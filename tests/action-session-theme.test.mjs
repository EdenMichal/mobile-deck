// Unit tests for the theme class on the dnd5e Current Action card host. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { actionSessionTheme } from "../src/foundry/systems/dnd5e/action-session-gateway.mjs";

/** A document whose #interface and body carry Foundry's theme classes. */
function fakeDocument(theme) {
  const classes = (name) => ({ contains: (value) => value === name });
  return {
    body: { classList: classes(`theme-${theme}`) },
    getElementById: (id) => (id === "interface" ? { classList: classes(`theme-${theme}`) } : null)
  };
}

test("whole chat cards are hosted under theme-light, like Foundry's own chat log, even with a dark interface", () => {
  assert.equal(actionSessionTheme(fakeDocument("dark")), "theme-light");
  assert.equal(actionSessionTheme(fakeDocument("light")), "theme-light");
});

test("compact roll rows sit on VE's surface and follow the interface theme", () => {
  assert.equal(actionSessionTheme(fakeDocument("dark"), { compact: true }), "theme-dark");
  assert.equal(actionSessionTheme(fakeDocument("light"), { compact: true }), "theme-light");
  assert.equal(actionSessionTheme(null, { compact: true }), "theme-dark");
});
