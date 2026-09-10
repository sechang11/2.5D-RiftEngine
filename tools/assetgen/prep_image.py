"""
Prepares concept art for single-view reconstruction.

The vision encoder sees a small square: a 1024px render is downsampled to a few
hundred pixels before the 3D model ever looks at it. A sword drawn thin and
centred in a wide white field survives that downsample as a smear about ten
pixels across, and the reconstructor does the only sensible thing with almost
no signal, which is to return a ball.

So the object is found, cropped tight, padded back to square with a small
margin, and rescaled to fill the frame. This is the difference between a sword
and a sphere, and it costs a few milliseconds.
"""

import os

import numpy as np
from PIL import Image

# Fraction of the final frame left as empty margin around the object.
MARGIN = 0.06

# Border band sampled to learn what the background actually is.
BORDER = 10

# Fraction of subject pixels trimmed from each end of the bounding box. Diffusion
# leaves faint speckle in the background; taking a percentile rather than the
# absolute extremes stops one stray pixel from defining the crop.
TRIM = 0.002


def _subject_mask(arr):
    """
    Boolean mask of the subject.

    The background is whatever the image's own border is, not an assumed white:
    these renders carry a soft vignette, so a fixed white cut marks the entire
    frame as subject and the crop becomes a no-op. Measuring the border's colour
    and its variation adapts the tolerance per image.
    """
    h, w = arr.shape[:2]
    border = np.concatenate(
        [
            arr[:BORDER, :, :].reshape(-1, 3),
            arr[-BORDER:, :, :].reshape(-1, 3),
            arr[:, :BORDER, :].reshape(-1, 3),
            arr[:, -BORDER:, :].reshape(-1, 3),
        ]
    ).astype(np.float32)

    bg = np.median(border, axis=0)
    spread = float(np.percentile(np.abs(border - bg).max(axis=1), 98))
    tol = max(20.0, spread * 2.0 + 8.0)

    dist = np.abs(arr.astype(np.float32) - bg).max(axis=2)
    mask = dist > tol

    try:
        from scipy import ndimage

        # Bridge thin gaps, then fill interior holes.
        #
        # This step is the difference between a character and a shredded one.
        # A specular highlight on armour or skin is as bright as the white
        # background, so a pure colour test punches holes straight through the
        # subject, and the reconstructor faithfully builds a model full of
        # holes. Anything enclosed by the silhouette is subject, whatever
        # colour it happens to be.
        mask = ndimage.binary_closing(mask, structure=np.ones((5, 5)))
        mask = ndimage.binary_fill_holes(mask)
        mask = ndimage.binary_opening(mask, structure=np.ones((3, 3)))

        labels, n = ndimage.label(mask)
        if n > 1:
            sizes = ndimage.sum(mask, labels, range(1, n + 1))
            # Keep the body and any substantial detached part, such as a
            # sword's floating wings, and drop soft background blooms.
            keep = np.where(sizes >= sizes.max() * 0.05)[0] + 1
            mask = np.isin(labels, keep)
            mask = ndimage.binary_fill_holes(mask)

        # Grow slightly so the silhouette edge is not shaved off.
        mask = ndimage.binary_dilation(mask, structure=np.ones((3, 3)), iterations=2)
    except Exception:
        pass

    return mask


def object_bounds(rgb):
    """Bounding box of the subject, or None when the frame is empty."""
    arr = np.asarray(rgb.convert("RGB"), dtype=np.uint8)
    mask = _subject_mask(arr)
    if mask.sum() < 64:
        return None

    row_counts = mask.sum(axis=1).astype(np.float64)
    col_counts = mask.sum(axis=0).astype(np.float64)
    total = mask.sum()

    def span(counts):
        c = np.cumsum(counts)
        lo = int(np.searchsorted(c, total * TRIM))
        hi = int(np.searchsorted(c, total * (1.0 - TRIM)))
        return lo, min(len(counts), hi + 1)

    y0, y1 = span(row_counts)
    x0, x1 = span(col_counts)
    if x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def prepare(src_path, dst_path, size=1024, margin=MARGIN, background=None, flatten=False):
    """
    Writes a square image with the subject filling the frame.

    Returns a dict describing what was done, so a batch run can flag images
    where nothing was found or the subject was suspiciously small.
    """
    img = Image.open(src_path).convert("RGB")
    box = object_bounds(img)
    if box is None:
        # Subject detection fails when the render fills the frame edge to edge,
        # because then the border is subject rather than background. Using the
        # whole image is the right answer in exactly that case, and losing the
        # asset entirely over a cropping heuristic is not.
        box = (0, 0, img.width, img.height)
    if background is None:
        background = (255, 255, 255)

    # Background flattening is available but off by default.
    #
    # It was added to suppress the ground plate the reconstructor invents from
    # the vignette, and it does help thin objects. But a colour-distance mask
    # cannot tell a white tunic from a white background: on characters it
    # erases pale clothing and armour highlights, and the reconstruction comes
    # back shredded. The plate is dealt with geometrically after meshing
    # instead, which is safe for every subject rather than most of them.
    if flatten:
        arr_full = np.asarray(img, dtype=np.uint8)
        mask = _subject_mask(arr_full).astype(np.float32)
        try:
            from scipy import ndimage

            alpha = ndimage.gaussian_filter(mask, 1.1)
            alpha = np.clip(alpha * 1.25, 0.0, 1.0)
        except Exception:
            alpha = mask
        flat = np.array(background, dtype=np.float32)
        comp = arr_full.astype(np.float32) * alpha[..., None] + flat * (1.0 - alpha[..., None])
        img = Image.fromarray(np.clip(comp, 0, 255).astype(np.uint8))

    x0, y0, x1, y1 = box
    w = x1 - x0
    h = y1 - y0
    fill_before = (w * h) / float(img.width * img.height)

    # Square the crop around the subject's centre so nothing is distorted.
    side = max(w, h)
    cx = (x0 + x1) / 2.0
    cy = (y0 + y1) / 2.0
    side = int(round(side * (1.0 + margin * 2)))
    left = int(round(cx - side / 2.0))
    top = int(round(cy - side / 2.0))

    # Paste onto a background canvas rather than clamping the crop, so a subject
    # near an edge stays centred instead of being shoved off to one side.
    canvas = Image.new("RGB", (side, side), background)
    canvas.paste(img.crop((left, top, left + side, top + side)), (0, 0))

    # Any region of the crop that fell outside the source is filled with the
    # source's own edge colour by PIL's crop, which is black. Repaint it.
    arr = np.asarray(canvas, dtype=np.uint8).copy()
    black = np.all(arr < 8, axis=2)
    if black.any():
        arr[black] = background
    canvas = Image.fromarray(arr)

    out = canvas.resize((size, size), Image.LANCZOS)
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    out.save(dst_path)

    return {
        "subjectBox": [x0, y0, x1, y1],
        "fillBefore": round(fill_before, 4),
        "fillAfter": round(min(1.0, (max(w, h) ** 2) / float(side * side)), 4),
        "aspect": round(w / float(h), 3) if h else 0.0,
    }


if __name__ == "__main__":
    import json
    import sys

    print(json.dumps(prepare(sys.argv[1], sys.argv[2]), indent=2))
