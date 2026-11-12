import { BUTTON, SOLID, WARN, rng, hexCenter, hexAt } from "./sim.js";
import { HAUL, KIND, SHOVE, BOTS } from "./data.js";

/**
 * HEXHAUL: bot brains (the `game-ai` and `ai-behavior-trees-utility-ai` skills), after TIDEFALL's.
 *
 * DECIDING: utility AI. Every so often (the reaction time) the bot scores what it could do, each score
 * 0..1, and takes the best, with a small bonus for what it is already doing so it doesn't flip-flop.
 *   flee   the tile under it is going, or it's in the water
 *   safe   stand somewhere sound: solid neighbours, near the middle, no specials
 *   attack shove whoever's close, more if they are near the water or carrying
 *   throw  carrying, with someone in range
 *   steal  pull up the tile under someone next to it
 *   place  put down what it carries
 *   bridge stranded on a scrap of land: fetch a tile and build towards bigger land
 *   haul   Haul mode: fetch a tile and take it home
 *
 * MOVING: Dijkstra over the hexes, where a one-hex gap can be jumped at a higher cost.
 *
 * SKILL (data.js, BOTS) changes reaction time, how late it notices danger, whether it paths or walks
 * straight, charge, how it lines up a shove, and how often it uses tiles. Nothing changes its physics:
 * a hard bot is no faster or stronger than you.
 * @module game/bots
 */

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];
/** tile index -> neighbour indexes and jump-over pairs [over, landing]. The grid never changes, so built once. */
let links = null;
function linksOf(m) {
    if (links) return links;
    const at = (q, r) => { const i = m.index.get(q + "," + r); return i === undefined ? -1 : i; };
    links = m.tiles.map((t) => ({
        step: DIRS.map(([a, b]) => at(t.q + a, t.r + b)).filter((i) => i >= 0),
        jump: DIRS.map(([a, b]) => [at(t.q + a, t.r + b), at(t.q + a * 2, t.r + b * 2)]).filter(([o, l]) => o >= 0 && l >= 0),
    }));
    return links;
}

const WALK = 1, JUMP = 2.5;
const curve = (v, a, b) => Math.max(0, Math.min(1, (v - a) / (b - a)));

export class Bot {
    /** @param {number} id @param {number} seed @param {keyof typeof BOTS} [skill] */
    constructor(id, seed, skill = "normal") {
        this.id = id;
        this.random = rng(seed);
        this.skill = BOTS[skill] ? skill : "normal";
        this.clock = 0;
        this.plan = { act: "safe" };
        this.hold = 0;
        this.carried = 0;
        this.dist = null;
        this.prevTile = null;
    }
    get level() { return BOTS[this.skill]; }

    /** @param {import("./sim.js").Match} m */
    think(m) {
        const p = m.player(this.id);
        if (!p) return;
        if (p.out) return this.buoy(m, p);
        if (m.phase !== "play") { this.clock = 0; this.hold = 0; return m.setInput(this.id, 0, 0, 0); }
        this.carried = p.carry ? this.carried + 1 / 60 : 0;
        if (--this.clock <= 0) {
            this.clock = this.level.react;
            this.search(m, p);
            this.decide(m, p);
        }
        this.act(m, p);
    }

    /** A buoy: pick someone, face them for a moment, let go. */
    buoy(m, p) {
        if (!p.buoy || m.phase !== "play" || this.random() > this.level.buoy) return m.setInput(this.id, 0, 0, 0);
        const foe = this.nearestFoe(m, p, 16);
        if (!foe) return m.setInput(this.id, 0, 0, 0);
        const d = Math.hypot(foe.x - p.x, foe.y - p.y) || 1;
        const facing = Math.abs(Math.atan2(foe.y - p.y, foe.x - p.x) - p.face) < 0.3;
        m.setInput(this.id, (foe.x - p.x) / d, (foe.y - p.y) / d, facing && !(p.lastButtons & BUTTON.SHOVE) ? BUTTON.SHOVE : 0);
    }

    nearestFoe(m, p, range) {
        let foe = null, best = range;
        for (const o of m.players) {
            if (o.out || !m.foes(p, o)) continue;
            const d = Math.hypot(o.x - p.x, o.y - p.y);
            if (d < best) { best = d; foe = o; }
        }
        return foe;
    }

    /** how long this tile will hold, as far as this bot has noticed */
    risky(m, t) {
        if (!m.standable(t)) return true;
        if (t.state === WARN && t.t < this.level.notice) return true;
        if (t.fuse > 0) return true;
        return this.level.bombs && this.nearFuse(m, t);
    }
    nearFuse(m, t) {
        const l = linksOf(m)[m.index.get(t.q + "," + t.r)];
        return l.step.some((i) => m.tiles[i].fuse > 0);
    }

    /** Distances from where the bot stands to every tile it can get to on foot or by a jump. */
    search(m, p) {
        const L = linksOf(m), n = m.tiles.length;
        if (!this.dist) { this.dist = new Float32Array(n); this.from = new Int16Array(n); }
        const { dist, from } = this;
        dist.fill(Infinity); from.fill(-1);
        const start = m.index.get(hexAt(p.x, p.y).join(","));
        if (start === undefined) { this.start = -1; this.land = 0; return; }
        this.start = start;
        dist[start] = 0;
        let frontier = [start], land = 0;
        const walkable = (i) => m.tiles[i].state === SOLID || m.tiles[i].state === WARN && m.tiles[i].t > 0.5;
        // bucketed by cost: good enough on 271 tiles, and it allocates little
        while (frontier.length) {
            const next = [];
            for (const i of frontier) {
                const d = dist[i];
                if (walkable(i)) land++;
                for (const j of L[i].step) if (walkable(j) && d + WALK < dist[j]) { dist[j] = d + WALK; from[j] = i; next.push(j); }
                if (this.level.jumps) for (const [o, j] of L[i].jump) if (!m.standable(m.tiles[o]) && walkable(j) && d + JUMP < dist[j]) { dist[j] = d + JUMP; from[j] = i; next.push(j); }
            }
            frontier = next;
        }
        this.land = land;
    }

    /** The first tile on the way to `goal`, or the goal itself when there's no way. */
    nextOn(goal) {
        if (this.start < 0 || !Number.isFinite(this.dist[goal]) || !this.level.paths) return goal;
        let i = goal, guard = 0;
        while (this.from[i] !== this.start && this.from[i] >= 0 && guard++ < 300) i = this.from[i];
        return i;
    }

    /** the soundest tile within reach */
    safest(m, p) {
        const L = linksOf(m), s = m.storm, lv = this.level;
        let best = -1, top = -Infinity;
        m.tiles.forEach((t, i) => {
            if (t.state !== SOLID || t.fuse > 0) return;
            const d = Number.isFinite(this.dist[i]) ? this.dist[i] : Math.hypot(t.x - p.x, t.y - p.y) * 1.5 + 4;
            let solid = 0;
            for (const j of L[i].step) if (m.tiles[j].state === SOLID) solid++;
            let v = solid * 0.45 - t.ring * (s && s.kind === "wave" ? 0.5 : 0.25) - d * 0.55;
            if (t.raft > 0) v -= 4;
            if (t.kind === KIND.BOUNCY) v -= 3;
            if (t.kind === KIND.ICE) v -= lv.dislikeIce;
            if (t.kind === KIND.HEAVY) v += lv.likeHeavy;
            if (lv.bombs && this.nearFuse(m, t)) v -= 5;
            if (s && s.active && s.kind === "wind" && lv.paths) v -= (t.x * s.dx + t.y * s.dy) * 0.15;
            if (v > top) { top = v; best = i; }
        });
        return best;
    }

    /** the middle of the land: which way is "towards the water" from somewhere */
    centre(m) {
        let x = 0, y = 0, n = 0;
        for (const t of m.tiles) if (t.state === SOLID) { x += t.x; y += t.y; n++; }
        return n ? [x / n, y / n] : [0, 0];
    }

    decide(m, p) {
        const lv = this.level, was = this.plan.act, under = m.tileUnder(p.x, p.y), swimming = !p.ground && p.z < -0.2;
        const options = [];
        const add = (act, score, extra) => options.push({ act, score: score * (was === act ? 1.15 : 1) + this.random() * lv.noise, ...extra });

        add("safe", 0.25 + (under && m.standable(under) ? curve(under.ring, 3, 7) * 0.2 : 0.3));
        if (swimming || !under || this.risky(m, under)) add("flee", 1.2);

        const foe = this.nearestFoe(m, p, 9);
        if (foe) {
            const fd = Math.hypot(foe.x - p.x, foe.y - p.y);
            const foeTile = m.tileUnder(foe.x, foe.y);
            const edge = foeTile && linksOf(m)[m.index.get(foeTile.q + "," + foeTile.r)].step.filter((i) => m.tiles[i].state !== SOLID).length / 6;
            // nobody gets jumped in the first moments of a round
            if (!p.carry && p.ground && m.time > 2) add("attack", lv.aggression * (1 - curve(fd, 1, 7)) * (0.55 + (edge || 0) * 0.8) * (foe.carry ? 1.4 : 1), { foe: foe.id });
            if (p.carry && p.ground && fd > 2 && fd < 8) add("throw", lv.throws * (p.carryKind === KIND.BOMB ? 1.5 : 1), { foe: foe.id });
            if (!p.carry && p.ground && fd < 2.6 && foeTile && foeTile !== under && foeTile.kind !== KIND.HEAVY && m.goalOf(foeTile) < 0 && m.standable(foeTile)) add("steal", lv.steals, { foe: foe.id });
        }
        if (p.carry && m.mode !== "haul" && this.carried > 1.2) add("place", 0.45);
        if (lv.bridges && this.land > 0 && this.land < 7 && m.tiles.some((t) => t.state === SOLID && !Number.isFinite(this.dist[m.index.get(t.q + "," + t.r)]))) add("bridge", 0.9);
        if (m.mode === "haul" && p.ground) add("haul", lv.hauls);

        let best = options[0];
        for (const o of options) if (o.score > best.score) best = o;
        this.plan = best;
        if (best.act === "safe" || best.act === "flee") this.plan.tile = this.safest(m, p);
        if (best.act === "attack") this.hold = 0;
        if (best.act === "haul" && !p.carry) this.plan.tile = this.haulTile(m, p);
    }

    /** a tile worth carrying: close, on the way home, from the outside of the island rather than its heart */
    haulTile(m, p) {
        const [gx, gy] = hexCenter(...HAUL.goals[p.team]);
        let best = -1, top = -Infinity;
        m.tiles.forEach((t, i) => {
            if (!m.standable(t) || t.kind === KIND.HEAVY || m.goalOf(t) >= 0 || t === m.tileUnder(p.x, p.y)) return;
            const home = Math.hypot(t.x - gx, t.y - gy);
            if (home < HAUL.from + 0.1) return;
            const v = -Math.hypot(t.x - p.x, t.y - p.y) - home * 0.5 + t.ring * 0.4 + (t.state === WARN ? 3 : 0);
            if (v > top) { top = v; best = i; }
        });
        return best;
    }

    act(m, p) {
        const plan = this.plan;
        let tx = p.x, ty = p.y, buttons = 0, brake = false;
        const foe = plan.foe !== undefined ? m.player(plan.foe) : null;
        const toward = (i) => { const t = m.tiles[this.nextOn(i)]; tx = t.x; ty = t.y; };
        const press = (b) => { if (!(p.lastButtons & b)) buttons |= b; };

        switch (plan.act) {
            case "flee": case "safe":
                if (plan.tile >= 0) toward(plan.tile);
                if (plan.act === "safe" && plan.tile >= 0 && Math.hypot(m.tiles[plan.tile].x - p.x, m.tiles[plan.tile].y - p.y) < 0.5) brake = true;
                break;
            case "attack": {
                if (!foe || foe.out) { this.clock = 0; break; }
                const d = Math.hypot(foe.x - p.x, foe.y - p.y);
                tx = foe.x; ty = foe.y;
                if (this.level.linesUp && d > 1.4) {
                    // come round to the side away from the water, so the shove sends them in
                    const [cx, cy] = this.centre(m), wx = foe.x - cx, wy = foe.y - cy, l = Math.hypot(wx, wy) || 1;
                    tx = foe.x - (wx / l) * 1.1; ty = foe.y - (wy / l) * 1.1;
                }
                if (this.hold > 0) { this.hold--; buttons |= BUTTON.SHOVE; tx = foe.x; ty = foe.y; }
                else if (d < SHOVE.reach + 0.5 && p.cooldown <= 0) this.hold = Math.round(this.level.charge * SHOVE.charge * 60 * (0.6 + this.random() * 0.4)) + 2;
                break;
            }
            case "throw": {
                if (!foe || foe.out || !p.carry) { this.clock = 0; break; }
                tx = foe.x; ty = foe.y;
                const a = Math.atan2(foe.y - p.y, foe.x - p.x);
                if (this.hold > 0) { this.hold--; buttons |= BUTTON.SHOVE; }
                else if (Math.abs(Math.atan2(Math.sin(a - p.face), Math.cos(a - p.face))) < 0.2 && p.cooldown <= 0 && !(p.lastButtons & BUTTON.SHOVE)) this.hold = 8 + Math.floor(this.random() * 20);
                break;
            }
            case "steal": {
                if (!foe || foe.out || p.carry) { this.clock = 0; break; }
                tx = foe.x; ty = foe.y;
                if (m.ahead(p) === m.tileUnder(foe.x, foe.y)) { press(BUTTON.GRAB); this.clock = 0; }
                break;
            }
            case "place":
                if (p.ground) { press(BUTTON.GRAB); this.clock = 0; }
                break;
            case "bridge": {
                // towards the nearest land it can't reach
                let near = null, top = Infinity;
                for (const t of m.tiles) {
                    if (t.state !== SOLID || Number.isFinite(this.dist[m.index.get(t.q + "," + t.r)])) continue;
                    const d = Math.hypot(t.x - p.x, t.y - p.y);
                    if (d < top) { top = d; near = t; }
                }
                if (!near) { this.clock = 0; break; }
                tx = near.x; ty = near.y;
                const ahead = m.ahead(p);
                if (p.carry) { if (!m.standable(ahead)) { press(BUTTON.GRAB); this.clock = 0; } else if (m.ahead(p, 1.9) && !m.standable(m.ahead(p, 1.9))) { /* walk on */ } }
                else if (m.standable(ahead) && ahead !== m.tileUnder(p.x, p.y) && p.ground) press(BUTTON.GRAB);
                else if (!m.standable(ahead)) { tx = p.x * 2 - near.x; ty = p.y * 2 - near.y; }  // turn round, there's a tile behind
                break;
            }
            case "haul":
                if (p.carry && p.carryFar < HAUL.from) { press(BUTTON.GRAB); this.clock = 0; }   // not worth carrying home
                else if (p.carry) {
                    const [q, r] = HAUL.goals[p.team], goal = m.index.get(q + "," + r);
                    toward(goal);
                    if (!Number.isFinite(this.dist[goal])) { const [gx, gy] = hexCenter(q, r); tx = gx; ty = gy; }
                } else if (plan.tile >= 0) {
                    const t = m.tiles[plan.tile];
                    if (!m.standable(t)) { this.clock = 0; break; }
                    toward(plan.tile);
                    if (m.ahead(p) === t && Math.hypot(t.x - p.x, t.y - p.y) < 2.2) { press(BUTTON.GRAB); this.clock = 0; }
                }
                break;
        }

        const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
        const k = d > 0.15 && !brake ? 1 / d : 0;
        const mx = dx * k, my = dy * k;
        // a gap ahead on the way: jump it, or don't walk off (the careless do)
        if (p.ground && k) {
            const look = (s) => m.tileUnder(p.x + mx * s, p.y + my * s);
            const front = look(0.9);
            if (!m.standable(front)) {
                if (this.level.jumps && m.standable(look(2.7))) press(BUTTON.JUMP);
                else if (this.level.careful && plan.act !== "bridge" && plan.act !== "flee") return m.setInput(this.id, 0, 0, buttons);
            }
        }
        m.setInput(this.id, mx, my, buttons);
    }
}
