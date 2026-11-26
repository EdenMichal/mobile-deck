// What the PF2e sheet shows in the wide tablet stats column and what stays in its tabs.
// The identity header (portrait, level, hero points, HP, AC and shield, speed, perception,
// class DC) moves into the column whole; these rules place the cards that follow it.
import { SHEET_LAYOUT_WIDE } from "../../sheet-layout.mjs";

// Weapon and armour proficiencies and class DCs, the rows the Proficiencies tab keeps
// below the skills. Untrained weapon and armour categories are left out.
export function pf2eSupplementaryProficiencies(actor) {
  return (actor?.pf2e?.details?.proficiencies ?? []).filter((row) => row && ["attacks", "defenses", "classDCs"].includes(row.group)
    && (row.group === "classDCs" || row.rank !== 0));
}

// Cards below the identity header in the stats column, in order: saves beside attributes,
// then skills, then lores. Each appears only when the Actor has some.
export function pf2eStatsRailSections(actor) {
  if (!actor || actor.collective) return [];
  const pf2e = actor.pf2e ?? {};
  const skills = pf2e.skills ?? [];
  const sections = [];
  if (pf2e.saves?.length || pf2e.attributes?.length) sections.push("statistics");
  if (skills.some((skill) => !skill.lore)) sections.push("skills");
  if (skills.some((skill) => skill.lore)) sections.push("lores");
  return sections;
}

// Wide mode: the Proficiencies tab keeps only weapon, armour and class DC rows once the skills
// sit in the stats column. With none of those it would be empty, so it is hidden and shows
// Character instead; state.characterTab is unchanged for the standard sheet.
export function pf2eRailPages(actor) {
  return pf2eSupplementaryProficiencies(actor).length ? {} : { abilities: "overview" };
}

// Tabs the wide layout hides because the stats column holds all of their content.
export function pf2eRailTabs(actor) {
  return Object.keys(pf2eRailPages(actor));
}

// Character tab sections. In wide mode the saves and attributes are already in the stats column.
export function pf2eOverviewSections(layout) {
  return layout === SHEET_LAYOUT_WIDE
    ? ["defenses", "details", "tools"]
    : ["statistics", "defenses", "details", "tools"];
}

// Proficiencies tab sections. In wide mode the core and lore skills are already in the stats column.
export function pf2eProficiencySections(layout) {
  return layout === SHEET_LAYOUT_WIDE
    ? ["proficiencies"]
    : ["skills", "lores", "proficiencies"];
}
