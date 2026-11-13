/**
 * Character Builder gateway (dnd5e). Owns the dnd5e level-up session and gives the
 * mobile screens (src/features/builder) a plain controller: view models in, answers out.
 * No Foundry documents cross into the presenter.
 */
import { MODULE_ID } from "../../../preferences.mjs";
import { createLevelUpSession } from "./advancement-driver.mjs";
import { commitSession, sessionReview } from "./commit.mjs";
import { configureSources, currentHouseRules, findClasses, preferredUuid } from "./content-sources.mjs";
import { registerBuilderSettings } from "./builder-settings.mjs";
import { createDraftStore } from "./draft-store.mjs";
import { multiclassBlockers } from "./asi-math.mjs";
import { builderSnapshot, classSummary } from "./snapshot.mjs";
import { itemDetails, stepModel } from "./step-model.mjs";
import { builderSpellSteps } from "./feature-spells.mjs";
import { spellDetails } from "./spell-details.mjs";
import { mountBuilder } from "../../../../features/builder/builder-layer.mjs";
import { createCreationController } from "./creation-controller.mjs";
import { mountCreator } from "../../../../features/builder/creation-layer.mjs";
import { approvalResult, asApproving, asDraft, asRejected, asSubmitted, asUnclaimed, canClaim, canWithdraw, holdsClaim, isWaiting, needsApproval, pageId,
  resultKey, sameSubmission, serverNow, statusOf, submissionId } from "./approval-rules.mjs";
import { CLAIM_SETTLE_MS } from "./creation-controller.mjs";
import { startApprovalWatcher } from "./approval-watcher.mjs";

export function t(key, fallback, data = {}) {
  const full = `VEMOBILE.Builder.${key}`;
  const i18n = globalThis.game?.i18n;
  const template = i18n?.has?.(full) ? i18n.localize(full) : fallback;
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (data[k] !== undefined ? String(data[k]) : m));
}

export function canLevelUp(actor, user = globalThis.game?.user) {
  return actor?.type === "character" && Boolean(actor.testUserPermission?.(user, "OWNER"));
}

/**
 * `user`: whose level-up draft this is (default: this client's user). Phase 4b: the GM's client opens a player's submitted
 * level-up with `user: <the player's User>, readOnly: true` and commits it on Approve.
 */
export function createBuilderController(actor, { moduleId = MODULE_ID, user = globalThis.game.user, readOnly = false } = {}) {
  const drafts = createDraftStore(moduleId, globalThis.game, user);
  let session = null;
  let loaded = null; // the stored draft resume() replayed (the GM checks it is still the same submission)
  const stored = () => drafts.draft(actor.id);
  const mode = () => (needsApproval("level-up", user, currentHouseRules()) ? "submit" : "commit");
  const assertEditable = () => {
    if (readOnly) throw new Error("This level-up is read-only here.");
    if (isWaiting(stored())) throw new Error(t("Approval.Locked", "Waiting for GM approval. Withdraw it to make changes."));
  };
  const maxLevel = () => Number(globalThis.CONFIG.DND5E.maxLevel) || 20;
  const abilityValues = () => Object.fromEntries(Object.entries(actor.system.abilities).map(([k, a]) => [k, Number(a.value) || 0]));
  const classTargetLabel = target => {
    if (target.kind === "level") {
      const cls = actor.items.get(target.classId);
      return cls ? `${cls.name} ${cls.system.levels} → ${cls.system.levels + 1}` : "";
    }
    return target.label ?? t("NewClass", "New class");
  };

  /**
   * A new class on a character that has one: "Allow multiclassing" and the 13+ prerequisites (house rules). A player is
   * refused (an Error); a GM may go ahead, and Review says what was overridden. Returns the Review notes.
   */
  async function multiclassNotes(target, { refuse = !globalThis.game.user.isGM } = {}) {
    if (target?.kind !== "new-class" || !Object.keys(actor.classes ?? {}).length) return [];
    const rules = currentHouseRules();
    const doc = await fromUuid(target.classUuid).catch(() => null);
    const problems = [];
    if (doc && actor.classes?.[doc.system?.identifier]) problems.push(t("Multiclass.Owned", "{name} already has {cls}.", { name: actor.name, cls: doc.name }));
    if (!rules.multiclass) problems.push(t("Multiclass.Off", "Multiclassing is switched off in this world's house rules."));
    else if (rules.multiclassPrerequisites && doc) {
      const current = Object.values(actor.classes ?? {}).map(c => ({ name: c.name, primaryAbility: Array.from(c.system.primaryAbility?.value ?? []),
        allRequired: c.system.primaryAbility?.all !== false }));
      const blockers = multiclassBlockers([...current, { name: doc.name, primaryAbility: Array.from(doc.system?.primaryAbility?.value ?? []),
        allRequired: doc.system?.primaryAbility?.all !== false }], abilityValues());
      for (const b of blockers) problems.push(t("Blocker.Multiclass", "{name} needs 13+ in {abilities}", { name: b.name, abilities: b.abilities.map(a => a.toUpperCase()).join(b.any ? " or " : " and ") }));
    }
    if (!problems.length) return [];
    if (refuse) throw new Error(t("Multiclass.Refused", "You can't take this class: {reasons}", { reasons: problems.join(" ") }));
    return problems.map((text, i) => ({ key: `multiclass:${i}`, text: t("Multiclass.Override", "GM override: {text}", { text }) }));
  }

  async function view() {
    if (session.pending) {
      const model = await stepModel(session);
      return { screen: "step", model, canBack: session.pending.index > 0, error: session.error?.message ?? "",
        heading: classTargetLabel(session.target), steps: session.path.length };
    }
    const { before, after, groups } = sessionReview(session, t);
    const draft = stored();
    return { screen: "review", groups, from: classSummary(before), to: classSummary(after), canBack: session.answers.length > 0,
      heading: classTargetLabel(session.target), mode: mode(), status: statusOf(draft), rejectReason: draft?.rejectReason ?? "",
      rejectedBy: draft?.rejectedBy?.name ?? "", gmOnline: Boolean(globalThis.game.users.activeGM) };
  }

  async function saveDraft() {
    if (readOnly) return;
    // Any change makes a rejected level-up a draft again; the GM's note (and who wrote it) stays until the next Submit.
    const { rejectReason, rejectedBy } = stored() ?? {};
    try {
      await drafts.saveDraft(actor.id, { ...session.draft(), label: classTargetLabel(session.target), status: "draft",
        ...(rejectReason ? { rejectReason, rejectedBy } : {}) });
    } catch (error) { console.warn(`${moduleId} | could not save the level-up draft`, error); }
  }

  return {
    actorName: actor.name,
    home() {
      const classes = Object.values(actor.classes ?? {}).map(cls => ({
        id: cls.id, name: cls.name, img: cls.img, levels: cls.system.levels, subclass: cls.subclass?.name ?? "", identifier: cls.identifier
      }));
      const level = Number(actor.system.details.level) || 0;
      const draft = drafts.draft(actor.id);
      const rules = currentHouseRules();
      return { name: actor.name, img: actor.img, level, classes, atMax: level >= maxLevel(),
        canAddClass: !classes.length || rules.multiclass,
        draft: draft ? { label: draft.label ?? "", answers: draft.answers?.length ?? 0, status: statusOf(draft), rejectReason: draft.rejectReason ?? "" } : null,
        locked: isWaiting(draft),
        isGM: Boolean(game.user.isGM) };
    },
    async newClassOptions() {
      const owned = new Set(Object.keys(actor.classes ?? {}));
      const current = Object.values(actor.classes ?? {}).map(c => ({ name: c.name,
        primaryAbility: Array.from(c.system.primaryAbility?.value ?? []), allRequired: c.system.primaryAbility?.all !== false }));
      const abilities = abilityValues();
      const multiclass = current.length > 0 && currentHouseRules().multiclassPrerequisites;
      return (await findClasses()).filter(c => !owned.has(c.system?.identifier)).map(c => ({
        uuid: c.uuid, name: c.name, img: c.img, source: c.packLabel, tier: c.tier ?? null,
        blockers: multiclass ? multiclassBlockers([...current, { name: c.name, primaryAbility: Array.from(c.system?.primaryAbility?.value ?? []),
          allRequired: c.system?.primaryAbility?.all !== false }], abilities) : []
      }));
    },
    async start(target) {
      assertEditable();
      // Fix 12: the multiclassing rules are the engine's, not only the class list's: a player is refused, a GM is warned.
      const notes = await multiclassNotes(target);
      session = createLevelUpSession(actor, target, [], { remapUuid: preferredUuid, extraSteps: builderSpellSteps });
      session.controllerNotes = notes;
      await session.start();
      await saveDraft();
      return view();
    },
    async resume() {
      const draft = drafts.draft(actor.id);
      if (!draft) return null;
      loaded = draft;
      session = createLevelUpSession(actor, draft.target, draft.answers ?? [], { remapUuid: preferredUuid, extraSteps: builderSpellSteps });
      session.controllerNotes = await multiclassNotes(draft.target, { refuse: false });
      await session.resume();
      return view();
    },
    async discardDraft() { assertEditable(); await drafts.clearDraft(actor.id); session = null; },
    async answer(data, meta) { assertEditable(); await session.answer(data, meta); await saveDraft(); return view(); },
    async back() { await session.back(); return view(); },
    async edit(index) { await session.edit(index); return view(); },
    lockedRoll(model) { return drafts.lockedRoll(actor.id, model.classIdentifier, model.level); },
    rollHitPoints(model) {
      if (readOnly) throw new Error("This level-up is read-only here.");
      return drafts.rollHitPoints({ actor, classIdentifier: model.classIdentifier, className: model.className, level: model.level, die: model.die });
    },
    async commit() {
      if (mode() === "submit") throw new Error(t("Approval.SubmitInstead", "This level-up needs your GM's approval: submit it instead."));
      const entry = await commitSession(session, { moduleId, t });
      await drafts.finish(actor.id);
      session = null;
      return entry;
    },
    /** Spec §4.3: send the finished level-up to the GM, with the level it starts from (the GM's client warns if it changed). */
    async submit() {
      assertEditable();
      if (!session || session.pending) throw new Error(t("Approval.NotReady", "Finish every step first."));
      await drafts.saveDraft(actor.id, asSubmitted({ ...session.draft(), label: classTargetLabel(session.target) }, serverNow(),
        { level: Number(actor.system.details.level) || 0 }));
      return view();
    },
    /** Back to editing; refused while a GM's client is saving it ("approving"). */
    async withdraw() {
      if (readOnly) throw new Error("This level-up is read-only here.");
      const draft = stored();
      // A claim older than two minutes is a GM page that died mid-way: it doesn't lock the player out.
      if (isWaiting(draft) && !canWithdraw(draft, serverNow())) throw new Error(t("Approval.Approving", "Your GM is approving this right now."));
      if (isWaiting(draft)) await drafts.saveDraft(actor.id, asDraft(draft));
      return session ? view() : null;
    },
    /** The stored draft (status, submittedAt, level), for the GM's checks. */
    submission: () => stored(),
    result: () => drafts.results()[resultKey("level-up", actor.id)] ?? null,
    async clearResult() { if (!readOnly) await drafts.clearResult(resultKey("level-up", actor.id)); },
    /**
     * What each HitPoints step of the replay applies (its answer's data.value) with its lock key and die, from the replayed
     * step itself (class, level, die); and this actor's locks on the player's flag. The GM's client checks them.
     */
    hpRolls: () => ({
      steps: (session?.path ?? []).filter(p => p.type === "HitPoints" && session.answers[p.index]?.key === p.key)
        .map(p => ({ value: session.answers[p.index].data?.value, key: `${actor.id}|${p.classIdentifier}|${p.level}`, die: p.die })),
      locks: drafts.locksFor(actor.id) }),
    /** The replayed steps and their answers (the GM's client checks ItemGrant / ItemChoice picks against what each offered). */
    sessions: () => (session ? [session] : []),
    /**
     * GM (spec §4.4): commit the player's submitted level-up on this client. This page claims it ("approving", by this page,
     * now; only a submitted request or a stale claim), waits, and goes on only if the claim is still its own (one GM can be
     * logged in on two pages). It then replays the reviewed answers on the actor as it is now, checks the claim once more and
     * commits. A level-up already in the actor's change log for this submission isn't committed again (only the finish
     * runs). Failure drops the claim; a commit that stopped partway sends the request back instead. The result and the
     * cleared draft and locks land in one update.
     */
    async approve({ by = globalThis.game.user } = {}) {
      if (!globalThis.game.user.isGM) throw new Error(t("Approval.GmOnly", "Only a GM can approve."));
      const before = stored();
      if (!sameSubmission(loaded, before)) throw new Error(t("Approval.Changed", "The player changed or withdrew this request."));
      if (!session || session.pending) throw new Error(t("Approval.Incomplete", "This level-up doesn't replay to the end on your client."));
      if (!canClaim(before, serverNow(), pageId())) throw new Error(t("Approval.ClaimedElsewhere", "Another GM window is approving this right now."));
      const key = resultKey("level-up", actor.id);
      const approvalOf = submissionId({ userId: user.id, key, submittedAt: Number(before.submittedAt) || 0 });
      const assertClaim = () => {
        const fresh = stored();
        if (!sameSubmission(loaded, fresh)) throw new Error(t("Approval.Changed", "The player changed or withdrew this request."));
        if (!holdsClaim(fresh, pageId())) throw new Error(t("Approval.ClaimedElsewhere", "Another GM window is approving this right now."));
      };
      await drafts.saveDraft(actor.id, asApproving(before, pageId(), serverNow()));
      let entry;
      try {
        await new Promise(resolve => setTimeout(resolve, CLAIM_SETTLE_MS));
        assertClaim();
        const committed = () => (actor.getFlag(moduleId, "changeLog") ?? []).find(e => e.approvalOf === approvalOf) ?? null;
        entry = committed();
        if (!entry) {
          // The review the popup showed may be older than the actor: replay the reviewed answers on the actor as it is now.
          session = createLevelUpSession(actor, loaded.target, loaded.answers ?? [], { remapUuid: preferredUuid, extraSteps: builderSpellSteps });
          await session.resume();
          if (session.pending) throw new Error(t("Approval.IncompleteNow", "This level-up no longer replays to the end on {name} (it stops at “{step}”). Send it back.",
            { name: actor.name, step: session.pending.title ?? "" }));
          assertClaim();
          // Looked up again after the replay and the last claim check: the latest moment before the commit.
          entry = committed() ?? await commitSession(session, { moduleId, t, author: user, approvedBy: { id: by.id, name: by.name }, approvalOf });
        }
      } catch (error) {
        if (error?.partial) {
          // Half saved: never back to "submitted" (a second Approve would apply it again on top). The player waits for the GM.
          const reason = t("Approval.Partial", "Saving stopped partway; your GM will check the sheet.");
          await drafts.saveDraft(actor.id, asRejected(stored() ?? before, reason, { id: by.id, name: by.name })).catch(() => {});
          globalThis.ui?.notifications?.error?.(t("Approval.PartialGm", "The level-up of {name} stopped partway: check the sheet. {error}", { name: actor.name, error: error.message ?? "" }));
        } else if (holdsClaim(stored(), pageId())) await drafts.saveDraft(actor.id, asUnclaimed(before)).catch(() => {});
        throw error;
      }
      session = null;
      try { await drafts.finishLevelUpWith(actor.id, key, approvalResult({ kind: "level-up", actor, entry, by })); }
      catch (error) {
        console.warn(`${moduleId} | the level-up was committed, but the player's draft could not be cleared`, error);
        globalThis.ui?.notifications?.error?.(t("Approval.FinishFailedLevel", "{name}'s level-up was saved, but {player}'s request could not be cleared. Approve it again later to finish.",
          { name: actor.name, player: user.name }));
      }
      return entry;
    },
    history() { return actor.getFlag(moduleId, "changeLog") ?? []; },
    details: uuid => itemDetails(uuid),
    /** The current screen again (the spell step's Retry). */
    current: () => view(),
    /** Record for Mobile Deck's own item detail window (spells in the picker). */
    spellDetails: uuid => spellDetails(uuid),
    /** Hand this level-up to dnd5e's own window (for advancement types we can't draw). */
    async openNativeWindow() {
      assertEditable();
      // dnd5e's own window saves directly, so in approval mode it would bypass the GM.
      if (mode() === "submit") throw new Error(t("Approval.NativeNeedsGm", "This step needs dnd5e's own window, which saves without approval. Ask your GM to finish this level-up."));
      const target = session?.target;
      session = null;
      await drafts.clearDraft(actor.id);
      if (target?.kind === "level") {
        const manager = globalThis.dnd5e.applications.advancement.AdvancementManager.forLevelChange(actor, target.classId, 1);
        if (manager.steps.length) manager.render(true);
      } else if (target?.kind === "new-class") {
        const doc = await fromUuid(target.classUuid);
        if (doc) await actor.createEmbeddedDocuments("Item", [game.items.fromCompendium(doc)]);
      }
    },
    snapshot: () => builderSnapshot(actor)
  };
}

/** The gateway Mobile Deck's kernel calls; one builder layer at a time. */
export function createBuilderGateway({ moduleId = MODULE_ID } = {}) {
  let current = null;
  // Each open takes a token; an open that had to wait (the creator, for the previous layer's last save)
  // mounts only if no later open or close came in meanwhile. `closing` is the previous layer's close.
  let token = 0;
  let closing = Promise.resolve();
  const closeCurrent = () => {
    const previous = current;
    current = null;
    if (previous) closing = Promise.resolve(previous.close()).catch(error => console.warn(`${moduleId} | builder close failed`, error));
    return closing;
  };
  const host = () => document.querySelector(".ve-mobile-app") ?? document.body;
  configureSources(moduleId);
  registerBuilderSettings(moduleId);
  // Phase 4b: the active GM's client shows players' submissions (desktop or VE); every client registers, only that one acts.
  startApprovalWatcher({ moduleId, t, levelUpController: createBuilderController });
  return Object.freeze({
    open({ actorSourceUuid } = {}) {
      const actor = globalThis.fromUuidSync?.(String(actorSourceUuid ?? ""));
      if (!canLevelUp(actor)) throw new Error(t("NotAllowed", "You can only level up characters you own."));
      token++;
      closeCurrent();
      const layer = mountBuilder(host(), createBuilderController(actor, { moduleId }), { t, onClose: () => { if (current === layer) current = null; } });
      current = layer;
      return true;
    },
    /**
     * Phase 4a: the character-creation wizard (every user; saving needs "Create New Actors" until 4b).
     * A creator still open is closed first, and its last debounced save lands before the new one reads the draft.
     * Returns false when a later open or close overtook this one while it waited.
     */
    async openCreator() {
      const mine = ++token;
      await closeCurrent();
      if (mine !== token) return false;
      const layer = mountCreator(host(), createCreationController({ moduleId, t }), { t, onClose: () => { if (current === layer) current = null; } });
      current = layer;
      return true;
    },
    close() { token++; closeCurrent(); },
    isOpen: () => Boolean(current)
  });
}
