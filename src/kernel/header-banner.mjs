// Resolve header artwork from plain character records. The presenters own image loading.
// No banner images are bundled: Procedural SVG draws a scene, Custom uses the user's image,
// and Off (the default) leaves the class/theme colour fallback on its own.
import { seededClassCandidate, seededHabitatCandidate } from "./seeded-class-banner.mjs";
import { customHeaderImagePath } from "./custom-header-image.mjs";

export const HEADER_ARTWORK_CHOICES = Object.freeze(["automatic", "custom", "off"]);
export const DEFAULT_HEADER_ARTWORK = "off";
export const DEFAULT_HEADER_ARTWORK_OPACITY = 0.75;

// Match class and creature-type names consistently without changing their displayed spelling.
const key = (value) => String(value ?? "").trim().toLocaleLowerCase("en");
// The D&D5e classes that have their own procedural class scene.
const DND5E_CLASSES = Object.freeze(["Artificer", "Barbarian", "Bard", "Cleric", "Druid", "Fighter", "Monk", "Paladin", "Ranger", "Rogue", "Sorcerer", "Warlock", "Wizard"]);
const byClass = new Map(DND5E_CLASSES.map((label) => [key(label), Object.freeze({ id: `class-${key(label)}`, kind: "class", label })]));

/** D&D5e 5.3 uses {value, subtype}; older actors may retain a type string. */
export function normalizeBannerClassification(type) {
  let parentType = "";
  let rawTags = "";
  if (typeof type === "string") {
    const match = /^\s*([^()]+?)\s*(?:\(([^()]*)\))?\s*$/u.exec(type);
    if (match) [, parentType, rawTags = ""] = match;
  } else if (type && typeof type === "object") {
    parentType = String(type.value === "custom" ? type.custom ?? "" : type.value ?? "");
    rawTags = String(type.subtype ?? "");
  }
  const tags = rawTags.split(/[,;]+/u).map((tag) => key(tag)).filter(Boolean);
  return Object.freeze({ parentType: key(parentType), tags: Object.freeze(tags) });
}

// Keep valid saved choices. A retired or missing value (such as the old bundled Artwork) becomes Off.
export function normalizedHeaderArtwork(value) {
  const choice = key(value);
  return HEADER_ARTWORK_CHOICES.includes(choice) ? choice : DEFAULT_HEADER_ARTWORK;
}

// Return ordered image candidates for the chosen preference; Off produces no image requests.
export function resolveHeaderBanner(actor, headerArtwork = DEFAULT_HEADER_ARTWORK, customHeader = null) {
  const choice = normalizedHeaderArtwork(headerArtwork);
  // User-wide Custom has priority only when explicitly selected. Empty paths
  // in either scope intentionally have no other-scope fallback.
  if (choice === "custom") {
    const url = customHeaderImagePath(customHeader?.scope === "user" ? customHeader.image : actor?.header?.customImage);
    return Object.freeze({ choice, candidates: Object.freeze(url ? [Object.freeze({ id: "custom", url })] : []) });
  }
  const candidates = choice === "automatic" ? proceduralBanners(actor) : [];
  return Object.freeze({ choice, candidates: Object.freeze(candidates) });
}

// Draw a class scene for a PC with a known class, otherwise a creature habitat or the general adventurer scene.
export function proceduralBanners(actor) {
  if (actor?.type === "npc") {
    const parentType = key(actor.header?.bannerClassification?.parentType);
    const habitat = seededHabitatCandidate(parentType, actor.name) ?? seededHabitatCandidate("generic", actor.name);
    return habitat ? [habitat] : [];
  }
  if (actor?.type !== "character") return [];
  for (const entry of actor.classes ?? []) {
    const classId = key(entry.name);
    const matched = byClass.get(classId);
    if (!matched) continue;
    const candidate = seededClassCandidate(matched, classId, actor.name);
    if (candidate?.url) return [candidate];
  }
  const general = seededHabitatCandidate("generic", actor.name);
  return general ? [general] : [];
}
