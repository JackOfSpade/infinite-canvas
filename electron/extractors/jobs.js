/**
 * Job Search Extractors + Site Configs.
 *
 * Extraction strategies (in order of reliability):
 *   1. JSON State — parse window.__NEXT_DATA__, window.mosaic, apolloState
 *   2. JSON-LD   — parse <script type="application/ld+json"> schemas
 *   3. DOM       — fallback CSS selector scraping (fragile, breaks often)
 *
 * Each source exports:
 *   - An extractor JS string (IIFE that runs in page context)
 *   - A site config object with waitFor, scrollFirst, referer, etc.
 */

// ── Site Configurations ─────────────────────────────────────────────────────

export const GOOGLE_JOBS_CONFIG = {
  waitMs: 2500,
  timeoutMs: 45000,
  waitFor: '.iFjolb, .PwjeAc, [data-ved] li',
  scrollFirst: false,
  dismissCookies: true,
  waitUntil: 'domcontentloaded',
};

export const INDEED_CONFIG = {
  waitMs: 3000,
  timeoutMs: 40000,
  waitFor: '.job_seen_beacon, .resultContent, .tapItem',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

export const LINKEDIN_CONFIG = {
  waitMs: 3000,
  timeoutMs: 40000,
  waitFor: '.base-card, .job-search-card, .base-search-card',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

export const REMOTEOK_CONFIG = {
  waitMs: 2000,
  timeoutMs: 30000,
  waitFor: 'tr.job, tr[data-slug]',
  scrollFirst: false,
  dismissCookies: false,
};

export const WEWORKREMOTELY_CONFIG = {
  waitMs: 2000,
  timeoutMs: 30000,
  waitFor: 'section.jobs li a',
  scrollFirst: false,
  dismissCookies: false,
};

// ── Google Jobs ─────────────────────────────────────────────────────────────
export const GOOGLE_JOBS_EXTRACTOR = `
(function() {
  const jobs = [];
  const cards = document.querySelectorAll('[data-ved] .iFjolb, [jscontroller] li[data-ved], .PwjeAc, .gws-plugins-horizon-jobs__tl-lif');
  
  if (cards.length === 0) {
    const allLinks = document.querySelectorAll('a[href*="jobs"], a[href*="careers"]');
    allLinks.forEach(link => {
      const text = link.closest('div')?.innerText || '';
      if (text.length > 30 && text.length < 500) {
        jobs.push({
          title: link.innerText?.trim() || '',
          company: '', location: '', salary: '',
          snippet: text.substring(0, 200),
          url: link.href || '', posted: '', source: 'google'
        });
      }
    });
    return jobs.slice(0, 30);
  }

  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('[role="heading"], h3, .BjJfJf, .sH3zFe');
      const companyEl = card.querySelector('.vNEEBe, .nJlQNd, [class*="company"]');
      const locationEl = card.querySelector('.Qk80Jf, [class*="location"]');
      const salaryEl = card.querySelector('[class*="salary"], [class*="pay"]');
      const snippetEl = card.querySelector('.HBvzbc, [class*="snippet"], [class*="description"]');
      const postedEl = card.querySelector('[class*="posted"], [class*="date"], .SuWscb');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;

      jobs.push({
        title,
        company: companyEl?.innerText?.trim() || '',
        location: locationEl?.innerText?.trim() || '',
        salary: salaryEl?.innerText?.trim() || '',
        snippet: snippetEl?.innerText?.trim()?.substring(0, 300) || '',
        url: card.querySelector('a')?.href || '',
        posted: postedEl?.innerText?.trim() || '',
        source: 'google'
      });
    } catch {}
  });

  return jobs.slice(0, 30);
})()
`;

// ── Indeed ──────────────────────────────────────────────────────────────────
// Strategy 0: __NEXT_DATA__ (Indeed migrated to Next.js)
// Strategy 1: window.mosaic.providerData JSON state (legacy, immune to CSS randomization)
// Strategy 2: DOM selector scraping
export const INDEED_JOBS_EXTRACTOR = `
(function() {
  const jobs = [];
  
  // Strategy 0: Parse __NEXT_DATA__ (Indeed Next.js migration)
  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
      const nd = JSON.parse(ndEl.textContent);
      const results = nd?.props?.pageProps?.initialData?.jobSearchResults ||
                      nd?.props?.pageProps?.searchResults?.results ||
                      nd?.props?.pageProps?.results ||
                      [];
      
      results.forEach(r => {
        const job = r.job || r;
        if (!job.title) return;
        const salary = job.extractedSalary || job.salaryInfo;
        jobs.push({
          title: job.title || '',
          company: job.company || job.companyName || job.employer?.name || '',
          location: job.formattedLocation || job.location || '',
          salary: salary?.max ? ('$' + salary.min + ' - $' + salary.max) : (job.salarySnippet?.text || ''),
          snippet: (job.snippet || job.description || '').replace(/<[^>]*>/g, ' ').substring(0, 300),
          url: job.link ? ('https://www.indeed.com' + job.link) : (job.jobkey ? ('https://www.indeed.com/viewjob?jk=' + job.jobkey) : ''),
          posted: job.formattedRelativeTime || job.pubDate || '',
          source: 'indeed'
        });
      });
      if (jobs.length > 0) return jobs.slice(0, 30);
    }
  } catch {}

  // Strategy 1: Parse mosaic provider JSON state (legacy)
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      const match = text.match(/window\\.mosaic\\.providerData\\["mosaic-provider-jobcards"\\]\\s*=\\s*(\\{.+?\\});/s);
      if (match) {
        const data = JSON.parse(match[1]);
        const results = data?.metaData?.mosaicProviderJobCardsModel?.results ||
                        data?.results ||
                        [];
        
        results.forEach(r => {
          if (!r.title) return;
          jobs.push({
            title: r.title || '',
            company: r.company || r.companyName || '',
            location: r.formattedLocation || r.location || '',
            salary: r.extractedSalary?.max ? ('$' + r.extractedSalary.min + ' - $' + r.extractedSalary.max) : (r.salarySnippet?.text || ''),
            snippet: (r.snippet || r.jobSnippet || '').substring(0, 300),
            url: r.link ? ('https://www.indeed.com' + r.link) : (r.jobkey ? ('https://www.indeed.com/viewjob?jk=' + r.jobkey) : ''),
            posted: r.formattedRelativeTime || r.pubDate || '',
            source: 'indeed'
          });
        });
        if (jobs.length > 0) return jobs.slice(0, 30);
      }
    }
  } catch {}
  
  // Strategy 2: Fallback DOM parsing
  const cards = document.querySelectorAll('.job_seen_beacon, .resultContent, .tapItem, [data-jk]');
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('.jobTitle a, .jcs-JobTitle, h2 a, [data-jk] a');
      const companyEl = card.querySelector('.companyName, [data-testid="company-name"], .css-1h7lukg');
      const locationEl = card.querySelector('.companyLocation, [data-testid="text-location"], .css-1restlb');
      const salaryEl = card.querySelector('.salary-snippet-container, .estimated-salary, [class*="salary"]');
      const snippetEl = card.querySelector('.job-snippet, .css-9446fg, [class*="snippet"]');
      const postedEl = card.querySelector('.date, [class*="date"]');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;

      jobs.push({
        title,
        company: companyEl?.innerText?.trim() || '',
        location: locationEl?.innerText?.trim() || '',
        salary: salaryEl?.innerText?.trim() || '',
        snippet: snippetEl?.innerText?.trim()?.substring(0, 300) || '',
        url: titleEl?.href ? (titleEl.href.startsWith('http') ? titleEl.href : 'https://www.indeed.com' + titleEl.getAttribute('href')) : '',
        posted: postedEl?.innerText?.trim() || '',
        source: 'indeed'
      });
    } catch {}
  });

  return jobs.slice(0, 30);
})()
`;

// ── LinkedIn ────────────────────────────────────────────────────────────────
export const LINKEDIN_JOBS_EXTRACTOR = `
(function() {
  const jobs = [];
  const cards = document.querySelectorAll('.base-card, .job-search-card, .base-search-card, [data-entity-urn]');
  
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('.base-search-card__title, .job-search-card__title, h3, h4');
      const companyEl = card.querySelector('.base-search-card__subtitle, .job-search-card__company-name, h4 + div a');
      const locationEl = card.querySelector('.job-search-card__location, .job-result-card__location, [class*="location"]');
      const linkEl = card.querySelector('a.base-card__full-link, a.base-search-card__full-link, a[href*="/jobs/view"]');
      const postedEl = card.querySelector('time, [datetime], [class*="listed"]');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;

      jobs.push({
        title,
        company: companyEl?.innerText?.trim() || '',
        location: locationEl?.innerText?.trim() || '',
        salary: '',
        snippet: '',
        url: linkEl?.href || '',
        posted: postedEl?.innerText?.trim() || postedEl?.getAttribute('datetime') || '',
        source: 'linkedin'
      });
    } catch {}
  });

  return jobs.slice(0, 30);
})()
`;

// ── RemoteOK ────────────────────────────────────────────────────────────────
export const REMOTEOK_EXTRACTOR = `
(function() {
  const jobs = [];
  const rows = document.querySelectorAll('tr.job, tr[data-slug]');
  
  rows.forEach(row => {
    try {
      const titleEl = row.querySelector('[itemprop="title"], h2, .company_and_position h2');
      const companyEl = row.querySelector('[itemprop="hiringOrganization"] h3, .companyLink h3, .company h3');
      const locationEl = row.querySelector('.location, [class*="location"]');
      const salaryEl = row.querySelector('[class*="salary"]');
      const linkEl = row.querySelector('a.preventLink, a[href*="/remote-jobs/"]');
      const tagsEls = row.querySelectorAll('.tag h3, .tags .tag');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;

      const tags = Array.from(tagsEls).map(t => t.innerText?.trim()).filter(Boolean).join(', ');

      jobs.push({
        title,
        company: companyEl?.innerText?.trim() || '',
        location: locationEl?.innerText?.trim() || 'Remote',
        salary: salaryEl?.innerText?.trim() || '',
        snippet: tags ? 'Tags: ' + tags : '',
        url: linkEl ? 'https://remoteok.com' + linkEl.getAttribute('href') : '',
        posted: '',
        source: 'remoteok'
      });
    } catch {}
  });

  return jobs.slice(0, 30);
})()
`;

// ── WeWorkRemotely ──────────────────────────────────────────────────────────
export const WEWORKREMOTELY_EXTRACTOR = `
(function() {
  const jobs = [];
  const items = document.querySelectorAll('section.jobs li > a[href*="/remote-jobs/"], article.job-listing a');
  
  items.forEach(link => {
    try {
      const titleEl = link.querySelector('.title, h4, h3');
      const companyEl = link.querySelector('.company, .company span');
      const regionEl = link.querySelector('.region, [class*="region"]');
      
      const title = titleEl?.innerText?.trim() || link.innerText?.split('\\n').find(l => l.trim().length > 5)?.trim() || '';
      if (!title) return;

      jobs.push({
        title,
        company: companyEl?.innerText?.trim() || '',
        location: regionEl?.innerText?.trim() || 'Remote',
        salary: '',
        snippet: '',
        url: link.href?.startsWith('http') ? link.href : 'https://weworkremotely.com' + link.getAttribute('href'),
        posted: '',
        source: 'weworkremotely'
      });
    } catch {}
  });

  return jobs.slice(0, 30);
})()
`;

// ── ZipRecruiter ────────────────────────────────────────────────────────────

export const ZIPRECRUITER_CONFIG = {
  waitMs: 3000,
  timeoutMs: 40000,
  waitFor: '.job_content, .jobList article, [data-testid="job-card"]',
  scrollFirst: true,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

// Strategy 0: __NEXT_DATA__ (ZipRecruiter is Next.js — contains salary ranges JSON-LD omits)
// Strategy 1: JSON-LD schema
// Strategy 2: DOM fallback
export const ZIPRECRUITER_EXTRACTOR = `
(function() {
  const jobs = [];
  
  // Strategy 0: Parse __NEXT_DATA__ (richer data than JSON-LD)
  try {
    const ndEl = document.getElementById('__NEXT_DATA__');
    if (ndEl) {
      const nd = JSON.parse(ndEl.textContent);
      const listings = nd?.props?.pageProps?.jobListings ||
                       nd?.props?.pageProps?.jobs ||
                       nd?.props?.pageProps?.searchResults?.jobs ||
                       [];
      
      listings.forEach(item => {
        const job = item.job || item;
        if (!job.title && !job.name) return;
        
        const salary = job.salary || job.compensation;
        const salaryStr = salary?.min ? ('$' + salary.min + (salary.max ? ' - $' + salary.max : '') + (salary.interval ? '/' + salary.interval : '')) : '';
        
        jobs.push({
          title: job.title || job.name || '',
          company: job.hiring_company?.name || job.companyName || job.hiringOrganization?.name || '',
          location: job.location || (job.city ? (job.city + (job.state ? ', ' + job.state : '')) : ''),
          salary: salaryStr || job.salary_text || '',
          snippet: (job.snippet || job.description || '').replace(/<[^>]*>/g, ' ').substring(0, 300),
          url: job.url || job.save_url || '',
          posted: job.posted_time || job.posted_time_friendly || '',
          source: 'ziprecruiter'
        });
      });
      if (jobs.length > 0) return jobs.slice(0, 30);
    }
  } catch {}

  // Strategy 1: Parse JSON-LD structured data
  try {
    const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      const data = JSON.parse(script.textContent);
      // Handle both single JobPosting and ItemList containing JobPostings
      const items = data['@type'] === 'ItemList' ? (data.itemListElement || []) :
                    data['@type'] === 'JobPosting' ? [data] :
                    Array.isArray(data) ? data : [];
      
      items.forEach(item => {
        const posting = item.item || item;
        if (posting['@type'] !== 'JobPosting') return;
        
        const salary = posting.baseSalary?.value;
        const salaryStr = salary ? ('$' + (salary.minValue || '') + (salary.maxValue ? ' - $' + salary.maxValue : '') + (salary.unitText ? '/' + salary.unitText : '')) : '';
        
        jobs.push({
          title: posting.title || '',
          company: posting.hiringOrganization?.name || '',
          location: posting.jobLocation?.address?.addressLocality ? (posting.jobLocation.address.addressLocality + (posting.jobLocation.address.addressRegion ? ', ' + posting.jobLocation.address.addressRegion : '')) : '',
          salary: salaryStr,
          snippet: (posting.description || '').replace(/<[^>]*>/g, ' ').replace(/\\s+/g, ' ').trim().substring(0, 300),
          url: posting.url || '',
          posted: posting.datePosted || '',
          source: 'ziprecruiter'
        });
      });
    }
    if (jobs.length > 0) return jobs.slice(0, 30);
  } catch {}
  
  // Strategy 2: Fallback DOM parsing
  const cards = document.querySelectorAll('.job_content, .jobList article, [data-testid="job-card"], .job_result_card');
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('.job_title a, h2 a, [data-testid="job-title"], .job_title');
      const companyEl = card.querySelector('.t_org_link, [data-testid="company-name"], .company_name, .hiring_company');
      const locationEl = card.querySelector('.location, [data-testid="location"], .job_location');
      const salaryEl = card.querySelector('.salary, [data-testid="salary"], .job_salary, .compensation');
      const snippetEl = card.querySelector('.job_snippet, [data-testid="description"], .snippet');
      const postedEl = card.querySelector('.posted, [data-testid="posted"], .job_age, time');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;

      jobs.push({
        title,
        company: companyEl?.innerText?.trim() || '',
        location: locationEl?.innerText?.trim() || '',
        salary: salaryEl?.innerText?.trim() || '',
        snippet: snippetEl?.innerText?.trim()?.substring(0, 300) || '',
        url: titleEl?.href || titleEl?.closest('a')?.href || '',
        posted: postedEl?.innerText?.trim() || '',
        source: 'ziprecruiter'
      });
    } catch {}
  });

  return jobs.slice(0, 30);
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

// Strategy 0: __NEXT_DATA__ > apolloCache (Glassdoor migrated to Next.js)
// Strategy 1: apolloState regex from inline script
// Strategy 2: DOM selector scraping (works even with login overlay)
export const GLASSDOOR_EXTRACTOR = `
(function() {
  const jobs = [];
  
  // Strategy 0: Parse __NEXT_DATA__ > apolloCache
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
          salary: value.salarySource?.payRange ? (value.salarySource.payRange) : (value.salaryEstimate || ''),
          snippet: (employer.overallRating ? 'Rating: ' + employer.overallRating + '/5 | ' : '') + (value.jobDescription || '').substring(0, 250),
          url: value.seoJobLink ? ('https://www.glassdoor.com' + value.seoJobLink) : (value.jobLink || ''),
          posted: value.ageInDays != null ? (value.ageInDays + 'd ago') : '',
          source: 'glassdoor'
        });
      }
      if (jobs.length > 0) return jobs.slice(0, 30);
    }
  } catch {}

  // Strategy 1: Parse Apollo GraphQL state from inline script
  try {
    const scripts = document.querySelectorAll('script');
    for (const script of scripts) {
      const text = script.textContent || '';
      if (!text.includes('apolloState')) continue;
      
      const match = text.match(/"apolloState"\\s*:\\s*(\\{.+\\})\\s*[,}]/s);
      if (!match) continue;
      
      const state = JSON.parse(match[1]);
      
      // Apollo state keys are like 'JobListingSearchResult:12345' or contain job data
      for (const [key, value] of Object.entries(state)) {
        if (!value || typeof value !== 'object') continue;
        
        // Look for job listing objects in the Apollo cache
        const isJob = key.includes('JobListing') || key.includes('jobListingSe') || 
                      (value.__typename && value.__typename.includes('Job'));
        if (!isJob || !value.jobTitleText) continue;
        
        const employer = value.employer ? state[value.employer.__ref || ''] || value.employer : {};
        
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
      if (jobs.length > 0) return jobs.slice(0, 30);
    }
  } catch {}
  
  // Strategy 2: Fallback DOM parsing (works even with login overlay)
  const cards = document.querySelectorAll('[data-test="jobListing"], .JobCard_jobCardWrapper, .react-job-listing, li[data-id]');
  cards.forEach(card => {
    try {
      const titleEl = card.querySelector('[data-test="job-title"], .job-title, .JobCard_jobTitle, a[data-test="job-link"]');
      const companyEl = card.querySelector('[data-test="emp-name"], .EmployerProfile_employerName, .job-search-key-l2q5hy');
      const locationEl = card.querySelector('[data-test="emp-location"], .location, .JobCard_location');
      const salaryEl = card.querySelector('[data-test="detailSalary"], .salary-estimate, .SalaryEstimate');
      const ratingEl = card.querySelector('[data-test="rating"], .rating, .CompanyRating');
      const linkEl = card.querySelector('a[href*="/job-listing/"], a[data-test="job-link"]');
      
      const title = titleEl?.innerText?.trim() || '';
      if (!title) return;

      const rating = ratingEl?.innerText?.trim() || '';
      const salary = salaryEl?.innerText?.trim() || '';

      jobs.push({
        title,
        company: companyEl?.innerText?.trim() || '',
        location: locationEl?.innerText?.trim() || '',
        salary: salary,
        snippet: rating ? 'Rating: ' + rating + (salary ? ' | ' + salary : '') : '',
        url: linkEl?.href || '',
        posted: '',
        source: 'glassdoor'
      });
    } catch {}
  });

  return jobs.slice(0, 30);
})()
`;
// ── Wellfound (AngelList) ───────────────────────────────────────────────────

export const WELLFOUND_CONFIG = {
  waitMs: 3000,
  timeoutMs: 40000,
  waitFor: '#__NEXT_DATA__, [class*="styles_result"], [class*="JobListing"]',
  scrollFirst: false,
  dismissCookies: true,
  referer: 'https://www.google.com/',
};

export const WELLFOUND_EXTRACTOR = `
(function() {
  const jobs = [];
  
  // Strategy 1: Parse __NEXT_DATA__ JSON (most reliable)
  const nextData = document.getElementById('__NEXT_DATA__');
  if (nextData) {
    try {
      const parsed = JSON.parse(nextData.textContent);
      const listings = parsed?.props?.pageProps?.listings ||
                       parsed?.props?.pageProps?.data?.seoLandingPage?.startupSearchResults?.edges ||
                       parsed?.props?.pageProps?.jobListings ||
                       [];
      
      const items = Array.isArray(listings) ? listings : (listings.edges || listings.nodes || []);
      
      items.forEach(item => {
        const node = item.node || item;
        const startup = node.startup || node.company || {};
        const title = node.title || node.role || '';
        if (!title) return;
        
        jobs.push({
          title,
          company: startup.name || startup.companyName || '',
          location: node.locationNames?.length ? node.locationNames.join(', ') : (node.remote ? 'Remote' : ''),
          salary: node.compensation ? node.compensation : '',
          snippet: startup.highConcept || startup.oneLiner || '',
          url: node.slug ? 'https://wellfound.com/jobs/' + node.slug : (node.url || ''),
          posted: node.liveStartAt || '',
          source: 'wellfound'
        });
      });
    } catch {}
  }
  
  // Strategy 2: Fallback DOM parsing
  if (jobs.length === 0) {
    const cards = document.querySelectorAll('[class*="styles_result"], [class*="JobListing"], [data-test="StartupResult"]');
    cards.forEach(card => {
      try {
        const titleEl = card.querySelector('[class*="jobTitle"], [class*="title"] a, h4 a');
        const companyEl = card.querySelector('[class*="startup-link"], [class*="companyName"], h2 a');
        const locationEl = card.querySelector('[class*="location"], [class*="tags"] span');
        const salaryEl = card.querySelector('[class*="compensation"], [class*="salary"]');
        
        const title = titleEl?.innerText?.trim() || '';
        if (!title) return;
        
        jobs.push({
          title,
          company: companyEl?.innerText?.trim() || '',
          location: locationEl?.innerText?.trim() || '',
          salary: salaryEl?.innerText?.trim() || '',
          snippet: '',
          url: titleEl?.href || '',
          posted: '',
          source: 'wellfound'
        });
      } catch {}
    });
  }

  return jobs.slice(0, 30);
})()
`;

