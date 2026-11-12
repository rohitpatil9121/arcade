import { Audio } from "../engine/index.js";

/**
 * FAULTLINE: sound (the `audio-design` skill). Everything is made in code: nothing to load.
 *
 *   one-shots (ZzFX) ─► sfx ─┐
 *   engine, rumble, wind, skid ─► sfx
 *   music layers ─► music ─► duck ─► limiter ─► master ─► speakers
 *
 * The ENGINE is two detuned oscillators through a low-pass filter. Pitch follows the driven wheel's speed
 * and the filter opens with throttle, so you hear the load. The RUMBLE is low noise whose level is the
 * nearest warning, rising as a change gets closer to moving: you can hear a change before you see it.
 *
 * MUSIC is vertical layering at 100 beats a minute on the biome's own root: bass and a plucked arpeggio
 * always, drums while the ground is warning, a high line in the air. Crashes and big moves duck it.
 * @module game/sound
 */

// ZzFX parameters: volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide,
// pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay
const SOUNDS = {
    coin: [0.32, 0, 1250, 0, 0.02, 0.12, 1, 1.6, 0, 0, 600, 0.04, 0, 0, 0, 0, 0, 0.6, 0.02],
    fuel: [0.55, 0, 380, 0.01, 0.12, 0.2, 0, 1.4, 6, 0, 190, 0.08, 0, 0, 0, 0, 0, 0.7, 0.05],
    pickcharge: [0.5, 0, 300, 0.02, 0.1, 0.3, 2, 1.2, 0, 0, 450, 0.06, 0.07, 0, 4, 0, 0, 0.6, 0.06],
    drop: [0.7, 0.05, 160, 0.01, 0.12, 0.4, 3, 0.8, -4, 0, 0, 0, 0, 1.2, 8, 0, 0, 0.6, 0.1],
    boom: [1, 0.1, 55, 0.01, 0.2, 0.9, 4, 0.5, -0.5, 0, 0, 0, 0, 2.5, 0, 0.3, 0.06, 0.6, 0.3],
    crack: [0.8, 0.2, 400, 0, 0.04, 0.5, 4, 1, -6, 0, 0, 0, 0.04, 3, 0, 0.3, 0, 0.5, 0.1],
    land: [0.5, 0.15, 80, 0, 0.02, 0.15, 4, 1, -2, 0, 0, 0, 0, 1.6, 0, 0, 0, 0.5, 0.05],
    clunk: [0.35, 0.1, 200, 0, 0.01, 0.06, 1, 2, 0, 0, 0, 0, 0, 0.6, 0, 0.3, 0, 0.5, 0.02],
    crash: [1, 0.1, 120, 0, 0.08, 0.6, 4, 1.2, -4, 0, 0, 0, 0, 2.2, 0, 0.4, 0.05, 0.5, 0.2],
    splash: [0.8, 0.3, 300, 0.01, 0.08, 0.5, 4, 0.5, -4, 0, 0, 0, 0, 3, 0, 0, 0.05, 0.5, 0.15],
    trick: [0.45, 0, 660, 0, 0.06, 0.18, 0, 1.4, 0, 0, 330, 0.05, 0, 0, 0, 0, 0.04, 0.7, 0.05],
    flip: [0.55, 0, 520, 0, 0.08, 0.25, 0, 1.6, 0, 0, 260, 0.06, 0.06, 0, 0, 0, 0.05, 0.7, 0.06],
    alarm: [0.3, 0, 880, 0, 0.06, 0.06, 1, 1, 0, 0, 0, 0, 0.12, 0, 0, 0, 0, 0.8, 0.02],
    steam: [0.35, 0.2, 900, 0.05, 0.3, 0.4, 4, 0.4, 0, 0, 0, 0, 0, 6, 0, 0, 0, 0.4, 0.2],
    finish: [0.9, 0, 523, 0.02, 0.3, 0.7, 0, 1.5, 0, 0, 262, 0.1, 0.1, 0, 0, 0, 0.12, 0.7, 0.2],
    lose: [0.6, 0, 300, 0.04, 0.25, 0.7, 0, 1, -5, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.5, 0.25],
    ui: [0.3, 0, 740, 0.003, 0.01, 0.06, 0, 1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02],
    buy: [0.5, 0, 600, 0, 0.05, 0.3, 0, 1.5, 0, 0, 300, 0.05, 0.05, 0, 0, 0, 0.05, 0.7, 0.08],
    nope: [0.4, 0, 200, 0, 0.05, 0.12, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.5, 0.05],
};

const dB = (v) => Math.pow(10, v / 20);
/** a 0..1 slider onto gain: -24 dB at the bottom of its travel, silence at 0, unchanged at 1 */
const slider = (v) => (v <= 0 ? 0 : dB((v - 1) * 24));
/** each biome's key (Hz of the root) and scale */
const KEYS = {
    mesa: { root: 110, scale: [0, 3, 5, 7, 10, 12, 15, 17] },      // A minor pentatonic, dusty
    glacier: { root: 130.81, scale: [0, 2, 4, 7, 9, 12, 14, 16] },  // C major pentatonic, bright
    ash: { root: 98, scale: [0, 1, 5, 7, 8, 12, 13, 17] },          // G phrygian-ish, hot
    delta: { root: 116.54, scale: [0, 2, 5, 7, 9, 12, 14, 17] },    // B♭, easy
};
const BPM = 100, STEP = 60 / BPM / 4;

export class Sound {
    constructor(settings = {}) {
        this.audio = new Audio({ volume: 1, sfx: 1, music: 1 });
        for (const [k, v] of Object.entries(SOUNDS)) this.audio.define(k, v);
        this.settings = { music: settings.music ?? 0.6, sfx: settings.sfx ?? 0.9, muted: !!settings.muted };
        this.started = false;
        this.step = 0;
        this.nextAt = 0;
        this.key = KEYS.mesa;
        this.state = { warn: 0, air: 0, playing: false };
        this.last = new Map();
    }

    /** Call from a user gesture. Safe to call again. */
    async unlock() {
        if (this.started) return;
        this.started = true;
        await this.audio.unlock();
        const a = this.audio, ctx = a.ctx;
        if (!ctx) return;
        this.duck = ctx.createGain();
        const limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -6; limiter.ratio.value = 12; limiter.attack.value = 0.003; limiter.release.value = 0.2;
        a.channels.sfx.disconnect(); a.channels.music.disconnect();
        a.channels.sfx.connect(limiter);
        a.channels.music.connect(this.duck);
        this.duck.connect(limiter);
        limiter.connect(a.master);
        this.apply();
        this.layers = {};
        for (const name of ["bass", "pluck", "drums", "lead"]) { const g = ctx.createGain(); g.gain.value = 0; g.connect(a.channels.music); this.layers[name] = g; }
        this.loops();
        this.nextAt = ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), 50);
    }

    apply() {
        const a = this.audio;
        if (!a.ctx) return;
        const t = a.ctx.currentTime, s = this.settings;
        a.master.gain.setTargetAtTime(s.muted ? 0 : dB(3), t, 0.02);
        a.channels.sfx.gain.setTargetAtTime(slider(s.sfx), t, 0.02);
        a.channels.music.gain.setTargetAtTime(slider(s.music) * dB(1), t, 0.02);
    }
    set(key, value) { this.settings[key] = value; this.apply(); }
    setBiome(id) { this.key = KEYS[id] || KEYS.mesa; }

    /** the continuous sounds: engine, rumble, wind, skid */
    loops() {
        const ctx = this.audio.ctx, out = this.audio.channels.sfx;
        const n = ctx.sampleRate * 2, buffer = ctx.createBuffer(1, n, ctx.sampleRate), d = buffer.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        const noise = (type, freq, q) => {
            const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
            const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = q;
            const g = ctx.createGain(); g.gain.value = 0;
            src.connect(f).connect(g).connect(out); src.start();
            return { f, g };
        };
        this.rumble = noise("lowpass", 90, 1);
        this.wind = noise("bandpass", 700, 0.6);
        this.skid = noise("bandpass", 1900, 3);
        const eg = ctx.createGain(); eg.gain.value = 0;
        const ef = ctx.createBiquadFilter(); ef.type = "lowpass"; ef.frequency.value = 400; ef.Q.value = 4;
        const o1 = ctx.createOscillator(), o2 = ctx.createOscillator();
        o1.type = "sawtooth"; o2.type = "square"; o1.frequency.value = 50; o2.frequency.value = 25; o2.detune.value = 8;
        const g2 = ctx.createGain(); g2.gain.value = 0.5;
        o1.connect(ef); o2.connect(g2).connect(ef);
        ef.connect(eg).connect(out);
        o1.start(); o2.start();
        this.engine = { o1, o2, ef, eg };
    }

    /**
     * Every frame while a run is shown.
     * @param {{ rpm: number, gas: number, speed: number, air: number, slip: number, warn: number, alive: boolean, playing: boolean, water: boolean }} s
     */
    update(s) {
        this.state = s;
        if (!this.engine) return;
        const t = this.audio.ctx.currentTime, e = this.engine;
        const f = 38 + s.rpm * 3.2;
        e.o1.frequency.setTargetAtTime(f, t, 0.05);
        e.o2.frequency.setTargetAtTime(f * 0.5, t, 0.05);
        e.ef.frequency.setTargetAtTime(250 + s.gas * 1300 + s.rpm * 8, t, 0.06);
        e.eg.gain.setTargetAtTime(s.playing && s.alive ? 0.05 + s.gas * 0.07 : 0, t, 0.08);
        this.rumble.g.gain.setTargetAtTime(s.playing ? s.warn * 0.55 : 0, t, 0.1);
        this.rumble.f.frequency.setTargetAtTime(70 + s.warn * 80, t, 0.1);
        this.wind.g.gain.setTargetAtTime(s.playing ? Math.min(0.12, s.speed * 0.004 + s.air * 0.05) : 0, t, 0.2);
        this.skid.g.gain.setTargetAtTime(s.playing ? Math.min(0.08, Math.max(0, s.slip - 3) * 0.012) : 0, t, 0.05);
        if (this.layers) {
            const want = { bass: 0.55, pluck: 0.38, drums: s.playing ? 0.15 + s.warn * 0.6 : 0, lead: s.playing && s.air > 0.4 ? 0.3 : 0 };
            for (const k in want) this.layers[k].gain.setTargetAtTime(want[k], t, k === "lead" ? 0.15 : 0.6);
        }
    }

    /** One effect, a little different every time. Repeats closer than `gap` are dropped. */
    play(name, { volume = 1, pitch = 1, pan = 0, spread = 0.06, gap = 0.04 } = {}) {
        const a = this.audio;
        if (!a.ready) return;
        const now = a.ctx.currentTime;
        if (now - (this.last.get(name) ?? -1) < gap) return;
        this.last.set(name, now);
        a.play(name, { volume, pan, pitch: pitch * (1 + (Math.random() - 0.5) * 2 * spread) });
    }

    /** Pull the music down for a moment; it comes back slowly. */
    dip(amount = -8, hold = 0.3) {
        if (!this.duck) return;
        const t = this.audio.ctx.currentTime, g = this.duck.gain;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(dB(amount), t, 0.02);
        g.setTargetAtTime(1, t + hold, 0.5);
    }

    note(dest, t, f, len, type, peak) {
        const ctx = this.audio.ctx, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(dest); o.start(t); o.stop(t + len + 0.02);
    }
    hat(dest, t, peak, freq = 7000) {
        const ctx = this.audio.ctx;
        if (!this.noiseBuf) { const n = ctx.sampleRate * 0.1 | 0; this.noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate); const d = this.noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }
        const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noiseBuf; hp.type = "highpass"; hp.frequency.value = freq;
        g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
        s.connect(hp).connect(g).connect(dest); s.start(t); s.stop(t + 0.08);
    }

    /** Lay down the next notes, a little ahead of the clock. */
    schedule() {
        const ctx = this.audio.ctx;
        if (this.nextAt < ctx.currentTime - 1) this.nextAt = ctx.currentTime + 0.05;
        const { root, scale } = this.key;
        const hz = (deg, oct = 0) => root * Math.pow(2, (scale[((deg % scale.length) + scale.length) % scale.length] + 12 * (oct + Math.floor(deg / scale.length))) / 12);
        const PROG = [0, 0, 3, 4];
        while (this.nextAt < ctx.currentTime + 0.15) {
            const t = this.nextAt, s = this.step, beat = s % 16, bar = Math.floor(s / 16) % 4, chord = PROG[bar], L = this.layers;
            if (beat === 0 || beat === 10) this.note(L.bass, t, hz(chord, -1), 0.35, "triangle", 0.5);
            if (beat === 6 || beat === 14) this.note(L.bass, t, hz(chord + 2, -1), 0.18, "triangle", 0.3);
            const fig = [0, 2, 4, 2, 5, 4, 2, 1][(s >> 1) % 8];
            if (s % 2 === 0 && (s * 5 + bar) % 7 !== 0) this.note(L.pluck, t, hz(chord + fig, 1), 0.22, "triangle", 0.22);
            if (beat % 8 === 0) {
                const o = ctx.createOscillator(), g = ctx.createGain();
                o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.14);
                g.gain.setValueAtTime(0.8, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
                o.connect(g).connect(L.drums); o.start(t); o.stop(t + 0.2);
            }
            if (beat === 4 || beat === 12) this.hat(L.drums, t, 0.45, 2500);
            if (s % 2 === 1) this.hat(L.drums, t, 0.12);
            if ([0, 3, 6, 8, 11].includes(beat) && bar % 2 === 1) this.note(L.lead, t, hz(chord + [7, 6, 4, 5, 7][[0, 3, 6, 8, 11].indexOf(beat)], 1), 0.2, "square", 0.08);
            this.step++;
            this.nextAt += STEP;
        }
    }
}
