// Phone-size UI test of the Phase 3 spell step in test-5e-world (Mobile Deck (DEV) enabled there).
// Builds a Wizard 3 with the engine, then levels it to 4 by tapping the real screens: HP average,
// the level-4 ASI, then Spells (filters, Misty Step's details window, Pick, a cantrip, prepare,
// VE Back closing only the details window), Review changes and Commit. Screenshots go to tests/foundry/screens/.
// Cleans up the actor, chat messages, drafts and the GM's assigned character.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/spells-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("spells-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);

const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try {
    localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone"));
    localStorage.setItem("music-deck.deckLink", "false");
  } catch {} }
};
const { browser, page } = await joinTestWorld("Claude Test GM", phone);
await pinToSrd(page); // the suite's expectations are for dnd5e's SRD content, not the user's books (pin-srd.mjs)
const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 400)); };
let n = 0;
const shot = async name => { await page.waitForTimeout(350); await page.screenshot({ path: `${shotsDir}spells-${String(++n).padStart(2, "0")}-${name}.png` }); };

const messagesBefore = await page.evaluate(() => game.messages.map(m => m.id));
const setup = await page.evaluate(async () => {
  const { createBuilderController } = await import("/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder/builder-gateway.mjs");
  const classUuid = async name => (await game.packs.get("dnd5e.classes24").getIndex()).find(e => e.type === "class" && e.name === name)?.uuid;
  const actor = await Actor.implementation.create({ name: "Mirela (CB spells phone test)", type: "character", img: "icons/svg/mystery-man.svg",
    system: { abilities: { str: { value: 8 }, dex: { value: 14 }, con: { value: 14 }, int: { value: 16 }, wis: { value: 12 }, cha: { value: 10 } },
      details: { xp: { value: 2700 } } } });
  const c = createBuilderController(actor);
  const play = async view => {
    while (view.screen === "step") {
      const m = view.model;
      let data, meta;
      if (m.type === "HitPoints") { data = { value: "avg" }; meta = { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod, modLabel: m.modLabel } }; }
      else if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); data = { chosen: [...chosen] }; }
      else if (m.type === "ItemChoice") data = { selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) };
      else if (m.type === "Subclass") { data = { uuid: m.options[0].uuid }; meta = { kind: "subclass" }; }
      else if (m.type === "Spells") {
        const spells = m.options.filter(o => o.level > 0 && o.name !== "Misty Step").slice(0, m.owed.spellbook).map(o => o.uuid);
        data = { cantrips: m.options.filter(o => o.level === 0).slice(0, m.owed.cantrips).map(o => o.uuid), spells, prepare: spells.slice(0, m.owed.prepared), swaps: [] };
        meta = { kind: "spells", warnings: [] };
      } else throw new Error(`setup: unexpected ${m.type}`);
      view = await c.answer(data, meta);
    }
    await c.commit();
  };
  await play(await c.start({ kind: "new-class", classUuid: await classUuid("Wizard"), label: "Wizard 1" }));
  const wizardId = actor.classes.wizard.id;
  await play(await c.start({ kind: "level", classId: wizardId }));
  await play(await c.start({ kind: "level", classId: wizardId }));
  const previousCharacter = game.user.character?.id ?? null;
  await game.user.update({ character: actor.id });
  return { actorId: actor.id, previousCharacter, level: actor.system.details.level };
});
check("setup: Wizard 3", setup.level === 3, setup);

try {
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });
  await page.addStyleTag({ content: "#notifications { display: none !important; }" });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.options?.window) await app.close().catch(() => {});
    for (const app of Object.values(ui.windows ?? {})) await app.close?.().catch?.(() => {});
  });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click().catch(() => {});

  await page.locator(".ve-character-identity-controls .ve-character-level-up").click({ timeout: 30000 });
  const layer = page.locator(".ve-builder-layer");
  await page.waitForSelector('.ve-builder-layer[data-screen="home"]');
  await layer.locator(".ve-builder-card", { hasText: "Wizard 3 → 4" }).click();
  const next = () => layer.locator(".ve-builder-footer .ve-builder-primary").click();
  const idle = () => page.waitForFunction(() => document.querySelector(".ve-builder-layer")?.getAttribute("aria-busy") !== "true");

  // Steps before Spells: HP average, the ASI (+2 INT), anything else with its default
  for (let guard = 0; guard < 10; guard++) {
    await idle();
    const s = await layer.getAttribute("data-screen");
    if (s === "Spells") break;
    if (s === "HitPoints") await layer.locator(".ve-builder-big-choice").nth(1).click();
    else if (s === "AbilityScoreImprovement") {
      const plus = layer.locator(".ve-builder-asi-cell").nth(3).locator(".ve-builder-step-btn").nth(1); // INT
      await plus.click(); await plus.click();
    } else if (s === "Trait") await layer.locator(".ve-builder-chip:not([disabled])").first().click();
    await next();
    await page.waitForFunction(prev => document.querySelector(".ve-builder-layer")?.dataset.screen !== prev, s, { timeout: 30000 }).catch(() => {});
  }
  await page.waitForSelector('.ve-builder-layer[data-screen="Spells"]');
  await shot("step");
  const counters = await layer.locator(".ve-builder-spell-counter").allInnerTexts();
  check("counters: Cantrips 0/1, Spellbook 0/2, Prepared 0/1", counters.join("|").replace(/\s+/g, " ") === "Cantrips 0 / 1|Spellbook 0 / 2|Prepared 0 / 1", counters);

  // Filter to level 2, search Misty, open the details window
  await layer.locator(".ve-builder-spell-filters .ve-builder-chip", { hasText: "Level 2" }).click();
  await layer.locator(".ve-builder-search").fill("Misty");
  await layer.locator(".ve-builder-spell-row:not([hidden]) .ve-builder-spell-open", { hasText: "Misty Step" }).click();
  const modal = page.locator(".ve-builder-layer .ve-item-modal");
  await modal.waitFor();
  const modalText = await modal.innerText();
  check("details window: name, Casting Time, Range, Components, description", modalText.includes("Misty Step") && /Casting Time/i.test(modalText)
    && /Range/i.test(modalText) && /Components/i.test(modalText) && /teleport/i.test(modalText), modalText.slice(0, 400));
  await shot("misty-step-details");
  // VE Back closes only the details window
  await modal.evaluate(el => el.dispatchEvent(new Event("ve-close")));
  check("VE Back closes the details window, not the builder", (await modal.count()) === 0 && (await layer.getAttribute("data-screen")) === "Spells");
  // Reopen and Pick from the window
  await layer.locator(".ve-builder-spell-row:not([hidden]) .ve-builder-spell-open", { hasText: "Misty Step" }).click();
  await modal.waitFor();
  await modal.locator(".ve-builder-spell-pick").click();
  check("Pick in the window selects Misty Step", (await layer.locator(".ve-builder-spell-row.is-selected", { hasText: "Misty Step" }).count()) >= 1);

  // One more spellbook spell, one cantrip, prepare Misty Step
  await layer.locator(".ve-builder-search").fill("");
  await layer.locator(".ve-builder-spell-filters .ve-builder-chip", { hasText: "Level 1" }).click();
  await layer.locator(".ve-builder-spell-row:not([hidden]):not(.is-selected) .ve-builder-spell-check:not([disabled])").first().click();
  await layer.locator(".ve-builder-spell-filters .ve-builder-chip", { hasText: "Cantrip" }).click();
  await layer.locator(".ve-builder-spell-row:not([hidden]):not(.is-selected) .ve-builder-spell-check:not([disabled])").first().click();
  await layer.locator(".ve-builder-spell-section .ve-builder-spell-row", { hasText: "Misty Step" }).locator(".ve-builder-spell-check").click();
  const done = await layer.locator(".ve-builder-spell-counter").allInnerTexts();
  check("counters full: 1/1, 2/2, 1/1", done.join("|").replace(/\s+/g, " ") === "Cantrips 1 / 1|Spellbook 2 / 2|Prepared 1 / 1", done);
  await layer.locator(".ve-builder-spell-filters .ve-builder-chip", { hasText: "All" }).click();
  await shot("picked");
  check("no swap sections for a Wizard level-up (cantrips swap on a Long Rest)", (await layer.locator(".ve-builder-spell-swap").count()) === 0);

  await next();
  await page.waitForSelector('.ve-builder-layer[data-screen="review"]');
  const review = await layer.locator(".ve-builder-body").innerText();
  // L20 fix 14: a Wizard's new prepared spell reads "Added to spellbook and prepared".
  check("review: Spells group with Misty Step learned and prepared", /Spells/i.test(review) && review.includes("Added to spellbook and prepared: Misty Step"), review);
  await shot("review");
  await layer.locator(".ve-builder-body").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot("review-bottom");

  await next(); // Commit
  await page.waitForSelector('.ve-builder-layer[data-screen="done"]', { timeout: 30000 });
  const after = await page.evaluate(id => { const a = game.actors.get(id); const misty = a.items.find(i => i.name === "Misty Step");
    return { level: a.system.details.level, misty: misty?.system.prepared, link: misty?.system.sourceItem }; }, setup.actorId);
  check("committed: Wizard 4 with Misty Step prepared and linked to the class", after.level === 4 && after.misty === 1 && after.link === "class:wizard", after);
  await shot("done");
} catch (error) {
  console.log("ERROR", error.message);
  await shot("error").catch(() => {});
  results.push(false);
} finally {
  await page.evaluate(async ({ actorId, previousCharacter, messages }) => {
    await game.user.update({ character: previousCharacter });
    await game.actors.get(actorId)?.delete();
    const keep = new Set(messages);
    for (const m of game.messages.contents.filter(m => !keep.has(m.id) && (m.content?.includes("ve-builder-chat-card") || m.flavor?.includes("hit points (level-up)")))) await m.delete();
    await game.user.unsetFlag("mobile-deck-dev", "builder");
  }, { ...setup, messages: messagesBefore }).catch(e => console.log("cleanup failed", e.message));
  console.log(`${results.filter(Boolean).length}/${results.length} passed; screenshots in ${shotsDir}`);
  await browser.close();
}
