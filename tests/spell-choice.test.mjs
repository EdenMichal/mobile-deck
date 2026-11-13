// Unit tests for spell-choice.mjs (creation data fix 2: Magic Initiate and spell ability choices). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { listsInCommon, lockedList, suggestedAbility } from "../src/foundry/systems/dnd5e/builder/spell-choice.mjs";

const MI = ["class:cleric", "class:druid", "class:wizard"];

test("lists in common: every spell must be on the list", () => {
  // Light (Cleric, Wizard) + Guidance (Cleric, Druid) → Cleric only; Druidcraft alone → Druid.
  assert.deepEqual(listsInCommon([["class:cleric", "class:wizard"], ["class:cleric", "class:druid"]], MI), ["class:cleric"]);
  assert.deepEqual(listsInCommon([["class:druid"]], MI), ["class:druid"]);
  assert.deepEqual(listsInCommon([["class:wizard"], ["class:druid"]], MI), []);
  assert.deepEqual(listsInCommon([], MI), MI);
});

test("locked list: a saved list wins; else the one list earlier picks share; else open", () => {
  assert.equal(lockedList({ answered: [null, "class:druid"] }, MI), "class:druid");
  assert.equal(lockedList({ answered: ["class:bard"] }, MI), null, "a list the feat doesn't offer doesn't lock");
  assert.equal(lockedList({ pickedLists: [["class:cleric", "class:wizard"], ["class:wizard"]] }, MI), "class:wizard");
  assert.equal(lockedList({ pickedLists: [["class:cleric", "class:wizard"]] }, MI), null, "Light alone could still be Cleric or Wizard");
  assert.equal(lockedList({}, MI), null);
});

test("suggested ability: the answer, the feat's other answer, the casting ability, else the best score", () => {
  const choices = ["int", "wis", "cha"];
  assert.equal(suggestedAbility(choices, { answer: "cha", sibling: "wis", casting: "int" }), "cha");
  assert.equal(suggestedAbility(choices, { sibling: "wis", casting: "int" }), "wis");
  assert.equal(suggestedAbility(choices, { casting: "int" }), "int");
  assert.equal(suggestedAbility(choices, { casting: "str", scores: { int: 8, wis: 17, cha: 12 } }), "wis");
  assert.equal(suggestedAbility([], {}), "");
});
