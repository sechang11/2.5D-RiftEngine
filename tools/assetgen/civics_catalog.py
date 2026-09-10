"""
What a city needs that a kit of houses does not: water, work and a throne.

The first four passes built things a city is made of. Walking the result showed
what it was missing was not more buildings but the *reasons* for them — where
the water comes from, where the grain is ground and stored, where the king sits,
and what the road out is actually going to.

So this pass is infrastructure and civic set-dressing: an aqueduct and the
conduit it feeds, irrigation for the fields it waters, a quarry the walls came
out of, and a throne with the hall furniture to put around it.

  python3 civics_catalog.py > catalog_civics.json
"""

import json

import city_catalog as base

STYLE = base.STYLE
M = base.M
A = []


def spec(aid, category, name, prompt, height=None, faces=None, material=None,
         tags=(), fit=None, octree=None):
    dh, df, du = base.DEFAULTS[category]
    entry = {
        "id": "%s_%s" % (category, aid),
        "name": name,
        "category": category,
        "tags": list(tags),
        "height": height if height is not None else dh,
        "faces": faces if faces is not None else df,
        "upright": du,
        "prompt": prompt + ", " + STYLE,
        "material": material or M("stone_rubble", scale=1.0, jitter=0.1),
    }
    if fit:
        entry["fit"] = fit
    if octree:
        entry["octree"] = octree
    A.append(entry)
    return entry


STONE = M("stone_limestone", "flagstone", 1.0, 0.05)
ASHLAR = M("stone_ashlar_warm", "flagstone", 1.0, 0.05)
MARBLE = M("stone_marble", "gold", 0.9, 0.03)
EARTH = M("dirt_grey", "grass_meadow", 1.0, 0.1)
TIMBER = M("wood_beam", "roof_shingle", 0.95, 0.1)

# --- water: where it comes from and where it goes --------------------------

spec("aqueduct_tall", "civic", "Aqueduct",
     "a monumental two-tier stone aqueduct, tall round arches below and smaller arches above "
     "carrying a covered water channel across the sky",
     height=14.0, faces=6000, material=ASHLAR, fit=[16.0, 14.0, 3.2],
     tags=["kit", "blocks"])
spec("aqueduct_low", "civic", "Aqueduct Span",
     "a single-tier stone aqueduct arcade of round arches carrying an open water channel",
     height=7.0, faces=4500, material=ASHLAR, fit=[16.0, 7.0, 3.0], tags=["kit", "blocks"])
spec("conduit_house", "civic", "Conduit House",
     "a small ornate stone water house with a domed roof, carved spouts on every face "
     "pouring into a ring basin",
     height=6.0, faces=5000, material=M("stone_limestone", "roof_lead", 1.0, 0.05))
spec("cistern", "civic", "Cistern",
     "a low vaulted stone cistern half sunk into the ground, an iron grille over the mouth "
     "and steps down one side",
     height=3.0, faces=4000, material=STONE)
spec("water_channel", "street", "Water Channel",
     "a straight open stone irrigation channel running with clear water, cut kerbs either side",
     height=0.7, faces=1400, material=M("stone_limestone", "flagstone", 0.8, 0.06),
     fit=[6.0, 0.7, 1.6], tags=["kit"])
spec("sluice_gate", "street", "Sluice",
     "a small timber and iron sluice gate in a stone channel, the paddle raised on a screw",
     height=2.0, faces=2000, material=M("wood_beam", "iron_rust", 0.8, 0.07))
spec("irrigation_ditch", "rural", "Irrigation Ditch",
     "a straight earth irrigation ditch full of water between raised banks of turf",
     height=0.8, faces=1400, material=EARTH, fit=[8.0, 0.8, 2.4], tags=["kit"])
spec("windpump", "rural", "Wind Pump",
     "a small timber wind pump on a trestle with a four-bladed fan and a pipe down to a ditch",
     height=6.0, faces=3000, material=TIMBER)
spec("horse_trough_long", "street", "Long Trough",
     "a long carved stone watering trough fed by a small spout, worn smooth at the rim",
     height=1.0, faces=1400, material=STONE)

# --- the throne, and the hall around it ------------------------------------

spec("throne_stone", "street", "The Throne",
     "a great carved stone throne with a high back, lion arms and a gilded canopy above it",
     height=4.0, faces=4500, material=MARBLE, tags=["hero"], octree=320)
spec("dais_steps", "street", "Dais",
     "a broad three-step stone dais platform, wide and shallow, with a carpet runner up the middle",
     height=1.2, faces=2400, material=M("stone_marble", "cloth_banner", 0.9, 0.04),
     fit=[9.0, 1.2, 7.0])
spec("hall_column", "street", "Hall Column",
     "a single tall carved stone column with a foliate capital on a square plinth",
     height=8.0, faces=2600, material=MARBLE)
spec("carpet_runner", "street", "Carpet",
     "a long red woven carpet runner with a gold border, laid flat",
     height=0.15, faces=900, material=M("cloth_banner", "cloth_banner", 1.0, 0.06),
     fit=[10.0, 0.15, 3.0], tags=["kit"])
spec("banner_wall", "street", "Hanging Banner",
     "a tall heraldic banner hanging flat against a wall from a horizontal pole",
     height=6.0, faces=1600, material=M("cloth_banner", "wood_beam", 0.9, 0.14))
spec("brazier_hall", "street", "Hall Brazier",
     "a tall ornate bronze brazier on a tripod with clawed feet, coals glowing",
     height=2.6, faces=2200, material=M("bronze", "iron_rust", 0.7, 0.05))
spec("high_table", "street", "High Table",
     "a long carved oak high table on a dais with two heavy chairs behind it",
     height=1.4, faces=2400, material=M("wood_beam", "cloth_banner", 0.8, 0.07))

# --- work: where the city's stone, grain and fuel come from ----------------

spec("quarry_face", "rural", "Quarry Face",
     "a cut limestone quarry face in stepped benches with tool marks and spoil at the base",
     height=9.0, faces=4000, material=M("stone_limestone", "gravel", 1.2, 0.08), tags=["blocks"])
spec("charcoal_burner", "rural", "Charcoal Clamp",
     "a smoking turf-covered charcoal burning clamp with a stacked wood pile beside it",
     height=2.6, faces=2600, material=M("dirt_grey", "wood_bark", 0.9, 0.1))
spec("sheep_pen", "rural", "Sheep Pen",
     "a hurdle-fenced sheep pen with a small open shelter in one corner",
     height=1.8, faces=2400, material=M("wood_bark", "roof_thatch", 0.9, 0.12))
spec("field_furrows", "rural", "Ploughed Field",
     "a ploughed field of straight earth furrows running in parallel ridges",
     height=0.5, faces=1600, material=EARTH, fit=[12.0, 0.5, 12.0], tags=["kit"])
spec("field_wheat", "rural", "Wheat Field",
     "a dense field of tall ripe golden wheat standing in rows",
     height=1.6, faces=2000, material=M("straw", "straw", 1.4, 0.09), fit=[12.0, 1.6, 12.0],
     tags=["kit"])
spec("granary_public", "civic", "Public Granary",
     "a long stone granary hall on an arcaded base with ventilation slits and a loading door",
     height=9.0, faces=6000, material=ASHLAR, tags=["blocks"])
spec("tithe_barn", "rural", "Tithe Barn",
     "an enormous stone tithe barn with buttresses and a vast steep slate roof, "
     "great doors at the centre",
     height=10.0, faces=6000, material=M("stone_rubble", "roof_slate", 1.05, 0.07), tags=["blocks"])
spec("weigh_house", "civic", "Weigh House",
     "a small open civic weigh house with a great balance beam under a tiled canopy",
     height=6.0, faces=5000, material=M("brick_pale", "roof_pantile", 1.0, 0.06))

# --- the road, and what stands beside it -----------------------------------

spec("road_shrine", "street", "Road Shrine",
     "a small roadside stone shrine with a peaked cap and a niche, worn steps in front",
     height=2.6, faces=2200, material=STONE)
spec("toll_post", "street", "Toll Post",
     "a striped timber toll barrier on a pivot beside a small stone booth",
     height=2.6, faces=2400, material=M("wood_beam", "roof_shingle", 0.85, 0.09))
spec("cart_ox", "street", "Ox Cart",
     "a heavy four-wheeled ox cart loaded with cut stone blocks, shafts resting on the ground",
     height=2.2, faces=2800, material=M("wood_plank", "stone_limestone", 0.85, 0.1))
spec("guild_sign", "street", "Trade Sign",
     "an ornate wrought iron bracket over the street carrying a painted trade sign board",
     height=3.4, faces=1800, material=M("iron_wrought", "wood_plank", 0.75, 0.12))


if __name__ == "__main__":
    print(json.dumps([a for a in A if a], indent=1))
