import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import * as nodeModule from 'node:module';
import path from 'node:path';
import { PDFDocument } from 'pdf-lib';
import {
  __setLocalAiRenderPdfForTests, getLocalApplicationHandoff, hydratePinnedCareerAuthority,
  importLocalApplicationJob, localApplicationStatus, submitLocalApplicationHandoff,
} from '../../electron/ipc/localAiApplication.js';
import { openAuthorityLedgerStore } from '../../electron/ipc/applicationAuthorityLedgerStore.js';
import { currentAuthorityFlowKit } from './local-ai-application.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';

const { createCanvasProject, listingCoverageFields, listingSemanticAuditFields, canonicalJson, sha256 } = currentAuthorityFlowKit;
const contextOf = handoff => JSON.parse(handoff.prompt.slice(handoff.prompt.lastIndexOf('\n\nAuthoritative context:\n') + '\n\nAuthoritative context:\n'.length));

async function historicalQueueModule() {
  // Reproduce a genuine pre-flag queue writer: every authority digest, store
  // genesis and immutable anchor is produced normally from its former exact
  // skill shape. No frozen input or genesis hash is patched after creation.
  const target = new URL('../../electron/ipc/localAiApplication.js?r1-flagless-queue-fixture', import.meta.url).href;
  const definition = 'function snapshotCareerSkillEvidence(snapshot) {';
  const historicalDefinition = `function snapshotCareerSkillEvidence(snapshot) {
    const projection = historicalFixtureModernProjection(snapshot);
    return { ...projection, skills: projection.skills.map(({ declaredInSkillsSection: _declared, ...skill }) => skill) };
  }
  function historicalFixtureModernProjection(snapshot) {`;
  if (typeof nodeModule.registerHooks !== 'function') {
    // Node 22.13 supports the asynchronous hook API; newer supported releases
    // can deregister their synchronous hook immediately after the import.
    const loader = `export async function load(url, context, nextLoad) {
      const loaded = await nextLoad(url, context);
      if (url !== ${JSON.stringify(target)}) return loaded;
      const source = String(loaded.source);
      if (source.split(${JSON.stringify(definition)}).length !== 2) throw new Error('Historical fixture projection function changed.');
      return { ...loaded, source: source.replace(${JSON.stringify(definition)}, ${JSON.stringify(historicalDefinition)}) };
    }`;
    nodeModule.register(`data:text/javascript,${encodeURIComponent(loader)}`, import.meta.url);
    return import(target);
  }
  const hook = nodeModule.registerHooks({ load(url, context, nextLoad) {
    const loaded = nextLoad(url, context);
    if (url !== target) return loaded;
    const source = String(loaded.source);
    assert.equal(source.split(definition).length, 2, 'historical fixture wraps exactly one projection function');
    return { ...loaded, source: source.replace(definition, historicalDefinition) };
  } });
  try { return await import(target); }
  finally { hook.deregister(); }
}

async function advanceRequirements(queued, args) {
  let handoff = (await getLocalApplicationHandoff(args)).handoff;
  assert.equal(handoff.stage, 'requirements');
  const context = contextOf(handoff);
  const quote = context.requirementsProgress.sourceCoverage.units.find(unit => unit.text.includes('reliable service delivery')).text;
  const evidence = [{ id: 'p1-e1', quote, requirement: 'Reliable service delivery', priority: 'high' }];
  const requirements = [{ id: 'p1-r1', text: 'Reliable service delivery', priority: 'high', evidenceIds: ['p1-e1'] }];
  const submit = async fields => {
    const accepted = await submitLocalApplicationHandoff({ ...args, handoffCode: handoff.handoffCode,
      response: JSON.stringify({ protocol: 1, jobId: queued.id, stage: handoff.stage, handoffCode: handoff.handoffCode,
        baseHashes: handoff.baseHashes, ...fields }) });
    assert.equal(accepted.accepted, true, JSON.stringify(accepted.validationErrors));
    handoff = accepted.handoff;
  };
  await submit({ storeDigest: context.authorityStore.digest, complete: true, identity: context.trustedIdentity,
    evidence, requirements, ...listingCoverageFields(context, evidence, requirements) });
  while (handoff.stage === 'requirements-audit') {
    await submit(listingSemanticAuditFields(contextOf(handoff), evidence, requirements));
  }
  assert.equal(handoff.stage, 'write');
}

export default [
  {
    name: 'R1 flagless pinned jobs retain their matching genesis and survive current handoff, poll and completed import',
    async run() {
      const project = await createCanvasProject();
      try {
        const { snapshotId } = await writeApprovedCareerSnapshotFixture();
        const historical = await historicalQueueModule();
        const queued = await historical.queueLocalApplicationJob({ transport: 'paste', canvasFilePath: project.canvasFilePath,
          careerSnapshotId: snapshotId, applicationProtocol: 'write-then-verify.v2',
          job: { title: 'Software Engineer', company: 'Northwind Labs', snippet: 'This engineering role requires reliable service delivery.' } });
        const args = { jobId: queued.id, canvasFilePath: project.canvasFilePath };
        const inputPath = path.join(queued.folder, 'input.json');
        const frozenInput = await fs.readFile(inputPath, 'utf8');
        const input = JSON.parse(frozenInput);
        const hydrated = await hydratePinnedCareerAuthority(input);
        assert.ok(hydrated.skillEvidence.skills.length > 0);
        assert.ok(hydrated.skillEvidence.skills.every(skill => !Object.hasOwn(skill, 'declaredInSkillsSection')));
        const store = await openAuthorityLedgerStore(path.join(queued.folder, 'context'), { namespace: 'application-authority' });
        assert.equal(store.state.genesis.skillDigest, sha256(JSON.stringify(hydrated.skillEvidence.skills)), 'the old projection exactly matches the genuine queue-time genesis');
        const genesis = canonicalJson(store.state.genesis);
        assert.equal((await localApplicationStatus(queued.id, project.canvasFilePath)).status, 'queued');
        await advanceRequirements(queued, args);
        assert.equal((await localApplicationStatus(queued.id, project.canvasFilePath)).status, 'queued');

        // Seed only the completed documents, after real immutable requirements
        // discovery and audit. This test targets the three reopen boundaries,
        // not the independently tested writer/ranking protocol.
        const manifestPath = path.join(queued.folder, 'manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        manifest.paste.stage = 'completed'; manifest.paste.handoffCode = null; manifest.status = 'paste-completed';
        await fs.writeFile(manifestPath, JSON.stringify(manifest));
        const bullet = 'Built a Python service used by 50 users.';
        const paragraph = 'Reliable service delivery is the capability this engineering role needs, and my service work supports it. I built a Python service used by 50 users. I would apply that service work to reliable service delivery in this role.';
        const result = { version: input.version, jobId: queued.id, status: 'completed', outputBundleRoot: 'Applied Jobs',
          applicationProtocol: 'write-then-verify.v2',
          resumeMainHtml: `<main class="page"><header class="header"><h1>Ada Lovelace</h1><div class="contact">ada@example.test</div></header><section class="section"><h2>Experience</h2><article class="role"><span class="title">Software Engineer</span><span class="company">Acme</span><span class="dates">January 2020 to Present</span><ul class="highlights"><li>${bullet}</li></ul></article></section></main>`,
          coverLetter: { name: 'Ada Lovelace', contact: ['ada@example.test'], paragraphs: [paragraph] },
          coverLetterArgument: { roleThesis: 'Reliable service delivery is the supported capability this engineering role needs.',
            primaryEvidence: { evidence: bullet, evidenceRole: 'Software Engineer at Acme', relationToThesis: 'The completed service delivery supports the stated service delivery capability.' } },
          qualityReview: null, generationAudit: null };
        await fs.writeFile(path.join(queued.folder, 'result.json'), JSON.stringify(result));
        const completed = await localApplicationStatus(queued.id, project.canvasFilePath);
        assert.equal(completed.status, 'completed', completed.message);
        const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
        const bytes = Buffer.from(await pdf.save());
        __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 1, fontsLoaded: true, missingFontFaces: [],
          layout: { contentHeightPx: 640, typeAreaHeightPx: 800, horizontalOverflowCount: 0 } }));
        const imported = await importLocalApplicationJob({ ...args, senderId: 12031 });
        assert.equal(imported.status, 'imported');
        assert.equal(imported.missingArtifacts.length, 0);
        assert.ok(await fs.stat(imported.resumePdfPath));
        assert.equal(await fs.readFile(inputPath, 'utf8'), frozenInput, 'current readers preserve the legacy input');
        const reopened = await openAuthorityLedgerStore(path.join(queued.folder, 'context'), { namespace: 'application-authority' });
        assert.equal(canonicalJson(reopened.state.genesis), genesis, 'the historical genesis is never upgraded or rewritten');
        return { handoff: 'requirements', poll: completed.status, import: imported.status, legacySkills: hydrated.skillEvidence.skills.length };
      } finally {
        __setLocalAiRenderPdfForTests(null);
        await fs.rm(project.root, { recursive: true, force: true });
      }
    },
  },
];
