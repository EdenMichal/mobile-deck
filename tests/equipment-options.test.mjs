// Unit tests for equipment-options.mjs (Phase 4a). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { equipmentOptions, packageContents, resolveContents, equipmentComplete, optionLabel, linkedToolIds, equipmentBookText, effectivePicks, bookCoins, startingEquipped, armorClassWith }
  from "../src/foundry/systems/dnd5e/builder/equipment-options.mjs";

const e = (_id, type, extra = {}) => ({ _id, group: null, sort: 0, type, ...extra });
const U = name => `Compendium.dnd5e.equipment24.Item.${name}`;

// Barbarian: one AND (package A) + wealth 75 (option B)
const barbarian = [
  e("and", "AND"),
  e("pack", "linked", { group: "and", sort: 1, key: U("explorer") }),
  e("axes", "linked", { group: "and", sort: 2, key: U("handaxe"), count: 4 }),
  e("gp", "currency", { group: "and", sort: 3, key: "gp", count: 15 })
];
// Fighter: OR of two ANDs + wealth 155
const fighter = [
  e("or", "OR"),
  e("a", "AND", { group: "or", sort: 1 }), e("chain", "linked", { group: "a", key: U("chain") }), e("a-gp", "currency", { group: "a", sort: 2, key: "gp", count: 4 }),
  e("b", "AND", { group: "or", sort: 2 }), e("leather", "linked", { group: "b", key: U("studded") }), e("b-gp", "currency", { group: "b", sort: 2, key: "gp", count: 11 })
];
// Monk: AND with a nested OR of two categories; Druid: one-child OR
const monk = [
  e("and", "AND"),
  e("spear", "linked", { group: "and", sort: 1, key: U("spear") }),
  e("tools", "OR", { group: "and", sort: 2 }),
  e("art", "tool", { group: "tools", sort: 1, key: "art" }),
  e("music", "tool", { group: "tools", sort: 2, key: "music" })
];
const druid = [e("and", "AND"), e("one", "OR", { group: "and", sort: 1 }), e("staff", "linked", { group: "one", key: U("staff") })];
const bard = [e("and", "AND"), e("inst", "tool", { group: "and", key: "music" }), e("gp", "currency", { group: "and", sort: 2, key: "gp", count: 19 })];

test("single AND + wealth gives A (package) and B (gold)", () => {
  const options = equipmentOptions(barbarian, "75");
  assert.deepEqual(options.map(o => [o.id, o.kind]), [["A", "package"], ["B", "gold"]]);
  assert.equal(options[1].gp, 75);
  const c = packageContents(barbarian, options[0]);
  assert.deepEqual(c.items.map(i => [i.uuid, i.count]), [[U("explorer"), 1], [U("handaxe"), 4]]);
  assert.deepEqual(c.coins, { gp: 15 });
});

test("Fighter: an OR of two packages + wealth gives A, B, C", () => {
  const options = equipmentOptions(fighter, "155");
  assert.deepEqual(options.map(o => o.id), ["A", "B", "C"]);
  assert.deepEqual(packageContents(fighter, options[1]).coins, { gp: 11 });
  assert.equal(options[2].gp, 155);
});

test("top-level entries stored with group \"\" (dnd5e 5.3.2 source) count as top level", () => {
  const blank = fighter.map(x => ({ ...x, group: x.group ?? "" }));
  assert.deepEqual(equipmentOptions(blank, "155").map(o => [o.id, o.kind]), [["A", "package"], ["B", "package"], ["C", "gold"]]);
  assert.deepEqual(packageContents(blank, equipmentOptions(blank, "155")[0]).coins, { gp: 4 });
});

test("no wealth: no gold card; a wealth formula keeps its formula", () => {
  assert.deepEqual(equipmentOptions(barbarian, "").map(o => o.id), ["A"]);
  const f = equipmentOptions(barbarian, "5d4 * 10");
  assert.equal(f[1].gp, null);
  assert.equal(f[1].formula, "5d4 * 10");
  assert.deepEqual(equipmentOptions([], "50").map(o => o.kind), ["gold"]);
});

test("one-child OR collapses into a fixed item", () => {
  const c = packageContents(druid, equipmentOptions(druid, "50")[0]);
  assert.deepEqual(c.items.map(i => i.uuid), [U("staff")]);
  assert.equal(c.choices.length, 0);
});

test("nested OR is a choice; resolving it adds the chosen pick", () => {
  const option = equipmentOptions(monk, "50")[0];
  const c = packageContents(monk, option);
  assert.equal(c.choices.length, 1);
  assert.deepEqual(c.choices[0].options.map(o => o.id), ["art", "music"]);
  assert.deepEqual(resolveContents(monk, option, {}).unresolved, ["tools"]);
  const r = resolveContents(monk, option, { choices: { tools: "music" } });
  assert.deepEqual(r.picks.map(p => [p.type, p.key]), [["tool", "music"]]);
  assert.equal(equipmentComplete(monk, option, { choices: { tools: "music" } }), false); // instrument not picked yet
  assert.equal(equipmentComplete(monk, option, { choices: { tools: "music" }, picks: { music: U("lute") } }), true);
});

test("complete: gold always; a package needs its picks", () => {
  const [a, b] = equipmentOptions(bard, "90");
  assert.equal(equipmentComplete(bard, b, {}), true);
  assert.equal(equipmentComplete(bard, a, {}), false);
  assert.equal(equipmentComplete(bard, a, { picks: { inst: U("lute") } }), true);
  assert.equal(equipmentComplete(bard, null, {}), false);
});

test("labels read like the book", () => {
  const names = { [U("explorer")]: "Explorer's Pack", [U("handaxe")]: "Handaxe", [U("spear")]: "Spear" };
  const nameOf = uuid => names[uuid] ?? "?";
  const [a, b] = equipmentOptions(barbarian, "75");
  assert.equal(optionLabel(barbarian, a, { nameOf }), "Explorer's Pack, 4× Handaxe, 15 GP");
  assert.equal(optionLabel(barbarian, b, { nameOf }), "75 GP");
  const monkA = equipmentOptions(monk, "50")[0];
  assert.equal(optionLabel(monk, monkA, { nameOf, categoryOf: p => `any ${p.key}` }), "Spear, (any art or any music)");
});

test("tool picks follow the proficiencies chosen from the same item", () => {
  assert.deepEqual(linkedToolIds(["skills:ath", "tool:music:lute", "tool:music:flute", "tool:game:dice"], "music"), ["lute", "flute"]);
  assert.deepEqual(linkedToolIds(["tool:game:*"], "game"), []);
  assert.deepEqual(linkedToolIds(["tool:music:lute"], ""), []);
});

test("book text: the item's own equipment line", () => {
  const acolyte = "<p><strong>Ability Scores:</strong> Intelligence</p><p><strong>Equipment:</strong> Choose A or B: (A) @UUID[Compendium.x.y.Item.z]{Calligrapher's Supplies}, Robe, 8 GP; or (B) 50 GP</p>";
  assert.equal(equipmentBookText(acolyte), "Equipment: Choose A or B: (A) Calligrapher's Supplies, Robe, 8 GP; or (B) 50 GP");
  const table = "<table><tr><td>Starting Equipment</td><td>Choose A or B: (A) Greataxe; or (B) 75 GP</td></tr></table>";
  assert.equal(equipmentBookText(table), "Starting Equipment Choose A or B: (A) Greataxe; or (B) 75 GP");
  assert.equal(equipmentBookText("<p>No gear here</p>"), "");
});

test("effective picks: a stale saved pick is dropped; a lone candidate fills itself; the rest stay open", () => {
  const cand = (...names) => names.map(n => ({ uuid: U(n) }));
  // Equipment filled first (any instrument → Lute), then the class proficiencies became Bagpipes/Drum/Flute.
  const stale = effectivePicks({ option: "A", picks: { inst: U("lute") } }, [{ id: "inst", candidates: cand("bagpipes", "drum", "flute") }]);
  assert.deepEqual(stale.picks, {});
  assert.equal(stale.option, "A");
  const kept = effectivePicks({ picks: { inst: U("drum") } }, [{ id: "inst", candidates: cand("bagpipes", "drum") }]);
  assert.deepEqual(kept.picks, { inst: U("drum") });
  // Stale but exactly one candidate now: the lone candidate, not the stale pick.
  const lone = effectivePicks({ picks: { inst: U("lute") } }, [{ id: "inst", candidates: cand("flute") }]);
  assert.deepEqual(lone.picks, { inst: U("flute") });
  assert.deepEqual(effectivePicks({}, [{ id: "inst", candidates: [] }]).picks, {});
});

test("book coins: by option letter, SRD and DDB text, any case, thousands; unlettered lines count for the one package", () => {
  assert.deepEqual(bookCoins("Equipment: Choose A or B: (A) Spear, Shortbow, 20 Arrows, Gaming Set (same as above), Healer's Kit, Quiver, Traveler's Clothes, 14 GP; or (B) 50 GP"),
    { A: { gp: 14 }, B: { gp: 50 } });
  assert.deepEqual(bookCoins("Equipment: Choose A or B: (A) Book (prayers), Parchment (10 sheets), Robe, 8 gp, 5 sp; or (B) 1,000 GP"), { A: { gp: 8, sp: 5 }, B: { gp: 1000 } });
  assert.deepEqual(bookCoins("Equipment: A holy symbol, 5 sticks of incense, vestments, and a pouch containing 15 gp."), { "": { gp: 15 } });
  assert.deepEqual(bookCoins("Equipment: 2 Daggers, Crowbar"), {});
  // Only the amount an option ends with: not coins inside an item's own description.
  assert.deepEqual(bookCoins("Equipment: Choose A or B: (A) Calligrapher's Supplies, a Gem worth 10 GP, Robe, 8 GP; or (B) 50 GP"), { A: { gp: 8 }, B: { gp: 50 } });
  assert.deepEqual(bookCoins("Equipment: (A) Ink (1-ounce bottle worth 10 gp), 5 GP; or (B) 50 GP"), { A: { gp: 5 }, B: { gp: 50 } });
  assert.deepEqual(bookCoins("Equipment: (A) a Trinket worth 25 GP; or (B) 50 GP"), { B: { gp: 50 } });
  assert.deepEqual(bookCoins(""), {});
});

test("a background with no currency entry takes option A's gold from its book text, and the card names it", () => {
  // Soldier (dnd5e.origins24): package A without coins, wealth 50.
  const soldier = [e("and", "AND"), e("spear", "linked", { group: "and", key: U("spear") }), e("clothes", "linked", { group: "and", sort: 2, key: U("clothes") })];
  const bookText = equipmentBookText("<p><strong>Equipment:</strong> <em>Choose A or B:</em> (A) @UUID[Compendium.dnd5e.equipment24.Item.phbwepSpear00000]{Spear}, @UUID[Compendium.dnd5e.items.Item.SsAm]{Traveler's Clothes}, 14 GP; or (B) 50 GP</p>");
  const options = equipmentOptions(soldier, "50", { bookText });
  assert.deepEqual(options.map(o => [o.id, o.kind, o.coins ?? null]), [["A", "package", { gp: 14 }], ["B", "gold", null]]);
  assert.deepEqual(packageContents(soldier, options[0]).coins, { gp: 14 });
  assert.deepEqual(resolveContents(soldier, options[0], {}).coins, { gp: 14 });
  const names = { [U("spear")]: "Spear", [U("clothes")]: "Traveler's Clothes" };
  assert.equal(optionLabel(soldier, options[0], { nameOf: u => names[u] }), "Spear, Traveler's Clothes, 14 GP");
  // A class that stores its coins as entries ignores the text; a 2014 line without letters goes to the one package.
  assert.equal(equipmentOptions(barbarian, "75", { bookText: "(A) Greataxe, 15 GP; or (B) 75 GP" })[0].coins, undefined);
  assert.deepEqual(packageContents(barbarian, equipmentOptions(barbarian, "75", { bookText: "(A) Greataxe, 15 GP; or (B) 75 GP" })[0]).coins, { gp: 15 });
  assert.deepEqual(equipmentOptions(soldier, "", { bookText: "Equipment: A holy symbol and a pouch containing 15 gp." })[0].coins, { gp: 15 });
  assert.equal(equipmentOptions(soldier, "50")[0].coins, undefined);
});

test("starting gear worn: the best trained armor, a trained shield, every weapon; packed items stay packed", () => {
  const armor = (type, value, dex) => ({ type: "equipment", system: { type: { value: type }, armor: { value, dex } } });
  const items = [
    { type: "weapon", system: {} },                       // 0 greatsword
    armor("heavy", 16, 0),                                // 1 chain mail
    armor("light", 11, null),                             // 2 leather
    armor("shield", 2, null),                             // 3 shield
    { type: "weapon", system: { container: "pack" } },    // 4 a dagger inside a pack
    { type: "equipment", system: { type: { value: "clothing" }, armor: { value: 0 } } } // 5 clothes
  ];
  assert.deepEqual(startingEquipped(items, { dexMod: 1 }), [0, 1, 3]);
  // Leather with DEX +3 (14) beats medium scale (14 + 2 = 16)? No: medium caps DEX at 2 → 16 > 14.
  assert.deepEqual(startingEquipped([armor("light", 11, null), armor("medium", 14, 2)], { dexMod: 3 }), [1]);
  // Untrained: no heavy armor and no shield, the weapon still in hand.
  const trained = new Set(["light"]);
  assert.deepEqual(startingEquipped(items, { dexMod: 3, proficient: i => trained.has(i.system.type.value) }), [0, 2]);
  assert.deepEqual(startingEquipped([], {}), []);
});

test("worn gear: heavy armor ignores DEX, Strength requirements, Unarmored Defense, shields and two-handed weapons", () => {
  const armor = (type, value, dex, strength = 0) => ({ type: "equipment", system: { type: { value: type }, armor: { value, dex }, strength } });
  const weapon = (...props) => ({ type: "weapon", system: { properties: props } });
  assert.equal(armorClassWith(armor("heavy", 16, 0), -1), 16, "heavy armor: no DEX, not even a penalty");
  assert.equal(armorClassWith(armor("medium", 14, 2), -1), 13);
  // Chain Mail needs STR 13: with STR 10 the leather is worn instead.
  assert.deepEqual(startingEquipped([armor("heavy", 16, 0, 13), armor("light", 11, null)], { dexMod: 1, strength: 10 }), [1]);
  assert.deepEqual(startingEquipped([armor("heavy", 16, 0, 13), armor("light", 11, null)], { dexMod: 1, strength: 13 }), [0]);
  // Barbarian (DEX +2, CON +3 → 15) keeps Hide (14) off but may use a shield; a Monk uses neither.
  const kit = [armor("medium", 12, 2), armor("shield", 2, null), weapon()];
  assert.deepEqual(startingEquipped(kit, { dexMod: 2, unarmored: { ac: 15, shield: true } }), [1, 2]);
  assert.deepEqual(startingEquipped(kit, { dexMod: 2, unarmored: { ac: 15, shield: false } }), [2]);
  assert.deepEqual(startingEquipped(kit, { dexMod: 2, unarmored: { ac: 13, shield: false } }), [0, 1, 2], "armor that beats it is worn");
  // A shield never goes with a two-handed weapon: with a one-handed weapon too, shield + that weapon; else no shield.
  assert.deepEqual(startingEquipped([weapon("two", "hvy"), armor("shield", 2, null)]), [0]);
  assert.deepEqual(startingEquipped([weapon("two", "hvy"), weapon("ver"), armor("shield", 2, null)]), [1, 2]);
  assert.deepEqual(startingEquipped([weapon("two", "hvy"), weapon("ver")]), [0, 1], "no shield: every weapon");
});
