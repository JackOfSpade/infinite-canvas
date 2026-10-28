import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { sourceJobKey } from '../../src/utils/jobIdentity.js';
import { googleJobsDocumentId } from '../../src/utils/jobListingUrl.js';
import { atomicWriteJson, ensureDirectoryWithinRoot } from '../utils/pathSafety.js';
import { normalizeOfficialPosting } from './officialPostingFields.js';
import { coreTitle, locationsCompatible } from './officialPostingMatch.js';
import { officialPostingSemanticProofMatches } from './officialPostingSemantic.js';
import { strictEmployerEqual } from './officialSourceHosts.js';

const TEXT_BYTE_LIMIT = 3 * 1024 * 1024;
const RECORD_BYTE_LIMIT = 2 * 1024 * 1024;
const MISS_TTL_MS = 24 * 60 * 60 * 1000;
const CONTENT_HASH_RE = /^[a-f0-9]{64}$/u;
const OFFICIAL_TEXT_LEVELS = new Set(['L1', 'L2', 'L3']);
const DURABLE_LEVELS = new Set(['L1', 'L2', 'L3', 'L4']);
const DURABLE_OUTCOMES = new Set(['found', 'link-only', 'unreadable']);
const missingTextAttempts = new WeakMap();

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const identityPart = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().toLowerCase();
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function hasUnsafeControl(value, { includeSpace = false, allowWhitespace = false } = {}) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (allowWhitespace && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || code === 127 || (includeSpace && code === 32)) return true;
  }
  return false;
}

function aliasUrl(value) {
  if (typeof value !== 'string' || value.length > 8_192 || hasUnsafeControl(value, { includeSpace: true })) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return '';
    const googleId = googleJobsDocumentId(value);
    if (googleId) return `google-document:${googleId}`;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_/iu.test(key)) url.searchParams.delete(key);
    return url.href;
  } catch { return ''; }
}

/** Cache aliases always use the scraped identity, including every retained location. */
export function officialPostingAliases(job) {
  const aliases = new Set();
  const add = value => {
    if (typeof value === 'string' && value.length > 0 && value.length <= 16_384 && !hasUnsafeControl(value)) aliases.add(value);
  };
  const sourceIdentity = job?.jobkey || aliasUrl(job?.url) || aliasUrl(job?.googleCardUrl) || (identityPart(job?.title) && identityPart(job?.company));
  const key = typeof job?.sourceJobKey === 'string' && job.sourceJobKey ? job.sourceJobKey
    : sourceIdentity ? sourceJobKey(job) : '';
  if (key) add(`source:${JSON.stringify([identityPart(job?.source), String(key)])}`);
  const variants = Array.isArray(job?.postingVariants) ? job.postingVariants : [];
  for (const row of [job, ...variants]) {
    for (const value of [row?.url, row?.googleCardUrl]) {
      if (typeof value !== 'string' || !value.trim()) continue;
      const raw = value.trim();
      const canonical = aliasUrl(raw);
      if (!canonical) continue;
      add(`url:${raw}`);
      add(`url:${canonical}`);
    }
    const title = identityPart(job?.title);
    const company = identityPart(job?.company);
    if (title) add(`identity:${JSON.stringify([title, company, identityPart(row?.location ?? job?.location)])}`);
  }
  return [...aliases];
}

/** An alias locates a record; its original scraped identity authorizes reuse. */
export function officialPostingRecordMatchesScrapedIdentity(job, record) {
  const title = coreTitle(job?.title, { company: job?.company, location: job?.location });
  if (!title || !Array.isArray(record?.aliases)) return false;
  return record.aliases.some(alias => {
    if (typeof alias !== 'string' || !alias.startsWith('identity:')) return false;
    let identity;
    try { identity = JSON.parse(alias.slice('identity:'.length)); } catch { return false; }
    if (!Array.isArray(identity) || identity.length !== 3 || identity.some(value => typeof value !== 'string')) return false;
    const [oldTitle, oldCompany, oldLocation] = identity;
    const companyAgrees = !identityPart(job?.company) && !identityPart(oldCompany)
      || strictEmployerEqual(job?.company, oldCompany);
    return companyAgrees && title === coreTitle(oldTitle, { company: oldCompany, location: oldLocation })
      && (identityPart(job?.location) === identityPart(oldLocation)
        || locationsCompatible(job, { location: oldLocation }));
  });
}

function sameVerifiedOfficialPosting(left, right) {
  if (!OFFICIAL_TEXT_LEVELS.has(left?.level) || !OFFICIAL_TEXT_LEVELS.has(right?.level)
    || !left.sourceUrl || left.sourceUrl !== right.sourceUrl
    || !strictEmployerEqual(left.employer, right.employer)) return false;
  const title = coreTitle(left.title, { company: left.employer, location: left.location });
  return Boolean(title && title === coreTitle(right.title, { company: right.employer, location: right.location })
    && locationsCompatible(left, right));
}

function durableRecord(record) {
  return DURABLE_LEVELS.has(record.officialPosting?.level) && DURABLE_OUTCOMES.has(record.officialPosting?.outcome);
}

function storeError(message, code = 'OFFICIAL_POSTING_STORE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function regularFileOrAbsent(file) {
  try {
    const stat = await fs.promises.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw storeError('Official posting storage requires a regular file.', 'OFFICIAL_POSTING_UNSAFE_PATH');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function boundedRead(file, limit) {
  let handle;
  try {
    handle = await fs.promises.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw storeError('Official posting storage requires a regular file.', 'OFFICIAL_POSTING_UNSAFE_PATH');
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > limit) throw storeError('Official posting storage exceeds its byte limit.');
    return buffer.subarray(0, size);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  } finally { await handle?.close(); }
}

function decodeText(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function checkDescription(description) {
  if (typeof description !== 'string' || !description.trim()
    || Buffer.byteLength(description, 'utf8') > TEXT_BYTE_LIMIT
    || hasUnsafeControl(description, { allowWhitespace: true })) {
    throw storeError('Official posting text must be nonempty, bounded, and free of unsafe controls.');
  }
}

/** rootDir is the dedicated userData/official-postings directory. */
export function createOfficialPostingStore(rootDir, { now = Date.now } = {}) {
  if (typeof rootDir !== 'string' || !rootDir || !path.isAbsolute(rootDir) || typeof now !== 'function') throw new TypeError('Official posting storage needs an absolute root and clock.');
  const root = path.resolve(rootDir);
  const aliasesDir = path.join(root, 'aliases');
  const textsDir = path.join(root, 'texts');
  const aliasFile = alias => path.join(aliasesDir, `${sha256(alias)}.json`);
  const textFile = hash => path.join(textsDir, `${hash}.txt`);
  let writeChain = Promise.resolve();
  const serializeWrite = operation => {
    const pending = writeChain.then(operation, operation);
    writeChain = pending.catch(() => {});
    return pending;
  };
  const prepare = async () => {
    await ensureDirectoryWithinRoot(path.dirname(root), root, { label: 'Official posting store' });
    await ensureDirectoryWithinRoot(root, aliasesDir, { label: 'Official posting aliases' });
    await ensureDirectoryWithinRoot(root, textsDir, { label: 'Official posting texts' });
  };
  const readRecord = async alias => {
    const bytes = await boundedRead(aliasFile(alias), RECORD_BYTE_LIMIT);
    if (!bytes) return null;
    let record;
    try { record = JSON.parse(decodeText(bytes)); } catch { return null; }
    const posting = normalizeOfficialPosting(record?.officialPosting);
    if (record?.version !== 1 || !posting || !Number.isFinite(record.savedAt)
      || !Array.isArray(record.aliases) || record.aliases.length > 2_048
      || record.aliases.some(value => typeof value !== 'string' || !value || value.length > 16_384 || hasUnsafeControl(value))
      || !record.aliases.includes(alias)) return null;
    return { version: 1, aliases: [...new Set(record.aliases)], savedAt: record.savedAt, officialPosting: posting };
  };
  const readText = async contentHash => {
    if (!CONTENT_HASH_RE.test(String(contentHash ?? ''))) throw storeError('Official posting text has an invalid content hash.');
    await prepare();
    const bytes = await boundedRead(textFile(contentHash), TEXT_BYTE_LIMIT);
    if (!bytes) return null;
    if (sha256(bytes) !== contentHash) throw storeError('Official posting text does not match its content hash.', 'OFFICIAL_POSTING_TEXT_CORRUPT');
    const description = decodeText(bytes);
    checkDescription(description);
    return description;
  };
  const find = async job => {
    await prepare();
    let firstHit = null;
    for (const alias of officialPostingAliases(job)) {
      const record = await readRecord(alias);
      if (!record) continue;
      if (!durableRecord(record) && Number(now()) - record.savedAt >= MISS_TTL_MS) continue;
      firstHit ||= record;
      if (officialPostingRecordMatchesScrapedIdentity(job, record)) return record;
    }
    return firstHit;
  };
  const writeText = async (contentHash, description) => {
    checkDescription(description);
    if (!CONTENT_HASH_RE.test(String(contentHash ?? '')) || sha256(description) !== contentHash) throw storeError('Official posting metadata and text have different content hashes.');
    await prepare();
    const destination = textFile(contentHash);
    await regularFileOrAbsent(destination);
    const temporary = path.join(textsDir, `.${contentHash}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, description, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      await fs.promises.rename(temporary, destination);
    } finally { await fs.promises.unlink(temporary).catch(() => {}); }
  };
  const restoreText = (contentHash, description) => serializeWrite(() => writeText(contentHash, description));
  const save = (job, { officialPosting, description, expectedRecord } = {}) => serializeWrite(async () => {
    const posting = normalizeOfficialPosting(officialPosting);
    if (!posting) throw storeError('Official posting metadata does not match its wire schema.');
    if (description != null && typeof description !== 'string') throw storeError('Official posting description must be text.');
    await prepare();
    const aliases = new Set(officialPostingAliases(job));
    if (!aliases.size) throw storeError('Official posting storage needs a scraped identity alias.');
    const previous = [];
    for (const alias of aliases) {
      const existing = await readRecord(alias);
      if (existing) previous.push(existing);
    }
    // An older view may report a missing file after a newer resolution has
    // already replaced its metadata. Compare the complete record, including
    // its level/proof fields, rather than only the shared description hash.
    if (expectedRecord !== undefined
      && (!previous.length || previous.some(record => canonical(record) !== canonical(expectedRecord)))) return null;
    const compatiblePrevious = previous.filter(existing => officialPostingRecordMatchesScrapedIdentity(job, existing)
      || sameVerifiedOfficialPosting(posting, existing.officialPosting));
    for (const existing of compatiblePrevious) for (const alias of existing.aliases) aliases.add(alias);
    if (aliases.size > 2_048) throw storeError('Official posting storage has too many identity aliases.');
    if (typeof description === 'string' && description.length) {
      checkDescription(description);
      const contentHash = sha256(description);
      if (posting.contentHash && posting.contentHash !== contentHash) throw storeError('Official posting metadata and text have different content hashes.');
      posting.contentHash = contentHash;
      await writeText(contentHash, description);
    } else if (OFFICIAL_TEXT_LEVELS.has(posting.level)
      && (!posting.contentHash || !compatiblePrevious.some(record => record.officialPosting.contentHash === posting.contentHash))) {
      throw storeError('An official-text resolution needs its content-hashed description.');
    }
    const savedAt = Number(now());
    if (!Number.isFinite(savedAt)) throw storeError('Official posting storage clock is invalid.');
    const record = { version: 1, aliases: [...aliases], officialPosting: posting, savedAt };
    if (Buffer.byteLength(JSON.stringify(record), 'utf8') > RECORD_BYTE_LIMIT) throw storeError('Official posting record exceeds its byte limit.');
    for (const alias of aliases) {
      const destination = aliasFile(alias);
      await regularFileOrAbsent(destination);
      await atomicWriteJson(destination, record, { mode: 0o600 });
    }
    return structuredClone(record);
  });
  return Object.freeze({ rootDir: root, find, save, readText, restoreText });
}

function scrapedView(job, posting = null) {
  const scrapedEmployer = String(job?.company ?? '');
  const employer = posting ? (posting.level === 'L6' ? scrapedEmployer : posting.employer || scrapedEmployer) : scrapedEmployer;
  return {
    employer,
    postedBy: posting && (posting.level === 'L6' || identityPart(employer) !== identityPart(scrapedEmployer)) ? scrapedEmployer : '',
    title: String(job?.title ?? ''), location: String(job?.location ?? ''), salary: String(job?.salary ?? ''),
    description: String(job?.snippet || job?.description || ''),
    ...(posting ? { officialPosting: posting } : {}),
  };
}

async function restoreMissingText(record, store, refetch) {
  if (typeof refetch !== 'function' || typeof store.restoreText !== 'function' || !record.officialPosting.sourceUrl) return null;
  let attempts = missingTextAttempts.get(store);
  if (!attempts) { attempts = new Map(); missingTextAttempts.set(store, attempts); }
  const hash = record.officialPosting.contentHash;
  if (!attempts.has(hash)) attempts.set(hash, (async () => {
    try {
      const fetched = await refetch(record.officialPosting.sourceUrl, { contentHash: hash });
      const description = typeof fetched === 'string' ? fetched : fetched?.description;
      checkDescription(description);
      if (sha256(description) !== hash) return null;
      await store.restoreText(hash, description);
      return description;
    } catch { return null; }
  })());
  return attempts.get(hash);
}

/** The one main-process posting view; row metadata alone never supplies official facts. */
export async function officialPostingView(job, { store, refetch, requireSemantic = false } = {}) {
  if (!store || typeof store.find !== 'function' || typeof store.readText !== 'function') return scrapedView(job);
  let record;
  try { record = await store.find(job); } catch { return scrapedView(job); }
  if (!record || !officialPostingRecordMatchesScrapedIdentity(job, record)) return scrapedView(job);
  const posting = record.officialPosting;
  if (requireSemantic && !officialPostingSemanticProofMatches(job, posting)) return scrapedView(job);
  const fallback = scrapedView(job, posting);
  if (!OFFICIAL_TEXT_LEVELS.has(posting.level) || !posting.contentHash || job?.officialPosting?.contentHash !== posting.contentHash) return fallback;
  let description;
  let missing = false;
  try { description = await store.readText(posting.contentHash); missing = description === null; } catch { description = null; }
  if (missing) description = await restoreMissingText(record, store, refetch);
  if (typeof description !== 'string') {
    const failed = { ...posting, trail: [...new Set([...(posting.trail || []), 'official-text-missing'])].slice(-32) };
    try { await store.save(job, { officialPosting: failed, expectedRecord: record }); } catch { /* A storage fault still falls back to the scraped listing. */ }
    return scrapedView(job, failed);
  }
  return {
    employer: posting.employer, postedBy: fallback.postedBy,
    title: posting.title || fallback.title,
    location: posting.location?.display || fallback.location,
    salary: posting.salary?.text || fallback.salary,
    description, officialPosting: posting,
  };
}
