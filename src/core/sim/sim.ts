/**
 * The simulation clock and the tick pipeline.
 *
 * The simulation runs at a fixed rate and the renderer runs at display rate.
 * They are decoupled by an accumulator: real elapsed time is banked, whole ticks
 * are consumed from it, and whatever is left over becomes `alpha`, the fraction
 * the view interpolates between the previous and current position.
 *
 * A fixed step is not a stylistic choice here. Collision resolution, cooldowns,
 * windups and pathing all behave differently under variable dt, which means a
 * player on a 144 Hz monitor would get a measurably different game from one on
 * 60 Hz. Fixing the step also makes replays and, later, lockstep networking
 * possible at all.
 *
 * System order within a tick is load-bearing and documented inline. The rule of
 * thumb: decide, then move, then resolve, then react.
 */

import { World } from '../ecs/world';
import type { NavGrid } from '../nav/navgrid';
import { FogOfWar } from '../vision/fog';
import { CommandQueue, CommandType, type Command } from './commands';
import { OrderKind } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { updateOrders, issueOrder } from './orders';
import { updateLocomotion } from './locomotion';
import { updateBrains, alertBrain } from '../ai/brain';
import { resolveCollisions, type CollisionStats } from '../physics/collision';
import { updateAttacks } from '../combat/autoattack';
import { updateProjectiles, updateEffects } from './projectiles';
import { updateStatuses } from '../status/statuses';
import { updateCasts, updateCooldowns, tryCast, refreshAbilities } from '../abilities/casting';
import { updateDeaths, updateRegeneration } from './lifecycle';
import { vec2 } from '../math/vec2';

export interface SimOptions {
  /** Simulation ticks per second. */
  tickRate?: number;
  seed?: number;
  /** Solver iterations for unit separation. */
  collisionIterations?: number;
  /** Ticks between fog recomputations. */
  fogInterval?: number;
}

export interface SimProfile {
  /** Milliseconds spent in the last batch of ticks. */
  simMs: number;
  ticksLastFrame: number;
  collision: CollisionStats;
  units: number;
  projectiles: number;
  /** Pathfinder node expansions since the last reset. */
  pathExpansions: number;
  pathRequests: number;
}

/** Ticks are dropped rather than simulated after this many in one frame. */
const MAX_CATCHUP_TICKS = 5;

const castPoint = vec2();

export class Sim {
  readonly world: World;
  readonly fog: FogOfWar;
  readonly commands = new CommandQueue();

  readonly tickRate: number;
  /** Seconds per tick. */
  readonly dt: number;

  /** Interpolation factor in [0,1) for the renderer. */
  alpha = 0;
  paused = false;
  /** Multiplies elapsed time. Useful for slow-motion debugging. */
  timeScale = 1;

  readonly profile: SimProfile = {
    simMs: 0,
    ticksLastFrame: 0,
    collision: { pairsTested: 0, pairsResolved: 0, terrainCorrections: 0 },
    units: 0,
    projectiles: 0,
    pathExpansions: 0,
    pathRequests: 0,
  };

  private accumulator = 0;
  private readonly collisionIterations: number;
  private readonly fogInterval: number;
  private eventCursor = 0;

  constructor(nav: NavGrid, opts: SimOptions = {}) {
    this.tickRate = opts.tickRate ?? 60;
    this.dt = 1 / this.tickRate;
    // Four is measured, not guessed: see tools/bench.ts. Going from three to
    // four halves the worst residual overlap for about a tenth of a
    // millisecond, and past four the curve flattens out.
    this.collisionIterations = opts.collisionIterations ?? 4;
    this.fogInterval = opts.fogInterval ?? 4;
    this.world = new World(nav, opts.seed ?? 20260909);
    this.fog = new FogOfWar(nav, 2);
    nav.ensureClearance();
  }

  /**
   * Banks real elapsed time and runs whole ticks.
   *
   * The catch-up clamp prevents the death spiral where a slow frame schedules
   * many ticks, which makes the next frame slower still. Past the clamp the
   * simulation simply runs slower than wall-clock, which is survivable; the
   * alternative is a hang.
   */
  advance(realDtSeconds: number): void {
    if (this.paused) {
      this.alpha = 1;
      return;
    }

    const scaled = Math.min(realDtSeconds, 0.25) * this.timeScale;
    this.accumulator += scaled;

    const started = performance.now();
    let ticks = 0;
    while (this.accumulator >= this.dt && ticks < MAX_CATCHUP_TICKS) {
      this.step();
      this.accumulator -= this.dt;
      ticks++;
    }
    if (ticks === MAX_CATCHUP_TICKS) this.accumulator = 0;

    this.profile.simMs = performance.now() - started;
    this.profile.ticksLastFrame = ticks;
    this.alpha = this.accumulator / this.dt;
  }

  /** Runs exactly one tick. Public so tests and replays can drive it directly. */
  step(): void {
    const world = this.world;
    const dt = this.dt;
    world.tick++;
    world.time += dt;
    this.eventCursor = world.events.pending.length;

    // 1. Player and network input becomes orders. Nothing else may issue orders
    //    from outside the sim.
    this.commands.drain((cmd) => this.applyCommand(cmd));

    // 2. Snapshot positions for render interpolation before anything moves.
    const units = world.units;
    for (let i = 0; i < units.length; i++) {
      units[i].prevPos.x = units[i].pos.x;
      units[i].prevPos.y = units[i].pos.y;
    }

    // 3. Timers first, so an ability that came off cooldown is usable this tick
    //    and a slow that expired no longer applies to this tick's movement.
    updateCooldowns(world, dt);
    updateStatuses(world, dt);

    // 4. Index before any spatial query. Everything below assumes it is current.
    world.refreshIndex();

    // 5. Decide. AI and orders both only express intent; neither moves anything.
    updateBrains(world, dt);
    updateOrders(world, dt);

    // 6. Casts advance after orders so a cast started this tick winds up from
    //    this tick, not the next.
    updateCasts(world, dt);

    // 7. Move.
    updateLocomotion(world, dt);

    // 8. Re-index, then push overlapping bodies apart and out of terrain.
    world.refreshIndex();
    resolveCollisions(world, this.collisionIterations, this.profile.collision);

    // 9. React. Attacks and projectiles resolve against post-movement positions,
    //    so a unit that walked out of range this tick is genuinely out of range.
    updateAttacks(world, dt);
    updateProjectiles(world, dt);
    updateEffects(world, dt);

    // 10. Bookkeeping.
    updateRegeneration(world, dt);
    this.reactToDamage();
    updateDeaths(world, dt);

    if (world.tick % this.fogInterval === 0) this.fog.update(world.units);

    world.reapTransients();

    this.profile.units = world.units.length;
    this.profile.projectiles = world.projectiles.length;
    this.profile.pathExpansions = world.pathfinder.stats.expanded;
    this.profile.pathRequests = world.pathfinder.stats.requests;
  }

  /**
   * Lets AI react to damage without the damage pipeline knowing AI exists.
   *
   * Scanning this tick's events is a deliberate seam: any system can respond to
   * anything that happened, and none of them need a reference to each other.
   */
  private reactToDamage(): void {
    const events = this.world.events.pending;
    for (let i = this.eventCursor; i < events.length; i++) {
      const e = events[i];
      if (e.type !== SimEventType.Damage) continue;
      const victim = this.world.get(e.target);
      const attacker = this.world.get(e.source);
      if (victim && attacker && victim.brain) alertBrain(victim, attacker);
    }
  }

  private applyCommand(cmd: Command): void {
    const world = this.world;
    const unit = world.get(cmd.unit);
    if (!unit || !unit.alive || unit.hp <= 0) return;

    switch (cmd.type) {
      case CommandType.Move:
        castPoint.x = cmd.x;
        castPoint.y = cmd.y;
        issueOrder(world, unit, OrderKind.MoveTo, castPoint);
        break;
      case CommandType.AttackMove:
        castPoint.x = cmd.x;
        castPoint.y = cmd.y;
        issueOrder(world, unit, OrderKind.AttackMove, castPoint);
        break;
      case CommandType.AttackUnit:
        issueOrder(world, unit, OrderKind.AttackUnit, undefined, cmd.target);
        break;
      case CommandType.Stop:
        issueOrder(world, unit, OrderKind.Stop);
        break;
      case CommandType.HoldPosition:
        issueOrder(world, unit, OrderKind.HoldPosition);
        break;
      case CommandType.Cast:
        castPoint.x = cmd.x;
        castPoint.y = cmd.y;
        tryCast(world, unit, cmd.slot, castPoint, cmd.target);
        break;
      case CommandType.DebugRefresh:
        refreshAbilities(unit);
        break;
    }
  }

  /** Resets cumulative profiling counters. The HUD calls this once a second. */
  resetCounters(): void {
    const s = this.world.pathfinder.stats;
    s.expanded = 0;
    s.requests = 0;
    s.partials = 0;
    s.failures = 0;
  }
}
