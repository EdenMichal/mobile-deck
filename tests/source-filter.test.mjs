// Unit tests for the allowed-sources rules. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { allowEntry, collectBooks, dedupe, effectiveRules, houseRules, isBanned, NO_BOOK, packInUse, replacementFor, resolvePacks, sourceType } from "../src/foundry/systems/dnd5e/builder/source-filter.mjs";

const packs = [
  { collection: "dnd5e.classes24", label: "Classes (2024)", packageType: "system" },
  { collection: "dnd5e.classes", label: "Classes (SRD)", packageType: "system" },
  { collection: "world.ddb-classes", label: "DDB Classes", packageType: "world" },
  { collection: "world.homebrew", label: "Homebrew", packageType: "world" }
];
const item = (name, rules = "", book = "", type = "feat", identifier = "") => ({ name, type, system: { identifier, source: { rules, book } } });

test("packs follow dnd5e's Compendium Browser Sources until the GM changes them, highest priority first", () => {
  const resolved = resolvePacks(packs, { packs: { "world.homebrew": { priority: 50 } } }, { "dnd5e.classes": false });
  assert.deepEqual(resolved.map(p => p.collection), ["world.homebrew", "world.ddb-classes", "dnd5e.classes24", "dnd5e.classes"]);
  assert.equal(resolved.find(p => p.collection === "dnd5e.classes").enabled, false);
  assert.equal(resolved.find(p => p.collection === "dnd5e.classes24").enabled, true);
  const own = resolvePacks(packs, { packs: { "dnd5e.classes": { enabled: true } } }, { "dnd5e.classes": false });
  assert.equal(own.find(p => p.collection === "dnd5e.classes").enabled, true, "GM choice beats dnd5e's setting");
});

test("rules: world default, explicit edition, both; unknown editions stay visible", () => {
  const [p] = resolvePacks([packs[0]]);
  assert.equal(effectiveRules({ rules: "world" }, "2014"), "2014");
  assert.ok(allowEntry(item("Grappler", "2024"), p, { rules: "world" }, "2024"));
  assert.ok(!allowEntry(item("Grappler", "2014"), p, { rules: "world" }, "2024"));
  assert.ok(allowEntry(item("Grappler", "2014"), p, { rules: "both" }));
  assert.ok(allowEntry(item("Homebrew Feat"), p, { rules: "2014" }), "no edition = visible");
  const tagged = { ...p, rules: "2014" };
  assert.ok(!allowEntry(item("Old Feat"), tagged, { rules: "2024" }), "pack tag fills in a missing edition");
  assert.ok(!allowEntry(item("X", "2024"), { ...p, enabled: false }, { rules: "both" }));
});

test("books: switched-off books hide their items, including items with no book", () => {
  const [p] = resolvePacks([packs[0]]);
  const saved = { rules: "both", books: { "XGtE": false, [NO_BOOK]: false } };
  assert.ok(!allowEntry(item("Shadow Touched", "2014", "XGtE"), p, saved));
  assert.ok(allowEntry(item("Grappler", "2024", "PHB 2024"), p, saved));
  assert.ok(!allowEntry(item("Mystery"), p, saved));
  assert.deepEqual(collectBooks([{ entry: item("a", "", "XGtE") }, { entry: item("b") }, { entry: item("c", "", "PHB 2024") }, { entry: item("d", "", "XGtE") }]),
    [{ key: "PHB 2024", count: 1 }, { key: "XGtE", count: 2 }, { key: NO_BOOK, count: 1 }]);
});

test("duplicates keep the highest-priority pack; same-named items inside one pack all stay", () => {
  const resolved = resolvePacks(packs);
  const ddb = resolved.find(p => p.collection === "world.ddb-classes");
  const srd = resolved.find(p => p.collection === "dnd5e.classes24");
  const result = dedupe([
    { entry: item("Fighter", "2024", "", "class"), pack: srd },
    { entry: item("Fighter", "2024", "", "class"), pack: ddb },
    { entry: item("Extra Attack", "2024"), pack: srd },
    { entry: item("Extra Attack", "2024"), pack: srd },
    { entry: item("Grappler", "2014"), pack: srd },
    { entry: item("Grappler", "2024"), pack: srd }
  ]);
  assert.deepEqual(result.map(c => `${c.entry.name}@${c.pack.collection}`),
    ["Fighter@world.ddb-classes", "Extra Attack@dnd5e.classes24", "Extra Attack@dnd5e.classes24", "Grappler@dnd5e.classes24", "Grappler@dnd5e.classes24"]);
});

test("a feature granted from a switched-off pack is swapped for the allowed copy, when unambiguous", () => {
  const resolved = resolvePacks(packs, { packs: { "dnd5e.classes24": { enabled: false } } });
  const off = resolved.find(p => p.collection === "dnd5e.classes24");
  const ddb = resolved.find(p => p.collection === "world.ddb-classes");
  const original = { entry: item("Second Wind", "2024"), pack: off };
  assert.equal(replacementFor(original, [{ entry: item("Second Wind", "2024"), pack: ddb }]).pack.collection, "world.ddb-classes");
  assert.equal(replacementFor(original, []), null, "no copy: keep the class's own feature");
  assert.equal(replacementFor(original, [{ entry: item("Extra", "2024"), pack: ddb }]), null);
  assert.equal(replacementFor(original, [{ entry: item("Second Wind", "2024"), pack: ddb }, { entry: item("Second Wind", "2024"), pack: ddb }]), null, "ambiguous");
  assert.equal(replacementFor({ ...original, pack: ddb }, [{ entry: item("Second Wind", "2024"), pack: ddb }]), null, "allowed pack: keep");
});

test("per-type sources: which type an entry is", () => {
  assert.equal(sourceType(item("Wizard", "", "", "class")), "classes");
  assert.equal(sourceType(item("Evoker", "", "", "subclass")), "subclasses");
  assert.equal(sourceType(item("Elf", "", "", "race")), "species");
  assert.equal(sourceType(item("Sage", "", "", "background")), "backgrounds");
  assert.equal(sourceType(item("Fireball", "", "", "spell")), "spells");
  assert.equal(sourceType({ name: "Alert", type: "feat", system: { type: { value: "feat" } } }), "feats");
  assert.equal(sourceType({ name: "Second Wind", type: "feat", system: { type: { value: "class" } } }), "", "class features follow the global sources");
  for (const t of ["weapon", "equipment", "tool", "consumable", "loot", "container"]) assert.equal(sourceType(item("x", "", "", t)), "equipment");
});

test("per-type sources: a customised type uses its own compendiums and books; other types keep the global ones", () => {
  const resolved = resolvePacks(packs, { packs: { "world.homebrew": { enabled: false } } });
  const srd = resolved.find(p => p.collection === "dnd5e.classes24");
  const brew = resolved.find(p => p.collection === "world.homebrew");
  const spell = (name, book) => ({ name, type: "spell", system: { source: { rules: "2024", book } } });
  const bg = (name, book) => ({ name, type: "background", system: { source: { rules: "2024", book } } });
  const saved = { rules: "both", books: { "XGtE": false }, types: {
    spells: { custom: true, packs: { "world.homebrew": true, "dnd5e.classes24": false }, books: { "XGtE": true } },
    backgrounds: { custom: true, packs: {}, books: { "PHB 2024": true, "FRHoF": false } },
    feats: { custom: false, packs: { "dnd5e.classes24": false } }
  } };
  assert.ok(allowEntry(spell("Homebrew Bolt"), brew, saved), "a type can switch on a compendium that is off globally");
  assert.ok(!allowEntry(spell("Fireball", "PHB 2024"), srd, saved), "…and switch off one that is on");
  assert.ok(!allowEntry(bg("Hermit"), brew, saved), "other types keep the global compendium switch");
  assert.ok(allowEntry(spell("Silvery Barbs", "XGtE"), brew, saved), "a type can allow a book that is off globally");
  assert.ok(!allowEntry(bg("Faction Agent", "FRHoF"), srd, saved), "a type can switch off a book");
  assert.ok(allowEntry(bg("Sage", "PHB 2024"), srd, saved));
  assert.ok(!allowEntry(bg("Guild Artisan", "XGtE"), srd, saved), "a book the type never set follows the global switch");
  assert.ok(allowEntry({ name: "Alert", type: "feat", system: { type: { value: "feat" }, source: { rules: "2024" } } }, srd, saved), "custom: false = global");
  assert.ok(packInUse(brew, saved), "a pack off globally is still read when a type uses it");
  assert.ok(!packInUse(brew, { types: { spells: { custom: false, packs: { "world.homebrew": true } } } }));
  // A feature granted from a pack its type switched off is swapped for the allowed copy.
  const original = { entry: spell("Fireball", "PHB 2024"), pack: srd };
  assert.equal(replacementFor(original, [{ entry: spell("Fireball", "PHB 2024"), pack: brew }], saved).pack.collection, "world.homebrew");
  assert.equal(replacementFor(original, [{ entry: spell("Fireball", "PHB 2024"), pack: brew }]), null, "without the saved sources, the global switch decides");
});

test("house rules default to everything allowed, and bans match identifiers", () => {
  const rules = houseRules({ bannedClasses: ["monk"] });
  assert.equal(rules.multiclass, true);
  assert.ok(isBanned({ type: "class", system: { identifier: "monk" } }, rules));
  assert.ok(!isBanned({ type: "subclass", system: { identifier: "monk" } }, rules));
});

test("house rules: ability methods default to Standard Array only, rerolls 0, nested merge keeps defaults", () => {
  const d = houseRules(undefined);
  assert.deepEqual(d.abilityMethods, { standardArray: true, pointBuy: false, roll: false, manual: false });
  assert.equal(d.abilityRerolls, 0);
  const saved = houseRules({ abilityMethods: { roll: true }, abilityRerolls: 2 });
  assert.deepEqual(saved.abilityMethods, { standardArray: true, pointBuy: false, roll: true, manual: false });
  assert.equal(saved.abilityRerolls, 2);
});

test("house rules: \"any language\" is on by default, also for worlds saved before it existed, and can be switched off", () => {
  assert.equal(houseRules(undefined).anyLanguage, true);
  assert.equal(houseRules({ multiclass: false, abilityRerolls: 1 }).anyLanguage, true);
  assert.equal(houseRules({ anyLanguage: false }).anyLanguage, false);
});

test("house rules: GM approval switches default on and merge per kind", () => {
  assert.deepEqual(houseRules(undefined).approval, { creation: true, levelUp: true });
  assert.deepEqual(houseRules({ approval: { levelUp: false } }).approval, { creation: true, levelUp: false });
  assert.deepEqual(houseRules({ multiclass: false }).approval, { creation: true, levelUp: true });
});
