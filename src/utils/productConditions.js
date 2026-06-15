/**
 * Single source of truth for the marketplace condition tiers.
 *
 * Shared by the renderer (the SellHub draft dropdown + tooltips) and the main
 * process (the photo-analysis & price-synthesis AI prompts, and the response
 * schema in aiSchemas.js). `electron/` already imports from `src/utils/`, so one
 * definition here keeps the human and the pricing AI agreeing on what each tier
 * means — previously the AI received only the bare label (e.g. "Used - Good")
 * and had to guess what it encompassed.
 *
 * WHY THESE SIX, AND WHY NOT RENAME THEM:
 * There is no single cross-platform condition standard — every marketplace
 * invented its own scale. These six are deliberately the de-facto resale middle
 * ground: they mirror Depop's grades almost exactly and map cleanly onto every
 * connected platform (eBay folds the middle three into one "Used"; Mercari uses
 * New/Like New/Good/Fair/Poor; Swappa New/Mint/Good/Fair; Reverb Brand New/Mint/
 * Excellent/Very Good/Good/Fair/Poor/Non-Functioning). The `value` strings are
 * persisted on saved canvases and fed to the AI verbatim — do NOT rename them
 * without a node migration (see the migration framework).
 *
 * `platforms` records each tier's nearest native equivalent on the platforms we
 * route to, so the AI (and the user) can reason about how our grade translates
 * when listing. Sources: each platform's own seller/condition help pages.
 */
export const PRODUCT_CONDITIONS = [
  {
    value: 'New',
    summary: 'Brand-new and unused, in original packaging.',
    includes: 'Never used or owned; original box, tags, and seals intact; all original accessories present; unactivated/unregistered.',
    excludes: 'Open-box, display or demo units, "tried once," refurbished, or anything used after unsealing.',
    platforms: 'eBay New · Facebook New · Mercari New · Depop Brand new · Swappa New · Reverb Brand New · Poshmark NWT',
  },
  {
    value: 'Like New',
    summary: 'No visible signs of use — but, unlike "New," it MAY have been opened or used lightly. What disqualifies it is wear, not use.',
    includes: 'Open-box / display units (opened but never used) AND items used a few times that left no marks; no scratches, scuffs, or blemishes anywhere; works flawlessly; original packaging/accessories ideally still included. Most platforms file this under "Used."',
    excludes: 'A still-sealed, never-opened item (that is "New"); and any visible wear at all, even a single faint scratch (that is "Used - Excellent").',
    platforms: 'eBay Open box · Facebook Used – Like New · Mercari Like New · Depop Used – like new · Swappa Mint · Reverb Mint',
  },
  {
    value: 'Used - Excellent',
    summary: 'Used and very well cared for; only the faintest wear, visible on close inspection.',
    includes: 'Light use with great care; at most micro-scratches or hairline marks you have to look for; 100% functional; nothing missing.',
    excludes: 'Noticeable scratches, dents, screen blemishes, or any functional issue (those are "Used - Good" or lower).',
    platforms: 'eBay Used · Facebook Used – Like New/Good · Mercari Good · Depop Used – excellent · Swappa Good · Reverb Excellent',
  },
  {
    value: 'Used - Good',
    summary: 'Honest everyday-used condition — visible light wear, fully functional. The default for most used items.',
    includes: 'Normal signs of use: light scratches, minor scuffs, small dings; works exactly as intended; all core parts present.',
    excludes: 'Cracks, dents that affect use, missing core components, or any functional defect.',
    platforms: 'eBay Used · Facebook Used – Good · Mercari Good · Depop Used – good · Swappa Good · Reverb Very Good/Good',
  },
  {
    value: 'Used - Fair',
    summary: 'Heavy cosmetic wear or minor quirks, but still works for its main purpose.',
    includes: 'Significant wear — deep scratches, dents, scuffing, faded finish, a cracked-but-working screen; minor quirks that don\'t stop core use; everything essential still functions.',
    excludes: 'Items that won\'t power on, are missing core functionality, or are sold for repair (those are "For Parts").',
    platforms: 'eBay Used · Facebook Used – Fair · Mercari Fair · Depop Used – fair · Swappa Fair (must still be 100% functional) · Reverb Fair',
  },
  {
    value: 'For Parts',
    summary: 'Does not fully work — sold for components or repair.',
    includes: 'Won\'t power on, a major defect, missing essential components, water damage, or a cracked non-working screen; the buyer expects it NOT to work as intended.',
    excludes: 'Anything that powers on and performs its main function (that is "Used - Fair").',
    platforms: 'eBay For parts or not working · Mercari Poor · Reverb Poor/Non-Functioning · (not allowed on Swappa; no Facebook/Depop equivalent — disclose clearly or skip those)',
  },
];

/** Ordered tier labels — for the dropdown options and the schema enum. */
export const CONDITION_VALUES = PRODUCT_CONDITIONS.map((c) => c.value);

/** Sensible fallback when an item has no recognized condition yet. */
export const DEFAULT_CONDITION = 'Used - Good';

const CONDITION_BY_VALUE = new Map(PRODUCT_CONDITIONS.map((c) => [c.value, c]));

/** Look up a tier's full definition, or null if the value isn't one of ours. */
export function getConditionDef(value) {
  return CONDITION_BY_VALUE.get(value) || null;
}

/**
 * The full tier guide, for the photo-analysis prompt where the AI must PICK the
 * right condition from photos. Lists every tier with what it includes/excludes.
 */
export function formatConditionGuideForPrompt() {
  return PRODUCT_CONDITIONS
    .map((c) => `- "${c.value}": ${c.summary} INCLUDES: ${c.includes} DOES NOT INCLUDE: ${c.excludes}`)
    .join('\n');
}

/**
 * One already-chosen tier's definition, for the price-synthesis prompt — so the
 * model anchors its comp adjustments to the same meaning the seller intended,
 * and knows the equivalent grade on each platform it scraped.
 */
export function formatConditionForPricingPrompt(value) {
  const c = CONDITION_BY_VALUE.get(value);
  if (!c) return value ? `${value} (no standard definition on file — interpret literally)` : 'Unknown';
  return `${c.value} — ${c.summary}\n  Includes: ${c.includes}\n  Does not include: ${c.excludes}\n  Equivalent tiers on other platforms: ${c.platforms}`;
}

const EXPLICIT_TITLE_CONDITION = [
  'brand[ -]?new',
  'new\\s+in\\s+(?:box|original\\s+packaging)',
  'new\\s+with(?:out)?\\s+tags',
  'nwt',
  'nwot',
  'open[ -]?box',
  'like[ -]?new',
  'mint\\s+condition',
  'excellent\\s+condition',
  'very\\s+good\\s+condition',
  'good\\s+condition',
  'fair\\s+condition',
  'poor\\s+condition',
  'used\\s*[-–—/]\\s*(?:excellent|good|fair)',
  'used(?:\\s+condition)?',
  'pre[ -]?owned',
  'refurbished',
  'for\\s+parts(?:\\s*(?:\\/|or)\\s*not\\s+working)?',
  'not\\s+working',
  'parts\\s+only',
  'as[ -]?is',
].join('|');

// Bare grades are ambiguous inside names ("Good Cook", "Mint Mobile"), so they
// are removed globally only when they are the entire title or bracketed. For
// ordinary title clauses, only aliases of the selected condition are removed.
const BARE_TITLE_CONDITION_GRADE = [
  'mint',
  'excellent',
  'very\\s+good',
  'good',
  'fair',
  'poor',
].join('|');

const TITLE_SEPARATOR = '\\s*(?:[-–—|,:/]|\\u2022)\\s*';
const STRONG_TITLE_SEPARATOR = '\\s*(?:[-–—|]|\\u2022)\\s*';

const CONDITION_TITLE_ALIASES = {
  'Like New': ['mint'],
  'Used - Excellent': ['excellent'],
  'Used - Good': ['very good', 'good'],
  'Used - Fair': ['fair'],
  'For Parts': ['poor'],
};

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Generated listing titles identify the item; condition belongs in the separate
 * condition field. This removes condition-only clauses at title boundaries while
 * preserving identity words that happen to resemble a condition, such as
 * "New Balance" or "Good Cook".
 *
 * User-edited titles do not pass through this helper.
 */
export function stripConditionFromGeneratedTitle(title, selectedCondition = '') {
  let cleaned = String(title || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';

  // Remove condition-only clauses first. This includes a title that contains
  // nothing except condition, and condition in the middle of a separated title
  // such as "Apple iPhone - Refurbished - 256GB".
  const explicit = `(?:${EXPLICIT_TITLE_CONDITION})`;
  const exactOrBracketedCondition = `(?:${EXPLICIT_TITLE_CONDITION}|${BARE_TITLE_CONDITION_GRADE})`;
  cleaned = cleaned
    .replace(new RegExp(`^\\s*${exactOrBracketedCondition}\\s*$`, 'i'), '')
    .replace(new RegExp(`\\s*[([]\\s*${exactOrBracketedCondition}\\s*[)\\]]\\s*`, 'ig'), ' ')
    .replace(new RegExp(`^${explicit}${TITLE_SEPARATOR}`, 'i'), '')
    .replace(new RegExp(`${TITLE_SEPARATOR}${explicit}(?=${TITLE_SEPARATOR}|$)`, 'ig'), '')
    // Explicit multi-word phrases are sufficiently unambiguous to strip when
    // attached with whitespace instead of a title separator.
    .replace(new RegExp(`^${explicit}(?:${TITLE_SEPARATOR}|\\s+)`, 'i'), '')
    .replace(new RegExp(`(?:${TITLE_SEPARATOR}|\\s+)${explicit}$`, 'i'), '');

  // The selected canonical tier may appear verbatim or as its final grade after
  // a separator ("- Used - Excellent" / "- Excellent"). Strip only exact,
  // bracketed, or separator-delimited clauses so a product named "New Balance"
  // remains intact.
  const canonical = String(selectedCondition || '').trim();
  const grade = canonical.replace(/^Used\s*-\s*/i, '').trim();
  const aliases = CONDITION_TITLE_ALIASES[canonical] || [];
  for (const term of new Set([canonical, grade, ...aliases].filter(Boolean))) {
    const escaped = escapeRegExp(term);
    cleaned = cleaned
      .replace(new RegExp(`^\\s*${escaped}\\s*$`, 'i'), '')
      .replace(new RegExp(`\\s*[([]\\s*${escaped}\\s*[)\\]]\\s*`, 'ig'), ' ')
      .replace(new RegExp(`^${escaped}${STRONG_TITLE_SEPARATOR}`, 'i'), '')
      .replace(new RegExp(`${STRONG_TITLE_SEPARATOR}${escaped}(?=${STRONG_TITLE_SEPARATOR}|$)`, 'ig'), '');
  }

  return cleaned
    .replace(/\s{2,}/g, ' ')
    .replace(/(?:\s*[-–—|,:/]\s*)+$/g, '')
    .replace(/^(?:\s*[-–—|,:/]\s*)+/g, '')
    .trim();
}
