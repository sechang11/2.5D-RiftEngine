/**
 * Scene serialization.
 *
 * A map that only exists as code cannot be edited by anyone who is not editing
 * code, which is the single thing that stops a game engine from being useful to
 * more than one person. This is the format the editor reads and writes: the
 * terrain generator's seed, every placed prop, and every placed unit.
 *
 * Terrain itself is not stored. It is regenerated from the seed, which keeps a
 * scene file a few kilobytes instead of a few megabytes, and means a change to
 * the generator improves every existing scene rather than orphaning it. Props
 * stamped into the navigation grid are re-stamped on load.
 */

import type { PropStore } from '../core/world/props';
import { PropFlag } from '../core/world/props';
import type { Sim } from '../core/sim/sim';
import type { Unit } from '../core/ecs/types';
import { Team, UnitKind } from '../core/ecs/types';
import { spawnUnit } from './scenario';
import { vec2 } from '../core/math/vec2';

export const SCENE_VERSION = 2;

export interface SerializedProp {
  a: string;
  x: number;
  y: number;
  /** Rotation in radians. Omitted when zero. */
  r?: number;
  /** Scale. Omitted when one. */
  s?: number;
  /** Flag bits. Omitted when none. */
  f?: number;
  item?: string;
  data?: Record<string, string | number>;
}

export interface SerializedUnit {
  a: string;
  t: number;
  x: number;
  y: number;
  f?: number;
  name?: string;
}

export interface Scene {
  version: number;
  name: string;
  mapSeed: number;
  props: SerializedProp[];
  units: SerializedUnit[];
}

const round = (v: number, places = 3): number => {
  const m = 10 ** places;
  return Math.round(v * m) / m;
};

export function serialize(name: string, mapSeed: number, props: PropStore, sim: Sim): Scene {
  const out: Scene = { version: SCENE_VERSION, name, mapSeed, props: [], units: [] };

  for (const p of props.props) {
    const entry: SerializedProp = { a: p.assetId, x: round(p.x), y: round(p.y) };
    // Defaults are omitted rather than written, which roughly halves the file
    // and makes a diff between two scenes readable.
    if (p.rotation) entry.r = round(p.rotation, 4);
    if (p.scale !== 1) entry.s = round(p.scale, 3);
    if (p.flags) entry.f = p.flags;
    if (p.item) entry.item = p.item;
    if (Object.keys(p.data).length) entry.data = p.data;
    out.props.push(entry);
  }

  for (const u of sim.world.units) {
    // Champions are placed by the game mode, not by the map.
    if (u.kind === UnitKind.Champion) continue;
    const entry: SerializedUnit = {
      a: u.archetype,
      t: u.team,
      x: round(u.pos.x),
      y: round(u.pos.y),
    };
    if (u.facing) entry.f = round(u.facing, 3);
    if (u.name && u.name !== u.archetype) entry.name = u.name;
    out.units.push(entry);
  }

  return out;
}

export interface LoadResult {
  props: number;
  units: number;
  warnings: string[];
}

/**
 * Applies a scene to a live world.
 *
 * `spawnUnits` is optional because the editor reloads scenes constantly while
 * dressing a map and rarely wants the population reset with them.
 */
export function deserialize(
  scene: Scene,
  props: PropStore,
  sim: Sim,
  opts: {
    /** Restore the scene's units. Defaults to true. */
    spawnUnits?: boolean;
    /**
     * Despawn existing non-champion units first, so loading a scene replaces
     * its population rather than adding a second copy of it. Champions are
     * always kept: they belong to the game mode, not to the map.
     */
    replaceUnits?: boolean;
    radiusOf?: (assetId: string) => number;
  } = {},
): LoadResult {
  const warnings: string[] = [];
  if (scene.version > SCENE_VERSION) {
    warnings.push(`scene version ${scene.version} is newer than this build (${SCENE_VERSION})`);
  }

  props.clear();
  for (const p of scene.props) {
    props.add({
      assetId: p.a,
      x: p.x,
      y: p.y,
      rotation: p.r ?? 0,
      scale: p.s ?? 1,
      flags: (p.f ?? 0) as PropFlag,
      radius: opts.radiusOf ? opts.radiusOf(p.a) : 0.5,
      item: p.item ?? null,
      data: p.data,
    });
  }
  props.invalidateNav();
  props.rebuildNav(true);

  let unitCount = 0;
  if (opts.spawnUnits !== false) {
    if (opts.replaceUnits) {
      // Iterate a copy: despawn swaps the last unit into the freed slot, so
      // walking the live array would skip whoever got moved.
      for (const existing of [...sim.world.units]) {
        if (existing.kind === UnitKind.Champion) continue;
        sim.world.despawn(existing.id);
      }
    }
    for (const u of scene.units) {
      try {
        const unit: Unit = spawnUnit(sim, u.a, u.t as Team, vec2(u.x, u.y));
        if (u.f !== undefined) unit.facing = u.f;
        if (u.name) unit.name = u.name;
        unitCount++;
      } catch (err) {
        warnings.push(`unit "${u.a}": ${String(err)}`);
      }
    }
  }

  return { props: scene.props.length, units: unitCount, warnings };
}

// --- persistence ----------------------------------------------------------

const STORAGE_PREFIX = 'rift.scene.';

export function saveLocal(slot: string, scene: Scene): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + slot, JSON.stringify(scene));
  } catch (err) {
    console.warn('[scene] could not save locally:', err);
  }
}

export function loadLocal(slot: string): Scene | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + slot);
    return raw ? (JSON.parse(raw) as Scene) : null;
  } catch (err) {
    console.warn('[scene] could not load locally:', err);
    return null;
  }
}

export function listLocal(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) out.push(key.slice(STORAGE_PREFIX.length));
    }
  } catch {
    /* storage unavailable */
  }
  return out.sort();
}

export function deleteLocal(slot: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + slot);
  } catch {
    /* ignore */
  }
}

/** Offers the scene as a file download. */
export function exportFile(scene: Scene): void {
  const blob = new Blob([JSON.stringify(scene, null, 1)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${scene.name.replace(/[^a-z0-9_-]+/gi, '_')}.scene.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the click has definitely been serviced.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Prompts for a file and returns the parsed scene. */
export function importFile(): Promise<Scene | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(String(reader.result)) as Scene);
        } catch (err) {
          console.warn('[scene] import failed:', err);
          resolve(null);
        }
      };
      reader.readAsText(file);
    };
    input.click();
  });
}
