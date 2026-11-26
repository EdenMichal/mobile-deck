// Side by side on landscape tablets: the sheet pinned beside Chat, Journals or Combat. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { initialAppState, reduceAppState } from "../src/kernel/app-state.mjs";
import { COMPANION_ROUTES, companionPaneActive, companionRoute, routeVisible, tabletLayoutMode, visibleCompanionRoute, wideCharacterSheet } from "../src/kernel/tablet-layout.mjs";
import { createVeBackDispatcher } from "../src/ui/ve-back-dispatcher.mjs";
import { veCloseWatcherLayers } from "../src/ui/ve-close-watcher-back.mjs";
import { createActionSceneReturn } from "../src/kernel/action-scene-return.mjs";
import { ACTOR_COMMANDS } from "../src/kernel/command-names.mjs";
import { chatPresentation } from "../src/foundry/native-chat-gateway.mjs";
import { companionPaneChanged, mainPaneJournalChanged, snapshotPresentationChangedForRoute } from "../src/ui/app-frame.mjs";
import { controlsGuideSections } from "../src/kernel/controls-guide-model.mjs";

const reduce = (state, ...events) => events.reduce((current, event) => reduceAppState(current, event), state);
const layout = (formFactor, orientation, canvasAvailable = true) => ({ type: "layout-policy-changed", formFactor, orientation, canvasAvailable });
const landscape = (canvasAvailable = true) => reduce({ ...initialAppState, status: "ready", snapshot: {} }, layout("tablet", "landscape", canvasAvailable));
const sideBySide = (state = landscape()) => reduce(state.splitScreen ? reduce(state, { type: "toggle-split-screen" }) : state, { type: "toggle-sheet-companion" });

test("tabletLayoutMode names every layout, and map Split wins if both flags are ever set", () => {
  assert.equal(tabletLayoutMode({ formFactor: "phone" }), "phone");
  assert.equal(tabletLayoutMode({ formFactor: "tablet", orientation: "portrait", sheetCompanion: true }), "portrait");
  assert.equal(tabletLayoutMode({ formFactor: "tablet", orientation: "landscape", splitScreen: true }), "map-split");
  assert.equal(tabletLayoutMode({ formFactor: "tablet", orientation: "landscape", sheetCompanion: true }), "companion");
  assert.equal(tabletLayoutMode({ formFactor: "tablet", orientation: "landscape" }), "full");
  assert.equal(tabletLayoutMode({ formFactor: "tablet", orientation: "landscape", splitScreen: true, sheetCompanion: true }), "map-split");
  assert.equal(wideCharacterSheet({ formFactor: "tablet", orientation: "landscape", sheetCompanion: true }), false, "the pinned sheet uses its narrow presentation");
});

test("Split Screen is the default; Side by side starts off and needs a landscape tablet", () => {
  const state = landscape();
  assert.equal(state.splitScreen, true);
  assert.equal(state.sheetCompanion, false);
  assert.equal(state.companionRoute, "chat");
  const portrait = reduce({ ...initialAppState }, layout("tablet", "portrait"), { type: "toggle-sheet-companion" });
  assert.equal(portrait.sheetCompanion, false);
  assert.equal(reduce({ ...initialAppState }, layout("phone", "portrait"), { type: "toggle-sheet-companion" }).sheetCompanion, false);
});

test("turning Side by side on turns Split Screen off, and the reverse, so both are never on", () => {
  let state = sideBySide();
  assert.equal(state.sheetCompanion, true);
  assert.equal(state.sheetCompanionPreferred, true);
  assert.equal(state.splitScreen, false);
  assert.equal(state.splitScreenPreferred, false);
  assert.equal(tabletLayoutMode(state), "companion");
  state = reduce(state, { type: "toggle-split-screen" });
  assert.equal(state.splitScreen, true);
  assert.equal(state.sheetCompanion, false);
  assert.equal(state.sheetCompanionPreferred, false);
  state = reduce(state, { type: "toggle-sheet-companion" });
  assert.deepEqual([state.splitScreen, state.sheetCompanion], [false, true]);
  state = reduce(state, { type: "toggle-sheet-companion" });
  assert.deepEqual([state.splitScreen, state.sheetCompanion, state.sheetCompanionPreferred, state.splitScreenPreferred], [false, false, false, false], "off leaves Tablet Full");
  assert.equal(tabletLayoutMode(state), "full");
});

test("the choice survives rotating to portrait and back", () => {
  let state = sideBySide();
  state = reduce(state, layout("tablet", "portrait"));
  assert.equal(state.sheetCompanion, false);
  assert.equal(state.sheetCompanionPreferred, true);
  assert.equal(tabletLayoutMode(state), "portrait");
  state = reduce(state, layout("tablet", "landscape"));
  assert.equal(state.sheetCompanion, true);
  assert.equal(state.splitScreen, false);
  const split = reduce(landscape(), layout("tablet", "portrait"), layout("tablet", "landscape"));
  assert.deepEqual([split.splitScreen, split.sheetCompanion], [true, false], "map Split keeps its own round trip");
});

test("Side by side works without a canvas, where Split Screen cannot", () => {
  let state = landscape(false);
  assert.equal(state.splitScreen, false);
  assert.equal(reduce(state, { type: "toggle-split-screen" }).splitScreen, false);
  state = reduce(state, { type: "toggle-sheet-companion" });
  assert.equal(state.sheetCompanion, true);
  state = reduce(state, layout("tablet", "landscape", false), layout("tablet", "portrait", false), layout("tablet", "landscape", false));
  assert.equal(state.sheetCompanion, true);
  assert.equal(state.splitScreen, false);
});

test("an active placement keeps the layout fixed", () => {
  const state = { ...landscape(), templatePlacement: { id: "t" } };
  assert.equal(reduce(state, { type: "toggle-sheet-companion" }), state);
});

test("rail taps put Chat, Journals or Combat beside the sheet without touching the sheet's own state", () => {
  let state = { ...sideBySide(), hitPointEditor: "hp", characterItemId: "item-1" };
  for (const route of COMPANION_ROUTES) {
    state = reduce(state, { type: "navigate", route });
    assert.equal(state.route, "characters");
    assert.equal(state.companionRoute, route);
    assert.equal(visibleCompanionRoute(state), route);
    assert.equal(routeVisible(state, route), true);
    assert.equal(routeVisible(state, "characters"), true);
  }
  assert.equal(state.hitPointEditor, "hp", "the HP editor stays open on the pinned sheet");
  assert.equal(state.characterItemId, "item-1");
  assert.deepEqual(state.routeHistory, [], "switching the companion is not a history step");
  assert.equal(reduce(state, { type: "navigate", route: "combat" }), state, "tapping the current companion changes nothing");
  const character = reduce(state, { type: "navigate", route: "characters" });
  assert.equal(character, state, "Character shows the pair with the last companion");
  assert.equal(character.companionRoute, "combat");
});

test("Scene and Settings take the full width; Chat, Journals or Combat bring the pair back", () => {
  let state = reduce(sideBySide(), { type: "navigate", route: "journals" });
  state = reduce(state, { type: "navigate", route: "settings" });
  assert.equal(state.route, "settings");
  assert.equal(companionPaneActive(state), false);
  assert.equal(routeVisible(state, "journals"), false);
  state = reduce(state, { type: "navigate", route: "chat" });
  assert.deepEqual([state.route, state.companionRoute], ["characters", "chat"]);
  state = reduce(state, { type: "navigate", route: "scene" });
  assert.equal(state.route, "scene");
  state = reduce(state, { type: "navigate", route: "characters" });
  assert.deepEqual([state.route, state.companionRoute, companionPaneActive(state)], ["characters", "chat", true]);
});

test("a detour to the Scene after an action, or for placement, comes back to the pair", () => {
  let state = reduce(sideBySide(), { type: "navigate", route: "combat" });
  state = reduce(state, { type: "return-to-scene-after-action" });
  assert.equal(state.route, "scene");
  assert.deepEqual(state.routeHistory, ["characters"]);
  const back = reduce(state, { type: "navigate-back" });
  assert.deepEqual([back.route, back.companionRoute, companionPaneActive(back)], ["characters", "combat", true]);
  const home = reduce(state, { type: "return-to-character" });
  assert.deepEqual([home.route, home.companionRoute], ["characters", "combat"]);
});

test("Return to Scene after actions treats Side by side like Tablet Full, because no map is visible", () => {
  const state = reduce(sideBySide(), { type: "navigate", route: "chat" });
  const navigations = [];
  const sceneReturn = createActionSceneReturn({
    command: ACTOR_COMMANDS.ROLL_SKILL,
    readState: () => ({ ...state, snapshot: { scene: { id: "s", canvasReady: true } } }),
    readPreference: () => "always",
    readScene: () => ({ id: "s", canvasReady: true }),
    readCombat: () => null,
    isCurrent: () => true,
    navigate: () => navigations.push("scene")
  });
  assert.equal(sceneReturn(), true);
  assert.deepEqual(navigations, ["scene"]);
});

test("turning Side by side on from Chat keeps Chat on screen beside the sheet", () => {
  let state = reduce({ ...landscape(), splitScreen: false, splitScreenPreferred: false }, { type: "navigate", route: "chat" });
  assert.equal(state.route, "chat");
  state = reduce(state, { type: "toggle-sheet-companion" });
  assert.deepEqual([state.route, state.companionRoute], ["characters", "chat"]);
  state = reduce(state, { type: "toggle-sheet-companion" });
  assert.equal(state.route, "characters", "turning it off keeps the pinned sheet");
});

test("rotating into landscape folds a companion route into the pair", () => {
  let state = reduce(sideBySide(), layout("tablet", "portrait"), { type: "navigate", route: "journals" });
  assert.equal(state.route, "journals");
  state = reduce(state, layout("tablet", "landscape"));
  assert.deepEqual([state.route, state.companionRoute, companionPaneActive(state)], ["characters", "journals", true]);
});

test("Back history recorded before Side by side reopens that screen in the companion pane, keeping its journal", () => {
  const journal = { id: "j", pages: [] };
  let state = reduce({ ...landscape(), splitScreen: false, splitScreenPreferred: false }, { type: "navigate", route: "journals" });
  state = { ...reduce(state, { type: "navigate", route: "scene" }), journal, journalPageId: "p" };
  state = reduce(state, { type: "toggle-sheet-companion" });
  assert.equal(state.route, "scene");
  state = reduce(state, { type: "navigate-back" });
  assert.deepEqual([state.route, state.companionRoute], ["characters", "journals"]);
  assert.equal(state.journal, journal);
  assert.equal(state.journalPageId, "p");
});

test("no sequence of events turns on both layouts or leaves a companion screen as the route", () => {
  const events = [
    { type: "toggle-sheet-companion" }, { type: "toggle-split-screen" }, layout("tablet", "portrait"), layout("tablet", "landscape"),
    layout("tablet", "landscape", false), layout("phone", "portrait"), { type: "navigate", route: "chat" }, { type: "navigate", route: "journals" },
    { type: "navigate", route: "combat" }, { type: "navigate", route: "scene" }, { type: "navigate", route: "settings" },
    { type: "navigate", route: "characters" }, { type: "navigate-back" }, { type: "return-to-character" }, { type: "open-full-scene" },
    { type: "open-split-scene-chooser" }, { type: "return-to-scene-after-action" }
  ];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let state = landscape();
  for (let step = 0; step < 4000; step += 1) {
    state = reduceAppState(state, events[Math.floor(random() * events.length)]);
    assert.ok(!(state.splitScreen && state.sheetCompanion), `both layouts on at step ${step}`);
    if (tabletLayoutMode(state) === "companion") assert.ok(!COMPANION_ROUTES.includes(state.route), `route ${state.route} at step ${step}`);
  }
});

test("companionRoute falls back to Chat and routeVisible ignores the companion when the pair is hidden", () => {
  assert.equal(companionRoute({ companionRoute: "scene" }), "chat");
  assert.equal(companionRoute({}), "chat");
  const state = { formFactor: "tablet", orientation: "landscape", sheetCompanion: true, route: "scene", companionRoute: "combat" };
  assert.equal(visibleCompanionRoute(state), "");
  assert.equal(routeVisible(state, "combat"), false);
  assert.equal(routeVisible({ ...state, route: "characters" }, "combat"), true);
  assert.equal(routeVisible({ ...state, route: "characters", orientation: "portrait" }, "combat"), false);
  assert.equal(routeVisible({ route: "combat" }, "combat"), true);
});

test("Back closes a journal open beside the sheet, but never one left behind a different companion", () => {
  const pair = { formFactor: "tablet", orientation: "landscape", sheetCompanion: true, route: "characters", characterTab: "overview", journal: { id: "j" } };
  const calls = [];
  const commands = { closeJournal: () => calls.push("close"), returnToCharacter: () => calls.push("home") };
  assert.equal(createVeBackDispatcher({ getState: () => ({ ...pair, companionRoute: "journals" }), commands }).back(), "journal-detail");
  assert.deepEqual(calls, ["close"]);
  assert.equal(createVeBackDispatcher({ getState: () => ({ ...pair, companionRoute: "chat" }), commands }).peek(), "root");
  assert.ok(veCloseWatcherLayers({ ...pair, companionRoute: "journals" }).includes("journal:j"));
  assert.ok(!veCloseWatcherLayers({ ...pair, companionRoute: "chat" }).includes("journal:j"));
});

test("docked Chat uses the shared-pane presentation beside the sheet", () => {
  assert.equal(chatPresentation({ dataset: { route: "chat", splitScreen: "false" } }), "full");
  assert.equal(chatPresentation({ dataset: { route: "chat", splitScreen: "true" } }), "pane");
  assert.equal(chatPresentation({ dataset: { route: "characters", companionRoute: "chat" } }), "pane");
  assert.equal(chatPresentation({ dataset: { route: "characters", companionRoute: "journals" } }), "");
  assert.equal(chatPresentation(null), "");
});

test("the companion pane rebuilds only for its own screen's data", () => {
  const snapshot = { journals: [], combat: {} };
  const base = { status: "ready", viewRevision: 1, snapshot, journal: null };
  assert.equal(companionPaneChanged(null, { ...base, route: "chat" }), true);
  assert.equal(companionPaneChanged({ ...base, route: "chat" }, { ...base, route: "chat", viewRevision: 2, snapshot: {} }), false, "Foundry keeps Chat live");
  assert.equal(companionPaneChanged({ ...base, route: "chat" }, { ...base, route: "combat" }), true);
  assert.equal(companionPaneChanged({ ...base, route: "combat" }, { ...base, route: "combat", snapshot: { ...snapshot } }), false);
  assert.equal(companionPaneChanged({ ...base, route: "combat" }, { ...base, route: "combat", snapshot: { ...snapshot, combat: {} } }), true);
  assert.equal(companionPaneChanged({ ...base, route: "journals" }, { ...base, route: "journals", journal: { id: "j" } }), true);
  assert.equal(companionPaneChanged({ ...base, route: "journals" }, { ...base, route: "journals", snapshot: { ...snapshot, combat: {} } }), false);
  assert.equal(companionPaneChanged({ ...base, route: "journals" }, { ...base, route: "journals", viewRevision: 2 }), true);
});

test("Journals or Combat changing beside the sheet never knocks the pinned sheet off its fast path", () => {
  const actor = { id: "a" };
  const snapshot = { actors: [actor], selectedActor: actor, journals: [], combat: { round: 1 } };
  const pair = { route: "characters", companionRoute: "journals", snapshot, journal: null, journalPageId: "", journalMenuOpen: false };
  const reading = { ...pair, journal: { id: "j" }, journalPageId: "p1" };
  assert.equal(mainPaneJournalChanged(pair, reading), false, "opening a journal");
  assert.equal(mainPaneJournalChanged(reading, { ...reading, journalPageId: "p2" }), false, "changing page");
  assert.equal(mainPaneJournalChanged(reading, { ...reading, journalMenuOpen: true }), false, "opening the page menu");
  assert.equal(companionPaneChanged({ ...reading, route: "journals" }, { ...reading, route: "journals", journalMenuOpen: true }), true, "the companion pane still rebuilds");
  assert.equal(mainPaneJournalChanged({ ...reading, route: "journals" }, { ...reading, route: "journals", journalPageId: "p2" }), true, "the Journals route still refreshes");
  const combatTurn = { ...pair, snapshot: { ...snapshot, combat: { round: 2 } } };
  assert.equal(snapshotPresentationChangedForRoute(pair, combatTurn), false, "a combat update leaves the sheet alone");
});

test("the controls guide describes Side by side while it is the tablet layout", () => {
  const layout = context => controlsGuideSections(context).find(section => section.id === "layout").entries;
  assert.deepEqual(layout({ presentation: "tablet", sideBySide: true }), ["TabletSideBySide"]);
  assert.deepEqual(layout({ presentation: "tablet", split: true }), ["TabletSplit"]);
  assert.deepEqual(layout({ presentation: "tablet" }), ["TabletFull"]);
  assert.ok(layout({ presentation: "desktop" }).includes("TabletSideBySide"));
});
