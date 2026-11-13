// Unit tests for the builder's pure modules. Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { reviewChanges, countChanges } from "../src/foundry/systems/dnd5e/builder/review-diff.mjs";
import { appendChangeLog, buildChangeLogEntry, changeLogTitle } from "../src/foundry/systems/dnd5e/builder/change-log.mjs";
import { asiState, asiAssignments, multiclassBlockers } from "../src/foundry/systems/dnd5e/builder/asi-math.mjs";

const base = () => ({
  level: 3,
  classes: { fighter: { name: "Fighter", levels: 3, subclass: "Champion" } },
  hpMax: 29,
  abilities: { str: { label: "STR", value: 17 }, con: { label: "CON", value: 14 } },
  size: { key: "med", label: "Medium" },
  skills: { ath: { label: "Athletics", value: 1 }, ste: { label: "Stealth", value: 0 } },
  saves: { str: { label: "Strength", proficient: true }, dex: { label: "Dexterity", proficient: false } },
  profs: { languages: ["Common"], armor: [], weapons: [], tools: [], mastery: ["Club"] },
  items: [{ id: "a", name: "Second Wind", type: "feat", typeLabel: "Feature" }, { id: "c", name: "Fighter", type: "class" }],
  scale: { "fighter.second-wind": { label: "Second Wind", value: "3" } }
});

test("level-up review lists level, HP with method, abilities, items and scale values", () => {
  const before = base();
  const after = structuredClone(before);
  after.level = 4;
  after.classes.fighter.levels = 4;
  after.hpMax = 37;
  after.abilities.str.value = 18;
  after.items.push({ id: "g", name: "Grappler", type: "feat", typeLabel: "Feat" });
  after.scale["fighter.second-wind"].value = "4";
  after.profs.mastery.push("Greatclub");
  const groups = reviewChanges(before, after, { hp: { method: "avg", roll: 6, die: 10, mod: 2 }, stepOf: { hp: 0, "ability:str": 1 } });
  const text = groups.flatMap(g => g.lines.map(l => l.text));
  assert.deepEqual(groups.map(g => g.id), ["level", "hp", "abilities", "proficiencies", "features", "scale"]);
  assert.ok(text.includes("Character level 3 → 4"));
  assert.ok(text.includes("Fighter 3 → 4"));
  assert.ok(text.includes("Max HP 29 → 37 (+8, average 6 + 2 CON)"));
  assert.ok(text.includes("STR 17 → 18"));
  assert.ok(text.includes("+ Grappler (Feat)"));
  assert.ok(text.includes("Second Wind 3 → 4"));
  assert.ok(text.includes("Weapon mastery: + Greatclub"));
  assert.equal(groups.find(g => g.id === "hp").lines[0].step, 0);
  assert.equal(groups.find(g => g.id === "abilities").lines[0].step, 1);
  assert.equal(countChanges(groups), 7);
});

test("rolled HP, new class, subclass, skills, saves, size and removed items", () => {
  const before = base();
  const after = structuredClone(before);
  after.level = 4;
  after.classes.rogue = { name: "Rogue", levels: 1, subclass: "" };
  after.hpMax = 34;
  after.size = { key: "sm", label: "Small" };
  after.skills.ste.value = 2;
  after.saves.dex.proficient = true;
  after.items = after.items.filter(i => i.id !== "a");
  const text = reviewChanges(before, after, { hp: { method: "roll", roll: 3, die: 8, mod: 2 } }).flatMap(g => g.lines.map(l => l.text));
  assert.ok(text.includes("New class: Rogue 1"));
  assert.ok(text.includes("Max HP 29 → 34 (+5, rolled 3 on a d8 + 2 CON)"));
  assert.ok(text.includes("Size: Medium → Small"));
  assert.ok(text.includes("Stealth: expertise"));
  assert.ok(text.includes("Dexterity saving throws: proficient"));
  assert.ok(text.includes("− Second Wind (Feature)"));
});

test("no changes gives an empty review, and a negative CON mod reads as minus", () => {
  assert.deepEqual(reviewChanges(base(), base()), []);
  const before = base();
  before.abilities.con.value = 8; // CON 8: −1, as the HP step showed
  const after = structuredClone(before);
  after.hpMax = 30;
  const text = reviewChanges(before, after, { hp: { method: "roll", roll: 2, die: 6, mod: -1 } })[0].lines[0].text;
  assert.equal(text, "Max HP 29 → 30 (+1, rolled 2 on a d6 − 1 CON)");
});

test("change log keeps newest first, caps length and trims undo data", () => {
  let log = [];
  for (let i = 0; i < 25; i++) {
    const entry = buildChangeLogEntry({ kind: "level-up", user: { id: "u", name: "Pat" }, date: 1000 + i,
      before: { level: i, label: `Fighter ${i}` }, after: { level: i + 1, label: `Fighter ${i + 1}` }, groups: [], undo: { createdItemIds: [String(i)] } });
    log = appendChangeLog(log, entry);
  }
  assert.equal(log.length, 20);
  assert.equal(log[0].after.level, 25);
  assert.ok(log[2].undo);
  assert.equal(log[3].undo, null);
  assert.equal(changeLogTitle(log[0]), "Fighter 24 → Fighter 25");
});

test("ASI screen limits: points, cap, max score, locked abilities, fixed increases", () => {
  const scores = { str: { value: 19, max: 20 }, dex: { value: 14, max: 20 }, cha: { value: 10, max: 20 } };
  let s = asiState({ points: 2, cap: 2, locked: ["cha"] }, scores, {});
  assert.equal(s.remaining, 2);
  assert.ok(s.abilities.str.canIncrease);
  assert.ok(!s.abilities.cha.canIncrease);
  s = asiState({ points: 2, cap: 2 }, scores, { str: 1 });
  assert.ok(!s.abilities.str.canIncrease, "STR is at 20");
  s = asiState({ points: 3, cap: 2 }, scores, { dex: 2 });
  assert.ok(!s.abilities.dex.canIncrease, "cap of 2 per ability");
  assert.equal(s.remaining, 1);
  s = asiState({ points: 2, cap: 2 }, scores, { str: 1, dex: 1 });
  assert.ok(s.complete);
  assert.deepEqual(asiAssignments({ fixed: { con: 1 } }, { str: 1, dex: 0 }), { con: 1, str: 1 });
});

test("multiclass prerequisites: all-of and any-of primary abilities", () => {
  const abilities = { str: 15, dex: 12, wis: 13 };
  assert.deepEqual(multiclassBlockers([{ name: "Fighter", primaryAbility: ["str", "dex"], allRequired: false }], abilities), []);
  assert.equal(multiclassBlockers([{ name: "Monk", primaryAbility: ["dex", "wis"], allRequired: true }], abilities).length, 1);
});

test("review: Spells group lists replaced, prepared, learned, spellbook, always-prepared and warnings", () => {
  const before = base();
  before.items.push(
    { id: "k0", name: "Light", type: "spell", level: 0, prepared: 1, source: "Compendium.x.light" },
    { id: "k1", name: "Sleep", type: "spell", level: 1, prepared: 0, source: "Compendium.x.sleep" });
  const after = structuredClone(before);
  after.items = after.items.filter(i => i.id !== "k0");
  after.items.find(i => i.id === "k1").prepared = 1;
  after.items.push(
    { id: "n1", name: "Mage Hand", type: "spell", level: 0, prepared: 1, source: "Compendium.x.hand" },
    { id: "n2", name: "Fire Bolt", type: "spell", level: 0, prepared: 1, source: "Compendium.x.bolt" },
    { id: "n3", name: "Misty Step", type: "spell", level: 2, prepared: 0, source: "Compendium.x.misty" },
    { id: "n4", name: "Shield of Faith", type: "spell", level: 1, prepared: 2, source: "Compendium.x.sof" },
    { id: "n5", name: "Bless", type: "spell", level: 1, prepared: 1, source: "Compendium.x.bless" });
  const groups = reviewChanges(before, after, { stepOf: { "item:n4": 2 },
    spells: { step: 5, spellbookClass: true, swaps: [{ out: "k0", in: "Compendium.x.hand" }], warnings: [{ kind: "prepared", missing: 1 }, { kind: "cantrips", missing: 2 }] } });
  const spells = groups.find(g => g.id === "spells");
  assert.deepEqual(spells.lines.map(l => [l.text, l.kind, l.step]), [
    ["Replaced Light → Mage Hand", "change", 5],
    ["Prepared Sleep", "gain", 5],
    ["Learned cantrip: Fire Bolt", "gain", 5],
    ["Added to spellbook: Misty Step", "gain", 5],
    ["Always prepared: Shield of Faith", "gain", 2],
    ["Learned Bless", "gain", 5],
    ["Not chosen yet: 1 prepared spell", "warning", 5],
    ["Not chosen yet: 2 cantrips", "warning", 5]
  ]);
  assert.equal(groups.find(g => g.id === "features"), undefined, "spells stay out of Features and items");
});

test("review: unprepared new spells read as spellbook only for spellbook classes; failed picks get a warning", () => {
  const before = base();
  const after = structuredClone(before);
  after.items.push({ id: "f1", name: "Misty Step", type: "spell", level: 2, prepared: 0, source: "Compendium.x.misty" });
  const lines = opts => reviewChanges(before, after, { spells: opts }).find(g => g.id === "spells").lines.map(l => [l.text, l.kind]);
  assert.deepEqual(lines({ step: 1, spellbookClass: false }), [["Learned Misty Step", "gain"]]);
  assert.deepEqual(lines({ step: 1, spellbookClass: true }), [["Added to spellbook: Misty Step", "gain"]]);
  assert.deepEqual(lines({ step: 1, warnings: [{ kind: "failed", missing: 1 }] }).at(-1),
    ["Spell picks couldn't be applied. Open the spell step to choose again.", "warning"]);
});

test("change log: approvedBy is kept (Phase 4b), null by default", () => {
  const plain = buildChangeLogEntry({ kind: "creation", user: { id: "p", name: "Ann" }, date: 1, before: {}, after: {}, groups: [] });
  assert.equal(plain.approvedBy, null);
  const approved = buildChangeLogEntry({ kind: "creation", user: { id: "p", name: "Ann" }, approvedBy: { id: "g", name: "GM", extra: 1 }, date: 1, before: {}, after: {}, groups: [] });
  assert.deepEqual(approved.approvedBy, { id: "g", name: "GM" });
  assert.deepEqual(approved.user, { id: "p", name: "Ann" });
  assert.equal("approvalOf" in plain, false);
  const stamped = buildChangeLogEntry({ kind: "level-up", user: { id: "p", name: "Ann" }, approvalOf: "p|levelUp:a|5", date: 1, before: {}, after: {}, groups: [] });
  assert.equal(stamped.approvalOf, "p|levelUp:a|5", "the submission it approved: a retry finds it and doesn't commit twice");
});

test("hpFromAnswer: the HP review detail follows the applied data.value, not the screen's notes", async () => {
  const { hpFromAnswer } = await import("../src/foundry/systems/dnd5e/builder/review-diff.mjs");
  const notes = { method: "avg", roll: 6, die: 10, mod: 2, modLabel: "CON" };
  assert.deepEqual(hpFromAnswer({ data: { value: 9 }, meta: { hp: notes } }, 10), { method: "roll", roll: 9, die: 10, mod: 2, modLabel: "CON" },
    "a forged method 'avg' doesn't hide a rolled 9");
  assert.deepEqual(hpFromAnswer({ data: { value: "avg" }, meta: { hp: { ...notes, method: "roll", roll: 10 } } }, 10), { method: "avg", roll: 6, die: 10, mod: 2, modLabel: "CON" });
  assert.equal(hpFromAnswer({ data: { value: "avg" } }, 8).roll, 5, "without notes the die comes from the step");
  assert.equal(hpFromAnswer({ data: {} }, 8), null);
  assert.equal(hpFromAnswer(null, 8), null);
});
