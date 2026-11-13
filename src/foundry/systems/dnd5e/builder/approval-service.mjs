/**
 * Phase 4b, GM side (spec §4.4, §4.5): the players' submissions, each opened as a review model rebuilt on this client,
 * then approved (the controllers commit, as the player, approved by this GM) or rejected with a reason.
 * The level-up controller factory is passed in (builder-gateway.mjs owns it), which avoids an import cycle.
 *
 * Everything in a submission sits in the player's own User flag, which they can edit, so open() checks what the player
 * wrote before the replay uses it: the level-up target, the creation picks (type, visible to the player), picks outside a
 * step's own list, and each roll against its chat card. A blocker disables Approve; a warning is for the GM to judge.
 */
import { createCreationController } from "./creation-controller.mjs";
import { createDraftStore } from "./draft-store.mjs";
import { currentHouseRules, isAllowedUuid, preferredUuid } from "./content-sources.mjs";
import { isBanned } from "./source-filter.mjs";
import { multiclassBlockers } from "./asi-math.mjs";
import { esc } from "./commit.mjs";
import { asRejected, checkGoldRolls, checkHpRolls, checkLevelUpTarget, checkRollCount, checkRolledSets, claimedElsewhere, collectSubmissions, pageId,
  sameSubmission, serverNow, submissionId } from "./approval-rules.mjs";

/** The document type each creation tab picks, and its tab label. */
const PICK_TYPES = Object.freeze({ class: ["class", "Tab.Class", "Class"], background: ["background", "Tab.Background", "Background"], species: ["race", "Tab.Species", "Species"] });

export function createApprovalService({ moduleId, t, game = globalThis.game, levelUpController, creationController = createCreationController }) {
  const players = () => game.users.filter(u => !u.isGM).map(u => ({ id: u.id, name: u.name, isGM: u.isGM, builder: u.getFlag(moduleId, "builder") ?? null }));
  const lookup = id => {
    const message = game.messages.get(id);
    return message ? { authorId: message.author?.id ?? message.user?.id ?? "", totals: (message.rolls ?? []).map(r => Number(r.total)) } : null;
  };
  const PROBLEM = {
    missing: ["Approval.CheckMissing", "its chat card is gone"],
    author: ["Approval.CheckAuthor", "its chat card was posted by someone else"],
    totals: ["Approval.CheckTotals", "its chat card shows different numbers"],
    unlocked: ["Approval.CheckUnlocked", "no locked roll matches it"],
    invalid: ["Approval.CheckInvalid", "it is neither the average nor a roll of the hit die"]
  };
  const problem = key => t(PROBLEM[key][0], PROBLEM[key][1]);
  const line = text => ({ text });
  /** A warning from the GM's own checks (rolls, HP, picks, prerequisites, level): auto-approve stops on these, not on the Review's soft notes. */
  const checked = text => ({ text, check: true });
  const nameOf = async uuid => {
    let doc = null;
    try { doc = globalThis.fromUuidSync?.(uuid, { strict: false }) ?? null; } catch { doc = null; }
    doc ??= await globalThis.fromUuid(uuid).catch(() => null);
    return doc?.name ?? uuid;
  };
  /** World documents the player may see; compendium documents in a pack the player may open (Foundry 14 pack ownership). */
  const visibleTo = (doc, user) => {
    if (doc.pack) return Boolean(game.packs.get(doc.pack)?.testUserPermission?.(user, "OBSERVER"));
    return Boolean(doc.testUserPermission?.(user, "LIMITED"));
  };

  /** Creation picks: each tab's document exists, has its tab's type, the player can see it; a class isn't banned. */
  async function pickBlockers(picks, user) {
    const rules = currentHouseRules(game);
    const blockers = [];
    for (const [tab, [type, key, fallback]] of Object.entries(PICK_TYPES)) {
      const uuid = picks[tab];
      if (!uuid) continue; // a missing pick is a Review blocker already
      const doc = await globalThis.fromUuid(uuid).catch(() => null);
      const label = t(key, fallback);
      if (!doc || doc.type !== type) blockers.push(line(t("Approval.PickWrong", "{tab}: the saved pick isn't a {kind} ({name}).", { tab: label, kind: label.toLowerCase(), name: doc?.name ?? uuid })));
      else if (!visibleTo(doc, user)) blockers.push(line(t("Approval.PickHidden", "{tab}: {player} can't see {name}.", { tab: label, player: user.name, name: doc.name })));
      else if (tab === "class" && isBanned(doc, rules)) blockers.push(line(t("Approval.PickBanned", "{name} is banned in the House Rules.", { name: doc.name })));
    }
    return blockers;
  }

  /** ItemGrant / ItemChoice answers that select something the step didn't offer (the replay's path entries carry `offered`). */
  async function offListPicks(sessions) {
    const warnings = [];
    for (const session of sessions) {
      for (const entry of session.path ?? []) {
        const answer = session.answers?.[entry.index];
        if (!entry.offered || answer?.key !== entry.key) continue;
        const selected = Array.isArray(answer.data?.selected) ? answer.data.selected : [];
        if (!selected.length) continue;
        const { items = [], pool = [], itemType = "", restriction = {} } = entry.offered;
        const outside = [];
        // The list the picker offered (step-model.mjs): a grant's items as their allowed copies (content-sources
        // preferredUuid); a choice's pool items whose allowed copy the GM's sources allow. A choice whose pool has none
        // left falls back, as the picker does, to the spell lists or feats of the restriction's type.
        const listed = [];
        if (entry.type === "ItemGrant") {
          for (const uuid of items) listed.push(uuid, await preferredUuid(uuid, game).catch(() => uuid));
        } else {
          for (const uuid of pool) {
            const copy = await preferredUuid(uuid, game).catch(() => uuid);
            if (await isAllowedUuid(copy, game).catch(() => false)) listed.push(uuid, copy);
          }
        }
        if (listed.length || entry.type === "ItemGrant") {
          const allowed = new Set(listed);
          outside.push(...selected.filter(uuid => !allowed.has(uuid)));
        } else {
          // No pool (or none of it allowed): spells from dnd5e's spell lists (spell-choice.mjs), feats of the restriction's type (step-model.mjs).
          for (const uuid of selected) {
            const doc = await globalThis.fromUuid(uuid).catch(() => null);
            const ok = doc && (itemType === "spell" ? doc.type === "spell"
              : itemType === "feat" ? doc.type === "feat" && (!restriction.type || doc.system?.type?.value === restriction.type)
                && (!restriction.subtype || doc.system?.type?.subtype === restriction.subtype) : false);
            if (!ok) outside.push(uuid);
          }
        }
        for (const uuid of outside) warnings.push(checked(t("Approval.OffList", "{step}: picked outside its list: {name}", { step: entry.title, name: await nameOf(uuid) })));
      }
    }
    return warnings;
  }

  /** The level-up target the player wrote: blockers, and multiclass prerequisites as a warning (spec: the GM may allow it). */
  async function targetChecks(actor, target, user) {
    const rules = currentHouseRules(game);
    const classes = Object.values(actor.classes ?? {});
    const doc = target?.kind === "new-class" ? await globalThis.fromUuid(String(target.classUuid ?? "")).catch(() => null) : null;
    const key = checkLevelUpTarget(target, { classIds: classes.map(c => c.id), identifiers: classes.map(c => c.identifier),
      level: Number(actor.system.details.level) || 0, maxLevel: Number(globalThis.CONFIG.DND5E.maxLevel) || 20, rules, doc });
    const TEXT = {
      kind: ["Approval.TargetKind", "This request isn't a level-up Mobile Deck makes."],
      class: ["Approval.TargetClass", "{name} has no such class."],
      max: ["Approval.TargetMax", "{name} is already at the maximum level."],
      multiclass: ["Approval.TargetMulticlass", "Multiclassing is off in the House Rules."],
      notClass: ["Approval.TargetNotClass", "The new class can't be found."],
      banned: ["Approval.TargetBanned", "{class} is banned in the House Rules."],
      owned: ["Approval.TargetOwned", "{name} already has {class}."]
    };
    if (key) return { blockers: [line(t(TEXT[key][0], TEXT[key][1], { name: actor.name, class: doc?.name ?? "" }))], warnings: [] };
    if (doc && !visibleTo(doc, user)) return { blockers: [line(t("Approval.PickHidden", "{tab}: {player} can't see {name}.", { tab: t("Tab.Class", "Class"), player: user.name, name: doc.name }))], warnings: [] };
    const warnings = [];
    if (doc && classes.length && rules.multiclassPrerequisites) {
      const abilities = Object.fromEntries(Object.entries(actor.system.abilities).map(([k, a]) => [k, Number(a.value) || 0]));
      const primary = c => ({ name: c.name, primaryAbility: Array.from(c.system?.primaryAbility?.value ?? []), allRequired: c.system?.primaryAbility?.all !== false });
      for (const b of multiclassBlockers([...classes.map(primary), primary(doc)], abilities)) {
        warnings.push(checked(t("Approval.MulticlassShort", "Multiclass prerequisite not met: {name} needs 13+ in {abilities}", { name: b.name,
          abilities: b.abilities.map(a => a.toUpperCase()).join(b.any ? " or " : " and ") })));
      }
    }
    return { blockers: [], warnings };
  }

  async function openCreation(model, user, sub) {
    model.title = t("Approval.CreationTitle", "{player}: new character", { player: user.name });
    const gone = { ...model, blockers: [line(t("Approval.DraftGone", "The draft can't be read any more."))] };
    if (sub.invalid) return gone;
    const controller = creationController({ moduleId, t, game, user, readOnly: true });
    if (!controller.hasDraft()) return gone;
    // The picks first: the replay trusts them.
    const picked = await pickBlockers(controller.picks(), user);
    if (picked.length) return { ...model, controller, blockers: picked };
    if (!(await controller.resume())) return gone;
    const review = await controller.review();
    const rolls = controller.rollRecords();
    const checks = checkRolledSets(rolls, lookup, user.id).map(p => t("Approval.SetCheck", "Rolled set {n} ({values}): {problem}",
      { n: p.index + 1, values: (rolls.sets[p.index] ?? []).join(", "), problem: problem(p.problem) }));
    for (const p of checkRollCount(rolls, currentHouseRules(game))) {
      checks.push(p.problem === "tooMany" ? t("Approval.TooManySets", "{sets} ability sets were rolled; the House Rules allow {allowed}.", p)
        : t("Approval.RerollCount", "The reroll count ({used}) doesn't match the rolled sets (expected {expected}).", p));
    }
    for (const p of checkGoldRolls(controller.goldRecords(), lookup, user.id)) {
      checks.push(t("Approval.GoldCheck", "Starting gold {value} GP ({name}): {problem}", { value: p.value, name: await nameOf(p.uuid), problem: problem(p.problem) }));
    }
    return { ...model, controller, subtitle: review.name, groups: review.groups.filter(g => g.lines.length),
      lead: t("Approval.CreationLead", "{player} submitted a new character. Approve creates it on your client, owned by {player}.", { player: user.name }),
      blockers: review.blockers.map(b => line(b.text)),
      warnings: [...review.warnings.map(w => line(w.text)), ...checks.map(checked), ...(await offListPicks(controller.sessions()))] };
  }

  async function openLevelUp(model, user, sub) {
    const actor = game.actors.get(sub.actorId);
    model.title = t("Approval.LevelUpTitle", "{player}: level up {name}", { player: user.name, name: actor?.name ?? sub.label });
    if (!actor) return { ...model, blockers: [line(t("Approval.ActorGone", "This character no longer exists."))] };
    // The request sits in the player's own flag, which they can edit: never level up a character they don't own.
    if (!actor.testUserPermission(user, "OWNER")) return { ...model, blockers: [line(t("Approval.NotOwner", "{player} doesn't own {name}.", { player: user.name, name: actor.name }))] };
    if (actor.type !== "character") return { ...model, blockers: [line(t("Approval.NotCharacter", "{name} isn't a player character.", { name: actor.name }))] };
    const stored = createDraftStore(moduleId, game, user).draft(actor.id);
    if (!stored) return { ...model, blockers: [line(t("Approval.DraftGone", "The draft can't be read any more."))] };
    // The target first: the replay builds dnd5e's manager from it.
    const target = await targetChecks(actor, stored.target, user);
    if (target.blockers.length) return { ...model, blockers: target.blockers };
    const controller = levelUpController(actor, { moduleId, user, readOnly: true });
    const view = await controller.resume();
    if (!view) return { ...model, blockers: [line(t("Approval.DraftGone", "The draft can't be read any more."))] };
    if (view.screen !== "review") {
      return { ...model, controller, blockers: [line(t("Approval.IncompleteStep", "On your client this level-up stops at “{step}”. Send it back so the player can answer again.",
        { step: view.model?.title ?? "" }))] };
    }
    const warnings = [...target.warnings];
    const submitted = Number(controller.submission()?.level) || 0;
    const now = Number(actor.system.details.level) || 0;
    if (submitted && submitted !== now) warnings.push(checked(t("Approval.LevelChanged", "{name} was level {then} when this was submitted and is level {now} now.", { name: actor.name, then: submitted, now })));
    const hp = controller.hpRolls();
    for (const p of checkHpRolls(hp.steps, hp.locks, lookup, user.id)) {
      warnings.push(checked(t("Approval.HpCheck", "Hit point roll {value}: {problem}", { value: p.value, problem: problem(p.problem) })));
    }
    warnings.push(...(await offListPicks(controller.sessions())));
    return { ...model, controller, subtitle: `${view.from} → ${view.to}`, groups: view.groups,
      lead: t("Approval.LevelUpLead", "{player} submitted a level-up for {name}. Approve applies it on your client.", { player: user.name, name: actor.name }),
      warnings };
  }

  const service = {
    list: () => collectSubmissions(players()),
    /** Is this submission still waiting, unchanged? */
    current: sub => service.list().some(s => submissionId(s) === submissionId(sub)),
    find: id => service.list().find(s => submissionId(s) === id) ?? null,

    /** → { sub, title, subtitle, lead, groups, blockers, warnings, controller } */
    async open(sub) {
      const user = game.users.get(sub.userId);
      const model = { sub, title: "", subtitle: "", lead: "", groups: [], blockers: [], warnings: [], controller: null };
      if (!user) return { ...model, title: sub.userName, blockers: [line(t("Approval.UserGone", "This player no longer exists."))] };
      return sub.kind === "creation" ? openCreation(model, user, sub) : openLevelUp(model, user, sub);
    },

    /** A request open() failed on: only a blocker with the error, so the GM can still send it back or put it off. */
    failedModel(sub, error) {
      return { sub, title: t("Approval.FailedTitle", "{player}: a request", { player: sub.userName }), subtitle: sub.label ?? "", lead: "", groups: [], warnings: [],
        controller: null, blockers: [line(t("Approval.OpenFailed", "This request couldn't be opened on your client: {error}", { error: error?.message ?? String(error) }))] };
    },

    async approve(model) {
      if (model.blockers.length || !model.controller) throw new Error(t("Approval.Blocked", "This request can't be approved. Send it back instead."));
      return model.controller.approve({ by: game.user });
    },

    /**
     * Spec §4.4 Reject: the player's draft goes back with the reason, and the player gets a short whisper. A waiting
     * creation draft this version can't read (collectSubmissions `invalid`) is deleted instead, so it can't jam the queue.
     * Refused while another GM page holds a fresh claim on it.
     */
    async reject(model, reason) {
      const text = String(reason ?? "").trim();
      if (!text) throw new Error(t("Approval.ReasonNeeded", "Write a short reason for the player."));
      const user = game.users.get(model.sub.userId);
      if (!user) return;
      const store = createDraftStore(moduleId, game, user);
      const by = { id: game.user.id, name: game.user.name };
      const loaded = { status: "submitted", submittedAt: model.sub.submittedAt };
      const check = fresh => {
        if (!sameSubmission(loaded, fresh)) throw new Error(t("Approval.Changed", "The player changed or withdrew this request."));
        if (claimedElsewhere(fresh, pageId(), serverNow(game))) throw new Error(t("Approval.ClaimedElsewhere", "Another GM window is approving this right now."));
      };
      let removed = false;
      if (model.sub.kind === "creation") {
        const fresh = store.creation();
        if (fresh) { check(fresh); await store.saveCreation(asRejected(fresh, text, by)); }
        else {
          // Unreadable here (another version, no tabs): if it is still that waiting request, it goes.
          check(store.rawCreation());
          await store.clearCreation();
          removed = true;
        }
      } else {
        const fresh = store.draft(model.sub.actorId);
        check(fresh);
        await store.saveDraft(model.sub.actorId, asRejected(fresh, text, by));
      }
      const what = model.sub.kind === "creation" ? t("Approval.WhatCreation", "your new character") : t("Approval.WhatLevelUp", "your level-up ({label})", { label: model.sub.label });
      const note = removed ? t("Approval.RemovedChat", "{gm} sent back {what}. It couldn't be read, so it was removed; please start again.", { gm: game.user.name, what })
        : t("Approval.RejectedChat", "{gm} sent back {what}:", { gm: game.user.name, what });
      await globalThis.ChatMessage.create({ speaker: { alias: game.user.name }, whisper: [...new Set([user.id, ...game.users.filter(u => u.isGM).map(u => u.id)])],
        content: `<div class="ve-builder-chat-card"><p>${esc(note)}</p><p><em>${esc(text)}</em></p></div>` })
        .catch(error => console.warn(`${moduleId} | rejection chat note failed`, error));
    }
  };
  return service;
}
