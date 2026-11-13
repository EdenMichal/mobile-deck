/**
 * Player feedback (fork), spec 2026-11-13 §2: "Create item" on the dnd5e inventory.
 * A bottom sheet in VE's editor style (the currency editor's layer and frame): pick one of six types, fill a short
 * form, Create. The form's choices come from commands.readCharacterItemCreator (CONFIG.DND5E via the command
 * gateway) and Create runs ACTOR_COMMANDS.CREATE_ITEM, which re-validates the draft and creates the item directly.
 * The UI never touches Foundry documents.
 *
 * Lifetime: the sheet belongs to the retained character shell's scope (commands.characterShellScope), not to the
 * pane. The pane is rebuilt on every Actor update (a GM changing HP), and a half-typed form must survive that.
 * The shell scope ends when the character view does (route or character change), and the sheet with it.
 */
import { icon, node } from "../../../../ui/dom.mjs";
import { localizedText } from "../../../../ui/localized-text.mjs";
import { ACTOR_COMMANDS } from "../../../../kernel/command-names.mjs";
import { characterErrorMessage, notifyCharacter } from "../../notifications.mjs";
import { emptyItemDraft, iconChoices, itemCreateErrorMessage, itemDataFromDraft, showsArmorValue } from "../../../../foundry/systems/dnd5e/item-create-rules.mjs";

const STYLESHEET = new URL("../../../../../assets/ve-item-create.css", import.meta.url).href;
const FALLBACK_ICONS = Object.freeze({ weapon: "fa-gavel", equipment: "fa-shield-halved", consumable: "fa-flask",
  tool: "fa-screwdriver-wrench", loot: "fa-gem", container: "fa-box-open" });
const TYPE_HINTS = Object.freeze({
  weapon: "Swords, bows, staves",
  equipment: "Armor, shields, rings, clothes",
  consumable: "Potions, scrolls, ammo, food",
  tool: "Kits, instruments, game sets",
  loot: "Gems, art, trade goods",
  container: "Bags, chests, pouches"
});
const FORM_TITLES = Object.freeze({
  weapon: "New weapon", equipment: "New equipment", consumable: "New consumable",
  tool: "New tool", loot: "New loot", container: "New container"
});
const CATEGORY_LISTS = Object.freeze({ weapon: "weaponTypes", equipment: "equipmentTypes", consumable: "consumableTypes", tool: "toolTypes", loot: "lootTypes" });
let fieldSequence = 0;
// At most one creator is open; a re-rendered inventory for another character (or without the right) closes it.
let openCreator = null;

/** The "+" icon button in the INVENTORY heading row, before sort and expand-all (it takes their square look from
 * .ve-collection-controls); null unless this user owns a character that can hold items. */
export function createItemButton(actor, commands, scope) {
  const sourceUuid = actorSourceUuid(actor);
  const allowed = Boolean(actor?.capabilities?.createItem) && typeof commands?.readCharacterItemCreator === "function";
  if (openCreator && (!allowed || openCreator.sourceUuid !== sourceUuid)) openCreator.close();
  if (!allowed) return null;
  ensureItemCreateStyles();
  const text = (key, fallback, data) => localizedText(commands.localize, `VEMOBILE.ItemCreate.${key}`, fallback, data);
  const button = node("button", {
    className: "ve-item-create-open",
    attrs: { type: "button", title: text("Button", "Create item"), "aria-label": text("Button", "Create item"), "aria-haspopup": "dialog" },
    children: [icon("fa-plus")]
  }, scope);
  scope.listen(button, "click", () => openItemCreator(button, actor, commands, commands.characterShellScope ?? scope));
  return button;
}

/** Open the creator over the character pane, owned by `scope` (the shell scope in the sheet). Exported for the harness. */
export function openItemCreator(anchor, actor, commands, scope) {
  const sourceUuid = actorSourceUuid(actor);
  const text = (key, fallback, data) => localizedText(commands.localize, `VEMOBILE.ItemCreate.${key}`, fallback, data);
  let options;
  try { options = commands.readCharacterItemCreator(sourceUuid); }
  catch (error) {
    notifyCharacter(commands, sourceUuid, characterErrorMessage(commands, error, text("Unavailable", "Items can't be created on this actor.")), "error");
    return null;
  }
  if (!options?.types?.length) return null;
  const doc = anchor?.ownerDocument ?? globalThis.document;
  ensureItemCreateStyles(doc);
  openCreator?.close();

  const screen = anchor?.closest?.(".ve-character-screen");
  const host = screen?.__veCharacterOverlayHost ?? screen ?? doc?.body;
  const sheetScope = scope.child("item-creator");
  let draft = null;
  let pristine = "";
  let pending = false;
  let confirming = null;
  let stepScope = null;
  const close = () => sheetScope.dispose();
  const creator = { sourceUuid, close };
  openCreator = creator;
  sheetScope.own(() => { if (openCreator === creator) openCreator = null; });

  const headerArt = node("span", { className: "ve-hp-editor-heading-icon ve-item-create-heading-art" });
  const title = node("h2", { attrs: { id: `ve-item-create-title-${++fieldSequence}` } });
  const backButton = node("button", { className: "ve-item-create-back", attrs: { type: "button", "aria-label": text("Back", "Back to item types"), hidden: true },
    on: { click: () => leave("back") }, children: [icon("fa-chevron-left")] }, sheetScope);
  const body = node("div", { className: "ve-item-create-body" });
  const form = node("form", {
    className: "ve-currency-editor ve-item-create",
    attrs: { role: "dialog", "aria-modal": "true", "aria-labelledby": title.id, tabindex: "-1", novalidate: true },
    children: [
      node("header", { children: [
        node("span", { className: "ve-item-create-lead", children: [backButton, headerArt] }),
        node("div", { children: [title] }),
        node("button", { className: "ve-hp-editor-close", attrs: { type: "button", "aria-label": text("Close", "Close item creator") }, on: { click: () => leave("close") }, children: [icon("fa-xmark")] }, sheetScope)
      ] }),
      body
    ]
  }, sheetScope);
  const layer = node("div", { className: `ve-currency-editor-layer ve-item-create-layer${host === screen ? "" : " is-pane-scoped"}`, children: [form] });

  // Step 1: six large tiles, two per row.
  function showTypes() {
    stepScope?.dispose();
    stepScope = sheetScope.child("item-creator-types");
    draft = null;
    pristine = "";
    form.dataset.step = "type";
    delete form.dataset.itemType;
    form.__veItemCreate = null;
    title.textContent = text("PickTitle", "Create item");
    backButton.hidden = true;
    headerArt.hidden = false;
    headerArt.replaceChildren(icon("fa-plus"));
    const tiles = options.types.map(type => node("button", {
      className: "ve-item-create-type",
      attrs: { type: "button", "data-item-type": type.value },
      on: { click: () => showForm(type) },
      children: [
        typeGlyph(type.value, type.img),
        node("span", { className: "ve-item-create-type-copy", children: [
          node("strong", { text: type.label }),
          node("small", { text: text(`Hints.${type.value}`, TYPE_HINTS[type.value] ?? "") })
        ] })
      ]
    }, stepScope));
    body.replaceChildren(node("div", { className: "ve-item-create-types", attrs: { role: "list" }, children: tiles.map(tile => node("div", { attrs: { role: "listitem" }, children: [tile] })) }));
    // Focus the dialog itself: screen readers announce it, and a touch open shows no focus ring on a tile.
    queueMicrotask(() => { if (!stepScope.disposed) form.focus({ preventScroll: true }); });
  }

  // Step 2: the short form for one type.
  function showForm(type) {
    stepScope?.dispose();
    stepScope = sheetScope.child("item-creator-form");
    draft = emptyItemDraft(type.value, options);
    form.dataset.step = "form";
    form.dataset.itemType = type.value;
    title.textContent = text(`FormTitles.${type.value}`, FORM_TITLES[type.value] ?? type.label);
    backButton.hidden = false;
    headerArt.hidden = true;
    const fields = itemForm(type, draft, options, text, stepScope);
    const submit = node("button", { className: "ve-currency-editor-submit ve-item-create-submit", attrs: { type: "submit" },
      children: [icon("fa-check"), node("span", { text: text("Create", "Create") })] });
    body.replaceChildren(fields.element, node("div", { className: "ve-item-create-footer", children: [submit] }));
    form.__veItemCreate = { fields, submit, type };
    pristine = JSON.stringify(fields.read());
    queueMicrotask(() => { if (!stepScope.disposed) fields.focusName(); });
  }

  const dirty = () => Boolean(form.__veItemCreate) && JSON.stringify(form.__veItemCreate.fields.read()) !== pristine;
  // Back, Escape, the X and a backdrop tap all come here: a form with typed values asks before it's dropped.
  function leave(kind) {
    if (pending) return;
    if (confirming) return dismissConfirm();
    const act = () => (kind === "back" ? showTypes() : close());
    if (!draft || !dirty()) return act();
    askDiscard(act);
  }
  function askDiscard(onDiscard) {
    const confirmScope = sheetScope.child("item-creator-discard");
    const heading = node("h3", { attrs: { id: `ve-item-create-discard-${++fieldSequence}` }, text: text("Discard.Title", "Discard this item?") });
    const keep = node("button", { className: "ve-modal-button is-secondary", attrs: { type: "button" }, on: { click: () => dismissConfirm() },
      children: [node("span", { text: text("Discard.Keep", "Keep editing") })] }, confirmScope);
    const discard = node("button", { className: "ve-modal-button is-primary ve-item-create-discard-confirm", attrs: { type: "button" },
      on: { click: () => { dismissConfirm(); onDiscard(); } }, children: [icon("fa-trash-can"), node("span", { text: text("Discard.Confirm", "Discard") })] }, confirmScope);
    const panel = node("div", { className: "ve-item-create-confirm", attrs: { role: "alertdialog", "aria-modal": "true", "aria-labelledby": heading.id },
      children: [heading, node("p", { text: text("Discard.Body", "What you've entered so far will be lost.") }), node("div", { className: "ve-modal-actions", children: [keep, discard] })] });
    form.inert = true;
    form.classList.add("is-confirming");
    layer.append(panel);
    confirming = { scope: confirmScope, panel };
    confirmScope.own(() => { panel.remove(); form.inert = false; form.classList.remove("is-confirming"); });
    queueMicrotask(() => keep.focus({ preventScroll: true }));
  }
  function dismissConfirm() {
    const current = confirming;
    confirming = null;
    current?.scope.dispose();
    form.__veItemCreate?.fields.focusName?.(false);
  }

  sheetScope.listen(form, "submit", async event => {
    event.preventDefault();
    const current = form.__veItemCreate;
    // Only the Create button creates; Return in a field moves on (see the keydown handler below).
    if (pending || !draft || !current || (event.submitter && event.submitter !== current.submit)) return;
    const values = current.fields.read();
    const result = itemDataFromDraft(values, options);
    current.fields.showErrors(result.ok ? {} : result.errors);
    if (!result.ok) return;
    pending = true;
    form.classList.add("is-pending");
    form.setAttribute("aria-busy", "true");
    for (const control of form.querySelectorAll("button, input, select, textarea")) control.disabled = true;
    current.submit.querySelector("span").textContent = text("Creating", "Creating…");
    try {
      const outcome = await commands.execute(ACTOR_COMMANDS.CREATE_ITEM, { actorSourceUuid: sourceUuid, draft: values });
      close();
      notifyCharacter(commands, sourceUuid, text("Created", "{item} added to {actor}.", { item: outcome?.itemName ?? result.data.name, actor: actor.name }), "info");
      if (outcome?.itemId) commands.setExpandedCharacterItem?.(outcome.itemId);
    } catch (error) {
      if (sheetScope.disposed) return;
      pending = false;
      form.classList.remove("is-pending");
      form.removeAttribute("aria-busy");
      for (const control of form.querySelectorAll("button, input, select, textarea")) control.disabled = false;
      current.fields.syncDisabled();
      current.submit.querySelector("span").textContent = text("Create", "Create");
      notifyCharacter(commands, sourceUuid, characterErrorMessage(commands, error, text("Failed", "The item could not be created.")), "error");
    }
  });

  // Return in a one-line field goes to the next field (or closes the keyboard on the last); it never submits.
  sheetScope.listen(form, "keydown", event => {
    if (event.key !== "Enter" || event.isComposing || !event.target.matches?.("input")) return;
    event.preventDefault();
    const fields = [...form.querySelectorAll("input:not([type=hidden]), select, textarea")]
      .filter(control => !control.disabled && !control.closest("[hidden]") && control.offsetParent !== null);
    const next = fields[fields.indexOf(event.target) + 1];
    if (next) next.focus();
    else event.target.blur();
  });

  // iOS Safari keeps fixed layers at the layout viewport's height while the keyboard covers the bottom; lift the sheet
  // by the covered height (as auto-mode-confirmation.mjs follows the visual viewport) and keep the focused field in view.
  const view = doc?.defaultView;
  const viewport = view?.visualViewport;
  const updateKeyboardInset = () => {
    const covered = viewport ? Math.max(0, view.innerHeight - (viewport.height + viewport.offsetTop)) : 0;
    layer.style.setProperty("--ve-keyboard-inset", `${Math.round(covered)}px`);
  };
  if (viewport) {
    sheetScope.listen(viewport, "resize", updateKeyboardInset, { passive: true });
    sheetScope.listen(viewport, "scroll", updateKeyboardInset, { passive: true });
  }
  updateKeyboardInset();
  sheetScope.listen(form, "focusin", event => {
    if (!event.target.matches?.("input, select, textarea")) return;
    const target = event.target;
    // After the keyboard's slide-in, so the visual viewport has its final height.
    const reveal = () => { if (target.isConnected) target.scrollIntoView?.({ block: "nearest" }); };
    if (typeof sheetScope.timeout === "function") sheetScope.timeout(reveal, 320);
    else setTimeout(reveal, 320);
  });

  host?.append(layer);
  // Back (gesture or hardware) steps out of the form first, then closes.
  sheetScope.listen(layer, "ve-close", () => leave(draft ? "back" : "close"));
  sheetScope.listen(layer, "pointerdown", event => { if (event.target === layer) leave("close"); });
  sheetScope.listen(layer, "keydown", event => { if (event.key === "Escape") { event.preventDefault(); leave(draft ? "back" : "close"); } });
  sheetScope.own(() => {
    layer.remove();
    const button = host?.querySelector?.(".ve-item-create-open") ?? (anchor?.isConnected ? anchor : null);
    button?.focus?.({ preventScroll: true });
  });
  showTypes();
  return layer;
}

function actorSourceUuid(actor) {
  return String(actor?.sourceUuid ?? (actor?.id ? `Actor.${actor.id}` : ""));
}

// dnd5e's white SVG defaults are drawn as a mask so they take the theme accent; Foundry's painted icons as images.
function typeGlyph(type, img, className = "ve-item-create-glyph") {
  if (!img) return node("span", { className: `${className} is-icon`, children: [icon(FALLBACK_ICONS[type] ?? "fa-box")] });
  if (!/\.svg$/iu.test(img)) return node("img", { className: `${className} is-image`, attrs: { src: img, alt: "", loading: "lazy", decoding: "async" } });
  const glyph = node("span", { className, attrs: { "aria-hidden": "true" } });
  const url = `url("${String(img).replace(/["\\]/gu, "")}")`;
  glyph.style.setProperty("mask-image", url);
  glyph.style.setProperty("-webkit-mask-image", url);
  return glyph;
}

// Build the form's fields; returns read/showErrors/focus helpers so submit stays in one place.
function itemForm(type, draft, options, text, scope) {
  const controls = {};
  const errorSlots = {};
  const isContainer = type.value === "container";
  const id = name => `ve-item-create-${name}-${++fieldSequence}`;
  // A field is a <div> with a <label for> its main control, never a <label> around buttons: tapping "Quantity"
  // focuses the number, it doesn't press "−".
  const field = (name, label, control, { className = "", hint = null, labelFor = null } = {}) => {
    const error = node("small", { className: "ve-item-create-error", attrs: { id: id(`${name}-error`), "aria-live": "polite" } });
    errorSlots[name] = error;
    const target = labelFor ?? (control.matches?.("input, select, textarea") ? control : null);
    const labelId = id(`${name}-label`);
    for (const each of control.matches?.("input, select, textarea") ? [control] : [...control.querySelectorAll("input, select, textarea")]) {
      each.setAttribute("aria-describedby", hint?.id ? `${error.id} ${hint.id}` : error.id);
    }
    if (!target && !control.matches?.("input, select, textarea")) control.setAttribute("aria-labelledby", labelId);
    const labelNode = target
      ? node("label", { className: "ve-item-create-label", attrs: { id: labelId, for: target.id }, text: label })
      : node("span", { className: "ve-item-create-label", attrs: { id: labelId }, text: label });
    return node("div", { className: `ve-item-create-field${className ? ` ${className}` : ""}`, dataset: { field: name },
      children: [labelNode, control, hint, error] });
  };
  const input = (name, attrs) => (controls[name] = node("input", { attrs: { id: id(name), name, autocomplete: "off", enterkeyhint: "next", ...attrs } }));
  // Text inputs with a numeric keyboard: no browser spinners, and a decimal comma is read as a point.
  const number = (name, value, { integer = false } = {}) => input(name, {
    type: "text", inputmode: integer ? "numeric" : "decimal", value: value === "" ? "" : String(value)
  });
  const numeric = control => String(control?.value ?? "").trim().replace(",", ".");
  const select = (name, list, value, { blank = null } = {}) => (controls[name] = node("select", { attrs: { id: id(name), name }, children: [
    blank === null ? null : node("option", { attrs: { value: "" }, text: blank }),
    ...list.map(entry => node("option", { attrs: { value: entry.value, selected: String(entry.value) === String(value) }, text: entry.label }))
  ] }));
  const hintNode = (name, value) => node("small", { className: "ve-item-create-hint", attrs: { id: id(`${name}-hint`) }, text: value });

  const name = input("name", { type: "text", required: true, maxlength: 100, autocapitalize: "words", spellcheck: "false" });
  const sections = [];

  // Picture: the chosen preset beside the name; tapping it opens a grid of this type's presets.
  let img = draft.img;
  const pictures = iconChoices(type.value, options);
  const preview = node("span", { className: "ve-item-create-picture-preview" });
  const drawPreview = () => preview.replaceChildren(typeGlyph(type.value, img, "ve-item-create-picture-art"));
  drawPreview();
  const pictureToggle = node("button", {
    className: "ve-item-create-picture", attrs: { type: "button", "aria-expanded": "false", "aria-label": text("Fields.PictureChange", "Change picture") },
    children: [preview, node("span", { className: "ve-item-create-picture-edit", children: [icon("fa-pen")] })]
  }, scope);
  const grid = node("div", { className: "ve-item-create-pictures", attrs: { role: "group", "aria-label": text("Fields.Picture", "Picture"), hidden: true },
    children: pictures.map((path, index) => node("button", {
      className: "ve-item-create-picture-choice",
      attrs: { type: "button", "aria-pressed": String(path === img), "data-img": path,
        "aria-label": index === 0 ? text("Fields.PictureDefault", "Default picture") : pictureName(path) },
      on: { click: event => {
        img = event.currentTarget.dataset.img;
        for (const choice of grid.querySelectorAll("[data-img]")) choice.setAttribute("aria-pressed", String(choice.dataset.img === img));
        drawPreview();
        togglePictures(false);
      } },
      children: [typeGlyph(type.value, path, "ve-item-create-picture-art")]
    }, scope)) });
  const togglePictures = (open = grid.hidden) => {
    grid.hidden = !open;
    pictureToggle.setAttribute("aria-expanded", String(open));
    if (open) grid.querySelector("[aria-pressed='true']")?.focus({ preventScroll: true });
  };
  scope.listen(pictureToggle, "click", () => togglePictures());
  errorSlots.img = node("small", { className: "ve-item-create-error", attrs: { "aria-live": "polite" } });
  sections.push(node("div", { className: "ve-item-create-identity", children: [
    pictures.length > 1 ? pictureToggle : node("span", { className: "ve-item-create-picture is-static", children: [preview] }),
    field("name", text("Fields.Name", "Name"), name)
  ] }), node("div", { className: "ve-item-create-field is-wide", dataset: { field: "img" }, children: [grid, errorSlots.img] }));

  // Quantity (a stepper; containers are always one), weight, price with coin segments.
  const quantity = number("quantity", draft.quantity, { integer: true });
  const stepper = node("span", { className: "ve-item-create-stepper", children: [
    node("button", { attrs: { type: "button", "aria-label": text("Decrease", "Decrease quantity") }, on: { click: () => bump(-1) }, children: [icon("fa-minus")] }, scope),
    quantity,
    node("button", { attrs: { type: "button", "aria-label": text("Increase", "Increase quantity") }, on: { click: () => bump(1) }, children: [icon("fa-plus")] }, scope)
  ] });
  function bump(delta) {
    const current = Math.trunc(Number(numeric(quantity)) || 1);
    quantity.value = String(Math.max(1, Math.min(9999, current + delta)));
    quantity.dispatchEvent(new Event("input", { bubbles: true }));
  }
  const weight = number("weight", draft.weight);
  sections.push(node("div", { className: "ve-item-create-row", children: [
    isContainer ? null : field("quantity", text("Fields.Quantity", "Quantity"), stepper, { labelFor: quantity }),
    field("weight", text("Fields.Weight", "Weight"), weight)
  ] }));

  const price = number("priceValue", draft.priceValue);
  let denomination = draft.priceDenomination;
  const coinButtons = options.currencies.map(currency => node("button", {
    className: `ve-item-create-coin is-${currency.value}`,
    attrs: { type: "button", "aria-pressed": String(currency.value === denomination), "data-denomination": currency.value },
    on: { click: () => { denomination = currency.value; for (const coin of coinButtons) coin.setAttribute("aria-pressed", String(coin.dataset.denomination === denomination)); } },
    text: currency.label
  }, scope));
  const coins = node("span", { className: "ve-item-create-coins", attrs: { role: "group", "aria-label": text("Fields.Currency", "Currency") }, children: coinButtons });
  sections.push(field("priceValue", text("Fields.Price", "Price"), node("span", { className: "ve-item-create-price", children: [price, coins] }), { className: "is-wide", labelFor: price }));

  // The type's own details.
  const details = [];
  const listKey = CATEGORY_LISTS[type.value];
  if (listKey && options[listKey]?.length) {
    const label = type.value === "weapon" ? text("Fields.WeaponType", "Weapon type") : text("Fields.Category", "Kind");
    details.push(field("category", label, select("category", options[listKey], draft.category, { blank: type.value === "weapon" ? null : text("Fields.None", "None") }), { className: "is-wide" }));
  }
  if (type.value === "weapon") {
    const dice = number("damageNumber", draft.damageNumber, { integer: true });
    dice.setAttribute("aria-label", text("Fields.DiceCount", "Number of dice"));
    const die = select("damageDie", options.dieFaces.map(face => ({ value: face, label: `d${face}` })), draft.damageDie);
    die.setAttribute("aria-label", text("Fields.Die", "Die"));
    const damageType = select("damageType", options.damageTypes, draft.damageType, { blank: text("Fields.Untyped", "Untyped") });
    damageType.setAttribute("aria-label", text("Fields.DamageType", "Damage type"));
    details.push(field("damageNumber", text("Fields.Damage", "Damage"), node("span", { className: "ve-item-create-damage", children: [dice, die, damageType] }), { className: "is-wide", labelFor: dice }));
    if (options.weaponProperties?.length) {
      const chips = options.weaponProperties.map(property => node("button", {
        className: "ve-item-create-chip", attrs: { type: "button", "aria-pressed": "false", "data-property": property.value },
        on: { click: event => { const chip = event.currentTarget; chip.setAttribute("aria-pressed", String(chip.getAttribute("aria-pressed") !== "true")); } },
        text: property.label
      }, scope));
      controls.properties = node("span", { className: "ve-item-create-chips", attrs: { role: "group" }, children: chips });
      details.push(field("properties", text("Fields.Properties", "Properties"), controls.properties, { className: "is-wide" }));
    }
  }
  let armorField = null;
  if (type.value === "equipment") {
    armorField = field("armorValue", text("Fields.ArmorValue", "Armor Class"), number("armorValue", "", { integer: true }));
    details.push(armorField);
  }
  let usesHint = null;
  if (type.value === "consumable") {
    usesHint = hintNode("uses", "");
    details.push(field("uses", text("Fields.Uses", "Uses"), number("uses", "", { integer: true }), { hint: usesHint }));
  }
  if (type.value === "tool" && options.baseTools?.length) {
    details.push(field("baseTool", text("Fields.BaseTool", "Base tool"), select("baseTool", options.baseTools, draft.baseTool, { blank: text("Fields.None", "None") }),
      { className: "is-wide", hint: hintNode("baseTool", text("Fields.BaseToolHint", "Pick the tool this is, so your proficiency applies.")) }));
  }
  if (isContainer) details.push(field("capacity", text("Fields.Capacity", "Holds up to (weight)"), number("capacity", "")));
  if (details.length) {
    sections.push(node("fieldset", { className: "ve-item-create-details", children: [
      node("legend", { text: text(`DetailsTitles.${type.value}`, `${type.label} details`) }), ...details
    ] }));
  }

  // Armor Class only for armor and shields; a shield's value is its bonus. A consumable's hint follows its kind.
  const syncCategory = () => {
    const category = controls.category?.value ?? "";
    if (armorField) {
      armorField.hidden = !showsArmorValue(category, options);
      armorField.querySelector(".ve-item-create-label").textContent = category === "shield"
        ? text("Fields.ShieldValue", "AC bonus") : text("Fields.ArmorValue", "Armor Class");
    }
    if (usesHint) usesHint.textContent = category === "ammo"
      ? text("Fields.UsesHintAmmo", "Ammunition is spent by the weapon that fires it.")
      : text("Fields.UsesHint", "Leave empty for a one-use item: using it spends one from the stack. A number gives it that many charges.");
  };
  if (controls.category) scope.listen(controls.category, "change", syncCategory);
  syncCategory();

  const description = node("textarea", { attrs: { id: id("description"), name: "description", rows: "3", maxlength: "5000",
    placeholder: text("Fields.DescriptionPlaceholder", "What it looks like, where it came from") } });
  controls.description = description;
  sections.push(field("description", text("Fields.Description", "Description"), description, { className: "is-wide" }));

  // Errors from fields the form doesn't show (type) land on the name.
  const errorTarget = key => errorSlots[key] ? key : (["damageDie", "damageType"].includes(key) ? "damageNumber" : key === "priceDenomination" ? "priceValue" : "name");

  const element = node("div", { className: "ve-item-create-fields", children: sections });
  // An error goes away as soon as the player edits that field.
  const clearField = event => {
    const holder = event.target.closest?.("[data-field]");
    const slot = holder ? errorSlots[holder.dataset.field] : null;
    if (slot) slot.textContent = "";
    for (const control of holder?.querySelectorAll?.("[aria-invalid]") ?? []) control.removeAttribute("aria-invalid");
  };
  scope.listen(element, "input", clearField);
  scope.listen(element, "change", clearField);
  scope.listen(element, "click", event => { if (event.target.closest?.("button")) clearField(event); });

  return {
    element,
    focusName: (scroll = true) => name.focus({ preventScroll: !scroll }),
    read: () => ({
      type: type.value,
      name: name.value,
      img,
      quantity: controls.quantity ? numeric(controls.quantity) : 1,
      weight: numeric(weight),
      priceValue: numeric(price),
      priceDenomination: denomination,
      description: description.value,
      category: controls.category?.value ?? "",
      damageNumber: controls.damageNumber ? numeric(controls.damageNumber) : "",
      damageDie: controls.damageDie?.value ?? "",
      damageType: controls.damageType?.value ?? "",
      properties: controls.properties ? [...controls.properties.querySelectorAll("[aria-pressed='true']")].map(chip => chip.dataset.property) : [],
      armorValue: armorField && !armorField.hidden ? numeric(controls.armorValue) : "",
      uses: controls.uses ? numeric(controls.uses) : "",
      capacity: controls.capacity ? numeric(controls.capacity) : "",
      baseTool: controls.baseTool?.value ?? ""
    }),
    showErrors(errors) {
      for (const slot of Object.values(errorSlots)) slot.textContent = "";
      for (const control of Object.values(controls)) control.removeAttribute?.("aria-invalid");
      let first = null;
      for (const [key, code] of Object.entries(errors)) {
        const target = errorTarget(key);
        const { key: messageKey, fallback } = itemCreateErrorMessage(key, code);
        if (!errorSlots[target].textContent) errorSlots[target].textContent = text(messageKey.replace(/^VEMOBILE\.ItemCreate\./u, ""), fallback);
        const control = controls[key] ?? controls[target];
        control?.setAttribute?.("aria-invalid", "true");
        first ??= control;
      }
      if (errors.img) togglePictures(true);
      first?.focus?.({ preventScroll: false });
    },
    syncDisabled: syncCategory
  };
}

// A readable name for a preset from its file name ("icons/weapons/swords/scimitar-blue.webp" → "scimitar blue").
function pictureName(path) {
  return String(path).split("/").pop().replace(/\.[a-z0-9]+$/iu, "").replace(/[-_]+/gu, " ");
}

/** Load ve-item-create.css once (it also styles the Delete confirm, which shares the discard card's look). */
export function ensureItemCreateStyles(doc = globalThis.document) {
  if (!doc?.head) return;
  if ([...doc.querySelectorAll("link[rel=stylesheet]")].some(link => link.href.split("?")[0].endsWith("/assets/ve-item-create.css"))) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLESHEET;
  link.dataset.veItemCreate = "true";
  doc.head.append(link);
}
