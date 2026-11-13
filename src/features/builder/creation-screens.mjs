/**
 * Phase 4a screens that only creation has: the background +2/+1, Abilities, Equipment and
 * Details (spec §2.3–§2.7). They use VE's cards and rows (ve-parts.mjs) and the builder's chips and segments.
 */
import { icon, node } from "../../ui/dom.mjs";
import {
  ABILITIES, STANDARD_ARRAY, clearAbility, finalScores, placeSlot, pointBuyState, scoresFromSlots, slotsFor,
  suggestedAssignments, validateBackgroundAsi, validateEntered
} from "../../foundry/systems/dnd5e/builder/creation-rules.mjs";
import { cardAction, cardNote, rowArt, rowCopy, sheetCard } from "./ve-parts.mjs";

/** VE's small uppercase field label (the rest dialog's "Hit Die Type"). */
const fieldLabel = text => node("span", { className: "ve-builder-field-label", text });

const mod = v => { const m = Math.floor((v - 10) / 2); return m >= 0 ? `+${m}` : `−${Math.abs(m)}`; };
const copy = value => JSON.parse(JSON.stringify(value ?? {}));

/** Background increase: "+2 and +1" or "+1 to all three", only on the background's abilities. */
export function backgroundAsiScreen(model, ctx, scope) {
  const open = Object.keys(model.scores).filter(k => !model.config.locked.includes(k) && model.canImprove?.[k] !== false);
  const prior = model.answer?.type === "asi" ? model.answer.assignments ?? {} : {};
  const priorKeys = Object.keys(prior).filter(k => Number(prior[k]));
  let mode = priorKeys.length === 3 && priorKeys.every(k => Number(prior[k]) === 1) ? "111" : "21";
  let plus2 = priorKeys.find(k => Number(prior[k]) === 2) ?? null;
  let plus1 = mode === "21" ? priorKeys.find(k => Number(prior[k]) === 1) ?? null : null;
  const assignments = () => (mode === "111" ? Object.fromEntries(open.map(k => [k, 1]))
    : Object.fromEntries([[plus2, 2], [plus1, 1]].filter(([k]) => k)));

  const modes = [["21", ctx.t("BgAsi.TwoOne", "+2 and +1")], ["111", ctx.t("BgAsi.OneOneOne", "+1 to all three")]].map(([key, text]) =>
    node("button", { className: "ve-builder-segment", attrs: { type: "button", "data-mode": key }, text, on: { click: () => { mode = key; refresh(); } } }, scope));
  const chipRow = (cls, amount) => node("div", { className: `ve-builder-chips ${cls}`, children: open.map(k => node("button", {
    className: "ve-builder-chip", attrs: { type: "button", "data-ability": k, "aria-pressed": "false" }, text: model.scores[k].abbr,
    on: { click: () => {
      if (amount === 2) { plus2 = k; if (plus1 === k) plus1 = null; } else { plus1 = k; if (plus2 === k) plus2 = null; }
      refresh();
    } } }, scope)) });
  const row2 = chipRow("ve-builder-bgasi-plus2", 2);
  const row1 = chipRow("ve-builder-bgasi-plus1", 1);
  const pairs = node("div", { className: "ve-builder-fields", children: [fieldLabel(ctx.t("BgAsi.PlusTwo", "+2 to")), row2,
    fieldLabel(ctx.t("BgAsi.PlusOne", "+1 to")), row1] });
  const all = node("p", { className: "ve-builder-lead ve-builder-fields" });
  const summary = node("p", { className: "ve-builder-hp-total" });
  const refresh = () => {
    summary.classList.toggle("is-set", Boolean(mode === "111" || plus2 || plus1));
    modes.forEach(b => b.classList.toggle("is-selected", b.dataset.mode === mode));
    pairs.hidden = mode !== "21";
    all.hidden = mode !== "111";
    all.textContent = open.map(k => `${model.scores[k].abbr} +1`).join(" · ");
    for (const [row, picked] of [[row2, plus2], [row1, plus1]]) {
      row.querySelectorAll("button").forEach(b => { const on = b.dataset.ability === picked; b.classList.toggle("is-selected", on); b.setAttribute("aria-pressed", String(on)); });
    }
    const a = assignments();
    summary.textContent = Object.entries(a).map(([k, v]) => `${model.scores[k].abbr} +${v}`).join(" · ") || ctx.t("BgAsi.Choose", "Choose where the increases go.");
    ctx.validChanged(validateBackgroundAsi(model.config, a).length === 0);
  };
  refresh();
  return {
    element: node("div", { className: "ve-builder-bgasi ve-builder-stack", children: [
      node("p", { className: "ve-builder-hint", text: ctx.t("BgAsi.Lead", "Your background raises {abilities}: +2 to one and +1 to another, or +1 to all three. No score goes above 20.",
        { abilities: open.map(k => model.scores[k].label).join(", ") }) }),
      node("div", { className: "ve-builder-segments", children: modes }),
      sheetCard({ children: [pairs, all, summary] })
    ] }),
    answer: () => ({ data: { type: "asi", assignments: assignments() } })
  };
}

/**
 * Abilities tab. Local changes redraw at once and are saved through actions.save (debounced by the
 * layer); rolling and entering dice go through the controller (chat, locks).
 * @param {{ save: (answer) => void, roll: () => void, enter: (values: number[]) => void }} actions
 */
export function abilitiesScreen(model, ctx, scope, actions) {
  const root = node("div", { className: "ve-builder-abilities ve-builder-stack" });
  let m = model;
  let answer = copy(model.answer);
  let selected = null;
  let entering = false;

  const slotsNow = () => {
    if (answer.method === "pointBuy") return null;
    if (answer.method === "standardArray") return slotsFor(STANDARD_ARRAY, "a");
    if (answer.method === "roll") return m.rolled ?? [];
    return answer.entered?.length === 6 && !validateEntered(answer.entered).length ? slotsFor(answer.entered, "m") : [];
  };
  const change = next => { answer = next; selected = null; draw(); actions.save(copy(answer)); };

  function row(k, base, final, pb) {
    const bonus = Number(m.bonus?.[k]) || 0;
    const score = node("span", { className: "ve-builder-ability-score", children: [node("strong", { text: final === null ? "—" : String(final) }),
      node("small", { text: final === null ? "" : mod(final) })] });
    const name = node("span", { className: "ve-builder-ability-name", children: [node("strong", { text: m.labels[k] }),
      node("small", { className: "ve-builder-ability-detail", text: base === null ? ctx.t("Abilities.Empty", "No number yet") : bonus ? `${base} + ${bonus}` : String(base) })] });
    if (pb) {
      const a = pb.abilities[k];
      const minus = node("button", { className: "ve-builder-step-btn", attrs: { type: "button", disabled: !a.canLower, "aria-label": ctx.t("ASI.Decrease", "Lower {ability}", { ability: m.labels[k] }) },
        children: [icon("fa-minus")], on: { click: () => change({ ...answer, pointBuy: { ...(answer.pointBuy ?? {}), [k]: a.value - 1 } }) } }, scope);
      // The next step's cost, visible under + (a title tooltip never shows on a phone).
      const cost = a.nextCost === null ? ctx.t("Abilities.CostMax", "Max")
        : ctx.t(a.nextCost === 1 ? "Abilities.CostOne" : "Abilities.Cost", a.nextCost === 1 ? "{cost} pt" : "{cost} pts", { cost: a.nextCost });
      const plus = node("button", { className: "ve-builder-step-btn", attrs: { type: "button", disabled: !a.canRaise,
        "aria-label": a.nextCost === null ? ctx.t("ASI.Increase", "Raise {ability}", { ability: m.labels[k] })
          : ctx.t("Abilities.IncreaseCost", "Raise {ability} ({cost})", { ability: m.labels[k], cost }) },
        children: [icon("fa-plus")], on: { click: () => change({ ...answer, pointBuy: { ...(answer.pointBuy ?? {}), [k]: a.value + 1 } }) } }, scope);
      // VE's − value + stepper (the rest dialog's), with the next step's cost under it.
      const stepper = node("span", { className: "ve-builder-stepper", children: [minus, score, plus] });
      const costText = node("small", { className: `ve-builder-step-cost${a.canRaise ? "" : " is-off"}`, attrs: { "aria-hidden": "true" }, text: cost });
      return node("div", { className: "ve-builder-ability-row", dataset: { ability: k }, children: [name, node("span", { className: "ve-builder-step-raise", children: [stepper, costText] })] });
    }
    return node("button", { className: `ve-builder-ability-row${selected ? " is-target" : ""}`, attrs: { type: "button", "data-ability": k }, children: [name, score],
      on: { click: () => {
        if (selected) change({ ...answer, assignments: placeSlot(answer.assignments ?? {}, selected, k) });
        else if (answer.assignments?.[k]) change({ ...answer, assignments: clearAbility(answer.assignments, k) });
      } } }, scope);
  }

  function enterForm() {
    const inputs = Array.from({ length: 6 }, (_, i) => {
      const input = node("input", { attrs: { type: "number", inputmode: "numeric", min: 3, max: 18, step: 1, "aria-label": ctx.t("Abilities.EnterN", "Number {n}", { n: i + 1 }) } });
      input.value = answer.entered?.[i] ?? "";
      return input;
    });
    const use = node("button", { className: "ve-builder-primary ve-builder-wide", attrs: { type: "button", "data-action": "use-dice" },
      children: [node("span", { text: ctx.t("Abilities.UseDice", "Use these numbers") }), icon("fa-check")],
      on: { click: () => actions.enter(inputs.map(i => i.value)) } }, scope);
    return sheetCard({ className: "ve-builder-enter-card", children: [cardNote(ctx.t("Abilities.EnterHint", "Type the six totals you rolled (3–18). They go to chat.")),
      node("div", { className: "ve-builder-enter", children: inputs }), node("div", { className: "ve-builder-card-actions", children: [use] })] });
  }

  function draw() {
    const slots = slotsNow();
    const pb = answer.method === "pointBuy" ? pointBuyState(answer.pointBuy) : null;
    const base = pb ? Object.fromEntries(Object.entries(pb.abilities).map(([k, a]) => [k, a.value])) : scoresFromSlots(slots ?? [], answer.assignments ?? {});
    const final = finalScores(base, m.bonus);
    const parts = [];
    if (m.methods.length > 1) {
      parts.push(node("div", { className: "ve-builder-segments", children: m.methods.map(x => node("button", {
        className: `ve-builder-segment${x.key === answer.method ? " is-selected" : ""}`, attrs: { type: "button", "data-method": x.key }, text: x.label,
        on: { click: () => { if (x.key !== answer.method) change({ method: x.key, assignments: {}, pointBuy: answer.pointBuy ?? {}, entered: answer.entered ?? [] }); } } }, scope)) }));
    }
    if (pb) parts.push(node("p", { className: "ve-builder-points", text: ctx.t("Abilities.PointsLeft", "Points left: {left} / 27", pb) }));
    if (answer.method === "roll" && !m.rolls.rolled) {
      parts.push(sheetCard({ children: [node("button", { className: "ve-builder-big-choice ve-sheet-item-row", attrs: { type: "button", "data-action": "roll" }, on: { click: () => actions.roll() },
        children: [rowArt(null, "fa-dice"), rowCopy(ctx.t("Abilities.RollSix", "Roll 4d6 six times"),
          node("small", { text: ctx.t("Abilities.RollHint", "The lowest die of each roll is dropped. The rolls go to chat and are kept.") })), icon("fa-chevron-right")] }, scope)] }));
    } else if (answer.method === "roll" && m.rolls.rerollsLeft > 0) {
      parts.push(node("button", { className: "ve-builder-secondary ve-builder-wide", attrs: { type: "button", "data-action": "reroll" }, on: { click: () => actions.roll() },
        children: [icon("fa-rotate"), node("span", { text: ctx.t("Abilities.Reroll", "Reroll all six ({left} left)", { left: m.rolls.rerollsLeft }) })] }, scope));
    }
    if (answer.method === "manual" && (entering || !slots.length)) parts.push(enterForm());
    else if (answer.method === "manual") {
      parts.push(node("div", { className: "ve-builder-inline-action", children: [cardAction(ctx.t("Abilities.ChangeDice", "Change the numbers"), () => { entering = true; draw(); }, scope, "ve-builder-link")] }));
    }
    if (slots?.length) {
      const owner = Object.fromEntries(Object.entries(answer.assignments ?? {}).map(([k, id]) => [id, k]));
      parts.push(node("div", { className: "ve-builder-chips ve-builder-slots", children: slots.map(slot => node("button", {
        className: `ve-builder-chip${selected === slot.id ? " is-selected" : ""}${owner[slot.id] ? " is-placed" : ""}`,
        attrs: { type: "button", "data-slot": slot.id, "aria-pressed": String(selected === slot.id) },
        children: [node("strong", { text: String(slot.value) }), owner[slot.id] ? node("small", { text: m.labels[owner[slot.id]] }) : null],
        on: { click: () => { selected = selected === slot.id ? null : slot.id; draw(); } } }, scope)) }));
      parts.push(node("p", { className: "ve-builder-hint", text: selected ? ctx.t("Abilities.TapAbility", "Now tap an ability.") : ctx.t("Abilities.TapNumber", "Tap a number, then an ability. Tap a filled ability to clear it.") }));
      if (m.suggested) {
        parts.push(node("button", { className: "ve-builder-secondary ve-builder-wide", attrs: { type: "button", "data-action": "suggested" },
          children: [icon("fa-wand-magic-sparkles"), node("span", { text: ctx.t("Abilities.Suggested", "Suggested for your class") })],
          on: { click: () => change({ ...answer, assignments: suggestedAssignments(m.classIdentifier, slots) ?? {} }) } }, scope));
      }
    }
    parts.push(sheetCard({ title: ctx.t("Creation.Review.Abilities", "Ability scores"), iconName: "fa-dumbbell",
      children: [node("div", { className: "ve-builder-ability-rows ve-builder-list", children: ABILITIES.map(k => row(k, base[k], final[k], pb)) })] }));
    if (Object.keys(m.bonus ?? {}).length === 0) parts.push(node("p", { className: "ve-builder-hint", text: ctx.t("Abilities.NoBonusYet", "Your background's +2/+1 is chosen on the Background tab.") }));
    root.replaceChildren(...parts);
  }

  ctx.validChanged(true);
  draw();
  return { element: root, update(next) { m = next; answer = copy(next.answer); selected = null; entering = false; draw(); } };
}

/**
 * Equipment tab: per source, option cards (A/B/…/gold), nested choices and "any X" picks.
 * @param {{ set: (source, answer) => void, trinket: () => void, busy?: () => boolean }} actions
 */
export function equipmentScreen(model, ctx, scope, actions) {
  const root = node("div", { className: "ve-builder-equipment ve-builder-stack" });
  let m = model;
  const answerOf = s => ({ option: s.option,
    choices: Object.fromEntries(s.choices.filter(c => c.value).map(c => [c.id, c.value])),
    picks: Object.fromEntries(s.picks.filter(p => p.picked).map(p => [p.id, p.value])) });

  function section(s) {
    if (s.missing) {
      return sheetCard({ className: "ve-builder-equipment-section", attrs: { "data-source": s.source }, children: [node("p", { className: "ve-builder-empty ve-sheet-empty",
        text: s.source === "class" ? ctx.t("Equipment.ClassMissing", "Choose a class first.") : ctx.t("Equipment.BackgroundMissing", "Choose a background first.") })] });
    }
    // No starting equipment listed (some DDB backgrounds): say so, with the book's text when it has any.
    if (s.empty) {
      return sheetCard({ title: s.item?.name ?? "", iconName: s.item?.img ? node("img", { className: "ve-builder-heading-art", attrs: { src: s.item.img, alt: "" } }) : (s.source === "class" ? "class:original-class" : "fa-scroll"),
        className: "ve-builder-equipment-section ve-builder-equipment-empty", attrs: { "data-source": s.source }, children: [
          node("p", { className: "ve-builder-empty ve-sheet-empty", text: ctx.t("Equipment.None", "No starting equipment listed") }),
          s.bookText ? node("p", { className: "ve-builder-book-text", text: s.bookText }) : null] });
    }
    const current = answerOf(s);
    const cards = s.options.map(o => node("button", {
      className: `ve-builder-card ve-builder-option ve-sheet-item-row${o.id === s.option ? " is-selected" : ""}`,
      attrs: { type: "button", role: "radio", "aria-checked": String(o.id === s.option), "data-option": o.id },
      on: { click: event => {
        // Only when the change will really be made (no job running): otherwise the tap would look accepted and be dropped.
        if (o.id === s.option || actions.busy?.()) return;
        // Optimistic: the tapped package shows as chosen at once; the controller's model then redraws the section
        // (or, if the change fails, the last good model does: actions.set's error path calls redraw()).
        const card = event.currentTarget;
        for (const other of card.parentElement?.querySelectorAll("[data-option]") ?? []) {
          const on = other === card;
          other.classList.toggle("is-selected", on);
          other.setAttribute("aria-checked", String(on));
          other.querySelector(".ve-builder-card-check")?.replaceChildren(on ? icon("fa-circle-check") : icon("fa-circle", "regular"));
        }
        actions.set(s.source, { option: o.id });
      } },
      children: [node("span", { className: "ve-sheet-item-art ve-builder-option-letter", text: o.id }),
        rowCopy(o.kind === "gold" ? ctx.t("Equipment.Gold", "Gold instead") : ctx.t("Equipment.Package", "Package {id}", o), node("small", { text: o.label })),
        node("span", { className: "ve-builder-card-check", attrs: { "aria-hidden": "true" }, children: [o.id === s.option ? icon("fa-circle-check") : icon("fa-circle", "regular")] })]
    }, scope));
    const choices = s.choices.map(c => node("div", { className: "ve-builder-segments", attrs: { "data-choice": c.id }, children: c.options.map(o => node("button", {
      className: `ve-builder-segment${o.id === c.value ? " is-selected" : ""}`, attrs: { type: "button" }, text: o.label,
      on: { click: () => actions.set(s.source, { ...current, choices: { ...current.choices, [c.id]: o.id } }) } }, scope)) }));
    const picks = s.picks.map(p => node("div", { className: "ve-builder-pick", attrs: { "data-pick": p.id }, children: [
      fieldLabel(p.linked ? ctx.t("Equipment.Linked", "{label} (from your proficiencies)", p) : p.label),
      p.candidates.length ? node("div", { className: "ve-builder-chips", children: p.candidates.map(cand => node("button", {
        className: `ve-builder-chip${cand.uuid === p.value ? " is-selected" : ""}`, attrs: { type: "button", "aria-pressed": String(cand.uuid === p.value) }, text: cand.name,
        on: { click: () => actions.set(s.source, { ...current, picks: { ...current.picks, [p.id]: cand.uuid } }) } }, scope)) })
        : node("p", { className: "ve-builder-warning", text: ctx.t("Equipment.NoCandidates", "Nothing in the allowed sources fits this pick.") })
    ] }));
    const book = s.bookText ? node("details", { className: "ve-builder-book ve-sheet-collection-section", children: [
      node("summary", { children: [icon("fa-chevron-right"), node("span", { text: ctx.t("Equipment.BookText", "What the book says") })] }), node("p", { text: s.bookText })] }) : null;
    const extras = [...choices, ...picks, ...(s.warnings ?? []).map(w => node("p", { className: "ve-builder-warning", text: w }))];
    return sheetCard({ title: s.item.name, iconName: s.item.img ? node("img", { className: "ve-builder-heading-art", attrs: { src: s.item.img, alt: "" } }) : (s.source === "class" ? "class:original-class" : "fa-scroll"),
      className: "ve-builder-equipment-section", attrs: { "data-source": s.source }, children: [
        node("div", { className: "ve-builder-cards ve-builder-list", attrs: { role: "radiogroup" }, children: cards }),
        extras.length ? node("div", { className: "ve-builder-fields", children: extras }) : null, book
      ] });
  }

  function trinket() {
    return sheetCard({ title: ctx.t("Equipment.Trinket", "Trinket"), iconName: "fa-gem", className: "ve-builder-equipment-section", attrs: { "data-source": "trinket" }, children: [
      m.trinket ? node("p", { className: "ve-builder-lead ve-builder-card-text-block", text: m.trinket.text })
        : node("div", { className: "ve-builder-card-actions", children: [node("button", { className: "ve-builder-secondary ve-builder-wide", attrs: { type: "button", "data-action": "trinket" },
          // A background's own table ("Background: Night Stalker: Night Stalker Trinkets" → "Night Stalker Trinkets").
          children: [icon("fa-dice-d20"), node("span", { text: m.trinketTable?.own
            ? ctx.t("Equipment.RollTrinketOwn", "Roll on {name} (optional, free)", { name: String(m.trinketTable.name).split(": ").pop() })
            : ctx.t("Equipment.RollTrinket", "Roll a trinket (optional, free)") })],
          on: { click: () => actions.trinket() } }, scope)] })
    ] });
  }

  const draw = () => root.replaceChildren(...m.sections.map(section), trinket(),
    ...m.notFound.map(n => node("p", { className: "ve-builder-warning", text: ctx.t("Creation.Review.NotFound", "Not found: {name}", { name: n }) })));
  ctx.validChanged(true);
  draw();
  return { element: root, update(next) { m = next; draw(); },
    /** Redraw from the last good model (after a failed change undoes an optimistic paint). */
    redraw: () => draw() };
}

/** Details tab: name, alignment, short biography. Saved through actions.save (debounced by the layer). */
export function detailsScreen(model, ctx, scope, actions) {
  const state = { name: model.name ?? "", alignment: model.alignment ?? "", biography: model.biography ?? "" };
  const name = node("input", { attrs: { type: "text", maxlength: 80, name: "name", placeholder: ctx.t("Details.NamePlaceholder", "Character name"), "aria-label": ctx.t("Details.Name", "Name") },
    on: { input: e => { state.name = e.currentTarget.value; actions.save({ ...state }); } } }, scope);
  name.value = state.name;
  const chips = [{ key: "", label: ctx.t("Details.NoAlignment", "None") }, ...model.alignments].map(a => node("button", {
    className: "ve-builder-chip", attrs: { type: "button", "data-alignment": a.key ? a.label : "", "aria-pressed": "false" }, text: a.label,
    on: { click: () => { state.alignment = a.key ? a.label : ""; refresh(); actions.save({ ...state }); } } }, scope));
  const refresh = () => chips.forEach(c => { const on = c.dataset.alignment === state.alignment; c.classList.toggle("is-selected", on); c.setAttribute("aria-pressed", String(on)); });
  const bio = node("textarea", { className: "ve-builder-textarea", attrs: { rows: 6, name: "biography", placeholder: ctx.t("Details.BioPlaceholder", "A few lines about who they are (optional)") },
    on: { input: e => { state.biography = e.currentTarget.value; actions.save({ ...state }); } } }, scope);
  bio.value = state.biography;
  refresh();
  ctx.validChanged(true);
  return { element: sheetCard({ className: "ve-builder-details", children: [node("div", { className: "ve-builder-fields", children: [
    node("label", { className: "ve-builder-field", children: [fieldLabel(ctx.t("Details.Name", "Name")), name] }),
    node("div", { className: "ve-builder-field", children: [fieldLabel(ctx.t("Details.Alignment", "Alignment")), node("div", { className: "ve-builder-chips", children: chips })] }),
    node("label", { className: "ve-builder-field", children: [fieldLabel(ctx.t("Details.Biography", "Short biography")), bio] })
  ] })] }) };
}
