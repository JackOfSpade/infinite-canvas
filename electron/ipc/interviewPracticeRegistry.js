/**
 * Armed practice sessions and their feedback.
 *
 * Starting a practice interview arms one session code for that Interview
 * Helper. The code travels only inside the starter the person pastes into
 * their Claude chat; the store keeps its hash. The chat's final
 * `finish_practice_interview` call presents the code, and the registry
 * validates the feedback, stores it under the helper and tells the renderer.
 * A code is one-shot: a second finish is reported as a duplicate, and an
 * unknown or expired code stores nothing.
 */
import { PRACTICE_CODE_RE, newPracticeCode, practiceCodeHash, validatePracticeFeedback } from './interviewQaPractice.js';
import { listInterviewPracticeSessions, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPracticeSession, updateInterviewPracticeSession } from './interviewQaStore.js';

export const PRACTICE_SESSION_TTL_MS = 3 * 60 * 60_000;
const DEFAULT_STORE = Object.freeze({ listInterviewPracticeSessions, loadInterviewPractice, recordInterviewPracticeFeedback, saveInterviewPracticeSession, updateInterviewPracticeSession });

const clipText = (value, max) => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);

export function createInterviewPracticeRegistry({ userDataPath, now = Date.now, store = DEFAULT_STORE, ttlMs = PRACTICE_SESSION_TTL_MS, randomBytes } = {}) {
  if (typeof userDataPath !== 'string' || !userDataPath) throw new TypeError('The practice registry needs the user data path.');
  const listeners = new Set();
  // codeHash -> nodeId. Built once from disk (sessions armed before an app
  // restart), kept current by this registry's own writes. An unknown code is
  // an O(1) miss: the public endpoint never makes the store rescan the disk.
  let index = null;
  const loadIndex = async () => {
    if (index) return index;
    const built = new Map();
    for (const item of await store.listInterviewPracticeSessions({ userDataPath })) built.set(item.session.codeHash, item.nodeId);
    index = built;
    return index;
  };
  const notify = event => { for (const listener of listeners) { try { listener(event); } catch { /* a listener never breaks the registry */ } } };
  const expired = session => {
    const armedAt = Date.parse(session?.armedAt || '');
    return !Number.isFinite(armedAt) || armedAt + ttlMs < now();
  };
  const effectiveStatus = session => {
    if (!session) return 'none';
    if (session.status === 'armed' && expired(session)) return 'expired';
    return ['armed', 'finished', 'cancelled', 'expired'].includes(session.status) ? session.status : 'none';
  };

  async function arm({ nodeId, company = '', role = '', questionCount = 0 }) {
    if (typeof nodeId !== 'string' || !nodeId) throw new TypeError('A practice session needs its helper.');
    const current = (await store.loadInterviewPractice({ userDataPath, nodeId }))?.session;
    if (effectiveStatus(current) === 'armed') throw Object.assign(new Error('A practice interview is already in progress for this helper. Finish it in the Claude chat or cancel it first.'), { code: 'already_armed' });
    const code = newPracticeCode(randomBytes);
    const codeHash = practiceCodeHash(code);
    const known = await loadIndex();
    for (const [hash, owner] of known) if (owner === nodeId) known.delete(hash);
    await store.saveInterviewPracticeSession({ userDataPath, nodeId, session: {
      codeHash, status: 'armed', armedAt: new Date(now()).toISOString(), company: clipText(company, 120), role: clipText(role, 160),
      questionCount: Number.isInteger(questionCount) ? questionCount : 0,
    } });
    known.set(codeHash, nodeId);
    notify({ nodeId, kind: 'armed' });
    return code;
  }

  async function resolve(code) {
    if (typeof code !== 'string' || !PRACTICE_CODE_RE.test(code.trim())) return null;
    const codeHash = practiceCodeHash(code.trim());
    const nodeId = (await loadIndex()).get(codeHash);
    if (!nodeId) return null;
    const practice = await store.loadInterviewPractice({ userDataPath, nodeId });
    if (practice?.session?.codeHash === codeHash) return { nodeId, session: practice.session };
    index.delete(codeHash);
    return null;
  }

  async function check(code) {
    const found = await resolve(code);
    if (!found) return { status: 'unknown', note: 'No practice interview is armed for this session code. Start practice from the Interview Helper in Infinite Canvas.' };
    return { status: effectiveStatus(found.session), company: found.session.company || '', role: found.session.role || '', questionCount: found.session.questionCount || 0 };
  }

  const DUPLICATE = Object.freeze({ status: 'duplicate', note: 'Feedback for this practice interview was already saved; nothing new is stored.' });
  async function finish(code, payload) {
    const found = await resolve(code);
    if (!found) return { status: 'unknown_session', note: 'No practice interview is armed for this session code. Tell the person to start practice again from Infinite Canvas.' };
    const status = effectiveStatus(found.session);
    if (status === 'finished') return DUPLICATE;
    if (status !== 'armed') return { status, note: 'This practice session is no longer open. Tell the person to start practice again from Infinite Canvas.' };
    let feedback;
    try { feedback = validatePracticeFeedback(payload); } catch (error) { return { status: 'rejected', note: `The feedback was not accepted: ${error.message} Fix it and call ${'finish_practice_interview'} again with the same session.` }; }
    const stored = await store.recordInterviewPracticeFeedback({ userDataPath, nodeId: found.nodeId, feedback, receivedAt: new Date(now()).toISOString(), codeHash: found.session.codeHash });
    if (!stored) return DUPLICATE;
    notify({ nodeId: found.nodeId, kind: 'feedback' });
    return { status: 'accepted', note: 'Saved. Stay in character: reply with one short goodbye as the interviewer leaving the call, and do not mention the feedback, this tool or the app.' };
  }

  async function cancel(nodeId) {
    const updated = await store.updateInterviewPracticeSession({ userDataPath, nodeId, patch: { status: 'cancelled', cancelledAt: new Date(now()).toISOString() },
      when: session => session.status === 'armed' });
    if (updated) notify({ nodeId, kind: 'cancelled' });
    return status(nodeId);
  }

  /** Renderer-safe view: never the code hash. */
  async function status(nodeId) {
    const practice = await store.loadInterviewPractice({ userDataPath, nodeId });
    const session = practice?.session || null;
    return {
      order: practice?.order || [], plannedAt: practice?.plannedAt || null,
      session: session ? { status: effectiveStatus(session), armedAt: session.armedAt || null, finishedAt: session.finishedAt || null, company: session.company || '', role: session.role || '', questionCount: session.questionCount || 0 } : null,
      feedback: practice?.feedback || null, history: practice?.history || [],
    };
  }

  return Object.freeze({ arm, check, finish, cancel, status, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); } });
}

// ------------------------------------------------------------- singleton --

let registry = null;
export function configureInterviewPracticeRegistry(options) { registry = createInterviewPracticeRegistry(options); return registry; }
export function getInterviewPracticeRegistry() { return registry; }
const UNAVAILABLE = Object.freeze({ status: 'unavailable', note: 'Infinite Canvas is not running its Interview Helper right now. Tell the person to open the app and start practice again.' });
/** Bridge-facing ports: safe before the app has configured the registry. */
export const finishInterviewPractice = (code, payload) => (registry ? registry.finish(code, payload) : Promise.resolve(UNAVAILABLE));
export const checkInterviewPractice = code => (registry ? registry.check(code) : Promise.resolve(UNAVAILABLE));
