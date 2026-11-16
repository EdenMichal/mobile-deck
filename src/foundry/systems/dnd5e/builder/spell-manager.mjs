/**
 * Player feedback (fork): Manage spells. From the sheet's Spells tab a player can change a class's own spell picks after
 * the fact: add spells from the class's spell list (up to the highest level the class can cast) and remove the class's
 * own picks. No GM approval: it works on the real actor, like the sheet's own Prepare toggle.
 *
 * Spells an advancement or a builder feature step gave (domain spells, Magic Initiate, Circle of the Land, always
 * prepared) are shown as fixed and can't be removed here: they belong to the feature that granted them.
 * The class's limits (cantrips known, prepared spells, Wizard spellbook) are shown as counters; going over warns, it
 * doesn't block, so a GM's ruling or a homebrew feature is never stuck.
 */
import { castingState, spellFacts } from "./spell-step.mjs";
import { FIXED_CANTRIPS, rulesFor, spellListKeys } from "./spell-rules.mjs";
import { spellsForList } from "./content-sources.mjs";
import { isBuilderGrant } from "./feature-spells.mjs";
import { spellDetails } from "./spell-details.mjs";

const PREPARED = 1;

const casts = cls => Boolean(cls?.spellcasting?.progression) && cls.spellcasting.progression !== "none";

/** "The same spell": its identifier, else its slugified name. */
function spellKey(system, name) {
  if (system?.identifier) return String(system.identifier);
  const text = String(name ?? "");
  return typeof text.slugify === "function" ? text.slugify({ strict: true }) : text.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** A spell a feature gave (advancement, builder grant, always prepared): not the class's own pick. */
export function isGrantedSpell(item) {
  return Boolean(item?.getFlag?.("dnd5e", "advancementOrigin") || item?.flags?.dnd5e?.advancementOrigin)
    || isBuilderGrant(item) || Number(item?.system?.prepared) === 2;
}

/** The casting classes the manager offers, in the sheet's order. */
export function castingClasses(actor) {
  return Object.values(actor?.classes ?? {}).filter(cls => {
    if (!casts(cls)) return false;
    const state = castingState(actor, cls.identifier);
    return state.cantrips > 0 || state.maxPrepared > 0;
  });
}

/** Which of the actor's spells belong to this class: linked to it, or unlinked when it is the only caster. */
function classSpells(actor, identifier, type) {
  const onlyCaster = castingClasses(actor).length === 1;
  return actor.items.filter(i => i.type === "spell" && (i.system.classIdentifier === identifier
    || (onlyCaster && !i.system.classIdentifier && !i.system.sourceItem && (i.system.method ?? "spell") === (type || "spell"))));
}

export function createSpellManager(actor) {
  const pools = new Map();

  const classRecord = cls => {
    const identifier = cls.identifier;
    const state = castingState(actor, identifier);
    const subclass = cls.subclass?.identifier ?? "";
    const rules = rulesFor(identifier, subclass);
    const fixedKeys = new Set(FIXED_CANTRIPS[subclass] ?? []);
    const spells = classSpells(actor, identifier, state.type).map(item => ({
      id: item.id, uuid: item._stats?.compendiumSource ?? "", ...spellFacts(item.name, item.img, item.system),
      prepared: Number(item.system.prepared) || 0,
      fixed: isGrantedSpell(item) || (!(Number(item.system.level) || 0) && fixedKeys.has(spellKey(item.system, item.name)))
    })).sort((a, b) => a.level - b.level || a.name.localeCompare(b.name));
    const own = spells.filter(s => !s.fixed);
    return {
      identifier, name: cls.name, img: cls.img, subclass: cls.subclass?.name ?? "",
      spellbook: Boolean(rules.spellbook),
      maxSpellLevel: state.maxSpellLevel,
      counts: {
        cantrips: { have: own.filter(s => !s.level).length, max: state.cantrips },
        prepared: { have: own.filter(s => s.level > 0 && (!rules.spellbook || s.prepared === PREPARED)).length, max: state.maxPrepared },
        spellbook: rules.spellbook ? own.filter(s => s.level > 0).length : 0
      },
      spells
    };
  };

  const findClass = identifier => {
    const cls = castingClasses(actor).find(c => c.identifier === identifier);
    if (!cls) throw new Error("That class can't cast spells.");
    return cls;
  };

  return {
    actorName: actor.name,
    /** Every casting class with its spells and counters. */
    classes: () => castingClasses(actor).map(classRecord),
    /** Spells from the class's list(s) that the character doesn't have yet, up to the highest castable level. */
    async options(identifier) {
      const cls = findClass(identifier);
      const state = castingState(actor, identifier);
      const lists = spellListKeys({ identifier, subclass: cls.subclass?.identifier ?? "", levels: cls.system.levels });
      const cacheKey = `${identifier}|${state.maxSpellLevel}|${lists.join(",")}`;
      let pool = pools.get(cacheKey);
      if (!pool) {
        const byUuid = new Map();
        let noList = true;
        for (const key of lists) {
          const result = await spellsForList(key, { maxLevel: state.maxSpellLevel, strict: lists.length > 1 });
          noList &&= result.noList;
          for (const s of result.spells) if (!byUuid.has(s.uuid)) byUuid.set(s.uuid, s);
        }
        pool = { spells: [...byUuid.values()].sort((x, y) => (Number(x.system?.level) || 0) - (Number(y.system?.level) || 0) || x.name.localeCompare(y.name)), noList };
        pools.set(cacheKey, pool);
      }
      const owned = actor.items.filter(i => i.type === "spell");
      const haveKeys = new Set(owned.map(i => spellKey(i.system, i.name)));
      const haveSources = new Set(owned.map(i => i._stats?.compendiumSource).filter(Boolean));
      const packBook = pack => globalThis.game?.packs?.get(pack)?.metadata?.flags?.dnd5e?.sourceBook ?? "";
      return {
        noList: pool.noList,
        options: pool.spells.filter(s => !haveKeys.has(spellKey(s.system, s.name)) && !haveSources.has(s.uuid)).map(s => ({
          uuid: s.uuid, source: s.packLabel, tier: s.tier ?? null, ...spellFacts(s.name, s.img, s.system),
          book: s.system?.source?.custom || s.system?.source?.book || packBook(s.pack)
        }))
      };
    },
    /** Add one spell from the class's list. Prepared, unless a spellbook class (Wizard) already has its prepared count. */
    async add(identifier, uuid) {
      const cls = findClass(identifier);
      const state = castingState(actor, identifier);
      const { options } = await this.options(identifier);
      if (!options.some(o => o.uuid === uuid)) throw new Error("That spell isn't on this class's list, or the character already has it.");
      const doc = await globalThis.fromUuid(uuid);
      if (!doc) throw new Error("That spell couldn't be loaded.");
      const record = classRecord(cls);
      const level = Number(doc.system?.level) || 0;
      const itemData = globalThis.game.items.fromCompendium(doc);
      itemData.system.sourceItem = `class:${identifier}`;
      itemData.system.method = state.type || "spell";
      itemData.system.prepared = level && record.spellbook && record.counts.prepared.have >= record.counts.prepared.max ? 0 : PREPARED;
      const [created] = await actor.createEmbeddedDocuments("Item", [itemData]);
      return { id: created?.id ?? "", name: doc.name };
    },
    /** Remove one of the class's own picks (not a spell a feature gave). */
    async remove(identifier, itemId) {
      findClass(identifier);
      const record = classRecord(findClass(identifier));
      const spell = record.spells.find(s => s.id === itemId);
      if (!spell) throw new Error("That spell is no longer on this character.");
      if (spell.fixed) throw new Error("A feature gives this spell, so it can't be removed here.");
      await actor.deleteEmbeddedDocuments("Item", [itemId]);
      return { name: spell.name };
    },
    spellDetails: uuid => spellDetails(uuid)
  };
}
