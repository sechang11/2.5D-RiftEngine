/**
 * Mesh inspector.
 *
 * A standalone page for looking at one generated asset at real game scale, with
 * the same lighting the game uses. Generated meshes need eyes on them before
 * they go in a pack: reconstruction produces plausible-looking geometry that is
 * frequently the wrong size, upside down, or a blob, and none of that shows up
 * in a triangle count.
 *
 * Open /viewer.html?src=/assets/bench/sword.glb
 * Add &grid=1 for a one-unit reference grid, &wire=1 for wireframe.
 */

import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DirectionalLight,
  GridHelper,
  Group,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import '../styles.css';

const params = new URLSearchParams(location.search);
const src = params.get('src') ?? '/assets/bench/sword.glb';
const showGrid = params.get('grid') !== '0';
const wireframe = params.get('wire') === '1';

const canvas = document.getElementById('viewer-canvas') as HTMLCanvasElement;
const info = document.getElementById('viewer-info') as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;

const scene = new Scene();
scene.background = new Color(0x141a24);
scene.add(new HemisphereLight(0xbcd6ff, 0x2a3324, 1.2));
const sun = new DirectionalLight(0xfff0d8, 2.0);
sun.position.set(6, 10, 6);
scene.add(sun);

const camera = new PerspectiveCamera(40, 1, 0.05, 200);
const pivot = new Group();
scene.add(pivot);

if (showGrid) {
  // One line per world unit, so scale errors are obvious at a glance.
  const grid = new GridHelper(10, 10, 0x4b6a90, 0x2a3a4e);
  scene.add(grid);
}

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

let radius = 3;

new GLTFLoader().load(
  src,
  (gltf) => {
    const root = gltf.scene as Object3D;
    let triangles = 0;
    root.traverse((o) => {
      const mesh = o as Mesh;
      if (!mesh.isMesh) return;
      const index = mesh.geometry.getIndex();
      const pos = mesh.geometry.getAttribute('position');
      triangles += index ? index.count / 3 : pos.count / 3;
      // Generated meshes arrive untextured, so give them the engine's
      // flat-shaded look rather than default grey.
      mesh.material = new MeshStandardMaterial({
        color: 0xb9c2d0,
        roughness: 0.75,
        metalness: 0.08,
        flatShading: true,
        wireframe,
      });
    });

    pivot.add(root);

    const box = new Box3().setFromObject(root);
    const size = new Vector3();
    const centre = new Vector3();
    box.getSize(size);
    box.getCenter(centre);
    radius = Math.max(size.x, size.y, size.z) * 1.9 + 1;

    info.innerHTML =
      `<b>${src.split('/').pop()}</b><br>` +
      `${triangles.toLocaleString()} triangles<br>` +
      `size ${size.x.toFixed(2)} &times; ${size.y.toFixed(2)} &times; ${size.z.toFixed(2)} units<br>` +
      `base at y = ${box.min.y.toFixed(3)}`;
  },
  undefined,
  (err) => {
    info.textContent = `Failed to load ${src}: ${String(err)}`;
  },
);

let t = 0;
function frame(): void {
  t += 0.006;
  pivot.rotation.y = t;
  // Orbit slightly above the model, looking at its middle.
  camera.position.set(0, radius * 0.45, radius);
  camera.lookAt(0, radius * 0.18, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}
frame();
