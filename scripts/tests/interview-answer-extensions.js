import { assert } from './testHelpers.js';
import { buildInterviewAnswerEvidence } from '../../electron/ipc/interviewAnswerBank.js';
import { prepareInterviewExtensionCandidates, sanitizeInterviewExtensions, validateInterviewExtensionPoint,
  INTERVIEW_EXTENSION_MAX_CHARACTERS, INTERVIEW_EXTENSION_MAX_WORDS } from '../../electron/ipc/interviewAnswerExtensions.js';

function statement(source, text = source.text) {
  return { text, evidenceIds: [source.id], quotes: [{ evidenceId: source.id, quote: source.text }] };
}
function fixture(extensionText = 'I reviewed deployment feedback with staff.') {
  const evidence = buildInterviewAnswerEvidence({ snapshot: { snapshotId: 'a'.repeat(64), profile: {
    roles: [{ id: 'role', title: 'Product Manager', employer: 'Example Employer' }],
    achievements: [{ id: 'onboarding', roleId: 'role',
      claim: 'I maintained the onboarding guide and tested the onboarding checklist. I reviewed onboarding feedback with staff. I automated the onboarding status reports.', evidenceSegmentIds: ['segment-0001'] },
    { id: 'deployment', roleId: 'role', claim: extensionText, evidenceSegmentIds: ['segment-0002'] }],
    projects: [{ id: 'migration', name: 'Archive migration', roleId: 'role',
      description: 'I tested archive migration rollback with engineers.', evidenceSegmentIds: ['segment-0003'] }],
  } }, brief: { briefId: 'b'.repeat(64), role: {}, roleThemes: [], companyFacts: [{ sourceId: 'company', sourceUrl: 'https://company.example.test/about',
    fact: 'Cedar serves subscription teams.', sourceDate: 'unknown' }] } });
  const source = evidence[0];
  const card = { id: 'onboarding-card', question: 'Walk me through a project.',
    headline: statement(source, 'I maintained the onboarding guide.'),
    bullets: [{ ...statement(source, 'I tested the onboarding checklist.'), stage: 'point' }],
    example: statement(source, 'I reviewed onboarding feedback with staff.'),
    extensions: [{ id: 'status-reports', ...statement(source, 'I automated the onboarding status reports.') },
      { id: 'deployment-feedback', ...statement(evidence[1]) }] };
  return { bank: { cards: [card], evidence }, card, evidence, source, point: card.extensions[1] };
}
function rejects(point, context, expectedRule) {
  let error;
  try { validateInterviewExtensionPoint(point, context); } catch (failure) { error = failure; }
  assert(error && (!expectedRule || error.code === expectedRule), `reject extension with ${expectedRule || 'a grounding failure'}; got ${error?.code}`);
}

export default [
  {
    name: 'interview extensions: two additional grounded points survive with tiny host-derived example hooks',
    run() {
      const { bank, card, source } = fixture();
      const before = JSON.stringify(bank);
      const candidates = prepareInterviewExtensionCandidates(bank);
      assert(candidates[card.id].length === 2, 'both a new detail and another career story survive as optional points');
      assert(candidates[card.id][0].text === card.extensions[0].text && candidates[card.id][1].text === card.extensions[1].text, 'dedicated generated points retain their IDs, prose and order');
      assert(candidates[card.id][0].sourceLabel === source.sourceLabel && candidates[card.id][0].quotes[0].quote === source.text, 'each point retains its complete exact cited source');
      assert(candidates[card.id][1].exampleHook === 'Example Employer · Product Manager', 'a host-derived role hook helps the human find an example');
      const project = bank.evidence.find(item => item.entityId === 'migration');
      card.extensions.push({ id: 'archive', ...statement(project) });
      assert(prepareInterviewExtensionCandidates(bank)[card.id][2].exampleHook === 'Archive migration', 'a different project provides its own tiny hook');
      card.extensions.pop();
      candidates[card.id][0].text = 'Changed locally.';
      assert(JSON.stringify(bank) === before, 'candidate projection cannot mutate the sealed card');
    },
  },
  {
    name: 'interview extensions: invented metrics, technologies, outcomes, entities and altered source quotes reject',
    run() {
      const context = fixture();
      for (const text of ['I reduced deployment setup time by 75%.', 'I reviewed deployment feedback in Salesforce.',
        'I improved deployment conversion with staff.', 'I reviewed deployment feedback at Invented Employer.']) {
        rejects({ ...context.point, text }, context);
      }
      rejects({ ...context.point, quotes: [{ evidenceId: context.evidence[1].id, quote: 'I reviewed deployment feedback and increased conversion.' }] }, context, 'INTERVIEW_EXTENSION_SOURCE');
      rejects({ ...context.point, sourceLabel: 'Invented employer story' }, context, 'INTERVIEW_EXTENSION_SHAPE');
      rejects({ ...context.point, evidenceIds: ['career-' + 'f'.repeat(64)], quotes: [{ evidenceId: 'career-' + 'f'.repeat(64), quote: context.point.text }] }, context, 'INTERVIEW_EXTENSION_SOURCE');
    },
  },
  {
    name: 'interview extensions: exact and reworded memorized bullets and sibling points add no optional detail',
    run() {
      const context = fixture();
      for (const text of ['I tested the onboarding checklist.', 'The onboarding checklist was tested by me.', 'I reviewed onboarding feedback with staff.']) {
        rejects({ id: 'duplicate', ...statement(context.source, text) }, context, 'INTERVIEW_EXTENSION_NEW_DETAIL');
      }
      const previousPoints = [context.card.extensions[0]];
      rejects({ id: 'duplicate-report', ...statement(context.source, 'The onboarding status reports were automated by me.') }, { ...context, previousPoints }, 'INTERVIEW_EXTENSION_NEW_DETAIL');
      rejects({ ...context.point, id: previousPoints[0].id }, { ...context, previousPoints }, 'INTERVIEW_EXTENSION_SHAPE');
    },
  },
  {
    name: 'interview extensions: distinct sibling propositions survive mechanical checks for independent semantic review',
    run() {
      const context = fixture('I reviewed deployment requirements with engineers. I tested rollback checklists with engineers.');
      const source = context.evidence[1];
      context.card.extensions = [
        { id: 'wrong-relationship', ...statement(source, 'I reviewed rollback requirements with engineers.') },
        { id: 'supported-rollback', ...statement(source, 'I tested rollback checklists with engineers.') },
      ];
      const retained = sanitizeInterviewExtensions(context.card, context.evidence);
      assert(retained.length === 2 && retained[1].id === 'supported-rollback', 'a sibling sharing new vocabulary cannot displace a distinct supported proposition before semantic review');
      context.card.extensions.reverse();
      assert(sanitizeInterviewExtensions(context.card, context.evidence).length === 2, 'both distinct propositions reach semantic review regardless of their order');
    },
  },
  {
    name: 'interview extensions: pre-review sibling comparison can preserve alternative citation bindings',
    run() {
      const context = fixture('I automated the onboarding guide and reviewed the onboarding status reports.');
      const text = 'I automated the onboarding status reports.';
      context.card.extensions = [
        { id: 'wrong-citation', ...statement(context.evidence[1], text) },
        { id: 'supported-citation', ...statement(context.source, text) },
      ];
      assert(sanitizeInterviewExtensions(context.card, context.evidence).length === 1, 'the default strict validator rejects repeated sibling wording');
      const retained = sanitizeInterviewExtensions(context.card, context.evidence, { compareSiblingDetails: false });
      assert(retained.length === 2 && retained[1].id === 'supported-citation', 'both different evidence bindings must reach semantic review before duplicate suppression');
      context.card.extensions[1].id = context.card.extensions[0].id;
      assert(sanitizeInterviewExtensions(context.card, context.evidence, { compareSiblingDetails: false }).length === 1, 'pre-review comparison still enforces unique extension IDs');
    },
  },
  {
    name: 'interview extensions: inherited, shared, team-chosen and supporting-only candor guards apply',
    run() {
      const inherited = fixture('The deployment guide was built by another engineer. I inherited the deployment guide and maintained it.');
      rejects({ ...inherited.point, text: 'I built the deployment guide.' }, inherited, 'INTERVIEW_ANSWER_INHERITED');
      const shared = fixture('I co-built the deployment guide with the other engineer. We reviewed deployment feedback with staff.');
      rejects({ ...shared.point, text: 'I reviewed deployment feedback with staff.' }, shared, 'INTERVIEW_ANSWER_CO_BUILT');
      assert(validateInterviewExtensionPoint({ ...shared.point, text: 'We reviewed deployment feedback with staff.' }, shared).text.startsWith('We '), 'shared agency remains explicit');
      const team = fixture('The team chose a modified deployment algorithm before I joined. I implemented and tested the deployment algorithm.');
      rejects({ ...team.point, text: 'I chose the modified deployment algorithm.' }, team, 'INTERVIEW_ANSWER_TEAM_CHOSEN');
      assert(validateInterviewExtensionPoint({ ...team.point, text: 'I implemented the deployment algorithm.' }, team).text.includes('implemented'), 'candidate implementation retains team-choice scope');
      const supported = fixture('I helped staff review deployment feedback and supported deployment checklist testing.');
      rejects({ ...supported.point, text: 'I reviewed deployment feedback with staff.' }, supported, 'INTERVIEW_ANSWER_SUPPORTED_ONLY');
      assert(validateInterviewExtensionPoint({ ...supported.point, text: 'I helped staff review deployment feedback.' }, supported).text.startsWith('I helped'), 'supporting agency remains modest');
    },
  },
  {
    name: 'interview extensions: sparse rejection keeps valid siblings and never promotes the card example',
    run() {
      const { bank, card, source, evidence } = fixture();
      const valid = structuredClone(card.extensions);
      card.extensions = [{ id: 'invented', ...statement(evidence[1], 'I doubled deployment conversion.') }, valid[0],
        { id: 'duplicate', ...card.example }, { ...valid[1], quotes: [] }, valid[1]];
      const retained = sanitizeInterviewExtensions(card, evidence);
      assert(retained.length === 2 && retained.map(point => point.id).join() === valid.map(point => point.id).join(), 'bad points individually drop without regenerating safe siblings');
      assert(card.extensions.length === 5 && card.headline.evidenceIds[0] === source.id, 'sparse sanitization does not mutate the draft or prepared answer');
      card.extensions = [];
      assert(prepareInterviewExtensionCandidates(bank)[card.id].length === 0, 'an example is never implicitly promoted into section B');
      delete card.extensions;
      assert(prepareInterviewExtensionCandidates(bank)[card.id].length === 0, 'a legacy bank without dedicated extensions remains honest');
    },
  },
  {
    name: 'interview extensions: glanceable one-line limits and four-point ceiling are enforced',
    run() {
      const context = fixture();
      rejects({ ...context.point, text: 'I ' + 'reviewed '.repeat(INTERVIEW_EXTENSION_MAX_WORDS) }, context, 'INTERVIEW_EXTENSION_SHAPE');
      rejects({ ...context.point, text: 'I ' + 'reviewed'.repeat(INTERVIEW_EXTENSION_MAX_CHARACTERS) }, context, 'INTERVIEW_EXTENSION_SHAPE');
      rejects({ ...context.point, text: 'I reviewed deployment\nfeedback.' }, context, 'INTERVIEW_EXTENSION_SHAPE');
      rejects({ ...context.point, text: 'It reviewed deployment feedback.' }, context, 'INTERVIEW_EXTENSION_CONCRETE');
      const extra = Array.from({ length: 5 }, (_, index) => {
        const source = { ...context.evidence[1], id: `career-${String(index + 1).repeat(64)}`, text: `I reviewed deployment phase${String.fromCharCode(97 + index)} feedback.` };
        context.evidence.push(source);
        return { id: `extra-${index}`, ...statement(source) };
      });
      context.card.extensions = extra;
      assert(sanitizeInterviewExtensions(context.card, context.evidence).length === 4, 'a card can expose no more than four valid optional points');
    },
  },
  {
    name: 'interview extensions: why-card research facts retain separate evidence and cannot establish candidate experience',
    run() {
      const context = fixture();
      const research = context.evidence.find(source => source.kind === 'research');
      const point = { id: 'company-reason', ...statement(research, 'This company interests me because Cedar serves subscription teams.') };
      rejects(point, context, 'INTERVIEW_EXTENSION_RESEARCH');
      context.card.question = 'Why are you interested in this company?';
      assert(validateInterviewExtensionPoint(point, context).evidenceIds[0] === research.id, 'a why-company extension may add a new separately cited research reason');
      rejects({ ...point, text: 'I served Cedar subscription teams.' }, context, 'INTERVIEW_ANSWER_RESEARCH_AGENCY');
      rejects({ ...point, evidenceIds: [research.id, context.source.id], quotes: [...point.quotes, { evidenceId: context.source.id, quote: context.source.text }] }, context, 'INTERVIEW_EXTENSION_RESEARCH');
      context.card.extensions = [point];
      assert(prepareInterviewExtensionCandidates(context.bank)[context.card.id][0].exampleHook === research.sourceUrl, 'research hooks identify the sealed research source');
    },
  },
];
