/**
 * Every openable link a job row holds, most official first, plus the
 * per-card "this link no longer shows the job" marks that walk down that list.
 *
 * Pure and renderer-safe. The host-side host classifier
 * (electron/ipc/officialSourceHosts.js) pulls in jsdom and parse5 through its
 * vendor adapters, so the renderer keeps its own small host tables here. A test
 * pins them against the host lists so the two cannot drift apart silently.
 *
 * Unconfirmed judge-cited candidates (officialPosting.alternatives) are not in
 * this chain on purpose: an unconfirmed address may be a different job, and the
 * card shows those separately as candidate links.
 */
import { mostOfficialSource, normalizeOfficialPosting } from '../../electron/ipc/officialPostingFields.js';
import { normalizeJobListingExternalUrl } from './jobListingUrl.js';
import { officialPostingPreparationSourceKey, projectOfficialPostingGenerationJob } from './officialPostingPreparation.js';
import { normalizeExternalHttpUrl } from './urlSafety.js';

/** Upper bound on stored dead marks per card; the oldest marks fall off first. */
export const MAX_DEAD_SOURCE_URLS = 50;

// Employer-run applicant tracking systems. Mirrors ATS_BASE_DOMAINS on the host.
export const SOURCE_LINK_ATS_DOMAINS = Object.freeze([
  'greenhouse.io', 'lever.co', 'myworkdayjobs.com', 'myworkdaysite.com', 'ashbyhq.com',
  'smartrecruiters.com', 'icims.com', 'jobvite.com', 'workable.com', 'bamboohr.com', 'taleo.net',
  'successfactors.com', 'successfactors.eu', 'recruitee.com', 'breezy.hr', 'teamtailor.com',
  'personio.de', 'personio.com', 'join.com', 'rippling.com', 'paylocity.com', 'ultipro.com',
  'dayforcehcm.com', 'eightfold.ai', 'applytojob.com', 'pinpointhq.com', 'comeet.com',
  'brassring.com', 'avature.net', 'csod.com', 'oraclecloud.com', 'workforcenow.adp.com',
  'recruiting.adp.com', 'hrmdirect.com', 'jazz.co', 'freshteam.com', 'zohorecruit.com',
  'gohire.io', 'greenhouse.com', 'ripplematch.com', 'phenompeople.com', 'gem.com',
]);

// Boards where employers post directly. A copy here is usually the employer's
// own posting syndicated by the employer, so it outranks a scraped repost.
export const SOURCE_LINK_BOARD_DOMAINS = Object.freeze([
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'wellfound.com', 'angel.co', 'builtin.com',
  'dice.com', 'monster.com', 'otta.com', 'welcometothejungle.com', 'themuse.com', 'hired.com',
  'workatastartup.com', 'ycombinator.com', 'levels.fyi', 'weworkremotely.com', 'remoteok.com',
  'remoteok.io', 'remote.co', 'justremote.co', 'nodesk.co', 'jobspresso.co', 'flexjobs.com',
  'idealist.org', 'snagajob.com', 'theladders.com', 'ladders.com', 'seek.com.au', 'seek.co.nz',
  'naukri.com', 'stepstone.de', 'reed.co.uk', 'totaljobs.com', 'workopolis.com', 'eluta.ca',
  'jobbank.gc.ca', 'usajobs.gov', 'handshake.com', 'joinhandshake.com',
]);

// Sites that copy postings from elsewhere. Kept just above the Google card
// because a repost often outlives, or predates, the original.
export const SOURCE_LINK_AGGREGATOR_DOMAINS = Object.freeze([
  'talent.com', 'ziprecruiter.com', 'jooble.org', 'adzuna.com', 'adzuna.ca', 'adzuna.co.uk',
  'simplyhired.com', 'simplyhired.ca', 'lensa.com', 'jobright.ai', 'careerbuilder.com',
  'jobgether.com', 'joblist.com', 'jobrapido.com', 'neuvoo.com', 'careerjet.com', 'careerjet.ca',
  'recruit.net', 'jobleads.com', 'whatjobs.com', 'jobisjob.com', 'trovit.com', 'learn4good.com',
  'getwork.com', 'jobcase.com', 'jobs.com', 'bebee.com', 'trabajo.org', 'careerbeacon.com',
  'jobilize.com', 'grabjobs.co', 'jobsora.com', 'ziprecruiter.ca', 'tealhq.com', 'hiringcafe.com',
  'hiring.cafe', 'remoterocketship.com', 'himalayas.app', 'talentify.io', 'salary.com', 'myjobhelper.com',
]);

// Country variants of the big boards (indeed.ca, uk.linkedin.com, glassdoor.co.uk, ...).
const BOARD_LABEL_RE = /(?:^|\.)(?:indeed|linkedin|glassdoor|monster|seek|naukri|stepstone|reed|totaljobs)\.(?:[a-z]{2,3}\.)?[a-z]{2,}$/u;
// Built In runs one site per city (builtinnyc.com, builtinchicago.org, ...).
const BUILTIN_CITY_RE = /(?:^|\.)builtin[a-z]*\.(?:com|org)$/u;
const AGGREGATOR_LABEL_RE = /(?:^|\.)(?:ziprecruiter|simplyhired|careerbuilder|jooble|adzuna|talent|careerjet|jobrapido)\.(?:[a-z]{2,3}\.)?[a-z]{2,}$/u;
const GOOGLE_HOST_RE = /(?:^|\.)google\.(?:com|[a-z]{2}|(?:com|co)\.[a-z]{2})$/u;

// 'other' is a host in none of the tables that does not carry the company's
// name: it may be a small reposter, so it ranks below the major boards.
const RANK = Object.freeze({ official: 0, ats: 1, employer: 2, board: 3, other: 4, aggregator: 5, google: 6 });

// Words that say nothing about which company a host belongs to.
const COMPANY_FILLER_WORDS = new Set([
  'the', 'and', 'of', 'inc', 'incorporated', 'llc', 'llp', 'lp', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'srl', 'bv', 'nv', 'ab', 'oy', 'as', 'pty', 'ulc',
  'group', 'holdings', 'holding', 'international', 'global', 'usa', 'us', 'canada', 'na',
]);

const hostMatches = (host, domain) => host === domain || host.endsWith(`.${domain}`);
const displayHost = host => host.replace(/^www\./u, '');

function parsedHost(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) return '';
    const host = parsed.hostname.toLowerCase().replace(/\.$/u, '');
    // A bare word ("linkedin") becomes https://linkedin/ under the lenient
    // normalizer; it names no real site, so it is never offered.
    return host.includes('.') ? host : '';
  } catch {
    return '';
  }
}

function companyWords(name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/gu, '')
    .split(/[^a-z0-9]+/u).filter(word => word && !COMPANY_FILLER_WORDS.has(word));
}

/**
 * Whether a host plausibly belongs to one of the named companies: a host label
 * (TLD excluded) is the compacted name, or carries one of its distinctive words.
 */
function hostNamesCompany(host, names) {
  const labels = host.split('.').slice(0, -1).map(label => label.replace(/[^a-z0-9]/gu, ''));
  return names.some((name) => {
    const words = companyWords(name);
    if (words.length === 0) return false;
    const compact = words.join('');
    return labels.some(label => label.length >= 3 && (label === compact
      || (label.length >= 4 && compact.startsWith(label))
      || words.some(word => word === label || (word.length >= 4 && label.includes(word)))));
  });
}

/**
 * Host class of a normalized URL: ats, employer, board, aggregator, google or
 * other. Only a host carrying one of `companyNames` counts as the employer's
 * own site; any other unknown host is 'other'.
 */
export function sourceLinkHostClass(url, companyNames = []) {
  const host = parsedHost(url);
  if (!host) return '';
  if (GOOGLE_HOST_RE.test(host)) return 'google';
  if (SOURCE_LINK_ATS_DOMAINS.some(domain => hostMatches(host, domain))) return 'ats';
  if (SOURCE_LINK_AGGREGATOR_DOMAINS.some(domain => hostMatches(host, domain)) || AGGREGATOR_LABEL_RE.test(host)) return 'aggregator';
  if (SOURCE_LINK_BOARD_DOMAINS.some(domain => hostMatches(host, domain)) || BOARD_LABEL_RE.test(host)
    || BUILTIN_CITY_RE.test(host)) return 'board';
  return hostNamesCompany(host, Array.isArray(companyNames) ? companyNames : [companyNames]) ? 'employer' : 'other';
}

/**
 * The one safety gate for every link in the chain. A Google Jobs internal
 * route is repaired into a working search URL with the job's own words, the
 * same way the card's link button always has.
 */
function safeLinkUrl(job, raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const url = normalizeJobListingExternalUrl({ title: job?.title, company: job?.company, location: job?.location, url: raw });
  return url && parsedHost(url) ? url : '';
}

function labelFor(kind, url) {
  if (kind === 'google') return 'Open Google Jobs card';
  return `Open listing on ${displayHost(parsedHost(url))}`;
}

/** Normalize, de-duplicate and cap a stored dead-mark list (newest kept). */
export function normalizeDeadSourceUrls(value) {
  return mergeDeadSourceUrls(value);
}

/** Union of several dead-mark lists, in first-seen order, capped to the newest. */
export function mergeDeadSourceUrls(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      if (typeof raw !== 'string') continue;
      const url = normalizeExternalHttpUrl(raw);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(url);
    }
  }
  return out.length > MAX_DEAD_SOURCE_URLS ? out.slice(-MAX_DEAD_SOURCE_URLS) : out;
}

/** Append one mark; returns the input list itself when it was already marked. */
export function appendDeadSourceUrl(list, url) {
  const current = normalizeDeadSourceUrls(list);
  const normalized = normalizeExternalHttpUrl(url);
  if (!normalized || current.includes(normalized)) return Array.isArray(list) ? list : current;
  return mergeDeadSourceUrls(current, [normalized]);
}

/**
 * The form a dead mark is stored and matched in: the stored address itself,
 * normalized but never repaired. A Google route without its own query is
 * repaired with the row's title, company and location, which consolidation
 * rewrites ("Multiple locations"), so the repaired address is not stable.
 */
function linkKey(raw) {
  return typeof raw === 'string' ? normalizeExternalHttpUrl(raw) : '';
}

/**
 * Ordered, de-duplicated openable links for a job row: [{ url, key, kind, label }].
 * `url` is what the button opens; `key` is what a dead mark records.
 *
 * 1. A confirmed, open official posting: its page, then its application page.
 * 2. The row's own listing, Google "Apply on" options, board copies that lost a
 *    cross-source dedup, and consolidated sibling postings, ranked by host:
 *    ATS, then other (employer) sites, then major boards, then reposters.
 *    Stable order inside each class.
 * 3. The Google Jobs card last: Google drops its card first when a job ages.
 */
export function jobSourceLinks(job) {
  if (!job || typeof job !== 'object') return [];
  const seen = new Set();
  const official = [];
  const listings = [];
  const add = (bucket, raw, kind, label) => {
    const url = safeLinkUrl(job, raw);
    const key = linkKey(raw);
    if (!url || !key || seen.has(url) || seen.has(key)) return;
    seen.add(url);
    seen.add(key);
    bucket.push({ url, key, kind: kind || sourceLinkHostClass(url, companyNames), label });
  };

  const posting = normalizeOfficialPosting(job.officialPosting);
  const companyNames = [job.company, posting?.employer];
  const source = mostOfficialSource(job);
  if (source.kind === 'official' && !source.closed) {
    add(official, posting?.sourceUrl, 'official', 'Open official posting');
    add(official, posting?.officialApplyUrl, 'official', 'Open official application page');
  }

  const listing = (raw) => {
    const url = safeLinkUrl(job, raw);
    const kind = url ? sourceLinkHostClass(url, companyNames) : '';
    if (kind) add(listings, raw, kind, labelFor(kind, url));
  };
  listing(job.url);
  for (const option of Array.isArray(job.applyOptions) ? job.applyOptions : []) listing(option?.href);
  for (const alternate of Array.isArray(job.alternateListings) ? job.alternateListings : []) listing(alternate?.url);
  for (const variant of Array.isArray(job.postingVariants) ? job.postingVariants : []) {
    // A sibling posting the liveness check already found closed would only
    // waste a click on the way down the list.
    if (!variant || typeof variant !== 'object' || variant.liveness === 'closed') continue;
    listing(variant.url);
    listing(variant.applyUrl);
    listing(variant.googleCardUrl);
  }
  listing(job.googleCardUrl);

  const ranked = listings
    .map((link, index) => ({ link, index }))
    .sort((a, b) => RANK[a.link.kind] - RANK[b.link.kind] || a.index - b.index)
    .map(({ link }) => (link.kind === 'ats' || link.kind === 'employer' ? { ...link, kind: 'employer' } : link));
  return [...official, ...ranked];
}

/**
 * The card's chain. An official posting that was previously marked closed stays
 * the first thing the link button opens, so the user can inspect it; it is
 * never an application target and is not part of jobSourceLinks.
 */
export function jobCardSourceLinks(job) {
  const links = jobSourceLinks(job);
  const posting = normalizeOfficialPosting(job?.officialPosting);
  if (!posting || !['L1', 'L2', 'L3', 'L4'].includes(posting.level) || posting.outcome !== 'closed') return links;
  const url = safeLinkUrl(job, posting.sourceUrl);
  const key = linkKey(posting.sourceUrl);
  if (!url || !key) return links;
  return [{ url, key, kind: 'closed-official', label: 'View official posting previously marked closed' },
    ...links.filter(link => link.url !== url && link.key !== key)];
}

/** The forms a link can be marked dead under: its key, and its opened address. */
function linkMarkForms(link) {
  return [link?.key, normalizeExternalHttpUrl(link?.url)].filter(Boolean);
}

/** The first link not marked dead, the ones after it, and whether all are gone. */
export function pickCurrentJobSourceLink(links, deadSourceUrls) {
  const list = Array.isArray(links) ? links : [];
  const dead = new Set(normalizeDeadSourceUrls(deadSourceUrls));
  const live = list.filter(link => link?.url && !linkMarkForms(link).some(form => dead.has(form)));
  return { current: live[0] || null, remaining: live.slice(1), exhausted: list.length > 0 && live.length === 0 };
}

/** The form to store when the user marks this link gone. */
export function jobSourceLinkMark(link) {
  return link?.key || normalizeExternalHttpUrl(link?.url);
}

const identityKey = (job) => {
  try { return officialPostingPreparationSourceKey(projectOfficialPostingGenerationJob(job)); } catch { return ''; }
};

const sameArray = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && a.every((value, index) => value === b[index]);

/**
 * Rebuild each Combine row's dead marks from the Board's cards. The cards are
 * the only authority: a list already on a row came from an earlier snapshot
 * and is replaced, so a Restore on a card is not undone.
 *
 * Marks travel per card, never as a Board-wide pool. A card's marks reach a row
 * when the card is that row (same lookup source key or source job key), or when
 * the two share a link no other rebuilt row holds; consolidation and re-scrapes
 * change the key while that address stays with the one job. A shared address
 * such as a careers index or the same repost on two rows is not identity, so a
 * mark on one job never lands on another. Only marks on links the row offers
 * are kept. A row whose list does not change is returned as the same object.
 */
export function carryBoardDeadSourceUrls(jobs, cards) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const marked = [];
  for (const card of Array.isArray(cards) ? cards : []) {
    if (card?.type !== 'jobcard' || !card.data) continue;
    const dead = normalizeDeadSourceUrls(card.data.deadSourceUrls);
    if (dead.length === 0) continue;
    marked.push({
      dead,
      forms: new Set(jobCardSourceLinks(card.data).flatMap(linkMarkForms)),
      identity: identityKey(card.data),
      sourceJobKey: typeof card.data.sourceJobKey === 'string' ? card.data.sourceJobKey : '',
    });
  }
  const rowForms = rows.map(job => (job && typeof job === 'object'
    ? new Set(jobCardSourceLinks(job).flatMap(linkMarkForms)) : new Set()));
  const holders = new Map();
  for (const forms of rowForms) for (const form of forms) holders.set(form, (holders.get(form) || 0) + 1);

  return rows.map((job, index) => {
    if (!job || typeof job !== 'object') return job;
    const forms = rowForms[index];
    const carried = [];
    if (marked.length > 0) {
      const identity = identityKey(job);
      for (const card of marked) {
        const same = (identity && card.identity === identity)
          || (card.sourceJobKey && card.sourceJobKey === job.sourceJobKey)
          || [...card.forms].some(form => forms.has(form) && holders.get(form) === 1);
        if (same) carried.push(card.dead.filter(url => forms.has(url)));
      }
    }
    const merged = mergeDeadSourceUrls(...carried);
    if (merged.length === 0) {
      if (!Object.hasOwn(job, 'deadSourceUrls')) return job;
      const { deadSourceUrls: _dropped, ...rest } = job;
      return rest;
    }
    return sameArray(job.deadSourceUrls, merged) ? job : { ...job, deadSourceUrls: merged };
  });
}
