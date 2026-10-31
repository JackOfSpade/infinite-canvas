// Maps a rejected interview-window:submit-question to fixed, path-free text.
// Electron wraps an IPC rejection as "Error invoking remote method '<channel>': Error: <reason>", so each
// reason is matched as a substring. Keep these reasons in step with submitQuestion in electron/interviewWindow.js
// and the preload guard in electron/interviewWindowPreload.js. Anything unrecognised stays generic: the raw text is never shown.
export const INVALID_QUESTION_MESSAGE = 'Enter a short interview question (up to 2,000 characters).';
export const SESSION_ENDED_MESSAGE = 'This interview session has ended. Close this window and launch it again from the Interview Helper.';
export const EVIDENCE_UNAVAILABLE_MESSAGE = 'The saved career evidence is unavailable or has changed. Try again, or launch this window again from the Interview Helper.';
export const SUBMIT_FAILED_MESSAGE = 'The question could not be checked. Try again, or launch this window again from the Interview Helper.';
export function interviewIgnoredMessage(result) {
  return typeof result?.message === 'string' && result.message.trim() ? result.message.trim()
    : 'This question could not be answered. Your draft is saved. Add detail or choose a prepared question.';
}
const REASONS = Object.freeze([
  ['Interview follow-up is invalid.', 'Ask about this example (for example, “What did you learn?”), or choose Next question for a new topic.'],
  ['Interview example is not available.', 'Choose a saved example before asking a follow-up.'],
  ['Interview question is invalid.', INVALID_QUESTION_MESSAGE],
  ['Interview question must be a bounded string.', INVALID_QUESTION_MESSAGE],
  ['Interview session is not available.', SESSION_ENDED_MESSAGE],
  ['Interview Window snapshot is unavailable.', EVIDENCE_UNAVAILABLE_MESSAGE],
]);
export function interviewSubmitErrorMessage(error) {
  const raw = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
  return REASONS.find(([reason]) => raw.includes(reason))?.[1] || SUBMIT_FAILED_MESSAGE;
}
