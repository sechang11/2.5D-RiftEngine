/**
 * Highhold: a walled castle city, assembled from a kit.
 *
 * No part of this is a model of a city. It is a curtain wall repeated a hundred
 * and forty times, six house shells reused at four rotations, and a street
 * network that decides where they go. That is the only way a city of this size
 * fits in a browser, and it is also how real medieval cities were built: a
 * small vocabulary of pieces, arranged.
 *
 * The layout is deliberately not organic. It is laid out the way a besieged
 * town actually grows:
 *
 *   the citadel takes the high ground at the back and walls itself off again
 *   the market square sits where the two main avenues cross
 *   the trades that stink — tanner, butcher, potter — go downwind by the water
 *   the temple precinct takes the best open ground that is not the market
 *   everything else is housing, packed into whatever the streets left over
 *   the river runs through, and the wall crosses it on two water gates
 *
 * Everything is stamped into the nav grid at build time rather than left to
 * blocking props. Props block as circles, which is right for a barrel and wrong
 * for a terrace of houses: a circle round a 12-by-6 building either leaves the
 * corners walkable or eats two metres of the street on each side. Buildings
 * here are rectangles in the grid and pure decoration as props, so collision
 * matches the silhouette and the streets stay the width they were drawn.
 *
 * That means the generator needs the asset catalogue before it can size a plot,
 * which is why the pack loads before the map is built.
 */

import { CellFlag, NavGrid } from '../../core/nav/navgrid';
import { Rng } from '../../core/math/rng';
import { Team } from '../../core/ecs/types';
import { vec2 } from '../../core/math/vec2';
import type { GameMap } from './map01';
import type { AssetRegistry } from '../../render/assets';
import { PropFlag, type PropStore } from '../../core/world/props';

const COLS = 320;
const ROWS = 300;
const CELL = 1;
const BORDER = 3;

/** Half-width of the river channel, before meander. */
const RIVER_HALF = 7;
/** One curtain-wall section is this long, so everything on the wall is a multiple. */
const WALL_SEG = 4;
/** A tower every this many sections. */
const TOWER_EVERY = 6;

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Placement {
  assetId: string;
  x: number;
  y: number;
  rotation: number;
  scale: number;
  /** Marks the piece as scenery the fog and nav have already accounted for. */
  blocks: boolean;
}

export interface District {
  name: string;
  rect: Rect;
  palette: string[];
  /** Smallest plot the subdivider will stop at, in world units. */
  minPlot: number;
  /** How much of the plot the building fills. */
  fill: number;
}

export interface CityPlan {
  /** Named points worth putting a label on. */
  landmarks: Array<{ name: string; x: number; y: number }>;
  districts: District[];
  streets: Rect[];
  gates: Array<{ name: string; x: number; y: number }>;
  placements: Placement[];
  /** Where a visitor starts: outside the south gate, looking up the avenue. */
  entrance: { x: number; y: number };
}

export type CityMap = GameMap & { plan: CityPlan };

// --- the shape of the town -------------------------------------------------

const WALL: Rect = { x0: -100, y0: -110, x1: 100, y1: 62 };
const CITADEL: Rect = { x0: -36, y0: -106, x1: 36, y1: -66 };
const MARKET: Rect = { x0: -28, y0: -28, x1: 28, y1: 2 };

/** Where the river runs, as a function of x. */
function riverY(x: number): number {
  return 34 + 7 * Math.sin((x + 40) / 52);
}

// --- small grid helpers ----------------------------------------------------

function rectCells(nav: NavGrid, r: Rect): { c0: number; r0: number; c1: number; r1: number } {
  return {
    c0: Math.max(0, nav.colAt(r.x0)),
    r0: Math.max(0, nav.rowAt(r.y0)),
    c1: Math.min(nav.cols - 1, nav.colAt(r.x1)),
    r1: Math.min(nav.rows - 1, nav.rowAt(r.y1)),
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

function inflate(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;
}

function width(r: Rect): number {
  return r.x1 - r.x0;
}

function depth(r: Rect): number {
  return r.y1 - r.y0;
}

// --- district palettes -----------------------------------------------------
//
// Names only. Anything the pack does not have yet is dropped at build time, so
// the city degrades to whatever is available rather than failing to generate.

const PALETTES: Record<string, string[]> = {
  citadel: [
    'civic_keep_great', 'civic_keep_round', 'civic_palace_wing', 'civic_great_hall',
    'civic_barracks', 'civic_treasury', 'civic_prison', 'civic_bell_tower',
    'civic_mint', 'civic_granary_tower', 'fort_tower_corner',
  ],
  temple: [
    'civic_cathedral', 'civic_abbey', 'civic_chapel', 'civic_temple_round',
    'civic_library', 'civic_observatory', 'civic_hospital', 'civic_almshouse',
    'civic_university',
  ],
  noble: [
    'house_manor', 'house_stone_b', 'house_timber_tall', 'civic_guildhall',
    'civic_courthouse', 'house_row_b', 'civic_wizard_tower', 'house_tower_house',
    'house_courtyard', 'house_oriel', 'house_balcony', 'civic_university',
  ],
  craft: [
    'house_smithy', 'house_tannery', 'house_potter', 'house_weaver', 'house_brewery',
    'house_bakery', 'house_butcher', 'house_apothecary', 'house_alchemist',
    'house_bathhouse', 'house_stable_town', 'house_workshop', 'house_cellar',
    'house_stair_outside', 'civic_baths',
  ],
  residential: [
    'house_timber_a', 'house_timber_b', 'house_timber_c', 'house_stone_a',
    'house_row_a', 'house_row_b', 'house_cottage_a', 'house_shop_front',
    'house_timber_tall', 'house_tenement', 'house_stone_b', 'house_gable_step',
    'house_gable_curved', 'house_arcade', 'house_oriel', 'house_dormer',
    'house_overhang', 'house_leaning', 'house_narrow', 'house_broad',
    'house_balcony', 'house_stair_outside', 'house_cellar',
  ],
  dockside: [
    'house_warehouse', 'house_granary_town', 'house_tenement', 'dock_boathouse',
    'house_hovel', 'house_cottage_b', 'house_ruin_house', 'house_half_ruin',
    'house_leaning', 'house_narrow', 'civic_customs', 'civic_granary_tower',
  ],
  suburb: [
    'house_cottage_a', 'house_cottage_b', 'house_hovel', 'house_broad',
    'rural_farmhouse', 'house_stone_a', 'house_broad', 'house_half_ruin',
  ],
};

/** Used when the city pack is missing, so the map still builds and still reads. */
const FALLBACK = [
  'building_cottage', 'building_hut_orc', 'building_tavern', 'building_longhouse',
  'building_granary', 'building_stable', 'building_chapel', 'building_watchtower',
];

// --- plot subdivision ------------------------------------------------------

/**
 * Splits a block into building plots, cutting a street at every split.
 *
 * A binary partition rather than a grid, because a grid of identical plots
 * produces a suburb. Splitting at a jittered ratio down the longer axis gives
 * the irregular frontages and awkward corner plots that make a street look
 * like it was built over three hundred years.
 */
function subdivide(rect: Rect, minPlot: number, rng: Rng, streets: Rect[], out: Rect[]): void {
  const w = width(rect);
  const d = depth(rect);
  // Only an axis with room for two plots plus a road between them may be cut.
  // Choosing the longer axis unconditionally turned a district six units deep
  // into nothing but road: every split took three and a half of the six, and
  // both halves were then too shallow to keep.
  const canX = w > minPlot * 2;
  const canY = d > minPlot * 2;
  if (!canX && !canY) {
    if (w >= minPlot * 0.7 && d >= minPlot * 0.7) out.push(rect);
    return;
  }

  const alongX = canX && (!canY || w > d);
  const span = alongX ? w : d;
  const road = span > minPlot * 5 ? 5 : 3.5;
  const t = 0.5 + (rng.next() - 0.5) * 0.34;
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

// --- the build -------------------------------------------------------------

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
  const gates: CityPlan['gates'] = [];
  const landmarks: CityPlan['landmarks'] = [];
  /** Rectangles nothing further may be placed inside. */
  const taken: Rect[] = [];

  const has = (id: string): boolean => !assets || !!assets.get(id);
  const sizeOf = (id: string): [number, number, number] => assets?.get(id)?.size ?? [4, 4, 4];
  const usable = (ids: string[]): string[] => {
    const kept = ids.filter(has);
    return kept.length ? kept : FALLBACK.filter(has);
  };

  const place = (assetId: string, x: number, y: number, rotation = 0, scale = 1, blocks = true): void => {
    if (!has(assetId)) return;
    const s = sizeOf(assetId);
    const turned = Math.abs(Math.sin(rotation)) > 0.5;
    const halfW = ((turned ? s[2] : s[0]) * scale) / 2;
    const halfD = ((turned ? s[0] : s[2]) * scale) / 2;
    const foot = { x0: x - halfW, y0: y - halfD, x1: x + halfW, y1: y + halfD };
    placements.push({ assetId, x, y, rotation, scale, blocks });
    if (blocks) {
      block(nav, builtMask, foot, CellFlag.BlockMove | CellFlag.BlockVision);
      taken.push(foot);
    }
  };

  const free = (r: Rect, pad = 0): boolean => {
    const test = inflate(r, pad);
    for (const t of taken) if (overlaps(test, t)) return false;
    return true;
  };

  // --- the ground ---------------------------------------------------------

  nav.fillRect(nav.minX, nav.minY, nav.maxX, nav.minY + BORDER, CellFlag.BlockMove | CellFlag.BlockVision);
  nav.fillRect(nav.minX, nav.maxY - BORDER, nav.maxX, nav.maxY, CellFlag.BlockMove | CellFlag.BlockVision);
  nav.fillRect(nav.minX, nav.minY, nav.minX + BORDER, nav.maxY, CellFlag.BlockMove | CellFlag.BlockVision);
  nav.fillRect(nav.maxX - BORDER, nav.minY, nav.maxX, nav.maxY, CellFlag.BlockMove | CellFlag.BlockVision);

  // The river, meandering. Blocked so nothing walks it, and flagged as built so
  // the terrain does not extrude a rock ridge down the middle of the water.
  const bridges = [-58, -4, 52];
  for (let cx = 0; cx < nav.cols; cx++) {
    const x = nav.cellCentreX(cx);
    const cy0 = nav.rowAt(riverY(x) - RIVER_HALF);
    const cy1 = nav.rowAt(riverY(x) + RIVER_HALF);
    const onBridge = bridges.some((bx) => Math.abs(x - bx) < 5);
    for (let cy = Math.max(0, cy0); cy <= Math.min(nav.rows - 1, cy1); cy++) {
      const i = nav.idx(cx, cy);
      riverMask[i] = 255;
      if (onBridge) continue;
      nav.set(cx, cy, CellFlag.BlockMove);
      builtMask[i] = 1;
    }
  }

  // --- avenues ------------------------------------------------------------
  //
  // Drawn before anything is placed, because every district is what the roads
  // left behind rather than the other way round.

  const AVENUE = 9;
  // Paved from the citadel to the south gate and no further: the road beyond
  // the wall is the countryside's, and it is dirt.
  const mainAvenue: Rect = { x0: -AVENUE / 2, y0: WALL.y0 - 34, x1: AVENUE / 2, y1: WALL.y1 };
  const crossAvenue: Rect = { x0: WALL.x0, y0: -17, x1: WALL.x1, y1: -17 + AVENUE };
  streets.push(mainAvenue, crossAvenue);

  // A ring road just inside the wall: the way a garrison actually moves.
  const ringInset = 11;
  const ring = inflate(WALL, -ringInset);
  const RING_W = 6;
  streets.push(
    { x0: ring.x0, y0: ring.y0, x1: ring.x1, y1: ring.y0 + RING_W },
    { x0: ring.x0, y0: ring.y1 - RING_W, x1: ring.x1, y1: ring.y1 },
    { x0: ring.x0, y0: ring.y0, x1: ring.x0 + RING_W, y1: ring.y1 },
    { x0: ring.x1 - RING_W, y0: ring.y0, x1: ring.x1, y1: ring.y1 },
  );

  // Roads out of every gate, to the edge of the world. Kept separate from the
  // paved streets: nobody cobbled the road to the next village, and a cobbled
  // ribbon running off across a wheat field looks exactly as wrong as it is.
  const roads: Rect[] = [
    { x0: -4, y0: WALL.y1, x1: 4, y1: nav.maxY },
    { x0: nav.minX, y0: -14, x1: WALL.x0, y1: -6 },
    { x0: WALL.x1, y0: -14, x1: nav.maxX, y1: -6 },
    { x0: -132, y0: -22, x1: -100, y1: -14 },
  ];

  // --- districts ----------------------------------------------------------

  const districts: District[] = [
    { name: 'Citadel', rect: CITADEL, palette: usable(PALETTES.citadel), minPlot: 16, fill: 0.82 },
    { name: 'Noble Quarter', rect: { x0: -78, y0: -62, x1: 78, y1: -34 }, palette: usable(PALETTES.noble), minPlot: 13.5, fill: 0.78 },
    { name: 'Temple Precinct', rect: { x0: 36, y0: -30, x1: 88, y1: 4 }, palette: usable(PALETTES.temple), minPlot: 20, fill: 0.76 },
    { name: 'Craft Quarter', rect: { x0: -88, y0: -30, x1: -34, y1: 6 }, palette: usable(PALETTES.craft), minPlot: 10.5, fill: 0.8 },
    { name: 'Old Town', rect: { x0: -88, y0: -1, x1: -8, y1: 10 }, palette: usable(PALETTES.residential), minPlot: 9.5, fill: 0.82 },
    { name: 'East Ward', rect: { x0: 34, y0: 6, x1: 88, y1: 22 }, palette: usable(PALETTES.residential), minPlot: 9.5, fill: 0.82 },
    { name: 'Dockside', rect: { x0: -86, y0: 12, x1: 86, y1: 26 }, palette: usable(PALETTES.dockside), minPlot: 10, fill: 0.84 },
    { name: 'Southbank', rect: { x0: -84, y0: 45, x1: 84, y1: 59 }, palette: usable(PALETTES.suburb), minPlot: 9.5, fill: 0.8 },
    { name: 'Upper Ward', rect: { x0: -88, y0: -104, x1: -42, y1: -66 }, palette: usable(PALETTES.residential), minPlot: 10.5, fill: 0.8 },
    { name: 'North Ward', rect: { x0: 42, y0: -104, x1: 88, y1: -66 }, palette: usable(PALETTES.residential), minPlot: 10.5, fill: 0.8 },
  ];

  // --- the curtain wall ---------------------------------------------------

  const gateSpans: Array<{ side: 'n' | 's' | 'e' | 'w'; at: number; name: string; wide: boolean }> = [
    { side: 's', at: 0, name: 'Kings Gate', wide: true },
    { side: 'w', at: -13 + AVENUE / 2, name: 'West Gate', wide: false },
    { side: 'e', at: -13 + AVENUE / 2, name: 'East Gate', wide: false },
    { side: 'n', at: -58, name: 'Postern', wide: false },
  ];

  const wallPiece = has('fort_wall_straight') ? 'fort_wall_straight' : '';
  const towerPiece = has('fort_tower_round') ? 'fort_tower_round' : '';
  const gatePiece = has('fort_gatehouse_great') ? 'fort_gatehouse_great' : '';
  const smallGate = has('fort_wall_gate') ? 'fort_wall_gate' : '';

  const runWall = (
    from: { x: number; y: number },
    to: { x: number; y: number },
    side: 'n' | 's' | 'e' | 'w',
  ): void => {
    const horizontal = Math.abs(to.x - from.x) > Math.abs(to.y - from.y);
    const length = horizontal ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y);
    const steps = Math.max(1, Math.round(length / WALL_SEG));
    const dirX = horizontal ? Math.sign(to.x - from.x) : 0;
    const dirY = horizontal ? 0 : Math.sign(to.y - from.y);
    const rotation = horizontal ? 0 : Math.PI / 2;

    for (let i = 0; i < steps; i++) {
      const t = (i + 0.5) * WALL_SEG;
      const x = from.x + dirX * t;
      const y = from.y + dirY * t;
      const along = horizontal ? x : y;

      const gate = gateSpans.find((g) => g.side === side && Math.abs(along - g.at) < (g.wide ? 9 : 6));
      if (gate) {
        // The opening is cut once, at the gate's centre, and the gatehouse
        // stands in it. The nav hole is wider than the arch so a crowd can
        // actually get through.
        if (Math.abs(along - gate.at) < WALL_SEG * 0.5) {
          const hole = horizontal
            ? { x0: gate.at - 6, y0: y - 4, x1: gate.at + 6, y1: y + 4 }
            : { x0: x - 4, y0: gate.at - 6, x1: x + 4, y1: gate.at + 6 };
          open(nav, hole);
          paint(nav, laneMask, inflate(hole, 3), 255);
          gates.push({ name: gate.name, x, y });
          landmarks.push({ name: gate.name, x, y: y + (side === 's' ? 6 : -6) });
          const piece = gate.wide ? gatePiece || smallGate : smallGate || gatePiece;
          if (piece) {
            // Set beside the opening rather than in it: the arch of a generated
            // gatehouse is not where its bounding box says it is, and a
            // gatehouse straddling the road seals the road.
            const off = gate.wide ? 9 : 7;
            place(piece, horizontal ? x - off : x, horizontal ? y : y - off, rotation);
            place(piece, horizontal ? x + off : x, horizontal ? y : y + off, rotation);
          }
        }
        continue;
      }

      const isTower = i % TOWER_EVERY === 0;
      const band = horizontal
        ? { x0: x - WALL_SEG / 2, y0: y - 1.1, x1: x + WALL_SEG / 2, y1: y + 1.1 }
        : { x0: x - 1.1, y0: y - WALL_SEG / 2, x1: x + 1.1, y1: y + WALL_SEG / 2 };
      block(nav, builtMask, band, CellFlag.BlockMove | CellFlag.BlockVision);
      if (isTower && towerPiece) {
        placements.push({ assetId: towerPiece, x, y, rotation: 0, scale: 1, blocks: false });
      } else if (wallPiece) {
        placements.push({ assetId: wallPiece, x, y, rotation, scale: 1, blocks: false });
      }
    }
  };

  runWall({ x: WALL.x0, y: WALL.y0 }, { x: WALL.x1, y: WALL.y0 }, 'n');
  runWall({ x: WALL.x0, y: WALL.y1 }, { x: WALL.x1, y: WALL.y1 }, 's');
  runWall({ x: WALL.x0, y: WALL.y0 }, { x: WALL.x0, y: WALL.y1 }, 'w');
  runWall({ x: WALL.x1, y: WALL.y0 }, { x: WALL.x1, y: WALL.y1 }, 'e');

  // Where the wall meets the water it stops: two water gates, open to boats and
  // shut to nothing, because the river already blocks the ground.
  for (const wx of [WALL.x0, WALL.x1]) {
    const y = riverY(wx);
    open(nav, { x0: wx - 2, y0: y - RIVER_HALF - 2, x1: wx + 2, y1: y + RIVER_HALF + 2 });
    for (let cy = nav.rowAt(y - RIVER_HALF - 2); cy <= nav.rowAt(y + RIVER_HALF + 2); cy++) {
      for (let cx = nav.colAt(wx - 2); cx <= nav.colAt(wx + 2); cx++) {
        if (!nav.inBounds(cx, cy)) continue;
        const cyWorld = nav.cellCentreY(cy);
        if (Math.abs(cyWorld - y) <= RIVER_HALF) nav.set(cx, cy, CellFlag.BlockMove);
      }
    }
    landmarks.push({ name: 'Water Gate', x: wx, y });
  }

  // The citadel's own wall, one gate facing the main avenue.
  runCitadelWall();

  function runCitadelWall(): void {
    const c = CITADEL;
    const segments: Array<[{ x: number; y: number }, { x: number; y: number }]> = [
      [{ x: c.x0, y: c.y1 }, { x: c.x1, y: c.y1 }],
      [{ x: c.x0, y: c.y0 }, { x: c.x0, y: c.y1 }],
      [{ x: c.x1, y: c.y0 }, { x: c.x1, y: c.y1 }],
    ];
    for (const [from, to] of segments) {
      const horizontal = Math.abs(to.x - from.x) > Math.abs(to.y - from.y);
      const length = horizontal ? Math.abs(to.x - from.x) : Math.abs(to.y - from.y);
      const steps = Math.max(1, Math.round(length / WALL_SEG));
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) * WALL_SEG;
        const x = horizontal ? from.x + t : from.x;
        const y = horizontal ? from.y : from.y + t;
        if (horizontal && Math.abs(x) < 7) continue; // the citadel gate
        const band = horizontal
          ? { x0: x - WALL_SEG / 2, y0: y - 1, x1: x + WALL_SEG / 2, y1: y + 1 }
          : { x0: x - 1, y0: y - WALL_SEG / 2, x1: x + 1, y1: y + WALL_SEG / 2 };
        block(nav, builtMask, band, CellFlag.BlockMove | CellFlag.BlockVision);
        const corner = i === 0 || i === steps - 1;
        const piece = corner && towerPiece ? towerPiece : wallPiece;
        if (piece) {
          placements.push({
            assetId: piece,
            x, y,
            rotation: piece === towerPiece ? 0 : horizontal ? 0 : Math.PI / 2,
            scale: 1,
            blocks: false,
          });
        }
      }
    }
    landmarks.push({ name: 'Citadel Gate', x: 0, y: CITADEL.y1 + 5 });
  }

  // --- fill the districts -------------------------------------------------

  const yardKit = [
    'street_firewood', 'street_barrel_stack', 'street_crate_stack', 'street_sack_pile',
    'street_rain_barrel', 'street_cart_hand', 'street_planter', 'street_laundry_line',
    'street_bench_wood', 'street_dung_heap', 'street_rubble_pile', 'street_table_long',
    'rural_hay_bales', 'rural_chicken_coop', 'rural_beehives', 'rural_crop_cabbage',
    'nature_hedge_section', 'nature_flowerbed', 'nature_topiary', 'street_wheelbarrow',
  ].filter(has);

  /** Scatters a few small things across a plot no building would fit. */
  const dressYard = (plot: Rect): void => {
    if (!yardKit.length) return;
    const count = Math.min(4, 1 + Math.floor((width(plot) * depth(plot)) / 46));
    for (let i = 0; i < count; i++) {
      const x = plot.x0 + 1 + rng.next() * Math.max(0.1, width(plot) - 2);
      const y = plot.y0 + 1 + rng.next() * Math.max(0.1, depth(plot) - 2);
      if (!nav.isWalkableWorld(x, y)) continue;
      place(yardKit[rng.int(0, yardKit.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
    }
  };

  for (const district of districts) {
    const plots: Rect[] = [];
    subdivide(district.rect, district.minPlot, rng, streets, plots);

    for (const plot of plots) {
      const pw = width(plot) * district.fill;
      const pd = depth(plot) * district.fill;
      const cx = (plot.x0 + plot.x1) / 2;
      const cy = (plot.y0 + plot.y1) / 2;

      // Buildings never straddle an avenue or the market, and never stand in
      // the river.
      const foot = { x0: cx - pw / 2, y0: cy - pd / 2, x1: cx + pw / 2, y1: cy + pd / 2 };
      if (overlaps(foot, inflate(mainAvenue, 1))) continue;
      if (overlaps(foot, inflate(crossAvenue, 1))) continue;
      if (overlaps(foot, inflate(MARKET, 2))) continue;
      if (Math.abs(cy - riverY(cx)) < RIVER_HALF + 4) continue;
      if (!free(foot, 0.5)) continue;

      // Pick the piece that fills the plot best in either orientation, so a
      // long thin plot gets a terrace and a square one gets a hall.
      let best: { id: string; rotation: number; scale: number; score: number } | null = null;
      for (const id of district.palette) {
        const s = sizeOf(id);
        for (const rotation of [0, Math.PI / 2]) {
          const turned = rotation !== 0;
          const w = turned ? s[2] : s[0];
          const d = turned ? s[0] : s[2];
          const scale = Math.min(pw / w, pd / d);
          // A narrow band on purpose. Outside it the piece is being visibly
          // resized rather than chosen, and a street of the same house at four
          // different scales looks worse than a street with a gap in it — the
          // gap reads as a yard.
          if (scale < 0.68 || scale > 1.45) continue;
          // Reward filling the plot; penalise having to stretch a small asset.
          const score = (w * scale * d * scale) / (pw * pd) - Math.abs(1 - scale) * 0.35;
          if (!best || score > best.score) best = { id, rotation, scale, score };
        }
      }
      if (!best) {
        // Nothing in the palette fits without being visibly stretched, so the
        // plot becomes a yard instead of bare ground. Cities are full of these:
        // the space behind and between the houses, with the woodpile in it.
        dressYard(foot);
        continue;
      }
      // A quarter turn either way, so a street is not a row of identical fronts.
      const flip = rng.int(0, 1) === 1 ? Math.PI : 0;
      place(best.id, cx, cy, best.rotation + flip, best.scale);
    }
  }

  // --- the market square and the set pieces --------------------------------

  paint(nav, laneMask, MARKET, 255);
  landmarks.push({ name: 'Market Square', x: 0, y: -13 });

  const marketProps = [
    'street_stall_awning', 'street_stall_fruit', 'street_stall_fish', 'street_stall_cloth',
    'street_stall_bread', 'street_stall_smith', 'street_stall_empty',
  ].filter(has);
  if (marketProps.length) {
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 7; col++) {
        const x = MARKET.x0 + 5 + col * 6.4 + (row % 2) * 1.2;
        const y = MARKET.y0 + 5 + row * 6.4;
        if (Math.hypot(x, y + 13) < 6) continue; // leave the middle for the cross
        place(marketProps[rng.int(0, marketProps.length - 1)], x, y, rng.next() * 0.4 - 0.2, 1, false);
      }
    }
  }
  place('street_market_cross', 0, -13, 0, 1, false);
  place('street_fountain_tiered', -20, 0, 0, 1, false);
  place('street_well_stone', 19, -25, 0, 1, false);

  // Landmarks that deserve to be placed by hand rather than fall out of a
  // subdivision: the things a visitor navigates by.
  const setPieces: Array<[string, number, number, number, string]> = [
    ['civic_cathedral', 62, -14, 0, 'Cathedral'],
    ['civic_keep_great', 0, -88, 0, 'The Keep'],
    ['civic_wizard_tower', -72, -46, 0, "Wizard's Tower"],
    ['civic_bell_tower', 22, -38, 0, 'Bell Tower'],
    ['civic_guildhall', -34, 4, 0, 'Guildhall'],
    ['house_tavern', 30, 4, Math.PI, 'The Broken Crown'],
    ['house_inn', -40, -22, 0, 'Coaching Inn'],
    ['rural_windmill', 118, -78, 0, 'Windmill'],
    ['rural_watermill', -118, 30, 0, 'Watermill'],
    ['dock_lighthouse', 96, 40, 0, 'Beacon'],
  ];
  for (const [id, x, y, rot, name] of setPieces) {
    if (!has(id)) continue;
    const s = sizeOf(id);
    const foot = { x0: x - s[0] / 2, y0: y - s[2] / 2, x1: x + s[0] / 2, y1: y + s[2] / 2 };
    if (!free(foot, 1)) continue;
    place(id, x, y, rot);
    landmarks.push({ name, x, y });
  }

  // --- the waterfront ------------------------------------------------------

  for (const side of [-1, 1]) {
    for (let i = 0; i < 9; i++) {
      const x = -70 + i * 17 + side * 3;
      const bank = riverY(x) - RIVER_HALF * side;
      place('dock_harbour_wall', x, bank - 1.4 * side, 0, 1, false);
      if (i % 3 === 1) place('dock_pier_section', x, bank + 3 * side, 0, 1, false);
      if (i % 3 === 2) place('dock_mooring_post', x + 2, bank - 0.4 * side, 0, 1, false);
    }
  }
  for (const [x, kind] of [[-46, 'dock_boat_fishing'], [12, 'dock_boat_barge'], [64, 'dock_boat_cog'], [-16, 'dock_boat_row']] as Array<[number, string]>) {
    place(kind, x, riverY(x), rng.next() * 0.3, 1, false);
  }
  place('dock_dock_crane', 40, riverY(40) - RIVER_HALF - 3, 0, 1, false);
  landmarks.push({ name: 'The Wharf', x: 40, y: riverY(40) - RIVER_HALF - 6 });

  for (const bx of bridges) {
    place('street_bridge_stone', bx, riverY(bx), 0, 1, false);
    paint(nav, laneMask, { x0: bx - 4, y0: riverY(bx) - RIVER_HALF - 4, x1: bx + 4, y1: riverY(bx) + RIVER_HALF + 4 }, 255);
  }

  // --- outside the walls ---------------------------------------------------

  const farmland: Rect[] = [
    { x0: -152, y0: -140, x1: -108, y1: -40 },
    { x0: 108, y0: -140, x1: 152, y1: -40 },
    { x0: -152, y0: 70, x1: -40, y1: 140 },
    { x0: 40, y0: 70, x1: 152, y1: 140 },
  ];
  const ruralKit = [
    'rural_farmhouse', 'rural_barn', 'rural_stable_farm', 'rural_haystack', 'rural_hay_bales',
    'rural_chicken_coop', 'rural_pigsty', 'rural_beehives', 'rural_crop_wheat', 'rural_crop_cabbage',
    'rural_vineyard_row', 'rural_orchard_tree', 'rural_scarecrow', 'rural_well_farm',
    'rural_fence_wood', 'rural_wall_field', 'rural_gate_field', 'rural_fence_wattle',
  ].filter(has);
  if (ruralKit.length) {
    for (const field of farmland) {
      const count = Math.round((width(field) * depth(field)) / 240);
      for (let i = 0; i < count; i++) {
        const id = ruralKit[rng.int(0, ruralKit.length - 1)];
        const x = field.x0 + rng.next() * width(field);
        const y = field.y0 + rng.next() * depth(field);
        if (Math.abs(y - riverY(x)) < RIVER_HALF + 3) continue;
        if (!nav.isWalkableWorld(x, y)) continue;
        const s = sizeOf(id);
        const foot = { x0: x - s[0] / 2, y0: y - s[2] / 2, x1: x + s[0] / 2, y1: y + s[2] / 2 };
        if (!free(foot, 1.5)) continue;
        const heavy = s[1] > 3;
        place(id, x, y, rng.int(0, 3) * (Math.PI / 2), 1, heavy);
      }
    }
  }

  // A graveyard, a shrine and a camp along the roads, so the approach is not
  // an empty field.
  place('rural_graveyard_gate', -118, -14, Math.PI / 2, 1, false);
  for (let i = 0; i < 14; i++) {
    place('rural_tombstone', -134 + (i % 5) * 5, -26 + Math.floor(i / 5) * 6, rng.next(), 1, false);
  }
  place('rural_mausoleum', -136, -6, 0);
  place('folk_gravedigger', -126, -20, 0.7, 1, false);
  landmarks.push({ name: 'Boneyard', x: -128, y: -16 });

  for (let i = 0; i < 7; i++) {
    place(i % 3 === 0 ? 'rural_tent_round' : 'rural_tent_square', -22 + i * 7, 86 + (i % 2) * 9, rng.next(), 1, false);
  }
  place('rural_campfire_ring', 6, 92, 0, 1, false);
  landmarks.push({ name: 'The Camp', x: 6, y: 88 });

  // --- street furniture ----------------------------------------------------
  //
  // Placed along the streets rather than scattered, and never blocking: the
  // point of a lamp post is that you walk past it.

  const furniture = [
    'street_pump', 'street_pillory', 'street_dovecote', 'street_shrine_corner',
    'street_awning_row', 'street_drain',
    'street_lamp_post', 'street_cart_wagon', 'street_cart_hand', 'street_barrel_stack',
    'street_crate_stack', 'street_sack_pile', 'street_firewood', 'street_rain_barrel',
    'street_bench_wood', 'street_signpost', 'street_notice_board', 'street_planter',
    'street_laundry_line', 'street_brazier_street', 'street_trough', 'street_ladder_lean',
    'street_cart_broken', 'street_rubble_pile', 'street_banner_pole', 'street_bunting',
    'nature_tree_street', 'nature_hedge_section', 'nature_flowerbed',
  ].filter(has);
  if (furniture.length) {
    for (const street of streets) {
      const along = Math.max(width(street), depth(street));
      const horizontal = width(street) > depth(street);
      const count = Math.floor(along / 13);
      for (let i = 0; i < count; i++) {
        const t = ((i + 0.5) / count) * along;
        const edge = rng.int(0, 1) === 0 ? -1 : 1;
        const half = (horizontal ? depth(street) : width(street)) / 2;
        const x = horizontal ? street.x0 + t : (street.x0 + street.x1) / 2 + edge * (half - 0.8);
        const y = horizontal ? (street.y0 + street.y1) / 2 + edge * (half - 0.8) : street.y0 + t;
        if (!nav.isWalkableWorld(x, y)) continue;
        if (Math.abs(y - riverY(x)) < RIVER_HALF + 2) continue;
        place(furniture[rng.int(0, furniture.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
      }
    }
  }

  // --- the people ----------------------------------------------------------
  //
  // Standing figures, not units. A city reads as inhabited from the number of
  // people in it long before any of them move, and two hundred static citizens
  // cost one instanced draw call each while two hundred simulated ones cost a
  // pathfinder. The ones that matter can be promoted to units later.

  const crowds: Array<{ ids: string[]; rect: Rect; count: number }> = [
    {
      ids: ['folk_merchant', 'folk_peasant_woman', 'folk_farmer', 'folk_beggar', 'folk_baker',
        'folk_monk', 'folk_bard', 'folk_thief', 'folk_innkeeper', 'folk_stablehand',
        'folk_porter', 'folk_watercarrier', 'folk_basket_woman', 'folk_crier',
        'folk_fishwife', 'folk_child_running', 'folk_child_standing', 'folk_old_woman',
        'folk_old_man', 'folk_maid', 'folk_jester', 'folk_musician', 'folk_dancer',
        'folk_beggar_seated', 'folk_scribe', 'folk_cook', 'creature_dog_street',
        'creature_goose', 'creature_cat'],
      rect: MARKET,
      count: 34,
    },
    {
      ids: ['folk_guard_city', 'folk_manatarms', 'folk_sergeant', 'folk_crossbowman',
        'folk_guard_leaning', 'folk_watchman_lantern', 'folk_standard_bearer'],
      rect: { x0: -12, y0: WALL.y1 - 16, x1: 12, y1: WALL.y1 - 2 },
      count: 6,
    },
    {
      ids: ['folk_knight_plate', 'folk_paladin', 'folk_herald', 'folk_pikeman', 'folk_archer',
        'folk_squire', 'folk_standard_bearer', 'folk_noble_seated', 'creature_falcon'],
      rect: { x0: CITADEL.x0 + 6, y0: CITADEL.y1 - 16, x1: CITADEL.x1 - 6, y1: CITADEL.y1 - 3 },
      count: 8,
    },
    {
      ids: ['folk_fisherman', 'folk_stablehand', 'folk_beggar', 'folk_mercenary', 'folk_merchant',
        'folk_porter', 'folk_cooper', 'folk_carpenter', 'folk_drunk', 'creature_rat_giant',
        'creature_dog_street'],
      rect: { x0: -80, y0: 18, x1: 80, y1: 26 },
      count: 14,
    },
    {
      ids: ['folk_blacksmith', 'folk_peasant_woman', 'folk_stablehand', 'folk_mason',
        'folk_carpenter', 'folk_smith_apprentice', 'folk_miller', 'folk_cooper'],
      rect: { x0: -86, y0: -28, x1: -36, y1: 4 },
      count: 10,
    },
    {
      ids: ['folk_farmer', 'folk_peasant_woman', 'creature_cow', 'creature_pig', 'creature_goat',
        'creature_chicken', 'creature_mule', 'folk_shepherd', 'folk_hunter', 'creature_sheep',
        'creature_ox', 'creature_donkey', 'creature_goose', 'creature_horse_cart'],
      rect: { x0: -150, y0: 74, x1: 150, y1: 136 },
      count: 22,
    },
    {
      ids: ['folk_wizard', 'folk_cleric', 'folk_bishop', 'folk_monk', 'folk_elf_mage',
        'folk_nun', 'folk_kneeling_pilgrim', 'folk_scribe', 'folk_plague_doctor'],
      rect: { x0: 38, y0: -28, x1: 86, y1: 2 },
      count: 7,
    },
  ];

  for (const crowd of crowds) {
    const ids = crowd.ids.filter(has);
    if (!ids.length) continue;
    for (let i = 0; i < crowd.count; i++) {
      const x = crowd.rect.x0 + rng.next() * width(crowd.rect);
      const y = crowd.rect.y0 + rng.next() * depth(crowd.rect);
      if (!nav.isWalkableWorld(x, y)) continue;
      if (Math.abs(y - riverY(x)) < RIVER_HALF + 2) continue;
      // People do not block. Walking through a crowd is better than a market
      // square nobody can cross.
      place(ids[rng.int(0, ids.length - 1)], x, y, rng.next() * Math.PI * 2, 1, false);
    }
  }

  // --- masks ---------------------------------------------------------------

  for (const street of streets) paint(nav, laneMask, street, 255);
  paint(nav, laneMask, inflate(CITADEL, -2), 210);
  // Between the streets is not paving and not lawn. It is the beaten earth of
  // yards, middens and alleys, which is most of what a medieval city stood on.
  for (const district of districts) paint(nav, dirtMask, inflate(district.rect, 3), 235);
  for (const road of roads) paint(nav, dirtMask, road, 255);
  for (const field of farmland) paint(nav, dirtMask, field, 120);
  // A worn apron outside each gate, where the traffic funnels in.
  for (const gate of gates) {
    paint(nav, dirtMask, { x0: gate.x - 16, y0: gate.y - 16, x1: gate.x + 16, y1: gate.y + 16 }, 220);
  }

  nav.rebuildClearance();

  const bounds = {
    minX: nav.minX + BORDER + 2,
    minY: nav.minY + BORDER + 2,
    maxX: nav.maxX - BORDER - 2,
    maxY: nav.maxY - BORDER - 2,
  };

  const plan: CityPlan = {
    landmarks,
    districts,
    streets,
    gates,
    placements,
    // On the road below the south gate, far enough out that the whole wall and
    // the keep behind it are in frame on the first render.
    entrance: { x: 0, y: WALL.y1 + 26 },
  };

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
      [Team.Blue]: vec2(plan.entrance.x, plan.entrance.y),
      [Team.Red]: vec2(0, CITADEL.y0 + 8),
      [Team.Neutral]: vec2(0, 0),
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
 * Everything is non-blocking here. The city already stamped its own collision
 * as rectangles when it was planned, and letting props re-stamp circles on top
 * would round off every building and seal half the streets.
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
