/**
 * Authored characters: skinned models with their own textures, moved by clips.
 *
 * Everything else that walks in the engine is procedural — primitives hung on
 * named joints and swung by code in `meshes/character.ts`. That holds up at
 * the game's camera height and falls apart the moment the camera comes close,
 * which is exactly where a player's own character is looked at. This is the
 * other path: a model made in a modelling package, skinned to a humanoid rig,
 * painted with PBR maps, and moved by authored animation rather than by sine
 * waves.
 *
 * Two files feed it:
 *
 *   the model     one GLB per character, from tools/characters/build.py
 *   the library   one GLB of clips shared by every character, from
 *                 tools/characters/anims.py
 *
 * The clips were keyed on a mannequin whose skeleton is close to the models'
 * and not the same: its neck sits seventeen degrees differently in its parent
 * and its hips three centimetres lower. Copying rotations across bone for bone
 * would put the mannequin's posture on every body, so each key is re-expressed
 * as a turn away from the mannequin's rest pose and applied as the same turn
 * away from the model's. See `retarget`.
 *
 * A body plays in two halves. The legs take one blend of clips and everything
 * above the pelvis another, so a character can throw a spell from its hand
 * without its feet stopping mid-stride.
 */

import {
  AnimationClip,
  AnimationMixer,
  Box3,
  Group,
  Quaternion,
  QuaternionKeyframeTrack,
  Vector3,
  VectorKeyframeTrack,
  type AnimationAction,
  type KeyframeTrack,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { clamp, clamp01, damp } from '../core/math/scalar';
import type { PoseInput } from './meshes/character';

export interface CharacterModelSpec {
  /** A GLB built by tools/characters/build.py. */
  url: string;
  /** World units from the soles to the top of the head, or of the hood. */
  height: number;
}

/**
 * Every authored character, by the id an archetype names it with.
 *
 * 2.2 is the height the procedural champion was built to and the height the
 * pack's buildings were scaled against, so an authored body at that height
 * fits the same doors.
 */
export const CHARACTER_MODELS: Record<string, CharacterModelSpec> = {
  ranger: { url: '/assets/characters/ranger.glb', height: 2.2 },
};

/** Clips shared by every character. */
export const ANIMATION_LIBRARY_URL = '/assets/characters/anims.glb';

/** Which library clip plays for each thing a unit can be doing. */
const CLIP = {
  idle: 'Idle_Loop',
  walk: 'Walk_Loop',
  jog: 'Jog_Fwd_Loop',
  sprint: 'Sprint_Loop',
  attack: 'Spell_Simple_Shoot',
  windup: 'Spell_Simple_Enter',
  release: 'Spell_Simple_Shoot',
  death: 'Death01',
} as const;

/**
 * Metres covered by one cycle of each gait, read off the library's
 * root-motion export of the same clips. Playback follows ground speed through
 * these, which is the difference between walking and skating.
 */
const STRIDE = { walk: 1.3, jog: 5.0, sprint: 5.5 };

/** Bones of the legs, for playing the two halves of a body apart. */
const LOWER_BODY = /^(root|pelvis|thigh_|calf_|foot_|ball_)/;

/** Below this ground speed, in metres per second, a body is standing. */
const STANDING = 0.25;

/**
 * How much faster than authored the fall plays. The library's takes two and a
 * half seconds, and a champion's corpse is gone in under one and a half.
 */
const DEATH_RATE = 2;

interface RestPose {
  local: Map<string, Quaternion>;
  /** Rotation in the skeleton's own frame: the root's parent, not the scene. */
  world: Map<string, Quaternion>;
  parent: Map<string, string | null>;
  position: Map<string, Vector3>;
}

interface Library {
  clips: AnimationClip[];
  rest: RestPose;
}

export interface CharacterTemplate {
  scene: Object3D;
  /** World units per metre. */
  scale: number;
  lower: Map<string, AnimationClip>;
  upper: Map<string, AnimationClip>;
  durations: Map<string, number>;
  /** Ground speed, metres per second, at which each gait plays as authored. */
  gait: { walk: number; jog: number; sprint: number };
  /** Seconds into a one-shot clip at which its hands move fastest: the throw. */
  release: Map<string, number>;
  materials: MeshStandardMaterial[];
}

/** Reads a skeleton's rest pose, walking down from its root bone. */
function restPose(root: Object3D): RestPose {
  const rest: RestPose = { local: new Map(), world: new Map(), parent: new Map(), position: new Map() };
  const visit = (node: Object3D, parent: string | null, parentWorld: Quaternion): void => {
    const world = parentWorld.clone().multiply(node.quaternion);
    rest.local.set(node.name, node.quaternion.clone());
    rest.world.set(node.name, world);
    rest.parent.set(node.name, parent);
    rest.position.set(node.name, node.position.clone());
    for (const child of node.children) visit(child, node.name, world);
  };
  visit(root, null, new Quaternion());
  return rest;
}

/**
 * Moves a clip from the skeleton it was keyed on to one with the same bones in
 * a slightly different rest pose.
 *
 * What should transfer is motion, not posture: how far each bone has turned
 * from where it rests, measured in the skeleton's frame so a nod is a nod
 * about the same axis on both bodies. For bone b under parent p that works out
 * to
 *
 *   target(b) = C · source(b) · sourceRest(b)⁻¹ · C⁻¹ · targetRest(b)
 *   where   C = targetRestWorld(p)⁻¹ · sourceRestWorld(p)
 *
 * C is how differently the two parents sit. With identical rest poses it is
 * the identity and the whole expression collapses to a straight copy. Both
 * factors either side of the key are constant per bone, so a clip retargets
 * with two multiplications a key and no forward kinematics at all.
 *
 * Translation is keyed only on the pelvis. It moves by its offset from rest,
 * scaled by the ratio of the two hip heights, so a crouch drops a tall body as
 * far in proportion as a short one.
 */
function retarget(clip: AnimationClip, source: RestPose, target: RestPose): AnimationClip {
  const hips = target.position.get('pelvis');
  const sourceHips = source.position.get('pelvis');
  // The pelvis hangs under a root turned a quarter about X, so its Z is up.
  const hipScale = hips && sourceHips && sourceHips.z > 1e-6 ? hips.z / sourceHips.z : 1;
  const q = new Quaternion();
  const tracks: KeyframeTrack[] = [];

  for (const track of clip.tracks) {
    const dot = track.name.lastIndexOf('.');
    const bone = track.name.slice(0, dot);
    const property = track.name.slice(dot + 1);
    const targetLocal = target.local.get(bone);
    const sourceLocal = source.local.get(bone);
    if (!targetLocal || !sourceLocal) continue;

    if (property === 'quaternion') {
      const parent = target.parent.get(bone) ?? null;
      const targetParent = parent ? target.world.get(parent) : undefined;
      const sourceParent = parent ? source.world.get(parent) : undefined;
      const c =
        targetParent && sourceParent ? targetParent.clone().invert().multiply(sourceParent) : new Quaternion();
      const right = sourceLocal.clone().invert().multiply(c.clone().invert()).multiply(targetLocal);
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(values, i).premultiply(c).multiply(right).toArray(values, i);
      }
      tracks.push(new QuaternionKeyframeTrack(track.name, track.times, values));
    } else if (property === 'position') {
      const from = source.position.get(bone);
      const to = target.position.get(bone);
      if (!from || !to) continue;
      const values = track.values.slice();
      for (let i = 0; i < values.length; i += 3) {
        values[i] = to.x + (values[i] - from.x) * hipScale;
        values[i + 1] = to.y + (values[i + 1] - from.y) * hipScale;
        values[i + 2] = to.z + (values[i + 2] - from.z) * hipScale;
      }
      tracks.push(new VectorKeyframeTrack(track.name, track.times, values));
    }
  }
  return new AnimationClip(clip.name, clip.duration, tracks);
}

/** Splits a clip into the tracks that move the legs and the tracks that move the rest. */
function halves(clip: AnimationClip): { lower: AnimationClip; upper: AnimationClip } {
  const lower: KeyframeTrack[] = [];
  const upper: KeyframeTrack[] = [];
  for (const track of clip.tracks) (LOWER_BODY.test(track.name) ? lower : upper).push(track);
  return {
    lower: new AnimationClip(`${clip.name}:lower`, clip.duration, lower),
    upper: new AnimationClip(`${clip.name}:upper`, clip.duration, upper),
  };
}

/**
 * Finds the moment in a one-shot clip at which either hand moves fastest.
 *
 * A clip carries no marker for when a spell leaves the hand, and the game
 * needs one: the throw has to land on the tick the simulation fires. The
 * fastest hand is the throw, near enough, and it is measured once per model
 * on a throwaway copy.
 */
function peakMotion(scene: Object3D, clip: AnimationClip): number {
  const probe = cloneSkinned(scene);
  const mixer = new AnimationMixer(probe);
  const action = mixer.clipAction(clip);
  action.play();
  const hands = ['hand_r', 'hand_l']
    .map((name) => probe.getObjectByName(name))
    .filter((o): o is Object3D => o !== undefined);
  const last = hands.map(() => new Vector3());
  const here = new Vector3();
  const step = 1 / 60;
  let fastest = -1;
  let when = clip.duration * 0.5;
  for (let t = 0; t < clip.duration - 1e-3; t += step) {
    action.time = t;
    mixer.update(0);
    probe.updateMatrixWorld(true);
    hands.forEach((hand, i) => {
      hand.getWorldPosition(here);
      const moved = t > 0 ? here.distanceTo(last[i]) : 0;
      if (moved > fastest) {
        fastest = moved;
        when = t;
      }
      last[i].copy(here);
    });
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(probe);
  return when;
}

function buildTemplate(spec: CharacterModelSpec, gltf: GLTF, library: Library): CharacterTemplate {
  const scene = gltf.scene;
  const root = scene.getObjectByName('root');
  if (!root) throw new Error(`${spec.url} has no root bone`);
  const rest = restPose(root);

  const lower = new Map<string, AnimationClip>();
  const upper = new Map<string, AnimationClip>();
  const full = new Map<string, AnimationClip>();
  const durations = new Map<string, number>();
  for (const clip of library.clips) {
    const moved = retarget(clip, library.rest, rest);
    const split = halves(moved);
    full.set(clip.name, moved);
    lower.set(clip.name, split.lower);
    upper.set(clip.name, split.upper);
    durations.set(clip.name, clip.duration);
  }
  for (const name of Object.values(CLIP)) {
    if (!full.has(name)) throw new Error(`${ANIMATION_LIBRARY_URL} has no clip ${name}`);
  }

  const materials = new Set<MeshStandardMaterial>();
  scene.traverse((object) => {
    const mesh = object as Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Bounds come from the bind pose, and a body mid-roll or lying on the
    // ground is nowhere near it. One character is cheaper to draw than to
    // watch vanish at the edge of the screen.
    mesh.frustumCulled = false;
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) materials.add(material as MeshStandardMaterial);
  });

  const extras = gltf.asset.extras as { height?: number } | undefined;
  const modelHeight = extras?.height ?? new Box3().setFromObject(scene).max.y;
  const gaitSpeed = (name: string, stride: number) => stride / (durations.get(name) ?? 1);

  const release = new Map<string, number>();
  for (const name of new Set([CLIP.attack, CLIP.release])) {
    release.set(name, peakMotion(scene, full.get(name) as AnimationClip));
  }

  return {
    scene,
    scale: spec.height / modelHeight,
    lower,
    upper,
    durations,
    gait: {
      walk: gaitSpeed(CLIP.walk, STRIDE.walk),
      jog: gaitSpeed(CLIP.jog, STRIDE.jog),
      sprint: gaitSpeed(CLIP.sprint, STRIDE.sprint),
    },
    release,
    materials: [...materials],
  };
}

/** Weights of walk, jog and sprint at a ground speed, blending neighbours. */
function gaitMix(speed: number, gait: CharacterTemplate['gait']): [number, number, number] {
  if (speed <= gait.walk) return [1, 0, 0];
  if (speed <= gait.jog) {
    const t = (speed - gait.walk) / (gait.jog - gait.walk);
    return [1 - t, t, 0];
  }
  if (speed <= gait.sprint) {
    const t = (speed - gait.jog) / (gait.sprint - gait.jog);
    return [0, 1 - t, t];
  }
  return [0, 0, 1];
}

type Overlay = 'none' | 'attack' | 'windup' | 'release' | 'death';

/**
 * One character in the world: a copy of a template with its own skeleton and
 * mixer, sharing geometry, materials and clips with every other copy.
 *
 * Nothing here advances on its own clock. Gait phase comes from distance
 * covered, one-shots from how far through its windup the simulation says an
 * attack or cast is, so a paused or slowed game poses exactly as it plays.
 */
export class SkinnedBody {
  /** Positioned and turned by the unit view. */
  readonly root = new Group();
  /** The bone a held weapon hangs from. */
  readonly weaponJoint: Object3D | null;
  /** The bone an off-hand item hangs from. */
  readonly offhandJoint: Object3D | null;
  /** World units per metre inside the model, which anything hung on a bone inherits. */
  readonly modelScale: number;

  private readonly template: CharacterTemplate;
  private readonly model: Object3D;
  private readonly mixer: AnimationMixer;
  private readonly lower = new Map<string, AnimationAction>();
  private readonly upper = new Map<string, AnimationAction>();

  private idleTime = 0;
  private gaitPhase = 0;
  private moving = 0;
  private overlay: Overlay = 'none';
  private overlayClip: string = CLIP.attack;
  private overlayTime = 0;
  private overlayWeight = 0;

  constructor(template: CharacterTemplate) {
    this.template = template;
    this.modelScale = template.scale;
    this.model = cloneSkinned(template.scene);
    this.model.scale.setScalar(template.scale);
    this.root.add(this.model);
    this.mixer = new AnimationMixer(this.model);
    for (const [name, clip] of template.lower) this.lower.set(name, this.start(clip));
    for (const [name, clip] of template.upper) this.upper.set(name, this.start(clip));
    this.weaponJoint = this.model.getObjectByName('hand_r') ?? null;
    this.offhandJoint = this.model.getObjectByName('hand_l') ?? null;
  }

  pose(p: PoseInput): void {
    const t = this.template;
    const dt = p.dt;
    const speed = Math.max(0, p.speed) / t.scale;

    this.moving = damp(this.moving, speed > STANDING ? 1 : 0, 12, dt);
    const [walk, jog, sprint] = gaitMix(speed, t.gait);
    const stride = walk * STRIDE.walk + jog * STRIDE.jog + sprint * STRIDE.sprint;
    this.gaitPhase = (this.gaitPhase + (dt * speed) / stride) % 1;
    this.idleTime = (this.idleTime + dt) % this.duration(CLIP.idle);

    this.updateOverlay(p);

    for (const action of this.lower.values()) action.setEffectiveWeight(0);
    for (const action of this.upper.values()) action.setEffectiveWeight(0);

    const m = this.moving;
    const o = this.overlay === 'none' ? 0 : this.overlayWeight;
    // The legs take the one-shot only while standing still, or into a fall.
    const legs = this.overlay === 'death' ? o : o * (1 - m);
    this.blend(CLIP.idle, 1 - m, this.idleTime, o, legs);
    this.blend(CLIP.walk, m * walk, this.gaitPhase * this.duration(CLIP.walk), o, legs);
    this.blend(CLIP.jog, m * jog, this.gaitPhase * this.duration(CLIP.jog), o, legs);
    this.blend(CLIP.sprint, m * sprint, this.gaitPhase * this.duration(CLIP.sprint), o, legs);
    if (o > 0) {
      this.set(this.upper, this.overlayClip, o, this.overlayTime);
      this.set(this.lower, this.overlayClip, legs, this.overlayTime);
    }

    this.root.position.y = p.lift;
    this.mixer.update(0);
  }

  dispose(): void {
    this.mixer.stopAllAction();
    this.mixer.uncacheRoot(this.model);
  }

  /**
   * Where an item held in a hand lies, in that hand's frame.
   *
   * The rig already says where a fist is: its knuckle bones. The butt of the
   * grip goes at the little finger's knuckle and the item runs across the fist
   * towards the index finger's, which is the line a handle takes through a
   * closed hand, with the blade coming out past the thumb.
   */
  grip(hand: Object3D): { position: Vector3; direction: Vector3 } | null {
    const side = hand.name.slice(-2);
    const index = hand.getObjectByName(`index_01${side}`);
    const little = hand.getObjectByName(`pinky_01${side}`);
    if (!index || !little) return null;
    return {
      position: little.position.clone(),
      direction: index.position.clone().sub(little.position).normalize(),
    };
  }

  private start(clip: AnimationClip): AnimationAction {
    const action = this.mixer.clipAction(clip);
    // Time is written by hand every frame, so the mixer only ever evaluates.
    action.play();
    action.setEffectiveWeight(0);
    return action;
  }

  /** Weights one base clip into both halves, leaving room for the one-shot. */
  private blend(name: string, weight: number, time: number, overlay: number, legs: number): void {
    this.set(this.upper, name, weight * (1 - overlay), time);
    this.set(this.lower, name, weight * (1 - legs), time);
  }

  private set(actions: Map<string, AnimationAction>, name: string, weight: number, time: number): void {
    const action = actions.get(name);
    if (!action || weight <= 0) return;
    action.setEffectiveWeight(action.getEffectiveWeight() + weight);
    action.time = time;
  }

  private duration(name: string): number {
    return this.template.durations.get(name) ?? 1;
  }

  /**
   * Chooses the one-shot, if any, and where in it the body is.
   *
   * Attacks and casts are mapped onto the simulation's own timeline: the
   * clip's throw lands on the fraction of the attack at which the damage
   * does, however long the unit's attack speed makes the windup.
   */
  private updateOverlay(p: PoseInput): void {
    const dt = p.dt;
    let wanted = true;

    if (p.death > 0) {
      if (this.overlay !== 'death') this.begin('death', CLIP.death);
      this.overlayTime += dt * DEATH_RATE;
    } else {
      if (this.overlay === 'death') {
        // Alive again. A respawn starts clean instead of easing out of a corpse.
        this.overlay = 'none';
        this.overlayWeight = 0;
      }
      if (p.cast >= 0) {
        if (this.overlay !== 'windup') this.begin('windup', CLIP.windup);
        this.overlayTime = clamp01(p.cast) * this.duration(CLIP.windup);
      } else if (this.overlay === 'windup') {
        // The cast went off. Pick the throw up just short of its peak, so the
        // hand moves on the frame the ability fires.
        this.begin('release', CLIP.release);
        this.overlayTime = Math.max(0, (this.template.release.get(CLIP.release) ?? 0) - 0.08);
      } else if (p.attack >= 0) {
        if (this.overlay !== 'attack') this.begin('attack', CLIP.attack);
        const strike = clamp(p.strike ?? 0.7, 0.05, 0.95);
        const peak = this.template.release.get(CLIP.attack) ?? 0;
        const k = clamp01(p.attack);
        this.overlayTime =
          k < strike
            ? (k / strike) * peak
            : peak + ((k - strike) / (1 - strike)) * (this.duration(CLIP.attack) - peak);
      } else if (this.overlay === 'release') {
        this.overlayTime += dt;
        wanted = this.overlayTime < this.duration(this.overlayClip);
      } else {
        wanted = false;
      }
    }

    this.overlayTime = Math.min(this.overlayTime, this.duration(this.overlayClip) - 1e-3);
    this.overlayWeight = damp(this.overlayWeight, wanted ? 1 : 0, this.overlay === 'death' ? 20 : 16, dt);
    if (!wanted && this.overlayWeight < 0.01) this.overlay = 'none';
  }

  private begin(kind: Overlay, clip: string): void {
    this.overlay = kind;
    this.overlayClip = clip;
    this.overlayTime = 0;
  }
}

/**
 * Loads authored characters and hands out bodies.
 *
 * Loading is up front and failure is quiet: a unit whose model is missing is
 * drawn from primitives, as every unit was before this file existed.
 */
export class CharacterModels {
  private readonly loader = new GLTFLoader();
  private readonly templates = new Map<string, CharacterTemplate>();
  private library: Promise<Library> | null = null;

  async load(ids: Iterable<string>): Promise<void> {
    await Promise.all([...new Set(ids)].map((id) => this.loadOne(id)));
  }

  has(id: string): boolean {
    return this.templates.has(id);
  }

  /** A new body for a loaded model, or null when there is none to give. */
  create(id: string): SkinnedBody | null {
    const template = this.templates.get(id);
    return template ? new SkinnedBody(template) : null;
  }

  /**
   * Gives every authored material a sky to reflect.
   *
   * Set per material rather than on the scene, because the scene's
   * environment is held down for the projected pack, and a painted model
   * lit that dimly loses its metal and its leather both.
   */
  setEnvironment(texture: Texture | null, intensity = 1, rotation = 0): void {
    for (const template of this.templates.values()) {
      for (const material of template.materials) {
        material.envMap = texture;
        material.envMapIntensity = intensity;
        // Turned with the scene's own sky, when it has been turned.
        material.envMapRotation.y = rotation;
        material.needsUpdate = true;
      }
    }
  }

  /** Keeps painted detail sharp at grazing angles, which is every angle this camera has. */
  setAnisotropy(level: number): void {
    for (const template of this.templates.values()) {
      for (const material of template.materials) {
        for (const map of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap]) {
          if (!map) continue;
          map.anisotropy = level;
          map.needsUpdate = true;
        }
      }
    }
  }

  dispose(): void {
    for (const template of this.templates.values()) {
      template.scene.traverse((object) => {
        const mesh = object as Mesh;
        if (mesh.isMesh) mesh.geometry.dispose();
      });
      for (const material of template.materials) {
        for (const map of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap]) {
          map?.dispose();
        }
        material.dispose();
      }
    }
    this.templates.clear();
  }

  private async loadOne(id: string): Promise<void> {
    if (this.templates.has(id)) return;
    const spec = CHARACTER_MODELS[id];
    if (!spec) {
      console.warn(`[characters] no model called ${id}`);
      return;
    }
    try {
      const [gltf, library] = await Promise.all([this.loader.loadAsync(spec.url), this.loadLibrary()]);
      this.templates.set(id, buildTemplate(spec, gltf, library));
    } catch (err) {
      console.warn(`[characters] ${id} did not load; its units keep their primitives:`, err);
    }
  }

  private loadLibrary(): Promise<Library> {
    this.library ??= this.loader.loadAsync(ANIMATION_LIBRARY_URL).then((gltf) => {
      const root = gltf.scene.getObjectByName('root');
      if (!root) throw new Error(`${ANIMATION_LIBRARY_URL} has no root bone`);
      return { clips: gltf.animations, rest: restPose(root) };
    });
    return this.library;
  }
}
