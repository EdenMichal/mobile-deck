import { ensureBuilderStyles } from "../builder/builder-styles.mjs";

// Load the My Journals stylesheet once. module.json lists it too, but Foundry caches a module's
// style list when it first discovers the module, so a running world can miss a new file.
const href = new URL("../../../assets/ve-player-journals.css", import.meta.url).href;

export function ensurePlayerJournalStyles(doc = globalThis.document) {
  ensureBuilderStyles(doc);
  if (!doc?.head) return;
  const loaded = [...doc.querySelectorAll("link[rel=stylesheet]")].some(link => link.href.split("?")[0].endsWith("/assets/ve-player-journals.css"));
  if (loaded) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.vePlayerJournals = "true";
  doc.head.append(link);
}
