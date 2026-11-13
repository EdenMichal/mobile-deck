/**
 * World settings and GM-only desktop menus for the Character Builder (spec §5):
 * "Character Builder: Sources" and "Character Builder: House Rules".
 * Players never see these controls; Mobile Deck only shows them the result.
 */
import { node } from "../../../../ui/dom.mjs";
import { ensureBuilderStyles } from "../../../../features/builder/builder-styles.mjs";
import {
  SETTING_HOUSE_RULES, SETTING_SOURCES, clearContentCache, currentHouseRules, packIndex, packSettings, savedSources, worldRules
} from "./content-sources.mjs";
import { DEFAULT_PRIORITY, NO_BOOK, SOURCE_TYPES, collectBooks, defaultHouseRules, defaultSources, dedupe, sourceType } from "./source-filter.mjs";

let registeredFor = null;

export function registerBuilderSettings(moduleId) {
  const game = globalThis.game;
  if (registeredFor === moduleId || !game?.settings?.register) return;
  registeredFor = moduleId;
  game.settings.register(moduleId, SETTING_SOURCES, {
    name: "Character Builder sources", scope: "world", config: false, type: Object, default: defaultSources(),
    onChange: () => clearContentCache()
  });
  game.settings.register(moduleId, SETTING_HOUSE_RULES, {
    name: "Character Builder house rules", scope: "world", config: false, type: Object, default: defaultHouseRules()
  });
  const { SourcesMenu, HouseRulesMenu } = menuClasses(moduleId);
  game.settings.registerMenu(moduleId, "builderSourcesMenu", {
    name: "Character Builder: Sources", label: "Choose sources", icon: "fa-solid fa-books",
    hint: "Which compendiums, rules editions and books players can build and level up with in Mobile Deck, for all content or per type (classes, spells, backgrounds…).",
    type: SourcesMenu, restricted: true
  });
  game.settings.registerMenu(moduleId, "builderHouseRulesMenu", {
    name: "Character Builder: House Rules", label: "Set house rules", icon: "fa-solid fa-scroll",
    hint: "Multiclassing, banned classes or subclasses, ability score methods and language choices for Mobile Deck's character builder.",
    type: HouseRulesMenu, restricted: true
  });
}

/** A book switch: its name and how many items it holds. */
function bookBox(b, attrs, checked) {
  return node("label", { children: [
    node("input", { attrs: { type: "checkbox", ...attrs, checked } }),
    node("span", { text: `${b.key === NO_BOOK ? "No book listed" : b.key} ` }), node("small", { text: `(${b.count})` })
  ] });
}

/** One type's panel in the Sources window: the "Custom sources" switch, then its compendium and book lists (filled later). */
function typePanel(type, saved) {
  const custom = saved.types?.[type.key]?.custom === true;
  const lists = node("div", { className: "ve-builder-settings-type-lists", children: [
    node("h4", { text: "Compendiums" }),
    node("div", { className: "ve-builder-settings-books", dataset: { typePacks: "" }, text: "Reading the compendiums…" }),
    node("h4", { text: "Books" }),
    node("div", { className: "ve-builder-settings-books", dataset: { typeBooks: "" }, text: "Reading the compendiums…" })
  ] });
  lists.hidden = !custom;
  const toggle = node("input", { attrs: { type: "checkbox", "data-type-custom": "", checked: custom } });
  toggle.addEventListener("change", () => { lists.hidden = !toggle.checked; });
  return node("div", { className: "ve-builder-settings-type", dataset: { typePanel: type.key }, children: [
    node("label", { className: "ve-builder-settings-check", children: [toggle, node("span", { children: [
      node("strong", { text: `Custom sources for ${type.label.toLowerCase()}` }),
      node("small", { text: `Off: ${type.label.toLowerCase()} use the compendiums and books above.` })
    ] })] }),
    lists
  ] });
}

/**
 * Fill a type's compendium and book lists from every pack's index. Only packs and books that hold this type's
 * content are listed. A switch the GM never set for this type starts as the global one.
 */
function fillTypePanel(panel, packs, all, saved) {
  const key = panel.dataset.typePanel;
  const own = saved.types?.[key]?.custom ? saved.types[key] : {};
  const mine = all.filter(c => sourceType(c.entry) === key);
  const counts = new Map();
  for (const c of mine) counts.set(c.pack.collection, (counts.get(c.pack.collection) ?? 0) + 1);
  const packHost = panel.querySelector("[data-type-packs]");
  const packRows = packs.filter(p => counts.has(p.collection)).map(p => node("label", { children: [
    node("input", { attrs: { type: "checkbox", "data-type-pack": p.collection,
      checked: typeof own.packs?.[p.collection] === "boolean" ? own.packs[p.collection] : p.enabled } }),
    node("span", { text: `${p.label} ` }), node("small", { text: `(${counts.get(p.collection)})` })
  ] }));
  packHost.replaceChildren(...(packRows.length ? packRows : [node("p", { text: "No compendium holds this type." })]));
  const books = collectBooks(dedupe(mine));
  const bookHost = panel.querySelector("[data-type-books]");
  bookHost.replaceChildren(...(books.length ? books.map(b => bookBox(b, { "data-type-book": b.key },
    typeof own.books?.[b.key] === "boolean" ? own.books[b.key] : saved.books?.[b.key] !== false))
    : [node("p", { text: "No books found for this type." })]));
}

function menuClasses(moduleId) {
  const { ApplicationV2 } = globalThis.foundry.applications.api;

  class SourcesMenu extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "ve-builder-sources", tag: "form", classes: ["ve-builder-settings"],
      window: { title: "Character Builder: Sources", icon: "fa-solid fa-books", resizable: true },
      position: { width: 720, height: 760 },
      form: { handler: SourcesMenu.#save, closeOnSubmit: true },
      actions: { reset: SourcesMenu.#reset }
    };

    async _renderHTML() {
      ensureBuilderStyles();
      const saved = savedSources();
      const packs = packSettings();
      const rules = node("select", { attrs: { name: "rules" }, children: [
        ["world", `Same as this world (${worldRules()})`], ["2024", "2024 only"], ["2014", "2014 only"], ["both", "Both editions"]
      ].map(([value, label]) => node("option", { attrs: { value, selected: (saved.rules ?? "world") === value }, text: label })) });

      const rows = packs.map(p => node("tr", { dataset: { pack: p.collection }, children: [
        node("td", { children: [node("input", { attrs: { type: "checkbox", "data-field": "enabled", checked: p.enabled, "aria-label": `Use ${p.label}` } })] }),
        node("td", { children: [node("strong", { text: p.label }), node("small", { text: ` ${p.packageType}: ${p.packageName}` })] }),
        node("td", { children: [node("input", { attrs: { type: "number", step: "1", "data-field": "priority", value: p.priority, "aria-label": `${p.label} priority` } })] }),
        node("td", { children: [node("select", { attrs: { "data-field": "rules", "aria-label": `${p.label} edition` }, children: [
          ["", "Per item"], ["2024", "2024"], ["2014", "2014"]
        ].map(([value, label]) => node("option", { attrs: { value, selected: p.rules === value }, text: label })) })] }),
        node("td", { children: [node("select", { attrs: { "data-field": "tier", "aria-label": `${p.label} tier` }, children: [
          ["", "By book"], ["core", "Core"], ["expanded", "Expanded"], ["thirdParty", "3rd party"], ["homebrew", "Homebrew"]
        ].map(([value, label]) => node("option", { attrs: { value, selected: p.tier === value }, text: label })) })] })
      ] }));

      const books = node("div", { className: "ve-builder-settings-books", text: "Reading the compendiums…" });

      // Sources by type: one panel per type (all in the form, so Save sees every type); the dropdown shows one.
      const typePanels = SOURCE_TYPES.map(t => typePanel(t, saved));
      const typeSelect = node("select", { attrs: { "data-type-view": "", "aria-label": "Content type" }, children: SOURCE_TYPES.map(t => {
        const custom = saved.types?.[t.key]?.custom === true;
        return node("option", { attrs: { value: t.key }, text: custom ? `${t.label} (custom)` : t.label });
      }) });
      typeSelect.addEventListener("change", () => { for (const panel of typePanels) panel.hidden = panel.dataset.typePanel !== typeSelect.value; });
      typePanels.forEach((panel, i) => { panel.hidden = i !== 0; });
      this.#fillBooks(books, typePanels, packs, saved);

      return node("div", { className: "ve-builder-settings-body", children: [
        node("p", { className: "hint", text: "These apply to every player's level-up in Mobile Deck. A class's own features always come with it; if they come from a compendium you switch off, the same feature from an allowed compendium is used when there is one." }),
        node("fieldset", { children: [node("legend", { text: "Rules edition" }), rules] }),
        node("fieldset", { children: [
          node("legend", { text: "Compendiums" }),
          node("p", { className: "hint", text: "Untouched compendiums follow dnd5e's Compendium Browser sources. When the same item is in several, the highest priority wins. \"Edition\" tags items that don't say which rules they use; \"Tier\" sets the picker tag (Core, Expanded, 3rd party, Homebrew) for a whole compendium instead of reading it from each item's book." }),
          node("table", { children: [
            node("thead", { children: [node("tr", { children: ["Use", "Compendium", "Priority", "Edition", "Tier"].map(h => node("th", { text: h })) })] }),
            node("tbody", { children: rows })
          ] })
        ] }),
        node("fieldset", { children: [node("legend", { text: "Books" }), books] }),
        node("fieldset", { className: "ve-builder-settings-types", children: [
          node("legend", { text: "Sources by type" }),
          node("p", { className: "hint", text: "By default every type uses the compendiums and books above. Pick a type and switch on \"Custom sources\" to choose its own: for example spells from every book, but backgrounds only from the Player's Handbook. Priority, edition and tier stay as set above. Class and species features come with their class or species." }),
          node("label", { className: "ve-builder-settings-type-pick", children: [node("span", { text: "Type" }), typeSelect] }),
          ...typePanels
        ] }),
        node("footer", { className: "form-footer", children: [
          node("button", { attrs: { type: "button", "data-action": "reset" }, text: "Reset to defaults" }),
          node("button", { attrs: { type: "submit" }, text: "Save" })
        ] })
      ] });
    }

    _replaceHTML(result, content) { content.replaceChildren(result); }

    async #fillBooks(host, typePanels, packs, saved) {
      // Read every Item pack once: the global book list counts the enabled ones; each type lists every pack and book
      // that holds its content, since a type can switch on a compendium that is off for everything else.
      const all = [];
      for (const p of packs) {
        try { for (const entry of await packIndex(p.collection)) all.push({ entry, pack: p }); } catch { /* skip unreadable pack */ }
      }
      const list = collectBooks(dedupe(all.filter(c => c.pack.enabled)));
      host.replaceChildren(...(list.length ? list.map(b => bookBox(b, { "data-book": b.key }, saved.books?.[b.key] !== false))
        : [node("p", { text: "No books found in the enabled compendiums." })]));
      for (const panel of typePanels) fillTypePanel(panel, packs, all, saved);
    }

    static async #save(event, form) {
      const dnd5eSources = (() => { try { return game.settings.get("dnd5e", "packSourceConfiguration") ?? {}; } catch { return {}; } })();
      const packs = {};
      for (const row of form.querySelectorAll("tr[data-pack]")) {
        const collection = row.dataset.pack;
        const pack = game.packs.get(collection);
        const enabled = row.querySelector("[data-field=enabled]").checked;
        const priority = Number(row.querySelector("[data-field=priority]").value);
        const rules = row.querySelector("[data-field=rules]").value;
        const tier = row.querySelector("[data-field=tier]")?.value ?? "";
        const own = {};
        if (enabled !== (dnd5eSources[collection] !== false)) own.enabled = enabled;
        if (Number.isFinite(priority) && priority !== (DEFAULT_PRIORITY[pack?.metadata.packageType] ?? 0)) own.priority = priority;
        if (rules) own.rules = rules;
        if (tier) own.tier = tier;
        if (Object.keys(own).length) packs[collection] = own;
      }
      const books = { ...(savedSources().books ?? {}) };
      for (const box of form.querySelectorAll("input[data-book]")) {
        if (box.checked) delete books[box.dataset.book];
        else books[box.dataset.book] = false;
      }
      const types = {};
      for (const panel of form.querySelectorAll("[data-type-panel]")) {
        const key = panel.dataset.typePanel;
        if (!panel.querySelector("[data-type-custom]")?.checked) continue;
        // Start from what was saved, so switches whose list hadn't loaded yet keep their values.
        const prior = savedSources().types?.[key] ?? {};
        const own = { custom: true, packs: { ...(prior.packs ?? {}) }, books: { ...(prior.books ?? {}) } };
        for (const box of panel.querySelectorAll("input[data-type-pack]")) own.packs[box.dataset.typePack] = box.checked;
        for (const box of panel.querySelectorAll("input[data-type-book]")) own.books[box.dataset.typeBook] = box.checked;
        types[key] = own;
      }
      await game.settings.set(moduleId, SETTING_SOURCES, { rules: form.querySelector("[name=rules]").value, packs, books, types });
      clearContentCache();
      ui.notifications.info("Character Builder sources saved.");
    }

    static async #reset() {
      const ok = await foundry.applications.api.DialogV2.confirm({
        window: { title: "Reset sources?" }, content: "<p>Go back to dnd5e's Compendium Browser sources, default priorities, the world's rules edition and all books?</p>"
      });
      if (!ok) return;
      await game.settings.set(moduleId, SETTING_SOURCES, defaultSources());
      clearContentCache();
      this.render();
    }
  }

  class HouseRulesMenu extends ApplicationV2 {
    static DEFAULT_OPTIONS = {
      id: "ve-builder-house-rules", tag: "form", classes: ["ve-builder-settings"],
      window: { title: "Character Builder: House Rules", icon: "fa-solid fa-scroll", resizable: true },
      position: { width: 560, height: 700 },
      form: { handler: HouseRulesMenu.#save, closeOnSubmit: true }
    };

    async _renderHTML() {
      ensureBuilderStyles();
      const rules = currentHouseRules();
      const check = (name, label, hint, checked) => node("label", { className: "ve-builder-settings-check", children: [
        node("input", { attrs: { type: "checkbox", name, checked } }),
        node("span", { children: [node("strong", { text: label }), hint ? node("small", { text: hint }) : null] })
      ] });
      const classes = node("div", { className: "ve-builder-settings-books", text: "Reading the compendiums…" });
      this.#fillClasses(classes, rules);
      return node("div", { className: "ve-builder-settings-body", children: [
        node("fieldset", { children: [
          node("legend", { text: "Multiclassing" }),
          check("multiclass", "Allow multiclassing", "Players can add a second class when they level up.", rules.multiclass),
          check("multiclassPrerequisites", "Enforce the 13+ ability requirement", "2024 rule: 13 or more in the main abilities of every class. You can always override it yourself.", rules.multiclassPrerequisites)
        ] }),
        node("fieldset", { children: [node("legend", { text: "Classes and subclasses players can pick" }), classes] }),
        node("fieldset", { children: [
          node("legend", { text: "Ability scores (character creation)" }),
          check("method-standardArray", "Standard Array", "15, 14, 13, 12, 10, 8.", rules.abilityMethods.standardArray),
          check("method-pointBuy", "Point Buy", "27 points, scores 8–15.", rules.abilityMethods.pointBuy),
          check("method-roll", "Roll in Foundry", "Six rolls of 4d6, drop the lowest. The rolls go to chat.", rules.abilityMethods.roll),
          check("method-manual", "Enter my dice", "Players type six totals (3–18) from real dice. They go to chat.", rules.abilityMethods.manual),
          node("label", { className: "ve-builder-settings-check", children: [
            node("input", { attrs: { type: "number", name: "abilityRerolls", min: 0, max: 10, step: 1, value: rules.abilityRerolls, style: "width: 4em" } }),
            node("span", { children: [node("strong", { text: "Rerolls allowed" }), node("small", { text: "For Roll in Foundry. A reroll replaces all six numbers; every set stays in chat." })] })
          ] })
        ] }),
        node("fieldset", { children: [
          node("legend", { text: "GM approval" }),
          check("approval-creation", "New characters need GM approval", "Players' new characters wait for you in a popup with their Review list. Off: your client saves them as soon as a GM is online (players can't create actors themselves).", rules.approval.creation),
          check("approval-levelUp", "Level-ups need GM approval", "Players' level-ups wait for you in the same popup. Off: players commit their own level-ups; you still get the change log and can undo.", rules.approval.levelUp)
        ] }),
        node("fieldset", { children: [
          node("legend", { text: "Languages" }),
          check("anyLanguage", "Language choices: any language", "Every language choice offers every language in the world: standard, rare, Primordial dialects and languages other modules add (DDB Importer's, for example). Off: only the languages the background, species or class lists.", rules.anyLanguage)
        ] }),
        node("footer", { className: "form-footer", children: [node("button", { attrs: { type: "submit" }, text: "Save" })] })
      ] });
    }

    _replaceHTML(result, content) { content.replaceChildren(result); }

    async #fillClasses(host, rules) {
      // Allowed sources, ignoring current bans, so banned items can be switched back on.
      const { findEntries } = await import("./content-sources.mjs");
      const [classes, subclasses] = await Promise.all([findEntries(e => e.type === "class"), findEntries(e => e.type === "subclass")]);
      host.replaceChildren(...classes.map(cls => {
        const id = cls.system?.identifier ?? "";
        const subs = subclasses.filter(s => s.system?.classIdentifier === id);
        return node("div", { className: "ve-builder-settings-class", children: [
          node("label", { children: [node("input", { attrs: { type: "checkbox", "data-class": id, checked: !rules.bannedClasses.includes(id) } }),
            node("strong", { text: ` ${cls.name}` }), node("small", { text: ` ${cls.packLabel}` })] }),
          ...subs.map(s => node("label", { className: "ve-builder-settings-sub", children: [
            node("input", { attrs: { type: "checkbox", "data-subclass": s.system?.identifier ?? "", checked: !rules.bannedSubclasses.includes(s.system?.identifier ?? "") } }),
            node("span", { text: ` ${s.name}` })] }))
        ] });
      }));
    }

    static async #save(event, form) {
      const unchecked = attr => [...new Set([...form.querySelectorAll(`input[${attr}]`)].filter(b => !b.checked).map(b => b.getAttribute(attr)).filter(Boolean))];
      const methods = Object.fromEntries(["standardArray", "pointBuy", "roll", "manual"].map(m => [m, form.querySelector(`[name=method-${m}]`).checked]));
      if (!Object.values(methods).some(Boolean)) methods.standardArray = true; // at least one method stays on
      await game.settings.set(moduleId, SETTING_HOUSE_RULES, {
        multiclass: form.querySelector("[name=multiclass]").checked,
        multiclassPrerequisites: form.querySelector("[name=multiclassPrerequisites]").checked,
        bannedClasses: unchecked("data-class"),
        bannedSubclasses: unchecked("data-subclass"),
        abilityMethods: methods,
        abilityRerolls: Math.max(0, Math.min(10, Number(form.querySelector("[name=abilityRerolls]").value) || 0)),
        anyLanguage: form.querySelector("[name=anyLanguage]").checked,
        approval: { creation: form.querySelector("[name=approval-creation]").checked, levelUp: form.querySelector("[name=approval-levelUp]").checked }
      });
      ui.notifications.info("Character Builder house rules saved.");
    }
  }

  return { SourcesMenu, HouseRulesMenu };
}
