"""
The castle-city kit, second pass: variety where the first pass repeats.

Walking the generated city shows exactly what is missing, and it is not more
categories. It is more *shells*. Six house types over four hundred plots means
every street is the same street, and no amount of per-instance tinting fixes a
silhouette you have already seen forty times.

So this is almost entirely housing and the civic buildings that break a skyline,
chosen for distinct outlines rather than distinct functions: a stepped gable
reads differently from a hipped roof at two hundred units in a way that a
"bakery" and a "butcher" do not.

  python3 city2_catalog.py > catalog_city2.json
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


CREAM = M("plaster_cream", "roof_clay_dark", 1.0, 0.14)
PINK = M("plaster_pink", "roof_clay_pale", 1.0, 0.14)
BLUE = M("plaster_blue", "roof_slate_blue", 1.0, 0.12)
SAGE = M("plaster_sage", "roof_shingle", 1.0, 0.14)
GREY = M("plaster_grey", "roof_slate", 1.0, 0.12)
WHITE = M("plaster_white", "roof_clay", 1.0, 0.14)
BRICK = M("brick_red", "roof_clay_dark", 1.0, 0.1)
RUBBLE = M("stone_rubble", "roof_slate", 1.0, 0.11)
DARKSTONE = M("stone_rubble_dark", "roof_slate_blue", 1.0, 0.11)
ASHLAR = M("stone_ashlar_warm", "roof_lead", 1.05, 0.06)
LIMESTONE = M("stone_limestone", "roof_slate", 1.05, 0.06)
DAUB = M("daub", "roof_thatch_old", 1.0, 0.16)

HOUSES = [
    ("gable_step", "Stepped Gable", 7.2, BRICK,
     "a narrow townhouse with a tall crow-stepped brick gable facing the street, "
     "a hoist beam at the peak and shuttered windows"),
    ("gable_curved", "Bell Gable", 6.8, CREAM,
     "a townhouse with an ornate curved bell gable and a round window near the top"),
    ("arcade", "Arcade House", 6.4, LIMESTONE,
     "a townhouse standing on a stone arcade of five round arches, shops in the shadow beneath, "
     "two storeys of windows above"),
    ("oriel", "Oriel House", 6.2, SAGE,
     "a corner townhouse with a carved wooden oriel window projecting over the street corner"),
    ("tower_house", "Tower House", 9.5, DARKSTONE,
     "a narrow fortified stone tower house, four storeys, tiny windows, a battlemented parapet"),
    ("courtyard", "Courtyard House", 6.0, WHITE,
     "a house built around a small square courtyard, an arched carriage entrance through the front range"),
    ("overhang", "Alley Bridge", 6.6, PINK,
     "two half-timbered houses joined by an upper floor that bridges the alley between them, "
     "a dark passage underneath"),
    ("dormer", "Dormer House", 6.0, BLUE,
     "a house with a very steep tiled roof carrying three dormer windows and a tall chimney stack"),
    ("stair_outside", "Stair House", 6.2, RUBBLE,
     "a stone house with an external stone stair climbing to a first floor door, "
     "storage arches underneath"),
    ("leaning", "Propped House", 6.4, DAUB,
     "a badly leaning old house held up by heavy timber props braced against the ground"),
    ("workshop", "Workshop House", 5.0, GREY,
     "a house with a wide open-fronted workshop attached to one side under a lean-to roof"),
    ("balcony", "Balcony House", 6.0, CREAM,
     "a house with a long carved wooden balcony running the width of the first floor, "
     "plants and washing on it"),
    ("half_ruin", "Gutted House", 4.6, M("stone_rubble", "stone_rubble", 1.0, 0.12),
     "a half-collapsed house, one gable wall standing, the roof fallen in, rubble inside"),
    ("cellar", "Cellar House", 5.4, RUBBLE,
     "a house with stone steps leading down to a cellar door below street level, "
     "a barred window at ankle height"),
    ("narrow", "Slice House", 6.8, PINK,
     "an absurdly narrow single-bay house squeezed between its neighbours, one window per floor"),
    ("broad", "Long House", 4.6, WHITE,
     "a broad low house with a very long unbroken tiled roof and six evenly spaced windows"),
]
for aid, name, h, mtl, prompt in HOUSES:
    spec(aid, "house", name, prompt, height=h, material=mtl, faces=5200, tags=["blocks"])

CIVIC = [
    ("almshouse", "Almshouse", 6.0, LIMESTONE,
     "a low symmetrical almshouse range with a central arched gateway and rows of small chimneys"),
    ("hospital", "Hospital", 8.0, LIMESTONE,
     "a long stone hospital hall with a chapel apse at one end and tall lancet windows"),
    ("mint", "The Mint", 7.5, ASHLAR,
     "a squat heavily built stone mint with barred windows, an iron door and a strongroom tower"),
    ("university", "Scholars Hall", 10.0, LIMESTONE,
     "a collegiate hall with a crenellated gate tower, oriel windows and a cloistered range"),
    ("customs", "Customs House", 8.0, ASHLAR,
     "a customs house on the quay with a pillared porch, a weighing beam and a clock gable"),
    ("tiltyard", "Tilt Yard", 5.0, M("wood_beam", "cloth_banner", 0.95, 0.1),
     "a jousting tilt yard, timber viewing stands hung with heraldic cloth beside a fenced list"),
    ("granary_tower", "Granary Tower", 11.0, ASHLAR,
     "a tall stone granary tower with tiny ventilation slits and an external hoist at the top"),
    ("baths", "Bath House", 6.5, BRICK,
     "a domed brick bath house with steam vents, small round windows and a wide arched entrance"),
]
for aid, name, h, mtl, prompt in CIVIC:
    spec(aid, "civic", name, prompt, height=h, material=mtl, faces=7000, tags=["blocks"])

FORT = [
    ("gate_flank", "Gate Tower", 11.0, M("stone_ashlar", "roof_slate", 1.0, 0.05),
     "a single square gate flanking tower with an arched opening at its base and machicolations above",
     None),
    ("wall_walk", "Wall Walk", 5.0, M("stone_ashlar", "stone_ashlar", 1.0, 0.05),
     "a section of castle wall seen from inside, the parapet walk running along the top with a rail",
     [4.0, 5.0, 2.6]),
    ("tower_corner", "Corner Tower", 10.0, M("stone_ashlar_cold", "roof_shingle", 1.0, 0.05),
     "a square castle corner tower with a pyramid roof, arrow loops on two faces", None),
    ("beacon", "Signal Beacon", 6.5, M("wood_beam", "iron_rust", 0.9, 0.07),
     "a timber signal beacon platform with an iron fire basket on top and a ladder", None),
]
for aid, name, h, mtl, prompt, fit in FORT:
    spec(aid, "fort", name, prompt, height=h, material=mtl, faces=5000, fit=fit, tags=["blocks"])

STREET = [
    ("pump", "Water Pump", 2.0, 1800, M("iron_wrought", "stone_limestone", 0.7, 0.06),
     "a public water pump, an iron spout and handle over a stone trough"),
    ("pillory", "Pillory", 2.2, 1600, M("wood_beam", scale=0.8, jitter=0.08),
     "a wooden pillory post with a hinged head and hand board on a small platform"),
    ("dovecote", "Dovecote", 3.4, 2400, M("stone_rubble", "roof_shingle", 0.8, 0.08),
     "a round stone dovecote with tiers of nesting holes and a small conical roof"),
    ("shrine_corner", "Corner Shrine", 2.2, 2000, M("stone_limestone", "roof_clay", 0.8, 0.07),
     "a small painted shrine niche set into a street corner with a little tiled canopy and candles"),
    ("awning_row", "Shop Awnings", 2.8, 2200, M("wood_plank", "canvas_stripe", 0.85, 0.18),
     "a row of three striped cloth shop awnings on poles with goods on trestles under them"),
    ("drain", "Street Drain", 0.5, 1200, M("stone_dark", "iron_rust", 0.7, 0.07),
     "a stone gutter channel with an iron grate over a drain mouth"),
]
for aid, name, h, f, mtl, prompt in STREET:
    spec(aid, "street", name, prompt, height=h, faces=f, material=mtl)


if __name__ == "__main__":
    print(json.dumps(A, indent=1))
