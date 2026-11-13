// Unit tests for the Phase 4 ability-score rules. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ABILITIES, POINT_BUY, STANDARD_ARRAY, pointBuyState, slotsFor, placeSlot, clearAbility, scoresFromSlots,
  suggestedAssignments, validateBackgroundAsi, finalScores, validateEntered, methodsAllowed, rerollsLeft,
  slotValues, baseScores, abilitiesComplete, abilityStatus
} from "../src/foundry/systems/dnd5e/builder/creation-rules.mjs";

test("point buy: all 8s cost nothing; 15/15/15 costs 27 and blocks further raises", () => {
  const start = pointBuyState({});
  assert.equal(start.spent, 0);
  assert.equal(start.left, 27);
  assert.equal(start.abilities.str.value, 8);
  assert.equal(start.abilities.str.nextCost, 1);
  assert.equal(start.abilities.str.canLower, false);
  const maxed = pointBuyState({ str: 15, dex: 15, con: 15 });
  assert.equal(maxed.spent, 27);
  assert.equal(maxed.left, 0);
  assert.equal(maxed.valid, true);
  assert.equal(maxed.abilities.int.canRaise, false);
  assert.equal(maxed.abilities.str.nextCost, null);
});

test("point buy: 13 → 14 costs 2, and scores are clamped to 8–15", () => {
  const s = pointBuyState({ str: 13, dex: 20, con: 3 });
  assert.equal(s.abilities.str.nextCost, 2);
  assert.equal(s.abilities.dex.value, 15);
  assert.equal(s.abilities.con.value, 8);
  assert.equal(POINT_BUY.costs[14], 7);
});

test("slot tokens: placing a used slot moves it and empties its old ability", () => {
  const slots = slotsFor(STANDARD_ARRAY, "a");
  assert.deepEqual(slots.map(s => s.id), ["a0", "a1", "a2", "a3", "a4", "a5"]);
  let a = placeSlot({}, "a0", "str");
  a = placeSlot(a, "a1", "dex");
  a = placeSlot(a, "a0", "con");
  assert.deepEqual(a, { dex: "a1", con: "a0" });
  a = placeSlot(a, "a2", "dex"); // dex had a1; a1 is free again
  assert.deepEqual(a, { con: "a0", dex: "a2" });
  assert.deepEqual(clearAbility(a, "con"), { dex: "a2" });
  assert.deepEqual(scoresFromSlots(slots, clearAbility(a, "con")), { str: null, dex: 13, con: null, int: null, wis: null, cha: null });
});

test("duplicate rolled values keep separate slots", () => {
  const slots = slotsFor([12, 12, 9, 15, 10, 8], "r");
  const a = placeSlot(placeSlot({}, "r0", "str"), "r1", "dex");
  assert.deepEqual(scoresFromSlots(slots, a).str, 12);
  assert.deepEqual(scoresFromSlots(slots, a).dex, 12);
});

test("suggested layout follows the book's Standard Array by Class table", () => {
  const slots = slotsFor(STANDARD_ARRAY, "a");
  const fighter = scoresFromSlots(slots, suggestedAssignments("fighter", slots));
  assert.deepEqual(fighter, { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 });
  const rolled = slotsFor([9, 17, 11, 14, 8, 13], "r");
  const wizard = scoresFromSlots(rolled, suggestedAssignments("wizard", rolled));
  assert.equal(wizard.int, 17);
  assert.equal(wizard.str, 8);
  assert.equal(suggestedAssignments("runesmith", slots), null);
});

test("background ASI: +2/+1 or +1/+1/+1 on unlocked abilities only", () => {
  const config = { points: 3, cap: 2, locked: ["int", "wis", "cha"] };
  assert.deepEqual(validateBackgroundAsi(config, { str: 2, con: 1 }), []);
  assert.deepEqual(validateBackgroundAsi(config, { str: 1, dex: 1, con: 1 }), []);
  assert.equal(validateBackgroundAsi(config, { str: 3 }).some(r => r.key === "cap"), true);
  assert.equal(validateBackgroundAsi(config, { str: 2, int: 1 }).some(r => r.key === "locked"), true);
  assert.equal(validateBackgroundAsi(config, { str: 2 }).some(r => r.key === "points"), true);
});

test("final scores add the bonus and cap at 20; missing bases stay null", () => {
  assert.deepEqual(finalScores({ str: 15, dex: 19, con: null }, { str: 2, dex: 2 }),
    { str: 17, dex: 20, con: null, int: null, wis: null, cha: null });
});

test("entered dice: six whole numbers from 3 to 18", () => {
  assert.deepEqual(validateEntered([3, 18, 10, 12, 9, 14]), []);
  assert.equal(validateEntered([2, 18, 10, 12, 9, 14])[0].key, "range");
  assert.equal(validateEntered([10, 10]).some(r => r.key === "count"), true);
  assert.equal(validateEntered([10.5, 10, 10, 10, 10, 10])[0].key, "range");
});

test("methods: only GM-enabled ones, Standard Array when none; rerolls left", () => {
  assert.deepEqual(methodsAllowed({}), ["standardArray"]);
  assert.deepEqual(methodsAllowed({ abilityMethods: { standardArray: false, pointBuy: true, roll: true, manual: false } }), ["pointBuy", "roll"]);
  assert.deepEqual(methodsAllowed({ abilityMethods: { standardArray: false } }), ["standardArray"]);
  assert.equal(rerollsLeft({ abilityRerolls: 2 }, { rerollsUsed: 1 }), 1);
  assert.equal(rerollsLeft({}, {}), 0);
});

test("base scores per method", () => {
  assert.deepEqual(baseScores({ method: "pointBuy", pointBuy: { str: 15 } }), { str: 15, dex: 8, con: 8, int: 8, wis: 8, cha: 8 });
  assert.equal(slotValues({ method: "roll" }, { sets: [] }).length, 0);
  const rolled = baseScores({ method: "roll", assignments: { str: "r0" } }, { sets: [[3, 4, 5, 6, 7, 8], [16, 4, 5, 6, 7, 8]] });
  assert.equal(rolled.str, 16); // the latest set
  assert.equal(baseScores({ method: "manual", entered: [18, 3, 9, 9, 9, 9], assignments: { cha: "m0" } }).cha, 18);
  assert.equal(slotValues({ method: "manual", entered: [19, 3, 9, 9, 9, 9] }).length, 0);
  assert.equal(abilitiesComplete({ str: 1, dex: 1, con: 1, int: 1, wis: 1, cha: null }), false);
  assert.equal(ABILITIES.length, 6);
});

test("ability status: point buy counts unspent points and refuses an over-budget buy", () => {
  assert.deepEqual(abilityStatus({ method: "pointBuy", pointBuy: {} }), { complete: true, unspent: 27, overBudget: false });
  assert.deepEqual(abilityStatus({ method: "pointBuy", pointBuy: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 } }), { complete: true, unspent: 0, overBudget: false });
  // Saved data edited by hand: 6 × 15 costs 54.
  const over = abilityStatus({ method: "pointBuy", pointBuy: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } });
  assert.equal(over.overBudget, true);
  assert.equal(over.complete, false);
  assert.equal(over.unspent, 0);
  assert.deepEqual(abilityStatus({ method: "standardArray", assignments: {} }), { complete: false, unspent: 0, overBudget: false });
  assert.deepEqual(abilityStatus({}), { complete: false, unspent: 0, overBudget: false });
});
