/**
 * The world: entity storage, spatial indexing and the queries every system
 * builds on.
 *
 * Units live in a dense array so iteration is cache-friendly, plus a sparse
 * slot table that maps a generation-tagged handle back to the dense index.
 * Removal is a swap-with-last, which is O(1) and keeps the dense array packed.
 */

import type { NavGrid } from '../nav/navgrid';
import { Pathfinder } from '../nav/pathfinder';
import { SpatialHash } from '../physics/spatialhash';
import { EventBus } from '../events/bus';
import { Rng } from '../math/rng';
import type { Vec2 } from '../math/vec2';
import { vec2, distSq } from '../math/vec2';
import type { BaseStats, EntityId, Unit } from './types';
import {
  createOrder,
  defaultBaseStats,
  idGeneration,
  idIndex,
  makeId,
  NO_ENTITY,
  OPPOSING,
  Team,
  UnitFlag,
  UnitKind,
} from './types';
import { copyStats } from '../combat/stats';

export interface Projectile {
  alive: boolean;
  owner: EntityId;
  team: Team;
  pos: Vec2;
  prevPos: Vec2;
  dir: Vec2;
  speed: number;
  radius: number;
  travelled: number;
  maxRange: number;
  /** Non-zero for homing projectiles, which steer towards this unit. */
  target: EntityId;
  /** Ability definition consulted when it connects. */
  defId: string;
  /** Remaining units it may hit before expiring. 1 for a single-target bolt. */
  pierce: number;
  hitList: EntityId[];
  /** Visual key for the renderer. */
  visual: string;
  /** Scales the ability's damage, for abilities with falloff. */
  power: number;
  /** True when it should stop at terrain rather than fly over it. */
  collidesTerrain: boolean;
}

/** A delayed effect: ground telegraph now, damage later. */
export interface PendingEffect {
  alive: boolean;
  defId: string;
  owner: EntityId;
  team: Team;
  pos: Vec2;
  radius: number;
  delay: number;
  elapsed: number;
  power: number;
  visual: string;
}

export interface SpawnSpec {
  archetype: string;
  name?: string;
  kind: UnitKind;
  team: Team;
  pos: Vec2;
  base: BaseStats;
  radius?: number;
  mass?: number;
  flags?: UnitFlag;
  abilities?: string[];
  facing?: number;
}

const DEFAULT_FLAGS = UnitFlag.Collides | UnitFlag.Targetable | UnitFlag.RevealsFog;

export class World {
  readonly nav: NavGrid;
  readonly pathfinder: Pathfinder;
  readonly hash: SpatialHash;
  readonly events = new EventBus();
  readonly rng: Rng;

  /** Dense, packed, live units. Iterate this. */
  readonly units: Unit[] = [];
  readonly projectiles: Projectile[] = [];
  readonly effects: PendingEffect[] = [];

  /** Sparse slot table: index -> dense position, or -1 when free. */
  private slotToDense: Int32Array;
  private slotGeneration: Uint16Array;
  private freeSlots: number[] = [];
  private nextSlot = 1; // slot 0 is reserved so NO_ENTITY is never valid

  tick = 0;
  /** Seconds of simulated time elapsed. */
  time = 0;

  private projectilePool: Projectile[] = [];
  private effectPool: PendingEffect[] = [];
  private queryScratch: number[] = [];

  constructor(nav: NavGrid, seed = 1337, capacity = 4096) {
    this.nav = nav;
    this.pathfinder = new Pathfinder(nav);
    this.rng = new Rng(seed);
    this.slotToDense = new Int32Array(capacity).fill(-1);
    this.slotGeneration = new Uint16Array(capacity);
    // Cell size must be at least twice the largest body radius for the
    // centre-cell filing scheme to stay correct with a 3x3 neighbourhood.
    this.hash = new SpatialHash(nav.minX, nav.minY, nav.width, nav.height, 4);
  }

  // --- lifecycle ------------------------------------------------------------

  spawn(spec: SpawnSpec): Unit {
    const slot = this.freeSlots.pop() ?? this.nextSlot++;
    if (slot >= this.slotToDense.length) this.growSlots();
    const generation = this.slotGeneration[slot] || 1;
    this.slotGeneration[slot] = generation;
    const id = makeId(slot, generation);

    const base = { ...spec.base };
    const unit: Unit = {
      id,
      alive: true,
      kind: spec.kind,
      team: spec.team,
      name: spec.name ?? spec.archetype,
      archetype: spec.archetype,
      pos: vec2(spec.pos.x, spec.pos.y),
      prevPos: vec2(spec.pos.x, spec.pos.y),
      vel: vec2(),
      facing: spec.facing ?? 0,
      radius: spec.radius ?? 0.65,
      mass: spec.mass ?? 1,
      flags: spec.flags ?? DEFAULT_FLAGS,
      base,
      stats: { ...base },
      hp: base.hpMax,
      mp: base.mpMax,
      order: createOrder(),
      path: [],
      pathCursor: 0,
      repathTimer: 0,
      blockedTicks: 0,
      attack: { cooldown: 0, windup: -1, target: NO_ENTITY },
      abilities: (spec.abilities ?? []).map((defId) => ({
        defId,
        cooldown: 0,
        rank: 1,
        charges: 1,
      })),
      statuses: [],
      modifiers: [],
      equipment: {},
      cast: null,
      dash: null,
      brain: null,
      respawnTimer: -1,
      visibleTo: 0,
      userData: {},
    };
    copyStats(unit.stats, base);

    this.slotToDense[slot] = this.units.length;
    this.units.push(unit);
    return unit;
  }

  private growSlots(): void {
    const size = this.slotToDense.length * 2;
    const dense = new Int32Array(size).fill(-1);
    dense.set(this.slotToDense);
    const gens = new Uint16Array(size);
    gens.set(this.slotGeneration);
    this.slotToDense = dense;
    this.slotGeneration = gens;
  }

  /**
   * Removes a unit immediately. Bumping the generation is what invalidates every
   * outstanding handle, so a projectile in flight towards this unit resolves to
   * null instead of striking whoever later occupies the slot.
   */
  despawn(id: EntityId): void {
    const dense = this.denseIndex(id);
    if (dense < 0) return;
    const slot = idIndex(id);

    const last = this.units.length - 1;
    if (dense !== last) {
      const moved = this.units[last];
      this.units[dense] = moved;
      this.slotToDense[idIndex(moved.id)] = dense;
    }
    this.units.pop();

    this.slotToDense[slot] = -1;
    this.slotGeneration[slot] = (this.slotGeneration[slot] + 1) & 0xffff || 1;
    this.freeSlots.push(slot);
  }

  private denseIndex(id: EntityId): number {
    if (id === NO_ENTITY) return -1;
    const slot = idIndex(id);
    if (slot <= 0 || slot >= this.slotToDense.length) return -1;
    if (this.slotGeneration[slot] !== idGeneration(id)) return -1;
    return this.slotToDense[slot];
  }

  /** Resolves a handle, or null when the referent is gone. */
  get(id: EntityId): Unit | null {
    const dense = this.denseIndex(id);
    return dense < 0 ? null : this.units[dense];
  }

  /** Resolves a handle only if the unit is alive and still targetable. */
  getTargetable(id: EntityId): Unit | null {
    const u = this.get(id);
    if (!u || !u.alive || u.hp <= 0) return null;
    if (!(u.flags & UnitFlag.Targetable)) return null;
    return u;
  }

  exists(id: EntityId): boolean {
    return this.denseIndex(id) >= 0;
  }

  // --- relationships --------------------------------------------------------

  isEnemy(a: Unit, b: Unit): boolean {
    if (a.team === Team.Neutral || b.team === Team.Neutral) return a.team !== b.team;
    return OPPOSING[a.team] === b.team;
  }

  isAlly(a: Unit, b: Unit): boolean {
    return a.team === b.team && a.id !== b.id;
  }

  // --- spatial queries ------------------------------------------------------

  /** Rebuilds the broadphase. Called once per tick before any spatial query. */
  refreshIndex(): void {
    const units = this.units;
    this.hash.rebuild(
      units.length,
      (i) => units[i].pos,
      (i) => units[i].radius,
    );
  }

  /**
   * Units whose bodies overlap the circle. `out` is reused by the caller to stay
   * allocation-free in hot paths.
   */
  queryCircle(
    x: number,
    y: number,
    radius: number,
    out: Unit[],
    filter?: (u: Unit) => boolean,
  ): Unit[] {
    out.length = 0;
    const cands = this.hash.query(x, y, radius, this.queryScratch);
    for (let i = 0; i < cands.length; i++) {
      const u = this.units[cands[i]];
      if (!u.alive || u.hp <= 0) continue;
      const dx = u.pos.x - x;
      const dy = u.pos.y - y;
      const r = radius + u.radius;
      if (dx * dx + dy * dy > r * r) continue;
      if (filter && !filter(u)) continue;
      out.push(u);
    }
    return out;
  }

  /**
   * Closest unit passing the filter within range, measured edge-to-edge the way
   * targeting works in League: a large body is in range when its hitbox is,
   * not when its centre is.
   */
  nearest(
    from: Vec2,
    range: number,
    filter: (u: Unit) => boolean,
    exclude: EntityId = NO_ENTITY,
  ): Unit | null {
    const cands = this.hash.query(from.x, from.y, range, this.queryScratch);
    let best: Unit | null = null;
    let bestD2 = Infinity;
    for (let i = 0; i < cands.length; i++) {
      const u = this.units[cands[i]];
      if (u.id === exclude || !u.alive || u.hp <= 0) continue;
      const reach = range + u.radius;
      const d2 = distSq(from, u.pos);
      if (d2 > reach * reach) continue;
      if (!filter(u)) continue;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = u;
      }
    }
    return best;
  }

  nearestEnemy(unit: Unit, range: number): Unit | null {
    return this.nearest(
      unit.pos,
      range,
      (u) => this.isEnemy(unit, u) && (u.flags & UnitFlag.Targetable) !== 0,
      unit.id,
    );
  }

  /** Edge-to-edge distance between two bodies. Negative when overlapping. */
  gap(a: Unit, b: Unit): number {
    return Math.sqrt(distSq(a.pos, b.pos)) - a.radius - b.radius;
  }

  inAttackRange(attacker: Unit, target: Unit): boolean {
    return this.gap(attacker, target) <= attacker.stats.attackRange;
  }

  // --- projectiles and delayed effects --------------------------------------

  spawnProjectile(p: Omit<Projectile, 'alive' | 'prevPos' | 'travelled' | 'hitList'>): Projectile {
    const proj = this.projectilePool.pop() ?? ({ hitList: [] } as unknown as Projectile);
    proj.alive = true;
    proj.owner = p.owner;
    proj.team = p.team;
    proj.pos = vec2(p.pos.x, p.pos.y);
    proj.prevPos = vec2(p.pos.x, p.pos.y);
    proj.dir = vec2(p.dir.x, p.dir.y);
    proj.speed = p.speed;
    proj.radius = p.radius;
    proj.travelled = 0;
    proj.maxRange = p.maxRange;
    proj.target = p.target;
    proj.defId = p.defId;
    proj.pierce = p.pierce;
    proj.hitList.length = 0;
    proj.visual = p.visual;
    proj.power = p.power;
    proj.collidesTerrain = p.collidesTerrain;
    this.projectiles.push(proj);
    return proj;
  }

  spawnEffect(e: Omit<PendingEffect, 'alive' | 'elapsed'>): PendingEffect {
    const fx = this.effectPool.pop() ?? ({} as PendingEffect);
    fx.alive = true;
    fx.defId = e.defId;
    fx.owner = e.owner;
    fx.team = e.team;
    fx.pos = vec2(e.pos.x, e.pos.y);
    fx.radius = e.radius;
    fx.delay = e.delay;
    fx.elapsed = 0;
    fx.power = e.power;
    fx.visual = e.visual;
    this.effects.push(fx);
    return fx;
  }

  /** Compacts the projectile and effect lists, recycling dead entries. */
  reapTransients(): void {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      if (!this.projectiles[i].alive) {
        this.projectilePool.push(this.projectiles[i]);
        this.projectiles[i] = this.projectiles[this.projectiles.length - 1];
        this.projectiles.pop();
      }
    }
    for (let i = this.effects.length - 1; i >= 0; i--) {
      if (!this.effects[i].alive) {
        this.effectPool.push(this.effects[i]);
        this.effects[i] = this.effects[this.effects.length - 1];
        this.effects.pop();
      }
    }
  }

  /** Convenience for content code that wants sensible defaults. */
  static baseStats(overrides: Partial<BaseStats> = {}): BaseStats {
    return { ...defaultBaseStats(), ...overrides };
  }
}
