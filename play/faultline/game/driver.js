import { rng, WARN, MOVE } from "./terrain.js";

/**
 * FAULTLINE: a driver that plays by the player's rules. It sees a ground change only once the warning has
 * been up for its reaction time, and drives with gas and brake through the same physics. Used for the
 * rivals in Race mode and as the test bot in the Node tools.
 *
 * On the ground it holds a target speed: lower before a slump or a down-step, higher for a heave or an
 * up-step, a stop before an open crack or deep water. In the air it rotates to match the slope it will land
 * on. Difficulty changes reaction time and how well it judges speed, never grip or power.
 * @module game/driver
 */

const STYLE = {
    careful: { cruise: 10, jump: 0, charge: 0.6 },
    reckless: { cruise: 15, jump: 4.5, charge: 0.8 },
    sneaky: { cruise: 12, jump: 3.5, charge: 2 },
    bot: { cruise: 12, jump: 0, charge: 0 },
};

const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Driver {
    /**
     * @param {{ style?: string, react?: number, accuracy?: number, charge?: number }} skill
     * @param {number} seed
     */
    constructor(skill = {}, seed = 1) {
        this.style = STYLE[skill.style || "bot"];
        this.react = skill.react ?? 0.3;
        this.accuracy = skill.accuracy ?? 0.9;
        this.chargeRate = (skill.charge ?? 0) * this.style.charge;
        this.random = rng(seed);
        this.error = 0;
        this.nextThink = 0;
        this.holding = 0;
        this.cool = 6;
        this.waiting = false;
    }

    /** this step's controls for vehicle `v` in run `run` */
    drive(run, v) {
        const out = { gas: 0, brake: 0, charge: false };
        if (!v.alive || v.done) return out;
        const T = run.terrain, t = run.t;
        const slopeAt = (x) => Math.atan2(T.h(x + 1) - T.h(x - 1), 2);

        // judging speed is imperfect: a slow drift around the right answer
        if (t >= this.nextThink) {
            this.nextThink = t + 0.5;
            this.error = (this.random() * 2 - 1) * (1 - this.accuracy) * 0.45;
        }

        if (v.air > 0.05) {
            // in the air: match the ground we'll land on
            const land = v.x + Math.max(0, v.vx) * 0.45;
            const err = wrap(slopeAt(land) - (v.a + v.w * 0.28));
            if (err > 0.07) out.gas = 1;
            else if (err < -0.07) out.brake = 1;
            return out;
        }

        let target = this.style.cruise * (1 + this.error);
        // steep ground ahead: slow for drops, keep speed for climbs. Applied after the ground changes too, so
        // speeding up for a heave never sends it over a crest into a steep drop.
        let dropCap = Infinity, jumping = false;
        for (let d = 4; d < 26; d += 3) {
            const s = (T.h(v.x + d + 1.5) - T.h(v.x + d - 1.5)) / 3;
            if (s < -0.55) dropCap = Math.min(dropCap, 7.5);
            else if (s < -0.35) dropCap = Math.min(dropCap, 10);
        }
        target = Math.min(target, dropCap);

        let stopAt = Infinity, reverse = false;
        for (const e of T.events) {
            if (e.pending || (e.state !== WARN && e.state !== MOVE)) continue;
            if (t - e.tWarn < this.react) continue;            // not noticed yet
            if (e.x1 < v.x - 1 || e.x0 > v.x + 75) continue;
            if (e.type === "crack") {
                if (v.x > e.x0 - 1) continue;                      // committed
                const jumpable = e.width <= this.style.jump && v.vx > 11;
                if (jumpable) { target = Math.max(target, 17); jumping = true; }
                else stopAt = Math.min(stopAt, e.x0 - 6);
            } else if (e.type === "fault") {
                if (e.sign > 0) target = Math.max(target, 11.5); else target = Math.min(target, 8.5);
            } else if (e.sign < 0) target = Math.min(target, 8);
            else if (e.state === MOVE || t > e.tMove - 1) target = Math.max(target, 12);
        }
        if (!jumping) target = Math.min(target, dropCap);
        // deep water ahead: wait it out
        const tide = T.biome.tide;
        if (tide) {
            // look at the water as it will be when we get there (mud is slow: 5 m/s), and wait on dry
            // ground: the last spot before the flood that even the high tide leaves shallow
            const safe = (x) => tide.high - T.h(x) < 0.5;
            if (safe(v.x)) {
                // arrival could be at cruise speed or at a crawl: take the deepest water over that window, and
                // once waiting, only set off when it will be clearly shallow, so the go/stop call doesn't flip
                // halfway down the bank
                const limit = this.waiting ? 0.5 : 0.75;
                let dry = v.x, wait = false;
                for (let d = 1; d < 160; d++) {
                    const x = v.x + d;
                    if (safe(x)) { dry = x; continue; }
                    const level = Math.max(T.water(t + d / 10 + 1).level, T.water(t + d / 7 + 1.5).level, T.water(t + d / 4 + 2).level);
                    if (level - T.h(x) > limit) { stopAt = Math.min(stopAt, this.restAt(T, v.x, dry - 4)); wait = true; break; }
                }
                this.waiting = wait;
            } else if (T.water().level - T.h(v.x) > 0.15) {
                // caught on the flats: out ahead if the water allows, otherwise back up the bank
                let ahead = 0, deepest = -Infinity;
                for (let d = 1; d < 120 && !ahead; d++) { if (safe(v.x + d)) ahead = d; else deepest = Math.max(deepest, -T.h(v.x + d)); }
                const worst = Math.max(T.water().level, T.water(t + ahead / 8).level, T.water(t + ahead / 4).level);
                const ok = ahead && worst + deepest < 0.95;
                if (!ok) reverse = true;
            }
        }
        if (reverse) {
            if (v.vx > -4) out.brake = 1;
            return out;
        }
        if (stopAt < Infinity) {
            const room = stopAt - v.x, ice = T.surface(v.x) === "ice";
            target = Math.min(target, room <= 0 ? 0 : Math.sqrt(2 * (ice ? 2.5 : 4) * room));
        }

        const speed = v.vx;
        if (target < 0.5) { if (speed > 0.15) out.brake = speed > 1 ? 1 : 0.5; else if (speed < -0.15) out.gas = 0.4; }
        else {
            if (speed < target - 0.5) out.gas = 1;
            else if (speed < target + 1) out.gas = 0.35;
            if (speed > target + 2.5) out.brake = 1;
        }

        // don't loop over backwards on a climb, don't nose-dive
        const pitch = wrap(v.a - slopeAt(v.x));
        if (pitch > 0.5) { out.gas = 0; if (pitch > 0.75) out.brake = 1; }
        else if (pitch < -0.45 && out.brake) { out.brake = 0; out.gas = 0.6; }

        // tremor charges: drop one under whoever is just ahead
        this.cool -= 1 / 120;
        if (this.holding > 0) { this.holding--; out.charge = this.holding > 0; return out; }
        if (v.charges > 0 && this.cool <= 0 && this.chargeRate > 0) {
            this.cool = 2;
            const ahead = run.vehicles.find((o) => o !== v && o.alive && o.x - v.x > 22 && o.x - v.x < 38);
            if (ahead && this.random() < this.chargeRate * 0.25) { this.holding = 3; out.charge = true; this.cool = 12; }
        }
        return out;
    }

    /**
     * where to wait near `x`: back from there to the nearest spot with no steep drop just ahead, so the wait
     * doesn't start halfway down a slope that ends at a fault step. Never behind `from`.
     */
    restAt(T, from, x) {
        const steep = (p) => {
            for (let d = -1; d <= 6; d++) if (T.h(p + d + 1) - T.h(p + d - 1) < -0.6) return true;
            return false;
        };
        let p = x;
        while (p > from && steep(p)) p -= 1;
        return p;
    }
}
