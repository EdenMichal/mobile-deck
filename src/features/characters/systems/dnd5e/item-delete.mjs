/**
 * Player feedback (fork): "Delete" at the end of the dnd5e inventory item menu, and its confirm card.
 * The menu record (commands.readCharacterItemMenu, built Foundry-side) says whether this user may delete the item
 * (OWNER on a character, physical inventory item) and how much goes with it; Delete runs ACTOR_COMMANDS.DELETE_ITEM,
 * which re-checks all of that. The card is DOM-only, like the item creator's discard card, and belongs to the
 * retained character shell's scope so a pane re-render (a GM changing HP) doesn't drop it mid-decision.
 */
import { icon, node } from "../../../../ui/dom.mjs";
import { localizedCount, localizedText } from "../../../../ui/localized-text.mjs";
import { ACTOR_COMMANDS } from "../../../../kernel/command-names.mjs";
import { characterErrorMessage, notifyCharacter } from "../../notifications.mjs";
import { ensureItemCreateStyles } from "./item-create.mjs";

const text = (commands, key, fallback, data) => localizedText(commands?.localize, `VEMOBILE.ItemDelete.${key}`, fallback, data);
const count = (commands, key, forms, value, data) => localizedCount(commands?.localize, `VEMOBILE.ItemDelete.${key}`, forms, value, commands?.readLocale?.() ?? "en", data);
const sourceOf = actor => String(actor?.sourceUuid ?? (actor?.id ? `Actor.${actor.id}` : ""));
let sequence = 0;

/** The menu's last entry, or null when the record doesn't allow deleting. */
export function itemDeleteMenuAction(record, commands) {
  if (!record?.canDelete) return null;
  return Object.freeze({ id: "delete", label: text(commands, "Menu", "Delete"), icon: "fa-trash-can", destructive: true });
}

/** The confirm's heading and line: what goes, and that it can't be undone. */
export function itemDeleteCopy(record, commands) {
  const contents = Math.max(0, Math.trunc(Number(record?.contentsCount) || 0));
  const quantity = Math.max(1, Math.trunc(Number(record?.quantity) || 1));
  const title = text(commands, "Title", "Delete {item}?", { item: record?.name ?? "" });
  const body = contents > 0
    ? count(commands, "Contents", { one: "The {count} item inside is deleted with it. This can't be undone.", other: "The {count} items inside are deleted with it. This can't be undone." }, contents)
    : quantity > 1 ? text(commands, "Stack", "All {count} are removed from your inventory. This can't be undone.", { count: quantity })
      : text(commands, "Single", "It's removed from your inventory. This can't be undone.");
  return { title, body };
}

/** Open the confirm over the character pane for the item the menu was opened on. Resolves once it closes. */
export function confirmItemDelete(anchor, actor, record, commands, scope) {
  const owner = commands.characterShellScope ?? scope;
  if (!owner || owner.disposed) return null;
  const doc = anchor?.ownerDocument ?? globalThis.document;
  ensureItemCreateStyles(doc);
  const screen = anchor?.closest?.(".ve-character-screen");
  const host = screen?.__veCharacterOverlayHost ?? screen ?? doc?.body;
  host?.querySelector?.(".ve-item-delete-layer")?.dispatchEvent(new Event("ve-close"));
  const sourceUuid = sourceOf(actor);
  const confirmScope = owner.child(`item-delete-${record.id}`);
  const { title, body } = itemDeleteCopy(record, commands);
  let pending = false;

  const heading = node("h3", { attrs: { id: `ve-item-delete-title-${++sequence}` }, text: title });
  const line = node("p", { attrs: { id: `ve-item-delete-body-${sequence}` }, text: body });
  const cancel = node("button", { className: "ve-modal-button is-secondary ve-item-delete-cancel", attrs: { type: "button" },
    on: { click: () => dismiss() }, children: [node("span", { text: text(commands, "Cancel", "Cancel") })] }, confirmScope);
  const confirmLabel = node("span", { text: text(commands, "Confirm", "Delete") });
  const confirm = node("button", { className: "ve-modal-button is-danger ve-item-delete-confirm-button", attrs: { type: "button" },
    on: { click: () => run() }, children: [icon("fa-trash-can"), confirmLabel] }, confirmScope);
  const card = node("div", { className: "ve-item-create-confirm ve-item-delete-confirm",
    attrs: { role: "alertdialog", "aria-modal": "true", "aria-labelledby": heading.id, "aria-describedby": line.id, "data-item-id": record.id },
    children: [heading, line, node("div", { className: "ve-modal-actions", children: [cancel, confirm] })] });
  const layer = node("div", { className: `ve-currency-editor-layer ve-item-delete-layer${host === screen ? "" : " is-pane-scoped"}`, children: [card] });

  function dismiss() {
    if (pending) return;
    confirmScope.dispose();
    if (anchor?.isConnected) anchor.focus?.({ preventScroll: true });
  }
  async function run() {
    if (pending) return;
    pending = true;
    card.setAttribute("aria-busy", "true");
    card.classList.add("is-pending");
    cancel.disabled = true;
    confirm.disabled = true;
    confirmLabel.textContent = text(commands, "Deleting", "Deleting…");
    try {
      const outcome = await commands.execute(ACTOR_COMMANDS.DELETE_ITEM, { actorSourceUuid: sourceUuid, itemId: record.id, contents: Math.max(0, Math.trunc(Number(record.contentsCount) || 0)) });
      const name = outcome?.itemName || record.name;
      const removed = Number(outcome?.contentsDeleted ?? record.contentsCount) || 0;
      confirmScope.dispose();
      notifyCharacter(commands, sourceUuid, removed > 0
        ? count(commands, "DeletedWithContents", { one: "{item} and the {count} item inside were deleted.", other: "{item} and the {count} items inside were deleted." }, removed, { item: name })
        : text(commands, "Deleted", "{item} deleted.", { item: name }), "info");
      globalThis.navigator?.vibrate?.(5);
    } catch (error) {
      notifyCharacter(commands, sourceUuid, characterErrorMessage(commands, error, text(commands, "Failed", "{item} could not be deleted.", { item: record.name })), "error");
      if (confirmScope.disposed) return;
      pending = false;
      card.removeAttribute("aria-busy");
      card.classList.remove("is-pending");
      cancel.disabled = false;
      confirm.disabled = false;
      confirmLabel.textContent = text(commands, "Confirm", "Delete");
    }
  }

  // Back (gesture or hardware), Escape and a backdrop tap all cancel; nothing cancels a delete already sent.
  confirmScope.listen(layer, "ve-close", () => dismiss());
  confirmScope.listen(layer, "pointerdown", event => { if (event.target === layer) dismiss(); });
  confirmScope.listen(layer, "keydown", event => { if (event.key === "Escape") { event.preventDefault(); dismiss(); } });
  confirmScope.own(() => layer.remove());
  host?.append(layer);
  // Cancel takes focus: Return on an open confirm never deletes.
  queueMicrotask(() => { if (!confirmScope.disposed) cancel.focus({ preventScroll: true }); });
  return layer;
}
