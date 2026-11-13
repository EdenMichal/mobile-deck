// Test isolation for a test world that also holds the user's real books: the user's own DDB Importer and homebrew packs,
// copied into the test world under a name prefix, given in BOOKS_PACK_PREFIX (no default). When it is unset, nothing is
// pinned. World packs outrank dnd5e's in the builder's de-duplication, so the suites would resolve to those copies. For
// one test page, pinToSrd() makes the world packs with that prefix invisible to this client (the builder reads only
// visible Item packs), so the suites see the content they were written for. Nothing is saved: no setting or pack
// changes, and a reload re-applies it.
// Spell lists: dnd5e's registry is built from journal pages; the copied books bring none (Item and RollTable packs only),
// and spells are taken from visible packs, so a hidden copy pack adds no spells to a list either.
const PREFIX = process.env.BOOKS_PACK_PREFIX ?? "";

const pinScript = prefix => `(() => {
  const prefix = ${JSON.stringify(prefix)};
  const hide = () => {
    const packs = globalThis.game?.packs;
    if (!packs?.size) return false;
    for (const pack of packs) {
      if (pack.metadata?.packageType !== "world" || !pack.metadata.name?.startsWith(prefix) || pack.__vePinned) continue;
      Object.defineProperty(pack, "visible", { configurable: true, get: () => false });
      pack.__vePinned = true;
    }
    return true;
  };
  // On a fresh page: as soon as Foundry has its packs ("setup"), before anything reads them. Only on /game (the join
  // page has no packs), and never for longer than a minute.
  if (!hide() && globalThis.location?.pathname?.endsWith("/game")) {
    let hooked = false;
    let tries = 0;
    const wait = setInterval(() => {
      if (hide() || ++tries > 6000) return clearInterval(wait);
      if (globalThis.Hooks?.once && !hooked) { hooked = true; globalThis.Hooks.once("setup", hide); globalThis.Hooks.once("ready", hide); }
    }, 10);
  }
})();`;

/** Pin this page (and its reloads) to the content the suites were written for. Returns the hidden pack ids. */
export async function pinToSrd(page) {
  if (!PREFIX) return [];
  const PIN = pinScript(PREFIX);
  await page.addInitScript(PIN);
  await page.evaluate(PIN);
  return page.evaluate(() => globalThis.game.packs.filter(p => p.__vePinned).map(p => p.collection));
}
