// Saved title verdicts for the AI role screen (screenJobRolesByTitle in
// jobPreferences.js). Unlimited Auto collection brings the same off-role
// titles back every run ("Carpenter", "Registered Nurse"); a title already
// judged against the same target titles is not sent to the AI again.
//
// What is saved, and why only that:
// - Only title-pass outcomes: 'mismatch' (removed) and 'match' (kept). An
//   'unsure' title is never saved, because its final answer comes from the
//   snippet step, which reads that job's own description.
// - Keyed by the cleaned-up title AND the exact target-title list. Changing the
//   target titles therefore starts from nothing; verdicts are never carried
//   across a different list. Several Searches with different lists each keep
//   their own entries.
// - Company is not in the key, so a hit would be shared across employers. A
//   saved 'mismatch' title is therefore replayed ONLY once it has been seen at
//   two different employers (two distinct company fingerprints, see
//   companyFingerprint). A title removed at a single company is still a
//   company-dependent judgement -- "Associate" at a bank is not "Associate" at
//   a design studio -- so it stays pending: lookup() does not return it, the
//   title goes to the AI again, and that answer feeds record(). A 'match'
//   always wins: it is returned immediately and replaces a pending mismatch.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import electronPkg from 'electron';
import { createFifoLock } from './asyncMutex.js';

const FILE_NAME = 'job-role-screen-verdicts.json';
const VERSION = 2;
// Least recently used entries go first past this count, across all lists.
export const ROLE_SCREEN_VERDICT_MAX_ENTRIES = 20_000;
// A replayed mismatch needs this many DISTINCT employers behind it.
export const ROLE_SCREEN_MISMATCH_MIN_COMPANIES = 2;
// Enough to prove a title is not one employer's quirk, few enough to bound
// the row written to disk.
const COMPANY_FINGERPRINT_CAP = 3;
const OUTCOMES = new Set(['match', 'mismatch']);

export function normalizeRoleScreenTitle(title) {
  return String(title ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 300);
}

export function normalizeRoleScreenCompany(company) {
  return String(company ?? '').normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Short, collision-resistant stand-in for an employer. An empty company
// contributes nothing, so it can never count toward the two-employer rule.
export function roleScreenCompanyFingerprint(company) {
  const normalized = normalizeRoleScreenCompany(company);
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export function roleScreenTargetsKey(titles) {
  const list = [...new Set((Array.isArray(titles) ? titles : []).map(normalizeRoleScreenTitle).filter(Boolean))].sort();
  return crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex').slice(0, 32);
}

function entryKey(targetsKey, title) { return `${targetsKey}\u0001${title}`; }

function cleanFingerprints(value) {
  const out = [];
  for (const fingerprint of Array.isArray(value) ? value : []) {
    if (typeof fingerprint !== 'string' || !fingerprint) continue;
    if (out.includes(fingerprint)) continue;
    out.push(fingerprint);
    if (out.length >= COMPANY_FINGERPRINT_CAP) break;
  }
  return out;
}

// A mismatch is replayable only with two distinct employers behind it;
// anything less is a pending entry and goes back to the AI.
function isReplayable(entry) {
  if (entry.outcome === 'match') return true;
  return entry.outcome === 'mismatch' && entry.companies.length >= ROLE_SCREEN_MISMATCH_MIN_COMPANIES;
}

export function createJobRoleScreenVerdictStore(dir, { maxEntries = ROLE_SCREEN_VERDICT_MAX_ENTRIES } = {}) {
  const file = path.join(dir, FILE_NAME);
  const lock = createFifoLock({ name: 'job-role-screen-verdicts' });
  let tempSequence = 0;
  let cache = null;

  async function read() {
    if (cache) return cache;
    const entries = new Map();
    try {
      const doc = JSON.parse(await fs.readFile(file, 'utf8'));
      // Any other version (including the pre-companies version 1) starts
      // empty: its rows cannot express the two-employer rule.
      if (doc?.version === VERSION && Array.isArray(doc.entries)) {
        for (const row of doc.entries) {
          if (!Array.isArray(row) || row.length < 4) continue;
          const [key, outcome, reason, usedAt] = row;
          if (typeof key !== 'string' || !OUTCOMES.has(outcome)) continue;
          entries.set(key, {
            outcome,
            reason: outcome === 'mismatch' ? String(reason || '').slice(0, 200) : '',
            usedAt: Number(usedAt) || 0,
            companies: outcome === 'mismatch' ? cleanFingerprints(row[4]) : [],
          });
        }
      }
    } catch {
      // Missing or unreadable: start empty. The screen still works; it just
      // sends every title to the AI.
    }
    cache = entries;
    return cache;
  }

  async function write(entries) {
    // Keep the most recently used entries only.
    let rows = [...entries.entries()];
    if (rows.length > maxEntries) {
      rows.sort((a, b) => b[1].usedAt - a[1].usedAt);
      rows = rows.slice(0, maxEntries);
      entries.clear();
      for (const [key, value] of rows) entries.set(key, value);
    }
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${++tempSequence}.tmp`;
    const doc = { version: VERSION, entries: rows.map(([key, value]) => [key, value.outcome, value.reason, value.usedAt, value.companies]) };
    try {
      await fs.writeFile(temp, `${JSON.stringify(doc)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => {});
    }
  }

  // Returns Map(normalizedTitle -> {outcome, reason}) for saved titles that
  // may be replayed: every 'match', and only a 'mismatch' seen at two or more
  // distinct employers. A pending one-employer mismatch is left out (and its
  // use time untouched) so the title goes to the AI again.
  async function lookup(targetsKey, normalizedTitles, { now = Date.now() } = {}) {
    return lock.withLock(async () => {
      const entries = await read();
      const found = new Map();
      for (const title of new Set(normalizedTitles)) {
        const hit = entries.get(entryKey(targetsKey, title));
        if (!hit || !isReplayable(hit)) continue;
        hit.usedAt = now;
        found.set(title, { outcome: hit.outcome, reason: hit.reason });
      }
      // Persist the use times so eviction keeps the titles that keep coming back.
      if (found.size > 0) await write(entries);
      return found;
    });
  }

  // `answers`: [{ title (normalized), outcome: 'match'|'mismatch'|'unclear',
  // reason, company (raw) }] from one screen run, possibly several rows per
  // title. Per title: all-'match' saves/overwrites a match (a keep always
  // wins); all-'mismatch' merges the distinct company fingerprints into an
  // already-mismatch entry (cap 3) or starts a fresh pending one; any
  // disagreement or 'unclear' deletes a saved entry instead.
  async function record(targetsKey, answers, { now = Date.now() } = {}) {
    return lock.withLock(async () => {
      const entries = await read();
      const byTitle = new Map();
      for (const answer of Array.isArray(answers) ? answers : []) {
        const title = answer?.title;
        if (!title) continue;
        const outcome = OUTCOMES.has(answer.outcome) ? answer.outcome : 'unclear';
        const fingerprint = outcome === 'mismatch' ? roleScreenCompanyFingerprint(answer.company) : '';
        const reason = outcome === 'mismatch' ? String(answer.reason || '').slice(0, 200) : '';
        const prior = byTitle.get(title);
        if (!prior) {
          byTitle.set(title, { outcome, reason, companies: fingerprint ? [fingerprint] : [] });
          continue;
        }
        if (prior.outcome !== outcome) { prior.outcome = 'unclear'; continue; }
        if (!prior.reason && reason) prior.reason = reason;
        if (fingerprint && !prior.companies.includes(fingerprint) && prior.companies.length < COMPANY_FINGERPRINT_CAP) prior.companies.push(fingerprint);
      }
      let saved = 0; let forgotten = 0;
      for (const [title, value] of byTitle) {
        const key = entryKey(targetsKey, title);
        if (value.outcome === 'unclear') {
          if (entries.delete(key)) forgotten += 1;
          continue;
        }
        if (value.outcome === 'match') {
          entries.set(key, { outcome: 'match', reason: '', usedAt: now, companies: [] });
          saved += 1;
          continue;
        }
        const existing = entries.get(key);
        const companies = existing?.outcome === 'mismatch' ? [...existing.companies] : [];
        for (const fingerprint of value.companies) {
          if (companies.length >= COMPANY_FINGERPRINT_CAP) break;
          if (!companies.includes(fingerprint)) companies.push(fingerprint);
        }
        entries.set(key, { outcome: 'mismatch', reason: value.reason, usedAt: now, companies });
        saved += 1;
      }
      await write(entries);
      return { saved, forgotten };
    });
  }

  return Object.freeze({ file, lookup, record });
}

let productionStore = null;
export function getJobRoleScreenVerdictStore() {
  if (!productionStore) productionStore = createJobRoleScreenVerdictStore(electronPkg.app.getPath('userData'));
  return productionStore;
}
export function __setJobRoleScreenVerdictStoreForTests(store) {
  const previous = productionStore;
  productionStore = store;
  return () => { productionStore = previous; };
}
