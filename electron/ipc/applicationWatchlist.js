/**
 * Private watch list for application improvement sessions.
 *
 * A session acts only on patterns that recur across several bundles. Patterns
 * below that bar are kept here instead of being forgotten at the counter reset:
 * each later session records which reviewed bundles the user corrected the
 * pattern in, which kept it unedited, and which were checked at all, so a
 * pattern is judged by its rate across many bundles rather than a few bad
 * variations. The file sits beside state.json, outside it, so counter resets
 * and model-label archives never clear it. Only sessions write it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const WATCH_READY_OCCURRENCES = 3;
// Below one correction in six reviewed bundles the pattern reads as variation.
export const WATCH_LOW_RATE = 1 / 6;
// Reviewed this many times since the last correction, the item is dormant.
export const WATCH_DORMANT_REVIEWS = 15;
export const WATCH_SUMMARY_MAX_CHARS = 200;
export const WATCH_CATEGORIES = Object.freeze(['truth error', 'evidence choice', 'wording', 'structure', 'length', 'letter structure', 'user judgment call']);
export const WATCH_DOCUMENTS = Object.freeze(['resume', 'letter', 'both']);
export const WATCH_STATUSES = Object.freeze(['watching', 'acting', 'resolved', 'dismissed']);
// Where the fix lives: the user's own career data, the generator's guidance or code, or not yet known.
export const WATCH_REMEDIES = Object.freeze(['career data', 'generator', 'undecided']);

function watchFile(root) { return path.join(root, 'application-improvement', 'watchlist.json'); }
function blank() { return { version: 1, items: [], reviews: [] }; }

export async function readWatchlist(root) {
  try { return JSON.parse(await fs.promises.readFile(watchFile(root), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return blank(); throw error; }
}

async function writeWatchlist(root, list) {
  const target = watchFile(root);
  await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(list, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(tmp, target);
  } finally { await fs.promises.unlink(tmp).catch(() => {}); }
}

function pairIds(value, field) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) throw new Error(`${field} must be a list of pair IDs.`);
  return [...new Set(value.map(id => id.trim()))];
}
function union(...lists) { return [...new Set(lists.flat())]; }
function slug(summary) { return `w-${crypto.createHash('sha256').update(summary).digest('hex').slice(0, 10)}`; }

/** Derived numbers the session reads; never stored, so they cannot drift from the evidence. */
export function watchItemStats(item, reviews = []) {
  const occurred = new Set(item.occurred || []);
  const reviewed = union(item.reviewed || [], [...occurred], item.kept || []);
  const order = new Map(reviews.flatMap(review => review.pairIds || []).map((id, index) => [id, index]));
  const sorted = [...reviewed].sort((left, right) => (order.get(left) ?? -1) - (order.get(right) ?? -1));
  const lastHit = sorted.findLastIndex(id => occurred.has(id));
  const sinceLast = lastHit < 0 ? sorted.length : sorted.length - 1 - lastHit;
  const rate = reviewed.length ? occurred.size / reviewed.length : 0;
  return {
    occurrences: occurred.size, kept: (item.kept || []).length, reviewed: reviewed.length,
    rate: Math.round(rate * 100) / 100,
    ready: item.status === 'watching' && occurred.size >= WATCH_READY_OCCURRENCES,
    lowRate: occurred.size >= WATCH_READY_OCCURRENCES && rate < WATCH_LOW_RATE,
    dormant: item.status === 'watching' && sinceLast >= WATCH_DORMANT_REVIEWS,
  };
}

export async function watchlistReport(root) {
  const list = await readWatchlist(root);
  return {
    reviews: list.reviews.length,
    lastReviewAt: list.reviews.at(-1)?.at || null,
    items: list.items.map(item => ({ id: item.id, summary: item.summary, category: item.category, document: item.document,
      remedy: item.remedy || 'undecided', status: item.status, openedAt: item.openedAt, ...watchItemStats(item, list.reviews) })),
  };
}

/** Status line for the app's improvement status: counts and summaries only. */
export async function watchlistStatus(root) {
  const report = await watchlistReport(root);
  const open = report.items.filter(item => item.status === 'watching');
  // Career-data items are edits the user makes in their own source, never generator rules.
  const careerDataEdits = report.items.filter(item => item.remedy === 'career data' && (item.status === 'watching' || item.status === 'acting'))
    .map(item => ({ summary: item.summary, status: item.status, occurrences: item.occurrences }));
  return { watching: open.length, ready: open.filter(item => item.ready).map(item => ({ summary: item.summary, remedy: item.remedy, occurrences: item.occurrences, reviewed: item.reviewed })), careerDataEdits, lastReviewAt: report.lastReviewAt };
}

/**
 * Applies one session's review: `{ at, pairIds, items: [{ id?, summary, category, document,
 * remedy?, occurred?, kept?, reviewed?, status?, reason? }] }`. Pair lists accumulate; an item is
 * matched by id, or created when it has none. Every listed pair must belong to the review;
 * an empty pairIds list only changes statuses.
 */
export async function applyWatchlistReview(root, review) {
  if (!review || typeof review !== 'object') throw new Error('Watch list review must be an object.');
  const at = typeof review.at === 'string' && !Number.isNaN(Date.parse(review.at)) ? review.at : null;
  if (!at) throw new Error('Watch list review needs an ISO "at" time.');
  const reviewed = pairIds(review.pairIds, 'pairIds');
  if (!Array.isArray(review.items)) throw new Error('Watch list review needs an items list.');
  const list = await readWatchlist(root);
  const scope = new Set(reviewed);
  for (const entry of review.items) {
    const occurred = pairIds(entry.occurred, 'occurred');
    const kept = pairIds(entry.kept, 'kept');
    const checked = pairIds(entry.reviewed, 'reviewed');
    const outside = union(occurred, kept, checked).filter(id => !scope.has(id));
    if (outside.length) throw new Error(`Watch item lists pairs outside this review: ${outside.join(', ')}.`);
    if (occurred.some(id => kept.includes(id))) throw new Error('A pair cannot both correct and keep the same pattern.');
    let item = entry.id ? list.items.find(candidate => candidate.id === entry.id) : null;
    if (entry.id && !item) throw new Error(`Unknown watch item ${entry.id}.`);
    if (!item) {
      const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
      if (!summary || summary.length > WATCH_SUMMARY_MAX_CHARS) throw new Error(`A new watch item needs a summary of 1–${WATCH_SUMMARY_MAX_CHARS} characters.`);
      if (!WATCH_CATEGORIES.includes(entry.category)) throw new Error(`Watch item category must be one of: ${WATCH_CATEGORIES.join(', ')}.`);
      if (!WATCH_DOCUMENTS.includes(entry.document)) throw new Error(`Watch item document must be one of: ${WATCH_DOCUMENTS.join(', ')}.`);
      item = { id: slug(`${summary}\0${at}`), summary, category: entry.category, document: entry.document, remedy: 'undecided', status: 'watching', openedAt: at, occurred: [], kept: [], reviewed: [], history: [] };
      list.items.push(item);
    }
    item.occurred = union(item.occurred, occurred);
    item.kept = union(item.kept.filter(id => !occurred.includes(id)), kept.filter(id => !item.occurred.includes(id)));
    item.reviewed = union(item.reviewed, checked, occurred, kept);
    if (entry.remedy !== undefined) {
      if (!WATCH_REMEDIES.includes(entry.remedy)) throw new Error(`Watch item remedy must be one of: ${WATCH_REMEDIES.join(', ')}.`);
      item.remedy = entry.remedy;
    }
    if (entry.status !== undefined) {
      if (!WATCH_STATUSES.includes(entry.status)) throw new Error(`Watch item status must be one of: ${WATCH_STATUSES.join(', ')}.`);
      if (entry.status !== item.status) {
        if (typeof entry.reason !== 'string' || !entry.reason.trim()) throw new Error('A watch status change needs a reason.');
        item.history.push({ at, from: item.status, to: entry.status, reason: entry.reason.trim().slice(0, 500) });
        item.status = entry.status;
      }
    }
    item.updatedAt = at;
  }
  // A status-only update (an empty pairIds list) records no review.
  if (reviewed.length) list.reviews.push({ at, pairIds: reviewed });
  await writeWatchlist(root, list);
  return watchlistReport(root);
}
