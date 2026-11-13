/**
 * Phase 4b, GM side (spec §4.4): decides when the active GM's client shows which submission. It checks at ready, on any
 * change to a User's builder flag or role, when a user connects, on a House Rules change and from the Later card's Review
 * button. It shows one popup at a time, oldest first, auto-approves kinds whose switch is off (only a request with no
 * blocker and no check warning; anything else goes to the popup), and closes a popup whose request was withdrawn.
 * Only game.users.activeGM acts; a request another page of the same GM is approving right now (a fresh claim) is left
 * alone. `globalThis.veBuilderApprovalPaused = true` stops it on a page (tests that call the service themselves).
 */
import { currentHouseRules } from "./content-sources.mjs";
import { createApprovalService } from "./approval-service.mjs";
import { esc } from "./commit.mjs";
import { CLAIM_STALE_MS, claimedElsewhere, pageId, serverNow, submissionId, touchesBuilderFlag } from "./approval-rules.mjs";
import { showApproval } from "../../../../features/builder/approval-popup.mjs";

let started = false;

export function startApprovalWatcher({ moduleId, t, levelUpController, game = globalThis.game, hooks = globalThis.Hooks, show = showApproval }) {
  if (started) return null;
  started = true;
  const service = createApprovalService({ moduleId, t, game, levelUpController });
  const later = new Set();      // submissions put off on this page (they come back on reload)
  const autoFailed = new Set(); // auto-approvals that failed or need a look: they go to the popup, never retried in a loop
  let open = null;              // { sub, handle, deciding }
  let checking = false;
  let dirty = false;            // a change arrived during a check: check again when it ends
  let pendingExplicit = null;   // a Review click that came in during a check: opened when it ends
  let timer = null;
  let staleTimer = null;
  const isActiveGM = () => Boolean(game.user?.isGM) && game.users.activeGM?.id === game.user.id;
  const paused = () => globalThis.veBuilderApprovalPaused === true;
  const notify = (kind, text) => globalThis.ui?.notifications?.[kind]?.(text);
  const schedule = (delay = 250) => { clearTimeout(timer); timer = setTimeout(() => check().catch(error => console.error(`${moduleId} | approval check failed`, error)), delay); };
  const whatOf = sub => (sub.kind === "creation" ? t("Approval.WhatNew", "a new character{name}", { name: sub.label ? ` (${sub.label})` : "" }) : t("Approval.WhatLevel", "a level-up ({label})", sub));
  /** Requests this page may act on: not one another page is approving right now. */
  const actionable = () => service.list().filter(s => !claimedElsewhere(s, pageId(), serverNow(game)));
  /** A claim by another page that goes stale later: look again then (a GM page that died mid-approval). */
  const watchClaims = () => {
    clearTimeout(staleTimer);
    const fresh = service.list().filter(s => claimedElsewhere(s, pageId(), serverNow(game)));
    if (!fresh.length) return;
    const due = Math.min(...fresh.map(s => s.approvingAt + CLAIM_STALE_MS)) - serverNow(game) + 1000;
    staleTimer = setTimeout(() => schedule(0), Math.max(1000, due));
  };

  async function check(explicit = null) {
    if (!isActiveGM() || paused()) return;
    if (checking) { dirty = true; if (explicit) pendingExplicit = explicit; return; }
    checking = true;
    try {
      do {
        dirty = false;
        await checkOnce(explicit);
        explicit = pendingExplicit;
        pendingExplicit = null;
      } while (dirty || explicit);
    } finally { checking = false; }
  }

  async function checkOnce(explicit) {
    // A popup that went away without a decision (its layer was removed, its window closed by other code) frees the queue.
    if (open && !open.deciding && !open.handle?.alive?.()) open = null;
    if (open) {
      const live = service.find(submissionId(open.sub));
      // The GM's own Approve / Reject changes the player's flag too: never second-guess a popup that is deciding.
      if (open.deciding || (live && !claimedElsewhere(live, pageId(), serverNow(game)))) {
        if (explicit && submissionId(explicit) !== submissionId(open.sub)) notify("warn", t("Approval.OneAtATime", "Finish the open approval first."));
        return;
      }
      // Withdrawn or changed, or another page of this GM is approving it now.
      open.handle.close();
      notify("info", live ? t("Approval.ClaimedElsewhere", "Another GM window is approving this right now.")
        : t("Approval.Withdrawn", "{player} withdrew or changed {what}.", { player: open.sub.userName, what: whatOf(open.sub) }));
      open = null;
    }
    const rules = currentHouseRules(game);
    const auto = sub => (sub.kind === "creation" ? rules.approval?.creation === false : rules.approval?.levelUp === false);
    for (const sub of actionable().filter(s => auto(s) && !autoFailed.has(submissionId(s)))) {
      // Switch off: save without asking, but only what passes the checks; a blocker, a check's warning (rolls, HP, picks
    // outside their list, multiclass prerequisites, a changed level; not the Review's soft notes) or a failure goes to
    // the popup instead
      // (once: the failed approve's own flag writes would otherwise re-trigger it forever).
      try {
        const model = await service.open(sub);
        if (model.blockers.length || model.warnings.some(w => w.check)) { autoFailed.add(submissionId(sub)); continue; }
        await service.approve(model);
        // Saved, but its finish write failed (the controller told the GM): not again in a loop.
        if (service.current(sub)) { autoFailed.add(submissionId(sub)); continue; }
        notify("info", t("Approval.AutoDone", "Saved {what} for {player}.", { what: whatOf(sub), player: sub.userName }));
      } catch (error) { autoFailed.add(submissionId(sub)); console.warn(`${moduleId} | auto-approve failed`, error); }
    }
    const list = actionable();
    const live = explicit ? list.find(s => submissionId(s) === submissionId(explicit)) : null;
    const sub = live ?? list.find(s => !later.has(submissionId(s)));
    watchClaims();
    if (sub) await present(sub);
  }

  async function present(sub) {
    let model;
    try { model = await service.open(sub); }
    catch (error) {
      // Still shown, with the error as its blocker: the GM can send it back or put it off.
      console.error(`${moduleId} | could not open the approval request`, error);
      model = service.failedModel(sub, error);
    }
    const mine = { sub, handle: null, deciding: false };
    open = mine;
    // Each handler closes only its own popup, and clears `open` only if it is still this one, whatever happens.
    const decide = async fn => {
      mine.deciding = true;
      try { await fn(); } catch (error) { mine.deciding = false; throw error; }
      try { mine.handle.close(); }
      finally {
        if (open === mine) open = null;
        schedule();
      }
    };
    mine.handle = show(model, {
      approve: () => decide(async () => {
        await service.approve(model);
        // Saved, but the player's request couldn't be cleared (the controller told the GM): put off, so it doesn't pop
        // straight back; Approve again later only finishes it.
        if (service.current(sub)) { later.add(submissionId(sub)); return; }
        notify("info", t("Approval.Approved", "Approved {what} for {player}.", { what: whatOf(sub), player: sub.userName }));
      }),
      reject: reason => decide(() => service.reject(model, reason)),
      // Later always lets the popup go: a chat card that fails to post only loses the Review button.
      later: () => decide(async () => {
        later.add(submissionId(sub));
        await postReviewCard(sub).catch(error => console.warn(`${moduleId} | the Later card could not be posted`, error));
      })
    }, { t });
  }

  /** Later: one whispered card per submission, with a Review button that reopens it. */
  async function postReviewCard(sub) {
    const id = submissionId(sub);
    if (game.messages.some(m => m.getFlag?.(moduleId, "approvalReview") === id)) return;
    await globalThis.ChatMessage.create({ speaker: { alias: "Mobile Deck" }, whisper: game.users.filter(u => u.isGM).map(u => u.id),
      flags: { [moduleId]: { approvalReview: id } },
      content: `<div class="ve-builder-chat-card"><p>${esc(t("Approval.Waits", "{player} is waiting for your approval of {what}.", { player: sub.userName, what: whatOf(sub) }))}</p>`
        + `<button type="button" data-ve-builder-review="${esc(id)}">${esc(t("Approval.Review", "Review"))}</button></div>` });
  }

  hooks.once("ready", () => schedule(500));
  // Only the builder flag counts: VE writes other User flags often (probe P1). A role change can add or drop a player.
  hooks.on("updateUser", (user, changes) => { if (touchesBuilderFlag(changes, moduleId) || changes?.role !== undefined) schedule(); });
  // A GM joining can make this client the active GM (or stop it being one).
  hooks.on("userConnected", () => schedule());
  // Switching a kind's approval off saves what already waits.
  hooks.on("updateSetting", setting => { if (String(setting?.key ?? "").endsWith("builderHouseRules")) schedule(); });
  hooks.on("renderChatMessageHTML", (message, html) => {
    const id = message.getFlag?.(moduleId, "approvalReview");
    const button = id ? html?.querySelector?.("[data-ve-builder-review]") : null;
    if (!button) return;
    if (!game.user.isGM || !service.find(id)) { button.disabled = true; button.textContent = t("Approval.Handled", "Already handled"); return; }
    button.addEventListener("click", () => {
      const live = service.find(id); // looked up again: the card may be older than the request's latest state
      if (!live) { button.disabled = true; button.textContent = t("Approval.Handled", "Already handled"); return; }
      if (!isActiveGM()) { notify("warn", t("Approval.OtherGm", "Approvals open on the active GM's client ({name}).", { name: game.users.activeGM?.name ?? "" })); return; }
      if (claimedElsewhere(live, pageId(), serverNow(game))) { notify("warn", t("Approval.ClaimedElsewhere", "Another GM window is approving this right now.")); return; }
      later.delete(id);
      if (open && open.handle?.alive?.() && submissionId(open.sub) === id) return;
      if (open && open.handle?.alive?.()) { notify("warn", t("Approval.OneAtATime", "Finish the open approval first.")); return; }
      check(live).catch(error => console.error(error));
    });
  });
  return { service, check };
}
