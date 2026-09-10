/**
 * The order layer: a unit's standing intent, and the per-tick decisions that
 * carry it out.
 *
 * This is the layer players actually feel. Each order is a small policy about
 * when to walk, when to stop, and when to swing:
 *
 *   MoveTo        walk there, ignore everything
 *   AttackMove    walk there, but stop and kill anything that comes in range
 *   AttackUnit    chase this unit until it dies, however far it runs
 *   HoldPosition  do not move, but defend yourself
 *   Stop          stand still
 *
 * Note that AttackMove deliberately does not chase. Holding ground and swinging
 * is the behaviour that makes attack-move useful for walking into a fight;
 * chasing is what the explicit attack order is for.
 */

import type { World } from '../ecs/world';
import type { EntityId, Unit } from '../ecs/types';
import { NO_ENTITY, OrderKind, UnitFlag } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { isStunned } from '../combat/stats';
import { attackReady, beginAttack, cancelAttack, isWindingUp } from '../combat/autoattack';
import { clearPath, faceTowards, hasPath, setDestination } from './locomotion';
import { isCastLocked } from '../abilities/casting';
import * as V from '../math/vec2';
import { vec2 } from '../math/vec2';

/** How close to the destination counts as arrived. */
const ARRIVAL_EPSILON = 0.18;

/** Extra reach when acquiring a target, so units commit slightly before range. */
const ACQUIRE_LEEWAY = 0.4;

/** Target is dropped once it exceeds attack range by this much. */
const DISENGAGE_LEEWAY = 1.6;

/** Seconds between target acquisition scans. Full-rate scanning is wasted work. */
const ACQUIRE_INTERVAL = 0.12;

/** A chase repaths once the target has drifted this far from the path's end. */
const CHASE_REPATH_DISTANCE = 1.25;

const scratch = vec2();

export function issueOrder(
  world: World,
  unit: Unit,
  kind: OrderKind,
  point?: V.Vec2,
  target: EntityId = NO_ENTITY,
): boolean {
  if (!unit.alive || unit.hp <= 0) return false;
  // A windup in progress is forfeited by any new order. This is what makes
  // cancelling your own attack animation to reposition possible.
  if (isWindingUp(unit)) cancelAttack(unit);

  unit.order.kind = kind;
  unit.order.target = target;
  if (point) V.copy(unit.order.point, point);
  unit.repathTimer = 0;
  unit.blockedTicks = 0;
  unit.userData.acq = 0;

  switch (kind) {
    case OrderKind.Stop:
    case OrderKind.HoldPosition:
      clearPath(unit);
      V.copy(unit.order.point, unit.pos);
      break;
    case OrderKind.MoveTo:
    case OrderKind.AttackMove:
      if (!setDestination(world, unit, unit.order.point)) {
        unit.order.kind = OrderKind.Stop;
        return false;
      }
      break;
    case OrderKind.AttackUnit: {
      const t = world.getTargetable(target);
      if (!t) {
        unit.order.kind = OrderKind.Stop;
        return false;
      }
      V.copy(unit.order.point, t.pos);
      break;
    }
  }

  world.events.push(SimEventType.OrderIssued, world.tick, {
    source: unit.id,
    target,
    x: unit.order.point.x,
    y: unit.order.point.y,
    amount: kind,
  });
  return true;
}

export function updateOrders(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.hp <= 0 || !unit.alive) continue;
    if (unit.flags & UnitFlag.Immovable) {
      updateTurret(world, unit, dt);
      continue;
    }
    // Stunned units keep their order but cannot act on it; it resumes on expiry.
    if (isStunned(unit)) continue;
    if (unit.dash) continue;

    unit.repathTimer -= dt;
    unit.userData.acq = (unit.userData.acq ?? 0) - dt;

    switch (unit.order.kind) {
      case OrderKind.MoveTo:
        updateMoveTo(world, unit);
        break;
      case OrderKind.AttackMove:
        updateAttackMove(world, unit, dt);
        break;
      case OrderKind.AttackUnit:
        updateAttackUnit(world, unit, dt);
        break;
      case OrderKind.HoldPosition:
      case OrderKind.Stop:
        updateIdle(world, unit, dt);
        break;
    }
  }
}

function updateMoveTo(world: World, unit: Unit): void {
  if (isCastLocked(unit)) return;

  if (V.dist(unit.pos, unit.order.point) <= ARRIVAL_EPSILON) {
    unit.order.kind = OrderKind.Stop;
    clearPath(unit);
    return;
  }

  if (!hasPath(unit) || unit.repathTimer <= 0) {
    if (!hasPath(unit)) {
      // Out of waypoints but not at the destination: either the route was
      // partial or the body was pushed off it. Either way, ask again.
      if (!setDestination(world, unit, unit.order.point)) {
        unit.order.kind = OrderKind.Stop;
      }
    } else {
      unit.repathTimer = 0.5;
    }
  }
}

function updateAttackMove(world: World, unit: Unit, dt: number): void {
  if (isCastLocked(unit)) return;

  const engaged = world.getTargetable(unit.order.target);
  if (engaged && world.isEnemy(unit, engaged)) {
    const gap = world.gap(unit, engaged);
    if (gap <= unit.stats.attackRange + DISENGAGE_LEEWAY) {
      // Hold and swing. Attack-move does not pursue.
      clearPath(unit);
      faceTowards(unit, engaged.pos, dt);
      if (attackReady(unit)) beginAttack(world, unit, engaged);
      return;
    }
    unit.order.target = NO_ENTITY;
  } else if (unit.order.target !== NO_ENTITY) {
    unit.order.target = NO_ENTITY;
  }

  if ((unit.userData.acq ?? 0) <= 0) {
    unit.userData.acq = ACQUIRE_INTERVAL;
    const found = world.nearestEnemy(unit, unit.stats.attackRange + ACQUIRE_LEEWAY);
    if (found) {
      unit.order.target = found.id;
      clearPath(unit);
      return;
    }
  }

  // Nothing to fight: continue to the destination.
  if (V.dist(unit.pos, unit.order.point) <= ARRIVAL_EPSILON) {
    unit.order.kind = OrderKind.Stop;
    clearPath(unit);
    return;
  }
  if (!hasPath(unit)) {
    if (!setDestination(world, unit, unit.order.point)) unit.order.kind = OrderKind.Stop;
  }
}

function updateAttackUnit(world: World, unit: Unit, dt: number): void {
  const target = world.getTargetable(unit.order.target);
  if (!target || target.hp <= 0) {
    unit.order.kind = OrderKind.Stop;
    unit.order.target = NO_ENTITY;
    clearPath(unit);
    return;
  }

  if (isCastLocked(unit)) {
    faceTowards(unit, target.pos, dt);
    return;
  }

  if (world.inAttackRange(unit, target)) {
    clearPath(unit);
    faceTowards(unit, target.pos, dt);
    if (attackReady(unit)) beginAttack(world, unit, target);
    return;
  }

  // Out of range: walk to the edge of attack range rather than to the target's
  // centre, so the unit stops as soon as it can actually swing.
  const desired = unit.stats.attackRange + target.radius + unit.radius - 0.25;
  V.direction(scratch, target.pos, unit.pos);
  scratch.x = target.pos.x + scratch.x * desired;
  scratch.y = target.pos.y + scratch.y * desired;

  const chaseX = unit.userData.chaseX ?? Infinity;
  const chaseY = unit.userData.chaseY ?? Infinity;
  const drifted = Math.hypot(target.pos.x - chaseX, target.pos.y - chaseY);

  if (!hasPath(unit) || (drifted > CHASE_REPATH_DISTANCE && unit.repathTimer <= 0)) {
    unit.userData.chaseX = target.pos.x;
    unit.userData.chaseY = target.pos.y;
    setDestination(world, unit, scratch);
  }
}

function updateIdle(world: World, unit: Unit, dt: number): void {
  // Champions do not pick their own fights while idle. Minions, monsters and
  // towers do, which is what `autoAcquire` marks.
  if (!unit.userData.autoAcquire) {
    const current = world.getTargetable(unit.attack.target);
    if (current && world.isEnemy(unit, current) && world.inAttackRange(unit, current)) {
      faceTowards(unit, current.pos, dt);
      if (attackReady(unit)) beginAttack(world, unit, current);
    }
    return;
  }

  if ((unit.userData.acq ?? 0) > 0) return;
  unit.userData.acq = ACQUIRE_INTERVAL;

  const found = world.nearestEnemy(unit, unit.stats.attackRange + ACQUIRE_LEEWAY);
  if (!found) return;
  faceTowards(unit, found.pos, dt);
  if (attackReady(unit)) beginAttack(world, unit, found);
}

/** Structures only pick targets and shoot. They never path or turn to chase. */
function updateTurret(world: World, unit: Unit, dt: number): void {
  if ((unit.userData.acq ?? 0) > 0) {
    unit.userData.acq = (unit.userData.acq ?? 0) - dt;
  } else {
    unit.userData.acq = 0.25;
    const current = world.getTargetable(unit.attack.target);
    const keep =
      current && world.isEnemy(unit, current) && world.gap(unit, current) <= unit.stats.attackRange;
    if (!keep) {
      const found = world.nearestEnemy(unit, unit.stats.attackRange);
      unit.attack.target = found ? found.id : NO_ENTITY;
    }
  }

  const target = world.getTargetable(unit.attack.target);
  if (!target) return;
  faceTowards(unit, target.pos, dt);
  if (attackReady(unit)) beginAttack(world, unit, target);
}
