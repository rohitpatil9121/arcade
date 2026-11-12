import { Audio } from "../engine/index.js";

/**
 * HEXHAUL: sound (the `audio-design` skill), after TIDEFALL's. Everything is made in code: nothing to load.
 *
 *   effects, voices ─► sfx ───┐
 *   sea ─► ambience ──────────┤
 *   music layers ─► music ─► duck ─► limiter ─► master ─► speakers
 *
 * Volumes are in decibels and converted at the edge; the sliders map 0..1 onto them. Stingers and big
 * hits pull the music down for a moment and let it back up slowly, so it dips rather than pumps.
 *
 * VOICES: each robot has a pitch from its id, and speaks in clanky blips: a square wave ring-modulated by a
 * second one, a few notes long. Hit, out, emote and win each have their own contour.
 *
 * MUSIC is vertical layering at 132 beats a minute in a major pentatonic: bass and a marimba always, then
 * drums, then a higher line and a pulsing tension note as the island goes. update() takes an intensity
 * 0..1 (how much of the island has gone, whether a storm is on, whether you're in the water), and each
 * layer's gain glides to what that asks for. Notes run on a lookahead clock, so frames don't jitter them.
 * @module game/sound
 */

// ZzFX parameters: volume, randomness, frequency, attack, sustain, release, shape, shapeCurve, slide, deltaSlide,
// pitchJump, pitchJumpTime, repeatTime, noise, modulation, bitCrush, delay, sustainVolume, decay
const SOUNDS = {
    jump: [0.28, 0.05, 240, 0, 0.02, 0.08, 1, 1, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02],
    land: [0.35, 0.2, 95, 0, 0.02, 0.08, 4, 1, -2, 0, 0, 0, 0, 1.5, 0, 0, 0, 0.5, 0.03],
    grab: [0.55, 0.1, 130, 0, 0.03, 0.12, 2, 1, 3, 0, 0, 0, 0, 0.6, 0, 0, 0, 0.6, 0.05],
    thunk: [0.8, 0.1, 110, 0, 0.03, 0.14, 4, 1, -3, 0, 0, 0, 0, 1, 0, 0, 0, 0.6, 0.05],
    charge: [0.14, 0, 300, 0.02, 0.05, 0.05, 2, 1, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.01],
    whiff: [0.28, 0.2, 480, 0.01, 0.03, 0.09, 4, 1, -9, 0, 0, 0, 0, 3, 0, 0, 0, 0.4, 0.03],
    hit: [0.95, 0.08, 150, 0, 0.03, 0.15, 4, 1.2, -6, 0, 0, 0, 0, 1.6, 0, 0.2, 0, 0.6, 0.05],
    clank: [0.5, 0.05, 1100, 0, 0.01, 0.14, 1, 2, 0, 0, 0, 0, 0, 0.4, 0, 0.3, 0, 0.6, 0.03],
    throw: [0.4, 0.15, 320, 0.01, 0.05, 0.14, 4, 1, 5, 0, 0, 0, 0, 2.5, 0, 0, 0, 0.4, 0.04],
    splash: [0.7, 0.3, 300, 0.01, 0.06, 0.4, 4, 0.5, -4, 0, 0, 0, 0, 3, 0, 0, 0.05, 0.5, 0.1],
    plop: [0.3, 0.2, 500, 0, 0.02, 0.12, 0, 1, -14, 0, 0, 0, 0, 1, 0, 0, 0, 0.5, 0.03],
    climb: [0.3, 0.1, 300, 0, 0.03, 0.1, 0, 1.2, 4, 0, 200, 0.05, 0, 0, 0, 0, 0, 0.6, 0.03],
    crack: [0.3, 0.3, 700, 0, 0.01, 0.05, 4, 1, -10, 0, 0, 0, 0.03, 3, 0, 0.2, 0, 0.5, 0.01],
    sink: [0.42, 0.2, 130, 0.02, 0.18, 0.5, 0, 1, -1.5, 0, 0, 0, 0.06, 1, 0, 0, 0, 0.5, 0.15],
    bomb: [1, 0.1, 70, 0, 0.1, 0.7, 4, 0.6, -1, 0, 0, 0, 0, 2.5, 0, 0.3, 0.05, 0.6, 0.2],
    fuse: [0.12, 0.1, 1500, 0, 0.01, 0.02, 3, 1, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0.5, 0.01],
    bounce: [0.5, 0.03, 180, 0, 0.05, 0.2, 0, 1, 12, 0, 0, 0, 0, 0, 8, 0, 0, 0.6, 0.05],
    haul: [0.6, 0, 660, 0, 0.05, 0.2, 0, 1.4, 0, 0, 330, 0.05, 0, 0, 0, 0, 0.05, 0.7, 0.06],
    out: [0.6, 0.05, 420, 0.01, 0.15, 0.45, 2, 1, -7, 0, 0, 0, 0, 0.3, 0, 0, 0, 0.5, 0.2],
    buoy: [0.4, 0.05, 240, 0, 0.05, 0.14, 0, 1, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.03],
    warn: [0.7, 0, 520, 0.02, 0.18, 0.25, 2, 1, 0, 0, -130, 0.14, 0.28, 0, 0, 0, 0, 0.7, 0.05],
    wave: [0.8, 0.2, 200, 0.2, 0.3, 0.9, 4, 0.5, -1, 0, 0, 0, 0, 4, 0, 0, 0, 0.5, 0.4],
    wind: [0.5, 0.2, 400, 0.3, 0.5, 0.9, 4, 0.3, 0.5, 0, 0, 0, 0, 5, 3, 0, 0, 0.4, 0.4],
    go: [0.7, 0, 880, 0, 0.08, 0.2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.8, 0.04],
    ready: [0.45, 0, 440, 0, 0.05, 0.1, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.7, 0.03],
    win: [0.9, 0, 523, 0.02, 0.3, 0.7, 0, 1.5, 0, 0, 262, 0.1, 0.1, 0, 0, 0, 0.12, 0.7, 0.2],
    lose: [0.6, 0, 300, 0.04, 0.25, 0.7, 0, 1, -5, 0, 0, 0, 0, 0, 0, 0, 0.1, 0.5, 0.25],
    ui: [0.3, 0, 740, 0.003, 0.01, 0.06, 0, 1.2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0.6, 0.02],
};

const dB = (v) => Math.pow(10, v / 20);
/** a 0..1 slider onto gain: -24 dB at the bottom of its travel, silence at 0, unchanged at 1 */
const slider = (v) => (v <= 0 ? 0 : dB((v - 1) * 24));

// major pentatonic in C, as semitones from C3
const SCALE = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
const hz = (semi) => 130.81 * Math.pow(2, semi / 12);
const CHORDS = [0, 0, -3, -5];                  // I I vi V, by root offset, a bar each
const BPM = 132, STEP = 60 / BPM / 4;           // sixteenths

export class Sound {
    constructor(settings = {}) {
        this.audio = new Audio({ volume: 1, sfx: 1, music: 1 });
        for (const [k, v] of Object.entries(SOUNDS)) this.audio.define(k, v);
        this.settings = { music: settings.music ?? 0.7, sfx: settings.sfx ?? 0.9, muted: !!settings.muted };
        this.started = false;
        this.intensity = 0;
        this.playing = false;
        this.step = 0;
        this.nextAt = 0;
        this.listener = { x: 0, y: 0, reach: 30 };
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
        this.musicBus = ctx.createGain();
        a.channels.sfx.connect(limiter);
        a.channels.music.connect(this.duck);
        this.musicBus.connect(a.channels.music);
        this.duck.connect(limiter);
        limiter.connect(a.master);
        this.apply();
        this.layers = {};
        for (const [name, level] of [["bass", 0], ["marimba", 0], ["drums", 0], ["lead", 0], ["tension", 0]]) {
            const g = ctx.createGain(); g.gain.value = level; g.connect(this.musicBus); this.layers[name] = g;
        }
        this.sea();
        this.nextAt = ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), 50);
    }

    apply() {
        const a = this.audio;
        if (!a.ctx) return;
        const t = a.ctx.currentTime, s = this.settings;
        a.master.gain.setTargetAtTime(s.muted ? 0 : dB(4), t, 0.02);
        a.channels.sfx.gain.setTargetAtTime(slider(s.sfx), t, 0.02);
        a.channels.music.gain.setTargetAtTime(slider(s.music) * dB(3), t, 0.02);
    }
    set(key, value) { this.settings[key] = value; this.apply(); }

    /** Waves on the shore: filtered noise breathing on a slow swell. */
    sea() {
        const ctx = this.audio.ctx, n = ctx.sampleRate * 2, buffer = ctx.createBuffer(1, n, ctx.sampleRate), d = buffer.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource(); src.buffer = buffer; src.loop = true;
        const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 650;
        const g = ctx.createGain(); g.gain.value = 0.035;
        const swell = ctx.createOscillator(), depth = ctx.createGain(); swell.frequency.value = 0.13; depth.gain.value = 0.02;
        swell.connect(depth).connect(g.gain);
        src.connect(lp).connect(g).connect(this.audio.channels.sfx);
        src.start(); swell.start();
    }

    /** where the sound is, as heard from the camera */
    at(x, y) {
        const l = this.listener;
        if (x === undefined) return { volume: 1, pan: 0 };
        const d = Math.hypot(x - l.x, y - l.y);
        return { volume: Math.max(0.35, 1 - d / l.reach), pan: Math.max(-0.7, Math.min(0.7, (x - l.x) / 14)) };
    }

    /** One effect, a little different every time. Repeats of the same sound closer than `gap` are dropped. */
    play(name, x, y, { volume = 1, pitch = 1, spread = 0.07, gap = 0.04 } = {}) {
        const a = this.audio;
        if (!a.ready) return;
        const now = a.ctx.currentTime;
        if (now - (this.last.get(name) ?? -1) < gap) return;
        this.last.set(name, now);
        const place = this.at(x, y);
        a.play(name, { volume: volume * place.volume, pan: place.pan, pitch: pitch * (1 + (Math.random() - 0.5) * 2 * spread) });
    }

    /** Pull the music down for a moment; it comes back slowly. */
    dip(amount = -7, hold = 0.2) {
        if (!this.duck) return;
        const t = this.audio.ctx.currentTime, g = this.duck.gain;
        g.cancelScheduledValues(t);
        g.setTargetAtTime(dB(amount), t, 0.02);
        g.setTargetAtTime(1, t + hold, 0.45);
    }

    /** A robot says something. @param {"hit" | "out" | "emote" | "win"} what */
    voice(id, what, x, y) {
        const a = this.audio;
        if (!a.ready) return;
        const ctx = a.ctx, base = 170 + ((id * 47) % 8) * 28;
        const shape = { hit: [1.6, 0.8], out: [1.3, 1, 0.75, 0.5], emote: [1, 1.4, 1.15], win: [1, 1.25, 1.5, 2] }[what];
        const place = this.at(x, y), t0 = ctx.currentTime + 0.01, len = 0.075;
        const out = ctx.createGain(); out.gain.value = 0.16 * place.volume;
        const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
        if (pan) { pan.pan.value = place.pan; out.connect(pan).connect(a.channels.sfx); } else out.connect(a.channels.sfx);
        shape.forEach((k, i) => {
            const t = t0 + i * len * 1.15, o = ctx.createOscillator(), ring = ctx.createOscillator(), ringGain = ctx.createGain(), g = ctx.createGain();
            o.type = "square"; o.frequency.value = base * k * (0.96 + Math.random() * 0.08);
            ring.type = "square"; ring.frequency.value = base * k * 2.7;
            ringGain.gain.value = 0;
            ring.connect(ringGain.gain);
            g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(1, t + 0.008); g.gain.setValueAtTime(1, t + len * 0.7); g.gain.linearRampToValueAtTime(0, t + len);
            o.connect(ringGain).connect(g).connect(out);
            o.start(t); ring.start(t); o.stop(t + len); ring.stop(t + len);
        });
    }

    /** Every frame. @param {number} intensity 0..1 @param {boolean} playing a round is on */
    update(intensity, playing) {
        this.intensity = intensity; this.playing = playing;
        if (!this.layers) return;
        const t = this.audio.ctx.currentTime, k = intensity;
        const want = { bass: playing ? 0.8 : 0.45, marimba: playing ? 0.55 : 0.35, drums: playing ? 0.3 + k * 0.5 : 0, lead: playing && k > 0.3 ? (k - 0.3) * 0.9 : 0, tension: playing && k > 0.55 ? (k - 0.55) * 1.1 : 0 };
        for (const name in want) this.layers[name].gain.setTargetAtTime(want[name], t, 0.5);
    }

    note(dest, t, f, len, type, peak) {
        const ctx = this.audio.ctx, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = type; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, t + len);
        o.connect(g).connect(dest); o.start(t); o.stop(t + len + 0.02);
    }
    hat(dest, t, peak) {
        const ctx = this.audio.ctx;
        if (!this.noise) { const n = ctx.sampleRate * 0.1 | 0; this.noise = ctx.createBuffer(1, n, ctx.sampleRate); const d = this.noise.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }
        const s = ctx.createBufferSource(), hp = ctx.createBiquadFilter(), g = ctx.createGain();
        s.buffer = this.noise; hp.type = "highpass"; hp.frequency.value = 6000;
        g.gain.setValueAtTime(peak, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
        s.connect(hp).connect(g).connect(dest); s.start(t); s.stop(t + 0.06);
    }

    /** Lay down the next notes, a little ahead of the clock. */
    schedule() {
        const ctx = this.audio.ctx;
        if (this.nextAt < ctx.currentTime - 1) this.nextAt = ctx.currentTime + 0.05;   // the tab slept
        while (this.nextAt < ctx.currentTime + 0.15) {
            const t = this.nextAt, s = this.step, beat = s % 16, bar = Math.floor(s / 16) % 4, root = CHORDS[bar], L = this.layers;
            // bass: oom-pah, bouncy
            if (beat === 0 || beat === 8) this.note(L.bass, t, hz(root - 12), 0.22, "triangle", 0.5);
            if (beat === 6 || beat === 14) this.note(L.bass, t, hz(root - 5), 0.14, "triangle", 0.32);
            // marimba: a tumbling figure that changes with the bar
            const fig = [0, 2, 3, 2, 4, 3, 2, 1][(s >> 1) % 8];
            if (s % 2 === 0 && (s * 7 + bar) % 5 !== 0) this.note(L.marimba, t, hz(root + SCALE[fig + 4]), 0.16, "sine", 0.3);
            // drums
            if (beat % 8 === 0) { const o = ctx.createOscillator(), g = ctx.createGain(); o.frequency.setValueAtTime(130, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12); g.gain.setValueAtTime(0.7, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.16); o.connect(g).connect(L.drums); o.start(t); o.stop(t + 0.18); }
            if (beat === 4 || beat === 12) this.hat(L.drums, t, 0.4);
            if (s % 2 === 0) this.hat(L.drums, t, 0.1);
            // lead: only when things are going badly
            if (bar % 2 === 1 && [0, 3, 6, 10, 12].includes(beat)) this.note(L.lead, t, hz(root + SCALE[[5, 7, 8, 7, 9][[0, 3, 6, 10, 12].indexOf(beat)]]), 0.2, "square", 0.1);
            // tension: a pulse on every eighth
            if (s % 2 === 0) this.note(L.tension, t, hz(root + 12), 0.08, "sawtooth", 0.08);
            this.step++;
            this.nextAt += STEP;
        }
    }
}
