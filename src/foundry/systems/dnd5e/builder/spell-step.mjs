/**
 * Character Builder Phase 3: the spell step that follows dnd5e's advancement steps. It appears only when a level
 * changes something spell-related (cantrips, prepared spells, Wizard spellbook additions, an allowed swap).
 * Limits come from the advanced copy (dnd5e's own preparation.max and the class's
 * cantrips-known scale value). Picks are applied to the copy, so Review and Commit see them.
 */
import { FIXED_CANTRIPS, maxSpellLevel, owedSpells, sanitizeSpellAnswer, spellListKeys, spellWarnings, swapsOnRest, tableCounts } from "./spell-rules.mjs";
import { spellsForList } from "./content-sources.mjs";
import { isBuilderGrant } from "./feature-spells.mjs";
import { rootTab } from "./trait-options.mjs";

const PREPARED = 1;

const tr = (key, fallback) => {
  const i18n = globalThis.game?.i18n;
  const full = `VEMOBILE.Builder.${key}`;
  return i18n?.has?.(full) ? i18n.localize(full) : fallback;
};

/** Match key for "the same spell": its identifier, else its slugified name (index entries may lack an identifier). */
function spellKey(system, name) {
  if (system?.identifier) return String(system.identifier);
  const text = String(name ?? "");
  return typeof text.slugify === "function" ? text.slugify({ strict: true }) : text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Display facts for a spell from index data (properties: array) or a document (properties: Set). */
export function spellFacts(name, img, system = {}) {
  const props = new Set(system.properties ?? []);
  const school = globalThis.CONFIG?.DND5E?.spellSchools?.[system.school];
  return {
    name, img, level: Number(system.level) || 0, school: system.school ?? "", schoolLabel: school?.label ?? system.school ?? "",
    components: [["vocal", "V"], ["somatic", "S"], ["material", "M"]].filter(([key]) => props.has(key)).map(([, abbr]) => abbr).join(", "),
    ritual: props.has("ritual"), concentration: props.has("concentration"), book: system.source?.book ?? ""
  };
}

/** The class whose levels grew on the copy, with its levels before this level-up. */
function levelledClass(manager, actor) {
  for (const cls of Object.values(manager.clone.classes ?? {})) {
    const before = Number(actor.classes?.[cls.identifier]?.system.levels) || 0;
    if ((Number(cls.system.levels) || 0) > before) return { cls, levelsBefore: before };
  }
  return null;
}

const casts = cls => Boolean(cls?.spellcasting?.progression) && cls.spellcasting.progression !== "none";

/**
 * Spellcasting limits of one class on an actor (the real actor or the copy). A class whose data has no count (no
 * "cantrips-known" scale, no prepared formula: DDB imports of the Eldritch Knight and Arcane Trickster) uses the 2024
 * table (spell-rules.mjs tableCounts); `fallback` says which counts came from it.
 */
export function castingState(actorDoc, identifier) {
  const none = { cantrips: 0, maxPrepared: 0, preparedValue: 0, maxSpellLevel: 0, type: "", fallback: { cantrips: false, prepared: false } };
  const cls = actorDoc.classes?.[identifier];
  const casting = cls?.spellcasting; // dnd5e: a subclass with its own progression replaces the class's casting
  if (!cls || !casts(cls)) return none;
  const sub = cls.subclass;
  const subCasts = Boolean(sub?.system.spellcasting?.progression) && sub.system.spellcasting.progression !== "none";
  const prep = (subCasts ? sub : cls).system.spellcasting?.preparation ?? {};
  let scale = {};
  try { scale = actorDoc.getRollData()?.scale ?? {}; } catch { scale = {}; }
  const raw = scale[identifier]?.["cantrips-known"] ?? (sub ? scale[sub.identifier]?.["cantrips-known"] : undefined);
  const config = globalThis.CONFIG.DND5E.spellcasting?.[casting.type];
  const levels = Number(cls.system.levels) || 0;
  const table = tableCounts(identifier, sub?.identifier ?? "", levels);
  const hasCantripScale = raw !== undefined && raw !== null;
  const hasPrepared = Boolean(String(prep.formula ?? "").trim()) || (Number(prep.max) || 0) > 0;
  return {
    cantrips: hasCantripScale ? Number(raw?.value ?? raw) || 0 : table?.cantrips ?? 0,
    maxPrepared: hasPrepared ? Number(prep.max) || 0 : table?.prepared ?? 0,
    preparedValue: Number(prep.value) || 0,
    maxSpellLevel: maxSpellLevel({ type: casting.type, progression: casting.progression, levels },
      config?.progression?.[casting.progression] ?? null, config?.table),
    type: casting.type,
    fallback: { cantrips: !hasCantripScale && Boolean(table?.cantrips), prepared: !hasPrepared && Boolean(table?.prepared) }
  };
}

/** Index entry → match keys (uuid, identifier, slug of the name). */
const keysOf = item => [item._stats?.compendiumSource, spellKey(item.system, item.name)].filter(Boolean);

/**
 * Fix 9: a pick of the levelled class that a grant (domain, oath, patron, circle spells…) now gives as always prepared.
 * The class copy is removed from the copy, so its prepared slot is free again in this step. Another class's pick of the
 * same spell (a multiclass) is left alone: that class can only re-pick on its own level or a Long Rest, and casting the
 * spell as either class stays legal, so it is named in Review instead (`shared`).
 */
function freeGrantedDuplicates(clone, actor, levelled) {
  const spells = clone.items.filter(i => i.type === "spell");
  const always = spells.filter(i => Number(i.system.prepared) === 2 && (i.getFlag("dnd5e", "advancementOrigin") || isBuilderGrant(i)));
  const freed = [];
  const shared = [];
  for (const spell of spells) {
    if (spell.getFlag("dnd5e", "advancementOrigin") || isBuilderGrant(spell) || Number(spell.system.prepared) === 2) continue;
    if (!spell.system.level || !spell.system.classIdentifier) continue;
    // Only a pick the real actor already had: one made in this very step is never on the copy before it applies.
    if (!actor.items.get(spell.id)) continue;
    // Only against a grant new on this level (an older duplicate was handled when it arrived).
    const keys = keysOf(spell);
    if (!always.some(g => !actor.items.get(g.id) && keysOf(g).some(k => keys.includes(k)))) continue;
    if (spell.system.classIdentifier !== levelled) {
      shared.push({ id: spell.id, name: spell.name, cls: actor.classes?.[spell.system.classIdentifier]?.name ?? spell.system.classIdentifier });
      continue;
    }
    clone.items.delete(spell.id);
    freed.push({ id: spell.id, name: spell.name });
  }
  return { freed, shared };
}

/** extraSteps hook for createLevelUpSession: zero or one Spells step for the class being levelled. */
export async function spellSteps(manager, actor) {
  const found = levelledClass(manager, actor);
  if (!found) return [];
  const { cls, levelsBefore } = found;
  const id = cls.identifier;
  const clone = manager.clone;
  // Fix 9: an earlier class pick that a grant of this level now makes always prepared gives its slot back.
  const { freed, shared } = freeGrantedDuplicates(clone, actor, cls.identifier);
  if (freed.length) clone.reset();
  const after = castingState(clone, id);
  if (!after.cantrips && !after.maxPrepared) return [];
  const before = levelsBefore ? castingState(actor, id) : { maxPrepared: 0 };
  const subclass = cls.subclass?.identifier ?? "";
  // The class's own picks. Spells granted by advancements (always prepared, Magic Initiate…) or by the builder's own
  // feature steps (Circle of the Land, Magical Discoveries, feat spells) don't count.
  // Older or imported spells with no class link count for the class when it is the only caster
  // (dnd5e can't count those as prepared, so they are added to its prepared value here).
  const onlyCaster = Object.values(clone.classes ?? {}).filter(casts).length === 1;
  const unlinked = i => onlyCaster && !i.system.sourceItem && i.system.method === (after.type || "spell");
  const own = clone.items.filter(i => i.type === "spell" && !i.getFlag("dnd5e", "advancementOrigin") && !isBuilderGrant(i)
    && Number(i.system.prepared) !== 2 && (i.system.classIdentifier === id || unlinked(i)));
  const unlinkedPrepared = own.filter(i => unlinked(i) && i.system.level > 0 && i.system.prepared === PREPARED).length;
  // A subclass caster's fixed cantrip (2024 Arcane Trickster: Mage Hand), added by this step when missing.
  const ownKeys = new Set(own.flatMap(keysOf));
  const fixedCantrips = after.cantrips ? (FIXED_CANTRIPS[subclass] ?? []).filter(key => !ownKeys.has(key)) : [];
  const owed = owedSpells({ identifier: id, subclass, levelsBefore, levelsAfter: Number(cls.system.levels) || 0,
    before, after, current: { cantrips: own.filter(s => !s.system.level).length + fixedCantrips.length,
      prepared: after.preparedValue + unlinkedPrepared, leveled: own.filter(s => s.system.level > 0).length } });
  if (!owed.hasStep && !fixedCantrips.length && !freed.length && !shared.length) return [];

  const lists = spellListKeys({ identifier: id, subclass, levels: cls.system.levels });
  // Spells the player may swap out or prepare: this class's own, cast the class's way, within its levels.
  // A fixed cantrip (the Arcane Trickster's Mage Hand) can't be swapped out, so it isn't offered for a swap.
  const fixedKeys = new Set(FIXED_CANTRIPS[subclass] ?? []);
  const known = new Map(own.filter(s => s.system.method === (after.type || "spell") && s.system.level <= owed.maxSpellLevel
    && !(s.system.level === 0 && keysOf(s).some(k => fixedKeys.has(k))))
    .map(s => [s.id, { id: s.id, uuid: s._stats?.compendiumSource ?? "", prepared: Number(s.system.prepared) || 0, ...spellFacts(s.name, s.img, s.system) }]));
  const spellItems = clone.items.filter(i => i.type === "spell");
  const haveKeys = new Set(spellItems.map(i => spellKey(i.system, i.name)));
  const haveSources = new Set(spellItems.map(i => i._stats?.compendiumSource).filter(Boolean));
  let pool = null;
  // Cache only a successful load, so Retry can try again. Several lists (Magical Secrets): their union, once each.
  const loadPool = async () => {
    if (pool) return pool;
    const byUuid = new Map();
    let noList = true;
    for (const key of lists) {
      const result = await spellsForList(key, { maxLevel: owed.maxSpellLevel, strict: lists.length > 1 });
      noList &&= result.noList;
      for (const s of result.spells) if (!byUuid.has(s.uuid)) byUuid.set(s.uuid, s);
    }
    const all = [...byUuid.values()].sort((x, y) => x.name.localeCompare(y.name));
    const fixed = fixedCantrips.map(key => all.find(s => spellKey(s.system, s.name) === key && !(Number(s.system?.level) || 0))).filter(Boolean);
    pool = { spells: all.filter(s => !haveKeys.has(spellKey(s.system, s.name)) && !haveSources.has(s.uuid) && !fixed.includes(s)), noList, fixed };
    return pool;
  };

  /**
   * Fix 7 (creation): saved picks the character now has from elsewhere (Magic Initiate picked the same spell on the
   * Background tab). They are no longer offered, so the step would drop them silently; they are named as conflicts
   * instead ({ tab, label }: the tab that gives the spell), which flags the Spells tab and blocks Create.
   */
  const conflictsOf = answer => {
    const picked = [...(answer?.cantrips ?? []), ...(answer?.spells ?? []), ...(answer?.swaps ?? []).map(s => s?.in)].filter(Boolean);
    const out = [];
    for (const uuid of new Set(picked)) {
      let entry = null;
      try { entry = globalThis.fromUuidSync?.(uuid, { strict: false }); } catch { entry = null; }
      const key = entry ? spellKey(entry.system, entry.name) : null;
      if (!haveSources.has(uuid) && !(key && haveKeys.has(key))) continue;
      const holder = spellItems.find(i => i._stats?.compendiumSource === uuid || (key && spellKey(i.system, i.name) === key));
      out.push({ key: uuid, label: entry?.name ?? holder?.name ?? uuid, tab: holder ? rootTab(clone, holder).tab : "" });
    }
    return out;
  };

  const step = {
    key: `spells|${id}|${cls.system.levels}`,
    type: "Spells",
    title: tr("Spells.Title", "Spells"),
    item: cls.name,
    level: Number(cls.system.levels) || 0,
    owed,
    /** Review warnings for what was actually applied (set by apply on every replay). */
    warnings: [],
    /** Class picks a grant of this level made always prepared (removed, so their slots are free). */
    freed,
    /** Another class's picks a grant of this level also gives (a multiclass): named in Review. */
    shared,
    /** Saved picks the character now has from elsewhere (set by apply). */
    conflicts: [],
    async model(answer = null) {
      const conflicts = conflictsOf(answer);
      const base = { className: cls.name, classIdentifier: id, owed, known: [...known.values()], conflicts,
        // Fix 14: classes that change prepared spells on a Long Rest only (the screen says so), and the lists offered.
        restSwap: swapsOnRest(id), lists, freed: freed.map(f => f.name), fallback: after.fallback };
      try {
        const { spells, noList, fixed } = await loadPool();
        // Source text as dnd5e labels it: custom, then book, then the pack's sourceBook flag ("SRD 5.2").
        const packBook = pack => globalThis.game.packs.get(pack)?.metadata?.flags?.dnd5e?.sourceBook ?? "";
        return { ...base, noList, loadError: "", fixed: fixed.map(f => ({ uuid: f.uuid, ...spellFacts(f.name, f.img, f.system) })), options: spells.map(s => ({ uuid: s.uuid, source: s.packLabel, tier: s.tier ?? null, ...spellFacts(s.name, s.img, s.system),
          book: s.system?.source?.custom || s.system?.source?.book || packBook(s.pack) })) };
      } catch (error) {
        return { ...base, noList: false, options: [], loadError: error?.message ?? String(error) };
      }
    },
    async apply(data) {
      let spells;
      let fixed = [];
      try { ({ spells, fixed } = await loadPool()); }
      catch (error) {
        console.warn("Character Builder | spell list unavailable; spell picks were not applied", error);
        step.warnings = [{ kind: "failed", missing: 1 }];
        return;
      }
      const options = new Map(spells.map(s => [s.uuid, { level: Number(s.system?.level) || 0 }]));
      step.conflicts = conflictsOf(data);
      const clean = sanitizeSpellAnswer(data, owed, { options, known });
      const applied = { cantrips: [], spells: [], prepare: [], swaps: [] };
      // One pick at a time: a spell that can't load or validate is skipped, not fatal.
      const create = async (uuid, prepared) => {
        try {
          const doc = await globalThis.fromUuid(uuid);
          if (!doc) return false;
          const itemData = globalThis.game.items.fromCompendium(doc);
          itemData._id = globalThis.foundry.utils.randomID();
          itemData.system.sourceItem = `class:${id}`;
          itemData.system.method = after.type || "spell";
          itemData.system.prepared = prepared;
          clone.updateSource({ items: [itemData] });
          return true;
        } catch (error) {
          console.warn(`Character Builder | could not add spell ${uuid}`, error);
          return false;
        }
      };
      for (const f of fixed) await create(f.uuid, PREPARED);
      for (const uuid of clean.cantrips) if (await create(uuid, PREPARED)) applied.cantrips.push(uuid);
      for (const uuid of clean.spells) {
        if (await create(uuid, !owed.spellbookClass || clean.prepare.includes(uuid) ? PREPARED : 0)) applied.spells.push(uuid);
      }
      applied.prepare = clean.prepare.filter(ref => ref.startsWith("item:") || applied.spells.includes(ref));
      const fromBook = applied.prepare.filter(ref => ref.startsWith("item:")).map(ref => ({ _id: ref.slice(5), system: { prepared: PREPARED } }));
      if (fromBook.length) clone.updateSource({ items: fromBook });
      // Add the replacement first; forget the old spell only if the new one arrived.
      for (const swap of clean.swaps) {
        if (!(await create(swap.in, PREPARED))) continue;
        clone.items.delete(swap.out);
        applied.swaps.push(swap);
      }
      const dropped = clean.cantrips.length + clean.spells.length + clean.swaps.length
        - applied.cantrips.length - applied.spells.length - applied.swaps.length;
      // A list with fewer spells left than owed (a Thaumaturge Cleric who knows every Cleric cantrip) owes only what it
      // can still offer, so Review doesn't warn at every level about picks that can't be made.
      const offered = { cantrips: spells.filter(sp => !(Number(sp.system?.level) || 0)).length, leveled: spells.filter(sp => (Number(sp.system?.level) || 0) > 0).length };
      const possible = { ...owed, cantrips: Math.min(owed.cantrips, offered.cantrips),
        ...(owed.spellbookClass ? { spellbook: Math.min(owed.spellbook, offered.leveled) } : { prepared: Math.min(owed.prepared, offered.leveled) }) };
      step.warnings = [...spellWarnings(possible, applied), ...(dropped ? [{ kind: "failed", missing: dropped }] : [])];
      step.freed = freed;
    }
  };
  return [step];
}
