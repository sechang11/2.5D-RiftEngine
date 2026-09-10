/**
 * The basic attack, expressed as an ability so that missiles, on-hit events and
 * damage all travel the same code path as spells.
 *
 * Registering it in the engine rather than in game content means a new champion
 * gets working auto-attacks for free, and the projectile system needs no special
 * case for "this missile is not a spell".
 */

import { DamageType } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { registerAbility, IndicatorShape, Targeting } from '../abilities/types';
import { applyDamage } from './stats';

export const BASIC_ATTACK_ID = 'core.basic_attack';

registerAbility({
  id: BASIC_ATTACK_ID,
  name: 'Attack',
  slot: '',
  icon: '',
  description: 'Standard attack.',
  targeting: Targeting.Unit,
  indicator: IndicatorShape.None,
  range: 0,
  radius: 0.18,
  cooldown: 0,
  manaCost: 0,
  castTime: 0,
  recovery: 0,
  locksMovement: false,
  onProjectileHit: (ctx) => {
    // `power` is the attacker's damage snapshotted at launch. Recomputing here
    // would let a buff that expires mid-flight retroactively weaken a missile
    // that was already in the air.
    const result = applyDamage(ctx.victim, {
      amount: ctx.power,
      type: DamageType.Physical,
      source: ctx.caster,
      tag: BASIC_ATTACK_ID,
    });
    if (result.dealt > 0 || result.absorbed > 0) {
      ctx.world.events.push(SimEventType.Damage, ctx.world.tick, {
        source: ctx.caster.id,
        target: ctx.victim.id,
        x: ctx.victim.pos.x,
        y: ctx.victim.pos.y,
        amount: result.dealt,
        damageType: DamageType.Physical,
        tag: BASIC_ATTACK_ID,
      });
    }
  },
});
