// Unit tests for trait-options.mjs (creation data fixes 4 and 6). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { anyLanguageOptions, isLanguagePool, mergeSlots, shapeSlots, traitConflicts } from "../src/foundry/systems/dnd5e/builder/trait-options.mjs";

test("language pools: only languages count; an empty pool doesn't", () => {
  assert.equal(isLanguagePool(["languages:standard:*"]), true);
  assert.equal(isLanguagePool(new Set(["languages:standard:*", "languages:exotic:draconic"])), true);
  assert.equal(isLanguagePool(["languages:*", "skills:ath"]), false);
  assert.equal(isLanguagePool([]), false);
});

test("slots offering the same options merge into one count; empty slots drop", () => {
  const langs = [{ key: "languages:standard:elvish" }, { key: "languages:exotic:abyssal" }];
  const merged = mergeSlots([{ options: langs, count: 1 }, { options: [...langs], count: 1 }, { options: [], count: 1 }, { options: [{ key: "skills:ath" }] }]);
  assert.deepEqual(merged.map(s => [s.options.map(o => o.key).join(), s.count]), [[langs.map(o => o.key).join(), 2], ["skills:ath", 1]]);
});

test("slots say whether they are a fixed grant (\"Common — granted\") or a choice, even with one option left", () => {
  const common = [{ key: "languages:standard:common" }];
  const slots = mergeSlots([{ options: common, granted: true }, { options: [{ key: "skills:ste" }], granted: false }, { options: [{ key: "skills:prc" }, { key: "skills:ins" }] }]);
  assert.deepEqual(slots.map(s => [s.options[0].key, s.granted]), [["languages:standard:common", true], ["skills:ste", false], ["skills:prc", false]]);
  // A grant merged with a choice offering the same option counts as a choice.
  assert.equal(mergeSlots([{ options: common, granted: true }, { options: common, granted: false }])[0].granted, false);
});

test("conflicts: saved picks no longer offered, but never a fixed grant; duplicates count once", () => {
  const offered = new Set(["skills:acr", "skills:ath", "skills:prc", "skills:inv"]);
  // Rogue answered Stealth and Sleight of Hand before Criminal (which grants both) was picked.
  assert.deepEqual(traitConflicts(["skills:ste", "skills:slt", "skills:prc", "skills:ste"], offered), ["skills:ste", "skills:slt"]);
  assert.deepEqual(traitConflicts(["languages:exotic:cant", "languages:standard:elvish"], new Set(["languages:standard:elvish"]), ["languages:exotic:cant"]), []);
  assert.deepEqual(traitConflicts([], offered), []);
});

test("any language: every language but Thieves' Cant and Druidic, unless the pool itself offers them; never a fixed grant", () => {
  const o = key => ({ key });
  const all = ["languages:standard:common", "languages:standard:elvish", "languages:exotic:abyssal", "languages:exotic:cant", "languages:exotic:druidic"].map(o);
  assert.deepEqual(anyLanguageOptions(all, [o("languages:standard:elvish"), o("languages:standard:common")], new Set(["languages:standard:common"])).map(x => x.key),
    ["languages:standard:elvish", "languages:exotic:abyssal"]);
  // Rogue 2024: grant Thieves' Cant, choose one from languages:* (whose own options include Druidic).
  assert.deepEqual(anyLanguageOptions(all, [o("languages:exotic:druidic"), o("languages:exotic:abyssal")], new Set(["languages:exotic:cant"])).map(x => x.key),
    ["languages:standard:common", "languages:standard:elvish", "languages:exotic:abyssal", "languages:exotic:druidic"]);
});

test("dnd5e's replacements (allowReplacements): one slot, the remaining grants preselected, no secret languages leaking in", () => {
  const o = key => ({ key });
  const skills = ["skills:his", "skills:ins", "skills:rel", "skills:ste"].map(o);
  // 2014 Acolyte: grants Insight and Religion; the class already gave Insight.
  const acolyte = shapeSlots([{ options: [], granted: true }, { options: [o("skills:rel")], granted: true }],
    { allowReplacements: true, trait: "skills", typeOptions: () => skills });
  assert.equal(acolyte.length, 1);
  assert.deepEqual([acolyte[0].count, acolyte[0].replacement, acolyte[0].preselected], [2, true, ["skills:rel"]]);
  assert.deepEqual(acolyte[0].options.map(x => x.key), skills.map(x => x.key));
  // A choice the "any language" rule widened is not empty: no replacement slot, so Cant / Druidic can't come back.
  const widened = shapeSlots([{ options: [o("languages:exotic:abyssal")], granted: false }],
    { allowReplacements: true, trait: "languages", typeOptions: () => [o("languages:exotic:abyssal"), o("languages:exotic:cant")] });
  assert.deepEqual(widened.map(x => [x.replacement ?? false, x.options.map(y => y.key)]), [[false, ["languages:exotic:abyssal"]]]);
  // A real replacement over languages: the secret ones only if an entry offered them.
  const langs = shapeSlots([{ options: [], granted: true }], { allowReplacements: true, trait: "languages",
    typeOptions: () => [o("languages:standard:elvish"), o("languages:exotic:cant"), o("languages:exotic:druidic")] });
  assert.deepEqual(langs[0].options.map(x => x.key), ["languages:standard:elvish"]);
  // Without allowReplacements: one slot per entry, as before.
  assert.deepEqual(shapeSlots([{ options: [], granted: true }, { options: [o("skills:rel")], granted: true }], { trait: "skills" }).map(x => x.options[0].key), ["skills:rel"]);
});

test("with the replacement slot, a saved grant the character now has elsewhere is a conflict", () => {
  const offered = new Set(["skills:his", "skills:rel", "skills:ste"]);
  // checkTraitAnswer passes no fixed grants when the step shows dnd5e's replacement slot.
  assert.deepEqual(traitConflicts(["skills:ins", "skills:rel"], offered, []), ["skills:ins"]);
  assert.deepEqual(traitConflicts(["skills:ins", "skills:rel"], offered, ["skills:ins", "skills:rel"]), [], "without it, grants never conflict");
});
