// Unit tests for common-display-user.mjs. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { isCommonDisplayUser } from "../src/foundry/common-display-user.mjs";

test("a user named Display or display is the Common Display user", () => {
  assert.equal(isCommonDisplayUser({ user: { name: "Display" } }), true);
  assert.equal(isCommonDisplayUser({ user: { name: "display" } }), true);
  assert.equal(isCommonDisplayUser({ user: { name: " DISPLAY " } }), true);
});

test("other users are not", () => {
  assert.equal(isCommonDisplayUser({ user: { name: "Gamemaster" } }), false);
  assert.equal(isCommonDisplayUser({ user: { name: "Display 2" } }), false);
});

test("during init the name comes from the raw user data", () => {
  const game = { userId: "u2", data: { users: [{ _id: "u1", name: "Eden" }, { _id: "u2", name: "Display" }] } };
  assert.equal(isCommonDisplayUser(game), true);
  assert.equal(isCommonDisplayUser({ ...game, userId: "u1" }), false);
});

test("before the user is known it is false", () => {
  assert.equal(isCommonDisplayUser({}), false);
  assert.equal(isCommonDisplayUser(undefined), false);
});
