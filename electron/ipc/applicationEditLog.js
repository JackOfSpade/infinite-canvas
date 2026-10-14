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

function editSummaries(generated, saved, id, at) {
  const rows = [];
  const visibleText = value => {
    const dom = new JSDOM(value);
    try { return dom.window.document.body.textContent || ''; }
    finally { dom.window.close(); }
  };
  for (const [kind, key] of [['resume', 'resume'], ['letter', 'letter']]) {
    const before = generated?.[key] || '';
    const after = saved?.[key] || '';
    if (before === after) continue;
    const beforeText = visibleText(before);
    const afterText = visibleText(after);
    const category = !after ? 'removed' : beforeText === afterText ? 'structure' : 'wording';
    const beforeLines = beforeText.split(/\n/);
    const afterLines = afterText.split(/\n/);
    let line = 0;
    while (line < Math.min(beforeLines.length, afterLines.length) && beforeLines[line] === afterLines[line]) line++;
    rows.push({ id, at, category, location: `${kind}:line-${line + 1}`, size: Math.abs(afterText.length - beforeText.length) });
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
    const pair = {
      id, workspaceId, posting: String(posting || ''), generated: snapshot, saved: snapshot,
      generatedAt: at, savedAt: at, appVersion: String(appVersion || ''), modelLabel: state.modelLabel,
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
    state.summaries = state.summaries.filter(row => row.id !== id);
    state.summaries.push(...editSummaries(pair.generated, pair.saved, id, at));
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
