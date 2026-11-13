/**
 * Pure: compare two builder snapshots (see snapshot.mjs) and produce the grouped,
 * plain-language "Review changes" list. No Foundry access, so it is unit-tested.
 *
 * @param {object} before  Snapshot of the real actor.
 * @param {object} after   Snapshot of the advanced copy.
 * @param {object} [context]
 * @param {object} [context.hp]       { method: "roll"|"avg"|"max", die, roll, mod } for the HP line.
 * @param {object} [context.spells]   { step, spellbookClass, swaps: [{ out: itemId, in: uuid }], warnings: [{ kind, missing }] } from the spell step.
 * @param {object} [context.stepOf]   Map of line key → step index, so a line can jump back to its step.
 * @param {Array<{ key: string, text: string, step?: number|string }>} [context.notes]  Warnings for a "Check these" group
 *   at the top (picks dnd5e dropped, grants that can't be found, data that looks incomplete, a GM override…).
 * @param {(key: string, fallback: string, data?: object) => string} [context.t]  Localizer.
 * @returns {Array<{ id: string, title: string, lines: Array<{ key: string, text: string, kind: string, step?: number }> }>}
 */
export function reviewChanges(before, after, { hp = null, stepOf = {}, t = defaultT, spells = null, notes = [] } = {}) {
  const groups = [];
  const group = (id, title) => {
    const g = { id, title, lines: [] };
    groups.push(g);
    return g;
  };
  const line = (g, key, text, kind = "change") => {
    const entry = { key, text, kind };
    if (stepOf[key] !== undefined) entry.step = stepOf[key];
    g.lines.push(entry);
  };

  // Warnings first, so they aren't missed.
  const attention = group("attention", t("Review.Attention", "Check these"));
  for (const n of notes) {
    const entry = { key: n.key, text: n.text, kind: "warning" };
    if (n.step !== undefined && n.step !== null) entry.step = n.step;
    attention.lines.push(entry);
  }

  // Level and class
  const lvl = group("level", t("Review.Level", "Level and class"));
  if (before.level !== after.level) line(lvl, "level", t("Review.CharacterLevel", "Character level {from} → {to}", { from: before.level, to: after.level }));
  for (const [id, cls] of Object.entries(after.classes ?? {})) {
    const prior = before.classes?.[id];
    if (!prior) line(lvl, `class:${id}`, t("Review.NewClass", "New class: {name} {levels}", { name: cls.name, levels: cls.levels }), "gain");
    else if (prior.levels !== cls.levels) line(lvl, `class:${id}`, `${cls.name} ${prior.levels} → ${cls.levels}`);
    if (cls.subclass && cls.subclass !== prior?.subclass) line(lvl, `subclass:${id}`, t("Review.Subclass", "Subclass: {name}", { name: cls.subclass }), "gain");
  }
  for (const [id, cls] of Object.entries(before.classes ?? {})) {
    if (!after.classes?.[id]) line(lvl, `class:${id}`, t("Review.RemovedClass", "Removed class: {name}", { name: cls.name }), "loss");
  }

  // Hit points
  const hpGroup = group("hp", t("Review.HitPoints", "Hit points"));
  if (before.hpMax !== after.hpMax) {
    const delta = after.hpMax - before.hpMax;
    let detail = "";
    if (hp) {
      const mod = Number(hp.mod) || 0;
      const modText = mod ? ` ${mod > 0 ? "+" : "−"} ${Math.abs(mod)} ${hp.modLabel ?? "CON"}` : "";
      if (hp.method === "roll") detail = t("Review.HpRolled", "rolled {roll} on a d{die}{mod}", { roll: hp.roll, die: hp.die, mod: modText });
      else if (hp.method === "avg") detail = t("Review.HpAverage", "average {roll}{mod}", { roll: hp.roll, mod: modText });
      else if (hp.method === "max") detail = t("Review.HpMax", "maximum {roll}{mod}", { roll: hp.roll, mod: modText });
      // Fix 14: what else changed max HP this level: a new CON modifier counts on every earlier level too, and features
      // (Draconic Resilience, Dwarven Toughness, Boon of Fortitude…) add their own.
      const extra = hpExtras({ delta, roll: hp.roll, mod, before, after, conKey: hp.conKey ?? "con" });
      if (extra.con) detail += t("Review.HpRetroCon", "; {sign}{n} from the new CON modifier on earlier levels", { sign: extra.con > 0 ? "+" : "−", n: Math.abs(extra.con) });
      if (extra.other) detail += t("Review.HpOther", "; {sign}{n} from other features", { sign: extra.other > 0 ? "+" : "−", n: Math.abs(extra.other) });
    }
    const sign = delta >= 0 ? "+" : "−";
    line(hpGroup, "hp", `${t("Review.MaxHp", "Max HP")} ${before.hpMax} → ${after.hpMax} (${sign}${Math.abs(delta)}${detail ? `, ${detail}` : ""})`, delta >= 0 ? "gain" : "loss");
  }

  // Ability scores
  const abl = group("abilities", t("Review.Abilities", "Ability scores"));
  for (const [key, a] of Object.entries(after.abilities ?? {})) {
    const from = before.abilities?.[key]?.value;
    if (from === undefined || from === a.value) continue;
    // Fix 14: above the usual maximum (an Epic Boon's "to a maximum of 30"), say so: the sheet still shows 20 as the maximum.
    const cap = a.value > 20 && a.value > from ? t("Review.AbilityAboveMax", " (above 20: the feat raises this score's maximum to {max})", { max: 30 }) : "";
    line(abl, `ability:${key}`, `${a.label} ${from} → ${a.value}${cap}`, a.value > from ? "gain" : "loss");
  }

  // Size and proficiencies
  const prof = group("proficiencies", t("Review.Proficiencies", "Size and proficiencies"));
  if (before.size?.key && after.size?.key && before.size.key !== after.size.key) line(prof, "size", t("Review.Size", "Size: {from} → {to}", { from: before.size.label, to: after.size.label }));
  const skillLevel = v => v >= 2 ? t("Review.Expertise", "expertise") : v >= 1 ? t("Review.Proficient", "proficient") : v > 0 ? t("Review.HalfProficient", "half proficiency") : t("Review.NotProficient", "not proficient");
  for (const [key, s] of Object.entries(after.skills ?? {})) {
    const from = before.skills?.[key]?.value ?? 0;
    if (from !== s.value) line(prof, `skill:${key}`, `${s.label}: ${skillLevel(s.value)}`, s.value > from ? "gain" : "loss");
  }
  for (const [key, s] of Object.entries(after.saves ?? {})) {
    const from = Boolean(before.saves?.[key]?.proficient);
    if (from !== Boolean(s.proficient)) line(prof, `save:${key}`, t("Review.Save", "{label} saving throws: {state}", { label: s.label, state: s.proficient ? t("Review.Proficient", "proficient") : t("Review.NotProficient", "not proficient") }), s.proficient ? "gain" : "loss");
  }
  const traitLabels = { languages: t("Review.Languages", "Languages"), armor: t("Review.Armor", "Armor"), weapons: t("Review.Weapons", "Weapons"),
    tools: t("Review.Tools", "Tools"), mastery: t("Review.Mastery", "Weapon mastery") };
  for (const [trait, label] of Object.entries(traitLabels)) {
    const from = new Set(before.profs?.[trait] ?? []);
    const to = new Set(after.profs?.[trait] ?? []);
    const added = [...to].filter(x => !from.has(x));
    const removed = [...from].filter(x => !to.has(x));
    if (added.length) line(prof, `trait:${trait}`, `${label}: + ${added.join(", ")}`, "gain");
    if (removed.length) line(prof, `trait:${trait}:removed`, `${label}: − ${removed.join(", ")}`, "loss");
  }

  // Features, feats and items
  const feat = group("features", t("Review.Features", "Features and items"));
  const beforeIds = new Map((before.items ?? []).map(i => [i.id, i]));
  const afterIds = new Map((after.items ?? []).map(i => [i.id, i]));
  for (const [id, item] of afterIds) {
    if (!beforeIds.has(id) && !["class", "subclass", "spell"].includes(item.type)) line(feat, `item:${id}`, `+ ${item.name}${item.typeLabel ? ` (${item.typeLabel})` : ""}`, "gain");
  }
  for (const [id, item] of beforeIds) {
    if (!afterIds.has(id) && !["class", "subclass", "spell"].includes(item.type)) line(feat, `item:${id}`, `− ${item.name}${item.typeLabel ? ` (${item.typeLabel})` : ""}`, "loss");
  }

  // Spells (Phase 3): one group, linked to the spell step (or the advancement step that granted the spell).
  const sp = group("spells", t("Review.Spells", "Spells"));
  const spellLine = (key, itemId, text, kind) => {
    const entry = { key, text, kind };
    const step = (itemId && stepOf[`item:${itemId}`] !== undefined) ? stepOf[`item:${itemId}`] : spells?.step;
    if (step !== undefined) entry.step = step;
    sp.lines.push(entry);
  };
  const spellsOf = snap => new Map((snap.items ?? []).filter(i => i.type === "spell").map(i => [i.id, i]));
  const beforeSpells = spellsOf(before);
  const afterSpells = spellsOf(after);
  const replacedOut = new Set();
  const replacedIn = new Set();
  // Fix 9: a class pick that a grant now gives always prepared: the class copy is gone and its slot is free.
  for (const freed of spells?.freed ?? []) {
    if (!beforeSpells.has(freed.id)) continue;
    replacedOut.add(freed.id);
    spellLine(`spell:freed:${freed.id}`, null, t("Review.SpellFreed", "{name} is now always prepared: your earlier pick of it is freed for another spell", freed), "change");
  }
  for (const swap of spells?.swaps ?? []) {
    const out = beforeSpells.get(swap.out);
    const incoming = [...afterSpells.values()].find(i => !beforeSpells.has(i.id) && !replacedIn.has(i.id) && i.source === swap.in);
    if (!out || !incoming || afterSpells.has(swap.out)) continue;
    replacedOut.add(out.id);
    replacedIn.add(incoming.id);
    spellLine(`spell:${incoming.id}`, null, t("Review.SpellReplaced", "Replaced {from} → {to}", { from: out.name, to: incoming.name }), "change");
  }
  for (const [id, s] of afterSpells) {
    if (replacedIn.has(id)) continue;
    const prior = beforeSpells.get(id);
    if (prior) {
      if (!prior.prepared && s.prepared === 1) spellLine(`spell:${id}`, id, t("Review.SpellPrepared", "Prepared {name}", s), "gain");
      continue;
    }
    if (s.prepared === 2) spellLine(`spell:${id}`, id, t("Review.SpellAlways", "Always prepared: {name}", s), "gain");
    else if (s.level === 0) spellLine(`spell:${id}`, id, t("Review.SpellCantrip", "Learned cantrip: {name}", s), "gain");
    else if (!s.prepared && spells?.spellbookClass) spellLine(`spell:${id}`, id, t("Review.SpellSpellbook", "Added to spellbook: {name}", s), "gain");
    else if (spells?.spellbookClass && s.classSpell) spellLine(`spell:${id}`, id, t("Review.SpellSpellbookPrepared", "Added to spellbook and prepared: {name}", s), "gain");
    else spellLine(`spell:${id}`, id, t("Review.SpellLearned", "Learned {name}", s), "gain");
  }
  for (const [id, s] of beforeSpells) {
    if (!afterSpells.has(id) && !replacedOut.has(id)) spellLine(`spell:${id}`, null, t("Review.SpellForgot", "Forgot {name}", s), "loss");
  }
  const missingText = ({ kind, missing: n }) => {
    if (kind === "failed") return t("Review.SpellFailed", "Spell picks couldn't be applied. Open the spell step to choose again.");
    if (kind === "cantrips") return n === 1 ? t("Review.SpellMissingCantrip", "Not chosen yet: 1 cantrip") : t("Review.SpellMissingCantrips", "Not chosen yet: {n} cantrips", { n });
    if (kind === "spellbook") return n === 1 ? t("Review.SpellMissingBookOne", "Not chosen yet: 1 spellbook spell") : t("Review.SpellMissingBook", "Not chosen yet: {n} spellbook spells", { n });
    return n === 1 ? t("Review.SpellMissingPreparedOne", "Not chosen yet: 1 prepared spell") : t("Review.SpellMissingPrepared", "Not chosen yet: {n} prepared spells", { n });
  };
  for (const warning of spells?.warnings ?? []) if (warning.missing > 0) spellLine(`spells:missing:${warning.kind}`, null, missingText(warning), "warning");

  // Values that grow with level
  const scale = group("scale", t("Review.Scale", "Values that grow with level"));
  for (const [key, s] of Object.entries(after.scale ?? {})) {
    const from = before.scale?.[key]?.value;
    const to = decodeEntities(s.value);
    if (from === undefined) { if (s.value) line(scale, `scale:${key}`, `${s.label}: ${to}`, "gain"); }
    else if (from !== s.value) line(scale, `scale:${key}`, `${s.label} ${decodeEntities(from) || "—"} → ${to || "—"}`);
  }

  return groups.filter(g => g.lines.length);
}

/** Fix 14: HTML entities dnd5e puts in scale values ("CR &frac14;") as plain characters. */
const ENTITIES = { frac14: "¼", frac12: "½", frac34: "¾", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", ndash: "–", mdash: "—", times: "×", minus: "−" };
export function decodeEntities(text) {
  return String(text ?? "").replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, code) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/**
 * Fix 14: the part of a level's max HP change the HP step doesn't explain. `con`: the new CON modifier on the levels
 * before this one; `other`: the rest (features that add HP per level).
 */
export function hpExtras({ delta, roll, mod, before, after, conKey = "con" }) {
  const modOf = v => Math.floor(((Number(v) || 10) - 10) / 2);
  const modBefore = modOf(before?.abilities?.[conKey]?.value);
  const modAfter = modOf(after?.abilities?.[conKey]?.value);
  const earlier = Math.max(0, Number(before?.level) || 0);
  const con = (modAfter - modBefore) * earlier;
  // The new level itself uses the new modifier; the HP step showed the old one.
  const thisLevel = modAfter - (Number(mod) || 0);
  const other = (Number(delta) || 0) - ((Number(roll) || 0) + (Number(mod) || 0)) - thisLevel - con;
  return { con: con + thisLevel, other };
}

/** Count the lines of a review, for the summary badge and the chat card. */
export function countChanges(groups) {
  return groups.reduce((n, g) => n + g.lines.length, 0);
}

function defaultT(_key, fallback, data = {}) {
  return String(fallback).replace(/\{(\w+)\}/g, (m, k) => (data[k] !== undefined ? String(data[k]) : m));
}

/**
 * The HP line's detail from what a HitPoints answer applies (data.value: "avg", "max" or the rolled number), with the die
 * from the replayed step; only the modifier's text comes from the screen's notes (meta.hp). Phase 4b: the GM sees what is
 * saved, whatever the notes say.
 */
export function hpFromAnswer(answer, die) {
  const value = answer?.data?.value;
  const notes = answer?.meta?.hp ?? {};
  const d = Number(die) || Number(notes.die) || 0;
  const base = { die: d, mod: notes.mod, modLabel: notes.modLabel };
  if (value === "avg") return { method: "avg", roll: Math.floor(d / 2) + 1, ...base };
  if (value === "max") return { method: "max", roll: d, ...base };
  if (typeof value === "number" && Number.isFinite(value)) return { method: "roll", roll: value, ...base };
  return null;
}
