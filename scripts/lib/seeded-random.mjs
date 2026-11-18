// One seeded generator for the A/B scripts, so the same --seed draws the same rows in every tool.

/** A mulberry32 generator: a function returning numbers in [0, 1). */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle of a copy of the list. */
export function shuffle(list, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy;
}

/** The first `count` items of a shuffled copy; a negative count draws nothing. */
export function sample(list, count, random) {
  return shuffle(list, random).slice(0, Math.max(0, count));
}
