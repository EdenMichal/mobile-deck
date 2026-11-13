/**
 * Pure: the limits the ability-score screen enforces, matching dnd5e 5.3.2's
 * AbilityScoreImprovementAdvancement (points, per-ability cap, locked abilities,
 * fixed increases, score maximum).
 *
 * @param {object} config   { points, cap, fixed: {str: 1}, locked: ["cha"], max }
 * @param {object} scores   { str: { value, max }, ... } before this step
 * @param {object} assigned { str: 1, ... } the player's current picks (excluding fixed)
 * @param {(key: string) => boolean} [canImprove]
 */
export function asiState(config, scores, assigned = {}, canImprove = () => true) {
  const points = Number(config?.points) || 0;
  const cap = Number(config?.cap) || 2;
  const fixed = config?.fixed ?? {};
  const locked = new Set(config?.locked ?? []);
  const used = Object.entries(assigned).reduce((n, [k, v]) => n + (canImprove(k) ? Number(v) || 0 : 0), 0);
  const remaining = Math.max(0, points - used);
  const abilities = {};
  for (const [key, score] of Object.entries(scores ?? {})) {
    const base = Number(score?.value) || 0;
    const maxScore = Math.max(Number(score?.max) || 20, Number(config?.max) || -Infinity);
    const fix = Number(fixed[key]) || 0;
    const pick = Number(assigned[key]) || 0;
    const value = Math.min(base + fix + pick, maxScore);
    const improvable = canImprove(key) && !locked.has(key);
    abilities[key] = {
      base, fixed: fix, assigned: pick, value, max: maxScore, locked: !improvable,
      canIncrease: improvable && remaining > 0 && pick < cap && value < maxScore,
      canDecrease: improvable && pick > 0
    };
  }
  return { points, used, remaining, cap, abilities, complete: remaining === 0 || Object.values(abilities).every(a => !a.canIncrease) };
}

/** Assignments to send to apply(): fixed increases plus the player's picks, zeros dropped. */
export function asiAssignments(config, assigned = {}) {
  const out = {};
  for (const [k, v] of Object.entries(config?.fixed ?? {})) if (Number(v)) out[k] = Number(v);
  for (const [k, v] of Object.entries(assigned)) if (Number(v)) out[k] = (out[k] ?? 0) + Number(v);
  return out;
}

/** 2024 multiclassing: 13+ in the primary abilities of every current class and the new one. */
export function multiclassBlockers(classes, abilities, threshold = 13) {
  const blockers = [];
  for (const cls of classes) {
    const keys = cls.primaryAbility ?? [];
    if (!keys.length) continue;
    const ok = cls.allRequired === false
      ? keys.some(k => (abilities[k] ?? 0) >= threshold)
      : keys.every(k => (abilities[k] ?? 0) >= threshold);
    if (!ok) blockers.push({ name: cls.name, abilities: keys, any: cls.allRequired === false });
  }
  return blockers;
}

/**
 * L20 fix 12: what is wrong with an ASI answer, checked by the engine (not only the screen): more points than the step
 * gives, more than the per-ability cap, a locked ability, or a score pushed past its maximum (those points would be
 * lost: dnd5e applies only up to the maximum). [] when it fits.
 * @param {object} config       { points, cap, fixed, locked, max }
 * @param {object} scores       { str: { value, max }, ... } before this step
 * @param {object} assignments  The answer's assignments (fixed increases included, as asiAssignments sends them)
 */
export function asiAnswerProblems(config, scores, assignments = {}, canImprove = () => true) {
  const points = Number(config?.points) || 0;
  const cap = Number(config?.cap) || 2;
  const fixed = config?.fixed ?? {};
  const locked = new Set(config?.locked ?? []);
  const problems = [];
  let used = 0;
  for (const [key, raw] of Object.entries(assignments ?? {})) {
    const total = Number(raw) || 0;
    const pick = total - (Number(fixed[key]) || 0);
    if (pick <= 0) continue;
    used += pick;
    const score = scores?.[key];
    if (!score || locked.has(key) || !canImprove(key)) { problems.push({ key, reason: "locked" }); continue; }
    if (pick > cap) problems.push({ key, reason: "cap", cap });
    const max = Math.max(Number(score.max) || 20, Number(config?.max) || -Infinity);
    if ((Number(score.value) || 0) + total > max) problems.push({ key, reason: "max", max });
  }
  if (used > points) problems.push({ key: "", reason: "points", points });
  return problems;
}
