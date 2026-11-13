import { localizeFoundry } from "../../localization.mjs";
import { actorSourceUuid, resolveActorSource } from "../../character-source.mjs";
import { CommandError, identifier } from "../../command-support.mjs";
import { MODULE_ID } from "../../preferences.mjs";
import { collectiveReferenceUuids } from "./collective-actor-view.mjs";
import {
  PARTY_CURRENCY, choosePartyGroup, coinsText, createKeyedQueue, findStackTarget, isPartyItemType, partyAccess,
  planCurrencyTransfer, planItemMove, transferItemData
} from "../../../kernel/party-stash-rules.mjs";

/** The party inventory: the D&D5e Group actor used as the party's shared stash.
 * Storage is the Group's own items and currency, so desktop Foundry's Group sheet
 * shows the same stash.
 *
 * Every move runs on the active GM's client (Foundry's CONFIG.queries), one at a time
 * per party. A player's client only asks; the GM's client re-checks that the asking
 * user owns the character and the Group, then writes. Serializing on one client makes
 * the absolute quantity and coin writes safe: each move reads what the previous one wrote. */

const t = (key, fallback, data) => localizeFoundry(`VEMOBILE.Party.${key}`, fallback, data);
// dev-install rewrites MODULE_ID, so the dev copy registers "ve-mobile-dev.partyTransfer".
export const PARTY_QUERY = `${MODULE_ID}.partyTransfer`;
const QUERY_TIMEOUT = 30_000;
const queue = createKeyedQueue();

/** Register the GM-side handler. Every client registers; only the active GM is ever asked. */
export function registerPartyRelay({ config = globalThis.CONFIG } = {}) {
  if (!config?.queries) return false;
  config.queries[PARTY_QUERY] = (data, context) => answerPartyQuery(data, context?.user);
  return true;
}

/** The Group this user treats as the party for this character, or null. */
export function findPartyGroup(character, user = globalThis.game?.user, game = globalThis.game) {
  if (!character || !user) return null;
  const groups = actorsOf(game).filter(actor => actor?.type === "group");
  if (!groups.length) return null;
  const candidates = groups.map(actor => ({ actor, uuid: actorSourceUuid(actor), level: accessOf(actor, user), memberUuids: collectiveReferenceUuids(actor) }));
  const chosen = choosePartyGroup(candidates, { primaryUuid: primaryPartyUuid(game), characterUuid: actorSourceUuid(character) });
  return chosen?.actor ?? null;
}

/** Identity the selected character's snapshot depends on, so stash changes refresh it. */
export function partyReferenceUuids(character) {
  if (character?.type !== "character") return [];
  try {
    const party = findPartyGroup(character);
    return party ? [actorSourceUuid(party)] : [];
  } catch { return []; }
}

/** Plain record of the party stash for the character sheet.
 * status "missing": no Group to use; "locked": a Group the player cannot look into
 * (Limited, or a primary party hidden from them); "ready": the stash, read-only or movable. */
export function partyViewRecord(character, user = globalThis.game?.user) {
  if (character?.type !== "character") return null;
  let party = null;
  try { party = findPartyGroup(character, user); } catch { party = null; }
  if (!party) return Object.freeze({ status: "missing" });
  const access = accessOf(party, user);
  if (access === "limited" || access === "none") {
    // A Limited user may see the Group's name; a hidden primary party stays unnamed.
    return Object.freeze({ status: "locked", name: access === "limited" ? String(party.name ?? "") : "", access });
  }
  const items = Array.from(party.items ?? []).filter(item => isPartyItemType(item?.type));
  const ids = new Set(items.map(item => String(item.id)));
  return Object.freeze({
    status: "ready",
    sourceUuid: actorSourceUuid(party),
    name: String(party.name ?? ""),
    img: String(party.img ?? ""),
    access,
    primary: actorSourceUuid(party) === primaryPartyUuid(globalThis.game),
    currency: Object.freeze(Object.fromEntries(PARTY_CURRENCY.map(key => [key, wholeNumber(party.system?.currency?.[key])]))),
    items: Object.freeze(items.map(item => partyItemRecord(item, ids)))
  });
}

/** Move one item (or part of a stack) between the character and the party.
 * payload: { partySourceUuid, direction: "take" | "send", itemId, quantity }. */
export async function transferPartyItem(actor, payload) {
  if (!["take", "send"].includes(payload?.direction)) throw partyError("INVALID_INPUT", "Errors.Direction", "Choose whether to take or send the item.");
  return relay(actor, { kind: "item", partySourceUuid: String(payload.partySourceUuid ?? ""), direction: payload.direction,
    itemId: identifier(payload.itemId, "itemId"), quantity: payload.quantity });
}

/** Deposit coins to, or withdraw them from, the party.
 * payload: { partySourceUuid, direction: "deposit" | "withdraw", amounts: { gp: 3, ... } }. */
export async function transferPartyCurrency(actor, payload) {
  if (!["deposit", "withdraw"].includes(payload?.direction)) throw partyError("INVALID_INPUT", "Errors.CoinDirection", "Choose whether to deposit or withdraw.");
  const amounts = payload.amounts && typeof payload.amounts === "object" && !Array.isArray(payload.amounts) ? { ...payload.amounts } : payload.amounts;
  return relay(actor, { kind: "currency", partySourceUuid: String(payload.partySourceUuid ?? ""), direction: payload.direction, amounts });
}

// Player side: check what this client can see, then ask the active GM to do the move.
async function relay(actor, request) {
  const game = globalThis.game;
  ownedParty(actor, request.partySourceUuid, game?.user);
  const activeGM = game?.users?.activeGM;
  if (!activeGM) throw partyError("GM_OFFLINE", "Errors.NoGm", "A GM needs to be online to move party items.");
  const data = { ...request, actorSourceUuid: actorSourceUuid(actor) };
  let response;
  if (activeGM.isSelf ?? activeGM.id === game.user?.id) response = await answerPartyQuery(data, game.user);
  else {
    try { response = await activeGM.query(PARTY_QUERY, data, { timeout: QUERY_TIMEOUT }); }
    catch (error) {
      throw partyError("RELAY_FAILED", "Errors.Relay", "The GM's client did not answer. Check the party inventory before trying again.", {}, error);
    }
  }
  if (!response?.ok) {
    if (!response?.key) throw partyError("RELAY_FAILED", "Errors.Relay", "The GM's client did not answer. Check the party inventory before trying again.");
    throw partyError(response.code ?? "COMMAND_FAILED", response.key, response.fallback ?? "", response.data ?? {});
  }
  return Object.freeze(response.result ?? {});
}

/** GM side: re-check the asking user's permissions, then run the move in the party's queue.
 * Always resolves to a plain { ok, result } or { ok: false, code, key, fallback, data } so the
 * player's client can show the message in its own language. */
export async function answerPartyQuery(data, requester) {
  try {
    if (!globalThis.game?.user?.isGM) throw partyError("FORBIDDEN", "Errors.NotGm", "Only a GM's client can move party items.");
    const actor = resolveActorSource(String(data?.actorSourceUuid ?? ""));
    const party = resolveActorSource(String(data?.partySourceUuid ?? ""));
    authorizeRequester(requester, actor, party);
    const run = data.kind === "currency" ? () => moveCurrency(actor, party, data) : () => moveItem(actor, party, data);
    return { ok: true, result: await queue.run(actorSourceUuid(party), run) };
  } catch (error) {
    if (!error?.party) console.error("Mobile Deck | Party move failed", error);
    return { ok: false, ...describeError(error) };
  }
}

/** The asking user must own the character and have Owner on the Group, checked on the GM's client. */
export function authorizeRequester(requester, actor, party) {
  if (!requester) throw partyError("FORBIDDEN", "Errors.NoUser", "The move did not say who asked for it.");
  if (!actor || actor.type !== "character") throw partyError("CAPABILITY_UNAVAILABLE", "Errors.CharacterOnly", "Only player characters can use the party inventory.");
  if (!permitted(actor, requester, "OWNER")) throw partyError("FORBIDDEN", "Errors.NotCharacterOwner", "You no longer own {actor}.", { actor: actor.name });
  if (!party || party.type !== "group") throw partyError("TARGET_MISSING", "Errors.PartyMissing", "The party inventory is no longer available.");
  if (!permitted(party, requester, "OWNER")) throw partyError("FORBIDDEN", "Errors.NotOwner", "You need Owner permission on {party} to move things. Ask your GM.", { party: party.name });
}

// GM side: copy to the target first, then take from the source; undo the copy if the source write fails.
async function moveItem(actor, party, data) {
  const [source, target] = data.direction === "take" ? [party, actor] : [actor, party];
  const item = source.items?.get?.(data.itemId);
  if (!item) throw goneError(source);
  if (!isPartyItemType(item.type)) throw partyError("CAPABILITY_UNAVAILABLE", "Errors.NotPhysical", "Only inventory items can go in the party stash.");
  const rule = { container: item.type === "container", hasContents: containedItems(item).length > 0 };
  const plan = itemPlan(planItemMove({ available: quantityOf(source, item.id), requested: data.quantity, ...rule }), item);
  const moving = await itemCreateData(item.constructor, item, entry => transferItemData(entry, plan.moved));
  const stackId = rule.hasContents ? null : findStackTarget(stackKey(item), Array.from(target.items ?? []).map(stackKey));

  const delivered = await deliver(target, moving, stackId, plan.moved);
  try {
    await takeFromSource(source, item, plan.moved, rule);
  } catch (error) {
    await undoDelivery(target, delivered, source, item);
    throw error;
  }
  await postNote(actor, t(data.direction === "take" ? "Chat.Took" : "Chat.Sent", data.direction === "take" ? "{actor} took {quantity}× {item} from {party}." : "{actor} put {quantity}× {item} in {party}.", {
    actor: actor.name, quantity: plan.moved, item: item.name, party: party.name
  }));
  return { direction: data.direction, itemId: String(item.id), moved: plan.moved, name: String(item.name ?? "") };
}

// GM side: credit the target, then debit the source after re-checking its balance; undo the credit on failure.
async function moveCurrency(actor, party, data) {
  const [source, target] = data.direction === "withdraw" ? [party, actor] : [actor, party];
  if (typeof source.update !== "function" || typeof target.update !== "function" || !source.system?.currency || !target.system?.currency) {
    throw partyError("CAPABILITY_UNAVAILABLE", "Errors.NoCurrency", "This currency cannot be moved.");
  }
  const moved = currencyPlan(planCurrencyTransfer(source.system.currency, target.system.currency, data.amounts), source).moved;
  const keys = Object.keys(moved);
  const adjust = (doc, sign) => doc.update(Object.fromEntries(keys.map(key => [`system.currency.${key}`, wholeNumber(doc.system.currency?.[key]) + sign * moved[key]])));
  await adjust(target, 1);
  try {
    // Re-read the source right before the debit; refuse rather than go negative.
    currencyPlan(planCurrencyTransfer(source.system.currency, {}, moved), source);
    await adjust(source, -1);
  } catch (error) {
    try { await adjust(target, -1); }
    catch (undoError) {
      console.error("Mobile Deck | Party coins could not be taken back", undoError);
      throw partyError("RESTORE_FAILED", "Errors.CoinsDoubled", "{coins} reached {target} but could not be taken from {source}. Tell your GM.", { coins: coinsText(moved), target: target.name, source: source.name }, error);
    }
    throw error;
  }
  await postNote(actor, t(data.direction === "withdraw" ? "Chat.Withdrew" : "Chat.Deposited", data.direction === "withdraw" ? "{actor} took {coins} from {party}." : "{actor} put {coins} in {party}.", {
    actor: actor.name, coins: coinsText(moved), party: party.name
  }));
  return { direction: data.direction, moved };
}

// Resolve the requested Group on the player's client and require Owner, for a fast, local refusal.
function ownedParty(actor, partySourceUuid, user) {
  if (actor?.type !== "character") throw partyError("CAPABILITY_UNAVAILABLE", "Errors.CharacterOnly", "Only player characters can use the party inventory.");
  let party = null;
  try { party = resolveActorSource(partySourceUuid); } catch { party = null; }
  if (!party || party.type !== "group" || !permitted(party, user, "OBSERVER")) {
    throw partyError("TARGET_MISSING", "Errors.PartyMissing", "The party inventory is no longer available.");
  }
  if (!permitted(party, user, "OWNER")) {
    throw partyError("FORBIDDEN", "Errors.NotOwner", "You need Owner permission on {party} to move things. Ask your GM.", { party: party.name });
  }
  return party;
}

/** A CommandError that also carries its translation key, so another client can re-localize it. */
function partyError(code, key, fallback, data = {}, cause) {
  const error = new CommandError(code, t(key, fallback, data), cause ? { cause } : {});
  error.party = Object.freeze({ key, fallback, data: plainData(data) });
  return error;
}

// Serialize any error from the GM's side; unexpected errors keep their raw reason.
function describeError(error) {
  if (error?.party) return { code: error.code, key: error.party.key, fallback: error.party.fallback, data: error.party.data };
  return { code: "COMMAND_FAILED", key: "Errors.MoveFailed", fallback: "The move could not be finished: {reason}",
    data: { reason: String(error?.message ?? error ?? "") } };
}

function plainData(data) {
  return Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [key, typeof value === "number" ? value : String(value ?? "")]));
}

function goneError(source, cause) {
  return partyError("STALE_STATE", "Errors.Gone", "That item is no longer in {source}. Someone may have just moved it.", { source: source.name }, cause);
}

// Map a refused plan onto a localized error.
function itemPlan(plan, item) {
  if (plan.ok) return plan;
  if (plan.code === "INSUFFICIENT") {
    throw partyError("STALE_STATE", "Errors.NotEnough", "Only {available} {item} left. Someone may have just taken some.", { available: plan.available, item: item.name });
  }
  if (plan.code === "CONTAINER_SPLIT") throw partyError("INVALID_INPUT", "Errors.ContainerSplit", "{item} has things inside, so it moves as a whole stack.", { item: item.name });
  throw partyError("INVALID_INPUT", "Errors.Quantity", "Choose how many to move (at least 1).");
}

// Map a refused coin plan onto a localized error.
function currencyPlan(plan, source) {
  if (plan.ok) return plan;
  if (plan.code === "INSUFFICIENT") {
    throw partyError("STALE_STATE", "Errors.NotEnoughCoins", "{source} only has {available} {denomination}.", { source: source.name, available: plan.available, denomination: plan.denomination });
  }
  if (plan.code === "EMPTY") throw partyError("INVALID_INPUT", "Errors.NoCoins", "Enter how many coins to move.");
  throw partyError("INVALID_INPUT", "Errors.CoinAmount", "Coin amounts must be whole numbers of 0 or more.");
}

// Build creation data for an item and everything inside it with dnd5e's own
// container-aware helper; fall back to a plain copy without that helper.
async function itemCreateData(ItemClass, item, transformFirst) {
  const first = data => transformFirst(data instanceof Object && typeof data.toObject === "function" ? data.toObject() : data);
  if (typeof ItemClass?.createWithContents === "function") {
    const data = await ItemClass.createWithContents([item], { keepId: false, transformFirst: first });
    if (Array.isArray(data) && data.length) return data;
  }
  const data = item.toObject();
  delete data._id;
  return [first(data)];
}

// Every item inside a container, at any depth.
function containedItems(item) {
  try { return Array.from(item.system?.allContainedItems?.values?.() ?? []); } catch { return []; }
}

// Add the moved items to the target, joining an identical loose stack if there is one.
async function deliver(target, data, stackId, moved) {
  const stack = stackId ? target.items?.get?.(stackId) : null;
  if (stack) {
    await stack.update({ "system.quantity": wholeNumber(stack.system?.quantity) + moved });
    return { kind: "stack", id: stack.id, moved };
  }
  const created = await target.createEmbeddedDocuments("Item", data, { keepId: true });
  return { kind: "created", ids: Array.from(created ?? [], entry => String(entry?.id ?? entry?._id ?? "")).filter(Boolean) };
}

// Take the moved quantity from the source, re-reading the item and its contents right before
// writing. A missing item, however the server words it, becomes "no longer in …".
async function takeFromSource(source, item, moved, rule) {
  const current = source.items?.get?.(item.id);
  if (!current) throw goneError(source);
  const contents = containedItems(current);
  const plan = itemPlan(planItemMove({ available: quantityOf(source, item.id), requested: moved, container: rule.container, hasContents: contents.length > 0 }), item);
  try {
    if (plan.mode === "decrement") await current.update({ "system.quantity": plan.remaining });
    else await source.deleteEmbeddedDocuments("Item", [current.id, ...contents.map(entry => entry.id)], { deleteContents: false });
  } catch (error) {
    if (!source.items?.get?.(item.id)) throw goneError(source, error);
    throw error;
  }
}

// Undo a delivery after the source write failed; if that fails too, say so plainly.
async function undoDelivery(target, delivered, source, item) {
  try {
    if (delivered.kind === "stack") {
      const stack = target.items?.get?.(delivered.id);
      if (stack) await stack.update({ "system.quantity": Math.max(0, wholeNumber(stack.system?.quantity) - delivered.moved) });
    } else if (delivered.ids.length) {
      const present = delivered.ids.filter(id => target.items?.get?.(id));
      if (present.length) await target.deleteEmbeddedDocuments("Item", present, { deleteContents: false });
    }
  } catch (error) {
    console.error("Mobile Deck | Party copy could not be removed", error);
    throw partyError("RESTORE_FAILED", "Errors.ItemDoubled", "{item} reached {target} but could not be taken out of {source}. Tell your GM so one copy can be removed.", {
      item: item.name, target: target.name, source: source.name
    }, error);
  }
}

// Post the public table note. A failed note never undoes a finished move.
async function postNote(actor, text) {
  const Message = globalThis.ChatMessage?.implementation ?? globalThis.ChatMessage;
  if (typeof Message?.create !== "function") return;
  try {
    await Message.create({
      speaker: Message.getSpeaker?.({ actor }) ?? { alias: actor.name },
      content: `<p class="ve-party-note">${escapeHtml(text)}</p>`
    });
  } catch (error) {
    console.warn("Mobile Deck | Party inventory chat note failed", error);
  }
}

// Plain stacking identity for an item document (see findStackTarget).
function stackKey(item) {
  const price = item?.system?.price;
  return {
    id: String(item?.id ?? ""), type: String(item?.type ?? ""), name: String(item?.name ?? ""),
    sourceId: String(item?._stats?.compendiumSource ?? item?.flags?.core?.sourceId ?? ""),
    containerId: String(item?.system?.container ?? ""),
    spent: Number(item?.system?.uses?.spent ?? 0) || 0,
    identified: item?.system?.identified !== false,
    price: price && typeof price === "object" ? `${price.value ?? ""} ${price.denomination ?? ""}`.trim() : String(price ?? "")
  };
}

// One row of the party stash.
function partyItemRecord(item, ids) {
  const system = item.system ?? {};
  const quantity = Number.isFinite(Number(system.quantity)) ? Math.max(0, Math.trunc(Number(system.quantity))) : 1;
  const containerId = String(system.container ?? "");
  return Object.freeze({
    id: String(item.id ?? ""),
    name: String(item.name ?? ""),
    img: String(item.img ?? ""),
    type: String(item.type ?? ""),
    typeLabel: typeLabel(item),
    quantity,
    weight: weightText(system.weight, quantity),
    containerId: ids.has(containerId) ? containerId : "",
    contentsCount: item.type === "container" ? containedItems(item).length : 0
  });
}

// Prepared dnd5e type label with a configured fallback.
function typeLabel(item) {
  const prepared = item.system?.type?.label;
  if (typeof prepared === "string" && prepared) return prepared;
  const label = globalThis.CONFIG?.Item?.typeLabels?.[item.type];
  return label ? String(globalThis.game?.i18n?.localize?.(label) ?? label) : String(item.type ?? "");
}

// Total stack weight using dnd5e's own unit formatting.
function weightText(weight, quantity) {
  const value = Number(weight?.value);
  if (!Number.isFinite(value) || value <= 0) return "";
  const total = Math.round(value * Math.max(quantity, 1) * 100) / 100;
  try {
    const formatted = globalThis.dnd5e?.utils?.formatWeight?.(total, weight.units);
    if (formatted) return String(formatted);
  } catch { /* Fall back to the raw unit key. */ }
  return `${total} ${weight.units ?? ""}`.trim();
}

// The configured primary party's UUID, or "" when unset or unreadable.
function primaryPartyUuid(game) {
  try {
    const actor = game?.settings?.get?.("dnd5e", "primaryParty")?.actor;
    if (!actor) return "";
    return typeof actor === "string" ? `Actor.${actor}` : actorSourceUuid(actor);
  } catch { return ""; }
}

function actorsOf(game) {
  try { return Array.from(game?.actors ?? []); } catch { return []; }
}

function quantityOf(source, itemId) {
  return Number(source.items?.get?.(itemId)?.system?.quantity);
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

// The user's permission level on a Group: owner, observer, limited or none.
function accessOf(actor, user) {
  return partyAccess({ own: permitted(actor, user, "OWNER"), observe: permitted(actor, user, "OBSERVER"), limited: permitted(actor, user, "LIMITED") });
}

// Fail closed when Foundry cannot confirm the requested permission.
function permitted(actor, user, level) {
  try { return Boolean(actor?.testUserPermission?.(user, level) ?? (level === "OWNER" ? actor?.isOwner : actor?.visible)); } catch { return false; }
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
