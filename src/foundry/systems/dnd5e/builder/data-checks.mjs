/**
 * L20 fixes, item 15: warnings for the GM when imported class data looks incomplete, so a gap in a DDB import or in
 * dnd5e's own data isn't followed silently. Nothing here changes compendium data. Pure checks over plain facts are
 * unit-tested (dataWarningsFor); sessionDataWarnings reads them from a level-up session.
 */
import { castingState } from "./spell-step.mjs";

const tr = (key, fallback, data = {}) => {
  const i18n = globalThis.game?.i18n;
  const full = `VEMOBILE.Builder.${key}`;
  const template = i18n?.has?.(full) ? i18n.localize(full) : fallback;
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (data[k] !== undefined ? String(data[k]) : m));
};

/** 2024 classes with a Weapon Mastery choice at level 1, and Expertise levels the 2024 tables give. */
const MASTERY_CLASSES = ["barbarian", "fighter", "paladin", "ranger", "rogue"];
const EXPERTISE_LEVELS = { rogue: [1, 6], bard: [2, 9] };

/**
 * Pure. `facts`: { className, identifier, rules ("2024"|"2014"|""), newClass, original, levelsBefore, levelsAfter,
 *   masteryTrait, expertiseLevels: number[], fallback: { cantrips, prepared }, firstCasting, weaponsGained: string[] }.
 */
export function dataWarningsFor(facts, t = tr) {
  const out = [];
  const name = facts.className ?? facts.identifier;
  if (facts.newClass && facts.original && facts.rules === "2024" && MASTERY_CLASSES.includes(facts.identifier) && !facts.masteryTrait) {
    out.push({ key: `data:mastery:${facts.identifier}`, text: t("Data.NoMastery", "{name}'s data has no Weapon Mastery step (2024 rules give one at level 1). Set the masteries on the sheet.", { name }) });
  }
  for (const level of EXPERTISE_LEVELS[facts.identifier] ?? []) {
    if (facts.rules !== "2024" || level <= facts.levelsBefore || level > facts.levelsAfter) continue;
    if (!(facts.expertiseLevels ?? []).includes(level)) {
      out.push({ key: `data:expertise:${facts.identifier}:${level}`, text: t("Data.NoExpertise", "{name} {level}: the class's data has no Expertise step here (2024 rules give two). Set them on the sheet.", { name, level }) });
    }
  }
  // Said once: on the level the class starts casting (Eldritch Knight / Arcane Trickster 3), not on every level after.
  if ((facts.fallback?.cantrips || facts.fallback?.prepared) && facts.firstCasting) {
    out.push({ key: `data:spellcounts:${facts.identifier}`, text: t("Data.SpellTable", "{name}'s data has no cantrip or prepared-spell counts; the builder uses the 2024 table.", { name }) });
  }
  if (facts.newClass && !facts.original && ["bard", "monk"].includes(facts.identifier) && facts.weaponsGained?.length) {
    out.push({ key: `data:mcweapons:${facts.identifier}`, text: t("Data.MulticlassWeapons", "Multiclassing into {name} gave weapon proficiencies ({weapons}) that the 2024 multiclass rules don't. Remove them on the sheet if you follow those rules.",
      { name, weapons: facts.weaponsGained.join(", ") }) });
  }
  return out;
}

const rulesOf = item => {
  const rules = String(item?.system?.source?.rules ?? "");
  if (rules) return rules;
  if (item?.flags?.ddbimporter?.is2024) return "2024";
  if (item?.flags?.ddbimporter?.is2014) return "2014";
  return "";
};

/** The data warnings for the class a session levels (level-up or creation's class segment). */
export function sessionDataWarnings(session) {
  const clone = session.manager?.clone;
  const actor = session.actor;
  if (!clone) return [];
  const out = [];
  for (const cls of Object.values(clone.classes ?? {})) {
    const levelsBefore = Number(actor.classes?.[cls.identifier]?.system.levels) || 0;
    const levelsAfter = Number(cls.system.levels) || 0;
    if (levelsAfter <= levelsBefore) continue;
    const advs = [...Object.values(cls.advancement?.byId ?? {}), ...Object.values(cls.subclass?.advancement?.byId ?? {})];
    const traits = advs.filter(a => a.constructor.typeName === "Trait");
    const weaponsBefore = new Set(actor.system?.traits?.weaponProf?.value ?? []);
    const facts = {
      className: cls.name, identifier: cls.identifier, rules: rulesOf(cls), newClass: levelsBefore === 0,
      original: levelsBefore === 0 && Object.keys(actor.classes ?? {}).length === 0,
      levelsBefore, levelsAfter,
      masteryTrait: traits.some(a => a.configuration?.mode === "mastery"),
      expertiseLevels: traits.filter(a => a.configuration?.mode === "expertise").map(a => Number(a.level) || 0),
      fallback: castingState(clone, cls.identifier).fallback ?? {},
      firstCasting: !castingState(actor, cls.identifier).maxSpellLevel,
      weaponsGained: [...(clone.system?.traits?.weaponProf?.value ?? [])].filter(w => !weaponsBefore.has(w))
    };
    out.push(...dataWarningsFor(facts));
  }
  return out;
}
