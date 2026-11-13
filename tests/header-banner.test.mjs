// Character header artwork with no bundled banners: Procedural SVG, Custom or Off. Run: node --test tests/*.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_HEADER_ARTWORK, HEADER_ARTWORK_CHOICES, normalizedHeaderArtwork, resolveHeaderBanner } from "../src/kernel/header-banner.mjs";
import { resolvePf2eHeaderBanner } from "../src/kernel/pf2e-class-appearance.mjs";

const pc = (className, name = "Orna") => ({ type: "character", name, sourceUuid: "Actor.pc", classes: className ? [{ name: className }] : [], header: {} });
const npc = (parentType, name = "Grick") => ({ type: "npc", name, sourceUuid: "Actor.npc", header: { bannerClassification: { parentType, tags: [] } } });
const pf2ePc = (classSlug, name = "Seelah") => ({ type: "character", name, sourceUuid: "Actor.pf2e", header: {}, pf2e: { identity: { classSlug } } });
const isSvg = candidate => typeof candidate?.url === "string" && candidate.url.startsWith("data:image/svg+xml,");

test("the bundled Artwork choice is gone and the header defaults to Off", () => {
  assert.deepEqual([...HEADER_ARTWORK_CHOICES], ["automatic", "custom", "off"]);
  assert.equal(DEFAULT_HEADER_ARTWORK, "off");
});

test("a saved Artwork choice from before falls back to Off", () => {
  assert.equal(normalizedHeaderArtwork("artwork"), "off");
  const resolution = resolveHeaderBanner(pc("Fighter"), "artwork");
  assert.equal(resolution.choice, "off");
  assert.equal(resolution.candidates.length, 0);
});

test("Off asks for no image, so the class colour fallback shows", () => {
  assert.equal(resolveHeaderBanner(pc("Wizard"), "off").candidates.length, 0);
  assert.equal(resolveHeaderBanner(npc("undead"), "off").candidates.length, 0);
});

test("Procedural SVG draws the character's class scene and nothing bundled", () => {
  const { candidates } = resolveHeaderBanner(pc("Fighter"), "automatic");
  assert.equal(candidates.length, 1);
  assert.ok(isSvg(candidates[0]));
  assert.equal(candidates[0].id, "class-fighter");
});

test("Procedural SVG gives a classless character the general adventurer scene", () => {
  const { candidates } = resolveHeaderBanner(pc("Homebrew Gadgeteer"), "automatic");
  assert.equal(candidates.length, 1);
  assert.ok(isSvg(candidates[0]));
  assert.equal(candidates[0].id, "seeded-generic");
});

test("Procedural SVG gives an NPC its creature habitat, or the general one", () => {
  assert.equal(resolveHeaderBanner(npc("undead"), "automatic").candidates[0].id, "seeded-undead");
  assert.equal(resolveHeaderBanner(npc("not-a-type"), "automatic").candidates[0].id, "seeded-generic");
  assert.ok(resolveHeaderBanner(npc("undead"), "automatic").candidates.every(isSvg));
});

test("Custom keeps the user's own image", () => {
  const actor = { ...pc("Fighter"), header: { customImage: "worlds/test/headers/orna.webp" } };
  const { candidates } = resolveHeaderBanner(actor, "custom");
  assert.deepEqual(candidates.map(c => c.url), ["worlds/test/headers/orna.webp"]);
});

test("PF2e: Procedural SVG draws the native class scene, Off draws nothing", () => {
  const automatic = resolvePf2eHeaderBanner(pf2ePc("champion"), "automatic");
  assert.equal(automatic.candidates.length, 1);
  assert.ok(isSvg(automatic.candidates[0]));
  assert.equal(automatic.candidates[0].id, "pf2e-class-champion");
  assert.equal(resolvePf2eHeaderBanner(pf2ePc("champion"), "off").candidates.length, 0);
  assert.equal(resolvePf2eHeaderBanner(pf2ePc("champion"), "artwork").candidates.length, 0);
  assert.equal(resolvePf2eHeaderBanner(pf2ePc("unknown-class"), "automatic").candidates[0].id, "seeded-generic");
});

test("no header candidate ever points at bundled banner files", () => {
  const actors = [pc("Fighter"), pc("Bard"), pc(""), npc("fiend"), npc("humanoid")];
  for (const choice of ["automatic", "custom", "off", "artwork"]) {
    for (const actor of actors) {
      for (const candidate of resolveHeaderBanner(actor, choice).candidates) assert.doesNotMatch(String(candidate.url), /header-banners/);
    }
  }
});
