/**
 * Highhold: a city laid out for the reasons a real one is.
 *
 * The first version of this file zoned a rectangle into blocks and filled each
 * with whatever fitted. That is a subdivision, not a city. A city is the record
 * of a set of arguments — about water, fire, smell, defence, money and God —
 * and every one of them leaves a mark on the plan:
 *
 *   The castle takes the high ground at the back and walls itself off again,
 *   because it is defending itself from the town as much as from the enemy.
 *
 *   The market is not in the middle. It is where the roads from the gates meet,
 *   and the town hall, the weigh house and the guildhall face onto it because
 *   that is where the money is counted.
 *
 *   The trades are grouped, and the grouping is physical. Tanners, dyers and
 *   fullers need running water and produce a stench, so they are downstream and
 *   outside the wall — never upstream of what the town drinks. Smiths, potters
 *   and bakers are a fire risk, so they are a quarter of their own against the
 *   wall. Weavers and joiners are clean and quiet and live in the town proper.
 *
 *   The wharf is where the river is deep, the warehouses are behind it, and the
 *   worst housing in the city is behind them.
 *
 *   Clean water is brought in from outside on an aqueduct, because the river
 *   inside the walls is a sewer by the time it leaves.
 *
 *   Wealth falls off with distance from the market: stone on the High Street,
 *   timber in the wards, tenements by the docks, hovels against the wall.
 *
 * The plan is drawn in that order — water, then walls, then the streets between
 * the gates, then the precincts that claim their ground, then the wards that
 * take what is left — because that is the order the arguments were settled in.
 *
 * Scale: a champion is 2.2 units, so one unit is about eighty centimetres. A
 * two-storey house is eleven units, the curtain wall twelve, the keep forty,
 * the minster sixty-four. Those ratios are the point; the first city was built
 * at half of them and read as a model village.
 */

import { CellFlag, NavGrid } from '../../core/nav/navgrid';
import { Rng } from '../../core/math/rng';
import { Team } from '../../core/ecs/types';
import { vec2 } from '../../core/math/vec2';
import type { GameMap } from './map01';
import type { AssetRegistry } from '../../render/assets';
import { PropFlag, type PropStore } from '../../core/world/props';

const COLS = 620;
const ROWS = 560;
const CELL = 1;
const BORDER = 4;

/** One curtain-wall section, so everything on the wall is a multiple of it. */
const WALL_SEG = 9.6;
/** A tower every this many sections. */
const TOWER_EVERY = 5;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Point {
  x: number;
  y: number;
}

export interface Placement {
  assetId: string;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  blocks: boolean;
}

/**
 * One quarter of the city.
 *
 * `palette` is what may be built here and `crowd` is who is here during the
 * day, and the two together are what makes a district a place rather than a
 * colour on a map: the Shambles is butchers' houses with butchers outside them.
 */
export interface District {
  name: string;
  rect: Rect;
  palette: string[];
  crowd?: string[];
  /** Trade clutter scattered along this district's frontages. */
  fittings?: string[];
  minPlot: number;
  fill: number;
  /** People per hundred square units of district. */
  crowding?: number;
}

export interface CityPlan {
  landmarks: Array<{ name: string; x: number; y: number }>;
  districts: District[];
  streets: Rect[];
  gates: Array<{ name: string; x: number; y: number }>;
  placements: Placement[];
  entrance: Point;
}

export type CityMap = GameMap & { plan: CityPlan };

// ---------------------------------------------------------------------------
// The ground the city is on
// ---------------------------------------------------------------------------

/** Where the river runs. It is the reason the town is here. */
function riverY(x: number): number {
  return 138 + 20 * Math.sin((x + 90) / 150) + 7 * Math.sin((x - 40) / 47);
}

const RIVER_HALF = 15;

/**
 * The wall, as a closed circuit.
 *
 * An octagon rather than a rectangle. Real circuits follow the ground and the
 * old ditch, and a rectangle is the one shape that says nobody had to.
 */
const WALL_RING: Point[] = [
  { x: -150, y: -228 },
  { x: 150, y: -228 },
  { x: 205, y: -160 },
  { x: 205, y: 40 },
  { x: 140, y: 122 },
  { x: -140, y: 122 },
  { x: -205, y: 40 },
  { x: -205, y: -160 },
];

/** The castle's own circuit, in the north-west corner. */
const CITADEL: Rect = { x0: -168, y0: -222, x1: -46, y1: -122 };
/** The cathedral's precinct, opposite it. */
const CLOSE: Rect = { x0: 40, y0: -216, x1: 190, y1: -118 };
/** Where the two main streets meet. */
const MARKET: Rect = { x0: -46, y0: -74, x1: 46, y1: 6 };

const AVENUE = 17;
const STREET = 11;

// ---------------------------------------------------------------------------
// grid helpers
// ---------------------------------------------------------------------------

function rectCells(nav: NavGrid, r: Rect) {
  return {
    c0: Math.max(0, nav.colAt(Math.min(r.x0, r.x1))),
    r0: Math.max(0, nav.rowAt(Math.min(r.y0, r.y1))),
    c1: Math.min(nav.cols - 1, nav.colAt(Math.max(r.x0, r.x1))),
    r1: Math.min(nav.rows - 1, nav.rowAt(Math.max(r.y0, r.y1))),
  };
}

function paint(nav: NavGrid, mask: Uint8Array, r: Rect, value: number): void {
  const { c0, r0, c1, r1 } = rectCells(nav, r);
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const i = nav.idx(cx, cy);
      if (mask[i] < value) mask[i] = value;
    }
  }
}

function paintLine(nav: NavGrid, mask: Uint8Array, a: Point, b: Point, half: number, value: number): void {
  const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2) + 1;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const x = a.x + (b.x - a.x) * t;
    const y = a.y + (b.y - a.y) * t;
    paint(nav, mask, { x0: x - half, y0: y - half, x1: x + half, y1: y + half }, value);
  }
}

function block(nav: NavGrid, built: Uint8Array, r: Rect, flags: CellFlag): void {
  const { c0, r0, c1, r1 } = rectCells(nav, r);
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      nav.set(cx, cy, flags);
      built[nav.idx(cx, cy)] = 1;
    }
  }
}

function open(nav: NavGrid, r: Rect): void {
  const { c0, r0, c1, r1 } = rectCells(nav, r);
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      nav.unset(cx, cy, CellFlag.BlockMove | CellFlag.BlockVision);
    }
  }
}

const inflate = (r: Rect, by: number): Rect => ({
  x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by,
});
const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
const width = (r: Rect): number => r.x1 - r.x0;
const depth = (r: Rect): number => r.y1 - r.y0;
const centre = (r: Rect): Point => ({ x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 });

/** True when a point is inside the wall circuit, by ray casting. */
function insideRing(ring: Point[], p: Point): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      hit = !hit;
    }
  }
  return hit;
}

// ---------------------------------------------------------------------------
// What may be built where, and who is standing there
// ---------------------------------------------------------------------------

const PALETTES: Record<string, string[]> = {
  castle: [
    'civic_keep_great', 'civic_keep_round', 'civic_palace_wing', 'civic_great_hall',
    'civic_barracks', 'civic_arsenal', 'civic_treasury', 'civic_prison', 'civic_mint',
    'fort_tower_corner', 'fort_tower_drum', 'civic_granary_public', 'house_stone_tower_home',
  ],
  minster: [
    'civic_cathedral', 'civic_abbey', 'civic_chapter_house', 'civic_basilica',
    'civic_chapel', 'civic_library', 'civic_hospice', 'civic_almshouse',
    'civic_university', 'civic_bell_tower',
  ],
  // Facing the square: the buildings that exist to watch money change hands.
  market: [
    'civic_guildhall', 'civic_courthouse', 'civic_weigh_house', 'civic_moot_hall',
    'civic_customs', 'house_inn', 'house_tavern', 'house_arcade', 'house_shopfront_double',
    'house_timber_tall', 'house_gable_step', 'house_gable_dutch', 'house_oriel',
  ],
  merchant: [
    'house_timber_tall', 'house_half_timber_tall', 'house_gable_dutch', 'house_gable_curved',
    'house_manor', 'house_stone_b', 'house_oriel', 'house_balcony',
    'house_gallery_house', 'house_turret_house', 'civic_guild_tower', 'civic_treasury',
  ],
  // Clean trades. Long upper windows to work by, in the town proper.
  weavers: [
    'house_weaver', 'house_timber_a', 'house_timber_b', 'house_timber_c',
    'house_dormer_row', 'house_stair_outside', 'house_row_a', 'house_shop_front',
    'house_narrow', 'house_wing_house',
  ],
  // Fire trades, kept together and kept against the wall.
  smiths: [
    'house_smithy', 'house_potter', 'house_bakery', 'house_bakehouse', 'house_brewery',
    'house_workshop', 'house_cellar', 'house_chimney_stack', 'house_broad',
  ],
  // Butchers, downhill of the town and upwind of nobody who mattered.
  shambles: [
    'house_butcher', 'house_shop_front', 'house_narrow', 'house_leaning',
    'house_overhang', 'house_timber_b', 'house_penthouse',
  ],
  // Tanners, dyers and fullers: they need the river, and everyone else needs
  // them to be downstream of it.
  tanners: [
    'house_tannery', 'house_hovel', 'house_penthouse',
    'house_half_ruin', 'house_broad', 'house_boat_builder',
  ],
  wharf: [
    'house_warehouse', 'civic_customs', 'house_granary_town', 'civic_granary_public',
    'dock_boathouse', 'house_boat_builder', 'civic_weigh_house',
  ],
  rents: [
    'house_tenement', 'house_hovel', 'house_penthouse', 'house_leaning',
    'house_half_ruin', 'house_narrow', 'house_cottage_b', 'house_ruin_house',
  ],
  wards: [
    'house_timber_a', 'house_timber_b', 'house_timber_c', 'house_stone_a',
    'house_row_a', 'house_cottage_a', 'house_dormer', 'house_hipped_roof',
    'house_catslide', 'house_broad', 'house_shop_front', 'house_cellar',
    'house_stair_outside', 'house_gatehouse_house', 'house_courtyard_gate',
  ],
  suburb: [
    'house_cottage_a', 'house_cottage_b', 'house_hovel', 'rural_farmhouse',
    'house_broad', 'house_catslide', 'house_penthouse', 'house_stone_a',
    'house_bakehouse', 'rural_stable_farm',
  ],
};

const CROWDS: Record<string, string[]> = {
  market: [
    'folk_merchant', 'folk_peasant_woman', 'folk_basket_woman', 'folk_watercarrier',
    'folk_crier', 'folk_fishwife', 'folk_baker', 'folk_child_running', 'folk_child_standing',
    'folk_old_woman', 'folk_old_man', 'folk_beggar', 'folk_beggar_seated', 'folk_jester',
    'folk_musician', 'folk_dancer', 'folk_thief', 'folk_maid', 'folk_scribe',
    'creature_dog_street', 'creature_goose', 'creature_cat',
  ],
  castle: [
    'folk_knight_plate', 'folk_paladin', 'folk_manatarms', 'folk_sergeant', 'folk_pikeman',
    'folk_archer', 'folk_squire', 'folk_standard_bearer', 'folk_herald', 'creature_falcon',
    'creature_warhorse',
  ],
  minster: [
    'folk_bishop', 'folk_cleric', 'folk_monk', 'folk_nun', 'folk_kneeling_pilgrim',
    'folk_scribe', 'folk_beggar_seated', 'folk_plague_doctor',
  ],
  smiths: ['folk_blacksmith', 'folk_smith_apprentice', 'folk_mason', 'folk_carpenter', 'folk_miller'],
  weavers: ['folk_peasant_woman', 'folk_maid', 'folk_old_woman', 'folk_child_standing', 'folk_scribe'],
  shambles: ['folk_fishwife', 'folk_cook', 'creature_dog_street', 'creature_pig', 'folk_innkeeper'],
  tanners: ['folk_peasant_woman', 'folk_beggar', 'folk_drunk', 'creature_rat_giant', 'folk_porter'],
  wharf: [
    'folk_fisherman', 'folk_porter', 'folk_cooper', 'folk_mercenary', 'folk_merchant',
    'folk_stablehand', 'creature_rat_giant', 'creature_goose',
  ],
  rents: ['folk_beggar', 'folk_beggar_seated', 'folk_drunk', 'folk_thief', 'folk_child_running', 'folk_old_woman'],
  wards: ['folk_peasant_woman', 'folk_old_man', 'folk_child_standing', 'folk_maid', 'folk_carpenter', 'creature_cat'],
  gate: ['folk_guard_city', 'folk_manatarms', 'folk_watchman_lantern', 'folk_crossbowman', 'folk_sergeant'],
  fields: [
    'folk_farmer', 'folk_shepherd', 'folk_peasant_woman', 'folk_hunter', 'creature_sheep',
    'creature_cow', 'creature_ox', 'creature_donkey', 'creature_pig', 'creature_horse_cart',
  ],
};

const FITTINGS: Record<string, string[]> = {
  market: ['street_stall_awning', 'street_stall_fruit', 'street_stall_cloth', 'street_stall_bread',
    'street_stall_fish', 'street_stall_smith', 'street_stall_covered', 'street_awning_row'],
  smiths: ['street_anvil_block', 'street_grindstone', 'street_firewood', 'street_cauldron_big',
    'street_barrel_stack', 'street_brazier_street', 'street_guild_sign'],
  weavers: ['street_laundry_line', 'street_crate_stack', 'street_bench_wood', 'street_guild_sign',
    'street_planter'],
  shambles: ['street_stall_fish', 'street_table_long', 'street_barrel_stack', 'street_dung_heap',
    'street_guild_sign'],
  tanners: ['street_barrel_stack', 'street_dung_heap', 'street_rubble_pile', 'street_firewood',
    'dock_fish_rack', 'street_sluice_gate'],
  wharf: ['dock_cargo_pile', 'street_crate_stack', 'street_sack_pile', 'dock_net_pile',
    'street_cart_ox', 'street_barrel_stack'],
  rents: ['street_dung_heap', 'street_rubble_pile', 'street_laundry_line', 'street_rain_barrel'],
  wards: ['street_rain_barrel', 'street_firewood', 'street_bench_wood', 'street_planter',
    'nature_flowerbed', 'street_wheelbarrow'],
  minster: ['street_bench_stone', 'nature_topiary', 'nature_hedge_section', 'street_shrine_corner'],
  castle: ['street_weapon_rack', 'street_training_dummy', 'street_archery_butt',
    'street_brazier_street', 'street_banner_pole'],
};

const FALLBACK = [
  'building_cottage', 'building_hut_orc', 'building_tavern', 'building_longhouse',
  'building_granary', 'building_stable', 'building_chapel', 'building_watchtower',
];

// ---------------------------------------------------------------------------
// plots
// ---------------------------------------------------------------------------

/**
 * Splits a block into building plots, cutting a lane at every split.
 *
 * Binary partition rather than a grid: a grid produces a suburb, and the
 * irregular frontages and awkward corner plots a jittered split produces are
 * what three hundred years of infill actually looks like. The lane narrows as
 * the blocks get smaller, so a ward ends up with streets, lanes and alleys
 * rather than one width of everything.
 */
function subdivide(rect: Rect, minPlot: number, rng: Rng, streets: Rect[], out: Rect[]): void {
  const w = width(rect);
  const d = depth(rect);
  const canX = w > minPlot * 2;
  const canY = d > minPlot * 2;
  if (!canX && !canY) {
    if (w >= minPlot * 0.65 && d >= minPlot * 0.65) out.push(rect);
    return;
  }

  const alongX = canX && (!canY || w > d);
  const span = alongX ? w : d;
  const road = span > minPlot * 5 ? STREET : span > minPlot * 3 ? 7.5 : 5;
  const t = 0.5 + (rng.next() - 0.5) * 0.36;
  const cut = (alongX ? rect.x0 : rect.y0) + span * t;

  if (alongX) {
    streets.push({ x0: cut - road / 2, y0: rect.y0, x1: cut + road / 2, y1: rect.y1 });
    subdivide({ ...rect, x1: cut - road / 2 }, minPlot, rng, streets, out);
    subdivide({ ...rect, x0: cut + road / 2 }, minPlot, rng, streets, out);
  } else {
    streets.push({ x0: rect.x0, y0: cut - road / 2, x1: rect.x1, y1: cut + road / 2 });
    subdivide({ ...rect, y1: cut - road / 2 }, minPlot, rng, streets, out);
    subdivide({ ...rect, y0: cut + road / 2 }, minPlot, rng, streets, out);
  }
}

// ---------------------------------------------------------------------------
// the build
// ---------------------------------------------------------------------------

export function buildCity(seed = 4711, assets?: AssetRegistry): CityMap {
  const nav = new NavGrid({ cols: COLS, rows: ROWS, cellSize: CELL });
  const rng = new Rng(seed);
  const cells = nav.cols * nav.rows;
  const laneMask = new Uint8Array(cells);
  const brushMask = new Uint8Array(cells);
  const riverMask = new Uint8Array(cells);
  const builtMask = new Uint8Array(cells);
  const dirtMask = new Uint8Array(cells);

  const placements: Placement[] = [];
  const streets: Rect[] = [];
  const roads: Rect[] = [];
  const gates: CityPlan['gates'] = [];
  const landmarks: CityPlan['landmarks'] = [];
  const taken: Rect[] = [];

  const has = (id: string): boolean => !assets || !!assets.get(id);
  const sizeOf = (id: string): [number, number, number] => assets?.get(id)?.size ?? [8, 8, 8];
  const usable = (ids: string[]): string[] => {
    const kept = ids.filter(has);
    return kept.length ? kept : FALLBACK.filter(has);
  };

  const footprintOf = (assetId: string, x: number, y: number, rotation: number, scale: number): Rect => {
    const s = sizeOf(assetId);
    const turned = Math.abs(Math.sin(rotation)) > 0.5;
    const halfW = ((turned ? s[2] : s[0]) * scale) / 2;
    const halfD = ((turned ? s[0] : s[2]) * scale) / 2;
    return { x0: x - halfW, y0: y - halfD, x1: x + halfW, y1: y + halfD };
  };

  const free = (r: Rect, pad = 0): boolean => {
    const test = inflate(r, pad);
    for (const t of taken) if (overlaps(test, t)) return false;
    return true;
  };

  const place = (assetId: string, x: number, y: number, rotation = 0, scale = 1, blocks = true): boolean => {
    if (!has(assetId)) return false;
    const foot = footprintOf(assetId, x, y, rotation, scale);
    placements.push({ assetId, x, y, rotation, scale, blocks });
    if (blocks) {
      block(nav, builtMask, foot, CellFlag.BlockMove | CellFlag.BlockVision);
      taken.push(foot);
    }
    return true;
  };

  /** Places a piece only if its footprint is clear, and says whether it did. */
  const tryPlace = (assetId: string, x: number, y: number, rotation = 0, scale = 1, pad = 1.5): boolean => {
    if (!has(assetId)) return false;
    if (!free(footprintOf(assetId, x, y, rotation, scale), pad)) return false;
    return place(assetId, x, y, rotation, scale, true);
  };

  // --- the border and the river -------------------------------------------

  nav.fillRect(nav.minX, nav.minY, nav.maxX, nav.minY + BORDER, CellFlag.BlockMove | CellFlag.BlockVision);
  nav.fillRect(nav.minX, nav.maxY - BORDER, nav.maxX, nav.maxY, CellFlag.BlockMove | CellFlag.BlockVision);
  nav.fillRect(nav.minX, nav.minY, nav.minX + BORDER, nav.maxY, CellFlag.BlockMove | CellFlag.BlockVision);
  nav.fillRect(nav.maxX - BORDER, nav.minY, nav.maxX, nav.maxY, CellFlag.BlockMove | CellFlag.BlockVision);

  const bridges = [-118, -8, 96];
  for (let cx = 0; cx < nav.cols; cx++) {
    const x = nav.cellCentreX(cx);
    const y = riverY(x);
    const onBridge = bridges.some((bx) => Math.abs(x - bx) < 9);
    const from = Math.max(0, nav.rowAt(y - RIVER_HALF));
    const to = Math.min(nav.rows - 1, nav.rowAt(y + RIVER_HALF));
    for (let cy = from; cy <= to; cy++) {
      const i = nav.idx(cx, cy);
      riverMask[i] = 255;
      if (onBridge) continue;
      nav.set(cx, cy, CellFlag.BlockMove);
      builtMask[i] = 1;
    }
  }

  // --- the wall, and the gates that decide where the streets go ------------

  const wallPiece = has('fort_wall_straight') ? 'fort_wall_straight' : '';
  const towerPiece = has('fort_tower_round') ? 'fort_tower_round' : '';
  const gatePiece = has('fort_gatehouse_great') ? 'fort_gatehouse_great' : '';
  const sideGate = has('fort_gate_flank') ? 'fort_gate_flank' : towerPiece;

  const gateSpecs: Array<{ name: string; at: Point; great: boolean }> = [
    { name: 'Kings Gate', at: { x: 0, y: 122 }, great: true },
    { name: 'Minster Gate', at: { x: 0, y: -228 }, great: false },
    { name: 'West Gate', at: { x: -205, y: -40 }, great: false },
    { name: 'East Gate', at: { x: 205, y: -40 }, great: false },
  ];

  const nearGate = (p: Point, r: number) =>
    gateSpecs.find((g) => Math.hypot(g.at.x - p.x, g.at.y - p.y) < r);

  /** Runs a wall along a segment at any angle, opening it where a gate is. */
  const runWall = (a: Point, b: Point): void => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.hypot(dx, dy);
    const steps = Math.max(1, Math.round(length / WALL_SEG));
    const angle = Math.atan2(dx, dy);
    const nx = dx / length;
    const ny = dy / length;

    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) / steps;
      const x = a.x + dx * t;
      const y = a.y + dy * t;

      const gate = nearGate({ x, y }, WALL_SEG * 1.6);
      if (gate) {
        // Cut the opening once, at the gate itself, and stand the gatehouse
        // beside the road rather than across it: the arch of a generated
        // gatehouse is not where its bounding box says it is.
        if (Math.hypot(gate.at.x - x, gate.at.y - y) < WALL_SEG * 0.6) {
          const half = gate.great ? 15 : 11;
          open(nav, { x0: gate.at.x - half, y0: gate.at.y - half, x1: gate.at.x + half, y1: gate.at.y + half });
          paint(nav, laneMask, inflate({ x0: gate.at.x - half, y0: gate.at.y - half, x1: gate.at.x + half, y1: gate.at.y + half }, 8), 255);
          gates.push({ name: gate.name, x: gate.at.x, y: gate.at.y });
          landmarks.push({ name: gate.name, x: gate.at.x, y: gate.at.y });
          const piece = gate.great ? gatePiece || sideGate : sideGate || gatePiece;
          if (piece) {
            const off = half + (gate.great ? 8 : 5);
            place(piece, gate.at.x - ny * off, gate.at.y + nx * off, angle, 1, false);
            place(piece, gate.at.x + ny * off, gate.at.y - nx * off, angle, 1, false);
          }
        }
        continue;
      }

      // The wall's collision is a band along the line rather than a box, so a
      // diagonal run is a diagonal wall and not a staircase.
      const half = WALL_SEG / 2;
      for (let s = -half; s <= half; s += 1.6) {
        const px = x + nx * s;
        const py = y + ny * s;
        block(nav, builtMask, { x0: px - 2.4, y0: py - 2.4, x1: px + 2.4, y1: py + 2.4 },
          CellFlag.BlockMove | CellFlag.BlockVision);
      }

      const piece = i % TOWER_EVERY === 0 && towerPiece ? towerPiece : wallPiece;
      if (piece) {
        placements.push({
          assetId: piece,
          x, y,
          rotation: piece === towerPiece ? 0 : angle,
          scale: 1,
          blocks: false,
        });
      }
    }
  };

  for (let i = 0; i < WALL_RING.length; i++) {
    runWall(WALL_RING[i], WALL_RING[(i + 1) % WALL_RING.length]);
  }

  // Where the wall meets the river it stops: the water is the barrier, and a
  // chain across it is the gate.
  for (const wx of [-205, 205]) {
    const y = riverY(wx);
    if (!insideRing(WALL_RING, { x: wx, y })) continue;
    open(nav, { x0: wx - 5, y0: y - RIVER_HALF - 5, x1: wx + 5, y1: y + RIVER_HALF + 5 });
    place('street_chain_boom', wx, y - RIVER_HALF - 2, Math.PI / 2, 1, false);
    landmarks.push({ name: 'Water Gate', x: wx, y });
  }

  // --- the two streets everything else hangs off ---------------------------

  const marketC = centre(MARKET);
  const highStreet: Rect = { x0: marketC.x - AVENUE / 2, y0: MARKET.y1 - 4, x1: marketC.x + AVENUE / 2, y1: 128 };
  const castleWay: Rect = { x0: marketC.x - AVENUE / 2, y0: -234, x1: marketC.x + AVENUE / 2, y1: MARKET.y0 + 4 };
  const crossStreet: Rect = { x0: -212, y0: marketC.y - AVENUE / 2, x1: 212, y1: marketC.y + AVENUE / 2 };
  streets.push(highStreet, castleWay, crossStreet);

  // Minster Way runs from the square to the cathedral door and Wharf Lane from
  // the square to the water. Both are dog-legs, because the square was there
  // first and the cathedral was built where there was room.
  const minsterWay: Rect[] = [
    { x0: 30, y0: -66, x1: 30 + STREET, y1: -20 },
    { x0: 30, y0: -66, x1: 116, y1: -66 + STREET },
    { x0: 108, y0: -140, x1: 108 + STREET, y1: -60 },
  ];
  const wharfLane: Rect[] = [
    { x0: -26, y0: 0, x1: -26 + STREET, y1: 80 },
    { x0: -104, y0: 76, x1: 44, y1: 76 + STREET },
  ];
  streets.push(...minsterWay, ...wharfLane);

  // A road inside the wall the garrison can move on without crossing the town.
  const ringPath: Point[] = WALL_RING.map((p) => ({ x: p.x * 0.88, y: p.y * 0.88 }));
  for (let i = 0; i < ringPath.length; i++) {
    paintLine(nav, laneMask, ringPath[i], ringPath[(i + 1) % ringPath.length], 6, 255);
  }

  // Roads out of every gate, in dirt: nobody cobbled the way to the next town.
  roads.push(
    { x0: -7, y0: 122, x1: 7, y1: nav.maxY },
    { x0: -7, y0: nav.minY, x1: 7, y1: -228 },
    { x0: nav.minX, y0: -47, x1: -205, y1: -33 },
    { x0: 205, y0: -47, x1: nav.maxX, y1: -33 },
  );

  // --- the districts, in the order they claimed their ground ---------------

  const districts: District[] = [
    { name: 'The Citadel', rect: CITADEL, palette: usable(PALETTES.castle), crowd: CROWDS.castle,
      fittings: FITTINGS.castle, minPlot: 40, fill: 0.84, crowding: 0.9 },
    { name: 'Minster Close', rect: CLOSE, palette: usable(PALETTES.minster), crowd: CROWDS.minster,
      fittings: FITTINGS.minster, minPlot: 40, fill: 0.84, crowding: 0.8 },
    { name: 'Market Ward', rect: { x0: -104, y0: -112, x1: 104, y1: -82 }, palette: usable(PALETTES.market),
      crowd: CROWDS.market, minPlot: 26, fill: 0.86, crowding: 1.4 },
    { name: 'Market Ward', rect: { x0: -104, y0: 14, x1: 104, y1: 44 }, palette: usable(PALETTES.market),
      crowd: CROWDS.market, minPlot: 26, fill: 0.86, crowding: 1.4 },
    { name: 'Merchant Row', rect: { x0: -110, y0: -174, x1: -56, y1: -118 }, palette: usable(PALETTES.merchant),
      crowd: CROWDS.market, minPlot: 28, fill: 0.82, crowding: 0.7 },
    { name: 'Silver Street', rect: { x0: 56, y0: -110, x1: 178, y1: -82 }, palette: usable(PALETTES.merchant),
      crowd: CROWDS.market, minPlot: 26, fill: 0.84, crowding: 0.9 },
    { name: 'Weavers Ward', rect: { x0: -182, y0: -110, x1: -58, y1: -52 }, palette: usable(PALETTES.weavers),
      crowd: CROWDS.weavers, fittings: FITTINGS.weavers, minPlot: 22, fill: 0.84, crowding: 0.7 },
    // Against the wall and away from the thatch of the wards: everything in
    // here has a furnace in it.
    { name: 'Smiths Row', rect: { x0: -188, y0: -22, x1: -100, y1: 34 }, palette: usable(PALETTES.smiths),
      crowd: CROWDS.smiths, fittings: FITTINGS.smiths, minPlot: 24, fill: 0.8, crowding: 0.8 },
    { name: 'Eastgate Ward', rect: { x0: 100, y0: -22, x1: 188, y1: 40 }, palette: usable(PALETTES.wards),
      crowd: CROWDS.wards, fittings: FITTINGS.wards, minPlot: 22, fill: 0.84, crowding: 0.7 },
    { name: 'Northgate Ward', rect: { x0: -40, y0: -204, x1: 26, y1: -122 }, palette: usable(PALETTES.wards),
      crowd: CROWDS.wards, fittings: FITTINGS.wards, minPlot: 22, fill: 0.84, crowding: 0.7 },
    { name: 'Kingsgate Ward', rect: { x0: -96, y0: 48, x1: 96, y1: 70 }, palette: usable(PALETTES.wards),
      crowd: CROWDS.wards, fittings: FITTINGS.wards, minPlot: 20, fill: 0.86, crowding: 0.9 },
    { name: 'The Shambles', rect: { x0: 48, y0: 48, x1: 152, y1: 72 }, palette: usable(PALETTES.shambles),
      crowd: CROWDS.shambles, fittings: FITTINGS.shambles, minPlot: 18, fill: 0.88, crowding: 1.0 },
    { name: 'The Wharf', rect: { x0: -108, y0: 88, x1: 56, y1: 114 }, palette: usable(PALETTES.wharf),
      crowd: CROWDS.wharf, fittings: FITTINGS.wharf, minPlot: 24, fill: 0.86, crowding: 1.2 },
    { name: 'Dockside Rents', rect: { x0: 64, y0: 88, x1: 176, y1: 114 }, palette: usable(PALETTES.rents),
      crowd: CROWDS.rents, fittings: FITTINGS.rents, minPlot: 17, fill: 0.9, crowding: 1.3 },
    // Outside the wall, on the water, downstream of everything.
    { name: 'Tanners Bank', rect: { x0: -192, y0: 158, x1: -44, y1: 192 }, palette: usable(PALETTES.tanners),
      crowd: CROWDS.tanners, fittings: FITTINGS.tanners, minPlot: 20, fill: 0.82, crowding: 0.8 },
    { name: 'Southgate Suburb', rect: { x0: -66, y0: 200, x1: 40, y1: 250 }, palette: usable(PALETTES.suburb),
      crowd: CROWDS.wards, fittings: FITTINGS.wards, minPlot: 22, fill: 0.78, crowding: 0.5 },
  ];

  // --- the castle, and the throne in it ------------------------------------

  const castleC = centre(CITADEL);

  const runPrecinctWall = (r: Rect, gateAt: Point, gateHalf: number): void => {
    const corners: Point[] = [
      { x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 },
      { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 },
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % 4];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const length = Math.hypot(dx, dy);
      const steps = Math.max(1, Math.round(length / WALL_SEG));
      const angle = Math.atan2(dx, dy);
      for (let s = 0; s < steps; s++) {
        const t = (s + 0.5) / steps;
        const x = a.x + dx * t;
        const y = a.y + dy * t;
        if (Math.hypot(x - gateAt.x, y - gateAt.y) < gateHalf) continue;
        block(nav, builtMask, { x0: x - 2.6, y0: y - 2.6, x1: x + 2.6, y1: y + 2.6 },
          CellFlag.BlockMove | CellFlag.BlockVision);
        const corner = s === 0 || s === steps - 1;
        const piece = corner && has('fort_tower_corner') ? 'fort_tower_corner' : wallPiece;
        if (piece) {
          placements.push({ assetId: piece, x, y, rotation: piece === wallPiece ? angle : 0, scale: 1, blocks: false });
        }
      }
    }
    open(nav, { x0: gateAt.x - gateHalf, y0: gateAt.y - 8, x1: gateAt.x + gateHalf, y1: gateAt.y + 8 });
    paint(nav, laneMask, { x0: gateAt.x - gateHalf, y0: gateAt.y - 18, x1: gateAt.x + gateHalf, y1: gateAt.y + 18 }, 255);
  };

  runPrecinctWall(CITADEL, { x: castleC.x, y: CITADEL.y1 }, 17);
  landmarks.push({ name: 'Castle Gate', x: castleC.x, y: CITADEL.y1 + 10 });

  /**
   * The throne room, built as an open court rather than a roofed hall.
   *
   * A hall with a roof on it is a box from a camera fifty units up, and the
   * throne is the thing the player came to see. A colonnade, a dais, a carpet
   * and braziers inside a walled court reads as an interior from above and
   * needs no cutaway.
   */
  const throne: Point = { x: castleC.x, y: CITADEL.y0 + 38 };
  {
    const hall: Rect = { x0: throne.x - 36, y0: throne.y - 28, x1: throne.x + 36, y1: throne.y + 44 };
    paint(nav, laneMask, hall, 255);
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i++) {
        place('street_hall_column', throne.x + side * 24, throne.y - 12 + i * 14, 0, 1, false);
      }
    }
    place('street_dais_steps', throne.x, throne.y, 0, 1, false);
    place('street_throne_stone', throne.x, throne.y - 3, 0, 1, false);
    place('street_carpet_runner', throne.x, throne.y + 26, Math.PI / 2, 1, false);
    for (const side of [-1, 1]) {
      place('street_banner_wall', throne.x + side * 10, throne.y - 14, 0, 1, false);
      place('street_brazier_hall', throne.x + side * 14, throne.y + 10, 0, 1, false);
      place('street_high_table', throne.x + side * 28, throne.y + 34, 0, 1, false);
    }
    place('folk_king', throne.x, throne.y + 5, Math.PI, 1, false);
    place('folk_queen', throne.x + 7, throne.y + 6, Math.PI, 1, false);
    for (let i = 0; i < 10; i++) {
      const side = i % 2 === 0 ? -1 : 1;
      place(i < 4 ? 'folk_knight_plate' : i < 7 ? 'folk_herald' : 'folk_noble_seated',
        throne.x + side * (16 + rng.next() * 6), throne.y + 16 + Math.floor(i / 2) * 8,
        Math.PI + (rng.next() - 0.5) * 0.5, 1, false);
    }
    taken.push(inflate(hall, 2));
    landmarks.push({ name: 'The Throne Room', x: throne.x, y: throne.y + 20 });
  }

  // The keep stands behind the hall; the rest of the castle fills in round it.
  if (tryPlace('civic_keep_great', castleC.x - 46, CITADEL.y0 + 34, 0, 1, 3)) {
    landmarks.push({ name: 'The Keep', x: castleC.x - 46, y: CITADEL.y0 + 34 });
  }
  tryPlace('civic_barracks', castleC.x + 48, CITADEL.y0 + 30, Math.PI / 2, 1, 3);
  tryPlace('civic_arsenal', castleC.x + 48, CITADEL.y1 - 28, Math.PI / 2, 1, 3);
  tryPlace('civic_chapel', castleC.x - 48, CITADEL.y1 - 26, 0, 1, 3);
  place('civic_cistern', castleC.x, CITADEL.y1 - 18, 0, 1, false);

  // --- the minster ---------------------------------------------------------

  const closeC = centre(CLOSE);
  if (tryPlace('civic_cathedral', closeC.x, closeC.y - 8, 0, 1, 4)) {
    landmarks.push({ name: 'The Minster', x: closeC.x, y: closeC.y - 8 });
  }
  tryPlace('civic_chapter_house', closeC.x + 56, closeC.y + 28, 0, 1, 3);
  tryPlace('civic_abbey', closeC.x - 58, closeC.y + 24, 0, 1, 3);
  tryPlace('civic_almshouse', CLOSE.x0 + 28, CLOSE.y1 - 20, 0, 1, 3);
  place('street_shrine_pillar', closeC.x, CLOSE.y1 - 12, 0, 1, false);
  for (let i = 0; i < 18; i++) {
    place('rural_tombstone', CLOSE.x1 - 14 - (i % 4) * 10, CLOSE.y0 + 18 + Math.floor(i / 4) * 10, rng.next(), 1, false);
  }
  place('rural_graveyard_gate', CLOSE.x1 - 30, CLOSE.y0 + 10, 0, 1, false);

  // --- clean water, from outside ------------------------------------------
  //
  // The river inside the walls is a sewer by the time it leaves, so what the
  // town drinks is carried in over an aqueduct from the hills and let out at a
  // conduit in the market square.

  {
    const from: Point = { x: 302, y: -252 };
    const to: Point = { x: 178, y: -78 };
    const steps = 11;
    const angle = Math.atan2(to.x - from.x, to.y - from.y);
    for (let i = 0; i < steps; i++) {
      const t = i / (steps - 1);
      place(i < steps - 3 ? 'civic_aqueduct_tall' : 'civic_aqueduct_low',
        from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, angle, 1, false);
    }
    landmarks.push({ name: 'The Aqueduct', x: 252, y: -172 });
    place('civic_conduit_house', marketC.x + 32, marketC.y - 24, 0, 1, false);
    place('street_fountain_wall_large', marketC.x - 32, marketC.y + 20, 0, 1, false);
    place('street_horse_trough_long', marketC.x - 36, marketC.y - 22, Math.PI / 2, 1, false);
  }

  // --- the market square ---------------------------------------------------

  paint(nav, laneMask, MARKET, 255);
  landmarks.push({ name: 'Market Square', x: marketC.x, y: marketC.y });
  place('street_market_cross', marketC.x, marketC.y - 8, 0, 1, false);
  place('street_well_covered', marketC.x + 18, marketC.y + 18, 0, 1, false);
  tryPlace('civic_weigh_house', MARKET.x0 - 24, marketC.y - 22, Math.PI / 2, 1, 2);
  tryPlace('civic_guildhall', MARKET.x1 + 26, marketC.y + 16, Math.PI / 2, 1, 2);

  const stalls = usable(FITTINGS.market);
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 9; col++) {
      const x = MARKET.x0 + 8 + col * 10 + (row % 2) * 2.5;
      const y = MARKET.y0 + 8 + row * 13;
      if (Math.hypot(x - marketC.x, y - (marketC.y - 8)) < 15) continue;
      place(stalls[rng.int(0, stalls.length - 1)], x, y, (rng.next() - 0.5) * 0.4, 1, false);
    }
  }

  // --- what the town navigates by ------------------------------------------

  const setPieces: Array<[string, number, number, number, string]> = [
    ['civic_moot_hall', -74, -32, 0, 'Moot Hall'],
    ['house_inn', 72, -36, Math.PI, 'The Coaching Inn'],
    ['house_tavern', -70, 24, 0, 'The Broken Crown'],
    ['civic_clock_tower', 34, 38, 0, 'Clock Tower'],
    ['civic_theatre', -154, 66, 0, 'The Playhouse'],
    ['civic_wizard_tower', 176, -152, 0, "Wizard's Tower"],
    ['civic_bell_tower', 80, -130, 0, 'Bell Tower'],
    ['civic_university', -170, -152, 0, 'Scholars Hall'],
    ['civic_hospital', 154, 10, 0, 'The Hospital'],
    ['civic_prison', -184, -122, 0, 'The Gaol'],
  ];
  for (const [id, x, y, rot, name] of setPieces) {
    if (tryPlace(id, x, y, rot, 1, 2)) landmarks.push({ name, x, y });
  }

  // --- the wharf -----------------------------------------------------------

  {
    for (let i = 0; i < 11; i++) {
      const x = -112 + i * 17;
      const bank = riverY(x) - RIVER_HALF;
      place('dock_harbour_wall', x, bank - 4, 0, 1, false);
      if (i % 3 === 1) place('dock_pier_section', x, bank + 8, 0, 1, false);
      if (i % 4 === 2) place('dock_mooring_post', x + 5, bank - 1, 0, 1, false);
    }
    place('dock_dock_crane', -48, riverY(-48) - RIVER_HALF - 14, 0, 1, false);
    place('dock_dock_crane', 20, riverY(20) - RIVER_HALF - 14, 0, 1, false);
    landmarks.push({ name: 'The Wharf', x: -30, y: riverY(-30) - RIVER_HALF - 18 });
    for (const [x, kind] of [[-98, 'dock_boat_fishing'], [-30, 'dock_boat_cog'], [44, 'dock_boat_barge'], [-66, 'dock_boat_row']] as Array<[number, string]>) {
      place(kind, x, riverY(x), rng.next() * 0.3, 1, false);
    }
  }

  for (const bx of bridges) {
    place('street_bridge_stone', bx, riverY(bx), 0, 1, false);
    paint(nav, laneMask, { x0: bx - 9, y0: riverY(bx) - RIVER_HALF - 12, x1: bx + 9, y1: riverY(bx) + RIVER_HALF + 12 }, 255);
  }
  landmarks.push({ name: 'The Great Bridge', x: -8, y: riverY(-8) - 24 });

  // The mill sits on a leat taken off the river above the town, which is also
  // where the clean water is drawn. The tanners are a long way downstream.
  tryPlace('rural_watermill', -214, riverY(-214) - 24, 0, 1, 3);
  landmarks.push({ name: 'The Mill', x: -214, y: riverY(-214) - 30 });
  place('street_sluice_gate', -198, riverY(-198) - RIVER_HALF - 5, 0, 1, false);
  tryPlace('rural_windmill', 236, -230, 0, 1, 4);

  // --- the wards -----------------------------------------------------------

  const yardKit = usable([
    'street_firewood', 'street_barrel_stack', 'street_crate_stack', 'street_sack_pile',
    'street_rain_barrel', 'street_cart_hand', 'street_planter', 'street_laundry_line',
    'street_bench_wood', 'street_dung_heap', 'street_rubble_pile', 'street_wheelbarrow',
    'rural_hay_bales', 'rural_chicken_coop', 'rural_beehives', 'nature_hedge_section',
    'nature_flowerbed', 'nature_topiary', 'street_dovecote',
  ]);

  const dressYard = (plot: Rect): void => {
    if (!yardKit.length) return;
    const count = Math.min(4, 1 + Math.floor((width(plot) * depth(plot)) / 200));
    for (let i = 0; i < count; i++) {
      const x = plot.x0 + 2 + rng.next() * Math.max(0.1, width(plot) - 4);
      const y = plot.y0 + 2 + rng.next() * Math.max(0.1, depth(plot) - 4);
      if (!nav.isWalkableWorld(x, y)) continue;
      place(yardKit[rng.int(0, yardKit.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
    }
  };

  const noBuild: Rect[] = [
    inflate(highStreet, 2), inflate(castleWay, 2), inflate(crossStreet, 2), inflate(MARKET, 4),
    ...minsterWay.map((r) => inflate(r, 2)), ...wharfLane.map((r) => inflate(r, 2)),
  ];

  for (const district of districts) {
    const plots: Rect[] = [];
    subdivide(district.rect, district.minPlot, rng, streets, plots);

    for (const plot of plots) {
      const pw = width(plot) * district.fill;
      const pd = depth(plot) * district.fill;
      const c = centre(plot);
      const foot = { x0: c.x - pw / 2, y0: c.y - pd / 2, x1: c.x + pw / 2, y1: c.y + pd / 2 };

      if (noBuild.some((r) => overlaps(foot, r))) continue;
      if (Math.abs(c.y - riverY(c.x)) < RIVER_HALF + 8) continue;
      if (!free(foot, 1)) continue;

      let best: { id: string; rotation: number; scale: number; score: number } | null = null;
      for (const id of district.palette) {
        const s = sizeOf(id);
        for (const rotation of [0, Math.PI / 2]) {
          const turned = rotation !== 0;
          const w = turned ? s[2] : s[0];
          const d = turned ? s[0] : s[2];
          const scale = Math.min(pw / w, pd / d);
          if (scale < 0.7 || scale > 1.4) continue;
          const score = (w * scale * d * scale) / (pw * pd) - Math.abs(1 - scale) * 0.35;
          if (!best || score > best.score) best = { id, rotation, scale, score };
        }
      }
      if (!best) {
        dressYard(foot);
        continue;
      }
      const flip = rng.int(0, 1) === 1 ? Math.PI : 0;
      place(best.id, c.x, c.y, best.rotation + flip, best.scale);
    }

    // The trade's own clutter, along its frontages.
    const fittings = district.fittings ? district.fittings.filter(has) : [];
    if (fittings.length) {
      const n = Math.round((width(district.rect) * depth(district.rect)) / 900);
      for (let i = 0; i < n; i++) {
        const x = district.rect.x0 + rng.next() * width(district.rect);
        const y = district.rect.y0 + rng.next() * depth(district.rect);
        if (!nav.isWalkableWorld(x, y)) continue;
        place(fittings[rng.int(0, fittings.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
      }
    }
  }

  // --- who is where, during the day ----------------------------------------

  for (const district of districts) {
    const ids = (district.crowd ?? CROWDS.wards).filter(has);
    if (!ids.length) continue;
    const area = width(district.rect) * depth(district.rect);
    const count = Math.round((area / 100) * (district.crowding ?? 0.6));
    for (let i = 0; i < count; i++) {
      const x = district.rect.x0 + rng.next() * width(district.rect);
      const y = district.rect.y0 + rng.next() * depth(district.rect);
      if (!nav.isWalkableWorld(x, y)) continue;
      if (Math.abs(y - riverY(x)) < RIVER_HALF + 3) continue;
      place(ids[rng.int(0, ids.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
    }
  }

  // The market is the busiest place in the city, and the gates are where
  // everyone is queuing to get into it.
  {
    const ids = CROWDS.market.filter(has);
    for (let i = 0; i < 52 && ids.length; i++) {
      const x = MARKET.x0 + 6 + rng.next() * (width(MARKET) - 12);
      const y = MARKET.y0 + 6 + rng.next() * (depth(MARKET) - 12);
      if (!nav.isWalkableWorld(x, y)) continue;
      place(ids[rng.int(0, ids.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
    }
    const guards = CROWDS.gate.filter(has);
    for (const gate of gates) {
      for (let i = 0; i < 5 && guards.length; i++) {
        const a = rng.next() * Math.PI * 2;
        const r = 16 + rng.next() * 12;
        const x = gate.x + Math.cos(a) * r;
        const y = gate.y + Math.sin(a) * r;
        if (!nav.isWalkableWorld(x, y)) continue;
        place(guards[rng.int(0, guards.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
      }
      const out = gate.y > 0 ? 1 : -1;
      place('street_toll_post', gate.x + 18, gate.y + out * 24, 0, 1, false);
      place('street_cart_ox', gate.x - 20, gate.y + out * 30, rng.next(), 1, false);
    }
  }

  // --- outside: fields, and the water that reaches them --------------------

  const fields: Rect[] = [
    { x0: -300, y0: -270, x1: -216, y1: -60 },
    { x0: 216, y0: -270, x1: 300, y1: -90 },
    { x0: -300, y0: 202, x1: -120, y1: 268 },
    { x0: 150, y0: 200, x1: 300, y1: 268 },
    { x0: 232, y0: 20, x1: 300, y1: 150 },
  ];

  const cropKit = usable(['rural_field_wheat', 'rural_field_furrows', 'rural_crop_wheat',
    'rural_crop_cabbage', 'rural_vineyard_row']);
  const farmKit = usable(['rural_farmhouse', 'rural_barn', 'rural_tithe_barn', 'rural_stable_farm',
    'rural_haystack', 'rural_hay_bales', 'rural_sheep_pen', 'rural_chicken_coop', 'rural_pigsty',
    'rural_beehives', 'rural_orchard_tree', 'rural_well_farm', 'rural_windpump',
    'rural_charcoal_burner', 'rural_scarecrow']);

  for (const field of fields) {
    // Strips, not scatter: the open-field system laid land out in long furlongs
    // and the edge of one is the edge of the next.
    const strips = Math.max(2, Math.floor(width(field) / 28));
    for (let s = 0; s < strips; s++) {
      const x0 = field.x0 + (s * width(field)) / strips;
      const x1 = field.x0 + ((s + 1) * width(field)) / strips;
      const crop = cropKit[rng.int(0, cropKit.length - 1)];
      const x = (x0 + x1) / 2;
      for (let y = field.y0 + 10; y < field.y1 - 10; y += 15) {
        if (!nav.isWalkableWorld(x, y)) continue;
        if (Math.abs(y - riverY(x)) < RIVER_HALF + 8) continue;
        place(crop, x, y, 0, 1, false);
      }
      // An irrigation ditch down every other strip boundary.
      if (s % 2 === 1) {
        for (let y = field.y0 + 8; y < field.y1 - 8; y += 11) {
          if (Math.abs(y - riverY(x0)) < RIVER_HALF + 5) continue;
          place('rural_irrigation_ditch', x0, y, Math.PI / 2, 1, false);
        }
      }
    }
    for (let i = 0; i < 5; i++) {
      const id = farmKit[rng.int(0, farmKit.length - 1)];
      const x = field.x0 + 14 + rng.next() * Math.max(1, width(field) - 28);
      const y = field.y0 + 14 + rng.next() * Math.max(1, depth(field) - 28);
      if (!nav.isWalkableWorld(x, y)) continue;
      if (Math.abs(y - riverY(x)) < RIVER_HALF + 8) continue;
      tryPlace(id, x, y, rng.int(0, 3) * (Math.PI / 2), 1, 3);
    }
    paint(nav, dirtMask, field, 110);
  }

  {
    const ids = CROWDS.fields.filter(has);
    for (let i = 0; i < 54 && ids.length; i++) {
      const field = fields[rng.int(0, fields.length - 1)];
      const x = field.x0 + rng.next() * width(field);
      const y = field.y0 + rng.next() * depth(field);
      if (!nav.isWalkableWorld(x, y)) continue;
      place(ids[rng.int(0, ids.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
    }
  }

  // The quarry the walls came out of, and the road they came in on.
  if (tryPlace('rural_quarry_face', 268, -182, Math.PI / 2, 1, 4)) {
    landmarks.push({ name: 'The Quarry', x: 268, y: -182 });
  }
  place('street_cart_ox', 242, -174, 0.4, 1, false);

  // Gallows on the road out, a lazar house well away from everyone, and a
  // wayside shrine where a traveller can be grateful they passed both.
  place('street_gallows', 36, 182, 0, 1, false);
  landmarks.push({ name: 'The Gallows', x: 36, y: 178 });
  if (tryPlace('civic_hospice', -184, 254, 0, 1, 3)) {
    landmarks.push({ name: 'Lazar House', x: -184, y: 254 });
  }
  place('street_road_shrine', -14, 206, 0, 1, false);
  place('street_road_shrine', -14, -266, 0, 1, false);
  for (const m of [[-8, 172], [-8, 254], [-8, -270], [254, -40], [-254, -40]] as Array<[number, number]>) {
    place('rural_milestone', m[0], m[1], 0, 1, false);
  }

  // The fairground: flat, open, outside the gate, and empty most of the year.
  {
    const fair: Rect = { x0: 62, y0: 146, x1: 184, y1: 196 };
    paint(nav, dirtMask, fair, 210);
    for (let i = 0; i < 10; i++) {
      place(i % 3 === 0 ? 'rural_tent_round' : 'rural_tent_square',
        fair.x0 + 14 + rng.next() * (width(fair) - 28),
        fair.y0 + 12 + rng.next() * (depth(fair) - 24),
        rng.next(), 1, false);
    }
    place('rural_campfire_ring', 122, 174, 0, 1, false);
    landmarks.push({ name: 'The Fairground', x: 122, y: 166 });
  }

  // --- street furniture ----------------------------------------------------

  const furniture = usable([
    'street_lamp_post', 'street_lamp_wall', 'street_signpost', 'street_notice_board',
    'street_cart_wagon', 'street_cart_hand', 'street_barrel_stack', 'street_crate_stack',
    'street_bench_wood', 'street_trough', 'street_planter', 'street_guild_sign',
    'street_drain', 'street_pump', 'street_shrine_corner', 'street_tree_planter',
    'nature_tree_street', 'nature_hedge_section', 'street_banner_pole', 'street_bunting',
  ]);
  for (const street of streets) {
    const along = Math.max(width(street), depth(street));
    const horizontal = width(street) > depth(street);
    const count = Math.floor(along / 22);
    for (let i = 0; i < count; i++) {
      const t = ((i + 0.5) / count) * along;
      const edge = rng.int(0, 1) === 0 ? -1 : 1;
      const half = (horizontal ? depth(street) : width(street)) / 2;
      const x = horizontal ? street.x0 + t : (street.x0 + street.x1) / 2 + edge * (half - 1.4);
      const y = horizontal ? (street.y0 + street.y1) / 2 + edge * (half - 1.4) : street.y0 + t;
      if (!nav.isWalkableWorld(x, y)) continue;
      if (Math.abs(y - riverY(x)) < RIVER_HALF + 3) continue;
      place(furniture[rng.int(0, furniture.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
    }
  }

  // --- masks ---------------------------------------------------------------

  for (const street of streets) paint(nav, laneMask, street, 255);
  paint(nav, laneMask, inflate(CITADEL, -6), 200);
  paint(nav, laneMask, inflate(CLOSE, -6), 190);
  for (const district of districts) paint(nav, dirtMask, inflate(district.rect, 5), 230);
  for (const road of roads) paint(nav, dirtMask, road, 255);
  for (const gate of gates) {
    paint(nav, dirtMask, { x0: gate.x - 34, y0: gate.y - 34, x1: gate.x + 34, y1: gate.y + 34 }, 220);
  }

  nav.rebuildClearance();

  const bounds = {
    minX: nav.minX + BORDER + 3,
    minY: nav.minY + BORDER + 3,
    maxX: nav.maxX - BORDER - 3,
    maxY: nav.maxY - BORDER - 3,
  };

  const entrance: Point = { x: 0, y: 176 };
  const plan: CityPlan = { landmarks, districts, streets, gates, placements, entrance };

  return {
    name: 'Highhold',
    nav,
    laneMask,
    brushMask,
    riverMask,
    builtMask,
    dirtMask,
    lanes: [],
    spawns: {
      [Team.Blue]: vec2(entrance.x, entrance.y),
      [Team.Red]: vec2(throne.x, throne.y + 24),
      [Team.Neutral]: vec2(marketC.x, marketC.y),
    } as GameMap['spawns'],
    camps: [],
    towers: [],
    bounds,
    plan,
  };
}

/**
 * Adds the planned pieces to a prop store.
 *
 * All of them non-blocking: the city stamped its own collision as rectangles
 * when it was planned, and letting props re-stamp circles on top would round
 * off every building and seal half the streets.
 */
export function populateCity(plan: CityPlan, props: PropStore, assets: AssetRegistry): number {
  for (const p of plan.placements) {
    const entry = assets.get(p.assetId);
    if (!entry) continue;
    props.add({
      assetId: p.assetId,
      category: entry.category,
      x: p.x,
      y: p.y,
      rotation: p.rotation,
      scale: p.scale,
      radius: entry.radius,
      flags: PropFlag.None,
    });
  }
  return plan.placements.length;
}
