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
    // A regeneration overwrites the folder's bundle, so the earlier pair was never sent.
    for (const prior of state.pairs) {
      if (prior.workspaceId !== workspaceId || prior.supersededAt) continue;
      prior.supersededAt = at;
      state.summaries.push({ id: prior.id, at, document: 'bundle', op: 'regenerated', section: '', kind: '' });
    }
    const pair = {
      id, workspaceId, posting: String(posting || ''), generated: snapshot, saved: snapshot,
      generatedAt: at, savedAt: at, appVersion: String(appVersion || ''), build: appBuild(), modelLabel: state.modelLabel,
      letterRemoved: false,
    };
    state.pairs.push(pair);
    state.countSinceSession = (state.countSinceSession || 0) + 1;
    await write(root, prune(state));
    return pair;
  });
}

export async function logSavedBundle({ root, workspaceDir, html, letterRemoved = false }) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    const pair = state.pairs.findLast(item => item.workspaceId === idFor(workspaceDir));
    if (!pair) return null; // Legacy workspaces have no generated baseline.
    const id = pair.id;
    const at = new Date().toISOString();
    pair.saved = documentSnapshot(html);
    pair.savedAt = at;
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

export async function improvementStatus(root) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    await write(root, state);
    return { count: state.countSinceSession || 0, due: (state.countSinceSession || 0) >= 50, modelLabel: state.modelLabel };
  });
}

export async function resetImprovementCounter(root) {
  return serialize(async () => {
    const state = await alignModel(root, await read(root));
    state.countSinceSession = 0;
    state.lastSessionAt = new Date().toISOString();
    await write(root, state);
  });
}
