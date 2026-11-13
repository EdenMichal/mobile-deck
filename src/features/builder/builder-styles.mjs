// Load the builder stylesheet once. module.json lists it too, but Foundry caches a module's
// style list when it first discovers the module, so a running world can miss a new file.
const href = new URL("../../../assets/ve-builder.css", import.meta.url).href;

export function ensureBuilderStyles(doc = globalThis.document) {
  if (!doc?.head) return;
  const loaded = [...doc.querySelectorAll("link[rel=stylesheet]")].some(link => link.href.split("?")[0].endsWith("/assets/ve-builder.css"));
  if (loaded) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.veBuilder = "true";
  doc.head.append(link);
}
