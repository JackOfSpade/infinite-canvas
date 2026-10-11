// Regression tests for the status poll that failed a healthy live job.
//
// A job was ended ('review root policy digest is stale') by a STATUS POLL from a
// source tree whose signed policy constants differed, by one character, from
// the build that had written the job. The poll validated an intact job with
// validators that could not re-derive its signed records, and the integrity
// path every paste surface shares recorded a TERMINAL fault: manifest status
// 'failed' plus a Generation Log event. A read has no business doing that.
//
// The rule these tests pin: a paste manifest records the validator stamp (a
// digest of the signed policy-constant catalogue) of the build that wrote it,
// and the blind-review root records its own inside its signed bytes. A
// READ-ONLY poll that fails validation ends the job only when every recorded
// stamp matches this build (the same constants cannot re-derive their own
// record: real corruption) or when no stamp was recorded (a job from before
// stamps, unchanged behaviour). When a recorded stamp differs, the poll reports
// a non-terminal 'blocked' status and persists NOTHING. Mutating paths (submit,
// handoff, import) never come through the poll and keep ending the job.
//
// Every fixture is the synthetic three-career real-flow driver of the repair
// convergence suite (different domains, names, technologies); nothing here is a
// fact about a real candidate. Each verdict is a function of the stamp alone, so
// every test proves the rule by flipping one input on the SAME tampered bytes
// and expecting the outcome to flip (A matching / B stale / C absent).
import fs from 'node:fs';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { createFlow, FLOW_SPECS } from './gapfix-repair-convergence.js';
import {
  LOCAL_AI_CARD_POLL_IDLE_STATUSES, LOCAL_AI_FALLBACK_IDLE_STATUSES, LOCAL_AI_JOB_INTEGRITY_ERROR_CODE,
  canRegenerateLocalApplication, getLocalApplicationHandoff, localApplicationStatus,
} from '../test-dependencies.js';
import { __setApplicationValidatorStampForTests, applicationValidatorStamp } from '../../electron/ipc/localAiApplication.js';
import { applicationBlindReviewValidatorStamp } from '../../electron/ipc/applicationBlindReview.js';
import { authorityDigest } from '../../electron/ipc/applicationAuthorityWorkflow.js';
import { mapApplicationStatus } from '../../electron/ipc/handoffBridge/sources/application.js';
import { applicationAwaitsPaste, applicationDockItemState } from '../../src/utils/applicationHandoffDock.js';

// Stand-ins for "a build whose policy constants differ": any digest but this build's.
const OTHER_BUILD = 'c0'.repeat(32);
const ANOTHER_BUILD = 'd1'.repeat(32);
const OTHER_BLIND_REVIEW_BUILD = 'e2'.repeat(32);

const GENERATION_LOG = 'Generation Log.jsonl';

async function walk(dir, prefix = '') {
  const found = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path.join(dir, entry.name), relative));
    else found.push(relative);
  }
  return found.sort();
}

// Every byte of the job folder, so "nothing was persisted" is a comparison and
// not a spot check of the two files a fault is known to touch.
async function snapshotJob(dir) {
  const files = new Map();
  for (const relative of await walk(dir)) files.set(relative, await fs.promises.readFile(path.join(dir, relative)));
  return files;
}

function sameSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [name, bytes] of left) if (!right.has(name) || !right.get(name).equals(bytes)) return false;
  return true;
}

async function restoreJob(dir, snapshot) {
  for (const relative of await walk(dir)) if (!snapshot.has(relative)) await fs.promises.rm(path.join(dir, relative), { force: true });
  for (const [relative, bytes] of snapshot) await fs.promises.writeFile(path.join(dir, relative), bytes);
}

async function logEvents(dir) {
  const text = await fs.promises.readFile(path.join(dir, GENERATION_LOG), 'utf8');
  return text.split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

const countFaults = async dir => (await logEvents(dir)).filter(event => event.type === 'job-integrity-fault').length;

// The same integrity-class tamper on every career: the paste state stops
// binding the career authority digest its input record pins (a fault no
// response can repair, so the shared integrity path ends the job).
const tamperedManifest = (healthy, mutate = () => {}) => {
  const manifest = JSON.parse(healthy.toString('utf8'));
  manifest.paste.careerAuthorityDigest = 'f'.repeat(64);
  mutate(manifest);
  return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
};

async function withFlow(spec, run) {
  const flow = await createFlow(spec);
  try {
    const dir = flow.queued.folder;
    const poll = () => localApplicationStatus(flow.queued.id, flow.project.canvasFilePath);
    const handoff = () => getLocalApplicationHandoff({ jobId: flow.queued.id, canvasFilePath: flow.project.canvasFilePath });
    const baseline = await snapshotJob(dir);
    const settleBaseline = () => restoreJob(dir, baseline);
    const writeManifest = bytes => fs.promises.writeFile(flow.manifestPath, bytes);
    return await run({ flow, dir, poll, handoff, baseline, settleBaseline, writeManifest });
  } finally {
    __setApplicationValidatorStampForTests(null);
    await flow.cleanup();
  }
}

async function enterBlindReview(flow) {
  const review = await flow.current();
  assert(review.stage === 'review', `expected the review handoff before blind review, found ${review.stage}`);
  const context = flow.contextOf(review);
  flow.accepted = await flow.submit(review, flow.quality(context.coverLetter.paragraphs[0].text, context.resume.roles[0].bullets[0].text));
  assert(flow.accepted.accepted && flow.accepted.handoff?.stage === 'blind-review', `the review pass must enter blind review (${JSON.stringify(flow.accepted.validationErrors || [])})`);
}

export default [
  {
    name: 'status poll: a paste manifest records the validator stamp of the build that wrote it, and a stale stamp alone never blocks or rewrites a healthy job',
    run: async () => {
      const stamp = applicationValidatorStamp();
      assert(/^[0-9a-f]{64}$/u.test(stamp) && stamp !== applicationBlindReviewValidatorStamp(), 'the application stamp is a digest that covers more than the blind-review catalogue');
      assert(applicationValidatorStamp() === stamp, 'the stamp is deterministic for one build');
      let rejectedMalformed = false;
      try { __setApplicationValidatorStampForTests('not-a-digest'); } catch { rejectedMalformed = true; }
      assert(rejectedMalformed, 'the test seam only accepts a digest');
      for (const spec of FLOW_SPECS) {
        await withFlow(spec, async ({ flow, dir, poll, baseline }) => {
          const written = await flow.manifest();
          assert(written.validatorStamp === stamp && written.transport === 'paste', `${spec.id}: every paste manifest write records the writing build's stamp`);
          // The stamp is evidence for a distinction and is not a validity condition: a job that validates is reported exactly as before
          // by a build with any other stamp, and that read changes no byte.
          __setApplicationValidatorStampForTests(OTHER_BUILD);
          const healthy = await poll();
          assert(healthy.status === 'queued' && healthy.stage === 'review' && !healthy.otherBuild, `${spec.id}: a healthy job validates under a different stamp (${JSON.stringify(healthy)})`);
          assert(sameSnapshot(baseline, await snapshotJob(dir)), `${spec.id}: a healthy read under a different stamp changes nothing`);
        });
      }
    },
  },
  {
    name: 'status poll: the SAME tampered job is ended when its stamp matches this build and reported blocked, with every byte untouched, when it was written by another build (A matching / B stale / C absent) across three careers',
    run: async () => {
      for (const spec of FLOW_SPECS) {
        await withFlow(spec, async ({ flow, dir, poll, baseline, settleBaseline, writeManifest }) => {
          const healthyManifest = baseline.get('manifest.json');
          const tampered = tamperedManifest(healthyManifest);
          const faultsBefore = await countFaults(dir);
          const label = `${spec.id}`;

          // B: written by another build. Two ways to differ, one outcome. The running build is not the one that wrote it...
          await writeManifest(tampered);
          const arranged = await snapshotJob(dir);
          __setApplicationValidatorStampForTests(OTHER_BUILD);
          const blockedStatuses = [];
          for (let attempt = 0; attempt < 3; attempt += 1) blockedStatuses.push(await poll());
          for (const status of blockedStatuses) {
            assert(status.status === 'blocked' && status.otherBuild === true && status.mode === 'paste' && status.stage === 'review' && status.resultSha256 === null,
              `${label}: a stale stamp reports a non-terminal blocked status (${JSON.stringify(status)})`);
            assert(/another app build/u.test(status.message) && /Generate/u.test(status.message) && /Nothing was changed/u.test(status.message), `${label}: the message names both ways forward and says nothing was changed`);
          }
          assert(sameSnapshot(arranged, await snapshotJob(dir)), `${label}: three blocked polls persisted nothing (manifest, Generation Log, sidecars all byte-identical)`);
          assert((await countFaults(dir)) === faultsBefore, `${label}: no Generation Log event was appended`);
          __setApplicationValidatorStampForTests(null);

          // ...or the stamp on disk is not this build's (the job was written by a build with other constants).
          await settleBaseline();
          await writeManifest(tamperedManifest(healthyManifest, manifest => { manifest.validatorStamp = ANOTHER_BUILD; }));
          const arrangedOnDisk = await snapshotJob(dir);
          const staleOnDisk = await poll();
          assert(staleOnDisk.status === 'blocked' && staleOnDisk.otherBuild === true, `${label}: a stamp on disk that is not this build's blocks the same way (${JSON.stringify(staleOnDisk)})`);
          assert(sameSnapshot(arrangedOnDisk, await snapshotJob(dir)), `${label}: the on-disk variant persisted nothing either`);

          // A: flip ONLY the stamp back to this build's, leaving the tampered bytes as they were: now it is real corruption and is ended as before.
          await settleBaseline();
          await writeManifest(tampered);
          const ended = await poll();
          const afterFault = await flow.manifest();
          assert(ended.status === 'failed' && !ended.otherBuild && ended.message === afterFault.paste.integrityFault?.message && afterFault.status === 'failed',
            `${label}: a matching stamp with a failing validation is a terminal fault (${JSON.stringify(ended)})`);
          assert((await countFaults(dir)) === faultsBefore + 1, `${label}: exactly one fault event was appended`);
          const settled = await snapshotJob(dir);
          const again = await poll();
          assert(again.status === 'failed' && sameSnapshot(settled, await snapshotJob(dir)), `${label}: a recorded fault is answered from its record on every later poll`);

          // C: a manifest from before stamps (or one whose stamp is not a digest) carries no evidence of another build, so today's behaviour holds,
          // even when the running stamp differs from anything.
          for (const [variant, mutate] of [
            ['absent', manifest => { delete manifest.validatorStamp; }],
            ['malformed', manifest => { manifest.validatorStamp = 'not-a-digest'; }],
          ]) {
            await settleBaseline();
            await writeManifest(tamperedManifest(healthyManifest, mutate));
            __setApplicationValidatorStampForTests(OTHER_BUILD);
            const legacy = await poll();
            __setApplicationValidatorStampForTests(null);
            assert(legacy.status === 'failed' && !legacy.otherBuild && (await flow.manifest()).status === 'failed', `${label}: a ${variant} stamp keeps the unchanged terminal behaviour (${JSON.stringify(legacy)})`);
          }
        });
      }
    },
  },
  {
    name: 'status poll: a mutating path still ends the job on the first fault whatever the stamp says, and an earlier blocked poll leaves that outcome reachable',
    run: async () => {
      for (const spec of FLOW_SPECS) {
        await withFlow(spec, async ({ flow, dir, poll, handoff, baseline, writeManifest }) => {
          await writeManifest(tamperedManifest(baseline.get('manifest.json')));
          __setApplicationValidatorStampForTests(OTHER_BUILD);
          assert((await poll()).status === 'blocked', `${spec.id}: the poll reports blocked first`);
          const untouched = await snapshotJob(dir);
          assert(untouched.get('manifest.json').equals(tamperedManifest(baseline.get('manifest.json'))), `${spec.id}: and persisted nothing`);
          // The handoff surface holds the job's mutation lock and mints a prompt against this state: it keeps ending the job (no stamp excuses a mutation).
          let error = null;
          try { await handoff(); } catch (caught) { error = caught; }
          const after = await flow.manifest();
          assert(error?.code === LOCAL_AI_JOB_INTEGRITY_ERROR_CODE && after.status === 'failed' && after.paste.integrityFault?.message === error.message,
            `${spec.id}: a mutating path records the terminal fault even under a stale stamp (${error?.code}/${after.status})`);
          assert((await countFaults(dir)) === 1, `${spec.id}: with exactly one fault event`);
        });
      }
    },
  },
  {
    name: 'status poll: the blind-review root records its stamp inside its signed bytes, and the poll weighs that stamp as well as the manifest\'s (A matching / B stale root / C pre-stamp root) across three careers',
    run: async () => {
      for (const spec of FLOW_SPECS) {
        await withFlow(spec, async ({ flow, dir, poll, writeManifest }) => {
          await enterBlindReview(flow);
          const entered = await snapshotJob(dir);
          const written = await flow.manifest();
          const root = written.paste.authorityBlindReview.plan.root;
          assert(root.validatorStamp === applicationBlindReviewValidatorStamp() && written.validatorStamp === applicationValidatorStamp(),
            `${spec.id}: the root records the blind-review stamp, the manifest the application stamp`);
          assert((await poll()).status === 'queued', `${spec.id}: the stamped job validates`);
          assert(sameSnapshot(entered, await snapshotJob(dir)), `${spec.id}: and reading it changes nothing`);
          const editRoot = mutate => {
            const manifest = JSON.parse(entered.get('manifest.json').toString('utf8'));
            mutate(manifest.paste.authorityBlindReview.plan.root, manifest);
            return Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
          };
          const rootStampMatches = { mutate: root => { root.policyDigest = '0'.repeat(64); } };
          const staleRootStamp = { mutate: root => { root.policyDigest = '0'.repeat(64); root.validatorStamp = OTHER_BLIND_REVIEW_BUILD; } };
          const preStampRoot = { mutate: (root, manifest) => { root.policyDigest = '0'.repeat(64); delete root.validatorStamp; delete manifest.validatorStamp; } };

          // B: the manifest's stamp is this build's, but the signed root was minted by a build with other blind-review constants.
          await writeManifest(editRoot(staleRootStamp.mutate));
          const arranged = await snapshotJob(dir);
          const blocked = await poll();
          assert(blocked.status === 'blocked' && blocked.otherBuild === true && blocked.stage === 'blind-review', `${spec.id}: a stale root stamp blocks the poll (${JSON.stringify(blocked)})`);
          assert(sameSnapshot(arranged, await snapshotJob(dir)), `${spec.id}: and persists nothing`);
          // A: the same damage with this build's root stamp is a root this build's own constants cannot re-derive: real corruption.
          await restoreJob(dir, entered);
          await writeManifest(editRoot(rootStampMatches.mutate));
          const ended = await poll();
          assert(ended.status === 'failed' && !ended.otherBuild && (await flow.manifest()).paste.integrityFault, `${spec.id}: matching stamps and a failing root end the job (${JSON.stringify(ended)})`);
          // The same pair for a root whose damage is DIGEST-CONSISTENT, the shape a real build skew has: root, plan and every pointer to them are
          // re-signed around a policyDigest this build cannot derive (a perfectly signed record from a build with other constants).
          const resignedRootEdit = mutateRoot => editRoot((root, manifest) => {
            mutateRoot(root);
            const { digest: _rootDigest, ...unsignedRoot } = root; root.digest = authorityDigest(unsignedRoot);
            const blind = manifest.paste.authorityBlindReview;
            const { digest: _planDigest, ...unsignedPlan } = blind.plan; blind.plan.digest = authorityDigest(unsignedPlan);
            blind.planDigest = blind.plan.digest;
            if (blind.rolling) {
              blind.rolling.planDigest = blind.plan.digest;
              const { digest: _rollingDigest, ...unsignedRolling } = blind.rolling; blind.rolling.digest = authorityDigest(unsignedRolling);
            }
          });
          await restoreJob(dir, entered);
          await writeManifest(resignedRootEdit(root => { root.policyDigest = '0'.repeat(64); root.validatorStamp = OTHER_BLIND_REVIEW_BUILD; }));
          const arrangedResigned = await snapshotJob(dir);
          const blockedResigned = await poll();
          assert(blockedResigned.status === 'blocked' && blockedResigned.otherBuild === true, `${spec.id}: a re-signed root from another build is blocked (${JSON.stringify(blockedResigned)})`);
          assert(sameSnapshot(arrangedResigned, await snapshotJob(dir)), `${spec.id}: and persisted nothing`);
          await restoreJob(dir, entered);
          await writeManifest(resignedRootEdit(root => { root.policyDigest = '0'.repeat(64); }));
          const endedResigned = await poll();
          assert(endedResigned.status === 'failed' && !endedResigned.otherBuild && (await flow.manifest()).paste.integrityFault,
            `${spec.id}: a root re-signed with a wrong policyDigest under a MATCHING stamp is still a terminal fault (${JSON.stringify(endedResigned)})`);
          // C: neither record carries a stamp: nothing says another build wrote it, so today's behaviour holds.
          await restoreJob(dir, entered);
          await writeManifest(editRoot(preStampRoot.mutate));
          const legacy = await poll();
          assert(legacy.status === 'failed' && !legacy.otherBuild, `${spec.id}: an unstamped root keeps the unchanged terminal behaviour (${JSON.stringify(legacy)})`);
        });
      }
    },
  },
  {
    name: 'status poll: blocked is a non-terminal, regenerable status that no driver stops polling on and the bridge never reads as a finished or broken job',
    run: () => {
      const blocked = { id: 'job', status: 'blocked', otherBuild: true, folder: '/safe', mode: 'paste', stage: 'review' };
      assert(!LOCAL_AI_CARD_POLL_IDLE_STATUSES.includes('blocked') && !LOCAL_AI_FALLBACK_IDLE_STATUSES.includes('blocked'),
        'neither the mounted card nor the fallback manager stops polling a blocked job, so the build that wrote it reconnects it by itself');
      // A blocked job must never read as "can show a prompt": fetching its handoff is a MUTATING path that ends a job on its first fault.
      assert(!applicationAwaitsPaste('blocked') && applicationDockItemState('blocked') === 'blocked', 'the dock must not ask a blocked job for a handoff, and must keep its slot');
      assert(canRegenerateLocalApplication({ status: 'blocked' }), 'the message names Generate, so the card must offer it');
      assert(!canRegenerateLocalApplication({ status: 'queued' }) && !canRegenerateLocalApplication({ status: 'completed' }), 'the regenerable set grew by exactly the blocked status');
      const mapped = mapApplicationStatus(blocked);
      assert(mapped.kind === 'threw' && !['done', 'gone', 'needs_user', 'host', 'awaiting'].includes(mapped.kind),
        `the bridge treats an unknown status as a read error, never as a terminal state (${JSON.stringify(mapped)})`);
    },
  },
];
