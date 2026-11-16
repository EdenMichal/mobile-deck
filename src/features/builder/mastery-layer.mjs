/**
 * Player feedback (fork): the Weapon Mastery picker, opened from the sheet's Weapon masteries card.
 * Weapons the character is proficient with come first; the others are listed greyed out (masteries need proficiency).
 * Save checks the 2024 rules (mastery-rules.mjs): new picks while fewer than allowed are known, and one swap after a
 * Long Rest. A GM may set anything.
 */
import { icon, node } from "../../ui/dom.mjs";
import { checkMasteryChange } from "../../foundry/systems/dnd5e/builder/mastery-rules.mjs";
import { createShell } from "./builder-shell.mjs";
import { emptyCard, sheetCard } from "./ve-parts.mjs";

export function mountMasteryPicker(host, manager, { t, onClose = () => {} }) {
  const shell = createShell(host, { t, subtitle: manager.actorName, controller: { isGM: manager.isGM }, headIcon: "fa-swords", onClose });
  shell.layer.classList.add("ve-mastery-layer");
  const { frame, work, setBody, showError } = shell;

  const reasons = {
    notProficient: t("Mastery.NotProficient", "A mastery needs proficiency with that weapon."),
    oneSwap: t("Mastery.OneSwap", "After a Long Rest you can change one mastery."),
    noSwap: t("Mastery.NoSwap", "You can change a mastery after a Long Rest."),
    tooMany: t("Mastery.TooMany", "That's more masteries than you know.")
  };

  async function show() {
    const summary = manager.summary() ?? { allowance: 0, chosen: [], free: 0, swap: false };
    const options = await manager.options();
    const before = summary.chosen.map(c => c.key);
    const selected = new Set(before);
    const proficient = new Set(options.filter(o => o.proficient).map(o => o.key));
    let check = null;
    const scope = frame({ screen: "mastery", heading: t("Mastery.Title", "Weapon masteries"), nextText: t("Mastery.Save", "Save"), nextIcon: "fa-check",
      next: () => void work(async () => {
        await manager.save([...selected]).catch(error => { throw new Error(reasons[error?.masteryReason] ?? error?.message ?? String(error)); });
        shell.close();
      }) });
    const ctx = shell.ctxFor(scope);
    if (!options.length) { setBody(emptyCard(t("Mastery.NoWeapons", "No weapons were found."))); ctx.validChanged(false); return; }

    const counter = node("strong");
    const hint = node("p", { className: "ve-builder-hint ve-mastery-hint", attrs: { role: "status", "aria-live": "polite" } });
    const rows = options.map(option => {
      const button = node("button", { className: "ve-builder-chip ve-mastery-chip", attrs: { type: "button", "aria-pressed": "false", disabled: !option.proficient && !manager.isGM },
        children: [node("span", { text: option.label }), option.mastery ? node("small", { text: option.mastery }) : null],
        on: { click: () => { if (selected.has(option.key)) selected.delete(option.key); else selected.add(option.key); refresh(); } } }, scope);
      return { option, button };
    });
    function refresh() {
      check = checkMasteryChange({ before, after: [...selected], allowance: summary.allowance, swap: summary.swap, proficient, isGM: manager.isGM });
      for (const { option, button } of rows) {
        const on = selected.has(option.key);
        button.classList.toggle("is-selected", on);
        button.setAttribute("aria-pressed", String(on));
      }
      counter.textContent = `${selected.size} / ${summary.allowance}`;
      const changed = check.added.length || check.removed.length;
      hint.textContent = manager.isGM ? t("Mastery.GmFree", "As GM you can set any masteries.")
        : !check.ok ? reasons[check.reason] ?? ""
        : summary.free > 0 && selected.size < summary.allowance ? t("Mastery.ChooseMore", "Choose {count} more.", { count: summary.allowance - selected.size })
        : summary.swap ? t("Mastery.SwapReady", "Long Rest: you can change one mastery.")
        : t("Mastery.Locked", "You can change a mastery after your next Long Rest.");
      hint.classList.toggle("is-error", !check.ok);
      ctx.validChanged(Boolean(check.ok && changed));
    }
    const group = (title, list) => list.length ? node("div", { className: "ve-builder-chip-group", children: [
      node("span", { className: "ve-builder-field-label", text: title }),
      node("div", { className: "ve-builder-chips", children: list.map(r => r.button) })] }) : null;
    refresh();
    setBody(
      sheetCard({ className: "ve-mastery-card", children: [
        node("div", { className: "ve-builder-spell-counters", dataset: { count: "1" }, children: [node("div", { className: "ve-builder-spell-counter", children: [
          node("small", { text: t("Mastery.Known", "Masteries") }), counter] })] }),
        hint,
        node("div", { className: "ve-builder-chip-groups", children: [
          group(t("Mastery.Proficient", "Proficient"), rows.filter(r => r.option.proficient)),
          group(t("Mastery.NotProficientGroup", "Not proficient"), rows.filter(r => !r.option.proficient))
        ].filter(Boolean) })
      ] })
    );
    showError("");
  }

  void work(show);
  return { close: () => shell.close() };
}

/** The sheet card: the masteries known, and Change. */
export function masteryCard(summary, { t, onChange, scope, canEdit }) {
  if (!summary) return null;
  const pending = summary.free > 0;
  const action = canEdit ? node("button", { className: `ve-sheet-card-action${pending || summary.swap ? " is-attention" : ""}`, attrs: { type: "button" },
    on: { click: onChange }, children: [node("span", { text: pending ? t("Mastery.Choose", "Choose") : t("Mastery.Change", "Change") }), icon("fa-chevron-right")] }, scope) : null;
  return node("section", { className: "ve-sheet-card ve-traits-preview ve-mastery-preview", children: [
    node("header", { className: "ve-sheet-card-heading", children: [icon("fa-swords"), node("h3", { text: t("Mastery.Title", "Weapon masteries") }), action] }),
    node("div", { className: "ve-traits-list", children: [node("article", { className: "ve-trait-group", children: [
      node("div", { className: "ve-trait-pills", children: summary.chosen.length ? summary.chosen.map(c => node("span", { text: c.label }))
        : [node("span", { text: t("Mastery.NoneYet", "None chosen yet") })] }),
      pending ? node("p", { className: "ve-mastery-note", text: t("Mastery.ChooseMore", "Choose {count} more.", { count: summary.free }) })
        : summary.swap ? node("p", { className: "ve-mastery-note", text: t("Mastery.SwapReady", "Long Rest: you can change one mastery.") }) : null
    ] })] })
  ] });
}
