import { Game, Camera, TouchControls, Entity, Mesh, InstancedMesh, StandardMaterial, BasicMaterial, ParticleSystem, ShadowMap, PostFX, primitives } from "../engine/index.js";
import { Match, BUTTON, SOLID, WARN, SINKING, GONE, hexCenter } from "./sim.js";
import { Bot } from "./bots.js";
import { Client, Loopback, SocketTransport, Conditions } from "./net.js";
import { PROTOCOL, NAME_MAX } from "./protocol.js";
import { GRID, TILE, PLAYER, SHOVE, COLORS, NAMES, KIND as TILE_KIND, HAUL, MODE_NAMES, MODE_HELP, COSMETICS, XP } from "./data.js";
import { FoamField, waterMaterial, skyMaterial, hexTile, crackGeometry, tuftGeometry } from "./gfx.js";
import { Sound } from "./sound.js";
import { load, store, DEFAULT_KEYS } from "./save.js";
import { Room } from "../server/room.mjs";

/**
 * HEXHAUL: the application. Screens, input, camera and drawing. Three ways to play:
 *   - Practice: a Room runs in this page with bots, joined through the same netcode as online play;
 *   - Online: a Room on the server, by quick play, a new room or a room code;
 *   - Local: two players on one keyboard, the Match stepped directly.
 * Whichever it is, each frame becomes a list of robots and an island, and the drawing reads only that.
 * @module game/main
 */

const $ = (id) => document.getElementById(id);
const save = load();
const sound = new Sound({ music: save.music, sfx: save.sfx, muted: save.muted });
const persist = () => store(save);

// ------------------------------------------------------------------ engine
const canvas = $("view");
const game = new Game({ canvas, quality: "high", camera: new Camera({ mode: "orbit", fov: 42, near: 0.1, far: 300 }) });
if (game.failed) throw new Error("WebGL unavailable");
const { renderer, camera, input, scene } = game;
renderer.postfx = new PostFX(renderer, { bloom: { threshold: 1.2, intensity: 0.35 }, ao: { enabled: true, radius: 0.6, intensity: 0.7 }, exposure: 0.95, saturation: 1.35, contrast: 1.12, vignette: 0.18, grain: 0 });

const sun = [0.45, -0.55, 0.7], sl = Math.hypot(...sun);
scene.sunDirection.set(sun.map((v) => v / sl));
scene.sunColor.set([1.05, 0.95, 0.82]);
scene.skyColor.set([0.3, 0.38, 0.5]);
scene.groundColor.set([0.12, 0.2, 0.24]);
scene.clearColor.set([0.38, 0.66, 0.84, 1]);
scene.fogColor.set([0.42, 0.68, 0.85]); scene.fogDensity = 0.012;
const highShadow = new ShadowMap({ cascades: 2, distance: 45, size: 1536, strength: 0.7 });
scene.shadow = highShadow;

// ------------------------------------------------------------------ input
const KEYS = [
    save.keys,
    { up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight", jump: "ShiftRight", grab: "Period", shove: "Slash" },
];
const bindKeys = () => KEYS.forEach((k, i) => { for (const [a, code] of Object.entries(k)) input.bind(a + i, i === 0 ? [code, "Touch" + a] : [code]); });
bindKeys();
input.bindAxis("touchX", {}); input.bindAxis("touchY", {});
const touch = new TouchControls(input, { visible: "auto" });
touch.joystick({ x: "touchX", y: "touchY" });
touch.button({ code: "Touchjump", label: "Jump", offset: [24, 110] });
touch.button({ code: "Touchgrab", label: "Grab", offset: [110, 40] });
touch.button({ code: "Touchshove", label: "Shove", offset: [24, 24], size: 80 });
/** the i-th gamepad, or null */
const padAt = (i) => (navigator.getGamepads ? navigator.getGamepads()[i] : null) || null;
const pressed = (pad, b) => !!(pad && pad.buttons[b] && pad.buttons[b].pressed);
input.bind("pause", ["Escape"]);
input.bind("debug", ["F3"]);
input.bind("mute", ["KeyM"]);
for (let n = 0; n < 6; n++) input.bind("emote" + n, ["Digit" + (n + 1)]);
/** one player's controls this tick; online and in Practice, either set of keys drives you */
function controlsOf(i, either = false) {
    const down = (a) => input.isDown(a + i) || (either && input.isDown(a + (1 - i)));
    let mx = (down("right") ? 1 : 0) - (down("left") ? 1 : 0), my = (down("up") ? 1 : 0) - (down("down") ? 1 : 0);
    if (i === 0) { mx ||= input.axis("touchX"); my ||= input.axis("touchY"); }
    // a gamepad per local player: A jump, X grab, B or RB shove
    const pad = padAt(i), dead = (v) => (Math.abs(v) < 0.25 ? 0 : v);
    if (pad) {
        mx ||= dead(pad.axes[0] || 0) || (pressed(pad, 15) ? 1 : 0) - (pressed(pad, 14) ? 1 : 0);
        my ||= -dead(pad.axes[1] || 0) || (pressed(pad, 12) ? 1 : 0) - (pressed(pad, 13) ? 1 : 0);
    }
    return { mx, my,
        buttons: (down("jump") || pressed(pad, 0) ? BUTTON.JUMP : 0) | (down("grab") || pressed(pad, 2) ? BUTTON.GRAB : 0) | (down("shove") || pressed(pad, 1) || pressed(pad, 5) ? BUTTON.SHOVE : 0),
    };
}

// ------------------------------------------------------------------ what is being played
/** @type {"title" | "local" | "net"} */
let mode = "title";
/** local play: the match and its bots */
let local = null;
const client = new Client();
/** the Room this page runs (Practice), or null online */
let room = null;
const conditions = { latency: 0, jitter: 0, loss: 0 };
/** a match with nobody in it, sinking slowly behind the title screen */
let idle = makeIdle();

function makeIdle() {
    const m = new Match({ seed: 7, players: [0, 1, 2, 3].map((i) => ({ name: "B" + i, bot: true })) });
    return { match: m, bots: m.players.map((p) => new Bot(p.id, 50 + p.id)) };
}

function startLocal(players) {
    leave();
    const list = Array.from({ length: players }, (_, i) => ({ id: i, name: i < 2 ? `P${i + 1}` : NAMES[i], bot: i >= 2 }));
    const m = new Match({ seed: (Date.now() & 0xffff) + 1, mode: save.mode, players: list });
    local = { match: m, bots: m.players.filter((p) => p.bot).map((p) => new Bot(p.id, 77 + p.id, save.skill)) };
    mode = "local";
    show("play");
}

function startPractice() {
    leave();
    room = new Room({ code: "PRACTICE", bots: save.bots + 1, mode: save.mode, skill: save.skill, seed: (Date.now() & 0xffff) + 1 });
    const link = new Conditions(new Loopback(room), conditions);
    link.settings = conditions;
    client.attach(link);
    link.connect({ name: playerName(), look: myLook() });
    mode = "net";
    show("play");
}

// ------------------------------------------------------------------ online
function serverUrl() {
    const named = new URLSearchParams(location.search).get("server");
    if (named) return named.endsWith("/ws") ? named : named.replace(/[/]$/, "") + "/ws";
    if (!location.host) return "";
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
}
const online = { url: serverUrl(), up: false };

async function probe() {
    const status = $("server-status");
    try {
        const base = online.url.replace(/^ws/, "http").replace(/\/ws$/, "");
        const res = await fetch(base + "/status", { cache: "no-store" });
        const s = await res.json();
        online.up = s.game === "hexhaul" && s.protocol === PROTOCOL;
        status.textContent = online.up ? `Server is up: ${s.players} playing in ${s.rooms} room${s.rooms === 1 ? "" : "s"}.` : "That server runs a different version.";
    } catch { online.up = false; status.textContent = "No server here. Run npm start to play online; Practice and Local work without one."; }
    for (const id of ["quick", "create", "join"]) $(id).disabled = !online.up;
}

/** @param {{ room?: string, create?: object }} how */
function playOnline(how) {
    leave();
    const link = new Conditions(new SocketTransport(online.url), conditions);
    link.settings = conditions;
    client.attach(link);
    let token = "";
    try { const kept = JSON.parse(sessionStorage.getItem("hexhaul-seat") || "null"); if (kept && kept.room === how.room) token = kept.token; } catch { /* none */ }
    link.connect({ name: playerName(), look: myLook(), token, ...how });
    mode = "net";
    show("play");
}

client.on("welcome", (m) => {
    try { sessionStorage.setItem("hexhaul-seat", JSON.stringify({ room: m.room.code, token: m.token })); } catch { /* storage unavailable */ }
    if (m.room.code !== "PRACTICE") history.replaceState(null, "", "?room=" + m.room.code);
});
client.on("close", (reason) => {
    if (mode !== "net") return;
    const code = client.room && client.room.code;
    leave();
    show("title");
    $("server-status").textContent = reason + (code && code !== "PRACTICE" ? ` You can rejoin room ${code} for ${30} seconds.` : "");
    if (code && code !== "PRACTICE") $("code").value = code;
});
client.on("event", (e) => {
    effects(e);
    if (e.type === "over" || e.type === "match") earn(e, client.id, client.players.get(client.id)?.team);
});

function leave() {
    client.detach();
    room = null; local = null;
    mode = "title";
    for (const r of robots.values()) { r.root.visible = false; r.tag.hidden = true; }
}
function playerName() { return save.name || "Player"; }
function myLook() { return { hat: save.hat, paint: save.paintId }; }

// ------------------------------------------------------------------ screens
let screen = "title";
function show(name) {
    screen = name;
    $("title").hidden = name !== "title";
    $("pause").hidden = name !== "pause";
    $("lobby").hidden = name !== "lobby";
    $("settings").hidden = name !== "settings";
    touch.root.style.display = name === "play" ? "" : "none";
    $("touch-menu").hidden = !(name === "play" && touch.visible);
    $("hud").hidden = name === "title" || name === "lobby" || name === "settings";
    const first = document.querySelector(`#${name} button:not(:disabled), #${name} input, #${name} select`);
    if (name !== "play" && first && document.activeElement?.closest?.(".screen")?.id !== name) first.focus({ preventScroll: true });
    if (name === "title") { history.replaceState(null, "", location.pathname); idle = makeIdle(); probe(); }
    if (name === "pause") {
        const code = client.room && client.room.code;
        $("room-line").hidden = mode !== "net" || !code || code === "PRACTICE";
        $("room-code").textContent = code || "";
        $("host").hidden = mode !== "net" || client.id !== client.hostId;
        $("h-mode").value = client.match.mode;
        if (client.room && client.room.skill) $("h-skill").value = client.room.skill;
        $("resume").focus();
    }
    if (name === "play") canvas.focus();
}

// ------------------------------------------------------------------ the lobby
client.on("roster", () => {
    if (mode !== "net") return;
    if (client.state === "lobby" && screen !== "lobby" && client.room) show("lobby");
    else if (client.state === "game" && screen === "lobby") show("play");
    if (screen === "lobby") drawLobby();
});
function drawLobby() {
    const s = client.settings, host = client.id === client.hostId;
    $("lobby-code").textContent = client.room ? client.room.code : "";
    $("lobby-mode").textContent = MODE_NAMES[s.mode] || "";
    $("lobby-help").textContent = MODE_HELP[s.mode] || "";
    const rgb = (slot) => `rgb(${COLORS[slot % COLORS.length].map((v) => Math.round(v * 255))})`;
    $("lobby-players").innerHTML = [...client.players.values()].map((p) => {
        const state = p.bot ? "Bot" : p.away ? "Away" : p.ready ? "Ready" : "Not ready";
        return `<li style="--c:${rgb(p.slot ?? 0)}"><span>${escape(p.name)}${p.id === client.id ? " (you)" : ""}${p.id === client.hostId ? " · host" : ""}</span><span class="state${p.ready && !p.bot ? " ready" : ""}">${state}</span></li>`;
    }).join("");
    const me = client.players.get(client.id);
    $("lobby-ready").textContent = me && me.ready ? "Not ready" : "Ready";
    $("lobby-status").textContent = client.countdown ? `Starting in ${client.countdown}…` : client.players.size < 2 ? "Waiting for someone to play against. Add bots, or share the code." : s.open ? "Open room: starts by itself soon, or when everyone is ready." : "Starts when everyone is ready.";
    $("lobby-start").hidden = !host;
    $("lobby-start").disabled = client.players.size < 2;
    $("lobby-host").hidden = !host;
    $("l-mode").value = s.mode; $("l-skill").value = s.skill; $("l-bots").value = String(s.bots);
    $("lobby-result").innerHTML = client.result ? `<h2>Last match</h2>${table(client.result.map((r) => ({ ...r, color: rgb(r.slot) })))}` : "";
}
/** @param {Array<{ name: string, color: string, wins: number, hits: number, tiles: number, hauled: number, falls: number }>} rows */
function table(rows) {
    return `<table class="scores"><thead><tr><th>Robot</th><th>Wins</th><th>Hits</th><th>Tiles put down</th><th>Hauled</th><th>Falls</th></tr></thead><tbody>`
        + rows.map((r) => `<tr><td style="--c:${r.color}">${escape(r.name)}</td><td>${r.wins}</td><td>${r.hits}</td><td>${r.tiles}</td><td>${r.hauled}</td><td>${r.falls}</td></tr>`).join("") + "</tbody></table>";
}
$("lobby-ready").onclick = () => { const me = client.players.get(client.id); client.send({ t: "ready", on: !(me && me.ready) }); };
$("lobby-start").onclick = () => client.send({ t: "start" });
$("lobby-leave").onclick = () => { leave(); show("title"); };
$("lobby-invite").onclick = () => { const url = location.origin + location.pathname + "?room=" + client.room.code; navigator.clipboard?.writeText(url); $("lobby-invite").textContent = "Copied"; setTimeout(() => ($("lobby-invite").textContent = "Copy invite link"), 1500); };
for (const [id, key] of [["l-mode", "mode"], ["l-skill", "skill"]]) $(id).onchange = () => client.send({ t: "setup", [key]: $(id).value });
$("l-bots").onchange = () => client.send({ t: "setup", bots: Number($("l-bots").value) });

// ------------------------------------------------------------------ looks and what unlocks them
function drawLooks() {
    $("xp-line").textContent = `${save.xp} XP. Playing earns looks: they never change how a robot performs.`;
    const fill = (id, list, value) => {
        $(id).innerHTML = list.map((o) => `<option value="${o.id}"${o.xp > save.xp ? " disabled" : ""}>${o.name}${o.xp > save.xp ? ` (${o.xp} XP)` : ""}</option>`).join("");
        $(id).value = String(value);
    };
    fill("look-hat", COSMETICS.hats, save.hat);
    fill("look-paint", COSMETICS.paints, save.paintId);
}
$("look-hat").onchange = () => { save.hat = Number($("look-hat").value); persist(); };
$("look-paint").onchange = () => { save.paintId = Number($("look-paint").value); persist(); };
drawLooks();
let toastTimer = 0;
function toast(text) { $("toast").textContent = text; $("toast").hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $("toast").hidden = true; }, 3500); }
/** a round finished: what it earned me */
function earn(e, meId, myTeam) {
    if (mode === "title") return;
    const won = e.team >= 0 ? e.team === myTeam : e.winner === meId;
    const before = save.xp;
    save.xp += XP.round + (won ? XP.roundWin : 0) + (won && e.type === "match" ? XP.matchWin : 0);
    persist();
    const fresh = [...COSMETICS.hats, ...COSMETICS.paints, ...COSMETICS.emotes.map((o) => ({ ...o, name: "Emote " + o.text }))].filter((o) => o.xp > before && o.xp <= save.xp);
    if (fresh.length) toast("New: " + fresh.map((o) => o.name).join(", "));
    drawLooks();
}
/** press 1-6 */
function emote(n) {
    if (COSMETICS.emotes[n].xp > save.xp) return toast(`That emote unlocks at ${COSMETICS.emotes[n].xp} XP`);
    if (mode === "net") client.send({ t: "emote", n });
    else if (mode === "local") effects({ type: "emote", id: 0, n });
}
let boardHeld = false;
addEventListener("keydown", (e) => { if (e.code === "Tab" && screen === "play") { e.preventDefault(); boardHeld = true; } });
addEventListener("keyup", (e) => { if (e.code === "Tab") boardHeld = false; });
addEventListener("blur", () => { boardHeld = false; });

// ------------------------------------------------------------------ settings
let settingsFrom = "title";
const openSettings = () => { settingsFrom = screen; show("settings"); };
$("title-settings").onclick = openSettings;
$("pause-settings").onclick = openSettings;
$("settings-back").onclick = () => show(settingsFrom);
$("touch-menu").onclick = () => show("pause");
function applyMotion() { game.juice.reducedMotion = save.motion === "on" || (save.motion === "auto" && !!matchMedia?.("(prefers-reduced-motion: reduce)").matches); }
function applyText() { document.documentElement.style.setProperty("--ui", String(save.textSize)); $("set-text-out").textContent = Math.round(save.textSize * 100) + "%"; }
$("set-quality").value = save.quality; $("set-motion").value = save.motion; $("set-text").value = String(save.textSize * 100);
$("set-captions").checked = save.captions; $("set-contrast").checked = save.contrast;
$("set-quality").onchange = () => { save.quality = $("set-quality").value; persist(); applyQuality(save.quality === "auto" ? "high" : save.quality); };
$("set-motion").onchange = () => { save.motion = $("set-motion").value; persist(); applyMotion(); };
$("set-text").oninput = () => { save.textSize = Number($("set-text").value) / 100; persist(); applyText(); };
$("set-captions").onchange = () => { save.captions = $("set-captions").checked; persist(); };
$("set-contrast").onchange = () => { save.contrast = $("set-contrast").checked; persist(); };
applyText();

// keys: choose an action, press a key. A key already used by another action swaps with it, so none is lost.
const KEY_NAMES = { up: "Up", down: "Down", left: "Left", right: "Right", jump: "Jump", grab: "Grab / place", shove: "Shove / throw" };
let listening = null;
function drawKeys() {
    $("key-list").innerHTML = Object.keys(KEY_NAMES).map((a) => `<button data-action="${a}"${listening === a ? ' class="listening"' : ""}><span>${KEY_NAMES[a]}</span><b>${listening === a ? "Press a key" : save.keys[a].replace(/^Key|^Digit/, "")}</b></button>`).join("");
}
$("key-list").onclick = (e) => { const b = e.target.closest("button"); if (b) { listening = b.dataset.action; drawKeys(); } };
addEventListener("keydown", (e) => {
    if (!listening) return;
    e.preventDefault(); e.stopPropagation();
    if (e.code !== "Escape") {
        const other = Object.keys(save.keys).find((a) => save.keys[a] === e.code);
        if (other) save.keys[other] = save.keys[listening];
        save.keys[listening] = e.code;
        KEYS[0] = save.keys; bindKeys(); persist();
    }
    const was = listening; listening = null; drawKeys();
    $("key-list").querySelector(`[data-action="${was}"]`).focus();
}, true);
$("keys-reset").onclick = () => { Object.assign(save.keys, DEFAULT_KEYS); bindKeys(); persist(); drawKeys(); };
drawKeys();

/** menus by gamepad: up and down move the focus, A presses, B backs out */
let padHeld = 0;
function menuPad() {
    const pad = padAt(0);
    if (!pad) return;
    const now = (pressed(pad, 12) ? 1 : 0) | (pressed(pad, 13) ? 2 : 0) | (pressed(pad, 0) ? 4 : 0) | (pressed(pad, 1) ? 8 : 0) | (pressed(pad, 9) ? 16 : 0);
    const hit = now & ~padHeld;
    padHeld = now;
    if (hit & 16) { if (screen === "play") show("pause"); else if (screen === "pause") show("play"); return; }
    if (screen === "play" || !hit) return;
    const list = [...document.querySelectorAll(`#${screen} button:not(:disabled):not([hidden]), #${screen} input, #${screen} select`)].filter((el) => el.offsetParent);
    const i = list.indexOf(document.activeElement);
    if (hit & 1) list[(i - 1 + list.length) % list.length]?.focus();
    if (hit & 2) list[(i + 1) % list.length]?.focus();
    if (hit & 4) document.activeElement?.click?.();
    if (hit & 8) { if (screen === "pause") show("play"); else if (screen === "settings") show(settingsFrom); }
}

// ------------------------------------------------------------------ graphics tiers
let tier = "high", foamEvery = 1, frameNo = 0;
function applyQuality(name) {
    tier = name;
    const fx = renderer.postfx.settings;
    renderer.setQuality(name === "high" ? "high" : name);
    fx.ao.enabled = name === "high";
    fx.bloom.enabled = name !== "low";
    scene.shadow = name === "low" ? null : name === "medium" ? (mediumShadow ||= new ShadowMap({ cascades: 1, distance: 40, size: 1024, strength: 0.7 })) : highShadow;
    foamEvery = name === "high" ? 1 : name === "medium" ? 2 : 4;
}
let mediumShadow = null;
// Automatic starts high and steps down if a few seconds of play run under 45 frames a second. Never back up,
// so it can't flip between tiers; a tab in the background doesn't count.
let slowFor = 0;
function autoQuality(dt) {
    if (save.quality !== "auto" || tier === "low" || document.hidden || screen !== "play") return;
    slowFor = game.loop.fps < 45 ? slowFor + dt : 0;
    if (slowFor > 4) { slowFor = 0; applyQuality(tier === "high" ? "medium" : "low"); }
}
applyQuality(save.quality === "auto" ? "high" : save.quality);

/** Short text for what the ears would have told you. */
function caption(text) {
    if (!save.captions || screen !== "play") return;
    const el = document.createElement("div");
    el.textContent = text;
    $("captions").append(el);
    while ($("captions").children.length > 4) $("captions").firstChild.remove();
    setTimeout(() => el.remove(), 2200);
}
const sideOf = (x) => (x === undefined ? "" : x < look.x - 4 ? " (left)" : x > look.x + 4 ? " (right)" : "");

// First game: one thing at a time, each gone as soon as it's been done.
const LESSONS = [
    { text: () => `Move with ${keyName("up")} ${keyName("left")} ${keyName("down")} ${keyName("right")}`, done: (c) => c.mx || c.my },
    { text: () => `${keyName("grab")}: pull up a tile`, done: (c, me) => me && me.carry },
    { text: () => `${keyName("grab")} again: put it down. It bridges gaps`, done: (c, me) => me && !me.carry },
    { text: () => `Hold and release ${keyName("shove")} to shove someone in. Last robot above water wins`, done: (c) => c.buttons & BUTTON.SHOVE },
];
const keyName = (a) => (touch.visible ? { jump: "Jump", grab: "Grab", shove: "Shove" }[a] || "the stick" : save.keys[a].replace(/^Key/, ""));
let lesson = 0;
function teach(controls, me) {
    if (save.tutorialDone) return;
    const l = LESSONS[lesson];
    if (l.done(controls, me) && ++lesson >= LESSONS.length) { save.tutorialDone = true; persist(); $("tutorial").hidden = true; return; }
    $("tutorial").hidden = false;
    $("tutorial").textContent = LESSONS[lesson].text();
}

// ------------------------------------------------------------------ sound settings
// browsers only allow sound after a gesture
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => sound.unlock());
addEventListener("click", (e) => { if (e.target.closest && e.target.closest("button")) sound.play("ui"); });
for (const key of ["music", "sfx"]) {
    const el = $("vol-" + key), out = $(`vol-${key}-out`);
    el.value = String(Math.round((save[key] ?? sound.settings[key]) * 100));
    out.textContent = el.value + "%";
    el.addEventListener("input", () => { const v = Number(el.value) / 100; out.textContent = el.value + "%"; sound.set(key, v); save[key] = v; persist(); });
}
const setMute = (on) => { sound.set("muted", on); save.muted = on; $("vol-mute").checked = on; persist(); };
$("vol-mute").checked = sound.settings.muted;
$("vol-mute").addEventListener("change", () => setMute($("vol-mute").checked));

$("name").value = save.name;
$("name").maxLength = NAME_MAX;
$("name").addEventListener("change", () => { save.name = $("name").value.trim().slice(0, NAME_MAX); persist(); });
const modeHelp = () => { $("mode-help").textContent = MODE_HELP[save.mode]; };
modeHelp();
$("mode").value = save.mode;
$("mode").addEventListener("change", () => { save.mode = $("mode").value; persist(); modeHelp(); });
$("skill").value = save.skill;
$("skill").addEventListener("change", () => { save.skill = $("skill").value; persist(); });
$("p-bots").value = String(save.bots);
$("p-bots").addEventListener("change", () => { save.bots = Number($("p-bots").value); persist(); });
$("practice").onclick = startPractice;
$("local").onclick = () => startLocal(Number($("l-players").value));
$("quick").onclick = () => playOnline({});
$("create").onclick = () => playOnline({ create: { bots: save.bots + 1, mode: save.mode, skill: save.skill, open: $("c-open").checked } });
$("join-form").onsubmit = (e) => { e.preventDefault(); const code = $("code").value.trim().toUpperCase(); if (code) playOnline({ room: code }); };
$("resume").onclick = () => show("play");
$("leave").onclick = () => { leave(); show("title"); };
$("invite").onclick = () => { const url = location.origin + location.pathname + "?room=" + client.room.code; navigator.clipboard?.writeText(url); $("invite").textContent = "Copied"; setTimeout(() => ($("invite").textContent = "Copy invite link"), 1500); };
$("host-apply").onclick = () => client.send({ t: "setup", bots: Number($("h-bots").value), mode: $("h-mode").value, skill: $("h-skill").value });
for (const k of ["latency", "jitter", "loss"]) {
    const el = $("net-" + k), out = $(`net-${k}-out`);
    const update = () => { conditions[k] = k === "loss" ? Number(el.value) / 100 : Number(el.value); out.textContent = el.value + (k === "loss" ? "%" : " ms"); };
    el.addEventListener("input", update); update();
}

// ------------------------------------------------------------------ scene
const TILE_COUNT = idle.match.tiles.length;
const TILE_R = GRID.size - GRID.gap;
/** the art direction's tile palette: sand, grass, stone */
const KIND = [[0.95, 0.83, 0.54], [0.49, 0.81, 0.35], [0.66, 0.64, 0.6]];
/** special tiles: each a colour of its own and a mark on top, so colour is never the only cue */
const SPECIAL_COLOR = { [TILE_KIND.BOUNCY]: [0.95, 0.42, 0.62], [TILE_KIND.HEAVY]: [0.3, 0.31, 0.38], [TILE_KIND.ICE]: [0.68, 0.92, 1], [TILE_KIND.BOMB]: [0.24, 0.13, 0.13] };
const tileColor = (kind) => SPECIAL_COLOR[kind] || KIND[0];
/** each tile's kind, from where it sits: grass in the middle, a sandy shore, stone outcrops here and there */
const kinds = idle.match.tiles.map((t) => {
    const h = Math.abs(Math.sin(t.q * 12.9898 + t.r * 78.233) * 43758.5453) % 1;
    if (t.ring > GRID.island) return 0;
    if (t.ring <= 2 || (t.ring <= 4 && h < 0.35)) return 1;
    return h < 0.18 ? 2 : 0;
});
const tileMesh = new InstancedMesh(hexTile(TILE_R, 0.55), new StandardMaterial({ vertexColors: true, specular: 0.08 }), TILE_COUNT);
scene.add(new Entity({ name: "tiles", mesh: tileMesh, frustumCulled: false }));
const crackMesh = new InstancedMesh(crackGeometry(TILE_R), new BasicMaterial({ color: [0.18, 0.1, 0.06], lit: false, transparent: true, depthWrite: false, cull: "none" }), TILE_COUNT);
scene.add(new Entity({ name: "cracks", mesh: crackMesh, frustumCulled: false, castShadow: false }));
/** grass tufts on grass tiles, up to three each, placed by hash */
const TUFTS = 3;
const tuftMesh = new InstancedMesh(tuftGeometry(), new StandardMaterial({ vertexColors: true, cull: "none" }), TILE_COUNT * TUFTS);
scene.add(new Entity({ name: "tufts", mesh: tuftMesh, frustumCulled: false, castShadow: false }));
const tuftAt = idle.match.tiles.map((t, i) => Array.from({ length: TUFTS }, (_, k) => {
    const h = (n) => Math.abs(Math.sin(i * 91.7 + k * 17.3 + n * 5.1) * 9999) % 1;
    const a = h(1) * Math.PI * 2, d = 0.2 + h(2) * 0.45;
    return { x: Math.cos(a) * d, y: Math.sin(a) * d, s: 0.8 + h(3) * 0.6, yaw: h(4) * 6.28, on: h(5) < 0.75 };
}));

/** kind -> an instanced mark on the tile's top */
const marks = new Map([
    [TILE_KIND.BOUNCY, { geo: primitives.torus(0.34, 0.09, 8, 24), color: [1, 0.85, 0.92], z: 0.06 }],
    [TILE_KIND.HEAVY, { geo: primitives.box(0.5, 0.5, 0.14), color: [0.55, 0.56, 0.62], z: 0.07 }],
    [TILE_KIND.ICE, { geo: primitives.cone(0.13, 0.3, 6), color: [0.92, 1, 1], z: 0.1 }],
    [TILE_KIND.BOMB, { geo: primitives.sphere(0.26, 14, 10), color: [0.1, 0.08, 0.09], z: 0.2 }],
]);
for (const [kind, k] of marks) {
    k.mesh = new InstancedMesh(k.geo, new StandardMaterial({ specular: 0.3 }), TILE_COUNT);
    scene.add(new Entity({ name: "mark" + kind, mesh: k.mesh, frustumCulled: false }));
    for (let i = 0; i < TILE_COUNT; i++) k.mesh.setTransform(i, 0, 0, -50, 0.001);
}
// the two goals in Haul, and the buoys and things in the air
const TEAM = [[0.95, 0.5, 0.06], [0.34, 0.71, 0.91]];
const goalEntities = HAUL.goals.map(([q, r], i) => {
    const [x, y] = hexCenter(q, r);
    const e = new Entity({ name: "goal" + i, castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.torus(1.25, 0.09, 8, 6), new BasicMaterial({ color: TEAM[i], lit: false })) });
    e.setPosition(x, y, 0.22);
    return scene.add(e);
});
const SHOTS = 16;
const shotTiles = new InstancedMesh(hexTile(GRID.size * 0.62, 0.3, 0.06), new StandardMaterial({ vertexColors: true, specular: 0.08 }), SHOTS);
scene.add(new Entity({ name: "flying tiles", mesh: shotTiles, frustumCulled: false }));
const buoys = new InstancedMesh(primitives.torus(0.42, 0.17, 10, 20), new StandardMaterial({ specular: 0.4 }), SHOTS);
scene.add(new Entity({ name: "buoys", mesh: buoys, frustumCulled: false }));

const foam = new FoamField(16, 128);
const water = new Entity({ name: "water", castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.plane(160, 160, 160, 160), waterMaterial(foam)) });
water.setPosition(0, 0, PLAYER.waterZ + 0.25);
scene.add(water);
// the open sea beyond: same surface, coarse, lower so the two never fight where they overlap
const farSea = new Entity({ name: "far sea", castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.plane(500, 500, 50, 50), water.mesh.material) });
farSea.setPosition(0, 0, PLAYER.waterZ - 0.1);
scene.add(farSea);
const seabed = new Entity({ name: "seabed", castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.plane(400, 400), new BasicMaterial({ color: [0.05, 0.3, 0.45] })) });
seabed.setPosition(0, 0, -3);
scene.add(seabed);
scene.add(new Entity({ name: "sky", castShadow: false, frustumCulled: false, mesh: new Mesh(primitives.sphere(260, 24, 16), skyMaterial()) }));
const foamHexes = [];
/** which instances of each mark are in use, to put away next frame */
const shown = Object.fromEntries([...marks.keys()].map((k) => [k, new Set()]));

// robots: a chunky courier with a visor, an antenna, a backpack and stubby feet; a dark outline (an
// inside-out shell) keeps each one readable against any tile, and a hat tells colours apart a second way
const bodyGeo = primitives.capsule(PLAYER.radius, 0.28, 8, 20);
const headGeo = primitives.sphere(0.27, 20, 14);
const visorGeo = primitives.box(0.12, 0.36, 0.17);
const eyeGeo = primitives.sphere(0.05, 8, 6);
const footGeo = primitives.sphere(0.13, 10, 8);
const packGeo = primitives.box(0.22, 0.42, 0.4);
const stalkGeo = primitives.cylinder(0.018, 0.018, 0.22, 6);
const bulbGeo = primitives.sphere(0.065, 10, 8);
const carryGeo = hexTile(GRID.size * 0.62, 0.3, 0.06);
const ringGeo = primitives.torus(0.55, 0.05, 6, 32);
const stripeGeo = primitives.torus(PLAYER.radius + 0.005, 0.045, 8, 28);
const HATS = [
    [[primitives.cylinder(0.2, 0.22, 0.24, 18), 0, 0, 0.27]],                                                       // top hat
    [[primitives.cone(0.2, 0.3, 16), 0, 0, 0.3]],                                                                  // party cone
    [[primitives.cylinder(0.24, 0.24, 0.05, 18), 0.06, 0, 0.21], [primitives.sphere(0.2, 14, 8), 0, 0, 0.2]],    // cap
    [[primitives.torus(0.14, 0.04, 6, 16), 0, 0, 0.3]],                                                            // halo
    [[primitives.cylinder(0.23, 0.17, 0.16, 6), 0, 0, 0.27], [primitives.sphere(0.04, 8, 6), 0, 0, 0.38]],         // crown
    [[primitives.cone(0.07, 0.24, 10), 0, 0.15, 0.29], [primitives.cone(0.07, 0.24, 10), 0, -0.15, 0.29]],        // horns
];
const ink = new BasicMaterial({ color: [0.08, 0.07, 0.1], lit: false, cull: "front" });
const dark = new StandardMaterial({ color: [0.12, 0.13, 0.17], specular: 0.6, shininess: 60 });
const metal = new StandardMaterial({ color: [0.82, 0.84, 0.88], specular: 0.5, shininess: 40 });
const eyeMat = new StandardMaterial({ color: [0.7, 1, 1], emissive: [0.9, 2.2, 2.4] });
/** id -> robot drawing; colours go by order of arrival in the room */
const robots = new Map();
/** drawn a little bigger than the collision radius: they are the stars, and must read from the game camera */
const ROBOT_SCALE = 1.2;
function part(parent, geo, mat, x, y, z, shadow = true) {
    const e = new Entity({ mesh: new Mesh(geo, mat), castShadow: shadow });
    e.setPosition(x, y, z);
    parent.add(e);
    return e;
}
function robot(id, slot, hatId = -1, paintId = 0) {
    let r = robots.get(id);
    if (r && r.slot === slot && r.hatId === hatId && r.paintId === paintId) return r;
    if (r) { scene.remove(r.root); r.tag.remove(); robots.delete(id); }
    const c = COLORS[slot % COLORS.length];
    const paint = new StandardMaterial({ color: c, specular: 0.45, shininess: 30, rim: [0.25, 0.25, 0.3] });
    const root = scene.add(new Entity({ name: "robot" + id }));
    root.setScale(ROBOT_SCALE);
    const lift = new Entity(); root.add(lift);            // squash and bob move this; the feet stay put
    const bodyZ = PLAYER.radius + 0.2;
    const body = part(lift, bodyGeo, paint, 0, 0, bodyZ);
    part(body, bodyGeo, ink, 0, 0, 0, false).setScale(1.1, 1.1, 1.07);
    const head = part(lift, headGeo, metal, 0.02, 0, bodyZ + 0.66);
    part(head, headGeo, ink, 0, 0, 0, false).setScale(1.12);
    part(head, visorGeo, dark, 0.19, 0, 0.03);
    part(head, eyeGeo, eyeMat, 0.27, 0.08, 0.03, false); part(head, eyeGeo, eyeMat, 0.27, -0.08, 0.03, false);
    part(head, stalkGeo, metal, -0.04, 0, 0.33);
    part(head, bulbGeo, paint, -0.04, 0, 0.46);
    part(lift, packGeo, metal, -PLAYER.radius - 0.02, 0, bodyZ + 0.08);
    const hat = new Entity(); head.add(hat);
    for (const [g, x, y, z] of HATS[hatId >= 0 ? hatId : Math.floor(slot / 2) % 4]) part(hat, g, paint, x, y, z);
    const stripe = COSMETICS.paints.find((o) => o.id === paintId)?.color;
    if (stripe) part(body, stripeGeo, new StandardMaterial({ color: stripe, specular: 0.5 }), 0, 0, 0.02, false);
    const feet = [part(root, footGeo, dark, 0.05, 0.19, 0.1), part(root, footGeo, dark, 0.05, -0.19, 0.1)];
    const carry = part(lift, carryGeo, new StandardMaterial({ vertexColors: true, specular: 0.08, color: [...KIND[0]] }), 0, 0, bodyZ + 1.25);
    const ring = new Entity({ castShadow: false, mesh: new Mesh(ringGeo, new BasicMaterial({ color: c, lit: false })) });
    ring.setPosition(0, 0, 0.05);
    root.add(ring);
    const tag = document.createElement("div");
    tag.className = "tag";
    tag.style.setProperty("--c", `rgb(${c.map((v) => Math.round(v * 255))})`);
    $("tags").append(tag);
    r = { id, slot, hatId, paintId, emote: "", emoteFor: 0, paint, flash: 0, stretch: 0, puff: 0, sparkle: 0, root, lift, body, head, feet, carry, ring, tag, name: "", color: c, squash: 0, seen: 0, walk: 0, lx: 0, ly: 0 };
    robots.set(id, r);
    return r;
}

const particles = (o) => { const s = scene.add(new ParticleSystem(o)); s.castShadow = false; s.frustumCulled = false; return s; };
const splash = particles({ capacity: 800, gravity: [0, 0, -12], drag: 0.8, blending: "normal", name: "splash" });
const dust = particles({ capacity: 600, gravity: [0, 0, -3], drag: 3, blending: "normal", name: "dust" });

/** a quick burst of sparks flying out flat from a blow */
function ring(x, y, z, k) { dust.emit(Math.round(10 * k), { position: [x, y, z], speed: 7 * k, life: [0.12, 0.25], size: [0.14, 0.01], color: [1, 1, 0.85, 1] }); }
function confettiAt(x, y, z) {
    if (game.juice.reducedMotion) return;
    COLORS.slice(0, 6).forEach((c) => splash.emit(14, { position: [x, y, z + 0.6], velocity: [0, 0, 7], speed: 3.5, spread: 0.7, life: [0.8, 1.4], size: [0.13, 0.08], color: [...c, 1] }));
}
/** what each thing sounds like */
function audible(e) {
    const r = robots.get(e.id), pos = r ? r.root.position : null, x = e.x ?? (pos ? pos[0] : undefined), y = e.y ?? (pos ? pos[1] : undefined);
    const me = mode === "net" ? e.id === client.id : e.id === 0 || e.id === 1;
    switch (e.type) {
        case "jump": sound.play("jump", x, y, { volume: me ? 1 : 0.5 }); break;
        case "land": sound.play("land", x, y, { volume: Math.min(1, e.v / 10) }); break;
        case "grab": sound.play("grab", x, y); break;
        case "place": sound.play("thunk", x, y); break;
        case "shove": if (!e.hit) sound.play("whiff", x, y, { volume: me ? 1 : 0.5, pitch: 1 + e.power * 0.3 }); break;
        case "hit":
            sound.play("hit", e.x, e.y, { pitch: 1.1 - e.power * 0.3, volume: 0.7 + e.power * 0.3 });
            sound.play("clank", e.x, e.y, { volume: 0.5 + e.power * 0.5 });
            sound.voice(e.target, "hit", e.x, e.y);
            sound.dip(-4, 0.1);
            break;
        case "throw": sound.play(e.buoy ? "buoy" : "throw", x, y); break;
        case "splash": sound.play(e.id === -1 ? "plop" : "splash", x, y); if (me) caption("You're in the water"); break;
        case "climb": sound.play("climb", x, y, { volume: me ? 1 : 0.5 }); break;
        case "sink": sound.play("sink", x, y, { gap: 0.1 }); break;
        case "wave": sound.play("crack", 0, 0, { volume: 0.7, gap: 0.2 }); break;
        case "bomb": sound.play("bomb", x, y); sound.dip(-10, 0.3); caption("Bomb" + sideOf(x)); break;
        case "bounce": sound.play("bounce", x, y); break;
        case "haul": sound.play("haul", x, y, { pitch: 1 + Math.random() * 0.1 }); caption("Tile home" + sideOf(x)); break;
        case "out": sound.play("out", x, y); sound.voice(e.id, "out", x, y); caption(`${view.find((v) => v.id === e.id)?.name || "Someone"} is out`); break;
        case "emote": sound.voice(e.id, "emote", x, y); break;
        case "stormWarn": sound.play("warn"); sound.dip(-6, 0.8); break;
        case "stormHit": if (e.kind === "wave") sound.play("wave"); else if (e.kind === "wind") sound.play("wind"); else sound.play("warn", undefined, undefined, { pitch: 1.3 }); break;
        case "round": sound.play("ready"); break;
        case "go": sound.play("go"); break;
        case "over": case "match": {
            const won = mode === "net" ? (e.team >= 0 ? e.team === client.players.get(client.id)?.team : e.winner === client.id) : e.winner === 0 || e.winner === 1;
            sound.play(won ? "win" : "lose");
            sound.dip(-10, 1);
            if (e.winner >= 0) sound.voice(e.winner, "win");
            break;
        }
    }
}

// ------------------------------------------------------------------ effects from what the match did
/** Am I in this? Online, the screen only stops and shakes hard for what happens to you. */
const mine = (...ids) => mode !== "net" || ids.includes(client.id);
function effects(e) {
    const j = game.juice, r = (id) => robots.get(id);
    audible(e);
    switch (e.type) {
        case "hit":
            j.shake(mine(e.id, e.target) ? 0.25 + e.power * 0.4 : 0.08);
            if (mine(e.id, e.target)) j.freeze(40 + e.power * 70);
            if (r(e.target)) r(e.target).flash = 1;
            ring(e.x, e.y, e.z + 0.6, 0.6 + e.power);
            dust.emit(14 + e.power * 20, { position: [e.x, e.y, e.z + 0.6], speed: 4 + e.power * 4, life: [0.25, 0.5], size: [0.22, 0.02], color: [1, 0.95, 0.7, 1] });
            if (r(e.target)) r(e.target).squash = 1;
            break;
        case "splash":
            j.shake(0.12);
            splash.emit(26, { position: [e.x, e.y, PLAYER.waterZ + 0.3], speed: 3.2, flat: true, life: [0.35, 0.7], size: [0.16, 0.03], color: [0.95, 0.99, 1, 0.9] });
            splash.emit(40, { position: [e.x, e.y, PLAYER.waterZ + 0.3], velocity: [0, 0, 4], speed: 3, spread: 0.3, life: [0.5, 1], size: [0.18, 0.05], color: [0.85, 0.95, 1, 0.9] });
            break;
        case "sink":
            splash.emit(16, { position: [e.x, e.y, PLAYER.waterZ + 0.3], velocity: [0, 0, 1.5], speed: 2, spread: 0.6, flat: true, life: [0.4, 0.8], size: [0.15, 0.05], color: [0.9, 0.97, 1, 0.8] });
            break;
        case "grab": case "place":
            dust.emit(10, { position: [e.x, e.y, 0.3], speed: 2.5, flat: true, life: [0.2, 0.45], size: [0.2, 0.04], color: [0.95, 0.85, 0.6, 1] });
            if (r(e.id)) r(e.id).squash = 0.6;
            break;
        case "land":
            if (r(e.id)) { const q = r(e.id); q.squash = Math.min(1, e.v / 10); dust.emit(8, { position: [q.root.position[0], q.root.position[1], 0.1], speed: 2.2, flat: true, life: [0.2, 0.4], size: [0.17, 0.03], color: [0.95, 0.9, 0.75, 0.9] }); }
            break;
        case "jump": if (r(e.id)) r(e.id).stretch = 1; break;
        case "go": confettiAt(0, 0, 0); break;
        case "over": case "match":
            if (r(e.winner)) { const q = r(e.winner).root.position; confettiAt(q[0], q[1], q[2] + 1.2); }
            break;
        case "throw": if (r(e.id)) r(e.id).squash = 0.5; break;
        case "out": j.shake(0.3); break;
        case "emote": if (r(e.id)) { r(e.id).emote = COSMETICS.emotes[e.n].text; r(e.id).emoteFor = 2; } break;
        case "bomb":
            j.shake(0.7); j.freeze(70);
            dust.emit(60, { position: [e.x, e.y, 0.5], speed: 9, life: [0.3, 0.8], size: [0.35, 0.03], color: [1, 0.6, 0.2, 1] });
            splash.emit(50, { position: [e.x, e.y, 0], velocity: [0, 0, 6], speed: 4, spread: 0.5, life: [0.5, 1], size: [0.2, 0.05], color: [0.9, 0.97, 1, 0.9] });
            break;
        case "bounce":
            dust.emit(14, { position: [e.x, e.y, 0.1], speed: 3, flat: true, life: [0.2, 0.4], size: [0.2, 0.03], color: [1, 0.7, 0.85, 1] });
            if (r(e.id)) r(e.id).squash = 1;
            break;
        case "haul":
            dust.emit(40, { position: [e.x, e.y, 0.6], velocity: [0, 0, 5], speed: 3, life: [0.4, 0.9], size: [0.22, 0.03], color: [...TEAM[e.team], 1] });
            break;
        case "stormHit": j.shake(e.kind === "wave" ? 0.6 : 0.25); break;
    }
}

// ------------------------------------------------------------------ loop
game.onUpdate(() => {
    if (input.wasPressed("pause")) { if (screen === "play") show("pause"); else if (screen === "pause") show("play"); }
    if (input.wasPressed("debug")) $("debug").hidden = !$("debug").hidden;
    menuPad();
    if (input.wasPressed("mute")) setMute(!sound.settings.muted);
    const playing = screen === "play";
    if (screen === "play" || screen === "pause") {
        for (let n = 0; n < 6; n++) if (input.wasPressed("emote" + n)) emote(n);
    }
    if (mode === "title" || mode === "net" && client.state === "lobby") {
        if (shot) return;
        for (const b of idle.bots) b.think(idle.match);
        idle.match.step();
        if (idle.match.phase === "over" || idle.match.phase === "match") idle = makeIdle();
        if (mode === "net") { if (room) room.tick(); return; }
    } else if (mode === "local") {
        for (let i = 0; i < 2; i++) { const c = playing ? controlsOf(i) : { mx: 0, my: 0, buttons: 0 }; local.match.setInput(i, c.mx, c.my, c.buttons); if (i === 0 && playing && local.match.phase === "play") teach(c, local.match.player(0)); }
        for (const b of local.bots) b.think(local.match);
        for (const p of local.match.players) { p.px = p.x; p.py = p.y; p.pz = p.z; }
        local.match.step();
        for (const e of local.match.events) { effects(e); if (e.type === "over" || e.type === "match") earn(e, 0, local.match.player(0).team); }
    } else if (mode === "net") {
        const c = playing ? controlsOf(0, true) : { mx: 0, my: 0, buttons: 0 };
        client.tick(c);
        if (playing && client.match.phase === "play") teach(c, client.me);
        if (room) room.tick();
    }
});

/** the robots to draw this frame: { id, slot, name, x, y, z, face, out, carry, charging, charge, ground, swim, wins } */
const view = [];
const at = { x: 0, y: 0, z: 0 }, sample = {};
function gather(alpha) {
    view.length = 0;
    if (mode === "net") {
        let slot = 0;
        if (client.state === "lobby") return idleView();
        for (const [id, info] of client.players) {
            const s = info.slot ?? slot++;
            if (id === client.id) {
                const me = client.me;
                client.myPosition(alpha, at);
                view.push({ id, slot: s, hat: info.hat, paint: info.paint, stats: info.stats, name: info.name, me: true, x: at.x, y: at.y, z: at.z, face: me.face, out: me.out, carry: me.carry, carryKind: me.carryKind, buoy: me.buoy, team: info.team, charging: me.charging, charge: me.charge / SHOVE.charge, ground: me.ground, swim: me.swim, wins: info.wins });
            } else if (client.sample(id, sample)) view.push({ id, slot: s, hat: info.hat, paint: info.paint, stats: info.stats, name: info.name, ...sample, team: info.team, wins: info.wins, away: info.away });
        }
        return client.match;
    }
    const m = mode === "local" ? local.match : idle.match;
    return pushMatch(m, alpha);
}
function idleView() { return pushMatch(idle.match, 1, true); }
function pushMatch(m, alpha, still = false) {
    m.players.forEach((p, i) => {
        const a = mode === "local" && !still ? alpha : 1, px = p.px ?? p.x, py = p.py ?? p.y, pz = p.pz ?? p.z;
        view.push({ id: still ? 1000 + p.id : mode === "title" ? 1000 + p.id : p.id, slot: i, stats: p.stats, name: p.name, x: px + (p.x - px) * a, y: py + (p.y - py) * a, z: pz + (p.z - pz) * a, face: p.face, out: p.out, carry: p.carry, carryKind: p.carryKind, buoy: p.buoy, team: p.team,
            charging: p.charging, charge: p.charge / SHOVE.charge, ground: p.ground, swim: p.swim, wins: p.wins });
    });
    return m;
}

const lerp = (a, b, t) => a + (b - a) * t;
let time = 0;
const look = { x: 0, y: 0, d: 22 };
const tagAt = { x: 0, y: 0, depth: 0, visible: false };
game.onRender((dt, alpha) => {
    time += dt;
    if (mode === "net") client.frame(dt);
    const m = gather(alpha);

    for (const [mk, a] of marks) { for (const i of shown[mk]) a.mesh.setTransform(i, 0, 0, -50, 0.001); shown[mk].clear(); }
    goalEntities.forEach((e) => { e.visible = m.mode === "haul"; });
    // tiles: their kind's colour, shaking, darkening and cracking while they warn, sliding under when they sink
    foamHexes.length = 0;
    m.tiles.forEach((t, i) => {
        const hide = () => { tileMesh.setTransform(i, 0, 0, -50, 0.001); crackMesh.setTransform(i, 0, 0, -50, 0.001); for (let k = 0; k < TUFTS; k++) tuftMesh.setTransform(i * TUFTS + k, 0, 0, -50, 0.001); };
        if (t.state === GONE) return hide();
        const kind = t.kind || t.placed > -99 && t.ring > GRID.island ? 0 : kinds[i];
        const goal = m.goalOf(t);
        let col = goal >= 0 ? TEAM[goal] : t.kind ? tileColor(t.kind) : KIND[kind], z = 0, crack = 0, ox = 0, oy = 0, tilt = 0;
        const age = m.time - t.placed, fresh = age < 0.35 && age >= 0 ? 1 - age / 0.35 : 0;
        if (t.state === WARN) {
            const k = Math.max(0, 1 - t.t / TILE.warn);
            const amp = 0.035 * (0.3 + k);
            ox = Math.sin(time * 55 + i) * amp; oy = Math.cos(time * 47 + i * 2) * amp;
            const d = 1 - 0.45 * k;
            col = [col[0] * d + 0.12 * k, col[1] * d * 0.92, col[2] * d * 0.85];
            if (save.contrast) col = Math.sin(time * 14) > 0 ? [1, 0.85, 0.05] : [0.04, 0.04, 0.05];
            crack = Math.min(1, 0.25 + k * 1.1);
            z = -k * 0.06;
        } else if (t.state === SINKING) {
            const k = 1 - t.t / TILE.sink;
            col = [col[0] * 0.5, col[1] * 0.5, col[2] * 0.52];
            z = -k * k * 1.7; crack = 1 - k; tilt = k * 0.25;
        }
        z += fresh * 0.3;
        // a raft bobs; a lit bomb flashes faster as its fuse burns
        if (t.raft > 0) z += Math.sin(time * 2.4 + i) * 0.05 - 0.05;
        if (t.fuse > 0) {
            const f = Math.sin(time * (10 + (2 - t.fuse) * 16)) > 0 ? 1 : 0; col = f ? [1, 0.25, 0.1] : col;
            if (Math.random() < 0.4) dust.emit(1, { position: [t.x, t.y, 0.45], velocity: [0, 0, 2], speed: 1.5, life: [0.12, 0.25], size: [0.08, 0.01], color: [1, 0.7, 0.2, 1] });
            sound.play("fuse", t.x, t.y, { gap: 0.12 + t.fuse * 0.12 });
        }
        const s = 1 + fresh * 0.08, x = t.x + ox, y = t.y + oy;
        tileMesh.setTransform(i, x, y, z - tilt, s, s, 1, tilt * 0.6);
        tileMesh.setColor(i, col[0], col[1], col[2]);
        crackMesh.setTransform(i, x, y, z, s);
        crackMesh.setColor(i, 1, 1, 1, crack);
        for (let k = 0; k < TUFTS; k++) {
            const u = tuftAt[i][k];
            if (kind !== 1 || !u.on) tuftMesh.setTransform(i * TUFTS + k, 0, 0, -50, 0.001);
            else {
                tuftMesh.setTransform(i * TUFTS + k, x + u.x, y + u.y, z, u.s, u.s, u.s * (1 - (t.state === WARN ? 0.3 : 0)), u.yaw);
                tuftMesh.setColor(i * TUFTS + k, 0.36 * (1 - crack * 0.3), 0.72 * (1 - crack * 0.3), 0.3);
            }
        }
        for (const [mk, a] of marks) {
            if (t.kind !== mk) continue;
            a.mesh.setTransform(i, x, y, z + a.z, s);
            a.mesh.setColor(i, a.color[0], a.color[1], a.color[2]);
            shown[mk].add(i);
        }
        foamHexes.push({ x, y, r: TILE_R, z });
    });
    if (++frameNo % foamEvery === 0) foam.build(foamHexes);
    autoQuality(dt);

    // robots
    let buoyCount = 0, tileShots = 0;
    for (const r of robots.values()) r.seen = 0;
    let cx = 0, cy = 0, n = 0, minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const v of view) {
        const r = robot(v.id, v.slot, v.hat, v.paint);
        r.seen = 1;
        r.root.visible = !v.out;
        r.tag.hidden = v.out || screen === "title" || screen === "lobby";
        if (v.out) {
            if (v.buoy && buoyCount < SHOTS) { buoys.setTransform(buoyCount, v.x, v.y, PLAYER.waterZ + 0.3 + Math.sin(time * 2 + v.id) * 0.06, 1); buoys.setColor(buoyCount, r.color[0], r.color[1], r.color[2]); buoyCount++; }
            // keep your own buoy in the picture
            if (v.me && v.buoy) { cx += v.x; cy += v.y; n++; minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y); }
            continue;
        }
        // walking: how far it moved this frame drives the foot shuffle and a little bob
        const speed = dt > 0 ? Math.min(8, Math.hypot(v.x - r.lx, v.y - r.ly) / dt) : 0;
        r.lx = v.x; r.ly = v.y;
        const moving = v.ground && speed > 0.4 ? Math.min(1, speed / PLAYER.speed) : 0;
        r.walk += dt * (6 + speed * 2.2) * (moving ? 1 : 0);
        r.root.setPosition(v.x, v.y, v.z);
        r.root.setYaw(v.face);
        r.squash = Math.max(0, r.squash - dt * 5);
        const charge = v.charging ? v.charge : 0;
        r.stretch = Math.max(0, r.stretch - dt * 6);
        const sq = 1 - r.squash * 0.3 - charge * 0.15 + r.stretch * 0.28;
        // the blow shows: a white flash that fades
        r.flash = Math.max(0, r.flash - dt * 7);
        r.paint.emissive[0] = r.paint.emissive[1] = r.paint.emissive[2] = r.flash * 1.6 + charge * charge * 0.35;
        // puffs of dust at a run, rings on the water when swimming, sparks while winding up
        const inWater = v.z <= PLAYER.waterZ + 0.05;
        if ((r.puff -= dt) <= 0 && moving > 0.6) { r.puff = 0.14; dust.emit(1, { position: [v.x, v.y, 0.08], speed: 0.5, life: [0.25, 0.4], size: [0.16, 0.02], color: [0.95, 0.92, 0.8, 0.7] }); }
        if (inWater && r.puff <= 0) { r.puff = 0.25; splash.emit(5, { position: [v.x, v.y, PLAYER.waterZ + 0.3], speed: 1.4, flat: true, life: [0.25, 0.5], size: [0.1, 0.02], color: [0.95, 0.99, 1, 0.8] }); }
        if (charge > 0.5 && (r.sparkle -= dt) <= 0) { r.sparkle = 0.06; dust.emit(1, { position: [v.x + Math.cos(v.face) * 0.4, v.y + Math.sin(v.face) * 0.4, v.z + 0.8], speed: 2, life: [0.12, 0.25], size: [0.09, 0.01], color: [1, 0.9, 0.4, 1] }); }
        const bob = Math.abs(Math.sin(r.walk)) * 0.06 * moving;
        // winding up trembles, and a swimming robot bobs low
        const shiver = charge > 0.3 ? Math.sin(time * 70) * 0.02 * charge : 0;
        r.lift.setPosition(-charge * 0.08 + shiver, 0, bob + (v.z <= PLAYER.waterZ + 0.05 ? Math.sin(time * 5 + v.id) * 0.05 : 0));
        r.lift.setScale(1 / Math.sqrt(sq), 1 / Math.sqrt(sq), sq);
        r.lift.setRotationEuler(0, moving * 0.12 - charge * 0.25 + (v.ground ? 0 : 0.1), Math.sin(r.walk) * 0.08 * moving);
        r.feet[0].setPosition(0.05 + Math.sin(r.walk) * 0.16 * moving, 0.19, 0.1 + Math.max(0, Math.cos(r.walk)) * 0.07 * moving);
        r.feet[1].setPosition(0.05 - Math.sin(r.walk) * 0.16 * moving, -0.19, 0.1 + Math.max(0, -Math.cos(r.walk)) * 0.07 * moving);
        r.carry.visible = v.carry;
        if (v.carry) r.carry.mesh.material.color.set(tileColor(v.carryKind));
        // in the team modes, the ring under a robot says whose side it's on
        r.ring.mesh.material.color.set(m.teamed && v.team !== undefined ? TEAM[v.team] : r.color);
        r.carry.setYaw(-v.face + time * 0.6);
        r.ring.visible = v.ground;
        r.ring.setScale(1 + charge * 0.6 + (v.me ? 0.15 * Math.sin(time * 6) : 0));
        // name tag over the head
        if (!r.tag.hidden) {
            camera.project([v.x, v.y, v.z + 2.55 + (v.carry ? 0.5 : 0)], w, h, tagAt);
            r.emoteFor = Math.max(0, r.emoteFor - dt);
            const label = r.emoteFor > 0 ? `${r.emote} ${v.name}` : v.name;
            if (r.name !== label) { r.name = label; r.tag.textContent = label; r.tag.classList.toggle("emoting", r.emoteFor > 0); }
            r.tag.hidden = !tagAt.visible;
            r.tag.style.transform = `translate(${tagAt.x.toFixed(1)}px, ${tagAt.y.toFixed(1)}px) translate(-50%, -100%)`;
            r.tag.classList.toggle("me", !!v.me);
        }
        cx += v.x; cy += v.y; n++;
        minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minY = Math.min(minY, v.y); maxY = Math.max(maxY, v.y);
    }
    for (const r of robots.values()) if (!r.seen) { r.root.visible = false; r.tag.hidden = true; }
    // things in the air
    for (const s of m.shots) {
        if (s.type === "buoy") { if (buoyCount < SHOTS) { buoys.setTransform(buoyCount, s.x, s.y, s.z, 1, 1, 1, time * 9); buoys.setColor(buoyCount, 1, 0.3, 0.2); buoyCount++; } }
        else if (tileShots < SHOTS) { const c = tileColor(s.kind); if (Math.random() < 0.5) dust.emit(1, { position: [s.x, s.y, s.z], speed: 0.3, life: [0.15, 0.3], size: [0.14, 0.02], color: [...c, 0.8] }); shotTiles.setTransform(tileShots, s.x, s.y, s.z, 1, 1, 1, time * 12); shotTiles.setColor(tileShots, c[0], c[1], c[2]); tileShots++; }
    }
    for (let i = buoyCount; i < SHOTS; i++) buoys.setTransform(i, 0, 0, -50, 0.001);
    for (let i = tileShots; i < SHOTS; i++) shotTiles.setTransform(i, 0, 0, -50, 0.001);
    // the camera keeps everyone in frame
    if (n) {
        cx /= n; cy /= n;
        const spread = Math.max(maxX - minX, (maxY - minY) * 1.3);
        const k = 1 - Math.exp(-dt * 2.5);
        look.x += (cx * 0.6 - look.x) * k; look.y += (cy * 0.6 - look.y) * k;
        look.d += (Math.max(17, 12 + spread * 1.1) - look.d) * k;
    }
    camera.target.set([look.x, look.y - 1, 0]);
    // a tall screen sees less sideways: pull back so the island's width still fits
    camera.distance = look.d * Math.max(1, 1.15 / Math.max(0.3, w / Math.max(1, h)));
    camera.yaw = -Math.PI / 2;
    camera.pitch = 1.0;
    if (shot) { camera.target.set(shot.target); camera.distance = shot.distance; camera.yaw = shot.yaw; camera.pitch = shot.pitch; }
    // the music follows how much of the island is gone, storms, and you in the water
    sound.listener.x = look.x; sound.listener.y = look.y; sound.listener.reach = look.d * 1.8;
    const playing = m.phase === "play" && screen !== "title" && screen !== "lobby";
    let left = 0;
    for (const t of m.tiles) if (t.state === SOLID) left++;
    const myWet = view.some((v) => v.me && !v.out && v.swim > 0);
    sound.update(Math.min(1, (1 - left / 127) * 1.1 + (m.storm ? 0.15 : 0) + (myWet ? 0.15 : 0)), playing);
    hud(m, dt);
});

// ------------------------------------------------------------------ HUD
let lastHud = "", since = 1, boardHtml = "";
function hud(m, dt) {
    if (screen === "title") return;
    const rgb = (slot) => `rgb(${COLORS[slot % COLORS.length].map((v) => Math.round(v * 255))})`;
    const scores = view.map((v) => `<li style="--c:${m.teamed && v.team !== undefined ? `rgb(${TEAM[v.team].map((c) => Math.round(c * 255))})` : rgb(v.slot)}" class="${v.out ? "out" : ""}${v.me ? " me" : ""}">${escape(v.name)}${v.away ? " (away)" : ""} <b>${v.wins}</b></li>`).join("");
    const name = (id) => { const v = view.find((x) => x.id === id); return v ? escape(v.name) : "?"; };
    let banner = "";
    if (m.phase === "ready") banner = `Round ${m.round}`;
    else if (m.phase === "over") banner = m.teamed && m.winnerTeam >= 0 ? `${TEAM_NAMES[m.winnerTeam]} win the round` : m.winner >= 0 ? `${name(m.winner)} wins the round` : "Nobody's left";
    else if (m.phase === "match") banner = m.teamed && m.winnerTeam >= 0 ? `${TEAM_NAMES[m.winnerTeam]} win the match!` : `${name(m.winner)} wins the match!`;
    if (m.phase === "ready") banner = `${MODE_NAMES[m.mode]}: round ${m.round}`;
    else if (view.length < 2) banner = "";
    const swim = view.filter((v) => !v.out && v.swim > 0).map((v) => `${escape(v.name)}: ${Math.max(0, PLAYER.swimTime - v.swim).toFixed(1)}s to swim`).join("<br>");
    const meOut = mode === "net" && client.me.out && m.phase === "play" ? (client.me.buoy ? "You're out. Paddle your buoy, then G to throw it!" : "You're out. Next round soon.") : "";
    const s = m.storm;
    const stormText = !s ? "" : s.active ? STORM_TEXT[s.kind][1] : STORM_TEXT[s.kind][0];
    const haulText = m.mode === "haul" ? `<span style="color:rgb(${TEAM[0].map((v) => Math.round(v * 255))})">${m.hauled[0]}</span> / ${m.haulGoalShown ?? m.haulTarget} / <span style="color:rgb(${TEAM[1].map((v) => Math.round(v * 255))})">${m.hauled[1]}</span>` : "";
    const stormBox = $("storm");
    if (stormBox.textContent !== stormText) { stormBox.textContent = stormText; stormBox.hidden = !stormText; }
    stormBox.classList.toggle("hit", !!(s && s.active));
    if ($("haul").innerHTML !== haulText) { $("haul").innerHTML = haulText; $("haul").hidden = !haulText; }
    const wantBoard = boardHeld || m.phase === "match";
    if (wantBoard) {
        const rows = view.map((v) => ({ name: v.name, color: rgb(v.slot), wins: v.wins, ...(v.stats || { hits: 0, tiles: 0, hauled: 0, falls: 0 }) })).sort((a, b) => b.wins - a.wins || b.hits - a.hits);
        const out = table(rows);
        if (boardHtml !== out) { boardHtml = out; $("board").innerHTML = out; }
    }
    $("board").hidden = !wantBoard;
    const html = scores + "|" + banner + "|" + swim + "|" + meOut;
    if (html !== lastHud) {
        lastHud = html;
        $("scores").innerHTML = scores;
        if ($("banner").textContent !== (banner || meOut)) { $("banner").classList.remove("pop"); void $("banner").offsetWidth; $("banner").classList.add("pop"); }
        $("banner").textContent = banner || meOut;
        $("banner").hidden = !banner && !meOut;
        $("banner").classList.toggle("small", !banner);
        $("swim").innerHTML = swim;
    }
    if (!$("debug").hidden && (since += dt) > 0.25) {
        since = 0;
        const s = renderer.stats, ns = client.stats;
        $("debug").textContent = `${Math.round(game.loop.fps)} fps  ${game.loop.frameMs.toFixed(1)} ms  ${s.drawCalls} draws  ${(s.triangles / 1000).toFixed(1)}k tris`
            + (mode === "net" ? `\nping ${client.ping} ms  in ${(ns.bytesIn / 1000).toFixed(1)} kB/s  out ${(ns.bytesOut / 1000).toFixed(1)} kB/s  ${ns.snaps} snaps/s`
            + `\nreplayed ${ns.replayed}  corrections ${ns.corrections}  last error ${ns.lastError.toFixed(3)} m` : "");
    }
}
const TEAM_NAMES = ["Orange team", "Sky team"];
const STORM_TEXT = { wind: ["Wind coming!", "Hold on: wind!"], wave: ["Big wave coming! Loose tiles will go", "Wave!"], fast: ["The island is shaking!", "Fast sink!"] };
const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ------------------------------------------------------------------ baseline views
/**
 * The four locked views of the look target (stage 3). Each freezes the title-screen match (seed 7, four
 * bots) at a fixed tick and puts the camera in a fixed place, so screenshots compare like with like.
 * ?view=1..4 in the address, or hexhaul.baseline(n) from the console; baseline(0) lets go.
 */
const BASELINES = [
    null,
    { tick: 900, target: [0, -1, 0], distance: 22, yaw: -Math.PI / 2, pitch: 1.0 },   // the game camera
    { tick: 900, target: [0, 0, 0.6], distance: 11, yaw: -2.1, pitch: 0.42 },          // robots up close
    { tick: 1500, target: [0, 0, 0], distance: 30, yaw: -0.6, pitch: 0.28 },           // wide, to the horizon
    { tick: 1500, warn: true, target: [0, 0, 0], distance: 7, yaw: -1.2, pitch: 0.8 }, // a tile about to sink, foam
];
let shot = null;
function baseline(n) {
    shot = null;
    if (!BASELINES[n]) return;
    leave(); show("title");
    $("title").hidden = true;
    idle = makeIdle();
    const step = () => { for (const b of idle.bots) b.think(idle.match); idle.match.step(); };
    for (let i = 0; i < BASELINES[n].tick; i++) step();
    shot = { ...BASELINES[n] };
    if (shot.warn) {
        // on to the first tile well into its warning, and look at it
        let t;
        for (let i = 0; i < 1200 && !(t = idle.match.tiles.find((x) => x.state === WARN && x.t < TILE.warn * 0.35)); i++) step();
        if (t) shot.target = [t.x, t.y, 0];
    }
}

// ------------------------------------------------------------------ start
const invited = new URLSearchParams(location.search).get("room");
const asked = Number(new URLSearchParams(location.search).get("view"));
show("title");
probe().then(() => { if (invited && online.up) playOnline({ room: invited.toUpperCase() }); else if (invited) $("code").value = invited.toUpperCase(); });
game.start();
if (asked) baseline(asked);
applyMotion();
window.hexhaul = { sound, baseline, game, client, conditions, robots, startPractice, startLocal, playOnline, leave, get room() { return room; }, get mode() { return mode; }, get local() { return local; } };
