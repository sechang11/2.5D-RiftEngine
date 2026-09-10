/**
 * Unit AI.
 *
 * Deliberately shallow: the AI only issues the same orders a player can issue,
 * through the same order layer. That constraint is load-bearing. A bot that
 * moved units directly would quietly diverge from player behaviour, and every
 * pathing or collision bug would then exist in two variants.
 *
 * Two archetypes cover everything on the map today:
 *
 *   Minions  walk a lane route, fight what steps in front of them, never
 *            abandon the route for long.
 *   Monsters sit on a camp, retaliate when struck, and leash home when dragged
 *            too far from their spawn.
 */

import type { World } from '../ecs/world';
import type { Unit } from '../ecs/types';
import { NO_ENTITY, OrderKind, UnitFlag, UnitKind } from '../ecs/types';
import { issueOrder } from '../sim/orders';
import { isStunned } from '../combat/stats';
import * as V from '../math/vec2';

/** Seconds between AI decisions. Units do not need to rethink every tick. */
const THINK_INTERVAL = 0.2;

/** How close a minion must get to a route node before advancing. */
const ROUTE_EPSILON = 2.2;

/** Seconds a monster stays aggressive after being hit. */
const ALERT_DURATION = 4;

export function updateBrains(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const brain = unit.brain;
    if (!brain) continue;
    if (unit.hp <= 0 || !unit.alive) continue;
    if (unit.flags & UnitFlag.Immovable) continue;

    if (brain.alertTimer > 0) brain.alertTimer -= dt;
    brain.retargetTimer -= dt;
    if (brain.retargetTimer > 0) continue;
    brain.retargetTimer = THINK_INTERVAL;

    if (isStunned(unit)) continue;

    if (unit.kind === UnitKind.Monster) thinkMonster(world, unit);
    else thinkMinion(world, unit);
  }
}

function thinkMinion(world: World, unit: Unit): void {
  const brain = unit.brain!;

  // Keep hitting the current target while it is alive and nearby.
  const current = world.getTargetable(unit.order.target);
  if (
    current &&
    world.isEnemy(unit, current) &&
    V.dist(unit.pos, current.pos) <= brain.aggroRange * 1.4
  ) {
    if (unit.order.kind !== OrderKind.AttackUnit) {
      issueOrder(world, unit, OrderKind.AttackUnit, undefined, current.id);
    }
    return;
  }

  const threat = pickTarget(world, unit, brain.aggroRange);
  if (threat) {
    issueOrder(world, unit, OrderKind.AttackUnit, undefined, threat.id);
    return;
  }

  // Nothing to fight: walk the route.
  if (brain.route.length === 0) {
    if (unit.order.kind !== OrderKind.Stop) issueOrder(world, unit, OrderKind.Stop);
    return;
  }

  const node = brain.route[brain.routeIndex];
  if (V.dist(unit.pos, node) <= ROUTE_EPSILON) {
    brain.routeIndex = Math.min(brain.routeIndex + 1, brain.route.length - 1);
    issueOrder(world, unit, OrderKind.AttackMove, brain.route[brain.routeIndex]);
    return;
  }

  const walking =
    unit.order.kind === OrderKind.AttackMove &&
    V.dist(unit.order.point, node) < 0.5 &&
    unit.path.length > 0;
  if (!walking) issueOrder(world, unit, OrderKind.AttackMove, node);
}

function thinkMonster(world: World, unit: Unit): void {
  const brain = unit.brain!;
  const fromHome = V.dist(unit.pos, brain.home);

  // Dragged too far: disengage, walk back, and regenerate on the way.
  if (fromHome > brain.leashRange) {
    unit.order.target = NO_ENTITY;
    if (unit.order.kind !== OrderKind.MoveTo || V.dist(unit.order.point, brain.home) > 1) {
      issueOrder(world, unit, OrderKind.MoveTo, brain.home);
    }
    return;
  }

  const current = world.getTargetable(unit.order.target);
  if (current && world.isEnemy(unit, current) && V.dist(current.pos, brain.home) <= brain.leashRange) {
    if (unit.order.kind !== OrderKind.AttackUnit) {
      issueOrder(world, unit, OrderKind.AttackUnit, undefined, current.id);
    }
    return;
  }

  // Camps only engage when provoked or when something walks right up to them.
  const provoked = brain.alertTimer > 0;
  const range = provoked ? brain.aggroRange : brain.aggroRange * 0.55;
  const threat = pickTarget(world, unit, range);
  if (threat) {
    issueOrder(world, unit, OrderKind.AttackUnit, undefined, threat.id);
    return;
  }

  if (fromHome > 1.5) {
    if (unit.order.kind !== OrderKind.MoveTo || V.dist(unit.order.point, brain.home) > 1) {
      issueOrder(world, unit, OrderKind.MoveTo, brain.home);
    }
  } else if (unit.order.kind !== OrderKind.HoldPosition) {
    issueOrder(world, unit, OrderKind.HoldPosition);
  }
}

/**
 * Target priority: whatever is closest, with champions discounted so a minion
 * standing between two options prefers the other minion. That is a simplified
 * version of League's priority table, which also weighs who attacked whom.
 */
function pickTarget(world: World, unit: Unit, range: number): Unit | null {
  let best: Unit | null = null;
  let bestScore = Infinity;
  const scratch: Unit[] = [];
  world.queryCircle(unit.pos.x, unit.pos.y, range, scratch, (u) => {
    if (!world.isEnemy(unit, u)) return false;
    return (u.flags & UnitFlag.Targetable) !== 0;
  });

  for (let i = 0; i < scratch.length; i++) {
    const u = scratch[i];
    let score = V.dist(unit.pos, u.pos);
    if (u.kind === UnitKind.Champion) score += 2.5;
    if (u.kind === UnitKind.Structure) score += 6;
    if (score < bestScore) {
      bestScore = score;
      best = u;
    }
  }
  return best;
}

/** Called from the damage path so camps retaliate against whoever hit them. */
export function alertBrain(unit: Unit, attacker: Unit): void {
  const brain = unit.brain;
  if (!brain) return;
  brain.alertTimer = ALERT_DURATION;
  brain.retargetTimer = 0;
  if (unit.order.target === NO_ENTITY) unit.order.target = attacker.id;
}
