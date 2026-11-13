/**
 * Record for Mobile Deck's own item detail window (spells in the picker). Shared by the
 * level-up and creation controllers.
 */
import { itemDetailRecord } from "../actor-view.mjs";

export async function spellDetails(uuid) {
  const doc = uuid ? await globalThis.fromUuid(uuid).catch(() => null) : null;
  if (!doc) return null;
  const game = globalThis.game;
  return { id: doc.id, name: doc.name, img: doc.img, type: doc.type,
    typeLabel: game.i18n.localize(globalThis.CONFIG.Item.typeLabels?.[doc.type] ?? doc.type), level: Number(doc.system.level) || 0,
    source: doc.system.source?.label || doc.system.source?.book || "", ...itemDetailRecord(doc) };
}
