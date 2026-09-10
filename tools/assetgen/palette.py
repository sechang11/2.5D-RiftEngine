"""
Takes the colour out of the concept art and puts it in the manifest.

The reconstructor throws away everything but shape. The concept image it worked
from is right there on disk, and it is the thing that actually looked good: a
red tiled roof over cream plaster over a grey stone base. Tiling materials give
the surface back but not that arrangement, so a hut and a guildhall end up the
same colour because they were assigned the same stone.

What survives the trip from a picture to a mesh is the *vertical* arrangement.
The concept is a front view of an upright object, so the colour it has at a
given height is the colour the mesh should have at that height, and a sixteen
band average down the image is enough to carry it: roof at the top, wall in the
middle, plinth at the bottom. Sixteen colours per asset, forty-eight bytes.

Extraction has to ignore the background, which is a near-white field the
prompt asked for and the crop left around the edges. It is identified from the
border rather than assumed, because "near-white" is also what a plastered wall
and a snowdrift are.

Written to its own file rather than into the manifest, because a generation
phase holds the manifest open for the length of a run and rewrites its own copy
after every batch: an edit made while one is running is silently lost at its
next save. The importer merges this file in.

  python3 palette.py            # every asset with a concept image
  python3 palette.py --only civic_
  python3 palette.py --report   # print what was found, write nothing
"""

import argparse
import json
import os

import numpy as np
from PIL import Image

ROOT = os.path.expanduser("~/gamegen")
CONCEPT_DIR = os.path.join(ROOT, "out", "concept")
MANIFEST = os.path.join(ROOT, "out", "manifest.json")
PALETTES = os.path.join(ROOT, "out", "palettes.json")

BANDS = 16
#: A band with fewer than this share of subject pixels borrows from its neighbour.
MIN_BAND_FILL = 0.015


def _subject_mask(rgb):
    """
    Everything the border cannot reach.

    Thresholding against the border's colour does not work, because the
    background is not one colour: the generator paints a soft vignette, so its
    corners are further from its centre than a knight in polished plate is. A
    flood fill from the four edges with a *floating* tolerance walks that
    gradient one step at a time and stops at the first real edge, which is the
    subject's outline. Before this, two thirds of a knight's image counted as
    knight and every figure in the pack came out the colour of the paper.
    """
    import cv2

    h, w = rgb.shape[:2]
    filled = rgb.astype(np.uint8).copy()
    ff = np.zeros((h + 2, w + 2), np.uint8)
    tol = (7, 7, 7)
    seeds = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1), (w // 2, 0), (w // 2, h - 1),
             (0, h // 2), (w - 1, h // 2)]
    for seed in seeds:
        cv2.floodFill(filled, ff, seed, (0, 0, 0), tol, tol,
                      4 | cv2.FLOODFILL_MASK_ONLY | (255 << 8))
    background = ff[1:-1, 1:-1] > 0

    # Close the one-pixel halo the fill leaves along the silhouette, so the
    # subject's own edge pixels are not counted as subject either.
    background = cv2.dilate(background.astype(np.uint8), np.ones((5, 5), np.uint8), 1) > 0
    return ~background


def extract(path, bands=BANDS):
    """
    Returns (palette, coverage). `palette` is `bands` RGB triples in 0..1,
    ordered from the bottom of the image to the top, which is the order the
    mesh's own Y axis runs in.
    """
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    subject = _subject_mask(rgb)

    height = rgb.shape[0]
    edges = np.linspace(0, height, bands + 1).astype(int)
    out = []
    fills = []
    for b in range(bands):
        # Image rows run top to bottom; the palette runs bottom to top.
        r0, r1 = edges[bands - 1 - b], edges[bands - b]
        strip = rgb[r0:r1]
        mask = subject[r0:r1]
        fill = float(mask.mean())
        fills.append(fill)
        if fill < MIN_BAND_FILL:
            out.append(None)
            continue
        # Median, not mean: a tight crop still leaves a halo of near-background
        # ringing around the silhouette, and enough of it in a thin band drags
        # the average all the way back to the background it came from. Every
        # figure in the pack came out the colour of the paper behind it.
        out.append((np.median(strip[mask], axis=0) / 255.0).tolist())

    # A band that saw almost no subject — the sky above a spire, the gap under
    # an arch — takes the nearest band that did, rather than the background.
    known = [i for i, c in enumerate(out) if c is not None]
    if not known:
        return [[0.72, 0.7, 0.66]] * bands, 0.0
    for i, c in enumerate(out):
        if c is None:
            j = min(known, key=lambda k: abs(k - i))
            out[i] = out[j]

    # Smooth along the run so one weak band cannot put a white ring round a
    # spire. Three taps: enough to fix a bad band, not enough to grey the roof.
    arr = np.array(out, dtype=np.float32)
    smooth = arr.copy()
    for i in range(bands):
        lo = max(0, i - 1)
        hi = min(bands, i + 2)
        smooth[i] = arr[lo:hi].mean(axis=0)
    return smooth.tolist(), float(np.mean(fills))


#: Averaging a band mixes its highlights with its shadows and lands on mud. The
#: concept art is not muddy, so the chroma is pushed back out around the band's
#: own grey before it is stored. Luminance is untouched; the shader takes that
#: from the texture anyway.
SATURATION = 1.55


def saturate(c, k=SATURATION):
    grey = 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]
    return [min(1.0, max(0.0, grey + (v - grey) * k)) for v in c]


def to_hex(c):
    return "#%02x%02x%02x" % tuple(max(0, min(255, int(round(v * 255)))) for v in c)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--report", action="store_true")
    a = ap.parse_args()

    with open(MANIFEST) as f:
        manifest = json.load(f)

    out = {}
    if os.path.exists(PALETTES):
        with open(PALETTES) as f:
            out = json.load(f)

    done = 0
    missing = []
    for aid, entry in sorted(manifest["assets"].items()):
        if a.only and not aid.startswith(a.only):
            continue
        path = os.path.join(CONCEPT_DIR, aid + ".png")
        if not os.path.exists(path):
            missing.append(aid)
            continue
        palette, coverage = extract(path)
        hexes = [to_hex(saturate(c)) for c in palette]
        if a.report:
            print("%-28s %.2f  %s .. %s" % (aid, coverage, hexes[0], hexes[-1]))
        else:
            out[aid] = hexes
        done += 1

    if not a.report:
        tmp = PALETTES + ".tmp"
        with open(tmp, "w") as f:
            json.dump(out, f, indent=0)
        os.replace(tmp, PALETTES)

    print("palettes for %d assets%s" % (done, "" if not missing else "; %d without concept art" % len(missing)))
    for aid in missing[:10]:
        print("   no concept:", aid)


if __name__ == "__main__":
    main()
