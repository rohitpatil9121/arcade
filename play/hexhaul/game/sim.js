import { GRID, TILE, WAVES, PLAYER, SHOVE, ROUND, TICK, KIND, SPECIAL, BOMB, RAFT, THROW, BUOY, STORM, HAUL, MODES } from "./data.js";

/**
 * HEXHAUL: the match. Pure and deterministic: given the same seed and the same inputs it plays out the
 * same way. The server (server/room.mjs) runs it with `authority` on; a client keeps a copy with it off,
 * filled from snapshots, and uses movePlayer() to predict its own robot between them.
 *
 * World: Z is up, the tile tops are at z = 0, the water a little below. The grid is flat-topped hexes in
 * axial coordinates (q, r).
 * @module game/sim
 */

export const SOLID = 0, WARN = 1, SINKING = 2, GONE = 3;

const SQRT3 = Math.sqrt(3);
/** ticks of past positions kept for lag compensation (a quarter of a second) */
const TRAIL = 15;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** small seeded random numbers (mulberry32) */
export function rng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const NEIGHBOURS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

export const hexDistance = (q, r) => (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
export function hexCenter(q, r, out = [0, 0]) {
    out[0] = GRID.size * 1.5 * q;
    out[1] = GRID.size * SQRT3 * (r + q / 2);
    return out;
}
/** the hex a point is over, by cube rounding */
export function hexAt(x, y) {
    const fq = (2 / 3) * x / GRID.size, fr = (-x / 3 + (SQRT3 / 3) * y) / GRID.size, fs = -fq - fr;
    let q = Math.round(fq), r = Math.round(fr);
    const s = Math.round(fs), dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
    if (dq > dr && dq > ds) q = -r - s;
    else if (dr > ds) r = -q - s;
    return [q, r];
}

/** one button state per player per tick */
export const BUTTON = { JUMP: 1, GRAB: 2, SHOVE: 4 };

/** A robot as it is at the start of a round (everything but who it is and its score). */
function fresh(p) {
    return Object.assign(p, { x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, face: 0, ground: true, out: false, swim: 0, stun: 0,
        carry: false, carryKind: 0, carryFar: 0, buoy: false, charge: 0, charging: false, cooldown: 0, airTime: 0, jumpBuffer: 0, lastButtons: 0 });
}

export class Match {
    /** @param {{ seed?: number, authority?: boolean, players?: Array<{ id?: number, name: string, bot?: boolean }> }} options */
    constructor(options = {}) {
        this.seed = options.seed ?? 1;
        /** "last", "teams" or "haul" */
        this.mode = MODES.includes(options.mode) ? options.mode : "last";
        this.authority = options.authority ?? true;
        this.random = rng(this.seed);
        this.tiles = [];
        /** "q,r" → tile index */
        this.index = new Map();
        for (let q = -GRID.reach; q <= GRID.reach; q++)
            for (let r = -GRID.reach; r <= GRID.reach; r++) {
                if (hexDistance(q, r) > GRID.reach) continue;
                const [x, y] = hexCenter(q, r);
                this.index.set(q + "," + r, this.tiles.length);
                this.tiles.push({ q, r, x, y, ring: hexDistance(q, r), state: GONE, t: 0, placed: -99, kind: 0, raft: 0, fuse: 0 });
            }
        /** in join order; `id` is stable, the index is not */
        this.players = [];
        /** things that happened this tick, for sound and effects: { type, ... } */
        this.events = [];
        this.round = 0;
        this.tick = 0;
        /** things in the air: { sid, type: "tile" | "buoy", kind, owner, x, y, z, vx, vy, vz } */
        this.shots = [];
        this.nextShot = 1;
        /** tiles each team has brought home this round (Haul) */
        this.hauled = [0, 0];
        /** the storm coming or blowing: { kind: "wind" | "wave" | "fast", active, t, dx, dy }, or null */
        this.storm = null;
        for (const [i, p] of (options.players || []).entries()) this.addPlayer(p.id ?? i, p.name, p.bot);
        this.startRound();
    }

    tile(q, r) { const i = this.index.get(q + "," + r); return i === undefined ? null : this.tiles[i]; }
    tileUnder(x, y) { const [q, r] = hexAt(x, y); return this.tile(q, r); }
    /** can you stand on it */
    standable(t) { return !!t && (t.state === SOLID || t.state === WARN); }
    player(id) { return this.players.find((p) => p.id === id) || null; }
    get teamed() { return this.mode !== "last"; }
    /** can these two hurt each other */
    foes(a, b) { return a !== b && (!this.teamed || a.team !== b.team); }
    /** which team's goal this tile is (Haul), or -1. Goals can't be taken or sunk. */
    goalOf(t) {
        if (this.mode !== "haul") return -1;
        return HAUL.goals.findIndex(([q, r]) => t.q === q && t.r === r);
    }
    resetScores() { for (const p of this.players) { p.wins = 0; p.stats = { hits: 0, tiles: 0, hauled: 0, falls: 0 }; } }
    /** tiles to bring home this round */
    get haulTarget() {
        const a = this.players.filter((p) => p.team === 0).length;
        return Math.max(HAUL.target, HAUL.perRobot * Math.max(a, this.players.length - a));
    }
    /** Change the rules: starts the match over. */
    setMode(mode) {
        if (!MODES.includes(mode) || mode === this.mode) return false;
        this.mode = mode;
        this.resetScores();
        this.startRound();
        return true;
    }

    /** Someone arrives. During a round they watch until the next one starts. */
    addPlayer(id, name, bot = false) {
        const p = fresh({ id, name, bot: !!bot, wins: 0, stats: { hits: 0, tiles: 0, hauled: 0, falls: 0 }, team: this.players.length % 2, input: { mx: 0, my: 0, buttons: 0 } });
        p.out = this.phase === "play" || this.phase === "over" || this.phase === "match";
        this.players.push(p);
        // before a round starts everyone is spaced out afresh, so arrivals never stand on top of each other
        if (this.phase === "ready") this.players.forEach((q, i) => { q.team = i % 2; this.spawn(q, i, this.players.length); });
        return p;
    }
    removePlayer(id) {
        const i = this.players.findIndex((p) => p.id === id);
        if (i >= 0) this.players.splice(i, 1);
    }

    spawn(p, i, n) {
        // teams start on their own side, each near its goal in Haul
        const a = this.teamed
            ? (p.team ? 0.52 : Math.PI + 0.52) + ((Math.floor(i / 2) + 0.5) / Math.max(1, Math.ceil(n / 2)) - 0.5) * 2.2
            : (i / Math.max(n, 2)) * Math.PI * 2 + 0.3, d = GRID.size * 1.5 * 3;
        const [q, r] = hexAt(Math.cos(a) * d, Math.sin(a) * d), [x, y] = hexCenter(q, r);
        fresh(p);
        p.x = x; p.y = y; p.face = a + Math.PI;
    }

    startRound() {
        this.round++;
        this.phase = "ready";
        this.clock = ROUND.ready;
        this.time = 0;
        this.nextWave = WAVES.first;
        this.winner = -1;
        this.winnerTeam = -1;
        this.shots.length = 0;
        this.hauled = [0, 0];
        this.storm = null;
        this.nextStorm = STORM.gapMin + this.random() * (STORM.gapMax - STORM.gapMin);
        for (const t of this.tiles) {
            t.state = t.ring <= GRID.island ? SOLID : GONE; t.t = 0; t.placed = -99; t.raft = 0; t.fuse = 0;
            t.kind = t.ring >= 1 && this.goalOf(t) < 0 ? this.rollKind() : 0;
        }
        this.players.forEach((p, i) => { p.team = i % 2; this.spawn(p, i, this.players.length); });
        this.events.push({ type: "round", round: this.round });
    }

    rollKind() {
        let v = this.random();
        for (const k of [KIND.BOUNCY, KIND.HEAVY, KIND.ICE, KIND.BOMB]) { if (v < SPECIAL.share[k]) return k; v -= SPECIAL.share[k]; }
        return KIND.NORMAL;
    }

    /** Set what a player is pressing. mx/my: -1..1 in world X and Y. */
    setInput(id, mx, my, buttons) {
        const p = this.player(id);
        if (!p) return;
        const len = Math.hypot(mx, my);
        p.input.mx = len > 1 ? mx / len : mx; p.input.my = len > 1 ? my / len : my;
        p.input.buttons = buttons;
    }

    step() {
        this.events.length = 0;
        this.tick++;
        const dt = TICK;
        if (this.phase === "ready") {
            if ((this.clock -= dt) <= 0) { this.phase = "play"; this.events.push({ type: "go" }); }
        } else if (this.phase === "play") {
            this.time += dt;
            if (this.authority) { this.stormStep(dt); this.waves(); }
        } else if (this.phase === "over" || this.phase === "match") {
            if ((this.clock -= dt) <= 0 && this.authority) {
                if (this.phase === "match") this.resetScores();
                this.startRound();
                return;
            }
        }
        this.tilesStep(dt);
        for (const p of this.players) this.playerStep(p, dt);
        this.collide();
        this.shotsStep(dt);
        if (this.authority) for (const p of this.players) { (p.trail ||= []).push(p.x, p.y); if (p.trail.length > TRAIL * 2) p.trail.splice(0, 2); }
        if (this.phase === "play" && this.authority) this.checkWinner();
    }

    waves() {
        if (this.time < this.nextWave) return;
        const k = clamp(this.time / WAVES.ramp, 0, 1);
        const fast = this.storm && this.storm.active && this.storm.kind === "fast" ? STORM.fastSink : 1;
        this.nextWave = this.time + (WAVES.gapStart + (WAVES.gapEnd - WAVES.gapStart) * k) * fast;
        const count = Math.round(WAVES.countStart + (WAVES.countEnd - WAVES.countStart) * k);
        const live = this.tiles.filter((t) => t.state === SOLID && this.time - t.placed > TILE.fresh && this.goalOf(t) < 0);
        if (!live.length) {
            // nothing left but the goals (Haul): now they go too, or two robots could stand on them for ever
            for (const t of this.tiles) if (t.state === SOLID && this.goalOf(t) >= 0) this.warnTile(t, TILE.warn);
            return;
        }
        // from the edge first: the tiles farthest out, ties broken at random
        const edge = live.map((t) => ({ t, k: t.ring + this.random() * 0.9 })).sort((a, b) => b.k - a.k);
        const picks = new Set();
        const fromEdge = Math.round(count * WAVES.edgeShare);
        for (let i = 0; i < edge.length && picks.size < fromEdge; i++) picks.add(edge[i].t);
        for (let tries = 0; picks.size < count && tries < 50; tries++) picks.add(live[Math.floor(this.random() * live.length)]);
        for (const t of picks) this.warnTile(t, TILE.warn);
        this.events.push({ type: "wave", count: picks.size });
    }

    /** Start a tile's last moments. Heavy ones take longer. */
    warnTile(t, time) {
        t.state = WARN; t.raft = 0;
        t.t = t.kind === KIND.HEAVY ? time * SPECIAL.heavyWarn : time;
    }

    /** Storms: announced, then they hit. */
    stormStep(dt) {
        const s = this.storm;
        if (!s) {
            if (this.time < this.nextStorm) return;
            const a = this.random() * Math.PI * 2, kinds = ["wind", "wave", "fast"];
            this.storm = { kind: kinds[Math.floor(this.random() * 3)], active: false, t: STORM.warn, dx: Math.cos(a), dy: Math.sin(a) };
            this.events.push({ type: "stormWarn", kind: this.storm.kind });
            return;
        }
        if ((s.t -= dt) > 0) return;
        if (s.active || s.kind === "wave") {
            if (!s.active) this.bigWave();
            this.storm = null;
            this.nextStorm = this.time + STORM.gapMin + this.random() * (STORM.gapMax - STORM.gapMin);
            return;
        }
        s.active = true; s.t = STORM.last;
        if (s.kind === "fast") this.nextWave = this.time;
        this.events.push({ type: "stormHit", kind: s.kind });
    }

    /** The big wave: rafts and loose (recently placed) tiles go, and the outer edge with them. */
    bigWave() {
        const live = this.tiles.filter((t) => t.state === SOLID && this.goalOf(t) < 0);
        const loose = live.filter((t) => t.raft > 0 || this.time - t.placed < TILE.fresh * 3);
        const edge = live.filter((t) => !loose.includes(t)).map((t) => ({ t, k: t.ring + this.random() * 0.9 })).sort((a, b) => b.k - a.k);
        for (const t of loose) this.warnTile(t, STORM.waveWarn);
        for (let i = 0; i < edge.length && i < STORM.waveTiles; i++) this.warnTile(edge[i].t, STORM.waveWarn);
        this.events.push({ type: "stormHit", kind: "wave" });
    }

    /** A tile lands in an empty hex: a raft if nothing's next to it, and a bomb starts its fuse. */
    setDown(t, kind, fused = true) {
        t.state = SOLID; t.t = 0; t.placed = this.time; t.kind = kind;
        t.fuse = kind === KIND.BOMB && fused ? BOMB.fuse : 0;
        const held = NEIGHBOURS.some(([a, b]) => { const n = this.tile(t.q + a, t.r + b); return this.standable(n) && n.raft <= 0; });
        t.raft = held ? 0 : RAFT.life;
    }

    /** A bomb goes off here. */
    explode(x, y, z) {
        const [q, r] = hexAt(x, y);
        for (const [a, b] of [[0, 0], ...NEIGHBOURS]) {
            const n = this.tile(q + a, r + b);
            if (!n || !this.standable(n) || n.kind === KIND.HEAVY || this.goalOf(n) >= 0) continue;
            n.state = SINKING; n.t = BOMB.sink; n.raft = 0; n.fuse = 0;
        }
        for (const p of this.players) {
            if (p.out) continue;
            const dx = p.x - x, dy = p.y - y, d = Math.hypot(dx, dy);
            if (d > BOMB.radius) continue;
            const k = BOMB.knock * (1 - (d / BOMB.radius) * 0.5), nx = d > 0.01 ? dx / d : 1, ny = d > 0.01 ? dy / d : 0;
            this.knock(p, nx * k, ny * k, 5);
        }
        this.events.push({ type: "bomb", x, y, z });
    }

    /** Send a robot flying. It drops whatever it was carrying. */
    knock(o, vx, vy, vz, stun = SHOVE.stun) {
        o.vx = vx; o.vy = vy; o.vz = vz; o.ground = false; o.stun = stun; o.charging = false;
        if (o.carry) { o.carry = false; this.events.push({ type: "lost", id: o.id }); }
    }

    /** Throw what you carry the way you face. */
    throwTile(p, power) {
        p.charging = false; p.charge = 0; p.cooldown = SHOVE.cooldown; p.carry = false;
        const k = THROW.speed + THROW.extra * power, fx = Math.cos(p.face), fy = Math.sin(p.face);
        this.shots.push({ sid: this.nextShot++, type: "tile", kind: p.carryKind, owner: p.id, x: p.x + fx * 0.6, y: p.y + fy * 0.6, z: p.z + 1.3, vx: fx * k + p.vx * 0.4, vy: fy * k + p.vy * 0.4, vz: THROW.up });
        this.events.push({ type: "throw", id: p.id });
    }

    /** A robot that's out throws its one buoy, helped towards whoever is closest to where it aims. */
    throwBuoy(p) {
        p.buoy = false;
        const fx = Math.cos(p.face), fy = Math.sin(p.face);
        let best = null, score = -Infinity;
        for (const o of this.players) {
            if (o.out || !this.foes(p, o)) continue;
            const dx = o.x - p.x, dy = o.y - p.y, d = Math.hypot(dx, dy);
            if (d > BUOY.range) continue;
            const s = (d > 0.01 ? (dx * fx + dy * fy) / d : 1) * 6 - d * 0.1;
            if (s > score) { score = s; best = o; }
        }
        const T = BUOY.flight, tx = best ? best.x : p.x + fx * 8, ty = best ? best.y : p.y + fy * 8, tz = best ? best.z + 0.6 : 0;
        this.shots.push({ sid: this.nextShot++, type: "buoy", kind: 0, owner: p.id, x: p.x, y: p.y, z: p.z, vx: (tx - p.x) / T, vy: (ty - p.y) / T, vz: (tz - p.z + 0.5 * PLAYER.gravity * T * T) / T });
        this.events.push({ type: "throw", id: p.id, buoy: true });
    }

    /** Everything in the air. A client only moves them; the server decides what they hit. */
    shotsStep(dt) {
        for (let i = this.shots.length - 1; i >= 0; i--) {
            const s = this.shots[i];
            s.vz -= PLAYER.gravity * dt;
            s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
            if (!this.authority) { if (s.z < PLAYER.waterZ) this.shots.splice(i, 1); continue; }
            const owner = this.player(s.owner);
            let done = false;
            for (const o of this.players) {
                if (o.out || o.id === s.owner || (owner && !this.foes(owner, o))) continue;
                if (Math.hypot(o.x - s.x, o.y - s.y) > THROW.radius || s.z < o.z - 0.3 || s.z > o.z + 1.9) continue;
                const l = Math.hypot(s.vx, s.vy) || 1, k = s.type === "buoy" ? BUOY.knock : THROW.knock;
                this.knock(o, (s.vx / l) * k, (s.vy / l) * k, 4, THROW.stun);
                if (owner) owner.stats.hits++;
                this.events.push({ type: "hit", id: s.owner, target: o.id, power: 0.6, x: o.x, y: o.y, z: o.z });
                done = true;
                break;
            }
            if (!done && (s.z <= 0.05 && s.vz < 0)) {
                const under = this.tileUnder(s.x, s.y);
                if (s.type === "tile" && s.kind === KIND.BOMB && (this.standable(under) || s.z <= PLAYER.waterZ)) { this.explode(s.x, s.y, 0); done = true; }
                else if (s.type === "buoy") { if (s.z <= PLAYER.waterZ) { this.events.push({ type: "splash", id: -1, x: s.x, y: s.y }); done = true; } else if (this.standable(under)) done = true; }
                else if (under && !this.standable(under) && s.z <= -0.1) { this.setDown(under, s.kind); this.events.push({ type: "place", id: s.owner, x: under.x, y: under.y }); done = true; }
                else if (this.standable(under)) {
                    // it lands on the island: into the nearest gap, or it breaks
                    const gap = NEIGHBOURS.map(([a, b]) => this.tile(under.q + a, under.r + b)).find((n) => n && !this.standable(n));
                    if (gap) { this.setDown(gap, s.kind); this.events.push({ type: "place", id: s.owner, x: gap.x, y: gap.y }); }
                    else this.events.push({ type: "grab", id: s.owner, x: s.x, y: s.y });
                    done = true;
                } else if (s.z <= PLAYER.waterZ) { this.events.push({ type: "splash", id: -1, x: s.x, y: s.y }); done = true; }
            }
            if (done) this.shots.splice(i, 1);
        }
    }

    tilesStep(dt) {
        for (const t of this.tiles) {
            if (t.state === SOLID && t.fuse > 0 && (t.fuse -= dt) <= 0) {
                t.fuse = 0;
                if (this.authority) this.explode(t.x, t.y, 0);
                continue;
            }
            if (t.state === SOLID && t.raft > 0 && this.authority && (t.raft -= dt) <= 0) { t.raft = 0; this.warnTile(t, TILE.warn); continue; }
            if (t.state === WARN && (t.t -= dt) <= 0) { t.state = SINKING; t.t = TILE.sink; this.events.push({ type: "sink", x: t.x, y: t.y }); }
            else if (t.state === SINKING && (t.t -= dt) <= 0) { t.state = GONE; t.t = 0; }
        }
    }

    playerStep(p, dt) {
        if (p.out) {
            // a buoy on the water: paddle it about and throw it once
            if (this.authority && p.buoy && this.phase === "play") {
                const i = p.input;
                p.x += i.mx * BUOY.drift * dt; p.y += i.my * BUOY.drift * dt;
                if (i.mx || i.my) p.face = Math.atan2(i.my, i.mx);
                if (i.buttons & ~p.lastButtons & BUTTON.SHOVE) this.throwBuoy(p);
            }
            p.lastButtons = p.input.buttons;
            return;
        }
        const buttons = p.input.buttons, pressed = buttons & ~p.lastButtons, released = p.lastButtons & ~buttons;
        p.cooldown = Math.max(0, p.cooldown - dt);
        p.stun = Math.max(0, p.stun - dt);
        if (this.authority && this.phase === "play" && p.stun <= 0) {
            if (pressed & BUTTON.GRAB) p.carry ? this.place(p) : this.grab(p);
            if (pressed & BUTTON.SHOVE && p.cooldown <= 0) { p.charging = true; p.charge = 0; }
            if (p.charging) {
                p.charge = Math.min(SHOVE.charge, p.charge + dt);
                if (released & BUTTON.SHOVE || !(buttons & BUTTON.SHOVE)) { if (p.carry) this.throwTile(p, p.charge / SHOVE.charge); else this.shove(p); }
            }
        } else if (this.authority) p.charging = false;
        if (this.authority && this.phase === "play" && this.mode === "haul" && p.carry && p.ground) {
            const [q, r] = HAUL.goals[p.team], [gx, gy] = hexCenter(q, r);
            if (p.carryFar >= HAUL.from && Math.hypot(p.x - gx, p.y - gy) < HAUL.reach) {
                p.carry = false;
                this.hauled[p.team]++;
                p.stats.hauled++;
                this.events.push({ type: "haul", id: p.id, team: p.team, x: gx, y: gy });
            }
        }
        this.movePlayer(p, dt);
    }

    /**
     * Steering, jumping, falling and swimming: the part of a robot's tick a client can predict. It reads
     * p.input and updates p.lastButtons. Grabbing, placing and shoving are the server's alone.
     */
    movePlayer(p, dt) {
        const inp = p.input, pressed = inp.buttons & ~p.lastButtons;
        p.lastButtons = inp.buttons;
        p.jumpBuffer = pressed & BUTTON.JUMP ? PLAYER.buffer : Math.max(0, p.jumpBuffer - dt);
        const steer = p.stun <= 0 && this.phase !== "ready";

        const swimming = p.z <= PLAYER.waterZ + 0.01;
        const on = p.ground ? this.tileUnder(p.x, p.y) : null;
        const ice = !!on && on.kind === KIND.ICE && this.standable(on);
        const top = (swimming ? PLAYER.swimSpeed : PLAYER.speed) * (p.carry ? PLAYER.carrySpeed : 1) * (p.charging ? 0.6 : 1) * (ice ? SPECIAL.iceSpeed : 1);
        if (steer && (inp.mx || inp.my)) {
            const tx = inp.mx * top, ty = inp.my * top, a = PLAYER.accel * (ice ? SPECIAL.iceGrip : p.ground || swimming ? 1 : 0.45) * dt;
            const dx = tx - p.vx, dy = ty - p.vy, d = Math.hypot(dx, dy);
            if (d > a) { p.vx += (dx / d) * a; p.vy += (dy / d) * a; } else { p.vx = tx; p.vy = ty; }
            p.face = Math.atan2(inp.my, inp.mx);
        } else if (p.ground || swimming) {
            const f = Math.exp(-PLAYER.friction * dt * (p.stun > 0 ? 0.25 : 1) * (ice ? SPECIAL.iceFriction : 1));
            p.vx *= f; p.vy *= f;
        }

        // jumping, with coyote time and a buffered press
        p.airTime = p.ground ? 0 : p.airTime + dt;
        if (steer && p.jumpBuffer > 0 && (p.ground || p.airTime < PLAYER.coyote) && !swimming) {
            p.vz = PLAYER.jump; p.ground = false; p.airTime = 1; p.jumpBuffer = 0;
            this.events.push({ type: "jump", id: p.id });
        }

        // a bouncy tile throws you up the moment you stand on it
        if (on && on.kind === KIND.BOUNCY && this.standable(on) && this.phase === "play") {
            p.vz = SPECIAL.bounce; p.ground = false; p.airTime = 1;
            this.events.push({ type: "bounce", id: p.id, x: on.x, y: on.y });
        }

        // moving and falling; the wind carries everyone, whatever they're doing
        const gust = this.storm && this.storm.active && this.storm.kind === "wind" ? STORM.wind : 0;
        p.x += (p.vx + this.windX(gust)) * dt; p.y += (p.vy + this.windY(gust)) * dt;
        const under = this.tileUnder(p.x, p.y);
        const floor = this.standable(under) ? 0 : under && under.state === SINKING ? -0.6 * (1 - under.t / TILE.sink) : -Infinity;
        if (p.ground && floor < 0) p.ground = false;
        if (!p.ground) {
            p.vz -= PLAYER.gravity * dt;
            p.z += p.vz * dt;
            if (floor === 0 && p.z <= 0 && p.z > -0.35 && p.vz <= 0) {
                if (p.vz < -4) this.events.push({ type: "land", id: p.id, v: -p.vz });
                p.z = 0; p.vz = 0; p.ground = true;
            }
        }
        if (p.z <= PLAYER.waterZ) {
            if (p.swim === 0) {
                this.events.push({ type: "splash", id: p.id, x: p.x, y: p.y });
                if (p.carry && this.authority) { p.carry = false; this.events.push({ type: "lost", id: p.id }); }
                if (this.authority) p.charging = false;
            }
            p.z = PLAYER.waterZ; p.vz = Math.max(0, p.vz);
            p.swim += dt;
            // reach a tile and you climb out
            if (this.standable(under)) { p.z = 0; p.vz = 0; p.ground = true; p.swim = 0; this.events.push({ type: "climb", id: p.id }); }
            else if (p.swim >= PLAYER.swimTime && this.phase === "play" && this.authority) { p.out = true; p.stats.falls++; p.buoy = true; p.carry = false; this.events.push({ type: "out", id: p.id, x: p.x, y: p.y }); }
            else if (p.swim >= PLAYER.swimTime) p.swim = PLAYER.swimTime;
        } else if (p.ground) p.swim = 0;
        // never drift off the world
        const far = GRID.size * 1.5 * (GRID.reach + 2), d = Math.hypot(p.x, p.y);
        if (d > far) { p.x *= far / d; p.y *= far / d; }
    }

    windX(gust) { return gust ? this.storm.dx * gust : 0; }
    windY(gust) { return gust ? this.storm.dy * gust : 0; }

    /** the hex a step in front of a player */
    ahead(p, step = 1.1) { return this.tileUnder(p.x + Math.cos(p.face) * GRID.size * step, p.y + Math.sin(p.face) * GRID.size * step); }

    /** Pull up a tile: the one in front if there is one, else the one you stand on. */
    grab(p) {
        if (!p.ground) return;
        let t = this.ahead(p);
        const under = this.tileUnder(p.x, p.y);
        const takeable = (x) => this.standable(x) && x.kind !== KIND.HEAVY && this.goalOf(x) < 0;
        if (!takeable(t) || t === under) t = under;
        if (!takeable(t)) return;
        p.carryKind = t.kind;
        if (this.mode === "haul") { const [gx, gy] = hexCenter(...HAUL.goals[p.team]); p.carryFar = Math.hypot(t.x - gx, t.y - gy); }
        t.state = GONE; t.t = 0; t.raft = 0; t.fuse = 0;
        p.carry = true;
        this.events.push({ type: "grab", id: p.id, x: t.x, y: t.y });
    }

    /** Put the tile down in the nearest empty hex in front, falling back to the sides. */
    place(p) {
        const under = this.tileUnder(p.x, p.y);
        for (const [step, turn] of [[1.1, 0], [1.1, 0.6], [1.1, -0.6], [0, 0], [2, 0]]) {
            const a = p.face + turn, t = step === 0 ? under : this.tileUnder(p.x + Math.cos(a) * GRID.size * step, p.y + Math.sin(a) * GRID.size * step);
            if (!t || this.standable(t)) continue;
            this.setDown(t, p.carryKind);
            p.stats.tiles++;
            p.carry = false;
            if (t === under && p.z < 0) { p.z = 0; p.vz = 0; p.ground = true; p.swim = 0; }
            this.events.push({ type: "place", id: p.id, x: t.x, y: t.y });
            return;
        }
    }

    shove(p) {
        const power = p.charge / SHOVE.charge;
        p.charging = false; p.charge = 0; p.cooldown = SHOVE.cooldown;
        const fx = Math.cos(p.face), fy = Math.sin(p.face);
        p.vx += fx * SHOVE.lunge; p.vy += fy * SHOVE.lunge;
        let hit = false;
        for (const o of this.players) {
            if (o === p || o.out || !this.foes(p, o)) continue;
            // lag compensation: judge the shove against where the shover saw this robot, a little in the past
            const back = Math.min(p.rewind || 0, o.trail ? o.trail.length / 2 : 0);
            const ox = back ? o.trail[o.trail.length - back * 2] : o.x, oy = back ? o.trail[o.trail.length - back * 2 + 1] : o.y;
            const dx = ox - p.x, dy = oy - p.y, d = Math.hypot(dx, dy);
            if (d > SHOVE.reach + PLAYER.radius || Math.abs(o.z - p.z) > 1) continue;
            if (d > 0.01 && (dx * fx + dy * fy) / d < SHOVE.cone) continue;
            const k = SHOVE.base + SHOVE.extra * power;
            this.knock(o, fx * k, fy * k, SHOVE.upward * (0.6 + power));
            hit = true;
            p.stats.hits++;
            this.events.push({ type: "hit", id: p.id, target: o.id, power, x: o.x, y: o.y, z: o.z });
        }
        this.events.push({ type: "shove", id: p.id, power, hit });
    }

    /** robots push each other apart */
    collide() {
        const ps = this.players, min = PLAYER.radius * 2;
        for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
            const a = ps[i], b = ps[j];
            if (a.out || b.out || Math.abs(a.z - b.z) > 0.9) continue;
            const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
            if (d >= min || d < 1e-6) continue;
            const push = (min - d) / 2, nx = dx / d, ny = dy / d;
            a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
        }
    }

    checkWinner() {
        // alone in the room: practise as long as you like
        if (this.players.length < 2) return;
        const alive = this.players.filter((p) => !p.out);
        let w;
        if (this.teamed) {
            // a side with nobody on it can't be beaten: practise until someone joins it
            if (new Set(this.players.map((p) => p.team)).size < 2) return;
            const hauled = this.mode === "haul" ? this.hauled.findIndex((n) => n >= this.haulTarget) : -1;
            const sides = new Set(alive.map((p) => p.team));
            if (hauled < 0 && sides.size > 1) return;
            this.winnerTeam = hauled >= 0 ? hauled : sides.size ? [...sides][0] : -1;
            w = alive.find((p) => p.team === this.winnerTeam) || this.players.find((p) => p.team === this.winnerTeam);
            if (this.winnerTeam >= 0) for (const p of this.players) if (p.team === this.winnerTeam) p.wins++;
        } else {
            if (alive.length > 1) return;
            w = alive[0];
            if (w) w.wins++;
        }
        this.winner = w ? w.id : -1;
        this.phase = w && w.wins >= ROUND.toWin ? "match" : "over";
        this.clock = ROUND.after + (this.phase === "match" ? 2 : 0);
        this.events.push({ type: this.phase, winner: this.winner, team: this.winnerTeam });
    }
}
