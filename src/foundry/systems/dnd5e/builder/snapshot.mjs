/**
 * Plain snapshot of a dnd5e character for the Review changes list (review-diff.mjs).
 * Works on the real actor or the AdvancementManager's prepared clone.
 */
export function builderSnapshot(actor, { CONFIG: config = globalThis.CONFIG, game = globalThis.game } = {}) {
  const D = config.DND5E;
  const sys = actor.system;
  const localize = key => (key ? game.i18n.localize(key) : "");
  const traitLabel = (key, trait) => {
    try { return globalThis.dnd5e?.documents?.Trait?.keyLabel?.(key, { trait }) || key; }
    catch { return key; }
  };

  const abilities = {};
  const saves = {};
  for (const [key, a] of Object.entries(sys.abilities ?? {})) {
    const cfg = D.abilities[key] ?? {};
    abilities[key] = { label: String(cfg.abbreviation ?? key).toUpperCase(), value: a.value };
    saves[key] = { label: localize(cfg.label) || key, proficient: Boolean(a.proficient) };
  }
  const skills = {};
  for (const [key, s] of Object.entries(sys.skills ?? {})) skills[key] = { label: localize(D.skills[key]?.label) || key, value: Number(s.value) || 0 };

  const traits = sys.traits ?? {};
  const set = v => Array.from(v ?? []);
  const profs = {
    languages: set(traits.languages?.value).map(k => traitLabel(k, "languages")).sort(),
    armor: set(traits.armorProf?.value).map(k => traitLabel(k, "armor")).sort(),
    weapons: set(traits.weaponProf?.value).map(k => traitLabel(k, "weapon")).sort(),
    mastery: set(traits.weaponProf?.mastery?.value).map(k => traitLabel(k, "weapon")).sort(),
    tools: Object.entries(sys.tools ?? {}).filter(([, t]) => Number(t.value) > 0).map(([k]) => traitLabel(k, "tool")).sort()
  };

  const classes = {};
  for (const [id, cls] of Object.entries(actor.classes ?? {})) {
    classes[id] = { name: cls.name, levels: cls.system.levels, subclass: cls.subclass?.name ?? "" };
  }

  const items = actor.items.map(i => ({ id: i.id, name: i.name, type: i.type,
    source: i._stats?.compendiumSource ?? i.flags?.dnd5e?.sourceId ?? "",
    typeLabel: i.type === "feat" ? localize(D.featureTypes?.[i.system.type?.value]?.label) || localize(config.Item.typeLabels?.[i.type]) : localize(config.Item.typeLabels?.[i.type]),
    ...(i.type === "spell" ? { level: Number(i.system.level) || 0, prepared: Number(i.system.prepared) || 0,
      // A class's own pick (not granted by a feature): Review says "Added to spellbook and prepared" for a Wizard's.
      classSpell: !i.flags?.dnd5e?.advancementOrigin && String(i.system.sourceItem ?? "").startsWith("class:") } : {}) }));

  // Scale values: label from the ScaleValue advancement, value from roll data.
  const scale = {};
  let rollScale = {};
  try { rollScale = actor.getRollData()?.scale ?? {}; } catch { rollScale = {}; }
  for (const item of actor.items) {
    if (!["class", "subclass"].includes(item.type)) continue;
    for (const adv of item.advancement?.byType?.ScaleValue ?? []) {
      const raw = rollScale[item.identifier]?.[adv.identifier];
      const value = raw == null ? "" : String(raw.display ?? raw.formula ?? raw);
      scale[`${item.identifier}.${adv.identifier}`] = { label: adv.title || adv.identifier, value: value === "null" ? "" : value };
    }
  }

  const sizeKey = traits.size ?? "";
  return {
    level: Number(sys.details?.level) || 0,
    classes, hpMax: Number(sys.attributes?.hp?.max) || 0, abilities, saves, skills, profs, items, scale,
    size: { key: sizeKey, label: localize(D.actorSizes?.[sizeKey]?.label) || sizeKey }
  };
}

/** "Fighter 3 (Champion) / Rogue 1" for titles and the change log. */
export function classSummary(snapshot) {
  return Object.values(snapshot.classes ?? {})
    .map(c => `${c.name} ${c.levels}${c.subclass ? ` (${c.subclass})` : ""}`).join(" / ") || `Level ${snapshot.level}`;
}
