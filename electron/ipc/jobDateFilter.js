/**
 * Parses the wide variety of "posted" strings job sources return so we can
 * apply a max-age filter client-side for sources without a URL date param.
 *
 * Unparseable entries are KEPT — we'd rather over-show than silently drop a
 * relevant listing because the source uses some format we missed.
 */

// Relative-unit token → day multiplier. Each pattern is fully anchored (^…$)
// so a token matches EXACTLY its set — there's no "starts-with-mo" overlap
// between months ("mo") and minutes ("m"), which is the disambiguation the old
// unanchored /^mo/ etc. relied on alternation luck to get right. Hours and
// minutes map to 0 (same calendar day). The matcher regex below lists each
// family longest-first so a short unit never shadows a longer one.
const UNIT_TO_DAYS = [
  [/^(?:months?|mo)$/, 30],
  [/^(?:weeks?|w)$/, 7],
  [/^(?:days?|d)$/, 1],
  [/^(?:hours?|h|minutes?|mins?|m)$/, 0],
];

export function parsePostedDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;

  // Skip the lenient Date.parse for a bare number ('5' → V8 reads it as a
  // year/month, '2024' → a year). Those aren't real posted dates; let them
  // fall through to the relative-unit matcher (which won't match) → null,
  // rather than fabricating a date decades off.
  if (!/^\d+$/.test(s)) {
    const iso = Date.parse(s);
    if (!isNaN(iso)) return new Date(iso);
  }

  const lower = s.toLowerCase();
  if (lower === 'today' || lower === 'just posted' || lower === 'just now' || lower.includes('active today')) {
    return new Date();
  }
  if (lower === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }

  // "Nd ago" / "N days ago" / "Nh ago" / "N weeks ago" / "N months ago"
  // Note: bare "Nm" is treated as minutes (matches the LinkedIn/Twitter
  // convention); "Nmo" is months. Both are recent enough that any reasonable
  // maxAgeDays will keep them.
  // Longest-first within each family (months? before mo, weeks? before w, …)
  // so the engine never grabs a short prefix when a longer unit is present —
  // correctness no longer depends on the trailing \b alone.
  // `\+?` tolerates LinkedIn's oldest-bucket literal "30+ days ago" (treated as
  // exactly 30 days — the conservative floor, so any maxAgeDays < 30 drops it).
  const m = lower.match(/(\d+)\+?\s*(months?|mo|weeks?|w|days?|d|hours?|h|minutes?|mins?|m)\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2];
    const mult = UNIT_TO_DAYS.find(([re]) => re.test(unit))?.[1] ?? 0;
    const d = new Date();
    d.setDate(d.getDate() - n * mult);
    return d;
  }
  return null;
}

export function filterJobsByAge(jobs, maxAgeDays) {
  if (!maxAgeDays || maxAgeDays <= 0) return jobs;
  const cutoff = Date.now() - maxAgeDays * 86400000;
  return jobs.filter(j => {
    const d = parsePostedDate(j.posted);
    if (!d) return true;
    return d.getTime() >= cutoff;
  });
}
