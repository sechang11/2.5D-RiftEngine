/**
 * Uniform-grid broadphase.
 *
 * Rebuilt from scratch every tick with a counting sort into flat typed arrays.
 * At MOBA scale a full rebuild is cheaper than incremental updates and removes a
 * whole class of bugs where a body's cached cell drifts out of sync with its
 * position after a teleport.
 *
 * Bodies are filed by their centre cell only. Queries widen the search by the
 * largest radius present, so a big body is still found by a small query that
 * merely grazes it.
 */

import type { Vec2 } from '../math/vec2';

export class SpatialHash {
  readonly cellSize: number;
  readonly invCellSize: number;
  readonly cols: number;
  readonly rows: number;
  readonly minX: number;
  readonly minY: number;

  /** Start offset of each cell's slice in `entries`, length cols*rows + 1. */
  private cellStart: Int32Array;
  private cellCount: Int32Array;
  /** Body indices grouped by cell. */
  private entries: Int32Array;
  private bodyCell: Int32Array;

  private count = 0;
  private maxRadius = 0;

  constructor(minX: number, minY: number, width: number, height: number, cellSize: number) {
    this.cellSize = cellSize;
    this.invCellSize = 1 / cellSize;
    this.minX = minX;
    this.minY = minY;
    this.cols = Math.max(1, Math.ceil(width / cellSize));
    this.rows = Math.max(1, Math.ceil(height / cellSize));
    const cells = this.cols * this.rows;
    this.cellStart = new Int32Array(cells + 1);
    this.cellCount = new Int32Array(cells);
    this.entries = new Int32Array(256);
    this.bodyCell = new Int32Array(256);
  }

  private cellIndex(x: number, y: number): number {
    let cx = Math.floor((x - this.minX) * this.invCellSize);
    let cy = Math.floor((y - this.minY) * this.invCellSize);
    if (cx < 0) cx = 0;
    else if (cx >= this.cols) cx = this.cols - 1;
    if (cy < 0) cy = 0;
    else if (cy >= this.rows) cy = this.rows - 1;
    return cy * this.cols + cx;
  }

  private ensureCapacity(n: number): void {
    if (this.entries.length >= n) return;
    let size = this.entries.length;
    while (size < n) size *= 2;
    this.entries = new Int32Array(size);
    this.bodyCell = new Int32Array(size);
  }

  /**
   * Files `count` bodies whose positions and radii are read through the two
   * accessors. Taking accessors rather than an array of objects keeps the hash
   * independent of the entity representation.
   */
  rebuild(count: number, getPos: (i: number) => Vec2, getRadius: (i: number) => number): void {
    this.count = count;
    this.ensureCapacity(count);
    this.cellCount.fill(0);
    this.maxRadius = 0;

    for (let i = 0; i < count; i++) {
      const p = getPos(i);
      const c = this.cellIndex(p.x, p.y);
      this.bodyCell[i] = c;
      this.cellCount[c]++;
      const r = getRadius(i);
      if (r > this.maxRadius) this.maxRadius = r;
    }

    // Prefix sum turns per-cell counts into slice offsets.
    let running = 0;
    for (let c = 0; c < this.cellCount.length; c++) {
      this.cellStart[c] = running;
      running += this.cellCount[c];
    }
    this.cellStart[this.cellCount.length] = running;

    // Second pass fills each slice; cellCount is reused as a write cursor.
    this.cellCount.fill(0);
    for (let i = 0; i < count; i++) {
      const c = this.bodyCell[i];
      this.entries[this.cellStart[c] + this.cellCount[c]++] = i;
    }
  }

  /**
   * Appends every body index whose centre cell could hold something within
   * `radius` of the point. Results are a superset: callers still do the exact
   * distance test. `out` is cleared first.
   */
  query(x: number, y: number, radius: number, out: number[]): number[] {
    out.length = 0;
    if (this.count === 0) return out;

    const reach = radius + this.maxRadius;
    const ring = Math.ceil(reach * this.invCellSize);
    let cx = Math.floor((x - this.minX) * this.invCellSize);
    let cy = Math.floor((y - this.minY) * this.invCellSize);
    const x0 = Math.max(0, cx - ring);
    const x1 = Math.min(this.cols - 1, cx + ring);
    const y0 = Math.max(0, cy - ring);
    const y1 = Math.min(this.rows - 1, cy + ring);

    for (cy = y0; cy <= y1; cy++) {
      const rowBase = cy * this.cols;
      for (cx = x0; cx <= x1; cx++) {
        const c = rowBase + cx;
        const start = this.cellStart[c];
        const end = this.cellStart[c + 1];
        for (let k = start; k < end; k++) out.push(this.entries[k]);
      }
    }
    return out;
  }

  /**
   * Visits candidate pairs once each, for the collision solver. Only pairs where
   * the second body's cell is at or after the first's are emitted, which is what
   * keeps a pair from being resolved twice per iteration.
   */
  forEachPair(visit: (a: number, b: number) => void): void {
    const ring = Math.max(1, Math.ceil((this.maxRadius * 2) * this.invCellSize));
    for (let cy = 0; cy < this.rows; cy++) {
      for (let cx = 0; cx < this.cols; cx++) {
        const c = cy * this.cols + cx;
        const start = this.cellStart[c];
        const end = this.cellStart[c + 1];
        if (start === end) continue;

        // Pairs within this cell.
        for (let i = start; i < end; i++) {
          for (let j = i + 1; j < end; j++) visit(this.entries[i], this.entries[j]);
        }

        // Pairs with forward neighbours only, so each cell pair is seen once.
        for (let ny = cy; ny <= Math.min(this.rows - 1, cy + ring); ny++) {
          const nx0 = ny === cy ? cx + 1 : Math.max(0, cx - ring);
          const nx1 = Math.min(this.cols - 1, cx + ring);
          for (let nx = nx0; nx <= nx1; nx++) {
            const n = ny * this.cols + nx;
            const ns = this.cellStart[n];
            const ne = this.cellStart[n + 1];
            for (let i = start; i < end; i++) {
              for (let k = ns; k < ne; k++) visit(this.entries[i], this.entries[k]);
            }
          }
        }
      }
    }
  }
}
