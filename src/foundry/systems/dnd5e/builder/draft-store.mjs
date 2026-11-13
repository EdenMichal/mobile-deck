/**
 * Drafts and locked HP rolls, stored on the current User so a closed phone or a
 * dropped connection resumes where it left off.
 *   flags.<module>.builder.drafts[actorId] = { target, answers, updated }
 *   flags.<module>.builder.rolls["actorId|classIdentifier|level"] = { value, die, messageId }
 *   flags.<module>.builder.creationJson = JSON of the user's one creation draft (Phase 4)
 *   flags.<module>.builder.creationRolls = JSON of the creation rolls (ability sets, gold, trinket); kept
 *     through Start over, cleared after a successful Create (creation-tabs.mjs emptyRolls)
 *   flags.<module>.builder.results[key] = Phase 4b: the GM's decision for the player (approval-rules.mjs resultKey);
 *     written by the GM's client on Approve, cleared by the player's builder once shown
 * Each write touches only its own keys: Foundry merges flag objects, and deletions go in the same update.
 */
import { isCreationDraft, normalizeRolls } from "./creation-tabs.mjs";

/** `{ key: deletion }` for an update: Foundry 14's `_del` operator, or the older "-=key" form. */
const deletion = key => (globalThis._del !== undefined ? { [key]: globalThis._del } : { [`-=${key}`]: null });
/** `{ key: value }` that replaces the stored value whole instead of merging into it (ForcedReplacement, or "==key"). */
const replacement = (key, value) => {
  const Replace = globalThis.foundry?.data?.operators?.ForcedReplacement;
  return Replace ? { [key]: Replace.create(value) } : { [`==${key}`]: value };
};

/** `user`: whose flag this store reads and writes (default: this client's user). A GM's client passes a player's User. */
export function createDraftStore(moduleId, game = globalThis.game, user = game.user) {
  const read = () => user.getFlag(moduleId, "builder") ?? {};
  const write = data => user.setFlag(moduleId, "builder", data);
  const update = builder => user.update({ flags: { [moduleId]: { builder } } });
  const rollKey = (actorId, classIdentifier, level) => `${actorId}|${classIdentifier}|${level}`;
  const parse = raw => { if (!raw) return null; try { return JSON.parse(raw); } catch { return null; } };

  return {
    draft(actorId) { return read().drafts?.[actorId] ?? null; },

    /** Only this actor's draft is written (replaced whole, so a changed target leaves no stale keys). */
    async saveDraft(actorId, draft) {
      await update({ drafts: replacement(actorId, { ...draft, updated: Date.now() }) });
    },

    async clearDraft(actorId, { clearRolls = false } = {}) {
      const data = read();
      const rolls = clearRolls ? Object.keys(data.rolls ?? {}).filter(key => key.startsWith(`${actorId}|`)) : [];
      // One update that deletes just these keys (the rest of the builder flag, creation included, is left alone).
      const changes = {};
      if (data.drafts && actorId in data.drafts) changes.drafts = deletion(actorId);
      if (rolls.length) changes.rolls = Object.assign({}, ...rolls.map(deletion));
      if (Object.keys(changes).length) await update(changes);
    },

    /**
     * Phase 4: the user's one creation draft. Stored as JSON so each save replaces it whole (setFlag merges
     * objects). Anything that isn't a draft of this version (a half-written or older draft) reads as none.
     */
    creation() {
      const draft = parse(read().creationJson);
      return isCreationDraft(draft) ? draft : null;
    },

    /** Phase 4b: the stored creation JSON as parsed, valid or not (the GM removes a waiting draft creation() can't read). */
    rawCreation() { return parse(read().creationJson); },

    async saveCreation(creation) {
      await write({ creationJson: JSON.stringify({ ...creation, updated: Date.now() }) });
    },

    /** Start over: the draft goes; the creation rolls stay. */
    async clearCreation() { await update(deletion("creationJson")); },

    creationRolls() { return normalizeRolls(parse(read().creationRolls)); },

    async saveCreationRolls(rolls) { await write({ creationRolls: JSON.stringify(normalizeRolls(rolls)) }); },

    /** After a successful Create: the draft and its rolls are history. */
    async finishCreation() { await update({ ...deletion("creationJson"), ...deletion("creationRolls") }); },

    /** Phase 4b: the GM's decisions waiting to be shown to this user, by resultKey. */
    results() { return read().results ?? {}; },
    async saveResult(key, result) { await update({ results: replacement(key, result) }); },
    async clearResult(key) { if (key in (read().results ?? {})) await update({ results: deletion(key) }); },

    /**
     * The GM's Approve, in ONE update: the player's client then sees the draft gone and the result together (two updates
     * would show it a Start / Home screen without the result in between).
     */
    async finishCreationWith(key, result) {
      await update({ ...deletion("creationJson"), ...deletion("creationRolls"), results: replacement(key, result) });
    },
    async finishLevelUpWith(actorId, key, result) {
      const data = read();
      const rolls = Object.keys(data.rolls ?? {}).filter(k => k.startsWith(`${actorId}|`));
      const changes = { results: replacement(key, result) };
      if (data.drafts && actorId in data.drafts) changes.drafts = deletion(actorId);
      if (rolls.length) changes.rolls = Object.assign({}, ...rolls.map(deletion));
      await update(changes);
    },

    /** The HP locks for one actor ([{ key, value, die, messageId, date }]). */
    locksFor(actorId) {
      return Object.entries(read().rolls ?? {}).filter(([key]) => key.startsWith(`${actorId}|`)).map(([key, lock]) => ({ key, ...lock }));
    },

    lockedRoll(actorId, classIdentifier, level) { return read().rolls?.[rollKey(actorId, classIdentifier, level)] ?? null; },

    /**
     * Roll the hit die once and lock it. The roll goes to chat, whispered to the GMs
     * and the player, so a reroll would be visible anyway.
     */
    async rollHitPoints({ actor, classIdentifier, className, level, die }) {
      const existing = this.lockedRoll(actor.id, classIdentifier, level);
      if (existing) return existing;
      const roll = await new Roll(`1d${die}`).evaluate();
      let messageId = "";
      try {
        const recipients = [...game.users.filter(u => u.isGM).map(u => u.id), game.user.id];
        // "gmroll" whispers the roll to the GMs and the roller (a plain whisper list is
        // overridden by the user's default roll mode).
        const message = await roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor }),
          flavor: `${className} ${level}: hit points (level-up)`,
          whisper: [...new Set(recipients)]
        }, { rollMode: CONST.DICE_ROLL_MODES?.PRIVATE ?? "gmroll" });
        messageId = message?.id ?? "";
      } catch { /* the lock below still holds */ }
      const value = Number(roll.total);
      // Only this lock is written; Foundry merges it into the other locks.
      const lock = { value, die, messageId, date: Date.now() };
      await update({ rolls: { [rollKey(actor.id, classIdentifier, level)]: lock } });
      return lock;
    },

    /** After a commit the level's roll is history; drop the lock and the draft. */
    async finish(actorId) { await this.clearDraft(actorId, { clearRolls: true }); }
  };
}
