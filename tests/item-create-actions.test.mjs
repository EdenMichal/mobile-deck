// Unit tests for the Foundry side of player item creation, against fake CONFIG / game objects.
// Run: node --test tests/*.test.mjs
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { CREATABLE_ITEM_TYPES as TYPES, itemCreateErrorMessage } from "../src/foundry/systems/dnd5e/item-create-rules.mjs";
import { canCreateItems, createActorItem, draftErrorText, readItemCreatorOptions, whisperItemCreated } from "../src/foundry/systems/dnd5e/item-create-actions.mjs";

const CONFIG = {
  Item: {
    dataModels: { weapon: {}, equipment: {}, consumable: {}, tool: {}, loot: {}, container: {}, spell: {}, feat: {} },
    typeLabels: { weapon: "TYPES.Item.weapon", loot: "TYPES.Item.loot" }
  },
  DND5E: {
    defaultArtwork: { Item: { weapon: "systems/dnd5e/icons/svg/items/weapon.svg", loot: "systems/dnd5e/icons/svg/items/loot.svg" } },
    weaponTypes: { simpleM: "Simple Melee", martialM: "Martial Melee", siege: "Siege" },
    validProperties: { weapon: new Set(["ver", "fin"]) },
    itemProperties: { fin: { label: "Finesse" }, ver: { label: "Versatile" } },
    damageTypes: { slashing: { label: "Slashing" }, acid: { label: "Acid" } },
    dieSteps: [4, 6, 8, 10, 12, 20, 100],
    equipmentTypes: { light: "Light Armor", ring: "Ring" },
    armorTypes: { light: "Light Armor", medium: "Medium Armor" },
    consumableTypes: { potion: { label: "Potion" } },
    toolTypes: { art: "Artisan's Tools" },
    lootTypes: { gem: { label: "Gem" } },
    currencies: { gp: { label: "Gold", abbreviation: "GP" }, sp: { label: "Silver", abbreviation: "SP" } },
    defaultCurrency: "gp",
    tools: { smith: { ability: "str", id: "Compendium.dnd5e.equipment24.Item.phbtulSmithsToo" }, thief: { ability: "dex", id: "Compendium.dnd5e.equipment24.Item.phbtulThievesToo" } }
  }
};
const localize = key => ({ "TYPES.Item.weapon": "Weapon", "TYPES.Item.loot": "Loot" })[key] ?? key;

afterEach(() => { delete globalThis.CONFIG; delete globalThis.game; delete globalThis.ChatMessage; delete globalThis.foundry; delete globalThis.dnd5e; });

test("options: only the six inventory types, with labels and default art; siege weapons and d100 left out", () => {
  const options = readItemCreatorOptions(CONFIG, localize);
  assert.deepEqual(options.types.map(t => t.value), ["weapon", "equipment", "consumable", "tool", "loot", "container"]);
  assert.deepEqual(options.types[0], { value: "weapon", label: "Weapon", img: "systems/dnd5e/icons/svg/items/weapon.svg" });
  assert.deepEqual(options.weaponTypes.map(t => t.value), ["simpleM", "martialM"]);
  assert.deepEqual(options.weaponProperties, [{ value: "fin", label: "Finesse" }, { value: "ver", label: "Versatile" }]);
  assert.deepEqual(options.damageTypes.map(t => t.value), ["acid", "slashing"], "sorted by label");
  assert.deepEqual([...options.dieFaces], [4, 6, 8, 10, 12, 20]);
  assert.deepEqual([...options.armorTypes], ["light", "medium"]);
  assert.deepEqual(options.currencies, [{ value: "gp", label: "GP" }, { value: "sp", label: "SP" }]);
  assert.equal(options.defaultCurrency, "gp");
});

test("options: base tools named from dnd5e's compendium index, with their ability; the icon presets are the allowlist", () => {
  const names = { "Compendium.dnd5e.equipment24.Item.phbtulSmithsToo": "Smith's Tools" };
  const options = readItemCreatorOptions(CONFIG, localize, uuid => names[uuid] ?? "");
  assert.deepEqual(options.baseTools, [{ value: "smith", label: "Smith's Tools", ability: "str" }, { value: "thief", label: "Thief", ability: "dex" }]);
  assert.equal(options.icons.weapon[0], "systems/dnd5e/icons/svg/items/weapon.svg", "the type's default comes first");
  for (const type of ["weapon", "equipment", "consumable", "tool", "loot", "container"]) assert.ok(options.icons[type].length >= 12, type);
});

test("options: base-tool names come from dnd5e.documents.Trait.getBaseItem (index only) by default", () => {
  globalThis.dnd5e = { documents: { Trait: { getBaseItem: (uuid, { indexOnly }) => indexOnly && uuid.endsWith("SmithsToo") ? { name: "Smith's Tools" } : undefined } } };
  assert.equal(readItemCreatorOptions(CONFIG, localize).baseTools[0].label, "Smith's Tools");
});

test("options: a type the system doesn't define is not offered", () => {
  const config = { ...CONFIG, Item: { ...CONFIG.Item, dataModels: { weapon: {}, loot: {} } } };
  assert.deepEqual(readItemCreatorOptions(config, localize).types.map(t => t.value), ["weapon", "loot"]);
});

test("only characters that can hold embedded items may create them", () => {
  const createEmbeddedDocuments = () => [];
  assert.equal(canCreateItems({ type: "character", createEmbeddedDocuments }), true);
  assert.equal(canCreateItems({ type: "npc", createEmbeddedDocuments }), false);
  assert.equal(canCreateItems({ type: "group", createEmbeddedDocuments }), false);
  assert.equal(canCreateItems({ type: "character" }), false);
});

test("an invalid draft is refused with the first field's message", () => {
  assert.equal(draftErrorText({ name: "required" }), "Give the item a name.");
  assert.equal(draftErrorText({ quantity: "wholeNumber", name: "required" }), "Quantity is a whole number from 1 to 9999.");
});

function fakeWorld() {
  const sent = [];
  globalThis.CONFIG = CONFIG;
  globalThis.game = {
    i18n: { localize },
    user: { id: "player1", name: "Mira <b>" },
    users: [{ id: "gm1", isGM: true }, { id: "player1", isGM: false }, { id: "gm2", isGM: true }]
  };
  globalThis.ChatMessage = { create: async data => { sent.push(data); return data; }, getSpeaker: ({ actor }) => ({ actor: actor.id }) };
  return sent;
}

test("create: the embedded item is made from the validated draft and the GMs get one whisper", async () => {
  const sent = fakeWorld();
  const created = [];
  const actor = { id: "a1", name: "Tamsin & Co", type: "character",
    createEmbeddedDocuments: async (name, data) => { created.push([name, data]); return [{ id: "i1", name: data[0].name }]; } };
  let checked = 0;
  const result = await createActorItem(actor, { draft: { type: "weapon", name: "Moon blade", category: "martialM",
    quantity: 1, weight: 3, priceValue: 15, priceDenomination: "gp", damageNumber: 1, damageDie: 8, damageType: "slashing", properties: ["fin"] } },
  { assertCurrent: () => { checked += 1; } });
  assert.deepEqual(result, { itemId: "i1", itemName: "Moon blade" });
  assert.equal(checked, 1, "the session is rechecked right before the write");
  assert.equal(created[0][0], "Item");
  assert.equal(created[0][1][0].type, "weapon");
  assert.equal(created[0][1][0].img, "systems/dnd5e/icons/svg/items/weapon.svg");
  assert.deepEqual(created[0][1][0].system.damage.base, { number: 1, denomination: 8, types: ["slashing"] });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].whisper, ["gm1", "gm2"]);
  assert.deepEqual(sent[0].speaker, { actor: "a1" });
  assert.equal(sent[0].content, '<p class="ve-item-created-note">Mira &lt;b&gt; created Moon blade (Weapon) on Tamsin &amp; Co.</p>');
});

test("create: a consumable gets uses and a Utility use activity under a fresh ID", async () => {
  fakeWorld();
  globalThis.foundry = { utils: { randomID: () => "Zq3vKf9LmN2pR7sT" } };
  const created = [];
  const actor = { id: "a1", name: "T", type: "character", createEmbeddedDocuments: async (_n, data) => { created.push(data[0]); return [{ id: "i2", name: data[0].name }]; } };
  await createActorItem(actor, { draft: { type: "consumable", name: "Tonic", category: "potion", priceDenomination: "gp" } });
  assert.deepEqual(created[0].system.uses, { max: "1", spent: 0, recovery: [], autoDestroy: true });
  assert.deepEqual(created[0].system.activities, { Zq3vKf9LmN2pR7sT: { _id: "Zq3vKf9LmN2pR7sT", type: "utility",
    activation: { type: "action", value: 1 }, consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] } } });
});

test("create: an image off the preset list is refused before anything is written", async () => {
  fakeWorld();
  let writes = 0;
  const actor = { id: "a1", name: "T", type: "character", createEmbeddedDocuments: async () => { writes += 1; return []; } };
  await assert.rejects(createActorItem(actor, { draft: { type: "loot", name: "Gem", priceDenomination: "gp", img: "worlds/x/secret.webp" } }),
    error => error.code === "INVALID_INPUT" && error.message === "Pick one of the pictures shown.");
  assert.equal(writes, 0);
});

test("create: a bad draft writes nothing and sends nothing", async () => {
  const sent = fakeWorld();
  let writes = 0;
  const actor = { id: "a1", name: "T", type: "character", createEmbeddedDocuments: async () => { writes += 1; return []; } };
  await assert.rejects(createActorItem(actor, { draft: { type: "spell", name: "Fireball" } }), error => error.code === "INVALID_INPUT");
  await assert.rejects(createActorItem({ ...actor, type: "npc" }, { draft: { type: "loot", name: "Gem" } }), error => error.code === "CAPABILITY_UNAVAILABLE");
  assert.equal(writes, 0);
  assert.equal(sent.length, 0);
});

test("create: a failed chat note doesn't undo or fail the creation", async () => {
  fakeWorld();
  globalThis.ChatMessage.create = async () => { throw new Error("socket down"); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const actor = { id: "a1", name: "T", type: "character", createEmbeddedDocuments: async (_n, data) => [{ id: "i9", name: data[0].name }] };
    const result = await createActorItem(actor, { draft: { type: "loot", name: "Gem", priceDenomination: "gp" } });
    assert.equal(result.itemId, "i9");
  } finally { console.warn = warn; }
});

test("whisper: nothing is sent in a world without a GM", async () => {
  const sent = fakeWorld();
  globalThis.game.users = [{ id: "player1", isGM: false }];
  assert.equal(await whisperItemCreated({ name: "T" }, { name: "Gem" }, "Loot"), null);
  assert.equal(sent.length, 0);
});

// Localization: every key the feature uses exists in en, en-AU and ru, and the code's English fallback matches en.json.
test("every item-creation string is in all three locales, with matching English fallbacks", () => {
  const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
  const ui = read("../src/features/characters/systems/dnd5e/item-create.mjs");
  const foundry = read("../src/foundry/systems/dnd5e/item-create-actions.mjs") + read("../src/foundry/systems/dnd5e/actor-actions.mjs")
    + read("../src/foundry/command-gateway.mjs");
  const used = new Map();
  for (const [, key, fallback] of ui.matchAll(/text\("([A-Za-z.]+)", "((?:[^"\\]|\\.)*)"/gu)) used.set(`VEMOBILE.ItemCreate.${key}`, fallback);
  for (const [, key, fallback] of foundry.matchAll(/"(VEMOBILE\.ItemCreate\.[A-Za-z.]+)", "((?:[^"\\]|\\.)*)"/gu)) used.set(key, fallback);
  for (const type of TYPES) for (const group of ["Hints", "FormTitles", "DetailsTitles"]) used.set(`VEMOBILE.ItemCreate.${group}.${type}`, null);
  for (const field of ["name", "quantity", "weight", "priceValue", "description", "damageNumber", "armorValue", "uses", "capacity", "category", "img"]) {
    for (const code of ["required", "tooLong", "x"]) { const { key, fallback } = itemCreateErrorMessage(field, code); used.set(key, fallback); }
  }
  assert.ok(used.size > 40, `found ${used.size} keys`);
  const lookup = (dictionary, key) => key.split(".").reduce((node, part) => node?.[part], dictionary);
  for (const locale of ["en", "en-AU", "ru"]) {
    const dictionary = JSON.parse(read(`../locales/${locale}.json`));
    for (const key of used.keys()) assert.equal(typeof lookup(dictionary, key), "string", `${locale} is missing ${key}`);
  }
  const en = JSON.parse(read("../locales/en.json"));
  for (const [key, fallback] of used) if (fallback !== null) assert.equal(lookup(en, key), fallback, `en.json and the code disagree on ${key}`);
});
