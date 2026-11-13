// The app frame keeps an expanded item row's DOM while unrelated hooks publish snapshots, but a change to which
// items the character has (created, deleted, moved into a container) must still re-render the pane.
// Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { characterItemSetChanged } from "../src/ui/app-frame.mjs";

const view = (inventory, { spells = [], features = [] } = {}) => ({ snapshot: { selectedActor: { inventory, spells, features } } });
const rope = { id: "rope", quantity: 1, containerId: "" };
const sword = { id: "sword", quantity: 1, containerId: "" };

test("a new or deleted inventory item changes the item set", () => {
  assert.equal(characterItemSetChanged(view([rope]), view([rope, sword])), true);
  assert.equal(characterItemSetChanged(view([rope, sword]), view([sword])), true);
});

test("moving an item into a container changes the item set", () => {
  assert.equal(characterItemSetChanged(view([rope, sword]), view([{ ...rope, containerId: "pack" }, sword])), true);
});

test("spells and features count too", () => {
  assert.equal(characterItemSetChanged(view([], { spells: [{ id: "a" }] }), view([], { spells: [] })), true);
  assert.equal(characterItemSetChanged(view([], { features: [] }), view([], { features: [{ id: "f" }] })), true);
});

test("other changes (a new snapshot, a different quantity) keep the expanded row's DOM", () => {
  assert.equal(characterItemSetChanged(view([rope, sword]), view([{ ...rope, quantity: 3 }, { ...sword }])), false);
  const same = view([rope]);
  assert.equal(characterItemSetChanged(same, same), false);
  assert.equal(characterItemSetChanged({ snapshot: null }, { snapshot: null }), false);
});
