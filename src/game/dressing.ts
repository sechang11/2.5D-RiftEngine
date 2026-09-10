/**
 * Automatic map dressing.
 *
 * An editor is only useful once there is something to edit, and hand-placing
 * two thousand trees is nobody's idea of a good time. This scatters the asset
 * pack across the map using the same masks the terrain shader already uses, so
 * the result agrees with the ground it stands on: forest in the jungle, reeds
 * along the river, rubble around the ruins, nothing in the lanes.
 *
 * It is a starting point, not a final layout. Everything it places is an
 * ordinary prop that the editor can move, rescale or delete, and the whole
 * thing is seeded, so the same seed always produces the same map.
 */

import { CellFlag } from '../core/nav/navgrid';
import { Rng } from '../core/math/rng';
import { PropFlag, type PropStore } from '../core/world/props';
import { Team } from '../core/ecs/types';
import type { AssetRegistry, AssetEntry } from '../render/assets';
import type { GameMap } from './content/map01';
import { vec2 } from '../core/math/vec2';

export interface DressingOptions {
  seed?: number;
  /** Multiplies every density. Zero places nothing. */
  density?: number;
  /** Keep this far from lane centrelines, so play space stays clear. */
  laneClearance?: number;
}

interface Rule {
  /** Which assets can satisfy this rule. */
  match: (e: AssetEntry) => boolean;
  /**
   * Roughly how many of this rule's assets to place on a full-size map, before
   * rejections. The actual count comes out lower, because most attempts land
   * somewhere the rule refuses.
   */
  attempts: number;
  /** Where this rule is allowed to place. */
  where: (ctx: PlacementContext) => boolean;
  scale: [number, number];
  blocks: boolean;
  /** Minimum spacing between two props from this rule. */
  spacing: number;
  /**
   * Regions to draw candidate positions from, instead of the whole map.
   *
   * Most rules can sample uniformly and reject what does not fit. A rule
   * aimed at a small region cannot: a ring around the two spawns is about
   * 1.5% of a 300 by 300 map, so ninety uniform attempts land one or two
   * inside it and the base ends up bare. Sampling the region directly makes
   * the attempt budget mean what it says.
   */
  regions?: (anchors: Anchors) => Array<{ x: number; y: number; radius: number; inner?: number }>;
}

interface Anchors {
  blue: { x: number; y: number };
  red: { x: number; y: number };
}

interface PlacementContext {
  x: number;
  y: number;
  laneStrength: number;
  riverStrength: number;
  brushStrength: number;
  distanceFromCentre: number;
  clearance: number;
  /** Distance to the nearer team's spawn point. */
  distanceFromBase: number;
}

const has = (e: AssetEntry, ...needles: string[]): boolean => {
  const hay = (e.id + ' ' + e.tags.join(' ')).toLowerCase();
  return needles.some((n) => hay.includes(n));
};

/**
 * Smallest bounding dimension over the largest. Near zero means a flat sheet.
 */
const flatness = (e: AssetEntry): number => {
  const mx = Math.max(...e.size);
  return mx > 1e-6 ? Math.min(...e.size) / mx : 0;
};

/**
 * Scattering ignores assets that came back as flat sheets.
 *
 * Reconstruction occasionally returns a subject with almost no depth. Placed by
 * hand and rotated to face the camera, such an asset is a usable billboard;
 * scattered at random rotations across a map it is a dark quad lying in the
 * grass, and one of them ruins a screenful of otherwise good scenery.
 *
 * They stay in the pack and in the editor palette. They are simply not chosen
 * automatically.
 *
 * Only scenery is filtered. A blade and a shield are supposed to be thin, and
 * they lie flat on the ground where that is exactly right.
 */
const MIN_SCATTER_FLATNESS = 0.29;
const SCATTER_FILTERED = new Set(['nature', 'prop', 'building', 'creature']);

/**
 * Widest ground dimension over height, above which an asset is skipped.
 *
 * A few reconstructions kept the ground plate the generator invented beneath
 * them, and geometric removal could not be made reliable without damaging
 * assets that legitimately have a wide base. A plate is unmistakable in the
 * numbers, though: a barrel three units across and one tall is a barrel sitting
 * on a disc. Those are left out of automatic scattering rather than cut,
 * because a bad cut is permanent and a skipped asset is not.
 */
const MAX_SCATTER_FOOTPRINT_RATIO = 1.9;

/**
 * How disc-like the footprint is: the *smaller* ground dimension over height.
 *
 * Using the smaller one is what separates a plate from a genuinely low object.
 * A plate is a disc, wide in both directions at once. A fallen log is long in
 * one direction and narrow in the other, so its smaller dimension stays close
 * to its height and it is kept.
 */
const footprintRatio = (e: AssetEntry): number =>
  Math.min(e.size[0], e.size[2]) / Math.max(0.01, e.size[1]);

/** Things that really do hug the ground, whatever the ratio says. */
const GROUND_HUGGING = ['log', 'rocks_small', 'sand', 'snow', 'rubble', 'lilypad', 'coral', 'bones_pile'];

const scatterable = (e: AssetEntry): boolean => {
  if (!SCATTER_FILTERED.has(e.category)) return true;
  // The exemption comes first: a fallen log is both flat and wide by nature,
  // and both tests would otherwise reject it for being exactly what it is.
  if (GROUND_HUGGING.some((k) => e.id.includes(k))) return true;
  if (flatness(e) < MIN_SCATTER_FLATNESS) return false;
  return footprintRatio(e) <= MAX_SCATTER_FOOTPRINT_RATIO;
};

/**
 * Placement rules, in application order.
 *
 * Densities are deliberately conservative. A map that reads as a forest from
 * the camera's fixed height needs far fewer trees than it looks like it should,
 * and every prop is a nav-grid stamp and an instance to draw.
 */
const RULES: Rule[] = [
  {
    // Base camp. The spawn is where every session starts and where a player
    // spends the first ten seconds, so it is the one place scenery is
    // guaranteed to be seen. The earlier rules all avoided lanes, and a spawn
    // is entirely lane, so the game opened onto bare ground with two hundred
    // assets loaded and none of them visible.
    match: (e) =>
      e.category === 'prop' &&
      has(e, 'banner', 'tent', 'brazier', 'crate', 'barrel', 'sack', 'anvil', 'weapon_rack', 'target_dummy', 'bench', 'cart'),
    attempts: 120,
    regions: (a) => [
      { x: a.blue.x, y: a.blue.y, radius: 24, inner: 6 },
      { x: a.red.x, y: a.red.y, radius: 24, inner: 6 },
    ],
    where: (c) => c.distanceFromBase > 5.5 && c.distanceFromBase < 26,
    scale: [0.9, 1.15],
    blocks: false,
    spacing: 3.0,
  },
  {
    // Deep forest, away from lanes and the river.
    match: (e) => e.category === 'nature' && has(e, 'oak', 'pine', 'birch', 'willow', 'dead_tree'),
    attempts: 340,
    where: (c) => c.laneStrength < 0.08 && c.riverStrength < 0.15 && c.clearance > 2.2,
    scale: [0.85, 1.35],
    blocks: true,
    spacing: 4.5,
  },
  {
    // Treeline along the lanes. A player walking a lane should have scenery
    // beside them the whole way, not only when they step into the jungle.
    match: (e) => e.category === 'nature' && has(e, 'oak', 'pine', 'birch', 'dead_tree', 'stump'),
    attempts: 260,
    where: (c) => c.laneStrength > 0.06 && c.laneStrength < 0.55 && c.clearance > 2.0,
    scale: [0.8, 1.2],
    blocks: true,
    spacing: 5.0,
  },
  {
    // Low cover right at the lane's edge, which does not block the walk.
    match: (e) => e.category === 'nature' && has(e, 'bush', 'fern', 'bramble', 'rocks', 'boulder', 'mushroom_cluster'),
    attempts: 320,
    where: (c) => c.laneStrength > 0.3 && c.laneStrength < 0.9 && c.clearance > 1.2,
    scale: [0.7, 1.15],
    blocks: false,
    spacing: 2.6,
  },
  {
    // Undergrowth fills in between the trees and does not block.
    match: (e) => e.category === 'nature' && has(e, 'bush', 'fern', 'bramble', 'mushroom_cluster', 'flowers'),
    attempts: 520,
    where: (c) => c.laneStrength < 0.35 && c.clearance > 1.0,
    scale: [0.7, 1.3],
    blocks: false,
    spacing: 2.0,
  },
  {
    // Rocks cluster near existing terrain, which reads as an outcrop.
    match: (e) => e.category === 'nature' && has(e, 'boulder', 'rocks', 'rock_spire', 'cliff'),
    attempts: 220,
    where: (c) => c.laneStrength < 0.12 && c.clearance > 1.4 && c.clearance < 6,
    scale: [0.7, 1.5],
    blocks: true,
    spacing: 3.4,
  },
  {
    // Wetland planting hugs the river band.
    match: (e) => e.category === 'nature' && has(e, 'reeds', 'cattails', 'lilypad', 'swamp_root'),
    attempts: 260,
    where: (c) => c.riverStrength > 0.35,
    scale: [0.8, 1.3],
    blocks: false,
    spacing: 2.2,
  },
  {
    // Crystals and glowing things, sparse enough to feel like a find.
    match: (e) => e.category === 'nature' && has(e, 'crystal', 'mushroom_giant', 'ice_shard', 'lava_rock'),
    attempts: 60,
    where: (c) => c.laneStrength < 0.05 && c.clearance > 2.5,
    scale: [0.8, 1.4],
    blocks: true,
    spacing: 12,
  },
  {
    // Bones and ruins, scattered in the wild.
    match: (e) => e.category === 'nature' && has(e, 'bones', 'tombstone', 'ruin', 'rubble', 'stump', 'log'),
    attempts: 110,
    where: (c) => c.laneStrength < 0.1 && c.clearance > 1.6,
    scale: [0.8, 1.2],
    blocks: false,
    spacing: 6,
  },
  {
    // Roadside props sit just off the lane, where a player will actually see
    // them at the camera's fixed height.
    match: (e) => e.category === 'prop' && has(e, 'signpost', 'lantern', 'fence', 'cart', 'barrel', 'crate', 'bench'),
    attempts: 130,
    where: (c) => c.laneStrength > 0.25 && c.laneStrength < 0.75,
    scale: [0.85, 1.15],
    blocks: false,
    spacing: 7,
  },
  {
    // Buildings are rare, large, and kept well off the lane.
    match: (e) => e.category === 'building' && !has(e, 'bridge', 'palisade', 'barricade'),
    attempts: 70,
    where: (c) => c.laneStrength < 0.04 && c.clearance > 5.5 && c.distanceFromCentre > 30,
    scale: [0.9, 1.1],
    blocks: true,
    spacing: 26,
  },
  {
    // A little loot, near the edges of the play space.
    match: (e) => e.category === 'pickup',
    attempts: 70,
    where: (c) => c.laneStrength < 0.5 && c.clearance > 1.2,
    scale: [1, 1],
    blocks: false,
    spacing: 14,
  },
  {
    // A handful of weapons on the ground, so the pickup system has something
    // to demonstrate without a trip to the editor.
    match: (e) => e.category === 'weapon' || e.category === 'shield',
    attempts: 46,
    where: (c) => c.laneStrength < 0.6 && c.clearance > 1.5,
    scale: [1, 1],
    blocks: false,
    spacing: 20,
  },
];

export interface DressingReport {
  placed: number;
  byCategory: Record<string, number>;
  rejected: number;
}

export function dressMap(
  map: GameMap,
  props: PropStore,
  assets: AssetRegistry,
  opts: DressingOptions = {},
): DressingReport {
  const rng = new Rng(opts.seed ?? 0x5eed1e);
  const density = opts.density ?? 1;
  const nav = map.nav;
  nav.ensureClearance();

  const report: DressingReport = { placed: 0, byCategory: {}, rejected: 0 };
  if (assets.size === 0 || density <= 0) return report;

  // Spatial buckets of what has already been placed, so spacing checks stay
  // cheap as the map fills up.
  //
  // Two levels, and the split matters. A rule's own spacing is checked only
  // against props that rule placed; a small global spacing stops anything from
  // landing inside anything else. Sharing one set of buckets across all rules
  // means a few hundred trees, each demanding several units of clearance,
  // silently starve every rule that runs after them, and the map comes out with
  // no buildings and no loot on it.
  const cell = 8;
  const cols = Math.ceil(nav.width / cell);
  type Placed = { x: number; y: number; spacing: number };
  const globalBuckets = new Map<number, Placed[]>();
  let ruleBuckets = new Map<number, Placed[]>();

  /** Nothing may land closer than this to anything else, whatever the rule. */
  const GLOBAL_SPACING = 1.1;

  const keyFor = (x: number, y: number): number => {
    const cx = Math.floor((x - nav.minX) / cell);
    const cy = Math.floor((y - nav.minY) / cell);
    return cy * cols + cx;
  };

  const nearAny = (
    store: Map<number, Placed[]>,
    x: number,
    y: number,
    spacing: number,
  ): boolean => {
    const cx = Math.floor((x - nav.minX) / cell);
    const cy = Math.floor((y - nav.minY) / cell);
    // Spacing can exceed one bucket, so widen the search to cover it.
    const reach = Math.max(1, Math.ceil(spacing / cell));
    for (let j = cy - reach; j <= cy + reach; j++) {
      for (let i = cx - reach; i <= cx + reach; i++) {
        const list = store.get(j * cols + i);
        if (!list) continue;
        for (const p of list) {
          const need = Math.max(spacing, p.spacing);
          const dx = p.x - x;
          const dy = p.y - y;
          if (dx * dx + dy * dy < need * need) return true;
        }
      }
    }
    return false;
  };

  const tooClose = (x: number, y: number, spacing: number): boolean =>
    nearAny(ruleBuckets, x, y, spacing) || nearAny(globalBuckets, x, y, GLOBAL_SPACING);

  const rememberIn = (store: Map<number, Placed[]>, x: number, y: number, spacing: number): void => {
    const k = keyFor(x, y);
    let list = store.get(k);
    if (!list) {
      list = [];
      store.set(k, list);
    }
    list.push({ x, y, spacing });
  };

  // Attempt budgets are written for a standard 300 by 300 map, and scale with
  // area so a larger map is dressed at the same visual density.
  const areaScale = (nav.width * nav.height) / (300 * 300);
  const snap = vec2();
  const blue = map.spawns[Team.Blue];
  const red = map.spawns[Team.Red];

  for (const rule of RULES) {
    const pool = assets.all().filter(rule.match).filter(scatterable);
    if (pool.length === 0) continue;

    // Each rule spaces itself only against its own placements.
    ruleBuckets = new Map<number, Placed[]>();
    const regions = rule.regions ? rule.regions({ blue, red }) : null;
    // A region-targeted rule places the same number wherever the map is, so its
    // budget does not scale with total area.
    const attempts = Math.round(rule.attempts * density * (regions ? 1 : areaScale));

    for (let a = 0; a < attempts; a++) {
      let x: number;
      let y: number;
      if (regions && regions.length > 0) {
        const region = regions[rng.int(0, regions.length - 1)];
        // Uniform over the annulus: sampling the radius linearly would crowd
        // everything into the middle.
        const inner = region.inner ?? 0;
        const r = Math.sqrt(rng.range(inner * inner, region.radius * region.radius));
        const theta = rng.range(0, Math.PI * 2);
        x = region.x + Math.cos(theta) * r;
        y = region.y + Math.sin(theta) * r;
        if (x < nav.minX + 6 || x > nav.maxX - 6 || y < nav.minY + 6 || y > nav.maxY - 6) {
          report.rejected++;
          continue;
        }
      } else {
        x = rng.range(nav.minX + 8, nav.maxX - 8);
        y = rng.range(nav.minY + 8, nav.maxY - 8);
      }

      const col = nav.colAt(x);
      const row = nav.rowAt(y);
      const idx = nav.idx(col, row);

      // Never place inside terrain, and never inside existing brush cover.
      if (nav.flags[idx] & CellFlag.BlockMove) {
        report.rejected++;
        continue;
      }

      const ctx: PlacementContext = {
        x,
        y,
        laneStrength: map.laneMask[idx] / 255,
        riverStrength: map.riverMask[idx] / 255,
        brushStrength: map.brushMask[idx] / 255,
        distanceFromCentre: Math.hypot(x, y),
        distanceFromBase: Math.min(
          Math.hypot(x - blue.x, y - blue.y),
          Math.hypot(x - red.x, y - red.y),
        ),
        clearance: nav.clearanceAt(col, row),
      };

      if (!rule.where(ctx)) {
        report.rejected++;
        continue;
      }
      if (tooClose(x, y, rule.spacing)) {
        report.rejected++;
        continue;
      }

      const entry = pool[rng.int(0, pool.length - 1)];
      const scale = rng.range(rule.scale[0], rule.scale[1]);
      const footprint = entry.radius * scale;

      // A blocking prop must fit without sealing a corridor, so it needs room
      // for a champion to still pass beside it.
      if (rule.blocks && ctx.clearance < footprint + 1.6) {
        report.rejected++;
        continue;
      }
      if (!nav.nearestFit(snap, x, y, Math.min(footprint, 1.5), 4)) {
        report.rejected++;
        continue;
      }

      const isPickup = entry.category === 'pickup' || entry.category === 'weapon' || entry.category === 'shield';
      let flags: PropFlag = PropFlag.None;
      if (rule.blocks) flags |= PropFlag.Blocks;
      if (rule.blocks && entry.category === 'building') flags |= PropFlag.Opaque;
      if (isPickup) flags |= PropFlag.Pickup;

      props.add({
        assetId: entry.id,
        category: entry.category,
        x: snap.x,
        y: snap.y,
        rotation: rng.range(-Math.PI, Math.PI),
        scale,
        flags,
        radius: entry.radius,
        item: isPickup ? entry.id : null,
      });

      rememberIn(ruleBuckets, snap.x, snap.y, rule.spacing);
      rememberIn(globalBuckets, snap.x, snap.y, GLOBAL_SPACING);
      report.placed++;
      report.byCategory[entry.category] = (report.byCategory[entry.category] ?? 0) + 1;
    }
  }

  props.invalidateNav();
  props.rebuildNav(true);
  return report;
}
