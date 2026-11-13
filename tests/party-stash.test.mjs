// Unit tests for the party inventory rules (party-stash-rules.mjs). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createKeyedQueue, choosePartyGroup, partyAccess, planItemMove, transferItemData, findStackTarget,
  planCurrencyTransfer, coinsText, isPartyItemType
} from "../src/kernel/party-stash-rules.mjs";

// ---- Which group is "the party" ----
// Candidates carry the player's permission level on each group: owner, observer, limited or none.

const group = (uuid, { level = "observer", members = [] } = {}) => ({ uuid, level, memberUuids: members });

test("the primary party wins when the player can see it", () => {
  const groups = [group("Actor.a"), group("Actor.primary")];
  assert.equal(choosePartyGroup(groups, { primaryUuid: "Actor.primary", characterUuid: "Actor.pc" })?.uuid, "Actor.primary");
});

test("a primary party hidden from the player is still the party (no fallback to an unrelated group)", () => {
  const groups = [group("Actor.primary", { level: "none" }), group("Actor.b")];
  assert.equal(choosePartyGroup(groups, { primaryUuid: "Actor.primary", characterUuid: "Actor.pc" })?.uuid, "Actor.primary");
});

test("a primary party that no longer exists falls back like no primary party", () => {
  const groups = [group("Actor.b")];
  assert.equal(choosePartyGroup(groups, { primaryUuid: "Actor.deleted", characterUuid: "Actor.pc" })?.uuid, "Actor.b");
});

test("without a primary party, a visible group that has this character as a member comes first", () => {
  const groups = [group("Actor.other"), group("Actor.mine", { members: ["Actor.pc"] })];
  assert.equal(choosePartyGroup(groups, { primaryUuid: "", characterUuid: "Actor.pc" })?.uuid, "Actor.mine");
});

test("otherwise the first visible group is the party", () => {
  const groups = [group("Actor.hidden", { level: "none" }), group("Actor.first"), group("Actor.second", { level: "owner" })];
  assert.equal(choosePartyGroup(groups, { primaryUuid: "", characterUuid: "Actor.pc" })?.uuid, "Actor.first");
});

test("with only Limited groups, one of them is the party (so the sheet can ask for Owner)", () => {
  const groups = [group("Actor.hidden", { level: "none" }), group("Actor.limited", { level: "limited" })];
  assert.equal(choosePartyGroup(groups, { primaryUuid: "", characterUuid: "Actor.pc" })?.uuid, "Actor.limited");
});

test("no group, or only hidden groups and no primary party, means no party", () => {
  assert.equal(choosePartyGroup([], { primaryUuid: "", characterUuid: "Actor.pc" }), null);
  assert.equal(choosePartyGroup([group("Actor.x", { level: "none" })], { primaryUuid: "", characterUuid: "Actor.pc" }), null);
});

// ---- Permission ----

test("access: owner can move, observer reads, limited and none are locked out", () => {
  assert.equal(partyAccess({ observe: true, own: true }), "owner");
  assert.equal(partyAccess({ observe: true, own: false }), "observer");
  assert.equal(partyAccess({ limited: true }), "limited");
  assert.equal(partyAccess({ observe: false, own: false }), "none");
  // Owner implies observer even if a broken adapter says otherwise.
  assert.equal(partyAccess({ observe: false, own: true }), "owner");
});

test("only physical inventory types can move", () => {
  for (const type of ["weapon", "equipment", "consumable", "tool", "loot", "container", "backpack"]) assert.equal(isPartyItemType(type), true, type);
  for (const type of ["spell", "feat", "class", "subclass", "background", "race", "facility"]) assert.equal(isPartyItemType(type), false, type);
});

// ---- Quantity split ----

test("moving the whole stack deletes the source", () => {
  assert.deepEqual(planItemMove({ available: 3, requested: 3 }), { ok: true, mode: "delete", moved: 3, remaining: 0 });
});

test("moving part of a stack decrements the source", () => {
  assert.deepEqual(planItemMove({ available: 5, requested: 2 }), { ok: true, mode: "decrement", moved: 2, remaining: 3 });
});

test("asking for more than is there is refused", () => {
  assert.deepEqual(planItemMove({ available: 1, requested: 2 }), { ok: false, code: "INSUFFICIENT", available: 1 });
});

test("a stack that is already gone is refused", () => {
  assert.deepEqual(planItemMove({ available: 0, requested: 1 }), { ok: false, code: "INSUFFICIENT", available: 0 });
});

test("quantities must be whole numbers of at least one", () => {
  for (const requested of [0, -1, 1.5, Number.NaN, "2", null, undefined]) {
    assert.equal(planItemMove({ available: 5, requested }).code, "INVALID_QUANTITY", String(requested));
  }
});

test("an item without a usable quantity moves as one", () => {
  // dnd5e physical items always carry quantity; malformed data is treated as a single item.
  assert.deepEqual(planItemMove({ available: Number.NaN, requested: 1 }), { ok: true, mode: "delete", moved: 1, remaining: 0 });
});

test("a container with contents only moves as a whole stack", () => {
  assert.equal(planItemMove({ available: 2, requested: 1, container: true, hasContents: true }).code, "CONTAINER_SPLIT");
  assert.deepEqual(planItemMove({ available: 1, requested: 1, container: true, hasContents: true }), { ok: true, mode: "delete", moved: 1, remaining: 0 });
  // An empty container splits like any other stack.
  assert.equal(planItemMove({ available: 2, requested: 1, container: true, hasContents: false }).mode, "decrement");
});

// ---- Item data on the target ----

test("the moved copy keeps its data but drops equipped and attuned state", () => {
  const source = { _id: "abc", name: "Longsword", type: "weapon", img: "sword.webp", flags: { x: { y: 1 } },
    system: { quantity: 3, equipped: true, attuned: true, prepared: 1, container: "bag", description: { value: "<p>Sharp</p>" } } };
  const copy = transferItemData(source, 2);
  assert.equal(copy.name, "Longsword");
  assert.equal(copy.img, "sword.webp");
  assert.deepEqual(copy.flags, { x: { y: 1 } });
  assert.equal(copy.system.quantity, 2);
  assert.equal(copy.system.description.value, "<p>Sharp</p>");
  assert.equal("equipped" in copy.system, false);
  assert.equal("attuned" in copy.system, false);
  assert.equal("prepared" in copy.system, false);
  assert.equal(copy.system.container, null, "the copy lands loose in the target inventory");
  // The source data is not mutated.
  assert.equal(source.system.equipped, true);
  assert.equal(source.system.quantity, 3);
  assert.equal(source.system.container, "bag");
});

// ---- Stacking on the target ----
// Matches dnd5e 5.3.2 _onDropStackConsumables (same compendium source, same name, same container, consumables)
// and also requires the same spent uses, identification and, for loot, price.

const POTION = "Compendium.dnd5e.items.Item.potion";
const candidate = (id, overrides = {}) => ({ id, type: "consumable", name: "Potion of Healing", sourceId: POTION, containerId: "",
  spent: 0, identified: true, price: "50 gp", ...overrides });
const potion = (overrides = {}) => ({ type: "consumable", name: "Potion of Healing", sourceId: POTION, spent: 0, identified: true, price: "50 gp", ...overrides });

test("an identical loose consumable on the target absorbs the moved quantity", () => {
  assert.equal(findStackTarget(potion(), [candidate("p1")]), "p1");
});

test("loot with the same source and price stacks too (gems, trade goods)", () => {
  const ruby = { type: "loot", name: "Ruby", sourceId: "Compendium.x.Item.ruby", spent: 0, identified: true, price: "500 gp" };
  assert.equal(findStackTarget(ruby, [candidate("r1", { type: "loot", name: "Ruby", sourceId: "Compendium.x.Item.ruby", price: "500 gp" })]), "r1");
  assert.equal(findStackTarget(ruby, [candidate("r2", { type: "loot", name: "Ruby", sourceId: "Compendium.x.Item.ruby", price: "100 gp" })]), null);
});

test("weapons and other gear never stack", () => {
  const dagger = { type: "weapon", name: "Dagger", sourceId: "Compendium.x.Item.dagger", spent: 0, identified: true, price: "2 gp" };
  assert.equal(findStackTarget(dagger, [candidate("d1", { type: "weapon", name: "Dagger", sourceId: "Compendium.x.Item.dagger", price: "2 gp" })]), null);
});

test("items without a compendium source never stack, even with an identical twin", () => {
  assert.equal(findStackTarget(potion({ sourceId: "" }), [candidate("a", { sourceId: "" })]), null);
});

test("stacks need the same name, type, source, spent uses, identification and a loose target", () => {
  assert.equal(findStackTarget(potion(), [candidate("a", { name: "Potion of Greater Healing" })]), null);
  assert.equal(findStackTarget(potion(), [candidate("b", { type: "loot" })]), null);
  assert.equal(findStackTarget(potion(), [candidate("c", { sourceId: "Compendium.other.Item.x" })]), null);
  assert.equal(findStackTarget(potion(), [candidate("d", { containerId: "bag" })]), null);
  assert.equal(findStackTarget(potion(), [candidate("e", { spent: 1 })]), null);
  assert.equal(findStackTarget(potion(), [candidate("f", { identified: false })]), null);
});

// ---- Currency ----

test("a deposit moves coins from character to party", () => {
  const plan = planCurrencyTransfer({ pp: 0, gp: 10, ep: 0, sp: 5, cp: 0 }, { pp: 1, gp: 3, ep: 0, sp: 0, cp: 0 }, { gp: 4, sp: 5 });
  assert.deepEqual(plan, { ok: true, moved: { gp: 4, sp: 5 },
    from: { pp: 0, gp: 6, ep: 0, sp: 0, cp: 0 }, to: { pp: 1, gp: 7, ep: 0, sp: 5, cp: 0 } });
});

test("zero amounts are ignored, and an all-zero transfer is refused", () => {
  assert.deepEqual(planCurrencyTransfer({ gp: 1 }, {}, { gp: 0, sp: 0 }), { ok: false, code: "EMPTY" });
  assert.deepEqual(planCurrencyTransfer({ gp: 2 }, {}, { gp: 1, sp: 0 }).moved, { gp: 1 });
});

test("the giving side may never go negative", () => {
  assert.deepEqual(planCurrencyTransfer({ gp: 3 }, { gp: 0 }, { gp: 4 }), { ok: false, code: "INSUFFICIENT", denomination: "gp", available: 3 });
});

test("currency amounts must be whole, non-negative numbers of known coins", () => {
  assert.equal(planCurrencyTransfer({ gp: 5 }, {}, { gp: -1 }).code, "INVALID_AMOUNT");
  assert.equal(planCurrencyTransfer({ gp: 5 }, {}, { gp: 1.5 }).code, "INVALID_AMOUNT");
  assert.equal(planCurrencyTransfer({ gp: 5 }, {}, { gp: "2" }).code, "INVALID_AMOUNT");
  assert.equal(planCurrencyTransfer({ gp: 5 }, {}, { xp: 2 }).code, "INVALID_AMOUNT");
  assert.equal(planCurrencyTransfer({ gp: 5 }, {}, null).code, "EMPTY");
});

test("malformed stored balances count as zero", () => {
  const plan = planCurrencyTransfer({ gp: "junk" }, { gp: null }, { gp: 1 });
  assert.deepEqual(plan, { ok: false, code: "INSUFFICIENT", denomination: "gp", available: 0 });
});

test("coin text lists denominations from platinum down", () => {
  assert.equal(coinsText({ sp: 5, gp: 2 }), "2 gp, 5 sp");
  assert.equal(coinsText({ cp: 1, pp: 1 }), "1 pp, 1 cp");
  assert.equal(coinsText({}), "");
});

// ---- Stash list order ----

test("stash rows list loose items by name, each container followed by its contents", async () => {
  const { stashRows } = await import("../src/kernel/party-stash-rules.mjs");
  const rows = stashRows([
    { id: "t", name: "Torch", containerId: "" },
    { id: "bag", name: "Bag of Holding", containerId: "" },
    { id: "rope", name: "Rope", containerId: "bag" },
    { id: "box", name: "Box", containerId: "bag" },
    { id: "gem", name: "Gem", containerId: "box" },
    { id: "lost", name: "Arrow", containerId: "missing" }
  ]);
  assert.deepEqual(rows.map(row => [row.item.id, row.depth]),
    [["lost", 0], ["bag", 0], ["box", 1], ["gem", 2], ["rope", 1], ["t", 0]]);
});

// ---- The GM's per-party queue ----

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

test("tasks for the same party run one at a time, in arrival order", async () => {
  const queue = createKeyedQueue();
  const log = [];
  const task = name => async () => { log.push(`start ${name}`); await tick(); log.push(`end ${name}`); return name; };
  const results = await Promise.all([queue.run("party", task("a")), queue.run("party", task("b")), queue.run("party", task("c"))]);
  assert.deepEqual(results, ["a", "b", "c"]);
  assert.deepEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
});

test("tasks for different parties do not wait for each other", async () => {
  const queue = createKeyedQueue();
  const log = [];
  const task = name => async () => { log.push(`start ${name}`); await tick(); log.push(`end ${name}`); };
  await Promise.all([queue.run("one", task("a")), queue.run("two", task("b"))]);
  assert.deepEqual(log.slice(0, 2), ["start a", "start b"]);
});

test("a failed task rejects for its caller and the next task still runs", async () => {
  const queue = createKeyedQueue();
  const failing = queue.run("party", async () => { await tick(); throw new Error("boom"); });
  const next = queue.run("party", async () => "after");
  await assert.rejects(failing, /boom/);
  assert.equal(await next, "after");
  await tick();
  assert.equal(queue.size, 0, "idle keys are forgotten once their last task settles");
});
