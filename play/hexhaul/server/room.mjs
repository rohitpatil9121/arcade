import { Match } from "../game/sim.js";
import { Bot } from "../game/bots.js";
import { NAMES, SKILLS, COLORS, COSMETICS, LOBBY } from "../game/data.js";
import { encode, decode, cleanInput, cleanText, cleanLook, playerRow, tileRow, shotRow, SNAP_EVERY, INTERP_TICKS, NAME_MAX, MAX_PLAYERS, REJOIN_SECONDS } from "../game/protocol.js";

/**
 * One match and the people in it. The room is the authority: it owns the Match, feeds it each player's
 * inputs, and tells everyone what happened. It knows nothing about sockets or timers: the Node server
 * (server.mjs) drives it from WebSockets, and Practice drives the very same class inside the page
 * (game/net.js, Loopback), so online and offline play share one code path.
 *
 * INPUTS. A client sends one input per tick. Each tick the room applies the next one waiting for each
 * player. When none has arrived (a late packet) the last one is held, and when several have piled up
 * the oldest beyond a small allowance are dropped, so a player is never more than a few ticks behind.
 *
 * LOBBY. With `lobby` on (online rooms) people gather and ready up first; the match only runs in "game",
 * and a finished match comes back here with its table. Practice has no lobby and plays straight away.
 *
 * COLOURS. Each robot holds a colour slot for as long as it's in the room, so nobody changes colour when
 * someone else leaves.
 *
 * REJOINING. Each person gets a secret token on joining. If their connection drops, their robot stays
 * (standing still) for REJOIN_SECONDS, and a hello carrying the token takes it back, score and all.
 * @module server/room
 */

/** inputs held for one player beyond this are dropped, oldest first */
const QUEUE_MAX = 4;
/** messages a client may send per second, and the burst allowed on top */
const RATE = 120, BURST = 200;
const TICK_RATE = 60;

export class Room {
    /** @param {{ code?: string, bots?: number, seed?: number, open?: boolean, log?: (line: string) => void }} [options] */
    constructor(options = {}) {
        this.code = options.code || "LOCAL";
        this.settings = { bots: Math.max(0, Math.min(MAX_PLAYERS, options.bots ?? 0)), open: options.open ?? true };
        this.skill = SKILLS.includes(options.skill) ? options.skill : "normal";
        this.log = options.log || (() => {});
        this.match = new Match({ seed: options.seed ?? 1, mode: options.mode });
        /** @type {Map<number, object>} people, by player id */
        this.clients = new Map();
        /** @type {Map<number, Bot>} */
        this.bots = new Map();
        /** dropped people whose seat is kept: token → { id, until } */
        this.seats = new Map();
        this.events = [];
        this.host = 0;
        this.nextId = 1;
        this.age = 0;
        /** @type {"lobby" | "game"} */
        this.state = options.lobby ? "lobby" : "game";
        this.lobby = !!options.lobby;
        /** id -> { slot, hat, paint, ready } */
        this.seatInfo = new Map();
        /** ticks left: to the start once everyone's ready, and to the start by itself in an open room */
        this.countdown = 0;
        this.waited = 0;
        this.lastCd = -1;
        this.result = null;
        this.fillBots();
    }

    /** the lowest colour nobody holds */
    freeSlot() {
        const held = new Set([...this.seatInfo.values()].map((s) => s.slot));
        for (let i = 0; i < COLORS.length; i++) if (!held.has(i)) return i;
        return 0;
    }

    /** people connected, plus seats being kept */
    get humans() { return this.clients.size + this.seats.size; }
    get full() { return this.humans >= MAX_PLAYERS; }
    info() { return { code: this.code, host: this.host, bots: this.settings.bots, open: this.settings.open, mode: this.match.mode, skill: this.skill }; }

    // ------------------------------------------------------------------ people

    /**
     * @param {(data: string) => void} send
     * @param {string} name
     * @param {string} [token] given back on a rejoin
     * @param {{ hat?: number, paint?: number }} [look]
     * @returns {number} the player id
     */
    join(send, name, token, look) {
        const seat = token && this.seats.get(token);
        let id;
        if (seat) {
            this.seats.delete(token);
            id = seat.id;
            this.log(`${this.code}: ${name} came back`);
        } else {
            token = Math.random().toString(36).slice(2) + Date.now().toString(36);
            id = this.nextId++;
            // a bot gives up its place first
            this.fillBots(1);
            this.match.addPlayer(id, cleanText(name, NAME_MAX) || "Player");
            this.seatInfo.set(id, { slot: this.freeSlot(), ...cleanLook(look), ready: false });
            this.log(`${this.code}: ${name} joined (${this.humans + 1} here)`);
            // someone was playing alone: now there's a match to be had, so start a round with both
            const m = this.match;
            if (this.state === "game" && m.players.length >= 2 && m.players.filter((p) => !p.out).length < 2) {
                m.startRound();
                for (const c of this.clients.values()) c.sentTiles = null;
            }
        }
        const client = { id, send, token, queue: [], lastSeq: 0, ack: 0, ping: 0, pingSent: 0, pingN: 0, tokens: BURST, sentTiles: null, sentRows: new Map() };
        this.clients.set(id, client);
        if (!this.host) this.host = id;
        this.sendTo(client, { t: "welcome", id, token, room: this.info(), tick: this.match.tick });
        this.roster();
        return id;
    }

    /** A connection closed. The robot stays a while in case they come back. */
    leave(id, keepSeat = true) {
        const client = this.clients.get(id);
        if (!client) return;
        this.clients.delete(id);
        const p = this.match.player(id);
        if (p) this.match.setInput(id, 0, 0, 0);
        if (keepSeat && p) this.seats.set(client.token, { id, until: this.age + REJOIN_SECONDS * TICK_RATE });
        else this.drop(id);
        if (this.host === id) this.host = this.clients.keys().next().value || 0;
        this.roster();
    }

    drop(id) {
        const p = this.match.player(id);
        this.match.removePlayer(id);
        this.seatInfo.delete(id);
        this.fillBots();
        this.roster();
        this.log(`${this.code}: ${p ? p.name : id} left (${this.humans} here)`);
    }

    /** Keep the room at its bot-fill size. `reserve` makes room for someone about to join. */
    fillBots(reserve = 0) {
        const want = Math.max(0, Math.min(MAX_PLAYERS, this.settings.bots) - this.humans - reserve);
        const ids = [...this.bots.keys()];
        while (ids.length > want) { const id = ids.pop(); this.bots.delete(id); this.match.removePlayer(id); this.seatInfo.delete(id); }
        const taken = new Set(this.match.players.map((p) => p.name));
        for (let i = ids.length; i < want; i++) {
            const id = this.nextId++;
            // a bot is named after its colour
            const slot = this.freeSlot();
            const name = !taken.has(NAMES[slot]) ? NAMES[slot] : "Bot " + id;
            this.seatInfo.set(id, { slot, hat: -1, paint: 0, ready: true });
            taken.add(name);
            this.match.addPlayer(id, name, true);
            this.bots.set(id, new Bot(id, this.match.seed + id * 7919, this.skill));
        }
    }

    // ------------------------------------------------------------------ the match

    /** One simulation tick. Call at 60 Hz. */
    tick() {
        const m = this.match;
        this.age++;
        for (const [token, seat] of this.seats) if (this.age >= seat.until) { this.seats.delete(token); this.drop(seat.id); }
        if (this.age % TICK_RATE === 0) for (const c of this.clients.values()) { c.pingSent = this.age; this.sendTo(c, { t: "ping", n: ++c.pingN }); }
        if (this.state === "lobby") return this.lobbyTick();
        for (const c of this.clients.values()) {
            if (c.tokens < BURST) c.tokens = Math.min(BURST, c.tokens + RATE / TICK_RATE);
            while (c.queue.length > QUEUE_MAX) c.ack = c.queue.shift().seq;
            const input = c.queue.shift();
            if (input) { m.setInput(c.id, input.mx, input.my, input.buttons); c.ack = input.seq; }
            // what this person sees of others is half a round trip plus the drawing delay behind us
            const me = m.player(c.id);
            if (me) me.rewind = Math.min(15, Math.round((c.ping / 2) * (TICK_RATE / 1000)) + INTERP_TICKS);
        }
        for (const bot of this.bots.values()) bot.think(m);
        // the match is over and its table has been up long enough: back to the lobby with it
        if (this.lobby && m.phase === "match" && m.clock <= 1 / TICK_RATE) return this.toLobby();
        const round = m.round;
        m.step();
        for (const e of m.events) this.events.push(e);
        // a new round puts every tile back: send them all
        if (m.round !== round) for (const c of this.clients.values()) c.sentTiles = null;
        if (m.tick % SNAP_EVERY === 0) this.sendSnapshots();
    }

    /** Waiting for the first round: start when everyone here is ready, or by itself in an open room. */
    lobbyTick() {
        const people = [...this.clients.keys()].map((id) => this.seatInfo.get(id));
        const enough = this.match.players.length >= 2 && people.length > 0;
        const allReady = enough && people.every((s) => s && s.ready);
        if (allReady && !this.countdown) this.countdown = LOBBY.countdown * TICK_RATE;
        else if (!allReady && this.settings.open && enough && !this.countdown) {
            if (++this.waited >= LOBBY.openWait * TICK_RATE) this.countdown = LOBBY.countdown * TICK_RATE;
        } else if (!allReady && !this.settings.open) this.countdown = 0;
        if (this.countdown && --this.countdown <= 0) return this.startGame();
        const cd = Math.ceil(this.countdown / TICK_RATE);
        if (cd !== this.lastCd) { this.lastCd = cd; this.roster(); }
    }

    startGame() {
        const m = this.match;
        this.state = "game"; this.countdown = 0; this.waited = 0; this.lastCd = -1; this.result = null;
        m.resetScores();
        m.startRound();
        for (const c of this.clients.values()) { c.sentTiles = null; c.sentRows.clear(); c.queue.length = 0; }
        this.log(`${this.code}: match started`);
        this.roster();
    }

    toLobby() {
        const m = this.match;
        this.result = m.players.map((p) => ({ id: p.id, name: p.name, slot: this.seatInfo.get(p.id)?.slot ?? 0, wins: p.wins, ...p.stats })).sort((a, b) => b.wins - a.wins || b.hits - a.hits);
        this.state = "lobby";
        for (const [id, s] of this.seatInfo) s.ready = this.bots.has(id);
        this.roster();
    }

    /**
     * Tell every client where things stand: its own robot in full, other robots and tiles only where they
     * differ from what that client was last sent.
     */
    sendSnapshots() {
        const m = this.match;
        const rows = m.players.map(playerRow);
        const tiles = m.tiles.map((t, i) => tileRow(t, i, m.time));
        const shots = m.shots.map(shotRow);
        for (const c of this.clients.values()) {
            const p = m.player(c.id);
            const changed = [];
            for (const row of rows) {
                const was = c.sentRows.get(row[0]);
                if (was && row.every((v, k) => v === was[k])) continue;
                c.sentRows.set(row[0], row); changed.push(row);
            }
            let tileChanges;
            // a timer counting down is run on the client too, so only a change of state (or placement) is news
            const key = (r) => r[1] * 2 + r[3] + r[4] * 16 + r[5] * 128 + (r[6] > 0 ? 256 : 0);
            if (!c.sentTiles) { tileChanges = tiles; c.sentTiles = tiles.map(key); }
            else {
                tileChanges = [];
                for (const r of tiles) { const k = key(r); if (c.sentTiles[r[0]] !== k) { c.sentTiles[r[0]] = k; tileChanges.push(r); } }
            }
            this.sendTo(c, {
                t: "snap", tick: m.tick, ack: c.ack, pg: c.ping,
                ph: m.phase, cl: Math.round(m.clock * 100), rd: m.round, tm: Math.round(m.time * 100), win: m.winner, wt: m.winnerTeam,
                md: m.mode, ha: m.hauled, ht: m.haulTarget, st: m.storm, sh: shots,
                wins: m.players.map((q) => [q.id, q.wins, q.team, q.stats.hits, q.stats.tiles, q.stats.hauled, q.stats.falls]),
                you: p ? { x: p.x, y: p.y, z: p.z, vx: p.vx, vy: p.vy, vz: p.vz, face: p.face, ground: p.ground, out: p.out, swim: p.swim, stun: p.stun,
                    carry: p.carry, carryKind: p.carryKind, buoy: p.buoy, charge: p.charge, charging: p.charging, cooldown: p.cooldown, airTime: p.airTime, jumpBuffer: p.jumpBuffer, lastButtons: p.lastButtons } : null,
                p: changed, tl: tileChanges, ev: this.events,
            });
        }
        this.events = [];
    }

    // ------------------------------------------------------------------ messages

    /** A message arrived from a client. Nothing in it is trusted. */
    receive(id, data) {
        const c = this.clients.get(id);
        if (!c) return;
        if (--c.tokens < 0) { c.tokens = 0; return; }
        const m = decode(data);
        if (!m) return;
        if (m.t === "in") {
            if (this.state === "lobby") return;
            const input = cleanInput(m);
            if (input && input.seq > c.lastSeq) { c.lastSeq = input.seq; c.queue.push(input); }
        } else if (m.t === "pong") {
            if (m.n === c.pingN) c.ping = Math.min(999, Math.round(((this.age - c.pingSent) * 1000) / TICK_RATE));
        } else if (m.t === "ready") {
            const s = this.seatInfo.get(id);
            if (s && this.state === "lobby") { s.ready = !!m.on; this.roster(); }
        } else if (m.t === "look") {
            const s = this.seatInfo.get(id);
            if (s) { Object.assign(s, cleanLook(m)); this.roster(); }
        } else if (m.t === "emote") {
            // one a second per person, so nobody can flood the room
            if (Number.isInteger(m.n) && m.n >= 0 && m.n < COSMETICS.emotes.length && this.age - (c.lastEmote ?? -999) >= TICK_RATE) { c.lastEmote = this.age; this.broadcast({ t: "emote", id, n: m.n }); }
        } else if (m.t === "start" && id === this.host) {
            if (this.state === "lobby" && this.match.players.length >= 2) this.startGame();
        } else if (m.t === "setup" && id === this.host) {
            if (SKILLS.includes(m.skill)) { this.skill = m.skill; for (const b of this.bots.values()) b.skill = m.skill; this.roster(); }
            if (typeof m.mode === "string" && this.match.setMode(m.mode)) { for (const q of this.clients.values()) q.sentTiles = null; this.roster(); }
            if (Number.isFinite(m.bots)) { this.settings.bots = Math.max(0, Math.min(MAX_PLAYERS, Math.round(m.bots))); this.fillBots(); this.roster(); }
        }
    }

    roster() {
        this.broadcast({ t: "roster", host: this.host, state: this.state, cd: Math.ceil(this.countdown / TICK_RATE), result: this.result,
            settings: { mode: this.match.mode, skill: this.skill, bots: this.settings.bots, open: this.settings.open },
            players: this.match.players.map((p) => ({ id: p.id, name: p.name, bot: p.bot, ...this.seatInfo.get(p.id),
                away: ![...this.clients.keys()].includes(p.id) && !p.bot, ping: this.clients.get(p.id)?.ping || 0 })) });
    }

    sendTo(client, message) { client.send(encode(message)); }
    broadcast(message) { const data = encode(message); for (const c of this.clients.values()) c.send(data); }
}
