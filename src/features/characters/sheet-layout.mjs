// Shared tablet sheet layout: a fixed stats column beside the tabbed content on a wide landscape pane.
// System presenters decide what goes in the column; this module owns the decision and the retained shell arrangement.
import { wideCharacterSheet } from "../../kernel/tablet-layout.mjs";
import { node } from "../../ui/dom.mjs";
import { localizedText } from "../../ui/localized-text.mjs";

export const SHEET_LAYOUT_WIDE = "wide";
export const SHEET_LAYOUT_STANDARD = "standard";

// Read the window size the wide threshold is measured against.
export function sheetLayoutWindowSize(view = globalThis) {
  return { width: Number(view?.innerWidth), height: Number(view?.innerHeight) };
}

// Name the layout for one render. Collective Actors (groups, vehicles) keep the standard sheet.
export function characterSheetLayout(state, actor, size = sheetLayoutWindowSize()) {
  if (!actor || actor.collective) return SHEET_LAYOUT_STANDARD;
  return wideCharacterSheet(state, size) ? SHEET_LAYOUT_WIDE : SHEET_LAYOUT_STANDARD;
}

// Render the page a layout can show for the requested page. In wide mode a page whose whole
// content sits in the stats column falls back to its parent tab; state.characterTab is unchanged,
// so returning to the standard layout lands on the page the player chose.
export function sheetPageForLayout(page, layout, railPages = {}) {
  if (layout !== SHEET_LAYOUT_WIDE || !Object.hasOwn(railPages, page)) return page;
  return railPages[page];
}

// Drop tabs whose whole content sits in the stats column in wide mode.
export function sheetTabsForLayout(tabs, layout, railTabs = []) {
  if (layout !== SHEET_LAYOUT_WIDE || !railTabs.length) return tabs;
  return tabs.filter(([key]) => !railTabs.includes(key));
}

// A presenter-initiated layout change re-renders the whole pane, which would discard
// transient surfaces the frame deliberately keeps alive. Wait for the next ordinary render then.
export function sheetLayoutRefreshBlocked(state) {
  return Boolean(!state || state.modeTransition || state.reconnect || state.hitPointEditor || state.restEditor
    || state.spellSlotEditor || state.xpEditor || state.characterItemId || state.portraitImage
    || state.actionSession || state.partySheet || state.status !== "ready");
}

// Put the retained selector, tab bar and content scroller where the layout wants them.
// Standard: screen > [origin back] .ve-character-heading(selector, tabs) .ve-character-content-scroller
// Wide:     screen > aside.ve-sheet-stats-rail([origin back] selector, rail body)
//                    div.ve-sheet-wide-main(tabs, .ve-character-content-scroller)
// The same scroller element survives both arrangements, so the frame's scroll memory keeps working.
// Moving a node resets its scroll position, so nothing moves unless the layout changed.
export function arrangeCharacterSheetShell(shell, layout, { localize = null } = {}) {
  const screen = shell.screen;
  const wide = layout === SHEET_LAYOUT_WIDE;
  if (shell.layout === layout) return false;
  shell.layout = layout;
  screen.dataset.sheetLayout = wide ? SHEET_LAYOUT_WIDE : SHEET_LAYOUT_STANDARD;
  screen.classList.toggle("ve-sheet-wide", wide);
  const scroller = shell.scroller ??= screen.querySelector(".ve-character-content-scroller");
  const back = shell.originBack ?? null;
  if (wide) {
    shell.rail ??= node("aside", { className: "ve-sheet-stats-rail", attrs: {
      "aria-label": localizedText(localize, "VEMOBILE.Character.Presenter.CharacterStats", "Character stats") } });
    shell.railBody ??= node("div", { className: "ve-sheet-stats-rail-body" });
    shell.main ??= node("div", { className: "ve-sheet-wide-main" });
    shell.rail.replaceChildren(...[back, shell.selector, shell.railBody].filter(Boolean));
    shell.main.replaceChildren(shell.tabBar, scroller);
    screen.replaceChildren(shell.rail, shell.main, ...detachedScreenChildren(screen, shell));
  } else {
    shell.heading ??= node("div", { className: "ve-character-heading" });
    shell.heading.replaceChildren(shell.selector, shell.tabBar);
    screen.replaceChildren(...[back, shell.heading, scroller].filter(Boolean), ...detachedScreenChildren(screen, shell));
    shell.rail?.remove();
    shell.main?.remove();
  }
  return true;
}

// Keep anything else a presenter appended to the screen (overlays, quickbar prompts, menus) after the layout parts.
function detachedScreenChildren(screen, shell) {
  const parts = new Set([shell.rail, shell.main, shell.heading, shell.scroller, shell.originBack].filter(Boolean));
  return Array.from(screen.children).filter((child) => !parts.has(child));
}

// True for a focused element that takes typed input: text fields, selects and contenteditable regions.
export function editableElement(element) {
  if (!element || element.disabled) return false;
  if (element.isContentEditable) return true;
  const tag = String(element.tagName ?? "").toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag !== "input") return false;
  return !["button", "checkbox", "color", "file", "image", "radio", "range", "reset", "submit"].includes(String(element.type ?? "text").toLowerCase());
}

// The focused editable element the sheet owns, if any. Sheet editors live in the screen, its
// overlay host or (PF2e) the app root, so the app root covers them all when the screen is mounted.
function focusedSheetField(shell, overlayHost, view) {
  const active = shell.screen?.ownerDocument?.activeElement ?? view.document?.activeElement;
  if (!editableElement(active)) return null;
  const roots = [shell.screen?.closest?.(".ve-mobile-app") ?? shell.screen, overlayHost].filter(Boolean);
  return roots.some((root) => root === active || root.contains?.(active)) ? active : null;
}

// Re-evaluate the layout when the window is resized across the wide threshold. The frame only
// re-renders on form-factor or orientation changes, so a plain resize (Stage Manager, Slide Over)
// is handled here, owned by the screen scope and debounced to one check per frame.
// A re-render would destroy a field the player is typing in, so the check waits while one has
// focus and runs again once focus leaves it.
export function watchCharacterSheetLayout(shell, scope, { readLayout, rerender, overlayHost = null, view = globalThis } = {}) {
  if (shell.layoutWatch || !view?.addEventListener) return;
  shell.layoutWatch = true;
  let frame = 0;
  let waitingForBlur = false;
  const cancel = () => { if (frame) view.cancelAnimationFrame?.(frame); frame = 0; };
  const schedule = () => {
    if (frame) return;
    frame = view.requestAnimationFrame?.(check) ?? 0;
    if (!frame) check();
  };
  scope.own(cancel);
  scope.listen(view, "resize", schedule, { passive: true });
  // Focus has not moved yet during focusout; the next frame reads where it landed.
  const doc = shell.screen?.ownerDocument ?? view.document;
  if (doc?.addEventListener) scope.listen(doc, "focusout", () => { if (waitingForBlur) schedule(); }, { capture: true, passive: true });
  function check() {
    frame = 0;
    if (scope.disposed || !shell.screen?.isConnected || sheetLayoutRefreshBlocked(shell.lastState)) return;
    if (readLayout() === shell.layout) { waitingForBlur = false; return; }
    waitingForBlur = Boolean(focusedSheetField(shell, overlayHost, view));
    if (waitingForBlur) return;
    rerender();
  }
}
