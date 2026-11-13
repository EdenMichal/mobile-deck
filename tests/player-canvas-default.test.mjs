// Unit tests for player-canvas-default.mjs with a fake game and storage. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyPlayerNoCanvasDefault } from "../src/foundry/player-canvas-default.mjs";

/** A Map-backed stand-in for localStorage. */
function fakeStorage(entries = {}) {
  const map = new Map(Object.entries(entries));
  return {
    getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: key => map.delete(key),
    map
  };
}

function fakeGame({ isGM = false, id = "player1" } = {}) {
  const config = { id: "core.noCanvas", scope: "client", default: false };
  return { config, game: { user: { id, isGM }, settings: { settings: new Map([["core.noCanvas", config]]) } } };
}

test("a player gets no canvas by default and a stale stored value is cleared once", () => {
  const { game, config } = fakeGame();
  const storage = fakeStorage({ "core.noCanvas": "false" });
  assert.equal(applyPlayerNoCanvasDefault({ game, storage }), "applied");
  assert.equal(config.default, true);
  assert.equal(storage.getItem("core.noCanvas"), null);
  assert.equal(storage.getItem("mobile-deck:playerNoCanvasReset.player1"), "1");
});

test("a player's later choice to turn the canvas back on is kept", () => {
  const { game, config } = fakeGame();
  const storage = fakeStorage({ "core.noCanvas": "false", "mobile-deck:playerNoCanvasReset.player1": "1" });
  applyPlayerNoCanvasDefault({ game, storage });
  assert.equal(config.default, true);
  assert.equal(storage.getItem("core.noCanvas"), "false");
});

test("a GM keeps Foundry's default and stored value", () => {
  const { game, config } = fakeGame({ isGM: true });
  const storage = fakeStorage({ "core.noCanvas": "false" });
  assert.equal(applyPlayerNoCanvasDefault({ game, storage }), "unchanged");
  assert.equal(config.default, false);
  assert.equal(storage.getItem("core.noCanvas"), "false");
});

test("nothing happens before the user or setting is known", () => {
  assert.equal(applyPlayerNoCanvasDefault({ game: {}, storage: fakeStorage() }), "unchanged");
});

test("the Monk's Common Display user keeps the canvas", () => {
  const { game, config } = fakeGame();
  game.user.name = "Display";
  const storage = fakeStorage({ "core.noCanvas": "false" });
  assert.equal(applyPlayerNoCanvasDefault({ game, storage }), "unchanged");
  assert.equal(config.default, false);
  assert.equal(storage.getItem("core.noCanvas"), "false");
});
