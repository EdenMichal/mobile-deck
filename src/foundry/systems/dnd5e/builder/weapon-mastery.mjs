/**
 * Player feedback (fork): Weapon Mastery on the sheet. Reads what a character may know (mastery-rules.mjs), lists the
 * weapons (proficient ones first), and saves the picks to dnd5e's own field (system.traits.weaponProf.mastery.value).
 * A Long Rest (dnd5e.restCompleted) leaves a one-swap token on the actor (flags.<module>.masterySwap), spent on the
 * first save that drops a mastery.
 */
import { MODULE_ID } from "../../../preferences.mjs";
import { checkMasteryChange, isProficient, masteryAllowance } from "./mastery-rules.mjs";

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

/** The sheet card's record (sync), or null when the character has no masteries to know. */
export function masterySummary(actor) {
  if (actor?.type !== "character") return null;
  const { total } = allowanceOf(actor);
  const chosen = chosenOf(actor);
  if (!total && !chosen.length) return null;
  return { allowance: total, chosen: chosen.map(key => ({ key, label: weaponLabel(key) })).sort((a, b) => a.label.localeCompare(b.label)),
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
      const categories = await Trait.categories("weapon");
      const proficiencies = new Set(actor.system?.traits?.weaponProf?.value ?? []);
      const chosen = new Set(chosenOf(actor));
      const out = [];
      for (const [category, data] of Object.entries(categories)) {
        const children = data.children ? Object.entries(data.children) : [[category, data]];
        for (const [key, child] of children) {
          let mastery = "";
          try {
            const index = Trait.getBaseItem?.(globalThis.CONFIG.DND5E.weaponIds?.[key], { indexOnly: true });
            const value = index?.system?.mastery;
            mastery = value ? (globalThis.CONFIG.DND5E.weaponMasteries?.[value]?.label ?? value) : "";
          } catch { mastery = ""; }
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
      if (!allowanceOf(actor).total || swapOf(actor)) return;
      void actor.setFlag(MODULE_ID, MASTERY_SWAP_FLAG, true).catch(error => console.warn(`${MODULE_ID} | mastery swap flag`, error));
    } catch (error) { console.warn(`${MODULE_ID} | mastery rest hook`, error); }
  });
}
