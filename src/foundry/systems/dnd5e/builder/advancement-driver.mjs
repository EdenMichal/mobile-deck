/**
 * Headless level-up session over dnd5e's AdvancementManager (proven in the Phase 1a spike).
 *
 * The manager only builds the step list and holds the actor clone; it is never rendered.
 * Every change replays the saved answers from a fresh manager, so Back, resuming a
 * draft and "jump to this step" are all the same operation. Answers are matched to
 * steps by a stable key (source item + advancement id + level); the first answer that
 * no longer matches, and everything after it, is dropped.
 */

import { checkSpellChoice } from "./spell-choice.mjs";
import { createTraitLists, unfulfilledChoices } from "./trait-choices.mjs";
import { isLanguagePool } from "./trait-options.mjs";
import { currentHouseRules } from "./content-sources.mjs";
import { asiAnswerProblems } from "./asi-math.mjs";

/** Advancement types the mobile screens can draw. Others fall back to dnd5e's window. */
export const SUPPORTED_TYPES = new Set(["HitPoints", "AbilityScoreImprovement", "Subclass", "ItemChoice", "ItemGrant", "Trait", "Size", "ScaleValue"]);

const managerClass = () => globalThis.dnd5e.applications.advancement.AdvancementManager;

/** Stable identity of a step across replays (item ids of granted items change every replay). */
export function stepKey(flow) {
  const item = flow.item ?? flow.advancement.item;
  const source = item._stats?.compendiumSource ?? item.flags?.dnd5e?.sourceId ?? item.identifier ?? item.name;
  return `${source}|${flow.advancement.id}|${flow.level}`;
}

/**
 * Phase 4b: what the GM's client checks a step's answer against, kept on the path entry (plain data): a HitPoints step's
 * class and die (its HP lock key), and the items an ItemGrant / ItemChoice step offers.
 */
function stepFacts(adv) {
  const type = adv.constructor.typeName;
  const config = adv.configuration ?? {};
  if (type === "HitPoints") return { classIdentifier: adv.item.identifier, die: Number(adv.hitDieValue) || 8 };
  if (type === "ItemGrant") return { offered: { items: (config.items ?? []).map(i => i.uuid) } };
  if (type === "ItemChoice") {
    const r = config.restriction ?? {};
    return { offered: { pool: (config.pool ?? []).map(p => p.uuid), itemType: config.type ?? "", restriction: { type: r.type ?? "", subtype: r.subtype ?? "" } } };
  }
  return {};
}

/** Does this step need the player? (Decides which steps get a screen.) */
export async function needsInput(adv, level) {
  const type = adv.constructor.typeName;
  switch (type) {
    // Players choose roll or average every time (spec §10); only level 1 of the first class is automatic.
    case "HitPoints": return !(level === 1 && adv.item.isOriginalClass);
    case "Size": return (adv.configuration.sizes?.size ?? 0) > 1;
    case "Subclass": return true;
    // Monk 20's Body and Mind is a fixed +4/+4 (dnd5e's data makes it look like a feat choice): applied, not asked.
    case "AbilityScoreImprovement": if (isBodyAndMind(adv, level)) return false;
      return (Number(adv.configuration.points) || 0) > 0 || adv.allowFeat;
    // A level with only dnd5e's "replace an earlier pick" (Fighting Style 2–20, invocations, Mystic Arcanum 12–20) is
    // asked too, as an optional "Change …?" step, when there is an earlier pick to replace.
    case "ItemChoice": return (adv.configuration.choices?.[level]?.count ?? 0) > 0
      || (Boolean(adv.configuration.choices?.[level]?.replacement) && replaceableItems(adv, level).length > 0);
    // A choice of spellcasting ability (High Elf, Tiefling lineage spells…) is asked too, as dnd5e's own flow does.
    case "ItemGrant": return Boolean(adv.configuration.optional || adv.configuration.items?.some(i => i.optional)
      || (adv.configuration.spell?.ability?.size ?? 0) > 1);
    case "ScaleValue": return false;
    // "Language choices: any language" (GM house rule): a language choice is always asked, also where dnd5e would fill
    // in the pool's last language itself, so the wider offer is shown (creation and level-up).
    case "Trait": if (anyLanguageChoice(adv)) return true; return (await adv.automaticApplicationValue(level)) === false;
    default: return (await adv.automaticApplicationValue(level)) === false;
  }
}

/**
 * ItemChoice picks of earlier levels still on the actor (copy), which dnd5e's replacement may swap out at `level`:
 * [{ id, uuid, level }].
 */
export function replaceableItems(adv, level) {
  const out = [];
  for (const [lvl, byId] of Object.entries(adv.value?.added ?? {})) {
    if (Number(lvl) >= Number(level)) continue;
    for (const [id, uuid] of Object.entries(byId ?? {})) if (adv.actor?.items?.get?.(id)) out.push({ id, uuid, level: Number(lvl) });
  }
  return out;
}

/**
 * Fix 11: line the saved answers up with the step at `index` by its key. A saved answer for this step further on moves
 * here; a step with none gets a hole (null) so the answers after it stay for the steps they belong to. Answers are thus
 * never applied to another step, and a new step (a species' level-1 grant picked after the class) no longer drops the
 * answers after it.
 */
export function alignAnswers(answers, index, key) {
  const current = answers[index];
  if (current?.key === key) return;
  const j = answers.findIndex((a, i) => i > index && a?.key === key);
  if (j >= 0) {
    const [found] = answers.splice(j, 1);
    if (current) answers.splice(index, 0, found);
    else answers[index] = found;
    return;
  }
  if (current) answers.splice(index, 0, null);
}

/**
 * Performance: a Trait step's open choices (`unfulfilledChoices`) are asked by needsInput, by the automatic application
 * and by a creation answer check, all on the same state. While the step is handled they are computed once, by the port
 * in trait-choices.mjs that builds each trait type's list once per replay (`lists`) instead of once per key.
 * `restore()` puts dnd5e's own method back. Results are unchanged: nothing changes the actor between those calls.
 */
export function shareTraitChoices(adv, lists = createTraitLists()) {
  if (adv?.constructor?.typeName !== "Trait" || typeof adv.unfulfilledChoices !== "function") return () => {};
  let shared = null;
  adv.unfulfilledChoices = function (chosen) {
    if (chosen !== undefined) return unfulfilledChoices(this, lists, chosen);
    shared ??= unfulfilledChoices(this, lists);
    return shared;
  };
  return () => { delete adv.unfulfilledChoices; };
}

/** A Trait step with a language choice while the "any language" house rule is on. */
function anyLanguageChoice(adv) {
  if (!currentHouseRules().anyLanguage) return false;
  return (adv.configuration.choices ?? []).some(c => (Number(c.count) || 0) > 0 && isLanguagePool(c.pool));
}

/** Apply a step with no player input. `remapUuid` swaps grants from switched-off packs (spec §5). */
async function applyAutomatic(adv, level, remapUuid, session = null) {
  const type = adv.constructor.typeName;
  if (type === "AbilityScoreImprovement" && isBodyAndMind(adv, level)) return applyBodyAndMind(adv, level, session);
  if (type === "Size") return adv.apply(level, { size: adv.configuration.sizes?.first?.() ?? "med" });
  if (type === "ScaleValue") return undefined;
  const auto = await adv.automaticApplicationValue(level);
  if (type === "ItemGrant" && auto && remapUuid) auto.selected = await Promise.all((auto.selected ?? []).map(uuid => remapUuid(uuid)));
  // Fix 10: a grant whose item can't be found anywhere (dnd5e's own data points at items its SRD packs lack) is named
  // in Review instead of dropped silently.
  if (type === "ItemGrant" && auto && session) {
    for (const uuid of auto.selected ?? []) {
      if (!(await resolves(uuid))) session.unresolved.push({ title: adv.title, item: adv.item?.name ?? "", uuid, name: missingName(uuid) });
    }
  }
  if (auto !== false && auto !== undefined) return adv.apply(level, auto, { automatic: true });
  return adv.apply(level, {}, { initial: true });
}

/**
 * L20 fix 15: dnd5e 5.3.2's Monk has Body and Mind as a level-20 ASI with fixed DEX +4 / WIS +4, no points and no
 * maximum, so it is offered as a feat choice (Epic Boons) and capped at 20. The 2024 feature is "+4, to a maximum of 25".
 */
export function isBodyAndMind(adv, level) {
  const config = adv.configuration ?? {};
  return adv.item?.type === "class" && adv.item?.identifier === "monk" && Number(level) === 20 && !(Number(config.points) > 0)
    && Object.values(config.fixed ?? {}).some(v => Number(v) > 0) && (config.max === null || config.max === undefined);
}

async function applyBodyAndMind(adv, level, session) {
  const before = adv.configuration.max;
  // The maximum only for this apply: dnd5e caps at max(ability.max, configuration.max). Put back after, so the class
  // item's data is saved as it was.
  adv.configuration.updateSource?.({ max: 25 });
  try { await adv.apply(level, { type: "asi", assignments: { ...adv.configuration.toObject?.().fixed ?? adv.configuration.fixed } }); }
  finally { adv.configuration.updateSource?.({ max: before ?? null }); }
  session?.notes?.push({ key: "data:body-and-mind", text: globalThis.game?.i18n?.has?.("VEMOBILE.Builder.Data.BodyAndMind")
    ? globalThis.game.i18n.localize("VEMOBILE.Builder.Data.BodyAndMind")
    : "Body and Mind: DEX and WIS +4, to a maximum of 25 (2024 rules; dnd5e's data would stop at 20 or offer a feat instead)." });
}

/**
 * A step's title for the screens: DDB's "8: Ability Score Improvement" without the level prefix, and an Expertise step
 * named so (dnd5e's Bard 9 step is titled "Skills").
 */
export function displayTitle(adv) {
  let title = String(adv?.title ?? "").replace(/^\s*\d+\s*:\s*/, "");
  if (adv?.constructor?.typeName === "Trait" && adv.configuration?.mode === "expertise" && !/expert/i.test(title)) {
    title = globalThis.game?.i18n?.has?.("VEMOBILE.Builder.Expertise") ? globalThis.game.i18n.localize("VEMOBILE.Builder.Expertise") : "Expertise";
  }
  return title;
}

/** Does a compendium UUID resolve to a document? */
async function resolves(uuid) {
  try { if (globalThis.fromUuidSync?.(uuid, { strict: false })) return true; } catch { /* index miss */ }
  try { return Boolean(await globalThis.fromUuid(uuid)); } catch { return false; }
}

/**
 * A readable name for an item UUID that doesn't resolve. dnd5e's SRD data links PHB items its packs lack; their ids are
 * "phb" + a class code + the name ("phbmnkSelfrestor", "phbfstBlindFight").
 */
export const MISSING_NAMES = Object.freeze({
  phbmnkSelfrestor: "Self-Restoration", phbfstBlindFight: "Blind Fighting", phbfstDueling000: "Dueling", phbfstIntercepti: "Interception",
  phbfstProtection: "Protection", phbfstThrownWeap: "Thrown Weapon Fighting", phbfstUnarmedFig: "Unarmed Fighting"
});
export function missingName(uuid) {
  const id = String(uuid ?? "").split(".").pop();
  if (MISSING_NAMES[id]) return MISSING_NAMES[id];
  const words = id.replace(/^phb[a-z]{0,3}(?=[A-Z])/, "").replace(/0+$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words || String(uuid ?? "");
}

/**
 * @param {Actor} actor  The real actor.
 * @param {{ kind: "level", classId: string } | { kind: "new-class", classUuid: string } | { kind: "new-item", uuid: string }} target
 *   "new-item" (Phase 4): add any item with advancement (a background or species) to `actor`, which may be an unsaved copy.
 * @param {Array<{ key: string, data: object }>} [answers]
 * @param {{ remapUuid?: (uuid: string) => Promise<string>,
 *   extraSteps?: (manager: object, actor: Actor) => Promise<Array<{ key: string, type: string, title: string, item: string,
 *     level: number, model: () => Promise<object>, apply: (data: object) => Promise<void> }>>,
 *   skipTypes?: { has: (type: string) => boolean }, skipUnanswered?: boolean }} [options]
 *   extraSteps: builder-owned steps asked after dnd5e's advancement steps (Phase 3: spells).
 *   skipTypes: advancement types never asked or applied (a Set, or any object with has(type)). Phase 4: a species' own
 *     ability increases under 2024 rules, and types the screens can't draw (there is no actor yet for dnd5e's own window).
 *   skipUnanswered: leave unanswered steps unapplied and list them in `session.missing` instead of stopping
 *     (Phase 4 free tabs: segments that aren't on screen).
 *   prepareItem: async (data, doc) => void, changes a new item's data before dnd5e adds it (creation: origin-prep.mjs).
 *   checkAnswer: (adv, level, data) => Promise<null | { conflicts: object[] }>, run before a saved answer is replayed
 *     (creation: Trait picks another tab now grants). A conflict stops the session at that step, answer kept, with
 *     `pending.conflicts`; with skipUnanswered the answer is applied as saved and listed in `session.conflicts`.
 */
export function createLevelUpSession(actor, target, answers = [], { remapUuid = null, extraSteps = null, skipTypes = null, skipUnanswered = false, checkAnswer = null, prepareItem = null } = {}) {
  const session = {
    actor, target,
    answers: answers.map(a => (a ? { key: a.key, data: a.data, meta: a.meta } : null)),
    manager: null,
    /** The step waiting for the player, or null when the session reached Review changes. */
    pending: null,
    /** Interactive steps reached this run, in order: { index, key, title, type }. */
    path: [],
    /** skipUnanswered: steps left unanswered (and unapplied) this run. */
    missing: [],
    /** skipTypes: steps skipped this run: { title, type }. */
    skipped: [],
    /** checkAnswer with skipUnanswered: saved answers that no longer fit, applied as saved: { ...step, conflicts }. */
    conflicts: [],
    /** Fix 2: ItemChoice picks dnd5e removed again after applying them (unmet prerequisites): { title, item, names }. */
    dropped: [],
    /** Fix 10: granted items that don't resolve: { title, item, uuid, name }. */
    unresolved: [],
    /** Review notes from the replay itself: { key, text }. */
    notes: [],
    error: null,
    returnToReview: false
  };

  async function buildManager() {
    const AM = managerClass();
    if (target.kind === "level") return AM.forLevelChange(actor, target.classId, 1);
    if (target.kind === "new-item") {
      const item = await fromUuid(target.uuid);
      if (!item) throw new Error(`Item not found: ${target.uuid}`);
      const data = game.items.fromCompendium(item);
      if (prepareItem) await prepareItem(data, item);
      return AM.forNewItem(actor, data);
    }
    const doc = await fromUuid(target.classUuid);
    if (!doc) throw new Error(`Class not found: ${target.classUuid}`);
    const data = game.items.fromCompendium(doc);
    if (prepareItem) await prepareItem(data, doc);
    data.system.levels = 1;
    return AM.forNewItem(actor, data);
  }

  /** Replay answers; stop at `stopAt` (an answer index to edit) or at the first unanswered step. */
  async function run({ stopAt = Infinity } = {}) {
    const manager = await buildManager();
    const steps = manager.steps;
    const path = [];
    let answerIndex = 0;
    session.pending = null;
    session.error = null;
    session.missing = [];
    session.skipped = [];
    session.conflicts = [];
    session.dropped = [];
    session.unresolved = [];
    session.notes = [];
    const lists = createTraitLists(); // trait choice lists, built once per replay (CONFIG is read afresh each replay)
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const flow = step.flow;
      if (step.class) {
        step.class.item.updateSource({ "system.levels": step.type === "reverse" ? step.class.level - 1 : step.class.level });
        manager.clone.reset();
      }
      const pre = new Map(manager.clone.items.map(item => [item.id, item]));

      if (step.type === "delete" && step.item) manager.clone.items.delete(step.item.id);
      else if (step.type === "reverse" && flow) await flow.advancement.reverse(flow.level);
      else if (flow && skipTypes?.has(flow.advancement.constructor.typeName)) {
        // Never asked, never applied (Phase 4: a species' ability increases; types with no screen).
        session.skipped.push({ title: flow.advancement.title, type: flow.advancement.constructor.typeName });
      }
      else if (flow) {
        const adv = flow.advancement;
        const restore = shareTraitChoices(adv, lists);
        try {
          if (await needsInput(adv, flow.level)) {
            const key = stepKey(flow);
            const entry = { index: answerIndex, key, title: displayTitle(adv), type: adv.constructor.typeName, item: flow.item?.name ?? adv.item.name, level: flow.level,
              ...stepFacts(adv) };
            path.push(entry);
            alignAnswers(session.answers, answerIndex, key);
            if (skipUnanswered && answerIndex < stopAt && !session.answers[answerIndex]) {
              // Free tabs: leave this step unapplied and keep going; its tab shows "needs attention".
              session.missing.push(entry);
            } else if (answerIndex >= stopAt || !session.answers[answerIndex]) {
              session.manager = manager;
              session.path = path;
              session.pending = { ...entry, stepIndex: i, totalSteps: steps.length, flow, advancement: adv, answer: session.answers[answerIndex] ?? null };
              return session;
            } else {
              const check = checkAnswer ? await checkAnswer(adv, flow.level, session.answers[answerIndex].data) : null;
              if (check?.conflicts?.length && !skipUnanswered) {
                // On screen: ask this step again, keeping the saved answer (and the ones after it) for the player to fix.
                session.manager = manager;
                session.path = path;
                session.pending = { ...entry, stepIndex: i, totalSteps: steps.length, flow, advancement: adv, answer: session.answers[answerIndex], conflicts: check.conflicts };
                return session;
              }
              if (check?.conflicts?.length) session.conflicts.push({ ...entry, conflicts: check.conflicts });
              try {
                const data = session.answers[answerIndex].data;
                await applyAnswer(adv, flow.level, data);
                const dropped = droppedPicks(adv, flow.level, data);
                if (dropped.length) session.dropped.push({ title: adv.title, item: entry.item, index: answerIndex, names: dropped.map(missingOrName) });
              } catch (error) {
                // A saved answer that dnd5e now rejects: ask this step again (the answers after it stay for their steps).
                session.answers[answerIndex] = null;
                session.manager = manager;
                session.path = path;
                session.error = error;
                session.pending = { ...entry, stepIndex: i, totalSteps: steps.length, flow, advancement: adv, answer: null };
                return session;
              }
              answerIndex++;
            }
          } else {
            await applyAutomatic(adv, flow.level, remapUuid, session);
          }
        } finally {
          // Before the step is shown (its model reads the choices afresh) or the next step runs.
          restore();
        }
      }
      synthesize(manager, i, pre);
      manager.clone.reset();
    }
    // Builder-owned steps after dnd5e's own (Phase 3: spells), answered and replayed the same way. A `defer` entry is
    // built only when it is reached (after the steps before it applied); an `auto` step applies with no screen.
    const extras = extraSteps ? await extraSteps(manager, actor) : [];
    for (let e = 0; e < extras.length; e++) {
      const extra = extras[e];
      if (extra.defer) { extras.splice(e + 1, 0, ...((await extra.defer()) ?? [])); continue; }
      if (extra.auto) {
        try { await extra.apply(null); } catch (error) { console.warn("Character Builder | automatic step failed", extra.key, error); }
        manager.clone.reset();
        continue;
      }
      // `extra` stays on the path entry so Review can read what the step applied (spell warnings).
      const entry = { index: answerIndex, key: extra.key, title: extra.title, type: extra.type, item: extra.item, level: extra.level, extra };
      path.push(entry);
      alignAnswers(session.answers, answerIndex, extra.key);
      const ask = (error = null) => {
        session.manager = manager;
        session.path = path;
        session.error = error;
        session.pending = { ...entry, stepIndex: steps.length, totalSteps: steps.length + 1, flow: null, advancement: null,
          answer: error ? null : session.answers[answerIndex] ?? null };
        return session;
      };
      if (skipUnanswered && answerIndex < stopAt && !session.answers[answerIndex]) { session.missing.push(entry); continue; }
      if (answerIndex >= stopAt || !session.answers[answerIndex]) return ask();
      try {
        await extra.apply(session.answers[answerIndex].data);
      } catch (error) {
        // An answer that can't be applied any more: ask this step again rather than jam every replay.
        session.answers[answerIndex] = null;
        return ask(error);
      }
      manager.clone.reset();
      answerIndex++;
    }
    session.answers.length = answerIndex;
    session.manager = manager;
    session.path = path;
    session.returnToReview = false;
    return session;
  }

  session.start = () => run();
  /** Answer the pending step and continue to the next one (or Review changes). */
  session.answer = async (data, meta) => {
    if (!session.pending) throw new Error("No step is waiting for an answer.");
    const index = session.pending.index;
    session.answers[index] = { key: session.pending.key, data, meta };
    // Editing from Review changes returns there; otherwise step forward one screen at a time.
    if (session.returnToReview) return run();
    return run({ stopAt: index + 1 });
  };
  /** Go back one interactive step, keeping later answers so Next replays them. */
  session.back = async () => {
    const current = session.pending ? session.pending.index : session.answers.length;
    if (current <= 0) return null;
    return run({ stopAt: current - 1 });
  };
  /** Reopen a specific answered step (from a Review changes line). */
  session.edit = index => { session.returnToReview = true; return run({ stopAt: index }); };
  /** Re-run to the first unanswered step or Review changes. */
  session.resume = () => run();
  /** Phase 4: replay, stopping at answer index `stopAt` (the step to show) or the first unanswered step. */
  session.replay = ({ stopAt = Infinity } = {}) => run({ stopAt });
  /** Plain draft for the user flag. */
  // Holes (steps not answered yet) stay as null, so answer indexes keep matching the path.
  session.draft = () => ({ target, answers: session.answers.map(a => (a ? { key: a.key, data: a.data, meta: a.meta ?? null } : null)) });
  return session;
}

/** Fix 12: refuse ASI points dnd5e would lose (a score at its maximum) or that break the step's limits. */
function checkAsiAnswer(adv, assignments) {
  const actor = adv.actor;
  const scores = {};
  for (const [key, ability] of Object.entries(actor?.system?.abilities ?? {})) {
    scores[key] = { value: Number(actor.system._source?.abilities?.[key]?.value ?? ability.value) || 0, max: Number(ability.max) || 20 };
  }
  const config = adv.configuration ?? {};
  const problems = asiAnswerProblems({ points: config.points, cap: config.cap, fixed: config.fixed ?? {}, locked: Array.from(config.locked ?? []), max: config.max },
    scores, assignments, key => adv.canImprove?.(key) !== false);
  if (!problems.length) return;
  const label = key => String(globalThis.CONFIG?.DND5E?.abilities?.[key]?.abbreviation ?? key).toUpperCase();
  const text = problems.map(p => p.reason === "max" ? `${label(p.key)} can't go above ${p.max}`
    : p.reason === "cap" ? `${label(p.key)} can't rise by more than ${p.cap}`
      : p.reason === "locked" ? `${label(p.key)} can't be raised here` : `only ${p.points} points to spend`).join("; ");
  throw new Error(`Ability scores: ${text}.`);
}

/** Picks of an ItemChoice answer that dnd5e didn't keep (its prerequisite check reverses them after apply). */
export function droppedPicks(adv, level, data) {
  if (adv.constructor.typeName !== "ItemChoice") return [];
  const kept = new Set(Object.values(adv.value?.added?.[level] ?? {}));
  return [...new Set(data?.selected ?? [])].filter(uuid => !kept.has(uuid));
}

const missingOrName = uuid => {
  let entry = null;
  try { entry = globalThis.fromUuidSync?.(uuid, { strict: false }); } catch { entry = null; }
  return entry?.name ?? missingName(uuid);
};

/** Apply a player's answer with the data shapes confirmed on dnd5e 5.3.2 (spec §4). */
export async function applyAnswer(adv, level, data) {
  const type = adv.constructor.typeName;
  if (type === "HitPoints") return adv.apply(level, { [level]: data.value });
  if (type === "Size") return adv.apply(level, { size: data.size });
  if (type === "Subclass") return adv.apply(level, { uuid: data.uuid });
  if (type === "AbilityScoreImprovement") {
    if (data.type === "feat") return adv.apply(level, { type: "feat", uuid: data.uuid });
    checkAsiAnswer(adv, data.assignments ?? {});
    return adv.apply(level, { type: "asi", assignments: data.assignments ?? {} });
  }
  if (type === "ItemChoice") {
    // Spells: all of a feat's picks from one list (Magic Initiate), and the chosen spellcasting ability (data fix 2).
    checkSpellChoice(adv, data);
    // Fix 3: dnd5e's replacement: one earlier pick (an item id on the copy) swapped for one more new pick.
    const choice = adv.configuration.choices?.[level] ?? {};
    const replace = choice.replacement && data.replace && replaceableItems(adv, level).some(r => r.id === data.replace) ? data.replace : null;
    const count = Number(choice.count) || 0;
    const selected = [...new Set(data.selected ?? [])].slice(0, count + (replace ? 1 : 0));
    const swap = replace && selected.length > count;
    return adv.apply(level, { selected, ...(swap ? { replace } : {}), ...(data.ability ? { ability: data.ability } : {}) });
  }
  if (type === "ItemGrant") return adv.apply(level, { selected: data.selected ?? [], ...(data.ability ? { ability: data.ability } : {}) });
  if (type === "Trait") return adv.apply(level, { chosen: data.chosen ?? [] });
  throw new Error(`Unsupported advancement type: ${type}`);
}

/**
 * Port of AdvancementManager#synthesizeSteps (private in dnd5e 5.3.2): forward steps for
 * added items with advancement, reverse + delete steps for removed ones.
 */
export function synthesize(manager, stepIndex, preItems) {
  const steps = manager.steps;
  const AM = manager.constructor;
  const preIds = new Set(preItems.keys());
  const initialIds = steps.reduce((ids, s) => { if (!s.synthetic && s.flow?.item) ids.add(s.flow.item.id); return ids; }, new Set());
  const postIds = new Set(manager.clone.items.map(i => i.id));
  const addedIds = postIds.difference(preIds).difference(initialIds);
  const deletedIds = preIds.difference(postIds).difference(initialIds);
  for (const addedId of addedIds) {
    const item = manager.clone.items.get(addedId);
    if (!item.hasAdvancement) continue;
    let handledLevel = 0;
    for (let idx = stepIndex; idx < steps.length; idx++) {
      const getLevel = s => (item.system.advancementClassLinked ? undefined : s?.level) ?? s?.flow?.level ?? s?.class?.level ?? s?.level;
      const thisLevel = getLevel(steps[idx]);
      const nextLevel = getLevel(steps[idx + 1]);
      if ((thisLevel < handledLevel) || (thisLevel >= nextLevel)) continue;
      const add = Array.fromRange(thisLevel - handledLevel + 1, handledLevel)
        .flatMap(l => AM.flowsForLevel(item, l, { findExisting: steps }))
        .map(flow => ({ type: "forward", flow, synthetic: true }));
      steps.splice(idx + 1, 0, ...add);
      idx += add.length;
      handledLevel = nextLevel ?? handledLevel;
    }
  }
  if ((steps[stepIndex].type === "delete") && steps[stepIndex].synthetic) return;
  for (const deletedId of deletedIds) {
    let item = preItems.get(deletedId);
    if (!item?.hasAdvancement) continue;
    manager.clone.updateSource({ items: [item.toObject()] });
    item = manager.clone.items.get(item.id);
    const add = Array.fromRange(manager.clone.system.details.level + 1)
      .flatMap(l => AM.flowsForLevel(item, l)).reverse()
      .map(flow => ({ type: "reverse", flow, automatic: true, synthetic: true }));
    add.push({ type: "delete", flow: steps[stepIndex].flow, item, automatic: true, synthetic: true });
    steps.splice(stepIndex + 1, 0, ...add);
  }
}

/** Port of AdvancementManager#complete's diff: what committing the clone will write. */
export function cloneDiff(manager) {
  const updates = manager.clone.toObject();
  const items = updates.items;
  delete updates.items;
  const { toCreate, toUpdate, toDelete } = items.reduce((obj, item) => {
    if (!manager.actor.items.get(item._id)) obj.toCreate.push(item);
    else { obj.toUpdate.push(item); obj.toDelete.findSplice(id => id === item._id); }
    return obj;
  }, { toCreate: [], toUpdate: [], toDelete: manager.actor.items.map(i => i.id) });
  return { updates, toCreate, toUpdate, toDelete };
}
