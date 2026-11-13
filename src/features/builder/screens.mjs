/**
 * Builder step screens. Each renderer takes a plain model and returns
 * { element, answer() → { data, meta } | null }; it calls ctx.validChanged(bool)
 * whenever the Next button should enable or disable.
 */
import { icon, node } from "../../ui/dom.mjs";
import { asiAssignments, asiState } from "../../foundry/systems/dnd5e/builder/asi-math.mjs";
import { spellScreen } from "./spell-screen.mjs";
import { cardNote, emptyCard, rowArt, rowCopy, sheetCard, rowMeta } from "./ve-parts.mjs";

const mod = v => { const m = Math.floor((v - 10) / 2); return m >= 0 ? `+${m}` : `−${Math.abs(m)}`; };
const signed = v => (v >= 0 ? `+${v}` : `−${Math.abs(v)}`);

/** The selection mark at the end of a row: an empty or filled circle (one pick) or box (several). */
const selectionMark = (on, multi) => icon(multi ? (on ? "fa-square-check" : "fa-square") : (on ? "fa-circle-check" : "fa-circle"), on ? "solid" : "regular");

/**
 * VE item rows in a VE card, single or multiple selection, optional search and a lazy details
 * chevron. heading: { title, iconName } for the card's heading (optional).
 */
function choiceList(options, { scope, ctx, max = 1, selected = [], search = options.length > 8, onChange, blockerText, heading = null, before = [] }) {
  const chosen = new Set(selected.filter(uuid => options.some(o => o.uuid === uuid)));
  const list = node("div", { className: "ve-builder-cards ve-builder-list", attrs: { role: max === 1 ? "radiogroup" : "group" } });
  const rows = [];
  const refresh = () => {
    for (const { option, button, mark } of rows) {
      const on = chosen.has(option.uuid);
      button.classList.toggle("is-selected", on);
      button.setAttribute("aria-checked", String(on));
      mark.replaceChildren(selectionMark(on, max > 1));
      const blocked = option.blockers?.length && !on;
      button.disabled = Boolean(blocked && !ctx.isGM) || (!on && max > 1 && chosen.size >= max);
    }
    onChange?.([...chosen]);
  };
  for (const option of options) {
    const details = node("div", { className: "ve-builder-card-details", attrs: { hidden: true } });
    const reasons = option.blockers?.length ? blockerText(option.blockers) : "";
    const mark = node("span", { className: "ve-builder-card-check", attrs: { "aria-hidden": "true" } });
    const button = node("button", {
      className: "ve-builder-card ve-sheet-item-row", attrs: { type: "button", role: max === 1 ? "radio" : "checkbox", "aria-checked": "false" },
      on: { click: () => {
        if (chosen.has(option.uuid)) chosen.delete(option.uuid);
        else { if (max === 1) chosen.clear(); chosen.add(option.uuid); }
        refresh();
      } },
      children: [
        rowArt(option.img, "fa-star"),
        rowCopy(option.name,
          rowMeta(option.source, option.tier),
          reasons ? node("small", { className: "ve-builder-warning", text: reasons }) : null),
        mark
      ]
    }, scope);
    const more = option.uuid ? node("button", {
      className: "ve-builder-more", attrs: { type: "button", "aria-expanded": "false", "aria-label": `${ctx.t("Details", "Details")}: ${option.name}` },
      children: [icon("fa-chevron-right"), node("span", { className: "ve-builder-sr", text: ctx.t("Details", "Details") })],
      on: { click: async () => {
        const open = details.hidden;
        details.hidden = !open;
        more.setAttribute("aria-expanded", String(open));
        if (open && !details.dataset.loaded) {
          details.dataset.loaded = "1";
          details.textContent = ctx.t("Loading", "Loading…");
          const html = await ctx.controller.details(option.uuid).catch(() => "");
          if (!scope.disposed) { details.innerHTML = html || ""; if (!html) details.textContent = ctx.t("NoDescription", "No description."); }
        }
      } }
    }, scope) : null;
    const wrap = node("div", { className: `ve-builder-card-wrap${more ? "" : " is-plain"}`, dataset: { name: option.name.toLowerCase() }, children: [button, more, details] });
    rows.push({ option, button, wrap, mark });
    list.append(wrap);
  }
  const filter = search ? node("label", { className: "ve-builder-search-row", children: [icon("fa-magnifying-glass"), node("input", {
    className: "ve-builder-search", attrs: { type: "search", placeholder: ctx.t("Search", "Search"), "aria-label": ctx.t("Search", "Search") },
    on: { input: event => {
      const q = event.currentTarget.value.trim().toLowerCase();
      query = q;
      applyVisible();
    } }
  }, scope)] }) : null;
  // Search, and an outside filter (a spell list): rows outside the filter are hidden and unpicked.
  let query = "";
  let allowed = () => true;
  function applyVisible() {
    for (const { option, wrap } of rows) wrap.hidden = !allowed(option) || (Boolean(query) && !wrap.dataset.name.includes(query));
  }
  queueMicrotask(refresh);
  const element = sheetCard({ title: heading?.title ?? "", iconName: heading?.iconName ?? "", className: "ve-builder-choice", children: [...before, filter, list] });
  return { element, chosen,
    /** Show only options passing `fn`; picks outside it are dropped. */
    setFilter(fn) {
      allowed = fn ?? (() => true);
      for (const option of options) if (chosen.has(option.uuid) && !allowed(option)) chosen.delete(option.uuid);
      applyVisible();
      refresh();
    } };
}

const blockerTextFor = t => blockers => blockers.map(b => {
  if (b.key === "level") return t("Blocker.Level", "Needs level {level}", { level: b.level });
  if (b.key === "repeat") return t("Blocker.Repeat", "Already taken");
  if (b.key === "items") return t("Blocker.Items", "Needs {items}", { items: b.items.join(", ") });
  if (b.abilities) return t("Blocker.Multiclass", "{name} needs 13+ in {abilities}", { name: b.name, abilities: b.abilities.map(a => a.toUpperCase()).join(b.any ? " or " : " and ") });
  return "";
}).filter(Boolean).join(" · ");

/**
 * A VE segmented strip (the sheet tab bar's look) for one choice among a few, in a card with a field label.
 * Returns { element, value() }. dataset key marks each button (data-list, data-ability) for tests.
 */
function segmentField({ label, choices, value, onPick = () => {}, scope, disabled = false, dataKey = "value", className = "" }) {
  let current = value ?? choices[0]?.key ?? "";
  let touched = false;
  const buttons = choices.map(c => node("button", { className: "ve-builder-segment", attrs: { type: "button", disabled, [`data-${dataKey}`]: c.key }, text: c.label,
    on: { click: () => { current = c.key; touched = true; paint(); onPick(current); } } }, scope));
  const paint = () => buttons.forEach(b => { const on = b.dataset[dataKey] === current; b.classList.toggle("is-selected", on); b.setAttribute("aria-pressed", String(on)); });
  paint();
  return { element: node("div", { className: `ve-builder-fields ve-builder-segment-field${className ? ` ${className}` : ""}`, children: [
    node("span", { className: "ve-builder-field-label", text: label }), node("div", { className: "ve-builder-segments", children: buttons })] }), value: () => current,
    /** Has the player tapped this strip? */
    touched: () => touched,
    /** Select a value for the player (no onPick); ignored if it isn't offered. */
    set(key) { if (choices.some(c => c.key === key)) { current = key; paint(); } } };
}

/** Spellcasting abilities of the SRD classes, when the class item can't be read. */
const CLASS_ABILITY = { artificer: "int", bard: "cha", cleric: "wis", druid: "wis", paladin: "cha", ranger: "wis", sorcerer: "cha", warlock: "cha", wizard: "int" };

/**
 * The spellcasting ability of a spell list's class ("class:cleric" → "wis"): the SRD map at once, then the class
 * item's own (found through dnd5e's class registry) when it says otherwise.
 */
function listAbility(listKey, onAbility) {
  const [type, identifier] = String(listKey ?? "").split(":");
  if (type !== "class" || !identifier) return;
  const fallback = CLASS_ABILITY[identifier];
  if (fallback) onAbility(fallback);
  const uuid = globalThis.dnd5e?.registry?.classes?.get?.(identifier)?.sources?.[0];
  if (!uuid) return;
  Promise.resolve(globalThis.fromUuid?.(uuid)).then(doc => {
    const ability = doc?.system?.spellcasting?.ability;
    if (ability && ability !== fallback) onAbility(ability);
  }).catch(() => {});
}

/** A choice card's heading in the step's own words: "Choose 2 cantrips", "Choose 1 spell", "Choose 1 feat", else "Choose 1". */
function choiceHeading(model, ctx) {
  const n = model.count;
  if (model.itemType === "spell") {
    const cantrips = model.options.length && model.options.every(o => o.level === 0);
    return cantrips ? ctx.t(n === 1 ? "ChooseCantrip" : "ChooseCantrips", n === 1 ? "Choose {count} cantrip" : "Choose {count} cantrips", model)
      : ctx.t(n === 1 ? "ChooseSpell" : "ChooseSpells", n === 1 ? "Choose {count} spell" : "Choose {count} spells", model);
  }
  if (model.itemType === "feat") return ctx.t(n === 1 ? "ChooseFeat" : "ChooseFeats", n === 1 ? "Choose {count} feat" : "Choose {count} feats", model);
  return ctx.t("ChooseCount", "Choose {count}", model);
}

/** The spellcasting ability choice for granted or chosen spells (High Elf, Magic Initiate), when there is one. */
function abilityField(model, ctx, scope) {
  if (!(model.abilityChoices?.length > 1)) return null;
  return segmentField({ label: ctx.t("SpellChoice.Ability", "Spellcasting ability"), choices: model.abilityChoices,
    value: model.answer?.ability ?? model.ability, scope, dataKey: "ability", className: "ve-builder-ability-choice" });
}

/** A big choice as a VE row: icon tile, title, subtitle and a selection mark. */
function bigChoiceContent(iconName, title, hint, on) {
  return [rowArt(null, iconName), rowCopy(title, node("small", { text: hint })), node("span", { className: "ve-builder-card-check", attrs: { "aria-hidden": "true" }, children: [selectionMark(on, false)] })];
}

export const STEP_SCREENS = {
  HitPoints(model, ctx, scope) {
    const locked = ctx.controller.lockedRoll(model);
    let method = model.meta?.hp?.method ?? (locked ? "roll" : "");
    let roll = locked?.value ?? null;
    const total = node("p", { className: "ve-builder-hp-total" });
    const rollButton = node("button", { className: "ve-builder-big-choice ve-sheet-item-row", attrs: { type: "button" }, on: { click: async () => {
      if (roll === null) {
        rollButton.disabled = true;
        try { roll = (await ctx.controller.rollHitPoints(model)).value; }
        catch (error) { ctx.error(error.message); rollButton.disabled = false; return; }
      }
      method = "roll";
      refresh();
    } } }, scope);
    const avgButton = node("button", { className: "ve-builder-big-choice ve-sheet-item-row", attrs: { type: "button" }, on: { click: () => { method = "avg"; refresh(); } } }, scope);
    const refresh = () => {
      rollButton.replaceChildren(...bigChoiceContent("fa-dice-d20", roll === null ? ctx.t("HP.Roll", "Roll d{die}", { die: model.die }) : ctx.t("HP.Rolled", "Rolled {roll}", { roll }),
        roll === null ? ctx.t("HP.RollHint", "The roll goes to chat and is locked in") : ctx.t("HP.Locked", "Locked in"), method === "roll"));
      avgButton.replaceChildren(...bigChoiceContent("fa-scale-balanced", ctx.t("HP.Average", "Take average ({avg})", { avg: model.average }),
        roll !== null ? ctx.t("HP.AverageLocked", "Not available after rolling") : ctx.t("HP.AverageHint", "The safe choice"), method === "avg"));
      avgButton.disabled = roll !== null;
      rollButton.classList.toggle("is-selected", method === "roll");
      avgButton.classList.toggle("is-selected", method === "avg");
      const base = method === "roll" ? roll : method === "avg" ? model.average : null;
      total.classList.toggle("is-set", base !== null);
      total.textContent = base === null ? ctx.t("HP.Choose", "Choose how to gain hit points.")
        : ctx.t("HP.Total", "+{total} max HP ({base} {mod} {label})", { total: Math.max(1, base + model.mod), base, mod: signed(model.mod), label: model.modLabel });
      ctx.validChanged(base !== null);
    };
    refresh();
    return {
      element: sheetCard({ title: ctx.t("HP.Lead", "{className} level {level}: hit die d{die}", model), iconName: "fa-heart", className: "ve-builder-hp",
        children: [node("div", { className: "ve-builder-cards ve-builder-list", children: [rollButton, avgButton] }), total] }),
      answer: () => ({ data: { value: method === "roll" ? roll : "avg" },
        meta: { hp: { method, roll: method === "roll" ? roll : model.average, die: model.die, mod: model.mod, modLabel: model.modLabel,
          classIdentifier: model.classIdentifier, level: model.level } } })
    };
  },

  Size(model, ctx, scope) {
    let size = model.answer?.size ?? "";
    const buttons = model.options.map(o => node("button", { className: "ve-builder-segment", attrs: { type: "button" }, text: o.label,
      on: { click: () => { size = o.key; refresh(); } } }, scope));
    const refresh = () => { buttons.forEach((b, i) => b.classList.toggle("is-selected", model.options[i].key === size)); ctx.validChanged(Boolean(size)); };
    refresh();
    return { element: node("div", { className: "ve-builder-segments", children: buttons }), answer: () => ({ data: { size } }) };
  },

  Subclass(model, ctx, scope) {
    if (!model.options.length) {
      ctx.validChanged(false);
      return { element: emptyCard(ctx.t("NoSubclasses", "No {className} subclasses were found in the compendiums.", model)), answer: () => null };
    }
    let pick = model.answer?.uuid ? [model.answer.uuid] : [];
    const list = choiceList(model.options, { scope, ctx, selected: pick, blockerText: blockerTextFor(ctx.t), onChange: c => { pick = c; ctx.validChanged(c.length === 1); } });
    return { element: list.element, answer: () => ({ data: { uuid: pick[0] }, meta: { kind: "subclass", name: model.options.find(o => o.uuid === pick[0])?.name } }) };
  },

  AbilityScoreImprovement(model, ctx, scope) {
    let mode = model.answer?.type === "feat" ? "feat" : "asi";
    const assigned = {};
    if (model.answer?.type === "asi") for (const [k, v] of Object.entries(model.answer.assignments ?? {})) assigned[k] = v - (Number(model.config.fixed?.[k]) || 0);
    let featPick = model.answer?.type === "feat" ? [model.answer.uuid] : [];
    const canImprove = k => model.canImprove[k] !== false;

    const remaining = cardNote("", "ve-builder-asi-remaining");
    const grid = node("div", { className: "ve-builder-asi-grid" });
    const cells = {};
    for (const [key, score] of Object.entries(model.scores)) {
      const value = node("strong");
      const modText = node("small");
      const minus = node("button", { className: "ve-builder-step-btn", attrs: { type: "button", "aria-label": ctx.t("ASI.Decrease", "Lower {ability}", { ability: score.label }) }, children: [icon("fa-minus")],
        on: { click: () => { assigned[key] = Math.max(0, (assigned[key] ?? 0) - 1); refresh(); } } }, scope);
      const plus = node("button", { className: "ve-builder-step-btn", attrs: { type: "button", "aria-label": ctx.t("ASI.Increase", "Raise {ability}", { ability: score.label }) }, children: [icon("fa-plus")],
        on: { click: () => { assigned[key] = (assigned[key] ?? 0) + 1; refresh(); } } }, scope);
      cells[key] = { value, modText, minus, plus };
      grid.append(node("div", { className: "ve-builder-asi-cell", children: [node("span", { text: score.abbr }), value, modText, node("div", { className: "ve-builder-asi-buttons ve-builder-stepper", children: [minus, plus] })] }));
    }
    const asiPanel = sheetCard({ title: ctx.t("ASI.Scores", "Ability scores"), iconName: "fa-dumbbell", children: [remaining, grid] });

    const featList = model.allowFeat ? choiceList(model.feats, { scope, ctx, selected: featPick, blockerText: blockerTextFor(ctx.t),
      heading: { title: ctx.t("ASI.Feat", "Feat"), iconName: "sheet:features" },
      onChange: c => { featPick = c; if (mode === "feat") ctx.validChanged(c.length === 1); } }) : null;
    const featPanel = featList ? featList.element : null;

    const tabs = model.allowFeat ? ["asi", "feat"].map(m => node("button", { className: "ve-builder-segment", attrs: { type: "button" },
      text: m === "asi" ? ctx.t("ASI.Scores", "Ability scores") : ctx.t("ASI.Feat", "Feat"),
      on: { click: () => { mode = m; refresh(); } } }, scope)) : [];

    const refresh = () => {
      const state = asiState(model.config, model.scores, assigned, canImprove);
      for (const [key, cell] of Object.entries(cells)) {
        const a = state.abilities[key];
        cell.value.textContent = String(a.value);
        cell.value.classList.toggle("is-raised", a.value > a.base);
        cell.modText.textContent = mod(a.value);
        cell.plus.disabled = !a.canIncrease;
        cell.minus.disabled = !a.canDecrease;
      }
      remaining.textContent = ctx.t("ASI.Remaining", "{remaining} of {points} points left (max +{cap} per ability)", state);
      tabs.forEach((b, i) => b.classList.toggle("is-selected", (i === 0 ? "asi" : "feat") === mode));
      asiPanel.hidden = mode !== "asi";
      if (featPanel) featPanel.hidden = mode !== "feat";
      ctx.validChanged(mode === "asi" ? state.remaining === 0 || state.complete : featPick.length === 1);
    };
    refresh();
    return {
      element: node("div", { className: "ve-builder-stack", children: [tabs.length ? node("div", { className: "ve-builder-segments", children: tabs }) : null, asiPanel, featPanel] }),
      answer: () => mode === "feat" ? { data: { type: "feat", uuid: featPick[0] }, meta: { name: model.feats.find(f => f.uuid === featPick[0])?.name } }
        : { data: { type: "asi", assignments: asiAssignments(model.config, assigned) } }
    };
  },

  ItemChoice(model, ctx, scope) {
    let picks = model.answer?.selected ?? [];
    // L20 fix 3: dnd5e's "replace an earlier pick" (Fighting Style, invocations, Mystic Arcanum, Magical Discoveries):
    // an optional card; choosing what to replace asks for one more new pick.
    const replaceable = model.replaceable ?? [];
    let replace = replaceable.some(r => r.id === model.answer?.replace) ? model.answer.replace : "";
    const missingNote = model.missing?.length ? cardNote(ctx.t("MissingOptions", "Not in your compendiums, so not offered: {names}", { names: model.missing.join(", ") }), "ve-builder-warning") : null;
    if (!model.options.length) {
      ctx.validChanged(model.count === 0);
      return { element: emptyCard(ctx.t("NoOptions", "No options were found in the compendiums for this choice.")), answer: () => (model.count === 0 ? { data: { selected: [] } } : null) };
    }
    const spells = model.itemType === "spell";
    // Spells (Magic Initiate): one spell list for all of the feat's picks, chosen first; it filters the rows.
    const lists = spells && model.spellLists?.length > 1 ? model.spellLists : [];
    let listKey = lists.length ? (model.answer?.list ?? model.list ?? lists[0].key) : null;
    const inList = o => !listKey || !o.lists || o.lists.includes(listKey);
    const visibleCount = () => model.options.filter(inList).length;
    const wanted = () => model.count + (replace ? 1 : 0);
    const valid = () => picks.length === Math.min(wanted(), visibleCount());
    const listField = lists.length ? segmentField({ label: ctx.t("SpellChoice.List", "Spell list"), choices: lists, value: listKey, scope, dataKey: "list",
      disabled: Boolean(model.listLocked), className: "ve-builder-list-choice",
      onPick: key => { listKey = key; list.setFilter(inList); followList(); } }) : null;
    const ability = spells ? abilityField(model, ctx, scope) : null;
    // Until the player taps the ability strip, it follows the list's class (Cleric → Wisdom); a saved answer or a
    // list fixed by the feat's earlier pick keeps the ability the step suggests.
    const followList = () => { if (ability && listKey) listAbility(listKey, key => { if (!ability.touched() && !scope.disposed) ability.set(key); }); };
    if (!model.answer?.ability && !model.listLocked) followList();
    const options = spells ? model.options.map(o => ({ ...o, source: [o.level === undefined ? "" : o.level === 0 ? ctx.t("Spells.Cantrip", "Cantrip")
      : ctx.t("Spells.Level", "Level {level}", { level: o.level }), o.source].filter(Boolean).join(" · ") })) : model.options;
    const needNote = replaceable.length ? cardNote("", "ve-builder-asi-remaining") : null;
    const paintNeed = () => {
      if (!needNote) return;
      needNote.textContent = wanted()
        ? ctx.t("ReplaceNeed", "Choose {count} ({done}/{count})", { count: wanted(), done: picks.length })
        : ctx.t("ReplaceSkip", "Nothing to choose this level unless you replace an earlier pick. Next keeps everything as it is.");
    };
    const list = choiceList(options, { scope, ctx, max: Math.max(1, model.count + (replaceable.length ? 1 : 0)), selected: picks, blockerText: blockerTextFor(ctx.t),
      heading: { title: model.count ? choiceHeading(model, ctx) : ctx.t("ReplaceHeading", "New pick (if you replace one)"), iconName: spells ? "sheet:spells" : "sheet:features" },
      before: [listField?.element, ability?.element, missingNote, needNote].filter(Boolean),
      onChange: c => { picks = c; paintNeed(); ctx.validChanged(valid()); } });
    if (lists.length) list.setFilter(inList);
    let replaceCard = null;
    if (replaceable.length) {
      const rows = replaceable.map(r => ({ uuid: r.id, name: r.name, img: r.img, source: "", blockers: [] }));
      const replaceList = choiceList(rows, { scope, ctx, max: 1, selected: replace ? [replace] : [], blockerText: blockerTextFor(ctx.t), search: false,
        heading: { title: ctx.t("ReplaceTitle", "Change an earlier pick? (optional)"), iconName: "fa-arrows-rotate" },
        before: [cardNote(ctx.t("ReplaceHint", "Choose one to replace, then pick its replacement below. Tap it again to keep it."), "")],
        onChange: c => { replace = c[0] ?? ""; paintNeed(); ctx.validChanged(valid()); } });
      replaceCard = replaceList.element;
      replaceCard.classList.add("ve-builder-replace");
    }
    paintNeed();
    queueMicrotask(() => ctx.validChanged(valid()));
    const element = replaceCard ? node("div", { className: "ve-builder-stack", children: [replaceCard, list.element] }) : list.element;
    return { element, answer: () => ({ data: { selected: picks,
      ...(replace && picks.length > model.count ? { replace } : {}),
      ...(lists.length ? { list: listKey } : {}), ...(ability ? { ability: ability.value() } : {}) } }) };
  },

  ItemGrant(model, ctx, scope) {
    const on = new Set(model.answer?.selected ?? model.items.map(i => i.uuid));
    const rows = model.items.map(item => {
      const box = node("input", { attrs: { type: "checkbox", disabled: !item.optional }, on: { change: e => { if (e.currentTarget.checked) on.add(item.uuid); else on.delete(item.uuid); } } }, scope);
      box.checked = on.has(item.uuid);
      return node("label", { className: "ve-builder-grant ve-sheet-item-row", children: [rowArt(item.img, "sheet:features"), rowCopy(item.name), box] });
    });
    // High Elf, Drow, Tiefling lineage spells: the spellcasting ability they use.
    const ability = abilityField(model, ctx, scope);
    ctx.validChanged(true);
    return { element: sheetCard({ className: "ve-builder-grants", children: [ability?.element, node("div", { className: "ve-builder-list", children: rows })] }),
      answer: () => ({ data: { selected: [...on], ...(ability ? { ability: ability.value() } : {}) } }) };
  },

  Trait(model, ctx, scope) {
    const chosen = model.slots.map(() => new Set());
    const prior = new Set(model.answer?.chosen ?? []);
    model.slots.forEach((slot, i) => slot.options.forEach(o => { if (prior.has(o.key) && chosen[i].size < slot.count) { chosen[i].add(o.key); prior.delete(o.key); } }));
    // No saved answer: tick what dnd5e pre-checks (a replacement slot's grants still to give, e.g. 2014 Acolyte's Religion).
    if (!model.answer?.chosen?.length) {
      model.slots.forEach((slot, i) => (slot.preselected ?? []).forEach(key => {
        if (chosen[i].size < slot.count && slot.options.some(o => o.key === key)) chosen[i].add(key);
      }));
    }
    const chipSets = [];
    // dnd5e's fixed grants (slot.granted: Background "Common") are taken as they are and listed as granted.
    // A choice with only one option left is picked for the player, and still shown as a choice.
    const granted = [];
    const sections = model.slots.map((slot, i) => {
      if (slot.granted) {
        slot.options.forEach(o => chosen[i].add(o.key));
        granted.push(...slot.options);
        return null;
      }
      const only = slot.options.length > 0 && slot.options.length <= slot.count;
      if (only && !chosen[i].size) slot.options.forEach(o => chosen[i].add(o.key));
      const counter = node("h3");
      const chips = slot.options.map(o => node("button", { className: "ve-builder-chip", attrs: { type: "button", "aria-pressed": "false" },
        text: o.group ? `${o.label}` : o.label,
        on: { click: () => {
          if (chosen[i].has(o.key)) chosen[i].delete(o.key);
          else if (chosen[i].size < slot.count) chosen[i].add(o.key);
          else if (slot.count === 1) { chosen[i].clear(); chosen[i].add(o.key); }
          refresh();
        } } }, scope));
      chipSets.push({ chips, slot, counter, index: i });
      // Languages ("any language" house rule): chips under their group's label, and a search for long lists.
      const groups = [...new Set(slot.options.map(o => o.group ?? ""))];
      const grouped = groups.length > 1 || (groups.length === 1 && groups[0]);
      // "Languages - Standard Languages", "Languages - Rare Languages": drop the prefix every group shares.
      const shared = groups.every(g => g.includes(" - ")) ? groups[0].split(" - ")[0] + " - " : "";
      const groupLabel = g => (shared && groups.every(x => x.startsWith(shared)) ? g.slice(shared.length) : g);
      const groupSections = grouped ? groups.map(group => {
        const groupChips = chips.filter((_, j) => (slot.options[j].group ?? "") === group);
        return node("div", { className: "ve-builder-chip-group", dataset: { group }, children: [
          group ? node("span", { className: "ve-builder-field-label", text: groupLabel(group) }) : null,
          node("div", { className: "ve-builder-chips", children: groupChips })] });
      }) : null;
      const filter = slot.options.length > 20 ? node("label", { className: "ve-builder-search-row", children: [icon("fa-magnifying-glass"), node("input", {
        className: "ve-builder-search", attrs: { type: "search", placeholder: ctx.t("Search", "Search"), "aria-label": ctx.t("Search", "Search") },
        on: { input: event => {
          const q = event.currentTarget.value.trim().toLowerCase();
          chips.forEach((chip, j) => { const o = slot.options[j]; chip.hidden = Boolean(q) && !`${o.label} ${o.group ?? ""}`.toLowerCase().includes(q); });
          for (const section of groupSections ?? []) section.hidden = ![...section.querySelectorAll(".ve-builder-chip")].some(c => !c.hidden);
        } } }, scope)] }) : null;
      return node("section", { className: "ve-sheet-card ve-builder-sheet-card ve-builder-trait-slot", children: [
        node("header", { className: "ve-sheet-card-heading", children: [icon("fa-list-check"), counter] }),
        only ? cardNote(ctx.t("TraitOnly", "Only option: {name}", { name: slot.options.map(o => o.label).join(", ") }), "ve-builder-only-option") : null,
        // dnd5e's replacement slot (allowReplacements): a grant the character already has frees a pick.
        slot.replacement ? cardNote(ctx.t("TraitReplacement", "Already known — choose a replacement"), "ve-builder-only-option") : null, filter,
        grouped ? node("div", { className: "ve-builder-chip-groups", children: groupSections }) : node("div", { className: "ve-builder-chips", children: chips })].filter(Boolean) });
    });
    const refresh = () => {
      const taken = new Set(chosen.flatMap(s => [...s]));
      chipSets.forEach(({ chips, slot, counter, index: i }) => {
        chips.forEach((chip, j) => {
          const key = slot.options[j].key;
          const on = chosen[i].has(key);
          chip.classList.toggle("is-selected", on);
          chip.setAttribute("aria-pressed", String(on));
          chip.disabled = !on && taken.has(key);
        });
        counter.textContent = ctx.t("TraitPick", "Choose {count} ({done}/{count})", { count: slot.count, done: chosen[i].size });
      });
      ctx.validChanged(chipSets.every(({ slot, index }) => chosen[index].size === Math.min(slot.count, slot.options.length)));
    };
    refresh();
    const grantedCard = granted.length ? sheetCard({ className: "ve-builder-granted", children: [node("ul", { className: "ve-builder-list", children: granted.map(o =>
      node("li", { className: "ve-builder-granted-row", children: [icon("fa-circle-check"), node("span", { text: ctx.t("TraitGranted", "{name} — granted", { name: o.label }) })] })) })] }) : null;
    return { element: node("div", { className: "ve-builder-stack", children: [grantedCard, ...sections.filter(Boolean)].filter(Boolean) }),
      answer: () => ({ data: { chosen: chosen.flatMap(s => [...s]) } }) };
  },

  Spells: spellScreen,

  unsupported(model, ctx, scope) {
    ctx.validChanged(false);
    return { element: emptyCard(ctx.t("Unsupported", "“{title}” is a step Mobile Deck can't show yet. dnd5e's own level-up window can finish this level-up instead.", model),
      node("div", { className: "ve-builder-card-actions", children: [
        node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, text: ctx.t("UseNative", "Use dnd5e's window"), on: { click: () => ctx.nativeFallback() } }, scope)] })),
    answer: () => null };
  }
};

/**
 * A step re-opened because a saved pick is now granted by another tab (creation, data fix 4): VE's attention
 * card with the controller's text. Null when the step has no conflict.
 */
function conflictBanner(model, t = null) {
  if (!model?.conflictText) return null;
  const tr = t ?? ((key, fallback) => (globalThis.game?.i18n?.has?.(`VEMOBILE.Builder.${key}`) ? globalThis.game.i18n.localize(`VEMOBILE.Builder.${key}`) : fallback));
  return sheetCard({ title: tr("Creation.NeedsAttention", "Needs attention"), iconName: "fa-triangle-exclamation", className: "ve-builder-attention ve-builder-conflict",
    attrs: { role: "status" }, children: [cardNote(model.conflictText, "ve-builder-conflict-text")] });
}

export { choiceList, blockerTextFor, conflictBanner, emptyCard };
