/**
 * Seeded pseudo-random number generator.
 *
 * The simulation must never call Math.random. Two clients replaying the same
 * command stream have to produce identical state, so every random draw comes
 * from a seeded stream whose cursor is part of the simulation snapshot.
 *
 * This is mulberry32: cheap, good enough distribution for gameplay, and its
 * entire state is a single 32-bit integer that serializes for free.
 */
export class Rng {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0;
  }

  /** Raw 32-bit draw. */
  nextUint(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint() / 4294967296;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Uniform integer in [min, max]. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)];
  }

  /** Snapshot and restore, so a replay can rewind to an earlier tick. */
  save(): number {
    return this.state;
  }

  restore(state: number): void {
    this.state = state >>> 0;
  }

  /** A derived stream, for subsystems that should not disturb the main cursor. */
  fork(salt: number): Rng {
    return new Rng((this.state ^ Math.imul(salt, 0x85ebca6b)) >>> 0);
  }
}
