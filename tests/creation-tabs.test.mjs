// Unit tests for creation-tabs.mjs (Phase 4a). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { TABS, CREATION_VERSION, emptyDraft, emptyRolls, normalizeRolls, setPick, tabStates, groupSpecies, abilityGroup, traitsOf }
  from "../src/foundry/systems/dnd5e/builder/creation-tabs.mjs";

test("empty draft has every tab and no picks", () => {
  const d = emptyDraft({ owner: "u1" });
  assert.equal(d.owner, "u1");
  assert.equal(d.tabs.class, null);
  assert.equal(d.version, CREATION_VERSION);
  // Rolls live apart from the draft (Start over and pick changes can't reroll).
  assert.equal(d.rolls, undefined);
  assert.equal(d.wealthRolls, undefined);
  assert.deepEqual(TABS, ["class", "background", "species", "abilities", "equipment", "spells", "details", "review"]);
});

test("a new class clears its answers and its equipment; same pick changes nothing", () => {
  let d = emptyDraft();
  d.tabs.class = { uuid: "C1", answers: [{ key: "k", data: {} }] };
  d.tabs.equipment = { class: { option: "A" }, background: { option: "B" } };
  const same = setPick(d, "class", "C1");
  assert.deepEqual(same.cleared, []);
  const { draft, cleared } = setPick(d, "class", "C2");
  assert.deepEqual(draft.tabs.class, { uuid: "C2", answers: [] });
  assert.equal(draft.tabs.equipment.class, undefined);
  assert.deepEqual(draft.tabs.equipment.background, { option: "B" });
  assert.deepEqual(cleared, ["class", "equipment.class"]);
  assert.equal(d.tabs.class.uuid, "C1"); // input untouched
});

test("a new background clears its equipment, not the class", () => {
  const d = emptyDraft();
  d.tabs.background = { uuid: "B1", answers: [] };
  d.tabs.equipment = { class: { option: "A" }, background: { option: "A" } };
  const { draft, cleared } = setPick(d, "background", "B2");
  assert.equal(draft.tabs.equipment.background, undefined);
  assert.deepEqual(draft.tabs.equipment.class, { option: "A" });
  assert.deepEqual(cleared, ["equipment.background"]);
});

test("tab states", () => {
  const d = emptyDraft();
  let s = tabStates(d, { missing: [], hasSpells: false, abilitiesDone: false, equipmentDone: false });
  assert.equal(s.class, "todo");
  assert.equal(s.spells, "hidden");
  assert.equal(s.details, "todo");
  assert.equal(s.review, "todo");
  d.tabs.class = { uuid: "C", answers: [] };
  d.tabs.background = { uuid: "B", answers: [] };
  d.tabs.abilities = { method: "standardArray" };
  d.tabs.equipment = { class: { option: "A" } };
  d.tabs.details.name = "Mirela";
  s = tabStates(d, { missing: [{ tab: "background", kind: "step" }, { tab: "spells", kind: "step" }], hasSpells: true, abilitiesDone: false, equipmentDone: false });
  assert.equal(s.class, "done");
  assert.equal(s.background, "attention");
  assert.equal(s.spells, "attention");
  assert.equal(s.abilities, "attention");
  assert.equal(s.equipment, "attention");
  assert.equal(s.details, "done");
  assert.equal(s.review, "attention");
});

test("species variants group under their base name", () => {
  const groups = groupSpecies([
    { uuid: "e1", name: "Elf, Drow", img: "d.png", packLabel: "SRD" },
    { uuid: "h", name: "Human", img: "h.png", packLabel: "SRD" },
    { uuid: "e2", name: "Elf, Wood", img: "w.png", packLabel: "SRD" }
  ]);
  assert.deepEqual(groups.map(g => [g.name, g.variants.map(v => v.name)]), [["Elf", ["Drow", "Wood"]], ["Human", ["Human"]]]);
  assert.equal(groups[0].variants[0].uuid, "e1");
});

test("ability review group and trait answers", () => {
  const g = abilityGroup({ method: "Standard Array", labels: { str: "STR", dex: "DEX", con: "CON", int: "INT", wis: "WIS", cha: "CHA" },
    base: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 }, bonus: { str: 2, con: 1 }, final: { str: 17, dex: 14, con: 14, int: 8, wis: 10, cha: 12 } },
    (k, f, d = {}) => f.replace(/\{(\w+)\}/g, (m, x) => d[x] ?? m));
  assert.equal(g.id, "abilities");
  assert.equal(g.lines[0].text, "Method: Standard Array");
  assert.equal(g.lines[1].text, "STR 15 + 2 = 17");
  assert.equal(g.lines[2].text, "DEX 14");
  assert.equal(g.lines[1].step, "abilities");
  const rolled = abilityGroup({ method: "Roll in Foundry", labels: { str: "STR" }, base: { str: 16 }, final: { str: 16 }, sets: [[9, 10, 11, 12, 13, 16], [8, 9, 10, 11, 12, 16]] },
    (k, f, d = {}) => f.replace(/\{(\w+)\}/g, (m, x) => d[x] ?? m));
  assert.deepEqual(rolled.lines.slice(1, 3).map(l => l.text), ["Rolled set 1: 9, 10, 11, 12, 13, 16 (in chat)", "Rolled set 2: 8, 9, 10, 11, 12, 16 (in chat)"]);
  assert.deepEqual(traitsOf({ answers: [{ data: { chosen: ["tool:music:lute"] } }, { data: { selected: ["x"] } }] }), ["tool:music:lute"]);
});

test("creation rolls: empty shape, and saved data normalized", () => {
  assert.deepEqual(emptyRolls(), { abilities: { sets: [], rerollsUsed: 0, messageIds: [] }, gold: {}, trinket: null });
  assert.deepEqual(normalizeRolls(null), emptyRolls());
  assert.deepEqual(normalizeRolls("junk"), emptyRolls());
  const r = normalizeRolls({ abilities: { sets: [[3, 4, 5, 6, 7, 8], "bad", [1, 2]], rerollsUsed: "2", messageIds: ["m1"] },
    gold: { "Compendium.x.Item.bard": { value: 120, messageId: "m2" }, bad: { value: "x" } }, trinket: { text: "A tooth", messageId: "m3" } });
  assert.deepEqual(r.abilities, { sets: [[3, 4, 5, 6, 7, 8]], rerollsUsed: 2, messageIds: ["m1"] });
  assert.deepEqual(r.gold, { "Compendium.x.Item.bard": { value: 120, messageId: "m2" } });
  assert.deepEqual(r.trinket, { text: "A tooth", messageId: "m3" });
  assert.equal(normalizeRolls({ trinket: { text: "" } }).trinket, null);
});

test("abilities: unspent point-buy points need attention (a warning, not a blocker)", () => {
  const d = emptyDraft();
  d.tabs.abilities = { method: "pointBuy", pointBuy: {} };
  assert.equal(tabStates(d, { abilitiesDone: true, abilitiesUnspent: true }).abilities, "attention");
  assert.equal(tabStates(d, { abilitiesDone: true, abilitiesUnspent: false }).abilities, "done");
});

test("ability review group lists every rolled set, whatever the method", () => {
  const t = (k, f, d = {}) => f.replace(/\{(\w+)\}/g, (m, x) => d[x] ?? m);
  const g = abilityGroup({ method: "Point Buy", labels: { str: "STR" }, base: { str: 15 }, final: { str: 15 }, sets: [[9, 10, 11, 12, 13, 16]] }, t);
  assert.equal(g.lines[1].text, "Rolled set 1: 9, 10, 11, 12, 13, 16 (in chat)");
});

test("species from dnd5e and from DDB books: one card per species, one choice per lineage (the book's copy)", async () => {
  const { readFileSync } = await import("node:fs");
  const { speciesParts } = await import("../src/foundry/systems/dnd5e/builder/creation-tabs.mjs");
  const fx = JSON.parse(readFileSync(new URL("./fixtures/origin-samples.json", import.meta.url), "utf8"));
  // What a 2024 world shows: dnd5e's Character Origins (priority 10) and the DDB 2024 species (a world pack, 30).
  const srd = fx.srdSpecies2024.map(name => ({ uuid: `srd:${name}`, name, img: "", packLabel: "SRD 5.2", rules: "2024", priority: 10 }));
  const ddb = fx.speciesIndex.filter(r => r.flags.ddbimporter?.is2024).map(r => ({ uuid: `ddb:${r.name}`, name: r.name, img: "", packLabel: r.book,
    rules: "2024", priority: 30, flags: r.flags, book: r.book }));
  // findEntries already keeps one of each same-named pair ("Dwarf", "Goliath"…): the book's.
  const names = new Set(ddb.map(e => e.name));
  const groups = groupSpecies([...srd.filter(e => !names.has(e.name)), ...ddb]);
  const card = name => groups.find(g => g.name === name);
  assert.deepEqual(card("Elf").variants.map(v => [v.name, v.uuid]), [["Drow", "ddb:Elf (Drow)"], ["High", "ddb:High Elf"], ["Wood", "ddb:Wood Elf"]]);
  assert.deepEqual(card("Gnome").variants.map(v => [v.name, v.source]), [["Forest", "PHB 2024"], ["Rock", "PHB 2024"]]);
  // DDB spells it "Cthonic", dnd5e "Chthonic": still one lineage.
  assert.deepEqual(card("Tiefling").variants.map(v => v.fullName), ["Tiefling (Abyssal)", "Tiefling (Cthonic)", "Tiefling (Infernal)"]);
  assert.ok(!groups.some(g => /^(High Elf|Wood Elf|Elf \(Drow\)|Forest Gnome|Rock Gnome|Tiefling \()/.test(g.name)), groups.map(g => g.name));
  assert.equal(card("Goliath").variants.length, 1);
  assert.equal(card("Goliath").source, "PHB 2024", "a one-option card shows its book");
  // Without the books, dnd5e's lineages stand as before.
  assert.deepEqual(groupSpecies(srd).find(g => g.name === "Tiefling").variants.map(v => v.name), ["Abyssal", "Chthonic", "Infernal"]);
  // Older DDB versions of a species join its card by their full names; a lineage of another edition stays separate.
  const old = fx.speciesIndex.filter(r => /^Goliath|^Wood Elf/.test(r.name)).map(r => ({ uuid: r.name, name: r.name, img: "", packLabel: r.book,
    rules: r.flags.ddbimporter?.is2024 ? "2024" : "2014", priority: 30, flags: r.flags, book: r.book }));
  const both = groupSpecies(old);
  assert.deepEqual(both.find(g => g.name === "Goliath").variants.map(v => v.name), ["Goliath", "Goliath (EE)", "Goliath (MotM)"]);
  assert.deepEqual(both.find(g => g.name === "Elf").variants.map(v => v.fullName), ["Wood Elf", "Wood Elf (PHB)"]);
  assert.deepEqual(speciesParts({ name: "Hill Dwarf (PHB)", book: "PHB", flags: { ddbimporter: { baseRaceName: "Dwarf", subRaceShortName: "Hill" } } }), { base: "Dwarf", variant: "Hill" });
  assert.deepEqual(speciesParts({ name: "Dhampir" }), { base: "Dhampir", variant: "" }, "homebrew without DDB flags");
});
