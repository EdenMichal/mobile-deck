// Phone-size UI test of the party inventory in test-5e-world (Mobile Deck (DEV) enabled there).
// Claude Test GM (desktop) builds a Group actor "VE Party Test Company" owned by Claude Test Player, makes it the primary
// party and fills it: 5 Potions of Healing, Rope, a Bag with a Ruby inside, 20 gp. The player owns two characters
// (Ayla and Bram); Ayla is assigned and carries an equipped Longsword.
// Claude Test Player on a phone (VE's UI): Inventory → Party Inventory, then
//   take the Rope (single item, no picker); take 2 of the 5 potions with the quantity picker; take the Bag (the Ruby comes
//   with it); send the Longsword from the "Send from" list (arrives unequipped); send the 2 potions back from the inventory
//   item menu (Send to Party → All), which joins the party's stack again; withdraw 5 gp; deposit 3 gp.
// Each move must leave a public chat note. Every move runs on the active GM's client (the GM page stays online
// throughout; the "no GM online" refusal is covered by unit tests only). Then:
//   GM relay, partial stack: two near-simultaneous takes of 1 from a stack of 2 (one from the GM's client for Bram, one
//   from the player's client for Ayla): exactly 2 leave the party, each character gets 1;
//   GM relay, last item: both clients take the same last Lucky Coin: one wins, one is refused, exactly one copy exists;
//   read-only: the GM drops the player to Observer: the page explains Owner is needed and shows no Take buttons;
//   Limited: the page names the group and asks for Owner;
//   hidden primary party: the page says a party exists but the player has no access (no fallback to another group);
//   no party: primary party cleared and the group hidden: "No party inventory yet" (if no other group is visible).
// Screenshots go to tests/foundry/screens/party-*.png.
// Cleans up the actors, the chat notes, the primary-party setting and the player's assigned character.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/party-inventory-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { ensureTestPlayer, TEST_PLAYER } from "./test-player.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("party-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);
const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try { localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone")); localStorage.setItem("music-deck.deckLink", "false"); } catch {} }
};
const desktop = { context: { viewport: { width: 1280, height: 900 } },
  initScript: () => { try { localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("desktop")); localStorage.setItem("music-deck.deckLink", "false"); } catch {} } };
const moduleId = "mobile-deck-dev";
const PARTY = "VE Party Test Company";
const AYLA = "VE Party Test Ayla";
const BRAM = "VE Party Test Bram";

const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 400)); };
let n = 0;
const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${shotsDir}party-${String(++n).padStart(2, "0")}-${name}.png` }); };
/** As approval-phone.e2e.mjs: hide Foundry's notices, confirm VE's display-mode dialog, close other modules' windows, tap "Not now". */
const settle = async page => {
  await page.addStyleTag({ content: "#notifications { display: none !important; }" });
  await page.waitForTimeout(2500);
  await page.evaluate(() => [...document.querySelectorAll(".ve-auto-mode-confirmation button")].find(b => /confirm/i.test(b.textContent))?.click());
  await page.evaluate(async () => {
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.hasFrame) await app.close().catch(() => {});
  });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click().catch(() => {});
};
/** Plain state of the test actors, read on any page. */
const readState = page => page.evaluate(({ PARTY, AYLA, BRAM }) => {
  const pick = actor => actor ? {
    currency: { ...actor.system.currency },
    items: actor.items.filter(i => ["weapon", "equipment", "consumable", "tool", "loot", "container"].includes(i.type))
      .map(i => ({ id: i.id, name: i.name, quantity: i.system.quantity, equipped: i.system.equipped ?? null, container: i.system.container ?? null }))
  } : null;
  return { party: pick(game.actors.getName(PARTY)), ayla: pick(game.actors.getName(AYLA)), bram: pick(game.actors.getName(BRAM)) };
}, { PARTY, AYLA, BRAM });
const itemOf = (side, name) => side?.items.find(i => i.name === name) ?? null;
const notes = page => page.evaluate(before => game.messages.contents.filter(m => !before.includes(m.id) && m.content?.includes("ve-party-note"))
  .map(m => ({ text: m.content.replace(/<[^>]+>/g, ""), whisper: m.whisper?.length ?? 0 })), beforeMessages);
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });

let gm = await joinTestWorld("Claude Test GM", desktop);
const playerId = await ensureTestPlayer(gm.page);
const beforeMessages = await gm.page.evaluate(() => game.messages.map(m => m.id));
const before = await gm.page.evaluate(playerId => ({
  character: game.users.get(playerId).character?.id ?? null,
  primary: game.settings.get("dnd5e", "primaryParty")?.actor?.id ?? null
}), playerId);

// ---- Setup on the GM page
const setup = await gm.page.evaluate(async ({ playerId, PARTY, AYLA, BRAM }) => {
  for (const name of [PARTY, AYLA, BRAM]) for (const a of game.actors.filter(x => x.name === name)) await a.delete();
  const owned = { default: 0, [playerId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER };
  const ayla = await Actor.implementation.create({ name: AYLA, type: "character", ownership: owned, system: { currency: { gp: 10 } } });
  const bram = await Actor.implementation.create({ name: BRAM, type: "character", ownership: owned });
  await ayla.createEmbeddedDocuments("Item", [{ name: "Longsword", type: "weapon", system: { quantity: 1, equipped: true, weight: { value: 3, units: "lb" } } }]);
  const party = await Actor.implementation.create({ name: PARTY, type: "group", ownership: owned,
    system: { currency: { gp: 20 }, members: [{ actor: ayla.id }, { actor: bram.id }] } });
  const [bag] = await party.createEmbeddedDocuments("Item", [{ name: "Test Bag", type: "container", system: { quantity: 1 } }]);
  await party.createEmbeddedDocuments("Item", [
    { name: "Potion of Healing", type: "consumable", system: { quantity: 5 }, _stats: { compendiumSource: "Compendium.dnd5e.items.Item.ztgcdrWPshKRpFd0" } },
    { name: "Rope", type: "loot", system: { quantity: 1 } },
    { name: "Ruby", type: "loot", system: { quantity: 1, container: bag.id } },
    { name: "Lucky Coin", type: "loot", system: { quantity: 1 } },
    { name: "Arrow Bundle", type: "consumable", system: { quantity: 2 } }
  ]);
  await game.settings.set("dnd5e", "primaryParty", { actor: party.id });
  await game.users.get(playerId).update({ character: ayla.id });
  return { partyId: party.id, aylaId: ayla.id, bramId: bram.id };
}, { playerId, PARTY, AYLA, BRAM });
check("setup: party, two characters, primary party set", Boolean(setup.partyId && setup.aylaId && setup.bramId), setup);

const pl = await joinTestWorld(TEST_PLAYER, phone);
await settle(pl.page);
await settle(gm.page);
const page = pl.page;
const stashRow = name => page.locator("[data-party-stash] .ve-party-row", { hasText: name });
const mineRow = name => page.locator("[data-party-mine] .ve-party-row", { hasText: name });

try {
  // ---- Entry point: Inventory tab → Party Inventory
  await page.locator('[data-character-tab="inventory"]').click({ timeout: 30000 });
  const entry = page.locator(".ve-party-entry");
  await entry.waitFor({ timeout: 15000 });
  check("Inventory shows the Party Inventory row with the party's name", (await entry.innerText()).includes(PARTY), await entry.innerText());
  await shot(page, "inventory-entry");
  await entry.click();
  await page.waitForSelector("[data-party-stash]");
  const heading = await page.locator("[data-party-stash] .ve-sheet-card-heading h3").innerText();
  check("Party page: heading is the group's name", heading.toUpperCase() === PARTY.toUpperCase(), heading);
  check("Party page: five loose rows plus the Ruby inside the Bag", (await page.locator("[data-party-stash] .ve-party-row").count()) === 6);
  check("Party page: the Ruby is indented under the Bag", (await stashRow("Ruby").getAttribute("data-depth")) === "1");
  check("Party page: GP shows 20", /20/.test(await page.locator("[data-party-stash] .ve-party-coins .is-gp").innerText()));
  await shot(page, "stash");

  // ---- Take a single item: no picker
  await stashRow("Rope").locator(".ve-party-move").click();
  await waitFor(page, ({ PARTY, AYLA }) => !game.actors.getName(PARTY).items.getName("Rope") && game.actors.getName(AYLA).items.getName("Rope"), { PARTY, AYLA });
  check("Take Rope: moved without a picker", (await page.locator(".ve-party-sheet").count()) === 0);

  // ---- Take part of a stack with the picker
  await stashRow("Potion of Healing").locator(".ve-party-move").click();
  const sheet = page.locator(".ve-party-sheet");
  await sheet.waitFor();
  check("Potion picker: defaults to 1 of 5", (await sheet.locator(".ve-party-stepper input").inputValue()) === "1" && /5/.test(await sheet.locator(".ve-party-sheet-hint").innerText()));
  await sheet.locator(".ve-party-stepper button").nth(1).click(); // +
  check("Potion picker: + makes it 2 and the button says Take 2", /Take 2/.test(await sheet.locator(".ve-currency-editor-submit").innerText()));
  await shot(page, "take-picker");
  await sheet.locator(".ve-currency-editor-submit").click();
  await waitFor(page, ({ PARTY }) => game.actors.getName(PARTY).items.getName("Potion of Healing")?.system.quantity === 3, { PARTY });
  let state = await readState(page);
  check("Take 2 potions: party 3, Ayla 2", itemOf(state.party, "Potion of Healing")?.quantity === 3 && itemOf(state.ayla, "Potion of Healing")?.quantity === 2, state);

  // ---- A container moves with its contents
  await stashRow("Test Bag").locator(".ve-party-move").first().click();
  await waitFor(page, ({ AYLA }) => game.actors.getName(AYLA).items.getName("Ruby"), { AYLA });
  state = await readState(page);
  const bag = itemOf(state.ayla, "Test Bag"), ruby = itemOf(state.ayla, "Ruby");
  check("Take the Bag: the Ruby comes along inside it", bag && ruby && ruby.container === bag.id && !itemOf(state.party, "Ruby") && !itemOf(state.party, "Test Bag"), state);

  // ---- Send from the "Send from" list: arrives unequipped
  const mine = page.locator("details.ve-party-mine");
  if (!(await mine.evaluate(el => el.open))) await mine.locator("summary").click();
  await mineRow("Longsword").locator(".ve-party-move").click();
  await waitFor(page, ({ PARTY }) => game.actors.getName(PARTY).items.getName("Longsword"), { PARTY });
  state = await readState(page);
  check("Send Longsword: in the party, not equipped, gone from Ayla", itemOf(state.party, "Longsword")?.equipped === false && !itemOf(state.ayla, "Longsword"), state);
  await shot(page, "after-moves");

  // ---- Send to Party from the inventory item menu (keyboard ContextMenu opens the same menu as a long press)
  await page.locator(".ve-sheet-back", { hasText: "Inventory" }).click();
  await page.waitForSelector(".ve-sheet-collection-section");
  await page.evaluate(() => document.querySelectorAll("details.ve-sheet-collection-section").forEach(section => { section.open = true; }));
  const potionRow = page.locator(".ve-sheet-item-row", { hasText: "Potion of Healing" }).first();
  await potionRow.waitFor();
  await potionRow.focus();
  await page.keyboard.press("ContextMenu");
  const menuItem = page.locator(".ve-character-item-menu button", { hasText: "Send to Party" });
  await menuItem.waitFor({ timeout: 10000 });
  const menuOrder = await page.$$eval(".ve-character-item-menu button", buttons => buttons.map(b => b.textContent.trim()));
  check("Item menu: Send to Party, then Delete last", menuOrder.at(-1) === "Delete" && menuOrder.at(-2) === "Send to Party", menuOrder);
  await shot(page, "item-menu");
  await menuItem.click();
  await sheet.waitFor();
  await sheet.locator(".ve-party-presets button").last().click(); // All 2
  await sheet.locator(".ve-currency-editor-submit").click();
  await waitFor(page, ({ PARTY }) => game.actors.getName(PARTY).items.getName("Potion of Healing")?.system.quantity === 5, { PARTY });
  state = await readState(page);
  check("Send 2 potions back: they join the party's stack (one row of 5)", state.party.items.filter(i => i.name === "Potion of Healing").length === 1
    && itemOf(state.party, "Potion of Healing").quantity === 5 && !itemOf(state.ayla, "Potion of Healing"), state);

  // ---- Coins
  await page.locator(".ve-party-entry").click();
  await page.locator('[data-party-coins="withdraw"]').click();
  const coins = page.locator(".ve-party-sheet");
  await coins.waitFor();
  await coins.locator(".ve-party-coin-row.is-gp input").fill("5");
  await shot(page, "withdraw");
  await coins.locator(".ve-currency-editor-submit").click();
  await waitFor(page, ({ PARTY }) => game.actors.getName(PARTY).system.currency.gp === 15, { PARTY });
  state = await readState(page);
  check("Withdraw 5 gp: party 15, Ayla 15", state.party.currency.gp === 15 && state.ayla.currency.gp === 15, state);
  await page.locator('[data-party-coins="deposit"]').click();
  await coins.waitFor();
  await coins.locator(".ve-party-coin-row.is-gp input").fill("3");
  await coins.locator(".ve-currency-editor-submit").click();
  await waitFor(page, ({ PARTY }) => game.actors.getName(PARTY).system.currency.gp === 18, { PARTY });
  state = await readState(page);
  check("Deposit 3 gp: party 18, Ayla 12", state.party.currency.gp === 18 && state.ayla.currency.gp === 12, state);
  const overdraw = await page.evaluate(async ({ moduleId, AYLA, PARTY }) => {
    const { transferPartyCurrency } = await import(`/modules/${moduleId}/src/foundry/systems/dnd5e/party-stash.mjs`);
    try { await transferPartyCurrency(game.actors.getName(AYLA), { partySourceUuid: game.actors.getName(PARTY).uuid, direction: "withdraw", amounts: { gp: 999 } }); return "allowed"; }
    catch (error) { return error.code; }
  }, { moduleId, AYLA, PARTY });
  check("Withdrawing more than the party has is refused", overdraw === "STALE_STATE", overdraw);

  // ---- Chat notes
  const posted = await notes(gm.page);
  // Rope, 2 potions, Bag, Longsword, potions back, withdraw, deposit; the refused overdraw posts nothing.
  check("Chat notes: one public note per move (7)", posted.length === 7 && posted.every(note => note.whisper === 0), posted);
  check("Chat note wording", posted.some(note => note.text.includes(`${AYLA} took 2× Potion of Healing from ${PARTY}.`))
    && posted.some(note => note.text.includes(`${AYLA} put 3 gp in ${PARTY}.`)), posted);

  // ---- GM relay: two clients take from the same stack at once; the GM's client runs the moves one at a time
  const take = ({ moduleId, actorName, PARTY, itemName }) => (async () => {
    const { transferPartyItem } = await import(`/modules/${moduleId}/src/foundry/systems/dnd5e/party-stash.mjs`);
    const party = game.actors.getName(PARTY);
    const item = party.items.getName(itemName);
    if (!item) return "not-visible";
    try { await transferPartyItem(game.actors.getName(actorName), { partySourceUuid: party.uuid, direction: "take", itemId: item.id, quantity: 1 }); return "ok"; }
    catch (error) { return error.code ?? error.message; }
  })();
  check("GM relay: the player's client sees an active GM that is not itself", await page.evaluate(() => Boolean(game.users.activeGM && !game.users.activeGM.isSelf)));
  const split = await Promise.all([
    gm.page.evaluate(take, { moduleId, actorName: BRAM, PARTY, itemName: "Arrow Bundle" }),
    page.evaluate(take, { moduleId, actorName: AYLA, PARTY, itemName: "Arrow Bundle" })
  ]);
  await page.waitForTimeout(1500);
  state = await readState(gm.page);
  check("Stack of 2, two takes of 1 at once: both succeed, exactly 2 leave the party, 1 each", split.every(r => r === "ok")
    && !itemOf(state.party, "Arrow Bundle") && itemOf(state.ayla, "Arrow Bundle")?.quantity === 1 && itemOf(state.bram, "Arrow Bundle")?.quantity === 1, { split, state });

  const raced = await Promise.all([
    gm.page.evaluate(take, { moduleId, actorName: BRAM, PARTY, itemName: "Lucky Coin" }),
    page.evaluate(take, { moduleId, actorName: AYLA, PARTY, itemName: "Lucky Coin" })
  ]);
  await page.waitForTimeout(1500);
  state = await readState(gm.page);
  const copies = [state.ayla, state.bram].flatMap(side => side.items.filter(i => i.name === "Lucky Coin")).length;
  check("Race for the last Lucky Coin: one wins, one is refused, exactly one copy", raced.filter(r => r === "ok").length === 1
    && copies === 1 && !itemOf(state.party, "Lucky Coin"), { raced, copies });

  // ---- Read-only for an Observer
  await gm.page.evaluate(({ PARTY, playerId }) => game.actors.getName(PARTY).update({ [`ownership.${playerId}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }), { PARTY, playerId });
  await waitFor(page, () => Boolean(document.querySelector(".ve-party-notice")));
  check("Observer: the page says Owner is needed and shows no Take buttons", /Owner permission/.test(await page.locator(".ve-party-notice").innerText())
    && (await page.locator("[data-party-stash] .ve-party-move").count()) === 0 && (await page.locator("[data-party-coins]").count()) === 0);
  await shot(page, "read-only");

  // ---- Limited: the group is named, the page asks for Owner
  await gm.page.evaluate(({ PARTY, playerId }) => game.actors.getName(PARTY).update({ [`ownership.${playerId}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.LIMITED }), { PARTY, playerId });
  await waitFor(page, () => document.querySelector("[data-party-state]")?.dataset.partyState === "locked");
  const limitedText = await page.locator(".ve-party-empty").innerText();
  check("Limited: the page names the group and asks the GM for Owner", limitedText.includes(PARTY) && /Owner permission/.test(limitedText), limitedText);
  await shot(page, "limited");

  // ---- Hidden primary party: a no-access state, never an unrelated group
  await gm.page.evaluate(({ PARTY, playerId }) => game.actors.getName(PARTY).update({ [`ownership.${playerId}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.NONE }), { PARTY, playerId });
  await page.waitForTimeout(1500);
  const hiddenText = await page.locator(".ve-party-empty").innerText();
  check("Hidden primary party: \"you don't have access\", not another group", /don't have access/.test(hiddenText) && !hiddenText.includes(PARTY), hiddenText);
  await shot(page, "hidden-primary");

  // ---- No party: primary party cleared and the group still hidden
  await gm.page.evaluate(() => game.settings.set("dnd5e", "primaryParty", { actor: null }));
  await page.waitForTimeout(1500);
  const otherGroups = await page.evaluate(() => game.actors.filter(a => a.type === "group" && a.testUserPermission(game.user, "LIMITED")).length);
  if (otherGroups) console.log(`SKIP no-party state: ${otherGroups} other group(s) are visible to the player in this world`);
  else {
    await waitFor(page, () => document.querySelector("[data-party-state]")?.dataset.partyState === "missing");
    check("No group: the page tells the GM to create a Group actor", /Group actor/.test(await page.locator(".ve-party-empty").innerText()));
    await shot(page, "no-party");
  }
} catch (error) {
  check(`no exception: ${error.message}`, false, error.stack);
  await shot(pl.page, "error-player").catch(() => {});
} finally {
  const cleanup = gmPage => gmPage.evaluate(async ({ playerId, names, before }) => {
    await game.settings.set("dnd5e", "primaryParty", { actor: before.primary });
    await game.users.get(playerId).update({ character: before.character });
    for (const name of names) for (const a of game.actors.filter(x => x.name === name)) await a.delete();
    const mine = game.messages.contents.filter(m => !before.messages.includes(m.id) && m.content?.includes("ve-party-note")).map(m => m.id);
    if (mine.length) await ChatMessage.deleteDocuments(mine);
  }, { playerId, names: [PARTY, AYLA, BRAM], before: { ...before, messages: beforeMessages } });
  await pl.browser.close().catch(() => {});
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
console.log(`${results.length - failed}/${results.length} passed; screenshots in ${shotsDir}`);
process.exit(failed ? 1 : 0);
