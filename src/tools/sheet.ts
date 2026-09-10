/**
 * Asset contact sheet.
 *
 * Lays out every mesh in the pack on a grid at true world scale, on a common
 * ground plane, with a champion-height reference bar beside each one. Reviewing
 * a generated pack one asset at a time does not work: the failures that matter
 * are relative — a tower the size of a barrel, a sword as tall as a person —
 * and they are invisible unless the assets are seen together.
 *
 *   /sheet.html                      the whole pack
 *   /sheet.html?category=weapon      one category
 *   /sheet.html?filter=sword         substring match on id
 *   /sheet.html?cols=8&scale=1
 */

import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { AssetRegistry } from '../render/assets';
import '../styles.css';

/** A champion stands this tall; every asset is judged against it. */
const REFERENCE_HEIGHT = 2.2;

const params = new URLSearchParams(location.search);
const category = params.get('category');
const filter = (params.get('filter') ?? '').toLowerCase();
const cols = Number(params.get('cols') ?? 7);
const spacing = Number(params.get('spacing') ?? 7);

const canvas = document.getElementById('sheet-canvas') as HTMLCanvasElement;
const info = document.getElementById('sheet-info') as HTMLDivElement;

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;

const scene = new Scene();
scene.background = new Color(0x121822);
scene.fog = new Fog(0x121822, 60, 220);
scene.add(new HemisphereLight(0xbcd6ff, 0x2a3324, 1.15));
const sun = new DirectionalLight(0xfff0d8, 2.0);
sun.position.set(20, 40, 20);
scene.add(sun);

const ground = new Mesh(
  new PlaneGeometry(600, 600),
  new MeshStandardMaterial({ color: 0x2a3340, roughness: 1 }),
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.01;
scene.add(ground);

const camera = new PerspectiveCamera(38, 1, 0.5, 500);
const world = new Group();
scene.add(world);

function resize(): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const registry = new AssetRegistry();

async function build(): Promise<void> {
  const count = await registry.loadManifest();
  if (count === 0) {
    info.textContent = 'No pack found at /assets/pack/manifest.json';
    return;
  }

  let entries = registry.all();
  if (category) entries = entries.filter((e) => e.category === category);
  if (filter) entries = entries.filter((e) => e.id.toLowerCase().includes(filter));
  entries.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));

  info.innerHTML =
    `<b>${entries.length} assets</b>` +
    (category ? ` in ${category}` : '') +
    `<br>grey bar = ${REFERENCE_HEIGHT}u champion height` +
    `<br>${registry.categories().join(' · ')}`;

  // A slim grey post beside each asset, exactly a champion tall, is the whole
  // point of the sheet: scale errors are obvious against it and invisible
  // without it.
  const refGeo = new BoxGeometry(0.12, REFERENCE_HEIGHT, 0.12);
  const refMat = new MeshBasicMaterial({ color: 0x6b7a8c });

  const rows = Math.ceil(entries.length / cols);

  // Reference posts first: they need no network, so the grid's shape is
  // visible immediately and it is obvious which cells are still filling in.
  for (let i = 0; i < entries.length; i++) {
    const x = ((i % cols) - (cols - 1) / 2) * spacing;
    const z = (Math.floor(i / cols) - (rows - 1) / 2) * spacing;
    const post = new Mesh(refGeo, refMat);
    post.position.set(x - spacing * 0.34, REFERENCE_HEIGHT / 2, z);
    world.add(post);
  }

  // Loading in parallel rather than one at a time. Awaiting each asset in turn
  // makes a two-hundred-asset sheet take minutes, because every request waits
  // for the previous one to finish rather than for the network.
  const loaded = await Promise.all(
    entries.map(async (entry, i) => {
      const x = ((i % cols) - (cols - 1) / 2) * spacing;
      const z = (Math.floor(i / cols) - (rows - 1) / 2) * spacing;
      try {
        const geo = await registry.load(entry.id);
        const mesh = new Mesh(geo, registry.material(entry.category));
        mesh.position.set(x, 0, z);
        mesh.castShadow = true;
        world.add(mesh);
        return true;
      } catch {
        return false;
      }
    }),
  );

  info.innerHTML += `<br>${loaded.filter(Boolean).length} meshes drawn`;

  // Frame the whole grid.
  const width = cols * spacing;
  const depth = rows * spacing;
  distance = Math.max(width, depth) * 0.95 + 14;
}

let distance = 40;
let angle = 0.5;

// Drag to orbit, wheel to zoom. Enough control to inspect a sheet, and no more.
let dragging = false;
let lastX = 0;
canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  lastX = e.clientX;
});
window.addEventListener('mouseup', () => (dragging = false));
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  angle += (e.clientX - lastX) * 0.005;
  lastX = e.clientX;
});
canvas.addEventListener('wheel', (e) => {
  distance = Math.max(8, Math.min(400, distance * Math.pow(1.1, Math.sign(e.deltaY))));
  e.preventDefault();
});

function frame(): void {
  const height = distance * 0.62;
  camera.position.set(Math.sin(angle) * distance, height, Math.cos(angle) * distance);
  camera.lookAt(0, 1.5, 0);
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

void build();
frame();
