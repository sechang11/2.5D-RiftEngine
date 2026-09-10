/**
 * Walk-over pickups.
 *
 * Any prop flagged as a pickup becomes collectable: a champion that touches it
 * takes it, the prop leaves the world, and its item is resolved from the asset
 * manifest. Dropping a sword on the ground in the editor and having it work in
 * play needs no extra authoring step, which is the whole point of deriving item
 * stats from the asset rather than from a separate table.
 *
 * Equipment is exclusive per slot and trinkets accumulate. Both are expressed
 * as stat modifiers under a source key, so swapping a weapon cleanly removes
 * the old one's contribution instead of leaving it behind.
 */

import type { Sim } from '../core/sim/sim';
import type { Prop, PropStore } from '../core/world/props';
import { PropFlag } from '../core/world/props';
import type { Unit } from '../core/ecs/types';
import { UnitKind } from '../core/ecs/types';
import { heal, recomputeStats, setModifiers } from '../core/combat/stats';
import type { AssetRegistry } from '../render/assets';
import { itemForAsset, type ItemDef } from './content/items';

/** Extra reach beyond the two radii, so pickups do not need a precise walk. */
const GRAB_SLACK = 0.35;

export interface PickupEvent {
  unit: Unit;
  item: ItemDef;
  x: number;
  y: number;
  replaced: string | null;
}

export class PickupSystem {
  private readonly sim: Sim;
  private readonly props: PropStore;
  private readonly assets: AssetRegistry;
  private readonly scratch: Prop[] = [];
  /** Trinkets held, per unit, so their modifiers can stack by index. */
  private trinkets = new Map<number, string[]>();

  onPickup: ((e: PickupEvent) => void) | null = null;

  constructor(sim: Sim, props: PropStore, assets: AssetRegistry) {
    this.sim = sim;
    this.props = props;
    this.assets = assets;
  }

  update(): void {
    const units = this.sim.world.units;
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      // Only champions collect. Minions walking a lane through a field of
      // dropped loot should not strip it on the way past.
      if (unit.kind !== UnitKind.Champion || unit.hp <= 0 || !unit.alive) continue;

      this.props.query(unit.pos.x, unit.pos.y, unit.radius + GRAB_SLACK, this.scratch);
      for (const prop of this.scratch) {
        if (!(prop.flags & PropFlag.Pickup)) continue;
        this.collect(unit, prop);
      }
    }
  }

  private collect(unit: Unit, prop: Prop): void {
    const entry = this.assets.get(prop.item ?? prop.assetId);
    if (!entry) {
      // An unknown asset is still consumed, so a broken pickup cannot become an
      // object the player walks over forever.
      this.props.remove(prop.id);
      return;
    }

    const item = itemForAsset(entry);
    if (!item) {
      this.props.remove(prop.id);
      return;
    }

    let replaced: string | null = null;

    if (item.consume) {
      if (item.consume.heal) heal(unit, item.consume.heal);
      if (item.consume.mana) unit.mp = Math.min(unit.stats.mpMax, unit.mp + item.consume.mana);
    } else if (item.slot === 'trinket') {
      const held = this.trinkets.get(unit.id) ?? [];
      held.push(item.id);
      this.trinkets.set(unit.id, held);
      // A unique source per copy lets the same trinket be picked up twice.
      setModifiers(unit, `trinket:${item.id}:${held.length}`, item.modifiers);
    } else {
      replaced = unit.equipment[item.slot] ?? null;
      unit.equipment[item.slot] = item.id;
      setModifiers(unit, `equip:${item.slot}`, item.modifiers);
    }

    recomputeStats(unit);
    this.props.remove(prop.id);
    this.props.rebuildNav();

    this.onPickup?.({ unit, item, x: prop.x, y: prop.y, replaced });
  }

  /** Everything a unit is carrying, for the HUD. */
  trinketsOf(unit: Unit): string[] {
    return this.trinkets.get(unit.id) ?? [];
  }

  /** Drops the equipped item of a slot back onto the map. */
  drop(unit: Unit, slot: 'weapon' | 'offhand'): boolean {
    const assetId = unit.equipment[slot];
    if (!assetId) return false;
    const entry = this.assets.get(assetId);
    delete unit.equipment[slot];
    setModifiers(unit, `equip:${slot}`, []);
    recomputeStats(unit);

    // Place it just in front of the champion so it is not instantly regrabbed.
    const dx = Math.sin(unit.facing) * (unit.radius + 1.2);
    const dy = Math.cos(unit.facing) * (unit.radius + 1.2);
    this.props.add({
      assetId,
      category: entry?.category ?? 'weapon',
      x: unit.pos.x + dx,
      y: unit.pos.y + dy,
      flags: PropFlag.Pickup,
      radius: entry?.radius ?? 0.4,
      item: assetId,
    });
    return true;
  }
}
