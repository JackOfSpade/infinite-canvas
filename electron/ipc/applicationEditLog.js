/** Private, local evidence for batch improvements to application generation. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';

const MAX_PAIRS = 100;
const SUMMARY_AGE_MS = 183 * 24 * 60 * 60 * 1000;
let queue = Promise.resolve();

export function modelLabel() {
  const file = process.env.IC_APPLICATION_MODEL_FILE || (process.resourcesPath && fs.existsSync(path.join(process.resourcesPath, 'config/application-model.json'))
    ? path.join(process.resourcesPath, 'config/application-model.json')
    : path.join(process.cwd(), 'config/application-model.json'));
  try {
    const label = JSON.parse(fs.readFileSync(file, 'utf8')).label;
    return typeof label === 'string' && label.trim() ? label.trim().slice(0, 120) : 'unspecified';
  } catch { return 'unspecified'; }
}

function storePath(root) { return path.join(root, 'application-improvement'); }
function stateFile(root) { return path.join(storePath(root), 'state.json'); }
function blank(label) { return { version: 1, modelLabel: label, countSinceSession: 0, pairs: [], summaries: [] }; }
async function read(root) {
  try { return JSON.parse(await fs.promises.readFile(stateFile(root), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return blank(modelLabel()); throw error; }
}
async function write(root, state) {
  const dir = storePath(root);
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  const frozen = path.join(dir, 'frozen-regression.json');
  try { await fs.promises.writeFile(frozen, '[]\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const target = stateFile(root);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tmp, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
    await fs.promises.rename(tmp, target);
  } finally { await fs.promises.unlink(tmp).catch(() => {}); }
}
function serialize(operation) {
  const result = queue.then(operation);
  queue = result.catch(() => {});
  return result;
}
function digest(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function idFor(dir) { return digest(path.resolve(dir)); }

export function documentSnapshot(html) {
  const dom = new JSDOM(String(html || ''));
  try {
    const doc = dom.window.document;
    const panel = kind => doc.querySelector(`[data-ic-document-panel="${kind}"] main.page`);
    let bundle = {};
    try { bundle = JSON.parse(doc.getElementById('ic-application-bundle-data')?.textContent || '{}'); } catch { /* no metadata */ }
    return {
      resume: panel('resume')?.outerHTML || '',
      letter: bundle.letterRemoved ? null : (panel('cover')?.outerHTML || null),
      letterRemoved: Boolean(bundle.letterRemoved),
    };
  } finally { dom.window.close(); }
}

/** Build identity stamped by vite.config.js; source runs (tests, scripts) have none. */
export function appBuild() {
  // eslint-disable-next-line no-undef
  return typeof __APP_BUILD__ === 'string' ? __APP_BUILD__ : 'unbundled source';
}

const BLOCKS = 'h1, h2, h3, p, li, dt, dd, article.project';
const squash = value => String(value || '').replace(/\s+/g, ' ').trim();

/** Leaf content blocks in reading order, each tagged with its section heading. */
function contentBlocks(html) {
  if (!html) return [];
  const dom = new JSDOM(html);
  try {
    const rows = [];
    let section = '';
    for (const el of dom.window.document.querySelectorAll(BLOCKS)) {
      if (el.parentElement?.closest(BLOCKS)) continue;
      const text = squash(el.textContent);
      if (el.tagName === 'H2') section = text;
      if (!text) continue;
      const kind = el.tagName.toLowerCase() + (el.classList[0] ? `.${el.classList[0]}` : '');
      rows.push({ text, section, kind });
    }
    return rows;
  } finally { dom.window.close(); }
}

function commonWords(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table[0][0];
}

/** Indexes of `values` outside one longest increasing run: the entries that changed order. */
function outOfOrder(values) {
  const tails = [];
  const previous = new Array(values.length).fill(-1);
  for (let k = 0; k < values.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (values[tails[mid]] < values[k]) lo = mid + 1; else hi = mid; }
    if (lo > 0) previous[k] = tails[lo - 1];
    tails[lo] = k;
  }
  const kept = new Set();
  for (let k = tails.at(-1) ?? -1; k >= 0; k = previous[k]) kept.add(k);
  return new Set(values.map((_, k) => k).filter(k => !kept.has(k)));
}

/**
 * Shared block pairing for editSummaries and editDiffs, so the private
 * summaries and the gate's diffs always describe the same edits.
 */
function pairBlocks(before, after) {
    const pairs = [];
    const freeAfter = new Set(after.keys());
    const freeBefore = [];
    for (const [i, block] of before.entries()) {
      const j = [...freeAfter].find(index => after[index].text === block.text);
      if (j === undefined) freeBefore.push(i);
      else { freeAfter.delete(j); pairs.push({ i, j }); }
    }
    // A leftover block in the same section and kind that keeps at least half its words is a rewrite.
    const candidates = [];
    for (const i of freeBefore) {
      const a = before[i].text.split(' ');
      for (const j of freeAfter) {
        if (after[j].kind !== before[i].kind || after[j].section !== before[i].section) continue;
        const b = after[j].text.split(' ');
        const kept = commonWords(a, b);
        const score = (2 * kept) / (a.length + b.length);
        if (score >= 0.5) candidates.push({ i, j, score, wordsRemoved: a.length - kept, wordsAdded: b.length - kept });
      }
    }
    const rewrittenBefore = new Set();
    for (const candidate of candidates.sort((x, y) => y.score - x.score)) {
      if (rewrittenBefore.has(candidate.i) || !freeAfter.has(candidate.j)) continue;
      rewrittenBefore.add(candidate.i);
      freeAfter.delete(candidate.j);
      pairs.push({ ...candidate, rewritten: true });
    }
    pairs.sort((x, y) => x.i - y.i);
    const moved = outOfOrder(pairs.map(pair => pair.j));
    return { pairs, moved, freeBefore, rewrittenBefore, freeAfter };
}

/**
 * One row per changed block: what the user did (added, removed, rewritten,
 * moved, markup) and where, without any document text. Classifying the edit
 * (truth, evidence, wording...) is left to the improvement session.
 */
export function editSummaries(generated, saved, id, at) {
  const rows = [];
  for (const document of ['resume', 'letter']) {
    const beforeHtml = generated?.[document] || '';
    const afterHtml = saved?.[document] || '';
    if (beforeHtml === afterHtml) continue;
    const before = contentBlocks(beforeHtml);
    const after = contentBlocks(afterHtml);
    const row = (block, extra) => rows.push({ id, at, document, section: block.section, kind: block.kind, ...extra });
    const { pairs, moved, freeBefore, rewrittenBefore, freeAfter } = pairBlocks(before, after);
    for (const [k, pair] of pairs.entries()) {
      const block = before[pair.i];
      const next = after[pair.j];
      const move = moved.has(k) ? { moved: true, to: next.section } : {};
      if (pair.rewritten) {
        row(block, { op: 'rewritten', chars: [block.text.length, next.text.length], wordsRemoved: pair.wordsRemoved, wordsAdded: pair.wordsAdded, ...move });
      } else if (moved.has(k)) row(block, { op: 'moved', to: next.section });
    }
    for (const i of freeBefore) if (!rewrittenBefore.has(i)) row(before[i], { op: 'removed', chars: [before[i].text.length, 0] });
    for (const j of freeAfter) row(after[j], { op: 'added', chars: [0, after[j].text.length] });
    if (!rows.some(item => item.document === document)) rows.push({ id, at, document, op: 'markup', section: '', kind: '' });
  }
  return rows;
}

const DIFF_TEXT_MAX = 500;
const cap = value => String(value || '').slice(0, DIFF_TEXT_MAX);

/**
 * The text of each added, removed or rewritten block, for the pre-generation
 * gate's handoff only (never stored). Moved-only blocks are not edits of content.
 */
export function editDiffs(generated, saved) {
  const rows = [];
  for (const document of ['resume', 'letter']) {
    const beforeHtml = generated?.[document] || '';
    const afterHtml = saved?.[document] || '';
    if (beforeHtml === afterHtml) continue;
    const before = contentBlocks(beforeHtml);
    const after = contentBlocks(afterHtml);
    const { pairs, freeBefore, rewrittenBefore, freeAfter } = pairBlocks(before, after);
    for (const pair of pairs) {
      if (!pair.rewritten) continue;
      const block = before[pair.i];
      rows.push({ document, section: block.section, kind: block.kind, op: 'rewritten', before: cap(block.text), after: cap(after[pair.j].text) });
    }
    for (const i of freeBefore) {
      if (!rewrittenBefore.has(i)) rows.push({ document, section: before[i].section, kind: before[i].kind, op: 'removed', before: cap(before[i].text), after: '' });
    }
    for (const j of freeAfter) rows.push({ document, section: after[j].section, kind: after[j].kind, op: 'added', before: '', after: cap(after[j].text) });
  }
  return rows;
}

function sinceSession(state) {
  return Number.isFinite(Date.parse(state?.lastSessionAt)) ? Date.parse(state.lastSessionAt) : -Infinity;
}

/** Non-superseded pairs since the last session with at least one content edit, oldest first. */
export function editedPairsSinceSession(state) {
  const since = sinceSession(state);
  return (state?.pairs || [])
    .filter(pair => !pair.supersededAt && Date.parse(pair.generatedAt) >= since)
    .sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)))
    .map(pair => ({ pair, diffs: editDiffs(pair.generated, pair.saved) }))
    .filter(entry => entry.diffs.length > 0);
}

export const GATE_PROMPT_VERSION = 1;
export const GATE_MIN_EDITED_BUNDLES = 3;
export const GATE_RECURRENCE_MIN = 3;

/** Changes exactly when the gate's handoff input could change. */
export function generationGateInputDigest(state, editedPairs) {
  return digest(JSON.stringify([
    GATE_PROMPT_VERSION,
    state?.lastSessionAt || '',
    (editedPairs || []).map(({ pair }) => [pair.id, pair.savedAt, pair.editNotesAt || '']),
  ]));
}

const GATE_KINDS = new Set(['truth', 'evidence', 'wording', 'structure', 'length', 'letter', 'other']);

function normalizeGate(record) {
  if (!record || typeof record !== 'object' || record.version !== 1 || typeof record.inputDigest !== 'string') return null;
  const patterns = (Array.isArray(record.patterns) ? record.patterns : [])
    .map(item => ({
      summary: String(item?.summary || '').trim().slice(0, 200),
      kind: GATE_KINDS.has(item?.kind) ? item.kind : 'other',
      bundles: [...new Set((Array.isArray(item?.bundles) ? item.bundles : []).filter(id => typeof id === 'string' && id))],
    }))
    .filter(item => item.summary && item.bundles.length > 0);
  return {
    version: 1,
    inputDigest: record.inputDigest,
    checkedAt: typeof record.checkedAt === 'string' ? record.checkedAt : null,
    lastSessionAt: typeof record.lastSessionAt === 'string' ? record.lastSessionAt : null,
    blocked: record.blocked === true,
    patterns,
    editedBundleCount: Number.isInteger(record.editedBundleCount) ? record.editedBundleCount : 0,
  };
}

/** The pre-generation gate's last result, or null. */
export async function readGenerationGate(root) {
  return serialize(async () => normalizeGate((await read(root)).generationGate));
}

/** Store (or, with null, clear) the gate record; the rest of the state is kept. */
export async function writeGenerationGate(root, record) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    const normalized = normalizeGate(record);
    if (normalized) state.generationGate = normalized;
    else delete state.generationGate;
    await write(root, state);
    return normalized;
  });
}

/** Read the state and its edited pairs in one consistent snapshot. */
export async function generationGateInputs(root) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    const editedPairs = editedPairsSinceSession(state);
    return { state, editedPairs, gate: normalizeGate(state.generationGate) };
  });
}

async function alignModel(root, state) {
  const label = modelLabel();
  if (state.modelLabel === label) return state;
  if (state.pairs?.length) {
    const archive = path.join(storePath(root), 'archive');
    await fs.promises.mkdir(archive, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(path.join(archive, `${Date.now()}-${crypto.randomUUID()}.json`), JSON.stringify({ modelLabel: state.modelLabel, pairs: state.pairs }), { mode: 0o600 });
  }
  return { ...state, modelLabel: label, countSinceSession: 0, pairs: [] };
}
function prune(state) {
  state.pairs = (state.pairs || []).slice(-MAX_PAIRS);
  state.summaries = (state.summaries || []).filter(row => Date.parse(row.at) >= Date.now() - SUMMARY_AGE_MS);
  return state;
}

export async function logGeneratedBundle({ root, workspaceDir, html, posting, appVersion }) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    const workspaceId = idFor(workspaceDir);
    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    const snapshot = documentSnapshot(html);
    if (!snapshot.resume) throw new Error('Cannot log a bundle without its résumé panel.');
    const build = appBuild();
    // A regeneration overwrites the folder's bundle, so the earlier pair was never
    // sent. Whether it was REJECTED is a different question: a regeneration under
    // a different build is a re-run of the posting under new code, and says
    // nothing about the earlier text. The reason is kept so a session can tell
    // the two apart (the 2026-10-19 session read five rebuild re-runs as rejections).
    for (const prior of state.pairs) {
      if (prior.workspaceId !== workspaceId || prior.supersededAt) continue;
      prior.supersededAt = at;
      prior.supersededReason = prior.build == null ? 'unknown-build' : prior.build !== build ? 'rebuild' : 'same-build';
      state.summaries.push({ id: prior.id, at, document: 'bundle', op: 'regenerated', section: '', kind: '', reason: prior.supersededReason });
    }
    const pair = {
      id, workspaceId, posting: String(posting || ''), generated: snapshot, saved: snapshot,
      generatedAt: at, savedAt: at, appVersion: String(appVersion || ''), build, modelLabel: state.modelLabel,
      letterRemoved: false,
    };
    state.pairs.push(pair);
    state.countSinceSession = (state.countSinceSession || 0) + 1;
    await write(root, prune(state));
    return pair;
  });
}

/**
 * The user's own stated reasons for their hand edits, typed in the workspace
 * sidebar. Kept on the pair only (never in summary rows), capped and stripped
 * of control characters other than newlines.
 */
export const EDIT_NOTES_MAX_CHARS = 4000;

export function normalizeEditNotes(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    // A tab is a word separator the user typed, not noise; keep the gap.
    .replace(/\t/g, ' ')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
    .trim()
    .slice(0, EDIT_NOTES_MAX_CHARS)
    .trim();
}

function applyEditNotes(pair, editNotes) {
  const text = normalizeEditNotes(editNotes);
  if (text) {
    pair.editNotes = text;
    pair.editNotesAt = new Date().toISOString();
  } else {
    delete pair.editNotes;
    delete pair.editNotesAt;
  }
  return text;
}

export async function logBundleEditNotes({ root, workspaceDir, editNotes }) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    const pair = state.pairs.findLast(item => item.workspaceId === idFor(workspaceDir));
    if (!pair) return null;
    const text = applyEditNotes(pair, editNotes);
    await write(root, state);
    return { editNotes: text };
  });
}

export async function bundleEditNotes({ root, workspaceDir }) {
  return serialize(async () => {
    const state = await read(root);
    const pair = (state.pairs || []).findLast(item => item.workspaceId === idFor(workspaceDir));
    if (!pair || state.modelLabel !== modelLabel()) return { editNotes: '', editNotesAt: null };
    return {
      editNotes: typeof pair.editNotes === 'string' ? pair.editNotes : '',
      editNotesAt: typeof pair.editNotesAt === 'string' ? pair.editNotesAt : null,
    };
  });
}

export async function logSavedBundle({ root, workspaceDir, html, letterRemoved = false, editNotes }) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    const pair = state.pairs.findLast(item => item.workspaceId === idFor(workspaceDir));
    if (!pair) return null; // Legacy workspaces have no generated baseline.
    const id = pair.id;
    const at = new Date().toISOString();
    pair.saved = documentSnapshot(html);
    pair.savedAt = at;
    if (typeof editNotes === 'string') applyEditNotes(pair, editNotes);
    if (letterRemoved || pair.saved.letterRemoved) {
      pair.generated.letter = null;
      pair.saved.letter = null;
      pair.letterRemoved = 'not needed';
    }
    state.pairs = state.pairs.filter(item => item.id !== id);
    state.pairs.push(pair);
    state.summaries = state.summaries.filter(row => row.id !== id || row.op === 'regenerated');
    state.summaries.push(...editSummaries(pair.generated, pair.saved, id, at));
    if (pair.letterRemoved) state.summaries.push({ id, at, document: 'letter', op: 'not needed', section: '', kind: '' });
    await write(root, prune(state));
    return pair;
  });
}

// The full session waits for a batch (SESSION_DUE_COUNT bundles) because a
// habit needs that much evidence to tell from noise. A SYSTEMATIC defect does
// not: it shows as the same section edited bundle after bundle, and the user
// fixes it by hand until a session notices. So a second, earlier signal reads
// recurrence rather than volume: one section of one document edited in
// RECURRING_MIN_BUNDLES of the last RECURRING_WINDOW accepted bundles logged
// since the last session. It suggests a session; it never starts one.
export const SESSION_DUE_COUNT = 50;
export const RECURRING_WINDOW = 8;
export const RECURRING_MIN_BUNDLES = 4;
const EDIT_OPS = new Set(['added', 'removed', 'rewritten', 'moved']);

/**
 * Sections edited in at least `min` of the last `window` accepted bundles
 * since the last session, most recurrent first: [{ document, section,
 * bundles, of }]. Superseded pairs never count (a rebuild re-run or a rejected
 * generation was not sent), and neither does a pair reviewed by a past session.
 */
export function recurringEditSections(state, { window = RECURRING_WINDOW, min = RECURRING_MIN_BUNDLES } = {}) {
  const since = Number.isFinite(Date.parse(state?.lastSessionAt)) ? Date.parse(state.lastSessionAt) : -Infinity;
  const recent = (state?.pairs || [])
    .filter(pair => !pair.supersededAt && Date.parse(pair.generatedAt) >= since)
    .sort((left, right) => String(left.generatedAt).localeCompare(String(right.generatedAt)))
    .slice(-window);
  if (recent.length < min) return [];
  const ids = new Set(recent.map(pair => pair.id));
  const bundlesByKey = new Map();
  for (const row of state?.summaries || []) {
    if (!ids.has(row.id) || !EDIT_OPS.has(row.op)) continue;
    const key = JSON.stringify([row.document, row.section || '']);
    if (!bundlesByKey.has(key)) bundlesByKey.set(key, new Set());
    bundlesByKey.get(key).add(row.id);
  }
  return [...bundlesByKey]
    .filter(([, bundles]) => bundles.size >= min)
    .map(([key, bundles]) => { const [document, section] = JSON.parse(key); return { document, section, bundles: bundles.size, of: recent.length }; })
    .sort((left, right) => right.bundles - left.bundles || left.document.localeCompare(right.document) || left.section.localeCompare(right.section));
}

export async function improvementStatus(root) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    await write(root, state);
    const count = state.countSinceSession || 0;
    const recurring = recurringEditSections(state);
    const gate = normalizeGate(state.generationGate);
    const generationGate = gate
      ? { blocked: gate.blocked, checkedAt: gate.checkedAt, patterns: gate.patterns.map(item => ({ summary: item.summary, count: item.bundles.length })) }
      : null;
    return { count, due: count >= SESSION_DUE_COUNT, earlyDue: recurring.length > 0, recurring, modelLabel: state.modelLabel, generationGate };
  });
}

export async function resetImprovementCounter(root) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    state.countSinceSession = 0;
    state.lastSessionAt = new Date().toISOString();
    // The session reviewed the recurring edits, so the refusal it answered ends here.
    delete state.generationGate;
    await write(root, state);
  });
}
