// Unit tests for edit-rules.mjs (Change choices, D&D Beyond-style edits). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { abilityBonuses, baseFrom, canRemoveClass, checkEditTarget, enteredAnswer, hasChoiceAt, isEditTarget, newScores, pairRecreatedItems, scoresAnswerProblem,
  seedsFor, swapIds } from "../src/foundry/systems/dnd5e/builder/edit-rules.mjs";
import { baseScores } from "../src/foundry/systems/dnd5e/builder/creation-rules.mjs";

const items = [
  { id: "f", type: "class", identifier: "fighter" },
  { id: "w", type: "class", identifier: "wizard" },
  { id: "r", type: "race", identifier: "human" },
  { id: "b", type: "background", identifier: "soldier" },
  { id: "x", type: "feat", identifier: "alert" }
];

test("isEditTarget: only the four edit kinds", () => {
  for (const kind of ["modify", "replace", "remove", "scores"]) assert.equal(isEditTarget({ kind }), true);
  for (const kind of ["level", "new-class", "new-item", undefined]) assert.equal(isEditTarget({ kind }), false);
  assert.equal(isEditTarget(null), false);
});

test("canRemoveClass: never the starting class or the only class", () => {
  assert.equal(canRemoveClass(items[1], items, "f"), true);
  assert.equal(canRemoveClass(items[0], items, "f"), false);
  assert.equal(canRemoveClass(items[0], [items[0]], ""), false);
  assert.equal(canRemoveClass(items[2], items, "f"), false);
});

test("checkEditTarget: modify, remove, scores", () => {
  assert.equal(checkEditTarget({ kind: "scores" }), null);
  assert.equal(checkEditTarget({ kind: "level" }), "kind");
  assert.equal(checkEditTarget({ kind: "modify", itemId: "f", level: 3 }, { items }), null);
  assert.equal(checkEditTarget({ kind: "modify", itemId: "b", level: 0 }, { items }), null);
  assert.equal(checkEditTarget({ kind: "modify", itemId: "gone", level: 3 }, { items }), "item");
  assert.equal(checkEditTarget({ kind: "modify", itemId: "f", level: -1 }, { items }), "level");
  assert.equal(checkEditTarget({ kind: "modify", itemId: "f", level: 1.5 }, { items }), "level");
  assert.equal(checkEditTarget({ kind: "remove", itemId: "w" }, { items, originalClass: "f" }), null);
  assert.equal(checkEditTarget({ kind: "remove", itemId: "f" }, { items, originalClass: "f" }), "remove");
});

test("checkEditTarget: replace needs the same type, not banned, not a class already owned", () => {
  const doc = (type, identifier = "") => ({ type, name: identifier, system: { identifier } });
  assert.equal(checkEditTarget({ kind: "replace", itemId: "r", uuid: "u" }, { items, doc: doc("race", "dwarf") }), null);
  assert.equal(checkEditTarget({ kind: "replace", itemId: "r", uuid: "u" }, { items, doc: doc("background", "sage") }), "notSame");
  assert.equal(checkEditTarget({ kind: "replace", itemId: "r", uuid: "u" }, { items, doc: null }), "notSame");
  assert.equal(checkEditTarget({ kind: "replace", itemId: "x", uuid: "u" }, { items, doc: doc("feat") }), "kind");
  assert.equal(checkEditTarget({ kind: "replace", itemId: "f", uuid: "u" }, { items, doc: doc("class", "barbarian") }), null);
  assert.equal(checkEditTarget({ kind: "replace", itemId: "f", uuid: "u" }, { items, doc: doc("class", "wizard") }), "owned");
  // The class being replaced may come back (another copy of the same class).
  assert.equal(checkEditTarget({ kind: "replace", itemId: "f", uuid: "u" }, { items, doc: doc("class", "fighter") }), null);
  assert.equal(checkEditTarget({ kind: "replace", itemId: "f", uuid: "u" }, { items, doc: doc("class", "barbarian"), rules: { bannedClasses: ["barbarian"] } }), "banned");
});

test("seedsFor: each advancement's current picks as replayable answers", () => {
  assert.deepEqual(seedsFor("HitPoints", { 1: "max", 2: "avg", 3: 7 }, [1, 2, 3]).map(s => [s.level, s.data.value, s.meta.hp.method]),
    [[1, "max", "max"], [2, "avg", "avg"], [3, 7, "roll"]]);
  assert.equal(seedsFor("HitPoints", { 3: 7 })[0].meta.hp.seeded, true);
  assert.deepEqual(seedsFor("Size", { size: "sm" }, [0]), [{ level: 0, data: { size: "sm" }, meta: null }]);
  assert.deepEqual(seedsFor("Subclass", { uuid: "S" }, [3])[0], { level: 3, data: { uuid: "S" }, meta: { kind: "subclass" } });
  assert.deepEqual(seedsFor("AbilityScoreImprovement", { type: "asi", assignments: { str: 2, dex: 0 } }, [4])[0].data, { type: "asi", assignments: { str: 2 } });
  assert.deepEqual(seedsFor("AbilityScoreImprovement", { type: "feat", feat: { abc: "FEAT" } }, [4])[0].data, { type: "feat", uuid: "FEAT" });
  assert.deepEqual(seedsFor("AbilityScoreImprovement", {}, [4]), []);
  assert.deepEqual(seedsFor("ItemChoice", { added: { 1: { a: "A" }, 2: {}, 6: { b: "B", c: "C" } }, ability: "int" }, [1, 2, 6]).map(s => [s.level, s.data]),
    [[1, { selected: ["A"], ability: "int" }], [6, { selected: ["B", "C"], ability: "int" }]]);
  // dnd5e's replacement at level 5: one earlier pick swapped for one more new pick; the swap is seeded with it.
  assert.deepEqual(seedsFor("ItemChoice", { added: { 2: { a: "A", b: "B" }, 5: { c: "C", d: "D" } }, replaced: { 5: { level: 2, original: "a", replacement: "d" } } }, [2, 5])
    .map(s => [s.level, s.data]), [[2, { selected: ["A", "B"] }], [5, { selected: ["C", "D"], replace: "a" }]]);
  assert.deepEqual(seedsFor("ItemGrant", { added: { a: "A" } }, [1])[0].data, { selected: ["A"] });
  assert.deepEqual(seedsFor("Trait", { chosen: new Set(["skills:ath", "skills:per"]) }, [1])[0].data, { chosen: ["skills:ath", "skills:per"] });
  assert.deepEqual(seedsFor("Trait", { chosen: [] }, [1]), []);
  assert.deepEqual(seedsFor("ScaleValue", {}, [1]), []);
  // A DataModel value is read through toObject().
  assert.deepEqual(seedsFor("Size", { toObject: () => ({ size: "lg" }) }, [0])[0].data, { size: "lg" });
});

test("abilityBonuses / baseFrom: base = score − every ASI advancement's assignments", () => {
  const advs = [
    { type: "AbilityScoreImprovement", value: { type: "asi", assignments: { str: 2, con: 1 } } },
    { type: "AbilityScoreImprovement", value: { type: "asi", assignments: { str: 1 } } },
    { type: "AbilityScoreImprovement", value: { type: "feat", feat: { a: "F" } } },
    { type: "AbilityScoreImprovement", value: { assignments: { dex: 1 } } },
    { type: "Trait", value: { chosen: ["skills:ath"] } }
  ];
  const bonus = abilityBonuses(advs);
  assert.deepEqual(bonus, { str: 3, con: 1, dex: 1 });
  assert.deepEqual(baseFrom({ str: 18, dex: 14, con: 15, int: 10, wis: 12, cha: 8 }, bonus), { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 });
});

test("enteredAnswer: the base scores as entered numbers, each on its own ability", () => {
  const base = { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 };
  const answer = enteredAnswer(base);
  assert.equal(answer.method, "manual");
  assert.deepEqual(baseScores(answer, {}), base);
});

test("newScores: base + increases, refusing a missing base or a total above the maximum", () => {
  const ok = newScores({ str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }, { str: 3 }, {});
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.scores.str, 18);
  const high = newScores({ str: 18, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }, { str: 3 }, { str: 20 });
  assert.deepEqual(high.problems, [{ key: "str", reason: "max", total: 21, max: 20 }]);
  // A higher maximum (Body and Mind, 25) is respected.
  assert.deepEqual(newScores({ str: 10, dex: 18, con: 14, int: 10, wis: 12, cha: 8 }, { dex: 6 }, { dex: 25 }).problems, []);
  assert.deepEqual(newScores({ str: null, dex: 13, con: 14, int: 10, wis: 12, cha: 8 }, {}, {}).problems, [{ key: "str", reason: "missing" }]);
});

test("hasChoiceAt: which levels the Change choices list shows", () => {
  assert.equal(hasChoiceAt({ type: "HitPoints" }, 1, { isOriginalClass: true }), false);
  assert.equal(hasChoiceAt({ type: "HitPoints" }, 1, { isOriginalClass: false }), true);
  assert.equal(hasChoiceAt({ type: "HitPoints" }, 2, { isOriginalClass: true }), true);
  assert.equal(hasChoiceAt({ type: "Subclass" }, 3), true);
  assert.equal(hasChoiceAt({ type: "AbilityScoreImprovement", points: 0, allowFeat: false }, 0), false);
  assert.equal(hasChoiceAt({ type: "AbilityScoreImprovement", points: 2 }, 4), true);
  assert.equal(hasChoiceAt({ type: "ItemChoice", choices: { 1: { count: 1 }, 2: { count: 0, replacement: true }, 3: { count: 0 } } }, 1), true);
  assert.equal(hasChoiceAt({ type: "ItemChoice", choices: { 1: { count: 1 }, 2: { count: 0, replacement: true }, 3: { count: 0 } } }, 2), true);
  assert.equal(hasChoiceAt({ type: "ItemChoice", choices: { 1: { count: 1 }, 2: { count: 0, replacement: true }, 3: { count: 0 } } }, 3), false);
  assert.equal(hasChoiceAt({ type: "Trait", traitChoices: 2 }, 1), true);
  assert.equal(hasChoiceAt({ type: "Trait", traitChoices: 0 }, 1), false);
  assert.equal(hasChoiceAt({ type: "Size", sizes: 2 }, 0), true);
  assert.equal(hasChoiceAt({ type: "Size", sizes: 1 }, 0), false);
  assert.equal(hasChoiceAt({ type: "ItemGrant", optional: false, spellAbilities: 0 }, 1), false);
  assert.equal(hasChoiceAt({ type: "ItemGrant", optional: true }, 1), true);
  assert.equal(hasChoiceAt({ type: "ScaleValue" }, 1), false);
});

test("pairRecreatedItems / swapIds: a re-created feature keeps the old item's id", () => {
  const src = id => ({ _stats: { compendiumSource: id } });
  const created = [
    { _id: "new1", type: "feat", name: "Second Wind", ...src("SW"), flags: { dnd5e: { advancementOrigin: "cls.adv1" } } },
    { _id: "new2", type: "feat", name: "Archery", ...src("AR") },
    { _id: "new3", type: "feat", name: "Dueling", ...src("DU") },
    { _id: "new4", type: "feat", name: "No source" }
  ];
  const deleted = [{ _id: "old1", type: "feat", name: "Second Wind", ...src("SW") }, { _id: "old2", type: "feat", name: "Archery", ...src("AR") },
    { _id: "old3", type: "feat", name: "Archery", ...src("AR") }, { _id: "old4", type: "feat", name: "No source" }];
  const map = pairRecreatedItems(created, deleted);
  assert.deepEqual([...map], [["new1", "old1"], ["new2", "old2"]]);
  // Snapshot items (id + source) pair the same way.
  assert.deepEqual([...pairRecreatedItems([{ id: "n", type: "feat", name: "A", source: "S" }], [{ id: "o", type: "feat", name: "A", source: "S" }])], [["n", "o"]]);
  const swapped = swapIds({ value: { added: { new1: "SW" } }, origin: "new2.adv", other: "new3" }, map);
  assert.deepEqual(swapped, { value: { added: { old1: "SW" } }, origin: "old2.adv", other: "new3" });
  assert.equal(swapIds("x", new Map()), "x");
});

test("scoresAnswerProblem: a method the House Rules don't offer, a Point Buy over budget, numbers typed where rolling is allowed", () => {
  const entered = { method: "manual", entered: [15, 14, 13, 12, 10, 8] };
  const array = { method: "standardArray", assignments: {} };
  const fair = { method: "pointBuy", pointBuy: { str: 15, dex: 15, con: 15, int: 8, wis: 8, cha: 8 } };
  const over = { method: "pointBuy", pointBuy: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } };
  assert.equal(scoresAnswerProblem(array, ["standardArray"]), null);
  assert.equal(scoresAnswerProblem(entered, ["standardArray"]), "method", "typed numbers where only the array is allowed");
  assert.equal(scoresAnswerProblem(entered, ["standardArray", "manual"]), null);
  assert.equal(scoresAnswerProblem(entered, ["roll"]), "entered", "rolling allowed: entering stands in, and the GM is told");
  assert.equal(scoresAnswerProblem(entered, ["roll", "manual"]), null);
  assert.equal(scoresAnswerProblem({ method: "roll" }, ["roll"]), "method", "rolling itself isn't offered again");
  assert.equal(scoresAnswerProblem(fair, ["pointBuy"]), null);
  assert.equal(scoresAnswerProblem(over, ["pointBuy", "manual"]), "overBudget");
  assert.equal(scoresAnswerProblem(null, ["standardArray"]), "method");
});
