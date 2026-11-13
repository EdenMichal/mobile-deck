/**
 * Pure: fixes applied to a background or species' item data before the creation wizard adds it (DDB Importer content,
 * homebrew books). The compendium copies are never changed; only the copy the character receives.
 * - A 2024 background without an AbilityScoreImprovement advancement (DDB's PHB 2024, FRHoF, TCMP1 backgrounds) gets the
 *   same step dnd5e's SRD backgrounds have: 3 points, at most 2 in one ability (+2/+1 or +1/+1/+1, max 20), limited to
 *   the three abilities its "Ability Scores:" line names, or any ability when it names none.
 * - Trait keys DDB doubles ("languages:languages:standard:common", its 2024 species' Common) are repaired.
 * - A species with no stored senses (all of DDB's) gets the ones its text states ("You have Darkvision with a range of…").
 * Unit-tested in tests/origin-prep.test.mjs with DDB Importer-shaped documents (tests/fixtures/origin-samples.json).
 */
import { entryRules } from "./source-filter.mjs";

/** Stable id (16 letters, like dnd5e's) so the step's answer key survives every replay. */
export const BACKGROUND_ASI_ID = "veBgAbilityScore";
export const ABILITY_KEYS = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);
const ENGLISH = Object.freeze({ str: "Strength", dex: "Dexterity", con: "Constitution", int: "Intelligence", wis: "Wisdom", cha: "Charisma" });

const plain = html => String(html ?? "")
  .replace(/<\/(p|li|dt|dd|tr|h\d|div)>|<br\s*\/?>/gi, "\n").replace(/<\/t[dh]>/gi, " ").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/&\w+\[[^\]]*\]\{([^}]*)\}/g, "$1");

/**
 * The abilities a background's "Ability Scores: Strength, Intelligence, Charisma" line names, as keys in order, or null
 * when there is no such line. `labels`: extra names per key (the world's language), matched as well as English and
 * the abbreviations ("Str", "STR").
 */
export function backgroundAbilities(html, labels = {}) {
  // "Ability Scores:" exactly (plural, with its colon): not "Ability Score Improvement" or "Ability Score Increase".
  const line = plain(html).split("\n").map(l => l.trim()).find(l => /^ability scores\s*:/i.test(l));
  if (!line) return null;
  const text = line.replace(/^ability scores\s*:\s*/i, "");
  const found = [];
  for (const key of ABILITY_KEYS) {
    const names = [ENGLISH[key], key, ...(labels[key] ? [labels[key]] : [])].map(n => String(n).toLowerCase());
    const at = Math.min(...names.map(n => {
      const m = text.toLowerCase().match(new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
      return m ? m.index : Infinity;
    }));
    if (Number.isFinite(at)) found.push([at, key]);
  }
  return found.length ? found.sort((a, b) => a[0] - b[0]).map(([, key]) => key) : null;
}

const hasAsi = data => Object.values(data?.system?.advancement ?? {}).some(a => a?.type === "AbilityScoreImprovement");

/**
 * The AbilityScoreImprovement advancement to add to a background's item data, or null when it needs none: it already
 * has one, or it is an older (2014) background (2014 rules put the increases on the species). A background of unknown
 * edition gets one only if its text names its abilities.
 */
export function backgroundAsiAdvancement(data, { labels = {}, pack = null } = {}) {
  if (data?.type !== "background" || hasAsi(data)) return null;
  const rules = entryRules(data, pack);
  const abilities = backgroundAbilities(data.system?.description?.value, labels);
  if (rules === "2014" || (rules !== "2024" && !abilities)) return null;
  const names = (abilities ?? []).map(k => labels[k] || ENGLISH[k]);
  return {
    _id: BACKGROUND_ASI_ID, type: "AbilityScoreImprovement", level: 0, title: "Background Ability Score Improvement", flags: {},
    hint: abilities ? `Increase one of ${names.slice(0, -1).join(", ")}${names.length > 1 ? `, or ${names.at(-1)}` : names[0]} by 2 and another by 1, or all three by 1 (max 20).`
      : "This background doesn't name its three abilities: increase any one by 2 and another by 1, or any three by 1 (max 20).",
    configuration: { points: 3, cap: 2, fixed: Object.fromEntries(ABILITY_KEYS.map(k => [k, 0])),
      locked: abilities ? ABILITY_KEYS.filter(k => !abilities.includes(k)) : [] },
    value: {}
  };
}

export const SENSES = Object.freeze(["darkvision", "blindsight", "tremorsense", "truesight"]);

/** Words that make a sense temporary or conditional ("while in beast form", "for 1 minute", "if…"). */
const CONDITIONAL = /\b(while|when|whenever|until|if|unless)\b|\bfor (\d+|an?|one|ten) (minute|hour|round|turn)s?\b/i;
const SENSE = "darkvision|blindsight|tremorsense|truesight";
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Senses a species' text gives it for good: a sentence that starts "You have Darkvision with a range of 120 feet" and
 * names no condition ("while…", "for 1 minute", "if…"). A lineage table row whose whole label is in the item's name
 * ("Drow" for "Elf (Drow)", "Wood Elf" for "Wood Elf") counts with its "The range of your Darkvision increases to N
 * feet". DDB Importer's species store no senses at all.
 */
export function speciesSenses(html, name = "") {
  const out = {};
  const sentences = plain(html).split(/\n+/).flatMap(line => line.split(/(?<=\.)\s+/)).map(t => t.replace(/\s+/g, " ").trim()).filter(Boolean);
  for (const sentence of sentences) {
    // An optional trait label first ("Darkvision: You have Darkvision with a range of 60 feet.").
    const m = sentence.match(new RegExp(`^(?:[\\w' -]+:\\s*)?you have (${SENSE})\\b.*?\\brange of (\\d+) ?(?:feet|foot|ft)\\b`, "i"));
    if (!m || CONDITIONAL.test(sentence)) continue;
    out[m[1].toLowerCase()] ??= Number(m[2]);
  }
  for (const row of String(html ?? "").split(/<\/tr>/i)) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => plain(c[1]).replace(/\s+/g, " ").trim());
    if (cells.length < 2 || !cells[0]) continue;
    if (!new RegExp(`(^|[\\s(])${escapeRe(cells[0])}($|[\\s),])`, "i").test(String(name))) continue;
    for (const cell of cells.slice(1)) {
      for (const m of cell.matchAll(new RegExp(`the range of your (${SENSE}) increases to (\\d+) ?(?:feet|ft)\\b`, "gi"))) out[m[1].toLowerCase()] = Number(m[2]);
    }
  }
  return out;
}

/** Fill a species' empty senses from its text (speciesSenses); stored values win. Returns the senses it set. */
export function fillSpeciesSenses(data) {
  if (data?.type !== "race") return {};
  const found = speciesSenses(data.system?.description?.value, data.name);
  const set = {};
  for (const [sense, range] of Object.entries(found)) {
    const ranges = (data.system.senses ??= {}).ranges ??= {};
    if (Number(ranges[sense]) > 0) continue;
    ranges[sense] = range;
    set[sense] = range;
  }
  if (Object.keys(set).length) data.system.senses.units ||= "ft";
  return set;
}

/** "languages:languages:standard:common" → "languages:standard:common" (any trait type DDB doubled). */
export const repairTraitKey = key => String(key).replace(/^([a-z]+):\1:/i, "$1:");

/** Repair doubled keys in the item data's Trait advancements; returns how many keys changed. */
export function repairTraitKeys(data) {
  let changed = 0;
  for (const adv of Object.values(data?.system?.advancement ?? {})) {
    if (adv?.type !== "Trait" || !adv.configuration) continue;
    const fix = list => Array.from(list ?? []).map(k => { const r = repairTraitKey(k); if (r !== k) changed++; return r; });
    adv.configuration.grants = fix(adv.configuration.grants);
    for (const choice of adv.configuration.choices ?? []) choice.pool = fix(choice.pool);
  }
  return changed;
}

/**
 * Keys that skip a category ("tool:alchemist" for dnd5e's "tool:art:alchemist", in a homebrew class) match no choice,
 * so dnd5e never grants them. `keysFor(trait)` gives the trait's full keys (dnd5e's Trait.choices); a key that isn't one
 * of them but ends like exactly one of them is rewritten to it. Wildcards and unknown keys are left alone.
 * Returns how many keys changed (mutates `data`).
 */
export async function canonicalTraitKeys(data, keysFor) {
  let changed = 0;
  const fix = async key => {
    const k = String(key);
    if (k.endsWith("*") || !k.includes(":")) return k;
    const keys = await keysFor(k.split(":")[0]);
    if (!keys?.size || keys.has(k)) return k;
    const tail = `:${k.split(":").pop()}`;
    const matches = [...keys].filter(full => full.endsWith(tail));
    if (matches.length !== 1) return k;
    changed++;
    return matches[0];
  };
  for (const adv of Object.values(data?.system?.advancement ?? {})) {
    if (adv?.type !== "Trait" || !adv.configuration) continue;
    adv.configuration.grants = await Promise.all(Array.from(adv.configuration.grants ?? []).map(fix));
    for (const choice of adv.configuration.choices ?? []) choice.pool = await Promise.all(Array.from(choice.pool ?? []).map(fix));
  }
  return changed;
}

/** All of the above on the item data the wizard is about to add (mutates `data`; returns it). */
export function prepareOriginItem(data, options = {}) {
  repairTraitKeys(data);
  fillSpeciesSenses(data);
  const asi = backgroundAsiAdvancement(data, options);
  if (asi) {
    data.system ??= {};
    data.system.advancement = { ...(data.system.advancement ?? {}), [asi._id]: asi };
  }
  return data;
}

/** Will the wizard ask this background for its ability increases (its own step, or the one added above)? */
export const backgroundHasAsi = (data, options = {}) => hasAsi(data) || Boolean(backgroundAsiAdvancement(data, options));

/**
 * A background's own trinket table: the first roll-table link in its description whose label names trinkets
 * ("@UUID[Compendium.world.ddb-tables.RollTable.x]{… Night Stalker Trinkets}"), or "".
 */
export function trinketTableUuid(html) {
  for (const [, uuid, label] of String(html ?? "").matchAll(/@UUID\[([^\]]*RollTable[^\]]*)\]\{([^}]*)\}/g)) {
    if (/trinket/i.test(label)) return uuid;
  }
  return "";
}
