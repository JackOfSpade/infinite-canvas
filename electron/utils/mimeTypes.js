/**
 * Shared MIME-type tables for the AI providers (Claude + Gemini). Both build
 * file parts from the same extension→MIME mapping, so it lives here once —
 * adding a new supported format updates every provider at once instead of
 * drifting between claude.js and gemini.js. Module-level so they're not
 * re-allocated per call.
 */

export const IMAGE_MIME_MAP = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.heic': 'image/heic', '.heif': 'image/heic',
};

export const DOCUMENT_MIME_MAP = {
  '.pdf':  'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt':  'text/plain',
  '.md':   'text/plain',
  '.json': 'text/plain',
  '.js':   'text/plain',
  '.py':   'text/plain',
};
