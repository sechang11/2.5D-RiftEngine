/**
 * Path following, turning and dashes.
 *
 * Units do not steer. They walk their string-pulled path at full speed and turn
 * the mesh to match, which is what click-to-move games do: acceleration curves
 * make a unit feel unresponsive to a player who expects the character to leave
 * the instant they click.
 *
 * The interesting work here is failure handling. Bodies get shoved off their
 * path by the collision solver, and a unit that keeps walking into a jam has to
 * notice and ask for a new route rather than grinding forever.
 */

import type { World } from '../ecs/world';
import type { Unit } from '../ecs/types';
import { UnitFlag } from '../ecs/types';
import { isImmobilized } from '../combat/stats';
import * as V from '../math/vec2';
import { vec2 } from '../math/vec2';
import { angleDelta } from '../math/vec2';
import { clamp01, smoothstep } from '../math/scalar';

/** Radians per second a body rotates to face its direction of travel. */
const TURN_RATE = 12;

/** How close counts as reaching an intermediate waypoint. */
const WAYPOINT_EPSILON = 0.12;

/** Ticks of near-zero progress before a unit gives up and repaths. */
const STUCK_TICKS = 18;

/** Fraction of expected movement below which a tick counts as blocked. */
const STUCK_RATIO = 0.25;

const scratchDir = vec2();
const scratchTo = vec2();

export function clearPath(unit: Unit): void {
  unit.path.length = 0;
  unit.pathCursor = 0;
  unit.blockedTicks = 0;
  unit.vel.x = 0;
  unit.vel.y = 0;
}

export function hasPath(unit: Unit): boolean {
  return unit.pathCursor < unit.path.length;
}

/** Remaining distance along the path, for range checks and UI. */
export function pathRemaining(unit: Unit): number {
  if (!hasPath(unit)) return 0;
  let total = V.dist(unit.pos, unit.path[unit.pathCursor]);
  for (let i = unit.pathCursor; i < unit.path.length - 1; i++) {
    total += V.dist(unit.path[i], unit.path[i + 1]);
  }
  return total;
}

/**
 * Computes and assigns a route to `goal`. Returns false when nothing usable was
 * found, which the caller reports as a rejected order.
 */
export function setDestination(world: World, unit: Unit, goal: V.Vec2): boolean {
  const result = world.pathfinder.find({
    start: unit.pos,
    goal,
    radius: unit.radius,
  });
  unit.path = result.waypoints;
  unit.pathCursor = 0;
  unit.blockedTicks = 0;
  unit.repathTimer = 0.25;
  return result.waypoints.length > 0;
}

/**
 * Advances every unit along its path.
 *
 * `stopDistance` handling lives in the order layer; by the time a unit gets here
 * it either has a path to walk or it does not.
 */
export function updateLocomotion(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.hp <= 0) continue;

    if (unit.dash) {
      updateDash(world, unit, dt);
      continue;
    }

    if (unit.flags & UnitFlag.Immovable) {
      unit.vel.x = 0;
      unit.vel.y = 0;
      continue;
    }

    const speed = unit.stats.moveSpeed;
    if (speed <= 0 || isImmobilized(unit) || !hasPath(unit)) {
      unit.vel.x = 0;
      unit.vel.y = 0;
      if (unit.cast && unit.cast.locksMovement) faceTowards(unit, unit.cast.point, dt);
      continue;
    }

    // A cast that locks movement halts the walk without discarding the path, so
    // the unit resumes its journey when the cast finishes.
    if (unit.cast && unit.cast.locksMovement) {
      unit.vel.x = 0;
      unit.vel.y = 0;
      faceTowards(unit, unit.cast.point, dt);
      continue;
    }

    let budget = speed * dt;
    const startX = unit.pos.x;
    const startY = unit.pos.y;

    // Consume the movement budget across as many waypoints as it reaches, so a
    // fast unit is not capped at one waypoint per tick.
    while (budget > 0 && hasPath(unit)) {
      const wp = unit.path[unit.pathCursor];
      V.sub(scratchDir, wp, unit.pos);
      const d = V.len(scratchDir);

      if (d <= WAYPOINT_EPSILON) {
        unit.pathCursor++;
        continue;
      }

      const step = Math.min(budget, d);
      unit.pos.x += (scratchDir.x / d) * step;
      unit.pos.y += (scratchDir.y / d) * step;
      budget -= step;

      if (d - step <= WAYPOINT_EPSILON) unit.pathCursor++;
    }

    const movedX = unit.pos.x - startX;
    const movedY = unit.pos.y - startY;
    unit.vel.x = movedX / dt;
    unit.vel.y = movedY / dt;

    if (movedX !== 0 || movedY !== 0) {
      V.set(scratchTo, unit.pos.x + movedX, unit.pos.y + movedY);
      faceTowards(unit, scratchTo, dt);
    }

    // Progress check. The collision solver runs after this, so a unit wedged in
    // a crowd will show movement here and lose it again; comparing against the
    // *previous* tick's start position is what actually detects the jam.
    const progressed = Math.hypot(unit.pos.x - unit.prevPos.x, unit.pos.y - unit.prevPos.y);
    if (progressed < speed * dt * STUCK_RATIO) {
      unit.blockedTicks++;
    } else if (unit.blockedTicks > 0) {
      unit.blockedTicks -= 1;
    }

    if (unit.blockedTicks > STUCK_TICKS) {
      unit.blockedTicks = 0;
      unit.repathTimer = 0; // signals the order layer to recompute
    }

    if (!hasPath(unit)) {
      unit.vel.x = 0;
      unit.vel.y = 0;
    }
  }
}

/** Rotates a unit's facing towards a world point at a fixed angular rate. */
export function faceTowards(unit: Unit, point: V.Vec2, dt: number): void {
  const dx = point.x - unit.pos.x;
  const dy = point.y - unit.pos.y;
  if (dx * dx + dy * dy < 1e-8) return;
  const target = Math.atan2(dx, dy);
  const delta = angleDelta(unit.facing, target);
  const maxStep = TURN_RATE * dt;
  unit.facing += Math.abs(delta) <= maxStep ? delta : Math.sign(delta) * maxStep;
}

/** Snaps facing immediately. Casts point the character before the spell leaves. */
export function faceInstantly(unit: Unit, point: V.Vec2): void {
  const dx = point.x - unit.pos.x;
  const dy = point.y - unit.pos.y;
  if (dx * dx + dy * dy < 1e-8) return;
  unit.facing = Math.atan2(dx, dy);
}

/**
 * Starts a dash, clipping the destination to the furthest reachable point so a
 * blink never ends inside terrain.
 *
 * `hop` raises the mesh in an arc during travel. It is a pure view value, but it
 * lives on the sim state so the renderer stays a passive reader.
 */
export function startDash(
  world: World,
  unit: Unit,
  targetX: number,
  targetY: number,
  speed: number,
  hop = 0,
): boolean {
  const dx = targetX - unit.pos.x;
  const dy = targetY - unit.pos.y;
  const requested = Math.hypot(dx, dy);
  if (requested < 1e-4) return false;

  const dirX = dx / requested;
  const dirY = dy / requested;
  const reachable = world.nav.maxTravel(unit.pos, dirX, dirY, requested, unit.radius);
  if (reachable < 0.2) return false;

  unit.dash = {
    from: vec2(unit.pos.x, unit.pos.y),
    to: vec2(unit.pos.x + dirX * reachable, unit.pos.y + dirY * reachable),
    elapsed: 0,
    duration: Math.max(0.06, reachable / speed),
    hop,
    onArrive: 0,
  };
  clearPath(unit);
  faceInstantly(unit, unit.dash.to);
  // Dashes pass through bodies; without this a dash into a minion wave stops
  // dead at the first minion.
  unit.flags |= UnitFlag.Ghosted;
  return true;
}

function updateDash(world: World, unit: Unit, dt: number): void {
  const dash = unit.dash!;
  dash.elapsed += dt;
  const t = clamp01(dash.elapsed / dash.duration);
  // Slight ease-out reads as momentum without costing responsiveness.
  const eased = smoothstep(t * 0.5 + 0.5) * 2 - 1;
  const k = t < 1 ? Math.max(t, eased) : 1;

  unit.pos.x = dash.from.x + (dash.to.x - dash.from.x) * k;
  unit.pos.y = dash.from.y + (dash.to.y - dash.from.y) * k;
  unit.vel.x = (dash.to.x - dash.from.x) / dash.duration;
  unit.vel.y = (dash.to.y - dash.from.y) / dash.duration;

  if (t >= 1) {
    unit.dash = null;
    unit.flags &= ~UnitFlag.Ghosted;
    unit.vel.x = 0;
    unit.vel.y = 0;
    // Landing inside a crowd is legal; landing inside a wall is not.
    world.nav.resolveTerrain(unit.pos, unit.radius, 8);
  }
}

/** Vertical offset for the renderer during a dash arc. Zero at rest. */
export function dashHeight(unit: Unit): number {
  if (!unit.dash || unit.dash.hop <= 0) return 0;
  const t = clamp01(unit.dash.elapsed / unit.dash.duration);
  return Math.sin(t * Math.PI) * unit.dash.hop;
}
