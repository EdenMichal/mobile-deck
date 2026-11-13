/**
 * Phase 4a engine: replay a creation draft on an unsaved actor (spec §3.4; research §2.4).
 * Rules order: base scores → background → species → class (with the Phase 3 spell step) →
 * equipment and trinket → details. Each segment is a headless level-up session on the previous
 * segment's copy. Segments that aren't on screen skip unanswered steps, so tabs can be filled in
 * any order; nothing reaches the world until commitCreation().
 */
import { createLevelUpSession, SUPPORTED_TYPES } from "./advancement-driver.mjs";
import { currentHouseRules, isAllowedUuid, packSettings, preferredUuid, savedSources, worldRules } from "./content-sources.mjs";
import { canonicalTraitKeys, prepareOriginItem } from "./origin-prep.mjs";
import { isBanned } from "./source-filter.mjs";
import { baseScores } from "./creation-rules.mjs";
import { emptyRolls, SEGMENT_TABS, traitsOf } from "./creation-tabs.mjs";
import { applyEquipment, applyTrinket, EQUIPMENT_SOURCES } from "./equipment-step.mjs";
import { builderSpellSteps } from "./feature-spells.mjs";
import { checkTraitAnswer } from "./trait-options.mjs";
import { appendChangeLog, buildChangeLogEntry } from "./change-log.mjs";
import { builderSnapshot, classSummary } from "./snapshot.mjs";
import { whisperSummary } from "./commit.mjs";

/** Types never asked: ones the screens can't draw (no actor yet for dnd5e's window) and, for species, ASIs (2024 rules). */
const skipFor = tab => ({ has: type => !SUPPORTED_TYPES.has(type) || (tab === "species" && type === "AbilityScoreImprovement") });

const paragraphs = text => {
  const esc = globalThis.foundry.utils.escapeHTML ?? (s => s);
  return String(text ?? "").split(/\n\s*\n/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`).join("");
};

/**
 * What dnd5e 5.3.2's item _onCreate handlers would have set had each item been created on a saved actor
 * (they never run here: the copy is saved once, with its items, by Actor.create). Background → details.background;
 * species → details.race (which also drives speed, senses and the species' level-1 grants in the class segment);
 * class or subclass → attributes.spellcasting when it is still empty. details.originalClass is set by
 * AdvancementManager.forNewItem itself. Idempotent: a link already in place is left alone.
 */
export function linkSegment(actor, tab) {
  const source = actor._source.system ?? {};
  const update = {};
  if (tab === "background") {
    const item = actor.items.find(i => i.type === "background");
    if (item && source.details?.background !== item.id) update["system.details.background"] = item.id;
  } else if (tab === "species") {
    const item = actor.items.find(i => i.type === "race");
    if (item && source.details?.race !== item.id) update["system.details.race"] = item.id;
  } else if (tab === "class" && !source.attributes?.spellcasting) {
    const ability = actor.items.filter(i => i.type === "class" || i.type === "subclass").map(i => i.spellcasting?.ability ?? i.system.spellcasting?.ability).find(Boolean);
    if (ability) update["system.attributes.spellcasting"] = ability;
  }
  if (Object.keys(update).length) {
    actor.updateSource(update);
    actor.reset();
  }
  return update;
}

/** What origin-prep needs: the world's ability names, and the item's pack settings (the GM's edition tag). */
/**
 * A trait type's full keys ("tool:art:alchemist"…), from dnd5e's own choice lists; built once per page, except languages
 * (modules such as DDB Importer add language groups after "ready").
 */
const traitKeyCache = new Map();
function traitKeys(trait) {
  if (!globalThis.CONFIG?.DND5E?.traits?.[trait]) return Promise.resolve(new Set());
  if (trait === "languages") return globalThis.dnd5e.documents.Trait.choices(trait, { prefixed: true }).then(c => c.asSet(), () => new Set());
  if (!traitKeyCache.has(trait)) {
    traitKeyCache.set(trait, globalThis.dnd5e.documents.Trait.choices(trait, { prefixed: true }).then(c => c.asSet(), () => new Set()));
  }
  return traitKeyCache.get(trait);
}

export function originOptions(doc) {
  const abilities = globalThis.CONFIG?.DND5E?.abilities ?? {};
  const labels = Object.fromEntries(Object.entries(abilities).map(([k, a]) => [k, globalThis.game?.i18n?.localize?.(a?.label ?? "") || ""]));
  return { labels, pack: doc?.pack ? packSettings().find(p => p.collection === doc.pack) ?? null : null };
}

const copy = value => (typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

/**
 * Performance: a cache of replay results for one creation controller (one wizard, one draft). Segments are keyed by
 * everything they depend on (runCreation), so a tap replays only from the first segment whose input changed, and an
 * Equipment or Details tap replays none. `equipment` holds equipment-step lookups (candidates, pack contents).
 */
export function createReplayCache({ limit = 30 } = {}) {
  return { segments: new Map(), limit, equipment: { candidates: new Map(), contents: new Map() } };
}

/**
 * What else the replay reads that can change during a session: the language list (modules add groups after "ready"),
 * dnd5e's Compendium Browser sources and which Item packs this client sees. Cheap: keys and ids only.
 */
function contentFingerprint(game = globalThis.game) {
  const keys = (tree, prefix = "") => Object.entries(tree ?? {}).flatMap(([k, v]) => [prefix + k, ...keys(v?.children, `${prefix}${k}:`)]);
  let dnd5eSources = {};
  try { dnd5eSources = game?.settings?.get?.("dnd5e", "packSourceConfiguration") ?? {}; } catch { dnd5eSources = {}; }
  const packs = game?.packs?.filter?.(p => p.documentName === "Item" && p.visible !== false).map(p => p.collection).join(",") ?? "";
  return [keys(globalThis.CONFIG?.DND5E?.languages).join(","), dnd5eSources, packs];
}

function remember(cache, key, value) {
  cache.segments.delete(key);
  cache.segments.set(key, value);
  while (cache.segments.size > cache.limit) cache.segments.delete(cache.segments.keys().next().value);
}

/** The unsaved starting actor: base scores (10 where none yet), name. `rolls`: the creation rolls (emptyRolls shape). */
export function blankActor(draft, methods = null, rolls = emptyRolls()) {
  const saved = draft.tabs.abilities ?? {};
  // A method the GM has since switched off doesn't count (spec §3.6).
  const answer = !methods || methods.includes(saved.method) ? saved : {};
  const base = baseScores(answer, rolls.abilities ?? {});
  const abilities = Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { value: v ?? 10 }]));
  return new (copyActorClass())({ name: draft.tabs.details?.name?.trim() || "New character", type: "character", system: { abilities } });
}

/**
 * Performance: the class of the unsaved creation copy. dnd5e's own Actor5e, not CONFIG.Actor.documentClass, which
 * modules may extend with work for tokens and vision on every data preparation (vision-5e: detection modes, special
 * statuses, a hearing roll from getRollData, a scan of feats and effects). The copy is prepared dozens of times per tap
 * and is never on a canvas; only its source is saved, and Create makes the real actor with the full class, so every
 * module prepares the saved character as usual. The builder reads only dnd5e's data from the copy.
 */
export function copyActorClass() {
  return globalThis.dnd5e?.documents?.Actor5e ?? globalThis.Actor.implementation;
}

/**
 * Replay `draft`. Mutates `draft.tabs[segment].answers` to what still applies (the driver drops
 * answers whose step no longer exists); the controller saves the draft afterwards.
 * @param {{ focus?: { tab: string, stopAt?: number }, methods?: string[], rolls?: object, cache?: object }} [options]  `focus`: the segment tab
 *   on screen ("spells" = the class segment); the replay stops there and returns `focused`. `methods`: ability methods the GM
 *   allows. `rolls`: the creation rolls (ability sets, gold by item uuid, trinket), kept apart from the draft.
 *   `cache`: createReplayCache(), to reuse unchanged segments (performance; results are the same without it).
 * @returns {Promise<{ blank, final, segments, missing: Array<{ tab, kind, title?, type?, conflicts? }>, notices: Array<{ tab, title }>,
 *   focused, equipment }>}
 */
export async function runCreation(draft, { focus = null, methods = null, rolls = emptyRolls(), cache = null } = {}) {
  const blank = blankActor(draft, methods, rolls);
  const rules = currentHouseRules();
  let actor = blank;
  const segments = {};
  const missing = [];
  const notices = [];
  // Segment cache key: what a segment's result depends on. Its input actor (the chain of earlier keys, from the base
  // scores), its pick and saved answers, and the GM's sources and house rules. The name and details come later.
  let chain = cache ? JSON.stringify([savedSources(), rules, worldRules(), contentFingerprint(), blank._source.system.abilities]) : "";
  for (const tab of SEGMENT_TABS) {
    const pick = draft.tabs[tab];
    if (!pick?.uuid) { missing.push({ tab, kind: "pick" }); continue; }
    const focused = Boolean(focus) && (focus.tab === tab || (tab === "class" && focus.tab === "spells"));
    const key = cache && !focused ? `${chain}|${tab}|${pick.uuid}|${JSON.stringify(pick.answers ?? [])}` : null;
    const hit = key ? cache.segments.get(key) : null;
    if (hit) {
      // Same input, same answers: the earlier result. Nothing writes to a cached actor (equipment goes on a clone).
      pick.answers = copy(hit.answers);
      segments[tab] = hit.segment;
      missing.push(...hit.missing);
      notices.push(...hit.notices);
      actor = hit.actor;
      chain = key;
      continue;
    }
    const missingFrom = missing.length;
    const noticesFrom = notices.length;
    // Spec §6: a pick the GM's sources no longer allow, that is gone, or that the House Rules now ban needs a new pick.
    const doc = (await isAllowedUuid(pick.uuid)) ? await globalThis.fromUuid(pick.uuid).catch(() => null) : null;
    if (!doc || isBanned(doc, rules)) {
      segments[tab] = { tab, session: null, error: new Error("unavailable"), unavailable: true };
      missing.push({ tab, kind: "unavailable" });
      if (focused) return { blank, final: null, segments, missing, notices, focused: segments[tab], equipment: null };
      continue;
    }
    const target = tab === "class" ? { kind: "new-class", classUuid: pick.uuid } : { kind: "new-item", uuid: pick.uuid };
    const session = createLevelUpSession(actor, target, pick.answers ?? [], { remapUuid: preferredUuid,
      extraSteps: builderSpellSteps, skipTypes: skipFor(tab), skipUnanswered: !focused, checkAnswer: checkTraitAnswer,
      prepareItem: async (data, source) => {
        prepareOriginItem(data, originOptions(source));
        await canonicalTraitKeys(data, traitKeys);
      } });
    try {
      await session.replay({ stopAt: focused ? (focus.stopAt ?? Infinity) : Infinity });
    } catch (error) {
      segments[tab] = { tab, session, error };
      missing.push({ tab, kind: "error", error });
      if (focused) return { blank, final: null, segments, missing, notices, focused: segments[tab], equipment: null };
      continue;
    }
    pick.answers = session.draft().answers;
    segments[tab] = { tab, session };
    for (const m of session.missing) missing.push({ tab: m.type === "Spells" ? "spells" : tab, kind: "step", title: m.title, type: m.type });
    // Saved Trait picks another tab now grants (or no longer offered): the step needs a new pick (data fix 4).
    for (const c of session.conflicts) missing.push({ tab, kind: "conflict", title: c.title, type: c.type, index: c.index, item: c.item, conflicts: c.conflicts });
    // Fix 7: Spells-tab picks another tab now gives (Magic Initiate): the Spells tab needs new picks.
    for (const p of session.path) {
      if (p.type === "Spells" && p.extra?.conflicts?.length) missing.push({ tab: "spells", kind: "conflict", title: p.title, type: p.type, index: p.index, conflicts: p.extra.conflicts });
    }
    // A saved answer dnd5e rejected on this replay stops the segment even off screen: flag it, don't lose it silently.
    if (!focused && session.pending) missing.push({ tab: session.pending.type === "Spells" ? "spells" : tab, kind: "step", title: session.pending.title, type: session.pending.type, rejected: true,
      // Why the saved answer was refused (it is dropped from the draft), so the tab can say so when it is reopened.
      key: session.pending.key, error: session.error?.message ?? "" });
    for (const s of session.skipped) if (!(tab === "species" && s.type === "AbilityScoreImprovement")) notices.push({ tab, title: s.title });
    if (focused) return { blank, final: null, segments, missing, notices, focused: segments[tab], equipment: null };
    actor = session.manager.clone;
    // Before the next segment: the class segment needs details.race to ask the species' level-1 steps.
    linkSegment(actor, tab);
    // A spell list that failed to load is tried again next time rather than remembered.
    if (key) {
      // A spell list that failed to load is tried again next time rather than remembered; the chain moves on either way,
      // so the next segment's key always names this segment's input.
      if (!session.path.some(p => p.extra?.warnings?.some(w => w.kind === "failed"))) {
        remember(cache, key, { answers: copy(pick.answers), segment: segments[tab], actor,
          missing: missing.slice(missingFrom), notices: notices.slice(noticesFrom) });
      }
      chain = key;
    }
  }
  let equipment = { notFound: [], coins: {} };
  if (actor !== blank) {
    // Equipment, trinket and details go on a copy, so a cached segment result is never written to.
    if (cache) actor = actor.clone({}, { keepId: true });
    equipment = await applyEquipment(actor, EQUIPMENT_SOURCES.map(source => ({
      item: actor.items.find(i => i.type === source) ?? null, answer: draft.tabs.equipment?.[source] ?? {},
      chosenTraits: traitsOf(draft.tabs[source]), wealthRoll: rolls.gold?.[draft.tabs[source]?.uuid]?.value ?? null })), { cache: cache?.equipment });
    applyTrinket(actor, rolls.trinket?.text);
  }
  const details = draft.tabs.details ?? {};
  actor.updateSource({ name: details.name?.trim() || "New character", "system.details.alignment": details.alignment ?? "",
    "system.details.biography.value": paragraphs(details.biography) });
  actor.reset?.();
  return { blank, final: actor, segments, missing, notices, focused: null, equipment };
}

/**
 * Save a finished replay as a new actor (4a: users who may create actors). One Actor.create with
 * item ids kept (containers keep their contents), the owner as OWNER, a "creation" change-log
 * entry and the GM chat card; the owner's assigned character if they have none.
 */
export async function commitCreation(run, draft, { moduleId, groups, t, game = globalThis.game, author = game.user, approvedBy = null, approvalOf = null }) {
  // An approved submission always belongs to its author: `draft.owner` sits in the player's own flag, which they can
  // edit, so it never decides who gets the actor. Otherwise a saved owner counts only for a GM creating for a player.
  const ownerId = approvedBy ? author.id : ((game.user.isGM && draft.owner) || author.id);
  const data = run.final.toObject();
  delete data._id;
  data.ownership = { default: 0, [ownerId]: globalThis.CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
  const after = builderSnapshot(run.final);
  const entry = buildChangeLogEntry({ kind: "creation", user: author, approvedBy, approvalOf, date: Date.now(),
    before: { level: 0, label: t("Creation.New", "New character") }, after: { level: after.level, label: classSummary(after) }, groups });
  globalThis.foundry.utils.setProperty(data, `flags.${moduleId}.changeLog`, appendChangeLog([], entry));
  // Phase 4b: the submission this actor was made from, so a retried Approve finds it instead of making a second one.
  if (approvalOf) globalThis.foundry.utils.setProperty(data, `flags.${moduleId}.approvalOf`, String(approvalOf));
  const actor = await globalThis.Actor.implementation.create(data, { keepEmbeddedIds: true });
  const owner = game.users.get(ownerId);
  if (owner && !owner.character) await owner.update({ character: actor.id }).catch(error => console.warn(`${moduleId} | could not assign the new character`, error));
  await whisperSummary(actor, entry, game).catch(error => console.warn(`${moduleId} | creation chat card failed`, error));
  return { actor, entry };
}
