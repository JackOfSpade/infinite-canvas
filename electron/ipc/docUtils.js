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
  // read carrying any is not faithful. The refusal set is FFFD, PUA, control
  // characters incl. NUL, INVISIBLE_CHAR_RE incl. a stray BOM, C1 controls and
  // U+2028/2029, which no career file legitimately holds.
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

// C1 controls (U+0080-009F, NEL and the ANSI CSI included) and the Unicode line /
// paragraph separators (U+2028, U+2029). None is text a career file holds.
const C1_AND_SEPARATOR_RE = /[\u0080-\u009F\u2028\u2029]/u;
