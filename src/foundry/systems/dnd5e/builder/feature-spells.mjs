/**
 * L20 fixes, item 6: spell features that have no dnd5e advancement, built by the builder as its own steps after dnd5e's
 * (createLevelUpSession extraSteps; creation and level-up):
 * - Circle of the Land (Druid 3+): a land-type choice once, then the land's spells always prepared up to the Druid's
 *   highest spell level (dnd5e's "subclass:land-<type>" spell lists).
 * - College of Lore, Magical Discoveries (Bard 6+): two spells from the Cleric, Druid or Wizard lists, always prepared;
 *   on later Bard levels one may be replaced (an optional step).
 * - Feats whose spells have no advancement (DDB imports): "Magic Initiate (<Class>)" (two cantrips and a level 1 spell from
 *   that class's list), Fey Touched and Shadow Touched (their fixed spell and a level 1 spell of two schools). Other such
 *   feats get a Review warning (featSpellWarnings).
 * The class's own Spells step (spell-step.mjs) comes last, after these have been applied, so it sees their spells.
 *
 * Spells added here carry flags.<module>.grant (isBuilderGrant), so they never count as the class's own picks.
 */
import { castingState, spellSteps } from "./spell-step.mjs";
import { findEntries, spellsForList } from "./content-sources.mjs";
import { GRANT_SCOPE, LAND_TYPES, featSpellRule, landSpellsFor } from "./spell-rules.mjs";

const tr = (key, fallback, data = {}) => {
  const i18n = globalThis.game?.i18n;
  const full = `VEMOBILE.Builder.${key}`;
  const template = i18n?.has?.(full) ? i18n.localize(full) : fallback;
  return String(template).replace(/\{(\w+)\}/g, (m, k) => (data[k] !== undefined ? String(data[k]) : m));
};

/** A spell the builder's feature steps added (Circle of the Land, Magical Discoveries, feat spells). */
export function isBuilderGrant(item) {
  return Boolean(item?.flags?.[GRANT_SCOPE]?.grant);
}
const grantOf = item => String(item?.flags?.[GRANT_SCOPE]?.grant ?? "");

const slug = (system, name) => {
  if (system?.identifier) return String(system.identifier);
  const text = String(name ?? "");
  return typeof text.slugify === "function" ? text.slugify({ strict: true }) : text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
};
const PACK_BOOK = pack => globalThis.game?.packs?.get(pack)?.metadata?.flags?.dnd5e?.sourceBook ?? "";
const option = s => ({ uuid: s.uuid, name: s.name, img: s.img, level: Number(s.system?.level) || 0, tier: s.tier ?? null,
  source: [s.system?.source?.custom || s.system?.source?.book || PACK_BOOK(s.pack) || s.packLabel].filter(Boolean).join(""), blockers: [] });

/** The class whose levels grew on the copy, with its levels before this level-up. */
function levelledClass(manager, actor) {
  for (const cls of Object.values(manager.clone.classes ?? {})) {
    const before = Number(actor.classes?.[cls.identifier]?.system.levels) || 0;
    if ((Number(cls.system.levels) || 0) > before) return { cls, levelsBefore: before };
  }
  return null;
}

/** Add compendium spells to the copy as builder grants. Returns the names added. */
async function grantSpells(clone, uuids, { sourceItem, grant, prepared = 2, method = "spell", ability = "", uses = false } = {}) {
  const added = [];
  for (const uuid of uuids) {
    try {
      const doc = await globalThis.fromUuid(uuid);
      if (!doc) continue;
      const itemData = globalThis.game.items.fromCompendium(doc);
      itemData._id = globalThis.foundry.utils.randomID();
      itemData.system.sourceItem = sourceItem;
      itemData.system.method = method;
      itemData.system.prepared = prepared;
      if (ability) itemData.system.ability = ability;
      if (uses && (Number(itemData.system.level) || 0) > 0) {
        itemData.system.uses = { ...(itemData.system.uses ?? {}), max: "1", recovery: [{ period: "lr", type: "recoverAll" }] };
      }
      itemData.flags ??= {};
      itemData.flags[GRANT_SCOPE] = { ...(itemData.flags[GRANT_SCOPE] ?? {}), grant };
      clone.updateSource({ items: [itemData] });
      added.push(doc.name);
    } catch (error) {
      console.warn(`Character Builder | could not add spell ${uuid}`, error);
    }
  }
  if (added.length) clone.reset();
  return added;
}

/** Spells on the copy, by match key (identifier or name slug, and source uuid). */
const haveKeysOf = clone => new Set(clone.items.filter(i => i.type === "spell").flatMap(i => [slug(i.system, i.name), i._stats?.compendiumSource]).filter(Boolean));

/** A builder step shown with the ItemChoice screen (model shape of step-model.mjs ItemChoice). */
function choiceStep({ key, title, item, level, count, load, apply, hint = "", replaceable = [], itemType = "spell" }) {
  let cache = null;
  const options = async () => (cache ??= await load());
  const step = {
    key, type: "ItemChoice", title, item, level, warnings: [],
    async model(answer) {
      const list = await options();
      return { count, itemType, hint, options: list,
        replaceable, replace: answer?.replace ?? "" };
    },
    async apply(data = {}) {
      const list = await options();
      const offered = new Set(list.map(o => o.uuid));
      const replace = replaceable.some(r => r.id === data.replace) ? data.replace : "";
      const max = count + (replace ? 1 : 0);
      const picks = [...new Set(data.selected ?? [])].filter(uuid => offered.has(uuid)).slice(0, max);
      await apply(picks, replace);
      step.warnings = picks.length < Math.min(max, list.length) ? [{ kind: "choice", missing: Math.min(max, list.length) - picks.length }] : [];
    }
  };
  return step;
}

/* ---- Circle of the Land ---- */

/** Foundry core icons for the four lands. */
const LAND_ART = { arid: "icons/magic/nature/symbol-sun-yellow.webp", polar: "icons/magic/nature/plant-sprout-snow-green.webp",
  temperate: "icons/magic/nature/leaf-glow-green.webp", tropical: "icons/environment/wilderness/island-palm-white.webp" };

function landSteps(found, clone) {
  const { cls } = found;
  if (cls.identifier !== "druid" || cls.subclass?.identifier !== "land" || (Number(cls.system.levels) || 0) < 3) return [];
  const level = Number(cls.system.levels) || 0;
  const maxLevel = castingState(clone, "druid").maxSpellLevel;
  const current = clone.items.filter(i => i.type === "spell" && grantOf(i).startsWith("land:"));
  const known = grantOf(current[0]).slice(5);
  const grantFor = async type => {
    const { spells } = await spellsForList(`subclass:land-${type}`, { maxLevel, strict: true });
    const have = haveKeysOf(clone);
    const wanted = landSpellsFor(spells.map(s => ({ uuid: s.uuid, key: slug(s.system, s.name), level: Number(s.system?.level) || 0 })), maxLevel);
    const missing = wanted.filter(s => !have.has(s.key) && !have.has(s.uuid)).map(s => s.uuid);
    return grantSpells(clone, missing, { sourceItem: "subclass:land", grant: `land:${type}` });
  };
  if (LAND_TYPES.includes(known)) {
    // The land is chosen: this level's new circle spells arrive on their own.
    return [{ key: `land|druid|${level}`, type: "Auto", auto: true, title: tr("Land.Title", "Circle of the Land spells"), item: cls.name, level,
      async apply() { await grantFor(known); } }];
  }
  const labels = { arid: tr("Land.Arid", "Arid land"), polar: tr("Land.Polar", "Polar land"), temperate: tr("Land.Temperate", "Temperate land"),
    tropical: tr("Land.Tropical", "Tropical land") };
  return [choiceStep({ key: `land|druid`, title: tr("Land.Choose", "Circle of the Land: land type"), item: cls.name, level, count: 1, itemType: "",
    hint: tr("Land.Hint", "You can change the land type on a Long Rest; your circle spells change with it."),
    load: async () => LAND_TYPES.map(type => ({ uuid: `land:${type}`, name: labels[type], img: LAND_ART[type], source: "", tier: null, blockers: [] })),
    apply: async picks => { const type = String(picks[0] ?? "").slice(5); if (LAND_TYPES.includes(type)) await grantFor(type); } })];
}

/* ---- College of Lore: Magical Discoveries ---- */

function discoverySteps(found, clone) {
  const { cls } = found;
  if (cls.identifier !== "bard" || cls.subclass?.identifier !== "lore" || (Number(cls.system.levels) || 0) < 6) return [];
  const level = Number(cls.system.levels) || 0;
  const maxLevel = castingState(clone, "bard").maxSpellLevel;
  const current = clone.items.filter(i => i.type === "spell" && grantOf(i) === "magical-discoveries");
  const count = Math.max(0, 2 - current.length);
  const replaceable = current.map(i => ({ id: i.id, name: i.name, img: i.img }));
  if (!count && !replaceable.length) return [];
  const load = async () => {
    const have = haveKeysOf(clone);
    const byUuid = new Map();
    for (const key of ["class:cleric", "class:druid", "class:wizard"]) {
      const { spells } = await spellsForList(key, { maxLevel, strict: true });
      for (const s of spells) if (!byUuid.has(s.uuid) && !have.has(slug(s.system, s.name)) && !have.has(s.uuid)) byUuid.set(s.uuid, option(s));
    }
    return [...byUuid.values()].sort((a, b) => a.name.localeCompare(b.name));
  };
  return [choiceStep({ key: "discoveries|bard", title: tr("Discoveries.Title", "Magical Discoveries"), item: cls.name, level, count, replaceable,
    hint: tr("Discoveries.Hint", "Spells from the Cleric, Druid or Wizard lists, always prepared. On each Bard level you may replace one."),
    load, apply: async (picks, replace) => {
      if (replace) { clone.items.delete(replace); clone.reset(); }
      await grantSpells(clone, picks, { sourceItem: "subclass:lore", grant: "magical-discoveries" });
    } })];
}

/* ---- Feats whose spells have no advancement ---- */

/** Feats new on the copy (not on the real actor) that grant or choose no spell through an advancement. */
function newFeatsWithoutSpellAdvancement(clone, actor) {
  const had = new Set(actor.items.map(i => i._stats?.compendiumSource ?? i.id));
  return clone.items.filter(i => i.type === "feat" && !actor.items.get(i.id) && !had.has(i._stats?.compendiumSource ?? "")
    && !Object.values(i.advancement?.byId ?? {}).some(a => ["ItemChoice", "ItemGrant"].includes(a.constructor.typeName)
      && (a.configuration?.type === "spell" || a.configuration?.spell || (a.configuration?.items ?? []).length)));
}

function featSteps(clone, actor) {
  const steps = [];
  for (const feat of newFeatsWithoutSpellAdvancement(clone, actor)) {
    const rule = featSpellRule(feat.system?.identifier || slug({}, feat.name));
    if (!rule || rule.warnOnly) continue;
    const identifier = feat.system?.identifier || slug({}, feat.name);
    const sourceItem = `feat:${identifier}`;
    const grant = `feat:${identifier}`;
    const ability = rule.ability ?? bestAbility(clone, rule.abilities ?? ["int", "wis", "cha"]);
    const have = () => haveKeysOf(clone);
    const fromList = async (minLevel, maxLevel) => {
      const keys = rule.list ? [`class:${rule.list}`] : [];
      const all = [];
      if (keys.length) for (const key of keys) all.push(...(await spellsForList(key, { minLevel, maxLevel, strict: true })).spells);
      else all.push(...(await findEntries(e => e.type === "spell" && (Number(e.system?.level) || 0) >= minLevel && (Number(e.system?.level) || 0) <= maxLevel
        && (!rule.schools || rule.schools.includes(e.system?.school)))));
      const h = have();
      const seen = new Set();
      return all.filter(s => !h.has(slug(s.system, s.name)) && !h.has(s.uuid) && !seen.has(s.uuid) && seen.add(s.uuid))
        .map(option).sort((a, b) => a.name.localeCompare(b.name));
    };
    if (rule.fixed?.length) {
      steps.push({ key: `featspells|${identifier}|fixed`, type: "Auto", auto: true, title: feat.name, item: feat.name, level: 0,
        async apply() {
          const h = have();
          const wanted = rule.fixed.filter(key => !h.has(key));
          if (!wanted.length) return;
          const found = await findEntries(e => e.type === "spell" && wanted.includes(slug(e.system, e.name)));
          const uuids = wanted.map(key => found.find(s => slug(s.system, s.name) === key)?.uuid).filter(Boolean);
          await grantSpells(clone, uuids, { sourceItem, grant, ability, uses: true });
        } });
    }
    if (rule.cantrips) {
      steps.push(choiceStep({ key: `featspells|${identifier}|cantrips`, title: tr("FeatSpells.Cantrips", "{feat}: cantrips", { feat: feat.name }), item: feat.name, level: 0,
        count: rule.cantrips, load: () => fromList(0, 0),
        apply: picks => grantSpells(clone, picks, { sourceItem, grant, prepared: 0, ability }) }));
    }
    if (rule.spells) {
      steps.push(choiceStep({ key: `featspells|${identifier}|spells`, title: tr("FeatSpells.Spells", "{feat}: level 1 spell", { feat: feat.name }), item: feat.name, level: 0,
        count: rule.spells, load: () => fromList(1, 1),
        apply: picks => grantSpells(clone, picks, { sourceItem, grant, ability, uses: true }) }));
    }
  }
  return steps;
}

function bestAbility(clone, keys) {
  return [...keys].sort((a, b) => (Number(clone.system.abilities?.[b]?.value) || 0) - (Number(clone.system.abilities?.[a]?.value) || 0))[0] ?? "";
}

/**
 * Review warnings for feats new on the copy whose spells the builder can't add (Telekinetic, Ritual Caster…):
 * [{ key, text }].
 */
export function featSpellWarnings(clone, actor) {
  return newFeatsWithoutSpellAdvancement(clone, actor).flatMap(feat => {
    const rule = featSpellRule(feat.system?.identifier || slug({}, feat.name));
    if (!rule?.warnOnly) return [];
    return [{ key: `featspells:${feat.id}`, text: tr("FeatSpells.Warn", "{feat}: its spells aren't added automatically. Add them on the character sheet.", { feat: feat.name }) }];
  });
}

/**
 * extraSteps hook for createLevelUpSession (creation and level-up): the feature steps above, then the class's Spells step,
 * built only once they have been applied (`defer`), so it sees the spells they added.
 */
export async function builderSpellSteps(manager, actor) {
  const clone = manager.clone;
  const found = levelledClass(manager, actor);
  const steps = [...featSteps(clone, actor)];
  if (found) steps.push(...landSteps(found, clone), ...discoverySteps(found, clone));
  steps.push({ defer: () => spellSteps(manager, actor) });
  return steps;
}
