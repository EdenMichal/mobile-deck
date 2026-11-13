// Unit tests for the level 1 → 20 fixes (L20 campaign). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { featSpellRule, landSpellsFor, owedSpells, spellListKeys, SPELL_TABLES, swapsOnRest, tableCounts } from "../src/foundry/systems/dnd5e/builder/spell-rules.mjs";
import { alignAnswers, displayTitle, droppedPicks, missingName, replaceableItems } from "../src/foundry/systems/dnd5e/builder/advancement-driver.mjs";
import { asiAnswerProblems } from "../src/foundry/systems/dnd5e/builder/asi-math.mjs";
import { backgroundList } from "../src/foundry/systems/dnd5e/builder/spell-choice.mjs";
import { decodeEntities, hpExtras, reviewChanges } from "../src/foundry/systems/dnd5e/builder/review-diff.mjs";
import { isResistancePool, withHeldResistances } from "../src/foundry/systems/dnd5e/builder/trait-options.mjs";
import { dataWarningsFor } from "../src/foundry/systems/dnd5e/builder/data-checks.mjs";

test("2024 tables: the eight core casters match dnd5e 5.3.2's classes24 scale values", () => {
  // From dnd5e's own data (max-prepared and Cantrips Known scales), level by level.
  const scale = values => Array.from({ length: 20 }, (_, i) => { let v = 0; for (const [l, n] of Object.entries(values)) if (i + 1 >= Number(l)) v = n; return v; });
  const full = scale({ 1: 4, 2: 5, 3: 6, 4: 7, 5: 9, 6: 10, 7: 11, 8: 12, 9: 14, 10: 15, 11: 16, 13: 17, 15: 18, 17: 19, 18: 20, 19: 21, 20: 22 });
  assert.deepEqual(SPELL_TABLES.bard.prepared, full);
  assert.deepEqual(SPELL_TABLES.cleric.prepared, full);
  assert.deepEqual(SPELL_TABLES.druid.prepared, full);
  assert.deepEqual(SPELL_TABLES.sorcerer.prepared, scale({ 1: 2, 2: 4, 3: 6, 4: 7, 5: 9, 6: 10, 7: 11, 8: 12, 9: 14, 10: 15, 11: 16, 13: 17, 15: 18, 17: 19, 18: 20, 19: 21, 20: 22 }));
  assert.deepEqual(SPELL_TABLES.wizard.prepared, scale({ 1: 4, 2: 5, 3: 6, 4: 7, 5: 9, 6: 10, 7: 11, 8: 12, 9: 14, 10: 15, 11: 16, 13: 17, 14: 18, 15: 19, 16: 21, 17: 22, 18: 23, 19: 24, 20: 25 }));
  assert.deepEqual(SPELL_TABLES.warlock.prepared, scale({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 9: 10, 11: 11, 13: 12, 15: 13, 17: 14, 19: 15 }));
  const half = scale({ 1: 2, 2: 3, 3: 4, 4: 5, 5: 6, 7: 7, 9: 9, 11: 10, 13: 11, 15: 12, 17: 14, 19: 15 });
  assert.deepEqual(SPELL_TABLES.paladin.prepared, half);
  assert.deepEqual(SPELL_TABLES.ranger.prepared, half);
  assert.deepEqual(SPELL_TABLES.cleric.cantrips, scale({ 1: 3, 4: 4, 10: 5 }));
  assert.deepEqual(SPELL_TABLES.sorcerer.cantrips, scale({ 1: 4, 4: 5, 10: 6 }));
  assert.deepEqual(SPELL_TABLES.wizard.cantrips, scale({ 1: 3, 4: 4, 10: 5 }));
  assert.deepEqual(SPELL_TABLES.paladin.cantrips, scale({}));
});

test("third casters (Eldritch Knight, Arcane Trickster) fall back to the 2024 subclass table", () => {
  assert.deepEqual(tableCounts("fighter", "eldritch-knight", 2), { cantrips: 0, prepared: 0 });
  assert.deepEqual(tableCounts("fighter", "eldritch-knight", 3), { cantrips: 2, prepared: 3 });
  assert.deepEqual(tableCounts("fighter", "eldritch-knight", 10), { cantrips: 3, prepared: 7 });
  assert.deepEqual(tableCounts("fighter", "eldritch-knight", 20), { cantrips: 3, prepared: 13 });
  assert.deepEqual(tableCounts("rogue", "arcane-trickster", 3), { cantrips: 3, prepared: 3 }, "Mage Hand + 2");
  assert.deepEqual(tableCounts("rogue", "arcane-trickster", 10), { cantrips: 4, prepared: 7 });
  assert.deepEqual(tableCounts("rogue", "arcane-trickster", 19), { cantrips: 4, prepared: 12 });
  assert.equal(tableCounts("homebrew", "", 5), null, "a class the tables don't know gets no fallback");
  // The level-3 Arcane Trickster: Mage Hand counts as known, so 2 picks and 3 prepared, and a spell swap later.
  const at3 = owedSpells({ identifier: "rogue", subclass: "arcane-trickster", levelsBefore: 2, levelsAfter: 3, before: { maxPrepared: 0 },
    after: { cantrips: 3, maxPrepared: 3, maxSpellLevel: 1 }, current: { cantrips: 1, prepared: 0, leveled: 0 } });
  assert.deepEqual([at3.cantrips, at3.prepared, at3.swapSpell, at3.hasStep], [2, 3, false, true]);
  const ek8 = owedSpells({ identifier: "fighter", subclass: "eldritch-knight", levelsBefore: 7, levelsAfter: 8, before: { maxPrepared: 5 },
    after: { cantrips: 2, maxPrepared: 6, maxSpellLevel: 2 }, current: { cantrips: 2, prepared: 5, leveled: 5 } });
  assert.deepEqual([ek8.prepared, ek8.swapSpell, ek8.swapCantrip], [1, true, true], "EK swaps a spell on every Fighter level");
});

test("spell lists: subclass casters use the Wizard list; Bard 10+ adds Magical Secrets' lists", () => {
  assert.deepEqual(spellListKeys({ identifier: "fighter", subclass: "eldritch-knight", levels: 3 }), ["class:wizard"]);
  assert.deepEqual(spellListKeys({ identifier: "rogue", subclass: "arcane-trickster", levels: 20 }), ["class:wizard"]);
  assert.deepEqual(spellListKeys({ identifier: "bard", subclass: "lore", levels: 9 }), ["class:bard"]);
  assert.deepEqual(spellListKeys({ identifier: "bard", levels: 10 }), ["class:bard", "class:cleric", "class:druid", "class:wizard"]);
  assert.deepEqual(spellListKeys({ identifier: "cleric", levels: 20 }), ["class:cleric"]);
  assert.equal(swapsOnRest("ranger"), true);
  assert.equal(swapsOnRest("paladin"), true);
  assert.equal(swapsOnRest("sorcerer"), false);
});

test("Circle of the Land spells follow the Druid's highest spell level", () => {
  const arid = [{ key: "fire-bolt", level: 0 }, { key: "blur", level: 2 }, { key: "burning-hands", level: 1 }, { key: "fireball", level: 3 },
    { key: "blight", level: 4 }, { key: "wall-of-stone", level: 5 }];
  assert.deepEqual(landSpellsFor(arid, 1).map(s => s.key), [], "no circle spells before Druid 3");
  assert.deepEqual(landSpellsFor(arid, 2).map(s => s.key), ["fire-bolt", "blur", "burning-hands"]);
  assert.deepEqual(landSpellsFor(arid, 3).map(s => s.key), ["fire-bolt", "blur", "burning-hands", "fireball"]);
  assert.equal(landSpellsFor(arid, 9).length, 6);
});

test("feats whose spells have no advancement", () => {
  assert.deepEqual(featSpellRule("magic-initiate-wizard"), { list: "wizard", cantrips: 2, spells: 1, ability: "int" });
  assert.equal(featSpellRule("magic-initiate-cleric").ability, "wis");
  assert.deepEqual(featSpellRule("fey-touched").fixed, ["misty-step"]);
  assert.deepEqual(featSpellRule("fey-touched").schools, ["div", "enc"]);
  assert.deepEqual(featSpellRule("shadow-touched").fixed, ["invisibility"]);
  assert.equal(featSpellRule("telekinetic").warnOnly, true);
  assert.equal(featSpellRule("ritual-caster-wizard").warnOnly, true);
  assert.equal(featSpellRule("grappler"), null);
});

test("answers are matched to steps by key, not position (a species step added before the class's)", () => {
  const a = key => ({ key, data: { key } });
  // Saved: class skill, class expertise. A species grant now comes first.
  const answers = [a("class|skills|1"), a("class|expertise|1")];
  alignAnswers(answers, 0, "species|spells|1");
  assert.deepEqual(answers.map(x => x?.key ?? null), [null, "class|skills|1", "class|expertise|1"], "a hole, the class answers kept");
  alignAnswers(answers, 1, "class|skills|1");
  alignAnswers(answers, 2, "class|expertise|1");
  assert.deepEqual(answers.map(x => x?.key ?? null), [null, "class|skills|1", "class|expertise|1"]);
  // An answer further on moves up to its step; a removed step's answer drifts to the end.
  const moved = [a("gone|1"), a("b|1")];
  alignAnswers(moved, 0, "b|1");
  assert.deepEqual(moved.map(x => x?.key ?? null), ["b|1", "gone|1"]);
  const hole = [null, a("c|1")];
  alignAnswers(hole, 0, "c|1");
  assert.deepEqual(hole.map(x => x?.key ?? null), ["c|1"]);
});

test("replacement: earlier picks still on the copy; picks dnd5e dropped", () => {
  const items = new Map([["inv1", {}], ["inv2", {}]]);
  const adv = { actor: { items: { get: id => items.get(id) } }, constructor: { typeName: "ItemChoice" },
    value: { added: { 1: { inv1: "Compendium.x.Item.pact" }, 2: { inv2: "Compendium.x.Item.agon", gone: "Compendium.x.Item.lost" }, 3: { new: "Compendium.x.Item.new" } } } };
  assert.deepEqual(replaceableItems(adv, 3).map(r => r.id), ["inv1", "inv2"], "only earlier levels, only items still there");
  assert.deepEqual(replaceableItems(adv, 1), []);
  assert.deepEqual(droppedPicks(adv, 3, { selected: ["Compendium.x.Item.new", "Compendium.x.Item.thirsting"] }), ["Compendium.x.Item.thirsting"]);
  assert.deepEqual(droppedPicks({ ...adv, constructor: { typeName: "ItemGrant" } }, 3, { selected: ["a"] }), []);
});

test("names for grants that don't resolve, and cleaned step titles", () => {
  assert.equal(missingName("Compendium.dnd5e.classes24.Item.phbmnkSelfrestor"), "Self-Restoration");
  assert.equal(missingName("Compendium.dnd5e.feats24.Item.phbfstBlindFight"), "Blind Fighting");
  assert.equal(missingName("Compendium.dnd5e.feats24.Item.phbfstSomeThing00"), "Some Thing");
  const adv = (title, typeName = "AbilityScoreImprovement", configuration = {}) => ({ title, configuration, constructor: { typeName } });
  assert.equal(displayTitle(adv("8: Ability Score Improvement")), "Ability Score Improvement");
  assert.equal(displayTitle(adv("Skills", "Trait", { mode: "expertise" })), "Expertise");
  assert.equal(displayTitle(adv("Skills", "Trait", { mode: "default" })), "Skills");
});

test("ASI answers the engine refuses: a score at its maximum, too many points, a locked ability", () => {
  const config = { points: 2, cap: 2, fixed: {}, locked: ["cha"] };
  const scores = { str: { value: 20, max: 20 }, dex: { value: 18, max: 20 }, cha: { value: 10, max: 20 } };
  assert.deepEqual(asiAnswerProblems(config, scores, { dex: 2 }), []);
  assert.deepEqual(asiAnswerProblems(config, scores, { str: 2 }), [{ key: "str", reason: "max", max: 20 }]);
  assert.deepEqual(asiAnswerProblems(config, scores, { dex: 1, str: 1 }).map(p => p.reason), ["max"]);
  assert.deepEqual(asiAnswerProblems(config, scores, { cha: 1 }).map(p => p.reason), ["locked"]);
  assert.deepEqual(asiAnswerProblems({ ...config, points: 1 }, scores, { dex: 2 }).map(p => p.reason), ["points"]);
  assert.deepEqual(asiAnswerProblems({ points: 1, cap: 1, fixed: {}, max: 30 }, scores, { str: 1 }), [], "an Epic Boon goes past 20");
  assert.deepEqual(asiAnswerProblems({ points: 0, fixed: { dex: 4 }, max: 25 }, { dex: { value: 20, max: 20 } }, { dex: 4 }), [], "fixed increases aren't picks");
});

test("a background's Magic Initiate list", () => {
  const keys = ["class:cleric", "class:druid", "class:wizard"];
  const labels = { "class:cleric": "Cleric", "class:druid": "Druid", "class:wizard": "Wizard" };
  assert.equal(backgroundList({ text: "<p><strong>Feat:</strong> Magic Initiate (Wizard)</p>", keys, labels }), "class:wizard");
  assert.equal(backgroundList({ text: "Feat: Magic Initiate (Cleric) (see chapter 5)", keys, labels }), "class:cleric");
  assert.equal(backgroundList({ identifier: "sage", keys, labels }), "class:wizard");
  assert.equal(backgroundList({ identifier: "background-guide", keys, labels }), "class:druid");
  assert.equal(backgroundList({ text: "Feat: Alert", identifier: "criminal", keys, labels }), null);
});

test("Review: notes first, HP explained, entities decoded, freed spells, spellbook wording, raised maximum", () => {
  const snap = (over = {}) => ({ level: 11, classes: { wizard: { name: "Wizard", levels: 11, subclass: "" } }, hpMax: 70,
    abilities: { con: { label: "CON", value: 15 }, int: { label: "INT", value: 20 } }, skills: {}, saves: {}, profs: {}, items: [],
    scale: { "druid.wild-shape-cr": { label: "Wild Shape CR", value: "&frac14;" } }, size: { key: "med", label: "Medium" }, ...over });
  const before = snap({ items: [{ id: "cw", name: "Cure Wounds", type: "spell", level: 1, prepared: 1, classSpell: true }] });
  const after = snap({ level: 12, classes: { wizard: { name: "Wizard", levels: 12, subclass: "" } }, hpMax: 89,
    abilities: { con: { label: "CON", value: 16 }, int: { label: "INT", value: 21 } },
    scale: { "druid.wild-shape-cr": { label: "Wild Shape CR", value: "&frac12;" } },
    items: [{ id: "cw2", name: "Cure Wounds", type: "spell", level: 1, prepared: 2 }, { id: "ff", name: "Fireball", type: "spell", level: 3, prepared: 1, classSpell: true }] });
  const groups = reviewChanges(before, after, { hp: { method: "avg", roll: 4, die: 6, mod: 2 }, spells: { step: 3, spellbookClass: true, freed: [{ id: "cw", name: "Cure Wounds" }] },
    notes: [{ key: "dropped:1", text: "Not applied: Thirsting Blade", step: 1 }] });
  assert.equal(groups[0].id, "attention");
  assert.equal(groups[0].lines[0].step, 1);
  const text = groups.flatMap(g => g.lines.map(l => l.text));
  // CON 15 → 16 (+2 → +3): 4 + 2 as the HP step showed, +1 more on this level and +11 on the 11 earlier ones, +1 from a feature.
  assert.ok(text.includes("Max HP 70 → 89 (+19, average 4 + 2 CON; +12 from the new CON modifier on earlier levels; +1 from other features)"), text.join("\n"));
  assert.ok(text.includes("Wild Shape CR ¼ → ½"));
  assert.ok(text.includes("Cure Wounds is now always prepared: your earlier pick of it is freed for another spell"));
  assert.ok(!text.some(t => t.startsWith("Forgot Cure Wounds")));
  assert.ok(text.includes("Added to spellbook and prepared: Fireball"));
  assert.ok(text.some(t => t.startsWith("INT 20 → 21 (above 20")));
  assert.equal(decodeEntities("a &amp; b &#189;"), "a & b ½");
  assert.deepEqual(hpExtras({ delta: 8, roll: 6, mod: 2, before: { level: 3, abilities: { con: { value: 14 } } }, after: { abilities: { con: { value: 14 } } } }), { con: 0, other: 0 });
  assert.deepEqual(hpExtras({ delta: 10, roll: 6, mod: 2, before: { level: 3, abilities: { con: { value: 14 } } }, after: { abilities: { con: { value: 14 } } } }), { con: 0, other: 2 },
    "Draconic Resilience-style +HP shows as other features");
});

test("Elemental Affinity may name a resistance the character already has", () => {
  assert.equal(isResistancePool(["dr:acid", "dr:fire"]), true);
  assert.equal(isResistancePool(["skills:ath"]), false);
  const options = withHeldResistances([{ key: "dr:acid", label: "Acid" }], ["dr:acid", "dr:fire"], k => k.slice(3));
  assert.deepEqual(options.map(o => [o.key, o.label]), [["dr:acid", "Acid"], ["dr:fire", "fire (already resistant)"]]);
});

test("GM data warnings for incomplete imports", () => {
  const base = { className: "Fighter", identifier: "fighter", rules: "2024", newClass: true, original: true, levelsBefore: 0, levelsAfter: 1,
    masteryTrait: false, expertiseLevels: [], fallback: {}, weaponsGained: [] };
  assert.deepEqual(dataWarningsFor(base).map(w => w.key), ["data:mastery:fighter"]);
  assert.deepEqual(dataWarningsFor({ ...base, masteryTrait: true }), []);
  assert.deepEqual(dataWarningsFor({ ...base, identifier: "rogue", className: "Rogue", masteryTrait: true, newClass: false, levelsBefore: 5, levelsAfter: 6, expertiseLevels: [1] })
    .map(w => w.key), ["data:expertise:rogue:6"]);
  assert.deepEqual(dataWarningsFor({ ...base, identifier: "fighter", masteryTrait: true, newClass: false, levelsBefore: 2, levelsAfter: 3, fallback: { cantrips: true, prepared: true }, firstCasting: true })
    .map(w => w.key), ["data:spellcounts:fighter"]);
  assert.deepEqual(dataWarningsFor({ ...base, identifier: "monk", className: "Monk", original: false, weaponsGained: ["shortsword"] }).map(w => w.key), ["data:mcweapons:monk"]);
});
