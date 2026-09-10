/**
 * Unit archetypes: the data a spawn needs, in one table.
 *
 * Stats, body size, AI profile and appearance live together because they are
 * balanced together. A wider body needs a wider attack range to feel right; a
 * tankier camp needs a longer leash. Splitting them across files makes those
 * relationships invisible.
 */

import type { BaseStats } from '../../core/ecs/types';
import { Team, UnitKind, UnitFlag, defaultBaseStats } from '../../core/ecs/types';
import type { CharacterStyle } from '../../render/meshes/character';
import { RIFT_KIT } from './abilities';

export interface Archetype {
  id: string;
  name: string;
  kind: UnitKind;
  radius: number;
  /** Separation weight. Structures use Immovable instead of a huge mass. */
  mass: number;
  flags?: UnitFlag;
  base: BaseStats;
  abilities: string[];
  /** Which mesh builder to use. */
  mesh: 'character' | 'tower';
  style: Omit<CharacterStyle, 'accent'>;
  /** Non-champions pick their own fights. */
  autoAcquire?: boolean;
  ai?: {
    aggroRange: number;
    leashRange: number;
  };
}

/** Team colours, used for accents, rings, health bars and the minimap. */
export const TEAM_COLOR: Record<Team, number> = {
  [Team.Blue]: 0x4ea6ff,
  [Team.Red]: 0xff5a5a,
  [Team.Neutral]: 0xd8b45a,
};

export const TEAM_CSS: Record<Team, string> = {
  [Team.Blue]: '#4ea6ff',
  [Team.Red]: '#ff5a5a',
  [Team.Neutral]: '#d8b45a',
};

const stats = (o: Partial<BaseStats>): BaseStats => ({ ...defaultBaseStats(), ...o });

export const ARCHETYPES: Record<string, Archetype> = {
  /** The player champion: ranged, mobile, full kit. */
  warden: {
    id: 'warden',
    name: 'Warden',
    kind: UnitKind.Champion,
    radius: 0.66,
    mass: 2.2,
    base: stats({
      hpMax: 780,
      hpRegen: 9,
      mpMax: 420,
      mpRegen: 12,
      attackDamage: 68,
      abilityPower: 45,
      armor: 34,
      magicResist: 32,
      attackSpeed: 0.72,
      attackRange: 6.2,
      attackWindup: 0.28,
      moveSpeed: 7.4,
      critChance: 0.1,
      tenacity: 0.1,
      visionRange: 26,
    }),
    abilities: RIFT_KIT,
    mesh: 'character',
    style: { primary: 0xcfd6e4, secondary: 0x3a4152, scale: 1, weapon: 'sword', cape: true, head: 'helm' },
  },

  /** A second champion body, used for the enemy duellist. Melee and beefier. */
  duelist: {
    id: 'duelist',
    name: 'Duelist',
    kind: UnitKind.Champion,
    radius: 0.7,
    mass: 2.6,
    base: stats({
      hpMax: 920,
      hpRegen: 11,
      mpMax: 300,
      mpRegen: 9,
      attackDamage: 76,
      abilityPower: 0,
      armor: 44,
      magicResist: 34,
      attackSpeed: 0.78,
      attackRange: 2.0,
      attackWindup: 0.25,
      moveSpeed: 7.6,
      visionRange: 24,
    }),
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 16, leashRange: 44 },
    style: { primary: 0x8a5a3a, secondary: 0x2d2721, scale: 1.05, weapon: 'claws', cape: false, head: 'horned' },
  },

  /** Lane minion: small, cheap, walks a route. */
  footman: {
    id: 'footman',
    name: 'Footman',
    kind: UnitKind.Minion,
    radius: 0.44,
    mass: 1,
    base: stats({
      hpMax: 220,
      hpRegen: 0,
      mpMax: 0,
      mpRegen: 0,
      attackDamage: 22,
      armor: 8,
      magicResist: 6,
      attackSpeed: 0.85,
      attackRange: 1.6,
      attackWindup: 0.3,
      moveSpeed: 5.6,
      visionRange: 14,
    }),
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 9, leashRange: Infinity },
    style: { primary: 0x9aa2b1, secondary: 0x39404d, scale: 0.68, weapon: 'sword', cape: false, head: 'helm' },
  },

  /** Ranged minion: fragile, outranges the melee line. */
  archer: {
    id: 'archer',
    name: 'Archer',
    kind: UnitKind.Minion,
    radius: 0.4,
    mass: 0.85,
    base: stats({
      hpMax: 150,
      hpRegen: 0,
      mpMax: 0,
      mpRegen: 0,
      attackDamage: 26,
      armor: 3,
      magicResist: 6,
      attackSpeed: 0.7,
      attackRange: 7,
      attackWindup: 0.35,
      moveSpeed: 5.6,
      visionRange: 15,
    }),
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 10, leashRange: Infinity },
    style: { primary: 0x7d8ba0, secondary: 0x2f3949, scale: 0.64, weapon: 'staff', cape: false, head: 'helm' },
  },

  /** Jungle camp: sits still, hits hard, leashes home. */
  golem: {
    id: 'golem',
    name: 'Stone Golem',
    kind: UnitKind.Monster,
    radius: 0.8,
    mass: 3.2,
    base: stats({
      hpMax: 520,
      hpRegen: 14,
      mpMax: 0,
      mpRegen: 0,
      attackDamage: 46,
      armor: 22,
      magicResist: 18,
      attackSpeed: 0.55,
      attackRange: 1.9,
      attackWindup: 0.35,
      moveSpeed: 5.2,
      visionRange: 12,
    }),
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 11, leashRange: 22 },
    style: { primary: 0x6d6a63, secondary: 0x4a463f, scale: 1.1, weapon: 'none', cape: false, head: 'orb', bulk: 1.35 },
  },

  /** Large camp: slow, very tanky, a real obstacle. */
  brute: {
    id: 'brute',
    name: 'Rift Brute',
    kind: UnitKind.Monster,
    radius: 1.25,
    mass: 6,
    base: stats({
      hpMax: 1800,
      hpRegen: 24,
      mpMax: 0,
      mpRegen: 0,
      attackDamage: 92,
      armor: 34,
      magicResist: 26,
      attackSpeed: 0.45,
      attackRange: 2.6,
      attackWindup: 0.4,
      moveSpeed: 4.8,
      visionRange: 14,
    }),
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 13, leashRange: 26 },
    style: { primary: 0x5c4a6b, secondary: 0x332a3d, scale: 1.55, weapon: 'claws', cape: false, head: 'horned', bulk: 1.5 },
  },

  /** Lane tower: immovable, long range, heavy damage. */
  tower: {
    id: 'tower',
    name: 'Guard Tower',
    kind: UnitKind.Structure,
    radius: 1.9,
    mass: 1000,
    flags: UnitFlag.Collides | UnitFlag.Targetable | UnitFlag.RevealsFog | UnitFlag.Immovable,
    base: stats({
      hpMax: 2600,
      hpRegen: 0,
      mpMax: 0,
      mpRegen: 0,
      attackDamage: 130,
      armor: 40,
      magicResist: 40,
      attackSpeed: 0.55,
      attackRange: 13,
      attackWindup: 0.4,
      moveSpeed: 0,
      visionRange: 20,
    }),
    abilities: [],
    mesh: 'tower',
    style: { primary: 0x8f9099, secondary: 0x55575e, scale: 1, weapon: 'none', cape: false, head: 'orb' },
  },

  /** Stationary punching bag for testing damage and collision. */
  dummy: {
    id: 'dummy',
    name: 'Training Dummy',
    kind: UnitKind.Minion,
    radius: 0.6,
    mass: 4,
    base: stats({
      hpMax: 1500,
      hpRegen: 40,
      mpMax: 0,
      mpRegen: 0,
      attackDamage: 0,
      armor: 20,
      magicResist: 20,
      attackSpeed: 0.1,
      attackRange: 0.1,
      moveSpeed: 0,
      visionRange: 8,
    }),
    abilities: [],
    mesh: 'character',
    style: { primary: 0xb59a6a, secondary: 0x6b5836, scale: 0.95, weapon: 'none', cape: false, head: 'orb' },
  },
};

/**
 * The fantasy roster.
 *
 * These are procedural rather than generated meshes, and deliberately so.
 * Single-view reconstruction returns a static surface with no skeleton, which
 * is fine for a barrel and useless for anything that has to walk. Built from
 * primitives and posed by rotating joints, every one of these animates, costs a
 * few hundred triangles, and takes a line of data to add.
 *
 * Body plan does most of the work: robe and hood read as a caster, a quadruped
 * spine reads as a beast, and a floating hover reads as undead, without any of
 * them sharing a silhouette.
 */
const ROSTER: Array<Omit<Archetype, 'base'> & { base: Partial<BaseStats> }> = [
  {
    id: 'knight',
    name: 'Knight',
    kind: UnitKind.Champion,
    radius: 0.7,
    mass: 2.8,
    base: { hpMax: 980, armor: 52, magicResist: 34, attackDamage: 72, attackRange: 2.0, moveSpeed: 7.0, attackSpeed: 0.7 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 15, leashRange: 60 },
    style: { primary: 0xc6ccd8, secondary: 0x2f3646, scale: 1.05, weapon: 'sword', cape: true, head: 'helm', pauldrons: true },
  },
  {
    id: 'barbarian',
    name: 'Barbarian',
    kind: UnitKind.Champion,
    radius: 0.72,
    mass: 2.9,
    base: { hpMax: 1050, armor: 34, attackDamage: 88, attackRange: 2.2, moveSpeed: 7.6, attackSpeed: 0.68 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 16, leashRange: 60 },
    style: { primary: 0x8a6a48, secondary: 0x4a3526, scale: 1.1, weapon: 'axe', cape: false, head: 'horned', bulk: 1.2 },
  },
  {
    id: 'paladin',
    name: 'Paladin',
    kind: UnitKind.Champion,
    radius: 0.7,
    mass: 2.9,
    base: { hpMax: 1020, armor: 48, magicResist: 44, abilityPower: 30, attackDamage: 66, attackRange: 2.0, moveSpeed: 7.0 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 15, leashRange: 60 },
    style: { primary: 0xe0c473, secondary: 0x8a6b2a, scale: 1.05, weapon: 'sword', cape: true, head: 'helm', pauldrons: true },
  },
  {
    id: 'ranger',
    name: 'Ranger',
    kind: UnitKind.Champion,
    radius: 0.62,
    mass: 2.0,
    base: { hpMax: 700, armor: 28, attackDamage: 70, attackRange: 8.5, attackSpeed: 0.9, moveSpeed: 7.8, critChance: 0.15 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 18, leashRange: 60 },
    style: { primary: 0x4c6b45, secondary: 0x2c3a28, scale: 0.98, weapon: 'bow', cape: true, head: 'hooded' },
  },
  {
    id: 'assassin',
    name: 'Assassin',
    kind: UnitKind.Champion,
    radius: 0.6,
    mass: 1.9,
    base: { hpMax: 680, armor: 26, attackDamage: 78, attackRange: 1.8, attackSpeed: 1.05, moveSpeed: 8.2, critChance: 0.25 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 14, leashRange: 60 },
    style: { primary: 0x2b2f3a, secondary: 0x14161d, scale: 0.96, weapon: 'claws', cape: true, head: 'hooded' },
  },
  {
    id: 'wizard',
    name: 'Wizard',
    kind: UnitKind.Champion,
    radius: 0.62,
    mass: 1.8,
    base: { hpMax: 620, mpMax: 560, abilityPower: 85, armor: 22, attackRange: 7.0, moveSpeed: 7.0 },
    abilities: RIFT_KIT,
    mesh: 'character',
    style: { primary: 0x4a5cc4, secondary: 0x27306a, scale: 1.0, weapon: 'staff', cape: false, head: 'hooded', robe: true },
  },
  {
    id: 'necromancer',
    name: 'Necromancer',
    kind: UnitKind.Champion,
    radius: 0.62,
    mass: 1.8,
    base: { hpMax: 660, mpMax: 520, abilityPower: 78, armor: 24, attackRange: 6.5, moveSpeed: 6.9 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 16, leashRange: 50 },
    style: { primary: 0x3a3040, secondary: 0x1d1824, scale: 1.0, weapon: 'staff', cape: true, head: 'skull', robe: true },
  },
  {
    id: 'druid',
    name: 'Druid',
    kind: UnitKind.Champion,
    radius: 0.64,
    mass: 1.9,
    base: { hpMax: 760, mpMax: 480, abilityPower: 66, hpRegen: 16, armor: 28, attackRange: 6.0, moveSpeed: 7.1 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 15, leashRange: 50 },
    style: { primary: 0x5e7a3a, secondary: 0x3a4a24, scale: 1.0, weapon: 'staff', cape: false, head: 'beast', robe: true },
  },
  {
    id: 'cleric',
    name: 'Cleric',
    kind: UnitKind.Champion,
    radius: 0.62,
    mass: 1.9,
    base: { hpMax: 780, mpMax: 500, abilityPower: 60, hpRegen: 18, magicResist: 40, attackRange: 5.5, moveSpeed: 7.0 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 14, leashRange: 50 },
    style: { primary: 0xe4e0d2, secondary: 0xc4a44a, scale: 1.0, weapon: 'staff', cape: true, head: 'orb', robe: true },
  },
  {
    id: 'skeleton',
    name: 'Skeleton Warrior',
    kind: UnitKind.Minion,
    radius: 0.48,
    mass: 1.0,
    base: { hpMax: 260, armor: 14, magicResist: 4, attackDamage: 34, attackRange: 1.7, moveSpeed: 6.2 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 11, leashRange: Infinity },
    style: { primary: 0xd8d2c0, secondary: 0x6a6250, scale: 0.92, weapon: 'sword', cape: false, head: 'skull', bulk: 0.8 },
  },
  {
    id: 'wraith',
    name: 'Wraith',
    kind: UnitKind.Monster,
    radius: 0.66,
    mass: 1.4,
    base: { hpMax: 540, armor: 10, magicResist: 48, attackDamage: 52, attackRange: 2.4, moveSpeed: 7.4 },
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 13, leashRange: 26 },
    style: { primary: 0x5a4f78, secondary: 0x2a2440, scale: 1.1, weapon: 'none', cape: true, head: 'hooded', body: 'floating', robe: true },
  },
  {
    id: 'lich',
    name: 'Lich',
    kind: UnitKind.Monster,
    radius: 0.7,
    mass: 2.0,
    base: { hpMax: 1400, abilityPower: 90, armor: 30, magicResist: 60, attackDamage: 60, attackRange: 8.0, moveSpeed: 6.4 },
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 16, leashRange: 30 },
    style: { primary: 0x36465e, secondary: 0x1b2230, scale: 1.15, weapon: 'staff', cape: true, head: 'skull', body: 'floating', robe: true },
  },
  {
    id: 'direwolf',
    name: 'Dire Wolf',
    kind: UnitKind.Monster,
    radius: 0.7,
    mass: 2.2,
    base: { hpMax: 620, armor: 20, attackDamage: 56, attackRange: 1.9, attackSpeed: 0.9, moveSpeed: 9.0 },
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 14, leashRange: 30 },
    style: { primary: 0x5a5148, secondary: 0x332d28, scale: 1.05, weapon: 'none', cape: false, head: 'beast', body: 'quadruped', tail: true },
  },
  {
    id: 'cavebear',
    name: 'Cave Bear',
    kind: UnitKind.Monster,
    radius: 0.95,
    mass: 4.2,
    base: { hpMax: 1500, armor: 32, attackDamage: 86, attackRange: 2.3, attackSpeed: 0.55, moveSpeed: 6.4, hpRegen: 20 },
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 12, leashRange: 24 },
    style: { primary: 0x6b4b33, secondary: 0x42301f, scale: 1.4, weapon: 'none', cape: false, head: 'beast', body: 'quadruped', bulk: 1.3, tail: false },
  },
  {
    id: 'drake',
    name: 'Drake',
    kind: UnitKind.Monster,
    radius: 1.05,
    mass: 5.0,
    base: { hpMax: 2200, armor: 42, magicResist: 38, attackDamage: 110, attackRange: 3.0, attackSpeed: 0.5, moveSpeed: 6.8 },
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 15, leashRange: 30 },
    style: { primary: 0x6b3a4a, secondary: 0x3a1f28, scale: 1.5, weapon: 'none', cape: false, head: 'horned', body: 'quadruped', bulk: 1.25, tail: true },
  },
  {
    id: 'imp',
    name: 'Imp',
    kind: UnitKind.Minion,
    radius: 0.42,
    mass: 0.9,
    base: { hpMax: 190, abilityPower: 30, armor: 6, magicResist: 20, attackDamage: 28, attackRange: 6.0, moveSpeed: 7.0 },
    abilities: [],
    mesh: 'character',
    autoAcquire: true,
    ai: { aggroRange: 12, leashRange: Infinity },
    style: { primary: 0xa8402f, secondary: 0x5e1f16, scale: 0.62, weapon: 'claws', cape: false, head: 'horned', wings: 'bat', tail: true },
  },
  {
    id: 'demonbrute',
    name: 'Demon Brute',
    kind: UnitKind.Monster,
    radius: 1.15,
    mass: 5.5,
    base: { hpMax: 2600, armor: 46, magicResist: 30, attackDamage: 125, attackRange: 2.8, attackSpeed: 0.48, moveSpeed: 6.2 },
    abilities: [],
    mesh: 'character',
    autoAcquire: false,
    ai: { aggroRange: 14, leashRange: 28 },
    style: { primary: 0x77303a, secondary: 0x2d1218, scale: 1.6, weapon: 'axe', cape: false, head: 'horned', bulk: 1.45, tail: true, pauldrons: true },
  },
];

for (const entry of ROSTER) {
  ARCHETYPES[entry.id] = { ...entry, base: stats(entry.base) } as Archetype;
}

export function archetype(id: string): Archetype {
  const a = ARCHETYPES[id];
  if (!a) throw new Error(`Unknown archetype "${id}"`);
  return a;
}

/** Builds the final render style for an archetype on a given team. */
export function styleFor(id: string, team: Team): CharacterStyle {
  const a = archetype(id);
  return { ...a.style, accent: TEAM_COLOR[team] };
}
