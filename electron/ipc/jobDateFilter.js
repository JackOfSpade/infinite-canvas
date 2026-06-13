/**
 * Parses the wide variety of "posted" strings job sources return so we can
 * apply a max-age filter client-side for sources without a URL date param.
 *
 * Unparseable entries are KEPT — we'd rather over-show than silently drop a
 * relevant listing because the source uses some format we missed.
 */

// ── Single source of truth for relative-date units ──────────────────────────
// One table drives all three consumers that previously each kept their own
// list (and drifted: the harvest pattern captured "second/year/posted today"
// that the parser couldn't convert, so a "Posted today" job parsed to null and
// sorted BEHIND month-old jobs, and "2 years ago" leaked through the age
// filter):
//   1. POSTED_DATE_PATTERN — the browser-injected harvest regex (manualScraper)
//   2. the relative matcher inside parsePostedDate
//   3. the unit→days multiplier
// Each family lists its tokens longest-first so a short unit never shadows a
// longer one ("months?" before "mo" before bare "m"); the day count rides
// alongside so a token can never exist without a conversion.
const UNIT_FAMILIES = [
  { tokens: ['years?', 'yrs?', 'y'], days: 365 },
  { tokens: ['months?', 'mo'], days: 30 },
  { tokens: ['weeks?', 'w'], days: 7 },
  { tokens: ['days?', 'd'], days: 1 },
  // Hours / minutes / seconds → same calendar day. Bare "m" is minutes
  // (LinkedIn/Twitter convention); "mo" above wins for months.
  { tokens: ['hours?', 'h', 'minutes?', 'mins?', 'm', 'seconds?', 'secs?', 's'], days: 0 },
];
const UNIT_ALTERNATION = UNIT_FAMILIES.flatMap(f => f.tokens).join('|');
const UNIT_TO_DAYS = UNIT_FAMILIES.map(f => [new RegExp(`^(?:${f.tokens.join('|')})$`), f.days]);

// "Fresh right now" phrases with no number to convert — parsed as today.
// HARVEST_TODAY_PHRASES feed the browser-injected pattern and deliberately
// EXCLUDE bare "today": page prose ("Apply today!") would match it and stamp a
// stale job as fresh. The parser additionally accepts bare "today" because
// structured extractors hand it over as the complete posted string.
const HARVEST_TODAY_PHRASES = ['just posted', 'posted today', 'just now'];
const TODAY_PHRASES = [...HARVEST_TODAY_PHRASES, 'today'];

// Relative-date pattern for the visible "Posted X ago" label some detail pages
// expose with NO structured date (verified on ZipRecruiter's /jobs/{co}/{slug}
// pages: no JSON-LD / __NEXT_DATA__ / <time>). A source string so it can be both
// injected into a browser-context evaluate (manualScraper's description harvest)
// AND unit-tested here against parsePostedDate. Built from the SAME unit table
// the parser consumes, so the harvest can never capture a phrase the parser
// can't convert. Captures the clean phrase — "28 days ago", "just posted", etc.
export const POSTED_DATE_PATTERN =
  `(\\d+\\+?\\s*(?:${UNIT_ALTERNATION})\\s*ago|${HARVEST_TODAY_PHRASES.join('|').replace(/ /g, '\\s*')})`;

// `\b` after the unit so "3 saturdays" can't match bare "s"; longest-first
// within each family so the engine never grabs a short prefix when a longer
// unit is present.
const RELATIVE_MATCHER = new RegExp(`(\\d+)\\+?\\s*(${UNIT_ALTERNATION})\\b`);

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
  // 'active today' arrives embedded in longer Indeed strings → substring match;
  // the standalone phrases ('posted today', 'just posted', …) match exactly,
  // with whitespace collapsed because the harvest pattern's `\s*` can capture
  // doubled spaces ("posted  today") verbatim.
  const norm = lower.replace(/\s+/g, ' ');
  if (TODAY_PHRASES.includes(norm) || lower.includes('active today')) {
    return new Date();
  }
  if (lower === 'yesterday') {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return d;
  }

  // "Nd ago" / "N days ago" / "Nh ago" / "N weeks ago" / "N months ago" …
  // `\+?` tolerates LinkedIn's oldest-bucket literal "30+ days ago" (treated as
  // exactly 30 days — the conservative floor, so any maxAgeDays < 30 drops it).
  const m = lower.match(RELATIVE_MATCHER);
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
