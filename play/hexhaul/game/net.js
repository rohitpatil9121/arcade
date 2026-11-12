import { Match } from "./sim.js";
import { TICK, TILE } from "./data.js";
import { encode, decode, byteLength, FLAG, INTERP_TICKS, SNAP_EVERY, PROTOCOL } from "./protocol.js";

/**
 * HEXHAUL: the client's side of the network. Adapted from BREACH's.
 *
 * PREDICTION. Each tick the client sends its input and at once applies it to its own robot with the same
 * Match.movePlayer() the server runs, so your robot answers your keys with no round trip. Grabbing,
 * placing and shoving change other things (tiles, other robots), so those wait for the server.
 *
 * RECONCILIATION. Each snapshot carries the server's state for you and the last input it applied. The
 * client takes that state and replays the inputs after it. Small differences are eased away over a
 * few frames; big ones (you were shoved) snap.
 *
 * INTERPOLATION. Other robots are drawn INTERP_TICKS in the past, blended between the snapshots either
 * side, so they move smoothly on 20 updates a second.
 *
 * TILES. The client keeps a copy of the island and runs its countdowns itself (a shaking tile sinks on
 * its own), so the server only has to send a tile when its state changes.
 * @module game/net
 */

const SNAP_DISTANCE = 2;
const BUFFER = 40;

// ------------------------------------------------------------------ transports

/** A room in this page. Messages still go through encode() and decode(), so Practice tests the online path. */
export class Loopback {
    /** @param {import("../server/room.mjs").Room} room */
    constructor(room) { this.room = room; this.id = 0; this.onmessage = null; this.onclose = null; this.open = false; }
    connect(hello) {
        this.open = true;
        this.id = this.room.join((data) => { if (this.open && this.onmessage) this.onmessage(data); }, hello.name, undefined, hello.look);
    }
    send(data) { if (this.open) this.room.receive(this.id, data); }
    close() { if (!this.open) return; this.open = false; this.room.leave(this.id, false); }
}

/** A WebSocket to a HEXHAUL server. */
export class SocketTransport {
    constructor(url) { this.url = url; this.onmessage = null; this.onclose = null; this.open = false; this.ws = null; }
    connect(hello) {
        const ws = (this.ws = new WebSocket(this.url));
        ws.onopen = () => { this.open = true; ws.send(encode({ t: "hello", v: PROTOCOL, ...hello })); };
        ws.onmessage = (e) => { if (this.onmessage) this.onmessage(e.data); };
        ws.onclose = (e) => { const was = this.open; this.open = false; if (this.onclose) this.onclose(e.reason || (was ? "The connection was lost." : "Could not reach the server.")); };
    }
    send(data) { if (this.open && this.ws.readyState === 1) this.ws.send(data); }
    close() { if (this.ws) { this.ws.onclose = null; this.ws.close(); } this.open = false; }
}

/**
 * Bad network on demand: holds every message, each way, for latency / 2 plus up to `jitter` ms. A "lost"
 * message arrives a round trip late (the real transport is TCP, which resends), and everything behind it
 * waits. Call pump() every frame.
 */
export class Conditions {
    constructor(inner, settings = {}) {
        this.inner = inner;
        this.settings = { latency: 0, jitter: 0, loss: 0, ...settings };
        this.onmessage = null; this.onclose = null;
        this.out = []; this.in = [];
        this.lastOut = 0; this.lastIn = 0;
        this.now = settings.now || (() => performance.now());
        this.random = settings.random || Math.random;
        inner.onmessage = (data) => this.hold(this.in, data, "lastIn");
        inner.onclose = (reason) => { if (this.onclose) this.onclose(reason); };
    }
    get open() { return this.inner.open; }
    get active() { const s = this.settings; return s.latency > 0 || s.jitter > 0 || s.loss > 0; }
    connect(hello) { this.inner.connect(hello); }
    hold(queue, data, last) {
        const s = this.settings;
        let due = this.now() + s.latency / 2 + this.random() * s.jitter;
        if (s.loss > 0 && this.random() < s.loss) due += 20 + s.latency;
        if (due < this[last]) due = this[last];
        this[last] = due;
        queue.push({ due, data });
        if (!this.active) this.pump();
    }
    send(data) { this.hold(this.out, data, "lastOut"); }
    pump() {
        const now = this.now();
        while (this.out.length && this.out[0].due <= now) this.inner.send(this.out.shift().data);
        while (this.in.length && this.in[0].due <= now) { const m = this.in.shift(); if (this.onmessage) this.onmessage(m.data); }
    }
    close() { this.inner.close(); }
}

// ------------------------------------------------------------------ the client

export class Client {
    constructor() {
        this.transport = null;
        this.id = 0;
        this.token = "";
        this.joined = false;
        this.room = null;
        this.hostId = 0;
        /** "lobby" or "game", with the lobby's countdown (seconds, 0 for none) and last match's table */
        this.state = "game";
        this.countdown = 0;
        this.result = null;
        this.settings = {};
        /** the island and the round as this client knows them (authority off) */
        this.match = new Match({ authority: false });
        /** my robot, predicted */
        this.me = this.match.addPlayer(-1, "me");
        this.match.players.length = 0;
        this.seq = 0;
        this.pending = [];
        this.prev = { x: 0, y: 0, z: 0 };
        this.offset = { x: 0, y: 0, z: 0 };
        /** id → { id, name, bot, away, ping, wins } */
        this.players = new Map();
        /** recent snapshots: { tick, rows: Map<id, row> } */
        this.snaps = [];
        this.renderTick = 0;
        this.serverTick = 0;
        this.ping = 0;
        this.stats = { bytesIn: 0, bytesOut: 0, snaps: 0, corrections: 0, lastError: 0, replayed: 0 };
        this._count = { bytesIn: 0, bytesOut: 0, snaps: 0, since: 0 };
        /** bytes received since this client was made */
        this.totalIn = 0;
        this._on = new Map();
    }

    /** Listen: "welcome", "roster", "event", "close". */
    on(name, fn) { (this._on.get(name) || this._on.set(name, []).get(name)).push(fn); return this; }
    emit(name, a) { for (const fn of this._on.get(name) || []) { try { fn(a); } catch (error) { console.error(error); } } }

    attach(transport) {
        this.detach();
        this.transport = transport;
        transport.onmessage = (data) => this.receive(data);
        transport.onclose = (reason) => { this.joined = false; this.emit("close", reason); };
    }
    detach() {
        if (this.transport) { this.transport.onmessage = null; this.transport.onclose = null; this.transport.close(); }
        this.transport = null; this.joined = false; this.players.clear(); this.snaps.length = 0; this.pending.length = 0;
    }
    send(message) {
        if (!this.transport) return;
        const data = encode(message);
        this._count.bytesOut += byteLength(data);
        this.transport.send(data);
    }

    /** One step of my own robot, as the server will run it. */
    predict(input) {
        const me = this.me;
        me.input.mx = input.mx; me.input.my = input.my; me.input.buttons = input.buttons;
        if (me.out) { me.lastButtons = input.buttons; return; }
        me.stun = Math.max(0, me.stun - TICK);
        me.cooldown = Math.max(0, me.cooldown - TICK);
        this.match.movePlayer(me, TICK);
    }

    /** Send this tick's controls and predict them. Call once per fixed step. */
    tick(controls) {
        if (!this.joined || this.state === "lobby") return;
        const me = this.me;
        // the island's countdowns run here too
        this.match.events.length = 0;
        this.match.tilesStep(TICK);
        this.match.shotsStep(TICK);
        for (const e of this.match.events) if (e.type === "sink") this.emit("event", e);
        const len = Math.hypot(controls.mx, controls.my), k = len > 1 ? 1 / len : 1;
        const input = { seq: ++this.seq, mx: Math.round(controls.mx * k * 100) / 100, my: Math.round(controls.my * k * 100) / 100, buttons: controls.buttons };
        this.pending.push(input);
        if (this.pending.length > 240) this.pending.shift();
        this.send({ t: "in", s: input.seq, mx: input.mx, my: input.my, b: input.buttons });
        this.prev.x = me.x; this.prev.y = me.y; this.prev.z = me.z;
        this.match.events.length = 0;
        this.predict(input);
        for (const e of this.match.events) if (e.type === "jump") this.emit("event", e);
    }

    receive(data) {
        this._count.bytesIn += byteLength(data);
        this.totalIn += byteLength(data);
        const m = decode(data);
        if (!m) return;
        if (m.t === "snap") this.snapshot(m);
        else if (m.t === "ping") this.send({ t: "pong", n: m.n });
        else if (m.t === "welcome") {
            this.id = m.id; this.token = m.token; this.room = m.room;
            this.me.id = m.id; this.seq = 0; this.pending.length = 0; this.snaps.length = 0;
            this.serverTick = m.tick; this.renderTick = m.tick - INTERP_TICKS;
            this.joined = true;
            this.emit("welcome", m);
        } else if (m.t === "roster") {
            const seen = new Set();
            for (const r of m.players) { seen.add(r.id); this.players.set(r.id, { wins: 0, ...(this.players.get(r.id) || {}), ...r }); }
            for (const id of [...this.players.keys()]) if (!seen.has(id)) this.players.delete(id);
            this.hostId = m.host;
            const wasLobby = this.state;
            this.state = m.state; this.countdown = m.cd; this.result = m.result; this.settings = m.settings;
            if (wasLobby === "lobby" && m.state === "game") { this.pending.length = 0; this.snaps.length = 0; }
            if (this.room) this.room.host = m.host;
            this.emit("roster", m);
        } else if (m.t === "emote") this.emit("event", { type: "emote", id: m.id, n: m.n });
        else if (m.t === "error") this.emit("close", m.text);
    }

    snapshot(m) {
        this._count.snaps++;
        this.serverTick = m.tick;
        const mt = this.match;
        if (m.rd !== mt.round) this.emit("event", { type: "round", round: m.rd });
        mt.phase = m.ph; mt.clock = m.cl / 100; mt.round = m.rd; mt.time = m.tm / 100; mt.winner = m.win; mt.winnerTeam = m.wt;
        mt.mode = m.md; mt.hauled = m.ha; mt.haulGoalShown = m.ht; mt.storm = m.st;
        for (const [id, w, team, hits, tiles, hauled, falls] of m.wins) { const info = this.players.get(id); if (info) { info.wins = w; info.team = team; info.stats = { hits, tiles, hauled, falls }; } }
        mt.shots = m.sh.map((r) => ({ sid: r[0], type: r[1] ? "buoy" : "tile", kind: r[2], x: r[3] / 100, y: r[4] / 100, z: r[5] / 100, vx: r[6] / 100, vy: r[7] / 100, vz: r[8] / 100 }));
        for (const [i, state, t, placed, kind, raft, fuse] of m.tl) {
            const tile = mt.tiles[i];
            tile.state = state; tile.t = t / 100; tile.kind = kind; tile.raft = raft; tile.fuse = fuse / 100;
            tile.placed = placed ? Math.min(tile.placed > mt.time - TILE.fresh ? tile.placed : mt.time, mt.time) : -99;
        }
        // a snapshot carries only the robots that changed
        const last = this.snaps[this.snaps.length - 1], rows = new Map();
        if (last) for (const [id, row] of last.rows) if (this.players.has(id)) rows.set(id, row);
        for (const row of m.p) rows.set(row[0], row);
        this.snaps.push({ tick: m.tick, rows });
        if (this.snaps.length > BUFFER) this.snaps.shift();
        const info = this.players.get(this.id);
        this.ping = m.pg ?? this.ping;
        if (info) info.ping = this.ping;

        if (m.you) this.reconcile(m.you, m.ack);
        for (const e of m.ev) {
            if (e.type === "sink") continue;                               // run here already
            if (e.type === "jump" && e.id === this.id) continue;           // predicted
            this.emit("event", e);
        }
    }

    /** Take the server's word for my robot, then replay what it hasn't seen yet. */
    reconcile(you, ack) {
        const me = this.me, bx = me.x, by = me.y, bz = me.z, wasOut = me.out;
        while (this.pending.length && this.pending[0].seq <= ack) this.pending.shift();
        Object.assign(me, you);
        const events = this.match.events.length;
        for (const input of this.pending) this.predict(input);
        this.match.events.length = events;
        this.stats.replayed = this.pending.length;
        const ex = bx - me.x, ey = by - me.y, ez = bz - me.z, error = Math.hypot(ex, ey, ez);
        this.stats.lastError = error;
        if (error < 1e-4) return;
        this.stats.corrections++;
        if (error > SNAP_DISTANCE || wasOut !== me.out) { this.offset.x = this.offset.y = this.offset.z = 0; this.prev.x = me.x; this.prev.y = me.y; this.prev.z = me.z; return; }
        this.offset.x += ex; this.offset.y += ey; this.offset.z += ez;
        this.prev.x -= ex; this.prev.y -= ey; this.prev.z -= ez;
    }

    /** Advance the drawing clocks. Call once per rendered frame. */
    frame(dt) {
        if (this.transport && this.transport.pump) this.transport.pump();
        const k = Math.exp(-dt * 12);
        this.offset.x *= k; this.offset.y *= k; this.offset.z *= k;
        const target = this.serverTick - INTERP_TICKS, gap = target - this.renderTick;
        if (Math.abs(gap) > 60) this.renderTick = target;
        else this.renderTick += dt * 60 * (1 + Math.max(-0.25, Math.min(0.75, (gap - SNAP_EVERY * 0.5) * 0.1)));
        if (this.renderTick > this.serverTick) this.renderTick = this.serverTick;
        const c = this._count;
        if ((c.since += dt) >= 1) {
            this.stats.bytesIn = Math.round(c.bytesIn / c.since); this.stats.bytesOut = Math.round(c.bytesOut / c.since); this.stats.snaps = Math.round(c.snaps / c.since);
            c.bytesIn = c.bytesOut = c.snaps = 0; c.since = 0;
        }
    }

    /** My robot between ticks, with any correction still being eased. */
    myPosition(alpha, out) {
        const me = this.me, p = this.prev, o = this.offset;
        out.x = p.x + (me.x - p.x) * alpha + o.x; out.y = p.y + (me.y - p.y) * alpha + o.y; out.z = p.z + (me.z - p.z) * alpha + o.z;
        return out;
    }

    /** Another robot at the moment being drawn. @returns {boolean} false if nothing is known yet */
    sample(id, out) {
        const snaps = this.snaps, t = this.renderTick;
        let a = null, b = null;
        for (let i = snaps.length - 1; i >= 0; i--) {
            if (!snaps[i].rows.has(id)) continue;
            if (snaps[i].tick <= t) { a = snaps[i]; break; }
            b = snaps[i];
        }
        if (!a) a = b;
        if (!b) b = a;
        if (!a) return false;
        const ra = a.rows.get(id), rb = b.rows.get(id);
        let f = b.tick > a.tick ? (t - a.tick) / (b.tick - a.tick) : 0;
        f = Math.max(0, Math.min(1, f));
        const dx = rb[1] - ra[1], dy = rb[2] - ra[2], dz = rb[3] - ra[3];
        // a new round puts everyone back at the start: a jump, not a slide
        if (dx * dx + dy * dy > 400 * 400) f = f < 0.5 ? 0 : 1;
        out.x = (ra[1] + dx * f) / 100; out.y = (ra[2] + dy * f) / 100; out.z = (ra[3] + dz * f) / 100;
        let df = rb[4] - ra[4];
        if (df > 314) df -= 628; else if (df < -314) df += 628;
        out.face = (ra[4] + df * f) / 100;
        const near = f < 0.5 ? ra : rb;
        out.flags = near[5]; out.charge = near[6] / 100; out.swim = near[7] / 10; out.carryKind = near[8]; out.buoy = !!(near[5] & FLAG.BUOY);
        out.ground = !!(near[5] & FLAG.GROUND); out.out = !!(near[5] & FLAG.OUT); out.carry = !!(near[5] & FLAG.CARRY); out.charging = !!(near[5] & FLAG.CHARGING);
        return true;
    }
}
