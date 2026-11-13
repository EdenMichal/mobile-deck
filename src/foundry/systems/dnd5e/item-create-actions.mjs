/**
 * Player item creation (spec 2026-11-13 §2), Foundry side: the form's choices read from CONFIG.DND5E, and the
 * ACTOR_COMMANDS.CREATE_ITEM handler. The command gateway has already re-resolved the Actor and checked OWNER;
 * this re-validates the draft with the same pure rules the form uses, creates the embedded Item directly
 * (no GM approval) and whispers the GMs a one-line note.
 */
import { localizeFoundry } from "../../localization.mjs";
import { CommandError } from "../../command-support.mjs";
import { CREATABLE_ITEM_TYPES, escapeHtml, itemCreateErrorMessage, itemDataFromDraft, typeOption } from "./item-create-rules.mjs";
import { ITEM_ICON_PRESETS } from "./item-create-icons.mjs";

const FALLBACK_DIE_FACES = Object.freeze([4, 6, 8, 10, 12, 20]);

/** Characters only (not groups, vehicles or NPCs), and only when the Actor can hold embedded Items. */
export function canCreateItems(actor) {
  return actor?.type === "character" && typeof actor.createEmbeddedDocuments === "function";
}

/**
 * The form's choices as plain records, labels already localized. `config`, `localize` and `baseItemName` are injectable
 * for tests. Types the running system doesn't define are left out.
 */
export function readItemCreatorOptions(config = globalThis.CONFIG, localize = key => globalThis.game?.i18n?.localize?.(key) ?? key,
  baseItemName = defaultBaseItemName) {
  const dnd5e = config?.DND5E ?? {};
  const text = entry => {
    const key = typeof entry === "string" ? entry : entry?.label;
    return key ? String(localize(key) ?? key) : "";
  };
  const list = (record, { sort = false } = {}) => {
    const entries = Object.entries(record ?? {}).map(([value, entry]) => Object.freeze({ value, label: text(entry) || value }));
    if (sort) entries.sort((a, b) => a.label.localeCompare(b.label));
    return Object.freeze(entries);
  };
  const defined = type => !config?.Item?.dataModels || Object.hasOwn(config.Item.dataModels, type);
  const weaponProperties = [...(dnd5e.validProperties?.weapon ?? [])].map(String)
    .map(value => Object.freeze({ value, label: text(dnd5e.itemProperties?.[value]) || value }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return Object.freeze({
    types: Object.freeze(CREATABLE_ITEM_TYPES.filter(defined).map(value => Object.freeze({
      value,
      label: text(config?.Item?.typeLabels?.[value] ?? `TYPES.Item.${value}`) || value,
      img: String(dnd5e.defaultArtwork?.Item?.[value] ?? "")
    }))),
    // Siege weapons belong on vehicles; a player's weapon is one of the others.
    weaponTypes: Object.freeze(list(dnd5e.weaponTypes).filter(entry => entry.value !== "siege")),
    weaponProperties: Object.freeze(weaponProperties),
    damageTypes: list(dnd5e.damageTypes, { sort: true }),
    dieFaces: Object.freeze((Array.isArray(dnd5e.dieSteps) ? dnd5e.dieSteps : FALLBACK_DIE_FACES).filter(face => face <= 20)),
    equipmentTypes: list(dnd5e.equipmentTypes, { sort: true }),
    armorTypes: Object.freeze(Object.keys(dnd5e.armorTypes ?? {})),
    consumableTypes: list(dnd5e.consumableTypes, { sort: true }),
    toolTypes: list(dnd5e.toolTypes, { sort: true }),
    lootTypes: list(dnd5e.lootTypes, { sort: true }),
    currencies: Object.freeze(Object.entries(dnd5e.currencies ?? {}).map(([value, entry]) => Object.freeze({
      value, label: text(entry?.abbreviation ?? entry?.label) || value.toUpperCase()
    }))),
    defaultCurrency: String(dnd5e.defaultCurrency ?? "gp"),
    // CONFIG.DND5E.tools has no labels: dnd5e names each base tool from its compendium entry (Trait.getBaseItem).
    baseTools: Object.freeze(Object.entries(dnd5e.tools ?? {})
      .map(([value, entry]) => Object.freeze({ value, label: baseItemName(entry?.id) || titleCase(value), ...(entry?.ability ? { ability: String(entry.ability) } : {}) }))
      .sort((a, b) => a.label.localeCompare(b.label))),
    icons: ITEM_ICON_PRESETS
  });
}

// The compendium index name of a base item, synchronously (dnd5e's indexOnly lookup never returns a promise).
function defaultBaseItemName(uuid) {
  if (!uuid) return "";
  try { return String(globalThis.dnd5e?.documents?.Trait?.getBaseItem?.(uuid, { indexOnly: true })?.name ?? ""); }
  catch { return ""; }
}

function titleCase(key) {
  return String(key).replace(/([a-z])([A-Z])/gu, "$1 $2").replace(/^./u, character => character.toUpperCase());
}

/** The command's localized refusal for an invalid draft: the first field's message. */
export function draftErrorText(errors) {
  const [field, code] = Object.entries(errors ?? {})[0] ?? ["type", "choice"];
  const { key, fallback } = itemCreateErrorMessage(field, code);
  return localizeFoundry(key, fallback);
}

/** ACTOR_COMMANDS.CREATE_ITEM: create one embedded Item from the form's draft, then tell the GMs. */
export async function createActorItem(actor, payload, context = {}) {
  if (!canCreateItems(actor)) {
    throw new CommandError("CAPABILITY_UNAVAILABLE", localizeFoundry("VEMOBILE.ItemCreate.Unavailable", "Items can't be created on this actor."));
  }
  const options = readItemCreatorOptions();
  // A fresh ID for a consumable's use activity (dnd5e keys activities by a 16-character random ID).
  const activityId = globalThis.foundry?.utils?.randomID?.() ?? "";
  const result = itemDataFromDraft(payload?.draft, options, { activityId });
  if (!result.ok) throw new CommandError("INVALID_INPUT", draftErrorText(result.errors));
  context.assertCurrent?.();
  const [item] = await actor.createEmbeddedDocuments("Item", [result.data]) ?? [];
  if (!item) throw new CommandError("COMMAND_FAILED", localizeFoundry("VEMOBILE.ItemCreate.Failed", "The item could not be created."));
  const typeLabel = typeOption(result.data.type, options)?.label ?? result.data.type;
  await whisperItemCreated(actor, item, typeLabel).catch(error => console.warn("Mobile Deck | Item creation note failed", error));
  return Object.freeze({ itemId: String(item.id ?? ""), itemName: String(item.name ?? result.data.name) });
}

/** "<Player> created <item> (<type>) on <Actor>.", whispered to every GM. Nothing is sent when the world has no GM. */
export async function whisperItemCreated(actor, item, typeLabel, game = globalThis.game, ChatMessage = globalThis.ChatMessage) {
  const whisper = Array.from(game?.users ?? []).filter(user => user?.isGM).map(user => user.id).filter(Boolean);
  if (!whisper.length || typeof ChatMessage?.create !== "function") return null;
  const line = localizeFoundry("VEMOBILE.ItemCreate.ChatNote", "{user} created {item} ({type}) on {actor}.", {
    user: escapeHtml(game.user?.name ?? ""), item: escapeHtml(item?.name ?? ""), type: escapeHtml(typeLabel), actor: escapeHtml(actor?.name ?? "")
  });
  const speaker = typeof ChatMessage.getSpeaker === "function" ? ChatMessage.getSpeaker({ actor }) : { alias: game.user?.name ?? "" };
  return ChatMessage.create({ speaker, whisper, content: `<p class="ve-item-created-note">${line}</p>` });
}
