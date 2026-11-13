// Unit tests for the party page's non-DOM decisions. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { canMoveWithParty, partyItemMenuAction, sendToPartyFromMenu } from "../src/features/characters/systems/dnd5e/party-panel.mjs";

const commands = { localize: (key, fallback) => fallback };
const actor = (access, transferParty = true) => ({ capabilities: { transferParty }, party: { status: "ready", access, sourceUuid: "Actor.p", name: "P", items: [] } });

test("moves need an owned party and a character that can transfer", () => {
  assert.equal(canMoveWithParty(actor("owner")), true);
  assert.equal(canMoveWithParty(actor("observer")), false);
  assert.equal(canMoveWithParty(actor("owner", false)), false);
  assert.equal(canMoveWithParty({ capabilities: { transferParty: true }, party: { status: "missing" } }), false);
  assert.equal(canMoveWithParty({}), false);
});

test("the inventory menu offers Send to Party only for physical items the player may move", () => {
  assert.equal(partyItemMenuAction({ type: "weapon" }, actor("owner"), commands)?.id, "party");
  assert.equal(partyItemMenuAction({ type: "spell" }, actor("owner"), commands), null);
  assert.equal(partyItemMenuAction({ type: "weapon" }, actor("observer"), commands), null);
});

test("a failed move is always reported, even after a stash refresh disposed the pane", async () => {
  const notices = [];
  const ayla = { ...actor("owner"), sourceUuid: "Actor.a", name: "Ayla", inventory: [{ id: "rope", name: "Rope", type: "loot", quantity: 1 }] };
  const failing = { ...commands, execute: async () => { throw Object.assign(new Error("The item left The Company but did not arrive."), { name: "CommandError", code: "RESTORE_FAILED" }); },
    notifyCharacterStatus: notice => { notices.push(notice); return true; } };
  const button = { disabled: false, isConnected: false, classList: { toggle() {} }, setAttribute() {}, removeAttribute() {} };
  await sendToPartyFromMenu(button, ayla, { id: "rope" }, failing, { disposed: true });
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "error");
  assert.match(notices[0].message, /did not arrive/);
});

test("Send to Party on a stack opens the quantity sheet through app state", async () => {
  const opened = [];
  const ayla = { ...actor("owner"), sourceUuid: "Actor.a", inventory: [{ id: "arrows", name: "Arrows", type: "consumable", quantity: 20 }] };
  await sendToPartyFromMenu(null, ayla, { id: "arrows" }, { ...commands, openPartySheet: sheet => opened.push(sheet) }, { disposed: false });
  assert.deepEqual(opened, [{ kind: "item", direction: "send", itemId: "arrows" }]);
});
