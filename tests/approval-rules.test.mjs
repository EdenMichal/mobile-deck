// Unit tests for approval-rules.mjs (Phase 4b). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { asApproving, asDraft, asRejected, asSubmitted, asUnclaimed, canClaim, canWithdraw, checkGoldRolls, checkHpRolls, checkLevelUpTarget, checkRollCount,
  checkRolledSets, claimedElsewhere, claimIsStale, CLAIM_STALE_MS, collectSubmissions, holdsClaim, isWaiting, needsApproval, resultKey, serverNow,
  sameSubmission, statusOf, submissionId } from "../src/foundry/systems/dnd5e/builder/approval-rules.mjs";

const rules = (creation = true, levelUp = true) => ({ approval: { creation, levelUp } });

test("needsApproval: players need it per switch; GMs never", () => {
  const player = { isGM: false };
  assert.equal(needsApproval("creation", player, rules()), true);
  assert.equal(needsApproval("level-up", player, rules()), true);
  assert.equal(needsApproval("creation", player, rules(false, true)), false);
  assert.equal(needsApproval("level-up", player, rules(true, false)), false);
  assert.equal(needsApproval("creation", { isGM: true }, rules()), false);
  assert.equal(needsApproval("creation", player, {}), true, "missing switches mean on");
  assert.equal(needsApproval("creation", null, rules()), false);
});

test("status changes keep the draft and move only the approval fields", () => {
  const draft = { tabs: { a: 1 }, status: "draft" };
  const sub = asSubmitted(draft, 100, { level: 3 });
  assert.deepEqual(sub, { tabs: { a: 1 }, status: "submitted", submittedAt: 100, level: 3 });
  const rej = asRejected(sub, "  Pick a different feat ", { id: "g", name: "GM" });
  assert.deepEqual(rej, { tabs: { a: 1 }, status: "rejected", level: 3, rejectReason: "Pick a different feat", rejectedBy: { id: "g", name: "GM" } });
  const back = asDraft(rej);
  assert.equal(back.status, "draft");
  assert.equal(back.rejectReason, "Pick a different feat", "the GM's note stays until the next Submit");
  assert.equal("submittedAt" in back, false);
  const again = asSubmitted(back, 200);
  assert.equal("rejectReason" in again, false);
  assert.equal("rejectedBy" in again, false);
  assert.equal(statusOf(again), "submitted");
  assert.equal(statusOf(null), "draft");
  assert.equal(statusOf({ status: "odd" }), "draft");
  const approving = asApproving(again, "pageA", 300);
  assert.equal(statusOf(approving), "approving");
  assert.equal(approving.submittedAt, 200, "approving keeps the submission's stamp");
  assert.equal(approving.approvingBy, "pageA");
  assert.equal(approving.approvingAt, 300);
  assert.equal(isWaiting(approving), true);
  assert.equal(isWaiting(again), true);
  assert.equal(isWaiting(rej), false);
});

test("resultKey and sameSubmission (submitted or approving, same stamp)", () => {
  assert.equal(resultKey("creation"), "creation");
  assert.equal(resultKey("level-up", "a1"), "levelUp:a1");
  assert.equal(sameSubmission({ status: "submitted", submittedAt: 5 }, { status: "submitted", submittedAt: 5 }), true);
  assert.equal(sameSubmission({ status: "submitted", submittedAt: 5 }, { status: "approving", submittedAt: 5 }), true);
  assert.equal(sameSubmission({ status: "submitted", submittedAt: 5 }, { status: "submitted", submittedAt: 6 }), false);
  assert.equal(sameSubmission({ status: "submitted", submittedAt: 5 }, { status: "draft" }), false);
  assert.equal(sameSubmission({ status: "submitted", submittedAt: 5 }, null), false);
});

test("collectSubmissions: players' submitted creation and level-ups, oldest first; GMs and other statuses skipped", () => {
  const users = [
    { id: "p1", name: "Ann", isGM: false, builder: {
      creationJson: JSON.stringify({ version: 2, status: "submitted", submittedAt: 30, tabs: { details: { name: " Mira " } } }),
      drafts: { a1: { status: "submitted", submittedAt: 10, label: "Fighter 3 → 4" }, a2: { status: "draft" }, a3: { status: "rejected" },
        a4: { status: "approving", submittedAt: 40, label: "Wizard 1 → 2", approvingBy: "pg", approvingAt: 45 } } } },
    { id: "p2", name: "Bo", isGM: false, builder: { creationJson: "{broken" } },
    // Waiting, but not a draft store.creation() reads (an older version): listed as invalid, so the GM can send it back.
    { id: "p4", name: "Di", isGM: false, builder: { creationJson: JSON.stringify({ version: 1, status: "submitted", submittedAt: 50, tabs: {} }) } },
    { id: "p3", name: "Cy", isGM: false, builder: null },
    { id: "g", name: "GM", isGM: true, builder: { drafts: { a9: { status: "submitted", submittedAt: 1 } } } }
  ];
  const list = collectSubmissions(users);
  assert.deepEqual(list.map(s => [s.userId, s.kind, s.key, s.actorId, s.submittedAt, s.label]), [
    ["p1", "level-up", "levelUp:a1", "a1", 10, "Fighter 3 → 4"],
    ["p1", "creation", "creation", null, 30, "Mira"],
    // An approval a GM client didn't finish (closed mid-way) stays listed, so it can be decided again.
    ["p1", "level-up", "levelUp:a4", "a4", 40, "Wizard 1 → 2"],
    ["p4", "creation", "creation", null, 50, ""]
  ]);
  assert.equal(submissionId(list[0]), "p1|levelUp:a1|10");
  assert.deepEqual(list.map(s => s.invalid ?? false), [false, false, false, true], "same validity check as store.creation()");
  assert.deepEqual([list[2].status, list[2].approvingBy, list[2].approvingAt], ["approving", "pg", 45], "the claim travels with the entry");
});

test("checkRolledSets: each set against its chat card", () => {
  const cards = { m1: { authorId: "p", totals: [15, 14, 13, 12, 10, 8] }, m2: { authorId: "x", totals: [9, 9, 9, 9, 9, 9] },
    m3: { authorId: "p", totals: [18, 18, 18, 18, 18, 17] } };
  const lookup = id => cards[id] ?? null;
  const sets = [[15, 14, 13, 12, 10, 8], [9, 9, 9, 9, 9, 9], [18, 18, 18, 18, 18, 18], [3, 3, 3, 3, 3, 3]];
  assert.deepEqual(checkRolledSets({ sets, messageIds: ["m1", "m2", "m3", ""] }, lookup, "p"), [
    { index: 1, problem: "author" }, { index: 2, problem: "totals" }, { index: 3, problem: "missing" }]);
  assert.deepEqual(checkRolledSets(undefined, lookup, "p"), []);
});

test("checkHpRolls: the applied value of each HP step: avg, or a locked roll (same die) whose chat card checks out", () => {
  const cards = { h1: { authorId: "p", totals: [7] }, h2: { authorId: "p", totals: [2] }, h3: { authorId: "g", totals: [6] } };
  const lookup = id => cards[id] ?? null;
  const locks = [{ key: "a|fighter|4", value: 7, die: 10, messageId: "h1" }, { key: "a|fighter|5", value: 5, die: 10, messageId: "h2" },
    { key: "a|wizard|2", value: 4, die: 6, messageId: "" }, { key: "a|rogue|3", value: 6, die: 8, messageId: "h3" }, { key: "a|old|9", value: 1, die: 8, messageId: "gone" },
    { key: "a|cleric|3", value: 7, die: 10, messageId: "h1" }];
  const step = (value, key, die) => ({ value, key, die });
  assert.deepEqual(checkHpRolls([step(7, "a|fighter|4", 10), step("avg", "a|fighter|6", 10)], locks, lookup, "p"), [], "avg and a good lock; an unused lock (old|9) doesn't warn");
  assert.deepEqual(checkHpRolls([step(5, "a|fighter|5", 10), step(4, "a|wizard|2", 6), step(6, "a|rogue|3", 8),
    step(8, "a|fighter|4", 10), step(3, "a|cleric|2", 8)], locks, lookup, "p"), [
    { value: 5, problem: "totals" }, { value: 4, problem: "missing" }, { value: 6, problem: "author" }, { value: 8, problem: "unlocked" }, { value: 3, problem: "unlocked" }]);
  // What is applied counts: anything but "avg" or a whole number from 1 to the die is a problem.
  assert.deepEqual(checkHpRolls([step(11, "a|fighter|4", 10), step(0, "a|fighter|4", 10), step("max", "a|fighter|4", 10), step(2.5, "a|fighter|4", 10),
    step("7", "a|fighter|4", 10), step(null, "a|fighter|4", 10)], locks, lookup, "p").map(p => p.problem),
  ["invalid", "invalid", "invalid", "invalid", "invalid", "invalid"]);
  assert.deepEqual(checkHpRolls([step(7, "a|cleric|3", 8)], locks, lookup, "p"), [{ value: 7, problem: "unlocked" }], "a lock for another die doesn't count");
});

test("claims: only a submitted request or a stale claim can be claimed; a fresh claim by another page is left alone", () => {
  const now = 1_000_000;
  const submitted = { status: "submitted", submittedAt: 5 };
  const fresh = asApproving(submitted, "other", now - 1000);
  const stale = asApproving(submitted, "other", now - CLAIM_STALE_MS - 1);
  const legacy = { status: "approving", submittedAt: 5 }; // no claim stamp at all (before this fix): stale
  assert.equal(CLAIM_STALE_MS, 120000);
  assert.equal(canClaim(submitted, now), true);
  assert.equal(canClaim(fresh, now), false);
  assert.equal(canClaim(fresh, now, "me"), false, "a fresh claim by another page");
  assert.equal(canClaim(fresh, now, "other"), true, "this page's own claim (a finish that failed): Approve again only finishes");
  assert.equal(canClaim(stale, now), true);
  assert.equal(canClaim(legacy, now), true);
  assert.equal(canClaim({ status: "draft" }, now), false);
  assert.equal(canClaim(null, now), false);
  assert.equal(claimIsStale(fresh, now), false);
  assert.equal(claimIsStale(stale, now), true);
  assert.equal(claimIsStale(submitted, now), false, "only a claim can be stale");
  assert.equal(holdsClaim(fresh, "other"), true);
  assert.equal(holdsClaim(fresh, "me"), false);
  assert.equal(holdsClaim(submitted, "other"), false);
  assert.equal(claimedElsewhere(fresh, "me", now), true);
  assert.equal(claimedElsewhere(fresh, "other", now), false, "my own claim");
  assert.equal(claimedElsewhere(stale, "me", now), false, "a stale claim can be taken over");
  assert.equal(claimedElsewhere(submitted, "me", now), false);
  assert.equal(canWithdraw(submitted, now), true);
  assert.equal(canWithdraw(fresh, now), false);
  assert.equal(canWithdraw(stale, now), true, "a GM client that died mid-way doesn't lock the player out");
  assert.equal(sameSubmission(submitted, fresh), true, "a claim keeps the stamp");
  const back = asUnclaimed(fresh);
  assert.deepEqual(back, { status: "submitted", submittedAt: 5 });
  for (const next of [asDraft(fresh), asRejected(fresh, "no", { id: "g" }), asSubmitted(fresh, 9)]) {
    assert.equal("approvingBy" in next || "approvingAt" in next, false, next.status);
  }
});

test("checkRollCount: more sets than the rerolls allow, or a reroll count that doesn't match the sets", () => {
  const rules = { abilityRerolls: 1 };
  assert.deepEqual(checkRollCount({ sets: [], rerollsUsed: 0 }, rules), []);
  assert.deepEqual(checkRollCount({ sets: [[1], [2]], rerollsUsed: 1 }, rules), []);
  assert.deepEqual(checkRollCount({ sets: [[1], [2], [3]], rerollsUsed: 2 }, rules), [{ problem: "tooMany", sets: 3, allowed: 2 }]);
  assert.deepEqual(checkRollCount({ sets: [[1], [2]], rerollsUsed: 0 }, rules), [{ problem: "rerolls", used: 0, expected: 1 }]);
  assert.deepEqual(checkRollCount({ sets: [], rerollsUsed: 1 }, rules), [{ problem: "rerolls", used: 1, expected: 0 }]);
  assert.deepEqual(checkRollCount({ sets: [[1], [2]], rerollsUsed: 1 }, {}).map(p => p.problem), ["tooMany"], "no rerolls by default");
  assert.deepEqual(checkRollCount(undefined, rules), []);
});

test("checkGoldRolls: each rolled starting gold against its chat card", () => {
  const cards = { m1: { authorId: "p", totals: [120] }, m2: { authorId: "x", totals: [80] }, m3: { authorId: "p", totals: [10] } };
  const lookup = id => cards[id] ?? null;
  assert.deepEqual(checkGoldRolls([{ uuid: "a", value: 120, messageId: "m1" }, { uuid: "b", value: 80, messageId: "m2" },
    { uuid: "c", value: 99, messageId: "m3" }, { uuid: "d", value: 5, messageId: "" }], lookup, "p"), [
    { uuid: "b", value: 80, problem: "author" }, { uuid: "c", value: 99, problem: "totals" }, { uuid: "d", value: 5, problem: "missing" }]);
  assert.deepEqual(checkGoldRolls([], lookup, "p"), []);
});

test("checkLevelUpTarget: a class the actor has, or an allowed new class; nothing else", () => {
  const actor = { classIds: ["c1"], identifiers: ["fighter"], level: 3, maxLevel: 20 };
  const rules = { multiclass: true, bannedClasses: ["warlock"] };
  const doc = (identifier, type = "class") => ({ type, system: { identifier } });
  assert.equal(checkLevelUpTarget({ kind: "level", classId: "c1" }, { ...actor, rules }), null);
  assert.equal(checkLevelUpTarget({ kind: "level", classId: "zz" }, { ...actor, rules }), "class");
  assert.equal(checkLevelUpTarget({ kind: "level", classId: "c1" }, { ...actor, level: 20, rules }), "max");
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { ...actor, rules, doc: doc("wizard") }), null);
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { ...actor, rules: { ...rules, multiclass: false }, doc: doc("wizard") }), "multiclass");
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { classIds: [], identifiers: [], level: 0, maxLevel: 20, rules: { ...rules, multiclass: false }, doc: doc("wizard") }), null,
    "a first class is not multiclassing");
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { ...actor, rules, doc: doc("warlock") }), "banned");
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { ...actor, rules, doc: doc("wizard", "feat") }), "notClass");
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { ...actor, rules, doc: null }), "notClass");
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { ...actor, rules, doc: doc("fighter") }), "owned");
  assert.equal(checkLevelUpTarget({ kind: "new-class", classUuid: "u" }, { ...actor, level: 20, rules, doc: doc("wizard") }), "max");
  assert.equal(checkLevelUpTarget({ kind: "new-item", uuid: "u" }, { ...actor, rules }), "kind");
  assert.equal(checkLevelUpTarget(null, { ...actor, rules }), "kind");
});

test("serverNow: Foundry's server clock (game.time.serverTime), else this device's", () => {
  assert.equal(serverNow({ time: { serverTime: 1234 } }), 1234);
  const before = Date.now();
  const local = serverNow({});
  assert.ok(local >= before && local <= Date.now());
  assert.ok(Number.isFinite(serverNow({ time: { serverTime: NaN } })));
});
