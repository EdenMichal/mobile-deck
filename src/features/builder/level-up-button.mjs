// "Level up" icon button beside the character chooser in the dnd5e character header (Character Builder fork addition).
// It mirrors the chooser's square button; the "ready" state (XP reached the next level) adds a filled square and a dot.
import { icon, node } from "../../ui/dom.mjs";
import { localizedText } from "../../ui/localized-text.mjs";
import { ensureBuilderStyles } from "./builder-styles.mjs";

/** True when the header's XP has reached the next level's threshold (milestone worlds have no `next`). */
export function levelUpReady(actor) {
  const xp = actor?.header?.experience;
  return Boolean(xp && xp.next !== null && xp.next !== undefined && xp.value >= xp.next);
}

export function characterLevelUpButton(actor, commands, scope) {
  if (!commands?.openCharacterBuilder || !actor?.capabilities?.levelUp) return null;
  ensureBuilderStyles();
  const ready = levelUpReady(actor);
  const label = ready ? localizedText(commands.localize, "VEMOBILE.Builder.LevelUpReady", "Level up ready")
    : localizedText(commands.localize, "VEMOBILE.Builder.LevelUp", "Level up");
  return node("button", {
    className: `ve-character-level-up${ready ? " is-ready" : ""}`,
    attrs: { type: "button", "aria-label": label, title: label },
    on: { click: () => { try { commands.openCharacterBuilder({ actorSourceUuid: actor.sourceUuid }); } catch (error) { console.error(error); } } },
    children: [icon("fa-angles-up")]
  }, scope);
}
