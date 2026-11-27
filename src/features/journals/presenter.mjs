import { localizedText, localizedCount } from "../../ui/localized-text.mjs";
import { icon, node } from "../../ui/dom.mjs";
import { renderImageViewer } from "../../ui/image-viewer.mjs";
import { buildJournalTree, journalBranchCount } from "./model.mjs";
import { bindJournalFontSize } from "./font-size-controller.mjs";
import { ensurePlayerJournalStyles } from "./player-journal-styles.mjs";
import { bindJournalSwipe } from "./journal-swipe.mjs";
import { libraryJournals } from "../../kernel/journal-navigation.mjs";

// Render the journal library or the currently selected page from snapshot state.
// expandedJournalFolderIds: folders the player opened, kept by folder id so a snapshot rebuild leaves them open.
export function renderJournals({ state, commands, scope, expandedJournalFolderIds = new Set() }) {
  if (state.journal) return journalReader(state, commands, scope);
  // Use the feature localizer with plain fallback text for library labels.
  const localize = (key, fallback, data) => commands.localize?.(key, fallback, data) ?? fallback;
  const characters = readPlayerJournalCharacters(commands);
  // A player's own notes show under My Journals, so the Library leaves those out. Notes whose
  // character is gone (deleted, or no longer theirs) stay in the Library so they are never lost.
  const journals = libraryJournals(state.snapshot?.journals ?? [], characters.map((character) => character.folderId));
  const status = node("p", { className: `ve-journal-status${state.journalError ? " is-error" : ""}`, attrs: { role: "status", "aria-live": "polite" }, text: state.journalLoading ? localize("VEMOBILE.Journals.Opening", "Opening journal…") : localize(state.journalError, state.journalError) });
  return node("section", { className: "ve-list-screen ve-journal-library", attrs: { "aria-busy": String(Boolean(state.journalLoading)) }, children: [
    node("header", { children: [node("div", { children: [node("small", { text: localize("VEMOBILE.Journals.Library", "Library").toLocaleUpperCase() }), node("h2", { text: localize("VEMOBILE.Journals.Title", "Journals") })] }), node("span", { className: "ve-count", text: journals.length })] }),
    status,
    characters.length ? myJournals(characters, commands, scope, localize) : null,
    characters.length ? node("h3", { className: "ve-journal-library-heading", text: localize("VEMOBILE.Journals.Library", "Library") }) : null,
    journals.length ? node("div", { className: "ve-journal-tree", children: renderBranch(buildJournalTree(journals), commands, scope, expandedJournalFolderIds) }) : node("div", { className: "ve-empty", children: [icon("fa-book-open"), node("p", { text: localize("VEMOBILE.Journals.None", "No visible journals.") })] })
  ].filter(Boolean) });
}

// The player's characters, or none for GMs and when player journals are unavailable.
function readPlayerJournalCharacters(commands) {
  try { return commands.playerJournalCharacters?.() ?? []; }
  catch { return []; }
}

// One row per character: opens that character's private notes.
function myJournals(characters, commands, scope, localize) {
  ensurePlayerJournalStyles();
  const status = node("p", { className: "ve-journal-status is-error", attrs: { role: "status", "aria-live": "polite", hidden: true } });
  const open = (actorId) => {
    status.hidden = true;
    try { commands.openPlayerJournals(actorId); }
    catch (error) { status.textContent = error?.message ?? String(error); status.hidden = false; }
  };
  return node("section", { className: "ve-journal-mine", attrs: { "aria-label": localize("VEMOBILE.PlayerJournals.Title", "My Journals") }, children: [
    node("h3", { text: localize("VEMOBILE.PlayerJournals.Title", "My Journals") }),
    status,
    ...characters.map((character) => node("button", { className: "ve-journal-entry ve-journal-mine-entry", attrs: { type: "button", "data-actor-id": character.actorId }, on: { click: () => open(character.actorId) }, children: [
      character.img ? node("img", { attrs: { src: character.img, alt: "" } }) : node("span", { className: "ve-journal-entry-icon", children: [icon("fa-feather")] }),
      node("span", { children: [node("strong", { text: character.name }), node("small", { text: localize("VEMOBILE.PlayerJournals.CharacterNotes", "Your private notes") })] }),
      icon("fa-chevron-right")
    ] }, scope))
  ] });
}

// Render one folder level while keeping journal and folder order from the model.
function renderBranch(branch, commands, scope, expanded) {
  return [...Array.from(branch.folders.values()).map((child) => folderNode(child, commands, scope, expanded)), ...branch.journals.map((journal) => journalButton(journal, commands, scope))];
}

// Build a disclosure row for a folder, reopened by its id after a rebuild, and reflect native open state accessibly.
function folderNode(branch, commands, scope, expanded) {
  const folderId = String(branch.folder.id ?? "");
  const open = expanded.has(folderId);
  const details = node("details", { className: "ve-journal-folder", attrs: { open }, children: [
    node("summary", { attrs: { "aria-expanded": String(open) }, children: [icon("fa-chevron-right"), icon("fa-folder"), node("strong", { text: branch.folder.name }), node("small", { text: journalBranchCount(branch) })] }),
    node("div", { className: "ve-journal-folder-contents", children: renderBranch(branch, commands, scope, expanded) })
  ] });
  scope.listen(details, "toggle", () => {
    if (details.open) expanded.add(folderId);
    else expanded.delete(folderId);
    details.querySelector(":scope > summary")?.setAttribute("aria-expanded", String(details.open));
  });
  return details;
}

// Open a journal by stable ID and show its available page count.
function journalButton(journal, commands, scope) {

  return node("button", { className: "ve-journal-entry", attrs: { type: "button" }, on: { click: () => void commands.openJournal(journal.id).catch(() => {}) }, children: [
    journal.img ? node("img", { attrs: { src: journal.img, alt: "" } }) : node("span", { className: "ve-journal-entry-icon", children: [icon("fa-book")] }),
    node("span", { children: [node("strong", { text: journal.name }), node("small", { text: localizedCount(commands.localize, "VEMOBILE.Journals.PageCount", { one: "{count} page", other: "{count} pages" }, journal.pages.length, commands.readLocale?.() ?? "en") })] }),
    icon("fa-chevron-right")
  ] }, scope);
}

// Render page navigation, native editing when permitted, and image viewing.
function journalReader(state, commands, scope) {
  // Use the feature localizer for page navigation and editor guidance.
  const localize = (key, fallback, data) => commands.localize?.(key, fallback, data) ?? fallback;
  const journal = state.journal;
  const pages = journal.pages ?? [];
  const selectedIndex = Math.max(0, pages.findIndex((page) => page.id === state.journalPageId));
  const page = pages[selectedIndex] ?? null;
  // Also says why a journal failed to open from here (a swipe into the next one), which keeps the current journal on screen.
  const editStatus = node("p", { className: "ve-journal-status is-error", attrs: { role: "status", "aria-live": "polite", hidden: !state.journalError },
    text: state.journalError ? localize(state.journalError, state.journalError) : undefined });
  // Ask Foundry to open its editor; the gateway rechecks edit authority.
  const editCurrentPage = async () => {
    editStatus.hidden = true;
    try { await commands.openNativeJournalEditor(journal.id, page?.id ?? ""); }
    catch (error) {
      editStatus.textContent = error?.message ?? localizedText(commands.localize, "VEMOBILE.Interface.Presenter.TheNativeJournalEditorCouldNotBeOpened", "The native Journal editor could not be opened.");
      editStatus.hidden = false;
    }
  };
  const reader = node("section", { className: "ve-journal-reader", children: [
    node("header", { children: [
      node("button", { attrs: { type: "button", "aria-label": localize("VEMOBILE.Journals.Back", "Back to journals") }, on: { click: commands.closeJournal }, children: [icon("fa-arrow-left")] }, scope),
      node("div", { children: [node("small", { text: localize("VEMOBILE.Journals.Journal", "Journal").toLocaleUpperCase() }), node("h2", { text: journal.name })] }),
      journal.canEdit && (!page || page.canEdit) ? node("button", { className: "ve-journal-native-edit", attrs: { type: "button" }, on: { click: () => void editCurrentPage() }, text: localizedText(commands.localize, "VEMOBILE.Journals.Edit", "Edit") }, scope) : null
    ].filter(Boolean) }),
    editStatus,
    pages.length ? node("nav", { className: "ve-journal-page-nav", attrs: { "aria-label": localizedText(commands.localize, "VEMOBILE.Journals.PagesAndHeadings", "Journal pages and headings") }, children: [
      node("button", { className: "ve-journal-page-selector", attrs: { type: "button", "aria-expanded": String(Boolean(state.journalMenuOpen)), "aria-label": localizedText(commands.localize, "VEMOBILE.Journals.ChoosePageOrHeading", "Choose Journal page or heading") }, on: { click: commands.toggleJournalMenu }, children: [node("span", { text: page?.name ?? localizedText(commands.localize, "VEMOBILE.Journals.ChoosePage", "Choose page") }), icon("fa-chevron-down")] }, scope),
      state.journalMenuOpen ? node("div", { className: "ve-journal-page-menu", attrs: { "data-ve-back-dismissable": "true", "data-ve-back-kind": "journal-page-menu" }, children: pages.flatMap((entry) => [
        node("button", { className: `ve-journal-page-choice${entry.id === page?.id ? " is-selected" : ""}`, attrs: { type: "button", "aria-current": entry.id === page?.id ? "page" : null, "data-level": String(entry.level ?? 1) }, on: { click: () => commands.selectJournalPage(entry.id) }, children: [node("span", { text: entry.name }), entry.id === page?.id ? icon("fa-check") : null].filter(Boolean) }, scope),
        ...(entry.toc ?? []).map((heading) => node("button", { className: `ve-journal-heading-choice${entry.id === page?.id && heading.slug === state.journalHeading ? " is-selected" : ""}`, attrs: { type: "button", "data-level": String(heading.level) }, on: { click: () => commands.selectJournalHeading(entry.id, heading.slug) }, text: heading.text }, scope))
      ]) }) : null
    ].filter(Boolean) }) : null,
    page ? journalPage(page, state.journalHeading, commands, scope) : node("div", { className: "ve-journal-reader-empty", children: [icon("fa-file-circle-xmark"), node("p", { text: localize("VEMOBILE.Journals.Empty", "This journal has no visible pages.") })] }),
    state.journalImage ? renderImageViewer(state.journalImage, commands.closeJournalImage, scope, { localize: commands.localize }) : null
  ].filter(Boolean) });
  // Swipe left or right for the next or previous page, then on into the neighbouring journal of the
  // same folder. The open image viewer and page menu keep their own touches. Bound once the reader is
  // mounted, on the pane's scroller (main or Side by Side companion) so the margins beside a
  // width-capped reader on a tablet swipe too; the screen scope removes the listeners with the reader.
  if (commands.swipeJournal && !state.journalImage && !state.journalMenuOpen) queueMicrotask(() => {
    if (scope.disposed || reader.isConnected === false) return;
    bindJournalSwipe(reader.closest?.(".ve-viewport, .ve-companion-viewport") ?? reader, { scope, content: reader,
      onSwipe: (direction) => commands.swipeJournal(direction),
      blocked: (target) => Boolean(target?.closest?.(".ve-journal-page-menu, .ve-image-viewer, input, textarea, select, [contenteditable='true']")) });
  });
  return reader;
}

// Present rich text, image pages, or a link for other readable attachments.
function journalPage(page, selectedHeading, commands, scope) {
  if (page.type === "text") {
    const content = node("article", { className: "ve-journal-rich-text" });
    content.innerHTML = String(page.html ?? "");
    bindJournalFontSize(content, commands, scope);
    if (selectedHeading) queueMicrotask(() => {
      if (scope.disposed || !content.isConnected) return;
      const headings = [...content.querySelectorAll("h1, h2, h3, h4, h5, h6")].filter((heading) => !heading.hasAttribute("data-no-toc"));
      const tableOfContents = page.toc ?? [];
      const index = tableOfContents.findIndex((heading) => heading.slug === selectedHeading);
      const target = [...content.querySelectorAll("[id]")].find((element) => element.id === selectedHeading) ?? headings[index];
      const scroller = content.closest(".ve-viewport, .ve-companion-viewport");
      if (!target || !scroller) return;
      scroller.scrollTop += target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 12;
    });
    scope.listen(content, "click", (event) => {
      const image = event.target?.closest?.("img");
      if (!image?.src) return;
      event.preventDefault();
      commands.openJournalImage({ src: image.currentSrc || image.src, name: image.alt || page.name });
    });
    return node("div", { className: "ve-journal-page", children: [node("h3", { text: page.name }), content] });
  }
  if (page.type === "image" && page.src) return node("div", { className: "ve-journal-page ve-journal-image-page", children: [node("h3", { text: page.name }), node("button", { attrs: { type: "button", "aria-label": commands.localize?.("VEMOBILE.Journals.Enlarge", `Enlarge ${page.name}`, { name: page.name }) ?? `Enlarge ${page.name}` }, on: { click: () => commands.openJournalImage({ src: page.src, name: page.name }) }, children: [node("img", { attrs: { src: page.src, alt: page.caption || page.name } })] }, scope), page.caption ? node("p", { text: page.caption }) : null].filter(Boolean) });
  return node("div", { className: "ve-journal-page ve-journal-attachment", children: [node("h3", { text: page.name }), page.src ? node("a", { attrs: { href: page.src, target: "_blank", rel: "noopener noreferrer" }, children: [icon(page.type === "video" ? "fa-circle-play" : "fa-file-arrow-up"), node("span", { text: localizedText(commands.localize, "VEMOBILE.Journals.OpenAttachment", "Open attachment") })] }) : node("p", { text: localizedText(commands.localize, "VEMOBILE.Interface.Presenter.ThisPageTypeHasNoReadableSource", "This page type has no readable source.") })] });
}
