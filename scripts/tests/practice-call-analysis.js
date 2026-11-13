import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeCall, checkReview, fillerTotals, wordsByAnswer } from '../../electron/practiceCall/analysis/analyzeCall.js';
import { buildChapters } from '../../electron/practiceCall/analysis/chapters.js';
import { REVIEW_SCHEMA, buildReviewPrompt } from '../../electron/practiceCall/analysis/reviewPrompt.js';

// Synthetic call: small talk, two questions, a typed answer, then the farewell.
const transcript = [
  { speaker: 'interviewer', text: 'Hi, thanks for joining. How are you today?', startMs: 0, endMs: 4000 },
  { speaker: 'candidate', text: 'Good, thanks. Glad to be here.', startMs: 4200, endMs: 7000 },
  { speaker: 'interviewer', text: 'Tell me about yourself.', startMs: 7500, endMs: 9500 },
  { speaker: 'candidate', text: 'I build checkout systems for busy stores.', startMs: 12000, endMs: 20000 },
  { speaker: 'interviewer', text: 'Why this team in particular?', startMs: 20500, endMs: 22500 },
  { speaker: 'candidate', text: 'Because you ship voice, and I have shipped audio.', startMs: 23000, endMs: 30000 },
  { speaker: 'candidate', text: 'One number: 42% fewer drop-offs.', startMs: 31000, endMs: 32000, channel: 'chat' },
  { speaker: 'interviewer', text: 'That is all from me. Thanks for your time.', startMs: 33000, endMs: 38000 },
];
const callRecord = {
  callId: 'call-3_A', nodeId: 'node-1', startedAt: '2026-11-08T10:00:00.000Z', endedAt: '2026-11-08T10:00:40.000Z', durationMs: 40000,
  persona: 'Warm hiring manager', transcript,
  toneNotes: [{ atMs: 15000, note: 'voice dropped' }],
  toneSamples: [{ atMs: 5000, arousal: 0.4, dominance: 0.5, valence: 0.6 }, { atMs: 25000, arousal: 0.5, dominance: 0.6, valence: 0.4 }],
  candidateProsodyByTurn: { 3: { wordsPerMinute: 130, pauses: [{ startMs: 16000, endMs: 19000 }] } }, baseline: { ready: true },
};
const plan = [{ id: 'intro', question: 'Tell me about yourself.', headline: 'Checkout engineer.', bullets: ['Shipped the redesign'], example: 'At Acme I led the migration.' }];
const brief = { role: { title: 'Product engineer', company: 'Discord' } };
const words = [{ text: 'I', startMs: 13000, endMs: 13100 }, { text: 'um', startMs: 13200, endMs: 13300 }, { text: 'Because', startMs: 23100, endMs: 23200 }];
const metrics = {
  answers: [{ turnIndex: 3, pauses: [{ startMs: 17000, endMs: 18000 }] }, { turnIndex: 5, pauses: [] }],
  interruptions: [{ atMs: 24000, beforeQuestionFinished: false }],
};
const reviewFeedback = {
  overall: { score: 7, summary: 'Calm and specific; the examples carried it.' },
  planned: [{ question: 'Tell me about yourself.', asked: true, askedAs: 'Tell me about yourself.', score: 7, covered: 'Headline and example.' }],
  moments: [], communication: { pace: 'steady', clarity: 'clear', structure: 'two-part', confidence: 'even', filler: 'a few' },
  priorities: ['Name the outcome first.'], transcript: [],
  delivery: { summary: 'Steady pace with two long pauses.', pace: 'about 130 words per minute', pauses: 'Two over one second', fillers: 'Fewer than before', confidence: 'even', interruptions: 'One, after the question finished', typedAnswers: 'One typed number', fillerCount: 4, wordsPerMinute: 130 },
};
const review = {
  feedback: reviewFeedback,
  chapters: [{ questionTurnIndex: 4, title: 'Motivation' }, { questionTurnIndex: 2, title: 'Background' }],
  moments: [{ turnIndex: 3, label: 'Paused before the number', kind: 'moment' }, { turnIndex: 5, label: 'Filler while thinking', kind: 'filler' }],
};
const tempDir = async () => fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-call-analysis-'));
const readAnalysis = async dir => JSON.parse(await fs.promises.readFile(path.join(dir, 'analysis.json'), 'utf8'));

export default [
  { name: 'practice call analysis: one review, chapters from question anchors, analysis.json written atomically', async run() {
    const dir = await tempDir();
    try {
      await fs.promises.writeFile(path.join(dir, 'candidate.wav'), 'fake wav');
      const calls = { scribe: [], metrics: [], review: [] };
      const deps = {
        transcribe: request => { calls.scribe.push(request); return { words }; },
        metrics: request => { calls.metrics.push(request); return metrics; },
        callText: request => { calls.review.push(request); return review; },
        now: () => '2026-11-08T10:05:00.000Z',
      };
      const result = await analyzeCall({ callDir: dir, callRecord, plan, brief, deps });
      assert.equal(calls.scribe.length, 1);
      assert.equal(calls.scribe[0].path, path.join(dir, 'candidate.wav'), 'Scribe reads the candidate track');
      assert.deepEqual(calls.metrics[0], { transcript, candidateProsodyByTurn: callRecord.candidateProsodyByTurn, baselineSnapshot: callRecord.baseline });
      assert.equal(calls.review.length, 1, 'exactly one review call');
      assert.deepEqual(calls.review[0].profile, { model: 'opus', effort: 'medium' });
      assert.equal(calls.review[0].schema, REVIEW_SCHEMA);
      const prompt = calls.review[0].prompt;
      for (const needle of [
        '[2] interviewer 00:07-00:09: Tell me about yourself.',
        'headline: Checkout engineer.',
        'example: At Acme I led the migration.',
        'scribe verbatim: I um',
        'voice dropped',
        'arousal 0.4 dominance 0.5 valence 0.6',
        '"endMs": 19000',
        'Never invent a number that is not in the metrics',
        'Aim for fewer fillers, not zero',
        'count only non-lexical filler uses',
        'one chapter per interviewer question turn',
      ]) assert.ok(prompt.includes(needle), `review prompt carries ${needle}`);
      assert.ok(prompt.includes('Why this team in particular?'), 'every turn is in the timed transcript');
      const { analysis, feedback } = result;
      assert.equal(analysis.callId, 'call-3_A');
      assert.equal(analysis.status, 'ready');
      assert.equal(analysis.createdAt, '2026-11-08T10:05:00.000Z');
      assert.equal(analysis.metrics, metrics, 'the deterministic metrics are kept as computed');
      assert.deepEqual(analysis.toneTimeline, callRecord.toneSamples);
      assert.deepEqual(analysis.chapters.map(chapter => [chapter.title, chapter.startMs, chapter.endMs, chapter.questionTurnIndex]), [
        ['Opening', 0, 7500, null], ['Background', 7500, 20500, 2], ['Motivation', 20500, 33000, 4], ['Closing', 33000, 40000, null],
      ]);
      assert.deepEqual(analysis.chapters.map(chapter => chapter.markers.map(marker => `${marker.kind}:${marker.atMs}`)), [
        [],
        ['moment:12000', 'tone:15000', 'pause:16000'],
        ['filler:23000', 'interruption:24000', 'chat:31000'],
        [],
      ]);
      const markers = analysis.chapters.flatMap(chapter => chapter.markers);
      assert.ok(markers.some(marker => marker.kind === 'pause' && marker.atMs === 16000), 'long pause marker');
      assert.ok(markers.some(marker => marker.kind === 'interruption' && marker.atMs === 24000), 'interruption marker');
      assert.ok(markers.some(marker => marker.kind === 'interruption' && marker.label === 'Talked over the interviewer'), 'interruption label follows beforeQuestionFinished');
      assert.ok(markers.some(marker => marker.kind === 'tone' && marker.label === 'voice dropped'), 'tone note marker');
      assert.ok(markers.some(marker => marker.kind === 'moment' && marker.atMs === 12000), 'flagged moment marker');
      assert.ok(markers.some(marker => marker.kind === 'filler' && marker.atMs === 23000), 'filler moment marker');
      assert.ok(markers.some(marker => marker.kind === 'chat' && marker.atMs === 31000), 'typed chat marker');
      assert.deepEqual(analysis.fillers, { total: 4, perMinute: 6, byAnswer: [0, 0, 1, 0] });
      assert.equal(feedback.callId, 'call-3_A');
      assert.equal(feedback.delivery.fillerCount, 4);
      assert.equal(feedback.overall.score, 7);
      const written = await readAnalysis(dir);
      assert.deepEqual(written, analysis, 'analysis.json holds exactly the returned analysis');
      const stat = await fs.promises.stat(path.join(dir, 'analysis.json'));
      assert.equal(stat.mode & 0o777, 0o600, 'analysis.json is private');
      const leftovers = (await fs.promises.readdir(dir)).filter(name => name.endsWith('.tmp'));
      assert.deepEqual(leftovers, [], 'no temp file is left behind');
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  } },
  { name: 'practice call analysis: Scribe failure still reviews, and the prompt says the words are missing', async run() {
    const dir = await tempDir();
    try {
      let prompt = '';
      const result = await analyzeCall({ callDir: dir, callRecord, plan, brief, deps: {
        transcribe: () => { throw new Error('scribe down'); },
        metrics: () => metrics,
        callText: request => { prompt = request.prompt; return { ...review, feedback: { ...reviewFeedback, delivery: { summary: 'Steady pace.', pace: 'steady', fillerCount: 0 } } }; },
      } });
      assert.match(prompt, /The verbatim Scribe pass failed \(scribe down\)/u);
      assert.doesNotMatch(prompt, /scribe verbatim:/u, 'no word-level transcript is claimed');
      assert.equal(result.analysis.status, 'ready');
      assert.deepEqual(result.analysis.metrics, metrics);
      assert.equal(result.analysis.fillers.total, 0);
      assert.equal(result.analysis.fillers.perMinute, 0);
      assert.deepEqual(result.analysis.fillers.byAnswer, [0, 0, 1, 0], 'filler moments still split per answer');
      assert.equal((await readAnalysis(dir)).status, 'ready');
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  } },
  { name: 'practice call analysis: a review with a bad anchor is retried once with the error, then fails with the metrics kept', async run() {
    const dir = await tempDir();
    try {
      const prompts = [];
      const result = await analyzeCall({ callDir: dir, callRecord, plan, brief, deps: {
        transcribe: () => ({ words }),
        metrics: () => metrics,
        callText: request => { prompts.push(request.prompt); return { ...review, chapters: [{ questionTurnIndex: 99, title: 'Nowhere' }] }; },
      } });
      assert.equal(prompts.length, 2, 'exactly one correction retry');
      assert.doesNotMatch(prompts[0], /CORRECTION REQUIRED/u);
      assert.match(prompts[1], /CORRECTION REQUIRED/u);
      assert.match(prompts[1], /99 is not a transcript turn index/u, 'the validation error is handed back');
      assert.equal(result.feedback, null);
      assert.equal(result.analysis.status, 'failed');
      assert.equal(result.analysis.metrics, metrics, 'deterministic metrics survive a failed review');
      assert.deepEqual(result.analysis.chapters, []);
      assert.deepEqual(result.analysis.fillers, { total: 0, perMinute: 0, byAnswer: [] });
      assert.match(result.analysis.error, /chapters: 99 is not a transcript turn index/u);
      assert.deepEqual(await readAnalysis(dir), result.analysis, 'the failed analysis is written too');
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  } },
  { name: 'practice call analysis: a review call that keeps throwing is a failed analysis, not a thrown exception', async run() {
    const dir = await tempDir();
    try {
      let calls = 0;
      const result = await analyzeCall({ callDir: dir, callRecord, plan, brief, deps: {
        transcribe: () => { throw new Error('no audio'); }, metrics: () => metrics, callText: () => { calls += 1; throw new Error('model offline'); },
      } });
      assert.equal(calls, 2);
      assert.equal(result.analysis.status, 'failed');
      assert.match(result.analysis.error, /model offline/u);
      assert.equal(result.analysis.metrics, metrics);
      assert.equal((await readAnalysis(dir)).status, 'failed');
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  } },
  { name: 'practice call analysis: chapters are pure and ignore anchors that are not interviewer turns', async run() {
    const snapshot = structuredClone(transcript);
    const input = { transcript, reviewChapters: [{ questionTurnIndex: 1, title: 'Not a question' }, { questionTurnIndex: 4, title: 'Motivation' }, { questionTurnIndex: 4, title: 'Duplicate' }, { questionTurnIndex: 2, title: 'Background' }, { questionTurnIndex: 77, title: 'Missing' }], moments: [], metrics: {}, toneNotes: [], durationMs: 40000 };
    const chapters = buildChapters(input);
    assert.deepEqual(chapters.map(chapter => [chapter.title, chapter.startMs, chapter.endMs, chapter.questionTurnIndex]), [
      ['Opening', 0, 7500, null], ['Background', 7500, 20500, 2], ['Motivation', 20500, 33000, 4], ['Closing', 33000, 40000, null],
    ]);
    for (let index = 1; index < chapters.length; index += 1) assert.equal(chapters[index].startMs, chapters[index - 1].endMs, 'chapters tile the timeline');
    assert.deepEqual(input.reviewChapters.length, 5, 'the review input is not consumed');
    assert.deepEqual(transcript, snapshot, 'the transcript is not mutated');
    const bare = buildChapters({ transcript: [snapshot[0], snapshot[1]], durationMs: 7000 });
    assert.deepEqual(bare.map(chapter => [chapter.title, chapter.startMs, chapter.endMs]), [['Call', 0, 7000]], 'a call with no question still gets a chapter');
    assert.deepEqual(buildChapters({ transcript, reviewChapters: [], moments: [], metrics: {}, toneNotes: [], durationMs: 40000 }).map(chapter => [chapter.title, chapter.startMs, chapter.endMs]), [['Opening', 0, 33000], ['Closing', 33000, 40000]], 'an untagged farewell is still the closing chapter');
  } },
  { name: 'practice call analysis: the review schema and anchors are checked, and the prompt carries no numbers of its own', async run() {
    assert.deepEqual(REVIEW_SCHEMA.required, ['feedback', 'chapters', 'moments']);
    assert.equal(REVIEW_SCHEMA.additionalProperties, false);
    assert.deepEqual(REVIEW_SCHEMA.properties.feedback.required, ['overall', 'planned', 'priorities'], 'session is not demanded of the reviewer');
    assert.equal(REVIEW_SCHEMA.properties.chapters.items.properties.questionTurnIndex.type, 'integer');
    assert.deepEqual(REVIEW_SCHEMA.properties.moments.items.properties.kind.enum, ['moment', 'filler']);
    assert.ok(REVIEW_SCHEMA.properties.feedback.properties.delivery, 'the review writes the delivery section');
    assert.match(checkReview({ ...review, feedback: { ...reviewFeedback, delivery: { summary: 's', fillerCount: -2 } } }, transcript).error, /delivery\.fillerCount/u);
    assert.match(checkReview({ ...review, chapters: [{ questionTurnIndex: 1, title: 'Candidate turn' }] }, transcript).error, /not an interviewer turn/u);
    assert.match(checkReview({ ...review, moments: [{ turnIndex: 2, label: 'x', kind: 'rant' }] }, transcript).error, /kind must be one of/u);
    assert.match(checkReview(null, transcript).error, /not a JSON object/u);
    assert.deepEqual(checkReview(review, transcript).review.chapters, [{ questionTurnIndex: 4, title: 'Motivation' }, { questionTurnIndex: 2, title: 'Background' }]);
    const prompt = buildReviewPrompt({ callRecord: { ...callRecord, toneSamples: [], toneNotes: [] }, plan: { cards: [] }, metrics: {}, wordsByTurn: { 3: [{ text: 'um' }] } });
    assert.match(prompt, /\(no prepared answers were part of this call\)/u);
    assert.match(prompt, /\(no tone notes were taken during the call\)/u);
    assert.match(prompt, /\(no tone samples\)/u);
    assert.match(prompt, /scribe verbatim: um/u, 'words reach the prompt per answer');
    assert.deepEqual(wordsByAnswer(transcript, words), { 3: [words[0], words[1]], 5: [words[2]] });
    assert.deepEqual(fillerTotals({ feedback: {}, moments: [{ kind: 'filler', turnIndex: 5 }, { kind: 'moment', turnIndex: 3 }], transcript, durationMs: 60000 }), { total: 1, perMinute: 1, byAnswer: [0, 0, 1, 0] });
  } },
  {
    name: "practice call analysis: prosody pauses, interruption labels, clamped markers and chat timing",
    async run() {
      const chapters = buildChapters({
        transcript: [
          { speaker: "interviewer", text: "Tell me about yourself.", startMs: 0, endMs: 5000 },
          { speaker: "candidate", text: "I build things.", startMs: 6000, endMs: 9000 },
          { speaker: "interviewer", text: "Why us?", startMs: 20000, endMs: 22000 },
          { speaker: "candidate", text: "Voice is fun.", startMs: 24000, endMs: 28000 },
          { speaker: "candidate", text: "Typed later.", startMs: 31000, endMs: 32000, channel: "chat" },
          { speaker: "candidate", text: "Untimed chat.", channel: "chat" },
        ],
        durationMs: 40000,
        candidateProsodyByTurn: {
          1: { pauses: [{ startMs: 9500, endMs: 11500 }, { startMs: 12000, endMs: 14000 }] },
          3: { pauses: [{ startMs: 50000, endMs: 52000 }] },
        },
        metrics: {
          answers: [{ turnIndex: 1, pauses: [{ startMs: 17000, endMs: 19000 }] }],
          interruptions: [
            { atMs: 20000, beforeQuestionFinished: true },
            { atMs: 24000, beforeQuestionFinished: false },
          ],
        },
        reviewChapters: [],
      });
      const flat = chapters.flatMap(chapter => chapter.markers);
      const pauseTimes = flat.filter(marker => marker.kind === "pause").map(marker => marker.atMs);
      assert.deepEqual(pauseTimes, [9500, 12000, 40000], "candidate-prosody pauses over 2 s, clamped to durationMs");
      assert.ok(!flat.some(marker => marker.kind === "pause" && marker.atMs === 17000), "metrics pauses are not a source");
      assert.deepEqual(flat.filter(marker => marker.kind === "interruption").map(marker => marker.label), ["Cut in before the question finished", "Talked over the interviewer"]);
      assert.deepEqual(flat.filter(marker => marker.kind === "chat").map(marker => marker.atMs), [31000], "timed chat only, untimed skipped");
      assert.ok(chapters.at(-1).markers.some(marker => marker.atMs === 40000), "clamped marker belongs to the closing chapter");
    },
  },
  {
    name: 'practice call analysis: the review prompt carries the candidate-requested interview focus only when one was set',
    async run() {
      const focus = 'Final round before an offer: ask my salary expectations.';
      const plain = buildReviewPrompt({ callRecord, plan: { cards: [] }, metrics: {}, wordsByTurn: {} });
      assert.equal(plain.includes('interview focus requested by the candidate'), false, 'no focus line without steering');
      assert.equal(plain.includes('judge the call against that requested focus'), false);
      for (const empty of ['', '   ']) {
        assert.equal(buildReviewPrompt({ callRecord: { ...callRecord, steering: empty }, plan: { cards: [] }, metrics: {}, wordsByTurn: {} }), plain, 'blank steering changes nothing');
      }
      assert.equal(buildReviewPrompt({ callRecord: { ...callRecord, steering: '   ' }, plan: { cards: [] }, metrics: {}, wordsByTurn: {} }), plain);
      const steered = buildReviewPrompt({ callRecord: { ...callRecord, steering: `  ${focus}  ` }, plan: { cards: [] }, metrics: {}, wordsByTurn: {} });
      const focusLine = `interview focus requested by the candidate: ${focus}`;
      assert.equal(steered.split(focusLine).length, 2, 'the trimmed focus line appears exactly once');
      assert.equal(steered.includes('judge the call against that requested focus'), true, 'the reviewer is told to judge against the focus');
      assert.equal(steered.indexOf(focusLine) > steered.indexOf('interviewer persona: Warm hiring manager'), true, 'the focus line sits next to the persona line');
      assert.equal(steered.split('\n').length, plain.split('\n').length + 2, 'only the focus line and its instruction are added');
    },
  },

];
