/**
 * The renderer: scene setup, lighting, and the per-frame draw.
 *
 * This module owns everything WebGL and nothing about gameplay. It reads
 * simulation state, never writes it. The one piece of real cleverness is the
 * shadow camera, which is parented to the view rather than the map: a
 * directional light covering a 300-unit map would need an enormous shadow map
 * to look sharp, so instead a small, tight frustum follows what the player is
 * actually looking at.
 */

import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PCFSoftShadowMap,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import type { Sim } from '../core/sim/sim';
import type { GameMap } from '../game/content/map01';
import { Team } from '../core/ecs/types';
import { SimEventType } from '../core/events/bus';
import { Terrain, type GroundSurfaces } from './terrain';
import { UnitViews } from './unitview';
import { Indicators } from './indicators';
import { Effects } from './fx';
import { Overlay } from './overlay';
import { RtsCamera } from './camera';
import { PropViews } from './propview';
import type { AssetRegistry } from './assets';
import type { PropStore } from '../core/world/props';

const SKY_COLOR = 0x0d1420;
const HORIZON_FOG_NEAR = 120;
const HORIZON_FOG_FAR = 260;

/** Half-extent of the shadow frustum in world units. */
const SHADOW_EXTENT = 46;

export interface RendererOptions {
  viewTeam?: Team;
  fogEnabled?: boolean;
  showGrid?: boolean;
  shadows?: boolean;
  /** Supplies meshes for placed props and equipped items. */
  assets?: AssetRegistry;
  /** Placed props to draw. */
  props?: PropStore;
  /** Extrusion height for blocked cells. Low values suit interiors. */
  wallHeight?: number;
  wallVariation?: number;
  /** Which two surfaces the ground is made of, when a material pack is loaded. */
  ground?: GroundSurfaces;
}

export class Renderer {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera: RtsCamera;
  readonly terrain: Terrain;
  readonly views: UnitViews;
  readonly propViews: PropViews | null = null;
  readonly indicators: Indicators;
  readonly effects: Effects;
  readonly overlay: Overlay;

  /** Milliseconds spent in the last draw call, for the performance panel. */
  frameMs = 0;

  private readonly sim: Sim;
  private readonly sun: DirectionalLight;
  private readonly container: HTMLElement;
  private viewTeam: Team;
  private fogEnabled: boolean;
  private width = 1;
  private height = 1;

  constructor(
    container: HTMLElement,
    canvas: HTMLCanvasElement,
    overlayCanvas: HTMLCanvasElement,
    sim: Sim,
    map: GameMap,
    opts: RendererOptions = {},
  ) {
    this.container = container;
    this.sim = sim;
    this.viewTeam = opts.viewTeam ?? Team.Blue;
    this.fogEnabled = opts.fogEnabled !== false;

    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = opts.shadows !== false;
    this.renderer.shadowMap.type = PCFSoftShadowMap;

    this.scene.background = new Color(SKY_COLOR);
    // Distance fade hides the map's hard edge without hiding anything playable.
    this.scene.fog = new Fog(SKY_COLOR, HORIZON_FOG_NEAR, HORIZON_FOG_FAR);

    // Sky and bounce light. Warm above, cool from the ground, which keeps
    // shadowed sides readable instead of black. The ground term is brighter
    // than a real bounce because generated buildings are hollow shells: with a
    // dark bounce, every doorway and missing wall is a black hole.
    const hemi = new HemisphereLight(0xbcd6ff, 0x4a4536, 1.2);
    this.scene.add(hemi);

    this.sun = new DirectionalLight(0xfff0d8, 2.1);
    this.sun.castShadow = opts.shadows !== false;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 220;
    this.sun.shadow.camera.left = -SHADOW_EXTENT;
    this.sun.shadow.camera.right = SHADOW_EXTENT;
    this.sun.shadow.camera.top = SHADOW_EXTENT;
    this.sun.shadow.camera.bottom = -SHADOW_EXTENT;
    // A small negative bias fixes shadow acne on the large flat ground plane.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    this.camera = new RtsCamera(1, {
      pitchDegrees: 57,
      distance: 38,
      // Wide enough at the bottom to stand at a wall and read the stonework,
      // and at the top to see a whole city district at once. Playing happens
      // in the middle of that range; the ends are for looking.
      minDistance: 5,
      maxDistance: 210,
      minPitchDegrees: 24,
      pitchEaseDistance: 26,
      bounds: map.bounds,
    });

    this.terrain = new Terrain(map, sim.fog, this.viewTeam, {
      fogEnabled: this.fogEnabled,
      showGrid: opts.showGrid,
      wallHeight: opts.wallHeight,
      wallVariation: opts.wallVariation,
      surfaces: opts.assets?.surfaces,
      ground: opts.ground,
    });
    this.scene.add(this.terrain.group);

    this.views = new UnitViews(this.scene, sim.world, this.viewTeam, opts.assets);
    if (opts.assets && opts.props) {
      this.propViews = new PropViews(this.scene, opts.assets, opts.props);
    }
    this.indicators = new Indicators();
    this.scene.add(this.indicators.group);
    this.effects = new Effects(this.scene);
    this.overlay = new Overlay(overlayCanvas);

    this.resize();
  }

  resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.floor(rect.width));
    this.height = Math.max(1, Math.floor(rect.height));
    // Cap the pixel ratio: a 4K display at native ratio quadruples fragment
    // cost for a difference nobody sees on a top-down view.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.resize(this.width, this.height);
    this.overlay.resize(this.width, this.height, dpr);
  }

  setViewTeam(team: Team): void {
    this.viewTeam = team;
    this.terrain.setViewTeam(team);
    this.views.setViewTeam(team);
  }

  setFogEnabled(enabled: boolean): void {
    this.fogEnabled = enabled;
    this.terrain.setFogEnabled(enabled);
    if (!enabled) this.sim.fog.revealAll();
  }

  get isFogEnabled(): boolean {
    return this.fogEnabled;
  }

  setGrid(enabled: boolean): void {
    this.terrain.setGrid(enabled);
  }

  /**
   * Draws one frame.
   *
   * `dt` is real elapsed time, not simulation time, so animations stay smooth
   * even when the simulation is paused or slowed.
   */
  render(dt: number, time: number, showPaths: boolean): void {
    const started = performance.now();
    const sim = this.sim;

    // Simulation events become visual effects. Draining here rather than in the
    // sim keeps the sim free of any view dependency.
    sim.world.events.drain((event) => {
      this.overlay.consume(event, sim.world);
      switch (event.type) {
        case SimEventType.Impact:
          this.effects.spawnImpact(event.x, event.y, 0xffb070, event.amount || 1, (event.amount || 1) * 1.6, 0.4);
          break;
        case SimEventType.ProjectileHit:
          this.effects.spawnImpact(event.x, event.y, 0xbfe4ff, 0.4, 1.4, 0.25);
          break;
        case SimEventType.Death:
          this.effects.spawnImpact(event.x, event.y, 0xff7a5a, 0.6, 3.2, 0.5);
          break;
        case SimEventType.Spawn:
          this.effects.spawnImpact(event.x, event.y, 0x8fffc4, 0.5, 3.0, 0.5);
          break;
        default:
          break;
      }
    });

    this.terrain.uploadFog();
    this.views.update(sim.alpha, dt, time, this.fogEnabled);
    this.propViews?.update(time);
    this.effects.syncProjectiles(sim.world, sim.alpha);
    this.effects.syncTelegraphs(sim.world);
    this.effects.update(dt);
    this.indicators.update(dt);

    this.updateSun();
    this.updateFog();

    this.renderer.render(this.scene, this.camera.camera);

    this.overlay.draw(
      sim.world,
      this.camera,
      this.views,
      this.viewTeam,
      this.views.selection,
      dt,
      this.fogEnabled,
    );

    void showPaths;
    this.frameMs = performance.now() - started;
  }

  /**
   * Keeps the distance haze proportional to how far the camera can see.
   *
   * Fixed near and far planes were tuned for a camera that lived between 22 and
   * 78 units out. Zoomed all the way back, the far half of a city sat beyond
   * the old far plane and dissolved into sky; zoomed all the way in, the haze
   * started closer than the building being inspected. The coefficients are
   * chosen to reproduce the original 120 and 260 at the default distance.
   */
  private updateFog(): void {
    const fog = this.scene.fog as Fog | null;
    if (!fog) return;
    const d = this.camera.currentDistance;
    fog.near = d * 1.1 + 78;
    fog.far = d * 2.6 + 161;
  }

  /**
   * Keeps the shadow frustum centred on what the camera is looking at.
   *
   * The sun sits on the camera's side of the world, not behind it. The yaw is
   * fixed, so a light at negative Z put every visible face in shadow: with flat
   * category colours that read as moody, and with real materials it read as
   * broken — pale cream stone rendered as wet slate, and the texture work was
   * invisible until the light came round to the front.
   */
  private updateSun(): void {
    const fx = this.camera.focusX;
    const fz = this.camera.focusY;
    this.sun.position.set(fx - 52, 88, fz + 46);
    this.sun.target.position.set(fx, 0, fz);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.views.dispose();
    this.effects.dispose();
    this.renderer.dispose();
  }
}
