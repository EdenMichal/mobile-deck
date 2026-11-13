/**
 * Pure: the GM's allowed-sources rules (spec §5). No Foundry access, so it is unit-tested.
 *
 * Saved setting (world, `<module>.builderSources`):
 *   { rules: "world" | "2024" | "2014" | "both",
 *     packs: { [collection]: { enabled?: boolean, priority?: number, rules?: "" | "2014" | "2024", tier?: "" | "core" | "expanded" | "thirdParty" | "homebrew" } },
 *     books: { [bookKey]: false },           // books are allowed unless switched off
 *     types: { [typeKey]: { custom: true, packs: { [collection]: boolean }, books: { [bookKey]: boolean } } } }
 *
 * `types` holds the GM's own sources for one kind of content (SOURCE_TYPES). A customised type uses its own compendium
 * and book switches; a compendium or book it doesn't mention (added after the GM saved) follows the global switches.
 * Priority, edition and tier stay per compendium, for every type.
 */
export const DEFAULT_PRIORITY = Object.freeze({ world: 30, module: 20, system: 10 });
export const NO_BOOK = "__none__";

export function defaultSources() {
  return { rules: "world", packs: {}, books: {}, types: {} };
}

/** The kinds of content the GM can give their own sources, in the order the Sources window lists them. */
export const SOURCE_TYPES = Object.freeze([
  Object.freeze({ key: "classes", label: "Classes" }),
  Object.freeze({ key: "subclasses", label: "Subclasses" }),
  Object.freeze({ key: "species", label: "Species" }),
  Object.freeze({ key: "backgrounds", label: "Backgrounds" }),
  Object.freeze({ key: "feats", label: "Feats" }),
  Object.freeze({ key: "spells", label: "Spells" }),
  Object.freeze({ key: "equipment", label: "Equipment" })
]);

const PHYSICAL_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);

/**
 * Which SOURCE_TYPES key an index entry belongs to, or "" for content that only follows the global sources
 * (class and species features, invocations and other non-feat "feat" items, which come with their class or species).
 */
export function sourceType(entry) {
  switch (entry?.type) {
    case "class": return "classes";
    case "subclass": return "subclasses";
    case "race": return "species";
    case "background": return "backgrounds";
    case "spell": return "spells";
    case "feat": return entry.system?.type?.value === "feat" ? "feats" : "";
    default: return PHYSICAL_TYPES.has(entry?.type) ? "equipment" : "";
  }
}

/** The GM's own sources for this entry's type, or null when the type follows the global sources. */
function typeSources(entry, saved) {
  const own = saved?.types?.[sourceType(entry)];
  return own?.custom ? own : null;
}

/** Is this pack switched on for this entry's type? Its type's own switch, else the pack's global one. */
export function packEnabledFor(entry, pack, saved) {
  const own = typeSources(entry, saved)?.packs?.[pack?.collection];
  return typeof own === "boolean" ? own : Boolean(pack?.enabled);
}

/** Is this entry's book allowed for its type? Its type's own switch, else the global one. */
export function bookAllowedFor(entry, saved) {
  const key = bookKey(entry);
  const own = typeSources(entry, saved)?.books?.[key];
  return typeof own === "boolean" ? own : saved?.books?.[key] !== false;
}

/** Could any entry of this pack be allowed: on globally, or switched on by some customised type? */
export function packInUse(pack, saved) {
  if (pack?.enabled) return true;
  return Object.values(saved?.types ?? {}).some(t => t?.custom && t.packs?.[pack?.collection] === true);
}

/**
 * Merge Item packs with the saved setting. Packs the GM never touched follow dnd5e's
 * "Compendium Browser Sources" (`dnd5e.packSourceConfiguration`, where `false` = off).
 * @param {Array<{collection, label, packageType, packageName}>} packs
 * @returns {Array<{collection, label, packageType, packageName, enabled, priority, rules}>} highest priority first
 */
export function resolvePacks(packs, saved = defaultSources(), dnd5eSources = {}) {
  return packs.map(p => {
    const own = saved?.packs?.[p.collection] ?? {};
    return {
      ...p,
      enabled: own.enabled ?? (dnd5eSources?.[p.collection] !== false),
      priority: Number.isFinite(own.priority) ? own.priority : (DEFAULT_PRIORITY[p.packageType] ?? 0),
      rules: own.rules ?? "",
      // The GM's tier for the whole pack ("core", "expanded", "thirdParty", "homebrew"; content-tier.mjs), or "".
      tier: own.tier ?? ""
    };
  }).sort((a, b) => b.priority - a.priority || String(a.label).localeCompare(String(b.label)));
}

/** "2024" / "2014" / "both", resolving "world" against the world's dnd5e rules. */
export function effectiveRules(saved, worldRules = "2024") {
  const r = saved?.rules ?? "world";
  return r === "world" ? worldRules : r;
}

/**
 * Books that only hold 2024-rules content (from the DDB Importer exports: every item of these that states its rules says
 * 2024). Books that mix editions (PHB, TCoE, XGtE, FToD…) aren't listed: their items rely on their own flags.
 */
export const BOOKS_2024 = Object.freeze(["PHB 2024", "DMG 2024", "MM 2025", "XPHB", "XDMG", "XMM", "FRHoF", "FRAiF", "TCMP1", "GSB1", "UHLH"]);

/** DDB Importer's own edition flags (`flags.ddbimporter.is2024` / `is2014`), which it sets even where source.rules is empty. */
export function ddbRules(entry) {
  const ddb = entry?.flags?.ddbimporter;
  if (ddb?.is2024 === true) return "2024";
  if (ddb?.is2014 === true) return "2014";
  return "";
}

/** "2024" for a book that only holds 2024 content ("PHB 2024", "FRHoF", any title naming 2024); "" when the book doesn't say. */
export function rulesFromBook(book) {
  const name = String(book ?? "").trim();
  if (!name) return "";
  if (BOOKS_2024.includes(name) || /\b2024\b/.test(name)) return "2024";
  return "";
}

/**
 * An item's edition: its own source.rules; else the GM's tag on its pack (an explicit choice outranks any guess); else
 * DDB Importer's edition flags (its species leave source.rules empty); else a book that is 2024-only; else unknown (""),
 * which stays visible.
 */
export function entryRules(entry, pack) {
  return String(entry?.system?.source?.rules || pack?.rules || ddbRules(entry) || rulesFromBook(entry?.system?.source?.book) || "");
}

export function bookKey(entry) {
  return String(entry?.system?.source?.book ?? "").trim() || NO_BOOK;
}

/**
 * Is this index entry allowed? Unknown editions (homebrew without a tag) stay visible,
 * so nothing disappears just because it lacks metadata.
 */
export function allowEntry(entry, pack, saved, worldRules = "2024") {
  if (!packEnabledFor(entry, pack, saved)) return false;
  const rules = effectiveRules(saved, worldRules);
  const r = entryRules(entry, pack);
  if (rules !== "both" && r && r !== rules) return false;
  return bookAllowedFor(entry, saved);
}

/** Same item in several packs: same type, name and edition. */
export function duplicateKey(entry, pack) {
  return `${entry.type}|${String(entry.name).trim().toLowerCase()}|${entryRules(entry, pack)}`;
}

/**
 * Keep each duplicate only from its highest-priority pack. Different items that merely
 * share a name inside one pack (five "Extra Attack" features) all stay.
 * @param {Array<{ entry, pack }>} candidates  allowed entries
 */
export function dedupe(candidates) {
  const best = new Map();
  for (const c of candidates) {
    const key = duplicateKey(c.entry, c.pack);
    const prior = best.get(key);
    if (prior === undefined || c.pack.priority > prior) best.set(key, c.pack.priority);
  }
  return candidates.filter(c => c.pack.priority === best.get(duplicateKey(c.entry, c.pack)));
}

/**
 * For an item granted from a pack the GM switched off: the copy from the highest-priority
 * allowed pack, or null to keep the original (a class's own features always come with it).
 * @param {{ entry, pack }} original
 * @param {Array<{ entry, pack }>} allowed  allowed candidates (any packs)
 * @param {object} [saved]  the saved sources, so a type's own compendium switches count
 */
export function replacementFor(original, allowed, saved) {
  if (packEnabledFor(original.entry, original.pack, saved)) return null;
  const key = duplicateKey(original.entry, original.pack);
  const matches = allowed.filter(c => duplicateKey(c.entry, c.pack) === key)
    .sort((a, b) => b.pack.priority - a.pack.priority);
  if (!matches.length) return null;
  // Ambiguous if the top pack has several same-named items of this type.
  const top = matches.filter(m => m.pack.priority === matches[0].pack.priority && m.pack.collection === matches[0].pack.collection);
  return top.length === 1 ? top[0] : null;
}

/** Books found in the enabled packs, for the GM's book switches. */
export function collectBooks(candidates) {
  const books = new Map();
  for (const { entry } of candidates) {
    const key = bookKey(entry);
    books.set(key, (books.get(key) ?? 0) + 1);
  }
  return [...books.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => (a.key === NO_BOOK) - (b.key === NO_BOOK) || a.key.localeCompare(b.key));
}

/*
 * House rules (world, `<module>.builderHouseRules`). Ability-score rules arrived with Phase 4a; `anyLanguage`
 * (every language choice offers every language dnd5e knows, including module groups) with the creation data fixes;
 * `approval` (players' new characters / level-ups wait for the GM) with Phase 4b.
 */
export function defaultHouseRules() {
  return { multiclass: true, multiclassPrerequisites: true, bannedClasses: [], bannedSubclasses: [],
    abilityMethods: { standardArray: true, pointBuy: false, roll: false, manual: false }, abilityRerolls: 0, anyLanguage: true,
    approval: { creation: true, levelUp: true } };
}

export function houseRules(saved) {
  const defaults = defaultHouseRules();
  return { ...defaults, ...(saved ?? {}), abilityMethods: { ...defaults.abilityMethods, ...(saved?.abilityMethods ?? {}) },
    approval: { ...defaults.approval, ...(saved?.approval ?? {}) } };
}

export function isBanned(entry, rules) {
  const id = String(entry?.system?.identifier ?? "");
  if (entry?.type === "class") return rules.bannedClasses.includes(id);
  if (entry?.type === "subclass") return rules.bannedSubclasses.includes(id);
  return false;
}
