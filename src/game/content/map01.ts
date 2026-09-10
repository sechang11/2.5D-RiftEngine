/**
 * "Hollow Reach" — the sandbox map.
 *
 * 300 by 300 world units, roughly 460 champion-radii across, which takes about
 * 45 seconds to walk end to end. That is deliberately close to the scale of a
 * MOBA map: large enough that the camera matters, small enough to cross.
 *
 * The layout is generated rather than hand-painted, but not randomly. Lane
 * corridors are carved first and are never built over, which guarantees both
 * bases stay connected no matter what the jungle generator does. Everything
 * else fills the space between them.
 *
 * The generator also emits the masks the renderer needs for terrain shading, so
 * the visual map and the collision map can never disagree.
 */

import { CellFlag, NavGrid } from '../../core/nav/navgrid';
import { Rng } from '../../core/math/rng';
import { Team } from '../../core/ecs/types';
import type { Vec2 } from '../../core/math/vec2';
import { vec2 } from '../../core/math/vec2';
import { distSqPointSegment } from '../../core/math/geom';

export interface Lane {
  name: string;
  points: Vec2[];
  /** Half-width of the walkable corridor in world units. */
  halfWidth: number;
}

export interface CampSpec {
  pos: Vec2;
  archetype: string;
  count: number;
}

export interface TowerSpec {
  pos: Vec2;
  team: Team;
  lane: string;
}

export interface GameMap {
  name: string;
  nav: NavGrid;
  /** Per nav cell: 255 inside a lane corridor, fading to 0 outside. */
  laneMask: Uint8Array;
  /** Per nav cell: 255 in brush. */
  brushMask: Uint8Array;
  /** Per nav cell: 255 in the river band. */
  riverMask: Uint8Array;
  lanes: Lane[];
  spawns: Record<Team, Vec2>;
  camps: CampSpec[];
  towers: TowerSpec[];
  /** Walkable world-space bounds, inset by the border wall. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
}

const CELL = 1;
const COLS = 300;
const ROWS = 300;
const BORDER_CELLS = 4;

/** Distance kept clear around a lane centreline before the jungle may build. */
const LANE_CLEARANCE = 3.5;

export function buildMap01(seed = 9090): GameMap {
  const nav = new NavGrid({ cols: COLS, rows: ROWS, cellSize: CELL });
  const rng = new Rng(seed);

  const blueSpawn = vec2(-118, -118);
  const redSpawn = vec2(118, 118);

  // --- lanes ---------------------------------------------------------------
  // Three routes from base to base: two that hug the map edges and one diagonal.
  const lanes: Lane[] = [
    {
      name: 'top',
      halfWidth: 7,
      points: [vec2(-118, -118), vec2(-104, -60), vec2(-104, 70), vec2(-70, 104), vec2(70, 104), vec2(118, 118)],
    },
    {
      name: 'mid',
      halfWidth: 6,
      points: [vec2(-118, -118), vec2(-60, -54), vec2(0, 0), vec2(54, 60), vec2(118, 118)],
    },
    {
      name: 'bot',
      halfWidth: 7,
      points: [vec2(-118, -118), vec2(-60, -104), vec2(70, -104), vec2(104, -70), vec2(104, 60), vec2(118, 118)],
    },
  ];

  const cells = COLS * ROWS;
  const laneMask = new Uint8Array(cells);
  const brushMask = new Uint8Array(cells);
  const riverMask = new Uint8Array(cells);

  // Distance from every cell to the nearest lane centreline. Used both to keep
  // corridors clear and to shade the ground.
  const laneDist = new Float32Array(cells).fill(1e9);
  for (let cy = 0; cy < ROWS; cy++) {
    const wy = nav.cellCentreY(cy);
    for (let cx = 0; cx < COLS; cx++) {
      const wx = nav.cellCentreX(cx);
      const p = { x: wx, y: wy };
      let best = 1e9;
      let bestHalf = 1;
      for (const lane of lanes) {
        for (let i = 0; i < lane.points.length - 1; i++) {
          const d2 = distSqPointSegment(p, lane.points[i], lane.points[i + 1]);
          if (d2 < best) {
            best = d2;
            bestHalf = lane.halfWidth;
          }
        }
      }
      const d = Math.sqrt(best);
      const i = cy * COLS + cx;
      laneDist[i] = d;
      // Full strength inside the corridor, fading over three units outside it.
      laneMask[i] = d <= bestHalf ? 255 : Math.max(0, 255 - ((d - bestHalf) / 3) * 255);
    }
  }

  // --- border wall ---------------------------------------------------------
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      if (cx < BORDER_CELLS || cy < BORDER_CELLS || cx >= COLS - BORDER_CELLS || cy >= ROWS - BORDER_CELLS) {
        nav.flags[cy * COLS + cx] |= CellFlag.BlockMove | CellFlag.BlockVision;
      }
    }
  }

  // --- jungle walls --------------------------------------------------------
  // Clusters of overlapping discs read as organic rock formations, and a disc
  // is trivially easy to keep a safe distance from a lane.
  const clusterCount = 46;
  for (let c = 0; c < clusterCount; c++) {
    // Rejection-sample a centre that is clear of every lane.
    let cx = 0;
    let cy = 0;
    let ok = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      cx = rng.range(nav.minX + 16, nav.maxX - 16);
      cy = rng.range(nav.minY + 16, nav.maxY - 16);
      const d = laneDist[nav.idx(nav.colAt(cx), nav.rowAt(cy))];
      if (d > LANE_CLEARANCE + 9) {
        ok = true;
        break;
      }
    }
    if (!ok) continue;

    const blobs = rng.int(3, 6);
    for (let b = 0; b < blobs; b++) {
      const ox = cx + rng.range(-7, 7);
      const oy = cy + rng.range(-7, 7);
      const r = rng.range(3.5, 7.5);
      stampWallDisc(nav, laneDist, ox, oy, r);
    }
  }

  // The river: a diagonal band across the middle, perpendicular to mid lane.
  // Walkable and open, but visually distinct and a natural fight location.
  for (let cy = 0; cy < ROWS; cy++) {
    const wy = nav.cellCentreY(cy);
    for (let cx = 0; cx < COLS; cx++) {
      const wx = nav.cellCentreX(cx);
      // Distance from the anti-diagonal through the origin.
      const d = Math.abs(wx + wy) / Math.SQRT2;
      if (d < 11) {
        const i = cy * COLS + cx;
        riverMask[i] = Math.round(255 * (1 - d / 11));
        // The river washes out jungle walls so it stays crossable everywhere.
        if (d < 7) nav.flags[i] &= ~(CellFlag.BlockMove | CellFlag.BlockVision);
      }
    }
  }

  // --- brush ---------------------------------------------------------------
  // Placed beside lanes, where hiding is actually useful.
  const brushSpots: Vec2[] = [];
  for (const lane of lanes) {
    for (let i = 0; i < lane.points.length - 1; i++) {
      const a = lane.points[i];
      const b = lane.points[i + 1];
      const segLen = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.floor(segLen / 34);
      for (let s = 1; s <= steps; s++) {
        const t = s / (steps + 1);
        const mx = a.x + (b.x - a.x) * t;
        const my = a.y + (b.y - a.y) * t;
        // Offset perpendicular to the lane, alternating sides.
        const nx = -(b.y - a.y) / segLen;
        const ny = (b.x - a.x) / segLen;
        const side = s % 2 === 0 ? 1 : -1;
        const off = lane.halfWidth + rng.range(2.5, 5);
        brushSpots.push(vec2(mx + nx * off * side, my + ny * off * side));
      }
    }
  }

  for (const spot of brushSpots) {
    const blobs = rng.int(2, 4);
    for (let b = 0; b < blobs; b++) {
      stampBrushDisc(
        nav,
        brushMask,
        spot.x + rng.range(-3.5, 3.5),
        spot.y + rng.range(-3.5, 3.5),
        rng.range(3, 5.5),
      );
    }
  }

  // --- clear the corridors last -------------------------------------------
  // Whatever the generator did, lanes win. This is what guarantees the map is
  // always fully connected, so no play session can start on an island.
  for (let i = 0; i < cells; i++) {
    if (laneDist[i] <= LANE_CLEARANCE) {
      nav.flags[i] &= ~(CellFlag.BlockMove | CellFlag.BlockVision);
    }
  }
  // Keep the area around each base spawn open.
  clearDisc(nav, blueSpawn.x, blueSpawn.y, 14);
  clearDisc(nav, redSpawn.x, redSpawn.y, 14);

  nav.rebuildClearance();

  // --- objectives ----------------------------------------------------------
  const towers: TowerSpec[] = [];
  for (const lane of lanes) {
    // Towers at fixed fractions along each lane, mirrored per team.
    for (const [team, fractions] of [
      [Team.Blue, [0.18, 0.34]],
      [Team.Red, [0.82, 0.66]],
    ] as const) {
      for (const f of fractions) {
        const p = pointAlongLane(lane, f);
        towers.push({ pos: p, team, lane: lane.name });
      }
    }
  }

  const camps: CampSpec[] = [];
  const campSpots: Array<[number, number, string, number]> = [
    [-58, -18, 'golem', 2],
    [-18, -58, 'golem', 2],
    [58, 18, 'golem', 2],
    [18, 58, 'golem', 2],
    [-74, 46, 'brute', 1],
    [74, -46, 'brute', 1],
    [-40, 62, 'golem', 3],
    [40, -62, 'golem', 3],
  ];
  for (const [x, y, archetype, count] of campSpots) {
    const p = vec2(x, y);
    // Nudge the camp into open ground so it never spawns inside a rock.
    if (nav.nearestFit(p, x, y, 2.2)) camps.push({ pos: p, archetype, count });
  }

  const inset = BORDER_CELLS * CELL + 1;
  return {
    name: 'Hollow Reach',
    nav,
    laneMask,
    brushMask,
    riverMask,
    lanes,
    spawns: {
      [Team.Blue]: blueSpawn,
      [Team.Red]: redSpawn,
      [Team.Neutral]: vec2(0, 0),
    },
    camps,
    towers,
    bounds: {
      minX: nav.minX + inset,
      minY: nav.minY + inset,
      maxX: nav.maxX - inset,
      maxY: nav.maxY - inset,
    },
  };
}

/** Stamps a solid disc, but refuses to encroach on a lane corridor. */
function stampWallDisc(
  nav: NavGrid,
  laneDist: Float32Array,
  wx: number,
  wy: number,
  radius: number,
): void {
  const c0 = nav.colAt(wx - radius);
  const c1 = nav.colAt(wx + radius);
  const r0 = nav.rowAt(wy - radius);
  const r1 = nav.rowAt(wy + radius);
  const r2 = radius * radius;
  for (let cy = r0; cy <= r1; cy++) {
    const dy = nav.cellCentreY(cy) - wy;
    for (let cx = c0; cx <= c1; cx++) {
      const dx = nav.cellCentreX(cx) - wx;
      if (dx * dx + dy * dy > r2) continue;
      const i = nav.idx(cx, cy);
      if (laneDist[i] <= LANE_CLEARANCE) continue;
      nav.flags[i] |= CellFlag.BlockMove | CellFlag.BlockVision;
    }
  }
}

/** Brush blocks sight but not movement, and only lands on walkable ground. */
function stampBrushDisc(
  nav: NavGrid,
  brushMask: Uint8Array,
  wx: number,
  wy: number,
  radius: number,
): void {
  const c0 = nav.colAt(wx - radius);
  const c1 = nav.colAt(wx + radius);
  const r0 = nav.rowAt(wy - radius);
  const r1 = nav.rowAt(wy + radius);
  const r2 = radius * radius;
  for (let cy = r0; cy <= r1; cy++) {
    const dy = nav.cellCentreY(cy) - wy;
    for (let cx = c0; cx <= c1; cx++) {
      const dx = nav.cellCentreX(cx) - wx;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      const i = nav.idx(cx, cy);
      if (nav.flags[i] & CellFlag.BlockMove) continue;
      nav.flags[i] |= CellFlag.Brush;
      const edge = 1 - Math.sqrt(d2) / radius;
      brushMask[i] = Math.max(brushMask[i], Math.round(255 * Math.min(1, edge * 2.2)));
    }
  }
}

function clearDisc(nav: NavGrid, wx: number, wy: number, radius: number): void {
  const c0 = nav.colAt(wx - radius);
  const c1 = nav.colAt(wx + radius);
  const r0 = nav.rowAt(wy - radius);
  const r1 = nav.rowAt(wy + radius);
  const r2 = radius * radius;
  for (let cy = r0; cy <= r1; cy++) {
    const dy = nav.cellCentreY(cy) - wy;
    for (let cx = c0; cx <= c1; cx++) {
      const dx = nav.cellCentreX(cx) - wx;
      if (dx * dx + dy * dy > r2) continue;
      nav.flags[nav.idx(cx, cy)] &= ~(CellFlag.BlockMove | CellFlag.BlockVision | CellFlag.Brush);
    }
  }
}

/** Interpolates a point at fraction `t` along a lane's total arc length. */
export function pointAlongLane(lane: Lane, t: number): Vec2 {
  let total = 0;
  const lengths: number[] = [];
  for (let i = 0; i < lane.points.length - 1; i++) {
    const l = Math.hypot(
      lane.points[i + 1].x - lane.points[i].x,
      lane.points[i + 1].y - lane.points[i].y,
    );
    lengths.push(l);
    total += l;
  }
  let target = total * Math.max(0, Math.min(1, t));
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i]) {
      const f = lengths[i] < 1e-6 ? 0 : target / lengths[i];
      return vec2(
        lane.points[i].x + (lane.points[i + 1].x - lane.points[i].x) * f,
        lane.points[i].y + (lane.points[i + 1].y - lane.points[i].y) * f,
      );
    }
    target -= lengths[i];
  }
  const last = lane.points[lane.points.length - 1];
  return vec2(last.x, last.y);
}

/** Resamples a lane into evenly spaced waypoints for minion routes. */
export function laneRoute(lane: Lane, spacing = 18, reverse = false): Vec2[] {
  const out: Vec2[] = [];
  let total = 0;
  for (let i = 0; i < lane.points.length - 1; i++) {
    total += Math.hypot(
      lane.points[i + 1].x - lane.points[i].x,
      lane.points[i + 1].y - lane.points[i].y,
    );
  }
  const steps = Math.max(2, Math.round(total / spacing));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    out.push(pointAlongLane(lane, reverse ? 1 - t : t));
  }
  return out;
}
