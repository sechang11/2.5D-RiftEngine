"""
The people and monsters of the castle city.

Two categories, because they are shaded and sized differently and because a
museum gallery of sixty figures should not mix a queen with a wyvern:

  folk       humans and humanoids, from a beggar to the king
  creature   everything that would eat them

Three things are deliberately different from the first character pass:

  Bigger. The first pack put every creature at 2.0 units against a 2.2 champion,
  so a dire wolf and a lich were the same height as each other and nearly the
  same as the player. Heights here are set individually and the range runs from
  a 1.4 goblin to a 7.5 giant.

  Denser. Characters get six to nine thousand triangles instead of four. They
  are what the camera is pointed at; a barrel is not.

  Textured. Each figure names the surfaces it wears — mail, hide, scale, wool —
  and the engine projects them. Nothing here is shaded by a category colour.

Poses are specified because reconstruction depends on them far more than on the
prompt's adjectives: arms clear of the body, feet apart, nothing crossing the
silhouette. A figure drawn with its arms folded reconstructs as a barrel.

  python3 folk_catalog.py > catalog_folk.json
"""

import json

STYLE = (
    "stylized medieval fantasy game character, full body from head to feet, "
    "standing upright in a neutral pose, arms held slightly away from the body, "
    "feet apart, three-quarter front view, crisp readable silhouette, "
    "painted character concept art, muted natural colours"
)

# category -> (height, faces)
DEFAULTS = {"folk": (2.5, 7000), "creature": (2.6, 7500)}

A = []


def M(side, top=None, scale=0.9, jitter=0.08):
    return {"side": side, "top": top or side, "scale": scale, "jitter": jitter}


def spec(aid, category, name, prompt, height=None, faces=None, material=None,
         tags=(), octree=None):
    dh, df = DEFAULTS[category]
    entry = {
        "id": "%s_%s" % (category, aid),
        "name": name,
        "category": category,
        "tags": list(tags),
        "height": height if height is not None else dh,
        "faces": faces if faces is not None else df,
        # Characters are modelled standing, and the reconstructor sometimes
        # returns them lying down. Forcing the longest axis vertical fixes that
        # for anything taller than it is wide, which is every figure here except
        # the four-legged ones.
        "upright": "longest" if category == "folk" else "none",
        "prompt": prompt + ", " + STYLE,
        "material": material or M("leather"),
    }
    if octree:
        entry["octree"] = octree
    A.append(entry)
    return entry


MAIL = M("chainmail", "steel", 0.55, 0.06)
PLATE = M("steel", "cloth_banner", 0.5, 0.05)
CLOTH = M("robe_cloth", "leather", 0.7, 0.12)
PEASANT = M("canvas_stripe", "leather", 0.7, 0.16)
LEATHER = M("leather", "wood_plank", 0.6, 0.12)
HIDE = M("fur_brown", "leather", 0.7, 0.12)
GREEN = M("skin_green", "leather", 0.7, 0.1)
SCALE = M("scale_green", "bone", 0.7, 0.1)
BONES = M("bone", "cloth_banner", 0.7, 0.08)
STONE = M("stone_dark", "stone_mossy", 0.8, 0.08)

# --- folk ------------------------------------------------------------------

FOLK = [
    ("king", "The King", 2.7, PLATE,
     "a crowned king in a fur-trimmed royal robe over gilded armour, holding a sceptre"),
    ("queen", "The Queen", 2.6, CLOTH,
     "a queen in a long embroidered gown with a jewelled circlet and a trailing mantle"),
    ("prince", "Young Lord", 2.5, CLOTH,
     "a young noble lord in a fitted doublet, hose and a short cape, a sword at his hip"),
    ("noblewoman", "Noblewoman", 2.5, CLOTH,
     "a noblewoman in a fine houppelande with hanging sleeves and a horned headdress"),
    ("knight_plate", "Knight", 2.7, PLATE,
     "a knight in full plate armour with a closed visor helm, a heraldic surcoat and a longsword"),
    ("knight_kneeling", "Champion", 2.7, PLATE,
     "an armoured champion in ornate plate with a great helm crest and a kite shield"),
    ("paladin", "Paladin", 2.8, PLATE,
     "a paladin in radiant silvered plate with a winged helm and a warhammer"),
    ("manatarms", "Man-at-Arms", 2.6, MAIL,
     "a man-at-arms in a mail hauberk and kettle helm with a spear and a round shield"),
    ("sergeant", "Sergeant", 2.6, MAIL,
     "a grizzled sergeant in a padded gambeson and mail coif, holding a halberd"),
    ("pikeman", "Pikeman", 2.6, MAIL,
     "a pikeman in a brigandine and open helm holding a very long pike upright"),
    ("archer", "Archer", 2.5, LEATHER,
     "a longbowman in a green hood and leather jerkin, longbow held at his side, quiver on his back"),
    ("crossbowman", "Crossbowman", 2.5, LEATHER,
     "a crossbowman in a padded jack and wide brimmed helm with a spanned crossbow"),
    ("guard_city", "City Guard", 2.6, MAIL,
     "a city watchman in a mail shirt and tabard with a lantern and a cudgel"),
    ("herald", "Herald", 2.5, CLOTH,
     "a herald in a bright quartered tabard holding a rolled proclamation and a horn"),
    ("wizard", "Archmage", 2.6, CLOTH,
     "an old archmage in a long star-patterned robe and pointed hat with a gnarled staff"),
    ("sorceress", "Sorceress", 2.5, CLOTH,
     "a sorceress in flowing layered robes with a circlet, holding a glowing orb"),
    ("necromancer", "Necromancer", 2.6, CLOTH,
     "a gaunt necromancer in tattered black robes with a bone staff and a skull amulet"),
    ("druid", "Druid", 2.5, HIDE,
     "a druid in furs and leaves with antlers in his hair, holding a living wooden staff"),
    ("cleric", "Cleric", 2.5, CLOTH,
     "a cleric in a hooded habit with a heavy holy symbol and a mace"),
    ("bishop", "Bishop", 2.6, CLOTH,
     "a bishop in an embroidered cope and mitre holding a crozier"),
    ("monk", "Monk", 2.4, CLOTH,
     "a tonsured monk in a plain brown habit with a rope belt, carrying a book"),
    ("bard", "Bard", 2.4, CLOTH,
     "a bard in a parti-coloured tunic and feathered cap with a lute slung at his side"),
    ("thief", "Cutpurse", 2.3, LEATHER,
     "a lean cutpurse in a dark hood and wrapped boots with two daggers at his belt"),
    ("assassin", "Assassin", 2.5, LEATHER,
     "a masked assassin in close-fitting dark leathers with a curved dagger reversed in one hand"),
    ("mercenary", "Sellsword", 2.6, LEATHER,
     "a scarred sellsword in mismatched armour with a two-handed sword over one shoulder"),
    ("barbarian", "Barbarian", 2.9, HIDE,
     "a huge bare-chested barbarian in fur and iron with a great axe and braided hair"),
    ("ranger", "Ranger", 2.5, LEATHER,
     "a ranger in a hooded travelling cloak with a bow, a short sword and a bedroll"),
    ("merchant", "Merchant", 2.4, CLOTH,
     "a portly merchant in a fur-trimmed gown and a hat, holding a ledger and a purse"),
    ("blacksmith", "Blacksmith", 2.5, PEASANT,
     "a broad blacksmith in a scorched leather apron with bare arms, holding a hammer and tongs"),
    ("baker", "Baker", 2.4, PEASANT,
     "a baker in a flour-dusted apron and cap carrying a wide tray of loaves"),
    ("fisherman", "Fisherman", 2.4, PEASANT,
     "a weathered fisherman in an oiled coat and boots with a net over one shoulder"),
    ("farmer", "Farmer", 2.4, PEASANT,
     "a farmer in a rough tunic and straw hat leaning on a pitchfork"),
    ("peasant_woman", "Goodwife", 2.3, PEASANT,
     "a peasant woman in a long apron and headscarf carrying a basket on her hip"),
    ("beggar", "Beggar", 2.2, PEASANT,
     "a ragged beggar hunched in a patched cloak holding out a wooden bowl"),
    ("innkeeper", "Innkeeper", 2.4, PEASANT,
     "a stout innkeeper in a stained apron with rolled sleeves holding a tankard"),
    ("stablehand", "Stablehand", 2.3, PEASANT,
     "a young stablehand in a short tunic with a coil of rope and a brush"),
    ("executioner", "Executioner", 2.7, LEATHER,
     "a hooded executioner, bare-chested with a leather hood, resting on a great axe"),
    ("dwarf_smith", "Dwarf Smith", 1.9, MAIL,
     "a stocky dwarf with a huge braided beard in a mail apron, holding a smith's hammer"),
    ("dwarf_warrior", "Dwarf Warrior", 2.0, PLATE,
     "an armoured dwarf warrior with a horned helm, a broad axe and a round shield"),
    ("elf_archer", "Elf Archer", 2.6, LEATHER,
     "a tall slender elf archer in layered leaf-green leathers with a long recurve bow"),
    ("elf_mage", "Elf Mage", 2.6, CLOTH,
     "an elven mage in pale flowing robes with silver filigree and a slim staff"),
    ("halfling", "Halfling", 1.5, PEASANT,
     "a curly-haired halfling in a waistcoat with bare feet, holding a sling"),
    ("orc_warrior", "Orc Warrior", 2.9, GREEN,
     "a heavy green orc warrior with tusks in scrap iron armour, holding a cleaver blade"),
    ("orc_shaman", "Orc Shaman", 2.7, GREEN,
     "an orc shaman in bones and hides with a totem staff and painted skin"),
    ("orc_chief", "Orc Warlord", 3.2, GREEN,
     "a massive orc warlord in plundered plate with a horned helm and a two-handed axe"),
    ("goblin", "Goblin", 1.5, GREEN,
     "a small hunched goblin with big ears in scraps of leather, holding a rusty knife"),
    ("hobgoblin", "Hobgoblin", 2.4, GREEN,
     "a disciplined hobgoblin soldier in lamellar armour with a spear and a tower shield"),
]
for aid, name, h, mtl, prompt in FOLK:
    spec(aid, "folk", name, prompt, height=h, material=mtl, faces=7000)

# The city's rulers deserve the extra octree; they are the ones players walk up to.
for hero in ("folk_king", "folk_knight_plate", "folk_wizard", "folk_orc_chief"):
    for entry in A:
        if entry["id"] == hero:
            entry["octree"] = 320
            entry["faces"] = 9000

# --- creatures --------------------------------------------------------------

CREATURES = [
    ("troll", "Cave Troll", 4.2, HIDE,
     "a hulking grey cave troll with a long nose and knotted muscles, dragging a club"),
    ("ogre", "Ogre", 3.8, HIDE,
     "a fat brutal ogre in a hide kilt with an iron collar, holding a spiked club"),
    ("giant", "Hill Giant", 7.5, HIDE,
     "an enormous hill giant in furs with a tree trunk over one shoulder", ),
    ("minotaur", "Minotaur", 3.4, HIDE,
     "a minotaur with heavy bull horns and a ringed nose, holding a double axe"),
    ("centaur", "Centaur", 3.2, HIDE,
     "a centaur, a man's torso on a horse's body, carrying a bow and a quiver"),
    ("satyr", "Satyr", 2.4, HIDE,
     "a satyr with goat legs and small curled horns, playing a set of pipes"),
    ("harpy", "Harpy", 2.4, HIDE,
     "a harpy with a woman's head and torso and great feathered wings and talons"),
    ("gargoyle", "Gargoyle", 2.6, STONE,
     "a crouching stone gargoyle with bat wings folded and a snarling face"),
    ("golem_stone", "Stone Golem", 4.0, STONE,
     "a massive stone golem of stacked carved blocks with glowing runes in the joints"),
    ("golem_iron", "Iron Golem", 4.2, M("iron_rust", "iron_wrought", 0.7, 0.06),
     "a riveted iron golem with a furnace glowing in its chest and heavy fists"),
    ("treant", "Treant", 5.5, M("wood_bark", "grass_meadow", 0.8, 0.12),
     "an ancient walking tree with a face in the bark, long root legs and mossy branches"),
    ("elemental_fire", "Fire Elemental", 3.2, M("iron_rust", "iron_rust", 0.6, 0.14),
     "a roaring humanoid figure made of twisting flame with a molten core"),
    ("elemental_earth", "Earth Elemental", 3.4, STONE,
     "a lumbering elemental of packed earth and boulders with crystal shards on its back"),
    ("skeleton_warrior", "Skeleton Warrior", 2.4, BONES,
     "an animated skeleton in a rusted helm and rotted tabard with a notched sword and buckler"),
    ("skeleton_archer", "Skeleton Archer", 2.4, BONES,
     "a skeletal archer with a warped bow and a quiver of black arrows"),
    ("zombie", "Zombie", 2.4, M("leather", "bone", 0.7, 0.12),
     "a shambling rotted corpse in torn grave clothes with one arm hanging"),
    ("ghoul", "Ghoul", 2.3, M("skin_human", "bone", 0.7, 0.1),
     "a crouched pallid ghoul with long claws and a distended jaw"),
    ("lich", "Lich", 2.8, BONES,
     "a crowned lich in trailing burial robes with a skeletal face and a rune staff"),
    ("wraith", "Wraith", 2.9, M("cloth_banner", "bone", 0.8, 0.1),
     "a hooded wraith of tattered cloth with no body inside, reaching with a bony hand"),
    ("vampire", "Vampire Lord", 2.7, CLOTH,
     "a pale vampire lord in a high-collared cloak with clawed hands and fangs"),
    ("mummy", "Mummy", 2.5, M("canvas_stripe", "gold", 0.7, 0.1),
     "a bandaged mummy trailing wrappings with gold funerary ornaments"),
    ("werewolf", "Werewolf", 3.0, HIDE,
     "a hunched werewolf with a wolf's head, ragged trousers and long claws"),
    ("direwolf", "Dire Wolf", 1.9, HIDE,
     "a huge shaggy dire wolf standing on all fours, head low and snarling"),
    ("bear_cave", "Cave Bear", 2.4, HIDE,
     "an enormous brown cave bear standing on all fours with a scarred muzzle"),
    ("boar", "Great Boar", 1.6, HIDE,
     "a bristling wild boar with long curved tusks on all fours"),
    ("warhorse", "Warhorse", 2.6, HIDE,
     "an armoured destrier warhorse in a heraldic caparison and a chanfron"),
    ("mule", "Pack Mule", 1.9, HIDE,
     "a laden pack mule with panniers and rolled bundles strapped on"),
    ("goat", "Goat", 1.3, HIDE, "a shaggy mountain goat with curved horns"),
    ("cow", "Cow", 1.8, HIDE, "a standing brown and white dairy cow"),
    ("pig", "Pig", 1.2, HIDE, "a fat muddy pig standing side on"),
    ("chicken", "Chicken", 0.7, HIDE, "a speckled hen standing"),
    ("griffon", "Griffon", 3.2, HIDE,
     "a griffon with an eagle's head and forelegs and a lion's hindquarters, wings half spread"),
    ("wyvern", "Wyvern", 3.6, SCALE,
     "a two-legged wyvern with broad membrane wings and a barbed tail, crouched"),
    ("drake", "Drake", 2.8, SCALE,
     "a squat four-legged drake with a horned head and short wings"),
    ("dragon_red", "Red Dragon", 6.0, M("scale_green", "bone", 0.8, 0.08),
     "a great red dragon with spread wings, curved horns and a long spined tail"),
    ("dragon_bone", "Bone Dragon", 5.6, BONES,
     "a skeletal undead dragon with tattered wing membranes over bare bones"),
    ("basilisk", "Basilisk", 1.8, SCALE,
     "a heavy eight-legged basilisk lizard with a crested head"),
    ("serpent_giant", "Giant Serpent", 2.2, SCALE,
     "a coiled giant serpent rearing its head with a flared hood"),
    ("spider_giant", "Giant Spider", 1.8, M("fur_brown", "bone", 0.5, 0.1),
     "a bristled giant spider with eight legs braced wide and clustered eyes"),
    ("scorpion_giant", "Giant Scorpion", 1.7, SCALE,
     "a giant black scorpion with raised sting and heavy pincers"),
    ("slime", "Ooze", 1.3, M("scale_green", "scale_green", 0.6, 0.16),
     "a translucent green ooze blob with objects suspended inside it"),
    ("imp", "Imp", 1.4, M("skin_green", "leather", 0.6, 0.12),
     "a small red-skinned imp with bat wings, horns and a barbed tail"),
    ("demon_greater", "Greater Demon", 4.4, M("skin_green", "iron_rust", 0.7, 0.08),
     "a towering horned demon with cloven hooves, burning eyes and a flaming sword"),
    ("elemental_water", "Water Elemental", 3.0, M("scale_green", "stone_marble", 0.7, 0.1),
     "a rearing wave-shaped elemental of clear water with a suggestion of a face"),
    ("banshee", "Banshee", 2.7, M("cloth_banner", "bone", 0.8, 0.1),
     "a wailing banshee, a translucent woman in trailing rags with streaming hair"),
]
for item in CREATURES:
    aid, name, h, mtl, prompt = item
    spec(aid, "creature", name, prompt, height=h, material=mtl, faces=7500)

for hero in ("creature_dragon_red", "creature_giant", "creature_troll", "creature_golem_stone"):
    for entry in A:
        if entry["id"] == hero:
            entry["octree"] = 320
            entry["faces"] = 10000


if __name__ == "__main__":
    print(json.dumps(A, indent=1))
