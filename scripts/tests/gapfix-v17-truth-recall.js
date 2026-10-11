import { assert } from './testHelpers.js';
import { __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';
import { checkTargetClaimScope, findUnsupportedDurationClaim } from '../../electron/ipc/coverLetterChecks.js';

// Four unrelated synthetic careers. A posting can guide selection, but it
// cannot supply a candidate fact. None of these records comes from acceptance
// evidence. The same matrix is also run against commit 56b5051 separately.
export const TRUTH_RECALL_PROFILES = Object.freeze([
  { company: 'Orchard Cooperative', title: 'Coordinator', action: 'maintained', object: 'routing schedules for seasonal deliveries', setting: 'with the logistics team', need: 'supply forecasting' },
  { company: 'City Museum', title: 'Conservator', action: 'evaluated', object: 'storage plans for fragile collections', setting: 'with the curatorial team', need: 'digital exhibitions' },
  { company: 'Coastal Survey Office', title: 'Technician', action: 'supported', object: 'coastal surveys for harbour planning', setting: 'with the field team', need: 'marine simulation' },
  { company: 'Community Clinic', title: 'Analyst', action: 'monitored', object: 'intake records for patient scheduling', setting: 'with the care team', need: 'clinical prediction' },
]);

function inputFor(profile, quote) {
  return {
    unitLabel: 'Résumé bullet', unitId: 'bullet-1',
    evidenceIds: ['career-1'], acceptedEvidence: [{ id: 'career-1', sourceId: 'career-data', quote }],
    identityTokens: profile.company.toLowerCase().split(' '), label: 'resumeBullets',
    sourceRoles: [{ id: 'role-1', title: profile.title, company: profile.company, dates: '2020 - 2023' }],
    careerData: `### ${profile.title}\n${profile.company}\n2020 - 2023\n${quote}`,
    authority: null, projects: [], targetCompany: 'Target Organization',
    postingText: `We need ${profile.need}.`,
  };
}

function sentences(profile) {
  const { action, object, setting, need } = profile;
  return [
    `I built ${object} ${setting}.`, // maintenance/evaluation/support presented as authorship
    `I led ${object} ${setting}.`, // inflated leadership
    `I owned ${object} ${setting}.`, // inflated ownership
    `I independently ${action} ${object} ${setting}.`, // team work turned into sole work
    `I ${action} ${object} and reduced costs by 50%.`, // outcome and metric
    `I ${action} ${object} in 2019.`, // date outside the role and quote
    `I ${action} ${object} with Kubernetes.`, // unlisted employer tool as own skill
    `I ${action} ${object} and delivered ${need}.`, // posting need presented as experience
    `As Director, I ${action} ${object}.`, // inflated title
    `I have 12 years of experience in ${object}.`, // computed duration
    `I ${action} ${object} for Target Organization.`, // false employer attribution
  ];
}

export function runTruthRecallMatrix(grounding = __pasteUnitGroundingErrorsForTests, duration = findUnsupportedDurationClaim) {
  return TRUTH_RECALL_PROFILES.map(profile => {
    const quote = `At ${profile.company}, I ${profile.action} ${profile.object} ${profile.setting}.`;
    const input = inputFor(profile, quote);
    const faithful = `I ${profile.action} ${profile.object} ${profile.setting}.`;
    const cases = sentences(profile).map((finalText, index) => ({
      index, finalText,
      blocked: grounding({ ...input, finalText }).length > 0 || Boolean(duration(finalText, [quote])),
    }));
    return { profile, quote, input, faithful, cases };
  });
}

export default [{
  name: 'Truth recall: 44 inflated claims over four unrelated careers are blocked, and source mutations flip the verdict',
  run() {
    const results = runTruthRecallMatrix();
    assert(results.length === 4 && results.every(row => row.cases.length === 11), 'the matrix covers 44 claims in four unrelated domains');
    for (const row of results) {
      const { profile, input, faithful, cases } = row;
      assert(__pasteUnitGroundingErrorsForTests({ ...input, finalText: faithful }).length === 0,
        `${profile.company}: the faithful control passes`);
      for (const item of cases) assert(item.blocked, `${profile.company}: inflated claim ${item.index + 1} must be blocked`);
      const built = cases[0].finalText;
      const builtQuote = `At ${profile.company}, I built ${profile.object} ${profile.setting}.`;
      assert(__pasteUnitGroundingErrorsForTests({ ...input, finalText: built,
        acceptedEvidence: [{ id: 'career-1', sourceId: 'career-data', quote: builtQuote }] }).length === 0,
      `${profile.company}: changing the cited source to state authorship flips the result`);
      const metric = cases[4].finalText;
      const metricQuote = `At ${profile.company}, I ${profile.action} ${profile.object} and reduced costs by 50%.`;
      assert(__pasteUnitGroundingErrorsForTests({ ...input, finalText: metric,
        acceptedEvidence: [{ id: 'career-1', sourceId: 'career-data', quote: metricQuote }] }).length === 0,
      `${profile.company}: changing the cited source to state the metric flips the result`);
      const dated = cases[5].finalText;
      assert(__pasteUnitGroundingErrorsForTests({ ...input, finalText: dated,
        sourceRoles: [{ ...input.sourceRoles[0], dates: '2019 - 2023' }] }).length === 0,
      `${profile.company}: changing trusted role dates flips the date verdict`);
    }
  },
}, {
  name: 'A pure application-intent opening passes the source-overlap floor, but a career overclaim beside it still fails',
  run() {
    for (const profile of TRUTH_RECALL_PROFILES) {
      const quote = `At ${profile.company}, I ${profile.action} ${profile.object} ${profile.setting}.`;
      const input = { ...inputFor(profile, quote), unitLabel: 'Cover-letter paragraph', label: 'coverLetterParagraphs' };
      const intent = `I am applying for the ${profile.title} role at Target Organization.`;
      const inflated = `${intent} I built ${profile.object}.`;
      assert(__pasteUnitGroundingErrorsForTests({ ...input, finalText: intent }).length === 0,
        `${profile.company}: intent alone asserts no past work`);
      assert(__pasteUnitGroundingErrorsForTests({ ...input, finalText: inflated }).length > 0,
        `${profile.company}: an adjacent invented past action still rejects`);
      assert(__pasteUnitGroundingErrorsForTests({ ...input, finalText: `${intent} I ${profile.action} ${profile.object} ${profile.setting}.` }).length === 0,
        `${profile.company}: replacing the invented action with the cited one flips the verdict`);
    }
  },
}, {
  name: 'Target-facing claims cannot promote prior-work domain mechanics into four unrelated employers',
  run() {
    for (const profile of TRUTH_RECALL_PROFILES) {
      const sourceMechanic = profile.object;
      const posting = `This role is responsible for ${profile.need}. You will organize project inputs, share progress with colleagues, review requirements with managers, maintain clear records, and help the team make careful decisions. The work involves communicating with stakeholders, checking outputs, documenting assumptions, and improving the way the team handles its current information. We value precise work, sound judgment, and collaboration across departments on these responsibilities.`;
      const evidence = { bulletTexts: [`I ${profile.action} ${sourceMechanic} ${profile.setting}.`] };
      const targetClaim = `For this role's ${profile.need}, I would bring experience building ${sourceMechanic}.`;
      const honestTransfer = `For this role's ${profile.need}, I would bring careful planning experience.`;
      assert(!checkTargetClaimScope({ roleThesis: targetClaim }, [], evidence, posting).passed,
        `${profile.company}: prior-work mechanics cannot be stated as the employer's work`);
      assert(checkTargetClaimScope({ roleThesis: honestTransfer }, [], evidence, posting).passed,
        `${profile.company}: a general, honest transfer remains legal`);
      assert(checkTargetClaimScope({ roleThesis: targetClaim }, [], evidence, `${posting} This role also involves ${sourceMechanic}.`).passed,
        `${profile.company}: changing the posting to state those mechanics flips the verdict`);
    }
  },
}];
