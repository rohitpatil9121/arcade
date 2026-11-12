import { CHANGES, SCHEDULE, PHYS } from "./data.js";

/**
 * FAULTLINE: the ground. Pure and deterministic: no DOM, no Math.random, no clock.
 *
 * Height is a function of distance and time, h(x, t) = base(x) + the sum of every ground change's offset.
 * The base is seeded value noise, so any x can be asked for without building chunks. Ground changes are
 * shaped offsets that ease in over time and then stay (a heave leaves a hill behind), except cracks, which
 * open and close again.
 *
 * Natural changes are laid out ahead of the leading vehicle in seeded order and armed when it gets close
 * enough, so the change happens around the time it arrives. A change goes WARN (rumble, glow) → MOVE → DONE.
 * @module game/terrain
 */

/** mulberry32: a small seeded generator returning [0, 1). */
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

/** a hash of an integer lattice point and a seed, to [0, 1) */
function hash(i, seed) {
    let h = Math.imul(i ^ 0x27d4eb2d, 0x165667b1) ^ Math.imul(seed, 0x9e3779b1);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca77);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae3d);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** smooth 1D value noise in [-1, 1] */
export function noise(x, seed) {
    const i = Math.floor(x), f = x - i, u = f * f * f * (f * (f * 6 - 15) + 10);
    return (hash(i, seed) * (1 - u) + hash(i + 1, seed) * u) * 2 - 1;
}

const smooth = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
const lerp = (a, b, t) => a + (b - a) * t;

export const WARN = 0, MOVE = 1, DONE = 2, CLOSED = 3;

export class Terrain {
    /**
     * @param {object} biome an entry of BIOMES
     * @param {number} seed
     */
    constructor(biome, seed) {
        this.biome = biome;
        this.seed = seed >>> 0;
        this.random = rng(this.seed ^ 0x5eed);
        /** every change that is pending, warning, moving or done and still near */
        this.events = [];
        this.nextId = 1;
        /** where the next natural change goes */
        this.nextX = biome.calm + lerp(SCHEDULE.start[0], SCHEDULE.start[1], this.random()) * 0.5;
        this.tension = 0;
        this.nextTension = SCHEDULE.tensionEvery;
        /** changes whose moving phase just started or ended this step (for close calls) */
        this.moved = [];
        this.time = 0;
        this.vents = [];
        if (biome.vents) for (let x = 120; x < 20000; x += biome.vents * (0.7 + 0.6 * hash(x | 0, this.seed + 7))) this.vents.push({ x, phase: hash(x | 0, this.seed + 9) * 5 });
    }

    /** difficulty from 0 at the start to 1 by SCHEDULE.rampKm */
    difficulty(x) { return Math.max(0, Math.min(1, x / (SCHEDULE.rampKm * 1000))); }

    /** the base road before any change */
    base(x) {
        const b = this.biome, s = this.seed;
        const grow = 1 + b.grow * this.difficulty(x);
        let h = 0, k = 0;
        for (const [wave, amp] of b.octaves) h += noise(x / wave, s + 31 * ++k) * amp;
        // a flat start, easing into the hills
        h = h * grow * smooth((x + 10) / 60);
        if (b.tide) {
            // the low ground is mudflat: valleys flatten out where the high tide would stand 1.6 m deep
            const floor = b.tide.high - CHANGES.tide.depth, k = 1.4;
            h = (h + floor + Math.sqrt((h - floor) * (h - floor) + k * k)) / 2;
            // a dry bank every 60-90 m, so no flat is too long to cross between tides
            const c = Math.cos(2 * Math.PI * (x / 75 + noise(x / 300, s + 99) * 0.3));
            if (c > 0) h += 2.6 * c ** 6;
        }
        return h;
    }

    /** offset of one change at x and t */
    offset(e, x, t) {
        if (e.pending || x < e.x0 - 1 || x > e.x1 + 1 || t < e.tMove) return 0;
        if (e.type === "crack") {
            const open = t < e.tOpen ? smooth((t - e.tMove) / (e.tOpen - e.tMove))
                : t < e.tClose ? 1 : t < e.tEnd ? 1 - smooth((t - e.tClose) / (e.tEnd - e.tClose)) : 0;
            const wall = 0.25, d = Math.min(x - e.x0, e.x1 - x);
            return d <= 0 ? 0 : -e.amp * open * smooth(d / wall);
        }
        const p = e.type === "fault" ? Math.min(1, (t - e.tMove) / (e.tEnd - e.tMove)) : smooth((t - e.tMove) / (e.tEnd - e.tMove));
        if (e.type === "fault") {
            // a wall at `at`, then a long ramp back to the old level
            const face = e.face;
            let s;
            if (x < e.at - face) s = 0;
            else if (x < e.at) s = smooth((x - (e.at - face)) / face);
            else s = 1 - smooth((x - e.at) / (e.x1 - e.at));
            return e.amp * e.sign * s * p;
        }
        // heave, slump, charge: a bell, its peak moved by `skew` so one side can be steeper (a ramp)
        let s;
        if (x <= e.peak) s = (x - e.x0) / (e.peak - e.x0);
        else s = (e.x1 - x) / (e.x1 - e.peak);
        s = s <= 0 ? 0 : 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, s));
        return e.amp * e.sign * s * p;
    }

    /** ground height at x and time t */
    h(x, t = this.time) {
        let y = this.base(x);
        for (let i = 0; i < this.events.length; i++) { const e = this.events[i]; if (x >= e.x0 - 1 && x <= e.x1 + 1) y += this.offset(e, x, t); }
        return y;
    }

    /** ground height without open cracks, to tell how far into one something has fallen */
    rim(x, t = this.time) {
        let y = this.base(x);
        for (const e of this.events) if (e.type !== "crack" && x >= e.x0 - 1 && x <= e.x1 + 1) y += this.offset(e, x, t);
        return y;
    }

    /** vertical speed of the ground at x, capped as PHYS asks */
    rate(x, t = this.time) {
        const d = 1 / 240;
        const r = (this.h(x, t + d) - this.h(x, t - d)) / (2 * d);
        return Math.max(-30, Math.min(PHYS.groundMaxRise + 2, r));
    }

    /** the crack open at x, or null */
    crackAt(x, t = this.time) {
        for (const e of this.events) if (e.type === "crack" && x > e.x0 && x < e.x1 && t >= e.tMove && t < e.tEnd) return e;
        return null;
    }

    /** water level (Infinity below means none) and whether it is rising */
    water(t = this.time) {
        const tide = this.biome.tide;
        if (!tide) return { level: -Infinity, rising: false, warn: false };
        const P = CHANGES.tide.period, phase = (t + P * 0.5) % P;
        const k = 0.5 - 0.5 * Math.cos((2 * Math.PI * phase) / P);
        const rising = phase < P / 2;
        return { level: lerp(tide.low, tide.high, k), rising, warn: rising || phase > P - CHANGES.tide.warn };
    }

    surface(x) { return this.biome.surface(x, this.base(x)); }

    /** upward push from a steam vent at x (Ash Fields), and whether one is about to blow */
    vent(x, t = this.time) {
        for (const v of this.vents) {
            if (v.x > x + 2) break;
            if (Math.abs(v.x - x) > 1.6) continue;
            const c = (t + v.phase) % 5;
            return { push: c > 4.3 ? 38 : 0, warn: c > 3.1 && c <= 4.3 };
        }
        return { push: 0, warn: false };
    }

    /**
     * Add a change. `at` is its centre (or the wall, for a fault). Returns the change.
     * @param {"heave" | "slump" | "fault" | "crack" | "charge"} type
     */
    add(type, at, opts, t = this.time) {
        const c = CHANGES[type === "charge" ? "charge" : type];
        const e = { id: this.nextId++, type, natural: !opts.charge, state: WARN, tWarn: t, ...opts };
        e.tMove = t + (opts.warn ?? c.warn * (this.warnScale || 1));
        if (type === "crack") {
            e.x0 = at - e.width / 2; e.x1 = at + e.width / 2; e.amp = CHANGES.crack.depth; e.sign = -1;
            e.tOpen = e.tMove + c.move; e.tClose = e.tOpen + e.open; e.tEnd = e.tClose + c.close;
        } else if (type === "fault") {
            e.at = at; e.face = e.sign > 0 ? Math.max(1.6, e.amp * 1.1) : 0.35;
            e.x0 = at - e.face; e.x1 = at + e.width;
            e.tEnd = e.tMove + Math.max(0.4, e.amp / c.speed);
        } else {
            e.x0 = at - e.width / 2; e.x1 = at + e.width / 2;
            e.peak = at + (e.skew || 0) * e.width / 2;
            e.tEnd = e.tMove + (opts.move ?? (type === "charge" ? 0.8 : c.move));
        }
        e.center = (e.x0 + e.x1) / 2;
        this.events.push(e);
        return e;
    }

    /** pick the next natural change, without placing it yet */
    plan(x) {
        const b = this.biome, r = this.random, d = this.difficulty(x);
        let total = 0;
        for (const k in b.changes) total += b.changes[k];
        let pick = r() * total, type = "heave";
        for (const k in b.changes) { pick -= b.changes[k]; if (pick <= 0) { type = k; break; } }
        // on tidal flats a slump would dig a pool deeper than any tide; it heaves instead
        if (b.tide && type === "slump" && this.base(x) < b.tide.high + 0.8) type = "heave";
        const c = CHANGES[type], size = r() * (0.35 + 0.65 * d);
        if (type === "crack") return { type, width: lerp(c.width[0], c.width[1], size), open: lerp(c.open[0], c.open[1], r()) };
        if (type === "fault") {
            const sign = r() < 0.6 ? -1 : 1;
            return { type, sign, amp: lerp(c.amp[0], sign > 0 ? 1.6 : c.amp[1], size), width: lerp(c.width[0], c.width[1], r()) };
        }
        const skew = type === "heave" && r() < 0.6 ? 0.35 + r() * 0.3 : (r() - 0.5) * 0.3;
        return { type, sign: type === "slump" ? -1 : 1, amp: lerp(c.amp[0], c.amp[1], size), width: lerp(c.width[0], c.width[1], r()), skew };
    }

    /**
     * Lay out natural changes ahead of the leader, arm the ones it is close to, and forget old ones.
     * @param {number} t time
     * @param {number} lead x of the leading vehicle
     * @param {number} speed its speed along x
     * @param {number} tail x of the last vehicle still running
     * @param {(e: object) => void} [onPlan] told about each change when it is laid out (for pickups)
     */
    update(t, lead, speed, tail, onPlan) {
        this.time = t;
        this.moved.length = 0;
        while (this.nextX < lead + 260) {
            const p = this.plan(this.nextX);
            const at = this.nextX;
            const pending = { ...p, at, arm: 0.7 + this.random() * 0.6, pending: true, id: this.nextId++, x0: at - 10, x1: at + 10, center: at };
            this.events.push(pending);
            onPlan?.(pending);
            const d = this.difficulty(at);
            let gap = lerp(lerp(SCHEDULE.start[0], SCHEDULE.end[0], d), lerp(SCHEDULE.start[1], SCHEDULE.end[1], d), this.random());
            if (this.tension > 0) { gap = 38 + this.random() * 22; this.tension--; }
            else if (at > this.nextTension) { this.tension = 1 + (this.random() < 0.5 ? 1 : 0); this.nextTension += SCHEDULE.tensionEvery * (0.8 + this.random() * 0.4); }
            this.nextX = at + gap;
        }
        for (let i = 0; i < this.events.length; i++) {
            const e = this.events[i];
            if (e.pending) {
                const c = CHANGES[e.type];
                const lead_time = c.warn + (c.move || 0.5) * 0.5;
                // a crack always opens before you get there: you see the gap and choose to jump or wait
                const arm = e.type === "crack" ? Math.max(1.1, e.arm + 0.3) : e.arm;
                const reach = Math.max(22, Math.min(120, speed * lead_time * arm + 8));
                if (lead >= e.at - reach) {
                    const real = this.add(e.type, e.at, { ...e, pending: false, id: undefined }, t);
                    real.id = e.id;
                    this.events[i] = real;
                    this.events.pop();
                }
                continue;
            }
            const was = e.state;
            e.state = t < e.tMove ? WARN : t < e.tEnd ? MOVE : e.type === "crack" ? CLOSED : DONE;
            if (was !== e.state && (e.state === MOVE || was === MOVE)) this.moved.push(e);
        }
        // forget changes far behind everybody; a crack that has closed leaves nothing behind
        this.events = this.events.filter((e) => !(e.x1 < tail - 120 && (e.state === DONE || e.state === CLOSED)) && e.state !== CLOSED);
    }
}
