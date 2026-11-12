/**
 * FAULTLINE: the save (the `save-systems` skill), after HEXHAUL's.
 *
 * Local storage writes one key at a time, so a write goes in three steps: the new save to a scratch key,
 * read back and parsed (proof it is whole), then to the main key, with the previous good save kept as a
 * backup. load() takes the main key, then the backup, then the scratch copy, then the defaults: whichever
 * is first to parse. A full or blocked storage is not an error: the game plays on from memory.
 * @module game/save
 */

export const SAVE_VERSION = 1;
const KEY = "faultline-save", BACKUP = KEY + ".backup", SCRATCH = KEY + ".tmp";

export const DEFAULT_KEYS = { gas: "ArrowRight", brake: "ArrowLeft", charge: "Space" };
export const ALT_KEYS = { gas: "KeyD", brake: "KeyA", charge: "KeyW" };

export function defaults() {
    return {
        version: SAVE_VERSION,
        coins: 0,
        owned: ["buggy"],
        vehicle: "buggy",
        upgrades: { buggy: {}, van: {}, tractor: {}, kite: {} },
        biome: "mesa",
        best: {},               // "biome" and "biome:vehicle" → metres
        daily: {},              // "YYYYMMDD:biome" → metres
        raceWins: {},           // difficulty → count
        achievements: [],
        stats: { runs: 0, metres: 0, flips: 0, coins: 0, crashes: 0 },
        music: 0.6, sfx: 0.9, muted: false,
        quality: "auto", motion: "auto", textSize: 1, captions: true, contrast: false, assist: false,
        keys: { ...DEFAULT_KEYS },
        tutorialDone: false,
        difficulty: "normal",
    };
}

/** Old shapes to new. Each step takes the save one version on. */
const MIGRATIONS = {};

function parse(text) {
    if (!text) return null;
    try { const s = JSON.parse(text); return s && typeof s === "object" && !Array.isArray(s) ? s : null; } catch { return null; }
}
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }

/** The save, from the first copy that parses, migrated and completed with defaults. */
export function load() {
    let s = parse(read(KEY)) || parse(read(BACKUP)) || parse(read(SCRATCH));
    const d = defaults();
    if (!s) return d;
    let v = s.version || 1;
    while (v < SAVE_VERSION && MIGRATIONS[v]) { s = MIGRATIONS[v](s); v = s.version; }
    return {
        ...d, ...s, version: SAVE_VERSION,
        keys: { ...d.keys, ...(s.keys || {}) },
        upgrades: { ...d.upgrades, ...(s.upgrades || {}) },
        stats: { ...d.stats, ...(s.stats || {}) },
        owned: Array.isArray(s.owned) && s.owned.length ? s.owned : d.owned,
    };
}

/** Write the save: scratch, check, main (keeping the last good one as the backup). Returns false if storage refused. */
export function store(save) {
    try {
        const text = JSON.stringify({ ...save, version: SAVE_VERSION });
        localStorage.setItem(SCRATCH, text);
        if (!parse(localStorage.getItem(SCRATCH))) return false;
        const previous = localStorage.getItem(KEY);
        if (previous && parse(previous)) localStorage.setItem(BACKUP, previous);
        localStorage.setItem(KEY, text);
        localStorage.removeItem(SCRATCH);
        return true;
    } catch { return false; }
}
