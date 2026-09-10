"""
Tiling material library: text -> seamless albedo + packed normal/roughness.

The mesh generator produces shape and nothing else, so every asset in the pack
is shaded by a flat category colour. That reads as clay. This module makes the
other half: a library of tiling surfaces the engine projects onto those meshes,
which is how a generated hut becomes plaster with a thatched roof without
anybody unwrapping a UV.

Tiling is why 1024 is enough. A material at two world units per tile is 512
pixels per unit, and a champion is 2.2 units tall, so the texel density on a
wall beats anything a per-asset unwrap of the same budget could reach.

Two passes per material, and the second one is the whole trick:

  1. SDXL draws the surface. Nothing about it wraps.
  2. The image is rolled by half its width and height, which moves its four
     edges into a cross through the middle, and that cross is inpainted with
     full surrounding context. Roll it back and the edges now match.

Then the maps are derived rather than generated: dividing by a heavy blur takes
out the lighting SDXL baked in, a Sobel on the result gives a normal map, and
the roughness rides in the blue channel of the same file.

  python3 materials.py list
  python3 materials.py gen [--only prefix] [--limit N] [--force]
  python3 materials.py maps [--only prefix]        # re-derive maps only
  python3 materials.py check                       # seam metrics
"""

import argparse
import json
import os
import sys
import time

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import comfy_client as cc

COMFY = "/home/k4shix/ComfyUI"
COMFY_OUT = os.path.join(COMFY, "output")
STAGE = os.path.join(COMFY, "input", "gamegen_mat")

ROOT = os.path.expanduser("~/gamegen")
RAW_DIR = os.path.join(ROOT, "out", "mat_raw")
PACK_DIR = os.path.join(ROOT, "out", "materials")
MANIFEST = os.path.join(ROOT, "out", "mat_manifest.json")

CKPT = "RealVisXL_V5.0_fp16.safetensors"
SIZE = 1024
NORMAL_SIZE = 512
SEAM_BAND = 112
BATCH = 6

SUFFIX = (
    ", seamless tileable texture, flat orthographic top-down view of a flat surface, "
    "evenly lit, uniform ambient light, no shadows, no highlights, no vignette, "
    "no perspective, fills the entire frame edge to edge, sharp macro detail, "
    "material scan, albedo map"
)

NEGATIVE = (
    "perspective, angled view, vignette, cast shadow, drop shadow, strong directional light, "
    "spotlight, glare, reflection, border, frame, matte, text, watermark, signature, "
    "blur, depth of field, bokeh, single object, isolated object, curved surface, sphere, "
    "material ball, 3d render of an object, product photo, gradient, dark corners"
)


def mat(
    mid,
    name,
    prompt,
    scale=2.0,
    roughness=0.85,
    metalness=0.0,
    normal_strength=1.0,
    tint=None,
    group="surface",
):
    """
    One entry in the library.

    `scale` is world units covered by one tile, which is the number that has to
    be right: it is the difference between a stone block wall and granite
    glitter. `tint` multiplies the albedo in the shader, so one grey stone can
    serve as three different stones without three generations.
    """
    return {
        "id": mid,
        "name": name,
        "group": group,
        "prompt": prompt + SUFFIX,
        "scale": scale,
        "roughness": roughness,
        "metalness": metalness,
        "normalStrength": normal_strength,
        "tint": tint,
    }


LIBRARY = [
    # --- masonry ---------------------------------------------------------
    mat("stone_ashlar", "Castle Ashlar",
        "a castle wall of large precisely cut grey granite ashlar blocks with thin mortar joints, "
        "weathered corners, faint lichen", scale=3.0, roughness=0.92, normal_strength=1.35),
    mat("stone_rubble", "Rubble Masonry",
        "a rough fieldstone rubble wall, irregular rounded stones set in pale lime mortar",
        scale=2.6, roughness=0.95, normal_strength=1.5),
    mat("stone_limestone", "Limestone Block",
        "pale cream limestone ashlar blocks, fine joints, soft weathering, cathedral masonry",
        scale=3.0, roughness=0.9, normal_strength=1.1),
    mat("stone_sandstone", "Sandstone Block",
        "warm honey sandstone blocks with horizontal bedding lines and eroded faces",
        scale=3.0, roughness=0.93, normal_strength=1.2),
    mat("stone_dark", "Dark Granite",
        "dark charcoal grey granite blocks, wet weathered, deep recessed joints",
        scale=3.2, roughness=0.88, normal_strength=1.4),
    mat("stone_mossy", "Mossy Stone",
        "old damp stone blocks overgrown with green moss in the joints and lower half",
        scale=2.8, roughness=0.96, normal_strength=1.4),
    mat("stone_marble", "White Marble",
        "polished white marble slab with soft grey veining, temple floor",
        scale=3.0, roughness=0.35, normal_strength=0.4),
    mat("brick_red", "Red Brick",
        "an old red clay brick wall in english bond, uneven bricks, crumbling pale mortar",
        scale=2.2, roughness=0.9, normal_strength=1.3),
    mat("cobblestone", "Cobblestone Street",
        "a medieval street of rounded granite cobblestones packed with dirt in the gaps, "
        "worn smooth by cart wheels", scale=3.0, roughness=0.9, normal_strength=1.6),
    mat("flagstone", "Flagstone Paving",
        "large flat irregular stone paving slabs, worn smooth, thin grass in the cracks",
        scale=3.6, roughness=0.9, normal_strength=1.1),

    # --- roofing ---------------------------------------------------------
    mat("roof_slate", "Slate Roof",
        "overlapping grey slate roof tiles in neat rows, slightly uneven, damp",
        scale=1.8, roughness=0.7, normal_strength=1.5, group="roof"),
    mat("roof_clay", "Clay Tile Roof",
        "overlapping terracotta barrel roof tiles in curved rows, orange red, weathered",
        scale=1.8, roughness=0.8, normal_strength=1.6, group="roof"),
    mat("roof_shingle", "Wood Shingle",
        "weathered grey wooden shingles overlapping in rows, split cedar shakes",
        scale=1.7, roughness=0.92, normal_strength=1.4, group="roof"),
    mat("roof_thatch", "Thatch",
        "a thick golden straw thatched roof, combed reed bundles running downward",
        scale=2.0, roughness=0.98, normal_strength=1.7, group="roof"),
    mat("roof_copper", "Verdigris Copper",
        "an aged copper sheet roof with green verdigris patina and standing seams",
        scale=2.4, roughness=0.55, metalness=0.35, normal_strength=0.9, group="roof"),
    mat("roof_lead", "Lead Sheet",
        "dull grey lead sheet roofing with raised seams and soft dents",
        scale=2.4, roughness=0.6, metalness=0.3, normal_strength=0.8, group="roof"),

    # --- timber ----------------------------------------------------------
    mat("wood_plank", "Oak Planks",
        "weathered oak floorboards laid side by side, visible grain, iron nail heads",
        scale=2.2, roughness=0.88, normal_strength=1.1),
    mat("wood_beam", "Tudor Timber",
        "dark stained oak timber framing beams laid tight, deep grain, adze marks",
        scale=2.4, roughness=0.9, normal_strength=1.2),
    mat("wood_door", "Studded Door",
        "heavy vertical oak door boards banded with black iron straps and round studs",
        scale=2.0, roughness=0.85, normal_strength=1.3),
    mat("wood_bark", "Bark",
        "deeply furrowed brown oak tree bark", scale=1.6, roughness=0.97, normal_strength=1.6),
    mat("wood_pale", "Pale Timber",
        "fresh cut pale pine planks, clean sawn grain, light honey colour",
        scale=2.2, roughness=0.85, normal_strength=1.0),

    # --- render and plaster ----------------------------------------------
    mat("plaster_white", "Lime Plaster",
        "whitewashed lime plaster wall, softly cracked, patchy grey staining near the base",
        scale=3.0, roughness=0.95, normal_strength=0.7),
    mat("plaster_ochre", "Ochre Render",
        "warm ochre painted lime render, flaking to reveal grey plaster beneath",
        scale=3.0, roughness=0.95, normal_strength=0.7),
    mat("daub", "Wattle and Daub",
        "rough cream wattle and daub wall panel, straw fibres visible, hand smoothed",
        scale=2.6, roughness=0.97, normal_strength=1.0),

    # --- metal -----------------------------------------------------------
    mat("iron_wrought", "Wrought Iron",
        "black hammered wrought iron plate, faint hammer dimples, oiled",
        scale=1.4, roughness=0.45, metalness=0.9, normal_strength=0.9, group="metal"),
    mat("iron_rust", "Rusted Iron",
        "heavily rusted iron plate, orange scale flaking off dark metal",
        scale=1.6, roughness=0.85, metalness=0.55, normal_strength=1.2, group="metal"),
    mat("steel", "Polished Steel",
        "brushed polished steel plate, fine directional grain, slight scratches",
        scale=1.4, roughness=0.25, metalness=1.0, normal_strength=0.5, group="metal"),
    mat("bronze", "Aged Bronze",
        "aged bronze surface, warm brown with dark patina in the low spots",
        scale=1.4, roughness=0.4, metalness=0.9, normal_strength=0.7, group="metal"),
    mat("gold", "Gilded Gold",
        "gilded gold leaf over relief, warm and lustrous, slight wear at the highs",
        scale=1.2, roughness=0.25, metalness=1.0, normal_strength=0.6, group="metal"),

    # --- ground ----------------------------------------------------------
    mat("dirt_path", "Dirt Road",
        "a packed dirt road surface, dry brown earth with small embedded pebbles and cart ruts",
        scale=3.2, roughness=0.98, normal_strength=1.1, group="ground"),
    mat("grass_meadow", "Meadow Grass",
        "short green meadow grass seen from directly above, dense blades, small clover",
        scale=2.6, roughness=0.98, normal_strength=1.0, group="ground"),
    mat("gravel", "Gravel",
        "a bed of grey crushed gravel chips, dense and even", scale=2.0,
        roughness=0.98, normal_strength=1.4, group="ground"),
    mat("mud", "Churned Mud", "wet churned brown mud with boot prints and shallow puddles",
        scale=2.8, roughness=0.6, normal_strength=1.2, group="ground"),
    mat("sand", "Sand", "fine wind rippled desert sand", scale=3.0,
        roughness=0.97, normal_strength=0.8, group="ground"),
    mat("snow", "Snow", "fresh windblown snow with soft drift ripples", scale=3.2,
        roughness=0.75, normal_strength=0.7, group="ground"),

    # --- cloth and soft ---------------------------------------------------
    mat("canvas_stripe", "Market Awning",
        "striped market awning canvas, wide cream and red vertical stripes, coarse weave",
        scale=2.0, roughness=0.95, normal_strength=0.8, group="cloth"),
    mat("cloth_banner", "Heraldic Cloth",
        "deep crimson heavy woollen banner cloth with a gold woven border thread",
        scale=1.8, roughness=0.95, normal_strength=0.7, group="cloth"),
    mat("leather", "Worn Leather",
        "worn brown leather hide, creased and scuffed, visible pores",
        scale=1.2, roughness=0.8, normal_strength=0.9, group="cloth"),
    mat("straw", "Straw Bale",
        "loose dry golden straw packed flat", scale=1.6, roughness=0.98,
        normal_strength=1.4, group="cloth"),
    mat("rope", "Rope Coil",
        "tightly laid hemp rope strands running parallel, twisted fibre",
        scale=1.0, roughness=0.95, normal_strength=1.3, group="cloth"),

    # --- character surfaces ------------------------------------------------
    mat("chainmail", "Chainmail",
        "riveted steel chainmail rings in dense rows, dark oiled metal",
        scale=0.8, roughness=0.45, metalness=0.85, normal_strength=1.5, group="character"),
    mat("skin_human", "Human Skin",
        "smooth pale human skin, fine pores, subtle warmth", scale=1.0,
        roughness=0.7, normal_strength=0.35, group="character"),
    mat("skin_green", "Orc Hide",
        "coarse mottled dark green orc skin, thick and leathery, faint scars",
        scale=1.0, roughness=0.85, normal_strength=0.8, group="character"),
    mat("scale_green", "Dragon Scale",
        "overlapping green reptile scales, glossy, dark edges", scale=0.9,
        roughness=0.45, normal_strength=1.4, group="character"),
    mat("fur_brown", "Brown Fur",
        "thick brown animal fur lying in one direction, coarse guard hairs",
        scale=1.0, roughness=0.95, normal_strength=1.2, group="character"),
    mat("bone", "Bone",
        "old dry bone surface, ivory white with fine cracks and brown staining",
        scale=1.2, roughness=0.85, normal_strength=0.7, group="character"),
    mat("robe_cloth", "Wizard Wool",
        "deep indigo woven wool robe cloth, visible twill weave, soft nap",
        scale=1.2, roughness=0.96, normal_strength=0.7, group="character"),
]

def variant(mid, base, name, tint, scale=None, roughness=None, group=None):
    """
    A recolour of a material that already exists.

    Costs nothing to ship: it reads the same two files and differs only in the
    multiplier the shader applies. A street of plaster houses needs five
    plasters and one plaster texture, and generating five would give five
    different brick patterns pretending to be paint.
    """
    src = BASE_BY_ID[base]
    return {
        "id": mid,
        "name": name,
        "group": group or src["group"],
        "maps": base,
        "prompt": None,
        "scale": scale if scale is not None else src["scale"],
        "roughness": roughness if roughness is not None else src["roughness"],
        "metalness": src["metalness"],
        "normalStrength": src["normalStrength"],
        "tint": tint,
    }


BASE_BY_ID = {m["id"]: m for m in LIBRARY}

VARIANTS = [
    variant("plaster_cream", "plaster_white", "Cream Plaster", "#e6dbbf"),
    variant("plaster_pink", "plaster_white", "Pink Wash", "#e3c0b1"),
    variant("plaster_blue", "plaster_white", "Blue Wash", "#c2cddd"),
    variant("plaster_sage", "plaster_white", "Sage Wash", "#c5cfb3"),
    variant("plaster_grey", "plaster_white", "Grey Render", "#c3c3c1"),
    variant("roof_clay_dark", "roof_clay", "Weathered Tile", "#9c6951"),
    variant("roof_clay_pale", "roof_clay", "Sun-bleached Tile", "#d79f73"),
    variant("roof_slate_blue", "roof_slate", "Blue Slate", "#96a4b7"),
    variant("roof_thatch_old", "roof_thatch", "Old Thatch", "#9c8962"),
    variant("stone_ashlar_warm", "stone_ashlar", "Warm Ashlar", "#d7c8a7"),
    variant("stone_ashlar_cold", "stone_ashlar", "Cold Ashlar", "#a8afb5"),
    variant("stone_rubble_dark", "stone_rubble", "Dark Rubble", "#99948b"),
    variant("wood_beam_black", "wood_beam", "Blackened Beam", "#6a5947"),
    variant("wood_plank_grey", "wood_plank", "Silvered Plank", "#b5b1a7"),
    variant("cobble_worn", "cobblestone", "Worn Cobble", "#b8b3aa"),
    # Ground variants. The generated dirt is dry orange earth, which is right
    # for a road across a summer field and far too loud spread over every yard
    # in a city; cooling it turns the same texture into trodden mud.
    variant("dirt_grey", "dirt_path", "Trodden Earth", "#b7a893", group="ground"),
    variant("grass_dry", "grass_meadow", "Dry Grass", "#cfc394", group="ground"),
    variant("mud_dark", "mud", "Deep Mud", "#8e8377", group="ground"),
]

LIBRARY = LIBRARY + VARIANTS
BY_ID = {m["id"]: m for m in LIBRARY}


# --------------------------------------------------------------------------
# graph
# --------------------------------------------------------------------------


def _txt2img_batch(items, steps=28, cfg=5.0):
    """`items` is [(id, prompt, seed)]. One loader, many samplers."""
    g = {
        "L": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "N": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L", 1], "text": NEGATIVE}},
    }
    for i, (mid, prompt, seed) in enumerate(items):
        g["p%d" % i] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L", 1], "text": prompt}}
        g["l%d" % i] = {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": SIZE, "height": SIZE, "batch_size": 1},
        }
        g["k%d" % i] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["L", 0], "positive": ["p%d" % i, 0], "negative": ["N", 0],
                "latent_image": ["l%d" % i, 0], "seed": seed, "steps": steps, "cfg": cfg,
                "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
            },
        }
        g["d%d" % i] = {"class_type": "VAEDecode", "inputs": {"samples": ["k%d" % i, 0], "vae": ["L", 2]}}
        g["s%d" % i] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["d%d" % i, 0], "filename_prefix": "gamegen_mat/" + mid},
        }
    return g


def _seam_batch(items, steps=26, cfg=5.0):
    """
    Inpaints the seam cross of already-rolled images.

    `items` is [(id, image_name, mask_name, prompt, seed)] where both names are
    paths under ComfyUI's input directory. Denoise is 1.0: the band is being
    replaced, not nudged, and it has nine hundred pixels of context on both
    sides to agree with.
    """
    g = {
        "L": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "N": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L", 1], "text": NEGATIVE}},
    }
    for i, (mid, image_name, mask_name, prompt, seed) in enumerate(items):
        g["p%d" % i] = {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L", 1], "text": prompt}}
        g["i%d" % i] = {"class_type": "LoadImage", "inputs": {"image": image_name}}
        g["mi%d" % i] = {"class_type": "LoadImage", "inputs": {"image": mask_name}}
        g["m%d" % i] = {
            "class_type": "ImageToMask",
            "inputs": {"image": ["mi%d" % i, 0], "channel": "red"},
        }
        g["c%d" % i] = {
            "class_type": "InpaintModelConditioning",
            "inputs": {
                "positive": ["p%d" % i, 0], "negative": ["N", 0], "vae": ["L", 2],
                "pixels": ["i%d" % i, 0], "mask": ["m%d" % i, 0], "noise_mask": True,
            },
        }
        g["k%d" % i] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["L", 0], "positive": ["c%d" % i, 0], "negative": ["c%d" % i, 1],
                "latent_image": ["c%d" % i, 2], "seed": seed, "steps": steps, "cfg": cfg,
                "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0,
            },
        }
        g["d%d" % i] = {"class_type": "VAEDecode", "inputs": {"samples": ["k%d" % i, 0], "vae": ["L", 2]}}
        g["s%d" % i] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["d%d" % i, 0], "filename_prefix": "gamegen_seam/" + mid},
        }
    return g


# --------------------------------------------------------------------------
# image maths
# --------------------------------------------------------------------------


def _roll_half(a):
    return np.roll(a, (a.shape[0] // 2, a.shape[1] // 2), axis=(0, 1))


def _seam_mask(n, band=SEAM_BAND):
    """White cross down the middle: where the wrapped edges land after a roll."""
    m = np.zeros((n, n), np.uint8)
    h = band // 2
    c = n // 2
    m[c - h : c + h, :] = 255
    m[:, c - h : c + h] = 255
    return m


def seam_score(rgb):
    """
    How far from tiling an image is, as a ratio.

    The wrap difference is compared against the difference between neighbouring
    interior rows, so a noisy texture is not punished for being noisy. One means
    the wrap is as continuous as the middle of the image; four means a visible
    line.
    """
    a = rgb.astype(np.float32)
    interior = (
        np.abs(a[1:-1, :] - a[2:, :]).mean() + np.abs(a[:, 1:-1] - a[:, 2:]).mean()
    ) / 2 + 1e-5
    wrap = (np.abs(a[0, :] - a[-1, :]).mean() + np.abs(a[:, 0] - a[:, -1]).mean()) / 2
    return float(wrap / interior)


def _wrapped(a, pad, fn):
    """
    Runs a filter as if the image tiled.

    OpenCV refuses BORDER_WRAP for separable filters, and every filter here has
    to wrap or it undoes the seam work: a blur that clamps at the edge darkens
    the border, and a Sobel that clamps invents a ridge exactly where the tiles
    meet. Padding with the opposite edge and cropping back is the same thing by
    hand.
    """
    pad = min(pad, min(a.shape[0], a.shape[1]) - 1)
    width = ((pad, pad), (pad, pad)) + ((0, 0),) * (a.ndim - 2)
    out = fn(np.pad(a, width, mode="wrap"))
    return out[pad : pad + a.shape[0], pad : pad + a.shape[1]]


def _blur(a, sigma):
    import cv2

    k = int(sigma * 4) | 1
    return _wrapped(a, k, lambda p: cv2.GaussianBlur(p, (k, k), sigma))


def delight(rgb, strength=0.75):
    """
    Divides out the low frequencies so the texture carries no lighting of its own.

    SDXL always paints a light source somewhere. Tiled, that becomes a grid of
    identical bright patches, which is the single most obvious tell that a
    surface is repeating. Dividing by a heavy blur removes the gradient and
    leaves the grain, and wrapping the blur keeps the tiling intact.
    """
    a = rgb.astype(np.float32) / 255.0
    low = _blur(a, rgb.shape[0] / 12.0)
    mean = low.mean(axis=(0, 1), keepdims=True)
    flat = a * (mean / np.maximum(low, 1e-3))
    out = a * (1 - strength) + flat * strength
    return np.clip(out * 255.0, 0, 255).astype(np.uint8)


def normal_rough(rgb, strength=1.0, size=NORMAL_SIZE):
    """
    Normal in RG, roughness in B, one file.

    Height comes from luminance, which is wrong in principle and right in
    practice for stone, timber and cloth: the dark parts are the recesses.
    Z is dropped because it is recoverable from the other two, which buys the
    third channel for roughness.
    """
    import cv2

    small = cv2.resize(rgb, (size, size), interpolation=cv2.INTER_AREA)
    lum = cv2.cvtColor(small, cv2.COLOR_RGB2GRAY).astype(np.float32) / 255.0

    # Height is the band between the tone and the grain. Subtracting the low
    # frequencies stops a dark stone from reading as a dent, and smoothing what
    # is left stops per-pixel film grain from reading as sandpaper: a Sobel
    # straight off the luminance sparkles under a moving light, and costs three
    # times the bytes because JPEG cannot compress noise.
    base = _wrapped(lum, 80, lambda p: cv2.GaussianBlur(p, (0, 0), 18))
    height = _wrapped(lum - base, 8, lambda p: cv2.GaussianBlur(p, (0, 0), 1.5))

    gx = _wrapped(height, 4, lambda p: cv2.Sobel(p, cv2.CV_32F, 1, 0, ksize=3))
    gy = _wrapped(height, 4, lambda p: cv2.Sobel(p, cv2.CV_32F, 0, 1, ksize=3))

    # The gradient scale is fitted, not chosen. A fixed multiplier means the
    # slope depends on how contrasty the generated image happened to be: at one
    # constant, nine tenths of the stone saturated to a hard foil, and thatch on
    # the same constant was nearly flat. Pinning a high percentile of the
    # gradient to a known slope makes `normalStrength` mean the same thing on
    # every material, and unsaturated maps also compress to half the bytes.
    steep = float(np.percentile(np.hypot(gx, gy), 92))
    scale = (0.55 * strength) / max(steep, 1e-4)
    nx = np.clip(-gx * scale, -1, 1)
    ny = np.clip(gy * scale, -1, 1)

    # Local contrast stands in for roughness: a polished face is smooth and
    # even, a broken one is not. Weak, but better than a constant. Blurred hard
    # afterwards, because what matters is which *region* is rough, and the
    # unblurred version is per-pixel noise that costs more bytes than the normal
    # it shares a file with.
    detail = np.abs(lum - _wrapped(lum, 24, lambda p: cv2.GaussianBlur(p, (0, 0), 6)))
    detail = _wrapped(detail, 16, lambda p: cv2.GaussianBlur(p, (0, 0), 4))
    rough = np.clip(0.5 + detail * 4.0, 0, 1)

    out = np.zeros((size, size, 3), np.uint8)
    out[..., 0] = ((nx * 0.5 + 0.5) * 255).astype(np.uint8)
    out[..., 1] = ((ny * 0.5 + 0.5) * 255).astype(np.uint8)
    out[..., 2] = (rough * 255).astype(np.uint8)
    return out


def derive_maps(mid, spec, raw_path):
    os.makedirs(PACK_DIR, exist_ok=True)
    rgb = np.asarray(Image.open(raw_path).convert("RGB"))
    albedo = delight(rgb)
    nr = normal_rough(albedo, spec["normalStrength"])

    a_path = os.path.join(PACK_DIR, mid + "_a.jpg")
    n_path = os.path.join(PACK_DIR, mid + "_nr.jpg")
    Image.fromarray(albedo).save(a_path, quality=85, optimize=True)
    # 4:4:4 for the packed map: chroma subsampling would smear the normal's two
    # channels into each other and into the roughness. Not optimised, because
    # PIL's optimising encoder needs a buffer bigger than a row of a 4:4:4
    # image and gives up with "broken data stream" rather than growing it.
    Image.fromarray(nr).save(n_path, quality=90, subsampling=0)
    return {
        "albedoBytes": os.path.getsize(a_path),
        "mapBytes": os.path.getsize(n_path),
        "seam": round(seam_score(rgb), 3),
    }


# --------------------------------------------------------------------------
# driver
# --------------------------------------------------------------------------


def load_manifest():
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            return json.load(f)
    return {}


def save_manifest(m):
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f:
        json.dump(m, f, indent=1)
    os.replace(tmp, MANIFEST)


def _out_path(entry):
    sub = entry.get("subfolder", "")
    return os.path.join(COMFY_OUT, sub, entry["filename"])


def _seed(mid, salt=0):
    return (abs(hash("mat:" + mid)) + salt * 7919) % (2**31)


def generate(only=None, limit=None, force=False, log=print):
    # Variants have nothing to generate: they are a tint over somebody else's
    # maps, and they enter the manifest through `remap`.
    todo = [m for m in LIBRARY if not m.get("maps") and (not only or m["id"].startswith(only))]
    man = load_manifest()
    if not force:
        todo = [m for m in todo if m["id"] not in man]
    if limit:
        todo = todo[:limit]
    log("materials: %d to generate" % len(todo))
    if not todo:
        return man

    os.makedirs(RAW_DIR, exist_ok=True)
    os.makedirs(STAGE, exist_ok=True)

    for start in range(0, len(todo), BATCH):
        chunk = todo[start : start + BATCH]
        t0 = time.time()

        # pass one: the surface, with no wrapping at all
        items = [(m["id"], m["prompt"], _seed(m["id"])) for m in chunk]
        outputs, _ = cc.run(_txt2img_batch(items), timeout=180 + 90 * len(chunk))

        # roll each one so its edges meet in the middle, and stage the pair
        seam_items = []
        mask = Image.fromarray(_seam_mask(SIZE))
        mask_name = "gamegen_mat/_seammask.png"
        mask.save(os.path.join(STAGE, "_seammask.png"))
        for i, spec in enumerate(chunk):
            files = cc.files_of(outputs.get("s%d" % i, {}))
            if not files:
                log("  %-18s no image" % spec["id"])
                continue
            rgb = np.asarray(Image.open(_out_path(files[0])).convert("RGB"))
            rolled = _roll_half(rgb)
            name = spec["id"] + "_rolled.png"
            Image.fromarray(rolled).save(os.path.join(STAGE, name))
            seam_items.append(
                (spec["id"], "gamegen_mat/" + name, mask_name, spec["prompt"], _seed(spec["id"], 1))
            )

        # pass two: fill the cross
        outputs2, _ = cc.run(_seam_batch(seam_items), timeout=180 + 90 * len(seam_items))

        for i, (mid, _n, _m, _p, _s) in enumerate(seam_items):
            spec = BY_ID[mid]
            files = cc.files_of(outputs2.get("s%d" % i, {}))
            if not files:
                log("  %-18s no seam pass" % mid)
                continue
            healed = np.asarray(Image.open(_out_path(files[0])).convert("RGB"))
            # Rolling back puts the healed cross at the edges, where it belongs.
            final = _roll_half(healed)
            raw_path = os.path.join(RAW_DIR, mid + ".png")
            Image.fromarray(final).save(raw_path)
            info = derive_maps(mid, spec, raw_path)
            rec = {k: spec[k] for k in FIELDS}
            rec.update(info)
            man[mid] = rec
            log("  %-18s seam %.2f  %5.0fkB + %4.0fkB" % (
                mid, info["seam"], info["albedoBytes"] / 1024, info["mapBytes"] / 1024))
        save_manifest(man)
        log("  batch of %d in %.0fs" % (len(chunk), time.time() - t0))

    return man


FIELDS = ("id", "name", "group", "scale", "roughness", "metalness", "normalStrength", "tint")


def remap(only=None, log=print):
    man = load_manifest()
    for m in LIBRARY:
        if only and not m["id"].startswith(only):
            continue
        if m.get("maps"):
            # Nothing to derive; the variant just needs a row that points at
            # the maps it borrows.
            rec = {k: m[k] for k in FIELDS}
            rec["maps"] = m["maps"]
            base = man.get(m["maps"], {})
            rec["albedoBytes"] = 0
            rec["mapBytes"] = 0
            rec["seam"] = base.get("seam", 1.0)
            man[m["id"]] = rec
            continue
        raw = os.path.join(RAW_DIR, m["id"] + ".png")
        if not os.path.exists(raw):
            continue
        info = derive_maps(m["id"], m, raw)
        rec = {k: m[k] for k in FIELDS}
        rec.update(info)
        man[m["id"]] = rec
        log("  %-18s seam %.2f" % (m["id"], info["seam"]))
    save_manifest(man)
    return man


def check(log=print):
    man = load_manifest()
    rows = []
    for mid, rec in sorted(man.items()):
        raw = os.path.join(RAW_DIR, mid + ".png")
        if not os.path.exists(raw):
            continue
        s = seam_score(np.asarray(Image.open(raw).convert("RGB")))
        rows.append((s, mid))
    rows.sort(reverse=True)
    for s, mid in rows:
        log("  %5.2f  %s%s" % (s, mid, "   <-- visible seam" if s > 2.5 else ""))
    log("%d materials, %d over threshold" % (len(rows), sum(1 for s, _ in rows if s > 2.5)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("command", choices=["list", "gen", "maps", "check"])
    ap.add_argument("--only")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args()

    if a.command == "list":
        for m in LIBRARY:
            print("%-18s %-10s scale %.1f  %s" % (m["id"], m["group"], m["scale"], m["name"]))
        print("%d materials" % len(LIBRARY))
    elif a.command == "gen":
        generate(a.only, a.limit, a.force)
    elif a.command == "maps":
        remap(a.only)
    elif a.command == "check":
        check()


if __name__ == "__main__":
    main()
