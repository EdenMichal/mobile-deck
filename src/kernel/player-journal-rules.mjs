/** Pure rules for player journals: each player's private notes, one folder per character.
 * No Foundry globals here. The gateway (foundry/player-journal-gateway.mjs) turns Folders and
 * JournalEntries into the plain records below, so every decision is unit tested.
 *
 * Layout, found by flags and never by name:
 *   Player Journals            role "root"
 *   └─ <player>                role "user",      userId
 *      └─ <character>          role "character", userId, actorId
 *         └─ <player folder>   role "custom",    userId, actorId
 * Foundry allows four folder levels (CONST.FOLDER_MAX_DEPTH), so player folders never nest.
 *
 * Folder record: { id, name, parentId, sort, role, userId, actorId }.
 * Journal record: { id, name, folderId, sort }. */

export const PLAYER_JOURNAL_FLAG = "playerJournal";
export const ROLES = Object.freeze({ ROOT: "root", USER: "user", CHARACTER: "character", CUSTOM: "custom" });
export const MAX_NAME_LENGTH = 100;
export const MAX_IMAGE_EDGE = 2048;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SORT_STEP = 100_000;

/** A failure the player's client can show in its own language. */
export class PlayerJournalRuleError extends Error {
  constructor(code, key, fallback, data = {}) {
    super(fallback);
    this.name = "PlayerJournalRuleError";
    this.code = code;
    this.key = key;
    this.fallback = fallback;
    this.data = data;
  }
}
const refuse = (code, key, fallback, data) => { throw new PlayerJournalRuleError(code, key, fallback, data); };

/** Read a folder's player-journal flag into { role, userId, actorId }, or null when it isn't one of ours. */
export function readFolderFlag(flag) {
  if (!flag || typeof flag !== "object") return null;
  const role = String(flag.role ?? "");
  if (!Object.values(ROLES).includes(role)) return null;
  const userId = String(flag.userId ?? "");
  const actorId = String(flag.actorId ?? "");
  if (role !== ROLES.ROOT && !userId) return null;
  if ((role === ROLES.CHARACTER || role === ROLES.CUSTOM) && !actorId) return null;
  return Object.freeze({ role, userId, actorId });
}

/** Trim and collapse whitespace; refuse empty or over-long names. */
export function cleanName(value) {
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!name) refuse("INVALID_INPUT", "Errors.NameEmpty", "Give it a name.");
  if (name.length > MAX_NAME_LENGTH) refuse("INVALID_INPUT", "Errors.NameLong", "Names can be at most {max} characters.", { max: MAX_NAME_LENGTH });
  return name;
}

/** Find our folder for a role and owner among folder records. */
export function findFolder(folders, { role, userId = "", actorId = "" }) {
  return (folders ?? []).find(folder => folder?.role === role
    && (role === ROLES.ROOT || folder.userId === userId)
    && (role !== ROLES.CHARACTER || folder.actorId === actorId)) ?? null;
}

/** Work out which folders the GM's client must create or rename so that every player has a folder
 * and every character they own has one inside it.
 * desired: [{ userId, name, characters: [{ actorId, name }] }]
 * Returns { root: { create, name }, users: [{ userId, id, create, rename, name, characters: [{ actorId, id, create, rename, name }] }] }.
 * Existing folders are matched by flag; a renamed player or character renames its folder. Nothing is ever deleted. */
export function planFolderUpkeep(folders, desired, { rootName = "Player Journals" } = {}) {
  const root = findFolder(folders, { role: ROLES.ROOT });
  const users = [];
  for (const user of desired ?? []) {
    if (!user?.userId || !(user.characters ?? []).length) continue;
    const userFolder = root ? (folders ?? []).find(folder => folder.role === ROLES.USER && folder.userId === user.userId && folder.parentId === root.id) ?? null : null;
    const userName = safeLabel(user.name, "Player");
    const characters = (user.characters ?? []).filter(character => character?.actorId).map(character => {
      const existing = userFolder ? (folders ?? []).find(folder => folder.role === ROLES.CHARACTER && folder.userId === user.userId
        && folder.actorId === character.actorId && folder.parentId === userFolder.id) ?? null : null;
      const name = safeLabel(character.name, "Character");
      return Object.freeze({ actorId: character.actorId, id: existing?.id ?? "", create: !existing, rename: Boolean(existing && existing.name !== name), name });
    });
    users.push(Object.freeze({ userId: user.userId, id: userFolder?.id ?? "", create: !userFolder, rename: Boolean(userFolder && userFolder.name !== userName),
      name: userName, characters: Object.freeze(characters) }));
  }
  return Object.freeze({ root: Object.freeze({ id: root?.id ?? "", create: !root && users.length > 0, name: rootName }), users: Object.freeze(users) });
}

/** True when the upkeep plan has nothing to do. */
export function upkeepIsIdle(plan) {
  return !plan.root.create && plan.users.every(user => !user.create && !user.rename && user.characters.every(character => !character.create && !character.rename));
}

// A display name that is never empty and never longer than Foundry's field is useful for.
function safeLabel(value, fallback) {
  const name = String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, MAX_NAME_LENGTH);
  return name || fallback;
}

/** The folder a request names, provided it is the asking player's character or player folder.
 * allowed: the roles this request may target. */
export function ownedFolder(folders, folderId, userId, allowed = [ROLES.CHARACTER, ROLES.CUSTOM]) {
  const folder = (folders ?? []).find(entry => entry?.id === folderId) ?? null;
  if (!folder || !folder.role) refuse("TARGET_MISSING", "Errors.FolderMissing", "That folder is no longer there.");
  if (!userId || folder.userId !== userId) refuse("FORBIDDEN", "Errors.NotYours", "That isn't one of your folders.");
  if (!allowed.includes(folder.role)) refuse("FORBIDDEN", "Errors.WrongFolder", "That can't be done to this folder.");
  // The chain above must be this player's own: character inside user inside root.
  const character = folder.role === ROLES.CUSTOM ? parentOf(folders, folder) : folder;
  if (folder.role === ROLES.CUSTOM && (character?.role !== ROLES.CHARACTER || character.userId !== userId || character.actorId !== folder.actorId)) {
    refuse("FORBIDDEN", "Errors.NotYours", "That isn't one of your folders.");
  }
  const user = parentOf(folders, character);
  if (user?.role !== ROLES.USER || user.userId !== userId || parentOf(folders, user)?.role !== ROLES.ROOT) {
    refuse("FORBIDDEN", "Errors.NotYours", "That isn't one of your folders.");
  }
  return folder;
}

function parentOf(folders, folder) {
  if (!folder?.parentId) return null;
  return (folders ?? []).find(entry => entry?.id === folder.parentId) ?? null;
}

/** The character folder above a character or player folder. */
export function characterFolderOf(folders, folder) {
  if (folder?.role === ROLES.CHARACTER) return folder;
  if (folder?.role === ROLES.CUSTOM) {
    const parent = parentOf(folders, folder);
    return parent?.role === ROLES.CHARACTER ? parent : null;
  }
  return null;
}

/** New player folders go directly inside a character folder: never deeper (Foundry's 4-level cap). */
export function assertCanHoldFolder(parent) {
  if (parent?.role !== ROLES.CHARACTER) refuse("INVALID_INPUT", "Errors.FolderDepth", "Folders can only be made directly inside a character's journals.");
}

/** Where a player's folder may move: any of that player's character folders except its current one. */
export function folderMoveTargets(folders, folder, userId) {
  if (folder?.role !== ROLES.CUSTOM) return [];
  return characterFolders(folders, userId).filter(target => target.id !== folder.parentId);
}

/** Where a journal may move: any of the player's character or player folders except its current one. */
export function journalMoveTargets(folders, journal, userId) {
  const characters = characterFolders(folders, userId);
  const targets = [];
  for (const character of characters) {
    targets.push(character);
    for (const custom of (folders ?? []).filter(folder => folder.role === ROLES.CUSTOM && folder.parentId === character.id && folder.userId === userId)
      .sort(bySort)) targets.push(custom);
  }
  return targets.filter(target => target.id !== journal?.folderId);
}

// This player's character folders, in their sort order, inside their own player folder.
function characterFolders(folders, userId) {
  const root = findFolder(folders, { role: ROLES.ROOT });
  const user = root ? (folders ?? []).find(folder => folder.role === ROLES.USER && folder.userId === userId && folder.parentId === root.id) : null;
  if (!user) return [];
  return (folders ?? []).filter(folder => folder.role === ROLES.CHARACTER && folder.userId === userId && folder.parentId === user.id).sort(bySort);
}

/** One character's notes as a tree: { folder, folders: [{ folder, journals }], journals }. */
export function buildCharacterTree(folders, journals, characterFolderId) {
  const character = (folders ?? []).find(folder => folder.id === characterFolderId && folder.role === ROLES.CHARACTER) ?? null;
  if (!character) return null;
  const inFolder = id => (journals ?? []).filter(journal => journal.folderId === id).sort(bySort);
  const children = (folders ?? []).filter(folder => folder.parentId === character.id && folder.role === ROLES.CUSTOM).sort(bySort)
    .map(folder => Object.freeze({ folder, journals: Object.freeze(inFolder(folder.id)) }));
  return Object.freeze({ folder: character, folders: Object.freeze(children), journals: Object.freeze(inFolder(character.id)) });
}

/** Manual order: by sort, then name. */
export function bySort(left, right) {
  return (Number(left?.sort) || 0) - (Number(right?.sort) || 0) || String(left?.name ?? "").localeCompare(String(right?.name ?? ""));
}

/** Move one entry up (-1) or down (+1) among its siblings. Returns the sort updates to write,
 * [{ id, sort }], renumbering the whole list so ties and gaps never block a move. Empty when it can't move. */
export function reorderUpdates(siblings, id, direction) {
  const list = [...(siblings ?? [])].sort(bySort);
  const index = list.findIndex(entry => entry.id === id);
  const target = index + (direction < 0 ? -1 : 1);
  if (index < 0 || target < 0 || target >= list.length) return [];
  [list[index], list[target]] = [list[target], list[index]];
  return list.map((entry, position) => ({ id: entry.id, sort: (position + 1) * SORT_STEP }))
    .filter(update => update.sort !== (Number(list.find(entry => entry.id === update.id)?.sort) || 0));
}

/** A sort value that puts a new entry after its siblings. */
export function nextSort(siblings) {
  const highest = Math.max(0, ...(siblings ?? []).map(entry => Number(entry?.sort) || 0));
  return highest + SORT_STEP;
}

/** Fit an image inside max × max, keeping its shape. */
export function fitImage(width, height, max = MAX_IMAGE_EDGE) {
  const w = Math.max(1, Math.round(Number(width) || 0));
  const h = Math.max(1, Math.round(Number(height) || 0));
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

const IMAGE_TYPES = Object.freeze({ "image/webp": "webp", "image/jpeg": "jpg", "image/png": "png" });

/** Check an image the phone sends for upload: a data URL of an allowed type within the size cap.
 * Returns { mime, extension, bytes } (bytes estimated from the base64 length). */
export function checkImageUpload(dataUrl) {
  const match = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(String(dataUrl ?? ""));
  if (!match) refuse("INVALID_INPUT", "Errors.ImageType", "That picture couldn't be read. Try a JPEG, PNG or WebP image.");
  const bytes = Math.floor(match[2].length * 3 / 4) - (match[2].endsWith("==") ? 2 : match[2].endsWith("=") ? 1 : 0);
  if (bytes > MAX_IMAGE_BYTES) refuse("INVALID_INPUT", "Errors.ImageSize", "That picture is too large, even after shrinking it.");
  return Object.freeze({ mime: match[1], extension: IMAGE_TYPES[match[1]], bytes });
}

/** A file name for an uploaded picture: safe characters, unique enough per upload. */
export function imageFileName(baseName, extension, stamp) {
  const stem = String(baseName ?? "").normalize("NFKD").replace(/[^\w-]+/gu, "-").replace(/-+/gu, "-").replace(/^-|-$/gu, "").slice(0, 40).toLowerCase() || "picture";
  return `${stem}-${String(stamp ?? "").replace(/[^\w]/gu, "") || "0"}.${extension}`;
}

// Writing screen HTML policy. The DOM walk lives in the browser code; these decide what survives.
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "frame", "frameset", "noscript", "template", "link", "meta", "base", "form", "input", "button", "textarea", "select", "option", "svg", "math"]);

/** Elements removed together with their content. */
export function dropsElement(tagName) {
  return DROP_WITH_CONTENT.has(String(tagName ?? "").toLowerCase());
}

/** Attributes removed from any element: event handlers, inline style, and script or data URLs in links. */
export function dropsAttribute(name, value) {
  const attribute = String(name ?? "").toLowerCase();
  if (attribute.startsWith("on") || attribute === "style" || attribute === "srcdoc" || attribute === "contenteditable") return true;
  if (["href", "src", "xlink:href", "action", "formaction"].includes(attribute)) {
    const url = String(value ?? "").replace(/[\u0000- ]/gu, "").toLowerCase();
    return url.startsWith("javascript:") || url.startsWith("vbscript:") || (url.startsWith("data:") && !url.startsWith("data:image/"));
  }
  return false;
}

/** Text a page holds when it has no visible words, so an emptied page saves as "". */
export function isBlankHtml(html) {
  return !String(html ?? "").replace(/<br\s*\/?>/giu, "").replace(/<\/?(?:p|div)[^>]*>/giu, "").replace(/&nbsp;/gu, "").trim();
}
