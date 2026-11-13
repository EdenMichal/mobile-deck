// test-5e-world only: the "Claude Test Player" account (Player role, no password) for the GM-approval tests (Phase 4b).
// Created once by Claude Test GM and kept: later runs reuse it. Never used in any other world.
export const TEST_PLAYER = "Claude Test Player";

/** Make sure the player exists (run on a GM page). Returns its id. */
export async function ensureTestPlayer(gmPage) {
  return gmPage.evaluate(async name => {
    if (!/test 5e world/i.test(game.world.title)) throw new Error(`not test-5e-world: ${game.world.title}`);
    if (!game.user.isGM) throw new Error("ensureTestPlayer needs a GM page");
    const existing = game.users.getName(name);
    if (existing) return existing.id;
    const user = await User.implementation.create({ name, role: CONST.USER_ROLES.PLAYER, password: "" });
    return user.id;
  }, TEST_PLAYER);
}
