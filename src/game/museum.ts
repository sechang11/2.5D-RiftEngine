/**
 * The asset museum: every mesh in the pack, laid out as a place you walk
 * through.
 *
 * The contact sheet at /sheet.html shows the whole pack at once and is almost
 * useless for judging an asset, because everything is far away and nothing is
 * at the scale or the camera angle the game will actually use it at. A model
 * that reads perfectly from three metres away can be a smear from the game's
 * fixed height, and a sheet cannot tell you that.
 *
 * So the pack becomes a level instead. One walled gallery per category, each
 * exhibit on the floor with a label above it, and the player's own champion
 * standing next to them for scale. It is the same renderer, the same camera and
 * the same controls as the game, which is the point: you are looking at each
 * asset under exactly the conditions it will be used under.
 *
 * It is also the second thing built on this engine, which is the only real test
 * of whether the map, scenario and content layers are actually separable.
 */

import { CellFlag, NavGrid } from '../core/nav/navgrid';
import { Team } from '../core/ecs/types';
import { vec2, type Vec2 } from '../core/math/vec2';
import type { GameMap } from './content/map01';
import type { AssetEntry, AssetRegistry } from '../render/assets';
import { PropFlag, type PropStore } from '../core/world/props';
import type { Sim } from '../core/sim/sim';
import { spawnUnit } from './scenario';

const CELL = 1;

/** Gap between the wall and the first exhibit. */
const ROOM_PADDING = 3.5;

/** Corridor width between galleries. */
const CORRIDOR = 9;

/** Wall thickness in world units. */
const WALL = 1.6;

/** Doorway width cut into a gallery's south wall. */
const DOOR = 7;

/** Galleries are packed into rows no wider than this before starting a new one. */
const MAX_ROW_WIDTH = 190;

/** Space reserved around every exhibit, on top of its own footprint. */
const EXHIBIT_MARGIN = 2.6;

/** Clamp on exhibit spacing, so one huge asset does not spread out a gallery. */
const MIN_CELL = 4.5;
const MAX_CELL = 15;

export interface Exhibit {
  assetId: string;
  name: string;
  category: string;
  x: number;
  y: number;
  /** Height of the mesh, so the label floats above it. */
  height: number;
  triangles: number;
  size: [number, number, number];
}

export interface Gallery {
  category: string;
  /** Room rectangle in world space, inside the walls. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Where the category sign hangs, at the doorway. */
  signX: number;
  signY: number;
  count: number;
}

export interface MuseumLayout {
  map: GameMap;
  galleries: Gallery[];
  exhibits: Exhibit[];
  entrance: Vec2;
}

interface PlannedRoom {
  category: string;
  entries: AssetEntry[];
  cell: number;
  cols: number;
  rows: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

const footprint = (e: AssetEntry): number => Math.max(e.size[0], e.size[2]);

/**
 * Plans every gallery before any geometry exists, because the map has to be
 * exactly large enough to hold the result. Sizing the grid first and hoping the
 * content fits is how you end up with a museum that runs off the edge of the
 * world.
 */
function planRooms(assets: AssetRegistry): PlannedRoom[] {
  const rooms: PlannedRoom[] = [];

  for (const category of assets.categories()) {
    const entries = assets.byCategory(category);
    if (entries.length === 0) continue;

    // One cell size per gallery, driven by its largest exhibit, so a hall of
    // daggers is dense and a hall of towers is not.
    const largest = entries.reduce((m, e) => Math.max(m, footprint(e)), 0);
    const cell = Math.min(MAX_CELL, Math.max(MIN_CELL, largest + EXHIBIT_MARGIN));

    // Slightly wider than deep reads better under a camera that looks along z.
    const cols = Math.max(1, Math.ceil(Math.sqrt(entries.length * 1.6)));
    const rows = Math.ceil(entries.length / cols);

    rooms.push({
      category,
      entries,
      cell,
      cols,
      rows,
      width: cols * cell + ROOM_PADDING * 2,
      height: rows * cell + ROOM_PADDING * 2,
      x: 0,
      y: 0,
    });
  }

  // Shelf-pack the rooms into rows. Largest first, so a wide gallery never
  // gets stranded on a row of its own at the end.
  rooms.sort((a, b) => b.width - a.width);

  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  for (const room of rooms) {
    if (cursorX > 0 && cursorX + room.width > MAX_ROW_WIDTH) {
      cursorX = 0;
      cursorY += rowHeight + CORRIDOR;
      rowHeight = 0;
    }
    room.x = cursorX;
    room.y = cursorY;
    cursorX += room.width + CORRIDOR;
    rowHeight = Math.max(rowHeight, room.height);
  }

  return rooms;
}

/**
 * Builds the museum map and returns everything needed to populate and label it.
 *
 * The nav grid is sized to the plan plus a border, then walls are stamped
 * around each gallery with a doorway on its south side.
 */
export function buildMuseum(assets: AssetRegistry): MuseumLayout {
  const rooms = planRooms(assets);

  if (rooms.length === 0) {
    // No pack. Return a small empty courtyard rather than a zero-sized grid.
    const nav = new NavGrid({ cols: 80, rows: 80, cellSize: CELL });
    nav.rebuildClearance();
    return {
      map: emptyMap('Museum', nav),
      galleries: [],
      exhibits: [],
      entrance: vec2(0, 0),
    };
  }

  const planWidth = Math.max(...rooms.map((r) => r.x + r.width));
  const planHeight = Math.max(...rooms.map((r) => r.y + r.height));
  const margin = CORRIDOR + 8;

  const cols = Math.ceil((planWidth + margin * 2) / CELL);
  const rows = Math.ceil((planHeight + margin * 2) / CELL);
  const nav = new NavGrid({ cols, rows, cellSize: CELL });

  // Plan coordinates start at the origin; the grid is centred on it.
  const offsetX = nav.minX + margin;
  const offsetY = nav.minY + margin;

  const map = emptyMap('The Asset Museum', nav);

  // Outer boundary.
  const border = 3;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      if (cx < border || cy < border || cx >= cols - border || cy >= rows - border) {
        nav.flags[cy * cols + cx] |= CellFlag.BlockMove | CellFlag.BlockVision;
      }
    }
  }

  const galleries: Gallery[] = [];
  const exhibits: Exhibit[] = [];

  for (const room of rooms) {
    const x0 = offsetX + room.x;
    const y0 = offsetY + room.y;
    const x1 = x0 + room.width;
    const y1 = y0 + room.height;

    // Walls on all four sides, with a doorway in the middle of the south edge.
    const doorFrom = (x0 + x1) / 2 - DOOR / 2;
    const doorTo = doorFrom + DOOR;

    stampWall(nav, x0 - WALL, y0 - WALL, x1 + WALL, y0);            // north
    stampWall(nav, x0 - WALL, y1, x1 + WALL, y1 + WALL);            // south, cut below
    stampWall(nav, x0 - WALL, y0 - WALL, x0, y1 + WALL);            // west
    stampWall(nav, x1, y0 - WALL, x1 + WALL, y1 + WALL);            // east
    clearRect(nav, doorFrom, y1 - 0.1, doorTo, y1 + WALL + 0.1);    // doorway

    // Paved floor inside, which the terrain shader renders as trodden stone.
    paint(map, nav, x0, y0, x1, y1, 'lane', 235);
    // A darker threshold strip at the door.
    paint(map, nav, doorFrom, y1 - 1, doorTo, y1 + WALL, 'river', 120);

    galleries.push({
      category: room.category,
      minX: x0,
      minY: y0,
      maxX: x1,
      maxY: y1,
      signX: (x0 + x1) / 2,
      signY: y1 + WALL + 1.6,
      count: room.entries.length,
    });

    // Exhibits, laid out row-major from the far wall forward.
    room.entries.forEach((entry, i) => {
      const col = i % room.cols;
      const row = Math.floor(i / room.cols);
      exhibits.push({
        assetId: entry.id,
        name: entry.name,
        category: entry.category,
        x: x0 + ROOM_PADDING + (col + 0.5) * room.cell,
        y: y0 + ROOM_PADDING + (row + 0.5) * room.cell,
        height: entry.size[1],
        triangles: entry.triangles,
        size: entry.size,
      });
    });
  }

  nav.rebuildClearance();

  // Start inside the first gallery, a little way in from its door.
  //
  // Spawning in the corridor outside looked tidier and was worse: the opening
  // shot was a wall. A museum should open on an exhibit.
  const first = galleries[0];
  // A third of the way in, so the opening view is exhibits rather than the
  // wall the camera would otherwise frame behind the visitor.
  const entrance = vec2(first.signX, first.maxY - (first.maxY - first.minY) * 0.32);

  map.spawns[Team.Blue] = vec2(entrance.x, entrance.y);
  map.spawns[Team.Red] = vec2(entrance.x, entrance.y);

  const inset = border * CELL + 1;
  map.bounds = {
    minX: nav.minX + inset,
    minY: nav.minY + inset,
    maxX: nav.maxX - inset,
    maxY: nav.maxY - inset,
  };

  return { map, galleries, exhibits, entrance };
}

/** Places every exhibit as a prop and spawns the visitor. */
export function populateMuseum(
  sim: Sim,
  layout: MuseumLayout,
  props: PropStore,
  assets: AssetRegistry,
): { player: ReturnType<typeof spawnUnit> } {
  props.clear();

  for (const exhibit of layout.exhibits) {
    const entry = assets.get(exhibit.assetId);
    props.add({
      assetId: exhibit.assetId,
      category: exhibit.category,
      x: exhibit.x,
      y: exhibit.y,
      // A slight turn keeps a row of identical crates from looking stamped.
      rotation: ((exhibit.x * 31 + exhibit.y * 17) % 100) / 100 - 0.5,
      scale: 1,
      // Nothing blocks. Walking up to an exhibit and around it is the entire
      // purpose, and a hall of solid props is a maze.
      flags: PropFlag.None,
      radius: entry?.radius ?? 0.5,
    });
  }
  props.invalidateNav();
  props.rebuildNav(true);

  const player = spawnUnit(sim, 'warden', Team.Blue, layout.entrance);
  player.name = 'Visitor';
  return { player };
}

// --- helpers --------------------------------------------------------------

function emptyMap(name: string, nav: NavGrid): GameMap {
  const cells = nav.cols * nav.rows;
  return {
    name,
    nav,
    laneMask: new Uint8Array(cells),
    brushMask: new Uint8Array(cells),
    riverMask: new Uint8Array(cells),
    lanes: [],
    spawns: {
      [Team.Neutral]: vec2(0, 0),
      [Team.Blue]: vec2(0, 0),
      [Team.Red]: vec2(0, 0),
    },
    camps: [],
    towers: [],
    bounds: { minX: nav.minX, minY: nav.minY, maxX: nav.maxX, maxY: nav.maxY },
  };
}

function stampWall(nav: NavGrid, x0: number, y0: number, x1: number, y1: number): void {
  nav.fillRect(x0, y0, x1, y1, CellFlag.BlockMove | CellFlag.BlockVision);
}

function clearRect(nav: NavGrid, x0: number, y0: number, x1: number, y1: number): void {
  const c0 = nav.colAt(Math.min(x0, x1));
  const c1 = nav.colAt(Math.max(x0, x1));
  const r0 = nav.rowAt(Math.min(y0, y1));
  const r1 = nav.rowAt(Math.max(y0, y1));
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      nav.flags[nav.idx(cx, cy)] &= ~(CellFlag.BlockMove | CellFlag.BlockVision);
    }
  }
}

function paint(
  map: GameMap,
  nav: NavGrid,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  channel: 'lane' | 'brush' | 'river',
  value: number,
): void {
  const target =
    channel === 'lane' ? map.laneMask : channel === 'brush' ? map.brushMask : map.riverMask;
  const c0 = nav.colAt(Math.min(x0, x1));
  const c1 = nav.colAt(Math.max(x0, x1));
  const r0 = nav.rowAt(Math.min(y0, y1));
  const r1 = nav.rowAt(Math.max(y0, y1));
  for (let cy = r0; cy <= r1; cy++) {
    for (let cx = c0; cx <= c1; cx++) {
      const i = nav.idx(cx, cy);
      if (value > target[i]) target[i] = value;
    }
  }
}
