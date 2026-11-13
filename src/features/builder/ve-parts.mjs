/**
 * Mobile Deck's sheet components, re-created with VE's own markup and class names for the builder
 * (presenter.mjs keeps sectionHeading / cardAction private). Styled by VE's CSS (ve-mobile.css)
 * plus the builder's small adjustments in ve-builder.css.
 */
import { icon, node } from "../../ui/dom.mjs";
import { sheetTabIcon } from "../characters/sheet-icons.mjs";

/** A VE icon: a Font Awesome name ("fa-heart"), a VE sheet icon ("sheet:spells"), a dnd5e class symbol ("class:wizard") or a node. */
export function veIcon(name) {
  if (name instanceof Node) return name;
  const value = String(name ?? "");
  if (value.startsWith("sheet:")) return sheetTabIcon(value.slice(6));
  if (value.startsWith("class:")) return node("span", { className: `ve-character-class-symbol is-${value.slice(6)}`, attrs: { "aria-hidden": "true" } });
  return icon(value || "fa-circle-info");
}

/** VE's card heading: accent icon, UPPERCASE title, optional action on the right. */
export function sectionHeading(title, iconName, action = null) {
  return node("header", { className: "ve-sheet-card-heading", children: [veIcon(iconName), node("h3", { text: title }), action] });
}

/** VE's card: a heading (optional) and its content. */
export function sheetCard({ title = "", iconName = "", action = null, className = "", children = [], attrs = {} } = {}) {
  return node("section", { className: `ve-sheet-card ve-builder-sheet-card${className ? ` ${className}` : ""}`, attrs,
    children: [title ? sectionHeading(title, iconName, action) : null, ...children].filter(Boolean) });
}

/** VE's "View All ›" card action, used for the builder's "Change ›". */
export function cardAction(label, onClick, scope, className = "") {
  return node("button", { className: `ve-sheet-card-action${className ? ` ${className}` : ""}`, attrs: { type: "button" }, on: { click: onClick },
    children: [node("span", { text: label }), icon("fa-chevron-right")] }, scope);
}

/** VE's item-row art tile: the picture, or an accent icon. */
export function rowArt(img, fallbackIcon = "fa-star") {
  return node("span", { className: "ve-sheet-item-art ve-builder-row-art", children: [img ? node("img", { attrs: { src: img, alt: "" } }) : veIcon(fallbackIcon)] });
}

/** VE's item-row copy: bold name over a small subtitle (and any extra lines). */
export function rowCopy(name, ...lines) {
  return node("span", { className: "ve-sheet-item-copy ve-builder-card-text", children: [node("strong", { text: name }), ...lines.filter(Boolean)] });
}

/**
 * A picker row's edition / tier tag ("5.5e Core", "5e Expanded", "3rd party", "Homebrew"): a small chip in VE's badge
 * style, toned by `tag.tone` (core55: accent, expanded55: accent outline, legacy: muted, other: gold). Null when untagged.
 */
export function tierChip(tag) {
  if (!tag?.label) return null;
  return node("span", { className: `ve-builder-tier is-${tag.tone || "legacy"}`, attrs: { title: tag.label }, text: tag.label });
}

/** A row's subtitle line: the book (or other source text) and the tier chip, side by side; null when both are empty. */
export function rowMeta(source, tag) {
  const chip = tierChip(tag);
  if (!source && !chip) return null;
  if (!chip) return node("small", { text: source });
  return node("span", { className: "ve-builder-card-meta", children: [source ? node("small", { text: source }) : null, chip].filter(Boolean) });
}

/** VE's small paragraph inside a card (".ve-section-intro"). */
export function cardNote(text, className = "") {
  return node("p", { className: `ve-section-intro${className ? ` ${className}` : ""}`, text });
}

/** A VE card with one subtle paragraph (VE's ".ve-sheet-empty"): empty and error states. */
export function emptyCard(text, ...children) {
  return sheetCard({ className: "ve-builder-empty-card", children: [node("p", { className: "ve-builder-empty ve-sheet-empty", text }), ...children] });
}
