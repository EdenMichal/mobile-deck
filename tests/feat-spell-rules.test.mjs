// Unit tests for featSpellRule: feats whose spells have no advancement. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { featSpellRule } from "../src/foundry/systems/dnd5e/builder/spell-rules.mjs";

test("Cultist Initiate: two Warlock cantrips and a level 1 spell, back on a Short Rest", () => {
  for (const id of ["cultist-initiate", "cult-initiate"]) {
    assert.deepEqual(featSpellRule(id), { list: "warlock", cantrips: 2, spells: 1, abilities: ["int", "wis", "cha"], recovery: "sr" });
  }
});

test("Magic Initiate keeps its Long Rest recovery (no recovery key)", () => {
  assert.equal(featSpellRule("magic-initiate-warlock").recovery, undefined);
  assert.equal(featSpellRule("magic-initiate-warlock").list, "warlock");
});
