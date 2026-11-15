/**
 * My Journals: a full-screen layer where a player keeps notes for one of their characters.
 * Built on the Character Builder's shell (builder-shell.mjs), so it owns its DOM and listeners and
 * Mobile Deck's Back reaches it through data-ve-back-dismissable + "ve-close"; no app-state changes.
 *
 * Screens: home (the character's folders and journals) → folder → journal (its pages) → writer
 * (a text page) or picture (an image page). Every row has a ⋯ menu: rename, move, reorder, delete.
 * The gateway (foundry/player-journal-gateway.mjs) does the work and re-checks every permission.
 */
import { icon, node } from "../../ui/dom.mjs";
import { createShell, createScope } from "../builder/builder-shell.mjs";
import { emptyCard, rowArt, rowCopy, sheetCard } from "../builder/ve-parts.mjs";
import { ROLES, fitImage, MAX_IMAGE_BYTES } from "../../kernel/player-journal-rules.mjs";
import { mountPageWriter } from "./page-writer.mjs";
import { ensurePlayerJournalStyles } from "./player-journal-styles.mjs";

const REFRESH_DELAY_MS = 120;

/** One layer at a time; opening another character's journals replaces it. */
export function createPlayerJournalsOpener({ gateway, t, host = () => document.querySelector(".ve-mobile-app") ?? document.body, readFontSize = () => 16 }) {
  let current = null;
  return Object.freeze({
    open(actorId) {
      current?.close();
      const character = gateway.characters().find(entry => entry.actorId === String(actorId ?? ""));
      if (!character) throw new Error(t("Errors.NotCharacterOwner", "You don't own that character."));
      const layer = mountPlayerJournals(host(), { gateway, t, character, readFontSize, onClose: () => { if (current === layer) current = null; } });
      current = layer;
      return true;
    },
    close() { current?.close(); current = null; }
  });
}

function mountPlayerJournals(host, { gateway, t, character, readFontSize, onClose }) {
  ensurePlayerJournalStyles();
  let unsubscribe = () => {};
  const shell = createShell(host, { t, subtitle: character.name, controller: {}, headIcon: "fa-book-open", sheetAccent: false,
    onClose: () => { unsubscribe(); onClose(); } });
  shell.layer.classList.add("ve-pj-layer");
  const { frame, work, setBody, showError } = shell;

  let folderId = character.folderId;          // the character folder
  let view = { screen: "home" };              // { screen, folderId?, journalId?, pageId? }
  let sheet = null;                           // the open action sheet, if any
  let refreshTimer = null;
  let refreshWanted = false;
  let screenHandle = null;                    // writer/picture: { onHook, flush }

  // ---- Navigation ----
  function go(next) {
    screenHandle?.flush?.();
    screenHandle = null;
    closeSheet();
    view = next;
    render();
  }
  function render() {
    refreshWanted = false;
    if (!folderId) return showSetup();
    const tree = gateway.tree(folderId);
    if (!tree) { folderId = ""; return showSetup(); }
    if (view.screen === "folder") {
      const entry = tree.folders.find(item => item.folder.id === view.folderId);
      return entry ? showFolder(tree, entry) : go({ screen: "home" });
    }
    if (view.screen === "journal") {
      const journal = gateway.journal(view.journalId);
      return journal ? showJournal(journal) : go(parentOfJournal(view));
    }
    if (view.screen === "writer" || view.screen === "picture") {
      const journal = gateway.journal(view.journalId);
      const page = journal?.pages.find(entry => entry.id === view.pageId);
      if (!page) return go(journal ? { screen: "journal", journalId: journal.id, folderId: view.folderId } : { screen: "home" });
      return view.screen === "writer" ? showWriter(journal, page) : showPicture(journal, page);
    }
    return showHome(tree);
  }
  const parentOfJournal = ({ folderId: parent }) => (parent && parent !== folderId ? { screen: "folder", folderId: parent } : { screen: "home" });

  // Refresh what's shown when Foundry changes underneath us (another device, the GM, our own relay).
  const scheduleRefresh = () => {
    refreshWanted = true;
    if (refreshTimer !== null || sheet) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (shell.isBusy()) { setTimeout(scheduleRefresh, REFRESH_DELAY_MS); return; }
      if (!refreshWanted || sheet || screenHandle) return;
      // A refresh redraws the same screen: keep the reader where they were in the list.
      const screen = view.screen;
      const top = shell.body.scrollTop;
      render();
      if (view.screen === screen) shell.body.scrollTop = top;
    }, REFRESH_DELAY_MS);
  };
  unsubscribe = gateway.subscribe((hook, document, changes, userId) => {
    if (screenHandle?.onHook?.(hook, document, changes, userId)) return;
    scheduleRefresh();
  });

  // ---- Screens ----
  function showSetup() {
    const s = frame({ screen: "pj-setup", heading: t("Title", "My Journals"), sub: character.name,
      next: () => render(), nextText: t("TryAgain", "Try again"), nextIcon: "fa-rotate-right" });
    setBody(emptyCard(t("Preparing", "Setting up your journal folder…")));
    void work(async () => {
      folderId = await gateway.characterFolder(character.actorId);
      if (!s.disposed) render();
    });
  }

  function showHome(tree) {
    const s = frame({ screen: "pj-home", heading: t("Title", "My Journals"), sub: character.name,
      next: () => openNewMenu(), nextText: t("New", "New"), nextIcon: "fa-plus" });
    const folders = tree.folders.map((entry, index) => folderRow(entry, index, tree.folders, s));
    const journals = tree.journals.map((journal, index) => journalRow(journal, index, tree.journals, folderId, s));
    setBody(
      folders.length || journals.length ? sheetCard({ className: "ve-pj-list", children: [...folders, ...journals] })
        : emptyCard(t("EmptyHome", "Nothing here yet. Tap New to start a journal or a folder.")),
      gmNote()
    );
  }

  function showFolder(tree, entry) {
    const s = frame({ screen: "pj-folder", heading: entry.folder.name, sub: character.name, back: () => go({ screen: "home" }),
      next: () => promptName({ title: t("NewJournal", "New journal"), save: name => gateway.createJournal(entry.folder.id, name)
        .then(result => go({ screen: "journal", journalId: result.id, folderId: entry.folder.id })) }),
      nextText: t("NewJournal", "New journal"), nextIcon: "fa-plus" });
    const rows = entry.journals.map((journal, index) => journalRow(journal, index, entry.journals, entry.folder.id, s));
    setBody(rows.length ? sheetCard({ className: "ve-pj-list", children: rows }) : emptyCard(t("EmptyFolder", "No journals in this folder yet.")), gmNote());
  }

  function showJournal(journal) {
    const back = () => go(parentOfJournal({ folderId: journal.folderId }));
    const s = frame({ screen: "pj-journal", heading: journal.name, sub: character.name, back,
      next: journal.canEdit ? () => openAddPage(journal) : null, nextText: t("AddPage", "Add page"), nextIcon: "fa-plus" });
    const rows = journal.pages.map((page, index) => pageRow(journal, page, index, s));
    setBody(rows.length ? sheetCard({ className: "ve-pj-list", children: rows }) : emptyCard(t("EmptyJournal", "No pages yet. Tap Add page.")));
  }

  function showWriter(journal, page) {
    const s = frame({ screen: "pj-writer", heading: page.name, sub: journal.name,
      back: () => go({ screen: "journal", journalId: journal.id, folderId: journal.folderId }) });
    const writer = mountPageWriter({ page, t, readFontSize, scope: s, canEdit: page.canEdit,
      save: html => gateway.saveText(journal.id, page.id, html),
      reload: () => gateway.page(journal.id, page.id),
      ownUserId: gateway.currentUserId() });
    screenHandle = {
      flush: () => writer.flush(),
      onHook: (hook, document, changes, userId) => {
        if (String(document?.id ?? "") !== page.id) return false;
        if (hook === "deleteJournalEntryPage") { screenHandle = null; showError(t("PageDeleted", "This page was deleted.")); go({ screen: "journal", journalId: journal.id, folderId: journal.folderId }); return true; }
        if (hook === "updateJournalEntryPage") {
          if (changes?.name) shell.layer.querySelector("#ve-builder-title").textContent = String(changes.name);
          writer.external(changes, userId);
          return true;
        }
        return false;
      }
    };
    s.own(() => writer.dispose());
    setBody(writer.element);
  }

  function showPicture(journal, page) {
    const s = frame({ screen: "pj-picture", heading: page.name, sub: journal.name,
      back: () => go({ screen: "journal", journalId: journal.id, folderId: journal.folderId }) });
    let timer = null;
    let pending = null;
    const status = node("small", { className: "ve-pj-save-status", attrs: { role: "status", "aria-live": "polite" } });
    const caption = node("textarea", { className: "ve-builder-textarea ve-pj-caption", attrs: { rows: 3, maxlength: 500, placeholder: t("CaptionPlaceholder", "Add a caption"), readonly: !page.canEdit } });
    caption.value = page.caption;
    const save = () => {
      if (pending === null) return Promise.resolve();
      const value = pending;
      pending = null;
      status.textContent = t("Saving", "Saving…");
      return gateway.saveCaption(journal.id, page.id, value).then(() => { status.textContent = t("Saved", "Saved"); },
        error => { status.textContent = t("NotSaved", "Not saved"); showError(error?.message ?? String(error)); });
    };
    s.listen(caption, "input", () => { pending = caption.value; clearTimeout(timer); timer = setTimeout(() => void save(), 900); });
    screenHandle = { flush: () => { clearTimeout(timer); void save(); }, onHook: (hook, document) => {
      if (String(document?.id ?? "") !== page.id) return false;
      if (hook === "deleteJournalEntryPage") { screenHandle = null; go({ screen: "journal", journalId: journal.id, folderId: journal.folderId }); }
      return true;
    } };
    s.own(() => clearTimeout(timer));
    setBody(node("figure", { className: "ve-pj-picture", children: [
      page.src ? node("img", { attrs: { src: page.src, alt: page.caption || page.name } }) : emptyCard(t("NoPicture", "This page has no picture.")),
      node("figcaption", { children: [caption, status] })
    ] }));
  }

  // ---- Rows ----
  function row({ art, name, detail, open, menu, kind, s }) {
    return node("div", { className: `ve-pj-row is-${kind}`, children: [
      node("button", { className: "ve-pj-row-open ve-sheet-item-row", attrs: { type: "button" }, on: { click: open },
        children: [art, rowCopy(name, detail ? node("small", { text: detail }) : null), icon("fa-chevron-right")] }, s),
      menu ? node("button", { className: "ve-pj-row-menu", attrs: { type: "button", "aria-label": t("MoreFor", "More for {name}", { name }) },
        on: { click: menu }, children: [icon("fa-ellipsis")] }, s) : null
    ] });
  }

  function folderRow(entry, index, siblings, s) {
    const { folder, journals } = entry;
    return row({ kind: "folder", s, art: rowArt("", "fa-folder"), name: folder.name, detail: count(journals.length, "JournalCount", "{count} journal", "{count} journals"),
      open: () => go({ screen: "folder", folderId: folder.id }),
      menu: () => openMenu(folder.name, [
        { label: t("Rename", "Rename"), iconName: "fa-pen", run: () => promptName({ title: t("RenameFolder", "Rename folder"), value: folder.name, save: name => gateway.renameFolder(folder.id, name) }) },
        { label: t("MoveTo", "Move to…"), iconName: "fa-folder-tree", hidden: !gateway.moveTargets("folder", folder.id).length,
          run: () => openMoveMenu(folder.name, gateway.moveTargets("folder", folder.id), targetId => gateway.moveFolder(folder.id, targetId)) },
        { label: t("MoveUp", "Move up"), iconName: "fa-arrow-up", hidden: index === 0, run: () => work(() => gateway.reorderFolder(folder.id, -1)) },
        { label: t("MoveDown", "Move down"), iconName: "fa-arrow-down", hidden: index === siblings.length - 1, run: () => work(() => gateway.reorderFolder(folder.id, 1)) },
        { label: t("Delete", "Delete"), iconName: "fa-trash", danger: true, run: () => confirm(
          journals.length ? t("DeleteFolderWith", "Delete {name} and the {count} journals in it?", { name: folder.name, count: journals.length })
            : t("DeleteThing", "Delete {name}?", { name: folder.name }),
          () => gateway.deleteFolder(folder.id)) }
      ]) });
  }

  function journalRow(journal, index, siblings, parentId, s) {
    return row({ kind: "journal", s, art: rowArt("", "fa-book"), name: journal.name, detail: count(journal.pageCount, "PageCount", "{count} page", "{count} pages"),
      open: () => go({ screen: "journal", journalId: journal.id, folderId: parentId }),
      menu: () => openMenu(journal.name, [
        { label: t("Rename", "Rename"), iconName: "fa-pen", run: () => promptName({ title: t("RenameJournal", "Rename journal"), value: journal.name, save: name => gateway.renameJournal(journal.id, name) }) },
        { label: t("MoveTo", "Move to…"), iconName: "fa-folder-tree", hidden: !gateway.moveTargets("journal", journal.id).length,
          run: () => openMoveMenu(journal.name, gateway.moveTargets("journal", journal.id), targetId => gateway.moveJournal(journal.id, targetId)) },
        { label: t("MoveUp", "Move up"), iconName: "fa-arrow-up", hidden: index === 0, run: () => work(() => gateway.reorderJournal(journal.id, -1)) },
        { label: t("MoveDown", "Move down"), iconName: "fa-arrow-down", hidden: index === siblings.length - 1, run: () => work(() => gateway.reorderJournal(journal.id, 1)) },
        { label: t("Delete", "Delete"), iconName: "fa-trash", danger: true, run: () => confirm(
          t("DeleteJournalWith", "Delete {name} and its {count} pages?", { name: journal.name, count: journal.pageCount }), () => gateway.deleteJournal(journal.id)) }
      ]) });
  }

  function pageRow(journal, page, index, s) {
    const isImage = page.type === "image";
    const openable = page.type === "text" || isImage;
    return row({ kind: "page", s, art: rowArt(isImage ? page.src : "", isImage ? "fa-image" : "fa-file-lines"), name: page.name,
      detail: isImage ? t("PicturePage", "Picture") : page.type === "text" ? t("TextPage", "Text") : t("OtherPage", "Open on desktop to view"),
      open: openable ? () => go({ screen: isImage ? "picture" : "writer", journalId: journal.id, pageId: page.id, folderId: journal.folderId }) : () => {},
      menu: page.canEdit ? () => openMenu(page.name, [
        { label: t("Rename", "Rename"), iconName: "fa-pen", run: () => promptName({ title: t("RenamePage", "Rename page"), value: page.name, save: name => gateway.renamePage(journal.id, page.id, name) }) },
        { label: t("MoveUp", "Move up"), iconName: "fa-arrow-up", hidden: index === 0, run: () => work(() => gateway.reorderPage(journal.id, page.id, -1)) },
        { label: t("MoveDown", "Move down"), iconName: "fa-arrow-down", hidden: index === journal.pages.length - 1, run: () => work(() => gateway.reorderPage(journal.id, page.id, 1)) },
        { label: t("Delete", "Delete"), iconName: "fa-trash", danger: true, run: () => confirm(t("DeleteThing", "Delete {name}?", { name: page.name }), () => gateway.deletePage(journal.id, page.id)) }
      ]) : null });
  }

  const count = (value, key, one, other) => t(`${key}.${value === 1 ? "One" : "Other"}`, value === 1 ? one : other, { count: value });
  const gmNote = () => gateway.gmOnline() ? null
    : node("p", { className: "ve-pj-note", children: [icon("fa-circle-info"), node("span", { text: t("GmOffline", "No GM is online: you can write and edit pages, but new folders, journals and pictures need a GM.") })] });

  // ---- Sheets: menus, prompts, confirmations ----
  function openSheet(title, content, { onClose = null } = {}) {
    closeSheet();
    const scope = createScope();
    const panel = node("div", { className: "ve-pj-sheet-panel", attrs: { role: "dialog", "aria-modal": "true", "aria-label": title }, children: [
      node("header", { children: [node("strong", { text: title }),
        node("button", { className: "ve-pj-sheet-close", attrs: { type: "button", "aria-label": t("Close", "Close") }, on: { click: () => closeSheet() }, children: [icon("fa-xmark")] }, scope)] }),
      content(scope)
    ] });
    const backdrop = node("div", { className: "ve-pj-sheet", attrs: { "data-ve-back-dismissable": "true" }, children: [panel] });
    scope.listen(backdrop, "click", event => { if (event.target === backdrop) closeSheet(); });
    scope.listen(backdrop, "ve-close", () => closeSheet());
    // Inside .ve-builder so the builder's button styles apply; last in the layer so Back closes it first.
    (shell.layer.querySelector(".ve-builder") ?? shell.layer).append(backdrop);
    sheet = { backdrop, scope, onClose };
    panel.querySelector("input, button:not(.ve-pj-sheet-close)")?.focus?.();
  }
  function closeSheet() {
    if (!sheet) return;
    const { backdrop, scope, onClose: after } = sheet;
    sheet = null;
    scope.dispose();
    backdrop.remove();
    after?.();
    if (refreshWanted) scheduleRefresh();
  }
  // Run a sheet's action: close the sheet, then do the work with the shell's busy state and error banner.
  const act = fn => { closeSheet(); return work(fn); };

  function openMenu(title, items) {
    openSheet(title, scope => node("div", { className: "ve-pj-menu", children: items.filter(item => !item.hidden).map(item =>
      node("button", { className: `ve-pj-menu-item${item.danger ? " is-danger" : ""}`, attrs: { type: "button" },
        on: { click: () => { closeSheet(); item.run(); } }, children: [icon(item.iconName), node("span", { text: item.label })] }, scope)) }));
  }

  function openNewMenu() {
    openMenu(t("New", "New"), [
      { label: t("NewJournal", "New journal"), iconName: "fa-book", run: () => promptName({ title: t("NewJournal", "New journal"),
        save: name => gateway.createJournal(folderId, name).then(result => go({ screen: "journal", journalId: result.id, folderId })) }) },
      { label: t("NewFolder", "New folder"), iconName: "fa-folder-plus", run: () => promptName({ title: t("NewFolder", "New folder"),
        save: name => gateway.createFolder(folderId, name) }) }
    ]);
  }

  function openAddPage(journal) {
    openMenu(t("AddPage", "Add page"), [
      { label: t("AddTextPage", "Text page"), iconName: "fa-file-lines", run: () => work(async () => {
        const pageId = await gateway.createPage(journal.id, { type: "text" });
        go({ screen: "writer", journalId: journal.id, pageId, folderId: journal.folderId });
      }) },
      { label: t("AddPicturePage", "Picture"), iconName: "fa-image", run: () => pickPicture(journal) }
    ]);
  }

  function openMoveMenu(title, targets, move) {
    openSheet(t("MoveThing", "Move {name} to…", { name: title }), scope => node("div", { className: "ve-pj-menu", children: targets.map(target =>
      node("button", { className: "ve-pj-menu-item", attrs: { type: "button" }, on: { click: () => act(() => move(target.id)) },
        children: [icon(target.role === ROLES.CHARACTER ? "fa-user" : "fa-folder"), node("span", { text: target.name })] }, scope)) }));
  }

  function promptName({ title, value = "", save }) {
    openSheet(title, scope => {
      const input = node("input", { className: "ve-pj-input", attrs: { type: "text", maxlength: 100, required: true, autocomplete: "off", enterkeyhint: "done", "aria-label": title } });
      input.value = value;
      const form = node("form", { className: "ve-pj-prompt", children: [input,
        node("div", { className: "ve-pj-sheet-actions", children: [
          node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, on: { click: () => closeSheet() }, text: t("Cancel", "Cancel") }, scope),
          node("button", { className: "ve-builder-primary", attrs: { type: "submit" }, text: t("Save", "Save") }, scope)
        ] })] });
      scope.listen(form, "submit", event => {
        event.preventDefault();
        const name = input.value;
        void act(() => save(name));
      });
      return form;
    });
    shell.layer.querySelector(".ve-pj-input")?.select?.();
  }

  function confirm(message, run) {
    openSheet(t("AreYouSure", "Are you sure?"), scope => node("div", { className: "ve-pj-prompt", children: [
      node("p", { text: message }),
      node("div", { className: "ve-pj-sheet-actions", children: [
        node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, on: { click: () => closeSheet() }, text: t("Cancel", "Cancel") }, scope),
        node("button", { className: "ve-builder-primary is-danger", attrs: { type: "button" }, on: { click: () => act(run) }, text: t("Delete", "Delete") }, scope)
      ] })
    ] }));
  }

  // ---- Pictures ----
  function pickPicture(journal) {
    const input = node("input", { attrs: { type: "file", accept: "image/*", hidden: true } });
    shell.layer.append(input);
    const done = () => input.remove();
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      done();
      if (!file) return;
      void work(async () => {
        showProgress(t("Uploading", "Uploading picture…"));
        const dataUrl = await shrinkPicture(file, t);
        const { path } = await gateway.uploadImage(dataUrl, file.name.replace(/\.[^.]+$/u, ""));
        const pageId = await gateway.createPage(journal.id, { type: "image", src: path, name: file.name.replace(/\.[^.]+$/u, "").slice(0, 100) || t("NewImagePage", "Picture") });
        go({ screen: "picture", journalId: journal.id, pageId, folderId: journal.folderId });
      });
    }, { once: true });
    input.addEventListener("cancel", done, { once: true });
    input.click();
  }
  const showProgress = text => setBody(emptyCard(text));

  render();
  return { close: () => { screenHandle?.flush?.(); screenHandle = null; closeSheet(); shell.close(); } };
}

/** Shrink a photo to at most 2048 px as WebP (JPEG where the browser can't make WebP). */
export async function shrinkPicture(file, t = (_key, fallback) => fallback) {
  const source = await decodePicture(file, t);
  const size = fitImage(source.width, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  context.drawImage(source.image, 0, 0, size.width, size.height);
  source.release();
  for (const [type, quality] of [["image/webp", 0.85], ["image/jpeg", 0.85], ["image/jpeg", 0.7]]) {
    const url = canvas.toDataURL(type, quality);
    if (url.startsWith(`data:${type}`) && url.length * 0.75 <= MAX_IMAGE_BYTES) { canvas.width = canvas.height = 0; return url; }
  }
  canvas.width = canvas.height = 0;
  throw new Error(t("Errors.ImageSize", "That picture is too large, even after shrinking it."));
}

async function decodePicture(file, t) {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { image: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch { /* fall back to an <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = "async";
    image.src = url;
    await image.decode();
    return { image, width: image.naturalWidth, height: image.naturalHeight, release: () => URL.revokeObjectURL(url) };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw new Error(t("Errors.ImageType", "That picture couldn't be read. Try a JPEG, PNG or WebP image."), { cause: error });
  }
}
