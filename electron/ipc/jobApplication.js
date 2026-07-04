/**
 * Job-application generator IPCs.
 *
 * From a scored job card the user can generate a tailored résumé + cover letter
 * as print-ready PDFs, built on the editorial design system in
 * `resume_design_system/`. Flow (generate-application):
 *
 *   1. research-company  — the AI does LIVE web research on the company
 *      (grounded callLLMRaw). We never scrape the company ourselves; per the
 *      product decision the model uses real web search, not training knowledge.
 *   2. résumé            — the AI fills the design system's exact markup,
 *      returning a `<main class="page">` block tailored to the job + research.
 *   3. cover letter      — structured fields the renderer lays out on-brand.
 *   4. render            — both documents → PDF via headless Chromium.
 *
 * generate-application returns the temp PDF paths; save-application then writes
 * both files into an "Applied Jobs/<company>/<job>" folder next to the saved
 * canvas and opens that folder in Finder — no picker.
 */
import fs from 'fs';
import path from 'path';
import electronPkg from 'electron';
import { handleSafe } from './ipcUtils.js';
import { callLLMRaw, callLLMText } from './llm.js';
import { APPLICATION_COVER_LETTER_SCHEMA } from './aiSchemas.js';
import { renderApplicationPdfs, getDesignSystemDir } from './resumePdf.js';
import { logger } from '../logger.js';
import { wrapUntrustedText } from './promptSafety.js';

const { shell } = electronPkg;

// The résumé markup the model mirrors — the design system's own sample <main>
// block, read once and cached so it stays the single source of truth for the
// component shapes (classes, role/bullet/skill/edu structure).
let _resumeSampleMain = null;
function getResumeSampleMain() {
  if (_resumeSampleMain) return _resumeSampleMain;
  const htmlPath = path.join(getDesignSystemDir(), 'resume.html');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const m = /<main[\s\S]*<\/main>/i.exec(html);
  if (!m) throw new Error('Could not locate the <main> sample in resume_design_system/resume.html');
  _resumeSampleMain = m[0];
  return _resumeSampleMain;
}

function jobBlock(job = {}) {
  // Every field here — not just the description — is scraper-sourced: whoever
  // posted the listing controls the title/company/location/salary text too, so
  // a crafted "Title" or "Company" can carry an injection exactly like a
  // crafted description can. Wrap the whole block as one untrusted boundary
  // rather than fencing only the description and leaving the rest bare.
  const fields = [
    `Title: ${job.title || 'Unknown'}`,
    `Company: ${job.company || 'Unknown'}`,
    job.location ? `Location: ${job.location}` : null,
    job.salary ? `Salary: ${job.salary}` : null,
    `Description:\n${job.snippet || '(none captured)'}`,
  ].filter(Boolean).join('\n');
  return wrapUntrustedText('job-listing', fields);
}

/**
 * Live grounded web research — real search, not training memory; we never
 * re-scrape the posting ourselves.
 *
 * The model is agentic over its searches, so it decides how deep to go: it
 * ALWAYS researches the company, and judges from the scraped job description
 * whether to ALSO research the role — skipping redundant role searches when the
 * description already conveys the responsibilities/requirements, and filling the
 * gap from the web when it's thin or empty. (Content-aware, vs. a blind length
 * threshold; cost is bounded by the web_search max_uses ceiling.)
 */
async function researchCompanyAndRole(job, signal) {
  const company = (job.company || '').trim();
  const title = (job.title || 'the role').trim();
  if (!company) return 'No company name was available, so no company/role research could be performed.';

  logger.info(`[JobApplication] Researching ${company} / "${title}" (scraped JD ${String(job.snippet || '').trim().length} chars; model decides whether to also research the role)`);

  // title/company are scraper-sourced (whoever posted the listing wrote them),
  // same as the description — wrap them too rather than splicing them
  // straight into the instruction prose, where a crafted title like
  // `Engineer\n\nIGNORE PRIOR INSTRUCTIONS...` would read as part of the
  // prompt's own directives instead of as the listing's data.
  const prompt = `You are researching to help a candidate tailor an application to the target role below. You have live web search — use it.

TARGET ROLE (scraper-sourced — see the boundary notice below):
${wrapUntrustedText('job-title-company', `Title: ${title}\nCompany: ${company}`)}

ALWAYS research the COMPANY named above: what it does and its main products/services; mission, values, and culture signals; stage / size / funding or notable scale; recent news or developments in roughly the last 12 months.

Then decide about the ROLE by reading the scraped job description below:
- If it already conveys the role's responsibilities and requirements well, do NOT spend searches on the role — the description covers it.
- If it is thin, vague, or empty, ALSO research the role: the typical responsibilities and requirements for the target role at this company (or closely comparable companies if this exact posting isn't findable), the skills/tools/outcomes emphasized, and seniority expectations. Note when you're inferring from comparable roles vs. citing a posting you actually found.

Scraped job description (may be full, partial, or empty):
${wrapUntrustedText('job-description', job.snippet)}

Prefer concrete, recent, verifiable facts with rough dates. If you cannot find reliable information about the specific company or role, say so explicitly rather than inventing. Output plain prose only — no headers, no bullet markdown.`;

  return await callLLMRaw(prompt, { signal, task: 'company-research', grounding: true });
}

/** Fill the design system's résumé markup, tailored to the job + research. */
async function generateResumeMain({ careerData, job, research }, signal) {
  // Static, job-independent block → CACHED PREFIX. The candidate's careerData and
  // the design-system instructions/markup are byte-identical across every
  // application generated this session, so résumé call 2..N read this from cache
  // (~10% of input cost on Opus 4.8) instead of re-billing it. Only the per-job
  // job/research live in the dynamic prompt below. Keep these two byte-stable.
  const cachedPrefix = `You are an elite résumé writer using the "Editorial" design system. Produce ONE \`<main class="page">…</main>\` HTML block that fills the design system's EXACT markup, tailored to the TARGET JOB and company research provided at the end.

CAREER DATA (the candidate — every claim must be grounded in this; see TRUTHFULNESS & FRAMING below):
"""
${careerData}
"""

MARKUP TO MIRROR (copy these class names and structure exactly; replace only the content):
${getResumeSampleMain()}

TRUTHFULNESS & FRAMING (read carefully — this is the core constraint):
- Ground every claim in the CAREER DATA. NEVER invent employers, job titles, employment dates, degrees, certifications, or specific metrics/numbers the data doesn't support. A recruiter must be able to verify everything against the candidate's real history.
- You MAY make FAIR INFERENCES: surface a skill or capability a reasonable recruiter would confidently read from demonstrated experience (e.g. shipped production REST APIs → comfortable with HTTP/JSON and API design; led a 5-person team → people management; heavy PostgreSQL use → SQL generally). The inference must be a defensible read of real work — not a brand-new tool, credential, employer, or number the data can't back up.
- FRAME to connect the dots: actively phrase and order the candidate's genuine experience in the TARGET JOB's language so a busy recruiter instantly sees the match. Translate real accomplishments into the JD's terminology wherever the underlying work truly maps. Lead each role/bullet with what's most relevant to this job.
- You MAY include skills/tools the candidate genuinely has (or that fairly derive from their work) even when the JD doesn't list them — but only when it's EASY TO SEE how they benefit THIS job (a recruiter would immediately recognize the relevance). Don't pad with items that are merely field-adjacent or whose usefulness here isn't obvious.

RULES:
- Output ONLY the \`<main class="page" …>…</main>\` block. No <html>, <head>, <style>, no markdown fences, no commentary before or after.
- Use the exact classes shown: .resume-header/.name/.tagline/.contact (with \`.sep\` separators), .section/.section-head (h2 + .rule), article.role with .role-header.meta-row (.role-title-line + .role-dates) and .role-meta.meta-row (.role-summary + .role-location), ul.highlights > li, the .projects/.project block, dl.skills (dt + dd), and .edu-line.
- Pull the candidate's name, contact line, titles, employers, dates, and bullets from the CAREER DATA.
- Wrap scale numbers / metrics in <strong>. Senior annotations are OPTIONAL and only if the data supports them: \`<span class="scope"><span class="annotation-label"> — </span>…</span>\` and \`<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>…</span>\`.
- 3-6 bullets per role, each with a concrete outcome or number drawn from the career data. Reorder and emphasize to match the job + research (per the FRAMING rules above).
- Section order: Experience, then OPTIONAL "Selected Systems"/projects, Skills, Education. Drop any section the career data can't support (e.g. omit "Selected Systems" for non-engineering candidates).
- No icons, photos, skill bars, progress dots, summary/objective paragraph, or emoji.
- VARIANT — set as attributes on the <main> tag:
  • Design-conscious / startup / craft-oriented company → \`data-print="dual-pdf"\` (the design system default — warm cream on screen, background automatically removed when printed).
  • Big-company ATS / enterprise / regulated / finance back-office → \`data-print="ink-only"\` (flat white; also add \`data-mono\` for very conservative fields: defense, big-law, traditional banking IT).
  • Non-US recipient → also add \`data-page="a4"\`.`;

  const prompt = `TARGET JOB (the "Description" is what we scraped — it may be full, partial, or empty):
${jobBlock(job)}

COMPANY & ROLE CONTEXT (live web research — always covers the company, and the role too when the scraped Description was thin). Combine it with the scraped Description above for the full picture, and tailor emphasis, ordering, and keywords to it:
"""
${research}
"""

Now produce the single \`<main class="page">…</main>\` block for THIS job, grounded in the CAREER DATA and following the markup + rules above.`;
  return await callLLMRaw(prompt, { signal, task: 'application-resume', cachedPrefix });
}

/** Structured cover letter the renderer lays out on the design-system letterhead. */
async function generateCoverLetterFields({ careerData, job, research }, signal) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  // Static, job-independent block → CACHED PREFIX (careerData + writing rules are
  // byte-identical across every application this session; only the job, research,
  // and date vary). Keep byte-stable so cover-letter call 2..N hit the cache.
  const cachedPrefix = `Write a tailored cover letter for a candidate applying to a job. Return JSON matching the provided schema, grounded in the CAREER DATA below and the target job + research provided at the end.

CAREER DATA (use ONLY facts found here for the candidate's name, contact, and evidence):
"""
${careerData}
"""

WRITING RULES:
- 3-4 body paragraphs. Each ties SPECIFIC career-data evidence to SPECIFIC job requirements, and references a genuine detail from the research (a product, a value, or a recent development).
- Authentic, specific, and concise — not a generic template. Ground every claim in the career data: never invent employers, titles, dates, or numbers. You MAY make fair inferences from demonstrated experience (a capability a recruiter would confidently read from real work, not a new credential) and frame the candidate's genuine accomplishments in the job's language to connect the dots for the reader.
- Pull "name", "tagline", and "contact" (location, email, phone, one URL) from the career data; omit any contact item not present.`;

  const prompt = `TARGET JOB (the "Description" is what we scraped — it may be full, partial, or empty):
${jobBlock(job)}

COMPANY & ROLE CONTEXT (live web research — always covers the company, and the role too when the scraped Description was thin). Combine it with the scraped Description above for the full picture:
"""
${research}
"""

FILL THESE FIELDS for THIS job (per the CAREER DATA and writing rules above):
- "date" = "${today}". "recipient" = the addressee block, one item per line separated by a literal \\n: first line the addressee, then the company, e.g. "Hiring Team\\n${job.company || 'the company'}" (optionally add a third line for the team/department if the research makes it clear). "salutation" like "Dear ${job.company || 'Hiring'} Team,". "closing" like "Sincerely,". "signatureTitle" = the TARGET role being applied to + " · candidate", i.e. "${job.title || 'the role'} · candidate".`;
  const result = await callLLMText(prompt, { signal, task: 'application-cover-letter', responseSchema: APPLICATION_COVER_LETTER_SCHEMA, cachedPrefix });
  return result;
}

function sanitizeFilePart(s, fallback) {
  const cleaned = String(s || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

/** Copy `src` to `dir/desired`, avoiding collision by appending " (n)". */
async function copyUnique(src, dir, desired) {
  const ext = path.extname(desired);
  const base = desired.slice(0, desired.length - ext.length);
  let target = path.join(dir, desired);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base} (${n})${ext}`);
    n += 1;
  }
  await fs.promises.copyFile(src, target);
  return target;
}

// Last application generation — captured so the bug reporter can SEE the model's
// actual résumé markup + cover-letter fields. That's the ONE place an application
// rendering bug shows (a stray mid-sentence newline, a literal "\n"/"\t", broken
// structure) — without it those are undebuggable from a report. In-memory,
// last-one-wins, never persisted (the PDFs already are).
let lastApplication = null;
export function getApplicationTelemetry() {
  return lastApplication;
}
function recordApplicationTelemetry(data) {
  lastApplication = { ts: Date.now(), ...data };
}

export function registerJobApplicationHandlers() {
  // Generate the tailored résumé + cover letter PDFs. Returns temp paths;
  // save-application copies them to a user-chosen folder.
  handleSafe('generate-application', async (event, { job, careerData, nodeId }, signal) => {
    const company = job?.company || 'this company';
    logger.info(`[JobApplication][${nodeId || '?'}] Generating application for ${job?.title} @ ${company}`);

    // Career data is required — fail loudly rather than producing an empty or
    // fabricated résumé.
    if (!careerData || !String(careerData).trim()) {
      throw new Error('No career data available for this hub. Drop your career files onto the job hub first.');
    }

    // 1. Live company + role research (grounded) — the PRIMARY job-context
    //    source; the scraped posting is supplementary. Surfaced as a clear error
    //    if the provider/tier can't do web search — we do NOT silently fall back
    //    to training-knowledge guesses.
    let research;
    try {
      research = await researchCompanyAndRole(job, signal);
    } catch (e) {
      throw new Error(`Company/role research (web search) failed: ${e?.message || e}. The résumé/cover letter need live research — check that the AI provider supports web search.`);
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // 2. Résumé HTML (design-system markup) + 3. structured cover letter.
    const resumeMainHtml = await generateResumeMain({ careerData, job, research }, signal);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const coverLetter = await generateCoverLetterFields({ careerData, job, research }, signal);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // Capture the raw model output BEFORE rendering, so a render/PDF failure still
    // leaves the LLM fields visible in a bug report (the prose is where newline /
    // escape bugs live). Stored verbatim — the reporter stringifies for inspection.
    recordApplicationTelemetry({
      nodeId: nodeId || null,
      jobTitle: job?.title || '',
      company: job?.company || '',
      coverLetter: {
        salutation:     coverLetter?.salutation || '',
        recipient:      coverLetter?.recipient || '',
        paragraphs:     Array.isArray(coverLetter?.paragraphs) ? coverLetter.paragraphs : [],
        closing:        coverLetter?.closing || '',
        signatureTitle: coverLetter?.signatureTitle || '',
        contact:        Array.isArray(coverLetter?.contact) ? coverLetter.contact : [],
      },
      resumeHtmlSample: String(resumeMainHtml || '').slice(0, 1500),
      resumeHtmlLen:    String(resumeMainHtml || '').length,
    });

    // 4. Render both to PDF.
    const { resumePdfPath, coverPdfPath, workDir } = await renderApplicationPdfs({
      resumeMainHtml,
      coverLetter,
      signal,
    });

    const candidateName = coverLetter?.name || '';
    logger.info(`[JobApplication][${nodeId || '?'}] Rendered application PDFs for ${company}`);
    return { resumePdfPath, coverPdfPath, workDir, company: job?.company || '', candidateName };
  });

  // Write both generated PDFs into "Applied Jobs/<company>/<job>" next to the
  // SAVED canvas file, then open that folder in Finder. No picker — the location
  // is deterministic so the user's applications stay organized with the project.
  // Cleans up the temp working directory afterward.
  handleSafe('save-application', async (event, { resumePdfPath, coverPdfPath, workDir, company, candidateName, jobTitle, canvasFilePath }) => {
    if (!resumePdfPath || !coverPdfPath) throw new Error('Missing generated PDF paths.');
    if (!fs.existsSync(resumePdfPath) || !fs.existsSync(coverPdfPath)) {
      throw new Error('Generated PDFs are no longer available — please regenerate.');
    }
    // The destination is relative to the canvas JSON, so it must be saved first.
    if (!canvasFilePath || typeof canvasFilePath !== 'string') {
      throw new Error('Save your canvas to a file first — applications are written to an "Applied Jobs" folder next to your saved canvas.');
    }

    const where = sanitizeFilePart(company, 'Company');
    const role = sanitizeFilePart(jobTitle, 'Role');
    const dir = path.join(path.dirname(canvasFilePath), 'Applied Jobs', where, role);
    await fs.promises.mkdir(dir, { recursive: true });

    // Folder already encodes company + role, so the files only carry the
    // candidate's name (useful once a recruiter detaches them from the folder).
    const who = sanitizeFilePart(candidateName, 'Application');
    const resumeFile = await copyUnique(resumePdfPath, dir, `${who} - Resume.pdf`);
    const coverFile  = await copyUnique(coverPdfPath, dir, `${who} - Cover Letter.pdf`);

    // Clean up the temp output dir now that the files are safely copied out.
    if (workDir) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    // Open the destination folder in a Finder/Explorer window.
    const openErr = await shell.openPath(dir);
    if (openErr) logger.warn(`[JobApplication] Could not open ${dir}: ${openErr}`);

    logger.info(`[JobApplication] Saved application to ${dir}`);
    return { saved: true, dir, resumeFile, coverFile };
  });
}
