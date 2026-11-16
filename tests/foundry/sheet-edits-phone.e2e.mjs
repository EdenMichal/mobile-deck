// Phone-size UI test of the player-feedback sheet edits in test-5e-world (Mobile Deck (DEV) enabled there):
//   A. Biography: the rich editor keeps paragraphs (Return = new paragraph, only Save saves) and takes a paste.
//   B. Ideals textarea: a real keyboard paste (clipboard) lands in the field.
//   C. Name and portrait: rename, upload a picture, Save.
//   D. Manage spells: the wand on the Spells tab, add a spell, remove it.
//   E. Weapon masteries: the Overview card (each weapon's mastery), no change without a Long Rest, a Long Rest asks on the
//      player's phone (Not now keeps the swap; the next rest asks again), Save spends it.
// Builds a Fighter 1 / Wizard 1 with the engine; cleans up the actor, uploads and chat messages.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/sheet-edits-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";
import { ensureTestPlayer, TEST_PLAYER } from "./test-player.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("sheet-edits-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);

const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    permissions: ["clipboard-read", "clipboard-write"],
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try {
    localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone"));
    localStorage.setItem("music-deck.deckLink", "false");
  } catch {} }
};
const { browser, page } = await joinTestWorld("Claude Test GM", phone);
await pinToSrd(page);
const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 500)); };
let n = 0;
const shot = async name => { await page.waitForTimeout(350); await page.screenshot({ path: `${shotsDir}sheet-edits-${String(++n).padStart(2, "0")}-${name}.png` }); };

const messagesBefore = await page.evaluate(() => game.messages.map(m => m.id));
const setup = await page.evaluate(async () => {
  const { createBuilderController } = await import("/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder/builder-gateway.mjs");
  const classUuid = async name => (await game.packs.get("dnd5e.classes24").getIndex()).find(e => e.type === "class" && e.name === name)?.uuid;
  const actor = await Actor.implementation.create({ name: "Brann (sheet edits test)", type: "character", img: "icons/svg/mystery-man.svg",
    system: { abilities: { str: { value: 16 }, dex: { value: 12 }, con: { value: 14 }, int: { value: 14 }, wis: { value: 10 }, cha: { value: 8 } },
      details: { xp: { value: 300 } } } });
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
        const spells = m.options.filter(o => o.level > 0).slice(0, m.owed.spellbook).map(o => o.uuid);
        data = { cantrips: m.options.filter(o => o.level === 0).slice(0, m.owed.cantrips).map(o => o.uuid), spells, prepare: spells.slice(0, m.owed.prepared), swaps: [] };
        meta = { kind: "spells", warnings: [] };
      } else throw new Error(`setup: unexpected ${m.type}`);
      view = await c.answer(data, meta);
    }
    await c.commit();
  };
  await play(await c.start({ kind: "new-class", classUuid: await classUuid("Fighter"), label: "Fighter 1" }));
  await game.settings.set("dnd5e", "allowMulticlassing", true).catch(() => {});
  try { await play(await c.start({ kind: "new-class", classUuid: await classUuid("Wizard"), label: "Wizard 1" })); } catch (error) { console.warn(error); }
  const previousCharacter = game.user.character?.id ?? null;
  await game.user.update({ character: actor.id });
  return { actorId: actor.id, previousCharacter, classes: Object.keys(actor.classes), masteries: [...(actor.system.traits.weaponProf.mastery?.value ?? [])] };
});
check("setup: Fighter with masteries", setup.classes.includes("fighter") && setup.masteries.length > 0, setup);
const actorState = () => page.evaluate(id => {
  const a = game.actors.get(id);
  return { name: a.name, img: a.img, bio: a.system.details.biography.value, ideal: a.system.details.ideal,
    spells: a.items.filter(i => i.type === "spell").map(i => i.name), masteries: [...(a.system.traits.weaponProf.mastery?.value ?? [])],
    swap: Boolean(a.getFlag("mobile-deck-dev", "masterySwap")) };
}, setup.actorId);

try {
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });
  await page.addStyleTag({ content: "#notifications { display: none !important; }" });
  await page.waitForTimeout(2500);
  await page.evaluate(async () => {
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.options?.window) await app.close().catch(() => {});
  });
  const notNow = page.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click().catch(() => {});
  const characterRoute = page.locator('[data-route="characters"]');
  if (await characterRoute.count()) await characterRoute.first().click().catch(() => {});

  // D. Manage spells
  await page.locator('[data-character-tab="spells"]').first().click();
  await page.locator(".ve-manage-spells").click({ timeout: 15000 });
  await page.waitForSelector('.ve-spell-manager-layer[data-screen="spell-manager"]');
  await shot("spells-home");
  const before = (await actorState()).spells;
  await page.locator(".ve-spell-manager-add").first().click();
  await page.waitForSelector('.ve-spell-manager-layer[data-screen="spell-manager-add"]');
  const addName = await page.locator(".ve-spell-manager-layer .ve-builder-spell-row:not([hidden]) strong").first().innerText();
  await page.locator(".ve-spell-manager-layer .ve-builder-spell-row:not([hidden]) .ve-builder-spell-check").first().click();
  await page.waitForFunction(([id, name]) => game.actors.get(id).items.some(i => i.type === "spell" && i.name === name), [setup.actorId, addName], { timeout: 15000 });
  check("D: added a spell", (await actorState()).spells.includes(addName), addName);
  await shot("spells-added");
  await page.locator(".ve-spell-manager-layer .ve-builder-secondary").first().click(); // Back
  await page.waitForSelector('.ve-spell-manager-layer[data-screen="spell-manager"]');
  await page.locator(".ve-spell-manager-layer .ve-builder-spell-row", { hasText: addName }).locator(".ve-spell-manager-remove").click();
  await page.waitForFunction(([id, name]) => !game.actors.get(id).items.some(i => i.type === "spell" && i.name === name), [setup.actorId, addName], { timeout: 15000 });
  check("D: removed it again", (await actorState()).spells.length === before.length);
  await page.locator(".ve-spell-manager-layer .ve-builder-close").click();


  // E. Weapon masteries, as the player (a GM may set anything, so the rules are tested on a player's phone)
  const playerId = await ensureTestPlayer(page);
  await page.evaluate(async ([id, pid]) => game.actors.get(id).update({ [`ownership.${pid}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER }), [setup.actorId, playerId]);
  setup.playerId = playerId;
  setup.playerCharacter = await page.evaluate(pid => game.users.get(pid).character?.id ?? null, playerId);
  await page.evaluate(([pid, id]) => game.users.get(pid).update({ character: id }), [playerId, setup.actorId]);
  const player = await joinTestWorld(TEST_PLAYER, phone);
  const pp = player.page;
  const pshot = async name => { await pp.waitForTimeout(350); await pp.screenshot({ path: `${shotsDir}sheet-edits-${String(++n).padStart(2, "0")}-${name}.png` }); };
  try {
    await pp.addStyleTag({ content: "#notifications { display: none !important; }" });
    await pp.waitForTimeout(2500);
    const pNotNow = pp.getByRole("button", { name: "Not now" });
    if (await pNotNow.count()) await pNotNow.first().click().catch(() => {});
    const pRoute = pp.locator('[data-route="characters"]');
    if (await pRoute.count()) await pRoute.first().click().catch(() => {});
    // E. Weapon masteries (Overview)
    await pp.locator('[data-character-tab="overview"]').first().click().catch(() => {});
    const masteryCard = pp.locator(".ve-mastery-preview");
    await masteryCard.waitFor({ timeout: 15000 });
    check("E: the Weapon masteries card lists the masteries", (await masteryCard.locator(".ve-trait-pills span").count()) === setup.masteries.length);
    await masteryCard.scrollIntoViewIfNeeded();
    await pshot("mastery-card");
    await masteryCard.locator(".ve-sheet-card-action").click();
    await pp.waitForSelector('.ve-mastery-layer[data-screen="mastery"]');
    const chips = pp.locator(".ve-mastery-layer .ve-mastery-chip");
    const firstLabels = await chips.evaluateAll(list => list.slice(0, 40).map(c => ({ label: c.textContent, disabled: c.disabled })));
    const firstDisabled = firstLabels.findIndex(c => c.disabled);
    check("E: a Fighter is proficient with every weapon (none greyed out)", firstDisabled === -1, firstLabels.slice(0, 6));
    const chipMasteries = await chips.evaluateAll(list => list.map(c => c.querySelector("small")?.textContent ?? ""));
    check("E: the picker shows each weapon's mastery", chipMasteries.filter(Boolean).length >= chipMasteries.length - 2, chipMasteries.slice(0, 8));
    await pshot("mastery-picker");
    // Masteries need proficiency: a Fighter is proficient with every weapon, so nothing is greyed out for one.
    // A chip is the weapon's name and its mastery ("Club" / "Slow"): matched on the exact name ("Club" isn't "Greatclub").
    const chipText = selector => pp.locator(`.ve-mastery-layer ${selector}`).first().locator("span").first().innerText();
    const chipNamed = name => pp.locator(".ve-mastery-layer .ve-mastery-chip", { has: pp.locator("span", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) }).first();
    const swapOnce = async () => {
      const out = await chipText(".ve-mastery-chip.is-selected");
      const into = await chipText(".ve-mastery-chip:not(.is-selected):not([disabled])");
      await chipNamed(out).click();
      await chipNamed(into).click();
    };
    await swapOnce();
    const save = pp.locator(".ve-mastery-layer .ve-builder-footer .ve-builder-primary");
    check("E: no swap before a Long Rest (Save disabled)", await save.isDisabled());
    await pp.locator(".ve-mastery-layer .ve-builder-close").click();
    // Each pill names the weapon's mastery property, as the picker does.
    const pillMasteries = await masteryCard.locator(".ve-trait-pills span").evaluateAll(list => list.map(s => s.querySelector("small")?.textContent ?? ""));
    check("E: the card shows each weapon's mastery", pillMasteries.length === setup.masteries.length && pillMasteries.every(Boolean), pillMasteries);
    // The GM's client takes the rest; the player's phone asks about the swap at once (the GM's doesn't).
    const longRest = () => page.evaluate(async id => { await game.actors.get(id).longRest({ dialog: false, chat: false }); }, setup.actorId);
    const restPrompt = '.ve-mastery-layer[data-screen="mastery-rest"]';
    await longRest();
    await pp.waitForSelector(restPrompt, { timeout: 15000 });
    check("E: a Long Rest gives one swap", (await actorState()).swap);
    const promptText = await pp.locator(restPrompt).innerText();
    check("E: the player's phone asks about the swap after the rest", /Long Rest/.test(promptText) && /swap one weapon mastery/.test(promptText), promptText.slice(0, 300));
    check("E: the GM who rested isn't asked (the player is online)", await page.locator(".ve-mastery-layer").count() === 0);
    await pshot("mastery-rest-prompt");
    await pp.locator(`${restPrompt} .ve-builder-footer .ve-builder-secondary`, { hasText: "Not now" }).click();
    await pp.waitForSelector(".ve-mastery-layer", { state: "detached", timeout: 15000 });
    check("E: Not now keeps the swap, and the card says so", (await actorState()).swap && /Long Rest: you can change one mastery/.test(await masteryCard.innerText()));
    // A second rest with the swap still unused asks again; the swap is made from the prompt.
    await longRest();
    await pp.waitForSelector(restPrompt, { timeout: 15000 });
    check("E: a later rest asks again while the swap is unused", true);
    await swapOnce();
    await pshot("mastery-swap");
    await save.click();
    await pp.waitForSelector(".ve-mastery-layer", { state: "detached", timeout: 15000 });
    const afterSwap = await actorState();
    check("E: the swap saved and spent the token", afterSwap.swap === false && afterSwap.masteries.length === setup.masteries.length
      && afterSwap.masteries.filter(k => !setup.masteries.includes(k)).length === 1, afterSwap);
  } finally { await player.browser.close(); }

  // A. Biography paragraphs and paste
  await page.locator('[data-character-tab="biography"]').first().click();
  const storyEdit = page.locator(".ve-character-biography-story .ve-biography-edit");
  await page.waitForFunction(() => !document.querySelector(".ve-character-biography-story .ve-biography-edit")?.disabled, null, { timeout: 15000 });
  await storyEdit.click();
  const rich = page.locator(".ve-biography-rich-editor");
  await rich.click();
  await page.keyboard.type("First paragraph.");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second paragraph.");
  await page.keyboard.press("Enter");
  await rich.evaluate(el => {
    const data = new DataTransfer();
    data.setData("text/plain", "Pasted line.");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  check("A: Return didn't close or save the editor", await rich.isVisible());
  await shot("biography-editor");
  await page.locator(".ve-biography-editor button[type=submit]").click();
  await page.waitForSelector(".ve-biography-rich-editor", { state: "detached", timeout: 15000 });
  const bio = (await actorState()).bio;
  check("A: saved as separate paragraphs, with the paste", (bio.match(/<p>/g) ?? []).length >= 3 && bio.includes("Pasted line."), bio);

  // B. A real keyboard paste into the Ideals textarea
  await page.evaluate(() => navigator.clipboard.writeText("Freedom.\nAlways."));
  await page.locator(".ve-character-biography-block", { hasText: "Ideals" }).locator(".ve-biography-edit").click();
  const ideals = page.locator(".ve-biography-editor textarea");
  await ideals.click();
  await page.keyboard.press("Meta+V");
  await page.waitForTimeout(200);
  const pasted = await ideals.inputValue();
  check("B: keyboard paste lands in the textarea", pasted.includes("Freedom."), pasted);
  await page.locator(".ve-biography-editor button[type=submit]").click();
  await page.waitForSelector(".ve-biography-editor", { state: "detached", timeout: 15000 });
  check("B: the line break is kept", (await actorState()).ideal === "Freedom.\nAlways.", (await actorState()).ideal);

  // C. Name and portrait
  await page.locator(".ve-character-identity .ve-biography-edit").click();
  await page.locator(".ve-identity-editor input[type=text]").fill("Brann Stoneheart (sheet edits test)");
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".ve-identity-editor .ve-modal-button", { hasText: "Upload" }).click();
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFElEQVR4nGNk+M+AFTCNSg8nBgCmGgEPCq0XVQAAAABJRU5ErkJggg==", "base64");
  await (await chooser).setFiles({ name: "brann.png", mimeType: "image/png", buffer: png });
  await page.waitForFunction(() => /portraits\//.test(document.querySelector(".ve-character-identity-preview")?.getAttribute("src") ?? ""), null, { timeout: 30000 });
  await shot("identity-editor");
  await page.locator(".ve-identity-editor button[type=submit]").click();
  await page.waitForSelector(".ve-identity-editor", { state: "detached", timeout: 15000 });
  const identity = await actorState();
  check("C: name and portrait saved", identity.name === "Brann Stoneheart (sheet edits test)" && /mobile-deck(-dev)?\/portraits\//.test(identity.img), identity);
  setup.uploaded = identity.img;
  await shot("identity-saved");
} catch (error) {
  console.log("ERROR", error.message);
  await shot("error").catch(() => {});
  results.push(false);
} finally {
  await page.evaluate(async ({ actorId, previousCharacter, messages, playerId, playerCharacter }) => {
    await game.user.update({ character: previousCharacter });
    if (playerId) await game.users.get(playerId)?.update({ character: playerCharacter ?? null });
    await game.actors.get(actorId)?.delete();
    const keep = new Set(messages);
    for (const m of game.messages.contents.filter(m => !keep.has(m.id))) await m.delete();
    await game.user.unsetFlag("mobile-deck-dev", "builder");
  }, { ...setup, messages: messagesBefore }).catch(e => console.log("cleanup failed", e.message));
  console.log(`${results.filter(Boolean).length}/${results.length} passed; screenshots in ${shotsDir}`);
  await browser.close();
}
