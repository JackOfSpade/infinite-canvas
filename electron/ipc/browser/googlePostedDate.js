/**
 * Google Jobs "posted" labels.
 *
 * Google's list cards are inconsistent about where (and whether) they render
 * the posting age: some cards ship it in a bare <span>, others in a classed
 * span/div, and a whole class of cards ships no date at all. The old extractor
 * only accepted `span:not([class])` leaves matching `\d+ (day|week|hour|month)`
 * or a literal "Just now", so "45 minutes ago", "30+ days ago", "5h ago",
 * "Today", "Yesterday" and "Posted today" all became an empty `posted` — which
 * is exactly the field scrape-health alarms on (jobSourceHealth FIELD_CHECKS
 * 'posted'). The detail panel DOES carry the date in its header, so this module
 * also exposes the panel reader used to recover a blank list-card date.
 *
 * Nothing here is a second unit table for the "ago" forms: that vocabulary
 * stays owned by jobDateFilter.js (UNIT_ALTERNATION drives parsePostedDate).
 * The one local token list is the legacy no-"ago" form, which is anchored to
 * the WHOLE label and spells units in full words only — see
 * LEGACY_NO_AGO_BRANCH.
 */
import { POSTED_DATE_PATTERN } from '../jobDateFilter.js';

// The old extractor also accepted the no-"ago" form, which on live cards always
// carried a space and a word unit ("3 days"). Requiring BOTH the whitespace and
// the whole-label anchors is what keeps page junk out: an unanchored
// `\d+\+?\s*(?:…|d|h|…)` branch matched a company-logo initials leaf "3D" that
// sits BEFORE the real date span, so the extractor returned "3D" as the posting
// age instead of the card's "2 days ago".
const LEGACY_NO_AGO_BRANCH = '|^\\d+\\+?\\s+(?:minutes?|hours?|days?|weeks?|months?|years?)$';

/**
 * Regex SOURCE for a short Google date label. Usable as
 * `new RegExp(GOOGLE_POSTED_TEXT_PATTERN, 'i')` both in Node and inside a
 * browser-context evaluate.
 *
 * - everything POSTED_DATE_PATTERN matches ("28 days ago", "30+ days ago",
 *   "5h ago", "just posted", "posted today", "just now");
 * - the legacy no-"ago" form as the WHOLE label with a word unit ("3 days",
 *   "40 hours"), never compact initials like "3D", "5h", "d1g1t" or "H1";
 * - bare "Today" / "Yesterday" as the WHOLE label only, so page prose such as
 *   "Apply today" can never be read as a posting date.
 */
export const GOOGLE_POSTED_TEXT_PATTERN =
  `(?:${POSTED_DATE_PATTERN}${LEGACY_NO_AGO_BRANCH}|^(?:today|yesterday)$)`;

/**
 * Read the posted label of the OPEN Google detail panel.
 *
 * Self-contained on purpose: it is passed straight to puppeteer
 * `page.evaluate`, so it must not close over this module's scope and it takes
 * the pattern source as an argument. Google leaves stale/preloaded panels
 * mounted (`aria-hidden="true"`) and the result LIST also renders dates, so the
 * reader starts at the first visible panel, walks up at most 8 ancestors,
 * refuses to scan any level that also holds a result card, and skips the
 * description spans (panelSelector) themselves.
 *
 * Call shapes (both supported, so the same function works in the page and in
 * Node/JSDOM tests):
 *   readGooglePanelPostedDate(document, panelSelector, patternSource)
 *   page.evaluate(readGooglePanelPostedDate, panelSelector, patternSource)
 *
 * @returns {string} first matched phrase ("2 days ago", "Today"), else ''.
 */
export function readGooglePanelPostedDate(first, second, third) {
  const root = typeof first === 'string' ? globalThis.document : first;
  const panelSelector = typeof first === 'string' ? first : second;
  const patternSource = typeof first === 'string' ? second : third;
  if (!root || typeof root.querySelectorAll !== 'function' || !panelSelector || !patternSource) return '';

  const LIST_CARD_SELECTOR = '.EimVGf, [jscontroller="b11o3b"]';
  const HIDDEN_SELECTOR = '[aria-hidden="true"]';
  const MAX_ANCESTOR_LEVELS = 8;
  const MAX_LABEL_CHARS = 40;

  let pattern;
  try {
    pattern = new RegExp(patternSource, 'i');
  } catch {
    return '';
  }

  const panel = Array.from(root.querySelectorAll(panelSelector))
    .find(el => !(el.closest && el.closest(HIDDEN_SELECTOR)));
  if (!panel) return '';

  const scanLevel = level => {
    const doc = level.ownerDocument || root;
    if (!doc || typeof doc.createTreeWalker !== 'function') return '';
    // NodeFilter.SHOW_TEXT === 4 (a literal so this stays dependency-free).
    const walker = doc.createTreeWalker(level, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const label = (node.nodeValue || '').trim();
      if (!label || label.length > MAX_LABEL_CHARS) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      if (parent.closest(HIDDEN_SELECTOR)) continue;
      // The description body is never a date chip, even when a line of it
      // happens to read like one.
      if (parent.closest(panelSelector)) continue;
      const match = pattern.exec(label);
      if (!match || !match[0]) continue;
      const phrase = match[0].trim();
      if (phrase) return phrase;
    }
    return '';
  };

  let level = panel;
  for (let depth = 0; level && depth < MAX_ANCESTOR_LEVELS; depth++, level = level.parentElement) {
    // A level that also holds list cards is (or contains) the result list:
    // ascending into it would hand back another card's date, so stop here.
    if (typeof level.querySelector === 'function' && level.querySelector(LIST_CARD_SELECTOR)) break;
    const found = scanLevel(level);
    if (found) return found;
  }
  return '';
}
