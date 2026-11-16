/**
 * Player feedback (fork): Weapon Mastery rules, pure (no Foundry).
 *
 * 2024 rules: Barbarian, Fighter, Paladin, Ranger and Rogue know the masteries of a few kinds of weapons they're
 * proficient with. The number grows on some levels (the class table), and after every Long Rest the character can
 * change one of them ("practice weapon drills"; the Fighter's text says one, like the others).
 */

/** The 2024 class tables: levels at which the count changes, and the count from that level. */
export const MASTERY_TABLE = Object.freeze({
  barbarian: [[1, 2], [4, 3], [10, 4]],
  fighter: [[1, 3], [4, 4], [10, 5], [16, 6]],
  paladin: [[1, 2]],
  ranger: [[1, 2]],
  rogue: [[1, 2]]
});

/** Masteries a class gives at `levels` by the 2024 table (0 for other classes). */
export function tableMasteries(identifier, levels) {
  const rows = MASTERY_TABLE[String(identifier ?? "")] ?? [];
  let count = 0;
  for (const [from, value] of rows) if ((Number(levels) || 0) >= from) count = value;
  return count;
}

/**
 * How many masteries a character may know. Each class counts what its own data gives (dnd5e's Weapon Mastery trait
 * steps), or, when its data has none (D&D Beyond imports), the 2024 table, if it is a 2024 class or the character
 * has a Weapon Mastery feature. Classes add up, as dnd5e's own steps would.
 * @param {Array<{ identifier: string, levels: number, dataCount: number|null, is2024: boolean }>} classes
 * @param {{ hasFeature?: boolean }} [options]
 */
export function masteryAllowance(classes = [], { hasFeature = false } = {}) {
  let total = 0;
  const sources = [];
  for (const cls of classes) {
    const fromData = cls.dataCount !== null && cls.dataCount !== undefined;
    const count = fromData ? Number(cls.dataCount) || 0 : (cls.is2024 || hasFeature ? tableMasteries(cls.identifier, cls.levels) : 0);
    if (!count) continue;
    total += count;
    sources.push({ identifier: cls.identifier, count, fromData });
  }
  return { total, sources };
}

/**
 * Check a new set of masteries against the old one.
 * - Picks may be added while fewer than `allowance` are known (a new character, or a level that gave more).
 * - One may be swapped after a Long Rest (`swap`): one old pick out, one new in.
 * - A GM may set anything.
 * Returns { ok, removed, added, usedSwap, reason }.
 */
export function checkMasteryChange({ before = [], after = [], allowance = 0, swap = false, proficient = new Set(), isGM = false }) {
  const was = new Set(before);
  const now = new Set(after);
  const removed = [...was].filter(k => !now.has(k));
  const added = [...now].filter(k => !was.has(k));
  const result = (ok, reason = "") => ({ ok, reason, removed, added, usedSwap: removed.length > 0 && !isGM });
  if (isGM) return result(true);
  if (added.some(k => !proficient.has(k))) return result(false, "notProficient");
  if (removed.length > (swap ? 1 : 0)) return result(false, swap ? "oneSwap" : "noSwap");
  if (now.size > Math.max(allowance, was.size)) return result(false, "tooMany");
  return result(true);
}

/** Is a weapon (`weapon` key, its category `category`: "sim" / "mar") covered by these weapon proficiencies? */
export function isProficient(proficiencies, weapon, category) {
  const set = proficiencies instanceof Set ? proficiencies : new Set(proficiencies ?? []);
  return set.has(weapon) || (Boolean(category) && set.has(category));
}
