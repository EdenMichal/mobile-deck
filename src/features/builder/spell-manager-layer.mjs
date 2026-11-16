/**
 * Player feedback (fork): the Manage spells layer, opened from the wand icon on the sheet's Spells tab.
 * Home: each casting class with its counters and spells (remove the class's own picks).
 * Add: the class's spell list with search and level chips; tap + to add, tap a row for the spell's details.
 * Built on the builder's shell and parts so it looks like the rest of the Character Builder.
 */
import { icon, node } from "../../ui/dom.mjs";
import { itemDetailModal } from "../characters/systems/dnd5e/presenter.mjs";
import { createShell, createScope } from "./builder-shell.mjs";
import { emptyCard, rowArt, rowCopy, sheetCard, tierChip } from "./ve-parts.mjs";

const levelLabel = (t, level) => (level === 0 ? t("Spells.Cantrip", "Cantrip") : t("Spells.Level", "Level {level}", { level }));

export function mountSpellManager(host, manager, { t, onClose = () => {} }) {
  const shell = createShell(host, { t, subtitle: manager.actorName, controller: {}, headIcon: "fa-wand-sparkles", onClose });
  shell.layer.classList.add("ve-spell-manager-layer");
  const { frame, work, setBody, showError } = shell;
  let notice = "";

  const subtitleOf = spell => [levelLabel(t, spell.level), spell.schoolLabel, spell.components].filter(Boolean).join(" · ");

  // Mobile Deck's own item detail window for one spell; `action` adds a button at the bottom.
  let closeDetails = null;
  async function openDetails(uuid, action = null) {
    if (!uuid) return;
    const record = await manager.spellDetails(uuid).catch(() => null);
    if (!record || shell.scope.disposed) return;
    closeDetails?.();
    const windowScope = createScope();
    const close = () => { windowScope.dispose(); if (closeDetails === close) closeDetails = null; };
    closeDetails = close;
    const modal = itemDetailModal(record, close, windowScope, {
      localize: (key, fallback) => (globalThis.game?.i18n?.has?.(key) ? globalThis.game.i18n.localize(key) : fallback),
      readLocale: () => globalThis.game?.i18n?.lang ?? "en"
    });
    if (!modal) { close(); return; }
    if (action) {
      const button = node("button", { className: "ve-builder-primary ve-builder-spell-pick", attrs: { type: "button" },
        children: [icon(action.icon), node("span", { text: action.label })], on: { click: () => { close(); action.run(); } } }, windowScope);
      modal.querySelector(".ve-item-modal-content")?.append(node("div", { className: "ve-builder-spell-pick-bar", children: [button] }));
    }
    modal.dataset.veBackDismissable = "true";
    windowScope.listen(modal, "ve-close", event => { event.stopPropagation(); close(); });
    shell.layer.append(modal);
    windowScope.own(() => modal.remove());
    shell.scope.own(close);
  }

  function counterTiles(record) {
    const tiles = [];
    if (record.counts.cantrips.max) tiles.push([t("Spells.Cantrips", "Cantrips"), record.counts.cantrips]);
    if (record.spellbook) tiles.push([t("Spells.Spellbook", "Spellbook"), { have: record.counts.spellbook, max: null }]);
    if (record.counts.prepared.max) tiles.push([t("Spells.Prepared", "Prepared"), record.counts.prepared]);
    const counters = node("div", { className: "ve-builder-spell-counters", children: tiles.map(([label, c]) => node("div", {
      className: `ve-builder-spell-counter${c.max !== null && c.have > c.max ? " is-over" : c.max !== null && c.have === c.max ? " is-done" : ""}`,
      children: [node("small", { text: label }), node("strong", { text: c.max === null ? String(c.have) : `${c.have} / ${c.max}` })] })) });
    counters.dataset.count = String(tiles.length);
    return counters;
  }

  function home() {
    const scope = frame({ screen: "spell-manager", heading: t("Manage.Title", "Manage spells") });
    let classes = [];
    try { classes = manager.classes(); } catch (error) { showError(error?.message ?? String(error)); }
    if (!classes.length) { setBody(emptyCard(t("Manage.NoCasting", "This character has no spellcasting class."))); return; }
    const cards = classes.map(record => {
      const rows = record.spells.map(spell => {
        const remove = spell.fixed
          ? node("span", { className: "ve-spell-manager-fixed", attrs: { title: t("Manage.Fixed", "A feature gives this spell") }, children: [icon("fa-lock")] })
          : node("button", { className: "ve-builder-spell-check ve-spell-manager-remove", attrs: { type: "button", "aria-label": t("Manage.RemoveName", "Remove {name}", { name: spell.name }) },
            children: [icon("fa-trash-can")], on: { click: () => void work(async () => {
              const { name } = await manager.remove(record.identifier, spell.id);
              notice = t("Manage.Removed", "Removed {name}.", { name });
              home();
            }) } }, scope);
        const open = node("button", { className: "ve-builder-spell-open ve-sheet-item-row", attrs: { type: "button" },
          on: { click: () => void openDetails(spell.uuid) }, children: [rowArt(spell.img, "fa-wand-sparkles"),
            rowCopy(spell.name, node("small", { text: subtitleOf(spell) }),
              spell.level && record.spellbook && spell.prepared !== 1 && !spell.fixed ? node("span", { className: "ve-builder-spell-tags", children: [node("span", { className: "ve-builder-tag", text: t("Manage.InBook", "In spellbook") })] }) : null),
            spell.uuid ? icon("fa-chevron-right") : null] }, scope);
        return node("div", { className: `ve-builder-spell-row${spell.fixed ? " is-fixed" : ""}`, children: [open, remove] });
      });
      const add = node("button", { className: "ve-builder-primary ve-spell-manager-add", attrs: { type: "button" },
        children: [icon("fa-plus"), node("span", { text: t("Manage.Add", "Add spells") })], on: { click: () => void work(() => addScreen(record.identifier)) } }, scope);
      const hint = record.maxSpellLevel ? t("Manage.UpTo", "Spells up to level {level}.", { level: record.maxSpellLevel }) : t("Manage.CantripsOnly", "Cantrips only for now.");
      return sheetCard({ title: record.subclass ? `${record.name} · ${record.subclass}` : record.name, iconName: `class:${record.identifier}`, className: "ve-spell-manager-card", children: [
        counterTiles(record),
        node("p", { className: "ve-builder-hint", text: hint }),
        rows.length ? node("div", { className: "ve-builder-spell-list", children: rows }) : node("p", { className: "ve-builder-empty", text: t("Manage.None", "No spells yet.") }),
        node("div", { className: "ve-builder-card-actions", children: [add] })
      ] });
    });
    setBody(notice ? node("p", { className: "ve-builder-hint ve-spell-manager-notice", attrs: { role: "status" }, text: notice }) : null, ...cards);
    notice = "";
  }

  async function addScreen(identifier) {
    const record = manager.classes().find(c => c.identifier === identifier);
    if (!record) return home();
    const result = await manager.options(identifier);
    const scope = frame({ screen: "spell-manager-add", heading: t("Manage.AddTo", "Add {name} spells", { name: record.name }), back: () => home() });
    if (!result.options.length) {
      setBody(counterTiles(record), emptyCard(result.noList ? t("Manage.NoList", "No spell list was found for this class.") : t("Manage.NoneLeft", "There are no more spells to add.")));
      return;
    }
    const filter = { level: "all", query: "" };
    const levels = [...new Set(result.options.map(o => o.level))].sort((a, b) => a - b);
    const chips = ["all", ...levels].map(level => node("button", { className: "ve-builder-chip", attrs: { type: "button", "aria-pressed": "false" },
      dataset: { level: String(level) }, text: level === "all" ? t("Spells.All", "All") : levelLabel(t, level),
      on: { click: () => { filter.level = String(level); applyFilter(); } } }, scope));
    const search = node("label", { className: "ve-builder-search-row", children: [icon("fa-magnifying-glass"), node("input", { className: "ve-builder-search",
      attrs: { type: "search", enterkeyhint: "search", placeholder: t("Spells.Search", "Search spells"), "aria-label": t("Spells.Search", "Search spells") },
      on: { input: event => { filter.query = event.currentTarget.value.trim().toLowerCase(); applyFilter(); },
        keydown: event => { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } } } }, scope)] });
    const counters = node("div", { children: [counterTiles(record)] });
    const added = new Set();
    const rows = result.options.map(option => {
      const addOne = () => void work(async () => {
        if (added.has(option.uuid)) return;
        const { name } = await manager.add(identifier, option.uuid);
        added.add(option.uuid);
        row.el.classList.add("is-selected");
        row.check.disabled = true;
        row.check.setAttribute("aria-pressed", "true");
        const fresh = manager.classes().find(c => c.identifier === identifier);
        if (fresh) counters.replaceChildren(counterTiles(fresh));
        showError("");
        status.textContent = t("Manage.Added", "Added {name}.", { name });
      });
      const check = node("button", { className: "ve-builder-spell-check", attrs: { type: "button", "aria-pressed": "false", "aria-label": t("Manage.AddName", "Add {name}", { name: option.name }) },
        children: [icon("fa-plus")], on: { click: addOne } }, scope);
      const open = node("button", { className: "ve-builder-spell-open ve-sheet-item-row", attrs: { type: "button" },
        on: { click: () => void openDetails(option.uuid, added.has(option.uuid) ? null : { icon: "fa-plus", label: t("Manage.Add", "Add spell"), run: addOne }) }, children: [
          rowArt(option.img, "fa-wand-sparkles"),
          rowCopy(option.name, node("small", { text: subtitleOf(option) }), node("span", { className: "ve-builder-spell-tags", children: [
            option.ritual ? node("span", { className: "ve-builder-tag", text: t("Spells.Ritual", "Ritual") }) : null,
            option.concentration ? node("span", { className: "ve-builder-tag", text: t("Spells.Concentration", "Concentration") }) : null,
            option.book || option.source ? node("small", { text: option.book || option.source }) : null,
            tierChip(option.tier)
          ] })),
          icon("fa-chevron-right")
        ] }, scope);
      const row = { option, check, el: node("div", { className: "ve-builder-spell-row", children: [open, check] }) };
      return row;
    });
    const status = node("p", { className: "ve-builder-hint ve-spell-manager-notice", attrs: { role: "status", "aria-live": "polite" } });
    function applyFilter() {
      for (const chip of chips) { const on = chip.dataset.level === filter.level; chip.classList.toggle("is-selected", on); chip.setAttribute("aria-pressed", String(on)); }
      for (const { option, el } of rows) {
        el.hidden = (filter.level !== "all" && String(option.level) !== filter.level) || (Boolean(filter.query) && !option.name.toLowerCase().includes(filter.query));
      }
    }
    applyFilter();
    setBody(counters, status, sheetCard({ className: "ve-builder-spell-card", children: [search,
      node("div", { className: "ve-builder-chips ve-builder-spell-filters", children: chips }),
      node("div", { className: "ve-builder-spell-list", children: rows.map(r => r.el) })] }));
  }

  home();
  return { close: () => shell.close() };
}
