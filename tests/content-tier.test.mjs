// Unit tests for content-tier.mjs: the edition / tier tag on picker rows, over every kind of book title seen in a test
// world and in DDB Importer and homebrew world packs. Run: node --test tests/*.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { bookInfo, contentTier, tierTone } from "../src/foundry/systems/dnd5e/builder/content-tier.mjs";

const item = (book, rules = "", ddb = null) => ({ system: { source: { book, rules } }, flags: ddb ? { ddbimporter: ddb } : {} });
const D24 = { is2024: true, is2014: false };
const D14 = { is2024: false, is2014: true };

// [book, rules, DDB flags, expected label] — every book found, with how it appears there.
const SEEN = [
  ["SRD 5.2", "2024", null, "5.5e Core"],                       // dnd5e's 2024 packs (book from the pack flag)
  ["SRD 5.1", "2014", null, "5e Core"],                         // dnd5e's 2014 packs
  ["Free Rules", "2024", null, "5.5e Core"],
  ["MM 2024", "2024", null, "5.5e Core"],
  ["PHB 2024", "2024", D24, "5.5e Core"],
  ["PHB 2024", "", D24, "5.5e Core"],                           // DDB species: no source.rules
  ["DMG 2024", "2024", D24, "5.5e Core"],
  ["PHB", "2014", D14, "5e Core"],
  ["PHB", "", D14, "5e Core"],
  ["PHB", "2024", D24, "5.5e Core"],                            // DDB's updated PHB subclasses
  ["DMG", "2014", D14, "5e Core"],
  ["SRD 5.1", "2014", D14, "5e Core"],
  ["FRHoF", "2024", D24, "5.5e Expanded"],
  ["FRAiF", "2024", D24, "5.5e Expanded"],
  ["UHLH", "2024", D24, "5.5e Expanded"],
  ["Eberron: Forge of the Artificer", "2024", null, "5.5e Expanded"],
  ["Eberron: Forge of the Artificer (Imported Stock)", "2024", null, "5.5e Expanded"],
  ["XGtE", "2024", D24, "5.5e Expanded"],
  ["XGtE", "2014", D14, "5e Expanded"],
  ["TCoE", "2024", D24, "5.5e Expanded"],
  ["TCoE", "2014", D14, "5e Expanded"],
  ["Tasha's Cauldron of Everything", "2014", null, "5e Expanded"],
  ["SCAG", "2024", D24, "5.5e Expanded"],
  ["FToD", "2024", D24, "5.5e Expanded"],
  ["FToD", "", D14, "5e Expanded"],
  ["MotM", "", D14, "5e Expanded"],
  ["VGtM", "2014", D14, "5e Expanded"],
  ["EE", "", D14, "5e Expanded"],
  ["PAitM", "2014", D14, "5e Expanded"],
  ["IDRotF", "2014", D14, "5e Expanded"],
  ["Explorer's Guide to Wildemount", "2014", null, "5e Expanded"],
  ["Strixhaven: A Curriculum of Chaos", "2014", null, "5e Expanded"],
  ["TCMP1", "2024", D24, "5.5e · 3rd party"],
  ["TCMP1", "", D24, "5.5e · 3rd party"],
  ["GSB1", "2024", D24, "5.5e · 3rd party"],
  ["GSB2", "2014", D14, "5e · 3rd party"],
  ["Homebrew", "2024", D24, "5.5e · Homebrew"],                 // DDB homebrew
  ["Ravenloft: The Horrors Within", "2024", null, "5.5e · Homebrew"],
  ["Shattered Coast: Player's Guide (Homebrew)", "2024", null, "5.5e · Homebrew"],
  ["Shattered Coast (Homebrew, Gunslinger v1)", "", null, "Homebrew"],
  ["The Pugilist Class (Sterling Vermin / DDB 2024)", "", null, "5.5e · Homebrew"], // its title names 2024
  ["Monk (PHB 2024) — auto-grant homebrew patch", "2024", null, "5.5e · Homebrew"],
  ["STUB", "2024", null, "5.5e · Homebrew"]
];

test("every book seen in the test world and the DDB / homebrew packs gets its tag", () => {
  for (const [book, rules, ddb, label] of SEEN) assert.equal(contentTier(item(book, rules, ddb)).label, label, `${book} / ${rules || "-"} / ${ddb ? "DDB" : "-"}`);
});

test("edition from the item first, then the book; tiers and tones", () => {
  // No rules anywhere: the book's own edition.
  assert.deepEqual(contentTier(item("MotM")), { edition: "5e", tier: "expanded", label: "5e Expanded", rules: "2014", tone: "legacy" });
  assert.equal(contentTier(item("XGtE")).label, "Expanded", "XGtE holds both editions: no prefix when the item doesn't say");
  // The pack's book (dnd5e flags its packs) when the item names none; nothing at all: no tag.
  assert.equal(contentTier(item(""), { rules: "" }, { book: "SRD 5.2" }).label, "5.5e Core");
  assert.deepEqual(contentTier(item("")), { edition: "", tier: "", label: "", rules: "", tone: "" });
  // Abbreviations and full titles, accents and case ignored.
  assert.equal(bookInfo("Player's Handbook (2024)").tier, "core");
  assert.equal(bookInfo("forgotten realms: heroes of faerun").tier, "expanded");
  assert.equal(bookInfo("XPHB").edition, "2024");
  assert.equal(tierTone(contentTier(item("PHB 2024", "2024"))), "core55");
  assert.equal(contentTier(item("PHB 2024", "2024")).tone, "core55", "the tag carries its tone");
  assert.equal(tierTone(contentTier(item("FRHoF", "2024"))), "expanded55");
  assert.equal(tierTone(contentTier(item("PHB", "2014"))), "legacy");
  assert.equal(tierTone(contentTier(item("MotM"))), "legacy");
  assert.equal(tierTone(contentTier(item("TCMP1", "2024", D24))), "other");
  assert.equal(tierTone(contentTier(item(""))), "");
});

test("the GM's tier on a pack wins over the book list", () => {
  assert.equal(contentTier(item("PHB 2024", "2024", D24), { tier: "homebrew" }).label, "5.5e · Homebrew");
  assert.equal(contentTier(item("TCMP1", "2024", D24), { tier: "expanded" }).label, "5.5e Expanded");
  assert.equal(contentTier(item("", "2014"), { tier: "core" }).label, "5e Core", "even with no book");
  assert.equal(contentTier(item("PHB 2024", "2024"), { tier: "nonsense" }).label, "5.5e Core");
});
