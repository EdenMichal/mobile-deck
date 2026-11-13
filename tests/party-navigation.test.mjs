// Party inventory: hardware Back, the party sheet state, and snapshot refreshes. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { characterBackTab, characterHomeBackTarget, createVeBackDispatcher } from "../src/ui/ve-back-dispatcher.mjs";
import { veCloseWatcherLayers } from "../src/ui/ve-close-watcher-back.mjs";
import { initialAppState, reduceAppState } from "../src/kernel/app-state.mjs";
import { sessionInvalidationForHook } from "../src/foundry/session-gateway.mjs";
import { dnd5eIntegration } from "../src/foundry/systems/dnd5e/integration.mjs";

const dnd5e = tab => ({ route: "characters", characterTab: tab, snapshot: { world: { systemId: "dnd5e" } } });
const pf2e = tab => ({ route: "characters", characterTab: tab, snapshot: { world: { systemId: "pf2e" } } });

test("Back on the dnd5e Party page returns to Inventory", () => {
  assert.equal(characterBackTab(dnd5e("party")), "inventory");
  const calls = [];
  const dispatcher = createVeBackDispatcher({ getState: () => dnd5e("party"), commands: { selectCharacterTab: tab => calls.push(tab) } });
  assert.equal(dispatcher.back(), "character-overview");
  assert.deepEqual(calls, ["inventory"]);
});

test("Back on the dnd5e Abilities and Effects pages returns to Overview; top-level tabs have no in-sheet Back", () => {
  assert.equal(characterBackTab(dnd5e("abilities")), "overview");
  assert.equal(characterBackTab(dnd5e("effects")), "overview");
  assert.equal(characterBackTab(dnd5e("inventory")), "");
  assert.equal(characterHomeBackTarget(dnd5e("overview")), false);
});

test("pf2e keeps its rule: any sub-tab goes back to the Character tab", () => {
  assert.equal(characterBackTab(pf2e("inventory")), "overview");
  assert.equal(characterHomeBackTarget(pf2e("overview")), false);
});

test("an open party sheet is the first thing Back closes, and Android sees it as a layer", () => {
  const state = { ...dnd5e("party"), partySheet: { kind: "item", direction: "take", itemId: "p1" } };
  const calls = [];
  const dispatcher = createVeBackDispatcher({ getState: () => state, commands: { closePartySheet: () => calls.push("close"), selectCharacterTab: () => calls.push("tab") } });
  assert.equal(dispatcher.back(), "party-sheet");
  assert.deepEqual(calls, ["close"]);
  assert.ok(veCloseWatcherLayers(state).includes("party-sheet"));
});

test("the party sheet is state, so it survives snapshot refreshes and closes on tab changes", () => {
  const actor = { id: "a", sourceUuid: "Actor.a", items: [], inventory: [] };
  let state = reduceAppState({ ...initialAppState, route: "characters", characterTab: "party", selectedActorSourceUuid: "Actor.a", selectedActorId: "a",
    snapshot: { actors: [actor], selectedActor: actor } }, { type: "open-party-sheet", sheet: { kind: "item", direction: "take", itemId: "p1" } });
  assert.deepEqual(state.partySheet, { kind: "item", direction: "take", itemId: "p1" });
  state = reduceAppState(state, { type: "session-loaded", snapshot: { actors: [actor], selectedActor: actor } });
  assert.deepEqual(state.partySheet, { kind: "item", direction: "take", itemId: "p1" }, "a refresh of the same character keeps it open");
  assert.equal(reduceAppState(state, { type: "close-party-sheet" }).partySheet, null);
  assert.equal(reduceAppState(state, { type: "select-character-tab", tab: "inventory" }).partySheet, null);
  assert.equal(reduceAppState(state, { type: "open-experience-editor" }).partySheet, null);
  assert.equal(reduceAppState(state, { type: "open-party-sheet", sheet: { kind: "nonsense" } }).partySheet.kind, "item", "invalid sheets are ignored");
});

test("a new Group, a deleted Group, or a Group's ownership change refreshes the selected character", () => {
  const group = { type: "group", id: "g", uuid: "Actor.g", documentName: "Actor" };
  assert.equal(sessionInvalidationForHook("createActor", group, {}, dnd5eIntegration).refreshSelectedActor, true);
  assert.equal(sessionInvalidationForHook("deleteActor", group, {}, dnd5eIntegration).refreshSelectedActor, true);
  assert.equal(sessionInvalidationForHook("updateActor", group, { ownership: { u1: 3 } }, dnd5eIntegration).refreshSelectedActor, true);
  assert.equal(sessionInvalidationForHook("updateActor", group, { name: "Renamed" }, dnd5eIntegration).refreshSelectedActor, undefined);
  const npc = { type: "npc", id: "n", uuid: "Actor.n", documentName: "Actor" };
  assert.equal(sessionInvalidationForHook("createActor", npc, {}, dnd5eIntegration).refreshSelectedActor, undefined);
});
