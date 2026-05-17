/**
 * Jobs IPC handlers — resume parsing, multi-source job search, AI scoring.
 * 12 Sources: Google, Indeed, LinkedIn, RemoteOK, WeWorkRemotely,
 *             ZipRecruiter, Glassdoor, Dice, Wellfound,
 *             Greenhouse API, Lever API, USAJobs API
 */
import { callLLMDocument, callLLMText } from './llm.js';
import { handleSafe } from './ipcUtils.js';
import { scrapeMultiple } from './browserPool.js';
import { logger } from '../logger.js';
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
import { loadJobsHistory, appendJobsHistory, dedupAgainstHistory } from './jobsHistory.js';
import { filterJobsByAge } from './jobDateFilter.js';

const DEFAULT_MAX_AGE_DAYS = 14;

// All source IDs — defines the complete set for progress tracking and reporting.
const ALL_SOURCE_IDS = [
  'google', 'indeed', 'linkedin', 'remoteok', 'weworkremotely',
  'ziprecruiter', 'glassdoor', 'dice', 'wellfound',
  'greenhouse', 'lever', 'usajobs',
];

// Sources that moved from browser pool to direct API (per deep research report):
// - remoteok: Open JSON API at remoteok.com/api (zero WAF)
// - weworkremotely: RSS feed at weworkremotely.com/remote-jobs.rss (zero WAF)

// Google Jobs chip parameter: closest discrete bucket ≥ requested age.
// Sources that take a raw day count get the number unmodified.
function googleDateChip(days) {
  if (days <= 1) return 'today';
  if (days <= 3) return '3days';
  if (days <= 7) return 'week';
  return 'month';
}

// ── Source → URL + Extractor + Config mapping (DOM scrape sources only) ──────
// LinkedIn has been moved to the API pool (fetchLinkedInJobs) — no Puppeteer needed.
function buildJobTasks(queries, maxAgeDays) {
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
  const gChip = googleDateChip(days);
  // Browser pool extractors — only platforms that REQUIRE Puppeteer rendering.
  // RemoteOK and WeWorkRemotely have been moved to fetchApiSources (direct HTTP).
  const extractors = {
    google:          { extractor: GOOGLE_JOBS_EXTRACTOR,      config: GOOGLE_JOBS_CONFIG,      urlFn: q => `https://www.google.com/search?q=${encodeURIComponent(q)}&ibp=htl;jobs&htichips=date_posted:${gChip}` },
    indeed:          { extractor: INDEED_JOBS_EXTRACTOR,      config: INDEED_CONFIG,           urlFn: q => `https://www.indeed.com/jobs?q=${encodeURIComponent(q)}&fromage=${days}` },
    ziprecruiter:    { extractor: ZIPRECRUITER_EXTRACTOR,     config: ZIPRECRUITER_CONFIG,     urlFn: q => `https://www.ziprecruiter.com/jobs-search?search=${encodeURIComponent(q)}&days=${days}` },
    glassdoor:       { extractor: GLASSDOOR_EXTRACTOR,        config: GLASSDOOR_CONFIG,        urlFn: q => `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encodeURIComponent(q)}&fromAge=${days}` },
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
async function fetchApiSources(queries, sender, signal = null, nodeId = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const firstQuery = queries[0] || '';
  const apiKey = process.env.USAJOBS_API_KEY || '';
  const email = process.env.USAJOBS_EMAIL || '';
  const days = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));

  const apiTasks = [
    { sourceId: 'linkedin',       fn: (s) => fetchLinkedInJobs(firstQuery, s, days) },
    { sourceId: 'greenhouse',     fn: (s) => fetchGreenhouseJobs(firstQuery, s) },
    { sourceId: 'lever',          fn: (s) => fetchLeverJobs(firstQuery, s) },
    { sourceId: 'usajobs',        fn: (s) => fetchUSAJobs(firstQuery, apiKey, email, s, days) },
    { sourceId: 'remoteok',       fn: (s) => fetchRemoteOKJobs(firstQuery, s) },
    { sourceId: 'weworkremotely', fn: (s) => fetchWeWorkRemotelyJobs(firstQuery, s) },
    { sourceId: 'dice',           fn: (s) => fetchDiceListings(firstQuery, '', s) },
  ];

  // Notify frontend that API sources are starting
  for (const { sourceId } of apiTasks) {
    if (!sender.isDestroyed()) {
      sender.send('job-source-progress', { nodeId, sourceId, status: 'searching', count: 0 });
    }
  }

  return Promise.all(apiTasks.map(async ({ sourceId, fn }) => {
    try {
      if (signal?.aborted) throw new Error('Aborted');
      const jobs = await fn(signal);
      return { sourceId, jobs };
    } catch (error) {
      return { sourceId, jobs: [], error: error?.message || String(error) };
    }
  }));
}

/**
 * Register all Jobs IPC handlers.
 */
export function registerJobsHandlers() {
  handleSafe('parse-resume', async (event, { filePath, nodeId }, signal) => {
    logger.info(`[Jobs][${nodeId}] Parsing resume:`, filePath);
    const profile = await callLLMDocument(filePath, `
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
Extract everything you can find. Be thorough.`, signal);

    logger.info(`[Jobs][${nodeId}] Resume parsed:`, profile.titles?.join(', '));
    return { profile };
  });

  handleSafe('generate-job-queries', async (event, { profile }, signal) => {
    const result = await callLLMText(`
You are a career strategist. Given this professional profile, generate search queries for a job search.

Profile:
${JSON.stringify(profile, null, 2)}

Return a JSON object with three arrays of search query strings:

{
  "titleQueries": ["2-3 queries using their exact job titles + location, e.g. 'senior backend engineer denver'"],
  "suggestedRoleQueries": ["3-5 queries for roles they could transition into — adjacent, stretch, and pivot roles they may not have considered. Think creatively: a backend engineer could be an engineering manager, developer advocate, solutions architect, technical PM, etc. Include the location."],
  "skillsOnlyQueries": ["2-3 queries using ONLY their skills and experience level, NO job title at all, e.g. 'python kubernetes 8 years team lead distributed systems'. This is intentionally broad to surface unexpected matches."]
}

Be creative with suggestedRoleQueries — think about what career directions their skills unlock that they might not have considered.`, signal);
      
    return { queries: result };
  });

  // ── Search Jobs (Multi-Source Phase 2) ────────────────────────────────────
  handleSafe('search-jobs', async (event, { queries, nodeId, maxAgeDays, canvasFilePath }, signal) => {
    const ageDays = Math.max(1, Math.floor(maxAgeDays || DEFAULT_MAX_AGE_DAYS));
    logger.info(`[Jobs][${nodeId}] Searching with`, queries.length, `queries across 12 sources (maxAge=${ageDays}d)`);

    const tasks = buildJobTasks(queries, ageDays);
    
    // Group tasks by source for per-source progress tracking
    const sourceTaskIds = {};
    for (const t of tasks) {
      if (!sourceTaskIds[t.sourceId]) sourceTaskIds[t.sourceId] = [];
      sourceTaskIds[t.sourceId].push(t.id);
    }

    // Notify frontend that sources are starting
    for (const sourceId of Object.keys(sourceTaskIds)) {
      if (!event.sender.isDestroyed()) {
        event.sender.send('job-source-progress', { nodeId, sourceId, status: 'searching', count: 0 });
      }
    }

    const allJobs = [];
    const sourceResults = {};
    
    // 1. Run Scraper Tasks and API Tasks concurrently
    const [results, apiResults] = await Promise.all([
      scrapeMultiple(tasks, (res) => {
        if (event.sender.isDestroyed()) return;
        const sourceId = res.id.replace(/-\d+$/, '');
        const count = Array.isArray(res.data) ? res.data.length : 0;
        event.sender.send('job-source-progress', {
          nodeId,
          sourceId,
          status: res.success ? 'done' : 'error',
          count
        });
      }, signal),
      fetchApiSources(queries, event.sender, signal, nodeId, ageDays)
    ]);

    // Process Scraper Results
    for (const result of results) {
      const sourceId = result.id.replace(/-\d+$/, '');
      if (!sourceResults[sourceId]) sourceResults[sourceId] = { jobs: [], errors: 0 };

      if (result.success && Array.isArray(result.data)) {
        const tagged = result.data.map(j => ({ ...j, source: sourceId }));
        sourceResults[sourceId].jobs.push(...tagged);
        allJobs.push(...tagged);
      } else {
        sourceResults[sourceId].errors++;
        logger.warn(`[Jobs] Source ${result.id} failed:`, result.error);
      }
    }

    // Process API Results
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
          nodeId,
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

    // Drop entries whose `posted` string parses to older than maxAgeDays.
    // Sources without a URL date param rely entirely on this pass; those
    // with a URL param re-apply it as a safety net.
    const ageFiltered = filterJobsByAge(deduped, ageDays);
    const ageDropped = deduped.length - ageFiltered.length;

    // Drop anything we've already shown the user on a previous run.
    let kept = ageFiltered;
    let historyDropped = 0;
    if (canvasFilePath) {
      const history = await loadJobsHistory(canvasFilePath);
      const result = dedupAgainstHistory(ageFiltered, history);
      kept = result.kept;
      historyDropped = result.removed;
    }

    logger.info(
      `[Jobs] ${kept.length} new jobs (raw=${allJobs.length}, dedup=${deduped.length}, ageDropped=${ageDropped}, historyDropped=${historyDropped})`
    );
    return { jobs: kept, sourceResults };
  });

  // ── Jobs history (60-day rolling CSV next to the canvas JSON) ─────────────
  handleSafe('append-jobs-history', async (_event, { canvasFilePath, jobs }) => {
    return appendJobsHistory(canvasFilePath, jobs);
  });

  handleSafe('load-jobs-history', async (_event, { canvasFilePath }) => {
    const rows = await loadJobsHistory(canvasFilePath);
    return { rows };
  });

  // ── Score Jobs Against Resume ─────────────────────────────────────────────
  handleSafe('score-jobs', async (event, { jobs, profile, nodeId }, signal) => {
    logger.info(`[Jobs][${nodeId}] Scoring`, jobs.length, 'jobs');

    // Batch into groups of 15
    const BATCH_SIZE = 15;
    const scoredJobs = [];

    for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
      // Guard: Check if window was closed between batches
      if (signal.aborted) break;

      const batch = jobs.slice(i, i + BATCH_SIZE);
      let batchResult;
      
      try {
        batchResult = await callLLMText(`
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
- Aim for 3-7 distinct careerDirection categories total. Merge small categories.`, signal);
      } catch (err) {
        if (signal.aborted) throw err;
        logger.warn(`[Jobs] Batch scoring failed:`, err);
        batchResult = null; // Forces string fallback below
      }

      if (Array.isArray(batchResult)) {
        batch.forEach((job, idx) => {
          const score = batchResult.find(s => s.index === idx) || { matchScore: 50, reasoning: 'Unable to score', careerDirection: 'Other', strengthLabel: 'exploring' };
          scoredJobs.push({ ...job, ...score });
        });
      } else {
        logger.warn(`[Jobs] batchResult was not an array:`, batchResult);
        batch.forEach((job) => {
          scoredJobs.push({ ...job, matchScore: 50, reasoning: 'AI format error', careerDirection: 'Other', strengthLabel: 'exploring' });
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

    logger.info(`[Jobs] Scored ${scoredJobs.length} jobs across ${Object.keys(clusters).length} career directions`);
    
    return { scoredJobs, clusters };
  });

  // ── Generate Cover Letter ─────────────────────────────────────────────────
  handleSafe('generate-cover-letter', async (event, { profile, job }, signal) => {
    const result = await callLLMText(`
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

Don't be generic. Reference specific skills from the resume that match specific requirements from the job.`, signal);

    return { coverLetter: result.coverLetter };
  });

  // ── Generate Interview Prep ───────────────────────────────────────────────
  handleSafe('generate-interview-prep', async (event, { profile, job }, signal) => {
    logger.info(`[Jobs] Generating interview prep for ${job.title} at ${job.company}`);
    const result = await callLLMText(`
You are an expert career coach preparing a candidate for a job interview.

CANDIDATE PROFILE:
${JSON.stringify(profile, null, 2)}

JOB:
Title: ${job.title}
Company: ${job.company}
Description: ${job.snippet || 'Not available'}

Generate a focused interview prep guide. Return a JSON object:
{
  "questions": [
    {
      "type": "behavioral" | "technical" | "company",
      "question": "The interview question they are likely to be asked",
      "tip": "1-2 sentence coaching tip: what to emphasize from their specific background, which skills to highlight, or what angle to take. Be specific to THIS candidate's profile."
    }
  ]
}

Rules:
- 3 behavioral questions (STAR-format questions about past experience)
- 3 technical/skills questions specific to the role's requirements
- 2 company-specific questions (about the company's mission, product, or growth stage)
- Tips must reference the candidate's ACTUAL skills and experience, not generic advice
- Total: exactly 8 questions`, signal);

    return { questions: result.questions || [] };
  });
}
