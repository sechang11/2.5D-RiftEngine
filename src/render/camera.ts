/**
 * The MOBA camera: fixed pitch, fixed yaw, free to slide over the ground plane.
 *
 * Locking the angle is what makes a 2.5D game 2.5D. The player never rotates
 * the view, so every unit can be drawn facing the way it faces in the
 * simulation, screen-space and world-space directions stay in a fixed
 * relationship, and a click maps to exactly one ground point.
 *
 * The camera exposes that mapping in both directions: `screenToGround` for
 * turning clicks into orders, and `worldToScreen` for the 2D overlay that draws
 * health bars and floating text.
 *
 * The one exception is the showcase, which exists to look at a single model
 * from every side. It turns the yaw and raises the point the camera looks at as
 * it closes in. Neither changes anything while playing: the yaw stays at zero
 * and the look height is zero at play distance.
 */

import { PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { clamp, damp, DEG2RAD } from '../core/math/scalar';
import type { Vec2 } from '../core/math/vec2';

export interface CameraBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface RtsCameraOptions {
  /** Angle below the horizon, in degrees, at playing distance and beyond. */
  pitchDegrees?: number;
  /** Angle at full zoom-in. Lower means more facade and less roof. */
  minPitchDegrees?: number;
  /** Distance below which the pitch starts easing towards `minPitchDegrees`. */
  pitchEaseDistance?: number;
  minDistance?: number;
  maxDistance?: number;
  distance?: number;
  /** World units per second of keyboard panning at default zoom. */
  panSpeed?: number;
  /** Screen margin in pixels that triggers edge panning. */
  edgeMargin?: number;
  bounds?: CameraBounds;
  /**
   * Height the camera looks at when fully zoomed in, easing to the ground by
   * `pitchEaseDistance`. Zero keeps it on the ground, which at eye level frames
   * a character's feet.
   */
  focusHeight?: number;
  /** Starting yaw in radians. Zero looks along -z. */
  yaw?: number;
}

const GROUND = new Plane(new Vector3(0, 1, 0), 0);

export class RtsCamera {
  readonly camera: PerspectiveCamera;

  /** Ground point the camera is centred on. */
  readonly focus = new Vector3(0, 0, 0);
  private readonly smoothFocus = new Vector3(0, 0, 0);

  distance: number;
  private smoothDistance: number;
  private readonly basePitch: number;
  private readonly minPitch: number;
  private readonly pitchEaseDistance: number;
  private readonly focusHeight: number;

  /** Rotation about the vertical, in radians. Zero while playing. */
  yaw: number;
  private smoothYaw: number;

  /**
   * Current angle below the horizon.
   *
   * Fixed for the whole playing range, which is what keeps the view 2.5D: a
   * click maps to one ground point and a unit's facing is the facing it has in
   * the simulation. Below `pitchEaseDistance` it tips towards the horizontal,
   * because at that range nobody is playing — they have zoomed in to look at
   * something, and from directly above a building is a roof.
   */
  get pitch(): number {
    return this.minPitch + (this.basePitch - this.minPitch) * (1 - this.closeness);
  }

  /**
   * How far into the close-up range the camera is: zero at `pitchEaseDistance`
   * and beyond, one at `minDistance`. Eased, so the tilt is barely there for
   * the first part of the zoom and arrives as the camera actually gets close.
   */
  private get closeness(): number {
    const span = this.pitchEaseDistance - this.minDistance;
    if (span <= 1e-3) return 0;
    const t = clamp((this.smoothDistance - this.minDistance) / span, 0, 1);
    return 1 - t * t;
  }

  /** When set, the camera follows this point every frame. */
  followTarget: Vec2 | null = null;
  /** Edge panning is off while the pointer is over the HUD. */
  edgePanEnabled = true;

  readonly minDistance: number;
  readonly maxDistance: number;
  readonly panSpeed: number;
  readonly edgeMargin: number;
  bounds: CameraBounds;

  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly hit = new Vector3();
  private viewportWidth = 1;
  private viewportHeight = 1;

  constructor(aspect: number, opts: RtsCameraOptions = {}) {
    this.basePitch = (opts.pitchDegrees ?? 58) * DEG2RAD;
    this.minPitch = (opts.minPitchDegrees ?? 24) * DEG2RAD;
    this.pitchEaseDistance = opts.pitchEaseDistance ?? 26;
    this.minDistance = opts.minDistance ?? 5;
    this.maxDistance = opts.maxDistance ?? 210;
    this.distance = opts.distance ?? 46;
    this.smoothDistance = this.distance;
    this.panSpeed = opts.panSpeed ?? 46;
    this.edgeMargin = opts.edgeMargin ?? 8;
    this.bounds = opts.bounds ?? { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
    this.focusHeight = opts.focusHeight ?? 0;
    this.yaw = opts.yaw ?? 0;
    this.smoothYaw = this.yaw;

    // The far plane has to clear the whole map from the top of the zoom range,
    // and the near plane has to let the camera get close enough to read a
    // mortar joint. Both were sized for a fixed 22-to-88 range and neither
    // survived widening it.
    this.camera = new PerspectiveCamera(46, aspect, 0.4, 2200);
    this.applyTransform();
  }

  resize(width: number, height: number): void {
    this.viewportWidth = width;
    this.viewportHeight = height;
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Snaps the camera to a point with no easing. */
  jumpTo(x: number, y: number): void {
    this.focus.set(x, 0, y);
    this.smoothFocus.copy(this.focus);
    this.clampFocus(this.smoothFocus);
    this.smoothYaw = this.yaw;
    this.applyTransform();
  }

  centreOn(x: number, y: number): void {
    this.focus.set(x, 0, y);
  }

  /** Pans in world space. */
  pan(dx: number, dz: number): void {
    this.focus.x += dx;
    this.focus.z += dz;
    this.followTarget = null;
  }

  zoomBy(steps: number): void {
    // Multiplicative zoom keeps each notch feeling the same size at any distance.
    this.distance = clamp(this.distance * Math.pow(1.12, steps), this.minDistance, this.maxDistance);
  }

  /** Turns the view about the point it is centred on. */
  orbit(radians: number): void {
    this.yaw += radians;
  }

  /**
   * Advances camera easing.
   *
   * `panX`/`panY` are normalised axis inputs in [-1,1] from keys and screen
   * edges combined, in screen directions: they are turned by the yaw, so up is
   * away from the camera however it faces. Pan speed scales with zoom so a
   * zoomed-out camera crosses the map at a sensible rate rather than crawling.
   */
  update(dt: number, panX: number, panY: number): void {
    if (panX !== 0 || panY !== 0) {
      const speed = this.panSpeed * (0.55 + this.smoothDistance / this.maxDistance);
      const len = Math.hypot(panX, panY) || 1;
      const cos = Math.cos(this.smoothYaw);
      const sin = Math.sin(this.smoothYaw);
      const worldX = panX * cos + panY * sin;
      const worldZ = -panX * sin + panY * cos;
      this.focus.x += (worldX / len) * speed * dt;
      this.focus.z += (worldZ / len) * speed * dt;
      this.followTarget = null;
    } else if (this.followTarget) {
      this.focus.x = this.followTarget.x;
      this.focus.z = this.followTarget.y;
    }

    this.clampFocus(this.focus);

    // Exponential easing: frame-rate independent and never overshoots.
    this.smoothFocus.x = damp(this.smoothFocus.x, this.focus.x, 18, dt);
    this.smoothFocus.z = damp(this.smoothFocus.z, this.focus.z, 18, dt);
    this.smoothDistance = damp(this.smoothDistance, this.distance, 12, dt);
    this.smoothYaw = damp(this.smoothYaw, this.yaw, 12, dt);

    this.applyTransform();
  }

  private clampFocus(v: Vector3): void {
    v.x = clamp(v.x, this.bounds.minX, this.bounds.maxX);
    v.z = clamp(v.z, this.bounds.minY, this.bounds.maxY);
  }

  private applyTransform(): void {
    const d = this.smoothDistance;
    const height = Math.sin(this.pitch) * d;
    const back = Math.cos(this.pitch) * d;
    const lift = this.focusHeight * this.closeness;
    this.camera.position.set(
      this.smoothFocus.x + Math.sin(this.smoothYaw) * back,
      height + lift,
      this.smoothFocus.z + Math.cos(this.smoothYaw) * back,
    );
    this.camera.lookAt(this.smoothFocus.x, lift, this.smoothFocus.z);
    this.camera.updateMatrixWorld();
  }

  /**
   * Converts a pixel position to the point where its ray meets the ground.
   * Returns false when the ray points at the sky, which happens near the top of
   * the screen at shallow pitches.
   */
  screenToGround(pixelX: number, pixelY: number, out: Vec2): boolean {
    this.ndc.x = (pixelX / this.viewportWidth) * 2 - 1;
    this.ndc.y = -((pixelY / this.viewportHeight) * 2 - 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    const point = this.raycaster.ray.intersectPlane(GROUND, this.hit);
    if (!point) return false;
    out.x = point.x;
    out.y = point.z;
    return true;
  }

  /** Ray for picking units, in world space. */
  pickRay(pixelX: number, pixelY: number): Raycaster {
    this.ndc.x = (pixelX / this.viewportWidth) * 2 - 1;
    this.ndc.y = -((pixelY / this.viewportHeight) * 2 - 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster;
  }

  /**
   * Projects a world point to pixels. `out.z` carries the normalised depth, so
   * callers can cull anything behind the camera by testing `out.z > 1`.
   */
  worldToScreen(x: number, y: number, z: number, out: Vector3): Vector3 {
    out.set(x, y, z);
    out.project(this.camera);
    const sx = (out.x * 0.5 + 0.5) * this.viewportWidth;
    const sy = (-out.y * 0.5 + 0.5) * this.viewportHeight;
    const depth = out.z;
    out.set(sx, sy, depth);
    return out;
  }

  /** World-space size of one screen pixel at ground level, for scaling decals. */
  pixelScaleAtGround(): number {
    const vfov = this.camera.fov * DEG2RAD;
    const height = 2 * Math.tan(vfov / 2) * this.smoothDistance;
    return height / this.viewportHeight;
  }

  get currentDistance(): number {
    return this.smoothDistance;
  }

  /** Half-extent of the visible ground area, for minimap viewport drawing. */
  visibleHalfExtent(out: Vec2): void {
    const vfov = this.camera.fov * DEG2RAD;
    const h = 2 * Math.tan(vfov / 2) * this.smoothDistance;
    out.y = (h / Math.sin(this.pitch)) * 0.5;
    out.x = (h * this.camera.aspect) * 0.5;
  }

  get focusX(): number {
    return this.smoothFocus.x;
  }

  get focusY(): number {
    return this.smoothFocus.z;
  }
}
