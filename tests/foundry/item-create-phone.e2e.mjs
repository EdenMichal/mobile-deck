// Phone-size UI test of player item creation (spec 2026-11-13 §2) in test-5e-world (Mobile Deck (DEV) enabled there).
// Claude Test GM (desktop, headless) makes two characters: one Claude Test Player owns and is assigned, one the player
// only observes. Claude Test Player on a phone (VE's UI):
//   A. Capabilities on the player's own client: Create item for the owned character, not for the observed one.
//   B. Inventory tab → the "+" (Create item) in the INVENTORY heading row, before sort and expand-all → six type tiles → Weapon → fill the form (a preset picture). Mid-form the GM changes
//      the actor's HP (the pane re-renders): the typed values survive. Return in Name doesn't create. Create: the
//      weapon is on the actor with the form's values, the picked picture and dnd5e's attack activity; the GMs got one
//      whispered note.
//   C. Loot with no name: the form says why and nothing is created. Back with typed values asks "Discard this item?":
//      Keep editing stays, Discard returns to the types; Back again closes.
//   D. Equipment: light armor without AC is refused; medium armor AC 14 → Dex cap 2. Container: 30 capacity, always one.
//   E. Tool with a base tool (Smith's Tools): type.baseItem and ability set, and the actor's Smith's Tools proficiency
//      applies. Consumable with no uses: one use per item with a Utility activity; using it spends one from the stack.
//   F. Delete from the item menu (keyboard ContextMenu opens the same menu as a long press): Delete is last and red;
//      not offered for a feature or on the observed character. Cancel and Back leave the item. A single item, a stack of
//      20, and a container holding a gem and a pouch with a pearl inside (3 items, all deleted with it); a toast each time.
// Screenshots go to tests/foundry/screens/item-create-*.png. Cleans up only what it made: the two actors, the
// "created" chat notes, the player's assigned character.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/item-create-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { ensureTestPlayer, TEST_PLAYER } from "./test-player.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("item-create-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);
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
const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${shotsDir}item-create-${String(++n).padStart(2, "0")}-${name}.png` }); };
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
const sheet = ".ve-item-create";
const layer = ".ve-item-create-layer";
/** The player's copy of the owned actor's item by name, as plain data. */
const itemOnActor = (page, actorId, name) => page.evaluate(({ actorId, name }) => {
  const item = game.actors.get(actorId)?.items.getName(name);
  return item ? { ...item.toObject(), activityTypes: [...(item.system.activities ?? [])].map(a => a.type) } : null;
}, { actorId, name });
/** Open the creator from the inventory card and pick a type. */
const openType = async (page, type) => {
  await page.locator(".ve-item-create-open").click();
  await page.waitForSelector(`${sheet}[data-step="type"]`);
  await page.locator(`${sheet} [data-item-type="${type}"]`).click();
  await page.waitForSelector(`${sheet}[data-step="form"][data-item-type="${type}"]`);
};
const submitAndWait = async page => {
  await page.locator(`${sheet} .ve-item-create-submit`).click();
  await page.waitForSelector(layer, { state: "detached", timeout: 20000 });
};

const gm = await joinTestWorld("Claude Test GM", desktop);
const playerId = await ensureTestPlayer(gm.page);
const setup = await gm.page.evaluate(async ({ playerId }) => {
  const previousCharacter = game.users.get(playerId).character?.id ?? null;
  const owned = await Actor.implementation.create({ name: "IC Item Create (test)", type: "character",
    ownership: { default: 0, [playerId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER } });
  const observed = await Actor.implementation.create({ name: "IC Observed (test)", type: "character",
    ownership: { default: 0, [playerId]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER } });
  await game.users.get(playerId).update({ character: owned.id });
  // Proficiency in Smith's Tools, for E's base-tool check.
  await owned.update({ "system.tools.smith": { value: 1, ability: "str" }, "system.attributes.hp.value": 8, "system.attributes.hp.max": 10 });
  return { ownedId: owned.id, observedId: observed.id, previousCharacter, gmIds: game.users.filter(u => u.isGM).map(u => u.id),
    messages: game.messages.map(m => m.id) };
}, { playerId });
await settle(gm.page);
const pl = await joinTestWorld(TEST_PLAYER, phone);
await settle(pl.page);

try {
  // ---- A. Capabilities, read on the player's own client
  const caps = await pl.page.evaluate(async ({ moduleId, ownedId, observedId }) => {
    const { dnd5eActorActions } = await import(`/modules/${moduleId}/src/foundry/systems/dnd5e/actor-actions.mjs`);
    return { owned: dnd5eActorActions.capabilitiesForActor(game.actors.get(ownedId), game.user).createItem,
      observed: dnd5eActorActions.capabilitiesForActor(game.actors.get(observedId), game.user).createItem };
  }, { moduleId, ...setup });
  check("an owned character may create items", caps.owned === true, caps);
  check("an observed character may not", caps.observed === false, caps);

  // ---- B. Weapon through the phone UI
  const characterRoute = pl.page.locator('.ve-nav-routes [data-route="characters"]');
  if (await characterRoute.count()) await characterRoute.first().click();
  await pl.page.locator('[data-character-tab="inventory"]').click();
  const open = pl.page.locator(".ve-item-create-open");
  await open.waitFor({ timeout: 30000 });
  check("Create item button on the owned character's inventory", await open.isVisible());
  const placement = await open.evaluate(button => {
    const controls = button.parentElement;
    return { inControls: controls?.classList.contains("ve-collection-controls") ?? false, first: controls?.firstElementChild === button,
      count: controls?.children.length ?? 0, inHeading: Boolean(button.closest(".ve-sheet-card-heading")),
      heading: button.closest(".ve-sheet-card-heading")?.querySelector("h3")?.textContent ?? "",
      label: button.getAttribute("aria-label"), text: button.textContent.trim() };
  });
  check("+ sits in the INVENTORY heading row, first of + / sort / expand-all", placement.inControls && placement.first && placement.count === 3
    && placement.inHeading && /inventory/i.test(placement.heading), placement);
  check("+ is an icon button named Create item", placement.label === "Create item" && placement.text === "", placement);
  const [plusBox, sortBox] = [await open.boundingBox(), await open.locator("xpath=following-sibling::button[1]").boundingBox()];
  check("+ is the same square as the sort button", plusBox && sortBox && Math.abs(plusBox.width - sortBox.width) < 1
    && Math.abs(plusBox.height - sortBox.height) < 1 && Math.abs(plusBox.y - sortBox.y) < 1, { plusBox, sortBox });
  check("the old full-width Create item row is gone", await pl.page.locator(".ve-sheet-collection .ve-item-create-open").count() === 1);
  await shot(pl.page, "inventory");

  await open.click();
  await pl.page.waitForSelector(`${sheet}[data-step="type"]`);
  const types = await pl.page.$$eval(`${sheet} [data-item-type]`, tiles => tiles.map(t => t.dataset.itemType));
  check("six type tiles in order", JSON.stringify(types) === JSON.stringify(["weapon", "equipment", "consumable", "tool", "loot", "container"]), types);
  await shot(pl.page, "types");

  await pl.page.locator(`${sheet} [data-item-type="weapon"]`).click();
  await pl.page.waitForSelector(`${sheet}[data-step="form"][data-item-type="weapon"]`);
  await pl.page.fill(`${sheet} input[name=name]`, "IC Moon blade");
  // The GM changes HP while the player types: VE re-renders the pane, the sheet and its values stay.
  await gm.page.evaluate(id => game.actors.get(id).update({ "system.attributes.hp.value": 6 }), setup.ownedId);
  await pl.page.waitForFunction(id => game.actors.get(id).system.attributes.hp.value === 6, setup.ownedId);
  await pl.page.waitForTimeout(600);
  check("the half-filled form survives an actor update", await pl.page.inputValue(`${sheet} input[name=name]`).catch(() => "") === "IC Moon blade");
  const itemsBeforeEnter = await pl.page.evaluate(id => game.actors.get(id).items.size, setup.ownedId);
  await pl.page.focus(`${sheet} input[name=name]`);
  await pl.page.keyboard.press("Enter");
  await pl.page.waitForTimeout(600);
  check("Return in Name moves on instead of creating", await pl.page.locator(layer).count() === 1
    && await pl.page.evaluate(id => game.actors.get(id).items.size, setup.ownedId) === itemsBeforeEnter);
  await pl.page.locator(`${sheet} .ve-item-create-picture`).click();
  const pictures = await pl.page.locator(`${sheet} .ve-item-create-picture-choice`).count();
  check("a grid of preset pictures (12+)", pictures >= 12, pictures);
  await shot(pl.page, "pictures");
  await pl.page.locator(`${sheet} .ve-item-create-picture-choice[data-img="icons/weapons/swords/scimitar-blue.webp"]`).click();
  await pl.page.fill(`${sheet} input[name=weight]`, "3");
  await pl.page.fill(`${sheet} input[name=priceValue]`, "25");
  await pl.page.locator(`${sheet} .ve-item-create-coin[data-denomination="sp"]`).click();
  await pl.page.selectOption(`${sheet} select[name=category]`, "martialM");
  await pl.page.fill(`${sheet} input[name=damageNumber]`, "1");
  await pl.page.selectOption(`${sheet} select[name=damageDie]`, "8");
  await pl.page.selectOption(`${sheet} select[name=damageType]`, "slashing");
  await pl.page.locator(`${sheet} [data-property="fin"]`).click();
  await pl.page.fill(`${sheet} textarea[name=description]`, "Curved.\nGlows under the moon.");
  await shot(pl.page, "weapon-form");
  await submitAndWait(pl.page);

  const weapon = await itemOnActor(pl.page, setup.ownedId, "IC Moon blade");
  check("weapon created on the actor", weapon?.type === "weapon", weapon?.type);
  check("weapon category", weapon?.system?.type?.value === "martialM", weapon?.system?.type);
  check("weapon damage 1d8 slashing", weapon?.system?.damage?.base?.number === 1 && weapon.system.damage.base.denomination === 8
    && weapon.system.damage.base.types?.includes("slashing"), weapon?.system?.damage?.base);
  check("weapon properties", weapon?.system?.properties?.includes("fin"), weapon?.system?.properties);
  check("weapon price 25 sp, weight 3", weapon?.system?.price?.value === 25 && weapon.system.price.denomination === "sp"
    && weapon.system.weight?.value === 3, { price: weapon?.system?.price, weight: weapon?.system?.weight });
  check("description paragraphs", weapon?.system?.description?.value === "<p>Curved.<br>Glows under the moon.</p>", weapon?.system?.description);
  check("the picked preset picture", weapon?.img === "icons/weapons/swords/scimitar-blue.webp", weapon?.img);
  check("dnd5e added its attack activity", weapon?.activityTypes?.includes("attack"), weapon?.activityTypes);
  await pl.page.waitForFunction(name => document.querySelector(".ve-sheet-collection-body")?.textContent.includes(name), "IC Moon blade", { timeout: 15000 });
  check("the new weapon shows in the inventory", true);
  await shot(pl.page, "weapon-created");

  await gm.page.waitForFunction(() => game.messages.contents.some(m => m.content?.includes("ve-item-created-note") && m.content.includes("IC Moon blade")), null, { timeout: 15000 });
  const note = await gm.page.evaluate(({ playerId }) => {
    const m = game.messages.contents.findLast(m => m.content?.includes("ve-item-created-note") && m.content.includes("IC Moon blade"));
    return { text: m?.content?.replace(/<[^>]+>/g, ""), whisper: m?.whisper ?? [], author: m?.author?.id ?? null, playerId };
  }, { playerId });
  check("GM note says who made what", note.text === `${TEST_PLAYER} created IC Moon blade (Weapon) on IC Item Create (test).`, note.text);
  check("the note is whispered to the GMs only", note.whisper.length === setup.gmIds.length && setup.gmIds.every(id => note.whisper.includes(id)), note.whisper);
  check("the note's author is the player", note.author === playerId, note);

  // ---- C. Validation and Back
  const countBefore = await pl.page.evaluate(id => game.actors.get(id).items.size, setup.ownedId);
  await openType(pl.page, "loot");
  await pl.page.locator(`${sheet} .ve-item-create-submit`).click();
  const nameError = await pl.page.locator(`${sheet} [data-field="name"] .ve-item-create-error`).textContent();
  check("an empty name is refused with a reason", nameError === "Give the item a name.", nameError);
  check("…and nothing is created", await pl.page.evaluate(id => game.actors.get(id).items.size, setup.ownedId) === countBefore);
  await shot(pl.page, "loot-error");
  await pl.page.fill(`${sheet} input[name=name]`, "x");
  check("the error clears when the name is edited", (await pl.page.locator(`${sheet} [data-field="name"] .ve-item-create-error`).textContent()) === "");
  await pl.page.locator(layer).evaluate(el => el.dispatchEvent(new Event("ve-close")));
  await pl.page.waitForSelector(".ve-item-create-confirm");
  check("Back with typed values asks first", await pl.page.locator(".ve-item-create-confirm h3").textContent() === "Discard this item?");
  await shot(pl.page, "discard");
  await pl.page.locator(".ve-item-create-confirm .is-secondary").click();
  check("Keep editing keeps the form", await pl.page.inputValue(`${sheet} input[name=name]`) === "x");
  await pl.page.locator(layer).evaluate(el => el.dispatchEvent(new Event("ve-close")));
  await pl.page.locator(".ve-item-create-confirm .ve-item-create-discard-confirm").click();
  check("Discard returns to the types", await pl.page.locator(`${sheet}[data-step="type"]`).count() === 1);
  await pl.page.locator(layer).evaluate(el => el.dispatchEvent(new Event("ve-close")));
  await pl.page.waitForSelector(layer, { state: "detached" });
  check("Back from the types closes the sheet", true);

  // ---- D. Equipment and Container
  await openType(pl.page, "equipment");
  await pl.page.fill(`${sheet} input[name=name]`, "IC Scale mail");
  check("no Armor Class field before an armor type is picked", await pl.page.locator(`${sheet} [data-field="armorValue"]`).isHidden());
  await pl.page.selectOption(`${sheet} select[name=category]`, "light");
  await pl.page.locator(`${sheet} .ve-item-create-submit`).click();
  check("armor without an Armor Class is refused", (await pl.page.locator(`${sheet} [data-field="armorValue"] .ve-item-create-error`).textContent()).startsWith("Enter the Armor Class"));
  await pl.page.selectOption(`${sheet} select[name=category]`, "medium");
  await pl.page.fill(`${sheet} input[name=armorValue]`, "14");
  await shot(pl.page, "equipment-form");
  await submitAndWait(pl.page);
  const armor = await itemOnActor(pl.page, setup.ownedId, "IC Scale mail");
  check("medium armor: AC 14, Dex cap 2", armor?.type === "equipment" && armor.system.type?.value === "medium"
    && armor.system.armor?.value === 14 && armor.system.armor?.dex === 2, armor?.system?.armor);

  await openType(pl.page, "container");
  check("a container has no quantity field", await pl.page.locator(`${sheet} [data-field="quantity"]`).count() === 0);
  await pl.page.fill(`${sheet} input[name=name]`, "IC Backpack");
  await pl.page.fill(`${sheet} input[name=capacity]`, "30");
  await submitAndWait(pl.page);
  const pack = await itemOnActor(pl.page, setup.ownedId, "IC Backpack");
  check("a second created item shows in the list too (an expanded row doesn't freeze it)", await pl.page.waitForFunction(name => document.querySelector(".ve-sheet-collection-body")?.textContent.includes(name), "IC Backpack", { timeout: 10000 }).then(() => true, () => false));
  check("container: capacity 30, one of it", pack?.type === "container" && pack.system.capacity?.weight?.value === 30 && pack.system.quantity === 1, pack?.system);

  // ---- E. Tool with a base tool; a single-use consumable that can be used
  await openType(pl.page, "tool");
  await pl.page.fill(`${sheet} input[name=name]`, "IC Grandad's hammers");
  await pl.page.selectOption(`${sheet} select[name=category]`, "art");
  await pl.page.selectOption(`${sheet} select[name=baseTool]`, "smith");
  await shot(pl.page, "tool-form");
  await submitAndWait(pl.page);
  const tool = await pl.page.evaluate(({ actorId }) => {
    const item = game.actors.get(actorId)?.items.getName("IC Grandad's hammers");
    return item && { type: item.system.type.toObject?.() ?? item.toObject().system.type, ability: item.system.ability, proficiency: item.system.proficiencyMultiplier };
  }, { actorId: setup.ownedId });
  check("tool: base tool and its ability", tool?.type?.baseItem === "smith" && tool.ability === "str", tool);
  check("tool: the actor's Smith's Tools proficiency applies", tool?.proficiency === 1, tool);

  await openType(pl.page, "consumable");
  await pl.page.fill(`${sheet} input[name=name]`, "IC Tonic");
  await pl.page.fill(`${sheet} input[name=quantity]`, "2");
  await pl.page.selectOption(`${sheet} select[name=category]`, "potion");
  await submitAndWait(pl.page);
  const tonic = await itemOnActor(pl.page, setup.ownedId, "IC Tonic");
  check("consumable: one use per item, spent from the stack", tonic?.system?.uses?.max === "1" && tonic.system.uses.autoDestroy === true, tonic?.system?.uses);
  check("consumable: a Utility activity that spends the item's uses", tonic?.activityTypes?.join() === "utility"
    && Object.values(tonic.system.activities ?? {})[0]?.consumption?.targets?.[0]?.type === "itemUses", tonic?.system?.activities);
  const afterUse = await pl.page.evaluate(async ({ actorId }) => {
    const item = game.actors.get(actorId).items.getName("IC Tonic");
    await item.system.activities.contents[0].use({}, { configure: false }, { create: false });
    return game.actors.get(actorId).items.getName("IC Tonic")?.system.quantity ?? 0;
  }, { actorId: setup.ownedId });
  check("using it spends one from the stack (2 → 1)", afterUse === 1, afterUse);
  await shot(pl.page, "after");

  // ---- F. Delete from the item menu
  const ids = await gm.page.evaluate(async ({ ownedId, observedId }) => {
    const actor = game.actors.get(ownedId);
    const [satchel] = await actor.createEmbeddedDocuments("Item", [{ name: "IC Satchel", type: "container" }]);
    const [pouch] = await actor.createEmbeddedDocuments("Item", [{ name: "IC Pouch", type: "container", system: { container: satchel.id } }]);
    await actor.createEmbeddedDocuments("Item", [
      { name: "IC Gem", type: "loot", system: { container: satchel.id } },
      { name: "IC Pearl", type: "loot", system: { container: pouch.id } },
      { name: "IC Rope", type: "loot" },
      { name: "IC Arrows", type: "consumable", system: { quantity: 20, type: { value: "ammo" } } },
      { name: "IC Keepsake", type: "loot" },
      { name: "IC Second Wind", type: "feat" }
    ]);
    const [watched] = await game.actors.get(observedId).createEmbeddedDocuments("Item", [{ name: "IC Watched Rope", type: "loot" }]);
    return { feat: actor.items.getName("IC Second Wind").id, watched: watched.id };
  }, setup);
  await pl.page.waitForFunction(name => document.querySelector(".ve-sheet-collection-body")?.textContent.includes(name), "IC Keepsake", { timeout: 15000 });
  const records = await pl.page.evaluate(async ({ moduleId, ownedId, observedId, feat, watched }) => {
    const { dnd5eActorActions } = await import(`/modules/${moduleId}/src/foundry/systems/dnd5e/actor-actions.mjs`);
    const read = (actorId, itemId) => dnd5eActorActions.readItemMenu(game.actors.get(actorId), { itemId }, game.user).item;
    // An observer gets no item menu at all (the gateway refuses it before the record is built).
    let watchedMenu;
    try { watchedMenu = read(observedId, watched).canDelete; } catch (error) { watchedMenu = `refused: ${error.message}`; }
    return { feat: read(ownedId, feat).canDelete, watched: watchedMenu,
      satchel: read(ownedId, game.actors.get(ownedId).items.getName("IC Satchel").id) };
  }, { moduleId, ...setup, ...ids });
  check("Delete is not offered for a feature", records.feat === false, records);
  check("Delete is not offered on the observed character", records.watched === false || String(records.watched).startsWith("refused"), records);
  check("the Satchel's record counts 3 items inside (sub-container included)", records.satchel.canDelete === true && records.satchel.contentsCount === 3, records.satchel);

  const exists = name => pl.page.evaluate(({ id, name }) => Boolean(game.actors.get(id).items.getName(name)), { id: setup.ownedId, name });
  const confirmCard = ".ve-item-delete-confirm";
  const deleteLayer = ".ve-item-delete-layer";
  /** Open the item menu on an inventory row and tap Delete. */
  const tapDelete = async (name, { screenshot = "" } = {}) => {
    await pl.page.evaluate(() => document.querySelectorAll("details.ve-sheet-collection-section, details.ve-sheet-container").forEach(d => { d.open = true; }));
    const row = pl.page.locator(".ve-sheet-collection-body summary", { hasText: name }).first();
    await row.waitFor();
    await row.focus();
    await pl.page.keyboard.press("ContextMenu");
    await pl.page.waitForSelector(".ve-character-item-menu");
    if (screenshot) await shot(pl.page, screenshot);
    await pl.page.locator(".ve-character-item-menu button", { hasText: "Delete" }).click();
    await pl.page.waitForSelector(confirmCard);
  };

  // The menu: Delete last, red.
  await pl.page.evaluate(() => document.querySelectorAll("details.ve-sheet-collection-section").forEach(d => { d.open = true; }));
  const keepsakeRow = pl.page.locator(".ve-sheet-collection-body summary", { hasText: "IC Keepsake" }).first();
  await keepsakeRow.focus();
  await pl.page.keyboard.press("ContextMenu");
  await pl.page.waitForSelector(".ve-character-item-menu");
  const menu = await pl.page.$$eval(".ve-character-item-menu button", buttons => buttons.map(b => ({ text: b.textContent.trim(), destructive: b.classList.contains("is-destructive") })));
  check("Delete is the menu's last entry, and the only destructive one", menu.at(-1)?.text === "Delete" && menu.at(-1).destructive && menu.filter(b => b.destructive).length === 1, menu);
  await shot(pl.page, "delete-menu");
  // VE's back path, not a real Escape (Foundry opens its main menu on Escape).
  await pl.page.locator(".ve-character-item-menu").evaluate(el => el.dispatchEvent(new Event("ve-close")));
  await pl.page.waitForSelector(".ve-character-item-menu", { state: "detached" });

  // Cancel, and Back, leave the item.
  await tapDelete("IC Keepsake");
  check("the confirm names the item", await pl.page.locator(`${confirmCard} h3`).textContent() === "Delete IC Keepsake?");
  check("Cancel has focus, so Return never deletes", await pl.page.evaluate(() => document.activeElement?.classList.contains("ve-item-delete-cancel")));
  await shot(pl.page, "delete-confirm");
  await pl.page.locator(`${confirmCard} .ve-item-delete-cancel`).click();
  await pl.page.waitForSelector(deleteLayer, { state: "detached" });
  check("Cancel leaves the item", await exists("IC Keepsake"));
  await tapDelete("IC Keepsake");
  await pl.page.locator(deleteLayer).evaluate(el => el.dispatchEvent(new Event("ve-close")));
  await pl.page.waitForSelector(deleteLayer, { state: "detached" });
  check("Back leaves the item", await exists("IC Keepsake"));

  const toast = text => pl.page.waitForFunction(text => [...document.querySelectorAll("#notifications .notification")].some(n => n.textContent.includes(text)), text, { timeout: 15000 })
    .then(() => true, () => false);
  const confirmAndWait = async name => {
    await pl.page.locator(`${confirmCard} .ve-item-delete-confirm-button`).click();
    await pl.page.waitForFunction(({ id, name }) => !game.actors.get(id).items.getName(name), { id: setup.ownedId, name }, { timeout: 15000 });
    await pl.page.waitForSelector(deleteLayer, { state: "detached" });
    // The list re-renders even with another row expanded (the created weapon is still open).
    const gone = await pl.page.waitForFunction(name => ![...document.querySelectorAll(".ve-sheet-collection-body summary")].some(row => row.textContent.includes(name)), name, { timeout: 10000 })
      .then(() => true, () => false);
    check(`${name}'s row leaves the inventory list`, gone);
  };

  // A single item.
  await tapDelete("IC Rope");
  check("single item: says it can't be undone", (await pl.page.locator(`${confirmCard} p`).textContent()) === "It's removed from your inventory. This can't be undone.");
  await confirmAndWait("IC Rope");
  check("single item deleted, with a toast", await toast("IC Rope deleted."));

  // A stack.
  await tapDelete("IC Arrows");
  check("stack: says all 20 go", (await pl.page.locator(`${confirmCard} p`).textContent()) === "All 20 are removed from your inventory. This can't be undone.");
  await confirmAndWait("IC Arrows");
  check("the whole stack of 20 deleted, with a toast", await toast("IC Arrows deleted."));

  // A container with contents, a sub-container included.
  await tapDelete("IC Satchel");
  check("container: says the 3 items inside go too", (await pl.page.locator(`${confirmCard} p`).textContent()) === "The 3 items inside are deleted with it. This can't be undone.");
  await shot(pl.page, "delete-container");
  await confirmAndWait("IC Satchel");
  await pl.page.waitForFunction(id => !["IC Gem", "IC Pouch", "IC Pearl"].some(name => game.actors.get(id).items.getName(name)), setup.ownedId, { timeout: 15000 })
    .catch(() => {});
  const leftovers = await pl.page.evaluate(id => ["IC Gem", "IC Pouch", "IC Pearl"].filter(name => game.actors.get(id).items.getName(name)), setup.ownedId);
  check("the container's contents are deleted with it", leftovers.length === 0, leftovers);
  check("container toast counts what went with it", await toast("IC Satchel and the 3 items inside were deleted."));
  check("the Keepsake and the feature are untouched", await exists("IC Keepsake") && await exists("IC Second Wind"));
  await shot(pl.page, "after-delete");
} catch (error) {
  console.log("ERROR", error.message);
  await shot(pl.page, "error").catch(() => {});
  results.push(false);
} finally {
  await gm.page.evaluate(async ({ ownedId, observedId, previousCharacter, messages, playerId }) => {
    await game.users.get(playerId).update({ character: previousCharacter });
    for (const id of [ownedId, observedId]) await game.actors.get(id)?.delete();
    const keep = new Set(messages);
    for (const m of game.messages.contents.filter(m => !keep.has(m.id) && m.content?.includes("ve-item-created-note"))) await m.delete();
  }, { ...setup, playerId }).catch(e => console.log("cleanup failed", e.message));
  console.log(`${results.filter(Boolean).length}/${results.length} passed; screenshots in ${shotsDir}`);
  await pl.browser.close();
  await gm.browser.close();
}
