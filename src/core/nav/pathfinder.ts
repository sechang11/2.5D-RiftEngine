/**
 * Grid A* with clearance filtering and string-pull smoothing.
 *
 * Three details separate this from a textbook A* and all three are things you
 * feel immediately when they are missing:
 *
 *   1. Neighbours are filtered by the clearance field, so a wide unit never
 *      receives a route through a gap it cannot enter.
 *   2. A failed search returns a partial path to whichever explored cell landed
 *      closest to the goal. Right-clicking into a wall should walk you to the
 *      wall, not do nothing.
 *   3. The raw cell path is string-pulled into long straight runs. Grid A*
 *      produces a staircase; a unit that follows it literally wobbles.
 *
 * Scratch buffers are allocated once per Pathfinder and reused, and visited
 * bookkeeping uses a generation counter rather than clearing arrays, so a
 * search over a 90k-cell map costs no allocations.
 */

import type { Vec2 } from '../math/vec2';
import { vec2 } from '../math/vec2';
import type { NavGrid } from './navgrid';

const SQRT2 = Math.SQRT2;

/** Neighbour offsets: four orthogonal first, then four diagonal. */
const NEIGHBOURS: ReadonlyArray<readonly [number, number, number]> = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, SQRT2],
  [1, -1, SQRT2],
  [-1, 1, SQRT2],
  [-1, -1, SQRT2],
];

export interface PathRequest {
  start: Vec2;
  goal: Vec2;
  radius: number;
  /** Abort after this many node expansions and return the best partial route. */
  maxExpansions?: number;
}

export interface PathResult {
  /** Smoothed waypoints in world space. Does not include the start position. */
  waypoints: Vec2[];
  /** False when the goal was unreachable and `waypoints` is a best effort. */
  complete: boolean;
  /** Node expansions performed, for profiling. */
  expanded: number;
}

/** A min-heap of cell indices keyed by an external score array. */
class NodeHeap {
  private items: Int32Array;
  private size = 0;
  private keys: Float32Array;

  constructor(capacity: number, keys: Float32Array) {
    this.items = new Int32Array(Math.max(64, capacity));
    this.keys = keys;
  }

  get length(): number {
    return this.size;
  }

  clear(): void {
    this.size = 0;
  }

  push(node: number): void {
    if (this.size === this.items.length) {
      const grown = new Int32Array(this.items.length * 2);
      grown.set(this.items);
      this.items = grown;
    }
    let i = this.size++;
    this.items[i] = node;
    const key = this.keys[node];
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[this.items[parent]] <= key) break;
      this.items[i] = this.items[parent];
      i = parent;
    }
    this.items[i] = node;
  }

  pop(): number {
    const top = this.items[0];
    const last = this.items[--this.size];
    if (this.size > 0) {
      let i = 0;
      const key = this.keys[last];
      for (;;) {
        const l = i * 2 + 1;
        if (l >= this.size) break;
        const r = l + 1;
        let child = l;
        if (r < this.size && this.keys[this.items[r]] < this.keys[this.items[l]]) child = r;
        if (this.keys[this.items[child]] >= key) break;
        this.items[i] = this.items[child];
        i = child;
      }
      this.items[i] = last;
    }
    return top;
  }
}

export class Pathfinder {
  readonly grid: NavGrid;

  private gScore: Float32Array;
  private fScore: Float32Array;
  private parent: Int32Array;
  private touched: Int32Array;
  private closed: Int32Array;
  private generation = 0;
  private heap: NodeHeap;

  /**
   * Inflating the heuristic trades a little path optimality for a large drop in
   * expansions. At 1.1 the routes are visually indistinguishable from optimal
   * and searches across a large map cost a fraction as much.
   */
  heuristicWeight = 1.1;

  /** Cumulative counters for the performance overlay. */
  readonly stats = { requests: 0, expanded: 0, partials: 0, failures: 0 };

  private scratchGoal = vec2();
  private scratchStart = vec2();
  private rawPath: number[] = [];
  private pulled: Vec2[] = [];

  constructor(grid: NavGrid) {
    this.grid = grid;
    const n = grid.cols * grid.rows;
    this.gScore = new Float32Array(n);
    this.fScore = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.touched = new Int32Array(n);
    this.closed = new Int32Array(n);
    this.heap = new NodeHeap(1024, this.fScore);
  }

  /** Octile distance: exact cost over an 8-connected grid with no obstacles. */
  private heuristic(ax: number, ay: number, bx: number, by: number): number {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return dx < dy ? dx * (SQRT2 - 1) + dy : dy * (SQRT2 - 1) + dx;
  }

  find(req: PathRequest): PathResult {
    const grid = this.grid;
    grid.ensureClearance();
    this.stats.requests++;

    const radius = req.radius;
    const maxExpansions = req.maxExpansions ?? 24000;

    // Snap both ends into space the body actually fits in.
    if (!grid.nearestFit(this.scratchStart, req.start.x, req.start.y, radius)) {
      this.stats.failures++;
      return { waypoints: [], complete: false, expanded: 0 };
    }
    if (!grid.nearestFit(this.scratchGoal, req.goal.x, req.goal.y, radius)) {
      this.stats.failures++;
      return { waypoints: [], complete: false, expanded: 0 };
    }

    const sx = grid.colAt(this.scratchStart.x);
    const sy = grid.rowAt(this.scratchStart.y);
    const gx = grid.colAt(this.scratchGoal.x);
    const gy = grid.rowAt(this.scratchGoal.y);

    // Fast path: if the straight line is already clear there is nothing to search.
    if (grid.lineClear(req.start, this.scratchGoal, radius)) {
      this.stats.expanded += 1;
      return {
        waypoints: [vec2(this.scratchGoal.x, this.scratchGoal.y)],
        complete: true,
        expanded: 1,
      };
    }

    const startIdx = grid.idx(sx, sy);
    const goalIdx = grid.idx(gx, gy);
    const gen = ++this.generation;
    const { gScore, fScore, parent, touched, closed, heap } = this;

    heap.clear();
    gScore[startIdx] = 0;
    fScore[startIdx] = this.heuristic(sx, sy, gx, gy) * this.heuristicWeight;
    parent[startIdx] = -1;
    touched[startIdx] = gen;
    heap.push(startIdx);

    let expanded = 0;
    let bestIdx = startIdx;
    let bestH = this.heuristic(sx, sy, gx, gy);
    let found = false;

    while (heap.length > 0) {
      const current = heap.pop();
      if (closed[current] === gen) continue; // stale duplicate from a lazy decrease-key
      closed[current] = gen;

      if (current === goalIdx) {
        found = true;
        bestIdx = current;
        break;
      }

      if (++expanded > maxExpansions) break;

      const cx = current % grid.cols;
      const cy = (current - cx) / grid.cols;
      const baseG = gScore[current];

      for (let n = 0; n < 8; n++) {
        const [dx, dy, cost] = NEIGHBOURS[n];
        const nx = cx + dx;
        const ny = cy + dy;
        if (!grid.fits(nx, ny, radius)) continue;
        // Never cut a corner: a diagonal step requires both adjacent
        // orthogonal cells to be passable, or the body clips the wall.
        if (dx !== 0 && dy !== 0) {
          if (!grid.fits(cx + dx, cy, radius) || !grid.fits(cx, cy + dy, radius)) continue;
        }
        const nIdx = ny * grid.cols + nx;
        if (closed[nIdx] === gen) continue;
        const tentative = baseG + cost;
        if (touched[nIdx] === gen && tentative >= gScore[nIdx]) continue;

        touched[nIdx] = gen;
        gScore[nIdx] = tentative;
        parent[nIdx] = current;
        const h = this.heuristic(nx, ny, gx, gy);
        fScore[nIdx] = tentative + h * this.heuristicWeight;
        heap.push(nIdx);

        if (h < bestH) {
          bestH = h;
          bestIdx = nIdx;
        }
      }
    }

    this.stats.expanded += expanded;
    if (!found) this.stats.partials++;

    // Walk parents back to the start.
    const raw = this.rawPath;
    raw.length = 0;
    let node = found ? goalIdx : bestIdx;
    while (node !== -1) {
      raw.push(node);
      if (node === startIdx) break;
      node = parent[node];
    }
    raw.reverse();

    const waypoints = this.stringPull(raw, req.start, radius, found ? this.scratchGoal : null);
    return { waypoints, complete: found, expanded };
  }

  /**
   * Collapses a cell path into the fewest straight segments a body of `radius`
   * can actually traverse.
   *
   * Greedy forward scan: from the current anchor, extend while the straight line
   * stays clear and stop at the first failure. Because a grid path hugs
   * obstacles, reachability along it is monotone in practice, so the early break
   * costs nothing in quality and keeps this linear.
   */
  private stringPull(
    cells: number[],
    start: Vec2,
    radius: number,
    exactGoal: Vec2 | null,
  ): Vec2[] {
    const grid = this.grid;
    const out = this.pulled;
    out.length = 0;
    if (cells.length === 0) return [];

    // Candidate points in world space, with the precise goal replacing the last
    // cell centre so the unit stops where the player clicked.
    const pts: Vec2[] = [];
    for (let i = 1; i < cells.length; i++) {
      const c = cells[i];
      const cx = c % grid.cols;
      const cy = (c - cx) / grid.cols;
      pts.push(vec2(grid.cellCentreX(cx), grid.cellCentreY(cy)));
    }
    if (exactGoal) {
      if (pts.length > 0) pts.pop();
      pts.push(vec2(exactGoal.x, exactGoal.y));
    }
    if (pts.length === 0) return [];

    let anchor = start;
    let i = 0;
    while (i < pts.length) {
      let furthest = i;
      for (let j = i; j < pts.length; j++) {
        if (grid.lineClear(anchor, pts[j], radius)) furthest = j;
        else break;
      }
      // Nothing visible from the anchor: keep the next cell so progress is made.
      if (furthest === i && !grid.lineClear(anchor, pts[i], radius)) {
        out.push(pts[i]);
        anchor = pts[i];
        i++;
        continue;
      }
      out.push(pts[furthest]);
      anchor = pts[furthest];
      i = furthest + 1;
    }

    return out.map((p) => vec2(p.x, p.y));
  }
}
