/**
 * Compendium lookups for the builder, through cached pack indexes, filtered by the GM's
 * allowed sources (source-filter.mjs, spec §5) and house rules.
 */
import { allowEntry, dedupe, defaultSources, entryRules, houseRules, isBanned, packEnabledFor, packInUse, replacementFor, resolvePacks } from "./source-filter.mjs";
import { contentTier } from "./content-tier.mjs";

const INDEX_FIELDS = [
  "system.identifier", "system.classIdentifier", "system.type", "system.prerequisites",
  "system.primaryAbility", "system.hd", "system.source",
  // Spells (Phase 3): level, school, components / ritual / concentration, material text
  "system.level", "system.school", "system.properties", "system.materials",
  "system.rarity", "system.price",
  // DDB Importer's edition flags: its species have no source.rules (source-filter.mjs entryRules)
  "flags.ddbimporter.is2024", "flags.ddbimporter.is2014",
  // …and its species' base and lineage ("High Elf": base "Elf"), for grouping lineages (creation-tabs.mjs groupSpecies)
  "flags.ddbimporter.baseRaceName", "flags.ddbimporter.subRaceShortName"
];
export const SETTING_SOURCES = "builderSources";
export const SETTING_HOUSE_RULES = "builderHouseRules";

const indexes = new Map();
let moduleId = "mobile-deck";

/** Called once by the gateway with the running module id (mobile-deck or mobile-deck-dev). */
export function configureSources(id) { moduleId = id; }

function readSetting(key, fallback, game = globalThis.game) {
  try { return game.settings.get(moduleId, key) ?? fallback; } catch { return fallback; }
}
export const savedSources = game => readSetting(SETTING_SOURCES, defaultSources(), game);
export const currentHouseRules = game => houseRules(readSetting(SETTING_HOUSE_RULES, {}, game));

/** Every Item pack this user can read, merged with the GM's settings, highest priority first. */
export function packSettings(game = globalThis.game) {
  const packs = game.packs.filter(p => p.documentName === "Item" && p.visible !== false).map(p => ({
    collection: p.collection, label: p.metadata.label, packageType: p.metadata.packageType, packageName: p.metadata.packageName
  }));
  let dnd5eSources = {};
  try { dnd5eSources = game.settings.get("dnd5e", "packSourceConfiguration") ?? {}; } catch { dnd5eSources = {}; }
  return resolvePacks(packs, savedSources(game), dnd5eSources);
}

export async function packIndex(collection, game = globalThis.game) {
  if (!indexes.has(collection)) {
    const pack = game.packs.get(collection);
    if (!pack) return [];
    indexes.set(collection, pack.getIndex({ fields: INDEX_FIELDS }).then(index => Array.from(index), error => {
      indexes.delete(collection);
      throw error;
    }));
  }
  return indexes.get(collection);
}

/** Forget cached indexes (a pack or the source settings changed). */
export function clearContentCache() { indexes.clear(); }

/** The rules edition this world plays: "2024" (modern) or "2014" (legacy). */
export function worldRules(game = globalThis.game) {
  try { return game.settings.get("dnd5e", "rulesVersion") === "legacy" ? "2014" : "2024"; }
  catch { return "2024"; }
}

const uuidOf = (entry, pack) => entry.uuid ?? `Compendium.${pack.collection}.Item.${entry._id}`;

/** Allowed { entry, pack } pairs matching `filter`, before de-duplication. */
async function allowedCandidates(filter, game = globalThis.game) {
  const saved = savedSources(game);
  const rules = worldRules(game);
  const out = [];
  for (const pack of packSettings(game)) {
    // A pack switched off globally can still hold allowed entries for a type that switched it on.
    if (!packInUse(pack, saved)) continue;
    let entries;
    try { entries = await packIndex(pack.collection, game); }
    catch { continue; }
    for (const entry of entries) if (filter(entry) && allowEntry(entry, pack, saved, rules)) out.push({ entry, pack });
  }
  return out;
}

/** Allowed, de-duplicated index entries matching `filter`, as plain records sorted by name. */
export async function findEntries(filter, game = globalThis.game) {
  const showEdition = savedSources(game).rules === "both";
  return dedupe(await allowedCandidates(filter, game)).map(({ entry, pack }) => {
    const book = String(entry.system?.source?.book ?? "").trim() || packBook(pack.collection, game);
    return {
    uuid: uuidOf(entry, pack), name: entry.name, img: entry.img || "", type: entry.type, system: entry.system ?? {},
    pack: pack.collection,
    packLabel: showEdition && entryRules(entry, pack) ? `${pack.label} · ${entryRules(entry, pack)}` : pack.label,
    // The book (DDB: "PHB 2024", "FRHoF"…; dnd5e's packs name theirs in a flag: "SRD 5.2"): a picker subtitle that
    // tells same-named options apart.
    book,
    rules: entryRules(entry, pack),
    priority: pack.priority,
    flags: entry.flags ?? {},
    // The row's tag: "5.5e Core", "5e Expanded", "3rd party", "Homebrew"… (content-tier.mjs)
    tier: contentTier(entry, pack, { book })
  }; }).sort((a, b) => a.name.localeCompare(b.name, game.i18n?.lang));
}

/** The book a whole pack holds, as dnd5e flags its own ("SRD 5.2"), or "". */
const packBook = (collection, game = globalThis.game) => String(game?.packs?.get?.(collection)?.metadata?.flags?.dnd5e?.sourceBook ?? "").trim();

export async function findClasses(game) {
  const rules = currentHouseRules(game);
  return findEntries(e => e.type === "class" && !isBanned(e, rules), game);
}

export async function findSubclasses(classIdentifier, game) {
  const rules = currentHouseRules(game);
  return findEntries(e => e.type === "subclass" && e.system?.classIdentifier === classIdentifier && !isBanned(e, rules), game);
}

/** Feats by dnd5e feat type and subtype (e.g. "feat"/"general", "feat"/"fightingStyle"). */
export const findFeats = ({ type = "", subtype = "" } = {}, game) =>
  findEntries(e => e.type === "feat" && (!type || e.system?.type?.value === type)
    && (!subtype || e.system?.type?.subtype === subtype), game);

/** Phase 4: backgrounds and species from allowed sources. */
export const findBackgrounds = game => findEntries(e => e.type === "background", game);
export const findSpecies = game => findEntries(e => e.type === "race", game);

/**
 * dnd5e registers its spell lists shortly after "ready"; `registry.ready` is a boolean
 * getter, so poll it (about 1s in test-5e-world). A timeout is remembered for the page, so a
 * broken registry costs one wait, not one per screen.
 */
let spellListsTimedOut = false;
export async function spellListsReady(timeoutMs = 10000, registry = globalThis.dnd5e?.registry?.spellLists) {
  if (!registry) return false;
  if (registry.ready) return true;
  if (spellListsTimedOut) return false;
  const start = Date.now();
  while (!registry.ready && Date.now() - start < timeoutMs) await new Promise(resolve => setTimeout(resolve, 100));
  if (!registry.ready) spellListsTimedOut = true;
  return Boolean(registry.ready);
}

/**
 * Allowed spells on a class's list, up to `maxLevel`, de-duplicated by pack priority.
 * Matches the registry's spell identifiers as well as its UUIDs, so a DDB or homebrew copy of a
 * listed spell counts. A class with no registered list gets every allowed spell and noList: true.
 */
export async function spellsForClass(identifier, { maxLevel = 9 } = {}, game = globalThis.game) {
  return spellsForList(`class:${identifier}`, { maxLevel }, game);
}

/**
 * Same, for any registered list ("class:wizard", "subclass:life", …) and a level range. With `strict`, a list that
 * isn't registered gives no spells (an advancement restricted to it offers nothing) rather than every spell.
 */
export async function spellsForList(key, { minLevel = 0, maxLevel = 9, strict = false } = {}, game = globalThis.game) {
  await spellListsReady();
  const spellList = globalThis.dnd5e?.registry?.spellLists?.forType?.(key) ?? null;
  if (!spellList && strict) return { spells: [], noList: true };
  const uuids = spellList ? new Set(spellList.uuids ?? []) : null;
  const identifiers = spellList ? new Set(spellList.identifiers ?? []) : null;
  const spells = await findEntries(e => {
    const level = Number(e.system?.level) || 0;
    return e.type === "spell" && level >= minLevel && level <= maxLevel
      && (!spellList || uuids.has(e.uuid) || identifiers.has(e.system?.identifier));
  }, game);
  return { spells, noList: !spellList };
}

/** Locate a compendium UUID's index entry and pack settings. */
async function lookup(uuid, game = globalThis.game) {
  const parsed = globalThis.foundry?.utils?.parseUuid?.(uuid);
  const collection = parsed?.collection?.collection ?? parsed?.collection ?? "";
  const id = parsed?.id ?? parsed?.documentId;
  if (!collection || typeof collection !== "string") return null;
  const pack = packSettings(game).find(p => p.collection === collection);
  if (!pack) return null;
  const entry = (await packIndex(collection, game).catch(() => [])).find(e => e._id === id);
  return entry ? { entry, pack } : null;
}

/** The tag for a compendium UUID's item (picker rows built from a fixed pool), or null when it isn't in a pack. */
export async function tierForUuid(uuid, game = globalThis.game) {
  const found = await lookup(uuid, game);
  if (!found) return null;
  const book = String(found.entry.system?.source?.book ?? "").trim() || packBook(found.pack.collection, game);
  return contentTier(found.entry, found.pack, { book });
}

/** Is this compendium UUID allowed by the GM's sources? Unknown UUIDs (world items) are allowed. */
export async function isAllowedUuid(uuid, game = globalThis.game) {
  const found = await lookup(uuid, game);
  if (!found) return true;
  return allowEntry(found.entry, found.pack, savedSources(game), worldRules(game));
}

/**
 * The UUID to grant for `uuid`: itself, or (when its pack is switched off) the same
 * item from the highest-priority allowed pack. Spec §5 "enforceAllowedSources".
 */
export async function preferredUuid(uuid, game = globalThis.game) {
  const found = await lookup(uuid, game);
  const saved = savedSources(game);
  if (!found || packEnabledFor(found.entry, found.pack, saved)) return uuid;
  const candidates = await allowedCandidates(e => e.type === found.entry.type && e.name === found.entry.name, game);
  const replacement = replacementFor(found, candidates, saved);
  return replacement ? uuidOf(replacement.entry, replacement.pack) : uuid;
}

/**
 * Cheap prerequisite check from index data, mirroring dnd5e 5.3.2's
 * FeatData#validatePrerequisites (level, repeatable, required items).
 * Returns a list of reasons; empty means allowed.
 */
export function featBlockers(entry, actor, level) {
  const reasons = [];
  const pre = entry.system?.prerequisites ?? {};
  if (Number.isFinite(pre.level) && pre.level > level) reasons.push({ key: "level", level: pre.level });
  if (!pre.repeatable && actor.sourcedItems?.get?.(entry.uuid)?.size) reasons.push({ key: "repeat" });
  const items = Array.from(pre.items ?? []);
  if (items.length && !items.some(id => actor.identifiedItems?.get?.(id)?.size)) reasons.push({ key: "items", items });
  return reasons;
}

/** Short plain-text description for cards. */
export function plainSummary(html, max = 220) {
  const text = String(html ?? "").replace(/<[^>]+>/g, " ").replace(/@\w+\[[^\]]*\](\{([^}]*)\})?/g, (m, g, label) => label ?? "")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
