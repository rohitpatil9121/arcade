import { PHYS, SURFACE, VEHICLES, UPGRADES, FUEL, CHANGES, SCORE, BIOMES, RACE } from "./data.js";
import { Terrain, rng, WARN, MOVE } from "./terrain.js";
import { Driver } from "./driver.js";

/**
 * FAULTLINE: the simulation. Pure and deterministic: the same seed and the same inputs give the same run,
 * to the bit. No DOM, no Math.random, no clock. main.js and the Node tools both drive it.
 *
 * A vehicle is a rigid chassis and two wheels. Each wheel is its own small body, held to the chassis by a
 * spring-damper along the suspension axis and a hard constraint across it. Wheels and chassis touch the
 * ground by sampling h(x, t) into short segments; contact uses the ground's own vertical speed, so a rising
 * hill throws the vehicle up and a sinking one drops out from under it. Velocity constraints are solved by
 * sequential impulses, a few passes per substep, then positions are pushed back out of the ground.
 * @module game/sim
 */

const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** closest ground point to (px, py) within `reach`, as signed distance and outward normal */
function ground(terrain, px, py, reach, t) {
    const step = PHYS.sample, x0 = px - reach, n = Math.max(2, Math.ceil((reach * 2) / step));
    let best = Infinity, bx = 0, by = 0, nx = 0, ny = 1;
    let ax = x0, ay = terrain.h(ax, t);
    for (let i = 1; i <= n; i++) {
        const cx = x0 + i * step, cy = terrain.h(cx, t);
        const dx = cx - ax, dy = cy - ay, len2 = dx * dx + dy * dy;
        let u = ((px - ax) * dx + (py - ay) * dy) / len2;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        const qx = ax + dx * u, qy = ay + dy * u, ex = px - qx, ey = py - qy, d2 = ex * ex + ey * ey;
        if (d2 < best) {
            best = d2; bx = qx; by = qy;
            const len = Math.sqrt(len2);
            nx = -dy / len; ny = dx / len;
        }
        ax = cx; ay = cy;
    }
    let dist = Math.sqrt(best);
    const below = py < terrain.h(px, t);
    if (below) dist = -dist;
    else if (dist > 1e-4) {
        // above the ground: the normal points from the ground to the point (round corners on steps)
        const ex = (px - bx) / dist, ey = (py - by) / dist;
        if (ex * nx + ey * ny > 0.2) { nx = ex; ny = ey; }
    }
    return { dist, nx, ny, x: bx, y: by };
}

export class Vehicle {
    /**
     * @param {object} spec an entry of VEHICLES
     * @param {Record<string, number>} up upgrade levels
     * @param {number} x start x
     * @param {number} y ground height there
     */
    constructor(spec, up = {}, x = 0, y = 0) {
        this.spec = spec;
        const lv = (k) => up[k] || 0;
        this.torque = spec.torque * (1 + UPGRADES.engine * lv("engine"));
        this.spinMax = spec.spin * (1 + UPGRADES.engine * 0.6 * lv("engine"));
        this.grip = spec.grip * (1 + UPGRADES.tyres * lv("tyres"));
        this.travel = spec.travel * (1 + UPGRADES.suspension * lv("suspension"));
        this.damper = spec.damper * (1 + UPGRADES.suspension * 0.8 * lv("suspension"));
        this.tank = spec.tank * (1 + UPGRADES.tank * lv("tank"));
        this.m = spec.mass; this.I = spec.inertia;
        this.x = x; this.y = y + spec.rest + 0.9; this.a = 0;
        this.vx = 0; this.vy = 0; this.w = 0;
        const [cx, cy] = spec.com;
        this.head = [spec.head[0] - cx, spec.head[1] - cy];
        const [bx, by] = spec.body;
        this.corners = [[-bx - cx, -by - cy], [bx - cx, -by - cy], [bx - cx, by - cy], [-bx - cx, by - cy], [-cx, by + 0.15 - cy]];
        this.wheels = spec.wheels.map((w) => {
            const lx = w.x - cx, ly = w.y - cy;
            return {
                lx, ly, r: w.r, m: w.mass, I: 0.5 * w.mass * w.r * w.r, drive: w.drive,
                x: this.x + lx, y: this.y + ly - spec.rest, vx: 0, vy: 0, spin: 0, angle: 0,
                touching: false, s: spec.rest, normal: 0,
            };
        });
        this.fuel = this.tank;
        this.alive = true;
        this.end = null;
        this.air = 0;            // seconds without touching
        this.airRot = 0;         // rotation while airborne
        this.touching = false;
        this.bodyTouch = false;
        this.stuck = 0;
        this.empty = 0;
        this.soak = 0;           // seconds the engine has been under water
        this.gas = 0; this.brake = 0;
        this.load = 0;           // engine load 0..1, for sound
        this.launch = null;      // the change that threw us into the air
        this.impact = 0;         // hardest landing this step, m/s
        this.distance = 0;
    }

    /** a body-space point in the world */
    world(lx, ly) {
        const c = Math.cos(this.a), s = Math.sin(this.a);
        return [this.x + lx * c - ly * s, this.y + lx * s + ly * c];
    }
    get speed() { return Math.hypot(this.vx, this.vy); }

    /** impulse (jx, jy) on the chassis at world point (px, py) */
    push(jx, jy, px, py) {
        this.vx += jx / this.m; this.vy += jy / this.m;
        this.w += ((px - this.x) * jy - (py - this.y) * jx) / this.I;
    }
    /** chassis velocity at a world point */
    velAt(px, py) { return [this.vx - this.w * (py - this.y), this.vy + this.w * (px - this.x)]; }

    /**
     * One substep. `terrain` is shared; `dt` is 1 / (hz * substeps).
     */
    substep(terrain, t, dt) {
        const spec = this.spec, g = PHYS.gravity;
        const ca = Math.cos(this.a), sa = Math.sin(this.a);
        const dx = sa, dy = -ca;        // suspension axis, body down
        const ux = ca, uy = sa;         // across it, body forward
        let gas = this.alive && this.fuel > 0 ? this.gas : 0;
        let brake = this.alive ? this.brake : 0;
        if (!this.alive) { gas = 0; brake = 0.4; }

        // ---------------------------------------------------------- forces
        this.vy -= g * dt;
        const water = terrain.water(t).level;
        if (water > this.y - 0.5) {
            const f = clamp((water - (this.y - 0.5)) / 0.9, 0, 1);
            this.vx *= 1 - 2.2 * f * dt; this.vy *= 1 - 2.2 * f * dt; this.w *= 1 - 1.5 * f * dt;
            this.vy += 7 * f * dt;
        }
        const vent = terrain.vent(this.x, t);
        if (vent.push && this.y - terrain.h(this.x, t) < 5) this.vy += vent.push * dt;

        // forward speed along the body, to tell braking from reversing
        const along = this.vx * ux + this.vy * uy;
        let reaction = 0;
        for (const w of this.wheels) {
            w.vy -= g * dt;
            const r = w.r;
            if (gas > 0 && w.drive > 0) {
                const fwd = -w.spin * r;                                       // rim speed forward
                const k = clamp(1 - fwd / (this.spinMax * r), 0, 1);
                const tq = this.torque * w.drive * gas * k;
                w.spin -= (tq / w.I) * dt; reaction += tq;
            }
            if (brake > 0) {
                if (along > 1.2 || -w.spin * r > 1.2) {
                    // brake: pull the spin toward zero
                    const tq = spec.brake * 0.5 * brake, change = (tq / w.I) * dt;
                    if (Math.abs(w.spin) <= change) { reaction += (w.spin * w.I) / dt; w.spin = 0; }
                    else { const sg = Math.sign(w.spin); w.spin -= sg * change; reaction += sg * tq; }
                } else if (w.drive > 0) {
                    // slow or stopped: brake reverses, gently
                    const back = w.spin * r;
                    const k = clamp(1 - back / (this.spinMax * r * 0.35), 0, 1);
                    const tq = this.torque * 0.45 * w.drive * brake * k;
                    w.spin += (tq / w.I) * dt; reaction -= tq;
                }
            }
            // rolling drag from the surface, when touching
            if (w.touching) w.spin *= 1 - SURFACE[terrain.surface(w.x)].roll * 20 * dt;

            // suspension spring and damper, along the axis
            const [mx, my] = this.world(w.lx, w.ly);
            const s = (w.x - mx) * dx + (w.y - my) * dy;
            const [vmx, vmy] = this.velAt(mx, my);
            const rel = (w.vx - vmx) * dx + (w.vy - vmy) * dy;
            const f = spec.spring * (spec.rest - s) - this.damper * rel;
            const fx = f * dx * dt, fy = f * dy * dt;
            w.vx += fx / w.m; w.vy += fy / w.m;
            this.push(-fx, -fy, mx, my);
            w.s = s;
        }
        this.w += (reaction / this.I) * dt;

        // air control: gas tips the nose up, brake tips it down
        if (!this.touching && !this.bodyTouch && this.air > 0.06) {
            const want = (gas > 0 ? 1 : 0) - (brake > 0 ? 1 : 0);
            const max = PHYS.airSpinMax * spec.air;
            if (want && this.w * want < max) this.w += want * PHYS.airTorque * spec.air * dt * 1.6;
        }

        // ---------------------------------------------------------- contacts and constraints
        const contacts = [];
        for (const w of this.wheels) {
            const q = ground(terrain, w.x, w.y, w.r + 0.35, t);
            w.contact = null;
            if (q.dist < w.r + 0.02) {
                const surf = SURFACE[terrain.surface(w.x)];
                w.contact = { nx: q.nx, ny: q.ny, pen: w.r - q.dist, gv: terrain.rate(q.x, t), mu: this.grip * surf.grip, jn: 0, jt: 0 };
            }
        }
        for (const p of this.corners) {
            const [px, py] = this.world(p[0], p[1]);
            const q = ground(terrain, px, py, 0.4, t);
            if (q.dist < 0.01) contacts.push({ px, py, nx: q.nx, ny: q.ny, pen: -q.dist, gv: terrain.rate(q.x, t), jn: 0, jt: 0 });
        }

        const wheelLat = this.wheels.map((w) => {
            const [mx, my] = this.world(w.lx, w.ly);
            const rx = mx - this.x, ry = my - this.y;
            const cross = rx * uy - ry * ux;
            const crossD = rx * dy - ry * dx;
            return {
                mx, my, rx, ry,
                e: (w.x - mx) * ux + (w.y - my) * uy,
                k: 1 / (1 / w.m + 1 / this.m + (cross * cross) / this.I),
                kd: 1 / (1 / w.m + 1 / this.m + (crossD * crossD) / this.I),
                jd: 0,
            };
        });

        for (let it = 0; it < PHYS.iterations; it++) {
            // wheel held across the suspension axis
            this.wheels.forEach((w, i) => {
                const L = wheelLat[i];
                const vmx = this.vx - this.w * L.ry, vmy = this.vy + this.w * L.rx;
                const rel = (w.vx - vmx) * ux + (w.vy - vmy) * uy;
                const j = -(rel + (0.2 * L.e) / dt) * L.k;
                w.vx += (j * ux) / w.m; w.vy += (j * uy) / w.m;
                this.push(-j * ux, -j * uy, L.mx, L.my);
                // bump stop: the wheel may not come closer than rest - travel
                const s = (w.x - L.mx) * dx + (w.y - L.my) * dy, smin = spec.rest - this.travel;
                if (s < smin + 0.005) {
                    const reld = (w.vx - vmx) * dx + (w.vy - vmy) * dy;
                    let jd = -(reld - (0.25 * (smin - s)) / dt) * L.kd;
                    const old = L.jd; L.jd = Math.max(0, old + jd); jd = L.jd - old;
                    w.vx += (jd * dx) / w.m; w.vy += (jd * dy) / w.m;
                    this.push(-jd * dx, -jd * dy, L.mx, L.my);
                }
            });
            // wheels on the ground
            for (const w of this.wheels) {
                const c = w.contact;
                if (!c) continue;
                const rx = -c.nx * w.r, ry = -c.ny * w.r;
                const tx = c.ny, ty = -c.nx;
                const pvx = w.vx - w.spin * ry, pvy = w.vy + w.spin * rx - c.gv;
                const vn = pvx * c.nx + pvy * c.ny;
                let jn = -(vn - (0.2 * Math.max(0, c.pen - 0.005)) / dt) * w.m;
                const oldN = c.jn; c.jn = Math.max(0, oldN + jn); jn = c.jn - oldN;
                w.vx += (jn * c.nx) / w.m; w.vy += (jn * c.ny) / w.m;
                const vt = (w.vx - w.spin * ry) * tx + (w.vy + w.spin * rx - c.gv) * ty;
                const crossT = rx * ty - ry * tx;
                const kt = 1 / (1 / w.m + (crossT * crossT) / w.I);
                let jt = -vt * kt;
                const max = c.mu * c.jn, oldT = c.jt;
                c.jt = clamp(oldT + jt, -max, max); jt = c.jt - oldT;
                w.vx += (jt * tx) / w.m; w.vy += (jt * ty) / w.m;
                w.spin += (crossT * jt) / w.I;
            }
            // chassis on the ground
            for (const c of contacts) {
                const rx = c.px - this.x, ry = c.py - this.y;
                const [pvx, pvy0] = this.velAt(c.px, c.py), pvy = pvy0 - c.gv;
                const crossN = rx * c.ny - ry * c.nx;
                const vn = pvx * c.nx + pvy * c.ny;
                let jn = -(vn - (0.2 * Math.max(0, c.pen - 0.01)) / dt) / (1 / this.m + (crossN * crossN) / this.I);
                const oldN = c.jn; c.jn = Math.max(0, oldN + jn); jn = c.jn - oldN;
                this.push(jn * c.nx, jn * c.ny, c.px, c.py);
                const tx = c.ny, ty = -c.nx;
                const [qx, qy0] = this.velAt(c.px, c.py);
                const vt = qx * tx + (qy0 - c.gv) * ty;
                const crossT = rx * ty - ry * tx;
                let jt = -vt / (1 / this.m + (crossT * crossT) / this.I);
                const max = PHYS.bodyFriction * c.jn, oldT = c.jt;
                c.jt = clamp(oldT + jt, -max, max); jt = c.jt - oldT;
                this.push(jt * tx, jt * ty, c.px, c.py);
            }
        }

        // ---------------------------------------------------------- integrate
        this.x += this.vx * dt; this.y += this.vy * dt; this.a += this.w * dt;
        let touching = false, impact = 0;
        for (const w of this.wheels) {
            w.x += w.vx * dt; w.y += w.vy * dt; w.angle += w.spin * dt;
            if (w.contact) {
                touching = true;
                impact = Math.max(impact, w.contact.jn / w.m);
                w.normal = w.contact.jn / dt;
            } else w.normal = 0;
            w.touching = !!w.contact;
            // push out of the ground
            const q = ground(terrain, w.x, w.y, w.r + 0.3, t + dt);
            if (q.dist < w.r) { const p = w.r - q.dist; w.x += q.nx * p; w.y += q.ny * p; }
        }
        let bodyTouch = contacts.length > 0;
        for (const p of this.corners) {
            const [px, py] = this.world(p[0], p[1]);
            const q = ground(terrain, px, py, 0.3, t + dt);
            if (q.dist < 0) { this.x += q.nx * -q.dist * 0.8; this.y += q.ny * -q.dist * 0.8; bodyTouch = true; }
        }
        // keep each wheel on its axis (it is light; the chassis does not notice)
        const ca2 = Math.cos(this.a), sa2 = Math.sin(this.a);
        for (const w of this.wheels) {
            const mx = this.x + w.lx * ca2 - w.ly * sa2, my = this.y + w.lx * sa2 + w.ly * ca2;
            const e = (w.x - mx) * ca2 + (w.y - my) * sa2;
            w.x -= e * ca2; w.y -= e * sa2;
            const s = (w.x - mx) * sa2 - (w.y - my) * ca2, smax = spec.rest + this.travel * 0.6;
            if (s > smax) { w.x -= (s - smax) * sa2; w.y += (s - smax) * ca2; }
        }
        this.substepTouch = touching || this.substepTouch;
        this.substepBody = bodyTouch || this.substepBody;
        this.impact = Math.max(this.impact, impact);
    }
}

/** A run: the ground, the player's vehicle, rivals in a race, pickups, score. */
export class Run {
    /**
     * @param {{ biome?: number | string, vehicle?: string, upgrades?: Record<string, number>, seed?: number,
     *           mode?: "endless" | "race" | "daily", difficulty?: "easy" | "normal" | "hard", assist?: boolean }} o
     */
    constructor(o = {}) {
        this.biome = typeof o.biome === "string" ? BIOMES.find((b) => b.id === o.biome) : BIOMES[o.biome || 0];
        this.seed = (o.seed ?? 1) >>> 0;
        this.mode = o.mode || "endless";
        this.assist = !!o.assist;
        this.terrain = new Terrain(this.biome, this.seed);
        if (this.assist) this.terrain.warnScale = 1.5;
        this.random = rng(this.seed ^ 0xc01d);
        this.t = 0;
        this.tick = 0;
        this.startX = 0;
        const spec = VEHICLES.find((v) => v.id === (o.vehicle || "buggy"));
        this.player = new Vehicle(spec, o.upgrades || {}, 0, this.terrain.h(0, 0));
        this.player.name = "Pip";
        this.player.isPlayer = true;
        this.vehicles = [this.player];
        this.drivers = new Map();
        if (this.mode === "race") {
            const diff = RACE.difficulty[o.difficulty || "normal"];
            RACE.rivals.forEach((r, i) => {
                const lv = diff.upgrades, up = { engine: lv, suspension: lv, tyres: lv, tank: lv, charges: 0 };
                const v = new Vehicle(VEHICLES.find((s) => s.id === r.vehicle), up, -3 - i * 0.5, this.terrain.h(-3 - i * 0.5, 0));
                v.name = r.name; v.color = r.color; v.rival = i;
                v.charges = Math.round(diff.charge * 2);
                this.vehicles.push(v);
                this.drivers.set(v, new Driver({ style: r.style, ...diff }, this.seed + i * 101));
            });
        }
        const up = o.upgrades || {};
        this.player.charges = UPGRADES.charges[up.charges || 0];
        this.coins = 0;
        this.coinsFromTricks = 0;
        this.tricks = { flips: 0, rides: 0, closeCalls: 0, bestAir: 0, chargesUsed: 0, rampJumps: 0, caches: 0 };
        this.pickups = [];
        this.nextCan = FUEL.firstCan;
        this.canGap = FUEL.firstCan;
        this.nextCharge = 600;
        this.nextCache = 900;
        this.coinSeg = 0;
        this.events = [];         // what happened this step, for sound and effects; main.js empties it
        this.closeCalls = [];
        this.aim = null;          // where a charge would land, while the button is held
        this.chargeHeld = false;
        this.over = false;
        this.result = null;
        this.finish = this.mode === "race" ? RACE.length : Infinity;
        this.finished = [];
        this.lastSafe = new Map();
        this.layPickups(260);
    }

    get distance() { return Math.max(0, this.player.x - this.startX); }

    emit(type, data = {}) { this.events.push({ type, t: this.t, ...data }); }

    /** coins, fuel and charges ahead, laid out by seed in 100 m segments */
    layPickups(upTo) {
        const T = this.terrain;
        while (this.coinSeg * 100 < upTo) {
            const k = this.coinSeg++, r = rng(this.seed * 31 + k * 977);
            if (k === 0) continue;
            const n = Math.round(SCORE.coinsPer100m / SCORE.coinValue);
            const start = k * 100 + r() * 50, arc = r() < 0.4;
            for (let i = 0; i < n; i++) this.pickups.push({ kind: "coin", x: start + i * 1.6, off: 1.1 + (arc ? Math.sin((i / (n - 1)) * Math.PI) * 2.2 : 0), taken: false });
        }
        while (this.nextCan < upTo) {
            this.pickups.push({ kind: "fuel", x: this.nextCan, off: 1.2, taken: false });
            this.canGap *= FUEL.growth;
            this.nextCan += this.canGap * (0.9 + this.random() * 0.2);
        }
        while (this.nextCharge < upTo) {
            this.pickups.push({ kind: "charge", x: this.nextCharge, off: 1.3, taken: false });
            this.nextCharge += 520 + this.random() * 160;
        }
        while (this.nextCache < upTo) {
            // high up: reachable only off a ramp, often one made with a charge
            for (let i = 0; i < 10; i++) this.pickups.push({ kind: "coin", x: this.nextCache + i * 1.3, off: 7.5 + Math.sin(i / 3) * 0.4, taken: false, cache: true });
            this.nextCache += 900 + this.random() * 300;
        }
        void T;
    }

    /** a natural change was laid out: greed goes on its far side or over its top */
    onPlan(e) {
        const r = this.random;
        if (e.type === "heave") for (let i = 0; i < 6; i++) this.pickups.push({ kind: "coin", x: e.at + 6 + i * 1.6, off: 3 + Math.sin(i / 5 * Math.PI) * 1.2, taken: false });
        else if (e.type === "crack" || e.type === "slump") for (let i = 0; i < 4; i++) this.pickups.push({ kind: "coin", x: e.at - 2 + i * 1.4, off: 2.4, taken: false });
        else if (e.type === "fault" && r() < 0.5) this.pickups.push({ kind: "coin", x: e.at + 3, off: 1.2, taken: false });
    }

    /**
     * Advance one physics step (1 / PHYS.hz seconds).
     * @param {{ gas?: number, brake?: number, charge?: boolean }} input the player's controls
     */
    step(input = {}) {
        // after the end the wreck keeps tumbling for a couple of seconds, with nothing scored
        const ended = this.over;
        if (ended && this.tick - this.overTick > PHYS.hz * 2.5) return;
        const dt = 1 / PHYS.hz, sub = dt / PHYS.substeps, T = this.terrain;
        const p = this.player;
        // leader for laying out the ground: the front vehicle still running
        let lead = p, tail = p.x;
        for (const v of this.vehicles) { if (v.alive && v.x > lead.x) lead = v; if (v.alive) tail = Math.min(tail, v.x); }
        T.update(this.t, lead.x, Math.max(6, lead.vx), tail, (e) => this.onPlan(e));
        this.layPickups(lead.x + 280);

        p.gas = ended ? 0 : clamp(input.gas || 0, 0, 1);
        p.brake = ended ? 0 : clamp(input.brake || 0, 0, 1);
        if (!ended) this.charge(p, !!input.charge);
        for (const [v, d] of this.drivers) {
            const c = d.drive(this, v);
            v.gas = c.gas; v.brake = c.brake;
            this.charge(v, c.charge);
        }

        for (const v of this.vehicles) {
            if (v.done) continue;
            v.substepTouch = false; v.substepBody = false; v.impact = 0;
            const wasAir = v.air;
            for (let s = 0; s < PHYS.substeps; s++) v.substep(T, this.t + s * sub, sub);
            v.touching = v.substepTouch; v.bodyTouch = v.substepBody;
            this.after(v, dt, wasAir);
        }
        this.t += dt;
        this.tick++;
        if (ended) return;
        this.collect();
        this.closeCallCheck();
        if (this.mode === "race") this.raceCheck();
    }

    /** hold to aim, release to drop a tremor charge */
    charge(v, held) {
        if (!v.alive || v.done) { v.chargeHeld = false; return; }
        const aim = clamp(CHANGES.charge.aim[0] + Math.max(0, v.vx) * 1.1, CHANGES.charge.aim[0], CHANGES.charge.aim[1]);
        if (v === this.player) this.aim = held && v.charges > 0 ? v.x + aim : null;
        if (v.chargeHeld && !held && v.charges > 0) {
            const x = v.x + aim, T = this.terrain;
            const slope = (T.h(x + 2) - T.h(x - 2)) / 4;
            const heave = slope > -0.08;
            const c = CHANGES.charge;
            const e = T.add("charge", x, { charge: true, by: v.name, sign: heave ? 1 : -1, amp: c.amp, width: c.width, skew: heave ? 0.45 : 0, warn: c.warn * (this.assist ? 1.5 : 1) }, this.t);
            v.charges--;
            if (v === this.player) this.tricks.chargesUsed++;
            this.emit("charge", { x, heave, by: v.name, id: e.id, player: v === this.player });
        }
        v.chargeHeld = held;
    }

    /** after a vehicle's step: fuel, air and tricks, how the run ends */
    after(v, dt, wasAir) {
        const T = this.terrain;
        if (v.alive) {
            const burn = FUEL.idle + (FUEL.full - FUEL.idle) * v.gas;
            v.fuel = Math.max(0, v.fuel - burn * dt * (this.mode === "race" ? 0.75 : 1));
            if (v.fuel === 0 && v.isPlayer && !v.empty) this.emit("empty");
        }
        v.load = v.gas;
        const airborne = !v.touching && !v.bodyTouch;
        if (airborne) {
            if (v.air === 0) {
                // just left the ground: was it a change that threw us?
                v.launch = null;
                for (const e of T.events) {
                    if (e.pending || e.sign < 0) continue;
                    if ((e.type === "heave" || e.type === "charge") && v.x > e.x0 - 2 && v.x < e.x1 + 4 && this.t > e.tMove && this.t < e.tEnd + 1.2) { v.launch = e; break; }
                }
                v.airRot = 0;
            }
            v.air += dt;
            v.airRot += v.w * dt;
        } else {
            if (wasAir > 0.25 && v.alive) this.landed(v, wasAir);
            v.air = 0;
        }
        if (v.impact > 4 && v.isPlayer) this.emit("land", { speed: v.impact, x: v.x });
        if (v.alive) {
            v.distance = Math.max(v.distance, v.x);
            const [hx, hy] = v.world(v.head[0], v.head[1]);
            const q = ground(T, hx, hy, v.spec.headR + 0.2, this.t);
            const crack = T.crackAt(v.x);
            if (q.dist < v.spec.headR) this.end(v, "head");
            else if (crack && v.y < T.rim(v.x) - 2.5) this.end(v, "crack");
            else if (T.water().level > v.y + 0.15) { v.soak += dt; if (v.soak > CHANGES.tide.stall) this.end(v, "water"); }
            else v.soak = Math.max(0, v.soak - dt);
            if (v.alive && Math.cos(v.a) < -0.2 && v.speed < 0.8 && (v.bodyTouch || v.touching)) { v.stuck += dt; if (v.stuck > 2) this.end(v, "stuck"); } else v.stuck = 0;
            if (v.alive && v.fuel <= 0) { v.empty += dt; if (v.speed < 0.4 && v.empty > 1.5) this.end(v, "fuel"); }
            // a safe spot to come back to in a race: upright, on the ground, not in a change
            if (v.alive && v.touching && Math.cos(v.a) > 0.8 && !T.crackAt(v.x + 4) && this.tick % 30 === 0) this.lastSafe.set(v, { x: v.x - 3, t: this.t });
        } else if (!v.done && this.mode === "race") {
            v.down = (v.down || 0) + dt;
            if (v.down > 2) this.respawn(v);
        }
    }

    landed(v, air) {
        if (!v.isPlayer) return;
        const upright = Math.cos(v.a) > 0.25;
        if (!upright) return;
        const k = v.spec.trick;
        let coins = 0;
        const flips = Math.floor((Math.abs(v.airRot) + 0.7) / TAU);
        if (flips > 0) { coins += SCORE.flip * flips; this.tricks.flips += flips; this.emit("trick", { what: flips > 1 ? `${flips}× flip` : "Flip", flips, coins: Math.round(SCORE.flip * flips * k) }); }
        if (air > SCORE.airFree) {
            const c = Math.floor((air - SCORE.airFree) * 10) * SCORE.airPerTenth;
            coins += c;
            this.emit("trick", { what: `Air ${air.toFixed(1)} s`, air, coins: Math.round(c * k) });
        }
        this.tricks.bestAir = Math.max(this.tricks.bestAir, air);
        if (v.launch && air > 0.7) {
            coins += SCORE.rideChange;
            this.tricks.rides++;
            if (v.launch.type === "charge" && v.launch.by === v.name) this.tricks.rampJumps++;
            this.emit("trick", { what: v.launch.type === "charge" ? "Own ramp" : "Rode the heave", coins: Math.round(SCORE.rideChange * k), ride: true });
        }
        coins = Math.round(coins * k);
        this.coins += coins;
        this.coinsFromTricks += coins;
        v.launch = null;
    }

    end(v, why) {
        v.alive = false;
        v.end = why;
        this.emit("crash", { why, x: v.x, y: v.y, name: v.name, player: v.isPlayer });
        if (v.isPlayer && this.mode !== "race") this.finishRun(why);
        if (v.isPlayer && this.mode === "race") v.down = 0;
    }

    respawn(v) {
        const T = this.terrain, safe = this.lastSafe.get(v) || { x: Math.max(0, v.x - 15) };
        let x = safe.x;
        while (T.crackAt(x)) x -= 2;
        const fresh = new Vehicle(v.spec, {}, x, T.h(x));
        for (const k of ["torque", "spinMax", "grip", "travel", "damper", "tank"]) fresh[k] = v[k];
        Object.assign(v, { x: fresh.x, y: fresh.y, a: 0, vx: 0, vy: 0, w: 0, wheels: fresh.wheels, alive: true, end: null, down: 0, stuck: 0, soak: 0, air: 0, fuel: Math.max(v.fuel, v.tank * 0.35), empty: 0 });
        this.emit("respawn", { name: v.name, player: v.isPlayer });
    }

    collect() {
        const p = this.player;
        if (!p.alive) return;
        const T = this.terrain, pts = [[p.x, p.y], ...p.wheels.map((w) => [w.x, w.y])];
        for (const k of this.pickups) {
            if (k.taken || k.x < p.x - 4 || k.x > p.x + 4) continue;
            const ky = T.h(k.x) + k.off;
            for (const [x, y] of pts) {
                if ((x - k.x) ** 2 + (y - ky) ** 2 < 1.3 * 1.3) {
                    k.taken = true;
                    if (k.kind === "coin") { this.coins += SCORE.coinValue; if (k.cache && !this.cacheFound) { this.cacheFound = true; this.tricks.caches++; this.emit("cache"); } }
                    else if (k.kind === "fuel") p.fuel = p.tank;
                    else if (k.kind === "charge") p.charges = Math.min(3, p.charges + 1);
                    this.emit("pickup", { kind: k.kind, x: k.x, y: ky });
                    break;
                }
            }
        }
        if (this.tick % 120 === 0) { this.pickups = this.pickups.filter((k) => !k.taken && k.x > p.x - 60); this.cacheFound = false; }
    }

    /** a change started or stopped moving with the player inside it: a close call if they live through it */
    closeCallCheck() {
        const p = this.player, T = this.terrain;
        for (const e of T.moved) {
            if (e.charge && e.by === p.name) continue;
            if (p.alive && p.x > e.x0 - 2 && p.x < e.x1 + 2 && !this.closeCalls.some((c) => c.id === e.id)) this.closeCalls.push({ id: e.id, t: this.t });
        }
        for (const c of this.closeCalls) {
            if (c.paid || this.t - c.t < 1.5) continue;
            c.paid = true;
            if (!p.alive) continue;
            const coins = Math.round(SCORE.closeCall * p.spec.trick);
            this.coins += coins; this.coinsFromTricks += coins; this.tricks.closeCalls++;
            this.emit("trick", { what: "Close call", coins });
        }
        if (this.closeCalls.length > 20) this.closeCalls = this.closeCalls.filter((c) => !c.paid);
    }

    raceCheck() {
        for (const v of this.vehicles) {
            if (!v.done && v.x >= this.finish) {
                v.done = true; v.time = this.t;
                this.finished.push(v);
                this.emit("finish", { name: v.name, place: this.finished.length, player: v.isPlayer });
                if (v.isPlayer) this.finishRun("finish");
            }
        }
    }

    /** places in a race: finished first, then by distance */
    standings() {
        const rest = this.vehicles.filter((v) => !v.done).sort((a, b) => b.x - a.x);
        return [...this.finished, ...rest];
    }

    finishRun(why) {
        if (this.over) return;
        this.over = true;
        this.overTick = this.tick;
        const place = this.mode === "race" ? this.standings().indexOf(this.player) + 1 : 0;
        const prize = this.mode === "race" && why === "finish" ? RACE.reward[place - 1] : 0;
        this.coins += prize;
        this.result = { why, distance: Math.round(this.distance), coins: this.coins, prize, place, time: this.t, tricks: { ...this.tricks } };
        this.emit("over", this.result);
    }

    /** what a warning looks like right now, for drawing and the AI */
    warnings() {
        const out = [];
        for (const e of this.terrain.events) {
            if (e.pending) continue;
            if (e.state === WARN || e.state === MOVE) out.push(e);
        }
        return out;
    }

    /** A cheap hash of the whole state, for the replay test. */
    hash() {
        let h = 2166136261;
        const mix = (v) => { const b = Math.round(v * 1e6) | 0; h = Math.imul(h ^ b, 16777619); };
        for (const v of this.vehicles) { mix(v.x); mix(v.y); mix(v.a); mix(v.vx); mix(v.vy); mix(v.w); for (const w of v.wheels) { mix(w.x); mix(w.y); mix(w.spin); } mix(v.fuel); }
        mix(this.coins); mix(this.terrain.events.length);
        return h >>> 0;
    }
}
