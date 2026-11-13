// End-to-end test of the level 1 → 20 fixes (L20 campaign), engine level, SRD-pinned, as Claude Test GM.
// Builds throwaway characters through the builder controller (creation controller for the creation checks) and
// asserts the fixed behaviours. Every actor it makes is deleted; chat messages, the user's builder flag and the
// house rules are restored.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/l20.e2e.mjs
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const { browser, page } = await joinTestWorld();
await pinToSrd(page);
page.setDefaultTimeout(0);
const result = await page.evaluate(async () => {
  const checks = [];
  const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const base = `/modules/${moduleId}/src/foundry/systems/dnd5e/builder`;
  const { createBuilderController } = await import(`${base}/builder-gateway.mjs`);
  const { createCreationController } = await import(`${base}/creation-controller.mjs`);
  const { createDraftStore } = await import(`${base}/draft-store.mjs`);
  const t = (k, f, d = {}) => String(f).replace(/\{(\w+)\}/g, (m, x) => (d[x] !== undefined ? String(d[x]) : m));
  const uuidOf = async (packId, type, name) => (await game.packs.get(packId).getIndex()).find(e => e.type === type && e.name === name)?.uuid;
  const flagBefore = foundry.utils.deepClone(game.user.getFlag(moduleId, "builder") ?? null);
  const rulesBefore = foundry.utils.deepClone(game.settings.get(moduleId, "builderHouseRules") ?? {});
  const messagesBefore = new Set(game.messages.map(m => m.id));
  const characterBefore = game.user.character?.id ?? null;
  const actors = [];
  const made = async (name, abilities) => {
    const a = await Actor.implementation.create({ name: `L20 fix e2e ${name}`, type: "character",
      system: { abilities: Object.fromEntries(Object.entries(abilities).map(([k, v]) => [k, { value: v }])) } });
    actors.push(a);
    return a;
  };
  const lines = view => (view.groups ?? []).flatMap(g => g.lines.map(l => l.text));
  const attention = view => (view.groups ?? []).find(g => g.id === "attention")?.lines.map(l => l.text) ?? [];

  /** Answer every screen; `hooks(model, view)` may return { data, meta } for a screen, or undefined for the default. */
  const play = async (c, view, hooks = () => undefined, seen = []) => {
    let guard = 0;
    while (view.screen === "step" && guard++ < 40) {
      const m = view.model;
      seen.push(m);
      let answer = await hooks(m, view);
      if (!answer) {
        if (m.type === "HitPoints") answer = { data: { value: "avg" }, meta: { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod } } };
        else if (m.type === "Trait") {
          const chosen = new Set();
          for (const slot of m.slots) slot.options.filter(o => !chosen.has(o.key)).slice(0, slot.count).forEach(o => chosen.add(o.key));
          answer = { data: { chosen: [...chosen] } };
        } else if (m.type === "ItemChoice") {
          let open = m.options.filter(o => !o.blockers.length);
          const extra = {};
          if (m.spellLists?.length > 1) { extra.list = m.list ?? m.spellLists[0].key; open = open.filter(o => !o.lists || o.lists.includes(extra.list)); }
          if (m.abilityChoices?.length) extra.ability = m.ability;
          answer = { data: { selected: open.slice(0, m.count).map(o => o.uuid), ...extra } };
        } else if (m.type === "Subclass") answer = { data: { uuid: m.options[0].uuid }, meta: { kind: "subclass" } };
        else if (m.type === "AbilityScoreImprovement") {
          const room = k => Math.max(0, Math.max(m.scores[k].max, Number(m.config.max) || 0) - m.scores[k].value);
          const keys = Object.keys(m.scores).filter(k => m.canImprove[k] !== false && !m.config.locked.includes(k) && room(k) > 0);
          const assignments = {};
          let left = m.config.points;
          for (const k of keys) { if (left <= 0) break; const add = Math.min(left, room(k), m.config.cap); if (add > 0) { assignments[k] = add; left -= add; } }
          answer = { data: { type: "asi", assignments } };
        } else if (m.type === "Size") answer = { data: { size: m.options[0].key } };
        else if (m.type === "ItemGrant") answer = { data: { selected: m.items.map(i => i.uuid), ...(m.abilityChoices?.length ? { ability: m.ability } : {}) } };
        else if (m.type === "Spells") {
          const take = (list, n) => list.slice(0, Math.max(0, n)).map(o => o.uuid);
          const cantrips = take(m.options.filter(o => o.level === 0), m.owed.cantrips);
          const leveled = [...m.options.filter(o => o.level > 0)].sort((a, b) => b.level - a.level);
          const spells = take(leveled, m.owed.spellbookClass ? m.owed.spellbook : m.owed.prepared);
          answer = { data: { cantrips, spells, prepare: m.owed.spellbookClass ? spells.slice(0, m.owed.prepared) : [], swaps: [] }, meta: { kind: "spells" } };
        } else throw new Error(`Unexpected screen ${m.type} (${m.title})`);
      }
      view = await c.answer(answer.data, answer.meta);
    }
    return view;
  };
  /** One level-up (or a new class), answered by `hooks`; returns { review, seen } and commits unless `commit: false`. */
  const level = async (c, actor, cls, hooks, { commit = true } = {}) => {
    const owned = actor.classes?.[cls];
    let view;
    if (owned) view = await c.start({ kind: "level", classId: owned.id });
    else view = await c.start({ kind: "new-class", classUuid: await uuidOf("dnd5e.classes24", "class", cls[0].toUpperCase() + cls.slice(1)), label: `New class: ${cls}` });
    const seen = [];
    view = await play(c, view, hooks, seen);
    if (view.screen !== "review") throw new Error(`level-up of ${cls} stopped at ${view.screen}: ${view.error ?? ""}`);
    if (commit) await c.commit();
    return { review: view, seen };
  };
  const levelTo = async (c, actor, cls, target, hooks = () => undefined, onLevel = null) => {
    while ((Number(actor.classes?.[cls]?.system.levels) || 0) < target) {
      const n = (Number(actor.classes?.[cls]?.system.levels) || 0) + 1;
      const r = await level(c, actor, cls, (m, v) => hooks(m, v, n));
      if (onLevel) await onLevel(n, r);
    }
  };
  const spellsNamed = (actor, name) => actor.items.filter(i => i.type === "spell" && i.name === name);
  const featsNamed = (actor, name) => actor.items.filter(i => i.type === "feat" && i.name === name);

  try {
    await game.settings.set(moduleId, "builderHouseRules", { ...rulesBefore, multiclass: true, multiclassPrerequisites: true,
      abilityMethods: { standardArray: true, pointBuy: true, roll: true, manual: true } });

    // ---- 1. Multiclass Warlock invocations (tester-e-05): Warlock-level prerequisites; a dropped pick is reported.
    {
      const actor = await made("Paladin Warlock", { str: 15, dex: 8, con: 14, int: 8, wis: 10, cha: 16 });
      const c = createBuilderController(actor, { moduleId });
      await levelTo(c, actor, "paladin", 4);
      await level(c, actor, "warlock", m => (m.type === "ItemChoice" && /Invocation/.test(m.title) ? { data: { selected: [m.options.find(o => o.name === "Pact of the Blade").uuid] } } : undefined));
      let model = null;
      const r = await level(c, actor, "warlock", (m) => {
        if (m.type === "ItemChoice" && /Invocation/.test(m.title)) {
          model = m;
          // As the GM, take Thirsting Blade anyway (blocked rows stay enabled for a GM).
          return { data: { selected: [m.options.find(o => o.name === "Thirsting Blade").uuid, m.options.find(o => o.name === "Agonizing Blast").uuid] } };
        }
      }, { commit: false });
      const tb = model?.options.find(o => o.name === "Thirsting Blade");
      check("Warlock 2 at character level 6: Thirsting Blade needs level 5 (Warlock level, not character level)", tb?.blockers.some(b => b.key === "level" && b.level === 5), tb);
      check("Warlock 2: One with Shadows blocked too", model?.options.find(o => o.name === "One with Shadows")?.blockers.some(b => b.key === "level"), model?.options.map(o => [o.name, o.blockers]));
      check("Warlock 2: a pick dnd5e drops is named in Review", attention(r.review).some(l => /Not applied: Thirsting Blade/.test(l)), attention(r.review));
      await c.discardDraft();
    }

    // ---- 2. Single-class Warlock: replacement, repeatable invocations, Mystic Arcanum, its replacement, Epic Boon feat list.
    {
      const actor = await made("Warlock", { str: 8, dex: 14, con: 14, int: 10, wis: 12, cha: 17 });
      const c = createBuilderController(actor, { moduleId });
      const want = { 1: ["Pact of the Tome"], 2: ["Agonizing Blast", "Devil's Sight"], 5: ["Agonizing Blast", "Repelling Blast"], 7: ["Eldritch Mind"], 9: ["Eldritch Spear"],
        12: ["Mask of Many Faces"], 15: ["Ascendant Step"], 18: ["Witch Sight"] };
      const facts = {};
      await levelTo(c, actor, "warlock", 19, (m, v, n) => {
        if (m.type === "ItemChoice" && /Invocation/.test(m.title)) {
          facts[`inv${n}`] = { count: m.count, replaceable: (m.replaceable ?? []).map(r => r.name), agonizing: m.options.find(o => o.name === "Agonizing Blast")?.blockers };
          if (n === 3) {
            const out = m.replaceable.find(r => r.name === "Devil's Sight");
            return { data: { selected: [m.options.find(o => o.name === "Eldritch Mind").uuid], replace: out?.id } };
          }
          const names = want[n] ?? [];
          return { data: { selected: names.map(name => m.options.find(o => o.name === name)?.uuid).filter(Boolean).slice(0, m.count) } };
        }
        if (m.type === "ItemChoice" && /Mystic Arcanum/.test(m.title)) {
          facts[`arc${n}:${m.title}`] = { count: m.count, levels: [...new Set(m.options.map(o => o.level))], replaceable: (m.replaceable ?? []).map(r => r.name) };
          if (n === 12 && /6th/.test(m.title)) {
            const out = m.replaceable[0];
            const inc = m.options.find(o => !o.blockers.length && o.name !== out?.name);
            facts.arcSwap = { out: out?.name, in: inc?.name };
            return { data: { selected: [inc.uuid], replace: out?.id } };
          }
        }
        if (m.type === "AbilityScoreImprovement" && n === 19 && m.allowFeat) facts.boonStep = { title: m.title, subtypes: [...new Set(m.feats.map(f => f.subtype))] };
      }, async n => {
        if (n === 2) facts.after2 = actor.items.filter(i => i.type === "feat" && i.system.type?.subtype === "eldritchInvocation").map(i => i.name).sort();
        if (n === 3) facts.after3 = actor.items.filter(i => i.type === "feat" && i.system.type?.subtype === "eldritchInvocation").map(i => i.name).sort();
        if (n === 11) facts.arc11 = actor.items.filter(i => i.type === "spell" && i.system.level === 6).map(i => i.name);
        if (n === 12) facts.arc12 = actor.items.filter(i => i.type === "spell" && i.system.level === 6).map(i => i.name);
      });
      check("Warlock 3: \"Change an earlier pick?\" offered on a level with no new invocation", facts.inv3?.count === 0 && facts.inv3.replaceable.includes("Devil's Sight"), facts.inv3);
      check("Warlock 3: Devil's Sight replaced by Eldritch Mind", facts.after2?.includes("Devil's Sight") && !facts.after3?.includes("Devil's Sight") && facts.after3?.includes("Eldritch Mind"), { after2: facts.after2, after3: facts.after3 });
      check("Warlock 5: Agonizing Blast (repeatable) offered again, no blocker", Array.isArray(facts.inv5?.agonizing) && facts.inv5.agonizing.length === 0, facts.inv5);
      check("Warlock 5: two Agonizing Blasts on the actor", featsNamed(actor, "Agonizing Blast").length === 2, featsNamed(actor, "Agonizing Blast").length);
      const arc = Object.entries(facts).filter(([k]) => k.startsWith("arc") && k.includes(":"));
      check("Mystic Arcanum 6th/7th/8th/9th picks at Warlock 11/13/15/17, each of its own level",
        ["11:Mystic Arcanum (6th level)", "13:Mystic Arcanum (7th level)", "15:Mystic Arcanum (8th level)", "17:Mystic Arcanum (9th level)"].every(k => facts[`arc${k}`]?.count === 1)
        && facts["arc11:Mystic Arcanum (6th level)"].levels.every(l => l === 6) && facts["arc17:Mystic Arcanum (9th level)"].levels.every(l => l === 9), arc);
      check("Warlock 12: the 6th-level arcanum may be replaced", facts["arc12:Mystic Arcanum (6th level)"]?.replaceable?.length === 1, facts["arc12:Mystic Arcanum (6th level)"]);
      check("Warlock 12: arcanum replaced", facts.arc11?.length === 1 && facts.arc12?.length === 1 && facts.arc12[0] === facts.arcSwap?.in && facts.arc11[0] === facts.arcSwap?.out, { arc11: facts.arc11, arc12: facts.arc12, swap: facts.arcSwap });
      check("Warlock 19: the Epic Boon step also offers General and Origin feats", facts.boonStep?.subtypes.includes("epicBoon") && facts.boonStep.subtypes.includes("general") && facts.boonStep.subtypes.includes("origin"), facts.boonStep);
      const arcanum = actor.items.filter(i => i.type === "spell" && i.system.level >= 6).map(i => i.system.level).sort();
      check("Warlock 19: arcanum spells of levels 6, 7, 8, 9", JSON.stringify(arcanum) === "[6,7,8,9]", arcanum);
    }

    // ---- 3. Fighter (Champion): Fighting Style replacement, feat lists, Champion 7 pool, ASI cap; Wizard 4 at character level 20.
    {
      const actor = await made("Fighter Wizard", { str: 19, dex: 12, con: 14, int: 13, wis: 10, cha: 8 });
      const c = createBuilderController(actor, { moduleId });
      const facts = {};
      await levelTo(c, actor, "fighter", 16, (m, v, n) => {
        if (m.type === "ItemChoice" && m.title === "Fighting Style" && m.item === "Fighter") {
          if (n === 1) return { data: { selected: [m.options.find(o => o.name === "Archery").uuid] } };
          facts[`fs${n}`] = { count: m.count, replaceable: (m.replaceable ?? []).map(r => r.name) };
          if (n === 2) return { data: { selected: [m.options.find(o => o.name === "Defense").uuid], replace: m.replaceable.find(r => r.name === "Archery")?.id } };
        }
        if (m.type === "ItemChoice" && m.title === "Fighting Style" && n === 7 && m.count === 1) {
          facts.champion7 = { names: m.options.map(o => o.name), missing: m.missing, defense: m.options.find(o => o.name === "Defense")?.blockers };
          return { data: { selected: [m.options.find(o => o.name === "Great Weapon Fighting").uuid] } };
        }
        if (m.type === "AbilityScoreImprovement" && m.allowFeat && n === 4) {
          facts.asi4 = { subtypes: [...new Set(m.feats.map(f => f.subtype))], names: m.feats.map(f => f.name), boons: m.feats.filter(f => f.subtype === "epicBoon").length };
          return { data: { type: "asi", assignments: { str: 1, con: 1 } } };
        }
      }, async n => { if (n === 2) facts.styles2 = actor.items.filter(i => i.system.type?.subtype === "fightingStyle").map(i => i.name); });
      check("Fighter 2: Fighting Style may be changed (replacement card)", facts.fs2?.count === 0 && facts.fs2.replaceable.includes("Archery"), facts.fs2);
      check("Fighter 2: Archery replaced by Defense", JSON.stringify(facts.styles2) === JSON.stringify(["Defense"]), facts.styles2);
      check("Fighter 4 ASI: General, Origin and Fighting Style feats offered, no Epic Boons", ["general", "origin", "fightingStyle"].every(s => facts.asi4?.subtypes.includes(s)) && facts.asi4.boons === 0, facts.asi4);
      check("Champion 7: no raw UUIDs in the Fighting Style list; missing ones named", facts.champion7 && !facts.champion7.names.some(n => n.startsWith("Compendium."))
        && (facts.champion7.missing ?? []).includes("Blind Fighting"), facts.champion7);
      check("Champion 7: the style already taken shows one \"repeat\" blocker", facts.champion7?.defense?.filter(b => b.key === "repeat").length === 1, facts.champion7?.defense);
      // ASI cap: STR is 20 by now; +2 STR is refused by the engine.
      check("STR at 20 before the cap check", actor.system.abilities.str.value === 20, actor.system.abilities.str.value);
      let refused = null;
      let view;
      // Wizard 1–4: at Wizard 4 the character is level 20, so the ASI lists Epic Boons; +2 STR at 20 is refused.
      await levelTo(c, actor, "wizard", 3);
      view = await c.start({ kind: "level", classId: actor.classes.wizard.id });
      let asiModel = null;
      view = await play(c, view, m => {
        if (m.type === "AbilityScoreImprovement" && m.allowFeat) { asiModel = m; return { data: { type: "asi", assignments: { str: 2 } } }; }
      });
      refused = view.screen === "step" && view.model.type === "AbilityScoreImprovement" ? view.error : null;
      check("Wizard 4 at character level 20: Epic Boons offered on the ASI", asiModel?.feats.some(f => f.subtype === "epicBoon"), asiModel?.feats.map(f => f.subtype));
      check("ASI +2 to STR 20 is refused by the engine", /can't go above 20/.test(refused ?? ""), { screen: view.screen, error: view.error });
      view = await c.answer({ type: "asi", assignments: { int: 2 } });
      view = await play(c, view);
      check("Wizard 4 finishes after a valid ASI", view.screen === "review", view.screen);
      const book = view.groups.find(g => g.id === "spells")?.lines.map(l => l.text) ?? [];
      check("Wizard: a new prepared spell reads \"Added to spellbook and prepared\"", book.some(l => l.startsWith("Added to spellbook and prepared:")), book);
      await c.commit();
      // Multiclassing off: a GM may still add a class, and Review says it was an override.
      await game.settings.set(moduleId, "builderHouseRules", { ...game.settings.get(moduleId, "builderHouseRules"), multiclass: false });
      view = await c.start({ kind: "new-class", classUuid: await uuidOf("dnd5e.classes24", "class", "Rogue"), label: "New class: Rogue" });
      view = await play(c, view);
      check("Multiclassing off: a GM's new class carries an override note", attention(view).some(l => /GM override: Multiclassing is switched off/.test(l)), attention(view));
      await c.discardDraft();
      await game.settings.set(moduleId, "builderHouseRules", { ...game.settings.get(moduleId, "builderHouseRules"), multiclass: true });
    }

    // ---- 4. Cleric (Life): a class pick the domain later grants is freed; Paladin/Ranger Long Rest note.
    {
      const actor = await made("Cleric", { str: 10, dex: 12, con: 14, int: 8, wis: 16, cha: 13 });
      const c = createBuilderController(actor, { moduleId });
      await level(c, actor, "cleric", m => {
        if (m.type === "Spells") {
          const cw = m.options.find(o => o.name === "Cure Wounds");
          const rest = m.options.filter(o => o.level === 1 && o.name !== "Cure Wounds").slice(0, m.owed.prepared - 1);
          return { data: { cantrips: m.options.filter(o => o.level === 0).slice(0, m.owed.cantrips).map(o => o.uuid), spells: [cw.uuid, ...rest.map(o => o.uuid)], prepare: [], swaps: [] } };
        }
      });
      await levelTo(c, actor, "cleric", 2);
      let spellModel = null;
      const r3 = await level(c, actor, "cleric", m => { if (m.type === "Spells") spellModel = m; });
      check("Cleric 3: the spell step names Cure Wounds as freed", spellModel?.freed?.includes("Cure Wounds"), spellModel?.freed);
      check("Cleric 3: Review says the earlier pick is freed", lines(r3.review).some(l => /^Cure Wounds is now always prepared/.test(l)), lines(r3.review));
      check("Cleric 3: one Cure Wounds, always prepared", spellsNamed(actor, "Cure Wounds").length === 1 && spellsNamed(actor, "Cure Wounds")[0].system.prepared === 2, spellsNamed(actor, "Cure Wounds").map(s => s.system.prepared));
      const prepared = actor.items.filter(i => i.type === "spell" && i.system.level > 0 && i.system.prepared === 1 && i.system.sourceItem === "class:cleric").length;
      check("Cleric 3: 6 prepared class spells (table)", prepared === 6, prepared);
      check("Cleric spell screen notes the Long Rest swap", spellModel?.restSwap === true, spellModel?.restSwap);
    }

    // ---- 5. Druid (Circle of the Land): land type at 3, its spells always prepared, more at 5.
    {
      const actor = await made("Druid", { str: 8, dex: 14, con: 14, int: 10, wis: 16, cha: 10 });
      const c = createBuilderController(actor, { moduleId });
      let land = null;
      await levelTo(c, actor, "druid", 5, (m, v, n) => {
        if (m.type === "Subclass") return { data: { uuid: m.options.find(o => o.name === "Circle of the Land").uuid }, meta: { kind: "subclass" } };
        if (m.type === "ItemChoice" && /land type/i.test(m.title)) { land = m; return { data: { selected: [m.options.find(o => /Temperate/.test(o.name)).uuid] } }; }
      }, async n => {
        if (n === 3) {
          const have = ["Misty Step", "Shocking Grasp", "Sleep"].map(name => spellsNamed(actor, name)[0]);
          check("Druid 3: Temperate circle spells always prepared", have.every(s => s && s.system.prepared === 2), have.map(s => s?.system.prepared));
        }
      });
      check("Druid 3: a land-type step with four lands", land?.options.length === 4, land?.options.map(o => o.name));
      check("Druid 5: Lightning Bolt added on its own", spellsNamed(actor, "Lightning Bolt")[0]?.system.prepared === 2, spellsNamed(actor, "Lightning Bolt").length);
      const cantrips = actor.items.filter(i => i.type === "spell" && i.system.level === 0 && i.system.sourceItem === "class:druid").length;
      const magician = actor.items.some(i => /Magician/.test(i.name)) ? 1 : 0;
      check("Druid 5: circle cantrip not counted among the class's cantrips (3, +1 for Magician)", cantrips === 3 + magician, { cantrips, magician });
    }

    // ---- 6. Bard (Lore): Magical Discoveries at 6, Magical Secrets lists at 10.
    {
      const actor = await made("Bard", { str: 8, dex: 14, con: 14, int: 10, wis: 12, cha: 16 });
      const c = createBuilderController(actor, { moduleId });
      let disc = null;
      let secrets = null;
      await levelTo(c, actor, "bard", 10, (m, v, n) => {
        if (m.type === "Subclass") return { data: { uuid: m.options.find(o => o.name === "College of Lore").uuid }, meta: { kind: "subclass" } };
        if (m.type === "ItemChoice" && m.title === "Magical Discoveries" && n === 6) {
          disc = m;
          return { data: { selected: ["Spiritual Weapon", "Counterspell"].map(name => m.options.find(o => o.name === name)?.uuid).filter(Boolean) } };
        }
        if (m.type === "Spells" && n === 10) {
          secrets = m;
          const fireball = m.options.find(o => o.name === "Fireball");
          return { data: { cantrips: m.options.filter(o => o.level === 0).slice(0, m.owed.cantrips).map(o => o.uuid), spells: [fireball?.uuid].filter(Boolean).slice(0, m.owed.prepared), prepare: [], swaps: [] } };
        }
      });
      check("Bard 6: Magical Discoveries asks 2 spells, none above level 3", disc?.count === 2 && Math.max(...disc.options.map(o => o.level)) <= 3, disc && { count: disc.count, max: Math.max(...disc.options.map(o => o.level)) });
      check("Bard 6: discoveries always prepared", ["Spiritual Weapon", "Counterspell"].every(n => spellsNamed(actor, n)[0]?.system.prepared === 2), ["Spiritual Weapon", "Counterspell"].map(n => spellsNamed(actor, n)[0]?.system.prepared));
      check("Bard 10: the spell step offers Bard, Cleric, Druid and Wizard lists", secrets?.lists?.length === 4 && secrets.options.some(o => o.name === "Fireball"), secrets?.lists);
      check("Bard 10: Fireball learned as a Bard spell", spellsNamed(actor, "Fireball")[0]?.system.sourceItem === "class:bard", spellsNamed(actor, "Fireball").map(s => s.system.sourceItem));
    }

    // ---- 7. Monk: Self-Restoration named at 10; Body and Mind at 20 is +4/+4 to 25 with no feat screen.
    {
      const actor = await made("Monk", { str: 10, dex: 20, con: 14, int: 8, wis: 20, cha: 8 });
      const c = createBuilderController(actor, { moduleId });
      let note10 = [];
      const bodyScreens = [];
      await levelTo(c, actor, "monk", 20, (m, v, n) => {
        if (n === 20 && m.type === "AbilityScoreImprovement") bodyScreens.push({ title: m.title, allowFeat: m.allowFeat, item: m.item });
      }, async (n, r) => { if (n === 10) note10 = attention(r.review); });
      check("Monk 10: Self-Restoration is named as missing, not dropped silently", note10.some(l => /Self-Restoration/.test(l)), note10);
      check("Monk 20: no feat screen for Body and Mind", !bodyScreens.some(s => s.item === "Monk"), bodyScreens);
      check("Monk 20: DEX and WIS 24 (Body and Mind +4, max 25)", actor.system.abilities.dex.value === 24 && actor.system.abilities.wis.value === 24, { dex: actor.system.abilities.dex.value, wis: actor.system.abilities.wis.value });
    }

    // ---- 8. Draconic Sorcerer with fire resistance: Elemental Affinity still offers Fire.
    {
      const actor = await made("Sorcerer", { str: 8, dex: 14, con: 14, int: 10, wis: 10, cha: 16 });
      await actor.update({ "system.traits.dr.value": ["fire"] });
      const c = createBuilderController(actor, { moduleId });
      let affinity = null;
      await levelTo(c, actor, "sorcerer", 6, (m, v, n) => {
        if (m.type === "Subclass") return { data: { uuid: m.options.find(o => o.name === "Draconic Sorcery").uuid }, meta: { kind: "subclass" } };
        if (m.type === "Trait" && n === 6 && m.slots.some(s => s.options.some(o => o.key.startsWith("dr:")))) { affinity = m; return { data: { chosen: ["dr:fire"] } }; }
      });
      const fire = affinity?.slots.flatMap(s => s.options).find(o => o.key === "dr:fire");
      check("Sorcerer 6: Elemental Affinity offers Fire to a fire-resistant character", Boolean(fire), affinity?.slots.map(s => s.options.map(o => o.key)));
    }

    // ---- 9. Creation: Acolyte's Magic Initiate locked to Cleric; Spells-tab picks it duplicates flag the tab; a species
    // picked after the class keeps the class answers (Infernal Tiefling adds a level-1 step).
    {
      const store = createDraftStore(moduleId);
      await store.finishCreation().catch(() => {});
      const c = createCreationController({ moduleId, t });
      await c.start({});
      const pickTab = async (tab, name, variant) => {
        const v = await c.segment(tab);
        if (tab === "species") {
          const g = v.options.find(x => x.name === name);
          return c.pick(tab, (g.variants.find(x => new RegExp(variant).test(x.fullName ?? x.name)) ?? g.variants[0]).uuid);
        }
        return c.pick(tab, v.options.find(o => o.name === name).uuid);
      };
      const answerAll = async (tab, view, hooks = () => undefined) => {
        let guard = 0;
        while (view.screen === "step" && guard++ < 30) {
          const m = view.model;
          let a = await hooks(m);
          if (!a) {
            if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); a = { data: { chosen: [...chosen] } }; }
            else if (m.type === "ItemChoice") { let open = m.options.filter(o => !o.blockers.length); const x = {}; if (m.spellLists?.length > 1) { x.list = m.list ?? m.spellLists[0].key; open = open.filter(o => !o.lists || o.lists.includes(x.list)); } if (m.abilityChoices?.length) x.ability = m.ability; a = { data: { selected: open.slice(0, m.count).map(o => o.uuid), ...x } }; }
            else if (m.type === "ItemGrant") a = { data: { selected: m.items.map(i => i.uuid), ...(m.abilityChoices?.length ? { ability: m.ability } : {}) } };
            else if (m.type === "AbilityScoreImprovement") a = { data: { type: "asi", assignments: { wis: 2, cha: 1 } } };
            else if (m.type === "Size") a = { data: { size: m.options[0].key } };
            else throw new Error(`creation screen ${m.type}`);
          }
          view = await c.answer(tab, a.data, a.meta);
          if (view.screen === "answered") break;
        }
        return view;
      };
      // Class first, its steps answered.
      let v = await answerAll("class", await pickTab("class", "Cleric"));
      // Spells tab: Guidance among the cantrips.
      v = await c.segment("spells");
      const guidance = v.model?.options.find(o => o.name === "Guidance");
      await c.answer("spells", { cantrips: [guidance.uuid, ...v.model.options.filter(o => o.level === 0 && o.name !== "Guidance").slice(0, 2).map(o => o.uuid)],
        spells: v.model.options.filter(o => o.level === 1).slice(0, v.model.owed.prepared).map(o => o.uuid), prepare: [], swaps: [] }, { kind: "spells" });
      // Background: Acolyte; Magic Initiate takes Guidance too.
      let miModel = null;
      v = await answerAll("background", await pickTab("background", "Acolyte"), m => {
        if (m.type === "ItemChoice" && m.itemType === "spell" && m.count === 2) {
          miModel = m;
          const onList = o => !m.list || !o.lists || o.lists.includes(m.list);
          return { data: { selected: [m.options.find(o => o.name === "Guidance").uuid, m.options.find(o => o.level === 0 && o.name !== "Guidance" && !o.blockers.length && onList(o)).uuid], list: m.list, ability: m.ability } };
        }
      });
      check("Acolyte's Magic Initiate is locked to the Cleric list", miModel?.list === "class:cleric" && miModel.listLocked === true, miModel && { list: miModel.list, locked: miModel.listLocked });
      const tabs = c.tabs();
      check("Spells tab flagged when Magic Initiate takes a spell picked there", tabs.spells === "attention", tabs);
      const review = await c.review();
      check("Create is blocked by the duplicate, with the spell named", review.blockers.some(b => b.kind === "conflict" && /Guidance/.test(b.text)), review.blockers);
      // Species after the class: Infernal Tiefling adds a level-1 step; the class answers stay.
      const before = (await c.segment("class")).screen;
      v = await answerAll("species", await pickTab("species", "Tiefling", "Infernal"));
      let after = await c.segment("class");
      const speciesStep = after.screen === "step" ? { title: after.model.title, from: after.model.sourceTab } : null;
      // Answer the species' new level-1 step: the class's own steps that follow keep their saved answers.
      if (after.screen === "step" && after.model.sourceTab === "species") {
        const m = after.model;
        after = await c.answer("class", m.type === "ItemGrant" ? { selected: m.items.map(i => i.uuid), ...(m.abilityChoices?.length ? { ability: m.ability } : {}) } : { selected: [] });
      }
      check("Picking the species after the class keeps the class answers", speciesStep?.from === "species"
        && (after.screen === "done" || (after.screen === "step" && after.model.answer !== null)), { before, speciesStep, after: after.screen, next: after.model?.title, answer: after.model?.answer });
      await store.finishCreation().catch(() => {});
    }

    return { checks };
  } catch (error) {
    return { checks, error: `${error.message}\n${error.stack}` };
  } finally {
    for (const a of actors) await a.delete().catch(() => {});
    const mine = game.messages.filter(m => !messagesBefore.has(m.id)).map(m => m.id);
    if (mine.length) await ChatMessage.deleteDocuments(mine).catch(() => {});
    await game.user.unsetFlag(moduleId, "builder").catch(() => {});
    if (flagBefore !== null) await game.user.setFlag(moduleId, "builder", flagBefore).catch(() => {});
    await game.settings.set(moduleId, "builderHouseRules", rulesBefore);
    if ((game.user.character?.id ?? null) !== characterBefore) await game.user.update({ character: characterBefore });
  }
});
for (const c of result.checks) console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info)?.slice(0, 700));
if (result.error) console.log("ERROR", result.error);
console.log(`${result.checks.filter(c => c.ok).length}/${result.checks.length} passed`);
await browser.close();
