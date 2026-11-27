/** Pure rules for moving through journals with a horizontal swipe. No DOM or Foundry globals here:
 * the Library reader (features/journals/presenter.mjs) and My Journals (player-journals-layer.mjs)
 * feed plain records in and act on the target that comes back.
 *
 * Swipe left = next, swipe right = previous. Pages first; past the last page the next journal in
 * the same folder opens on its first page, before the first page the previous journal opens on its
 * last page. Never another folder, and nothing at either end of a folder. */

export const JOURNAL_SWIPE = Object.freeze({
  minDistance: 64,     // px the finger must travel sideways
  dominance: 2,        // sideways travel must be at least this many times the vertical travel
  maxDuration: 700,    // ms; a slower drag is reading or selecting, not a swipe
  verticalLock: 24,    // px of mostly vertical travel that hands the gesture to scrolling for good
  edgeGutter: 24       // px at each screen edge left to the system Back gesture
});

/** Foundry's directory order: alphabetical ("a") by name, otherwise manual sort then name. */
export function compareJournalEntries(left, right, sorting) {
  if (sorting === "a") return String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
  return Number(left?.sort ?? 0) - Number(right?.sort ?? 0)
    || String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
}

/** The journals the Library lists: a player's own notes show under My Journals instead, so the
 * Library leaves out journals inside their character folders. Notes whose character is gone stay. */
export function libraryJournals(journals, ownFolderIds = []) {
  const mine = new Set([...ownFolderIds].filter(Boolean).map(String));
  return (journals ?? []).filter((journal) => !journal?.playerJournal || !journal.folderPath?.some((folder) => mine.has(String(folder.id))));
}

/** The journals sharing a Library journal's folder, in the order the list shows them. Root-level
 * journals count as one folder. Empty when the journal isn't in the list. */
export function libraryFolderSiblings(journals, journalId) {
  const list = journals ?? [];
  const current = list.find((journal) => journal.id === journalId);
  if (!current) return [];
  const key = folderKey(current);
  const sorting = current.folderPath?.length ? current.folderPath.at(-1).sorting : list[0]?.rootSorting;
  return list.filter((journal) => folderKey(journal) === key).sort((left, right) => compareJournalEntries(left, right, sorting === "a" ? "a" : "m"));
}

function folderKey(journal) {
  return String(journal?.folderPath?.at?.(-1)?.id ?? "");
}

/** Where a swipe leads.
 * pageIds: the open journal's pages in reading order. siblings: [{ id, pageCount }] for its folder,
 * in list order and including the open journal. Journals with no pages are stepped over.
 * Returns { kind: "page", journalId, pageId }, { kind: "journal", journalId, edge: "first" | "last" }, or null. */
export function journalSwipeTarget({ journalId, pageIds = [], pageId = "", siblings = [], direction }) {
  const step = direction === "next" ? 1 : direction === "previous" ? -1 : 0;
  if (!step || !journalId) return null;
  const pages = [...pageIds].map(String);
  // The reader shows the first page when the selected one is unknown, so count from there.
  const shown = pages.length ? Math.max(0, pages.indexOf(String(pageId))) : -1;
  const nextPage = shown + step;
  if (shown >= 0 && nextPage >= 0 && nextPage < pages.length) return Object.freeze({ kind: "page", journalId, pageId: pages[nextPage] });
  const order = (siblings ?? []).map((journal) => journal.id);
  const at = order.indexOf(journalId);
  if (at < 0) return null;
  for (let position = at + step; position >= 0 && position < order.length; position += step) {
    if (Number(siblings[position].pageCount) > 0) {
      return Object.freeze({ kind: "journal", journalId: siblings[position].id, edge: step > 0 ? "first" : "last" });
    }
  }
  return null;
}

/** The Library reader's swipe target from app state (kernel/app-state.mjs): null while no journal is
 * open, while one is loading (so a quick second swipe can't act on the journal being left), or while
 * the page menu or image viewer is open. ownFolderIds: the player's character folders (My Journals). */
export function readerSwipeTarget(state, { direction, ownFolderIds = [] } = {}) {
  const journal = state?.journal;
  if (!journal?.id || state.journalLoading || state.journalMenuOpen || state.journalImage) return null;
  const journals = libraryJournals(state.snapshot?.journals ?? [], ownFolderIds);
  const siblings = libraryFolderSiblings(journals, journal.id).map((entry) => ({ id: entry.id, pageCount: entry.pages?.length ?? 0 }));
  return journalSwipeTarget({ journalId: journal.id, pageIds: (journal.pages ?? []).map((page) => page.id), pageId: state.journalPageId, siblings, direction });
}

/** True when the reader closed between two app states: Back, or a snapshot that no longer lists the
 * open journal. A journal load still in flight then belongs to a reader that is gone, so the kernel
 * drops it rather than let it pop the reader open over the list. Opening from the list (no reader
 * before) and loading a neighbour (the old journal stays until the new one lands) don't count. */
export function readerClosed(previous, current) {
  return Boolean(previous?.journal?.id) && !current?.journal;
}

/** Which way a finished touch went: "next" (swiped left), "previous" (swiped right) or null. */
export function journalSwipeDirection({ dx, dy, duration }, limits = JOURNAL_SWIPE) {
  const across = Math.abs(Number(dx) || 0);
  const down = Math.abs(Number(dy) || 0);
  if (!(across >= limits.minDistance) || across < down * limits.dominance) return null;
  if (!(Number(duration) >= 0) || Number(duration) > limits.maxDuration) return null;
  return dx < 0 ? "next" : "previous";
}

/** Follow one touch sequence and decide at its end whether it was a swipe. Feed it plain values:
 * start({ touches, time, width }), move({ touches }), end({ touches, changedTouches, time }).
 * A second finger, a gesture that starts at a screen edge, or one that turns into a vertical
 * scroll is dropped for good. end() returns the direction or null. */
export function createJournalSwipeTracker(limits = JOURNAL_SWIPE) {
  let start = null;
  const point = (touches, id) => [...(touches ?? [])].find((touch) => touch.identifier === id) ?? null;
  return Object.freeze({
    start({ touches = [], time = 0, width = Infinity } = {}) {
      const list = [...touches];
      const touch = list[0];
      start = null;
      if (list.length !== 1 || !touch) return;
      const x = Number(touch.clientX), y = Number(touch.clientY);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      if (x < limits.edgeGutter || x > Number(width) - limits.edgeGutter) return;
      start = { id: touch.identifier, x, y, time: Number(time) || 0 };
    },
    move({ touches = [] } = {}) {
      if (!start) return;
      const list = [...touches];
      if (list.length !== 1) { start = null; return; }
      const touch = point(list, start.id);
      if (!touch) { start = null; return; }
      const dx = Math.abs(touch.clientX - start.x), dy = Math.abs(touch.clientY - start.y);
      if (dy >= limits.verticalLock && dy > dx) start = null;
    },
    end({ touches = [], changedTouches = [], time = 0 } = {}) {
      const begun = start;
      start = null;
      if (!begun || [...touches].length) return null;
      const touch = point(changedTouches, begun.id);
      if (!touch) return null;
      return journalSwipeDirection({ dx: touch.clientX - begun.x, dy: touch.clientY - begun.y, duration: (Number(time) || 0) - begun.time }, limits);
    },
    cancel() { start = null; },
    get active() { return Boolean(start); }
  });
}
