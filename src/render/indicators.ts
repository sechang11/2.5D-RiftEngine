/**
 * Ground decals that tell the player what is about to happen.
 *
 * Targeting indicators, click feedback and the debug path overlay all live
 * here. They are plain meshes lying on the ground plane rather than screen-space
 * UI, so they sit in the world correctly: a range circle is clipped by the
 * camera exactly like the ground it describes, and it scales with zoom for free.
 *
 * Everything is allocated once and toggled with `visible`. These change every
 * frame, and rebuilding geometry per frame is how a renderer ends up
 * garbage-collecting mid-fight.
 */

import {
  AdditiveBlending,
  CircleGeometry,
  DoubleSide,
  Group,
  Line,
  BufferGeometry,
  LineBasicMaterial,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Float32BufferAttribute,
  type Texture,
} from 'three';
import { IndicatorShape, type AbilityDef } from '../core/abilities/types';
import type { Unit } from '../core/ecs/types';
import type { Vec2 } from '../core/math/vec2';
import { clamp01 } from '../core/math/scalar';
import { createRingTexture } from './textures/procedural';

/** Maximum waypoints the debug path overlay will draw. */
const MAX_PATH_POINTS = 64;

export class Indicators {
  readonly group = new Group();

  private readonly ringTexture: Texture;

  /** Circle at the caster showing maximum cast range. */
  private readonly rangeRing: Mesh;
  private readonly rangeMaterial: MeshBasicMaterial;

  /** Filled disc at the cursor for area spells. */
  private readonly areaDisc: Mesh;
  private readonly areaRing: Mesh;
  private readonly areaMaterial: MeshBasicMaterial;
  private readonly areaRingMaterial: MeshBasicMaterial;

  /** Rectangle from the caster towards the cursor for skillshots. */
  private readonly lineMesh: Mesh;
  private readonly lineMaterial: MeshBasicMaterial;

  /** Sector for cone spells. */
  private coneMesh: Mesh;
  private readonly coneMaterial: MeshBasicMaterial;
  private coneAngle = -1;

  /** Ring showing the selected unit's auto-attack reach. */
  private readonly attackRing: Mesh;
  private readonly attackMaterial: MeshBasicMaterial;

  /** Expanding ring where the player last issued a move order. */
  private readonly moveMarker: Mesh;
  private readonly moveMaterial: MeshBasicMaterial;
  private moveMarkerAge = Infinity;

  /** Polyline of the selected unit's current path. */
  private readonly pathLine: Line;
  private readonly pathPositions: Float32Array;
  private readonly pathGeometry: BufferGeometry;

  constructor() {
    this.ringTexture = createRingTexture(256, 0.035, 0.02);

    const ringGeo = new CircleGeometry(1, 64);

    this.rangeMaterial = new MeshBasicMaterial({
      map: this.ringTexture,
      color: 0x9fd4ff,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.rangeRing = this.groundMesh(ringGeo, this.rangeMaterial, 0.05);

    this.areaMaterial = new MeshBasicMaterial({
      color: 0xff9a4a,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: DoubleSide,
    });
    this.areaDisc = this.groundMesh(new CircleGeometry(1, 48), this.areaMaterial, 0.06);

    this.areaRingMaterial = new MeshBasicMaterial({
      map: createRingTexture(256, 0.07, 0.02),
      color: 0xffc27a,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.areaRing = this.groundMesh(ringGeo.clone(), this.areaRingMaterial, 0.07);

    this.lineMaterial = new MeshBasicMaterial({
      color: 0x8fd0ff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      side: DoubleSide,
    });
    // A unit rectangle anchored at one edge and baked flat, extending along
    // local +Z. Anchoring at the edge means scaling grows it forwards from the
    // caster rather than about its centre, and choosing +Z as "forward" makes
    // its rotation.y identical to a unit's facing angle, so no correction term
    // is needed anywhere.
    const lineGeo = new PlaneGeometry(1, 1);
    lineGeo.translate(0, 0.5, 0);
    lineGeo.rotateX(Math.PI / 2);
    this.lineMesh = new Mesh(lineGeo, this.lineMaterial);
    this.lineMesh.position.y = 0.06;
    this.lineMesh.renderOrder = 3;
    this.lineMesh.visible = false;
    this.group.add(this.lineMesh);

    this.coneMaterial = new MeshBasicMaterial({
      color: 0x8fd0ff,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      side: DoubleSide,
    });
    this.coneMesh = this.groundMesh(new CircleGeometry(1, 24, 0, 1), this.coneMaterial, 0.06);

    this.attackMaterial = new MeshBasicMaterial({
      map: createRingTexture(256, 0.02, 0.015),
      color: 0xffffff,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.attackRing = this.groundMesh(ringGeo.clone(), this.attackMaterial, 0.045);

    this.moveMaterial = new MeshBasicMaterial({
      map: createRingTexture(128, 0.16, 0.06),
      color: 0x7dffa8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.moveMarker = this.groundMesh(ringGeo.clone(), this.moveMaterial, 0.08);

    this.pathPositions = new Float32Array(MAX_PATH_POINTS * 3);
    this.pathGeometry = new BufferGeometry();
    this.pathGeometry.setAttribute('position', new Float32BufferAttribute(this.pathPositions, 3));
    this.pathGeometry.setDrawRange(0, 0);
    this.pathLine = new Line(
      this.pathGeometry,
      new LineBasicMaterial({ color: 0x7dffa8, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.pathLine.visible = false;
    this.pathLine.renderOrder = 4;
    this.group.add(this.pathLine);
  }

  private groundMesh(geo: BufferGeometry, material: MeshBasicMaterial, y: number): Mesh {
    const mesh = new Mesh(geo, material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = y;
    mesh.renderOrder = 3;
    mesh.visible = false;
    this.group.add(mesh);
    return mesh;
  }

  /** Hides every targeting decal. Called at the start of each frame. */
  clearTargeting(): void {
    this.rangeRing.visible = false;
    this.areaDisc.visible = false;
    this.areaRing.visible = false;
    this.lineMesh.visible = false;
    this.coneMesh.visible = false;
  }

  /**
   * Draws the indicator for the ability the player is currently aiming.
   *
   * `cursor` is the ground point under the mouse. The indicator clamps to cast
   * range the same way the cast itself will, so what is drawn is what happens.
   */
  showAbility(def: AbilityDef, caster: Unit, cursor: Vec2): void {
    const ox = caster.pos.x;
    const oz = caster.pos.y;

    if (def.range > 0 && def.indicator !== IndicatorShape.None) {
      this.rangeRing.position.set(ox, 0.05, oz);
      this.rangeRing.scale.setScalar(def.range + caster.radius);
      this.rangeRing.visible = true;
    }

    let dx = cursor.x - ox;
    let dz = cursor.y - oz;
    const distance = Math.hypot(dx, dz) || 1;
    dx /= distance;
    dz /= distance;
    const clamped = Math.min(distance, def.range);

    switch (def.indicator) {
      case IndicatorShape.TargetCircle: {
        const px = ox + dx * clamped;
        const pz = oz + dz * clamped;
        this.areaDisc.position.set(px, 0.06, pz);
        this.areaDisc.scale.setScalar(def.radius);
        this.areaDisc.visible = true;
        this.areaRing.position.set(px, 0.07, pz);
        this.areaRing.scale.setScalar(def.radius);
        this.areaRing.visible = true;
        break;
      }
      case IndicatorShape.Line: {
        this.lineMesh.position.set(ox, 0.06, oz);
        // The geometry is already flat and points along +Z, so aiming is a
        // single yaw and the length scales on Z.
        this.lineMesh.rotation.set(0, Math.atan2(dx, dz), 0);
        this.lineMesh.scale.set(Math.max(0.2, def.radius * 2), 1, def.range);
        this.lineMesh.visible = true;
        break;
      }
      case IndicatorShape.Cone: {
        const half = def.coneAngle ?? 0.6;
        if (this.coneAngle !== half) {
          this.coneMesh.geometry.dispose();
          this.coneMesh.geometry = new CircleGeometry(1, 32, -half, half * 2);
          this.coneAngle = half;
        }
        this.coneMesh.position.set(ox, 0.06, oz);
        // The sector is a CircleGeometry still in its own XY plane, laid down
        // by the mesh's own X rotation. With Euler order XYZ the Z rotation is
        // applied first, in-plane, so it aims the sector; the later X tilt maps
        // plane +x to world +x and plane +y to world -z, which is where this
        // angle comes from.
        this.coneMesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-dz, dx));
        this.coneMesh.scale.setScalar(def.range);
        this.coneMesh.visible = true;
        break;
      }
      case IndicatorShape.RangeCircle:
      case IndicatorShape.None:
      default:
        break;
    }
  }

  /** Ring showing where the selected unit can auto-attack. */
  showAttackRange(unit: Unit | null): void {
    if (!unit || unit.hp <= 0) {
      this.attackRing.visible = false;
      return;
    }
    this.attackRing.position.set(unit.pos.x, 0.045, unit.pos.y);
    this.attackRing.scale.setScalar(unit.stats.attackRange + unit.radius);
    this.attackRing.visible = true;
  }

  /** Flashes a marker where the player clicked. */
  pingMove(x: number, y: number, hostile: boolean): void {
    this.moveMarker.position.set(x, 0.08, y);
    this.moveMarkerAge = 0;
    // Red for an attack order, green for a plain move.
    this.moveMaterial.color.setHex(hostile ? 0xff8080 : 0x7dffa8);
  }

  /** Draws the selected unit's remaining path, for debugging pathfinding. */
  showPath(unit: Unit | null, enabled: boolean): void {
    if (!enabled || !unit || unit.pathCursor >= unit.path.length) {
      this.pathLine.visible = false;
      return;
    }

    const pts = this.pathPositions;
    let n = 0;
    pts[n++] = unit.pos.x;
    pts[n++] = 0.15;
    pts[n++] = unit.pos.y;
    for (let i = unit.pathCursor; i < unit.path.length && n < pts.length - 3; i++) {
      pts[n++] = unit.path[i].x;
      pts[n++] = 0.15;
      pts[n++] = unit.path[i].y;
    }
    this.pathGeometry.attributes.position.needsUpdate = true;
    this.pathGeometry.setDrawRange(0, n / 3);
    this.pathGeometry.computeBoundingSphere();
    this.pathLine.visible = true;
  }

  /** Advances the click-marker animation. */
  update(dt: number): void {
    if (this.moveMarkerAge < 0.5) {
      this.moveMarkerAge += dt;
      const t = clamp01(this.moveMarkerAge / 0.5);
      this.moveMarker.scale.setScalar(0.5 + t * 1.5);
      this.moveMaterial.opacity = (1 - t) * 0.9;
      this.moveMarker.visible = true;
    } else {
      this.moveMarker.visible = false;
    }
  }
}
