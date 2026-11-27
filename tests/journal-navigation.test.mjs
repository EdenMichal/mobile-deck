// Unit tests for swiping through journals (journal-navigation.mjs). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  JOURNAL_SWIPE, compareJournalEntries, libraryJournals, libraryFolderSiblings, journalSwipeTarget, readerSwipeTarget,
  journalSwipeDirection, createJournalSwipeTracker, readerClosed
} from "../src/kernel/journal-navigation.mjs";
import { scrollsSideways } from "../src/features/journals/journal-swipe.mjs";
import { buildJournalTree } from "../src/features/journals/model.mjs";
import { initialAppState, reduceAppState } from "../src/kernel/app-state.mjs";

// A Library like the snapshot's journal records: Handouts › Party › Chapter, all alphabetical, plus root-level journals.
const top = { id: "top", name: "Handouts", sort: 0, sorting: "a" };
const party = { id: "party", name: "Party", sort: 0, sorting: "a" };
const one = { id: "ch1", name: "Chapter 1", sort: 0, sorting: "a" };
const two = { id: "ch2", name: "Chapter 2", sort: 0, sorting: "a" };
const pages = (...ids) => ids.map(id => ({ id, name: id, type: "text" }));
const record = (id, name, folderPath, pageIds = ["p"], extra = {}) => ({ id, name, img: "", sort: 0, rootSorting: "m", folderPath, playerJournal: false, pages: pages(...pageIds.map(page => `${id}.${page}`)), ...extra });
const library = () => [
  record("map", "Map of the Coast", [top, party, one]),
  record("letter", "A Letter", [top, party, one], ["a", "b"]),
  record("empty", "Blank Note", [top, party, one], []),
  record("diary", "Diary", [top, party, one]),
  record("ledger", "Ledger", [top, party, two]),
  record("rules", "House Rules", [], ["p"], { sort: 20 }),
  record("intro", "Welcome", [], ["p"], { sort: 10 })
];
const siblingIds = (journals, id) => libraryFolderSiblings(journals, id).map(journal => journal.id);

// ---- Same folder, same order as the list ----

test("a journal's folder siblings come in the list's own order, never from another folder", () => {
  assert.deepEqual(siblingIds(library(), "diary"), ["letter", "empty", "diary", "map"], "alphabetical, like the Chapter 1 folder");
  assert.deepEqual(siblingIds(library(), "ledger"), ["ledger"], "Chapter 2 holds only its own journal");
  assert.deepEqual(siblingIds(library(), "rules"), ["intro", "rules"], "root-level journals are one folder in manual order");
  assert.deepEqual(siblingIds(library(), "missing"), []);
  // Exactly the order the Library tree shows.
  const tree = buildJournalTree(library());
  const chapter = tree.folders.get("top").folders.get("party").folders.get("ch1");
  assert.deepEqual(chapter.journals.map(journal => journal.id), siblingIds(library(), "map"));
  assert.deepEqual(tree.journals.map(journal => journal.id), siblingIds(library(), "intro"));
});

test("only journals the Library lists count: the player's own notes live under My Journals", () => {
  const own = { id: "own", name: "Character", sort: 0, sorting: "m" };
  const journals = [...library(), record("notes", "Notes", [own], ["p"], { playerJournal: true })];
  assert.equal(libraryJournals(journals, ["own"]).some(journal => journal.id === "notes"), false);
  assert.equal(libraryJournals(journals, []).some(journal => journal.id === "notes"), true, "notes whose character is gone stay listed");
  assert.equal(libraryJournals(journals, ["own"]).length, library().length);
});

test("manual sorting goes by sort, then name; alphabetical by name only", () => {
  assert.ok(compareJournalEntries({ name: "B", sort: 1 }, { name: "A", sort: 2 }, "m") < 0);
  assert.ok(compareJournalEntries({ name: "B", sort: 1 }, { name: "A", sort: 2 }, "a") > 0);
  assert.ok(compareJournalEntries({ name: "A", sort: 1 }, { name: "B", sort: 1 }, "m") < 0);
});

// ---- Where a swipe leads ----

const folder = [{ id: "j1", pageCount: 2 }, { id: "j2", pageCount: 0 }, { id: "j3", pageCount: 3 }];

test("a swipe turns pages inside the open journal first", () => {
  assert.deepEqual(journalSwipeTarget({ journalId: "j1", pageIds: ["a", "b"], pageId: "a", siblings: folder, direction: "next" }), { kind: "page", journalId: "j1", pageId: "b" });
  assert.deepEqual(journalSwipeTarget({ journalId: "j3", pageIds: ["a", "b", "c"], pageId: "b", siblings: folder, direction: "previous" }), { kind: "page", journalId: "j3", pageId: "a" });
  assert.deepEqual(journalSwipeTarget({ journalId: "j1", pageIds: ["a", "b"], pageId: "gone", siblings: folder, direction: "next" }), { kind: "page", journalId: "j1", pageId: "b" }, "an unknown page reads as the first, as the reader shows it");
});

test("past the last page the next journal opens on its first page, before the first the previous one on its last", () => {
  assert.deepEqual(journalSwipeTarget({ journalId: "j1", pageIds: ["a", "b"], pageId: "b", siblings: folder, direction: "next" }), { kind: "journal", journalId: "j3", edge: "first" }, "the empty journal is stepped over");
  assert.deepEqual(journalSwipeTarget({ journalId: "j3", pageIds: ["a", "b", "c"], pageId: "a", siblings: folder, direction: "previous" }), { kind: "journal", journalId: "j1", edge: "last" });
});

test("nothing happens at either end of a folder or for a journal the list doesn't show", () => {
  assert.equal(journalSwipeTarget({ journalId: "j3", pageIds: ["a", "b", "c"], pageId: "c", siblings: folder, direction: "next" }), null);
  assert.equal(journalSwipeTarget({ journalId: "j1", pageIds: ["a", "b"], pageId: "a", siblings: folder, direction: "previous" }), null);
  assert.equal(journalSwipeTarget({ journalId: "linked", pageIds: ["a"], pageId: "a", siblings: folder, direction: "next" }), null);
  assert.equal(journalSwipeTarget({ journalId: "j1", pageIds: ["a", "b"], pageId: "a", siblings: folder, direction: "up" }), null);
});

test("an open journal with no visible pages still moves on to its neighbours", () => {
  assert.deepEqual(journalSwipeTarget({ journalId: "j2", pageIds: [], pageId: "", siblings: folder, direction: "next" }), { kind: "journal", journalId: "j3", edge: "first" });
  assert.deepEqual(journalSwipeTarget({ journalId: "j2", pageIds: [], pageId: "", siblings: folder, direction: "previous" }), { kind: "journal", journalId: "j1", edge: "last" });
});

// ---- The Library reader, through app state ----

const reduce = (state, ...events) => events.reduce((current, event) => reduceAppState(current, event), state);
const reader = (journalId, pageIds) => ({ id: journalId, name: journalId, pages: pageIds.map(id => ({ id, name: id, type: "text", sort: 0 })) });
const opened = (journalId, pageIds, target = {}) => reduce({ ...initialAppState, status: "ready", snapshot: { journals: library() } },
  { type: "journal-loaded", journal: reader(journalId, pageIds), target });

test("the reader swipes through the Library folder the player sees", () => {
  const state = opened("letter", ["letter.a", "letter.b"]);
  assert.deepEqual(readerSwipeTarget(state, { direction: "next" }), { kind: "page", journalId: "letter", pageId: "letter.b" });
  const last = reduce(state, { type: "select-journal-page", pageId: "letter.b" });
  assert.deepEqual(readerSwipeTarget(last, { direction: "next" }), { kind: "journal", journalId: "diary", edge: "first" }, "Blank Note has no pages to land on");
  assert.deepEqual(readerSwipeTarget(state, { direction: "previous" }), null, "A Letter is first in Chapter 1");
  assert.equal(readerSwipeTarget(opened("map", ["map.p"]), { direction: "next" }), null, "Chapter 2 is another folder");
});

test("a quick second swipe while the next journal loads does nothing, and the menu and image viewer keep their touches", () => {
  const state = reduce(opened("letter", ["letter.a", "letter.b"]), { type: "select-journal-page", pageId: "letter.b" });
  const loading = reduce(state, { type: "journal-loading" });
  assert.equal(loading.journal.id, "letter", "the old journal stays on screen while the next one loads");
  assert.equal(readerSwipeTarget(loading, { direction: "next" }), null);
  assert.equal(readerSwipeTarget(reduce(state, { type: "toggle-journal-menu" }), { direction: "next" }), null);
  assert.equal(readerSwipeTarget(reduce(state, { type: "open-journal-image", image: { src: "x.webp" } }), { direction: "next" }), null);
  assert.equal(readerSwipeTarget({ ...initialAppState }, { direction: "next" }), null, "no journal open");
});

test("the previous journal opens on its last page through journal-loaded's target", () => {
  const state = reduce(opened("diary", ["diary.p"]), { type: "journal-loading" },
    { type: "journal-loaded", journal: reader("letter", ["letter.a", "letter.b"]), target: { pageIndex: -1 } });
  assert.equal(state.journalPageId, "letter.b");
  assert.equal(opened("letter", ["letter.a", "letter.b"], { pageIndex: 0 }).journalPageId, "letter.a");
  assert.equal(opened("letter", ["letter.a", "letter.b"], { pageIndex: 1 }).journalPageId, "letter.b", "Foundry's own page indexes still work");
  assert.equal(opened("letter", [], { pageIndex: -1 }).journalPageId, "", "an empty journal shows its empty state");
});

test("a snapshot that drops the open journal mid-swipe closes the reader, so the swipe's load must be dropped", () => {
  const reading = reduce(opened("letter", ["letter.a", "letter.b"]), { type: "select-journal-page", pageId: "letter.b" });
  const swiping = reduce(reading, { type: "journal-loading" });
  assert.equal(readerClosed(reading, swiping), false, "the old journal stays while the next one loads");
  const dropped = reduce(swiping, { type: "session-loaded", snapshot: { journals: library().filter(journal => journal.id !== "letter") } });
  assert.equal(dropped.journal, null);
  assert.equal(dropped.journalLoading, false, "back on the list, so a late journal-loaded would pop the reader open");
  assert.equal(readerClosed(swiping, dropped), true);
  assert.equal(readerClosed(reading, reduce(reading, { type: "close-journal" })), true, "Back too");
  const list = { ...initialAppState, status: "ready", snapshot: { journals: library() } };
  const tapped = reduce(list, { type: "journal-loading" });
  assert.equal(readerClosed(list, tapped), false, "opening from the list never counts");
  assert.equal(readerClosed(tapped, reduce(tapped, { type: "session-loaded", snapshot: { journals: library() } })), false);
});

// ---- Whether a touch was a swipe ----

test("a swipe is clearly sideways, long enough and quick", () => {
  assert.equal(journalSwipeDirection({ dx: -120, dy: 10, duration: 200 }), "next", "swipe left");
  assert.equal(journalSwipeDirection({ dx: 120, dy: -10, duration: 200 }), "previous", "swipe right");
  assert.equal(journalSwipeDirection({ dx: -(JOURNAL_SWIPE.minDistance - 1), dy: 0, duration: 100 }), null, "too short");
  assert.equal(journalSwipeDirection({ dx: -120, dy: 70, duration: 200 }), null, "too diagonal");
  assert.equal(journalSwipeDirection({ dx: -120, dy: 0, duration: JOURNAL_SWIPE.maxDuration + 1 }), null, "a slow drag");
});

const touch = (clientX, clientY, identifier = 1) => ({ identifier, clientX, clientY });
const run = (steps, width = 400) => {
  const tracker = createJournalSwipeTracker();
  let result = null;
  for (const [type, value] of steps) {
    if (type === "start") tracker.start({ touches: value.touches, time: value.time ?? 0, width });
    if (type === "move") tracker.move({ touches: value.touches });
    if (type === "end") result = tracker.end({ touches: value.touches ?? [], changedTouches: value.changed, time: value.time ?? 200 });
  }
  return result;
};

test("the tracker reports a one-finger swipe", () => {
  assert.equal(run([["start", { touches: [touch(300, 200)] }], ["move", { touches: [touch(250, 204)] }], ["end", { changed: [touch(180, 206)] }]]), "next");
  assert.equal(run([["start", { touches: [touch(100, 200)] }], ["end", { changed: [touch(220, 196)] }]]), "previous");
});

test("pinches, vertical scrolls, screen-edge gestures and slow drags are not swipes", () => {
  assert.equal(run([["start", { touches: [touch(300, 200)] }], ["move", { touches: [touch(290, 200), touch(100, 300, 2)] }], ["end", { changed: [touch(180, 200)] }]]), null, "a second finger cancels");
  assert.equal(run([["start", { touches: [touch(300, 200)] }], ["end", { touches: [touch(100, 300, 2)], changed: [touch(180, 200)] }]]), null, "a finger still down");
  assert.equal(run([["start", { touches: [touch(300, 200)] }], ["move", { touches: [touch(298, 240)] }], ["move", { touches: [touch(180, 242)] }], ["end", { changed: [touch(180, 242)] }]]), null, "once the page scrolls vertically it stays a scroll");
  assert.equal(run([["start", { touches: [touch(5, 200)] }], ["end", { changed: [touch(200, 200)] }]]), null, "the left edge belongs to the system Back gesture");
  assert.equal(run([["start", { touches: [touch(395, 200)] }], ["end", { changed: [touch(200, 200)] }]]), null, "and the right edge");
  assert.equal(run([["start", { touches: [touch(300, 200)], time: 0 }], ["end", { changed: [touch(150, 200)], time: 1500 }]]), null, "a slow drag");
  assert.equal(run([["start", { touches: [touch(300, 200), touch(320, 260, 2)] }], ["end", { changed: [touch(150, 200)] }]]), null, "a two-finger start");
  assert.equal(run([["end", { changed: [touch(150, 200)] }]]), null, "an end without a start");
});

// Element stand-ins: a parent chain with sizes and an overflow-x style.
const box = (parentElement, { scrollWidth = 100, clientWidth = 100, overflowX = "visible" } = {}) => ({ nodeType: 1, parentElement, scrollWidth, clientWidth, overflowX });
const style = element => ({ overflowX: element.overflowX });

test("a touch on a table that scrolls sideways is the table's; the page and its pane scroller never count", () => {
  const pane = box(null, { scrollWidth: 420, clientWidth: 400, overflowX: "auto" });
  const page = box(pane);
  const wrapper = box(page, { scrollWidth: 900, clientWidth: 360, overflowX: "auto" });
  const cell = box(wrapper);
  const paragraph = box(page);
  assert.equal(scrollsSideways(cell, [page, pane], style), true);
  assert.equal(scrollsSideways({ nodeType: 3, parentElement: cell }, [page, pane], style), true, "a text node starts at its element");
  assert.equal(scrollsSideways(paragraph, [page, pane], style), false, "a pane that overflows by a few pixels doesn't swallow every swipe");
  assert.equal(scrollsSideways(pane, [page, pane], style), false, "a touch in the margin beside the reader");
  const clipped = box(page, { scrollWidth: 900, clientWidth: 360, overflowX: "hidden" });
  assert.equal(scrollsSideways(box(clipped), [page, pane], style), false, "content that can't scroll sideways");
});
