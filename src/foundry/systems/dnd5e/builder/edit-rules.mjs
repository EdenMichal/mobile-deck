/**
 * Pure rules for changing a character after the fact (D&D Beyond-style edits; spec 2026-11-16).
 * An edit is a level-up session with one of these targets:
 *   { kind: "modify", itemId, level }   redo one level's choices of an item (dnd5e forModifyChoices)
 *   { kind: "replace", itemId, uuid }   swap the species, background or a class for another
 *   { kind: "remove", itemId }          drop a class that isn't the starting class
 *   { kind: "scores" }                  change the base ability scores
 */
import { isBanned } from "./source-filter.mjs";
import { abilityStatus } from "./creation-rules.mjs";

export const ABILITY_KEYS = Object.freeze(["str", "dex", "con", "int", "wis", "cha"]);
export const EDIT_KINDS = Object.freeze(new Set(["modify", "replace", "remove", "scores"]));
export const isEditTarget = target => EDIT_KINDS.has(target?.kind);
/** Item types the Change choices screen offers to replace. */
export const REPLACEABLE_TYPES = Object.freeze(new Set(["race", "background", "class"]));

/** A class can be removed when it isn't the starting class and the character keeps another. */
export function canRemoveClass(item, items = [], originalClass = "") {
  return item?.type === "class" && item.id !== originalClass && items.filter(i => i.type === "class").length > 1;
}

/**
 * An edit target the player wrote, checked on the GM's client against the actor's items ({ id, type, identifier }).
 * `doc`: the replacement document (replace only). Returns null when fine, else a reason key:
 * "kind" | "item" | "level" | "remove" | "notSame" | "banned" | "owned".
 */
export function checkEditTarget(target, { items = [], originalClass = "", doc = null, rules = {} } = {}) {
  if (!isEditTarget(target)) return "kind";
  if (target.kind === "scores") return null;
  const item = items.find(i => i.id === target.itemId);
  if (!item) return "item";
  if (target.kind === "modify") {
    const level = Number(target.level);
    return Number.isInteger(level) && level >= 0 ? null : "level";
  }
  if (target.kind === "remove") return canRemoveClass(item, items, originalClass) ? null : "remove";
  if (!REPLACEABLE_TYPES.has(item.type)) return "kind";
  if (!doc || doc.type !== item.type) return "notSame";
  if (item.type === "class") {
    if (isBanned(doc, { bannedClasses: [], bannedSubclasses: [], ...rules })) return "banned";
    const identifier = String(doc.system?.identifier ?? "");
    if (items.some(i => i.type === "class" && i.id !== item.id && i.identifier === identifier)) return "owned";
  }
  return null;
}

const plain = value => (value && typeof value.toObject === "function" ? value.toObject() : value ?? {});
const list = value => (value instanceof Set ? [...value] : Array.isArray(value) ? [...value] : []);

/**
 * The current picks of one advancement as replayable answers (the shapes applyAnswer takes), one per level:
 * [{ level, data, meta }]. `levels`: the advancement's levels (adv.levels). Used to preselect what the player chose before
 * and to re-apply choices dnd5e asks again (a subclass re-added, species choices reversed with a class).
 */
export function seedsFor(type, rawValue, levels = []) {
  const value = plain(rawValue);
  const at = Number(levels[0] ?? 0) || 0;
  switch (type) {
    case "HitPoints":
      return Object.entries(value).filter(([level, v]) => /^\d+$/.test(level) && v !== null && v !== undefined).map(([level, v]) => {
        const roll = Number(v);
        const method = v === "avg" ? "avg" : v === "max" ? "max" : "roll";
        return { level: Number(level), data: { value: method === "roll" ? roll : v }, meta: { hp: { method, roll: method === "roll" ? roll : null, seeded: true } } };
      });
    case "Size":
      return value.size ? [{ level: at, data: { size: value.size }, meta: null }] : [];
    case "Subclass":
      return value.uuid ? [{ level: at, data: { uuid: value.uuid }, meta: { kind: "subclass" } }] : [];
    case "AbilityScoreImprovement": {
      if (value.type === "feat") {
        const uuid = Object.values(value.feat ?? {})[0];
        return uuid ? [{ level: at, data: { type: "feat", uuid }, meta: { kind: "feat" } }] : [];
      }
      if (value.type !== "asi") return [];
      const assignments = Object.fromEntries(Object.entries(value.assignments ?? {}).filter(([, n]) => Number(n)).map(([k, n]) => [k, Number(n)]));
      return [{ level: at, data: { type: "asi", assignments }, meta: null }];
    }
    case "ItemChoice":
      return Object.entries(value.added ?? {}).filter(([, byId]) => byId && Object.keys(byId).length).map(([level, byId]) => ({
        // A level that swapped an earlier pick (dnd5e's replacement) carries one pick more: the swap goes with it, or
        // replaying it would cut the list to the level's count and drop a pick.
        level: Number(level), data: { selected: Object.values(byId), ...(value.replaced?.[level]?.original ? { replace: value.replaced[level].original } : {}),
          ...(value.ability ? { ability: value.ability } : {}) }, meta: null }));
    case "ItemGrant": {
      const selected = Object.values(value.added ?? {});
      return selected.length ? [{ level: at, data: { selected, ...(value.ability ? { ability: value.ability } : {}) }, meta: null }] : [];
    }
    case "Trait": {
      const chosen = list(value.chosen);
      return chosen.length ? [{ level: at, data: { chosen }, meta: null }] : [];
    }
    default: return [];
  }
}

/**
 * Ability increases the character's advancements gave (class ASIs, a 2024 background's +2/+1, a feat's own +1, a 2014
 * species), summed: { str: 2, … }. `advancements`: [{ type, value }].
 */
export function abilityBonuses(advancements = []) {
  const out = {};
  for (const adv of advancements) {
    if (adv?.type !== "AbilityScoreImprovement") continue;
    const value = plain(adv.value);
    if (value.type && value.type !== "asi") continue;
    for (const [k, n] of Object.entries(value.assignments ?? {})) out[k] = (out[k] ?? 0) + (Number(n) || 0);
  }
  return out;
}

/** Base scores: the actor's scores less the increases. */
export function baseFrom(scores = {}, bonus = {}) {
  return Object.fromEntries(ABILITY_KEYS.map(k => [k, (Number(scores[k]) || 0) - (Number(bonus[k]) || 0)]));
}

/** The base scores as an "entered numbers" answer of the creation Abilities screen (each number on its own ability). */
export function enteredAnswer(base = {}) {
  return { method: "manual", entered: ABILITY_KEYS.map(k => Number(base[k]) || 0),
    assignments: Object.fromEntries(ABILITY_KEYS.map((k, i) => [k, `m${i}`])), pointBuy: {} };
}

/**
 * How an Ability scores answer was made, against the methods the House Rules allow (`allowed`: methodsAllowed()).
 * Rolling isn't offered again, so "roll" lets the player enter the numbers instead.
 * @returns {"overBudget"|"method"|"entered"|null} overBudget: a Point Buy over 27 points (refused); method: a method the
 *   House Rules don't allow (the GM is warned); entered: typed in where the House Rules allow rolling, not entering (the
 *   GM is told).
 */
export function scoresAnswerProblem(answer, allowed = []) {
  const method = answer?.method;
  if (method === "pointBuy" && abilityStatus(answer).overBudget) return "overBudget";
  const offered = new Set(allowed.map(m => (m === "roll" ? "manual" : m)));
  if (!offered.has(method)) return "method";
  if (method === "manual" && !allowed.includes("manual")) return "entered";
  return null;
}

/**
 * The new scores (base + the same increases) and what's wrong with them: a base missing, or a total above the ability's
 * maximum (`max`: { str: 20, … }). Problems: [{ key, reason: "missing" | "max", total?, max? }].
 */
export function newScores(base = {}, bonus = {}, max = {}) {
  const scores = {};
  const problems = [];
  for (const k of ABILITY_KEYS) {
    const b = base[k];
    if (b === null || b === undefined || !Number.isFinite(Number(b))) { problems.push({ key: k, reason: "missing" }); continue; }
    const total = Number(b) + (Number(bonus[k]) || 0);
    const cap = Number(max[k]) || 20;
    if (total > cap) problems.push({ key: k, reason: "max", total, max: cap });
    scores[k] = total;
  }
  return { scores, problems };
}

/**
 * Does an advancement (plain facts) give the player a choice at `level`? Mirrors the driver's needsInput without the
 * actor: HitPoints after the starting class's first level, a subclass, ASI points or a feat, an ItemChoice with picks or a
 * replacement, a Trait with choices, several sizes, an optional grant or a spellcasting ability to choose.
 * @param {{ type: string, levels?: number[], points?: number, allowFeat?: boolean, sizes?: number, choices?: object,
 *   traitChoices?: number, optional?: boolean, spellAbilities?: number }} adv
 */
export function hasChoiceAt(adv, level, { isOriginalClass = false } = {}) {
  const lvl = Number(level);
  switch (adv?.type) {
    case "HitPoints": return lvl >= 1 && !(lvl === 1 && isOriginalClass);
    case "Subclass": return true;
    case "AbilityScoreImprovement": return (Number(adv.points) || 0) > 0 || Boolean(adv.allowFeat);
    case "ItemChoice": return (Number(adv.choices?.[lvl]?.count) || 0) > 0 || Boolean(adv.choices?.[lvl]?.replacement);
    case "Trait": return (Number(adv.traitChoices) || 0) > 0;
    case "Size": return (Number(adv.sizes) || 0) > 1;
    case "ItemGrant": return Boolean(adv.optional) || (Number(adv.spellAbilities) || 0) > 1;
    default: return false;
  }
}

const sourceOf = i => i?._stats?.compendiumSource ?? i?.flags?.dnd5e?.sourceId ?? i?.source ?? "";
const idOf = i => i?._id ?? i?.id;

/**
 * Items dnd5e deleted and re-created with a fresh id while replaying (a level's grants given again, a subclass's
 * features after a restore), paired with the actor's item they stand for: same compendium source, type and name, one to
 * one. Map(newId → oldId). Committing them as updates keeps the item ids (hotbar macros, links) and Review quiet.
 */
export function pairRecreatedItems(created = [], deleted = []) {
  const map = new Map();
  const used = new Set();
  for (const c of created) {
    const source = sourceOf(c);
    if (!source) continue;
    const old = deleted.find(d => !used.has(idOf(d)) && sourceOf(d) === source && d.type === c.type && d.name === c.name);
    if (!old) continue;
    map.set(idOf(c), idOf(old));
    used.add(idOf(old));
  }
  return map;
}

/** `value` (plain data) with every id in `map` swapped for its pair (advancement values and origins name item ids). */
export function swapIds(value, map) {
  if (!map?.size) return value;
  const pattern = new RegExp([...map.keys()].map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
  return JSON.parse(JSON.stringify(value).replace(pattern, id => map.get(id)));
}
