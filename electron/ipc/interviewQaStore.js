/**
 * Editable Interview Q&A: one global Foundation set (questions asked at every
 * interview, shared by every Interview Helper) and one Company set per helper.
 *
 * Cards keep the sealed answer-bank card shape (headline/bullets/example with
 * evidence IDs) plus `scope`, `origin`, `source`, `author` and `status`, so the
 * live window can match and display them like prepared cards.
 *
 * Preparation is FILL-ONLY: a card whose answer is not empty (generated or
 * written by the user) is never replaced; only empty or new questions receive
 * generated answers, and a deleted question (tombstone) never returns.
 *
 * Files are private main-process data (0600 under a 0700 directory, atomic
 * replace, no symlinks). User-authored text is trusted as the user's own words
 * and is only bounds-checked.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { INTERVIEW_FOUNDATION_QUESTIONS } from '../../src/utils/interviewAnswerQuestions.js';

export const INTERVIEW_QA_DIRECTORY = 'interview-helper-qa';
const STORE_VERSION = 1;
const MAX_STORE_BYTES = 2 * 1024 * 1024;
const MAX_CARDS = 80;
const MAX_QUESTION = 300;
const MAX_LINE = 600;
const MAX_EXAMPLE = 1200;
const MAX_BULLETS = 6;
const MAX_EXTENSIONS = 6;
const MAX_VARIANTS = 8;
const MAX_TOMBSTONES = 200;
const MAX_LINKS = 40;
const SCOPES = new Set(['foundation', 'company']);
const ORIGINS = new Set(['catalog', 'disclosed', 'posting', 'research', 'user']);
// Control characters other than tab/newline/carriage return are refused.
const hasControl = value => [...value].some(character => { const code = character.codePointAt(0); return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127; });

export const normalizeQuestion = value => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const FOUNDATION_KEYS = new Set(INTERVIEW_FOUNDATION_QUESTIONS.map(item => normalizeQuestion(item.question)));
export const isFoundationQuestion = question => FOUNDATION_KEYS.has(normalizeQuestion(question));

const text = (value, max) => typeof value === 'string' && value.length <= max && !hasControl(value);
const statementText = statement => (typeof statement === 'string' ? statement : statement?.text || '').trim();

/** A card is answered when its headline, any bullet or its example has text. */
export function isAnsweredCard(card) {
  return !!(statementText(card?.headline) || (card?.bullets || []).some(item => statementText(item)) || statementText(card?.example));
}

function cardStatus(card) {
  if (isAnsweredCard(card)) return 'ready';
  return card?.origin === 'disclosed' || card?.origin === 'posting' ? 'needs-prep' : 'empty';
}

// ---------------------------------------------------------------- storage --

async function storeRoot(userDataPath) {
  if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) throw new Error('Interview Q&A storage is unavailable.');
  const root = path.join(userDataPath, INTERVIEW_QA_DIRECTORY);
  await fs.promises.mkdir(path.join(root, 'company'), { recursive: true, mode: 0o700 });
  for (const directory of [root, path.join(root, 'company')]) {
    const stat = await fs.promises.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Interview Q&A storage is unsafe.');
  }
  return root;
}

function storeFile(root, scope, nodeId) {
  if (scope === 'foundation') return path.join(root, 'foundation.json');
  const key = crypto.createHash('sha256').update(String(nodeId)).digest('hex');
  return path.join(root, 'company', `${key}.json`);
}

function emptyStore(scope) {
  return { version: STORE_VERSION, scope, company: '', cards: [], tombstones: [], foundationLinks: [] };
}

async function readStore(userDataPath, scope, nodeId) {
  const file = storeFile(await storeRoot(userDataPath), scope, nodeId);
  let stat;
  try { stat = await fs.promises.lstat(file); } catch { return emptyStore(scope); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) throw new Error('Interview Q&A storage is unsafe.');
  let parsed;
  try { parsed = JSON.parse(await fs.promises.readFile(file, 'utf8')); } catch { throw new Error('Interview Q&A storage is unreadable.'); }
  if (!parsed || parsed.version !== STORE_VERSION || parsed.scope !== scope || !Array.isArray(parsed.cards)) throw new Error('Interview Q&A storage is unreadable.');
  return {
    ...emptyStore(scope), ...parsed,
    cards: parsed.cards.filter(card => card && typeof card.id === 'string' && typeof card.question === 'string').slice(0, MAX_CARDS),
    tombstones: Array.isArray(parsed.tombstones) ? parsed.tombstones.filter(item => typeof item === 'string').slice(-MAX_TOMBSTONES) : [],
    foundationLinks: Array.isArray(parsed.foundationLinks) ? parsed.foundationLinks.slice(0, MAX_LINKS) : [],
  };
}

async function writeStore(userDataPath, scope, nodeId, store) {
  const root = await storeRoot(userDataPath);
  const file = storeFile(root, scope, nodeId);
  const encoded = JSON.stringify({ ...store, version: STORE_VERSION, scope });
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STORE_BYTES) throw new Error('Interview Q&A is too large to save.');
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tmp, encoded, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await fs.promises.rename(tmp, file);
  } finally { await fs.promises.rm(tmp, { force: true }).catch(() => {}); }
}

// Every store write for one file is serialized so concurrent edits from two
// helpers (both editing the shared Foundation set) cannot lose an update.
const queues = new Map();
function serialized(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.then(task);
  // The queue tail never rejects: a failed edit is reported to its caller
  // through `next`, and must not become an unhandled rejection here.
  const tail = next.catch(() => {}).finally(() => { if (queues.get(key) === tail) queues.delete(key); });
  queues.set(key, tail);
  return next;
}
const queueKey = (userDataPath, scope, nodeId) => `${userDataPath}\u0000${scope}\u0000${scope === 'company' ? nodeId : ''}`;

// ------------------------------------------------------------- projection --

/** Public, renderer-safe projection (no evidence IDs or private quotes). */
export function toQaCard(card, scope) {
  return {
    id: card.id, scope, question: card.question,
    variants: Array.isArray(card.variants) ? card.variants.filter(item => typeof item === 'string').slice(0, MAX_VARIANTS) : [],
    headline: statementText(card.headline),
    bullets: (card.bullets || []).map(item => ({ ...(typeof item?.stage === 'string' ? { stage: item.stage } : {}), text: statementText(item) })).filter(item => item.text),
    example: statementText(card.example),
    extensions: (card.extensions || []).map((item, index) => ({ id: typeof item?.id === 'string' ? item.id : `ext-${index + 1}`, text: statementText(item) })).filter(item => item.text),
    origin: ORIGINS.has(card.origin) ? card.origin : 'catalog',
    source: card.source && typeof card.source.url === 'string' ? { url: card.source.url, date: String(card.source.date || 'unknown'), quote: String(card.source.quote || '') } : null,
    author: card.author === 'user' ? 'user' : 'generated',
    status: cardStatus(card),
    thinEvidence: card.thinEvidence === true,
  };
}

function section(store, scope) {
  const cards = store.cards.map(card => toQaCard(card, scope));
  const status = !cards.length ? 'missing' : cards.every(card => card.status === 'ready') ? 'ready' : 'partial';
  return scope === 'company'
    ? { status, company: store.company || '', cards, foundationLinks: store.foundationLinks.map(link => ({ foundationQuestion: link.foundationQuestion, question: link.question, sourceUrl: link.sourceUrl })) }
    : { status, cards };
}

export async function loadInterviewQa({ userDataPath, nodeId }) {
  const [foundation, company] = await Promise.all([readStore(userDataPath, 'foundation', nodeId), readStore(userDataPath, 'company', nodeId)]);
  return { foundation: section(foundation, 'foundation'), company: section(company, 'company') };
}

// ------------------------------------------------------------- user edits --

function userStatement(value, max) {
  const value_ = typeof value === 'string' ? value.trim() : '';
  if (!text(value_, max)) throw new Error('This Q&A text is too long or contains unsupported characters.');
  return { text: value_, evidenceIds: [], quotes: [] };
}

/** Validate and normalize a user edit payload into the stored card shape. */
export function userCardFromPayload(payload, { id }) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('This Q&A card is invalid.');
  const question = typeof payload.question === 'string' ? payload.question.trim() : '';
  if (!question || !text(question, MAX_QUESTION)) throw new Error('Write a question (up to 300 characters) before saving.');
  const variants = (Array.isArray(payload.variants) ? payload.variants : []).map(item => String(item || '').trim()).filter(Boolean);
  if (variants.length > MAX_VARIANTS || variants.some(item => !text(item, MAX_QUESTION))) throw new Error('Keep at most 8 short question variants.');
  const bullets = (Array.isArray(payload.bullets) ? payload.bullets : []).map(item => (typeof item === 'string' ? item : item?.text) || '').map(item => item.trim()).filter(Boolean);
  if (bullets.length > MAX_BULLETS) throw new Error('Keep at most 6 recall bullets.');
  const extensions = (Array.isArray(payload.extensions) ? payload.extensions : []).map(item => (typeof item === 'string' ? item : item?.text) || '').map(item => item.trim()).filter(Boolean);
  if (extensions.length > MAX_EXTENSIONS) throw new Error('Keep at most 6 extension points.');
  return {
    id, question, variants,
    headline: userStatement(payload.headline || '', MAX_LINE),
    bullets: bullets.map(item => ({ stage: 'point', ...userStatement(item, MAX_LINE) })),
    example: userStatement(payload.example || '', MAX_EXAMPLE),
    extensions: extensions.map((item, index) => ({ id: `user-ext-${index + 1}`, ...userStatement(item, MAX_LINE) })),
    consistency: { consistentWithResume: false, resumeQuote: '' },
    thinEvidence: false,
    author: 'user', updatedAt: new Date().toISOString(),
  };
}

function assertScope(scope) { if (!SCOPES.has(scope)) throw new Error('This Q&A section is invalid.'); }

export async function saveInterviewQaCard({ userDataPath, nodeId, scope, card }) {
  assertScope(scope);
  return serialized(queueKey(userDataPath, scope, nodeId), async () => {
    const store = await readStore(userDataPath, scope, nodeId);
    const index = store.cards.findIndex(item => item.id === card?.id);
    if (index < 0) throw new Error('This Q&A card no longer exists. Reload Q&A and try again.');
    const previous = store.cards[index];
    const edited = userCardFromPayload(card, { id: previous.id });
    store.cards[index] = { ...edited, origin: previous.origin || 'catalog', source: previous.source || null };
    await writeStore(userDataPath, scope, nodeId, store);
    return section(store, scope);
  });
}

export async function addInterviewQaCard({ userDataPath, nodeId, scope, card }) {
  assertScope(scope);
  return serialized(queueKey(userDataPath, scope, nodeId), async () => {
    const store = await readStore(userDataPath, scope, nodeId);
    if (store.cards.length >= MAX_CARDS) throw new Error('This Q&A section is full. Delete a card first.');
    const added = userCardFromPayload(card, { id: `user-${crypto.randomBytes(6).toString('hex')}` });
    if (store.cards.some(item => normalizeQuestion(item.question) === normalizeQuestion(added.question))) throw new Error('That question is already in this section.');
    store.cards.push({ ...added, origin: 'user', source: null });
    store.tombstones = store.tombstones.filter(item => item !== normalizeQuestion(added.question));
    await writeStore(userDataPath, scope, nodeId, store);
    return section(store, scope);
  });
}

export async function deleteInterviewQaCard({ userDataPath, nodeId, scope, cardId }) {
  assertScope(scope);
  return serialized(queueKey(userDataPath, scope, nodeId), async () => {
    const store = await readStore(userDataPath, scope, nodeId);
    const card = store.cards.find(item => item.id === cardId);
    if (!card) throw new Error('This Q&A card no longer exists. Reload Q&A and try again.');
    store.cards = store.cards.filter(item => item !== card);
    // A deleted generated question must not come back on the next Prepare.
    store.tombstones = [...store.tombstones.filter(item => item !== normalizeQuestion(card.question)), normalizeQuestion(card.question)].slice(-MAX_TOMBSTONES);
    await writeStore(userDataPath, scope, nodeId, store);
    return section(store, scope);
  });
}

// ------------------------------------------------------------- fill-only --

function generatedCard(card, { origin = 'catalog', source = null } = {}) {
  return { ...structuredClone(card), origin, source, author: 'generated', updatedAt: new Date().toISOString() };
}

function fillCards(store, incoming) {
  const tombstoned = new Set(store.tombstones);
  for (const card of incoming) {
    const key = normalizeQuestion(card.question);
    if (tombstoned.has(key)) continue;
    const index = store.cards.findIndex(item => normalizeQuestion(item.question) === key);
    if (index < 0) { if (store.cards.length < MAX_CARDS) store.cards.push(card); continue; }
    const existing = store.cards[index];
    // FILL-ONLY: an answer that is not empty is kept, whoever wrote it.
    if (isAnsweredCard(existing)) {
      if (card.variants?.length) existing.variants = [...new Set([...(existing.variants || []), ...card.variants])].slice(0, MAX_VARIANTS);
      continue;
    }
    store.cards[index] = { ...card, id: existing.id, variants: [...new Set([...(existing.variants || []), ...(card.variants || [])])].slice(0, MAX_VARIANTS),
      origin: existing.origin || card.origin, source: existing.source || card.source };
  }
}

/**
 * Merge a freshly sealed answer bank and mapped disclosures into the stores.
 * `disclosureMapping` items: { question, sourceUrl, sourceDate, evidenceQuote,
 * target: 'foundation' | 'company' | 'none', cardQuestion }.
 */
export async function fillInterviewQaFromPreparation({ userDataPath, nodeId, bank, company = '', disclosureMapping = [] }) {
  const generated = (bank?.cards || []).filter(isAnsweredCard);
  const foundationIncoming = generated.filter(card => isFoundationQuestion(card.question)).map(card => generatedCard(card));
  const companyIncoming = generated.filter(card => !isFoundationQuestion(card.question)).map(card => generatedCard(card));
  const links = [];
  for (const item of disclosureMapping) {
    const source = { url: item.sourceUrl, date: item.sourceDate || 'unknown', quote: item.evidenceQuote || '' };
    if (item.target === 'foundation' && item.cardQuestion) {
      links.push({ foundationQuestion: item.cardQuestion, question: item.question, sourceUrl: item.sourceUrl });
    } else if (item.target === 'company' && item.cardQuestion) {
      const card = companyIncoming.find(entry => normalizeQuestion(entry.question) === normalizeQuestion(item.cardQuestion));
      if (card) {
        card.variants = [...new Set([...(card.variants || []), item.question])].slice(0, MAX_VARIANTS);
        if (!card.source) { card.origin = 'disclosed'; card.source = source; }
      }
    } else if (!companyIncoming.some(entry => normalizeQuestion(entry.question) === normalizeQuestion(item.question))) {
      companyIncoming.push({ id: `disclosed-${crypto.createHash('sha256').update(normalizeQuestion(item.question)).digest('hex').slice(0, 12)}`,
        question: item.question, variants: [], headline: { text: '', evidenceIds: [], quotes: [] }, bullets: [],
        example: { text: '', evidenceIds: [], quotes: [] }, extensions: [], consistency: { consistentWithResume: false, resumeQuote: '' },
        thinEvidence: false, origin: 'disclosed', source, author: 'generated', updatedAt: new Date().toISOString() });
    }
  }
  await serialized(queueKey(userDataPath, 'foundation', nodeId), async () => {
    const store = await readStore(userDataPath, 'foundation', nodeId);
    fillCards(store, foundationIncoming);
    await writeStore(userDataPath, 'foundation', nodeId, store);
  });
  await serialized(queueKey(userDataPath, 'company', nodeId), async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    fillCards(store, companyIncoming);
    if (company) store.company = String(company).slice(0, 200);
    const seen = new Set(store.foundationLinks.map(link => `${normalizeQuestion(link.foundationQuestion)}|${normalizeQuestion(link.question)}`));
    for (const link of links) {
      const key = `${normalizeQuestion(link.foundationQuestion)}|${normalizeQuestion(link.question)}`;
      if (!seen.has(key)) { seen.add(key); store.foundationLinks.push(link); }
    }
    store.foundationLinks = store.foundationLinks.slice(-MAX_LINKS);
    await writeStore(userDataPath, 'company', nodeId, store);
  });
  return loadInterviewQa({ userDataPath, nodeId });
}

/** Live-window cards: Foundation then Company, each tagged with its scope. */
export async function loadInterviewQaLiveCards({ userDataPath, nodeId }) {
  const [foundation, company] = await Promise.all([readStore(userDataPath, 'foundation', nodeId), readStore(userDataPath, 'company', nodeId)]);
  return [
    ...foundation.cards.map(card => ({ ...card, scope: 'foundation' })),
    ...company.cards.map(card => ({ ...card, scope: 'company' })),
  ];
}

// ---------------------------------------------------------------- practice --

const MAX_PRACTICE_HISTORY = 10;
const practiceOf = store => (store.practice && typeof store.practice === 'object' && !Array.isArray(store.practice) ? store.practice : {});
const validOrder = order => (Array.isArray(order) ? order : []).filter(item => typeof item === 'string' && text(item, MAX_QUESTION)).slice(0, MAX_CARDS);
const hasPractice = practice => !!(practice.order?.length || practice.session || practice.feedback || practice.history?.length);

/** Save the AI-planned practice order (the Claude interviewer gets it as a plan). */
export async function saveInterviewPractice({ userDataPath, nodeId, practice }) {
  const order = validOrder(practice?.order);
  return serialized(queueKey(userDataPath, 'company', nodeId), async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    store.practice = { ...practiceOf(store), order, plannedAt: new Date().toISOString() };
    await writeStore(userDataPath, 'company', nodeId, store);
    return store.practice;
  });
}

export async function loadInterviewPractice({ userDataPath, nodeId }) {
  const practice = practiceOf(await readStore(userDataPath, 'company', nodeId));
  return hasPractice(practice) ? { order: validOrder(practice.order), plannedAt: practice.plannedAt || null, session: practice.session || null, feedback: practice.feedback || null, history: Array.isArray(practice.history) ? practice.history : [] } : null;
}

/** Arm (or replace) the one practice session of this helper; the code itself is never stored. */
export async function saveInterviewPracticeSession({ userDataPath, nodeId, session }) {
  if (!session || typeof session.codeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(session.codeHash)) throw new Error('A practice session needs a code hash.');
  return serialized(queueKey(userDataPath, 'company', nodeId), async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    store.practice = { ...practiceOf(store), session: { ...session, nodeId: String(nodeId) } };
    await writeStore(userDataPath, 'company', nodeId, store);
    return store.practice.session;
  });
}

export async function updateInterviewPracticeSession({ userDataPath, nodeId, patch }) {
  return serialized(queueKey(userDataPath, 'company', nodeId), async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const practice = practiceOf(store);
    if (!practice.session) return null;
    store.practice = { ...practice, session: { ...practice.session, ...patch } };
    await writeStore(userDataPath, 'company', nodeId, store);
    return store.practice.session;
  });
}

/** Store the feedback of a finished practice interview, keeping earlier ones as history. */
export async function recordInterviewPracticeFeedback({ userDataPath, nodeId, feedback, receivedAt = new Date().toISOString(), codeHash = null }) {
  return serialized(queueKey(userDataPath, 'company', nodeId), async () => {
    const store = await readStore(userDataPath, 'company', nodeId);
    const practice = practiceOf(store);
    // The one-shot decision is made here, inside the file's queue: two finish
    // calls racing on the same code cannot both pass a check made outside it.
    if (codeHash && (practice.session?.status !== 'armed' || practice.session.codeHash !== codeHash)) return null;
    const history = Array.isArray(practice.history) ? practice.history : [];
    const entry = { ...feedback, receivedAt, session: practice.session ? { armedAt: practice.session.armedAt || null, company: practice.session.company || '', role: practice.session.role || '' } : null };
    store.practice = {
      ...practice, feedback: entry,
      history: [...(practice.feedback ? [practice.feedback] : []), ...history].slice(0, MAX_PRACTICE_HISTORY),
      session: practice.session ? { ...practice.session, status: 'finished', finishedAt: receivedAt } : null,
    };
    await writeStore(userDataPath, 'company', nodeId, store);
    return entry;
  });
}

/** Every helper's practice session (for the registry's in-memory index). */
export async function listInterviewPracticeSessions({ userDataPath }) {
  const root = await storeRoot(userDataPath);
  let names = [];
  try { names = await fs.promises.readdir(path.join(root, 'company')); } catch { return []; }
  const sessions = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
    let parsed;
    try {
      const file = path.join(root, 'company', name);
      const stat = await fs.promises.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_STORE_BYTES) continue;
      parsed = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch { continue; }
    const session = parsed?.practice?.session;
    if (session && typeof session.codeHash === 'string' && typeof session.nodeId === 'string') sessions.push({ nodeId: session.nodeId, session });
  }
  return sessions;
}

/** Find the helper whose practice session carries this code hash. */
export async function findInterviewPracticeSession({ userDataPath, codeHash }) {
  if (typeof codeHash !== 'string' || !/^[a-f0-9]{64}$/u.test(codeHash)) return null;
  return (await listInterviewPracticeSessions({ userDataPath })).find(item => item.session.codeHash === codeHash) || null;
}
