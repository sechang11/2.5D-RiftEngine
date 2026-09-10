/**
 * The starter champion kit.
 *
 * One ability per targeting mode, chosen so that every engine subsystem is
 * exercised by something a player can press:
 *
 *   Q  direction skillshot   projectiles, swept collision, slows
 *   W  self cast             shields, stat modifiers, buff timers
 *   E  ground-targeted dash  terrain clipping, body ghosting, area damage
 *   R  delayed ground area   telegraphs, hard crowd control, cast windups
 *   D  blink                 instant reposition validated against terrain
 *   F  unit-targeted debuff  damage over time, target validation
 *
 * Numbers are tuned against the sandbox dummies rather than balanced against a
 * real roster; they exist to make behaviour legible.
 */

import { DamageType, StatusKind, UnitFlag } from '../../core/ecs/types';
import type { Unit } from '../../core/ecs/types';
import { IndicatorShape, registerAbility, Targeting } from '../../core/abilities/types';
import { applyDamage } from '../../core/combat/stats';
import { applyStatus } from '../../core/status/statuses';
import { SimEventType } from '../../core/events/bus';
import { startDash } from '../../core/sim/locomotion';
import { segmentHitsCircle } from '../../core/math/geom';
import * as V from '../../core/math/vec2';
import { vec2 } from '../../core/math/vec2';

const scratchUnits: Unit[] = [];
const scratchDir = vec2();

/** Emits a damage event so the view layer can draw a number. */
function reportDamage(
  ctx: { world: import('../../core/ecs/world').World; caster: Unit },
  victim: Unit,
  amount: number,
  type: DamageType,
  tag: string,
): void {
  if (amount <= 0) return;
  ctx.world.events.push(SimEventType.Damage, ctx.world.tick, {
    source: ctx.caster.id,
    target: victim.id,
    x: victim.pos.x,
    y: victim.pos.y,
    amount,
    damageType: type,
    tag,
  });
}

// ---------------------------------------------------------------------------
// Q: Rift Bolt
// ---------------------------------------------------------------------------

export const RIFT_BOLT = registerAbility({
  id: 'rift.q',
  name: 'Rift Bolt',
  slot: 'Q',
  icon: '✦',
  description:
    'Fires a bolt that damages the first enemy struck and slows it. Stopped by terrain.',
  targeting: Targeting.Direction,
  indicator: IndicatorShape.Line,
  range: 13,
  radius: 0.45,
  cooldown: 3.5,
  manaCost: 45,
  castTime: 0.22,
  recovery: 0.05,
  locksMovement: true,

  onCast: (ctx) => {
    V.direction(scratchDir, ctx.caster.pos, ctx.point);
    if (V.lenSq(scratchDir) < 1e-6) return;
    ctx.world.spawnProjectile({
      owner: ctx.caster.id,
      team: ctx.caster.team,
      pos: ctx.caster.pos,
      dir: scratchDir,
      speed: 24,
      radius: 0.45,
      maxRange: ctx.def.range,
      target: 0,
      defId: ctx.def.id,
      pierce: 1,
      visual: 'bolt_arcane',
      power: 70 + ctx.caster.stats.abilityPower * 0.7,
      collidesTerrain: true,
    });
  },

  onProjectileHit: (ctx) => {
    const result = applyDamage(ctx.victim, {
      amount: ctx.power,
      type: DamageType.Magic,
      source: ctx.caster,
      tag: ctx.def.id,
    });
    reportDamage(ctx, ctx.victim, result.dealt, DamageType.Magic, ctx.def.id);
    applyStatus(ctx.world, ctx.victim, {
      kind: StatusKind.Slow,
      duration: 1.6,
      magnitude: 0.35,
      source: ctx.caster.id,
      tag: 'rift.q.slow',
    });
  },
});

// ---------------------------------------------------------------------------
// W: Aegis Ward
// ---------------------------------------------------------------------------

export const AEGIS_WARD = registerAbility({
  id: 'rift.w',
  name: 'Aegis Ward',
  slot: 'W',
  icon: '❖',
  description: 'Shields yourself and surges forward with bonus movement speed.',
  targeting: Targeting.Self,
  indicator: IndicatorShape.None,
  range: 0,
  radius: 0,
  cooldown: 9,
  manaCost: 55,
  castTime: 0,
  recovery: 0,
  locksMovement: false,
  castableWhileMoving: true,

  onCast: (ctx) => {
    const amount = 110 + ctx.caster.stats.abilityPower * 0.6;
    applyStatus(ctx.world, ctx.caster, {
      kind: StatusKind.Shield,
      duration: 3,
      magnitude: amount,
      source: ctx.caster.id,
      tag: 'rift.w.shield',
    });
    applyStatus(ctx.world, ctx.caster, {
      kind: StatusKind.Haste,
      duration: 2.2,
      magnitude: 0.35,
      source: ctx.caster.id,
      tag: 'rift.w.haste',
    });
  },
});

// ---------------------------------------------------------------------------
// E: Blink Step
// ---------------------------------------------------------------------------

export const BLINK_STEP = registerAbility({
  id: 'rift.e',
  name: 'Blink Step',
  slot: 'E',
  icon: '➤',
  description: 'Dash a short distance, cutting through anyone in the way.',
  targeting: Targeting.Point,
  indicator: IndicatorShape.RangeCircle,
  range: 7.5,
  radius: 1.1,
  cooldown: 7,
  manaCost: 50,
  castTime: 0,
  recovery: 0.08,
  locksMovement: false,

  onCast: (ctx) => {
    const from = vec2(ctx.caster.pos.x, ctx.caster.pos.y);
    if (!startDash(ctx.world, ctx.caster, ctx.point.x, ctx.point.y, 20, 0.35)) return;
    const to = ctx.caster.dash ? ctx.caster.dash.to : ctx.point;

    // Damage is applied along the whole intended path immediately. The dash
    // itself takes a couple of hundred milliseconds; resolving per-tick would
    // let a fast target slip out of a swing that visually connected.
    const midX = (from.x + to.x) * 0.5;
    const midY = (from.y + to.y) * 0.5;
    const reach = V.dist(from, to) * 0.5 + ctx.def.radius;

    ctx.world.queryCircle(midX, midY, reach, scratchUnits, (u) => {
      if (!ctx.world.isEnemy(ctx.caster, u)) return false;
      if (!(u.flags & UnitFlag.Targetable)) return false;
      return segmentHitsCircle(from, to, u.pos, u.radius + ctx.def.radius);
    });

    const damage = 55 + ctx.caster.stats.abilityPower * 0.4;
    for (let i = 0; i < scratchUnits.length; i++) {
      const victim = scratchUnits[i];
      const result = applyDamage(victim, {
        amount: damage,
        type: DamageType.Physical,
        source: ctx.caster,
        tag: ctx.def.id,
      });
      reportDamage(ctx, victim, result.dealt, DamageType.Physical, ctx.def.id);
    }
  },
});

// ---------------------------------------------------------------------------
// R: Cataclysm
// ---------------------------------------------------------------------------

export const CATACLYSM = registerAbility({
  id: 'rift.r',
  name: 'Cataclysm',
  slot: 'R',
  icon: '✷',
  description:
    'Calls down a delayed blast that damages and stuns everyone caught inside.',
  targeting: Targeting.Point,
  indicator: IndicatorShape.TargetCircle,
  range: 16,
  radius: 4.4,
  cooldown: 22,
  manaCost: 100,
  castTime: 0.35,
  recovery: 0.2,
  locksMovement: true,

  onCast: (ctx) => {
    ctx.world.spawnEffect({
      defId: ctx.def.id,
      owner: ctx.caster.id,
      team: ctx.caster.team,
      pos: ctx.point,
      radius: ctx.def.radius,
      delay: 0.7,
      power: 210 + ctx.caster.stats.abilityPower * 0.9,
      visual: 'cataclysm',
    });
  },

  onEffectResolve: (ctx) => {
    ctx.world.queryCircle(ctx.origin.x, ctx.origin.y, ctx.radius, scratchUnits, (u) => {
      if (!ctx.world.isEnemy(ctx.caster, u)) return false;
      return (u.flags & UnitFlag.Targetable) !== 0;
    });

    for (let i = 0; i < scratchUnits.length; i++) {
      const victim = scratchUnits[i];
      const result = applyDamage(victim, {
        amount: ctx.power,
        type: DamageType.Magic,
        source: ctx.caster,
        tag: ctx.def.id,
      });
      reportDamage(ctx, victim, result.dealt, DamageType.Magic, ctx.def.id);
      applyStatus(ctx.world, victim, {
        kind: StatusKind.Stun,
        duration: 1.1,
        magnitude: 1,
        source: ctx.caster.id,
        tag: 'rift.r.stun',
      });
    }
  },
});

// ---------------------------------------------------------------------------
// D: Flash
// ---------------------------------------------------------------------------

export const FLASH = registerAbility({
  id: 'sum.flash',
  name: 'Flash',
  slot: 'D',
  icon: '⚡',
  description: 'Blink a short distance towards the cursor, through terrain.',
  targeting: Targeting.Point,
  indicator: IndicatorShape.RangeCircle,
  range: 6.5,
  radius: 0,
  cooldown: 45,
  manaCost: 0,
  castTime: 0,
  recovery: 0,
  locksMovement: false,

  onCast: (ctx) => {
    const caster = ctx.caster;
    V.direction(scratchDir, caster.pos, ctx.point);
    if (V.lenSq(scratchDir) < 1e-6) return;

    const requested = Math.min(ctx.def.range, V.dist(caster.pos, ctx.point));
    const landing = vec2(
      caster.pos.x + scratchDir.x * requested,
      caster.pos.y + scratchDir.y * requested,
    );

    // Flash goes *through* walls, so the landing spot is snapped to open ground
    // rather than clipped at the first obstruction the way a dash is.
    if (!ctx.world.nav.nearestFit(landing, landing.x, landing.y, caster.radius, 12)) return;

    caster.pos.x = landing.x;
    caster.pos.y = landing.y;
    caster.prevPos.x = landing.x;
    caster.prevPos.y = landing.y;
    caster.path.length = 0;
    caster.pathCursor = 0;
    ctx.world.nav.resolveTerrain(caster.pos, caster.radius, 8);

    ctx.world.events.push(SimEventType.Impact, ctx.world.tick, {
      source: caster.id,
      x: landing.x,
      y: landing.y,
      tag: 'sum.flash',
    });
  },
});

// ---------------------------------------------------------------------------
// F: Ignite
// ---------------------------------------------------------------------------

export const IGNITE = registerAbility({
  id: 'sum.ignite',
  name: 'Ignite',
  slot: 'F',
  icon: '🔥',
  description: 'Burns a target for true damage over five seconds.',
  targeting: Targeting.Unit,
  indicator: IndicatorShape.RangeCircle,
  range: 12,
  radius: 0,
  cooldown: 30,
  manaCost: 0,
  castTime: 0,
  recovery: 0,
  locksMovement: false,

  canCast: (world, caster, target) => {
    const t = world.getTargetable(target);
    return !!t && world.isEnemy(caster, t);
  },

  onCast: (ctx) => {
    const victim = ctx.world.getTargetable(ctx.target);
    if (!victim) return;
    applyStatus(ctx.world, victim, {
      kind: StatusKind.Burn,
      duration: 5,
      magnitude: 34,
      source: ctx.caster.id,
      tag: 'sum.ignite',
      period: 0.5,
    });
  },
});

/** Slot order the HUD and input layer use for this champion. */
export const RIFT_KIT = [RIFT_BOLT.id, AEGIS_WARD.id, BLINK_STEP.id, CATACLYSM.id, FLASH.id, IGNITE.id];

/** Keys bound to each slot, parallel to RIFT_KIT. */
export const KIT_KEYS = ['Q', 'W', 'E', 'R', 'D', 'F'];
