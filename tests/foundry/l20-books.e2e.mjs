// End-to-end test of the L20 fixes that need the user's books: the user's own DDB Importer and homebrew packs, copied
// into the test world under a prefix (BOOKS_PACK_PREFIX). Engine level, as Claude Test GM, not pinned. Skips cleanly when
// the prefix is unset or no pack has it.
// 1. DDB Fighter (Eldritch Knight) 1–4: a Spells step at 3 from the 2024 table (2 cantrips, 3 prepared, Wizard list), the
//    GM data note, the Fighting Style replacement card, and the 4th prepared spell plus a swap at 4.
// 2. DDB Rogue (Arcane Trickster) 1–4: Mage Hand added for the player, 2 cantrip picks; Fey Touched (DDB, no spell
//    advancement) at 4 adds Misty Step and asks for a level 1 Divination or Enchantment spell.
// Creates and deletes throwaway actors; restores chat, the user's builder flag and the house rules.
// The packs' name prefix comes from BOOKS_PACK_PREFIX (no default); unset, the suite skips.
// Run: BOOKS_PACK_PREFIX=<prefix> PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/l20-books.e2e.mjs
import { joinTestWorld } from "./join.mjs";

const PREFIX = process.env.BOOKS_PACK_PREFIX ?? "";
if (!PREFIX) {
  console.log("SKIP set BOOKS_PACK_PREFIX to the name prefix of the copied book packs in the test world\n0/0 passed");
  process.exit(0);
}

const { browser, page } = await joinTestWorld();
page.setDefaultTimeout(0);
const result = await page.evaluate(async PREFIX => {
  const checks = [];
  const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
  if (!game.packs.some(p => p.metadata.name.startsWith(PREFIX))) return { checks, skipped: `no ${PREFIX}* packs in this world` };
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const base = `/modules/${moduleId}/src/foundry/systems/dnd5e/builder`;
  const { createBuilderController } = await import(`${base}/builder-gateway.mjs`);
  const flagBefore = foundry.utils.deepClone(game.user.getFlag(moduleId, "builder") ?? null);
  const messagesBefore = new Set(game.messages.map(m => m.id));
  const actors = [];
  const ddb = async (type, name) => (await game.packs.get(`world.${PREFIX}ddb-classes`).getIndex()).find(e => e.type === type && e.name === name)?.uuid;
  const made = async (name, abilities) => {
    const a = await Actor.implementation.create({ name: `L20 fix e2e ${name}`, type: "character",
      system: { abilities: Object.fromEntries(Object.entries(abilities).map(([k, v]) => [k, { value: v }])) } });
    actors.push(a);
    return a;
  };
  const attention = view => (view.groups ?? []).find(g => g.id === "attention")?.lines.map(l => l.text) ?? [];
  const play = async (c, view, hooks = () => undefined) => {
    let guard = 0;
    while (view.screen === "step" && guard++ < 40) {
      const m = view.model;
      let a = await hooks(m);
      if (!a) {
        if (m.type === "HitPoints") a = { data: { value: "avg" } };
        else if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); a = { data: { chosen: [...chosen] } }; }
        else if (m.type === "ItemChoice") a = { data: { selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) } };
        else if (m.type === "ItemGrant") a = { data: { selected: m.items.map(i => i.uuid) } };
        else if (m.type === "AbilityScoreImprovement") a = { data: { type: "asi", assignments: { con: Math.min(2, m.config.points) } } };
        else if (m.type === "Spells") {
          const c0 = m.options.filter(o => o.level === 0).slice(0, m.owed.cantrips).map(o => o.uuid);
          const c1 = m.options.filter(o => o.level > 0).slice(0, m.owed.prepared).map(o => o.uuid);
          a = { data: { cantrips: c0, spells: c1, prepare: [], swaps: [] } };
        } else throw new Error(`Unexpected ${m.type} ${m.title}`);
      }
      view = await c.answer(a.data, a.meta);
    }
    return view;
  };
  const levelUp = async (c, actor, uuid, hooks) => {
    const cls = Object.values(actor.classes ?? {})[0];
    let view = cls ? await c.start({ kind: "level", classId: cls.id }) : await c.start({ kind: "new-class", classUuid: uuid, label: "New class" });
    view = await play(c, view, hooks);
    if (view.screen !== "review") throw new Error(`stopped at ${view.screen}: ${view.error}`);
    const out = view;
    await c.commit();
    return out;
  };
  const subclassHook = name => m => (m.type === "Subclass" ? { data: { uuid: m.options.find(o => o.name === name && o.uuid.includes(`.${PREFIX}`)).uuid }, meta: { kind: "subclass" } } : undefined);
  try {
    // ---- 1. Eldritch Knight
    {
      const actor = await made("EK", { str: 16, dex: 12, con: 14, int: 13, wis: 10, cha: 8 });
      const c = createBuilderController(actor, { moduleId });
      const uuid = await ddb("class", "Fighter");
      let spells3 = null;
      let fs2 = null;
      await levelUp(c, actor, uuid, m => (m.type === "ItemChoice" && m.title === "Fighting Style" ? { data: { selected: [m.options.find(o => !o.blockers.length).uuid] } } : undefined));
      await levelUp(c, actor, uuid, m => { if (m.type === "ItemChoice" && m.title === "Fighting Style") { fs2 = m; return { data: { selected: [] } }; } });
      const r3 = await levelUp(c, actor, uuid, m => subclassHook("Eldritch Knight")(m) ?? (m.type === "Spells" ? (spells3 = m, undefined) : undefined));
      check("DDB Fighter 2: the Fighting Style replacement card is offered", fs2?.count === 0 && fs2.replaceable?.length === 1, fs2 && { count: fs2.count, replaceable: fs2.replaceable });
      check("EK 3: a Spells step from the 2024 table (2 cantrips, 3 prepared, level 1)", spells3?.owed.cantrips === 2 && spells3.owed.prepared === 3 && spells3.owed.maxSpellLevel === 1,
        spells3?.owed);
      check("EK 3: from the Wizard list", spells3?.lists?.[0] === "class:wizard" && spells3.options.some(o => o.name === "Shield"), spells3?.lists);
      check("EK 3: 2 cantrips and 3 spells on the actor, linked to the Fighter", actor.items.filter(i => i.type === "spell" && i.system.sourceItem === "class:fighter").length === 5,
        actor.items.filter(i => i.type === "spell").map(i => `${i.name} ${i.system.sourceItem}`));
      check("EK 3: the GM sees that the table was used", attention(r3).some(l => /2024 table/.test(l)), attention(r3));
      let spells4 = null;
      await levelUp(c, actor, uuid, m => {
        if (m.type === "Spells") {
          spells4 = m;
          const out = m.known.find(k => k.level === 1);
          const inc = m.options.find(o => o.level === 1);
          const add = m.options.filter(o => o.level === 1 && o.uuid !== inc.uuid).slice(0, m.owed.prepared);
          return { data: { cantrips: [], spells: add.map(o => o.uuid), prepare: [], swaps: [{ out: out.id, in: inc.uuid }] } };
        }
      });
      check("EK 4: one more prepared spell and a spell swap offered", spells4?.owed.prepared === 1 && spells4.owed.swapSpell === true, spells4?.owed);
      check("EK 4: 4 prepared Fighter spells after the swap", actor.items.filter(i => i.type === "spell" && i.system.level > 0 && i.system.sourceItem === "class:fighter").length === 4,
        actor.items.filter(i => i.type === "spell").map(i => i.name));
    }
    // ---- 2. Arcane Trickster with Fey Touched
    {
      const actor = await made("AT", { str: 8, dex: 16, con: 14, int: 15, wis: 10, cha: 12 });
      const c = createBuilderController(actor, { moduleId });
      const uuid = await ddb("class", "Rogue");
      let spells3 = null;
      let fey = null;
      await levelUp(c, actor, uuid);
      await levelUp(c, actor, uuid);
      await levelUp(c, actor, uuid, m => subclassHook("Arcane Trickster")(m) ?? (m.type === "Spells" ? (spells3 = m, undefined) : undefined));
      check("AT 3: Mage Hand is added for the player; 2 cantrips to pick", spells3?.fixed?.some(f => f.name === "Mage Hand") && spells3.owed.cantrips === 2, spells3 && { fixed: spells3.fixed, owed: spells3.owed });
      check("AT 3: Mage Hand on the actor", actor.items.some(i => i.type === "spell" && i.name === "Mage Hand" && i.system.sourceItem === "class:rogue"), actor.items.filter(i => i.type === "spell").map(i => i.name));
      await levelUp(c, actor, uuid, m => {
        if (m.type === "AbilityScoreImprovement" && m.allowFeat) {
          const f = m.feats.find(x => x.name === "Fey Touched" && !x.blockers.length);
          return f ? { data: { type: "feat", uuid: f.uuid } } : undefined;
        }
        if (m.type === "AbilityScoreImprovement") return { data: { type: "asi", assignments: { int: 1 } } };
        if (m.type === "ItemChoice" && /Fey Touched/.test(m.title)) { fey = m; return { data: { selected: [m.options[0].uuid] } }; }
      });
      check("Fey Touched (DDB): asks for one level 1 Divination or Enchantment spell", fey?.count === 1 && fey.options.length > 0 && fey.options.every(o => o.level === 1), fey && { count: fey.count, n: fey.options.length });
      const misty = actor.items.find(i => i.type === "spell" && i.name === "Misty Step");
      check("Fey Touched (DDB): Misty Step added, always prepared, once per Long Rest", misty?.system.prepared === 2 && String(misty.system.uses?.max) === "1", misty && { prepared: misty.system.prepared, uses: misty.system.uses?.max });
      check("Fey Touched spells don't count as Arcane Trickster picks", actor.items.filter(i => i.type === "spell" && i.system.sourceItem === "feat:fey-touched").length === 2,
        actor.items.filter(i => i.type === "spell").map(i => `${i.name} ${i.system.sourceItem}`));
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
  }
}, PREFIX);
if (result.skipped) { console.log(`SKIP ${result.skipped}\n0/0 passed`); await browser.close(); process.exit(0); }
for (const c of result.checks) console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info)?.slice(0, 700));
if (result.error) console.log("ERROR", result.error);
console.log(`${result.checks.filter(c => c.ok).length}/${result.checks.length} passed`);
await browser.close();
