// The mobile Journal reader redirect (mobile-journal-reader-gateway.mjs). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { enableMobileJournalReader, opensSheet } from "../src/foundry/mobile-journal-reader-gateway.mjs";

// Foundry's two application bases: neither renders a closed sheet unless the render is forced.
class ApplicationV2 { render(options = {}, _options = {}) { this.calls.push(["v2", options]); return Promise.resolve(this); } }
class Application { render(force = false, options = {}) { this.calls.push(["v1", force, options]); return this; } }

const player = { id: "player" };
const observe = level => ({ testUserPermission: (_user, wanted) => level === "OWNER" || wanted !== "OWNER" });
const journal = (id, level = "OBSERVER") => {
  const entry = { documentName: "JournalEntry", id, pack: null, ...observe(level) };
  const page = { documentName: "JournalEntryPage", id: `${id}-p`, parent: entry, type: "text", sort: 0, toc: {}, ...observe(level) };
  entry.pages = new Map([[page.id, page]]);
  return { entry, page };
};

function setup() {
  const handout = journal("handout");
  const game = { user: player, journal: new Map([["handout", handout.entry]]) };
  const opened = [];
  const owned = [];
  const scope = { own: fn => owned.push(fn) };
  enableMobileJournalReader(scope, {
    openJournal: (id, target) => { opened.push([id, target.pageId]); return Promise.resolve({ id }); },
    isActive: () => true,
    getGame: () => game,
    getFoundry: () => ({ applications: { api: { ApplicationV2 } }, appv1: { api: { Application } } })
  });
  const sheet = (Base, document) => Object.assign(Object.create(Base.prototype), { document, calls: [] });
  return { handout, opened, sheet, dispose: () => owned.forEach(fn => fn()) };
}

test("opening a journal sheet shows it in the mobile reader instead", async () => {
  const { handout, opened, sheet, dispose } = setup();
  try {
    const v2 = sheet(ApplicationV2, handout.entry);
    await v2.render({ force: true });
    await v2.render(true, { pageId: handout.page.id });
    sheet(Application, handout.entry).render(true);
    assert.deepEqual(opened, [["handout", ""], ["handout", "handout-p"], ["handout", ""]]);
    assert.deepEqual(v2.calls, [], "the native sheet stays closed");
  } finally { dispose(); }
});

test("a refresh render of a journal the player never opened stays a no-op and never pulls the phone into that journal", async () => {
  const { handout, opened, sheet, dispose } = setup();
  try {
    // Foundry asks for these to refresh a sheet only if it is already open, for example
    // parent.sheet.render(false) after a page's type changes, or document.render(false) on updates.
    const v2 = sheet(ApplicationV2, handout.entry);
    await v2.render(false);
    await v2.render({});
    await v2.render({ parts: ["sidebar"] });
    const v1 = sheet(Application, handout.page);
    v1.render(false);
    v1.render();
    assert.deepEqual(opened, [], "no refresh opens the reader");
    assert.equal(v2.calls.length + v1.calls.length, 5, "each one reaches Foundry's own render, which skips a closed sheet");
  } finally { dispose(); }
});

test("only a forced render counts as opening a sheet", () => {
  assert.equal(opensSheet([true]), true);
  assert.equal(opensSheet([{ force: true }]), true);
  assert.equal(opensSheet([true, { pageId: "p" }]), true);
  assert.equal(opensSheet([false]), false);
  assert.equal(opensSheet([{}]), false);
  assert.equal(opensSheet([{ force: false }]), false);
  assert.equal(opensSheet([]), false);
  assert.equal(opensSheet([undefined, { force: true }]), false, "a second-argument force is not Foundry's signature");
});

test("disposing restores Foundry's own render", () => {
  const original2 = ApplicationV2.prototype.render;
  const original1 = Application.prototype.render;
  const { dispose } = setup();
  assert.notEqual(ApplicationV2.prototype.render, original2);
  dispose();
  assert.equal(ApplicationV2.prototype.render, original2);
  assert.equal(Application.prototype.render, original1);
});
