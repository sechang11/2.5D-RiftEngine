"""
The castle-city catalog: a modular kit, not a diorama.

A grand medieval city cannot be one model. It is a curtain wall repeated forty
times, a gatehouse, six house shells reused at different rotations, and two
hundred small things in the street. So every entry here is a *piece*, sized so
it butts against its neighbours, and the city map assembles them.

Three fields carry the weight:

  height     world units, where a champion is 2.2 tall. A cottage is 3.5, a
             curtain wall 5, a keep 16. Getting this right in the catalog is
             what stops a tower from being barrel-sized on the map.
  fit        an exact [w, h, d] box for kit pieces. A wall section that is
             3.9 units long leaves a gap every time it repeats; wall sections
             are scaled non-uniformly to exactly 4.
  material   which tiling surfaces the engine projects onto the mesh, and how
             much each instance may drift from them. `side` covers the walls,
             `top` the roof, and the split is by surface angle.

Sizes are deliberate rather than generated: the reconstructor decides shape,
this file decides scale, and separating the two is what makes the kit snap.

  python3 city_catalog.py > catalog_city.json
"""

import json

STYLE = (
    "stylized medieval fantasy game asset, three-quarter aerial view from above, "
    "bold readable architecture, crisp carved detail, clean silhouette, "
    "muted natural colours, painted game concept art"
)

# category -> (height, faces, upright)
DEFAULTS = {
    "fort": (8.0, 6000, "none"),
    "house": (5.5, 5000, "none"),
    "civic": (9.0, 7000, "none"),
    "street": (1.6, 1800, "none"),
    "rural": (3.5, 3000, "none"),
    "dock": (2.5, 2500, "none"),
    "nature": (3.0, 2200, "none"),
}


def M(side, top=None, scale=1.0, jitter=0.0, tint=None):
    """
    A material assignment.

    `scale` multiplies the material's own world-units-per-tile, so one stone can
    read as fine ashlar on a chapel and as cyclopean blocks on a keep. `jitter`
    is how far individual instances may drift in brightness and hue, which is
    the difference between a street of houses and a street of one house.
    """
    return {"side": side, "top": top or side, "scale": scale, "jitter": jitter, "tint": tint}


A = []


def spec(aid, category, name, prompt, height=None, faces=None, upright=None,
         fit=None, material=None, tags=(), octree=None):
    dh, df, du = DEFAULTS[category]
    entry = {
        "id": "%s_%s" % (category, aid),
        "name": name,
        "category": category,
        "tags": list(tags),
        "height": height if height is not None else dh,
        "faces": faces if faces is not None else df,
        "upright": upright if upright is not None else du,
        "prompt": prompt + ", " + STYLE,
        "material": material or M("stone_rubble", scale=1.0, jitter=0.06),
    }
    if fit:
        entry["fit"] = fit
    if octree:
        entry["octree"] = octree
    A.append(entry)
    return entry


# ---------------------------------------------------------------------------
# Fortification: the modular curtain wall and everything that interrupts it
#
# The wall pieces all fit an exact box because they repeat. Everything that
# interrupts the wall — gates, towers — matches its 5-unit height so the
# parapet line runs unbroken across the whole city.
# ---------------------------------------------------------------------------

WALL_MAT = M("stone_ashlar", "stone_ashlar", scale=1.0, jitter=0.05)
KEEP_MAT = M("stone_ashlar", "roof_slate", scale=1.15, jitter=0.04)

spec("wall_straight", "fort", "Curtain Wall",
     "a straight section of crenellated stone castle curtain wall with square merlons, "
     "an arrow slit, and a walkway on top",
     height=5.0, faces=3000, fit=[4.0, 5.0, 1.6], material=WALL_MAT, tags=["kit", "blocks"])
spec("wall_battered", "fort", "Battered Wall",
     "a section of thick castle wall with a sloped battered base, crenellations above, "
     "heavy masonry courses",
     height=5.0, faces=3000, fit=[4.0, 5.0, 2.0], material=WALL_MAT, tags=["kit", "blocks"])
spec("wall_corner", "fort", "Wall Corner",
     "a right-angled corner section of crenellated stone castle wall, two faces meeting",
     height=5.0, faces=3200, fit=[2.4, 5.0, 2.4], material=WALL_MAT, tags=["kit", "blocks"])
spec("wall_ruined", "fort", "Breached Wall",
     "a broken section of castle wall, collapsed in the middle, rubble spilling out, "
     "exposed masonry core",
     height=4.4, faces=3400, fit=[4.0, 4.4, 1.8], material=M("stone_rubble", scale=1.0, jitter=0.1),
     tags=["kit", "ruin"])
spec("wall_stair", "fort", "Rampart Stair",
     "a stone stair climbing the inner face of a castle wall to the parapet walk, with a handrail",
     height=5.0, faces=2600, fit=[3.0, 5.0, 3.0], material=WALL_MAT, tags=["kit"])
spec("wall_gate", "fort", "Wall Gate",
     "an arched gateway through a crenellated castle wall, iron portcullis half lowered, "
     "heavy voussoir stones",
     height=5.6, faces=4500, fit=[4.0, 5.6, 2.2], material=WALL_MAT, tags=["kit", "gate"])
spec("tower_round", "fort", "Round Wall Tower",
     "a round stone castle wall tower with a conical slate roof, arrow slits and a corbelled parapet",
     height=9.5, faces=5000, material=M("stone_ashlar", "roof_slate", 1.0, 0.05), tags=["blocks"])
spec("tower_square", "fort", "Square Tower",
     "a square stone watchtower with crenellations, a timber hoarding gallery near the top",
     height=9.0, faces=4800, material=WALL_MAT, tags=["blocks"])
spec("tower_bastion", "fort", "Bastion",
     "a squat wide artillery bastion of sloped stone with gun embrasures and a flat top",
     height=6.0, faces=4200, material=WALL_MAT, tags=["blocks"])
spec("tower_watch", "fort", "Watch Turret",
     "a slender stone lookout turret with a pointed roof and a small balcony",
     height=7.5, faces=3600, material=M("stone_ashlar", "roof_shingle", 1.0, 0.06))
spec("gatehouse_great", "fort", "Great Gatehouse",
     "a monumental twin-towered castle gatehouse, portcullis in a deep arch, machicolations above, "
     "banners hanging from the towers",
     height=13.0, faces=10000, material=M("stone_ashlar", "roof_slate", 1.1, 0.03),
     tags=["hero", "gate"], octree=320)
spec("gatehouse_small", "fort", "Postern Gate",
     "a small fortified postern gate with a single arch, a heavy studded door and a lamp bracket",
     height=6.5, faces=4000, material=WALL_MAT, tags=["gate"])
spec("barbican", "fort", "Barbican",
     "a forward barbican of stone flanking a bridge approach, arrow loops and a raised walkway",
     height=8.0, faces=6000, material=WALL_MAT)
spec("drawbridge", "fort", "Drawbridge",
     "a raised timber drawbridge on iron chains against a stone gate arch",
     height=6.0, faces=3500, material=M("wood_beam", "wood_beam", 1.0, 0.08))
spec("palisade", "fort", "Timber Palisade",
     "a section of pointed timber palisade fence lashed with rope, earth bank at the base",
     height=3.4, faces=2200, fit=[4.0, 3.4, 0.9], material=M("wood_beam", "wood_beam", 0.9, 0.1),
     tags=["kit", "blocks"])
spec("palisade_gate", "fort", "Palisade Gate",
     "a timber palisade gateway with two heavy posts and a crossbeam over an open gate",
     height=4.2, faces=2600, fit=[4.0, 4.2, 1.0], material=M("wood_beam", scale=0.9, jitter=0.1),
     tags=["kit"])
spec("wall_hoarding", "fort", "Timber Hoarding",
     "a timber fighting gallery bolted to the top of a stone wall, shuttered openings",
     height=5.8, faces=3000, fit=[4.0, 5.8, 2.4], material=M("wood_beam", "roof_shingle", 0.9, 0.08),
     tags=["kit"])
spec("moat_bridge", "fort", "Moat Bridge",
     "a low stone arch bridge crossing a castle moat, worn parapets",
     height=2.6, faces=3000, fit=[8.0, 2.6, 3.2], material=M("stone_rubble", scale=1.0, jitter=0.05))

# Siege engines: mobile, so no fit box.
spec("siege_trebuchet", "fort", "Trebuchet",
     "a huge timber counterweight trebuchet with a long throwing arm and a sling, ropes and winch",
     height=9.0, faces=6000, material=M("wood_beam", scale=0.9, jitter=0.08))
spec("siege_ram", "fort", "Battering Ram",
     "a covered battering ram, an iron-headed log slung under a hide-covered timber roof on wheels",
     height=3.6, faces=4000, material=M("wood_beam", "leather", 0.9, 0.08))
spec("siege_tower", "fort", "Siege Tower",
     "a tall wheeled timber siege tower with a hinged boarding ramp and hide facing",
     height=11.0, faces=6000, material=M("wood_beam", "leather", 0.9, 0.06))
spec("siege_mangonel", "fort", "Mangonel",
     "a torsion mangonel catapult with a bucket arm on a heavy timber frame",
     height=3.2, faces=3800, material=M("wood_beam", scale=0.9, jitter=0.08))
spec("siege_ballista", "fort", "Ballista",
     "a large mounted ballista with twisted skeins and a heavy bolt in the groove",
     height=2.6, faces=3200, material=M("wood_beam", "iron_wrought", 0.9, 0.06))
spec("siege_ladder", "fort", "Siege Ladder",
     "a long timber scaling ladder leaning at an angle with hooks at the top",
     height=6.0, faces=1400, material=M("wood_plank", scale=0.9, jitter=0.1))
spec("caltrop_barricade", "fort", "Barricade",
     "a street barricade of lashed timber, upturned carts and sharpened stakes",
     height=2.2, faces=2600, material=M("wood_plank", scale=0.9, jitter=0.12))


# ---------------------------------------------------------------------------
# The castle proper: hero pieces, generated at a higher octree because they
# carry the skyline and every player will look straight at them.
# ---------------------------------------------------------------------------

spec("keep_great", "civic", "Great Keep",
     "a massive square Norman castle keep, four corner turrets, narrow windows, "
     "a forebuilding stair, banners on the roofline",
     height=17.0, faces=12000, material=KEEP_MAT, tags=["hero"], octree=320)
spec("keep_round", "civic", "Round Donjon",
     "a tall cylindrical castle donjon with a machicolated crown and a conical roof",
     height=16.0, faces=10000, material=M("stone_ashlar", "roof_slate", 1.1, 0.03),
     tags=["hero"], octree=320)
spec("palace_wing", "civic", "Palace Wing",
     "an ornate royal palace wing with tall mullioned windows, carved cornices and a steep leaded roof",
     height=12.0, faces=10000, material=M("stone_limestone", "roof_lead", 1.1, 0.04),
     tags=["hero"], octree=320)
spec("great_hall", "civic", "Great Hall",
     "a long stone great hall with buttresses, a high timber roof, a louvred smoke vent and a rose window",
     height=11.0, faces=9000, material=M("stone_limestone", "roof_slate", 1.1, 0.04), tags=["hero"])
spec("cathedral", "civic", "Cathedral",
     "a gothic cathedral with twin spires, flying buttresses, a great rose window and a deep arched portal",
     height=22.0, faces=14000, material=M("stone_limestone", "roof_lead", 1.2, 0.02),
     tags=["hero"], octree=320)
spec("chapel", "civic", "Stone Chapel",
     "a small stone chapel with a bellcote, lancet windows and a steep slate roof",
     height=6.5, faces=5000, material=M("stone_limestone", "roof_slate", 1.0, 0.05))
spec("abbey", "civic", "Abbey",
     "a monastic abbey range with a cloister arcade, a squat crossing tower and lead roofs",
     height=10.0, faces=9000, material=M("stone_limestone", "roof_lead", 1.1, 0.04))
spec("bell_tower", "civic", "Bell Tower",
     "a tall square stone campanile with open belfry arches, a great bronze bell visible",
     height=15.0, faces=6000, material=M("stone_limestone", "roof_copper", 1.0, 0.04))
spec("wizard_tower", "civic", "Wizard Tower",
     "a tall crooked wizard tower of dark stone leaning slightly, banded with buttresses, "
     "a glowing arched window near the top and a witch-hat roof",
     height=18.0, faces=9000, material=M("stone_dark", "roof_slate", 1.0, 0.05),
     tags=["hero"], octree=320)
spec("mage_spire", "civic", "Arcane Spire",
     "a slender arcane spire of pale stone wound with a spiral outer stair, floating rings near the crown",
     height=19.0, faces=8000, material=M("stone_marble", "roof_copper", 1.0, 0.03), tags=["hero"])
spec("observatory", "civic", "Observatory",
     "a stone observatory tower with a domed copper roof and a shuttered opening for a telescope",
     height=13.0, faces=7000, material=M("stone_limestone", "roof_copper", 1.0, 0.04))
spec("temple_round", "civic", "Round Temple",
     "a circular colonnaded stone temple with a shallow dome and a stepped base",
     height=9.0, faces=7000, material=M("stone_marble", "roof_copper", 1.1, 0.03))
spec("guildhall", "civic", "Guildhall",
     "an imposing guildhall with a stepped gable front, an arcaded ground floor and a clock",
     height=10.0, faces=8000, material=M("stone_limestone", "roof_clay", 1.0, 0.05))
spec("courthouse", "civic", "Court House",
     "a civic hall with a pillared porch, a stone balcony and a slate hipped roof",
     height=8.5, faces=7000, material=M("stone_limestone", "roof_slate", 1.0, 0.05))
spec("treasury", "civic", "Counting House",
     "a narrow fortified counting house of stone with barred windows and an iron-bound door",
     height=7.0, faces=5500, material=M("stone_ashlar", "roof_slate", 0.9, 0.05))
spec("library", "civic", "Great Library",
     "a stone library hall with tall arched windows, buttresses and a shallow lead roof",
     height=9.5, faces=8000, material=M("stone_sandstone", "roof_lead", 1.1, 0.04))
spec("barracks", "civic", "Barracks",
     "a long two-storey stone barracks with rows of shuttered windows and a weapon rack outside",
     height=7.0, faces=6000, material=M("stone_rubble", "roof_clay", 1.0, 0.06))
spec("prison", "civic", "Gaol",
     "a grim squat stone gaol with tiny barred windows and a heavy studded door",
     height=6.0, faces=5000, material=M("stone_dark", "roof_slate", 1.0, 0.05))


# ---------------------------------------------------------------------------
# Housing: the mass of the city. These get generous jitter, because a street is
# made of the same six shells and the eye must not notice.
# ---------------------------------------------------------------------------

TIMBER = M("plaster_white", "roof_clay", 1.0, 0.16)
TIMBER_DARK = M("daub", "roof_thatch", 1.0, 0.18)
STONE_HOUSE = M("stone_rubble", "roof_slate", 1.0, 0.12)

HOUSES = [
    ("timber_a", "Timber House", 5.6, TIMBER,
     "a two-storey half-timbered medieval townhouse, dark oak framing over white plaster, "
     "a jettied upper floor overhanging the street, small leaded windows, a red tile roof"),
    ("timber_b", "Crooked House", 6.4, TIMBER,
     "a leaning three-storey half-timbered house, each floor jettied further out, "
     "a crooked chimney, shuttered windows"),
    ("timber_c", "Corner House", 5.8, TIMBER,
     "a half-timbered corner townhouse with two street faces meeting at a rounded corner post"),
    ("timber_tall", "Merchant House", 8.0, TIMBER,
     "a tall narrow four-storey merchant house with a steep stepped gable facing the street, "
     "a hoist beam at the top and a wide shop door below"),
    ("stone_a", "Stone House", 5.4, STONE_HOUSE,
     "a squat two-storey house of rough grey fieldstone with a slate roof and a stone chimney"),
    ("stone_b", "Burgher House", 6.6, STONE_HOUSE,
     "a solid three-storey stone burgher house with dressed quoins, mullioned windows and a slate roof"),
    ("cottage_a", "Thatched Cottage", 3.6, TIMBER_DARK,
     "a small single-storey cottage with wattle and daub walls and a deep golden thatched roof, "
     "a crooked chimney and a low door"),
    ("cottage_b", "Longhouse", 3.8, TIMBER_DARK,
     "a long low peasant longhouse under one thatched roof, half of it a byre, a stone base course"),
    ("hovel", "Hovel", 2.8, TIMBER_DARK,
     "a poor lean-to hovel of scrap timber and turf with a sagging thatch roof and a sacking door"),
    ("row_a", "Terrace Row", 5.6, TIMBER,
     "a row of three joined narrow half-timbered houses sharing a continuous tiled roof, "
     "each front a different width"),
    ("row_b", "Stone Terrace", 6.0, STONE_HOUSE,
     "a terrace of four joined narrow stone houses with a shared slate roof and staggered chimneys"),
    ("manor", "Town Manor", 8.5, M("stone_limestone", "roof_slate", 1.0, 0.08),
     "a fine town manor house with a symmetrical front, tall chimneys, a porch and a walled forecourt"),
    ("tenement", "Tenement Block", 9.0, M("plaster_ochre", "roof_clay", 1.0, 0.14),
     "a tall crowded medieval tenement block, five floors of small shuttered windows, "
     "washing lines strung between them, an outside stair"),
    ("shop_front", "Shop House", 5.2, TIMBER,
     "a half-timbered shop house with an open shuttered counter onto the street and a "
     "painted trade sign hanging on an iron bracket"),
    ("bakery", "Bakery", 5.0, M("plaster_white", "roof_clay", 1.0, 0.1),
     "a baker's house with a domed brick oven bulging from the side wall, a smoking flue, "
     "and a bread sign over the door"),
    ("butcher", "Butcher", 5.0, TIMBER,
     "a butcher's shop with an open front counter, hanging hooks and a striped awning"),
    ("apothecary", "Apothecary", 5.4, TIMBER,
     "an apothecary shop with a bow window of small round panes, drying herbs hung under the eaves"),
    ("alchemist", "Alchemist", 6.2, M("stone_dark", "roof_shingle", 1.0, 0.1),
     "a cluttered alchemist's shop leaning over the street, copper pipes and a fuming chimney, "
     "green glass bottles in the window"),
    ("tavern", "Tavern", 7.0, TIMBER,
     "a big half-timbered tavern with a wide door, benches outside, a swinging painted sign "
     "and lamplit windows"),
    ("inn", "Coaching Inn", 8.0, TIMBER,
     "a two-winged coaching inn around an arched carriage entrance, galleried upper floors, "
     "a stable yard behind"),
    ("smithy", "Blacksmith", 4.6, M("stone_rubble", "roof_shingle", 1.0, 0.1),
     "a blacksmith's forge, half open to the street, a stone chimney, an anvil and a "
     "water trough under the eaves"),
    ("tannery", "Tannery", 5.0, M("wood_plank", "roof_shingle", 1.0, 0.12),
     "a tannery with open drying frames of stretched hides and sunken vats beside it"),
    ("weaver", "Weaver's House", 5.6, TIMBER,
     "a weaver's house with a long band of windows on the upper floor to light the looms"),
    ("potter", "Pottery", 4.4, M("brick_red", "roof_clay", 1.0, 0.1),
     "a potter's workshop with a beehive brick kiln beside it and stacked drying pots"),
    ("stable_town", "Town Stable", 4.2, M("wood_plank", "roof_thatch", 1.0, 0.12),
     "a timber stable block with a row of half doors and a hay loft above"),
    ("warehouse", "Warehouse", 7.5, M("wood_plank", "roof_shingle", 1.0, 0.1),
     "a tall plain timber warehouse with a loading door on every floor and an external hoist"),
    ("granary_town", "Granary", 6.5, M("wood_plank", "roof_thatch", 1.0, 0.1),
     "a raised timber granary standing on staddle stones with a steep thatched roof"),
    ("bathhouse", "Bath House", 5.0, M("brick_red", "roof_clay", 1.0, 0.08),
     "a low brick bath house with a steaming vent, small high windows and a wide arched door"),
    ("brewery", "Brewery", 6.0, M("stone_rubble", "roof_clay", 1.0, 0.1),
     "a brewery with a tall mash tun housing, barrels stacked outside and a steam vent"),
    ("ruin_house", "Burnt Shell", 4.4, M("stone_rubble", "stone_rubble", 1.0, 0.12),
     "the burnt-out shell of a house, charred timbers, a collapsed roof, empty window holes"),
]
for aid, name, h, mtl, prompt in HOUSES:
    spec(aid, "house", name, prompt, height=h, material=mtl, tags=["blocks"])


# ---------------------------------------------------------------------------
# Market and street furniture: the layer that makes a city look inhabited.
# Small, numerous, cheap. Most do not block movement.
# ---------------------------------------------------------------------------

STREET = [
    ("stall_awning", "Market Stall", 2.6, 2200, M("wood_plank", "canvas_stripe", 0.9, 0.2),
     "a market stall, a timber trestle counter under a striped canvas awning on four poles"),
    ("stall_fruit", "Fruit Stall", 2.4, 2400, M("wood_plank", "canvas_stripe", 0.9, 0.18),
     "a market stall heaped with baskets of apples and cabbages under a sagging awning"),
    ("stall_fish", "Fish Stall", 2.4, 2400, M("wood_plank", "canvas_stripe", 0.9, 0.18),
     "a fishmonger's stall with fish laid on a slab and nets hung behind"),
    ("stall_cloth", "Cloth Stall", 2.6, 2400, M("wood_plank", "cloth_banner", 0.9, 0.2),
     "a cloth merchant's stall with bolts of fabric stacked and lengths hanging from a rail"),
    ("stall_bread", "Bread Stall", 2.4, 2200, M("wood_plank", "canvas_stripe", 0.9, 0.18),
     "a baker's market stall with loaves in shallow baskets under a cloth canopy"),
    ("stall_smith", "Tinker's Stall", 2.4, 2400, M("wood_plank", "canvas_stripe", 0.9, 0.18),
     "a tinker's stall hung with pots, pans and iron tools on hooks"),
    ("stall_empty", "Empty Trestle", 1.4, 1200, M("wood_plank", scale=0.9, jitter=0.16),
     "an empty market trestle table of rough planks on crossed legs"),
    ("market_cross", "Market Cross", 4.5, 3200, M("stone_limestone", scale=0.9, jitter=0.04),
     "a stone market cross on a stepped octagonal base with a carved shaft and a small canopy"),
    ("well_stone", "Town Well", 2.4, 2600, M("stone_rubble", "roof_shingle", 0.9, 0.06),
     "a round stone well with a timber winding frame, a bucket on a rope and a shingled cap"),
    ("fountain_tiered", "Town Fountain", 3.4, 4000, M("stone_limestone", scale=0.9, jitter=0.04),
     "a tiered stone town fountain, two carved basins and a spout in the form of a lion head"),
    ("trough", "Horse Trough", 0.9, 900, M("stone_rubble", scale=0.8, jitter=0.08),
     "a long stone horse trough full of water beside a hitching post"),
    ("lamp_post", "Street Lamp", 3.2, 1600, M("iron_wrought", scale=0.7, jitter=0.05),
     "a wrought iron street lamp post with a glazed lantern and a scrolled bracket"),
    ("brazier_street", "Street Brazier", 1.5, 1400, M("iron_rust", scale=0.7, jitter=0.08),
     "a tall iron brazier on three legs full of burning coals"),
    ("signpost", "Signpost", 2.6, 1200, M("wood_plank", scale=0.8, jitter=0.12),
     "a wooden signpost with three painted direction boards pointing different ways"),
    ("notice_board", "Notice Board", 2.2, 1400, M("wood_plank", scale=0.8, jitter=0.12),
     "a public notice board of planks under a small roof, papers nailed to it"),
    ("banner_pole", "Banner Pole", 5.0, 1600, M("wood_beam", "cloth_banner", 0.8, 0.12),
     "a tall banner pole with a long heraldic pennant hanging from a crossbar"),
    ("flag_standard", "Standard", 4.6, 1600, M("wood_beam", "cloth_banner", 0.8, 0.12),
     "a war standard on a pole, a square heraldic banner with a fringed lower edge"),
    ("bunting", "Festival Bunting", 3.2, 1400, M("wood_beam", "cloth_banner", 0.8, 0.2),
     "a line of triangular festival pennants strung between two poles"),
    ("cart_wagon", "Wagon", 2.2, 2600, M("wood_plank", scale=0.85, jitter=0.14),
     "a four-wheeled timber merchant wagon with an arched canvas cover and a raised driver bench"),
    ("cart_hand", "Handcart", 1.4, 1800, M("wood_plank", scale=0.85, jitter=0.14),
     "a two-wheeled wooden handcart tipped forward with its shafts on the ground"),
    ("cart_hay", "Hay Cart", 2.6, 2200, M("wood_plank", "straw", 0.85, 0.14),
     "a wooden farm cart piled high with loose hay, one wheel deep in mud"),
    ("cart_broken", "Broken Cart", 1.5, 2000, M("wood_plank", scale=0.85, jitter=0.16),
     "an overturned broken cart with a shattered wheel and spilled crates"),
    ("barrel_stack", "Barrel Stack", 1.8, 2000, M("wood_plank", scale=0.7, jitter=0.14),
     "a stack of five oak barrels bound with iron hoops, two upright and three on their sides"),
    ("crate_stack", "Crate Stack", 1.6, 1800, M("wood_pale", scale=0.7, jitter=0.14),
     "a stack of rough timber crates of different sizes with rope handles"),
    ("sack_pile", "Grain Sacks", 1.2, 1600, M("canvas_stripe", scale=0.7, jitter=0.14),
     "a pile of bulging hessian grain sacks, one split with grain spilling"),
    ("firewood", "Wood Pile", 1.3, 1800, M("wood_bark", scale=0.7, jitter=0.12),
     "a neatly stacked pile of split firewood logs against a wall"),
    ("rain_barrel", "Rain Barrel", 1.1, 1200, M("wood_plank", scale=0.7, jitter=0.12),
     "a single water butt of dark oak under a downpipe, brimming"),
    ("ladder_lean", "Ladder", 3.6, 800, M("wood_plank", scale=0.8, jitter=0.1),
     "a long wooden ladder leaning at an angle"),
    ("scaffold", "Scaffolding", 5.0, 2600, M("wood_beam", scale=0.85, jitter=0.1),
     "timber scaffolding lashed with rope against a building, planks at two levels"),
    ("planter", "Stone Planter", 0.9, 1200, M("stone_limestone", scale=0.7, jitter=0.08),
     "a carved stone planter box spilling with flowers and trailing greenery"),
    ("laundry_line", "Washing Line", 3.4, 1600, M("wood_beam", "cloth_banner", 0.8, 0.2),
     "a washing line strung between two poles hung with sheets and shirts"),
    ("stocks", "Stocks", 1.4, 1600, M("wood_beam", scale=0.8, jitter=0.08),
     "a set of wooden punishment stocks on a low platform"),
    ("gallows", "Gallows", 4.4, 1800, M("wood_beam", scale=0.85, jitter=0.06),
     "a grim timber gallows frame with a hanging noose"),
    ("statue_king", "King's Statue", 5.0, 4500, M("stone_limestone", scale=0.9, jitter=0.03),
     "a stone statue of a crowned king on a tall plinth, one hand raised, a sword at his side"),
    ("statue_knight", "Knight Statue", 4.2, 4500, M("stone_dark", scale=0.9, jitter=0.03),
     "a stone statue of an armoured knight standing with a greatsword point down on a plinth"),
    ("statue_angel", "Winged Statue", 4.6, 5000, M("stone_marble", scale=0.9, jitter=0.03),
     "a marble statue of a winged figure with outspread wings on a carved base"),
    ("obelisk", "Obelisk", 6.0, 2000, M("stone_sandstone", scale=0.9, jitter=0.04),
     "a tapering carved stone obelisk covered in runes on a stepped base"),
    ("fountain_wall", "Wall Fountain", 2.4, 2600, M("stone_limestone", scale=0.8, jitter=0.05),
     "a wall fountain, a carved mask spouting into a shallow stone basin"),
    ("bench_stone", "Stone Bench", 0.7, 900, M("stone_limestone", scale=0.7, jitter=0.08),
     "a simple carved stone bench with scrolled ends"),
    ("bench_wood", "Wooden Bench", 0.8, 800, M("wood_plank", scale=0.7, jitter=0.14),
     "a long weathered wooden bench with a plank back"),
    ("table_long", "Trestle Table", 1.0, 1400, M("wood_plank", scale=0.7, jitter=0.14),
     "a long trestle table of thick planks with benches down each side"),
    ("anvil_block", "Anvil", 0.9, 1400, M("iron_wrought", scale=0.6, jitter=0.05),
     "a heavy black iron anvil on a scarred oak stump with tongs and a hammer beside it"),
    ("grindstone", "Grindstone", 1.2, 1600, M("stone_rubble", scale=0.7, jitter=0.06),
     "a large round sharpening grindstone on a timber frame with a treadle"),
    ("cauldron_big", "Great Cauldron", 1.3, 1800, M("iron_rust", scale=0.7, jitter=0.06),
     "a big black iron cauldron hanging on a tripod over a fire"),
    ("weapon_rack", "Weapon Rack", 2.0, 1800, M("wood_beam", "iron_wrought", 0.7, 0.08),
     "a wooden rack holding spears, halberds and a pair of swords upright"),
    ("training_dummy", "Pell", 2.0, 1600, M("wood_beam", "straw", 0.7, 0.1),
     "a training pell, a post wrapped in straw and sacking with sword scars"),
    ("archery_butt", "Archery Butt", 1.8, 1600, M("straw", scale=0.7, jitter=0.1),
     "a round straw archery target on a tripod with arrows stuck in it"),
    ("armour_stand", "Armour Stand", 2.0, 2200, M("steel", scale=0.6, jitter=0.05),
     "a suit of plate armour displayed on a wooden stand holding a shield"),
    ("chest_iron", "Strongbox", 0.9, 1600, M("wood_beam", "iron_wrought", 0.6, 0.06),
     "an iron-bound oak strongbox with a heavy lock and corner straps"),
    ("bookstack", "Book Stack", 0.9, 1400, M("leather", scale=0.6, jitter=0.14),
     "a leaning stack of thick leather-bound books with a candle on top"),
    ("wheelbarrow", "Wheelbarrow", 1.0, 1400, M("wood_plank", scale=0.7, jitter=0.14),
     "a wooden wheelbarrow half full of rubble with one iron-rimmed wheel"),
    ("rubble_pile", "Rubble Heap", 1.2, 1600, M("stone_rubble", scale=0.7, jitter=0.1),
     "a heap of broken masonry blocks and roof tiles"),
    ("dung_heap", "Midden", 1.0, 1400, M("mud", scale=0.7, jitter=0.12),
     "a midden heap of straw and refuse behind a building"),
    ("bell_free", "Alarm Bell", 3.0, 2200, M("wood_beam", "bronze", 0.7, 0.05),
     "a bronze alarm bell hung in a small timber frame with a pull rope"),
    ("sundial", "Sundial", 1.1, 1400, M("stone_limestone", "bronze", 0.7, 0.05),
     "a stone pedestal sundial with a bronze gnomon and carved hour lines"),
    ("gate_arch_free", "Triumphal Arch", 8.0, 5000, M("stone_limestone", scale=1.0, jitter=0.03),
     "a free-standing triumphal stone arch with carved reliefs and a statue group on top"),
    ("stair_street", "Street Stair", 2.4, 2000, M("stone_rubble", scale=0.9, jitter=0.08),
     "a flight of worn stone street steps between two low walls"),
    ("bridge_stone", "Stone Bridge", 3.2, 4000, M("stone_rubble", "cobblestone", 1.0, 0.05),
     "a humpbacked stone arch bridge with low parapets and cutwaters"),
    ("bridge_wood", "Timber Bridge", 2.4, 3000, M("wood_beam", "wood_plank", 0.9, 0.08),
     "a simple timber plank bridge on trestle piers with a rope handrail"),
    ("aqueduct", "Aqueduct Span", 7.0, 4000, M("stone_sandstone", scale=1.0, jitter=0.05),
     "a two-tier stone aqueduct span with round arches carrying a water channel"),
    ("sewer_grate", "Sewer Mouth", 1.6, 1600, M("stone_dark", "iron_rust", 0.7, 0.06),
     "an arched stone sewer outfall with a rusted iron grate"),
]
for aid, name, h, f, mtl, prompt in STREET:
    spec(aid, "street", name, prompt, height=h, faces=f, material=mtl)


# ---------------------------------------------------------------------------
# The rural belt outside the walls.
# ---------------------------------------------------------------------------

RURAL = [
    ("farmhouse", "Farmhouse", 4.4, 4000, M("plaster_white", "roof_thatch", 1.0, 0.12),
     "a stone and plaster farmhouse with a thatched roof, a lean-to porch and a bread oven"),
    ("barn", "Barn", 6.0, 4500, M("wood_plank", "roof_thatch", 1.0, 0.1),
     "a big timber barn with tall double doors and a steep thatched roof"),
    ("stable_farm", "Stables", 3.8, 3500, M("wood_plank", "roof_shingle", 1.0, 0.12),
     "a low timber stable with three half doors and a hay rack outside"),
    ("windmill", "Windmill", 11.0, 6000, M("stone_rubble", "roof_shingle", 1.0, 0.06),
     "a stone tower windmill with four latticed sails and a rotating timber cap"),
    ("watermill", "Watermill", 6.5, 5500, M("stone_rubble", "roof_shingle", 1.0, 0.08),
     "a watermill with a great wooden undershot wheel on the side and a millrace"),
    ("chicken_coop", "Coop", 1.6, 1600, M("wood_plank", "roof_thatch", 0.8, 0.14),
     "a small wooden chicken coop on legs with a ramp and a wire run"),
    ("pigsty", "Pigsty", 1.4, 1600, M("stone_rubble", "roof_thatch", 0.8, 0.12),
     "a low stone pigsty with a thatched shelter and a mud wallow"),
    ("haystack", "Haystack", 3.0, 1600, M("straw", scale=1.0, jitter=0.12),
     "a big round hay rick with a combed conical top and a leaning ladder"),
    ("hay_bales", "Hay Bales", 1.2, 1400, M("straw", scale=0.8, jitter=0.14),
     "three square bound hay bales stacked in a pyramid"),
    ("beehives", "Beehives", 1.2, 1600, M("straw", scale=0.7, jitter=0.12),
     "a row of three woven straw skep beehives on a low plank shelf"),
    ("fence_wood", "Fence", 1.2, 900, M("wood_plank", scale=0.8, jitter=0.14),
     "a section of split-rail timber fence with three rails between two posts"),
    ("fence_wattle", "Wattle Fence", 1.1, 1200, M("wood_bark", scale=0.8, jitter=0.14),
     "a section of woven wattle hurdle fencing between two stakes"),
    ("wall_field", "Dry Stone Wall", 1.1, 1400, M("stone_rubble", scale=0.9, jitter=0.1),
     "a section of dry stone field wall of stacked flat stones with a rough coping"),
    ("gate_field", "Field Gate", 1.5, 1000, M("wood_plank", scale=0.8, jitter=0.12),
     "a five-bar timber field gate hung between two heavy posts"),
    ("scarecrow", "Scarecrow", 2.2, 1600, M("straw", "canvas_stripe", 0.7, 0.14),
     "a scarecrow of crossed poles in a ragged coat and a straw hat"),
    ("crop_wheat", "Wheat Rows", 1.4, 1800, M("straw", scale=1.2, jitter=0.1),
     "a patch of tall ripe wheat growing in neat rows"),
    ("crop_cabbage", "Vegetable Bed", 0.6, 1600, M("grass_meadow", scale=0.8, jitter=0.12),
     "a tilled vegetable bed with rows of cabbages and leeks in dark earth"),
    ("vineyard_row", "Vine Row", 1.6, 1800, M("wood_bark", "grass_meadow", 0.8, 0.12),
     "a row of staked grape vines on a low trellis"),
    ("orchard_tree", "Apple Tree", 4.0, 2400, M("wood_bark", "grass_meadow", 0.9, 0.14),
     "a spreading apple tree heavy with red fruit"),
    ("well_farm", "Farm Well", 2.0, 2000, M("stone_rubble", "wood_beam", 0.8, 0.1),
     "a rough stone farm well with a shaduf pole and a leather bucket"),
    ("shrine_wayside", "Wayside Shrine", 2.4, 2400, M("stone_limestone", "roof_shingle", 0.8, 0.06),
     "a small wayside shrine, a carved stone niche with a little peaked roof and candles"),
    ("graveyard_gate", "Lychgate", 3.0, 2600, M("wood_beam", "roof_shingle", 0.8, 0.06),
     "a timber lychgate with a shingled roof over a graveyard entrance"),
    ("tombstone", "Gravestones", 1.2, 1400, M("stone_dark", scale=0.7, jitter=0.12),
     "three leaning weathered gravestones of different heights, moss in the carving"),
    ("mausoleum", "Mausoleum", 3.6, 3600, M("stone_dark", "roof_slate", 0.9, 0.06),
     "a small stone mausoleum with a pillared front, an iron gate and a carved pediment"),
    ("ruin_arch", "Ruined Arch", 4.5, 2600, M("stone_mossy", scale=1.0, jitter=0.08),
     "a lone standing ruined stone archway with broken walls either side, ivy climbing it"),
    ("ruin_column", "Broken Columns", 3.6, 2400, M("stone_mossy", scale=1.0, jitter=0.08),
     "three broken stone columns of different heights on a cracked base"),
    ("campfire_ring", "Camp Fire", 0.8, 1400, M("stone_rubble", scale=0.6, jitter=0.1),
     "a ring of stones around a burning campfire with a spit over it"),
    ("tent_round", "Round Tent", 3.2, 2400, M("canvas_stripe", scale=1.0, jitter=0.16),
     "a round canvas pavilion tent with a pointed top and a pennant, guy ropes pegged out"),
    ("tent_square", "Camp Tent", 2.2, 2000, M("canvas_stripe", scale=1.0, jitter=0.16),
     "a simple ridge tent of grey canvas with an open flap"),
    ("watchpost", "Watchpost", 5.0, 2600, M("wood_beam", "roof_shingle", 0.9, 0.08),
     "a timber watchpost on four tall legs with a ladder and a small roofed platform"),
    ("milestone", "Milestone", 1.0, 900, M("stone_rubble", scale=0.6, jitter=0.1),
     "a short carved stone milestone with worn lettering"),
    ("cairn", "Stone Cairn", 1.6, 1400, M("stone_mossy", scale=0.7, jitter=0.12),
     "a stacked cairn of flat stones with a rune-carved capstone"),
]
for aid, name, h, f, mtl, prompt in RURAL:
    spec(aid, "rural", name, prompt, height=h, faces=f, material=mtl)


# ---------------------------------------------------------------------------
# The waterfront.
# ---------------------------------------------------------------------------

DOCK = [
    ("pier_section", "Pier", 1.4, 2000, M("wood_plank", "wood_plank", 0.9, 0.1),
     "a section of timber pier decking on piles standing above the water"),
    ("pier_head", "Pier Head", 1.6, 2400, M("wood_plank", scale=0.9, jitter=0.1),
     "the end of a timber pier with mooring bollards and a coil of rope"),
    ("boat_row", "Rowing Boat", 1.0, 2200, M("wood_plank", scale=0.8, jitter=0.14),
     "a small clinker-built wooden rowing boat with two oars shipped inside"),
    ("boat_fishing", "Fishing Boat", 2.6, 3600, M("wood_plank", "canvas_stripe", 0.9, 0.12),
     "a single-masted fishing boat with a furled sail, nets piled on the deck"),
    ("boat_barge", "River Barge", 2.0, 3400, M("wood_plank", scale=0.9, jitter=0.1),
     "a flat-bottomed river barge loaded with barrels and sacks, a long steering oar"),
    ("boat_cog", "Merchant Cog", 8.0, 6000, M("wood_plank", "cloth_banner", 1.0, 0.08),
     "a medieval merchant cog with a high stern castle, a single square sail and a crow's nest"),
    ("dock_crane", "Treadwheel Crane", 6.0, 4000, M("wood_beam", "roof_shingle", 0.9, 0.08),
     "a medieval harbour crane, a great timber treadwheel in a roofed frame with a swinging jib"),
    ("fish_rack", "Drying Rack", 2.2, 1800, M("wood_beam", scale=0.8, jitter=0.12),
     "a timber rack hung with rows of split fish drying in the air"),
    ("net_pile", "Net Pile", 0.9, 1600, M("rope", scale=0.7, jitter=0.14),
     "a heaped pile of brown fishing net with cork floats and a wicker trap"),
    ("mooring_post", "Bollard", 0.9, 800, M("wood_beam", "rope", 0.6, 0.1),
     "a thick timber mooring post with a heavy rope looped around it"),
    ("lighthouse", "Beacon Tower", 12.0, 5000, M("stone_ashlar", "iron_rust", 1.0, 0.05),
     "a tapering stone beacon tower with an iron fire basket at the top and an outside stair"),
    ("boathouse", "Boathouse", 4.0, 3600, M("wood_plank", "roof_shingle", 1.0, 0.1),
     "a timber boathouse over the water with a wide arched opening and a slipway"),
    ("harbour_wall", "Harbour Wall", 2.2, 2200, M("stone_ashlar", "cobblestone", 1.0, 0.06),
     "a section of stone harbour quay wall with iron rings and a stepped landing"),
    ("cargo_pile", "Cargo", 1.6, 2000, M("wood_pale", scale=0.7, jitter=0.16),
     "a dockside pile of crates, barrels and a bound bale under a tarpaulin"),
]
for aid, name, h, f, mtl, prompt in DOCK:
    spec(aid, "dock", name, prompt, height=h, faces=f, material=mtl)


# ---------------------------------------------------------------------------
# Greenery that belongs in a city rather than a forest.
# ---------------------------------------------------------------------------

CITY_NATURE = [
    ("tree_street", "Street Tree", 5.0, 2600, M("wood_bark", "grass_meadow", 0.9, 0.14),
     "a mature broadleaf street tree with a straight trunk and a rounded crown"),
    ("tree_cypress", "Cypress", 6.0, 2200, M("wood_bark", "grass_meadow", 0.9, 0.12),
     "a tall narrow dark cypress tree"),
    ("tree_willow", "Willow", 4.6, 2800, M("wood_bark", "grass_meadow", 0.9, 0.12),
     "a weeping willow with long trailing branches over water"),
    ("tree_dead", "Dead Tree", 4.4, 2000, M("wood_bark", scale=0.9, jitter=0.12),
     "a bare dead tree with broken clawing branches"),
    ("hedge_section", "Hedge", 1.4, 1600, M("grass_meadow", scale=1.0, jitter=0.12),
     "a dense clipped garden hedge section, flat topped"),
    ("topiary", "Topiary", 2.0, 1800, M("grass_meadow", scale=0.8, jitter=0.1),
     "a clipped conical topiary bush in a stone urn"),
    ("ivy_wall", "Ivy Curtain", 3.0, 1800, M("grass_meadow", scale=0.9, jitter=0.12),
     "a hanging curtain of climbing ivy on a fragment of wall"),
    ("flowerbed", "Flower Bed", 0.6, 1600, M("grass_meadow", scale=0.8, jitter=0.14),
     "a low bed of mixed flowers edged with small stones"),
    ("rocks_city", "Boulder", 1.4, 1400, M("stone_mossy", scale=0.9, jitter=0.12),
     "a large weathered mossy boulder"),
]
for aid, name, h, f, mtl, prompt in CITY_NATURE:
    spec(aid, "nature", name, prompt, height=h, faces=f, material=mtl)


if __name__ == "__main__":
    print(json.dumps(A, indent=1))
