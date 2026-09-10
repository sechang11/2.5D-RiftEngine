"""
The castle-city kit, third pass: silhouettes the skyline is still short of.

Two passes in, the streets no longer repeat but the city still has only one of
most things. There is one cathedral and one keep, which is correct, and one
shape of tall house, one shape of tower and one kind of gate, which is not: a
skyline is read from its outlines, and the eye counts repeats in outlines long
before it counts them in colour.

So this pass is deliberately shape-led. Everything here differs from what is
already in the pack by its profile — a stepped roof, a round turret, a bridge
that carries houses — rather than by what it is for.

  python3 city3_catalog.py > catalog_city3.json
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


FLINT = M("stone_flint", "roof_pantile", 1.0, 0.09)
FLINT_PALE = M("stone_flint_pale", "roof_pantile_grey", 1.0, 0.09)
SLATEWALL = M("stone_slate_wall", "roof_moss", 1.0, 0.1)
PARGET = M("plaster_pargeting", "roof_clay", 1.0, 0.12)
YELLOW = M("brick_pale", "roof_pantile", 1.0, 0.11)
RED_TIMBER = M("plaster_cream", "roof_clay_dark", 1.0, 0.13)
BLUE_TIMBER = M("plaster_white", "roof_slate_blue", 1.0, 0.12)
GREEN_ROOF = M("stone_limestone", "roof_tile_green", 1.05, 0.06)
MOSSY = M("stone_mossy", "roof_moss", 1.0, 0.12)

HOUSES = [
    ("gable_dutch", "Dutch Gable", 7.0, YELLOW,
     "a narrow house with a shaped dutch gable of curves and scrolls facing the street, "
     "a hoist hook at the apex"),
    ("turret_house", "Turret House", 7.5, FLINT,
     "a house with a round stair turret rising above the roofline on one corner, a conical cap"),
    ("gatehouse_house", "Gate House", 6.5, PARGET,
     "a house built over a wide arched passage through its ground floor, rooms above the arch"),
    ("half_timber_tall", "Guild House", 8.5, RED_TIMBER,
     "a tall five-storey guild house, each floor jettied out further than the last, "
     "an ornate carved bracket under every overhang"),
    ("hipped_roof", "Hipped House", 5.4, BLUE_TIMBER,
     "a broad house with a hipped roof sloping on all four sides and a central chimney"),
    ("catslide", "Catslide House", 5.0, MOSSY,
     "a house whose rear roof sweeps almost to the ground in one long unbroken slope"),
    ("wing_house", "L-Plan House", 5.8, YELLOW,
     "a house in an L plan with two wings meeting at a right angle round a small yard"),
    ("gallery_house", "Gallery House", 6.4, RED_TIMBER,
     "a house with an open covered gallery along the whole first floor on carved posts"),
    ("stone_tower_home", "Peel Tower", 8.5, SLATEWALL,
     "a squat defensive stone peel tower with a battlemented top and a single small door"),
    ("shopfront_double", "Double Shop", 5.6, PARGET,
     "a wide house with two shuttered shop counters side by side and a painted sign between"),
    ("dormer_row", "Attic House", 6.2, FLINT_PALE,
     "a house with five small dormer windows in a row along a long steep tiled roof"),
    ("chimney_stack", "Hearth House", 6.0, FLINT,
     "a house dominated by an enormous external chimney stack climbing the whole gable end"),
    ("undercroft", "Undercroft House", 6.4, SLATEWALL,
     "a stone house on a vaulted undercroft, arched cellar openings at street level, "
     "living floors above"),
    ("penthouse", "Lean-To Row", 4.4, MOSSY,
     "a row of lean-to shacks built against a taller wall, each with its own low door"),
    ("bridge_house", "Bridge House", 6.0, RED_TIMBER,
     "a timber house built out over a stone bridge parapet on brackets, overhanging the water"),
    ("courtyard_gate", "Yard Gate", 4.0, PARGET,
     "a wide arched carriage gateway with a room above it and a tiled roof, a yard behind"),
    ("watchhouse", "Watch House", 5.0, FLINT,
     "a small square watch house with a bell turret and an open arcaded porch"),
    ("bakehouse", "Bake House", 4.4, YELLOW,
     "a low brick bake house with two domed ovens bulging from the side and a tall flue"),
    ("dyeworks", "Dye Works", 5.2, MOSSY,
     "a dyer's workshop with open vats steaming outside and lengths of coloured cloth on racks"),
    ("boat_builder", "Boat Yard", 4.6, M("wood_pale", "roof_shingle", 1.0, 0.12),
     "an open-sided boat shed with a half-built hull on stocks inside"),
]
for aid, name, h, mtl, prompt in HOUSES:
    spec(aid, "house", name, prompt, height=h, material=mtl, faces=5200, tags=["blocks"])

CIVIC = [
    ("basilica", "Basilica", 13.0, GREEN_ROOF,
     "a long basilica with a clerestory nave, aisle roofs stepping down either side, "
     "and a semicircular apse"),
    ("moot_hall", "Moot Hall", 8.5, PARGET,
     "a timber-framed moot hall raised on an open stone arcade, an external stair to the door"),
    ("theatre", "Playhouse", 9.0, M("wood_beam", "roof_thatch", 1.0, 0.08),
     "a round timber playhouse with three tiers of galleries and an open thatched ring"),
    ("hospice", "Hospice", 6.5, FLINT_PALE,
     "a long low hospice range with a covered walk along its front and dormers above"),
    ("clock_tower", "Clock Tower", 14.0, M("stone_limestone", "roof_copper", 1.0, 0.04),
     "a square clock tower with a painted clock face on each side and a copper cupola"),
    ("chapter_house", "Chapter House", 8.0, GREEN_ROOF,
     "an octagonal chapter house with tall windows on every face and a steep pointed roof"),
    ("arsenal", "Arsenal", 9.0, M("stone_ashlar_cold", "roof_lead", 1.05, 0.05),
     "a heavy vaulted arsenal with wide iron-bound doors and slit windows high up"),
    ("guild_tower", "Guild Tower", 12.0, YELLOW,
     "a tall narrow guild tower of brick with stepped setbacks and a small spire"),
]
for aid, name, h, mtl, prompt in CIVIC:
    spec(aid, "civic", name, prompt, height=h, material=mtl, faces=7500, tags=["blocks"])

FORT = [
    ("wall_curved", "Curved Wall", 5.0, M("stone_ashlar", "stone_ashlar", 1.0, 0.05),
     "a gently curving section of crenellated castle wall", [4.0, 5.0, 2.0]),
    ("tower_drum", "Drum Tower", 8.0, M("stone_ashlar_warm", "roof_lead", 1.0, 0.05),
     "a broad low drum tower with a flat leaded roof and a ring of crenellations", None),
    ("gate_double", "Twin Gate", 12.0, M("stone_ashlar", "roof_slate", 1.05, 0.04),
     "a gate flanked by two round drum towers with a portcullis between them and a walkway over",
     None),
    ("sally_port", "Sally Port", 5.0, M("stone_ashlar", "stone_ashlar", 1.0, 0.05),
     "a small low arched sally port cut through the base of a castle wall, iron gate ajar",
     [4.0, 5.0, 2.2]),
    ("wall_ruined_tower", "Broken Tower", 6.5, M("stone_rubble", "stone_rubble", 1.0, 0.1),
     "a collapsed round tower sheared open, floors and stairs exposed inside", None),
    ("chain_boom", "River Chain", 3.0, M("iron_rust", "wood_beam", 0.8, 0.07),
     "a heavy iron river chain on two stone posts with a winch drum", None),
]
for aid, name, h, mtl, prompt, fit in FORT:
    spec(aid, "fort", name, prompt, height=h, material=mtl, faces=5200, fit=fit, tags=["blocks"])

STREET = [
    ("shrine_pillar", "Plague Column", 5.5, 3200, M("stone_marble", scale=0.9, jitter=0.04),
     "an ornate baroque stone plague column with tiers of carved figures on a stepped base"),
    ("well_covered", "Covered Well", 3.0, 2600, M("stone_limestone", "roof_tile_green", 0.85, 0.06),
     "a well under a small tiled canopy on four carved stone pillars"),
    ("lamp_wall", "Wall Lantern", 1.4, 1400, M("iron_wrought", scale=0.7, jitter=0.05),
     "an iron wall bracket carrying a glazed lantern, mounted on a fragment of wall"),
    ("stall_covered", "Covered Stall", 3.0, 2600, M("wood_plank", "roof_shingle", 0.9, 0.14),
     "a permanent market stall with a shingled roof on posts and a shuttered counter"),
    ("cage_hanging", "Gibbet Cage", 3.6, 2000, M("iron_rust", "wood_beam", 0.7, 0.06),
     "an iron gibbet cage hanging from a timber arm on a post"),
    ("fountain_wall_large", "Conduit", 3.2, 3000, M("stone_limestone", scale=0.9, jitter=0.05),
     "a public water conduit, a carved stone housing with three spouts into a long trough"),
    ("steps_grand", "Grand Steps", 2.0, 2400, M("stone_limestone", "flagstone", 0.95, 0.06),
     "a wide flight of shallow ceremonial stone steps with low flanking walls"),
    ("tree_planter", "Market Tree", 4.5, 2600, M("wood_bark", "grass_meadow", 0.9, 0.13),
     "a spreading tree growing from a circular stone planter with a bench around it"),
]
for aid, name, h, f, mtl, prompt in STREET:
    spec(aid, "street", name, prompt, height=h, faces=f, material=mtl)


if __name__ == "__main__":
    print(json.dumps(A, indent=1))
