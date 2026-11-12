import { TILE, COSMETICS } from "./data.js";
import { SOLID } from "./sim.js";

/**
 * HEXHAUL: what travels between the page and the server. JSON text: the state is small (a few hundred
 * tiles that rarely change, up to eight robots), so a binary format isn't worth its complexity yet.
 * Positions travel in centimetres and angles in hundredths of a radian.
 * @module game/protocol
 */

export const PROTOCOL = 3;
export const NAME_MAX = 16;
export const MAX_PLAYERS = 8;
/** a snapshot every this many ticks (20 a second) */
export const SNAP_EVERY = 3;
/** other robots are drawn this many ticks in the past, between two snapshots */
export const INTERP_TICKS = 7;
/** seconds a dropped player's seat is kept for them */
export const REJOIN_SECONDS = 30;

/** a look from a client, kept to what exists */
export function cleanLook(look) {
    const has = (list, v) => list.some((x) => x.id === v);
    const hat = look && has(COSMETICS.hats, look.hat) ? look.hat : -1, paint = look && has(COSMETICS.paints, look.paint) ? look.paint : 0;
    return { hat, paint };
}

export const encode = (m) => JSON.stringify(m);
export function decode(data) {
    if (typeof data !== "string" || data.length > 64 * 1024) return null;
    try { const m = JSON.parse(data); return m && typeof m === "object" && typeof m.t === "string" ? m : null; } catch { return null; }
}
export const byteLength = (data) => typeof data === "string" ? data.length : data.byteLength;

export function cleanText(text, max) {
    return typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, max) : "";
}

/** an input from a client, or null if it isn't one */
export function cleanInput(m) {
    const n = (v) => Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
    if (!Number.isInteger(m.s) || m.s < 1) return null;
    return { seq: m.s, mx: n(m.mx), my: n(m.my), buttons: Number.isInteger(m.b) ? m.b & 7 : 0 };
}

const cm = (v) => Math.round(v * 100);
/** flag bits in a robot's row */
export const FLAG = { GROUND: 1, OUT: 2, CARRY: 4, CHARGING: 8, STUN: 16, BUOY: 32 };

/** one robot as others see it: [id, x, y, z, face, flags, charge (0..100), swim (tenths of a second), kind of tile carried] */
export function playerRow(p) {
    const flags = (p.ground ? FLAG.GROUND : 0) | (p.out ? FLAG.OUT : 0) | (p.carry ? FLAG.CARRY : 0) | (p.charging ? FLAG.CHARGING : 0) | (p.stun > 0 ? FLAG.STUN : 0) | (p.buoy ? FLAG.BUOY : 0);
    return [p.id, cm(p.x), cm(p.y), cm(p.z), Math.round(p.face * 100), flags, Math.round((p.charge / 0.6) * 100), Math.round(p.swim * 10), p.carryKind];
}

/** one tile as it travels: [index, state, time left in hundredths, placed recently (1/0), kind, raft (1/0), fuse in hundredths] */
export function tileRow(t, i, time) {
    return [i, t.state, Math.round(t.t * 100), t.state === SOLID && time - t.placed < TILE.fresh ? 1 : 0, t.kind, t.raft > 0 ? 1 : 0, Math.round(t.fuse * 100)];
}

/** one thing in the air: [id, type (0 tile, 1 buoy), kind, x, y, z, vx, vy, vz] */
export function shotRow(s) {
    return [s.sid, s.type === "buoy" ? 1 : 0, s.kind, cm(s.x), cm(s.y), cm(s.z), cm(s.vx), cm(s.vy), cm(s.vz)];
}
