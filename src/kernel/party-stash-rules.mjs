/** Pure rules for the party inventory (D&D5e Group actor as a shared stash).
 * No Foundry globals here: the gateway in party-stash.mjs reads documents and
 * passes plain values, so every decision below is unit tested. */

export const PARTY_CURRENCY = Object.freeze(["pp", "gp", "ep", "sp", "cp"]);
const PARTY_ITEM_TYPES = new Set(["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]);
const STACKABLE_TYPES = new Set(["consumable", "loot"]);
// dnd5e's own drop handler clears the same per-owner state (_onDropResetData).
const OWNER_STATE = Object.freeze(["equipped", "attuned", "prepared"]);

/** Physical inventory items only; spells, features and class items never move. */
export function isPartyItemType(type) {
  return PARTY_ITEM_TYPES.has(String(type ?? ""));
}

/** Pick "the party". Candidates are plain records `{ uuid, level, memberUuids }` in world
 * order, where level is the player's permission on that group: owner, observer, limited or none.
 * 1. The primary party, whatever the player's level (the sheet then explains what is missing).
 * 2. Otherwise a visible group this character belongs to, then the first visible group.
 * 3. Otherwise a Limited group (member first), so the sheet can ask the GM for Owner.
 * Hidden groups are never picked unless they are the primary party. */
export function choosePartyGroup(candidates, { primaryUuid = "", characterUuid = "" } = {}) {
  const list = candidates ?? [];
  if (primaryUuid) {
    const primary = list.find(candidate => candidate?.uuid === primaryUuid);
    if (primary) return primary;
  }
  const memberFirst = entries => entries.find(candidate => characterUuid && (candidate.memberUuids ?? []).includes(characterUuid)) ?? entries[0] ?? null;
  return memberFirst(list.filter(candidate => ["owner", "observer"].includes(candidate?.level)))
    ?? memberFirst(list.filter(candidate => candidate?.level === "limited"));
}

/** "owner" may move things, "observer" sees the stash read-only, "limited" and "none" see nothing. */
export function partyAccess({ observe = false, own = false, limited = false } = {}) {
  if (own) return "owner";
  if (observe) return "observer";
  return limited ? "limited" : "none";
}

/** Run async tasks one at a time per key (the party's UUID), in arrival order. The GM's
 * client uses it so each party move reads values the previous move already wrote. */
export function createKeyedQueue() {
  const tails = new Map();
  return {
    run(key, task) {
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(() => task());
      const tail = result.then(() => {}, () => {});
      tails.set(key, tail);
      tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
      return result;
    },
    get size() { return tails.size; }
  };
}

/** Decide how much moves and what happens to the source stack. `available` is
 * the freshly re-read source quantity. */
export function planItemMove({ available, requested, container = false, hasContents = false } = {}) {
  if (typeof requested !== "number" || !Number.isSafeInteger(requested) || requested < 1) return { ok: false, code: "INVALID_QUANTITY" };
  const stack = Number.isFinite(available) ? Math.max(0, Math.trunc(available)) : 1;
  if (requested > stack) return { ok: false, code: "INSUFFICIENT", available: stack };
  // Splitting a filled container would leave its contents with only one half.
  if (container && hasContents && requested < stack) return { ok: false, code: "CONTAINER_SPLIT" };
  const remaining = stack - requested;
  return { ok: true, mode: remaining ? "decrement" : "delete", moved: requested, remaining };
}

/** Copy of the item's source data for the target actor: same data, the moved
 * quantity, loose in the inventory, and without equipped/attuned state. */
export function transferItemData(data, quantity) {
  const copy = structuredClone(data ?? {});
  copy.system ??= {};
  for (const key of OWNER_STATE) delete copy.system[key];
  copy.system.quantity = quantity;
  copy.system.container = null;
  return copy;
}

/** Find a loose stack on the target that should absorb the moved items. Follows dnd5e
 * 5.3.2's _onDropStackConsumables (a consumable with a compendium source, same name, same
 * container) and is stricter: spent uses and identification must match too. Loot with the same
 * source and price also stacks. Records are plain
 * `{ id, type, name, sourceId, containerId, spent, identified, price }`. */
export function findStackTarget(moved, candidates) {
  if (!STACKABLE_TYPES.has(moved?.type) || !moved.sourceId) return null;
  const match = (candidates ?? []).find(candidate => !candidate.containerId
    && candidate.type === moved.type && candidate.name === moved.name && candidate.sourceId === moved.sourceId
    && Number(candidate.spent ?? 0) === Number(moved.spent ?? 0) && Boolean(candidate.identified ?? true) === Boolean(moved.identified ?? true)
    && (moved.type !== "loot" || String(candidate.price ?? "") === String(moved.price ?? "")));
  return match?.id ?? null;
}

/** Plan a coin transfer between two balances. Neither side may go negative and
 * every amount must be a whole number of a known denomination. */
export function planCurrencyTransfer(from, to, amounts) {
  if (!amounts || typeof amounts !== "object" || Array.isArray(amounts)) return { ok: false, code: "EMPTY" };
  const moved = {};
  for (const [denomination, amount] of Object.entries(amounts)) {
    if (!PARTY_CURRENCY.includes(denomination) || typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) {
      return { ok: false, code: "INVALID_AMOUNT", denomination };
    }
    if (amount > 0) moved[denomination] = amount;
  }
  if (!Object.keys(moved).length) return { ok: false, code: "EMPTY" };
  const fromBalance = balance(from);
  const toBalance = balance(to);
  for (const denomination of PARTY_CURRENCY) {
    const amount = moved[denomination] ?? 0;
    if (amount > fromBalance[denomination]) return { ok: false, code: "INSUFFICIENT", denomination, available: fromBalance[denomination] };
    fromBalance[denomination] -= amount;
    toBalance[denomination] += amount;
  }
  return { ok: true, moved: ordered(moved), from: fromBalance, to: toBalance };
}

/** "2 gp, 5 sp" — coin amounts from platinum down, for chat notes. */
export function coinsText(amounts) {
  return PARTY_CURRENCY.filter(denomination => amounts?.[denomination] > 0)
    .map(denomination => `${amounts[denomination]} ${denomination}`).join(", ");
}

// Normalize a stored currency record; malformed or negative values count as zero.
function balance(currency) {
  return Object.fromEntries(PARTY_CURRENCY.map(denomination => {
    const value = Number(currency?.[denomination]);
    return [denomination, Number.isSafeInteger(value) && value > 0 ? value : 0];
  }));
}

// Keep the moved record in denomination order for stable chat text and results.
function ordered(moved) {
  return Object.fromEntries(PARTY_CURRENCY.filter(denomination => moved[denomination]).map(denomination => [denomination, moved[denomination]]));
}

/** Display order for a stash: loose items by name, each container followed by
 * its contents (also by name). Items whose container is missing count as loose. */
export function stashRows(items) {
  const list = items ?? [];
  const ids = new Set(list.map(item => item.id));
  const children = new Map();
  for (const item of list) {
    const parent = item.containerId && ids.has(item.containerId) && item.containerId !== item.id ? item.containerId : "";
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(item);
  }
  const rows = [];
  const seen = new Set();
  const walk = (parent, depth) => {
    for (const item of (children.get(parent) ?? []).sort((left, right) => String(left.name).localeCompare(String(right.name)))) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      rows.push({ item, depth });
      walk(item.id, depth + 1);
    }
  };
  walk("", 0);
  return rows;
}
