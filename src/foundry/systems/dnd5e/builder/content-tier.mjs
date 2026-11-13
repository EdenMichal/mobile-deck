/**
 * Pure: the small tag on every builder picker row. Edition ("5.5e" for the 2024 rules, "5e" for 2014) and tier:
 * Core (the three core books and the SRD / free rules), Expanded (every other official Wizards of the Coast book or
 * adventure), 3rd party (other books that came through D&D Beyond, i.e. its marketplace / partnered content) or
 * Homebrew (everything else). Labels: "5.5e Core", "5.5e Expanded", "5e Core", "5e Expanded", "3rd party",
 * "Homebrew" ("5.5e · Homebrew" when the edition is known). Unit-tested in tests/content-tier.test.mjs.
 */
import { entryRules } from "./source-filter.mjs";

/** Tiers a GM can set on a pack (Sources menu), overriding the book list. */
export const TIERS = Object.freeze(["core", "expanded", "thirdParty", "homebrew"]);

const book = (edition, tier, ...names) => names.map(name => [name, { edition, tier }]);

/**
 * Books by DDB / Foundry abbreviation and full title (matched case- and punctuation-insensitively). `edition` is the
 * book's own edition, used only when the item doesn't say ("" for books that hold both, like XGtE's updated
 * subclasses). Maintained list: add a book here when a new one turns up.
 */
export const BOOKS = new Map([
  // 5.5e Core
  ...book("2024", "core", "PHB 2024", "XPHB", "Player's Handbook 2024", "Player's Handbook (2024)"),
  ...book("2024", "core", "DMG 2024", "XDMG", "Dungeon Master's Guide 2024", "Dungeon Master's Guide (2024)"),
  ...book("2024", "core", "MM 2025", "MM 2024", "XMM", "Monster Manual 2025", "Monster Manual (2025)", "Monster Manual 2024"),
  ...book("2024", "core", "SRD 5.2", "SRD 5.2.1", "SRD 5.2.0", "Free Rules", "Free Rules 2024", "Free Rules (2024)", "Basic Rules 2024", "Basic Rules (2024)", "D&D Free Rules"),
  // 5e Core
  ...book("2014", "core", "PHB", "PHB 2014", "Player's Handbook", "Player's Handbook (2014)"),
  ...book("2014", "core", "DMG", "DMG 2014", "Dungeon Master's Guide", "Dungeon Master's Guide (2014)"),
  ...book("2014", "core", "MM", "MM 2014", "Monster Manual", "Monster Manual (2014)"),
  ...book("2014", "core", "SRD 5.1", "SRD", "Basic Rules", "Basic Rules 2014", "Basic Rules (2014)"),
  // 5.5e Expanded (2024 rules books)
  ...book("2024", "expanded", "FRHoF", "Forgotten Realms: Heroes of Faerûn", "Heroes of Faerun"),
  ...book("2024", "expanded", "FRAiF", "Forgotten Realms: Adventures in Faerûn", "Adventures in Faerun"),
  ...book("2024", "expanded", "EFA", "EFotA", "Eberron: Forge of the Artificer"),
  ...book("2024", "expanded", "UHLH", "Uni and the Hunt for the Lost Horn"),
  // 5e Expanded (official 2014-era books and adventures); edition "" where DDB updated parts to 2024
  ...book("", "expanded", "XGtE", "XGE", "Xanathar's Guide to Everything"),
  ...book("", "expanded", "TCoE", "TCE", "Tasha's Cauldron of Everything"),
  ...book("", "expanded", "SCAG", "Sword Coast Adventurer's Guide"),
  ...book("2014", "expanded", "MotM", "MPMM", "Mordenkainen Presents: Monsters of the Multiverse"),
  ...book("", "expanded", "FToD", "Fizban's Treasury of Dragons"),
  ...book("2014", "expanded", "VGtM", "VGM", "Volo's Guide to Monsters"),
  ...book("2014", "expanded", "MToF", "MTF", "Mordenkainen's Tome of Foes"),
  ...book("2014", "expanded", "EE", "EEPC", "Elemental Evil Player's Companion", "Princes of the Apocalypse"),
  ...book("2014", "expanded", "ERLW", "Eberron: Rising from the Last War"),
  ...book("2014", "expanded", "EGtW", "Explorer's Guide to Wildemount"),
  ...book("2014", "expanded", "MOoT", "Mythic Odysseys of Theros"),
  ...book("2014", "expanded", "VRGtR", "Van Richten's Guide to Ravenloft"),
  ...book("2014", "expanded", "SCC", "Strixhaven: A Curriculum of Chaos"),
  ...book("2014", "expanded", "BMT", "The Book of Many Things"),
  ...book("2014", "expanded", "AAG", "Astral Adventurer's Guide"),
  ...book("2014", "expanded", "SAiS", "Spelljammer: Adventures in Space"),
  ...book("2014", "expanded", "PAitM", "Planescape: Adventures in the Multiverse"),
  ...book("2014", "expanded", "BGG", "Bigby Presents: Glory of the Giants"),
  ...book("2014", "expanded", "DSotDQ", "Dragonlance: Shadow of the Dragon Queen"),
  ...book("2014", "expanded", "GGtR", "Guildmasters' Guide to Ravnica"),
  ...book("2014", "expanded", "AI", "Acquisitions Incorporated"),
  ...book("2014", "expanded", "TDCSR", "Tal'Dorei Campaign Setting Reborn"),
  ...book("2014", "expanded", "IDRotF", "Icewind Dale: Rime of the Frostmaiden"),
  ...book("2014", "expanded", "WBtW", "The Wild Beyond the Witchlight"),
  ...book("2014", "expanded", "CoS", "Curse of Strahd"),
  ...book("2014", "expanded", "ToA", "Tomb of Annihilation"),
  ...book("2014", "expanded", "BGDiA", "Baldur's Gate: Descent into Avernus"),
  ...book("2014", "expanded", "OGA", "One Grung Above"),
  ...book("2014", "expanded", "LR", "Locathah Rising"),
  ...book("2014", "expanded", "SatO", "Sigil and the Outlands"),
  ...book("2014", "expanded", "PSA", "Plane Shift: Amonkhet"),
  ...book("2014", "expanded", "PSK", "Plane Shift: Kaladesh"),
  ...book("2014", "expanded", "PSZ", "Plane Shift: Zendikar"),
  ...book("2014", "expanded", "PSI", "Plane Shift: Innistrad"),
  ...book("2014", "expanded", "PSX", "Plane Shift: Ixalan"),
  ...book("2014", "expanded", "PSD", "Plane Shift: Dominaria"),
  ...book("2014", "expanded", "UA", "Unearthed Arcana")
]);

const norm = name => String(name ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9.]+/g, " ").trim();
const INDEX = new Map([...BOOKS].map(([name, info]) => [norm(name), info]));

/**
 * The book list's entry for a title: exact, else without a trailing bracket ("… (Imported Stock)"). A title that says
 * it is homebrew ("…homebrew patch", "Shattered Coast (Homebrew, …)") is homebrew whatever else it names.
 */
export function bookInfo(title) {
  const name = String(title ?? "").trim();
  if (!name) return null;
  if (/\bhomebrew\b/i.test(name)) return { edition: "", tier: "homebrew" };
  return INDEX.get(norm(name)) ?? INDEX.get(norm(name.replace(/\s*\([^)]*\)\s*$/, ""))) ?? null;
}

const EDITION_LABEL = { 2024: "5.5e", 2014: "5e" };
const TIER_LABEL = { core: "Core", expanded: "Expanded", thirdParty: "3rd party", homebrew: "Homebrew" };

/** Did this item come through DDB Importer (its edition or lineage flags)? */
const fromDdb = entry => {
  const ddb = entry?.flags?.ddbimporter;
  return Boolean(ddb) && typeof ddb === "object" && Object.keys(ddb).length > 0;
};

/**
 * { edition: "5.5e" | "5e" | "", tier: "core" | "expanded" | "thirdParty" | "homebrew" | "", label, rules, tone }
 * (tone: tierTone below, for the row's chip).
 * - edition: entryRules (the item's rules, the GM's pack tag, DDB's flags, a 2024-only book), else the book list's.
 * - tier: the GM's tier on the pack (`pack.tier`), else the book list, else "3rd party" for any other book that came
 *   through DDB Importer, else "Homebrew" for any other book; no book at all (the pack's `book` included): no tag.
 * `book`: the item's book, or the one its pack declares (dnd5e's packs: "SRD 5.2").
 */
export function contentTier(entry, pack = null, { book: bookName = "" } = {}) {
  const title = String(bookName || entry?.system?.source?.book || "").trim();
  const info = bookInfo(title);
  const rules = entryRules(entry, pack) || info?.edition || "";
  let tier = TIERS.includes(pack?.tier) ? pack.tier : info?.tier ?? "";
  if (!tier && title) tier = fromDdb(entry) ? "thirdParty" : "homebrew";
  const edition = EDITION_LABEL[rules] ?? "";
  let label = "";
  if (tier === "core" || tier === "expanded") label = edition ? `${edition} ${TIER_LABEL[tier]}` : TIER_LABEL[tier];
  else if (tier) label = edition ? `${edition} · ${TIER_LABEL[tier]}` : TIER_LABEL[tier];
  const tag = { edition, tier, label, rules };
  return { ...tag, tone: tierTone(tag) };
}

/** The look of a tag: "core55" (accent), "expanded55" (accent outline), "legacy" (muted, any 5e tag), "other" (gold). */
export function tierTone(tag) {
  if (!tag?.tier) return "";
  if (tag.tier === "thirdParty" || tag.tier === "homebrew") return "other";
  if (tag.edition === "5e") return "legacy";
  return tag.tier === "core" ? "core55" : "expanded55";
}
