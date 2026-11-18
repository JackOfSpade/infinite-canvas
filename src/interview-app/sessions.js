// Pure state helpers for the standalone Interview Helper's list of interviews.
// One interview carries the same fields an Interview Helper node carried.

import { INTERVIEW_RUN_ID_RE } from '../utils/interviewRunIdGrammar.js';

export function emptyInterviewData() {
  return {
    interviewHelperSourceNodeId: null,
    interviewHelperSourceSnapshotId: null,
    interviewHelperCareerMode: null,
    interviewHelperCareerGeneration: null,
    interviewHelperCareerCompilation: null,
    interviewHelperCareerSnapshotId: null,
    interviewHelperCareerFingerprint: null,
    interviewHelperCareerFilenames: [],
    interviewHelperJobUrl: null,
    interviewHelperApplicationBundle: null,
    interviewHelperTypedJob: null,
    interviewHelperTypedJobKind: null,
    interviewHelperTypedJobNotes: null,
    interviewHelperPreparation: null,
    interviewHelperPreparationRecordId: null,
    interviewHelperPreparationInputBinding: null,
    interviewHelperPreparationInputDigest: null,
    interviewHelperPreparationRunId: null,
    interviewHelperManualAiCleanup: null,
    interviewHelperManualAiRetirementReceipts: null,
    interviewHelperLockedPlan: null,
    interviewHelperCurrentStep: 0,
  };
}

/** What the list shows: a name the user typed, else the chosen application, else a placeholder. */
export function interviewTitle(session) {
  const typed = typeof session?.title === 'string' ? session.title.trim() : '';
  if (typed) return typed;
  const label = session?.data?.interviewHelperApplicationBundle?.label;
  return typeof label === 'string' && label.trim() ? label.trim() : 'New interview';
}

export function addInterview(state, { id, now = Date.now(), data = null, title = '' }) {
  if (state.sessions.some(session => session.id === id)) return state;
  const session = { id, title, createdAt: now, data: { ...emptyInterviewData(), ...(data || {}) } };
  return { ...state, sessions: [...state.sessions, session], selectedId: id };
}

export function patchInterview(state, id, patch) {
  let changed = false;
  const sessions = state.sessions.map((session) => {
    if (session.id !== id) return session;
    changed = true;
    return { ...session, data: { ...session.data, ...patch } };
  });
  return changed ? { ...state, sessions } : state;
}

export function renameInterview(state, id, title) {
  return { ...state, sessions: state.sessions.map(session => (session.id === id ? { ...session, title: String(title || '').slice(0, 200) } : session)) };
}

export function removeInterview(state, id) {
  const sessions = state.sessions.filter(session => session.id !== id);
  if (sessions.length === state.sessions.length) return state;
  return { ...state, sessions, selectedId: state.selectedId === id ? (sessions[0]?.id || null) : state.selectedId };
}

/**
 * Add interviews read from a canvas file. An id that already exists here is
 * skipped, never overwritten: the copy in this app is the newer one.
 */
export function importCanvasInterviews(state, interviews, now = Date.now()) {
  let next = state;
  let added = 0;
  for (const item of Array.isArray(interviews) ? interviews : []) {
    if (!item || typeof item.id !== 'string' || next.sessions.some(session => session.id === item.id)) continue;
    next = addInterview(next, { id: item.id, now, data: item.data });
    added += 1;
  }
  return { state: next, added, skipped: (Array.isArray(interviews) ? interviews.length : 0) - added };
}

export const RUN_ID_RE = INTERVIEW_RUN_ID_RE;

/** Worker run ids an interview may still own, so deleting it can retire them. */
export function interviewRunIds(data) {
  const ids = [
    data?.interviewHelperCareerCompilation?.manualAiRunId,
    data?.interviewHelperPreparationRunId,
    data?.interviewHelperManualAiCleanup?.runId,
    ...(Array.isArray(data?.interviewHelperManualAiRetirementReceipts) ? data.interviewHelperManualAiRetirementReceipts.map(receipt => receipt?.runId) : []),
  ];
  return [...new Set(ids.filter(id => typeof id === 'string' && RUN_ID_RE.test(id)))];
}
