/**
 * Spells step (Phase 3 spec §2): counters, filter chips, the class's allowed spells, optional
 * swaps and, for Wizards, preparing from the spellbook. Tapping a spell opens Mobile Deck's own
 * item detail window, with a Pick / Unpick button added at the bottom.
 */
import { icon, node } from "../../ui/dom.mjs";
import { spellProgress, spellWarnings } from "../../foundry/systems/dnd5e/builder/spell-rules.mjs";
import { itemDetailModal } from "../characters/systems/dnd5e/presenter.mjs";
import { emptyCard, rowArt, rowCopy, sheetCard, tierChip } from "./ve-parts.mjs";

/** A small disposable scope for listeners that live shorter than the screen (rebuilt rows, one details window). */
function childScope(parent) {
  const disposers = [];
  const child = {
    disposed: false,
    listen(element, type, listener) { element.addEventListener(type, listener); disposers.push(() => element.removeEventListener(type, listener)); },
    own(fn) { disposers.push(fn); },
    dispose() { child.disposed = true; while (disposers.length) { try { disposers.pop()(); } catch { /* keep disposing */ } } }
  };
  parent.own(() => child.dispose());
  return child;
}

/** "class:wizard" → "Wizard". */
const listName = key => {
  const id = String(key ?? "").split(":").pop();
  return globalThis.dnd5e?.registry?.spellLists?.forType?.(key)?.name ?? (id.charAt(0).toUpperCase() + id.slice(1));
};

const levelLabel = (t, level) => (level === 0 ? t("Spells.Cantrip", "Cantrip") : t("Spells.Level", "Level {level}", { level }));

export function spellScreen(model, ctx, scope) {
  const t = ctx.t;
  const owed = model.owed;
  const book = owed.spellbookClass;
  const emptyAnswer = () => ({ data: { cantrips: [], spells: [], prepare: [], swaps: [] }, meta: { kind: "spells", warnings: spellWarnings(owed, {}) } });

  if (model.loadError) {
    ctx.validChanged(true);
    const card = emptyCard(t("Spells.LoadError", "The spell list couldn't load: {message}", { message: model.loadError }),
      node("div", { className: "ve-builder-card-actions", children: [
        node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, text: t("Retry", "Retry"), on: { click: () => ctx.retry() } }, scope)] }));
    card.querySelector(".ve-builder-empty")?.classList.add("ve-builder-warning");
    return { element: card, answer: emptyAnswer };
  }

  const prior = model.answer ?? {};
  const byUuid = new Map(model.options.map(o => [o.uuid, o]));
  const knownById = new Map(model.known.map(k => [k.id, k]));
  const priorSwap = cantrip => {
    const s = (prior.swaps ?? []).find(swap => knownById.has(swap.out) && (knownById.get(swap.out).level === 0) === cantrip && byUuid.has(swap.in));
    return s ? { out: s.out, in: s.in } : null;
  };
  const state = {
    cantrips: new Set((prior.cantrips ?? []).filter(u => byUuid.get(u)?.level === 0).slice(0, owed.cantrips)),
    spells: new Set((prior.spells ?? []).filter(u => byUuid.get(u)?.level > 0).slice(0, book ? owed.spellbook : owed.prepared)),
    prepare: new Set((prior.prepare ?? []).slice(0, book ? owed.prepared : 0)),
    swaps: { cantrip: priorSwap(true), spell: priorSwap(false) }
  };
  const swapIns = () => new Set(Object.values(state.swaps).map(s => s?.in).filter(Boolean));
  const swapOuts = () => new Set(Object.values(state.swaps).map(s => s?.out).filter(Boolean));
  const data = () => ({
    cantrips: [...state.cantrips],
    spells: [...state.spells],
    prepare: book ? [...state.prepare].filter(ref => (ref.startsWith("item:") ? knownById.has(ref.slice(5)) && !swapOuts().has(ref.slice(5)) : state.spells.has(ref))) : [],
    swaps: Object.values(state.swaps).filter(s => s?.out && s?.in)
  });

  const filter = { level: "all", ritual: false, concentration: false, query: "" };
  const rows = [];          // filterable rows (main list and swap lists)
  const swapChipSets = [];

  /** One spell: tap the row for details, the check button to pick. */
  function spellRow(option, picker, { register = true, owner = scope } = {}) {
    const check = node("button", { className: "ve-builder-spell-check", attrs: { type: "button", "aria-pressed": "false", "aria-label": t("Spells.PickName", "Pick {name}", option) },
      children: [icon("fa-check")], on: { click: () => { picker.toggle(); refresh(); } } }, owner);
    const open = node("button", { className: "ve-builder-spell-open ve-sheet-item-row", attrs: { type: "button" },
      on: { click: () => openDetails(option, picker) }, children: [
        rowArt(option.img, "fa-wand-sparkles"),
        rowCopy(option.name,
          node("small", { text: [levelLabel(t, option.level), option.schoolLabel, option.components].filter(Boolean).join(" · ") }),
          node("span", { className: "ve-builder-spell-tags", children: [
            option.ritual ? node("span", { className: "ve-builder-tag", text: t("Spells.Ritual", "Ritual") }) : null,
            option.concentration ? node("span", { className: "ve-builder-tag", text: t("Spells.Concentration", "Concentration") }) : null,
            option.book || option.source ? node("small", { text: option.book || option.source }) : null,
            tierChip(option.tier)
          ] })),
        icon("fa-chevron-right")
      ] }, owner);
    const el = node("div", { className: "ve-builder-spell-row", children: [open, check] });
    const row = { option, el, check, picker };
    if (register) rows.push(row);
    return row;
  }

  function paint(row) {
    const on = row.picker.isOn();
    row.el.classList.toggle("is-selected", on);
    row.check.setAttribute("aria-pressed", String(on));
    row.check.disabled = !on && !row.picker.canTurnOn();
  }

  /** Mobile Deck's own item detail window, with a Pick / Unpick bar. VE Back closes only the window. */
  let opening = false;
  let closeWindow = null;
  async function openDetails(option, picker) {
    if (!option.uuid || opening) return;
    opening = true;
    let record = null;
    try { record = await ctx.controller.spellDetails(option.uuid).catch(() => null); }
    finally { opening = false; }
    if (!record || scope.disposed) return;
    closeWindow?.();
    const windowScope = childScope(scope);
    let modal = null;
    const close = () => { windowScope.dispose(); modal = null; if (closeWindow === close) closeWindow = null; };
    closeWindow = close;
    modal = itemDetailModal(record, close, windowScope, {
      localize: (key, fallback) => (globalThis.game?.i18n?.has?.(key) ? globalThis.game.i18n.localize(key) : fallback),
      readLocale: () => globalThis.game?.i18n?.lang ?? "en"
    });
    if (!modal) { close(); return; }
    const on = picker.isOn();
    const pick = node("button", { className: "ve-builder-primary ve-builder-spell-pick", attrs: { type: "button" },
      children: [icon(on ? "fa-xmark" : "fa-check"), node("span", { text: on ? t("Spells.Unpick", "Unpick") : t("Spells.Pick", "Pick") })],
      on: { click: () => { picker.toggle(); refresh(); close(); } } }, windowScope);
    pick.disabled = !on && !picker.canTurnOn();
    modal.querySelector(".ve-item-modal-content")?.append(node("div", { className: "ve-builder-spell-pick-bar", children: [pick] }));
    modal.dataset.veBackDismissable = "true";
    windowScope.listen(modal, "ve-close", event => { event.stopPropagation(); close(); });
    ctx.overlay(modal, windowScope);
  }

  // Counters
  const counters = node("div", { className: "ve-builder-spell-counters" });
  const carried = owed.carriedOver ? node("p", { className: "ve-builder-hint", text: t("Spells.CarriedOver", "Prepared includes {count} from earlier levels.", { count: owed.carriedOver }) }) : null;
  function renderCounters() {
    const progress = spellProgress(owed, data());
    const tiles = [];
    if (owed.cantrips) tiles.push([t("Spells.Cantrips", "Cantrips"), progress.cantrips]);
    if (book && owed.spellbook) tiles.push([t("Spells.Spellbook", "Spellbook"), progress.spellbook]);
    if (owed.prepared) tiles.push([t("Spells.Prepared", "Prepared"), progress.prepared]);
    counters.replaceChildren(...tiles.map(([label, c]) => node("div", { className: `ve-builder-spell-counter${c.done >= c.owed ? " is-done" : ""}`,
      children: [node("small", { text: label }), node("strong", { text: `${c.done} / ${c.owed}` })] })));
    counters.dataset.count = String(tiles.length);
    counters.hidden = !tiles.length;
  }

  // Filters: one level chip at a time, Ritual and Concentration as toggles, and search
  const spellCap = book ? owed.spellbook : owed.prepared;
  const mainOptions = model.options.filter(o => (o.level === 0 ? owed.cantrips > 0 : spellCap > 0));
  const levels = [...new Set(mainOptions.map(o => o.level))].sort((a, b) => a - b);
  const levelChips = ["all", ...levels].map(level => node("button", { className: "ve-builder-chip", attrs: { type: "button", "aria-pressed": "false" },
    dataset: { level: String(level) }, text: level === "all" ? t("Spells.All", "All") : levelLabel(t, level),
    on: { click: () => { filter.level = String(level); applyFilter(); } } }, scope));
  const toggleChip = (key, label) => node("button", { className: "ve-builder-chip", attrs: { type: "button", "aria-pressed": "false" },
    dataset: { toggle: key }, text: label, on: { click: () => { filter[key] = !filter[key]; applyFilter(); } } }, scope);
  const toggles = [toggleChip("ritual", t("Spells.Ritual", "Ritual")), toggleChip("concentration", t("Spells.Concentration", "Concentration"))];
  const search = node("label", { className: "ve-builder-search-row", children: [icon("fa-magnifying-glass"), node("input", { className: "ve-builder-search", attrs: { type: "search", placeholder: t("Spells.Search", "Search spells"), "aria-label": t("Spells.Search", "Search spells") },
    on: { input: event => { filter.query = event.currentTarget.value.trim().toLowerCase(); applyFilter(); } } }, scope)] });
  function applyFilter() {
    for (const chip of levelChips) { const on = chip.dataset.level === filter.level; chip.classList.toggle("is-selected", on); chip.setAttribute("aria-pressed", String(on)); }
    for (const chip of toggles) { const on = filter[chip.dataset.toggle]; chip.classList.toggle("is-selected", on); chip.setAttribute("aria-pressed", String(on)); }
    for (const { option, el } of rows) {
      el.hidden = (filter.level !== "all" && String(option.level) !== filter.level) || (filter.ritual && !option.ritual)
        || (filter.concentration && !option.concentration) || (Boolean(filter.query) && !option.name.toLowerCase().includes(filter.query));
    }
  }

  // Main list: new cantrips, and new spells (prepared, or added to a Wizard's spellbook)
  const mainList = node("div", { className: "ve-builder-spell-list", children: mainOptions.map(option => {
    const set = option.level === 0 ? state.cantrips : state.spells;
    const cap = option.level === 0 ? owed.cantrips : spellCap;
    return spellRow(option, {
      isOn: () => set.has(option.uuid),
      canTurnOn: () => set.size < cap && !swapIns().has(option.uuid),
      toggle: () => {
        if (set.has(option.uuid)) { set.delete(option.uuid); state.prepare.delete(option.uuid); }
        else if (set.size < cap && !swapIns().has(option.uuid)) set.add(option.uuid);
      }
    }).el;
  }) });

  // Wizard: prepare from the spellbook (known unprepared spells plus this level's additions)
  const prepareHost = node("div", { className: "ve-builder-spell-list" });
  const prepareSection = book && owed.prepared ? sheetCard({ title: t("Spells.PrepareHeading", "Prepare from your spellbook"), iconName: "fa-book-open",
    className: "ve-builder-spell-section", children: [prepareHost] }) : null;
  let prepareScope = null;
  function renderPrepare() {
    if (!prepareSection) return;
    prepareScope?.dispose();
    prepareScope = childScope(scope);
    const entries = [
      ...model.known.filter(k => k.level > 0 && k.prepared === 0 && !swapOuts().has(k.id)).map(k => ({ ref: `item:${k.id}`, option: k })),
      ...[...state.spells].map(uuid => ({ ref: uuid, option: byUuid.get(uuid) })).filter(e => e.option)
    ];
    const prepareRows = entries.map(({ ref, option }) => spellRow(option, {
      isOn: () => state.prepare.has(ref),
      canTurnOn: () => data().prepare.length < owed.prepared,
      toggle: () => { if (state.prepare.has(ref)) state.prepare.delete(ref); else if (data().prepare.length < owed.prepared) state.prepare.add(ref); }
    }, { register: false, owner: prepareScope }));
    prepareHost.replaceChildren(...prepareRows.map(r => r.el));
    prepareRows.forEach(paint);
    if (!prepareRows.length) prepareHost.append(node("p", { className: "ve-builder-empty ve-sheet-empty", text: t("Spells.EmptyBook", "Add spells to your spellbook above, then prepare them here.") }));
  }

  // Optional swaps on gaining a level (SRD 5.2): one cantrip (not Wizards: Long Rest), one spell (Bard, Sorcerer, Warlock, Eldritch Knight, Arcane Trickster)
  function swapSection(kind) {
    const cantrip = kind === "cantrip";
    if (cantrip ? !owed.swapCantrip : !owed.swapSpell) return null;
    const outs = model.known.filter(k => (cantrip ? k.level === 0 : k.level > 0) && k.prepared !== 2);
    if (!outs.length) return null;
    const ins = model.options.filter(o => (cantrip ? o.level === 0 : o.level > 0));
    const outChips = outs.map(k => node("button", { className: "ve-builder-chip", attrs: { type: "button", "aria-pressed": "false" }, dataset: { out: k.id }, text: k.name,
      on: { click: () => { const cur = state.swaps[kind]; state.swaps[kind] = cur?.out === k.id ? null : { out: k.id, in: cur?.in ?? null }; refresh(); } } }, scope));
    swapChipSets.push({ kind, chips: outChips });
    const inList = node("div", { className: "ve-builder-spell-list", children: ins.map(option => spellRow(option, {
      isOn: () => state.swaps[kind]?.in === option.uuid,
      canTurnOn: () => Boolean(state.swaps[kind]?.out) && !state.cantrips.has(option.uuid) && !state.spells.has(option.uuid) && !swapIns().has(option.uuid),
      toggle: () => { const s = state.swaps[kind]; if (s?.out) s.in = s.in === option.uuid ? null : option.uuid; }
    }).el) });
    const section = node("details", { className: "ve-builder-spell-swap ve-sheet-card ve-sheet-collection-section", children: [
      node("summary", { children: [icon("fa-chevron-right"), node("span", { text: cantrip ? t("Spells.SwapCantrip", "Replace a cantrip (optional)") : t("Spells.SwapSpell", "Replace a spell (optional)") }),
        node("b", { children: [icon("fa-right-left")] })] }),
      node("div", { className: "ve-builder-fields", children: [
        node("span", { className: "ve-builder-field-label", text: t("Spells.SwapOut", "Choose one to forget:") }),
        node("div", { className: "ve-builder-chips", children: outChips }),
        node("span", { className: "ve-builder-field-label", text: t("Spells.SwapIn", "Then choose its replacement:") })] }),
      inList
    ] });
    if (state.swaps[kind]) section.open = true;
    return section;
  }
  const swaps = [swapSection("cantrip"), swapSection("spell")];

  function refresh() {
    for (const row of rows) paint(row);
    for (const { kind, chips } of swapChipSets) for (const chip of chips) {
      const on = state.swaps[kind]?.out === chip.dataset.out;
      chip.classList.toggle("is-selected", on);
      chip.setAttribute("aria-pressed", String(on));
    }
    renderPrepare();
    renderCounters();
    ctx.validChanged(true); // Next always works; unfilled picks become warnings in Review
  }
  refresh();
  applyFilter();

  return {
    element: node("div", { className: "ve-builder-spells ve-builder-stack", children: [
      node("p", { className: "ve-builder-lead", text: (model.lists?.length ?? 0) > 1
        ? t("Spells.LeadSecrets", "{className} {level}: choose from the Bard, Cleric, Druid and Wizard spell lists (Magical Secrets).", { className: model.className, level: model.level })
        : model.lists?.[0] && model.lists[0] !== `class:${model.classIdentifier}`
          ? t("Spells.LeadOther", "{className} {level}: choose from the {list} spell list.", { className: model.className, level: model.level, list: listName(model.lists[0]) })
          : t("Spells.Lead", "{className} {level}: choose from the {className} spell list.", { className: model.className, level: model.level }) }),
      model.noList ? node("p", { className: "ve-builder-warning", text: t("Spells.NoList", "Your GM hasn't set a spell list for this class, so every allowed spell is shown.") }) : null,
      // L20 fixes: what the step does on its own, and what happens outside level-ups.
      ...(model.fixed ?? []).map(f => node("p", { className: "ve-builder-hint", text: t("Spells.Fixed", "{name} is one of your cantrips: it is added for you.", f) })),
      ...(model.freed ?? []).map(name => node("p", { className: "ve-builder-hint", text: t("Spells.Freed", "{name} is now always prepared, so your earlier pick of it is free for another spell.", { name }) })),
      model.restSwap ? node("p", { className: "ve-builder-hint", text: book
        ? t("Spells.RestSwapBook", "You change which spellbook spells are prepared when you finish a Long Rest, not when you gain a level.")
        : t("Spells.RestSwap", "{className}s change their prepared spells when they finish a Long Rest, not when they gain a level.", { className: model.className }) }) : null,
      counters, carried,
      mainOptions.length ? sheetCard({ className: "ve-builder-spell-card", children: [search,
        node("div", { className: "ve-builder-chips ve-builder-spell-filters", children: [...levelChips, ...toggles] }), mainList] }) : null,
      prepareSection,
      ...swaps
    ] }),
    answer: () => {
      const answer = data();
      return { data: answer, meta: { kind: "spells", warnings: spellWarnings(owed, answer) } };
    }
  };
}
