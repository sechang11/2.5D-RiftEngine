"""
Builds the asset catalog.

Sizes are in engine world units, where a champion stands 2.2 units tall, so one
unit is roughly two thirds of a metre. Getting these right in the catalog is
what lets the editor drop a wizard tower and a dropped dagger onto the same map
without either being absurd, and it is much cheaper to state the intended size
here than to rescale two hundred meshes by hand later.

Triangle budgets are set by how close the camera ever gets and how often the
thing appears: a hero building can afford five thousand, a mushroom cannot.
"""

import json
import os

STYLE = "stylized fantasy game asset, bold readable forms, clean silhouette, three-quarter view"

# category -> (default height, default faces, upright rule)
DEFAULTS = {
    "weapon": (1.3, 2500, "longest"),
    "shield": (1.0, 2000, "none"),
    "building": (5.0, 5000, "none"),
    "prop": (1.2, 1800, "none"),
    "nature": (3.0, 2200, "none"),
    "creature": (2.0, 4000, "none"),
    "pickup": (0.6, 1200, "none"),
}


def spec(aid, category, name, prompt, height=None, faces=None, upright=None, tags=()):
    dh, df, du = DEFAULTS[category]
    return {
        "id": "%s_%s" % (category, aid),
        "name": name,
        "category": category,
        "tags": list(tags),
        "height": height if height is not None else dh,
        "faces": faces if faces is not None else df,
        "upright": upright if upright is not None else du,
        "prompt": prompt + ", " + STYLE,
    }


A = []

# --- weapons -------------------------------------------------------------
# Held in a character's hand, so these are sized like real arms rather than
# like the oversized props they are drawn as.
WEAPONS = [
    ("longsword", "Longsword", "a knightly longsword with a straight crossguard and leather-wrapped grip", 1.35),
    ("greatsword", "Greatsword", "a huge two-handed greatsword with a broad fullered blade", 1.9),
    ("scimitar", "Scimitar", "a curved desert scimitar with a brass pommel", 1.2),
    ("rapier", "Rapier", "a slender duelling rapier with a swept basket hilt", 1.25),
    ("flamberge", "Flamberge", "a wavy-bladed flamberge sword with an ornate guard", 1.7),
    ("shortsword", "Shortsword", "a simple iron shortsword with a wooden grip", 0.95),
    ("dagger", "Dagger", "a curved assassin dagger with a jewelled pommel", 0.5),
    ("dagger_bone", "Bone Dagger", "a jagged bone dagger bound with sinew", 0.48),
    ("battleaxe", "Battleaxe", "a heavy double-headed battleaxe with a runed haft", 1.4),
    ("handaxe", "Hand Axe", "a small iron hand axe with a worn wooden handle", 0.8),
    ("warhammer", "Warhammer", "a blocky steel warhammer with a spiked back", 1.3),
    ("maul", "Great Maul", "an enormous stone maul on a thick timber shaft", 1.8),
    ("mace", "Mace", "a flanged iron mace with a round pommel", 1.0),
    ("morningstar", "Morningstar", "a spiked morningstar ball on a short chain and handle", 1.1),
    ("spear", "Spear", "a long ash spear with a leaf-shaped steel head", 2.4),
    ("halberd", "Halberd", "a halberd with an axe blade, spike and hook on a long shaft", 2.5),
    ("glaive", "Glaive", "a glaive with a long curved blade on a polearm shaft", 2.4),
    ("trident", "Trident", "a three-pronged bronze trident", 2.3),
    ("bow", "Longbow", "a recurve longbow of dark yew with a taut string", 1.7),
    ("bow_ornate", "Elven Bow", "an ornate elven longbow carved with leaf motifs", 1.7),
    ("crossbow", "Crossbow", "a heavy wooden crossbow with iron fittings", 0.9),
    ("staff_wizard", "Wizard Staff", "a gnarled wooden wizard staff with a glowing crystal at the top", 2.0),
    ("staff_necro", "Necromancer Staff", "a black staff topped with a horned skull and bone fingers", 2.0),
    ("staff_druid", "Druid Staff", "a living wooden staff wrapped in ivy with green leaves", 2.0),
    ("staff_crystal", "Crystal Staff", "a silver staff holding a floating faceted blue crystal", 2.0),
    ("wand_oak", "Oak Wand", "a short carved oak wand with a rune band", 0.42),
    ("wand_bone", "Bone Wand", "a slim bone wand tipped with a red gem", 0.42),
    ("orb_arcane", "Arcane Orb", "a floating polished arcane orb wrapped in a metal claw setting", 0.35),
    ("tome", "Spell Tome", "a thick leather spellbook with brass corners and a clasp", 0.45),
    ("scroll_rod", "Scroll Rod", "a rolled parchment scroll bound with a red ribbon", 0.4),
    ("scythe", "Scythe", "a reaper scythe with a long curved blade", 2.3),
    ("club_spiked", "Spiked Club", "a crude orcish club studded with iron spikes", 1.2),
    ("khopesh", "Khopesh", "a bronze khopesh with a hooked blade", 1.1),
    ("katar", "Katar", "a push dagger with an H-shaped horizontal grip", 0.55),
    ("whip", "Chain Whip", "a coiled segmented chain whip with a barbed tip", 1.0),
]
for aid, name, prompt, h in WEAPONS:
    A.append(spec(aid, "weapon", name, "a single " + prompt + ", floating upright, nothing beneath it", height=h, tags=["weapon"]))

SHIELDS = [
    ("kite", "Kite Shield", "a tall kite shield painted with a heraldic lion", 1.15),
    ("tower", "Tower Shield", "a rectangular iron-banded tower shield", 1.35),
    ("round", "Round Shield", "a round viking shield of painted planks with an iron boss", 0.95),
    ("buckler", "Buckler", "a small round steel buckler", 0.5),
    ("aegis", "Aegis", "an ornate golden shield with a radiant sunburst face", 1.1),
]
for aid, name, prompt, h in SHIELDS:
    A.append(spec(aid, "shield", name, "a single " + prompt + ", facing the viewer, floating", height=h, tags=["shield", "armour"]))

# --- buildings -----------------------------------------------------------
BUILDINGS = [
    ("wizard_tower", "Wizard Tower", "a tall stone wizard tower with a conical blue tiled roof and arched windows", 9.0),
    ("watchtower", "Watchtower", "a square timber watchtower with a shingled roof and a ladder", 7.0),
    ("guard_post", "Guard Post", "a small stone guard post with an arrow slit and a banner", 4.0),
    ("gatehouse", "Gatehouse", "a fortified stone gatehouse with a raised portcullis and twin turrets", 6.5),
    ("keep", "Stone Keep", "a squat fortified stone keep with battlements and a heavy door", 8.0),
    ("chapel", "Chapel", "a small stone chapel with a bell tower and a rose window", 6.0),
    ("shrine", "Roadside Shrine", "a small roadside shrine of carved stone with a candle alcove", 2.2),
    ("blacksmith", "Blacksmith Forge", "a blacksmith forge with a stone chimney, anvil and open shutter", 4.0),
    ("tavern", "Tavern", "a timber-framed fantasy tavern with a hanging sign and warm windows", 5.5),
    ("cottage", "Cottage", "a thatched stone cottage with a crooked chimney", 3.6),
    ("longhouse", "Longhouse", "a viking longhouse with a turf roof and carved gable posts", 4.2),
    ("hut_orc", "Orc Hut", "a crude orcish hut of hide and bone lashed to timber poles", 3.0),
    ("market_stall", "Market Stall", "a wooden market stall with a striped awning and crates", 2.8),
    ("windmill", "Windmill", "a stone windmill with four wooden sails and a shingled cap", 8.0),
    ("granary", "Granary", "a round wooden granary raised on stone staddle stones", 3.4),
    ("stable", "Stable", "an open timber stable with a hay loft", 3.8),
    ("well", "Stone Well", "a round stone well with a wooden roof and a bucket on a rope", 2.0),
    ("fountain", "Fountain", "an ornate stone fountain with a carved central figure", 2.6),
    ("obelisk", "Obelisk", "a tall carved obelisk covered in glowing runes", 6.0),
    ("standing_stones", "Standing Stones", "a cluster of three weathered standing stones", 3.2),
    ("portal_arch", "Portal Arch", "a stone archway framing a swirling magical portal", 4.5),
    ("ruined_arch", "Ruined Arch", "a crumbling stone archway missing half its keystone", 4.0),
    ("crypt_entrance", "Crypt Entrance", "a sunken stone crypt entrance with iron gates and skull carvings", 3.0),
    ("altar", "Dark Altar", "a blood-stained stone altar with candles and chains", 1.4),
    ("statue_knight", "Knight Statue", "a weathered stone statue of an armoured knight holding a sword", 4.0),
    ("statue_dragon", "Dragon Statue", "a stone statue of a coiled dragon on a low plinth", 3.2),
    ("siege_ballista", "Ballista", "a wooden siege ballista mounted on a turntable", 2.6),
    ("siege_catapult", "Catapult", "a wooden siege catapult with a loaded arm", 3.2),
    ("barricade", "Barricade", "a spiked wooden barricade of lashed timber", 1.6),
    ("palisade", "Palisade Section", "a section of sharpened timber palisade wall", 3.0),
    ("bridge", "Stone Bridge", "a small arched stone footbridge with low parapets", 2.2),
    ("dock", "Wooden Dock", "a short wooden dock on pilings with mooring posts", 1.4),
    ("tent", "Camp Tent", "a canvas camp tent with guy ropes and a banner pole", 2.4),
    ("campfire", "Campfire", "a stone-ringed campfire with burning logs and a cooking tripod", 1.2),
    ("mine_entrance", "Mine Entrance", "a timber-framed mine entrance cut into rock with rails", 3.2),
]
for aid, name, prompt, h in BUILDINGS:
    A.append(spec(aid, "building", name, prompt + ", whole structure visible", height=h, tags=["structure"]))

# --- nature and terrain --------------------------------------------------
NATURE = [
    ("oak", "Oak Tree", "a broad gnarled oak tree with a full canopy", 7.0),
    ("pine", "Pine Tree", "a tall narrow pine tree", 9.0),
    ("birch", "Birch Tree", "a slender white birch tree with sparse leaves", 6.5),
    ("willow", "Willow Tree", "a weeping willow with long trailing branches", 6.0),
    ("dead_tree", "Dead Tree", "a bare dead tree with twisted broken branches", 5.0),
    ("palm", "Palm Tree", "a curved palm tree with broad fronds", 6.0),
    ("stump", "Tree Stump", "a mossy cut tree stump with exposed roots", 0.7),
    ("log", "Fallen Log", "a fallen mossy log split at one end", 0.8),
    ("bush", "Bush", "a dense round leafy bush", 1.1),
    ("bramble", "Bramble Patch", "a tangled thorny bramble patch", 0.9),
    ("fern", "Fern Cluster", "a cluster of tall green ferns", 0.8),
    ("reeds", "Reeds", "a clump of tall marsh reeds", 1.4),
    ("mushroom_giant", "Giant Mushroom", "a giant glowing blue-capped mushroom", 2.4),
    ("mushroom_cluster", "Mushroom Cluster", "a cluster of small red spotted mushrooms", 0.4),
    ("boulder", "Boulder", "a large rounded granite boulder", 1.8),
    ("boulder_mossy", "Mossy Boulder", "a mossy weathered boulder", 1.6),
    ("rock_spire", "Rock Spire", "a jagged upright rock spire", 4.0),
    ("rocks_small", "Small Rocks", "a scattered pile of small angular rocks", 0.5),
    ("cliff_chunk", "Cliff Face", "a blocky chunk of layered stone cliff", 4.5),
    ("stalagmite", "Stalagmite", "a tapering cave stalagmite of pale stone", 2.6),
    ("crystal_blue", "Blue Crystal", "a cluster of tall glowing blue crystals", 2.2),
    ("crystal_violet", "Violet Crystal", "a cluster of jagged violet crystals", 1.8),
    ("crystal_amber", "Amber Crystal", "a cluster of warm amber crystal shards", 1.6),
    ("lilypad", "Lily Pads", "a spread of flat lily pads with a white flower", 0.2),
    ("cattails", "Cattails", "a stand of brown cattail reeds", 1.5),
    ("flowers", "Wildflowers", "a small patch of blue and white wildflowers", 0.35),
    ("vines", "Hanging Vines", "a curtain of hanging green vines", 2.5),
    ("coral", "Coral Fan", "a branching pink coral fan", 1.0),
    ("bones_ribcage", "Ribcage", "a huge weathered ribcage of some great beast", 2.8),
    ("bones_skull", "Beast Skull", "an enormous horned beast skull half buried", 1.6),
    ("bones_pile", "Bone Pile", "a heap of scattered bones and skulls", 0.6),
    ("tombstone", "Tombstone", "a cracked weathered tombstone", 1.1),
    ("ruin_pillar", "Ruined Pillar", "a broken fluted stone pillar", 3.0),
    ("ruin_wall", "Ruined Wall", "a crumbling section of mossy stone wall", 2.0),
    ("rubble", "Rubble", "a pile of broken masonry rubble", 0.7),
    ("ice_shard", "Ice Shard", "a jagged translucent ice shard formation", 2.4),
    ("lava_rock", "Lava Rock", "a cracked black volcanic rock glowing orange in the fissures", 1.4),
    ("sand_dune", "Sand Drift", "a low windswept sand drift", 0.6),
    ("snow_drift", "Snow Drift", "a low mound of packed snow", 0.5),
    ("swamp_root", "Swamp Roots", "a tangle of gnarled swamp roots rising from mud", 1.2),
]
for aid, name, prompt, h in NATURE:
    A.append(spec(aid, "nature", name, prompt, height=h, tags=["terrain"]))

# --- props ---------------------------------------------------------------
PROPS = [
    ("barrel", "Barrel", "a wooden barrel with iron bands", 1.1),
    ("barrel_open", "Open Barrel", "an open wooden barrel full of apples", 1.1),
    ("crate", "Crate", "a wooden shipping crate with rope handles", 0.9),
    ("crate_stack", "Crate Stack", "a stack of three wooden crates", 1.8),
    ("sack", "Grain Sack", "a bulging burlap grain sack tied with rope", 0.8),
    ("chest", "Treasure Chest", "a banded wooden treasure chest with a heavy lock", 0.8),
    ("chest_open", "Open Chest", "an open treasure chest spilling gold coins", 0.8),
    ("anvil", "Anvil", "a heavy black iron anvil on a wooden block", 0.9),
    ("cart", "Handcart", "a two-wheeled wooden handcart with a load of hay", 1.4),
    ("wagon", "Wagon", "a covered merchant wagon with canvas top and spoked wheels", 2.6),
    ("wheel", "Wagon Wheel", "a leaning broken wooden wagon wheel", 1.2),
    ("brazier", "Brazier", "an iron brazier on three legs burning with coals", 1.3),
    ("lantern_post", "Lamp Post", "a wrought iron lamp post with a glass lantern", 3.0),
    ("torch_wall", "Wall Torch", "an iron wall sconce holding a burning torch", 0.8),
    ("candelabra", "Candelabra", "a tall branched iron candelabra with lit candles", 1.5),
    ("signpost", "Signpost", "a wooden signpost with three painted direction boards", 2.3),
    ("banner", "Banner", "a tall heraldic banner on a pole with a gold fringe", 3.2),
    ("fence", "Fence Section", "a section of split rail wooden fence", 1.2),
    ("gate_iron", "Iron Gate", "an ornate wrought iron gate with spear finials", 2.6),
    ("bench", "Bench", "a weathered wooden bench", 0.8),
    ("table_round", "Round Table", "a round wooden tavern table", 0.9),
    ("cauldron", "Cauldron", "a black iron cauldron bubbling with green brew", 1.1),
    ("bookshelf", "Bookshelf", "a tall wooden bookshelf crammed with old books", 2.2),
    ("weapon_rack", "Weapon Rack", "a wooden rack holding spears and swords", 1.8),
    ("target_dummy", "Training Dummy", "a straw training dummy on a wooden post", 2.0),
    ("bedroll", "Bedroll", "a rolled canvas bedroll with a blanket", 0.35),
    ("crystal_ball", "Crystal Ball", "a crystal ball on a clawed brass stand", 0.5),
    ("hourglass", "Hourglass", "a large brass-framed hourglass", 0.6),
    ("bell", "Bronze Bell", "a large bronze bell on a timber frame", 1.8),
    ("statue_bust", "Stone Bust", "a carved stone bust of a hooded figure", 1.0),
]
for aid, name, prompt, h in PROPS:
    A.append(spec(aid, "prop", name, prompt, height=h, tags=["prop"]))

# --- pickups -------------------------------------------------------------
PICKUPS = [
    ("potion_red", "Health Potion", "a round glass potion bottle full of glowing red liquid with a cork", 0.3),
    ("potion_blue", "Mana Potion", "a tall glass potion bottle of glowing blue liquid", 0.3),
    ("potion_green", "Elixir", "a squat green elixir flask with a wax seal", 0.28),
    ("gem_ruby", "Ruby", "a large faceted ruby gemstone", 0.25),
    ("gem_emerald", "Emerald", "a large faceted emerald gemstone", 0.25),
    ("gem_sapphire", "Sapphire", "a large faceted sapphire gemstone", 0.25),
    ("coin_pile", "Gold Pile", "a small heap of gold coins", 0.25),
    ("coin_chest", "Coin Purse", "a leather coin purse spilling gold", 0.3),
    ("key_iron", "Iron Key", "a large ornate iron key", 0.25),
    ("skull_small", "Skull", "a bleached human skull", 0.25),
    ("rune_stone", "Rune Stone", "a flat grey stone carved with a single glowing rune", 0.35),
    ("amulet", "Amulet", "a golden amulet on a chain with a blue stone", 0.28),
    ("ring", "Ring", "an ornate gold ring set with a red gem", 0.15),
    ("crown", "Crown", "a golden crown set with jewels", 0.4),
    ("mushroom_pick", "Glow Cap", "a single glowing blue mushroom", 0.3),
    ("herb_bundle", "Herb Bundle", "a tied bundle of dried green herbs", 0.3),
]
for aid, name, prompt, h in PICKUPS:
    A.append(spec(aid, "pickup", name, "a single " + prompt + ", floating, nothing beneath it", height=h, tags=["pickup", "item"]))

# --- creatures -----------------------------------------------------------
# Reconstruction handles massed, non-humanoid forms far better than it handles
# people. These are chosen to play to that: things made of rock, slime, bone
# and plant, plus beasts whose silhouette reads from a single view.
CREATURES = [
    ("slime", "Slime", "a translucent green blob slime creature with two eyes", 1.0),
    ("ooze_purple", "Purple Ooze", "a bubbling purple ooze creature", 1.1),
    ("golem_stone", "Stone Golem", "a hulking golem built of stacked mossy boulders with glowing eyes", 3.0),
    ("golem_iron", "Iron Golem", "a massive riveted iron golem with a furnace chest", 3.2),
    ("golem_bone", "Bone Golem", "a hulking golem assembled from bones and skulls", 3.0),
    ("treant", "Treant", "an ancient walking tree creature with a face in its bark", 6.0),
    ("mushroom_folk", "Myconid", "a walking mushroom creature with a broad spotted cap", 1.6),
    ("gargoyle", "Gargoyle", "a crouching stone gargoyle with folded bat wings", 2.0),
    ("elemental_fire", "Fire Elemental", "a swirling humanoid figure of flame and ember", 2.6),
    ("elemental_ice", "Ice Elemental", "a jagged humanoid figure of blue ice shards", 2.6),
    ("elemental_earth", "Earth Elemental", "a lumbering humanoid figure of packed earth and stone", 2.8),
    ("wisp", "Wisp", "a floating glowing wisp of light with trailing tendrils", 0.7),
    ("dragon_wyrmling", "Wyrmling", "a small four-legged dragon with folded wings and a long tail", 1.8),
    ("drake", "Drake", "a wingless four-legged drake with a spined back", 2.2),
    ("wyvern", "Wyvern", "a wyvern with two legs and broad wings, standing", 3.4),
    ("basilisk", "Basilisk", "a heavy six-legged basilisk lizard with a crested head", 1.6),
    ("giant_spider", "Giant Spider", "a huge hairy spider with eight jointed legs", 1.5),
    ("beetle_giant", "Giant Beetle", "an armoured giant beetle with a horned carapace", 1.2),
    ("scorpion", "Giant Scorpion", "a giant black scorpion with raised stinger and claws", 1.3),
    ("dire_wolf", "Dire Wolf", "a large shaggy dire wolf standing on all fours", 1.6),
    ("bear_cave", "Cave Bear", "a massive shaggy cave bear on all fours", 2.0),
    ("boar_tusked", "Tusked Boar", "a bristling wild boar with long curved tusks", 1.2),
    ("stag_great", "Great Stag", "a noble stag with enormous branching antlers", 2.4),
    ("serpent", "Serpent", "a huge coiled scaled serpent with a raised head", 1.8),
    ("crab_giant", "Giant Crab", "an armoured giant crab with heavy claws", 1.2),
    ("turtle_ancient", "Ancient Turtle", "an enormous ancient turtle with a mossy rocky shell", 2.2),
    ("skeleton_warrior", "Skeleton", "a skeleton warrior in tattered mail holding a rusted sword, standing", 2.0),
    ("zombie", "Zombie", "a shambling rotted zombie in torn clothing, standing", 2.0),
    ("wraith", "Wraith", "a hooded floating wraith with empty sleeves and a trailing shroud", 2.4),
    ("lich", "Lich", "a skeletal lich in an ornate robe and crown holding a staff", 2.4),
    ("imp", "Imp", "a small horned red imp with bat wings and a barbed tail", 1.0),
    ("demon_brute", "Demon Brute", "a hulking horned demon with cloven hooves and heavy arms", 3.2),
    ("minotaur", "Minotaur", "a huge bull-headed minotaur with a great axe", 3.0),
    ("troll_cave", "Cave Troll", "a hunched warty cave troll with long arms", 3.0),
    ("ogre", "Ogre", "a fat brutish ogre with a club and a leather kilt", 2.8),
    ("harpy", "Harpy", "a harpy with feathered wings for arms and taloned feet", 2.0),
    ("mimic", "Mimic", "a treasure chest with a fanged mouth and a lolling tongue", 0.9),
]
for aid, name, prompt, h in CREATURES:
    A.append(spec(aid, "creature", name, prompt + ", full body visible, standing on nothing", height=h, tags=["creature", "npc"]))


if __name__ == "__main__":
    out = os.path.expanduser("~/gamegen/scripts/catalog.json")
    with open(out, "w") as f:
        json.dump(A, f, indent=1)
    counts = {}
    for s in A:
        counts[s["category"]] = counts.get(s["category"], 0) + 1
    print("wrote %d assets to %s" % (len(A), out))
    for k in sorted(counts):
        print("  %-10s %d" % (k, counts[k]))
