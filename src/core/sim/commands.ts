/**
 * Commands: the only way input enters the simulation.
 *
 * Nothing outside the sim calls `issueOrder` or `tryCast` directly. Input
 * produces commands, the sim drains them at the top of a tick, and that single
 * choke point buys three things at once:
 *
 *   - replays, by recording the command stream and the seed
 *   - deterministic lockstep networking later, by exchanging commands per tick
 *     instead of synchronising state
 *   - input that cannot corrupt a tick in progress
 *
 * Commands are flat structs of numbers and short strings so they serialize
 * without ceremony.
 */

import type { EntityId } from '../ecs/types';

export const enum CommandType {
  Move = 0,
  AttackMove = 1,
  AttackUnit = 2,
  Stop = 3,
  HoldPosition = 4,
  Cast = 5,
  /** Sandbox only: wipe cooldowns on a unit. */
  DebugRefresh = 6,
}

export interface Command {
  type: CommandType;
  /** The unit being ordered. */
  unit: EntityId;
  x: number;
  y: number;
  /** Unit target for attack and unit-targeted casts. */
  target: EntityId;
  /** Ability slot index for Cast. */
  slot: number;
}

export function makeCommand(
  type: CommandType,
  unit: EntityId,
  x = 0,
  y = 0,
  target: EntityId = 0,
  slot = 0,
): Command {
  return { type, unit, x, y, target, slot };
}

/**
 * A fixed-size ring of commands awaiting execution.
 *
 * A ring rather than a growable array because the queue is drained every tick:
 * if it ever fills, the correct response is to drop the oldest input and keep
 * the simulation running, not to allocate without bound.
 */
export class CommandQueue {
  private buffer: Command[] = [];
  private head = 0;
  private tail = 0;
  private readonly capacity: number;
  /** Commands dropped because the queue was full, for diagnostics. */
  dropped = 0;

  constructor(capacity = 256) {
    this.capacity = capacity;
    for (let i = 0; i < capacity; i++) {
      this.buffer.push({ type: CommandType.Stop, unit: 0, x: 0, y: 0, target: 0, slot: 0 });
    }
  }

  get length(): number {
    return (this.tail - this.head + this.capacity) % this.capacity;
  }

  push(cmd: Command): void {
    const next = (this.tail + 1) % this.capacity;
    if (next === this.head) {
      this.dropped++;
      return;
    }
    const slot = this.buffer[this.tail];
    slot.type = cmd.type;
    slot.unit = cmd.unit;
    slot.x = cmd.x;
    slot.y = cmd.y;
    slot.target = cmd.target;
    slot.slot = cmd.slot;
    this.tail = next;
  }

  emit(
    type: CommandType,
    unit: EntityId,
    x = 0,
    y = 0,
    target: EntityId = 0,
    slot = 0,
  ): void {
    const next = (this.tail + 1) % this.capacity;
    if (next === this.head) {
      this.dropped++;
      return;
    }
    const c = this.buffer[this.tail];
    c.type = type;
    c.unit = unit;
    c.x = x;
    c.y = y;
    c.target = target;
    c.slot = slot;
    this.tail = next;
  }

  /** Calls `consume` for every queued command in order, then empties the queue. */
  drain(consume: (cmd: Command) => void): void {
    while (this.head !== this.tail) {
      consume(this.buffer[this.head]);
      this.head = (this.head + 1) % this.capacity;
    }
  }

  clear(): void {
    this.head = this.tail;
  }
}
