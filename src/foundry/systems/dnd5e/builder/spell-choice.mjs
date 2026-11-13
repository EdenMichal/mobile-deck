/**
 * Data fix 2: advancement steps that hand out spells.
 * - ItemChoice with type "spell" and no fixed pool (Magic Initiate: "Two Cantrips", "Level 1 Spell"): the options come
 *   from dnd5e's spell lists (restriction.list, e.g. Cleric / Druid / Wizard), limited to restriction.level and the GM's
 *   allowed sources. With several lists the player picks one, and every spell of the feat comes from it (2024 rules).
 * - The spellcasting ability for granted or chosen spells (spell.ability with more than one entry), passed to dnd5e's
 *   apply as `ability`, as its own ItemChoiceFlow / ItemGrantFlow do.
 * Shared by creation and level-up (step-model.mjs, advancement-driver.mjs).
 */
import { findEntries, spellListsReady, spellsForList } from "./content-sources.mjs";

const tr = (key, fallback) => {
  const i18n = globalThis.game?.i18n;
  const full = `VEMOBILE.Builder.${key}`;
  return i18n?.has?.(full) ? i18n.localize(full) : fallback;
};
const registry = () => globalThis.dnd5e?.registry?.spellLists ?? null;

/** Pure: the lists every one of these spells is on, among `choices` (each spell given as its list keys). */
export function listsInCommon(spellLists = [], choices = []) {
  return choices.filter(key => spellLists.every(lists => lists.includes(key)));
}

/** Pure: the one list a feat's earlier picks fix, or null: a saved `list` answer first, else the only list they share. */
export function lockedList({ answered = [], pickedLists = [] } = {}, choices = []) {
  const saved = answered.find(list => list && choices.includes(list));
  if (saved) return saved;
  if (!pickedLists.length) return null;
  const common = listsInCommon(pickedLists, choices);
  return common.length === 1 ? common[0] : null;
}

/** 2024 backgrounds whose Magic Initiate is tied to one list, when their text doesn't say "Magic Initiate (Cleric)". */
const BACKGROUND_LISTS = { acolyte: "class:cleric", sage: "class:wizard", guide: "class:druid" };

/**
 * Pure (fix 8): the one list a background's Magic Initiate uses: "Magic Initiate (Wizard)" in the background's text, else
 * the 2024 background's own (Acolyte → Cleric, Sage → Wizard, Guide → Druid). null when the background doesn't say.
 * @param {{ text: string, identifier: string, featName: string, keys: string[], labels: Record<string, string> }} input
 */
export function backgroundList({ text = "", identifier = "", featName = "Magic Initiate", keys = [], labels = {} } = {}) {
  const plain = String(text).replace(/<[^>]+>/g, " ");
  const escape = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const key of keys) {
    const label = labels[key] ?? key.split(":").pop();
    if (new RegExp(`${escape(featName)}\\s*\\(\\s*${escape(label)}\\s*\\)`, "i").test(plain)) return key;
  }
  const mapped = BACKGROUND_LISTS[String(identifier).replace(/^background-/, "")];
  return keys.includes(mapped) ? mapped : null;
}

/** The list a spell choice is fixed to by the background that granted its feat, or null (fix 8). */
export function originList(adv, keys = Array.from(adv?.configuration?.restriction?.list ?? [])) {
  if (keys.length < 2) return null;
  const flag = adv.item?.getFlag?.("dnd5e", "advancementOrigin") ?? adv.item?.flags?.dnd5e?.advancementOrigin ?? "";
  const origin = adv.actor?.items?.get?.(String(flag).split(".")[0]);
  if (origin?.type !== "background") return null;
  return backgroundList({ text: `${origin.name} ${origin.system?.description?.value ?? ""}`, identifier: origin.system?.identifier ?? "",
    featName: adv.item?.name ?? "Magic Initiate", keys, labels: Object.fromEntries(keys.map(k => [k, listLabel(k)])) });
}

/** Pure: the ability to offer first: the answer, the feat's other answer, the character's casting ability, else the best score. */
export function suggestedAbility(choices = [], { answer = "", sibling = "", casting = "", scores = {} } = {}) {
  for (const key of [answer, sibling, casting]) if (key && choices.includes(key)) return key;
  return [...choices].sort((a, b) => (Number(scores[b]) || 0) - (Number(scores[a]) || 0))[0] ?? "";
}

/** The level range of a spell choice: "" any, "available" up to the highest slot the character has, or one level. */
function levelRange(restriction = {}, actor) {
  const raw = String(restriction.level ?? "");
  if (raw === "") return { min: 0, max: 9 };
  if (raw === "available") {
    let max = 0;
    for (const [key, slot] of Object.entries(actor?.system?.spells ?? {})) {
      const level = key === "pact" ? Number(slot?.level) || 0 : Number(key.replace("spell", "")) || 0;
      if ((Number(slot?.max) || 0) > 0) max = Math.max(max, level);
    }
    return { min: 0, max };
  }
  const level = Number(raw) || 0;
  return { min: level, max: level };
}

/** "class:cleric" → its registered name ("Cleric"). */
const listLabel = key => registry()?.forType?.(key)?.name ?? key.split(":").pop();

/** List keys a spell is on, among `keys` (or any registered list when `keys` is empty). Matches DDB / homebrew copies by identifier. */
function listsOf(uuid, identifier, keys) {
  const reg = registry();
  if (!reg) return [];
  if (!keys.length) return Array.from(reg.forSpell?.(uuid) ?? []).map(l => `${l.metadata.type}:${l.metadata.identifier}`);
  return keys.filter(key => {
    const list = reg.forType?.(key);
    return list && (list.has(uuid) || (identifier && list.identifiers?.has(identifier)));
  });
}

const identifierOf = uuid => {
  let entry = null;
  try { entry = globalThis.fromUuidSync?.(uuid, { strict: false }); } catch { entry = null; }
  const name = String(entry?.name ?? "");
  return entry?.system?.identifier || (typeof name.slugify === "function" ? name.slugify({ strict: true }) : "");
};

/** Spells this item's other spell choices already added (Magic Initiate's cantrips when the level-1 spell is asked). */
function siblingPicks(adv) {
  const others = (adv.item?.advancement?.byType?.ItemChoice ?? []).filter(a => a.id !== adv.id && a.configuration.type === "spell");
  return others.flatMap(a => Object.values(a.value?.added ?? {}).flatMap(byLevel => Object.values(byLevel ?? {})));
}

/** The saved answers of this item's other steps (same item source in the step key), for the list and ability. */
function siblingAnswers(session, pending) {
  const source = String(pending.key ?? "").split("|")[0];
  return (session.path ?? []).filter(p => p.index !== pending.index && String(p.key).split("|")[0] === source)
    .map(p => session.answers?.[p.index]?.data).filter(Boolean);
}

/** Ability fields for a step whose spells may use one of several abilities (none when there is one or none). */
export function abilityModel(adv, { answer = null, siblings = [], actor = adv.actor } = {}) {
  const choices = Array.from(adv.configuration?.spell?.ability ?? []);
  if (choices.length < 2) return {};
  const D = globalThis.CONFIG?.DND5E?.abilities ?? {};
  const scores = Object.fromEntries(choices.map(k => [k, actor?.system?.abilities?.[k]?.value]));
  const ability = suggestedAbility(choices, { answer: answer?.ability, sibling: siblings.find(s => s?.ability)?.ability,
    casting: actor?.system?.attributes?.spellcasting, scores });
  return { abilityChoices: choices.map(key => ({ key, label: globalThis.game?.i18n?.localize?.(D[key]?.label ?? key) ?? key })), ability };
}

/**
 * Options for a spell ItemChoice with no fixed pool: [{ uuid, name, img, source, level, lists, blockers }], plus
 * `spellLists` ([{ key, label }], when the player must pick one), `list` (the list the feat's earlier picks fixed, or
 * the saved one) and the ability fields.
 */
export async function spellChoiceModel(adv, session, pending) {
  const config = adv.configuration;
  const actor = adv.actor;
  const keys = Array.from(config.restriction?.list ?? []);
  const { min, max } = levelRange(config.restriction, actor);
  await spellListsReady();
  const options = new Map();
  if (keys.length) {
    for (const key of keys) {
      const { spells } = await spellsForList(key, { minLevel: min, maxLevel: max, strict: true });
      for (const s of spells) {
        const o = options.get(s.uuid) ?? { uuid: s.uuid, name: s.name, img: s.img, source: s.packLabel, tier: s.tier ?? null, level: Number(s.system?.level) || 0, lists: [], system: s.system };
        o.lists.push(key);
        options.set(s.uuid, o);
      }
    }
  } else {
    for (const s of await findEntries(e => e.type === "spell" && (Number(e.system?.level) || 0) >= min && (Number(e.system?.level) || 0) <= max)) {
      options.set(s.uuid, { uuid: s.uuid, name: s.name, img: s.img, source: s.packLabel, tier: s.tier ?? null, level: Number(s.system?.level) || 0,
        lists: listsOf(s.uuid, s.system?.identifier, []), system: s.system });
    }
  }
  // A spell the character already has (by source or identifier) is shown but blocked, like a feat already taken.
  const have = new Set(actor.items.filter(i => i.type === "spell").flatMap(i => [i._stats?.compendiumSource, i.system?.identifier]).filter(Boolean));
  const siblings = siblingAnswers(session, pending);
  const picked = siblingPicks(adv);
  const multi = keys.length > 1;
  const fixed = multi ? originList(adv, keys) : null;
  const list = fixed ?? (multi ? lockedList({ answered: [pending.answer?.data?.list, ...siblings.map(s => s.list)],
    pickedLists: picked.map(uuid => listsOf(uuid, identifierOf(uuid), keys)) }, keys) : null);
  return {
    itemType: "spell",
    spellLists: multi ? keys.map(key => ({ key, label: listLabel(key) })) : [],
    list, listLocked: Boolean(fixed) || Boolean(list && picked.length),
    options: [...options.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ system, ...o }) => ({ ...o,
      blockers: have.has(o.uuid) || (system?.identifier && have.has(system.identifier)) ? [{ key: "repeat" }] : [] })),
    ...abilityModel(adv, { answer: pending.answer?.data, siblings, actor })
  };
}

/**
 * Before dnd5e applies a spell ItemChoice answer: with several lists, every spell of the feat (this answer's and the
 * ones its other steps added) must be on one list, and on `data.list` when the answer names one. Throws otherwise.
 */
export function checkSpellChoice(adv, data = {}) {
  const config = adv.configuration ?? {};
  if (adv.constructor.typeName !== "ItemChoice" || config.type !== "spell") return;
  const keys = Array.from(config.restriction?.list ?? []);
  if (keys.length < 2 || !registry()) return;
  const fixed = originList(adv, keys);
  if (fixed && data.list && data.list !== fixed) throw new Error(tr("SpellChoice.BackgroundList", "This background's Magic Initiate uses one spell list only."));
  const uuids = [...(data.selected ?? []), ...siblingPicks(adv)];
  if (!uuids.length) return;
  const choices = fixed ? [fixed] : data.list ? keys.filter(k => k === data.list) : keys;
  if (!listsInCommon(uuids.map(uuid => listsOf(uuid, identifierOf(uuid), keys)), choices).length) {
    throw new Error(tr("SpellChoice.OneList", "All of this feat's spells must come from the same spell list."));
  }
}
