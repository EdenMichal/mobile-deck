/**
 * Change choices after the fact (D&D Beyond-style edits; spec 2026-11-16), dnd5e side.
 * An edit is a level-up session (advancement-driver) with an edit target (edit-rules.mjs); this module gives the
 * controller what differs: the session options per target, the "Change choices" overview, replacement candidates,
 * the Ability scores step and the Review notes.
 */
import { displayTitle, SUPPORTED_TYPES } from "./advancement-driver.mjs";
import { builderSpellSteps } from "./feature-spells.mjs";
import { currentHouseRules, findBackgrounds, findClasses, findSpecies, preferredUuid } from "./content-sources.mjs";
import { abilityStatus, baseScores, methodsAllowed } from "./creation-rules.mjs";
import { prepareOriginData } from "./creation-session.mjs";
import { abilityBonuses, ABILITY_KEYS, baseFrom, canRemoveClass, enteredAnswer, hasChoiceAt, isEditTarget, newScores, REPLACEABLE_TYPES } from "./edit-rules.mjs";

export { isEditTarget };

const AM = () => globalThis.dnd5e.applications.advancement.AdvancementManager;
const localize = key => (key ? globalThis.game.i18n.localize(key) : "");
const abilityLabel = k => String(globalThis.CONFIG.DND5E.abilities[k]?.abbreviation ?? k).toUpperCase();

/** Every advancement on the actor as { type, value } (for the ability increases). */
const allAdvancements = actor => actor.items.contents.flatMap(item => Object.values(item.advancement?.byId ?? {})
  .map(adv => ({ type: adv.constructor.typeName, value: adv.value })));

/** The base scores and the increases on top of them: { base, bonus, max }. */
export function scoreParts(actor) {
  const bonus = abilityBonuses(allAdvancements(actor));
  const source = actor._source.system?.abilities ?? {};
  const scores = Object.fromEntries(ABILITY_KEYS.map(k => [k, Number(source[k]?.value ?? actor.system.abilities[k]?.value) || 0]));
  const max = Object.fromEntries(ABILITY_KEYS.map(k => [k, Math.max(Number(actor.system.abilities[k]?.max) || 20, scores[k])]));
  return { base: baseFrom(scores, bonus), bonus, max };
}

const METHOD_LABELS = Object.freeze({
  standardArray: ["Abilities.StandardArray", "Standard Array"], pointBuy: ["Abilities.PointBuy", "Point Buy"],
  manual: ["Edit.EnterScores", "Enter the numbers"]
});

/**
 * The Ability scores step (target { kind: "scores" }): the creation Abilities screen on the base scores, the increases
 * shown on top. Rolling isn't offered again (the old rolls aren't kept): "Enter the numbers" stands in for it.
 */
function scoresSteps(t) {
  return async (manager, actor) => {
    const { base, bonus, max } = scoreParts(actor);
    const rules = currentHouseRules();
    const allowed = methodsAllowed(rules);
    const methods = [...new Set(allowed.map(m => (m === "roll" ? "manual" : m)))];
    if (globalThis.game.user.isGM && !methods.includes("manual")) methods.push("manual");
    const start = methods.includes("manual") ? enteredAnswer(base) : { method: methods[0], assignments: {}, pointBuy: {}, entered: [] };
    return [{
      key: "edit:scores", type: "AbilityScores", title: t("Edit.Scores", "Ability scores"), item: actor.name, level: 0,
      model: async data => ({
        answer: data ?? start, methods: methods.map(m => ({ key: m, label: t(METHOD_LABELS[m][0], METHOD_LABELS[m][1]) })),
        labels: Object.fromEntries(ABILITY_KEYS.map(k => [k, abilityLabel(k)])), bonus, base, current: Object.fromEntries(ABILITY_KEYS.map(k => [k, base[k] + (bonus[k] ?? 0)])),
        rolls: { rolled: true, rerollsLeft: 0, sets: 0 }, rolled: [], suggested: false, classIdentifier: ""
      }),
      apply: async data => {
        if (abilityStatus(data ?? {}).overBudget) throw new Error(t("Edit.PointBuyOver", "Point Buy spends more than 27 points. Lower some scores."));
        const { scores, problems } = newScores(baseScores(data ?? {}, {}), bonus, max);
        if (problems.length) {
          throw new Error(problems.map(p => (p.reason === "missing"
            ? t("Edit.ScoreMissing", "{ability} has no number yet", { ability: abilityLabel(p.key) })
            : t("Edit.ScoreMax", "{ability} would be {total} with your increases (the most is {max})", { ability: abilityLabel(p.key), total: p.total, max: p.max }))).join("; "));
        }
        manager.clone.updateSource(Object.fromEntries(ABILITY_KEYS.map(k => [`system.abilities.${k}.value`, scores[k]])));
      }
    }];
  };
}

/** Session options for a target: level-ups keep the spell steps; edits leave spells alone (spec: Manage spells). */
export function sessionOptions(target, actor, t) {
  const base = { remapUuid: preferredUuid };
  if (!isEditTarget(target)) return { ...base, extraSteps: builderSpellSteps };
  if (target.kind === "scores") return { ...base, extraSteps: scoresSteps(t) };
  const options = { ...base, skipTypes: { has: type => !SUPPORTED_TYPES.has(type) } };
  const item = actor.items.get(target.itemId);
  if (target.kind === "replace" && (item?.type === "race" || item?.type === "background")) options.prepareItem = prepareOriginData;
  // As in creation: a species' own ability increases are never applied (2024 rules put them on the background), unless
  // this character has them already (an older build): then a change of its choices keeps them.
  const speciesAsi = item?.type === "race" && target.kind === "modify"
    && Object.values(item.advancement?.byId ?? {}).some(a => a.constructor.typeName === "AbilityScoreImprovement" && a.value?.type);
  if (item?.type === "race" && !speciesAsi) options.skipTypes = { has: type => !SUPPORTED_TYPES.has(type) || type === "AbilityScoreImprovement" };
  return options;
}

/** What the Change choices list says about an advancement's current pick at a level ("Athletics, Perception"). */
function pickSummary(actor, item, adv, level) {
  const value = adv.value ?? {};
  const names = ids => ids.map(id => actor.items.get(id)?.name).filter(Boolean).join(", ");
  try {
    switch (adv.constructor.typeName) {
      case "HitPoints": {
        const v = value[level];
        return v === "avg" ? localize("DND5E.ADVANCEMENT.HitPoints.Average") || "Average" : v === "max" ? "Max" : Number.isFinite(Number(v)) ? String(v) : "";
      }
      case "Subclass": return item.subclass?.name ?? "";
      case "AbilityScoreImprovement":
        if (value.type === "feat") return names(Object.keys(value.feat ?? {}));
        return Object.entries(value.assignments ?? {}).filter(([, n]) => Number(n)).map(([k, n]) => `${abilityLabel(k)} +${n}`).join(", ");
      case "ItemChoice": return names(Object.keys(value.added?.[level] ?? {}));
      case "ItemGrant": return names(Object.keys(value.added ?? {}));
      case "Trait": {
        const grants = new Set(adv.configuration?.grants ?? []);
        const Trait = globalThis.dnd5e?.documents?.Trait;
        return [...(value.chosen ?? [])].filter(k => !grants.has(k)).map(k => Trait?.keyLabel?.(k) ?? k).join(", ");
      }
      case "Size": return localize(globalThis.CONFIG.DND5E.actorSizes[value.size]?.label) || value.size || "";
      default: return "";
    }
  } catch { return ""; }
}

/** Plain facts of an advancement for hasChoiceAt. */
function facts(adv) {
  const c = adv.configuration ?? {};
  return { type: adv.constructor.typeName, points: c.points, allowFeat: adv.allowFeat, sizes: c.sizes?.size ?? 0,
    choices: c.choices && !Array.isArray(c.choices) ? c.choices : {},
    traitChoices: Array.isArray(c.choices) ? c.choices.reduce((n, ch) => n + (Number(ch.count) || 0), 0) : 0,
    optional: Boolean(c.optional || c.items?.some?.(i => i.optional)), spellAbilities: c.spell?.ability?.size ?? 0 };
}

/** One row per level of `item` that has a choice: { itemId, level, titles, summary }. */
function choiceRows(actor, item) {
  if (!item.advancement?.byLevel) return [];
  const current = AM().currentLevel(item, actor);
  const isOriginalClass = item.type === "class" && actor.system.details.originalClass === item.id;
  const rows = [];
  for (const [lvl, advs] of Object.entries(item.advancement.byLevel)) {
    const level = Number(lvl);
    if (!(level <= current)) continue;
    const chosen = (advs ?? []).filter(a => a.appliesToClass !== false && SUPPORTED_TYPES.has(a.constructor.typeName) && hasChoiceAt(facts(a), level, { isOriginalClass }));
    if (!chosen.length) continue;
    rows.push({ itemId: item.id, level, titles: chosen.map(a => displayTitle(a) || a.constructor.typeName),
      summary: chosen.map(a => pickSummary(actor, item, a, level)).filter(Boolean).join(" · ") });
  }
  return rows.sort((a, b) => a.level - b.level);
}

/**
 * The Change choices overview: groups for the species, background, each class (its subclass's levels included) and any
 * other item with choices (feats), each with its rows and whether it can be replaced or removed.
 */
export function editOverview(actor) {
  const items = actor.items.contents;
  const plain = items.map(i => ({ id: i.id, type: i.type, identifier: i.identifier ?? i.system?.identifier ?? "" }));
  const originalClass = actor.system.details.originalClass ?? "";
  const group = (item, rows, extra = {}) => ({ itemId: item.id, type: item.type, name: item.name, img: item.img,
    canReplace: REPLACEABLE_TYPES.has(item.type), canRemove: canRemoveClass(plain.find(p => p.id === item.id), plain, originalClass), rows, ...extra });
  const groups = [];
  for (const type of ["race", "background"]) for (const item of items.filter(i => i.type === type)) groups.push(group(item, choiceRows(actor, item)));
  const classes = items.filter(i => i.type === "class").sort((a, b) => (a.id === originalClass ? -1 : b.id === originalClass ? 1 : 0));
  for (const cls of classes) {
    const sub = cls.subclass;
    const rows = [...choiceRows(actor, cls), ...(sub ? choiceRows(actor, sub).map(r => ({ ...r, subclass: sub.name })) : [])].sort((a, b) => a.level - b.level);
    groups.push(group(cls, rows, { levels: Number(cls.system.levels) || 0, subclass: sub?.name ?? "", original: cls.id === originalClass }));
  }
  for (const item of items.filter(i => !["race", "background", "class", "subclass"].includes(i.type))) {
    const rows = choiceRows(actor, item);
    if (rows.length) groups.push(group(item, rows));
  }
  return { groups };
}

/** Candidates to replace `itemId` with (allowed sources), as level-up's class list: { uuid, name, img, source, tier }. */
export async function replaceOptions(actor, itemId) {
  const old = actor.items.get(itemId);
  if (!old) return [];
  const entries = old.type === "race" ? await findSpecies() : old.type === "background" ? await findBackgrounds() : old.type === "class" ? await findClasses() : [];
  const owned = new Set(Object.values(actor.classes ?? {}).filter(c => c.id !== old.id).map(c => c.identifier));
  const oldSource = old._stats?.compendiumSource ?? old.flags?.dnd5e?.sourceId ?? "";
  return entries.filter(e => e.uuid !== oldSource && !(old.type === "class" && owned.has(e.system?.identifier)))
    .map(e => ({ uuid: e.uuid, name: e.name, img: e.img, source: e.packLabel, tier: e.tier ?? null, blockers: [] }));
}

/** The draft's label for an edit: "Fighter: level 3", "Elf → Dwarf", "Remove Wizard", "Ability scores". */
export async function editLabel(actor, target, t) {
  const item = target.itemId ? actor.items.get(target.itemId) : null;
  if (target.kind === "scores") return t("Edit.Scores", "Ability scores");
  if (target.kind === "remove") return t("Edit.RemoveLabel", "Remove {name}", { name: item?.name ?? "" });
  if (target.kind === "replace") {
    const doc = await globalThis.fromUuid(target.uuid).catch(() => null);
    return t("Edit.ReplaceLabel", "{from} → {to}", { from: item?.name ?? "", to: doc?.name ?? "" });
  }
  const level = Number(target.level) || 0;
  return level ? t("Edit.ModifyLabel", "{name}: level {level}", { name: item?.name ?? "", level }) : t("Edit.ModifyOrigin", "{name}: choices", { name: item?.name ?? "" });
}

/** Review notes for an edit: what it leaves alone (spells, equipment). */
export function editNotes(actor, target, t) {
  if (!isEditTarget(target) || target.kind === "scores") return [];
  const item = actor.items.get(target.itemId);
  const notes = [];
  const classy = item?.type === "class" || item?.type === "subclass";
  if (target.kind !== "modify" || classy) {
    notes.push({ key: "edit:spells", text: t("Edit.SpellsNote", "Spells aren't changed here. Check them afterwards with Manage spells on the Spells tab.") });
  }
  if (target.kind !== "modify" && (item?.type === "class" || item?.type === "background")) {
    notes.push({ key: "edit:equipment", text: t("Edit.EquipmentNote", "Starting equipment from {name} stays in your inventory.", { name: item.name }) });
  }
  return notes;
}
