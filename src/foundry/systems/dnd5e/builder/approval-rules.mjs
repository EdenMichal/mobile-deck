/**
 * Pure: GM approval (Phase 4b, spec §4). Who needs it, the status on a draft, the list of submissions the GM's
 * client shows, and the checks of rolls against their chat cards. No Foundry access, so it is unit-tested.
 *
 * A draft (creation or level-up) carries status "draft" | "submitted" | "approving" | "rejected", submittedAt while
 * submitted or approving, and rejectReason / rejectedBy after a rejection (kept until the next Submit, so the player can
 * still read it). "approving": a GM's client is saving it right now; the player can't withdraw it then. The claim names the
 * page (approvingBy, one id per GM page: one GM user can be logged in on two pages at once) and its time (approvingAt);
 * a claim older than CLAIM_STALE_MS is a GM page that died mid-way, and anyone may take it over. Stamps and the `now`
 * passed in are server time (serverNow), never a device's own clock.
 */
import { isCreationDraft } from "./creation-tabs.mjs";
import { isBanned } from "./source-filter.mjs";

export const STATUSES = Object.freeze(["draft", "submitted", "approving", "rejected"]);
export const CLAIM_STALE_MS = 2 * 60 * 1000;
const CLAIM = ["approvingBy", "approvingAt"];

const without = (object, ...keys) => Object.fromEntries(Object.entries(object ?? {}).filter(([k]) => !keys.includes(k)));

/** kind: "creation" | "level-up". GMs (Assistants included) never need it; a missing switch counts as on. */
export function needsApproval(kind, user, rules) {
  if (!user || user.isGM) return false;
  const approval = rules?.approval ?? {};
  return kind === "creation" ? approval.creation !== false : approval.levelUp !== false;
}

export function statusOf(draft) {
  return STATUSES.includes(draft?.status) ? draft.status : "draft";
}

export function asSubmitted(draft, now, extra = {}) {
  return { ...without(draft, "rejectReason", "rejectedBy", "submittedAt", ...CLAIM), ...extra, status: "submitted", submittedAt: now };
}

export function asDraft(draft) {
  return { ...without(draft, "submittedAt", ...CLAIM), status: "draft" };
}

/** A GM page has started saving it (same submittedAt, so its own later checks still match): its claim. */
export function asApproving(draft, pageId, now) {
  return { ...draft, status: "approving", approvingBy: pageId, approvingAt: now };
}

/** The claim dropped again (the approval failed before anything was saved). */
export function asUnclaimed(draft) {
  return { ...without(draft, ...CLAIM), status: "submitted" };
}

/** A claim older than CLAIM_STALE_MS (or without a time): the GM page that made it is gone. */
export function claimIsStale(draft, now) {
  return statusOf(draft) === "approving" && !(Number(now) - Number(draft.approvingAt) < CLAIM_STALE_MS);
}

/**
 * Approve may claim a submitted request, take over a stale claim, or go on with this page's own claim (an earlier
 * Approve here saved it but couldn't finish: the duplicate lookup then runs only the finish).
 */
export function canClaim(draft, now, pageId = null) {
  return statusOf(draft) === "submitted" || claimIsStale(draft, now) || holdsClaim(draft, pageId);
}

export function holdsClaim(draft, pageId) {
  return statusOf(draft) === "approving" && Boolean(pageId) && draft.approvingBy === pageId;
}

/** Another page is saving it right now: don't show it, don't auto-approve it. */
export function claimedElsewhere(draft, pageId, now) {
  return statusOf(draft) === "approving" && !claimIsStale(draft, now) && draft.approvingBy !== pageId;
}

/** The player may take it back while it waits, and when a GM page's claim went stale. */
export function canWithdraw(draft, now) {
  return statusOf(draft) === "submitted" || claimIsStale(draft, now);
}

/**
 * Now on Foundry's server clock (game.time.serverTime), for every approval stamp and comparison: devices' own clocks
 * differ (a phone two minutes ahead would read every fresh claim as stale). This device's clock only without Foundry.
 */
export function serverNow(game = globalThis.game) {
  const time = Number(game?.time?.serverTime);
  return Number.isFinite(time) ? time : Date.now();
}

let page = null;
/** This page's claim id (one per page load). */
export function pageId() {
  page ??= globalThis.foundry?.utils?.randomID?.() ?? Math.random().toString(36).slice(2, 18);
  return page;
}

/** Submitted or being approved: the player waits and can't change it. */
export function isWaiting(draft) {
  return ["submitted", "approving"].includes(statusOf(draft));
}

export function asRejected(draft, reason, by) {
  return { ...without(draft, "submittedAt", ...CLAIM), status: "rejected", rejectReason: String(reason ?? "").trim(), rejectedBy: by };
}

/** Where the GM's client leaves the outcome on the player's flag (`builder.results[key]`). */
export function resultKey(kind, actorId = "") {
  return kind === "creation" ? "creation" : `levelUp:${actorId}`;
}

/** Is `fresh` still the very submission `loaded` was read from (waiting, same stamp)? */
export function sameSubmission(loaded, fresh) {
  return isWaiting(loaded) && isWaiting(fresh) && Number(loaded.submittedAt) === Number(fresh.submittedAt);
}

const claimOf = draft => ({ status: statusOf(draft), approvingBy: draft.approvingBy ?? null, approvingAt: Number(draft.approvingAt) || 0 });
const parse = raw => { try { return JSON.parse(raw ?? "null"); } catch { return null; } };

/**
 * @param {Array<{ id, name, isGM, builder }>} users  builder: the user's raw `flags.<module>.builder`
 * @returns {Array<{ userId, userName, kind, key, actorId, submittedAt, label, status, approvingBy, approvingAt, invalid? }>} oldest
 *   first. A waiting creation draft that store.creation() can't read (another version, no tabs) comes with `invalid: true`:
 *   the GM can only send it back.
 */
export function collectSubmissions(users = []) {
  const list = [];
  for (const user of users) {
    if (user.isGM || !user.builder) continue;
    const creation = parse(user.builder.creationJson);
    if (creation && typeof creation === "object" && isWaiting(creation)) {
      list.push({ userId: user.id, userName: user.name, kind: "creation", key: resultKey("creation"), actorId: null,
        submittedAt: Number(creation.submittedAt) || 0, label: String(creation.tabs?.details?.name ?? "").trim(), ...claimOf(creation),
        ...(isCreationDraft(creation) ? {} : { invalid: true }) });
    }
    for (const [actorId, draft] of Object.entries(user.builder.drafts ?? {})) {
      if (!isWaiting(draft)) continue;
      list.push({ userId: user.id, userName: user.name, kind: "level-up", key: resultKey("level-up", actorId), actorId,
        submittedAt: Number(draft.submittedAt) || 0, label: String(draft.label ?? ""), ...claimOf(draft) });
    }
  }
  return list.sort((a, b) => a.submittedAt - b.submittedAt);
}

export const submissionId = sub => `${sub.userId}|${sub.key}|${sub.submittedAt}`;

/**
 * Does an `updateUser` change touch the builder flag (set, merged, deleted or replaced)? VE writes other User flags
 * often, so hooks filter on this instead of `changes.flags` (probe P1).
 */
export function touchesBuilderFlag(changes, moduleId) {
  const flags = changes?.flags?.[moduleId];
  return Boolean(flags) && typeof flags === "object" && ["builder", "-=builder", "==builder"].some(key => key in flags);
}

const sameNumbers = (a = [], b = []) => a.length === b.length && a.every((v, i) => Number(v) === Number(b[i]));

/**
 * Each rolled ability set against its chat card. lookup(messageId) → { authorId, totals } | null.
 * @returns {Array<{ index, problem: "missing" | "author" | "totals" }>}
 */
export function checkRolledSets({ sets = [], messageIds = [] } = {}, lookup, authorId) {
  const problems = [];
  sets.forEach((set, index) => {
    const card = messageIds[index] ? lookup(messageIds[index]) : null;
    if (!card) problems.push({ index, problem: "missing" });
    else if (card.authorId !== authorId) problems.push({ index, problem: "author" });
    else if (!sameNumbers(card.totals, set)) problems.push({ index, problem: "totals" });
  });
  return problems;
}

/**
 * Level-up HP: what each HitPoints step applies on the GM's replay (its answer's data.value, not the screen's notes): "avg",
 * or a whole number from 1 to the step's die that equals that step's own lock (same die), whose chat card checks out.
 * Locks no step uses (an abandoned roll, another level) are ignored.
 * @param {Array<{ value, key, die }>} steps  key = "actorId|classIdentifier|level" from the replayed step
 * @param {Array<{ key, value, die, messageId }>} locks  the actor's HP locks on the player's flag
 * @returns {Array<{ value, problem: "invalid" | "unlocked" | "missing" | "author" | "totals" }>}
 */
export function checkHpRolls(steps = [], locks = [], lookup, authorId) {
  const problems = [];
  for (const step of steps) {
    const value = step.value;
    if (value === "avg") continue;
    const die = Number(step.die);
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > die) { problems.push({ value, problem: "invalid" }); continue; }
    const lock = locks.find(l => l.key === step.key);
    if (!lock || Number(lock.value) !== value || Number(lock.die) !== die) { problems.push({ value, problem: "unlocked" }); continue; }
    const card = lock.messageId ? lookup(lock.messageId) : null;
    if (!card) problems.push({ value, problem: "missing" });
    else if (card.authorId !== authorId) problems.push({ value, problem: "author" });
    else if (Number(card.totals[0]) !== value) problems.push({ value, problem: "totals" });
  }
  return problems;
}

/** Ability sets: no more than the house rules' rerolls allow, and a reroll count that matches the sets. */
export function checkRollCount({ sets = [], rerollsUsed = 0 } = {}, rules = {}) {
  const problems = [];
  const allowed = (Number(rules?.abilityRerolls) || 0) + 1;
  if (sets.length > allowed) problems.push({ problem: "tooMany", sets: sets.length, allowed });
  const expected = Math.max(0, sets.length - 1);
  if ((Number(rerollsUsed) || 0) !== expected) problems.push({ problem: "rerolls", used: Number(rerollsUsed) || 0, expected });
  return problems;
}

/** Rolled starting gold ([{ uuid, value, messageId }]) against its chat card, as the ability sets. */
export function checkGoldRolls(entries = [], lookup, authorId) {
  const problems = [];
  for (const { uuid, value, messageId } of entries) {
    const card = messageId ? lookup(messageId) : null;
    if (!card) problems.push({ uuid, value, problem: "missing" });
    else if (card.authorId !== authorId) problems.push({ uuid, value, problem: "author" });
    else if (Number(card.totals[0]) !== Number(value)) problems.push({ uuid, value, problem: "totals" });
  }
  return problems;
}

/**
 * The level-up target the player wrote, on the GM's client. "level": a class the actor has, below the maximum level;
 * "new-class": a class document (doc), not banned, not one the actor has, multiclassing allowed if it has a class.
 * Anything else ("new-item", missing) is refused.
 * @returns {null | "kind" | "class" | "max" | "multiclass" | "notClass" | "banned" | "owned"}
 */
export function checkLevelUpTarget(target, { classIds = [], identifiers = [], level = 0, maxLevel = 20, rules = {}, doc = null } = {}) {
  if (target?.kind === "level") {
    if (!classIds.includes(target.classId)) return "class";
    return level >= maxLevel ? "max" : null;
  }
  if (target?.kind !== "new-class") return "kind";
  if (classIds.length && rules.multiclass === false) return "multiclass";
  if (!doc || doc.type !== "class") return "notClass";
  if (isBanned(doc, { bannedClasses: [], bannedSubclasses: [], ...rules })) return "banned";
  if (identifiers.includes(String(doc.system?.identifier ?? ""))) return "owned";
  return level >= maxLevel ? "max" : null;
}

/** What the GM's client leaves on the player's flag after Approve (approval-rules resultKey). */
export function approvalResult({ kind, actor, entry, by }) {
  return { status: "approved", kind, actorId: actor.id, name: actor.name, label: entry.after.label, by: by.name, date: Date.now(),
    entry: { ...entry, undo: null } };
}
