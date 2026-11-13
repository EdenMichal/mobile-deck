// End-to-end test of the builder controller (no UI) in test-5e-world, as Claude Test GM.
// Imports the installed dev copy straight from Foundry's static files, so it runs even
// before "Mobile Deck (DEV)" is enabled. Creates and deletes a throwaway actor.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/level-up-engine.e2e.mjs
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const { browser, page } = await joinTestWorld();
await pinToSrd(page); // the suite's expectations are for dnd5e's SRD content, not the user's books (pin-srd.mjs)
const result = await page.evaluate(async () => {
  const checks = [];
  const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
  const base = "/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder";
  const { createBuilderController } = await import(`${base}/builder-gateway.mjs`);
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const uuidOf = async (packId, type, name) => (await game.packs.get(packId).getIndex()).find(e => e.type === type && e.name === name)?.uuid;
  const actor = await Actor.implementation.create({ name: "CB Engine Test", type: "character",
    system: { abilities: { str: { value: 15 }, dex: { value: 14 }, con: { value: 14 }, int: { value: 8 }, wis: { value: 12 }, cha: { value: 10 } } } });
  const userFlagsBefore = foundry.utils.deepClone(game.user.getFlag(moduleId, "builder") ?? null);
  const messagesBefore = new Set(game.messages.map(m => m.id));
  const log = [];
  try {
    const c = createBuilderController(actor, { moduleId });
    // Answer whatever screen comes up, the way a player would.
    const play = async (view, prefs = {}) => {
      let guard = 0;
      while (view.screen === "step" && guard++ < 30) {
        const m = view.model;
        log.push(`${m.type}: ${m.title} (${m.item} L${m.level})`);
        let data, meta;
        if (m.type === "HitPoints") {
          if (prefs.hp === "roll") { const r = await c.rollHitPoints(m); data = { value: r.value }; meta = { hp: { method: "roll", roll: r.value, die: m.die, mod: m.mod, modLabel: m.modLabel } }; }
          else { data = { value: "avg" }; meta = { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod, modLabel: m.modLabel } }; }
        } else if (m.type === "Trait") {
          const chosen = new Set();
          for (const slot of m.slots) slot.options.filter(o => !chosen.has(o.key)).slice(0, slot.count).forEach(o => chosen.add(o.key));
          data = { chosen: [...chosen] };
        } else if (m.type === "ItemChoice") data = { selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) };
        else if (m.type === "Subclass") { data = { uuid: m.options.find(o => o.name === "Champion")?.uuid }; meta = { kind: "subclass" }; }
        else if (m.type === "AbilityScoreImprovement") {
          if (prefs.feat && m.allowFeat) data = { type: "feat", uuid: m.feats.find(f => f.name === prefs.feat)?.uuid };
          else if (m.item === prefs.feat) data = { type: "asi", assignments: { str: 1 } };
          else data = { type: "asi", assignments: { str: 1, con: 1 } };
        } else if (m.type === "Size") data = { size: m.options[0].key };
        else if (m.type === "ItemGrant") data = { selected: m.items.map(i => i.uuid) };
        else throw new Error(`Unexpected screen ${m.type}`);
        view = await c.answer(data, meta);
      }
      return view;
    };

    // Level 1: new class (Fighter) on a blank character
    const home0 = c.home();
    check("home: no classes yet", home0.classes.length === 0, home0);
    const classes = await c.newClassOptions();
    check("class list from compendiums", classes.some(o => o.name === "Fighter"), classes.map(o => o.name));
    let view = await c.start({ kind: "new-class", classUuid: await uuidOf("dnd5e.classes24", "class", "Fighter"), label: "New class: Fighter 1" });
    check("first screen is a choice, not HP (level 1 HP is automatic max)", view.screen === "step" && view.model.type !== "HitPoints", view.model?.type);
    check("draft saved after start", c.home().draft !== null);
    view = await play(view);
    check("reached Review changes", view.screen === "review", view);
    const text1 = view.groups.flatMap(g => g.lines.map(l => l.text));
    check("review: new class line", text1.some(t => t === "New class: Fighter 1"), text1);
    check("review: HP 0 → 12", text1.some(t => t.startsWith("Max HP 0 → 12")), text1);
    check("review: Fighting Style feat gained", text1.some(t => t.startsWith("+ Archery") || /Fighting Style/.test(t)), text1);
    let entry = await c.commit();
    check("commit: Fighter 1, HP 12", actor.system.details.level === 1 && actor.system.attributes.hp.max === 12, { level: actor.system.details.level, hp: actor.system.attributes.hp.max });
    check("change log entry stored", actor.getFlag(moduleId, "changeLog")?.length === 1, actor.getFlag(moduleId, "changeLog"));
    check("draft cleared after commit", c.home().draft === null, c.home().draft);
    const fighterId = actor.items.find(i => i.type === "class").id;

    // Level 2: average HP, then Back and change to... still average (Back keeps the answer prefilled)
    view = await c.start({ kind: "level", classId: fighterId });
    check("level 2 starts on HP", view.model?.type === "HitPoints", view.model?.type);
    view = await play(view);
    check("level 2 review: HP 12 → 20", view.groups.some(g => g.lines.some(l => l.text.startsWith("Max HP 12 → 20 (+8, average 6 + 2 CON)"))), view.groups);
    const hpLine = view.groups.find(g => g.id === "hp").lines[0];
    check("HP line links to its step", hpLine.step === 0, hpLine);
    view = await c.back();
    check("Back from review reopens the last step with its answer", view.screen === "step" && view.model.answer !== null, view);
    view = await play(view);
    await c.commit();

    // Level 3: rolled HP (locked, posted to chat) and Champion
    view = await c.start({ kind: "level", classId: fighterId });
    const hpModel = view.model;
    const r1 = await c.rollHitPoints(hpModel);
    const r2 = await c.rollHitPoints(hpModel);
    check("HP roll is locked (second roll returns the same)", r1.value === r2.value && r1.messageId === r2.messageId, { r1, r2 });
    view = await play(view, { hp: "roll" });
    const text3 = view.groups.flatMap(g => g.lines.map(l => l.text));
    check("level 3 review: rolled HP and subclass", text3.some(t => t.includes(`rolled ${r1.value} on a d10`)) && text3.includes("Subclass: Champion"), text3);
    await c.commit();
    check("Champion on the actor", actor.items.some(i => i.type === "subclass" && i.name === "Champion"));

    // Level 4: Grappler feat, whose own ASI shows up as an extra screen
    view = await c.start({ kind: "level", classId: fighterId });
    view = await play(view, { feat: "Grappler" });
    const text4 = view.groups.flatMap(g => g.lines.map(l => l.text));
    check("level 4 review: Grappler and STR 15 → 16", text4.includes("+ Grappler (Feat)") && text4.includes("STR 15 → 16"), text4);
    check("Grappler's own ASI was a screen", log.some(l => l.startsWith("AbilityScoreImprovement") && l.includes("Grappler")), log);
    // Edit from review: change the ASI step to a plain ASI, which drops the Grappler screen
    const grapplerLine = view.groups.flatMap(g => g.lines).find(l => l.text === "+ Grappler (Feat)");
    check("Grappler line links to the step where it was picked", grapplerLine?.step !== undefined, grapplerLine);
    view = await c.edit(grapplerLine?.step ?? 1);
    check("edit opens the ASI step", view.model?.type === "AbilityScoreImprovement", view.model?.type);
    view = await c.answer({ type: "asi", assignments: { str: 1, con: 1 } });
    check("after editing, back to review (no Grappler)", view.screen === "review" && !view.groups.flatMap(g => g.lines.map(l => l.text)).includes("+ Grappler (Feat)"), view);
    entry = await c.commit();
    check("level 4 committed: STR 16, CON 15", actor.system.abilities.str.value === 16 && actor.system.abilities.con.value === 15, actor.system.abilities);
    const changeLog = actor.getFlag(moduleId, "changeLog");
    check("change log has 4 entries, newest first", changeLog.length === 4 && changeLog[0].after.level === 4, changeLog.map(e => e.after.label));
    check("undo data kept on the newest 3 only", changeLog[0].undo && changeLog[2].undo && changeLog[3].undo === null, changeLog.map(e => Boolean(e.undo)));
    const newMessages = game.messages.filter(m => !messagesBefore.has(m.id));
    check("GM chat cards: 4 summaries + 1 HP roll", newMessages.filter(m => m.content.includes("ve-builder-chat-card")).length === 4 && newMessages.filter(m => m.rolls?.length).length === 1,
      newMessages.map(m => m.content.slice(0, 60)));
    check("chat cards are whispers", newMessages.every(m => m.whisper.length > 0), newMessages.map(m => m.whisper));
    return { checks, log, moduleId, devActive: Boolean(game.modules.get("mobile-deck-dev")?.active), devKnown: Boolean(game.modules.get("mobile-deck-dev")) };
  } catch (error) {
    return { checks, log, moduleId, error: `${error.message}\n${error.stack}` };
  } finally {
    await actor.delete();
    for (const m of game.messages.filter(m => !messagesBefore.has(m.id))) await m.delete();
    if (userFlagsBefore === null) await game.user.unsetFlag(moduleId, "builder");
    else await game.user.setFlag(moduleId, "builder", userFlagsBefore);
  }
});
for (const c of result.checks) console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info)?.slice(0, 600));
if (result.error) console.log("ERROR", result.error);
console.log(`module scope: ${result.moduleId}; dev module known: ${result.devKnown}, active: ${result.devActive}`);
console.log(`${result.checks.filter(c => c.ok).length}/${result.checks.length} passed`);
await browser.close();
