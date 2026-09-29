import fs from 'node:fs/promises';
import zlib from 'node:zlib';
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
// So unwrap exactly the constructs that change a line's shape and nothing else;
// every character that carries a fact is preserved. The rules are DELIBERATELY
// stricter than CommonMark where CommonMark would remove a character the author
// may have typed as text: CommonMark treats `2**10 to 3**4` as bold and `**bold**text`
// as bold, and an emphasis marker there is removed by no rule below. The price is
// that some real emphasis (`**Google**'s`, `[**Acme**](url)`) stays as typed; the
// markers are then still the file's own characters, which is faithful, only not
// line-shape-normalised. Ambiguity is deferred, never guessed: a line whose `**` /
// `__` runs do not ALL pair up is left exactly as typed (a partial unwrap would
// strand markers in positions the author never wrote), a `__word__` that reads
// equally as emphasis or as an identifier (`__init__`) defers the file, and so does
// a fenced code block, whose lines are literal text that no rule here may edit.

// An ATX heading: 1-6 hashes, then its text. The closing sequence of hashes is
// stripped only when whitespace precedes it, so a heading that ends in a hash
// that belongs to the text (`### Languages: Python, C#`) keeps it.
const ATX_HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]+(.*)$/gmu;
function atxHeadingText(content) {
  const text = trimBlankEnd(content);
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) === 35) end -= 1;
  if (end === text.length) return text;
  if (end === 0) return '';
  const before = text.charCodeAt(end - 1);
  return before === 32 || before === 9 ? trimBlankEnd(text.slice(0, end)) : text;
}

// A thematic break: three or more of one of `*` `-` `_`, spaces between them
// allowed, nothing else on the line. It becomes the `---` rule the corpus already
// uses; left alone, the bullet rule below would turn `* * *` into `- * *`.
// The regex only narrows the candidates (a plain character-class loop, so no
// backtrack frame per repetition: a nested-quantifier form overflowed the regexp
// stack on a 3 MB line of `*`); the same-character and count test is a linear scan.
const THEMATIC_BREAK_CANDIDATE_RE = /^[ \t]*[*_-][ \t*_-]*$/gmu;
function isThematicBreak(line) {
  let marker = '';
  let count = 0;
  for (let at = 0; at < line.length; at += 1) {
    const ch = line[at];
    if (ch === ' ' || ch === '\t') continue;
    if (marker === '') marker = ch;
    else if (ch !== marker) return false;
    count += 1;
  }
  return count >= 3;
}

// A fenced code block's lines are literal text, so none of the rules below may edit them.
const CODE_FENCE_RE = /^[ \t]{0,3}(?:```|~~~)/mu;

// True when a run of one or more punctuation marks (never `*` or `_`, which are
// emphasis delimiters) starts at `from` and is followed by whitespace or the end of
// the line: `**Acme**).`, `**Denver, CO**...`. A mark followed by a letter, digit or
// another delimiter (`**a**.x`, `**Go**/**Rust**`, `**a**:**b**`) is not.
function punctuationEndsLine(line, from) {
  let at = from;
  while (at < line.length && line[at] !== '*' && line[at] !== '_' && /\p{P}/u.test(line[at])) at += 1;
  return at > from && (at === line.length || /\s/u.test(line[at]));
}

// The [start, end) ranges of the inline code spans on a line: a run of N backticks
// up to the next run of EXACTLY N. A run with no such partner is literal text. Text
// inside a span is literal, so nothing here may edit it.
function codeSpanRanges(line) {
  const spans = [];
  const runs = [];
  for (let at = 0; at < line.length; at += 1) {
    if (line[at] !== '`') continue;
    let end = at + 1;
    while (line[end] === '`') end += 1;
    runs.push([at, end]);
    at = end - 1;
  }
  for (let index = 0; index < runs.length; index += 1) {
    const width = runs[index][1] - runs[index][0];
    let partner = -1;
    for (let next = index + 1; next < runs.length; next += 1) {
      if (runs[next][1] - runs[next][0] === width) { partner = next; break; }
    }
    if (partner < 0) continue;
    spans.push([runs[index][0], runs[partner][1]]);
    index = partner;
  }
  return spans;
}

// Paired ** / __ emphasis on ONE line. A delimiter run of exactly two characters
// opens only at the start of the line or after whitespace or an opening bracket,
// and only when text follows it; it closes only when text precedes it and it ends
// the line, or is followed by whitespace, or by a run of punctuation that is itself
// followed by whitespace or the end of the line. Neither can sit against a letter
// or digit on its outer side, so `__init__.py`, `2**10` and `snake__case` are text.
// Linear: one pass with one pending opener per delimiter character. Returns the
// line unchanged unless EVERY run of two or more delimiter characters on it paired up (only a run of exactly two can), and null when a
// `__` pair holds one bare word (`__init__`: emphasis or an identifier, undecidable).
// A delimiter run inside an inline code span is literal text: it is neither paired
// nor counted, so the span comes through exactly as typed.
function unwrapEmphasis(line) {
  if (!line.includes('**') && !line.includes('__')) return line;
  const pending = { '*': -1, _: -1 };
  const dropped = [];
  const spans = line.includes('`') ? codeSpanRanges(line) : [];
  let span = 0;
  let runs = 0;
  for (let at = 0; at < line.length - 1; at += 1) {
    const mark = line[at];
    if ((mark !== '*' && mark !== '_') || line[at + 1] !== mark) continue;
    let end = at + 2;
    while (line[end] === mark) end += 1;
    const start = at;
    at = end - 1;
    while (span < spans.length && spans[span][1] <= start) span += 1;
    if (span < spans.length && spans[span][0] < start) continue;
    runs += 1;
    if (end - start !== 2) continue;
    const previous = start > 0 ? line[start - 1] : '';
    const next = end < line.length ? line[end] : '';
    const closes = previous !== '' && !/\s/u.test(previous)
      && (next === '' || /\s/u.test(next) || punctuationEndsLine(line, end));
    const opens = (previous === '' || /[\s([{]/u.test(previous)) && next !== '' && !/\s/u.test(next);
    if (closes && pending[mark] >= 0) {
      if (mark === '_' && /^[\p{L}\p{N}_]+$/u.test(line.slice(pending[mark] + 2, start))) return null;
      dropped.push(pending[mark], start);
      pending[mark] = -1;
    } else if (opens && pending[mark] < 0) {
      pending[mark] = start;
    }
  }
  if (dropped.length === 0 || dropped.length !== runs) return line;
  dropped.sort((left, right) => left - right);
  let out = '';
  let from = 0;
  for (const index of dropped) {
    out += line.slice(from, index);
    from = index + 2;
  }
  return out + line.slice(from);
}

// The plain text of a Markdown document, or null when it holds something this
// reader will not guess at.
function plainTextFromMarkdown(text) {
  if (CODE_FENCE_RE.test(text)) return null;
  const lines = text
    .replace(ATX_HEADING_RE, (_line, content) => atxHeadingText(content))
    .replace(THEMATIC_BREAK_CANDIDATE_RE, line => (isThematicBreak(line) ? '---' : line))
    // `*` / `+` bullets -> the "- " the contract names.
    .replace(/^([ \t]*)[*+][ \t]+/gmu, '$1- ')
    .split('\n');
  for (let at = 0; at < lines.length; at += 1) {
    const line = unwrapEmphasis(lines[at]);
    if (line === null) return null;
    lines[at] = line;
  }
  return lines.join('\n');
}

// Markdown that a renderer hides or rewrites, so the file's text is not what a reader
// of the rendered page sees. A link-reference (or footnote) definition line is drawn as
// nothing (`[//]: # (note)` is the portable comment); a raw HTML tag can hide what it
// wraps (`<span hidden>`, `display:none`) and is itself never shown; a character
// reference (`&shy;`, `&#8203;`, `&amp;`) is drawn as a different character than the
// one typed. Every one defers rather than being read as career text. An autolink
// (`<jack@x.com>`, `<https://x.com>`), a bare `&` (`R&D`) and a comparison (`3 < 4`)
// match none of them. Each is one linear pass: a fixed-width lead, then a run bounded by
// the line or by one character class.
const MARKDOWN_HIDDEN_RE = [
  /^ {0,3}\[[^\]\n]*\]:/mu,
  /<(?:\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|[!?])/mu,
  /&(?:#[0-9]+|#[xX][0-9A-Fa-f]+|[A-Za-z][A-Za-z0-9]*);/u,
];

// A career file is prose; anything this large is not the document we think it is.
const PLAIN_TEXT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Read a plain-text document verbatim, or return null to defer to the normal
 * extraction path. Never throws: null means "not confidently clean text", and
 * every caller already has a working fallback, so a surprising file degrades to
 * the previous behaviour instead of failing the drop.
 */
export async function readPlainTextDocument(filePath) {
  // The coercion is inside the guard: an argument whose toString throws (or a
  // null-prototype object) is a refusal like any other, not a rejection.
  let resolved;
  try {
    resolved = path.resolve(String(filePath || ''));
  } catch {
    return null;
  }
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
  // A byte-order mark leading the file is an encoding signature (Windows editors
  // write one), not text: strip it. Node's utf8 decoding keeps it as U+FEFF.
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // Text that renders as nothing, that reorders or hides the text around it, or that
  // is not text at all (control characters, private-use glyph slots, line and
  // paragraph separators, C1 controls) is not what a reader of the file sees, so a
  // read carrying any is not faithful. This is the DOCX path's own refusal set
  // (FFFD, PUA, control characters incl. NUL, INVISIBLE_CHAR_RE incl. a stray BOM,
  // C1 controls and U+2028/2029), which no career file legitimately holds.
  // Deliberately conservative: such a character in a career file is far more likely
  // to be pasted debris than intent, and the file still reads through the AI handoff.
  if (text.includes('\uFFFD') || PUA_RE.test(text) || hasControlChar(text) || INVISIBLE_CHAR_RE.test(text) || C1_AND_SEPARATOR_RE.test(text)) return null;
  const markdown = MARKDOWN_EXT.has(path.extname(resolved).toLowerCase());
  // An HTML comment is hidden when the Markdown is rendered, and so are the other
  // constructs MARKDOWN_HIDDEN_RE names.
  if (markdown && (text.includes('<!--') || MARKDOWN_HIDDEN_RE.some(hidden => hidden.test(text)))) return null;
  if (!markdown) return text.trim() || null;
  // The never-throw contract holds even if a pathological line exhausts the regexp
  // engine (a RangeError there is a refusal, not a crash).
  try {
    const plain = plainTextFromMarkdown(text);
    return plain === null ? null : plain.trim() || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Local DOCX reading
//
// A Word file's text is machine-readable, so a plain one can be read without a
// manual AI handoff. Same contract as readPlainTextDocument: never throw; null
// means "not confidently faithful", and the caller's AI transcription then runs
// unchanged.
//
// "Confidently faithful" is the whole design. A wrong local read is worse than
// the handoff it saves: it is ingested as the candidate's career history with no
// AI pass, so a dropped fact, a glued figure or hidden text corrupts every
// downstream score, query and generated document with no error anywhere. So this
// reader accepts only plain flow content (paragraphs, runs, tabs, breaks, simple
// hyperlinks, tables, bullet lists, super/subscript glyphs) and returns null the
// moment anything else is present. It does not reconstruct layout, and it does
// not edit content to suit a parser: no section fences, no reordering, no
// joined fields, no appended URLs.
//
// PDF is deliberately NOT read here. A PDF stores glyphs at coordinates, so its
// "text" is a reconstruction (reading order, columns, word gaps, ligatures,
// glyph-to-character maps) that no check can prove faithful; every PDF takes the
// AI path.
// ---------------------------------------------------------------------------

// Binary documents are much larger than the prose they hold, so the INPUT cap
// is separate from (and higher than) the extracted-text cap.
const BINARY_DOC_MAX_BYTES = 25 * 1024 * 1024;
const EXTRACTED_TEXT_MAX_CHARS = PLAIN_TEXT_MAX_BYTES;

// The one normalisation this reader applies: a Word tab (a right-aligned date, a
// tab-stop field) and the boundary between two table cells are both written as
// this string, and nothing else about the text is changed.
//
// Chosen by measurement, not taste. Word-style resume fixtures (a title with a
// right-tab date, "Employer<tab>City, ST", an education cell holding a degree) were
// read and each candidate separator was run through the consumers of the corpus:
// the role scoper (structuredResume.js), its opening-block dates rule, the
// employer-location reader (jobApplication.js) and the completed-degree detector
// (localAiApplication.js). A tab, a single space and a double space behave
// IDENTICALLY (every consumer collapses whitespace), and none lets the role scoper
// find a role, because it wants the title alone on its line and a date sharing the
// line defeats it, so that role's evidence gate silently stops applying. A newline
// is the only whitespace that recovers role scoping and the dates rule in both the
// tab-stop and the table layout, and the degree when the institution comes first.
// No whitespace recovers the employer's city: that reader needs a " - " between
// employer and city, which is an inserted character (a content edit) and so is not
// done. The asserting test is in scripts/tests/job-resume-ingestion.js.
//
// Known cost: a table row's cells land on consecutive lines instead of one line, so
// a row of figures keeps its order but not its single-line shape.
const FIELD_SEPARATOR = '\n';

async function statBinaryDocument(resolved) {
  const stats = await fs.stat(resolved);
  if (!stats.isFile() || stats.size > BINARY_DOC_MAX_BYTES || stats.size === 0) return false;
  return true;
}

// Manual, linear trim of trailing spaces/tabs. `/[ \t]+$/` is quadratic on a long
// run of blanks that is NOT at the end (each start position rescans the run).
function trimBlankEnd(text) {
  let end = text.length;
  while (end > 0) {
    const code = text.charCodeAt(end - 1);
    if (code !== 32 && code !== 9) break;
    end -= 1;
  }
  return end === text.length ? text : text.slice(0, end);
}

function hasControlChar(text) {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    // Tab (9), LF (10) and CR (13) are ordinary whitespace; everything else below
    // 32 (NUL included), and DEL, is not text.
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) return true;
  }
  return false;
}

// Private Use Area code points are glyph slots (Symbol/Wingdings bullets, a font's
// own ligature slots), not characters: what they stand for cannot be recovered
// from the code point, so a read that contains one is refused, not repaired.
const PUA_RE = /[\uE000-\uF8FF\u{F0000}-\u{FFFFD}\u{100000}-\u{10FFFD}]/u;

// Characters that render as nothing, render as a placeholder, or reorder or hide the
// text around them. Text carrying one is not what it shows, so the read is refused:
//   soft hyphen (U+00AD), combining grapheme joiner (U+034F), Arabic letter mark (U+061C),
//   Hangul fillers (U+115F, U+1160, U+3164, U+FFA0), Khmer inherent vowels (U+17B4-17B5),
//   Mongolian free variation selectors and vowel separator (U+180B-180F),
//   zero-width space/joiners and direction marks (U+200B-200F), bidi embeddings and
//   overrides (U+202A-202E), word joiner through invisible operators and the bidi
//   isolates (U+2060-206F), braille blank (U+2800), variation selectors (U+FE00-FE0F),
//   the byte-order mark (U+FEFF), the specials block (U+FFF0-FFFF: interlinear
//   annotation marks, object replacement, replacement, noncharacters), the
//   noncharacters U+FDD0-FDEF and the last two code points of every plane, musical
//   formatting characters (U+1D173-1D17A), the tag characters (U+E0000-E007F) and the
//   variation selectors supplement (U+E0100-E01EF), and the Egyptian hieroglyph format
//   controls (U+13430-1343F). Every code point Unicode marks Default_Ignorable is
//   refused by property, which also covers what the list above does not spell out
//   (the shorthand format controls U+1BCA0-1BCA3 and the reserved ranges beside the tag
//   block, U+E0080-E00FF and U+E01F0-E0FFF). The format characters that DO render
//   (the Arabic number signs and marks U+0600-0605, U+06DD, U+070F, U+0890-0891,
//   U+08E2, and the Kaithi number signs U+110BD, U+110CD) stay readable.
const INVISIBLE_CHAR_RE = new RegExp('[' + [
  '\\u00AD', '\\u034F', '\\u061C', '\\u115F\\u1160', '\\u17B4\\u17B5', '\\u180B-\\u180F', '\\u200B-\\u200F', '\\u202A-\\u202E',
  '\\u2060-\\u206F', '\\u2800', '\\u3164', '\\uFDD0-\\uFDEF', '\\uFE00-\\uFE0F', '\\uFEFF', '\\uFFA0', '\\uFFF0-\\uFFFF',
  '\\u{1D173}-\\u{1D17A}', '\\u{E0000}-\\u{E007F}', '\\u{E0100}-\\u{E01EF}', '\\u{13430}-\\u{1343F}', '\\p{Default_Ignorable_Code_Point}',
  ...Array.from({ length: 16 }, (_, plane) => `\\u{${(plane + 1).toString(16).toUpperCase()}FFFE}-\\u{${(plane + 1).toString(16).toUpperCase()}FFFF}`),
].join('') + ']', 'u');

// Refused on both paths: C1 controls (U+0080-009F, NEL and the ANSI CSI included) and
// the Unicode line / paragraph separators (U+2028, U+2029). None is text a career file
// holds, and a DOCX's w:t already refuses the separators and NEL as line breaks.
const C1_AND_SEPARATOR_RE = /[\u0080-\u009F\u2028\u2029]/u;

const SUPERSCRIPT_CHARS = {
  0: '\u2070', 1: '\u00B9', 2: '\u00B2', 3: '\u00B3', 4: '\u2074', 5: '\u2075', 6: '\u2076', 7: '\u2077', 8: '\u2078', 9: '\u2079',
  '+': '\u207A', '-': '\u207B', '(': '\u207D', ')': '\u207E',
};
const SUBSCRIPT_CHARS = {
  0: '\u2080', 1: '\u2081', 2: '\u2082', 3: '\u2083', 4: '\u2084', 5: '\u2085', 6: '\u2086', 7: '\u2087', 8: '\u2088', 9: '\u2089',
  '+': '\u208A', '-': '\u208B', '(': '\u208D', ')': '\u208E',
};
// Footnote symbols read the same raised or not.
const SCRIPT_PASSTHROUGH = '*\u2020\u2021\u00A7\u00B6';

// The real Unicode super/subscript form of a run's text (a glyph change, not a
// content edit), or null when any character has none.
function scriptText(text, script) {
  const map = script === 'sup' ? SUPERSCRIPT_CHARS : SUBSCRIPT_CHARS;
  let out = '';
  for (const ch of text) {
    if (Object.hasOwn(map, ch)) out += map[ch];
    else if (SCRIPT_PASSTHROUGH.includes(ch)) out += ch;
    else return null;
  }
  return out;
}

// ---- DOCX ------------------------------------------------------------------

const DOCX_MAX_PART_BYTES = 32 * 1024 * 1024;
const DOCX_MAX_TOTAL_BYTES = 48 * 1024 * 1024;
// Real Word documents nest a few dozen elements deep even with a textbox inside a
// table inside a table. Anything past this is not a document we can trust.
const DOCX_MAX_DEPTH = 200;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_EOCD64_LOCATOR_SIG = 0x07064b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_LOCAL_SIG = 0x04034b50;

// Minimal, dependency-free ZIP reader. It is driven by the central directory
// (authoritative sizes and local-header offsets), which sidesteps the
// data-descriptor case where a local header's sizes are zero. Only stored (0)
// and deflate (8) are supported; ZIP64, encryption, duplicate names and anything
// odd return null.
function readZipDirectory(buffer) {
  if (buffer.length < 22) return null;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  if (eocd >= 20 && buffer.readUInt32LE(eocd - 20) === ZIP_EOCD64_LOCATOR_SIG) return null;
  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const cdSize = buffer.readUInt32LE(eocd + 12);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null;
  if (cdOffset + cdSize > eocd) return null;

  const entries = new Map();
  let pos = cdOffset;
  for (let n = 0; n < totalEntries; n += 1) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== ZIP_CENTRAL_SIG) return null;
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const nameEnd = pos + 46 + nameLen;
    if (nameEnd > buffer.length) return null;
    const name = buffer.toString('utf8', pos + 46, nameEnd);
    // Two entries with one name are ambiguous: which one Word reads is
    // implementation-defined, so neither can be trusted.
    if (entries.has(name)) return null;
    entries.set(name, {
      flags: buffer.readUInt16LE(pos + 8),
      method: buffer.readUInt16LE(pos + 10),
      compressedSize: buffer.readUInt32LE(pos + 20),
      uncompressedSize: buffer.readUInt32LE(pos + 24),
      localOffset: buffer.readUInt32LE(pos + 42),
    });
    pos = nameEnd + extraLen + commentLen;
  }
  return entries;
}

function inflateZipEntry(buffer, entry) {
  const { flags, method, compressedSize, uncompressedSize, localOffset } = entry;
  // Bit 0 = encrypted, bit 6 = strong encryption.
  if (flags & 0x41) return null;
  if (method !== 0 && method !== 8) return null;
  if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) return null;
  if (uncompressedSize > DOCX_MAX_PART_BYTES) return null;
  if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== ZIP_LOCAL_SIG) return null;
  const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
  const dataEnd = dataStart + compressedSize;
  if (dataEnd > buffer.length) return null;
  const raw = buffer.subarray(dataStart, dataEnd);
  // The output cap IS the declared size: an entry that inflates past what its
  // directory record claims is a zip bomb whose header lies, and it is refused
  // before it is ever allocated.
  // inflateRawSync THROWS on corrupt data and on output past the cap; both are a
  // refusal, stated here rather than left to the caller's catch-all.
  let data;
  try {
    data = method === 0 ? raw : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, uncompressedSize) });
  } catch {
    return null;
  }
  return data.length === uncompressedSize ? data : null;
}

function decodeXmlEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (match, body) => {
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: {
        const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        // An invalid reference becomes U+FFFD so the whole read is refused
        // rather than silently losing a character.
        if (!Number.isInteger(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
        return String.fromCodePoint(code);
      }
    }
  });
}

// Content that is not part of the document as it currently reads.
// (w:rPrChange needs no entry: the w:rPr nested in it is not a run's own w:rPr, so
// runProperty() below never applies it.)
const DOCX_SKIPPED_ELEMENTS = new Set([
  'w:del',          // tracked deletion
  'w:moveFrom',     // the source copy of a tracked move (the destination is w:moveTo)
  'w:pPrChange',    // the OLD paragraph properties of a tracked formatting change
  'w:sectPrChange', // the OLD section properties
]);
// Elements whose content lives somewhere this reader does not look, has no
// plain-text form, is positioned by geometry rather than by document order, or is
// text a reader of the printed page would not see as written. Reading past one
// would silently drop, reorder, reshape or over-include what it stands for, so
// the read is refused and the AI transcription runs instead.
const DOCX_UNSUPPORTED_ELEMENTS = new Set([
  'w:sym',                // a glyph addressed by font + code point
  'w:altChunk',           // an embedded second document
  'w:subDoc',
  'w:drawing',            // a picture, shape, text box, chart or SmartArt anchor
  'w:pict',               // legacy VML: shapes, text boxes, WordArt
  'w:object',             // an embedded OLE object and its preview image
  'v:textpath',           // WordArt: the text is drawn along a path
  'dgm:relIds',           // SmartArt: its text is in word/diagrams/*
  'c:chart',              // chart labels and figures are in word/charts/*
  'm:oMath',              // equations carry m:t, not w:t
  'm:oMathPara',
  'w:txbxContent',        // a text box: anchored ones are positioned by offset, so document
                          // order is NOT reading order
  'w:framePr',            // a positioned paragraph frame: same problem as a text box
  'mc:AlternateContent',  // a construct written twice (modern + legacy); which copy shows depends on the reader
  'w:fldChar',            // a complex field: its shown result is a cached value, its code is elsewhere
  'w:instrText',
  'w:fldSimple',
  'w:footnoteReference',  // the note's text is elsewhere and would be detached from its claim
  'w:endnoteReference',
  'w:commentReference',   // ditto for a comment
  'w:ruby',               // phonetic guide text is interleaved with the base text
  'w:vMerge',             // a cell spanning rows: its text belongs to several rows, not the one it is read in
  'w:tblpPr',             // a floating table: positioned by offset, so document order is not reading order
  'w:placeholder',        // a content control that names placeholder content: the shown text may be the unfilled prompt
  'w:dataBinding',        // a content control whose shown text Word refreshes from a custom XML part or a document property
  'w:cellDel',            // a tracked-deleted table cell (the marker is self-closing; its runs are ordinary w:t)
  'w:bdo',                // a bidirectional override wrapper: Word displays its runs in reverse order
  'w:dir',                // ditto (the directional-embedding form)
  // Elements that RENDER text this reader has no source for (the page number, a
  // date, a note's own number): dropping one leaves "Page " where the page shows
  // "Page 2".
  'w:pgNum', 'w:dayShort', 'w:dayLong', 'w:monthShort', 'w:monthLong', 'w:yearShort', 'w:yearLong',
  'w:annotationRef', 'w:footnoteRef', 'w:endnoteRef',
]);
const WORD_NAMESPACE = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
// Every element this reader recognises is matched by a LITERAL prefix. A namespace is
// what an element means, not its prefix, so a part that binds one of these namespaces
// to a second prefix and then WRITES elements or attributes under it hides them from
// this reader (paragraphs it drops, a hide / strike / colour property or a drawing it
// never checks) while Word, which is namespace-aware, reads them. A part that declares
// such a prefix and never uses it is harmless (an older producer's unused mc: alias),
// so the read is refused only when an alias is used.
const GUARDED_NAMESPACES = new Map([
  [WORD_NAMESPACE, 'w'],
  ['http://purl.oclc.org/ooxml/wordprocessingml/main', 'w'],
  ['http://schemas.openxmlformats.org/officeDocument/2006/math', 'm'],
  ['http://purl.oclc.org/ooxml/officeDocument/math', 'm'],
  ['http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing', 'wp'],
  ['http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing', 'wp'],
  ['http://schemas.openxmlformats.org/markup-compatibility/2006', 'mc'],
  ['http://schemas.microsoft.com/office/word/2010/wordml', 'w14'],
  ['urn:schemas-microsoft-com:vml', 'v'],
  ['http://schemas.openxmlformats.org/drawingml/2006/chart', 'c'],
  ['http://schemas.openxmlformats.org/drawingml/2006/diagram', 'dgm'],
  // r:id names a relationship (a hyperlink's address, a header part); an aliased
  // prefix would hide one from the literal reads below.
  ['http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r'],
  ['http://purl.oclc.org/ooxml/officeDocument/relationships', 'r'],
]);
const XMLNS_DECLARATION_RE = /(?:^|\s)xmlns:([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

// A per-part checker, called with every opening tag in document order. It returns
// false when the tag (or an earlier one) makes a literal-prefix match mean something
// else: a default namespace, the w: prefix bound to anything but the WordprocessingML
// namespace, or an element / attribute written under a non-canonical prefix bound to
// a guarded namespace.
function createNamespaceGuard() {
  const aliases = [];
  return (name, attributes) => {
    if (attributes.includes('xmlns')) {
      if (/\sxmlns\s*=/.test(attributes)) return false;
      for (const match of attributes.matchAll(XMLNS_DECLARATION_RE)) {
        const uri = decodeXmlEntities((match[2] ?? match[3]).trim());
        if (match[1] === 'w') {
          if (uri !== WORD_NAMESPACE) return false;
          continue;
        }
        const canonical = GUARDED_NAMESPACES.get(uri);
        if (canonical !== undefined && canonical !== match[1] && !aliases.some(alias => alias.prefix === match[1])) {
          aliases.push({ prefix: match[1], attribute: new RegExp(`(?:^|\\s)${match[1].replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')}:`) });
        }
      }
    }
    return !aliases.some(alias => name.startsWith(`${alias.prefix}:`) || alias.attribute.test(attributes));
  };
}

// ---- attribute / flag helpers over the text of one tag's attributes ---------------

const attributePatterns = new Map();
function xmlAttribute(attributes, name) {
  let pattern = attributePatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`);
    attributePatterns.set(name, pattern);
  }
  const match = pattern.exec(attributes);
  return match ? decodeXmlEntities(match[1] ?? match[2]) : undefined;
}

// A boolean run/paragraph property: present with no value, or a value that is not
// an explicit "off", is on.
function xmlFlagOn(attributes) {
  const value = xmlAttribute(attributes, 'w:val');
  return value === undefined || !/^(?:0|false|off)$/i.test(value.trim());
}

class MalformedXml extends Error {}

// Linear tag scanner for the small property parts (styles, numbering, relationships).
// A regex with a lazy attribute group rescans to the end of the text for every
// unclosed "<", which is quadratic on a hostile part; this advances past each tag
// exactly once and treats a "<" inside a tag as malformed.
function* xmlTags(xml) {
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) return;
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) throw new MalformedXml('unterminated tag');
    const inner = xml.slice(lt + 1, gt);
    pos = gt + 1;
    if (inner.includes('<')) throw new MalformedXml('nested <');
    const first = inner.charCodeAt(0);
    if (first === 33 /* ! */ || first === 63 /* ? */) {
      if (inner.startsWith('!--')) {
        const end = xml.indexOf('-->', lt + 4);
        if (end < 0) throw new MalformedXml('unterminated comment');
        pos = end + 3;
      }
      continue;
    }
    const closing = first === 47;
    const body = closing ? inner.slice(1) : inner;
    const selfClosing = !closing && body.endsWith('/');
    const text = selfClosing ? body.slice(0, -1) : body;
    let nameEnd = 0;
    while (nameEnd < text.length && !/[\s/]/.test(text[nameEnd])) nameEnd += 1;
    yield { closing, name: text.slice(0, nameEnd).trim(), attributes: text.slice(nameEnd), selfClosing };
  }
}

// The tags of a WordprocessingML property part (styles, numbering, settings): the same
// literal-prefix reading as the document body, so the root must bind w: to the
// WordprocessingML namespace and no tag may declare a namespace that would make that
// reading wrong (see GUARDED_NAMESPACES). Malformed otherwise.
function* wordPartTags(xml) {
  let root = true;
  const faithful = createNamespaceGuard();
  for (const tag of xmlTags(xml)) {
    if (!tag.closing) {
      if (root && xmlAttribute(tag.attributes, 'xmlns:w') !== WORD_NAMESPACE) throw new MalformedXml('root does not bind w:');
      root = false;
      if (!tag.name.includes(':') || !faithful(tag.name, tag.attributes)) throw new MalformedXml('unfaithful namespace');
    }
    yield tag;
  }
}

// Runs `read` over the tags of one part; null when the part is malformed.
function readXmlParts(xml, read, wordPart = false) {
  try {
    return read(wordPart ? wordPartTags(xml) : xmlTags(xml));
  } catch (error) {
    if (error instanceof MalformedXml) return null;
    throw error;
  }
}

// ---- styles.xml / numbering.xml / relationships -------------------------------------

// Text the printed page does not show at a legible size: below 4pt (w:sz counts
// half-points).
const DOCX_MIN_VISIBLE_HALF_POINTS = 8;

// A colour this reader cannot resolve to one value: it depends on a theme mapping
// that the document rebinds.
const UNRESOLVED = 'unresolved';
// A shading whose paint is a pattern (solid, stripes, percentages), not the plain
// background a "clear" pattern gives: its colour is not the w:fill value.
const PATTERN_PAINT = 'pattern';

// Theme slots that are the light end of the scheme in every theme Word ships, and
// the names that go through w:clrSchemeMapping (which a document may rebind).
const THEME_LIGHT = new Set(['background1', 'bg1', 'light1', 'background2', 'bg2', 'light2']);
const THEME_MAPPED = new Set(['background1', 'bg1', 'text1', 'tx1', 'background2', 'bg2', 'text2', 'tx2']);
const NEAR_WHITE_CHANNEL = 0xf0;
// [tint, shade] attribute names beside each theme reference.
const THEME_ADJUSTMENTS = { 'w:themeColor': ['w:themeTint', 'w:themeShade'], 'w:themeFill': ['w:themeFillTint', 'w:themeFillShade'] };

// True when a text colour is a theme colour darkened by a shade (Word's default
// heading colour is one). Darkening cannot hide text on a white page, but against a
// fill the shaded result is not the cached hex this reader compares.
function themeShaded(attributes) {
  const theme = xmlAttribute(attributes, 'w:themeColor')?.trim().toLowerCase();
  return theme !== undefined && theme !== 'none' && xmlAttribute(attributes, 'w:themeShade') !== undefined;
}

// WCAG relative luminance of a six-digit hex colour, and the contrast ratio of two.
function relativeLuminance(hex) {
  const [red, green, blue] = [0, 2, 4].map((at) => {
    const channel = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}
function contrastRatio(first, second) {
  const [high, low] = [relativeLuminance(first), relativeLuminance(second)].sort((left, right) => right - left);
  return (high + 0.05) / (low + 0.05);
}
// Text closer than this to what it sits on is not legible as written. Below the 4.5:1
// of body text on purpose: light grey secondary text is real; near-invisible is not.
const DOCX_MIN_CONTRAST = 3;
// This reader assumes the plain white page (a w:background of any other colour defers).
const PAGE_COLOR = 'ffffff';

// One w:ind's attributes as a comparable string (order-insensitive), or '' for none.
function indentSignature(attributes) {
  const pairs = [];
  for (const match of attributes.matchAll(/(?:^|\s)w:([A-Za-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) pairs.push(`${match[1]}=${(match[2] ?? match[3]).trim()}`);
  return pairs.sort().join(',');
}

// The colour a w:color / w:shd attribute set names, as lowercase hex, or null for
// "auto"/absent. Word honours a theme reference OVER the cached hex beside it, so
// a light theme slot is white whatever w:val says, and a slot that goes through a
// rebound clrSchemeMapping is not knowable at all (UNRESOLVED).
function wordColor(attributes, valueName, themeName, remapped = false) {
  const theme = xmlAttribute(attributes, themeName)?.trim().toLowerCase();
  if (theme !== undefined && theme !== 'none') {
    if (remapped && THEME_MAPPED.has(theme)) return UNRESOLVED;
    // A tint lightens the theme colour and a fill's shade or tint moves it anywhere;
    // Word computes the result from the theme part, which this reader never reads,
    // so the cached hex beside it cannot be trusted.
    const [tintName, shadeName] = THEME_ADJUSTMENTS[themeName] ?? [];
    if (tintName !== undefined && xmlAttribute(attributes, tintName) !== undefined) return UNRESOLVED;
    if (themeName === 'w:themeFill' && shadeName !== undefined && xmlAttribute(attributes, shadeName) !== undefined) return UNRESOLVED;
    if (THEME_LIGHT.has(theme)) return 'ffffff';
  }
  const value = xmlAttribute(attributes, valueName);
  if (value === undefined) return null;
  const hex = value.trim().toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(hex)) return null;
  // A colour a reader cannot tell from white on the default page is white: every
  // channel at or above this floor.
  return [0, 2, 4].every(at => Number.parseInt(hex.slice(at, at + 2), 16) >= NEAR_WHITE_CHANNEL) ? 'ffffff' : hex;
}

// What a w:shd paints. Only the "clear" (or "nil") pattern is a plain background in
// w:fill; any other pattern paints with w:color over w:fill, which this reader does
// not model, so it says so instead of naming a colour.
function shadingFill(attributes, remapped) {
  const pattern = (xmlAttribute(attributes, 'w:val') || '').trim().toLowerCase();
  const fill = wordColor(attributes, 'w:fill', 'w:themeFill', remapped) ?? 'auto';
  if (pattern === '' || pattern === 'clear' || pattern === 'nil' || fill === UNRESOLVED) return fill;
  return PATTERN_PAINT;
}

// The sixteen colours w:highlight can name. Any other name is not one this reader
// can place.
const HIGHLIGHT_COLORS = {
  black: '000000', blue: '0000ff', cyan: '00ffff', darkblue: '000080', darkcyan: '008080', darkgray: '808080', darkgreen: '008000',
  darkmagenta: '800080', darkred: '800000', darkyellow: '808000', green: '00ff00', lightgray: 'c0c0c0', magenta: 'ff00ff',
  red: 'ff0000', white: 'ffffff', yellow: 'ffff00',
};
// 'none' | lowercase hex | UNRESOLVED.
function highlightPaint(attributes) {
  const name = (xmlAttribute(attributes, 'w:val') || '').trim().toLowerCase();
  if (name === 'none') return 'none';
  return HIGHLIGHT_COLORS[name] ?? UNRESOLVED;
}

// Text that a property makes unreadable without hiding it outright: squeezed to a
// sliver by character scale or condensed spacing, or pushed off the page by an
// indent. Limits are deliberately loose (a real design condenses by a point or
// outdents by a fraction of an inch); anything past them defers.
const DOCX_MIN_CHARACTER_SCALE = 50;      // w:w, percent
const DOCX_MIN_CHARACTER_SPACING = -20;   // w:spacing w:val in a run, twentieths of a point (-1pt)
const DOCX_MAX_OUTDENT = 1440;            // twentieths of a point (1in)
const DOCX_MIN_EXACT_LINE = 160;          // an exact line height (8pt) when the font size is unknown

const twips = (attributes, name) => {
  const value = Number.parseInt(xmlAttribute(attributes, name) || '', 10);
  return Number.isFinite(value) ? value : undefined;
};

// A layout property that makes text unreadable regardless of what it sits on: true
// when the element is one.
function layoutHazard(name, attributes) {
  switch (name) {
    case 'w:w': { const percent = twips(attributes, 'w:val'); return percent !== undefined && percent < DOCX_MIN_CHARACTER_SCALE; }
    case 'w:fitText': return true;      // squeezes the run into a fixed width
    case 'w:framePr': return true;      // a positioned paragraph frame (see DOCX_UNSUPPORTED_ELEMENTS)
    case 'w:spacing': { const spacing = twips(attributes, 'w:val'); return spacing !== undefined && spacing < DOCX_MIN_CHARACTER_SPACING; }
    case 'w:ind': {
      const left = twips(attributes, 'w:start') ?? twips(attributes, 'w:left') ?? 0;
      const right = twips(attributes, 'w:end') ?? twips(attributes, 'w:right') ?? 0;
      const first = (twips(attributes, 'w:firstLine') ?? 0) - (twips(attributes, 'w:hanging') ?? 0);
      return left < -DOCX_MAX_OUTDENT || right < -DOCX_MAX_OUTDENT || left + first < -DOCX_MAX_OUTDENT;
    }
    default: return false;
  }
}

// An exact paragraph line height in twentieths of a point, or undefined.
function exactLineHeight(attributes) {
  if ((xmlAttribute(attributes, 'w:lineRule') || '').trim().toLowerCase() !== 'exact') return undefined;
  return twips(attributes, 'w:line');
}

// A face whose glyphs are pictures or symbols: the characters stored in the
// document are code points that the font remaps, so reading them as text yields
// letters and punctuation where Word draws an icon or a bullet. Matched loosely
// on purpose: a false match only defers.
const SYMBOL_FONT_RE = /dings|symbol|marlett|zapf|mt ?extra|awesome|icons?\b|icomoon|glyph|sorts|emoji|mdl2|pictogram|ornament|fontello/i;
function symbolFontNamed(attributes) {
  return ['w:ascii', 'w:hAnsi', 'w:cs', 'w:eastAsia'].some(name => SYMBOL_FONT_RE.test(xmlAttribute(attributes, name) || ''));
}

const halfPoints = attributes => {
  const value = Number.parseInt(xmlAttribute(attributes, 'w:val') || '', 10);
  return Number.isFinite(value) ? value : undefined;
};

/**
 * Character/paragraph style properties that change how a run reads: hidden or
 * struck-through text, its colour and size, super/subscript, list membership. A
 * run or paragraph can inherit any of them from a named style (the Word
 * "Superscript" and "List Bullet" styles), so without this a style-level bullet
 * has no "- " marker, a style-level superscript is glued into the figure and a
 * style-level hidden run is read as content.
 */
function readStyles(xml, remapped = false) {
  return readXmlParts(xml, tags => readStylesFrom(tags, remapped), true);
}

const DEFAULT_STYLE_TYPES = new Set(['paragraph', 'character', 'table']);

function readStylesFrom(tags, remapped = false) {
  const styles = new Map();
  // The style Word applies to a paragraph / run / table that names none.
  const defaults = {};
  let defaultSize;
  let current = null;
  let inDefaults = false;
  let defaultsAlter = false;
  for (const { closing, name, attributes, selfClosing } of tags) {
    if (closing) {
      if (name === 'w:style') current = null;
      else if (name === 'w:docDefaults') inDefaults = false;
      continue;
    }
    if (name === 'w:docDefaults') { if (!selfClosing) inDefaults = true; continue; }
    if (name === 'w:style') {
      if (selfClosing) continue;
      const id = xmlAttribute(attributes, 'w:styleId');
      if (id === undefined || styles.has(id)) return null;
      const type = xmlAttribute(attributes, 'w:type');
      current = { type, basedOn: null, vanish: undefined, struck: undefined, script: undefined, position: undefined, numId: undefined, ilvl: undefined, color: undefined, shaded: undefined, size: undefined, fill: undefined, highlight: undefined, geometry: undefined, lineExact: undefined, hazard: undefined, ind: undefined, nested: undefined };
      // Word's built-in "List Bullet 2", "List Number 3" ... are the deeper levels of a list.
      if (NESTED_LIST_STYLE_ID_RE.test(id)) current.nested = true;
      styles.set(id, current);
      if (/^(?:1|true|on)$/i.test((xmlAttribute(attributes, 'w:default') || '').trim()) && DEFAULT_STYLE_TYPES.has(type)) {
        // Two defaults of one type: which one applies is not something to guess.
        if (defaults[type] !== undefined) return null;
        defaults[type] = id;
      }
      continue;
    }
    if (name === 'w:vanish' || name === 'w:specVanish') {
      if (inDefaults && xmlFlagOn(attributes)) defaultsAlter = true;
      else if (current) current.vanish = current.vanish === true || xmlFlagOn(attributes);
    } else if (name === 'w:strike' || name === 'w:dstrike') {
      if (inDefaults && xmlFlagOn(attributes)) defaultsAlter = true;
      else if (current) current.struck = current.struck === true || xmlFlagOn(attributes);
    } else if ((name === 'w:rFonts' && symbolFontNamed(attributes)) || name === 'w14:textFill') {
      // A symbol face (its characters are not the text they look like) or a
      // text-fill effect (which can paint the text invisible) that this reader
      // does not resolve: any style or default carrying one defers the text it reaches.
      if (inDefaults) defaultsAlter = true;
      else if (current) current.hazard = true;
    } else if (name === 'w:vertAlign') {
      const value = xmlAttribute(attributes, 'w:val');
      const script = value === 'superscript' ? 'sup' : value === 'subscript' ? 'sub' : 'none';
      if (inDefaults && script !== 'none') defaultsAlter = true;
      else if (current) current.script = script;
    } else if (name === 'w:color') {
      const color = wordColor(attributes, 'w:val', 'w:themeColor', remapped);
      if (inDefaults && (color === 'ffffff' || color === UNRESOLVED)) defaultsAlter = true;
      else if (current) { current.color = color ?? 'auto'; current.shaded = themeShaded(attributes); }
    } else if (name === 'w:sz') {
      const size = halfPoints(attributes);
      if (inDefaults && size !== undefined) {
        defaultSize = size;
        if (size < DOCX_MIN_VISIBLE_HALF_POINTS) defaultsAlter = true;
      } else if (current && size !== undefined) current.size = size;
    } else if (name === 'w:highlight') {
      const paint = highlightPaint(attributes);
      if (inDefaults) { if (paint !== 'none') defaultsAlter = true; }
      else if (current) current.highlight = paint;
    } else if (name === 'w:spacing' && exactLineHeight(attributes) !== undefined) {
      const line = exactLineHeight(attributes);
      if (inDefaults) { if (line < DOCX_MIN_EXACT_LINE) defaultsAlter = true; }
      else if (current) current.lineExact = line;
    } else if (layoutHazard(name, attributes)) {
      if (inDefaults) defaultsAlter = true;
      else if (current) current.geometry = true;
    } else if (current && !inDefaults) {
      if (name === 'w:basedOn') current.basedOn = xmlAttribute(attributes, 'w:val') ?? null;
      else if (name === 'w:position') current.position = !/^0?$/.test((xmlAttribute(attributes, 'w:val') || '').trim());
      else if (name === 'w:numId') current.numId = xmlAttribute(attributes, 'w:val');
      else if (name === 'w:ilvl') current.ilvl = xmlAttribute(attributes, 'w:val');
      else if (name === 'w:shd') current.fill = shadingFill(attributes, remapped);
      else if (name === 'w:ind') current.ind = indentSignature(attributes);
      else if (name === 'w:name' && NESTED_LIST_STYLE_NAME_RE.test((xmlAttribute(attributes, 'w:val') || '').trim())) current.nested = true;
    }
  }
  return { styles, defaults, defaultSize, defaultsAlter };
}

const NESTED_LIST_STYLE_ID_RE = /^List(?:Bullet|Number|Continue)(?:[2-9]|\d\d+)$/i;
const NESTED_LIST_STYLE_NAME_RE = /^list\s+(?:bullet|number|continue)\s+(?:[2-9]|\d\d+)$/i;

const STYLE_KEYS = ['hazard', 'vanish', 'struck', 'script', 'position', 'numId', 'ilvl', 'color', 'shaded', 'size', 'fill', 'highlight', 'geometry', 'lineExact', 'ind', 'nested'];

// Hidden and struck-through are TOGGLE properties: a style level that turns one off
// does not undo a level above it that turned it on, and the states combine by
// level in a way this reader does not model. `vanishAny` / `struckAny` say that
// SOME style in the chain turns it on, so a reader can refuse rather than let the
// nearest style's "off" stand for the whole chain.
function resolveStyle(styles, id) {
  const out = {};
  let current = id === undefined ? undefined : styles.get(id);
  for (let depth = 0; current && depth < 24; depth += 1) {
    for (const key of STYLE_KEYS) {
      if (out[key] === undefined && current[key] !== undefined) out[key] = current[key];
    }
    if (current.vanish === true) out.vanishAny = true;
    if (current.struck === true) out.struckAny = true;
    current = current.basedOn ? styles.get(current.basedOn) : undefined;
  }
  return out;
}

// A table style sets properties for every cell under it (and its conditional
// first/last row and column parts are read into the same bag), and this reader does
// not model which cells they reach, so a table style that could hide, shrink,
// whiten or blend text is a table this reader does not read.
function tableStyleUnreadable(style) {
  const explicitColor = style.color !== undefined && style.color !== 'auto';
  return Boolean(style.hazard || style.vanish || style.vanishAny || style.struck || style.struckAny || style.script === 'sup' || style.script === 'sub' || style.position || style.geometry
    || (style.size !== undefined && style.size < DOCX_MIN_VISIBLE_HALF_POINTS)
    || style.color === 'ffffff' || style.color === UNRESOLVED || style.fill === UNRESOLVED || style.highlight === UNRESOLVED
    || (explicitColor && (style.fill === style.color || style.fill === PATTERN_PAINT || style.highlight === style.color)));
}

function readNumbering(xml) {
  return readXmlParts(xml, readNumberingFrom, true);
}

function readNumberingFrom(tags) {
  const abstracts = new Map();
  const nums = new Map();
  let abstract = null;
  let num = null;
  let level = null;
  let override = null;
  // The definition (format + literal level text) the open w:lvl is filling in.
  const definition = () => {
    if (level === undefined || level === null) return null;
    const table = num && override !== null ? num.overrides : abstract?.levels;
    if (!table) return null;
    if (!table.has(level)) table.set(level, { format: undefined, text: undefined, ind: undefined });
    return table.get(level);
  };
  for (const { closing, name, attributes, selfClosing } of tags) {
    if (closing) {
      if (name === 'w:abstractNum') abstract = null;
      else if (name === 'w:num') num = null;
      else if (name === 'w:lvl') level = null;
      else if (name === 'w:lvlOverride') override = null;
      continue;
    }
    if (name === 'w:abstractNum') {
      if (selfClosing) continue;
      const id = xmlAttribute(attributes, 'w:abstractNumId');
      if (id === undefined || abstracts.has(id)) return null;
      abstract = { levels: new Map(), linked: false };
      abstracts.set(id, abstract);
    } else if (name === 'w:num') {
      if (selfClosing) continue;
      const id = xmlAttribute(attributes, 'w:numId');
      if (id === undefined || nums.has(id)) return null;
      num = { abstractId: undefined, overrides: new Map() };
      nums.set(id, num);
    } else if (name === 'w:lvlOverride') {
      if (!selfClosing) override = xmlAttribute(attributes, 'w:ilvl');
    } else if (name === 'w:lvl') {
      if (!selfClosing) level = xmlAttribute(attributes, 'w:ilvl');
    } else if (name === 'w:numFmt') {
      const entry = definition();
      if (entry) entry.format = xmlAttribute(attributes, 'w:val');
    } else if (name === 'w:lvlText') {
      const entry = definition();
      if (entry) entry.text = xmlAttribute(attributes, 'w:val') ?? '';
    } else if (name === 'w:ind') {
      const entry = definition();
      if (entry) entry.ind = indentSignature(attributes);
    } else if (name === 'w:abstractNumId' && num) {
      num.abstractId = xmlAttribute(attributes, 'w:val');
    } else if ((name === 'w:numStyleLink' || name === 'w:styleLink') && abstract) {
      abstract.linked = true;
    }
  }
  return { abstracts, nums };
}

// 'bullet' | 'none' | 'numbered', or null when the numbering cannot be resolved
// or the level shows something other than the marker this reader states.
function listKind(numbering, numId, ilvl) {
  const num = numbering?.nums.get(numId);
  if (!num) return null;
  const abstract = numbering.abstracts.get(num.abstractId);
  if (!abstract || abstract.linked) return null;
  const level = ilvl === undefined ? '0' : ilvl;
  const entry = num.overrides.has(level) ? num.overrides.get(level) : abstract.levels.get(level);
  if (entry === undefined || entry.format === undefined) return null;
  const { format, text } = entry;
  if (format === 'bullet') {
    // A bullet level shows one glyph; any other level text is a label Word
    // prints before the paragraph that "- " does not state.
    return text === undefined || Array.from(text).length === 1 ? 'bullet' : null;
  }
  if (format === 'none') {
    // "No number" still prints its literal level text (a "Skills:" label);
    // only the %N counters vanish.
    return text === undefined || !text.replace(/%\d/g, '').trim() ? 'none' : null;
  }
  return 'numbered';
}

// The indent the numbering level itself sets (as a comparable string), or undefined.
function levelIndent(numbering, numId, ilvl) {
  const num = numbering?.nums.get(numId);
  const abstract = num && numbering.abstracts.get(num.abstractId);
  if (!abstract) return undefined;
  const level = ilvl === undefined ? '0' : ilvl;
  return (num.overrides.has(level) ? num.overrides.get(level) : abstract.levels.get(level))?.ind;
}

function readRelationships(xml) {
  return readXmlParts(xml, (tags) => {
    const rels = new Map();
    for (const { closing, name, attributes } of tags) {
      if (closing || name !== 'Relationship') continue;
      const id = xmlAttribute(attributes, 'Id');
      if (id === undefined || rels.has(id)) return null;
      rels.set(id, {
        type: xmlAttribute(attributes, 'Type') || '',
        target: (xmlAttribute(attributes, 'Target') || '').trim(),
        external: /^external$/i.test(xmlAttribute(attributes, 'TargetMode') || ''),
      });
    }
    return rels;
  });
}

// A hyperlink's address is a fact the page shows only if its display text says it.
// The address as it would be typed: no mailto: / tel: / http(s):// scheme, no leading
// `www.`, no trailing slash, percent-escapes decoded, case folded. Nothing else is
// dropped: a query, a fragment or a phone number's country code that the display text
// omits is part of where the link goes, so a display that omits it does not show it.
function typedAddress(value) {
  let address = value.trim().replace(/^(?:mailto:|tel:|https?:\/\/)/i, '').replace(/^www\./i, '').replace(/\/$/, '');
  try {
    address = decodeURIComponent(address);
  } catch {
    // Not a valid escape sequence: compare the address as written.
  }
  return address.toLowerCase();
}

// The display text shows the address only as a WHOLE token equal to it. A token is a
// whitespace-separated piece of the display, taken as written (so an address that
// itself holds a bracket, quote, comma, semicolon or bar - `o'neil@x.com`,
// `wiki/Foo_(bar)`, `?q=Toronto,ON` - shows itself), or with the brackets, quotes,
// commas and bars prose wraps around an address stripped from its two ENDS
// (`(jack@x.com),`), or as each piece between the marks that no address holds
// unescaped and prose uses to run items together (`GitHub|github.com/x`). An INTERIOR
// comma, semicolon, apostrophe or bracket is part of the token, never a boundary:
// splitting there made `o'neil@x.com` show `neil@x.com` and `x.com/a,b` show `x.com/a`,
// a different address, while the read dropped the real target. One sentence-final mark
// after the address is punctuation, not part of it. A substring test accepted
// `jack@gmail.com` for a link to `ack@gmail.com` and `github.com/jackwu-other` for
// `github.com/jackwu`, while the read then dropped the real target. A label glued to
// the address (`Email:jack@x.com`) is not the address, so it does not show it.
const ADDRESS_WRAP_MARKS = new Set([...',;()<>[]"\'|\u00B7\u2022\u2018\u2019\u201C\u201D']);
const ADDRESS_ITEM_SEPARATOR_RE = /[|<>"\u00B7\u2022\u201C\u201D]+/u;
// Manual, linear end-trim (a `[...]+$` regex is quadratic on a long run that is not at the end).
function stripAddressWrap(token) {
  let start = 0;
  let end = token.length;
  while (start < end && ADDRESS_WRAP_MARKS.has(token[start])) start += 1;
  while (end > start && (ADDRESS_WRAP_MARKS.has(token[end - 1]) || '.:!?'.includes(token[end - 1]))) end -= 1;
  return token.slice(start, end);
}
function hyperlinkShowsTarget(display, target) {
  const address = typedAddress(target);
  if (address === '') return true;
  const shows = token => token !== '' && typedAddress(token) === address;
  const showsWhole = token => shows(token.replace(/[.:!?]$/u, ''));
  return display.split(/\s+/u).some(token => showsWhole(token)
    || shows(stripAddressWrap(token))
    || token.split(ADDRESS_ITEM_SEPARATOR_RE).some(piece => shows(stripAddressWrap(piece))));
}

/**
 * Plain text of one WordprocessingML part, or null when it is malformed or holds
 * something that cannot be represented. One linear pass, no lazy regex over the
 * document: an unclosed opener repeated 100,000 times used to rescan to the end
 * of the XML once per opener (quadratic, on the Electron main process), and a
 * cell nested 200,000 deep rescanned the frame stack per close. Structure is
 * tracked with explicit stacks instead, depth-capped, and a tag that never closes
 * ends the read.
 *
 * `context`: { expectRoot, styles, defaults, defaultSize, remapped, numbering,
 * sections, rels }. `rels` maps the part's relationship ids to their targets.
 * `defaults` names the style Word applies to a paragraph / run / table
 * that names none; `remapped` says the document rebinds its theme colour mapping.
 * `sections` is an output list: each w:sectPr found, with the header/footer
 * references it makes.
 */
function plainTextFromWordXml(xml, context = {}) {
  const { expectRoot = 'w:document', styles = new Map(), defaults = {}, defaultSize, remapped = false, numbering = null, sections = [], rels = new Map() } = context;
  // The style that applies to a paragraph / run / table: the one it names, else the
  // default of its type. An id the styles part does not define is treated as
  // naming none, as Word does.
  const styleFor = (id, type) => resolveStyle(styles, id !== undefined && styles.has(id) ? id : defaults[type]);
  // True when what a run writes at this point is not what a reader of the page sees:
  // hidden, struck, raised, shrunk, squeezed, or too close to what it sits on. It
  // guards EVERY character the run contributes (text, tab, break, no-break hyphen),
  // not only its w:t.
  const runUnreadable = (run, paragraph) => {
    const fromRun = styleFor(run.style, 'character');
    const fromParagraph = styleFor(paragraph.style, 'paragraph');
    const pick = key => run[key] ?? fromRun[key] ?? fromParagraph[key];
    // Text Word does not display or shows crossed out must not become a career
    // fact, and text it displays raised or lowered is not the plain digits that
    // follow a figure. Hidden and struck are toggle properties: the levels combine
    // in a way this reader does not model (a character style's "off" does not undo
    // a paragraph style's "on"), so ANY level turning one on refuses the read.
    if (run.hidden === true || fromRun.vanishAny === true || fromParagraph.vanishAny === true) return true;
    // A symbol face or text-fill effect at any level: what the characters
    // stand for on the page is not what they read as.
    if (run.hazard || fromRun.hazard || fromParagraph.hazard) return true;
    if (run.struck === true || fromRun.struckAny === true || fromParagraph.struckAny === true) return true;
    if (run.position ?? fromRun.position ?? fromParagraph.position ?? false) return true;
    // Text a reader cannot see: too small to read, white, or too close to the colour
    // of whatever it sits on. White is refused outright: white-on-dark is a real
    // design, but proving the background dark needs the whole paint model.
    const size = pick('size');
    if (size !== undefined && size < DOCX_MIN_VISIBLE_HALF_POINTS) return true;
    // Squeezed, crowded or displaced by layout properties: not legible as written.
    if (run.geometry || fromRun.geometry || paragraph.geometry || fromParagraph.geometry) return true;
    const exactLine = paragraph.lineExact ?? fromParagraph.lineExact;
    const lineSize = size ?? defaultSize;
    if (exactLine !== undefined && exactLine < (lineSize !== undefined ? lineSize * 10 : DOCX_MIN_EXACT_LINE)) return true;
    const color = pick('color');
    if (color === 'ffffff' || color === UNRESOLVED) return true;
    // A highlight is painted over any shading, so it is the run's background
    // when there is one.
    const highlight = run.highlight ?? fromRun.highlight ?? fromParagraph.highlight;
    if (highlight === UNRESOLVED) return true;
    const shading = run.fill ?? fromRun.fill ?? paragraph.fill ?? fromParagraph.fill ?? enclosing('tc')?.fill ?? enclosing('tbl')?.fill;
    if (shading === UNRESOLVED) return true;
    if (color && color !== 'auto') {
      const fill = highlight !== undefined && highlight !== 'none' ? highlight : shading;
      // A pattern shading paints with its own colour, which is not modelled.
      if (fill === PATTERN_PAINT) return true;
      const painted = fill !== undefined && fill !== 'auto';
      if (contrastRatio(color, painted ? fill : PAGE_COLOR) < DOCX_MIN_CONTRAST) return true;
      // A shaded theme colour is not the cached hex once something is painted behind it.
      if (painted && pick('shaded')) return true;
    }
    return false;
  };
  const sinks = [[]];          // line sink stack: body, then each open table cell
  const open = [];             // open elements: { name, frame }
  const paragraphs = [];       // open paragraph frames, innermost last
  const runs = [];             // open run frames, innermost last
  const links = [];            // open hyperlinks that carry an address, innermost last
  let skipAt = -1;             // index in `open` of the element being skipped
  let rootSeen = false;
  const faithful = createNamespaceGuard();
  const emit = line => sinks[sinks.length - 1].push(line);
  // The indent inputs of the bullet paragraph just before this one, or null when the
  // previous paragraph was not a bullet: the bullets of one list must all sit at one
  // indent, because "- " cannot say that a later one is nested under an earlier one.
  let bulletIndent = null;
  // The innermost open frame of one type (a cell, a table), seen through any
  // frameless wrapper.
  const enclosing = (type) => {
    for (let index = open.length - 1; index >= 0; index -= 1) if (open[index].frame?.type === type) return open[index].frame;
    return undefined;
  };
  let pos = 0;
  while (pos < xml.length) {
    const lt = xml.indexOf('<', pos);
    if (lt < 0) break;
    const marker = xml.charCodeAt(lt + 1);
    if (marker === 33 /* ! */) {
      if (!xml.startsWith('<!--', lt)) return null; // CDATA / DOCTYPE never occur in Word output
      const commentEnd = xml.indexOf('-->', lt + 4);
      if (commentEnd < 0) return null;
      pos = commentEnd + 3;
      continue;
    }
    if (marker === 63 /* ? */) {
      const piEnd = xml.indexOf('?>', lt + 2);
      if (piEnd < 0) return null;
      pos = piEnd + 2;
      continue;
    }
    const gt = xml.indexOf('>', lt + 1);
    if (gt < 0) return null;
    pos = gt + 1;

    if (marker === 47 /* / */) {
      const name = xml.slice(lt + 2, gt).trim();
      const entry = open.pop();
      if (!entry || entry.name !== name) return null;
      if (skipAt >= 0) {
        if (open.length === skipAt) skipAt = -1;
        continue;
      }
      const frame = entry.frame;
      if (!frame) continue;
      if (frame.type === 'p') {
        paragraphs.pop();
        let list = false;
        let numId = frame.numId;
        let ilvl = frame.ilvl;
        // A paragraph whose style hides its mark joins the next paragraph in the
        // displayed document; two lines would not say so.
        if (styleFor(frame.style, 'paragraph').vanish) return null;
        if (numId === undefined) {
          const inherited = styleFor(frame.style, 'paragraph');
          numId = inherited.numId;
          if (ilvl === undefined) ilvl = inherited.ilvl;
        }
        if (numId !== undefined && numId !== '0') {
          const kind = listKind(numbering, numId, ilvl);
          // A numbered list needs its counters (start, restarts, levels) to be
          // written out; a list this reader cannot classify is not a bullet.
          if (kind === null || kind === 'numbered') return null;
          list = kind === 'bullet';
          if (list) {
            // A nested bullet carries its depth in the level, which "- " cannot
            // say; and a tab inside a bullet splits it into fields of which only
            // the first would keep the marker.
            if ((ilvl ?? '0').trim() !== '0') return null;
            if (hasFieldBoundary(frame.text)) return null;
            // Depth is also written as a deeper list style ("List Bullet 2") or as a
            // larger indent on a level-0 bullet (direct, from the style, or from
            // the numbering level). The inputs are compared, not the indent they
            // resolve to, so two bullets that could differ never read as siblings.
            const paragraphStyle = styleFor(frame.style, 'paragraph');
            if (paragraphStyle.nested) return null;
            const indent = [frame.ind ?? '', paragraphStyle.ind ?? '', levelIndent(numbering, numId, ilvl) ?? ''].join('|');
            if (bulletIndent !== null && bulletIndent !== indent) return null;
            bulletIndent = indent;
          }
        }
        if (!list) bulletIndent = null;
        const line = trimBlankEnd(fieldSeparated(trimBlankEnd(frame.text)));
        emit(line && list ? `- ${line}` : line);
      } else if (frame.type === 'r') {
        runs.pop();
      } else if (frame.type === 'hyperlink') {
        links.pop();
        // The link's address is a fact the transcription would lose unless the
        // display text already says it (a bare address, an email, a phone number).
        if (!hyperlinkShowsTarget(frame.display, frame.target)) return null;
      } else if (frame.type === 'sect') {
        sections.push(frame);
      } else if (frame.type === 'tc') {
        sinks.pop();
        const lines = frame.lines.flatMap(line => line.split('\n'));
        // The row this cell belongs to is the nearest enclosing table frame, seen
        // through any wrapper (a content control, a smart tag) that has none.
        let parent;
        for (let index = open.length - 1; index >= 0; index -= 1) {
          if (open[index].frame) { parent = open[index].frame; break; }
        }
        if (parent?.type === 'tr') parent.cells.push(lines);
        else for (const line of lines) emit(line);
      } else if (frame.type === 'tr') {
        const filled = frame.cells.map(cell => cell.filter(line => line.trim()));
        // An empty cell in front of a filled one is a column position: dropping it
        // would read a value as if it stood in the first column.
        const lastFilled = filled.map(cell => cell.length > 0).lastIndexOf(true);
        if (lastFilled > 0 && filled.slice(0, lastFilled).some(cell => cell.length === 0)) return null;
        const cells = filled.filter(cell => cell.length);
        // A row whose cells hold several paragraphs is a layout table (a sidebar
        // beside the experience, say). Its reading order is a layout decision this
        // reader cannot verify, so it is not read.
        if (cells.length > 1 && cells.some(cell => cell.length > 1)) return null;
        if (cells.length === 1) for (const line of cells[0]) emit(line);
        else emit(cells.map(cell => cell[0]).join(FIELD_SEPARATOR));
      }
      continue;
    }

    // Opening (or self-closing) tag.
    let nameEnd = lt + 1;
    while (nameEnd < gt) {
      const code = xml.charCodeAt(nameEnd);
      if (code === 32 || code === 9 || code === 10 || code === 13 || code === 47) break;
      nameEnd += 1;
    }
    const name = xml.slice(lt + 1, nameEnd);
    const selfClosing = xml.charCodeAt(gt - 1) === 47;
    const attributes = xml.slice(nameEnd, selfClosing ? gt - 1 : gt);
    if (open.length >= DOCX_MAX_DEPTH) return null;

    // Every element below is matched by its literal "w:" prefix, so a part whose
    // WordprocessingML is bound to any other prefix (or to the default namespace)
    // would read as an EMPTY document, silently. The root must be the expected
    // element with w: bound to the WordprocessingML namespace, and no element in the
    // part may rebind that prefix, introduce a default namespace, or bind the
    // WordprocessingML namespace (or another one matched below) to a second prefix.
    if (!rootSeen) {
      rootSeen = true;
      if (name !== expectRoot || xmlAttribute(attributes, 'xmlns:w') !== WORD_NAMESPACE) return null;
    } else {
      if (!name.includes(':')) return null;
    }
    if (!faithful(name, attributes)) return null;

    if (skipAt >= 0) {
      if (!selfClosing) open.push({ name, frame: null });
      continue;
    }
    if (DOCX_UNSUPPORTED_ELEMENTS.has(name)) return null;

    if (DOCX_SKIPPED_ELEMENTS.has(name)) {
      // A tracked deletion of the paragraph MARK (w:del inside the mark's own run
      // properties) joins this paragraph to the next in the final view, which is
      // not the two lines this reader would emit.
      if ((name === 'w:del' || name === 'w:moveFrom') && open[open.length - 1]?.name === 'w:rPr' && open[open.length - 2]?.name === 'w:pPr') return null;
      // A tracked deletion of a whole table ROW is a marker inside the row's own
      // properties, not a container around its content: the runs stay ordinary
      // w:t, so nothing below would say the row is gone from the final view.
      if ((name === 'w:del' || name === 'w:moveFrom') && open[open.length - 1]?.name === 'w:trPr') return null;
      if (selfClosing) continue;
      open.push({ name, frame: null });
      skipAt = open.length - 1;
      continue;
    }

    // A property element applies to the run / paragraph / cell / table whose
    // property container it sits directly in.
    const parentName = open[open.length - 1]?.name;
    const container = () => open[open.length - 2]?.frame;
    const runProperty = () => (parentName === 'w:rPr' && container()?.type === 'r' ? container() : undefined);
    const pushPlain = () => { if (!selfClosing) open.push({ name, frame: null }); };

    switch (name) {
      case 'w:p':
        if (selfClosing) {
          bulletIndent = null;
          emit('');
        } else {
          const frame = { type: 'p', text: '', style: undefined, numId: undefined, ilvl: undefined, ind: undefined, fill: undefined, geometry: undefined, lineExact: undefined };
          open.push({ name, frame });
          paragraphs.push(frame);
        }
        break;
      case 'w:r': {
        if (selfClosing) break;
        const frame = { type: 'r', style: undefined, hidden: undefined, struck: undefined, script: undefined, position: undefined, color: undefined, shaded: undefined, size: undefined, fill: undefined, highlight: undefined, geometry: undefined, hazard: undefined };
        open.push({ name, frame });
        runs.push(frame);
        break;
      }
      case 'w:hyperlink': {
        // An external address behind display text is not shown on the page as text.
        // An internal anchor (no r:id) and a link whose relationship does not
        // resolve carry no address to lose.
        const rid = xmlAttribute(attributes, 'r:id');
        const rel = rid === undefined ? undefined : rels.get(rid);
        // w:anchor names a location INSIDE the target (`x.com/a` + `sec` is `x.com/a#sec`):
        // it is part of the address, so the display has to show it too.
        const anchor = (xmlAttribute(attributes, 'w:anchor') || '').trim();
        const target = rel === undefined ? '' : (anchor === '' ? rel.target : `${rel.target}#${anchor}`);
        if (rel === undefined) {
          pushPlain();
        } else if (selfClosing) {
          if (!hyperlinkShowsTarget('', target)) return null;
        } else {
          const frame = { type: 'hyperlink', target, display: '' };
          open.push({ name, frame });
          links.push(frame);
        }
        break;
      }
      case 'w:tbl':
        // A table that names no style gets the default table style.
        if (defaults.table !== undefined && tableStyleUnreadable(resolveStyle(styles, defaults.table))) return null;
        if (!selfClosing) open.push({ name, frame: { type: 'tbl', fill: undefined } });
        break;
      case 'w:tblStyle': {
        if (parentName === 'w:tblPr' && tableStyleUnreadable(styleFor(xmlAttribute(attributes, 'w:val'), 'table'))) return null;
        pushPlain();
        break;
      }
      case 'w:tc': {
        if (selfClosing) break;
        const frame = { type: 'tc', lines: [], fill: undefined };
        open.push({ name, frame });
        sinks.push(frame.lines);
        break;
      }
      case 'w:tr':
        if (!selfClosing) open.push({ name, frame: { type: 'tr', cells: [] } });
        break;
      case 'w:sectPr': {
        const frame = { type: 'sect', refs: [], titlePg: false, body: parentName === 'w:body' };
        if (selfClosing) sections.push(frame);
        else open.push({ name, frame });
        break;
      }
      case 'w:headerReference':
      case 'w:footerReference': {
        const parent = open[open.length - 1]?.frame;
        if (parent?.type === 'sect') {
          parent.refs.push({ kind: name === 'w:headerReference' ? 'header' : 'footer', type: xmlAttribute(attributes, 'w:type') || 'default', rid: xmlAttribute(attributes, 'r:id') });
        }
        pushPlain();
        break;
      }
      case 'w:titlePg': {
        const parent = open[open.length - 1]?.frame;
        if (parent?.type === 'sect') parent.titlePg = xmlFlagOn(attributes);
        pushPlain();
        break;
      }
      case 'w:pStyle': {
        const paragraph = paragraphs[paragraphs.length - 1];
        if (paragraph && parentName === 'w:pPr') paragraph.style = xmlAttribute(attributes, 'w:val');
        pushPlain();
        break;
      }
      case 'w:ilvl': {
        const paragraph = paragraphs[paragraphs.length - 1];
        if (paragraph && parentName === 'w:numPr') paragraph.ilvl = xmlAttribute(attributes, 'w:val');
        pushPlain();
        break;
      }
      case 'w:rStyle': {
        const run = runProperty();
        if (run) run.style = xmlAttribute(attributes, 'w:val');
        // Word's own style for an unfilled prompt ("Click or tap here to enter text").
        if (/^placeholder\s*text$/i.test((xmlAttribute(attributes, 'w:val') || '').trim())) return null;
        pushPlain();
        break;
      }
      case 'w:vanish':
      case 'w:specVanish': {
        const run = runProperty();
        // strike-style flags accumulate: vanish plus specVanish-off is still hidden.
        if (run) run.hidden = run.hidden === true || xmlFlagOn(attributes);
        // On a paragraph MARK it hides the mark, which joins this paragraph to the next.
        else if (parentName === 'w:rPr' && open[open.length - 2]?.name === 'w:pPr' && xmlFlagOn(attributes)) return null;
        pushPlain();
        break;
      }
      case 'w:strike':
      case 'w:dstrike': {
        const run = runProperty();
        // Two flags, one effect: a struck-off strike must not cancel a dstrike.
        if (run) run.struck = run.struck === true || xmlFlagOn(attributes);
        pushPlain();
        break;
      }
      case 'w:rFonts':
      case 'w14:textFill': {
        if (name === 'w:rFonts' ? symbolFontNamed(attributes) : true) {
          const run = runProperty();
          if (run) run.hazard = true;
          // Anywhere but a run's own properties or a paragraph mark's (a content
          // control's run properties, a tracked formatting change) this reader
          // does not know what text it reaches.
          else if (!(parentName === 'w:rPr' && open[open.length - 2]?.name === 'w:pPr')) return null;
        }
        pushPlain();
        break;
      }
      case 'w:background': {
        // The page colour Word paints behind the text (when it shows it at all): only
        // a plain white one is the page this reader assumes text sits on.
        const plainWhite = selfClosing && (xmlAttribute(attributes, 'w:color') || '').trim().toLowerCase() === PAGE_COLOR
          && xmlAttribute(attributes, 'w:themeColor') === undefined && xmlAttribute(attributes, 'w:themeFill') === undefined;
        if (!plainWhite) return null;
        break;
      }
      case 'w:showingPlcHdr':
        // A content control showing its placeholder: the shown text is a template
        // prompt, not the author's words.
        if (xmlFlagOn(attributes)) return null;
        pushPlain();
        break;
      case 'w:gridBefore': {
        // A row that starts at a later grid column leaves no empty cell for the row's
        // own column-position check to see, so its first cell would read as if it
        // stood in the first column. Only an explicit zero moves nothing.
        const skipped = Number.parseInt((xmlAttribute(attributes, 'w:val') || '').trim(), 10);
        if (parentName === 'w:trPr' && !(skipped === 0)) return null;
        pushPlain();
        break;
      }
      case 'w:trHeight': {
        // A row of an exact height below a legible line clips what it holds.
        const height = twips(attributes, 'w:val');
        if (parentName === 'w:trPr' && (xmlAttribute(attributes, 'w:hRule') || '').trim().toLowerCase() === 'exact' && (height === undefined || height < DOCX_MIN_EXACT_LINE)) return null;
        pushPlain();
        break;
      }
      case 'w:hidden':
        if (parentName === 'w:trPr' && xmlFlagOn(attributes)) return null;
        pushPlain();
        break;
      case 'w:color': {
        const run = runProperty();
        if (run) {
          run.color = wordColor(attributes, 'w:val', 'w:themeColor', remapped) ?? 'auto';
          run.shaded = themeShaded(attributes);
        }
        pushPlain();
        break;
      }
      case 'w:sz': {
        const run = runProperty();
        if (run) run.size = halfPoints(attributes);
        pushPlain();
        break;
      }
      case 'w:shd': {
        const fill = shadingFill(attributes, remapped);
        if (parentName === 'w:rPr' && container()?.type === 'r') container().fill = fill;
        else if (parentName === 'w:pPr' && container()?.type === 'p') container().fill = fill;
        else if (parentName === 'w:tcPr' && container()?.type === 'tc') container().fill = fill;
        else if (parentName === 'w:tblPr' && container()?.type === 'tbl') container().fill = fill;
        pushPlain();
        break;
      }
      case 'w:highlight': {
        const run = runProperty();
        if (run) run.highlight = highlightPaint(attributes);
        pushPlain();
        break;
      }
      case 'w:w':
      case 'w:fitText': {
        const run = runProperty();
        if (run && layoutHazard(name, attributes)) run.geometry = true;
        pushPlain();
        break;
      }
      case 'w:spacing': {
        // In a run's properties this is character spacing; in a paragraph's it is
        // the space around and between its lines.
        const run = runProperty();
        const paragraph = paragraphs[paragraphs.length - 1];
        if (run) {
          if (layoutHazard(name, attributes)) run.geometry = true;
        } else if (paragraph && parentName === 'w:pPr') {
          const line = exactLineHeight(attributes);
          if (line !== undefined) paragraph.lineExact = line;
        }
        pushPlain();
        break;
      }
      case 'w:ind': {
        const paragraph = paragraphs[paragraphs.length - 1];
        if (paragraph && parentName === 'w:pPr') {
          if (layoutHazard(name, attributes)) paragraph.geometry = true;
          paragraph.ind = indentSignature(attributes);
        }
        pushPlain();
        break;
      }
      case 'w:vertAlign': {
        const run = runProperty();
        if (run) {
          const value = xmlAttribute(attributes, 'w:val');
          run.script = value === 'superscript' ? 'sup' : value === 'subscript' ? 'sub' : 'none';
        }
        pushPlain();
        break;
      }
      case 'w:position': {
        const run = runProperty();
        if (run) run.position = !/^0?$/.test((xmlAttribute(attributes, 'w:val') || '').trim());
        pushPlain();
        break;
      }
      case 'w:t': {
        if (selfClosing) break;
        // Leaf: take the text up to the (required) closing tag. indexOf resumes
        // where the last one ended, so the scan is linear overall; a missing
        // closer ends the read rather than rescanning per opener.
        const close = xml.indexOf('</w:t>', pos);
        if (close < 0) return null;
        const raw = xml.slice(pos, close);
        if (raw.includes('<')) return null;
        pos = close + 6;
        const paragraph = paragraphs[paragraphs.length - 1];
        if (!paragraph) break;
        let text = decodeXmlEntities(raw);
        // A line break inside w:t is source formatting, not a break in the
        // paragraph (only w:br and w:cr are): Word folds it into the text, and
        // which way it folds is not something this reader states.
        if (/[\r\n\u0085\u2028\u2029]/.test(text)) return null;
        if (text.trim()) {
          const run = runs[runs.length - 1] || {};
          if (runUnreadable(run, paragraph)) return null;
          const script = run.script ?? styleFor(run.style, 'character').script ?? styleFor(paragraph.style, 'paragraph').script;
          if (script === 'sup' || script === 'sub') {
            const body = text.trim();
            const raised = scriptText(body, script);
            if (raised === null) return null;
            text = text.replace(body, () => raised);
          }
        }
        paragraph.text += text;
        if (links.length > 0) links[links.length - 1].display += text;
        break;
      }
      case 'w:tab':
      case 'w:ptab': {
        // <w:tab/> in a run is a tab character; <w:tab w:val=.. w:pos=../> inside
        // <w:tabs> only DEFINES a tab stop.
        const paragraph = paragraphs[paragraphs.length - 1];
        if (paragraph && parentName !== 'w:tabs') {
          if (runUnreadable(runs[runs.length - 1] || {}, paragraph)) return null;
          paragraph.text += '\t';
          if (links.length > 0) links[links.length - 1].display += '\t';
        }
        break;
      }
      case 'w:br':
      case 'w:cr': {
        const paragraph = paragraphs[paragraphs.length - 1];
        if (paragraph) {
          if (runUnreadable(runs[runs.length - 1] || {}, paragraph)) return null;
          paragraph.text += '\n';
          if (links.length > 0) links[links.length - 1].display += '\n';
        }
        break;
      }
      case 'w:noBreakHyphen': {
        const paragraph = paragraphs[paragraphs.length - 1];
        if (paragraph) {
          if (runUnreadable(runs[runs.length - 1] || {}, paragraph)) return null;
          paragraph.text += '-';
          if (links.length > 0) links[links.length - 1].display += '-';
        }
        break;
      }
      case 'w:numId': {
        const paragraph = paragraphs[paragraphs.length - 1];
        if (paragraph && parentName === 'w:numPr') paragraph.numId = xmlAttribute(attributes, 'w:val');
        pushPlain();
        break;
      }
      default:
        pushPlain();
    }
  }
  // Anything still open means the part was truncated or malformed.
  if (!rootSeen || open.length !== 0 || sinks.length !== 1) return null;
  const out = [];
  for (const raw of sinks[0]) {
    const line = trimBlankEnd(raw);
    if (!line && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

// A Word tab (a right-aligned date, a tab-stop field) becomes FIELD_SEPARATOR, and
// the blanks around it go with it. A tab that starts or ends the paragraph indents
// or pads it and separates nothing, and a run of tabs is one boundary. Linear: a
// regex over "blanks then a tab" rescans a long run of blanks from every start.
// True when a tab separates two non-blank pieces of the paragraph: fields, not
// padding at either end.
function hasFieldBoundary(text) {
  if (!text.includes('\t')) return false;
  let filled = 0;
  for (const piece of text.split('\t')) if (piece.trim()) filled += 1;
  return filled > 1;
}

function fieldSeparated(text) {
  if (!text.includes('\t')) return text;
  const pieces = text.split('\t');
  const last = pieces.length - 1;
  const fields = [];
  for (let index = 0; index <= last; index += 1) {
    let piece = pieces[index];
    if (index > 0) {
      let start = 0;
      while (start < piece.length && (piece.charCodeAt(start) === 32)) start += 1;
      piece = piece.slice(start);
    }
    if (index < last) piece = trimBlankEnd(piece);
    if (piece) fields.push(piece);
  }
  return fields.join(FIELD_SEPARATOR);
}

// ---- which header/footer parts the document actually DISPLAYS -----------------------

function documentPartPath(target) {
  if (!target || /(?:^|\/)\.\.(?:\/|$)/.test(target) || /^[a-z][a-z0-9+.-]*:/i.test(target)) return null;
  return target.startsWith('/') ? target.slice(1) : `word/${target}`;
}

/**
 * The DEFAULT header and footer the document displays, as relationship ids:
 * `{ header, footer }` (each an id or undefined for "none"), or null when they
 * cannot be stated with confidence. A header part exists in the ZIP whether or not
 * any page shows it (a stale "first page" header, an orphan), so only what the
 * body's final section references counts, and only when every page shows that
 * default: a title page (w:titlePg), separate even pages (w:evenAndOddHeaders) or
 * sections that display different headers each make "the" header ambiguous.
 */
function displayedDefaultHeaderFooter(sections, evenAndOdd) {
  if (evenAndOdd || sections.some(section => section.titlePg)) return null;
  const inherited = { header: undefined, footer: undefined };
  const seen = new Set();
  for (const section of sections) {
    for (const ref of section.refs) if (ref.type === 'default') inherited[ref.kind] = ref.rid ?? null;
    seen.add(`${inherited.header}|${inherited.footer}`);
  }
  if (seen.size > 1) return null;
  const last = sections[sections.length - 1];
  // Header references live on the body's final sectPr; one found only in a
  // paragraph means the part was not shaped the way Word writes it.
  if (last && !last.body && (inherited.header !== undefined || inherited.footer !== undefined)) return null;
  if (inherited.header === null || inherited.footer === null) return null;
  return { header: inherited.header, footer: inherited.footer };
}

async function readDocxText(resolved) {
  if (!(await statBinaryDocument(resolved))) return null;
  const buffer = await fs.readFile(resolved);
  const directory = readZipDirectory(buffer);
  if (!directory) return null;
  let budget = DOCX_MAX_TOTAL_BYTES;
  // undefined: the part is not in the archive. null: it is, and cannot be read.
  const readEntry = (name) => {
    const entry = directory.get(name);
    if (!entry) return undefined;
    budget -= entry.uncompressedSize;
    if (budget < 0) return null;
    const data = inflateZipEntry(buffer, entry);
    return data ? data.toString('utf8') : null;
  };

  // The main document part is the one the package's own relationships name, not
  // whichever part carries the conventional name: a leftover or decoy
  // word/document.xml beside the real body would otherwise be read in its place.
  // Only the conventional target is read; any other layout defers.
  const packageRelsXml = readEntry('_rels/.rels');
  if (typeof packageRelsXml !== 'string') return null;
  const packageRels = readRelationships(packageRelsXml);
  if (!packageRels) return null;
  const officeDocuments = [...packageRels.values()].filter(rel => /\/officeDocument$/.test(rel.type));
  if (officeDocuments.length !== 1 || officeDocuments[0].external || officeDocuments[0].target.replace(/^\//, '') !== 'word/document.xml') return null;

  const styleXml = readEntry('word/styles.xml');
  const numberingXml = readEntry('word/numbering.xml');
  const settingsXml = readEntry('word/settings.xml');
  const relsXml = readEntry('word/_rels/document.xml.rels');
  if (styleXml === null || numberingXml === null || settingsXml === null || relsXml === null) return null;
  let evenAndOdd = false;
  // A document that rebinds which theme slot is "background" and which is "text"
  // makes every theme colour reference (background1, text1, ...) unknowable here.
  let themeRemapped = false;
  if (settingsXml !== undefined) {
    const found = readXmlParts(settingsXml, (tags) => {
      let on = false;
      let remapped = false;
      for (const { closing, name, attributes } of tags) {
        if (closing) continue;
        if (name === 'w:evenAndOddHeaders') on = xmlFlagOn(attributes);
        else if (name === 'w:clrSchemeMapping') {
          for (const [attribute, standard] of [['w:bg1', 'light1'], ['w:t1', 'dark1'], ['w:bg2', 'light2'], ['w:t2', 'dark2']]) {
            const bound = xmlAttribute(attributes, attribute);
            if (bound !== undefined && bound.trim() !== standard) remapped = true;
          }
        }
      }
      return { on, remapped };
    }, true);
    if (!found) return null;
    evenAndOdd = found.on;
    themeRemapped = found.remapped;
  }
  const styleInfo = styleXml === undefined ? { styles: new Map(), defaults: {}, defaultSize: undefined, defaultsAlter: false } : readStyles(styleXml, themeRemapped);
  // A document whose DEFAULT text properties hide, shrink, whiten or raise every
  // run is not one this reader can describe run by run.
  if (!styleInfo || styleInfo.defaultsAlter) return null;
  const numbering = numberingXml === undefined ? null : readNumbering(numberingXml);
  if (numberingXml !== undefined && !numbering) return null;
  const rels = relsXml === undefined ? new Map() : readRelationships(relsXml);
  if (!rels) return null;
  const documentXml = readEntry('word/document.xml');
  if (typeof documentXml !== 'string') return null;
  const sections = [];
  const partContext = { styles: styleInfo.styles, defaults: styleInfo.defaults, defaultSize: styleInfo.defaultSize, remapped: themeRemapped, numbering };
  const body = plainTextFromWordXml(documentXml, { ...partContext, expectRoot: 'w:document', sections, rels });
  // A career document with no body text is not a read that succeeded: a body that
  // parsed to nothing must never let a header alone stand for the whole file.
  if (body === null || !body.trim()) return null;

  const displayed = displayedDefaultHeaderFooter(sections, evenAndOdd);
  if (!displayed) return null;
  const pieces = { header: '', footer: '' };
  for (const kind of ['header', 'footer']) {
    const rid = displayed[kind];
    if (rid === undefined) continue;
    const rel = rels.get(rid);
    const part = rel && new RegExp(`/${kind}$`).test(rel.type) && !rel.external ? documentPartPath(rel.target) : null;
    if (!part) return null;
    const xml = readEntry(part);
    if (typeof xml !== 'string') return null;
    // A header's hyperlinks are resolved by its OWN relationships part.
    const partRelsXml = readEntry(part.replace(/(^|\/)([^/]+)$/, '$1_rels/$2.rels'));
    if (partRelsXml === null) return null;
    const partRels = partRelsXml === undefined ? new Map() : readRelationships(partRelsXml);
    if (!partRels) return null;
    const text = plainTextFromWordXml(xml, { ...partContext, expectRoot: kind === 'header' ? 'w:hdr' : 'w:ftr', rels: partRels });
    if (text === null) return null;
    pieces[kind] = text.trim();
  }

  const text = [pieces.header, body.trim(), pieces.footer].filter(Boolean).join('\n\n');
  if (text.includes('\uFFFD') || PUA_RE.test(text) || hasControlChar(text) || INVISIBLE_CHAR_RE.test(text) || C1_AND_SEPARATOR_RE.test(text)) return null;
  return text.trim() || null;
}

/**
 * Read a career file's text locally: plain text verbatim, or a plain DOCX via its
 * document XML. Returns null - never throws - whenever the read is not
 * confidently faithful (any construct listed above, an unsupported or hostile ZIP,
 * an oversized file, a sensitive path), and ALWAYS for a PDF, so the AI
 * transcription runs for exactly those files.
 */
export async function readCareerFileText(filePath) {
  try {
    const resolved = path.resolve(String(filePath || ''));
    const ext = path.extname(resolved).toLowerCase();
    if (PLAIN_TEXT_EXT.has(ext)) return await readPlainTextDocument(resolved);
    if (ext !== '.docx') return null;
    if (isSensitivePath(resolved)) return null;
    const text = await readDocxText(resolved);
    if (typeof text !== 'string') return null;
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > EXTRACTED_TEXT_MAX_CHARS) return null;
    return trimmed;
  } catch {
    return null;
  }
}

// Test seam (no behaviour): the DOCX reader WITHOUT readCareerFileText's catch-all,
// so a test can tell a refusal the reader states (null) from an exception the
// catch-all would quietly turn into null.
export async function __readDocxTextForTests(filePath) {
  return readDocxText(path.resolve(String(filePath || '')));
}
