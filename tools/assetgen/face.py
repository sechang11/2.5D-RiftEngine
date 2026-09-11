"""
Turns each concept image into a colour map the engine can wrap round its mesh.

The sixteen-band palette this replaces was the right idea at the wrong
dimension. A band average says "red at the top, cream in the middle", which is
enough to stop a city being grey and not enough to put a dark window where a
window is, a brown door where a door is, or a red tabard on a knight. All of
that is in the image the mesh was reconstructed from, and the reconstruction is
in that image's own frame, so the two line up.

So: crop the concept back to its subject, flatten it a little, and ship it at
256 square. The engine wraps it round the mesh cylindrically — height always
maps to height, and the horizontal coordinate comes from whichever axis the
surface faces — so the front is right, the sides are plausible and the back is
the front again, which for a building is what the back looks like anyway.

Twelve kilobytes an asset. The mesh it dresses is a hundred.

Three things are done to the image on the way through:

  crop      to the subject's own bounding box, because the mesh's extents are
            the subject's extents and the padded frame would shift everything
  bleed     the subject's edge colour outward into the background, so the
            margin does not put a white halo round the silhouette
  flatten   divide out the large-scale shading, because the engine is going to
            light this itself and baked-in shadow read twice is mud

  python3 face.py            # every asset with a concept image
  python3 face.py --only civic_
"""

import argparse
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.expanduser("~/gamegen")
CONCEPT_DIR = os.path.join(ROOT, "out", "concept")
FACE_DIR = os.path.join(ROOT, "out", "faces")
MANIFEST = os.path.join(ROOT, "out", "manifest.json")

SIZE = 256
#: Bigger where it is looked at closely. Architecture is what the camera gets
#: near and what fills the screen when it does; a barrel is neither.
SIZE_BY_CATEGORY = {
    "civic": 512,
    "fort": 512,
    "house": 512,
    "rural": 384,
    "dock": 384,
    "folk": 384,
    "creature": 384,
    "building": 384,
}
#: Chroma is pushed out because the engine keeps the material's luminance and
#: takes only the hue from here; a timid hue transfers as no hue at all.
SATURATION = 1.5
#: How much of the image's own large-scale shading to remove.
FLATTEN = 0.65


def subject_mask(rgb):
    """
    Everything a flood fill from the border cannot reach.

    Thresholding against the border colour does not work: the generator paints
    a soft vignette, so its corners are further from its centre than a knight
    in polished plate is. A floating-tolerance fill walks that gradient one
    step at a time and stops at the first real edge.
    """
    import cv2

    h, w = rgb.shape[:2]
    work = rgb.astype(np.uint8).copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    tol = (7, 7, 7)
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1),
             (w // 2, 0), (w // 2, h - 1), (0, h // 2), (w - 1, h // 2)]
    for seed in seeds:
        cv2.floodFill(work, ff, seed, (0, 0, 0), tol, tol,
                      4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    background = ff[1:-1, 1:-1] > 0
    background = cv2.dilate(background.astype(np.uint8), np.ones((5, 5), np.uint8), 1) > 0
    return ~background


def bleed(rgb, mask, iterations=48):
    """
    Grows the subject outward over the background.

    Whatever is left of the frame after the crop is margin, and leaving it the
    colour of the paper puts a white rim round every silhouette once the engine
    wraps the image round a mesh whose outline does not match it exactly.
    """
    import cv2

    out = rgb.copy()
    known = mask.astype(np.uint8)
    kernel = np.ones((3, 3), np.uint8)
    for _ in range(iterations):
        if known.all():
            break
        grown = cv2.dilate(known, kernel, 1)
        edge = (grown > 0) & (known == 0)
        if not edge.any():
            break
        blurred = cv2.blur(out * known[..., None], (3, 3))
        weight = cv2.blur(known.astype(np.float32), (3, 3))
        filled = blurred / np.maximum(weight, 1e-3)[..., None]
        out[edge] = filled[edge]
        known = grown
    return out


def flatten(rgb, strength=FLATTEN):
    """Divides out the large-scale shading the concept art was drawn with."""
    import cv2

    a = rgb.astype(np.float32) / 255.0
    sigma = max(4.0, rgb.shape[0] / 6.0)
    low = cv2.GaussianBlur(a, (0, 0), sigma)
    mean = low.mean(axis=(0, 1), keepdims=True)
    flat = a * (mean / np.maximum(low, 1e-3))
    return np.clip((a * (1 - strength) + flat * strength) * 255.0, 0, 255).astype(np.uint8)


def saturate(rgb, k=SATURATION):
    a = rgb.astype(np.float32)
    grey = a @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    return np.clip(grey[..., None] + (a - grey[..., None]) * k, 0, 255).astype(np.uint8)


def build(path, size=SIZE):
    """Returns (image, aspect) where aspect is the subject's width over height."""
    import cv2

    rgb = np.asarray(Image.open(path).convert("RGB"))
    mask = subject_mask(rgb)
    if not mask.any():
        return None, 1.0

    ys, xs = np.where(mask)
    y0, y1 = int(ys.min()), int(ys.max()) + 1
    x0, x1 = int(xs.min()), int(xs.max()) + 1

    filled = bleed(rgb, mask)
    crop = filled[y0:y1, x0:x1]
    aspect = (x1 - x0) / max(1, y1 - y0)

    # Square, because the engine addresses it in normalised coordinates and the
    # mesh's own extents supply the proportions.
    square = cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)
    # A light unsharp pass, because area-averaging a thousand pixels down to a
    # few hundred costs exactly the edges — the window frames and the timber —
    # that the transfer exists to carry.
    blur = cv2.GaussianBlur(square, (0, 0), 1.1)
    square = cv2.addWeighted(square, 1.45, blur, -0.45, 0)
    return saturate(flatten(square)), aspect


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    a = ap.parse_args()

    os.makedirs(FACE_DIR, exist_ok=True)
    with open(MANIFEST) as f:
        manifest = json.load(f)

    done = 0
    missing = 0
    for aid in sorted(manifest["assets"]):
        if a.only and not aid.startswith(a.only):
            continue
        src = os.path.join(CONCEPT_DIR, aid + ".png")
        if not os.path.exists(src):
            missing += 1
            continue
        category = manifest["assets"][aid].get("category", "prop")
        img, _aspect = build(src, SIZE_BY_CATEGORY.get(category, SIZE))
        if img is None:
            missing += 1
            continue
        Image.fromarray(img).save(os.path.join(FACE_DIR, aid + ".jpg"), quality=84, optimize=True)
        done += 1

    total = sum(
        os.path.getsize(os.path.join(FACE_DIR, f)) for f in os.listdir(FACE_DIR) if f.endswith(".jpg")
    )
    print("wrote %d face maps, %.1f MB total%s" % (
        done, total / 1024 / 1024, "" if not missing else ", %d skipped" % missing))


if __name__ == "__main__":
    main()
