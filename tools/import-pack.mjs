/**
 * Imports a generated asset pack into the web project.
 *
 * The generator writes a manifest describing what it made and a directory of
 * GLB files. This turns that into the shape the browser wants: one manifest
 * with only the fields the runtime reads, and the meshes under public/ so Vite
 * serves them.
 *
 * Assets whose mesh failed are dropped rather than listed, so the editor
 * palette never offers something that will not load. A short report is printed
 * because a pack that silently lost a third of its contents is worth noticing.
 *
 *   node tools/import-pack.mjs <staging-dir> [--out public/assets/pack]
 *
 * `staging-dir` holds manifest.json and a glb/ directory, as produced by
 * scripts/pipeline.py on the generation host.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const stagingDir = args[0] ?? 'assets-staging';
const outIndex = args.indexOf('--out');
const outDir = outIndex >= 0 ? args[outIndex + 1] : 'public/assets/pack';

const manifestPath = join(stagingDir, 'manifest.json');
const palettePath = join(stagingDir, 'palettes.json');
const glbDir = join(stagingDir, 'glb');

let raw;
try {
  raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`Could not read ${manifestPath}: ${err.message}`);
  process.exit(1);
}

// Colour recovered from the concept art, kept beside the manifest rather than
// inside it because a generation phase rewrites the manifest from its own copy
// and would drop anything written while it ran.
let palettes = {};
try {
  palettes = JSON.parse(readFileSync(palettePath, 'utf8'));
} catch {
  palettes = {};
}

/**
 * How much bigger than its catalogue height each kind of thing is in the world.
 *
 * The catalogue sizes were set against each other and never against a person,
 * and it showed: a two-storey house stood 5.6 units to a champion's 2.2, a
 * ratio of two and a half. A real one is nine metres to a person's one point
 * eight, a ratio of five. Everything architectural was about half the size it
 * should be, which is why the city read as a model village.
 *
 * Applied here rather than baked into the meshes, because it is one number per
 * category and re-deriving it should not mean regenerating five hundred files.
 * The manifest records the scaled size, so every consumer — plot fitting,
 * collision, the museum's spacing — already agrees.
 */
const WORLD_SCALE = {
  fort: 2.4,
  civic: 2.6,
  house: 2.05,
  rural: 1.9,
  dock: 1.7,
  street: 1.4,
  nature: 2.4,
  building: 1.9,
  prop: 1.2,
  creature: 1.0,
  folk: 1.0,
  weapon: 1.0,
  shield: 1.0,
  pickup: 1.0,
};

// A few things are landmarks rather than examples of their category, and the
// skyline is the reason to build them at all.
const SCALE_OVERRIDE = {
  civic_cathedral: 2.9,
  civic_keep_great: 2.5,
  civic_keep_round: 2.5,
  civic_bell_tower: 3.0,
  civic_wizard_tower: 2.6,
  civic_mage_spire: 2.6,
  civic_clock_tower: 2.8,
  civic_guild_tower: 2.7,
  fort_gatehouse_great: 2.3,
  fort_tower_round: 2.3,
  street_market_cross: 1.6,
  street_lamp_post: 1.6,
  street_statue_king: 1.7,
  street_gate_arch_free: 2.2,
  street_obelisk: 2.0,
};

const available = new Set();
try {
  for (const f of readdirSync(glbDir)) if (f.endsWith('.glb')) available.add(f);
} catch (err) {
  console.error(`Could not read ${glbDir}: ${err.message}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
// Clear stale meshes so a reimport cannot leave orphans behind that the
// manifest no longer mentions.
for (const f of readdirSync(outDir)) {
  if (f.endsWith('.glb')) rmSync(join(outDir, f));
}

const assets = [];
const skipped = [];
let totalBytes = 0;
let totalTris = 0;

for (const [id, entry] of Object.entries(raw.assets ?? {})) {
  const file = entry.mesh;
  if (!file || !available.has(file)) {
    skipped.push(`${id}: no mesh`);
    continue;
  }
  const info = entry.meshInfo ?? {};
  const src = join(glbDir, file);
  const bytes = statSync(src).size;
  copyFileSync(src, join(outDir, file));

  const category = entry.category ?? 'prop';
  const scale = SCALE_OVERRIDE[id] ?? WORLD_SCALE[category] ?? 1;
  const size = (info.size ?? [1, 1, 1]).map((v) => Math.round(v * scale * 1e4) / 1e4);

  assets.push({
    id,
    name: entry.name ?? id,
    category: entry.category ?? 'prop',
    tags: entry.tags ?? [],
    mesh: file,
    size,
    radius: Math.round((info.radius ?? 0.5) * scale * 1e4) / 1e4,
    ...(scale !== 1 ? { meshScale: scale } : {}),
    triangles: info.triangles ?? 0,
    bytes,
    // Which tiling surfaces to project onto this mesh. Absent for the first
    // pack, which predates materials; the runtime falls back to its category.
    ...(entry.material ? { material: entry.material } : {}),
    ...(palettes[id] ? { palette: palettes[id] } : {}),
  });
  totalBytes += bytes;
  totalTris += info.triangles ?? 0;
}

assets.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

writeFileSync(
  join(outDir, 'manifest.json'),
  JSON.stringify({ generated: new Date().toISOString(), assets }, null, 1),
);

const byCategory = {};
for (const a of assets) byCategory[a.category] = (byCategory[a.category] ?? 0) + 1;

const coloured = assets.filter((a) => a.palette).length;
console.log(
  `imported ${assets.length} assets into ${resolve(outDir)}` +
    (coloured ? `, ${coloured} with concept colour` : ''),
);
for (const k of Object.keys(byCategory).sort()) {
  console.log(`  ${k.padEnd(10)} ${byCategory[k]}`);
}
console.log(`  ${'total'.padEnd(10)} ${(totalBytes / 1024 / 1024).toFixed(1)} MB, ${totalTris.toLocaleString()} triangles`);
if (skipped.length) {
  console.log(`skipped ${skipped.length}:`);
  for (const s of skipped.slice(0, 12)) console.log(`  ${s}`);
  if (skipped.length > 12) console.log(`  ... and ${skipped.length - 12} more`);
}
