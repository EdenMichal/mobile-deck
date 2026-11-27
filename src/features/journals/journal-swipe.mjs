import { createJournalSwipeTracker } from "../../kernel/journal-navigation.mjs";

/** Turn a one-finger horizontal swipe on `element` into onSwipe("next" | "previous").
 * Listeners are passive and owned by `scope`, so vertical scrolling, taps and the pinch font-size
 * gesture keep working. A touch is left alone when it starts on something inside `content` that
 * scrolls sideways itself (a wide table or code block), while text is selected, or when
 * blocked(target) says so. `element` may be the pane's scroller around `content`, so its margins swipe too. */
export function bindJournalSwipe(element, { scope, onSwipe, blocked = () => false, content = element }) {
  const tracker = createJournalSwipeTracker();
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const touchList = (list) => Array.from(list ?? []);
  const passive = { passive: true };
  scope.listen(element, "touchstart", (event) => {
    if (scope.disposed || touchList(event.touches).length !== 1 || blocked(event.target) || textSelected()
      || scrollsSideways(event.target, [content, element])) { tracker.cancel(); return; }
    tracker.start({ touches: touchList(event.touches), time: now(), width: globalThis.innerWidth ?? Infinity });
  }, passive);
  scope.listen(element, "touchmove", (event) => tracker.move({ touches: touchList(event.touches) }), passive);
  scope.listen(element, "touchend", (event) => {
    const direction = tracker.end({ touches: touchList(event.touches), changedTouches: touchList(event.changedTouches), time: now() });
    if (!direction || scope.disposed || textSelected() || blocked(event.target)) return;
    onSwipe(direction);
  }, passive);
  scope.listen(element, "touchcancel", () => tracker.cancel(), passive);
}

// A long press that selected text, or a selection being adjusted, is never a page turn.
function textSelected() {
  try {
    const selection = globalThis.getSelection?.();
    return Boolean(selection && !selection.isCollapsed && String(selection).trim());
  } catch { return false; }
}

// True when the touch starts on something inside the page that can itself scroll sideways. The walk
// stops below the page root and the pane's own scroller: those scroll the page, not a table in it.
export function scrollsSideways(target, roots = [], getStyle = (element) => globalThis.getComputedStyle?.(element)) {
  for (let current = target?.nodeType === 1 ? target : target?.parentElement; current && !roots.includes(current); current = current.parentElement) {
    if (current.scrollWidth > current.clientWidth + 1) {
      const overflow = getStyle(current)?.overflowX ?? "";
      if (overflow === "auto" || overflow === "scroll") return true;
    }
  }
  return false;
}
