/**
 * Items, derived from the asset pack rather than hand-authored.
 *
 * There are forty weapons and shields in the generated pack and there will be
 * more. Writing a stat line for each by hand would be a hundred lines of table
 * that immediately goes stale the moment the pack is regenerated. Instead an
 * item's numbers come from what the engine already knows about the mesh: its
 * category, its tags, and how big it is.
 *
 * A greatsword hits harder and swings slower than a dagger because it is
 * physically larger in the manifest, not because someone typed that in. New
 * weapons get sensible stats for free, and the balance curve lives in one
 * place where it can be tuned as a curve.
 */

import type { StatModifier } from '../../core/ecs/types';
import type { AssetEntry } from '../../render/assets';

export type ItemSlot = 'weapon' | 'offhand' | 'trinket';

export interface ItemDef {
  id: string;
  name: string;
  slot: ItemSlot;
  modifiers: StatModifier[];
  /** One-line summary for the pickup toast and the inventory panel. */
  description: string;
  /** Instant effect on pickup rather than a persistent modifier. */
  consume?: { heal?: number; mana?: number };
}

/** Reference weapon length in world units; longer means heavier. */
const REFERENCE_LENGTH = 1.3;

function describe(mods: StatModifier[]): string {
  const parts: string[] = [];
  for (const m of mods) {
    const label = STAT_LABEL[m.stat] ?? m.stat;
    if (m.add) parts.push(`${m.add > 0 ? '+' : ''}${Math.round(m.add)} ${label}`);
    if (m.mul) parts.push(`${m.mul > 0 ? '+' : ''}${Math.round(m.mul * 100)}% ${label}`);
  }
  return parts.join(', ') || 'No effect';
}

const STAT_LABEL: Partial<Record<StatModifier['stat'], string>> = {
  attackDamage: 'attack damage',
  abilityPower: 'ability power',
  attackSpeed: 'attack speed',
  attackRange: 'range',
  armor: 'armour',
  magicResist: 'magic resist',
  hpMax: 'health',
  mpMax: 'mana',
  moveSpeed: 'move speed',
  critChance: 'crit',
};

const has = (entry: AssetEntry, ...needles: string[]): boolean => {
  const hay = (entry.id + ' ' + entry.name + ' ' + entry.tags.join(' ')).toLowerCase();
  return needles.some((n) => hay.includes(n));
};

/**
 * Builds an item from a manifest entry, or null when the asset is not
 * something a champion can carry.
 */
export function itemForAsset(entry: AssetEntry): ItemDef | null {
  const length = Math.max(entry.size[0], entry.size[1], entry.size[2]);
  const heft = length / REFERENCE_LENGTH;

  if (entry.category === 'weapon') {
    const mods: StatModifier[] = [];

    if (has(entry, 'staff', 'wand', 'orb', 'tome', 'scroll')) {
      // Casting implements trade attack damage for ability power and mana.
      mods.push({ stat: 'abilityPower', add: Math.round(28 * heft + 12), source: 'item' });
      mods.push({ stat: 'mpMax', add: Math.round(60 * heft), source: 'item' });
      mods.push({ stat: 'attackRange', add: 1.2, source: 'item' });
    } else if (has(entry, 'bow', 'crossbow')) {
      mods.push({ stat: 'attackDamage', add: Math.round(16 * heft + 8), source: 'item' });
      mods.push({ stat: 'attackRange', add: 2.4, source: 'item' });
      mods.push({ stat: 'critChance', add: 0.08, source: 'item' });
    } else {
      // Melee: damage rises with size, attack speed falls with it.
      mods.push({ stat: 'attackDamage', add: Math.round(18 * heft + 6), source: 'item' });
      mods.push({ stat: 'attackSpeed', mul: -0.16 * (heft - 1), source: 'item' });
      if (heft > 1.25) mods.push({ stat: 'armor', add: Math.round(8 * (heft - 1)), source: 'item' });
      if (heft < 0.6) mods.push({ stat: 'attackSpeed', mul: 0.18, source: 'item' });
    }

    return {
      id: entry.id,
      name: entry.name,
      slot: 'weapon',
      modifiers: mods,
      description: describe(mods),
    };
  }

  if (entry.category === 'shield') {
    const mods: StatModifier[] = [
      { stat: 'armor', add: Math.round(18 * heft + 6), source: 'item' },
      { stat: 'magicResist', add: Math.round(10 * heft + 4), source: 'item' },
      { stat: 'hpMax', add: Math.round(90 * heft), source: 'item' },
      { stat: 'attackSpeed', mul: -0.08, source: 'item' },
    ];
    return {
      id: entry.id,
      name: entry.name,
      slot: 'offhand',
      modifiers: mods,
      description: describe(mods),
    };
  }

  if (entry.category === 'pickup') {
    if (has(entry, 'potion_red', 'health')) {
      return { id: entry.id, name: entry.name, slot: 'trinket', modifiers: [], description: 'Restores health', consume: { heal: 260 } };
    }
    if (has(entry, 'potion_blue', 'mana')) {
      return { id: entry.id, name: entry.name, slot: 'trinket', modifiers: [], description: 'Restores mana', consume: { mana: 180 } };
    }
    if (has(entry, 'elixir')) {
      return { id: entry.id, name: entry.name, slot: 'trinket', modifiers: [], description: 'Restores health and mana', consume: { heal: 140, mana: 100 } };
    }

    // Everything else in the pickup category is a trinket with a small,
    // thematically-chosen bonus.
    const mods: StatModifier[] = [];
    if (has(entry, 'ruby')) mods.push({ stat: 'hpMax', add: 140, source: 'item' });
    else if (has(entry, 'sapphire')) mods.push({ stat: 'mpMax', add: 140, source: 'item' });
    else if (has(entry, 'emerald')) mods.push({ stat: 'hpRegen', add: 8, source: 'item' });
    else if (has(entry, 'crown')) mods.push({ stat: 'abilityPower', add: 40, source: 'item' });
    else if (has(entry, 'amulet')) mods.push({ stat: 'magicResist', add: 22, source: 'item' });
    else if (has(entry, 'ring')) mods.push({ stat: 'critChance', add: 0.12, source: 'item' });
    else if (has(entry, 'rune')) mods.push({ stat: 'abilityPower', add: 25, source: 'item' });
    else if (has(entry, 'herb', 'mushroom')) mods.push({ stat: 'hpRegen', add: 6, source: 'item' });
    else if (has(entry, 'coin', 'gold')) mods.push({ stat: 'moveSpeed', add: 0.3, source: 'item' });
    else if (has(entry, 'key')) mods.push({ stat: 'armor', add: 6, source: 'item' });
    else if (has(entry, 'skull')) mods.push({ stat: 'attackDamage', add: 12, source: 'item' });
    else mods.push({ stat: 'hpMax', add: 60, source: 'item' });

    return {
      id: entry.id,
      name: entry.name,
      slot: 'trinket',
      modifiers: mods,
      description: describe(mods),
    };
  }

  return null;
}

/** Which rig socket an item's mesh should hang from. */
export function socketFor(slot: ItemSlot): 'rightHand' | 'leftHand' | 'none' {
  if (slot === 'weapon') return 'rightHand';
  if (slot === 'offhand') return 'leftHand';
  return 'none';
}
