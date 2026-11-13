/**
 * Phase 4a: the character-creation wizard on the shared builder shell (spec §2). Free tabs:
 * Class · Background · Species · Abilities · Equipment · Spells · Details · Review.
 */
import { icon, node } from "../../ui/dom.mjs";
import { createScope, createShell } from "./builder-shell.mjs";
import { draftCard, historyGroups, reviewGroup, sentBackGroup, stripHtml, waitingCard } from "./builder-layer.mjs";
import { choiceList, conflictBanner, STEP_SCREENS } from "./screens.mjs";
import { cardAction, rowArt, rowCopy, sheetCard, veIcon } from "./ve-parts.mjs";
import { abilitiesScreen, backgroundAsiScreen, detailsScreen, equipmentScreen } from "./creation-screens.mjs";
import { TABS } from "../../foundry/systems/dnd5e/builder/creation-tabs.mjs";
import { TAB_LABELS } from "../../foundry/systems/dnd5e/builder/creation-controller.mjs";
import { isWaiting, touchesBuilderFlag } from "../../foundry/systems/dnd5e/builder/approval-rules.mjs";
import { MODULE_ID } from "../../foundry/preferences.mjs";

const PICK_TEXT = { class: ["Creation.PickClass", "Choose a class"], background: ["Creation.PickBackground", "Choose a background"],
  species: ["Creation.PickSpecies", "Choose a species"] };
const SEGMENT_TABS = new Set(["class", "background", "species", "spells"]);
/** Tab icons: VE's own sheet icons and dnd5e symbols where VE has one, Font Awesome otherwise. */
const TAB_ICONS = { class: "class:original-class", background: "fa-scroll", species: "fa-dna", abilities: "fa-dumbbell", equipment: "sheet:inventory",
  spells: "sheet:spells", details: "sheet:biography", review: "fa-clipboard-check" };
/** The class themes VE paints (actor-view.mjs classThemes); other classes keep VE's default accent. */
const CLASS_THEMES = new Set(["artificer", "barbarian", "bard", "cleric", "druid", "fighter", "monk", "paladin", "psion", "ranger", "rogue", "sorcerer", "warlock", "wizard"]);
/** A fixed colour scheme the player chose in VE's settings (not "class"): keep it, as VE's sheet does. */
const FIXED_SCHEMES = new Set(["red", "bestiary", "custom"]);

export function mountCreator(host, controller, { t, onClose = () => {} }) {
  const label = pair => t(pair[0], pair[1]);
  let current = "class";
  let tabsScope = null;

  // Debounced saves for screens that change on every tap or keystroke (Abilities, Details).
  const queued = new Map();
  let timer = null;
  let inflight = Promise.resolve();
  const flush = () => {
    clearTimeout(timer);
    const jobs = [...queued.values()];
    queued.clear();
    for (const job of jobs) inflight = inflight.then(job).catch(error => shell.showError(error?.message ?? String(error)));
    return inflight;
  };
  /** Debounce per screen: Point Buy and ability taps save fast (setAbilities is cheap), typing waits a little longer. */
  const DEBOUNCE = { abilities: 150, details: 400 };
  const queue = (key, job) => {
    queued.set(key, job);
    clearTimeout(timer);
    timer = setTimeout(() => { flush().then(() => { if (!shell.scope.disposed) renderTabs(); }); }, DEBOUNCE[key] ?? 400);
  };

  const shell = createShell(host, { t, subtitle: label(["Creation.Title", "New character"]), controller, headIcon: "fa-user-plus", sheetAccent: false,
    // The final flush is returned, so a new creator can wait for it before reading the draft.
    onClose: () => { const last = flush(); tabsScope?.dispose(); onClose(); return last; },
    retry: async () => show(current) });
  const { frame, work, setBody, showError, ctxFor } = shell;

  // The class / background / species lists (compendium index scans) are read once per wizard session: pickScreen()
  // and the segment views fetch them through controller.options. Start over and Start drop them.
  const optionLists = new Map();
  const readOptions = controller.options.bind(controller);
  controller.options = tab => {
    if (!optionLists.has(tab)) optionLists.set(tab, readOptions(tab).catch(error => { optionLists.delete(tab); throw error; }));
    return optionLists.get(tab);
  };

  const visibleTabs = () => { const s = controller.tabs(); return TABS.filter(tab => s[tab] !== "hidden"); };
  const nextTab = tab => { const list = visibleTabs(); return list[Math.min(list.length - 1, list.indexOf(tab) + 1)] ?? "review"; };
  const percent = tab => { const list = visibleTabs(); return Math.round((Math.max(0, list.indexOf(tab)) / Math.max(1, list.length - 1)) * 100); };
  const firstOpenTab = () => { const s = controller.tabs(); return TABS.find(tab => tab !== "review" && ["todo", "attention"].includes(s[tab])) ?? "review"; };

  function renderTabs() {
    if (!controller.hasDraft() || isWaiting(controller.status())) { shell.tabs.hidden = true; return; }
    tabsScope?.dispose();
    tabsScope = createScope();
    const states = controller.tabs();
    shell.tabs.hidden = false;
    shell.layer.dataset.tab = current;
    shell.tabs.replaceChildren(...TABS.filter(tab => states[tab] !== "hidden").map(tab => node("button", {
      className: `ve-builder-tab is-${states[tab]}${tab === current ? " is-active" : ""}`,
      attrs: { type: "button", role: "tab", "aria-selected": String(tab === current), "data-tab": tab },
      on: { click: () => go(tab) },
      children: [node("span", { className: "ve-builder-tab-icon", attrs: { "aria-hidden": "true" }, children: [veIcon(TAB_ICONS[tab])] }),
        node("span", { className: "ve-builder-tab-label", text: label(TAB_LABELS[tab]) }),
        states[tab] === "done" ? icon("fa-check") : states[tab] === "attention" ? node("i", { className: "ve-builder-tab-dot", attrs: { "aria-hidden": "true" } }) : null]
    }, tabsScope)));
    shell.tabs.querySelector(".is-active")?.scrollIntoView?.({ block: "nearest", inline: "center" });
    applyClassTheme();
  }

  /** Once a class is picked, paint with its VE class accent (unless the player fixed a colour scheme). */
  function applyClassTheme() {
    let identifier = "";
    try { identifier = String(controller.abilities?.().classIdentifier ?? "").toLowerCase(); } catch { identifier = ""; }
    const scheme = document.querySelector(".ve-mobile-app")?.dataset.characterTheme ?? "";
    shell.setTheme(CLASS_THEMES.has(identifier) && !FIXED_SCHEMES.has(scheme) ? identifier : "");
  }

  const go = tab => work(async () => { await flush(); await show(tab); });

  async function show(tab) {
    current = tab;
    if (SEGMENT_TABS.has(tab)) showSegment(await controller.segment(tab));
    else if (tab === "abilities") showAbilities(controller.abilities());
    else if (tab === "equipment") showEquipment(await controller.equipment());
    else if (tab === "details") showDetails(controller.detailsTab());
    else showReview(await controller.review());
    renderTabs();
  }

  /* ---- Start ---- */

  function showStart() {
    const result = controller.result();
    if (result) return showDone(fromResult(result), { clear: true });
    const home = controller.home();
    shell.tabs.hidden = true;
    const s = frame({ screen: "start", heading: label(["Creation.Title", "New character"]) });
    let owner = "";
    const ownerChips = home.isGM ? node("div", { className: "ve-builder-chips ve-builder-owners", children: [{ id: "", name: t("Creation.OwnerMe", "Me") }, ...home.players].map(p =>
      node("button", { className: "ve-builder-chip", attrs: { type: "button", "aria-pressed": "false", "data-owner": p.id }, text: p.name,
        on: { click: () => { owner = p.id; refreshOwner(); } } }, s)) }) : null;
    const refreshOwner = () => ownerChips?.querySelectorAll("button").forEach(b => {
      const on = b.dataset.owner === owner;
      b.classList.toggle("is-selected", on);
      b.setAttribute("aria-pressed", String(on));
    });
    refreshOwner();
    let armed = false;
    const startOver = node("button", { className: "ve-builder-secondary", attrs: { type: "button", "data-action": "start-over" }, text: t("StartOver", "Start over"),
      on: { click: () => {
        if (!armed) { armed = true; startOver.textContent = t("Creation.ConfirmStartOver", "Tap again to delete the draft"); return; }
        work(async () => { queued.clear(); clearTimeout(timer); optionLists.clear(); await controller.discard(); showStart(); });
      } } }, s);
    const status = home.draft?.status;
    const resume = node("button", { className: "ve-builder-primary", attrs: { type: "button", "data-action": "resume" },
      children: [node("span", { text: isWaiting(home.draft) ? t("Approval.View", "View") : t("Continue", "Continue") })],
      on: { click: () => work(async () => { await controller.resume(); await show(isWaiting(home.draft) || status === "rejected" ? "review" : firstOpenTab()); }) } }, s);
    const withdraw = node("button", { className: "ve-builder-secondary", attrs: { type: "button", "data-action": "withdraw" }, text: t("Approval.Withdraw", "Withdraw to make changes"),
      on: { click: () => work(async () => { await controller.resume(); await controller.withdraw(); await show("review"); }) } }, s);
    const draftText = isWaiting(home.draft) ? t("Approval.WaitingDraft", "Waiting for GM approval: {name}", { name: home.draft.name || label(["Creation.Title", "New character"]) })
      : status === "rejected" ? t("Approval.RejectedDraft", "Your GM sent this character back: {reason}", { reason: home.draft.rejectReason })
        : home.draft?.name ? t("Creation.DraftNamed", "You have a character in progress: {name}", home.draft) : t("Creation.Draft", "You have a character in progress.");
    const draftBox = home.draft ? draftCard(draftText, isWaiting(home.draft) ? [resume, withdraw] : [resume, startOver]) : null;
    const startButton = home.draft ? null : node("button", { className: "ve-builder-primary ve-builder-wide", attrs: { type: "button", "data-action": "start" },
      children: [node("span", { text: t("Creation.Start", "Start a new character") }), icon("fa-arrow-right")],
      on: { click: () => work(async () => { optionLists.clear(); await controller.start({ owner }); await show("class"); }) } }, s);
    setBody(
      draftBox,
      home.draft ? null : node("p", { className: "ve-builder-lead", text: t("Creation.Lead", "Build a level 1 character. Move between the tabs at any time; your progress is saved as you go.") }),
      !home.draft && ownerChips ? sheetCard({ title: t("Creation.Owner", "Who will play this character?"), iconName: "fa-user", children: [ownerChips] }) : null,
      startButton
    );
  }

  /* ---- Class, Background, Species, Spells ---- */

  const segmentBack = tab => () => work(async () => { showSegment(await controller.back(tab)); renderTabs(); });

  function showSegment(view) {
    const tab = view.tab;
    current = tab;
    if (view.screen === "pick") return showPick(view);
    if (view.screen === "step") {
      const model = view.model;
      let answerFn = null;
      const s = frame({ screen: model.type, heading: model.title, sub: view.item?.name, percent: percent(tab),
        back: tab === "spells" ? null : segmentBack(tab),
        next: () => {
          const a = answerFn?.();
          if (!a) return;
          work(async () => {
            const next = await controller.answer(tab, a.data, a.meta);
            if (next.screen === "answered") await show(nextTab(tab));
            else { showSegment(next); renderTabs(); }
          });
        } });
      const ctx = ctxFor(s);
      const render = tab === "background" && model.type === "AbilityScoreImprovement" ? backgroundAsiScreen : STEP_SCREENS[model.type] ?? STEP_SCREENS.unsupported;
      const screen = render(model, ctx, s);
      answerFn = screen.answer;
      const fromSpecies = node("p", { className: "ve-builder-hint ve-builder-from-species", attrs: { hidden: true } });
      setBody(conflictBanner(model, t), fromSpecies, view.note ? node("p", { className: "ve-builder-hint", text: view.note }) : null,
        model.hint && model.type !== "AbilityScoreImprovement" ? node("p", { className: "ve-builder-hint", text: stripHtml(model.hint) }) : null, screen.element);
      // dnd5e asks the species' level-1 steps inside the class segment: say whose step it is (model.sourceTab).
      if (model.sourceTab && model.sourceTab !== tab && model.sourceName) {
        const text = model.sourceTab === "species" ? t("Creation.FromSpecies", "From your species: {name}", { name: model.sourceName })
          : t("Creation.FromTab", "From your {tab}: {name}", { tab: label(TAB_LABELS[model.sourceTab] ?? [model.sourceTab, model.sourceTab]).toLowerCase(), name: model.sourceName });
        const kicker = shell.layer.querySelector(".ve-builder-header small");
        if (kicker) kicker.textContent = text;
        fromSpecies.textContent = text;
        fromSpecies.hidden = false;
      }
      if (view.error) showError(t("AnswerRejected", "Please choose again: {message}", { message: view.error }));
      if (view.cleared?.length) showError(clearedText(view.cleared));
      return;
    }
    // done | none | blocked | error
    const s = frame({ screen: `${tab}-${view.screen}`, heading: label(TAB_LABELS[tab]), sub: view.item?.name, percent: percent(tab),
      back: view.canBack ? segmentBack(tab) : null,
      next: () => go(view.screen === "blocked" ? "class" : nextTab(tab)),
      nextText: view.screen === "blocked" ? t("Creation.ToClass", "Go to Class") : t("Next", "Next") });
    const text = {
      done: t("Creation.TabDone", "All choices here are made."),
      none: t("Creation.NoSpells", "No spells to choose at level 1."),
      blocked: t("Creation.SpellsBlocked", "Finish the Class tab first; spells come after your class's choices."),
      error: view.error ?? ""
    }[view.screen];
    setBody(
      view.item ? sheetCard({ title: label(TAB_LABELS[tab]), iconName: TAB_ICONS[tab], children: [
        node("div", { className: `ve-builder-card is-static ve-sheet-item-row${view.screen === "done" ? " is-selected" : ""}`, children: [rowArt(view.item.img, TAB_ICONS[tab]),
          rowCopy(view.item.name, node("small", { className: view.screen === "error" ? "ve-builder-warning" : "", text })),
          node("span", { className: "ve-builder-card-check", attrs: { "aria-hidden": "true" }, children: [view.screen === "done" ? icon("fa-circle-check") : icon("fa-circle-exclamation")] })] })
      ] }) : node("p", { className: view.screen === "error" ? "ve-builder-error" : "ve-builder-lead", text }),
      view.note ? node("p", { className: "ve-builder-hint", text: view.note }) : null,
      tab !== "spells" && view.item ? node("button", { className: "ve-builder-secondary ve-builder-wide", attrs: { type: "button", "data-action": "change-pick" },
        children: [icon("fa-pen"), node("span", { text: t("Creation.ChangePick", "Change {tab}", { tab: label(TAB_LABELS[tab]).toLowerCase() }) })],
        on: { click: () => work(async () => { showPick(await controller.pickScreen(tab)); renderTabs(); }) } }, s) : null
    );
    if (view.cleared?.length) showError(clearedText(view.cleared));
  }

  function clearedText(cleared) {
    const names = cleared.map(c => (c.startsWith("equipment.") ? t("Creation.ClearedEquipment", "{source} equipment", { source: label(TAB_LABELS[c.split(".")[1]]).toLowerCase() })
      : t("Creation.ClearedChoices", "{tab} choices", { tab: label(TAB_LABELS[c]).toLowerCase() })));
    return t("Creation.Cleared", "Cleared because of the change: {list}.", { list: names.join(", ") });
  }

  function showPick(view) {
    const tab = view.tab;
    current = tab;
    let pick = view.current ? [view.current] : [];
    const s = frame({ screen: `${tab}-pick`, heading: label(PICK_TEXT[tab]), percent: percent(tab),
      next: () => {
        if (!pick[0]) return;
        work(async () => { showSegment(await controller.pick(tab, pick[0])); renderTabs(); });
      } });
    const ctx = ctxFor(s);
    if (tab !== "species") {
      const list = choiceList(view.options, { scope: s, ctx, selected: pick, heading: { title: label(TAB_LABELS[tab]), iconName: TAB_ICONS[tab] },
        onChange: c => { pick = c; ctx.validChanged(c.length === 1); } });
      ctx.validChanged(pick.length === 1);
      return setBody(list.element);
    }
    // Species: one card per species; a species with variants then shows its variants.
    let group = view.options.find(g => g.variants.some(v => v.uuid === view.current)) ?? null;
    const variantsHost = node("div", { className: "ve-builder-stack" });
    // The first lineage's uuid, so the group card's Details shows a real description.
    const groupId = g => g.variants[0].uuid;
    const renderVariants = () => {
      if (!group) { pick = []; variantsHost.replaceChildren(); ctx.validChanged(false); return; }
      if (group.variants.length === 1) { pick = [group.variants[0].uuid]; variantsHost.replaceChildren(); ctx.validChanged(true); return; }
      if (!group.variants.some(v => v.uuid === pick[0])) pick = [];
      const list = choiceList(group.variants.map(v => ({ uuid: v.uuid, name: v.name, img: v.img, source: v.source, tier: v.tier })),
        { scope: s, ctx, selected: pick, heading: { title: t("Creation.PickVariant", "Choose your {species} lineage", { species: group.name }), iconName: TAB_ICONS.species },
          onChange: c => { pick = c; ctx.validChanged(c.length === 1); } });
      variantsHost.replaceChildren(list.element);
      ctx.validChanged(pick.length === 1);
    };
    const groups = choiceList(view.options.map(g => ({ uuid: groupId(g), name: g.name, img: g.img,
      source: g.variants.length > 1 ? t("Creation.Variants", "{count} lineages", { count: g.variants.length }) : g.source, tier: g.tier })),
      { scope: s, ctx, selected: group ? [groupId(group)] : [], heading: { title: label(TAB_LABELS.species), iconName: TAB_ICONS.species }, onChange: c => {
        const next = view.options.find(g => groupId(g) === c[0]) ?? null;
        if (next !== group) { group = next; renderVariants(); }
      } });
    setBody(groups.element, variantsHost);
    renderVariants();
  }

  /* ---- Abilities, Equipment, Details ---- */

  function showAbilities(model) {
    const s = frame({ screen: "abilities", heading: label(TAB_LABELS.abilities), percent: percent("abilities"), next: () => go(nextTab("abilities")) });
    const ctx = ctxFor(s);
    const screen = abilitiesScreen(model, ctx, s, {
      save: answer => { controller.previewAbilities(answer); renderTabs(); queue("abilities", () => controller.setAbilities(answer)); },
      roll: () => work(async () => { await flush(); screen.update(await controller.rollAbilities()); renderTabs(); }),
      enter: values => work(async () => { await flush(); screen.update(await controller.enterDice(values)); renderTabs(); })
    });
    setBody(screen.element);
  }

  function showEquipment(model) {
    const s = frame({ screen: "equipment", heading: label(TAB_LABELS.equipment), percent: percent("equipment"), next: () => go(nextTab("equipment")) });
    const ctx = ctxFor(s);
    const screen = equipmentScreen(model, ctx, s, {
      busy: () => shell.isBusy(),
      set: (source, answer) => work(async () => { screen.update(await controller.setEquipment(source, answer)); renderTabs(); },
        { onError: () => screen.redraw() }),
      trinket: () => work(async () => { screen.update(await controller.rollTrinket()); renderTabs(); })
    });
    setBody(screen.element);
  }

  function showDetails(model) {
    const s = frame({ screen: "details", heading: label(TAB_LABELS.details), percent: percent("details"), next: () => go(nextTab("details")) });
    const screen = detailsScreen(model, ctxFor(s), s, { save: details => queue("details", () => controller.setDetails(details)) });
    setBody(screen.element);
  }

  /* ---- Review and done ---- */

  function showReview(view) {
    if (isWaiting(view)) return showWaiting(view);
    const create = view.mode === "create";
    const ready = !view.blockers.length;
    const s = frame({ screen: "review", heading: label(TAB_LABELS.review), sub: view.name || label(["Creation.Title", "New character"]), percent: 100,
      next: () => { if (ready) work(async () => { await flush(); queued.clear(); if (create) showDone(await controller.commit()); else showWaiting(await controller.submit()); }); },
      nextText: create ? t("Creation.Create", "Create character") : t("Creation.Submit", "Submit for approval"), nextIcon: create ? "fa-check" : "fa-paper-plane" });
    const ctx = ctxFor(s);
    const toTab = tab => cardAction(t("Change", "Change"), () => go(tab), s, "ve-builder-link");
    const attention = view.blockers.length || view.warnings.length ? reviewGroup({ id: "attention", title: t("Creation.NeedsAttention", "Needs attention"),
      lines: [...view.blockers.map(b => ({ ...b, kind: b.kind === "conflict" ? "conflict" : "warning" })), ...view.warnings.map(w => ({ ...w, kind: "note" }))] }, line => toTab(line.tab), "ve-builder-attention") : null;
    const groups = view.groups.filter(g => g.lines.length).map(g => reviewGroup(g, line => (typeof line.step === "string" ? toTab(line.step) : null)));
    const lead = create ? t("Creation.ReviewLead", "Check everything below. Create saves the character; your GM gets this summary.")
      : view.mode === "auto" ? t("Approval.AutoLead", "Check everything below. Submit hands it to your GM's client, which saves it as soon as a GM is online.")
        : t("Approval.SubmitLead", "Check everything below. Submit sends it to your GM, who approves it or sends it back with a note.");
    setBody(sentBackGroup(view, t), node("p", { className: "ve-builder-lead", text: lead }), attention, ...groups);
    ctx.validChanged(ready);
  }

  /** Spec §4.3: submitted. The Review list, read-only, and Withdraw. */
  function showWaiting(view) {
    shell.tabs.hidden = true;
    const s = frame({ screen: "waiting", heading: t("Approval.Waiting", "Waiting for GM approval"), sub: view.name || label(["Creation.Title", "New character"]),
      percent: 100, next: () => shell.close(), nextText: t("Close", "Close"), nextIcon: "fa-check" });
    setBody(
      waitingCard({ t, scope: s, onWithdraw: () => work(async () => { await controller.withdraw(); await show("review"); }) }),
      ...view.groups.filter(g => g.lines.length).map(g => reviewGroup(g))
    );
  }

  /** A result the GM's client left (approval-rules results) → showDone's shape. */
  const fromResult = result => ({ actor: { name: result.name }, entry: result.entry, approvedBy: result.by });

  function showDone(result, { clear = false } = {}) {
    shell.tabs.hidden = true;
    if (clear) controller.clearResult().catch(error => console.warn(error));
    frame({ screen: "done", heading: t("Creation.Done", "Character created"), sub: result.actor.name, percent: 100, next: () => shell.close(), nextText: t("Close", "Close"), nextIcon: "fa-check" });
    setBody(node("p", { className: "ve-builder-lead", text: result.approvedBy
      ? t("Approval.DoneLead", "{name} is ready: {summary}. Approved by {gm}.", { name: result.actor.name, summary: result.entry.after.label, gm: result.approvedBy })
      : t("Creation.DoneLead", "{name} is ready: {summary}. A summary was sent to your GM.", { name: result.actor.name, summary: result.entry.after.label }) }),
      ...historyGroups(result.entry));
  }

  // Spec §4.3: the GM approves or sends it back while the wizard is open. Only changes to the builder flag made by another
  // client count (this client's own saves fire the same hook; VE writes other User flags often), and only while this
  // draft waits.
  const onRemote = () => {
    if (shell.scope.disposed) return;
    if (shell.isBusy()) { setTimeout(onRemote, 300); return; }
    const result = controller.result();
    if (result) { work(async () => showDone(fromResult(result), { clear: true })); return; }
    if (!isWaiting(controller.status())) return;
    work(async () => {
      if (!controller.reload()) { showStart(); return; }
      if (!isWaiting(controller.status())) await show("review");
    });
  };
  const hookId = globalThis.Hooks.on("updateUser", (user, changes, options, userId) => {
    if (user.id === globalThis.game.user.id && userId !== globalThis.game.user.id && touchesBuilderFlag(changes, MODULE_ID)) onRemote();
  });
  shell.scope.own(() => globalThis.Hooks.off("updateUser", hookId));

  showStart();
  return { close: () => shell.close(), element: shell.layer };
}
