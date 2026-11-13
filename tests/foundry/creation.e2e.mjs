// End-to-end test of Phase 4a character creation (no UI) in test-5e-world, as Claude Test GM.
// 1. Human Soldier Fighter: point buy, background +2/+1, package A, gaming set linked to the Soldier's proficiency.
// 2. Wood Elf Acolyte Cleric: free tab order, standard array + Suggested, class gold, holy focus pick,
//    spells, a class change that clears its equipment, and a resumed draft.
// 3. Halfling Sage Bard: Roll in Foundry with one reroll (a third roll is refused), instrument linked to proficiency.
// Also: Enter my dice validation, the trinket, tab states, Review blockers, and commit refusing an unfinished draft.
// Review fixes: a stale linked equipment pick, rolls kept through Start over (and cleared by Create), one-update flag
// deletes, Create not running twice, a class banned after it was picked, unspent / over-budget point buy, "Level 1".
// Data fixes: species / background links, speed, senses and spell DC; book gold; worn gear and AC; any language.
// 4. Dwarf Criminal Rogue, class first: Stealth / Sleight of Hand picked before Criminal grants them → the class step
//    needs attention (Review says why), re-opens without them, Expertise offers them; leather armor AC 14, darkvision 120.
// 5. High Elf Wizard (not saved): the species' level-1 cantrip asks for its spellcasting ability. The Acolyte's Magic
//    Initiate (scenario 2) offers spells from one list, with the ability.
// Creates and deletes throwaway actors, chat cards and the user's creation draft.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/creation.e2e.mjs
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const { browser, page } = await joinTestWorld();
await pinToSrd(page); // the suite's expectations are for dnd5e's SRD content, not the user's books (pin-srd.mjs)
const result = await page.evaluate(async () => {
  const checks = [];
  const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const base = `/modules/${moduleId}/src/foundry/systems/dnd5e/builder`;
  const { createCreationController } = await import(`${base}/creation-controller.mjs`);
  const { suggestedAssignments } = await import(`${base}/creation-rules.mjs`);
  const { runCreation, createReplayCache } = await import(`${base}/creation-session.mjs`);
  const { builderSnapshot } = await import(`${base}/snapshot.mjs`);
  const { unfulfilledChoices } = await import(`${base}/trait-choices.mjs`);
  // Performance caches must not change results: the same draft replayed without a cache, with a cold one and a warm one.
  const replayShape = r => {
    const snap = builderSnapshot(r.final);
    return JSON.stringify({ ...snap, items: snap.items.map(i => `${i.type}|${i.name}|${i.source}|${i.level ?? ""}|${i.prepared ?? ""}`).sort(),
      missing: r.missing.map(m => `${m.tab}|${m.kind}|${m.title ?? ""}|${(m.conflicts ?? []).map(x => x.key).join()}`),
      ac: r.final.system.attributes.ac.value, gp: r.final.system.currency.gp, equipped: r.final.items.filter(i => i.system.equipped).map(i => i.name).sort() });
  };
  const sameWithCache = async () => {
    const draft = store.creation();
    const opts = { methods: ["standardArray", "pointBuy", "roll", "manual"], rolls: store.creationRolls() };
    const plain = replayShape(await runCreation(structuredClone(draft), opts));
    const cache = createReplayCache();
    const cold = replayShape(await runCreation(structuredClone(draft), { ...opts, cache }));
    const warm = replayShape(await runCreation(structuredClone(draft), { ...opts, cache }));
    return { same: plain === cold && plain === warm, hits: cache.segments.size, plain: plain.slice(0, 300) };
  };
  const { createDraftStore } = await import(`${base}/draft-store.mjs`);
  const store = createDraftStore(moduleId);
  const builderFlag = () => game.user.getFlag(moduleId, "builder") ?? {};
  const t = (k, f, d = {}) => String(f).replace(/\{(\w+)\}/g, (m, x) => (d[x] !== undefined ? String(d[x]) : m));
  const rulesBefore = foundry.utils.deepClone(game.settings.get(moduleId, "builderHouseRules") ?? {});
  const sourcesBefore = foundry.utils.deepClone(game.settings.get(moduleId, "builderSources") ?? {});
  const characterBefore = game.user.character?.id ?? null;
  const messagesBefore = new Set(game.messages.map(m => m.id));
  const created = [];
  const log = [];
  const models = [];

  const defaultSpells = m => {
    const pick = (filter, n) => m.options.filter(filter).slice(0, n).map(o => o.uuid);
    const cantrips = pick(o => o.level === 0, m.owed.cantrips);
    const spells = pick(o => o.level > 0, m.owed.spellbookClass ? m.owed.spellbook : m.owed.prepared);
    return { cantrips, spells, prepare: m.owed.spellbookClass ? spells.slice(0, m.owed.prepared) : [], swaps: [] };
  };
  const answerFor = (m, prefs = {}) => {
    if (m.type === "Trait") {
      const chosen = new Set();
      for (const s of m.slots) s.options.filter(o => (prefs.want ?? []).includes(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key));
      const left = s => s.count - s.options.filter(o => chosen.has(o.key)).length;
      for (const s of m.slots) s.options.filter(o => !chosen.has(o.key) && (!prefs.traitFilter || prefs.traitFilter(o))).slice(0, Math.max(0, left(s))).forEach(o => chosen.add(o.key));
      for (const s of m.slots) if (left(s) > 0) s.options.filter(o => !chosen.has(o.key)).slice(0, left(s)).forEach(o => chosen.add(o.key));
      return { data: { chosen: [...chosen] } };
    }
    if (m.type === "ItemChoice") {
      let open = m.options.filter(o => !o.blockers.length);
      const extra = {};
      if (m.abilityChoices?.length) extra.ability = prefs.ability ?? m.ability;
      if (m.spellLists?.length > 1) {
        // Once, if asked: one Wizard-only and one Druid-only cantrip, which dnd5e's rules (one list per feat) refuse.
        if (prefs.mixOnce && !prefs.mixed && m.count === 2) {
          prefs.mixed = true;
          const only = key => open.find(o => o.lists.length === 1 && o.lists[0] === key);
          return { data: { selected: [only("class:wizard")?.uuid, only("class:druid")?.uuid].filter(Boolean), ...extra } };
        }
        extra.list = m.list ?? prefs.spellList ?? m.spellLists[0].key;
        open = open.filter(o => o.lists.includes(extra.list));
      }
      const liked = open.filter(o => (prefs.items ?? []).includes(o.name));
      return { data: { selected: [...liked, ...open.filter(o => !liked.includes(o))].slice(0, m.count).map(o => o.uuid), ...extra } };
    }
    if (m.type === "Size") return { data: { size: m.options.find(o => o.key === "med")?.key ?? m.options[0].key } };
    if (m.type === "ItemGrant") return { data: { selected: m.items.map(i => i.uuid), ...(m.abilityChoices?.length ? { ability: prefs.ability ?? m.ability } : {}) } };
    if (m.type === "AbilityScoreImprovement") {
      const open = Object.keys(m.scores).filter(k => !m.config.locked.includes(k));
      return { data: { type: "asi", assignments: prefs.asi ?? { [open[0]]: 2, [open[1]]: 1 } } };
    }
    if (m.type === "Spells") return { data: defaultSpells(m), meta: { kind: "spells", warnings: [] } };
    throw new Error(`Unexpected screen ${m.type}`);
  };
  const play = async (c, tab, view, prefs) => {
    let guard = 0;
    while (view.screen === "step" && guard++ < 30) {
      log.push(`${tab}: ${view.model.type} ${view.model.title}`);
      models.push({ ...view.model, error: view.error ?? "" });
      const a = answerFor(view.model, prefs);
      view = await c.answer(tab, a.data, a.meta);
    }
    return view;
  };
  const optionNamed = (view, name) => view.options.find(o => o.name === name);
  const traitsOfClass = () => store.creation()?.tabs?.class?.answers?.flatMap(x => x?.data?.chosen ?? []) ?? [];
  const commitAndCheck = async c => { const r = await c.commit(); const actor = game.actors.get(r.actor.id); created.push(actor); return actor; };

  try {
    await game.settings.set(moduleId, "builderHouseRules", { ...rulesBefore,
      abilityMethods: { standardArray: true, pointBuy: true, roll: true, manual: true }, abilityRerolls: 1 });

    await store.finishCreation(); // leftovers of an interrupted run
    const otherKeysBefore = JSON.stringify(Object.keys(builderFlag()).filter(k => !k.startsWith("creation")).sort());

    // ---- 1. Human Soldier Fighter
    let c = createCreationController({ moduleId, t });
    let states = await c.start({});
    check("new draft: class todo, spells hidden", states.class === "todo" && states.spells === "hidden", states);
    let v = await c.segment("class");
    check("class tab starts with a picker listing Fighter", v.screen === "pick" && optionNamed(v, "Fighter"), v.screen);
    // Class skills the Soldier (Athletics, Intimidation) and the Human (first pick: Acrobatics) don't also give: a duplicate
    // would now need attention (data fix 4).
    v = await play(c, "class", await c.pick("class", optionNamed(v, "Fighter").uuid), { items: ["Defense"], want: ["skills:prc", "skills:sur"] });
    check("Fighter steps answered → class done", v.screen === "done", v);
    v = await c.segment("background");
    v = await c.pick("background", optionNamed(v, "Soldier").uuid);
    check("Soldier's first step is its ability increase", v.model?.type === "AbilityScoreImprovement" && v.model.config.points === 3, v.model?.type);
    v = await play(c, "background", v, { asi: { str: 2, con: 1 }, traitFilter: o => o.key.startsWith("tool:game:"),
      want: ["languages:exotic:abyssal", "languages:exotic:primordial:aquan"] });
    // Data fix 6: "Language choices: any language" (on by default) offers every language, each with its group.
    const soldierLangs = models.find(m => m.type === "Trait" && /Languages/.test(m.title));
    const langOptions = soldierLangs?.slots.find(sl => sl.count === 2)?.options ?? [];
    check("any language (default on): Soldier's language choice offers standard, rare and Primordial dialects, grouped, two picks in one slot",
      langOptions.some(o => o.key === "languages:standard:elvish")
      && langOptions.some(o => o.key === "languages:exotic:abyssal" && o.group) && langOptions.some(o => o.key === "languages:exotic:primordial:aquan" && /Primordial/.test(o.group))
      && !langOptions.some(o => o.key === "languages:standard:common" || /:ALL$/.test(o.key)), soldierLangs?.slots.map(sl => [sl.count, sl.options.map(o => `${o.key}|${o.group}`)]));
    v = await c.segment("species");
    const human = v.options.find(g => g.name === "Human");
    v = await play(c, "species", await c.pick("species", human.variants[0].uuid));
    let ab = await c.setAbilities({ method: "pointBuy", pointBuy: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 } });
    check("point buy spends 27", ab.pointBuy.left === 0, ab.pointBuy);
    check("final STR 17 and CON 14 (base + Soldier bonus)", ab.final.str === 17 && ab.final.con === 14, ab.final);
    check("background note only for a background without an increase", !(await c.segment("background")).note, (await c.segment("background")).note);
    let eq = await c.equipment();
    const fClass = eq.sections.find(s => s.source === "class");
    check("Fighter has options A, B (packages) and C (155 GP)", fClass.options.map(o => o.id).join() === "A,B,C" && /155 GP/.test(fClass.options[2].label), fClass.options);
    eq = await c.setEquipment("class", { option: "A" });
    eq = await c.setEquipment("background", { option: "A" });
    const bg = eq.sections.find(s => s.source === "background");
    const gaming = bg.picks.find(p => p.type === "tool");
    check("Soldier's gaming set follows the chosen proficiency (one candidate, auto-picked)", gaming?.linked && gaming.candidates.length === 1 && gaming.value, gaming);
    check("background book text shown", /Equipment/i.test(bg.bookText), bg.bookText);
    check("Soldier option A names the book's 14 GP (no currency entry in dnd5e's data)", /14 GP$/.test(bg.options.find(o => o.id === "A")?.label ?? ""), bg.options);
    eq = await c.rollTrinket();
    check("trinket rolled once and kept", Boolean(eq.trinket?.text), eq.trinket);
    const again = await c.rollTrinket();
    check("second trinket roll keeps the first", again.trinket.text === eq.trinket.text);
    await c.setDetails({ name: "CB Create Fighter", alignment: "Lawful Good", biography: "Soldier.\n\nVeteran." });
    // Point buy left unspent: a dot on the tab and a Review warning, not a blocker.
    await c.setAbilities({ method: "pointBuy", pointBuy: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 8 } });
    let review = await c.review();
    check("unspent point buy: tab needs attention, Review warns but doesn't block", c.tabs().abilities === "attention"
      && review.warnings.some(w => w.tab === "abilities" && /4 Point Buy points/.test(w.text)) && !review.blockers.length, { tabs: c.tabs(), review: [review.warnings, review.blockers] });
    // Over budget (only possible by editing the saved draft): refused with a clear error.
    await c.setAbilities({ method: "pointBuy", pointBuy: { str: 15, dex: 15, con: 15, int: 15, wis: 15, cha: 15 } });
    let overError = "";
    try { await c.commit(); } catch (error) { overError = error.message; }
    check("commit refuses an over-budget point buy", /more than 27 points/.test(overError) && !game.actors.some(a => a.name === "CB Create Fighter"), overError);
    await c.setAbilities({ method: "pointBuy", pointBuy: { str: 15, dex: 14, con: 13, int: 8, wis: 10, cha: 12 } });
    review = await c.review();
    check("Review: no blockers", review.blockers.length === 0, review.blockers);
    check("Review: \"Level 1\", not level-up's \"Character level 0 → 1\"", review.groups.find(g => g.id === "level")?.lines.some(l => l.text === "Level 1")
      && !review.groups.some(g => g.lines.some(l => /^Character level/.test(l.text))), review.groups.find(g => g.id === "level"));
    check("Review: STR 15 + 2 = 17 line", review.groups.find(g => g.id === "abilities")?.lines.some(l => l.text === "STR 15 + 2 = 17"), review.groups.find(g => g.id === "abilities"));
    check("Review: equipment group names package A", review.groups.find(g => g.id === "equipment")?.lines.some(l => /Chain Mail/.test(l.text)), review.groups.find(g => g.id === "equipment"));
    const fighter = await commitAndCheck(c);
    const bag = fighter.items.find(i => i.name === "Dungeoneer's Pack");
    check("saved: Fighter 1, STR 17, CON 14, HP 12", fighter.system.details.level === 1 && fighter.system.abilities.str.value === 17
      && fighter.system.abilities.con.value === 14 && fighter.system.attributes.hp.max === 12,
      { level: fighter.system.details.level, str: fighter.system.abilities.str.value, hp: fighter.system.attributes.hp.max });
    check("saved: Chain Mail, Greatsword, 8 Javelins", fighter.items.some(i => i.name === "Chain Mail") && fighter.items.some(i => i.name === "Greatsword")
      && fighter.items.find(i => i.name === "Javelin")?.system.quantity === 8, fighter.items.map(i => `${i.name}×${i.system.quantity}`));
    check("saved: the pack holds its contents", bag && (await bag.system.contents).size > 0);
    check("saved: a gaming set and the trinket", fighter.items.some(i => i.type === "tool" && i.system.type?.value === "game")
      && fighter.items.some(i => i.type === "loot" && i.system.description.value.includes(foundry.utils.escapeHTML(eq.trinket.text))),
      fighter.items.map(i => `${i.type}:${i.name}`));
    check("saved: 18 GP (Fighter A 4 + Soldier A 14 from the book), alignment, two biography paragraphs", fighter.system.currency.gp === 18 && fighter.system.details.alignment === "Lawful Good"
      && (fighter.system.details.biography.value.match(/<p>/g) ?? []).length === 2, { gp: fighter.system.currency.gp, bio: fighter.system.details.biography.value });
    // Data fix 5: starting gear worn and wielded, as D&D Beyond does.
    const worn = a => a.items.filter(i => i.system.equipped && !i.system.container).map(i => i.name).sort();
    check("saved Fighter: Chain Mail worn, weapons in hand, AC 17 (Chain Mail 16 + Defense)", fighter.system.attributes.ac.value === 17
      && worn(fighter).includes("Chain Mail") && worn(fighter).includes("Greatsword") && fighter.items.some(i => i.name === "Defense"),
      { ac: fighter.system.attributes.ac.value, worn: worn(fighter) });
    check("saved Fighter: Common plus the two chosen languages (Abyssal, Aquan)", ["common", "abyssal", "aquan"].every(k => fighter.system.traits.languages.value.has(k)),
      Array.from(fighter.system.traits.languages.value));
    check("saved: change log entry of kind creation", fighter.getFlag(moduleId, "changeLog")?.[0]?.kind === "creation");
    // Data fix 1: what dnd5e's item _onCreate would have set (species / background links, speed from the species).
    const links = a => ({ race: a.system.details.race?.name ?? a.system._source.details.race, background: a.system.details.background?.name ?? a.system._source.details.background,
      walk: a.system.attributes.movement.walk, slowed: a.system.attributes.movement.slowed, darkvision: a.system.attributes.senses.ranges?.darkvision ?? a.system.attributes.senses.darkvision,
      casting: a.system.attributes.spellcasting, dc: a.system.attributes.spell?.dc ?? a.system.attributes.spelldc });
    let l = links(fighter);
    check("saved Fighter: species Human and background Soldier linked, walking speed 30, not slowed", l.race === "Human" && l.background === "Soldier"
      && l.walk === 30 && !l.slowed && fighter.system._source.details.race === fighter.items.find(i => i.type === "race")?.id, l);
    check("saved: the owner (the GM here) is OWNER; assigned only if they had no character",
      fighter.testUserPermission(game.user, "OWNER") && (characterBefore ? game.user.character?.id === characterBefore : game.user.character?.id === fighter.id),
      { characterBefore, now: game.user.character?.id });
    check("draft cleared after commit", !createCreationController({ moduleId, t }).hasDraft());
    const flagAfter = builderFlag();
    check("commit deletes only creationJson / creationRolls (other builder keys kept)", !("creationJson" in flagAfter) && !("creationRolls" in flagAfter)
      && JSON.stringify(Object.keys(flagAfter).filter(k => !k.startsWith("creation")).sort()) === otherKeysBefore, { keys: Object.keys(flagAfter), otherKeysBefore });
    let twice = "";
    try { await c.commit(); } catch (error) { twice = error.message; }
    check("Create can't run twice", /already been created/.test(twice) && game.actors.filter(a => a.name === "CB Create Fighter").length === 1, twice);

    // ---- 2. Wood Elf Acolyte Cleric, tabs in a free order
    c = createCreationController({ moduleId, t });
    await c.start({});
    ab = await c.setAbilities({ method: "standardArray", assignments: {} });
    check("standard array: six slots, nothing placed", ab.slots.length === 6 && ab.base.str === null);
    // An older (2014) background has no increase: the tab says so instead of looking silently done.
    await game.settings.set(moduleId, "builderSources", { ...sourcesBefore, rules: "both" });
    const legacy = Array.from(await game.packs.get("dnd5e.backgrounds")?.getIndex() ?? []).find(e => e.name === "Acolyte");
    if (legacy) {
      v = await c.pick("background", `Compendium.dnd5e.backgrounds.Item.${legacy._id}`);
      check("2014 background: \"no ability score increase\" note", /no ability score increase/.test(v.note ?? ""), v);
    }
    await game.settings.set(moduleId, "builderSources", sourcesBefore);
    v = await c.pickScreen("background");
    v = await c.pick("background", optionNamed(v, "Acolyte").uuid);
    states = c.tabs();
    check("background picked but unanswered → attention; class still todo", states.background === "attention" && states.class === "todo", states);
    v = await c.segment("class");
    await play(c, "class", await c.pick("class", optionNamed(v, "Wizard").uuid));
    await c.setEquipment("class", { option: "A" });
    v = await c.pick("class", (await c.pickScreen("class")).options.find(o => o.name === "Cleric").uuid);
    check("changing the class clears its equipment", v.cleared.includes("equipment.class"), v.cleared);
    v = await play(c, "class", v, { want: ["skills:med", "skills:per"] }); // not the Acolyte's Insight / Religion
    check("Cleric class tab done (spells live on the Spells tab)", v.screen === "done", v);
    states = c.tabs();
    check("Spells tab appears for a Cleric", states.spells !== "hidden", states);
    v = await play(c, "spells", await c.segment("spells"));
    check("spells answered", v.screen === "answered", v);
    // With the house rule off, only the background's own pool (standard languages).
    await game.settings.set(moduleId, "builderHouseRules", { ...game.settings.get(moduleId, "builderHouseRules"), anyLanguage: false });
    models.length = 0;
    v = await play(c, "background", await c.segment("background"), { asi: { wis: 2, int: 1 },
      mixOnce: true, spellList: "class:cleric", ability: "wis", items: ["Thaumaturgy", "Spare the Dying", "Sanctuary"] });
    // Data fix 2: Acolyte's Magic Initiate offers spells from dnd5e's lists, one list for the whole feat, and the ability.
    const miCantrips = models.filter(m => m.type === "ItemChoice" && m.title === "Two Cantrips");
    const miSpell = models.find(m => m.type === "ItemChoice" && m.title === "Level 1 Spell");
    const miLists = ["class:cleric", "class:druid", "class:wizard"];
    check("step models name their source tab: Magic Initiate (granted by the Acolyte) → background",
      miCantrips.every(m => m.sourceTab === "background" && m.sourceName === "Acolyte"), miCantrips.map(m => [m.sourceTab, m.sourceName]));
    check("Magic Initiate cantrips: spells from the Cleric, Druid and Wizard lists, all cantrips, tagged with their lists; a list and an ability to pick",
      miCantrips[0]?.itemType === "spell" && miCantrips[0].count === 2 && miCantrips[0].options.length > 10 && miCantrips[0].options.every(o => o.level === 0 && o.lists.length && o.lists.every(k => miLists.includes(k)))
      && miCantrips[0].spellLists.map(x => x.key).join() === miLists.join() && miCantrips[0].abilityChoices?.map(x => x.key).join() === "int,wis,cha",
      miCantrips[0] && { count: miCantrips[0].count, n: miCantrips[0].options.length, lists: miCantrips[0].spellLists, ab: miCantrips[0].abilityChoices, sample: miCantrips[0].options.slice(0, 3) });
    check("Magic Initiate: a Wizard cantrip with a Druid cantrip is refused (one list per feat), and the step is asked again",
      miCantrips.length >= 2 && !miCantrips[1].answer, miCantrips.map(m => [m.error, m.answer]));
    // L20 fix 8: the Acolyte's Magic Initiate is the Cleric's, so both of its steps are locked to the Cleric list.
    check("Magic Initiate level 1 spell: level-1 spells; both of the feat's steps locked to the Acolyte's Cleric list",
      miSpell?.count === 1 && miSpell.options.length > 0 && miSpell.options.every(o => o.level === 1)
      && miSpell.list === "class:cleric" && miSpell.listLocked && miCantrips.at(-1)?.list === "class:cleric" && miCantrips.at(-1)?.listLocked,
      { spell: miSpell && { list: miSpell.list, n: miSpell.options.length }, cantrips: miCantrips.map(m => [m.list, m.listLocked]) });
    const acolyteLangs = models.find(m => m.type === "Trait" && /Languages/.test(m.title))?.slots.flatMap(sl => sl.options) ?? [];
    check("any language off: Acolyte's language choice offers standard languages only", acolyteLangs.length > 0 && acolyteLangs.every(o => o.key.startsWith("languages:standard:")),
      acolyteLangs.map(o => o.key));
    await game.settings.set(moduleId, "builderHouseRules", { ...game.settings.get(moduleId, "builderHouseRules"), anyLanguage: true });
    v = await c.segment("species");
    const elf = v.options.find(g => g.name === "Elf");
    check("Elf is one card with variants", elf?.variants.length >= 2, elf);
    await play(c, "species", await c.pick("species", elf.variants.find(x => /Wood/.test(x.name)).uuid));
    ab = c.abilities();
    const assignments = suggestedAssignments(ab.classIdentifier, ab.slots);
    ab = await c.setAbilities({ method: "standardArray", assignments });
    check("Suggested for Cleric: WIS 15 + 2 = 17, STR 14", ab.base.wis === 15 && ab.final.wis === 17 && ab.base.str === 14, ab.final);
    // A second controller resumes the same draft
    const c2 = createCreationController({ moduleId, t });
    const resumed = await c2.resume();
    check("draft resumes in a new controller with the same tab states", JSON.stringify(resumed) === JSON.stringify(c.tabs()), { resumed, now: c.tabs() });
    // Data fix 5, previewed on the replayed copy: Cleric package A wears its Chain Shirt and Shield.
    await c.setEquipment("class", { option: "A" });
    const preview = (await runCreation(store.creation(), { methods: ["standardArray"], rolls: store.creationRolls() })).final;
    const dexMod = preview.system.abilities.dex.mod;
    check("Cleric package A: Chain Shirt and Shield worn, Mace in hand, AC 13 + DEX (max 2) + 2", preview.system.attributes.ac.value === 13 + Math.min(dexMod, 2) + 2
      && ["Chain Shirt", "Shield", "Mace"].every(n => preview.items.some(i => i.name === n && i.system.equipped)),
      { ac: preview.system.attributes.ac.value, dexMod, worn: worn(preview) });
    eq = await c.setEquipment("class", { option: "B" });
    const holy = (await c.setEquipment("background", { option: "A" })).sections.find(s => s.source === "background").picks.find(p => p.type === "focus");
    check("Acolyte's holy focus offers the three holy symbols", holy?.candidates.length === 3, holy);
    await c.setEquipment("background", { option: "A", picks: { [holy.id]: holy.candidates[0].uuid } });
    review = await c.review();
    check("Review blocks without a name", review.blockers.some(b => b.tab === "details"), review.blockers);
    let refused = false;
    try { await c.commit(); } catch { refused = true; }
    check("commit refuses an unfinished draft", refused);
    await c.setDetails({ name: "CB Create Cleric", alignment: "", biography: "" });
    const cleric = await commitAndCheck(c);
    check("saved Cleric: 118 GP (class gold 110 + Acolyte A 8), WIS 17, spells", cleric.system.currency.gp === 118 && cleric.system.abilities.wis.value === 17
      && cleric.items.filter(i => i.type === "spell").length >= 3, { gp: cleric.system.currency.gp, wis: cleric.system.abilities.wis.value, spells: cleric.items.filter(i => i.type === "spell").map(i => i.name) });
    check("saved Cleric: an Amulet/Emblem/Reliquary", cleric.items.some(i => i.uuid && holy.candidates.some(h => h.name === i.name)));
    const initiate = cleric.items.filter(i => i.type === "spell" && i.system.sourceItem === "feat:magic-initiate");
    check("saved Cleric: Magic Initiate's two Cleric cantrips and one level-1 spell, cast with WIS",
      initiate.length === 3 && initiate.filter(i => i.system.level === 0).length === 2 && initiate.every(i => i.system.ability === "wis")
      && initiate.every(i => miCantrips[0].options.concat(miSpell.options).some(o => o.name === i.name && o.lists.includes("class:cleric"))),
      initiate.map(i => `${i.name} L${i.system.level} ${i.system.ability}`));
    l = links(cleric);
    check("saved Cleric: Wood Elf + Acolyte linked, speed 35, darkvision 60, casts with WIS (spell save DC 13)", l.race === "Elf, Wood" && l.background === "Acolyte"
      && l.walk === 35 && !l.slowed && l.darkvision === 60 && l.casting === "wis" && l.dc === 13, l);
    check("saved Cleric: the Wood Elf's level-1 Druidcraft (asked in the class segment, now that the species is linked)",
      cleric.items.some(i => i.type === "spell" && i.name === "Druidcraft" && i.getFlag("dnd5e", "advancementOrigin")), cleric.items.filter(i => i.type === "spell").map(i => i.name));

    // ---- 3. Halfling Sage Bard: rolling and the instrument link
    c = createCreationController({ moduleId, t });
    await c.start({});
    let badDice = false;
    try { await c.enterDice([18, 2, 10, 10, 10, 10]); } catch { badDice = true; }
    check("Enter my dice refuses a 2", badDice);
    ab = await c.enterDice([18, 3, 10, 11, 12, 13]);
    check("entered dice become six slots", ab.answer.method === "manual" && ab.slots.length === 6, ab.answer);
    ab = await c.rollAbilities();
    check("roll: one set of six, 3–18 each", ab.rolls.sets === 1 && ab.slots.length === 6 && ab.slots.every(s => s.value >= 3 && s.value <= 18), ab.slots);
    ab = await c.rollAbilities();
    check("one reroll allowed; the new set replaces the old", ab.rolls.sets === 2 && ab.rolls.rerollsLeft === 0, ab.rolls);
    let noMore = false;
    try { await c.rollAbilities(); } catch { noMore = true; }
    check("a third roll is refused", noMore);
    const rolledBefore = ab.slots.map(x => x.value).join();
    eq = await c.rollTrinket();
    const bardTrinket = eq.trinket?.text;
    // Start over: the draft goes, the rolls stay (no fresh rolls by starting again).
    await c.discard();
    check("Start over deletes the draft key only", !("creationJson" in builderFlag()) && "creationRolls" in builderFlag(), Object.keys(builderFlag()));
    c = createCreationController({ moduleId, t });
    check("Start over: no draft in a new controller", !c.hasDraft());
    await c.start({});
    ab = c.abilities();
    check("Start over keeps both rolled sets and the used reroll", ab.rolls.sets === 2 && ab.rolls.rerollsLeft === 0 && ab.rolled.map(x => x.value).join() === rolledBefore, { rolls: ab.rolls, rolled: ab.rolled, rolledBefore });
    let afterStartOver = false;
    try { await c.rollAbilities(); } catch { afterStartOver = true; }
    check("no new roll after Start over", afterStartOver);
    check("Start over keeps the trinket", (await c.equipment()).trinket?.text === bardTrinket && (await c.rollTrinket()).trinket?.text === bardTrinket, (await c.equipment()).trinket);
    const latest = ab.rolled;
    v = await c.segment("class");
    await play(c, "class", await c.pick("class", optionNamed(v, "Bard").uuid), { traitFilter: o => !o.key.startsWith("tool:") || /lute|flute|drum/.test(o.key),
      want: ["skills:prf", "skills:dec", "skills:per"] }); // not the Sage's Arcana / History
    ab = c.abilities();
    ab = await c.setAbilities({ method: "roll", assignments: suggestedAssignments("bard", ab.rolled) }); // the new draft starts on the first method
    check("rolled values placed: CHA gets the highest", ab.base.cha === Math.max(...latest.map(s => s.value)), { base: ab.base, latest });
    await play(c, "spells", await c.segment("spells"));
    v = await c.segment("background");
    await play(c, "background", await c.pick("background", optionNamed(v, "Sage").uuid));
    v = await c.segment("species");
    await play(c, "species", await c.pick("species", v.options.find(g => g.name === "Halfling").variants[0].uuid));
    eq = await c.setEquipment("class", { option: "A" });
    const instrument = eq.sections.find(s => s.source === "class").picks.find(p => p.type === "tool");
    check("Bard's instrument pick offers only the three chosen instruments", instrument?.linked && instrument.candidates.length === 3, instrument);
    // A saved pick that is no longer a candidate (Equipment filled before the class proficiencies changed) doesn't count.
    const stale = Object.values(CONFIG.DND5E.tools).map(x => x.id).find(id => id && !instrument.candidates.some(cand => cand.uuid === id));
    eq = await c.setEquipment("class", { option: "A", picks: { [instrument.id]: stale } });
    const staleSection = eq.sections.find(s => s.source === "class");
    review = await c.review();
    check("stale instrument pick: nothing selected, section and tab unfinished, Review blocks", staleSection.picks.find(p => p.id === instrument.id)?.value === null
      && !staleSection.complete && c.tabs().equipment !== "done" && review.blockers.some(b => b.tab === "equipment"),
      { value: staleSection.picks.find(p => p.id === instrument.id)?.value, complete: staleSection.complete, tabs: c.tabs(), blockers: review.blockers });
    // A class the GM bans after it was picked needs a new pick (spec §6), like a source switched off.
    const rulesNow = game.settings.get(moduleId, "builderHouseRules");
    await game.settings.set(moduleId, "builderHouseRules", { ...rulesNow, bannedClasses: ["bard"] });
    const banned = await c.segment("class");
    review = await c.review();
    check("banned after the pick: Class says no longer available and blocks", banned.screen === "error" && /No longer available/.test(banned.error)
      && c.tabs().class === "attention" && review.blockers.some(b => b.tab === "class"), { banned, tabs: c.tabs() });
    await game.settings.set(moduleId, "builderHouseRules", rulesNow);
    check("unbanned: Class is done again", (await c.segment("class")).screen === "done" && (await c.review(), c.tabs().class === "done"), c.tabs());
    await c.setEquipment("class", { option: "A", picks: { [instrument.id]: instrument.candidates[0].uuid } });
    await c.setEquipment("background", { option: "B" });
    await c.setDetails({ name: "CB Create Bard", alignment: "", biography: "" });
    check("details saved without a replay; the tab is done", c.tabs().details === "done" && createCreationController({ moduleId, t }).home().draft?.name === "CB Create Bard");
    const bard = await commitAndCheck(c);
    check("saved Bard: the chosen instrument and 50 GP + package gold", bard.items.some(i => i.name === instrument.candidates[0].name) && bard.system.currency.gp >= 50,
      { gp: bard.system.currency.gp });
    l = links(bard);
    check("saved Bard: Halfling + Sage linked, speed 30, casts with CHA (DC 8 + 2 + CHA mod)", l.race === "Halfling" && l.background === "Sage" && l.walk === 30
      && l.casting === "cha" && l.dc === 10 + bard.system.abilities.cha.mod, l);
    check("saved Bard: the trinket rolled before Start over", bard.items.some(i => i.type === "loot" && i.system.description.value.includes(foundry.utils.escapeHTML(bardTrinket))));
    const summary = game.messages.find(m => !messagesBefore.has(m.id) && /created this character/.test(m.content) && m.content.includes("CB Create Bard"));
    check("GM summary card lists both rolled sets", /Rolled set 1/.test(summary?.content ?? "") && /Rolled set 2/.test(summary?.content ?? ""), summary?.content?.slice(0, 400));
    check("Create clears the rolls", store.creationRolls().abilities.sets.length === 0 && !store.creationRolls().trinket && !("creationRolls" in builderFlag()), Object.keys(builderFlag()));
    const rollCards = game.messages.filter(m => !messagesBefore.has(m.id) && /ability scores/.test(m.content));
    check("chat has both roll sets and the entered dice", rollCards.length === 3, rollCards.length);

    // ---- 4. Dwarf Criminal Rogue, class before background (data fix 4)
    c = createCreationController({ moduleId, t });
    await c.start({});
    v = await c.segment("class");
    const sneaky = ["skills:ste", "skills:slt"];
    v = await play(c, "class", await c.pick("class", optionNamed(v, "Rogue").uuid), { want: sneaky });
    check("Rogue answered first: Stealth and Sleight of Hand among its skills, class done", v.screen === "done"
      && sneaky.every(k => traitsOfClass(c).includes(k)), traitsOfClass(c));
    v = await c.segment("background");
    await play(c, "background", await c.pick("background", optionNamed(v, "Criminal").uuid), { asi: { dex: 2, con: 1 } });
    v = await c.segment("species");
    await play(c, "species", await c.pick("species", v.options.find(g => g.name === "Dwarf").variants[0].uuid));
    review = await c.review();
    const conflictBlock = review.blockers.find(b => b.tab === "class" && b.kind === "conflict");
    check("Criminal grants them too: Class needs attention, Review says they're already granted by the background",
      c.tabs().class === "attention" && /already granted by your background/.test(conflictBlock?.text ?? "") && /Stealth/.test(conflictBlock?.text ?? ""),
      { tabs: c.tabs(), blockers: review.blockers });
    let cached = await sameWithCache();
    check("cached replay = uncached replay (conflicted Rogue draft)", cached.same && cached.hits === 3, cached);
    v = await c.segment("class");
    const conflicted = v.model;
    check("the Class tab re-opens that step with the saved answer, without the granted skills, and says why",
      v.screen === "step" && conflicted?.type === "Trait" && sneaky.every(k => conflicted.conflicts.some(x => x.key === k && x.tab === "background"))
      && !conflicted.slots.some(sl => sl.options.some(o => sneaky.includes(o.key))) && sneaky.every(k => conflicted.answer?.chosen?.includes(k))
      && /background/.test(conflicted.conflictText ?? "") && conflicted.sourceTab === "class", { screen: v.screen, model: conflicted && { type: conflicted.type, conflicts: conflicted.conflicts, text: conflicted.conflictText, answer: conflicted.answer } });
    models.length = 0;
    v = await play(c, "class", v, { want: sneaky });
    const expertise = models.find(m => m.type === "Trait" && m.mode === "expertise");
    check("Expertise is asked again and offers Stealth and Sleight of Hand (proficient through Criminal)",
      sneaky.every(k => expertise?.slots.some(sl => sl.options.some(o => o.key === k))), expertise?.slots);
    review = await c.review();
    check("fixed: Class done, no conflict in Review", v.screen === "done" && c.tabs().class === "done" && !review.blockers.some(b => b.kind === "conflict"),
      { screen: v.screen, tabs: c.tabs(), blockers: review.blockers });
    ab = c.abilities();
    await c.setAbilities({ method: "standardArray", assignments: suggestedAssignments("rogue", ab.slots) });
    await c.setEquipment("class", { option: "A" });
    await c.setEquipment("background", { option: "A" });
    await c.setDetails({ name: "CB Create Rogue", alignment: "", biography: "" });
    cached = await sameWithCache();
    check("cached replay = uncached replay (finished Rogue draft, with equipment)", cached.same, cached);
    const rogue = await commitAndCheck(c);
    // The Trait choice port (performance) gives dnd5e's own results on every Trait advancement of the saved Rogue.
    const traitShape = r => JSON.stringify({ a: r.available.map(x => [x.type, x.choiceIdx ?? null, x.choices.asOptions()]), c: r.choices.asOptions() });
    const portDiffs = [];
    let compared = 0;
    for (const item of rogue.items) for (const adv of item.advancement?.byType?.Trait ?? []) for (const chosen of [new Set(), undefined]) {
      compared++;
      if (traitShape(await adv.unfulfilledChoices(chosen)) !== traitShape(await unfulfilledChoices(adv, undefined, chosen))) portDiffs.push(`${item.name}: ${adv.title}`);
    }
    check("Trait choice port = dnd5e's unfulfilledChoices on every Rogue Trait advancement", compared > 10 && !portDiffs.length, { compared, portDiffs });
    // …and on pools where a category sits next to keys under it (dnd5e merges one filter per key).
    const TraitAdv = CONFIG.DND5E.advancementTypes.Trait.documentClass ?? CONFIG.DND5E.advancementTypes.Trait;
    const rogueClass = rogue.items.find(i => i.type === "class");
    const nestedDiffs = [];
    for (const pool of [["tool:art", "tool:art:alchemist"], ["tool:art:alchemist", "tool:art"], ["weapon:mar", "weapon:mar:longsword", "skills:ath"], ["languages:standard", "languages:standard:elvish"]]) {
      const adv = new TraitAdv({ type: "Trait", configuration: { grants: [], choices: [{ count: 1, pool }] } }, { parent: rogueClass });
      if (traitShape(await adv.unfulfilledChoices()) !== traitShape(await unfulfilledChoices(adv))) nestedDiffs.push(pool.join("+"));
    }
    check("Trait choice port = dnd5e on pools mixing a category and keys under it", !nestedDiffs.length, nestedDiffs);
    l = links(rogue);
    check("saved Rogue: Dwarf + Criminal, darkvision 120, Leather Armor worn, AC 14 (11 + DEX 17)", l.race === "Dwarf" && l.background === "Criminal"
      && l.darkvision === 120 && rogue.system.abilities.dex.value === 17 && rogue.system.attributes.ac.value === 14 && worn(rogue).includes("Leather Armor"),
      { l, dex: rogue.system.abilities.dex.value, ac: rogue.system.attributes.ac.value, worn: worn(rogue) });
    check("saved Rogue: Stealth with expertise, no class pick wasted on a background skill",
      rogue.system.skills.ste.value === 2 && rogue.system.skills.slt.value === 2
      && !(rogue.items.find(i => i.type === "class")?.advancement.byType.Trait ?? []).some(a => a.configuration.mode === "default" && sneaky.some(k => a.value.chosen?.has(k) && !a.configuration.grants.has(k))),
      { ste: rogue.system.skills.ste.value, slt: rogue.system.skills.slt.value });

    // ---- 5. High Elf Wizard, species first (data fix 2): the species' level-1 cantrip asks for its spellcasting ability.
    c = createCreationController({ moduleId, t });
    await c.start({});
    v = await c.segment("species");
    await play(c, "species", await c.pick("species", v.options.find(g => g.name === "Elf").variants.find(x => /High/.test(x.name)).uuid));
    v = await c.segment("class");
    v = await c.pick("class", optionNamed(v, "Wizard").uuid);
    check("High Elf Wizard: the species' level-1 grant is a class-segment step asking Intelligence, Wisdom or Charisma",
      v.model?.type === "ItemGrant" && /High Elf/.test(v.model.title) && v.model.abilityChoices?.map(x => x.key).join() === "int,wis,cha" && v.model.items.some(i => i.name === "Prestidigitation")
      && v.model.sourceTab === "species" && v.model.sourceName === "Elf, High",
      v.model && { type: v.model.type, title: v.model.title, ab: v.model.abilityChoices, items: v.model.items?.map(i => i.name), source: [v.model.sourceTab, v.model.sourceName] });
    await play(c, "class", v, { ability: "cha" });
    const elfPreview = (await runCreation(store.creation(), { methods: ["standardArray"], rolls: store.creationRolls() })).final;
    const prestidigitation = elfPreview.items.find(i => i.name === "Prestidigitation" && i.getFlag("dnd5e", "advancementOrigin"));
    check("High Elf's Prestidigitation is cast with the chosen ability (CHA)", prestidigitation?.system.ability === "cha", prestidigitation?.system.ability);
    await c.discard();
  } catch (error) {
    check(`no exception (${error.message})`, false, error.stack?.slice(0, 800));
  } finally {
    for (const a of created) await a?.delete().catch(() => {});
    await store.finishCreation().catch(() => {}); // the draft and any rolls of an interrupted run
    await game.settings.set(moduleId, "builderHouseRules", rulesBefore);
    await game.settings.set(moduleId, "builderSources", sourcesBefore);
    await game.user.update({ character: characterBefore });
    const newMessages = game.messages.filter(m => !messagesBefore.has(m.id) && m.author?.id === game.user.id).map(m => m.id);
    if (newMessages.length) await ChatMessage.deleteDocuments(newMessages);
  }
  return { checks, log };
});
await browser.close();
let failed = 0;
for (const c of result.checks) { if (!c.ok) failed++; console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info ?? "").slice(0, 600)); }
console.log(`\n${result.checks.length - failed}/${result.checks.length} passed`);
if (failed) console.log(result.log.join("\n"));
process.exit(failed ? 1 : 0);
