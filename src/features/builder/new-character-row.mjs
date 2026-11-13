// "New character" row for Mobile Deck's character chooser (Character Builder fork addition, Phase 4a).
import { icon, node } from "../../ui/dom.mjs";
import { localizedText } from "../../ui/localized-text.mjs";
import { ensureBuilderStyles } from "./builder-styles.mjs";
import { creationBadge } from "../../foundry/systems/dnd5e/builder/approval-status.mjs";
import { touchesBuilderFlag } from "../../foundry/systems/dnd5e/builder/approval-rules.mjs";
import { MODULE_ID } from "../../foundry/preferences.mjs";

export function newCharacterRow(commands, scope, onClose = null) {
  if (!commands?.openCharacterCreator) return null;
  ensureBuilderStyles();
  const label = localizedText(commands.localize, "VEMOBILE.Builder.NewCharacter", "New character");
  const copy = node("span", { className: "ve-character-menu-copy", children: [node("strong", { text: label })] });
  // Phase 4b: waiting / sent back / approved (approval-status.mjs; one flag read, cheap enough for the menu).
  const renderBadge = () => {
    copy.querySelector(".ve-builder-row-badge")?.remove();
    const badge = creationBadge((key, fallback) => localizedText(commands.localize, `VEMOBILE.Builder.${key}`, fallback));
    if (badge) copy.append(node("small", { className: `ve-builder-row-badge is-${badge.kind}`, text: badge.text }));
  };
  renderBadge();
  // VE doesn't re-render its character screen for a User flag change, so the line follows the builder flag itself
  // (this client's Submit and the GM's decision alike).
  scope?.hook?.("updateUser", (user, changes) => {
    if (user.id === globalThis.game?.user?.id && touchesBuilderFlag(changes, MODULE_ID)) renderBadge();
  });
  return node("button", {
    className: "ve-character-menu-new", attrs: { type: "button", role: "menuitem" },
    on: { click: () => { try { onClose?.(); Promise.resolve(commands.openCharacterCreator({})).catch(error => console.error(error)); } catch (error) { console.error(error); } } },
    children: [node("span", { className: "ve-character-menu-portrait", children: [icon("fa-user-plus")] }), copy]
  }, scope);
}
