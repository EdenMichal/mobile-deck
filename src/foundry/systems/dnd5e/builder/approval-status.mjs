/**
 * Phase 4b: the line under VE's "New character" row (spec §4.3): waiting, sent back, or approved and not yet seen.
 * It renders inside VE's character menu, so it stays cheap: one flag read, and the creation draft's JSON is parsed only
 * when it changed since the last render (the status is remembered by the raw string).
 */
import { MODULE_ID } from "../../../preferences.mjs";
import { resultKey, statusOf } from "./approval-rules.mjs";

let lastRaw = null;
let lastStatus = "draft";
const statusOfRaw = raw => {
  if (raw !== lastRaw) {
    lastRaw = raw;
    try { lastStatus = statusOf(JSON.parse(raw)); } catch { lastStatus = "draft"; }
  }
  return lastStatus;
};

/** `t(key, fallback)`: the caller's text lookup (no import of the gateway, which would close an import cycle through the presenter). */
export function creationBadge(t, game = globalThis.game, moduleId = MODULE_ID) {
  try {
    const user = game?.user;
    if (!user || user.isGM) return null; // GMs never need approval
    const builder = user.getFlag(moduleId, "builder");
    if (!builder) return null;
    if (builder.results?.[resultKey("creation")]) return { kind: "approved", text: t("Approval.BadgeApproved", "Approved by your GM") };
    if (!builder.creationJson) return null;
    const status = statusOfRaw(builder.creationJson);
    if (status === "submitted" || status === "approving") return { kind: "submitted", text: t("Approval.BadgeWaiting", "Waiting for GM approval") };
    if (status === "rejected") return { kind: "rejected", text: t("Approval.BadgeRejected", "Sent back by your GM") };
  } catch { /* no line */ }
  return null;
}
