import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';

// execFile (no shell) with an args array — never interpolate a caller-controlled
// file path into a shell string. `/usr/bin/textutil` is the absolute path.
const execFileAsync = promisify(execFile);
const TEXTUTIL = '/usr/bin/textutil';

// Word documents can't be handed to the LLMs as inline data: Gemini's API rejects
// the OOXML MIME ("400 Unsupported MIME type") and reading the bytes as UTF-8 for
// Claude yields ZIP/binary garbage. macOS's built-in `textutil` (ships with every
// Mac — same posture as `sips` in heicUtils.js) extracts clean plain text from
// BOTH the modern .docx (OOXML) and legacy .doc via the Cocoa text stack. We send
// that TEXT instead, which every provider accepts.
export const WORD_DOC_EXT = new Set(['.docx', '.doc']);

export function isWordDoc(filePath) {
  return WORD_DOC_EXT.has(path.extname(String(filePath || '')).toLowerCase());
}

/**
 * Extract plain text from a Word (.docx / legacy .doc) file via macOS `textutil`.
 * `-stdout` streams the text out (no temp file), so it works without scratch-dir
 * access. macOS-only: throws elsewhere with an actionable message (the app already
 * depends on macOS CLIs — sips for images, textutil here). Throws on empty output
 * so an unreadable/corrupt file fails loud rather than silently parsing to nothing.
 */
export async function extractWordText(filePath) {
  if (process.platform !== 'darwin') {
    throw new Error('Reading .docx/.doc resumes requires macOS (textutil). Save as PDF and try again.');
  }
  const { stdout } = await execFileAsync(
    TEXTUTIL,
    ['-convert', 'txt', '-stdout', filePath],
    { maxBuffer: 25 * 1024 * 1024 }, // a résumé is tiny; bound it defensively
  );
  const text = String(stdout || '').trim();
  if (!text) {
    throw new Error(`Could not extract any text from ${path.basename(filePath)} — the file may be empty or corrupt.`);
  }
  return text;
}
