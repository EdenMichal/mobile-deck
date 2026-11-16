import { localizeFoundry } from "./localization.mjs";
import { CommandError } from "./command-support.mjs";
import { MODULE_ID } from "./preferences.mjs";
import { createKeyedQueue } from "../kernel/party-stash-rules.mjs";
import {
  PLAYER_JOURNAL_FLAG, ROLES, PlayerJournalRuleError, readFolderFlag, cleanName, findFolder, planFolderUpkeep, upkeepIsIdle,
  ownedFolder, characterFolderOf, assertCanHoldFolder, folderMoveTargets, journalMoveTargets, buildCharacterTree, bySort,
  reorderUpdates, nextSort, checkImageUpload, imageFileName
} from "../kernel/player-journal-rules.mjs";

/** Player journals: each player's private notes, one folder per character, all ordinary Foundry
 * folders, journals and pages (see kernel/player-journal-rules.mjs for the layout).
 *
 * Foundry lets only GMs and Assistant GMs make or change Folders, makes new journals need
 * "Create Journal Entries" (Trusted) and uploads need "Upload Files" (Assistant). So those three
 * run on the active GM's client through CONFIG.queries, which re-checks every request against the
 * asking user Foundry authenticated. Everything a journal's owner may do (rename, move, delete the
 * journal; create, write, reorder, delete its pages) runs directly, so writing works with no GM online.
 *
 * The GM's client also keeps the folders tidy: on ready, and when characters or players change,
 * it makes any missing Player Journals / player / character folder and follows renames. */

// dev-install rewrites MODULE_ID, so the dev copy registers "mobile-deck-dev.playerJournal".
export const PLAYER_JOURNAL_QUERY = `${MODULE_ID}.playerJournal`;
const QUERY_TIMEOUT = 30_000;
const UPLOAD_TIMEOUT = 120_000;
const UPKEEP_DELAY_MS = 400;
const OWNER = 3;
const NONE = 0;
const queue = createKeyedQueue();
// Every folder upkeep (on hooks, or for a player's "ensure") runs in this one line, so the
// root and player folders are never made twice.
const UPKEEP_KEY = "\u0000upkeep";

const t = (key, fallback, data) => localizeFoundry(`VEMOBILE.PlayerJournals.${key}`, fallback, data);

/** A failure with a message in this client's language; `relay` keeps the parts to send to a player. */
function journalError(code, key, fallback, data = {}, cause) {
  const error = new CommandError(code, t(key, fallback, data), cause ? { cause } : {});
  error.relay = Object.freeze({ key, fallback, data: plainData(data) });
  return error;
}

function plainData(data) {
  return Object.fromEntries(Object.entries(data ?? {}).map(([key, value]) => [key, typeof value === "number" ? value : String(value ?? "")]));
}

// Turn a rule refusal into this client's localized error.
function fromRule(error) {
  if (error instanceof PlayerJournalRuleError) return journalError(error.code, error.key, error.fallback, error.data, error);
  return error;
}
const ruled = fn => { try { return fn(); } catch (error) { throw fromRule(error); } };

// ---- Reading Foundry into plain records ----

/** Journal folders as rule records. */
export function folderRecords(game = globalThis.game) {
  return Array.from(game?.folders ?? []).filter(folder => folder?.type === "JournalEntry").map(folder => {
    const flag = readFolderFlag(folder.flags?.[MODULE_ID]?.[PLAYER_JOURNAL_FLAG]);
    return {
      id: String(folder.id ?? ""), name: String(folder.name ?? ""),
      parentId: String(folder.folder?.id ?? folder._source?.folder ?? ""),
      sort: Number(folder.sort) || 0,
      role: flag?.role ?? "", userId: flag?.userId ?? "", actorId: flag?.actorId ?? ""
    };
  });
}

function journalFolderId(journal) {
  return String(journal?.folder?.id ?? journal?._source?.folder ?? "");
}

function permitted(document, user, level) {
  try { return Boolean(document?.testUserPermission?.(user, level)); } catch { return false; }
}

/** The characters a player keeps notes for: characters they were given Owner on by name (not the
 * world's default permission), plus their assigned character. */
export function ownsCharacter(actor, user) {
  if (!actor || !user || actor.type !== "character") return false;
  if (String(user.character?.id ?? "") === String(actor.id)) return true;
  return Number(actor.ownership?.[user.id] ?? NONE) >= OWNER;
}

function playerCharacters(game, user) {
  return Array.from(game?.actors ?? []).filter(actor => ownsCharacter(actor, user))
    .sort((left, right) => String(left.name ?? "").localeCompare(String(right.name ?? "")));
}

function desiredFolders(game, onlyUserId = "") {
  return Array.from(game?.users ?? []).filter(user => !user.isGM && (!onlyUserId || user.id === onlyUserId)).map(user => ({
    userId: String(user.id), name: String(user.name ?? ""),
    characters: playerCharacters(game, user).map(actor => ({ actorId: String(actor.id), name: String(actor.name ?? "") }))
  }));
}

// ---- GM side: folder upkeep ----

const flagData = flag => ({ [MODULE_ID]: { [PLAYER_JOURNAL_FLAG]: flag } });

/** Make the missing Player Journals, player and character folders and follow renames. GM client only. */
export async function runFolderUpkeep({ game = globalThis.game, Folder = globalThis.Folder, onlyUserId = "" } = {}) {
  if (!game?.user?.isGM || !Folder?.create) return null;
  const plan = planFolderUpkeep(folderRecords(game), desiredFolders(game, onlyUserId), { rootName: t("RootName", "Player Journals") });
  if (upkeepIsIdle(plan)) return plan;
  let rootId = plan.root.id;
  if (plan.root.create) {
    const root = await Folder.create({ name: plan.root.name, type: "JournalEntry", sorting: "a", flags: flagData({ role: ROLES.ROOT }) });
    rootId = String(root?.id ?? "");
  }
  if (!rootId) return plan;
  for (const user of plan.users) {
    let userFolderId = user.id;
    if (user.create) {
      const created = await Folder.create({ name: user.name, type: "JournalEntry", folder: rootId, sorting: "a", flags: flagData({ role: ROLES.USER, userId: user.userId }) });
      userFolderId = String(created?.id ?? "");
    } else if (user.rename) await game.folders.get(user.id)?.update({ name: user.name });
    if (!userFolderId) continue;
    for (const character of user.characters) {
      if (character.create) {
        await Folder.create({ name: character.name, type: "JournalEntry", folder: userFolderId, sorting: "m",
          flags: flagData({ role: ROLES.CHARACTER, userId: user.userId, actorId: character.actorId }) });
      } else if (character.rename) await game.folders.get(character.id)?.update({ name: character.name });
    }
  }
  return plan;
}

// ---- GM side: answering players ----

/** Answer one player request on the active GM's client. Always resolves to { ok, result } or
 * { ok: false, code, key, fallback, data } so the player sees the message in their own language. */
export async function answerPlayerJournalQuery(data, requester, { game = globalThis.game, Folder = globalThis.Folder,
  JournalEntry = globalThis.JournalEntry, FilePicker = globalThis.foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker } = {}) {
  try {
    if (!game?.user?.isGM) throw journalError("FORBIDDEN", "Errors.NotGm", "Only a GM's client can do this.");
    if (!requester?.id || requester.isGM || !game.users?.get?.(requester.id)) throw journalError("FORBIDDEN", "Errors.NoUser", "The request did not say which player asked.");
    const action = String(data?.action ?? "");
    const handler = GM_ACTIONS[action];
    if (!handler) throw journalError("INVALID_INPUT", "Errors.UnknownAction", "Mobile Deck didn't recognise that request.");
    const result = await queue.run(requester.id, () => handler(data, requester, { game, Folder, JournalEntry, FilePicker }));
    return { ok: true, result: result ?? {} };
  } catch (raw) {
    const error = fromRule(raw);
    if (!error?.relay) console.error("Mobile Deck | Player journal request failed", raw);
    if (error?.relay) return { ok: false, code: error.code, ...error.relay };
    return { ok: false, code: "COMMAND_FAILED", key: "Errors.Failed", fallback: "That didn't work: {reason}", data: { reason: String(raw?.message ?? raw ?? "") } };
  }
}

const GM_ACTIONS = Object.freeze({
  // Make sure this player's character folder exists; returns its id.
  async ensure(data, requester, { game, Folder }) {
    const actor = game.actors?.get?.(String(data?.actorId ?? ""));
    if (!ownsCharacter(actor, requester)) throw journalError("FORBIDDEN", "Errors.NotCharacterOwner", "You don't own that character.");
    await queue.run(UPKEEP_KEY, () => runFolderUpkeep({ game, Folder, onlyUserId: requester.id }));
    const folder = findFolder(folderRecords(game), { role: ROLES.CHARACTER, userId: requester.id, actorId: actor.id });
    if (!folder) throw journalError("COMMAND_FAILED", "Errors.NoFolder", "Your journal folder couldn't be made.");
    return { folderId: folder.id };
  },
  async createFolder(data, requester, { game, Folder }) {
    const folders = folderRecords(game);
    const parent = ruled(() => ownedFolder(folders, String(data?.parentId ?? ""), requester.id, [ROLES.CHARACTER]));
    ruled(() => assertCanHoldFolder(parent));
    const name = ruled(() => cleanName(data?.name));
    const siblings = folders.filter(folder => folder.parentId === parent.id);
    const created = await Folder.create({ name, type: "JournalEntry", folder: parent.id, sorting: "m", sort: nextSort(siblings),
      flags: flagData({ role: ROLES.CUSTOM, userId: requester.id, actorId: parent.actorId }) });
    return { id: String(created?.id ?? "") };
  },
  async renameFolder(data, requester, { game }) {
    const folder = ruled(() => ownedFolder(folderRecords(game), String(data?.folderId ?? ""), requester.id, [ROLES.CUSTOM]));
    await game.folders.get(folder.id).update({ name: ruled(() => cleanName(data?.name)) });
    return { id: folder.id };
  },
  async moveFolder(data, requester, { game }) {
    const folders = folderRecords(game);
    const folder = ruled(() => ownedFolder(folders, String(data?.folderId ?? ""), requester.id, [ROLES.CUSTOM]));
    const target = folderMoveTargets(folders, folder, requester.id).find(entry => entry.id === String(data?.targetId ?? ""));
    if (!target) throw journalError("FORBIDDEN", "Errors.BadTarget", "It can't be moved there.");
    await game.folders.get(folder.id).update({ folder: target.id, sort: nextSort(folders.filter(entry => entry.parentId === target.id)),
      [`flags.${MODULE_ID}.${PLAYER_JOURNAL_FLAG}.actorId`]: target.actorId });
    return { id: folder.id };
  },
  async reorderFolder(data, requester, { game, Folder }) {
    const folders = folderRecords(game);
    const folder = ruled(() => ownedFolder(folders, String(data?.folderId ?? ""), requester.id, [ROLES.CUSTOM]));
    const siblings = folders.filter(entry => entry.parentId === folder.parentId && entry.role === ROLES.CUSTOM);
    const updates = reorderUpdates(siblings, folder.id, Number(data?.direction) < 0 ? -1 : 1);
    if (updates.length) await Folder.updateDocuments(updates.map(update => ({ _id: update.id, sort: update.sort })));
    return { id: folder.id };
  },
  // Delete a player folder and the player's journals in it. A journal the player doesn't own
  // (a GM put it there) moves up to the character folder instead of being deleted.
  async deleteFolder(data, requester, { game }) {
    const folders = folderRecords(game);
    const folder = ruled(() => ownedFolder(folders, String(data?.folderId ?? ""), requester.id, [ROLES.CUSTOM]));
    const kept = Array.from(game.journal ?? []).filter(journal => journalFolderId(journal) === folder.id && !permitted(journal, requester, "OWNER"));
    for (const journal of kept) await journal.update({ folder: folder.parentId });
    await game.folders.get(folder.id).delete({ deleteSubfolders: true, deleteContents: true });
    return { id: folder.id };
  },
  // A new journal only its player (and GMs) can open, with one empty text page to write in.
  async createJournal(data, requester, { game, JournalEntry }) {
    const folders = folderRecords(game);
    const folder = ruled(() => ownedFolder(folders, String(data?.folderId ?? ""), requester.id));
    const name = ruled(() => cleanName(data?.name));
    const siblings = Array.from(game.journal ?? []).filter(journal => journalFolderId(journal) === folder.id).map(journal => ({ sort: journal.sort }));
    const created = await JournalEntry.create({
      name, folder: folder.id, sort: nextSort(siblings),
      ownership: { default: NONE, [requester.id]: OWNER },
      pages: [{ name: t("FirstPageName", "Notes"), type: "text", sort: nextSort([]), text: { content: "", format: 1 } }]
    });
    return { id: String(created?.id ?? ""), pageId: String(created?.pages?.contents?.[0]?.id ?? Array.from(created?.pages ?? [])[0]?.id ?? "") };
  },
  // Store a picture the phone already shrank, in this world's folder for the player.
  async uploadImage(data, requester, { game, FilePicker }) {
    if (!FilePicker?.upload) throw journalError("CAPABILITY_UNAVAILABLE", "Errors.NoUpload", "Pictures can't be uploaded on this server.");
    const image = ruled(() => checkImageUpload(data?.dataUrl));
    const directory = `worlds/${game.world.id}/mobile-deck/player-journals/${requester.id}`;
    await ensureDirectory(FilePicker, directory);
    const blob = await (await fetch(String(data.dataUrl))).blob();
    const file = new File([blob], imageFileName(data?.name, image.extension, Date.now().toString(36)), { type: image.mime });
    const response = await FilePicker.upload("data", directory, file, {}, { notify: false });
    const path = String(response?.path ?? "");
    if (!path) throw journalError("COMMAND_FAILED", "Errors.UploadFailed", "The picture couldn't be saved on the server.");
    return { path };
  },
  // Player feedback (fork): a character portrait the phone already shrank, in this world's portraits folder for the player.
  async uploadPortrait(data, requester, { game, FilePicker }) {
    return { path: await storePortrait(data, requester, { game, FilePicker }) };
  }
});

// Save a shrunk portrait under worlds/<world>/mobile-deck/portraits/<user>; returns the stored path.
async function storePortrait(data, user, { game, FilePicker }) {
  if (!FilePicker?.upload) throw journalError("CAPABILITY_UNAVAILABLE", "Errors.NoUpload", "Pictures can't be uploaded on this server.");
  const image = ruled(() => checkImageUpload(data?.dataUrl));
  const directory = `worlds/${game.world.id}/mobile-deck/portraits/${user.id}`;
  await ensureDirectory(FilePicker, directory);
  const blob = await (await fetch(String(data.dataUrl))).blob();
  const file = new File([blob], imageFileName(data?.name || "portrait", image.extension, Date.now().toString(36)), { type: image.mime });
  const response = await FilePicker.upload("data", directory, file, {}, { notify: false });
  const path = String(response?.path ?? "");
  if (!path) throw journalError("COMMAND_FAILED", "Errors.UploadFailed", "The picture couldn't be saved on the server.");
  return path;
}

// Make each missing level of a data-folder path. Foundry refuses to make one that exists, which is fine.
async function ensureDirectory(FilePicker, path) {
  const parts = path.split("/");
  for (let depth = 3; depth <= parts.length; depth += 1) {
    const prefix = parts.slice(0, depth).join("/");
    try { await FilePicker.browse("data", prefix); continue; } catch { /* missing: make it */ }
    try { await FilePicker.createDirectory("data", prefix, { notify: false }); } catch { /* made meanwhile, or the upload will say */ }
  }
}

// ---- The gateway ----

/** Wire player journals into Foundry and give the phone screens what they need.
 * register() at init: the GM's client answers players and keeps folders tidy, even on desktop. */
export function createPlayerJournalGateway({ getGame = () => globalThis.game, getHooks = () => globalThis.Hooks,
  getConfig = () => globalThis.CONFIG, getFolderClass = () => globalThis.Folder, getJournalClass = () => globalThis.JournalEntry } = {}) {
  let upkeepTimer = null;

  const isActiveGm = () => {
    const game = getGame();
    return Boolean(game?.user?.isGM) && game.users?.activeGM?.id === game.user.id;
  };
  const scheduleUpkeep = () => {
    if (!isActiveGm() || upkeepTimer !== null) return;
    upkeepTimer = setTimeout(() => {
      upkeepTimer = null;
      queue.run(UPKEEP_KEY, () => runFolderUpkeep({ game: getGame(), Folder: getFolderClass() }))
        .catch(error => console.warn("Mobile Deck | Player journal folders could not be updated", error));
    }, UPKEEP_DELAY_MS);
  };

  // Ask the active GM's client to do something only a GM may do.
  async function ask(action, payload = {}, timeout = QUERY_TIMEOUT) {
    const game = getGame();
    const gm = game?.users?.activeGM;
    if (!gm) throw journalError("GM_OFFLINE", "Errors.NoGm", "A GM needs to be online for this. Writing in your journals still works.");
    const data = { ...payload, action };
    let response;
    if (gm.isSelf ?? gm.id === game.user?.id) response = await answerPlayerJournalQuery(data, game.user);
    else {
      try { response = await gm.query(PLAYER_JOURNAL_QUERY, data, { timeout }); }
      catch (error) { throw journalError("RELAY_FAILED", "Errors.Relay", "The GM's client did not answer. Try again in a moment.", {}, error); }
    }
    if (!response?.ok) {
      if (!response?.key) throw journalError("RELAY_FAILED", "Errors.Relay", "The GM's client did not answer. Try again in a moment.");
      throw journalError(response.code ?? "COMMAND_FAILED", response.key, response.fallback ?? "", response.data ?? {});
    }
    return response.result ?? {};
  }

  const me = () => getGame()?.user ?? null;
  const journal = id => getGame()?.journal?.get?.(String(id ?? "")) ?? null;
  const ownedJournal = id => {
    const entry = journal(id);
    if (!entry || !permitted(entry, me(), "OWNER")) throw journalError("FORBIDDEN", "Errors.JournalGone", "That journal is no longer yours to change.");
    return entry;
  };
  const ownedPage = (journalId, pageId) => {
    const entry = ownedJournal(journalId);
    const page = entry.pages?.get?.(String(pageId ?? ""));
    if (!page || !permitted(page, me(), "OWNER")) throw journalError("FORBIDDEN", "Errors.PageGone", "That page is no longer there.");
    return { entry, page };
  };
  const journalRecord = entry => ({ id: String(entry.id), name: String(entry.name ?? ""), folderId: journalFolderId(entry), sort: Number(entry.sort) || 0 });
  // Journals this player can see in their own folders.
  const visibleJournals = folderIds => Array.from(getGame()?.journal ?? [])
    .filter(entry => folderIds.has(journalFolderId(entry)) && permitted(entry, me(), "OBSERVER"));
  const pageRecord = page => Object.freeze({
    id: String(page.id), name: String(page.name ?? ""), type: String(page.type ?? "text"), sort: Number(page.sort) || 0,
    content: String(page.text?.content ?? ""), src: String(page.src ?? ""), caption: String(page.image?.caption ?? ""),
    canEdit: permitted(page, me(), "OWNER")
  });

  const api = {
    /** Every client: the GM's answers players; the active GM keeps folders up to date. */
    register() {
      const config = getConfig();
      if (config?.queries) config.queries[PLAYER_JOURNAL_QUERY] = (data, context) => answerPlayerJournalQuery(data, context?.user);
      const hooks = getHooks();
      hooks?.once?.("ready", () => {
        if (!getGame()?.user?.isGM) return;
        scheduleUpkeep();
        hooks.on("createActor", scheduleUpkeep);
        hooks.on("updateActor", (_actor, changes) => { if (changes && ("ownership" in changes || "name" in changes || "type" in changes)) scheduleUpkeep(); });
        hooks.on("createUser", scheduleUpkeep);
        hooks.on("updateUser", (_user, changes) => { if (changes && ("name" in changes || "role" in changes || "character" in changes)) scheduleUpkeep(); });
        // A GM who takes over as the active GM catches up.
        hooks.on("userConnected", () => scheduleUpkeep());
      });
      return true;
    },

    /** Player journals are for players; GMs read every one in the Library. */
    available: () => Boolean(me()) && !me().isGM,

    /** The characters this player keeps notes for. */
    characters() {
      const game = getGame();
      const user = me();
      if (!user || user.isGM) return [];
      const folders = folderRecords(game);
      return playerCharacters(game, user).map(actor => Object.freeze({
        actorId: String(actor.id), name: String(actor.name ?? ""), img: String(actor.img ?? ""),
        folderId: findFolder(folders, { role: ROLES.CHARACTER, userId: user.id, actorId: actor.id })?.id ?? ""
      }));
    },

    /** The character's folder id, asking the GM to make it when it's missing. */
    async characterFolder(actorId) {
      const user = me();
      const existing = findFolder(folderRecords(getGame()), { role: ROLES.CHARACTER, userId: user?.id, actorId: String(actorId ?? "") });
      if (existing) return existing.id;
      return String((await ask("ensure", { actorId: String(actorId ?? "") })).folderId ?? "");
    },

    /** A character's folders and journals, with each journal's pages. Null when the folder is gone. */
    tree(characterFolderId) {
      const folders = folderRecords(getGame());
      const ids = new Set([characterFolderId, ...folders.filter(folder => folder.parentId === characterFolderId).map(folder => folder.id)]);
      const journals = visibleJournals(ids).map(entry => ({ ...journalRecord(entry), pageCount: Array.from(entry.pages ?? []).filter(page => permitted(page, me(), "OBSERVER")).length }));
      return buildCharacterTree(folders, journals, characterFolderId);
    },

    folder: id => folderRecords(getGame()).find(folder => folder.id === id) ?? null,

    /** One journal with its pages in order, or null. */
    journal(journalId) {
      const entry = journal(journalId);
      if (!entry || !permitted(entry, me(), "OBSERVER")) return null;
      const pages = Array.from(entry.pages ?? []).filter(page => permitted(page, me(), "OBSERVER")).map(pageRecord).sort(bySort);
      return Object.freeze({ ...journalRecord(entry), canEdit: permitted(entry, me(), "OWNER"), pages: Object.freeze(pages) });
    },

    page(journalId, pageId) {
      const entry = journal(journalId);
      const page = entry?.pages?.get?.(String(pageId ?? ""));
      return page && permitted(page, me(), "OBSERVER") ? pageRecord(page) : null;
    },

    /** Where a folder or journal may move: [{ id, name, role }]. */
    moveTargets(kind, id) {
      const folders = folderRecords(getGame());
      const userId = me()?.id;
      const label = target => Object.freeze({ id: target.id, name: target.role === ROLES.CUSTOM
        ? `${folders.find(folder => folder.id === target.parentId)?.name ?? ""} › ${target.name}` : target.name, role: target.role });
      if (kind === "folder") return folderMoveTargets(folders, folders.find(folder => folder.id === id), userId).map(label);
      const entry = journal(id);
      return entry ? journalMoveTargets(folders, journalRecord(entry), userId).map(label) : [];
    },

    // Things only the GM's client may do.
    createFolder: (parentId, name) => ask("createFolder", { parentId, name: ruled(() => cleanName(name)) }),
    renameFolder: (folderId, name) => ask("renameFolder", { folderId, name: ruled(() => cleanName(name)) }),
    moveFolder: (folderId, targetId) => ask("moveFolder", { folderId, targetId }),
    reorderFolder: (folderId, direction) => ask("reorderFolder", { folderId, direction }),
    deleteFolder: folderId => ask("deleteFolder", { folderId }),
    createJournal: (folderId, name) => ask("createJournal", { folderId, name: ruled(() => cleanName(name)) }),
    uploadImage: (dataUrl, name) => ask("uploadImage", { dataUrl, name: String(name ?? "").slice(0, 100) }, UPLOAD_TIMEOUT),
    // Player feedback (fork): a user who may upload stores the portrait itself; anyone else asks the GM's client.
    async uploadPortrait(dataUrl, name) {
      const game = getGame();
      const data = { dataUrl, name: String(name ?? "").slice(0, 100) };
      if (game?.user?.isGM || game?.user?.can?.("FILES_UPLOAD")) {
        const FilePicker = globalThis.foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
        return { path: await storePortrait(data, game.user, { game, FilePicker }) };
      }
      return ask("uploadPortrait", data, UPLOAD_TIMEOUT);
    },
    canBrowseImages: () => {
      const game = getGame();
      return Boolean(game?.user?.isGM || game?.user?.can?.("FILES_BROWSE"));
    },
    // Foundry's own file browser, images only; resolves to the chosen path, or null when closed.
    browseImages(current = "") {
      const FilePicker = globalThis.foundry?.applications?.apps?.FilePicker?.implementation ?? globalThis.FilePicker;
      if (!FilePicker) return Promise.resolve(null);
      return new Promise(resolve => {
        let settled = false;
        const settle = value => { if (!settled) { settled = true; resolve(value); } };
        const picker = new FilePicker({ type: "image", current: String(current ?? ""), callback: path => settle(String(path ?? "") || null) });
        try { picker.addEventListener?.("close", () => setTimeout(() => settle(null), 0)); } catch { /* older picker */ }
        Promise.resolve(picker.render({ force: true })).catch(() => settle(null));
      });
    },

    // Things a journal's owner does directly.
    async renameJournal(journalId, name) {
      await ownedJournal(journalId).update({ name: ruled(() => cleanName(name)) });
    },
    async deleteJournal(journalId) {
      await ownedJournal(journalId).delete();
    },
    async moveJournal(journalId, targetId) {
      const entry = ownedJournal(journalId);
      const folders = folderRecords(getGame());
      const target = journalMoveTargets(folders, journalRecord(entry), me()?.id).find(folder => folder.id === targetId);
      if (!target) throw journalError("FORBIDDEN", "Errors.BadTarget", "It can't be moved there.");
      const siblings = visibleJournals(new Set([target.id])).map(journalRecord);
      await entry.update({ folder: target.id, sort: nextSort(siblings) });
    },
    async reorderJournal(journalId, direction) {
      const entry = ownedJournal(journalId);
      const folderId = journalFolderId(entry);
      const siblings = visibleJournals(new Set([folderId])).filter(sibling => permitted(sibling, me(), "OWNER")).map(journalRecord);
      const updates = reorderUpdates(siblings, entry.id, direction < 0 ? -1 : 1);
      if (updates.length) await getJournalClass().updateDocuments(updates.map(update => ({ _id: update.id, sort: update.sort })));
    },
    async createPage(journalId, { type = "text", name = "", src = "", caption = "" } = {}) {
      const entry = ownedJournal(journalId);
      const pageName = ruled(() => cleanName(name || t(type === "image" ? "NewImagePage" : "NewTextPage", type === "image" ? "Picture" : "New page")));
      const sort = nextSort(Array.from(entry.pages ?? []).map(page => ({ sort: page.sort })));
      const data = type === "image"
        ? { name: pageName, type: "image", sort, src: String(src), image: { caption: String(caption ?? "").slice(0, 500) } }
        : { name: pageName, type: "text", sort, text: { content: "", format: 1 } };
      const [page] = await entry.createEmbeddedDocuments("JournalEntryPage", [data]);
      return String(page?.id ?? "");
    },
    async renamePage(journalId, pageId, name) {
      const { page } = ownedPage(journalId, pageId);
      await page.update({ name: ruled(() => cleanName(name)) });
    },
    async deletePage(journalId, pageId) {
      const { page } = ownedPage(journalId, pageId);
      await page.delete();
    },
    async reorderPage(journalId, pageId, direction) {
      const { entry, page } = ownedPage(journalId, pageId);
      const siblings = Array.from(entry.pages ?? []).map(sibling => ({ id: String(sibling.id), name: sibling.name, sort: sibling.sort }));
      const updates = reorderUpdates(siblings, page.id, direction < 0 ? -1 : 1);
      if (updates.length) await entry.updateEmbeddedDocuments("JournalEntryPage", updates.map(update => ({ _id: update.id, sort: update.sort })));
    },
    async saveText(journalId, pageId, html) {
      const { page } = ownedPage(journalId, pageId);
      await page.update({ "text.content": String(html ?? ""), "text.format": 1 });
    },
    async saveCaption(journalId, pageId, caption) {
      const { page } = ownedPage(journalId, pageId);
      await page.update({ "image.caption": String(caption ?? "").slice(0, 500) });
    },

    /** Call `listener(hook, document, changes, userId)` when anything a player journal screen shows changes. */
    subscribe(listener) {
      const hooks = getHooks();
      const names = ["createFolder", "updateFolder", "deleteFolder", "createJournalEntry", "updateJournalEntry", "deleteJournalEntry",
        "createJournalEntryPage", "updateJournalEntryPage", "deleteJournalEntryPage"];
      const ids = names.map(name => {
        const handler = (document, second, third, fourth) => {
          // update hooks pass (document, changes, options, userId); create/delete pass (document, options, userId).
          const isUpdate = name.startsWith("update");
          try { listener(name, document, isUpdate ? second : null, String((isUpdate ? fourth : third) ?? "")); }
          catch (error) { console.error("Mobile Deck | Player journal screen refresh failed", error); }
        };
        return [name, hooks?.on?.(name, handler)];
      });
      return () => { for (const [name, id] of ids) hooks?.off?.(name, id); };
    },

    currentUserId: () => String(me()?.id ?? ""),
    gmOnline: () => Boolean(getGame()?.users?.activeGM),
    characterFolderOf: folderId => {
      const folders = folderRecords(getGame());
      return characterFolderOf(folders, folders.find(folder => folder.id === folderId))?.id ?? "";
    }
  };
  return Object.freeze(api);
}
