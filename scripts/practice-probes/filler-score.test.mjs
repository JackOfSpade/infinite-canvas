import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseScript, normalizeText, align, scoreTranscript } from './filler-score.mjs';

const SCRIPT = '<!-- SCRIPT START -->\n{um} So I [restart: went to the] {uh} drove to the office, {um} and {uh} then left.\n<!-- SCRIPT END -->';

/** Build a hypothesis from parsed tokens, keeping only fillers selected by keep(fillerOrdinal). */
function hypothesisFrom(markdown, keep) {
  const { tokens } = parseScript(markdown);
  let ordinal = 0;
  return tokens
    .filter((t) => !t.filler || keep(ordinal++))
    .map((t) => t.word)
    .join(' ');
}

const REAL = readFileSync(fileURLToPath(new URL('./reading-script.md', import.meta.url)), 'utf8');

test('reading script has >= 20 fillers and >= 5 restarts', () => {
  const { tokens, restarts } = parseScript(REAL);
  assert.ok(tokens.filter((t) => t.filler).length >= 20);
  assert.ok(restarts.length >= 5);
  assert.ok(!tokens.some((t) => t.word === 'restart'), 'instructions must be excluded');
});

test('parseScript extracts fillers and restart spans', () => {
  const { tokens, restarts } = parseScript(SCRIPT);
  assert.deepEqual(tokens.filter((t) => t.filler).map((t) => t.word), ['um', 'uh', 'um', 'uh']);
  assert.equal(restarts.length, 1);
  assert.deepEqual(restarts[0].words, ['went', 'to', 'the']);
});

test('normalizeText lowercases and strips punctuation', () => {
  assert.deepEqual(normalizeText('Um, So... "I\u2019m" here!'), ['um', 'so', "i'm", 'here']);
});

test('align reports insertions and deletions', () => {
  const ops = align(['a', 'b', 'c'], ['a', 'x', 'b', 'c']);
  assert.deepEqual(ops.map((o) => o.op), ['match', 'ins', 'match', 'match']);
  const ops2 = align(['a', 'b', 'c'], ['a', 'c']);
  assert.deepEqual(ops2.map((o) => o.op), ['match', 'del', 'match']);
});

test('all fillers kept => recall 1, WER 0, local', () => {
  const r = scoreTranscript(SCRIPT, hypothesisFrom(SCRIPT, () => true));
  assert.equal(r.fillersReference, 4);
  assert.equal(r.fillersRecalled, 4);
  assert.equal(r.recall, 1);
  assert.equal(r.wer, 0);
  assert.equal(r.verdict, 'local');
  assert.deepEqual(r.perFiller.um, { reference: 2, recalled: 2, recall: 1 });
  assert.deepEqual(r.perFiller.uh, { reference: 2, recalled: 2, recall: 1 });
  assert.equal(r.restartsReference, 1);
  assert.equal(r.restartsWithAbandonedWordsKept, 1);
});

test('half fillers kept => recall 0.5, cloud', () => {
  const r = scoreTranscript(SCRIPT, hypothesisFrom(SCRIPT, (i) => i % 2 === 0));
  assert.equal(r.fillersRecalled, 2);
  assert.equal(r.recall, 0.5);
  assert.equal(r.verdict, 'cloud');
});

test('no fillers kept => recall 0, cloud, per-filler zero', () => {
  const r = scoreTranscript(SCRIPT, hypothesisFrom(SCRIPT, () => false));
  assert.equal(r.fillersRecalled, 0);
  assert.equal(r.recall, 0);
  assert.equal(r.perFiller.um.recalled, 0);
  assert.equal(r.perFiller.uh.recalled, 0);
  assert.equal(r.verdict, 'cloud');
});

test('a hypothesis filler of the wrong kind does not count as recalled', () => {
  const swapped = hypothesisFrom(SCRIPT, () => true).replace(/\buh\b/g, 'um');
  const r = scoreTranscript(SCRIPT, swapped);
  assert.equal(r.perFiller.uh.recalled, 0);
  assert.equal(r.perFiller.um.recalled, 2);
});

test('0.8 boundary: 4/5 is local, 3/5 is cloud (real script scale)', () => {
  const five = '<!-- SCRIPT START -->\none {um} two {um} three {um} four {um} five {um} six\n<!-- SCRIPT END -->';
  const four = scoreTranscript(five, hypothesisFrom(five, (i) => i !== 2));
  assert.equal(four.recall, 0.8);
  assert.equal(four.verdict, 'local');
  const three = scoreTranscript(five, hypothesisFrom(five, (i) => i < 3));
  assert.equal(three.recall, 0.6);
  assert.equal(three.verdict, 'cloud');
});

test('insertions and deletions of ordinary words still align fillers', () => {
  const hyp = 'um so I went to the extra uh drove office um and uh then left';
  const r = scoreTranscript(SCRIPT, hyp);
  assert.equal(r.fillersRecalled, 4);
  assert.ok(r.wer > 0);
  assert.equal(r.verdict, 'local');
});

test('empty transcript is INCONCLUSIVE', () => {
  assert.equal(scoreTranscript(SCRIPT, '').verdict, 'INCONCLUSIVE');
  assert.equal(scoreTranscript(SCRIPT, { segments: [], words: [] }).verdict, 'INCONCLUSIVE');
});

test('high WER (bad recording) is INCONCLUSIVE even if fillers match', () => {
  const r = scoreTranscript(SCRIPT, 'um uh um uh banana banana banana banana banana banana banana');
  assert.ok(r.wer > 0.5);
  assert.equal(r.verdict, 'INCONCLUSIVE');
});

test('restart detection: abandoned words dropped => not kept', () => {
  const kept = scoreTranscript(SCRIPT, 'um so I went to the uh drove to the office um and uh then left');
  assert.equal(kept.restartsWithAbandonedWordsKept, 1);
  const cleaned = scoreTranscript(SCRIPT, 'um so I uh drove to the office um and uh then left');
  assert.equal(cleaned.restartsReference, 1);
  assert.equal(cleaned.restartsWithAbandonedWordsKept, 0);
});

test('SpeechProbe JSON shape is accepted (segments)', () => {
  const json = { engine: 'apple-speechtranscriber', segments: [{ text: 'Um, so I went to the', startMs: 0, endMs: 1 }, { text: 'uh drove to the office, um and uh then left.', startMs: 1, endMs: 2 }] };
  const r = scoreTranscript(SCRIPT, json);
  assert.equal(r.fillersRecalled, 4);
  assert.equal(r.verdict, 'local');
});
