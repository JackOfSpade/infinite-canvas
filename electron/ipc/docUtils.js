import fs from 'node:fs/promises';
import path from 'path';
import { isSensitivePath } from '../utils/pathSafety.js';

// A dropped .md/.txt career file needs no AI transcription pass: the "faithful,
// complete plain-text representation" the career-file extractor asks a model to
// produce IS the file's own bytes. On the copy/paste transport that round trip
// costs a whole manual handoff (attach the file to a chat, wait, copy the reply
// back) and buys only risk - anything the chat application renders as a widget
// rather than as text vanishes from the copied reply, silently. Reading the file
// directly is byte-faithful instead of model-approximate, which also strengthens
// the achievement miner's verbatim-quote grounding (aiSchemas.js requires quotes
// to appear in the career data exactly as written).
export const PLAIN_TEXT_EXT = new Set(['.txt', '.text', '.md', '.markdown']);
const MARKDOWN_EXT = new Set(['.md', '.markdown']);

// The extractor contract this reader stands in for asks for PLAIN text with
// "simple line breaks and '- ' bullets" - not Markdown - and a transcribing
// model duly dropped the syntax. Several downstream parsers depend on that:
// jobApplication.js anchors its section/heading regexes to the whole line
// (`^(?:personal|...)\s+projects?$`) and reads an employer's city off its own
// heading line. Handing them `## Personal Projects` or
// `**Acme - Denver, Colorado**` does not fail loudly - it silently matches
// nothing, quietly retiring the per-role location and project-provenance gates.
// So unwrap exactly the three constructs that change a line's shape and nothing
// else; every character that carries a fact is preserved.
function plainTextFromMarkdown(text) {
  return text
    // ATX heading -> its own text, closing hashes included.
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+(.*?)[ \t]*#*[ \t]*$/gmu, '$1')
    // `*` / `+` bullets -> the "- " the contract names.
    .replace(/^([ \t]*)[*+][ \t]+/gmu, '$1- ')
    // Paired ** / __ emphasis. Single `*`/`_` is deliberately left alone: it is
    // ambiguous with literal asterisks and snake_case, and it never begins a
    // line, so it cannot reshape one.
    .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/gu, '$2');
}

// A career file is prose; anything this large is not the document we think it is.
const PLAIN_TEXT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Read a plain-text document verbatim, or return null to defer to the normal
 * extraction path. Never throws: null means "not confidently clean text", and
 * every caller already has a working fallback, so a surprising file degrades to
 * the previous behaviour instead of failing the drop.
 */
export async function readPlainTextDocument(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  if (!PLAIN_TEXT_EXT.has(path.extname(resolved).toLowerCase())) return null;
  // Deferring rather than throwing keeps ONE copy of this rule: the attachment
  // path (llm.js callLLMDocument) raises the canonical refusal for a sensitive
  // path, and it is where this file was already headed.
  if (isSensitivePath(resolved)) return null;
  let text;
  try {
    const stats = await fs.stat(resolved);
    if (!stats.isFile() || stats.size > PLAIN_TEXT_MAX_BYTES) return null;
    text = await fs.readFile(resolved, 'utf8');
  } catch {
    return null;
  }
  // U+FFFD means Node substituted replacement characters for bytes that are not
  // valid UTF-8 - a Latin-1/Windows-1252 save, say - and a NUL means the
  // extension is lying about the contents. Either way this read is not faithful,
  // so hand the file to the extractor rather than ingesting mojibake as if it
  // were the candidate's career history.
  if (text.includes('\u0000') || text.includes('\uFFFD')) return null;
  return (MARKDOWN_EXT.has(path.extname(resolved).toLowerCase()) ? plainTextFromMarkdown(text) : text).trim() || null;
}
