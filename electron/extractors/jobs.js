/**
 * Job Search Extractors + Site Configs.
 *
 * Each platform has ONE best strategy. If it returns 0 results, the extractor
 * throws SITE_CHANGED so the failure surfaces immediately as a 'stale-selectors'
 * warning — the user is told to update the scraper code rather than silently
 * getting 0 jobs. There are no fallback chains.
 *
 * Exceptions: Swappa (0 = no model match, not broken), PriceCharting (niche source, 0 is valid).
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

  if (jobs.length === 0) {
    // Titles like "0 Category Manager Jobs..." = genuine empty results page, not a breakage.
    if (/^0\\s/.test((document.title || '').trim())) return [];
    throw new Error('SITE_CHANGED: ziprecruiter ItemList JSON-LD extractor returned 0 — JSON-LD structure or @type may have changed');
  }
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

// Strategy 1: __NEXT_DATA__ Apollo cache (server-rendered, fast).
// Strategy 2: DOM card extraction (fallback — Glassdoor may not inject __NEXT_DATA__
//   when using Next.js App Router or client-side rendering on subsequent navigations).
// Throws SITE_CHANGED only when both strategies yield 0 results.
export const GLASSDOOR_EXTRACTOR = `
(function() {
  const jobs = [];

  // Strategy 1: __NEXT_DATA__ Apollo cache
  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
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
          salary: value.salarySource?.payRange ? String(value.salarySource.payRange) : (value.salaryEstimate || ''),
          snippet: (employer.overallRating ? 'Rating: ' + employer.overallRating + '/5 | ' : '') + (value.jobDescription || ''),
          url: value.seoJobLink ? ('https://www.glassdoor.com' + value.seoJobLink) : (value.jobLink || ''),
          posted: value.ageInDays != null ? (value.ageInDays + 'd ago') : '',
          source: 'glassdoor'
        });
      }
    }
  } catch {}

  // Strategy 2: DOM card extraction
  if (jobs.length === 0) {
    const cards = document.querySelectorAll('[data-test="jobListing"], .JobCard_jobCardWrapper, li[data-jobid]');
    cards.forEach(card => {
      try {
        const jobId = card.getAttribute('data-jobid') || '';

        const titleEl = card.querySelector(
          '[data-test="jobTitle"], a[data-test="job-title"], h3, h2, a[class*="trackingLink"], a[class*="jobTitle"]'
        );
        const title = titleEl?.innerText?.trim() || '';
        if (!title) return;

        const linkEl = card.querySelector('a[href*="jl="], a[href*="partner/jobListing"], a[href*="JobViewIAF"]')
                    || (titleEl?.tagName === 'A' ? titleEl : null)
                    || titleEl?.closest('a')
                    || card.querySelector('a[href*=".htm"]');
        const href = linkEl?.getAttribute('href') || (jobId ? '/partner/jobListing.htm?jl=' + jobId : '');
        const url = href.startsWith('http') ? href : (href ? 'https://www.glassdoor.com' + href : '');

        // Employer NAME only. The name-specific selectors come first because
        // [data-test="detailRecruiter"] is the wrapper that also holds the star
        // rating, and innerText on it yields "Marshalls\\n3.4" — a company name
        // no downstream consumer can use (it reached the scoring prompt, the
        // card, and broke the seen-history CSV, whose reader is line-based).
        // Belt-and-braces: keep only the first line and drop a trailing rating.
        const companyEl = card.querySelector(
          '[data-test="employer-name"], [class*="EmployerProfile_employerName"], [class*="employer-name"], [data-test="detailRecruiter"]'
        );
        // A rating is always one decimal place ("3.4", "4.0"), so requiring the
        // decimal keeps a real company name like "Studio 5" intact.
        const company = (companyEl?.innerText || '')
          .split('\\n')[0]
          .replace(/\\s+[0-5]\\.\\d\\s*$/, '')
          .trim();

        const locationEl = card.querySelector('[data-test="location"], [data-test="emp-location"]');
        const location = locationEl?.innerText?.trim() || '';

        const salaryEl = card.querySelector('[data-test="detailSalary"], [class*="salary" i]');
        const salary = salaryEl?.innerText?.trim() || '';

        const dateEl = card.querySelector('[data-test="job-age"], [class*="jobAge"]');
        const posted = dateEl?.innerText?.trim() || '';

        jobs.push({ title, company, location, salary, snippet: '', url, posted, source: 'glassdoor' });
      } catch {}
    });
  }

  if (jobs.length === 0) {
    const bodyText = document.body?.innerText || '';
    if (/no jobs found|0 jobs|no matching jobs|we couldn.t find/i.test(bodyText)) return [];
    throw new Error('SITE_CHANGED: glassdoor extractor returned 0 — __NEXT_DATA__ Apollo cache absent and DOM card selectors matched nothing');
  }
  return jobs;
})()
`;
// ── Google Jobs ──────────────────────────────────────────────────────────────

export const GOOGLE_JOBS_CONFIG = {
  waitMs: 2500,
  timeoutMs: 25000,
  // waitFor intentionally null — bot-throttled sessions never reach the selector
  // and we'd hang for the full timeout. Scrolling is handled by SCROLL_SOURCES
  // in manualScraper.js after domcontentloaded fires.
  waitFor: null,
  scrollFirst: false,
  dismissCookies: true,
  waitUntil: 'domcontentloaded',
};

// Google Jobs (served at ?q=…&udm=8; the old ibp=htl;jobs param now 302-redirects
// there). The udm=8 RESULT LIST cards are UNCHANGED from the old panel — still
// .EimVGf / [jscontroller="b11o3b"] containers, each with a data-share-url and a
// .GoEOPd content group (title .tNxQIb, then company + location divs). (The
// data-result-index / aria-label="Job details" markup only exists in the per-job
// DETAIL view you reach by clicking a card — NOT the list we scrape; don't target
// it here.) Class names are obfuscated hashes that rotate on deploys — pair them
// with semantic fallbacks ([role="heading"] etc.). Verified against a live udm=8
// list card 2026-06.
//
// NOTE: a thin result count (e.g. 1) is almost always bot-throttling of the stealth
// session (datacenter/VPN egress), NOT stale selectors — confirm in a real browser
// before "fixing" the selectors.
//
// Does NOT throw SITE_CHANGED on 0 — bot detection legitimately blocks the
// jobs panel entirely; 0 means "blocked", not "broken selectors".
export const GOOGLE_JOBS_EXTRACTOR = `
(function() {
  const jobs = [];
  const cards = document.querySelectorAll('.EimVGf, [jscontroller="b11o3b"]');

  // Free-form pay chip ("$50K–70K a year", "18–22 an hour") — fallback when the
  // semantic aria-label="Salary $X" anchor isn't on the card.
  const payRe = /\\$?\\s?\\d[\\d.,]*\\s?[KkMm]?(?:\\s?[–-]\\s?\\$?\\s?\\d[\\d.,]*\\s?[KkMm]?)?\\s?(?:an hour|a year|a month|a week|per (?:hour|year|month)|\\/(?:yr|hr|year|hour|mo))/i;

  cards.forEach(card => {
    try {
      const url = card.getAttribute('data-share-url') || '';

      const titleEl = card.querySelector('.tNxQIb, [role="heading"], h3');
      const title = titleEl?.innerText?.trim() || '';
      if (!title || title === 'Jobs') return;

      // Company + location: positional children of the content grouping div
      // (.GoEOPd > [title, company, location]). Location line is "City, ST • via Source".
      const contentGroup = card.querySelector('.GoEOPd') || titleEl?.parentElement;
      const contentDivs = contentGroup ? Array.from(contentGroup.querySelectorAll(':scope > div')) : [];
      const company = contentDivs[1]?.innerText?.trim() || '';
      const location = (contentDivs[2]?.innerText?.trim() || '').split(/[•·]/)[0].trim();

      // Posted date + employment type from bare <span> elements (no class attr).
      const bareSpans = Array.from(card.querySelectorAll('span:not([class])'))
        .map(s => s.innerText?.trim()).filter(Boolean);
      const posted = bareSpans.find(s => /\\d+\\s+(day|week|hour|month)/i.test(s) || s === 'Just now') || '';
      const empType = bareSpans.find(s => /full[- ]?time|part[- ]?time|contract|intern/i.test(s)) || '';

      // Salary: prefer the semantic aria-label="Salary $X" anchor (keeps the currency
      // even when the visible chip drops it); fall back to a money-text scan of the card.
      let salary = '';
      const salAria = card.querySelector('[aria-label^="Salary"]');
      if (salAria) salary = (salAria.getAttribute('aria-label') || '').replace(/^Salary\\s*/i, '').trim();
      if (!salary) {
        for (const el of card.querySelectorAll('span, div')) {
          const t = (el.innerText || '').trim();
          if (t && t.length <= 40 && payRe.test(t)) { salary = t; break; }
        }
      }

      // The employment label is useful metadata but is not a job description.
      // Keeping it out of the snippet field lets the description-expansion walk report
      // (and downstream scoring receive) the truthful empty state until the
      // card panel was actually read.
      jobs.push({ title, company, location, salary, employmentType: empType, snippet: '', url, posted, source: 'google' });
    } catch {}
  });

  return jobs;
})()
`;
