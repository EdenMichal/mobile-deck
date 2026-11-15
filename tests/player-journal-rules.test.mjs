// Unit tests for player journal rules (player-journal-rules.mjs). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ROLES, readFolderFlag, cleanName, findFolder, planFolderUpkeep, upkeepIsIdle, ownedFolder, characterFolderOf,
  assertCanHoldFolder, folderMoveTargets, journalMoveTargets, buildCharacterTree, reorderUpdates, nextSort,
  fitImage, checkImageUpload, imageFileName, dropsElement, dropsAttribute, isBlankHtml, MAX_NAME_LENGTH
} from "../src/kernel/player-journal-rules.mjs";

// Two players: u1 plays a1 and a2, u2 plays a3.
const folder = (id, role, { parentId = "", userId = "", actorId = "", name = id, sort = 0 } = {}) => ({ id, name, parentId, sort, role, userId, actorId });
const world = () => [
  folder("root", ROLES.ROOT, { name: "Player Journals" }),
  folder("fu1", ROLES.USER, { parentId: "root", userId: "u1", name: "Ana" }),
  folder("fa1", ROLES.CHARACTER, { parentId: "fu1", userId: "u1", actorId: "a1", name: "Thorin", sort: 1 }),
  folder("fa2", ROLES.CHARACTER, { parentId: "fu1", userId: "u1", actorId: "a2", name: "Mira", sort: 2 }),
  folder("quests", ROLES.CUSTOM, { parentId: "fa1", userId: "u1", actorId: "a1", name: "Quests", sort: 2 }),
  folder("npcs", ROLES.CUSTOM, { parentId: "fa1", userId: "u1", actorId: "a1", name: "NPCs", sort: 1 }),
  folder("fu2", ROLES.USER, { parentId: "root", userId: "u2", name: "Ben" }),
  folder("fa3", ROLES.CHARACTER, { parentId: "fu2", userId: "u2", actorId: "a3", name: "Pip" }),
  folder("loot", ROLES.CUSTOM, { parentId: "fa3", userId: "u2", actorId: "a3", name: "Loot" }),
  folder("gm", "", { name: "GM notes" })
];

const code = (fn, expected) => assert.throws(fn, error => error.code === expected);

// ---- Flags and names ----

test("folder flags are read only when complete", () => {
  assert.deepEqual(readFolderFlag({ role: "root" }), { role: "root", userId: "", actorId: "" });
  assert.equal(readFolderFlag({ role: "user" }), null, "a player folder needs its player");
  assert.equal(readFolderFlag({ role: "character", userId: "u1" }), null, "a character folder needs its actor");
  assert.equal(readFolderFlag({ role: "other", userId: "u1" }), null);
  assert.equal(readFolderFlag(null), null);
});

test("names are trimmed, collapsed, and must be 1 to 100 characters", () => {
  assert.equal(cleanName("  The   Lost\nMine  "), "The Lost Mine");
  code(() => cleanName("   "), "INVALID_INPUT");
  code(() => cleanName("x".repeat(MAX_NAME_LENGTH + 1)), "INVALID_INPUT");
  assert.equal(cleanName("x".repeat(MAX_NAME_LENGTH)).length, MAX_NAME_LENGTH);
});

// ---- Folder upkeep on the GM's client ----

test("an empty world plans the root, the player and each character", () => {
  const plan = planFolderUpkeep([], [{ userId: "u1", name: "Ana", characters: [{ actorId: "a1", name: "Thorin" }] }]);
  assert.equal(plan.root.create, true);
  assert.equal(plan.users[0].create, true);
  assert.deepEqual(plan.users[0].characters.map(c => [c.actorId, c.create]), [["a1", true]]);
  assert.equal(upkeepIsIdle(plan), false);
});

test("a world whose folders all exist has nothing to do", () => {
  const plan = planFolderUpkeep(world(), [
    { userId: "u1", name: "Ana", characters: [{ actorId: "a1", name: "Thorin" }, { actorId: "a2", name: "Mira" }] },
    { userId: "u2", name: "Ben", characters: [{ actorId: "a3", name: "Pip" }] }
  ]);
  assert.equal(upkeepIsIdle(plan), true);
});

test("renamed players and characters rename their folders; new characters get one", () => {
  const plan = planFolderUpkeep(world(), [{ userId: "u1", name: "Ana B", characters: [{ actorId: "a1", name: "Thorin II" }, { actorId: "a9", name: "Wren" }] }]);
  assert.equal(plan.users[0].rename, true);
  const [thorin, wren] = plan.users[0].characters;
  assert.equal(thorin.rename, true);
  assert.equal(thorin.id, "fa1");
  assert.equal(wren.create, true);
});

test("players without characters get no folder, and no root is made for nobody", () => {
  const plan = planFolderUpkeep([], [{ userId: "u1", name: "Ana", characters: [] }]);
  assert.equal(plan.users.length, 0);
  assert.equal(plan.root.create, false);
});

test("a player folder outside the root does not count", () => {
  const folders = [folder("root", ROLES.ROOT), folder("stray", ROLES.USER, { userId: "u1" })];
  const plan = planFolderUpkeep(folders, [{ userId: "u1", name: "Ana", characters: [{ actorId: "a1", name: "Thorin" }] }]);
  assert.equal(plan.users[0].create, true);
});

// ---- Who may touch which folder (checked on the GM's client) ----

test("a player may use their own character and player folders", () => {
  assert.equal(ownedFolder(world(), "fa1", "u1").id, "fa1");
  assert.equal(ownedFolder(world(), "quests", "u1").id, "quests");
});

test("a player may not touch another player's folders", () => {
  code(() => ownedFolder(world(), "fa3", "u1"), "FORBIDDEN");
  code(() => ownedFolder(world(), "loot", "u1"), "FORBIDDEN");
});

test("the root, player folders and ordinary folders are off limits", () => {
  code(() => ownedFolder(world(), "root", "u1"), "FORBIDDEN");
  code(() => ownedFolder(world(), "fu1", "u1"), "FORBIDDEN");
  code(() => ownedFolder(world(), "gm", "u1"), "TARGET_MISSING");
  code(() => ownedFolder(world(), "missing", "u1"), "TARGET_MISSING");
});

test("a forged flag outside the player's own chain is refused", () => {
  const folders = [...world(), folder("forged", ROLES.CUSTOM, { parentId: "fa3", userId: "u1", actorId: "a3" })];
  code(() => ownedFolder(folders, "forged", "u1"), "FORBIDDEN");
  const loose = [...world(), folder("loose", ROLES.CHARACTER, { parentId: "gm", userId: "u1", actorId: "a1" })];
  code(() => ownedFolder(loose, "loose", "u1"), "FORBIDDEN");
});

test("role limits narrow what a request may target", () => {
  code(() => ownedFolder(world(), "fa1", "u1", [ROLES.CUSTOM]), "FORBIDDEN");
});

test("player folders only go directly inside a character folder", () => {
  assert.doesNotThrow(() => assertCanHoldFolder(world().find(f => f.id === "fa1")));
  code(() => assertCanHoldFolder(world().find(f => f.id === "quests")), "INVALID_INPUT");
});

test("the character folder above a player folder is found", () => {
  assert.equal(characterFolderOf(world(), world().find(f => f.id === "quests")).id, "fa1");
  assert.equal(characterFolderOf(world(), world().find(f => f.id === "fa2")).id, "fa2");
  assert.equal(characterFolderOf(world(), world().find(f => f.id === "fu1")), null);
});

// ---- Moves ----

test("a player folder can move to the player's other characters only", () => {
  const targets = folderMoveTargets(world(), world().find(f => f.id === "quests"), "u1");
  assert.deepEqual(targets.map(t => t.id), ["fa2"]);
});

test("a journal can move to any of the player's folders except where it is", () => {
  const targets = journalMoveTargets(world(), { id: "j1", folderId: "quests" }, "u1");
  assert.deepEqual(targets.map(t => t.id), ["fa1", "npcs", "fa2"]);
  assert.ok(!targets.some(t => t.userId !== "u1"));
});

// ---- Tree and order ----

test("a character's tree holds its folders and journals in manual order", () => {
  const journals = [
    { id: "j1", name: "B", folderId: "fa1", sort: 2 }, { id: "j2", name: "A", folderId: "fa1", sort: 1 },
    { id: "j3", name: "Clue", folderId: "quests", sort: 0 }, { id: "j4", name: "Other", folderId: "fa3", sort: 0 }
  ];
  const tree = buildCharacterTree(world(), journals, "fa1");
  assert.deepEqual(tree.folders.map(entry => entry.folder.id), ["npcs", "quests"]);
  assert.deepEqual(tree.journals.map(j => j.id), ["j2", "j1"]);
  assert.deepEqual(tree.folders[1].journals.map(j => j.id), ["j3"]);
  assert.equal(buildCharacterTree(world(), journals, "quests"), null, "only character folders have trees");
});

test("moving up swaps with the previous entry and renumbers", () => {
  const siblings = [{ id: "a", sort: 10 }, { id: "b", sort: 20 }, { id: "c", sort: 30 }];
  const updates = reorderUpdates(siblings, "c", -1);
  const order = [...siblings].map(entry => ({ ...entry, sort: updates.find(u => u.id === entry.id)?.sort ?? entry.sort })).sort((l, r) => l.sort - r.sort);
  assert.deepEqual(order.map(entry => entry.id), ["a", "c", "b"]);
});

test("ties still reorder, and edges do nothing", () => {
  const tied = [{ id: "a", name: "a", sort: 0 }, { id: "b", name: "b", sort: 0 }];
  const updates = reorderUpdates(tied, "b", -1);
  assert.ok(updates.find(u => u.id === "b").sort < updates.find(u => u.id === "a").sort);
  assert.deepEqual(reorderUpdates(tied, "a", -1), []);
  assert.deepEqual(reorderUpdates(tied, "b", 1), []);
  assert.deepEqual(reorderUpdates(tied, "zz", 1), []);
});

test("new entries sort after their siblings", () => {
  assert.ok(nextSort([{ sort: 5 }, { sort: 300000 }]) > 300000);
  assert.ok(nextSort([]) > 0);
});

// ---- Pictures ----

test("pictures shrink to fit 2048 px and never grow", () => {
  assert.deepEqual(fitImage(4096, 3072), { width: 2048, height: 1536 });
  assert.deepEqual(fitImage(1000, 3000), { width: 683, height: 2048 });
  assert.deepEqual(fitImage(800, 600), { width: 800, height: 600 });
});

test("uploads must be small WebP, JPEG or PNG data URLs", () => {
  assert.equal(checkImageUpload("data:image/webp;base64,AAAA").extension, "webp");
  assert.equal(checkImageUpload("data:image/jpeg;base64,AAAA").extension, "jpg");
  code(() => checkImageUpload("data:image/svg+xml;base64,AAAA"), "INVALID_INPUT");
  code(() => checkImageUpload("data:text/html;base64,AAAA"), "INVALID_INPUT");
  code(() => checkImageUpload("https://example.com/a.png"), "INVALID_INPUT");
  code(() => checkImageUpload(`data:image/png;base64,${"A".repeat(12 * 1024 * 1024)}`), "INVALID_INPUT");
});

test("picture file names are safe", () => {
  assert.equal(imageFileName("Map of the Keep!", "webp", "k9x"), "map-of-the-keep-k9x.webp");
  assert.equal(imageFileName("../../etc", "png", "1"), "etc-1.png");
  assert.equal(imageFileName("", "jpg", ""), "picture-0.jpg");
});

// ---- Writing screen HTML policy ----

test("scripts, frames and forms are dropped with their content", () => {
  for (const tag of ["script", "STYLE", "iframe", "object", "form", "svg"]) assert.equal(dropsElement(tag), true, tag);
  for (const tag of ["p", "h2", "strong", "ul", "blockquote", "img", "a", "table"]) assert.equal(dropsElement(tag), false, tag);
});

test("event handlers, inline styles and script links are dropped", () => {
  assert.equal(dropsAttribute("onerror", "x"), true);
  assert.equal(dropsAttribute("style", "color:red"), true);
  assert.equal(dropsAttribute("href", " javascript:alert(1)"), true);
  assert.equal(dropsAttribute("href", "java\tscript:alert(1)"), true);
  assert.equal(dropsAttribute("src", "data:text/html,x"), true);
  assert.equal(dropsAttribute("src", "data:image/png;base64,AA"), false);
  assert.equal(dropsAttribute("href", "https://example.com"), false);
  assert.equal(dropsAttribute("class", "secret"), false);
  assert.equal(dropsAttribute("data-uuid", "JournalEntry.x"), false);
});

test("pages with only empty paragraphs are blank", () => {
  assert.equal(isBlankHtml("<p><br></p>"), true);
  assert.equal(isBlankHtml("<div>&nbsp;</div>"), true);
  assert.equal(isBlankHtml("<p>Hi</p>"), false);
});

test("findFolder matches by role and owner", () => {
  assert.equal(findFolder(world(), { role: ROLES.ROOT }).id, "root");
  assert.equal(findFolder(world(), { role: ROLES.CHARACTER, userId: "u2", actorId: "a3" }).id, "fa3");
  assert.equal(findFolder(world(), { role: ROLES.CHARACTER, userId: "u1", actorId: "a3" }), null);
});
