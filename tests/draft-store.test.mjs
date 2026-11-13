// Unit tests for draft-store.mjs (creation draft and rolls) with a fake user. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDraftStore } from "../src/foundry/systems/dnd5e/builder/draft-store.mjs";
import { CREATION_VERSION, emptyDraft, emptyRolls } from "../src/foundry/systems/dnd5e/builder/creation-tabs.mjs";

const DEL = { deletion: true };
/** Stand-in for Foundry 14's ForcedReplacement operator (replace a value whole, no merge). */
class FakeReplace { constructor(value) { this.value = value; } static create(value) { return new FakeReplace(value); } }

/** A user whose update() merges like Foundry: nested objects merge, `_del` / "-=key" delete. */
function fakeGame(flags = {}) {
  const updates = [];
  const merge = (target, changes) => {
    for (const [k, v] of Object.entries(changes)) {
      if (k.startsWith("-=")) { delete target[k.slice(2)]; continue; }
      if (k.startsWith("==")) { target[k.slice(2)] = structuredClone(v); continue; }
      if (v === DEL) { delete target[k]; continue; }
      if (v instanceof FakeReplace) { target[k] = structuredClone(v.value); continue; }
      if (v && typeof v === "object" && !Array.isArray(v)) { target[k] = target[k] && typeof target[k] === "object" ? target[k] : {}; merge(target[k], v); }
      else target[k] = v;
    }
  };
  const user = {
    flags: { mod: structuredClone(flags) },
    getFlag(scope, key) { return this.flags[scope]?.[key]; },
    async setFlag(scope, key, value) { return this.update({ flags: { [scope]: { [key]: value } } }); },
    async unsetFlag(scope, key) { updates.push({ unset: key }); delete this.flags[scope][key]; },
    async update(changes) { updates.push(changes); merge(this, changes); return this; }
  };
  return { game: { user }, updates };
}

test("creation(): only a draft of this version with tabs is read back", () => {
  const good = { ...emptyDraft({ owner: "u" }) };
  for (const [raw, ok] of [[JSON.stringify(good), true], ["{not json", false], [JSON.stringify({ version: CREATION_VERSION }), false],
    [JSON.stringify({ ...good, version: 1 }), false], [JSON.stringify(null), false], [JSON.stringify("text"), false]]) {
    const { game } = fakeGame({ builder: { creationJson: raw } });
    assert.equal(Boolean(createDraftStore("mod", game).creation()), ok, raw);
  }
});

for (const [name, del] of [["Foundry 14 (_del)", DEL], ["older cores (-= key)", undefined]]) {
  test(`clearCreation and finishCreation delete only their keys, in one update: ${name}`, async () => {
    globalThis._del = del;
    try {
      const { game, updates } = fakeGame({ builder: { drafts: { a1: { answers: [] } }, rolls: { "a1|wizard|2": { value: 3 } },
        creationJson: JSON.stringify(emptyDraft()), creationRolls: JSON.stringify(emptyRolls()) } });
      const store = createDraftStore("mod", game);
      await store.clearCreation();
      assert.equal(updates.length, 1);
      assert.deepEqual(Object.keys(game.user.flags.mod.builder).sort(), ["creationRolls", "drafts", "rolls"]);
      await store.finishCreation();
      assert.equal(updates.length, 2);
      assert.deepEqual(Object.keys(game.user.flags.mod.builder).sort(), ["drafts", "rolls"]);
    } finally { delete globalThis._del; }
  });
}

test("rolls survive clearing the draft and are saved apart from it", async () => {
  const { game, updates } = fakeGame({ builder: { drafts: { a1: {} } } });
  const store = createDraftStore("mod", game);
  assert.deepEqual(store.creationRolls(), emptyRolls());
  const rolls = emptyRolls();
  rolls.abilities.sets.push([10, 11, 12, 13, 14, 15]);
  await store.saveCreationRolls(rolls);
  await store.saveCreation(emptyDraft());
  await store.clearCreation();
  assert.deepEqual(store.creationRolls().abilities.sets, [[10, 11, 12, 13, 14, 15]]);
  assert.equal(store.creation(), null);
  assert.ok(game.user.flags.mod.builder.drafts.a1, "level-up drafts untouched");
  // Each save writes its own key only.
  assert.deepEqual(Object.keys(updates[0].flags.mod.builder), ["creationRolls"]);
  assert.deepEqual(Object.keys(updates[1].flags.mod.builder), ["creationJson"]);
});

test("level-up clearDraft removes one actor's draft (and its roll locks) in one update", async () => {
  globalThis._del = DEL;
  try {
    const { game, updates } = fakeGame({ builder: { drafts: { a1: {}, a2: {} }, rolls: { "a1|wizard|2": { value: 3 }, "a2|fighter|4": { value: 7 } },
      creationRolls: "{}" } });
    const store = createDraftStore("mod", game);
    await store.finish("a1");
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.drafts), ["a2"]);
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.rolls), ["a2|fighter|4"]);
    assert.equal(game.user.flags.mod.builder.creationRolls, "{}");
    await store.clearDraft("a2");
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.drafts), []);
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.rolls), ["a2|fighter|4"]);
  } finally { delete globalThis._del; }
});

for (const [name, operators] of [["Foundry 14 (ForcedReplacement)", { ForcedReplacement: FakeReplace }], ["older cores (== key)", undefined]]) {
  test(`level-up saveDraft writes only its own draft, replaced whole: ${name}`, async () => {
    const before = globalThis.foundry;
    globalThis.foundry = operators ? { data: { operators } } : undefined;
    try {
      const { game, updates } = fakeGame({ builder: { drafts: { a2: { answers: [1] } }, creationJson: "OLD" } });
      const store = createDraftStore("mod", game);
      await store.saveDraft("a1", { target: { kind: "level", classId: "c1" }, answers: [] });
      // Meanwhile the creation draft moves on; a later level-up save must not bring back the value it once read.
      game.user.flags.mod.builder.creationJson = "NEW";
      await store.saveDraft("a1", { target: { kind: "new-class", classUuid: "u" }, answers: [{ key: "k" }] });
      assert.equal(updates.length, 2);
      for (const u of updates) assert.deepEqual(Object.keys(u.flags.mod.builder), ["drafts"]);
      const b = game.user.flags.mod.builder;
      assert.equal(b.creationJson, "NEW");
      assert.deepEqual(b.drafts.a1.target, { kind: "new-class", classUuid: "u" }); // no stale classId merged in
      assert.deepEqual(b.drafts.a2, { answers: [1] });
      await store.clearDraft("a1");
      assert.deepEqual(Object.keys(game.user.flags.mod.builder.drafts), ["a2"]);
    } finally { globalThis.foundry = before; }
  });
}

test("rollHitPoints locks its roll under its own key only", async () => {
  const saved = { Roll: globalThis.Roll, ChatMessage: globalThis.ChatMessage, CONST: globalThis.CONST };
  globalThis.Roll = class { constructor() { this.total = 7; } async evaluate() { return this; } async toMessage() { return { id: "msg1" }; } };
  globalThis.ChatMessage = { getSpeaker: () => ({}) };
  globalThis.CONST = { DICE_ROLL_MODES: { PRIVATE: "gmroll" } };
  try {
    const { game, updates } = fakeGame({ builder: { rolls: { "a2|fighter|4": { value: 3 } }, creationRolls: "OLD" } });
    game.users = [];
    const store = createDraftStore("mod", game);
    game.user.flags.mod.builder.creationRolls = "NEW";
    const lock = await store.rollHitPoints({ actor: { id: "a1" }, classIdentifier: "wizard", className: "Wizard", level: 2, die: 6 });
    assert.equal(lock.value, 7);
    assert.equal(lock.messageId, "msg1");
    assert.deepEqual(Object.keys(updates[0].flags.mod.builder), ["rolls"]);
    assert.deepEqual(Object.keys(updates[0].flags.mod.builder.rolls), ["a1|wizard|2"]);
    const b = game.user.flags.mod.builder;
    assert.equal(b.creationRolls, "NEW");
    assert.deepEqual(Object.keys(b.rolls).sort(), ["a1|wizard|2", "a2|fighter|4"]);
    assert.equal((await store.rollHitPoints({ actor: { id: "a1" }, classIdentifier: "wizard", level: 2, die: 6 })).value, 7); // locked
    assert.equal(updates.length, 1);
    await store.finish("a1");
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.rolls), ["a2|fighter|4"]);
  } finally { Object.assign(globalThis, saved); }
});

test("a store for another user reads and writes that user's flag, not game.user's", async () => {
  const { game } = fakeGame({ builder: { creationJson: JSON.stringify(emptyDraft({ owner: "gm" })) } });
  const other = fakeGame({ builder: { creationJson: JSON.stringify({ ...emptyDraft({ owner: "p" }), status: "submitted", submittedAt: 7 }) } }).game.user;
  const store = createDraftStore("mod", game, other);
  assert.equal(store.creation().owner, "p");
  await store.finishCreation();
  assert.equal(other.flags.mod.builder.creationJson, undefined);
  assert.ok(game.user.flags.mod.builder.creationJson, "game.user's draft untouched");
});

test("results: saved whole per key, cleared alone", async () => {
  globalThis._del = DEL;
  globalThis.foundry = { data: { operators: { ForcedReplacement: FakeReplace } } };
  try {
    const { game } = fakeGame({ builder: { results: { creation: { name: "old", extra: 1 } } } });
    const store = createDraftStore("mod", game);
    await store.saveResult("creation", { name: "Mira" });
    await store.saveResult("levelUp:a1", { name: "Brienne" });
    assert.deepEqual(store.results(), { creation: { name: "Mira" }, "levelUp:a1": { name: "Brienne" } });
    await store.clearResult("creation");
    assert.deepEqual(Object.keys(store.results()), ["levelUp:a1"]);
  } finally { delete globalThis._del; delete globalThis.foundry; }
});

test("approval finish: the draft (and its rolls) go and the result arrives in ONE update", async () => {
  globalThis._del = DEL;
  globalThis.foundry = { data: { operators: { ForcedReplacement: FakeReplace } } };
  try {
    const { game, updates } = fakeGame({ builder: { creationJson: "{}", creationRolls: "{}", drafts: { a1: { status: "approving" }, a2: { status: "draft" } },
      rolls: { "a1|fighter|2": { value: 7 }, "a2|wizard|2": { value: 3 } } } });
    const store = createDraftStore("mod", game);
    await store.finishCreationWith("creation", { name: "Mira" });
    assert.equal(updates.length, 1);
    assert.deepEqual(Object.keys(game.user.flags.mod.builder).sort(), ["drafts", "results", "rolls"]);
    await store.finishLevelUpWith("a1", "levelUp:a1", { name: "Brienne" });
    assert.equal(updates.length, 2);
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.drafts), ["a2"]);
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.rolls), ["a2|wizard|2"]);
    assert.deepEqual(Object.keys(game.user.flags.mod.builder.results).sort(), ["creation", "levelUp:a1"]);
  } finally { delete globalThis._del; delete globalThis.foundry; }
});

test("locksFor: an actor's HP locks only", () => {
  const { game } = fakeGame({ builder: { rolls: { "a1|fighter|4": { value: 7, messageId: "m" }, "a2|wizard|2": { value: 3 } } } });
  assert.deepEqual(createDraftStore("mod", game).locksFor("a1"), [{ key: "a1|fighter|4", value: 7, messageId: "m" }]);
});

test("rawCreation: the stored JSON as parsed, also when creation() can't read it (the GM removes it)", async () => {
  const old = { version: 1, status: "submitted", submittedAt: 5, tabs: {} };
  const { game, updates } = fakeGame({ builder: { creationJson: JSON.stringify(old), creationRolls: "{}" } });
  const store = createDraftStore("mod", game);
  assert.equal(store.creation(), null);
  assert.deepEqual(store.rawCreation(), old);
  await store.clearCreation();
  assert.equal(store.rawCreation(), null);
  assert.equal(updates.length, 1);
  assert.equal(game.user.flags.mod.builder.creationRolls, "{}", "the rolls stay");
});
