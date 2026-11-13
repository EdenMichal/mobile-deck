// The character header's Level up icon button (Character Builder fork). Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";

// The smallest DOM the button builder touches: elements with attributes, children and listeners.
class FakeNode {}
class FakeElement extends FakeNode {
  constructor(tag) { super(); this.tagName = tag.toUpperCase(); this.attributes = {}; this.children = []; this.dataset = {}; this.className = ""; this.listeners = {}; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  removeEventListener() {}
}
globalThis.Node ??= FakeNode;
globalThis.document ??= { createElement: tag => new FakeElement(tag), createTextNode: text => ({ text }) };

const { characterLevelUpButton, levelUpReady } = await import("../src/features/builder/level-up-button.mjs");
const scope = { listen: (element, type, fn) => element.addEventListener(type, fn) };
const actor = (experience, levelUp = true) => ({ sourceUuid: "Actor.a", capabilities: { levelUp }, header: { experience } });

test("no button without the builder command or the levelUp capability", () => {
  assert.equal(characterLevelUpButton(actor({ value: 0, next: 300 }), {}, scope), null);
  assert.equal(characterLevelUpButton(actor({ value: 0, next: 300 }, false), { openCharacterBuilder() {} }, scope), null);
});

test("an icon-only button labelled Level up that opens the builder for this Actor", () => {
  const opened = [];
  const button = characterLevelUpButton(actor({ value: 10, next: 300 }), { openCharacterBuilder: options => opened.push(options) }, scope);
  assert.equal(button.className, "ve-character-level-up");
  assert.equal(button.getAttribute("aria-label"), "Level up");
  assert.equal(button.getAttribute("title"), "Level up");
  assert.equal(button.children.length, 1, "only the glyph, no text label");
  assert.match(button.children[0].className, /fa-angles-up/);
  assert.equal(button.children[0].getAttribute("aria-hidden"), "true");
  button.listeners.click();
  assert.deepEqual(opened, [{ actorSourceUuid: "Actor.a" }]);
});

test("XP at the next threshold marks the button ready and says so in its label", () => {
  const button = characterLevelUpButton(actor({ value: 300, next: 300 }), { openCharacterBuilder() {}, localize: key => key === "VEMOBILE.Builder.LevelUpReady" ? "Prêt" : key }, scope);
  assert.equal(button.className, "ve-character-level-up is-ready");
  assert.equal(button.getAttribute("aria-label"), "Prêt");
  assert.equal(button.getAttribute("title"), "Prêt");
});

test("ready needs a next threshold: milestone worlds (no next) and missing XP are never ready", () => {
  assert.equal(levelUpReady(actor({ value: 2700, next: 2700 })), true);
  assert.equal(levelUpReady(actor({ value: 2699, next: 2700 })), false);
  assert.equal(levelUpReady(actor({ value: 5, next: null })), false);
  assert.equal(levelUpReady(actor(undefined)), false);
  assert.equal(levelUpReady(null), false);
});
