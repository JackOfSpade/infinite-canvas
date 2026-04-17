/**
 * Jobs IPC handlers — resume parsing, multi-source job search, AI scoring.
 * 12 Sources: Google, Indeed, LinkedIn, RemoteOK, WeWorkRemotely,
 *             ZipRecruiter, Glassdoor, Dice, Wellfound,
 *             Greenhouse API, Lever API, USAJobs API
 */
import electronPkg from 'electron';
const { ipcMain } = electronPkg;
import { callGeminiDocument, callGeminiText } from './gemini.js';
import { scrapeMultiple } from './browserPool.js';
import { 
  GOOGLE_JOBS_EXTRACTOR, GOOGLE_JOBS_CONFIG,
  INDEED_JOBS_EXTRACTOR, INDEED_CONFIG,
  ZIPRECRUITER_EXTRACTOR, ZIPRECRUITER_CONFIG,
  GLASSDOOR_EXTRACTOR, GLASSDOOR_CONFIG,
  WELLFOUND_EXTRACTOR, WELLFOUND_CONFIG,
} from '../extractors/jobs.js';
import {
  fetchLinkedInJobs,
  fetchGreenhouseJobs,
  fetchLeverJobs,
  fetchUSAJobs,
  fetchRemoteOKJobs,
  fetchWeWorkRemotelyJobs,
  fetchDiceListings,
} from '../extractors/apiExtractors.js';

// All source IDs — defines the complete set for progress tracking and reporting.
const ALL_SOURCE_IDS = [
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice', 'wellfound',
  'greenhouse', 'lever', 'usajobs',
];

// Sources that moved from browser pool to direct API (per deep research report):
// - remoteok: Open JSON API at remoteok.com/api (zero WAF)
// - weworkremotely: RSS feed at weworkremotely.com/remote-jobs.rss (zero WAF)

// ── Source → URL + Extractor + Config mapping (DOM scrape sources only) ──────
// LinkedIn has been moved to the API pool (fetchLinkedInJobs) — no Puppeteer needed.
function buildJobTasks(queries) {
  // Browser pool extractors — only platforms that REQUIRE Puppeteer rendering.
  // RemoteOK and WeWorkRemotely have been moved to fetchApiSources (direct HTTP).
  const extractors = {
    google:          { extractor: GOOGLE_JOBS_EXTRACTOR,      config: GOOGLE_JOBS_CONFIG,      urlFn: q => `https://www.google.com/search?q=${encodeURIComponent(q)}&ibp=htl;jobs` },
    indeed:          { extractor: INDEED_JOBS_EXTRACTOR,      config: INDEED_CONFIG,           urlFn: q => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&fromage=14` },
    ziprecruiter:    { extractor: ZIPRECRUITER_EXTRACTOR,     config: ZIPRECRUITER_CONFIG,     urlFn: q => `https://www.ziprecruiter.com/jobs-search?search=${encodeURIComponent(q)}&days=14` },
    glassdoor:       { extractor: GLASSDOOR_EXTRACTOR,        config: GLASSDOOR_CONFIG,        urlFn: q => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}` },
    wellfound:       { extractor: WELLFOUND_EXTRACTOR,        config: WELLFOUND_CONFIG,        urlFn: q => `https://wellfound.com/role/${q.toLowerCase().replace(/\s+/g, '-')}` },
  };

  const tasks = [];
  // Remote-only boards get fewer queries; heavy WAF sites get only the first query
  for (const [sourceId, { extractor, config, urlFn }] of Object.entries(extractors)) {
    const isHeavyWAF = sourceId === 'ziprecruiter' || sourceId === 'glassdoor';
    const querySubset = isHeavyWAF ? queries.slice(0, 1) : queries.slice(0, 2);

    querySubset.forEach((q, i) => {
      tasks.push({
        id: `${sourceId}-${i}`,
        sourceId,
        url: urlFn(q),
        extractorJS: extractor,
        options: config,
      });
    });
  }
  return tasks;
}

/**
 * Fetch API-based sources in parallel (no Puppeteer needed).
 * @returns {{ sourceId: string, jobs: object[], error?: string }[]}
 */
async function fetchApiSources(queries, sender) {
  const firstQuery = queries[0] || '';
  const apiKey = process.env.USAJOBS_API_KEY || '';
  const email = process.env.USAJOBS_EMAIL || '';

  const apiTasks = [
    { sourceId: 'linkedin',       fn: () => fetchLinkedInJobs(firstQuery) },
    { sourceId: 'greenhouse',     fn: () => fetchGreenhouseJobs(firstQuery) },
    { sourceId: 'lever',          fn: () => fetchLeverJobs(firstQuery) },
    { sourceId: 'usajobs',        fn: () => fetchUSAJobs(firstQuery, apiKey, email) },
    { sourceId: 'remoteok',       fn: () => fetchRemoteOKJobs(firstQuery) },
    { sourceId: 'weworkremotely', fn: () => fetchWeWorkRemotelyJobs(firstQuery) },
    { sourceId: 'dice',           fn: () => fetchDiceListings(firstQuery) },
  ];

  // Notify frontend that API sources are starting
  for (const { sourceId } of apiTasks) {
    if (!sender.isDestroyed()) {
      sender.send('job-source-progress', { sourceId, status: 'searching', count: 0 });
    }
  }

  const results = await Promise.allSettled(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      const jobs = await fn();
      return { sourceId, jobs };
    } catch (error) {
      return { sourceId, jobs: [], error: error?.message || String(error) };
    }
  }));

  return results.map(r => r.status === 'fulfilled' ? r.value : { sourceId: 'unknown', jobs: [], error: 'Promise rejected' });
}

/**
 * Register all Jobs IPC handlers.
 */
export function registerJobsHandlers() {

  // ── Parse Resume ──────────────────────────────────────────────────────────
  ipcMain.handle('parse-resume', async (_event, { filePath }) => {
    try {
      console.log('[Jobs] Parsing resume:', filePath);
      const profile = await callGeminiDocument(filePath, `
Analyze this resume/CV thoroughly. Return a JSON object with:
{
  "titles": ["exact job titles held, most recent first"],
  "skills": ["all technical and professional skills mentioned"],
  "experience_years": number (total years of professional experience),
  "soft_skills": ["leadership, mentoring, communication examples found"],
  "industries": ["industries worked in"],
  "locations": ["cities/states/countries mentioned or implied"],
  "education": ["degrees, certifications, notable training"],
  "summary": "A 2-sentence professional summary of this person"
}
Extract everything you can find. Be thorough.`);

      console.log('[Jobs] Resume parsed:', profile.titles?.join(', '));
      return { success: true, profile };
    } catch (error) {
      console.error('[Jobs] Resume parse failed:', error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });

  // ── Generate Search Queries (Three-Prong Strategy) ────────────────────────
  ipcMain.handle('generate-job-queries', async (_event, { profile }) => {
    try {
      const result = await callGeminiText(`
You are a career strategist. Given this professional profile, generate search queries for a job search.

Profile:
${JSON.stringify(profile, null, 2)}

Return a JSON object with three arrays of search query strings:

{
  "titleQueries": ["2-3 queries using their exact job titles + location, e.g. 'senior backend engineer denver'"],
  "suggestedRoleQueries": ["3-5 queries for roles they could transition into — adjacent, stretch, and pivot roles they may not have considered. Think creatively: a backend engineer could be an engineering manager, developer advocate, solutions architect, technical PM, etc. Include the location."],
  "skillsOnlyQueries": ["2-3 queries using ONLY their skills and experience level, NO job title at all, e.g. 'python kubernetes 8 years team lead distributed systems'. This is intentionally broad to surface unexpected matches."]
}

Be creative with suggestedRoleQueries — think about what career directions their skills unlock that they might not have considered.`);

      return { success: true, queries: result };
    } catch (error) {
      console.error('[Jobs] Query generation failed:', error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });

  // ── Search Jobs (Multi-Source Phase 2) ────────────────────────────────────
  ipcMain.handle('search-jobs', async (event, { queries }) => {
    try {
      console.log('[Jobs] Searching with', queries.length, 'queries across 12 sources');

      const tasks = buildJobTasks(queries);
      
      // Group tasks by source for per-source progress tracking
      const sourceTaskIds = {};
      for (const t of tasks) {
        if (!sourceTaskIds[t.sourceId]) sourceTaskIds[t.sourceId] = [];
        sourceTaskIds[t.sourceId].push(t.id);
      }

      // Notify frontend that sources are starting
      for (const sourceId of Object.keys(sourceTaskIds)) {
        if (!event.sender.isDestroyed()) {
          event.sender.send('job-source-progress', { sourceId, status: 'searching', count: 0 });
        }
      }

      const allJobs = [];
      const sourceResults = {};
      
      // 1. Run Scraper Tasks
      const results = await scrapeMultiple(tasks);
      for (const result of results) {
        const sourceId = result.id.replace(/-\d+$/, '');
        if (!sourceResults[sourceId]) sourceResults[sourceId] = { jobs: [], errors: 0 };

        if (result.success && Array.isArray(result.data)) {
          const tagged = result.data.map(j => ({ ...j, source: sourceId }));
          sourceResults[sourceId].jobs.push(...tagged);
          allJobs.push(...tagged);
        } else {
          sourceResults[sourceId].errors++;
          console.warn(`[Jobs] Source ${result.id} failed:`, result.error);
        }
      }

      // 2. Run API Tasks
      const apiResults = await fetchApiSources(queries, event.sender);
      for (const res of apiResults) {
        if (!sourceResults[res.sourceId]) sourceResults[res.sourceId] = { jobs: [], errors: 0 };
        if (res.jobs.length > 0) {
          const tagged = res.jobs.map(j => ({ ...j, source: res.sourceId }));
          sourceResults[res.sourceId].jobs.push(...tagged);
          allJobs.push(...tagged);
        } else if (res.error) {
          sourceResults[res.sourceId].errors++;
        }
      }

      // Send per-source completion events
      for (const sourceId of ALL_SOURCE_IDS) {
        const data = sourceResults[sourceId] || { jobs: [], errors: 0 };
        const allFailed = data.errors > 0 && data.jobs.length === 0;
        const status = (data.jobs.length === 0 && data.errors === 0) ? 'idle' : (allFailed ? 'error' : 'done');
        
        if (!event.sender.isDestroyed()) {
          event.sender.send('job-source-progress', {
            sourceId,
            status,
            count: data.jobs.length,
          });
        }
      }

      // Deduplicate by normalized company + title
      const seen = new Set();
      const deduped = allJobs.filter(job => {
        const key = `${(job.title || '').toLowerCase().trim()}|${(job.company || '').toLowerCase().trim()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });

      console.log(`[Jobs] Found ${deduped.length} unique jobs (from ${allJobs.length} total across ${Object.keys(sourceResults).length} sources)`);
      return { success: true, jobs: deduped, sourceResults };
    } catch (error) {
      console.error('[Jobs] Search failed:', error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });

  // ── Score Jobs Against Resume ─────────────────────────────────────────────
  ipcMain.handle('score-jobs', async (_event, { jobs, profile }) => {
    try {
      console.log('[Jobs] Scoring', jobs.length, 'jobs');

      // Batch into groups of 15
      const BATCH_SIZE = 15;
      const scoredJobs = [];

      for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
        const batch = jobs.slice(i, i + BATCH_SIZE);
        const batchResult = await callGeminiText(`
You are a career matching expert. Score each job against this candidate's profile.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

JOBS TO SCORE (array):
${JSON.stringify(batch, null, 2)}

For each job, return a JSON array with one object per job:
[
  {
    "index": 0,
    "matchScore": 85,
    "reasoning": "1-2 sentences explaining WHY this matches or doesn't. Read between the lines — a startup wanting a 'manager with engineering depth' is a match for an experienced engineer even without management title.",
    "careerDirection": "Engineering | Leadership | Product | DevRel | Consulting | Design | Data | Operations | Teaching | Other",
    "strengthLabel": "strong | exploring | stretch | unexpected"
  }
]

IMPORTANT SCORING RULES:
- Don't just match title-to-title. Read the job requirements deeply.
- A startup "manager" role that wants someone who's been in the trenches IS a match for an experienced IC.
- Skills-only matches without title match can still score 70%+ if requirements align.
- Score 85%+ only for genuinely strong matches.
- "unexpected" label is for jobs from the skills-only queries that reveal surprising career paths.
- Aim for 3-7 distinct careerDirection categories total. Merge small categories.`);

        if (Array.isArray(batchResult)) {
          batch.forEach((job, idx) => {
            const score = batchResult.find(s => s.index === idx) || { matchScore: 50, reasoning: 'Unable to score', careerDirection: 'Other', strengthLabel: 'exploring' };
            scoredJobs.push({ ...job, ...score });
          });
        }
      }

      // Sort by score descending
      scoredJobs.sort((a, b) => b.matchScore - a.matchScore);

      // Group by career direction
      const clusters = {};
      for (const job of scoredJobs) {
        const dir = job.careerDirection || 'Other';
        if (!clusters[dir]) clusters[dir] = [];
        clusters[dir].push(job);
      }

      console.log(`[Jobs] Scored ${scoredJobs.length} jobs across ${Object.keys(clusters).length} career directions`);
      return { success: true, scoredJobs, clusters };
    } catch (error) {
      console.error('[Jobs] Scoring failed:', error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });

  // ── Generate Cover Letter ─────────────────────────────────────────────────
  ipcMain.handle('generate-cover-letter', async (_event, { profile, job }) => {
    try {
      const result = await callGeminiText(`
Write a compelling cover letter for this candidate applying to this job.

CANDIDATE:
${JSON.stringify(profile, null, 2)}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.snippet || 'Not available'}

Return a JSON object:
{
  "coverLetter": "The full cover letter text, properly formatted with paragraphs. Professional but authentic tone. Highlight specific skills that match the job. Keep it concise — 3-4 paragraphs max."
}

Don't be generic. Reference specific skills from the resume that match specific requirements from the job.`);

      return { success: true, coverLetter: result.coverLetter };
    } catch (error) {
      console.error('[Jobs] Cover letter failed:', error?.message || String(error));
      return { success: false, error: error?.message || String(error) };
    }
  });
}
