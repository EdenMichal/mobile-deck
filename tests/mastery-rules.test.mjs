// Unit tests for the Weapon Mastery rules (player feedback). Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMasteryChange, isProficient, masteryAllowance, tableMasteries } from "../src/foundry/systems/dnd5e/builder/mastery-rules.mjs";

test("the 2024 tables", () => {
  assert.equal(tableMasteries("fighter", 1), 3);
  assert.equal(tableMasteries("fighter", 4), 4);
  assert.equal(tableMasteries("fighter", 16), 6);
  assert.equal(tableMasteries("barbarian", 9), 3);
  assert.equal(tableMasteries("rogue", 20), 2);
  assert.equal(tableMasteries("wizard", 20), 0);
});

test("class data wins over the table; the table needs 2024 or the feature", () => {
  assert.equal(masteryAllowance([{ identifier: "fighter", levels: 4, dataCount: 3, is2024: true }]).total, 3);
  assert.equal(masteryAllowance([{ identifier: "fighter", levels: 4, dataCount: null, is2024: true }]).total, 4);
  assert.equal(masteryAllowance([{ identifier: "fighter", levels: 4, dataCount: null, is2024: false }]).total, 0);
  assert.equal(masteryAllowance([{ identifier: "fighter", levels: 4, dataCount: null, is2024: false }], { hasFeature: true }).total, 4);
  assert.equal(masteryAllowance([{ identifier: "fighter", levels: 1, dataCount: null, is2024: true },
    { identifier: "rogue", levels: 1, dataCount: null, is2024: true }]).total, 5);
});

test("new picks while fewer than allowed are known", () => {
  const proficient = new Set(["longsword", "greataxe", "dagger"]);
  assert.ok(checkMasteryChange({ before: [], after: ["longsword", "greataxe"], allowance: 2, proficient }).ok);
  assert.equal(checkMasteryChange({ before: [], after: ["longsword", "greataxe", "dagger"], allowance: 2, proficient }).reason, "tooMany");
  assert.equal(checkMasteryChange({ before: [], after: ["whip"], allowance: 2, proficient }).reason, "notProficient");
});

test("one swap only after a Long Rest", () => {
  const proficient = new Set(["longsword", "greataxe", "dagger", "rapier"]);
  const before = ["longsword", "greataxe"];
  assert.equal(checkMasteryChange({ before, after: ["longsword", "dagger"], allowance: 2, proficient }).reason, "noSwap");
  const swap = checkMasteryChange({ before, after: ["longsword", "dagger"], allowance: 2, proficient, swap: true });
  assert.ok(swap.ok);
  assert.ok(swap.usedSwap);
  assert.equal(checkMasteryChange({ before, after: ["dagger", "rapier"], allowance: 2, proficient, swap: true }).reason, "oneSwap");
});

test("a GM may set anything", () => {
  const result = checkMasteryChange({ before: ["longsword"], after: ["whip", "net", "lance"], allowance: 1, isGM: true });
  assert.ok(result.ok);
  assert.equal(result.usedSwap, false);
});

test("proficiency by weapon or category", () => {
  assert.ok(isProficient(["mar"], "longsword", "mar"));
  assert.ok(isProficient(["longsword"], "longsword", "mar"));
  assert.ok(!isProficient(["sim"], "longsword", "mar"));
});
