// The wide tablet character sheet: when it applies, what the D&D5e stats column holds, and how the
// retained shell moves between the standard and wide arrangements. Run: node --test tests/*.test.mjs
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

const { wideCharacterSheet } = await import("../src/kernel/tablet-layout.mjs");
const { arrangeCharacterSheetShell, characterSheetLayout, editableElement, sheetLayoutRefreshBlocked, sheetPageForLayout, sheetTabsForLayout, watchCharacterSheetLayout } = await import("../src/features/characters/sheet-layout.mjs");
const { DND5E_RAIL_PAGES, dnd5eOverviewSections, dnd5eStatsRailSections } = await import("../src/features/characters/systems/dnd5e/sheet-sections.mjs");

const landscape = { formFactor: "tablet", orientation: "landscape", splitScreen: false, status: "ready" };
const ipad11 = { width: 1194, height: 834 };
const pc = { type: "character", abilities: [{ key: "str" }], skills: [{ key: "ath" }], toolProficiencies: [{ key: "thief" }] };

test("a landscape tablet pane that owns the whole width gets the wide sheet at every target size", () => {
  for (const size of [{ width: 1133, height: 744 }, ipad11, { width: 1366, height: 1024 }, { width: 960, height: 600 }]) {
    assert.equal(characterSheetLayout(landscape, pc, size), "wide", `${size.width}x${size.height}`);
  }
});

test("phone, portrait, map Split, Side by side and narrow windows keep the standard sheet", () => {
  assert.equal(characterSheetLayout({ ...landscape, formFactor: "phone" }, pc, ipad11), "standard");
  assert.equal(characterSheetLayout({ ...landscape, orientation: "portrait" }, pc, { width: 834, height: 1194 }), "standard");
  assert.equal(characterSheetLayout({ ...landscape, splitScreen: true }, pc, ipad11), "standard");
  assert.equal(characterSheetLayout({ ...landscape, sheetCompanion: true }, pc, ipad11), "standard");
  assert.equal(characterSheetLayout(landscape, pc, { width: 900, height: 834 }), "standard");
});

test("a short window stays wide, so a soft keyboard shrinking the height never flips the layout", () => {
  assert.equal(characterSheetLayout(landscape, pc, { width: 960, height: 600 }), "wide");
  assert.equal(characterSheetLayout(landscape, pc, { width: 960, height: 280 }), "wide");
  assert.equal(characterSheetLayout(landscape, pc, { width: 1194, height: 400 }), "wide");
});

test("the layout follows the shared contract and ignores an undefined sheetCompanion", () => {
  assert.equal(characterSheetLayout(landscape, pc, ipad11) === "wide", wideCharacterSheet(landscape, ipad11));
  assert.equal(characterSheetLayout({ ...landscape, sheetCompanion: undefined }, pc, ipad11), "wide");
});

test("collective Actors and a missing Actor keep the standard sheet", () => {
  assert.equal(characterSheetLayout(landscape, { type: "group", collective: { members: [] } }, ipad11), "standard");
  assert.equal(characterSheetLayout(landscape, null, ipad11), "standard");
});

test("NPCs get the wide sheet like characters", () => {
  assert.equal(characterSheetLayout(landscape, { type: "npc", abilities: [], skills: [] }, ipad11), "wide");
});

test("in wide mode the Abilities page shows Overview; the requested page is kept for the standard sheet", () => {
  assert.equal(sheetPageForLayout("abilities", "wide", DND5E_RAIL_PAGES), "overview");
  assert.equal(sheetPageForLayout("abilities", "standard", DND5E_RAIL_PAGES), "abilities");
  for (const page of ["favourites", "overview", "effects", "inventory", "party", "spells", "features", "biography"]) {
    assert.equal(sheetPageForLayout(page, "wide", DND5E_RAIL_PAGES), page);
  }
});

test("no D&D5e tab is emptied by the stats column; the tab filter only drops named rail tabs", () => {
  const tabs = [["favourites"], ["overview"], ["inventory"]];
  assert.equal(sheetTabsForLayout(tabs, "wide"), tabs);
  assert.deepEqual(sheetTabsForLayout(tabs, "wide", ["overview"]).map(([key]) => key), ["favourites", "inventory"]);
  assert.equal(sheetTabsForLayout(tabs, "standard", ["overview"]), tabs);
});

test("the stats column holds abilities, skills and tools only when the Actor has them", () => {
  assert.deepEqual(dnd5eStatsRailSections(pc), ["abilities", "skills", "tools"]);
  assert.deepEqual(dnd5eStatsRailSections({ ...pc, toolProficiencies: [] }), ["abilities", "skills"]);
  assert.deepEqual(dnd5eStatsRailSections({ type: "npc", abilities: [{}], skills: [{}] }), ["abilities", "skills"]);
  assert.deepEqual(dnd5eStatsRailSections({ type: "group", collective: {}, abilities: [{}] }), []);
});

test("wide Overview drops the abilities card and keeps effects, traits and weapon masteries", () => {
  assert.deepEqual(dnd5eOverviewSections("standard"), ["effects", "abilities", "traits", "mastery"]);
  assert.deepEqual(dnd5eOverviewSections("wide"), ["effects", "traits", "mastery"]);
});

test("transient editors and surfaces block a presenter-initiated layout re-render", () => {
  assert.equal(sheetLayoutRefreshBlocked(landscape), false);
  for (const key of ["hitPointEditor", "restEditor", "spellSlotEditor", "xpEditor", "characterItemId", "portraitImage", "actionSession", "partySheet", "modeTransition", "reconnect"]) {
    assert.equal(sheetLayoutRefreshBlocked({ ...landscape, [key]: { open: true } }), true, key);
  }
  assert.equal(sheetLayoutRefreshBlocked({ ...landscape, status: "loading" }), true);
  assert.equal(sheetLayoutRefreshBlocked(null), true);
});

// A retained shell as the D&D5e presenter builds it before its first arrangement.
function freshShell() {
  const make = (className) => { const element = document.createElement("div"); element.className = className; return element; };
  const shell = { selector: make("ve-character-selector"), tabBar: make("ve-sheet-tabs"), scroller: make("ve-character-content-scroller"), originBack: null };
  shell.screen = make("ve-character-screen ve-character-shared-shell");
  return shell;
}
const classes = (element) => element.children.map((child) => child.className.split(" ")[0]);

test("the retained shell moves between standard and wide and keeps one scroller, selector and tab bar", () => {
  const shell = freshShell();
  const overlay = document.createElement("div");
  overlay.className = "ve-item-modal";

  assert.equal(arrangeCharacterSheetShell(shell, "standard"), true);
  shell.screen.append(overlay);
  assert.equal(shell.screen.dataset.sheetLayout, "standard");
  assert.deepEqual(classes(shell.screen), ["ve-character-heading", "ve-character-content-scroller", "ve-item-modal"]);
  assert.deepEqual(classes(shell.heading), ["ve-character-selector", "ve-sheet-tabs"]);

  const scroller = shell.scroller;
  assert.equal(arrangeCharacterSheetShell(shell, "wide"), true);
  assert.equal(shell.screen.dataset.sheetLayout, "wide");
  assert.ok(shell.screen.classList.contains("ve-sheet-wide"));
  assert.deepEqual(classes(shell.screen), ["ve-sheet-stats-rail", "ve-sheet-wide-main", "ve-item-modal"]);
  assert.deepEqual(classes(shell.rail), ["ve-character-selector", "ve-sheet-stats-rail-body"]);
  assert.deepEqual(classes(shell.main), ["ve-sheet-tabs", "ve-character-content-scroller"]);
  assert.equal(shell.main.children[1], scroller);
  assert.equal(shell.heading.children.length, 0);

  assert.equal(arrangeCharacterSheetShell(shell, "standard"), true);
  assert.deepEqual(classes(shell.screen), ["ve-character-heading", "ve-character-content-scroller", "ve-item-modal"]);
  assert.equal(shell.screen.children[1], scroller);
  assert.ok(!shell.screen.classList.contains("ve-sheet-wide"));
  assert.deepEqual(classes(shell.rail), ["ve-sheet-stats-rail-body"], "the selector moved back to the heading");
  assert.equal(shell.main.parent, null);
});

test("an unchanged layout leaves the DOM alone so scroll positions survive", () => {
  const shell = freshShell();
  arrangeCharacterSheetShell(shell, "wide");
  const before = [...shell.screen.children];
  assert.equal(arrangeCharacterSheetShell(shell, "wide"), false);
  assert.deepEqual(shell.screen.children, before);
});

test("the origin back button sits at the top of the stats column in wide mode", () => {
  const shell = freshShell();
  shell.originBack = document.createElement("button");
  shell.originBack.className = "ve-sheet-back ve-actor-origin-back";
  arrangeCharacterSheetShell(shell, "wide");
  assert.deepEqual(classes(shell.rail), ["ve-sheet-back", "ve-character-selector", "ve-sheet-stats-rail-body"]);
  arrangeCharacterSheetShell(shell, "standard");
  assert.deepEqual(classes(shell.screen), ["ve-sheet-back", "ve-character-heading", "ve-character-content-scroller"]);
});

// A window whose resize listeners run synchronously through a one-frame debounce.
function fakeView() {
  const listeners = [];
  const frames = [];
  return {
    listeners, frames,
    addEventListener: (type, listener) => listeners.push([type, listener]),
    requestAnimationFrame: (callback) => { frames.push(callback); return frames.length; },
    cancelAnimationFrame: () => {},
    resize() { for (const [type, listener] of listeners) if (type === "resize") listener(); },
    flush() { while (frames.length) frames.shift()(); }
  };
}
function fakeScope() {
  const cleanups = [];
  return { disposed: false, own: (cleanup) => cleanups.push(cleanup), listen: (target, type, listener) => target.addEventListener(type, listener),
    dispose() { this.disposed = true; for (const cleanup of cleanups) cleanup(); } };
}

test("a resize across the threshold re-renders once per frame, and only when the layout changes", () => {
  const view = fakeView();
  const scope = fakeScope();
  const shell = { ...freshShell(), layout: "wide", lastState: landscape };
  let layout = "wide";
  let renders = 0;
  watchCharacterSheetLayout(shell, scope, { readLayout: () => layout, rerender: () => { renders += 1; shell.layout = layout; }, view });
  watchCharacterSheetLayout(shell, scope, { readLayout: () => layout, rerender: () => { renders += 100; }, view });
  assert.equal(view.listeners.length, 1, "one watcher per retained shell");

  view.resize(); view.flush();
  assert.equal(renders, 0, "same layout, no render");

  layout = "standard";
  view.resize(); view.resize(); view.resize();
  assert.equal(view.frames.length, 1);
  view.flush();
  assert.equal(renders, 1);

  layout = "wide";
  shell.lastState = { ...landscape, hitPointEditor: { field: "hp" } };
  view.resize(); view.flush();
  assert.equal(renders, 1, "an open HP editor waits for the next ordinary render");

  shell.lastState = landscape;
  scope.dispose();
  view.resize(); view.flush();
  assert.equal(renders, 1, "a disposed screen scope never renders");
});

test("text inputs, text areas, selects and contenteditable regions count as fields being typed in", () => {
  const field = (tagName, extra = {}) => ({ tagName, ...extra });
  assert.equal(editableElement(field("INPUT")), true);
  assert.equal(editableElement(field("INPUT", { type: "number" })), true);
  assert.equal(editableElement(field("TEXTAREA")), true);
  assert.equal(editableElement(field("SELECT")), true);
  assert.equal(editableElement(field("DIV", { isContentEditable: true })), true);
  assert.equal(editableElement(field("INPUT", { type: "checkbox" })), false);
  assert.equal(editableElement(field("INPUT", { disabled: true })), false);
  assert.equal(editableElement(field("BUTTON")), false);
  assert.equal(editableElement(null), false);
});

test("the layout waits while a sheet field has focus and re-evaluates once focus leaves it", () => {
  const view = fakeView();
  const docListeners = [];
  const doc = { activeElement: null, addEventListener: (type, listener) => docListeners.push([type, listener]) };
  const app = { contains: (element) => element?.inApp === true };
  const shell = { ...freshShell(), layout: "wide", lastState: landscape };
  shell.screen.ownerDocument = doc;
  shell.screen.closest = (selector) => selector === ".ve-mobile-app" ? app : null;
  const scope = fakeScope();
  let layout = "wide";
  let renders = 0;
  watchCharacterSheetLayout(shell, scope, { readLayout: () => layout, rerender: () => { renders += 1; shell.layout = layout; }, view });
  const focusout = () => { for (const [type, listener] of docListeners) if (type === "focusout") listener(); };

  doc.activeElement = { tagName: "INPUT", inApp: true };
  layout = "standard";
  view.resize(); view.flush();
  assert.equal(renders, 0, "a focused currency or HP field keeps its DOM");

  doc.activeElement = { tagName: "TEXTAREA", inApp: true };
  focusout(); view.flush();
  assert.equal(renders, 0, "focus moved to another sheet field");

  doc.activeElement = { tagName: "BODY" };
  focusout(); view.flush();
  assert.equal(renders, 1, "the stale layout is applied once focus leaves");

  layout = "wide";
  doc.activeElement = { tagName: "INPUT", inApp: false };
  view.resize(); view.flush();
  assert.equal(renders, 2, "a field outside the sheet (a native Foundry dialog) does not hold the layout");

  focusout(); view.flush();
  assert.equal(renders, 2, "focusout alone does not re-render when nothing is waiting");
});
