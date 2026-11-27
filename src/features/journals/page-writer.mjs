/**
 * The writing screen for one text page: a phone-sized editor with a small toolbar that saves on its
 * own a moment after typing stops, and when the screen closes. The page is stored as ordinary
 * Foundry HTML (text.format 1), so desktop Foundry shows and edits the same page.
 *
 * HTML going into and out of the editor passes sanitizeHtml(): scripts, frames, forms, event
 * handlers, inline styles and script links are removed (rules in kernel/player-journal-rules.mjs).
 */
import { icon, node } from "../../ui/dom.mjs";
import { dropsAttribute, dropsElement, isBlankHtml } from "../../kernel/player-journal-rules.mjs";

const SAVE_DELAY_MS = 1200;

/** Clean HTML through an inert document: nothing in it runs or loads while it is cleaned. */
export function sanitizeHtml(html, DOMParserClass = globalThis.DOMParser) {
  const doc = new DOMParserClass().parseFromString(`<!doctype html><body>${String(html ?? "")}</body>`, "text/html");
  clean(doc.body);
  return doc.body.innerHTML;
}

function clean(element) {
  for (const child of Array.from(element.children)) {
    if (dropsElement(child.tagName)) { child.remove(); continue; }
    for (const attribute of Array.from(child.attributes)) {
      if (dropsAttribute(attribute.name, attribute.value)) child.removeAttribute(attribute.name);
    }
    clean(child);
  }
}

export function mountPageWriter({ page, t, readFontSize = () => 16, scope, canEdit = true, save, reload, ownUserId = "" }) {
  let dirty = false;
  let saving = null;
  let again = false;
  let timer = null;
  let disposed = false;

  const status = node("small", { className: "ve-pj-save-status", attrs: { role: "status", "aria-live": "polite" } });
  const setStatus = (text, state = "") => { status.textContent = text; status.dataset.state = state; };
  const editor = node("div", { className: "ve-pj-editor", attrs: {
    contenteditable: canEdit ? "true" : "false", role: "textbox", "aria-multiline": "true",
    "aria-label": t("WriterLabel", "Page text"), spellcheck: "true", autocapitalize: "sentences",
    "data-placeholder": t("WriterPlaceholder", "Start writing…")
  } });
  editor.style.fontSize = `${Number(readFontSize()) || 16}px`;
  editor.innerHTML = sanitizeHtml(page.content);

  // The toolbar acts on the selection; pointerdown is cancelled so the editor keeps focus and selection.
  const command = (name, value = null) => {
    editor.focus();
    try { document.execCommand(name, false, value); } catch { /* unsupported command: ignore */ }
    markDirty();
  };
  const toggleBlock = tag => {
    const current = String(document.queryCommandValue?.("formatBlock") ?? "").toLowerCase().replace(/[<>]/gu, "");
    command("formatBlock", current === tag ? "<p>" : `<${tag}>`);
  };
  const tool = (iconName, label, run) => node("button", { className: "ve-pj-tool", attrs: { type: "button", "aria-label": label, title: label },
    on: { pointerdown: event => event.preventDefault(), click: run }, children: [icon(iconName)] }, scope);
  const toolbar = canEdit ? node("div", { className: "ve-pj-toolbar", attrs: { role: "toolbar", "aria-label": t("Formatting", "Formatting") }, children: [
    tool("fa-bold", t("Bold", "Bold"), () => command("bold")),
    tool("fa-italic", t("Italic", "Italic"), () => command("italic")),
    tool("fa-heading", t("Heading", "Heading"), () => toggleBlock("h2")),
    tool("fa-list-ul", t("BulletList", "Bullet list"), () => command("insertUnorderedList")),
    tool("fa-quote-left", t("Quote", "Quote"), () => toggleBlock("blockquote")),
    tool("fa-rotate-left", t("Undo", "Undo"), () => command("undo"))
  ] }) : null;

  const banner = node("div", { className: "ve-pj-banner", attrs: { role: "alert", hidden: true } });

  function markDirty() {
    if (!canEdit || disposed) return;
    dirty = true;
    setStatus(t("Unsaved", "Not saved yet"), "pending");
    clearTimeout(timer);
    timer = setTimeout(() => void saveNow(), SAVE_DELAY_MS);
  }

  function currentHtml() {
    const html = sanitizeHtml(editor.innerHTML);
    return isBlankHtml(html) ? "" : html;
  }

  // One save at a time; typing during a save queues one more.
  function saveNow() {
    clearTimeout(timer);
    if (!dirty) return saving ?? Promise.resolve();
    if (saving) { again = true; return saving; }
    dirty = false;
    setStatus(t("Saving", "Saving…"), "saving");
    saving = Promise.resolve().then(() => save(currentHtml())).then(
      () => { if (!dirty) setStatus(t("Saved", "Saved"), "saved"); },
      error => {
        dirty = true;
        console.error("Mobile Deck | Page could not be saved", error);
        setStatus(t("NotSavedRetry", "Not saved. Tap to retry."), "error");
      }).finally(() => {
      saving = null;
      if (again && !disposed) { again = false; void saveNow(); }
    });
    return saving;
  }

  scope.listen(editor, "input", markDirty);
  scope.listen(editor, "blur", () => { if (dirty) void saveNow(); });
  scope.listen(status, "click", () => { if (status.dataset.state === "error") void saveNow(); });
  // Paste as plain text: pasted web pages bring styles and markup the phone can't show well.
  scope.listen(editor, "paste", event => {
    const text = event.clipboardData?.getData?.("text/plain");
    if (typeof text !== "string") return;
    event.preventDefault();
    command("insertText", text);
  });
  try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch { /* older browsers */ }

  // Another device or the GM changed this page.
  function showNewer() {
    const latest = reload();
    if (!latest) return;
    editor.innerHTML = sanitizeHtml(latest.content);
    dirty = false;
    banner.hidden = true;
    setStatus(t("UpdatedElsewhere", "Updated from another device"), "saved");
  }
  function external(changes, userId) {
    if (!changes?.text || (userId && userId === ownUserId)) return;
    if (!dirty && !saving) { showNewer(); return; }
    banner.replaceChildren(
      node("span", { text: t("ChangedElsewhere", "This page was changed somewhere else.") }),
      node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, on: { click: showNewer }, text: t("LoadNewer", "Load theirs") }, scope),
      node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, on: { click: () => { banner.hidden = true; markDirty(); } }, text: t("KeepMine", "Keep mine") }, scope)
    );
    banner.hidden = false;
  }

  if (canEdit) setStatus(t("Saved", "Saved"), "saved");
  else setStatus(t("ReadOnly", "You can read this page but not change it."), "");

  const element = node("div", { className: "ve-pj-writer", children: [banner, toolbar, editor, status] });
  return {
    element,
    external,
    flush: () => { if (dirty) void saveNow(); },
    // Nothing being written: the editor isn't focused, every change is saved and no conflict is showing.
    // Swiping to another page waits for this, so it never leaves unsaved text behind.
    idle: () => !dirty && !saving && banner.hidden && status.dataset.state !== "error"
      && !(document.activeElement && editor.contains(document.activeElement)),
    dispose: () => { if (disposed) return; if (dirty) void saveNow(); disposed = true; clearTimeout(timer); }
  };
}
