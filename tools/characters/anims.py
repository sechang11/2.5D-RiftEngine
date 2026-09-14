"""
Cuts the Universal Animation Library down to what the engine plays.

The library is one GLB: a mannequin, its skin, and forty-three clips, each
keying all sixty-five bones in translation, rotation and scale. For any body
other than the mannequin's, two thirds of that is not just waste but damage.
A bone's translation is its offset from its parent, which is to say the length
of the bone above it, and every clip carries the mannequin's lengths as
constant keys. Played on a body with a longer neck and shorter forearms, those
keys pull the skeleton into the mannequin's proportions and the skin creases
at every joint.

So rotation survives, and translation only on the pelvis, where it is motion
rather than proportion: the bob of a stride, the drop of a crouch. That one
still carries the mannequin's hip height, so the engine rescales it at load
time by the ratio of the two, reading this rig's from `asset.extras.hipHeight`.

The mesh, skin and materials go too. What is left is the bone hierarchy the
clips address by name, and the clips.

  python tools/characters/anims.py <UAL1_Standard.glb> public/assets/characters/anims.glb

Use the library's plain file, not the `_RM` one. Root motion walks the root
forward through the clip, and here the simulation moves the unit.
"""

import argparse
import json
import os
import struct

import numpy as np

GLB_MAGIC = 0x46546C67
CHUNK_JSON = 0x4E4F534A
CHUNK_BIN = 0x004E4942
FLOAT = 5126
COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}

#: What the engine plays. Everything else stays in the library.
CLIPS = [
    "Idle_Loop",
    "Idle_Talking_Loop",
    "Walk_Loop",
    "Jog_Fwd_Loop",
    "Sprint_Loop",
    "Sword_Idle",
    "Sword_Attack",
    "Punch_Jab",
    "Punch_Cross",
    "Spell_Simple_Enter",
    "Spell_Simple_Shoot",
    "Spell_Simple_Exit",
    "Spell_Simple_Idle_Loop",
    "Hit_Chest",
    "Hit_Head",
    "Death01",
    "Roll",
    "Interact",
    "PickUp_Table",
    "Dance_Loop",
]

#: Bones whose translation is motion rather than proportion.
MOVING_BONES = {"pelvis"}

#: A track that never moves further than this is stored as its two end keys.
STILL = 1e-5


def read_glb(path):
    with open(path, "rb") as f:
        data = f.read()
    magic, _version, length = struct.unpack_from("<III", data, 0)
    if magic != GLB_MAGIC:
        raise SystemExit("%s is not a GLB" % path)
    doc, binary, offset = None, b"", 12
    while offset < length:
        size, kind = struct.unpack_from("<II", data, offset)
        chunk = data[offset + 8 : offset + 8 + size]
        if kind == CHUNK_JSON:
            doc = json.loads(chunk)
        elif kind == CHUNK_BIN:
            binary = chunk
        offset += 8 + size
    return doc, binary


def write_glb(path, doc, binary):
    text = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    text += b" " * (-len(text) % 4)
    binary = bytes(binary) + b"\0" * (-len(binary) % 4)
    total = 12 + 8 + len(text) + 8 + len(binary)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", GLB_MAGIC, 2, total))
        f.write(struct.pack("<II", len(text), CHUNK_JSON))
        f.write(text)
        f.write(struct.pack("<II", len(binary), CHUNK_BIN))
        f.write(binary)


def read_accessor(doc, binary, index):
    acc = doc["accessors"][index]
    if acc["componentType"] != FLOAT:
        raise SystemExit("accessor %d is not float" % index)
    width = COMPONENTS[acc["type"]]
    view = doc["bufferViews"][acc["bufferView"]]
    if view.get("byteStride", 4 * width) != 4 * width:
        raise SystemExit("accessor %d is interleaved" % index)
    start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
    return np.frombuffer(binary, np.float32, acc["count"] * width, start).reshape(-1, width)


class Writer:
    """Appends float arrays to a fresh buffer, one view and accessor each."""

    def __init__(self):
        self.binary = bytearray()
        self.views = []
        self.accessors = []

    def put(self, array, kind, bounds=False):
        array = np.ascontiguousarray(array, dtype=np.float32)
        self.binary.extend(b"\0" * (-len(self.binary) % 4))
        self.views.append({"buffer": 0, "byteOffset": len(self.binary), "byteLength": array.nbytes})
        self.binary.extend(array.tobytes())
        acc = {"bufferView": len(self.views) - 1, "componentType": FLOAT, "count": len(array), "type": kind}
        if bounds:
            # Required on sampler inputs, which is where they are used.
            acc["min"] = array.min(axis=0).tolist()
            acc["max"] = array.max(axis=0).tolist()
        self.accessors.append(acc)
        return len(self.accessors) - 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", help="UAL1_Standard.glb from the library")
    ap.add_argument("dest", help="where to write the cut-down GLB")
    args = ap.parse_args()

    doc, binary = read_glb(args.source)
    names = [n.get("name", "") for n in doc["nodes"]]
    clips = {c["name"]: c for c in doc["animations"]}
    missing = [c for c in CLIPS if c not in clips]
    if missing:
        raise SystemExit("not in the library: %s" % ", ".join(missing))

    pelvis = doc["nodes"][names.index("pelvis")]
    # The pelvis sits under a root turned a quarter about X, so its Z is up.
    hip_height = float(pelvis["translation"][2])

    out = Writer()
    # Channels in one clip share their key times; so should the copies.
    times_cache = {}
    kept = dropped = 0
    animations = []
    for name in CLIPS:
        clip = clips[name]
        samplers, channels = [], []
        for channel in clip["channels"]:
            target = channel["target"]
            bone, path = names[target["node"]], target["path"]
            if path == "scale" or bone == "root" or (path == "translation" and bone not in MOVING_BONES):
                dropped += 1
                continue
            sampler = clip["samplers"][channel["sampler"]]
            if sampler.get("interpolation", "LINEAR") == "CUBICSPLINE":
                raise SystemExit("%s uses cubic keys, which this does not thin" % name)
            times = read_accessor(doc, binary, sampler["input"])
            values = read_accessor(doc, binary, sampler["output"])
            still = len(values) > 2 and float(np.ptp(values, axis=0).max()) < STILL
            if still:
                values = values[[0, -1]]
            key = (sampler["input"], still)
            if key not in times_cache:
                times_cache[key] = out.put(times[[0, -1]] if still else times, "SCALAR", bounds=True)
            samplers.append({
                "input": times_cache[key],
                "output": out.put(values, "VEC4" if path == "rotation" else "VEC3"),
                "interpolation": sampler.get("interpolation", "LINEAR"),
            })
            channels.append({"sampler": len(samplers) - 1, "target": {"node": target["node"], "path": path}})
            kept += 1
        animations.append({"name": name, "samplers": samplers, "channels": channels})

    nodes = [{k: v for k, v in n.items() if k not in ("mesh", "skin")} for n in doc["nodes"]]
    out.binary.extend(b"\0" * (-len(out.binary) % 4))
    result = {
        "asset": {
            "version": "2.0",
            "generator": "rift-engine tools/characters/anims.py",
            "copyright": "Universal Animation Library by Quaternius, CC0 1.0",
            "extras": {"hipHeight": hip_height},
        },
        "scene": doc.get("scene", 0),
        "scenes": doc["scenes"],
        "nodes": nodes,
        "animations": animations,
        "accessors": out.accessors,
        "bufferViews": out.views,
        "buffers": [{"byteLength": len(out.binary)}],
    }
    os.makedirs(os.path.dirname(os.path.abspath(args.dest)), exist_ok=True)
    write_glb(args.dest, result, out.binary)
    print("%d clips, %d channels kept, %d dropped, hip height %.4f, %.2f MB -> %.2f MB" % (
        len(animations), kept, dropped, hip_height,
        os.path.getsize(args.source) / 1e6, os.path.getsize(args.dest) / 1e6))


if __name__ == "__main__":
    main()
