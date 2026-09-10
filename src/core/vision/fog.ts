/**
 * Fog of war.
 *
 * Vision is computed on its own coarse grid, independent of the nav grid, so the
 * cost scales with how much fog detail the game wants rather than with terrain
 * resolution. Three states per cell per team:
 *
 *   0  never seen       fully black
 *   1  seen before      dimmed terrain, no units
 *   2  visible now      lit, units shown
 *
 * The algorithm casts rays around each vision source and marks cells until a
 * blocker stops the ray. Proper recursive shadowcasting would produce cleaner
 * silhouettes, but ray marching is a fraction of the code, fast enough to run
 * every few frames for every unit on the map, and the difference is invisible
 * once the result is blurred in the shader.
 *
 * Brush is the interesting case: it blocks vision while staying walkable, which
 * is what makes it a hiding place rather than a wall.
 */

import type { NavGrid } from '../nav/navgrid';
import { CellFlag } from '../nav/navgrid';
import { Team, UnitFlag } from '../ecs/types';
import type { Unit } from '../ecs/types';

export const enum FogState {
  Unexplored = 0,
  Explored = 1,
  Visible = 2,
}

/** Teams that maintain their own fog. Neutral sees everything. */
const TRACKED_TEAMS = [Team.Blue, Team.Red] as const;

export class FogOfWar {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly minX: number;
  readonly minY: number;

  /** One byte per cell per tracked team, indexed by `teamOffset`. */
  private readonly state: Uint8Array;
  private readonly nav: NavGrid;
  /** Cached per-cell opacity so the hot loop never touches the nav grid. */
  private readonly opaque: Uint8Array;

  /** Set true whenever the state changed, so the renderer can skip uploads. */
  dirty = true;

  constructor(nav: NavGrid, cellSize = 2) {
    this.nav = nav;
    this.cellSize = cellSize;
    this.cols = Math.ceil(nav.width / cellSize);
    this.rows = Math.ceil(nav.height / cellSize);
    this.minX = nav.minX;
    this.minY = nav.minY;
    this.state = new Uint8Array(this.cols * this.rows * TRACKED_TEAMS.length);
    this.opaque = new Uint8Array(this.cols * this.rows);
    this.rebuildOpacity();
  }

  /** Re-samples terrain opacity. Call after any terrain edit. */
  rebuildOpacity(): void {
    const { cols, rows, cellSize, nav } = this;
    for (let cy = 0; cy < rows; cy++) {
      const wy = this.minY + (cy + 0.5) * cellSize;
      for (let cx = 0; cx < cols; cx++) {
        const wx = this.minX + (cx + 0.5) * cellSize;
        const ncx = nav.colAt(wx);
        const ncy = nav.rowAt(wy);
        const blocks =
          nav.has(ncx, ncy, CellFlag.BlockVision) || nav.has(ncx, ncy, CellFlag.Brush);
        this.opaque[cy * cols + cx] = blocks ? 1 : 0;
      }
    }
  }

  private teamOffset(team: Team): number {
    return team === Team.Blue ? 0 : this.cols * this.rows;
  }

  colAt(x: number): number {
    const c = Math.floor((x - this.minX) / this.cellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  rowAt(y: number): number {
    const r = Math.floor((y - this.minY) / this.cellSize);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  stateAt(team: Team, x: number, y: number): FogState {
    if (team === Team.Neutral) return FogState.Visible;
    const i = this.teamOffset(team) + this.rowAt(y) * this.cols + this.colAt(x);
    return this.state[i] as FogState;
  }

  isVisible(team: Team, x: number, y: number): boolean {
    return this.stateAt(team, x, y) === FogState.Visible;
  }

  /** Raw buffer for a team, for uploading to a texture. */
  buffer(team: Team): Uint8Array {
    const off = this.teamOffset(team);
    return this.state.subarray(off, off + this.cols * this.rows);
  }

  /** Reveals the whole map permanently. The sandbox uses this as a debug toggle. */
  revealAll(): void {
    this.state.fill(FogState.Visible);
    this.dirty = true;
  }

  /**
   * Recomputes current visibility for both teams and stamps each unit's
   * `visibleTo` mask.
   *
   * Previously-visible cells decay to Explored rather than Unexplored, which is
   * what gives the classic dimmed-but-remembered terrain.
   */
  update(units: readonly Unit[]): void {
    const cells = this.cols * this.rows;

    for (let t = 0; t < TRACKED_TEAMS.length; t++) {
      const off = t * cells;
      for (let i = 0; i < cells; i++) {
        if (this.state[off + i] === FogState.Visible) this.state[off + i] = FogState.Explored;
      }
    }

    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      if (u.hp <= 0 || !u.alive) continue;
      if (!(u.flags & UnitFlag.RevealsFog)) continue;
      if (u.team === Team.Neutral) continue;
      this.castFrom(u.team, u.pos.x, u.pos.y, u.stats.visionRange);
    }

    // A unit standing in an opaque cell (brush) is only seen by enemies whose
    // own vision reaches into that cell, which is exactly what the ray march
    // already computed.
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      let mask = 0;
      if (u.hp > 0 && u.alive) {
        if (this.isVisible(Team.Blue, u.pos.x, u.pos.y)) mask |= 1 << Team.Blue;
        if (this.isVisible(Team.Red, u.pos.x, u.pos.y)) mask |= 1 << Team.Red;
      }
      // You always see your own team.
      if (u.team !== Team.Neutral) mask |= 1 << u.team;
      u.visibleTo = mask;
    }

    this.dirty = true;
  }

  /**
   * Marches rays outward from a source, stopping each at the first opaque cell.
   *
   * Ray count scales with the circumference so angular gaps stay below one cell
   * at the rim, and the blocker itself is marked visible before the ray stops,
   * so walls are lit rather than appearing as black outlines.
   */
  private castFrom(team: Team, wx: number, wy: number, range: number): void {
    const off = this.teamOffset(team);
    const { cols, rows, cellSize, state, opaque } = this;

    const radiusCells = range / cellSize;
    const originX = (wx - this.minX) / cellSize;
    const originY = (wy - this.minY) / cellSize;

    const ocx = Math.floor(originX);
    const ocy = Math.floor(originY);
    if (ocx >= 0 && ocy >= 0 && ocx < cols && ocy < rows) {
      state[off + ocy * cols + ocx] = FogState.Visible;
    }

    const rays = Math.max(32, Math.ceil(radiusCells * 2 * Math.PI * 1.6));
    const angleStep = (Math.PI * 2) / rays;
    const stepLen = 0.5; // half a cell per step: no cell is skipped

    for (let r = 0; r < rays; r++) {
      const a = r * angleStep;
      const dx = Math.cos(a) * stepLen;
      const dy = Math.sin(a) * stepLen;
      let x = originX;
      let y = originY;
      const steps = Math.ceil(radiusCells / stepLen);

      for (let s = 0; s < steps; s++) {
        x += dx;
        y += dy;
        const cx = Math.floor(x);
        const cy = Math.floor(y);
        if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) break;
        const i = cy * cols + cx;
        state[off + i] = FogState.Visible;
        if (opaque[i]) break;
      }
    }
  }
}
