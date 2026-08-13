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
 *   4. document build     — buildResumeDocument / buildCoverLetterDocument
 *      (resumeHtml.js) turn those into two self-contained HTML files.
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
 * generate-application returns the temp HTML paths as resumeHtmlPath /
 * coverHtmlPath, plus resumePdfPath (the fit-loop's PDF companion — null
 * when rendering failed for any reason). save-application then writes those
 * files into an
 * "Applied Jobs/<company>/<location>/<job>" folder next to the saved canvas
 * and opens that folder in Finder — no picker.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import electronPkg from 'electron';
import { handleSafe } from './ipcUtils.js';
import { callLLMRaw, callLLMText } from './llm.js';
import { APPLICATION_COVER_LETTER_SCHEMA, ACHIEVEMENT_LEDGER_SCHEMA, ACHIEVEMENT_REFUTE_SCHEMA } from './aiSchemas.js';
import { buildResumeDocument, buildCoverLetterDocument, extractVariantAttrs, isDualMode, getDesignSystemDir } from './resumeHtml.js';
import { renderPdf, applyDualPdf } from './resumeRender.js';
import { primeClaudeModels } from './modelResolver.js';
import {
  LEDGER_VERSION, MINING_TARGET, computeLedger, applyRefuteVerdicts, serializeLedgerForPrompt,
} from '../../src/utils/achievementLedger.js';
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

STANDARD — be GENEROUS, not strict, except on one thing:
- Be generous with fair inference: "worked on a Django web app" may fairly claim ORM / migrations / admin-panel familiarity even though the corpus never uses those words. Extend the same generosity to what COUNTS as an accomplishment — a real but modest join is still worth surfacing, not just the dramatic ones.
- Be STRICT only about the join itself being real: every endpoint must trace to an actual quote in the CAREER DATA, and the reasoning connecting the facts must hold up. Never invent an endpoint, a date, or a connection that isn't actually there.
- The costs are asymmetric: an over-claimed line is visible and gets caught on a human's review pass; an accomplishment you failed to mine is invisible and simply never happens for this candidate. Optimize against the visible failure, not the invisible one.

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
- You MAY make FAIR INFERENCES, and be GENEROUS about it: surface any skill, capability, or accomplishment a reasonable recruiter would confidently read from demonstrated experience — not just adjacent tools (shipped production REST APIs → comfortable with HTTP/JSON and API design; led a 5-person team → people management; heavy PostgreSQL use → SQL generally), but also scope, scale, and outcomes a reasonable reader would infer from the work described. Costs here are asymmetric: an inference that reads as slightly generous gets caught on a quick review and costs nothing; an accomplishment you under-claimed is invisible and simply never happened for this application. The inference must still be a defensible read of real work, never a brand-new tool, credential, employer, or FIGURE the data can't back up (figures come only from the CAREER DATA or the ACHIEVEMENT LEDGER — never invented).
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
async function generateResumeMain({ careerData, job, research, ledger }, signal) {
  const cachedPrefix = buildResumeCachedPrefix({ careerData, ledger });
  const prompt = `TARGET JOB (the "Description" is what we scraped — it may be full, partial, or empty):
${jobBlock(job)}

COMPANY & ROLE CONTEXT (live web research — always covers the company, and the role too when the scraped Description was thin). Combine it with the scraped Description above for the full picture, and tailor emphasis, ordering, and keywords to it:
"""
${research}
"""

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
async function renderResumeWithFit({ careerData, ledger, resumeMainHtml, docId, targetPageCount }, signal) {
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
    const doc = buildResumeDocument({ resumeMainHtml: mainHtml, variantAttrs, ledger: ledgerArray, docId });

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
async function generateCoverLetterFields({ careerData, job, research, ledger }, signal) {
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
  const cachedPrefix = `Write a tailored cover letter for a candidate applying to a job. Return JSON matching the provided schema, grounded in the CAREER DATA below and the target job + research provided at the end.

CAREER DATA (use ONLY facts found here for the candidate's name, contact, and evidence):
"""
${careerData}
"""

WRITING RULES:
- 3-4 body paragraphs. Each ties SPECIFIC career-data evidence to SPECIFIC job requirements, and references a genuine detail from the research (a product, a value, or a recent development).
- Authentic, specific, and concise — not a generic template. Ground every claim in the career data: never invent employers, titles, dates, or numbers — with ONE exception: a figure drawn from the ACHIEVEMENT LEDGER below is already verified and computed by code FROM the candidate's own career data, not invented. You MAY make fair inferences, generously, from demonstrated experience (a capability or accomplishment a recruiter would confidently read from real work, not a new credential or an invented figure) and frame the candidate's genuine accomplishments in the job's language to connect the dots for the reader.
- NO RECEIPTS here — unlike the résumé, this document's paragraphs are plain prose with nowhere to hang a machine-readable attribute, so any ledger figure you use is stated as unadorned text.
- A ledger item with attribution 'context' describes something that happened during the candidate's tenure, not necessarily because of them — phrase it as context, never as a personal win.
- Pull "name", "tagline", and "contact" (location, email, phone, one URL) from the career data; omit any contact item not present.${ledgerSection}${rubricSection}`;

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
// last-one-wins, never persisted (the HTML files already are). Also carries the
// achievement-ledger telemetry (mined/reused/unavailable, stats, resolved
// models) so a report shows whether the feature ran at all and what it did.
let lastApplication = null;
export function getApplicationTelemetry() {
  return lastApplication;
}
function recordApplicationTelemetry(data) {
  lastApplication = { ts: Date.now(), ...data };
}

export function registerJobApplicationHandlers() {
  // Generate the tailored résumé + cover letter HTML documents. Returns temp
  // paths; save-application then copies them to a user-chosen folder.
  handleSafe('generate-application', async (event, { job, careerData, nodeId, achievements, mineAllowed, targetPageCount: targetPageCountOverride }, signal) => {
    const company = job?.company || 'this company';
    logger.info(`[JobApplication][${nodeId || '?'}] Generating application for ${job?.title} @ ${company}`);

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
    const resumeMainHtml = await generateResumeMain({ careerData, job, research, ledger: ledgerForPrompt }, signal);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const coverLetter = await generateCoverLetterFields({ careerData, job, research, ledger: ledgerForPrompt }, signal);
    if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });

    // 4. Local render → page-count → fit loop (SKILL.md §5). Runs on the
    //    RAW model markup — docId is generated now (not after the loop) since
    //    it's baked into the rendered document at every attempt (keys the
    //    contenteditable autosave, §5.5) and must stay the same across
    //    attempts for the same application. This can NEVER block generation:
    //    renderResumeWithFit itself already degrades render failures to
    //    `pdfBytes: null` internally (§4), and this try/catch is a second,
    //    outer safety net for anything unexpected in the loop's own
    //    orchestration (a bug here must still ship the HTML the model wrote).
    const resumeDocId = crypto.randomUUID();
    const coverDocId = crypto.randomUUID();
    const targetPageCount = Number.isFinite(targetPageCountOverride) && targetPageCountOverride > 0
      ? targetPageCountOverride
      : targetPageCountForJob(job?.title);

    let fitResult = null;
    try {
      fitResult = await renderResumeWithFit({
        // The WRAPPED { ledger, gaps } shape — same value generateResumeMain
        // was called with — NOT the bare array (see renderResumeWithFit's
        // @param note: it needs the wrapped shape to reproduce the
        // byte-identical cached prefix on a length-revision call).
        careerData, ledger: ledgerForPrompt, resumeMainHtml,
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

    // 5. Dual-mode OCG post-process (SKILL.md §5 step 6) — ONLY for the
    //    dual-pdf variant, and only when a PDF actually rendered. A failure
    //    here degrades to shipping the PLAIN rendered PDF (no cream layer,
    //    same as the ink-only variant's output) rather than no PDF at all —
    //    the cosmetic dual-state layer is not worth losing the whole PDF over.
    let resumePdfBytes = fitResult?.pdfBytes || null;
    if (resumePdfBytes && isDualMode(variantAttrs)) {
      try {
        resumePdfBytes = await applyDualPdf(resumePdfBytes);
      } catch (e) {
        logger.warn(`[JobApplication][${nodeId || '?'}] OCG dual-mode post-process failed — shipping the plain (non-dual) PDF instead: ${e?.message || e}`);
      }
    }

    // Capture the raw model output + render telemetry BEFORE building the
    // documents, so a build failure still leaves them visible in a bug report
    // (the prose is where newline/escape bugs live; the render attempts are
    // where page-fit bugs live). Stored verbatim — the reporter stringifies
    // for inspection. Ledger stats are recorded regardless of outcome
    // (reused/mined/unavailable) so a report shows whether the feature ran at all.
    const ledgerStats = freshlyMined?.stats || achievements?.stats || null;
    const minedBy = freshlyMined?.minedBy || achievements?.minedBy || null;
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
      resumeHtmlSample: String(finalMainHtml || '').slice(0, 1500),
      resumeHtmlLen:    String(finalMainHtml || '').length,
      achievements: {
        source: ledgerSource,
        skipped: achievementsSkipped,
        kept: ledgerForPrompt?.ledger?.length || 0,
        stats: ledgerStats,
        minedBy,
      },
      render: {
        targetPageCount,
        attempts: fitResult?.attempts || [],
        initialPageCount: fitResult?.attempts?.[0]?.pageCount ?? null,
        finalPageCount: fitResult?.pageCount ?? null,
        compactApplied: !!fitResult?.compactApplied,
        revisionApplied: !!fitResult?.revisionApplied,
        pdfProduced: !!resumePdfBytes,
        error: fitResult ? (fitResult.renderError || null) : 'render/fit loop threw before producing any attempts',
        // Distinguishes "no PDF because rendering broke" from "no PDF because
        // the design system's Google Fonts CDN import was unreachable" — the
        // two share the same pdfProduced:false/error:null shape otherwise, so
        // without this a bug report can't tell a render bug from a network
        // condition (offline/proxy/ad-blocker) that resolved on its own.
        fontsLoaded: fitResult ? fitResult.fontsLoaded !== false : null,
      },
    });

    // 6. Build the two self-contained HTML documents. HTML-first output
    //    (design §5) — buildResumeDocument / buildCoverLetterDocument
    //    (resumeHtml.js) own the scaffold, inlined CSS, and injected chrome.
    //    `ledger` is passed to the résumé builder so its post-process can
    //    resolve each `data-achievement-id` receipt against the SAME ledger
    //    the model was shown (§4.3) — the cover letter carries no ledger
    //    since it emits no receipts (§4.4). `docId` keys the contenteditable
    //    autosave (§5.5) — the SAME id used in the render loop above, so the
    //    shipped HTML and the measured PDF are the same document.
    const resumeDoc = buildResumeDocument({ resumeMainHtml: finalMainHtml, variantAttrs, ledger: ledgerForPrompt?.ledger || null, docId: resumeDocId });
    const coverDoc = buildCoverLetterDocument({ letter: coverLetter, variantAttrs, docId: coverDocId });

    const outDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'jobapp-out-'));
    const resumeHtmlPath = path.join(outDir, `resume-${resumeDocId}.html`);
    const coverHtmlPath = path.join(outDir, `cover-${coverDocId}.html`);
    await fs.promises.writeFile(resumeHtmlPath, resumeDoc, 'utf8');
    await fs.promises.writeFile(coverHtmlPath, coverDoc, 'utf8');

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

    const candidateName = coverLetter?.name || '';
    logger.info(`[JobApplication][${nodeId || '?'}] Built application HTML for ${company}${resumePdfPath ? ' (+ PDF)' : ' (PDF unavailable — see log above)'}`);
    return {
      resumeHtmlPath,
      coverHtmlPath,
      resumePdfPath,
      workDir: outDir,
      company: job?.company || '',
      candidateName,
      achievements: freshlyMined, // a NEWLY mined ledger for the renderer to cache on the hub, or null
      achievementsSkipped,
    };
  });

  // Write the generated documents into
  // "Applied Jobs/<company>/<location>/<job>" next to the SAVED canvas file,
  // then open that folder in Finder. No picker — the location is deterministic
  // so the user's applications stay organized with the project. Cleans up the
  // temp working directory afterward.
  handleSafe('save-application', async (event, { resumeHtmlPath, coverHtmlPath, resumePdfPath, workDir, company, candidateName, jobTitle, location, canvasFilePath }) => {
    if (!resumeHtmlPath || !coverHtmlPath) throw new Error('Missing generated application file paths.');
    if (!fs.existsSync(resumeHtmlPath) || !fs.existsSync(coverHtmlPath)) {
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
    const dir = path.join(path.dirname(canvasFilePath), 'Applied Jobs', where, whereLocation, role);
    await fs.promises.mkdir(dir, { recursive: true });

    // Folder already encodes company + location + role, so the files only carry
    // the candidate's name (useful once a recruiter detaches them from the folder).
    const who = sanitizeFilePart(candidateName, 'Application');
    const resumeFile = await copyUnique(resumeHtmlPath, dir, `${who} - Resume.html`);
    const coverFile  = await copyUnique(coverHtmlPath, dir, `${who} - Cover Letter.html`);

    // The PDF companion (electron/ipc/resumeRender.js + jobApplication.js's
    // render/fit loop) is OPTIONAL — rendering can fail for reasons that never
    // touch the HTML (no display, printToPDF throwing, pdf-lib rejecting), and
    // per that loop's robustness rule a missing PDF must never block saving
    // the HTML the user actually needs. fs.existsSync also guards the rarer
    // case of workDir having been cleaned up by something else between
    // generate and save (save-application is a separate IPC call — nothing
    // enforces it runs before another cleanup path could touch the same dir).
    let resumePdfFile = null;
    if (resumePdfPath && fs.existsSync(resumePdfPath)) {
      resumePdfFile = await copyUnique(resumePdfPath, dir, `${who} - Resume.pdf`);
    }

    // Clean up the temp output dir now that the files are safely copied out.
    if (workDir) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }

    // Open the destination folder in a Finder/Explorer window.
    const openErr = await shell.openPath(dir);
    if (openErr) logger.warn(`[JobApplication] Could not open ${dir}: ${openErr}`);

    logger.info(`[JobApplication] Saved application to ${dir}${resumePdfFile ? ' (+ PDF)' : ''}`);
    return { saved: true, dir, resumeFile, coverFile, resumePdfFile };
  });
}
