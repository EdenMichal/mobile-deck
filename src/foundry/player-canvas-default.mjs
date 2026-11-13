// Player logins start without the Scene canvas; GM logins keep Foundry's default.
// Run during the "setup" hook: core settings are registered and game.user is known,
// but Foundry has not yet read core.noCanvas to build the canvas.
import { isCommonDisplayUser } from "./common-display-user.mjs";

const NO_CANVAS_ID = "core.noCanvas";
// Per-user marker for the one-time reset below. Client storage is shared by every
// login on the same browser, so the marker carries the user id.
const RESET_MARKER = "mobile-deck:playerNoCanvasReset";

/**
 * Make "no canvas" the default for non-GM users. A player who turns the canvas back
 * on keeps that choice: Foundry stores it explicitly and stored values win over the default.
 * The first time this runs for a player on a device, any stored value is cleared once,
 * so earlier values (including ones Mobile Deck restored) don't keep the canvas on.
 * @returns {"applied"|"unchanged"}
 */
export function applyPlayerNoCanvasDefault({ game = globalThis.game, storage = game?.settings?.storage?.get?.("client") } = {}) {
  const user = game?.user;
  const config = game?.settings?.settings?.get?.(NO_CANVAS_ID);
  // The Common Display screen needs the canvas, so it keeps Foundry's default too.
  if (!user || !config || user.isGM || isCommonDisplayUser(game)) return "unchanged";
  config.default = true;
  const marker = `${RESET_MARKER}.${user.id}`;
  try {
    if (storage && storage.getItem(marker) !== "1") {
      storage.removeItem(NO_CANVAS_ID);
      storage.setItem(marker, "1");
    }
  } catch (error) {
    console.warn("Mobile Deck | Could not reset the stored canvas setting", error);
  }
  return "applied";
}
