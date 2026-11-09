#!/usr/bin/env node
// Side-by-side measurement of three web-research arms on the app's two web-research
// tasks: Claude's built-in web search (native), the Tavily MCP server (tavily), and a
// merged answer that reuses both replies without any extra research call. Prompts,
// profiles and validators are the app's own; only the tools differ. The Tavily key is
// read from the Keychain and never printed or written.
//
//   node --import ./scripts/test-stubs/register.mjs scripts/web-research-ab.mjs \
//     --task preference|compensation --canvas "<canvas.json>" --out <private dir> \
//     [--count N] [--seed 1] [--concurrency 3] [--ultracode on|off] [--dry-run]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const PREFERENCE_TASK = 'job-preference-research-batch';
const PREFERENCE_ASSESSMENT_TASK = 'job-preference-research-batch-assessment';
const COMPENSATION_TASK = 'job-compensation-research-batch';
const RESEARCH_MAX_TURNS = 16;
const TAVILY_EXTRACT_URL = 'https://api.tavily.com/extract';
const EXTRACT_BATCH = 10;
const ARMS = Object.freeze(['native', 'tavily', 'merged']);
const CANADIAN_MENTION = /canada|ontario|toronto|ottawa|kanata|waterloo|vancouver|burnaby|british columbia|montreal|quebec|calgary|alberta/iu;
const US_STATE_AFTER_COMMA = /,\s*(?:AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY)\b/u;
const US_MENTION = /united states/iu;
const US_ABBREVIATION = /\bUSA\b|\bUS\b/u;
const EXPERIENCE_BAND_BASIS = 'Use comparable salaries for the listing role and seniority. No published years-to-level ladder was established; do not infer candidate tenure or invent numerical experience bands.';
const ipc = rel => import(new URL(`../electron/ipc/${rel}`, import.meta.url).href);

const preferenceBegin = id => `BEGIN RESEARCH ${id}`;
const preferenceEnd = id => `END RESEARCH ${id}`;
const compensationBegin = id => `BEGIN COMPENSATION RESEARCH ${id}`;
const compensationEnd = id => `END COMPENSATION RESEARCH ${id}`;

function options(argv) {
  const { values } = parseNodeArgs({ args: argv, options: {
    task: { type: 'string' }, canvas: { type: 'string' }, out: { type: 'string' }, count: { type: 'string' },
    seed: { type: 'string', default: '1' }, concurrency: { type: 'string', default: '3' }, 'dry-run': { type: 'boolean', default: false },
    ultracode: { type: 'string', default: 'on' },
  } });
  const task = String(values.task ?? '');
  if (task !== 'preference' && task !== 'compensation') throw new Error('--task must be preference or compensation.');
  const ultracode = String(values.ultracode ?? 'on');
  if (ultracode !== 'on' && ultracode !== 'off') throw new Error('--ultracode must be on or off.');
  if (!values.canvas || !values.out) throw new Error('--canvas and --out are required.');
  const int = (name, raw, min) => { const n = Number(raw); if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`); return n; };
  return {
    task, canvas: values.canvas, out: path.resolve(values.out), count: int('count', values.count ?? (task === 'preference' ? '20' : '8'), 1),
    seed: int('seed', values.seed, 0), concurrency: int('concurrency', values.concurrency, 1), dryRun: values['dry-run'] === true,
    ultracode: ultracode === 'on',
  };
}

const redactWith = key => text => (key && key !== 'dry-run-no-key' ? String(text ?? '').split(key).join('<tavily-key>') : String(text ?? ''));

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(list, count, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy.slice(0, Math.max(0, count));
}

// ---- Pure helpers (unit-tested) --------------------------------------------

const markerLines = (text, marker) => String(text ?? '').replace(/\r\n?/gu, '\n').split('\n').filter(line => line.trim() === marker);

/** The body between one id's marker lines in one reply, or null when the reply lacks that section. */
function sectionBody(text, id, begin, end) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.replace(/\r\n?/gu, '\n').split('\n');
  const from = lines.findIndex(line => line.trim() === String(begin(id)).trim());
  if (from < 0) return null;
  const tail = String(end(id)).trim();
  const to = lines.findIndex((line, index) => index > from && line.trim() === tail);
  const body = to < 0 ? '' : lines.slice(from + 1, to).join('\n').trim();
  return body || null;
}

/**
 * Combine the native and Tavily replies per section id. Ids are matched by exact
 * marker lines, so an id that prefixes another (c1 / c10) never picks up its
 * neighbour's body. Ids with no body in either reply are dropped; null when the
 * merge produced nothing.
 */
export function mergeSectionReplies({ ids = [], replies = {}, begin, end } = {}) {
  const sections = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    const native = sectionBody(replies?.native, id, begin, end);
    const tavily = sectionBody(replies?.tavily, id, begin, end);
    const body = native && tavily ? `SOURCE SET A (built-in web search):\n${native}\n\nSOURCE SET B (Tavily search):\n${tavily}` : native || tavily;
    if (body) sections.push(`${begin(id)}\n${body}\n${end(id)}`);
  }
  return sections.length ? sections.join('\n') : null;
}

/** Unique http(s) URLs in order, with trailing punctuation and markdown wrappers removed. */
export function extractSectionUrls(body) {
  const urls = [];
  for (const match of String(body ?? '').matchAll(/https?:\/\/[^\s<>]+/gu)) {
    let url = match[0];
    while (url.length) {
      const last = url.at(-1);
      // A ')' that closes a '(' inside the URL belongs to the URL; one that only wraps a markdown link does not.
      if (last === ')') {
        const balanced = (url.match(/\(/gu) || []).length >= (url.match(/\)/gu) || []).length;
        if (balanced) break;
        url = url.slice(0, -1);
        continue;
      }
      if (!').,;]>"\''.includes(last)) break;
      url = url.slice(0, -1);
    }
    if (/^https?:\/\/[^/]/u.test(url) && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

const MONEY_TOKEN = /(CA\$|C\$|US\$|A\$|NZ\$|AU\$|\$|USD|CAD|AUD)?\s*(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s*[kK])?/gu;

/** Blocks separated by blank lines or by a line that starts a new bullet or numbered item. */
function blocksOf(text) {
  const blocks = [];
  let current = [];
  let blank = false;
  const flush = () => { if (current.length) blocks.push(current.join('\n')); current = []; };
  // One block per top-level source item: an unindented bullet, numbered item, heading or bold lead-in
  // starts a new block, and its indented sub-points (URL, figures, quote, date) stay with it.
  for (const line of String(text ?? '').replace(/\r\n?/gu, '\n').split('\n')) {
    if (!line.trim()) { blank = true; continue; }
    // After a blank line an unindented line is a new paragraph; an indented one still belongs to the item.
    if ((blank && !/^[ \t]/u.test(line)) || /^(?:[-*]\s|\d+[.)]\s|#|\*\*|\|)/u.test(line)) flush();
    blank = false;
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * Money figures written in the same paragraph or bullet block as a URL, each
 * normalized to an integer. 1900-2100 written without separators or currency is
 * a year, not a figure.
 */
/** Text with every URL and markdown link target blanked out. */
export const withoutLinks = text => String(text ?? '').replace(/\]\([^)\s]*\)/gu, '] ').replace(/https?:\/\/[^\s)\]>"']+/gu, ' ');

export function moneyFiguresNear(body, url) {
  const figures = [];
  if (!url) return figures;
  for (const block of blocksOf(body)) {
    if (!block.includes(String(url))) continue;
    // Digits inside links (Payscale's '/Salary/19749aa3/') are not salary figures.
    for (const [, currency, digits, thousands] of withoutLinks(block).matchAll(MONEY_TOKEN)) {
      const numeric = Number(String(digits).replace(/,/gu, ''));
      const value = Number.isFinite(numeric) ? Math.round(numeric * (thousands ? 1000 : 1)) : 0;
      if (value < 1000) continue;
      if (!currency && !thousands && !String(digits).includes(',') && value >= 1900 && value <= 2100) continue;
      if (!figures.includes(value)) figures.push(value);
    }
  }
  return figures;
}

const escapeRegExp = text => String(text).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** True when the page text states that figure in any common spelling, with digit boundaries. */
export function pageHasFigure(pageText, figure) {
  const value = Math.round(Number(figure));
  const text = withoutLinks(pageText);
  if (!text.trim() || !Number.isFinite(value) || value < 1000) return false;
  const plain = String(value);
  const spellings = new Set([plain, plain.replace(/\B(?=(\d{3})+(?!\d))/gu, ','), plain.replace(/\B(?=(\d{3})+(?!\d))/gu, ' ')]);
  for (const suffix of ['k', 'K']) {
    if (value % 1000 === 0) { spellings.add(`${value / 1000}${suffix}`); spellings.add(`${value / 1000}.0${suffix}`); }
    else if (value % 100 === 0) spellings.add(`${(value / 1000).toFixed(1)}${suffix}`);
  }
  for (const spelling of spellings) if (new RegExp(`(?<![\\d.,])${escapeRegExp(spelling)}(?![\\d]|[.,]\\d)`, 'u').test(text)) return true;
  return false;
}

/** The research-parameters object the app sends for a board row's compensation cohort. */
export function compensationParameters(row) {
  const context = row?.compensationContext && typeof row.compensationContext === 'object' ? row.compensationContext : {};
  const location = typeof row?.location === 'string' ? row.location : String(row?.location?.display || row?.location?.label || '');
  const targetCurrency = CANADIAN_MENTION.test(location) ? 'CAD'
    : US_MENTION.test(location) || US_ABBREVIATION.test(location) || US_STATE_AFTER_COMMA.test(location) ? 'USD' : 'CAD';
  return {
    roleFamily: context.roleFamily || row?.title || '', seniority: context.seniority || 'unspecified',
    experienceBand: 'listing role level', experienceBandBasis: EXPERIENCE_BAND_BASIS,
    employmentType: context.employmentType || 'unspecified', workLocationOrRemoteResidence: row?.location ?? location, targetCurrency,
  };
}

/** One cohort identity: role family, seniority, employment type, location and currency. */
export function cohortKey(row) {
  const parameters = compensationParameters(row);
  return JSON.stringify([parameters.roleFamily, parameters.seniority, parameters.employmentType,
    parameters.workLocationOrRemoteResidence, parameters.targetCurrency]).toLowerCase();
}

const researchIdsInPrompt = prompt => {
  const ids = [];
  for (const match of String(prompt ?? '').matchAll(/"researchId"\s*:\s*"([^"]+)"/gu)) if (!ids.includes(match[1])) ids.push(match[1]);
  return ids;
};
const researchIdsInReplies = (texts, begin) => {
  const ids = [];
  for (const text of texts) for (const line of String(text ?? '').split('\n')) {
    const match = line.trim().match(/^BEGIN (?:COMPENSATION )?RESEARCH ([a-z0-9-]+)$/u);
    if (match && !ids.includes(match[1]) && markerLines(text, begin(match[1])).length) ids.push(match[1]);
  }
  return ids;
};

// ---- Run plumbing ----------------------------------------------------------

function writers(outDir, redact) {
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const resultsPath = path.join(outDir, 'results.jsonl');
  fs.writeFileSync(resultsPath, '', { mode: 0o600 });
  return {
    resultsPath,
    row: record => fs.appendFileSync(resultsPath, `${redact(JSON.stringify(record))}\n`),
    json: (name, value) => fs.writeFileSync(path.join(outDir, name), `${redact(JSON.stringify(value, null, 2))}\n`, { mode: 0o600 }),
    text: (name, value) => fs.writeFileSync(path.join(outDir, name), redact(value), { mode: 0o600 }),
  };
}

const sum = (list, read) => list.reduce((total, item) => total + (Number(read(item)) || 0), 0);
const average = (list, read) => (list.length ? Math.round(sum(list, read) / list.length / 100) / 10 : null);
const toolTotals = calls => calls.reduce((all, call) => { for (const [tool, n] of Object.entries(call.toolCalls || {})) all[tool] = (all[tool] || 0) + n; return all; }, {});
const toolCallsOf = (toolCalls, webTools) => (webTools && typeof webTools === 'object' && !Object.keys(toolCalls).length
  ? Object.fromEntries(Object.entries(webTools).filter(([, value]) => typeof value === 'number')) : toolCalls);

/**
 * One research call per (arm, prompt). The merged arm never researches: it waits
 * for the cached native and Tavily replies and merges their sections.
 */
function createResearcher({ app, profile, stage, tavily, tavilyKey, task, begin, end, parse, limit, calls, cacheDir = '' }) {
  const cache = new Map();
  // Valid replies are also kept on disk, so a rerun after a later failure never pays for the same research twice.
  const diskPath = (arm, prompt) => (cacheDir ? path.join(cacheDir, `${crypto.createHash('sha256').update(`${arm}\u0000${prompt}`, 'utf8').digest('hex').slice(0, 32)}.txt`) : '');
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const nativeTools = profile?.tools ? String(profile.tools).split(',').filter(Boolean) : [];

  async function once(arm, prompt, ids) {
    const key = `${arm}\u0000${prompt}`;
    if (cache.has(key)) return cache.get(key);
    const pending = (async () => {
      const cached = app.cachedPromptParts(app.materializeNonApiPrompt({ prompt, cachedPrefix: '', task, grounding: true }), '');
      const toolCalls = {};
      const started = Date.now();
      const record = { task, arm, promptChars: prompt.length, sections: ids.length, costUsd: null, toolCalls };
      let text = null;
      const saved = diskPath(arm, prompt);
      if (saved && fs.existsSync(saved)) {
        try {
          const savedText = fs.readFileSync(saved, 'utf8');
          parse(savedText, ids);
          Object.assign(record, { valid: true, reused: true, durationMs: 0 });
          calls.push(record);
          return savedText;
        } catch { /* an unusable saved reply is researched again */ }
      }
      try {
        const reply = await limit(() => app.runClaudeSdkStage({
          ...stage, ...cached, env: cached.systemAppend ? stage.env : { ...stage.env, DISABLE_PROMPT_CACHING: '1' },
          pageImages: [], model: profile.model, effort: profile.effort, persistSession: false, maxTurns: RESEARCH_MAX_TURNS,
          tools: arm === 'tavily' ? [...tavily.TAVILY_RESEARCH_TOOLS] : nativeTools,
          mcpServers: arm === 'tavily' ? tavily.tavilyMcpServers(tavilyKey) : {},
          onActivity: event => { if (event?.kind === 'tool') for (const call of event.calls || []) toolCalls[call.tool] = (toolCalls[call.tool] || 0) + 1; },
        }));
        record.costUsd = reply?.costUsd ?? null;
        record.toolCalls = toolCallsOf(toolCalls, reply?.webTools);
        parse(reply?.text, ids);
        record.valid = true;
        text = reply.text;
        if (saved) fs.writeFileSync(saved, text, { mode: 0o600 });
      } catch (error) {
        record.valid = false;
        record.error = String(error?.code || error?.message || 'invalid').slice(0, 240);
      }
      record.durationMs = Date.now() - started;
      calls.push(record);
      return text;
    })();
    cache.set(key, pending);
    return pending;
  }

  async function merged(prompt, ids) {
    const key = `merged\u0000${prompt}`;
    if (cache.has(key)) return cache.get(key);
    const pending = (async () => {
      const started = Date.now();
      const [nativeText, tavilyText] = await Promise.all([once('native', prompt, ids), once('tavily', prompt, ids)]);
      const resolved = ids.length ? ids : researchIdsInReplies([nativeText, tavilyText], begin);
      const text = mergeSectionReplies({ ids: resolved, replies: { native: nativeText, tavily: tavilyText }, begin, end });
      const has = value => resolved.filter(id => sectionBody(value, id, begin, end)).length;
      const record = { task, arm: 'merged', promptChars: prompt.length, durationMs: Date.now() - started, costUsd: 0, toolCalls: {},
        valid: Boolean(text), sections: resolved.length, nativeSections: has(nativeText), tavilySections: has(tavilyText) };
      if (text) {
        try { parse(text, resolved); } catch (error) { record.valid = false; record.error = String(error?.code || error?.message || 'invalid').slice(0, 240); }
      }
      calls.push(record);
      return text;
    })();
    cache.set(key, pending);
    return pending;
  }

  const research = (arm, prompt, ids = []) => (arm === 'merged' ? merged(prompt, ids) : once(arm, prompt, ids));
  research.calls = calls;
  return research;
}

// ---- Preference task -------------------------------------------------------

function preferenceCompanies(rows, replay, opts) {
  const eligible = replay.selectRowsForTask(PREFERENCE_TASK, rows).map(replay.resetResearchedMatches);
  const companies = new Map();
  for (const row of eligible) {
    const name = String(row?.company || row?.employer || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!companies.has(key)) companies.set(key, { name, rows: [] });
    companies.get(key).rows.push(row);
  }
  const forced = [...companies.keys()].filter(key => /stelvio/iu.test(key)).slice(0, 1);
  const rest = [...companies.keys()].filter(key => !forced.includes(key));
  const chosen = [...forced, ...sample(rest, opts.count - forced.length, mulberry32(opts.seed))];
  return { eligible, companies: companies.size, chosen, jobs: chosen.flatMap(key => companies.get(key).rows) };
}

async function runPreference({ opts, rows, replay, app, researcher, output, log }) {
  const companies = preferenceCompanies(rows, replay, opts);
  log(`eligible rows ${companies.eligible.length} · companies ${companies.companies} · sampled ${companies.chosen.length} · jobs ${companies.jobs.length}`);
  const materialize = replay.appMaterialize(app);
  const validate = replay.appValidate(app);
  const execute = replay.appExecute(app, PREFERENCE_ASSESSMENT_TASK);
  const assessments = [];
  const results = [];
  const runs = new Map();

  for (const arm of ARMS) {
    // Fresh module instance per arm: jobPreferences caches research answers for 24h
    // by company+criterion, which would serve arm 1's replies to every later arm and
    // erase the comparison.
    const prefs = await import(new URL(`../electron/ipc/jobPreferences.js?ab-arm=${arm}-${opts.seed}`, import.meta.url).href);
    const callRaw = async prompt => {
      const text = await researcher(arm, prompt, researchIdsInPrompt(prompt));
      if (!text) throw new Error('No valid research reply for this prompt.');
      return text;
    };
    // Like the app's correction rounds: a rejected answer is asked again with the rejection reason, up to 3 tries.
    const callText = async (prompt, callOpts = {}) => {
      let rejection = '';
      for (let attempt = 1; ; attempt += 1) {
        const asked = rejection ? `${prompt}\n\nYOUR PREVIOUS ANSWER WAS REJECTED: ${rejection}\nReturn a corrected complete answer.` : prompt;
        const call = { ...materialize(asked, callOpts), task: callOpts.task };
        const started = Date.now();
        const reply = await execute({ config: { kind: 'claude', id: 'claude' }, call });
        assessments.push({ arm, task: callOpts.task, attempt, durationMs: Date.now() - started, costUsd: reply?.costUsd ?? null });
        try { return validate(call, reply.text); } catch (error) {
          rejection = String(error?.message || error).slice(0, 600);
          log(`${arm} assessment attempt ${attempt} rejected: ${rejection}`);
          if (attempt >= 3) throw error;
        }
      }
    };
    const started = Date.now();
    let outcome;
    try {
      outcome = await prefs.researchDeferredJobPreferences({ jobs: structuredClone(companies.jobs), callRaw, callText });
    } catch (error) {
      log(`${arm} failed: ${String(error?.message || error).slice(0, 300)}`);
      runs.set(arm, { jobs: 0, statuses: {}, matches: 0, error: String(error?.message || error).slice(0, 300) });
      continue;
    }
    const jobs = Array.isArray(outcome?.jobs) ? outcome.jobs : [];
    const statuses = {};
    let matches = 0;
    for (const job of jobs) {
      const status = job?.preferenceAssessment?.status || 'unknown';
      statuses[status] = (statuses[status] || 0) + 1;
      for (const match of Array.isArray(job?.preferenceAssessment?.matches) ? job.preferenceAssessment.matches : []) {
        if (match?.category !== 'company' || match?.strict !== true) continue;
        matches += 1;
        const record = { arm, company: job.company, title: job.title, criterion: match.criterion, outcome: match.outcome,
          evidence: String(match.evidence ?? match.evidenceQuote ?? '').slice(0, 300), sourceUrls: Array.isArray(match.sourceUrls) ? [...match.sourceUrls] : [] };
        results.push(record);
        output.row({ kind: 'match', ...record });
      }
    }
    runs.set(arm, { jobs: jobs.length, statuses, matches });
    log(`${arm.padEnd(6)} jobs ${jobs.length} · matches ${matches} · ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const summary = { task: 'preference', ultracode: opts.ultracode, arms: {}, researchCalls: {}, disagreements: 0 };
  for (const arm of ARMS) {
    const mine = results.filter(record => record.arm === arm);
    const outcomes = { confirmed: 0, conflicts: 0, unverified: 0, other: 0 };
    for (const record of mine) outcomes[['confirmed', 'conflicts', 'unverified'].includes(record.outcome) ? record.outcome : 'other'] += 1;
    const research = researcher.calls.filter(call => call.arm === arm);
    const assessment = assessments.filter(call => call.arm === arm);
    summary.arms[arm] = { matches: mine.length, outcomes, jobStatuses: runs.get(arm)?.statuses || {},
      researchCostUsd: Number(sum(research, call => call.costUsd).toFixed(4)), assessmentCostUsd: Number(sum(assessment, call => call.costUsd).toFixed(4)),
      avgResearchSeconds: average(research, call => call.durationMs), avgAssessmentSeconds: average(assessment, call => call.durationMs),
      avgSeconds: average([...research, ...assessment], call => call.durationMs), researchCalls: research.length,
      invalidResearchReplies: research.filter(call => call.valid === false).length, toolCalls: toolTotals(research) };
    summary.researchCalls[arm] = research;
  }
  const disagreements = preferenceDisagreements(results);
  summary.disagreements = disagreements.length;
  output.json('summary.json', summary);
  output.text('disagreements.md', renderDisagreements(disagreements));
  log(`${JSON.stringify(summary, null, 2)}\ndetails: ${output.resultsPath}`);
}

/** (company, criterion) pairs whose outcome is not identical across arms. */
function preferenceDisagreements(results) {
  const byKey = new Map();
  for (const record of results) {
    const key = `${String(record.company).toLowerCase()}\u0000${String(record.criterion).toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, { company: record.company, criterion: record.criterion, arms: {} });
    const entry = byKey.get(key);
    if (!entry.arms[record.arm]) entry.arms[record.arm] = record;
  }
  return [...byKey.values()].filter(entry => new Set(ARMS.map(arm => entry.arms[arm]?.outcome ?? 'missing')).size > 1);
}

function renderDisagreements(entries) {
  const lines = ['# Preference research disagreements', '',
    'One entry per (company, criterion) whose outcome differs between arms. Evidence is truncated to 300 characters.', ''];
  for (const entry of entries) {
    lines.push(`## ${entry.company} — ${entry.criterion}`, '');
    for (const arm of ARMS) {
      const record = entry.arms[arm];
      lines.push(`- **${arm}**: ${record?.outcome ?? 'no result'}`);
      if (record?.evidence) lines.push(`  - evidence: ${record.evidence.replace(/\s+/gu, ' ')}`);
      if (record?.sourceUrls?.length) lines.push(`  - urls: ${record.sourceUrls.join(', ')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

// ---- Compensation task -----------------------------------------------------

// Mirrors jobs.js compensationResearchId: deterministic and 24 lowercase hex.
const compensationId = (index, cohort) => crypto.createHash('sha256').update(`web-research-ab:compensation-batch-v1:${index}:${cohort}`, 'utf8').digest('hex').slice(0, 24);

function compensationBatches(rows, opts) {
  const withContext = rows.filter(row => row?.compensationContext && typeof row.compensationContext === 'object');
  const cohorts = new Map();
  for (const row of withContext) {
    const key = cohortKey(row);
    if (!cohorts.has(key)) cohorts.set(key, { key, row });
  }
  const picked = sample([...cohorts.values()], opts.count, mulberry32(opts.seed));
  const batches = [];
  for (let i = 0; i < picked.length; i += 2) {
    const slice = picked.slice(i, i + 2);
    // c0/c1 in the app are opaque 24-hex ids; parseCompensationResearchSections
    // only accepts `[a-f0-9]{24}` markers, so a literal "c0" is rejected as a
    // malformed marker. Derive the same shape deterministically per cohort.
    const entries = slice.map((cohort, index) => ({ researchId: compensationId(index, cohort.key), researchParameters: compensationParameters(cohort.row) }));
    batches.push({ cohorts: slice, entries });
  }
  return { withContext, cohorts: cohorts.size, picked, batches };
}

/** Fetch each distinct source URL once through Tavily extract; a plain-code call, no AI. */
function tavilyExtractor({ key, log }) {
  return async urls => {
    const pages = new Map();
    for (let i = 0; i < urls.length; i += EXTRACT_BATCH) {
      const chunk = urls.slice(i, i + EXTRACT_BATCH);
      try {
        const response = await fetch(TAVILY_EXTRACT_URL, { method: 'POST', headers: { 'content-type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ urls: chunk, extract_depth: 'basic' }) });
        const body = response.ok ? await response.json() : null;
        if (!response.ok) log(`tavily extract failed with status ${response.status}`);
        for (const result of Array.isArray(body?.results) ? body.results : []) if (result?.url) pages.set(String(result.url), String(result.raw_content ?? ''));
        for (const failed of Array.isArray(body?.failed_results) ? body.failed_results : []) if (failed?.url) pages.set(String(failed.url), null);
      } catch (error) { log(`tavily extract error: ${error?.message || error}`); }
      for (const url of chunk) if (!pages.has(url)) pages.set(url, null);
    }
    return pages;
  };
}

async function runCompensation({ opts, rows, researcher, output, log, extract, buildPrompt }) {
  const board = compensationBatches(rows, opts);
  log(`rows with compensation context ${board.withContext.length} · cohorts ${board.cohorts} · sampled ${board.picked.length} · batches ${board.batches.length}`);
  const texts = Object.fromEntries(ARMS.map(arm => [arm, []]));
  for (const [index, batch] of board.batches.entries()) {
    const prompt = buildPrompt(batch.entries);
    const ids = batch.entries.map(entry => entry.researchId);
    await Promise.all(ARMS.map(async arm => { texts[arm][index] = await researcher(arm, prompt, ids); }));
    log(`batch ${index + 1}/${board.batches.length} · prompt ${prompt.length} chars · ${ARMS.map(arm => `${arm} ${texts[arm][index] ? 'ok' : 'missing'}`).join(' · ')}`);
  }

  const sections = [];
  for (const [index, batch] of board.batches.entries()) for (const [position, entry] of batch.entries.entries()) for (const arm of ARMS) {
    const body = sectionBody(texts[arm][index], entry.researchId, compensationBegin, compensationEnd);
    sections.push({ arm, batch: index + 1, cohort: entry.researchId, cohortKey: batch.cohorts[position].key,
      roleFamily: entry.researchParameters.roleFamily, currency: entry.researchParameters.targetCurrency,
      urls: extractSectionUrls(body), body });
  }
  const urls = [...new Set(sections.flatMap(section => section.urls))];
  log(`sections ${sections.length} · distinct source urls ${urls.length}`);
  const pages = await extract(urls);
  // Kept so the scoring can be redone without paying for the research again.
  output.json('sections.json', sections.map(({ arm, batch, cohort, cohortKey, roleFamily, currency, body }) => ({ arm, batch, cohort, cohortKey, roleFamily, currency, body })));
  output.json('pages.json', Object.fromEntries([...pages.entries()]));
  const sources = [];
  for (const section of sections) {
    section.verified = false;
    for (const url of section.urls) {
      const page = pages.get(url) ?? null;
      const figures = moneyFiguresNear(section.body, url);
      const verified = Boolean(page) && figures.some(figure => pageHasFigure(page, figure));
      section.verified ||= verified;
      const record = { kind: 'source', arm: section.arm, batch: section.batch, cohort: section.cohort, cohortKey: section.cohortKey,
        roleFamily: section.roleFamily, currency: section.currency, url, figures, verified, pageChars: page ? page.length : 0,
        pageError: page ? null : 'unavailable' };
      sources.push(record);
      output.row(record);
    }
    section.urlCount = section.urls.length;
    output.row({ kind: 'section', arm: section.arm, batch: section.batch, cohort: section.cohort, cohortKey: section.cohortKey,
      roleFamily: section.roleFamily, currency: section.currency, urls: section.urlCount, verified: section.verified });
  }

  const summary = { task: 'compensation', ultracode: opts.ultracode, cohorts: board.cohorts, sampledCohorts: board.picked.length, batches: board.batches.length,
    distinctSourceUrls: urls.length, arms: {}, researchCalls: {} };
  for (const arm of ARMS) {
    const mine = sections.filter(section => section.arm === arm);
    const mineSources = sources.filter(source => source.arm === arm);
    const research = researcher.calls.filter(call => call.arm === arm);
    summary.arms[arm] = { sections: mine.length, sectionsWithUrls: mine.filter(section => section.urlCount > 0).length,
      sectionsWithVerifiedSource: mine.filter(section => section.verified).length, sourceUrls: mineSources.length,
      verifiedSources: mineSources.filter(source => source.verified).length, researchCostUsd: Number(sum(research, call => call.costUsd).toFixed(4)),
      avgSeconds: average(research, call => call.durationMs), researchCalls: research.length,
      invalidResearchReplies: research.filter(call => call.valid === false).length, toolCalls: toolTotals(research) };
    summary.researchCalls[arm] = research;
  }
  output.json('summary.json', summary);
  log(`${JSON.stringify(summary, null, 2)}\ndetails: ${output.resultsPath}`);
}

// ---- Dry run ---------------------------------------------------------------

async function dryPreference({ opts, rows, replay }) {
  const companies = preferenceCompanies(rows, replay, opts);
  console.log(`dry run: preference · eligible rows ${companies.eligible.length} · companies ${companies.companies} · sampled ${companies.chosen.length} · jobs ${companies.jobs.length}`);
  const prefs = await import(new URL('../electron/ipc/jobPreferences.js?ab-dry=1', import.meta.url).href);
  const research = [];
  const assessments = [];
  // Both callbacks are injected, so the dry run builds every prompt through the app's
  // own builders and refuses at the transport: no AI, no Tavily, no Keychain.
  const refuse = list => async prompt => { list.push(String(prompt ?? '')); throw new Error('dry run: no AI call'); };
  await prefs.researchDeferredJobPreferences({ jobs: structuredClone(companies.jobs), callRaw: refuse(research), callText: refuse(assessments) });
  const sizes = list => `${list.length}${list.length ? ` (${list.map(prompt => prompt.length).join(', ')} chars)` : ''}`;
  console.log(`research prompts ${sizes(research)}`);
  console.log(`assessment prompts ${sizes(assessments)}`);
  console.log(`arms ${ARMS.join(', ')} · no AI or Tavily call made, Keychain not read`);
  return 0;
}

function dryCompensation({ opts, rows, buildPrompt }) {
  const board = compensationBatches(rows, opts);
  console.log(`dry run: compensation · rows with context ${board.withContext.length} · cohorts ${board.cohorts} · sampled ${board.picked.length} · batches ${board.batches.length}`);
  board.batches.forEach((batch, index) => {
    const prompt = buildPrompt(batch.entries);
    console.log(`batch ${index + 1}/${board.batches.length} · ${batch.entries.map(entry => entry.researchParameters.roleFamily).join(' | ')} · prompt ${prompt.length} chars`);
  });
  console.log(`arms ${ARMS.join(', ')} · no AI or Tavily call made, Keychain not read`);
  return 0;
}

let redactOutput = text => String(text ?? '');

async function main(argv) {
  const opts = options(argv);
  const [{ parseWorkspaceText, restoreWorkspaceContent }, tavily, nonApi, worker, profiles, sdk, runner, replay] = await Promise.all([
    ipc('workspaceContentPool.js'), ipc('tavily.js'), ipc('nonApiAi.js'), ipc('claudeTaskWorker.js'),
    ipc('claudeTaskProfiles.js'), ipc('claudeApplicationSdkStage.js'), ipc('claudeApplicationRunner.js'),
    import(new URL('./ai-task-replay.mjs', import.meta.url).href),
  ]);
  const parsed = parseWorkspaceText(fs.readFileSync(opts.canvas, 'utf8'));
  const canvas = restoreWorkspaceContent(parsed) ?? parsed;
  const node = replay.findBoardNode(canvas);
  if (!node) throw new Error('No Job Board node with rows was found in the canvas.');
  const rows = [node.data.scoredJobs, node.data.rows, node.data.jobs].find(Array.isArray) || [];
  const prefs = await ipc('jobPreferences.js');
  const jobsModule = opts.task === 'compensation' ? await ipc('jobs.js') : null;
  if (opts.dryRun) return opts.task === 'preference' ? dryPreference({ opts, rows, replay }) : dryCompensation({ opts, rows, buildPrompt: jobsModule.buildCompensationResearchPrompt });

  const key = await tavily.readTavilyKey();
  if (!key) throw new Error(`No Tavily key in the Keychain. Run: security add-generic-password -s ${tavily.TAVILY_KEYCHAIN_SERVICE} -a tavily -w`);
  const redact = redactWith(key);
  redactOutput = redact;
  const output = writers(opts.out, redact);
  const log = message => console.log(redact(message));
  const binary = runner.resolveClaudeBinary({ env: process.env, homedir: os.homedir() });
  const stage = { binary, env: runner.claudeChildEnv(process.env, path.dirname(binary)), cwd: os.tmpdir() };
  // Assessment calls run through replay.appExecute, so the switch is wrapped here
  // too: every runClaudeSdkStage call this script makes carries the same flag.
  const { ultracode } = opts;
  const app = { ...nonApi, ...worker, ...profiles, ...sdk, ...runner, runClaudeSdkStage: callOpts => sdk.runClaudeSdkStage({ ...callOpts, ultracode }) };
  const limit = replay.createLimiter(opts.concurrency);
  const calls = [];

  if (opts.task === 'preference') {
    const profile = profiles.claudeTaskProfile(PREFERENCE_TASK);
    if (!profile) throw new Error(`No Claude task profile for ${PREFERENCE_TASK}.`);
    const researcher = createResearcher({ app, profile, stage, tavily, tavilyKey: key, task: PREFERENCE_TASK,
      begin: preferenceBegin, end: preferenceEnd, parse: (raw, ids) => prefs.parseJobPreferenceResearchSections(raw, ids), limit, calls, cacheDir: path.join(opts.out, 'research-cache') });
    await runPreference({ opts, rows, replay, app, researcher, output, log });
  } else {
    const profile = profiles.claudeTaskProfile(COMPENSATION_TASK);
    if (!profile) throw new Error(`No Claude task profile for ${COMPENSATION_TASK}.`);
    const researcher = createResearcher({ app, profile, stage, tavily, tavilyKey: key, task: COMPENSATION_TASK,
      begin: compensationBegin, end: compensationEnd, parse: (raw, ids) => jobsModule.parseCompensationResearchSections(raw, ids), limit, calls, cacheDir: path.join(opts.out, 'research-cache') });
    await runCompensation({ opts, rows, researcher, output, log, extract: tavilyExtractor({ key, log }), buildPrompt: jobsModule.buildCompensationResearchPrompt });
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(redactOutput(error?.message || error)); process.exitCode = 1; });
}
