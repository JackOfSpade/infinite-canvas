import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  GATE_MIN_EDITED_BUNDLES,
  GATE_RECURRENCE_MIN,
  editDiffs,
  editSummaries,
  editedPairsSinceSession,
  improvementStatus,
  logGeneratedBundle,
  logSavedBundle,
  readGenerationGate,
  resetImprovementCounter,
} from '../../electron/ipc/applicationEditLog.js';
import {
  APPLICATION_EDIT_RECURRENCE_SCHEMA,
  APPLICATION_EDIT_RECURRENCE_TASK,
  buildEditRecurrencePrompt,
  evaluateApplicationGenerationGate,
  interpretEditRecurrence,
  registerApplicationGenerationGateHandlers,
} from '../../electron/ipc/applicationGenerationGate.js';
import { validateResponseSchema } from '../../electron/ipc/schemaValidation.js';

const html = (resume, letter) => `<!doctype html><html><body>
<section data-ic-document-panel="resume"><main class="page">${resume}</main></section>
<section data-ic-document-panel="cover"><main class="page">${letter}</main></section>
<button data-ic-document-tab="cover">Cover letter</button>
<script id="ic-application-bundle-data" type="application/json">{"sync":{"documents":{"resume":{},"cover":{}}}}</script>
</body></html>`;

const WORDS = ['quarry', 'lagoon', 'thimble', 'saffron', 'kestrel', 'meadow'];
const resumeFor = (word, suffix = '') => `<h2>Summary</h2><p>${word} opening line about steady craft${suffix}</p><h2>Other</h2><p>${word} unchanged closing line</p>`;
const letterFor = word => `<p>${word} letter paragraph stays put</p>`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function withRoot(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'application-gate-'));
  try { await run(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

async function addBundle(root, index, { edited = true, notes } = {}) {
  const word = WORDS[index];
  const workspaceDir = path.join(root, `bundle-${index}`);
  await logGeneratedBundle({ root, workspaceDir, html: html(resumeFor(word), letterFor(word)), posting: `Synthetic posting ${index}`, appVersion: 'test' });
  await pause(3);
  if (edited) {
    await logSavedBundle({ root, workspaceDir, html: html(resumeFor(word, ' trimmed shorter'), letterFor(word)), editNotes: notes ?? `shortened the ${word} opener` });
  }
  await pause(3);
  return workspaceDir;
}

function fakeCallText(responses) {
  const calls = [];
  const callText = async (prompt, options) => {
    calls.push({ prompt, options });
    await pause(5);
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, callText };
}

const stored = async root => JSON.parse(await fs.readFile(path.join(root, 'application-improvement', 'state.json'), 'utf8'));
const ALL_THREE = { version: 1, patterns: [{ summary: 'Shortens the summary opener in every bundle.', kind: 'length', bundles: [1, 2, 3] }] };

export default [{
  name: 'generation gate: editDiffs carries block text for content edits and stays in lockstep with editSummaries',
  run: async () => {
    const page = body => `<main class="page">${body}</main>`;
    const generated = page(`<h2>Experience</h2><ul><li>alpha one</li><li>beta two</li><li>gamma three</li></ul>
<h2>Projects</h2><article class="project"><span>Kite</span></article><article class="project"><span>Lantern</span></article>
<h2>Skills</h2><dl class="skills"><dt>Skills</dt><dd>Rust · Go · Elm</dd></dl>`);
    const saved = page(`<h2>Experience</h2><ul><li>gamma three</li><li>alpha one revised here</li><li>delta four</li></ul>
<h2>Projects</h2><article class="project"><span>Kite</span></article>
<h2>Skills</h2><dl class="skills"><dt>Skills</dt><dd>Rust · Go</dd></dl>`);
    const diffs = editDiffs({ resume: generated }, { resume: saved });
    const key = row => [row.document, row.section, row.kind, row.op, row.before, row.after].join('|');
    assert.deepEqual(diffs.map(key).sort(), [
      'resume|Experience|li|added||delta four',
      'resume|Experience|li|removed|beta two|',
      'resume|Experience|li|rewritten|alpha one|alpha one revised here',
      'resume|Projects|article.project|removed|Lantern|',
      'resume|Skills|dd|rewritten|Rust · Go · Elm|Rust · Go',
    ].sort());
    assert(!diffs.some(row => row.before === 'gamma three' || row.after === 'gamma three'), 'a moved-only block is not a diff');
    // editSummaries output is unchanged by the shared pairing.
    const rows = editSummaries({ resume: generated }, { resume: saved }, 'x', 'now');
    const skills = rows.filter(row => row.op === 'rewritten' && row.section === 'Skills');
    assert.deepEqual([skills.length, skills[0].kind, skills[0].wordsRemoved, skills[0].wordsAdded], [1, 'dd', 2, 0]);
    assert.deepEqual(rows.filter(row => row.section === 'Experience').map(row => row.op).sort(), ['added', 'removed', 'rewritten']);
    assert.equal(rows.find(row => row.section === 'Experience' && row.op === 'rewritten').moved, true);
    assert.equal(rows.filter(row => row.op === 'removed' && row.section === 'Projects').length, 1);
    assert(!JSON.stringify(rows).match(/Lantern|Elm|alpha/), 'summaries still carry no document text');
    assert.deepEqual(editDiffs({ resume: generated, letter: page('<p>x</p>') }, { resume: generated, letter: page('<p>x</p>') }), []);
    const long = 'w'.repeat(900);
    const capped = editDiffs({ resume: page(`<p>${long}</p>`) }, { resume: page('<p>short</p>') });
    assert(capped.length >= 1 && capped.every(row => row.before.length <= 500 && row.after.length <= 500), 'diff text is capped at 500 chars');
  },
}, {
  name: 'generation gate: skipped below three edited bundles, one handoff at three, blocks on a 3-bundle pattern, then caches',
  run: async () => withRoot(async root => {
    assert.equal(GATE_MIN_EDITED_BUNDLES, 3); assert.equal(GATE_RECURRENCE_MIN, 3);
    const { calls, callText } = fakeCallText([ALL_THREE]);
    await addBundle(root, 0);
    await addBundle(root, 1);
    await addBundle(root, 5, { edited: false });
    let result = await evaluateApplicationGenerationGate({ root, callText });
    assert.deepEqual([result.blocked, result.checked, result.reason, result.editedBundleCount, calls.length],
      [false, false, 'fewer-than-three-edited-bundles', 2, 0]);
    await addBundle(root, 2, { notes: 'the opener was too long' });
    result = await evaluateApplicationGenerationGate({ root, callText, now: () => '2030-01-01T00:00:00.000Z' });
    assert.equal(calls.length, 1, 'exactly one handoff');
    assert.equal(calls[0].options.task, APPLICATION_EDIT_RECURRENCE_TASK);
    assert.equal(calls[0].options.responseSchema, APPLICATION_EDIT_RECURRENCE_SCHEMA);
    assert.deepEqual(calls[0].options.hints, { itemCount: 3 });
    const prompt = calls[0].prompt;
    for (const [index, word] of [[0, 'quarry'], [1, 'lagoon'], [2, 'thimble']]) {
      assert(prompt.includes(`BEFORE: ${word} opening line about steady craft\n`), `bundle ${index} before text`);
      assert(prompt.includes(`AFTER: ${word} opening line about steady craft trimmed shorter\n`), `bundle ${index} after text`);
    }
    assert(prompt.includes("User's stated reasons: shortened the quarry opener"));
    assert(prompt.includes("User's stated reasons: the opener was too long"));
    assert(prompt.indexOf('Bundle 1\n') < prompt.indexOf('quarry opening') && prompt.indexOf('Bundle 3\n') < prompt.indexOf('thimble opening'), 'bundles numbered oldest first');
    assert(!prompt.includes('meadow'), 'an unedited bundle is not sent');
    assert.deepEqual([result.blocked, result.checked, result.reason, result.editedBundleCount], [true, true, 'checked', 3]);
    assert.deepEqual(result.patterns, [{ summary: 'Shortens the summary opener in every bundle.', kind: 'length', count: 3 }]);
    const ids = editedPairsSinceSession(await stored(root)).map(({ pair }) => pair.id);
    const gate = await readGenerationGate(root);
    assert.deepEqual(gate.patterns[0].bundles, ids, 'record stores pair ids');
    assert.equal(gate.checkedAt, '2030-01-01T00:00:00.000Z');
    assert.equal((await improvementStatus(root)).generationGate.blocked, true);
    assert.deepEqual((await improvementStatus(root)).generationGate.patterns, [{ summary: 'Shortens the summary opener in every bundle.', count: 3 }]);
    const gateJson = JSON.stringify((await stored(root)).generationGate);
    assert(!WORDS.some(word => gateJson.includes(word)), 'the stored gate carries no document text');
    const summariesJson = JSON.stringify((await stored(root)).summaries);
    assert(!WORDS.some(word => summariesJson.includes(word)), 'summaries carry no document text');

    result = await evaluateApplicationGenerationGate({ root, callText });
    assert.deepEqual([calls.length, result.reason, result.blocked], [1, 'cached', true], 'unchanged history costs no handoff');
  }),
}, {
  name: 'generation gate: a new edit re-checks, 2-bundle patterns do not block, bad bundle numbers are ignored, reset clears',
  run: async () => withRoot(async root => {
    const twoOnly = { version: 1, patterns: [
      { summary: 'Trims the opener.', kind: 'length', bundles: [1, 2, 2, 9, 0] },
      { summary: 'Only one real bundle.', kind: 'wording', bundles: [3, 3, 99] },
    ] };
    const { calls, callText } = fakeCallText([ALL_THREE, twoOnly]);
    for (const index of [0, 1, 2]) await addBundle(root, index);
    assert.equal((await evaluateApplicationGenerationGate({ root, callText })).blocked, true);
    await logSavedBundle({ root, workspaceDir: path.join(root, 'bundle-1'), html: html(resumeFor('lagoon', ' trimmed again'), letterFor('lagoon')) });
    const result = await evaluateApplicationGenerationGate({ root, callText });
    assert.equal(calls.length, 2, 'a new edit changes the digest');
    assert.deepEqual([result.blocked, result.reason], [false, 'checked']);
    assert.deepEqual(result.patterns, [{ summary: 'Trims the opener.', kind: 'length', count: 2 }]);
    assert.equal((await improvementStatus(root)).generationGate.blocked, false);

    await pause(3);
    await resetImprovementCounter(root);
    const after = await evaluateApplicationGenerationGate({ root, callText });
    assert.deepEqual([after.blocked, after.checked, calls.length], [false, false, 2]);
    assert.equal((await improvementStatus(root)).generationGate, null, 'reset clears the stored gate');
  }),
}, {
  name: 'generation gate: interpretEditRecurrence maps numbers to ids and the schema accepts the empty answer',
  run: async () => {
    const pairs = ['a', 'b', 'c', 'd'].map(id => ({ pair: { id }, diffs: [] }));
    const out = interpretEditRecurrence({ version: 1, patterns: [
      { summary: `  ${'s'.repeat(250)}  `, kind: 'truth', bundles: [4, 1, 4, 3] },
      { summary: 'x', kind: 'other', bundles: [5, 6] },
    ] }, pairs);
    assert.deepEqual(out, { blocked: true, patterns: [{ summary: 's'.repeat(200), kind: 'truth', bundles: ['d', 'a', 'c'] }] });
    assert.equal(interpretEditRecurrence({ version: 1, patterns: [{ summary: 'y', kind: 'truth', bundles: [1, 2] }] }, pairs).blocked, false);
    assert.equal(interpretEditRecurrence({ version: 1, patterns: [{ summary: 'y', kind: 'truth', bundles: [1, 2] }] }, pairs, { min: 2 }).blocked, true);
    assert.deepEqual(validateResponseSchema({ version: 1, patterns: [] }, APPLICATION_EDIT_RECURRENCE_SCHEMA), [], 'the empty answer is schema-valid');
    assert(validateResponseSchema({ version: 1, patterns: [{ summary: 'y', kind: 'truth', bundles: [1] }] }, APPLICATION_EDIT_RECURRENCE_SCHEMA).length > 0,
      'a one-bundle pattern is schema-invalid');
    const prompt = buildEditRecurrencePrompt([{ pair: { id: 'a' }, diffs: [{ document: 'letter', section: '', kind: 'p', op: 'removed', before: 'old words', after: '' }] }]);
    assert(prompt.includes("User's stated reasons: none given"));
    assert(prompt.includes('- letter / (no section) / p / removed\n  BEFORE: old words\n  AFTER: (none)'));
    assert(prompt.includes('{ "version": 1, "patterns": [] }'));
  },
}, {
  name: 'generation gate: concurrent evaluations share one handoff and a failed handoff propagates without touching the record',
  run: async () => withRoot(async root => {
    const { calls, callText } = fakeCallText([ALL_THREE, new Error('handoff cancelled')]);
    for (const index of [0, 1, 2]) await addBundle(root, index);
    const [first, second] = await Promise.all([
      evaluateApplicationGenerationGate({ root, callText }),
      evaluateApplicationGenerationGate({ root, callText }),
    ]);
    assert.equal(calls.length, 1, 'one in-flight handoff per digest');
    assert.deepEqual([first.blocked, second.blocked], [true, true]);
    const before = await readGenerationGate(root);
    await addBundle(root, 3);
    await assert.rejects(evaluateApplicationGenerationGate({ root, callText }), /handoff cancelled/);
    assert.equal(calls.length, 2);
    assert.deepEqual(await readGenerationGate(root), before, 'a failed check leaves the stored gate unchanged');
  }),
}, {
  name: 'generation gate: IPC channel, task registries, preload, main, and the card call site are wired',
  run: async () => {
    const registered = [];
    registerApplicationGenerationGateHandlers({
      registerHandler: (channel, handler) => registered.push({ channel, handler }),
      callText: async () => { throw new Error('not called'); },
      appInstance: { getPath: () => os.tmpdir() },
    });
    assert.deepEqual(registered.map(row => row.channel), ['check-application-generation-gate']);
    const read = file => fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    const count = (text, needle) => text.split(needle).length - 1;
    for (const file of ['electron/ipc/llm.js', 'electron/ipc/nonApiAi.js', 'electron/ipc/handoffBridge/controller.js',
      'electron/ipc/handoffBridge/engine.js', 'electron/ipc/handoffBridge/telemetry.js']) {
      const text = await read(file);
      const gap = count(text, "'job-gap-review'");
      assert(gap > 0, `${file} still lists job-gap-review`);
      assert.equal(count(text, "'application-edit-recurrence'"), gap, `${file} lists the gate task beside job-gap-review`);
    }
    const preload = await read('electron/preload.js');
    assert(preload.includes("checkApplicationGenerationGate: (args) => ipcRenderer.invoke('check-application-generation-gate', args)"));
    const main = await read('electron/main.js');
    assert(/\n\s+registerApplicationGenerationGateHandlers\(\);/.test(main), 'main registers the gate handlers');
    const ipcUtils = await read('electron/ipc/ipcUtils.js');
    const quitList = ipcUtils.slice(ipcUtils.indexOf('const QUIT_PAUSE_WORK_CHANNELS = new Set(['), ipcUtils.indexOf(']);', ipcUtils.indexOf('const QUIT_PAUSE_WORK_CHANNELS')));
    assert(quitList.includes("'check-application-generation-gate'"), 'the gate is a quit-pause work channel');

    const card = await read('src/nodes/JobCardNode.jsx');
    const start = card.indexOf('const generateApplication = useCallback(');
    const body = card.slice(start, card.indexOf('\n\n  return (', start));
    const canvasCheck = body.indexOf('if (!canvasFilePath) {');
    const gateCall = body.indexOf('await window.electronAPI.checkApplicationGenerationGate(');
    const blocked = body.indexOf('if (gate.blocked) {');
    const queueCall = body.indexOf('window.electronAPI.queueLocalApplication(');
    assert(canvasCheck > 0 && gateCall > canvasCheck && blocked > gateCall && queueCall > blocked, 'gate runs after the canvas check and before the queue call');
    const blockedBranch = body.slice(blocked, body.indexOf('\n      }\n', blocked));
    assert(/\n\s+return;$/.test(blockedBranch.trimEnd()) || blockedBranch.includes('return;'), 'a blocked gate returns');
    assert(body.slice(blocked, queueCall).includes('return;\n      }'), 'the blocked branch returns before the queue call');
    assert(body.includes('        careerSnapshotId,\n'), 'queue payload anchor intact');
    assert(card.includes("import { generateId } from '../utils/idGenerator';"));
  },
}];
