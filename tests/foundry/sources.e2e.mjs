// Phase 2 test: GM sources and house rules, in test-5e-world as Claude Test GM (desktop).
// Needs Mobile Deck (DEV) enabled. Restores both settings and deletes its actor and temporary
// world compendium. Screenshots of the two GM windows go to tests/foundry/screens/.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/sources.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
const { browser, page } = await joinTestWorld("Claude Test GM", {
  context: { viewport: { width: 1400, height: 1000 } },
  // Answer Mobile Deck's one-time "Confirm display mode" prompt and keep off the real Stream Deck.
  initScript: () => { try { localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("desktop")); localStorage.setItem("music-deck.deckLink", "false"); } catch {} }
});
await pinToSrd(page); // the suite's expectations are for dnd5e's SRD content, not the user's books (pin-srd.mjs)
await page.addStyleTag({ content: "#notifications { display: none !important; }" });
await page.waitForTimeout(2000);
await page.evaluate(async () => { for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.options?.window) await app.close().catch(() => {}); });

const M = "mobile-deck-dev";
const backup = await page.evaluate(M => ({ sources: game.settings.get(M, "builderSources"), house: game.settings.get(M, "builderHouseRules") }), M);
const results = [];
const report = r => { for (const c of r.checks) { results.push(c.ok); console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info ?? "").slice(0, 500)); } if (r.error) { results.push(false); console.log("ERROR", r.error); } };

try {
  // GM windows
  const menus = await page.evaluate(M => ["builderSourcesMenu", "builderHouseRulesMenu"].map(k => game.settings.menus.get(`${M}.${k}`)).map(m => m ? { name: m.name, restricted: m.restricted } : null), M);
  report({ checks: [{ ok: menus.every(m => m?.restricted), label: "both GM menus registered, GM-only", info: menus }] });
  for (const [key, file] of [["builderSourcesMenu", "sources-menu"], ["builderHouseRulesMenu", "house-rules-menu"]]) {
    await page.evaluate(({ M, key }) => new (game.settings.menus.get(`${M}.${key}`).type)().render({ force: true }), { M, key });
    await page.waitForTimeout(2500);
    await page.locator(".ve-builder-settings").first().screenshot({ path: `${shotsDir}phase2-${file}.png` });
    // The window must scroll (mouse wheel over the list) and keep Save on screen.
    const body = page.locator(".ve-builder-settings .ve-builder-settings-body").first();
    const box = await body.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 2000);
    await page.waitForTimeout(400);
    const scroll = await page.evaluate(() => {
      const el = document.querySelector(".ve-builder-settings .ve-builder-settings-body");
      const save = [...el.querySelectorAll("button[type=submit]")][0].getBoundingClientRect();
      const win = document.querySelector(".ve-builder-settings").getBoundingClientRect();
      return { scrollTop: el.scrollTop, overflow: el.scrollHeight - el.clientHeight, saveVisible: save.bottom <= win.bottom + 1 && save.top >= win.top };
    });
    report({ checks: [{ ok: scroll.overflow > 0 && scroll.scrollTop > 0 && scroll.saveVisible, label: `${file}: scrolls with the wheel, Save stays visible`, info: scroll }] });
    await page.locator(".ve-builder-settings").first().screenshot({ path: `${shotsDir}phase2-${file}-scrolled.png` });
    await page.evaluate(() => { for (const app of [...foundry.applications.instances.values()]) if (app.id?.startsWith("ve-builder-")) app.close(); });
  }

  report(await page.evaluate(async M => {
    const checks = [];
    const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
    const base = "/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder";
    const cs = await import(`${base}/content-sources.mjs`);
    const { bookKey } = await import(`${base}/source-filter.mjs`);
    const { createBuilderController } = await import(`${base}/builder-gateway.mjs`);
    const set = async (key, value) => { await game.settings.set(M, key, value); cs.clearContentCache(); };
    const names = list => list.map(e => e.name);
    const actor = await Actor.implementation.create({ name: "CB Sources Test", type: "character",
      system: { abilities: { str: { value: 15 }, dex: { value: 14 }, con: { value: 14 }, int: { value: 8 }, wis: { value: 12 }, cha: { value: 10 } } } });
    let pack = null;
    try {
      // Defaults: the world's edition (2024) only, each class once
      await set("builderSources", { rules: "world", packs: {}, books: {} });
      await set("builderHouseRules", {});
      let classes = await cs.findClasses();
      check("default: 2024 classes, each once", classes.filter(c => c.name === "Fighter").length === 1 && classes.every(c => c.rules !== "2014"), names(classes));
      const has2014 = (await cs.packIndex("dnd5e.classes")).length > 0;
      await set("builderSources", { rules: "both", packs: {}, books: {} });
      classes = await cs.findClasses();
      check("both editions: Fighter 2014 and 2024", !has2014 || classes.filter(c => c.name === "Fighter").length === 2, classes.filter(c => c.name === "Fighter"));
      await set("builderSources", { rules: "2014", packs: {}, books: {} });
      classes = await cs.findClasses();
      check("2014 only: no 2024 classes", classes.every(c => c.rules !== "2024"), classes.map(c => `${c.name} ${c.rules}`));
      await set("builderSources", { rules: "world", packs: {}, books: {} });

      // Books: switch off the 2024 Player's Handbook book key found on Grappler
      const grappler = (await cs.findFeats({ type: "feat" })).find(f => f.name === "Grappler");
      const book = grappler && bookKey(grappler);
      await set("builderSources", { rules: "world", packs: {}, books: { [book]: false } });
      check(`book "${book}" switched off hides Grappler`, book && !(await cs.findFeats({ type: "feat" })).some(f => f.name === "Grappler"));
      await set("builderSources", { rules: "world", packs: {}, books: {} });

      // House rules: bans and multiclassing
      await set("builderHouseRules", { bannedClasses: ["monk"], bannedSubclasses: ["champion"] });
      check("banned class hidden", !(await cs.findClasses()).some(c => c.name === "Monk"));
      check("banned subclass hidden", !(await cs.findSubclasses("fighter")).some(s => s.name === "Champion"));
      await set("builderHouseRules", {});

      // Build Fighter 1 with defaults, then test multiclass rules and pack switches on level 2
      const c = createBuilderController(actor, { moduleId: M });
      const play = async view => {
        while (view.screen === "step") {
          const m = view.model;
          let data, meta;
          if (m.type === "HitPoints") { data = { value: "avg" }; meta = { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod } }; }
          else if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); data = { chosen: [...chosen] }; }
          else if (m.type === "ItemChoice") data = { selected: m.options.slice(0, m.count).map(o => o.uuid) };
          else throw new Error(`unexpected ${m.type}`);
          view = await c.answer(data, meta);
        }
        return view;
      };
      const fighter = (await cs.findClasses()).find(x => x.name === "Fighter");
      await play(await c.start({ kind: "new-class", classUuid: fighter.uuid }));
      await c.commit();
      check("Fighter 1 built", actor.system.details.level === 1);
      check("multiclass allowed by default", c.home().canAddClass === true);
      await set("builderHouseRules", { multiclass: false });
      check("multiclass off hides Add a class", c.home().canAddClass === false);
      await set("builderHouseRules", { multiclassPrerequisites: false });
      const mc = await c.newClassOptions();
      check("13+ rule off: no multiclass blockers", mc.every(o => !o.blockers.length), mc.filter(o => o.blockers.length).map(o => o.name));
      await set("builderHouseRules", {});
      const mc2 = await c.newClassOptions();
      check("13+ rule on: Wizard blocked (INT 8)", mc2.find(o => o.name === "Wizard")?.blockers.length > 0, mc2.find(o => o.name === "Wizard"));

      // Fighting Style pool honours sources: switch off feats24 and the choice list empties
      await set("builderSources", { rules: "world", packs: { "dnd5e.feats24": { enabled: false } }, books: {} });
      check("feats24 off: no general feats", !(await cs.findFeats({ type: "feat", subtype: "general" })).length);
      await set("builderSources", { rules: "world", packs: {}, books: {} });

      // Grant swap: a world compendium with copies of Fighter level-2 features; classes24 switched off
      pack = await foundry.documents.collections.CompendiumCollection.createCompendium({ type: "Item", label: "CB Test Copies", name: "cb-test-copies" });
      const originals = await Promise.all(["Action Surge", "Tactical Mind"].map(async n => {
        const idx = (await game.packs.get("dnd5e.classes24").getIndex()).find(e => e.name === n && e.type === "feat");
        return (await fromUuid(idx.uuid)).toObject();
      }));
      await Item.implementation.createDocuments(originals.map(o => ({ ...o, _id: undefined, name: o.name, flags: { cbTest: true } })), { pack: pack.collection });
      cs.clearContentCache();
      await set("builderSources", { rules: "world", packs: { "dnd5e.classes24": { enabled: false } }, books: {} });
      const fighterId = actor.items.find(i => i.type === "class").id;
      const review = await play(await c.start({ kind: "level", classId: fighterId }));
      check("level 2 reached review with classes24 off", review.screen === "review", review);
      await c.commit();
      const granted = ["Action Surge", "Tactical Mind"].map(n => actor.items.find(i => i.name === n)?._stats?.compendiumSource ?? "");
      check("granted features came from the allowed world copies", granted.every(s => s.includes(pack.collection)), granted);
    } catch (error) {
      return { checks, error: `${error.message}\n${error.stack}` };
    } finally {
      await actor.delete();
      if (pack) await pack.deleteCompendium();
      for (const m of game.messages.filter(m => String(m.content ?? "").includes("ve-builder-chat-card") && String(m.content).includes("CB Sources Test"))) await m.delete();
      await game.user.unsetFlag(M, "builder");
    }
    return { checks };
  }, M));
} finally {
  await page.evaluate(async ({ M, backup }) => {
    await game.settings.set(M, "builderSources", backup.sources);
    await game.settings.set(M, "builderHouseRules", backup.house);
  }, { M, backup });
  console.log(`${results.filter(Boolean).length}/${results.length} passed`);
  await browser.close();
}
