# Materials

Generated meshes arrive with shape and nothing else. No UV layout, no texture,
and no honest way to make one that is not a per-asset unwrap-and-bake pipeline.
With two hundred assets that was never going to happen, so the texture is
projected instead of mapped.

## The idea

Each fragment samples a tiling material three times, once down each object-space
axis, and blends the three by how much the surface faces that axis. Nothing is
unwrapped, nothing is baked, seams cannot exist because there are none, and the
texel density is the same everywhere on the model.

Three consequences shaped everything else.

**Tiling makes resolution nearly free.** A 1024 texture at two world units per
tile is 512 pixels per world unit, and a champion is 2.2 units tall. No per-asset
unwrap at any budget the pack could afford comes close. That is why zooming all
the way in shows mortar joints rather than a smear.

**Projection is in object space, not world space.** World space hides tiling
better and is easier, and it makes the grain slide across a building whenever the
building is rotated. Every house in the city is a rotated copy of six shells, so
the grain has to rotate with them.

**Surfaces are split by angle, not by material slot.** `side` covers the walls
and `top` covers anything facing up past the blend threshold. That is what puts
slate on a roof and ashlar on the wall under it without the mesh, the generator
or the manifest knowing that a roof is a thing.

## What an asset asks for

```json
"material": { "side": "plaster_white", "top": "roof_clay", "scale": 1, "jitter": 0.16 }
```

| Field | Means |
| --- | --- |
| `side` | Material on vertical surfaces |
| `top` | Material on up-facing surfaces, blended in between 0.32 and 0.68 of normal Y |
| `scale` | Multiplies the material's own world-units-per-tile, per asset |
| `jitter` | How far individual instances may drift in brightness and hue |
| `normalScale` | Multiplies the relief baked into the map. Defaults to 1 |

`jitter` is the difference between a street and a street of one house. It is
applied per instance through instance colour, keyed on the prop id, so a house
keeps its own shade of plaster when something else on the map is deleted.

An asset with no material spec falls back to one chosen by its category. That is
crude — every creature gets hide, every weapon gets steel — and it is still an
enormous improvement on one flat colour per category, so the whole first pack
got textured without being regenerated.

## What a material is

Two files and a row in a manifest:

| File | Contents |
| --- | --- |
| `<id>_a.jpg` | Albedo, 1024, sRGB |
| `<id>_nr.jpg` | Normal X in red, normal Y in green, roughness in blue, 512, 4:4:4 |

Normal Z is dropped because it is recoverable from the other two, which buys the
third channel for roughness. The packed map is saved without chroma subsampling;
with it, the two normal channels smear into each other and into the roughness.

## How one is made

Two passes on SDXL, and the second one is the whole trick.

1. The model draws the surface. Nothing about it wraps.
2. The image is rolled by half its width and height, which moves its four edges
   into a cross through the middle, and that cross is inpainted with nine hundred
   pixels of context on both sides. Roll it back and the edges now match.

Tiling is then measured rather than assumed: the difference across the wrap is
compared against the difference between neighbouring interior rows, so a noisy
texture is not punished for being noisy. One means the wrap is as continuous as
the middle of the image. Forty-five of the forty-seven materials score under 1.6.

The maps are derived, not generated:

- **Albedo** is divided by a heavy wrapped blur, which removes the lighting SDXL
  always paints in. Tiled, that lighting becomes a grid of identical bright
  patches, and it is the single most obvious tell that a surface repeats.
- **Normal** is a Sobel of the band between the tone and the grain, with the
  gradient scale *fitted* rather than chosen: a high percentile of the gradient
  is pinned to a known slope. At a fixed multiplier, nine tenths of the stone
  saturated into a hard foil while thatch on the same constant came out nearly
  flat. Fitting also halves the file size, because an unsaturated map compresses.
- **Roughness** is local contrast, blurred hard. What matters is which region is
  rough; the unblurred version is per-pixel noise that costs more bytes than the
  normal sharing the file with it.

## Regenerating

```bash
python3 materials.py gen        # both passes, then derive the maps
python3 materials.py maps       # re-derive maps only, no GPU
python3 materials.py check      # seam scores, worst first
```

Then, from the project root:

```bash
node tools/import-materials.mjs <staging-dir>
```

## The ground

The terrain is drawn unlit by a shader of its own, and it takes two materials
rather than a full library: open ground, and whatever the map's lane mask means
there. On the battle map that mask is a trodden path between camps; in the city
it is a cobbled street. Same authoring, different vocabulary, chosen by naming a
material.

Because the ground has no lighting, relief is faked: the normal is reconstructed
from the packed map and shaded against the same sun direction the rest of the
scene uses. Two instructions, and the difference between a photograph of cobbles
and cobbles.

## Costs

| | |
| --- | --- |
| Texture fetches per fragment | 12 |
| Programs, museum with 184 assets | 16 |
| Frame time, museum, 195 draw calls, 737k triangles | 2.2 ms |

The fetch count is the price of triplanar: six for the two albedos, six for the
two packed maps. The packed maps are sampled once and their results reused by
both the roughness and the normal, which is why it is twelve rather than
eighteen.
