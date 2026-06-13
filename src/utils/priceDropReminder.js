/**
 * Price-drop reminder math for marketplace listing cards.
 *
 * Each `marketplacecard` carries:
 *   createdAt            ISO — when the card was spawned (shown on the card).
 *   lastPriceDropAt      ISO — when the user last lowered the price (or, before
 *                        any drop, the creation time). The reminder anchor.
 *   priceDropReminderDue bool — the reminder has fired and the user hasn't
 *                        acknowledged it yet; drives the pulsing border.
 *
 * The interval is PER-ITEM: `priceDropReminderWeeks` lives on the card's
 * parent hub (set in the Price Check Module's priced state; decimals allowed;
 * 0/absent = reminders off) and applies to that hub's cards only. A card is
 * due when `anchor + weeks <= now`. When the reminder FIRES the anchor resets to NOW
 * (not anchor + interval) — so a listing that predates the feature, or sat
 * unopened for months, reminds once and then waits a full fresh interval
 * instead of re-firing the moment it's acknowledged.
 */

export const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;

// Spawn-generated card ids end in a Date.now() suffix: mkt-<hubId>-<platformId>-<ms>.
// Accept it as the card's real creation time only when it falls in a sane range
// (after 2020, not in the future) — anything else gets the "now" fallback.
const ID_TIMESTAMP_RE = /-(\d{12,14})$/;
const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);

/** Real creation time recovered from a card's id, in ms — or null. */
export function createdAtMsFromCardId(id, nowMs = Date.now()) {
  const match = ID_TIMESTAMP_RE.exec(String(id || ''));
  if (!match) return null;
  const ms = Number(match[1]);
  if (!Number.isFinite(ms) || ms < MIN_PLAUSIBLE_MS || ms > nowMs) return null;
  return ms;
}

/**
 * Should the reminder fire? True when reminders are enabled (weeks > 0), the
 * anchor parses, and `anchor + weeks <= now`. The anchor is the card's
 * lastPriceDropAt, falling back to createdAt for cards that never dropped.
 */
export function isPriceDropReminderDue({ anchorIso, weeks, nowMs = Date.now() }) {
  const intervalWeeks = Number(weeks);
  if (!Number.isFinite(intervalWeeks) || intervalWeeks <= 0) return false;
  const anchorMs = Date.parse(anchorIso || '');
  if (!Number.isFinite(anchorMs)) return false;
  return anchorMs + intervalWeeks * MS_PER_WEEK <= nowMs;
}
