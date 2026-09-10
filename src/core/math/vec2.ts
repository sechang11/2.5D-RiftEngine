/**
 * 2D vector math for the simulation plane.
 *
 * The entire simulation lives on the XZ plane (height is purely a rendering
 * concern), so sim code never touches a 3-component vector. Vectors are plain
 * objects so they can be structurally cloned into a worker or serialized into
 * a replay file.
 *
 * Functions are pure unless they take an explicit `out` parameter. Hot loops
 * use the `out` variants to stay allocation-free.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export const vec2 = (x = 0, y = 0): Vec2 => ({ x, y });
export const clone = (a: Vec2): Vec2 => ({ x: a.x, y: a.y });

export function set(out: Vec2, x: number, y: number): Vec2 {
  out.x = x;
  out.y = y;
  return out;
}

export function copy(out: Vec2, a: Vec2): Vec2 {
  out.x = a.x;
  out.y = a.y;
  return out;
}

export function add(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x + b.x;
  out.y = a.y + b.y;
  return out;
}

export function sub(out: Vec2, a: Vec2, b: Vec2): Vec2 {
  out.x = a.x - b.x;
  out.y = a.y - b.y;
  return out;
}

export function scale(out: Vec2, a: Vec2, s: number): Vec2 {
  out.x = a.x * s;
  out.y = a.y * s;
  return out;
}

/** out = a + b * s. The workhorse of every integrator in the engine. */
export function addScaled(out: Vec2, a: Vec2, b: Vec2, s: number): Vec2 {
  out.x = a.x + b.x * s;
  out.y = a.y + b.y * s;
  return out;
}

export function lerp(out: Vec2, a: Vec2, b: Vec2, t: number): Vec2 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  return out;
}

export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.y * b.y;

/** Z component of the 3D cross product. Positive when b is counter-clockwise from a. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.y - a.y * b.x;

export const lenSq = (a: Vec2): number => a.x * a.x + a.y * a.y;
export const len = (a: Vec2): number => Math.sqrt(a.x * a.x + a.y * a.y);

export function distSq(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.sqrt(distSq(a, b));
}

/** Normalizes in place. A zero-length vector stays at zero rather than becoming NaN. */
export function normalize(out: Vec2, a: Vec2): Vec2 {
  const l = Math.sqrt(a.x * a.x + a.y * a.y);
  if (l < 1e-9) {
    out.x = 0;
    out.y = 0;
    return out;
  }
  out.x = a.x / l;
  out.y = a.y / l;
  return out;
}

/** Unit vector from `from` towards `to`. Returns zero when the points coincide. */
export function direction(out: Vec2, from: Vec2, to: Vec2): Vec2 {
  sub(out, to, from);
  return normalize(out, out);
}

/** Clamps magnitude to `max` without changing direction. */
export function truncate(out: Vec2, a: Vec2, max: number): Vec2 {
  const l2 = a.x * a.x + a.y * a.y;
  if (l2 > max * max && l2 > 1e-12) {
    const s = max / Math.sqrt(l2);
    out.x = a.x * s;
    out.y = a.y * s;
  } else {
    out.x = a.x;
    out.y = a.y;
  }
  return out;
}

/** Rotates 90 degrees counter-clockwise. Used for skillshot width and flank offsets. */
export function perp(out: Vec2, a: Vec2): Vec2 {
  const x = a.x;
  out.x = -a.y;
  out.y = x;
  return out;
}

export function rotate(out: Vec2, a: Vec2, radians: number): Vec2 {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const x = a.x;
  const y = a.y;
  out.x = x * c - y * s;
  out.y = x * s + y * c;
  return out;
}

/** Facing angle measured so that +y is zero and the angle grows clockwise. */
export const angleOf = (a: Vec2): number => Math.atan2(a.x, a.y);

export function fromAngle(out: Vec2, radians: number, length = 1): Vec2 {
  out.x = Math.sin(radians) * length;
  out.y = Math.cos(radians) * length;
  return out;
}

/** Shortest signed delta between two angles, in (-PI, PI]. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export const ZERO: Readonly<Vec2> = Object.freeze({ x: 0, y: 0 });
