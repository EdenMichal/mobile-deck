// End-to-end test of Phase 4b GM approval (no UI) in test-5e-world, on a Claude Test GM page acting for Claude Test Player:
// 1. Creation: a Human Soldier Fighter draft built on the player's flag (rolled scores: the chat cards are the GM's, so the
//    GM's check warns), submitted; edits refused; the service lists it and rebuilds the review read-only; a withdrawal makes
//    Approve refuse; resubmitted; rejected with a reason (status, note, whisper); an edit makes it a draft again with the note;
//    resubmitted; "approving" refuses a withdrawal; Approve creates the actor owned by and assigned to the player, change log
//    author = player and approvedBy = GM, chat card to the player, draft and rolls cleared and the result written in one update.
//    Review fixes: forged rolls (too many sets, a wrong reroll count) warn; a clean build has no "outside its list" warning;
//    a fresh claim by another GM page refuses Approve and Withdraw; a stale one lets the player withdraw and is taken over
//    by Approve. A second character whose actor already exists (stamped with the submission) and still carries this page's
//    own claim (a finish that failed) is finished by Approve, not made twice. A creation
//    pick of the wrong type is blocked.
// 2. Level-up of a player-owned Fighter 1 → 2: rolled HP (lock card is the GM's → warning), submitted, rejected, edited,
//    resubmitted; a changed level warns; a forged HP answer (data.value not the lock, notes saying "average") warns and the
//    review shows the applied roll; approved (level 2, change log, result, draft and lock cleared). A submission for an
//    actor the player doesn't own is blocked, and so are invalid targets (a class the actor lacks, a "new-item").
// 3. Modes: the player needs approval for both; the GM's own creation is "create"; with the level-up switch off the player's
//    level-up is "commit" (a Fighter 2 → 3 with a Subclass step).
// Cleans up: actors, chat cards, both users' builder flags, the player's assigned character, the house rules.
// Run: PLAYWRIGHT=/path/to/playwright/index.mjs node tests/foundry/approval.e2e.mjs
import { pinToSrd } from "./pin-srd.mjs";
import { ensureTestPlayer } from "./test-player.mjs";
import { joinTestWorld } from "./join.mjs";

const { browser, page } = await joinTestWorld();
await pinToSrd(page);
const playerId = await ensureTestPlayer(page);
const result = await page.evaluate(async playerId => {
  globalThis.veBuilderApprovalPaused = true; // this suite calls the service itself
  const checks = [];
  const check = (label, ok, info) => checks.push({ ok: !!ok, label, info: ok ? undefined : info });
  const moduleId = game.modules.get("mobile-deck-dev")?.active ? "mobile-deck-dev" : "mobile-deck";
  const base = `/modules/${moduleId}/src/foundry/systems/dnd5e/builder`;
  const { createCreationController } = await import(`${base}/creation-controller.mjs`);
  const { createBuilderController, t } = await import(`${base}/builder-gateway.mjs`);
  const { createApprovalService } = await import(`${base}/approval-service.mjs`);
  const { suggestedAssignments } = await import(`${base}/creation-rules.mjs`);
  const { pageId, submissionId } = await import(`${base}/approval-rules.mjs`);
  const player = game.users.get(playerId);
  const builder = () => player.getFlag(moduleId, "builder") ?? {};
  // Deletes a user's whole builder flag (Foundry 14's _del, older cores' "-=").
  const dropBuilder = user => user.update({ flags: { [moduleId]: globalThis._del !== undefined ? { builder: globalThis._del } : { "-=builder": null } } });
  const rulesBefore = foundry.utils.deepClone(game.settings.get(moduleId, "builderHouseRules") ?? {});
  const characterBefore = player.character?.id ?? null;
  const builderBefore = foundry.utils.deepClone(builder());
  const gmBuilderBefore = foundry.utils.deepClone(game.user.getFlag(moduleId, "builder") ?? {});
  const messagesBefore = new Set(game.messages.map(m => m.id));
  const created = [];
  const service = createApprovalService({ moduleId, t, levelUpController: createBuilderController });
  const level = id => service.list().find(s => s.kind === "level-up" && s.actorId === id);
  const hpAnswer = (m, method, roll) => ({ data: { value: method === "roll" ? roll : "avg" },
    meta: { hp: { method, roll: method === "roll" ? roll : m.average, die: m.die, mod: m.mod, modLabel: m.modLabel, classIdentifier: m.classIdentifier, level: m.level } } });

  // Answers as in creation.e2e.mjs: Trait picks skip the background's and species' grants (the tabs are answered in rules order).
  const answerFor = m => {
    if (m.type === "Trait") {
      const chosen = new Set();
      for (const s of m.slots) s.options.filter(o => !chosen.has(o.key)).slice(0, s.count).forEach(o => chosen.add(o.key));
      return { data: { chosen: [...chosen] } };
    }
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
    if (m.type === "HitPoints") return hpAnswer(m, "avg");
    throw new Error(`Unexpected screen ${m.type}`);
  };
  /** Pick by name; species come as groups ({ name, variants }) whose first variant is the plain species (creation.e2e.mjs). */
  const playTab = async (c, tab, name) => {
    let v = await c.segment(tab);
    const option = v.options.find(o => o.name === name);
    v = await c.pick(tab, option.uuid ?? option.variants[0].uuid);
    for (let guard = 0; v.screen === "step" && guard < 30; guard++) { const a = answerFor(v.model); v = await c.answer(tab, a.data, a.meta); }
    return v;
  };
  const playLevel = async (c, v) => { for (let g = 0; v.screen === "step" && g < 20; g++) { const a = answerFor(v.model); v = await c.answer(a.data, a.meta); } return v; };
  /** A finished Human Soldier Fighter on the player's flag. Rules order (background, species, class), so class skills avoid the others' grants. */
  const buildCreation = async name => {
    const c = createCreationController({ moduleId, t, user: player });
    await c.start({});
    await playTab(c, "background", "Soldier");
    await playTab(c, "species", "Human");
    await playTab(c, "class", "Fighter");
    const ab = await c.rollAbilities();
    await c.setAbilities({ method: "roll", assignments: suggestedAssignments(ab.classIdentifier, ab.slots) });
    const eq = await c.equipment();
    for (const s of eq.sections) await c.setEquipment(s.source, { option: s.options.find(o => o.kind === "gold").id });
    await c.setDetails({ name, alignment: "", biography: "" });
    return c;
  };
  const threw = async fn => { try { await fn(); return ""; } catch (e) { return e.message; } };

  try {
    await game.settings.set(moduleId, "builderHouseRules", { ...rulesBefore, abilityMethods: { standardArray: true, pointBuy: false, roll: true, manual: false },
      abilityRerolls: 0, approval: { creation: true, levelUp: true } });
    await dropBuilder(player);
    if (player.character) await player.update({ character: null });

    // ---- 3. Modes
    const gmc = createCreationController({ moduleId, t });
    if (gmc.hasDraft()) await gmc.discard();
    await gmc.start({});
    check("the GM's own creation saves directly (mode create)", (await gmc.review()).mode === "create");
    await gmc.discard();

    // ---- 1. Creation
    let c = await buildCreation("CB Approval Mira");
    check("player's creation needs approval (mode submit)", (await c.review()).mode === "submit");
    check("draft owner is the player", JSON.parse(builder().creationJson).owner === playerId);
    let review = await c.review();
    check("finished draft has no blockers", review.blockers.length === 0, review.blockers);
    await c.submit();
    check("submitted: status on the player's flag", JSON.parse(builder().creationJson).status === "submitted");
    check("a submitted draft refuses edits", /Withdraw/.test(await threw(() => c.setDetails({ name: "x", alignment: "", biography: "" }))));
    check("a submitted draft refuses Start over", /Withdraw it/.test(await threw(() => c.discard())));
    let list = service.list();
    check("the service lists the creation", list.length === 1 && list[0].kind === "creation" && list[0].label === "CB Approval Mira", list);
    let model = await service.open(list[0]);
    check("review rebuilt on the GM's client, no blockers", model.blockers.length === 0 && model.groups.some(g => g.id === "equipment"), model.blockers);
    check("rolled set whose chat card is the GM's → warning", model.warnings.some(w => /someone else/.test(w.text)), model.warnings);
    check("the read-only open didn't touch the player's draft", JSON.parse(builder().creationJson).status === "submitted");
    check("a clean build: no pick outside its list", !model.warnings.some(w => /outside its list/.test(w.text)), model.warnings);
    check("one set, no reroll: no count warning", !model.warnings.some(w => /ability sets were rolled|reroll count/.test(w.text)), model.warnings);
    // Forged rolls: a second set with no reroll counted (the House Rules allow none).
    const rollsSaved = builder().creationRolls;
    const forgedRolls = JSON.parse(rollsSaved);
    forgedRolls.abilities.sets.push([18, 18, 18, 18, 18, 18]);
    forgedRolls.abilities.messageIds.push("");
    await player.setFlag(moduleId, "builder", { creationRolls: JSON.stringify(forgedRolls) });
    let forgedModel = await service.open(service.list()[0]);
    check("too many rolled sets → warning", forgedModel.warnings.some(w => /2 ability sets were rolled; the House Rules allow 1/.test(w.text)), forgedModel.warnings);
    check("reroll count that doesn't match the sets → warning", forgedModel.warnings.some(w => /reroll count \(0\)/.test(w.text)), forgedModel.warnings);
    await player.setFlag(moduleId, "builder", { creationRolls: rollsSaved });
    await c.withdraw();
    check("withdrawn → Approve refuses", /changed or withdrew/.test(await threw(() => service.approve(model))));
    check("withdrawn → no actor created", !game.actors.getName("CB Approval Mira"));
    await c.submit();
    model = await service.open(service.list()[0]);
    check("reject needs a reason", /reason/.test(await threw(() => service.reject(model, "  "))));
    await service.reject(model, "Please give her a short backstory.");
    let d = JSON.parse(builder().creationJson);
    check("creation rejected: status, note and author", d.status === "rejected" && d.rejectReason === "Please give her a short backstory." && d.rejectedBy?.id === game.user.id, d);
    check("rejection whispered to the player", game.messages.contents.some(m => !messagesBefore.has(m.id) && /sent back/.test(m.content) && m.whisper.includes(playerId)));
    c = createCreationController({ moduleId, t, user: player });
    await c.resume();
    review = await c.review();
    check("Review carries the GM's note", review.status === "rejected" && review.rejectReason === "Please give her a short backstory." && review.rejectedBy === game.user.name, review.status);
    await c.setDetails({ name: "CB Approval Mira", alignment: "", biography: "Raised in the barracks." });
    d = JSON.parse(builder().creationJson);
    check("an edit makes it a draft again, the note stays", d.status === "draft" && d.rejectReason === "Please give her a short backstory.", d.status);
    await c.submit();
    check("resubmitting drops the note", !JSON.parse(builder().creationJson).rejectReason);
    // Another GM page that is saving it right now (a fresh claim): the player can't withdraw, and Approve here refuses.
    const saved = builder().creationJson;
    const claim = at => player.setFlag(moduleId, "builder", { creationJson: JSON.stringify({ ...JSON.parse(saved), status: "approving", approvingBy: "otherPage", approvingAt: at }) });
    model = await service.open(service.list()[0]);
    await claim(game.time.serverTime);
    check("a fresh claim refuses a withdrawal", /approving this right now/.test(await threw(() => c.withdraw())));
    check("a fresh claim by another page refuses Approve", /Another GM window/.test(await threw(() => service.approve(model))));
    check("refused → no actor, the other page's claim untouched", !game.actors.getName("CB Approval Mira") && JSON.parse(builder().creationJson).approvingBy === "otherPage");
    // That page died: its claim goes stale after two minutes. The player may withdraw it then.
    await claim(game.time.serverTime - 3 * 60 * 1000);
    const cs = createCreationController({ moduleId, t, user: player });
    await cs.withdraw();
    check("a stale claim lets the player withdraw", JSON.parse(builder().creationJson).status === "draft");
    // …and Approve takes it over.
    await claim(game.time.serverTime - 3 * 60 * 1000);
    model = await service.open(service.list()[0]);
    const approved = await service.approve(model);
    const actor = game.actors.get(approved.actor.id);
    created.push(actor);
    check("approve created the actor", actor?.name === "CB Approval Mira");
    check("owned by the player", actor?.ownership?.[playerId] === CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER, actor?.ownership);
    check("assigned to the player (they had none)", player.character?.id === actor?.id);
    const log = actor?.getFlag(moduleId, "changeLog")?.[0];
    check("change log: author player, approved by GM", log?.user?.id === playerId && log?.approvedBy?.id === game.user.id, log && { user: log.user, approvedBy: log.approvedBy });
    const card = game.messages.contents.filter(m => !messagesBefore.has(m.id)).find(m => /approved by/.test(m.content) && /CB Approval Mira/.test(m.content));
    check("chat card whispered to the player, says approved by", card?.whisper?.includes(playerId), card?.whisper);
    check("player's draft and rolls cleared", !builder().creationJson && !builder().creationRolls, Object.keys(builder()));
    const res = builder().results?.creation;
    check("result written for the player, without undo data", res?.name === "CB Approval Mira" && res.entry?.groups?.length > 0 && res.entry.undo === null && res.by === game.user.name);
    check("nothing waits any more", service.list().length === 0);
    check("the actor is stamped with its submission", actor?.getFlag(moduleId, "approvalOf") === submissionId(model.sub), actor?.getFlag(moduleId, "approvalOf"));

    // ---- 1b. Idempotency: an actor already made from this submission (an earlier Approve whose finish write failed).
    c = await buildCreation("CB Approval Twin");
    await c.submit();
    const twinSub = service.list()[0];
    const twin = await Actor.implementation.create({ name: "CB Approval Twin", type: "character", ownership: { default: 0, [playerId]: 3 },
      flags: { [moduleId]: { approvalOf: submissionId(twinSub), changeLog: [{ id: "x", kind: "creation", date: Date.now(), user: { id: playerId, name: player.name },
        approvedBy: { id: game.user.id, name: game.user.name }, approvalOf: submissionId(twinSub), before: { level: 0, label: "New character" }, after: { level: 1, label: "Fighter 1" }, groups: [], undo: null }] } } });
    created.push(twin);
    model = await service.open(twinSub);
    // This page's own claim from that earlier Approve is still on the draft: Approve here goes on (it only finishes).
    await player.setFlag(moduleId, "builder", { creationJson: JSON.stringify({ ...JSON.parse(builder().creationJson), status: "approving",
      approvingBy: pageId(), approvingAt: game.time.serverTime }) });
    const again = await service.approve(model);
    check("this page's own claim doesn't block its Approve", Boolean(again?.actor));
    check("already stamped → no second actor", game.actors.filter(a => a.name === "CB Approval Twin").length === 1 && again.actor.id === twin.id);
    check("…and only the finish ran: draft gone, result written", !builder().creationJson && builder().results?.creation?.name === "CB Approval Twin");
    for (const a of game.actors.filter(x => x.name === "CB Approval Twin" && x.id !== twin.id)) created.push(a);

    // ---- 1c. A creation pick of the wrong type (a background on the Class tab) is blocked before the replay.
    const background = (await createCreationController({ moduleId, t, user: player }).options("background")).find(o => o.name === "Soldier");
    await player.setFlag(moduleId, "builder", { creationJson: JSON.stringify({ version: 2, owner: playerId, startLevel: 1, status: "submitted", submittedAt: Date.now(),
      tabs: { class: { uuid: background.uuid, answers: [] }, background: null, species: null, abilities: null, equipment: {}, details: { name: "CB Approval Forged", alignment: "", biography: "" } } }) });
    model = await service.open(service.list()[0]);
    check("a class pick that isn't a class → blocked", model.blockers.some(b => /Class: the saved pick isn't a class/.test(b.text)), model.blockers);
    await service.reject(model, "Pick a class.");
    // A waiting draft this version can't read: listed as invalid, and Reject removes it.
    await player.setFlag(moduleId, "builder", { creationJson: JSON.stringify({ version: 1, status: "submitted", submittedAt: Date.now(), tabs: {} }) });
    model = await service.open(service.list()[0]);
    check("an unreadable waiting draft → blocked", model.blockers.some(b => /can't be read/.test(b.text)), model.blockers);
    await service.reject(model, "Please start again.");
    check("…and Reject removes it", !builder().creationJson && service.list().length === 0);

    // ---- 2. Level-up: a Fighter 1 owned by the player
    const fighter = (await game.packs.get("dnd5e.classes24").getIndex()).find(e => e.type === "class" && e.name === "Fighter");
    const makeFighter = async (name, ownership) => {
      const hero = await Actor.implementation.create({ name, type: "character", ownership,
        system: { abilities: { str: { value: 15 }, dex: { value: 14 }, con: { value: 14 }, int: { value: 8 }, wis: { value: 12 }, cha: { value: 10 } }, details: { xp: { value: 900 } } } });
      created.push(hero);
      const gm = createBuilderController(hero, { moduleId });
      await playLevel(gm, await gm.start({ kind: "new-class", classUuid: fighter.uuid, label: "Fighter 1" }));
      await gm.commit();
      return hero;
    };
    const hero = await makeFighter("CB Approval Brienne", { default: 0, [playerId]: 3 });
    const lc = createBuilderController(hero, { moduleId, user: player });
    let v = await lc.start({ kind: "level", classId: hero.items.find(i => i.type === "class").id });
    check("Fighter 2 asks hit points first", v.model?.type === "HitPoints", v.model?.type);
    const lock = await lc.rollHitPoints(v.model);
    v = await playLevel(lc, await lc.answer(...Object.values(hpAnswer(v.model, "roll", lock.value))));
    check("player's level-up needs approval (mode submit)", v.screen === "review" && v.mode === "submit", v.mode);
    check("commit refused in submit mode", /approval/.test(await threw(() => lc.commit())));
    await lc.submit();
    check("submitted with the starting level", builder().drafts?.[hero.id]?.status === "submitted" && builder().drafts[hero.id].level === 1, builder().drafts?.[hero.id]);
    model = await service.open(level(hero.id));
    check("level-up review rebuilt: Fighter 1 → Fighter 2", /Fighter 1 → Fighter 2/.test(model.subtitle) && model.blockers.length === 0, model.subtitle);
    // The answer finds its own lock by key (not "no locked roll matches it"), and that lock's chat card is the GM's.
    check("HP lock card is the GM's → warning", model.warnings.some(w => /Hit point roll \d+: its chat card was posted by someone else/.test(w.text)), model.warnings);
    await service.reject(model, "Please double-check, then send it again.");
    d = builder().drafts?.[hero.id];
    check("level-up rejected: status, note and author", d?.status === "rejected" && d.rejectReason === "Please double-check, then send it again." && d.rejectedBy?.id === game.user.id, d);
    check("nothing applied on reject", hero.system.details.level === 1);
    const lc2 = createBuilderController(hero, { moduleId, user: player });
    v = await lc2.resume();
    check("resumed rejected level-up shows the note", v.rejectReason === "Please double-check, then send it again." && v.rejectedBy === game.user.name, v.rejectReason);
    v = await lc2.edit(0);
    v = await playLevel(lc2, await lc2.answer(...Object.values(hpAnswer(v.model, "roll", lock.value)))); // the locked roll again
    d = builder().drafts?.[hero.id];
    check("an edit makes it a draft again, note and author stay", d?.status === "draft" && d.rejectReason && d.rejectedBy?.id === game.user.id, d);
    await lc2.submit();
    check("resubmitting drops the note", !builder().drafts[hero.id].rejectReason);
    // A changed level: simulated by a submission that says it started from level 5.
    await player.update({ [`flags.${moduleId}.builder.drafts.${hero.id}`]: { ...builder().drafts[hero.id], level: 5 } });
    model = await service.open(level(hero.id));
    check("a changed level warns", model.warnings.some(w => /level 5 when this was submitted/.test(w.text)), model.warnings);
    // A forged HP answer: the applied value isn't the locked roll, and the screen's notes say "average".
    const real = builder().drafts[hero.id];
    const hpIndex = real.answers.findIndex(a => a.meta?.hp);
    const forgedValue = (Number(lock.value) % 10) + 1;
    const forgedHp = foundry.utils.deepClone(real);
    forgedHp.answers[hpIndex] = { ...real.answers[hpIndex], data: { value: forgedValue }, meta: { hp: { ...real.answers[hpIndex].meta.hp, method: "avg", roll: 6 } } };
    await player.update({ [`flags.${moduleId}.builder.drafts.${hero.id}`]: forgedHp });
    const hpModel = await service.open(level(hero.id));
    check("HP check reads data.value: a forged value with notes saying average warns", hpModel.warnings.some(w => new RegExp(`Hit point roll ${forgedValue}: no locked roll matches it`).test(w.text)), hpModel.warnings);
    const hpLine = hpModel.groups.find(g => g.id === "hp")?.lines[0]?.text ?? "";
    check("the review's HP line shows the applied roll", new RegExp(`rolled ${forgedValue} on a d10`).test(hpLine), hpLine);
    check("a clean level-up: no pick outside its list", !model.warnings.some(w => /outside its list/.test(w.text)), model.warnings);
    await player.update({ [`flags.${moduleId}.builder.drafts.${hero.id}`]: real });
    model = await service.open(level(hero.id));
    await service.approve(model);
    check("approve applied the level-up", hero.system.details.level === 2);
    const hlog = hero.getFlag(moduleId, "changeLog")?.[0];
    check("level-up change log: author player, approved by GM", hlog?.user?.id === playerId && hlog?.approvedBy?.id === game.user.id && hlog.kind === "level-up");
    check("player's level-up draft and lock cleared", !builder().drafts?.[hero.id] && !Object.keys(builder().rolls ?? {}).some(k => k.startsWith(hero.id)));
    check("level-up result for the player, without undo data", builder().results?.[`levelUp:${hero.id}`]?.label?.includes("Fighter 2") && builder().results[`levelUp:${hero.id}`].entry.undo === null);

    // ---- 2b. A submission for someone else's character is blocked.
    const other = await makeFighter("CB Approval Not Yours", { default: 0 });
    const forged = { target: { kind: "level", classId: other.items.find(i => i.type === "class").id }, answers: [], status: "submitted", submittedAt: Date.now(), label: "Fighter 1 → 2" };
    await player.update({ [`flags.${moduleId}.builder.drafts.${other.id}`]: forged });
    model = await service.open(level(other.id));
    check("not the player's character → blocked", model.blockers.some(b => /doesn't own/.test(b.text)), model.blockers);
    check("blocked → Approve refuses", /can't be approved/.test(await threw(() => service.approve(model))));
    await service.reject(model, "Not your character.");
    // Invalid targets the player wrote: a class the actor lacks, and a kind Mobile Deck never makes.
    for (const [target, pattern] of [[{ kind: "level", classId: "noSuchClass000" }, /has no such class/], [{ kind: "new-item", uuid: fighter.uuid }, /isn't a level-up Mobile Deck makes/]]) {
      await player.update({ [`flags.${moduleId}.builder.drafts.${hero.id}`]: { target, answers: [], status: "submitted", submittedAt: Date.now(), label: "forged" } });
      model = await service.open(level(hero.id));
      check(`invalid level-up target (${target.kind}) → blocked`, model.blockers.some(b => pattern.test(b.text)), model.blockers);
      await service.reject(model, "Not a level-up.");
    }

    // ---- 3b. Level-up switch off: the player commits directly (Fighter 2 → 3 asks for a subclass).
    await game.settings.set(moduleId, "builderHouseRules", { ...game.settings.get(moduleId, "builderHouseRules"), approval: { creation: true, levelUp: false } });
    const lc3 = createBuilderController(hero, { moduleId, user: player });
    v = await playLevel(lc3, await lc3.start({ kind: "level", classId: hero.items.find(i => i.type === "class").id }));
    check("level-up switch off → mode commit", v.screen === "review" && v.mode === "commit", v.mode);
    await lc3.discardDraft();
  } catch (error) {
    check(`no exception: ${error.message}`, false, error.stack);
  } finally {
    for (const a of created) await a?.delete?.().catch(() => {});
    const mine = game.messages.contents.filter(m => !messagesBefore.has(m.id)).map(m => m.id);
    if (mine.length) await ChatMessage.deleteDocuments(mine);
    await dropBuilder(player);
    if (Object.keys(builderBefore).length) await player.setFlag(moduleId, "builder", builderBefore);
    await dropBuilder(game.user);
    if (Object.keys(gmBuilderBefore).length) await game.user.setFlag(moduleId, "builder", gmBuilderBefore);
    if ((player.character?.id ?? null) !== characterBefore) await player.update({ character: characterBefore });
    await game.settings.set(moduleId, "builderHouseRules", rulesBefore);
    globalThis.veBuilderApprovalPaused = false;
  }
  return checks;
}, playerId);
let failed = 0;
for (const c of result) { if (!c.ok) failed++; console.log(c.ok ? "PASS" : "FAIL", c.label, c.ok ? "" : JSON.stringify(c.info ?? "").slice(0, 500)); }
console.log(`${result.length - failed}/${result.length} passed`);
await browser.close();
process.exit(failed ? 1 : 0);
