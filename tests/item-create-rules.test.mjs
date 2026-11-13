// Unit tests for player item creation (spec 2026-11-13 §2). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CREATABLE_ITEM_TYPES, ITEM_CREATE_LIMITS, emptyItemDraft, itemDataFromDraft, descriptionHtml, escapeHtml,
  showsArmorValue, typeOption, itemCreateErrorMessage, useActivity
} from "../src/foundry/systems/dnd5e/item-create-rules.mjs";

// The plain options record the gateway reads from CONFIG.DND5E (labels already localized).
const options = Object.freeze({
  types: [
    { value: "weapon", label: "Weapon", img: "systems/dnd5e/icons/svg/items/weapon.svg" },
    { value: "equipment", label: "Equipment", img: "systems/dnd5e/icons/svg/items/equipment.svg" },
    { value: "consumable", label: "Consumable", img: "systems/dnd5e/icons/svg/items/consumable.svg" },
    { value: "tool", label: "Tool", img: "systems/dnd5e/icons/svg/items/tool.svg" },
    { value: "loot", label: "Loot", img: "systems/dnd5e/icons/svg/items/loot.svg" },
    { value: "container", label: "Container", img: "systems/dnd5e/icons/svg/items/container.svg" }
  ],
  weaponTypes: [{ value: "simpleM", label: "Simple Melee" }, { value: "martialR", label: "Martial Ranged" }],
  weaponProperties: [{ value: "fin", label: "Finesse" }, { value: "lgt", label: "Light" }],
  damageTypes: [{ value: "slashing", label: "Slashing" }, { value: "fire", label: "Fire" }],
  dieFaces: [4, 6, 8, 10, 12, 20],
  equipmentTypes: [{ value: "light", label: "Light Armor" }, { value: "medium", label: "Medium Armor" },
    { value: "shield", label: "Shield" }, { value: "trinket", label: "Trinket" }],
  armorTypes: ["light", "medium", "heavy", "natural", "shield"],
  consumableTypes: [{ value: "potion", label: "Potion" }, { value: "food", label: "Food" }],
  toolTypes: [{ value: "art", label: "Artisan's Tools" }],
  lootTypes: [{ value: "gem", label: "Gem" }],
  currencies: [{ value: "gp", label: "GP" }, { value: "sp", label: "SP" }],
  defaultCurrency: "gp",
  baseTools: [{ value: "smith", label: "Smith's Tools", ability: "str" }, { value: "lute", label: "Lute", ability: "cha" }],
  icons: {
    weapon: ["systems/dnd5e/icons/svg/items/weapon.svg", "icons/weapons/swords/scimitar-blue.webp"],
    loot: ["systems/dnd5e/icons/svg/items/loot.svg", "icons/commodities/gems/pearl-beige-smooth.webp"]
  }
});

test("the six dnd5e inventory types, in a fixed order, and nothing else", () => {
  assert.deepEqual([...CREATABLE_ITEM_TYPES], ["weapon", "equipment", "consumable", "tool", "loot", "container"]);
  assert.ok(Object.isFrozen(CREATABLE_ITEM_TYPES));
  assert.equal(typeOption("weapon", options).img, "systems/dnd5e/icons/svg/items/weapon.svg");
  assert.equal(typeOption("spell", options), null);
});

test("a fresh draft starts with one item worth nothing in the default currency", () => {
  const draft = emptyItemDraft("weapon", options);
  assert.equal(draft.type, "weapon");
  assert.equal(draft.name, "");
  assert.equal(draft.quantity, 1);
  assert.equal(draft.weight, 0);
  assert.equal(draft.priceValue, 0);
  assert.equal(draft.priceDenomination, "gp");
  assert.equal(draft.category, "simpleM");
  assert.equal(draft.damageNumber, 1);
  assert.equal(draft.damageDie, 6);
  assert.deepEqual(draft.properties, []);
  assert.equal(emptyItemDraft("equipment", options).category, "");
});

test("a name is required, trimmed and capped", () => {
  assert.deepEqual(itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "   " }, options).errors, { name: "required" });
  const long = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "x".repeat(ITEM_CREATE_LIMITS.name + 1) }, options);
  assert.equal(long.errors.name, "tooLong");
  const ok = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "  Pearl  " }, options);
  assert.equal(ok.ok, true);
  assert.equal(ok.data.name, "Pearl");
});

test("only the six types are accepted", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("weapon", options), type: "spell", name: "Fireball" }, options);
  assert.equal(result.ok, false);
  assert.equal(result.errors.type, "choice");
});

test("common fields: quantity, weight, price, description and the type's default image", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Silver ring", quantity: "3", weight: "0.5",
    priceValue: "25", priceDenomination: "sp", category: "gem", description: "Engraved.\nOld.\n\nWarm to the touch." }, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    name: "Silver ring", type: "loot", img: "systems/dnd5e/icons/svg/items/loot.svg",
    system: {
      quantity: 3, weight: { value: 0.5 }, price: { value: 25, denomination: "sp" },
      description: { value: "<p>Engraved.<br>Old.</p><p>Warm to the touch.</p>" },
      type: { value: "gem" }
    }
  });
});

test("blank numbers fall back to the defaults; bad numbers are refused field by field", () => {
  const blank = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Rock", quantity: "", weight: "", priceValue: "" }, options);
  assert.equal(blank.data.system.quantity, 1);
  assert.equal(blank.data.system.weight.value, 0);
  assert.equal(blank.data.system.price.value, 0);
  const bad = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Rock", quantity: "1.5", weight: "-2",
    priceValue: "abc", priceDenomination: "zz" }, options);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.errors, { quantity: "wholeNumber", weight: "number", priceValue: "number", priceDenomination: "choice" });
  assert.equal(itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Rock", quantity: "0" }, options).errors.quantity, "wholeNumber");
  assert.equal(itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Rock", quantity: String(ITEM_CREATE_LIMITS.quantity + 1) }, options).errors.quantity, "wholeNumber");
});

test("weapon: category, base damage dice and type, properties", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Flame tongue", category: "martialR",
    damageNumber: "2", damageDie: "8", damageType: "fire", properties: ["fin", "lgt"] }, options);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.system.type, { value: "martialR" });
  assert.deepEqual(result.data.system.damage, { base: { number: 2, denomination: 8, types: ["fire"] } });
  assert.deepEqual(result.data.system.properties, ["fin", "lgt"]);
});

test("weapon: no dice means no base damage; a blank type leaves the damage untyped", () => {
  const none = itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Net", damageNumber: "0" }, options);
  assert.equal(none.ok, true);
  assert.equal(none.data.system.damage, undefined);
  const untyped = itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Club", damageType: "" }, options);
  assert.deepEqual(untyped.data.system.damage.base, { number: 1, denomination: 6, types: [] });
});

test("weapon: unknown dice, damage types, categories and properties are refused", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Odd", category: "laser",
    damageNumber: "1", damageDie: "7", damageType: "psionic", properties: ["fin", "xyz"] }, options);
  assert.deepEqual(result.errors, { category: "choice", damageDie: "choice", damageType: "choice", properties: "choice" });
  assert.equal(itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Huge", damageNumber: "99" }, options).errors.damageNumber, "wholeNumber");
});

test("equipment: armor value only for armor types; medium armor caps Dex at +2", () => {
  assert.equal(showsArmorValue("light", options), true);
  assert.equal(showsArmorValue("trinket", options), false);
  const medium = itemDataFromDraft({ ...emptyItemDraft("equipment", options), name: "Scale mail", category: "medium", armorValue: "14" }, options);
  assert.deepEqual(medium.data.system.type, { value: "medium" });
  assert.deepEqual(medium.data.system.armor, { value: 14, dex: 2 });
  const shield = itemDataFromDraft({ ...emptyItemDraft("equipment", options), name: "Shield", category: "shield", armorValue: "2" }, options);
  assert.deepEqual(shield.data.system.armor, { value: 2 });
  const trinket = itemDataFromDraft({ ...emptyItemDraft("equipment", options), name: "Locket", category: "trinket", armorValue: "18" }, options);
  assert.equal(trinket.data.system.armor, undefined);
  const blank = itemDataFromDraft({ ...emptyItemDraft("equipment", options), name: "Leather", category: "light", armorValue: "" }, options);
  assert.equal(blank.errors.armorValue, "required", "armor and shields need their Armor Class");
  assert.equal(itemDataFromDraft({ ...emptyItemDraft("equipment", options), name: "Plate", category: "light", armorValue: "99" }, options).errors.armorValue, "wholeNumber");
});

test("consumable: no uses given means single-use (one use per item, spent from the stack)", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("consumable", options), name: "Potion of healing", category: "potion", uses: "" }, options);
  assert.deepEqual(result.data.system.type, { value: "potion" });
  assert.deepEqual(result.data.system.uses, { max: "1", spent: 0, recovery: [], autoDestroy: true });
  assert.equal(result.data.system.activities, undefined, "the form's check never invents an activity id");
});

test("consumable: a number of uses is charges that stay when spent", () => {
  const wand = itemDataFromDraft({ ...emptyItemDraft("consumable", options), name: "Wand of sparks", category: "potion", uses: "7" }, options);
  assert.deepEqual(wand.data.system.uses, { max: "7", spent: 0, recovery: [], autoDestroy: false });
  assert.equal(itemDataFromDraft({ ...emptyItemDraft("consumable", options), name: "X", uses: "-1" }, options).errors.uses, "wholeNumber");
});

test("consumable: with an activity id, a Utility activity spends one of the item's own uses", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("consumable", options), name: "Ration", category: "food" }, options, { activityId: "abcdefghijklmnop" });
  assert.deepEqual(result.data.system.activities, {
    abcdefghijklmnop: useActivity("abcdefghijklmnop")
  });
  assert.deepEqual(useActivity("abcdefghijklmnop"), {
    _id: "abcdefghijklmnop", type: "utility",
    activation: { type: "action", value: 1 },
    consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] }
  });
});

test("consumable: ammunition is spent by the weapon, so it gets no use activity and no uses unless asked", () => {
  const options2 = { ...options, consumableTypes: [...options.consumableTypes, { value: "ammo", label: "Ammunition" }] };
  const arrows = itemDataFromDraft({ ...emptyItemDraft("consumable", options2), name: "Arrows", category: "ammo", quantity: "20" }, options2, { activityId: "abcdefghijklmnop" });
  assert.equal(arrows.data.system.activities, undefined);
  assert.equal(arrows.data.system.uses, undefined);
});

test("tool: tool type", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("tool", options), name: "Smith's tools", category: "art" }, options);
  assert.deepEqual(result.data.system.type, { value: "art" });
  assert.equal(result.data.system.ability, undefined);
  assert.equal(itemDataFromDraft({ ...emptyItemDraft("tool", options), name: "Kit", category: "potion" }, options).errors.category, "choice");
});

test("tool: a base tool links proficiency (type.baseItem) and its default ability", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("tool", options), name: "Grandad's hammers", category: "art", baseTool: "smith" }, options);
  assert.deepEqual(result.data.system.type, { value: "art", baseItem: "smith" });
  assert.equal(result.data.system.ability, "str");
  const noCategory = itemDataFromDraft({ ...emptyItemDraft("tool", options), name: "Lute", baseTool: "lute" }, options);
  assert.deepEqual(noCategory.data.system.type, { value: "", baseItem: "lute" });
  assert.equal(itemDataFromDraft({ ...emptyItemDraft("tool", options), name: "X", baseTool: "laser" }, options).errors.baseTool, "choice");
});

test("image: the type's default unless a preset is picked; anything off the list is refused", () => {
  assert.equal(emptyItemDraft("weapon", options).img, "systems/dnd5e/icons/svg/items/weapon.svg");
  const picked = itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Blade", img: "icons/weapons/swords/scimitar-blue.webp" }, options);
  assert.equal(picked.data.img, "icons/weapons/swords/scimitar-blue.webp");
  const blank = itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Blade", img: "" }, options);
  assert.equal(blank.data.img, "systems/dnd5e/icons/svg/items/weapon.svg");
  for (const img of ["icons/commodities/gems/pearl-beige-smooth.webp", "https://evil.example/x.png", "../../etc/passwd"]) {
    assert.equal(itemDataFromDraft({ ...emptyItemDraft("weapon", options), name: "Blade", img }, options).errors.img, "choice", img);
  }
});

test("container: one container, optional weight capacity", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("container", options), name: "Backpack", quantity: "4", capacity: "30" }, options);
  assert.equal(result.ok, true);
  assert.equal(result.data.system.quantity, undefined, "a container is always one item");
  assert.deepEqual(result.data.system.capacity, { weight: { value: 30 } });
  assert.equal(result.data.system.type, undefined, "containers have no category");
  const open = itemDataFromDraft({ ...emptyItemDraft("container", options), name: "Sack", capacity: "" }, options);
  assert.equal(open.data.system.capacity, undefined);
});

test("fields for another type are ignored, never written", () => {
  const result = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Gem", category: "gem",
    damageNumber: "5", damageDie: "12", armorValue: "20", uses: "3", capacity: "100", properties: ["fin"] }, options);
  assert.deepEqual(Object.keys(result.data.system).sort(), ["description", "price", "quantity", "type", "weight"]);
  const tool = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Gem", baseTool: "smith" }, options);
  assert.equal(tool.data.system.ability, undefined);
});

test("description text is escaped into paragraphs and capped", () => {
  assert.equal(descriptionHtml(""), "");
  assert.equal(descriptionHtml("  \n "), "");
  assert.equal(descriptionHtml("<b>bold</b> & \"q\""), "<p>&lt;b&gt;bold&lt;/b&gt; &amp; &quot;q&quot;</p>");
  assert.equal(descriptionHtml("a\r\nb"), "<p>a<br>b</p>");
  const long = itemDataFromDraft({ ...emptyItemDraft("loot", options), name: "Book", description: "x".repeat(ITEM_CREATE_LIMITS.description + 1) }, options);
  assert.equal(long.errors.description, "tooLong");
});

test("escapeHtml covers the five HTML-significant characters", () => {
  assert.equal(escapeHtml(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
});

test("a malformed draft is refused rather than thrown", () => {
  assert.equal(itemDataFromDraft(null, options).ok, false);
  assert.equal(itemDataFromDraft({ type: "weapon", name: "A", properties: "fin" }, options).errors.properties, "choice");
});

test("every error code has a localization key and an English fallback", () => {
  const fields = ["type", "name", "quantity", "weight", "priceValue", "priceDenomination", "description", "category",
    "damageNumber", "damageDie", "damageType", "properties", "armorValue", "uses", "capacity", "img", "baseTool"];
  for (const field of fields) {
    const message = itemCreateErrorMessage(field, "whatever");
    assert.match(message.key, /^VEMOBILE\.ItemCreate\.Errors\.[A-Za-z]+$/u, field);
    assert.ok(message.fallback.length > 5, field);
  }
  assert.notEqual(itemCreateErrorMessage("name", "required").key, itemCreateErrorMessage("name", "tooLong").key);
  assert.equal(itemCreateErrorMessage("unknown", "x").key, "VEMOBILE.ItemCreate.Errors.Choice");
  assert.equal(itemCreateErrorMessage("armorValue", "required").key, "VEMOBILE.ItemCreate.Errors.ArmorRequired");
});
