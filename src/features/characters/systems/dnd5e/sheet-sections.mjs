// What the D&D5e sheet shows in the wide tablet stats column and what stays in its tabs.
import { SHEET_LAYOUT_WIDE } from "../../sheet-layout.mjs";

// Wide mode: the Abilities page (scores, saves, skills) lives in the stats column, so it shows Overview instead.
export const DND5E_RAIL_PAGES = Object.freeze({ abilities: "overview" });

// Cards below the identity header in the stats column, in order. Tool proficiencies appear only when there are some.
export function dnd5eStatsRailSections(actor) {
  if (!actor || actor.collective) return [];
  const sections = [];
  if (actor.abilities?.length) sections.push("abilities");
  if (actor.skills?.length) sections.push("skills");
  if (actor.toolProficiencies?.length) sections.push("tools");
  return sections;
}

// Overview cards. In wide mode the abilities, saves, skills and tools card is already in the stats column.
export function dnd5eOverviewSections(layout) {
  return layout === SHEET_LAYOUT_WIDE
    ? ["effects", "traits", "mastery"]
    : ["effects", "abilities", "traits", "mastery"];
}
