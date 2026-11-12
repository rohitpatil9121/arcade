import { Geometry, ShaderMaterial, primitives, projectionChunk, mat4, quat } from "../engine/index.js";

/**
 * FAULTLINE: shapes and materials made in code. Vehicles, the driver, pickups and landmarks are built from
 * primitives and merged into one geometry each, coloured per part, so a vehicle is a handful of draw calls.
 * Body space is the physics plane: x forward, z up, y is depth (towards the back of the track).
 * @module game/gfx
 */

/** a part for Geometry.merge: geometry, placed, rotated (radians, applied z, y, x), scaled, coloured */
export function part(geometry, at = [0, 0, 0], rot = [0, 0, 0], scale = [1, 1, 1], color = [1, 1, 1]) {
    const q = quat.create();
    quat.fromEuler(q, (rot[0] * 180) / Math.PI, (rot[1] * 180) / Math.PI, (rot[2] * 180) / Math.PI, "zyx");
    const m = mat4.create();
    mat4.fromRotationTranslationScale(m, q, at, scale);
    return { geometry, matrix: m, color };
}

const AXLE = [Math.PI / 2, 0, 0];          // turns a z-axis cylinder to lie along y
const C = {
    tyre: [0.13, 0.12, 0.13], rim: [0.82, 0.8, 0.76], dark: [0.16, 0.15, 0.17], glass: [0.28, 0.42, 0.5],
    steel: [0.6, 0.62, 0.66], skin: [0.98, 0.75, 0.58], suit: [0.25, 0.32, 0.55], light: [1, 0.95, 0.75],
    mail: [0.96, 0.94, 0.88], seat: [0.3, 0.22, 0.18],
};

/** a wheel: tyre, rim, and spokes so its turning shows. Axle along y, both sides of the vehicle in one. */
export function wheelGeometry(r, hub = [0.82, 0.8, 0.76], half = 0.72) {
    const parts = [];
    for (const side of [-half, half]) {
        parts.push(part(primitives.cylinder(r, r, 0.34, 20), [0, side, 0], AXLE, [1, 1, 1], C.tyre));
        parts.push(part(primitives.cylinder(r * 0.56, r * 0.56, 0.36, 14), [0, side, 0], AXLE, [1, 1, 1], hub));
        parts.push(part(primitives.box(r * 1.5, 0.37, r * 0.16), [0, side, 0], [0, 0, 0], [1, 1, 1], C.dark));
        parts.push(part(primitives.box(r * 0.16, 0.37, r * 1.5), [0, side, 0], [0, 0, 0], [1, 1, 1], C.dark));
        // tread blocks
        for (let i = 0; i < 10; i++) {
            const a = (i / 10) * Math.PI * 2;
            parts.push(part(primitives.box(0.09, 0.36, 0.07), [Math.cos(a) * r, side, Math.sin(a) * r], [0, -a, 0], [1, 1, 1], C.tyre));
        }
    }
    return Geometry.merge(parts, { name: "wheel" });
}

/** Pip: suit, scarf, round helmeted head. Origin at the seat; head centre at `head` (relative). */
function driverParts(head, helmet) {
    const [hx, hz] = head;
    return [
        part(primitives.capsule(0.22, 0.28, 6, 12), [hx, 0, hz - 0.62], [0, 0, 0], [1, 1, 1], C.suit),
        part(primitives.cylinder(0.24, 0.2, 0.08, 14), [hx, 0, hz - 0.33], [0, 0, 0], [1, 1, 1], [0.95, 0.3, 0.25]),
        part(primitives.sphere(0.28, 18, 12), [hx, 0, hz], [0, 0, 0], [1, 1, 1], C.skin),
        part(primitives.sphere(0.3, 18, 12), [hx - 0.03, 0, hz + 0.05], [0, 0, 0], [1, 0.98, 0.84], helmet),
        part(primitives.box(0.08, 0.34, 0.12), [hx + 0.24, 0, hz + 0.03], [0, 0.15, 0], [1, 1, 1], [0.1, 0.12, 0.16]),
        part(primitives.sphere(0.045, 8, 6), [hx + 0.25, -0.1, hz - 0.06], [0, 0, 0], [1, 1, 1], [0.1, 0.08, 0.08]),
        part(primitives.sphere(0.045, 8, 6), [hx + 0.25, 0.1, hz - 0.06], [0, 0, 0], [1, 1, 1], [0.1, 0.08, 0.08]),
        // arms reaching for the wheel
        part(primitives.capsule(0.07, 0.4, 4, 8), [hx + 0.25, -0.2, hz - 0.62], [0, 1.2, 0], [1, 1, 1], C.suit),
        part(primitives.capsule(0.07, 0.4, 4, 8), [hx + 0.25, 0.2, hz - 0.62], [0, 1.2, 0], [1, 1, 1], C.suit),
    ];
}

/**
 * The chassis and driver for a vehicle spec, in body space centred on the centre of mass.
 * @param {object} spec an entry of VEHICLES
 * @param {number[]} paint body colour
 * @param {number[]} helmet helmet colour
 * @param {boolean} [withDriver] false when Pip comes from a model file instead
 */
export function vehicleGeometry(spec, paint, helmet = [1, 0.85, 0.2], withDriver = true) {
    const P = [];
    const [bx, by] = spec.body;
    const dim = (c, k) => c.map((v) => v * k);
    const head = spec.head;
    switch (spec.id) {
        case "buggy":
            P.push(part(primitives.box(bx * 2, 1.25, by * 1.3), [0, 0, -by * 0.2], [0, 0, 0], [1, 1, 1], paint));
            P.push(part(primitives.box(0.8, 1.15, 0.3), [bx - 0.25, 0, by * 0.25], [0, -0.35, 0], [1, 1, 1], paint));
            P.push(part(primitives.box(0.5, 1.3, 0.22), [-bx + 0.15, 0, by * 0.1], [0, 0, 0], [1, 1, 1], dim(paint, 0.7)));
            P.push(part(primitives.box(0.55, 0.6, 0.12), [head[0], 0, by * 0.45], [0, 0, 0], [1, 1, 1], C.seat));
            // roll cage
            for (const y of [-0.5, 0.5]) {
                P.push(part(primitives.cylinder(0.04, 0.04, 1.25, 6), [head[0] - 0.42, y, by + 0.45], [0, 0.25, 0], [1, 1, 1], C.steel));
                P.push(part(primitives.cylinder(0.04, 0.04, 1.2, 6), [head[0] + 0.3, y, by + 0.4], [0, -0.45, 0], [1, 1, 1], C.steel));
            }
            P.push(part(primitives.cylinder(0.04, 0.04, 1.0, 6), [head[0] - 0.25, 0, by + 1.05], AXLE, [1, 1, 1], C.steel));
            P.push(part(primitives.cylinder(0.06, 0.06, 0.7, 8), [-bx - 0.05, -0.45, by * 0.4], [0, 1.2, 0], [1, 1, 1], C.steel));
            P.push(part(primitives.cylinder(0.3, 0.3, 0.14, 14), [-bx - 0.2, 0, by * 0.5], [0, 1.2, 0], [1, 1, 1], C.tyre));
            for (const y of [-0.45, 0.45]) P.push(part(primitives.sphere(0.09, 8, 6), [bx + 0.02, y, by * 0.1], [0, 0, 0], [1, 1, 1], C.light));
            break;
        case "van":
            P.push(part(primitives.box(bx * 2, 1.5, by * 2), [0, 0, 0], [0, 0, 0], [1, 1, 1], paint));
            P.push(part(primitives.box(bx * 2 + 0.02, 1.52, 0.18), [0, 0, -by * 0.2], [0, 0, 0], [1, 1, 1], C.mail));
            P.push(part(primitives.box(0.5, 1.4, by * 1.1), [bx + 0.05, 0, -by * 0.3], [0, -0.2, 0], [1, 1, 1], paint));
            P.push(part(primitives.box(0.08, 1.3, by * 0.7), [bx * 0.72, 0, by * 0.45], [0, -0.25, 0], [1, 1, 1], C.glass));
            P.push(part(primitives.cylinder(0.32, 0.32, 0.12, 14), [head[0], 0, by + 0.02], [0, 0, 0], [1, 1, 1], C.dark));
            P.push(part(primitives.box(1.6, 1.3, 0.08), [-0.4, 0, by + 0.04], [0, 0, 0], [1, 1, 1], dim(paint, 0.8)));
            for (const y of [-0.55, 0.55]) P.push(part(primitives.sphere(0.1, 8, 6), [bx + 0.28, y, -by * 0.35], [0, 0, 0], [1, 1, 1], C.light));
            P.push(part(primitives.box(0.3, 0.05, 0.3), [-bx * 0.3, -0.76, 0.05], [0, 0, 0], [1, 1, 1], [0.85, 0.2, 0.18]));
            break;
        case "tractor":
            P.push(part(primitives.box(bx * 2, 1.0, by * 2), [0.1, 0, 0], [0, 0, 0], [1, 1, 1], paint));
            P.push(part(primitives.box(1.3, 0.9, by * 1.6), [bx * 0.55, 0, by * 0.9], [0, 0, 0], [1, 1, 1], paint));
            P.push(part(primitives.box(0.08, 0.92, by * 1.3), [bx * 0.55 + 0.66, 0, by * 0.9], [0, 0, 0], [1, 1, 1], C.dark));
            P.push(part(primitives.cylinder(0.07, 0.07, 1.0, 8), [bx * 0.5, -0.25, by * 2.2], [0, 0, 0], [1, 1, 1], C.dark));
            P.push(part(primitives.box(0.6, 0.7, 0.14), [head[0], 0, by * 1.1], [0, 0, 0], [1, 1, 1], C.seat));
            for (const x of [head[0] - 0.4, head[0] + 0.45]) for (const y of [-0.45, 0.45]) P.push(part(primitives.cylinder(0.035, 0.035, 1.3, 6), [x, y, by * 1.1 + 0.65], [0, 0, 0], [1, 1, 1], C.steel));
            P.push(part(primitives.box(1.15, 1.1, 0.07), [head[0] + 0.02, 0, by * 1.1 + 1.32], [0, 0, 0], [1, 1, 1], [0.95, 0.85, 0.3]));
            P.push(part(primitives.box(0.5, 1.1, 0.35), [-bx - 0.15, 0, -by * 0.3], [0, 0, 0], [1, 1, 1], C.dark));
            for (const y of [-0.42, 0.42]) P.push(part(primitives.sphere(0.09, 8, 6), [bx + 0.22, y, by * 0.6], [0, 0, 0], [1, 1, 1], C.light));
            break;
        default: // kite kart
            P.push(part(primitives.box(bx * 2, 0.9, by * 1.4), [0, 0, -by * 0.3], [0, 0, 0], [1, 1, 1], paint));
            P.push(part(primitives.cone(0.3, 0.7, 10), [bx + 0.25, 0, -by * 0.3], [0, Math.PI / 2, 0], [1, 1.2, 0.5], paint));
            P.push(part(primitives.box(0.45, 0.55, 0.1), [head[0], 0, by * 0.2], [0, 0, 0], [1, 1, 1], C.seat));
            P.push(part(primitives.cylinder(0.03, 0.03, 1.5, 6), [-bx * 0.6, 0, by + 0.65], [0, 0, 0], [1, 1, 1], C.steel));
            P.push(part(primitives.box(0.05, 0.02, 1.1), [-bx * 0.6 - 0.3, 0, by + 0.95], [0, 0.2, 0], [1.8, 1, 1], [1, 0.95, 0.9]));
            P.push(part(primitives.cone(0.55, 1.1, 3), [-bx * 0.6 - 0.32, 0, by + 0.85], [0, -Math.PI / 2, 0], [0.1, 1, 1], dim(paint, 1.1)));
            P.push(part(primitives.box(0.6, 1.0, 0.06), [-bx - 0.05, 0, by * 0.6], [0, 0.25, 0], [1, 1, 1], C.dark));
    }
    if (withDriver) P.push(...driverParts(head, helmet));
    const [cx, cy] = spec.com;
    const g = Geometry.merge(P, { name: spec.id });
    for (let i = 0; i < g.positions.length; i += 3) { g.positions[i] -= cx; g.positions[i + 2] -= cy; }
    g.computeBounds();
    return g;
}

/** Pip alone, in the same body space as vehicleGeometry: for vehicles drawn from a model file */
export function driverGeometry(spec, helmet = [1, 0.85, 0.2]) {
    const [cx, cy] = spec.com;
    const g = Geometry.merge(driverParts(spec.head, helmet), { name: "driver" });
    for (let i = 0; i < g.positions.length; i += 3) { g.positions[i] -= cx; g.positions[i + 2] -= cy; }
    g.computeBounds();
    return g;
}

/** a coin standing on its edge, facing the camera (spins about z) */
export function coinGeometry() {
    return Geometry.merge([
        part(primitives.cylinder(0.34, 0.34, 0.08, 18), [0, 0, 0], AXLE, [1, 1, 1], [1, 0.8, 0.25]),
        part(primitives.box(0.12, 0.1, 0.32), [0, 0, 0], [0, 0, 0], [1, 1, 1], [0.9, 0.62, 0.12]),
    ], { name: "coin" });
}

/** fuel: a tall green can with a handle (its shape tells it apart without colour) */
export function fuelGeometry() {
    return Geometry.merge([
        part(primitives.box(0.55, 0.32, 0.8), [0, 0, 0], [0, 0, 0], [1, 1, 1], [0.25, 0.75, 0.32]),
        part(primitives.box(0.4, 0.2, 0.08), [0, 0, 0.44], [0, 0, 0], [1, 1, 1], [0.2, 0.55, 0.25]),
        part(primitives.cylinder(0.06, 0.06, 0.18, 8), [0.18, 0, 0.5], [0, 0.5, 0], [1, 1, 1], [0.9, 0.85, 0.2]),
        part(primitives.box(0.56, 0.33, 0.1), [0, 0, -0.1], [0, 0, 0], [1, 1, 1], [0.95, 0.95, 0.9]),
    ], { name: "fuel" });
}

/** a tremor charge: a violet ball with spikes */
export function chargeGeometry() {
    const P = [part(primitives.sphere(0.3, 14, 10), [0, 0, 0], [0, 0, 0], [1, 1, 1], [0.6, 0.35, 0.95])];
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0.7, 0, 0.7], [-0.7, 0, 0.7], [0.7, 0, -0.7], [-0.7, 0, -0.7]];
    for (const [x, , z] of dirs) {
        const a = Math.atan2(x, z);
        P.push(part(primitives.cone(0.09, 0.28, 6), [x * 0.32, 0, z * 0.32], [0, a, 0], [1, 1, 1], [0.85, 0.7, 1]));
    }
    return Geometry.merge(P, { name: "charge" });
}

/** a distance post: a pole and a flag */
export function postGeometry() {
    return Geometry.merge([
        part(primitives.cylinder(0.06, 0.06, 2.2, 6), [0, 0, 1.1], [0, 0, 0], [1, 1, 1], [0.95, 0.95, 0.92]),
        part(primitives.box(0.7, 0.04, 0.42), [0.36, 0, 1.95], [0, 0, 0], [1, 1, 1], [0.95, 0.4, 0.2]),
    ], { name: "post" });
}

/** a lumpy rock for the foreground */
export function rockGeometry(seed) {
    const g = primitives.sphere(1, 9, 7);
    const p = g.positions;
    for (let i = 0; i < p.length; i += 3) {
        const k = 0.75 + 0.35 * Math.abs(Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453 % 1);
        p[i] *= k * 1.3; p[i + 1] *= k; p[i + 2] *= k * 0.8;
    }
    g.computeBounds();
    return g;
}

/** a grass tuft or ice shard (crossed blades) */
export function tuftGeometry() {
    const P = [];
    for (let i = 0; i < 5; i++) P.push(part(primitives.cone(0.07, 0.5 + (i % 3) * 0.15, 4), [(i - 2) * 0.09, (i % 2) * 0.08 - 0.04, 0.25], [((i - 2) * 0.25), 0, 0], [1, 1, 1], [1, 1, 1]));
    return Geometry.merge(P, { name: "tuft" });
}

/** each biome's far landmark, built big */
export function landmarkGeometry(kind) {
    const P = [];
    if (kind === "arch") {
        P.push(part(primitives.torus(14, 4, 10, 28), [0, 0, 0], [Math.PI / 2, 0, 0], [1, 1, 1], [0.78, 0.42, 0.28]));
        P.push(part(primitives.box(40, 12, 6), [0, 0, -3], [0, 0, 0], [1, 1, 1], [0.6, 0.32, 0.22]));
    } else if (kind === "tower") {
        P.push(part(primitives.cylinder(5, 8, 40, 7), [0, 0, 20], [0, 0, 0], [1, 1, 1], [0.8, 0.92, 1]));
        P.push(part(primitives.cone(6, 16, 7), [0, 0, 48], [0, 0, 0], [1, 1, 1], [0.92, 0.97, 1]));
        P.push(part(primitives.cylinder(3, 6, 26, 6), [14, 4, 13], [0, 0, 0.3], [1, 1, 1], [0.7, 0.85, 0.95]));
    } else if (kind === "cone") {
        P.push(part(primitives.cone(48, 46, 18), [0, 0, 23], [0, 0, 0], [1, 1, 1], [0.24, 0.2, 0.21]));
        P.push(part(primitives.cylinder(9, 9, 2, 16), [0, 0, 45], [0, 0, 0], [1, 1, 1], [1.6, 0.6, 0.2]));
    } else {
        P.push(part(primitives.box(34, 9, 7), [0, 0, 3], [0, 0, 0.08], [1, 1, 1], [0.55, 0.32, 0.22]));
        P.push(part(primitives.box(12, 7, 8), [-6, 0, 10], [0, 0, 0.08], [1, 1, 1], [0.9, 0.88, 0.82]));
        P.push(part(primitives.cylinder(1.4, 1.4, 9, 10), [-2, 0, 17], [0, 0, 0.08], [1, 1, 1], [0.85, 0.25, 0.2]));
    }
    return Geometry.merge(P, { name: kind });
}

const skyVertex = /* glsl */ `
${projectionChunk}
attribute vec3 a_position;
uniform mat4 u_model;
varying vec3 v_dir;
void main() {
    v_dir = a_position;
    gl_Position = projectLab((u_model * vec4(a_position, 1.0)).xyz);
}
`;
const skyFragment = /* glsl */ `
uniform vec3 u_sunDirection;
uniform vec3 u_sunColor;
uniform vec3 u_zenith;
uniform vec3 u_horizon;
varying vec3 v_dir;
void main() {
    vec3 d = normalize(v_dir);
    float h = max(d.z, 0.0);
    vec3 color = mix(u_horizon, u_zenith, pow(h, 0.55));
    float toward = max(dot(d, u_sunDirection), 0.0);
    color += u_sunColor * (pow(toward, 600.0) * 8.0 + pow(toward, 8.0) * 0.22);
    // a soft band of haze just above the horizon
    color = mix(color, u_horizon * 1.05, exp(-h * 18.0) * 0.5);
    if (d.z < 0.0) color = u_horizon * 0.9;
    gl_FragColor = vec4(color, 1.0);
}
`;
export function skyMaterial() {
    return new ShaderMaterial({ name: "faultline-sky", vertex: skyVertex, fragment: skyFragment, uniforms: { u_zenith: new Float32Array([0.24, 0.43, 0.61]), u_horizon: new Float32Array([0.62, 0.83, 0.9]) }, cull: "none", depthWrite: false });
}
