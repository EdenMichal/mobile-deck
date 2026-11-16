// Phone-size UI test of Change choices (D&D Beyond-style edits) in test-5e-world (Mobile Deck (DEV) enabled there):
//   A. Level Up → Change choices lists ability scores, the species, background and class levels with their picks.
//   B. Ability scores: enter the base numbers again with STR one lower; Review says so; Commit; the increases stay on top.
//   C. Human's starting choices: the picks come preselected; swap the Skillful skill. Fighter level 3: Champion comes
//      preselected; level 4 (ASI, HP) is restored and the Champion's features keep their item ids.
//   D. Replace the species (Human → Dwarf): the new species' choices, Review, Commit; the species link follows.
//   E. As the player (GM approval on): an ability score edit is submitted, the GM's phone approves it, the player sees Done.
//   F. Change history lists the edits.
//   G. Engine (as the GM): replace the background (Soldier → Sage), replace the class at level 4 (Fighter → Barbarian),
//      add a Rogue multiclass and remove it again.
// Builds a Soldier / Human / Fighter 4 (Champion) with the engine from dnd5e's own packs; cleans up the actor, chat
// messages, builder flags and the House Rules it changed.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/edit-character-phone.e2e.mjs
import fs from "fs";
import { fileURLToPath } from "url";
import { pinToSrd } from "./pin-srd.mjs";
import { joinTestWorld } from "./join.mjs";
import { ensureTestPlayer, TEST_PLAYER } from "./test-player.mjs";

const shotsDir = fileURLToPath(new URL("./screens/", import.meta.url));
fs.mkdirSync(shotsDir, { recursive: true });
for (const f of fs.readdirSync(shotsDir)) if (f.startsWith("edit-character-") && f.endsWith(".png")) fs.unlinkSync(`${shotsDir}${f}`);

const phone = {
  context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1" },
  initScript: () => { try {
    localStorage.setItem("mobile-deck-dev.mode", JSON.stringify("phone"));
    localStorage.setItem("music-deck.deckLink", "false");
  } catch {} }
};
const { browser, page } = await joinTestWorld("Claude Test GM", phone);
await pinToSrd(page);
const results = [];
const check = (label, ok, info) => { results.push(Boolean(ok)); console.log(ok ? "PASS" : "FAIL", label, ok ? "" : JSON.stringify(info ?? "").slice(0, 600)); };
let n = 0;
const shotOf = p => async name => { await p.waitForTimeout(350); await p.screenshot({ path: `${shotsDir}edit-character-${String(++n).padStart(2, "0")}-${name}.png` }); };
const shot = shotOf(page);

const messagesBefore = await page.evaluate(() => game.messages.map(m => m.id));
const playerId = await ensureTestPlayer(page);
const setup = await page.evaluate(async playerId => {
  const B = "/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder/";
  const { createBuilderController } = await import(B + "builder-gateway.mjs");
  const { createLevelUpSession } = await import(B + "advancement-driver.mjs");
  const { commitSession } = await import(B + "commit.mjs");
  const { prepareOriginData } = await import(B + "creation-session.mjs");
  const { stepModel } = await import(B + "step-model.mjs");
  // dnd5e's own 2024 packs (classes24, origins24…) first; the test world may hold copies of other books.
  const uuidOf = async (type, name) => {
    const packs = game.packs.filter(p => p.documentName === "Item" && p.metadata.packageName === "dnd5e");
    for (const p of [...packs.filter(p => /24$/.test(p.metadata.name)), ...packs.filter(p => !/24$/.test(p.metadata.name))]) {
      const e = (await p.getIndex()).find(e => e.type === type && e.name === name);
      if (e) return e.uuid;
    }
    return null;
  };
  const rulesBefore = foundry.utils.deepClone(game.settings.get("mobile-deck-dev", "builderHouseRules") ?? {});
  await game.settings.set("mobile-deck-dev", "builderHouseRules", foundry.utils.mergeObject(foundry.utils.deepClone(rulesBefore),
    { approval: { levelUp: true }, abilityMethods: { standardArray: true, pointBuy: true, manual: true } }, { inplace: false }));
  const actor = await Actor.implementation.create({ name: "Thorin (edit test)", type: "character", img: "icons/svg/mystery-man.svg",
    system: { abilities: { str: { value: 15 }, dex: { value: 13 }, con: { value: 14 }, int: { value: 10 }, wis: { value: 12 }, cha: { value: 8 } },
      details: { xp: { value: 2700 } } } });
  const answerFor = m => {
    if (m.type === "HitPoints") return [{ value: "avg" }, { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod, modLabel: m.modLabel } }];
    if (m.type === "Trait") { const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key)); return [{ chosen: [...chosen] }]; }
    if (m.type === "ItemChoice") return [{ selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) }];
    if (m.type === "Subclass") return [{ uuid: m.options.find(o => o.name === "Champion").uuid }, { kind: "subclass" }];
    if (m.type === "AbilityScoreImprovement") return [{ type: "asi", assignments: m.item === "Soldier" ? { str: 2, con: 1 } : { str: 2 } }];
    if (m.type === "Size") return [{ size: m.options[0].key }];
    throw new Error(`setup: unexpected ${m.type}`);
  };
  // Background and species as creation adds them (origin data prepared), then Fighter 1–4.
  for (const [type, name] of [["background", "Soldier"], ["race", "Human"]]) {
    const s = createLevelUpSession(actor, { kind: "new-item", uuid: await uuidOf(type, name) }, [], { prepareItem: prepareOriginData });
    await s.start();
    for (let guard = 0; s.pending && guard < 20; guard++) await s.answer(...answerFor(await stepModel(s)));
    await commitSession(s, { moduleId: "mobile-deck-dev", t: (k, f) => f, kind: "creation" });
  }
  const c = createBuilderController(actor);
  const play = async view => {
    while (view.screen === "step") view = await c.answer(...answerFor(view.model));
    await c.commit();
  };
  await play(await c.start({ kind: "new-class", classUuid: await uuidOf("class", "Fighter"), label: "Fighter 1" }));
  const fighterId = actor.items.find(i => i.type === "class").id;
  for (let l = 2; l <= 4; l++) await play(await c.start({ kind: "level", classId: fighterId }));
  const previousCharacter = game.user.character?.id ?? null;
  await game.user.update({ character: actor.id });
  await actor.update({ [`ownership.${playerId}`]: CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER });
  return { actorId: actor.id, fighterId, raceId: actor.items.find(i => i.type === "race")?.id, previousCharacter, rulesBefore,
    playerCharacter: game.users.get(playerId).character?.id ?? null, level: actor.system.details.level,
    str: actor.system.abilities.str.value, secondWind: actor.items.find(i => i.name === "Second Wind")?.id };
}, playerId);
check("setup: Soldier / Human / Fighter 4", setup.level === 4 && setup.raceId, setup);

const actorState = () => page.evaluate(id => {
  const a = game.actors.get(id);
  return { level: a.system.details.level, hp: a.system.attributes.hp.max,
    abilities: Object.fromEntries(Object.entries(a.system.abilities).map(([k, v]) => [k, v.value])),
    skills: Object.entries(a.system.skills).filter(([, s]) => s.value > 0).map(([k]) => k).sort(),
    race: a.system.details.race?.name ?? null, background: a.system.details.background?.name ?? null,
    subclass: a.items.find(i => i.type === "subclass")?.name ?? null, secondWind: a.items.find(i => i.name === "Second Wind")?.id ?? null,
    log: (a.getFlag("mobile-deck-dev", "changeLog") ?? []).map(e => ({ kind: e.kind, user: e.user?.name, approvedBy: e.approvedBy?.name ?? null })) };
}, setup.actorId);

const layerSel = ".ve-builder-layer:not([data-ve-approval])";
/** Next on the current step; a Trait step with open picks gets the first free chips first. */
async function settle(p) { await p.waitForFunction(sel => document.querySelector(sel)?.getAttribute("aria-busy") !== "true", layerSel, { timeout: 30000 }); }
async function screen(p) { await settle(p); return p.locator(layerSel).getAttribute("data-screen"); }
async function next(p) { await p.locator(`${layerSel} .ve-builder-footer .ve-builder-primary`).click(); await p.waitForTimeout(150); await settle(p); }
async function finishSteps(p, seen = []) {
  for (let guard = 0; guard < 25; guard++) {
    const s = await screen(p);
    if (s === "review") return seen;
    seen.push(s);
    const nextButton = p.locator(`${layerSel} .ve-builder-footer .ve-builder-primary`);
    if (s === "Trait" && await nextButton.isDisabled()) {
      for (const chip of await p.locator(`${layerSel} .ve-builder-chip:not(.is-selected):not([disabled])`).all()) {
        if (!(await nextButton.isDisabled())) break;
        await chip.click();
      }
    }
    if (s === "HitPoints" && await nextButton.isDisabled()) await p.locator(`${layerSel} .ve-builder-big-choice`).nth(1).click();
    await next(p);
  }
  throw new Error(`no Review after ${seen.join(", ")}`);
}
async function prepare(p) {
  await p.addStyleTag({ content: "#notifications { display: none !important; }" });
  await p.waitForTimeout(2500);
  await p.evaluate(async () => {
    for (const app of [...(foundry.applications.instances?.values?.() ?? [])]) if (app.rendered && app.options?.window) await app.close().catch(() => {});
  });
  const notNow = p.getByRole("button", { name: "Not now" });
  if (await notNow.count()) await notNow.first().click().catch(() => {});
  const route = p.locator('[data-route="characters"]');
  if (await route.count()) await route.first().click().catch(() => {});
}
async function openChangeChoices(p) {
  const levelUp = p.locator(".ve-character-identity-controls .ve-character-level-up");
  await levelUp.waitFor({ timeout: 30000 });
  await levelUp.click();
  await p.waitForSelector(`${layerSel}[data-screen="home"]`);
  await p.locator(`${layerSel} [data-action="edit-choices"]`).click();
  await p.waitForSelector(`${layerSel}[data-screen="edit"]`);
}
async function commitAndClose(p) {
  await p.locator(`${layerSel} .ve-builder-footer .ve-builder-primary`).click(); // Commit
  await p.waitForSelector(`${layerSel}[data-screen="done"]`, { timeout: 30000 });
  const lead = await p.locator(`${layerSel} .ve-builder-lead`).innerText();
  const heading = await p.locator(layerSel).innerText();
  await p.locator(`${layerSel} .ve-builder-footer .ve-builder-primary`).click(); // Close
  await p.waitForSelector(layerSel, { state: "detached" });
  return { lead, heading };
}
const reviewText = p => p.locator(`${layerSel} .ve-builder-body`).innerText();
const SKILLS = { Acrobatics: "acr", "Animal Handling": "ani", Arcana: "arc", Athletics: "ath", Deception: "dec", History: "his", Insight: "ins", Intimidation: "itm",
  Investigation: "inv", Medicine: "med", Nature: "nat", Perception: "prc", Performance: "prf", Persuasion: "per", Religion: "rel", "Sleight of Hand": "slt",
  Stealth: "ste", Survival: "sur" };
const skillKey = label => SKILLS[label] ?? label;

let player = null;
try {
  await page.reload();
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60000 });
  await prepare(page);

  // A. The Change choices list
  await openChangeChoices(page);
  const groups = await page.locator(`${layerSel} .ve-builder-edit-group`).evaluateAll(list => list.map(g => ({ type: g.dataset.editType,
    rows: [...g.querySelectorAll("[data-edit-level]")].map(r => r.dataset.editLevel), replace: Boolean(g.querySelector('[data-action="replace"]')),
    text: g.innerText.replace(/\s+/g, " ").slice(0, 800) })));
  const cls = groups.find(g => g.type === "class");
  check("A: species, background and class groups, each replaceable", ["race", "background", "class"].every(t => groups.some(g => g.type === t && g.replace)), groups);
  check("A: Fighter rows for levels 1–4", JSON.stringify(cls?.rows) === JSON.stringify(["1", "2", "3", "4"]), cls);
  check("A: the rows show the current picks (Champion, STR +2)", /Champion/.test(cls?.text) && /STR \+2/.test(cls?.text), cls?.text);
  check("A: an Ability scores row", await page.locator(`${layerSel} [data-action="edit-scores"]`).count() === 1);
  const width = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, view: innerWidth }));
  check("A: no sideways scroll at phone width", width.doc <= width.view, width);
  await shot("overview");

  // B. Ability scores: STR base one lower
  const before = await actorState();
  await page.locator(`${layerSel} [data-action="edit-scores"]`).click();
  await page.waitForSelector(`${layerSel}[data-screen="AbilityScores"]`);
  await shot("scores");
  await page.locator(`${layerSel} .ve-builder-inline-action button`).click(); // Change the numbers
  const inputs = page.locator(`${layerSel} .ve-builder-enter input`);
  const entered = await inputs.evaluateAll(list => list.map(i => Number(i.value)));
  check("B: the base scores come prefilled (15 13 14 10 12 8)", JSON.stringify(entered) === "[15,13,14,10,12,8]", entered);
  await inputs.first().fill(String(entered[0] - 1));
  await page.locator(`${layerSel} [data-action="use-dice"]`).click();
  await shot("scores-entered");
  await next(page);
  check("B: Review", (await screen(page)) === "review");
  const scoresReview = await reviewText(page);
  check("B: Review says STR goes down by one", scoresReview.includes(`STR ${before.abilities.str} → ${before.abilities.str - 1}`), scoresReview);
  await shot("scores-review");
  const scoresDone = await commitAndClose(page);
  check("B: Done says Changes saved", /Changes saved/.test(scoresDone.heading), scoresDone);
  const afterScores = await actorState();
  check("B: STR one lower, the rest unchanged", afterScores.abilities.str === before.abilities.str - 1 && afterScores.abilities.con === before.abilities.con, afterScores.abilities);

  // C. Human's starting choices: swap the Skillful skill
  await openChangeChoices(page);
  await page.locator(`${layerSel} [data-edit-item="${setup.raceId}"][data-edit-level="0"]`).click();
  const speciesSteps = [];
  let swapped = null;
  for (let guard = 0; guard < 8 && !swapped; guard++) {
    const s = await screen(page);
    speciesSteps.push(s);
    const heading = await page.locator(`${layerSel} #ve-builder-title`).innerText().catch(() => "");
    const chips = s === "Trait" ? await page.locator(`${layerSel} .ve-builder-chip`).allInnerTexts() : [];
    if (s === "Trait" && chips.some(c => SKILLS[c.trim()])) {
      const selected = page.locator(`${layerSel} .ve-builder-chip.is-selected`);
      const picks = await selected.allInnerTexts();
      check("C: the Skillful skill comes preselected", picks.length === 1, { picks, heading });
      await shot("species-skill");
      await selected.first().click();
      const fresh = page.locator(`${layerSel} .ve-builder-chip:not(.is-selected):not([disabled])`);
      swapped = { from: picks[0]?.trim(), to: (await fresh.last().innerText()).trim() };
      await fresh.last().click();
      await shot("species-skill-swapped");
    } else if (s === "review") break;
    await next(page);
  }
  const steps = await finishSteps(page, speciesSteps);
  const skillReview = await reviewText(page);
  check("C: Review shows the swap", swapped && skillReview.includes(`${swapped.from}: not proficient`) && skillReview.includes(`${swapped.to}: proficient`), { skillReview, swapped, steps });
  await shot("species-skill-review");
  await commitAndClose(page);
  const afterSkill = await actorState();
  check("C: the skill changed, the rest kept", afterSkill.level === 4 && afterSkill.race === "Human" && afterSkill.hp === afterScores.hp
    && afterSkill.skills.includes(skillKey(swapped?.to)) && !afterSkill.skills.includes(skillKey(swapped?.from)), { afterSkill, swapped });

  // C2. Fighter level 3: keep Champion; level 4 comes back as it was
  const champion = await page.evaluate(id => game.actors.get(id).items.find(i => i.name === "Improved Critical")?.id, setup.actorId);
  await openChangeChoices(page);
  await page.locator(`${layerSel} [data-edit-item="${setup.fighterId}"][data-edit-level="3"]`).click();
  const level3Steps = [];
  for (let guard = 0; guard < 8; guard++) {
    const s = await screen(page);
    if (s === "review") break;
    level3Steps.push(s);
    if (s === "Subclass") {
      check("C2: Champion comes preselected", await page.locator(`${layerSel} .ve-builder-card.is-selected, ${layerSel} [aria-pressed="true"]`, { hasText: "Champion" }).count() > 0);
      await shot("level3-subclass");
    }
    await next(page);
  }
  check("C2: the level's steps: HP, then the subclass", level3Steps.includes("HitPoints") && level3Steps.includes("Subclass"), level3Steps);
  const level3Review = await reviewText(page);
  check("C2: nothing changes", !/→|proficient|^\s*[+−] /m.test(level3Review.replace(/Spells aren't changed[^\n]*/g, "")), level3Review);
  await commitAndClose(page);
  const afterLevel3 = await actorState();
  check("C2: still Fighter 4 (Champion), same HP and scores", afterLevel3.level === 4 && afterLevel3.subclass === "Champion" && afterLevel3.hp === afterSkill.hp
    && JSON.stringify(afterLevel3.abilities) === JSON.stringify(afterSkill.abilities), afterLevel3);
  const championAfter = await page.evaluate(id => game.actors.get(id).items.find(i => i.name === "Improved Critical")?.id, setup.actorId);
  check("C2: the Champion's features kept their item ids", champion && championAfter === champion, { champion, championAfter });
  const afterLevel1 = afterLevel3;

  // D. Replace the species
  await openChangeChoices(page);
  await page.locator(`${layerSel} [data-edit-group="${setup.raceId}"] [data-action="replace"]`).click();
  await page.waitForSelector(`${layerSel}[data-screen="edit-replace"]`);
  await page.locator(`${layerSel} .ve-builder-card`, { hasText: /^\s*Dwarf/ }).first().click();
  await shot("replace-species");
  await page.locator(`${layerSel} [data-action="replace-start"]`).click();
  await finishSteps(page);
  const speciesReview = await reviewText(page);
  check("D: Review: + Dwarf, − Human", /\+ Dwarf/.test(speciesReview) && /− Human/.test(speciesReview), speciesReview);
  await shot("species-review");
  await commitAndClose(page);
  const afterSpecies = await actorState();
  check("D: the species is Dwarf (linked), the rest kept", afterSpecies.race === "Dwarf" && afterSpecies.background === "Soldier" && afterSpecies.level === 4
    && afterSpecies.hp === afterLevel1.hp + 4, afterSpecies);

  // E. The player's edit goes through GM approval
  await page.evaluate(([pid, id]) => game.users.get(pid).update({ character: id }), [playerId, setup.actorId]);
  player = await joinTestWorld(TEST_PLAYER, phone);
  const pp = player.page;
  const pshot = shotOf(pp);
  await prepare(pp);
  await openChangeChoices(pp);
  await pp.locator(`${layerSel} [data-action="edit-scores"]`).click();
  await pp.waitForSelector(`${layerSel}[data-screen="AbilityScores"]`);
  await pp.locator(`${layerSel} .ve-builder-inline-action button`).click();
  const pInputs = pp.locator(`${layerSel} .ve-builder-enter input`);
  await pInputs.first().fill(String(entered[0]));
  await pp.locator(`${layerSel} [data-action="use-dice"]`).click();
  await next(pp);
  const submitText = await pp.locator(`${layerSel} .ve-builder-footer .ve-builder-primary`).innerText();
  check("E: the player's Review says Submit for approval", /Submit for approval/.test(submitText), submitText);
  await pp.locator(`${layerSel} .ve-builder-footer .ve-builder-primary`).click();
  await pp.waitForSelector(`${layerSel}[data-screen="waiting"]`, { timeout: 30000 });
  await pshot("player-waiting");
  const gmLayer = ".ve-mobile-app .ve-builder-layer[data-ve-approval]";
  await page.waitForSelector(`${gmLayer}[data-screen=approval]`, { timeout: 30000 });
  const gmText = await page.locator(gmLayer).innerText();
  check("E: the GM's phone shows the request with the STR change", gmText.includes(`STR ${afterSpecies.abilities.str} → ${afterSpecies.abilities.str + 1}`), gmText.slice(0, 600));
  await shot("gm-approval");
  await page.locator(`${gmLayer} .ve-builder-footer .ve-builder-primary`).click(); // Approve
  await page.waitForSelector(gmLayer, { state: "detached", timeout: 30000 });
  await pp.waitForSelector(`${layerSel}[data-screen="done"]`, { timeout: 30000 });
  const playerDone = await pp.locator(`${layerSel} .ve-builder-lead`).innerText();
  check("E: the player sees Done, approved by the GM", /Approved by Claude Test GM/.test(playerDone), playerDone);
  await pshot("player-done");
  const afterApproval = await actorState();
  check("E: STR back up by one", afterApproval.abilities.str === afterSpecies.abilities.str + 1, afterApproval.abilities);
  check("E: change log: an edit by the player, approved by the GM", afterApproval.log[0]?.kind === "edit" && afterApproval.log[0]?.user === TEST_PLAYER
    && afterApproval.log[0]?.approvedBy === "Claude Test GM", afterApproval.log[0]);

  await pp.locator(`${layerSel} .ve-builder-footer .ve-builder-primary`).click(); // Close
  await pp.waitForSelector(layerSel, { state: "detached" });

  // F. Change history: the five edits (scores, species choices, level 3, species, the player's scores)
  check("F: five edits in the change log", afterApproval.log.filter(e => e.kind === "edit").length === 5, afterApproval.log);
  await page.locator(".ve-character-identity-controls .ve-character-level-up").click();
  await page.waitForSelector(`${layerSel}[data-screen="home"]`);
  await page.locator(`${layerSel} .ve-builder-link`, { hasText: "Change history" }).click();
  await page.waitForSelector(`${layerSel}[data-screen="history"]`);
  const history = await page.locator(`${layerSel} .ve-builder-history summary`).allInnerTexts();
  check("F: Change history shows the species swap", history.some(h => /Human/.test(h) || /Dwarf/.test(h)) && history.length >= 10, history.slice(0, 6));
  await shot("history");
  await page.locator(layerSel).evaluate(el => el.dispatchEvent(new Event("ve-close")));
  await page.locator(layerSel).evaluate(el => el.dispatchEvent(new Event("ve-close"))).catch(() => {});

  // G. Engine: replace the background (Soldier → Sage), replace the class at level 4 (Fighter → Barbarian), add a
  //    Rogue multiclass and remove it again. dnd5e's own 2024 packs, as the GM.
  await page.waitForSelector(layerSel, { state: "detached" }).catch(() => {});
  const engine = await page.evaluate(async actorId => {
    const B = "/modules/mobile-deck-dev/src/foundry/systems/dnd5e/builder/";
    const { createBuilderController } = await import(B + "builder-gateway.mjs");
    const actor = game.actors.get(actorId);
    const uuidOf = async (type, name) => {
      for (const p of game.packs.filter(p => p.documentName === "Item" && p.metadata.packageName === "dnd5e" && /24$/.test(p.metadata.name))) {
        const e = (await p.getIndex()).find(e => e.type === type && e.name === name);
        if (e) return e.uuid;
      }
      return null;
    };
    const state = () => ({ level: actor.system.details.level, hp: actor.system.attributes.hp.max,
      abilities: Object.fromEntries(Object.entries(actor.system.abilities).map(([k, v]) => [k, v.value])),
      skills: Object.entries(actor.system.skills).filter(([, s]) => s.value > 0).map(([k]) => k).sort(),
      race: actor.system.details.race?.name ?? null, background: actor.system.details.background?.name ?? null,
      classes: actor.items.filter(i => i.type === "class").map(i => `${i.name} ${i.system.levels}`).sort(),
      subclass: actor.items.filter(i => i.type === "subclass").map(i => i.name).sort(),
      original: actor.items.get(actor.system.details.originalClass)?.name ?? null,
      features: actor.items.filter(i => i.type === "feat").map(i => i.name).sort(),
      log: (actor.getFlag("mobile-deck-dev", "changeLog") ?? []).slice(0, 1).map(e => ({ kind: e.kind, label: e.label ?? "" }))[0] ?? null });
    const answerFor = (m, prefer) => {
      if (m.type === "HitPoints") return [{ value: "avg" }, { hp: { method: "avg", roll: m.average, die: m.die, mod: m.mod, modLabel: m.modLabel } }];
      if (m.type === "Trait") {
        if (m.answer) return [m.answer];
        const chosen = new Set(); for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key));
        return [{ chosen: [...chosen] }];
      }
      if (m.type === "ItemChoice") return [{ selected: m.options.filter(o => !o.blockers.length).slice(0, m.count).map(o => o.uuid) }];
      if (m.type === "ItemGrant") return [{ selected: m.answer?.selected ?? (m.options ?? []).map(o => o.uuid) }];
      if (m.type === "Subclass") return [{ uuid: (m.options.find(o => o.name === prefer.subclass) ?? m.options[0]).uuid }, { kind: "subclass" }];
      if (m.type === "AbilityScoreImprovement") return [{ type: "asi", assignments: prefer.asi ?? { str: 2 } }];
      if (m.type === "Size") return [{ size: m.options[0].key }];
      if (m.type === "Spells") return [{ cantrips: [], spells: [], prepare: [], swaps: [] }, { kind: "spells", warnings: [] }];
      throw new Error(`unexpected step ${m.type}`);
    };
    const c = createBuilderController(actor);
    const play = async (view, prefer = {}) => {
      const steps = [];
      for (let guard = 0; view.screen === "step" && guard < 60; guard++) { steps.push(view.model.type); view = await c.answer(...answerFor(view.model, prefer)); }
      if (view.screen !== "review") throw new Error(`stuck at ${view.screen} after ${steps.join(", ")}`);
      const review = view.groups.flatMap(g => g.lines.map(l => l.text));
      await c.commit();
      return { steps, review };
    };
    const out = {};
    const multiclassBefore = game.settings.settings.has("dnd5e.allowMulticlassing") ? game.settings.get("dnd5e", "allowMulticlassing") : null;
    try {
      // Background
      out.bgBefore = state();
      const bg = actor.items.find(i => i.type === "background");
      out.bgRun = await play(await c.startEdit({ kind: "replace", itemId: bg.id, uuid: await uuidOf("background", "Sage") }), { asi: { int: 2, wis: 1 } });
      out.bgAfter = state();
      // Class at level 4
      const fighter = actor.items.find(i => i.type === "class" && i.name === "Fighter");
      out.clsRun = await play(await c.startEdit({ kind: "replace", itemId: fighter.id, uuid: await uuidOf("class", "Barbarian") }), { subclass: "Path of the Berserker" });
      out.clsAfter = state();
      // Multiclass Rogue 1, then remove it
      if (multiclassBefore !== null) await game.settings.set("dnd5e", "allowMulticlassing", true);
      out.rogueRun = await play(await c.start({ kind: "new-class", classUuid: await uuidOf("class", "Rogue"), label: "Rogue 1" }));
      out.rogueAfter = state();
      const overview = c.editOverview();
      out.removable = overview.groups.filter(g => g.type === "class").map(g => [g.name, g.canRemove]);
      const rogue = actor.items.find(i => i.type === "class" && i.name === "Rogue");
      out.removeRun = await play(await c.startEdit({ kind: "remove", itemId: rogue.id }));
      out.removeAfter = state();
    } catch (error) {
      out.error = String(error?.stack ?? error).slice(0, 1200);
      out.state = state();
    } finally {
      if (multiclassBefore !== null) await game.settings.set("dnd5e", "allowMulticlassing", multiclassBefore);
    }
    return out;
  }, setup.actorId);
  check("G: the engine edits ran without an error", !engine.error, engine.error ? { error: engine.error, state: engine.state } : "");
  const { bgBefore: g0, bgAfter: g1, clsAfter: g2, rogueAfter: g3, removeAfter: g4 } = engine;
  const delta = (a, b, k) => (b?.abilities?.[k] ?? NaN) - (a?.abilities?.[k] ?? NaN);
  check("G1: the background is Sage (linked), the species and class kept", g1?.background === "Sage" && g1?.race === "Dwarf"
    && JSON.stringify(g1?.classes) === JSON.stringify(["Fighter 4"]), g1);
  check("G1: Soldier's +2 STR +1 CON move to Sage's +2 INT +1 WIS", delta(g0, g1, "str") === -2 && delta(g0, g1, "con") === -1
    && delta(g0, g1, "int") === 2 && delta(g0, g1, "wis") === 1, { before: g0?.abilities, after: g1?.abilities });
  check("G1: Sage's skills (Arcana, History)", ["arc", "his"].every(k => g1?.skills?.includes(k)), g1?.skills);
  check("G1: Review: + Sage, − Soldier; logged as Soldier → Sage", engine.bgRun?.review?.some(l => /Sage/.test(l)) && engine.bgRun?.review?.some(l => /Soldier/.test(l))
    && g1?.log?.kind === "edit" && g1?.log?.label === "Soldier → Sage", { review: engine.bgRun?.review, log: g1?.log });
  check("G2: Barbarian 4 (Berserker) in Fighter's place, now the starting class", JSON.stringify(g2?.classes) === JSON.stringify(["Barbarian 4"])
    && JSON.stringify(g2?.subclass) === JSON.stringify(["Path of the Berserker"]) && g2?.original === "Barbarian" && g2?.level === 4, g2);
  check("G2: the Fighter's features are gone, the Barbarian's are there", !g2?.features?.includes("Second Wind") && g2?.features?.includes("Rage")
    && g2?.background === "Sage" && g2?.race === "Dwarf", g2?.features);
  check("G2: the class's levels were asked (subclass, HP)", engine.clsRun?.steps?.includes("Subclass") && engine.clsRun?.steps?.filter(s => s === "HitPoints").length >= 3, engine.clsRun?.steps);
  check("G2: HP follows the d12 (+5 at level 4, averages)", g2?.hp === g1?.hp + 5, { before: g1?.hp, after: g2?.hp });
  check("G3: Rogue 1 added as a multiclass", JSON.stringify(g3?.classes) === JSON.stringify(["Barbarian 4", "Rogue 1"]) && g3?.level === 5, g3?.classes);
  check("G3: Change choices offers Remove on the Rogue only", JSON.stringify(engine.removable) === JSON.stringify([["Barbarian", false], ["Rogue", true]]), engine.removable);
  check("G4: removing the Rogue asks nothing and leaves Barbarian 4", engine.removeRun?.steps?.length === 0 && JSON.stringify(g4?.classes) === JSON.stringify(["Barbarian 4"])
    && g4?.level === 4 && !g4?.features?.includes("Sneak Attack"), { steps: engine.removeRun?.steps, after: g4 });
  check("G4: HP, scores and skills back to before the Rogue; logged as Remove Rogue", g4?.hp === g2?.hp && JSON.stringify(g4?.abilities) === JSON.stringify(g2?.abilities)
    && JSON.stringify(g4?.skills) === JSON.stringify(g2?.skills) && g4?.log?.label === "Remove Rogue", { g2, g4 });
} catch (error) {
  console.log("ERROR", error.message);
  await shot("error").catch(() => {});
  if (player) await shotOf(player.page)("player-error").catch(() => {});
  results.push(false);
} finally {
  if (player) await player.browser.close().catch(() => {});
  await page.evaluate(async ({ actorId, previousCharacter, playerCharacter, rulesBefore, playerId, messages }) => {
    await game.user.update({ character: previousCharacter });
    await game.users.get(playerId)?.update({ character: playerCharacter });
    await game.settings.set("mobile-deck-dev", "builderHouseRules", rulesBefore);
    await game.actors.get(actorId)?.delete();
    const keep = new Set(messages);
    for (const m of game.messages.contents.filter(m => !keep.has(m.id) && (m.content?.includes("ve-builder-chat-card") || m.flavor?.includes("hit points")))) await m.delete();
    for (const user of [game.user, game.users.get(playerId)].filter(Boolean)) {
      if (user.getFlag("mobile-deck-dev", "builder")?.drafts?.[actorId]) await user.unsetFlag("mobile-deck-dev", `builder.drafts.${actorId}`);
      if (user.getFlag("mobile-deck-dev", "builder")?.results?.[`levelUp:${actorId}`]) await user.unsetFlag("mobile-deck-dev", `builder.results.levelUp:${actorId}`);
    }
  }, { ...setup, playerId, messages: messagesBefore }).catch(e => console.log("cleanup failed", e.message));
  console.log(`${results.filter(Boolean).length}/${results.length} passed; screenshots in ${shotsDir}`);
  await browser.close();
}
