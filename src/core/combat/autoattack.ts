/**
 * Auto-attack timing.
 *
 * The attack cycle has two clocks, and keeping them separate is what makes
 * attack speed feel right:
 *
 *   - `cooldown` counts the whole cycle, 1/attackSpeed seconds.
 *   - `windup` counts the portion before damage lands.
 *
 * Because they run concurrently, a faster attack speed shortens both, so a high
 * attack-speed unit both swings more often and connects sooner. Damage is
 * committed against the target captured when the windup began, which is why
 * stepping out of range after an attack starts does not save you, but killing the
 * attacker does.
 */

import type { World } from '../ecs/world';
import type { Unit } from '../ecs/types';
import { DamageType, NO_ENTITY, UnitFlag } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { applyDamage, attackInterval, canAttack } from './stats';
import { BASIC_ATTACK_ID } from './basicattack';
import { faceTowards } from '../sim/locomotion';
import * as V from '../math/vec2';
import { vec2 } from '../math/vec2';

/** Missile speed for ranged attacks, in world units per second. */
const MISSILE_SPEED = 26;

/** Attack range above which a unit is treated as ranged and fires a missile. */
const RANGED_THRESHOLD = 3;

const launchDir = vec2();

export const isWindingUp = (unit: Unit): boolean => unit.attack.windup >= 0;

export const attackReady = (unit: Unit): boolean =>
  unit.attack.cooldown <= 0 && unit.attack.windup < 0 && canAttack(unit);

/**
 * Begins a swing at `target`. Returns false when the attack could not start,
 * which the order layer reads as "keep chasing".
 */
export function beginAttack(world: World, unit: Unit, target: Unit): boolean {
  if (!attackReady(unit)) return false;
  if (!world.inAttackRange(unit, target)) return false;
  if (unit.cast) return false;

  const cycle = attackInterval(unit);
  unit.attack.cooldown = cycle;
  unit.attack.windup = cycle * unit.stats.attackWindup;
  unit.attack.target = target.id;
  return true;
}

export function cancelAttack(unit: Unit): void {
  unit.attack.windup = -1;
  unit.attack.target = NO_ENTITY;
}

export function updateAttacks(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (unit.hp <= 0) {
      cancelAttack(unit);
      continue;
    }

    if (unit.attack.cooldown > 0) unit.attack.cooldown -= dt;
    if (unit.attack.windup < 0) continue;

    // Hard CC and casting both abort a swing in progress.
    if (!canAttack(unit) || unit.cast) {
      cancelAttack(unit);
      continue;
    }

    const target = world.getTargetable(unit.attack.target);
    if (!target || target.hp <= 0) {
      cancelAttack(unit);
      continue;
    }

    faceTowards(unit, target.pos, dt);

    unit.attack.windup -= dt;
    if (unit.attack.windup > 0) continue;

    unit.attack.windup = -1;
    releaseAttack(world, unit, target);
  }
}

function releaseAttack(world: World, unit: Unit, target: Unit): void {
  const crit = unit.stats.critChance > 0 && world.rng.chance(unit.stats.critChance);
  const damage = unit.stats.attackDamage * (crit ? 1.75 : 1);

  if (unit.stats.attackRange >= RANGED_THRESHOLD) {
    // Ranged: spawn a homing missile. Travel time is real, so a kill can be
    // stolen or a target can die before the arrow lands.
    V.direction(launchDir, unit.pos, target.pos);
    world.spawnProjectile({
      owner: unit.id,
      team: unit.team,
      pos: unit.pos,
      dir: launchDir,
      speed: MISSILE_SPEED,
      radius: 0.2,
      maxRange: unit.stats.attackRange * 3 + 10,
      target: target.id,
      defId: BASIC_ATTACK_ID,
      pierce: 1,
      visual: unit.team === 1 ? 'bolt_blue' : 'bolt_red',
      power: damage,
      collidesTerrain: false,
    });
    return;
  }

  // Melee: resolve immediately at the end of the windup.
  const result = applyDamage(target, {
    amount: damage,
    type: DamageType.Physical,
    source: unit,
    tag: BASIC_ATTACK_ID,
  });

  if (result.dealt > 0 || result.absorbed > 0) {
    world.events.push(SimEventType.Damage, world.tick, {
      source: unit.id,
      target: target.id,
      x: target.pos.x,
      y: target.pos.y,
      amount: result.dealt,
      damageType: DamageType.Physical,
      tag: BASIC_ATTACK_ID,
      crit,
    });
  }
}

/** True when this unit fires missiles rather than striking in melee. */
export const isRanged = (unit: Unit): boolean => unit.stats.attackRange >= RANGED_THRESHOLD;

/** Structures never move, so their attacks need no approach logic. */
export const isTurret = (unit: Unit): boolean => (unit.flags & UnitFlag.Immovable) !== 0;
