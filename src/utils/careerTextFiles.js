// Career data is plain text only. A Job Search module accepts .txt and .md
// files, read verbatim from disk; every other file type is refused before any
// work starts. There is no AI transcription route for PDFs, Word files or images.

export const CAREER_TEXT_EXTENSIONS = Object.freeze(['.txt', '.md']);

const extensionOf = (value) => {
  const name = String(value || '').split(/[\\/]/).pop() || '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
};

export function isCareerTextFileName(value) {
  return CAREER_TEXT_EXTENSIONS.includes(extensionOf(value));
}

export const CAREER_TEXT_ONLY_MESSAGE = 'Career files must be plain text (.txt or .md). Save a PDF or Word résumé as .txt or .md, then drop that file.';

// One sentence per refusal reason from readPlainTextDocumentWithReason, naming
// what to change in the file.
const REASON_DETAIL = Object.freeze({
  extension: 'it is not a .txt or .md file',
  sensitive: 'it is in a protected system or credential location',
  unreadable: 'it could not be read',
  too_large: 'it is larger than 4 MB',
  encoding: 'it is not saved as UTF-8 text; re-save it as UTF-8',
  hidden_chars: 'it contains invisible or control characters; retype or re-save it as plain text',
  hidden_markdown: 'it contains HTML, comments, link definitions or character codes that Markdown hides; remove them',
  code_block: 'it contains a fenced code block (```); remove it',
  markdown: 'it contains Markdown formatting that could not be read faithfully; simplify it or save it as .txt',
  empty: 'it has no text',
});

export function careerTextRefusalMessage(name, reason) {
  const detail = REASON_DETAIL[reason] || REASON_DETAIL.unreadable;
  return `${name || 'This file'} can't be used as career data: ${detail}.`;
}

export function careerFileNotTextError(name, reason) {
  const error = new Error(careerTextRefusalMessage(name, reason));
  error.code = 'CAREER_FILE_NOT_TEXT';
  error.reason = Object.hasOwn(REASON_DETAIL, reason) ? reason : 'unreadable';
  return error;
}
