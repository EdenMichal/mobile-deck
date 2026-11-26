// Pure tablet layout rules shared by the reducer, the frame and the sheet presenters.

// Screens that may sit beside the pinned character sheet in the Side by side layout.
export const COMPANION_ROUTES = Object.freeze(["chat", "journals", "combat"]);

// Narrowest window that still fits a fixed stats column next to the tabbed sheet content.
// There is no height floor: the column scrolls on its own, and a soft keyboard that shrinks
// the window must never flip the layout under a focused field.
export const WIDE_SHEET_MIN_WIDTH = 940;

// Name the layout the tablet has enabled:
//   "phone"      not a tablet
//   "portrait"   tablet held upright, always one pane
//   "map-split"  landscape, live map beside one screen (state.splitScreen)
//   "companion"  landscape, character sheet pinned beside Chat, Journals or Combat (state.sheetCompanion)
//   "full"       landscape, one wide pane
// The reducer keeps splitScreen and sheetCompanion from both being true; map-split wins if they ever are.
export function tabletLayoutMode(state) {
  if (state?.formFactor !== "tablet") return "phone";
  if (state.orientation !== "landscape") return "portrait";
  if (state.splitScreen) return "map-split";
  if (state.sheetCompanion) return "companion";
  return "full";
}

// The sheet gets its fixed stats column only when it owns the whole landscape pane and the window is wide enough.
export function wideCharacterSheet(state, size = null) {
  if (tabletLayoutMode(state) !== "full") return false;
  if (!size) return true;
  const width = Number(size.width);
  return !Number.isFinite(width) || width >= WIDE_SHEET_MIN_WIDTH;
}

// The screen remembered for the companion pane, falling back to Chat for missing or stale values.
export function companionRoute(state) {
  return COMPANION_ROUTES.includes(state?.companionRoute) ? state.companionRoute : "chat";
}

// True while the Side by side pair is on screen. Scene and Settings take the full width instead.
export function companionPaneActive(state) {
  return tabletLayoutMode(state) === "companion" && state.route === "characters";
}

// The screen shown in the companion pane, or "" while the pair is not on screen.
export function visibleCompanionRoute(state) {
  return companionPaneActive(state) ? companionRoute(state) : "";
}

// True when a screen is visible in either pane: the main route, or the companion beside the pinned sheet.
export function routeVisible(state, route) {
  return Boolean(route) && (state?.route === route || visibleCompanionRoute(state) === route);
}
