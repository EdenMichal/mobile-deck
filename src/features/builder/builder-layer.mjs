/**
 * Full-screen Level Up layer on the shared builder shell (builder-shell.mjs).
 */
import { icon, node } from "../../ui/dom.mjs";
import { createShell } from "./builder-shell.mjs";
import { blockerTextFor, choiceList, conflictBanner, emptyCard, STEP_SCREENS } from "./screens.mjs";
import { cardAction, rowArt, rowCopy, sheetCard } from "./ve-parts.mjs";
import { isWaiting, touchesBuilderFlag } from "../../foundry/systems/dnd5e/builder/approval-rules.mjs";
import { MODULE_ID } from "../../foundry/preferences.mjs";

export function mountBuilder(host, controller, { t, onClose = () => {} }) {
  let answerFn = null;
  let waiting = false; // the waiting screen is up (Phase 4b live update)
  const shell = createShell(host, { t, subtitle: controller.actorName, controller, onClose, headIcon: "fa-angles-up",
    nativeFallback: () => controller.openNativeWindow(),
    retry: async () => showView(await controller.current()) });
  const { frame, work, setBody, showError, ctxFor } = shell;
  const close = () => shell.close();

  function showView(view) {
    if (!view) return showHome();
    if (view.screen === "review") return showReview(view);
    const model = view.model;
    const s = frame({
      screen: model.type,
      heading: model.title, sub: `${view.heading} · ${model.item}`, percent: model.progress,
      back: () => work(async () => showView(view.canBack ? await controller.back() : null)),
      next: () => {
        const answer = answerFn?.();
        if (!answer) return;
        work(async () => showView(await controller.answer(answer.data, answer.meta)));
      }
    });
    const ctx = ctxFor(s);
    const render = STEP_SCREENS[model.type] ?? STEP_SCREENS.unsupported;
    const screen = render(model, ctx, s);
    answerFn = screen.answer;
    setBody(
      conflictBanner(model, t),
      model.hint ? node("p", { className: "ve-builder-hint", text: stripHtml(model.hint) }) : null,
      screen.element
    );
    if (view.error) showError(t("AnswerRejected", "Please choose again: {message}", { message: view.error }));
  }

  function showHome() {
    waiting = false;
    const home = controller.home();
    const result = controller.result();
    if (result) { controller.clearResult().catch(error => console.warn(error)); return showDone(result.entry, result.by); }
    const s = frame({ screen: "home", heading: t("LevelUp", "Level up"), sub: home.name });
    const classButton = cls => node("button", { className: "ve-builder-card ve-sheet-item-row", attrs: { type: "button", disabled: home.atMax || home.locked },
      on: { click: () => work(async () => showView(await controller.start({ kind: "level", classId: cls.id }))) },
      children: [rowArt(cls.img, classSymbol(cls.name)),
        rowCopy(`${cls.name} ${cls.levels} → ${cls.levels + 1}`, cls.subclass ? node("small", { text: cls.subclass }) : null),
        node("span", { className: "ve-builder-card-check", attrs: { "aria-hidden": "true" }, children: [icon("fa-chevron-right")] })] }, s);

    const multiclassHost = node("div", { className: "ve-builder-stack" });
    const multiclassToggle = !home.canAddClass ? null : node("button", { className: "ve-builder-secondary ve-builder-wide", attrs: { type: "button", disabled: home.atMax || home.locked },
      children: [icon("fa-plus"), node("span", { text: home.classes.length ? t("Multiclass", "Add a new class (multiclass)") : t("FirstClass", "Choose a class") })],
      on: { click: () => work(async () => {
        multiclassToggle.hidden = true;
        const options = await controller.newClassOptions();
        let pick = [];
        const list = choiceList(options, { scope: s, ctx: ctxFor(s), selected: [], blockerText: blockerTextFor(t), onChange: c => { pick = c; start.disabled = !c.length; } });
        const start = node("button", { className: "ve-builder-primary ve-builder-wide", attrs: { type: "button", disabled: true },
          children: [node("span", { text: t("StartClass", "Start with this class") }), icon("fa-arrow-right")],
          on: { click: () => work(async () => {
            const option = options.find(o => o.uuid === pick[0]);
            showView(await controller.start({ kind: "new-class", classUuid: pick[0], label: t("NewClassLabel", "New class: {name} 1", { name: option?.name ?? "" }) }));
          }) } }, s);
        multiclassHost.replaceChildren(list.element, start);
      }) } }, s);

    const status = home.draft?.status;
    const waits = isWaiting(home.draft);
    const draft = home.draft ? draftCard(
      waits ? t("Approval.LevelWaiting", "Waiting for GM approval: {label}", { label: home.draft.label })
        : status === "rejected" ? t("Approval.LevelRejected", "Your GM sent back {label}: {reason}", { label: home.draft.label, reason: home.draft.rejectReason })
          : t("DraftFound", "You have a level-up in progress: {label}", { label: home.draft.label }), [
        node("button", { className: "ve-builder-primary", attrs: { type: "button", "data-action": "resume" },
          children: [node("span", { text: waits ? t("Approval.View", "View") : t("Continue", "Continue") })],
          on: { click: () => work(async () => showView(await controller.resume())) } }, s),
        waits
          ? node("button", { className: "ve-builder-secondary", attrs: { type: "button", "data-action": "withdraw" }, text: t("Approval.Withdraw", "Withdraw to make changes"),
            on: { click: () => work(async () => { await controller.resume(); showView(await controller.withdraw()); }) } }, s)
          : node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, text: t("StartOver", "Start over"),
            on: { click: () => work(async () => { await controller.discardDraft(); showHome(); }) } }, s)
      ]) : null;

    setBody(
      draft,
      home.atMax ? emptyCard(t("AtMax", "{name} is already at the maximum level.", home)) : null,
      home.classes.length ? sheetCard({ title: t("PickClass", "Which class gains a level?"), iconName: "fa-angles-up",
        children: [node("div", { className: "ve-builder-cards ve-builder-list", children: home.classes.map(classButton) })] }) : null,
      multiclassToggle, multiclassHost,
      sheetCard({ children: [node("button", { className: "ve-builder-link ve-sheet-item-row", attrs: { type: "button" },
        children: [rowArt(null, "fa-clock-rotate-left"), rowCopy(t("History", "Change history")), icon("fa-chevron-right")],
        on: { click: () => showHistory() } }, s)] })
    );
  }

  function showReview(view) {
    if (isWaiting(view)) return showWaiting(view);
    waiting = false;
    const submit = view.mode === "submit";
    const s = frame({ screen: "review", heading: t("Review", "Review changes"), sub: `${view.from} → ${view.to}`, percent: 100,
      back: view.canBack ? () => work(async () => showView(await controller.back())) : null,
      next: () => work(async () => (submit ? showWaiting(await controller.submit()) : showDone(await controller.commit()))),
      nextText: submit ? t("Creation.Submit", "Submit for approval") : t("Commit", "Commit"), nextIcon: submit ? "fa-paper-plane" : "fa-check" });
    const change = step => cardAction(t("Change", "Change"), () => work(async () => showView(await controller.edit(step))), s, "ve-builder-link");
    const groups = view.groups.map(g => reviewGroup(g, line => (line.step !== undefined ? change(line.step) : null)));
    setBody(
      sentBackGroup(view, t),
      node("p", { className: "ve-builder-lead", text: submit ? t("Approval.LevelSubmitLead", "Check everything below. Submit sends it to your GM, who approves it or sends it back with a note.")
        : t("ReviewLead", "Check everything below. Commit applies it all at once; your GM gets this summary.") }),
      ...(groups.length ? groups : [emptyCard(t("NoChanges", "Nothing changes."))])
    );
  }

  /** Spec §4.3: submitted. The Review list, read-only, and Withdraw. */
  function showWaiting(view) {
    waiting = true;
    const s = frame({ screen: "waiting", heading: t("Approval.Waiting", "Waiting for GM approval"), sub: `${view.from} → ${view.to}`, percent: 100,
      next: () => close(), nextText: t("Close", "Close"), nextIcon: "fa-check" });
    setBody(
      waitingCard({ t, scope: s, onWithdraw: () => work(async () => showView(await controller.withdraw())) }),
      ...view.groups.map(g => reviewGroup(g))
    );
  }

  function showDone(entry, approvedBy = "") {
    waiting = false;
    frame({ screen: "done", heading: t("Done", "Level up complete"), sub: entry.after.label, percent: 100, next: () => close(), nextText: t("Close", "Close"), nextIcon: "fa-check" });
    setBody(
      node("p", { className: "ve-builder-lead", text: approvedBy
        ? t("Approval.LevelDoneLead", "{from} → {to}. Approved by {gm}.", { from: entry.before.label, to: entry.after.label, gm: approvedBy })
        : t("DoneLead", "{from} → {to}. A summary was sent to your GM.", { from: entry.before.label, to: entry.after.label }) }),
      ...historyGroups(entry)
    );
  }

  function showHistory() {
    const entries = controller.history();
    frame({ screen: "history", heading: t("History", "Change history"), back: () => showHome() });
    const fmt = new Intl.DateTimeFormat(globalThis.game?.i18n?.lang, { dateStyle: "medium", timeStyle: "short" });
    setBody(...(entries.length ? entries.map(entry => node("details", { className: "ve-builder-history ve-sheet-card", children: [
      node("summary", { children: [icon("fa-chevron-right"), node("span", { children: [node("strong", { text: `${entry.before.label} → ${entry.after.label}` }),
        node("small", { text: `${fmt.format(new Date(entry.date))} · ${entry.user.name}` })] })] }),
      node("div", { className: "ve-builder-history-groups", children: historyGroups(entry) })
    ] })) : [emptyCard(t("NoHistory", "No level-ups have been committed from Mobile Deck yet."))]));
  }

  // Spec §4.3: the GM decides while the level-up waits on screen. Only other clients' changes to the builder flag count
  // (this client's own saves fire the same hook; VE writes other User flags often). A result shows Done whatever screen
  // is up; a rejection reopens Review with the note.
  const onRemote = () => {
    if (shell.scope.disposed) return;
    if (shell.isBusy()) { setTimeout(onRemote, 300); return; }
    const result = controller.result();
    if (result) { waiting = false; work(async () => { await controller.clearResult(); showDone(result.entry, result.by); }); return; }
    const draft = controller.home().draft;
    // The home's draft card says "waiting": a decision (or the draft gone) redraws it.
    if (!waiting) { if (shell.layer.dataset.screen === "home" && !isWaiting(draft)) showHome(); return; }
    if (isWaiting(draft)) return;
    waiting = false;
    work(async () => showView(draft?.status === "rejected" ? await controller.resume() : null));
  };
  const hookId = globalThis.Hooks.on("updateUser", (user, changes, options, userId) => {
    if (user.id === globalThis.game.user.id && userId !== globalThis.game.user.id && touchesBuilderFlag(changes, MODULE_ID)) onRemote();
  });
  shell.scope.own(() => globalThis.Hooks.off("updateUser", hookId));

  showHome();
  return { close, element: shell.layer };
}

/** dnd5e's class symbol (VE's .ve-character-class-symbol) for a class name, or the generic one. */
const CLASS_SYMBOLS = new Set(["barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "ranger", "rogue", "sorcerer", "warlock", "wizard"]);
const classSymbol = name => { const key = String(name ?? "").trim().toLowerCase(); return `class:${CLASS_SYMBOLS.has(key) ? key : "original-class"}`; };

/** Icons for the review / history groups, by the engine's group id. */
const GROUP_ICONS = { level: "fa-angles-up", hp: "fa-heart", abilities: "fa-dumbbell", proficiencies: "fa-list-check", features: "sheet:features",
  spells: "sheet:spells", scale: "fa-chart-line", equipment: "sheet:inventory", details: "sheet:biography", notices: "fa-circle-exclamation",
  attention: "fa-triangle-exclamation" };

/** One review group as a VE card: heading with the group's icon, one row per line (gain / loss / note dot), optional action. */
export function reviewGroup(g, actionFor = () => null, className = "") {
  return sheetCard({ title: g.title, iconName: GROUP_ICONS[g.id] ?? "fa-circle-info", className: `ve-builder-review-group${className ? ` ${className}` : ""}`,
    children: [node("ul", { children: g.lines.map(line => node("li", { className: `is-${line.kind}`, children: [node("span", { text: line.text }), actionFor(line)] })) })] });
}

export function historyGroups(entry) {
  return entry.groups.map(g => reviewGroup(g));
}

/** Spec §4.3: the GM's note on a sent-back Review (level-up and creation), or null. */
export function sentBackGroup(view, t) {
  return view.rejectReason ? reviewGroup({ id: "notices", title: t("Approval.SentBack", "Sent back by {gm}", { gm: view.rejectedBy || t("Approval.YourGm", "your GM") }),
    lines: [{ text: view.rejectReason, kind: "warning" }] }, () => null, "ve-builder-attention ve-builder-sent-back") : null;
}

/**
 * Spec §4.3: the waiting screen's card (level-up and creation): whether a GM is online to decide, kept current as users
 * connect and leave, and Withdraw. `scope`: the screen's scope (the hook goes with it).
 */
export function waitingCard({ t, scope, onWithdraw }) {
  const lead = node("p", { className: "ve-builder-lead" });
  const refresh = () => {
    lead.textContent = globalThis.game?.users?.activeGM ? t("Approval.WaitingLead", "Your GM has been asked. This screen changes as soon as they decide; you can close it meanwhile.")
      : t("Approval.NoGm", "No GM is online right now. Your request waits until one joins.");
  };
  refresh();
  // Foundry settles the active GM around this hook: read it once the hook is done.
  const hookId = globalThis.Hooks?.on?.("userConnected", () => setTimeout(() => { if (!scope.disposed) refresh(); }, 0));
  if (hookId !== undefined) scope.own(() => globalThis.Hooks.off("userConnected", hookId));
  const withdraw = node("button", { className: "ve-builder-secondary ve-builder-wide", attrs: { type: "button", "data-action": "withdraw" },
    children: [icon("fa-rotate-left"), node("span", { text: t("Approval.Withdraw", "Withdraw to make changes") })], on: { click: () => onWithdraw() } }, scope);
  return sheetCard({ className: "ve-builder-waiting", children: [lead, withdraw] });
}

/** A level-up or creation draft waiting: its text and the Continue / Start over buttons. */
export function draftCard(text, buttons) {
  return sheetCard({ title: "", className: "ve-builder-draft", children: [node("p", { className: "ve-builder-draft-text", text }),
    node("div", { className: "ve-builder-row ve-builder-card-actions", children: buttons })] });
}

export function stripHtml(html) {
  return String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
