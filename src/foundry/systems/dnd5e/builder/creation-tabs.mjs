/**
 * Pure: the creation draft (one per user), picking items and what that clears, tab states,
 * species grouping and the Review groups only creation has. Spec §2, §3.4, §3.5.
 * Unit-tested in tests/creation-tabs.test.mjs.
 */
export const TABS = Object.freeze(["class", "background", "species", "abilities", "equipment", "spells", "details", "review"]);
export const SEGMENT_TABS = Object.freeze(["background", "species", "class"]); // apply order (rules order)

const copy = value => (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

/** 2: rolls moved out of the draft into their own user-flag key (see emptyRolls). */
export const CREATION_VERSION = 2;

/** A creation draft this version reads (draft-store creation(), the GM's list of submissions). */
export function isCreationDraft(draft) {
  return Boolean(draft) && typeof draft === "object" && draft.version === CREATION_VERSION && Boolean(draft.tabs) && typeof draft.tabs === "object";
}

export function emptyDraft({ owner = null } = {}) {
  return {
    version: CREATION_VERSION, owner, startLevel: 1, status: "draft",
    tabs: { class: null, background: null, species: null, abilities: null, equipment: {}, details: { name: "", alignment: "", biography: "" } }
  };
}

/**
 * Creation rolls: ability sets, dice-formula starting gold (by the class or background uuid) and the
 * trinket. They live apart from the draft, so Start over or switching class A → B → A never rolls
 * again; they are cleared only by a successful Create.
 */
export function emptyRolls() {
  return { abilities: { sets: [], rerollsUsed: 0, messageIds: [] }, gold: {}, trinket: null };
}

/** Saved rolls (parsed JSON) in the shape above; anything malformed is dropped. */
export function normalizeRolls(raw) {
  const out = emptyRolls();
  if (!raw || typeof raw !== "object") return out;
  const a = raw.abilities ?? {};
  out.abilities.sets = (Array.isArray(a.sets) ? a.sets : []).filter(set => Array.isArray(set) && set.length === 6 && set.every(Number.isFinite));
  out.abilities.rerollsUsed = Math.max(0, Number(a.rerollsUsed) || 0);
  out.abilities.messageIds = (Array.isArray(a.messageIds) ? a.messageIds : []).map(String);
  for (const [uuid, g] of Object.entries(raw.gold ?? {})) {
    if (Number.isFinite(Number(g?.value)) && g?.value !== null && g?.value !== "") out.gold[uuid] = { value: Number(g.value), messageId: String(g.messageId ?? "") };
  }
  if (raw.trinket?.text) out.trinket = { text: String(raw.trinket.text), messageId: String(raw.trinket.messageId ?? "") };
  return out;
}

/**
 * Pick a class, background or species. A different pick clears the tab's answers and what depends
 * on it: a class takes its equipment (its spells are class answers); a background takes its
 * equipment. Gold rolls stay (they are kept by item, apart from the draft). Returns { draft, cleared }.
 */
export function setPick(draft, tab, uuid) {
  const next = copy(draft);
  const cleared = [];
  if (next.tabs[tab]?.uuid === uuid) return { draft: next, cleared };
  if (next.tabs[tab]?.answers?.length) cleared.push(tab);
  next.tabs[tab] = { uuid, answers: [] };
  if (tab === "class" || tab === "background") {
    if (next.tabs.equipment?.[tab]) { delete next.tabs.equipment[tab]; cleared.push(`equipment.${tab}`); }
  }
  return { draft: next, cleared };
}

/**
 * "todo" | "attention" | "done" | "hidden" per tab.
 * @param {object} info { missing: [{ tab, kind }], hasSpells, abilitiesDone, abilitiesUnspent, equipmentDone }
 *   abilitiesUnspent: point-buy points left; the tab needs attention, but like open spell picks it doesn't block saving.
 */
export function tabStates(draft, { missing = [], hasSpells = false, abilitiesDone = false, abilitiesUnspent = false, equipmentDone = false } = {}) {
  const flagged = new Set(missing.map(m => m.tab));
  const states = {};
  for (const tab of ["class", "background", "species"]) {
    states[tab] = !draft.tabs[tab]?.uuid ? "todo" : flagged.has(tab) ? "attention" : "done";
  }
  states.abilities = abilitiesDone ? (abilitiesUnspent ? "attention" : "done") : draft.tabs.abilities ? "attention" : "todo";
  const equipmentStarted = Object.keys(draft.tabs.equipment ?? {}).some(k => k !== "trinket");
  states.equipment = equipmentDone ? "done" : equipmentStarted ? "attention" : "todo";
  states.spells = !hasSpells ? "hidden" : flagged.has("spells") ? "attention" : "done";
  states.details = String(draft.tabs.details?.name ?? "").trim() ? "done" : "todo";
  const others = TABS.filter(t => t !== "review" && states[t] !== "hidden");
  states.review = others.every(t => states[t] === "done") ? "done" : others.some(t => states[t] !== "todo") ? "attention" : "todo";
  return states;
}

/**
 * A species' base and lineage. DDB Importer says so in its flags (baseRaceName "Elf" for "High Elf", "Elf (Drow)",
 * "Wood Elf"; subRaceShortName for older items); otherwise dnd5e's "Elf, High" naming. The lineage of a DDB item without
 * a short name is its name without the base and brackets ("Elf (Drow)" → "Drow", "Forest Gnome" → "Forest"); a bracket
 * that only names the book ("Goliath (EE)") is not a lineage. { base, variant: "" } when there is none.
 */
export function speciesParts(entry = {}) {
  const name = String(entry.name ?? "").trim();
  const ddb = entry.flags?.ddbimporter ?? {};
  const base = String(ddb.baseRaceName || ddb.baseName || "").trim();
  if (base && base.toLowerCase() !== name.toLowerCase()) {
    const book = String(entry.book || entry.system?.source?.book || "").trim().toLowerCase();
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const fromName = name.replace(new RegExp(`\\b${escaped}\\b`, "i"), " ").replace(/\(([^)]*)\)/g, (m, inner) => {
      const tag = inner.trim().toLowerCase();
      return tag === book || ["phb", "ee", "motm", "dmg"].includes(tag) ? " " : ` ${inner} `;
    }).replace(/\s+/g, " ").trim();
    const variant = String(ddb.subRaceShortName ?? "").trim() || fromName;
    return { base, variant };
  }
  const [head, ...rest] = name.split(/,\s*/);
  return rest.length ? { base: head, variant: rest.join(", ") } : { base: name, variant: "" };
}

/** Same lineage, allowing one letter of spelling (DDB's "Cthonic" for dnd5e's "Chthonic"). */
function sameLineage(a, b) {
  const x = a.toLowerCase().replace(/[^a-z]/g, "");
  const y = b.toLowerCase().replace(/[^a-z]/g, "");
  if (!x || !y) return false;
  if (x === y) return true;
  if (Math.min(x.length, y.length) < 5 || Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}

/**
 * One card per species with its lineages: "Elf, High" (dnd5e), "High Elf" and "Elf (Drow)" (DDB) all go under "Elf".
 * The same lineage of the same edition from several sources is one choice, from the higher-priority pack (as findEntries
 * does for same-named items: the GM's world packs, such as their books, outrank dnd5e's); equal priority keeps both.
 * Entries: findEntries records ({ uuid, name, img, packLabel, rules, priority, flags, book }).
 */
export function groupSpecies(entries = []) {
  const groups = new Map();
  for (const entry of entries) {
    const { base, variant } = speciesParts(entry);
    // DDB's other versions of a species ("Goliath (EE)", "Human (PHB)") sit under it too, by their full names.
    const grouped = Boolean(variant) || base.toLowerCase() !== String(entry.name).toLowerCase();
    const key = (grouped ? base : entry.name).toLowerCase();
    const group = groups.get(key) ?? { name: grouped ? base : entry.name, img: entry.img, source: entry.packLabel ?? "", variants: [] };
    const option = { uuid: entry.uuid, name: variant || entry.name, fullName: entry.name, img: entry.img, source: entry.packLabel ?? "", tier: entry.tier ?? null,
      rules: entry.rules ?? "", priority: Number(entry.priority) || 0, lineage: variant };
    const twin = variant ? group.variants.find(v => v.lineage && v.rules === option.rules && sameLineage(v.lineage, variant)) : null;
    if (twin && twin.priority > option.priority) { /* keep the higher-priority copy */ }
    else if (twin && twin.priority < option.priority) group.variants.splice(group.variants.indexOf(twin), 1, option);
    else group.variants.push(option);
    groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.variants.sort((a, b) => a.name.localeCompare(b.name) || a.fullName.localeCompare(b.fullName));
    // A one-option card shows that option's subtitle and picture; a card's tag is its lineages' when they all share one.
    if (group.variants.length === 1) { group.source = group.variants[0].source; group.img = group.variants[0].img; }
    const labels = new Set(group.variants.map(v => v.tier?.label ?? ""));
    group.tier = labels.size === 1 ? group.variants[0].tier ?? null : null;
    for (const v of group.variants) { delete v.rules; delete v.priority; delete v.lineage; }
  }
  return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Trait keys chosen in a segment's answers ("tool:music:lute", "skills:ath", …). */
export function traitsOf(segment) {
  return (segment?.answers ?? []).flatMap(a => a?.data?.chosen ?? []);
}

/** Review group: method, the rolled or entered numbers (also in chat), and base + bonus = final per ability. */
export function abilityGroup({ method, labels, base, bonus = {}, final, sets = [], entered = null }, t) {
  const lines = [{ key: "abilities:method", text: t("Creation.Review.Method", "Method: {method}", { method }), kind: "change", step: "abilities" }];
  sets.forEach((set, i) => lines.push({ key: `abilities:set:${i}`, kind: "note", step: "abilities",
    text: t("Creation.Review.Rolled", "Rolled set {n}: {values} (in chat)", { n: i + 1, values: set.join(", ") }) }));
  if (entered?.length) lines.push({ key: "abilities:entered", kind: "note", step: "abilities",
    text: t("Creation.Review.Entered", "Entered from dice: {values} (in chat)", { values: entered.join(", ") }) });
  for (const k of Object.keys(labels)) {
    if (base[k] === null || base[k] === undefined) continue;
    const plus = Number(bonus[k]) || 0;
    lines.push({ key: `ability:${k}`, kind: plus ? "gain" : "change", step: "abilities",
      text: plus ? `${labels[k]} ${base[k]} + ${plus} = ${final[k]}` : `${labels[k]} ${base[k]}` });
  }
  return { id: "abilities", title: t("Creation.Review.Abilities", "Ability scores"), lines };
}
