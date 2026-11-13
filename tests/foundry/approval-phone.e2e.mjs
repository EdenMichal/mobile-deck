// Two-browser test of Phase 4b in test-5e-world: Claude Test Player on a phone (VE's UI), Claude Test GM on desktop, then on
// a phone. Screenshots go to tests/foundry/screens/approval-*.png.
// A. Creation: the player's draft is filled through the controller on the player's own page (the 4a phone test already taps
//    every tab). The player opens New character → Continue → Review, taps Submit for approval (waiting screen), Withdraws
//    and Submits again, closes the wizard: the New character row says it waits; View reopens the waiting screen. The GM's
//    desktop window sends it back with a note: the player's open wizard shows Review with the note; Submit again. The
//    GM taps Later (a chat card with Review appears), then Review reopens it; Approve. The player's open wizard
//    switches to Done.
// B. Level-up: a player-owned Fighter 1 (built by the GM). The player taps Level up → Fighter 1 → 2 → average HP → Review →
//    Submit. The GM's window: Send back with a reason. The player's open level-up reopens Review with the note; Submit again.
//    The GM's VE phone UI (a second GM login, phone): the approval layer; Approve. The player's open level-up shows Done.
// C. Auto: the GM switches "New characters need GM approval" off. First a character whose rolls warn (two ability sets, no
//    reroll counted): the GM's client doesn't save it but shows the popup, which sends it back. Then a clean second character
//    from the controller (only a soft Review note: Point Buy points unspent): the GM's client creates it without a popup; the player's flag gets the result, the New character
//    row says Approved, and tapping it opens the wizard on Done.
// Cleans up (on a fresh GM page if the last one failed): open approval popups first (their X posts a Later card), then
// actors, chat cards, the player's builder flag and assigned character, the house rules.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/approval-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { pinToSrd } from "./pin-srd.mjs";
import { ensureTestPlayer, TEST_PLAYER } from "./test-player.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("approval-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);
const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try { localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone")); localStorage.setItem("music-deck.deckLink", "false"); } catch {} }
};
const desktop = { context: { viewport: { width: 1280, height: 900 } },
  initScript: () => { try { localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("desktop")); localStorage.setItem("music-deck.deckLink", "false"); } catch {} } };
const moduleId = "mobile-deck-dev";

const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 400)); };
let n = 0;
const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${shotsDir}approval-${String(++n).padStart(2, "0")}-${name}.png` }); };
/** As level-up-phone.e2e.mjs: hide Foundry's notices, confirm VE's display-mode dialog, close other modules' windows, tap "Not now". */
const settle = async page => {
  await page.addStyleTag({ content: "#notifications { display: none !important; }" });
  await page.waitForTimeout(2500);
  // A fresh desktop browser gets VE's "Confirm display mode" dialog (the mode is preselected), which covers the page.
  await page.evaluate(() => [...document.querySelectorAll(".ve-auto-mode-confirmation button")].find(b => /confirm/i.test(b.textContent))?.click());
  await page.evaluate(async () => {
    // Framed windows only: the sidebar, chat and hotbar are frameless ApplicationV2s too, and the desktop GM needs them.
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.hasFrame && !app.options.classes?.includes("ve-builder-approval-window")) await app.close().catch(() => {});
  });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click().catch(() => {});
};
const gmWindow = ".ve-builder-approval-window";
const playerLayer = ".ve-builder-layer:not([data-ve-approval])";
const gmLayer = ".ve-mobile-app .ve-builder-layer[data-ve-approval]";
const idle = page => page.waitForFunction(sel => document.querySelector(sel)?.getAttribute("aria-busy") !== "true", playerLayer, { timeout: 30000 });
const text = async (page, sel) => (await page.textContent(sel)) ?? "";
/** Fill a finished Human Soldier Fighter draft on the player's own page (rules order, so class skills avoid the others' grants). */
const fillDraft = (page, name, abilities = null) => page.evaluate(async ({ moduleId, name, abilities }) => {
  const base = `/modules/${moduleId}/src/foundry/systems/dnd5e/builder`;
  const { createCreationController } = await import(`${base}/creation-controller.mjs`);
  const { t } = await import(`${base}/builder-gateway.mjs`);
  const { suggestedAssignments } = await import(`${base}/creation-rules.mjs`);
  const c = createCreationController({ moduleId, t });
  if (c.hasDraft()) await c.discard();
  await c.start({});
  const answerFor = m => {
    if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); return { data: { chosen: [...chosen] } }; }
    if (m.type === "ItemChoice") {
      const extra = { ...(m.abilityChoices?.length ? { ability: m.ability } : {}) };
      let open = m.options.filter(o => !o.blockers.length);
      if (m.spellLists?.length > 1) { extra.list = m.list ?? m.spellLists[0].key; open = open.filter(o => o.lists.includes(extra.list)); }
      return { data: { selected: open.slice(0, m.count).map(o => o.uuid), ...extra } };
    }
    if (m.type === "Size") return { data: { size: m.options.find(o => o.key === "med")?.key ?? m.options[0].key } };
    if (m.type === "ItemGrant") return { data: { selected: m.items.map(i => i.uuid), ...(m.abilityChoices?.length ? { ability: m.ability } : {}) } };
    if (m.type === "AbilityScoreImprovement") { const open = Object.keys(m.scores).filter(k => !m.config.locked.includes(k)); return { data: { type: "asi", assignments: { [open[0]]: 2, [open[1]]: 1 } } }; }
    if (m.type === "Subclass") return { data: { uuid: m.options[0].uuid }, meta: { kind: "subclass" } };
    throw new Error(m.type);
  };
  for (const [tab, pick] of [["background", "Soldier"], ["species", "Human"], ["class", "Fighter"]]) {
    let v = await c.segment(tab);
    const option = v.options.find(o => o.name === pick);
    v = await c.pick(tab, option.uuid ?? option.variants[0].uuid);
    for (let g = 0; v.screen === "step" && g < 30; g++) { const a = answerFor(v.model); v = await c.answer(tab, a.data, a.meta); }
  }
  const ab = c.abilities();
  await c.setAbilities(abilities ?? { method: "standardArray", assignments: suggestedAssignments(ab.classIdentifier, ab.slots) });
  const eq = await c.equipment();
  for (const s of eq.sections) await c.setEquipment(s.source, { option: s.options.find(o => o.kind === "gold").id });
  await c.setDetails({ name, alignment: "", biography: "" });
  return true;
}, { moduleId, name, abilities });
/** The New character row: on screen when the player has no character, else in the character chooser's menu. */
const newCharacterRow = async page => {
  const row = page.locator(".ve-character-menu-new");
  if (!(await row.isVisible().catch(() => false))) await page.locator('.ve-character-screen button[aria-haspopup="menu"]').first().click();
  await row.waitFor({ timeout: 15000 });
  return row;
};

let gm = await joinTestWorld("Claude Test GM", desktop);
await pinToSrd(gm.page);
const playerId = await ensureTestPlayer(gm.page);
const before = await gm.page.evaluate(({ playerId, moduleId }) => ({ messages: game.messages.map(m => m.id), character: game.users.get(playerId).character?.id ?? null,
  rules: foundry.utils.deepClone(game.settings.get(moduleId, "builderHouseRules") ?? {}) }), { playerId, moduleId });
// A clean start for the player: no draft, rolls or results from an earlier run.
await gm.page.evaluate(({ moduleId, playerId }) => game.users.get(playerId).update({ flags: { [moduleId]: globalThis._del !== undefined ? { builder: globalThis._del } : { "-=builder": null } } }), { moduleId, playerId });
const pl = await joinTestWorld(TEST_PLAYER, phone);
await pinToSrd(pl.page);
await settle(pl.page);
await settle(gm.page);
const createdNames = ["CB Approval Phone", "CB Approval Phone Brienne", "CB Approval Auto", "CB Approval Warned"];
try {
  await gm.page.evaluate(({ moduleId, rules }) => game.settings.set(moduleId, "builderHouseRules", { ...rules,
    abilityMethods: { standardArray: true, pointBuy: true, roll: false, manual: false }, abilityRerolls: 0, approval: { creation: true, levelUp: true } }), { moduleId, rules: before.rules });

  // ---- A. Creation
  await fillDraft(pl.page, "CB Approval Phone");
  await (await newCharacterRow(pl.page)).click();
  await pl.page.click(`${playerLayer} [data-action=resume]`);
  await pl.page.waitForSelector(`${playerLayer} .ve-builder-tab[data-tab=review]`);
  await idle(pl.page);
  await pl.page.click(`${playerLayer} .ve-builder-tab[data-tab=review]`);
  await pl.page.waitForSelector(`${playerLayer}[data-screen=review]`);
  await idle(pl.page);
  check("player's Review says Submit for approval", /Submit for approval/.test(await text(pl.page, `${playerLayer} .ve-builder-footer .ve-builder-primary`)));
  await shot(pl.page, "player-review-submit");
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`);
  await pl.page.waitForSelector(`${playerLayer}[data-screen=waiting]`);
  check("player sees the waiting screen with Withdraw", await pl.page.isVisible(`${playerLayer} [data-action=withdraw]`));
  await shot(pl.page, "player-waiting");
  // Withdraw: back to Review, editable; the GM's popup for that submission goes away. Then Submit again.
  await gm.page.waitForSelector(gmWindow, { timeout: 20000 });
  await pl.page.click(`${playerLayer} [data-action=withdraw]`);
  await pl.page.waitForSelector(`${playerLayer}[data-screen=review]`, { timeout: 15000 });
  await idle(pl.page);
  check("Withdraw reopens Review with Submit for approval", /Submit for approval/.test(await text(pl.page, `${playerLayer} .ve-builder-footer .ve-builder-primary`)));
  await gm.page.waitForSelector(gmWindow, { state: "detached", timeout: 15000 });
  check("the GM's popup closes when the player withdraws", true);
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`);
  await pl.page.waitForSelector(`${playerLayer}[data-screen=waiting]`);
  // Close the waiting screen: the New character row says it waits; View reopens the waiting screen.
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`);
  await pl.page.waitForSelector(playerLayer, { state: "detached" });
  const rowA = await newCharacterRow(pl.page);
  check("New character row: Waiting for GM approval", /Waiting for GM approval/.test(await rowA.textContent()), await rowA.textContent());
  await shot(pl.page, "player-row-waiting");
  await rowA.click();
  await pl.page.waitForSelector(`${playerLayer}[data-screen=start]`);
  check("start screen offers View and Withdraw", /View/.test(await text(pl.page, `${playerLayer} [data-action=resume]`)) && await pl.page.isVisible(`${playerLayer} [data-action=withdraw]`));
  await pl.page.click(`${playerLayer} [data-action=resume]`);
  await pl.page.waitForSelector(`${playerLayer}[data-screen=waiting]`);

  // Send back: the player's open wizard leaves the waiting screen for Review with the GM's note; the player submits again.
  await gm.page.waitForSelector(gmWindow, { timeout: 20000 });
  await gm.page.fill(`${gmWindow} [name=reason]`, "Pick a name that fits the setting, please.");
  await gm.page.click(`${gmWindow} [data-action=reject]`);
  await gm.page.waitForSelector(gmWindow, { state: "detached", timeout: 15000 });
  await pl.page.waitForSelector(`${playerLayer}[data-screen=review] .ve-builder-sent-back`, { timeout: 20000 });
  await idle(pl.page);
  check("player's open wizard reopens Review with the GM's note", /fits the setting/.test(await text(pl.page, `${playerLayer} .ve-builder-sent-back`))
    && /Submit for approval/.test(await text(pl.page, `${playerLayer} .ve-builder-footer .ve-builder-primary`)));
  await shot(pl.page, "player-creation-sent-back");
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`); // Submit again
  await pl.page.waitForSelector(`${playerLayer}[data-screen=waiting]`);

  await gm.page.waitForSelector(gmWindow, { timeout: 20000 });
  check("GM window: new character from Claude Test Player", /Claude Test Player: new character/.test(await text(gm.page, `${gmWindow} .window-title`)), await text(gm.page, `${gmWindow} .window-title`));
  check("GM window lists the review groups", (await gm.page.$$(`${gmWindow} .ve-builder-review-group`)).length >= 4);
  await shot(gm.page, "gm-desktop-creation");
  // Later: the window goes, a Review card arrives in chat; its button reopens the request.
  await gm.page.click(`${gmWindow} [data-action=later]`);
  await gm.page.waitForSelector(gmWindow, { state: "detached", timeout: 15000 });
  await gm.page.evaluate(() => { ui.sidebar?.expand?.(); ui.chat?.activate?.(); });
  const review = gm.page.locator("#chat [data-ve-builder-review]").last();
  await review.waitFor({ timeout: 15000 });
  await review.scrollIntoViewIfNeeded();
  const card = await review.evaluate(b => b.closest(".ve-builder-chat-card")?.textContent ?? "");
  check("Later card: the player is waiting for approval of the new character", /Claude Test Player is waiting for your approval of a new character \(CB Approval Phone\)/.test(card), card);
  await shot(gm.page, "gm-later-card");
  await review.click();
  await gm.page.waitForSelector(gmWindow, { timeout: 20000 });
  await gm.page.click(`${gmWindow} [data-action=approve]`);
  await gm.page.waitForSelector(gmWindow, { state: "detached", timeout: 30000 });
  await pl.page.waitForSelector(`${playerLayer}[data-screen=done]`, { timeout: 20000 });
  check("player's wizard shows Done, approved by the GM", /Approved by Claude Test GM/.test(await text(pl.page, `${playerLayer} .ve-builder-lead`)), await text(pl.page, `${playerLayer} .ve-builder-lead`));
  await shot(pl.page, "player-approved");
  const made = await gm.page.evaluate(playerId => { const a = game.actors.getName("CB Approval Phone"); return a ? { owner: a.ownership[playerId], assigned: game.users.get(playerId).character?.id === a.id } : null; }, playerId);
  check("actor exists, owned by and assigned to the player", made?.owner === 3 && made.assigned, made);
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`); // Close
  await pl.page.waitForSelector(playerLayer, { state: "detached" });

  // ---- B. Level-up. The GM builds a Fighter 1 owned by the player; the player makes it their character.
  const heroId = await gm.page.evaluate(async ({ moduleId, playerId }) => {
    const { createBuilderController } = await import(`/modules/${moduleId}/src/foundry/systems/dnd5e/builder/builder-gateway.mjs`);
    const fighter = (await game.packs.get("dnd5e.classes24").getIndex()).find(e => e.type === "class" && e.name === "Fighter");
    const hero = await Actor.implementation.create({ name: "CB Approval Phone Brienne", type: "character", ownership: { default: 0, [playerId]: 3 },
      system: { abilities: { str: { value: 15 }, dex: { value: 14 }, con: { value: 14 }, int: { value: 8 }, wis: { value: 12 }, cha: { value: 10 } }, details: { xp: { value: 300 } } } });
    const c = createBuilderController(hero, { moduleId });
    let v = await c.start({ kind: "new-class", classUuid: fighter.uuid, label: "Fighter 1" });
    for (let g = 0; v.screen === "step" && g < 20; g++) {
      const m = v.model;
      const a = m.type === "Trait" ? { data: { chosen: m.slots.flatMap(s => s.options.slice(0, s.count).map(o => o.key)) } }
        : m.type === "ItemChoice" ? { data: { selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) } } : null;
      if (!a) throw new Error(m.type);
      v = await c.answer(a.data, a.meta);
    }
    await c.commit();
    await game.users.get(playerId).update({ character: hero.id });
    return hero.id;
  }, { moduleId, playerId });
  await pl.page.reload();
  await pl.page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });
  await settle(pl.page);
  const levelUp = pl.page.locator(".ve-character-identity-controls .ve-character-level-up"); // the icon button beside the chooser
  await levelUp.waitFor({ timeout: 30000 });
  await levelUp.click();
  await pl.page.waitForSelector(`${playerLayer}[data-screen=home]`);
  await pl.page.locator(`${playerLayer} .ve-builder-card`, { hasText: "Fighter 1 → 2" }).click();
  await pl.page.waitForSelector(`${playerLayer}[data-screen=HitPoints]`);
  await pl.page.locator(`${playerLayer} .ve-builder-big-choice`).nth(1).click(); // Take average
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`);
  // L20 fix 3: Fighter 2 offers an optional "Change an earlier pick?" card for the Fighting Style; Next keeps it.
  await pl.page.waitForSelector(`${playerLayer}[data-screen=ItemChoice], ${playerLayer}[data-screen=review]`, { timeout: 20000 });
  if (await pl.page.isVisible(`${playerLayer}[data-screen=ItemChoice]`)) {
    await idle(pl.page);
    await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`);
  }
  await pl.page.waitForSelector(`${playerLayer}[data-screen=review]`, { timeout: 20000 });
  await idle(pl.page);
  check("level-up Review says Submit for approval", /Submit for approval/.test(await text(pl.page, `${playerLayer} .ve-builder-footer .ve-builder-primary`)));
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`);
  await pl.page.waitForSelector(`${playerLayer}[data-screen=waiting]`);
  check("level-up waiting screen has Withdraw", await pl.page.isVisible(`${playerLayer} [data-action=withdraw]`));
  await shot(pl.page, "player-levelup-waiting");
  await gm.page.waitForSelector(gmWindow, { timeout: 20000 });
  check("GM window: level up the Fighter", /level up CB Approval Phone Brienne/.test(await text(gm.page, `${gmWindow} .window-title`)), await text(gm.page, `${gmWindow} .window-title`));
  await gm.page.fill(`${gmWindow} [name=reason]`, "Please double-check, then send it again.");
  await gm.page.locator(`${gmWindow} .ve-builder-approval`).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot(gm.page, "gm-desktop-send-back");
  await gm.page.click(`${gmWindow} [data-action=reject]`);
  await gm.page.waitForSelector(gmWindow, { state: "detached", timeout: 15000 });
  await pl.page.waitForSelector(`${playerLayer}[data-screen=review] .ve-builder-sent-back`, { timeout: 20000 });
  check("player's open level-up reopens Review with the GM's note", /double-check/.test(await text(pl.page, `${playerLayer} .ve-builder-sent-back`)));
  await idle(pl.page);
  await shot(pl.page, "player-sent-back");
  // GM moves to VE's phone UI for the second round.
  await gm.browser.close();
  gm = await joinTestWorld("Claude Test GM", phone);
  await pinToSrd(gm.page);
  await settle(gm.page);
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`); // Submit again
  await pl.page.waitForSelector(`${playerLayer}[data-screen=waiting]`);
  await gm.page.waitForSelector(`${gmLayer}[data-screen=approval]`, { timeout: 20000 });
  check("GM phone: the approval layer inside VE", /level up CB Approval Phone Brienne/.test(await text(gm.page, `${gmLayer} .ve-builder-header h2`)), await text(gm.page, `${gmLayer} .ve-builder-header h2`));
  await shot(gm.page, "gm-phone-levelup");
  await gm.page.locator(`${gmLayer} .ve-builder-body`).evaluate(el => { el.scrollTop = el.scrollHeight; });
  await shot(gm.page, "gm-phone-levelup-bottom");
  await gm.page.click(`${gmLayer} .ve-builder-footer .ve-builder-primary`);
  await gm.page.waitForSelector(gmLayer, { state: "detached", timeout: 30000 });
  await pl.page.waitForSelector(`${playerLayer}[data-screen=done]`, { timeout: 20000 });
  check("player's level-up shows Done, approved", /Approved by Claude Test GM/.test(await text(pl.page, `${playerLayer} .ve-builder-lead`)), await text(pl.page, `${playerLayer} .ve-builder-lead`));
  await shot(pl.page, "player-levelup-approved");
  check("the Fighter is level 2", await gm.page.evaluate(id => game.actors.get(id).system.details.level === 2, heroId));
  await pl.page.click(`${playerLayer} .ve-builder-footer .ve-builder-primary`); // Close
  await pl.page.waitForSelector(playerLayer, { state: "detached" });

  // ---- C. Auto: approval for new characters switched off.
  await gm.page.evaluate(({ moduleId }) => game.settings.set(moduleId, "builderHouseRules", { ...game.settings.get(moduleId, "builderHouseRules"), approval: { creation: false, levelUp: true } }), { moduleId });
  const submitDraft = () => pl.page.evaluate(async ({ moduleId }) => {
    const base = `/modules/${moduleId}/src/foundry/systems/dnd5e/builder`;
    const { createCreationController } = await import(`${base}/creation-controller.mjs`);
    const { t } = await import(`${base}/builder-gateway.mjs`);
    const c = createCreationController({ moduleId, t });
    await c.resume();
    const r = await c.review();
    await c.submit();
    return { mode: r.mode, warnings: r.warnings.map(w => w.text) };
  }, { moduleId });
  const setRolls = sets => pl.page.evaluate(({ moduleId, sets }) => game.user.setFlag(moduleId, "builder", { creationRolls: JSON.stringify({
    abilities: { sets, rerollsUsed: 0, messageIds: sets.map(() => "") }, gold: {}, trinket: null }) }), { moduleId, sets });
  // A submission with warnings (rolls that don't add up) is never saved without the GM: it goes to the popup.
  await fillDraft(pl.page, "CB Approval Warned");
  await setRolls([[15, 14, 13, 12, 10, 8], [18, 18, 18, 18, 18, 18]]);
  await submitDraft();
  await gm.page.waitForSelector(`${gmLayer}[data-screen=approval]`, { timeout: 30000 });
  const warned = await text(gm.page, `${gmLayer} .ve-builder-body`);
  check("switch off, but warned: the popup shows it instead of saving it", /ability sets were rolled/.test(warned)
    && !(await gm.page.evaluate(() => Boolean(game.actors.getName("CB Approval Warned")))), warned.slice(0, 300));
  await shot(gm.page, "gm-phone-auto-warned");
  await gm.page.fill(`${gmLayer} [name=reason]`, "Your rolls don't add up; please roll again with me.");
  await gm.page.click(`${gmLayer} [data-action=reject]`);
  await gm.page.waitForSelector(gmLayer, { state: "detached", timeout: 15000 });
  await setRolls([]);
  // Clean apart from a soft Review note (Point Buy points left unspent): saved without the GM.
  await fillDraft(pl.page, "CB Approval Auto", { method: "pointBuy", pointBuy: { str: 15, dex: 14, con: 13, int: 8, wis: 8, cha: 8 }, assignments: {} });
  const { mode, warnings: softNotes } = await submitDraft();
  check("the auto submission carries only a soft note (points unspent)", softNotes.length === 1 && /Point Buy points not spent/.test(softNotes[0]), softNotes);
  check("switch off: the player's Review mode is auto", mode === "auto", mode);
  await gm.page.waitForFunction(() => Boolean(game.actors.getName("CB Approval Auto")), null, { timeout: 30000 });
  check("the GM's client created it without a popup", !(await gm.page.$(".ve-builder-layer[data-ve-approval]")));
  await pl.page.waitForFunction(m => game.user.getFlag(m, "builder")?.results?.creation?.name === "CB Approval Auto", moduleId, { timeout: 15000 }).catch(() => {});
  check("the player has the result", await pl.page.evaluate(m => Boolean(game.user.getFlag(m, "builder")?.results?.creation?.name === "CB Approval Auto"), moduleId));
  const rowC = await newCharacterRow(pl.page);
  check("New character row: Approved by your GM", /Approved by your GM/.test(await rowC.textContent()), await rowC.textContent());
  await shot(pl.page, "player-row-approved");
  await rowC.click();
  await pl.page.waitForSelector(`${playerLayer}[data-screen=done]`, { timeout: 15000 });
  check("New character opens on Done for the GM-made character", /CB Approval Auto/.test(await text(pl.page, `${playerLayer} .ve-builder-lead`)), await text(pl.page, `${playerLayer} .ve-builder-lead`));
  await shot(pl.page, "player-auto-done");
  await pl.page.waitForFunction(m => !game.user.getFlag(m, "builder")?.results?.creation, moduleId, { timeout: 15000 }).catch(() => {});
  check("Done clears the result", await pl.page.evaluate(m => !game.user.getFlag(m, "builder")?.results?.creation, moduleId));
} catch (error) {
  check(`no exception: ${error.message}`, false, error.stack);
  await shot(pl.page, "error-player").catch(() => {});
  await shot(gm.page, "error-gm").catch(() => {});
} finally {
  const cleanup = page => page.evaluate(async ({ moduleId, playerId, names, before }) => {
    globalThis.veBuilderApprovalPaused = true;
    // Popups first: closing one (X) posts a Later card even while paused; the chat cards go after.
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.options?.classes?.includes("ve-builder-approval-window")) await app.close().catch(() => {});
    for (const layer of document.querySelectorAll(".ve-builder-layer[data-ve-approval]")) layer.querySelector(".ve-builder-close")?.click();
    await new Promise(r => setTimeout(r, 1500));
    for (const name of names) for (const a of game.actors.filter(x => x.name === name)) await a.delete();
    const drop = { [moduleId]: globalThis._del !== undefined ? { builder: globalThis._del } : { "-=builder": null } };
    await game.users.get(playerId).update({ flags: drop, character: before.character });
    await game.settings.set(moduleId, "builderHouseRules", before.rules);
    const mine = game.messages.contents.filter(m => !before.messages.includes(m.id)).map(m => m.id);
    if (mine.length) await ChatMessage.deleteDocuments(mine);
  }, { moduleId, playerId, names: createdNames, before });
  await pl.browser.close().catch(() => {}); // no late writes from the player's page during cleanup
  try { await cleanup(gm.page); }
  catch (error) {
    console.log("cleanup on the open GM page failed, retrying on a fresh one:", error.message);
    await gm.browser.close().catch(() => {});
    gm = await joinTestWorld("Claude Test GM", desktop);
    await cleanup(gm.page).catch(e => console.log("CLEANUP FAILED", e.message));
  }
  await gm.browser.close().catch(() => {});
}
const failed = results.filter(r => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
