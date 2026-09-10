/**
 * Stat resolution and the damage pipeline.
 *
 * Two rules keep this maintainable as content grows:
 *
 *   1. `base` is immutable character data. Buffs, items and auras never write to
 *      it. Every frame that modifiers change, `stats` is rebuilt from `base`.
 *      This is why a slow expiring restores exactly the right movement speed
 *      instead of drifting after a hundred applications.
 *   2. All damage flows through one function, so lifesteal, shields, damage
 *      amplification and death all have exactly one place to hook.
 */

import type { BaseStats, StatModifier, Stats, Unit } from '../ecs/types';
import { DamageType, StatusKind, UnitFlag } from '../ecs/types';
import { clamp } from '../math/scalar';

export function copyStats(dst: Stats, src: BaseStats): void {
  dst.hpMax = src.hpMax;
  dst.hpRegen = src.hpRegen;
  dst.mpMax = src.mpMax;
  dst.mpRegen = src.mpRegen;
  dst.attackDamage = src.attackDamage;
  dst.abilityPower = src.abilityPower;
  dst.armor = src.armor;
  dst.magicResist = src.magicResist;
  dst.attackSpeed = src.attackSpeed;
  dst.attackRange = src.attackRange;
  dst.attackWindup = src.attackWindup;
  dst.moveSpeed = src.moveSpeed;
  dst.critChance = src.critChance;
  dst.tenacity = src.tenacity;
  dst.visionRange = src.visionRange;
}

/**
 * Rebuilds `unit.stats` from `unit.base` plus every active status.
 *
 * Slows and hastes are collected separately and applied multiplicatively in a
 * fixed order, so the result does not depend on the order statuses happen to sit
 * in the array. Determinism requires that.
 */
export function recomputeStats(unit: Unit): void {
  const s = unit.stats;
  copyStats(s, unit.base);

  // Persistent modifiers first: items and runes form the character's baseline,
  // and temporary effects then act on that. Applying them the other way round
  // would make a slow's percentage depend on what boots you were wearing.
  if (unit.modifiers.length > 0) applyModifiers(unit, s);

  let slowPct = 0;
  let hastePct = 0;
  let attackSpeedPct = 0;

  for (let i = 0; i < unit.statuses.length; i++) {
    const st = unit.statuses[i];
    switch (st.kind) {
      case StatusKind.Slow:
        // Strongest slow wins rather than stacking additively to zero.
        slowPct = Math.max(slowPct, st.magnitude);
        break;
      case StatusKind.Haste:
        hastePct += st.magnitude;
        break;
      case StatusKind.AttackSpeedBuff:
        attackSpeedPct += st.magnitude;
        break;
      default:
        break;
    }
  }

  // These two read from `s`, not from `base`, so an item's movement speed is
  // included before slows and hastes scale it.
  s.moveSpeed = s.moveSpeed * (1 + hastePct) * (1 - clamp(slowPct, 0, 0.95));
  s.attackSpeed = s.attackSpeed * (1 + attackSpeedPct);

  if (isImmobilized(unit)) s.moveSpeed = 0;

  // Health and mana are pools with a cap that other things move. This clamp
  // has to run on every recompute, not only when modifiers are present:
  // dropping the item that raised the cap is exactly the case that leaves a
  // unit sitting above its new maximum.
  if (unit.hp > s.hpMax) unit.hp = s.hpMax;
  if (unit.mp > s.mpMax) unit.mp = s.mpMax;
}

/**
 * Folds every persistent modifier into the stat block.
 *
 * Two passes rather than one: all flat additions, then all multipliers summed
 * and applied once. Interleaving them would make the result depend on the order
 * items happen to sit in the array, which is exactly the class of bug that
 * makes a character sheet disagree with itself after a reload.
 */
function applyModifiers(unit: Unit, s: Stats): void {
  const mods = unit.modifiers;

  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    if (m.add) (s[m.stat] as number) = (s[m.stat] as number) + m.add;
  }

  let key: keyof BaseStats;
  const scales = new Map<keyof BaseStats, number>();
  for (let i = 0; i < mods.length; i++) {
    const m = mods[i];
    if (!m.mul) continue;
    scales.set(m.stat, (scales.get(m.stat) ?? 0) + m.mul);
  }
  for (const [stat, factor] of scales) {
    key = stat;
    (s[key] as number) = (s[key] as number) * (1 + factor);
  }
}

/** Attaches modifiers under a source key, replacing any already there. */
export function setModifiers(unit: Unit, source: string, mods: StatModifier[]): void {
  removeModifiers(unit, source, false);
  for (const m of mods) unit.modifiers.push({ ...m, source });
  recomputeStats(unit);
}

export function removeModifiers(unit: Unit, source: string, recompute = true): void {
  for (let i = unit.modifiers.length - 1; i >= 0; i--) {
    if (unit.modifiers[i].source === source) unit.modifiers.splice(i, 1);
  }
  if (recompute) recomputeStats(unit);
}

export function hasStatus(unit: Unit, kind: StatusKind): boolean {
  for (let i = 0; i < unit.statuses.length; i++) {
    if (unit.statuses[i].kind === kind) return true;
  }
  return false;
}

export function statusMagnitude(unit: Unit, kind: StatusKind): number {
  let total = 0;
  for (let i = 0; i < unit.statuses.length; i++) {
    if (unit.statuses[i].kind === kind) total += unit.statuses[i].magnitude;
  }
  return total;
}

/** Stunned or rooted: cannot move under its own power. */
export function isImmobilized(unit: Unit): boolean {
  return hasStatus(unit, StatusKind.Stun) || hasStatus(unit, StatusKind.Root);
}

/** Stunned: cannot move, attack, or cast. */
export function isStunned(unit: Unit): boolean {
  return hasStatus(unit, StatusKind.Stun);
}

export function canCast(unit: Unit): boolean {
  return !isStunned(unit) && !hasStatus(unit, StatusKind.Silence);
}

export function canAttack(unit: Unit): boolean {
  return !isStunned(unit);
}

/**
 * League's mitigation curve. Positive resistance divides damage; negative
 * resistance amplifies it, but with diminishing returns so that -100 armor
 * doubles damage rather than dividing by zero.
 */
export function mitigate(raw: number, resistance: number): number {
  if (resistance >= 0) return raw * (100 / (100 + resistance));
  return raw * (2 - 100 / (100 - resistance));
}

export interface DamageInput {
  amount: number;
  type: DamageType;
  source: Unit | null;
  /** Identifies the spell or attack, for combat logs and on-hit rules. */
  tag: string;
  /** Fraction of resistance ignored, 0..1. */
  penetration?: number;
}

export interface DamageResult {
  /** Health actually removed after resistances and shields. */
  dealt: number;
  /** Portion absorbed by shields. */
  absorbed: number;
  /** True when this blow reduced the target to zero health. */
  lethal: boolean;
  /** True when the hit was prevented entirely. */
  blocked: boolean;
}

/**
 * The single entry point for losing health.
 *
 * Order of operations matters and mirrors League: resistances, then damage
 * amplification, then shields, then health. Shields sitting in front of
 * resistances would make them scale with the attacker's penetration, which is
 * not how players expect a shield to behave.
 */
export function applyDamage(target: Unit, input: DamageInput): DamageResult {
  const result: DamageResult = { dealt: 0, absorbed: 0, lethal: false, blocked: false };

  if (!target.alive || target.hp <= 0) {
    result.blocked = true;
    return result;
  }
  if (target.flags & UnitFlag.Invulnerable || hasStatus(target, StatusKind.Invulnerable)) {
    result.blocked = true;
    return result;
  }

  let amount = input.amount;
  const pen = input.penetration ?? 0;

  switch (input.type) {
    case DamageType.Physical:
      amount = mitigate(amount, target.stats.armor * (1 - pen));
      break;
    case DamageType.Magic:
      amount = mitigate(amount, target.stats.magicResist * (1 - pen));
      break;
    case DamageType.True:
      break;
  }

  const amp = statusMagnitude(target, StatusKind.DamageAmp);
  if (amp !== 0) amount *= 1 + amp;

  // Shields soak in application order, and each is consumed before the next.
  if (amount > 0) {
    for (let i = 0; i < target.statuses.length && amount > 0; i++) {
      const st = target.statuses[i];
      if (st.kind !== StatusKind.Shield || st.magnitude <= 0) continue;
      const soak = Math.min(st.magnitude, amount);
      st.magnitude -= soak;
      amount -= soak;
      result.absorbed += soak;
      if (st.magnitude <= 0.001) st.remaining = 0; // expires this tick
    }
  }

  if (amount <= 0) {
    result.dealt = 0;
    return result;
  }

  const before = target.hp;
  target.hp = Math.max(0, target.hp - amount);
  result.dealt = before - target.hp;
  result.lethal = target.hp <= 0;
  return result;
}

export function heal(target: Unit, amount: number): number {
  if (!target.alive || target.hp <= 0) return 0;
  const before = target.hp;
  target.hp = Math.min(target.stats.hpMax, target.hp + amount);
  return target.hp - before;
}

/** Seconds between auto-attacks, derived from attack speed. */
export const attackInterval = (unit: Unit): number =>
  1 / Math.max(0.1, unit.stats.attackSpeed);

/** Crowd-control duration after tenacity. */
export const applyTenacity = (unit: Unit, seconds: number): number =>
  seconds * (1 - clamp(unit.stats.tenacity, 0, 0.9));
