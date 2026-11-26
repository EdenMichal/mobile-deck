// The wide tablet PF2e sheet: what its stats column holds, what each tab keeps, and how the retained
// PF2e shell moves between the standard and wide arrangements. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// The smallest DOM the shell arrangement touches: parented elements with classes, data and children.
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.attributes = {};
    this.dataset = {};
    this.className = "";
    this.children = [];
    this.parent = null;
    const element = this;
    this.classList = {
      toggle(name, force) {
        const names = new Set(element.className.split(/\s+/u).filter(Boolean));
        const on = force ?? !names.has(name);
        if (on) names.add(name); else names.delete(name);
        element.className = [...names].join(" ");
        return on;
      },
      contains: (name) => element.className.split(/\s+/u).includes(name)
    };
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { for (const child of nodes) { child.remove?.(); child.parent = this; this.children.push(child); } }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.parent = null; this.children = []; this.append(...nodes); }
  remove() { if (!this.parent) return; this.parent.children = this.parent.children.filter((child) => child !== this); this.parent = null; }
  addEventListener() {}
  get isConnected() { return true; }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: (tag) => new FakeElement(tag), createTextNode: (text) => ({ text }) };

const { arrangeCharacterSheetShell, characterSheetLayout, sheetPageForLayout, sheetTabsForLayout } = await import("../src/features/characters/sheet-layout.mjs");
const { pf2eOverviewSections, pf2eProficiencySections, pf2eRailPages, pf2eRailTabs, pf2eStatsRailSections, pf2eSupplementaryProficiencies } = await import("../src/features/characters/systems/pf2e/sheet-sections.mjs");

const landscape = { formFactor: "tablet", orientation: "landscape", splitScreen: false, status: "ready" };
const ipad11 = { width: 1194, height: 834 };
const PF2E_TABS = ["overview", "features", "inventory", "crafting", "spells", "abilities", "feats", "effects", "biography", "society"].map((key) => [key]);
const proficiency = (group, label, rank) => ({ group, label, rank });
function character({ saves = true, attributes = true, skills = true, lores = true, proficiencies = true } = {}) {
  return { type: "character", pf2e: {
    saves: saves ? [{ slug: "fortitude" }, { slug: "reflex" }, { slug: "will" }] : [],
    attributes: attributes ? [{ slug: "str", modifier: 4 }] : [],
    skills: [...(skills ? [{ slug: "athletics" }] : []), ...(lores ? [{ slug: "warfare-lore", lore: true }] : [])],
    details: { proficiencies: proficiencies ? [proficiency("attacks", "Martial", 2), proficiency("defenses", "Heavy", 1), proficiency("classDCs", "Fighter", 1)] : [] }
  } };
}

test("a PF2e character on a landscape tablet that owns the pane gets the wide sheet; Split and Side by side do not", () => {
  assert.equal(characterSheetLayout(landscape, character(), ipad11), "wide");
  assert.equal(characterSheetLayout(landscape, character(), { width: 960, height: 600 }), "wide");
  assert.equal(characterSheetLayout({ ...landscape, splitScreen: true }, character(), ipad11), "standard");
  assert.equal(characterSheetLayout({ ...landscape, sheetCompanion: true }, character(), ipad11), "standard");
  assert.equal(characterSheetLayout({ ...landscape, orientation: "portrait" }, character(), { width: 834, height: 1194 }), "standard");
  assert.equal(characterSheetLayout(landscape, null, ipad11), "standard", "the chooser notice keeps the standard heading");
});

test("the stats column holds saves and attributes, skills, then lores, each only when the Actor has some", () => {
  assert.deepEqual(pf2eStatsRailSections(character()), ["statistics", "skills", "lores"]);
  assert.deepEqual(pf2eStatsRailSections(character({ lores: false })), ["statistics", "skills"]);
  assert.deepEqual(pf2eStatsRailSections(character({ skills: false })), ["statistics", "lores"]);
  assert.deepEqual(pf2eStatsRailSections(character({ saves: false })), ["statistics", "skills", "lores"], "attributes alone still fill the card");
  assert.deepEqual(pf2eStatsRailSections(character({ saves: false, attributes: false, skills: false, lores: false })), []);
  assert.deepEqual(pf2eStatsRailSections({ type: "character" }), []);
  assert.deepEqual(pf2eStatsRailSections({ type: "party", collective: {}, pf2e: character().pf2e }), []);
  assert.deepEqual(pf2eStatsRailSections(null), []);
});

test("the Proficiencies tab keeps weapon, armour and class DC rows and drops untrained categories", () => {
  const actor = character();
  actor.pf2e.details.proficiencies.push(proficiency("attacks", "Unarmed", 0), proficiency("defenses", "Unarmored", 0), proficiency("classDCs", "Spell", 0), proficiency("other", "Stray", 2));
  assert.deepEqual(pf2eSupplementaryProficiencies(actor).map((row) => row.label), ["Martial", "Heavy", "Fighter", "Spell"]);
  assert.deepEqual(pf2eSupplementaryProficiencies({}), []);
});

test("wide mode keeps the Proficiencies tab while it has weapon, armour or class DC rows", () => {
  const actor = character();
  assert.deepEqual(pf2eRailPages(actor), {});
  assert.deepEqual(pf2eRailTabs(actor), []);
  assert.equal(sheetPageForLayout("abilities", "wide", pf2eRailPages(actor)), "abilities");
  assert.equal(sheetTabsForLayout(PF2E_TABS, "wide", pf2eRailTabs(actor)).length, PF2E_TABS.length);
});

test("wide mode hides an otherwise empty Proficiencies tab and shows Character; the standard sheet keeps it", () => {
  const actor = character({ proficiencies: false });
  actor.pf2e.details.proficiencies = [proficiency("attacks", "Simple", 0)];
  assert.deepEqual(pf2eRailTabs(actor), ["abilities"]);
  assert.equal(sheetPageForLayout("abilities", "wide", pf2eRailPages(actor)), "overview");
  assert.equal(sheetPageForLayout("abilities", "standard", pf2eRailPages(actor)), "abilities");
  assert.deepEqual(sheetTabsForLayout(PF2E_TABS, "wide", pf2eRailTabs(actor)).map(([key]) => key), PF2E_TABS.map(([key]) => key).filter((key) => key !== "abilities"));
  assert.equal(sheetTabsForLayout(PF2E_TABS, "standard", pf2eRailTabs(actor)), PF2E_TABS);
  for (const page of ["overview", "features", "inventory", "crafting", "spells", "feats", "effects", "biography", "society"]) {
    assert.equal(sheetPageForLayout(page, "wide", pf2eRailPages(actor)), page);
  }
});

test("wide tabs leave out what the stats column shows and keep everything else", () => {
  assert.deepEqual(pf2eOverviewSections("standard"), ["statistics", "defenses", "details", "tools"]);
  assert.deepEqual(pf2eOverviewSections("wide"), ["defenses", "details", "tools"]);
  assert.deepEqual(pf2eProficiencySections("standard"), ["skills", "lores", "proficiencies"]);
  assert.deepEqual(pf2eProficiencySections("wide"), ["proficiencies"]);
});

// A retained shell as the PF2e presenter builds it: its own heading, already mounted with the scroller.
function pf2eShell() {
  const make = (className) => { const element = document.createElement("div"); element.className = className; return element; };
  const shell = { screen: make("ve-character-screen ve-character-shared-shell ve-pf2e-character-screen"),
    heading: make("ve-character-heading ve-pf2e-character-heading"), scroller: make("ve-character-content-scroller"),
    panelHost: make("ve-sheet-panel ve-pf2e-sheet-panel"), selector: make("ve-character-selector ve-pf2e-character-selector"), tabBar: make("ve-sheet-tabs ve-pf2e-tabs") };
  shell.heading.dataset.headerLayout = "intrinsic";
  shell.scroller.append(shell.panelHost);
  shell.screen.append(shell.heading, shell.scroller);
  shell.heading.append(shell.selector, shell.tabBar);
  return shell;
}
const classes = (element) => element.children.map((child) => child.className.split(" ").at(-1));

test("the PF2e shell keeps its own heading, panel host and single scroller across wide and standard", () => {
  const shell = pf2eShell();
  const { heading, scroller, panelHost } = shell;
  const overlay = document.createElement("div");
  overlay.className = "ve-roll-result";
  shell.screen.append(overlay);

  assert.equal(arrangeCharacterSheetShell(shell, "standard"), true);
  assert.equal(shell.heading, heading, "the PF2e heading with its intrinsic header layout is reused");
  assert.deepEqual(classes(shell.screen), ["ve-pf2e-character-heading", "ve-character-content-scroller", "ve-roll-result"]);

  assert.equal(arrangeCharacterSheetShell(shell, "wide"), true);
  assert.deepEqual(classes(shell.screen), ["ve-sheet-stats-rail", "ve-sheet-wide-main", "ve-roll-result"]);
  assert.deepEqual(classes(shell.rail), ["ve-pf2e-character-selector", "ve-sheet-stats-rail-body"]);
  assert.deepEqual(classes(shell.main), ["ve-pf2e-tabs", "ve-character-content-scroller"]);
  assert.equal(shell.main.children[1], scroller);
  assert.equal(scroller.children[0], panelHost, "the panel host stays inside the one scroller");
  assert.equal(heading.parent, null);

  assert.equal(arrangeCharacterSheetShell(shell, "standard"), true);
  assert.deepEqual(classes(shell.screen), ["ve-pf2e-character-heading", "ve-character-content-scroller", "ve-roll-result"]);
  assert.deepEqual(classes(heading), ["ve-pf2e-character-selector", "ve-pf2e-tabs"]);
  assert.equal(heading.dataset.headerLayout, "intrinsic");
  assert.equal(shell.screen.dataset.sheetLayout, "standard");
});
