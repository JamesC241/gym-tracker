/*
 * progression.js — the rules for "how did I do vs last time" and the
 * "add weight" suggestion. Kept in one small file so they're easy to tweak.
 *
 * Your sets go to failure, so the rule is: if your FIRST working set last
 * time reached REP_CEILING reps or more, suggest adding INCREMENT_KG.
 */

export const REP_CEILING = 12;   // reps on set 1 that trigger the suggestion
export const INCREMENT_KG = 2.5; // how much weight to suggest adding

/**
 * Returns a short suggestion string, or null for no suggestion.
 * @param exercise  the exercise record ({ bodyweight, ... })
 * @param lastSets  sets from the previous session of this exercise, or null
 */
export function progressionHint(exercise, lastSets) {
  if (!lastSets || !lastSets.length) return null;
  if (exercise.bodyweight) return null; // weight is your bodyweight, nothing to add
  const first = lastSets[0];
  if (first.kg == null || first.reps == null) return null;
  if (first.reps >= REP_CEILING) {
    return `Set 1 hit ${first.reps} reps last time — try ${round(first.kg + INCREMENT_KG)} kg`;
  }
  return null;
}

/**
 * Compare one set today with the same-numbered set last time.
 * Returns { cls: 'up' | 'down' | 'same', label } or null if not comparable.
 * Same weight, or a bodyweight exercise → compare reps.
 * Different weight → compare estimated 1-rep max.
 */
export function compareSet(now, last, isBodyweight = false) {
  if (!now || !last || now.reps == null || now.kg == null || last.reps == null || last.kg == null) return null;
  if (now.kg === last.kg || isBodyweight) {
    const d = now.reps - last.reps;
    if (d > 0) return { cls: 'up', label: `+${d}` };
    if (d < 0) return { cls: 'down', label: `${d}`.replace('-', '−') };
    return { cls: 'same', label: '=' };
  }
  const d = e1rm(now.kg, now.reps) - e1rm(last.kg, last.reps);
  if (Math.abs(d) < 0.01) return { cls: 'same', label: '=' };
  return d > 0 ? { cls: 'up', label: '▲' } : { cls: 'down', label: '▼' };
}

/** Estimated one-rep max (Epley formula). Used for comparisons and the chart. */
export function e1rm(kg, reps) {
  if (!reps) return 0;
  return kg * (1 + reps / 30);
}

const round = (n) => Math.round(n * 100) / 100;
