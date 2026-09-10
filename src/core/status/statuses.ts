/**
 * Buffs, debuffs and crowd control.
 *
 * Statuses are the only thing allowed to change a unit's effective stats, and
 * they do it declaratively: they declare what they are, and `recomputeStats`
 * rebuilds the stat block from base every time the set changes. Nothing here
 * ever adds or subtracts from a live stat, which is what stops movement speed
 * from drifting after a few hundred slows.
 */

import type { World } from '../ecs/world';
import type { StatusInstance, Unit } from '../ecs/types';
import { DamageType, StatusKind } from '../ecs/types';
import { SimEventType } from '../events/bus';
import { applyDamage, applyTenacity, heal, recomputeStats } from '../combat/stats';
import { cancelCast } from '../abilities/casting';
import { clearPath } from '../sim/locomotion';

export interface StatusSpec {
  kind: StatusKind;
  duration: number;
  magnitude: number;
  source: number;
  /** Stacking key. A reapplication with the same tag refreshes instead of adding. */
  tag: string;
  /** When true, a reapplication adds another independent instance. */
  stacks?: boolean;
  /** Seconds between ticks for periodic kinds. */
  period?: number;
  /** Crowd control respects tenacity; buffs do not. */
  reducedByTenacity?: boolean;
}

const CROWD_CONTROL = new Set([StatusKind.Stun, StatusKind.Root, StatusKind.Silence]);

export function applyStatus(world: World, target: Unit, spec: StatusSpec): StatusInstance | null {
  if (!target.alive || target.hp <= 0) return null;

  let duration = spec.duration;
  if (spec.reducedByTenacity ?? CROWD_CONTROL.has(spec.kind)) {
    duration = applyTenacity(target, duration);
    if (duration <= 0.02) return null; // fully resisted
  }

  if (!spec.stacks) {
    for (let i = 0; i < target.statuses.length; i++) {
      const existing = target.statuses[i];
      if (existing.tag !== spec.tag) continue;
      // Refresh: take the longer remaining time and the stronger magnitude, so a
      // weak reapplication never overwrites a strong one.
      existing.remaining = Math.max(existing.remaining, duration);
      existing.magnitude =
        spec.kind === StatusKind.Shield
          ? Math.max(existing.magnitude, spec.magnitude)
          : Math.max(existing.magnitude, spec.magnitude);
      existing.source = spec.source;
      recomputeStats(target);
      return existing;
    }
  }

  const status: StatusInstance = {
    kind: spec.kind,
    remaining: duration,
    magnitude: spec.magnitude,
    source: spec.source,
    tag: spec.tag,
    tickTimer: spec.period ?? 0.5,
  };
  target.statuses.push(status);

  // Hard CC drops the current action immediately rather than waiting a tick.
  if (spec.kind === StatusKind.Stun) {
    cancelCast(world, target, 'stunned');
    clearPath(target);
    target.attack.windup = -1;
  } else if (spec.kind === StatusKind.Root) {
    clearPath(target);
  }

  recomputeStats(target);
  world.events.push(SimEventType.StatusApplied, world.tick, {
    source: spec.source,
    target: target.id,
    x: target.pos.x,
    y: target.pos.y,
    amount: duration,
    tag: spec.tag,
  });
  return status;
}

export function removeStatusByTag(unit: Unit, tag: string): void {
  let changed = false;
  for (let i = unit.statuses.length - 1; i >= 0; i--) {
    if (unit.statuses[i].tag === tag) {
      unit.statuses.splice(i, 1);
      changed = true;
    }
  }
  if (changed) recomputeStats(unit);
}

/** Strips all crowd control. Used by cleanse effects and on respawn. */
export function clearCrowdControl(unit: Unit): void {
  let changed = false;
  for (let i = unit.statuses.length - 1; i >= 0; i--) {
    if (CROWD_CONTROL.has(unit.statuses[i].kind)) {
      unit.statuses.splice(i, 1);
      changed = true;
    }
  }
  if (changed) recomputeStats(unit);
}

/**
 * Expires statuses and runs periodic effects.
 *
 * Stats are only recomputed for units whose status set actually changed this
 * tick, since recomputation is the expensive part and most units are unaffected
 * most of the time.
 */
export function updateStatuses(world: World, dt: number): void {
  const units = world.units;
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    const list = unit.statuses;
    if (list.length === 0) continue;

    let dirty = false;

    for (let s = list.length - 1; s >= 0; s--) {
      const st = list[s];

      if (st.kind === StatusKind.Burn || st.kind === StatusKind.Regeneration) {
        st.tickTimer -= dt;
        if (st.tickTimer <= 0) {
          st.tickTimer += 0.5;
          if (st.kind === StatusKind.Burn) {
            const src = world.get(st.source);
            const res = applyDamage(unit, {
              amount: st.magnitude * 0.5,
              type: DamageType.True,
              source: src,
              tag: st.tag,
            });
            if (res.dealt > 0) {
              world.events.push(SimEventType.Damage, world.tick, {
                source: st.source,
                target: unit.id,
                x: unit.pos.x,
                y: unit.pos.y,
                amount: res.dealt,
                damageType: DamageType.True,
                tag: st.tag,
              });
            }
          } else {
            const amount = heal(unit, st.magnitude * 0.5);
            if (amount > 0) {
              world.events.push(SimEventType.Heal, world.tick, {
                source: st.source,
                target: unit.id,
                x: unit.pos.x,
                y: unit.pos.y,
                amount,
                tag: st.tag,
              });
            }
          }
        }
      }

      if (st.remaining < 0) continue; // permanent until removed
      st.remaining -= dt;
      if (st.remaining <= 0) {
        list.splice(s, 1);
        dirty = true;
      }
    }

    if (dirty) recomputeStats(unit);
  }
}

/** Total remaining shield across every shield status. */
export function shieldAmount(unit: Unit): number {
  let total = 0;
  for (let i = 0; i < unit.statuses.length; i++) {
    if (unit.statuses[i].kind === StatusKind.Shield) total += unit.statuses[i].magnitude;
  }
  return total;
}

/** Longest remaining duration of a given kind, for HUD timers. */
export function statusRemaining(unit: Unit, kind: StatusKind): number {
  let best = 0;
  for (let i = 0; i < unit.statuses.length; i++) {
    const st = unit.statuses[i];
    if (st.kind === kind && st.remaining > best) best = st.remaining;
  }
  return best;
}
