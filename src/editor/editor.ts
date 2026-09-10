/**
 * Map editor.
 *
 * Turns the engine from something only a programmer can add content to into
 * something anyone can dress a map with. Everything it does goes through the
 * same stores the game uses at runtime, so a scene built here is not a special
 * editor format that has to be baked: the game is already running underneath,
 * and leaving the editor simply hands control back to the player.
 *
 * Interaction model, borrowed from level editors rather than from the game:
 *
 *   pick an asset in the palette   the cursor carries a translucent ghost
 *   left click on ground           place it
 *   left click on a placed object  select it, palette brush is dropped
 *   drag a selected object         move it
 *   wheel / brackets               rotate, or scale with shift held
 *   delete                         remove it
 *
 * Every mutation is pushed onto an undo stack as a pair of closures. That is
 * far less machinery than a general command system and covers everything an
 * editor of this size needs.
 */

import { Group, Mesh, MeshBasicMaterial, Scene as ThreeScene } from 'three';
import type { AssetEntry, AssetRegistry } from '../render/assets';
import type { PropId, PropStore, Prop } from '../core/world/props';
import { PropFlag } from '../core/world/props';
import type { PropViews } from '../render/propview';
import type { RtsCamera } from '../render/camera';
import type { Sim } from '../core/sim/sim';
import { InputState, MouseButton } from '../input/input';
import { EditorUi, type EditorAction, type PropChange } from './ui';
import { ARCHETYPES } from '../game/content/units';
import { Team, UnitKind } from '../core/ecs/types';
import { spawnUnit } from '../game/scenario';
import { vec2, type Vec2 } from '../core/math/vec2';
import * as scene from '../game/scene';

interface Command {
  label: string;
  undo: () => void;
  redo: () => void;
}

/** Grid sizes cycled by the snap button. */
const SNAP_SIZES = [0, 0.5, 1, 2, 4];

const UNIT_CATEGORY = 'unit';

/** Panel widths, matched to the CSS, used to suppress edge panning under them. */
const PALETTE_WIDTH = 300;
const INSPECTOR_WIDTH = 264;

export interface EditorDeps {
  container: HTMLElement;
  threeScene: ThreeScene;
  assets: AssetRegistry;
  props: PropStore;
  propViews: PropViews;
  camera: RtsCamera;
  input: InputState;
  sim: Sim;
  mapSeed: number;
  mapName: string;
  onLog: (message: string) => void;
  /** Lets the host hide gameplay chrome while editing. */
  onModeChange?: (active: boolean) => void;
}

export class Editor {
  active = false;

  private readonly ui: EditorUi;
  private readonly d: EditorDeps;

  private category = 'building';
  private brushAsset: string | null = null;
  private brushUnit: string | null = null;
  private search = '';
  private snapIndex = 2;

  private selected: PropId = 0;
  private dragging = false;
  private dragOffset: Vec2 = vec2();

  private readonly ghost = new Group();
  private ghostMesh: Mesh | null = null;
  private readonly ghostMaterial = new MeshBasicMaterial({
    color: 0x7dffa8,
    transparent: true,
    opacity: 0.45,
    depthWrite: false,
  });

  private undoStack: Command[] = [];
  private redoStack: Command[] = [];

  private readonly cursor = vec2();
  private cursorValid = false;

  constructor(deps: EditorDeps) {
    this.d = deps;
    deps.threeScene.add(this.ghost);
    this.ghost.visible = false;

    this.ui = new EditorUi(deps.container, {
      onSelectCategory: (c) => {
        this.category = c;
        this.refreshPalette();
      },
      onSelectAsset: (id) => this.selectBrush(id),
      onSearch: (q) => {
        this.search = q;
        this.refreshPalette();
      },
      onAction: (a) => this.handleAction(a),
      onPropChange: (c) => this.handlePropChange(c),
    });

    this.refreshPalette();
    this.ui.setSnap(this.snapSize);
  }

  get snapSize(): number {
    return SNAP_SIZES[this.snapIndex];
  }

  toggle(): void {
    this.setActive(!this.active);
  }

  setActive(active: boolean): void {
    this.active = active;
    this.ui.setVisible(active);
    this.ghost.visible = false;
    if (!active) {
      this.clearBrush();
      this.select(0);
    }
    this.d.onModeChange?.(active);
    this.d.onLog(active ? 'Editor on. F2 to play.' : 'Editor off.');
  }

  /** True when a text field has focus, so the host should not act on hotkeys. */
  get capturingKeys(): boolean {
    return this.active && this.ui.typing;
  }

  // --- palette ------------------------------------------------------------

  private refreshPalette(): void {
    const categories = [...this.d.assets.categories(), UNIT_CATEGORY];
    if (!categories.includes(this.category)) this.category = categories[0] ?? UNIT_CATEGORY;
    this.ui.setCategories(categories, this.category);

    if (this.category === UNIT_CATEGORY) {
      const q = this.search.trim().toLowerCase();
      const items = Object.values(ARCHETYPES)
        .filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q))
        .map((a) => ({
          id: 'unit:' + a.id,
          name: a.name,
          detail: `${KIND_LABEL[a.kind] ?? 'unit'} r${a.radius}`,
        }));
      this.ui.setItems(items, this.brushUnit ? 'unit:' + this.brushUnit : '');
      return;
    }

    const pool = this.search
      ? this.d.assets.search(this.search).filter((e) => e.category === this.category)
      : this.d.assets.byCategory(this.category);
    this.ui.setItems(
      pool.map((e) => ({
        id: e.id,
        name: e.name,
        detail: `${e.triangles} tris · ${e.size[1].toFixed(1)}u`,
      })),
      this.brushAsset ?? '',
    );
  }

  private selectBrush(id: string): void {
    this.select(0);
    if (id.startsWith('unit:')) {
      this.brushUnit = id.slice(5);
      this.brushAsset = null;
      this.setGhostMesh(null);
    } else {
      this.brushAsset = id;
      this.brushUnit = null;
      void this.d.assets.load(id).then(() => this.setGhostMesh(id));
    }
    this.refreshPalette();
  }

  private clearBrush(): void {
    this.brushAsset = null;
    this.brushUnit = null;
    this.setGhostMesh(null);
    this.refreshPalette();
  }

  private setGhostMesh(assetId: string | null): void {
    if (this.ghostMesh) {
      this.ghost.remove(this.ghostMesh);
      this.ghostMesh = null;
    }
    if (!assetId) {
      this.ghost.visible = false;
      return;
    }
    const geo = this.d.assets.geometry(assetId);
    if (!geo) return;
    this.ghostMesh = new Mesh(geo, this.ghostMaterial);
    this.ghost.add(this.ghostMesh);
  }

  // --- per-frame ----------------------------------------------------------

  update(dt: number, viewportWidth: number, viewportHeight: number): void {
    if (!this.active) return;
    const input = this.d.input;

    this.cursorValid = this.d.camera.screenToGround(input.mouseX, input.mouseY, this.cursor);
    if (this.snapSize > 0) {
      this.cursor.x = Math.round(this.cursor.x / this.snapSize) * this.snapSize;
      this.cursor.y = Math.round(this.cursor.y / this.snapSize) * this.snapSize;
    }

    this.updateGhost();
    this.updateHover();
    this.handleMouse();
    this.handleKeys();
    this.updateStatus();
    this.updateCamera(dt, viewportWidth, viewportHeight);
  }

  /**
   * Scrolls the map while editing.
   *
   * The editor owns this rather than the player controller, which is not
   * running in this mode. Edge panning is suppressed over the palette and the
   * inspector: those cover the sides of the viewport, and a camera that slides
   * away every time you reach for an asset is unusable.
   */
  private updateCamera(dt: number, width: number, height: number): void {
    const input = this.d.input;
    let panX = 0;
    let panY = 0;

    if (input.isHeld('ArrowLeft')) panX -= 1;
    if (input.isHeld('ArrowRight')) panX += 1;
    if (input.isHeld('ArrowUp')) panY -= 1;
    if (input.isHeld('ArrowDown')) panY += 1;

    const overPanel = input.mouseX < PALETTE_WIDTH || input.mouseX > width - INSPECTOR_WIDTH;
    if (input.mouseInside && !overPanel) {
      const margin = 6;
      if (input.mouseX <= margin) panX -= 1;
      else if (input.mouseX >= width - margin) panX += 1;
      if (input.mouseY <= margin) panY -= 1;
      else if (input.mouseY >= height - margin) panY += 1;
    }

    // The wheel is bound to rotate and scale, so zoom needs a modifier.
    if (input.wheel !== 0 && (input.isHeld('ControlLeft') || input.isHeld('ControlRight'))) {
      this.d.camera.zoomBy(input.wheel);
    }

    this.d.camera.followTarget = null;
    this.d.camera.update(dt, panX, panY);
  }

  private updateGhost(): void {
    const show = this.cursorValid && (this.brushAsset !== null || this.brushUnit !== null);
    this.ghost.visible = show && this.ghostMesh !== null;
    if (show) this.ghost.position.set(this.cursor.x, 0, this.cursor.y);
  }

  private updateHover(): void {
    if (this.brushAsset || this.brushUnit) {
      this.d.propViews.hovered = 0;
      return;
    }
    const hit = this.cursorValid ? this.d.props.pick(this.cursor.x, this.cursor.y) : null;
    this.d.propViews.hovered = hit ? hit.id : 0;
  }

  private handleMouse(): void {
    const input = this.d.input;

    if (input.wasButtonPressed(MouseButton.Left) && this.cursorValid) {
      if (this.brushAsset) this.placeProp(this.brushAsset);
      else if (this.brushUnit) this.placeUnit(this.brushUnit);
      else {
        const hit = this.d.props.pick(this.cursor.x, this.cursor.y);
        this.select(hit ? hit.id : 0);
        if (hit) {
          this.dragging = true;
          this.dragOffset.x = hit.x - this.cursor.x;
          this.dragOffset.y = hit.y - this.cursor.y;
          this.dragStart = { x: hit.x, y: hit.y };
        }
      }
    }

    if (this.dragging) {
      const prop = this.d.props.get(this.selected);
      if (!prop || !input.isButtonHeld(MouseButton.Left)) {
        if (prop && this.dragStart) this.commitMove(prop, this.dragStart);
        this.dragging = false;
        this.dragStart = null;
      } else if (this.cursorValid) {
        prop.x = this.cursor.x + this.dragOffset.x;
        prop.y = this.cursor.y + this.dragOffset.y;
        this.d.props.touch(prop);
      }
    }

    // Right click drops the brush, which is the fastest way back to selecting.
    if (input.wasButtonPressed(MouseButton.Right)) this.clearBrush();

    // The wheel rotates the brush or the selection instead of zooming, since
    // aiming an asset is the more common need while dressing a map.
    if (input.wheel !== 0) {
      const step = input.isHeld('ShiftLeft') || input.isHeld('ShiftRight') ? 0.02 : 0.15;
      const prop = this.d.props.get(this.selected);
      if (prop) {
        if (input.isHeld('ShiftLeft') || input.isHeld('ShiftRight')) {
          prop.scale = clamp(prop.scale * (1 - input.wheel * 0.06), 0.15, 8);
        } else {
          prop.rotation += input.wheel * step * 2;
        }
        this.d.props.touch(prop);
        this.refreshInspector();
      } else {
        this.ghost.rotation.y += input.wheel * step * 2;
      }
    }
  }

  private dragStart: { x: number; y: number } | null = null;

  private handleKeys(): void {
    const input = this.d.input;
    if (this.ui.typing) {
      if (input.wasPressed('Escape')) this.ui.blurSearch();
      return;
    }

    if (input.wasPressed('Delete') || input.wasPressed('Backspace')) this.handleAction('delete');
    if (input.wasPressed('KeyD') && (input.isHeld('ControlLeft') || input.isHeld('ControlRight'))) {
      this.handleAction('duplicate');
    }
    if (input.wasPressed('Escape')) {
      if (this.brushAsset || this.brushUnit) this.clearBrush();
      else this.select(0);
    }
    if (input.wasPressed('KeyG')) this.handleAction('toggleSnap');
    if (input.wasPressed('KeyF')) this.handleAction('focus');

    const prop = this.d.props.get(this.selected);
    if (prop) {
      if (input.wasPressed('BracketLeft')) {
        prop.rotation -= Math.PI / 12;
        this.d.props.touch(prop);
        this.refreshInspector();
      }
      if (input.wasPressed('BracketRight')) {
        prop.rotation += Math.PI / 12;
        this.d.props.touch(prop);
        this.refreshInspector();
      }
    }
  }

  private updateStatus(): void {
    const count = this.d.props.props.length;
    const brush = this.brushAsset
      ? this.d.assets.get(this.brushAsset)?.name
      : this.brushUnit
        ? ARCHETYPES[this.brushUnit]?.name
        : null;
    const where = this.cursorValid ? `${this.cursor.x.toFixed(1)}, ${this.cursor.y.toFixed(1)}` : 'off map';
    this.ui.setStatus(
      `${count} placed · ${brush ? `brush: ${brush}` : 'no brush'} · cursor ${where} · ${this.undoStack.length} undo`,
    );
  }

  // --- mutations ----------------------------------------------------------

  private placeProp(assetId: string): void {
    const entry = this.d.assets.get(assetId);
    if (!entry) return;

    // Sensible defaults by category, so a tree blocks and a coin does not.
    //
    // A creature asset placed here is scenery, not a living unit: a statue, a
    // slain beast, a set dressing monster. Living NPCs come from the unit
    // palette instead. Both are solid, so both block.
    let flags: PropFlag = PropFlag.None;
    if (entry.category === 'building' || entry.category === 'nature' || entry.category === 'creature') {
      flags |= PropFlag.Blocks;
    }
    if (entry.category === 'building') flags |= PropFlag.Opaque;
    if (entry.category === 'pickup' || entry.category === 'weapon' || entry.category === 'shield') {
      flags |= PropFlag.Pickup;
    }

    const prop = this.d.props.add({
      assetId,
      category: entry.category,
      x: this.cursor.x,
      y: this.cursor.y,
      rotation: this.ghost.rotation.y,
      scale: 1,
      flags,
      radius: entry.radius,
      item: flags & PropFlag.Pickup ? assetId : null,
    });

    const id = prop.id;
    const snapshot = { ...prop, data: { ...prop.data } };
    this.push({
      label: 'place ' + entry.name,
      undo: () => {
        this.d.props.remove(id);
        this.d.props.rebuildNav();
      },
      redo: () => {
        const restored = this.d.props.add(snapshot);
        restored.id = id;
        this.d.props.rebuildNav();
      },
    });
    this.d.props.rebuildNav();
  }

  private placeUnit(archetypeId: string): void {
    const arch = ARCHETYPES[archetypeId];
    if (!arch) return;
    const team = arch.kind === UnitKind.Monster ? Team.Neutral : Team.Red;
    const unit = spawnUnit(this.d.sim, archetypeId, team, vec2(this.cursor.x, this.cursor.y));
    const id = unit.id;
    this.push({
      label: 'place ' + arch.name,
      undo: () => this.d.sim.world.despawn(id),
      // Re-placing gives a new handle, which is fine: nothing holds the old one
      // once it has been despawned.
      redo: () => {
        spawnUnit(this.d.sim, archetypeId, team, vec2(this.cursor.x, this.cursor.y));
      },
    });
    this.d.onLog(`Placed ${arch.name}`);
  }

  private commitMove(prop: Prop, from: { x: number; y: number }): void {
    if (Math.abs(prop.x - from.x) < 1e-4 && Math.abs(prop.y - from.y) < 1e-4) return;
    const id = prop.id;
    const to = { x: prop.x, y: prop.y };
    this.push({
      label: 'move',
      undo: () => {
        const p = this.d.props.get(id);
        if (p) {
          p.x = from.x;
          p.y = from.y;
          this.d.props.touch(p);
          this.d.props.rebuildNav();
        }
      },
      redo: () => {
        const p = this.d.props.get(id);
        if (p) {
          p.x = to.x;
          p.y = to.y;
          this.d.props.touch(p);
          this.d.props.rebuildNav();
        }
      },
    });
    this.d.props.rebuildNav();
  }

  private select(id: PropId): void {
    this.selected = id;
    this.d.propViews.selected = id;
    this.refreshInspector();
  }

  private refreshInspector(): void {
    const prop = this.d.props.get(this.selected);
    const name = prop ? (this.d.assets.get(prop.assetId)?.name ?? prop.assetId) : '';
    this.ui.setSelection(prop ?? null, name);
  }

  private handlePropChange(change: PropChange): void {
    const prop = this.d.props.get(this.selected);
    if (!prop) return;
    switch (change.field) {
      case 'rotation':
        prop.rotation = Number(change.value);
        break;
      case 'scale':
        prop.scale = Number(change.value);
        break;
      case 'blocks':
        prop.flags = setFlag(prop.flags, PropFlag.Blocks, Boolean(change.value));
        break;
      case 'opaque':
        prop.flags = setFlag(prop.flags, PropFlag.Opaque, Boolean(change.value));
        break;
      case 'pickup':
        prop.flags = setFlag(prop.flags, PropFlag.Pickup, Boolean(change.value));
        prop.item = prop.flags & PropFlag.Pickup ? prop.assetId : null;
        break;
      case 'item':
        prop.item = String(change.value) || null;
        break;
    }
    this.d.props.touch(prop);
    this.d.props.rebuildNav();
  }

  private handleAction(action: EditorAction): void {
    const prop = this.d.props.get(this.selected);
    switch (action) {
      case 'delete': {
        if (!prop) return;
        const snapshot = { ...prop, data: { ...prop.data } };
        const id = prop.id;
        this.d.props.remove(id);
        this.d.props.rebuildNav();
        this.select(0);
        this.push({
          label: 'delete',
          undo: () => {
            const restored = this.d.props.add(snapshot);
            restored.id = id;
            this.d.props.rebuildNav();
          },
          redo: () => {
            this.d.props.remove(id);
            this.d.props.rebuildNav();
          },
        });
        break;
      }
      case 'duplicate': {
        if (!prop) return;
        const copy = this.d.props.add({
          ...prop,
          x: prop.x + 1.5,
          y: prop.y + 1.5,
          data: { ...prop.data },
        });
        const id = copy.id;
        this.push({
          label: 'duplicate',
          undo: () => {
            this.d.props.remove(id);
            this.d.props.rebuildNav();
          },
          redo: () => {
            this.d.props.rebuildNav();
          },
        });
        this.select(id);
        this.d.props.rebuildNav();
        break;
      }
      case 'focus':
        if (prop) this.d.camera.jumpTo(prop.x, prop.y);
        break;
      case 'toggleSnap':
        this.snapIndex = (this.snapIndex + 1) % SNAP_SIZES.length;
        this.ui.setSnap(this.snapSize);
        break;
      case 'undo': {
        const cmd = this.undoStack.pop();
        if (cmd) {
          cmd.undo();
          this.redoStack.push(cmd);
          this.select(0);
          this.d.onLog('Undo ' + cmd.label);
        }
        break;
      }
      case 'redo': {
        const cmd = this.redoStack.pop();
        if (cmd) {
          cmd.redo();
          this.undoStack.push(cmd);
          this.d.onLog('Redo ' + cmd.label);
        }
        break;
      }
      case 'clear': {
        const snapshot = this.d.props.props.map((p) => ({ ...p, data: { ...p.data } }));
        this.d.props.clear();
        this.d.props.rebuildNav(true);
        this.select(0);
        this.push({
          label: 'clear',
          undo: () => {
            for (const p of snapshot) this.d.props.add(p);
            this.d.props.rebuildNav(true);
          },
          redo: () => {
            this.d.props.clear();
            this.d.props.rebuildNav(true);
          },
        });
        break;
      }
      case 'save': {
        const data = scene.serialize(this.d.mapName, this.d.mapSeed, this.d.props, this.d.sim);
        scene.saveLocal('autosave', data);
        this.d.onLog(`Saved ${data.props.length} props and ${data.units.length} units`);
        break;
      }
      case 'load': {
        const data = scene.loadLocal('autosave');
        if (!data) {
          this.d.onLog('No saved scene in this browser');
          return;
        }
        this.applyScene(data);
        break;
      }
      case 'export': {
        scene.exportFile(scene.serialize(this.d.mapName, this.d.mapSeed, this.d.props, this.d.sim));
        break;
      }
      case 'import': {
        void scene.importFile().then((data) => {
          if (data) this.applyScene(data);
          else this.d.onLog('Import cancelled or invalid');
        });
        break;
      }
      case 'play':
        this.setActive(false);
        break;
    }
    this.refreshInspector();
  }

  private applyScene(data: scene.Scene): void {
    // Loading a scene replaces its population as well as its props. Anything
    // else means the NPCs a designer placed can be saved but never come back,
    // and a second load quietly doubles them.
    const result = scene.deserialize(data, this.d.props, this.d.sim, {
      spawnUnits: true,
      replaceUnits: true,
      radiusOf: (id) => this.d.assets.get(id)?.radius ?? 0.5,
    });
    // Anything the scene references must be resident before it can be drawn.
    void this.d.assets.loadAll(new Set(this.d.props.props.map((p) => p.assetId)));
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.select(0);
    this.d.onLog(
      `Loaded ${result.props} props and ${result.units} units` +
        (result.warnings.length ? ` (${result.warnings.length} warnings)` : ''),
    );
    for (const w of result.warnings) console.warn('[scene]', w);
  }

  private push(cmd: Command): void {
    this.undoStack.push(cmd);
    // A bounded history keeps a long dressing session from growing without end.
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Called by the host for Ctrl+Z and Ctrl+Y, which are global. */
  undo(): void {
    this.handleAction('undo');
  }

  redo(): void {
    this.handleAction('redo');
  }
}

/** A const enum has no reverse map, so labels are spelled out. */
const KIND_LABEL: Record<number, string> = {
  [UnitKind.Champion]: 'champion',
  [UnitKind.Minion]: 'minion',
  [UnitKind.Monster]: 'monster',
  [UnitKind.Structure]: 'structure',
  [UnitKind.Ward]: 'ward',
};

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function setFlag(flags: PropFlag, bit: PropFlag, on: boolean): PropFlag {
  return on ? flags | bit : flags & ~bit;
}

/** Loading a scene needs the asset entry type for radii; re-exported for hosts. */
export type { AssetEntry };
