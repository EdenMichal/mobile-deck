/**
 * Pure: change-log entries stored on the actor (`flags.<module>.changeLog`).
 * Each entry is what the player committed; the newest few also carry undo data
 * for the GM-only undo on desktop (Phase 5). Older entries drop it to keep the
 * actor document small, since flags sync with every actor update.
 */
export const CHANGE_LOG_LIMIT = 20;
export const UNDO_KEEP = 3;

/**
 * @param {object} data
 * @param {"level-up"|"creation"|"fix-level"} data.kind
 * @param {{ id: string, name: string }} data.user
 * @param {{ id: string, name: string }|null} [data.approvedBy]  The GM who approved a player's submission (Phase 4b).
 * @param {number} data.date                 Milliseconds since epoch.
 * @param {{ level: number, label: string }} data.before
 * @param {{ level: number, label: string }} data.after
 * @param {Array} data.groups                Output of reviewChanges().
 * @param {object} [data.undo]               { createdItemIds, deletedItems, actorSystem }.
 * @param {string} [data.approvalOf]         Phase 4b: the submission this entry approved (approval-rules submissionId).
 */
export function buildChangeLogEntry({ kind, user, approvedBy = null, date, before, after, groups, undo = null, approvalOf = null }) {
  return {
    id: `${date.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    date,
    user: { id: String(user?.id ?? ""), name: String(user?.name ?? "") },
    approvedBy: approvedBy ? { id: String(approvedBy.id ?? ""), name: String(approvedBy.name ?? "") } : null,
    before: { level: Number(before?.level) || 0, label: String(before?.label ?? "") },
    after: { level: Number(after?.level) || 0, label: String(after?.label ?? "") },
    groups: (groups ?? []).map(g => ({ id: g.id, title: g.title, lines: g.lines.map(l => ({ text: l.text, kind: l.kind })) })),
    undo: undo ?? null,
    ...(approvalOf ? { approvalOf: String(approvalOf) } : {})
  };
}

/** Newest first, capped, with undo data kept only on the newest UNDO_KEEP entries. */
export function appendChangeLog(existing, entry, { limit = CHANGE_LOG_LIMIT, undoKeep = UNDO_KEEP } = {}) {
  const list = [entry, ...(Array.isArray(existing) ? existing : [])].slice(0, limit);
  return list.map((e, i) => (i < undoKeep || !e.undo ? e : { ...e, undo: null }));
}

/** Short one-line summary, e.g. "Fighter 3 → Fighter 4 (Champion)". */
export function changeLogTitle(entry) {
  if (entry.before?.label && entry.after?.label) return `${entry.before.label} → ${entry.after.label}`;
  return entry.after?.label || entry.kind;
}
