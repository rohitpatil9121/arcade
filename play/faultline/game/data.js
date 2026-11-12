/**
 * FAULTLINE: every tuning number in one place. Units are metres, seconds, kilograms and radians.
 * The physics plane is x (along the track) and y (up); the renderer maps y to world z.
 * @module game/data
 */

export const PHYS = Object.freeze({
    hz: 120,                 // physics steps a second
    substeps: 4,             // contact substeps per step
    iterations: 6,           // velocity solver passes per substep
    gravity: 15,
    groundMaxRise: 6,        // the fastest the ground may push upwards, m/s (cracks closing are exempt)
    restitution: 0.05,
    bodyFriction: 0.55,
    airTorque: 6,            // rad/s² of nose-up/down from gas/brake in the air (scaled per vehicle)
    airSpinMax: 7,           // rad/s cap on air-driven spin
    stuckTime: 2,            // upside down and still for this long ends the run
    sample: 0.18,            // terrain sample spacing for contacts
});

/** surface grip and rolling drag; `mud` drags, `ice` slips */
export const SURFACE = Object.freeze({
    ground: { grip: 1, roll: 0.012 },
    ice: { grip: 0.42, roll: 0.008 },
    mud: { grip: 0.8, roll: 0.06 },
});

/**
 * Vehicles. Wheels are listed rear first. `drive` is the share of motor torque each wheel gets.
 * body: half extents of the chassis box; head: driver's head centre in body space.
 */
export const VEHICLES = Object.freeze([
    {
        id: "buggy", name: "Dune Buggy", cost: 0,
        blurb: "Light and quick. Tips over if you floor it uphill.",
        mass: 240, inertia: 150, body: [1.25, 0.32], com: [0, 0.05],
        head: [-0.25, 1.15], headR: 0.28,
        wheels: [
            { x: -1.1, y: -0.25, r: 0.48, mass: 16, drive: 0.65 },
            { x: 1.15, y: -0.25, r: 0.44, mass: 14, drive: 0.35 },
        ],
        torque: 1250, spin: 40, brake: 1500, grip: 1.15,
        spring: 17000, damper: 1500, rest: 0.42, travel: 0.32,
        air: 1, tank: 100, trick: 1, color: [0.95, 0.42, 0.18],
    },
    {
        id: "van", name: "Mail Van", cost: 4000,
        blurb: "Heavy and steady. Hard to flip, slow to climb.",
        mass: 400, inertia: 360, body: [1.55, 0.6], com: [0, -0.12],
        head: [0.75, 1.05], headR: 0.28,
        wheels: [
            { x: -1.2, y: -0.45, r: 0.5, mass: 20, drive: 1 },
            { x: 1.25, y: -0.45, r: 0.5, mass: 20, drive: 0 },
        ],
        torque: 1700, spin: 34, brake: 2400, grip: 1.05,
        spring: 30000, damper: 2800, rest: 0.42, travel: 0.3,
        air: 0.7, tank: 130, trick: 1, color: [0.25, 0.5, 0.85],
    },
    {
        id: "tractor", name: "Tractor", cost: 9000,
        blurb: "Slow, huge back wheels, climbs almost anything.",
        mass: 480, inertia: 420, body: [1.15, 0.45], com: [0.15, -0.05],
        head: [-0.35, 1.3], headR: 0.28,
        wheels: [
            { x: -0.85, y: -0.15, r: 0.82, mass: 34, drive: 0.7 },
            { x: 1.15, y: -0.35, r: 0.46, mass: 16, drive: 0.3 },
        ],
        torque: 3000, spin: 19, brake: 3400, grip: 1.45,
        spring: 32000, damper: 3200, rest: 0.36, travel: 0.28,
        air: 0.6, tank: 120, trick: 1, color: [0.35, 0.68, 0.25],
    },
    {
        id: "kite", name: "Kite Kart", cost: 16000,
        blurb: "Featherweight. Spins fast in the air; tricks pay half again.",
        mass: 150, inertia: 70, body: [1.0, 0.22], com: [0, 0],
        head: [-0.1, 0.95], headR: 0.26,
        wheels: [
            { x: -0.9, y: -0.18, r: 0.4, mass: 10, drive: 0.5 },
            { x: 0.9, y: -0.18, r: 0.4, mass: 10, drive: 0.5 },
        ],
        torque: 700, spin: 46, brake: 1000, grip: 1.1,
        spring: 11000, damper: 900, rest: 0.4, travel: 0.36,
        air: 1.7, tank: 85, trick: 1.5, color: [0.85, 0.3, 0.75],
    },
]);

/** What each upgrade level adds (level 0..5). */
export const UPGRADES = Object.freeze({
    kinds: ["engine", "suspension", "tyres", "tank", "charges"],
    names: { engine: "Engine", suspension: "Suspension", tyres: "Tyres", tank: "Fuel tank", charges: "Charges" },
    help: {
        engine: "More torque and top speed.",
        suspension: "Softer landings, more travel.",
        tyres: "More grip on every surface.",
        tank: "A bigger tank goes further.",
        charges: "Start with more tremor charges.",
    },
    cost: [100, 250, 500, 900, 1500],
    engine: 0.08,            // torque and top speed per level
    suspension: 0.07,        // travel and damping per level
    tyres: 0.05,             // grip per level
    tank: 0.15,              // capacity per level
    charges: [1, 1, 2, 2, 3, 3],
});

export const FUEL = Object.freeze({
    idle: 0.6,               // per second at no throttle
    full: 2.2,               // per second at full throttle
    firstCan: 300,           // metres to the first canister
    growth: 1.12,            // each canister is 12% further than the last
    lowAlarm: 0.2,
});

/** Ground changes. Times in seconds. */
export const CHANGES = Object.freeze({
    heave: { warn: 3.0, move: 1.2, width: [12, 30], amp: [1.5, 4] },
    slump: { warn: 3.0, move: 0.8, width: [14, 30], amp: [1.5, 3.5] },
    fault: { warn: 2.5, speed: 5, width: [20, 40], amp: [1, 2.5] },
    crack: { warn: 2.5, move: 0.6, width: [3, 7], open: [4, 8], close: 1, depth: 14 },
    tide: { warn: 4, period: 40, depth: 1.6, stall: 1.5 },
    charge: { warn: 1, aim: [25, 40], width: 18, amp: 2.8 },
    settle: 0.5,
});

/** Spacing of natural changes: from `start` metres apart at 0 km to `end` apart by `rampKm`. */
export const SCHEDULE = Object.freeze({
    start: [140, 260], end: [70, 130], rampKm: 3,
    tensionEvery: 800,       // a run of 2-3 changes close together about this often
    minSeeWarning: 2,        // seconds a warning must be on view before the change moves
});

export const SCORE = Object.freeze({
    coinsPer100m: 35,
    flip: 50,
    airPerTenth: 10,         // after the first second in the air
    airFree: 1,
    rideChange: 75,
    closeCall: 40,
    closeCallWindow: 0.5,
    coinValue: 5,
});

/**
 * Biomes. `changes` is the mix of natural changes (weights). Terrain noise: [wavelength, amplitude] octaves,
 * amplitudes grow by `grow` (fraction) by 3 km. `slopeMax` caps the base road's slope.
 */
export const BIOMES = Object.freeze([
    {
        id: "mesa", name: "Red Mesa", unlock: null,
        blurb: "Hills rise and slopes slump. Learn to read the ground.",
        changes: { heave: 3, slump: 2 }, calm: 400,
        octaves: [[140, 9], [48, 5.5], [18, 1.5], [7, 0.22]], grow: 0.7, slopeMax: 1.1,
        surface: () => "ground",
        colors: { top: [0.86, 0.6, 0.36], soil: [0.78, 0.39, 0.23], rock: [0.36, 0.23, 0.18], deep: [0.22, 0.14, 0.12], far: [0.82, 0.55, 0.45], mid: [0.72, 0.4, 0.28], near: [0.55, 0.3, 0.2] },
        sky: { zenith: [0.24, 0.43, 0.61], horizon: [0.62, 0.83, 0.9], fog: [0.72, 0.8, 0.84] },
        landmark: "arch",
    },
    {
        id: "glacier", name: "Glacier Shelf", unlock: { biome: "mesa", distance: 1000 },
        blurb: "Cracks open and close. The ice barely grips.",
        changes: { heave: 2, slump: 1, crack: 3 }, calm: 250,
        octaves: [[150, 9], [50, 4.8], [19, 1.2], [8, 0.15]], grow: 0.6, slopeMax: 0.8,
        surface: (x) => (Math.sin(x * 0.021) + Math.sin(x * 0.0063 + 1.7) > 0.7 ? "ice" : "ground"),
        colors: { top: [0.93, 0.97, 1.0], soil: [0.72, 0.86, 0.95], rock: [0.42, 0.52, 0.62], deep: [0.22, 0.28, 0.38], far: [0.6, 0.7, 0.84], mid: [0.52, 0.64, 0.78], near: [0.44, 0.55, 0.68] },
        sky: { zenith: [0.13, 0.33, 0.68], horizon: [0.62, 0.8, 0.93], fog: [0.7, 0.8, 0.9] },
        landmark: "tower",
    },
    {
        id: "ash", name: "Ash Fields", unlock: { biome: "glacier", distance: 1500 },
        blurb: "Fault steps and steam vents. The cracks glow.",
        changes: { heave: 2, slump: 1, fault: 3, crack: 1 }, calm: 200,
        octaves: [[120, 8.5], [42, 5.2], [15, 1.4], [6, 0.2]], grow: 0.7, slopeMax: 1.3,
        surface: () => "ground", vents: 160,
        colors: { top: [0.3, 0.27, 0.27], soil: [0.2, 0.17, 0.17], rock: [0.14, 0.12, 0.12], deep: [0.4, 0.13, 0.05], far: [0.45, 0.35, 0.36], mid: [0.3, 0.24, 0.25], near: [0.2, 0.16, 0.16] },
        sky: { zenith: [0.25, 0.22, 0.3], horizon: [0.8, 0.55, 0.42], fog: [0.6, 0.48, 0.44] },
        landmark: "cone",
    },
    {
        id: "delta", name: "Mudflat Delta", unlock: { biome: "ash", distance: 2000 },
        blurb: "The tide floods the low road. Mud drags at your wheels.",
        changes: { heave: 2, slump: 2, fault: 1 }, calm: 200,
        octaves: [[100, 5], [38, 3], [14, 0.8], [6, 0.12]], grow: 0.5, slopeMax: 0.85,
        surface: (x, y) => (y < -0.6 ? "mud" : "ground"), tide: { low: -3.4, high: -0.9 },
        colors: { top: [0.5, 0.45, 0.3], soil: [0.42, 0.35, 0.23], rock: [0.3, 0.24, 0.17], deep: [0.18, 0.15, 0.11], far: [0.6, 0.66, 0.6], mid: [0.42, 0.5, 0.4], near: [0.3, 0.36, 0.26] },
        sky: { zenith: [0.3, 0.48, 0.58], horizon: [0.8, 0.86, 0.8], fog: [0.72, 0.78, 0.74] },
        landmark: "ferry",
    },
]);

export const RACE = Object.freeze({
    length: 2500,
    rivals: [
        { name: "Dusty", style: "careful", color: [0.85, 0.75, 0.45], vehicle: "van" },
        { name: "Vee", style: "reckless", color: [0.95, 0.25, 0.3], vehicle: "buggy" },
        { name: "Moss", style: "sneaky", color: [0.35, 0.7, 0.45], vehicle: "buggy" },
    ],
    difficulty: {
        easy: { react: 0.6, accuracy: 0.6, charge: 0.2, upgrades: 0 },
        normal: { react: 0.35, accuracy: 0.8, charge: 0.5, upgrades: 2 },
        hard: { react: 0.2, accuracy: 0.95, charge: 0.8, upgrades: 4 },
    },
    reward: [600, 300, 150, 50],
});

export const ACHIEVEMENTS = Object.freeze([
    { id: "first", name: "First delivery", help: "Finish a run." },
    { id: "km1", name: "One kilometre", help: "Drive 1 km in one run." },
    { id: "km3", name: "Long haul", help: "Drive 3 km in one run." },
    { id: "km5", name: "Beyond the map", help: "Drive 5 km in one run." },
    { id: "flip", name: "Head over wheels", help: "Land a flip." },
    { id: "flip3", name: "Triple", help: "Land three flips in one jump." },
    { id: "ride", name: "Surfer", help: "Ride a heave into a jump." },
    { id: "ride3", name: "Wave rider", help: "Ride 3 heaves in one run." },
    { id: "close", name: "Close call", help: "Get through a change just as it moves." },
    { id: "charge", name: "Earthshaker", help: "Use a tremor charge." },
    { id: "ramp", name: "Build your own ramp", help: "Jump off a ramp you made with a charge." },
    { id: "cache", name: "Treasure", help: "Find a hidden coin cache." },
    { id: "air3", name: "Hang time", help: "Stay in the air for 3 seconds." },
    { id: "glacier", name: "Into the cold", help: "Unlock Glacier Shelf." },
    { id: "ash", name: "Hot ground", help: "Unlock Ash Fields." },
    { id: "delta", name: "Tide table", help: "Unlock Mudflat Delta." },
    { id: "race", name: "Winner", help: "Win a race." },
    { id: "hardrace", name: "Fastest post", help: "Win a race on Hard." },
    { id: "garage", name: "Full garage", help: "Own all four vehicles." },
    { id: "maxed", name: "Fully loaded", help: "Max every upgrade on one vehicle." },
]);

/** Lines for the results card, by how the run ended. */
export const ENDINGS = Object.freeze({
    head: ["Pip is fine. The parcel is not.", "Helmet: 1, ground: 1.", "Pip will walk the rest of the way."],
    crack: ["The ground swallowed the mail.", "Return to sender: the bottom of a crack.", "Pip waves from the crack."],
    water: ["The engine took a bath.", "Delivered: to the fish.", "The tide wins this one."],
    fuel: ["Out of fuel. Pip pushes on foot.", "Running on fumes, then not.", "The tank is dry."],
    stuck: ["Wheels up. Mail down.", "Pip waits for a tow.", "Upside down and going nowhere."],
    finish: ["Delivered!", "Signed, sealed, delivered.", "First class."],
});
