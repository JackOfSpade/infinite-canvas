/**
 * Price-drop reminder math for marketplace listing cards.
 *
 * Each `marketplacecard` carries:
 *   createdAt            ISO — when the card was spawned (shown on the card).
 *   lastPriceDropAt      ISO — when the user last acknowledged lowering price.
 *   priceDropReminderDue bool — the reminder has fired and the user hasn't
 *                        acknowledged it yet; drives the pulsing border.
 *
 * `priceDropReminderWeeks` lives on the parent hub and applies to all of its
 * cards. Their shared fixed cadence begins at the oldest connected card's
 * creation time. Acknowledging a card marks that card handled through the
 * current cadence step without shifting the group's future reminder dates.
 */

export const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
export const MAX_PRICE_DROP_TIMER_DELAY_MS = 2_147_000_000;
export const INITIAL_PRICE_DROP_CHECK_DELAY_MS = 100;
export const DEFAULT_PRICE_DROP_STARTING_TIER = 'best';

const PRICE_DROP_STARTING_TIERS = new Set(['quick', 'best', 'max']);
const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DECIMAL_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

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

/** Oldest valid creation timestamp among a hub's connected listing cards. */
export function oldestPriceDropCardCreatedAtIso(cards, nowMs = Date.now()) {
  let oldestMs = null;
  for (const card of Array.isArray(cards) ? cards : []) {
    const parsed = Date.parse(card?.data?.createdAt || '');
    const createdAtMs = Number.isFinite(parsed) && parsed <= nowMs
      ? parsed
      : createdAtMsFromCardId(card?.id, nowMs);
    if (Number.isFinite(createdAtMs) && (oldestMs == null || createdAtMs < oldestMs)) {
      oldestMs = createdAtMs;
    }
  }
  return oldestMs == null ? null : new Date(oldestMs).toISOString();
}

/** Strictly normalize a persisted/editor reminder cadence; invalid means off. */
export function normalizePriceDropReminderWeeks(raw) {
  let weeks;
  if (typeof raw === 'number') {
    weeks = raw;
  } else if (typeof raw === 'string') {
    const value = raw.trim();
    if (!DECIMAL_RE.test(value)) return 0;
    weeks = Number(value);
  } else {
    return 0;
  }
  return Number.isFinite(weeks) && weeks > 0 && Number.isFinite(weeks * MS_PER_WEEK) ? weeks : 0;
}

/** A valid date-input value, or an empty string when the must-sell date is off. */
export function normalizePriceDropMustSellDate(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return '';
  const match = DATE_ONLY_RE.exec(value);
  if (!match) return '';
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  const day = Number(match[3]);
  const date = new Date(year, monthIndex, day);
  return date.getFullYear() === year && date.getMonth() === monthIndex && date.getDate() === day
    ? value
    : '';
}

/** Local midnight at the beginning of a valid must-sell date, or null. */
export function priceDropMustSellDateMs(raw) {
  const value = normalizePriceDropMustSellDate(raw);
  if (!value) return null;
  const [, year, month, day] = DATE_ONLY_RE.exec(value);
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

/**
 * Local midnight at the END of the must-sell day (start of the next day), or
 * null. This is the inclusive cutoff for the plan: a reminder that naturally
 * lands ANY time on the must-sell day still counts (a "reduction on the day
 * of"), but reminders after the day are suppressed. `day + 1` lets the Date
 * constructor roll the month/year and respect DST, unlike adding 24h of ms.
 */
export function priceDropMustSellDayEndMs(raw) {
  const value = normalizePriceDropMustSellDate(raw);
  if (!value) return null;
  const [, year, month, day] = DATE_ONLY_RE.exec(value);
  return new Date(Number(year), Number(month) - 1, Number(day) + 1).getTime();
}

function normalizeNonNegativeCurrency(raw) {
  let amount;
  if (typeof raw === 'number') {
    amount = raw;
  } else if (typeof raw === 'string') {
    const value = raw.trim();
    if (!DECIMAL_RE.test(value)) return null;
    amount = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * The absolute price the listing should reach BY the must-sell date — entered
 * directly by the user. Non-negative currency or null (null = no target, so
 * the cards fall back to generic cadence reminders without a suggested price).
 */
export function normalizePriceDropTargetPrice(raw) {
  const price = normalizeNonNegativeCurrency(raw);
  return price != null ? price : null;
}

export function normalizePriceDropStartingTier(raw) {
  return PRICE_DROP_STARTING_TIERS.has(raw) ? raw : DEFAULT_PRICE_DROP_STARTING_TIER;
}

export function normalizePriceDropStartingPrice(raw) {
  const price = normalizeNonNegativeCurrency(raw);
  return price != null && price > 0 ? price : null;
}

/** Resolve the selected tier, falling back only when that tier has no price. */
export function resolvePriceDropStartingTier(tiers, raw) {
  const selected = normalizePriceDropStartingTier(raw);
  if (normalizePriceDropStartingPrice(tiers?.[selected]) != null) return selected;
  return [DEFAULT_PRICE_DROP_STARTING_TIER, 'quick', 'max']
    .find(tier => normalizePriceDropStartingPrice(tiers?.[tier]) != null) || null;
}

export function priceDropStartingPrice(tiers, raw) {
  const tier = resolvePriceDropStartingTier(tiers, raw);
  return tier ? normalizePriceDropStartingPrice(tiers?.[tier]) : null;
}

/**
 * Number of cadence reminders that occur THROUGH the must-sell day — i.e. on or
 * before it. A reminder that naturally lands any time on the must-sell day is
 * the plan's final reminder (it reaches the exact target); reminders after the
 * day are excluded. The last of these N reminders is the one that hits target.
 */
export function priceDropReminderCountThroughMustSell({ scheduleStartedAtIso, mustSellDate, weeks }) {
  const intervalWeeks = normalizePriceDropReminderWeeks(weeks);
  const scheduleStartedAtMs = Date.parse(scheduleStartedAtIso || '');
  const dayEndMs = priceDropMustSellDayEndMs(mustSellDate);
  if (!intervalWeeks || !Number.isFinite(scheduleStartedAtMs) || !Number.isFinite(dayEndMs)) return null;
  const scheduleSpanMs = dayEndMs - scheduleStartedAtMs;
  if (!(scheduleSpanMs > 0)) return 0;
  return Math.max(0, Math.ceil(scheduleSpanMs / (intervalWeeks * MS_PER_WEEK)) - 1);
}

function nextPriceDropReminder({ scheduleStartedAtIso, lastAcknowledgedAtIso, cardCreatedAtIso, weeks, nowMs }) {
  const intervalWeeks = normalizePriceDropReminderWeeks(weeks);
  const scheduleStartedAtMs = Date.parse(scheduleStartedAtIso || '');
  if (!intervalWeeks || !Number.isFinite(scheduleStartedAtMs) || !Number.isFinite(nowMs)) return null;
  const acknowledgedAtMs = Date.parse(lastAcknowledgedAtIso || '');
  const cardCreatedAtMs = Date.parse(cardCreatedAtIso || '');
  // A card never owes reminders from before it existed. Floor the cadence cursor
  // at the card's own creation so one spawned mid-schedule joins at the next
  // shared grid point instead of firing immediately for an interval that elapsed
  // before the card was added (e.g. listing a second platform weeks later). A
  // future creation time (corrupt or clock-skewed) is ignored — matching
  // oldestPriceDropCardCreatedAtIso — so it can't push reminders out forever.
  let scheduleCursorMs = scheduleStartedAtMs;
  if (Number.isFinite(cardCreatedAtMs) && cardCreatedAtMs <= nowMs) scheduleCursorMs = Math.max(scheduleCursorMs, cardCreatedAtMs);
  if (Number.isFinite(acknowledgedAtMs)) scheduleCursorMs = Math.max(scheduleCursorMs, acknowledgedAtMs);
  const intervalMs = intervalWeeks * MS_PER_WEEK;
  const nextStep = Math.max(1, Math.floor((scheduleCursorMs - scheduleStartedAtMs) / intervalMs) + 1);
  const nextDueAtMs = scheduleStartedAtMs + nextStep * intervalMs;
  return Number.isFinite(nextDueAtMs) ? { nextDueAtMs, nextStep } : null;
}

/**
 * Delay to the next fixed-cadence reminder shared by every connected card.
 * An acknowledgment advances only that card to the next group cadence step.
 */
export function priceDropReminderDelayMs({
  scheduleStartedAtIso,
  lastAcknowledgedAtIso,
  cardCreatedAtIso,
  weeks,
  nowMs = Date.now(),
}) {
  const next = nextPriceDropReminder({ scheduleStartedAtIso, lastAcknowledgedAtIso, cardCreatedAtIso, weeks, nowMs });
  return next ? Math.max(0, next.nextDueAtMs - nowMs) : null;
}

/**
 * Delay to the next fixed-cadence must-sell-plan reminder. Acknowledging late
 * does not drift the remaining schedule. Reminders fire on the shared cadence
 * through the must-sell day (a natural on-the-day reminder is allowed) and stop
 * once the day has fully passed — extending the must-sell date later naturally
 * brings them back, since everything is derived from the date.
 */
export function priceDropDeadlineReminderDelayMs({
  scheduleStartedAtIso,
  lastAcknowledgedAtIso,
  cardCreatedAtIso,
  mustSellDate,
  weeks,
  nowMs = Date.now(),
}) {
  const dayEndMs = priceDropMustSellDayEndMs(mustSellDate);
  const remindersThroughDeadline = priceDropReminderCountThroughMustSell({ scheduleStartedAtIso, mustSellDate, weeks });
  const next = nextPriceDropReminder({ scheduleStartedAtIso, lastAcknowledgedAtIso, cardCreatedAtIso, weeks, nowMs });
  if (
    !next
    || !Number.isFinite(dayEndMs)
    || !(remindersThroughDeadline > 0)
    || nowMs >= dayEndMs
    || next.nextStep > remindersThroughDeadline
  ) {
    return null;
  }
  return Math.max(0, next.nextDueAtMs - nowMs);
}

/**
 * Should the next shared-cadence reminder fire for this card?
 */
export function isPriceDropReminderDue(args) {
  return priceDropReminderDelayMs(args) === 0;
}

/**
 * Linear price-drop schedule for a listing card.
 *
 * The oldest connected card's creation time starts the shared schedule.
 * Reminders are counted at the configured cadence through the must-sell day, and
 * the final reminder (on or before that day) reaches the exact user-entered
 * target price. A late reminder catches up to the corresponding schedule step.
 * Returns null when there is no valid drop to suggest — no target, a target not
 * below the starting price, or a deadline too close to contain any reminder
 * (claiming the target can be reached would then be mathematically false).
 */
export function calculatePriceDropSuggestion({
  startingPrice,
  targetPrice,
  scheduleStartedAtIso,
  mustSellDate,
  weeks,
  nowMs = Date.now(),
}) {
  const startPrice = normalizePriceDropStartingPrice(startingPrice);
  const target = normalizePriceDropTargetPrice(targetPrice);
  const scheduleStartedAtMs = Date.parse(scheduleStartedAtIso || '');
  const dropsThroughDeadline = priceDropReminderCountThroughMustSell({ scheduleStartedAtIso, mustSellDate, weeks });
  if (
    startPrice == null
    || target == null
    || !(target < startPrice)
    || !Number.isFinite(scheduleStartedAtMs)
    || !(dropsThroughDeadline > 0)
    || !Number.isFinite(nowMs)
  ) {
    return null;
  }

  const intervalMs = normalizePriceDropReminderWeeks(weeks) * MS_PER_WEEK;
  const elapsedDrops = Math.max(1, Math.floor((nowMs - scheduleStartedAtMs) / intervalMs));
  const currentStep = Math.min(dropsThroughDeadline, elapsedDrops);
  if (currentStep === dropsThroughDeadline) return target;
  const suggestion = startPrice - ((startPrice - target) * currentStep / dropsThroughDeadline);
  return Math.floor((suggestion + Number.EPSILON) * 100) / 100;
}
