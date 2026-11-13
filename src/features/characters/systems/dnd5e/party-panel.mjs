import { ACTOR_COMMANDS } from "../../../../kernel/command-names.mjs";
import { icon, node } from "../../../../ui/dom.mjs";
import { localizedCount, localizedText } from "../../../../ui/localized-text.mjs";
import { characterErrorMessage, notifyCharacter } from "../../notifications.mjs";
import { PARTY_CURRENCY, isPartyItemType, stashRows } from "../../../../kernel/party-stash-rules.mjs";

/** Party inventory page for the D&D5e character sheet: the party Group's items
 * and coins, with Take / Send / Deposit / Withdraw. Reached from the Inventory
 * tab; the page key is "party" and Back returns to "inventory". */

// Foundry caches a module's style list when it first sees the module, so a
// running world can miss a newly added stylesheet (same approach as the builder).
const STYLES = new URL("../../../../../assets/ve-party.css", import.meta.url).href;
function ensurePartyStyles(doc = globalThis.document) {
  if (!doc?.head || [...doc.querySelectorAll("link[rel=stylesheet]")].some(link => link.href.split("?")[0].endsWith("/assets/ve-party.css"))) return;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLES;
  doc.head.append(link);
}

const t = (commands, key, fallback, data) => localizedText(commands.localize, `VEMOBILE.Party.${key}`, fallback, data);
const sourceOf = actor => String(actor?.sourceUuid ?? (actor?.id ? `Actor.${actor.id}` : ""));

/** True when this character may move things to and from its party. */
export function canMoveWithParty(actor) {
  return actor?.party?.status === "ready" && actor.party.access === "owner" && Boolean(actor.capabilities?.transferParty);
}

/** The Inventory tab's entry row into the party page. */
export function partyEntryRow(actor, commands, scope) {
  const party = actor?.party;
  if (!party) return null;
  ensurePartyStyles();
  const locale = commands.readLocale?.() ?? "en";
  const detail = party.status === "locked" ? (party.name || t(commands, "Entry.NoAccess", "No access yet"))
    : party.status !== "ready" ? t(commands, "Entry.NotSetUp", "Not set up yet")
    : [party.name, localizedCount(commands.localize, "VEMOBILE.Party.Entry.Items", { one: "{count} item", other: "{count} items" }, party.items.length, locale)].join(" · ");
  return node("button", {
    className: "ve-party-entry",
    attrs: { type: "button", "data-party-entry": "true" },
    on: { click: () => commands.selectCharacterTab("party") },
    children: [
      node("span", { className: "ve-party-entry-icon", children: [icon("fa-people-group")] }),
      node("span", { className: "ve-party-entry-copy", children: [
        node("strong", { text: t(commands, "Title", "Party Inventory") }),
        node("small", { text: detail })
      ] }),
      icon("fa-chevron-right")
    ]
  }, scope);
}

/** The full party page. */
export function partyPanel(actor, commands, scope) {
  ensurePartyStyles();
  const back = node("button", { className: "ve-sheet-back", attrs: { type: "button" },
    on: { click: () => commands.selectCharacterTab("inventory") },
    children: [icon("fa-chevron-left"), node("span", { text: localizedText(commands.localize, "VEMOBILE.Character.Tabs.Inventory", "Inventory") })] }, scope);
  const party = actor.party;
  if (!party || party.status !== "ready") {
    // "locked": a Group the player cannot look into (Limited, or a hidden primary party).
    const locked = party?.status === "locked";
    const body = locked
      ? (party.name
        ? t(commands, "Locked.Named", "You can't look inside {party} yet. Ask your GM to give you Owner permission on it.", { party: party.name })
        : t(commands, "Locked.Hidden", "Your GM has set up a party inventory, but you don't have access to it yet. Ask your GM for Owner permission."))
      : t(commands, "Missing.Body", "Your GM needs to create a Group actor for the party, set it as the primary party, and give players Owner permission on it.");
    return node("div", { className: "ve-sheet-stack ve-party", children: [back, node("section", { className: "ve-sheet-card ve-party-card", attrs: { "data-party-state": party?.status ?? "missing" }, children: [
      heading(locked && party.name ? party.name : t(commands, "Title", "Party Inventory"), "fa-people-group"),
      node("div", { className: "ve-party-empty", children: [
        icon(locked ? "fa-lock" : "fa-box-open"),
        node("strong", { text: locked ? t(commands, "Locked.Title", "No access yet") : t(commands, "Missing.Title", "No party inventory yet") }),
        node("p", { text: body })
      ] })
    ] })] });
  }
  const movable = canMoveWithParty(actor);
  const locale = commands.readLocale?.() ?? "en";
  const rows = stashRows(party.items);
  const stash = node("section", { className: "ve-sheet-card ve-party-card", attrs: { "data-party-stash": "true" }, children: [
    heading(party.name, "fa-people-group"),
    movable ? null : node("p", { className: "ve-party-notice", children: [icon("fa-lock"), node("span", {
      text: t(commands, "ReadOnly", "You can see the stash, but moving things needs Owner permission on {party}. Ask your GM to give it to you.", { party: party.name })
    })] }),
    coinStrip(party.currency, t(commands, "PartyCoins", "Party coins")),
    movable ? node("div", { className: "ve-party-coin-actions", children: [
      node("button", { attrs: { type: "button", "data-party-coins": "deposit" }, on: { click: () => commands.openPartySheet({ kind: "coins", direction: "deposit" }) },
        children: [icon("fa-coins"), node("span", { text: t(commands, "Deposit", "Deposit") })] }, scope),
      node("button", { attrs: { type: "button", "data-party-coins": "withdraw" }, on: { click: () => commands.openPartySheet({ kind: "coins", direction: "withdraw" }) },
        children: [icon("fa-hand-holding-dollar"), node("span", { text: t(commands, "Withdraw", "Withdraw") })] }, scope)
    ] }) : null,
    node("div", { className: "ve-party-list", attrs: { role: "list", "aria-label": t(commands, "StashItems", "Items in {party}", { party: party.name }) },
      children: rows.length ? rows.map(({ item, depth }) => itemRow(item, depth, {
        actionLabel: t(commands, "Take", "Take"), actionName: t(commands, "TakeItem", "Take {item}", { item: item.name }),
        enabled: movable, onAction: button => startItemTransfer(button, actor, item, "take", commands, scope), locale, commands, scope
      })) : [node("p", { className: "ve-sheet-empty", text: t(commands, "EmptyStash", "Nothing in the stash yet. Send something from your inventory below.") })] })
  ] });

  const mine = (actor.inventory ?? []).filter(item => isPartyItemType(item.type));
  const mineList = node("div", { className: "ve-party-list", attrs: { role: "list" },
    children: mine.length ? stashRows(mine).map(({ item, depth }) => itemRow(item, depth, {
      actionLabel: t(commands, "Send", "Send"), actionName: t(commands, "SendItem", "Send {item} to the party", { item: item.name }),
      enabled: movable, onAction: button => startItemTransfer(button, actor, item, "send", commands, scope), locale, commands, scope
    })) : [node("p", { className: "ve-sheet-empty", text: t(commands, "EmptyMine", "You are not carrying anything that can go in the stash.") })] });
  const summary = node("summary", { children: [icon("fa-chevron-right"), node("span", { text: t(commands, "FromCharacter", "Send from {name}", { name: actor.name }) }), node("b", { text: mine.length })] });
  const yours = node("section", { className: "ve-sheet-card ve-party-card", attrs: { "data-party-mine": "true" }, children: [
    node("details", { className: "ve-sheet-collection-section ve-party-mine", attrs: { open: movable && !rows.length }, children: [summary, mineList] })
  ] });
  return node("div", { className: "ve-sheet-stack ve-party", children: [back, stash, movable ? yours : null] });
}

/** Menu action for a character inventory row ("Send to Party"), or null. */
export function partyItemMenuAction(item, actor, commands) {
  if (!canMoveWithParty(actor) || !isPartyItemType(item?.type)) return null;
  return Object.freeze({ id: "party", label: t(commands, "SendToParty", "Send to Party"), icon: "fa-people-group" });
}

/** Run "Send to Party" from the inventory item menu. */
export function sendToPartyFromMenu(anchor, actor, item, commands, scope) {
  const record = (actor.inventory ?? []).find(entry => entry.id === item.id) ?? item;
  return startItemTransfer(anchor, actor, record, "send", commands, scope);
}

// A single stack moves at once; larger stacks open the quantity sheet.
function startItemTransfer(button, actor, item, direction, commands, scope) {
  const quantity = Math.max(0, Math.trunc(Number(item.quantity) || 0));
  const container = item.type === "container" && Number(item.contentsCount ?? countContents(actor, item.id)) > 0;
  if (quantity > 1 && !container) return commands.openPartySheet({ kind: "item", direction, itemId: item.id });
  return runItemTransfer(button, actor, item, direction, Math.max(1, quantity), commands);
}

// Errors are always reported: the first write refreshes the sheet and disposes this pane, but
// the kernel still checks that the notice belongs to the character on screen.
async function runItemTransfer(button, actor, item, direction, quantity, commands) {
  if (button?.disabled) return false;
  setBusy(button, true);
  try {
    await commands.execute(ACTOR_COMMANDS.TRANSFER_PARTY_ITEM, {
      actorSourceUuid: sourceOf(actor), partySourceUuid: actor.party.sourceUuid, direction, itemId: item.id, quantity
    });
    globalThis.navigator?.vibrate?.(5);
    return true;
  } catch (error) {
    notifyCharacter(commands, sourceOf(actor), characterErrorMessage(commands, error,
      t(commands, direction === "take" ? "Errors.TakeFailed" : "Errors.SendFailed", direction === "take" ? "{item} could not be taken." : "{item} could not be sent.", { item: item.name })), "error");
    return false;
  } finally {
    if (button?.isConnected) setBusy(button, false);
  }
}

// The open sheet's draft (typed values, pending submit) outlives pane renders, so a stash
// refresh caused by someone else's move neither closes the sheet nor loses what was typed.
let draft = null;
const draftKey = (actor, sheet) => [sourceOf(actor), sheet.kind, sheet.direction, sheet.itemId ?? ""].join("|");
function draftFor(actor, sheet, initial) {
  const key = draftKey(actor, sheet);
  if (draft?.key !== key) draft = { key, values: initial(), pending: false, view: null };
  return draft;
}
function clearDraft(key) { if (draft?.key === key) draft = null; }

/** Render the open party sheet (quantity picker or coins) from app state, or null. Called by the
 * character presenter on every render, like the HP, rest and XP editors. */
export function partySheetModal(actor, sheet, commands, scope) {
  if (!sheet) { draft = null; return null; }
  if (!canMoveWithParty(actor)) { queueMicrotask(() => commands.closePartySheet?.()); return null; }
  ensurePartyStyles();
  return sheet.kind === "coins" ? coinSheet(actor, sheet, commands, scope) : quantitySheet(actor, sheet, commands, scope);
}

// How many of a stack to move. The maximum follows the live stack; a vanished item closes the sheet.
function quantitySheet(actor, sheet, commands, scope) {
  const take = sheet.direction === "take";
  const item = (take ? actor.party.items : actor.inventory ?? []).find(entry => entry.id === sheet.itemId);
  const max = Math.max(0, Math.trunc(Number(item?.quantity) || 0));
  if (!item || max < 1) {
    const key = draftKey(actor, sheet);
    queueMicrotask(() => {
      if (draft?.pending && draft.key === key) return; // our own move just emptied it; the submit closes the sheet
      clearDraft(key);
      commands.closePartySheet?.();
      notifyCharacter(commands, sourceOf(actor), t(commands, "Errors.Gone", "That item is no longer in {source}. Someone may have just moved it.", { source: take ? actor.party.name : actor.name }), "warn");
    });
    return null;
  }
  const state = draftFor(actor, sheet, () => ({ count: 1 }));
  state.values.count = Math.min(max, Math.max(1, state.values.count));
  const input = node("input", { attrs: { type: "number", inputmode: "numeric", min: "1", max: String(max), step: "1", value: String(state.values.count),
    "aria-label": t(commands, "Quantity", "How many") } });
  const submitLabel = node("span");
  const submit = node("button", { className: "ve-currency-editor-submit", attrs: { type: "submit" }, children: [icon(take ? "fa-hand-holding" : "fa-people-group"), submitLabel] });
  const sync = next => {
    state.values.count = Math.min(max, Math.max(1, Math.trunc(Number(next) || 0)));
    input.value = String(state.values.count);
    submitLabel.textContent = t(commands, take ? "TakeCount" : "SendCount", take ? "Take {count}" : "Send {count}", { count: state.values.count });
  };
  sync(state.values.count);
  scope.listen(input, "change", () => sync(input.value));
  // Remember typing as it happens (without rewriting the field), so a refresh mid-typing keeps it.
  scope.listen(input, "input", () => { const value = Math.trunc(Number(input.value)); if (value >= 1) state.values.count = Math.min(max, value); });
  const preset = (label, onClick) => node("button", { attrs: { type: "button" }, on: { click: onClick }, children: [node("span", { text: label })] }, scope);
  return sheetLayer(actor, sheet, commands, scope, state, {
    kicker: t(commands, take ? "TakeFrom" : "SendTo", take ? "Take from {party}" : "Send to {party}", { party: actor.party.name }),
    title: item.name,
    iconName: take ? "fa-hand-holding" : "fa-people-group",
    label: t(commands, take ? "TakeTitle" : "SendTitle", take ? "Take {item}" : "Send {item}", { item: item.name }),
    body: [
      node("p", { className: "ve-party-sheet-hint", text: t(commands, "Available", "{count} in this stack", { count: max }) }),
      node("div", { className: "ve-party-stepper", children: [
        node("button", { attrs: { type: "button", "aria-label": t(commands, "Fewer", "Fewer") }, on: { click: () => sync(state.values.count - 1) }, children: [icon("fa-minus")] }, scope),
        input,
        node("button", { attrs: { type: "button", "aria-label": t(commands, "More", "More") }, on: { click: () => sync(state.values.count + 1) }, children: [icon("fa-plus")] }, scope)
      ] }),
      node("div", { className: "ve-party-presets", children: [
        preset(t(commands, "One", "1"), () => sync(1)),
        max > 2 ? preset(t(commands, "Half", "Half"), () => sync(Math.floor(max / 2))) : null,
        preset(t(commands, "All", "All {count}", { count: max }), () => sync(max))
      ] })
    ],
    submit,
    run: () => commands.execute(ACTOR_COMMANDS.TRANSFER_PARTY_ITEM, {
      actorSourceUuid: sourceOf(actor), partySourceUuid: actor.party.sourceUuid, direction: sheet.direction, itemId: item.id, quantity: state.values.count
    }),
    failure: t(commands, take ? "Errors.TakeFailed" : "Errors.SendFailed", take ? "{item} could not be taken." : "{item} could not be sent.", { item: item.name })
  });
}

// Deposit or withdraw coins, one row per denomination; maxima follow the live balances.
function coinSheet(actor, sheet, commands, scope) {
  const deposit = sheet.direction === "deposit";
  const available = deposit ? actor.currency ?? {} : actor.party.currency ?? {};
  const state = draftFor(actor, sheet, () => Object.fromEntries(PARTY_CURRENCY.map(key => [key, 0])));
  const rows = PARTY_CURRENCY.map(denomination => {
    const max = Math.max(0, Math.trunc(Number(available[denomination]) || 0));
    state.values[denomination] = Math.min(max, Math.max(0, state.values[denomination] ?? 0));
    const input = node("input", { attrs: { type: "number", inputmode: "numeric", min: "0", max: String(max), step: "1", value: String(state.values[denomination]), disabled: max === 0,
      "aria-label": t(commands, "CoinAmount", "{denomination} to move", { denomination: denomination.toUpperCase() }) } });
    const set = next => { state.values[denomination] = Math.min(max, Math.max(0, Math.trunc(Number(next) || 0))); input.value = String(state.values[denomination]); };
    scope.listen(input, "change", () => set(input.value));
    scope.listen(input, "input", () => { const value = Math.trunc(Number(input.value)); if (value >= 0) state.values[denomination] = Math.min(max, value); });
    const label = denomination.toUpperCase();
    return node("div", { className: `ve-currency-editor-row ve-party-coin-row is-${denomination}`, children: [
      // The coin label doubles as the "all" control: one 44px target instead of a small chip.
      node("button", { className: "ve-party-coin-max", attrs: { type: "button", disabled: max === 0, "aria-label": t(commands, "AllCoins", "All {denomination}", { denomination: label }) },
        on: { click: () => set(max) }, children: [
          node("span", { children: [icon("fa-coins"), node("strong", { text: label })] }),
          node("small", { text: t(commands, "OfMax", "All {count}", { count: max }) })
        ] }, scope),
      node("button", { attrs: { type: "button", disabled: max === 0, "aria-label": t(commands, "FewerCoins", "Fewer {denomination}", { denomination: label }) }, on: { click: () => set(state.values[denomination] - 1) }, children: [icon("fa-minus")] }, scope),
      input,
      node("button", { attrs: { type: "button", disabled: max === 0, "aria-label": t(commands, "MoreCoins", "More {denomination}", { denomination: label }) }, on: { click: () => set(state.values[denomination] + 1) }, children: [icon("fa-plus")] }, scope)
    ] });
  });
  const submit = node("button", { className: "ve-currency-editor-submit", attrs: { type: "submit" }, children: [icon("fa-check"),
    node("span", { text: t(commands, deposit ? "Deposit" : "Withdraw", deposit ? "Deposit" : "Withdraw") })] });
  return sheetLayer(actor, sheet, commands, scope, state, {
    kicker: t(commands, deposit ? "SendTo" : "TakeFrom", deposit ? "Send to {party}" : "Take from {party}", { party: actor.party.name }),
    title: t(commands, deposit ? "DepositTitle" : "WithdrawTitle", deposit ? "Deposit coins" : "Withdraw coins"),
    iconName: "fa-coins",
    label: t(commands, deposit ? "DepositTitle" : "WithdrawTitle", deposit ? "Deposit coins" : "Withdraw coins"),
    body: [node("div", { className: "ve-currency-editor-rows", children: rows })],
    submit,
    validate: () => {
      if (PARTY_CURRENCY.some(key => state.values[key] > 0)) return true;
      notifyCharacter(commands, sourceOf(actor), t(commands, "Errors.NoCoins", "Enter how many coins to move."), "warn");
      return false;
    },
    run: () => commands.execute(ACTOR_COMMANDS.TRANSFER_PARTY_CURRENCY, { actorSourceUuid: sourceOf(actor), partySourceUuid: actor.party.sourceUuid, direction: sheet.direction,
      amounts: Object.fromEntries(PARTY_CURRENCY.filter(key => state.values[key] > 0).map(key => [key, state.values[key]])) }),
    failure: t(commands, "Errors.CoinsFailed", "The coins could not be moved.")
  });
}

// The bottom sheet in the currency editor's visual language. Submits survive re-renders: the
// draft remembers it is pending and whichever render is live shows that.
function sheetLayer(actor, sheet, commands, scope, state, { kicker, title, iconName, label, body, submit, run, failure, validate = () => true }) {
  const key = state.key;
  const close = () => { if (state.pending) return; clearDraft(key); commands.closePartySheet(); };
  const form = node("form", {
    className: "ve-currency-editor ve-party-sheet",
    attrs: { role: "dialog", "aria-modal": "true", "aria-label": label, tabindex: "-1" },
    on: { submit: async event => {
      event.preventDefault();
      if (state.pending) return;
      for (const input of form.querySelectorAll("input:not(:disabled)")) input.dispatchEvent(new Event("change"));
      if (!validate()) return;
      state.pending = true;
      state.view?.setPending(true);
      try {
        await run();
        globalThis.navigator?.vibrate?.(5);
        state.pending = false;
        clearDraft(key);
        commands.closePartySheet();
      } catch (error) {
        state.pending = false;
        state.view?.setPending(false);
        notifyCharacter(commands, sourceOf(actor), characterErrorMessage(commands, error, failure), "error");
      }
    } },
    children: [
      node("header", { children: [
        node("span", { className: "ve-hp-editor-heading-icon", children: [icon(iconName)] }),
        node("div", { children: [node("small", { text: kicker }), node("h2", { text: title })] }),
        node("button", { className: "ve-hp-editor-close", attrs: { type: "button", "aria-label": t(commands, "Close", "Close") }, on: { click: close }, children: [icon("fa-xmark")] }, scope)
      ] }),
      ...body,
      submit
    ]
  }, scope);
  const lockedOff = new Set([...form.querySelectorAll("button:disabled, input:disabled")]);
  const view = { setPending(pending) {
    form.toggleAttribute("aria-busy", pending);
    for (const control of form.querySelectorAll("button, input")) control.disabled = pending || lockedOff.has(control);
  } };
  state.view = view;
  scope.own(() => { if (state.view === view) state.view = null; });
  view.setPending(state.pending);
  const layer = node("div", { className: "ve-currency-editor-layer ve-party-sheet-layer", attrs: { "data-party-sheet": sheet.kind }, children: [form] });
  scope.listen(layer, "pointerdown", event => { if (event.target === layer) close(); });
  scope.listen(form, "keydown", event => { if (event.key === "Escape") { event.preventDefault(); close(); } });
  // Focus the sheet, not its number field: focusing an input inside a tap would raise the phone keyboard over the steppers.
  queueMicrotask(() => { if (!scope.disposed && !form.contains(document.activeElement)) form.focus?.({ preventScroll: true }); });
  return layer;
}

// One stash or inventory row: art, name and quantity, type and weight, and the move button.
function itemRow(item, depth, { actionLabel, actionName, enabled, onAction, locale, commands, scope }) {
  const quantity = Math.max(0, Math.trunc(Number(item.quantity) || 0));
  const meta = [item.typeLabel, item.weight, item.contentsCount ? localizedCount(commands.localize, "VEMOBILE.Character.Copy.ItemCount", { one: "{count} item", other: "{count} items" }, item.contentsCount, locale) : ""].filter(Boolean).join(" · ");
  const row = node("div", { className: "ve-party-row", attrs: { role: "listitem" }, dataset: { itemId: item.id, depth: String(depth) }, children: [
    node("span", { className: "ve-sheet-item-art", children: item.img ? [node("img", { attrs: { src: item.img, alt: "" } })] : [icon("fa-box")] }),
    node("span", { className: "ve-party-row-copy", children: [
      node("strong", { children: [node("span", { text: item.name }), quantity > 1 ? node("b", { text: `×${quantity}` }) : null] }),
      meta ? node("small", { text: meta }) : null
    ] }),
    enabled ? node("button", { className: "ve-party-move", attrs: { type: "button", "aria-label": actionName }, on: { click: event => onAction(event.currentTarget) },
      children: [node("span", { text: actionLabel })] }, scope) : null
  ] });
  if (depth) row.style.setProperty("--ve-party-depth", String(Math.min(depth, 3)));
  return row;
}

function heading(title, iconName) {
  return node("header", { className: "ve-sheet-card-heading", children: [icon(iconName), node("h3", { text: title })] });
}

function coinStrip(currency, label) {
  return node("div", { className: "ve-currency-strip ve-party-coins", attrs: { "aria-label": label }, children: PARTY_CURRENCY.map(denomination => node("span", {
    className: `is-${denomination}`, attrs: { title: `${denomination.toUpperCase()} ${currency?.[denomination] ?? 0}` },
    children: [node("small", { text: denomination.toUpperCase() }), node("strong", { text: currency?.[denomination] ?? 0 })]
  })) });
}

function countContents(actor, containerId) {
  return (actor.inventory ?? []).filter(entry => entry.containerId === containerId).length;
}

function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.classList.toggle("is-pending", busy);
  if (busy) button.setAttribute("aria-busy", "true");
  else button.removeAttribute("aria-busy");
}
