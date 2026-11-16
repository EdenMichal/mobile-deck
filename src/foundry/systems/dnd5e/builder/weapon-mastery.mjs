/**
 * Player feedback (fork): Weapon Mastery on the sheet. Reads what a character may know (mastery-rules.mjs), lists the
 * weapons (proficient ones first), and saves the picks to dnd5e's own field (system.traits.weaponProf.mastery.value).
 * A Long Rest (dnd5e.restCompleted) leaves a one-swap token on the actor (flags.<module>.masterySwap, the rest's time),
 * spent on the first save that drops a mastery. The owner's client then offers the swap right away (registerMasteryPrompt).
 */
import { MODULE_ID } from "../../../preferences.mjs";
import { checkMasteryChange, isProficient, masteryAllowance, shouldAskSwap } from "./mastery-rules.mjs";

export const MASTERY_SWAP_FLAG = "masterySwap";

const rulesOf = item => {
  const rules = String(item?.system?.source?.rules ?? "");
  if (rules) return rules;
  if (item?.flags?.ddbimporter?.is2024) return "2024";
  return "";
};

/** Masteries a class's data gives up to its level (dnd5e Trait steps in "mastery" mode), or null when it has none. */
function dataCount(cls) {
  const levels = Number(cls.system?.levels) || 0;
  const advs = [...Object.values(cls.advancement?.byId ?? {}), ...Object.values(cls.subclass?.advancement?.byId ?? {})]
    .filter(a => a.constructor?.typeName === "Trait" && a.configuration?.mode === "mastery");
  if (!advs.length) return null;
  return advs.filter(a => (Number(a.level) || 0) <= levels).reduce((sum, a) => sum + (a.configuration.grants?.size ?? 0)
    + (a.configuration.choices ?? []).reduce((n, c) => n + (Number(c.count) || 0), 0), 0);
}

export function allowanceOf(actor) {
  const hasFeature = actor.items.some(i => i.type === "feat" && /^weapon[- ]mastery$/i.test(String(i.system?.identifier || i.name).trim()));
  return masteryAllowance(Object.values(actor.classes ?? {}).map(cls => ({
    identifier: cls.identifier, levels: Number(cls.system?.levels) || 0, dataCount: dataCount(cls), is2024: rulesOf(cls) === "2024"
  })), { hasFeature });
}

const chosenOf = actor => [...(actor.system?.traits?.weaponProf?.mastery?.value ?? [])];
const swapOf = actor => Boolean(actor.getFlag?.(MODULE_ID, MASTERY_SWAP_FLAG));

function weaponLabel(key) {
  try { return globalThis.dnd5e.documents.Trait.keyLabel(`weapon:${key}`); } catch { return key; }
}

/**
 * Compendium indexes leave out a weapon's mastery (dnd5e indexes only system.container and system.identifier), so the
 * card and the picker would show none. Foundry builds every index at startup from compendiumIndexFields: call at init.
 */
export function addMasteryIndexField(config = globalThis.CONFIG) {
  const fields = config?.Item?.compendiumIndexFields;
  if (Array.isArray(fields) && !fields.includes("system.mastery")) fields.push("system.mastery");
}

let indexLoad = null;
/**
 * Build the indexes of the packs that hold dnd5e's base weapons (with system.mastery, addMasteryIndexField). Foundry
 * builds a pack's index only on first use. Once per page; resolves true when an index was built.
 */
export function loadMasteryIndex(game = globalThis.game, config = globalThis.CONFIG) {
  indexLoad ??= (async () => {
    const collections = new Set(Object.values(config?.DND5E?.weaponIds ?? {})
      .map(uuid => String(uuid).split(".")).filter(parts => parts[0] === "Compendium" && parts.length >= 5).map(parts => `${parts[1]}.${parts[2]}`));
    let loaded = false;
    for (const collection of collections) {
      const pack = game?.packs?.get(collection);
      if (!pack) continue;
      try { await pack.getIndex(); loaded = true; }
      catch (error) { console.warn(`${MODULE_ID} | weapon index ${collection}`, error); }
    }
    return loaded;
  })();
  return indexLoad;
}

/** The mastery property of a base weapon ("Sap", "Vex"), or "" when its base item isn't indexed. */
function masteryOf(key) {
  try {
    const index = globalThis.dnd5e.documents.Trait.getBaseItem?.(globalThis.CONFIG.DND5E.weaponIds?.[key], { indexOnly: true });
    const value = index?.system?.mastery;
    return value ? String(globalThis.CONFIG.DND5E.weaponMasteries?.[value]?.label ?? value) : "";
  } catch { return ""; }
}

/** The sheet card's record (sync), or null when the character has no masteries to know. */
export function masterySummary(actor) {
  if (actor?.type !== "character") return null;
  const { total } = allowanceOf(actor);
  const chosen = chosenOf(actor);
  if (!total && !chosen.length) return null;
  return { allowance: total, chosen: chosen.map(key => ({ key, label: weaponLabel(key), mastery: masteryOf(key) })).sort((a, b) => a.label.localeCompare(b.label)),
    free: Math.max(0, total - chosen.length), swap: swapOf(actor) };
}

export function createMasteryManager(actor) {
  const isGM = Boolean(globalThis.game?.user?.isGM);
  return {
    actorName: actor.name,
    isGM,
    summary: () => masterySummary(actor),
    /** Every base weapon, proficient ones first: [{ key, label, category, categoryLabel, mastery, proficient, chosen }]. */
    async options() {
      const Trait = globalThis.dnd5e.documents.Trait;
      await loadMasteryIndex().catch(() => false);
      const categories = await Trait.categories("weapon");
      const proficiencies = new Set(actor.system?.traits?.weaponProf?.value ?? []);
      const chosen = new Set(chosenOf(actor));
      const out = [];
      for (const [category, data] of Object.entries(categories)) {
        const children = data.children ? Object.entries(data.children) : [[category, data]];
        for (const [key, child] of children) {
          const mastery = masteryOf(key);
          out.push({ key, label: String(child.label ?? key), category: data.children ? category : "", categoryLabel: data.children ? String(data.label ?? category) : "",
            mastery, proficient: isProficient(proficiencies, key, data.children ? category : ""), chosen: chosen.has(key) });
        }
      }
      return out.sort((a, b) => Number(b.proficient) - Number(a.proficient) || a.label.localeCompare(b.label));
    },
    /** Save the new picks; refused when the rules don't allow the change (a GM may set anything). */
    async save(keys) {
      const options = await this.options();
      const known = new Set(options.map(o => o.key));
      const after = [...new Set(keys)].filter(k => known.has(k));
      const check = checkMasteryChange({ before: chosenOf(actor), after, allowance: allowanceOf(actor).total, swap: swapOf(actor),
        proficient: new Set(options.filter(o => o.proficient).map(o => o.key)), isGM });
      if (!check.ok) throw Object.assign(new Error(check.reason), { masteryReason: check.reason });
      const update = { "system.traits.weaponProf.mastery.value": after };
      if (check.usedSwap) update[`flags.${MODULE_ID}.${MASTERY_SWAP_FLAG}`] = false;
      await actor.update(update);
      return check;
    }
  };
}

/** After a Long Rest, a character with masteries may change one. Runs on the client that took the rest. */
export function registerMasteryRestHook(hooks = globalThis.Hooks) {
  hooks?.on?.("dnd5e.restCompleted", (actor, result) => {
    try {
      if (!(result?.longRest || result?.type === "long") || actor?.type !== "character" || !actor.isOwner) return;
      if (!allowanceOf(actor).total) return;
      // The rest's time, not just true: a swap still unused from an earlier rest changes too, so the owner is asked again.
      void actor.setFlag(MODULE_ID, MASTERY_SWAP_FLAG, Date.now()).catch(error => console.warn(`${MODULE_ID} | mastery swap flag`, error));
    } catch (error) { console.warn(`${MODULE_ID} | mastery rest hook`, error); }
  });
}

/**
 * Offer the Long Rest swap on the client that should be asked (shouldAskSwap): `onSwapReady(actor)` opens the picker.
 * Follows the flag rather than the rest, so a player is asked on their phone when the GM's client took the rest.
 */
export function registerMasteryPrompt({ hooks = globalThis.Hooks, onSwapReady } = {}) {
  hooks?.on?.("updateActor", (actor, changes, _options, userId) => {
    try {
      const value = changes?.flags?.[MODULE_ID]?.[MASTERY_SWAP_FLAG];
      if (!value || actor?.type !== "character" || !masterySummary(actor)?.swap) return;
      const game = globalThis.game;
      const playerOwnerActive = game.users.some(u => u.active && !u.isGM && actor.testUserPermission(u, "OWNER"));
      if (!shouldAskSwap({ isGM: Boolean(game.user.isGM), isOwner: Boolean(actor.isOwner), playerOwnerActive, byThisUser: userId === game.user.id })) return;
      onSwapReady?.(actor);
    } catch (error) { console.warn(`${MODULE_ID} | mastery prompt`, error); }
  });
}
