// Phone-size UI test of Level Up in test-5e-world (Mobile Deck (DEV) must be enabled there).
// Builds a level 3 Fighter (Champion) with the engine, then levels it to 4 by tapping the
// real screens: average HP, the Grappler feat, Grappler's +1, a weapon mastery, Review
// changes, Commit, Change history. Screenshots go to tests/foundry/screens/.
// Cleans up the actor, chat messages, drafts and the GM's assigned character.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/level-up-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);

const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try {
    localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone"));
    localStorage.setItem("music-deck.deckLink", "false"); // keep the test browser off the real Stream Deck
  } catch {} }
};
const { browser, page } = await joinTestWorld("Claude Test GM", phone);
await pinToSrd(page); // the suite's expectations are for dnd5e's SRD content, not the user's books (pin-srd.mjs)
const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 400)); };
let n = 0;
const shot = async name => { await page.waitForTimeout(350); await page.screenshot({ path: `${shotsDir}${String(++n).padStart(2, "0")}-${name}.png` }); };

// Setup: a level 3 Champion built through the engine, assigned to Claude Test GM.
const messagesBefore = await page.evaluate(() => game.messages.map(m => m.id));
const setup = await page.evaluate(async () => {
  const { createBuilderController } = await import("/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder/builder-gateway.mjs");
  const uuidOf = async (packId, type, name) => (await game.packs.get(packId).getIndex()).find(e => e.type === type && e.name === name)?.uuid;
  const actor = await Actor.implementation.create({ name: "Brienne (CB phone test)", type: "character", img: "icons/svg/mystery-man.svg",
    system: { abilities: { str: { value: 15 }, dex: { value: 14 }, con: { value: 14 }, int: { value: 8 }, wis: { value: 12 }, cha: { value: 10 } },
      details: { xp: { value: 2700 } } } });
  const c = createBuilderController(actor);
  const play = async view => {
    while (view.screen === "step") {
      const m = view.model;
      let data, meta;
      if (m.type === "HitPoints") { data = { value: "avg" }; meta = { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod, modLabel: m.modLabel } }; }
      else if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); data = { chosen: [...chosen] }; }
      else if (m.type === "ItemChoice") data = { selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) };
      else if (m.type === "Subclass") { data = { uuid: m.options.find(o => o.name === "Champion").uuid }; meta = { kind: "subclass" }; }
      else throw new Error(`setup: unexpected ${m.type}`);
      view = await c.answer(data, meta);
    }
    await c.commit();
  };
  await play(await c.start({ kind: "new-class", classUuid: await uuidOf("dnd5e.classes24", "class", "Fighter"), label: "Fighter 1" }));
  const fighterId = actor.items.find(i => i.type === "class").id;
  await play(await c.start({ kind: "level", classId: fighterId }));
  await play(await c.start({ kind: "level", classId: fighterId }));
  const previousCharacter = game.user.character?.id ?? null;
  await game.user.update({ character: actor.id });
  return { actorId: actor.id, previousCharacter, level: actor.system.details.level };
});
check("setup: level 3 Champion", setup.level === 3, setup);

try {
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });
  // Headless Chromium triggers Foundry's permanent "no hardware acceleration" notices, which sit over the UI.
  await page.addStyleTag({ content: "#notifications { display: none !important; }" });
  // Other modules open windows in a fresh browser (Stream Deck pairing, settings sync); close them.
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.options?.window) await app.close().catch(() => {});
    for (const app of Object.values(ui.windows ?? {})) await app.close?.().catch?.(() => {});
  });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click().catch(() => {});
  // Level up is a square icon button beside the character chooser, not a full-width bar.
  const levelUp = page.locator(".ve-character-identity-controls .ve-character-level-up");
  await levelUp.waitFor({ timeout: 30000 });
  check("Level Up button in the character header", await levelUp.isVisible());
  check("button says ready (XP 2700 reached level 4's threshold)", (await levelUp.getAttribute("class")).includes("is-ready"));
  check("button is labelled Level up ready", await levelUp.getAttribute("aria-label") === "Level up ready", await levelUp.getAttribute("aria-label"));
  const placement = await page.evaluate(() => {
    const box = el => el?.getBoundingClientRect();
    const button = box(document.querySelector(".ve-character-level-up"));
    const chooser = box(document.querySelector(".ve-character-select-trigger"));
    const first = document.querySelector(".ve-character-name-first");
    const range = document.createRange();
    if (first?.firstChild) range.selectNodeContents(first);
    const name = first?.firstChild ? range.getBoundingClientRect() : null;
    return { button: button && { w: button.width, h: button.height, top: button.top, right: button.right, left: button.left },
      chooser: chooser && { w: chooser.width, h: chooser.height, top: chooser.top, left: chooser.left },
      nameRight: name?.right ?? null, text: document.querySelector(".ve-character-level-up")?.textContent.trim() };
  });
  check("icon button: 44px tap box, no text, level with the chooser and left of it",
    placement.button?.w === 44 && placement.button?.h === 44 && placement.text === ""
      && Math.abs(placement.button.top - placement.chooser.top) < 1 && placement.button.left < placement.chooser.left, placement);
  check("the name's first line stops before the level-up square", placement.nameRight === null || placement.nameRight <= placement.button.left + 11, placement);
  await shot("character-header");

  await levelUp.click();
  const layer = page.locator(".ve-builder-layer");
  await page.waitForSelector('.ve-builder-layer[data-screen="home"]');
  await shot("home");
  await layer.locator(".ve-builder-card", { hasText: "Fighter 3 → 4" }).click();

  const screen = () => layer.getAttribute("data-screen");
  const next = () => layer.locator(".ve-builder-primary").last().click();
  const waitScreen = async not => page.waitForFunction(prev => {
    const el = document.querySelector(".ve-builder-layer");
    return el && el.dataset.screen && el.dataset.screen !== prev && el.getAttribute("aria-busy") !== "true";
  }, not, { timeout: 30000 });

  await page.waitForSelector('.ve-builder-layer[data-screen="HitPoints"]');
  await shot("hp");
  await layer.locator(".ve-builder-big-choice").nth(1).click(); // Take average
  check("HP total preview: +8", (await layer.locator(".ve-builder-hp-total").textContent()).includes("+8"));
  await shot("hp-average");
  await next();

  const seen = [];
  let asiCount = 0;
  for (let guard = 0; guard < 10; guard++) {
    await page.waitForFunction(() => document.querySelector(".ve-builder-layer")?.getAttribute("aria-busy") !== "true");
    const s = await screen();
    if (s === "review") break;
    seen.push(s);
    if (s === "AbilityScoreImprovement" && asiCount++ === 0) {
      await layer.locator(".ve-builder-segment", { hasText: "Feat" }).click();
      const search = layer.locator(".ve-builder-search");
      if (await search.count()) await search.fill("Grappler");
      await layer.locator(".ve-builder-card", { hasText: "Grappler" }).click();
      await shot("asi-feat-grappler");
    } else if (s === "AbilityScoreImprovement") {
      await layer.locator(".ve-builder-asi-cell").first().locator(".ve-builder-step-btn").nth(1).click(); // STR +
      await shot("grappler-plus-one");
    } else if (s === "Trait") {
      await layer.locator(".ve-builder-chip:not([disabled])").first().click();
      await shot("weapon-mastery");
    } else {
      await shot(`step-${s}`);
    }
    await next();
    await waitScreen(s).catch(() => {});
  }
  // L20 fix 3: the Fighter's optional "Change an earlier pick?" card for its Fighting Style (skipped with Next).
  check("screens: feat, mastery, the optional Fighting Style change, then Grappler's own +1 (dnd5e adds a feat's steps at the end of the level)",
    seen.join(",") === "AbilityScoreImprovement,Trait,ItemChoice,AbilityScoreImprovement", seen);

  await page.waitForSelector('.ve-builder-layer[data-screen="review"]');
  const review = await layer.locator(".ve-builder-body").innerText();
  check("review lists HP, Grappler and STR", review.includes("Max HP 28 → 36") && review.includes("+ Grappler") && review.includes("STR 15 → 16"), review);
  await shot("review");
  await layer.locator(".ve-builder-body").evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot("review-bottom");

  await next(); // Commit
  await page.waitForSelector('.ve-builder-layer[data-screen="done"]', { timeout: 30000 });
  await shot("done");
  const after = await page.evaluate(id => { const a = game.actors.get(id); return { level: a.system.details.level, hp: a.system.attributes.hp.max, str: a.system.abilities.str.value, grappler: a.items.some(i => i.name === "Grappler") }; }, setup.actorId);
  check("actor is level 4, HP 36, STR 16, has Grappler", after.level === 4 && after.hp === 36 && after.str === 16 && after.grappler, after);
  await next(); // Close
  await page.waitForSelector(".ve-builder-layer", { state: "detached" });
  await page.waitForTimeout(800);
  await shot("header-after");

  const afterLevelUp = page.locator(".ve-character-identity-controls .ve-character-level-up");
  check("after levelling, the button is no longer ready", !(await afterLevelUp.getAttribute("class")).includes("is-ready") && await afterLevelUp.getAttribute("aria-label") === "Level up");
  await afterLevelUp.click();
  await page.waitForSelector('.ve-builder-layer[data-screen="home"]');
  await layer.locator(".ve-builder-link", { hasText: "Change history" }).click();
  await page.waitForSelector('.ve-builder-layer[data-screen="history"]');
  await layer.locator(".ve-builder-history summary").first().click();
  await shot("history");
  const historyCount = await layer.locator(".ve-builder-history").count();
  check("change history shows 4 entries", historyCount === 4, historyCount);

  // VE Back button: dispatch ve-close like ui/ve-back-dispatcher.mjs does.
  await layer.evaluate(el => el.dispatchEvent(new Event("ve-close")));
  check("Back from history returns to the start screen", (await screen()) === "home");
  await layer.evaluate(el => el.dispatchEvent(new Event("ve-close")));
  await page.waitForSelector(".ve-builder-layer", { state: "detached" });
  check("Back from the start screen closes the builder", true);
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
