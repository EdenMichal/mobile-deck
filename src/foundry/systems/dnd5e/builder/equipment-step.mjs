/**
 * Phase 4a: the Equipment tab's Foundry side. dnd5e 5.3.2 stores starting equipment
 * (system.startingEquipment + system.wealth) but nothing grants it (research §2.3), so this
 * builds the option cards, resolves "any X" picks from allowed sources, and adds the chosen gear
 * and coins to the creation copy. Spec §2.5, §3.3.
 */
import { effectivePicks, equipmentBookText, equipmentComplete, equipmentOptions, linkedToolIds, optionLabel, packageContents, resolveContents, startingEquipped } from "./equipment-options.mjs";
import { findEntries, isAllowedUuid, preferredUuid, savedSources, worldRules } from "./content-sources.mjs";

export const EQUIPMENT_SOURCES = Object.freeze(["class", "background"]);
export const TRINKETS_TABLE = "Compendium.dnd5e.tables24.RollTable.phbStartingTrink";

const tr = (key, fallback, data = {}) => {
  const i18n = globalThis.game?.i18n;
  const full = `VEMOBILE.Builder.${key}`;
  const template = i18n?.has?.(full) ? i18n.localize(full) : fallback;
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (data[k] !== undefined ? String(data[k]) : m));
};
const stripHtml = html => String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/** Plain entries from an item's system.startingEquipment (EquipmentEntryData → objects). */
export function plainEntries(item) {
  return Array.from(item?.system?.startingEquipment ?? []).map(e => ({ _id: e._id, group: e.group || null, sort: e.sort ?? 0,
    type: e.type, key: e.key, count: e.count, requiresProficiency: Boolean(e.requiresProficiency) }));
}

/** Option cards for an item: its entries, its wealth, and coins its book text names when no entry holds them. */
export function itemEquipmentOptions(item, entries = plainEntries(item)) {
  return equipmentOptions(entries, item?.system?.wealth ?? "", { bookText: equipmentBookText(item?.system?.description?.value) });
}

const names = new Map();
async function nameOf(uuid) {
  if (names.has(uuid)) return names.get(uuid);
  const doc = await globalThis.fromUuid(uuid).catch(() => null);
  const name = doc?.name ?? String(uuid).split(".").pop();
  names.set(uuid, name);
  return name;
}

/** "any martial weapon", "any musical instrument", "any holy focus". */
export function categoryLabel(pick) {
  const D = globalThis.CONFIG.DND5E;
  const i18n = globalThis.game.i18n;
  const config = { armor: D.armorTypes, tool: D.toolTypes, focus: D.focusTypes, weapon: { ...D.weaponProficiencies, ...D.weaponTypes } }[pick.type] ?? {};
  const raw = config[pick.key];
  const label = typeof raw === "string" ? raw : raw?.label ?? "";
  const blank = { armor: "DND5E.Armor", tool: "TYPES.Item.tool", focus: "DND5E.Focus.Label", weapon: "TYPES.Item.weapon" }[pick.type] ?? pick.type;
  let text = i18n.localize(label || blank);
  // "Martial Weapons" already names the weapon; "Martial Melee" doesn't.
  if (pick.type === "weapon" && label && !/weapon/i.test(text)) text = `${text} ${i18n.localize("TYPES.Item.weapon")}`;
  return tr("Equipment.Any", "any {category}", { category: text.toLowerCase() });
}

const notMagic = e => !e.system?.rarity && !Array.from(e.system?.properties ?? []).includes("mgc");
const weaponMatch = (key, type = "") => (!key ? ["simpleM", "simpleR", "martialM", "martialR"].includes(type)
  : key === "sim" ? type.startsWith("simple") : key === "mar" ? type.startsWith("martial") : type === key);

async function entriesFor(uuids) {
  const out = [];
  for (const raw of uuids) {
    const uuid = await preferredUuid(raw);
    if (!(await isAllowedUuid(uuid))) continue;
    const doc = await globalThis.fromUuid(uuid).catch(() => null);
    if (doc) out.push({ uuid, name: doc.name, img: doc.img, source: "" });
  }
  return out;
}

/**
 * Items an "any X" pick can be, from allowed sources, without magic items. A tool pick linked to
 * proficiencies chosen on the same item ("same as above") offers only those tools.
 */
export async function equipmentCandidates(pick, { linkedIds = [], cache = null } = {}) {
  if (!cache) return findCandidates(pick, linkedIds);
  // Performance: the same pick under the same sources gives the same items (a scan of every pack index otherwise).
  const key = JSON.stringify([savedSources(), worldRules(), pick.type, pick.key ?? "", linkedIds]);
  if (!cache.candidates.has(key)) cache.candidates.set(key, findCandidates(pick, linkedIds).catch(error => { cache.candidates.delete(key); throw error; }));
  return (await cache.candidates.get(key)).map(c => ({ ...c }));
}

async function findCandidates(pick, linkedIds) {
  const D = globalThis.CONFIG.DND5E;
  if (pick.type === "tool" && linkedIds.length) return entriesFor(linkedIds.map(id => D.tools?.[id]?.id).filter(Boolean));
  if (pick.type === "focus") return entriesFor(Object.values(D.focusTypes?.[pick.key]?.itemIds ?? {}));
  if (pick.type === "weapon" && D.weaponIds?.[pick.key]) return entriesFor([D.weaponIds[pick.key]]);
  const match = {
    tool: e => e.type === "tool" && (!pick.key || e.system?.type?.value === pick.key),
    weapon: e => e.type === "weapon" && weaponMatch(pick.key, e.system?.type?.value),
    armor: e => e.type === "equipment" && (!pick.key || e.system?.type?.value === pick.key)
  }[pick.type];
  if (!match) return [];
  return (await findEntries(e => match(e) && notMagic(e))).map(e => ({ uuid: e.uuid, name: e.name, img: e.img, source: e.packLabel, tier: e.tier ?? null }));
}

/** Choices open in the chosen package, including choices inside a chosen choice. */
function openChoices(entries, option, answer, labelOf) {
  const out = [];
  const visit = contents => {
    for (const ch of contents.choices) {
      const value = answer.choices?.[ch.id] ?? null;
      out.push({ id: ch.id, value, options: ch.options.map(o => ({ id: o.id, label: labelOf({ kind: "package", roots: [o.id] }) })) });
      const picked = ch.options.find(o => o.id === value);
      if (picked) visit(picked);
    }
  };
  visit(packageContents(entries, option));
  return out;
}

/** Is `actor` proficient with this item? (Spec §2.5: linked items marked "if proficient".) */
export function isProficient(actor, doc) {
  const traits = actor?.system?.traits ?? {};
  const type = doc?.system?.type?.value ?? "";
  const base = doc?.system?.type?.baseItem ?? "";
  if (doc?.type === "weapon") {
    const have = new Set(traits.weaponProf?.value ?? []);
    return have.has(type.startsWith("simple") ? "sim" : type.startsWith("martial") ? "mar" : type) || have.has(base);
  }
  if (doc?.type === "equipment") {
    const key = { light: "lgt", medium: "med", heavy: "hvy", shield: "shl" }[type];
    const have = new Set(traits.armorProf?.value ?? []);
    return !key || have.has(key) || have.has(base);
  }
  if (doc?.type === "tool") return Number(actor?.system?.tools?.[base]?.value) > 0;
  return true;
}

/**
 * dnd5e's generated equipment text, or "" when it can't build it: its EquipmentEntryData rejects entries homebrew and DDB
 * data store with `count: null` (seen in a homebrew class), and the getter throws.
 */
function generatedText(item) {
  try { return stripHtml(item.system.startingEquipmentDescription ?? ""); } catch { return ""; }
}

/** View model for one source (class or background) on the Equipment tab. */
export async function equipmentSection(source, item, answer = {}, { chosenTraits = [], actor = null, cache = null, goldRolled = true } = {}) {
  if (!item) return { source, missing: true, options: [], choices: [], picks: [], warnings: [], option: null, complete: false, empty: false };
  const entries = plainEntries(item);
  const options = itemEquipmentOptions(item, entries);
  const uuids = new Set();
  const collect = c => { c.items.forEach(i => uuids.add(i.uuid)); c.choices.forEach(ch => ch.options.forEach(collect)); };
  options.filter(o => o.kind === "package").forEach(o => collect(packageContents(entries, o)));
  const nameMap = new Map(await Promise.all([...uuids].map(async u => [u, await nameOf(u)])));
  const labelOf = o => optionLabel(entries, o, { nameOf: u => nameMap.get(u) ?? u, categoryOf: categoryLabel });
  const chosen = options.find(o => o.id === answer.option) ?? null;
  let choices = [];
  let picks = [];
  const warnings = [];
  if (chosen?.kind === "package") {
    choices = openChoices(entries, chosen, answer, labelOf);
    const resolved = resolveContents(entries, chosen, answer);
    for (const i of resolved.items.filter(x => x.requiresProficiency)) {
      const doc = await globalThis.fromUuid(i.uuid).catch(() => null);
      if (doc && actor && !isProficient(actor, doc)) warnings.push(tr("Equipment.NotProficient", "Not proficient: {name}", { name: doc.name }));
    }
    picks = await Promise.all(resolved.picks.map(async p => {
      const linkedIds = p.type === "tool" ? linkedToolIds(chosenTraits, p.key) : [];
      return { ...p, label: categoryLabel(p), linked: linkedIds.length > 0, candidates: await equipmentCandidates(p, { linkedIds, cache }) };
    }));
  }
  const effective = effectivePicks(answer, picks);
  // `picked`: the player's own tap (saved); an auto-filled lone candidate isn't saved back.
  for (const p of picks) { p.value = effective.picks[p.id] ?? null; p.picked = Boolean(p.value) && answer.picks?.[p.id] === p.value; }
  return {
    source, item: { name: item.name, img: item.img || "" },
    options: options.map(o => ({ id: o.id, kind: o.kind, label: labelOf(o) })),
    option: chosen?.id ?? null, choices, picks, warnings,
    bookText: equipmentBookText(item.system.description?.value) || generatedText(item),
    // `empty`: the item lists no starting equipment (DDB's TCMP1 backgrounds): nothing to choose, so it doesn't block.
    empty: !options.length,
    // A dice-formula gold option counts once it has been rolled (goldRolled): an unrolled one would add nothing.
    complete: !options.length || (equipmentComplete(entries, chosen, effective) && !(chosen?.kind === "gold" && chosen.gp === null && !goldRolled))
  };
}

/**
 * dnd5e's createWithContents for one compendium item (a pack and what it holds). Performance: with a cache, the
 * contents are read from the pack once; each use gets a deep copy with fresh ids (container links follow them).
 */
async function itemWithContents(doc, cache) {
  const create = () => globalThis.CONFIG.Item.documentClass.createWithContents([doc]);
  if (!cache) return create();
  if (!cache.contents.has(doc.uuid)) cache.contents.set(doc.uuid, create().catch(error => { cache.contents.delete(doc.uuid); throw error; }));
  const template = globalThis.foundry.utils.deepClone(await cache.contents.get(doc.uuid));
  const ids = new Map(template.map(d => [d._id, globalThis.foundry.utils.randomID()]));
  for (const d of template) {
    d._id = ids.get(d._id);
    if (d.system?.container && ids.has(d.system.container)) d.system.container = ids.get(d.system.container);
  }
  return template;
}

/**
 * Unarmored Defense on the copy, if any: Barbarian 10 + DEX + CON (a shield allowed), Monk 10 + DEX + WIS (no shield).
 * Read from the class's own feature (identifier or name), so a homebrew class with neither gets none.
 */
export function unarmoredDefense(actor) {
  const mod = k => Number(actor.system.abilities?.[k]?.mod) || 0;
  const classes = actor.classes ?? {};
  const feature = actor.items.some(i => i.type === "feat" && (i.system?.identifier === "unarmored-defense" || i.name === "Unarmored Defense"));
  if (!feature) return null;
  if (classes.barbarian) return { ac: 10 + mod("dex") + mod("con"), shield: true };
  if (classes.monk) return { ac: 10 + mod("dex") + mod("wis"), shield: false };
  return null;
}

/**
 * Add the chosen equipment and coins to the creation copy (spec §3.3). `sources` is
 * [{ item, answer, chosenTraits, wealthRoll }]. Returns { notFound: [names], coins }.
 */
export async function applyEquipment(clone, sources, { cache = null } = {}) {
  const notFound = [];
  const coins = {};
  const itemData = [];
  for (const { item, answer = {}, chosenTraits = [], wealthRoll = null } of sources) {
    if (!item || !answer.option) continue;
    const entries = plainEntries(item);
    const option = itemEquipmentOptions(item, entries).find(o => o.id === answer.option);
    if (!option) continue;
    if (option.kind === "gold") {
      const gp = option.gp ?? Number(wealthRoll);
      if (gp) coins.gp = (coins.gp ?? 0) + gp;
      continue;
    }
    const resolved = resolveContents(entries, option, answer);
    const picks = await Promise.all(resolved.picks.map(async p => ({ ...p,
      candidates: await equipmentCandidates(p, { linkedIds: p.type === "tool" ? linkedToolIds(chosenTraits, p.key) : [], cache }) })));
    const effective = effectivePicks(answer, picks);
    const wanted = [...resolved.items.map(i => ({ uuid: i.uuid, count: i.count })),
      ...picks.filter(p => effective.picks[p.id]).map(p => ({ uuid: effective.picks[p.id], count: p.count }))];
    for (const { uuid, count } of wanted) {
      const doc = await globalThis.fromUuid(await preferredUuid(uuid)).catch(() => null);
      if (!doc) { notFound.push(await nameOf(uuid)); continue; }
      // Containers (packs) are created whole, once per count; other items get the count as quantity.
      const copies = doc.type === "container" ? count : 1;
      for (let n = 0; n < copies; n++) {
        const data = await itemWithContents(doc, cache);
        if (doc.type !== "container" && data[0]) data[0].system.quantity = count;
        itemData.push(...data);
      }
    }
    for (const [k, v] of Object.entries(resolved.coins)) coins[k] = (coins[k] ?? 0) + v;
  }
  // Worn and wielded from the start (D&D Beyond): the best armor the character is trained with, a shield, the weapons.
  const dexMod = Number(clone.system.abilities?.dex?.mod) || 0;
  for (const index of startingEquipped(itemData, { dexMod, strength: Number(clone.system.abilities?.str?.value) || 0,
    proficient: data => isProficient(clone, data), unarmored: unarmoredDefense(clone) })) {
    globalThis.foundry.utils.setProperty(itemData[index], "system.equipped", true);
  }
  if (itemData.length) clone.updateSource({ items: itemData });
  if (Object.keys(coins).length) {
    const current = clone.toObject().system.currency ?? {};
    const keys = new Set([...Object.keys(current), ...Object.keys(coins)]);
    clone.updateSource({ "system.currency": Object.fromEntries([...keys].map(k => [k, (Number(current[k]) || 0) + (coins[k] ?? 0)])) });
  }
  return { notFound, coins };
}

/** The free trinket (rules: one at no cost) as a Tiny loot item. */
export function applyTrinket(clone, text) {
  if (!text) return;
  const name = text.length > 60 ? `${text.slice(0, 57).trimEnd()}…` : text;
  const esc = globalThis.foundry.utils.escapeHTML ?? (s => s);
  clone.updateSource({ items: [{ _id: globalThis.foundry.utils.randomID(), name, type: "loot", img: "icons/svg/item-bag.svg",
    system: { description: { value: `<p>${esc(text)}</p>` }, quantity: 1 } }] });
}
