# The asset pipeline

How the mesh pack is made, why each stage exists, and what to do when a batch
comes out wrong.

Text prompt to game-ready GLB, in six stages:

```
catalog.json ─▶ SDXL concept art ─▶ tight crop ─▶ Hunyuan3D 2.1 ─▶ mesh cleanup ─▶ audit and re-roll ─▶ pack
```

Everything runs on one machine with a GPU and a ComfyUI install. The scripts
live in `tools/assetgen/` and the importer that brings the result into the web
project is `tools/import-pack.mjs`.

## Running it

On the generation host:

```bash
python3 tools/assetgen/make_catalog.py          # writes catalog.json
python3 tools/assetgen/pipeline.py images       # all concept art
python3 tools/assetgen/pipeline.py meshes       # all reconstructions
python3 tools/assetgen/pipeline.py audit        # report failures, change nothing
python3 tools/assetgen/pipeline.py retry        # re-roll the failures
```

`pipeline.py all` runs images, meshes and retry in order.

Progress lives in `out/manifest.json`. Both phases skip work already recorded
there, so a run that dies partway can simply be restarted.

Then, on the machine with the web project:

```bash
node tools/import-pack.mjs <staging-dir>
```

where the staging directory holds `manifest.json` and `glb/`. The importer
writes `public/assets/pack/`, drops any asset whose mesh failed, and prints a
per-category summary.

## Why the stages are shaped this way

### Two phases, not one

Images are all generated first, then all meshes. Interleaving them evicts a
multi-gigabyte model from VRAM on every single asset.

That is not a theoretical cost. During the first run another workload was
sharing the same ComfyUI and cycling a 20 GB model between our jobs. Concept
images went from 3.4 seconds each to 42, because the four seconds of generation
were preceded by thirty-eight seconds of reloading SDXL.

### Batched submissions

Each submission carries ten images or five meshes in one graph, sharing a single
checkpoint loader. ComfyUI keeps a model resident for the duration of one
prompt, so a batch pays the load once. On a contended GPU this took the
per-image cost from 42 seconds back down to under 7.

Batch size is a trade: larger amortises the load better, but one bad asset
costs the whole batch a retry.

### The tight crop

A single-view reconstructor sees a small square. A 1024px render is downsampled
to a few hundred pixels before the 3D model looks at it, so the subject has to
fill the frame. `prep_image.py` finds the subject, crops to it, and pads back
to square.

Subject detection measures the image's own border rather than assuming white.
These renders carry a soft vignette, and a fixed white threshold marks the whole
frame as subject, which makes the crop a no-op.

### Meshing settings

Established by sweeping, not guessed:

| Setting | Value | Why |
| --- | --- | --- |
| Algorithm | surface nets | Cleaner topology than marching cubes at roughly half the triangles |
| Threshold | 0.4 | The field is noisy near zero; meshing at 0.0 produced a 365 MB surface |
| Octree | 256 | 384 doubles file size for detail that does not survive decimation |
| Steps | 30 | Above this the shape stops changing |

### A dependency that fails silently

Mesh cleanup slices geometry with trimesh, and `slice_plane` needs **shapely**.
Without it every slice raises, and because plate removal catches its own
exceptions and returns the mesh unchanged, the whole stage quietly does nothing.
The pack still builds, every asset still looks plausible one at a time, and a
fifth of them stand on invented slabs.

Install it with the rest:

```bash
pip install numpy trimesh pygltflib scipy networkx pillow shapely fast-simplification
```

It was found by instrumenting a mesh that the detector said had a plate and the
output said did not. A silent fallback that keeps working is much harder to
notice than a crash.

### Mesh cleanup

A raw reconstruction is a quarter of a million triangles and nearly nine
megabytes, which is unusable in a browser where the whole pack has to download.
`meshproc.py` takes it to a few thousand triangles and about fifty kilobytes,
a reduction of roughly 160 times, in under a second.

The stages are: strip the invented ground plate, drop floating speckle,
quadric-decimate to a triangle budget, orient, scale to the size the catalog
asked for, rest the base at y=0, and recompute normals.

**The ground plate deserves its own note.** Reconstruction reads the concept
art's background as a real surface and returns the object standing on a wide
flat disc, usually fused to the model. It is also nearly always the largest
thing in the file, so the obvious filter — keep the biggest component — keeps
the plate and throws away the sword. That is exactly what the first version did,
and every asset came out a featureless blob.

The plate is detected by what it is made of rather than how wide it is: a dense
band of up-facing and down-facing triangles crowded at the floor. Width alone
cannot distinguish a ground disc from a winged crossguard, which are the same
size on the asset that first exposed the bug.

### Automated quality control

Roughly a third of weapons fail reconstruction, and reviewing two hundred meshes
by hand is not a plan. Both failure modes are visible in the bounding box alone,
so they are caught without a human:

| Failure | Signature | Looks like |
| --- | --- | --- |
| Paper-thin cutout | smallest dimension under 2.5% of the largest | a sticker of a staff |
| Blob | bounding box nearly cubic on something meant to be long | a sword that came back a ball |

The blob test needs to know what the asset was *supposed* to be, because a cubic
box is correct for a boulder and wrong for a spear. The first attempt used the
concept image's own aspect ratio for this and it did not work: reference art of
a longsword came back framed at 0.83, nearly square, because the generator drew
it large with a wide crossguard. Naming the shapes that must be elongated is
less clever and much more reliable, and it lets an orb and a tome stay round
without a special case.

Failures are re-rolled at a new seed rather than discarded, because these
failures are seed-dependent and a second attempt usually succeeds. The retry
keeps whichever attempt scores better, so running it can only improve a pack.

Review the result on the contact sheet at `/sheet.html`, which lays every asset
out at true scale beside a champion-height post. Scale errors are invisible one
asset at a time and obvious against a reference.

## Sizes are authored, not discovered

`make_catalog.py` states a target height in world units for every asset, where a
champion is 2.2 units tall. That number is what lets a wizard tower and a
dropped dagger sit on the same map without either being absurd, and it is far
cheaper to state up front than to rescale two hundred meshes afterwards.

Triangle budgets are set the same way, by how close the camera gets and how
often the asset appears. A hero building can afford five thousand; a mushroom
cannot.

## What this pipeline is bad at

**Humanoid characters.** Reconstruction handles massed, non-humanoid forms well
and people poorly. A goblin came back shredded where a sword and a tower came
back clean. Worse, even a perfect result is a static mesh with no skeleton, so
it cannot walk.

Animated characters therefore stay procedural, built from primitives and posed
by rotating named joints. Generated meshes are used for the things they are good
at: props, weapons, buildings, terrain, and creatures whose silhouette reads
from one view.

**Texture.** Hunyuan3D's texture-painting stage is a separate model that is not
installed here, so meshes arrive untextured. The engine shades them by category
from a palette, which suits its flat-shaded look, but a pack with real texture
maps would want a material per asset instead.

**Interior detail.** Anything the single reference view cannot see is invented.
Backs of buildings are plausible rather than correct, which is fine at a fixed
camera angle and would not be in a game with a free camera.
