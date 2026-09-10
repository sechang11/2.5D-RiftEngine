/**
 * Ability definitions and the registry that content plugs into.
 *
 * An ability is data plus a handful of hooks. Everything the engine needs to
 * validate a cast, draw a targeting indicator, spend the resource and start the
 * windup is declarative; only the effect itself is code. That split is what lets
 * the HUD render a range circle for a spell it has never heard of, and it is why
 * adding a champion means adding content, not editing systems.
 */

import type { World } from '../ecs/world';
import type { EntityId, Unit } from '../ecs/types';
import type { Vec2 } from '../math/vec2';

export const enum Targeting {
  /** Fires immediately on the caster. No cursor involvement. */
  Self = 0,
  /** Needs a friendly or hostile unit under the cursor. */
  Unit = 1,
  /** Needs a ground position, clamped to cast range. */
  Point = 2,
  /** Uses the direction from the caster to the cursor; range is a max travel. */
  Direction = 3,
}

/** How the renderer should telegraph the spell while the player aims it. */
export const enum IndicatorShape {
  None = 0,
  /** Ring at max range, for point-targeted spells. */
  RangeCircle = 1,
  /** Ring at max range plus a filled disc at the cursor. */
  TargetCircle = 2,
  /** Rectangle from the caster towards the cursor. */
  Line = 3,
  /** Sector from the caster towards the cursor. */
  Cone = 4,
}

export interface AbilityContext {
  world: World;
  caster: Unit;
  def: AbilityDef;
  /** Ground point captured at cast time, already range-clamped. */
  point: Vec2;
  /** Unit target, or NO_ENTITY. */
  target: EntityId;
  /** Ability rank, 1-based. */
  rank: number;
}

export interface ProjectileHitContext extends AbilityContext {
  victim: Unit;
  /** Where the projectile connected. */
  impact: Vec2;
  /** Scales damage for abilities with falloff or partial hits. */
  power: number;
}

export interface EffectContext extends AbilityContext {
  /** Centre of the resolving area. */
  origin: Vec2;
  radius: number;
  power: number;
}

export interface AbilityDef {
  id: string;
  name: string;
  /** Display slot. Purely cosmetic; the kit array decides the real binding. */
  slot: string;
  icon: string;
  description: string;

  targeting: Targeting;
  indicator: IndicatorShape;

  /** Maximum cast distance in world units. Zero for self-cast. */
  range: number;
  /** Effect radius, or half-width for a Line indicator. */
  radius: number;
  /** Half-angle in radians for a Cone indicator. */
  coneAngle?: number;

  cooldown: number;
  manaCost: number;
  /** Seconds of windup before the effect fires. */
  castTime: number;
  /** Seconds after the effect during which no other cast may begin. */
  recovery: number;
  /** Whether the caster is rooted for the duration of the cast. */
  locksMovement: boolean;
  /** Whether the ability may be cast while moving without stopping. */
  castableWhileMoving?: boolean;

  /** Fires when the windup completes. The main effect entry point. */
  onCast?: (ctx: AbilityContext) => void;
  /** Fires for each unit a projectile belonging to this ability strikes. */
  onProjectileHit?: (ctx: ProjectileHitContext) => void;
  /** Fires when a delayed ground effect belonging to this ability resolves. */
  onEffectResolve?: (ctx: EffectContext) => void;
  /** Optional extra validation, e.g. "needs a hostile target". */
  canCast?: (world: World, caster: Unit, target: EntityId, point: Vec2) => boolean;
}

const registry = new Map<string, AbilityDef>();

export function registerAbility(def: AbilityDef): AbilityDef {
  if (registry.has(def.id)) {
    throw new Error(`Ability "${def.id}" is already registered`);
  }
  registry.set(def.id, def);
  return def;
}

export function getAbility(id: string): AbilityDef | undefined {
  return registry.get(id);
}

/** Throws rather than returning undefined, for call sites that cannot recover. */
export function requireAbility(id: string): AbilityDef {
  const def = registry.get(id);
  if (!def) throw new Error(`Unknown ability "${id}"`);
  return def;
}

export function allAbilities(): AbilityDef[] {
  return [...registry.values()];
}

/** Reason a cast attempt was refused, so the HUD can say why. */
export const enum CastRejection {
  Ok = 0,
  NoAbility = 1,
  OnCooldown = 2,
  NotEnoughMana = 3,
  Silenced = 4,
  NoTarget = 5,
  OutOfRange = 6,
  AlreadyCasting = 7,
  Dead = 8,
  Blocked = 9,
}

export const REJECTION_TEXT: Record<CastRejection, string> = {
  [CastRejection.Ok]: '',
  [CastRejection.NoAbility]: 'No ability in that slot',
  [CastRejection.OnCooldown]: 'Ability is on cooldown',
  [CastRejection.NotEnoughMana]: 'Not enough mana',
  [CastRejection.Silenced]: 'Silenced',
  [CastRejection.NoTarget]: 'Needs a target',
  [CastRejection.OutOfRange]: 'Target out of range',
  [CastRejection.AlreadyCasting]: 'Already casting',
  [CastRejection.Dead]: 'Dead',
  [CastRejection.Blocked]: 'Cannot cast there',
};
