/**
 * Entity model for the simulation.
 *
 * Units are pooled objects rather than parallel typed arrays. A MOBA-scale
 * battle is a few hundred bodies, which is three orders of magnitude below where
 * struct-of-arrays layout starts to matter, and readable entities are worth far
 * more while the engine is still growing systems. The hot inner loop that does
 * care about locality (broadphase) keeps its own typed-array mirror.
 *
 * Everything here is plain data. Behaviour lives in systems under core/sim.
 */

import type { Vec2 } from '../math/vec2';
import { vec2 } from '../math/vec2';

/**
 * A stable reference to a unit. The low bits index the pool, the high bits are a
 * generation counter, so a handle to a dead unit can never be mistaken for the
 * unit that reused its slot. Abilities hold targets across many ticks, and
 * without generations a delayed projectile will happily kill whoever respawned
 * into that slot.
 */
export type EntityId = number;

export const NO_ENTITY: EntityId = 0;

const INDEX_BITS = 20;
const INDEX_MASK = (1 << INDEX_BITS) - 1;

export const makeId = (index: number, generation: number): EntityId =>
  ((generation << INDEX_BITS) | (index & INDEX_MASK)) >>> 0;
export const idIndex = (id: EntityId): number => id & INDEX_MASK;
export const idGeneration = (id: EntityId): number => id >>> INDEX_BITS;

export const enum Team {
  Neutral = 0,
  Blue = 1,
  Red = 2,
}

export const OPPOSING: Record<Team, Team> = {
  [Team.Neutral]: Team.Neutral,
  [Team.Blue]: Team.Red,
  [Team.Red]: Team.Blue,
};

export const enum UnitKind {
  Champion = 0,
  Minion = 1,
  Monster = 2,
  Structure = 3,
  Ward = 4,
}

export const enum UnitFlag {
  None = 0,
  /** Participates in unit-versus-unit separation. */
  Collides = 1 << 0,
  /** Can be clicked and targeted by abilities. */
  Targetable = 1 << 1,
  /** Immune to damage but still present. */
  Invulnerable = 1 << 2,
  /** Passes through other bodies this tick (dashes, certain spells). */
  Ghosted = 1 << 3,
  /** Never moved by anything: towers, inhibitors. */
  Immovable = 1 << 4,
  /** Grants vision to its team. */
  RevealsFog = 1 << 5,
  /** Controlled by the local player. */
  PlayerControlled = 1 << 6,
}

/** Damage classes, each mitigated by a different resistance. */
export const enum DamageType {
  Physical = 0,
  Magic = 1,
  True = 2,
}

export const enum OrderKind {
  /** No intent. Holds position, still auto-attacks what comes in range. */
  Stop = 0,
  MoveTo = 1,
  /** Walks to a point, stopping to kill anything hostile it passes. */
  AttackMove = 2,
  /** Chases a specific unit until it dies or leaves the world. */
  AttackUnit = 3,
  /** Refuses to move at all, even to chase. */
  HoldPosition = 4,
}

export interface Order {
  kind: OrderKind;
  point: Vec2;
  target: EntityId;
}

export const enum CastPhase {
  /** Winding up: the unit is locked, the spell has not gone out yet. */
  Windup = 0,
  /** Continuous effect that ticks until cancelled or expired. */
  Channel = 1,
  /** Recovery after the effect, during which no new cast may start. */
  Recovery = 2,
}

export interface CastState {
  slot: number;
  phase: CastPhase;
  /** Seconds remaining in the current phase. */
  timer: number;
  /** Ground point or direction anchor captured when the cast began. */
  point: Vec2;
  target: EntityId;
  /** Cast locks facing and movement unless the ability opts out. */
  locksMovement: boolean;
}

export interface DashState {
  /** Where the dash ends, already validated against terrain. */
  to: Vec2;
  from: Vec2;
  elapsed: number;
  duration: number;
  /** Vertical arc height for the renderer. Zero for a flat dash. */
  hop: number;
  /** Fired once when the dash completes. */
  onArrive: number;
}

export const enum StatusKind {
  Slow = 0,
  Haste = 1,
  Stun = 2,
  Root = 3,
  Silence = 4,
  Shield = 5,
  Invulnerable = 6,
  DamageAmp = 7,
  AttackSpeedBuff = 8,
  Regeneration = 9,
  Burn = 10,
}

export interface StatusInstance {
  kind: StatusKind;
  /** Seconds left. Negative means permanent until removed explicitly. */
  remaining: number;
  /** Meaning depends on kind: slow percent, shield pool, damage per second. */
  magnitude: number;
  /** Who applied it, for damage attribution. */
  source: EntityId;
  /** Display/stacking key so refreshes replace rather than accumulate. */
  tag: string;
  /** Accumulator for periodic effects. */
  tickTimer: number;
}

/** Raw, un-modified character stats. Buffs and items never write here. */
export interface BaseStats {
  hpMax: number;
  hpRegen: number;
  mpMax: number;
  mpRegen: number;
  attackDamage: number;
  abilityPower: number;
  armor: number;
  magicResist: number;
  /** Attacks per second at 100% attack speed. */
  attackSpeed: number;
  attackRange: number;
  /** Fraction of the attack cycle spent winding up before damage lands. */
  attackWindup: number;
  moveSpeed: number;
  critChance: number;
  /** Fraction of crowd-control duration ignored, 0..1. */
  tenacity: number;
  visionRange: number;
}

/** Stats after buffs, items and auras. Recomputed whenever modifiers change. */
export interface Stats extends BaseStats {}

/**
 * A named, stackable change to one stat.
 *
 * Statuses could already move movement speed and attack speed, but only
 * because those two were special-cased in the stat recomputation. Anything
 * else -- an item granting attack damage, a rune granting armour, a passive
 * granting range -- had nowhere to live. This is that place, and it is what
 * items, runes, auras and equipment all express themselves in.
 *
 * Flat additions apply before multipliers, so two sources that each say "+10%"
 * agree with each other regardless of the order they were attached in.
 */
export interface StatModifier {
  /** Which stat this affects. */
  stat: keyof BaseStats;
  /** Flat amount added before any multiplier. */
  add?: number;
  /** Multiplier, where 0.1 means +10%. Summed across sources, then applied. */
  mul?: number;
  /** Grouping key, so a whole item's modifiers can be removed together. */
  source: string;
}

export interface AttackState {
  /** Seconds until the next attack may begin. */
  cooldown: number;
  /** Seconds left in the current windup, or -1 when not attacking. */
  windup: number;
  /** Locked in when the windup starts, so the hit lands even if the target moves. */
  target: EntityId;
}

export interface AbilityInstance {
  /** Key into the ability registry. */
  defId: string;
  /** Seconds until castable. */
  cooldown: number;
  rank: number;
  /** Charges for abilities that hold more than one use. */
  charges: number;
}

export interface BrainState {
  /** Leash anchor for monsters, lane objective for minions. */
  home: Vec2;
  /** Waypoints a lane minion walks between. */
  route: Vec2[];
  routeIndex: number;
  aggroRange: number;
  /** How far it will chase before returning home. Infinity for minions. */
  leashRange: number;
  retargetTimer: number;
  /** Seconds of aggression left after being hit, for monster retaliation. */
  alertTimer: number;
}

export interface Unit {
  id: EntityId;
  alive: boolean;
  kind: UnitKind;
  team: Team;
  name: string;
  /** Content key, e.g. the champion or minion archetype id. */
  archetype: string;

  /** Simulation position on the ground plane. */
  pos: Vec2;
  /** Position at the end of the previous tick, for render interpolation. */
  prevPos: Vec2;
  vel: Vec2;
  /** Facing in radians, where 0 is +y and the angle grows clockwise. */
  facing: number;

  radius: number;
  /** Separation weight. Higher mass is pushed less. */
  mass: number;
  flags: UnitFlag;

  base: BaseStats;
  stats: Stats;
  hp: number;
  mp: number;

  order: Order;
  path: Vec2[];
  pathCursor: number;
  /** Throttles repathing so a jammed crowd does not melt the CPU. */
  repathTimer: number;
  /** Consecutive ticks of near-zero progress, used to trigger a repath. */
  blockedTicks: number;

  attack: AttackState;
  abilities: AbilityInstance[];
  statuses: StatusInstance[];
  /** Persistent stat changes from items, runes and auras. */
  modifiers: StatModifier[];
  /** Asset ids of equipped gear, by slot, for the renderer to attach. */
  equipment: Record<string, string>;
  cast: CastState | null;
  dash: DashState | null;
  brain: BrainState | null;

  /** Seconds until respawn, or -1 when not dead. */
  respawnTimer: number;
  /** Set by the vision system each tick, per observing team. */
  visibleTo: number;

  /** Free-form per-archetype scratch, e.g. a passive's stack count. */
  userData: Record<string, number>;
}

export function createOrder(): Order {
  return { kind: OrderKind.Stop, point: vec2(), target: NO_ENTITY };
}

export function defaultBaseStats(): BaseStats {
  return {
    hpMax: 600,
    hpRegen: 6,
    mpMax: 300,
    mpRegen: 8,
    attackDamage: 60,
    abilityPower: 0,
    armor: 28,
    magicResist: 30,
    attackSpeed: 0.65,
    attackRange: 1.8,
    attackWindup: 0.3,
    moveSpeed: 6.6,
    critChance: 0,
    tenacity: 0,
    visionRange: 22,
  };
}
