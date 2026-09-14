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
  BackSide,
  Color,
  DataUtils,
  DirectionalLight,
  EquirectangularReflectionMapping,
  Fog,
  HalfFloatType,
  HemisphereLight,
  Mesh,
  PCFSoftShadowMap,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  ShadowMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type DataTexture,
} from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { Sim } from '../core/sim/sim';
import type { GameMap } from '../game/content/map01';
import { Team } from '../core/ecs/types';
import { SimEventType } from '../core/events/bus';
import { Terrain, type GroundSurfaces } from './terrain';
import { UnitViews } from './unitview';
import { Indicators } from './indicators';
import { Effects } from './fx';
import { Overlay } from './overlay';
import { RtsCamera, type RtsCameraOptions } from './camera';
import { PropViews } from './propview';
import type { AssetRegistry } from './assets';
import type { CharacterModels } from './characters';
import type { PropStore } from '../core/world/props';

const SKY_COLOR = 0x0d1420;
const HORIZON_FOG_NEAR = 120;
const HORIZON_FOG_FAR = 260;

/** Half-extent of the shadow frustum in world units. */
const SHADOW_EXTENT = 92;

const UP = new Vector3(0, 1, 0);

const SKY_VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize( position );
    gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
  }
`;

const SKY_FRAG = /* glsl */ `
  varying vec3 vDir;
  void main() {
    float t = clamp( vDir.y * 0.5 + 0.5, 0.0, 1.0 );
    vec3 ground = vec3( 0.17, 0.15, 0.12 );
    vec3 horizon = vec3( 0.55, 0.56, 0.58 );
    vec3 sky = vec3( 0.42, 0.55, 0.78 );
    vec3 c = t < 0.5 ? mix( ground, horizon, t * 2.0 ) : mix( horizon, sky, ( t - 0.5 ) * 2.0 );
    gl_FragColor = vec4( c, 1.0 );
  }
`;

/** Prefilters a sky gradient into an environment map, once. */
function buildSkyEnvironment(renderer: WebGLRenderer) {
  const pmrem = new PMREMGenerator(renderer);
  const scene = new Scene();
  const sphere = new Mesh(
    new SphereGeometry(1, 24, 16),
    new ShaderMaterial({ vertexShader: SKY_VERT, fragmentShader: SKY_FRAG, side: BackSide }),
  );
  scene.add(sphere);
  const target = pmrem.fromScene(scene, 0.02);
  sphere.geometry.dispose();
  (sphere.material as ShaderMaterial).dispose();
  pmrem.dispose();
  return target.texture;
}

type SkyPixels = { data: ArrayLike<number>; width: number; height: number };

function skyReader(texture: DataTexture): (v: number) => number {
  return texture.type === HalfFloatType ? (v) => DataUtils.fromHalfFloat(v) : (v) => v;
}

/**
 * The direction of the brightest pixel in an equirectangular sky, which in a
 * clear daytime photograph is the sun.
 */
function brightestDirection(texture: DataTexture): Vector3 {
  const { data, width, height } = texture.image as SkyPixels;
  const read = skyReader(texture);
  let best = -1;
  let bestX = 0;
  let bestY = 0;
  // The upper half only, two pixels at a time: the sun is a blob tens of
  // pixels across, and nothing below the horizon can be it.
  for (let y = 0; y < height / 2; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const o = (y * width + x) * 4;
      const luminance = read(data[o]) * 0.2126 + read(data[o + 1]) * 0.7152 + read(data[o + 2]) * 0.0722;
      if (luminance > best) {
        best = luminance;
        bestX = x;
        bestY = y;
      }
    }
  }
  // Row zero is the top of the photograph. three.js wraps u round from -x
  // through +z, and runs v from straight down to straight up.
  const u = (bestX + 0.5) / width;
  const v = 1 - (bestY + 0.5) / height;
  const elevation = (v - 0.5) * Math.PI;
  const azimuth = (u - 0.5) * Math.PI * 2;
  return new Vector3(
    Math.cos(azimuth) * Math.cos(elevation),
    Math.sin(elevation),
    Math.sin(azimuth) * Math.cos(elevation),
  ).normalize();
}

/** The average colour just above a sky's horizon, which is what distant ground should fade into. */
function horizonColour(texture: DataTexture): Color {
  const { data, width, height } = texture.image as SkyPixels;
  const read = skyReader(texture);
  const row = Math.floor(height * 0.48);
  const samples = 96;
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < samples; i++) {
    const o = (row * width + Math.floor((i / samples) * width)) * 4;
    r += read(data[o]);
    g += read(data[o + 1]);
    b += read(data[o + 2]);
  }
  return new Color(r / samples, g / samples, b / samples);
}

export interface SkyOptions {
  /** Light the whole scene with the sky, not only authored models. */
  world?: boolean;
  /** Show the sky behind everything. */
  background?: boolean;
  /**
   * Turn the sky so its sun sits at this azimuth, measured as atan2(x, z).
   * Left out, the sky stays as photographed.
   */
  sunAzimuth?: number;
}

export interface RendererOptions {
  viewTeam?: Team;
  fogEnabled?: boolean;
  showGrid?: boolean;
  shadows?: boolean;
  /** Supplies meshes for placed props and equipped items. */
  assets?: AssetRegistry;
  /** Authored characters, drawn in place of primitives for archetypes that name one. */
  characters?: CharacterModels;
  /** Placed props to draw. */
  props?: PropStore;
  /** Extrusion height for blocked cells. Low values suit interiors. */
  wallHeight?: number;
  wallVariation?: number;
  /** Which two surfaces the ground is made of, when a material pack is loaded. */
  ground?: GroundSurfaces;
  /** Multiplies ground layers, as hex colours. */
  groundTint?: Partial<Record<'base' | 'lane' | 'dirt', number>>;
  /** How much of the open ground's own colour to keep, from zero to one. */
  groundSaturation?: number;
  /** Whether shadows fall on the ground, which is otherwise drawn unlit. */
  groundShadows?: boolean;
  /** Overrides for the camera's zoom and tilt ranges. */
  camera?: RtsCameraOptions;
  /** Half-extent of the sun's shadow frustum. Tighter is sharper and covers less. */
  shadowExtent?: number;
  /** Multiplies the distances at which the haze begins and closes. */
  hazeScale?: number;
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
  private readonly hemi: HemisphereLight;
  /** Where the sun sits relative to the point the camera looks at. */
  private readonly sunOffset = new Vector3(-52, 88, 46);
  /** A plane that draws only the shadows falling on the ground, when asked for. */
  private readonly shadowCatcher: Mesh | null = null;
  private readonly characters: CharacterModels | null;
  private readonly hazeScale: number;
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
    this.characters = opts.characters ?? null;
    this.hazeScale = opts.hazeScale ?? 1;

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
    this.hemi = new HemisphereLight(0xbcd6ff, 0x4a4536, 1.2);
    this.scene.add(this.hemi);

    const shadowExtent = opts.shadowExtent ?? SHADOW_EXTENT;
    this.sun = new DirectionalLight(0xfff0d8, 2.1);
    this.sun.castShadow = opts.shadows !== false;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.near = 1;
    this.sun.shadow.camera.far = 260;
    this.sun.shadow.camera.left = -shadowExtent;
    this.sun.shadow.camera.right = shadowExtent;
    this.sun.shadow.camera.top = shadowExtent;
    this.sun.shadow.camera.bottom = -shadowExtent;
    // A small negative bias fixes shadow acne on the large flat ground plane.
    this.sun.shadow.bias = -0.0006;
    this.sun.shadow.normalBias = 0.035;
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // The terrain shader is unlit and takes no shadow, which is right for a
    // map-sized plane and wrong for anything standing on it: a character with
    // no shadow under it looks pasted onto the ground. So shadows get a
    // surface of their own, a transparent plane that renders only the
    // darkening, as wide as the shadow frustum and moved along with it.
    if (opts.groundShadows && opts.shadows !== false) {
      const plane = new PlaneGeometry(shadowExtent * 2, shadowExtent * 2);
      plane.rotateX(-Math.PI / 2);
      this.shadowCatcher = new Mesh(
        plane,
        new ShadowMaterial({
          opacity: 0.45,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      );
      this.shadowCatcher.receiveShadow = true;
      this.scene.add(this.shadowCatcher);
    }

    // A sky probe, because a metal without one is black.
    //
    // Physically shaded metal has no diffuse term: everything it shows is
    // reflection, and with only a sun and a hemisphere light there is nothing
    // to reflect, so every gilded and iron surface in the pack rendered as a
    // silhouette. A two-colour gradient sphere is enough to give them a sky to
    // mirror, and it warms every rough surface as well.
    this.scene.environment = buildSkyEnvironment(this.renderer);
    // Held well below one. At full strength the probe lights every rough
    // surface from every direction at once, which is exactly the light that
    // hides texture: the whole city went pale and flat the moment it was added.
    this.scene.environmentIntensity = 0.35;

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
      ...opts.camera,
    });

    this.terrain = new Terrain(map, sim.fog, this.viewTeam, {
      fogEnabled: this.fogEnabled,
      showGrid: opts.showGrid,
      wallHeight: opts.wallHeight,
      wallVariation: opts.wallVariation,
      surfaces: opts.assets?.surfaces,
      ground: opts.ground,
    });
    for (const [layer, colour] of Object.entries(opts.groundTint ?? {})) {
      this.terrain.tintGround(layer as 'base' | 'lane' | 'dirt', colour);
    }
    if (opts.groundSaturation !== undefined) this.terrain.setGroundSaturation(opts.groundSaturation);
    this.scene.add(this.terrain.group);

    // Painted textures are what anisotropic filtering exists for: at this
    // camera's angles, without it a character's cloth blurs to its average.
    this.characters?.setAnisotropy(this.renderer.capabilities.getMaxAnisotropy());
    this.views = new UnitViews(this.scene, sim.world, this.viewTeam, opts.assets, opts.characters);
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
   * Loads a photographed sky and lights authored models with it.
   *
   * The generated pack keeps the gradient probe it was balanced against: its
   * colour came off concept art and was tuned by eye under that light, and a
   * brighter, bluer sky washes it out. Painted models were balanced by their
   * authors under skies like this one, and under the gradient their leather
   * went grey and their buckles black. So by default the sky goes onto their
   * materials and nowhere else.
   *
   * `world` gives the whole scene the sky, trades most of the hemisphere fill
   * for it, and moves the sun to where the photograph has it, so shadows fall
   * the way the reflections say the light does. `background` shows it, and
   * turns the distance haze to its horizon colour so the ground fades into sky
   * rather than into a flat tint. `sunAzimuth` turns the whole sky, background,
   * reflections and sun together, so a scene can be composed first and lit
   * to suit rather than the other way round.
   *
   * Returns the direction sunlight comes from, after any turn.
   */
  async loadSky(url: string, opts: SkyOptions = {}): Promise<Vector3> {
    const texture = await new RGBELoader().loadAsync(url);
    texture.mapping = EquirectangularReflectionMapping;
    const pmrem = new PMREMGenerator(this.renderer);
    const environment = pmrem.fromEquirectangular(texture).texture;
    pmrem.dispose();

    // Turning about the vertical by θ carries a direction at azimuth φ to
    // φ + θ, in background, reflections and the sun alike.
    const found = brightestDirection(texture);
    const turn = opts.sunAzimuth === undefined ? 0 : opts.sunAzimuth - Math.atan2(found.x, found.z);
    const sun = found.clone().applyAxisAngle(UP, turn);

    this.characters?.setEnvironment(environment, 1, turn);
    if (opts.world) {
      this.scene.environment = environment;
      this.scene.environmentIntensity = 1;
      this.scene.environmentRotation.y = turn;
      this.hemi.intensity = 0.3;
      this.sunOffset.copy(sun).multiplyScalar(120);
      this.terrain.setSunDirection(sun);
    }
    if (opts.background) {
      this.scene.background = texture;
      this.scene.backgroundRotation.y = turn;
      (this.scene.fog as Fog | null)?.color.copy(horizonColour(texture));
    } else {
      texture.dispose();
    }
    return sun;
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
    fog.near = (d * 1.1 + 78) * this.hazeScale;
    fog.far = (d * 2.6 + 161) * this.hazeScale;
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
    this.sun.position.set(fx + this.sunOffset.x, this.sunOffset.y, fz + this.sunOffset.z);
    this.sun.target.position.set(fx, 0, fz);
    this.sun.target.updateMatrixWorld();
    this.sun.shadow.camera.updateProjectionMatrix();
    this.shadowCatcher?.position.set(fx, 0.02, fz);
  }

  dispose(): void {
    this.views.dispose();
    this.effects.dispose();
    this.renderer.dispose();
  }
}
