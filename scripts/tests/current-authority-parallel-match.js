import { assert, __setAuthorityLedgerStoreFaultHookForTests, fs, getLocalApplicationHandoff, localApplicationStatus, openAuthorityLedgerStore, path, submitLocalApplicationHandoff } from '../test-dependencies.js';
import { requirementsAuditCapTerminal } from '../../electron/ipc/applicationRequirementsAuditPolicy.js';
import { createApplicationSource } from '../../electron/ipc/handoffBridge/sources/application.js';
import { queueLocalApplicationJob, __setLocalAiJobMutationLockObserverForTests, __setQueuedCurrentAuthorityProtocolForTests, PASTE_REQUIREMENTS_SCHEMA_RULE_IDS, pasteCorrectionPrompt, pasteRejectionCheckIds } from '../../electron/ipc/localAiApplication.js';
import { _resetPasteHandoffDiagnostics, getPasteHandoffDiagnosticsSnapshot } from '../../electron/ipc/pasteHandoffDiagnostics.js';
import { makeCurrentAuthorityParallelMatchFixture } from './fixtures/current-authority-parallel-match.mjs';

function contextOf(handoffOrServed) {
  const prompt = handoffOrServed.prompt;
  const marker = '\n\nAuthoritative context:\n';
  return JSON.parse(prompt.slice(prompt.lastIndexOf(marker) + marker.length));
}

function coverageFor(context, evidence, requirements, nextUnitIndex) {
  const source = context.requirementsProgress.sourceCoverage;
  const idsByUnit = new Map(source.units.map(unit => [unit.id, []]));
  for (const requirement of requirements) {
    for (const evidenceId of requirement.evidenceIds) {
      const item = evidence.find(candidate => candidate.id === evidenceId);
      const unit = source.units.find(candidate => String(candidate.text).includes(String(item?.quote || '')));
      if (unit) idsByUnit.get(unit.id).push(requirement.id);
    }
  }
  return {
    nextUnitIndex,
    coverage: source.units.slice(0, nextUnitIndex - source.unitStart).map(unit => {
      const requirementIds = idsByUnit.get(unit.id);
      return requirementIds.length ? { unitId: unit.id, disposition: 'requirement', requirementIds } : { unitId: unit.id, disposition: 'not-a-requirement', requirementIds: [] };
    }),
  };
}

function semanticAuditFor(context, evidence, requirements) {
  return {
    storeDigest: context.authorityStore.digest,
    auditDigest: context.auditDigest,
    rows: context.units.map(unit => {
      const requirementIds = requirements.filter(requirement => requirement.evidenceIds.some(id => {
        const item = evidence.find(candidate => candidate.id === id);
        return item && String(unit.text).includes(String(item.quote));
      })).map(requirement => requirement.id);
      return { unitId: unit.id, disposition: requirementIds.length ? 'requirement' : 'not-a-requirement' };
    }),
  };
}

// Drives discovery for the remaining source windows of the active epoch.  A
// re-epoch carries the discovery pages wholly before the disputed audit
// window, so in epochs > 0 the first handoff may resume past unit zero; the
// carried pages' evidence and requirements come from `prior` (the previous
// epoch's result) so later audits classify the whole listing.
async function completeRequirementsDiscovery({ fixture, queued, epoch = 0, prior = null }) {
  const reply = (handoff, fields) => JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields });
  const evidence = [];
  const requirements = [];
  const byIndex = new Map();
  let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath })).handoff;
  const idPrefix = epoch === 0 ? 'p1-' : `e${epoch}-p1-`;
  const resumeUnit = contextOf(handoff).requirementsProgress.sourceCoverage.unitStart;
  const firstRemaining = fixture.requirementUnitIndexes
    ? fixture.requirementUnitIndexes.findIndex(unitIndex => unitIndex >= resumeUnit)
    : 0;
  assert(resumeUnit === 0 || (epoch > 0 && fixture.requirementUnitIndexes && firstRemaining > 0),
    `only a re-epoch over a long listing resumes past unit zero (resume=${resumeUnit}, epoch=${epoch})`);
  for (let index = 0; index < firstRemaining; index += 1) {
    const carried = prior?.byIndex?.get(index);
    assert(!!carried, `carried discovery page ${index + 1} has a prior-epoch record to reuse`);
    byIndex.set(index, carried);
    evidence.push(...carried.evidence); requirements.push(...carried.requirements);
  }
  const submitCoverageOnlyPage = async (label, complete = false) => {
    const context = contextOf(handoff);
    const source = context.requirementsProgress.sourceCoverage;
    const accepted = await submitLocalApplicationHandoff({
      jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: handoff.handoffCode,
      response: reply(handoff, {
        storeDigest: context.authorityStore.digest, complete, identity: context.trustedIdentity,
        evidence: [], requirements: [], ...coverageFor(context, [], [], source.unitStart + 1),
      }),
    });
    assert(accepted.accepted, `${label} coverage-only requirement page is accepted (${JSON.stringify(accepted.validationErrors || [])})`);
    handoff = accepted.handoff;
  };
  if (fixture.coverageOnlyPrefix && resumeUnit === 0) await submitCoverageOnlyPage('prefix');
  for (let index = firstRemaining; index < fixture.requirements.length; index += 1) {
    const context = contextOf(handoff);
    assert(context.requirementsProgress.epoch === epoch,
      `requirements discovery reopens the expected immutable epoch (${context.requirementsProgress.epoch})`);
    const source = context.requirementsProgress.sourceCoverage;
    const requirementUnitIndex = source.units.findIndex(unit => unit.text === fixture.requirements[index]);
    assert(requirementUnitIndex >= 0, `synthetic requirement ${index + 1} appears in the current immutable source window`);
    const item = { id: `${idPrefix}e-${index + 1}`, sourceId: 'job-listing', quote: fixture.requirements[index], requirement: `Synthetic capability ${String(index + 1).padStart(2, '0')}`, priority: 'high' };
    const requirement = { id: `${idPrefix}r-${index + 1}`, text: item.requirement, priority: 'high', evidenceIds: [item.id] };
    const bound = source.bindingRows?.find(row => row.unitId === source.units[requirementUnitIndex].id);
    const pageEvidence = bound?.disposition === 'not-a-requirement' ? [] : [item];
    const pageRequirements = bound?.disposition === 'not-a-requirement' ? [] : [requirement];
    if (epoch > 0) {
      for (const binding of source.bindingRows || []) {
        if (binding.disposition !== 'requirement' || source.units.find(unit => unit.id === binding.unitId)?.text === item.quote) continue;
        const unit = source.units.find(candidate => candidate.id === binding.unitId);
        if (!unit || source.units.indexOf(unit) > requirementUnitIndex) continue;
        const extra = { id: `${idPrefix}e-bound-${binding.unitId}`, sourceId: 'job-listing', quote: unit.text,
          requirement: `Synthetic adjudicated capability ${binding.unitId}`, priority: 'high' };
        pageEvidence.push(extra);
        pageRequirements.push({ id: `${idPrefix}r-bound-${binding.unitId}`, text: extra.requirement, priority: 'high', evidenceIds: [extra.id] });
      }
    }
    evidence.push(...pageEvidence); requirements.push(...pageRequirements);
    byIndex.set(index, { evidence: [...pageEvidence], requirements: [...pageRequirements] });
    const hasCoverageOnlyAfter = fixture.coverageOnlyAfterEveryRequirement || fixture.coverageOnlyAfterRequirementIndex === index;
    const accepted = await submitLocalApplicationHandoff({
      jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: handoff.handoffCode,
      response: reply(handoff, {
        storeDigest: context.authorityStore.digest, complete: index === fixture.requirements.length - 1 && !fixture.trailingCoverageOnlyUnit && !hasCoverageOnlyAfter,
        identity: context.trustedIdentity, evidence: pageEvidence, requirements: pageRequirements,
        ...coverageFor(context, pageEvidence, pageRequirements, index === fixture.requirements.length - 1 && !fixture.trailingCoverageOnlyUnit && !hasCoverageOnlyAfter
          ? source.unitStart + source.units.length
          : source.unitStart + requirementUnitIndex + 1),
      }),
    });
    assert(accepted.accepted, `requirement page ${index + 1} is accepted (${JSON.stringify(accepted.validationErrors || [])})`);
    handoff = accepted.handoff;
    if (hasCoverageOnlyAfter) await submitCoverageOnlyPage('middle', index === fixture.requirements.length - 1 && !fixture.trailingCoverageOnlyUnit);
  }
  if (fixture.trailingCoverageOnlyUnit) {
    const context = contextOf(handoff);
    const source = context.requirementsProgress.sourceCoverage;
    const accepted = await submitLocalApplicationHandoff({
      jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: handoff.handoffCode,
      response: reply(handoff, {
        storeDigest: context.authorityStore.digest, complete: true, identity: context.trustedIdentity,
        evidence: [], requirements: [],
        ...coverageFor(context, [], [], source.unitStart + source.units.length),
      }),
    });
    assert(accepted.accepted, `coverage-only requirement page is accepted (${JSON.stringify(accepted.validationErrors || [])})`);
    handoff = accepted.handoff;
  }
  return { handoff, evidence, requirements, reply, byIndex, resumeUnit, firstRemaining };
}

// Flips one audit row so the independent audit disagrees with discovery.
function flipRow(audit, unitId) {
  const row = audit.rows.find(candidate => candidate.unitId === unitId);
  assert(!!row, `the audit window contains disputed unit ${unitId}`);
  row.disposition = row.disposition === 'requirement' ? 'not-a-requirement' : 'requirement';
  return row;
}

// Submits an audit-sided adjudication for an open adjudication handoff.
async function adjudicateWithAudit({ fixture, queued, opened, audit, reply }) {
  const context = contextOf(opened.handoff);
  return submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
    handoffCode: opened.handoff.handoffCode, response: reply(opened.handoff, {
      storeDigest: context.storeDigest, caseDigest: context.caseDigest,
      rows: context.cases.map(unit => ({ unitId: unit.unitId, disposition: audit.rows.find(row => row.unitId === unit.unitId).disposition })),
    }) });
}

// Long-listing helpers: the unit id at a listing index comes from whichever
// served window contains that index's synthetic text.
function unitIdForText(context, text) {
  const units = context.units || context.requirementsProgress?.sourceCoverage?.units || [];
  return units.find(unit => unit.text === text)?.id;
}

// Agrees with every served audit window until the one holding `unitIndex`,
// disputes that unit, and sides the adjudicator with the audit.
async function disputeLiveAuditWindow({ fixture, queued, discovery, unitIndex }) {
  let handoff = discovery.handoff;
  while (handoff?.stage === 'requirements-audit') {
    const context = contextOf(handoff);
    const audit = semanticAuditFor(context, discovery.evidence, discovery.requirements);
    const disputedId = unitIdForText(context, fixture.unitTexts[unitIndex]);
    if (disputedId) {
      flipRow(audit, disputedId);
      const opened = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: handoff.handoffCode, response: discovery.reply(handoff, audit) });
      assert(opened.accepted && opened.handoff?.stage === 'requirements-adjudication',
        `the dispute on unit ${unitIndex} opens adjudication (${JSON.stringify(opened.validationErrors || [])})`);
      return adjudicateWithAudit({ fixture, queued, opened, audit, reply: discovery.reply });
    }
    const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
      handoffCode: handoff.handoffCode, response: discovery.reply(handoff, audit) });
    assert(accepted.accepted, `an agreeing audit window is accepted (${JSON.stringify(accepted.validationErrors || [])})`);
    handoff = accepted.handoff;
  }
  throw new Error(`no served audit window contained unit ${unitIndex}`);
}

// Epoch zero over the long listing: agree with window [0,64), dispute unit 80
// in window [64,128), and side with the audit to open epoch one.
async function longListingToEpochOne({ fixture, queued }) {
  const first = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath })).handoff;
  const firstSource = contextOf(first).requirementsProgress.sourceCoverage;
  const header = fixture.headerUnitCount;
  assert(firstSource.unitCount === fixture.unitTexts.length + 2 && firstSource.units[header]?.text === fixture.unitTexts[header]
    && firstSource.units[header - 1]?.text !== fixture.unitTexts[header],
  `the long listing is one listing page of 150 units whose synthetic sentences start after the header (${firstSource.unitCount}, ${JSON.stringify(firstSource.units.slice(0, header + 1).map(unit => unit.text.length))})`);
  const epochZero = await completeRequirementsDiscovery({ fixture, queued });
  assert(epochZero.handoff?.stage === 'requirements-audit' && contextOf(epochZero.handoff).units[header].text === fixture.unitTexts[header],
    'epoch-zero audit starts at window [0,64)');
  const reset = await disputeLiveAuditWindow({ fixture, queued, discovery: epochZero, unitIndex: 80 });
  assert(reset.accepted && reset.handoff?.stage === 'requirements', 'the audit-sided verdict on unit 80 opens epoch one');
  return { epochZero, reset };
}

async function readGenerationLog(queued) {
  const text = await fs.promises.readFile(path.join(queued.folder, 'Generation Log.jsonl'), 'utf8');
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

async function assertReplays({ fixture, queued, stage, label }) {
  const reopened = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath });
  const status = await localApplicationStatus(queued.id, fixture.canvasFilePath);
  assert(reopened.handoff?.stage === stage && reopened.localJob.status === 'queued' && status.status === 'queued' && status.stage === stage,
    `${label}: reopen and status replay the immutable store (stage=${reopened.handoff?.stage}, status=${status.status}/${status.stage})`);
  return reopened;
}

function authorityRootPageReferences(root) {
  const files = new Set();
  for (const stream of Object.values(root?.streams || {})) {
    if (stream?.head) files.add(stream.head);
    for (const peak of stream?.index?.peaks || []) if (peak?.file) files.add(peak.file);
  }
  for (const bucket of Object.values(root?.idBuckets || {})) if (bucket?.head) files.add(bucket.head);
  return files;
}

async function assertAuthorityRootReferencesExist(contextDir, root, label) {
  const pagesDir = path.join(contextDir, 'application-authority-pages');
  const missing = [];
  for (const file of authorityRootPageReferences(root)) {
    const valid = await fs.promises.lstat(path.join(pagesDir, file))
      .then(stat => stat.isFile() && !stat.isSymbolicLink(), () => false);
    if (!valid) missing.push(file);
  }
  assert(missing.length === 0, `${label} (${missing.join(', ')})`);
}

export default [
  { name: 'current authority requirements audit: agreed audit advances a compact write-verify job into writing', async run() {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    fixture.requirements = fixture.requirements.slice(0, 2);
    fixture.job.snippet = fixture.requirements.join('\n');
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const discovery = await completeRequirementsDiscovery({ fixture, queued });
      let handoff = discovery.handoff;
      let count = 0;
      while (handoff.stage === 'requirements-audit') {
        assert(++count < 10, 'the audit must make bounded cursor progress');
        const audit = semanticAuditFor(contextOf(handoff), discovery.evidence, discovery.requirements);
        const result = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
          handoffCode: handoff.handoffCode, response: discovery.reply(handoff, audit) });
        assert(result.accepted, `agreed audit must be accepted: ${JSON.stringify(result.validationErrors || [])}`);
        handoff = result.handoff;
      }
      assert(handoff.stage === 'write', `agreed audit reaches writing, got ${handoff.stage}`);
    } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
  } },
{
  name: 'current authority requirements: compact schema replay keeps coverage cascades and durable diagnostics structural',
  run: async () => {
    const highVolume = pasteCorrectionPrompt({
      input: { jobId: 'schema-test', careerAuthority: { snapshotDigest: 'schema-test' }, authorityProtocol: 'requirements-ledger.v2', listingCoverageVersion: 1 },
      state: { stage: 'requirements', handoffCode: 'schema-code', baseHashes: {}, authorityListingPage: { index: 0, pageCount: 1, sourceCoverage: { unitStart: 0, unitCount: 1, units: [{ id: 'u00000001' }] } } },
      corrections: [
        'requirements-schema-response: response field is missing.',
        'requirements-schema-response: response field has the wrong type.',
        'requirements-schema-response: response array is out of order.',
      ],
      checkIds: ['requirements-schema-response'],
    });
    assert(highVolume.prompt.includes('Schema reconstruction required') && highVolume.prompt.includes('Compact requirements schema'),
      'the first high-volume requirements schema rejection replays the compact stage schema without waiting for a streak');
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    const secret = 'PRIVATE_REQUIREMENTS_SOURCE_TEXT';
    _resetPasteHandoffDiagnostics();
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath })).handoff;
      const context = contextOf(handoff);
      const source = context.requirementsProgress.sourceCoverage;
      assert(handoff.prompt.includes('Compact requirements schema')
        && handoff.prompt.includes(`Cursor window [${source.unitStart}, ${source.unitStart + source.units.length}) of ${source.unitCount}`)
        && handoff.prompt.includes("quote overlapping that row's exact source unit")
        && handoff.prompt.includes('field names, types, references, and array order'),
      'the requirements prompt ships a compact host-derived schema that states cursor, coverage, binding, quote-overlap, and order invariants');

      const malformed = () => JSON.stringify({
        protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes,
        storeDigest: context.authorityStore.digest, complete: false, identity: context.trustedIdentity,
        evidence: [{ id: 'p1-e-secret', sourceId: 'job-listing', quote: secret, requirement: 'Synthetic capability', priority: 'high' }],
        requirements: [{ id: 'p1-r-secret', text: 'Synthetic capability', priority: 'high', evidenceIds: ['p1-e-secret'] }],
        coverage: {}, nextUnitIndex: source.unitStart,
      });
      let rejected;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        rejected = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: handoff.handoffCode, response: malformed() });
        assert(!rejected.accepted && rejected.validationErrors.length >= 2
          && rejected.validationErrors.every(message => message.startsWith('requirements-schema-coverage:'))
          && !rejected.validationErrors.some(message => message.includes(secret)),
        `coverage shape fails first without quote/binding cascades on attempt ${attempt} (errors=${JSON.stringify(rejected.validationErrors)})`);
        handoff = rejected.handoff;
      }
      assert(rejected.handoff.correctionPrompt.includes('Schema reconstruction required')
        && rejected.handoff.correctionPrompt.includes('Compact requirements schema')
        && rejected.handoff.correctionPrompt.includes('complete object')
        && rejected.handoff.rejectionEscalation.active
        && rejected.handoff.rejectionEscalation.checkIds.includes('requirements-schema-coverage'),
      'a repeated typed schema rule escalates to complete-object reconstruction and replays the compact schema');
      const typed = pasteRejectionCheckIds(rejected.validationErrors);
      assert(typed.checkIds.length === 1 && typed.checkIds[0] === 'requirements-schema-coverage'
        && PASTE_REQUIREMENTS_SCHEMA_RULE_IDS.includes(typed.checkIds[0]) && typed.uncodedErrors === 0,
      'requirements schema errors participate in the closed diagnostic and streak vocabulary');
      const diagnostics = getPasteHandoffDiagnosticsSnapshot();
      const durable = await fs.promises.readFile(path.join(queued.folder, 'Paste Rejections.json'), 'utf8');
      assert(!JSON.stringify(diagnostics).includes(secret) && !durable.includes(secret)
        && durable.includes('requirements-schema-coverage') && !durable.includes('coverage must'),
      'live and durable diagnostics retain only closed schema ids and metadata, never source or validation detail');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority independent audit and adjudication stop on a repeated structural rule',
  run: async () => {
    for (const stage of ['requirements-audit', 'requirements-adjudication']) {
      const fixture = await makeCurrentAuthorityParallelMatchFixture();
      try {
        const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
        const args = { jobId: queued.id, canvasFilePath: fixture.canvasFilePath };
        const discovered = await completeRequirementsDiscovery({ fixture, queued });
        let handoff = discovered.handoff;
        if (stage === 'requirements-adjudication') {
          const audit = semanticAuditFor(contextOf(handoff), discovered.evidence, discovered.requirements);
          audit.rows[0].disposition = audit.rows[0].disposition === 'requirement' ? 'not-a-requirement' : 'requirement';
          const opened = await submitLocalApplicationHandoff({ ...args, handoffCode: handoff.handoffCode, response: discovered.reply(handoff, audit) });
          assert(opened.accepted, 'valid disagreement opens adjudication'); handoff = opened.handoff;
        }
        assert(handoff.stage === stage, 'fixture reaches intended independent stage');
        let result;
        for (let attempt = 1; attempt <= 5; attempt++) {
          const context = contextOf(handoff);
          result = await submitLocalApplicationHandoff({ ...args, route: 'claude-runner', handoffCode: handoff.handoffCode,
            response: discovered.reply(handoff, { storeDigest: context.authorityStore?.digest || context.storeDigest,
              ...(stage === 'requirements-audit' ? { auditDigest: context.auditDigest } : { caseDigest: context.caseDigest }), rows: {} }) });
          if (attempt < 5) { assert(result.handoff && !result.terminal, 'correction remains open before fifth same rule'); handoff = result.handoff; }
        }
        assert(result.terminal && result.stop.stage === stage && result.stop.count === 5, 'same-rule terminal names the independent stage');
        assert((await getLocalApplicationHandoff(args)).terminal, 'retained-stage terminal reloads');
      } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
    }
  },
}, {
  name: 'current authority requirements: same-rule stop is durable and restricted to the Claude route',
  run: async () => {
    for (const route of ['claude-runner', null]) {
      const fixture = await makeCurrentAuthorityParallelMatchFixture();
      try {
        const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
        const args = { jobId: queued.id, canvasFilePath: fixture.canvasFilePath };
        let handoff = (await getLocalApplicationHandoff(args)).handoff;
        const context = contextOf(handoff);
        const malformed = () => JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes,
          storeDigest: context.authorityStore.digest, complete: false, identity: context.trustedIdentity,
          evidence: [], requirements: [], coverage: {}, nextUnitIndex: context.requirementsProgress.sourceCoverage.unitStart });
        for (let attempt = 1; attempt <= (route ? 5 : 7); attempt++) {
          const result = await submitLocalApplicationHandoff({ ...args, handoffCode: handoff.handoffCode, response: malformed(), route });
          assert(!result.accepted, 'malformed response must fail');
          if (attempt === 5 && route) {
            assert(result.terminal && result.completed && result.handoff === null, 'fifth same-rule rejection ends the runner step');
            assert(result.stop.reason === 'same-rule-repeat' && result.stop.count === 5, 'typed same-rule stop');
          } else {
            assert(!result.terminal && result.handoff, 'manual replies stay available');
            if (attempt >= 2) assert(result.handoff.corrections[0].startsWith('Unchanged reply:'), 'identical rejected content is explained');
            assert(!result.validationErrors.some(line => line.startsWith('Unchanged reply:')), 'notice is not a failed rule');
            handoff = result.handoff;
          }
        }
        const manifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
        assert(manifest.paste.ruleTally.steps[0].rules[0].n === (route ? 5 : 7), 'tally survives file persistence');
        if (route) {
          assert(manifest.status === 'failed' && manifest.paste.stage === 'requirements', 'stop keeps the source cursor stage');
          const reopened = await getLocalApplicationHandoff(args);
          assert(reopened.completed && reopened.terminal && reopened.handoff === null && reopened.stop.reason === 'same-rule-repeat', 'reopened terminal is durable');
          const status = await localApplicationStatus(queued.id, fixture.canvasFilePath);
          assert(status.terminalReason === 'same-rule-repeat', 'card exposes stop reason');
        }
      } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
    }
  },
}, {
  name: 'current authority requirements: one generic requirement may retain distinct evidence across repeated source units',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const repeatedFirst = 'First responsibility: build reliable services with explicit operational ownership.';
      const repeatedSecond = 'Second responsibility: build reliable services with explicit operational ownership.';
      const queued = await queueLocalApplicationJob({
        transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId,
        job: { ...fixture.job, snippet: `Team overview only.\n${repeatedFirst}\nProduct narrative only.\n${repeatedSecond}\n` },
      });
      const handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath })).handoff;
      const context = contextOf(handoff);
      const source = context.requirementsProgress.sourceCoverage;
      const first = source.units.find(unit => unit.text.includes(repeatedFirst));
      const second = source.units.find(unit => unit.text.includes(repeatedSecond));
      assert(first && second && first.id !== second.id,
        'the frozen listing exposes two distinct immutable source units for the same generic operational requirement');
      const evidence = [
        { id: 'p1-e-ownership-a', sourceId: 'job-listing', quote: repeatedFirst, requirement: 'Reliable service ownership', priority: 'high' },
        { id: 'p1-e-ownership-b', sourceId: 'job-listing', quote: repeatedSecond, requirement: 'Reliable service ownership', priority: 'high' },
      ];
      const requirement = { id: 'p1-r-ownership', text: 'Reliable service ownership', priority: 'high', evidenceIds: evidence.map(item => item.id) };
      const accepted = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: handoff.handoffCode,
        response: JSON.stringify({
          protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes,
          storeDigest: context.authorityStore.digest, complete: true, identity: context.trustedIdentity,
          evidence, requirements: [requirement],
          nextUnitIndex: source.unitCount,
          coverage: source.units.map(unit => [first.id, second.id].includes(unit.id)
            ? { unitId: unit.id, disposition: 'requirement', requirementIds: [requirement.id] }
            : { unitId: unit.id, disposition: 'not-a-requirement', requirementIds: [] }),
        }),
      });
      assert(accepted.accepted && accepted.handoff?.stage === 'requirements-audit',
        `one requirement can be grounded in two distinct source units without merging their context (${JSON.stringify(accepted.validationErrors || [])})`);
      const store = await openAuthorityLedgerStore(path.join(fixture.root, '.local-ai', 'jobs', queued.id, 'context'), { namespace: 'application-authority' });
      const receiptPage = await store.getReceiptPage('requirements', 0);
      const coverage = receiptPage.records.find(record => record.kind === 'listing-coverage')?.receipt;
      const groundedRows = coverage.dispositions.filter(row => row.requirementIds.includes(requirement.id));
      assert(groundedRows.map(row => row.unitId).join(',') === `${first.id},${second.id}`
        && receiptPage.records.filter(record => record.kind === 'listing-evidence').length === 2,
      'the durable receipt preserves both independently grounded units for the generic requirement rather than collapsing source provenance');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority requirements: a long repeated requirement text remains scoped and duplicate-protected',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const reply = (handoff, fields) => JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields });
      let handoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath })).handoff;
      let context = contextOf(handoff);
      const firstSource = context.requirementsProgress.sourceCoverage;
      const firstUnit = firstSource.units.find(unit => unit.text === fixture.requirements[0]);
      const longText = `Operational requirement ${'x'.repeat(700)}`;
      const firstEvidence = { id: 'p1-e-long-a', sourceId: 'job-listing', quote: fixture.requirements[0], requirement: 'First long-text grounding', priority: 'high' };
      const firstRequirement = { id: 'p1-r-long-a', text: longText, priority: 'high', evidenceIds: [firstEvidence.id] };
      const first = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: handoff.handoffCode,
        response: reply(handoff, {
          storeDigest: context.authorityStore.digest, complete: false, identity: context.trustedIdentity,
          evidence: [firstEvidence], requirements: [firstRequirement],
          ...coverageFor(context, [firstEvidence], [firstRequirement], firstSource.unitStart + firstSource.units.indexOf(firstUnit) + 1),
        }),
      });
      assert(first.accepted && first.handoff?.stage === 'requirements',
        'a long requirement text is accepted once and its short scoped index key is persisted');
      handoff = first.handoff; context = contextOf(handoff);
      const secondSource = context.requirementsProgress.sourceCoverage;
      const secondUnit = secondSource.units.find(unit => unit.text === fixture.requirements[1]);
      const secondEvidence = { id: 'p1-e-long-b', sourceId: 'job-listing', quote: fixture.requirements[1], requirement: 'Second long-text grounding', priority: 'high' };
      const secondRequirement = { id: 'p1-r-long-b', text: longText, priority: 'high', evidenceIds: [secondEvidence.id] };
      const duplicate = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: handoff.handoffCode,
        response: reply(handoff, {
          storeDigest: context.authorityStore.digest, complete: false, identity: context.trustedIdentity,
          evidence: [secondEvidence], requirements: [secondRequirement],
          ...coverageFor(context, [secondEvidence], [secondRequirement], secondSource.unitStart + secondSource.units.indexOf(secondUnit) + 1),
        }),
      });
      assert(!duplicate.accepted
        && duplicate.validationErrors.some(error => /exactly duplicates an earlier accepted requirement/i.test(error))
        && duplicate.handoff?.freshContextKey === handoff.freshContextKey,
      'the fixed-size scoped requirement-text key rejects a repeated value beyond the ledger index-key byte ceiling');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority requirements audit: a V3 disagreement receives an isolated adjudication and converges without leaking source text',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const { handoff: auditHandoff, evidence, requirements, reply } = await completeRequirementsDiscovery({ fixture, queued });
      assert(auditHandoff.stage === 'requirements-audit', 'complete immutable discovery enters the independent audit before candidate matching');

      const malformed = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: auditHandoff.handoffCode,
        response: reply(auditHandoff, {
          storeDigest: contextOf(auditHandoff).authorityStore.digest,
          auditDigest: contextOf(auditHandoff).auditDigest,
          rows: { malformed: true },
        }),
      });
      assert(!malformed.accepted
        && malformed.validationErrors.every(error => error.startsWith('requirements-audit-schema-rows:'))
        && malformed.handoff?.stage === 'requirements-audit'
        && typeof malformed.handoff?.correctionPrompt === 'string',
      'malformed audit rows remain a typed structural schema correction, not semantic evidence');

      const auditContext = contextOf(malformed.handoff);
      const discoveryAudit = semanticAuditFor(auditContext, evidence, requirements);
      const disagreement = structuredClone(discoveryAudit);
      disagreement.rows[0] = {
        ...disagreement.rows[0],
        disposition: disagreement.rows[0].disposition === 'requirement' ? 'not-a-requirement' : 'requirement',
      };
      const adjudication = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: malformed.handoff.handoffCode,
        response: reply(malformed.handoff, disagreement),
      });
      assert(adjudication.accepted && !adjudication.completed && !adjudication.terminal
        && adjudication.handoff?.stage === 'requirements-adjudication' && adjudication.localJob.status === 'queued',
      'a structurally valid V3 audit disagreement opens a third independent adjudication instead of a terminal failure');

      let adjudicationHandoff = adjudication.handoff;
      let adjudicationContext = contextOf(adjudicationHandoff);
      const adjudicationKey = adjudicationHandoff.freshContextKey;
      const disputedText = adjudicationContext.cases?.[0]?.text;
      assert(adjudicationHandoff.freshContextRequired === true
        && /^authority-requirements-adjudication-[a-f0-9]{64}$/u.test(adjudicationKey)
        && adjudicationKey !== malformed.handoff.freshContextKey
        && Object.keys(adjudicationContext).join(',') === 'storeDigest,caseDigest,cases'
        && !adjudicationHandoff.prompt.includes('candidateEvidenceIds')
        && !adjudicationHandoff.prompt.includes('discovery classifications')
        && !adjudicationHandoff.prompt.includes('audit classifications')
        && typeof disputedText === 'string' && disputedText,
      'the adjudicator receives only the opaque case, disputed source, unlabeled neighbors, and a fresh private context');

      const malformedAdjudication = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: adjudicationHandoff.handoffCode,
        response: reply(adjudicationHandoff, { storeDigest: adjudicationContext.storeDigest, caseDigest: adjudicationContext.caseDigest, rows: { malformed: true } }),
      });
      assert(!malformedAdjudication.accepted
        && malformedAdjudication.validationErrors.every(error => error.startsWith('requirements-adjudication-schema-rows:'))
        && malformedAdjudication.handoff?.stage === 'requirements-adjudication'
        && malformedAdjudication.handoff.freshContextKey === adjudicationKey,
      'malformed adjudication rows stay in the same third-context schema repair');

      adjudicationHandoff = malformedAdjudication.handoff;
      adjudicationContext = contextOf(adjudicationHandoff);
      const staleAdjudication = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: adjudicationHandoff.handoffCode,
        response: reply(adjudicationHandoff, {
          storeDigest: '0'.repeat(64), caseDigest: adjudicationContext.caseDigest,
          rows: [{ unitId: adjudicationContext.cases[0].unitId, disposition: discoveryAudit.rows.find(row => row.unitId === adjudicationContext.cases[0].unitId).disposition }],
        }),
      });
      assert(!staleAdjudication.accepted
        && staleAdjudication.validationErrors.every(error => error.startsWith('requirements-adjudication-schema-envelope:'))
        && staleAdjudication.handoff?.freshContextKey === adjudicationKey,
      'a stale disagreement-era store binding cannot be replayed into adjudication');

      adjudicationHandoff = staleAdjudication.handoff;
      adjudicationContext = contextOf(adjudicationHandoff);
      let converged = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: adjudicationHandoff.handoffCode,
        response: reply(adjudicationHandoff, {
          storeDigest: adjudicationContext.storeDigest, caseDigest: adjudicationContext.caseDigest,
          rows: adjudicationContext.cases.map(caseUnit => ({
            unitId: caseUnit.unitId,
            disposition: discoveryAudit.rows.find(row => row.unitId === caseUnit.unitId).disposition,
          })),
        }),
      });
      assert(converged.accepted && !converged.terminal && converged.handoff
        && ['requirements-audit', 'write'].includes(converged.handoff.stage),
      'an adjudicator that sides with discovery appends a canonical effective audit and continues normally');
      while (converged.handoff?.stage === 'requirements-audit') {
        const continuedContext = contextOf(converged.handoff);
        converged = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: converged.handoff.handoffCode,
          response: reply(converged.handoff, semanticAuditFor(continuedContext, evidence, requirements)),
        });
        assert(converged.accepted && converged.handoff, 'remaining independent audit pages continue after a convergent adjudication');
      }
      assert(converged.handoff?.stage === 'write', 'convergent adjudication completes independent audit before matching');

      const manifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
      const persistedPaste = JSON.stringify(manifest.paste);
      const log = await fs.promises.readFile(path.join(queued.folder, 'Generation Log.jsonl'), 'utf8');
      assert(manifest.status === 'queued'
        && manifest.paste.stage === 'write'
        && !Object.hasOwn(manifest.paste, 'authorityAdjudication')
        && !persistedPaste.includes(disputedText) && !log.includes(disputedText),
      'the durable continuation stores only adjudication metadata, never disputed or neighboring source text');

      const store = await openAuthorityLedgerStore(path.join(fixture.root, '.local-ai', 'jobs', queued.id, 'context'), { namespace: 'application-authority' });
      const receipt = store.receipt();
      const disagreementStream = receipt.streams['requirements-audit-disagreements'];
      const disagreementPage = await store.getReceiptPage('requirements-audit-disagreements', 0);
      assert(receipt.streams.requirements.count === fixture.requirements.length
        && receipt.streams['requirements-audit'].count >= 1
        && disagreementStream.count === 1
        && disagreementPage.records.length === 1
        && disagreementPage.records[0].kind === 'listing-semantic-disagreement'
        && disagreementPage.records[0].receipt.rows.every(row => !Object.hasOwn(row, 'text')),
      'the immutable disagreement and effective audit receipts preserve source privacy while allowing matching to begin');

      const reopened = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath });
      assert(reopened.handoff?.stage === 'write' && reopened.localJob.status === 'queued',
      'restart replays the effective adjudication provenance and resumes matching rather than terminalizing the job');

      const status = await localApplicationStatus(queued.id, fixture.canvasFilePath);
      const source = createApplicationSource({ api: { localApplicationStatus: async () => status } });
      const bridged = await source.status({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath });
      assert(status.status === 'queued' && bridged.kind === 'awaiting',
      'the persisted continuation remains live to status and bridge routing');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority requirements adjudication: status serializes behind a held submit even when a queued observer fails',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    let releaseJournal = null;
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const epochZero = await completeRequirementsDiscovery({ fixture, queued });
      const auditContext = contextOf(epochZero.handoff);
      const discoveryAudit = semanticAuditFor(auditContext, epochZero.evidence, epochZero.requirements);
      const disagreement = structuredClone(discoveryAudit);
      disagreement.rows[0] = {
        ...disagreement.rows[0],
        disposition: disagreement.rows[0].disposition === 'requirement' ? 'not-a-requirement' : 'requirement',
      };
      const opened = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: epochZero.handoff.handoffCode,
        response: epochZero.reply(epochZero.handoff, disagreement),
      });
      assert(opened.accepted && opened.handoff?.stage === 'requirements-adjudication',
        'the concurrency fixture reaches a V3 adjudication before holding its effective-audit append');

      const contextDir = path.join(queued.folder, 'context');
      const manifestPath = path.join(queued.folder, 'manifest.json');
      const rootPath = path.join(contextDir, 'application-authority.root.json');
      const journalPath = path.join(contextDir, 'application-authority.journal.json');
      const beforeManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      const adjudicationContext = contextOf(opened.handoff);
      const response = epochZero.reply(opened.handoff, {
        storeDigest: adjudicationContext.storeDigest,
        caseDigest: adjudicationContext.caseDigest,
        rows: adjudicationContext.cases.map(caseUnit => ({
          unitId: caseUnit.unitId,
          disposition: discoveryAudit.rows.find(row => row.unitId === caseUnit.unitId).disposition,
        })),
      });

      let journalPublishedResolve;
      const journalPublished = new Promise(resolve => { journalPublishedResolve = resolve; });
      const journalRelease = new Promise(resolve => { releaseJournal = resolve; });
      let intercepted = false;
      __setAuthorityLedgerStoreFaultHookForTests(async step => {
        if (step !== 'journal-published' || intercepted) return;
        intercepted = true;
        journalPublishedResolve();
        await journalRelease;
      });
      const lockEvents = [];
      let queuedNotifications = 0;
      let queuedObserverFailed = false;
      __setLocalAiJobMutationLockObserverForTests(event => {
        if (event.jobId !== queued.id) return;
        lockEvents.push(event.phase);
        if (event.phase === 'queued') {
          queuedNotifications += 1;
          // A owns the held submit; B throws while only queued; C must stay
          // behind both rather than seeing an empty tail map and entering A.
          if (queuedNotifications === 2) {
            queuedObserverFailed = true;
            throw new Error('synthetic queued observer failure');
          }
        }
      });

      const submitPromise = submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: opened.handoff.handoffCode, response,
      });
      await journalPublished;
      const pendingJournal = JSON.parse(await fs.promises.readFile(journalPath, 'utf8'));
      const heldRoot = JSON.parse(await fs.promises.readFile(rootPath, 'utf8'));
      const previousReferences = authorityRootPageReferences(pendingJournal.previousState);
      const introducedReferences = [...authorityRootPageReferences(pendingJournal.nextState)]
        .filter(file => !previousReferences.has(file));
      assert(pendingJournal.hold === true
        && pendingJournal.previous === beforeManifest.paste.authorityStore.digest
        && pendingJournal.nextState.revision === pendingJournal.previousState.revision + 1
        && heldRoot.digest === pendingJournal.previous
        && pendingJournal.nextState.streams['requirements-audit']?.count === 1
        && introducedReferences.includes('requirements-audit-000000000000.json')
        && introducedReferences.includes('index-requirements-audit-000000000000-000000000001.json'),
      'the held boundary is the exact journal-before-root effective-audit transaction that the live failure exposed');
      await assertAuthorityRootReferencesExist(contextDir, pendingJournal.nextState,
        'every next-root page, index peak, and ID bucket exists before the writer is released');

      let failedStatusSettled = false;
      const rejectedStatusPromise = localApplicationStatus(queued.id, fixture.canvasFilePath).then(
        () => { failedStatusSettled = true; return null; },
        error => { failedStatusSettled = true; return error; },
      );
      const statusPromise = localApplicationStatus(queued.id, fixture.canvasFilePath);
      assert(queuedObserverFailed && !failedStatusSettled
        && lockEvents.join(',') === 'queued,acquired,queued,queued',
      'B retains its tail after a queued-observer failure and C still queues behind the held submit');
      assert(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')).paste.authorityStore.digest === pendingJournal.previous,
        'the manifest remains at the previous receipt while status is queued, exercising the stale pre-lock snapshot boundary');

      releaseJournal(); releaseJournal = null;
      const [committed, observerError, status] = await Promise.all([submitPromise, rejectedStatusPromise, statusPromise]);
      const committedManifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      const committedRoot = JSON.parse(await fs.promises.readFile(rootPath, 'utf8'));
      const journalGone = await fs.promises.lstat(journalPath).then(() => false, error => error?.code === 'ENOENT');
      for (const file of introducedReferences) {
        const exists = await fs.promises.lstat(path.join(contextDir, 'application-authority-pages', file))
          .then(stat => stat.isFile() && !stat.isSymbolicLink(), () => false);
        assert(exists, `the committed held-transaction capability remains present (${file})`);
      }
      await assertAuthorityRootReferencesExist(contextDir, committedRoot,
        'the committed root has every advertised page, index peak, and ID bucket after the overlapping status completes');
      const reopened = await openAuthorityLedgerStore(contextDir, { namespace: 'application-authority' });
      assert(committed.accepted && committed.handoff?.stage === 'write'
        && observerError?.message === 'synthetic queued observer failure'
        && status.status === 'queued' && status.stage === committedManifest.paste.stage
        && status.revision === committedManifest.paste.revision
        && status.revision === committed.localJob.revision
        && committedManifest.paste.authorityStore.digest === committedRoot.digest
        && committedManifest.paste.authorityStore.revision === committedRoot.revision
        && reopened.receipt().digest === committedRoot.digest
        && journalGone
        && lockEvents.join(',') === 'queued,acquired,queued,queued,released,released,acquired,released',
      'A commits before B reports its observer failure; C then reads the post-lock manifest and the finalized store has no orphaned root');
    } finally {
      releaseJournal?.();
      __setAuthorityLedgerStoreFaultHookForTests(null);
      __setLocalAiJobMutationLockObserverForTests(null);
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority status: a throwing lock observer cannot retain the per-job queue',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({
        transport: 'paste', canvasFilePath: fixture.canvasFilePath,
        careerSnapshotId: fixture.snapshotId, job: fixture.job,
      });
      let threw = false;
      __setLocalAiJobMutationLockObserverForTests(event => {
        if (!threw && event.jobId === queued.id && event.phase === 'acquired') {
          threw = true;
          throw new Error('synthetic lock observer failure');
        }
      });
      let observerError = null;
      try {
        await localApplicationStatus(queued.id, fixture.canvasFilePath);
      } catch (error) {
        observerError = error;
      }
      assert(threw && observerError?.message === 'synthetic lock observer failure',
        'the test-only observer failure reaches its caller instead of being hidden');

      __setLocalAiJobMutationLockObserverForTests(null);
      const recovered = await localApplicationStatus(queued.id, fixture.canvasFilePath);
      assert(recovered.status === 'queued' && recovered.id === queued.id,
        'a failed observer releases the reserved per-job tail, so the next status poll can run');
    } finally {
      __setLocalAiJobMutationLockObserverForTests(null);
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority requirements audit: a frozen V2 disagreement retains its published terminal behavior',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    let queued = null;
    try {
      __setQueuedCurrentAuthorityProtocolForTests('requirements-ledger.v2');
      queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      __setQueuedCurrentAuthorityProtocolForTests(null);
      const epochZero = await completeRequirementsDiscovery({ fixture, queued });
      const auditContext = contextOf(epochZero.handoff);
      const disagreement = semanticAuditFor(auditContext, epochZero.evidence, epochZero.requirements);
      disagreement.rows[0] = {
        ...disagreement.rows[0],
        disposition: disagreement.rows[0].disposition === 'requirement' ? 'not-a-requirement' : 'requirement',
      };
      const terminal = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: epochZero.handoff.handoffCode,
        response: epochZero.reply(epochZero.handoff, disagreement),
      });
      assert(terminal.accepted && terminal.completed && terminal.terminal && terminal.handoff === null
        && terminal.localJob.status === 'failed' && !terminal.validationErrors,
      'the published V2 protocol retains terminal-on-disagreement semantics');
      const manifest = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'manifest.json'), 'utf8'));
      assert(manifest.status === 'failed'
        && manifest.paste.stage === 'requirements-audit-disagreement'
        && manifest.paste.terminal?.kind === 'requirements-audit-disagreement'
        && !Object.hasOwn(manifest.paste, 'authorityAdjudication'),
      'the frozen V2 manifest stays in its historical terminal shape rather than acquiring V3 adjudication metadata');
      const reopened = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath });
      const replay = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: epochZero.handoff.handoffCode, response: '{}',
      });
      const status = await localApplicationStatus(queued.id, fixture.canvasFilePath);
      assert(reopened.completed && reopened.terminal && reopened.handoff === null
        && replay.accepted && replay.completed && replay.terminal
        && status.status === 'failed' && status.message.includes('Generate a new application'),
      'V2 status, reopen, and stale replay all retain the actionable terminal result');
    } finally {
      __setQueuedCurrentAuthorityProtocolForTests(null);
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority requirements adjudication: a tampered async V3 history becomes a terminal frozen-state fault',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const epochZero = await completeRequirementsDiscovery({ fixture, queued });
      const auditContext = contextOf(epochZero.handoff);
      const disagreement = semanticAuditFor(auditContext, epochZero.evidence, epochZero.requirements);
      disagreement.rows[0] = {
        ...disagreement.rows[0],
        disposition: disagreement.rows[0].disposition === 'requirement' ? 'not-a-requirement' : 'requirement',
      };
      const opened = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: epochZero.handoff.handoffCode,
        response: epochZero.reply(epochZero.handoff, disagreement),
      });
      assert(opened.accepted && opened.handoff?.stage === 'requirements-adjudication',
        'the fixture reaches a live V3 immutable-adjudication history before its frozen pointer is tampered');

      const manifestPath = path.join(queued.folder, 'manifest.json');
      const tampered = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      tampered.paste.authorityAdjudication.caseDigest = '0'.repeat(64);
      await fs.promises.writeFile(manifestPath, `${JSON.stringify(tampered)}\n`, 'utf8');

      const status = await localApplicationStatus(queued.id, fixture.canvasFilePath);
      let reopenError = null;
      try {
        await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath });
      } catch (error) {
        reopenError = error;
      }
      const recorded = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
      assert(status.status === 'failed' && status.stage === 'requirements-adjudication'
        && reopenError?.code === 'LOCAL_AI_JOB_INTEGRITY'
        && recorded.status === 'failed' && recorded.paste?.handoffCode === null
        && typeof recorded.paste?.integrityFault?.message === 'string',
      'an async immutable-history replay failure is wrapped as terminal job integrity on status and reopen, not exposed as a retryable raw IPC error');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority requirements adjudication: an audit-sided V3 case starts a fresh epoch with isolated requirement and audit streams',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const firstRequirements = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath })).handoff;
      const requirementsEpochZeroKey = firstRequirements.freshContextKey;
      const epochZero = await completeRequirementsDiscovery({ fixture, queued });
      const auditEpochZeroKey = epochZero.handoff.freshContextKey;
      const auditContext = contextOf(epochZero.handoff);
      const discoveryAudit = semanticAuditFor(auditContext, epochZero.evidence, epochZero.requirements);
      const disagreement = structuredClone(discoveryAudit);
      disagreement.rows[0] = {
        ...disagreement.rows[0],
        disposition: disagreement.rows[0].disposition === 'requirement' ? 'not-a-requirement' : 'requirement',
      };
      const opened = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: epochZero.handoff.handoffCode,
        response: epochZero.reply(epochZero.handoff, disagreement),
      });
      assert(opened.accepted && opened.handoff?.stage === 'requirements-adjudication',
        'an epoch-zero disagreement opens the isolated adjudicator before any candidate matching work');
      const adjudicationKey = opened.handoff.freshContextKey;
      const adjudicationContext = contextOf(opened.handoff);
      const reset = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: opened.handoff.handoffCode,
        response: epochZero.reply(opened.handoff, {
          storeDigest: adjudicationContext.storeDigest,
          caseDigest: adjudicationContext.caseDigest,
          rows: adjudicationContext.cases.map(caseUnit => ({
            unitId: caseUnit.unitId,
            disposition: disagreement.rows.find(row => row.unitId === caseUnit.unitId).disposition,
          })),
        }),
      });
      assert(reset.accepted && reset.handoff?.stage === 'requirements'
        && reset.handoff.freshContextRequired === true
        && reset.handoff.freshContextKey !== requirementsEpochZeroKey
        && reset.handoff.freshContextKey !== auditEpochZeroKey
        && reset.handoff.freshContextKey !== adjudicationKey,
      'an audit-sided classification atomically selects a distinct fresh requirements epoch rather than patching old rows');
      const epochOneContext = contextOf(reset.handoff);
      assert(epochOneContext.requirementsProgress.epoch === 1
        && epochOneContext.requirementsProgress.requirementsStream === 'requirements-e1'
        && !reset.handoff.prompt.includes('p1-r-'),
      'epoch one starts at immutable unit zero in requirements-e1 without showing epoch-zero discovery IDs');

      const replayed = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath });
      assert(replayed.handoff?.stage === 'requirements'
        && contextOf(replayed.handoff).requirementsProgress.epoch === 1
        && replayed.handoff.freshContextKey === reset.handoff.freshContextKey,
      'restart reconstructs the host-selected active epoch and its private discovery context from immutable receipts');

      const epochOne = await completeRequirementsDiscovery({ fixture, queued, epoch: 1 });
      const auditEpochOneKey = epochOne.handoff.freshContextKey;
      assert(epochOne.handoff.stage === 'requirements-audit'
        && auditEpochOneKey !== auditEpochZeroKey,
      'the epoch-one independent audit receives a distinct fresh context, so it cannot reuse the epoch-zero audit chat');
      let converged = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: epochOne.handoff.handoffCode,
        response: epochOne.reply(epochOne.handoff, semanticAuditFor(contextOf(epochOne.handoff), epochOne.evidence, epochOne.requirements)),
      });
      while (converged.handoff?.stage === 'requirements-audit') {
        converged = await submitLocalApplicationHandoff({
          jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: converged.handoff.handoffCode,
          response: epochOne.reply(converged.handoff, semanticAuditFor(contextOf(converged.handoff), epochOne.evidence, epochOne.requirements)),
        });
      }
      assert(converged.accepted && converged.handoff?.stage === 'write',
        'fresh discovery and fresh independent audit both complete before epoch-one writing can begin');
      assert(converged.handoff.prompt.includes('e1-p1-r-'),
        'the active writer receives epoch-one requirement IDs');

      const store = await openAuthorityLedgerStore(path.join(fixture.root, '.local-ai', 'jobs', queued.id, 'context'), { namespace: 'application-authority' });
      const receipt = store.receipt();
      assert(receipt.streams.requirements.count === fixture.requirements.length
        && receipt.streams['requirements-e1'].count === fixture.requirements.length
        && receipt.streams['requirements-audit-e1'].count >= 1
        && receipt.streams['requirements-epochs'].count === 1
        && receipt.streams['requirements-adjudications'].count === 1,
      'the durable epoch pointer and adjudication receipt select a new stream without rewriting the old immutable requirements stream');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'current authority requirements adjudication: repeated audit disputes are repairable and signed bindings advance',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const epochZero = await completeRequirementsDiscovery({ fixture, queued });
      const firstAudit = semanticAuditFor(contextOf(epochZero.handoff), epochZero.evidence, epochZero.requirements);
      firstAudit.rows[0].disposition = firstAudit.rows[0].disposition === 'requirement' ? 'not-a-requirement' : 'requirement';
      const opened = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: epochZero.handoff.handoffCode, response: epochZero.reply(epochZero.handoff, firstAudit) });
      assert(opened.accepted && opened.handoff?.stage === 'requirements-adjudication', 'first independent dispute reaches adjudication');
      const adjudicationContext = contextOf(opened.handoff);
      const reset = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: opened.handoff.handoffCode, response: epochZero.reply(opened.handoff, {
          storeDigest: adjudicationContext.storeDigest, caseDigest: adjudicationContext.caseDigest,
          rows: adjudicationContext.cases.map(unit => ({ unitId: unit.unitId,
            disposition: firstAudit.rows.find(row => row.unitId === unit.unitId).disposition })),
        }) });
      assert(reset.accepted && reset.handoff?.stage === 'requirements', 'audit-sided adjudication opens one new epoch');
      const epochOne = await completeRequirementsDiscovery({ fixture, queued, epoch: 1 });
      const secondAudit = semanticAuditFor(contextOf(epochOne.handoff), epochOne.evidence, epochOne.requirements);
      const disputedId = firstAudit.rows[0].unitId;
      const repeated = secondAudit.rows.find(row => row.unitId === disputedId);
      assert(!!repeated, 'the prior disputed unit is present in the second independent audit');
      repeated.disposition = repeated.disposition === 'requirement' ? 'not-a-requirement' : 'requirement';
      let continued = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: epochOne.handoff.handoffCode, response: epochOne.reply(epochOne.handoff, secondAudit) });
      assert(!continued.accepted && continued.validationErrors.some(error => /binding disposition/.test(error)),
        'a contradictory audit is repairable rather than an application terminal');
      const malformed = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: epochOne.handoff.handoffCode, response: epochOne.reply(epochOne.handoff, { ...secondAudit, rows: [null] }) });
      assert(!malformed.accepted && malformed.validationErrors.length > 0, 'malformed audit rows return repairable schema errors');
      assert(contextOf(epochOne.handoff).bindingRows.some(row => row.unitId === disputedId),
        'the audit prompt includes the signed independent decision');
      repeated.disposition = firstAudit.rows[0].disposition;
      continued = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: epochOne.handoff.handoffCode, response: epochOne.reply(epochOne.handoff, secondAudit) });
      assert(continued.accepted && !continued.terminal, 'correcting the binding advances without a fresh generation');
      while (continued.handoff?.stage === 'requirements-audit') {
        const context = contextOf(continued.handoff);
        continued = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
          handoffCode: continued.handoff.handoffCode, response: epochOne.reply(continued.handoff,
            semanticAuditFor(context, epochOne.evidence, epochOne.requirements)) });
      }
      const status = await localApplicationStatus(queued.id, fixture.canvasFilePath);
      assert(continued.accepted && continued.handoff?.stage === 'write' && status.status === 'queued',
        'the binding survives audit replay and allows the job to write');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}, {
  name: 'requirements audits converge past two epochs and recover a legacy capped job without changing source receipts',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath,
        careerSnapshotId: fixture.snapshotId, job: fixture.job });
      for (let epoch = 0; epoch < 3; epoch += 1) {
        const discovery = await completeRequirementsDiscovery({ fixture, queued, epoch });
        const context = contextOf(discovery.handoff);
        const audit = semanticAuditFor(context, discovery.evidence, discovery.requirements);
        const boundIds = new Set((context.bindingRows || []).map(row => row.unitId));
        const novel = audit.rows.filter(row => !boundIds.has(row.unitId) && context.units.find(unit => unit.id === row.unitId)?.text.trim()).slice(0, 2);
        assert(novel.length === 2, 'fixture has two new disputed source units');
        for (const row of novel) row.disposition = row.disposition === 'requirement' ? 'not-a-requirement' : 'requirement';
        if (epoch === 1) {
          const repeated = audit.rows.filter(row => boundIds.has(row.unitId)).slice(0, 2);
          const prior = repeated.map(row => row.disposition);
          for (const row of repeated) row.disposition = row.disposition === 'requirement' ? 'not-a-requirement' : 'requirement';
          const mixed = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
            handoffCode: discovery.handoff.handoffCode, response: discovery.reply(discovery.handoff, audit) });
          assert(!mixed.accepted && !mixed.terminal && mixed.validationErrors.filter(error => /binding disposition/.test(error)).length === 2,
            'mixed novel and repeated multi-unit disputes preserve bindings through repair');
          repeated.forEach((row, index) => { row.disposition = prior[index]; });
        }
        let opened = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
          handoffCode: discovery.handoff.handoffCode, response: discovery.reply(discovery.handoff, audit) });
        assert(opened.accepted && opened.handoff?.stage === 'requirements-adjudication' && !opened.terminal,
          `novel multi-unit disagreements are adjudicated at epoch ${epoch}`);
        if (epoch === 2) {
          // Recreate the old host-authored terminal around the real signed
          // disagreement. Recovery must preserve that store, not regenerate.
          const file = path.join(queued.folder, 'manifest.json');
          const manifest = JSON.parse(await fs.promises.readFile(file, 'utf8'));
          const receipt = JSON.stringify(manifest.paste.authorityStore);
          manifest.status = 'failed';
          manifest.paste.stage = 'requirements-audit-disagreement';
          manifest.paste.terminal = requirementsAuditCapTerminal(epoch, novel.map(row => row.unitId));
          manifest.paste.handoffCode = null;
          delete manifest.paste.authorityAdjudication;
          await fs.promises.writeFile(file, JSON.stringify(manifest));
          opened = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath });
          assert(opened.handoff?.stage === 'requirements-adjudication' && opened.localJob.status === 'queued',
            'legacy capped application reopens its exact pending case');
          const recovered = JSON.parse(await fs.promises.readFile(file, 'utf8'));
          assert(JSON.stringify(recovered.paste.authorityStore) === receipt && !recovered.paste.terminal,
            'recovery preserves the immutable source store and removes only the obsolete stop');
        }
        const adjudication = contextOf(opened.handoff);
        const reset = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
          handoffCode: opened.handoff.handoffCode, response: discovery.reply(opened.handoff, {
            storeDigest: adjudication.storeDigest, caseDigest: adjudication.caseDigest,
            rows: adjudication.cases.map(unit => ({ unitId: unit.unitId,
              disposition: audit.rows.find(row => row.unitId === unit.unitId).disposition })),
          }) });
        if (epoch < 2) {
          assert(reset.accepted && reset.handoff?.stage === 'requirements', `a new signed decision at epoch ${epoch} opens a fresh discovery epoch`);
          continue;
        }
        // At the re-epoch cap the audit-sided verdict overrides this page's
        // audit instead of opening epoch 3.
        assert(reset.accepted && !reset.terminal && ['requirements-audit', 'write'].includes(reset.handoff?.stage),
          `the capped audit-sided decision proceeds without a new epoch (${reset.handoff?.stage})`);
        let handoff = reset.handoff;
        while (handoff?.stage === 'requirements-audit') {
          const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
            handoffCode: handoff.handoffCode, response: discovery.reply(handoff,
              semanticAuditFor(contextOf(handoff), discovery.evidence, discovery.requirements)) });
          assert(accepted.accepted, 'all signed decisions survive receipt replay');
          handoff = accepted.handoff;
        }
        assert(handoff?.stage === 'write', 'the recovered job converges to document writing');
        const store = await openAuthorityLedgerStore(path.join(queued.folder, 'context'), { namespace: 'application-authority' });
        const streams = store.receipt().streams;
        const overridePage = await store.getReceiptPage('requirements-audit-e2', 0);
        assert(streams['requirements-epochs'].count === 2 && streams['requirements-adjudications'].count === 2
          && !streams['requirements-e3'] && !streams['requirements-audit-e3']
          && overridePage.records.length === 2 && overridePage.records[0].kind === 'requirements-adjudication'
          && overridePage.records[1].receipt.capOverride?.epoch === 2 && overridePage.records[1].receipt.capOverride?.maxReEpochs === 2
          && [...overridePage.records[1].receipt.capOverride.unitIds].sort().join(',') === novel.map(row => row.unitId).sort().join(','),
        'the cap override records the adjudication and an overriding effective audit in the epoch-2 audit stream, never epoch 3');
        await assertReplays({ fixture, queued, stage: 'write', label: 'legacy capped job after override' });
      }
    } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
  },
}, {
  name: 'requirements re-epoch carries discovery pages before the disputed window and carries agreed audits without serving them',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture({ longListing: true });
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath,
        careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const { epochZero, reset } = await longListingToEpochOne({ fixture, queued });
      const resetSource = contextOf(reset.handoff).requirementsProgress.sourceCoverage;
      assert(contextOf(reset.handoff).requirementsProgress.epoch === 1 && resetSource.unitStart === 41
        && resetSource.units[0].text === fixture.unitTexts[41],
      'the new epoch resumes discovery at the first page overlapping the disputed window (unit 41), not at unit zero');
      const contextDir = path.join(queued.folder, 'context');
      let store = await openAuthorityLedgerStore(contextDir, { namespace: 'application-authority' });
      assert(store.receipt().streams['requirements-e1']?.count === 2 && store.receipt().streams.requirements.count === 6,
        'exactly the two discovery pages wholly before audit window [64,128) are carried into requirements-e1');
      for (let number = 0; number < 2; number += 1) {
        const original = await store.getReceiptPage('requirements', number);
        const carried = await store.getReceiptPage('requirements-e1', number);
        assert(carried.records.map(record => record.id).join('|') === original.records.map(record => record.id).join('|')
          && carried.records.map(record => record.kind).join('|') === original.records.map(record => record.kind).join('|'),
        `carried discovery page ${number} keeps its original record ids`);
        const originalRequirement = original.records.find(record => record.kind === 'requirement');
        const carriedRequirement = carried.records.find(record => record.kind === 'requirement');
        assert(carriedRequirement && JSON.stringify(carriedRequirement.item) === JSON.stringify(originalRequirement.item)
          && carriedRequirement.indexKeys.length === originalRequirement.indexKeys.length
          && carriedRequirement.indexKeys.every((key, index) => key !== originalRequirement.indexKeys[index]),
        `carried discovery page ${number} copies items verbatim but re-scopes every index key to requirements-e1`);
      }
      await assertReplays({ fixture, queued, stage: 'requirements', label: 'after the discovery prefix carry' });

      const epochOne = await completeRequirementsDiscovery({ fixture, queued, epoch: 1, prior: epochZero });
      assert(epochOne.resumeUnit === 41 && epochOne.firstRemaining === 2,
        'epoch one re-extracts only the overlapping and later windows');
      store = await openAuthorityLedgerStore(contextDir, { namespace: 'application-authority' });
      assert(store.receipt().streams['requirements-e1'].count === 6,
        'two carried plus four re-extracted discovery pages complete requirements-e1');
      const firstAudit = contextOf(epochOne.handoff);
      assert(epochOne.handoff.stage === 'requirements-audit' && firstAudit.units[0].text === fixture.unitTexts[64],
        'no requirements-audit handoff is served for the carried window; the live audit resumes at the disputed page');
      const carriedAudit = await store.getReceiptPage('requirements-audit-e1', 0);
      const carriedFrom = carriedAudit.records[0]?.receipt?.carriedFrom;
      assert(store.receipt().streams['requirements-audit-e1'].count === 1
        && carriedAudit.records.length === 1 && carriedAudit.records[0].kind === 'listing-semantic-audit'
        && carriedFrom?.epoch === 0 && carriedFrom?.auditStream === 'requirements-audit' && carriedFrom?.pageIndex === 0
        && Object.keys(carriedFrom).length === 3,
      `the epoch-one audit page before the disputed window is a carriedFrom receipt pointing at the agreeing epoch-zero page (${store.receipt().streams['requirements-audit-e1'].count}, ${carriedAudit.records.length}, ${JSON.stringify(carriedFrom)})`);
      const log = await readGenerationLog(queued);
      const carriedEvents = log.filter(event => event.type === 'authority-requirements-audit-carried');
      assert(carriedEvents.length === 1 && carriedEvents[0].epoch === 1 && carriedEvents[0].pageIndex === 0 && carriedEvents[0].fromEpoch === 0
        && Object.keys(carriedEvents[0]).sort().join(',') === 'at,epoch,fromEpoch,jobId,pageIndex,revision,sequence,stage,type',
      'the carried audit is logged as one metadata-only lifecycle event');
      const sequences = log.filter(event => Number.isSafeInteger(event.sequence)).map(event => event.sequence);
      assert(sequences.length > 1 && sequences.every((value, index) => index === 0 || value > sequences[index - 1]),
        'generation-log sequence numbers stay strictly monotonic across carried events');
      await assertReplays({ fixture, queued, stage: 'requirements-audit', label: 'after audit carry-forward' });

      let handoff = epochOne.handoff;
      while (handoff?.stage === 'requirements-audit') {
        const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
          handoffCode: handoff.handoffCode, response: epochOne.reply(handoff, semanticAuditFor(contextOf(handoff), epochOne.evidence, epochOne.requirements)) });
        assert(accepted.accepted, `epoch-one audit page is accepted (${JSON.stringify(accepted.validationErrors || [])})`);
        handoff = accepted.handoff;
      }
      assert(handoff?.stage === 'write', 'the carried epoch converges to writing');
      await assertReplays({ fixture, queued, stage: 'write', label: 'after the carried epoch reaches write' });
    } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
  },
}, {
  name: 'requirements re-epoch cap: a third audit-sided adjudication overrides the page audit and reaches write',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture({ longListing: true });
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath,
        careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const { epochZero } = await longListingToEpochOne({ fixture, queued });
      const epochOne = await completeRequirementsDiscovery({ fixture, queued, epoch: 1, prior: epochZero });
      const secondReset = await disputeLiveAuditWindow({ fixture, queued, discovery: epochOne, unitIndex: 90 });
      assert(secondReset.accepted && secondReset.handoff?.stage === 'requirements'
        && contextOf(secondReset.handoff).requirementsProgress.epoch === 2,
      'a second audit-sided verdict opens epoch two');
      await assertReplays({ fixture, queued, stage: 'requirements', label: 'after the second re-epoch' });
      const epochTwo = await completeRequirementsDiscovery({ fixture, queued, epoch: 2, prior: epochOne });
      assert(epochTwo.resumeUnit === 41 && contextOf(epochTwo.handoff).units[0].text === fixture.unitTexts[64],
        'epoch two also carries the discovery prefix and the agreed first audit window');
      const contextDir = path.join(queued.folder, 'context');
      let store = await openAuthorityLedgerStore(contextDir, { namespace: 'application-authority' });
      const carriedTwice = await store.getReceiptPage('requirements-audit-e2', 0);
      assert(carriedTwice.records.length === 1 && carriedTwice.records[0].receipt.carriedFrom?.epoch < 2
        && carriedTwice.records[0].receipt.carriedFrom?.pageIndex === 0,
      'the epoch-two first audit page is carried from an earlier agreeing epoch');

      const audit = semanticAuditFor(contextOf(epochTwo.handoff), epochTwo.evidence, epochTwo.requirements);
      const disputedId = unitIdForText(contextOf(epochTwo.handoff), fixture.unitTexts[95]);
      flipRow(audit, disputedId);
      const opened = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
        handoffCode: epochTwo.handoff.handoffCode, response: epochTwo.reply(epochTwo.handoff, audit) });
      assert(opened.accepted && opened.handoff?.stage === 'requirements-adjudication', 'the third dispute is adjudicated');
      const overridden = await adjudicateWithAudit({ fixture, queued, opened, audit, reply: epochTwo.reply });
      assert(overridden.accepted && !overridden.terminal && overridden.handoff?.stage === 'requirements-audit'
        && contextOf(overridden.handoff).units[0].text === fixture.unitTexts[128],
      'at the cap the audit-sided verdict advances to the next audit window instead of a new epoch');
      store = await openAuthorityLedgerStore(contextDir, { namespace: 'application-authority' });
      const overridePage = await store.getReceiptPage('requirements-audit-e2', 1);
      const effective = overridePage.records[1]?.receipt;
      assert(store.receipt().streams['requirements-epochs'].count === 2
        && store.receipt().streams['requirements-adjudications'].count === 2
        && !store.receipt().streams['requirements-e3']
        && overridePage.records.length === 2 && overridePage.records[0].kind === 'requirements-adjudication'
        && JSON.stringify(effective.capOverride) === JSON.stringify({ epoch: 2, maxReEpochs: 2, unitIds: [disputedId] })
        && effective.rows.find(row => row.unitId === disputedId)?.disposition === 'requirement',
      'the override page holds the adjudication and an effective audit taking the adjudicator disposition, with no third epoch');
      const log = await readGenerationLog(queued);
      const capEvents = log.filter(event => event.type === 'authority-requirements-audit-cap-override');
      assert(capEvents.length === 1 && capEvents[0].epoch === 2 && capEvents[0].pageIndex === 1 && capEvents[0].maxReEpochs === 2
        && JSON.stringify(capEvents[0].unitIds) === JSON.stringify([disputedId])
        && capEvents[0].disputedUnitCount === 1 && capEvents[0].overriddenUnitCount === 1
        && /^[a-f0-9]{64}$/u.test(capEvents[0].adjudicationDigest)
        && !JSON.stringify(log).includes(fixture.unitTexts[95]),
      'the cap override is logged as metadata only, never the disputed unit text');
      await assertReplays({ fixture, queued, stage: 'requirements-audit', label: 'after the cap override' });

      let handoff = overridden.handoff;
      while (handoff?.stage === 'requirements-audit') {
        const accepted = await submitLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath,
          handoffCode: handoff.handoffCode, response: epochTwo.reply(handoff, semanticAuditFor(contextOf(handoff), epochTwo.evidence, epochTwo.requirements)) });
        assert(accepted.accepted, `post-override audit page is accepted (${JSON.stringify(accepted.validationErrors || [])})`);
        handoff = accepted.handoff;
      }
      assert(handoff?.stage === 'write', 'the capped job reaches writing');
      await assertReplays({ fixture, queued, stage: 'write', label: 'after the capped job reaches write' });
    } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
  },
}, {
  name: 'requirements audit carry: a carriedFrom pointer edited on disk is rejected on reopen',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture({ longListing: true });
    try {
      const queued = await queueLocalApplicationJob({ transport: 'paste', canvasFilePath: fixture.canvasFilePath,
        careerSnapshotId: fixture.snapshotId, job: fixture.job });
      const { epochZero } = await longListingToEpochOne({ fixture, queued });
      await completeRequirementsDiscovery({ fixture, queued, epoch: 1, prior: epochZero });
      const contextDir = path.join(queued.folder, 'context');
      const probe = await openAuthorityLedgerStore(contextDir, { namespace: 'application-authority' });
      const carried = await probe.getReceiptPage('requirements-audit-e1', 0);
      assert(carried.records[0]?.receipt?.carriedFrom?.pageIndex === 0, 'the untampered carried receipt binds epoch-zero page 0');

      // Content-addressed page files cannot be edited without failing the
      // store's inclusion proof first, so present the edited pointer through
      // the store read path to reach the semantic carriedFrom check itself.
      const prototype = Object.getPrototypeOf(probe);
      const original = prototype.getReceiptPage;
      let servedTampered = 0;
      prototype.getReceiptPage = async function tamperedGetReceiptPage(stream, number, ...rest) {
        const page = await original.call(this, stream, number, ...rest);
        if (stream !== 'requirements-audit-e1' || number !== 0 || !page?.records?.[0]?.receipt?.carriedFrom) return page;
        servedTampered += 1;
        const edited = JSON.parse(JSON.stringify(page));
        // Epoch-zero page 1 is the disputed window and never agrees with 0.
        edited.records[0].receipt.carriedFrom.pageIndex = 1;
        return edited;
      };
      let status = null; let statusError = null; let reopened = null; let reopenError = null;
      try {
        try { status = await localApplicationStatus(queued.id, fixture.canvasFilePath); } catch (error) { statusError = error; }
        try { reopened = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath }); } catch (error) { reopenError = error; }
      } finally { prototype.getReceiptPage = original; }
      assert(servedTampered > 0, 'reopen replays the carried audit receipt through the store');
      assert((statusError || status?.status === 'failed') && (reopenError?.code === 'LOCAL_AI_JOB_INTEGRITY' || reopened?.localJob?.status === 'failed')
        && reopened?.handoff?.stage !== 'requirements-audit',
      `a carriedFrom pointer naming a non-agreeing page fails closed on reopen (${status?.status}, ${statusError?.message}, ${reopenError?.code}, ${reopened?.handoff?.stage})`);
    } finally { await fs.promises.rm(fixture.root, { recursive: true, force: true }); }
  },
}, {
  name: 'current authority compact schedule: an all-coverage listing fails closed before career matching',
  run: async () => {
    const fixture = await makeCurrentAuthorityParallelMatchFixture();
    try {
      const queued = await queueLocalApplicationJob({
        transport: 'paste', canvasFilePath: fixture.canvasFilePath, careerSnapshotId: fixture.snapshotId,
        job: { ...fixture.job, snippet: 'Synthetic company overview with no job requirement.' },
      });
      const reply = (handoff, fields) => JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode, baseHashes: handoff.baseHashes, ...fields });
      const requirementsHandoff = (await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath: fixture.canvasFilePath })).handoff;
      const requirementsContext = contextOf(requirementsHandoff);
      const discovered = await submitLocalApplicationHandoff({
        jobId: queued.id, canvasFilePath: fixture.canvasFilePath, handoffCode: requirementsHandoff.handoffCode,
        response: reply(requirementsHandoff, {
          storeDigest: requirementsContext.authorityStore.digest, complete: true, identity: requirementsContext.trustedIdentity,
          evidence: [], requirements: [], ...coverageFor(requirementsContext, [], [], requirementsContext.requirementsProgress.sourceCoverage.unitCount),
        }),
      });
      assert(!discovered.accepted && discovered.validationErrors.some(error => /final requirements page needs at least one discovered listing requirement/i.test(error)),
        'an all-empty requirement schedule fails deterministically before the career-match stage rather than emitting fake zero-work receipts');
      const store = await openAuthorityLedgerStore(path.join(queued.folder, 'context'), { namespace: 'application-authority' });
      assert(!store.receipt().streams.requirements && !store.receipt().streams.matches && !store.receipt().streams['requirements-audit'],
        'the rejected all-empty transition does not append requirements, audit, or fake match receipts');
    } finally {
      await fs.promises.rm(fixture.root, { recursive: true, force: true });
    }
  },
}];
