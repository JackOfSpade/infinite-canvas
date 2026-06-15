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
export const DEFAULT_PRICE_DROP_TARGET_PERCENT = 10;
export const MAX_PRICE_DROP_TARGET_PERCENT = 10;
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

/** Strictly normalize a target percentage constrained to the required <=10%. */
export function normalizePriceDropTargetPercent(raw) {
  let percent;
  if (typeof raw === 'number') {
    percent = raw;
  } else if (typeof raw === 'string') {
    const value = raw.trim();
    if (!DECIMAL_RE.test(value)) return null;
    percent = Number(value);
  } else {
    return null;
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > MAX_PRICE_DROP_TARGET_PERCENT) return null;
  return Math.round((percent + Number.EPSILON) * 100) / 100;
}

export function effectivePriceDropTargetPercent(raw) {
  return normalizePriceDropTargetPercent(raw) ?? DEFAULT_PRICE_DROP_TARGET_PERCENT;
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
 * Number of cadence reminders strictly before the must-sell date. A reminder
 * exactly at local midnight on that date is intentionally excluded.
 */
export function priceDropReminderCountBeforeMustSell({ scheduleStartedAtIso, mustSellDate, weeks }) {
  const intervalWeeks = normalizePriceDropReminderWeeks(weeks);
  const scheduleStartedAtMs = Date.parse(scheduleStartedAtIso || '');
  const deadlineMs = priceDropMustSellDateMs(mustSellDate);
  if (!intervalWeeks || !Number.isFinite(scheduleStartedAtMs) || !Number.isFinite(deadlineMs)) return null;
  const scheduleSpanMs = deadlineMs - scheduleStartedAtMs;
  if (!(scheduleSpanMs > 0)) return 0;
  return Math.max(0, Math.ceil(scheduleSpanMs / (intervalWeeks * MS_PER_WEEK)) - 1);
}

/**
 * Maximum listing price at the deadline. Floor to cents so floating-point or
 * currency rounding can never push the result above the selected percentage.
 */
export function priceDropTargetPrice(startingPrice, targetPercent = DEFAULT_PRICE_DROP_TARGET_PERCENT) {
  const startPrice = normalizePriceDropStartingPrice(startingPrice);
  const percent = normalizePriceDropTargetPercent(targetPercent);
  if (startPrice == null || percent == null) return null;
  const startCents = Math.round(startPrice * 100);
  const percentBasisPoints = Math.round(percent * 100);
  if (!Number.isSafeInteger(startCents) || !Number.isSafeInteger(startCents * percentBasisPoints)) return null;
  return Math.floor(startCents * percentBasisPoints / 10_000) / 100;
}

function nextPriceDropReminder({ scheduleStartedAtIso, lastAcknowledgedAtIso, weeks, nowMs }) {
  const intervalWeeks = normalizePriceDropReminderWeeks(weeks);
  const scheduleStartedAtMs = Date.parse(scheduleStartedAtIso || '');
  if (!intervalWeeks || !Number.isFinite(scheduleStartedAtMs) || !Number.isFinite(nowMs)) return null;
  const acknowledgedAtMs = Date.parse(lastAcknowledgedAtIso || '');
  const scheduleCursorMs = Number.isFinite(acknowledgedAtMs)
    ? Math.max(scheduleStartedAtMs, acknowledgedAtMs)
    : scheduleStartedAtMs;
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
  weeks,
  nowMs = Date.now(),
}) {
  const next = nextPriceDropReminder({ scheduleStartedAtIso, lastAcknowledgedAtIso, weeks, nowMs });
  return next ? Math.max(0, next.nextDueAtMs - nowMs) : null;
}

/**
 * Delay to the next fixed-cadence must-sell-plan reminder. Acknowledging late
 * does not drift the remaining schedule, and no reminder is scheduled on or
 * after the must-sell date.
 */
export function priceDropDeadlineReminderDelayMs({
  scheduleStartedAtIso,
  lastAcknowledgedAtIso,
  mustSellDate,
  weeks,
  nowMs = Date.now(),
}) {
  const deadlineMs = priceDropMustSellDateMs(mustSellDate);
  const remindersBeforeDeadline = priceDropReminderCountBeforeMustSell({ scheduleStartedAtIso, mustSellDate, weeks });
  const next = nextPriceDropReminder({ scheduleStartedAtIso, lastAcknowledgedAtIso, weeks, nowMs });
  if (
    !next
    || !Number.isFinite(deadlineMs)
    || !(remindersBeforeDeadline > 0)
    || nowMs >= deadlineMs
    || next.nextStep > remindersBeforeDeadline
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
 * Reminder opportunities are counted at the configured cadence, and the last
 * opportunity strictly before the must-sell date reaches the target percentage.
 * A late reminder catches up to the corresponding schedule step. When the
 * deadline is too close to contain a prior reminder, no suggestion is returned:
 * claiming the target can be reached would be mathematically false.
 */
export function calculatePriceDropSuggestion({
  startingPrice,
  targetPercent = DEFAULT_PRICE_DROP_TARGET_PERCENT,
  scheduleStartedAtIso,
  mustSellDate,
  weeks,
  nowMs = Date.now(),
}) {
  const startPrice = normalizePriceDropStartingPrice(startingPrice);
  const target = priceDropTargetPrice(startPrice, targetPercent);
  const scheduleStartedAtMs = Date.parse(scheduleStartedAtIso || '');
  const dropsBeforeDeadline = priceDropReminderCountBeforeMustSell({ scheduleStartedAtIso, mustSellDate, weeks });
  if (
    startPrice == null
    || target == null
    || !Number.isFinite(scheduleStartedAtMs)
    || !(dropsBeforeDeadline > 0)
    || !Number.isFinite(nowMs)
  ) {
    return null;
  }

  const intervalMs = normalizePriceDropReminderWeeks(weeks) * MS_PER_WEEK;
  const elapsedDrops = Math.max(1, Math.floor((nowMs - scheduleStartedAtMs) / intervalMs));
  const currentStep = Math.min(dropsBeforeDeadline, elapsedDrops);
  if (currentStep === dropsBeforeDeadline) return target;
  const suggestion = startPrice - ((startPrice - target) * currentStep / dropsBeforeDeadline);
  return Math.floor((suggestion + Number.EPSILON) * 100) / 100;
}
