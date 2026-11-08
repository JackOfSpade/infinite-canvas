// Filler-recall scorer for the SpeechTranscriber probe.
//
// Library + CLI:
//   node filler-score.mjs --script reading-script.md --transcript words.json
//
// The reference is parsed from the script markup only:
//   {um} / {uh}                 -> a filler token ("um"/"uh"); any {word} works,
//                                  no filler list is hard-coded here
//   [restart: abandoned words]  -> spoken words that were then abandoned
// Reference and hypothesis are aligned with word-level Levenshtein + backtrace.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const RECALL_THRESHOLD = 0.8; // recall >= 0.8 => analysis stays local
export const WER_INCONCLUSIVE_ABOVE = 0.5;

const SCRIPT_START = '<!-- SCRIPT START -->';
const SCRIPT_END = '<!-- SCRIPT END -->';

export function normalizeText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[-\u2013\u2014]/g, ' ')
    .replace(/[^\p{L}\p{N}'\s]/gu, ' ')
    .replace(/(^|\s)'+|'+(?=\s|$)/g, '$1')
    .split(/\s+/)
    .filter(Boolean);
}

/** Parse script markdown into reference tokens and restart spans. */
export function parseScript(markdown) {
  let body = String(markdown ?? '');
  const start = body.indexOf(SCRIPT_START);
  if (start >= 0) body = body.slice(start + SCRIPT_START.length);
  const end = body.indexOf(SCRIPT_END);
  if (end >= 0) body = body.slice(0, end);

  const tokens = []; // {word, filler: bool}
  const restarts = []; // {words, startIndex, endIndex} (endIndex exclusive)
  const markup = /\{([^{}]+)\}|\[restart:([^\]]*)\]/gi;
  let cursor = 0;
  const pushPlain = (chunk) => {
    for (const word of normalizeText(chunk)) tokens.push({ word, filler: false });
  };
  for (const match of body.matchAll(markup)) {
    pushPlain(body.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[1] !== undefined) {
      for (const word of normalizeText(match[1])) tokens.push({ word, filler: true });
    } else {
      const startIndex = tokens.length;
      pushPlain(match[2]);
      if (tokens.length > startIndex) {
        restarts.push({
          words: tokens.slice(startIndex).map((t) => t.word),
          startIndex,
          endIndex: tokens.length,
        });
      }
    }
  }
  pushPlain(body.slice(cursor));
  return { tokens, restarts };
}

/** Accepts a string or the SpeechProbe JSON ({segments, words}); returns hypothesis tokens. */
export function hypothesisTokens(transcript) {
  if (typeof transcript === 'string') return normalizeText(transcript);
  if (Array.isArray(transcript)) return normalizeText(transcript.map((s) => s?.text ?? s).join(' '));
  const parts = Array.isArray(transcript?.segments) && transcript.segments.length
    ? transcript.segments
    : Array.isArray(transcript?.words) ? transcript.words : [];
  return normalizeText(parts.map((p) => p?.text ?? '').join(' '));
}

/**
 * Word-level Levenshtein alignment with backtrace.
 * Returns ops in order: {op: 'match'|'sub'|'del'|'ins', ref: index|null, hyp: index|null}.
 * del = reference word missing from hypothesis; ins = extra hypothesis word.
 */
export function align(ref, hyp) {
  const n = ref.length;
  const m = hyp.length;
  const dist = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i += 1) dist[i][0] = i;
  for (let j = 0; j <= m; j += 1) dist[0][j] = j;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const diag = dist[i - 1][j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1);
      dist[i][j] = Math.min(diag, dist[i - 1][j] + 1, dist[i][j - 1] + 1);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const same = ref[i - 1] === hyp[j - 1];
      if (dist[i][j] === dist[i - 1][j - 1] + (same ? 0 : 1)) {
        ops.push({ op: same ? 'match' : 'sub', ref: i - 1, hyp: j - 1 });
        i -= 1; j -= 1;
        continue;
      }
    }
    if (i > 0 && dist[i][j] === dist[i - 1][j] + 1) {
      ops.push({ op: 'del', ref: i - 1, hyp: null });
      i -= 1;
    } else {
      ops.push({ op: 'ins', ref: null, hyp: j - 1 });
      j -= 1;
    }
  }
  return ops.reverse();
}

/** Score a hypothesis (string or SpeechProbe JSON) against script markdown. */
export function scoreTranscript(scriptMarkdown, transcript) {
  const { tokens, restarts } = parseScript(scriptMarkdown);
  const ref = tokens.map((t) => t.word);
  const hyp = hypothesisTokens(transcript);
  const ops = align(ref, hyp);

  const matched = new Set();
  let errors = 0;
  for (const o of ops) {
    if (o.op === 'match') matched.add(o.ref);
    else errors += 1;
  }

  const perFiller = {};
  let fillersReference = 0;
  let fillersRecalled = 0;
  tokens.forEach((t, index) => {
    if (!t.filler) return;
    const slot = (perFiller[t.word] ??= { reference: 0, recalled: 0, recall: 0 });
    slot.reference += 1;
    fillersReference += 1;
    if (matched.has(index)) { slot.recalled += 1; fillersRecalled += 1; }
  });
  for (const slot of Object.values(perFiller)) {
    slot.recall = slot.reference ? slot.recalled / slot.reference : 0;
  }

  let restartsWithAbandonedWordsKept = 0;
  for (const r of restarts) {
    let kept = true;
    for (let k = r.startIndex; k < r.endIndex; k += 1) if (!matched.has(k)) kept = false;
    if (kept) restartsWithAbandonedWordsKept += 1;
  }

  const wer = ref.length ? errors / ref.length : 1;
  const recall = fillersReference ? fillersRecalled / fillersReference : null;
  let verdict;
  if (hyp.length === 0 || fillersReference === 0 || wer > WER_INCONCLUSIVE_ABOVE) {
    verdict = 'INCONCLUSIVE';
  } else {
    // Integer compare avoids float error at the exact 0.8 boundary.
    verdict = fillersRecalled * 5 >= fillersReference * 4 ? 'local' : 'cloud';
  }
  return {
    fillersReference,
    fillersRecalled,
    recall,
    perFiller,
    restartsReference: restarts.length,
    restartsWithAbandonedWordsKept,
    wer,
    verdict,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--script') out.script = argv[++i];
    else if (argv[i] === '--transcript') out.transcript = argv[++i];
  }
  return out;
}

export function main(argv = process.argv.slice(2)) {
  const { script, transcript } = parseArgs(argv);
  if (!script || !transcript) {
    console.error('usage: node filler-score.mjs --script reading-script.md --transcript words.json');
    return 2;
  }
  const raw = readFileSync(transcript, 'utf8');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { parsed = raw; }
  const result = scoreTranscript(readFileSync(script, 'utf8'), parsed);
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
