/**
 * Phase 4a: the creation wizard's controller (spec §2, §3). Plain view models out, answers in.
 * It owns the user's one creation draft and replays it through creation-session.mjs: a full
 * replay after every change (tab states, Review), and a focused replay for the segment on screen.
 */
import { createDraftStore } from "./draft-store.mjs";
import { currentHouseRules, findBackgrounds, findClasses, findSpecies, packSettings, worldRules } from "./content-sources.mjs";
import { entryRules } from "./source-filter.mjs";
import { ABILITIES, abilityStatus, baseScores, finalScores, methodsAllowed, pointBuyState, rerollsLeft, slotValues, SUGGESTED_ARRAY, validateEntered } from "./creation-rules.mjs";
import { abilityGroup, emptyDraft, emptyRolls, groupSpecies, setPick, tabStates, traitsOf } from "./creation-tabs.mjs";
import { commitCreation, createReplayCache, originOptions, runCreation } from "./creation-session.mjs";
import { esc, sessionNotes } from "./commit.mjs";
import { backgroundHasAsi, trinketTableUuid } from "./origin-prep.mjs";
import { EQUIPMENT_SOURCES, equipmentSection, itemEquipmentOptions, TRINKETS_TABLE } from "./equipment-step.mjs";
import { reviewChanges } from "./review-diff.mjs";
import { builderSnapshot } from "./snapshot.mjs";
import { itemDetails, stepModel } from "./step-model.mjs";
import { spellDetails } from "./spell-details.mjs";
import { approvalResult, asApproving, asDraft, asSubmitted, asUnclaimed, canClaim, canWithdraw, claimIsStale, holdsClaim, isWaiting, needsApproval, pageId,
  resultKey, sameSubmission, serverNow, statusOf, submissionId } from "./approval-rules.mjs";

/** Phase 4b: how long a claim settles before the claiming page reads it back (another page's write would have landed). */
export const CLAIM_SETTLE_MS = 500;

const METHOD_LABELS = Object.freeze({
  standardArray: ["Abilities.StandardArray", "Standard Array"], pointBuy: ["Abilities.PointBuy", "Point Buy"],
  roll: ["Abilities.Roll", "Roll in Foundry"], manual: ["Abilities.Manual", "Enter my dice"]
});
export const TAB_LABELS = Object.freeze({
  class: ["Tab.Class", "Class"], background: ["Tab.Background", "Background"], species: ["Tab.Species", "Species"],
  abilities: ["Tab.Abilities", "Abilities"], equipment: ["Tab.Equipment", "Equipment"], spells: ["Tab.Spells", "Spells"],
  details: ["Tab.Details", "Details"], review: ["Tab.Review", "Review"]
});

/**
 * `user`: whose draft this is (default: this client's user). Phase 4b: the GM's client opens a player's submission with
 * `user: <the player's User>, readOnly: true`, which replays and reviews it but never saves the draft back.
 */
export function createCreationController({ moduleId, t, game = globalThis.game, user = game.user, readOnly = false } = {}) {
  const store = createDraftStore(moduleId, game, user);
  let draft = store.creation();
  // Ability sets, dice-formula gold and the trinket: kept apart from the draft, so Start over or a class
  // switch never rolls again (spec §2.4); cleared only by a successful Create.
  let rolls = store.creationRolls();
  let full = null;   // last full replay (+ equipmentDone)
  // Performance: unchanged segments and equipment lookups are reused between replays (keyed by what they depend on).
  let cache = createReplayCache();
  let shown = null;  // last focused replay (segment tab on screen)
  const isGM = Boolean(game.user.isGM);
  const canCreate = () => isGM || Boolean(game.user.can?.("ACTOR_CREATE"));
  /** Plain text of roll-table HTML, entities decoded ("&amp;" → "&"), so the trinket item escapes it exactly once. */
  const stripHtml = html => {
    const text = String(html ?? "").replace(/<[^>]+>/g, " ");
    let decoded = text;
    try { decoded = new globalThis.DOMParser().parseFromString(text, "text/html").documentElement.textContent ?? text; }
    catch { decoded = text.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&"); }
    return decoded.replace(/\s+/g, " ").trim();
  };
  const label = pair => t(pair[0], pair[1]);

  const save = async () => {
    // A late save after Create or Start over; the GM's read-only copy; a waiting draft (only Withdraw changes it, so a
    // resume can't overwrite the GM's decision).
    if (!draft || readOnly || isWaiting(draft)) return;
    try { await store.saveCreation(draft); }
    catch (error) { console.warn(`${moduleId} | could not save the creation draft`, error); }
  };
  /** The roll lock: saved before anything else can fail. */
  const saveRolls = async () => {
    if (readOnly) return;
    try { await store.saveCreationRolls(rolls); }
    catch (error) { console.warn(`${moduleId} | could not save the creation rolls`, error); }
  };
  /** Spec §4.2: a waiting draft doesn't change; the first change to a rejected one makes it a draft again (the GM's note stays). */
  const edit = () => {
    if (readOnly) throw new Error("This draft is read-only here.");
    if (isWaiting(draft)) throw new Error(t("Approval.Locked", "Waiting for GM approval. Withdraw it to make changes."));
    if (statusOf(draft) === "rejected") draft = asDraft(draft);
  };
  /**
   * "create": saves here. "submit": waits for GM approval (spec §4.1). "auto": the approval switch is off, but this user
   * can't create actors, so the GM's client creates it without asking.
   */
  const mode = () => {
    if (needsApproval("creation", user, currentHouseRules(game))) return "submit";
    return canCreate() ? "create" : "auto";
  };
  const equipmentSections = async () => {
    const final = full?.final;
    const sections = [];
    for (const source of EQUIPMENT_SOURCES) {
      const item = final?.items.find(i => i.type === source) ?? null;
      sections.push(await equipmentSection(source, item, draft.tabs.equipment?.[source] ?? {}, { chosenTraits: traitsOf(draft.tabs[source]), actor: final,
        cache: cache.equipment, goldRolled: Boolean(rolls.gold?.[draft.tabs[source]?.uuid]) }));
    }
    return sections;
  };
  const methods = () => methodsAllowed(currentHouseRules(game));
  /** The saved Abilities answer, unless the GM has since switched its method off. */
  const abilityAnswer = () => (methods().includes(draft.tabs.abilities?.method) ? draft.tabs.abilities : null);
  const refresh = async () => {
    full = await runCreation(draft, { methods: methods(), rolls, cache });
    full.sections = await equipmentSections();
    full.equipmentDone = full.sections.every(s => s.complete);
    return full;
  };
  const abilityLabels = () => Object.fromEntries(ABILITIES.map(k => [k, String(globalThis.CONFIG.DND5E.abilities[k]?.abbreviation ?? k).toUpperCase()]));
  const backgroundBonus = () => (draft.tabs.background?.answers ?? []).find(a => a?.data?.type === "asi")?.data?.assignments ?? {};
  const classIdentifier = () => full?.final?.items.find(i => i.type === "class")?.identifier ?? "";
  const spellsEntry = () => full?.segments.class?.session?.path?.find(p => p.type === "Spells") ?? null;
  /** Answered steps on a segment's own tab (the class's spell step lives on the Spells tab). */
  const answeredSteps = (segTab, session) => {
    const path = session?.path ?? [];
    return segTab === "class" ? path.filter(p => p.type !== "Spells" && p.index < (draft.tabs.class?.answers?.length ?? 0)).length
      : (draft.tabs[segTab]?.answers?.length ?? 0);
  };
  /** "Skill Proficiencies: Stealth, Sleight of Hand already granted by your background — choose another." */
  const conflictText = ({ title, conflicts = [] }) => {
    const bySource = new Map();
    for (const c of conflicts) bySource.set(c.tab ?? "", [...(bySource.get(c.tab ?? "") ?? []), c.label ?? c.key]);
    return [...bySource.entries()].map(([source, labels]) => (source
      ? t("Creation.Conflict", "{title}: {traits} already granted by your {source} — choose another.", { title, traits: labels.join(", "), source: label(TAB_LABELS[source]).toLowerCase() })
      : t("Creation.ConflictGone", "{title}: {traits} can't be chosen any more — choose another.", { title, traits: labels.join(", ") }))).join(" ");
  };
  /** The edition of the picked class ("2014", "2024" or ""), as the pickers read it (its rules, the GM's tag, DDB flags…). */
  const classRules = async () => {
    const uuid = draft?.tabs.class?.uuid;
    const doc = uuid ? await globalThis.fromUuid(uuid).catch(() => null) : null;
    return doc ? entryRules(doc, doc.pack ? packSettings(game).find(p => p.collection === doc.pack) ?? null : null) : "";
  };
  /** An older background with no increase of its own (a 2024 one without a step gets one: origin-prep.mjs). */
  const backgroundWithoutAsi = async uuid => {
    const doc = await globalThis.fromUuid(uuid).catch(() => null);
    return !doc || !backgroundHasAsi(doc.toObject(), originOptions(doc));
  };
  /** The background's own trinket table when its description links one (a DDB Importer world pack, a homebrew book), else the PHB's. */
  const trinketTable = async () => {
    const background = draft?.tabs.background?.uuid ? await globalThis.fromUuid(draft.tabs.background.uuid).catch(() => null) : null;
    const own = trinketTableUuid(background?.system?.description?.value);
    return (own && await globalThis.fromUuid(own).catch(() => null)) || await globalThis.fromUuid(TRINKETS_TABLE).catch(() => null);
  };
  const card = async uuid => {
    const doc = await globalThis.fromUuid(uuid).catch(() => null);
    return doc ? { uuid, name: doc.name, img: doc.img || "" } : { uuid, name: uuid, img: "" };
  };
  async function chat(content, extra = {}) {
    const whisper = [...new Set([...game.users.filter(u => u.isGM).map(u => u.id), game.user.id])];
    const message = await globalThis.ChatMessage.create({ speaker: { alias: game.user.name },
      content: `<div class="ve-builder-chat-card">${content}</div>`, whisper, ...extra });
    return message?.id ?? "";
  }

  /** Everything Create and Submit refuse: an over-budget point buy and Review blockers. */
  async function readyReview() {
    if (!draft) throw new Error(t("Creation.AlreadyCreated", "This character has already been created."));
    // Saved data can say anything; the rules can't be bent at the last step.
    if (abilityStatus(abilityAnswer() ?? {}, rolls.abilities).overBudget) {
      throw new Error(t("Creation.PointBuyOverCommit", "Point Buy spends more than 27 points. Lower some scores on the Abilities tab."));
    }
    const review = await controller.review();
    if (review.blockers.length) throw new Error(t("Creation.Unfinished", "Finish the highlighted tabs first."));
    return review;
  }

  /** Phase 4b: the actor an earlier Approve of this very submission already made (its finish write failed), or null. */
  const madeFrom = approvalOf => {
    const actor = game.actors?.find?.(a => a.getFlag?.(moduleId, "approvalOf") === approvalOf);
    if (!actor) return null;
    const log = actor.getFlag(moduleId, "changeLog") ?? [];
    return { actor, entry: log.find(e => e.approvalOf === approvalOf) ?? log.find(e => e.kind === "creation") ?? log[0] };
  };

  /**
   * Make the actor. With `approvedBy` (the GM's Approve): `approvalOf` stamps the actor, and an actor already stamped with
   * it is not made again (only the finish runs); `assertClaim` checks the claim once more just before; the player's
   * result lands in the same update that removes the draft (one update, so the player's open wizard sees both at once).
   */
  async function create({ author = user, approvedBy = null, approvalOf = null, assertClaim = null } = {}) {
    if (!canCreate()) throw new Error(t("Approval.CantCreate", "You can't create actors in this world."));
    let made = approvalOf ? madeFrom(approvalOf) : null;
    if (!made) {
      const review = await readyReview();
      assertClaim?.();
      // Looked up again after the (slow) review and the last claim check: the latest moment before the actor is made.
      made = approvalOf ? madeFrom(approvalOf) : null;
      made ??= await commitCreation(full, draft, { moduleId, groups: review.groups, t, game, author, approvedBy, approvalOf });
    }
    const { actor, entry } = made;
    // The actor exists: from here on, nothing may create it a second time.
    draft = null; full = null; shown = null; rolls = emptyRolls(); cache = createReplayCache();
    try {
      if (approvedBy) await store.finishCreationWith(resultKey("creation"), approvalResult({ kind: "creation", actor, entry, by: approvedBy }));
      else await store.finishCreation();
    } catch (error) {
      console.warn(`${moduleId} | the character was created, but its draft could not be cleared`, error);
      if (approvedBy) globalThis.ui?.notifications?.error?.(t("Approval.FinishFailed", "{name} was saved, but {player}'s request could not be cleared. Approve it again later to finish.",
        { name: actor.name, player: user.name }));
    }
    return { actor: { id: actor.id, name: actor.name, uuid: actor.uuid }, entry };
  }

  const controller = {
    isGM,
    actorName: t("Creation.Title", "New character"),
    canCreate,

    home() {
      return { draft: draft ? { name: draft.tabs.details?.name ?? "", updated: draft.updated ?? 0, status: statusOf(draft), rejectReason: draft.rejectReason ?? "" } : null, isGM,
        players: isGM ? game.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name })) : [] };
    },
    async start({ owner = null } = {}) {
      // Only a GM working on their own draft creates for someone else.
      draft = emptyDraft({ owner: (isGM && user === game.user && owner) || user.id });
      await refresh();
      await save();
      return controller.tabs();
    },
    async resume() {
      if (!draft) return null;
      await refresh();
      await save();
      return controller.tabs();
    },
    /** Start over: the draft goes; rolls stay (spec §2.4: no new rolls by starting again). */
    async discard() {
      if (readOnly) throw new Error("This draft is read-only here.");
      // A GM page that died mid-approval (a stale claim) doesn't lock the player out.
      const stored = store.creation();
      if (isWaiting(stored) && !claimIsStale(stored, serverNow(game))) throw new Error(t("Approval.WithdrawFirst", "Withdraw it from your GM first."));
      await store.clearCreation(); draft = null; full = null; shown = null; cache = createReplayCache();
    },
    hasDraft: () => Boolean(draft),

    /** { class: "todo"|"attention"|"done"|"hidden", … } */
    tabs() {
      const status = abilityStatus(abilityAnswer() ?? {}, rolls.abilities);
      return tabStates(draft, { missing: full?.missing ?? [], hasSpells: Boolean(spellsEntry()),
        abilitiesDone: status.complete, abilitiesUnspent: status.unspent > 0, equipmentDone: Boolean(full?.equipmentDone) });
    },

    /* ---- Class, Background, Species, Spells ---- */

    async options(tab) {
      // Subtitle: the book ("PHB 2024", "FRHoF", "SRD 5.2"), else the compendium, so same-named options from different
      // books tell themselves apart. The same item in several packs is one card (findEntries keeps the GM's top pack).
      const subtitle = c => c.book || c.packLabel;
      const plain = list => list.map(c => ({ uuid: c.uuid, name: c.name, img: c.img, source: subtitle(c), book: c.book ?? "", pack: c.packLabel, tier: c.tier ?? null }));
      if (tab === "class") return plain(await findClasses());
      if (tab === "background") return plain(await findBackgrounds());
      return groupSpecies((await findSpecies()).map(c => ({ ...c, packLabel: subtitle(c) })));
    },
    async pickScreen(tab) {
      return { tab, screen: "pick", options: await controller.options(tab), current: draft.tabs[tab]?.uuid ?? null };
    },
    /** screen: "pick" | "step" | "done" | "blocked" | "none" | "error" */
    async segment(tab, stopAt) {
      const segTab = tab === "spells" ? "class" : tab;
      const pick = draft.tabs[segTab];
      if (!pick?.uuid) return tab === "spells" ? { tab, screen: "blocked" } : controller.pickScreen(tab);
      if (tab === "spells" && stopAt === undefined) {
        const entry = spellsEntry();
        if (!entry) return { tab, screen: "none" };
        stopAt = entry.index;
      }
      shown = await runCreation(draft, { focus: { tab, stopAt }, methods: methods(), rolls, cache });
      const seg = shown.focused;
      const item = await card(pick.uuid);
      if (seg?.unavailable) return { tab, screen: "error", item, error: t("Creation.Unavailable", "No longer available. Choose again.") };
      if (seg?.error) return { tab, screen: "error", item, error: seg.error.message ?? String(seg.error) };
      const session = seg.session;
      const pending = session.pending;
      // Spec §2.3: older species' own ability increases are skipped under 2024 rules; say so.
      // An older (2014) background has no increase of its own; say so rather than look silently finished.
      const note = segTab === "species" && session.skipped?.some(s => s.type === "AbilityScoreImprovement")
        ? t("Creation.SpeciesAsi", "Ability increases come from your background (2024 rules).")
        : segTab === "background" && (await backgroundWithoutAsi(pick.uuid))
          ? t("Creation.BackgroundNoAsi", "This background has no ability score increase.") : "";
      if (tab === "spells") {
        if (!pending) return { tab, screen: "none" };
        if (pending.type !== "Spells") return { tab, screen: "blocked", item };
      } else if (!pending || (tab === "class" && pending.type === "Spells")) {
        return { tab, screen: "done", item, note, canBack: answeredSteps(segTab, session) > 0 };
      }
      const model = await stepModel(session);
      // Data fix 4: a saved pick another tab now grants re-opens its step; say why (the options already leave it out).
      if (model.conflicts?.length) model.conflictText = conflictText({ title: model.title, conflicts: model.conflicts });
      // A saved answer the last full replay refused (and dropped) is asked again with the reason (e.g. a spell off the list
      // a background's Magic Initiate is locked to).
      const refused = (full?.missing ?? []).find(m => m.rejected && m.key === pending.key && m.error)?.error ?? "";
      return { tab, screen: "step", item, note, model, error: session.error?.message || refused, canBack: true };
    },
    async pick(tab, uuid) {
      edit();
      const result = setPick(draft, tab, uuid);
      draft = result.draft;
      await refresh();
      await save();
      return { ...(await controller.segment(tab)), cleared: result.cleared };
    },
    async answer(tab, data, meta) {
      edit();
      const pending = shown?.focused?.session?.pending;
      if (!pending) throw new Error("No step is waiting for an answer.");
      const segTab = tab === "spells" ? "class" : tab;
      draft.tabs[segTab].answers[pending.index] = { key: pending.key, data, meta: meta ?? null };
      await refresh();
      await save();
      if (tab === "spells") return { tab, screen: "answered" };
      return controller.segment(tab, pending.index + 1);
    },
    async back(tab) {
      const segTab = tab === "spells" ? "class" : tab;
      const session = shown?.focused?.session;
      const pending = session?.pending;
      // On the Class tab's "done" screen the pending step may be the spell step (or none, once spells are answered):
      // step back to the last class step, not into the spell step.
      const at = pending && !(segTab === "class" && pending.type === "Spells") ? pending.index : answeredSteps(segTab, session);
      if (at <= 0) return controller.pickScreen(segTab);
      return controller.segment(segTab, at - 1);
    },

    /* ---- Abilities ---- */

    abilities() {
      const rules = currentHouseRules(game);
      const allowed = methodsAllowed(rules);
      const answer = abilityAnswer() ?? { method: allowed[0], assignments: {}, pointBuy: draft.tabs.abilities?.pointBuy ?? {}, entered: draft.tabs.abilities?.entered ?? [] };
      const base = baseScores(answer, rolls.abilities);
      const bonus = backgroundBonus();
      const identifier = classIdentifier();
      return {
        methods: allowed.map(m => ({ key: m, label: label(METHOD_LABELS[m]) })), answer, base, bonus, final: finalScores(base, bonus),
        labels: abilityLabels(), slots: slotValues(answer, rolls.abilities), rolled: slotValues({ method: "roll" }, rolls.abilities),
        pointBuy: answer.method === "pointBuy" ? pointBuyState(answer.pointBuy) : null,
        suggested: Boolean(SUGGESTED_ARRAY[identifier]), classIdentifier: identifier,
        rolls: { rolled: rolls.abilities.sets.length > 0, rerollsLeft: rerollsLeft(rules, rolls.abilities), sets: rolls.abilities.sets.length }
      };
    },
    /** The answer on screen, before its debounced save: the tab strip follows the method at once. */
    previewAbilities(answer) { if (draft && !isWaiting(draft)) draft.tabs.abilities = answer; },
    async setAbilities(answer) {
      if (!draft) return null; // a debounced save after commit or Start over
      edit();
      draft.tabs.abilities = answer;
      // Performance: no replay under 2024 rules, where scores change no step, pick or option (tab states, equipment and
      // the spell counts don't read them); everything that shows the copy (Review, Create, a step screen) replays
      // first. Under 2014 rules (the world's, or the picked class's own, e.g. a 2024 world allowing both editions)
      // prepared-spell counts follow the casting ability's modifier, so the Spells tab replays.
      if (worldRules(game) === "2014" || (await classRules()) === "2014") await refresh();
      await save();
      return controller.abilities();
    },
    async rollAbilities() {
      edit();
      const rules = currentHouseRules(game);
      if (!methodsAllowed(rules).includes("roll")) throw new Error(t("Abilities.RollOff", "Rolling isn't allowed in this world."));
      const reroll = rolls.abilities.sets.length > 0;
      if (reroll && !rerollsLeft(rules, rolls.abilities)) throw new Error(t("Abilities.NoRerolls", "No rerolls left."));
      const dice = [];
      for (let i = 0; i < 6; i++) dice.push(await new globalThis.Roll("4d6kh3").evaluate());
      const values = dice.map(r => Number(r.total));
      const verb = reroll ? t("Abilities.Rerolled", "rerolled") : t("Abilities.Rolled", "rolled");
      const messageId = await chat(`<p><strong>${esc(game.user.name)}</strong> ${verb} ability scores (4d6, drop the lowest): <strong>${values.join(", ")}</strong></p>`,
        { rolls: dice, sound: globalThis.CONFIG.sounds?.dice });
      // Saved at once: the set is locked in, and switching method, Start over or reopening never rolls again.
      const a = rolls.abilities;
      rolls = { ...rolls, abilities: { sets: [...a.sets, values], rerollsUsed: a.rerollsUsed + (reroll ? 1 : 0), messageIds: [...a.messageIds, messageId] } };
      await saveRolls(); // the lock first, before anything else can fail
      draft.tabs.abilities = { ...(draft.tabs.abilities ?? {}), method: "roll", assignments: {} };
      await refresh();
      await save();
      return controller.abilities();
    },
    async enterDice(values) {
      edit();
      const numbers = values.map(v => (v === "" || v === null ? NaN : Number(v)));
      if (validateEntered(numbers).length) throw new Error(t("Abilities.EnteredRange", "Enter six whole numbers from 3 to 18."));
      const messageId = await chat(`<p><strong>${esc(game.user.name)}</strong> ${t("Abilities.EnteredChat", "entered ability scores from physical dice")}: <strong>${numbers.join(", ")}</strong></p>`);
      draft.tabs.abilities = { ...(draft.tabs.abilities ?? {}), method: "manual", entered: numbers, assignments: {}, messageId };
      await refresh();
      await save();
      return controller.abilities();
    },

    /* ---- Equipment ---- */

    async equipment() {
      const table = await trinketTable();
      return { sections: full?.sections ?? await equipmentSections(), trinket: rolls.trinket,
        // The table the trinket comes from: the background's own (DDB / homebrew), else the PHB's.
        trinketTable: table ? { uuid: table.uuid, name: table.name, own: table.uuid !== TRINKETS_TABLE } : null,
        notFound: full?.equipment?.notFound ?? [] };
    },
    async setEquipment(source, answer) {
      edit();
      const item = full?.final?.items.find(i => i.type === source);
      const gold = item ? itemEquipmentOptions(item).find(o => o.kind === "gold") : null;
      // A dice formula is rolled once per class or background and kept with the rolls (by its uuid). The roll comes
      // first: if it fails, the draft and the last replay are left as they were.
      const key = draft.tabs[source]?.uuid;
      if (gold && key && answer.option === gold.id && gold.gp === null && !rolls.gold[key]) {
        const roll = await new globalThis.Roll(gold.formula).evaluate();
        const value = Number(roll.total);
        if (!Number.isFinite(value)) throw new Error(t("Equipment.GoldRollFailed", "The starting gold roll gave no number."));
        const messageId = await chat(`<p><strong>${esc(game.user.name)}</strong> ${t("Equipment.GoldChat", "rolled starting gold for {name}", { name: esc(item.name) })}: <strong>${value} GP</strong></p>`, { rolls: [roll] });
        rolls = { ...rolls, gold: { ...rolls.gold, [key]: { value, messageId } } };
        await saveRolls();
      }
      draft.tabs.equipment = { ...(draft.tabs.equipment ?? {}), [source]: answer };
      await refresh();
      await save();
      return controller.equipment();
    },
    async rollTrinket() {
      edit();
      if (rolls.trinket) return controller.equipment();
      const table = await trinketTable();
      if (!table) throw new Error(t("Equipment.NoTrinkets", "The Trinkets table isn't available."));
      const { results } = await table.roll();
      const result = results?.[0];
      const text = stripHtml(result?.description || result?.name || result?.text || "");
      const messageId = await chat(`<p><strong>${esc(game.user.name)}</strong> ${t("Equipment.TrinketChat", "rolled a trinket")}: ${esc(text)}</p>`);
      rolls = { ...rolls, trinket: { text, messageId } };
      await saveRolls(); // the lock first
      await refresh();
      await save();
      return controller.equipment();
    },

    /* ---- Details ---- */

    detailsTab() {
      const alignments = Object.entries(globalThis.CONFIG.DND5E.alignments ?? {}).map(([key, value]) => ({ key, label: game.i18n.localize(value?.label ?? value) }));
      return { ...draft.tabs.details, alignments };
    },
    async setDetails(details) {
      if (!draft) return null; // a debounced save after commit or Start over
      edit();
      // No replay: the Details tab state reads the draft, and Review replays anyway.
      draft.tabs.details = { name: String(details.name ?? ""), alignment: String(details.alignment ?? ""), biography: String(details.biography ?? "") };
      await save();
      return controller.detailsTab();
    },

    /* ---- Review and commit ---- */

    async review() {
      await refresh();
      const before = builderSnapshot(full.blank);
      const after = builderSnapshot(full.final);
      const stepOf = { hp: "class", size: "species", level: "class" };
      for (const id of Object.keys(after.classes)) { stepOf[`class:${id}`] = "class"; stepOf[`subclass:${id}`] = "class"; }
      for (const tab of ["background", "species", "class"]) {
        for (const a of draft.tabs[tab]?.answers ?? []) {
          for (const key of a?.data?.chosen ?? []) {
            const [trait, ...rest] = String(key).split(":");
            if (trait === "skills") stepOf[`skill:${rest.at(-1)}`] ??= tab;
            if (trait === "saves") stepOf[`save:${rest.at(-1)}`] ??= tab;
          }
          const picked = new Set([a?.data?.uuid, ...(a?.data?.selected ?? [])].filter(Boolean));
          for (const item of after.items) if (item.source && picked.has(item.source)) stepOf[`item:${item.id}`] ??= tab;
        }
      }
      const spellPath = spellsEntry();
      const spellAnswer = spellPath ? draft.tabs.class.answers.find(a => a?.key === spellPath.key) : null;
      const spells = spellPath ? { step: "spells", spellbookClass: Boolean(spellPath.extra?.owed?.spellbookClass),
        swaps: spellAnswer?.data?.swaps ?? [], warnings: spellPath.extra?.warnings ?? [], freed: spellPath.extra?.freed ?? [] } : null;
      // L20 fixes: each segment's "Check these" notes (feat spells, grants not found, GM data warnings), linked to its tab.
      const notes = Object.values(full.segments ?? {}).flatMap(seg => (seg?.session?.manager ? sessionNotes(seg.session, t) : [])
        .map(n => ({ ...n, key: `${seg.tab}:${n.key}`, step: seg.tab })));
      // Creation has its own ability group (base + bonus = final); drop the generic "10 → 17" one.
      const groups = reviewChanges(before, after, { stepOf, t, spells, notes }).filter(g => g.id !== "abilities");
      // A new character starts at level 1; level-up's "Character level 0 → 1" reads oddly here.
      const levelLine = groups.find(g => g.id === "level")?.lines.find(l => l.key === "level");
      if (levelLine) levelLine.text = t("Creation.Review.Level", "Level {level}", { level: after.level });
      const answer = abilityAnswer() ?? {};
      const base = baseScores(answer, rolls.abilities);
      const bonus = backgroundBonus();
      // Every set rolled since the last Create is listed (it is also in chat), whatever method is used now.
      groups.unshift(abilityGroup({ method: label(METHOD_LABELS[answer.method ?? "standardArray"]), labels: abilityLabels(), base, bonus,
        final: finalScores(base, bonus), sets: rolls.abilities.sets,
        entered: answer.method === "manual" ? answer.entered : null }, t));
      const sections = full.sections;
      groups.push({ id: "equipment", title: t("Creation.Review.Equipment", "Starting equipment"), lines: [
        ...sections.filter(s => !s.missing).map(s => {
          const o = s.options.find(x => x.id === s.option);
          const gold = o?.kind === "gold" ? rolls.gold[draft.tabs[s.source]?.uuid] : null;
          if (s.empty) return { key: `equipment:${s.source}`, kind: "note", step: "equipment",
            text: t("Creation.Review.NoEquipmentListed", "{name}: no starting equipment listed", { name: s.item.name }) };
          return { key: `equipment:${s.source}`, kind: o ? "gain" : "warning", step: "equipment",
            text: !o ? t("Creation.Review.NoEquipment", "{name}: no option chosen", { name: s.item.name })
              : gold ? t("Creation.Review.GoldRolled", "{name}: {label}, rolled {value} GP (in chat)", { name: s.item.name, label: o.label, value: gold.value })
                : `${s.item.name}: ${o.label}` };
        }),
        ...(rolls.trinket ? [{ key: "equipment:trinket", kind: "gain", step: "equipment",
          text: t("Creation.Review.Trinket", "Trinket: {text}", rolls.trinket) }] : []),
        ...(full.equipment?.notFound ?? []).map(name => ({ key: `equipment:missing:${name}`, kind: "warning", step: "equipment",
          text: t("Creation.Review.NotFound", "Not found: {name}", { name }) }))
      ] });
      const d = draft.tabs.details;
      groups.push({ id: "details", title: t("Creation.Review.Details", "Details"), lines: [
        { key: "details:name", kind: d.name?.trim() ? "change" : "warning", step: "details",
          text: d.name?.trim() ? t("Creation.Review.Name", "Name: {name}", { name: d.name.trim() }) : t("Creation.Review.NoName", "No name yet") },
        ...(d.alignment ? [{ key: "details:alignment", kind: "change", step: "details", text: t("Creation.Review.Alignment", "Alignment: {alignment}", d) }] : [])
      ] });
      if (full.notices.length) groups.push({ id: "notices", title: t("Creation.Review.Notices", "Finish after creating"), lines: full.notices.map(n => ({
        key: `notice:${n.title}`, kind: "warning", step: n.tab, text: t("Creation.Review.Desktop", "Finish on desktop after creating: {title}", n) })) });
      const states = controller.tabs();
      const status = abilityStatus(answer, rolls.abilities);
      // Unspent point-buy points are a warning, like open spell picks; an over-budget buy blocks.
      const warnOnly = tab => tab === "spells" || (tab === "abilities" && status.complete && status.unspent > 0);
      const blockers = Object.entries(states).filter(([tab, s]) => tab !== "review" && !warnOnly(tab) && s !== "done" && s !== "hidden")
        .map(([tab]) => ({ tab, text: tab === "abilities" && status.overBudget ? t("Creation.PointBuyOver", "Abilities: Point Buy spends more than 27 points.")
          : t("Creation.Needs", "{tab}: not finished", { tab: label(TAB_LABELS[tab]) }) }));
      // Data fix 4: a tab whose only problem is a pick another tab now grants says exactly that.
      const conflicts = (full.missing ?? []).filter(m => m.kind === "conflict");
      const onlyConflicts = tab => conflicts.some(m => m.tab === tab) && full.missing.every(m => m.tab !== tab || m.kind === "conflict");
      blockers.splice(0, blockers.length, ...blockers.filter(b => !onlyConflicts(b.tab)),
        ...conflicts.map(m => ({ tab: m.tab, kind: "conflict", text: `${label(TAB_LABELS[m.tab])} · ${conflictText(m)}` })));
      const warnings = [
        ...(states.spells === "attention" ? [{ tab: "spells", text: t("Creation.SpellsOpen", "Spells: not chosen yet (you can finish at the table)") }] : []),
        ...(warnOnly("abilities") ? [{ tab: "abilities", text: t("Creation.PointsUnspent", "Abilities: {left} Point Buy points not spent", { left: status.unspent }) }] : [])
      ];
      return { groups, blockers, warnings, canCreate: canCreate(), name: d.name?.trim() ?? "", mode: mode(), status: statusOf(draft),
        rejectReason: draft.rejectReason ?? "", rejectedBy: draft.rejectedBy?.name ?? "", gmOnline: Boolean(game.users.activeGM) };
    },
    async commit() {
      if (mode() !== "create") throw new Error(t("Approval.SubmitInstead", "This character needs your GM's approval: submit it instead."));
      return create();
    },
    /** Spec §4.3: send the finished draft to the GM. */
    async submit() {
      if (readOnly) throw new Error("This draft is read-only here.");
      if (isWaiting(draft)) return controller.review();
      await readyReview();
      draft = asSubmitted(draft, serverNow(game));
      await store.saveCreation(draft);
      return controller.review();
    },
    /** Back to editing. Refused while a GM's client is saving it ("approving"); read from the flag, not memory. */
    async withdraw() {
      if (readOnly) throw new Error("This draft is read-only here.");
      const stored = store.creation();
      if (isWaiting(stored) && !canWithdraw(stored, serverNow(game))) throw new Error(t("Approval.Approving", "Your GM is approving this right now."));
      if (isWaiting(stored)) { draft = asDraft(stored); await store.saveCreation(draft); }
      return controller.review();
    },
    /** The stored draft again (the GM decided while the wizard was open). False when it is gone. */
    reload() {
      draft = store.creation();
      rolls = store.creationRolls();
      full = null; shown = null;
      return Boolean(draft);
    },
    status: () => ({ status: statusOf(draft), rejectReason: draft?.rejectReason ?? "", rejectedBy: draft?.rejectedBy?.name ?? "", submittedAt: draft?.submittedAt ?? 0 }),
    /** The GM's decision waiting for this user (approval-rules resultKey "creation"), or null. */
    result: () => store.results()[resultKey("creation")] ?? null,
    async clearResult() { if (!readOnly) await store.clearResult(resultKey("creation")); },
    /** The rolls the GM's client checks against their chat cards: the ability sets, and the rolled gold of the picked class / background. */
    rollRecords: () => rolls.abilities,
    goldRecords: () => ["class", "background"].map(tab => draft?.tabs[tab]?.uuid).filter(uuid => uuid && rolls.gold[uuid])
      .map(uuid => ({ uuid, ...rolls.gold[uuid] })),
    /** What the GM's client checks the picks against: each tab's pick and each segment's replayed steps with their answers. */
    picks: () => Object.fromEntries(["class", "background", "species"].map(tab => [tab, draft?.tabs[tab]?.uuid ?? null])),
    sessions: () => ["class", "background", "species"].map(tab => full?.segments?.[tab]?.session).filter(Boolean),
    /**
     * GM (spec §4.4): create the player's submitted character on this client, as theirs. This page claims it first
     * ("approving", by this page, now; only a submitted request or a stale claim can be claimed), waits, and goes on only
     * if the claim is still its own (one GM can be logged in on two pages); the claim is checked again right before the
     * actor is made, and dropped on failure. An actor already made from this submission is not made again.
     */
    async approve({ by = game.user } = {}) {
      if (!game.user.isGM) throw new Error(t("Approval.GmOnly", "Only a GM can approve."));
      const stored = store.creation();
      if (!sameSubmission(draft, stored)) throw new Error(t("Approval.Changed", "The player changed or withdrew this request."));
      if (!canClaim(stored, serverNow(game), pageId())) throw new Error(t("Approval.ClaimedElsewhere", "Another GM window is approving this right now."));
      const approvalOf = submissionId({ userId: user.id, key: resultKey("creation"), submittedAt: Number(stored.submittedAt) || 0 });
      await store.saveCreation(asApproving(stored, pageId(), serverNow(game)));
      const assertClaim = () => {
        const fresh = store.creation();
        if (!sameSubmission(draft, fresh)) throw new Error(t("Approval.Changed", "The player changed or withdrew this request."));
        if (!holdsClaim(fresh, pageId())) throw new Error(t("Approval.ClaimedElsewhere", "Another GM window is approving this right now."));
      };
      try {
        await new Promise(resolve => setTimeout(resolve, CLAIM_SETTLE_MS));
        assertClaim();
        return await create({ author: user, approvedBy: { id: by.id, name: by.name }, approvalOf, assertClaim });
      } catch (error) {
        if (holdsClaim(store.creation(), pageId())) await store.saveCreation(asUnclaimed(stored)).catch(() => {});
        throw error;
      }
    },

    /* ---- Shared with the level-up screens ---- */
    details: uuid => itemDetails(uuid),
    spellDetails: uuid => spellDetails(uuid),
    lockedRoll: () => null,
    rollHitPoints: () => { throw new Error("Level 1 hit points are automatic."); }
  };
  return controller;
}
