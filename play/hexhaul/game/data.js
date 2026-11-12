/**
 * HEXHAUL: every tuning number in one place. Distances in metres, times in seconds.
 * @module game/data
 */

export const TICK = 1 / 60;

export const GRID = {
    /** circumradius of one hex tile */
    size: 1,
    /** the island at the start of a round: every hex within this many steps of the centre */
    island: 6,
    /** tiles can be placed out to here (bridges and rafts beyond the island's edge) */
    reach: 9,
    /** a little gap between tiles, so each one reads on its own */
    gap: 0.06,
};

export const TILE = {
    /** how long a tile shakes before it goes */
    warn: 1.5,
    /** how long it takes to slide under */
    sink: 0.8,
    /** a freshly placed tile can't be picked for a sink wave this soon */
    fresh: 4,
};

export const WAVES = {
    /** the first wave comes this long after the round starts */
    first: 4,
    /** gap between waves at the start and at the end of the ramp */
    gapStart: 6.5,
    gapEnd: 3,
    /** tiles per wave at the start and at the end of the ramp */
    countStart: 3,
    countEnd: 8,
    /** seconds for the ramp from start to end */
    ramp: 120,
    /** share of each wave taken from the outer edge; the rest are random holes */
    edgeShare: 0.7,
};

export const PLAYER = {
    radius: 0.38,
    speed: 5.2,
    accel: 40,
    /** speed while carrying a tile, as a share */
    carrySpeed: 0.72,
    /** ground friction when there's no input (1/s) */
    friction: 12,
    jump: 6.4,
    gravity: 20,
    /** below this height you're in the water */
    waterZ: -0.55,
    swimSpeed: 2.2,
    /** seconds in the water before you're out */
    swimTime: 3,
    /** a press this early still counts (input buffering) */
    buffer: 0.12,
    /** you can still jump this long after walking off an edge (coyote time) */
    coyote: 0.1,
};

export const SHOVE = {
    /** hold for up to this long to charge */
    charge: 0.6,
    /** knockback speed from a tap, and the extra from a full charge */
    base: 7,
    extra: 9,
    upward: 3.5,
    /** reach in front of the shover, and how wide the cone is (cos of the half angle) */
    reach: 1.25,
    cone: 0.35,
    /** a short lunge forward when you shove */
    lunge: 4,
    cooldown: 0.7,
    /** a robot that is hit can't steer for this long */
    stun: 0.45,
};

export const ROUND = {
    /** countdown before a round */
    ready: 2,
    /** after a winner, before the next round */
    after: 3,
    /** wins needed to take the match */
    toWin: 3,
};

/** the special tiles: normal 0, then these */
export const KIND = { NORMAL: 0, BOUNCY: 1, HEAVY: 2, ICE: 3, BOMB: 4 };
export const SPECIAL = {
    /** share of the island's tiles of each kind, at the start of a round */
    share: { [KIND.BOUNCY]: 0.05, [KIND.HEAVY]: 0.08, [KIND.ICE]: 0.08, [KIND.BOMB]: 0.05 },
    /** upward speed from a bouncy tile */
    bounce: 11,
    /** a heavy tile warns this many times longer */
    heavyWarn: 2,
    /** on ice: how much grip is left, and how much slower you stop */
    iceGrip: 0.18,
    iceFriction: 0.1,
    iceSpeed: 1.15,
};

export const BOMB = {
    /** seconds from being put down to going off */
    fuse: 2,
    /** robots this close get thrown, at this speed */
    radius: 2.8,
    knock: 11,
    /** the tiles it pops are gone this much faster than a normal sink */
    sink: 0.25,
};

/** a tile put down with no solid neighbour floats this long, then starts to sink */
export const RAFT = { life: 6 };

export const THROW = {
    /** forward speed from a tap and the extra from a full charge */
    speed: 8,
    extra: 7,
    up: 3,
    /** how close a flying thing has to come to hit a robot */
    radius: 0.85,
    knock: 9,
    stun: 0.4,
};

export const BUOY = {
    /** how fast a robot that's out can paddle its buoy */
    drift: 2.5,
    /** seconds the throw takes to arrive */
    flight: 0.9,
    range: 16,
    knock: 8,
};

export const STORM = {
    /** seconds between storms */
    gapMin: 30,
    gapMax: 40,
    /** the warning before one hits */
    warn: 3,
    /** how long wind and fast-sink last */
    last: 6,
    /** how fast the wind carries a robot, m/s */
    wind: 1.9,
    /** the big wave: this many of the outermost tiles go at once, and every raft and fresh tile */
    waveTiles: 14,
    /** tiles knocked by a wave warn this briefly */
    waveWarn: 0.7,
    /** during fast-sink, waves come this much more often */
    fastSink: 0.35,
};

export const HAUL = {
    /** tiles a team has to bring home to win the round */
    target: 12,
    /** and more for bigger teams: this many per robot on the larger side */
    perRobot: 8,
    /** how close to your goal you have to come */
    reach: 1.5,
    /** a tile only counts if it was pulled up at least this far from the goal, or a robot could stand there and pass tiles in */
    from: 7,
    /** the two goals, axial */
    goals: [[-5, 0], [5, 0]],
};

export const MODES = ["last", "teams", "haul"];
export const MODE_NAMES = { last: "Last Bot Standing", teams: "Teams", haul: "Haul" };

/** what skill changes in a bot: never its physics, only what it notices and how well it plans (game/bots.js) */
export const BOTS = {
    easy: { react: 40, noise: 0.3, notice: 0.45, paths: false, jumps: false, careful: false, linesUp: false, bridges: false, bombs: false,
        aggression: 0.5, charge: 0.2, throws: 0.15, steals: 0.05, hauls: 0.5, buoy: 0.004, dislikeIce: 0, likeHeavy: 0 },
    normal: { react: 14, noise: 0.12, notice: 1.2, paths: true, jumps: true, careful: true, linesUp: false, bridges: false, bombs: false,
        aggression: 0.75, charge: 0.5, throws: 0.4, steals: 0.2, hauls: 0.65, buoy: 0.01, dislikeIce: 1, likeHeavy: 0.3 },
    hard: { react: 6, noise: 0.04, notice: 9, paths: true, jumps: true, careful: true, linesUp: true, bridges: true, bombs: true,
        aggression: 1, charge: 0.85, throws: 0.7, steals: 0.4, hauls: 0.8, buoy: 0.03, dislikeIce: 2, likeHeavy: 1 },
};
export const SKILLS = ["easy", "normal", "hard"];

export const MODE_HELP = {
    last: "Everyone for themselves. The last robot above water wins the round.",
    teams: "Two sides, no shoving your own. The last side above water wins the round.",
    haul: "Two sides. Bring tiles from far away to your goal ring, or wipe out the other side.",
};

export const LOBBY = {
    /** seconds from everyone being ready to the first round */
    countdown: 3,
    /** an open room starts by itself this long after someone arrives */
    openWait: 20,
};

/** what playing earns. Looks only: nothing here changes how a robot performs. */
export const XP = { round: 1, roundWin: 3, matchWin: 10 };
/** hats index the drawing's list in game/main.js; -1 is the hat that goes with your colour */
export const COSMETICS = {
    hats: [
        { id: -1, name: "Goes with your colour", xp: 0 }, { id: 0, name: "Top hat", xp: 0 }, { id: 1, name: "Party cone", xp: 5 },
        { id: 2, name: "Cap", xp: 15 }, { id: 3, name: "Halo", xp: 30 }, { id: 4, name: "Crown", xp: 60 }, { id: 5, name: "Horns", xp: 100 },
    ],
    paints: [
        { id: 0, name: "No stripe", xp: 0, color: null }, { id: 1, name: "Silver stripe", xp: 3, color: [0.85, 0.87, 0.92] },
        { id: 2, name: "Black stripe", xp: 10, color: [0.08, 0.08, 0.1] }, { id: 3, name: "Mint stripe", xp: 25, color: [0.5, 0.95, 0.75] },
        { id: 4, name: "Gold stripe", xp: 50, color: [1, 0.78, 0.2] },
    ],
    emotes: [
        { text: "👋", xp: 0 }, { text: "😂", xp: 0 }, { text: "😡", xp: 8 }, { text: "🎉", xp: 20 }, { text: "🤖", xp: 40 }, { text: "🌊", xp: 80 },
    ],
};

/** robot colours: picked to stay apart for the common kinds of colour blindness */
export const COLORS = [
    // Okabe-Ito based, so the robots stay apart for the common kinds of colour blindness; each also gets a hat
    [0.95, 0.5, 0.06],
    [0.34, 0.71, 0.91],
    [0.94, 0.89, 0.26],
    [0.8, 0.47, 0.65],
    [0.0, 0.45, 0.7],
    [0.82, 0.2, 0.16],
    [0.96, 0.96, 0.96],
    [0.25, 0.25, 0.3],
];

export const NAMES = ["Orange", "Sky", "Yellow", "Pink", "Blue", "Red", "Snow", "Ink"];
