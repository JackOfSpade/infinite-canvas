import assert from 'node:assert/strict';
import {
  compileAuditedCareerSnapshot,
  validateCurrentCareerSnapshot,
  verbatimCareerTranscriptionAuditReceipt,
} from '../../electron/ipc/careerSnapshot.js';

const NOTES = [
  'Organized weekly engineering reviews.',
  'Prepared monthly delivery reports.',
  'Coordinated customer release meetings.',
];

function files(lines) {
  const text = lines.map(line => `${line}\n`).join('');
  return [{ name: 'Career.md', text, legacyText: text, transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }];
}

function sourcePayload(prompt) {
  const match = prompt.match(/<UNTRUSTED_CAREER_SOURCE_PAGE>\n([\s\S]*?)\n<\/UNTRUSTED_CAREER_SOURCE_PAGE>/u)
    || prompt.match(/<UNTRUSTED_CAREER_INCREMENTAL_INPUT>\n([\s\S]*?)\n<\/UNTRUSTED_CAREER_INCREMENTAL_INPUT>/u);
  assert.ok(match, 'a compilation request must retain the current bounded source-page block');
  return JSON.parse(match[1]);
}

function emptyShard() {
  return {
    identity: { name: '', contacts: [], evidenceSegmentIds: [] },
    roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
    rolePatches: [], projectPatches: [],
    continuationState: { roles: { mode: 'clear', ids: [] }, projects: { mode: 'clear', ids: [] } },
    segmentCoverage: [],
  };
}

function notesShard(payload) {
  const shard = emptyShard();
  for (const segment of payload.page.segments) {
    const id = `note-${segment.id}`;
    shard.achievements.push({
      id, roleId: '', claim: segment.text.trimEnd(), technologies: [], technologyReferences: [], metrics: [],
      evidenceSegmentIds: [segment.id],
    });
    shard.segmentCoverage.push({ segmentId: segment.id, disposition: 'achievement', entityIds: [id] });
  }
  return shard;
}

function recordingTransport({ shardForPage = notesShard, incrementalMode = 'edits', auditResponse = null, repairResponse = null } = {}) {
  const calls = [];
  return {
    calls,
    callText: async (prompt, options) => {
      calls.push({ prompt, task: options.task, pageIndex: options.hints?.pageIndex });
      let response;
      if (options.task === 'career-profile-compile') {
        const payload = sourcePayload(prompt);
        if (options.hints?.phase === 'incremental-edit') {
          response = { mode: incrementalMode, edits: [], notes: 'Apply the literal source change.' };
          if (incrementalMode === 'edits') {
            for (const previous of payload.previousPageProfile.achievements) {
              const segment = payload.page.segments.find(row => previous.evidenceSegmentIds.includes(row.id));
              if (segment && previous.claim !== segment.text.trimEnd()) response.edits.push({
                op: 'set', group: 'achievements', entityId: previous.id, field: 'claim', valueJson: JSON.stringify(segment.text.trimEnd()),
              });
            }
          }
        } else response = shardForPage(payload);
      }
      else if (options.task.startsWith('career-profile-audit-')) response = auditResponse ? auditResponse(prompt, options) : { findings: [] };
      else if (options.task === 'career-profile-repair' && repairResponse) response = repairResponse(prompt, options);
      else throw new Error(`Unexpected incremental fixture task: ${options.task}`);
      if (options.responseValidator) options.responseValidator(response);
      return response;
    },
  };
}

function laneCalls(transport, taskPrefix) {
  return transport.calls.filter(call => call.task.startsWith(taskPrefix));
}

// Keep the public compiler's baseline arguments in one place. The fixture
// passes the retained approved source text and compiler state together, as the
// production intake must do after the original career file has been edited.
function previousOptions(previous) {
  return previous ? { previousCompilation: { snapshot: previous.snapshot, state: previous.reuseState } } : {};
}

async function compile(lines, { previous = null, transport = recordingTransport() } = {}) {
  const result = await compileAuditedCareerSnapshot({
    sourceFiles: files(lines), pageMaxSegments: 1, callText: transport.callText,
    ...previousOptions(previous),
  });
  assert.equal(validateCurrentCareerSnapshot(result.snapshot).valid, true, 'incremental output must pass the complete current snapshot validator');
  assert.ok(result.reuseState && typeof result.reuseState === 'object', 'approval must retain reusable page compiler state');
  return { result, transport };
}

export default [
  {
    name: 'career incremental compilation: a literal edit reprocesses one page while reusing the other approved pages',
    run: async () => {
      const baseline = await compile(NOTES);
      assert.equal(laneCalls(baseline.transport, 'career-profile-compile').length, 3);
      assert.equal(laneCalls(baseline.transport, 'career-profile-audit-').length, 18);
      const baselineBytes = JSON.stringify(baseline.result.snapshot);
      const changed = [NOTES[0], 'Prepared quarterly delivery reports for leadership.', NOTES[2]];
      const update = await compile(changed, { previous: baseline.result });
      assert.equal(laneCalls(update.transport, 'career-profile-compile').length, 1, 'only the edited page needs another conversion');
      assert.equal(laneCalls(update.transport, 'career-profile-audit-').length, 6, 'unchanged approved page audit inputs retain their six clean proofs');
      assert.deepEqual(laneCalls(update.transport, 'career-profile-compile').map(call => call.pageIndex), [1]);
      assert.notEqual(update.result.snapshotId, baseline.result.snapshotId, 'edited source publishes a new immutable snapshot');
      assert.equal(JSON.stringify(baseline.result.snapshot), baselineBytes, 'the previous approved snapshot stays unchanged');
      assert.deepEqual(update.result.profile.achievements.map(row => row.claim), changed);
      const prompt = laneCalls(update.transport, 'career-profile-compile')[0].prompt;
      assert.ok(prompt.includes(NOTES[1]) && prompt.includes(changed[1]), 'the edit request includes the previous literal text and current source');
      return { compiled: 1, audited: 6, baselineCompiled: 3, baselineAudited: 18 };
    },
  },
  {
    name: 'career incremental compilation: an unchanged approved baseline requires no model handoffs',
    run: async () => {
      const baseline = await compile(NOTES);
      const repeated = await compile(NOTES, { previous: baseline.result });
      assert.equal(repeated.transport.calls.length, 0, 'unchanged source and contexts reuse conversion and clean audit proofs');
      assert.equal(repeated.result.snapshotId, baseline.result.snapshotId);
      assert.deepEqual(repeated.result.profile, baseline.result.profile);
      return { calls: 0 };
    },
  },
  {
    name: 'career incremental compilation: reusable state survives serialization with the approved source baseline',
    run: async () => {
      const baseline = await compile(NOTES);
      const persisted = JSON.parse(JSON.stringify({ snapshot: baseline.result.snapshot, reuseState: baseline.result.reuseState }));
      const update = await compile([NOTES[0], 'Prepared annual delivery reports.', NOTES[2]], { previous: persisted });
      assert.equal(laneCalls(update.transport, 'career-profile-compile').length, 1);
      assert.equal(laneCalls(update.transport, 'career-profile-audit-').length, 6);
      return { compiled: 1, audited: 6 };
    },
  },
  {
    name: 'career incremental compilation: mismatched retained shards fail closed to a full conversion',
    run: async () => {
      const baseline = await compile(NOTES);
      const damaged = structuredClone(baseline.result);
      damaged.reuseState.pageProfiles[1].achievements[0].claim = 'An unsupported retained claim.';
      const update = await compile([NOTES[0], 'Prepared annual delivery reports.', NOTES[2]], { previous: damaged });
      assert.equal(laneCalls(update.transport, 'career-profile-compile').length, 3, 'a state/profile mismatch must discard all untrusted reuse');
      assert.equal(laneCalls(update.transport, 'career-profile-audit-').length, 18);
      assert.ok(!JSON.stringify(update.result.profile).includes('unsupported'));
      return { compiled: 3, audited: 18 };
    },
  },
  {
    name: 'career incremental compilation: a forged clean audit digest discards the retained optimization state',
    run: async () => {
      const baseline = await compile(NOTES);
      const damaged = structuredClone(baseline.result);
      damaged.reuseState.cleanAuditDigests[0] = '0'.repeat(64);
      const update = await compile([NOTES[0], 'Prepared annual delivery reports.', NOTES[2]], { previous: damaged });
      assert.equal(laneCalls(update.transport, 'career-profile-compile').length, 3);
      assert.equal(laneCalls(update.transport, 'career-profile-audit-').length, 18, 'unverified audit proofs cannot suppress independent checks');
      return { compiled: 3, audited: 18 };
    },
  },
  {
    name: 'career incremental compilation: a prior settled decision does not suppress a fresh independent audit',
    run: async () => {
      const shardForPage = payload => {
        const shard = notesShard(payload);
        if (payload.page.index !== 0) return shard;
        const segment = payload.page.segments[0];
        const id = 'career-note';
        shard.achievements = [];
        shard.otherEvidence = [{ id, kind: 'note', label: '', text: segment.text.trimEnd(), evidenceSegmentIds: [segment.id] }];
        shard.segmentCoverage = [{ segmentId: segment.id, disposition: 'context', entityIds: [id] }];
        return shard;
      };
      let corrected = false;
      const auditResponse = (_prompt, options) => {
        if (corrected || options.hints.pageIndex !== 0 || options.task !== 'career-profile-audit-completeness') return { findings: [] };
        corrected = true;
        return { findings: [{
          id: 'classify-note', category: 'coverage', severity: 'warning', segmentIds: ['segment-0001'], entityIds: ['p0001-career-note'],
          detail: 'Classify the supplied career note consistently.', sourceQuote: NOTES[0],
          edits: [{ op: 'set', group: 'otherEvidence', entityId: 'p0001-career-note', field: 'kind', valueJson: JSON.stringify('career-note') }],
          challenge: { decisionId: '', evidenceSegmentIds: [] },
        }] };
      };
      const baseline = await compile(NOTES, { transport: recordingTransport({ shardForPage, auditResponse }) });
      assert.equal(baseline.result.snapshot.auditHistory.at(-1).decisionLog.targets.length, 1, 'fixture must include a genuinely settled audit decision');
      assert.equal(baseline.result.reuseState.cleanAuditDigests.length, 12, 'only the two pages without settled decisions supply reusable audit proofs');
      const repeated = await compile(NOTES, { previous: baseline.result });
      assert.equal(laneCalls(repeated.transport, 'career-profile-compile').length, 0, 'the approved facts can still be retained');
      const audits = laneCalls(repeated.transport, 'career-profile-audit-');
      assert.equal(audits.length, 6, 'the page previously audited under a settled decision needs all six unrestricted lanes');
      assert.ok(audits.every(call => call.pageIndex === 0));
      assert.equal(repeated.result.profile.otherEvidence[0].kind, 'career-note');
      return { compiled: 0, audited: 6 };
    },
  },
  {
    name: 'career incremental compilation: host grounding catches and removes a metric left behind by an incomplete source edit',
    run: async () => {
      const shardForPage = payload => {
        const shard = notesShard(payload);
        if (payload.page.index === 1) {
          const segment = payload.page.segments[0];
          shard.achievements[0].metrics = [{ label: 'users', value: '50', unit: 'users', evidenceSegmentIds: [segment.id] }];
        }
        return shard;
      };
      const baseline = await compile([NOTES[0], 'Built a report used by 50 users.'], { transport: recordingTransport({ shardForPage }) });
      const repairResponse = (prompt) => {
        assert.ok(prompt.includes('50'), 'the stale metric must reach the deterministic repair context');
        return {
          edits: [{ op: 'set', group: 'achievements', entityId: 'p0002-note-segment-0002', field: 'metrics', valueJson: '[]' }],
          notes: 'The current source no longer states a user count.',
        };
      };
      const transport = recordingTransport({ repairResponse });
      const currentClaim = 'Built a report for customer reviews.';
      const update = await compile([NOTES[0], currentClaim], { previous: baseline.result, transport });
      assert.equal(laneCalls(transport, 'career-profile-repair').length, 1, 'a shortcut must still run the global literal-grounding validator');
      assert.equal(update.result.profile.achievements[1].claim, currentClaim);
      assert.deepEqual(update.result.profile.achievements[1].metrics, [], 'an obsolete source metric cannot reach approval');
      assert.equal(laneCalls(transport, 'career-profile-audit-').length, 6);
      return { repairs: 1, audited: 6 };
    },
  },
  {
    name: 'career incremental compilation: deleted source facts cannot survive baseline reuse',
    run: async () => {
      const baseline = await compile(NOTES);
      const remaining = [NOTES[0], NOTES[2]];
      const update = await compile(remaining, { previous: baseline.result });
      assert.deepEqual(update.result.profile.achievements.map(row => row.claim), remaining);
      assert.ok(!JSON.stringify(update.result.profile).includes(NOTES[1]), 'a removed source line must remove its old claim');
      assert.equal(update.result.snapshot.sources[0].text, files(remaining)[0].text);
      return { retainedClaims: remaining.length };
    },
  },
  {
    name: 'career incremental compilation: a changed active role invalidates an unchanged dependent source page',
    run: async () => {
      const shardForPage = (payload) => {
        const shard = notesShard(payload);
        if (payload.page.index === 0) {
          const segment = payload.page.segments[0];
          const role = {
            id: 'role-acme', title: segment.text.startsWith('Senior') ? 'Senior Engineer' : 'Engineer', employer: 'Acme',
            startDate: '', endDate: '', location: '', achievementIds: [], skillIds: [], evidenceSegmentIds: [segment.id],
          };
          shard.roles = [role];
          shard.achievements = [];
          shard.segmentCoverage = [{ segmentId: segment.id, disposition: 'role-header', entityIds: [role.id] }];
          shard.continuationState.roles = { mode: 'replace', ids: [role.id] };
        } else {
          shard.achievements[0].roleId = 'p0001-role-acme';
          shard.continuationState.roles = { mode: 'inherit', ids: [] };
        }
        return shard;
      };
      const lines = ['Engineer at Acme', NOTES[0]];
      const baseline = await compile(lines, { transport: recordingTransport({ shardForPage, incrementalMode: 'recompile' }) });
      const transport = recordingTransport({ shardForPage, incrementalMode: 'recompile' });
      const update = await compile(['Senior Engineer at Acme', NOTES[0]], { previous: baseline.result, transport });
      assert.ok(laneCalls(transport, 'career-profile-compile').some(call => call.pageIndex === 1), 'an unchanged claim must be reconsidered when its active role context changes');
      assert.equal(laneCalls(transport, 'career-profile-audit-').length, 12, 'both changed and context-dependent pages need fresh audit proofs');
      assert.equal(update.result.profile.roles[0].title, 'Senior Engineer');
      assert.equal(update.result.profile.achievements[0].roleId, update.result.profile.roles[0].id);
      return { audited: 12 };
    },
  },
];
