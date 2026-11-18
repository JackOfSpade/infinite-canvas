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
  toneSamples: [{ atMs: 5000, arousal: 0.4, dominance: 0.5, valence: 0.6 }, { atMs: 25000, arousal: 0.5, dominance: 0.6, valence: 0.4 }],
  candidateProsody: [{ startMs: 12000, endMs: 20000, speechMs: 6000, wordsPerMinute: 130, pauses: [{ startMs: 16000, endMs: 19000 }] }], voiceBaseline: { wordsPerMinute: 120 },
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
      assert.deepEqual(calls.metrics[0], { transcript, candidateProsody: callRecord.candidateProsody, baselineSnapshot: callRecord.voiceBaseline });
      assert.equal(calls.review.length, 1, 'exactly one review call');
      assert.deepEqual(calls.review[0].profile, { model: 'opus', effort: 'medium' });
      assert.equal(calls.review[0].schema, REVIEW_SCHEMA);
      const prompt = calls.review[0].prompt;
      for (const needle of [
        '[2] interviewer 00:07-00:09: Tell me about yourself.',
        'headline: Checkout engineer.',
        'example: At Acme I led the migration.',
        'scribe verbatim: I um',
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
        ['moment:12000', 'pause:16000'],
        ['filler:23000', 'interruption:24000', 'chat:31000'],
        [],
      ]);
      const markers = analysis.chapters.flatMap(chapter => chapter.markers);
      assert.ok(markers.some(marker => marker.kind === 'pause' && marker.atMs === 16000), 'long pause marker');
      assert.ok(markers.some(marker => marker.kind === 'interruption' && marker.atMs === 24000), 'interruption marker');
      assert.ok(markers.some(marker => marker.kind === 'interruption' && marker.label === 'Talked over the interviewer'), 'interruption label follows beforeQuestionFinished');
      assert.ok(markers.every(marker => marker.kind !== 'tone'), 'no tone markers: nothing records live tone notes');
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
    const input = { transcript, reviewChapters: [{ questionTurnIndex: 1, title: 'Not a question' }, { questionTurnIndex: 4, title: 'Motivation' }, { questionTurnIndex: 4, title: 'Duplicate' }, { questionTurnIndex: 2, title: 'Background' }, { questionTurnIndex: 77, title: 'Missing' }], moments: [], metrics: {}, durationMs: 40000 };
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
    const prompt = buildReviewPrompt({ callRecord: { ...callRecord, toneSamples: [] }, plan: { cards: [] }, metrics: {}, wordsByTurn: { 3: [{ text: 'um' }] } });
    assert.match(prompt, /\(no prepared answers were part of this call\)/u);
    assert.doesNotMatch(prompt, /TONE NOTES|tone notes/u, 'the always-empty live tone notes section is gone');
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
    name: 'practice call analysis: the review prompt says when the candidate ended the call early and never when the interviewer ended it',
    async run() {
      const build = reason => buildReviewPrompt({ callRecord: { ...callRecord, reason }, plan: { cards: [] }, metrics: {}, wordsByTurn: {} });
      for (const reason of ['candidate', 'window-closed']) {
        const early = build(reason);
        assert.equal(early.includes('the candidate ended the call early'), true, `${reason} is an early end`);
        assert.equal(early.includes('review only the part of the call that took place'), true);
      }
      const finished = build('interviewer');
      assert.equal(finished.includes('ended the call early'), false, 'an interviewer wrap-up is not an early end');
      assert.equal(finished.includes('the interviewer wrapped up and ended the call'), true);
      assert.equal(build(undefined).includes('how the call ended'), false, 'an unknown ending says nothing');
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

  {
    name: 'practice call analysis: a call answered only by typing skips Scribe and tells the reviewer delivery was not measurable',
    async run() {
      const dir = await tempDir();
      try {
        const typed = [
          { speaker: 'interviewer', text: 'Tell me about yourself.', startMs: 1000, endMs: 3000 },
          { speaker: 'candidate', text: 'I build checkout systems.', startMs: 9000, endMs: 9000, channel: 'chat' },
          { speaker: 'interviewer', text: 'Thanks.', startMs: 12000, endMs: 13000 },
        ];
        let scribed = 0;
        let prompt = '';
        const result = await analyzeCall({ callDir: dir, callRecord: { ...callRecord, transcript: typed, toneSamples: [], candidateProsody: [], startedAt: Date.UTC(2026, 10, 8, 10), persona: { name: 'Dana Lee', role: 'Engineering manager', team: 'Voice', temperament: 'warm' } }, plan, brief, deps: {
          transcribe: () => { scribed += 1; throw new Error('empty recording'); },
          metrics: request => ({ typedOnly: request.transcript.length === 3 }),
          callText: request => { prompt = request.prompt; return { ...review, chapters: [{ questionTurnIndex: 0, title: 'Intro' }], moments: [] }; },
        } });
        assert.equal(scribed, 0, 'no transcription of a silent recording');
        assert.equal(result.analysis.status, 'ready');
        assert.doesNotMatch(prompt, /Scribe pass failed/u, 'typing is not a transcription failure');
        assert.match(prompt, /answered only by typing/u);
        assert.match(prompt, /Delivery could not be measured because the call was typed/u);
        assert.match(prompt, /Never make a claim about pace, pauses, fillers, confidence or tone for a typed turn/u);
        assert.doesNotMatch(prompt, /CANDIDATE PROSODY BY TURN/u);
        assert.doesNotMatch(prompt, /TONE TIMELINE/u);
        assert.match(prompt, /interviewer persona: Dana Lee, Engineering manager, Voice \(warm\)/u);
        assert.match(prompt, /started: 2026-11-08T10:00:00\.000Z/u);
        assert.doesNotMatch(prompt, /persona: \(unknown\)/u);
        assert.doesNotMatch(prompt, /started: \(unknown\)/u);
      } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'practice call analysis: a technical ending is not reviewed as a complete call or blamed on the candidate',
    async run() {
      const build = reason => buildReviewPrompt({ callRecord: { ...callRecord, reason }, plan: { cards: [] }, metrics: {}, wordsByTurn: {} });
      for (const reason of ['helper-error', 'audio-error', 'session-error']) {
        const text = build(reason);
        assert.match(text, new RegExp(`a technical failure cut the call short \\(${reason}\\)`, 'u'));
        assert.match(text, /must not be faulted/u);
        assert.match(text, /review only the part of the call that took place/u);
        assert.equal(text.includes('the candidate ended the call early'), false);
      }
    },
  },
  {
    name: 'practice call analysis: chapters use the recording timeline, which starts before the call clock',
    async run() {
      const dir = await tempDir();
      try {
        const result = await analyzeCall({ callDir: dir, callRecord: { ...callRecord, durationMs: 30000, recordingLeadMs: 10000 }, plan, brief, deps: {
          transcribe: () => ({ words }), metrics: () => metrics, callText: () => review,
        } });
        assert.equal(result.analysis.chapters.at(-1).title, 'Closing');
        assert.equal(result.analysis.chapters.at(-1).endMs, 40000, 'call length plus the lead before the answer');
      } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'practice call analysis: screens and the coding pad reach the review prompt only when present, and are capped',
    async run() {
      const build = record => buildReviewPrompt({ callRecord: record, plan: { cards: [] }, metrics: {}, wordsByTurn: {} });
      const plain = build(callRecord);
      assert.equal(build({ ...callRecord, screens: [], pad: { lang: 'python', snapshots: [] } }), plain, 'empty screens and pad change nothing');
      assert.equal(build({ ...callRecord, screens: undefined, pad: null }), plain);
      assert.equal(plain.includes('SHARED SCREENS'), false);
      const record = {
        ...callRecord,
        screens: [{ atMs: 8000, title: 'Sum pairs', content: 'Given a list, return pairs.\n\n```\nf([1,2])\n```', speakerId: 'A', endMs: 25000 }],
        pad: { lang: 'python', snapshots: [{ atMs: 15000, text: 'def f(x):\n  pass' }, { atMs: 30000, text: 'def f(x):\n  return sorted(x)' }] },
      };
      const text = build(record);
      assert.match(text, /--- SHARED SCREENS/u);
      assert.match(text, /screen 1: "Sum pairs" shown at 00:08 \(during or after transcript turn \[2\]\), until 00:25/u);
      assert.match(text, /Given a list, return pairs\./u);
      assert.match(text, /--- CANDIDATE CODING PAD \(final text, language: python\) ---/u);
      assert.equal(text.includes('return sorted(x)'), true, 'the last snapshot is the final text');
      assert.equal(text.includes('  pass'), false, 'earlier snapshots are not shown');
      assert.match(text, /Never claim anything about code that is not in the pad/u);
      const big = build({ ...record, screens: [{ atMs: 0, title: 'Big', content: 'x'.repeat(7000) }], pad: { snapshots: [{ atMs: 1, text: 'y'.repeat(13000) }] } });
      assert.equal(big.includes('x'.repeat(6001)), false);
      assert.equal(big.includes('x'.repeat(6000)), true);
      assert.equal(big.includes('y'.repeat(12001)), false);
      assert.equal(big.includes('y'.repeat(12000)), true);
      assert.match(big, /cut: the first 6000 characters of 7000/u);
      assert.match(big, /cut: the first 12000 characters of 13000/u);
    },
  },
  {
    name: 'practice call analysis: a panel record names every interviewer, who spoke each turn, and adds the panel rule',
    async run() {
      const build = record => buildReviewPrompt({ callRecord: record, plan: { cards: [] }, metrics: {}, wordsByTurn: {} });
      const solo = build(callRecord);
      assert.equal(build({ ...callRecord, panel: [] }), solo, 'an empty panel is byte-for-byte the solo prompt');
      assert.equal(solo.includes('- Panel:'), false);
      const persona = { name: 'Dana', role: 'Engineering manager', temperament: 'warm' };
      const record = {
        ...callRecord, persona,
        panel: [
          { id: 'B', name: 'John', role: 'Senior engineer', focus: 'system design', joins: 'late', joinedAtMs: 95000, voiceId: 'v-b' },
          { id: 'C', name: 'Priya', role: 'Recruiter', focus: '', joins: 'late', joinedAtMs: null, voiceId: 'v-c' },
        ],
        transcript: [
          { speaker: 'interviewer', speakerId: 'A', text: 'Welcome.', startMs: 0, endMs: 3000 },
          { speaker: 'candidate', text: 'Thanks.', startMs: 3500, endMs: 4000 },
          { speaker: 'interviewer', speakerId: 'A', text: 'Over to John. John, go ahead.', startMs: 4500, endMs: 9000,
            segments: [{ speakerId: 'A', text: 'Over to John.' }, { speakerId: 'B', text: 'John, go ahead.' }] },
          { speaker: 'interviewer', text: 'No speaker recorded.', startMs: 9500, endMs: 10000 },
        ],
      };
      const text = build(record);
      assert.match(text, /interviewers on this call \(a panel\): Dana, Engineering manager; John, Senior engineer \(focus: system design; joined late at 01:35\); Priya, Recruiter \(joined late, but never joined the call\)/u);
      assert.match(text, /\[0\] Dana 00:00-00:03: Welcome\./u);
      assert.match(text, /\[1\] candidate 00:03-00:04: Thanks\./u);
      assert.match(text, /\[2\] Dana 00:04-00:09:\n {4}Dana: Over to John\.\n {4}John: John, go ahead\./u);
      assert.equal(text.includes('Over to John. John, go ahead.'), false, 'the joined text is replaced by the segments');
      assert.match(text, /\[3\] interviewer 00:09-00:10: No speaker recorded\./u, 'a turn with no speaker keeps the bare word');
      assert.equal(text.split('- Panel:').length, 2, 'the panel rule is added once');
      assert.match(text, /only when the transcript shows it/u);
      // A record that repeats the lead inside the panel is read the same way.
      const withLead = build({ ...record, panel: [{ id: 'A', name: 'Dana', role: 'Engineering manager', joins: 'start' }, ...record.panel] });
      assert.match(withLead, /Dana, Engineering manager; John/u);
      assert.equal(withLead.includes('Engineering manager; Dana'), false, 'the lead is listed once in the panel line');
    },
  },
  {
    name: 'practice call analysis: an overlay entry is labelled as an overlapping remark and a call without one prompts as before',
    async run() {
      const plain = buildReviewPrompt({ callRecord, plan, brief, metrics });
      assert.doesNotMatch(plain, /overlapping remark/u);
      const withOver = [...transcript.slice(0, 1), { speaker: 'interviewer', speakerId: 'B', text: 'Hi there.', startMs: 1000, endMs: 1700, overlay: true }, ...transcript.slice(1)];
      const prompt = buildReviewPrompt({ callRecord: { ...callRecord, transcript: withOver }, plan, brief, metrics });
      assert.match(prompt, /\[1\] interviewer \(overlapping remark, said over the speaker\) 00:01-00:01: Hi there\./u);
      assert.equal(buildReviewPrompt({ callRecord: { ...callRecord, transcript }, plan, brief, metrics }), plain, 'no overlay, identical prompt');
    },
  },
  {
    name: 'practice call analysis: the unprepared question is named with its own judging rule, and an absent field leaves the prompt unchanged',
    async run() {
      const plain = buildReviewPrompt({ callRecord, plan, brief, metrics });
      assert.doesNotMatch(plain, /not one the candidate had prepared/u);
      const asked = 'Tell me about a time a launch went wrong.';
      const named = buildReviewPrompt({ callRecord: { ...callRecord, unpreparedQuestion: { text: asked, askedBy: 'A' } }, plan, brief, metrics });
      assert.ok(named.includes(asked));
      assert.match(named, /There is no prepared answer for it/u);
      assert.match(named, /adaptability: structure, relevance and composure/u);
      assert.match(named, /Never fault it for departing from prepared material/u);
      const viaPlan = buildReviewPrompt({ callRecord: { ...callRecord, setup: { plan: { questions: [{ number: 1 }, { number: 0, text: asked }] } } }, plan, brief, metrics });
      assert.ok(viaPlan.includes(asked));
    },
  },
];
