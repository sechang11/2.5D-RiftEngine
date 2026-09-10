"""
Automated quality control for generated meshes.

Single-view reconstruction fails in two recognisable ways, and both are visible
in the bounding box alone:

  a paper-thin cutout   the model came back as a flat sheet with no depth
  a featureless blob    the model came back as a ball, losing the silhouette

Neither needs a human to spot, and neither is subtle: a sword whose bounding box
is a perfect cube is a sphere, and a staff two units tall and two centimetres
deep is a sticker.

The blob test needs to know what the asset was *meant* to look like, because a
cubic bounding box is correct for a boulder and wrong for a spear. The concept
image's own aspect ratio supplies that: it is recorded during the image phase,
and if the reference art was tall and narrow then the mesh should be too.

Failures are re-rolled with a different seed rather than discarded. These are
seed-dependent, so a second attempt usually succeeds, and keeping whichever
result scores better means a retry can never make a pack worse.
"""


def flatness(size):
    """Smallest bounding dimension over the largest. 1 is a cube, 0 is a plane."""
    mx = max(size)
    mn = min(size)
    return (mn / mx) if mx > 1e-6 else 0.0


def elongation(size):
    """Largest dimension over the median. High means long and thin."""
    s = sorted(size)
    return (s[2] / s[1]) if s[1] > 1e-6 else 1.0


# Categories where a cubic result is a legitimate shape, so the blob test is
# skipped no matter what the reference art looked like.
BLOB_IS_FINE = {"nature", "prop", "building", "pickup"}

"""
Assets that are meant to be long and thin, matched on their id.

The concept image's aspect ratio turned out to be a poor guide here: reference
art of a longsword came back framed at 0.83, nearly square, because the
generator drew it large in frame with a wide crossguard. Naming the shapes that
must be elongated is less clever and considerably more reliable, and it lets an
orb and a tome stay round without a special case.
"""
SLENDER_IDS = (
    "sword",
    "blade",
    "rapier",
    "scimitar",
    "flamberge",
    "khopesh",
    "dagger",
    "katar",
    "spear",
    "halberd",
    "glaive",
    "trident",
    "scythe",
    "staff",
    "wand",
    "bow",
    "crossbow",
    "axe",
    "hammer",
    "mace",
    "maul",
    "morningstar",
    "club",
    "whip",
)


def is_slender(asset_id):
    return any(k in asset_id for k in SLENDER_IDS)

# Blob threshold for those categories, lower than the general one because the
# evidence is stronger.
NEVER_BLOB_FLATNESS = 0.78

# Below this, the mesh has essentially no depth in some axis.
MIN_FLATNESS = 0.025

"""
Scenery gets a stricter floor than the general one.

A weapon may legitimately be a thin blade and a shield a thin disc, but a tree
or a boulder that comes back at a quarter depth is a cardboard cutout. It
passes the general test, and then reads as a flat green diamond lying in the
grass the moment it is placed on a map. Since scenery is the overwhelming
majority of what gets placed, it is worth holding to a higher bar.
"""
SCENERY_MIN_FLATNESS = 0.30
SCENERY = {"nature", "prop", "building"}

# Things that really are flat, whatever their category says.
GENUINELY_FLAT = (
    "lilypad",
    "gate",
    "banner",
    "fence",
    "flowers",
    "vines",
    "wheel",
    "rack",
    "sand",
    "snow",
    # Objects whose real shape is a slab or a panel: a bedroll is a mat, a
    # bookshelf and a wall torch both stand flat against a wall, a tombstone is
    # a stone slab, and an obelisk is a narrow square column.
    "bedroll",
    "bookshelf",
    "torch",
    "tombstone",
    "obelisk",
)

# Above this, the mesh is effectively a ball.
MAX_FLATNESS = 0.82

# Reference art narrower than this was of a long thin object.
SLENDER_ASPECT = 0.62


def inspect(entry):
    """
    Returns (ok, reason). `entry` is one asset's manifest record.
    """
    info = entry.get("meshInfo")
    if not info:
        return False, "no mesh"

    size = info.get("size") or [1, 1, 1]
    f = flatness(size)
    category = entry.get("category", "prop")
    aspect = (entry.get("conceptInfo") or {}).get("aspect", 1.0)

    aid = entry.get("id", "")
    if f < MIN_FLATNESS:
        return False, "paper thin (flatness %.3f)" % f

    if (
        category in SCENERY
        and f < SCENERY_MIN_FLATNESS
        and not any(k in aid for k in GENUINELY_FLAT)
    ):
        return False, "cardboard (flatness %.2f, scenery needs %.2f)" % (f, SCENERY_MIN_FLATNESS)

    if is_slender(entry.get("id", "")) and f > NEVER_BLOB_FLATNESS:
        return False, "blob (flatness %.2f, should be elongated)" % f

    if category not in BLOB_IS_FINE and f > MAX_FLATNESS:
        # Elsewhere it is only a failure if the source art was clearly not a
        # blob: a slime legitimately reconstructs as a ball.
        if aspect < SLENDER_ASPECT or aspect > (1.0 / SLENDER_ASPECT):
            return False, "blob (flatness %.2f, art aspect %.2f)" % (f, aspect)

    if info.get("triangles", 0) < 200:
        return False, "almost no geometry (%d tris)" % info.get("triangles", 0)

    return True, "ok"


def score(entry):
    """
    How good a result is, higher is better. Used to decide whether a retry
    beat the original.
    """
    info = entry.get("meshInfo") or {}
    size = info.get("size") or [1, 1, 1]
    f = flatness(size)
    category = entry.get("category", "prop")
    aspect = (entry.get("conceptInfo") or {}).get("aspect", 1.0)

    # Distance from whichever failure mode this asset is at risk of.
    s = 0.0
    s += min(f / MIN_FLATNESS, 4.0)
    if is_slender(entry.get("id", "")):
        s += max(0.0, (NEVER_BLOB_FLATNESS - f)) * 8.0
    elif category not in BLOB_IS_FINE and (aspect < SLENDER_ASPECT or aspect > 1 / SLENDER_ASPECT):
        s += max(0.0, (MAX_FLATNESS - f)) * 6.0
    else:
        s += 1.0

    # Prefer a silhouette that matches the reference art's proportions. The
    # concept image is a front view, so its aspect should roughly match the
    # mesh's width over height.
    if size[1] > 1e-6:
        mesh_aspect = size[0] / size[1]
        s += max(0.0, 1.5 - abs(mesh_aspect - aspect)) * 2.0

    return s


def audit(manifest):
    """Splits a manifest into passing and failing assets."""
    good, bad = [], []
    for aid, entry in manifest.get("assets", {}).items():
        if not entry.get("mesh"):
            continue
        ok, reason = inspect(entry)
        (good if ok else bad).append((aid, reason, round(score(entry), 3)))
    good.sort()
    bad.sort()
    return good, bad


if __name__ == "__main__":
    import json
    import os
    import sys

    path = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/gamegen/out/manifest.json")
    with open(path) as f:
        manifest = json.load(f)
    good, bad = audit(manifest)
    print("pass: %d   fail: %d" % (len(good), len(bad)))
    for aid, reason, sc in bad:
        print("  %-32s %-42s score %.2f" % (aid, reason, sc))
