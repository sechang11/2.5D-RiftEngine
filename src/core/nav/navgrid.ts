/**
 * The navigation grid: the engine's single source of truth for "where can
 * things be".
 *
 * A 2.5D game has no third axis to path around, so terrain collapses to a
 * tile grid with per-cell flags. Three facts live here:
 *
 *   - movement blocking (walls, cliffs, map border)
 *   - vision blocking (walls, and brush, which you can walk into but not see through)
 *   - a clearance field, the approximate distance from each cell to the nearest
 *     blocker
 *
 * Clearance is what stops a 0.65-radius champion from pathing through a gap one
 * cell wide. Without it A* happily returns a route the body cannot physically
 * follow, and the unit grinds against a corner forever.
 */

import type { Vec2 } from '../math/vec2';

export const enum CellFlag {
  None = 0,
  /** Bodies cannot overlap this cell. */
  BlockMove = 1 << 0,
  /** Sight lines stop here. */
  BlockVision = 1 << 1,
  /** Walkable, but opaque: the classic MOBA bush. */
  Brush = 1 << 2,
}

export interface NavGridOptions {
  /** Cell count along x. */
  cols: number;
  /** Cell count along y (the world's z axis). */
  rows: number;
  /** World units per cell. */
  cellSize: number;
}

export class NavGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cellSize: number;
  readonly invCellSize: number;

  /** World-space extent, centred on the origin. */
  readonly width: number;
  readonly height: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;

  readonly flags: Uint8Array;
  /** Distance in world units from each cell centre to the nearest blocked cell. */
  readonly clearance: Float32Array;

  private clearanceDirty = true;

  constructor(opts: NavGridOptions) {
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.cellSize = opts.cellSize;
    this.invCellSize = 1 / opts.cellSize;
    this.width = this.cols * this.cellSize;
    this.height = this.rows * this.cellSize;
    this.minX = -this.width * 0.5;
    this.minY = -this.height * 0.5;
    this.maxX = this.width * 0.5;
    this.maxY = this.height * 0.5;
    this.flags = new Uint8Array(this.cols * this.rows);
    this.clearance = new Float32Array(this.cols * this.rows);
  }

  // --- indexing -------------------------------------------------------------

  idx(cx: number, cy: number): number {
    return cy * this.cols + cx;
  }

  inBounds(cx: number, cy: number): boolean {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  /** World x to column. Values outside the map clamp, so callers never index out of range. */
  colAt(x: number): number {
    const c = Math.floor((x - this.minX) * this.invCellSize);
    return c < 0 ? 0 : c >= this.cols ? this.cols - 1 : c;
  }

  rowAt(y: number): number {
    const r = Math.floor((y - this.minY) * this.invCellSize);
    return r < 0 ? 0 : r >= this.rows ? this.rows - 1 : r;
  }

  /** Centre of a cell in world space. */
  cellCentreX(cx: number): number {
    return this.minX + (cx + 0.5) * this.cellSize;
  }

  cellCentreY(cy: number): number {
    return this.minY + (cy + 0.5) * this.cellSize;
  }

  // --- flags ----------------------------------------------------------------

  set(cx: number, cy: number, flags: CellFlag): void {
    if (!this.inBounds(cx, cy)) return;
    this.flags[this.idx(cx, cy)] |= flags;
    this.clearanceDirty = true;
  }

  unset(cx: number, cy: number, flags: CellFlag): void {
    if (!this.inBounds(cx, cy)) return;
    this.flags[this.idx(cx, cy)] &= ~flags;
    this.clearanceDirty = true;
  }

  has(cx: number, cy: number, flag: CellFlag): boolean {
    if (!this.inBounds(cx, cy)) return flag === CellFlag.BlockMove || flag === CellFlag.BlockVision;
    return (this.flags[this.idx(cx, cy)] & flag) !== 0;
  }

  /** Out-of-bounds counts as blocked: the map edge is a wall. */
  isBlocked(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return true;
    return (this.flags[this.idx(cx, cy)] & CellFlag.BlockMove) !== 0;
  }

  isWalkable(cx: number, cy: number): boolean {
    return !this.isBlocked(cx, cy);
  }

  blocksVision(cx: number, cy: number): boolean {
    if (!this.inBounds(cx, cy)) return true;
    return (this.flags[this.idx(cx, cy)] & CellFlag.BlockVision) !== 0;
  }

  isWalkableWorld(x: number, y: number): boolean {
    if (x < this.minX || y < this.minY || x >= this.maxX || y >= this.maxY) return false;
    return !this.isBlocked(this.colAt(x), this.rowAt(y));
  }

  /** Stamps a world-space rectangle. Used by map authoring to carve walls and brush. */
  fillRect(x0: number, y0: number, x1: number, y1: number, flags: CellFlag): void {
    const cx0 = this.colAt(Math.min(x0, x1));
    const cx1 = this.colAt(Math.max(x0, x1));
    const cy0 = this.rowAt(Math.min(y0, y1));
    const cy1 = this.rowAt(Math.max(y0, y1));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        this.flags[this.idx(cx, cy)] |= flags;
      }
    }
    this.clearanceDirty = true;
  }

  fillCircle(cx: number, cy: number, radius: number, flags: CellFlag): void {
    const c0 = this.colAt(cx - radius);
    const c1 = this.colAt(cx + radius);
    const r0 = this.rowAt(cy - radius);
    const r1 = this.rowAt(cy + radius);
    const r2 = radius * radius;
    for (let r = r0; r <= r1; r++) {
      const wy = this.cellCentreY(r) - cy;
      for (let c = c0; c <= c1; c++) {
        const wx = this.cellCentreX(c) - cx;
        if (wx * wx + wy * wy <= r2) this.flags[this.idx(c, r)] |= flags;
      }
    }
    this.clearanceDirty = true;
  }

  // --- clearance field ------------------------------------------------------

  /**
   * Two-pass chamfer distance transform. Exact Euclidean distance would need a
   * heavier algorithm; the 3x3 chamfer with weights 1 and sqrt(2) is within a
   * few percent, which is far below the precision gameplay needs, and it runs
   * in two linear sweeps over the grid.
   */
  rebuildClearance(): void {
    const { cols, rows, flags, clearance, cellSize } = this;
    const BIG = 1e9;
    const D1 = 1;
    const D2 = Math.SQRT2;

    for (let i = 0; i < flags.length; i++) {
      clearance[i] = (flags[i] & CellFlag.BlockMove) !== 0 ? 0 : BIG;
    }

    // Forward pass: top-left to bottom-right.
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = y * cols + x;
        if (clearance[i] === 0) continue;
        let best = clearance[i];
        if (x > 0) best = Math.min(best, clearance[i - 1] + D1);
        if (y > 0) {
          best = Math.min(best, clearance[i - cols] + D1);
          if (x > 0) best = Math.min(best, clearance[i - cols - 1] + D2);
          if (x < cols - 1) best = Math.min(best, clearance[i - cols + 1] + D2);
        }
        clearance[i] = best;
      }
    }

    // Backward pass: bottom-right to top-left.
    for (let y = rows - 1; y >= 0; y--) {
      for (let x = cols - 1; x >= 0; x--) {
        const i = y * cols + x;
        if (clearance[i] === 0) continue;
        let best = clearance[i];
        if (x < cols - 1) best = Math.min(best, clearance[i + 1] + D1);
        if (y < rows - 1) {
          best = Math.min(best, clearance[i + cols] + D1);
          if (x > 0) best = Math.min(best, clearance[i + cols - 1] + D2);
          if (x < cols - 1) best = Math.min(best, clearance[i + cols + 1] + D2);
        }
        clearance[i] = best;
      }
    }

    // Convert cell counts to world units. The half-cell offset accounts for the
    // blocked cell's own extent: a cell adjacent to a wall has its centre half a
    // cell from the wall face, not a full cell.
    for (let i = 0; i < clearance.length; i++) {
      clearance[i] = clearance[i] >= BIG ? 1e9 : Math.max(0, (clearance[i] - 0.5) * cellSize);
    }

    this.clearanceDirty = false;
  }

  ensureClearance(): void {
    if (this.clearanceDirty) this.rebuildClearance();
  }

  clearanceAt(cx: number, cy: number): number {
    if (!this.inBounds(cx, cy)) return 0;
    return this.clearance[this.idx(cx, cy)];
  }

  clearanceAtWorld(x: number, y: number): number {
    if (x < this.minX || y < this.minY || x >= this.maxX || y >= this.maxY) return 0;
    return this.clearance[this.idx(this.colAt(x), this.rowAt(y))];
  }

  /** True when a body of `radius` can stand centred on this cell. */
  fits(cx: number, cy: number, radius: number): boolean {
    if (this.isBlocked(cx, cy)) return false;
    return this.clearance[this.idx(cx, cy)] >= radius;
  }

  // --- queries --------------------------------------------------------------

  /**
   * Can a body of `radius` slide in a straight line from a to b?
   *
   * Three samples are taken at every step along the segment: the centre line
   * and both edges of the swept capsule, offset perpendicular by the radius.
   *
   * The edge samples are not an optimisation, they are the whole point. The
   * clearance field measures room around a cell *centre*, which is the right
   * question for standing still and the wrong one for squeezing between two
   * blocked cells that touch at a corner. There the centre line threads a gap
   * of exactly zero width while the clearance field still reads half a cell,
   * so a centre-only test happily walks a unit through solid rock. Sampling
   * the capsule's edges puts those two blocked cells directly under the test.
   *
   * This is also the rule the pathfinder enforces when it refuses to cut a
   * diagonal corner, so smoothing can never re-introduce a move A* rejected.
   */
  lineClear(a: Vec2, b: Vec2, radius: number): boolean {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1e-6) return this.clearanceAtWorld(a.x, a.y) >= radius;

    const step = this.cellSize * 0.5;
    const steps = Math.ceil(length / step);
    const sx = dx / steps;
    const sy = dy / steps;
    // Unit perpendicular, scaled to the body's radius.
    const px = (-dy / length) * radius;
    const py = (dx / length) * radius;

    let x = a.x;
    let y = a.y;
    for (let i = 0; i <= steps; i++) {
      if (this.clearanceAtWorld(x, y) < radius) return false;
      if (radius > 0) {
        if (!this.isWalkableWorld(x + px, y + py)) return false;
        if (!this.isWalkableWorld(x - px, y - py)) return false;
      }
      x += sx;
      y += sy;
    }
    return true;
  }

  /** Sight line test: ignores clearance, only asks whether anything opaque intervenes. */
  visionClear(ax: number, ay: number, bx: number, by: number): boolean {
    const dx = bx - ax;
    const dy = by - ay;
    const length = Math.sqrt(dx * dx + dy * dy);
    if (length < 1e-6) return true;
    const steps = Math.ceil(length * this.invCellSize * 1.5);
    const sx = dx / steps;
    const sy = dy / steps;
    let x = ax;
    let y = ay;
    for (let i = 0; i <= steps; i++) {
      if (this.blocksVision(this.colAt(x), this.rowAt(y))) return false;
      x += sx;
      y += sy;
    }
    return true;
  }

  /**
   * Walks a segment and returns how far it can travel before clearance fails,
   * as a distance in world units. Dashes and knockbacks use this to stop at a
   * wall instead of tunnelling through it.
   */
  maxTravel(a: Vec2, dirX: number, dirY: number, distance: number, radius: number): number {
    const step = this.cellSize * 0.4;
    const steps = Math.max(1, Math.ceil(distance / step));
    // Same capsule edges as `lineClear`, for the same reason: a dash aimed
    // exactly at a diagonal seam between two rocks must not slip through it.
    const px = -dirY * radius;
    const py = dirX * radius;
    let travelled = 0;
    for (let i = 1; i <= steps; i++) {
      const t = (distance * i) / steps;
      const x = a.x + dirX * t;
      const y = a.y + dirY * t;
      if (this.clearanceAtWorld(x, y) < radius) break;
      if (radius > 0 && (!this.isWalkableWorld(x + px, y + py) || !this.isWalkableWorld(x - px, y - py))) {
        break;
      }
      travelled = t;
    }
    return travelled;
  }

  /**
   * Nearest cell centre where a body of `radius` fits, searched as an expanding
   * ring. Clicks land in walls constantly; snapping the destination is what
   * makes "walk towards that cliff" feel right instead of silently failing.
   */
  nearestFit(out: Vec2, x: number, y: number, radius: number, maxRings = 48): boolean {
    const cx = this.colAt(x);
    const cy = this.rowAt(y);
    if (this.fits(cx, cy, radius)) {
      out.x = x;
      out.y = y;
      return true;
    }
    for (let ring = 1; ring <= maxRings; ring++) {
      let bestIdxX = -1;
      let bestIdxY = -1;
      let bestD2 = Infinity;
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dx = -ring; dx <= ring; dx++) {
          // Only the perimeter of the ring is new.
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const tx = cx + dx;
          const ty = cy + dy;
          if (!this.fits(tx, ty, radius)) continue;
          const wx = this.cellCentreX(tx) - x;
          const wy = this.cellCentreY(ty) - y;
          const d2 = wx * wx + wy * wy;
          if (d2 < bestD2) {
            bestD2 = d2;
            bestIdxX = tx;
            bestIdxY = ty;
          }
        }
      }
      if (bestIdxX >= 0) {
        out.x = this.cellCentreX(bestIdxX);
        out.y = this.cellCentreY(bestIdxY);
        return true;
      }
    }
    return false;
  }

  /**
   * Pushes a body out of terrain it has ended up inside, by sampling the
   * clearance gradient. Collision resolution can shove a unit into a wall; this
   * is the correction pass that gets it back out, and it is also the safety net
   * after a teleport.
   */
  resolveTerrain(pos: Vec2, radius: number, iterations = 4): boolean {
    let moved = false;
    const s = this.cellSize * 0.5;
    for (let i = 0; i < iterations; i++) {
      const c = this.clearanceAtWorld(pos.x, pos.y);
      if (c >= radius) break;
      // Central difference of the clearance field gives the direction of
      // steepest escape.
      const gx = this.clearanceAtWorld(pos.x + s, pos.y) - this.clearanceAtWorld(pos.x - s, pos.y);
      const gy = this.clearanceAtWorld(pos.x, pos.y + s) - this.clearanceAtWorld(pos.x, pos.y - s);
      const gl = Math.sqrt(gx * gx + gy * gy);
      if (gl < 1e-6) break;
      const push = Math.min(radius - c, this.cellSize) + 1e-4;
      pos.x += (gx / gl) * push;
      pos.y += (gy / gl) * push;
      moved = true;
    }
    // Hard clamp to the playable rectangle regardless of the field.
    const lo = radius + 1e-3;
    if (pos.x < this.minX + lo) {
      pos.x = this.minX + lo;
      moved = true;
    }
    if (pos.x > this.maxX - lo) {
      pos.x = this.maxX - lo;
      moved = true;
    }
    if (pos.y < this.minY + lo) {
      pos.y = this.minY + lo;
      moved = true;
    }
    if (pos.y > this.maxY - lo) {
      pos.y = this.maxY - lo;
      moved = true;
    }
    return moved;
  }
}
