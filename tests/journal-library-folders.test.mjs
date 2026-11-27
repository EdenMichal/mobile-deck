// The Journals Library list across snapshot rebuilds (features/journals/presenter.mjs). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// The smallest DOM the Library presenter touches: elements with attributes, children and listeners.
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.dataset = {}; this.className = ""; this.listeners = {}; this.textContent = ""; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  removeEventListener() {}
  querySelector() { return null; }
  get open() { return "open" in this.attributes; }
  set open(value) { if (value) this.attributes.open = ""; else delete this.attributes.open; }
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: tag => new FakeElement(tag), createTextNode: text => ({ text }) };

const { renderJournals } = await import("../src/features/journals/presenter.mjs");
const { journalPageTurned } = await import("../src/ui/app-frame.mjs");

const scope = { listen: (element, type, fn) => element.addEventListener(type, fn), own() {}, disposed: false };
const commands = { localize: (_key, fallback) => fallback, readLocale: () => "en", openJournal: () => Promise.resolve() };
const folder = (id, name) => ({ id, name, sort: 0, sorting: "a" });
const handouts = folder("top", "Handouts"), party = folder("party", "Party");
const record = (id, name, path) => ({ id, name, img: "", sort: 0, rootSorting: "a", folderPath: path, playerJournal: false, pages: [{ id: `${id}.p`, name: "Page", type: "text" }] });
const before = [record("j1", "Letter", [handouts, party, folder("ch2", "Chapter 2")]), record("j2", "Map", [handouts, folder("lore", "Lore")])];
// The GM adds a handout in a new folder that sorts first: every later folder moves down one place.
const after = [record("new", "Notice", [handouts, party, folder("ch1", "Chapter 1")]), ...before];

const folders = element => [
  ...(element.tagName === "DETAILS" ? [element] : []),
  ...(element.children ?? []).filter(child => child instanceof FakeElement).flatMap(folders)
];
const descendants = element => [element, ...(element.children ?? []).filter(child => child instanceof FakeElement).flatMap(descendants)];
const name = details => details.children[0].children.find(child => child.tagName === "STRONG").textContent;
const openNames = element => folders(element).filter(details => details.open).map(name);
const render = (journals, expandedJournalFolderIds) => renderJournals({ state: { snapshot: { journals }, journal: null }, commands, scope, expandedJournalFolderIds });

test("folders the player opened stay open, by folder id, when a snapshot rebuilds the list", () => {
  const expanded = new Set();
  const first = render(before, expanded);
  for (const details of folders(first).filter(details => ["Handouts", "Party", "Chapter 2"].includes(name(details)))) {
    details.open = true;
    details.listeners.toggle();
  }
  assert.deepEqual(openNames(render(after, expanded)), ["Handouts", "Party", "Chapter 2"], "the new Chapter 1 folder stays closed; Lore stays closed");
  const party = folders(render(after, expanded)).find(details => name(details) === "Party");
  assert.equal(party.children[0].getAttribute("aria-expanded"), "true");
});

test("closing a folder is remembered too, and a list without remembered folders starts closed", () => {
  const expanded = new Set(["top", "party"]);
  const list = render(before, expanded);
  const party = folders(list).find(details => name(details) === "Party");
  party.open = false;
  party.listeners.toggle();
  assert.deepEqual(openNames(render(after, expanded)), ["Handouts"]);
  assert.deepEqual(openNames(render(after, new Set())), []);
  assert.deepEqual(openNames(renderJournals({ state: { snapshot: { journals: after }, journal: null }, commands, scope })), [], "callers without a folder memory still work");
});

test("a new page or journal in the reader starts at the top; a refresh of the same page keeps its place", () => {
  const journal = { id: "j1", pages: [] };
  assert.equal(journalPageTurned({ journal: null }, { journal, journalPageId: "a" }), true, "opening a journal from the list");
  assert.equal(journalPageTurned({ journal, journalPageId: "a" }, { journal: { ...journal }, journalPageId: "b" }), true, "a swipe to the next page");
  assert.equal(journalPageTurned({ journal, journalPageId: "b" }, { journal: { id: "j2" }, journalPageId: "c" }), true, "a swipe into the next journal");
  assert.equal(journalPageTurned({ journal, journalPageId: "a" }, { journal: { ...journal }, journalPageId: "a" }), false, "a GM edit reloading the same page");
  assert.equal(journalPageTurned({ journal, journalPageId: "a" }, { journal, journalPageId: "b", journalHeading: "h" }), false, "a chosen heading scrolls itself");
  assert.equal(journalPageTurned({ journal, journalPageId: "a" }, { journal: null }), false, "back to the list");
});

test("when the next journal can't open, the reader that stays on screen says why", () => {
  const status = element => descendants(element).find(child => child.className === "ve-journal-status is-error");
  const reader = error => renderJournals({ state: { snapshot: { journals: before }, journal: { id: "j1", name: "Letter", pages: [] }, journalError: error }, commands, scope });
  const failed = status(reader("This journal is no longer available."));
  assert.equal(failed.getAttribute("hidden"), null);
  assert.equal(failed.textContent, "This journal is no longer available.");
  assert.equal(status(reader("")).getAttribute("hidden"), "");
});
