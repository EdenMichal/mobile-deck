/**
 * Player feedback (fork): Delete from the inventory item menu, Foundry side. The command gateway has already
 * re-resolved the Actor and checked OWNER; this re-resolves the embedded Item, re-checks that it is a physical
 * inventory item on a character, and deletes it the way dnd5e 5.3.2's own sheet does: a container goes with
 * everything inside it (Item5e#deleteDialog's "Also delete all items within the container" → delete({ deleteContents })).
 */
import { localizeFoundry } from "../../localization.mjs";
import { CommandError } from "../../command-support.mjs";
import { isPartyItemType } from "../../../kernel/party-stash-rules.mjs";

/** A physical inventory item (not a spell, feature or class) embedded in, and owned with, this character. */
export function canDeleteItem(actor, item) {
  return actor?.type === "character" && Boolean(item) && item.parent === actor && item.isOwner !== false
    && isPartyItemType(item.type) && typeof item.delete === "function";
}

/** How many Items a container holds, sub-containers' contents included (dnd5e's allContainedItems). */
export function containedItemCount(item) {
  if (item?.type !== "container") return 0;
  const contents = item.system?.allContainedItems;
  return Number.isSafeInteger(contents?.size) ? contents.size : 0;
}

/** ACTOR_COMMANDS.DELETE_ITEM: delete one inventory Item (a whole stack, or a container with its contents).
 * `contents` is the count the player confirmed; a different live count refuses rather than deleting more. */
export async function deleteActorItem(actor, payload, context = {}) {
  const itemId = String(payload?.itemId ?? "");
  const item = itemId ? (actor?.items?.get?.(itemId) ?? null) : null;
  if (actor?.type !== "character" || (item && !canDeleteItem(actor, item))) {
    throw new CommandError("CAPABILITY_UNAVAILABLE", localizeFoundry("VEMOBILE.ItemDelete.Unavailable", "This item can't be deleted here. Use Foundry instead."));
  }
  if (!item) throw new CommandError("TARGET_MISSING", localizeFoundry("VEMOBILE.Character.CommandGateway.ThisItemIsNoLongerAvailableOnTheSelected", "This item is no longer available on the selected actor."));
  const confirmed = payload?.contents;
  if (!Number.isSafeInteger(confirmed) || confirmed < 0) {
    throw new CommandError("INVALID_INPUT", localizeFoundry("VEMOBILE.ItemDelete.Changed", "{item} changed. Check it and try again.", { item: item.name }));
  }
  const contents = containedItemCount(item);
  if (contents !== confirmed) {
    throw new CommandError("STALE_STATE", localizeFoundry("VEMOBILE.ItemDelete.Changed", "{item} changed. Check it and try again.", { item: item.name }));
  }
  context.assertCurrent?.();
  const name = String(item.name ?? "");
  await item.delete(item.type === "container" ? { deleteContents: true } : {});
  return Object.freeze({ itemId: String(item.id), itemName: name, contentsDeleted: contents });
}
