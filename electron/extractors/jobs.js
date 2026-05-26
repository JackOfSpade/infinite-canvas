/**
 * Job Search Extractors + Site Configs.
 *
 * Each platform has ONE best strategy. If it returns 0 results, the extractor
 * throws SITE_CHANGED so the failure surfaces immediately as a 'stale-selectors'
 * warning — the user is told to update the scraper code rather than silently
 * getting 0 jobs. There are no fallback chains.
 *
 * Exceptions: Google (legitimately unscrapeable, has paste fallback),
 * Swappa (0 = no model match, not broken), PriceCharting (niche source, 0 is valid).
 *
 * Each source exports:
 *   - An extractor JS string (IIFE that runs in page context)
 *   - A site config object with waitFor, scrollFirst, referer, etc.
 */

// ── Site Configurations ─────────────────────────────────────────────────────
// `timeoutMs` is a SEED / safety ceiling, not a fixed budget: scrapeBudget
// learns each source's typical time-to-ready and derives a tighter working
// timeout for fast sources (never looser than this seed). `waitMs` is now
// vestigial — the readiness-stabilization loop in browserPool decides when
// results are ready, and the pre-read beat is sized from learned timing.

export const GOOGLE_JOBS_CONFIG = {
  waitMs: 2500,
  timeoutMs: 25000, // reduced from 45s — Google headless consistently times out; fail fast so the manual-paste UI appears sooner
  // waitFor intentionally omitted: the selector (.EimVGf / jscontroller="b11o3b") never
  // appears in bot-throttled sessions, burning the full SELECTOR_WAIT_MS (8s) before the
  // readiness loop even starts. Without it, MAX_ZERO_READS exits in ~3s and the paste
  // fallback UI surfaces immediately. Positive sessions rely on firstBeatMs + the loop.
  waitFor: null,
  scrollFirst: false,
  dismissCookies: true,
  waitUntil: 'domcontentloaded',
};

// ── Google Jobs ─────────────────────────────────────────────────────────────
// Card structure (as of 2026-05): .EimVGf root, jscontroller="b11o3b".
// URL lives on data-share-url (no <a> tags in cards — old card.querySelector('a')
// was always returning empty). Title/company/location are positional children of
// the content grouping div (.GoEOPd); bare class-less <span> elements carry
// posted date and employment type. All obfuscated class names need periodic
// revalidation when Google rotates its frontend.
// NOTE: no SITE_CHANGED throw — Google Jobs is legitimately unscrapeable
// (JS-rendered, obfuscated). 0 results triggers the paste-fallback UI path.
export const GOOGLE_JOBS_EXTRACTOR = `
(function() {
  const jobs = [];

  const cards = document.querySelectorAll('.EimVGf, [jscontroller="b11o3b"]');

  cards.forEach(card => {
    try {
      // URL: data-share-url is the stable anchor — cards have no <a> tags
      const url = card.getAttribute('data-share-url') || '';

      // Title: .tNxQIb is current; [role="heading"] is the semantic fallback
      const titleEl = card.querySelector('.tNxQIb, [role="heading"], h3');
      const title = titleEl?.innerText?.trim() || '';
      if (!title || title === 'Jobs') return;

      // Company + location: positional children of the content grouping div.
      // nth-child is more resilient than the obfuscated sibling class names.
      const contentGroup = card.querySelector('.GoEOPd') || titleEl?.parentElement;
      const contentDivs = contentGroup ? Array.from(contentGroup.querySelectorAll(':scope > div')) : [];
      const company = contentDivs[1]?.innerText?.trim() || '';
      const locationRaw = contentDivs[2]?.innerText?.trim() || '';
      // Strip " • via LinkedIn" / " • via Indeed" suffix
      const location = locationRaw.split(' • ')[0].trim();

      // Posted date + employment type: bare <span> elements (no class by design)
      const bareSpans = Array.from(card.querySelectorAll('span:not([class])'))
        .map(s => s.innerText?.trim()).filter(Boolean);
      const posted = bareSpans.find(s => /\\d+\\s+(day|week|hour|month)/i.test(s) || s === 'Just now') || '';
      const empType = bareSpans.find(s => /full[- ]?time|part[- ]?time|contract|intern/i.test(s)) || '';

      jobs.push({
        title, company, location, salary: '',
        snippet: empType,
        url, posted,
        source: 'google'
      });
    } catch {}
  });

  return jobs;
})()
`;

// ── ZipRecruiter ────────────────────────────────────────────────────────────

export const ZIPRECRUITER_CONFIG = {
  waitMs: 1500,
  timeoutMs: 40000,
  // JSON-LD is server-rendered — available on DOMContentLoaded, no DOM selector needed
  waitFor: 'script[type="application/ld+json"]',
  scrollFirst: false,
  dismissCookies: true,
  referer: 'https://www.google.com/',
  waitUntil: 'domcontentloaded',
};

// Strategy: JSON-LD ItemList — ZipRecruiter's only structured data post-App-Router
// migration (no __NEXT_DATA__). ItemList entries have only name + url; company and
// location are parsed from the URL: /c/{Company}/Job/{Title}/-in-{City},{State}?jid=
// Throws SITE_CHANGED if no ItemList is found or 0 jobs are extracted.
export const ZIPRECRUITER_EXTRACTOR = `
(function() {
  const jobs = [];

  const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (const script of ldScripts) {
    try {
      const data = JSON.parse(script.textContent);
      if (data['@type'] !== 'ItemList') continue;
      const items = data.itemListElement || [];

      items.forEach(item => {
        if (item['@type'] !== 'ListItem') return;
        const title = (item.name || '').trim();
        const url = item.url || '';
        if (!title || !url) return;

        let company = '';
        let location = '';
        try {
          const cMatch = url.match(new RegExp('/c/([^/]+)/Job/'));
          if (cMatch) company = cMatch[1].replace(/-/g, ' ');
          const lMatch = url.match(new RegExp('/-in-([^?]+)'));
          if (lMatch) location = lMatch[1].replace(/-/g, ' ');
        } catch {}

        jobs.push({ title, company, location, salary: '', snippet: '', url, posted: '', source: 'ziprecruiter' });
      });
      if (jobs.length > 0) break;
    } catch {}
  }

  if (jobs.length === 0) throw new Error('SITE_CHANGED: ziprecruiter ItemList JSON-LD extractor returned 0 — JSON-LD structure or @type may have changed');
  return jobs;
})()
`;

// ── Glassdoor ───────────────────────────────────────────────────────────────

export const GLASSDOOR_CONFIG = {
  waitMs: 3500,
  timeoutMs: 40000,
  waitFor: '[data-test="jobListing"], .JobCard_jobCardWrapper, .react-job-listing',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

// Strategy: __NEXT_DATA__ > apolloCache (Glassdoor migrated to Next.js + Apollo).
// Looks for cache entries with JobListing keys and a jobTitleText field.
// Note: returning 1–10 jobs before hitting "Show more" is the Glassdoor review
// gate (detected by the IPC layer separately). Returning 0 means the apolloCache
// structure changed → SITE_CHANGED.
export const GLASSDOOR_EXTRACTOR = `
(function() {
  const jobs = [];

  const ndEl = document.getElementById('__NEXT_DATA__');
  if (!ndEl) throw new Error('SITE_CHANGED: glassdoor __NEXT_DATA__ element missing');
  const nd = JSON.parse(ndEl.textContent);
  const cache = nd?.props?.pageProps?.apolloCache || nd?.props?.pageProps?.apollo?.cache || {};

  for (const [key, value] of Object.entries(cache)) {
    if (!value || typeof value !== 'object') continue;
    const isJob = key.includes('JobListing') || key.includes('jobListingSe') ||
                  (value.__typename && value.__typename.includes('Job'));
    if (!isJob || !value.jobTitleText) continue;

    const employer = value.employer ? cache[value.employer.__ref || ''] || value.employer : {};

    jobs.push({
      title: value.jobTitleText || value.jobTitle || '',
      company: employer.shortName || employer.name || value.employerName || '',
      location: value.locationName || value.location || '',
      salary: value.salarySource?.payRange ? (value.salarySource.payRange) : (value.salaryEstimate || ''),
      snippet: (employer.overallRating ? 'Rating: ' + employer.overallRating + '/5 | ' : '') + (value.jobDescription || '').substring(0, 250),
      url: value.seoJobLink ? ('https://www.glassdoor.com' + value.seoJobLink) : (value.jobLink || ''),
      posted: value.ageInDays != null ? (value.ageInDays + 'd ago') : '',
      source: 'glassdoor'
    });
  }

  if (jobs.length === 0) throw new Error('SITE_CHANGED: glassdoor apolloCache extractor returned 0 — cache key patterns or jobTitleText field may have changed');
  return jobs;
})()
`;
// ── Wellfound (AngelList) ───────────────────────────────────────────────────

export const WELLFOUND_CONFIG = {
  waitMs: 3000,
  timeoutMs: 40000,
  // Jobs load client-side via GraphQL — wait for the rendered card semantic attr
  waitFor: '[data-testid="job-listing-list"]',
  scrollFirst: false,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

// Wellfound migrated to a client-side GraphQL architecture (Apollo, no SSR job data).
// __NEXT_DATA__ only carries the logged-in user's profile, not listings.
// Jobs are rendered client-side; structure as of 2026-05:
//   [data-testid="job-listing-list"] — one card per job (stable semantic attr)
//     a[href*="/jobs/"]              — relative link; prefix with wellfound.com
//     [class*="styles_title__"]      — job title
//     [class*="styles_location__"]   — location text
//     [class*="styles_compensation__"] — salary + equity (strip " • X%" equity suffix)
//     [class*="styles_tags__"]       — posted date text
// Company name is not present in this card format (Wellfound's "Apply on Wellfound"
// anonymous flow); left empty rather than fabricating.
// CSS module hashes rotate on deploys — wildcard fallbacks guard against that.
export const WELLFOUND_EXTRACTOR = `
(function() {
  const jobs = [];

  const cards = document.querySelectorAll('[data-testid="job-listing-list"]');

  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('[class*="styles_title__"]');
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;

      const locationEl = card.querySelector('[class*="styles_location__"]');
      const location = locationEl?.innerText?.trim() || '';

      const salaryEl = card.querySelector('[class*="styles_compensation__"]');
      const salaryRaw = salaryEl?.innerText?.trim() || '';
      // Strip equity suffix: "$220k – $260k • 0.0% – 0.1%" → "$220k – $260k"
      const salary = salaryRaw.split(' • ')[0].trim();

      const linkEl = card.querySelector('a[href*="/jobs/"]');
      const href = linkEl?.getAttribute('href') || '';
      const url = href.startsWith('http') ? href : (href ? 'https://wellfound.com' + href : '');

      const tagsEl = card.querySelector('[class*="styles_tags__"]');
      const tagsText = tagsEl?.innerText || '';
      const postedMatch = tagsText.match(/Posted\\s+([^\\n]+)/i);
      const posted = postedMatch ? postedMatch[1].trim() : '';

      jobs.push({ title, company: '', location, salary, snippet: '', url, posted, source: 'wellfound' });
    } catch {}
  });

  if (jobs.length === 0) throw new Error('SITE_CHANGED: wellfound extractor returned 0 — data-testid or styles_* CSS module selectors may have changed');
  return jobs;
})()
`;
