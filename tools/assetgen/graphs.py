"""
ComfyUI graph builders for the asset pipeline.

Two graphs, run in two separate phases so neither model is ever swapped out of
VRAM mid-batch:

  concept image   SDXL text-to-image, one clean object on white
  image to mesh   Hunyuan3D 2.1, single-view reconstruction to GLB

Keeping them apart matters more than it looks. Interleaving them would evict a
7 GB model from VRAM on every single asset, and the reload costs more than the
generation does.
"""

IMAGE_CKPT = "RealVisXL_V5.0_fp16.safetensors"
MESH_CKPT = "hunyuan_3d_v2.1.safetensors"

# What a single-view 3D reconstructor needs from its input image: one object,
# dead centre, no background, no cast shadow, no crop. Everything else is
# noise it will faithfully turn into geometry.
IMAGE_SUFFIX = (
    ", single isolated object, centred in frame, plain solid white background, "
    "even diffuse studio lighting, no cast shadow, full object visible, "
    "sharp clean silhouette, high detail, 3d game asset reference sheet"
)

IMAGE_NEGATIVE = (
    "background scenery, environment, floor, ground plane, cast shadow, multiple objects, "
    "duplicate, text, watermark, signature, logo, cropped, cut off, out of frame, "
    "blurry, motion blur, depth of field, bokeh, dark, low contrast, busy background, "
    # A pedestal or display stand is reconstructed as real geometry fused to
    # the model, and it is far cheaper to not ask for one than to cut it off.
    "pedestal, display stand, podium, plinth, base plate, platform, diorama base"
)


def concept_image(prompt, seed, width=1024, height=1024, steps=26, cfg=5.5, prefix="concept/asset"):
    """SDXL text-to-image tuned for reconstruction-friendly reference art."""
    return {
        "1": {
            "class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": IMAGE_CKPT},
        },
        "2": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["1", 1], "text": prompt + IMAGE_SUFFIX},
        },
        "3": {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["1", 1], "text": IMAGE_NEGATIVE},
        },
        "4": {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        },
        "5": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["2", 0],
                "negative": ["3", 0],
                "latent_image": ["4", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "denoise": 1.0,
            },
        },
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {
            "class_type": "SaveImage",
            "inputs": {"images": ["6", 0], "filename_prefix": prefix},
        },
    }


def concept_image_batch(items, width=1024, height=1024, steps=26, cfg=5.5):
    """
    Several concept images in one graph, sharing a single checkpoint loader.

    ComfyUI keeps a model resident for the duration of one prompt, so batching
    pays the load once instead of once per image. That is a modest win on an
    idle GPU and an enormous one on a shared card: when another workload cycles
    a 20 GB model in between, every single-image submission pays a forty-second
    reload, and the generation itself only takes four.

    `items` is a list of (id, prompt, seed).
    """
    graph = {
        "L": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": IMAGE_CKPT}},
        "N": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["L", 1], "text": IMAGE_NEGATIVE}},
    }
    for i, (aid, prompt, seed) in enumerate(items):
        graph["p%d" % i] = {
            "class_type": "CLIPTextEncode",
            "inputs": {"clip": ["L", 1], "text": prompt + IMAGE_SUFFIX},
        }
        graph["l%d" % i] = {
            "class_type": "EmptyLatentImage",
            "inputs": {"width": width, "height": height, "batch_size": 1},
        }
        graph["k%d" % i] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["L", 0],
                "positive": ["p%d" % i, 0],
                "negative": ["N", 0],
                "latent_image": ["l%d" % i, 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "dpmpp_2m",
                "scheduler": "karras",
                "denoise": 1.0,
            },
        }
        graph["d%d" % i] = {
            "class_type": "VAEDecode",
            "inputs": {"samples": ["k%d" % i, 0], "vae": ["L", 2]},
        }
        graph["s%d" % i] = {
            "class_type": "SaveImage",
            "inputs": {"images": ["d%d" % i, 0], "filename_prefix": "gamegen_concept/" + aid},
        }
    return graph


def image_to_mesh_batch(items, octree=256, steps=30, threshold=0.4, algorithm="surface net", resolution=3072, num_chunks=8000):
    """
    Several reconstructions in one graph, sharing one Hunyuan3D loader.

    `items` is a list of (id, image_filename, seed).
    """
    graph = {"L": {"class_type": "ImageOnlyCheckpointLoader", "inputs": {"ckpt_name": MESH_CKPT}}}
    for i, (aid, image_name, seed) in enumerate(items):
        graph["i%d" % i] = {"class_type": "LoadImage", "inputs": {"image": image_name}}
        graph["c%d" % i] = {
            "class_type": "CLIPVisionEncode",
            "inputs": {"clip_vision": ["L", 1], "image": ["i%d" % i, 0], "crop": "center"},
        }
        graph["g%d" % i] = {
            "class_type": "Hunyuan3Dv2Conditioning",
            "inputs": {"clip_vision_output": ["c%d" % i, 0]},
        }
        graph["e%d" % i] = {
            "class_type": "EmptyLatentHunyuan3Dv2",
            "inputs": {"resolution": resolution, "batch_size": 1},
        }
        graph["k%d" % i] = {
            "class_type": "KSampler",
            "inputs": {
                "model": ["L", 0],
                "positive": ["g%d" % i, 0],
                "negative": ["g%d" % i, 1],
                "latent_image": ["e%d" % i, 0],
                "seed": seed,
                "steps": steps,
                "cfg": 5.5,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
            },
        }
        graph["v%d" % i] = {
            "class_type": "VAEDecodeHunyuan3D",
            "inputs": {
                "samples": ["k%d" % i, 0],
                "vae": ["L", 2],
                "num_chunks": num_chunks,
                "octree_resolution": octree,
            },
        }
        graph["m%d" % i] = {
            "class_type": "VoxelToMesh",
            "inputs": {"voxel": ["v%d" % i, 0], "algorithm": algorithm, "threshold": threshold},
        }
        graph["o%d" % i] = {
            "class_type": "SaveGLB",
            "inputs": {"mesh": ["m%d" % i, 0], "filename_prefix": "gamegen_raw/" + aid},
        }
    return graph


def image_to_mesh(
    image_filename,
    seed,
    prefix="mesh/asset",
    steps=32,
    cfg=5.5,
    resolution=3072,
    octree=256,
    num_chunks=8000,
    threshold=0.6,
):
    """
    Hunyuan3D 2.1 single-view reconstruction.

    `resolution` is the size of the shape latent, `octree` the resolution the
    voxel field is decoded at. Octree dominates both the runtime and how much
    fine detail survives; 256 is the useful floor for props at game scale.
    """
    return {
        "1": {
            "class_type": "ImageOnlyCheckpointLoader",
            "inputs": {"ckpt_name": MESH_CKPT},
        },
        "2": {"class_type": "LoadImage", "inputs": {"image": image_filename}},
        "3": {
            "class_type": "CLIPVisionEncode",
            "inputs": {"clip_vision": ["1", 1], "image": ["2", 0], "crop": "center"},
        },
        "4": {
            "class_type": "Hunyuan3Dv2Conditioning",
            "inputs": {"clip_vision_output": ["3", 0]},
        },
        "5": {
            "class_type": "EmptyLatentHunyuan3Dv2",
            "inputs": {"resolution": resolution, "batch_size": 1},
        },
        "6": {
            "class_type": "KSampler",
            "inputs": {
                "model": ["1", 0],
                "positive": ["4", 0],
                "negative": ["4", 1],
                "latent_image": ["5", 0],
                "seed": seed,
                "steps": steps,
                "cfg": cfg,
                "sampler_name": "euler",
                "scheduler": "normal",
                "denoise": 1.0,
            },
        },
        "7": {
            "class_type": "VAEDecodeHunyuan3D",
            "inputs": {
                "samples": ["6", 0],
                "vae": ["1", 2],
                "num_chunks": num_chunks,
                "octree_resolution": octree,
            },
        },
        "8": {
            "class_type": "VoxelToMeshBasic",
            "inputs": {"voxel": ["7", 0], "threshold": threshold},
        },
        "9": {
            "class_type": "SaveGLB",
            "inputs": {"mesh": ["8", 0], "filename_prefix": prefix},
        },
    }
