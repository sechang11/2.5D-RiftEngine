/**
 * Props: everything on the map that is not a unit.
 *
 * The engine's original entity model had exactly one kind of thing in it, a
 * Unit, with health and orders and an ability bar. That is enough to build a
 * battle and not enough to build a world. A tree is not a unit. Neither is a
 * tavern, a dropped sword, a barrel, or a door.
 *
 * A prop is deliberately much smaller than a unit: a transform, an asset to
 * draw, and a few flags describing how the world should treat it. The two that
 * matter are `blocks`, which stamps the navigation grid, and `item`, which
 * makes it something a champion can walk over and pick up.
 *
 * Terrain editing at runtime falls out of this. Because props stamp the nav
 * grid rather than owning it, the store keeps a pristine copy of the map's own
 * terrain and recomputes `base | props` whenever a blocking prop is added or
 * moved. Placing a wall of crates in the editor closes a lane for pathfinding
 * immediately, and deleting them reopens it.
 */

import { CellFlag, type NavGrid } from '../nav/navgrid';

export type PropId = number;

export const enum PropFlag {
  None = 0,
  /** Stamps the navigation grid; units path around it. */
  Blocks = 1 << 0,
  /** Blocks line of sight as well as movement. */
  Opaque = 1 << 1,
  /** Can be walked over and collected. */
  Pickup = 1 << 2,
  /** Highlighted and reported when a champion is near. */
  Interactive = 1 << 3,
}

export interface Prop {
  id: PropId;
  assetId: string;
  category: string;
  /** Position on the simulation plane. */
  x: number;
  y: number;
  /** Yaw in radians. Props have no pitch or roll; the world is 2.5D. */
  rotation: number;
  scale: number;
  flags: PropFlag;
  /** Footprint radius at scale 1, from the asset manifest. */
  radius: number;
  /** Item granted when picked up, or null. */
  item: string | null;
  /** Free-form authoring data, carried through save and load. */
  data: Record<string, string | number>;
}

export interface PropSpec {
  assetId: string;
  category?: string;
  x: number;
  y: number;
  rotation?: number;
  scale?: number;
  flags?: PropFlag;
  radius?: number;
  item?: string | null;
  data?: Record<string, string | number>;
}

export class PropStore {
  readonly props: Prop[] = [];
  private byId = new Map<PropId, Prop>();
  private nextId: PropId = 1;

  private readonly nav: NavGrid;
  /** The map's own terrain, before any prop stamped it. */
  private readonly baseFlags: Uint8Array;
  private navDirty = false;

  /** Bumped whenever the set or transform of props changes, so views can diff. */
  revision = 0;

  constructor(nav: NavGrid) {
    this.nav = nav;
    this.baseFlags = new Uint8Array(nav.flags);
  }

  add(spec: PropSpec): Prop {
    const prop: Prop = {
      id: this.nextId++,
      assetId: spec.assetId,
      category: spec.category ?? 'prop',
      x: spec.x,
      y: spec.y,
      rotation: spec.rotation ?? 0,
      scale: spec.scale ?? 1,
      flags: spec.flags ?? PropFlag.None,
      radius: spec.radius ?? 0.5,
      item: spec.item ?? null,
      data: spec.data ? { ...spec.data } : {},
    };
    this.props.push(prop);
    this.byId.set(prop.id, prop);
    if (prop.flags & PropFlag.Blocks) this.navDirty = true;
    this.revision++;
    return prop;
  }

  get(id: PropId): Prop | undefined {
    return this.byId.get(id);
  }

  remove(id: PropId): boolean {
    const prop = this.byId.get(id);
    if (!prop) return false;
    const i = this.props.indexOf(prop);
    if (i >= 0) {
      this.props[i] = this.props[this.props.length - 1];
      this.props.pop();
    }
    this.byId.delete(id);
    if (prop.flags & PropFlag.Blocks) this.navDirty = true;
    this.revision++;
    return true;
  }

  clear(): void {
    this.props.length = 0;
    this.byId.clear();
    this.nextId = 1;
    this.navDirty = true;
    this.revision++;
  }

  /** Call after mutating a prop's transform or flags directly. */
  touch(prop: Prop, navAffecting = true): void {
    if (navAffecting && prop.flags & PropFlag.Blocks) this.navDirty = true;
    this.revision++;
  }

  /** Marks the navigation grid stale even when nothing obvious changed. */
  invalidateNav(): void {
    this.navDirty = true;
  }

  /**
   * Rebuilds terrain from the base map plus every blocking prop.
   *
   * Recomputing from a pristine copy rather than un-stamping is what makes
   * editing reversible. Un-stamping cannot know whether a cell was blocked by
   * the map, by this prop, or by an overlapping one, and gets it wrong the
   * first time two props touch.
   */
  rebuildNav(force = false): boolean {
    if (!this.navDirty && !force) return false;
    this.navDirty = false;

    this.nav.flags.set(this.baseFlags);
    for (const prop of this.props) {
      if (!(prop.flags & PropFlag.Blocks)) continue;
      const r = Math.max(0.2, prop.radius * prop.scale);
      let mask: CellFlag = CellFlag.BlockMove;
      if (prop.flags & PropFlag.Opaque) mask |= CellFlag.BlockVision;
      this.nav.fillCircle(prop.x, prop.y, r, mask);
    }
    this.nav.rebuildClearance();
    return true;
  }

  /** Nearest prop within `range` passing the filter, for interaction prompts. */
  nearest(x: number, y: number, range: number, filter?: (p: Prop) => boolean): Prop | null {
    let best: Prop | null = null;
    let bestD2 = range * range;
    for (const prop of this.props) {
      if (filter && !filter(prop)) continue;
      const dx = prop.x - x;
      const dy = prop.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= bestD2) {
        bestD2 = d2;
        best = prop;
      }
    }
    return best;
  }

  /** Every prop whose footprint overlaps the circle. */
  query(x: number, y: number, range: number, out: Prop[]): Prop[] {
    out.length = 0;
    for (const prop of this.props) {
      const reach = range + prop.radius * prop.scale;
      const dx = prop.x - x;
      const dy = prop.y - y;
      if (dx * dx + dy * dy <= reach * reach) out.push(prop);
    }
    return out;
  }

  /** Topmost prop under a world point, for editor picking. */
  pick(x: number, y: number, slack = 0.4): Prop | null {
    let best: Prop | null = null;
    let bestD2 = Infinity;
    for (const prop of this.props) {
      const r = prop.radius * prop.scale + slack;
      const dx = prop.x - x;
      const dy = prop.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r * r && d2 < bestD2) {
        bestD2 = d2;
        best = prop;
      }
    }
    return best;
  }
}
