// Unit tests for party-stash.mjs against small in-memory stand-ins for Foundry actors, items, users,
// CONFIG.queries and chat. Writes take a few milliseconds, like a server round trip, so concurrent
// moves really interleave. Run: node --test tests/*.test.mjs
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { PARTY_QUERY, partyViewRecord, registerPartyRelay, transferPartyCurrency, transferPartyItem } from "../src/foundry/systems/dnd5e/party-stash.mjs";

let messages;
const gm = { id: "gm", name: "GM", isGM: true, active: true };
const player = { id: "u1", name: "Player", isGM: false, active: true };
const other = { id: "u2", name: "Other", isGM: false, active: true };
const latency = () => new Promise(resolve => setTimeout(resolve, 3));

// A minimal embedded item: plain source data plus update/toObject.
function makeItem(actor, data) {
  return {
    ...structuredClone(data), parent: actor,
    get actor() { return actor; },
    // Foundry source data carries the document ID as _id.
    toObject() {
      const { parent, actor: _owner, id: _id, ...rest } = this;
      return structuredClone({ _id, ...Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== "function")) });
    },
    async update(changes) {
      await latency();
      if (!actor.items.has(this.id)) throw new Error(`Item "${this.id}" does not exist!`);
      for (const [path, value] of Object.entries(changes)) setPath(this, path, value);
      return this;
    }
  };
}

// Foundry Collections iterate their values, unlike a plain Map.
class Items extends Map { [Symbol.iterator]() { return this.values(); } }

// A minimal actor. `owners` maps user id → permission level; the GM is always Owner.
function makeActor({ id, name, type, owners = { u1: "OWNER" }, currency = {}, items = [] }) {
  const actor = {
    id, uuid: `Actor.${id}`, name, type, documentName: "Actor",
    system: { currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0, ...currency }, members: [] },
    hooks: {},
    testUserPermission(user, level) {
      const rank = { NONE: 0, LIMITED: 1, OBSERVER: 2, OWNER: 3 };
      return user?.isGM || rank[owners[user?.id] ?? "NONE"] >= rank[level];
    },
    async update(changes) {
      await latency();
      if (actor.hooks.failUpdate) { actor.hooks.failUpdate = false; throw new Error("network"); }
      for (const [path, value] of Object.entries(changes)) setPath(actor, path, value);
      return actor;
    },
    async createEmbeddedDocuments(_type, data) {
      await latency();
      if (actor.hooks.failCreate) { actor.hooks.failCreate = false; throw new Error("network"); }
      const created = data.map(entry => {
        const { _id, ...rest } = entry;
        const item = makeItem(actor, { ...rest, id: _id ?? `new${Math.random().toString(36).slice(2, 8)}` });
        actor.items.set(item.id, item);
        return item;
      });
      await actor.hooks.afterCreate?.();
      return created;
    },
    async deleteEmbeddedDocuments(_type, ids) {
      await latency();
      if (actor.hooks.failDelete) { actor.hooks.failDelete = false; throw new Error("network"); }
      for (const itemId of ids) if (!actor.items.has(itemId)) throw new Error(`Item "${itemId}" does not exist!`);
      for (const itemId of ids) actor.items.delete(itemId);
      return ids;
    }
  };
  actor.items = new Items(items.map(entry => [entry.id, makeItem(actor, entry)]));
  return actor;
}

function setPath(target, path, value) {
  const keys = path.split(".");
  let cursor = target;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] ??= {};
  cursor[keys.at(-1)] = value;
}

/** Install the fake world. `as` is the user this client runs as; `activeGM` the GM (or null). With a
 * remote GM, query() runs the registered handler as the GM, the way Foundry's socket would. */
function install(actors, { primary = null, as = gm, activeGM = gm } = {}) {
  const list = [...actors];
  list.get = actorId => actors.find(actor => actor.id === actorId);
  const users = [gm, player, other];
  globalThis.CONFIG = { queries: {} };
  globalThis.game = { user: as, actors: list, settings: { get: (scope, key) => scope === "dnd5e" && key === "primaryParty" ? { actor: primary } : null },
    users: Object.assign(users, { activeGM: activeGM && { ...activeGM, get isSelf() { return globalThis.game.user.id === activeGM.id; },
      async query(name, data) {
        const handler = globalThis.CONFIG.queries[name];
        if (!handler) throw new Error(`User query '${name}' is not registered`);
        // The handler starts on the GM's client; swap the current user only while it starts.
        const caller = globalThis.game.user;
        globalThis.game.user = gm;
        const pending = handler(structuredClone(data), { user: caller });
        globalThis.game.user = caller;
        return structuredClone(await pending);
      } } }) };
  globalThis.ChatMessage = { create: async data => { messages.push(data); return data; }, getSpeaker: ({ actor }) => ({ alias: actor.name }) };
  registerPartyRelay();
}

const rope = { id: "rope", name: "Rope", type: "loot", system: { quantity: 1, container: null } };
const potions = { id: "pot", name: "Potion of Healing", type: "consumable", _stats: { compendiumSource: "Compendium.dnd5e.items.Item.pot" }, system: { quantity: 5, container: null } };
const sword = { id: "sword", name: "Longsword", type: "weapon", system: { quantity: 1, equipped: true, attuned: false, container: null } };
const party = (extra = {}) => makeActor({ id: "party", name: "The Company", type: "group", ...extra });
const hero = (extra = {}) => makeActor({ id: "hero", name: "Ayla", type: "character", ...extra });
const take = (actor, itemId, quantity = 1) => transferPartyItem(actor, { partySourceUuid: "Actor.party", direction: "take", itemId, quantity });

beforeEach(() => { messages = []; delete globalThis.game; delete globalThis.ChatMessage; delete globalThis.CONFIG; });

test("the query name follows the module id", () => {
  assert.equal(PARTY_QUERY, "mobile-deck.partyTransfer");
});

test("taking the last item moves it to the character and tells the table", async () => {
  const stash = party({ items: [rope] }), ayla = hero();
  install([ayla, stash], { primary: stash, as: player });
  const result = await take(ayla, "rope");
  assert.equal(result.moved, 1);
  assert.equal(stash.items.has("rope"), false);
  assert.deepEqual([...ayla.items.values()].map(item => [item.name, item.system.quantity]), [["Rope", 1]]);
  assert.equal(messages.length, 1);
  assert.match(messages[0].content, /Ayla took 1× Rope from The Company\./);
  assert.equal(messages[0].whisper, undefined, "the note is public");
});

test("without an active GM nothing moves", async () => {
  const stash = party({ items: [rope] }), ayla = hero();
  install([ayla, stash], { as: player, activeGM: null });
  await assert.rejects(take(ayla, "rope"), error => error.code === "GM_OFFLINE" && /GM needs to be online/.test(error.message));
  assert.equal(stash.items.has("rope"), true);
});

test("a GM using Mobile Deck runs the move on their own client", async () => {
  const stash = party({ items: [rope] }), ayla = hero();
  install([ayla, stash], { as: gm });
  await take(ayla, "rope");
  assert.equal(ayla.items.size, 1);
});

test("two players each taking 1 from a stack of 2: exactly 2 leave the party", async () => {
  const stash = party({ items: [{ ...potions, system: { quantity: 2, container: null } }], owners: { u1: "OWNER", u2: "OWNER" } });
  const ayla = hero(), bram = makeActor({ id: "bram", name: "Bram", type: "character", owners: { u2: "OWNER" } });
  install([ayla, bram, stash], { as: player });
  const [first, second] = await Promise.all([take(ayla, "pot"), (async () => {
    globalThis.game.user = other;
    try { return await take(bram, "pot"); } finally { globalThis.game.user = player; }
  })()]);
  assert.equal(first.moved + second.moved, 2);
  assert.equal(stash.items.has("pot"), false);
  assert.equal([...ayla.items.values()][0].system.quantity, 1);
  assert.equal([...bram.items.values()][0].system.quantity, 1);
});

test("three takes from a stack of 2: the third is refused, nothing is duplicated", async () => {
  const stash = party({ items: [{ ...potions, system: { quantity: 2, container: null } }] });
  const ayla = hero();
  install([ayla, stash], { as: player });
  const outcomes = await Promise.allSettled([take(ayla, "pot"), take(ayla, "pot"), take(ayla, "pot")]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 2);
  assert.ok(["STALE_STATE"].includes(outcomes.find(outcome => outcome.status === "rejected").reason.code));
  assert.equal([...ayla.items.values()].reduce((sum, item) => sum + item.system.quantity, 0), 2);
});

test("two 60 gp withdrawals from 100 gp: one succeeds, one is refused", async () => {
  const stash = party({ currency: { gp: 100 } }), ayla = hero();
  install([ayla, stash], { as: player });
  const withdraw = () => transferPartyCurrency(ayla, { partySourceUuid: "Actor.party", direction: "withdraw", amounts: { gp: 60 } });
  const outcomes = await Promise.allSettled([withdraw(), withdraw()]);
  assert.equal(outcomes.filter(outcome => outcome.status === "fulfilled").length, 1);
  assert.equal(outcomes.find(outcome => outcome.status === "rejected").reason.code, "STALE_STATE");
  assert.equal(stash.system.currency.gp, 40);
  assert.equal(ayla.system.currency.gp, 60);
});

test("the GM re-checks permission: a requester who does not own the character is refused", async () => {
  const stash = party({ items: [rope], owners: { u1: "OWNER", u2: "OWNER" } }), ayla = hero();
  install([ayla, stash], { as: other });
  await assert.rejects(take(ayla, "rope"), error => error.code === "FORBIDDEN");
  assert.equal(stash.items.has("rope"), true);
});

test("the GM re-checks permission: a requester without Owner on the group is refused", async () => {
  const stash = party({ items: [rope], owners: { u1: "OBSERVER" } }), ayla = hero();
  install([ayla, stash], { as: gm });
  // Call the GM's handler directly, skipping the player's own early check, to prove the GM side refuses on its own.
  const response = await globalThis.CONFIG.queries[PARTY_QUERY]({ kind: "item", actorSourceUuid: "Actor.hero", partySourceUuid: "Actor.party",
    direction: "take", itemId: "rope", quantity: 1 }, { user: player });
  assert.equal(response.ok, false);
  assert.equal(response.code, "FORBIDDEN");
  assert.equal(stash.items.has("rope"), true);
});

test("asking for more than the party holds is refused before anything is written", async () => {
  const stash = party({ items: [potions] }), ayla = hero();
  install([ayla, stash], { as: player });
  await assert.rejects(take(ayla, "pot", 6), error => error.code === "STALE_STATE" && /Only 5/.test(error.message));
  assert.equal(stash.items.get("pot").system.quantity, 5);
  assert.equal(ayla.items.size, 0);
});

test("the copy is created before the source is touched; if the source vanished, the copy is removed", async () => {
  const stash = party({ items: [rope] }), ayla = hero();
  install([ayla, stash], { as: player });
  // Someone deletes the rope from the party sheet directly while the copy is being created.
  ayla.hooks.afterCreate = async () => { stash.items.delete("rope"); };
  await assert.rejects(take(ayla, "rope"), error => error.code === "STALE_STATE" && /no longer in The Company/.test(error.message));
  assert.equal(ayla.items.size, 0, "the copy was removed again");
  assert.equal(messages.length, 0);
});

test("a failed source write after the copy arrived removes the copy again", async () => {
  const stash = party({ items: [rope] }), ayla = hero();
  install([ayla, stash], { as: player });
  stash.hooks.failDelete = true;
  await assert.rejects(take(ayla, "rope"));
  assert.equal(stash.items.has("rope"), true);
  assert.equal(ayla.items.size, 0);
});

test("if the copy cannot be removed again, the error says so plainly", async () => {
  const stash = party({ items: [rope] }), ayla = hero();
  install([ayla, stash], { as: player });
  stash.hooks.failDelete = true;
  ayla.hooks.afterCreate = async () => { ayla.hooks.failDelete = true; };
  await assert.rejects(take(ayla, "rope"), error => error.code === "RESTORE_FAILED" && /Tell your GM/.test(error.message));
});

test("an observer cannot move anything", async () => {
  const stash = party({ items: [rope], owners: { u1: "OBSERVER" } }), ayla = hero();
  install([ayla, stash], { as: player });
  await assert.rejects(take(ayla, "rope"), error => error.code === "FORBIDDEN");
  assert.equal(stash.items.has("rope"), true);
});

test("sending gear drops its equipped state", async () => {
  const stash = party(), ayla = hero({ items: [sword] });
  install([ayla, stash], { as: player });
  await transferPartyItem(ayla, { partySourceUuid: "Actor.party", direction: "send", itemId: "sword", quantity: 1 });
  const stashed = [...stash.items.values()][0];
  assert.equal(stashed.name, "Longsword");
  assert.equal("equipped" in stashed.system, false);
  assert.equal(ayla.items.has("sword"), false);
  assert.match(messages[0].content, /Ayla put 1× Longsword in The Company\./);
});

test("sending potions joins the party's identical stack", async () => {
  const stash = party({ items: [{ ...potions, id: "stash", system: { quantity: 1, container: null } }] });
  const ayla = hero({ items: [potions] });
  install([ayla, stash], { as: player });
  await transferPartyItem(ayla, { partySourceUuid: "Actor.party", direction: "send", itemId: "pot", quantity: 2 });
  assert.equal(stash.items.size, 1);
  assert.equal(stash.items.get("stash").system.quantity, 3);
  assert.equal(ayla.items.get("pot").system.quantity, 3);
});

test("depositing coins moves them from the character to the party", async () => {
  const stash = party({ currency: { gp: 10 } }), ayla = hero({ currency: { gp: 7, sp: 3 } });
  install([ayla, stash], { as: player });
  await transferPartyCurrency(ayla, { partySourceUuid: "Actor.party", direction: "deposit", amounts: { gp: 5, sp: 3 } });
  assert.deepEqual([ayla.system.currency.gp, ayla.system.currency.sp, stash.system.currency.gp, stash.system.currency.sp], [2, 0, 15, 3]);
  assert.match(messages[0].content, /Ayla put 5 gp, 3 sp in The Company\./);
});

test("if the coins cannot leave the party after being credited, the credit is taken back", async () => {
  const stash = party({ currency: { gp: 9 } }), ayla = hero();
  install([ayla, stash], { as: player });
  // The credit lands first; the party's debit then fails.
  const realUpdate = stash.update;
  stash.update = async () => { stash.update = realUpdate; throw new Error("network"); };
  await assert.rejects(transferPartyCurrency(ayla, { partySourceUuid: "Actor.party", direction: "withdraw", amounts: { gp: 4 } }));
  assert.equal(stash.system.currency.gp, 9);
  assert.equal(ayla.system.currency.gp, 0);
});

test("the sheet record: missing, read-only, owner, Limited, and a hidden primary party", () => {
  const ayla = hero();
  install([ayla], { as: player });
  assert.deepEqual(partyViewRecord(ayla, player), { status: "missing" });

  const watched = party({ owners: { u1: "OBSERVER" }, currency: { gp: 4 }, items: [rope] });
  install([ayla, watched], { primary: watched, as: player });
  const readOnly = partyViewRecord(ayla, player);
  assert.equal(readOnly.status, "ready");
  assert.equal(readOnly.access, "observer");
  assert.equal(readOnly.primary, true);
  assert.equal(readOnly.currency.gp, 4);
  assert.deepEqual(readOnly.items.map(item => [item.id, item.quantity]), [["rope", 1]]);

  install([ayla, party()], { as: player });
  assert.equal(partyViewRecord(ayla, player).access, "owner");

  const limited = party({ name: "Secret", owners: { u1: "LIMITED" } });
  install([ayla, limited], { as: player });
  assert.deepEqual(partyViewRecord(ayla, player), { status: "locked", name: "Secret", access: "limited" });

  const hidden = party({ owners: {} });
  const unrelated = makeActor({ id: "other", name: "Other Group", type: "group" });
  install([ayla, hidden, unrelated], { primary: hidden, as: player });
  assert.deepEqual(partyViewRecord(ayla, player), { status: "locked", name: "", access: "none" }, "no fallback to an unrelated group");
});
