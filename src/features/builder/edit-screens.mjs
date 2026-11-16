/**
 * Change choices (D&D Beyond-style edits; spec 2026-11-16): the builder-owned step screens an edit adds to the level-up
 * screens (screens.mjs STEP_SCREENS). Same contract: { element, answer() → { data, meta } | null }.
 */
import { abilitiesScreen } from "./creation-screens.mjs";
import { abilitiesComplete, baseScores, pointBuyState, validateEntered } from "../../foundry/systems/dnd5e/builder/creation-rules.mjs";

const copy = value => JSON.parse(JSON.stringify(value ?? {}));
const complete = answer => abilitiesComplete(baseScores(answer, {})) && (answer.method !== "pointBuy" || pointBuyState(answer.pointBuy).valid);

export const EDIT_SCREENS = {
  /** Base ability scores: creation's Abilities screen, the character's increases shown on top. Rolling isn't offered. */
  AbilityScores(model, ctx, scope) {
    let answer = copy(model.answer);
    const screen = abilitiesScreen(model, ctx, scope, {
      save: next => { answer = next; ctx.validChanged(complete(answer)); },
      roll: () => {},
      enter: values => {
        const numbers = values.map(v => Number(v));
        const problems = validateEntered(numbers);
        if (problems.length) { ctx.error(ctx.t("Edit.EnterRange", "Each number must be from 3 to 18.")); return; }
        // Each number stays on its ability (1 = STR … 6 = CHA); tap a number, then an ability, to move it.
        answer = { ...answer, method: "manual", entered: numbers, assignments: { str: "m0", dex: "m1", con: "m2", int: "m3", wis: "m4", cha: "m5" } };
        screen.update({ ...model, answer });
        ctx.validChanged(complete(answer));
      }
    });
    ctx.validChanged(complete(answer));
    return { element: screen.element, answer: () => (complete(answer) ? { data: copy(answer), meta: null } : null) };
  }
};
