/**
 * Player item creation (spec 2026-11-13 §2): the pure rules shared by the mobile form and the command handler.
 * A draft is the flat record the form edits; `itemDataFromDraft` turns it into dnd5e Item source data, or into
 * per-field error codes. The handler runs it again on whatever the client sent, so the form's checks are a courtesy.
 *
 * `options` is the plain record the gateway reads from CONFIG.DND5E (see readItemCreator in actor-actions.mjs):
 * { types, weaponTypes, weaponProperties, damageTypes, dieFaces, equipmentTypes, armorTypes, consumableTypes,
 *   toolTypes, lootTypes, currencies, defaultCurrency, baseTools, icons } where each list is [{ value, label }]
 * (types add `img`, baseTools add `ability`) and `icons` maps each type to its allowed image paths.
 * No Foundry globals here.
 */

/** The dnd5e inventory types a player may create, in picker order. No spells, features or other types. */
export const CREATABLE_ITEM_TYPES = Object.freeze(["weapon", "equipment", "consumable", "tool", "loot", "container"]);

export const ITEM_CREATE_LIMITS = Object.freeze({
  name: 100, description: 5000, quantity: 9999, weight: 100000, price: 10000000,
  damageNumber: 20, armorValue: 30, uses: 999, capacity: 100000
});

// Which options list holds the `category` choices for each type (containers have none).
const CATEGORY_LISTS = Object.freeze({
  weapon: "weaponTypes", equipment: "equipmentTypes", consumable: "consumableTypes", tool: "toolTypes", loot: "lootTypes"
});
const MEDIUM_ARMOR_DEX_CAP = 2;

/** The picker entry for a type ({ value, label, img }), or null for a type players can't create. */
export function typeOption(type, options) {
  if (!CREATABLE_ITEM_TYPES.includes(type)) return null;
  return (options?.types ?? []).find(entry => entry.value === type) ?? null;
}

/** Whether the equipment category takes an armor value (armor and shields; not clothing, rings, trinkets...). */
export function showsArmorValue(category, options) {
  return Boolean(category) && (options?.armorTypes ?? []).includes(category);
}

/** The image paths a player may pick for a type: the presets, else only the type's default. */
export function iconChoices(type, options) {
  const presets = options?.icons?.[type];
  if (Array.isArray(presets) && presets.length) return presets.map(String);
  const fallback = typeOption(type, options)?.img;
  return fallback ? [fallback] : [];
}

/** A dnd5e Utility activity that spends one of the item's own uses (a potion you drink, a wand charge). */
export function useActivity(id) {
  return {
    _id: id, type: "utility",
    activation: { type: "action", value: 1 },
    consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] }
  };
}

/** The form's starting values for a type. */
export function emptyItemDraft(type, options) {
  return {
    type, name: "", img: iconChoices(type, options)[0] ?? "", quantity: 1, weight: 0, priceValue: 0,
    priceDenomination: options?.defaultCurrency || options?.currencies?.[0]?.value || "gp",
    description: "",
    category: type === "weapon" ? (choiceValues(options?.weaponTypes)[0] ?? "") : "",
    damageNumber: 1, damageDie: 6, damageType: "", properties: [],
    armorValue: "", uses: "", capacity: "", baseTool: ""
  };
}

/**
 * Validate a draft and build the Item source data.
 * `activityId` (Foundry side only, a fresh random ID) adds a consumable's use activity; the form's own check leaves it out.
 * @returns {{ ok: true, data: object } | { ok: false, errors: Record<string, string> }}
 *   Error codes: required, tooLong, choice, number, wholeNumber.
 */
export function itemDataFromDraft(draft, options, { activityId = "" } = {}) {
  const errors = {};
  if (!draft || typeof draft !== "object") return { ok: false, errors: { type: "choice" } };
  const type = String(draft.type ?? "");
  const typeEntry = typeOption(type, options);
  if (!typeEntry) return { ok: false, errors: { type: "choice" } };

  const name = String(draft.name ?? "").trim();
  if (!name) errors.name = "required";
  else if (name.length > ITEM_CREATE_LIMITS.name) errors.name = "tooLong";

  const quantity = readNumber(draft.quantity, { fallback: 1, min: 1, max: ITEM_CREATE_LIMITS.quantity, integer: true });
  const weight = readNumber(draft.weight, { fallback: 0, min: 0, max: ITEM_CREATE_LIMITS.weight });
  const priceValue = readNumber(draft.priceValue, { fallback: 0, min: 0, max: ITEM_CREATE_LIMITS.price });
  if (quantity === null && type !== "container") errors.quantity = "wholeNumber";
  if (weight === null) errors.weight = "number";
  if (priceValue === null) errors.priceValue = "number";
  const denomination = String(draft.priceDenomination ?? "");
  if (!choiceValues(options?.currencies).includes(denomination)) errors.priceDenomination = "choice";

  // Only a preset path: the list doubles as the allowlist, so a client can't point the item at any other file.
  const img = isBlank(draft.img) ? iconChoices(type, options)[0] ?? "" : String(draft.img);
  if (img && !iconChoices(type, options).includes(img)) errors.img = "choice";

  const descriptionText = typeof draft.description === "string" ? draft.description : "";
  if (descriptionText.length > ITEM_CREATE_LIMITS.description) errors.description = "tooLong";

  const system = {};
  if (type !== "container") system.quantity = quantity;
  system.weight = { value: weight };
  system.price = { value: priceValue, denomination };
  system.description = { value: descriptionHtml(descriptionText) };

  // The type's own category ("system.type.value"); blank means "none" except for weapons.
  const listKey = CATEGORY_LISTS[type];
  let category = "";
  if (listKey) {
    category = String(draft.category ?? "");
    if (!category && type === "weapon") category = choiceValues(options?.weaponTypes)[0] ?? "";
    if (category && !choiceValues(options?.[listKey]).includes(category)) errors.category = "choice";
    else if (category) system.type = { value: category };
  }

  if (type === "weapon") Object.assign(system, weaponFields(draft, options, errors));
  if (type === "equipment" && showsArmorValue(category, options)) {
    // Armor without a value would be AC 0 (+ Dex) once equipped, so it's required here.
    const armorValue = readNumber(draft.armorValue, { fallback: null, min: 0, max: ITEM_CREATE_LIMITS.armorValue, integer: true });
    if (isBlank(draft.armorValue)) errors.armorValue = "required";
    else if (armorValue === null) errors.armorValue = "wholeNumber";
    else system.armor = category === "medium" ? { value: armorValue, dex: MEDIUM_ARMOR_DEX_CAP } : { value: armorValue };
  }
  if (type === "consumable") {
    // Blank uses: single-use, each use spends one item from the stack (autoDestroy). A number: charges that stay.
    // Ammunition is spent by the weapon that fires it, so it only gets uses when asked and never a use activity.
    const uses = readNumber(draft.uses, { fallback: 0, min: 0, max: ITEM_CREATE_LIMITS.uses, integer: true });
    if (uses === null) errors.uses = "wholeNumber";
    else if (category !== "ammo") {
      system.uses = { max: String(uses || 1), spent: 0, recovery: [], autoDestroy: !uses };
      if (activityId) system.activities = { [activityId]: useActivity(activityId) };
    } else if (uses > 0) system.uses = { max: String(uses), spent: 0, recovery: [], autoDestroy: false };
  }
  if (type === "tool" && !isBlank(draft.baseTool)) {
    // The base tool is what proficiency matches (actor.system.tools[baseItem]); its ability becomes the default check.
    const baseTool = (options?.baseTools ?? []).find(entry => entry.value === String(draft.baseTool));
    if (!baseTool) errors.baseTool = "choice";
    else {
      system.type = { value: system.type?.value ?? "", baseItem: baseTool.value };
      if (baseTool.ability) system.ability = baseTool.ability;
    }
  }
  if (type === "container") {
    const capacity = readNumber(draft.capacity, { fallback: 0, min: 0, max: ITEM_CREATE_LIMITS.capacity });
    if (capacity === null) errors.capacity = "number";
    else if (capacity > 0) system.capacity = { weight: { value: capacity } };
  }

  if (Object.keys(errors).length) return { ok: false, errors };
  const data = { name, type, ...(img ? { img } : {}), system };
  return { ok: true, data };
}

// Weapon damage (dice + one type) and properties.
function weaponFields(draft, options, errors) {
  const fields = {};
  const number = readNumber(draft.damageNumber, { fallback: 0, min: 0, max: ITEM_CREATE_LIMITS.damageNumber, integer: true });
  if (number === null) errors.damageNumber = "wholeNumber";
  const die = Number(draft.damageDie);
  const damageType = String(draft.damageType ?? "");
  if (number > 0) {
    if (!(options?.dieFaces ?? []).includes(die)) errors.damageDie = "choice";
    if (damageType && !choiceValues(options?.damageTypes).includes(damageType)) errors.damageType = "choice";
    fields.damage = { base: { number, denomination: die, types: damageType ? [damageType] : [] } };
  }
  const properties = draft.properties ?? [];
  const allowed = choiceValues(options?.weaponProperties);
  if (!Array.isArray(properties) || properties.some(key => !allowed.includes(String(key)))) errors.properties = "choice";
  else if (properties.length) fields.properties = [...new Set(properties.map(String))];
  return fields;
}

// One sentence per field (or code): what's wrong and what to enter instead. Keys live in locales/*.json.
const ERROR_MESSAGES = Object.freeze({
  NameRequired: "Give the item a name.",
  NameTooLong: `Keep the name under ${ITEM_CREATE_LIMITS.name} characters.`,
  Quantity: `Quantity is a whole number from 1 to ${ITEM_CREATE_LIMITS.quantity}.`,
  Weight: "Weight is a number, zero or more.",
  Price: "Price is a number, zero or more.",
  Description: `Keep the description under ${ITEM_CREATE_LIMITS.description} characters.`,
  DamageNumber: `Dice is a whole number from 0 to ${ITEM_CREATE_LIMITS.damageNumber}.`,
  ArmorValue: `Armor Class is a whole number from 0 to ${ITEM_CREATE_LIMITS.armorValue}.`,
  Uses: `Uses is a whole number from 0 to ${ITEM_CREATE_LIMITS.uses}.`,
  Capacity: "Capacity is a number, zero or more.",
  ArmorRequired: "Enter the Armor Class (a shield's bonus, e.g. 2).",
  Image: "Pick one of the pictures shown.",
  Choice: "Pick one of the listed options."
});
const ERROR_FIELDS = Object.freeze({
  quantity: "Quantity", weight: "Weight", priceValue: "Price", description: "Description",
  damageNumber: "DamageNumber", armorValue: "ArmorValue", uses: "Uses", capacity: "Capacity", img: "Image"
});

/** The localization key and English fallback for one field's error code. */
export function itemCreateErrorMessage(field, code) {
  const name = field === "name" ? (code === "tooLong" ? "NameTooLong" : "NameRequired")
    : field === "armorValue" && code === "required" ? "ArmorRequired" : ERROR_FIELDS[field] ?? "Choice";
  return { key: `VEMOBILE.ItemCreate.Errors.${name}`, fallback: ERROR_MESSAGES[name] };
}

/** Plain textarea text → escaped HTML paragraphs (blank lines split paragraphs, single newlines become <br>). */
export function descriptionHtml(text) {
  const normalized = String(text ?? "").replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return "";
  return normalized.split(/\n\s*\n/u)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .map(paragraph => `<p>${paragraph.split("\n").map(escapeHtml).join("<br>")}</p>`)
    .join("");
}

/** Escape text for insertion into HTML (chat cards, descriptions). */
export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/gu, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function choiceValues(list) {
  return Array.isArray(list) ? list.map(entry => String(entry?.value ?? entry)) : [];
}

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === "";
}

// A finite number within bounds, the fallback when blank, or null when invalid.
function readNumber(value, { fallback, min, max, integer = false }) {
  if (isBlank(value)) return fallback;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) return null;
  if (integer && !Number.isInteger(number)) return null;
  return number;
}
