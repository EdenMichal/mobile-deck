/**
 * Pure 2024 (SRD 5.2) character-creation rules for the Abilities tab and the background
 * increase: point buy (27 points, 8–15), the standard array and the book's suggested array by class, rolled or
 * entered sets (3–18), slot placement, and the background increase check (3 points, the step's cap, unlocked abilities).
 * No Foundry access: unit-tested in tests/creation-rules.test.mjs.
 */
export const ABILITIES = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);
export const METHODS = Object.freeze(["standardArray", "pointBuy", "roll", "manual"]);
export const POINT_BUY = Object.freeze({ budget: 27, min: 8, max: 15,
  costs: Object.freeze({ 8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9 }) });
export const STANDARD_ARRAY = Object.freeze([15, 14, 13, 12, 10, 8]);
export const ENTERED_RANGE = Object.freeze({ min: 3, max: 18 });
export const SCORE_MAX = 20;

/** The book's "Standard Array by Class" table (SRD 5.2, Character Creation, step 3). */
export const SUGGESTED_ARRAY = Object.freeze({
  barbarian: { str: 15, dex: 13, con: 14, int: 10, wis: 12, cha: 8 },
  bard: { str: 8, dex: 14, con: 12, int: 13, wis: 10, cha: 15 },
  cleric: { str: 14, dex: 8, con: 13, int: 10, wis: 15, cha: 12 },
  druid: { str: 8, dex: 12, con: 14, int: 13, wis: 15, cha: 10 },
  fighter: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 },
  monk: { str: 12, dex: 15, con: 13, int: 10, wis: 14, cha: 8 },
  paladin: { str: 15, dex: 10, con: 13, int: 8, wis: 12, cha: 14 },
  ranger: { str: 12, dex: 15, con: 13, int: 8, wis: 14, cha: 10 },
  rogue: { str: 12, dex: 15, con: 13, int: 14, wis: 10, cha: 8 },
  sorcerer: { str: 10, dex: 13, con: 14, int: 8, wis: 12, cha: 15 },
  warlock: { str: 8, dex: 14, con: 13, int: 12, wis: 10, cha: 15 },
  wizard: { str: 8, dex: 12, con: 13, int: 15, wis: 14, cha: 10 }
});

const num = v => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** Point buy limits for the current scores (missing scores count as 8). */
export function pointBuyState(scores = {}) {
  const abilities = {};
  let spent = 0;
  for (const k of ABILITIES) {
    const value = Math.min(POINT_BUY.max, Math.max(POINT_BUY.min, num(scores[k]) ?? POINT_BUY.min));
    const cost = POINT_BUY.costs[value];
    spent += cost;
    abilities[k] = { value, cost };
  }
  const left = POINT_BUY.budget - spent;
  for (const k of ABILITIES) {
    const a = abilities[k];
    a.nextCost = a.value < POINT_BUY.max ? POINT_BUY.costs[a.value + 1] - a.cost : null;
    a.canRaise = a.nextCost !== null && a.nextCost <= left;
    a.canLower = a.value > POINT_BUY.min;
  }
  return { spent, left, valid: left >= 0, abilities };
}

/** Numbers to place, each with a stable id, so duplicates stay distinct. */
export function slotsFor(values = [], prefix = "s") {
  return values.map((value, i) => ({ id: `${prefix}${i}`, value: Number(value) }));
}

/** Slot tokens: put `slotId` on `ability`; the slot leaves any other ability, and the ability's old slot is freed. */
export function placeSlot(assignments = {}, slotId, ability) {
  const next = {};
  for (const [k, id] of Object.entries(assignments)) if (id !== slotId && k !== ability) next[k] = id;
  next[ability] = slotId;
  return next;
}

export function clearAbility(assignments = {}, ability) {
  const next = { ...assignments };
  delete next[ability];
  return next;
}

/** { str: value | null, … } from slots and assignments. */
export function scoresFromSlots(slots = [], assignments = {}) {
  const byId = new Map(slots.map(s => [s.id, s.value]));
  return Object.fromEntries(ABILITIES.map(k => [k, byId.has(assignments[k]) ? byId.get(assignments[k]) : null]));
}

/** The book's layout for a class: highest number on its highest suggested ability, and so on. */
export function suggestedAssignments(identifier, slots = []) {
  const suggested = SUGGESTED_ARRAY[identifier];
  if (!suggested || slots.length !== ABILITIES.length) return null;
  const order = [...ABILITIES].sort((a, b) => suggested[b] - suggested[a] || ABILITIES.indexOf(a) - ABILITIES.indexOf(b));
  const bySize = [...slots].sort((a, b) => b.value - a.value);
  return Object.fromEntries(order.map((k, i) => [k, bySize[i].id]));
}

/**
 * The 2024 background increase: exactly `points` (3) spread over unlocked abilities, at most
 * `cap` (2) each, which allows +2/+1 or +1/+1/+1. dnd5e's apply() doesn't check this.
 * Returns reasons; empty means valid.
 */
export function validateBackgroundAsi(config = {}, assignments = {}) {
  const points = Number(config.points) || 0;
  const cap = Number(config.cap) || 2;
  const locked = new Set(config.locked ?? []);
  const reasons = [];
  let sum = 0;
  for (const [k, raw] of Object.entries(assignments)) {
    const v = Number(raw) || 0;
    if (!v) continue;
    if (locked.has(k)) reasons.push({ key: "locked", ability: k });
    if (!Number.isInteger(v) || v < 0 || v > cap) reasons.push({ key: "cap", ability: k, cap });
    sum += v;
  }
  if (sum !== points) reasons.push({ key: "points", points, used: sum });
  return reasons;
}

export function finalScores(base = {}, bonus = {}, max = SCORE_MAX) {
  return Object.fromEntries(ABILITIES.map(k => {
    const b = num(base[k]);
    return [k, b === null ? null : Math.min(max, b + (Number(bonus[k]) || 0))];
  }));
}

/** "Enter my dice": six whole numbers from 3 to 18. Returns reasons; empty means valid. */
export function validateEntered(values = []) {
  const reasons = [];
  if (values.length !== ABILITIES.length) reasons.push({ key: "count", count: values.length });
  values.forEach((raw, index) => {
    const v = Number(raw);
    if (raw === "" || raw === null || !Number.isInteger(v) || v < ENTERED_RANGE.min || v > ENTERED_RANGE.max) reasons.push({ key: "range", index, value: raw });
  });
  return reasons;
}

/** Methods the GM allows (house rules); Standard Array if none are on. */
export function methodsAllowed(rules = {}) {
  const on = rules.abilityMethods ?? { standardArray: true };
  const list = METHODS.filter(m => on[m]);
  return list.length ? list : ["standardArray"];
}

export function rerollsLeft(rules = {}, rolls = {}) {
  return Math.max(0, (Number(rules.abilityRerolls) || 0) - (Number(rolls.rerollsUsed) || 0));
}

/** The six numbers to place for the chosen method; null for point buy, [] when not rolled or entered yet. */
export function slotValues(answer = {}, rolls = {}) {
  if (answer.method === "pointBuy") return null;
  if (answer.method === "roll") return rolls.sets?.length ? slotsFor(rolls.sets.at(-1), "r") : [];
  if (answer.method === "manual") {
    return answer.entered?.length === ABILITIES.length && !validateEntered(answer.entered).length ? slotsFor(answer.entered, "m") : [];
  }
  return slotsFor(STANDARD_ARRAY, "a");
}

/** Base scores (before the background increase) from the Abilities answer. */
export function baseScores(answer = {}, rolls = {}) {
  if (answer.method === "pointBuy") {
    return Object.fromEntries(Object.entries(pointBuyState(answer.pointBuy).abilities).map(([k, a]) => [k, a.value]));
  }
  return scoresFromSlots(slotValues(answer, rolls) ?? [], answer.assignments ?? {});
}

export const abilitiesComplete = base => ABILITIES.every(k => num(base?.[k]) !== null);

/**
 * Where the Abilities answer stands. Point Buy always has six values, so it also reports points
 * left unspent (a warning) and an over-budget buy (only possible in edited saved data; blocks saving).
 */
export function abilityStatus(answer = {}, rolls = {}) {
  const complete = abilitiesComplete(baseScores(answer, rolls));
  if (answer?.method !== "pointBuy") return { complete, unspent: 0, overBudget: false };
  const pb = pointBuyState(answer.pointBuy);
  return { complete: complete && pb.valid, unspent: Math.max(0, pb.left), overBudget: !pb.valid };
}
