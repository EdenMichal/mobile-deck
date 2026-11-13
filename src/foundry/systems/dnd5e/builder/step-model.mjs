/**
 * Turn the pending advancement step into a plain screen model for src/features/builder.
 * Models carry labels, options and limits only; the screen returns answer data in the
 * shapes applyAnswer() expects (advancement-driver.mjs).
 */
import { SUPPORTED_TYPES, missingName, replaceableItems } from "./advancement-driver.mjs";
import { featBlockers, findEntries, findFeats, findSubclasses, isAllowedUuid, preferredUuid, tierForUuid } from "./content-sources.mjs";
import { rootTab, traitSlots } from "./trait-options.mjs";
import { abilityModel, spellChoiceModel } from "./spell-choice.mjs";

const label = key => (key ? globalThis.game.i18n.localize(key) : "");

/** Index entry (name, img) for a compendium UUID without loading the document when possible. */
async function entryFor(uuid) {
  let entry = null;
  try { entry = globalThis.fromUuidSync?.(uuid, { strict: false }); } catch { entry = null; }
  if (!entry) entry = await globalThis.fromUuid(uuid).catch(() => null);
  // Fix 10: an item that doesn't resolve is named from its id ("Self-Restoration"), never shown as a raw UUID.
  return entry ? { uuid, name: entry.name, img: entry.img, type: entry.type, system: entry.system ?? {} } : { uuid, name: missingName(uuid), img: "", type: "", system: {}, missing: true };
}

export async function stepModel(session) {
  const pending = session.pending;
  // Builder-owned steps (Phase 3: spells) build their own model.
  if (pending.extra) {
    return { type: pending.type, key: pending.key, index: pending.index, title: pending.title, item: pending.item, level: pending.level, sourceTab: "class",
      hint: "", answer: pending.answer?.data ?? null, meta: pending.answer?.meta ?? null,
      progress: Math.round((pending.stepIndex / Math.max(1, pending.totalSteps)) * 100), ...(await pending.extra.model(pending.answer?.data ?? null)) };
  }
  const adv = pending.advancement;
  const clone = session.manager.clone;
  const type = adv.constructor.typeName;
  const base = {
    type, key: pending.key, index: pending.index, title: pending.title || type, item: pending.item, level: pending.level,
    hint: adv.hint ?? adv.configuration?.hint ?? "", answer: pending.answer?.data ?? null, meta: pending.answer?.meta ?? null,
    progress: Math.round((pending.stepIndex / Math.max(1, pending.totalSteps)) * 100),
    // Creation (data fix 4): saved picks another tab now grants, [{ key, label, tab, name }]; the options leave them out.
    conflicts: pending.conflicts ?? [],
    // The tab the step's item comes from ("class" | "background" | "species"; "" unknown): a species' level-1 grants are
    // asked in the class segment, so the Class tab can say "From your species: <sourceName>".
    ...(({ tab, name }) => ({ sourceTab: tab, sourceName: name }))(rootTab(clone, pending.flow?.item ?? adv.item))
  };
  if (!SUPPORTED_TYPES.has(type)) return { ...base, type: "unsupported" };

  if (type === "HitPoints") {
    const die = Number(adv.hitDieValue) || 8;
    const conKey = globalThis.CONFIG.DND5E.defaultAbilities?.hitPoints || "con";
    return { ...base, die, average: Math.floor(die / 2) + 1, mod: Number(clone.system.abilities[conKey]?.mod) || 0,
      modLabel: String(globalThis.CONFIG.DND5E.abilities[conKey]?.abbreviation ?? conKey).toUpperCase(),
      className: adv.item.name, classIdentifier: adv.item.identifier };
  }

  if (type === "Size") {
    return { ...base, options: Array.from(adv.configuration.sizes).map(key => ({ key, label: label(globalThis.CONFIG.DND5E.actorSizes[key]?.label) || key })) };
  }

  if (type === "Subclass") {
    const options = await findSubclasses(adv.item.identifier);
    return { ...base, className: adv.item.name, options: options.map(o => ({ uuid: o.uuid, name: o.name, img: o.img, source: o.packLabel, tier: o.tier ?? null })) };
  }

  if (type === "AbilityScoreImprovement") {
    const scores = {};
    for (const [key, ability] of Object.entries(clone.system.abilities)) {
      const cfg = globalThis.CONFIG.DND5E.abilities[key] ?? {};
      scores[key] = { label: label(cfg.label) || key, abbr: String(cfg.abbreviation ?? key).toUpperCase(),
        value: Number(clone.system._source.abilities?.[key]?.value ?? ability.value) || 0, max: Number(ability.max) || 20 };
    }
    const config = adv.configuration;
    const model = { ...base, allowFeat: Boolean(adv.allowFeat), scores,
      config: { points: Number(config.points) || 0, cap: Number(config.cap) || 2, fixed: { ...(config.fixed ?? {}) },
        locked: Array.from(config.locked ?? []), max: config.max ?? null },
      canImprove: Object.fromEntries(Object.keys(scores).map(k => [k, adv.canImprove(k)])), feats: [] };
    if (model.allowFeat) {
      // Fix 5 (2024 rules): "the Ability Score Improvement feat or another feat of your choice for which you qualify":
      // General, Origin and Fighting Style feats (with the Fighting Style feature) at every ASI, and Epic Boons once the
      // character is level 19 (the Epic Boon step at class level 19, or any class's ASI at character level 19+).
      const level = Number(clone.system.details.level) || 0;
      const feats = await findFeats({ type: "feat" });
      model.feats = feats
        .filter(f => !["ability-score-improvement"].includes(f.system?.identifier) && f.name !== "Ability Score Improvement")
        .filter(f => (f.system?.type?.subtype ?? "") !== "epicBoon" || level >= 19)
        .map(f => ({ uuid: f.uuid, name: f.name, img: f.img, source: f.packLabel, tier: f.tier ?? null, subtype: f.system?.type?.subtype ?? "",
          blockers: uniqueBlockers([...featBlockers(f, clone, level), ...styleBlockers(f, clone)]) }))
        // Epic Boons first on the Epic Boon step; otherwise by name (findFeats sorts by name).
        .sort((a, b) => (adv.isEpicBoon ? Number(b.subtype === "epicBoon") - Number(a.subtype === "epicBoon") : 0));
    }
    return model;
  }

  if (type === "ItemChoice") {
    const config = adv.configuration;
    const choice = config.choices?.[pending.level] ?? {};
    const count = choice.count ?? 0;
    // Fix 3: dnd5e's "replace an earlier pick" (Fighting Style, invocations, Mystic Arcanum): the picks it may replace.
    const replaceable = choice.replacement ? replaceableItems(adv, pending.level).map(r => {
      const item = clone.items.get(r.id);
      return { id: r.id, uuid: r.uuid, name: item?.name ?? r.uuid, img: item?.img ?? "" };
    }) : [];
    const replacement = { replaceable, replace: pending.answer?.data?.replace ?? "" };
    // Fixed pools: drop items the GM's sources don't allow, after swapping in allowed copies. Fix 10: an entry that doesn't
    // resolve (dnd5e's SRD data links PHB items its packs lack) is looked up by name in the allowed books, else left out
    // and named on the screen.
    const pool = [];
    const missing = [];
    for (const p of config.pool ?? []) {
      let uuid = await preferredUuid(p.uuid);
      if (!(await resolvable(uuid))) {
        const name = missingName(uuid);
        const found = (await findEntries(e => e.type === (config.type || "feat") && e.name === name))[0];
        if (!found) { missing.push(name); continue; }
        uuid = found.uuid;
      }
      if (await isAllowedUuid(uuid)) pool.push(uuid);
    }
    let options = await Promise.all(pool.map(async uuid => ({ ...(await entryFor(uuid)), tier: await tierForUuid(uuid) })));
    const r = config.restriction ?? {};
    // Spells with no fixed pool (Magic Initiate): from dnd5e's spell lists, with the list and ability choices (data fix 2).
    if (!options.length && config.type === "spell") {
      return { ...base, count, ...replacement, ...(await spellChoiceModel(adv, session, pending)) };
    }
    if (!options.length && config.type === "feat") {
      options = (await findFeats({ type: r.type, subtype: r.subtype })).map(o => ({ uuid: o.uuid, name: o.name, img: o.img, system: o.system, source: o.packLabel, tier: o.tier }));
    }
    // Fix 2: prerequisites are checked at the level dnd5e checks them: the advancement's own level (the Warlock level for
    // invocations), else the character level.
    const level = Number(pending.level) || Number(clone.system.details.level) || 0;
    const taken = new Set(Object.values(adv.value?.added ?? {}).flatMap(byLevel => Object.values(byLevel ?? {})));
    // Fix 4: a repeatable item (Agonizing Blast, Eldritch Spear…) may be taken again.
    const repeatable = o => Boolean(o.system?.prerequisites?.repeatable);
    return { ...base, count, itemType: config.type ?? "", ...replacement, missing,
      options: options.map(o => ({ uuid: o.uuid, name: o.name, img: o.img, source: o.source ?? "", tier: o.tier ?? null,
        blockers: uniqueBlockers([...(taken.has(o.uuid) && !repeatable(o) ? [{ key: "repeat" }] : []), ...(o.system ? featBlockers(o, clone, level) : [])]) })),
      ...(config.type === "spell" ? abilityModel(adv, { answer: pending.answer?.data, actor: clone }) : {}) };
  }

  if (type === "ItemGrant") {
    const items = await Promise.all((adv.configuration.items ?? []).map(async i => ({ ...(await entryFor(await preferredUuid(i.uuid))), optional: Boolean(adv.configuration.optional || i.optional) })));
    // abilityChoices / ability: the spellcasting ability for granted spells, when there is a choice (data fix 2).
    return { ...base, items: items.map(i => ({ uuid: i.uuid, name: i.name, img: i.img, optional: i.optional })),
      ...abilityModel(adv, { answer: pending.answer?.data, actor: clone }) };
  }

  if (type === "Trait") {
    // Options carry their group label ("Standard Languages", "Rare Languages - Primordial", a module's group) for grouping.
    return { ...base, mode: adv.configuration.mode ?? "default", slots: await traitSlots(adv) };
  }

  return { ...base, type: "unsupported" };
}

/** One blocker per reason ("Already taken" was listed twice: the advancement's own picks and the actor's items). */
function uniqueBlockers(blockers) {
  const seen = new Set();
  return blockers.filter(b => {
    const key = `${b.key}|${b.level ?? ""}|${(b.items ?? []).join(",")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 2024: a Fighting Style feat needs the Fighting Style feature (DDB copies lack the prerequisite dnd5e's data has). */
function styleBlockers(feat, actor) {
  if ((feat.system?.type?.subtype ?? "") !== "fightingStyle") return [];
  if (Array.from(feat.system?.prerequisites?.items ?? []).length) return []; // featBlockers checks it
  const has = actor.items.some(i => i.type === "feat" && (/^fighting-style/.test(i.system?.identifier ?? "") || /^Fighting Style\b/.test(i.name)));
  return has ? [] : [{ key: "items", items: ["Fighting Style"] }];
}

async function resolvable(uuid) {
  try { if (globalThis.fromUuidSync?.(uuid, { strict: false })) return true; } catch { /* not indexed */ }
  try { return Boolean(await globalThis.fromUuid(uuid)); } catch { return false; }
}

/** Lazily load a compendium item's description for a card's "Details". */
export async function itemDetails(uuid) {
  const doc = await globalThis.fromUuid(uuid).catch(() => null);
  if (!doc) return "";
  const html = doc.system?.description?.value ?? "";
  try {
    return await globalThis.foundry.applications.ux.TextEditor.implementation.enrichHTML(html, { secrets: false, relativeTo: doc });
  } catch {
    return html;
  }
}
