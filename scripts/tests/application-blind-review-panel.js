import { assert } from './testHelpers.js';
import { authorityDigest } from '../../electron/ipc/applicationAuthorityWorkflow.js';
import {
  APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES, APPLICATION_BLIND_REVIEW_PANEL_MAX_CONTEXT_BYTES,
  APPLICATION_BLIND_REVIEW_PANEL_FACT_SCOPE_MODE, applicationBlindReviewScopeAt,
  applicationBlindReviewScopeCount, applicationBlindReviewWorkAt, buildApplicationBlindReviewPrompt,
  createApplicationBlindReviewPlan, createApplicationBlindReviewSourceAccessor,
  acceptApplicationBlindReviewCursorResponse,
  validateApplicationBlindReviewReceipts,
} from '../../electron/ipc/applicationBlindReview.js';
import { APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE } from '../../electron/ipc/applicationRefinement.js';
import { __advanceBlindReviewRollingForTests, __blindReviewRollingSeedForTests } from '../../electron/ipc/localAiApplication.js';

const DOMAINS = Object.freeze([
  { employer: 'Orchard Cooperative', role: 'Dispatch Coordinator', work: 'Coordinated harvest pickups with the depot team.', need: 'route planning' },
  { employer: 'City Museum', role: 'Conservator', work: 'Evaluated storage conditions with curatorial staff.', need: 'collection care' },
  { employer: 'Coastal Survey Office', role: 'Field Technician', work: 'Supported shoreline measurements with the survey crew.', need: 'coastal mapping' },
]);

function fixture(domain, claimCount = 2, extraHandCount = 0) {
  const lines = Array.from({ length: claimCount }, (_, index) => `${index + 1}. ${domain.work}`);
  const resume = `${domain.role} at ${domain.employer}\n${lines.join('\n')}\n`;
  const coverLetter = `I ${domain.work.toLowerCase()} I would bring that practice to ${domain.need}.\n`;
  const source = { id: 'career-1', text: domain.work };
  const factClaims = lines.map((line, index) => ({ id: `bullet-${index + 1}`, document: 'resume', pageIndex: 0, text: line, citedEvidenceIds: [source.id] }));
  factClaims.push({ id: 'letter-1', document: 'coverLetter', pageIndex: 0, text: coverLetter.trim(), citedEvidenceIds: [source.id] });
  const accessor = createApplicationBlindReviewSourceAccessor({
    resume, coverLetter, citedEvidencePages: [source], tailoringPages: [{ id: 'page-1', requirements: [], dispositions: [] }], factClaims,
    factScopeMode: APPLICATION_BLIND_REVIEW_PANEL_FACT_SCOPE_MODE,
    letterGrounding: [{ text: coverLetter.trim(), jobNeedQuote: null, citedEvidenceIds: [source.id] }],
    panel: { posting: `The ${domain.role} role needs ${domain.need}.`, careerHand: [
      { id: source.id, text: domain.work, selected: true },
      { id: 'career-unselected', text: `Also documented unrelated ${domain.need} records.`, selected: false },
      ...Array.from({ length: extraHandCount }, (_, index) => ({
        id: `host.career.achievement.synthetic-${domain.role.replace(/\W+/gu, '-').toLowerCase()}-${index}.1`,
        text: `A separate approved evidence entry ${index} describes ${domain.work} Its details are retained in the source catalog for independent selection review.`,
        selected: false,
      })),
    ] },
  });
  return { accessor, plan: createApplicationBlindReviewPlan({ sourceAccessor: accessor }), resume, coverLetter };
}

export default [{
  name: 'The signed v8 panel packs same-document claims and presents three fixed-hand lenses over three unrelated careers',
  run() {
    for (const domain of DOMAINS) {
      const { accessor, plan, resume, coverLetter } = fixture(domain);
      assert(plan.root.promptMode === APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE, `${domain.employer}: v8 mode`);
      assert(applicationBlindReviewScopeCount(plan) === 5, `${domain.employer}: two fact packs plus three lenses`);
      for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal++) {
        const { scope, context } = applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor });
        const work = applicationBlindReviewWorkAt(plan, { scopeOrdinal: ordinal, sourceAccessor: accessor });
        const prompt = buildApplicationBlindReviewPrompt(plan, work, { sourceAccessor: accessor });
        const ceiling = scope.track === 'fact-fidelity' ? APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES : APPLICATION_BLIND_REVIEW_PANEL_MAX_CONTEXT_BYTES;
        assert(Buffer.byteLength(JSON.stringify(context), 'utf8') <= ceiling && Buffer.byteLength(prompt, 'utf8') <= plan.root.promptByteLimit,
          `${domain.employer}: scope ${ordinal} fits signed envelopes`);
        if (scope.track !== 'fact-fidelity') {
          assert(prompt.includes('fixed hand') && context.careerHand.some(item => item.selected && item.text === domain.work)
            && context.resume === resume && context.coverLetter === coverLetter,
          `${domain.employer}: every holistic lens sees the selected hand and both documents whole`);
        }
        assert(prompt.includes('HOST CONVENTIONS (signed)'), `${domain.employer}: host-owned fields stay protected in every panel scope`);
        if (scope.track === 'holistic-letter-argument') {
          assert(prompt.includes('LETTER CONVENTIONS (signed)') && context.letterGrounding?.paragraphs?.length === 1,
            `${domain.employer}: letter lens sees the signed convention and bounded paragraph grounding`);
        }
      }
    }
  },
}, {
  name: 'Every holistic lens fits a large approved catalog without dropping selected evidence',
  run() {
    for (const domain of DOMAINS) {
      const { accessor, plan, resume, coverLetter } = fixture(domain, 2, 900);
      for (let ordinal = plan.root.trackCounts['fact-fidelity']; ordinal < plan.root.scopeCount; ordinal += 1) {
        const { context } = applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor });
        const work = applicationBlindReviewWorkAt(plan, { scopeOrdinal: ordinal, sourceAccessor: accessor });
        const prompt = buildApplicationBlindReviewPrompt(plan, work, { sourceAccessor: accessor });
        assert(context.careerHand.length === 902 && context.careerHand[0].text === domain.work
          && context.resume === resume && context.coverLetter === coverLetter && context.incomplete === true,
        `${domain.employer}: the large hand keeps every item and both documents, marking shortened previews`);
        assert(Buffer.byteLength(JSON.stringify(context), 'utf8') <= APPLICATION_BLIND_REVIEW_PANEL_MAX_CONTEXT_BYTES
          && Buffer.byteLength(prompt, 'utf8') <= plan.root.promptByteLimit,
        `${domain.employer}: real-scale panel scope fits both signed byte ceilings`);
      }
    }
  },
}, {
  name: 'Panel packing and signed selection scale across three unrelated long career drafts',
  run() {
    for (const domain of DOMAINS) {
      const { accessor, plan } = fixture(domain, 80);
      assert(plan.root.trackCounts['fact-fidelity'] < 80, `${domain.employer}: claims are packed rather than copied into one scope each`);
      for (let ordinal = 0; ordinal < plan.root.trackCounts['fact-fidelity']; ordinal += 1) {
        const { context } = applicationBlindReviewScopeAt(plan, ordinal, { sourceAccessor: accessor });
        assert(context.claims.length > 0 && Buffer.byteLength(JSON.stringify(context), 'utf8') <= APPLICATION_BLIND_REVIEW_MAX_CONTEXT_BYTES,
          `${domain.employer}: each escaped claim pack fits the fact ceiling`);
      }
      const { plan: changed } = fixture({ ...domain, work: `${domain.work} A second documented activity followed.` }, 80);
      assert(changed.digest !== plan.digest, `${domain.employer}: changing the career hand changes the signed plan`);
    }
  },
}, {
  name: 'Panel editorial findings stay signed and nonblocking while any fact finding remains blocking',
  run() {
    for (const domain of DOMAINS) {
      const { accessor, plan } = fixture(domain);
      const receipts = [];
      let rolling = __blindReviewRollingSeedForTests(plan);
      for (let ordinal = 0; ordinal < plan.root.scopeCount; ordinal += 1) {
        const work = applicationBlindReviewWorkAt(plan, { scopeOrdinal: ordinal, sourceAccessor: accessor });
        const finding = ordinal === 2 ? { id: `${ordinal}-0-1`, ruleId: 'clarity', document: 'resume', targetId: 'resume',
          issue: 'A clearer lead would help.', fix: 'Lead with the relevant contribution.', severity: 'major', kind: 'editorial' } : null;
        const receipt = acceptApplicationBlindReviewCursorResponse({ plan, work, sourceAccessor: accessor,
          response: { version: 1, scopeDigest: work.scopeDigest, pageIndex: 0, previousPageDigest: null,
            complete: true, decision: finding ? 'issues' : 'pass', findings: finding ? [finding] : [] } });
        receipts.push(receipt);
        rolling = __advanceBlindReviewRollingForTests(plan, rolling, work, receipt, accessor);
      }
      const result = validateApplicationBlindReviewReceipts(plan, receipts, { sourceAccessor: accessor });
      assert(result.coverage.clean && result.aggregate.findingCount === 1 && result.blockingAggregate.findingCount === 0,
        `${domain.employer}: editorial finding is retained without blocking`);
      assert(rolling.findingCount === 1 && rolling.blockingFindingCount === 0 && rolling.clean,
        `${domain.employer}: rolling state is truth-only`);
      const changed = { ...receipts[2], findings: [{ ...receipts[2].findings[0], kind: 'truth' }] };
      let rejected = false;
      try { validateApplicationBlindReviewReceipts(plan, [...receipts.slice(0, 2), changed, ...receipts.slice(3)], { sourceAccessor: accessor }); } catch { rejected = true; }
      assert(rejected, `${domain.employer}: a receipt cannot be demoted or promoted after signing`);
    }
  },
}, {
  name: 'A v8 fact pack binds targetId to a member, and a truth escalation needs an exact artifact span',
  run() {
    for (const domain of DOMAINS) {
      const { accessor, plan, resume } = fixture(domain);
      const work = applicationBlindReviewWorkAt(plan, { scopeOrdinal: 0, sourceAccessor: accessor });
      const base = { version: 1, scopeDigest: work.scopeDigest, pageIndex: 0, previousPageDigest: null, complete: true, decision: 'issues' };
      const finding = { id: '0-0-1', ruleId: 'ownership', document: 'resume', targetId: 'bullet-1', issue: 'The claim overstates work.', fix: 'State the supported action.', kind: 'editorial' };
      const receipt = acceptApplicationBlindReviewCursorResponse({ plan, work, response: { ...base, findings: [finding] }, sourceAccessor: accessor });
      assert(receipt.findings[0].kind === 'truth', `${domain.employer}: fact finding cannot demote`);
      let badTarget = false;
      try { acceptApplicationBlindReviewCursorResponse({ plan, work, response: { ...base, findings: [{ ...finding, targetId: 'foreign' }] }, sourceAccessor: accessor }); } catch { badTarget = true; }
      assert(badTarget, `${domain.employer}: foreign target rejected`);
      const lensWork = applicationBlindReviewWorkAt(plan, { scopeOrdinal: 2, sourceAccessor: accessor });
      const lens = { ...base, scopeDigest: lensWork.scopeDigest, findings: [{ ...finding, id: '2-0-1', kind: 'truth', span: resume.split('\n')[1] }] };
      assert(acceptApplicationBlindReviewCursorResponse({ plan, work: lensWork, response: lens, sourceAccessor: accessor }).findings[0].kind === 'truth', `${domain.employer}: exact span escalation accepted`);
      let badSpan = false;
      try { acceptApplicationBlindReviewCursorResponse({ plan, work: lensWork, response: { ...lens, findings: [{ ...lens.findings[0], span: authorityDigest(resume) }] }, sourceAccessor: accessor }); } catch { badSpan = true; }
      assert(badSpan, `${domain.employer}: invented span rejected`);
    }
  },
}];
