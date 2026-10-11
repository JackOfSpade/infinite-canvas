// Crash/relaunch recovery of the career-file compiler.
//
// The scenario these pin down: a long compile (dozens of accepted handoffs) is
// interrupted, the app is relaunched, and the person presses Continue.  Three
// things went wrong together:
//   1. the renderer-denied `career-input-staging` namespace made the host's OWN
//      staged copy of a plain-text file look sensitive, so a `.md` file stopped
//      being read verbatim and was demoted to AI attachment inventory;
//   2. the staged pathname is random per staging and was hashed into the durable
//      step key, so no attachment-bearing step could ever replay;
//   3. the banner called every one of these an "exact saved checkpoint" resume.
// Nothing here names a person, employer, or file: the invariants are about
// content-bound identity and honest recovery.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  assert, fs, getKnownTaskIds, handleSafe, ipcMain, registerNonApiAiHandlers,
  requestNonApiAi, __reloadDurableStateForTests, durableRunSettlementSummary,
} from '../test-dependencies.js';
import {
  __assertCareerInputDescriptorsStillMatchForTests, __assertOwnedStagedCareerAttachmentForTests,
  __bindCareerCompileRunForTests, __careerCompileResumeStatusForTests, __extractCareerFileSectionsForTests,
  __hostStagedDocumentCallerForTests, __readOwnedStagedCareerAttachmentForTests, __stageCareerInputFilesForTests,
} from '../../electron/ipc/jobs.js';
import { careerSnapshotId, careerSnapshotInputFingerprint } from '../../electron/ipc/careerSnapshot.js';
import { readPlainTextDocument } from '../../electron/ipc/docUtils.js';
import { isCareerCompilerTask } from '../../src/utils/careerCompilerTasks.js';
import { careerCompileResumeExplanation, careerResumeBannerStatus, careerResumeInputPaths } from '../../src/utils/jobCareerCompilationReceipt.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';

const STAGING_COMPONENT = 'career-input-staging';
const SCHEMA = {
  type: 'object', required: ['answer'], additionalProperties: false,
  properties: { answer: { type: 'string' } },
};
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function scratchDirectory(label) {
  // Under the repo, like the other staging tests: the system temp root is a
  // sensitive location the host staging API (rightly) refuses to write into.
  return fs.mkdtempSync(path.join(process.cwd(), `.career-recovery-${label}-`));
}

function writeSource(directory, name, text) {
  const filePath = `${directory}/${name}`;
  fs.writeFileSync(filePath, text);
  return filePath;
}

function makeSender(id, sent) {
  const sender = new EventEmitter();
  sender.id = id;
  sender.isDestroyed = () => false;
  sender.send = (channel, payload) => sent.push({ channel, payload });
  return sender;
}

async function waitForRequests(sent, count, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requests = sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
    if (requests.length >= count) return requests;
    await sleep(5);
  }
  return sent.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
}

// One "relaunch-able" attachment workflow: stage the person's file exactly as
// parse-career-data does (fresh random directory under a real
// `career-input-staging` namespace), then ask for one attachment-bearing
// handoff through the same host-staged caller production uses.
function registerAttachmentWorkflow(channel, { sourcePath, stagingRoot, record }) {
  handleSafe(channel, async (_event, _args, signal) => {
    const staged = await __stageCareerInputFilesForTests([sourcePath], { stagingRoot });
    try {
      record.stagedPath = staged.stagedPaths[0];
      const caller = __hostStagedDocumentCallerForTests(staged);
      return { value: await caller(staged.stagedPaths[0], 'ATTACHMENT INVENTORY PROMPT', {
        signal, task: 'career-file-inventory', responseSchema: SCHEMA,
      }) };
    } finally {
      await staged.cleanup();
    }
  });
  return ipcMain.__getInvokeHandler(channel);
}

async function snapshotIdFor(sourcePath, stagingRoot) {
  const staged = await __stageCareerInputFilesForTests([sourcePath], { stagingRoot });
  try {
    return careerSnapshotId(careerSnapshotInputFingerprint(staged.descriptors));
  } finally {
    await staged.cleanup();
  }
}

// Runs the attachment workflow once for `sourcePath` under `runId`.  Answers
// the handoff when one is asked; resolves `{ asked: false }` when the durable
// store replays an earlier accepted answer without asking.
let attachmentChannelCounter = 0;
async function acceptOneAttachmentAnswer(label, { sourcePath, stagingRoot, runId, senderId, answer }) {
  attachmentChannelCounter += 1;
  const invoke = registerAttachmentWorkflow(`${label}-${attachmentChannelCounter}`, { sourcePath, stagingRoot, record: {} });
  const sent = [];
  const sender = makeSender(senderId, sent);
  const run = invoke({ sender }, { nodeId: 'career-node', manualAiRunId: runId });
  const outcome = await Promise.race([run, waitForRequests(sent, 1, 1_500).then(requests => ({ request: requests[0] }))]);
  if (outcome && 'value' in outcome) return { asked: false, value: outcome.value.answer };
  const request = outcome?.request;
  if (!request) return { asked: false, value: (await run).value.answer };
  await ipcMain.__getInvokeHandler('submit-non-api-ai-response')({ sender }, { requestId: request.requestId, response: `{"handoffCode":"${request.handoffCode}","answer":"${answer}"}` });
  return { asked: true, value: (await run).value.answer };
}

// Three unrelated synthetic career records: the invariants are about file
// identity and content, never about what a particular profile says.
const SYNTHETIC_DOMAINS = [
  { label: 'clinical', name: 'Clinical Record.md', text: '# Ward log\n\nCharge nurse on a surgical unit; coordinated discharge planning for a rotating team.\n' },
  { label: 'culinary', name: 'Kitchen History.txt', text: 'Sous chef for a tasting-menu line. Rebuilt the prep checklist and supplier rota.\n' },
  { label: 'freight', name: 'Dispatch Summary.pdf', text: '%PDF-1.4 synthetic dispatch record: routed regional deliveries and audited carrier invoices.\n' },
];

export default [
  {
    name: 'career recovery: a plain-text file staged in the real private store is still read verbatim, never demoted to an AI attachment',
    run: async () => {
      const directory = scratchDirectory('verbatim');
      const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
      let staged;
      try {
        const text = '# Free-form notes\n\nHeld a role from 2019 to 2022. Wrote the intake checklist.\r\nNo template here.\n';
        const source = writeSource(directory, 'Notes.md', text);
        staged = await __stageCareerInputFilesForTests([source], { stagingRoot });
        let documentCalls = 0;
        const extracted = await __extractCareerFileSectionsForTests(staged.stagedPaths, {
          sourceNames: staged.sourceNames,
          readStagedAttachment: (filePath, options) => __readOwnedStagedCareerAttachmentForTests(staged, filePath, options),
          callDocument: async () => { documentCalls += 1; throw new Error('a plain-text file must not request an AI attachment handoff'); },
        });
        assert(documentCalls === 0 && extracted.directTextFiles === 1 && extracted.transcribedFiles === 0,
          'the staged plain-text copy takes the verbatim route');
        assert(extracted.sourceFiles[0].text === text,
          'the compiler sees the exact bytes the person wrote, line endings and all');
        // The renderer-facing policy for this namespace is deliberately intact:
        // only the host's descriptor-pinned staged reader may classify it.
        assert(await readPlainTextDocument(staged.stagedPaths[0]) === null,
          'a generic caller (no host staged reader) is still refused the private namespace');
      } finally {
        await staged?.cleanup();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: host-mode plain-text classification keeps system/credential denial and the extension and size gates',
    run: async () => {
      const readsSecret = async () => 'harmless text';
      assert(await readPlainTextDocument('/Users/someone/.ssh/notes.md', { includeAppPrivate: false, readUtf8: readsSecret }) === null,
        'a credential path stays refused even for a host caller');
      assert(await readPlainTextDocument('/tmp/fixture/scan.pdf', { includeAppPrivate: false, readUtf8: readsSecret }) === null,
        'only plain-text extensions are ever read verbatim');
      assert(await readPlainTextDocument('/tmp/fixture/ok.txt', { includeAppPrivate: false, readUtf8: async () => 'x'.repeat(4 * 1024 * 1024 + 1) }) === null,
        'an oversized read is deferred to the attachment path');
      assert(await readPlainTextDocument('/tmp/fixture/ok.txt', { includeAppPrivate: false, readUtf8: async () => { throw new Error('not an owned staged file'); } }) === null,
        'a reader that refuses (not an owned staged inode) degrades to deferral, never a throw');
      assert(await readPlainTextDocument('/tmp/fixture/ok.txt', { includeAppPrivate: false, readUtf8: async () => 'plain words\n' }) === 'plain words',
        'a clean host-read text file is accepted');
    },
  },
  {
    name: 'career recovery: crash/relaunch replays an accepted attachment step even though the new staging has a different random path',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const directory = scratchDirectory('replay');
      const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
      const runId = `career-replay-${process.pid}-${Date.now()}`;
      try {
        const source = writeSource(directory, 'Career File.pdf', '%PDF-1.4 fixture bytes that are not parsed here\n');
        const first = {};
        const invoke = registerAttachmentWorkflow('career-recovery-replay', { sourcePath: source, stagingRoot, record: first });
        const sentA = [];
        const senderA = makeSender(9101, sentA);
        const runA = invoke({ sender: senderA }, { nodeId: 'career-node', manualAiRunId: runId });
        const [requestA] = await waitForRequests(sentA, 1);
        assert(requestA?.attachments?.length === 1 && requestA.attachments[0] === first.stagedPath,
          'the first handoff shows the attachment staged for it');
        assert(requestA.mcpEligible === false,
          'an attachment-bearing handoff is never offered to a bridge chat, live or retired');
        const submit = ipcMain.__getInvokeHandler('submit-non-api-ai-response');
        await submit({ sender: senderA }, { requestId: requestA.requestId, response: `{"handoffCode":"${requestA.handoffCode}","answer":"accepted once"}` });
        assert((await runA).value.answer === 'accepted once', 'the first launch completes the step');
        assert(!fs.existsSync(first.stagedPath), 'staging is removed after the run, as in production');

        // Relaunch: the process-local registry is gone, the durable file remains.
        await ipcMain.__getInvokeHandler('flush-non-api-ai-persistence')({ sender: senderA });
        await __reloadDurableStateForTests();
        ipcMain.__clearInvokeHandlers();
        registerNonApiAiHandlers();
        const second = {};
        const invokeAgain = registerAttachmentWorkflow('career-recovery-replay-2', { sourcePath: source, stagingRoot, record: second });
        const sentB = [];
        const senderB = makeSender(9102, sentB);
        const relaunched = invokeAgain({ sender: senderB }, { nodeId: 'career-node', manualAiRunId: runId });
        const outcome = await Promise.race([relaunched, sleep(1_500).then(() => 'asked-again')]);
        if (outcome === 'asked-again') {
          const [again] = sentB.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
          if (again) await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender: senderB }, { requestId: again.requestId });
          await relaunched;
          assert(false, 'the accepted step was asked again after relaunch: its key still depends on the random staging path');
        }
        const resumed = outcome;
        assert(second.stagedPath && second.stagedPath !== first.stagedPath,
          'the relaunch staged the same file under a different random path');
        assert(sentB.filter(item => item.channel === 'non-api-ai-request').length === 0,
          'the accepted step replays silently: the person is not asked again');
        assert(resumed.value.answer === 'accepted once', 'the replayed value is the originally accepted answer');
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: senderB }, { runId });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: a changed file never replays an answer given for different bytes',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const directory = scratchDirectory('changed');
      const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
      const runId = `career-changed-${process.pid}-${Date.now()}`;
      try {
        const source = writeSource(directory, 'Career File.pdf', 'original bytes\n');
        const first = {};
        const invoke = registerAttachmentWorkflow('career-recovery-changed', { sourcePath: source, stagingRoot, record: first });
        const sentA = [];
        const senderA = makeSender(9111, sentA);
        const runA = invoke({ sender: senderA }, { nodeId: 'career-node', manualAiRunId: runId });
        const [requestA] = await waitForRequests(sentA, 1);
        await ipcMain.__getInvokeHandler('submit-non-api-ai-response')({ sender: senderA }, { requestId: requestA.requestId, response: `{"handoffCode":"${requestA.handoffCode}","answer":"for original bytes"}` });
        await runA;

        await ipcMain.__getInvokeHandler('flush-non-api-ai-persistence')({ sender: senderA });
        await __reloadDurableStateForTests();
        ipcMain.__clearInvokeHandlers();
        registerNonApiAiHandlers();
        fs.writeFileSync(source, 'edited bytes\n');
        const second = {};
        const invokeAgain = registerAttachmentWorkflow('career-recovery-changed-2', { sourcePath: source, stagingRoot, record: second });
        const sentB = [];
        const senderB = makeSender(9112, sentB);
        const runB = invokeAgain({ sender: senderB }, { nodeId: 'career-node', manualAiRunId: runId });
        const [requestB] = await waitForRequests(sentB, 1);
        assert(requestB, 'edited bytes are a new question and must be asked again');
        assert(fs.existsSync(requestB.attachments[0]) && requestB.attachments[0] === second.stagedPath,
          'the re-asked prompt names an attachment that exists right now');
        await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender: senderB }, { requestId: requestB.requestId });
        await runB;
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: senderB }, { runId });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: a pending attachment handoff is re-presented after relaunch with a freshly staged, existing attachment and its draft',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const directory = scratchDirectory('pending');
      const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
      const runId = `career-pending-${process.pid}-${Date.now()}`;
      try {
        const source = writeSource(directory, 'Career File.pdf', 'pending bytes\n');
        const first = {};
        const invoke = registerAttachmentWorkflow('career-recovery-pending', { sourcePath: source, stagingRoot, record: first });
        const sentA = [];
        const senderA = makeSender(9121, sentA);
        const runA = invoke({ sender: senderA }, { nodeId: 'career-node', manualAiRunId: runId });
        const [requestA] = await waitForRequests(sentA, 1);
        await ipcMain.__getInvokeHandler('update-non-api-ai-draft')({ sender: senderA }, { requestId: requestA.requestId, response: '{"answer":"half typed"}' });
        await ipcMain.__getInvokeHandler('flush-non-api-ai-persistence')({ sender: senderA });
        senderA.emit('did-start-navigation', {}, 'file:///relaunch.html', false, true);
        await runA;
        assert(!fs.existsSync(first.stagedPath), 'the interrupted run cleaned its private copy up');

        await __reloadDurableStateForTests();
        ipcMain.__clearInvokeHandlers();
        registerNonApiAiHandlers();
        const second = {};
        const invokeAgain = registerAttachmentWorkflow('career-recovery-pending-2', { sourcePath: source, stagingRoot, record: second });
        const sentB = [];
        const senderB = makeSender(9122, sentB);
        const runB = invokeAgain({ sender: senderB }, { nodeId: 'career-node', manualAiRunId: runId });
        const [requestB] = await waitForRequests(sentB, 1);
        assert(requestB, 'the unfinished step is shown again');
        assert(requestB.attachments.length === 1 && fs.existsSync(requestB.attachments[0]),
          'the resumed prompt references an attachment that exists at the moment it is shown');
        assert(requestB.attachments[0] === second.stagedPath && requestB.attachments[0] !== first.stagedPath,
          'it is the new staging, never the vanished one');
        assert(requestB.initialResponse === '{"answer":"half typed"}' && requestB.handoffCode === requestA.handoffCode,
          'the same logical step keeps its draft and its handoff code');
        await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender: senderB }, { requestId: requestB.requestId });
        await runB;
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: senderB }, { runId });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: a host-staged handoff is refused before it can be shown or replayed once its attachment is gone',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const directory = scratchDirectory('missing');
      try {
        const present = writeSource(directory, 'present.pdf', 'bytes\n');
        const sent = [];
        const sender = makeSender(9131, sent);
        handleSafe('career-recovery-missing-at-admission', async (_event, _args, signal) => requestNonApiAi({
          prompt: 'NEEDS A FILE', task: 'career-file-inventory', responseSchema: SCHEMA, signal,
          attachmentPaths: [`${directory}/never-existed.pdf`], attachmentIdentities: ['career-input:0001:deadbeef'], hostStagedAttachments: true,
        }));
        const refused = await ipcMain.__getInvokeHandler('career-recovery-missing-at-admission')({ sender }, { nodeId: 'n', manualAiRunId: `career-missing-${process.pid}` });
        assert(refused.success === false && /no longer on disk/.test(refused.error || ''),
          'admission refuses a host-staged handoff whose file does not exist');
        assert(sent.filter(item => item.channel === 'non-api-ai-request').length === 0, 'nothing was shown');

        // The file vanishes AFTER admission (external cleanup): the dock-remount
        // replay must refuse rather than re-show a prompt that names a ghost.
        handleSafe('career-recovery-missing-at-replay', async (_event, _args, signal) => requestNonApiAi({
          prompt: 'NEEDS A FILE TOO', task: 'career-file-inventory', responseSchema: SCHEMA, signal,
          attachmentPaths: [present], attachmentIdentities: ['career-input:0001:cafe'], hostStagedAttachments: true,
        }));
        const pending = ipcMain.__getInvokeHandler('career-recovery-missing-at-replay')({ sender }, { nodeId: 'n2', manualAiRunId: `career-missing-2-${process.pid}` });
        const [shown] = await waitForRequests(sent, 1);
        assert(shown?.attachments?.[0] === present, 'while the file exists the prompt is shown');
        fs.rmSync(present);
        sent.length = 0;
        const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')({ sender });
        const settled = await pending;
        assert(replay.count === 0 && sent.filter(item => item.channel === 'non-api-ai-request').length === 0,
          'the replay shows nothing for a vanished attachment');
        assert(settled.success === false && /no longer on disk/.test(settled.error || ''),
          'the workflow fails with an actionable message instead of waiting on a ghost');
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId: `career-missing-2-${process.pid}` });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: without a host identity an attachment is still keyed by its path (user documents keep their old behaviour)',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const directory = scratchDirectory('legacy');
      try {
        const a = writeSource(directory, 'a.pdf', 'same\n');
        const b = writeSource(directory, 'b.pdf', 'same\n');
        const sent = [];
        const sender = makeSender(9141, sent);
        const keys = [];
        for (const attachment of [a, b]) {
          handleSafe(`career-recovery-legacy-${keys.length}`, async (_event, _args, signal) => requestNonApiAi({
            prompt: 'SAME PROMPT', task: 'career-file-inventory', responseSchema: SCHEMA, signal, attachmentPaths: [attachment],
          }));
          const run = ipcMain.__getInvokeHandler(`career-recovery-legacy-${keys.length}`)({ sender }, { nodeId: 'legacy-node', manualAiRunId: `career-legacy-${process.pid}-${keys.length}` });
          const requests = await waitForRequests(sent, keys.length + 1);
          keys.push(requests[keys.length].stepKey);
          await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: requests[keys.length - 1].requestId });
          await run;
        }
        // Different runs hash different workflow ids' steps independently, so
        // compare within one run: same prompt, two paths, two keys.
        const runId = `career-legacy-shared-${process.pid}`;
        const sharedKeys = [];
        for (const [index, attachment] of [a, b].entries()) {
          handleSafe(`career-recovery-legacy-shared-${index}`, async (_event, _args, signal) => requestNonApiAi({
            prompt: 'SAME PROMPT', task: 'career-file-inventory', responseSchema: SCHEMA, signal, attachmentPaths: [attachment],
          }));
          const run = ipcMain.__getInvokeHandler(`career-recovery-legacy-shared-${index}`)({ sender }, { nodeId: 'legacy-node', manualAiRunId: runId });
          const requests = await waitForRequests(sent, keys.length + index + 1);
          const latest = requests[requests.length - 1];
          sharedKeys.push(latest.stepKey);
          await ipcMain.__getInvokeHandler('cancel-non-api-ai-request')({ sender }, { requestId: latest.requestId });
          await run;
        }
        assert(sharedKeys[0] !== sharedKeys[1], 'two different user-supplied paths with the same prompt remain distinct steps');
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: stale pending steps from an earlier round are never delivered, replayed, or treated as the current task',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const runId = `career-stale-${process.pid}-${Date.now()}`;
      const makeWorkflow = (channel, prompts) => handleSafe(channel, async (_event, _args, signal) => {
        const answers = [];
        for (const prompt of prompts) {
          answers.push((await requestNonApiAi({ prompt, task: 'test-manual-stale-pending', responseSchema: SCHEMA, signal })).answer);
        }
        return { answers };
      });

      makeWorkflow('career-recovery-stale-1', ['AUDIT OF AN EARLIER PROFILE']);
      const sentA = [];
      const senderA = makeSender(9151, sentA);
      const firstRun = ipcMain.__getInvokeHandler('career-recovery-stale-1')({ sender: senderA }, { nodeId: 'career-node', manualAiRunId: runId });
      await waitForRequests(sentA, 1);
      await ipcMain.__getInvokeHandler('flush-non-api-ai-persistence')({ sender: senderA });
      senderA.emit('did-start-navigation', {}, 'file:///relaunch.html', false, true);
      await firstRun;

      await __reloadDurableStateForTests();
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      // After the repair round the audit asks about a DIFFERENT profile, so the
      // earlier pending question is orphaned (its prompt will never recur).
      makeWorkflow('career-recovery-stale-2', ['AUDIT OF THE REPAIRED PROFILE']);
      const sentB = [];
      const senderB = makeSender(9152, sentB);
      const secondRun = ipcMain.__getInvokeHandler('career-recovery-stale-2')({ sender: senderB }, { nodeId: 'career-node', manualAiRunId: runId });
      const requests = await waitForRequests(sentB, 1);
      await sleep(30);
      const shown = sentB.filter(item => item.channel === 'non-api-ai-request').map(item => item.payload);
      assert(shown.length === 1 && shown[0].prompt.includes('AUDIT OF THE REPAIRED PROFILE') && !shown[0].prompt.includes('EARLIER PROFILE'),
        'only the currently requested question is ever delivered');
      const replay = await ipcMain.__getInvokeHandler('replay-pending-non-api-ai-requests')({ sender: senderB });
      assert(replay.count === 1, 'a dock remount replays the one live request, not the orphaned durable one');
      const summary = await durableRunSettlementSummary(runId);
      assert(summary.pending === 2 && summary.acceptedOnly === false,
        'the durable store honestly still holds the orphan; no code path may promote it to "current"');
      await ipcMain.__getInvokeHandler('submit-non-api-ai-response')({ sender: senderB }, { requestId: requests[0].requestId, response: `{"handoffCode":"${requests[0].handoffCode}","answer":"ok"}` });
      assert((await secondRun).answers[0] === 'ok', 'the live request alone drives the workflow');
      await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender: senderB }, { runId });
      assert((await durableRunSettlementSummary(runId)).found === false,
        'completing the run retires the orphaned pending step with everything else');
    },
  },
  {
    name: 'career recovery: Continue states exactly what it will do — exact, restart, unverified, or already compiled — from file content and compiler contract',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const directory = scratchDirectory('status');
      const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
      const runId = `career-status-${process.pid}-${Date.now()}`;
      const sender = makeSender(9161, []);
      try {
        const source = writeSource(directory, 'Career File.pdf', 'status bytes\n');
        assert((await __careerCompileResumeStatusForTests([source], runId, { stagingRoot })).mode === 'restart'
          && (await __careerCompileResumeStatusForTests([source], runId, { stagingRoot })).reason === 'run-missing',
        'no durable run means compilation starts over, and says so');

        // Production binds before the first handoff; then one answer is accepted.
        await __bindCareerCompileRunForTests(runId, await snapshotIdFor(source, stagingRoot));
        await acceptOneAttachmentAnswer('career-recovery-status', { sourcePath: source, stagingRoot, runId, senderId: 9162, answer: 'one' });

        // A run whose answers predate any binding can never be attributed.
        const legacyRunId = `${runId}-legacy`;
        await acceptOneAttachmentAnswer('career-recovery-status-legacy', { sourcePath: source, stagingRoot, runId: legacyRunId, senderId: 9163, answer: 'legacy' });
        const legacy = await __careerCompileResumeStatusForTests([source], legacyRunId, { stagingRoot });
        assert(legacy.mode === 'unverified' && legacy.acceptedSteps === 1,
          'a run recorded before binding existed is never described as an exact resume');
        await __bindCareerCompileRunForTests(legacyRunId, await snapshotIdFor(source, stagingRoot));
        assert((await __careerCompileResumeStatusForTests([source], legacyRunId, { stagingRoot })).mode === 'unverified',
          'binding such a run later cannot retroactively prove which input its earlier answers belong to');
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId: legacyRunId });

        const exact = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
        assert(exact.mode === 'exact' && exact.acceptedSteps === 1, 'same files + same compiler contract = exact');

        fs.writeFileSync(source, 'status bytes, edited\n');
        const restart = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
        assert(restart.mode === 'restart' && restart.reason === 'input-or-compiler-changed',
          'an edited source can no longer resume exactly and says it will restart');
        fs.writeFileSync(source, 'status bytes\n');
        assert((await __careerCompileResumeStatusForTests([source], runId, { stagingRoot })).mode === 'exact',
          'restoring the exact bytes restores the exact verdict (content, not mtime)');
        assert(!fs.readdirSync(stagingRoot).length, 'inspection leaves no staged copy behind');
        await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: an already-approved snapshot for the current files is reported as ready, so Continue asks nothing more',
    run: async () => {
      const directory = scratchDirectory('ready');
      try {
        const fixture = await writeApprovedCareerSnapshotFixture();
        const source = writeSource(directory, 'Work Experience.md', fixture.careerData);
        const status = await __careerCompileResumeStatusForTests([source], `career-ready-${process.pid}`, { stagingRoot: `${directory}/${STAGING_COMPONENT}` });
        assert(status.mode === 'snapshot-ready', `expected snapshot-ready, got ${JSON.stringify(status)}`);
        const edited = writeSource(directory, 'Other.md', `${fixture.careerData}An added sentence.\n`);
        const notReady = await __careerCompileResumeStatusForTests([edited], `career-ready-${process.pid}`, { stagingRoot: `${directory}/${STAGING_COMPONENT}` });
        assert(notReady.mode !== 'snapshot-ready', 'a different file never borrows another file\'s approved snapshot');
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career recovery: only a proven exact verdict is ever worded as an exact resume; every other state says what it will do',
    run: () => {
      const exact = careerCompileResumeExplanation({ state: 'exact', acceptedSteps: 43 });
      assert(exact.exact === true && /43 answers/.test(exact.body) && /in order/.test(exact.body), 'exact names what replays');
      for (const status of [
        { state: 'restart', reason: 'input-or-compiler-changed' }, { state: 'restart', reason: 'run-missing' },
        { state: 'unverified' }, { state: 'checking' }, { state: 'unavailable' }, { state: 'snapshot-ready' }, undefined,
      ]) {
        const result = careerCompileResumeExplanation(status);
        assert(result.exact === false, `${JSON.stringify(status)} must not be presented as exact`);
        assert(!/exact saved checkpoint|resumes its exact/i.test(result.body), `${JSON.stringify(status)} never uses the generic exact-resume sentence`);
      }
      assert(/restart/i.test(careerCompileResumeExplanation({ state: 'restart', reason: 'input-or-compiler-changed' }).body)
        && /restart/i.test(careerCompileResumeExplanation({ state: 'restart', reason: 'run-missing' }).body),
      'a restart is called a restart');
      assert(/cannot be verified/.test(careerCompileResumeExplanation({ state: 'unverified' }).body)
        && /does not claim to resume at an exact step/.test(careerCompileResumeExplanation({ state: 'unverified' }).body),
      'an unverifiable checkpoint says so');
      assert(careerCompileResumeExplanation({ state: 'exact', acceptedSteps: 1 }, { paused: true }).body.startsWith('You paused'),
        'a user-paused compilation keeps that context');
      const paths = careerResumeInputPaths({ filePaths: ['/a', '/b'], careerFilePaths: ['/b', '/c'], filePath: '/a' });
      assert(JSON.stringify(paths) === JSON.stringify(['/a', '/b', '/c']), 'retained input paths are de-duplicated in first-seen order');
    },
  },
  {
    name: 'career recovery: every career-* compiler stage the main process knows is recognised by the renderer, and job stages are not',
    run: () => {
      const known = [...getKnownTaskIds()];
      const careerTasks = known.filter(task => task.startsWith('career-') || task === 'resume-parse');
      assert(careerTasks.includes('career-file-inventory') && careerTasks.includes('career-file-inventory-audit')
        && careerTasks.includes('career-file-boundary-audit'),
      'the stages that were silently missing from the old renderer lists exist');
      for (const task of careerTasks) assert(isCareerCompilerTask(task), `${task} must be recognised as career compiler work`);
      for (const task of known.filter(task => !task.startsWith('career-') && task !== 'resume-parse')) {
        assert(!isCareerCompilerTask(task), `${task} is not career compiler work`);
      }
      assert(!isCareerCompilerTask(undefined) && !isCareerCompilerTask(null) && !isCareerCompilerTask('') && !isCareerCompilerTask({}),
        'malformed markers are not career work');
      const searchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const dialogSource = readFileSync(new URL('../../src/components/NonApiAiDialog.jsx', import.meta.url), 'utf8');
      assert(/function isCareerCompilationTask\(task\) \{\s*return isCareerCompilerTask\(task\);\s*\}/.test(searchSource)
        && dialogSource.includes('isCareerCompilerTask(request.task)'),
      'both renderer gates delegate to the one shared classifier instead of keeping a private list');
    },
  },
  {
    name: 'career recovery: the saved-checkpoint banner never shows the generic exact-resume sentence for career work and waits for the verdict',
    run: () => {
      const searchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const bannerStart = searchSource.indexOf('const manualAiRecoveryBanner = showManualAiRecoveryBanner');
      const banner = searchSource.slice(bannerStart, searchSource.indexOf('</button>', bannerStart));
      assert(bannerStart > 0 && banner.indexOf('careerResumeExplanation ?') >= 0
        && banner.indexOf('careerResumeExplanation ?') < banner.indexOf('Continue resumes its exact saved checkpoint'),
      'the career branch precedes, and so shadows, the generic exact-checkpoint sentence');
      assert(banner.includes('|| careerResumeStillChecking'), 'Continue is disabled while the verdict is still being computed');
      assert(searchSource.includes('window.electronAPI?.inspectCareerCompileResume')
        && readFileSync(new URL('../../electron/preload.js', import.meta.url), 'utf8').includes("'inspect-career-compile-resume'"),
      'the renderer reaches the verdict through the preload bridge');
      const resumeSource = searchSource.slice(searchSource.indexOf('const resumeManualAiRecovery = useCallback'));
      assert(resumeSource.indexOf('careerResumeInputPaths(liveData)') > 0
        && resumeSource.indexOf('careerResumeInputPaths(liveData)') < resumeSource.indexOf('peekJobRun'),
      'a career marker is routed to compilation before any job-run inspection, using the same paths the banner described');
    },
  },
  {
    name: 'career recovery: parse-career-data records its binding before the first handoff and cached snapshots never create a durable run',
    run: () => {
      const jobsSource = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const handler = jobsSource.slice(jobsSource.indexOf("handleSafe('parse-career-data'"));
      const miss = handler.indexOf("cacheTelemetry.outcome = 'miss'");
      const bind = handler.indexOf('await bindCareerCompileRun(');
      const firstHandoff = handler.indexOf('extractCareerFileSections(stagedPaths');
      const hit = handler.indexOf("cacheTelemetry.outcome = 'hit'");
      assert(miss > 0 && hit > 0 && hit < miss && miss < bind && bind < firstHandoff,
        'binding happens only on a cache miss, after the cache decision and before any handoff can be issued');
      assert(sha256('x') === sha256('x'), 'sanity');
    },
  },
  {
    name: 'career input: a file reached through a symlinked folder or a differently-cased name is staged and fenced by identity, never refused as changed',
    run: async () => {
      for (const domain of SYNTHETIC_DOMAINS) {
        const directory = scratchDirectory(`alias-${domain.label}`);
        const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
        try {
          const realFolder = path.join(directory, 'RealFolder');
          fs.mkdirSync(realFolder);
          const source = writeSource(realFolder, domain.name, domain.text);
          const aliases = [];
          const linkFolder = path.join(directory, 'LinkedFolder');
          try {
            fs.symlinkSync(realFolder, linkFolder, 'dir');
            aliases.push({ kind: 'symlinked-ancestor', filePath: path.join(linkFolder, domain.name) });
          } catch (error) {
            if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) throw error;
          }
          const caseVariant = path.join(directory, 'realfolder', domain.name.toLowerCase());
          const caseInsensitive = fs.existsSync(caseVariant) && fs.statSync(caseVariant).ino === fs.statSync(source).ino;
          if (caseInsensitive) aliases.push({ kind: 'case-variant', filePath: caseVariant });
          assert(aliases.length > 0 || process.platform === 'win32', `${domain.label}: this host can create at least one alias to exercise`);
          for (const alias of aliases) {
            const staged = await __stageCareerInputFilesForTests([alias.filePath], { stagingRoot });
            try {
              assert(staged.descriptors.length === 1
                && staged.descriptors[0].contentHash === sha256(domain.text)
                && staged.descriptors[0].name === path.basename(alias.filePath)
                && fs.readFileSync(staged.stagedPaths[0], 'utf8') === domain.text,
              `${domain.label}/${alias.kind}: the alias stages the very bytes of the canonical file`);
              await __assertCareerInputDescriptorsStillMatchForTests([alias.filePath], staged.descriptors);
            } finally {
              await staged.cleanup();
            }
          }
          // The alias is a binding, not a bypass: an edit seen through it still
          // fails the final live-path fence.
          fs.writeFileSync(source, `${domain.text}An added sentence.\n`);
          for (const alias of aliases) {
            let rejected = null;
            try {
              await __assertCareerInputDescriptorsStillMatchForTests([alias.filePath], [{ name: path.basename(alias.filePath), contentHash: sha256(domain.text) }]);
            } catch (error) { rejected = error; }
            assert(/changed while the profile was being compiled/.test(rejected?.message || ''),
              `${domain.label}/${alias.kind}: an edited file is still detected through its alias`);
          }
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  },
  {
    name: 'career input: an alias still refuses a sensitive target and a final symlink, and a folder retargeted mid-read is reported as changed',
    run: async () => {
      const directory = scratchDirectory('alias-guards');
      const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
      try {
        const [first, second] = SYNTHETIC_DOMAINS;
        const privateFolder = path.join(directory, '.ssh');
        fs.mkdirSync(privateFolder);
        writeSource(privateFolder, 'credentials.md', 'synthetic secret material\n');
        const folderA = path.join(directory, 'FolderA');
        const folderB = path.join(directory, 'FolderB');
        fs.mkdirSync(folderA); fs.mkdirSync(folderB);
        writeSource(folderA, 'Record.md', first.text);
        writeSource(folderB, 'Record.md', second.text);
        const sharedLink = path.join(directory, 'Shared');
        const swapLink = path.join(directory, 'Current');
        const fileLink = path.join(folderA, 'Shortcut.md');
        try {
          fs.symlinkSync(privateFolder, sharedLink, 'dir');
          fs.symlinkSync(folderA, swapLink, 'dir');
          fs.symlinkSync(path.join(folderA, 'Record.md'), fileLink);
        } catch (error) {
          if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return { skipped: 'symlinks unavailable' };
          throw error;
        }
        let sensitive = null;
        try { await __stageCareerInputFilesForTests([path.join(sharedLink, 'credentials.md')], { stagingRoot }); } catch (error) { sensitive = error; }
        assert(sensitive?.code === 'CAREER_INPUT_PRIVATE_PATH',
          `a symlinked folder that resolves into a private location is refused as sensitive, got ${sensitive?.code}`);
        let finalLink = null;
        try { await __stageCareerInputFilesForTests([fileLink], { stagingRoot }); } catch (error) { finalLink = error; }
        assert(finalLink?.code === 'CAREER_INPUT_PRIVATE_PATH', 'a final-component symlink is still never followed');
        let retargeted = null;
        try {
          await __stageCareerInputFilesForTests([path.join(swapLink, 'Record.md')], {
            stagingRoot,
            afterSourceInspection: () => {
              fs.unlinkSync(swapLink);
              fs.symlinkSync(folderB, swapLink, 'dir');
            },
          });
        } catch (error) { retargeted = error; }
        assert(retargeted?.code === 'CAREER_INPUT_CHANGED',
          `a folder alias retargeted between inspection and read is a real change and says so, got ${retargeted?.code}`);
        const left = fs.existsSync(stagingRoot) ? fs.readdirSync(stagingRoot) : [];
        assert(left.length === 0, 'no refused alias leaves a staged copy behind');
        return { sensitiveRefused: true, finalLinkRefused: true, retargetRefused: true };
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'career input: a metadata-only change to the private staged copy keeps ownership; changed bytes never do',
    run: async () => {
      for (const domain of SYNTHETIC_DOMAINS) {
        const directory = scratchDirectory(`staged-meta-${domain.label}`);
        const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
        let staged;
        try {
          const source = writeSource(directory, domain.name, domain.text);
          staged = await __stageCareerInputFilesForTests([source], { stagingRoot });
          const stagedPath = staged.stagedPaths[0];
          assert(await __assertOwnedStagedCareerAttachmentForTests(staged, stagedPath) === stagedPath, `${domain.label}: freshly staged copy is owned`);
          const before = fs.statSync(stagedPath);
          await sleep(20);
          // What opening the revealed copy does: metadata only, no byte changes.
          fs.chmodSync(stagedPath, 0o400);
          fs.chmodSync(stagedPath, 0o600);
          if (process.platform === 'darwin') {
            try { execFileSync('xattr', ['-w', 'com.apple.lastuseddate#PS', 'synthetic', stagedPath]); } catch { /* xattr tool optional */ }
          }
          const touched = fs.statSync(stagedPath);
          assert(touched.ctimeMs !== before.ctimeMs && touched.mtimeMs === before.mtimeMs && touched.size === before.size,
            `${domain.label}: the fixture really moved only ctime`);
          assert(await __assertOwnedStagedCareerAttachmentForTests(staged, stagedPath) === stagedPath,
            `${domain.label}: a metadata-only change keeps the staged copy owned`);
          assert(await __readOwnedStagedCareerAttachmentForTests(staged, stagedPath, 'utf8') === domain.text
            && Buffer.compare(await __readOwnedStagedCareerAttachmentForTests(staged, stagedPath), Buffer.from(domain.text)) === 0,
          `${domain.label}: the owned read still returns the staged bytes, as text or as a buffer`);
          assert(await __assertOwnedStagedCareerAttachmentForTests(staged, stagedPath) === stagedPath,
            `${domain.label}: ownership stays verifiable on every later check`);

          // Mutation: same length, mtime restored.  Only content can tell.
          const initial = fs.statSync(stagedPath);
          const flipped = Buffer.from(domain.text);
          flipped[flipped.length - 2] = flipped[flipped.length - 2] === 0x2e ? 0x21 : 0x2e;
          fs.writeFileSync(stagedPath, flipped);
          fs.utimesSync(stagedPath, initial.atimeMs / 1_000, initial.mtimeMs / 1_000);
          const restored = fs.statSync(stagedPath);
          assert(restored.size === initial.size && restored.mtimeMs === initial.mtimeMs,
            `${domain.label}: the mutation fixture preserved size and mtime`);
          let inspectRejected = null;
          try { await __assertOwnedStagedCareerAttachmentForTests(staged, stagedPath); } catch (error) { inspectRejected = error; }
          let readRejected = null;
          try { await __readOwnedStagedCareerAttachmentForTests(staged, stagedPath, 'utf8'); } catch (error) { readRejected = error; }
          for (const rejected of [inspectRejected, readRejected]) {
            assert(rejected?.code === 'HOST_STAGED_ATTACHMENT_INVALID' && /Press Continue to stage a fresh copy/.test(rejected.message),
              `${domain.label}: changed staged bytes are refused with an actionable message, got ${rejected?.code}: ${rejected?.message}`);
          }
        } finally {
          await staged?.cleanup();
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  },
  {
    name: 'career recovery: each input keeps its own answers — re-binding never counts another input\'s answers as exact, and returning to an earlier input is exact again',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      registerNonApiAiHandlers();
      const sender = makeSender(9170, []);
      for (const [index, domain] of SYNTHETIC_DOMAINS.entries()) {
        const directory = scratchDirectory(`binding-${domain.label}`);
        const stagingRoot = `${directory}/${STAGING_COMPONENT}`;
        const runId = `career-binding-${domain.label}-${process.pid}-${Date.now()}`;
        const textA = domain.text;
        const textB = `${domain.text}A later revision added this sentence.\n`;
        const senderId = 9171 + index * 10;
        try {
          const source = writeSource(directory, domain.name, textA);
          const idA = await snapshotIdFor(source, stagingRoot);
          await __bindCareerCompileRunForTests(runId, idA);
          const firstA = await acceptOneAttachmentAnswer('career-binding-a', { sourcePath: source, stagingRoot, runId, senderId, answer: `${domain.label}-a` });
          assert(firstA.asked, `${domain.label}: input A is asked once`);
          let status = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
          assert(status.mode === 'exact' && status.acceptedSteps === 1, `${domain.label}: A bound, A on disk -> exact 1, got ${JSON.stringify(status)}`);

          fs.writeFileSync(source, textB);
          const idB = await snapshotIdFor(source, stagingRoot);
          status = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
          assert(status.mode === 'restart' && status.reason === 'input-or-compiler-changed',
            `${domain.label}: B on disk was never compiled -> restart, got ${JSON.stringify(status)}`);
          // Continue on B re-binds the run, then it is interrupted before any answer.
          await __bindCareerCompileRunForTests(runId, idB);
          status = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
          assert(status.mode === 'exact' && status.acceptedSteps === 0,
            `${domain.label}: no answer belongs to B yet, so none is claimed, got ${JSON.stringify(status)}`);
          const explanation = careerCompileResumeExplanation({ state: 'exact', acceptedSteps: status.acceptedSteps });
          assert(!/replays the \d+ answer/.test(explanation.body) && /no answer was accepted for these exact files yet/.test(explanation.body),
            `${domain.label}: the banner does not promise replays it cannot deliver`);

          // Back to A: its answer is still in the store and will replay.
          fs.writeFileSync(source, textA);
          status = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
          assert(status.mode === 'exact' && status.acceptedSteps === 1,
            `${domain.label}: returning to A is exact with A's own answer, got ${JSON.stringify(status)}`);
          await __bindCareerCompileRunForTests(runId, idA);
          const replayA = await acceptOneAttachmentAnswer('career-binding-a2', { sourcePath: source, stagingRoot, runId, senderId: senderId + 1, answer: 'never-asked' });
          assert(!replayA.asked && replayA.value === `${domain.label}-a`, `${domain.label}: the exact verdict was true: A's answer replays without asking`);

          // Now give B its own answer and check both tallies stay separate.
          fs.writeFileSync(source, textB);
          await __bindCareerCompileRunForTests(runId, idB);
          const firstB = await acceptOneAttachmentAnswer('career-binding-b', { sourcePath: source, stagingRoot, runId, senderId: senderId + 2, answer: `${domain.label}-b` });
          assert(firstB.asked, `${domain.label}: B is a new question`);
          status = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
          assert(status.mode === 'exact' && status.acceptedSteps === 1, `${domain.label}: B counts only B's answer, got ${JSON.stringify(status)}`);
          fs.writeFileSync(source, textA);
          status = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
          assert(status.mode === 'exact' && status.acceptedSteps === 1, `${domain.label}: A counts only A's answer, got ${JSON.stringify(status)}`);
          // An input this run never compiled is still a restart.
          fs.writeFileSync(source, `${textA}Unrelated third revision.\n`);
          status = await __careerCompileResumeStatusForTests([source], runId, { stagingRoot });
          assert(status.mode === 'restart', `${domain.label}: a never-compiled revision restarts, got ${JSON.stringify(status)}`);
          await ipcMain.__getInvokeHandler('complete-non-api-ai-run')({ sender }, { runId });
        } finally {
          fs.rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  },
  {
    name: 'career recovery: a marker without retained input paths is a terminal, actionable state, and the verdict is re-checked when the window regains focus',
    run: () => {
      const missing = careerResumeBannerStatus({ markerRunId: 'run-1', paths: [], inspected: null, key: 'run-1\u0000' });
      assert(missing?.state === 'missing-input', 'no retained paths -> a terminal state, not an endless check');
      const missingText = careerCompileResumeExplanation(missing);
      assert(missingText.exact === false && /Clear career data/.test(missingText.body) && !/Checking/.test(missingText.body),
        'the banner says what to do instead of "Checking"');
      assert(careerResumeBannerStatus({ markerRunId: null, paths: ['/a'] }) === null, 'no career marker, no career banner status');
      assert(careerResumeBannerStatus({ markerRunId: 'run-1', paths: ['/a'], inspected: { key: 'other', state: 'exact' }, key: 'run-1\u0000/a' }).state === 'checking',
        'a verdict for other files is never shown for these');
      const verdict = { key: 'run-1\u0000/a', state: 'restart', reason: 'input-or-compiler-changed' };
      assert(careerResumeBannerStatus({ markerRunId: 'run-1', paths: ['/a'], inspected: verdict, key: 'run-1\u0000/a' }) === verdict,
        'the verdict for exactly these files is shown');
      const searchSource = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      assert(/const careerResumeCurrentStatus = careerResumeBannerStatus\(/.test(searchSource),
        'the banner derives its status through the shared helper, so missing input is not stuck on Checking');
      assert(searchSource.includes("window.addEventListener('focus', refresh)")
        && /\}, \[careerResumeInspectable, careerResumeMarkerRunId, careerResumePathsKey, careerResumeRefresh\]\);/.test(searchSource),
      'the inspection re-runs when the window regains focus, so an edited file never keeps an "unchanged" verdict');
    },
  },
];
