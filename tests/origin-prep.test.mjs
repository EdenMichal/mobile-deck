// Unit tests for origin-prep.mjs and the DDB / homebrew edition rules (creation stage A), on documents shaped like a
// DDB Importer and homebrew world-pack export, with invented text (tests/fixtures/origin-samples.json).
// Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { backgroundAbilities, backgroundAsiAdvancement, backgroundHasAsi, BACKGROUND_ASI_ID, prepareOriginItem, repairTraitKey, speciesSenses, trinketTableUuid, canonicalTraitKeys }
  from "../src/foundry/systems/dnd5e/builder/origin-prep.mjs";
import { allowEntry, ddbRules, dedupe, entryRules, rulesFromBook } from "../src/foundry/systems/dnd5e/builder/source-filter.mjs";

const fx = JSON.parse(readFileSync(new URL("./fixtures/origin-samples.json", import.meta.url), "utf8"));
const named = (list, name, book) => structuredClone(fx[list].find(x => x.name === name && (!book || x.system.source.book === book)));

test("DDB 2024 background: the 'Ability Scores:' line names its three abilities", () => {
  assert.deepEqual(backgroundAbilities(named("backgrounds", "Noble", "PHB 2024").system.description.value), ["str", "int", "cha"]);
  assert.deepEqual(backgroundAbilities(named("backgrounds", "Sailor", "PHB 2024").system.description.value), ["str", "dex", "wis"]);
  assert.equal(backgroundAbilities(named("backgrounds", "Night Stalker").system.description.value), null, "TCMP1 lists none");
  assert.deepEqual(backgroundAbilities("<p><strong>Ability Scores:</strong> Int, Wis, Cha</p>"), ["int", "wis", "cha"]);
  assert.deepEqual(backgroundAbilities("<p>Ability Scores: Force, Sagesse</p>", { str: "Force", wis: "Sagesse" }), ["str", "wis"]);
  assert.equal(backgroundAbilities("<p><strong>Ability Score Improvement:</strong> Strength, Dexterity, Constitution</p>"), null, "not an ASI feature line");
  assert.equal(backgroundAbilities("<p>Ability Score Increase. Your Strength increases by 2.</p>"), null);
  assert.equal(backgroundAbilities("<p>Ability Scores Strength, Wisdom</p>"), null, "the colon is required");
});

test("a 2024 background without an increase gets the SRD step: 3 points, max 2 per ability, only its three abilities", () => {
  const noble = named("backgrounds", "Noble", "PHB 2024");
  const asi = backgroundAsiAdvancement(noble);
  assert.equal(asi._id, BACKGROUND_ASI_ID);
  assert.equal(asi.type, "AbilityScoreImprovement");
  assert.deepEqual([asi.configuration.points, asi.configuration.cap, asi.level], [3, 2, 0]);
  assert.deepEqual(asi.configuration.locked, ["dex", "con", "wis"]);
  assert.match(asi.hint, /Strength, Intelligence, or Charisma by 2/);
  // Same shape as an RtHW background that has its own step (Investigator: Intelligence, Wisdom, Charisma).
  const own = Object.values(named("backgrounds", "Investigator").system.advancement).find(a => a.type === "AbilityScoreImprovement");
  assert.deepEqual([own.configuration.points, own.configuration.cap], [asi.configuration.points, asi.configuration.cap]);
  const prepared = prepareOriginItem(noble);
  assert.equal(Object.values(prepared.system.advancement).filter(a => a.type === "AbilityScoreImprovement").length, 1);
  assert.equal(prepareOriginItem(prepared).system.advancement[BACKGROUND_ASI_ID].configuration.locked.length, 3, "idempotent");
});

test("no step added: a background with its own, a 2014 background; TCMP1 (none listed) offers any ability", () => {
  assert.equal(backgroundAsiAdvancement(named("backgrounds", "Investigator")), null);
  assert.equal(backgroundAsiAdvancement(named("backgrounds", "Urchin", "PHB")), null);
  assert.equal(backgroundHasAsi(named("backgrounds", "Urchin", "PHB")), false);
  const any = backgroundAsiAdvancement(named("backgrounds", "Night Stalker"));
  assert.deepEqual(any.configuration.locked, []);
  assert.match(any.hint, /doesn't name/);
  assert.equal(backgroundHasAsi(named("backgrounds", "Night Stalker")), true);
  assert.equal(backgroundAsiAdvancement(named("species", "Goliath")), null, "species are never given one");
});

test("DDB's doubled trait keys are repaired: 2024 species grant Common again", () => {
  assert.equal(repairTraitKey("languages:languages:standard:common"), "languages:standard:common");
  assert.equal(repairTraitKey("languages:standard:*"), "languages:standard:*");
  assert.equal(repairTraitKey("skills:ste"), "skills:ste");
  const goliath = prepareOriginItem(named("species", "Goliath"));
  const langs = Object.values(goliath.system.advancement).find(a => a.type === "Trait" && a.title === "Languages");
  assert.deepEqual(langs.configuration.grants, ["languages:standard:common"]);
  assert.deepEqual(langs.configuration.choices[0].pool, ["languages:standard:*"]);
});

test("editions: DDB species have no source.rules; their importer flags (else a 2024-only book) decide", () => {
  const goliath = named("species", "Goliath");
  const shadar = named("species", "Shadar-kai");
  assert.equal(goliath.system.source.rules, "");
  assert.equal(ddbRules(goliath), "2024");
  assert.equal(entryRules(goliath, {}), "2024");
  assert.equal(entryRules(shadar, {}), "2014");
  assert.equal(entryRules({ system: { source: { book: "FRHoF", rules: "" } } }, {}), "2024");
  assert.equal(entryRules({ system: { source: { book: "PHB", rules: "" } } }, {}), "", "PHB mixes editions: unknown, stays visible");
  assert.equal(entryRules({ system: { source: { book: "TCMP1" } } }, { rules: "2014" }), "2014", "the GM's pack tag outranks a book guess");
  assert.equal(entryRules(goliath, { rules: "2014" }), "2014", "…and DDB's flags: the GM's explicit tag comes first");
  assert.equal(entryRules({ ...goliath, system: { ...goliath.system, source: { ...goliath.system.source, rules: "2024" } } }, { rules: "2014" }), "2024", "the item's own rules come first of all");
  assert.equal(rulesFromBook("Some Book 2024"), "2024");
  const pack = { enabled: true, priority: 30, rules: "" };
  assert.equal(allowEntry(goliath, pack, { rules: "world" }, "2024"), true);
  assert.equal(allowEntry(shadar, pack, { rules: "world" }, "2024"), false, "2014 species hidden in a 2024 world");
  assert.equal(allowEntry(shadar, pack, { rules: "both" }, "2024"), true);
});

test("duplicates: the SRD and DDB copies of a 2024 background are one card, from the higher-priority pack", () => {
  const srd = { entry: { type: "background", name: "Noble", system: { source: { book: "SRD 5.2", rules: "2024" } } }, pack: { collection: "dnd5e.origins24", priority: 10 } };
  const ddb = { entry: named("backgrounds", "Noble", "PHB 2024"), pack: { collection: "world.books-copy-ddb-backgrounds", priority: 30 } };
  const old = { entry: { type: "background", name: "Noble", system: { source: { book: "SRD 5.1", rules: "2014" } } }, pack: ddb.pack };
  assert.deepEqual(dedupe([srd, ddb, old]).map(c => c.entry.system.source.book), ["PHB 2024", "SRD 5.1"]);
});

test("a background's own trinket table, from its description links", () => {
  assert.equal(trinketTableUuid(named("backgrounds", "Night Stalker").system.description.value), "Compendium.world.ddb-campaign-ddb-tables.RollTable.GmvkvtpBNGHmeKe2");
  assert.equal(trinketTableUuid(named("backgrounds", "Urchin", "PHB").system.description.value), "");
});

test("DDB class wealth: dice formulas, a flat amount, or none (Artificer EFA) give the right gold card", async () => {
  const { equipmentOptions, optionLabel } = await import("../src/foundry/systems/dnd5e/builder/equipment-options.mjs");
  const byName = Object.fromEntries(fx.classWealth.map(c => [`${c.name}|${c.book}`, c.wealth]));
  const gold = wealth => equipmentOptions([], wealth).find(o => o.kind === "gold") ?? null;
  const fighter = gold(byName["Fighter|PHB 2024"]);
  assert.deepEqual([fighter.formula, fighter.gp], ["5d4 * 10", null], "rolled once, then kept");
  assert.equal(optionLabel([], fighter), "5d4 × 10 GP");
  assert.deepEqual([gold(byName["Monk|PHB 2024"]).formula, gold(byName["Monk|PHB 2024"]).gp], ["5d4", null]);
  assert.equal(gold(byName["Gunslinger|Shattered Coast (Homebrew, Gunslinger v1)"]).gp, 175);
  assert.equal(gold(byName["Artificer|Eberron: Forge of the Artificer (Imported Stock)"]), null);
  assert.equal(gold(byName["Artificer (STUB)|STUB"]), null, "no wealth at all");
});

test("TCMP1 background: no stored equipment; the book's coins-only option stays, the rest is text", async () => {
  const { equipmentOptions, equipmentBookText, bookGoldOptions } = await import("../src/foundry/systems/dnd5e/builder/equipment-options.mjs");
  const stalker = named("backgrounds", "Night Stalker");
  const bookText = equipmentBookText(stalker.system.description.value);
  assert.match(bookText, /\(B\) 50 GP/);
  assert.deepEqual(bookGoldOptions(bookText), [{ letter: "B", gp: 50 }]);
  assert.deepEqual(equipmentOptions(stalker.system.startingEquipment, stalker.system.wealth ?? "", { bookText }).map(o => [o.kind, o.gp]), [["gold", 50]]);
  assert.deepEqual(equipmentOptions([], "", { bookText: "" }), [], "nothing at all: no cards (the section is complete and says so)");
  // A DDB 2024 background stores its coins as entries (Noble: A 29 GP, B 50 GP), so the text isn't read.
  const noble = named("backgrounds", "Noble", "PHB 2024");
  const options = equipmentOptions(noble.system.startingEquipment, noble.system.wealth ?? "", { bookText: equipmentBookText(noble.system.description.value) });
  assert.deepEqual(options.map(o => [o.id, o.kind, o.coins ?? null]), [["A", "package", null], ["B", "package", null]]);
});

test("DDB 2024 species languages: Common (repaired) plus a standard-language choice the any-language rule widens", async () => {
  const { isLanguagePool } = await import("../src/foundry/systems/dnd5e/builder/trait-options.mjs");
  for (const name of ["Goliath", "Graveborn"]) {
    const langs = Object.values(prepareOriginItem(named("species", name)).system.advancement).find(a => a.type === "Trait" && a.title === "Languages");
    assert.deepEqual(langs.configuration.grants, ["languages:standard:common"], name);
    assert.ok(langs.configuration.choices.every(c => isLanguagePool(c.pool)), name);
  }
  // A DDB 2024 background has no language step: nothing to add or ask.
  assert.ok(!Object.values(named("backgrounds", "Noble", "PHB 2024").system.advancement).some(a => a.type === "Trait"
    && [...a.configuration.grants, ...a.configuration.choices.flatMap(c => c.pool)].some(k => k.startsWith("languages:"))));
});

test("DDB species store no senses: the ones their text gives for good are filled in (not a bonus action's)", () => {
  const dwarf = named("species", "Dwarf");
  assert.equal(dwarf.system.senses.ranges.darkvision, null);
  assert.deepEqual(speciesSenses(dwarf.system.description.value, dwarf.name), { darkvision: 120 }, "Stonecunning's Tremorsense is for 10 minutes");
  assert.equal(prepareOriginItem(dwarf).system.senses.ranges.darkvision, 120);
  assert.deepEqual(speciesSenses(named("species", "Wood Elf").system.description.value, "Wood Elf"), { darkvision: 60 });
  assert.deepEqual(speciesSenses(named("species", "Elf (Drow)").system.description.value, "Elf (Drow)"), { darkvision: 120 }, "the Drow row applies to the Drow");
  const stored = named("species", "Dwarf");
  stored.system.senses.ranges.darkvision = 60;
  assert.equal(prepareOriginItem(stored).system.senses.ranges.darkvision, 60, "a stored range wins");
  assert.deepEqual(speciesSenses("<p>No senses here.</p>"), {});
});

test("a trait key that skips its category (a homebrew class's \"tool:alchemist\") is rewritten to dnd5e's full key", async () => {
  const keys = { tool: new Set(["tool:art:alchemist", "tool:art:smith", "tool:game:dice", "tool:thief"]), skills: new Set(["skills:ste"]) };
  const data = { system: { advancement: { a: { type: "Trait", configuration: { grants: ["tool:alchemist", "tool:thief", "skills:ste", "tool:art:*"],
    choices: [{ count: 1, pool: ["tool:smith", "tool:unknown"] }] } } } } };
  assert.equal(await canonicalTraitKeys(data, async trait => keys[trait]), 2);
  assert.deepEqual(data.system.advancement.a.configuration.grants, ["tool:art:alchemist", "tool:thief", "skills:ste", "tool:art:*"]);
  assert.deepEqual(data.system.advancement.a.configuration.choices[0].pool, ["tool:art:smith", "tool:unknown"]);
});

test("senses: only for good, from a sentence starting 'You have'; a lineage row by its whole label", () => {
  assert.deepEqual(speciesSenses("<p><strong>Darkvision.</strong> You have Darkvision with a range of 60 feet.</p>"), { darkvision: 60 });
  assert.deepEqual(speciesSenses("<p>Darkvision: You have Darkvision with a range of 60 feet.</p>"), { darkvision: 60 }, "a trait label with a colon");
  assert.deepEqual(speciesSenses("<p>Echo Sense: You have Blindsight with a range of 10 feet for 1 minute.</p>"), {}, "still not a temporary one");
  // Beast form and a 1-minute sense are not the species' own.
  assert.deepEqual(speciesSenses("<p>While you are in your beast form, you have Darkvision with a range of 60 feet.</p>"), {});
  assert.deepEqual(speciesSenses("<p>Shifting. You have Darkvision with a range of 60 feet while you are shifted.</p>"), {});
  assert.deepEqual(speciesSenses("<p>Echo Sense. As a Bonus Action you focus. You have Blindsight with a range of 10 feet for 1 minute.</p>"), {});
  const table = "<p>You have Darkvision with a range of 60 feet.</p><table><tr><td>High Elf</td><td>The range of your Darkvision increases to 90 feet.</td></tr>"
    + "<tr><td>Wood Elf</td><td>The range of your Darkvision increases to 120 feet.</td></tr></table>";
  assert.deepEqual(speciesSenses(table, "Wood Elf"), { darkvision: 120 });
  assert.deepEqual(speciesSenses(table, "High Elf"), { darkvision: 90 });
  assert.deepEqual(speciesSenses(table, "Elf"), { darkvision: 60 }, "a row labelled \"Wood Elf\" isn't any Elf's");
});
