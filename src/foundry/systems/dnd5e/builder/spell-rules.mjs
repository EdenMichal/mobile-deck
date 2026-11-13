/**
 * Pure 2024 spell rules for the level-up spell step (Phase 3 spec §3.1). No Foundry access,
 * so everything here is unit-tested. Foundry data is read in spell-step.mjs and passed in.
 */

/**
 * 2024 core classes (checked against the SRD 5.2 Spellcasting texts in dnd5e's classes24 pack):
 * who keeps a spellbook, who may swap a leveled spell when gaining a level, and who swaps cantrips
 * only on a Long Rest (Wizard). Paladin and Ranger swap spells on a Long Rest (Phase 5 rest helper).
 */
export const CLASS_SPELL_RULES = Object.freeze({
  bard: { swapSpell: true },
  sorcerer: { swapSpell: true },
  warlock: { swapSpell: true },
  wizard: { spellbook: { first: 6, perLevel: 2 }, cantripSwapOnRest: true },
  cleric: {}, druid: {}, paladin: {}, ranger: {}
});

/** Subclass casters that pick from another class's list (2024 PHB). */
export const SUBCLASS_SPELL_LISTS = Object.freeze({ "eldritch-knight": "wizard", "arcane-trickster": "wizard" });

/** Subclass casters' own rules: both swap one spell whenever they gain a Fighter / Rogue level (2024 PHB). */
export const SUBCLASS_SPELL_RULES = Object.freeze({ "eldritch-knight": { swapSpell: true }, "arcane-trickster": { swapSpell: true } });

/** Rules for a class (and subclass) identifier; homebrew gets none (no spell swap, no spellbook). */
export const rulesFor = (identifier, subclass = "") => ({ ...(CLASS_SPELL_RULES[identifier] ?? {}), ...(SUBCLASS_SPELL_RULES[subclass] ?? {}) });

/**
 * SRD 5.2 / PHB 2024 class tables: cantrips known and prepared spells by class level (index 0 = level 1). Used only when a
 * class's own data has no count (DDB imports of the Eldritch Knight and Arcane Trickster have neither a "cantrips-known"
 * scale nor a prepared formula). Checked against dnd5e 5.3.2's classes24 scale values for the eight core casters.
 */
const steps = (from, values) => Array.from({ length: 20 }, (_, i) => {
  let v = 0;
  for (const [lvl, n] of Object.entries(values)) if (i + 1 >= Number(lvl)) v = n;
  return from && i + 1 < from ? 0 : v;
});
const FULL_PREPARED = [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22];
const HALF_PREPARED = [2, 3, 4, 5, 6, 6, 7, 7, 9, 9, 10, 10, 11, 11, 12, 12, 14, 14, 15, 15];
const THIRD_PREPARED = [0, 0, 3, 4, 4, 4, 5, 6, 6, 7, 8, 8, 9, 10, 10, 11, 11, 11, 12, 13];
export const SPELL_TABLES = Object.freeze({
  bard: { cantrips: steps(0, { 1: 2, 4: 3, 10: 4 }), prepared: FULL_PREPARED },
  cleric: { cantrips: steps(0, { 1: 3, 4: 4, 10: 5 }), prepared: FULL_PREPARED },
  druid: { cantrips: steps(0, { 1: 2, 4: 3, 10: 4 }), prepared: FULL_PREPARED },
  sorcerer: { cantrips: steps(0, { 1: 4, 4: 5, 10: 6 }), prepared: [2, 4, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 17, 18, 18, 19, 20, 21, 22] },
  warlock: { cantrips: steps(0, { 1: 2, 4: 3, 10: 4 }), prepared: [2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14, 15, 15] },
  wizard: { cantrips: steps(0, { 1: 3, 4: 4, 10: 5 }), prepared: [4, 5, 6, 7, 9, 10, 11, 12, 14, 15, 16, 16, 17, 18, 19, 21, 22, 23, 24, 25] },
  paladin: { cantrips: steps(0, {}), prepared: HALF_PREPARED },
  ranger: { cantrips: steps(0, {}), prepared: HALF_PREPARED },
  // Subclass casters, by Fighter / Rogue level. The Arcane Trickster's three cantrips include Mage Hand.
  "eldritch-knight": { cantrips: steps(3, { 3: 2, 10: 3 }), prepared: THIRD_PREPARED },
  "arcane-trickster": { cantrips: steps(3, { 3: 3, 10: 4 }), prepared: THIRD_PREPARED }
});

/** The 2024 table counts for a class level, the subclass's table first; null for a class the tables don't know. */
export function tableCounts(identifier, subclass = "", levels = 0) {
  const table = SPELL_TABLES[subclass] ?? SPELL_TABLES[identifier];
  if (!table) return null;
  const level = Math.min(20, Math.max(0, Number(levels) || 0));
  if (!level) return { cantrips: 0, prepared: 0 };
  return { cantrips: table.cantrips[level - 1], prepared: table.prepared[level - 1] };
}

/** Cantrips a subclass caster always knows, counted among its table's cantrips (2024 Arcane Trickster: Mage Hand). */
export const FIXED_CANTRIPS = Object.freeze({ "arcane-trickster": ["mage-hand"] });

/**
 * The spell lists a class's own picks come from: the subclass's list (Eldritch Knight, Arcane Trickster → Wizard), and
 * from Bard 10 (Magical Secrets) the Bard, Cleric, Druid and Wizard lists. Otherwise the class's own list.
 */
export function spellListKeys({ identifier = "", subclass = "", levels = 0, magicalSecrets = null } = {}) {
  if (SUBCLASS_SPELL_LISTS[subclass]) return [`class:${SUBCLASS_SPELL_LISTS[subclass]}`];
  const secrets = magicalSecrets ?? (identifier === "bard" && (Number(levels) || 0) >= 10);
  if (secrets) return ["class:bard", "class:cleric", "class:druid", "class:wizard"];
  return [`class:${identifier}`];
}

/** Flag scope of spells the builder's own feature steps add (feature-spells.mjs); the dev install renames it. */
export const GRANT_SCOPE = "mobile-deck";

/** Circle of the Land types, as dnd5e names their spell lists ("subclass:land-arid"). */
export const LAND_TYPES = Object.freeze(["arid", "polar", "temperate", "tropical"]);

/**
 * Circle of the Land spells for a Druid whose highest spell level is `maxLevel`: the land list's cantrip and every spell
 * up to that level (2024 table: Druid 3 → levels 1–2 and the cantrip, 5 → 3, 7 → 4, 9 → 5).
 * @param {Array<{ level: number }>} spells  The land list.
 */
export function landSpellsFor(spells = [], maxLevel = 0) {
  if (!(Number(maxLevel) >= 2)) return [];
  return spells.filter(s => (Number(s.level) || 0) <= maxLevel);
}

const CASTING_ABILITY = { bard: "cha", cleric: "wis", druid: "wis", sorcerer: "cha", warlock: "cha", wizard: "int" };

/**
 * How the builder handles a feat whose spells have no advancement (DDB imports), by the feat's identifier:
 * - picks: { list?, cantrips?, spells?, schools?, fixed?: [spell identifiers], ability?, abilities? }
 * - { warnOnly: true }: a Review warning that the spells must be added by hand.
 * null for any other feat.
 */
export function featSpellRule(identifier = "") {
  const id = String(identifier);
  const mi = id.match(/^magic-initiate-(bard|cleric|druid|sorcerer|warlock|wizard)$/);
  if (mi) return { list: mi[1], cantrips: 2, spells: 1, ability: CASTING_ABILITY[mi[1]] };
  if (id === "fey-touched") return { fixed: ["misty-step"], spells: 1, schools: ["div", "enc"], abilities: ["int", "wis", "cha"] };
  if (id === "shadow-touched") return { fixed: ["invisibility"], spells: 1, schools: ["ill", "nec"], abilities: ["int", "wis", "cha"] };
  if (/^(telekinetic|telepathic|ritual-caster(-[a-z]+)?|mythal-touched|artificer-initiate|magic-initiate|drow-high-magic|wood-elf-magic|fey-teleportation|svirfneblin-magic)$/.test(id)) {
    return { warnOnly: true };
  }
  return null;
}

/** 2024 classes whose prepared spells change on a Long Rest, never on a level-up (the spell screen says so). */
export const swapsOnRest = identifier => ["cleric", "druid", "paladin", "ranger", "wizard"].includes(identifier);

/**
 * Highest spell level a class can pick, as if single-classed. Mirrors dnd5e 5.3.2's
 * computeProgression: divide (rounding per progression), then single-classed partial
 * casters round up.
 * @param {{ type: string, progression: string, levels: number }} casting
 * @param {{ divisor?: number, roundUp?: boolean } | null} prog   CONFIG.DND5E.spellcasting[type].progression[progression]
 * @param {Array<number[]> | Record<string, { level: number }>} table  SPELL_SLOT_TABLE, or pactCastingProgression for pact
 */
export function maxSpellLevel(casting, prog, table) {
  const levels = Number(casting?.levels) || 0;
  if (!levels || !casting?.progression || casting.progression === "none") return 0;
  if (casting.type === "pact") {
    let level = 0;
    for (const [from, row] of Object.entries(table ?? {})) if (levels >= Number(from)) level = Math.max(level, Number(row?.level) || 0);
    return level;
  }
  const divisor = Number(prog?.divisor) || 1;
  let effective = (prog?.roundUp ? Math.ceil : Math.floor)(levels / divisor);
  if (divisor > 1 && effective) effective = Math.ceil(levels / divisor);
  if (!effective || !Array.isArray(table) || !table.length) return 0;
  return (table[Math.min(effective, table.length) - 1] ?? []).length;
}

/**
 * What this level-up owes the player for one class.
 * @param {object} input
 * @param {string} input.identifier     Class identifier ("wizard").
 * @param {string} [input.subclass]     Subclass identifier ("eldritch-knight"), for subclass casters' rules.
 * @param {number} input.levelsBefore   Class levels before (0 for a new class).
 * @param {number} input.levelsAfter    Class levels after.
 * @param {{ maxPrepared: number }} input.before  Prepared limit before the level.
 * @param {{ cantrips: number, maxPrepared: number, maxSpellLevel: number }} input.after
 * @param {{ cantrips: number, prepared: number, leveled: number }} input.current  The class's own spells on the copy.
 */
export function owedSpells({ identifier, subclass = "", levelsBefore = 0, levelsAfter = 0, before = {}, after = {}, current = {} }) {
  const rules = rulesFor(identifier, subclass);
  const cantripsKnown = Number(after.cantrips) || 0;
  const haveCantrips = Number(current.cantrips) || 0;
  const havePrepared = Number(current.prepared) || 0;
  const cantrips = Math.max(0, cantripsKnown - haveCantrips);
  const prepared = Math.max(0, (Number(after.maxPrepared) || 0) - havePrepared);
  const carriedOver = Math.min(prepared, Math.max(0, (Number(before.maxPrepared) || 0) - havePrepared));
  const gained = Math.max(0, levelsAfter - levelsBefore);
  const spellbookClass = Boolean(rules.spellbook);
  const spellbook = spellbookClass && (Number(after.maxSpellLevel) || 0) > 0 && gained
    ? (levelsBefore === 0 ? rules.spellbook.first + rules.spellbook.perLevel * (gained - 1) : rules.spellbook.perLevel * gained)
    : 0;
  const swapCantrip = !rules.cantripSwapOnRest && cantripsKnown > 0 && haveCantrips > 0;
  const swapSpell = Boolean(rules.swapSpell) && (Number(current.leveled) || 0) > 0;
  return {
    cantrips, prepared, carriedOver, spellbook, spellbookClass, swapCantrip, swapSpell,
    maxSpellLevel: Number(after.maxSpellLevel) || 0,
    hasStep: Boolean(cantrips || prepared || spellbook || swapCantrip || swapSpell)
  };
}

const list = value => (Array.isArray(value) ? value : []);

/**
 * Keep only picks that still fit: offered, right level, within the owed counts, no duplicates,
 * at most one cantrip swap and one spell swap, never swapping out an always-prepared spell.
 * @param {{ cantrips?: string[], spells?: string[], prepare?: string[], swaps?: Array<{ out: string, in: string }> }} answer
 * @param {ReturnType<typeof owedSpells>} owed
 * @param {{ options: Map<string, { level: number }>, known: Map<string, { level: number, prepared: number }> }} pools
 *   options: offered compendium spells by UUID. known: the class's spells on the copy by item id.
 */
export function sanitizeSpellAnswer(answer, owed, { options, known }) {
  const seen = new Set();
  const take = (values, ok, max) => {
    const out = [];
    for (const value of list(values)) {
      if (out.length >= max) break;
      if (typeof value !== "string" || seen.has(value) || !ok(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  };
  const cantrips = take(answer?.cantrips, uuid => options.get(uuid)?.level === 0, owed.cantrips);
  const spells = take(answer?.spells, uuid => {
    const level = options.get(uuid)?.level;
    return level > 0 && level <= owed.maxSpellLevel;
  }, owed.spellbookClass ? owed.spellbook : owed.prepared);
  const prepareSeen = new Set();
  const prepare = [];
  if (owed.spellbookClass) {
    for (const ref of list(answer?.prepare)) {
      if (prepare.length >= owed.prepared) break;
      if (typeof ref !== "string" || prepareSeen.has(ref)) continue;
      const entry = ref.startsWith("item:") ? known.get(ref.slice(5)) : null;
      const ok = ref.startsWith("item:") ? Boolean(entry && entry.level > 0 && entry.prepared === 0) : spells.includes(ref);
      if (!ok) continue;
      prepareSeen.add(ref);
      prepare.push(ref);
    }
  }
  const swaps = [];
  for (const swap of list(answer?.swaps)) {
    const out = known.get(swap?.out);
    const incoming = options.get(swap?.in);
    if (!out || !incoming || out.prepared === 2 || seen.has(swap.in)) continue;
    const cantrip = out.level === 0;
    if (swaps.some(s => (known.get(s.out).level === 0) === cantrip)) continue;
    const allowed = cantrip ? owed.swapCantrip && incoming.level === 0
      : owed.swapSpell && incoming.level > 0 && incoming.level <= owed.maxSpellLevel;
    if (!allowed) continue;
    seen.add(swap.in);
    swaps.push({ out: swap.out, in: swap.in });
  }
  return { cantrips, spells, prepare, swaps };
}

/** Picked / owed for each counter on the screen. Non-Wizards prepare their new spells directly. */
export function spellProgress(owed, answer = {}) {
  const n = value => list(value).length;
  return {
    cantrips: { done: n(answer.cantrips), owed: owed.cantrips || 0 },
    prepared: { done: owed.spellbookClass ? n(answer.prepare) : n(answer.spells), owed: owed.prepared || 0 },
    spellbook: { done: owed.spellbookClass ? n(answer.spells) : 0, owed: owed.spellbook || 0 }
  };
}

/** Unfilled counters, for the warning lines in Review changes. */
export function spellWarnings(owed, answer = {}) {
  const progress = spellProgress(owed, answer);
  return ["cantrips", "prepared", "spellbook"]
    .map(kind => ({ kind, missing: Math.max(0, progress[kind].owed - progress[kind].done) }))
    .filter(w => w.missing > 0);
}
