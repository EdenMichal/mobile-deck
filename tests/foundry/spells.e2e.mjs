// End-to-end test of the Phase 3 spell step (no UI) in test-5e-world, as Claude Test GM.
// Wizard 1→4 (cantrips, spellbook, prepare from book, cantrip swap, edit from Review), a Bard
// spell swap at 5, no step for a Fighter, a draft resumed on the spell step, and the no-list fallback.
// Creates and deletes throwaway actors, chat cards and user flags.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/spells.e2e.mjs
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const { browser, page } = await joinTestWorld();
await pinToSrd(page); // the suite's expectations are for dnd5e's SRD content, not the user's books (pin-srd.mjs)
const result = await page.evaluate(async () => {
  const checks = [];
  const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
  const base = "/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder";
  const { createBuilderController } = await import(`${base}/builder-gateway.mjs`);
  const { spellsForClass } = await import(`${base}/content-sources.mjs`);
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const classUuid = async name => (await game.packs.get("dnd5e.classes24").getIndex()).find(e => e.type === "class" && e.name === name)?.uuid;
  const abilities = { str: { value: 10 }, dex: { value: 14 }, con: { value: 14 }, int: { value: 16 }, wis: { value: 12 }, cha: { value: 15 } };
  const actors = [];
  const userFlagsBefore = foundry.utils.deepClone(game.user.getFlag(moduleId, "builder") ?? null);
  const messagesBefore = new Set(game.messages.map(m => m.id));
  const log = [];
  const newActor = async name => { const a = await Actor.implementation.create({ name, type: "character", system: { abilities } }); actors.push(a); return a; };
  const spellNames = (actor, filter = () => true) => actor.items.filter(i => i.type === "spell" && filter(i)).map(i => i.name).sort();

  // Default spell answer: the first offered spells for each counter.
  const defaultSpells = m => {
    const pick = (filter, n) => m.options.filter(filter).slice(0, n).map(o => o.uuid);
    const cantrips = pick(o => o.level === 0, m.owed.cantrips);
    const spells = pick(o => o.level > 0, m.owed.spellbookClass ? m.owed.spellbook : m.owed.prepared);
    return { cantrips, spells, prepare: m.owed.spellbookClass ? spells.slice(0, m.owed.prepared) : [], swaps: [] };
  };
  // Answer every screen the way a player would; `spells(model)` can override the spell answer.
  const play = async (c, view, prefs = {}) => {
    let guard = 0;
    while (view.screen === "step" && guard++ < 40) {
      const m = view.model;
      log.push(`${m.type}: ${m.title} (${m.item} L${m.level})`);
      let data, meta;
      if (m.type === "HitPoints") { data = { value: "avg" }; meta = { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod, modLabel: m.modLabel } }; }
      else if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); data = { chosen: [...chosen] }; }
      else if (m.type === "ItemChoice") data = { selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) };
      else if (m.type === "Subclass") { data = { uuid: (m.options.find(o => o.name === prefs.subclass) ?? m.options[0]).uuid }; meta = { kind: "subclass" }; }
      else if (m.type === "AbilityScoreImprovement") data = { type: "asi", assignments: { con: 1, dex: 1 } };
      else if (m.type === "Size") data = { size: m.options[0].key };
      else if (m.type === "ItemGrant") data = { selected: m.items.map(i => i.uuid) };
      else if (m.type === "Spells") { data = prefs.spells ? prefs.spells(m) : defaultSpells(m); meta = { kind: "spells", warnings: [] }; }
      else throw new Error(`Unexpected screen ${m.type}`);
      view = await c.answer(data, meta);
    }
    return view;
  };

  try {
    // Spell lists
    const wizList = await spellsForClass("wizard", { maxLevel: 2 });
    const wizNames = new Set(wizList.spells.map(s => s.name));
    check("Wizard list (≤ level 2) has Misty Step and Fire Bolt", wizNames.has("Misty Step") && wizNames.has("Fire Bolt"), [...wizNames].slice(0, 20));
    check("Wizard list leaves out Cure Wounds (not a Wizard spell) and Fireball (level 3)", !wizNames.has("Cure Wounds") && !wizNames.has("Fireball"));
    check("Wizard list is registered (noList false)", wizList.noList === false);
    const none = await spellsForClass("runesmith", { maxLevel: 1 });
    check("a class with no list gets every allowed spell and noList", none.noList === true && none.spells.some(s => s.name === "Cure Wounds"), none.noList);

    // Wizard 1 (new class): 3 cantrips, 6 spellbook spells, 4 prepared
    const wizard = await newActor("CB Spells Wizard");
    const c = createBuilderController(wizard, { moduleId });
    let view = await c.start({ kind: "new-class", classUuid: await classUuid("Wizard"), label: "New class: Wizard 1" });
    let spellModel = null;
    view = await play(c, view, { spells: m => { spellModel = m; return defaultSpells(m); } });
    check("Wizard 1 has a Spells step", Boolean(spellModel), log);
    check("Wizard 1 owes 3 cantrips, 6 spellbook, 4 prepared", spellModel?.owed.cantrips === 3 && spellModel.owed.spellbook === 6 && spellModel.owed.prepared === 4, spellModel?.owed);
    check("Wizard 1 options stop at level 1", spellModel?.options.every(o => o.level <= 1), spellModel?.options.filter(o => o.level > 1).map(o => o.name));
    check("review has a Spells group", view.groups?.some(g => g.id === "spells"), view.groups?.map(g => g.id));
    await c.commit();
    const wizSpells = wizard.items.filter(i => i.type === "spell");
    check("Wizard 1 committed: 3 cantrips + 6 spellbook spells", wizSpells.filter(s => s.system.level === 0).length === 3 && wizSpells.filter(s => s.system.level > 0).length === 6, spellNames(wizard));
    check("spells are linked to the Wizard class", wizSpells.every(s => s.system.sourceItem === "class:wizard" && s.system.classIdentifier === "wizard"), wizSpells.map(s => s.system.sourceItem));
    check("dnd5e counts 4 prepared of 4", wizard.classes.wizard.system.spellcasting.preparation.value === 4 && wizard.classes.wizard.system.spellcasting.preparation.max === 4,
      wizard.classes.wizard.system.spellcasting.preparation);

    // Wizard 2 and 3 with default picks (2 spellbook + 1 prepared each)
    const wizardId = wizard.classes.wizard.id;
    await play(c, await c.start({ kind: "level", classId: wizardId }));
    await c.commit();
    await play(c, await c.start({ kind: "level", classId: wizardId }));
    await c.commit();
    check("Wizard 3: 10 spellbook spells, 6 prepared", wizard.items.filter(i => i.type === "spell" && i.system.level > 0).length === 10
      && wizard.classes.wizard.system.spellcasting.preparation.value === 6, wizard.classes.wizard.system.spellcasting.preparation);

    // Wizard 4: new cantrip, Misty Step + 1 to the spellbook, prepare an EXISTING book spell.
    // A cantrip swap is sent too and must be ignored: 2024 Wizards swap cantrips on a Long Rest.
    const unpreparedBook = wizard.items.find(i => i.type === "spell" && i.system.level > 0 && i.system.prepared === 0);
    const oldCantrip = wizard.items.find(i => i.type === "spell" && i.system.level === 0);
    let swapIn = null;
    view = await play(c, await c.start({ kind: "level", classId: wizardId }), { spells: m => {
      spellModel = m;
      const misty = m.options.find(o => o.name === "Misty Step");
      const other = m.options.find(o => o.level > 0 && o.uuid !== misty.uuid);
      const cantrips = m.options.filter(o => o.level === 0);
      swapIn = cantrips[1];
      return { cantrips: [cantrips[0].uuid], spells: [misty.uuid, other.uuid], prepare: [`item:${unpreparedBook.id}`], swaps: [{ out: oldCantrip.id, in: swapIn.uuid }] };
    } });
    check("Wizard 4 owes 1 cantrip, 2 spellbook, 1 prepared, and no swaps",
      spellModel.owed.cantrips === 1 && spellModel.owed.spellbook === 2 && spellModel.owed.prepared === 1 && !spellModel.owed.swapCantrip && !spellModel.owed.swapSpell, spellModel.owed);
    check("Wizard 4 options reach level 2", spellModel.options.some(o => o.level === 2) && spellModel.options.every(o => o.level <= 2));
    check("known spells are not offered again", !spellModel.options.some(o => o.name === unpreparedBook.name));
    const lines = view.groups.find(g => g.id === "spells")?.lines ?? [];
    const texts = lines.map(l => l.text);
    check("review: Added to spellbook: Misty Step", texts.includes("Added to spellbook: Misty Step"), texts);
    check(`review: Prepared ${unpreparedBook.name}`, texts.includes(`Prepared ${unpreparedBook.name}`), texts);
    check("review: no Replaced line for a Wizard", !texts.some(text => text.startsWith("Replaced")), texts);
    check("every spell line links back to a step", lines.every(l => l.step !== undefined), lines);
    // Edit from Review: reopen the spell step, keep the saved answer, return to Review
    const spellLine = lines.find(l => l.text === "Added to spellbook: Misty Step");
    view = await c.edit(spellLine.step);
    check("edit reopens the Spells step with the saved answer", view.model?.type === "Spells" && view.model.answer?.spells?.length === 2, view.model?.type);
    view = await c.answer(view.model.answer, { kind: "spells", warnings: [] });
    check("answering again returns to Review", view.screen === "review", view.screen);
    await c.commit();
    check("Wizard 4 committed: Misty Step unprepared, book spell prepared, old cantrip kept",
      wizard.items.some(i => i.name === "Misty Step" && i.system.prepared === 0)
      && wizard.items.get(unpreparedBook.id)?.system.prepared === 1
      && Boolean(wizard.items.get(oldCantrip.id)) && !wizard.items.some(i => i.name === swapIn.name), spellNames(wizard));
    check("Wizard 4: 4 cantrips, 7 prepared", wizard.items.filter(i => i.type === "spell" && i.system.level === 0).length === 4
      && wizard.classes.wizard.system.spellcasting.preparation.value === 7, wizard.classes.wizard.system.spellcasting.preparation);

    // Drafts: stop on the Spells step at Wizard 5, resume from a new controller
    view = await c.start({ kind: "level", classId: wizardId });
    let guard = 0;
    while (view.screen === "step" && view.model.type !== "Spells" && guard++ < 20) {
      const m = view.model;
      if (m.type === "HitPoints") view = await c.answer({ value: "avg" }, { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod, modLabel: m.modLabel } });
      else if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); view = await c.answer({ chosen: [...chosen] }); }
      else if (m.type === "ItemChoice") view = await c.answer({ selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) });
      else throw new Error(`draft test: unexpected ${m.type}`);
    }
    check("Wizard 5 stops on the Spells step", view.model?.type === "Spells", view.model?.type);
    const c2 = createBuilderController(wizard, { moduleId });
    const resumed = await c2.resume();
    check("a resumed draft opens on the Spells step", resumed?.model?.type === "Spells" && resumed.model.owed.maxSpellLevel === 3, resumed?.model?.type);
    // Warnings come from what was applied: a pick that no longer exists is dropped, and Review says so
    // even though the saved answer claims no warnings.
    const goneReview = await c2.answer({ cantrips: [], spells: ["Compendium.dnd5e.spells24.Item.doesNotExist0000"], prepare: [], swaps: [] }, { kind: "spells", warnings: [] });
    const goneTexts = goneReview.groups?.find(g => g.id === "spells")?.lines.map(l => l.text) ?? [];
    check("Review warns about picks that were dropped", goneTexts.includes("Not chosen yet: 2 spellbook spells"), goneTexts);
    await c2.discardDraft();

    // Warlock 2 → 3: pact slots reach level 2 (dnd5e's pact table)
    const warlock = await newActor("CB Spells Warlock");
    const w = createBuilderController(warlock, { moduleId });
    await play(w, await w.start({ kind: "new-class", classUuid: await classUuid("Warlock"), label: "New class: Warlock 1" }));
    await w.commit();
    await play(w, await w.start({ kind: "level", classId: warlock.classes.warlock.id }));
    await w.commit();
    let warlockModel = null;
    await play(w, await w.start({ kind: "level", classId: warlock.classes.warlock.id }), { spells: m => { warlockModel = m; return defaultSpells(m); } });
    check("Warlock 3 picks spells up to level 2 and may swap one", warlockModel?.owed.maxSpellLevel === 2 && warlockModel.owed.swapSpell
      && warlockModel.options.some(o => o.level === 2), warlockModel?.owed);
    await w.commit();
    check("Warlock spells use the pact method", warlock.items.filter(i => i.type === "spell").every(i => i.system.method === "pact"),
      warlock.items.filter(i => i.type === "spell").map(i => i.system.method));

    // Bard 4 → 5 swaps a level-1 spell for a level-3 spell
    const bard = await newActor("CB Spells Bard");
    const b = createBuilderController(bard, { moduleId });
    await play(b, await b.start({ kind: "new-class", classUuid: await classUuid("Bard"), label: "New class: Bard 1" }));
    await b.commit();
    const bardId = bard.classes.bard.id;
    for (let level = 2; level <= 4; level++) { await play(b, await b.start({ kind: "level", classId: bardId })); await b.commit(); }
    const outSpell = bard.items.find(i => i.type === "spell" && i.system.level === 1);
    const outCantrip = bard.items.find(i => i.type === "spell" && i.system.level === 0);
    let bardModel = null;
    let inSpell = null;
    let inCantrip = null;
    view = await play(b, await b.start({ kind: "level", classId: bardId }), { spells: m => {
      bardModel = m;
      inSpell = m.options.find(o => o.level === 3);
      inCantrip = m.options.find(o => o.level === 0);
      const picks = m.options.filter(o => o.level > 0 && o.uuid !== inSpell.uuid).slice(0, m.owed.prepared).map(o => o.uuid);
      return { cantrips: [], spells: picks, prepare: [], swaps: [{ out: outSpell.id, in: inSpell.uuid }, { out: outCantrip.id, in: inCantrip.uuid }] };
    } });
    check("Bard 5 owes 2 prepared and allows a spell and a cantrip swap", bardModel?.owed.prepared === 2 && bardModel.owed.swapSpell && bardModel.owed.swapCantrip, bardModel?.owed);
    const bardTexts = view.groups.find(g => g.id === "spells")?.lines.map(l => l.text) ?? [];
    check(`Bard review: Replaced ${outSpell.name} → ${inSpell?.name} and ${outCantrip.name} → ${inCantrip?.name}`,
      bardTexts.includes(`Replaced ${outSpell.name} → ${inSpell?.name}`) && bardTexts.includes(`Replaced ${outCantrip.name} → ${inCantrip?.name}`), bardTexts);
    await b.commit();
    check("Bard 5 committed: both swapped out, level-3 spell prepared, new cantrip added", !bard.items.get(outSpell.id) && !bard.items.get(outCantrip.id)
      && bard.items.some(i => i.name === inSpell.name && i.system.prepared === 1) && bard.items.some(i => i.name === inCantrip.name), spellNames(bard));

    // Fighter: no Spells step
    const fighter = await newActor("CB Spells Fighter");
    const f = createBuilderController(fighter, { moduleId });
    const before = log.length;
    await play(f, await f.start({ kind: "new-class", classUuid: await classUuid("Fighter"), label: "New class: Fighter 1" }));
    check("Fighter 1 has no Spells step", !log.slice(before).some(l => l.startsWith("Spells")), log.slice(before));
    await f.discardDraft();

    return { checks, log };
  } catch (error) {
    return { checks, log, error: `${error.message}\n${error.stack}` };
  } finally {
    for (const a of actors) await a.delete();
    for (const m of game.messages.filter(m => !messagesBefore.has(m.id))) await m.delete();
    if (userFlagsBefore === null) await game.user.unsetFlag(moduleId, "builder");
    else await game.user.setFlag(moduleId, "builder", userFlagsBefore);
  }
});
for (const c of result.checks) console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info)?.slice(0, 600));
if (result.error) console.log("ERROR", result.error);
console.log(`${result.checks.filter(c => c.ok).length}/${result.checks.length} passed`);
await browser.close();
