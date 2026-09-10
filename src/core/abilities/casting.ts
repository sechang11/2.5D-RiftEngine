/**
 * The cast pipeline: validate, commit, wind up, fire, recover.
 *
 * Casting is a small state machine rather than an immediate function call
 * because the windup is where most of a MOBA's counterplay lives. A spell that
 * resolves on the same tick the key is pressed cannot be interrupted, cannot be
 * dodged on reaction, and gives the renderer nothing to telegraph.
 *
 * Resources and cooldowns are committed at the *start* of the windup. Getting
 * stunned mid-cast costs you the spell, which is the behaviour players expect.
 */

import type { World } from '../ecs/world';
import type { Unit } from '../ecs/types';
import { CastPhase, NO_ENTITY, UnitFlag } from '../ecs/types';
import type { EntityId } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { canCast as unitCanCast, isStunned } from '../combat/stats';
import { faceInstantly } from '../sim/locomotion';
import * as V from '../math/vec2';
import { vec2 } from '../math/vec2';
import type { AbilityContext, AbilityDef } from './types';
import { CastRejection, getAbility, Targeting } from './types';

const scratchPoint = vec2();

export function findSlot(unit: Unit, slot: number): AbilityDef | undefined {
  const inst = unit.abilities[slot];
  return inst ? getAbility(inst.defId) : undefined;
}

/**
 * Checks everything that could refuse a cast without changing any state.
 * The HUD calls this every frame to grey out unusable buttons, so it must stay
 * side-effect free.
 */
export function validateCast(
  world: World,
  unit: Unit,
  slot: number,
  point: V.Vec2,
  target: EntityId,
): CastRejection {
  if (!unit.alive || unit.hp <= 0) return CastRejection.Dead;
  const inst = unit.abilities[slot];
  if (!inst) return CastRejection.NoAbility;
  const def = getAbility(inst.defId);
  if (!def) return CastRejection.NoAbility;
  if (inst.cooldown > 0) return CastRejection.OnCooldown;
  if (unit.mp < def.manaCost) return CastRejection.NotEnoughMana;
  if (isStunned(unit)) return CastRejection.Silenced;
  if (!unitCanCast(unit)) return CastRejection.Silenced;
  if (unit.cast) return CastRejection.AlreadyCasting;

  if (def.targeting === Targeting.Unit) {
    const t = world.getTargetable(target);
    if (!t) return CastRejection.NoTarget;
    if (world.gap(unit, t) > def.range) return CastRejection.OutOfRange;
  }

  if (def.canCast && !def.canCast(world, unit, target, point)) return CastRejection.Blocked;
  return CastRejection.Ok;
}

/**
 * Commits a cast. Point-targeted spells clamp the requested position to cast
 * range rather than failing, which is how every MOBA behaves: clicking past
 * max range casts at max range instead of doing nothing.
 */
export function tryCast(
  world: World,
  unit: Unit,
  slot: number,
  point: V.Vec2,
  target: EntityId = NO_ENTITY,
): CastRejection {
  const verdict = validateCast(world, unit, slot, point, target);
  if (verdict !== CastRejection.Ok) return verdict;

  const inst = unit.abilities[slot];
  const def = getAbility(inst.defId)!;

  V.copy(scratchPoint, point);
  if (def.targeting === Targeting.Point || def.targeting === Targeting.Direction) {
    clampToRange(scratchPoint, unit.pos, def.range);
  } else if (def.targeting === Targeting.Unit) {
    const t = world.get(target)!;
    V.copy(scratchPoint, t.pos);
  } else {
    V.copy(scratchPoint, unit.pos);
  }

  unit.mp -= def.manaCost;
  inst.cooldown = def.cooldown;

  unit.cast = {
    slot,
    phase: CastPhase.Windup,
    timer: def.castTime,
    point: vec2(scratchPoint.x, scratchPoint.y),
    target,
    locksMovement: def.locksMovement,
  };

  if (def.targeting !== Targeting.Self) faceInstantly(unit, scratchPoint);

  world.events.push(SimEventType.CastStart, world.tick, {
    source: unit.id,
    target,
    x: scratchPoint.x,
    y: scratchPoint.y,
    tag: def.id,
  });

  // Zero-windup spells still pass through the state machine so that recovery,
  // events and interrupts all behave identically for instant and slow casts.
  if (def.castTime <= 0) advanceCast(world, unit, 0);
  return CastRejection.Ok;
}

function clampToRange(point: V.Vec2, origin: V.Vec2, range: number): void {
  if (range <= 0) {
    V.copy(point, origin);
    return;
  }
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const d = Math.hypot(dx, dy);
  if (d <= range || d < 1e-6) return;
  point.x = origin.x + (dx / d) * range;
  point.y = origin.y + (dy / d) * range;
}

export function cancelCast(world: World, unit: Unit, reason: string): void {
  if (!unit.cast) return;
  const inst = unit.abilities[unit.cast.slot];
  world.events.push(SimEventType.CastCancel, world.tick, {
    source: unit.id,
    x: unit.pos.x,
    y: unit.pos.y,
    tag: inst ? inst.defId : reason,
  });
  unit.cast = null;
}

/** Drives the cast state machine for every unit. */
export function updateCasts(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (!unit.cast) continue;

    if (unit.hp <= 0) {
      unit.cast = null;
      continue;
    }
    // Hard crowd control eats the cast. The cooldown and mana are already spent.
    if (isStunned(unit)) {
      cancelCast(world, unit, 'interrupted');
      continue;
    }
    advanceCast(world, unit, dt);
  }
}

function advanceCast(world: World, unit: Unit, dt: number): void {
  const cast = unit.cast;
  if (!cast) return;
  cast.timer -= dt;
  if (cast.timer > 0) return;

  const inst = unit.abilities[cast.slot];
  const def = inst ? getAbility(inst.defId) : undefined;
  if (!def) {
    unit.cast = null;
    return;
  }

  switch (cast.phase) {
    case CastPhase.Windup: {
      fire(world, unit, def, cast.point, cast.target, inst.rank);
      if (def.recovery > 0) {
        cast.phase = CastPhase.Recovery;
        cast.timer = def.recovery;
        cast.locksMovement = false; // recovery never roots the caster
      } else {
        unit.cast = null;
      }
      break;
    }
    case CastPhase.Channel:
    case CastPhase.Recovery:
      unit.cast = null;
      break;
  }
}

function fire(
  world: World,
  unit: Unit,
  def: AbilityDef,
  point: V.Vec2,
  target: EntityId,
  rank: number,
): void {
  world.events.push(SimEventType.CastFire, world.tick, {
    source: unit.id,
    target,
    x: point.x,
    y: point.y,
    tag: def.id,
  });

  const ctx: AbilityContext = { world, caster: unit, def, point, target, rank };
  def.onCast?.(ctx);
}

/** Ticks every ability cooldown. Separate from casting so it runs while dead. */
export function updateCooldowns(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const abilities = units[i].abilities;
    for (let a = 0; a < abilities.length; a++) {
      if (abilities[a].cooldown > 0) {
        abilities[a].cooldown = Math.max(0, abilities[a].cooldown - dt);
      }
    }
  }
}

/** True when the unit is locked in a windup and should not accept move orders. */
export function isCastLocked(unit: Unit): boolean {
  return unit.cast !== null && unit.cast.locksMovement;
}

/** Debug helper used by the sandbox: wipes every cooldown on a unit. */
export function refreshAbilities(unit: Unit): void {
  for (let i = 0; i < unit.abilities.length; i++) unit.abilities[i].cooldown = 0;
  unit.mp = unit.stats.mpMax;
  unit.flags |= UnitFlag.Targetable;
}
