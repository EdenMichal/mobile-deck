/**
 * Phase 4b: the GM's approval popup (spec §4.4). One body with two hosts: a Foundry window on desktop (ApplicationV2,
 * like the House Rules menu) and a builder-shell layer while Mobile Deck's UI runs (VE hides other windows then).
 * Handlers: approve(), reject(reason), later(); each may throw, and the error shows in the popup. Each host returns
 * { close(), alive() }: alive() is false once it is closed or gone from the page (the watcher then frees its queue). Both hosts carry
 * data-ve-approval, so tests (and other suites' selectors) can tell the popup from the player's builder layer.
 */
import { icon, node } from "../../ui/dom.mjs";
import { createScope, createShell } from "./builder-shell.mjs";
import { ensureBuilderStyles } from "./builder-styles.mjs";
import { reviewGroup } from "./builder-layer.mjs";
import { sheetCard } from "./ve-parts.mjs";

/** The cards: lead, problems, review groups, the send-back form; optional own Later / Approve row (desktop window). */
export function approvalBody(model, handlers, { t, scope, run, actions = true }) {
  const reason = node("textarea", { className: "ve-builder-textarea ve-builder-approval-reason", attrs: { name: "reason", rows: 3,
    placeholder: t("Approval.ReasonPlaceholder", "What should the player change?") } });
  const reject = node("button", { className: "ve-builder-secondary", attrs: { type: "button", "data-action": "reject", disabled: true },
    children: [icon("fa-reply"), node("span", { text: t("Approval.Reject", "Send back") })],
    on: { click: () => run(() => handlers.reject(reason.value)) } }, scope);
  scope.listen(reason, "input", () => { reject.disabled = !reason.value.trim(); });
  const approve = node("button", { className: "ve-builder-primary", attrs: { type: "button", "data-action": "approve", disabled: model.blockers.length > 0 },
    children: [icon("fa-check"), node("span", { text: t("Approval.Approve", "Approve") })], on: { click: () => run(() => handlers.approve()) } }, scope);
  const later = node("button", { className: "ve-builder-secondary", attrs: { type: "button", "data-action": "later" },
    children: [icon("fa-clock"), node("span", { text: t("Approval.Later", "Later") })], on: { click: () => run(() => handlers.later()) } }, scope);
  return {
    element: node("div", { className: "ve-builder-approval-body", children: [
      model.lead ? node("p", { className: "ve-builder-lead", text: model.lead }) : null,
      model.blockers.length ? reviewGroup({ id: "attention", title: t("Approval.CantApprove", "Can't approve"),
        lines: model.blockers.map(b => ({ text: b.text, kind: "warning" })) }, () => null, "ve-builder-attention") : null,
      model.warnings.length ? reviewGroup({ id: "notices", title: t("Approval.Check", "Check these"),
        lines: model.warnings.map(w => ({ text: w.text, kind: "note" })) }, () => null, "ve-builder-attention") : null,
      ...model.groups.filter(g => g.lines.length).map(g => reviewGroup(g)),
      sheetCard({ title: t("Approval.SendBackTitle", "Send back to the player"), iconName: "fa-reply", className: "ve-builder-approval-reject",
        children: [reason, node("div", { className: "ve-builder-row ve-builder-card-actions", children: [reject] })] }),
      actions ? node("div", { className: "ve-builder-row ve-builder-approval-actions", children: [later, approve] }) : null
    ].filter(Boolean) })
  };
}

/** Desktop: an ApplicationV2 window, a new id each time (a closing window can't clash with the next). The X counts as Later. */
let WindowClass = null;
let windowCount = 0;
function approvalWindowClass() {
  if (WindowClass) return WindowClass;
  const { ApplicationV2 } = globalThis.foundry.applications.api;
  WindowClass = class ApprovalWindow extends ApplicationV2 {
    static DEFAULT_OPTIONS = { classes: ["ve-builder-approval-window"],
      window: { title: "Character Builder: approval", icon: "fa-solid fa-user-check", resizable: true }, position: { width: 560, height: 720 } };
    constructor(options, build, onClosed) { super(options); this.build = build; this.onClosed = onClosed; }
    async _renderHTML() { ensureBuilderStyles(); return this.build(); }
    _replaceHTML(result, content) { content.replaceChildren(result); }
    _onClose(options) { super._onClose?.(options); this.onClosed?.(); }
  };
  return WindowClass;
}

export function openApprovalWindow(model, handlers, { t }) {
  const scope = createScope();
  let finished = false;
  const errorBox = node("p", { className: "ve-builder-error", attrs: { role: "alert", hidden: true } });
  let busy = false;
  const run = async job => {
    if (busy) return;
    busy = true;
    errorBox.hidden = true;
    try { await job(); } catch (error) { console.error(error); errorBox.hidden = false; errorBox.textContent = error?.message ?? String(error); }
    finally { busy = false; }
  };
  // ".ve-builder" carries the builder's button and field styles (ve-builder.css widens them to this window).
  const app = new (approvalWindowClass())({ id: `ve-builder-approval-${++windowCount}`, window: { title: model.title } },
    () => node("div", { className: "ve-character-screen ve-builder ve-builder-approval", attrs: { "data-ve-approval": "true" }, children: [
      model.subtitle ? node("p", { className: "ve-builder-approval-subtitle", text: model.subtitle }) : null, errorBox,
      approvalBody(model, handlers, { t, scope, run }).element].filter(Boolean) }),
    () => { scope.dispose(); if (!finished) { finished = true; Promise.resolve(handlers.later()).catch(error => console.error(error)); } });
  let rendering = true;
  Promise.resolve(app.render({ force: true })).catch(error => console.error(error)).finally(() => { rendering = false; });
  // alive(): the watcher frees its queue when a window went away without a decision.
  return { close() { finished = true; app.close(); }, alive: () => !finished && (rendering || Boolean(app.rendered)) };
}

/** VE's phone UI: a builder-shell layer; Approve in the footer, the X counts as Later. */
export function mountApprovalLayer(host, model, handlers, { t }) {
  let finished = false;
  const shell = createShell(host, { t, subtitle: model.subtitle, controller: { isGM: true }, headIcon: "fa-user-check", sheetAccent: false,
    onClose: () => { if (!finished) { finished = true; Promise.resolve(handlers.later()).catch(error => console.error(error)); } } });
  shell.layer.dataset.veApproval = "true";
  const s = shell.frame({ screen: "approval", heading: model.title, sub: model.subtitle, percent: 100,
    next: model.blockers.length ? null : () => shell.work(() => handlers.approve()), nextText: t("Approval.Approve", "Approve"), nextIcon: "fa-check" });
  const run = job => shell.work(job);
  const body = approvalBody(model, handlers, { t, scope: s, run, actions: false });
  const later = node("button", { className: "ve-builder-secondary ve-builder-wide", attrs: { type: "button", "data-action": "later" },
    children: [icon("fa-clock"), node("span", { text: t("Approval.Later", "Later") })], on: { click: () => run(() => handlers.later()) } }, s);
  shell.setBody(body.element, later);
  return { close() { finished = true; shell.close(); }, alive: () => !finished && shell.layer.isConnected };
}

/** The host for this client right now: VE's layer while VE runs, else the window. */
export function showApproval(model, handlers, { t }) {
  const app = globalThis.document?.body?.classList.contains("ve-mobile-running") ? document.querySelector(".ve-mobile-app") : null;
  return app ? mountApprovalLayer(app, model, handlers, { t }) : openApprovalWindow(model, handlers, { t });
}
