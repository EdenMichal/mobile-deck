// Unit tests for deleting an inventory item from the mobile sheet (dnd5e): the Foundry-side rules and handler
// against fake documents, the menu entry and the confirm copy. Run: node --test tests/*.test.mjs
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ACTOR_COMMANDS } from "../src/kernel/command-names.mjs";
import { canDeleteItem, containedItemCount, deleteActorItem } from "../src/foundry/systems/dnd5e/item-delete-actions.mjs";
import { itemDeleteCopy, itemDeleteMenuAction } from "../src/features/characters/systems/dnd5e/item-delete.mjs";
import { dnd5eActorActions } from "../src/foundry/systems/dnd5e/actor-actions.mjs";

afterEach(() => { delete globalThis.game; });

// A character with a backpack holding rope and a pouch, and the pouch holding a gem.
function world() {
  const deleted = [];
  const actor = { id: "a1", name: "Tamsin", type: "character", items: null };
  const make = (id, type, extra = {}) => ({ id, name: extra.name ?? id, type, parent: actor, isOwner: true,
    system: { quantity: extra.quantity ?? 1, container: extra.container ?? null },
    async delete(options) { deleted.push([id, options]); return this; } });
  const backpack = make("pack", "container", { name: "Backpack" });
  const rope = make("rope", "loot", { container: "pack" });
  const pouch = make("pouch", "container", { container: "pack" });
  const gem = make("gem", "loot", { container: "pouch" });
  const arrows = make("arrows", "consumable", { name: "Arrows", quantity: 20 });
  const spell = make("fireball", "spell");
  const feat = make("rage", "feat");
  const all = [backpack, rope, pouch, gem, arrows, spell, feat];
  // dnd5e 5.3.2: ContainerData#allContainedItems walks contents and sub-containers.
  const walk = id => all.filter(item => item.system.container === id).flatMap(item => [item, ...(item.type === "container" ? walk(item.id) : [])]);
  for (const item of all) if (item.type === "container") item.system.allContainedItems = new Map(walk(item.id).map(each => [each.id, each]));
  actor.items = { get: id => all.find(item => item.id === id), contents: all };
  return { actor, deleted, backpack, rope, pouch, gem, arrows, spell, feat };
}

test("only physical items on a character can be deleted from the mobile sheet", () => {
  const { actor, backpack, arrows, spell, feat } = world();
  assert.equal(canDeleteItem(actor, backpack), true);
  assert.equal(canDeleteItem(actor, arrows), true);
  assert.equal(canDeleteItem(actor, spell), false, "spells stay in Foundry");
  assert.equal(canDeleteItem(actor, feat), false, "features stay in Foundry");
  assert.equal(canDeleteItem({ ...actor, type: "npc" }, arrows), false);
  assert.equal(canDeleteItem({ ...actor, type: "group" }, arrows), false);
  assert.equal(canDeleteItem(actor, { ...arrows, delete: undefined }), false);
  assert.equal(canDeleteItem(actor, { ...arrows, isOwner: false }), false);
  assert.equal(canDeleteItem(actor, { ...arrows, parent: { id: "other" } }), false);
});

test("a container counts every item inside it, sub-containers included", () => {
  const { backpack, pouch, arrows } = world();
  assert.equal(containedItemCount(backpack), 3);
  assert.equal(containedItemCount(pouch), 1);
  assert.equal(containedItemCount(arrows), 0);
});

test("delete: a single item is deleted after the session is rechecked", async () => {
  const { actor, deleted } = world();
  let checked = 0;
  const result = await deleteActorItem(actor, { itemId: "rope", contents: 0 }, { assertCurrent: () => { checked += 1; } });
  assert.deepEqual(result, { itemId: "rope", itemName: "rope", contentsDeleted: 0 });
  assert.equal(checked, 1);
  assert.deepEqual(deleted, [["rope", {}]]);
});

test("delete: a whole stack goes at once", async () => {
  const { actor, deleted } = world();
  const result = await deleteActorItem(actor, { itemId: "arrows", contents: 0 });
  assert.equal(result.itemName, "Arrows");
  assert.deepEqual(deleted, [["arrows", {}]]);
});

test("delete: a container takes its contents with it, the way dnd5e's own sheet does", async () => {
  const { actor, deleted } = world();
  const result = await deleteActorItem(actor, { itemId: "pack", contents: 3 });
  assert.deepEqual(result, { itemId: "pack", itemName: "Backpack", contentsDeleted: 3 });
  assert.deepEqual(deleted, [["pack", { deleteContents: true }]]);
});

test("delete: contents that changed since the confirm are refused, nothing is deleted", async () => {
  const { actor, deleted } = world();
  await assert.rejects(deleteActorItem(actor, { itemId: "pack", contents: 2 }), error => error.code === "STALE_STATE");
  await assert.rejects(deleteActorItem(actor, { itemId: "pack" }), error => error.code === "INVALID_INPUT");
  assert.deepEqual(deleted, []);
});

test("delete: spells, features, other actors' items and missing items are refused", async () => {
  const { actor, deleted } = world();
  await assert.rejects(deleteActorItem(actor, { itemId: "fireball", contents: 0 }), error => error.code === "CAPABILITY_UNAVAILABLE");
  await assert.rejects(deleteActorItem(actor, { itemId: "rage", contents: 0 }), error => error.code === "CAPABILITY_UNAVAILABLE");
  await assert.rejects(deleteActorItem({ ...actor, type: "npc" }, { itemId: "rope", contents: 0 }), error => error.code === "CAPABILITY_UNAVAILABLE");
  await assert.rejects(deleteActorItem(actor, { itemId: "nothere", contents: 0 }), error => error.code === "TARGET_MISSING");
  assert.deepEqual(deleted, []);
});

test("delete: a session that went stale before the write deletes nothing", async () => {
  const { actor, deleted } = world();
  const stale = Object.assign(new Error("stale"), { code: "STALE_VALUE" });
  await assert.rejects(deleteActorItem(actor, { itemId: "rope", contents: 0 }, { assertCurrent: () => { throw stale; } }), stale);
  assert.deepEqual(deleted, []);
});

test("the command is wired: a handler, its own lock per item, and the result fields", () => {
  assert.equal(ACTOR_COMMANDS.DELETE_ITEM, "actor.delete-item");
  assert.equal(typeof dnd5eActorActions.handlers[ACTOR_COMMANDS.DELETE_ITEM], "function");
  const key = item => dnd5eActorActions.fingerprint(ACTOR_COMMANDS.DELETE_ITEM, "Actor.a1", { itemId: item });
  assert.notEqual(key("rope"), key("gem"));
  assert.deepEqual(dnd5eActorActions.resultFields(ACTOR_COMMANDS.DELETE_ITEM, { itemId: "pack", itemName: "Backpack", contentsDeleted: 3 }),
    { itemId: "pack", itemName: "Backpack", contentsDeleted: 3 });
  // Groups and vehicles never reach the handler.
  assert.throws(() => dnd5eActorActions.assertActorCommand({ type: "group" }, ACTOR_COMMANDS.DELETE_ITEM), error => error.code === "CAPABILITY_UNAVAILABLE");
  assert.throws(() => dnd5eActorActions.assertActorCommand({ type: "vehicle" }, ACTOR_COMMANDS.DELETE_ITEM), error => error.code === "CAPABILITY_UNAVAILABLE");
});

test("the kernel only runs Delete for the character on screen", () => {
  const kernel = fs.readFileSync(new URL("../src/kernel/app-kernel.mjs", import.meta.url), "utf8");
  const guard = kernel.match(/if \(\[(ACTOR_COMMANDS\.ADD_EXPERIENCE[^\]]+)\]\.includes\(name\)/u)?.[1] ?? "";
  assert.match(guard, /ACTOR_COMMANDS\.DELETE_ITEM/u);
});

const commands = { localize: (key, fallback) => fallback };

test("the menu offers Delete, marked destructive, only when the item record allows it", () => {
  const action = itemDeleteMenuAction({ canDelete: true }, commands);
  assert.equal(action.id, "delete");
  assert.equal(action.label, "Delete");
  assert.equal(action.destructive, true);
  assert.equal(itemDeleteMenuAction({ canDelete: false }, commands), null);
  assert.equal(itemDeleteMenuAction({}, commands), null);
});

test("confirm copy: a single item, a stack, and a container with contents", () => {
  assert.deepEqual(itemDeleteCopy({ name: "Rope", quantity: 1, contentsCount: 0 }, commands),
    { title: "Delete Rope?", body: "It's removed from your inventory. This can't be undone." });
  assert.deepEqual(itemDeleteCopy({ name: "Arrows", quantity: 20, contentsCount: 0 }, commands),
    { title: "Delete Arrows?", body: "All 20 are removed from your inventory. This can't be undone." });
  assert.deepEqual(itemDeleteCopy({ name: "Backpack", quantity: 1, contentsCount: 3 }, commands),
    { title: "Delete Backpack?", body: "The 3 items inside are deleted with it. This can't be undone." });
  assert.deepEqual(itemDeleteCopy({ name: "Pouch", quantity: 1, contentsCount: 1 }, commands),
    { title: "Delete Pouch?", body: "The 1 item inside is deleted with it. This can't be undone." });
});

// Localization: every Delete key exists in en, en-AU and ru, and the code's English fallback matches en.json.
test("every item-delete string is in all three locales, with matching English fallbacks", () => {
  const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
  const source = read("../src/features/characters/systems/dnd5e/item-delete.mjs") + read("../src/foundry/systems/dnd5e/item-delete-actions.mjs");
  const used = new Map();
  for (const [, key, fallback] of source.matchAll(/text\(\w+, "([A-Za-z.]+)", "((?:[^"\\]|\\.)*)"/gu)) used.set(`VEMOBILE.ItemDelete.${key}`, fallback);
  for (const [, key, fallback] of source.matchAll(/"(VEMOBILE\.ItemDelete\.[A-Za-z.]+)", "((?:[^"\\]|\\.)*)"/gu)) used.set(key, fallback);
  for (const [, key] of source.matchAll(/count\(\w+, "([A-Za-z.]+)"/gu)) for (const form of ["One", "Other"]) used.set(`VEMOBILE.ItemDelete.${key}.${form}`, null);
  assert.ok(used.size >= 10, `found ${used.size} keys`);
  const lookup = (dictionary, key) => key.split(".").reduce((node, part) => node?.[part], dictionary);
  const dictionaries = Object.fromEntries(["en", "en-AU", "ru"].map(locale => [locale, JSON.parse(read(`../locales/${locale}.json`))]));
  for (const [locale, dictionary] of Object.entries(dictionaries)) {
    for (const key of used.keys()) assert.equal(typeof lookup(dictionary, key), "string", `${locale} is missing ${key}`);
  }
  for (const [key, fallback] of used) if (fallback !== null) assert.equal(lookup(dictionaries.en, key), fallback, `en.json and the code disagree on ${key}`);
  // The whole section is in parity, not just the keys the code reads today.
  const keys = (record, prefix = "") => Object.entries(record ?? {}).flatMap(([name, value]) => typeof value === "object" ? keys(value, `${prefix}${name}.`) : [`${prefix}${name}`]).sort();
  for (const locale of ["en-AU", "ru"]) {
    assert.deepEqual(keys(dictionaries[locale].VEMOBILE.ItemDelete), keys(dictionaries.en.VEMOBILE.ItemDelete), `${locale} ItemDelete keys`);
    assert.deepEqual(keys(dictionaries[locale].VEMOBILE.ItemCreate), keys(dictionaries.en.VEMOBILE.ItemCreate), `${locale} ItemCreate keys`);
  }
});

test("the item menu puts Delete last, after Send to Party, and leaves it off Favorites rows", async () => {
  const { resolveCharacterItemMenu } = await import("../src/features/characters/systems/dnd5e/presenter.mjs");
  const record = { id: "rope", name: "Rope", type: "loot", canDelete: true, canEdit: true, quantity: 1, contentsCount: 0 };
  const menuCommands = { ...commands, readCharacterItemMenu: () => ({ item: record, canUse: false, preferences: {} }) };
  const actor = { sourceUuid: "Actor.a", capabilities: { transferParty: true }, party: { status: "ready", access: "owner", sourceUuid: "Actor.p" } };
  const ids = item => resolveCharacterItemMenu(item, actor, menuCommands).actions.map(action => action.id);
  assert.deepEqual(ids({ id: "rope", type: "loot" }), ["edit", "party", "delete"]);
  assert.deepEqual(ids({ id: "rope", type: "loot", favouriteIds: [] }), ["edit", "party"]);
  const solo = { ...menuCommands, readCharacterItemMenu: () => ({ item: { ...record, canDelete: false }, canUse: false, preferences: {} }) };
  assert.deepEqual(resolveCharacterItemMenu({ id: "rope", type: "loot" }, actor, solo).actions.map(action => action.id), ["edit", "party"]);
});
