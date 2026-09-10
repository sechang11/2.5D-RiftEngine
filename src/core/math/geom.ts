/** Intersection tests used by projectiles, targeting and line of sight. */

import type { Vec2 } from './vec2';
import { clamp01 } from './scalar';

/** Squared distance from a point to the segment ab. */
export function distSqPointSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const denom = abx * abx + aby * aby;
  const t = denom < 1e-12 ? 0 : clamp01((apx * abx + apy * aby) / denom);
  const dx = apx - abx * t;
  const dy = apy - aby * t;
  return dx * dx + dy * dy;
}

/** Parameter in [0,1] of the closest point on ab to p. */
export function closestTOnSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const denom = abx * abx + aby * aby;
  if (denom < 1e-12) return 0;
  return clamp01(((p.x - a.x) * abx + (p.y - a.y) * aby) / denom);
}

/** True when the capsule (segment ab, radius r) overlaps the circle at c. */
export function segmentHitsCircle(a: Vec2, b: Vec2, c: Vec2, r: number): boolean {
  return distSqPointSegment(c, a, b) <= r * r;
}

/**
 * Earliest time of impact in [0,1] for a point sweeping from a to b against a
 * circle, or -1 when it never touches.
 *
 * Projectiles need the *first* unit along their path, not merely any overlap,
 * so a boolean test is not enough: at high speed a bolt can pass through two
 * units in one tick and must hit the nearer one.
 */
export function sweepCircleEntry(a: Vec2, b: Vec2, c: Vec2, r: number): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const fx = a.x - c.x;
  const fy = a.y - c.y;
  const A = dx * dx + dy * dy;
  if (A < 1e-12) return fx * fx + fy * fy <= r * r ? 0 : -1;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - r * r;
  if (C <= 0) return 0; // already overlapping when the step began
  const disc = B * B - 4 * A * C;
  if (disc < 0) return -1;
  const t = (-B - Math.sqrt(disc)) / (2 * A);
  return t >= 0 && t <= 1 ? t : -1;
}

/** True when p lies in the circular sector centred on `facing` with half-angle `halfAngle`. */
export function pointInCone(
  p: Vec2,
  origin: Vec2,
  facing: Vec2,
  range: number,
  halfAngle: number,
): boolean {
  const dx = p.x - origin.x;
  const dy = p.y - origin.y;
  const d2 = dx * dx + dy * dy;
  if (d2 > range * range) return false;
  if (d2 < 1e-9) return true;
  const d = Math.sqrt(d2);
  const cosA = (dx * facing.x + dy * facing.y) / d;
  return cosA >= Math.cos(halfAngle);
}

export function circlesOverlap(a: Vec2, ra: number, b: Vec2, rb: number): boolean {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const r = ra + rb;
  return dx * dx + dy * dy < r * r;
}

/** Axis-aligned rectangle against a circle, for nav-cell blockers. */
export function circleHitsAabb(
  cx: number,
  cy: number,
  r: number,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
): boolean {
  const nx = cx < minX ? minX : cx > maxX ? maxX : cx;
  const ny = cy < minY ? minY : cy > maxY ? maxY : cy;
  const dx = cx - nx;
  const dy = cy - ny;
  return dx * dx + dy * dy < r * r;
}
