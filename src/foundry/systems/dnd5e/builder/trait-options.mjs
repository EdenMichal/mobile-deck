/**
 * Trait steps (skills, tools, languages…): the options a step offers, shared by the step screens (step-model.mjs)
 * and the creation replay's check of saved picks (creation-session.mjs).
 * Data fix 6: with the "any language" house rule, a language choice offers every language dnd5e knows
 * (CONFIG.DND5E.languages, read when the step is built, so groups a module adds after "ready" count).
 * Data fix 4: a saved pick that another tab now grants, or that is no longer offered, is a conflict.
 */
import { currentHouseRules } from "./content-sources.mjs";
import { unfulfilledChoices } from "./trait-choices.mjs";

/** Pure: is this choice pool made only of languages ("languages:standard:*", "languages:exotic:draconic", …)? */
export function isLanguagePool(pool = []) {
  const keys = Array.from(pool ?? []);
  return keys.length > 0 && keys.every(k => String(k).startsWith("languages:"));
}

/** Pure: is this choice pool made only of damage resistances ("dr:fire", …)? */
export function isResistancePool(pool = []) {
  const keys = Array.from(pool ?? []);
  return keys.length > 0 && keys.every(k => /^dr:[a-z]+$/.test(String(k)));
}

/** Pure: the pool's resistances missing from `options` (the character already has them) added back, marked as held. */
export function withHeldResistances(options = [], pool = [], labelOf = key => key, heldText = "{label} (already resistant)") {
  const have = new Set(options.map(o => o.key));
  const held = pool.filter(key => !have.has(key)).map(key => ({ key, label: heldText.replace("{label}", labelOf(key)), group: "" }));
  return [...options, ...held];
}

const heldResistanceText = () => {
  const i18n = globalThis.game?.i18n;
  const key = "VEMOBILE.Builder.TraitHeldResistance";
  return i18n?.has?.(key) ? i18n.localize(key) : "{label} (already resistant)";
};

const resistanceLabel = key => {
  try { return globalThis.dnd5e?.documents?.Trait?.keyLabel?.(key, { trait: "dr" }) || key.split(":").pop(); } catch { return key.split(":").pop(); }
};

/** Pure: saved picks no longer among `valid` keys. Fixed grants aren't the player's choice, so they never conflict. */
export function traitConflicts(chosen = [], valid = new Set(), grants = []) {
  const fixed = new Set(grants);
  return [...new Set(chosen)].filter(key => !valid.has(key) && !fixed.has(key));
}

/**
 * Pure: merge slots offering the same options ("choose 1 skill" twice → "choose 2 skills"). `granted`: every merged slot
 * is a fixed grant of the advancement (dnd5e's "grant" entries: "Common — granted"), not a choice with one option left.
 */
export function mergeSlots(slots = []) {
  const merged = new Map();
  for (const { options, count = 1, granted = false } of slots) {
    if (!options.length) continue;
    const sig = options.map(o => o.key).join("|");
    const slot = merged.get(sig) ?? { options, count: 0, granted: true };
    slot.count += count;
    slot.granted = slot.granted && Boolean(granted);
    merged.set(sig, slot);
  }
  return [...merged.values()];
}

const notPseudo = o => o.key && !/:(ALL|\*)$/.test(o.key);

/** dnd5e's secret class languages: never added by the "any language" rule (only offered where the pool itself has them). */
export const SECRET_LANGUAGES = Object.freeze(["cant", "druidic"]);
const isSecret = key => SECRET_LANGUAGES.includes(String(key).split(":").pop());

/**
 * Pure: the options of a language choice under the "any language" rule: every language the character doesn't know yet
 * (`all`), minus dnd5e's secret class languages unless the pool itself offered them, never the advancement's fixed grants.
 */
export function anyLanguageOptions(all = [], original = [], grants = new Set()) {
  const own = new Set(original.map(o => o.key));
  const out = all.filter(o => !grants.has(o.key) && (!isSecret(o.key) || own.has(o.key)));
  for (const o of original) if (!grants.has(o.key) && !out.some(x => x.key === o.key)) out.push(o);
  return out;
}

/**
 * The step's slots: [{ count, granted, options: [{ key, label, group }] }] (granted: a fixed grant, see mergeSlots).
 * - A choice pool of languages offers every language the character doesn't know yet when `anyLanguage` is on (each with
 *   its group label: "Standard Languages", "Rare Languages - Primordial", a module's own group), except Thieves' Cant and
 *   Druidic unless the pool has them. Non-selectable group nodes never become options.
 * - With `allowReplacements` (dnd5e's own rule, e.g. 2014 backgrounds), a grant or choice the character already has is
 *   replaced as dnd5e's availableChoices does: one slot for all of the step's picks, from every option of that trait type.
 */
export async function traitSlots(adv, { anyLanguage = currentHouseRules().anyLanguage } = {}) {
  // Inside a replay step the driver shares one computation; otherwise the faster port of dnd5e's own (same result).
  const { available, choices } = await (Object.hasOwn(adv, "unfulfilledChoices") ? adv.unfulfilledChoices() : unfulfilledChoices(adv));
  const grants = new Set(adv.configuration.grants ?? []);
  const asOptions = list => list.asOptions().map(o => ({ key: o.value, label: o.label, group: o.group ?? "" })).filter(notPseudo);
  let languages = null;
  const entries = [];
  for (const entry of available) {
    let options = asOptions(entry.choices);
    const pool = entry.type === "choice" ? adv.configuration.choices?.[entry.choiceIdx]?.pool : null;
    if (anyLanguage && pool && isLanguagePool(pool)) {
      languages ??= asOptions(choices.filter(new Set(["languages:*"]), { inplace: false }));
      options = anyLanguageOptions(languages, options, grants);
    }
    // L20 fix 13: a damage-type choice (Draconic Sorcery's Elemental Affinity) may name a resistance the character
    // already has (a fire Dragonborn choosing Fire): the choice matters beyond the resistance, so it stays offered.
    if (pool && isResistancePool(pool)) options = withHeldResistances(options, Array.from(pool), resistanceLabel, heldResistanceText());
    entries.push({ options, granted: entry.type === "grant" });
  }
  const represented = typeof adv.representedTraits === "function" ? adv.representedTraits() : new Set();
  const trait = represented.size === 1 ? [...represented][0] : "";
  return shapeSlots(entries, { allowReplacements: Boolean(adv.configuration.allowReplacements), trait,
    typeOptions: () => (trait ? asOptions(choices.filter(new Set([`${trait}:*`]), { inplace: false })) : []) });
}

/**
 * Pure: a Trait step's entries ([{ options, granted }], options after any widening) as screen slots. Normally one slot
 * per entry, merged (mergeSlots). With `allowReplacements` and an entry left with nothing to offer (counted after the
 * "any language" widening), dnd5e's availableChoices replaces them all with one slot: `count` = all entries, every
 * option of the trait type (`typeOptions()`; Thieves' Cant and Druidic only if an entry itself offered them),
 * `replacement: true`, and `preselected`: the grants still to give (a single-option grant entry, as dnd5e pre-checks
 * them: a 2014 Acolyte's Religion when Insight is already known).
 */
export function shapeSlots(entries = [], { allowReplacements = false, trait = "", typeOptions = () => [] } = {}) {
  const empty = entries.filter(e => !e.options.length).length;
  if (allowReplacements && empty && trait) {
    const own = new Set(entries.flatMap(e => e.options.map(o => o.key)));
    const all = typeOptions();
    const options = trait === "languages" ? all.filter(o => !isSecret(o.key) || own.has(o.key)) : all;
    const offered = new Set(options.map(o => o.key));
    const preselected = entries.filter(e => e.granted && e.options.length === 1).map(e => e.options[0].key).filter(k => offered.has(k));
    return options.length ? [{ options, count: entries.length, granted: false, replacement: true, preselected }] : [];
  }
  return mergeSlots(entries.map(e => ({ options: e.options, count: 1, granted: e.granted })));
}

const TAB_OF = { background: "background", race: "species", class: "class", subclass: "class" };

/**
 * The creation tab an item comes from ("class" | "background" | "species", "" when unknown): its own type, or the type
 * of the item that granted it (dnd5e's advancementRoot flag: Magic Initiate → its background).
 */
export function rootTab(actor, item) {
  if (!item) return { tab: "", name: "" };
  let root = item;
  const rootId = String(item.getFlag?.("dnd5e", "advancementRoot") ?? item.flags?.dnd5e?.advancementRoot ?? "").split(".")[0];
  if (!TAB_OF[root.type] && rootId) root = actor?.items?.get(rootId) ?? root;
  return { tab: TAB_OF[root.type] ?? "", name: root.name };
}

/** Which tab and item already give `key`: the item whose Trait advancement chose it, followed to its root item. */
export function traitSource(actor, key) {
  for (const item of actor.items) {
    const advs = item.advancement?.byType?.Trait ?? [];
    if (advs.some(a => a.value?.chosen?.has?.(key))) return rootTab(actor, item);
  }
  return { tab: "", name: "" };
}

/**
 * checkAnswer hook for createLevelUpSession (creation only): for a Trait step, the saved picks that are no longer
 * offered, with the tab that now gives them. Null when the answer still fits.
 */
export async function checkTraitAnswer(adv, level, data) {
  if (adv.constructor.typeName !== "Trait") return null;
  const slots = await traitSlots(adv);
  const valid = new Set(slots.flatMap(s => s.options.map(o => o.key)));
  // With dnd5e's replacement slot, a saved grant the character now has elsewhere is no longer the step's to give.
  const fixed = slots.some(s => s.replacement) ? [] : Array.from(adv.configuration.grants ?? []);
  const bad = traitConflicts(data?.chosen ?? [], valid, fixed);
  if (!bad.length) return null;
  const keyLabel = globalThis.dnd5e?.documents?.Trait?.keyLabel;
  return { conflicts: bad.map(key => {
    let label = key;
    try { label = keyLabel?.(key) || key; } catch { label = key; }
    return { key, label, ...traitSource(adv.actor, key) };
  }) };
}
