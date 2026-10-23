/** Durable, source-free observations of rejected application steps. */
import crypto from 'node:crypto';
export const SAME_RULE_STOP_LIMIT = 5;
export const SAME_RULE_STOP_REASONS = Object.freeze(['same-rule-repeat', 'run-budget']);
export const APPLICATION_ROUTE_CLAUDE_RUNNER = 'claude-runner';
export const UNCHANGED_NOTICE_PREFIX = 'Unchanged reply:';
const FAMILIES = Object.freeze({ write: 'write', convert: 'documents', 'verify-correction': 'documents', 'fit-correction': 'documents', pick: 'pick', 'fact-check': 'fact-check', 'fact-recheck': 'fact-check', 'fact-correction': 'fact-correction', requirements: 'requirements', 'requirements-audit': 'requirements-audit', 'requirements-adjudication': 'requirements-adjudication' });
const SUBJECT = /^[a-z0-9][a-z0-9-]{0,47}$/u;
const ID = /^[a-z][a-z0-9-]{0,63}$/u;
const KEY = /^[a-z][a-z0-9-]{0,63}(?::[0-9a-f]{8})?$/u;
const SHA = /^[0-9a-f]{64}$/u;
const subjectOk = value => typeof value === 'string' && SUBJECT.test(value);
const idOk = value => typeof value === 'string' && ID.test(value);
const keyOk = value => typeof value === 'string' && KEY.test(value);
const shaOk = value => typeof value === 'string' && SHA.test(value);
const countOk = n => Number.isSafeInteger(n) && n >= 0 && n <= 9999;
const digest = text => crypto.createHash('sha256').update(text).digest('hex');
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
export const ruleTallyFamily = stage => Object.hasOwn(FAMILIES, stage) ? FAMILIES[stage] : null;
export const emptyRuleTally = () => ({ version: 1, steps: [] });
export function cleanRuleTally(value) {
  if (!plain(value) || value.version !== 1 || !Array.isArray(value.steps)) return emptyRuleTally();
  const steps = [];
  for (const step of value.steps) {
    if (!plain(step) || !Object.values(FAMILIES).includes(step.family) || !subjectOk(step.subject) || !shaOk(step.lastRejectedSha256)) continue;
    const rules = (Array.isArray(step.rules) ? step.rules : []).filter(row => plain(row) && idOk(row.id) && keyOk(row.key) && countOk(row.n)).slice(-32).map(({ key, id, n }) => ({ key, id, n }));
    const runs = Object.fromEntries(Object.entries(plain(step.runs) ? step.runs : {}).filter(([id, n]) => idOk(id) && countOk(n)).slice(-32));
    steps.push({ family: step.family, subject: step.subject, lastRejectedSha256: step.lastRejectedSha256, runs, rules });
  }
  return { version: 1, steps: steps.slice(-32) };
}
export const normalizedObservationFingerprint = text => digest(String(text).replace(/[\u2018\u201c][^\u2019\u201d]*[\u2019\u201d]/gu, '<value>').replace(/\d+/g, '#')).slice(0, 8);
const stable = value => Array.isArray(value) ? value.map(stable) : plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export function canonicalAnswerSha256({ rawText, parsed }) {
  return plain(parsed) ? digest(JSON.stringify(stable(Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'handoffCode' && !key.startsWith('__'))))))
    : digest(`text:${String(rawText || '').replace(/\r\n/g, '\n').trim()}`);
}
export function recordRuleRejection(value, { family, subject, rules: observations, answerSha256 }) {
  const tally = cleanRuleTally(value);
  if (!Object.values(FAMILIES).includes(family) || !subjectOk(subject) || !shaOk(answerSha256)) return { tally, unchanged: false, rules: [], stop: null };
  let step = tally.steps.find(row => row.family === family && row.subject === subject);
  if (!step) { step = { family, subject, lastRejectedSha256: answerSha256, runs: {}, rules: [] }; tally.steps.push(step); }
  const unchanged = step.lastRejectedSha256 === answerSha256 && step.rules.length > 0;
  step.lastRejectedSha256 = answerSha256;
  const unique = new Map();
  for (const row of observations) {
    if (!idOk(row.id) || (row.id === 'schema-invalid' && !/^[0-9a-f]{8}$/u.test(row.fingerprint))) continue;
    const key = row.id === 'schema-invalid' ? `${row.id}:${row.fingerprint}` : row.id;
    unique.set(key, row.id);
  }
  const runs = Object.fromEntries([...new Set(unique.values())].map(id => [id, Math.min(9999, (step.runs[id] || 0) + 1)]));
  const rules = [];
  for (const [key, id] of unique) {
    let row = step.rules.find(item => item.key === key);
    if (!row) { row = { key, id, n: 0 }; step.rules.push(row); }
    row.n = Math.min(9999, row.n + 1);
    rules.push({ ...row, run: runs[id] });
  }
  step.rules = step.rules.slice(-32); step.runs = runs; tally.steps = tally.steps.slice(-32);
  const stop = rules.filter(row => row.n >= SAME_RULE_STOP_LIMIT).sort((a, b) => b.n - a.n || a.key.localeCompare(b.key))[0];
  return { tally, unchanged, rules, stop: stop ? { id: stop.id, key: stop.key, n: stop.n } : null };
}
export function clearRuleTallyFamily(value, family) {
  const tally = cleanRuleTally(value); tally.steps = tally.steps.filter(row => row.family !== family); return tally;
}
export function clearRuleTallyStep(value, family, subject) {
  const tally = cleanRuleTally(value); tally.steps = tally.steps.filter(row => row.family !== family || row.subject !== subject); return tally;
}
export function ruleTallyEscalationRuns(value, family, subject) {
  return Object.fromEntries(Object.entries(cleanRuleTally(value).steps.find(row => row.family === family && row.subject === subject)?.runs || {}).filter(([, n]) => n > 0));
}
export const ruleTallyLastRoundIds = (value, family, subject) => Object.keys(ruleTallyEscalationRuns(value, family, subject)).sort();
export function summarizeRuleTally(value, limit = 3) {
  return cleanRuleTally(value).steps.flatMap(step => step.rules.map(row => ({ family: step.family, subject: step.subject, ruleId: row.id, count: row.n })))
    .sort((a, b) => b.count - a.count || a.family.localeCompare(b.family) || a.subject.localeCompare(b.subject) || a.ruleId.localeCompare(b.ruleId)).slice(0, limit);
}
export function sameRuleStopTerminal({ stage, family, subject, ruleId, count }) {
  return { kind: 'write-verify-human-stop', reason: 'same-rule-repeat', stage, family, subject, ruleId, count, checkIds: [ruleId],
    message: `Stopped: the ${stage} step for ${subject} was rejected ${count} times for the same rule (${ruleId}).` };
}
export function runBudgetTerminal({ stage, runs, limit, tallies = [] }) {
  const top = tallies.slice(0, 3);
  return { kind: 'write-verify-human-stop', reason: 'run-budget', stage, runs, limit, tallies: top, checkIds: [...new Set(top.map(row => row.ruleId))],
    message: `Stopped: Claude used ${runs} of ${limit} allowed runs on this application and is now at the ${stage} step.${top.length ? ` Most repeated rules: ${top.map(row => `${row.ruleId} x${row.count} (${row.family} ${row.subject})`).join('; ')}` : ''}` };
}
export function terminalStopSummary(terminal) {
  return SAME_RULE_STOP_REASONS.includes(terminal?.reason) ? { reason: terminal.reason, stage: terminal.stage,
    ...(terminal.subject ? { subject: terminal.subject } : {}), ...(terminal.ruleId ? { ruleId: terminal.ruleId } : {}), ...(terminal.count ? { count: terminal.count } : {}) } : null;
}
export function unchangedNotice({ family, subject, ruleIds, n }) {
  return `${UNCHANGED_NOTICE_PREFIX} this reply is identical to your previous rejected reply for this step (${family} ${subject}) apart from the handoff envelope, so ${ruleIds.join(', ')} rejected it again (rule rejected ${n} times). Change what the items that follow name; do not resend the same reply.`;
}
