import fs from 'node:fs';
import { assert } from './testHelpers.js';
import { importLocalApplicationJob, PDFDocument } from '../test-dependencies.js';
import { __setLocalAiRenderPdfForTests } from '../../electron/ipc/localAiApplication.js';
import { FLOW_SPECS, createFlow, runBlindCycle } from './gapfix-repair-convergence.js';

async function promoteEditorialCandidate(flow, spec) {
  await runBlindCycle(flow, ({ track }) => track === 'holistic-hiring-evidence'
    ? [{ document: 'resume', targetId: 'resume', issue: 'The skills heading could be clearer.',
      fix: 'Use a plainer heading.', kind: 'editorial', severity: 'major' }] : []);
  assert(flow.accepted.handoff?.stage === 'review', `${spec.id}: editorial refinement opens`);
  const accepted = (await flow.manifest()).paste;
  const replacement = { resume: structuredClone(accepted.resume), coverLetter: structuredClone(accepted.coverLetter) };
  replacement.resume.skills[0].group = 'Technical languages';
  replacement.coverLetter.coverLetterArgument.primaryEvidence.relationToThesis = `The supported ${spec.tech} delivery illustrates the role thesis.`;
  let handoff = await flow.current();
  flow.accepted = await flow.submit(handoff, { ...flow.quality(flow.texts.paragraph, flow.texts.bullet), decision: 'revised',
    findings: [{ id: `editorial-${spec.id}`, document: 'resume', targetId: 'skills-main', issue: 'The heading is generic.', fix: 'Use a clearer heading.' }],
    resume: replacement.resume, coverLetter: replacement.coverLetter });
  assert(flow.accepted.accepted && flow.accepted.handoff?.stage === 'refinement-judge', `${spec.id}: candidate reaches judges`);
  for (let index = 0; index < 2; index += 1) {
    handoff = await flow.current();
    const context = flow.contextOf(handoff);
    const candidatePosition = context.A.resume.skills[0].group === 'Technical languages' ? 'A' : 'B';
    flow.accepted = await flow.submit(handoff, { verdict: candidatePosition, candidateUnsupportedClaim: false,
      reason: 'The proposed version states the same evidence more clearly.' });
    assert(flow.accepted.accepted, `${spec.id}: candidate preference ${index + 1} accepted`);
  }
  assert(flow.accepted.handoff?.stage === 'requirement-disposition', `${spec.id}: candidate promotion restarts disposition`);
  await flow.completeDispositions();
}

export default [{
  name: 'Three unrelated careers keep their authenticated incumbent when both position-swapped judges prefer it',
  async run() {
    for (const spec of FLOW_SPECS) {
      const flow = await createFlow(spec);
      try {
        await runBlindCycle(flow, ({ track }) => track === 'holistic-hiring-evidence'
          ? [{ document: 'resume', targetId: 'resume', issue: 'The skills heading could be clearer.',
            fix: 'Use a plainer heading.', kind: 'editorial', severity: 'major' }] : []);
        assert(flow.accepted.accepted && flow.accepted.handoff?.stage === 'review', `${spec.id}: major editorial opens optional refinement`);
        let handoff = await flow.current();
        assert(handoff.prompt.includes('editorialBrief') && handoff.prompt.includes('Optional editorial refinement'), `${spec.id}: writer sees advisory brief`);
        const accepted = (await flow.manifest()).paste;
        const replacement = { resume: structuredClone(accepted.resume), coverLetter: structuredClone(accepted.coverLetter) };
        replacement.resume.skills[0].group = 'Technical languages';
        replacement.coverLetter.coverLetterArgument.primaryEvidence.relationToThesis = `The supported ${spec.tech} delivery illustrates the role thesis.`;
        const proposed = { ...flow.quality(flow.texts.paragraph, flow.texts.bullet), decision: 'revised',
          findings: [{ id: `editorial-${spec.id}`, document: 'resume', targetId: 'skills-main',
            issue: 'The skills heading is generic.', fix: 'Use a clearer heading.' }],
          resume: replacement.resume, coverLetter: replacement.coverLetter };
        flow.accepted = await flow.submit(handoff, proposed);
        assert(flow.accepted.accepted && flow.accepted.handoff?.stage === 'refinement-judge',
          `${spec.id}: revised candidate enters judge (${JSON.stringify(flow.accepted.validationErrors || [])})`);
        for (let judgeIndex = 0; judgeIndex < 2; judgeIndex += 1) {
          handoff = await flow.current();
          const context = flow.contextOf(handoff);
          const candidatePosition = context.A.resume.skills[0].group === 'Technical languages' ? 'A' : 'B';
          const incumbentPosition = candidatePosition === 'A' ? 'B' : 'A';
          flow.accepted = await flow.submit(handoff, { verdict: incumbentPosition, candidateUnsupportedClaim: false,
            reason: 'The incumbent has the clearer evidence hierarchy.' });
          assert(flow.accepted.accepted, `${spec.id}: judge ${judgeIndex + 1} accepted`);
        }
        const manifest = await flow.manifest();
        assert(manifest.paste.stage === 'completed' && manifest.paste.refinementOutcome?.kept === 'incumbent'
          && JSON.stringify(manifest.paste.resume) === JSON.stringify(flow.original.resume)
          && JSON.stringify(manifest.paste.coverLetter) === JSON.stringify(flow.original.coverLetter),
        `${spec.id}: judge loss leaves incumbent documents byte-identical`);
        if (spec === FLOW_SPECS[0]) {
          const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
          const bytes = Buffer.from(await pdf.save());
          __setLocalAiRenderPdfForTests(async () => ({ bytes, pageCount: 2, fontsLoaded: true,
            missingFontFaces: [], layout: { contentHeightPx: 900, typeAreaHeightPx: 800 } }));
          try {
            const imported = await importLocalApplicationJob({ jobId: flow.queued.id,
              canvasFilePath: flow.project.canvasFilePath, senderId: 9911 });
            const reopened = await flow.manifest();
            assert(imported.status === 'revision-required' && reopened.status === 'queued'
              && reopened.paste.stage === 'review' && !reopened.paste.refinementOutcome,
            'a measured fit failure reopens a judged incumbent without a completed-only refinement outcome');
            const handoff = await flow.current();
            assert(handoff.stage === 'review' && handoff.prompt.includes('requiredChangeDocuments'),
              'the reopened fit handoff remains readable and requires a measured document repair');
          } finally { __setLocalAiRenderPdfForTests(null); }
        }
      } finally { await flow.cleanup(); }
    }
  },
}, {
  name: 'Three unrelated careers promote a judged candidate only after a fresh truth check, and roll back on any truth finding',
  async run() {
    for (const spec of FLOW_SPECS) {
      for (const failsTruth of [false, true]) {
        const flow = await createFlow(spec);
        try {
          await promoteEditorialCandidate(flow, spec);
          await runBlindCycle(flow, ({ track, context }) => failsTruth && track === 'fact-fidelity' && context.claim?.id?.startsWith('resume-')
            ? [{ document: 'resume', targetId: context.claim.id, issue: 'The action needs the exact source scope.',
              fix: 'Restore the cited action.', kind: 'truth' }] : []);
          const manifest = await flow.manifest();
          assert(manifest.paste.stage === 'completed', `${spec.id}: candidate check reaches a completed state`);
          if (failsTruth) {
            assert(manifest.paste.refinementOutcome?.reason === 'candidate-truth-failed'
              && JSON.stringify(manifest.paste.resume) === JSON.stringify(flow.original.resume)
              && !Object.keys(manifest.paste.authorityStore.streams).some(key => key.startsWith('blind-repair-root-')),
            `${spec.id}: truth failure restores the incumbent without a repair root`);
          } else {
            assert(manifest.paste.refinementOutcome?.kept === 'candidate'
              && manifest.paste.resume.skills[0].group === 'Technical languages'
              && manifest.paste.authorityBlindReview.coverage.clean,
            `${spec.id}: candidate remains only after truth-clean panel coverage`);
          }
        } finally { await flow.cleanup(); }
      }
    }
  },
}, {
  name: 'The second judged improvement is the cap and an existing convergence marker does not block its optional revision',
  async run() {
    for (const spec of FLOW_SPECS) {
      const flow = await createFlow(spec);
      try {
        await promoteEditorialCandidate(flow, spec);
        await runBlindCycle(flow, ({ track }) => track === 'holistic-hiring-evidence'
          ? [{ document: 'resume', targetId: 'resume', issue: 'The evidence order could be clearer.',
            fix: 'Clarify the evidence hierarchy.', kind: 'editorial', severity: 'major' }] : []);
        let manifest = await flow.manifest();
        assert(manifest.paste.stage === 'review' && manifest.paste.refinement?.round === 2,
          `${spec.id}: the first promoted candidate may open a second optional round`);
        let handoff = await flow.current();
        assert(!handoff.prompt.includes('Current-authority convergence is now required'),
          `${spec.id}: the preexisting convergence marker does not force a pass in refinement mode`);
        const replacement = { resume: structuredClone(manifest.paste.resume), coverLetter: structuredClone(manifest.paste.coverLetter) };
        replacement.resume.skills[0].group = 'Engineering languages';
        replacement.coverLetter.coverLetterArgument.primaryEvidence.relationToThesis = `The documented ${spec.tech} work supports the thesis.`;
        flow.accepted = await flow.submit(handoff, { ...flow.quality(flow.texts.paragraph, flow.texts.bullet), decision: 'revised',
          findings: [{ id: `second-editorial-${spec.id}`, document: 'resume', targetId: 'skills-main', issue: 'Improve hierarchy.', fix: 'Use a clearer group.' }],
          resume: replacement.resume, coverLetter: replacement.coverLetter });
        assert(flow.accepted.accepted && flow.accepted.handoff?.stage === 'refinement-judge', `${spec.id}: second candidate reaches judges`);
        for (let index = 0; index < 2; index += 1) {
          handoff = await flow.current();
          const context = flow.contextOf(handoff);
          const candidatePosition = context.A.resume.skills[0].group === 'Engineering languages' ? 'A' : 'B';
          flow.accepted = await flow.submit(handoff, { verdict: candidatePosition, candidateUnsupportedClaim: false,
            reason: 'The second version presents the fixed evidence more clearly.' });
          assert(flow.accepted.accepted, `${spec.id}: second-round judge ${index + 1} accepted`);
        }
        await flow.completeDispositions();
        await runBlindCycle(flow, ({ track }) => track === 'holistic-hiring-evidence'
          ? [{ document: 'resume', targetId: 'resume', issue: 'A minor further edit is possible.',
            fix: 'Consider another heading.', kind: 'editorial', severity: 'major' }] : []);
        manifest = await flow.manifest();
        assert(manifest.paste.stage === 'completed' && manifest.paste.refinementOutcome?.reason === 'round-cap'
          && manifest.paste.refinementOutcome?.round === 2 && !manifest.paste.refinement,
        `${spec.id}: a third refinement never opens`);
      } finally { await flow.cleanup(); }
    }
  },
}, {
  name: 'A forged incumbent snapshot cannot reopen optional refinement in three unrelated careers',
  async run() {
    for (const spec of FLOW_SPECS) {
      const flow = await createFlow(spec);
      try {
        await runBlindCycle(flow, ({ track }) => track === 'holistic-hiring-evidence'
          ? [{ document: 'resume', targetId: 'resume', issue: 'The heading could be clearer.',
            fix: 'Use a clearer heading.', kind: 'editorial', severity: 'major' }] : []);
        const manifest = await flow.manifest();
        assert(manifest.paste.refinement?.phase === 'revise', `${spec.id}: fixture opens refinement`);
        manifest.paste.refinement.incumbent.snapshot.resume.skills[0].group = 'forged heading';
        await fs.promises.writeFile(flow.manifestPath, JSON.stringify(manifest), 'utf8');
        let rejected = false;
        try { await flow.current(); } catch (error) { rejected = /refinement|incumbent|snapshot|digest/iu.test(String(error?.message || error)); }
        assert(rejected, `${spec.id}: forged incumbent is refused before a writer handoff`);
      } finally { await flow.cleanup(); }
    }
  },
}];
