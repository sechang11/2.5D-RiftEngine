/**
 * The showcase: one character and one building under a photographed sky.
 *
 * The city asks every asset to hold up at once and the museum stands four
 * hundred of them in rows. Neither is the place to judge whether one model is
 * good, because neither lets the camera get close and neither lights anything
 * the way its author did. This does both. The camera comes down to eye level
 * and turns, the sky is a real one, and there is nothing else on screen to
 * hide behind.
 *
 * The composition is fixed so that the first frame is a good one: the camera
 * looks north, the character stands on a cobbled apron facing it, and the
 * cottage stands at the end of a path behind him with its door to the camera.
 * The sky is turned to put its sun over the camera's left shoulder rather than
 * the camera being turned to wherever the photographer's sun happened to be.
 *
 * Nothing built from primitives stands in it: one lego training dummy in the
 * corner of the frame undoes the point of the whole page.
 */

import { CellFlag, NavGrid } from '../core/nav/navgrid';
import { Team } from '../core/ecs/types';
import { vec2, type Vec2 } from '../core/math/vec2';
import type { Sim } from '../core/sim/sim';
import type { GameMap } from './content/map01';
import { METRE, type Footprint } from '../render/buildings';
import { emptyMap } from './museum';
import { spawnUnit } from './scenario';

/** Wide enough that the haze takes the edge of the world before the camera finds it. */
const SIZE = 240;

/** Radius of the cobbled apron the character starts on. */
const APRON = 9;

/** Half-width of the path from the apron to the door. */
const PATH = 1.7;

/** The building the showcase stands up, by its id in `render/buildings.ts`. */
export const SHOWCASE_BUILDING = 'cottage';

/** Where it stands, in world units: north of the apron, across the path's end. */
const BUILDING_AT = vec2(0, -17);

/** The cottage's door is the middle panel of its front. */
const DOOR_OFFSET = 0 * METRE;

/**
 * Where the sun is put, as an azimuth measured with atan2(x, z): a little to
 * the left of the camera's own direction from the character, so faces are lit
 * from the front and still have a side in shadow.
 */
export const SHOWCASE_SUN = -0.55;

export interface ShowcaseLayout {
  map: GameMap;
  spawn: Vec2;
  /** The building and where it stands, when it loaded. */
  building: { id: string; x: number; z: number; turn: number } | null;
}

export function buildShowcase(footprint: Footprint | null): ShowcaseLayout {
  const nav = new NavGrid({ cols: SIZE, rows: SIZE, cellSize: 1 });
  const map = emptyMap('Showcase', nav);
  const cells = nav.cols * nav.rows;
  const dirt = new Uint8Array(cells);
  const built = new Uint8Array(cells);
  map.dirtMask = dirt;
  map.builtMask = built;

  // The path ends at the house front, or where one would be.
  const front = BUILDING_AT.y + (footprint ? footprint.maxZ : 4);
  const doorX = BUILDING_AT.x + DOOR_OFFSET;

  for (let row = 0; row < nav.rows; row++) {
    for (let col = 0; col < nav.cols; col++) {
      const x = nav.minX + col + 0.5;
      const y = nav.minY + row + 0.5;
      const i = nav.idx(col, row);

      // A slow wobble on both edges, so neither reads as drawn with a compass.
      const wobble = Math.sin(x * 0.7 + y * 0.3) * 0.6 + Math.sin(y * 1.3 - x * 0.2) * 0.35;
      const fromApron = Math.hypot(x, y) - (APRON + wobble);
      // Eases from the apron's middle to the door, so the path arrives at it.
      const along = clamp01(y / front);
      const centre = doorX * along * along * (3 - 2 * along) + Math.sin(y * 0.4) * 0.35;
      const onPath = y < 0 && y > front - 1.2;
      const fromPath = onPath ? Math.abs(x - centre) - (PATH + wobble * 0.4) : Infinity;
      const edge = Math.min(fromApron, fromPath);

      map.laneMask[i] = Math.round(255 * clamp01(0.5 - edge));
      // Worn earth just outside the stone, where feet leave it, and never on
      // it: under the cobbles it read as pale smears across the paving.
      dirt[i] = edge <= 0 ? 0 : Math.round(190 * clamp01(1 - Math.abs(edge - 0.9) / 1.6));
    }
  }

  let building: ShowcaseLayout['building'] = null;
  if (footprint) {
    const x0 = BUILDING_AT.x + footprint.minX;
    const x1 = BUILDING_AT.x + footprint.maxX;
    const y0 = BUILDING_AT.y + footprint.minZ;
    const y1 = BUILDING_AT.y + footprint.maxZ;
    nav.fillRect(x0, y0, x1, y1, CellFlag.BlockMove | CellFlag.BlockVision);
    // Built over, so the terrain does not push rock up through the floor.
    for (let row = nav.rowAt(y0); row <= nav.rowAt(y1); row++) {
      for (let col = nav.colAt(x0); col <= nav.colAt(x1); col++) built[nav.idx(col, row)] = 1;
    }
    building = { id: SHOWCASE_BUILDING, x: BUILDING_AT.x, z: BUILDING_AT.y, turn: 0 };
  }

  nav.rebuildClearance();

  const spawn = vec2(0, 2);
  map.spawns[Team.Blue] = vec2(spawn.x, spawn.y);
  map.spawns[Team.Red] = vec2(spawn.x, spawn.y);
  const inset = 30;
  map.bounds = { minX: nav.minX + inset, minY: nav.minY + inset, maxX: nav.maxX - inset, maxY: nav.maxY - inset };

  return { map, spawn, building };
}

/** Spawns the character, facing the camera. */
export function populateShowcase(sim: Sim, layout: ShowcaseLayout): { player: ReturnType<typeof spawnUnit> } {
  const player = spawnUnit(sim, 'warden', Team.Blue, layout.spawn);
  player.name = 'Ranger';
  // Facing is measured from +y, which is towards the camera at no yaw.
  player.facing = 0;
  return { player };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
