/**
 * Job-application generator IPCs.
 *
 * From a scored job card the user can generate a tailored résumé + cover letter
 * as self-contained HTML documents, built on the editorial design system in
 * `resume_design_system/`. Flow (generate-application):
 *
 *   0. achievement ledger — a job-independent mining pass (Opus) + deterministic
 *      checks + an independent refute pass (Sonnet), run lazily on the origin
 *      hub's FIRST Generate and cached there (docs/resume-achievement-mining-
 *      design.md §3). Reused on every later application from that hub instead
 *      of being re-derived. Never blocks generation — a failed mine/refute
 *      falls back to today's behaviour (careerData alone).
 *   1. research-company  — the AI does LIVE web research on the company
 *      (grounded callLLMRaw). We never scrape the company ourselves; per the
 *      product decision the model uses real web search, not training knowledge.
 *   2. résumé            — the AI fills the design system's exact markup,
 *      returning a `<main class="page">` block tailored to the job + research,
 *      using the ledger (when available) as a floor of pre-derived, code-
 *      verified accomplishments.
 *   3. cover letter       — structured fields the renderer lays out on-brand.
 *   4. document build     — buildResumeDocument (resumeHtml.js) turns the
 *      résumé and structured cover letter into one self-contained workspace.
 *      HTML-first output (design §5) — the HTML is still the primary,
 *      editable artifact.
 *   5. render → fit loop  — a LOCAL render → page-count → fit loop
 *      (resumeRender.js, Electron's own `webContents.printToPDF` — no
 *      puppeteer, no headless Chromium download) implements SKILL.md §5's
 *      "compact-density algorithm": render, and if the page count is over
 *      target, retry with `data-density="compact"` (free, deterministic); if
 *      STILL over, make one targeted LLM revision call to cut content and
 *      render once more. Produces a PDF companion next to the HTML. This step
 *      can never block generation — any render failure degrades to
 *      HTML-only, logged, never thrown (see renderResumeWithFit below).
 *
 * generate-application returns the temp combined workspace as resumeHtmlPath,
 * plus resumePdfPath (the safe baseline PDF companion — null
 * when rendering failed for any reason). save-application then writes those
 * bundle into an
 * "Applied Jobs/<company>/<location>/<job>" folder next to the saved canvas
 * and opens that folder in Finder — no picker.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import electronPkg from 'electron';
import { handleSafe } from './ipcUtils.js';
import { callLLMRaw, callLLMText, modelForTask, providerForTask } from './llm.js';
import {
  APPLICATION_COVER_LETTER_SCHEMA,
  APPLICATION_SKILL_OPPORTUNITY_SCHEMA,
  ACHIEVEMENT_LEDGER_SCHEMA,
  ACHIEVEMENT_REFUTE_SCHEMA,
} from './aiSchemas.js';
import { buildResumeDocument, buildCoverLetterDocument, embedApplicationSyncConfig, extractVariantAttrs, isDualMode, getDesignSystemDir } from './resumeHtml.js';
import { renderPdf, applyDualPdf } from './resumeRender.js';
import { primeClaudeModels } from './modelResolver.js';
import {
  LEDGER_VERSION, MINING_TARGET, computeLedger, applyRefuteVerdicts, serializeLedgerForPrompt,
} from '../../src/utils/achievementLedger.js';
import { logger } from '../logger.js';
import { wrapUntrustedText } from './promptSafety.js';
import { createFifoLock } from './asyncMutex.js';
import {
  loadSkillOpportunityHistogram,
  recordSkillOpportunityAnalysis,
} from './skillOpportunityStore.js';
import { mergeSkillOpportunityAnalysis } from '../../src/utils/skillOpportunityHistogram.js';
import { formatOriginalJobListingMarkdown, sanitizeApplicationBundlePart } from './applicationBundle.js';
import { registerApplicationSyncWorkspace } from './applicationSync.js';

const { shell } = electronPkg;

// A renderer must not be able to substitute arbitrary filesystem paths into
// save-application. Generation registers the exact temp artifacts here; save
// consumes only that record and removes it after a durable bundle/recovery save.
const pendingApplicationArtifacts = new Map();

// Resolve a generated workspace only when the caller names an exact record
// owned by its sender. Exported to keep the capability boundary directly
// testable without exposing the production Map itself.
export function resolvePendingApplicationWorkspaceForOwner(workDir, pendingArtifacts, senderId) {
  const resolvedWorkDir = typeof workDir === 'string' ? path.resolve(workDir) : '';
  const pending = pendingArtifacts.get(resolvedWorkDir);
  if (!pending) {
    throw new Error('Generated application session is no longer available — please regenerate.');
  }
  if (pending.senderId !== senderId) {
    throw new Error('Generated application session belongs to a different window — please regenerate.');
  }
  return { resolvedWorkDir, pending };
}

// Remove only a workspace that this process previously registered.  The
// renderer never gets arbitrary temp-directory deletion: callers must first
// prove ownership with the exact Map entry (and, at the IPC boundary, sender
// identity) before this helper is reached.
async function discardPendingApplicationArtifacts(resolvedWorkDir, pending, reason = 'discarded') {
  if (pendingApplicationArtifacts.get(resolvedWorkDir) !== pending) return false;
  pendingApplicationArtifacts.delete(resolvedWorkDir);
  try {
    await fs.promises.rm(resolvedWorkDir, { recursive: true, force: true });
  } catch (error) {
    logger.warn(`[JobApplication] Could not clean temporary application workspace after ${reason}: ${error?.message || error}`);
  }
  return true;
}

// Serialize histogram-backed taxonomy reads/AI canonicalization and the later
// completed-artifact record operations. The two phases are deliberately
// separate: demand is not persisted until the application files exist, while
// each individual read/analyse or merge/write remains race-free.
const { withLock: withSkillOpportunityLock } = createFifoLock({
  name: 'skillOpportunityAnalysis',
  supportsAbort: true,
});

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

// The editorial rubric — SKILL.md + readme.md, injected WHOLE into the résumé
// and cover-letter cached prefixes (design §4.1). Unlike getResumeSampleMain
// above, a missing rubric does NOT fail generation: the rubric only makes the
// output better-edited, it isn't structural (§4.1's stated asymmetry — fail
// loud on what breaks the artifact, degrade quietly on what only improves it).
// Read once and cached (empty string on failure) so repeated calls within a
// session neither re-hit disk nor destabilize the cached-prefix byte content.
let _editorialRubric = null;
function getEditorialRubric() {
  if (_editorialRubric !== null) return _editorialRubric;
  try {
    const dir = getDesignSystemDir();
    const skill = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
    const readme = fs.readFileSync(path.join(dir, 'readme.md'), 'utf8');
    _editorialRubric = `${skill}\n\n---\n\n${readme}`;
  } catch (e) {
    logger.warn(`[JobApplication] Editorial rubric (SKILL.md/readme.md) not found — generating without it: ${e?.message || e}`);
    _editorialRubric = '';
  }
  return _editorialRubric;
}

// ---------------------------------------------------------------------------
// Render → page-count → fit loop (SKILL.md §5's "compact-density algorithm").
// The two functions below are PURE (no I/O, no LLM, no Electron) so they're
// directly unit-testable under plain Node (scripts/test-runner.js) without
// standing up a BrowserWindow — the orchestration that calls renderPdf/
// callLLMRaw around them lives in renderResumeWithFit, further down.
// ---------------------------------------------------------------------------

// "Staff+" (with the literal plus) — NOT bare "Staff" — is the 2-page trigger.
// SKILL.md is explicit that target page count is "1 for IC roles up to staff
// and 2 for principal+": a plain "Staff Engineer" title is still a 1-page
// résumé under that rule. "Staff+" is the industry-ladder shorthand some
// postings use for "staff and above" (Staff, Senior Staff, Principal,
// Distinguished, collectively) — matching it but not bare "staff" is
// deliberate, not an oversight; a naive `/staff/i` here would 2-page every
// staff-level IC posting SKILL.md's own guidance says should stay 1 page.
// "staff\+" is deliberately its OWN alternative outside the \b(...)\b group
// (not folded in alongside "principal" etc.) — "+" is not a word character,
// so a trailing \b right after it never matches (there's no \w↔\W transition
// at that position when "+" is followed by a space or end-of-string, which is
// how a title actually ends: "...Staff+"). A leading \b is enough since '+'
// itself unambiguously terminates the token.
// "Chief of Staff" is an administrative/advisory title, not an IC level at
// principal+; treating every "chief" as an executive misclassifies it and
// gives it an unnecessarily long default target. Senior Staff is above Staff,
// so it belongs with principal+ even when a posting does not use "Staff+".
const SENIOR_TITLE_RE = /\b(?:principal|director|vice president|vp|head of)\b|\bchief\b(?![\s-]+of[\s-]+staff\b)|\b(?:senior|sr\.?)\s+staff\b|\bstaff\+/i;

/**
 * Target page count for a job title (SKILL.md §5: "conventionally 1 for IC
 * roles up to staff and 2 for principal+"). Callers may override this
 * heuristic entirely (generate-application accepts an optional
 * `targetPageCount` argument, below) — this is only the default when no
 * override is supplied.
 */
export function targetPageCountForJob(jobTitle) {
  return SENIOR_TITLE_RE.test(String(jobTitle || '')) ? 2 : 1;
}

/**
 * One step of SKILL.md §5's page-count algorithm, as a pure state → action
 * decision — no rendering, no LLM call, just "given what's already been
 * tried, what should happen next."
 *
 * SKILL.md gates compact density on overflow SIZE ("~1-9 lines, or the final
 * page <30% full"). `pdf-lib` gives a page count, not final-page occupancy,
 * so a one-page overrun remains genuinely ambiguous: it can be one line or an
 * almost-full second page. We use compact first in that ambiguous case because
 * it is deterministic and free. More than one whole page beyond target is
 * unambiguously large from the count alone, so it skips straight to the one
 * content revision instead of wasting a compact render that cannot close it.
 *
 * @param {object} args
 * @param {number} args.pageCount     the just-rendered page count
 * @param {number} args.target        target page count (targetPageCountForJob or an override)
 * @param {boolean} args.compactTried    whether data-density="compact" has already been applied+rendered
 * @param {boolean} args.revisionTried   whether the one LLM length-revision call has already run
 * @param {boolean} [args.fontsLoaded=true] whether the render window actually loaded the design
 *   system's web fonts (renderPdf reports this)
 * @returns {{action: 'ship'|'compact'|'revise', reason: string}}
 */
export function decideFitStep({ pageCount, target, compactTried, revisionTried, fontsLoaded = true }) {
  // A page count measured with fallback typefaces describes a document nobody
  // will ever see: the design system's fonts come from the Google Fonts CDN, so
  // offline (or with the CDN blocked) the render window lays the résumé out in
  // system serif/sans at different metrics. Acting on that number could compact
  // a résumé that already fits, or — far worse — spend an LLM revision call
  // CUTTING REAL CONTENT to solve an overflow that doesn't exist. Ship what the
  // model wrote and leave the layout alone.
  if (!fontsLoaded) {
    return { action: 'ship', reason: `web fonts unavailable in the render window — page count ${pageCount} reflects fallback typefaces, not the real document, so no fit action is taken` };
  }
  if (!(pageCount > target)) {
    return { action: 'ship', reason: `page count ${pageCount} already fits target ${target}` };
  }
  // `target + 2` pages means at least one *complete* page beyond the target,
  // regardless of how full the final page is. That is the one large-overflow
  // verdict a page count can make honestly without PDF layout geometry.
  if (pageCount > target + 1 && !revisionTried) {
    return { action: 'revise', reason: `${pageCount} pages exceeds target ${target} by more than one full page — skipping compact density and revising content` };
  }
  if (!compactTried) {
    return { action: 'compact', reason: `${pageCount} pages exceeds target ${target} — trying data-density="compact" first (free, deterministic, no LLM call)` };
  }
  if (!revisionTried) {
    return { action: 'revise', reason: `still ${pageCount} pages after compact density (target ${target}) — the content itself is too long; one targeted LLM revision call` };
  }
  // Both levers exhausted. Never loop indefinitely (§4) — ship the best
  // result produced rather than making a second revision call or retrying
  // forever; a résumé slightly over the conventional target still beats no
  // résumé at all.
  return { action: 'ship', reason: `exhausted both fit levers (compact density + one revision) at ${pageCount} pages vs target ${target} — shipping best effort` };
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

/**
 * Research improves tailoring but is not required for a truthful application:
 * the scraped job description remains a valid source. A provider quota or web
 * search capability failure therefore degrades to an explicit no-research
 * context instead of cancelling the whole generation.
 */
export async function getCompanyResearchContext(job, signal, researchFn = researchCompanyAndRole) {
  try {
    return { text: await researchFn(job, signal), available: true, error: null };
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const message = String(error?.message || error).replace(/\s+/g, ' ').trim().slice(0, 300);
    return {
      text: 'Live company and role research was unavailable for this application. Do not invent or imply company facts, values, products, news, or role requirements that are not present in the scraped target job description.',
      available: false,
      error: message || 'Unknown research failure',
    };
  }
}

/**
 * Build the persistent "what should I learn next?" signal for one application.
 * This is deliberately a separate call from résumé writing: asking the résumé
 * writer to both maximize fit and police unsupported adjacent skills makes the
 * truthfulness boundary compete with the writing objective. Here the model has
 * one job — identify only missing skills that materially change this job's
 * outcome, classify their distance from demonstrated work, and map aliases to
 * the app-global role/skill taxonomy. Deterministic code owns the counters.
 */
async function analyzeSkillOpportunities({ careerData, job, research, histogram }, signal) {
  const roles = Array.isArray(histogram?.roles) ? histogram.roles : [];
  const taxonomy = roles.map((role) => ({
    id: role.id,
    name: role.name,
    aliases: Array.isArray(role.aliases) ? role.aliases : [],
    skills: (Array.isArray(role.skills) ? role.skills : []).map((skill) => ({
      id: skill.id,
      name: skill.name,
      aliases: Array.isArray(skill.aliases) ? skill.aliases : [],
    })),
  }));

  const prompt = `You are the evidence-and-demand analyst in a truthful résumé system. Analyze ONE target job against the candidate's career data. Return JSON matching the schema.

Your output drives two things:
1. A review queue for a small, plausible but UNVERIFIED adjacent skill. It may enter the final résumé only after the user explicitly verifies it.
2. A private learning queue for a more distant skill that must NEVER enter the résumé yet.
Both kinds are counted in a persistent histogram so repeated demand across jobs reveals which skill is most worth learning for each role family.

SELECTION GATE — the most important rule:
- Emit a skill only if possessing it would SIGNIFICANTLY improve this candidate's odds for THIS job: it is explicitly required, repeated, central to core responsibilities, or a likely hard screen. A generic nice-to-have, fashionable adjacent tool, or minor keyword is not enough.
- Empty items is a correct and preferred result when no missing skill clears that bar. Do not manufacture a queue just to be helpful.
- Emit each semantic skill once. Count demand, not wording variants.

TRUTHFUL DISTANCE:
- First exclude skills already directly supported by the career data; those belong in the résumé normally and are not missing-skill demand.
- kind="verify": a very small inference from concrete demonstrated work that could plausibly already be true, but the data does not establish it. Example: substantial Django database-backed CRUD/models work can make Django ORM plausible; the word "Django" alone does not. Supply the exact evidence and one plain verification question. Never say the candidate is proficient.
- kind="learn": too distant to claim now, but realistically learnable to an interview-usable level through a bounded near-term course/project given the candidate's foundation. Keep it private and supply a concrete first learning action. Exclude gaps that would require months/years or prerequisites the candidate lacks. Python/C++ does not imply Ruby; Ruby may be a learn item only when it clears both the significant-impact and reasonable-learning-horizon gates.
- Never invent usage, proficiency, duration, projects, credentials, metrics, or accomplishments.

CANONICALIZATION:
- Map the current title to an existing role id only when it is the same durable role family despite wording/seniority variants (for example Backend Developer and Backend Engineer). Keep meaningfully different functions separate.
- Map a skill to an existing skill id only for a true semantic alias (Postgres/PostgreSQL; Django models/Django ORM), not merely related technologies (Django ORM/SQLAlchemy).
- If there is no equivalent, return an empty matched id and a clean canonical name. Preserve the scraped title in sourceTitle.

EXISTING ROLE/SKILL TAXONOMY (app data; ids may be reused under the rules above):
${wrapUntrustedText('existing-skill-taxonomy', JSON.stringify(taxonomy))}

TARGET JOB:
${jobBlock(job)}

LIVE COMPANY/ROLE CONTEXT (supporting context; if it describes a comparable role rather than this exact posting, do not treat a speculative tool as a hard requirement):
${wrapUntrustedText('company-role-research', research)}

CANDIDATE CAREER DATA:
${wrapUntrustedText('candidate-career-data', careerData)}

Return only high-impact missing skills. suggestedResumeText must be only the concise skill label/phrase that could be added after verification — never a fabricated experience bullet. For verify items, resumeCategory names the résumé Skills-section group the label belongs under, in the candidate's own domain vocabulary — 1-3 words, Title Case, a domain name like "Certifications" or "Infrastructure", never a provenance/verification word like "Verified" or "Role-fit". Choose the natural grouping the candidate's résumé would already use, so the skill merges into an existing heading instead of starting a new one. For learn items, suggestedResumeText, resumeCategory, and verificationQuestion should be empty strings. Supply learningAction for BOTH kinds: for a verify item it is the bounded fallback the user can follow if they answer "not mine."`;

  return await callLLMText(prompt, {
    signal,
    task: 'application-skill-opportunity',
    responseSchema: APPLICATION_SKILL_OPPORTUNITY_SCHEMA,
  });
}

/**
 * Mine the achievement ledger (Opus, job-independent — design §3.3), run the
 * deterministic checks (arithmetic/evidence/dates — achievementLedger.js), then
 * refute with a DIFFERENT model (Sonnet — design §3.5) and apply its verdicts.
 * Throws on any failure (including abort) — the caller decides how to degrade;
 * this function never partially persists anything, so a cancelled/failed mine
 * simply re-mines next time (nothing here is cached until the caller stores
 * the returned object on the hub).
 */
async function mineAchievementLedger(careerData, signal) {
  const miningPrompt = `You are mining a candidate's full career-data corpus for résumé-worthy ACCOMPLISHMENTS the candidate never stated directly — the kind that only become visible when you JOIN facts that live in different places in the corpus (e.g. a 2019 balance sheet + a 2023 balance sheet + a stated tenure span → "cut debt 74%").

CAREER DATA (every file the candidate dropped, concatenated; "===== FILE: <name> =====" headers mark where each file's content starts):
"""
${careerData}
"""

WHAT TO LOOK FOR — facts that only become an accomplishment WHEN JOINED:
- Time-series deltas across documents: the same metric appearing in two different snapshots, reports, or dashboards.
- Before/after around a tenure boundary: a number as the candidate started vs. as they left or as of now.
- Scale implied by scope: a stated headcount/budget/user-count combined with a stated area of responsibility.
- Firsts: "first to...", a process, product, or capability that plainly didn't exist before this person.
- Survived crises: a downturn, an outage, a reorg the candidate's role persisted through or was central to.
- Corroboration across documents: the same fact appearing in, say, a brag doc AND a performance review — the corroboration itself is evidence worth citing.

STANDARD — search broadly, but keep every claim evidence-bound:
- Be generous about what COUNTS as an accomplishment: a real but modest join is still worth surfacing, not just dramatic ones.
- Do not derive tool usage or proficiency from technical proximity. This ledger mines accomplishments, not unverified skills; adjacent-skill discovery happens in a separate candidate-review workflow.
- Be strict about the join itself being real: every endpoint must trace to an actual quote in the CAREER DATA, and the reasoning connecting the facts must hold up. Never invent an endpoint, a date, a skill, or a connection that isn't actually there.

OUTPUT:
- Rank by strength and return at most ~${MINING_TARGET} achievements. This is deliberately ABOVE the ~30-item ledger a résumé actually draws from — an independent adversarial pass runs next and drops items that don't hold up, so mining generously here leaves that pass room to cut without thinning the ledger below what a tailored résumé needs.
- NEVER author the computed figure yourself (no percentage, no dollar delta, no derived number of any kind) — return only the raw baseline/endpoint values and their labels. Code computes every number and the human-readable figure from what you return; this is the one mistake that can't be caught downstream, so leave the arithmetic to code entirely.
- Quote evidence VERBATIM — copy the exact text, not a paraphrase — and name the "===== FILE: <name> =====" section each quote came from.
- Declare attribution honestly. When the candidate's causal role in a delta is uncertain, use 'contributed' or 'context' and explain the uncertainty in caveats — do NOT drop the item just because attribution is unclear; an honestly-hedged claim is still worth a résumé line.`;

  const miningMeta = {};
  const rawLedger = await callLLMText(miningPrompt, {
    signal, task: 'career-achievement-mining', responseSchema: ACHIEVEMENT_LEDGER_SCHEMA, meta: miningMeta,
  });
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

  const { ledger: checkedLedger, gaps, stats: checkStats } = computeLedger(rawLedger, careerData);

  const serializedForRefute = serializeLedgerForPrompt(checkedLedger, {});
  const refutePrompt = `You are an independent adversarial reviewer checking a résumé "achievement ledger" that another AI derived from a candidate's career-data corpus. Your job is to ATTACK each item, not confirm it — you are the one check in this pipeline that neither deterministic code nor a light human read-through can perform.

For EVERY achievement below, ask:
- Is the JOIN valid — do the cited quotes actually support connecting these facts the way the claim does, or is the connection a stretch?
- Is ATTRIBUTION overstated — does the evidence actually show the candidate personally drove this, or does 'sole'/'led' claim more credit than the evidence supports?
- Is there a CONFOUNDER — a more plausible explanation for the change than the candidate's own work (market conditions, a reorg, someone else's initiative, survivorship in what got recorded)?

ACHIEVEMENT LEDGER (one item per [id], already checked for arithmetic/evidence/dates by code — your job is the judgment call code can't make):
"""
${serializedForRefute}
"""

CAREER DATA (for cross-checking context beyond each item's quoted evidence):
"""
${careerData}
"""

Return one verdict per id. Reach for 'drop' only when the join genuinely doesn't hold up or the claim isn't defensible at all — 'weaken' is the right call far more often (the join is real but attribution or a caveat needs adjusting). Be concrete in 'reason': name the specific confounder or overstatement, don't just assert doubt.`;

  const refuteMeta = {};
  const refuteResult = await callLLMText(refutePrompt, {
    signal, task: 'career-achievement-refute', responseSchema: ACHIEVEMENT_REFUTE_SCHEMA, meta: refuteMeta,
  });
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

  const verdicts = Array.isArray(refuteResult?.verdicts) ? refuteResult.verdicts : [];
  const { ledger, stats: refuteStats } = applyRefuteVerdicts(checkedLedger, verdicts);

  return {
    version: LEDGER_VERSION,
    minedAt: Date.now(),
    minedBy: { miner: miningMeta.model || 'unknown', refuter: refuteMeta.model || 'unknown' },
    ledger,
    gaps,
    // checkStats carries dateMisses/directionMisses/claimFigureLeaks too
    // (achievementLedger.js's computeLedger doc-comment) — all three were
    // being silently dropped here, which matters most for claimFigureLeaks:
    // it's the ONLY signal that the miner ignored the "never author the
    // computed figure yourself" instruction (§3.2), and recordApplicationTelemetry's
    // payload (below, via `stats: ledgerStats`) plus the bug-report line that
    // reads it (jobsSnapshot.js) are the sole places that leak is ever visible
    // — a hit here means a résumé line embeds a self-computed figure a
    // reviewer could quietly trust as code-verified when it isn't. Forwarding
    // it into `stats` and stopping short of the bug-report line would leave
    // the data present but still invisible, so jobsSnapshot.js's stats
    // summary line was updated alongside this to print it.
    stats: {
      mined: checkStats.mined,
      droppedByRefute: refuteStats.droppedByRefute,
      demotedByCheck: checkStats.demotedByCheck,
      evidenceMisses: checkStats.evidenceMisses,
      dateMisses: checkStats.dateMisses,
      directionMisses: checkStats.directionMisses,
      claimFigureLeaks: checkStats.claimFigureLeaks,
    },
  };
}

/** Fill the design system's résumé markup, tailored to the job + research. */
/**
 * The static, job-independent prefix of the résumé prompt → CACHED PREFIX.
 * The candidate's careerData, the design-system instructions/markup, the
 * ledger, and the rubric are all byte-identical across every application
 * generated this session from this hub (and across the initial generation +
 * any later length-revision call for the SAME application, below), so every
 * call after the first reads this from cache (~10% of input cost) instead of
 * re-billing it. Pulled out of generateResumeMain (rather than inlined there)
 * specifically so reviseResumeForLength can call it a second time with the
 * SAME arguments and get the byte-identical string back — Anthropic's prompt
 * cache keys on exact prefix bytes, so re-deriving this block with even
 * slightly different interpolation at the call site would silently miss the
 * cache on the revision call. Only the per-job job/research (and, for the
 * revision call, the in-progress résumé + how much to cut) live in each
 * call's DYNAMIC prompt, appended after this. Keep this function's output
 * byte-stable for a given (careerData, ledger) pair.
 */
function buildResumeCachedPrefix({ careerData, ledger }) {
  // The ledger — serialized through serializeLedgerForPrompt(), NEVER a raw
  // JSON.stringify (whose key order can vary call to call and would silently
  // miss the cache marker below — see that function's own doc-comment and
  // design §4.1). Empty when no ledger is available for this application
  // (absent, mining failed, or mining was skipped this call) — the model then
  // just gets the CAREER DATA + rubric, i.e. today's behavior.
  const ledgerSection = ledger?.ledger?.length
    ? `\n\nACHIEVEMENT LEDGER (accomplishments already DERIVED by joining facts across the CAREER DATA above — see the RECEIPTS rule below for how to use them; this is a FLOOR, not a ceiling — you still have the full CAREER DATA and should mine it yourself for anything the target job emphasizes that this ledger missed):
"""
${serializeLedgerForPrompt(ledger.ledger, { gaps: ledger.gaps })}
"""`
    : '';

  // The editorial rubric — read at runtime from resume_design_system/, injected
  // WHOLE (never parsed by heading — see getEditorialRubric's doc-comment).
  // Empty when the docs are absent; injection is skipped rather than failing.
  const rubricText = getEditorialRubric();
  const rubricSection = rubricText
    ? `\n\nEDITORIAL RUBRIC (the design system's own writing/editing standard — follow it for phrasing, bullet length, and structure; the CAREER DATA and ACHIEVEMENT LEDGER above govern WHAT to write, this governs HOW):
"""
${rubricText}
"""`
    : '';

  return `You are an elite résumé writer using the "Editorial" design system. Produce ONE \`<main class="page">…</main>\` HTML block that fills the design system's EXACT markup, tailored to the TARGET JOB and company research provided at the end.

CAREER DATA (the candidate — every claim must be grounded in this; see TRUTHFULNESS & FRAMING below):
"""
${careerData}
"""

MARKUP TO MIRROR (copy these class names and structure exactly; replace only the content):
${getResumeSampleMain()}

TRUTHFULNESS & FRAMING (read carefully — this is the core constraint):
- Ground every claim in the CAREER DATA. NEVER invent employers, job titles, employment dates, degrees, certifications, or specific metrics/numbers the data doesn't support — with ONE exception: a figure that appears in the ACHIEVEMENT LEDGER above is already verified and computed by code FROM the candidate's own career data, not invented by you, and you SHOULD use it per the RECEIPTS rule below. A recruiter must be able to verify everything against the candidate's real history.
- You MAY state a capability that is directly entailed by concrete demonstrated work (shipped production REST APIs → HTTP/JSON and API design; led a 5-person team → team leadership; substantial PostgreSQL work → SQL). Do NOT turn mere technical proximity into experience or proficiency. A named framework alone does not prove use of every subsystem inside it. Any plausible-but-unverified adjacent skill is handled by a separate private review workflow and is expressly excluded from this draft until the candidate verifies it.
- The ACHIEVEMENT LEDGER, when present, is a FLOOR, not a ceiling. Draw on its strongest items where they fit this job, but you still have the full CAREER DATA above — dig into it yourself for anything the target job emphasizes that the ledger didn't surface.
- ATTRIBUTION: a ledger item with \`attribution=context\` means the change happened during the candidate's tenure but their personal causal role is uncertain — phrase it AS CONTEXT ("during a period when revenue grew 40%...", "amid a company-wide replatforming that cut latency 60%..."), never as a personal win ("I grew revenue 40%"). \`sole\`/\`led\`/\`contributed\` items may be phrased as a personal accomplishment, scaled to that word.
- RECEIPTS: when a bullet uses a figure sourced from the ACHIEVEMENT LEDGER (not one quoted verbatim from the CAREER DATA), wrap ONLY the figure in \`<strong data-achievement-id="ID">figure</strong>\` using that item's \`[id]\` from the ledger above, e.g. \`<strong data-achievement-id="a3">74%</strong>\`. Emit ONLY the bare id — never the derivation text, never your own paraphrase of it. Do NOT use this attribute on a figure quoted directly from the CAREER DATA (not derived) — if every number carries the attribute, it stops meaning anything.
- FRAME to connect the dots: actively phrase and order the candidate's genuine experience in the TARGET JOB's language so a busy recruiter instantly sees the match. Translate real accomplishments into the JD's terminology wherever the underlying work truly maps. Lead each role/bullet with what's most relevant to this job.
- You MAY include skills/tools the candidate genuinely has (or that fairly derive from their work) even when the JD doesn't list them — but only when it's EASY TO SEE how they benefit THIS job (a recruiter would immediately recognize the relevance). Don't pad with items that are merely field-adjacent or whose usefulness here isn't obvious.

RULES:
- Output ONLY the \`<main class="page" …>…</main>\` block. No <html>, <head>, <style>, no markdown fences, no commentary before or after.
- Use the exact classes shown in the MARKUP TO MIRROR sample above — do not invent new ones or rename them.
- Pull the candidate's name, contact line, titles, employers, dates, and bullets from the CAREER DATA.
- Wrap scale numbers / metrics quoted directly from the CAREER DATA in plain <strong>. Senior annotations are OPTIONAL and only if the data supports them: \`<span class="scope"><span class="annotation-label"> — </span>…</span>\` and \`<span class="tradeoff"><span class="annotation-label"> · trade-off: </span>…</span>\`. Figures sourced from the ACHIEVEMENT LEDGER instead use the RECEIPTS markup above, not plain <strong>.
- 3-6 bullets per role, each with a concrete outcome or number drawn from the career data (or, per RECEIPTS, the ledger). Reorder and emphasize to match the job + research (per the FRAMING rules above).
- Section order: Experience, then OPTIONAL "Selected Systems"/projects, Skills, Education. Drop any section the career data can't support (e.g. omit "Selected Systems" for non-engineering candidates).
- No icons, photos, skill bars, progress dots, summary/objective paragraph, or emoji.
- VARIANT — set as attributes on the <main> tag:
  • Design-conscious / startup / craft-oriented company → \`data-print="dual-pdf"\` (the design system default — warm cream on screen, background automatically removed when printed).
  • Big-company ATS / enterprise / regulated / finance back-office → \`data-print="ink-only"\` (flat white; also add \`data-mono\` for very conservative fields: defense, big-law, traditional banking IT).
  • Non-US recipient → also add \`data-page="a4"\`.${ledgerSection}${rubricSection}`;
}

/** Fill the design system's résumé markup, tailored to the job + research. */
async function generateResumeMain({ careerData, job, research, researchAvailable = true, ledger, skillInsights }, signal) {
  const cachedPrefix = buildResumeCachedPrefix({ careerData, ledger });
  const excludedSkills = (Array.isArray(skillInsights?.items) ? skillInsights.items : [])
    .map(item => String(item?.canonicalSkillName || '').trim())
    .filter(Boolean);
  const verifiedCategories = [...new Set(
    (Array.isArray(skillInsights?.items) ? skillInsights.items : [])
      .filter(item => item?.kind === 'verify')
      .map(item => String(item?.resumeCategory || '').trim())
      .filter(Boolean)
  )];
  const categoryPreference = verifiedCategories.length
    ? ` NAMING PREFERENCE: if a Skills group you would naturally create from genuine, corpus-backed skills covers one of these areas — ${verifiedCategories.join(', ')} — use that exact label for its <dt>. This is a naming preference only for a group your own real skill data already justifies: never create, pad, or retain a group solely to host one of these labels, and an area with no genuine corpus-backed skills gets no group at all. The exclusion above still applies — populate any such group only from real career data, never from this list.`
    : '';
  const exclusionBlock = excludedSkills.length
    ? `\n\nPRIVATE MISSING-SKILL ANALYSIS — EXCLUSION LIST:\n${excludedSkills.map(name => `- ${name}`).join('\n')}\nThese skills were classified as plausible-but-unverified or learn-first gaps. Do NOT put them anywhere in the résumé draft, do NOT imply the candidate used them, and do NOT substitute an alias. The self-contained HTML workspace will let the candidate verify eligible near-adjacent items and will insert only the confirmed skill labels deterministically.${categoryPreference}`
    : '';
  const prompt = `TARGET JOB (the "Description" is what we scraped — it may be full, partial, or empty):
${jobBlock(job)}

COMPANY & ROLE CONTEXT (${researchAvailable ? 'live web research — combine it with the scraped Description above for the full picture' : 'live research unavailable — use only the scraped Description for company and role facts'}):
"""
${research}
"""${exclusionBlock}

Now produce the single \`<main class="page">…</main>\` block for THIS job, grounded in the CAREER DATA and following the markup + rules above.`;
  return await callLLMRaw(prompt, { signal, task: 'application-resume', cachedPrefix });
}

// Rough estimate only — the revision prompt needs a DIRECTION and a rough
// MAGNITUDE ("cut about N lines"), not a precise target. This is a generic
// single-column résumé page at the design system's default body type
// (colors_and_type.css: ~10.25pt / 1.45 leading over a ~9in content height)
// and doesn't need to be exact for that purpose — it only steers how
// aggressively the model trims, and the fit loop re-measures with a real
// render afterward regardless of how close this guess was.
const LINES_PER_PAGE_ESTIMATE = 45;

/**
 * ONE targeted revision pass — SKILL.md §5's "overflow is large" case.
 * Ambiguous one-page overflow reaches here after compact density proved
 * insufficient; a count that is more than one whole page over target reaches
 * here directly. Reuses buildResumeCachedPrefix with the SAME (careerData,
 * ledger) the initial résumé call used, so this call still hits the Anthropic
 * prompt cache instead of re-billing the whole prefix.
 */
async function reviseResumeForLength({ careerData, ledger, mainHtml, pageCount, targetPageCount, compactApplied }, signal) {
  const cachedPrefix = buildResumeCachedPrefix({ careerData, ledger });
  const overflowPages = pageCount - targetPageCount;
  const estimatedLinesToCut = Math.max(4, Math.round(overflowPages * LINES_PER_PAGE_ESTIMATE));
  const fitContext = compactApplied
    ? 'even WITH data-density="compact" applied'
    : 'without trying data-density="compact", because the page count is more than one whole page beyond the target';

  const prompt = `The résumé <main> block below renders to ${pageCount} page(s) ${fitContext}, but the target for this job is ${targetPageCount} page(s). Per the editorial rubric above (SKILL.md §5), the content needs a focused length edit.

Revise it to cut roughly ${estimatedLinesToCut} line(s) of content. Cut or merge the WEAKEST bullets first — the ones leaning on adjectives instead of a number or trade-off, per the rubric's content rules — before touching anything with a strong metric or receipt. Keep the exact same markup structure, classes, and attributes (including whatever data-print/data-mono/data-page/data-density the block already has). Do not change any candidate fact, employer, date, or figure — this is a LENGTH edit, not a rewrite. Output ONLY the revised \`<main class="page" …>…</main>\` block: no <html>, no markdown fences, no commentary before or after.

CURRENT <main> BLOCK TO REVISE:
${mainHtml}`;

  return await callLLMRaw(prompt, { signal, task: 'application-resume', cachedPrefix });
}

// Absolute safety net on the render → fit loop (SKILL.md §5 / decideFitStep
// above) — the deterministic path (initial render, compact retry, one
// post-revision render) only ever needs 3, but a future change to
// decideFitStep that adds a step must not be able to loop this forever; a
// résumé PDF is worth retrying for, not worth hanging a Generate click over.
const MAX_RENDER_ATTEMPTS = 4;

function throwIfAbortedApp(signal) {
  if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/**
 * Drives SKILL.md §5's render → page-count → fit loop end to end for one
 * résumé: render, apply compact density if it's over target, make one
 * targeted revision call if compact still isn't enough, ship whatever the
 * last successful render produced. See decideFitStep for the per-step
 * decision and MAX_RENDER_ATTEMPTS for the hard cap.
 *
 * ROBUSTNESS (design item 4): a render failure at ANY attempt (no display,
 * printToPDF throwing, pdf-lib rejecting malformed bytes) breaks out of the
 * loop and returns with `pdfBytes: null` rather than throwing — the caller
 * ships the HTML regardless (a layout nicety must never cost the user their
 * résumé). AbortError is the one exception: a real cancellation propagates
 * so the caller can stop the whole generation, not just this loop.
 *
 * @param {object} args
 * @param {object|null} args.ledger  the WRAPPED `{ ledger, gaps }` shape (or
 *   null) — the SAME shape/value `generateResumeMain` was called with
 *   (`ledgerForPrompt`), NOT the bare achievement array. Both
 *   `buildResumeCachedPrefix`/`reviseResumeForLength` (need the wrapped shape
 *   to reproduce the byte-identical cached prefix) and `buildResumeDocument`
 *   (needs the bare array, for `injectReceipts`) are called from inside this
 *   loop — passing the wrong shape to either would either silently drop the
 *   ledger from the revision prompt (breaking the prompt-cache reuse this
 *   whole plumbing exists for) or crash the receipt resolver.
 * @returns {Promise<{
 *   mainHtml: string, variantAttrs: string, pdfBytes: Uint8Array|null,
 *   pageCount: number|null, attempts: Array<object>,
 *   compactApplied: boolean, revisionApplied: boolean, renderError: string|null,
 * }>}
 */
async function renderResumeWithFit({ careerData, ledger, resumeMainHtml, docId, targetPageCount, skillInsights }, signal) {
  const attempts = [];
  let mainHtml = resumeMainHtml;
  // The length-revision model may cut copy but must not silently change the
  // initial document's ATS/ink-only choice or its paper size. Keep the root
  // variant immutable across retries; buildResumeDocument removes conflicting
  // model-level copies before rendering.
  const baseVariantAttrs = extractVariantAttrs(resumeMainHtml, { density: null });
  const variantAttrsForDensity = (nextDensity) => nextDensity === 'compact'
    ? `${baseVariantAttrs} data-density="compact"`
    : baseVariantAttrs;
  let density = null;   // null | 'compact'
  let compactTried = false;
  let revisionTried = false;
  let pdfBytes = null;  // valid ONLY for the (mainHtml, density) pair currently in scope
  let pageCount = null;
  let renderError = null;
  let fontsLoaded = true; // renderPdf's own fonts-actually-loaded check (not just fonts.ready resolving) — assume good until a render says otherwise
  const ledgerArray = ledger?.ledger || null; // buildResumeDocument/injectReceipts want the bare array — see the @param note above

  for (let attempt = 1; attempt <= MAX_RENDER_ATTEMPTS; attempt++) {
    throwIfAbortedApp(signal);
    const variantAttrs = variantAttrsForDensity(density);
    // Measure the largest possible reviewed state: every near-adjacent skill is
    // visible. The shipped interactive HTML still starts with all candidates
    // hidden and requires explicit verification; this render exists only to
    // keep a later all-verified export within the same page target.
    const doc = buildResumeDocument({
      resumeMainHtml: mainHtml,
      variantAttrs,
      ledger: ledgerArray,
      docId,
      skillInsights,
      showAllVerifySkills: true,
    });

    try {
      const rendered = await renderPdf(doc, { signal });
      pageCount = rendered.pageCount;
      fontsLoaded = rendered.fontsLoaded !== false;
      renderError = null;
      // Keep the bytes ONLY when the fonts they were laid out with are the
      // real ones. A fallback-typeface PDF looks subtly wrong and would sit in
      // "Applied Jobs" indistinguishable from a good one — the exact artifact a
      // user could send to an employer without noticing. The HTML still ships
      // and renders correctly the moment they're back online.
      pdfBytes = fontsLoaded ? rendered.bytes : null;
      attempts.push({ attempt, density, pageCount, fontsLoaded });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      pdfBytes = null;
      pageCount = null;
      renderError = e?.message || String(e);
      attempts.push({ attempt, density, pageCount: null, error: renderError });
      logger.warn(`[JobApplication] Résumé PDF render failed (attempt ${attempt}/${MAX_RENDER_ATTEMPTS}, density=${density || 'default'}) — shipping the HTML without a PDF: ${renderError}`);
      break; // rendering infrastructure is broken this call — further attempts would fail the same way (§4)
    }

    const step = decideFitStep({ pageCount, target: targetPageCount, compactTried, revisionTried, fontsLoaded });
    if (step.action === 'ship') break;

    if (step.action === 'compact') {
      density = 'compact';
      compactTried = true;
      continue;
    }

    // step.action === 'revise'
    revisionTried = true;
    try {
      mainHtml = await reviseResumeForLength({
        careerData, ledger, mainHtml, pageCount, targetPageCount, compactApplied: compactTried,
      }, signal);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      logger.warn(`[JobApplication] Length-revision call failed — shipping the last successful render as-is (${pageCount} page(s) vs target ${targetPageCount}): ${e?.message || e}`);
      break; // keep the current mainHtml/pdfBytes/pageCount — best effort, per §4
    }
    // Content changed — the PDF/pageCount just measured no longer describes
    // it; the next loop iteration re-renders before deciding anything else.
    pdfBytes = null;
    pageCount = null;
  }

  const finalVariantAttrs = variantAttrsForDensity(density);
  return {
    mainHtml, variantAttrs: finalVariantAttrs, pdfBytes, pageCount, attempts,
    compactApplied: compactTried, revisionApplied: revisionTried, renderError, fontsLoaded,
  };
}

/** Structured cover letter the renderer lays out on the design-system letterhead. */
async function generateCoverLetterFields({ careerData, job, research, researchAvailable = true, ledger, skillInsights }, signal) {
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  // Same ledger serialization as the résumé (byte-stable — see that function's
  // comment), but the instruction is deliberately narrower: "at most two or
  // three" per design §4.4 — a letter that recites the résumé's numbers reads
  // as padding, and every figure it does use also appears on the résumé where
  // it carries a full receipt.
  const ledgerSection = ledger?.ledger?.length
    ? `\n\nACHIEVEMENT LEDGER (accomplishments already DERIVED by joining facts across the CAREER DATA; draw on AT MOST two or three of the strongest items that genuinely fit this job — a letter that recites the résumé's numbers reads as padding, and every figure used here also appears on the résumé, where it carries a receipt):
"""
${serializeLedgerForPrompt(ledger.ledger, { gaps: ledger.gaps })}
"""`
    : '';
  const rubricText = getEditorialRubric();
  const rubricSection = rubricText
    ? `\n\nEDITORIAL RUBRIC (the design system's own writing standard — follow it for voice and phrasing):
"""
${rubricText}
"""`
    : '';

  // Static, job-independent block → CACHED PREFIX (careerData + writing rules are
  // byte-identical across every application this session; only the job, research,
  // and date vary). Keep byte-stable so cover-letter call 2..N hit the cache.
  const researchRule = researchAvailable
    ? 'Each ties SPECIFIC career-data evidence to SPECIFIC job requirements, and references a genuine detail from the research (a product, a value, or a recent development).'
    : 'Each ties SPECIFIC career-data evidence to SPECIFIC requirements in the scraped target job. Live company research is unavailable, so do not mention or imply unverified company facts, values, products, news, or role requirements.';
  const cachedPrefix = `Write a tailored cover letter for a candidate applying to a job. Return JSON matching the provided schema, grounded in the CAREER DATA below and the target job + research provided at the end.

CAREER DATA (use ONLY facts found here for the candidate's name, contact, and evidence):
"""
${careerData}
"""

WRITING RULES:
- 3-4 body paragraphs. ${researchRule}
- Authentic, specific, and concise — not a generic template. Ground every claim in the career data: never invent employers, titles, dates, skills, proficiency, or numbers — with ONE exception: a figure drawn from the ACHIEVEMENT LEDGER below is already verified and computed by code FROM the candidate's own career data, not invented. You may state only capabilities directly entailed by concrete demonstrated work and may frame genuine accomplishments in the job's language. Technical proximity alone is not evidence of experience.
- NO RECEIPTS here — unlike the résumé, this document's paragraphs are plain prose with nowhere to hang a machine-readable attribute, so any ledger figure you use is stated as unadorned text.
- A ledger item with attribution 'context' describes something that happened during the candidate's tenure, not necessarily because of them — phrase it as context, never as a personal win.
- Pull "name", "tagline", and "contact" (location, email, phone, one URL) from the career data; omit any contact item not present.${ledgerSection}${rubricSection}`;

  const excludedSkills = (Array.isArray(skillInsights?.items) ? skillInsights.items : [])
    .map(item => String(item?.canonicalSkillName || '').trim())
    .filter(Boolean);
  const exclusionBlock = excludedSkills.length
    ? `\n\nPRIVATE MISSING-SKILL EXCLUSION LIST:\n${excludedSkills.map(name => `- ${name}`).join('\n')}\nDo not mention or imply these skills in the cover letter. Near-adjacent items still require candidate verification; learn items are not current skills.`
    : '';

  const prompt = `TARGET JOB (the "Description" is what we scraped — it may be full, partial, or empty):
${jobBlock(job)}

COMPANY & ROLE CONTEXT (${researchAvailable ? 'live web research — combine it with the scraped Description above for the full picture' : 'live research unavailable — use only the scraped Description for company and role facts'}):
"""
${research}
"""${exclusionBlock}

FILL THESE FIELDS for THIS job (per the CAREER DATA and writing rules above):
- "date" = "${today}". "recipient" = the addressee block, one item per line separated by a literal \\n: first line the addressee, then the company, e.g. "Hiring Team\\n${job.company || 'the company'}" (optionally add a third line for the team/department if the research makes it clear). "salutation" like "Dear ${job.company || 'Hiring'} Team,". "closing" like "Sincerely,". "signatureTitle" = the TARGET role being applied to + " · candidate", i.e. "${job.title || 'the role'} · candidate".`;
  const result = await callLLMText(prompt, { signal, task: 'application-cover-letter', responseSchema: APPLICATION_COVER_LETTER_SCHEMA, cachedPrefix });
  return result;
}

function sanitizeFilePart(s, fallback) {
  return sanitizeApplicationBundlePart(s, fallback);
}

async function replaceFileAtomically(destination, data) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${crypto.randomUUID()}.tmp`);
  try {
    await fs.promises.writeFile(temporary, data);
    await fs.promises.rename(temporary, destination);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

async function copyFileAtomically(source, destination) {
  await replaceFileAtomically(destination, await fs.promises.readFile(source));
}

// Bug-report only: how many verify items to keep full detail for. The
// analysis prompt already gates hard on "significantly improve this
// candidate's odds" (§ analyzeSkillOpportunities), so a real response is
// small — this cap exists only so a pathological response can't blow the
// clipboard budget, not because the ordinary case needs trimming.
const SKILL_OPPORTUNITY_VERIFY_SAMPLE_CAP = 20;

// Bounded, sanitized per-verify-item detail for the bug reporter — the whole
// point of a skill-opportunity report line is answering "which Skills-section
// category would this verified skill file under," and the aggregate counts
// alone can't answer that. canonicalSkillName/resumeCategory are model-
// supplied strings (see APPLICATION_SKILL_OPPORTUNITY_SCHEMA), so they're
// collapsed/capped the same way every other model string reaching a report
// is (compare companyResearch.error handling above) rather than trusted
// verbatim.
function sanitizeSkillOpportunityVerifyItems(items) {
  const verify = (Array.isArray(items) ? items : []).filter(item => item?.kind === 'verify');
  const clean = (value, maxLen) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
  const sample = verify.slice(0, SKILL_OPPORTUNITY_VERIFY_SAMPLE_CAP).map(item => ({
    canonicalSkillName: clean(item?.canonicalSkillName, 80),
    resumeCategory: clean(item?.resumeCategory, 60),
  }));
  return { sample, total: verify.length, truncated: sample.length < verify.length };
}

// Bug-report only: pull the résumé's own `<dl class="skills">…</dl>` block out
// of the FINAL rendered document — the one place a skill-opportunity /
// résumé-injection bug actually shows, and the section the plain head-slice
// sample (resumeHtmlSample below) is too short to ever reach. Mirrors
// resumeHtml.js's injectInferredSkills open-tag regex EXACTLY — see that
// function's own doc-comment for why the boundary check after the bare
// (unquoted) `skills` class value must be a LOOKAHEAD, not a consuming match:
// a consuming version eats the tag's own `>`, then lets `[^>]*>` overshoot
// hunting for the NEXT `>`, so a bare `<dl class="skills">` (nothing else in
// the attribute) mismatches. Do not replace this with a fresh regex that
// reintroduces that bug.
const SKILLS_DL_OPEN_RE = /<dl\b[^>]*\bclass\s*=\s*(?:"[^"]*\bskills\b[^"]*"|'[^']*\bskills\b[^']*'|skills(?=\s|>|\/))[^>]*>/i;
function extractSkillsDlSample(html, maxLen = 2500) {
  const text = String(html || '');
  const open = SKILLS_DL_OPEN_RE.exec(text);
  if (!open) return { found: false, sample: '', truncated: false };
  const closeAt = text.indexOf('</dl>', open.index + open[0].length);
  if (closeAt < 0) return { found: false, sample: '', truncated: false };
  const block = text.slice(open.index, closeAt + '</dl>'.length);
  return { found: true, sample: block.slice(0, maxLen), truncated: block.length > maxLen };
}

// Last application generation — captured so the bug reporter can SEE the model's
// actual résumé markup + cover-letter fields. That's the ONE place an application
// rendering bug shows (a stray mid-sentence newline, a literal "\n"/"\t", broken
// structure) — without it those are undebuggable from a report. In-memory,
// last-one-wins, never persisted (the HTML files already are). Also carries the
// achievement-ledger telemetry (mined/reused/unavailable, stats, resolved
// models) so a report shows whether the feature ran at all and what it did.
let lastApplication = null;
export function getApplicationTelemetry() {
  return lastApplication;
}
// Exported for the deterministic bug-report fixtures. Production callers keep
// this private to the generation lifecycle below; tests use it to assert the
// report renders failed attempts just as faithfully as completed ones.
export function recordApplicationTelemetry(data) {
  if (data == null) {
    lastApplication = null;
    return;
  }
  lastApplication = { ts: Date.now(), ...data };
}

export function registerJobApplicationHandlers() {
  // Generate the tailored résumé + cover letter HTML documents. Returns temp
  // paths; save-application then copies them to a user-chosen folder.
  handleSafe('generate-application', async (event, { job, careerData, nodeId, achievements, mineAllowed, targetPageCount: targetPageCountOverride }, signal) => {
    const company = job?.company || 'this company';
    // A previous implementation only recorded telemetry after every model,
    // render, and artifact-write step had succeeded. That made the most useful
    // report case — an early generation failure — look as if Generate was never
    // clicked. Keep one bounded, in-memory lifecycle record from the first
    // instruction through terminal outcome. It is diagnostics only: it changes
    // neither the generated content nor error/cancellation behavior.
    const attemptId = crypto.randomUUID();
    const applicationAttempt = {
      attemptId,
      nodeId: nodeId || null,
      jobTitle: job?.title || '',
      company: job?.company || '',
      startedAt: Date.now(),
      status: 'running',
      stage: 'starting',
      stages: [],
      taskRoutes: ['company-research', 'application-skill-opportunity', 'application-resume', 'application-cover-letter']
        .map(task => ({ task, provider: providerForTask(task), model: modelForTask(task) })),
    };
    const updateAttempt = (changes = {}) => {
      // Concurrent Generate clicks are possible on different cards. Do not let
      // an older attempt that settles late replace the newer one in the
      // last-attempt diagnostic slot.
      if (lastApplication && lastApplication.attemptId !== attemptId) return;
      recordApplicationTelemetry({ ...applicationAttempt, ...lastApplication, ...changes });
    };
    const markStage = (stage) => {
      applicationAttempt.stage = stage;
      applicationAttempt.stages = [...applicationAttempt.stages, { stage, ts: Date.now() }];
      updateAttempt({
        status: 'running',
        stage,
        stages: applicationAttempt.stages,
      });
    };
    const diagnosticError = (error) => String(error?.message || error || 'Unknown generation failure')
      .replace(/[\r\n\t]+/g, ' ')
      .slice(0, 800);
    // Claim the last-attempt slot before the fencing guard in updateAttempt is
    // used. Without this, a previously running attempt would prevent the new
    // attempt from ever becoming visible in diagnostics.
    recordApplicationTelemetry(applicationAttempt);
    markStage('model resolution');
    logger.info(`[JobApplication][${nodeId || '?'}] Generating application for ${job?.title} @ ${company}`);

    try {

    // Resolve Claude family tokens ONCE for this whole run (résumé design doc
    // §8.3 guard 2 / §3.6): prompt caches are model-scoped, so flipping the
    // resolved id mid-run would silently invalidate every cached prefix below
    // and re-bill it at full rate. Never throws — falls back to MODEL_FLOOR on
    // any resolution failure.
    await primeClaudeModels({ signal });

    // Career data is required — fail loudly rather than producing an empty or
    // fabricated résumé.
    if (!careerData || !String(careerData).trim()) {
      throw new Error('No career data available for this hub. Drop your career files onto the job hub first.');
    }

    markStage('achievement ledger');
    // 0. Achievement ledger (résumé design doc §3.6/§3.7). Reuse a passed-in
    //    ledger when present (hub-cached, so every application from this hub
    //    carries the SAME derived figures); mine only when absent AND the
    //    renderer says mining is allowed (its own in-flight marker prevents
    //    two concurrent Generates from both mining and racing to cache). A
    //    mine/refute FAILURE must never block generation — it falls back to
    //    today's behavior (careerData alone) with a short reason recorded.
    let freshlyMined = null;    // returned to the renderer to cache on the hub, or null
    let achievementsSkipped = null;
    let ledgerSource = 'none';  // 'reused' | 'mined' | 'unavailable' — telemetry only
    let ledgerForPrompt = null; // { ledger, gaps } fed to the résumé/cover-letter calls, or null

    if (achievements && Array.isArray(achievements.ledger)) {
      ledgerForPrompt = { ledger: achievements.ledger, gaps: achievements.gaps || [] };
      ledgerSource = 'reused';
    } else if (mineAllowed) {
      try {
        freshlyMined = await mineAchievementLedger(careerData, signal);
        ledgerForPrompt = { ledger: freshlyMined.ledger, gaps: freshlyMined.gaps };
        ledgerSource = 'mined';
      } catch (e) {
        if (e?.name === 'AbortError') throw e; // a real cancellation must actually cancel, not degrade
        logger.warn(`[JobApplication][${nodeId || '?'}] Achievement mining failed, continuing on careerData alone: ${e?.message || e}`);
        achievementsSkipped = `Mining failed: ${String(e?.message || e).slice(0, 200)}`;
        ledgerSource = 'unavailable';
      }
    } else {
      ledgerSource = 'unavailable';
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // 1. Live company + role research (grounded). It improves tailoring, but
    //    quota/capability failures degrade safely to the scraped description.
    markStage('company and role research');
    const companyResearch = await getCompanyResearchContext(job, signal);
    const research = companyResearch.text;
    // Persist this as soon as research settles, not only with the final
    // artifact snapshot: the subsequent résumé/cover-letter call can still
    // fail, and that failure report must say whether it had live context.
    updateAttempt({
      companyResearch: { available: companyResearch.available, error: companyResearch.error },
    });
    if (!companyResearch.available) {
      logger.warn(`[JobApplication][${nodeId || '?'}] Company/role research unavailable — continuing with scraped job description only: ${companyResearch.error}`);
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // 2. High-impact missing-skill analysis + persistent demand histogram.
    //    This is separate from the résumé call so the optimization target
    //    (find consequential gaps) never competes with employer-facing prose.
    //    AI owns semantic aliasing across role/skill names; deterministic code
    //    owns one-count-per-generation persistence. A failure is visible in the
    //    workspace but does not cost the user the rest of the application.
    markStage('skill-opportunity analysis');
    let skillInsights = { role: { canonicalName: String(job?.title || 'Other'), matchedRoleId: '', sourceTitle: String(job?.title || '') }, items: [] };
    let skillHistogram = { version: 1, roles: [] };
    let skillOpportunityError = null;
    let skillAnalysisReady = false;
    try {
      const recorded = await withSkillOpportunityLock(async () => {
        const histogramBefore = loadSkillOpportunityHistogram();
        const analysis = await analyzeSkillOpportunities({ careerData, job, research, histogram: histogramBefore }, signal);
        if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        // Project the workspace bars without mutating durable demand yet. The
        // actual increment happens only after every application artifact has
        // been written successfully below.
        return { analysis, histogram: mergeSkillOpportunityAnalysis(histogramBefore, analysis) };
      }, signal);
      skillInsights = recorded.analysis;
      skillHistogram = recorded.histogram;
      skillAnalysisReady = true;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      skillOpportunityError = String(e?.message || e).slice(0, 300);
      logger.warn(`[JobApplication][${nodeId || '?'}] Skill-opportunity analysis unavailable — continuing with a visible workspace warning: ${skillOpportunityError}`);
    }

    markStage('résumé generation');
    // 3. Résumé HTML (design-system markup) + 4. structured cover letter.
    const resumeMainHtml = await generateResumeMain({ careerData, job, research, researchAvailable: companyResearch.available, ledger: ledgerForPrompt, skillInsights }, signal);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    markStage('cover-letter generation');
    const coverLetter = await generateCoverLetterFields({ careerData, job, research, researchAvailable: companyResearch.available, ledger: ledgerForPrompt, skillInsights }, signal);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // 5. Local render → page-count → fit loop (SKILL.md §5). Runs on the
    //    RAW model markup — docId is generated now (not after the loop) since
    //    it's baked into the rendered document at every attempt (keys the
    //    contenteditable autosave, §5.5) and must stay the same across
    //    attempts for the same application. This can NEVER block generation:
    //    renderResumeWithFit itself already degrades render failures to
    //    `pdfBytes: null` internally (§4), and this try/catch is a second,
    //    outer safety net for anything unexpected in the loop's own
    //    orchestration (a bug here must still ship the HTML the model wrote).
    const resumeDocId = crypto.randomUUID();
    const targetPageCount = Number.isFinite(targetPageCountOverride) && targetPageCountOverride > 0
      ? targetPageCountOverride
      : targetPageCountForJob(job?.title);

    markStage('résumé render and fit');
    let fitResult = null;
    try {
      fitResult = await renderResumeWithFit({
        // The WRAPPED { ledger, gaps } shape — same value generateResumeMain
        // was called with — NOT the bare array (see renderResumeWithFit's
        // @param note: it needs the wrapped shape to reproduce the
        // byte-identical cached prefix on a length-revision call).
        careerData, ledger: ledgerForPrompt, resumeMainHtml, skillInsights,
        docId: resumeDocId, targetPageCount,
      }, signal);
    } catch (e) {
      if (e?.name === 'AbortError') throw e; // a real cancellation must actually cancel, not degrade
      logger.warn(`[JobApplication][${nodeId || '?'}] Résumé render/fit loop failed unexpectedly — shipping the HTML without a PDF: ${e?.message || e}`);
    }
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // The fit loop may have applied compact density and/or a length revision
    // — finalMainHtml/variantAttrs are what actually get shipped as BOTH the
    // HTML and the PDF (the whole point of a shared source: they must never
    // diverge). Falls back to the original, unfit markup when the loop threw
    // before producing anything at all.
    const finalMainHtml = fitResult?.mainHtml || resumeMainHtml;
    const variantAttrs = fitResult?.variantAttrs || extractVariantAttrs(resumeMainHtml);

    const resumeRequiresReview = (Array.isArray(skillInsights?.items) ? skillInsights.items : [])
      .some(item => item?.kind === 'verify');
    // The fit loop intentionally measures a worst-case document with every
    // candidate skill revealed. Those bytes must never be delivered: an
    // unverified skill in a PDF is an employer-facing claim. We render a
    // second, baseline document below with every inferred skill hidden.
    let resumePdfBytes = null;
    let baselinePdfError = null;
    let baselineFontsLoaded = null;
    let baselinePageCount = null;
    let coverLetterPdfBytes = null;
    let coverLetterPdfError = null;
    let coverLetterFontsLoaded = null;

    markStage('baseline PDF render');
    // 6. Build ONE self-contained application workspace. The design-system
    // builder owns the resume/cover tabs; the PDF below is deliberately the
    // résumé-only printable baseline. The same workspace is what a user can
    // reopen later to edit either document and Sync it back to this folder.
    const candidateName = coverLetter?.name || '';
    const jobMarkdown = formatOriginalJobListingMarkdown(job);
    const buildApplicationDocument = () => buildResumeDocument({
      resumeMainHtml: finalMainHtml,
      variantAttrs,
      ledger: ledgerForPrompt?.ledger || null,
      docId: resumeDocId,
      skillInsights,
      skillHistogram,
      skillOpportunityError,
      jobContext: { title: job?.title || '', company: job?.company || '' },
      coverLetter,
      downloadBundle: {
        company: job?.company || '',
        candidateName,
        jobMarkdown,
      },
    });

    // `renderResumeWithFit` measures all verified candidates to reserve page
    // room, so its PDF is intentionally never shipped. Render the normal
    // workspace state separately: candidates stay hidden until the person
    // explicitly verifies them, making this a safe baseline attachment.
    const baselineDocument = buildApplicationDocument();
    try {
      const rendered = await renderPdf(baselineDocument, { signal });
      baselineFontsLoaded = rendered.fontsLoaded !== false;
      // Free — renderPdf already measures this to produce the PDF below, so
      // recording it costs nothing extra. This is the ONE place the real,
      // shipped page count is ever known: renderResumeWithFit above
      // deliberately measures a worst-case (all-candidate-skills-visible)
      // document that is never shipped (see its own comment), so its page
      // counts must never be reported as what the user actually receives.
      baselinePageCount = Number.isFinite(rendered.pageCount) ? rendered.pageCount : null;
      if (baselineFontsLoaded) resumePdfBytes = rendered.bytes;
      else baselinePdfError = 'Web fonts were unavailable while rendering the baseline résumé PDF.';
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      baselinePdfError = e?.message || String(e);
      logger.warn(`[JobApplication][${nodeId || '?'}] Safe baseline résumé PDF render failed — shipping recoverable HTML + listing only: ${baselinePdfError}`);
    }
    if (resumePdfBytes && isDualMode(variantAttrs)) {
      try {
        resumePdfBytes = await applyDualPdf(resumePdfBytes);
      } catch (e) {
        logger.warn(`[JobApplication][${nodeId || '?'}] OCG dual-mode post-process failed — shipping the plain baseline PDF instead: ${e?.message || e}`);
      }
    }
    // This render-only document uses the cover builder's native page surface.
    // It is never written or bundled as HTML: Application.html remains the
    // sole editable source, while this avoids tab/default-panel state leaking
    // into Chromium's print pipeline.
    try {
      const coverDocument = buildCoverLetterDocument({
        letter: coverLetter,
        variantAttrs,
        docId: `${resumeDocId}-cover-pdf`,
      });
      const rendered = await renderPdf(coverDocument, { signal });
      coverLetterFontsLoaded = rendered.fontsLoaded !== false;
      if (coverLetterFontsLoaded) coverLetterPdfBytes = rendered.bytes;
      else coverLetterPdfError = 'Web fonts were unavailable while rendering the cover-letter PDF.';
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      coverLetterPdfError = e?.message || String(e);
      logger.warn(`[JobApplication][${nodeId || '?'}] Cover-letter PDF render failed — shipping recoverable HTML + listing only: ${coverLetterPdfError}`);
    }
    if (coverLetterPdfBytes && isDualMode(variantAttrs)) {
      try {
        coverLetterPdfBytes = await applyDualPdf(coverLetterPdfBytes);
      } catch (e) {
        logger.warn(`[JobApplication][${nodeId || '?'}] Cover-letter OCG dual-mode post-process failed — shipping the plain cover-letter PDF instead: ${e?.message || e}`);
      }
    }
    // PDFs live as normal sibling files in the saved workspace. Keeping them
    // out of Application.html avoids duplicating large binaries and lets Sync
    // render only the document the user changed.
    const resumeDoc = buildApplicationDocument();

    // Capture raw output and both render phases for the bug reporter. The fit
    // loop is a layout measurement; `baselinePdfProduced` is the résumé PDF
    // written beside the editable application workspace. resumeSkillsDlSample
    // is pulled from `resumeDoc` (the FINAL document, already built above) so
    // it reflects the markup AFTER skill-opportunity injection ran, not the
    // model's pre-injection draft the head-slice sample below shows.
    const ledgerStats = freshlyMined?.stats || achievements?.stats || null;
    const minedBy = freshlyMined?.minedBy || achievements?.minedBy || null;
    updateAttempt({
      status: 'running',
      stage: 'writing application artifacts',
      stages: [...applicationAttempt.stages, { stage: 'writing application artifacts', ts: Date.now() }],
      nodeId: nodeId || null,
      jobTitle: job?.title || '',
      company: job?.company || '',
      coverLetter: {
        salutation: coverLetter?.salutation || '', recipient: coverLetter?.recipient || '',
        paragraphs: Array.isArray(coverLetter?.paragraphs) ? coverLetter.paragraphs : [],
        closing: coverLetter?.closing || '', signatureTitle: coverLetter?.signatureTitle || '',
        contact: Array.isArray(coverLetter?.contact) ? coverLetter.contact : [],
      },
      resumeHtmlSample: String(finalMainHtml || '').slice(0, 1500),
      resumeHtmlLen: String(finalMainHtml || '').length,
      resumeSkillsDlSample: extractSkillsDlSample(resumeDoc),
      variantAttrs,
      achievements: { source: ledgerSource, skipped: achievementsSkipped, kept: ledgerForPrompt?.ledger?.length || 0, stats: ledgerStats, minedBy },
      companyResearch: { available: companyResearch.available, error: companyResearch.error },
      skillOpportunities: {
        itemCount: Array.isArray(skillInsights?.items) ? skillInsights.items.length : 0,
        verifyCount: Array.isArray(skillInsights?.items) ? skillInsights.items.filter(item => item?.kind === 'verify').length : 0,
        learnCount: Array.isArray(skillInsights?.items) ? skillInsights.items.filter(item => item?.kind === 'learn').length : 0,
        histogramRoleCount: Array.isArray(skillHistogram?.roles) ? skillHistogram.roles.length : 0,
        error: skillOpportunityError,
        verifyItems: sanitizeSkillOpportunityVerifyItems(skillInsights?.items),
      },
      render: {
        targetPageCount, attempts: fitResult?.attempts || [],
        initialPageCount: fitResult?.attempts?.[0]?.pageCount ?? null,
        finalPageCount: fitResult?.pageCount ?? null,
        compactApplied: !!fitResult?.compactApplied, revisionApplied: !!fitResult?.revisionApplied,
        pdfProduced: !!resumePdfBytes, baselinePdfProduced: !!resumePdfBytes,
        baselinePageCount, baselinePdfError, baselineFontsLoaded,
        coverLetterPdfProduced: !!coverLetterPdfBytes, coverLetterPdfError, coverLetterFontsLoaded,
        resumeRequiresReview,
        error: fitResult ? (fitResult.renderError || null) : 'render/fit loop threw before producing any attempts',
        fontsLoaded: fitResult ? fitResult.fontsLoaded !== false : null,
      },
    });

    applicationAttempt.stage = 'writing application artifacts';
    applicationAttempt.stages = [...applicationAttempt.stages, { stage: 'writing application artifacts', ts: Date.now() }];
    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jobapp-out-'));
    const resumeHtmlPath = path.join(outDir, `application-${resumeDocId}.html`);
    // Keep the exact source-side job data alongside the editable résumé. The
    // stable filename lets save-application discover it even if an older
    // renderer has not yet been updated to pass jobListingPath explicitly.
    const jobListingPath = path.join(outDir, 'original-job-listing.md');
    await fs.promises.writeFile(resumeHtmlPath, resumeDoc, 'utf8');
    await fs.promises.writeFile(jobListingPath, jobMarkdown, 'utf8');

    // PDF companion — written next to the HTML, never in place of it (§5.1
    // still stands: HTML is the primary, editable artifact). null when
    // rendering failed for any reason; the caller (JobCardNode.jsx / the
    // renderer) must treat it as optional the same way it already treats a
    // failed résumé PDF as "generation still succeeded."
    let resumePdfPath = null;
    if (resumePdfBytes) {
      const candidatePath = path.join(outDir, `resume-${resumeDocId}.pdf`);
      try {
        await fs.promises.writeFile(candidatePath, resumePdfBytes);
        resumePdfPath = candidatePath;
      } catch (e) {
        logger.warn(`[JobApplication][${nodeId || '?'}] Could not write résumé PDF to disk — continuing with HTML only: ${e?.message || e}`);
      }
    }
    let coverLetterPdfPath = null;
    if (coverLetterPdfBytes) {
      const candidatePath = path.join(outDir, `cover-letter-${resumeDocId}.pdf`);
      try {
        await fs.promises.writeFile(candidatePath, coverLetterPdfBytes);
        coverLetterPdfPath = candidatePath;
      } catch (e) {
        logger.warn(`[JobApplication][${nodeId || '?'}] Could not write cover-letter PDF to disk — continuing with HTML only: ${e?.message || e}`);
      }
    }

    // Count demand only after the application has real, readable artifacts.
    // The previous placement persisted immediately after the analysis call, so
    // a later résumé/cover/render/write failure inflated the histogram with an
    // application the user never received.
    markStage('recording skill-demand analysis');
    if (skillAnalysisReady) {
      try {
        skillHistogram = await withSkillOpportunityLock(
          async () => recordSkillOpportunityAnalysis(skillInsights),
          signal,
        );
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        skillOpportunityError = String(e?.message || e).slice(0, 300);
        logger.warn(`[JobApplication][${nodeId || '?'}] Application built, but skill-opportunity demand could not be recorded: ${skillOpportunityError}`);
      }
    }
    if (lastApplication?.attemptId === attemptId && lastApplication.skillOpportunities) {
      updateAttempt({
        skillOpportunities: {
          ...lastApplication.skillOpportunities,
          histogramRoleCount: Array.isArray(skillHistogram?.roles) ? skillHistogram.roles.length : 0,
          error: skillOpportunityError,
          recordedAfterArtifacts: skillAnalysisReady && !skillOpportunityError,
        },
      });
    }

    pendingApplicationArtifacts.set(path.resolve(outDir), {
      senderId: event.sender.id,
      company: job?.company || '',
      candidateName,
      resumeHtmlPath: path.resolve(resumeHtmlPath),
      resumePdfPath: resumePdfPath ? path.resolve(resumePdfPath) : null,
      coverLetterPdfPath: coverLetterPdfPath ? path.resolve(coverLetterPdfPath) : null,
      jobListingPath: path.resolve(jobListingPath),
    });
    logger.info(`[JobApplication][${nodeId || '?'}] Built application HTML for ${company}${resumePdfPath && coverLetterPdfPath ? ' (+ résumé and cover-letter PDFs)' : ' (one or more PDFs unavailable — see log above)'}`);
    updateAttempt({
      status: 'completed',
      stage: 'completed',
      stages: [...applicationAttempt.stages, { stage: 'completed', ts: Date.now() }],
      finishedAt: Date.now(),
    });
    return {
      resumeHtmlPath,
      resumePdfPath,
      coverLetterPdfPath,
      jobListingPath,
      workDir: outDir,
      company: job?.company || '',
      candidateName,
      achievements: freshlyMined, // a NEWLY mined ledger for the renderer to cache on the hub, or null
      achievementsSkipped,
      resumeRequiresReview,
      skillOpportunityError,
    };
    } catch (error) {
      const cancelled = signal?.aborted || error?.name === 'AbortError';
      updateAttempt({
        status: cancelled ? 'cancelled' : 'failed',
        stage: applicationAttempt.stage,
        failedStage: applicationAttempt.stage,
        stages: [...applicationAttempt.stages, { stage: cancelled ? 'cancelled' : 'failed', ts: Date.now() }],
        error: diagnosticError(error),
        finishedAt: Date.now(),
      });
      throw error;
    }
  });

  // A card may be deleted after generation has produced a registered temp
  // workspace but before the renderer can save it.  Dispose of that exact
  // sender-owned workspace without accepting arbitrary filesystem paths.
  handleSafe('discard-application', async (event, { workDir } = {}) => {
    const { resolvedWorkDir, pending } = resolvePendingApplicationWorkspaceForOwner(
      workDir, pendingApplicationArtifacts, event.sender.id,
    );
    await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'renderer discard');
    logger.info('[JobApplication] Discarded generated application workspace before save');
    return { discarded: true };
  });

  // Write the generated documents into
  // "Applied Jobs/<company>/<location>/<job>" next to the SAVED canvas file,
  // then open that folder in Finder. No picker — the location is deterministic
  // so the user's applications stay organized with the project. Cleans up the
  // temp working directory afterward.
  handleSafe('save-application', async (event, { resumeHtmlPath, resumePdfPath, coverLetterPdfPath, jobListingPath, workDir, jobTitle, location, canvasFilePath }) => {
    const { resolvedWorkDir, pending } = resolvePendingApplicationWorkspaceForOwner(
      workDir, pendingApplicationArtifacts, event.sender.id,
    );
    const matchesPending = path.resolve(String(resumeHtmlPath || '')) === pending.resumeHtmlPath
      && path.resolve(String(jobListingPath || '')) === pending.jobListingPath
      && (resumePdfPath ? path.resolve(resumePdfPath) : null) === pending.resumePdfPath
      && (coverLetterPdfPath ? path.resolve(coverLetterPdfPath) : null) === pending.coverLetterPdfPath;
    if (!matchesPending) {
      throw new Error('Generated application paths did not match this generation session — please regenerate.');
    }
    resumeHtmlPath = pending.resumeHtmlPath;
    resumePdfPath = pending.resumePdfPath;
    coverLetterPdfPath = pending.coverLetterPdfPath;
    jobListingPath = pending.jobListingPath;
    const company = pending.company;
    try {
    if (!fs.existsSync(resumeHtmlPath)) {
      throw new Error('Generated application files are no longer available — please regenerate.');
    }
    // The destination is relative to the canvas JSON, so it must be saved first.
    if (!canvasFilePath || typeof canvasFilePath !== 'string') {
      throw new Error('Save your canvas to a file first — applications are written to an "Applied Jobs" folder next to your saved canvas.');
    }

    const where = sanitizeFilePart(company, 'Company');
    // Location is a hard part of job identity (§6.3) but here it's just a path
    // segment — a missing/unresolvable value degrades to a sane folder name
    // rather than collapsing the path (e.g. "Company//Role" if left empty).
    const whereLocation = sanitizeFilePart(location, 'Unknown Location');
    const role = sanitizeFilePart(jobTitle, 'Role');
    const appliedJobsDir = path.resolve(path.dirname(canvasFilePath), 'Applied Jobs');
    const dir = path.resolve(appliedJobsDir, where, whereLocation, role);
    const relativeDir = path.relative(appliedJobsDir, dir);
    if (relativeDir.startsWith('..') || path.isAbsolute(relativeDir)) {
      throw new Error('Application destination escaped the Applied Jobs directory.');
    }
    await fs.promises.mkdir(dir, { recursive: true });

    const listingSource = jobListingPath || (workDir ? path.join(workDir, 'original-job-listing.md') : '');
    const hasPdf = !!resumePdfPath && fs.existsSync(resumePdfPath);
    const hasCoverLetterPdf = !!coverLetterPdfPath && fs.existsSync(coverLetterPdfPath);
    const hasListing = !!listingSource && fs.existsSync(listingSource);
    const sync = await registerApplicationSyncWorkspace(dir);
    const applicationFile = path.join(dir, 'Application.html');
    const resumeFile = path.join(dir, 'Resume.pdf');
    const coverLetterFile = path.join(dir, 'Cover Letter.pdf');
    const jobListingFile = path.join(dir, 'Original Job Listing.md');
    const generatedHtml = embedApplicationSyncConfig(await fs.promises.readFile(resumeHtmlPath, 'utf8'), sync);

    // The workspace is deliberately unzipped and predictable. Every file gets
    // an atomic same-directory replacement, so a failed write never leaves a
    // truncated HTML/PDF/listing artifact in the company folder.
    await replaceFileAtomically(applicationFile, generatedHtml);
    if (hasPdf) await copyFileAtomically(resumePdfPath, resumeFile);
    if (hasCoverLetterPdf) await copyFileAtomically(coverLetterPdfPath, coverLetterFile);
    if (hasListing) await copyFileAtomically(listingSource, jobListingFile);
    const missingFiles = [!hasPdf && 'résumé PDF', !hasCoverLetterPdf && 'cover-letter PDF', !hasListing && 'original job listing'].filter(Boolean);
    const bundleError = missingFiles.length ? `Saved the editable workspace, but the ${missingFiles.join(', ')} was unavailable.` : null;
    if (bundleError) logger.warn(`[JobApplication] ${bundleError}`);

    // Clean up the temp output dir now that the files are safely copied out.
    await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'successful save');

    // Open the destination folder in a Finder/Explorer window.
    const openErr = await shell.openPath(dir);
    if (openErr) logger.warn(`[JobApplication] Could not open ${dir}: ${openErr}`);

    logger.info(`[JobApplication] Saved unzipped application workspace to ${dir}`);
    return {
      saved: true,
      dir,
      applicationFile,
      resumeFile: hasPdf ? resumeFile : null,
      coverLetterFile: hasCoverLetterPdf ? coverLetterFile : null,
      jobListingFile: hasListing ? jobListingFile : null,
      bundleError,
    };
    } catch (error) {
      // There is no retry UI for a failed save.  Once the trusted source files
      // cannot be saved, remove their registered temp workspace rather than
      // retaining it indefinitely.  Validation failures above this try block
      // deliberately do not discard anything, so a malformed IPC request can
      // never erase a valid session it does not own.
      await discardPendingApplicationArtifacts(resolvedWorkDir, pending, 'terminal save failure');
      throw error;
    }
  });
}
