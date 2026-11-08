#!/usr/bin/env node
// Scores a replay run written by ai-task-replay.mjs. Reads <out>/results.jsonl
// (and the optional <out>/meta.json holding strict preference ids) and prints,
// per task x config: n, first-try valid rate, mean cost, p50/p95 latency and
// agreement with Claude rep 1. Claude reps 2/3 against rep 1 are the noise
// floor the other configs are read against. Nothing here prints answer text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUTCOMES = new Set(['confirmed', 'conflicts', 'unverified']);
const WITHIN_POINTS = 5;

export function parseResults(text) {
  const rows = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try { row = JSON.parse(trimmed); } catch { continue; }
    if (row && typeof row === 'object' && !Array.isArray(row) && typeof row.task === 'string' && typeof row.config === 'string') rows.push(row);
  }
  return rows;
}

export function percentile(values, p) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function mean(values) {
  const finite = values.filter(value => Number.isFinite(value));
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

/** "listing index:preference id" -> outcome for one preference-evaluation answer. */
export function outcomeMap(answer) {
  const map = new Map();
  for (const row of Array.isArray(answer?.assessments) ? answer.assessments : []) {
    if (!Number.isInteger(row?.index)) continue;
    for (const match of Array.isArray(row.matches) ? row.matches : []) {
      if (typeof match?.preferenceId === 'string' && OUTCOMES.has(match.outcome)) map.set(`${row.index}:${match.preferenceId}`, match.outcome);
    }
  }
  return map;
}

/** listing index -> 'filtered' when any strict requirement conflicts, else 'accepted' (mirrors attachAssessments). */
export function decisionMap(answer, strictIds) {
  const strict = strictIds instanceof Set ? strictIds : new Set(strictIds || []);
  const map = new Map();
  for (const row of Array.isArray(answer?.assessments) ? answer.assessments : []) {
    if (!Number.isInteger(row?.index)) continue;
    const matches = Array.isArray(row.matches) ? row.matches : [];
    map.set(row.index, matches.some(match => strict.has(match?.preferenceId) && match.outcome === 'conflicts') ? 'filtered' : 'accepted');
  }
  return map;
}

/** listing index -> integer score for one job-scoring answer. */
export function scoreMap(answer) {
  const map = new Map();
  for (const row of Array.isArray(answer?.scores) ? answer.scores : []) {
    if (Number.isInteger(row?.index) && Number.isFinite(row.matchScore)) map.set(row.index, row.matchScore);
  }
  return map;
}

/** Counts of equal entries over the reference's keys; a key the answer lacks is a disagreement. */
export function compareMaps(reference, candidate) {
  let total = 0;
  let equal = 0;
  for (const [key, value] of reference) {
    total += 1;
    if (candidate.get(key) === value) equal += 1;
  }
  return { total, equal };
}

export function compareScores(reference, candidate) {
  const diffs = [];
  for (const [key, value] of reference) if (candidate.has(key)) diffs.push(Math.abs(candidate.get(key) - value));
  return { total: reference.size, diffs };
}

// ---- Web-research tasks: answers are raw text sections (or one JSON judgment) ----

export const RESEARCH_TASKS = ['job-official-posting-research', 'job-official-posting-match', 'job-compensation-research-batch', 'job-preference-research-batch'];
const COMP_WITHIN = 0.1;
const CURRENCIES = 'USD|EUR|GBP|CAD|AUD|NZD|CHF|SEK|NOK|DKK|PLN|CZK|INR|JPY|CNY|SGD|HKD|BRL|MXN|ZAR|AED';
const SYMBOLS = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' };

/** Lowercase host, no query/fragment, no trailing slash; '' when not an absolute URL. */
export function normalizePostingUrl(value) {
  try {
    const url = new URL(String(value ?? '').trim());
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/u, '')}`;
  } catch { return ''; }
}

/** id -> section body for `BEGIN <label> <id>` ... `END <label> <id>` markers. */
export function markedSections(text, label) {
  const sections = new Map();
  const pattern = new RegExp(`^\\s*BEGIN ${label} ([A-Za-z0-9_-]+)\\s*\\n([\\s\\S]*?)^\\s*END ${label} \\1\\s*$`, 'gimu');
  for (const match of String(text ?? '').matchAll(pattern)) if (!sections.has(match[1])) sections.set(match[1], match[2]);
  return sections;
}

/** job id -> normalized posting URL of the first candidate that has one, else 'none' (parseOfficialPostingResearchResponse format). */
export function officialPostingMap(answer) {
  const map = new Map();
  if (typeof answer !== 'string') return map;
  for (const [id, body] of markedSections(answer, 'OFFICIAL POSTING RESEARCH')) {
    let chosen = 'none';
    for (const line of body.split('\n')) {
      const m = /^\s*CANDIDATE:\s*(\{.*\})\s*$/u.exec(line);
      if (!m) continue;
      let candidate;
      try { candidate = JSON.parse(m[1]); } catch { continue; }
      const url = normalizePostingUrl(candidate?.postingUrl);
      if (url) { chosen = url; break; }
    }
    map.set(id, chosen);
  }
  return map;
}

/** One judge answer (JSON object or JSON text): { decision: choice, chosen: normalized postingUrl or 'none' }. */
export function matchDecision(answer) {
  let value = answer;
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return null; } }
  if (!value || typeof value !== 'object') return null;
  const decision = typeof value.choice === 'string' ? value.choice : typeof value.status === 'string' ? value.status : '';
  if (!decision) return null;
  return { decision, chosen: normalizePostingUrl(value.postingUrl) || 'none' };
}

function toNumber(raw, k) {
  const value = Number(String(raw).replace(/,/gu, ''));
  return Number.isFinite(value) ? value * (k ? 1000 : 1) : NaN;
}

/** Salary ranges stated in one research section: [{ currency, min, max }]. */
export function salaryRanges(text) {
  const ranges = [];
  const sep = '\\s*(?:-|–|—|to)\\s*';
  const lead = new RegExp(`(${CURRENCIES}|[$€£¥₹])\\s?(\\d[\\d,.]*)\\s*(k)?${sep}(?:(?:${CURRENCIES}|[$€£¥₹])\\s?)?(\\d[\\d,.]*)\\s*(k)?`, 'giu');
  const trail = new RegExp(`(\\d[\\d,.]*)\\s*(k)?${sep}(\\d[\\d,.]*)\\s*(k)?\\s*(${CURRENCIES})\\b`, 'giu');
  for (const m of String(text ?? '').matchAll(lead)) ranges.push({ currency: SYMBOLS[m[1]] || m[1].toUpperCase(), min: toNumber(m[2], m[3]), max: toNumber(m[4], m[5] || m[3]) });
  for (const m of String(text ?? '').matchAll(trail)) ranges.push({ currency: m[5].toUpperCase(), min: toNumber(m[1], m[2]), max: toNumber(m[3], m[4] || m[2]) });
  return ranges.filter(r => Number.isFinite(r.min) && Number.isFinite(r.max) && r.min > 0 && r.max >= r.min);
}

const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const modeOf = values => { const c = new Map(); for (const v of values) c.set(v, (c.get(v) || 0) + 1); return [...c].sort((a, b) => b[1] - a[1])[0]?.[0] ?? ''; };

/** cohort id -> { currency, period, min, max } (median stated range, most common currency); sections with no stated range are absent. */
export function compensationMap(answer) {
  const map = new Map();
  if (typeof answer !== 'string') return map;
  for (const [id, body] of markedSections(answer, 'COMPENSATION RESEARCH')) {
    const ranges = salaryRanges(body);
    if (!ranges.length) continue;
    const period = /per hour|hourly|\/\s?h(?:ou)?r\b/iu.test(body) && !/per (?:year|annum)|annual/iu.test(body) ? 'hour'
      : /per month|monthly/iu.test(body) && !/per (?:year|annum)|annual/iu.test(body) ? 'month' : 'year';
    map.set(id, { currency: modeOf(ranges.map(r => r.currency)), period, min: median(ranges.map(r => r.min)), max: median(ranges.map(r => r.max)) });
  }
  return map;
}

const within = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= COMP_WITHIN * Math.max(Math.abs(a), Math.abs(b));
export const compensationSame = (a, b) => Boolean(a && b) && a.currency === b.currency && a.period === b.period && within(a.min, b.min) && within(a.max, b.max);

/** researchId -> { found, hosts } for one preference research answer ('BEGIN RESEARCH <id>' sections). Found = cites at least one URL. */
export function preferenceResearchMap(answer) {
  const map = new Map();
  if (typeof answer !== 'string') return map;
  for (const [id, body] of markedSections(answer, 'RESEARCH')) {
    const hosts = new Set();
    for (const m of body.matchAll(/https?:\/\/[^\s)\]>"']+/giu)) { try { hosts.add(new URL(m[0]).host.toLowerCase().replace(/^www\./u, '')); } catch { /* skip */ } }
    map.set(id, { found: hosts.size > 0, hosts });
  }
  return map;
}
export const preferenceSame = (a, b) => Boolean(a && b) && a.found === b.found && (!a.found || [...a.hosts].some(host => b.hosts.has(host)));

function textTaskAgreement(task, ref, answer) {
  const tally = { total: 0, equal: 0, missing: 0, found: 0, foundOnlyCandidate: 0, foundOnlyReference: 0, chosenEqual: 0 };
  if (task === 'job-official-posting-match') {
    const r = matchDecision(ref); const c = matchDecision(answer);
    if (!r) return tally;
    tally.total = 1;
    if (!c) tally.missing = 1;
    else { if (c.decision === r.decision) tally.equal = 1; if (c.chosen === r.chosen) tally.chosenEqual = 1; }
    return tally;
  }
  const maps = task === 'job-official-posting-research' ? [officialPostingMap(ref), officialPostingMap(answer)]
    : task === 'job-compensation-research-batch' ? [compensationMap(ref), compensationMap(answer)] : [preferenceResearchMap(ref), preferenceResearchMap(answer)];
  for (const [id, r] of maps[0]) {
    const c = maps[1].get(id);
    tally.total += 1;
    if (!c) tally.missing += 1;
    if (task === 'job-official-posting-research') {
      const refFound = r !== 'none'; const candFound = Boolean(c) && c !== 'none';
      if (candFound) tally.found += 1;
      if (candFound && !refFound) tally.foundOnlyCandidate += 1;
      if (refFound && !candFound) tally.foundOnlyReference += 1;
      if (c !== undefined && c === r) tally.equal += 1;
    } else if (task === 'job-compensation-research-batch') {
      if (compensationSame(r, c)) tally.equal += 1;
    } else {
      if (c?.found) tally.found += 1;
      if (preferenceSame(r, c)) tally.equal += 1;
    }
  }
  return tally;
}

const isAnswer = value => Boolean(value) && (typeof value === 'object' || (typeof value === 'string' && value.trim() !== ''));

function referenceAnswers(rows) {
  const refs = new Map();
  for (const row of rows) {
    if (row.config === 'claude' && row.rep === 1 && row.valid === true && isAnswer(row.answer)) refs.set(row.batch, row.answer);
  }
  return refs;
}

function researchAgreementFor(task, rows, refs) {
  const sum = { total: 0, equal: 0, missing: 0, found: 0, foundOnlyCandidate: 0, foundOnlyReference: 0, chosenEqual: 0 };
  let compared = 0;
  for (const row of rows) {
    const ref = refs.get(row.batch);
    if (!ref || (row.config === 'claude' && row.rep === 1) || row.valid !== true || !isAnswer(row.answer)) continue;
    compared += 1;
    const t = textTaskAgreement(task, ref, row.answer);
    for (const key of Object.keys(sum)) sum[key] += t[key];
  }
  const f = (n) => (sum.total ? n / sum.total : null);
  if (task === 'job-official-posting-match') return { compared, decisionAgreement: f(sum.equal), chosenLeadAgreement: f(sum.chosenEqual), missingRate: f(sum.missing) };
  if (task === 'job-official-posting-research') {
    return { compared, agreement: f(sum.equal), foundRate: f(sum.found), foundByDeepSeekOnly: sum.foundOnlyCandidate, foundByClaudeOnly: sum.foundOnlyReference, missingRate: f(sum.missing) };
  }
  if (task === 'job-compensation-research-batch') return { compared, agreement: f(sum.equal), missingRate: f(sum.missing) };
  return { compared, agreement: f(sum.equal), foundRate: f(sum.found), missingRate: f(sum.missing) };
}

function agreementFor(task, rows, refs, strictIds) {
  if (RESEARCH_TASKS.includes(task)) return researchAgreementFor(task, rows, refs);
  const outcomes = { total: 0, equal: 0 };
  const decisions = { total: 0, equal: 0 };
  const diffs = [];
  let scoreTotal = 0;
  let compared = 0;
  for (const row of rows) {
    const ref = refs.get(row.batch);
    // Claude rep 1 is the reference itself; every other Claude rep is the noise floor.
    if (!ref || (row.config === 'claude' && row.rep === 1)) continue;
    if (row.valid !== true || !row.answer || typeof row.answer !== 'object') continue;
    compared += 1;
    if (task === 'job-preference-evaluation') {
      const o = compareMaps(outcomeMap(ref), outcomeMap(row.answer));
      outcomes.total += o.total; outcomes.equal += o.equal;
      if (strictIds) {
        const d = compareMaps(decisionMap(ref, strictIds), decisionMap(row.answer, strictIds));
        decisions.total += d.total; decisions.equal += d.equal;
      }
    } else {
      const s = compareScores(scoreMap(ref), scoreMap(row.answer));
      scoreTotal += s.total;
      diffs.push(...s.diffs);
    }
  }
  const fraction = ({ total, equal }) => (total ? equal / total : null);
  if (task === 'job-preference-evaluation') {
    return { compared, outcomeAgreement: fraction(outcomes), decisionAgreement: strictIds ? fraction(decisions) : null };
  }
  return {
    compared,
    meanAbsScoreDiff: mean(diffs),
    withinPointsFraction: scoreTotal ? diffs.filter(diff => diff <= WITHIN_POINTS).length / scoreTotal : null,
  };
}

export function summarize(rows, { strictIds = null } = {}) {
  const byTask = new Map();
  for (const row of rows) {
    if (!byTask.has(row.task)) byTask.set(row.task, []);
    byTask.get(row.task).push(row);
  }
  const tasks = [];
  for (const [task, taskRows] of [...byTask].sort((a, b) => a[0].localeCompare(b[0]))) {
    const refs = referenceAnswers(taskRows);
    const byConfig = new Map();
    for (const row of taskRows) {
      if (!byConfig.has(row.config)) byConfig.set(row.config, []);
      byConfig.get(row.config).push(row);
    }
    const configs = [...byConfig].map(([config, configRows]) => ({
      config,
      n: configRows.length,
      validRate: configRows.filter(row => row.valid === true).length / configRows.length,
      meanCostUsd: mean(configRows.map(row => row.costUsd)),
      p50LatencyMs: percentile(configRows.map(row => row.latencyMs), 50),
      p95LatencyMs: percentile(configRows.map(row => row.latencyMs), 95),
      agreementBasis: config === 'claude' ? 'noise-floor (claude rep>=2 vs rep 1)' : 'vs claude rep 1',
      ...agreementFor(task, configRows, refs, strictIds),
    })).sort((a, b) => (a.config === 'claude' ? -1 : b.config === 'claude' ? 1 : a.config.localeCompare(b.config)));
    const entry = { task, batches: refs.size, configs };
    if (task === 'job-official-posting-match') {
      // Claude rep>=2 against rep 1: how often the judge disagrees with itself, the bar any other config is read against.
      const floor = configs.find(c => c.config === 'claude');
      entry.noiseFloor = floor ? { decisionAgreement: floor.decisionAgreement, chosenLeadAgreement: floor.chosenLeadAgreement, compared: floor.compared } : null;
    }
    tasks.push(entry);
  }
  return { tasks };
}

const pct = value => (value === null || value === undefined ? '-' : `${(value * 100).toFixed(1)}%`);
const num = (value, digits) => (value === null || value === undefined ? '-' : value.toFixed(digits));

export function renderText(summary) {
  const lines = [];
  for (const { task, batches, configs, noiseFloor } of summary.tasks) {
    lines.push(`${task} (${batches} batches with a valid Claude rep 1)`);
    if (noiseFloor) lines.push(`  noise floor (claude rep>=2 vs rep 1): decision ${pct(noiseFloor.decisionAgreement)} chosen-lead ${pct(noiseFloor.chosenLeadAgreement)} [${noiseFloor.compared} compared]`);
    for (const c of configs) {
      const agree = task === 'job-preference-evaluation'
        ? `outcome ${pct(c.outcomeAgreement)} decision ${pct(c.decisionAgreement)}`
        : task === 'job-official-posting-research'
          ? `agreement ${pct(c.agreement)} found ${pct(c.foundRate)} deepseek-only ${c.foundByDeepSeekOnly ?? '-'} claude-only ${c.foundByClaudeOnly ?? '-'}`
          : task === 'job-official-posting-match'
            ? `decision ${pct(c.decisionAgreement)} chosen-lead ${pct(c.chosenLeadAgreement)}`
            : task === 'job-compensation-research-batch'
              ? `agreement ${pct(c.agreement)} missing ${pct(c.missingRate)}`
              : task === 'job-preference-research-batch'
                ? `agreement ${pct(c.agreement)} found ${pct(c.foundRate)} missing ${pct(c.missingRate)}`
                : `mean|diff| ${num(c.meanAbsScoreDiff, 2)} within-5 ${pct(c.withinPointsFraction)}`;
      lines.push(`  ${c.config.padEnd(14)} n=${c.n} valid=${pct(c.validRate)} cost=$${num(c.meanCostUsd, 5)} p50=${num(c.p50LatencyMs, 0)}ms p95=${num(c.p95LatencyMs, 0)}ms | ${agree} [${c.agreementBasis}, ${c.compared} compared]`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function parseArgs(argv) {
  const opts = { out: null, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') opts.out = argv[++i] ?? null;
    else if (argv[i] === '--json') opts.json = true;
    else throw new Error(`Unknown argument ${argv[i]}`);
  }
  if (!opts.out) throw new Error('--out <dir> is required');
  return opts;
}

export function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (error) { console.error(error.message); return 2; }
  const resultsPath = path.join(opts.out, 'results.jsonl');
  if (!fs.existsSync(resultsPath)) { console.error('No results.jsonl in the out directory.'); return 1; }
  const rows = parseResults(fs.readFileSync(resultsPath, 'utf8'));
  let strictIds = null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(opts.out, 'meta.json'), 'utf8'));
    if (Array.isArray(meta?.strictPreferenceIds)) strictIds = new Set(meta.strictPreferenceIds);
  } catch { /* decision agreement is simply not reported without it */ }
  const summary = summarize(rows, { strictIds });
  process.stdout.write(opts.json ? `${JSON.stringify(summary, null, 2)}\n` : renderText(summary));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
