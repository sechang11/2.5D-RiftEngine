/**
 * Binds simulation units to scene objects.
 *
 * The simulation knows nothing about this layer. Views are created and
 * destroyed by diffing the world's unit list each frame, and every visual
 * property is derived from sim state rather than pushed into the view when
 * something happens. That one-way flow means a view can be thrown away and
 * rebuilt at any time, which is what makes hot-reloading the renderer possible
 * and keeps desyncs impossible by construction.
 *
 * Positions are interpolated between the previous and current tick using the
 * simulation's leftover time, so a 60 Hz simulation renders smoothly at any
 * refresh rate.
 *
 * A unit is drawn one of two ways. Most are procedural rigs built from
 * primitives. An archetype that names an authored model gets a skinned body
 * instead, posed from exactly the same inputs, and falls back to primitives if
 * that model never loaded.
 */

import {
  AdditiveBlending,
  CircleGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Scene,
  Vector3,
  type Object3D,
  type Texture,
} from 'three';
import type { World } from '../core/ecs/world';
import type { EntityId, Unit } from '../core/ecs/types';
import { Team, UnitKind } from '../core/ecs/types';
import { CastPhase } from '../core/ecs/types';
import { dashHeight } from '../core/sim/locomotion';
import { clamp01 } from '../core/math/scalar';
import { attackInterval } from '../core/combat/stats';
import type { RtsCamera } from './camera';
import {
  buildCharacter,
  buildTower,
  disposeCharacter,
  poseCharacter,
  poseTower,
  type CharacterRig,
  type PoseInput,
} from './meshes/character';
import { archetype, styleFor, TEAM_COLOR } from '../game/content/units';
import { createRingTexture } from './textures/procedural';
import type { AssetRegistry } from './assets';
import type { CharacterModels, SkinnedBody } from './characters';

/** Seconds a corpse stays on the field before its view is removed. */
const CORPSE_DURATION = 1.4;

/** Extra seconds of swing follow-through after the damage lands. */
const ATTACK_FOLLOW_THROUGH = 0.16;

interface UnitView {
  id: EntityId;
  archetype: string;
  team: Team;
  /** The body built from primitives, or null when an authored model stands in. */
  rig: CharacterRig | null;
  /** The authored body, when the archetype names a model and it loaded. */
  skinned: SkinnedBody | null;
  /** Whichever of the two is drawn, for turning it to the unit's heading. */
  body: Object3D;
  /** Asset ids currently attached, so equipment is only rebuilt when it changes. */
  equipped: Record<string, string>;
  /** Meshes added for equipment, removed on the next swap. */
  attached: Mesh[];
  group: Group;
  ring: Mesh;
  ringMaterial: MeshBasicMaterial;
  isTower: boolean;
  /** Countdown driving the attack animation. */
  attackTimer: number;
  attackTotal: number;
  /** Total windup of the cast in progress, captured when it started. */
  castTotal: number;
  /** Seconds since death, for the collapse animation. */
  deathTimer: number;
  /** True once the unit has left the world and only the corpse remains. */
  orphaned: boolean;
  /** Smoothed opacity so units fading in and out of fog do not pop. */
  visibility: number;
}

export class UnitViews {
  readonly group = new Group();
  readonly selection = new Set<EntityId>();
  /** Unit under the cursor, refreshed by `pickAt`. */
  hovered: EntityId = 0;
  /** Whether the team rings under units are drawn. */
  ringsVisible = true;

  private readonly views = new Map<EntityId, UnitView>();
  private readonly world: World;
  private readonly ringTexture: Texture;
  private readonly ringGeometry = new CircleGeometry(1, 28);
  private viewTeam: Team;
  private readonly screen = new Vector3();
  private readonly seen = new Set<EntityId>();
  /** Optional: supplies meshes for equipped items. */
  private assets: AssetRegistry | null = null;
  /** Optional: supplies authored bodies for archetypes that name one. */
  private characters: CharacterModels | null = null;

  constructor(scene: Scene, world: World, viewTeam: Team, assets?: AssetRegistry, characters?: CharacterModels) {
    this.world = world;
    this.viewTeam = viewTeam;
    this.assets = assets ?? null;
    this.characters = characters ?? null;
    this.ringTexture = createRingTexture(256, 0.09, 0.03);
    scene.add(this.group);
  }

  setViewTeam(team: Team): void {
    this.viewTeam = team;
  }

  /**
   * Reconciles views with the world, then poses everything.
   *
   * `alpha` is the fraction of a tick that has elapsed since the last
   * simulation step.
   */
  update(alpha: number, dt: number, time: number, fogEnabled: boolean): void {
    const world = this.world;
    this.seen.clear();

    for (let i = 0; i < world.units.length; i++) {
      const unit = world.units[i];
      this.seen.add(unit.id);
      let view = this.views.get(unit.id);
      if (!view) {
        view = this.createView(unit);
        this.views.set(unit.id, view);
      }
      view.orphaned = false;
      this.updateView(view, unit, alpha, dt, time, fogEnabled);
    }

    // Units that vanished this frame leave a corpse behind for a moment.
    for (const [id, view] of this.views) {
      if (this.seen.has(id)) continue;
      view.orphaned = true;
      view.deathTimer += dt;
      poseFor(view, {
        speed: 0,
        time,
        dt,
        attack: -1,
        cast: -1,
        death: clamp01(view.deathTimer / 0.55),
        lift: 0,
      });
      const fade = 1 - clamp01((view.deathTimer - CORPSE_DURATION * 0.6) / (CORPSE_DURATION * 0.4));
      view.ringMaterial.opacity = 0.25 * fade;
      if (view.deathTimer > CORPSE_DURATION) {
        this.destroyView(view);
        this.views.delete(id);
      }
    }
  }

  private createView(unit: Unit): UnitView {
    const arch = archetype(unit.archetype);
    const style = styleFor(unit.archetype, unit.team);
    const isTower = arch.mesh === 'tower';

    const skinned = !isTower && arch.model ? (this.characters?.create(arch.model) ?? null) : null;
    let rig: CharacterRig | null = null;
    let body: Object3D;
    if (skinned) {
      body = skinned.root;
    } else {
      rig = isTower ? buildTower(style) : buildCharacter(style);
      body = rig.root;
    }

    const group = new Group();
    group.add(body);

    const ringMaterial = new MeshBasicMaterial({
      map: this.ringTexture,
      color: TEAM_COLOR[unit.team],
      transparent: true,
      opacity: 0.35,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    const ring = new Mesh(this.ringGeometry, ringMaterial);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.04;
    ring.scale.setScalar(unit.radius * 1.55);
    ring.renderOrder = 2;
    group.add(ring);

    this.group.add(group);

    return {
      id: unit.id,
      archetype: unit.archetype,
      team: unit.team,
      rig,
      skinned,
      body,
      group,
      ring,
      ringMaterial,
      isTower,
      equipped: {},
      attached: [],
      attackTimer: 0,
      attackTotal: 0.3,
      castTotal: 0,
      deathTimer: 0,
      orphaned: false,
      visibility: 1,
    };
  }

  private destroyView(view: UnitView): void {
    this.group.remove(view.group);
    if (view.rig) disposeCharacter(view.rig);
    view.skinned?.dispose();
    view.ringMaterial.dispose();
  }

  private updateView(
    view: UnitView,
    unit: Unit,
    alpha: number,
    dt: number,
    time: number,
    fogEnabled: boolean,
  ): void {
    // Interpolate between the last two simulation positions.
    const x = unit.prevPos.x + (unit.pos.x - unit.prevPos.x) * alpha;
    const z = unit.prevPos.y + (unit.pos.y - unit.prevPos.y) * alpha;
    const lift = dashHeight(unit);

    view.group.position.set(x, 0, z);
    // Simulation facing is measured from +y with atan2(x, y), and the sim's y
    // axis is the world's z axis, so it maps to rotation.y with no correction.
    view.body.rotation.y = unit.facing;

    this.syncEquipment(view, unit);

    // --- attack animation ---------------------------------------------------
    const windupTotal = attackInterval(unit) * unit.stats.attackWindup;
    if (unit.attack.windup >= 0) {
      view.attackTotal = windupTotal + ATTACK_FOLLOW_THROUGH;
      view.attackTimer = unit.attack.windup + ATTACK_FOLLOW_THROUGH;
    } else if (view.attackTimer > 0) {
      view.attackTimer = Math.max(0, view.attackTimer - dt);
    }
    const attackProgress =
      view.attackTimer > 0 ? 1 - view.attackTimer / Math.max(0.001, view.attackTotal) : -1;

    // --- cast animation -----------------------------------------------------
    let castProgress = -1;
    if (unit.cast && unit.cast.phase === CastPhase.Windup) {
      if (view.castTotal <= 0) view.castTotal = Math.max(unit.cast.timer, 0.08);
      castProgress = 1 - unit.cast.timer / view.castTotal;
    } else {
      view.castTotal = 0;
    }

    // --- death --------------------------------------------------------------
    const dead = unit.hp <= 0 || !unit.alive;
    view.deathTimer = dead ? view.deathTimer + dt : 0;
    const deathProgress = dead ? clamp01(view.deathTimer / 0.55) : 0;

    const speed = Math.hypot(unit.vel.x, unit.vel.y);
    poseFor(view, {
      speed,
      time,
      dt,
      attack: attackProgress,
      // The damage lands where the windup ends, and the follow-through is what
      // is left of the animation after it.
      strike: 1 - ATTACK_FOLLOW_THROUGH / Math.max(0.001, view.attackTotal),
      cast: castProgress,
      death: deathProgress,
      lift,
    });

    // --- fog visibility -----------------------------------------------------
    const visibleBit = 1 << this.viewTeam;
    const shouldShow =
      !fogEnabled || this.viewTeam === Team.Neutral || (unit.visibleTo & visibleBit) !== 0;
    const targetVisibility = shouldShow ? 1 : 0;
    // Ease so a unit stepping into brush fades rather than blinking out.
    view.visibility += (targetVisibility - view.visibility) * Math.min(1, dt * 14);
    view.group.visible = view.visibility > 0.03 && !(dead && unit.kind === UnitKind.Champion && view.deathTimer > CORPSE_DURATION);

    // --- selection ring -----------------------------------------------------
    const selected = this.selection.has(unit.id);
    const hovered = this.hovered === unit.id;
    let opacity = selected ? 0.95 : hovered ? 0.6 : 0.28;
    if (dead) opacity *= 0.2;
    view.ringMaterial.opacity = opacity * view.visibility;
    view.ringMaterial.color.setHex(selected ? 0xffffff : TEAM_COLOR[unit.team]);
    const ringScale = unit.radius * (selected ? 1.75 : 1.5);
    view.ring.scale.setScalar(ringScale);
    view.ring.visible = this.ringsVisible && (!view.isTower || selected || hovered);
  }

  /**
   * Hangs equipped item meshes from the rig.
   *
   * The generated weapon replaces the procedural one rather than sitting beside
   * it, and it is parented to the same joint, so it inherits the whole attack
   * animation for free. That is the payoff for keeping the rig as plain scene
   * graph nodes: a mesh that has never been rigged still swings correctly
   * because the arm it is attached to is what moves. A skinned body's hand is a
   * bone, which is a scene graph node too, so the same holds for it.
   */
  private syncEquipment(view: UnitView, unit: Unit): void {
    if (!this.assets || view.isTower) return;
    const { rig, skinned } = view;

    for (const slot of EQUIP_SLOTS) {
      const wanted = unit.equipment[slot] ?? '';
      if (view.equipped[slot] === wanted) continue;

      // Drop whatever was in this slot.
      for (let i = view.attached.length - 1; i >= 0; i--) {
        const mesh = view.attached[i];
        if (mesh.userData.slot !== slot) continue;
        mesh.parent?.remove(mesh);
        view.attached.splice(i, 1);
      }

      view.equipped[slot] = wanted;
      const joint = skinned
        ? slot === 'weapon'
          ? skinned.weaponJoint
          : skinned.offhandJoint
        : slot === 'weapon'
          ? (rig?.weapon ?? null)
          : (rig?.leftArm ?? null);
      if (!joint) continue;

      // With nothing equipped, show the character's own weapon again.
      if (!wanted) {
        if (slot === 'weapon') rig?.weapon?.children.forEach((c) => (c.visible = true));
        continue;
      }

      const geo = this.assets.geometry(wanted);
      if (!geo) {
        // Not resident yet. Request it and try again on a later frame.
        view.equipped[slot] = '';
        void this.assets.load(wanted);
        continue;
      }

      if (slot === 'weapon') rig?.weapon?.children.forEach((c) => (c.visible = false));

      const mesh = new Mesh(geo, this.assets.materialFor(wanted));
      mesh.userData.slot = slot;
      mesh.castShadow = true;
      // Items are authored at a size that suits a standard champion, so they
      // are scaled to whoever is actually holding them. Without this an imp
      // picking up a greatsword carries something taller than itself.
      const bearer = archetype(unit.archetype).style.scale ?? 1;
      if (skinned) {
        // A bone lives inside a model scaled from metres to world units, so the
        // item undoes that scale. A weapon goes where the hand's own knuckle
        // bones put a fist; an off-hand item keeps a plain offset.
        mesh.scale.setScalar(bearer / skinned.modelScale);
        const grip = slot === 'weapon' ? skinned.grip(joint) : null;
        if (grip) {
          mesh.position.copy(grip.position);
          mesh.quaternion.setFromUnitVectors(UP, grip.direction);
        } else {
          mesh.position.set(0, 0.09, 0.02);
          mesh.rotation.set(0, 0, Math.PI / 2);
        }
      } else {
        mesh.scale.setScalar(bearer);
        // The mesh's origin is its base, which for a weapon is the butt of the
        // grip, so it hangs from the hand with only a small offset.
        mesh.position.set(0, -0.08 * bearer, 0);
        mesh.rotation.set(slot === 'weapon' ? -0.35 : -1.45, 0, slot === 'weapon' ? 0 : Math.PI / 2);
      }
      joint.add(mesh);
      view.attached.push(mesh);
    }
  }

  /**
   * Screen-space unit picking.
   *
   * Projecting a handful of unit centres and comparing pixel distances beats
   * raycasting the actual meshes: limbs are thin, so a mesh raycast misses
   * clicks a player expects to land, and this way the clickable area matches
   * the ring drawn under the unit.
   */
  pickAt(camera: RtsCamera, pixelX: number, pixelY: number, filter?: (u: Unit) => boolean): EntityId {
    const units = this.world.units;
    let best: EntityId = 0;
    let bestScore = Infinity;

    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (unit.hp <= 0 || !unit.alive) continue;
      const view = this.views.get(unit.id);
      if (!view || !view.group.visible) continue;
      if (filter && !filter(unit)) continue;

      camera.worldToScreen(unit.pos.x, 0.9, unit.pos.y, this.screen);
      if (this.screen.z > 1) continue; // behind the camera

      const dx = this.screen.x - pixelX;
      const dy = this.screen.y - pixelY;
      const distance = Math.hypot(dx, dy);

      // Clickable radius in pixels, derived from the unit's world radius so
      // zooming does not change how easy something is to click.
      const worldPerPixel = camera.pixelScaleAtGround();
      const pixelRadius = Math.max(16, (unit.radius * 2.1) / worldPerPixel);
      if (distance > pixelRadius) continue;

      // Prefer the closest to the cursor, breaking ties towards the camera.
      const score = distance - unit.radius * 4;
      if (score < bestScore) {
        bestScore = score;
        best = unit.id;
      }
    }
    return best;
  }

  /** Screen position of a unit's overhead anchor, for HUD elements. */
  anchorFor(camera: RtsCamera, unit: Unit, out: Vector3): Vector3 {
    const arch = archetype(unit.archetype);
    const height = arch.mesh === 'tower' ? 5.6 : 2.35 * (arch.style.scale ?? 1);
    return camera.worldToScreen(unit.pos.x, height, unit.pos.y, out);
  }

  /** How visible a unit is to the viewing team, 0..1, for overlay fading. */
  visibilityOf(id: EntityId): number {
    return this.views.get(id)?.visibility ?? 0;
  }

  dispose(): void {
    for (const view of this.views.values()) this.destroyView(view);
    this.views.clear();
    this.ringGeometry.dispose();
    this.ringTexture.dispose();
  }
}

const EQUIP_SLOTS = ['weapon', 'offhand'] as const;

const UP = new Vector3(0, 1, 0);

function poseFor(view: UnitView, input: PoseInput): void {
  if (view.skinned) view.skinned.pose(input);
  else if (view.rig && view.isTower) poseTower(view.rig, input);
  else if (view.rig) poseCharacter(view.rig, input);
}
