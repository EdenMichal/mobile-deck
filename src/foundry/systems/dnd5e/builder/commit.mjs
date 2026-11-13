/**
 * Commit a finished session: write the clone to the actor (port of dnd5e 5.3.2's private
 * AdvancementManager#complete), store a change-log entry, and whisper a summary to the GMs.
 */
import { cloneDiff } from "./advancement-driver.mjs";
import { appendChangeLog, buildChangeLogEntry } from "./change-log.mjs";
import { hpFromAnswer, reviewChanges } from "./review-diff.mjs";
import { builderSnapshot, classSummary } from "./snapshot.mjs";
import { featSpellWarnings } from "./feature-spells.mjs";
import { sessionDataWarnings } from "./data-checks.mjs";

/** HTML-escaped text for chat cards (Foundry's escapeHTML, or a plain fallback). Shared by the builder's chat cards. */
export const esc = s => (globalThis.foundry?.utils?.escapeHTML ? globalThis.foundry.utils.escapeHTML(String(s)) : String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`));

/** HP detail for the review from what the session's HitPoints step applies (its answer's data.value; review-diff hpFromAnswer). */
export function hpDetail(session) {
  const step = session.path.find(p => p.type === "HitPoints" && session.answers[p.index]?.key === p.key);
  return step ? hpFromAnswer(session.answers[step.index], step.die) : null;
}

/** Grouped Review changes for the current session, with lines linked to their steps. */
export function sessionReview(session, t) {
  const before = builderSnapshot(session.actor);
  const after = builderSnapshot(session.manager.clone);
  const stepOf = {};
  for (const entry of session.path) {
    if (entry.type === "HitPoints") stepOf.hp ??= entry.index;
    if (entry.type === "Size") stepOf.size ??= entry.index;
  }
  for (const a of session.answers) {
    if (!a) continue;
    const step = session.path.find(p => p.key === a.key)?.index;
    if (step === undefined) continue;
    for (const k of Object.keys(a.data?.assignments ?? {})) stepOf[`ability:${k}`] ??= step;
    for (const k of a.data?.chosen ?? []) {
      const [trait, ...rest] = k.split(":");
      if (trait === "skills") stepOf[`skill:${rest.at(-1)}`] ??= step;
      if (trait === "saves") stepOf[`save:${rest.at(-1)}`] ??= step;
    }
    if (a.data?.uuid && a.meta?.kind === "subclass") for (const id of Object.keys(after.classes)) stepOf[`subclass:${id}`] ??= step;
    // Features and feats link to the step where they were picked.
    const picked = new Set([a.data?.uuid, ...(a.data?.selected ?? [])].filter(Boolean));
    for (const item of after.items) if (item.source && picked.has(item.source)) stepOf[`item:${item.id}`] ??= step;
  }
  const spellPath = session.path.find(p => p.type === "Spells");
  const spellAnswer = spellPath ? session.answers.find(a => a?.key === spellPath.key) : null;
  // Warnings come from what the step actually applied on this replay, not from the screen's answer,
  // so picks dropped later (an edited subclass, a pack switched off) still show as "not chosen".
  const spells = spellPath ? { step: spellPath.index, spellbookClass: Boolean(spellPath.extra?.owed?.spellbookClass),
    swaps: spellAnswer?.data?.swaps ?? [], warnings: spellPath.extra?.warnings ?? [], freed: spellPath.extra?.freed ?? [] } : null;
  return { before, after, groups: reviewChanges(before, after, { hp: hpDetail(session), stepOf, t, spells, notes: sessionNotes(session, t) }) };
}

/**
 * The "Check these" lines of a session's Review (L20 fixes): picks dnd5e removed again, granted items that can't be
 * found, feats whose spells must be added by hand, builder steps left open, and (for a GM) data that looks incomplete.
 */
export function sessionNotes(session, t, { isGM = Boolean(globalThis.game?.user?.isGM) } = {}) {
  const notes = [];
  for (const d of session.dropped ?? []) {
    notes.push({ key: `dropped:${d.index}`, step: d.index, text: t("Review.Dropped", "Not applied: {names} ({title}). dnd5e removed it: its prerequisites aren't met at this class level. Choose again.",
      { names: d.names.join(", "), title: d.title }) });
  }
  for (const u of session.unresolved ?? []) {
    notes.push({ key: `unresolved:${u.uuid}`, text: t("Review.Unresolved", "{name} ({item}) isn't in your compendiums, so it wasn't added. Add it on the sheet.",
      { name: u.name, item: u.item || u.title }) });
  }
  for (const p of session.path ?? []) {
    for (const d of p.extra?.shared ?? []) {
      notes.push({ key: `shared:${d.id}`, step: p.index, text: t("Review.SpellShared", "{name} is now always prepared through this level; your {cls}'s own pick of it can be changed on a Long Rest.", d) });
    }
    if (p.type !== "ItemChoice" || !p.extra) continue;
    const missing = (p.extra.warnings ?? []).find(w => w.kind === "choice")?.missing ?? 0;
    if (missing) notes.push({ key: `choice:${p.key}`, step: p.index, text: t("Review.ChoiceOpen", "{title}: {n} not chosen yet", { title: p.title, n: missing }) });
  }
  if (session.manager?.clone) {
    for (const w of featSpellWarnings(session.manager.clone, session.actor)) notes.push(w);
    for (const w of [...(session.notes ?? []), ...(session.controllerNotes ?? [])]) notes.push(w);
    if (isGM) {
      try { notes.push(...sessionDataWarnings(session)); } catch (error) { console.warn("Character Builder | data check failed", error); }
    }
  }
  return notes;
}

/**
 * `approvalOf`: the submission a GM's Approve commits (Phase 4b), stamped on the change-log entry so a retry can tell it
 * is already saved. An error thrown after the first write carries `error.partial = true`: the actor is half-changed.
 */
export async function commitSession(session, { moduleId, kind = "level-up", t, game = globalThis.game, author = game.user, approvedBy = null, approvalOf = null } = {}) {
  const actor = session.actor;
  const manager = session.manager;
  const { before, after, groups } = sessionReview(session, t);
  const actorBefore = actor.toObject();
  const { updates, toCreate, toUpdate, toDelete } = cloneDiff(manager);

  const entry = buildChangeLogEntry({
    kind, user: author, approvedBy, approvalOf, date: Date.now(),
    before: { level: before.level, label: classSummary(before) },
    after: { level: after.level, label: classSummary(after) },
    groups,
    undo: {
      createdItemIds: toCreate.map(i => i._id),
      deletedItems: actorBefore.items.filter(i => toDelete.includes(i._id)),
      updatedItems: actorBefore.items.filter(i => toUpdate.some(u => u._id === i._id)).map(i => ({ _id: i._id, system: i.system })),
      actorSystem: actorBefore.system
    }
  });
  const log = appendChangeLog(actor.getFlag(moduleId, "changeLog"), entry);
  foundry.utils.setProperty(updates, `flags.${moduleId}.changeLog`, log);

  if (Hooks.call("dnd5e.preAdvancementManagerComplete", manager, updates, toCreate, toUpdate, toDelete) === false) {
    throw new Error("Another module stopped this level-up (dnd5e.preAdvancementManagerComplete).");
  }
  // One after another rather than Promise.all, so a failure stops at a known point.
  await actor.update(updates, { isAdvancement: true });
  try {
    if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate, { keepId: true, isAdvancement: true });
    if (toUpdate.length) await actor.updateEmbeddedDocuments("Item", toUpdate, { diff: false, recursive: false, isAdvancement: true });
    if (toDelete.length) await actor.deleteEmbeddedDocuments("Item", toDelete, { isAdvancement: true });
    Hooks.callAll("dnd5e.advancementManagerComplete", manager);
  } catch (error) {
    // The actor update (and the change-log entry) went through: this level-up is saved only in part.
    if (error && typeof error === "object") error.partial = true;
    throw error;
  }

  await whisperSummary(actor, entry, game).catch(error => console.warn(`${moduleId} | change-log chat card failed`, error));
  return entry;
}

/** A compact chat card for the GMs and the player whose build it is (author), saying who approved it (Phase 4b). */
export async function whisperSummary(actor, entry, game = globalThis.game) {
  const groups = entry.groups.map(g => `<p><strong>${esc(g.title)}</strong></p><ul>${g.lines.map(l => `<li>${esc(l.text)}</li>`).join("")}</ul>`).join("");
  const verb = entry.kind === "creation" ? "created this character" : "committed this level-up";
  const approved = entry.approvedBy ? `; approved by ${esc(entry.approvedBy.name)}` : "";
  const content = `<div class="ve-builder-chat-card"><h3>${esc(actor.name)}: ${esc(entry.before.label)} → ${esc(entry.after.label)}</h3>`
    + `<p><em>${esc(entry.user.name)} ${verb} in Mobile Deck${approved}.</em></p>${groups}</div>`;
  const whisper = [...new Set([...game.users.filter(u => u.isGM).map(u => u.id), entry.user.id, game.user.id].filter(Boolean))];
  return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content, whisper });
}
