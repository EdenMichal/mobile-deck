/**
 * Pure: turn dnd5e 5.3.2 starting-equipment entries (`system.startingEquipment` as plain
 * objects) and `system.wealth` into the Equipment tab's option cards, as dnd5e's own
 * getStartingEquipmentDescription reads them: a single top-level OR lists the options, otherwise all
 * top-level entries are option A; wealth is the last, gold-only option.
 * Spec §2.5, §3.2; research §2.2. Unit-tested in tests/equipment-options.test.mjs.
 */
const LETTERS = "ABCDEFGHIJ";
const CATEGORY_TYPES = new Set(["weapon", "armor", "tool", "focus"]);

// dnd5e 5.3.2 stores top-level entries with group "" (not null): both mean "no parent".
const childrenOf = (entries, id) => entries.filter(e => (e.group || null) === (id || null)).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0));

/** One-child ORs are fixed items in disguise (Druid's quarterstaff, Sorcerer's crystal). */
function collapse(entries, entry) {
  let current = entry;
  while (current?.type === "OR") {
    const kids = childrenOf(entries, current._id);
    if (kids.length !== 1) break;
    current = kids[0];
  }
  return current;
}

const COIN = /(\d[\d,]*)\s*(pp|gp|ep|sp|cp)\b/gi;

const COIN_END = /(?:^|\s)(\d[\d,]*)\s*(pp|gp|ep|sp|cp)$/i;
const COIN_ONLY = /^(\d[\d,]*)\s*(pp|gp|ep|sp|cp)$/i;

/**
 * The coins an option ends with: its last comma part when that part ends in an amount ("…, Traveler's Clothes, 14 GP",
 * "…, and a pouch containing 15 gp"), and the plain amounts just before it ("8 GP, 5 SP"). Coins inside an item
 * ("a Gem worth 10 GP", "Ink (worth 10 gp)") don't count.
 */
function endingCoins(part) {
  const out = {};
  const pieces = String(part).replace(/[\s;,.]*(\bor\b)?[\s;,.]*$/i, "").split(/,\s+/); // "1,000 gp" keeps its comma
  for (let i = pieces.length - 1; i >= 0; i--) {
    const piece = pieces[i].trim().replace(/^and\s+/i, "").replace(/[.;]+$/, "").trim();
    const m = piece.match(COIN_END);
    if (!m || /\bworth\b/i.test(piece)) break;
    const value = Number(m[1].replace(/,/g, ""));
    if (value) out[m[2].toLowerCase()] = (out[m[2].toLowerCase()] ?? 0) + value;
    if (!COIN_ONLY.test(piece)) break;
  }
  return out;
}

/**
 * Coins named in a book equipment line, by option letter: "(A) Spear, …, 14 GP; or (B) 50 GP" → { A: { gp: 14 }, B: { gp: 50 } };
 * a line without lettered options ("…, and a pouch containing 15 gp") → { "": { gp: 15 } }. Only the amount an option
 * ends with counts (endingCoins). Reads dnd5e's SRD text and DDB Importer's ("Choose A or B: (A) …, 8 GP; or (B) 50 GP",
 * any case, "1,000 gp"); `text` is plain (equipmentBookText).
 */
export function bookCoins(text = "") {
  const line = String(text ?? "");
  const out = {};
  const add = (key, part) => {
    const coins = endingCoins(part);
    if (Object.keys(coins).length) out[key] = coins;
  };
  const marks = [...line.matchAll(/\(([A-J])\)/g)];
  if (!marks.length) { add("", line); return out; }
  marks.forEach((m, i) => add(m[1], line.slice(m.index + m[0].length, marks[i + 1]?.index ?? line.length)));
  return out;
}

/**
 * Lettered options of a book line that hold nothing but coins: "(A) Leatherworker's Tools, …, 8 GP; or (B) 50 GP" →
 * [{ letter: "B", gp: 50 }]. For items whose equipment is only text (DDB's TCMP1 backgrounds): the gold option stays.
 */
export function bookGoldOptions(text = "") {
  const line = String(text ?? "");
  const marks = [...line.matchAll(/\(([A-J])\)/g)];
  const out = [];
  marks.forEach((m, i) => {
    const part = line.slice(m.index + m[0].length, marks[i + 1]?.index ?? line.length);
    const rest = part.replace(COIN, "").replace(/\b(or|and)\b/gi, "").replace(/[\s,;.:]+/g, "");
    const coins = bookCoins(`(${m[1]}) ${part}`)[m[1]];
    if (!rest && coins?.gp && Object.keys(coins).length === 1) out.push({ letter: m[1], gp: coins.gp });
  });
  return out;
}

/** "5d4 * 10" → "5d4 × 10" for the card (the formula rolled is unchanged). */
export const formulaLabel = formula => String(formula ?? "").trim().replace(/\s*\*\s*/g, " × ");

/**
 * [{ id: "A", kind: "package", roots: [entryId…], coins? }, …, { id, kind: "gold", formula, gp }]
 * `bookText`: the item's equipment line. dnd5e 5.3.2's 2024 backgrounds store no currency entry ("…, 14 GP" is only in
 * the text), so when no entry holds coins, each package takes the coins its letter names in the book (`coins`).
 */
export function equipmentOptions(entries = [], wealth = "", { bookText = "" } = {}) {
  const top = childrenOf(entries, null);
  const options = [];
  const single = top.length === 1 ? collapse(entries, top[0]) : null;
  if (single?.type === "OR") childrenOf(entries, single._id).forEach(child => options.push({ kind: "package", roots: [child._id] }));
  else if (top.length) options.push({ kind: "package", roots: top.map(t => t._id) });
  const formula = String(wealth ?? "").trim();
  if (formula) {
    const gp = /^\d+(\.\d+)?$/.test(formula) ? Number(formula) : null;
    options.push({ kind: "gold", formula, gp });
  }
  // Nothing stored at all, only book text: its coins-only options can still be taken (TCMP1: "(B) 50 GP").
  if (!options.length && bookText) bookGoldOptions(bookText).forEach(g => options.push({ kind: "gold", formula: String(g.gp), gp: g.gp }));
  const lettered = options.map((o, i) => ({ id: LETTERS[i], ...o }));
  if (bookText && !entries.some(e => e.type === "currency")) {
    const coins = bookCoins(bookText);
    const packages = lettered.filter(o => o.kind === "package");
    for (const o of packages) {
      const found = coins[o.id] ?? (packages.length === 1 && !Object.keys(coins).some(k => k) ? coins[""] : null);
      if (found) o.coins = { ...found };
    }
  }
  return lettered;
}

/** What a package holds: fixed items, coins, "any X" picks and nested choices. */
export function packageContents(entries = [], option = {}) {
  const out = { items: [], coins: {}, picks: [], choices: [] };
  const byId = new Map(entries.map(e => [e._id, e]));
  const walk = entry => {
    const e = collapse(entries, entry);
    if (!e) return;
    if (e.type === "AND") { childrenOf(entries, e._id).forEach(walk); return; }
    if (e.type === "OR") {
      out.choices.push({ id: e._id, options: childrenOf(entries, e._id).map(c => ({ id: c._id, ...packageContents(entries, { roots: [c._id] }) })) });
      return;
    }
    if (e.type === "linked" && e.key) out.items.push({ id: e._id, uuid: e.key, count: Number(e.count) || 1, requiresProficiency: Boolean(e.requiresProficiency) });
    else if (e.type === "currency" && e.key) out.coins[e.key] = (out.coins[e.key] ?? 0) + (Number(e.count) || 0);
    else if (CATEGORY_TYPES.has(e.type)) out.picks.push({ id: e._id, type: e.type, key: e.key ?? "", count: Number(e.count) || 1 });
  };
  for (const id of option.roots ?? []) if (byId.has(id)) walk(byId.get(id));
  // Coins read from the book text (equipmentOptions), when no entry holds them.
  for (const [k, v] of Object.entries(option.coins ?? {})) out.coins[k] = (out.coins[k] ?? 0) + (Number(v) || 0);
  return out;
}

/** Contents with the player's nested choices resolved; `unresolved` lists choices still open. */
export function resolveContents(entries = [], option = {}, answer = {}) {
  const base = packageContents(entries, option);
  const merged = { items: [...base.items], coins: { ...base.coins }, picks: [...base.picks], unresolved: [] };
  for (const choice of base.choices) {
    const picked = choice.options.find(o => o.id === answer.choices?.[choice.id]);
    if (!picked) { merged.unresolved.push(choice.id); continue; }
    const inner = resolveContents(entries, { roots: [picked.id] }, answer);
    merged.items.push(...inner.items);
    merged.picks.push(...inner.picks);
    merged.unresolved.push(...inner.unresolved);
    for (const [k, v] of Object.entries(inner.coins)) merged.coins[k] = (merged.coins[k] ?? 0) + v;
  }
  return merged;
}

/** Is this source's equipment fully chosen? Gold always is; a package needs every choice and pick. */
export function equipmentComplete(entries = [], option = null, answer = {}) {
  if (!option) return false;
  if (option.kind === "gold") return true;
  const r = resolveContents(entries, option, answer);
  return !r.unresolved.length && r.picks.every(p => Boolean(answer.picks?.[p.id]));
}

/**
 * The picks that count: a saved pick that is no longer one of its candidates is dropped (a linked
 * proficiency changed since), and a pick with exactly one candidate needs no tap (a linked
 * proficiency, a lone focus). `picks` are [{ id, candidates: [{ uuid }] }].
 */
export function effectivePicks(answer = {}, picks = []) {
  const out = { ...answer, picks: {} };
  for (const p of picks) {
    const uuids = (p.candidates ?? []).map(c => c.uuid);
    const saved = answer.picks?.[p.id];
    if (saved && uuids.includes(saved)) out.picks[p.id] = saved;
    else if (uuids.length === 1) out.picks[p.id] = uuids[0];
  }
  return out;
}

/** Card text: "Explorer's Pack, 4× Handaxe, 15 GP" or "75 GP". */
export function optionLabel(entries = [], option = {}, { nameOf = uuid => uuid, categoryOf = pick => pick.key } = {}) {
  if (option.kind === "gold") return `${option.gp ?? formulaLabel(option.formula)} GP`;
  const describe = c => [
    ...c.items.map(i => `${i.count > 1 ? `${i.count}× ` : ""}${nameOf(i.uuid)}`),
    ...c.picks.map(p => `${p.count > 1 ? `${p.count}× ` : ""}${categoryOf(p)}`),
    ...c.choices.map(ch => `(${ch.options.map(describe).join(" or ")})`),
    ...Object.entries(c.coins).filter(([, n]) => n).map(([k, n]) => `${n} ${k.toUpperCase()}`)
  ].join(", ");
  return describe(packageContents(entries, option));
}

/** Tool ids chosen as proficiencies in a category ("tool:music:lute" → "lute"), so the pick follows them. */
export function linkedToolIds(chosen = [], category = "") {
  if (!category) return [];
  const prefix = `tool:${category}:`;
  return [...new Set(chosen.filter(k => String(k).startsWith(prefix)).map(k => String(k).slice(prefix.length)).filter(id => id && id !== "*"))];
}

/** The item's own equipment line from its description (the book text), or "". */
export function equipmentBookText(html = "") {
  const lines = String(html)
    .replace(/<\/(p|li|tr|h\d|dt|dd|div)>|<br\s*\/?>/gi, "\n").replace(/<\/t[dh]>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/@\w+\[[^\]]*\]\{([^}]*)\}/g, "$1").replace(/@\w+\[([^\]]*)\]/g, "$1")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&times;/g, "×")
    .split("\n").map(l => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const index = lines.findIndex(l => /^(starting )?equipment\b/i.test(l) || /\bstarting equipment\b/i.test(l));
  if (index < 0) return "";
  const line = lines[index];
  return /^(starting )?equipment:?$/i.test(line) && lines[index + 1] ? `${line} ${lines[index + 1]}` : line;
}

const BODY_ARMOR = new Set(["light", "medium", "heavy"]);

/** AC a piece of body armor gives: its value plus DEX up to its cap (heavy armor: none at all). */
export function armorClassWith(item, dexMod = 0) {
  const type = item?.system?.type?.value;
  const cap = item?.system?.armor?.dex;
  const dex = type === "heavy" ? 0 : cap === null || cap === undefined || cap === "" ? dexMod : Math.min(dexMod, Number(cap) || 0);
  return (Number(item?.system?.armor?.value) || 0) + dex;
}

const twoHanded = item => {
  const props = item?.system?.properties;
  return Array.isArray(props) ? props.includes("two") : props instanceof Set ? props.has("two") : Boolean(props?.two);
};

/**
 * What to wear and wield from the starting gear, as D&D Beyond does. Items inside a container stay packed.
 * - Body armor: the one with the best AC among armor the character is trained with and strong enough for (its
 *   Strength requirement), and only if it beats Unarmored Defense (`unarmored`: { ac, shield } for a Barbarian, whose
 *   defense allows a shield, or a Monk, whose doesn't).
 * - Shield (if trained): worn with a one-handed weapon, which then stays in hand while two-handed ones are put away;
 *   with only two-handed weapons the shield stays unequipped.
 * - Weapons: all of them, apart from the above.
 * `items` are plain item data; `proficient(item)` says whether the character is trained with it. Returns indexes.
 */
export function startingEquipped(items = [], { dexMod = 0, strength = Infinity, proficient = () => true, unarmored = null } = {}) {
  const loose = items.map((item, index) => ({ item, index })).filter(({ item }) => !item?.system?.container);
  const weapons = loose.filter(({ item }) => item.type === "weapon");
  const out = [];
  const usable = ({ item }) => proficient(item) && (Number(item.system?.strength) || 0) <= strength;
  const worn = loose.filter(({ item }) => item.type === "equipment" && BODY_ARMOR.has(item.system?.type?.value) && usable({ item }))
    .sort((a, b) => armorClassWith(b.item, dexMod) - armorClassWith(a.item, dexMod))[0];
  if (worn && !(unarmored && unarmored.ac >= armorClassWith(worn.item, dexMod))) out.push(worn.index);
  const wearsArmor = out.length > 0;
  const shield = loose.find(({ item }) => item.type === "equipment" && item.system?.type?.value === "shield" && proficient(item));
  const oneHanded = weapons.filter(({ item }) => !twoHanded(item));
  const shieldAllowed = shield && oneHanded.length && (wearsArmor || !unarmored || unarmored.shield);
  if (shieldAllowed) out.push(shield.index, ...oneHanded.map(w => w.index));
  else out.push(...weapons.map(w => w.index));
  return out.sort((a, b) => a - b);
}
