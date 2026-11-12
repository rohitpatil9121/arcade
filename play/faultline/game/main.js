import { Game, Camera, TouchControls, PostFX } from "../engine/index.js";
import { Run } from "./sim.js";
import { Driver } from "./driver.js";
import { World } from "./world.js";
import { Sound } from "./sound.js";
import { load, store, defaults, ALT_KEYS } from "./save.js";
import { VEHICLES, BIOMES, UPGRADES, ACHIEVEMENTS, ENDINGS, RACE, FUEL, PHYS } from "./data.js";
import { WARN } from "./terrain.js";

/**
 * FAULTLINE: the application. Screens, input, the HUD, the garage and the save. The simulation (sim.js)
 * knows nothing of this; each fixed step the controls go in and events come out, and world.js draws.
 *
 * Behind the menus the game drives itself: the test bot runs the selected vehicle in the selected biome,
 * so the title screen shows the game being played.
 * @module game/main
 */

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const save = load();
const persist = () => store(save);
const sound = new Sound(save);

// ------------------------------------------------------------------ engine
const canvas = $("view");
const game = new Game({ canvas, quality: "high", camera: new Camera({ mode: "orbit", fov: 40, near: 0.2, far: 1600 }) });
if (game.failed) throw new Error("WebGL unavailable");
const { renderer, input } = game;
renderer.postfx = new PostFX(renderer, { bloom: { threshold: 1.05, intensity: 0.4 }, ao: { enabled: true, radius: 0.7, intensity: 0.55 }, exposure: 1.0, saturation: 1.12, contrast: 1.06, vignette: 0.22, grain: 0 });
const world = new World(game);

// ------------------------------------------------------------------ input
function bindKeys() {
    input.bind("gas", [save.keys.gas, ALT_KEYS.gas, "TouchGas"]);
    input.bind("brake", [save.keys.brake, ALT_KEYS.brake, "TouchBrake"]);
    input.bind("charge", [save.keys.charge, ALT_KEYS.charge, "TouchCharge"]);
}
bindKeys();
input.bind("pause", ["Escape", "KeyP"]);
input.bind("mute", ["KeyM"]);
input.bind("debug", ["F3"]);
const touch = new TouchControls(input, { visible: "auto", color: "255,246,234" });
touch.button({ code: "TouchBrake", label: "◀ Brake", side: "left", size: 112, offset: [22, 22] });
touch.button({ code: "TouchGas", label: "Gas ▶", side: "right", size: 112, offset: [22, 22] });
touch.button({ code: "TouchCharge", label: "Charge", side: "right", size: 76, offset: [150, 70] });
if (touch.visible) $("title-hint").textContent = "Right pedal: drive · left pedal: brake and reverse · hold Charge to aim, let go to drop";

const pad = () => (navigator.getGamepads ? [...navigator.getGamepads()].find(Boolean) : null) || null;
const padVal = (p, b) => (p && p.buttons[b] ? (p.buttons[b].value || (p.buttons[b].pressed ? 1 : 0)) : 0);
/** the player's controls this step */
function controls() {
    const p = pad();
    let gas = input.isDown("gas") ? 1 : 0, brake = input.isDown("brake") ? 1 : 0, charge = input.isDown("charge");
    if (p) {
        gas = Math.max(gas, padVal(p, 7), padVal(p, 0), (p.axes[0] || 0) > 0.5 ? 1 : 0);
        brake = Math.max(brake, padVal(p, 6), padVal(p, 2), (p.axes[0] || 0) < -0.5 ? 1 : 0);
        charge = charge || padVal(p, 1) > 0.5 || padVal(p, 5) > 0.5;
    }
    return { gas, brake, charge };
}

// ------------------------------------------------------------------ settings applied
function reducedMotion() { return save.motion === "on" || (save.motion === "auto" && matchMedia("(prefers-reduced-motion: reduce)").matches); }
function applySettings() {
    document.documentElement.style.setProperty("--text", save.textSize);
    game.juice.reducedMotion = reducedMotion();
    world.reducedMotion = reducedMotion();
    world.contrast = save.contrast;
    sound.set("music", save.music); sound.set("sfx", save.sfx); sound.set("muted", save.muted);
}
let tier = "high";
function applyQuality(name) { tier = name; world.setQuality(name); }
// Automatic starts high and steps down if a few seconds of driving run under 45 frames a second. Never back up.
let slowFor = 0;
function autoQuality(dt) {
    if (save.quality !== "auto" || tier === "low" || document.hidden || screen !== "play") return;
    slowFor = game.loop.fps < 45 ? slowFor + dt : 0;
    if (slowFor > 4) { slowFor = 0; applyQuality(tier === "high" ? "medium" : "low"); toast(`Graphics set to ${tier} to keep it smooth`); }
}
applyQuality(save.quality === "auto" ? "high" : save.quality);
applySettings();

// ------------------------------------------------------------------ screens
let screen = "title";
const SCREENS = ["title", "select", "garage", "pause", "results", "settings", "achievements"];
let back = [];
function show(name, remember = true) {
    if (remember && screen !== name && screen !== "play") back.push(screen);
    screen = name;
    for (const s of SCREENS) $(s).hidden = s !== name;
    $("hud").hidden = !(name === "play" || name === "pause");
    $("tags").hidden = name !== "play";
    touch.root.style.display = touch.visible && name === "play" ? "block" : "none";
    const focus = name !== "play" && ($(name).querySelector("[data-focus]") || $(name).querySelector("button"));
    if (focus) focus.focus();
    if (name === "title") refreshWallet();
}
function goBack() {
    const to = back.pop() || "title";
    if (to === "pause" || (to === "play" && run)) { show(run && !run.over ? "pause" : "title", false); return; }
    show(to, false);
    if (to === "title" || to === "garage" || to === "select") ensureAttract();
}
document.querySelectorAll("[data-back]").forEach((b) => b.addEventListener("click", () => { sound.play("ui"); goBack(); }));
function refreshWallet() { document.querySelectorAll(".coins").forEach((e) => (e.textContent = save.coins.toLocaleString())); }
function toast(text, ms = 2200) {
    const t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.hidden = true), ms);
}
function caption(text) {
    if (!save.captions || screen !== "play") return;
    const el = document.createElement("div");
    el.textContent = text;
    $("captions").append(el);
    while ($("captions").children.length > 3) $("captions").firstChild.remove();
    setTimeout(() => el.remove(), 2200);
}

// ------------------------------------------------------------------ the run being shown
/** @type {Run | null} */
let run = null;
let attract = true;                // the bot drives, behind the menus
let showroom = false;              // parked in the garage
const bot = new Driver({ style: "bot" }, 99);
let mode = "endless", biomeId = save.biome, difficulty = save.difficulty;
let endedAt = 0;
const paint = () => ({ paint: VEHICLES.find((v) => v.id === save.vehicle).color, helmet: [1, 0.85, 0.2] });

function newRun(opts) {
    run = new Run(opts);
    const biome = run.biome;
    world.setBiome(biome);
    sound.setBiome(biome.id);
    world.attach(run, paint());
    world.bestX = opts.mode === "race" ? RACE.length : save.best[`${biome.id}:${opts.vehicle}`] || 0;
    return run;
}
function ensureAttract(force = false) {
    if (!force && run && attract) return;
    attract = true; showroom = false;
    newRun({ biome: save.biome, vehicle: save.vehicle, seed: (Math.random() * 1e9) >>> 0, upgrades: { engine: 2, suspension: 2, tyres: 2, tank: 5 } });
}
function startShowroom() {
    attract = false; showroom = true;
    newRun({ biome: save.biome, vehicle: garageCar().id, seed: 77, upgrades: save.upgrades[garageCar().id] });
    world.bestX = 0;
}

const todaySeed = () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
function startRun(m = mode, b = biomeId, fixedSeed = null) {
    mode = m; biomeId = b;
    save.biome = b; persist();
    attract = false; showroom = false;
    const bi = BIOMES.findIndex((x) => x.id === b);
    const seed = fixedSeed ?? (m === "daily" ? todaySeed() * 10 + bi : (Math.random() * 1e9) >>> 0);
    newRun({ biome: b, vehicle: save.vehicle, seed, mode: m === "race" ? "race" : "endless", difficulty, upgrades: save.upgrades[save.vehicle], assist: save.assist });
    hud.reset();
    tutorial.start();
    endedAt = 0;
    sound.unlock();
    show("play");
    canvas.focus();
}

// ------------------------------------------------------------------ the HUD
const hud = {
    pops: [],
    lowBeep: 0,
    reset() {
        $("tide").hidden = !run.biome.tide;
        $("place").hidden = run.mode !== "race";
        $("pops").innerHTML = ""; $("arrows").innerHTML = ""; $("tags").innerHTML = "";
        this.tags = run.vehicles.filter((v) => !v.isPlayer).map((v) => { const el = document.createElement("div"); el.className = "tag"; el.textContent = v.name; el.style.borderBottom = `3px solid rgb(${v.color.map((c) => Math.round(c * 255)).join(",")})`; $("tags").append(el); return el; });
        this.arrows = [0, 1, 2].map(() => { const el = document.createElement("div"); el.className = "arrow-tag"; el.hidden = true; $("arrows").append(el); return el; });
        const best = save.best[`${run.biome.id}:${save.vehicle}`];
        $("dist-best").textContent = run.mode === "race" ? `finish ${RACE.length} m` : best ? `best ${best} m` : "";
    },
    pop(text, x, y) {
        const el = document.createElement("div");
        el.className = "pop"; el.textContent = text;
        el.style.left = `${x}px`; el.style.top = `${y}px`;
        $("pops").append(el);
        setTimeout(() => el.remove(), 1300);
    },
    update(dt) {
        const p = run.player, w = innerWidth, h = innerHeight;
        $("dist-n").textContent = Math.floor(run.distance);
        const f = p.fuel / p.tank;
        $("fuel-bar").style.width = `${Math.round(f * 100)}%`;
        $("fuel").classList.toggle("low", f < FUEL.lowAlarm);
        if (f < FUEL.lowAlarm && f > 0 && p.alive) { this.lowBeep -= dt; if (this.lowBeep <= 0) { this.lowBeep = 1.2; sound.play("alarm"); caption("Fuel low"); } }
        $("coins-n").textContent = run.coins;
        const ch = $("charges-hud");
        const max = Math.max(3, p.charges);
        if (ch.childElementCount !== max || ch.dataset.n !== String(p.charges)) {
            ch.innerHTML = ""; ch.dataset.n = p.charges;
            for (let i = 0; i < max; i++) { const el = document.createElement("i"); if (i >= p.charges) el.className = "off"; ch.append(el); }
        }
        if (run.biome.tide) {
            const tide = run.terrain.water();
            const depth = tide.level - run.biome.tide.low, full = run.biome.tide.high - run.biome.tide.low;
            const el = $("tide");
            el.textContent = `Tide ${tide.rising ? "rising ▲" : "falling ▼"} ${Math.round((depth / full) * 100)}%`;
            el.classList.toggle("rising", tide.rising && depth / full > 0.25);
        }
        if (run.mode === "race") {
            const order = run.standings();
            const place = order.indexOf(p) + 1;
            $("place").textContent = `${["1st", "2nd", "3rd", "4th"][place - 1]} of ${order.length}\n${Math.max(0, Math.round(RACE.length - p.x))} m to go`;
            run.vehicles.filter((v) => !v.isPlayer).forEach((v, i) => {
                const s = world.toScreen(v.x, v.y + 2.2, w, h), el = this.tags[i];
                el.hidden = !s.visible || s.x < 0 || s.x > w;
                if (!el.hidden) { el.style.left = `${s.x}px`; el.style.top = `${s.y}px`; el.style.opacity = v.alive ? 1 : 0.5; }
            });
        }
        // changes beyond the right edge of the view get an arrow at that edge
        let a = 0;
        for (const e of run.warnings()) {
            if (a >= this.arrows.length) break;
            const s = world.toScreen(e.center, run.terrain.h(e.center), w, h);
            if (s.visible && s.x < w - 40) continue;
            if (e.center < p.x) continue;
            const el = this.arrows[a++];
            el.hidden = false;
            el.className = `arrow-tag${e.charge ? " charge" : ""}`;
            el.textContent = `${{ heave: "Heave", slump: "Slump", fault: "Fault", crack: "Crack", charge: "Charge" }[e.type]} ${Math.round(e.center - p.x)} m`;
            el.style.top = `${Math.max(120, Math.min(h - 160, s.visible ? s.y : h * 0.5))}px`;
        }
        for (; a < this.arrows.length; a++) this.arrows[a].hidden = true;
    },
};

// ------------------------------------------------------------------ tutorial
const tutorial = {
    on: false, step: 0, until: 0,
    start() {
        this.on = !save.tutorialDone && run.biome.id === "mesa" && run.mode !== "race";
        this.step = 0;
        this.say(touch.visible ? "Hold the right pedal to drive. The left one brakes, and reverses when you're stopped." : "Hold → to drive. ← brakes, and reverses when you're stopped.", 0);
    },
    say(text, secs) { const el = $("tutorial"); el.textContent = text; el.hidden = !this.on || !text; this.until = secs ? run.t + secs : Infinity; },
    update() {
        if (!this.on) { $("tutorial").hidden = true; return; }
        const p = run.player;
        if (run.t > this.until) $("tutorial").hidden = true;
        if (this.step === 0 && run.distance > 45) { this.step = 1; this.say("", 0); }
        if (this.step === 1 && p.air > 0.45) { this.step = 2; this.say(touch.visible ? "In the air, Gas tips the nose up and Brake tips it down. Land on your wheels!" : "In the air, → tips the nose up and ← tips it down. Land on your wheels!", 4); }
        if (this.step <= 2 && run.warnings().some((e) => e.natural && e.center > p.x)) { this.step = 3; this.say("Orange glow: that ground is about to move. Read it and pick your speed.", 5); }
        if (this.step === 3 && p.charges > 0 && run.t > this.until) { this.step = 4; this.say(touch.visible ? "Hold Charge to aim a tremor charge, let go to drop it. Flat ground rises into a ramp, a slope sinks." : "Hold Space to aim a tremor charge, let go to drop it. Flat ground rises into a ramp, a slope sinks.", 6); }
    },
};

// ------------------------------------------------------------------ events from the simulation
const ordinal = (n) => ["1st", "2nd", "3rd", "4th"][n - 1] || `${n}th`;
function handleEvents() {
    const evs = run.events;
    if (!evs.length && !run.terrain.moved.length) return;
    const playing = screen === "play";
    world.effects(evs, game.juice, run);
    const p = run.player, w = innerWidth, h = innerHeight;
    const pan = (x) => Math.max(-0.8, Math.min(0.8, (x - p.x) / 30));
    for (const e of evs) {
        if (!playing && !["land"].includes(e.type)) continue;
        switch (e.type) {
            case "pickup":
                sound.play(e.kind === "coin" ? "coin" : e.kind === "fuel" ? "fuel" : "pickcharge", { pitch: e.kind === "coin" ? 1 + (run.coins % 50) / 200 : 1, gap: 0.02 });
                if (e.kind === "fuel") { caption("Fuel refilled"); const s = world.toScreen(e.x, e.y, w, h); hud.pop("Fuel!", s.x, s.y); }
                if (e.kind === "charge") caption("Got a tremor charge");
                break;
            case "trick": {
                sound.play(e.flips ? "flip" : "trick");
                const s = world.toScreen(p.x, p.y + 2.5, w, h);
                hud.pop(`${e.what} +${e.coins}`, s.x, s.y - hud.pops.length * 4);
                break;
            }
            case "land": if (e.speed > 6) sound.play(e.speed > 11 ? "clunk" : "land", { volume: Math.min(1, e.speed / 14) }); break;
            case "charge": sound.play("drop", { pan: pan(e.x) }); if (!e.player) caption(`${e.by} dropped a charge`); break;
            case "crash":
                if (e.player) { sound.play(e.why === "water" ? "splash" : "crash"); sound.dip(-14, 0.8); caption({ head: "Crash!", crack: "Fell into the crack", water: "Engine flooded", fuel: "Out of fuel", stuck: "Stuck upside down" }[e.why]); }
                break;
            case "respawn": if (e.player) caption("Back on the road (+2 s)"); break;
            case "empty": caption("Out of fuel"); break;
            case "cache": toast("Hidden coin cache!"); break;
            case "finish": if (e.player) { sound.play("finish"); } else caption(`${e.name} finished ${ordinal(e.place)}`); break;
        }
    }
    for (const e of run.terrain.moved) {
        if (!playing || Math.abs(e.center - p.x) > 90) continue;
        if (e.state === 1) {
            sound.play(e.type === "crack" ? "crack" : "boom", { pan: pan(e.center), volume: Math.max(0.3, 1 - Math.abs(e.center - p.x) / 90) });
            if (e.type !== "charge") sound.dip(-5, 0.3);
            caption({ heave: "The ground heaves", slump: "The ground slumps", fault: "A fault slips", crack: "The ground cracks open", charge: "Charge goes off" }[e.type]);
        }
    }
    run.events.length = 0;
}

// ------------------------------------------------------------------ the end of a run
function finishRun() {
    const r = run.result, biome = run.biome, vid = save.vehicle;
    const earned = r.coins;
    save.coins += earned;
    save.stats.runs++; save.stats.metres += r.distance; save.stats.flips += r.tricks.flips; save.stats.coins += earned;
    if (r.why !== "finish") save.stats.crashes++;
    const wasOpen = BIOMES.map((b) => isUnlocked(b));
    const key = `${biome.id}:${vid}`;
    const prevBest = save.best[key] || 0, prevBiome = save.best[biome.id] || 0;
    let newBest = false;
    if (run.mode !== "race") {
        if (r.distance > prevBest) { save.best[key] = r.distance; newBest = prevBest > 0; }
        if (r.distance > prevBiome) save.best[biome.id] = r.distance;
        if (mode === "daily") { const dk = `${todaySeed()}:${biome.id}`; save.daily[dk] = Math.max(save.daily[dk] || 0, r.distance); }
        if (r.distance > 400) save.tutorialDone = true;
    }
    const unlocked = BIOMES.filter((b, i) => !wasOpen[i] && isUnlocked(b)).map((b) => `${b.name} unlocked!`);
    const got = checkAchievements(r);
    persist();
    refreshWallet();

    // the card
    const line = ENDINGS[r.why] || ENDINGS.finish;
    $("res-line").textContent = line[Math.floor(Math.random() * line.length)];
    $("res-dist").textContent = run.mode === "race" ? (r.why === "finish" ? `${ordinal(r.place)} place` : "Did not finish") : `${r.distance.toLocaleString()} m`;
    $("res-best").textContent = run.mode === "race" ? `${Math.round(r.time)} s · ${biome.name}` : newBest ? "New best!" : prevBest ? `Best ${Math.max(prevBest, r.distance).toLocaleString()} m` : "";
    const rows = [["Coins picked up", earned - run.coinsFromTricks - (r.prize || 0)], ["Tricks", run.coinsFromTricks]];
    if (r.prize) rows.push([`${ordinal(r.place)} place prize`, r.prize]);
    if (r.tricks.flips) rows.push(["Flips", r.tricks.flips]);
    if (r.tricks.bestAir > 1) rows.push(["Best air", `${r.tricks.bestAir.toFixed(1)} s`]);
    if (r.tricks.rides) rows.push(["Heaves ridden", r.tricks.rides]);
    rows.push(["Total coins", `+${earned}`]);
    $("res-list").innerHTML = rows.map(([a, b]) => `<li><span>${a}</span><b>${b}</b></li>`).join("");
    $("res-new").innerHTML = [...unlocked, ...got.map((a) => `Achievement: ${a.name}`)].map((t) => `<li>${t}</li>`).join("");
    sound.play(r.why === "finish" ? "finish" : "lose", { volume: 0.7 });
    show("results");
}
function isUnlocked(b, bests = save.best) {
    if (!b.unlock) return true;
    return (bests?.[b.unlock.biome] || 0) >= b.unlock.distance;
}

function grant(id, list) {
    if (save.achievements.includes(id)) return;
    save.achievements.push(id);
    const a = ACHIEVEMENTS.find((x) => x.id === id);
    if (a && list) list.push(a);
    else if (a) toast(`Achievement: ${a.name}`);
}
function checkAchievements(r) {
    const got = [], t = r.tricks;
    grant("first", got);
    if (r.distance >= 1000) grant("km1", got);
    if (r.distance >= 3000) grant("km3", got);
    if (r.distance >= 5000) grant("km5", got);
    if (t.flips) grant("flip", got);
    if (t.rides) grant("ride", got);
    if (t.rides >= 3) grant("ride3", got);
    if (t.closeCalls) grant("close", got);
    if (t.chargesUsed) grant("charge", got);
    if (t.rampJumps) grant("ramp", got);
    if (t.caches) grant("cache", got);
    if (t.bestAir >= 3) grant("air3", got);
    if (run.maxFlips >= 3) grant("flip3", got);
    for (const b of ["glacier", "ash", "delta"]) if (isUnlocked(BIOMES.find((x) => x.id === b))) grant(b, got);
    if (run.mode === "race" && r.why === "finish" && r.place === 1) {
        grant("race", got);
        save.raceWins[difficulty] = (save.raceWins[difficulty] || 0) + 1;
        if (difficulty === "hard") grant("hardrace", got);
    }
    return got;
}

// ------------------------------------------------------------------ biome select
function openSelect(m) {
    mode = m;
    $("select-title").textContent = { endless: "Choose a road", daily: "Today's road", race: "Race the Shaky Post" }[m];
    $("difficulty").hidden = m !== "race";
    document.querySelectorAll("[data-diff]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.diff === difficulty)));
    const cards = $("biomes");
    cards.innerHTML = "";
    for (const b of BIOMES) {
        const open = isUnlocked(b);
        const el = document.createElement("button");
        el.className = `card${open ? "" : " locked"}`;
        const c = b.colors, sk = b.sky;
        const rgb = (v) => `rgb(${v.map((x) => Math.round(Math.min(1, x) * 255)).join(",")})`;
        const best = m === "daily" ? save.daily[`${todaySeed()}:${b.id}`] : save.best[`${b.id}:${save.vehicle}`];
        const need = b.unlock ? `Reach ${b.unlock.distance} m in ${BIOMES.find((x) => x.id === b.unlock.biome).name}` : "";
        el.innerHTML = `<div class="swatch" style="background:linear-gradient(${rgb(sk.zenith)}, ${rgb(sk.horizon)} 45%, ${rgb(c.far)} 46%, ${rgb(c.mid)} 62%, ${rgb(c.top)} 63%, ${rgb(c.soil)} 75%, ${rgb(c.rock)})"></div>
            <h3>${b.name}${open ? "" : " 🔒"}</h3><p>${b.blurb}</p><small>${open ? (best ? `Best ${best} m${m === "daily" ? " today" : ""}` : "Not driven yet") : need}</small>`;
        el.disabled = !open;
        el.addEventListener("click", () => { sound.play("ui"); startRun(m, b.id); });
        cards.append(el);
    }
    show("select");
    cards.querySelector("button:not(:disabled)")?.focus();
}
document.querySelectorAll("[data-diff]").forEach((b) => b.addEventListener("click", () => {
    difficulty = b.dataset.diff; save.difficulty = difficulty; persist();
    document.querySelectorAll("[data-diff]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
    sound.play("ui");
}));

// ------------------------------------------------------------------ garage
let carIndex = VEHICLES.findIndex((v) => v.id === save.vehicle);
const garageCar = () => VEHICLES[carIndex];
function stat(v, up, k) {
    const lv = (n) => up[n] || 0;
    switch (k) {
        case "Power": return (v.torque * (1 + UPGRADES.engine * lv("engine"))) / v.mass / 13;
        case "Top speed": return (v.spin * v.wheels[0].r * (1 + UPGRADES.engine * 0.6 * lv("engine"))) / 30;
        case "Grip": return (v.grip * (1 + UPGRADES.tyres * lv("tyres"))) / 2;
        case "Suspension": return (v.travel * (1 + UPGRADES.suspension * lv("suspension"))) / 0.6;
        case "Fuel": return (v.tank * (1 + UPGRADES.tank * lv("tank"))) / 260;
        case "Air control": return v.air / 1.8;
    }
    return 0;
}
function renderGarage() {
    const v = garageCar(), owned = save.owned.includes(v.id), up = save.upgrades[v.id] || (save.upgrades[v.id] = {});
    $("car-name").textContent = v.name;
    $("car-blurb").textContent = v.blurb;
    $("car-stats").innerHTML = ["Power", "Top speed", "Grip", "Suspension", "Fuel", "Air control"].map((k) => `<span>${k}</span><div class="meter"><i style="width:${Math.round(Math.min(1, stat(v, up, k)) * 100)}%"></i></div>`).join("");
    const ups = $("upgrades");
    ups.innerHTML = "";
    ups.hidden = !owned;
    for (const kind of UPGRADES.kinds) {
        const lv = up[kind] || 0, cost = UPGRADES.cost[lv];
        const row = document.createElement("div");
        row.className = "up";
        row.title = UPGRADES.help[kind];
        row.innerHTML = `<span>${UPGRADES.names[kind]}</span><span class="pips">${[0, 1, 2, 3, 4].map((i) => `<i class="${i < lv ? "on" : ""}"></i>`).join("")}</span>`;
        const b = document.createElement("button");
        b.textContent = lv >= 5 ? "Max" : `${cost.toLocaleString()} ●`;
        b.disabled = lv >= 5;
        b.setAttribute("aria-label", lv >= 5 ? `${UPGRADES.names[kind]} at maximum` : `Upgrade ${UPGRADES.names[kind]} for ${cost} coins`);
        b.addEventListener("click", () => {
            if (save.coins < cost) { sound.play("nope"); toast("Not enough coins yet"); return; }
            save.coins -= cost; up[kind] = lv + 1; sound.play("buy");
            if (UPGRADES.kinds.every((k) => (up[k] || 0) >= 5)) grant("maxed");
            persist(); refreshWallet(); renderGarage(); startShowroom();
            ups.querySelectorAll("button")[UPGRADES.kinds.indexOf(kind)]?.focus();
        });
        row.append(b);
        ups.append(row);
    }
    const act = $("car-action");
    if (!owned) { act.textContent = `Buy · ${v.cost.toLocaleString()} ●`; act.disabled = false; }
    else if (save.vehicle === v.id) { act.textContent = "Driving this one"; act.disabled = true; }
    else { act.textContent = "Drive this one"; act.disabled = false; }
    refreshWallet();
}
function openGarage() { carIndex = VEHICLES.findIndex((v) => v.id === save.vehicle); renderGarage(); startShowroom(); show("garage"); }
$("prev-car").addEventListener("click", () => { carIndex = (carIndex + VEHICLES.length - 1) % VEHICLES.length; sound.play("ui"); renderGarage(); startShowroom(); });
$("next-car").addEventListener("click", () => { carIndex = (carIndex + 1) % VEHICLES.length; sound.play("ui"); renderGarage(); startShowroom(); });
$("car-action").addEventListener("click", () => {
    const v = garageCar();
    if (!save.owned.includes(v.id)) {
        if (save.coins < v.cost) { sound.play("nope"); toast(`${(v.cost - save.coins).toLocaleString()} more coins to go`); return; }
        save.coins -= v.cost; save.owned.push(v.id); sound.play("buy"); toast(`${v.name} is yours`);
        if (save.owned.length === VEHICLES.length) grant("garage");
    }
    save.vehicle = v.id; persist(); renderGarage(); startShowroom();
});

// ------------------------------------------------------------------ settings
function renderSettings() {
    $("set-music").value = save.music; $("set-sfx").value = save.sfx; $("set-muted").checked = save.muted;
    $("set-quality").value = save.quality; $("set-motion").value = save.motion; $("set-text").value = String(save.textSize);
    $("set-captions").checked = save.captions; $("set-contrast").checked = save.contrast; $("set-assist").checked = save.assist;
    const keys = $("keys");
    keys.innerHTML = "";
    for (const [action, label] of [["gas", "Gas"], ["brake", "Brake / reverse"], ["charge", "Tremor charge"]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = save.keys[action];
        b.addEventListener("click", () => {
            b.textContent = "Press a key…"; b.classList.add("listening");
            const take = (e) => {
                e.preventDefault();
                if (e.code !== "Escape") save.keys[action] = e.code;
                removeEventListener("keydown", take, true);
                bindKeys(); persist(); renderSettings();
            };
            addEventListener("keydown", take, true);
        });
        const span = document.createElement("span"); span.textContent = `${label} (also ${ALT_KEYS[action]})`;
        keys.append(span, b);
    }
}
$("settings-form").addEventListener("input", () => {
    save.music = +$("set-music").value; save.sfx = +$("set-sfx").value; save.muted = $("set-muted").checked;
    save.motion = $("set-motion").value; save.textSize = +$("set-text").value;
    save.captions = $("set-captions").checked; save.contrast = $("set-contrast").checked; save.assist = $("set-assist").checked;
    const q = $("set-quality").value;
    if (q !== save.quality) { save.quality = q; applyQuality(q === "auto" ? "high" : q); }
    applySettings(); persist();
});
$("reset-save").addEventListener("click", () => {
    if (!confirm("Erase coins, vehicles, upgrades and bests? Settings stay.")) return;
    const keep = { music: save.music, sfx: save.sfx, muted: save.muted, quality: save.quality, motion: save.motion, textSize: save.textSize, captions: save.captions, contrast: save.contrast, assist: save.assist, keys: save.keys };
    Object.assign(save, defaults(), keep);
    persist(); refreshWallet(); toast("Progress erased");
});

function renderAchievements() {
    $("ach-list").innerHTML = ACHIEVEMENTS.map((a) => `<li class="${save.achievements.includes(a.id) ? "got" : ""}"><b>${a.name}</b>${a.help}</li>`).join("");
}

// ------------------------------------------------------------------ buttons
const click = (id, fn) => $(id).addEventListener("click", () => { sound.unlock(); sound.play("ui"); fn(); });
click("go", () => (save.tutorialDone ? openSelect("endless") : startRun("endless", "mesa")));
click("to-garage", openGarage);
click("to-race", () => openSelect("race"));
click("to-daily", () => openSelect("daily"));
click("to-settings", () => { renderSettings(); show("settings"); });
click("to-achievements", () => { renderAchievements(); show("achievements"); });
click("resume", () => { show("play", false); canvas.focus(); });
click("restart", () => startRun());
click("pause-settings", () => { renderSettings(); show("settings"); });
click("quit", () => { back = []; ensureAttract(true); show("title", false); });
click("again", () => startRun());
click("res-garage", () => { openGarage(); back = ["title"]; });
click("res-menu", () => { back = []; ensureAttract(true); show("title", false); });
$("pause-btn").addEventListener("click", () => pause());
function pause() { if (screen === "play" && run && !run.over) { show("pause"); sound.play("ui"); } }
addEventListener("blur", () => { if (screen === "play" && touch.visible) pause(); });
document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });

// gamepad menus: the d-pad moves focus, A presses, B goes back, Start pauses
let padPrev = [];
function padMenus() {
    const p = pad();
    if (!p) return;
    const now = p.buttons.map((b) => b.pressed), edge = (i) => now[i] && !padPrev[i];
    if (screen === "play") { if (edge(9)) pause(); padPrev = now; return; }
    const items = [...$(screen).querySelectorAll("button:not(:disabled), select, input")].filter((e) => e.offsetParent);
    const i = items.indexOf(document.activeElement);
    if (edge(12) || edge(14)) items[(i - 1 + items.length) % items.length]?.focus();
    if (edge(13) || edge(15)) items[(i + 1) % items.length]?.focus();
    if (edge(0)) document.activeElement?.click?.();
    if (edge(1)) goBack();
    if (edge(9) && screen === "pause") $("resume").click();
    padPrev = now;
}

// ------------------------------------------------------------------ the loop
let debugOn = false, stepMs = 0;
game.onUpdate(() => {
    if (input.wasPressed("pause")) { if (screen === "play") pause(); else if (screen === "pause") { show("play", false); canvas.focus(); } else if (screen !== "title") goBack(); }
    if (input.wasPressed("mute")) { save.muted = !save.muted; applySettings(); persist(); toast(save.muted ? "Muted" : "Sound on", 1000); }
    if (input.wasPressed("debug")) { debugOn = !debugOn; $("debug").hidden = !debugOn; }
    padMenus();
    if (!run) return;
    const playing = screen === "play";
    if (!playing && !attract && !showroom) return;     // paused or on a card: the road holds still
    const t0 = performance.now();
    for (let i = 0; i < PHYS.hz / 60; i++) {
        let c = { gas: 0, brake: 0, charge: false };
        if (playing) c = controls();
        else if (attract) c = bot.drive(run, run.player);
        else if (showroom) c = { brake: Math.abs(run.player.vx) > 0.2 ? 0.5 : 0 };
        run.step(c);
        if (run.player.air > 0) run.maxFlips = Math.max(run.maxFlips || 0, Math.floor((Math.abs(run.player.airRot) + 0.7) / (Math.PI * 2)));
    }
    stepMs = stepMs * 0.95 + (performance.now() - t0) * 0.05;
    world.fixedUpdate();
    handleEvents();
    if (playing) tutorial.update();
    if (run.over) {
        if (attract) { ensureAttract(true); return; }
        if (playing && !endedAt) endedAt = run.t;
        if (playing && run.t - endedAt > 1.6) finishRun();
    }
});
game.onRender((frameDelta, alpha) => {
    if (!run) return;
    world.render(run, alpha, frameDelta, { close: showroom });
    if (screen === "play" || screen === "pause") hud.update(frameDelta);
    const p = run.player;
    const drive = p.wheels.reduce((m, w) => Math.max(m, Math.abs(w.spin * w.r)), 0);
    const slip = p.wheels.reduce((m, w) => (w.touching ? Math.max(m, Math.abs(-w.spin * w.r - p.vx)) : m), 0);
    let warn = 0;
    for (const e of run.warnings()) {
        const d = Math.abs(e.center - p.x);
        if (d > 80) continue;
        const k = e.state === WARN ? 1 - Math.max(0, e.tMove - run.t) / 3 : Math.max(0, 1 - (run.t - e.tMove) / 1.5);
        warn = Math.max(warn, k * (1 - d / 80));
    }
    sound.update({ rpm: drive * 4, gas: p.gas, speed: Math.abs(p.vx), air: p.air, slip, warn: Math.min(1, warn), alive: p.alive, playing: screen === "play" });
    autoQuality(frameDelta);
    if (debugOn) $("debug").textContent = `${game.loop.fps.toFixed(0)} fps · ${game.loop.frameMs.toFixed(1)} ms frame · physics ${stepMs.toFixed(2)} ms/frame · tier ${tier}\nx ${p.x.toFixed(1)} v ${p.vx.toFixed(1)} a ${p.a.toFixed(2)} air ${p.air.toFixed(2)} fuel ${p.fuel.toFixed(0)} changes ${run.terrain.events.length}`;
});

// ------------------------------------------------------------------ start
ensureAttract(true);
show("title", false);
refreshWallet();
game.start();
canvas.addEventListener("pointerdown", () => sound.unlock(), { once: true });
addEventListener("keydown", () => sound.unlock(), { once: true });
if (params.has("play")) startRun("endless", params.get("biome") || "mesa");

// for the test tools
window.__faultline = { game, world, save, get run() { return run; }, startRun, openGarage, openSelect, show, get screen() { return screen; } };
