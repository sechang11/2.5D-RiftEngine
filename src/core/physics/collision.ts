/**
 * Unit-versus-unit separation.
 *
 * This is a positional solver, not an impulse solver. Bodies that overlap are
 * pushed apart and their velocities are left alone. That single choice is what
 * produces the MOBA feel: units squeeze past each other and slide along a wall
 * of bodies instead of bouncing off like billiard balls. An impulse solver here
 * would make a minion wave behave like a pile of marbles.
 *
 * Determinism comes from resolving pairs in a fixed order (the broadphase emits
 * them by cell) and from breaking exact-overlap ties with entity id rather than
 * a random jitter.
 */

import type { World } from '../ecs/world';
import type { Unit } from '../ecs/types';
import { UnitFlag } from '../ecs/types';

/**
 * Fraction of the overlap corrected per iteration. Correcting the full overlap
 * in one step makes dense crowds explode outward; this softens it so pressure
 * spreads through the pile over a few iterations.
 */
const CORRECTION = 0.7;

/**
 * Overlap tolerated without correction. Prevents two touching units from
 * trading sub-millimetre pushes forever, which shows up as visible shimmer.
 */
const SLOP = 0.004;

const canPush = (u: Unit): boolean =>
  (u.flags & UnitFlag.Collides) !== 0 && (u.flags & UnitFlag.Ghosted) === 0;

const inverseMass = (u: Unit): number =>
  u.flags & UnitFlag.Immovable ? 0 : 1 / Math.max(0.05, u.mass);

export interface CollisionStats {
  pairsTested: number;
  pairsResolved: number;
  terrainCorrections: number;
}

export function resolveCollisions(
  world: World,
  iterations: number,
  stats: CollisionStats,
): void {
  stats.pairsTested = 0;
  stats.pairsResolved = 0;
  stats.terrainCorrections = 0;

  const units = world.units;

  for (let iter = 0; iter < iterations; iter++) {
    world.hash.forEachPair((ia, ib) => {
      const a = units[ia];
      const b = units[ib];
      stats.pairsTested++;

      if (!canPush(a) || !canPush(b)) return;
      if (a.hp <= 0 || b.hp <= 0) return;

      const invA = inverseMass(a);
      const invB = inverseMass(b);
      const invSum = invA + invB;
      if (invSum <= 0) return; // two immovable bodies: nothing to do

      let dx = b.pos.x - a.pos.x;
      let dy = b.pos.y - a.pos.y;
      const minDist = a.radius + b.radius;
      const d2 = dx * dx + dy * dy;
      if (d2 >= minDist * minDist) return;

      let dist = Math.sqrt(d2);
      if (dist < 1e-6) {
        // Perfectly co-located. Pick a stable direction from the id pair so the
        // same situation always separates the same way.
        const seed = (a.id * 2654435761 + b.id) >>> 0;
        const angle = (seed % 6283) / 1000;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        dist = 1;
      } else {
        dx /= dist;
        dy /= dist;
      }

      const overlap = minDist - dist - SLOP;
      if (overlap <= 0) return;

      const push = (overlap * CORRECTION) / invSum;
      a.pos.x -= dx * push * invA;
      a.pos.y -= dy * push * invA;
      b.pos.x += dx * push * invB;
      b.pos.y += dy * push * invB;
      stats.pairsResolved++;
    });
  }

  // Separation can shove a body into a wall, so terrain is corrected last and
  // wins. A unit clipped inside geometry is far worse than one slightly
  // overlapping a neighbour.
  const nav = world.nav;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.flags & UnitFlag.Immovable) continue;
    if (u.hp <= 0) continue;
    if (nav.resolveTerrain(u.pos, u.radius)) stats.terrainCorrections++;
  }
}
