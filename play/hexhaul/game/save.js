/**
 * HEXHAUL: the save (the `save-systems` skill), after TIDEFALL's.
 *
 * Local storage writes one key at a time, so a write goes in three steps: the new save to a scratch key,
 * read back and parsed (proof it is whole), then to the main key, with the previous good save kept as a
 * backup. load() takes the main key, then the backup, then the scratch copy, then the defaults: whichever
 * is first to parse. A full or blocked storage is not an error: the game plays on from memory.
 * @module game/save
 */

export const SAVE_VERSION = 2;
const KEY = "hexhaul-save", BACKUP = KEY + ".backup", SCRATCH = KEY + ".tmp", OLD = "hexhaul-save-v1";

export const DEFAULT_KEYS = { up: "KeyW", down: "KeyS", left: "KeyA", right: "KeyD", jump: "Space", grab: "KeyF", shove: "KeyG" };

export function defaults() {
    return {
        version: SAVE_VERSION,
        name: "", bots: 5, mode: "last", skill: "normal",
        xp: 0, hat: -1, paintId: 0,
        music: 0.7, sfx: 0.9, muted: false,
        quality: "auto", motion: "auto", textSize: 1, captions: true, contrast: false,
        keys: { ...DEFAULT_KEYS },
        tutorialDone: false,
    };
}

/** Old shapes to new. Each step takes the save one version on. */
const MIGRATIONS = {
    // v1 (stages 1 to 7) had no version and fewer settings; the defaults fill in the rest
    1: (s) => ({ ...s, version: 2 }),
};

function parse(text) {
    if (!text) return null;
    try { const s = JSON.parse(text); return s && typeof s === "object" && !Array.isArray(s) ? s : null; } catch { return null; }
}
function read(key) { try { return localStorage.getItem(key); } catch { return null; } }

/** The save, from the first copy that parses, migrated and completed with defaults. */
export function load() {
    let s = parse(read(KEY)) || parse(read(BACKUP)) || parse(read(SCRATCH)) || parse(read(OLD));
    const d = defaults();
    if (!s) return d;
    let v = s.version || 1;
    while (v < SAVE_VERSION && MIGRATIONS[v]) { s = MIGRATIONS[v](s); v = s.version; }
    return { ...d, ...s, version: SAVE_VERSION, keys: { ...d.keys, ...(s.keys || {}) } };
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
