// Unit tests for the Phase 3 spell rules. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { maxSpellLevel, owedSpells, sanitizeSpellAnswer, spellProgress, spellWarnings } from "../src/foundry/systems/dnd5e/builder/spell-rules.mjs";

// dnd5e 5.3.2 CONFIG.DND5E.SPELL_SLOT_TABLE and pactCastingProgression
const SLOTS = [[2], [3], [4, 2], [4, 3], [4, 3, 2], [4, 3, 3], [4, 3, 3, 1], [4, 3, 3, 2], [4, 3, 3, 3, 1], [4, 3, 3, 3, 2],
  [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 2, 1, 1, 1],
  [4, 3, 3, 3, 2, 1, 1, 1, 1], [4, 3, 3, 3, 3, 1, 1, 1, 1], [4, 3, 3, 3, 3, 2, 1, 1, 1], [4, 3, 3, 3, 3, 2, 2, 1, 1]];
const PACT = { 1: { slots: 1, level: 1 }, 2: { slots: 2, level: 1 }, 3: { slots: 2, level: 2 }, 5: { slots: 2, level: 3 },
  7: { slots: 2, level: 4 }, 9: { slots: 2, level: 5 }, 11: { slots: 3, level: 5 }, 17: { slots: 4, level: 5 } };
const FULL = { divisor: 1 };
const HALF = { divisor: 2, roundUp: true };
const THIRD = { divisor: 3 };
const caster = (levels, progression = "full") => ({ type: "spell", progression, levels });

test("highest spell level as if single-classed (dnd5e 5.3.2 rounding)", () => {
  assert.equal(maxSpellLevel(caster(3), FULL, SLOTS), 2);
  assert.equal(maxSpellLevel(caster(5), FULL, SLOTS), 3);
  assert.equal(maxSpellLevel(caster(20), FULL, SLOTS), 9);
  assert.equal(maxSpellLevel(caster(1, "half"), HALF, SLOTS), 1, "2024 Paladin and Ranger cast from level 1");
  assert.equal(maxSpellLevel(caster(5, "half"), HALF, SLOTS), 2);
  assert.equal(maxSpellLevel(caster(2, "third"), THIRD, SLOTS), 0, "Eldritch Knight has no spells before 3");
  assert.equal(maxSpellLevel(caster(3, "third"), THIRD, SLOTS), 1);
  assert.equal(maxSpellLevel(caster(7, "third"), THIRD, SLOTS), 2, "single-classed third casters round up");
  assert.equal(maxSpellLevel({ type: "pact", progression: "pact", levels: 4 }, FULL, PACT), 2);
  assert.equal(maxSpellLevel({ type: "pact", progression: "pact", levels: 5 }, FULL, PACT), 3);
  assert.equal(maxSpellLevel({ type: "spell", progression: "none", levels: 5 }, null, SLOTS), 0);
});

test("owed picks for the 2024 core classes", () => {
  const wizard34 = owedSpells({ identifier: "wizard", levelsBefore: 3, levelsAfter: 4, before: { maxPrepared: 6 },
    after: { cantrips: 4, maxPrepared: 7, maxSpellLevel: 2 }, current: { cantrips: 3, prepared: 6, leveled: 10 } });
  assert.deepEqual(wizard34, { cantrips: 1, prepared: 1, carriedOver: 0, spellbook: 2, spellbookClass: true,
    swapCantrip: false, swapSpell: false, maxSpellLevel: 2, hasStep: true }, "2024 Wizards swap cantrips on a Long Rest, not on a level");

  const wizardNew = owedSpells({ identifier: "wizard", levelsBefore: 0, levelsAfter: 1, before: { maxPrepared: 0 },
    after: { cantrips: 3, maxPrepared: 4, maxSpellLevel: 1 }, current: { cantrips: 0, prepared: 0, leveled: 0 } });
  assert.equal(wizardNew.spellbook, 6, "a new Wizard starts with 6 spellbook spells");
  assert.equal(wizardNew.cantrips, 3);
  assert.equal(wizardNew.prepared, 4);
  assert.equal(wizardNew.swapCantrip, false);

  const cleric34 = owedSpells({ identifier: "cleric", levelsBefore: 3, levelsAfter: 4, before: { maxPrepared: 6 },
    after: { cantrips: 4, maxPrepared: 7, maxSpellLevel: 2 }, current: { cantrips: 3, prepared: 6, leveled: 6 } });
  assert.deepEqual([cleric34.cantrips, cleric34.prepared, cleric34.spellbook, cleric34.swapCantrip, cleric34.swapSpell], [1, 1, 0, true, false]);

  const bard45 = owedSpells({ identifier: "bard", levelsBefore: 4, levelsAfter: 5, before: { maxPrepared: 7 },
    after: { cantrips: 3, maxPrepared: 9, maxSpellLevel: 3 }, current: { cantrips: 3, prepared: 7, leveled: 7 } });
  assert.deepEqual([bard45.cantrips, bard45.prepared, bard45.swapSpell, bard45.maxSpellLevel], [0, 2, true, 3]);

  const warlock45 = owedSpells({ identifier: "warlock", levelsBefore: 4, levelsAfter: 5, before: { maxPrepared: 5 },
    after: { cantrips: 3, maxPrepared: 6, maxSpellLevel: 3 }, current: { cantrips: 3, prepared: 5, leveled: 5 } });
  assert.deepEqual([warlock45.prepared, warlock45.swapSpell], [1, true]);

  const paladin12 = owedSpells({ identifier: "paladin", levelsBefore: 1, levelsAfter: 2, before: { maxPrepared: 2 },
    after: { cantrips: 0, maxPrepared: 3, maxSpellLevel: 1 }, current: { cantrips: 0, prepared: 2, leveled: 2 } });
  assert.deepEqual([paladin12.prepared, paladin12.swapCantrip, paladin12.swapSpell, paladin12.hasStep], [1, false, false, true]);
});

test("catch-up, homebrew and non-casters", () => {
  const short = owedSpells({ identifier: "cleric", levelsBefore: 3, levelsAfter: 4, before: { maxPrepared: 6 },
    after: { cantrips: 4, maxPrepared: 7, maxSpellLevel: 2 }, current: { cantrips: 4, prepared: 4, leveled: 4 } });
  assert.deepEqual([short.prepared, short.carriedOver, short.cantrips], [3, 2, 0], "the gap from earlier levels is owed now");

  const homebrew = owedSpells({ identifier: "runesmith", levelsBefore: 2, levelsAfter: 3, before: { maxPrepared: 3 },
    after: { cantrips: 2, maxPrepared: 4, maxSpellLevel: 2 }, current: { cantrips: 2, prepared: 3, leveled: 3 } });
  assert.deepEqual([homebrew.swapCantrip, homebrew.swapSpell, homebrew.spellbook], [true, false, 0]);

  const fighter = owedSpells({ identifier: "fighter", levelsBefore: 3, levelsAfter: 4, before: { maxPrepared: 0 },
    after: { cantrips: 0, maxPrepared: 0, maxSpellLevel: 0 }, current: { cantrips: 0, prepared: 0, leveled: 0 } });
  assert.equal(fighter.hasStep, false);
});

test("sanitizing an answer keeps only picks that still fit", () => {
  const owed = owedSpells({ identifier: "wizard", levelsBefore: 3, levelsAfter: 4, before: { maxPrepared: 6 },
    after: { cantrips: 4, maxPrepared: 7, maxSpellLevel: 2 }, current: { cantrips: 3, prepared: 6, leveled: 10 } });
  const options = new Map([["c1", { level: 0 }], ["c2", { level: 0 }], ["s1", { level: 1 }], ["s2", { level: 2 }], ["s3", { level: 3 }], ["s4", { level: 1 }]]);
  const known = new Map([["k0", { level: 0, prepared: 1 }], ["k1", { level: 1, prepared: 0 }], ["k2", { level: 1, prepared: 1 }], ["kA", { level: 1, prepared: 2 }]]);
  const clean = sanitizeSpellAnswer({
    cantrips: ["c1", "c2", "s1", "gone"],                 // 1 cantrip owed; s1 isn't a cantrip; "gone" isn't offered
    spells: ["s3", "s1", "s2", "s4"],                     // s3 is above level 2; the spellbook owes 2
    prepare: ["item:k2", "item:k1", "s2"],                // k2 is already prepared; 1 prepared owed
    swaps: [{ out: "k0", in: "c2" }, { out: "kA", in: "s4" }, { out: "k1", in: "s4" }] // Wizards swap neither on a level
  }, owed, { options, known });
  assert.deepEqual(clean, { cantrips: ["c1"], spells: ["s1", "s2"], prepare: ["item:k1"], swaps: [] });
  const bard = owedSpells({ identifier: "bard", levelsBefore: 4, levelsAfter: 5, before: { maxPrepared: 7 },
    after: { cantrips: 3, maxPrepared: 9, maxSpellLevel: 3 }, current: { cantrips: 3, prepared: 7, leveled: 7 } });
  const bardClean = sanitizeSpellAnswer({ swaps: [{ out: "k0", in: "c2" }, { out: "kA", in: "s4" }, { out: "k2", in: "s3" }, { out: "k1", in: "s4" }] },
    bard, { options, known });
  assert.deepEqual(bardClean.swaps, [{ out: "k0", in: "c2" }, { out: "k2", in: "s3" }], "one cantrip and one spell; never an always-prepared spell");
  assert.deepEqual(sanitizeSpellAnswer(undefined, owed, { options, known }), { cantrips: [], spells: [], prepare: [], swaps: [] });
});

test("counters and Review warnings", () => {
  const wizard = { cantrips: 1, prepared: 1, spellbook: 2, spellbookClass: true };
  const answer = { cantrips: [], spells: ["a"], prepare: ["a"], swaps: [] };
  assert.deepEqual(spellProgress(wizard, answer), { cantrips: { done: 0, owed: 1 }, prepared: { done: 1, owed: 1 }, spellbook: { done: 1, owed: 2 } });
  assert.deepEqual(spellWarnings(wizard, answer), [{ kind: "cantrips", missing: 1 }, { kind: "spellbook", missing: 1 }]);
  const cleric = { cantrips: 0, prepared: 2, spellbook: 0, spellbookClass: false };
  assert.deepEqual(spellProgress(cleric, { spells: ["x"] }).prepared, { done: 1, owed: 2 });
  assert.deepEqual(spellWarnings(cleric, { spells: ["x", "y"] }), []);
});

test("subclass casters: Eldritch Knight and Arcane Trickster swap a spell on gaining a level", () => {
  const ek = owedSpells({ identifier: "fighter", subclass: "eldritch-knight", levelsBefore: 7, levelsAfter: 8, before: { maxPrepared: 5 },
    after: { cantrips: 2, maxPrepared: 6, maxSpellLevel: 2 }, current: { cantrips: 2, prepared: 5, leveled: 5 } });
  assert.deepEqual([ek.swapSpell, ek.swapCantrip, ek.prepared, ek.spellbook], [true, true, 1, 0]);
  const champion = owedSpells({ identifier: "fighter", subclass: "champion", levelsBefore: 7, levelsAfter: 8, before: { maxPrepared: 0 },
    after: { cantrips: 0, maxPrepared: 0, maxSpellLevel: 0 }, current: { cantrips: 0, prepared: 0, leveled: 0 } });
  assert.equal(champion.hasStep, false);
});
