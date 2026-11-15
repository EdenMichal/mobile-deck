// Phone-size UI test of My Journals (player journals) in test-5e-world (Mobile Deck (DEV) enabled there).
// Claude Test GM (desktop) makes two characters owned by Claude Test Player ("PJ Test Wren", "PJ Test Oak") and a second,
// temporary player ("PJ Test Other") with a character of their own. The GM's client must then make
// Player Journals → Claude Test Player → Wren / Oak (and the other player's folders) by itself.
// Claude Test Player on a phone: Journals tab → My Journals → Wren, then
//   new folder "Quests"; new journal "Session notes" (opens with one empty page); write in that page and see it saved
//   on the GM's side; add a picture page from the phone (uploaded through the GM's client); move the picture page up;
//   rename the journal; move it into Quests; move Quests to Oak; delete the journal; delete the folder.
// Privacy: journals are Owner for the player only; the other player's journal is hidden from this player and the server
// refuses their edits; a forged request for the other player's folder is refused by the GM's client; the Library doesn't
// list the player's own notes. (Foundry sends every journal to every browser: permissions decide what it shows and who
// may change it, so a player with the browser console can read any journal. That's Foundry's model, not this module's.)
// No GM online: writing a page still works; a new folder says a GM is needed.
// Screenshots go to tests/foundry/screens/journals-*.png.
// Cleans up the actors, the temporary player, and the test folders and journals (uploaded pictures stay in the
// test world's mobile-deck/player-journals folder: Foundry has no API to delete files).
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/player-journals-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { ensureTestPlayer, TEST_PLAYER } from "./test-player.mjs";
import { joinTestWorld } from "./join.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("journals-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);
const picture = fs.readFileSync(fileURLToPath(new URL("../../assets/app-192.png", import.meta.url)));
const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try { localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone")); localStorage.setItem("music-deck.deckLink", "false"); } catch {} }
};
const desktop = { context: { viewport: { width: 1280, height: 900 } },
  initScript: () => { try { localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("desktop")); localStorage.setItem("music-deck.deckLink", "false"); } catch {} } };
const moduleId = "mobile-deck-dev";
const WREN = "PJ Test Wren";
const OAK = "PJ Test Oak";
const OTHER_USER = "PJ Test Other";
const OTHER_PC = "PJ Test Other PC";

const results = [];
const check = (label, ok, info) => { results.push(ok); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 400)); };
let n = 0;
const shot = async (page, name) => { await page.waitForTimeout(400); await page.screenshot({ path: `${shotsDir}journals-${String(++n).padStart(2, "0")}-${name}.png` }); };
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
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });
// Our folders, read on any page: { role, userId, actorId, name, parentId, id }.
const ourFolders = page => page.evaluate(moduleId => game.folders.filter(f => f.type === "JournalEntry" && f.flags?.[moduleId]?.playerJournal)
  .map(f => ({ id: f.id, name: f.name, parentId: f.folder?.id ?? "", ...f.flags[moduleId].playerJournal })), moduleId);

let gm = await joinTestWorld("Claude Test GM", desktop);
const playerId = await ensureTestPlayer(gm.page);

// ---- Setup on the GM page
const setup = await gm.page.evaluate(async ({ playerId, WREN, OAK, OTHER_USER, OTHER_PC }) => {
  for (const name of [WREN, OAK, OTHER_PC]) for (const a of game.actors.filter(x => x.name === name)) await a.delete();
  for (const u of game.users.filter(x => x.name === OTHER_USER)) await u.delete();
  const other = await User.implementation.create({ name: OTHER_USER, role: CONST.USER_ROLES.PLAYER, password: "" });
  const owner = id => ({ default: 0, [id]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
  const wren = await Actor.implementation.create({ name: WREN, type: "character", ownership: owner(playerId) });
  const oak = await Actor.implementation.create({ name: OAK, type: "character", ownership: owner(playerId) });
  const otherPc = await Actor.implementation.create({ name: OTHER_PC, type: "character", ownership: owner(other.id) });
  return { wrenId: wren.id, oakId: oak.id, otherId: other.id, otherPcId: otherPc.id };
}, { playerId, WREN, OAK, OTHER_USER, OTHER_PC });
check("setup: two characters for the player, a second player with one", Boolean(setup.wrenId && setup.oakId && setup.otherPcId), setup);

let pl = null;
try {
  // ---- Folder upkeep on the GM's client
  await waitFor(gm.page, ({ moduleId, playerId, otherId, ids }) => {
    const mine = f => f.flags?.[moduleId]?.playerJournal;
    const has = (userId, actorId) => game.folders.some(f => mine(f)?.role === "character" && mine(f).userId === userId && mine(f).actorId === actorId);
    return has(playerId, ids.wrenId) && has(playerId, ids.oakId) && has(otherId, ids.otherPcId);
  }, { moduleId, playerId, otherId: setup.otherId, ids: setup });
  let folders = await ourFolders(gm.page);
  const root = folders.filter(f => f.role === "root");
  const userFolder = folders.find(f => f.role === "user" && f.userId === playerId);
  const wrenFolder = folders.find(f => f.role === "character" && f.actorId === setup.wrenId);
  check("upkeep: one Player Journals root", root.length === 1, root);
  check("upkeep: player folder inside the root, named after the player", userFolder?.parentId === root[0]?.id && userFolder?.name === TEST_PLAYER, userFolder);
  check("upkeep: Wren's folder inside the player's folder", wrenFolder?.parentId === userFolder?.id && wrenFolder?.name === WREN, wrenFolder);

  // Renaming a character renames its folder.
  await gm.page.evaluate(({ id, name }) => game.actors.get(id).update({ name: `${name} Renamed` }), { id: setup.oakId, name: OAK });
  await waitFor(gm.page, ({ moduleId, actorId, name }) => game.folders.some(f => f.flags?.[moduleId]?.playerJournal?.actorId === actorId && f.name === name),
    { moduleId, actorId: setup.oakId, name: `${OAK} Renamed` });
  check("upkeep: a renamed character renames its folder", true);
  await gm.page.evaluate(({ id, name }) => game.actors.get(id).update({ name }), { id: setup.oakId, name: OAK });

  // ---- The player on a phone
  pl = await joinTestWorld(TEST_PLAYER, phone);
  await settle(pl.page);
  await settle(gm.page);
  const page = pl.page;
  const layer = page.locator(".ve-pj-layer");
  const screen = name => page.locator(`.ve-pj-layer[data-screen="${name}"]`);
  const row = text => layer.locator(".ve-pj-row", { hasText: text });
  const footerNext = () => layer.locator(".ve-builder-footer .ve-builder-primary");
  const footerBack = () => layer.locator(".ve-builder-footer .ve-builder-secondary");
  const sheet = () => layer.locator(".ve-pj-sheet");
  const menuItem = text => sheet().locator(".ve-pj-menu-item", { hasText: text });
  const promptName = async name => { await sheet().locator(".ve-pj-input").fill(name); await sheet().locator("button[type=submit]").click(); };
  const openMenu = async text => { await row(text).first().locator(".ve-pj-row-menu").click(); await sheet().waitFor(); };
  const title = () => layer.locator("#ve-builder-title").innerText();
  const errorText = () => layer.locator(".ve-builder-error").innerText().catch(() => "");

  await page.locator('[data-route="journals"]').first().click({ timeout: 30000 });
  const mine = page.locator(".ve-journal-mine-entry");
  await mine.first().waitFor({ timeout: 15000 });
  const names = await mine.allInnerTexts();
  check("Journals tab: My Journals lists both characters, not the other player's", names.some(t => t.includes(WREN)) && names.some(t => t.includes(OAK)) && !names.some(t => t.includes(OTHER_PC)), names);
  await shot(page, "tab");
  await mine.filter({ hasText: WREN }).click();
  await layer.waitFor();
  await screen("pj-home").waitFor({ timeout: 10000 });
  check("My Journals opens on Wren's empty home", (await title()) === "My Journals" && /Nothing here yet/.test(await layer.innerText()), await layer.innerText());
  await shot(page, "home-empty");

  // ---- New folder
  await footerNext().click();
  await menuItem("New folder").click();
  await promptName("Quests");
  await row("Quests").waitFor();
  folders = await ourFolders(gm.page);
  const quests = folders.find(f => f.name === "Quests");
  check("New folder: made by the GM's client inside Wren's folder, flagged as the player's", quests?.role === "custom" && quests.parentId === wrenFolder.id && quests.userId === playerId, quests);

  // ---- New journal: opens with one empty page
  await footerNext().click();
  await menuItem("New journal").click();
  await promptName("Session notes");
  await screen("pj-journal").waitFor();
  check("New journal: opens on its page list", (await title()) === "Session notes" && (await layer.locator(".ve-pj-row.is-page").count()) === 1);
  const journal = await gm.page.evaluate(({ name, playerId }) => {
    const j = game.journal.getName(name);
    return j && { id: j.id, folder: j.folder?.id, ownership: j.ownership, pages: j.pages.size };
  }, { name: "Session notes", playerId });
  check("New journal: Owner for the player, None for everyone else, in Wren's folder",
    journal?.ownership?.[playerId] === 3 && journal.ownership.default === 0 && journal.folder === wrenFolder.id && journal.pages === 1, journal);
  await shot(page, "journal");

  // ---- Write in the page
  await row("Notes").locator(".ve-pj-row-open").click();
  const editor = layer.locator(".ve-pj-editor");
  await editor.waitFor();
  await editor.click();
  await page.keyboard.type("The ferryman owes us three gold.");
  await page.keyboard.press("Enter");
  await layer.locator(".ve-pj-tool[aria-label='Bold']").click();
  await page.keyboard.type("Ask about the lighthouse.");
  await waitFor(page, () => document.querySelector(".ve-pj-save-status")?.dataset.state === "saved" && /Saved/.test(document.querySelector(".ve-pj-save-status").textContent));
  await waitFor(gm.page, id => /ferryman/.test(game.journal.get(id)?.pages.contents[0]?.text.content ?? ""), journal.id);
  const content = await gm.page.evaluate(id => game.journal.get(id).pages.contents[0].text.content, journal.id);
  check("Writer: saved on its own, as HTML the GM sees, with bold kept", /ferryman owes us three gold/.test(content) && /<(b|strong)>Ask about the lighthouse/.test(content), content);
  await shot(page, "writer");

  // A change made elsewhere shows up while the page is open (nothing unsaved here, so it just loads).
  await gm.page.evaluate(id => game.journal.get(id).pages.contents[0].update({ "text.content": "<p>GM added a line.</p>" }), journal.id);
  await waitFor(page, () => /GM added a line/.test(document.querySelector(".ve-pj-editor")?.textContent ?? ""));
  check("Writer: a change from another device loads into the open page", true);

  // ---- Picture page
  await footerBack().click();
  await footerNext().click();
  const chooser = page.waitForEvent("filechooser");
  await menuItem("Picture").click();
  await (await chooser).setFiles({ name: "harbour-map.png", mimeType: "image/png", buffer: picture });
  await layer.locator(".ve-pj-picture img").waitFor({ timeout: 30000 });
  const imagePage = await gm.page.evaluate(id => {
    const p = game.journal.get(id).pages.find(x => x.type === "image");
    return p && { id: p.id, src: p.src, name: p.name };
  }, journal.id);
  check("Picture: uploaded through the GM's client into this world's player folder", Boolean(imagePage?.src?.startsWith(`worlds/`) && imagePage.src.includes(`/mobile-deck/player-journals/${playerId}/`) && /\.(webp|jpg)$/.test(imagePage.src)), imagePage);
  const loaded = await layer.locator(".ve-pj-picture img").evaluate(img => img.complete && img.naturalWidth > 0);
  check("Picture: the page shows the uploaded image", loaded);
  await layer.locator(".ve-pj-caption").fill("The old harbour");
  await waitFor(gm.page, ({ id, pageId }) => game.journal.get(id).pages.get(pageId)?.image?.caption === "The old harbour", { id: journal.id, pageId: imagePage.id });
  check("Picture: the caption saves", true);
  await shot(page, "picture");

  // ---- Reorder pages: the picture moves above Notes
  await footerBack().click();
  await openMenu("harbour-map");
  await menuItem("Move up").click();
  await waitFor(page, () => document.querySelector(".ve-pj-row.is-page strong")?.textContent === "harbour-map");
  check("Reorder: Move up puts the picture first", true);

  // ---- Rename, move into Quests, move Quests to Oak
  await footerBack().click();
  await openMenu("Session notes");
  await menuItem("Rename").click();
  await promptName("Session one");
  await row("Session one").waitFor();
  await openMenu("Session one");
  await menuItem("Move to").click();
  await sheet().locator(".ve-pj-menu-item", { hasText: "Quests" }).click();
  await waitFor(gm.page, ({ id, folder }) => game.journal.get(id)?.folder?.id === folder, { id: journal.id, folder: quests.id });
  check("Move: the journal now lives in Quests", true);
  await openMenu("Quests");
  await menuItem("Move to").click();
  await sheet().locator(".ve-pj-menu-item", { hasText: OAK }).click();
  await waitFor(gm.page, ({ id, moduleId, oakId }) => game.folders.get(id)?.flags?.[moduleId]?.playerJournal?.actorId === oakId, { id: quests.id, moduleId, oakId: setup.oakId });
  await row("Quests").waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
  check("Move: Quests (with its journal) moved to Oak", (await row("Quests").count()) === 0);
  await shot(page, "after-moves");

  // ---- Library leaves the player's notes out
  await layer.locator(".ve-builder-close").click();
  await page.waitForTimeout(600);
  const library = await page.locator(".ve-journal-tree").innerText().catch(() => "");
  check("Library: the player's own notes are not listed twice", !/Session one|Quests/.test(library), library);

  // ---- Privacy
  const otherJournalId = await gm.page.evaluate(async ({ moduleId, otherId, otherPcId }) => {
    const folder = game.folders.find(f => f.flags?.[moduleId]?.playerJournal?.actorId === otherPcId);
    const j = await JournalEntry.create({ name: "PJ Test Other secret", folder: folder.id, ownership: { default: 0, [otherId]: 3 } });
    return j.id;
  }, { moduleId, otherId: setup.otherId, otherPcId: setup.otherPcId });
  await page.waitForTimeout(500);
  // Foundry sends every journal to every browser; permissions decide what Foundry shows and who may change it.
  const seen = await page.evaluate(id => ({ visible: game.journal.get(id)?.visible ?? false, owner: game.journal.get(id)?.isOwner ?? false }), otherJournalId);
  check("Privacy: the other player's journal is hidden from this player and not theirs", !seen.visible && !seen.owner, seen);
  const write = await page.evaluate(async id => { try { await game.journal.get(id)?.update({ name: "Snooped" }); return game.journal.get(id)?.name; } catch (error) { return `refused: ${error.message}`; } }, otherJournalId);
  await page.waitForTimeout(500);
  const nameOnGm = await gm.page.evaluate(id => game.journal.get(id)?.name, otherJournalId);
  check("Privacy: the server refuses this player's edit to the other player's journal", nameOnGm === "PJ Test Other secret", { write, nameOnGm });
  const forged = await page.evaluate(async ({ moduleId, otherPcId }) => {
    const folder = game.folders.find(f => f.flags?.[moduleId]?.playerJournal?.actorId === otherPcId);
    return game.users.activeGM.query(`${moduleId}.playerJournal`, { action: "createFolder", parentId: folder.id, name: "Snooping" });
  }, { moduleId, otherPcId: setup.otherPcId });
  check("Privacy: a forged request for the other player's folder is refused by the GM's client", forged?.ok === false && forged.code === "FORBIDDEN", forged);
  const forgedJournal = await page.evaluate(async ({ moduleId, otherPcId }) => {
    const folder = game.folders.find(f => f.flags?.[moduleId]?.playerJournal?.actorId === otherPcId);
    return game.users.activeGM.query(`${moduleId}.playerJournal`, { action: "createJournal", folderId: folder.id, name: "Snooping" });
  }, { moduleId, otherPcId: setup.otherPcId });
  check("Privacy: a forged journal in the other player's folder is refused", forgedJournal?.ok === false && forgedJournal.code === "FORBIDDEN", forgedJournal);

  // ---- Delete: the journal, then the folder (via Oak)
  await page.locator(".ve-journal-mine-entry", { hasText: OAK }).click();
  await row("Quests").waitFor();
  await row("Quests").locator(".ve-pj-row-open").click();
  await openMenu("Session one");
  await menuItem("Delete").click();
  check("Delete: asks first, naming the journal and its pages", /Delete Session one and its 2 pages\?/.test(await sheet().innerText()), await sheet().innerText());
  await sheet().locator(".is-danger").click();
  await waitFor(gm.page, id => !game.journal.get(id), journal.id);
  check("Delete: the journal is gone", true);
  await footerBack().click();
  await gm.page.evaluate(async ({ folder, playerId }) => {
    await JournalEntry.create({ name: "PJ Test Leftover", folder, ownership: { default: 0, [playerId]: 3 } });
  }, { folder: quests.id, playerId });
  await waitFor(page, () => /1 journal/.test(document.querySelector(".ve-pj-row.is-folder")?.textContent ?? ""));
  await openMenu("Quests");
  await menuItem("Delete").click();
  check("Delete folder: asks first, counting its journals", /Delete Quests and the 1 journals in it\?/.test(await sheet().innerText()), await sheet().innerText());
  await sheet().locator(".is-danger").click();
  await waitFor(gm.page, ({ id }) => !game.folders.get(id) && !game.journal.getName("PJ Test Leftover"), { id: quests.id });
  check("Delete folder: the folder and the journal in it are gone", true);

  // ---- No GM online: writing works, folders need a GM
  await footerNext().click();
  await menuItem("New journal").click();
  await promptName("Offline test");
  await layer.locator(".ve-pj-row.is-page").first().waitFor();
  const offlineId = await page.evaluate(() => game.journal.getName("Offline test")?.id);
  await gm.browser.close();
  gm = null;
  await waitFor(page, () => !game.users.activeGM, null, 20000);
  await row("Notes").locator(".ve-pj-row-open").click();
  await layer.locator(".ve-pj-editor").click();
  await page.keyboard.type("Written while the GM was away.");
  await waitFor(page, () => document.querySelector(".ve-pj-save-status")?.dataset.state === "saved" && /Saved/.test(document.querySelector(".ve-pj-save-status").textContent));
  check("No GM: writing a page still saves", await page.evaluate(id => /GM was away/.test(game.journal.get(id).pages.contents[0].text.content), offlineId));
  await footerBack().click();
  await footerBack().click();
  await footerNext().click();
  await menuItem("New folder").click();
  await promptName("Should fail");
  await page.waitForTimeout(500);
  check("No GM: a new folder says a GM is needed", /A GM needs to be online/.test(await errorText()), await errorText());
  check("No GM: the home screen explains what needs a GM", /No GM is online/.test(await layer.innerText()));
  await shot(page, "no-gm");
} catch (error) {
  check("no unexpected error", false, error.stack ?? String(error));
} finally {
  if (pl) await pl.browser.close().catch(() => {});
  if (gm) await gm.browser.close().catch(() => {});
  // Clean up on a fresh GM page.
  gm = await joinTestWorld("Claude Test GM", desktop);
  await gm.page.evaluate(async ({ moduleId, playerId, names, otherUser }) => {
    const other = game.users.getName(otherUser);
    const ours = f => {
      const flag = f.flags?.[moduleId]?.playerJournal;
      return flag && (flag.userId === playerId || flag.userId === other?.id);
    };
    for (const f of game.folders.filter(f => f.type === "JournalEntry" && ours(f) && f.flags[moduleId].playerJournal.role === "user")) {
      await f.delete({ deleteSubfolders: true, deleteContents: true });
    }
    // Remove the root too if nothing else is in it (a test world only).
    const root = game.folders.find(f => f.flags?.[moduleId]?.playerJournal?.role === "root");
    if (root && !root.children.length && !root.contents.length) await root.delete();
    for (const name of names) for (const a of game.actors.filter(x => x.name === name)) await a.delete();
    if (other) await other.delete();
  }, { moduleId, playerId, names: [WREN, OAK, OTHER_PC], otherUser: OTHER_USER }).catch(e => console.log("CLEANUP FAILED", e.message));
  await gm.browser.close().catch(() => {});
  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
