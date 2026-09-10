/**
 * Player controls.
 *
 * The mapping is deliberately the modern MOBA one, because it is what hands
 * already know: right click to move and attack, QWER for abilities, A for
 * attack-move, S to stop, arrows and screen edges to scroll, wheel to zoom.
 *
 * Two details matter more than the list of keys:
 *
 *   Quick cast. Pressing an ability key shows its indicator; releasing casts at
 *   the cursor. Tap for an instant cast, hold to aim. This is why the ability
 *   system separates validation from commitment: the indicator has to predict
 *   exactly what the cast will do, including range clamping.
 *
 *   Everything becomes a command. No handler here touches a unit. Input is
 *   translated into the same command stream the network layer would carry, so
 *   what the player does is recordable and replayable by construction.
 */

import type { Sim } from '../core/sim/sim';
import { CommandType } from '../core/sim/commands';
import type { EntityId, Unit } from '../core/ecs/types';
import { NO_ENTITY, Team, UnitFlag } from '../core/ecs/types';
import { getAbility, Targeting, CastRejection } from '../core/abilities/types';
import { validateCast } from '../core/abilities/casting';
import type { RtsCamera } from '../render/camera';
import type { UnitViews } from '../render/unitview';
import type { Indicators } from '../render/indicators';
import { vec2, type Vec2 } from '../core/math/vec2';
import { InputState, MouseButton } from './input';

/** Ability slot order, matching the champion's kit array. */
const ABILITY_KEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyD', 'KeyF'];

/** Pixels from the window edge that trigger camera panning. */
const EDGE_MARGIN = 6;

export interface ControllerToggles {
  quickCast: boolean;
  cameraLocked: boolean;
  showPaths: boolean;
  showGrid: boolean;
  fogEnabled: boolean;
  paused: boolean;
  timeScale: number;
  viewTeam: Team;
}

export interface ControllerHooks {
  onToggleGrid: (on: boolean) => void;
  onToggleFog: (on: boolean) => void;
  onToggleViewTeam: (team: Team) => void;
  onSpawnWave: () => void;
  onLog: (message: string) => void;
}

export class PlayerController {
  readonly toggles: ControllerToggles = {
    quickCast: true,
    cameraLocked: false,
    showPaths: false,
    showGrid: false,
    fogEnabled: true,
    paused: false,
    timeScale: 1,
    viewTeam: Team.Blue,
  };

  /** Ground position under the cursor, updated every frame. */
  readonly cursor: Vec2 = vec2();
  /** Ability slot currently being aimed, or -1. */
  aiming = -1;
  /** True while an attack-move click is pending. */
  attackMovePending = false;
  /** Unit under the cursor this frame. */
  hovered: EntityId = NO_ENTITY;

  private readonly input: InputState;
  private readonly sim: Sim;
  private readonly camera: RtsCamera;
  private readonly views: UnitViews;
  private readonly indicators: Indicators;
  private readonly hooks: ControllerHooks;

  /** The unit this player commands. */
  playerUnit: EntityId = NO_ENTITY;

  private cursorValid = false;

  constructor(
    input: InputState,
    sim: Sim,
    camera: RtsCamera,
    views: UnitViews,
    indicators: Indicators,
    hooks: ControllerHooks,
  ) {
    this.input = input;
    this.sim = sim;
    this.camera = camera;
    this.views = views;
    this.indicators = indicators;
    this.hooks = hooks;
  }

  get champion(): Unit | null {
    return this.sim.world.get(this.playerUnit);
  }

  update(dt: number, viewportWidth: number, viewportHeight: number): void {
    const input = this.input;

    this.cursorValid = this.camera.screenToGround(input.mouseX, input.mouseY, this.cursor);
    this.hovered = this.views.pickAt(this.camera, input.mouseX, input.mouseY);
    this.views.hovered = this.hovered;

    this.updateCamera(dt, viewportWidth, viewportHeight);
    this.updateDebugKeys();
    this.updateOrders();
    this.updateAbilities();
    this.updateIndicators();
  }

  // --- camera ---------------------------------------------------------------

  private updateCamera(dt: number, width: number, height: number): void {
    const input = this.input;
    let panX = 0;
    let panY = 0;

    if (input.isHeld('ArrowLeft')) panX -= 1;
    if (input.isHeld('ArrowRight')) panX += 1;
    // Up on screen is towards negative z at this camera's fixed yaw.
    if (input.isHeld('ArrowUp')) panY -= 1;
    if (input.isHeld('ArrowDown')) panY += 1;

    if (input.mouseInside && this.camera.edgePanEnabled) {
      if (input.mouseX <= EDGE_MARGIN) panX -= 1;
      else if (input.mouseX >= width - EDGE_MARGIN) panX += 1;
      if (input.mouseY <= EDGE_MARGIN) panY -= 1;
      else if (input.mouseY >= height - EDGE_MARGIN) panY += 1;
    }

    if (input.wheel !== 0) this.camera.zoomBy(input.wheel);

    // Space centres the camera; holding it keeps the champion centred.
    const champion = this.champion;
    if (input.wasPressed('Space') && champion) {
      this.camera.centreOn(champion.pos.x, champion.pos.y);
    }
    if (input.wasPressed('KeyY')) {
      this.toggles.cameraLocked = !this.toggles.cameraLocked;
      this.hooks.onLog(`Camera lock ${this.toggles.cameraLocked ? 'on' : 'off'}`);
    }

    const following =
      champion && (this.toggles.cameraLocked || this.input.isHeld('Space')) && panX === 0 && panY === 0;
    this.camera.followTarget = following ? champion.pos : null;

    this.camera.update(dt, panX, panY);
  }

  // --- orders ---------------------------------------------------------------

  private updateOrders(): void {
    const input = this.input;
    const unit = this.champion;
    if (!unit) return;

    // Right click: move, or attack whatever hostile is under the cursor.
    if (input.wasButtonPressed(MouseButton.Right)) {
      if (this.aiming >= 0 || this.attackMovePending) {
        this.cancelTargeting();
      } else if (this.cursorValid) {
        const target = this.hostileUnder();
        if (target) {
          this.sim.commands.emit(CommandType.AttackUnit, unit.id, 0, 0, target.id);
          this.indicators.pingMove(target.pos.x, target.pos.y, true);
        } else {
          this.sim.commands.emit(CommandType.Move, unit.id, this.cursor.x, this.cursor.y);
          this.indicators.pingMove(this.cursor.x, this.cursor.y, false);
        }
      }
    }

    // Attack-move: press A, then click a destination.
    if (input.wasPressed('KeyA')) {
      this.aiming = -1;
      this.attackMovePending = true;
    }

    if (input.wasButtonPressed(MouseButton.Left)) {
      if (this.attackMovePending && this.cursorValid) {
        this.sim.commands.emit(CommandType.AttackMove, unit.id, this.cursor.x, this.cursor.y);
        this.indicators.pingMove(this.cursor.x, this.cursor.y, true);
        this.attackMovePending = false;
      } else if (this.aiming >= 0) {
        this.confirmCast(this.aiming);
      } else {
        // Plain left click selects, for inspecting anything on the field.
        this.views.selection.clear();
        if (this.hovered) this.views.selection.add(this.hovered);
      }
    }

    if (input.wasPressed('KeyS')) {
      this.sim.commands.emit(CommandType.Stop, unit.id);
      this.cancelTargeting();
    }
    if (input.wasPressed('KeyH')) {
      this.sim.commands.emit(CommandType.HoldPosition, unit.id);
      this.cancelTargeting();
    }
    if (input.wasPressed('Escape')) this.cancelTargeting();
  }

  private hostileUnder(): Unit | null {
    const unit = this.champion;
    if (!unit || !this.hovered) return null;
    const target = this.sim.world.getTargetable(this.hovered);
    if (!target) return null;
    if (!this.sim.world.isEnemy(unit, target)) return null;
    return target;
  }

  // --- abilities ------------------------------------------------------------

  private updateAbilities(): void {
    const input = this.input;
    const unit = this.champion;
    if (!unit) return;

    for (let slot = 0; slot < ABILITY_KEYS.length; slot++) {
      const key = ABILITY_KEYS[slot];

      if (input.wasPressed(key)) {
        const inst = unit.abilities[slot];
        const def = inst ? getAbility(inst.defId) : undefined;
        if (!def) continue;

        this.attackMovePending = false;

        // Self-cast abilities have nothing to aim, so they fire on press.
        if (def.targeting === Targeting.Self) {
          this.confirmCast(slot);
        } else {
          this.aiming = slot;
        }
      }

      // Quick cast fires when the key comes up, so a tap casts instantly and a
      // hold lets the player line the indicator up first.
      if (this.toggles.quickCast && this.aiming === slot && input.wasReleased(key)) {
        this.confirmCast(slot);
      }
    }
  }

  private confirmCast(slot: number): void {
    const unit = this.champion;
    if (!unit || !this.cursorValid) {
      this.aiming = -1;
      return;
    }

    const inst = unit.abilities[slot];
    const def = inst ? getAbility(inst.defId) : undefined;
    if (!def) {
      this.aiming = -1;
      return;
    }

    let target: EntityId = NO_ENTITY;
    if (def.targeting === Targeting.Unit) {
      // Prefer whatever is under the cursor; fall back to the nearest valid
      // enemy in range so a slightly missed click still does the obvious thing.
      const under = this.sim.world.getTargetable(this.hovered);
      if (under && this.sim.world.isEnemy(unit, under)) {
        target = under.id;
      } else {
        const near = this.sim.world.nearest(
          this.cursor,
          3.5,
          (u) => this.sim.world.isEnemy(unit, u) && (u.flags & UnitFlag.Targetable) !== 0,
          unit.id,
        );
        if (near) target = near.id;
      }
    }

    const verdict = validateCast(this.sim.world, unit, slot, this.cursor, target);
    if (verdict !== CastRejection.Ok) {
      this.reportRejection(def.name, verdict);
      this.aiming = -1;
      return;
    }

    this.sim.commands.emit(
      CommandType.Cast,
      unit.id,
      this.cursor.x,
      this.cursor.y,
      target,
      slot,
    );
    this.aiming = -1;
  }

  private reportRejection(name: string, verdict: CastRejection): void {
    // Cooldown is the common case and does not deserve a log line every press.
    if (verdict === CastRejection.OnCooldown) return;
    const reasons: Partial<Record<CastRejection, string>> = {
      [CastRejection.NotEnoughMana]: 'not enough mana',
      [CastRejection.NoTarget]: 'no target',
      [CastRejection.OutOfRange]: 'out of range',
      [CastRejection.Silenced]: 'cannot cast right now',
      [CastRejection.AlreadyCasting]: 'already casting',
    };
    const reason = reasons[verdict];
    if (reason) this.hooks.onLog(`${name}: ${reason}`);
  }

  private cancelTargeting(): void {
    this.aiming = -1;
    this.attackMovePending = false;
  }

  // --- indicators -----------------------------------------------------------

  private updateIndicators(): void {
    this.indicators.clearTargeting();
    const unit = this.champion;
    if (!unit) return;

    if (this.aiming >= 0) {
      const inst = unit.abilities[this.aiming];
      const def = inst ? getAbility(inst.defId) : undefined;
      if (def) this.indicators.showAbility(def, unit, this.cursor);
    }

    const selectedId = this.views.selection.values().next().value as EntityId | undefined;
    const inspected = selectedId ? this.sim.world.get(selectedId) : unit;
    this.indicators.showAttackRange(inspected ?? unit);
    this.indicators.showPath(inspected ?? unit, this.toggles.showPaths);
  }

  // --- debug ----------------------------------------------------------------

  private updateDebugKeys(): void {
    const input = this.input;

    if (input.wasPressed('KeyP')) {
      this.toggles.paused = !this.toggles.paused;
      this.sim.paused = this.toggles.paused;
      this.hooks.onLog(this.toggles.paused ? 'Simulation paused' : 'Simulation resumed');
    }
    if (input.wasPressed('KeyG')) {
      this.toggles.showGrid = !this.toggles.showGrid;
      this.hooks.onToggleGrid(this.toggles.showGrid);
    }
    if (input.wasPressed('KeyV')) {
      this.toggles.fogEnabled = !this.toggles.fogEnabled;
      this.hooks.onToggleFog(this.toggles.fogEnabled);
      this.hooks.onLog(`Fog of war ${this.toggles.fogEnabled ? 'on' : 'off'}`);
    }
    if (input.wasPressed('KeyO')) {
      this.toggles.showPaths = !this.toggles.showPaths;
      this.hooks.onLog(`Path overlay ${this.toggles.showPaths ? 'on' : 'off'}`);
    }
    if (input.wasPressed('KeyT')) {
      this.toggles.viewTeam = this.toggles.viewTeam === Team.Blue ? Team.Red : Team.Blue;
      this.hooks.onToggleViewTeam(this.toggles.viewTeam);
      this.hooks.onLog(`Viewing ${this.toggles.viewTeam === Team.Blue ? 'blue' : 'red'} team vision`);
    }
    if (input.wasPressed('KeyB')) this.hooks.onSpawnWave();

    if (input.wasPressed('Backquote')) {
      const unit = this.champion;
      if (unit) {
        this.sim.commands.emit(CommandType.DebugRefresh, unit.id);
        this.hooks.onLog('Cooldowns refreshed');
      }
    }

    if (input.wasPressed('BracketLeft')) this.setTimeScale(this.toggles.timeScale / 2);
    if (input.wasPressed('BracketRight')) this.setTimeScale(this.toggles.timeScale * 2);
  }

  private setTimeScale(value: number): void {
    this.toggles.timeScale = Math.max(0.125, Math.min(4, value));
    this.sim.timeScale = this.toggles.timeScale;
    this.hooks.onLog(`Time scale ${this.toggles.timeScale}x`);
  }
}
