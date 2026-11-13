// Character creation with the user's real books: the user's own DDB Importer and homebrew packs, copied into the test
// world under a prefix (BOOKS_PACK_PREFIX). Skips cleanly when it is unset or no pack has it. No UI; as Claude Test GM.
// 1. PHB 2024 Noble + Goliath + Fighter: the background's ability increase the wizard adds (DDB has none), Common granted
//    (DDB's doubled key repaired), 2014 species hidden, class gold from a dice formula.
// 2. TCMP1 Night Stalker + Dwarf + Cleric: any-ability increase (no "Ability Scores" line), the book's 50 GP option, the
//    background's own trinket table, Divine Order (ItemChoice), spells.
// 3. A homebrew class + PHB 2024 Sage + Human: the copied books' Homebrew class with the most level-1 advancements (skipped
//    when there is none); its skills picked before the Sage and the Human give theirs are re-asked. The saved character
//    is checked against that class's own data: saves, hit die, spellcasting ability, level-1 features.
// Each is saved and checked like the creation audit: links, speed, senses, spellcasting, proficiencies, equipment, gold.
// Creates and deletes throwaway actors, chat cards and the user's creation draft.
// The packs' name prefix comes from BOOKS_PACK_PREFIX (no default); unset, the suite skips.
// Run: BOOKS_PACK_PREFIX=<prefix> PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/creation-books.e2e.mjs
import { joinTestWorld } from "./join.mjs";

const PREFIX = process.env.BOOKS_PACK_PREFIX ?? "";
if (!PREFIX) {
  console.log("SKIP set BOOKS_PACK_PREFIX to the name prefix of the copied book packs in the test world\n0/0 passed");
  process.exit(0);
}

const { browser, page } = await joinTestWorld();
const result = await page.evaluate(async PREFIX => {
  const checks = [];
  const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
  if (!game.packs.some(p => p.metadata.name.startsWith(PREFIX))) return { checks, log: [], skipped: `no ${PREFIX}* packs in this world` };
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const base = `/modules/${moduleId}/src/foundry/systems/dnd5e/builder`;
  const { createCreationController } = await import(`${base}/creation-controller.mjs`);
  const { suggestedAssignments } = await import(`${base}/creation-rules.mjs`);
  const { createDraftStore } = await import(`${base}/draft-store.mjs`);
  const store = createDraftStore(moduleId);
  const t = (k, f, d = {}) => String(f).replace(/\{(\w+)\}/g, (m, x) => (d[x] !== undefined ? String(d[x]) : m));
  const rulesBefore = foundry.utils.deepClone(game.settings.get(moduleId, "builderHouseRules") ?? {});
  const characterBefore = game.user.character?.id ?? null;
  // The test user's own creation draft and rolls are put back afterwards; only chat cards this test makes are deleted.
  const priorBuilder = foundry.utils.deepClone(game.user.getFlag(moduleId, "builder") ?? {});
  const priorCreation = { creationJson: priorBuilder.creationJson ?? null, creationRolls: priorBuilder.creationRolls ?? null };
  const testMessages = [];
  const trackMessage = Hooks.on("createChatMessage", m => { if (m.author?.id === game.user.id) testMessages.push(m.id); });
  const created = [];
  const log = [];
  const models = [];
  const books = uuid => String(uuid).includes(`.${PREFIX}`);

  const answerFor = (m, prefs = {}) => {
    if (m.type === "Trait") {
      const chosen = new Set();
      const left = s => s.count - s.options.filter(o => chosen.has(o.key)).length;
      for (const s of m.slots) s.options.filter(o => (prefs.want ?? []).includes(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key));
      for (const s of m.slots) if (left(s) > 0) s.options.filter(o => !chosen.has(o.key)).slice(0, left(s)).forEach(o => chosen.add(o.key));
      return { data: { chosen: [...chosen] } };
    }
    if (m.type === "ItemChoice") {
      let open = m.options.filter(o => !o.blockers.length);
      const extra = {};
      if (m.abilityChoices?.length) extra.ability = prefs.ability ?? m.ability;
      if (m.spellLists?.length > 1) { extra.list = m.list ?? m.spellLists[0].key; open = open.filter(o => o.lists.includes(extra.list)); }
      const liked = open.filter(o => (prefs.items ?? []).includes(o.name));
      return { data: { selected: [...liked, ...open.filter(o => !liked.includes(o))].slice(0, m.count).map(o => o.uuid), ...extra } };
    }
    if (m.type === "Size") return { data: { size: m.options.find(o => o.key === "med")?.key ?? m.options[0].key } };
    if (m.type === "ItemGrant") return { data: { selected: m.items.map(i => i.uuid), ...(m.abilityChoices?.length ? { ability: prefs.ability ?? m.ability } : {}) } };
    if (m.type === "AbilityScoreImprovement") {
      const open = Object.keys(m.scores).filter(k => !m.config.locked.includes(k));
      return { data: { type: "asi", assignments: prefs.asi ?? { [open[0]]: 2, [open[1]]: 1 } } };
    }
    if (m.type === "Spells") {
      const pick = (filter, n) => m.options.filter(filter).slice(0, n).map(o => o.uuid);
      const spells = pick(o => o.level > 0, m.owed.spellbookClass ? m.owed.spellbook : m.owed.prepared);
      return { data: { cantrips: pick(o => o.level === 0, m.owed.cantrips), spells, prepare: m.owed.spellbookClass ? spells.slice(0, m.owed.prepared) : [], swaps: [] }, meta: { kind: "spells", warnings: [] } };
    }
    throw new Error(`Unexpected screen ${m.type} (${m.title})`);
  };
  const play = async (c, tab, view, prefs) => {
    let guard = 0;
    while (view.screen === "step" && guard++ < 40) {
      log.push(`${tab}: ${view.model.type} ${view.model.title} [${view.model.sourceTab}]`);
      models.push({ tab, ...view.model, error: view.error ?? "" });
      const a = answerFor(view.model, prefs);
      view = await c.answer(tab, a.data, a.meta);
    }
    if (view.screen !== "done" && view.screen !== "answered" && view.screen !== "none") log.push(`${tab}: ended on ${view.screen} ${view.error ?? ""}`);
    return view;
  };
  const fromBooks = (options, name) => options.find(o => o.name === name && books(o.uuid));
  const speciesFromBooks = (groups, name) => groups.flatMap(g => g.variants).find(v => v.fullName === name && books(v.uuid));
  /** Equipment: an option (by id, or the gold card), then any open choice or pick takes its first entry. */
  const equip = async (c, source, want) => {
    let eq = await c.equipment();
    let section = eq.sections.find(s => s.source === source);
    const option = want === "gold" ? section.options.find(o => o.kind === "gold")?.id : want;
    const answer = { option, choices: {}, picks: {} };
    for (let round = 0; round < 4; round++) {
      eq = await c.setEquipment(source, answer);
      section = eq.sections.find(s => s.source === source);
      let changed = false;
      for (const ch of section.choices) if (!answer.choices[ch.id]) { answer.choices[ch.id] = ch.options[0].id; changed = true; }
      for (const p of section.picks) if (!answer.picks[p.id] && (p.value ?? p.candidates[0]?.uuid)) { answer.picks[p.id] = p.value ?? p.candidates[0].uuid; changed = true; }
      if (!changed) break;
    }
    return { eq, section };
  };
  const commit = async c => { const r = await c.commit(); const actor = game.actors.get(r.actor.id); created.push(actor); return actor; };
  const summary = a => ({
    race: a.system.details.race?.name ?? null, background: a.system.details.background?.name ?? null,
    walk: a.system.attributes.movement.walk, darkvision: a.system.attributes.senses.ranges?.darkvision ?? null,
    casting: a.system.attributes.spellcasting, dc: a.system.attributes.spell?.dc, hp: a.system.attributes.hp.max, ac: a.system.attributes.ac.value,
    abilities: Object.fromEntries(Object.entries(a.system.abilities).map(([k, v]) => [k, v.value])),
    skills: Object.entries(a.system.skills).filter(([, s]) => s.value > 0).map(([k, s]) => `${k}${s.value > 1 ? "*" : ""}`).sort(),
    saves: Object.entries(a.system.abilities).filter(([, s]) => s.proficient).map(([k]) => k),
    languages: [...a.system.traits.languages.value].sort(), armor: [...a.system.traits.armorProf.value].sort(), weapons: [...a.system.traits.weaponProf.value].sort(),
    tools: Object.entries(a.system.tools ?? {}).filter(([, t]) => t.value > 0).map(([k]) => k), gp: a.system.currency.gp,
    items: a.items.map(i => `${i.type}:${i.name}${i.system.equipped ? "(e)" : ""}`).sort()
  });

  try {
    await game.settings.set(moduleId, "builderHouseRules", { ...rulesBefore, abilityMethods: { standardArray: true, pointBuy: true, roll: false, manual: false } });
    await store.finishCreation();

    // ---- 1. PHB 2024 Noble + Goliath + Fighter
    let c = createCreationController({ moduleId, t });
    await c.start({});
    let v = await c.segment("class");
    const fighter = fromBooks(v.options, "Fighter");
    check("DDB classes in the class picker, the book as subtitle", fighter?.source === "PHB 2024", v.options.filter(o => o.name === "Fighter").map(o => [o.source, o.uuid]));
    v = await play(c, "class", await c.pick("class", fighter.uuid), { items: ["Defense"] });
    check("DDB Fighter: every class step answered", v.screen === "done", v);
    v = await c.segment("background");
    const noble = fromBooks(v.options, "Noble");
    const frhof = v.options.find(o => books(o.uuid) && o.book === "FRHoF");
    const tcmp1 = v.options.find(o => books(o.uuid) && o.book === "TCMP1");
    check("row tags: PHB 2024 Fighter \"5.5e Core\", a FRHoF background \"5.5e Expanded\", a TCMP1 background \"3rd party\"",
      fighter.tier?.label === "5.5e Core" && fighter.tier.tone === "core55" && frhof?.tier?.label === "5.5e Expanded" && frhof.tier.tone === "expanded55"
      && /^(5\.5e · )?3rd party$/.test(tcmp1?.tier?.label ?? "") && tcmp1.tier.tone === "other",
      { fighter: fighter.tier, frhof: frhof && [frhof.name, frhof.tier], tcmp1: tcmp1 && [tcmp1.name, tcmp1.tier] });
    check("PHB 2024 Noble offered (one card per book: the SRD 2014 Noble hidden in a 2024 world)", noble && !v.options.some(o => o.name === "Noble" && o.source === "SRD 5.1"), v.options.filter(o => o.name === "Noble").map(o => o.source));
    v = await c.pick("background", noble.uuid);
    check("Noble asks for its ability increase first (DDB stores none): +2/+1 among STR, INT, CHA",
      v.model?.type === "AbilityScoreImprovement" && v.model.config.points === 3 && v.model.config.cap === 2
      && v.model.config.locked.slice().sort().join() === "con,dex,wis" && v.model.sourceTab === "background", v.model && { type: v.model.type, config: v.model.config });
    v = await play(c, "background", v, { asi: { str: 2, int: 1 } });
    v = await c.segment("species");
    const goliath = speciesFromBooks(v.options, "Goliath");
    const variants = v.options.flatMap(g => g.variants);
    check("species: DDB Goliath (PHB 2024) offered; 2014 DDB species (MotM Shadar-kai) hidden in a 2024 world", goliath && !variants.some(x => /Shadar-kai/.test(x.fullName)),
      { goliath: Boolean(goliath), shadar: variants.filter(x => /Shadar/.test(x.fullName)).map(x => x.source) });
    const elfCard = v.options.find(g => g.name === "Elf");
    check("species list: DDB lineages join dnd5e's cards, one choice per lineage from the book, the book as subtitle",
      elfCard?.variants.map(x => x.name).join() === "Drow,High,Wood" && elfCard.variants.every(x => books(x.uuid) && x.source === "PHB 2024")
      && v.options.find(g => g.name === "Tiefling")?.variants.length === 3 && v.options.find(g => g.name === "Gnome")?.variants.length === 2
      && !v.options.some(g => /^(High Elf|Wood Elf|Elf \(|Forest Gnome|Rock Gnome|Tiefling \()/.test(g.name)),
      v.options.filter(g => /Elf|Gnome|Tiefling/.test(g.name)).map(g => [g.name, g.variants.map(x => `${x.name}|${x.source}`)]));
    models.length = 0;
    v = await play(c, "species", await c.pick("species", goliath.uuid), { want: ["languages:standard:elvish", "languages:exotic:sylvan"] });
    const langStep = models.find(m => m.type === "Trait" && /Languages/.test(m.title));
    check("Goliath's languages: Common is a granted slot again (DDB's doubled key repaired); the choice of 2 offers every language",
      langStep?.slots.some(s => s.granted && s.options.length === 1 && s.options[0].key === "languages:standard:common")
      && langStep.slots.some(s => !s.granted && s.count === 2 && s.options.some(o => o.key === "languages:exotic:sylvan")),
      langStep?.slots.map(s => [s.granted, s.count, s.options.slice(0, 4).map(o => o.key)]));
    let ab = c.abilities();
    ab = await c.setAbilities({ method: "standardArray", assignments: suggestedAssignments("fighter", ab.slots) });
    const fighterEq = await equip(c, "class", "gold");
    const goldCard = fighterEq.section.options.find(o => o.kind === "gold");
    check("DDB Fighter's gold card shows its dice formula and is rolled once", /5d4 × 10 GP/.test(goldCard?.label ?? ""), fighterEq.section.options);
    const nobleEq = await equip(c, "background", "A");
    check("Noble's equipment option A (its coins are entries in DDB data)", nobleEq.section.complete && /29 GP/.test(nobleEq.section.options[0].label), nobleEq.section);
    await c.setDetails({ name: "CB Books Fighter", alignment: "", biography: "" });
    let review = await c.review();
    check("Fighter: Review has no blockers", !review.blockers.length, review.blockers);
    const rolledGold = (store.creationRolls().gold ?? {})[fighter.uuid]?.value;
    const f = await commit(c);
    let s = summary(f);
    log.push(`Fighter: ${JSON.stringify(s)}`);
    check("saved: Goliath and Noble linked, speed 35, no spellcasting", s.race === "Goliath" && s.background === "Noble" && s.walk === 35 && !s.casting, s);
    check("saved: STR 15 + 2 = 17, INT +1 (suggested array + the Noble increase)", s.abilities.str === 17 && s.abilities.int === 8 + 1, s.abilities);
    check("saved: Common plus Elvish and Sylvan; History and Persuasion from Noble", ["common", "elvish", "sylvan"].every(k => s.languages.includes(k)) && s.skills.includes("his") && s.skills.includes("per"), s);
    check("saved: STR and CON saves, heavy armor, martial weapons", s.saves.includes("str") && s.saves.includes("con") && s.armor.includes("hvy") && s.weapons.includes("mar"), s);
    check("saved: gold = the rolled class gold + Noble's 29 GP, a gaming set, Fine Clothes", Number.isFinite(rolledGold) && s.gp === rolledGold + 29
      && f.items.some(i => i.type === "tool" && i.system.type?.value === "game") && s.items.some(n => /Fine Clothes/.test(n)), { rolledGold, gp: s.gp, items: s.items });
    check("saved: HP 10 + CON mod (d10 class)", s.hp === 10 + f.system.abilities.con.mod, s.hp);

    // ---- 2. TCMP1 Night Stalker + Dwarf + Cleric
    c = createCreationController({ moduleId, t });
    await c.start({});
    v = await c.segment("background");
    const stalker = fromBooks(v.options, "Night Stalker");
    v = await c.pick("background", stalker.uuid);
    check("Night Stalker (TCMP1, no 'Ability Scores' line): an increase on any ability", v.model?.type === "AbilityScoreImprovement" && v.model.config.locked.length === 0, v.model?.config);
    await play(c, "background", v, { asi: { wis: 2, con: 1 } });
    v = await c.segment("species");
    await play(c, "species", await c.pick("species", speciesFromBooks(v.options, "Dwarf").uuid));
    v = await c.segment("class");
    models.length = 0;
    v = await play(c, "class", await c.pick("class", fromBooks(v.options, "Cleric").uuid));
    check("DDB Cleric: Divine Order (ItemChoice) asked and answered", models.some(m => m.type === "ItemChoice" && /Divine Order/i.test(m.title)) && v.screen === "done", log.slice(-8));
    v = await c.segment("spells");
    if (v.screen === "step") v = await play(c, "spells", v);
    ab = c.abilities();
    await c.setAbilities({ method: "standardArray", assignments: suggestedAssignments("cleric", ab.slots) });
    const stalkerEq = await equip(c, "background", "A");
    check("Night Stalker: no stored equipment; the book's 50 GP card", stalkerEq.section.options.length === 1 && stalkerEq.section.options[0].kind === "gold"
      && stalkerEq.section.options[0].label === "50 GP" && stalkerEq.section.complete, stalkerEq.section.options);
    await equip(c, "class", "A");
    let eq = await c.equipment();
    check("trinket: Night Stalker's own table", eq.trinketTable?.own && /Night Stalker/.test(eq.trinketTable.name), eq.trinketTable);
    eq = await c.rollTrinket();
    check("trinket rolled from it", Boolean(eq.trinket?.text), eq.trinket);
    await c.setDetails({ name: "CB Books Cleric", alignment: "", biography: "" });
    review = await c.review();
    check("Cleric: Review has no blockers", !review.blockers.length, review.blockers);
    const cl = await commit(c);
    s = summary(cl);
    log.push(`Cleric: ${JSON.stringify(s)}`);
    check("saved: Dwarf and Night Stalker linked, speed 30", s.race === "Dwarf" && s.background === "Night Stalker" && s.walk === 30, s);
    check("saved: darkvision 120 (DDB Dwarf)", s.darkvision === 120, { darkvision: s.darkvision, senses: cl.system.attributes.senses });
    check("saved: casts with WIS (DC 8 + 2 + WIS mod), cleric spells", s.casting === "wis" && s.dc === 10 + cl.system.abilities.wis.mod && cl.items.filter(i => i.type === "spell").length >= 3, s);
    check("saved: gold includes the book's 50 GP; the trinket", s.gp >= 50 && cl.items.some(i => i.type === "loot" && i.system.description.value.includes(foundry.utils.escapeHTML(eq.trinket.text))), { gp: s.gp });
    check("saved: Stealth from Night Stalker; WIS and CHA saves", s.skills.includes("ste") && s.saves.includes("wis") && s.saves.includes("cha"), s);

    // ---- 3. A homebrew class (whichever the copied books have) + PHB 2024 Sage + Human
    c = createCreationController({ moduleId, t });
    await c.start({});
    v = await c.segment("class");
    // Of the copied books' Homebrew classes, the one with the most level-1 advancements (placeholders have few).
    const level1 = async o => { const d = await fromUuid(o.uuid); const adv = d?.toObject().system.advancement;
      return (Array.isArray(adv) ? adv : Object.values(adv ?? {})).filter(x => (x.level ?? 1) <= 1).length; };
    const candidates = [];
    for (const o of v.options.filter(o => books(o.uuid) && /^(5\.5e · )?Homebrew$/.test(o.tier?.label ?? ""))) candidates.push({ o, n: await level1(o) });
    const homebrew = candidates.sort((x, y) => y.n - x.n || x.o.name.localeCompare(y.o.name))[0]?.o;
    if (!homebrew) log.push("SKIP homebrew class: no class in the copied books is tagged Homebrew");
    else {
      check(`homebrew ${homebrew.name} in the class picker, its book as subtitle, tagged Homebrew`, Boolean(homebrew.source) && homebrew.tier.tone === "other", homebrew);
      v = await play(c, "class", await c.pick("class", homebrew.uuid));
      check("homebrew class: every class step answered", v.screen === "done", log.slice(-6));
      v = await c.segment("spells");
      if (v.screen === "step") v = await play(c, "spells", v);
      v = await c.segment("background");
      await play(c, "background", await c.pick("background", fromBooks(v.options, "Sage").uuid), { asi: { int: 2, con: 1 } });
      v = await c.segment("species");
      await play(c, "species", await c.pick("species", speciesFromBooks(v.options, "Human").uuid));
      // Class answered first: skills the Sage or the Human now give are flagged, and the step re-opens without them.
      v = await c.segment("class");
      const reopened = v.model;
      check("homebrew class answered before Sage and Human: any duplicate skills re-open with the reason", v.screen !== "step"
        || (reopened.conflicts.length > 0 && /already granted by your (background|species)/.test(reopened.conflictText ?? "")), reopened && { conflicts: reopened.conflicts, text: reopened.conflictText });
      if (v.screen === "step") v = await play(c, "class", v);
      ab = c.abilities();
      await c.setAbilities({ method: "standardArray", assignments: { int: ab.slots[0].id, dex: ab.slots[1].id, con: ab.slots[2].id, wis: ab.slots[3].id, str: ab.slots[4].id, cha: ab.slots[5].id } });
      await equip(c, "class", "A");
      await equip(c, "background", "A");
      await c.setDetails({ name: "CB Books Homebrew", alignment: "", biography: "" });
      review = await c.review();
      check("homebrew class: Review has no blockers", !review.blockers.length, { blockers: review.blockers, tabs: c.tabs() });
      const hb = await commit(c);
      s = summary(hb);
      log.push(`Homebrew ${homebrew.name}: ${JSON.stringify(s)}`);
      // What the class itself promises at level 1, read from its own document.
      const cls = hb.items.find(i => i.type === "class");
      const adv = cls?.toObject().system.advancement;
      const traits = (Array.isArray(adv) ? adv : Object.values(adv ?? {})).filter(a => a.type === "Trait" && (a.level ?? 0) <= 1 && a.classRestriction !== "secondary");
      const saves = traits.flatMap(a => a.configuration?.grants ?? []).filter(g => g.startsWith("saves:")).map(g => g.slice(6));
      const die = Number(String(cls?.system.hd?.denomination ?? "").replace("d", ""));
      const casts = cls?.system.spellcasting?.progression && cls.system.spellcasting.progression !== "none" ? cls.system.spellcasting.ability : null;
      check("saved homebrew character: level 1, Human and Sage linked, the class's saving throws",
        hb.system.details.level === 1 && s.race === "Human" && s.background === "Sage" && saves.every(k => s.saves.includes(k)), { saves, s });
      check("saved homebrew character: level-1 features from its pack, HP = hit die + CON mod, casts with the class's ability",
        hb.items.some(i => i.type === "feat" && i.getFlag("dnd5e", "advancementOrigin")) && (!die || s.hp === die + hb.system.abilities.con.mod)
        && (!casts || s.casting === casts), { die, casts, s });
    }
  } catch (error) {
    check(`no exception (${error.message})`, false, error.stack?.slice(0, 800));
  } finally {
    for (const a of created) await a?.delete().catch(() => {});
    await store.finishCreation().catch(() => {});
    const restore = Object.fromEntries(Object.entries(priorCreation).filter(([, v]) => v !== null));
    if (Object.keys(restore).length) await game.user.update({ flags: { [moduleId]: { builder: restore } } }).catch(() => {});
    await game.settings.set(moduleId, "builderHouseRules", rulesBefore);
    await game.user.update({ character: characterBefore });
    Hooks.off("createChatMessage", trackMessage);
    const mine = testMessages.filter(id => game.messages.has(id));
    if (mine.length) await ChatMessage.deleteDocuments(mine);
  }
  return { checks, log };
}, PREFIX);
await browser.close();
if (result.skipped) { console.log(`SKIP ${result.skipped}\n0/0 passed`); process.exit(0); }
let failed = 0;
for (const c of result.checks) { if (!c.ok) failed++; console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info ?? "").slice(0, 900)); }
console.log(`\n${result.checks.length - failed}/${result.checks.length} passed`);
console.log(result.log.join("\n"));
process.exit(failed ? 1 : 0);
