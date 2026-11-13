/**
 * Character Builder (fork): make the character sheet's book badge a real Prepare / Unprepare toggle.
 *
 * Mobile Deck draws a spell's preparation state as a status image (a book icon) and offers
 * "Prepare" only from the long-press menu, so tapping the book did nothing. For spells VE says
 * can be prepared (item.canPrepare), the badge becomes a button that runs VE's own
 * SET_SPELL_PREPARED command, which is the same command and checks as the menu.
 * Unprepared spells stay muted (black and white), as VE designs them; preparing restores colour.
 */
import { node } from "../../ui/dom.mjs";
import { ACTOR_COMMANDS } from "../../kernel/command-names.mjs";
import { localizedText } from "../../ui/localized-text.mjs";
import { characterErrorMessage, notifyCharacter } from "../characters/notifications.mjs";
import { ensureBuilderStyles } from "./builder-styles.mjs";

/**
 * @param {HTMLElement|null} cluster  The row's .ve-item-status-cluster (may be null).
 * @param {object} item               VE's spell view record (type, canPrepare, preparationState, id, name).
 * @param {object} commands           The sheet's command surface (execute, localize).
 * @param {object} scope              The row's render scope.
 * @param {string} actorSourceUuid    The actor source UUID the sheet's commands expect.
 */
export function withPrepareToggle(cluster, item, commands, scope, actorSourceUuid) {
  if (!cluster || item?.type !== "spell" || !item.canPrepare) return cluster;
  const badge = cluster.querySelector(".ve-item-status.is-preparation");
  if (!badge) return cluster;
  ensureBuilderStyles();
  const prepared = Number(item.preparationState) === 1;
  const label = prepared
    ? localizedText(commands.localize, "VEMOBILE.Builder.Sheet.Unprepare", "Unprepare {name}", { name: item.name })
    : localizedText(commands.localize, "VEMOBILE.Builder.Sheet.Prepare", "Prepare {name}", { name: item.name });
  const button = node("button", {
    className: `${badge.className} ve-prepare-toggle`,
    attrs: { type: "button", "aria-pressed": String(prepared), "aria-label": label, title: label },
    on: {
      // Inside the row's <summary>: don't expand the row, just toggle preparation.
      click: async event => {
        event.preventDefault();
        event.stopPropagation();
        if (button.disabled) return;
        button.disabled = true;
        try {
          await commands.execute(ACTOR_COMMANDS.SET_SPELL_PREPARED, { actorSourceUuid, itemId: item.id, prepared: prepared ? 0 : 1 });
          globalThis.navigator?.vibrate?.(5);
        } catch (error) {
          button.disabled = false;
          if (!scope.disposed) notifyCharacter(commands, actorSourceUuid, characterErrorMessage(commands, error,
            localizedText(commands.localize, "VEMOBILE.Builder.Sheet.PrepareFailed", "{name} couldn't be prepared.", { name: item.name })));
        }
      },
      // Keep the row's long-press menu from starting on the badge.
      pointerdown: event => event.stopPropagation()
    }
  }, scope);
  button.append(...badge.childNodes);
  badge.replaceWith(button);
  return cluster;
}
