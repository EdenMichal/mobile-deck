// The Character Builder ships no art of its own: every option shows its item's own Foundry img. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { clearContentCache, findBackgrounds, findSpecies } from "../src/foundry/systems/dnd5e/builder/content-sources.mjs";

const ROOT = new URL("../", import.meta.url);
const DDB_BOOK_ICON = "icons/skills/trades/academics-book-study-purple.webp";

/** One world Item pack holding `entries`, with no saved source settings (the defaults apply). */
function gameWith(entries) {
  const pack = {
    collection: "world.origins", documentName: "Item", visible: true,
    metadata: { label: "Origins", packageType: "world", packageName: "test-world" },
    getIndex: async () => entries
  };
  return {
    packs: Object.assign([pack], { get: id => (id === pack.collection ? pack : undefined) }),
    settings: { get: () => { throw new Error("not registered"); } }
  };
}

test("background and species pickers show each item's own img, placeholders included", async () => {
  clearContentCache();
  const game = gameWith([
    { _id: "sage", type: "background", name: "Sage", img: DDB_BOOK_ICON, system: { identifier: "background-sage" } },
    { _id: "soldier", type: "background", name: "Soldier", img: "systems/dnd5e/icons/backgrounds/soldier.webp", system: { identifier: "soldier" } },
    { _id: "haunted", type: "background", name: "Haunted One", img: "icons/svg/item-bag.svg", system: {} },
    { _id: "lineage", type: "race", name: "Custom Lineage", img: "", system: { identifier: "custom-lineage" } }
  ]);
  const backgrounds = Object.fromEntries((await findBackgrounds(game)).map(b => [b.name, b.img]));
  assert.deepEqual(backgrounds, {
    "Haunted One": "icons/svg/item-bag.svg",
    Sage: DDB_BOOK_ICON,
    Soldier: "systems/dnd5e/icons/backgrounds/soldier.webp"
  });
  // No img at all: the row gets "" and draws its own non-art fallback.
  assert.deepEqual((await findSpecies(game)).map(s => s.img), [""]);
});

test("no bundled builder art ships, and nothing in src points at it", () => {
  assert.equal(existsSync(new URL("assets/builder-art/", ROOT)), false);
  assert.equal(existsSync(new URL("src/foundry/systems/dnd5e/builder/builder-art.mjs", ROOT)), false);
  const walk = dir => readdirSync(dir, { withFileTypes: true }).flatMap(d =>
    d.isDirectory() ? walk(new URL(`${d.name}/`, dir)) : d.name.endsWith(".mjs") ? [new URL(d.name, dir)] : []);
  for (const file of walk(new URL("src/", ROOT))) assert.doesNotMatch(readFileSync(file, "utf8"), /builder-art/, file.pathname);
});
