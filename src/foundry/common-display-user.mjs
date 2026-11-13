// Monk's Common Display runs a shared screen (TV/monitor) logged in as a user named "Display".
// Mobile Deck stays out of that login entirely: no mobile interface, no mode prompt, no canvas changes.

const DISPLAY_USER_NAME = "display";

/**
 * True when the current login is the Common Display user (name "Display", any case).
 * game.user exists from "setup"; during "init" only the raw user data is available.
 * Before "init" the user is unknown, so this returns false.
 */
export function isCommonDisplayUser(game = globalThis.game) {
  const name = game?.user?.name
    ?? game?.data?.users?.find?.(user => user?._id === game?.userId)?.name;
  return typeof name === "string" && name.trim().toLowerCase() === DISPLAY_USER_NAME;
}
