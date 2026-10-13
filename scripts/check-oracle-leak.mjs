#!/usr/bin/env node
// Acceptance-only leak gate: fails when distinctive facts of a REAL career
// source file appear in shipped code, prompts, docs, or test fixtures.
//
// The oracle file is never copied into the repository.  Point the gate at it
// with an environment variable at run time:
//
//   CAREER_ORACLE_PATH="/path/outside/repo/Work Experience.md" node scripts/check-oracle-leak.mjs
//
// How it decides.  Two independent checks, both case-insensitive. Only the
// copied-sentence (ngram) class blocks; generic name matches are diagnostic:
//
//   1. Names.  Proper-noun candidates from the oracle (runs of capitalised
//      words, single capitalised words that never occur in lower case in the
//      oracle, e-mail addresses and links) are searched as whole words.  A
//      single word that is an ordinary lower-case word of a BACKGROUND
//      vocabulary that excludes the oracle (by default the system word list)
//      is not a name.
//      How many files a name appears in never matters: a name that leaked into
//      every file is the widest leak, not shared vocabulary.
//   2. Sentences.  Every run of CAREER_ORACLE_NGRAM (default 6) consecutive
//      words of one oracle line, lower-cased, that holds at least three content
//      words is searched in each file's word stream, so a career sentence copied
//      verbatim is found whatever its case, punctuation or line wrapping, and
//      even when the employer name beside it was changed.
//
// Shared tokens (the product's own name, generic role titles, public technology
// names) are allowlisted explicitly by the person running the gate:
//   CAREER_ORACLE_IGNORE="Token One,Token Two"
// An ignored phrase also covers every n-gram it contains. Exit status 1 on an
// ngram finding, 2 on a usage error.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCANNED_TREES = Object.freeze([
  'electron', 'src', 'local_ai', 'public', 'docs', 'Job Application Design System', 'scripts',
]);
// `build` is skipped only as a repository-root output directory: the design
// system keeps real test sources under "Job Application Design System/build/".
const SKIPPED_DIRECTORIES = new Set(['node_modules', 'dist', 'dist-electron', 'release', '.git', '.test-artifacts']);
const SKIPPED_ROOT_DIRECTORIES = new Set(['build']);
const SCANNED_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.html', '.css', '.txt']);
const MAX_FILE_BYTES = 6 * 1024 * 1024;
export const DEFAULT_NGRAM_WORDS = 6;
export const MIN_NGRAM_CONTENT_WORDS = 3;
export const DEFAULT_BACKGROUND_PATHS = Object.freeze(['/usr/share/dict/words']);
const MAX_REPORTED_LINES = 5;

// Function words carry no fact; an n-gram made mostly of them is ordinary prose.
const FUNCTION_WORDS = new Set(`a an and are as at be been but by for from had has have he her his i in into is it its me my of on or our she so than that the their them then there these they this those to too us was we were what when where which while who will with you your
  over under about after before during each every per via also all any both more most other some such only own same very just not no nor can could would should may might must do does did done`.split(/\s+/u).filter(Boolean));

function normalize(text) { return String(text ?? '').normalize('NFKC'); }
function lowerWords(text) { return normalize(text).toLowerCase().match(/[\p{L}\p{N}]+/gu) || []; }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

/** Proper-noun, contact and link candidates of the oracle, in first-seen order. */
export function oracleTokens(text, { background = null } = {}) {
  const source = normalize(text);
  const lowerSeen = new Set((source.match(/\b[a-z][a-z'’-]{3,}\b/g) || []));
  const lowerInOracle = word => lowerSeen.has(word.toLowerCase().replace(/[.'’-]+$/u, ''));
  const tokens = new Set();
  // Runs of 2-4 capitalised words ("Some Employer Name").  A run made only of
  // words the oracle itself also writes in lower case ("Job Search") is
  // vocabulary; a proper-noun run has at least one word it never does.  The
  // background vocabulary is not consulted here: an employer whose name is
  // made of ordinary words ("General Harbor Works") is still a name.
  // A run never crosses a line: a heading is not one name with the line below it.
  for (const match of source.matchAll(/\b(?:[A-Z][\p{L}'’.-]+)(?:[ \t]+(?:(?:of|the|and|&)[ \t]+)?[A-Z][\p{L}'’.-]+){1,3}\b/gu)) {
    const run = match[0].replace(/\s+/gu, ' ').trim();
    if (run.length >= 7 && run.split(' ').some(word => /^[A-Z]/u.test(word) && !lowerInOracle(word))) tokens.add(run);
  }
  // Single capitalised words that are neither written in lower case in the
  // oracle nor an ordinary word of the background vocabulary.
  for (const match of source.matchAll(/\b[A-Z][\p{L}'’-]{3,}\b/gu)) {
    if (!lowerInOracle(match[0]) && !background?.has(match[0].toLowerCase())) tokens.add(match[0]);
  }
  // Contact-shaped strings and links are always distinctive.
  for (const match of source.matchAll(/[\w.+-]+@[\w-]+\.[\w.-]+/gu)) tokens.add(match[0].replace(/[.]+$/u, ''));
  for (const match of source.matchAll(/\bhttps?:\/\/[^\s)>\]"'`]+/gu)) tokens.add(match[0].replace(/[.,;]+$/u, ''));
  return [...tokens];
}

/**
 * Every run of `size` consecutive words of one oracle line that holds at least
 * MIN_NGRAM_CONTENT_WORDS content words, lower-cased and joined by one space.
 */
export function oracleNgrams(text, size = DEFAULT_NGRAM_WORDS) {
  const grams = new Set();
  for (const line of normalize(text).split(/\r?\n/u)) {
    const wordList = lowerWords(line);
    for (let index = 0; index + size <= wordList.length; index += 1) {
      const window = wordList.slice(index, index + size);
      if (window.filter(word => !FUNCTION_WORDS.has(word) && !/^\d+$/u.test(word)).length >= MIN_NGRAM_CONTENT_WORDS) grams.add(window.join(' '));
    }
  }
  return grams;
}

/**
 * The ordinary words of a background vocabulary that excludes the oracle (a
 * word list, one word per line, or free text).  Only words the list itself
 * writes in lower case count: a capitalised entry of a word list is a proper
 * noun, and a proper noun is exactly what the gate must keep looking for.
 */
export function backgroundVocabulary(text) {
  const words = new Set();
  for (const match of normalize(text).matchAll(/(?<![\p{L}\p{N}])\p{Ll}[\p{L}]*/gu)) words.add(match[0]);
  return words;
}
export function loadBackgroundVocabulary(paths = DEFAULT_BACKGROUND_PATHS) {
  const words = new Set();
  for (const file of paths) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const word of backgroundVocabulary(text)) words.add(word);
  }
  return words;
}

function* walk(directory, root) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const rootLevelOutput = directory === root && SKIPPED_ROOT_DIRECTORIES.has(entry.name);
      if (!SKIPPED_DIRECTORIES.has(entry.name) && !rootLevelOutput) yield* walk(path.join(directory, entry.name), root);
    } else if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      yield path.join(directory, entry.name);
    }
  }
}

function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
  return starts;
}
function lineOf(starts, offset) {
  let low = 0; let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle; else high = middle - 1;
  }
  return low + 1;
}

// Whole-word, case-insensitive, whitespace-tolerant (a name may wrap a line).
function tokenPattern(token) {
  const body = token.split(/\s+/u).map(escapeRegExp).join('\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

/**
 * Scan the trees under `root` for the oracle's names and sentences.  Returns
 * one finding per (token, file): { kind: 'name' | 'ngram', token, file, lines,
 * count }.  `ignore` lists allowlisted tokens or phrases (case-insensitive).
 */
export function scanForLeaks(text, {
  root = ROOT, trees = SCANNED_TREES, ngramWords = DEFAULT_NGRAM_WORDS, background = null, ignore = [],
} = {}) {
  const ignored = (Array.isArray(ignore) ? ignore : []).map(value => lowerWords(value).join(' ')).filter(Boolean);
  const ignoredSet = new Set(ignored);
  const names = oracleTokens(text, { background })
    .filter(token => !ignoredSet.has(lowerWords(token).join(' ')))
    .map(token => ({ token, pattern: tokenPattern(normalize(token)) }));
  const grams = ngramWords > 0 ? [...oracleNgrams(text, ngramWords)].filter(gram => !ignored.some(phrase => ` ${phrase} `.includes(` ${gram} `))) : [];
  const gramSet = new Set(grams);
  const findings = [];
  for (const tree of trees) {
    for (const file of walk(path.join(root, tree), root)) {
      let stat;
      try { stat = fs.statSync(file); } catch { continue; }
      if (stat.size > MAX_FILE_BYTES) continue;
      const content = normalize(fs.readFileSync(file, 'utf8'));
      const starts = lineStarts(content);
      const key = path.relative(root, file);
      for (const { token, pattern } of names) {
        pattern.lastIndex = 0;
        const lines = [];
        for (const match of content.matchAll(pattern)) lines.push(lineOf(starts, match.index));
        if (lines.length) findings.push({ kind: 'name', token, file: key, lines: [...new Set(lines)].slice(0, MAX_REPORTED_LINES), count: lines.length });
      }
      if (!gramSet.size) continue;
      const stream = [];
      for (const match of content.matchAll(/[\p{L}\p{N}]+/gu)) stream.push({ word: match[0].toLowerCase(), offset: match.index });
      let first = null; const lines = []; let count = 0;
      for (let index = 0; index + ngramWords <= stream.length; index += 1) {
        const gram = stream.slice(index, index + ngramWords).map(entry => entry.word).join(' ');
        if (!gramSet.has(gram)) continue;
        first ??= gram; count += 1;
        lines.push(lineOf(starts, stream[index].offset));
      }
      if (count) findings.push({ kind: 'ngram', token: first, file: key, lines: [...new Set(lines)].slice(0, MAX_REPORTED_LINES), count });
    }
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const oraclePath = process.env.CAREER_ORACLE_PATH;
  if (!oraclePath) {
    console.error('Set CAREER_ORACLE_PATH to a career source file that lives outside this repository.');
    process.exit(2);
  }
  // The scanned root defaults to this repository; a test points it at a fixture tree.
  const scanRoot = path.resolve(process.env.CAREER_ORACLE_SCAN_ROOT || ROOT);
  const resolvedOracle = path.resolve(oraclePath);
  if (resolvedOracle.startsWith(`${ROOT}${path.sep}`) || resolvedOracle.startsWith(`${scanRoot}${path.sep}`)) {
    console.error('The oracle file must live outside the repository.');
    process.exit(2);
  }
  let oracle;
  try { oracle = fs.readFileSync(resolvedOracle, 'utf8'); } catch (error) {
    console.error(`Cannot read the oracle file: ${error.message}`);
    process.exit(2);
  }
  const ngramWords = process.env.CAREER_ORACLE_NGRAM ? Number(process.env.CAREER_ORACLE_NGRAM) : DEFAULT_NGRAM_WORDS;
  if (!Number.isInteger(ngramWords) || ngramWords < 3) {
    console.error('CAREER_ORACLE_NGRAM must be an integer of at least 3.');
    process.exit(2);
  }
  // CAREER_ORACLE_BACKGROUND lists oracle-free word lists (path-delimiter
  // separated); "none" disables the background so every capitalised word counts.
  const backgroundSetting = process.env.CAREER_ORACLE_BACKGROUND;
  const background = backgroundSetting === 'none' ? null
    : loadBackgroundVocabulary(backgroundSetting ? backgroundSetting.split(path.delimiter).filter(Boolean) : DEFAULT_BACKGROUND_PATHS);
  const ignore = (process.env.CAREER_ORACLE_IGNORE || '').split(',').map(value => value.trim()).filter(Boolean);
  const findings = scanForLeaks(oracle, { root: scanRoot, ngramWords, background, ignore });
  const ngrams = findings.filter(finding => finding.kind === 'ngram');
  const nameCount = findings.length - ngrams.length;
  const summary = `oracle leak gate: ${ngrams.length} ngram / ${nameCount} name (noise)`;
  if (!ngrams.length) {
    console.log(summary);
    process.exit(0);
  }
  console.error(summary);
  for (const finding of ngrams) console.error(`  ${finding.file}:${finding.lines.join(',')} x${finding.count}  ${finding.kind} ${JSON.stringify(finding.token)}`);
  process.exit(1);
}
