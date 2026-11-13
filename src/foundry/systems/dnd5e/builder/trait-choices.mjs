/**
 * Performance: dnd5e 5.3.2's TraitAdvancement#unfulfilledChoices, with each trait type's choice list built once.
 *
 * dnd5e builds the full, sorted choice list of a trait type (`Trait.choices`) for every key it looks at: in
 * actorValues once per trait type, and in mixedChoices once per key, which for the actor's open traits is a few hundred
 * builds per Trait step. Measured at 4× CPU throttling, that was most of a tap. This port is line for line the same
 * logic (actorValues, actorSelected, mixedChoices, unfulfilledChoices), except that each trait type's list comes from
 * `lists` (built once, never written to: every use filters a copy) and mixedChoices filters once per trait type with all
 * of that type's keys, which keeps the same entries in the same order as merging one filter per key.
 * Shared by creation and level-up through advancement-driver.mjs; verified against dnd5e's own results (see the perf
 * notes in the creation data-fix report).
 */

const dnd5e = () => globalThis.dnd5e;

/** One replay's lists: trait type → Promise<SelectChoices> (dnd5e's own `Trait.choices(trait, { prefixed: true })`). */
export function createTraitLists() { return new Map(); }

function listFor(lists, trait) {
  if (!lists.has(trait)) lists.set(trait, dnd5e().documents.Trait.choices(trait, { prefixed: true }));
  return lists.get(trait);
}

/** dnd5e `actorValues` (documents/actor/trait.mjs). */
async function actorValues(actor, trait, lists) {
  const Trait = dnd5e().documents.Trait;
  const data = globalThis.foundry.utils.getProperty(actor._source, Trait.actorKeyPath(trait));
  if (!data) return {};
  const values = {};
  const traitChoices = await listFor(lists, trait);
  const setValue = (k, v) => {
    const result = traitChoices.find(k);
    if (result) values[result[0]] = v;
  };
  if (["skills", "tool"].includes(trait)) Object.entries(data).forEach(([k, d]) => setValue(k, d.value));
  else if (trait === "saves") Object.entries(data).forEach(([k, d]) => setValue(k, d.proficient));
  else if (trait === "dm") Object.entries(data.amount).forEach(([k, d]) => setValue(k, d));
  else data.value?.forEach(v => setValue(v, 1));
  if (trait === "weapon") data.mastery?.value?.forEach(v => setValue(v, 2));
  return values;
}

/** dnd5e `TraitAdvancement#actorSelected`. */
async function actorSelected(adv, lists) {
  const selected = new Set();
  const available = new Set();
  const CONFIG = globalThis.CONFIG.DND5E;
  const mode = adv.configuration.mode;
  const traitTypes = mode === "default" ? Object.keys(CONFIG.traits).filter(k => k !== "dm")
    : Object.entries(CONFIG.traits).filter(([, t]) => t[mode === "mastery" ? "mastery" : "expertise"]).map(([k]) => k);
  for (const trait of traitTypes) {
    const values = await actorValues(adv.actor, trait, lists);
    const traitChoices = await listFor(lists, trait);
    for (const key of traitChoices.asSet()) {
      const value = values[key] ?? 0;
      if (mode === "default") {
        if (value >= 1) selected.add(key);
        else available.add(key);
      } else if (mode === "mastery") {
        const split = key.split(":");
        split.pop();
        const category = split.join(":");
        if (value === 2) selected.add(key);
        if ((value === 1) || (values[category] === 1)) available.add(key);
      } else {
        if (value === 2) selected.add(key);
        if ((mode === "expertise") && (value === 1)) available.add(key);
        else if ((mode !== "expertise") && (value < 2)) available.add(key);
      }
    }
  }
  return { selected, available };
}

/** dnd5e `mixedChoices`, one filter per trait type instead of one full list per key. */
async function mixedChoices(keys, lists) {
  const { SelectChoices, Trait } = dnd5e().documents;
  if (!keys.size) return new SelectChoices();
  const byTrait = new Map();
  for (const key of keys) {
    const trait = key.split(":")[0];
    if (!byTrait.has(trait)) byTrait.set(trait, new Set());
    byTrait.get(trait).add(key);
  }
  const types = {};
  for (const [trait, set] of byTrait) {
    const list = await listFor(lists, trait);
    types[trait] ??= { label: Trait.traitLabel(trait), children: new SelectChoices() };
    // One filter for all keys keeps what one filter per key would, unless a key is a category of another key in the set
    // ("tool:art" with "tool:art:alchemist": alone, the category drops its children; merged, the other key's filter
    // brings one back). Then filter per key and merge in order, as dnd5e does.
    const keys = [...set];
    const nested = keys.some(k => keys.some(o => o !== k && o.startsWith(`${k}:`)));
    if (nested) for (const key of keys) types[trait].children.merge(list.filter(new Set([key]), { inplace: false }));
    else types[trait].children.merge(list.filter(set, { inplace: false }));
  }
  if (Object.keys(types).length > 1) return new SelectChoices(types);
  return Object.values(types)[0].children;
}

/** dnd5e `TraitAdvancement#unfulfilledChoices(chosen)`. */
export async function unfulfilledChoices(adv, lists = createTraitLists(), chosen) {
  const { SelectChoices } = dnd5e().documents;
  const actorData = await actorSelected(adv, lists);
  const selected = { actor: actorData.selected, item: chosen ?? adv.value.chosen ?? new Set() };
  if (adv.maxTraits <= selected.item.size) return { available: [], choices: new SelectChoices() };
  const available = await Promise.all([
    ...adv.configuration.grants.map(async g => ({ type: "grant", choices: await mixedChoices(new Set([g]), lists) })),
    ...adv.configuration.choices.reduce((arr, choice, index) => arr.concat(Array.fromRange(choice.count).map(async () => ({
      type: "choice", choiceIdx: index, choices: await mixedChoices(choice.pool, lists)
    }))), [])
  ]);
  available.sort((lhs, rhs) => lhs.choices.asSet().size - rhs.choices.asSet().size);
  for (const key of selected.item) available.findSplice(grant => grant.choices.asSet().has(key));
  const allChoices = await mixedChoices(actorData.available, lists);
  allChoices.exclude(new Set([...(selected.actor ?? []), ...selected.item]));
  available.forEach(a => a.choices = allChoices.filter(a.choices, { inplace: false }));
  return { available, choices: allChoices };
}
