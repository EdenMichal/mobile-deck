/**
 * Shared full-screen layer for the Character Builder (level-up and creation). Self-contained: it
 * owns its DOM and listeners, and Mobile Deck's Back button reaches it through
 * data-ve-back-dismissable + "ve-close" (ui/ve-back-dispatcher.mjs), so no app-state changes are needed.
 *
 * Look: the layer carries VE's own character-screen scope (.ve-character-screen + data-character-theme),
 * so VE's typography (Roboto Condensed / VE Work Sans) and class accents apply; the header is VE's
 * dialog header (icon tile, accent kicker, title, square close).
 */
import { append, icon, node } from "../../ui/dom.mjs";
import { ensureBuilderStyles } from "./builder-styles.mjs";

/** Resolves after the next paint (one frame, then a task); never waits more than 50 ms (hidden tabs have no frames). */
export function nextPaint() {
  return new Promise(resolve => {
    const done = () => { clearTimeout(fallback); resolve(); };
    const fallback = setTimeout(resolve, 50);
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => setTimeout(done, 0));
  });
}

export function createScope() {
  const disposers = [];
  return {
    disposed: false,
    listen(element, type, listener) { element.addEventListener(type, listener); disposers.push(() => element.removeEventListener(type, listener)); },
    own(fn) { disposers.push(fn); },
    dispose() { this.disposed = true; while (disposers.length) { try { disposers.pop()(); } catch { /* keep disposing */ } } }
  };
}

/**
 * @param {HTMLElement} host
 * @param {{ t: Function, subtitle?: string, controller: object, onClose?: () => void,
 *   nativeFallback?: () => Promise<void>, retry?: () => Promise<void>, headIcon?: string, sheetAccent?: boolean }} options
 *   headIcon: the header tile's Font Awesome icon. sheetAccent: take the open sheet's accent (level-up);
 *   creation leaves it off and sets a class theme with setTheme() once a class is picked.
 */
export function createShell(host, { t, subtitle = "", controller, onClose = () => {}, nativeFallback = null, retry = null, headIcon = "fa-angles-up", sheetAccent = true }) {
  ensureBuilderStyles();
  const scope = createScope();
  let screenScope = null;
  let busy = false;
  let valid = true;
  let onNext = null;
  let onBack = null;

  const title = node("h2", { attrs: { id: "ve-builder-title" } });
  const sub = node("small");
  const progress = node("i");
  const errorBox = node("p", { className: "ve-builder-error", attrs: { role: "alert", hidden: true } });
  const body = node("div", { className: "ve-builder-body" });
  const tabs = node("nav", { className: "ve-builder-tabs", attrs: { role: "tablist", hidden: true } });
  const backButton = node("button", { className: "ve-builder-secondary", attrs: { type: "button" }, children: [icon("fa-arrow-left"), node("span", { text: t("Back", "Back") })],
    on: { click: () => onBack?.() } }, scope);
  const nextLabel = node("span");
  const nextButton = node("button", { className: "ve-builder-primary", attrs: { type: "button" }, children: [nextLabel, icon("fa-arrow-right")],
    on: { click: () => onNext?.() } }, scope);
  const closeButton = node("button", { className: "ve-builder-close ve-hp-editor-close", attrs: { type: "button", "aria-label": t("Close", "Close") }, children: [icon("fa-xmark")],
    on: { click: () => close() } }, scope);
  const footer = node("footer", { className: "ve-builder-footer", children: [backButton, nextButton] });

  const layer = node("div", {
    className: "ve-builder-layer ve-character-screen",
    attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": "ve-builder-title", "data-ve-back-dismissable": "true" },
    children: [node("section", { className: "ve-builder", children: [
      node("header", { className: "ve-builder-header", children: [
        node("span", { className: "ve-hp-editor-heading-icon ve-builder-header-icon", children: [icon(headIcon)] }),
        node("div", { className: "ve-builder-heading", children: [sub, title] }), closeButton] }),
      node("div", { className: "ve-builder-progress", attrs: { "aria-hidden": "true" }, children: [progress] }),
      tabs, errorBox, body, footer
    ] })]
  });
  // Level-up paints with the open sheet's accent (its class theme or the player's colour scheme).
  // Read before the layer joins the page, so the query finds the sheet, not the layer.
  const sheet = sheetAccent ? document.querySelector(".ve-character-screen") : null;
  const accent = sheet ? getComputedStyle(sheet).getPropertyValue("--ve-character-accent").trim() : "";
  if (accent) layer.style.setProperty("--ve-character-accent", accent);
  if (sheet?.dataset.characterTheme) layer.dataset.characterTheme = sheet.dataset.characterTheme;
  // VE Back: step back inside the builder, or close it.
  scope.listen(layer, "ve-close", () => (onBack && !backButton.hidden && !backButton.disabled ? onBack() : close()));
  host.append(layer);

  // replaceChildren() would print null children as the text "null"; append() skips them.
  function setBody(...children) {
    body.replaceChildren();
    append(body, children);
  }

  function showError(message) {
    errorBox.hidden = !message;
    errorBox.textContent = message ?? "";
  }

  function frame({ screen, heading, sub: subText, percent = 0, back = null, next = null, nextText = t("Next", "Next"), nextIcon = "fa-arrow-right" }) {
    screenScope?.dispose();
    layer.dataset.screen = screen ?? "";
    screenScope = createScope();
    title.textContent = heading;
    sub.textContent = subText ?? subtitle;
    progress.style.width = `${Math.max(0, Math.min(100, percent))}%`;
    onBack = back;
    onNext = next;
    backButton.hidden = !back;
    nextButton.hidden = !next;
    nextLabel.textContent = nextText;
    nextButton.querySelector("i")?.setAttribute("class", `fa-solid ${nextIcon}`);
    valid = true;
    nextButton.disabled = busy;
    showError("");
    body.scrollTop = 0;
    return screenScope;
  }

  /**
   * Run one job at a time. Resolves true when `fn` ran and finished, false when it was skipped (another job is
   * running) or threw; `onError` undoes any optimistic paint before the error shows in the banner.
   */
  async function work(fn, { onError = null } = {}) {
    if (busy) return false;
    busy = true;
    layer.setAttribute("aria-busy", "true");
    nextButton.disabled = backButton.disabled = true;
    // Let the tap's feedback paint (pressed Next, a package marked chosen) before the replay holds the main thread.
    try { await nextPaint(); await fn(); return true; }
    catch (error) {
      console.error(error);
      try { onError?.(error); } catch (undoError) { console.error(undoError); }
      showError(error?.message ?? String(error));
      return false;
    }
    finally { busy = false; layer.removeAttribute("aria-busy"); backButton.disabled = false; nextButton.disabled = !valid; }
  }

  /** Is a job running? Optimistic paints check this first: a tap work() would skip must not look accepted. */
  const isBusy = () => busy;

  function ctxFor(s) {
    return {
      t, controller, isGM: Boolean(controller.isGM ?? controller.home?.().isGM),
      validChanged: v => { valid = v; nextButton.disabled = busy || !v; },
      error: message => showError(message),
      nativeFallback: async () => { if (nativeFallback) await nativeFallback(); close(); },
      /** Show a window above the builder (spell details); it leaves with `owner` (default: the screen). */
      overlay: (element, owner = s) => { layer.append(element); owner.own(() => element.remove()); },
      /** Rebuild the current screen (the spell step's Retry). */
      retry: () => work(async () => { if (retry) await retry(); }),
      scope: s
    };
  }

  /** Returns whatever onClose returns (creation: its last debounced save). */
  function close() {
    screenScope?.dispose();
    scope.dispose();
    layer.remove();
    return onClose();
  }

  /** Creation: switch to a class's VE accent (VE's .ve-character-screen[data-character-theme] palette). */
  function setTheme(theme) {
    if (theme) layer.dataset.characterTheme = theme;
    else delete layer.dataset.characterTheme;
  }

  return { layer, tabs, body, scope, frame, work, isBusy, setBody, showError, ctxFor, close, setTheme };
}
