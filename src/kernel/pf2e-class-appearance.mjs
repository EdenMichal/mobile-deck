import { DEFAULT_HEADER_ARTWORK, normalizedHeaderArtwork, resolveHeaderBanner } from "./header-banner.mjs";
import { seededClassCandidate } from "./seeded-class-banner.mjs";

// Native class slugs select plain visual records shared by the adapter and renderer.
export const PF2E_CLASS_APPEARANCES = Object.freeze({
  alchemist: Object.freeze({ label: "Alchemist", themeKey: "pf2e-alchemist",
    accent: Object.freeze({ deep: "#567b2e", bright: "#a5c85a" }) }),
  animist: Object.freeze({ label: "Animist", themeKey: "pf2e-animist",
    accent: Object.freeze({ deep: "#357f79", bright: "#75c5b6" }) }),
  barbarian: Object.freeze({ label: "Barbarian", themeKey: "barbarian" }),
  bard: Object.freeze({ label: "Bard", themeKey: "bard" }),
  champion: Object.freeze({ label: "Champion", themeKey: "paladin" }),
  cleric: Object.freeze({ label: "Cleric", themeKey: "cleric" }),
  commander: Object.freeze({ label: "Commander", themeKey: "pf2e-commander",
    accent: Object.freeze({ deep: "#8f3e49", bright: "#d77c83" }) }),
  druid: Object.freeze({ label: "Druid", themeKey: "druid" }),
  exemplar: Object.freeze({ label: "Exemplar", themeKey: "pf2e-exemplar",
    accent: Object.freeze({ deep: "#ad7931", bright: "#efc56c" }) }),
  fighter: Object.freeze({ label: "Fighter", themeKey: "fighter" }),
  guardian: Object.freeze({ label: "Guardian", themeKey: "pf2e-guardian",
    accent: Object.freeze({ deep: "#496b7b", bright: "#8eb5c6" }) }),
  gunslinger: Object.freeze({ label: "Gunslinger", themeKey: "pf2e-gunslinger",
    accent: Object.freeze({ deep: "#96613a", bright: "#d9a26a" }) }),
  inventor: Object.freeze({ label: "Inventor", themeKey: "pf2e-inventor",
    accent: Object.freeze({ deep: "#8e6332", bright: "#d4a15b" }) }),
  investigator: Object.freeze({ label: "Investigator", themeKey: "pf2e-investigator",
    accent: Object.freeze({ deep: "#497a7c", bright: "#80b7b7" }) }),
  kineticist: Object.freeze({ label: "Kineticist", themeKey: "pf2e-kineticist",
    accent: Object.freeze({ deep: "#387f92", bright: "#75c4d2" }) }),
  magus: Object.freeze({ label: "Magus", themeKey: "pf2e-magus",
    accent: Object.freeze({ deep: "#555da3", bright: "#959be0" }) }),
  monk: Object.freeze({ label: "Monk", themeKey: "monk" }),
  necromancer: Object.freeze({ label: "Necromancer", themeKey: "pf2e-necromancer",
    accent: Object.freeze({ deep: "#597e6a", bright: "#94bea5" }) }),
  oracle: Object.freeze({ label: "Oracle", themeKey: "pf2e-oracle",
    accent: Object.freeze({ deep: "#8b689f", bright: "#c8a0d8" }) }),
  psychic: Object.freeze({ label: "Psychic", themeKey: "pf2e-psychic",
    accent: Object.freeze({ deep: "#6653a8", bright: "#aa92df" }) }),
  ranger: Object.freeze({ label: "Ranger", themeKey: "ranger" }),
  rogue: Object.freeze({ label: "Rogue", themeKey: "rogue" }),
  runesmith: Object.freeze({ label: "Runesmith", themeKey: "pf2e-runesmith",
    accent: Object.freeze({ deep: "#a15c39", bright: "#e59b62" }) }),
  sorcerer: Object.freeze({ label: "Sorcerer", themeKey: "sorcerer" }),
  summoner: Object.freeze({ label: "Summoner", themeKey: "pf2e-summoner",
    accent: Object.freeze({ deep: "#3f8d91", bright: "#81d4ce" }) }),
  swashbuckler: Object.freeze({ label: "Swashbuckler", themeKey: "pf2e-swashbuckler",
    accent: Object.freeze({ deep: "#aa5343", bright: "#e68d72" }) }),
  thaumaturge: Object.freeze({ label: "Thaumaturge", themeKey: "pf2e-thaumaturge",
    accent: Object.freeze({ deep: "#8a536c", bright: "#c991ab" }) }),
  witch: Object.freeze({ label: "Witch", themeKey: "pf2e-witch",
    accent: Object.freeze({ deep: "#6b5787", bright: "#b69aca" }) }),
  wizard: Object.freeze({ label: "Wizard", themeKey: "wizard" }),
});

export const PF2E_CLASS_ACCENTS = Object.freeze(Object.fromEntries(
  Object.values(PF2E_CLASS_APPEARANCES).filter(entry => entry.accent).map(entry => [entry.themeKey, entry.accent])
));

// Resolve a native class slug to VE's own theme, using the neutral fallback for an unknown class.
export function pf2eClassThemeKey(slug) {
  return PF2E_CLASS_APPEARANCES[String(slug ?? "").toLowerCase()]?.themeKey ?? "neutral";
}

// Draw the native PF2e class scene for Procedural SVG; every other choice and actor shares the D&D5e resolver.
export function resolvePf2eHeaderBanner(actor, headerArtwork = DEFAULT_HEADER_ARTWORK, customHeader = null) {
  const identity = actor?.pf2e?.identity ?? {};
  const classSlug = String(identity.classSlug ?? "").toLowerCase();
  const appearance = PF2E_CLASS_APPEARANCES[classSlug];
  const choice = normalizedHeaderArtwork(headerArtwork);
  if (choice === "automatic" && actor?.type === "character" && appearance) {
    const banner = seededClassCandidate(Object.freeze({ id: `pf2e-class-${classSlug}`, kind: "class", label: appearance.label }), classSlug, actor.name);
    if (banner?.url) return Object.freeze({ choice, candidates: Object.freeze([banner]) });
  }
  return resolveHeaderBanner({
    ...actor,
    classes: [],
    header: { ...(actor?.header ?? {}), bannerClassification: actor?.header?.bannerClassification ?? actor?.pf2e?.bannerClassification }
  }, choice, customHeader);
}
