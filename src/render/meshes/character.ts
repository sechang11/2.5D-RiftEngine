/**
 * Procedural character meshes and their animation rig.
 *
 * Characters are assembled from primitives at runtime and posed by rotating
 * named joints. There is no skeletal animation and no imported model, which
 * suits a 2.5D game: the camera sits at a fixed distance and angle, so a few
 * hundred flat-shaded triangles read perfectly well, and a rig that is plain
 * scene-graph nodes is trivial to drive from simulation state.
 *
 * Swapping in glTF models later means replacing `buildCharacter` and keeping
 * the same pose interface.
 */

import {
  BoxGeometry,
  CapsuleGeometry,
  ConeGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SphereGeometry,
  TorusGeometry,
  DoubleSide,
  type BufferGeometry,
  type Material,
} from 'three';
import { clamp01, lerp, smoothstep } from '../../core/math/scalar';

export type WeaponKind = 'sword' | 'staff' | 'claws' | 'bow' | 'axe' | 'none';
export type HeadKind = 'helm' | 'orb' | 'horned' | 'skull' | 'beast' | 'hooded';

/**
 * How the body is put together.
 *
 * Generated meshes cannot walk: single-view reconstruction returns a static
 * surface with no skeleton. Anything that has to move is therefore still built
 * from primitives and posed by rotating named joints, and the way to get a
 * roster out of that is to vary the body plan rather than to hand-model each
 * character.
 *
 *   biped      two legs, two arms, the champion silhouette
 *   quadruped  four legs, a horizontal spine, a head out front
 *   floating   no legs at all, a hovering robe or a drifting light
 */
export type BodyPlan = 'biped' | 'quadruped' | 'floating';

export interface CharacterStyle {
  /** Armour and body plate. */
  primary: number;
  /** Cloth, leather, secondary panels. */
  secondary: number;
  /** Team colour: trim, eyes, weapon glow. */
  accent: number;
  /** Overall scale multiplier; 1 is a standard champion. */
  scale: number;
  weapon: WeaponKind;
  cape: boolean;
  head: HeadKind;
  /** Adds bulk to torso and limbs, for monsters. */
  bulk?: number;
  body?: BodyPlan;
  /** Feathered or membranous wings on the back. */
  wings?: 'none' | 'feathered' | 'bat';
  /** A trailing tail, animated with the gait. */
  tail?: boolean;
  /** A long robe skirt instead of visible legs. */
  robe?: boolean;
  /** Shoulder plates, for heavily armoured silhouettes. */
  pauldrons?: boolean;
}

export interface CharacterRig {
  root: Group;
  /** Everything above the feet, so the whole body can bob and fall over. */
  body: Group;
  torso: Object3D;
  head: Object3D;
  leftArm: Object3D;
  rightArm: Object3D;
  leftLeg: Object3D;
  rightLeg: Object3D;
  /** Rear legs on a quadruped, null otherwise. */
  leftRearLeg: Object3D | null;
  rightRearLeg: Object3D | null;
  weapon: Object3D | null;
  cape: Object3D | null;
  wings: Object3D | null;
  tail: Object3D | null;
  plan: BodyPlan;
  /** Accumulated gait phase, advanced by distance travelled. */
  phase: number;
  /** Materials owned by this rig, for disposal. */
  materials: Material[];
  geometries: BufferGeometry[];
}

export interface PoseInput {
  /** Current speed in world units per second. */
  speed: number;
  /** Seconds since the scene started, for idle motion. */
  time: number;
  /** Frame delta, for advancing the gait. */
  dt: number;
  /** 0..1 through an attack windup, or -1 when not attacking. */
  attack: number;
  /** 0..1 through a cast, or -1 when not casting. */
  cast: number;
  /** 0..1 death collapse, 0 when alive. */
  death: number;
  /** Extra height, e.g. mid-dash hop. */
  lift: number;
}

/** Reference walking speed used to normalise the gait. */
const GAIT_REFERENCE_SPEED = 7;

function mat(color: number, roughness = 0.72, metalness = 0.05): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness, flatShading: true });
}

function part(
  geo: BufferGeometry,
  material: Material,
  x = 0,
  y = 0,
  z = 0,
): Mesh {
  const mesh = new Mesh(geo, material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  return mesh;
}

/**
 * Builds a humanoid facing +Z, standing on y = 0.
 *
 * +Z is forward because the simulation's facing angle is measured from +y with
 * atan2(x, y), and the sim's y axis is the world's z axis. Keeping that
 * consistent means the renderer sets rotation.y directly from unit.facing with
 * no correction term.
 */
export function buildCharacter(style: CharacterStyle): CharacterRig {
  const plan = style.body ?? 'biped';
  if (plan === 'quadruped') return buildQuadruped(style);
  return buildBiped(style);
}

function buildBiped(style: CharacterStyle): CharacterRig {
  const s = style.scale;
  const bulk = style.bulk ?? 1;
  const plan: BodyPlan = style.body ?? 'biped';
  const floating = plan === 'floating';

  const materials: Material[] = [];
  const geometries: BufferGeometry[] = [];
  const track = <T extends BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const trackMat = (m: MeshStandardMaterial): MeshStandardMaterial => {
    materials.push(m);
    return m;
  };

  const armour = trackMat(mat(style.primary, 0.62, 0.18));
  const cloth = trackMat(mat(style.secondary, 0.9, 0));
  const accent = trackMat(
    new MeshStandardMaterial({
      color: style.accent,
      roughness: 0.35,
      metalness: 0.2,
      emissive: style.accent,
      emissiveIntensity: 0.55,
      flatShading: true,
    }),
  );
  materials.push(accent);

  const root = new Group();
  const body = new Group();
  root.add(body);

  // --- legs ---------------------------------------------------------------
  const hipY = 0.92 * s;
  const legGeo = track(new CapsuleGeometry(0.13 * s * bulk, 0.52 * s, 2, 6));

  const leftLeg = new Group();
  const rightLeg = new Group();
  leftLeg.position.set(-0.17 * s * bulk, hipY, 0);
  rightLeg.position.set(0.17 * s * bulk, hipY, 0);
  body.add(leftLeg);
  body.add(rightLeg);

  if (style.robe || floating) {
    // A robe replaces the legs with a single tapered skirt reaching the ground,
    // which is what sells a caster or a wraith from this camera angle. The leg
    // groups still exist and still swing, so the skirt sways with the gait.
    const skirtGeo = track(new ConeGeometry(0.34 * s * bulk, 0.98 * s, 8, 1, true));
    const skirt = part(skirtGeo, cloth, 0, hipY - 0.42 * s, 0);
    skirt.rotation.x = Math.PI;
    (skirt.material as MeshStandardMaterial).side = DoubleSide;
    body.add(skirt);
    if (!floating) {
      const footGeo = track(new BoxGeometry(0.2 * s, 0.1 * s, 0.3 * s));
      leftLeg.add(part(footGeo, armour, 0, -0.7 * s, 0.04 * s));
      rightLeg.add(part(footGeo, armour, 0, -0.7 * s, 0.04 * s));
    }
  } else {
    leftLeg.add(part(legGeo, cloth, 0, -0.36 * s, 0));
    rightLeg.add(part(legGeo, cloth, 0, -0.36 * s, 0));
    const bootGeo = track(new BoxGeometry(0.22 * s * bulk, 0.14 * s, 0.34 * s));
    leftLeg.add(part(bootGeo, armour, 0, -0.66 * s, 0.05 * s));
    rightLeg.add(part(bootGeo, armour, 0, -0.66 * s, 0.05 * s));
  }

  // --- torso --------------------------------------------------------------
  const torso = new Group();
  torso.position.set(0, hipY, 0);
  body.add(torso);

  const chestGeo = track(new CapsuleGeometry(0.27 * s * bulk, 0.42 * s, 3, 8));
  torso.add(part(chestGeo, armour, 0, 0.32 * s, 0));

  const beltGeo = track(new BoxGeometry(0.5 * s * bulk, 0.1 * s, 0.34 * s));
  torso.add(part(beltGeo, cloth, 0, 0.04 * s, 0));

  // Team-coloured chest sigil, the main readable identity cue from above.
  const sigilGeo = track(new BoxGeometry(0.2 * s, 0.2 * s, 0.06 * s));
  torso.add(part(sigilGeo, accent, 0, 0.42 * s, 0.24 * s * bulk));

  const shoulderGeo = track(new SphereGeometry(0.16 * s * bulk, 7, 5));
  torso.add(part(shoulderGeo, armour, -0.3 * s * bulk, 0.6 * s, 0));
  torso.add(part(shoulderGeo, armour, 0.3 * s * bulk, 0.6 * s, 0));

  // --- head ---------------------------------------------------------------
  const head = new Group();
  head.position.set(0, 0.82 * s, 0);
  torso.add(head);

  if (style.head === 'orb') {
    head.add(part(track(new SphereGeometry(0.2 * s, 8, 6)), accent));
    head.add(part(track(new TorusGeometry(0.26 * s, 0.03 * s, 4, 10)), armour, 0, 0, 0));
  } else if (style.head === 'skull') {
    head.add(part(track(new BoxGeometry(0.28 * s, 0.26 * s, 0.3 * s)), armour));
    // Sunken sockets, which is most of what makes a box read as a skull.
    for (const side of [-1, 1]) {
      head.add(part(track(new BoxGeometry(0.08 * s, 0.07 * s, 0.05 * s)), accent, side * 0.07 * s, 0.03 * s, 0.15 * s));
    }
    head.add(part(track(new BoxGeometry(0.14 * s, 0.09 * s, 0.12 * s)), armour, 0, -0.14 * s, 0.11 * s));
  } else if (style.head === 'beast') {
    head.add(part(track(new SphereGeometry(0.22 * s, 8, 6)), armour));
    // A snout pushed forward is the whole difference between a head and a maw.
    const snout = part(track(new ConeGeometry(0.15 * s, 0.34 * s, 6)), armour, 0, -0.02 * s, 0.24 * s);
    snout.rotation.x = Math.PI / 2;
    head.add(snout);
    for (const side of [-1, 1]) {
      const ear = part(track(new ConeGeometry(0.07 * s, 0.2 * s, 4)), armour, side * 0.13 * s, 0.2 * s, -0.02 * s);
      ear.rotation.z = side * 0.35;
      head.add(ear);
      head.add(part(track(new SphereGeometry(0.035 * s, 5, 4)), accent, side * 0.1 * s, 0.05 * s, 0.17 * s));
    }
  } else if (style.head === 'hooded') {
    // An empty hood: a cowl with a glowing void where a face would be.
    const hood = part(track(new ConeGeometry(0.26 * s, 0.44 * s, 7)), cloth, 0, 0.06 * s, -0.02 * s);
    (hood.material as MeshStandardMaterial).side = DoubleSide;
    head.add(hood);
    head.add(part(track(new SphereGeometry(0.09 * s, 6, 5)), accent, 0, -0.02 * s, 0.1 * s));
  } else {
    head.add(part(track(new SphereGeometry(0.21 * s, 8, 6)), armour));
    // Visor slit.
    head.add(part(track(new BoxGeometry(0.26 * s, 0.05 * s, 0.06 * s)), accent, 0, 0.02 * s, 0.19 * s));
    if (style.head === 'horned') {
      const hornGeo = track(new ConeGeometry(0.06 * s, 0.32 * s, 5));
      const l = part(hornGeo, armour, -0.16 * s, 0.16 * s, -0.02 * s);
      l.rotation.z = 0.5;
      l.rotation.x = -0.3;
      head.add(l);
      const r = part(hornGeo, armour, 0.16 * s, 0.16 * s, -0.02 * s);
      r.rotation.z = -0.5;
      r.rotation.x = -0.3;
      head.add(r);
    }
  }

  // --- arms ---------------------------------------------------------------
  const armGeo = track(new CapsuleGeometry(0.1 * s * bulk, 0.42 * s, 2, 6));
  const shoulderY = 0.58 * s;

  const leftArm = new Group();
  leftArm.position.set(-0.32 * s * bulk, shoulderY, 0);
  leftArm.add(part(armGeo, cloth, 0, -0.3 * s, 0));
  torso.add(leftArm);

  const rightArm = new Group();
  rightArm.position.set(0.32 * s * bulk, shoulderY, 0);
  rightArm.add(part(armGeo, cloth, 0, -0.3 * s, 0));
  torso.add(rightArm);

  // --- weapon -------------------------------------------------------------
  let weapon: Object3D | null = null;
  if (style.weapon !== 'none') {
    weapon = new Group();
    weapon.position.set(0, -0.52 * s, 0.04 * s);
    rightArm.add(weapon);

    if (style.weapon === 'sword') {
      weapon.add(part(track(new BoxGeometry(0.06 * s, 0.16 * s, 0.06 * s)), cloth, 0, 0, 0));
      weapon.add(part(track(new BoxGeometry(0.22 * s, 0.04 * s, 0.08 * s)), armour, 0, 0.1 * s, 0));
      const blade = part(track(new BoxGeometry(0.09 * s, 0.78 * s, 0.03 * s)), armour, 0, 0.52 * s, 0);
      weapon.add(blade);
      weapon.add(part(track(new BoxGeometry(0.03 * s, 0.7 * s, 0.045 * s)), accent, 0, 0.5 * s, 0));
      // Held blade-up and angled slightly forward.
      weapon.rotation.x = -0.35;
    } else if (style.weapon === 'staff') {
      weapon.add(part(track(new CapsuleGeometry(0.035 * s, 1.1 * s, 2, 5)), cloth, 0, 0.25 * s, 0));
      weapon.add(part(track(new SphereGeometry(0.12 * s, 7, 5)), accent, 0, 0.86 * s, 0));
      weapon.rotation.x = -0.2;
    } else {
      // Claws: three short blades fanned from the fist.
      const clawGeo = track(new ConeGeometry(0.035 * s, 0.34 * s, 4));
      for (let i = -1; i <= 1; i++) {
        const c = part(clawGeo, accent, i * 0.09 * s, -0.12 * s, 0.12 * s);
        c.rotation.x = Math.PI * 0.55;
        c.rotation.z = i * 0.2;
        weapon.add(c);
      }
    }
  }

  // --- cape ---------------------------------------------------------------
  let cape: Object3D | null = null;
  if (style.cape) {
    const capeGeo = track(new PlaneGeometry(0.56 * s, 0.9 * s, 1, 3));
    const capeMat = trackMat(
      new MeshStandardMaterial({
        color: style.accent,
        roughness: 0.95,
        metalness: 0,
        side: DoubleSide,
        flatShading: true,
      }),
    );
    cape = new Mesh(capeGeo, capeMat);
    cape.position.set(0, 0.34 * s, -0.24 * s * bulk);
    cape.rotation.x = 0.18;
    cape.castShadow = true;
    torso.add(cape);
  }

  // --- pauldrons ----------------------------------------------------------
  if (style.pauldrons) {
    const plateGeo = track(new ConeGeometry(0.24 * s * bulk, 0.22 * s, 5));
    for (const side of [-1, 1]) {
      const plate = part(plateGeo, armour, side * 0.34 * s * bulk, 0.66 * s, 0);
      plate.rotation.z = side * -0.5;
      torso.add(plate);
    }
  }

  // --- wings --------------------------------------------------------------
  let wings: Object3D | null = null;
  if (style.wings && style.wings !== 'none') {
    wings = new Group();
    wings.position.set(0, 0.56 * s, -0.18 * s * bulk);
    torso.add(wings);
    const feathered = style.wings === 'feathered';
    const spanGeo = track(new PlaneGeometry(0.8 * s, 0.5 * s, 3, 2));
    const wingMat = trackMat(
      new MeshStandardMaterial({
        color: feathered ? style.primary : style.secondary,
        roughness: 0.9,
        side: DoubleSide,
        flatShading: true,
      }),
    );
    for (const side of [-1, 1]) {
      const wing = new Group();
      wing.position.set(side * 0.12 * s, 0, 0);
      const panel = new Mesh(spanGeo, wingMat);
      panel.position.set(side * 0.4 * s, 0.06 * s, -0.05 * s);
      panel.castShadow = true;
      wing.add(panel);
      if (!feathered) {
        // Membrane wings get visible finger struts.
        const strut = track(new BoxGeometry(0.75 * s, 0.03 * s, 0.03 * s));
        wing.add(part(strut, armour, side * 0.4 * s, 0.2 * s, -0.04 * s));
      }
      wing.rotation.y = side * -0.35;
      wings.add(wing);
    }
  }

  // --- tail ---------------------------------------------------------------
  let tail: Object3D | null = null;
  if (style.tail) {
    tail = new Group();
    tail.position.set(0, 0.1 * s, -0.24 * s * bulk);
    torso.add(tail);
    const segGeo = track(new ConeGeometry(0.09 * s, 0.62 * s, 5));
    const seg = part(segGeo, armour, 0, -0.2 * s, -0.2 * s);
    seg.rotation.x = -1.2;
    tail.add(seg);
    tail.add(part(track(new ConeGeometry(0.05 * s, 0.24 * s, 4)), accent, 0, -0.36 * s, -0.5 * s));
  }

  return {
    root,
    body,
    torso,
    head,
    leftArm,
    rightArm,
    leftLeg,
    rightLeg,
    leftRearLeg: null,
    rightRearLeg: null,
    weapon,
    cape,
    wings,
    tail,
    plan,
    phase: 0,
    materials,
    geometries,
  };
}

/**
 * A four-legged body: horizontal spine, head out front, legs in two pairs.
 *
 * Reuses the same joint names so one pose function drives both plans. The front
 * pair are `leftLeg` and `rightLeg`, which means a quadruped's gait falls out of
 * the same leg-swing code that walks a champion.
 */
function buildQuadruped(style: CharacterStyle): CharacterRig {
  const s = style.scale;
  const bulk = style.bulk ?? 1;

  const materials: Material[] = [];
  const geometries: BufferGeometry[] = [];
  const track = <T extends BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };

  const hide = new MeshStandardMaterial({ color: style.primary, roughness: 0.9, flatShading: true });
  const underside = new MeshStandardMaterial({ color: style.secondary, roughness: 0.95, flatShading: true });
  const accent = new MeshStandardMaterial({
    color: style.accent,
    emissive: style.accent,
    emissiveIntensity: 0.5,
    roughness: 0.4,
    flatShading: true,
  });
  materials.push(hide, underside, accent);

  const root = new Group();
  const body = new Group();
  root.add(body);

  // Spine runs along +Z, so the animal faces the same way a champion does.
  const backY = 0.78 * s;
  const torso = new Group();
  torso.position.set(0, backY, 0);
  body.add(torso);

  const barrelGeo = track(new CapsuleGeometry(0.3 * s * bulk, 0.72 * s, 3, 8));
  const barrel = new Mesh(barrelGeo, hide);
  barrel.rotation.x = Math.PI / 2;
  barrel.castShadow = true;
  torso.add(barrel);

  torso.add(part(track(new CapsuleGeometry(0.2 * s * bulk, 0.3 * s, 2, 6)), underside, 0, -0.1 * s, 0.1 * s));

  // Neck and head, pushed forward and slightly down.
  const head = new Group();
  head.position.set(0, 0.16 * s, 0.56 * s);
  torso.add(head);
  const neck = part(track(new CapsuleGeometry(0.15 * s, 0.26 * s, 2, 6)), hide, 0, -0.08 * s, -0.14 * s);
  neck.rotation.x = 0.9;
  torso.add(neck);

  head.add(part(track(new SphereGeometry(0.21 * s * bulk, 8, 6)), hide));
  const snout = part(track(new ConeGeometry(0.14 * s, 0.32 * s, 6)), hide, 0, -0.03 * s, 0.22 * s);
  snout.rotation.x = Math.PI / 2;
  head.add(snout);
  for (const side of [-1, 1]) {
    head.add(part(track(new SphereGeometry(0.035 * s, 5, 4)), accent, side * 0.1 * s, 0.05 * s, 0.15 * s));
    if (style.head === 'horned') {
      const horn = part(track(new ConeGeometry(0.05 * s, 0.26 * s, 5)), underside, side * 0.13 * s, 0.18 * s, 0);
      horn.rotation.z = side * 0.5;
      head.add(horn);
    } else {
      const ear = part(track(new ConeGeometry(0.06 * s, 0.18 * s, 4)), hide, side * 0.12 * s, 0.19 * s, -0.03 * s);
      ear.rotation.z = side * 0.4;
      head.add(ear);
    }
  }

  // Four legs. Front pair forward of centre, rear pair behind.
  const legGeo = track(new CapsuleGeometry(0.09 * s * bulk, 0.5 * s, 2, 6));
  const pawGeo = track(new BoxGeometry(0.17 * s, 0.1 * s, 0.24 * s));
  const makeLeg = (x: number, z: number): Group => {
    const leg = new Group();
    leg.position.set(x, backY - 0.06 * s, z);
    leg.add(part(legGeo, hide, 0, -0.3 * s, 0));
    leg.add(part(pawGeo, underside, 0, -0.62 * s, 0.03 * s));
    body.add(leg);
    return leg;
  };
  const leftLeg = makeLeg(-0.24 * s * bulk, 0.34 * s);
  const rightLeg = makeLeg(0.24 * s * bulk, 0.34 * s);
  const leftRearLeg = makeLeg(-0.24 * s * bulk, -0.34 * s);
  const rightRearLeg = makeLeg(0.24 * s * bulk, -0.34 * s);

  let tail: Object3D | null = null;
  if (style.tail !== false) {
    tail = new Group();
    tail.position.set(0, 0.08 * s, -0.5 * s);
    torso.add(tail);
    const seg = part(track(new ConeGeometry(0.08 * s, 0.6 * s, 5)), hide, 0, 0.06 * s, -0.24 * s);
    seg.rotation.x = -1.35;
    tail.add(seg);
  }

  return {
    root,
    body,
    torso,
    head,
    // A quadruped has no arms; the front legs stand in so shared pose code has
    // something valid to write to.
    leftArm: leftLeg,
    rightArm: rightLeg,
    leftLeg,
    rightLeg,
    leftRearLeg,
    rightRearLeg,
    weapon: null,
    cape: null,
    wings: null,
    tail,
    plan: 'quadruped',
    phase: 0,
    materials,
    geometries,
  };
}

/**
 * Poses a rig from simulation state.
 *
 * The gait phase advances with distance travelled rather than with time, so a
 * slowed unit takes shorter steps instead of sliding, and a stopped unit's legs
 * settle rather than marching in place.
 */
export function poseCharacter(rig: CharacterRig, p: PoseInput): void {
  const speed = Math.max(0, p.speed);
  const gaitSpeed = speed / GAIT_REFERENCE_SPEED;

  rig.phase += p.dt * (2.2 + gaitSpeed * 7.5) * (speed > 0.05 ? 1 : 0.35);
  const phase = rig.phase;

  // Blend between idle and run so starting and stopping is not a snap.
  const run = clamp01(gaitSpeed * 1.6);
  const swing = Math.sin(phase) * (0.12 + run * 0.62);
  const counter = Math.sin(phase + Math.PI) * (0.1 + run * 0.5);

  if (rig.plan === 'quadruped') {
    // Diagonal pairs move together, which is what a real trot looks like and
    // what stops a four-legged walk from reading as a pantomime horse.
    rig.leftLeg.rotation.x = swing;
    rig.rightRearLeg!.rotation.x = swing;
    rig.rightLeg.rotation.x = -swing;
    rig.leftRearLeg!.rotation.x = -swing;
  } else if (rig.plan === 'floating') {
    // Nothing to walk on. The whole body drifts and banks instead.
    rig.leftLeg.rotation.x = Math.sin(phase * 0.6) * 0.1;
    rig.rightLeg.rotation.x = Math.sin(phase * 0.6 + 1) * 0.1;
    rig.leftArm.rotation.x = -0.5 + Math.sin(p.time * 1.3) * 0.12;
    rig.rightArm.rotation.x = -0.5 + Math.sin(p.time * 1.3 + 2) * 0.12;
    rig.leftArm.rotation.z = 0.35;
    rig.rightArm.rotation.z = -0.35;
  } else {
    rig.leftLeg.rotation.x = swing;
    rig.rightLeg.rotation.x = -swing;

    // Arms counter-swing, and the weapon arm swings less so it stays readable.
    rig.leftArm.rotation.x = counter * 0.9;
    rig.leftArm.rotation.z = 0.08;
    rig.rightArm.rotation.x = -counter * 0.55;
    rig.rightArm.rotation.z = -0.08;
  }

  if (rig.wings) {
    // Wings beat faster when moving and idle to a slow breath when still.
    const beat = Math.sin(p.time * (3.2 + run * 6)) * (0.18 + run * 0.5);
    rig.wings.children.forEach((wing, i) => {
      const side = i === 0 ? -1 : 1;
      wing.rotation.z = side * (0.15 + beat);
      wing.rotation.x = -beat * 0.4;
    });
  }

  if (rig.tail) {
    rig.tail.rotation.y = Math.sin(phase * 0.9) * (0.12 + run * 0.28);
    rig.tail.rotation.x = Math.sin(phase * 1.8) * 0.08 * run;
  }

  // Vertical bob at twice the stride frequency, plus a slow idle breath. A
  // floating body hovers clear of the ground and never touches it.
  const bob = Math.abs(Math.sin(phase)) * 0.055 * run;
  const breathe = Math.sin(p.time * 1.9) * 0.012 * (1 - run);
  const hover = rig.plan === 'floating' ? 0.34 + Math.sin(p.time * 1.1) * 0.07 : 0;
  rig.body.position.y = bob + breathe + p.lift + hover;
  rig.torso.rotation.z = Math.sin(phase) * 0.04 * run;
  rig.torso.rotation.x = run * 0.09;

  if (rig.cape) {
    // Cape trails backwards with speed and flutters on the stride.
    rig.cape.rotation.x = 0.18 + run * 0.5 + Math.sin(phase * 2) * 0.06 * run;
  }

  // --- attack -------------------------------------------------------------
  if (p.attack >= 0) {
    // Wind back over the first 60%, strike through the last 40%.
    const t = clamp01(p.attack);
    const wind = smoothstep(clamp01(t / 0.6));
    const strike = smoothstep(clamp01((t - 0.6) / 0.4));
    const angle = lerp(0, -2.1, wind) + lerp(0, 2.9, strike);
    rig.rightArm.rotation.x = angle;
    rig.torso.rotation.y = lerp(0, -0.35, wind) + lerp(0, 0.5, strike);
  } else {
    rig.torso.rotation.y = 0;
  }

  // --- cast ---------------------------------------------------------------
  if (p.cast >= 0) {
    const t = clamp01(p.cast);
    const raise = smoothstep(Math.min(1, t * 2));
    rig.rightArm.rotation.x = lerp(rig.rightArm.rotation.x, -2.4, raise);
    rig.leftArm.rotation.x = lerp(rig.leftArm.rotation.x, -1.9, raise * 0.7);
    rig.leftArm.rotation.z = lerp(0.08, 0.5, raise);
    rig.rightArm.rotation.z = lerp(-0.08, -0.5, raise);
    rig.torso.rotation.x = lerp(rig.torso.rotation.x, -0.12, raise);
  }

  // --- death --------------------------------------------------------------
  if (p.death > 0) {
    const t = smoothstep(clamp01(p.death));
    rig.root.rotation.x = lerp(0, -Math.PI * 0.48, t);
    rig.body.position.y = lerp(rig.body.position.y, 0.1, t);
    rig.leftArm.rotation.x = lerp(rig.leftArm.rotation.x, 0.9, t);
    rig.rightArm.rotation.x = lerp(rig.rightArm.rotation.x, 0.9, t);
  } else {
    rig.root.rotation.x = 0;
  }
}

/** Frees the GPU resources a rig owns. */
export function disposeCharacter(rig: CharacterRig): void {
  for (const g of rig.geometries) g.dispose();
  for (const m of rig.materials) m.dispose();
}

/**
 * A defensive structure. Not a character, but it lives here because it shares
 * the same "assemble from primitives" approach and the same pose interface.
 */
export function buildTower(style: CharacterStyle): CharacterRig {
  const s = style.scale;
  const materials: Material[] = [];
  const geometries: BufferGeometry[] = [];
  const stone = new MeshStandardMaterial({ color: style.primary, roughness: 0.95, flatShading: true });
  const trim = new MeshStandardMaterial({
    color: style.accent,
    emissive: style.accent,
    emissiveIntensity: 0.7,
    roughness: 0.4,
    flatShading: true,
  });
  materials.push(stone, trim);

  const root = new Group();
  const body = new Group();
  root.add(body);

  const baseGeo = new ConeGeometry(1.5 * s, 1.2 * s, 6);
  const shaftGeo = new ConeGeometry(0.95 * s, 3.4 * s, 6);
  const capGeo = new ConeGeometry(1.1 * s, 1.1 * s, 6);
  const coreGeo = new SphereGeometry(0.42 * s, 8, 6);
  geometries.push(baseGeo, shaftGeo, capGeo, coreGeo);

  body.add(part(baseGeo, stone, 0, 0.6 * s, 0));
  body.add(part(shaftGeo, stone, 0, 2.6 * s, 0));
  const cap = part(capGeo, stone, 0, 4.6 * s, 0);
  body.add(cap);
  const core = part(coreGeo, trim, 0, 4.2 * s, 0);
  body.add(core);

  return {
    root,
    body,
    torso: cap,
    head: core,
    leftArm: cap,
    rightArm: core,
    leftLeg: body,
    rightLeg: body,
    leftRearLeg: null,
    rightRearLeg: null,
    weapon: null,
    cape: null,
    wings: null,
    tail: null,
    plan: 'biped',
    phase: 0,
    materials,
    geometries,
  };
}

/** Towers only spin their core and pulse when firing. */
export function poseTower(rig: CharacterRig, p: PoseInput): void {
  rig.head.rotation.y += p.dt * 0.6;
  const pulse = p.attack >= 0 ? 1 + Math.sin(p.attack * Math.PI) * 0.35 : 1;
  rig.head.scale.setScalar(pulse);
  if (p.death > 0) {
    const t = smoothstep(clamp01(p.death));
    rig.body.position.y = lerp(0, -3.5, t);
    rig.body.rotation.z = lerp(0, 0.4, t);
  }
}
