import { assert } from './testHelpers.js';
import { EventEmitter } from 'node:events';
import { ipcMain } from 'electron';
import { getRecentLogs } from '../../electron/logger.js';
import { snapshotActiveNodeTasks } from '../../electron/ipc/ipcUtils.js';
import {
  INTERVIEW_HELPER_MAX_STEPS,
  buildInterviewPlan,
  canonicalInterviewJobUrl,
  createInterviewHelperSession,
  extractLatestInterviewQuestion,
  extractInterviewProfileEvidence,
  interviewHelperTerms,
  interviewHelperSessionReducer,
  rankInterviewEvidence,
  validInterviewPreparationBrief,
} from '../../src/utils/interviewHelper.js';
import {
  isInterviewHelperNodeId,
  isInterviewHelperSnapshotId,
  loadInterviewHelperCareerSnapshot,
  projectInterviewHelperCareerSnapshot,
  registerInterviewHelperHandlers,
} from '../../electron/ipc/interviewHelper.js';
import { cloneNode, NODE_FACTORIES } from '../../src/utils/nodeFactory.js';
import { getNodeDims } from '../../src/utils/constants.js';

function profileFixture() {
  return {
    identity: { name: 'Ada Example', contacts: [], evidenceSegmentIds: ['segment-0001'] },
    roles: [{
      id: 'role-acme', title: 'Product Manager', employer: 'Acme', startDate: '2021', endDate: 'Present', location: 'Toronto',
      achievementIds: ['achievement-onboarding', 'achievement-platform'], skillIds: ['skill-react'], evidenceSegmentIds: ['segment-0002'],
    }],
    achievements: [
      { id: 'achievement-onboarding', roleId: 'role-acme', claim: 'Improved onboarding conversion by testing a simpler setup flow.', technologies: ['Optimizely'], metrics: [], evidenceSegmentIds: ['segment-0003'] },
      { id: 'achievement-platform', roleId: 'role-acme', claim: 'Led the platform migration with partner teams.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0004'] },
    ],
    projects: [{
      id: 'project-dashboard', roleId: 'role-acme', name: 'Analytics Dashboard', description: 'Built an analytics dashboard for weekly retention reviews.', technologies: ['React'], metrics: [], evidenceSegmentIds: ['segment-0005'],
    }, {
      id: 'project-atlas', roleId: 'role-acme', name: 'Atlas', description: 'Built a private reporting console.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0009'],
    }],
    skills: [
      { id: 'skill-react', name: 'React', category: 'frontend', supportMode: 'direct', indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: ['segment-0006'], directEvidenceSegmentIds: ['segment-0005'] },
      { id: 'skill-cpp', name: 'C++', category: 'language', supportMode: 'direct', indexEligible: true, roleIds: ['role-acme'], evidenceSegmentIds: ['segment-0008'], directEvidenceSegmentIds: ['segment-0008'] },
      { id: 'skill-prototype', name: 'Prototype', category: 'tool', supportMode: 'direct', indexEligible: false, roleIds: ['role-acme'], evidenceSegmentIds: ['segment-0010'], directEvidenceSegmentIds: ['segment-0010'] },
      { id: 'skill-conditional', name: 'Legacy CMS', category: 'platform', supportMode: 'relationship-qualified', indexEligible: false, roleIds: [], evidenceSegmentIds: ['segment-0007'], directEvidenceSegmentIds: [] },
    ],
    education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
  };
}

const INTERVIEW_SNAPSHOT_ID = 'a'.repeat(64);

function approvedSnapshotFixture() {
  const profile = profileFixture();
  const directSkill = {
    ...profile.skills[0],
    capabilityKind: 'technology',
    supportMode: 'direct',
    directEvidenceSegmentIds: ['segment-0005', 'not-a-segment-id'],
  };
  return {
    snapshotId: INTERVIEW_SNAPSHOT_ID,
    schemaVersion: 6,
    status: 'approved',
    // These must never cross the Interview Helper renderer boundary.
    sources: [{ name: 'Work Experience.md', legacyText: 'RAW_LEGACY_SOURCE_SHOULD_NOT_LEAK' }],
    segments: [{ id: 'segment-0001', text: 'RAW_SEGMENT_SOURCE_SHOULD_NOT_LEAK' }],
    profile: {
      ...profile,
      identity: { name: 'Ada Example', contacts: ['ada@example.test'], evidenceSegmentIds: ['segment-0001'] },
      achievements: [{
        ...profile.achievements[0],
        metrics: [{ label: 'conversion', value: '12', unit: 'percent', evidenceSegmentIds: ['segment-0003'] }],
      }, ...profile.achievements.slice(1)],
      skills: [directSkill, ...profile.skills.slice(1)],
      otherEvidence: [{
        id: 'other-award', kind: 'award', label: 'Delivery recognition', text: 'Recognized for delivery.', evidenceSegmentIds: ['segment-0008'],
      }],
    },
  };
}

function throws(callback) {
  try {
    callback();
    return false;
  } catch {
    return true;
  }
}

function senderEvent() {
  const sender = new EventEmitter();
  sender.id = senderEvent.nextId++;
  sender.isDestroyed = () => false;
  return { sender };
}
senderEvent.nextId = 50_000;

export default [
  {
    name: 'interview helper: renderer and IPC canonicalize repaired job URLs identically',
    run: async () => {
      const { normalizeInterviewPreparationJobUrl } = await import('../../electron/ipc/interviewPreparation.js');
      const urls = [
        ' https://jobs.example.test/openings/42?ref=canvas#details ',
        'https://www.google.com/search?q=Product+Manager&ibp=htl;jobs&htidocid=abc123#htivrt=jobs',
      ];
      for (const input of urls) {
        const renderer = canonicalInterviewJobUrl(input);
        const backend = normalizeInterviewPreparationJobUrl(input);
        assert(renderer && renderer === backend, `renderer and IPC must agree on ${input}`);
        assert(!renderer.includes('#') && !renderer.includes('?ref='), 'canonical job URLs must not retain fragments or arbitrary query metadata');
      }
      const repaired = canonicalInterviewJobUrl(urls[1]);
      assert(repaired === 'https://www.google.com/search?udm=8&htidocid=abc123', 'a genuine Google Jobs card URL must retain only its repaired public Jobs identity');
      for (const unsafe of ['https://jobs.example.test/a\u0085b', 'https://jobs.example.test/a\u202Eb']) {
        assert(canonicalInterviewJobUrl(unsafe) === null && !normalizeInterviewPreparationJobUrl(unsafe), 'C1 and bidi controls must be rejected at both URL boundaries');
      }
    },
  },
  {
    name: 'interview helper: strips secret and tracking URL data at renderer and IPC boundaries',
    run: async () => {
      const { normalizeInterviewPreparationJobUrl } = await import('../../electron/ipc/interviewPreparation.js');
      const privacyCases = [
        ['https://jobs.example.test/openings/42?access_token=top-secret&ref=canvas#candidate@example.test', 'https://jobs.example.test/openings/42'],
        ['https://research.example.test/article?token=abc123&signature=deadbeef&utm_source=email', 'https://research.example.test/article'],
        ['https://jobs.example.test/?email=ada%40example.test', 'https://jobs.example.test/'],
        ['https://jobs.example.test/?signed=private', 'https://jobs.example.test/'],
      ];
      for (const [input, expected] of privacyCases) {
        assert(canonicalInterviewJobUrl(input) === expected, `renderer must redact query/fragment data for ${input}`);
        assert(normalizeInterviewPreparationJobUrl(input) === expected, `IPC must redact query/fragment data for ${input}`);
        assert(!canonicalInterviewJobUrl(input)?.match(/access_token|token|signature|email|utm|private|secret/iu), 'a persisted URL must not retain input secret-like query values');
      }
      const google = 'https://www.google.com/search?q=ada%40example.test&ibp=htl%3Bjobs&udm=8&htidocid=abc_123%3Adef&hl=en-CA&token=secret#docid=abc_123%3Adef';
      const expectedGoogle = 'https://www.google.com/search?udm=8&htidocid=abc_123%3Adef&hl=en-CA';
      assert(canonicalInterviewJobUrl(google) === expectedGoogle && normalizeInterviewPreparationJobUrl(google) === expectedGoogle, 'Google Jobs repair may retain only bounded document identity and locale, never q or arbitrary parameters');
      const malformedGoogleId = 'https://www.google.com/search?udm=8&htidocid=abc%2Fprivate&token=secret';
      assert(canonicalInterviewJobUrl(malformedGoogleId) === 'https://www.google.com/search?udm=8', 'invalid Google document ids must not be persisted');
      const credentialedGoogle = 'https://user:pass@www.google.com/search?udm=8&htidocid=abc123';
      assert(canonicalInterviewJobUrl(credentialedGoogle) === null && !normalizeInterviewPreparationJobUrl(credentialedGoogle), 'credential-bearing inputs must be rejected before Google repair can erase their origin');
    },
  },
  {
    name: 'interview helper: rejects unsafe persisted preparation display text',
    run: () => {
      const bundleId = 'b'.repeat(64);
      const digest = 'c'.repeat(64);
      const brief = {
        version: 1,
        briefId: 'd'.repeat(64),
        createdAt: '2026-10-08T00:00:00.000Z',
        inputs: { careerSnapshotId: INTERVIEW_SNAPSHOT_ID, jobUrlSha256: 'e'.repeat(64), applicationArtifactId: bundleId, applicationArtifactDigest: digest },
        role: { title: 'Café — Product', company: 'Acme', location: 'Toronto', summary: 'Owns product outcomes.' },
        roleThemes: [], companyFacts: [], recentContext: [], likelyQuestions: [], questionsToAsk: [], applicationPositioning: [], sources: [], warnings: [],
      };
      assert(validInterviewPreparationBrief(brief, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'ordinary non-ASCII letters and punctuation remain valid display text');
      const emptySummary = structuredClone(brief); emptySummary.role.summary = '';
      assert(validInterviewPreparationBrief(emptySummary, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'an explicitly empty worker summary must remain valid when persisted in the canvas');
      const missingRoleField = structuredClone(brief); delete missingRoleField.role.summary;
      const nullRoleField = structuredClone(brief); nullRoleField.role.location = null;
      assert(!validInterviewPreparationBrief(missingRoleField, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'every public role key must be present');
      assert(!validInterviewPreparationBrief(nullRoleField, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'non-summary public role keys must be safe nonempty strings');
      const bidi = structuredClone(brief); bidi.role.title = 'Café\u202E — Product';
      const c1 = structuredClone(brief); c1.role.summary = 'Owns\u0085 product outcomes.';
      assert(!validInterviewPreparationBrief(bidi, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'bidi controls must not persist in brief display text');
      assert(!validInterviewPreparationBrief(c1, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'C1 controls must not persist in brief display text');
    },
  },
  {
    name: 'interview helper: preparation brief never permits application excerpts in canvas state',
    run: () => {
      const bundleId = 'b'.repeat(64);
      const digest = 'c'.repeat(64);
      const brief = {
        version: 1,
        briefId: 'd'.repeat(64),
        createdAt: '2026-10-08T00:00:00.000Z',
        inputs: { careerSnapshotId: INTERVIEW_SNAPSHOT_ID, jobUrlSha256: 'e'.repeat(64), applicationArtifactId: bundleId, applicationArtifactDigest: digest },
        role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Owns product outcomes.' },
        roleThemes: [], companyFacts: [{ fact: 'Acme serves teams.', sourceId: 'source-1', sourceUrl: 'https://acme.test/news', sourceDate: '2026-01-01' }], recentContext: [], likelyQuestions: [], questionsToAsk: [],
        applicationPositioning: [{ documentKind: 'resume', point: 'Emphasizes delivery leadership.' }], sources: [], warnings: [],
      };
      assert(validInterviewPreparationBrief(brief, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'compact application positioning should be accepted');
      const excerpt = structuredClone(brief);
      excerpt.applicationPositioning[0].evidenceQuote = 'Candidate led delivery at a private employer.';
      assert(!validInterviewPreparationBrief(excerpt, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'application excerpts must be rejected before canvas persistence');
      const nested = structuredClone(brief);
      nested.inputs.rawListing = 'do not persist';
      assert(!validInterviewPreparationBrief(nested, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'brief inputs must reject nested extras');
      const roleExtra = structuredClone(brief);
      roleExtra.role.rawCompanyResearch = 'do not persist';
      assert(!validInterviewPreparationBrief(roleExtra, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'brief role must reject nested extras');
      const sourceQuote = structuredClone(brief);
      sourceQuote.companyFacts[0].evidenceQuote = 'Acme serves teams.';
      assert(!validInterviewPreparationBrief(sourceQuote, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'research evidence quotes must not be smuggled into canvas state');
      const privateCitation = structuredClone(brief);
      privateCitation.companyFacts[0].sourceUrl = 'https://acme.test/news?access_token=top-secret#candidate@example.test';
      assert(!validInterviewPreparationBrief(privateCitation, { snapshotId: INTERVIEW_SNAPSHOT_ID, bundleArtifactId: bundleId, bundleDigest: digest }), 'a restored canvas brief must reject citations that retain query or fragment data');
    },
  },
  {
    name: 'interview helper: extracts canonical role, achievement, project, and direct skill evidence with provenance',
    run: () => {
      const evidence = extractInterviewProfileEvidence(profileFixture());
      const ids = evidence.map(item => item.id);
      assert(ids.includes('role:role-acme:title'), 'role title should be available as canonical evidence');
      assert(ids.includes('achievement:achievement-onboarding:claim'), 'achievement claim should be available as canonical evidence');
      assert(ids.includes('project:project-dashboard:description'), 'project description should be available as canonical evidence');
      assert(ids.includes('project:project-dashboard:name') && ids.includes('project:project-atlas:name'), 'project names must remain dedicated exact evidence even when descriptions exist');
      assert(ids.includes('skill:skill-react:name'), 'direct index-eligible skill should be available as canonical evidence');
      assert(!ids.includes('skill:skill-conditional:name'), 'relationship-qualified skills must not be rendered as standalone capability cues');
      const onboarding = evidence.find(item => item.id === 'achievement:achievement-onboarding:claim');
      assert(onboarding.cue === 'Improved onboarding conversion by testing a simpler setup flow.', 'cue must retain exact structured career text');
      assert(onboarding.evidenceSegmentIds[0] === 'segment-0003' && onboarding.entityId === 'achievement-onboarding', 'evidence must retain exact source ids');
      const whitespaceProfile = profileFixture();
      whitespaceProfile.achievements[0].claim = '  Improved onboarding conversion by testing a simpler setup flow.  ';
      const whitespaceEvidence = extractInterviewProfileEvidence(whitespaceProfile).find(item => item.id === 'achievement:achievement-onboarding:claim');
      assert(whitespaceEvidence.cue === whitespaceProfile.achievements[0].claim, 'cue must retain source-field whitespace verbatim rather than rewriting the evidence');
      return { evidenceCount: evidence.length };
    },
  },
  {
    name: 'interview helper: retrieves role, achievement, project, and skill from strong lexical evidence',
    run: () => {
      const profile = profileFixture();
      const cases = [
        ['Tell me about your Product Manager role at Acme.', 'role-acme'],
        ['How did you improve onboarding conversion?', 'achievement-onboarding'],
        ['Tell me about the analytics dashboard.', 'project-dashboard'],
        ['How have you used React?', 'skill-react'],
      ];
      for (const [question, expectedId] of cases) {
        const plan = buildInterviewPlan({ question, profile, snapshotId: 'snapshot-demo' });
        assert(plan.status === 'supported', `${question} should retrieve grounded evidence`);
        assert(plan.steps.some(step => step.provenance.entityId === expectedId), `${question} should retain ${expectedId} provenance`);
        assert(plan.snapshotId === 'snapshot-demo', 'plan should retain the supplied immutable snapshot id');
      }
    },
  },
  {
    name: 'interview helper: technology ledger labels never create a hidden capability match',
    run: () => {
      const profile = {
        roles: [],
        achievements: [{
          id: 'achievement-vendor-portal', roleId: '', claim: 'Led a customer renewal review.',
          technologies: ['Vendor Portal'],
          technologyReferences: [{ technology: 'Vendor Portal', disposition: 'non-skill', nonSkillReason: 'vendor-owned system', relationship: 'independent' }],
          metrics: [], evidenceSegmentIds: ['segment-technology-1'],
        }, {
          id: 'achievement-alternative-platforms', roleId: '', claim: 'Coordinated the rollout review.',
          technologies: ['Cedar', 'Juniper'],
          technologyReferences: [
            { technology: 'Cedar', disposition: 'skill', relationship: 'alternative', relationshipGroup: 'platform-choice' },
            { technology: 'Juniper', disposition: 'skill', relationship: 'alternative', relationshipGroup: 'platform-choice' },
          ],
          metrics: [], evidenceSegmentIds: ['segment-technology-2'],
        }, {
          id: 'achievement-visible-python', roleId: '', claim: 'Improved the Python integration rollout.',
          technologies: ['Internal Gateway'], metrics: [], evidenceSegmentIds: ['segment-technology-3'],
        }],
        projects: [{
          id: 'project-visible-python', roleId: '', name: 'Service Portal',
          description: 'Built a Python service portal for requests.', technologies: ['Internal Gateway'], metrics: [], evidenceSegmentIds: ['segment-technology-3'],
        }],
        skills: [{
          id: 'skill-python', name: 'Python', category: 'language', supportMode: 'direct', indexEligible: true,
          roleIds: [], evidenceSegmentIds: ['segment-technology-4'], directEvidenceSegmentIds: ['segment-technology-4'],
        }, {
          id: 'skill-cedar', name: 'Cedar', category: 'platform', supportMode: 'relationship-qualified', indexEligible: false,
          roleIds: [], evidenceSegmentIds: ['segment-technology-2'], directEvidenceSegmentIds: [],
        }, {
          id: 'skill-juniper', name: 'Juniper', category: 'platform', supportMode: 'relationship-qualified', indexEligible: false,
          roleIds: [], evidenceSegmentIds: ['segment-technology-2'], directEvidenceSegmentIds: [],
        }],
        education: [], certifications: [], otherEvidence: [],
      };
      for (const question of ['How did you use Vendor Portal?', 'How did you use Cedar and Juniper?']) {
        const plan = buildInterviewPlan({ question, profile });
        assert(plan.status === 'unsupported' && plan.steps.length === 0, `${question} must not turn a non-skill or relationship-qualified technology label into an answer rail`);
      }
      const visibleClaim = buildInterviewPlan({ question: 'How did you improve the Python integration rollout?', profile });
      assert(visibleClaim.status === 'supported' && visibleClaim.steps.some(step => step.provenance.entityId === 'achievement-visible-python'), 'a literal technology in the displayed achievement claim must remain retrievable');
      const visibleDescription = buildInterviewPlan({ question: 'How did you build a Python service portal?', profile });
      assert(visibleDescription.status === 'supported' && visibleDescription.steps.some(step => step.provenance.entityId === 'project-visible-python'), 'a literal technology in the displayed project description must remain retrievable');
      const directSkill = buildInterviewPlan({ question: 'How have you used Python?', profile });
      assert(directSkill.status === 'supported' && directSkill.steps.some(step => step.provenance.entityId === 'skill-python'), 'a vetted direct skill must remain retrievable for an exact usage question');
    },
  },
  {
    name: 'interview helper: permits only exact single-word employer and project-name entities',
    run: () => {
      const profile = profileFixture();
      const employer = buildInterviewPlan({ question: 'What did you do at Acme?', profile });
      assert(employer.status === 'supported' && employer.steps.map(step => step.cue).join(',') === 'Acme', 'single-word employer lookup must emit only its dedicated exact cue');
      const atlas = buildInterviewPlan({ question: 'Tell me about Atlas?', profile });
      assert(atlas.status === 'supported' && atlas.steps.map(step => step.cue).join(',') === 'Atlas', 'single-word project-name lookup must not pull its description or unrelated achievements');
    },
  },
  {
    name: 'interview helper: rejects lone generic matches while retaining a direct vetted skill-use question',
    run: () => {
      const profile = profileFixture();
      for (const question of [
        'Can you discuss conversion?',
        'Can you discuss product?',
        'Can you discuss a React bug?',
        'Can you discuss a C++ bug?',
      ]) {
        const plan = buildInterviewPlan({ question, profile });
        assert(plan.status === 'unsupported' && plan.steps.length === 0, `${question} must not select an unrelated saved story from one word`);
      }
      const react = buildInterviewPlan({ question: 'How have you used React?', profile });
      assert(react.status === 'supported' && react.steps.some(step => step.provenance.entityId === 'skill-react'), 'a direct usage question for a vetted direct/index-eligible skill must remain supported');
      const cpp = buildInterviewPlan({ question: 'How have you used C++?', profile });
      assert(cpp.status === 'supported' && cpp.steps.some(step => step.provenance.entityId === 'skill-cpp'), 'a direct usage question must support an exact vetted punctuation-bearing skill name');
    },
  },
  {
    name: 'interview helper: admits literal behavioral narratives through controlled action and conflict families only',
    run: () => {
      const leadership = profileFixture();
      leadership.achievements[1].claim = 'Led a cross-functional team through a difficult platform migration.';
      const ledTeam = buildInterviewPlan({ question: 'Tell me about a time you led a team', profile: leadership });
      assert(ledTeam.status === 'supported', 'an irregular lead/led match with literal narrative evidence should not be a false no-fit');
      assert(ledTeam.steps[0].cue === leadership.achievements[1].claim, 'behavioral retrieval must retain the exact saved narrative cue');
      assert(ledTeam.steps[0].match.terms.join(',') === 'lead', 'the exception must use the normalized literal action anchor');
      const leadershipExperience = buildInterviewPlan({ question: 'Tell me about your leadership experience', profile: leadership });
      assert(leadershipExperience.status === 'supported' && leadershipExperience.steps[0].cue === leadership.achievements[1].claim, 'leadership must normalize to the same narrow literal lead family as a saved led narrative');
      const managementExperience = buildInterviewPlan({ question: 'Tell me about your management experience', profile: leadership });
      assert(managementExperience.status === 'unsupported' && managementExperience.steps.length === 0, 'related behavioral categories without a shared literal action anchor must not become a synonym-based match');

      const conflict = profileFixture();
      conflict.achievements[1].claim = 'Resolved stakeholder pushback during a platform migration.';
      const stakeholderConflict = buildInterviewPlan({ question: 'Describe a conflict with a stakeholder', profile: conflict });
      assert(stakeholderConflict.status === 'supported', 'a literal stakeholder anchor plus the controlled conflict family should be supported');
      assert(stakeholderConflict.steps[0].cue === conflict.achievements[1].claim, 'conflict retrieval must not rewrite the source evidence');

      const ordinaryStakeholder = profileFixture();
      ordinaryStakeholder.achievements[1].claim = 'Shared weekly status updates with stakeholders during the platform migration.';
      const unsupported = buildInterviewPlan({ question: 'Describe a conflict with a stakeholder', profile: ordinaryStakeholder });
      assert(unsupported.status === 'unsupported' && unsupported.steps.length === 0, 'stakeholder alone must not turn ordinary communication into a conflict story');
    },
  },
  {
    name: 'interview helper: normalizes only controlled verb inflections for literal evidence matching',
    run: () => {
      const profile = {
        ...profileFixture(),
        achievements: [{ id: 'achievement-reliability', roleId: 'role-acme', claim: 'Improved reliability during a platform migration.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-reliability'] }],
        projects: [], skills: [],
      };
      const reliability = buildInterviewPlan({ question: 'How did you improve reliability?', profile });
      assert(reliability.status === 'supported' && reliability.steps[0].cue === profile.achievements[0].claim, 'improve and improved should retrieve the exact literal reliability evidence');

      const shipped = {
        ...profile,
        achievements: [{ id: 'achievement-release', roleId: 'role-acme', claim: 'Shipped the release.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-release'] }],
      };
      const release = buildInterviewPlan({ question: 'How did you ship the release?', profile: shipped });
      assert(release.status === 'supported' && release.steps[0].cue === shipped.achievements[0].claim, 'the controlled doubled-consonant ship/shipped form should remain a literal match');
      assert(interviewHelperTerms('reduce reduced reducing resolve resolved resolving plan planned planning').join(',') === 'reduce,resolve,plan', 'the explicit morphology allow-list should cover only the selected silent-e and doubled-consonant verb families');

      const unrelated = buildInterviewPlan({ question: 'How did you improve reliability?', profile: profileFixture() });
      assert(unrelated.status === 'unsupported' && unrelated.steps.length === 0, 'a single normalized improve term must not inject an unrelated saved improvement story');
    },
  },
  {
    name: 'interview helper: behavioral exception preserves one deterministic role rail',
    run: () => {
      const profile = {
        ...profileFixture(),
        roles: [
          { id: 'role-first', title: 'Program Manager', employer: 'First', evidenceSegmentIds: ['segment-role-first'] },
          { id: 'role-second', title: 'Program Manager', employer: 'Second', evidenceSegmentIds: ['segment-role-second'] },
        ],
        achievements: [
          { id: 'achievement-first-lead', roleId: 'role-first', claim: 'Led a cross-functional team through a difficult platform migration.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-first-lead'] },
          { id: 'achievement-second-lead', roleId: 'role-second', claim: 'Led a cross-functional team through a difficult billing migration.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-second-lead'] },
        ],
        projects: [], skills: [],
      };
      const plan = buildInterviewPlan({ question: 'Tell me about a time you led a team', profile });
      assert(plan.status === 'supported', 'the first stable behavioral match should select a grounded path');
      assert(plan.steps.map(step => step.provenance.entityId).join(',') === 'achievement-first-lead', 'a behavioral rail must not stitch same-family stories from different roles');
      assert(plan.steps.every(step => step.provenance.roleId === 'role-first'), 'the selected rail must retain one exact role boundary');
    },
  },
  {
    name: 'interview helper: explicit generic profile prompts use canonical order without inventing an accomplishment rank',
    run: () => {
      const profile = profileFixture();
      for (const question of ['Tell me about yourself', 'Walk me through your background', 'Walk me through your resume', 'Walk me through your experience']) {
        const plan = buildInterviewPlan({ question, profile });
        assert(plan.status === 'supported', `${question} should use the saved profile overview path`);
        assert(plan.steps.length <= INTERVIEW_HELPER_MAX_STEPS && plan.steps.every(step => step.provenance.roleId === 'role-acme'), 'overview must stay capped and within one canonical role path');
        assert(plan.steps.slice(0, 2).map(step => step.cue).join('|') === 'Product Manager|Acme', 'overview must begin with exact source-ordered role context');
        assert(/do not claim an unsaved ranking/iu.test(plan.message), 'overview must disclose that profile order is not a ranking');
      }
      const scopedExperience = buildInterviewPlan({ question: 'Walk me through your experience with React', profile });
      assert(scopedExperience.status === 'supported' && scopedExperience.steps.map(step => step.cue).join(',') === 'React', 'a scoped experience question must use its exact capability path rather than the overview rail');
      const accomplishment = buildInterviewPlan({ question: 'What is your biggest accomplishment?', profile });
      assert(accomplishment.status === 'supported' && accomplishment.steps.map(step => step.provenance.entityId).join(',') === 'achievement-onboarding', 'an accomplishment prompt should expose one exact canonical achievement without cross-role injection');
      assert(accomplishment.steps[0].cue === profile.achievements[0].claim && /do not claim an unsaved ranking/iu.test(accomplishment.message), 'the accomplishment cue must be exact and must not assert that it is biggest');

      const noAccomplishments = { ...profile, achievements: [] };
      const unsupported = buildInterviewPlan({ question: 'What is your biggest accomplishment?', profile: noAccomplishments });
      assert(unsupported.status === 'unsupported' && unsupported.steps.length === 0, 'an accomplishment prompt remains unsupported when no saved accomplishment exists');
    },
  },
  {
    name: 'interview helper: role title matching does not emit an unrelated employer cue',
    run: () => {
      const plan = buildInterviewPlan({ question: 'Tell me about your Product Manager role?', profile: profileFixture() });
      assert(plan.status === 'supported', 'two title terms should clear the lexical threshold');
      assert(plan.steps.some(step => step.cue === 'Product Manager'), 'matched title should remain a usable exact cue');
      assert(!plan.steps.some(step => step.cue === 'Acme'), 'title matching must not cross-search into a separate employer cue');
    },
  },
  {
    name: 'interview helper: plans use only exact evidence fields and never fabricate a result or lesson',
    run: () => {
      const profile = profileFixture();
      const plan = buildInterviewPlan({ question: 'How did you improve onboarding conversion?', profile });
      const allowedCues = new Set([
        'Product Manager', 'Acme', 'Improved onboarding conversion by testing a simpler setup flow.',
        'Led the platform migration with partner teams.', 'Built an analytics dashboard for weekly retention reviews.', 'React',
      ]);
      assert(plan.steps.length > 0, 'fixture should produce a grounded rail');
      assert(plan.steps.every(step => allowedCues.has(step.cue)), 'every cue must be an exact structured profile value');
      assert(!plan.steps.some(step => /result|lesson|%|success/iu.test(step.cue)), 'engine must not manufacture a result or lesson');
      const first = plan.steps[0];
      assert(first.provenance.entityId === 'achievement-onboarding', 'strongest evidence should be the directly matching achievement');
      assert(first.provenance.evidenceSegmentIds[0] === 'segment-0003', 'step provenance must expose exact segment id');
    },
  },
  {
    name: 'interview helper: no fit returns a truthful unsupported plan with no steps',
    run: () => {
      const plan = buildInterviewPlan({ question: 'How do you negotiate a real-estate lease?', profile: profileFixture() });
      assert(plan.status === 'unsupported', 'unrelated question should not select a career story');
      assert(plan.steps.length === 0 && plan.evidence.length === 0, 'unsupported plan must not construct a guessed rail');
      assert(/truthful experience that is not present/iu.test(plan.message), 'unsupported plan should directly state that a truthful unsaved experience is required');
    },
  },
  {
    name: 'interview helper: equal evidence scores preserve profile order',
    run: () => {
      const profile = {
        ...profileFixture(),
        roles: [], projects: [], skills: [],
        achievements: [
          { id: 'achievement-first', roleId: '', claim: 'Improved payment reconciliation.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0010'] },
          { id: 'achievement-second', roleId: '', claim: 'Improved payment reconciliation.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0011'] },
        ],
      };
      const ranked = rankInterviewEvidence('How did you improve payment reconciliation?', profile);
      assert(ranked.map(item => item.entityId).join(',') === 'achievement-first,achievement-second', 'equal scores must retain source order');
    },
  },
  {
    name: 'interview helper: rail caps at six exact evidence steps from one role path',
    run: () => {
      const profile = {
        ...profileFixture(), roles: [], projects: [], skills: [],
        achievements: Array.from({ length: 7 }, (_, index) => ({
          id: `achievement-${index + 1}`, roleId: 'role-platform', claim: `Improved platform workflow ${index + 1}.`, technologies: [], metrics: [], evidenceSegmentIds: [`segment-01${index}`],
        })),
      };
      const plan = buildInterviewPlan({ question: 'How did you improve the platform workflow?', profile });
      assert(plan.status === 'supported' && plan.steps.length === INTERVIEW_HELPER_MAX_STEPS, 'plan must be capped at six steps');
      assert(plan.steps.map(step => step.provenance.entityId).join(',') === 'achievement-1,achievement-2,achievement-3,achievement-4,achievement-5,achievement-6', 'cap must preserve ranked stable order');
    },
  },
  {
    name: 'interview helper: rail keeps one role path, orders it conversationally, and retains exact same-role evidence',
    run: () => {
      const profile = {
        ...profileFixture(),
        roles: [
          { id: 'role-north', title: 'Product Operations Lead', employer: 'Northstar', evidenceSegmentIds: ['segment-north-role'] },
          { id: 'role-south', title: 'Product Operations Lead', employer: 'Southstar', evidenceSegmentIds: ['segment-south-role'] },
        ],
        achievements: [
          { id: 'achievement-north', roleId: 'role-north', claim: 'Improved onboarding conversion with React.', technologies: ['React'], metrics: [], evidenceSegmentIds: ['segment-north-achievement'] },
          { id: 'achievement-south', roleId: 'role-south', claim: 'Improved onboarding conversion with React.', technologies: ['React'], metrics: [], evidenceSegmentIds: ['segment-south-achievement'] },
        ],
        projects: [
          { id: 'project-north', roleId: 'role-north', name: 'North onboarding', description: 'Built React onboarding conversion workflow.', technologies: ['React'], metrics: [], evidenceSegmentIds: ['segment-north-project'] },
        ],
        skills: [{ id: 'skill-north-react', name: 'React', category: 'frontend', supportMode: 'direct', indexEligible: true, roleIds: ['role-north'], evidenceSegmentIds: ['segment-north-skill'], directEvidenceSegmentIds: ['segment-north-skill'] }],
      };
      const question = 'How have you used React to improve onboarding conversion in your Product Operations Lead role?';
      const first = buildInterviewPlan({ question, profile });
      const second = buildInterviewPlan({ question, profile });
      const cues = first.steps.map(step => step.cue);
      const entityIds = first.steps.map(step => step.provenance.entityId);
      assert(first.status === 'supported', 'the shared role path should remain supported');
      assert(entityIds.join(',') === 'role-north,achievement-north,project-north,skill-north-react', 'independently-qualified context, story evidence, and a direct skill should follow one deterministic role path');
      assert(!entityIds.includes('achievement-south') && !first.steps.some(step => step.provenance.roleId === 'role-south'), 'equally relevant evidence from another role must never be stitched into the answer path');
      assert(cues.join('|') === 'Product Operations Lead|Improved onboarding conversion with React.|Built React onboarding conversion workflow.|React', 'the rail must preserve source strings exactly and use the conversational role-to-story-to-skill order');
      assert(first.steps.map(step => step.id).join(',') === second.steps.map(step => step.id).join(','), 'coherent path ordering must be stable across identical retrievals');
      assert(first.steps.every(step => step.provenance.roleId === 'role-north'), 'all retained role-linked cues must preserve one role provenance boundary');
    },
  },
  {
    name: 'interview helper: unlinked anchor does not blend matching records without a role boundary',
    run: () => {
      const profile = {
        ...profileFixture(), roles: [], projects: [], skills: [],
        achievements: [
          { id: 'achievement-first', roleId: '', claim: 'Improved payment reconciliation.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0010'] },
          { id: 'achievement-second', roleId: '', claim: 'Improved payment reconciliation.', technologies: [], metrics: [], evidenceSegmentIds: ['segment-0011'] },
        ],
      };
      const plan = buildInterviewPlan({ question: 'How did you improve payment reconciliation?', profile });
      assert(plan.status === 'supported' && plan.steps.map(step => step.provenance.entityId).join(',') === 'achievement-first', 'a standalone anchor must stay with its exact entity instead of merging unrelated records');
    },
  },
  {
    name: 'interview helper: matched plan locks across transcript revisions until explicit next question',
    run: () => {
      const profile = profileFixture();
      let session = createInterviewHelperSession();
      session = interviewHelperSessionReducer(session, { type: 'receive-question', question: 'How did you improve onboarding conversion?', profile });
      const lockedPlan = session.activePlan;
      assert(session.locked && lockedPlan.status === 'supported', 'first supported plan should lock');
      const revised = interviewHelperSessionReducer(session, { type: 'receive-question', question: 'Tell me about the analytics dashboard.', profile });
      assert(revised === session && revised.activePlan === lockedPlan, 'revision must not replace a locked answer path');
      session = interviewHelperSessionReducer(session, { type: 'next-question' });
      assert(!session.locked && session.activePlan === null, 'explicit next question should unlock and clear the rail');
      session = interviewHelperSessionReducer(session, { type: 'receive-question', question: 'Tell me about the analytics dashboard.', profile });
      assert(session.locked && session.activePlan.steps.some(step => step.provenance.entityId === 'project-dashboard'), 'new turn should allow a new grounded plan');
    },
  },
  {
    name: 'interview helper: unsupported partial question stays unlocked for a later grounded question',
    run: () => {
      const profile = profileFixture();
      let session = createInterviewHelperSession();
      session = interviewHelperSessionReducer(session, { type: 'receive-question', question: 'How do you negotiate a real-estate lease?', profile });
      assert(session.activePlan.status === 'unsupported' && !session.locked, 'unsupported question must not lock the session');
      session = interviewHelperSessionReducer(session, { type: 'receive-question', question: 'How did you improve onboarding conversion?', profile });
      assert(session.activePlan.status === 'supported' && session.locked, 'later grounded question must still be eligible to lock');
    },
  },
  {
    name: 'interview helper: education and certifications remain exact, grounded evidence',
    run: () => {
      const profile = {
        ...profileFixture(),
        education: [{ id: 'education-1', institution: 'University of Toronto', credential: 'Bachelor of Science in Computer Science', dates: '2017', evidenceSegmentIds: ['segment-0012'] }],
        certifications: [{ id: 'certification-1', name: 'AWS Certified Cloud Practitioner', issuer: 'AWS', dates: '2024', evidenceSegmentIds: ['segment-0013'] }],
      };
      const education = buildInterviewPlan({ question: 'Tell me about your Computer Science degree.', profile });
      const certification = buildInterviewPlan({ question: 'Do you hold the AWS Certified Cloud Practitioner certification?', profile });
      assert(education.steps.some(step => step.cue === 'Bachelor of Science in Computer Science' && step.provenance.entityId === 'education-1' && step.provenance.evidenceSegmentIds[0] === 'segment-0012'), 'education cue and provenance must use exact structured fields');
      assert(certification.steps.some(step => step.cue === 'AWS Certified Cloud Practitioner' && step.provenance.entityId === 'certification-1' && step.provenance.evidenceSegmentIds[0] === 'segment-0013'), 'certification cue and provenance must use exact structured fields');
    },
  },
  {
    name: 'interview helper: hidden sibling metadata never makes a displayed cue retrievable',
    run: () => {
      const profile = {
        roles: [], achievements: [], projects: [],
        skills: [{
          id: 'skill-visible', name: 'Visible Skill', category: 'Distributed Graph Platform', supportMode: 'direct', indexEligible: true,
          roleIds: [], evidenceSegmentIds: ['segment-hidden-1'], directEvidenceSegmentIds: ['segment-hidden-1'],
        }],
        education: [{ id: 'education-visible', credential: 'Visible Credential', institution: 'Visible Institute', dates: 'Quantum Fellowship', evidenceSegmentIds: ['segment-hidden-2'] }],
        certifications: [{ id: 'certification-visible', name: 'Visible Certification', issuer: 'Visible Issuer', dates: 'Professional Renewal', evidenceSegmentIds: ['segment-hidden-3'] }],
        otherEvidence: [{ id: 'other-visible', kind: 'National Community Award', label: 'Visible Label', text: 'Visible narrative.', evidenceSegmentIds: ['segment-hidden-4'] }],
      };
      const hiddenOnlyQuestions = [
        'How did you use Distributed Graph Platform?',
        'Tell me about Quantum Fellowship.',
        'Tell me about Professional Renewal.',
        'Tell me about National Community Award.',
      ];
      for (const question of hiddenOnlyQuestions) {
        const plan = buildInterviewPlan({ question, profile });
        assert(plan.status === 'unsupported' && plan.steps.length === 0, `${question} must not surface a cue from a hidden sibling field`);
      }
    },
  },
  {
    name: 'interview helper: visible education, certification, and detail fields are independent exact candidates',
    run: () => {
      const profile = {
        roles: [], achievements: [], projects: [], skills: [],
        education: [{ id: 'education-split', credential: 'Bachelor of Science', institution: 'University of Toronto', dates: '2017', evidenceSegmentIds: ['segment-split-1'] }],
        certifications: [{ id: 'certification-split', name: 'AWS Certified Architect', issuer: 'Cloud Council', dates: '2024', evidenceSegmentIds: ['segment-split-2'] }],
        otherEvidence: [{ id: 'other-split', kind: 'award', label: 'Community Leadership Award', text: 'Led a volunteer program.', evidenceSegmentIds: ['segment-split-3'] }],
      };
      const expected = [
        ['Tell me about your Bachelor of Science degree.', 'education-split', 'credential', 'Bachelor of Science'],
        ['Tell me about University of Toronto.', 'education-split', 'institution', 'University of Toronto'],
        ['Tell me about AWS Certified Architect.', 'certification-split', 'name', 'AWS Certified Architect'],
        ['Tell me about Cloud Council.', 'certification-split', 'issuer', 'Cloud Council'],
        ['Tell me about Community Leadership Award.', 'other-split', 'label', 'Community Leadership Award'],
        ['Tell me about how you led a volunteer program.', 'other-split', 'text', 'Led a volunteer program.'],
      ];
      const evidence = extractInterviewProfileEvidence(profile);
      for (const [, entityId, sourceField, cue] of expected) {
        const candidate = evidence.find(item => item.entityId === entityId && item.sourceField === sourceField);
        assert(candidate?.cue === cue, `${sourceField} must retain its own exact source string`);
        assert(candidate.matchingTerms.join(',') === interviewHelperTerms(cue).join(','), `${sourceField} matching terms must come only from its displayed cue`);
      }
      for (const [question, entityId, sourceField, cue] of expected) {
        const plan = buildInterviewPlan({ question, profile });
        assert(plan.status === 'supported' && plan.steps.some(step => (
          step.cue === cue && step.provenance.entityId === entityId && step.provenance.sourceField === sourceField
        )), `${sourceField} should independently retrieve its exact visible cue`);
        assert(plan.steps.length <= INTERVIEW_HELPER_MAX_STEPS, 'split fields must keep the rail bounded');
      }
    },
  },
  {
    name: 'interview helper: reports an explicitly requested but undocumented lesson without inventing a cue',
    run: () => {
      const plan = buildInterviewPlan({ question: 'What did you learn from improving onboarding conversion?', profile: profileFixture() });
      assert(plan.status === 'supported', 'matching achievement should remain usable');
      assert(plan.missingComponents.join(',') === 'lesson', 'missing lesson should be disclosed deterministically');
      assert(!plan.steps.some(step => step.label === 'LESSON' || /learn|lesson/iu.test(step.cue)), 'engine must not create a lesson cue that profile evidence does not contain');
    },
  },
  {
    name: 'interview helper: outcome disclosure and retrieval use only the displayed cue, never hidden metrics',
    run: () => {
      const withHiddenMetric = {
        ...profileFixture(), roles: [], projects: [], skills: [],
        achievements: [{
          id: 'achievement-retention', roleId: '', claim: 'Led a retention review.', technologies: [],
          metrics: [{ label: 'conversion improvement', value: '12 percent' }], evidenceSegmentIds: ['segment-retention'],
        }],
      };
      const requestedOutcome = buildInterviewPlan({ question: 'What was the outcome of your retention review?', profile: withHiddenMetric });
      assert(requestedOutcome.status === 'supported' && requestedOutcome.steps[0].cue === 'Led a retention review.', 'visible retention terms should select the exact displayed cue');
      assert(requestedOutcome.missingComponents.join(',') === 'outcome', 'a hidden metric must not erase an outcome gap from the displayed rail');

      const visibleOutcome = structuredClone(withHiddenMetric);
      visibleOutcome.achievements[0].claim = 'Led a retention review that improved conversion.';
      const documentedOutcome = buildInterviewPlan({ question: 'What was the outcome of your retention review?', profile: visibleOutcome });
      assert(documentedOutcome.status === 'supported' && documentedOutcome.missingComponents.length === 0, 'an outcome literally present in the displayed cue should satisfy the requested outcome');

      const metricOnlyMatch = buildInterviewPlan({ question: 'How did you improve conversion?', profile: withHiddenMetric });
      assert(metricOnlyMatch.status === 'unsupported' && metricOnlyMatch.steps.length === 0, 'hidden metric terms alone must not retrieve a cue with no visible shared terms');
    },
  },
  {
    name: 'interview helper: extracts only the latest completed or question-shaped pasted question',
    run: () => {
      assert(extractLatestInterviewQuestion('Thanks for that. What did you learn from improving onboarding? Can you describe the analytics dashboard?') === 'Can you describe the analytics dashboard?', 'latest completed question should win');
      assert(extractLatestInterviewQuestion('Describe a time you improved onboarding conversion') === 'Describe a time you improved onboarding conversion', 'question-shaped ASR utterance may omit punctuation');
      assert(extractLatestInterviewQuestion('Thanks, that gives me a clear picture of the project') === null, 'ordinary statement must not become a question');
      assert(extractLatestInterviewQuestion('Thanks. That gives me a clear picture.') === null, 'ordinary punctuated transcript must not become a question');
    },
  },
  {
    name: 'interview helper: retains an adjacent story anchor for a generic compound follow-up only',
    run: () => {
      assert(extractLatestInterviewQuestion('Tell me about a difficult stakeholder. What did you do?') === 'Tell me about a difficult stakeholder. What did you do?', 'a generic action follow-up should retain its immediately preceding story anchor');
      assert(extractLatestInterviewQuestion('Describe a difficult stakeholder. What happened') === 'Describe a difficult stakeholder. What happened', 'an unpunctuated generic follow-up should retain its immediately preceding story anchor');
      assert(extractLatestInterviewQuestion('Tell me about improving onboarding. What was the outcome?') === 'Tell me about improving onboarding. What was the outcome?', 'a generic outcome follow-up should retain its immediately preceding story anchor');
      assert(extractLatestInterviewQuestion('Thanks for the context. What did you do?') === 'What did you do?', 'ordinary prior prose must not be merged into a generic follow-up');
      assert(extractLatestInterviewQuestion('What did you learn? What did you do?') === 'What did you do?', 'a prior generic question must not be treated as a story anchor');
      assert(extractLatestInterviewQuestion('Tell me about improving onboarding? Can you describe the analytics dashboard?') === 'Can you describe the analytics dashboard?', 'a distinct latest interviewer question must still replace the earlier question');
    },
  },
  {
    name: 'interview helper: plan retrieval uses only the latest pasted question and rejects ordinary prose',
    run: () => {
      const profile = profileFixture();
      const plan = buildInterviewPlan({
        question: 'How did you improve onboarding conversion? Can you describe the analytics dashboard?',
        profile,
      });
      assert(plan.status === 'supported', 'latest pasted question should retrieve a grounded plan');
      assert(plan.analysis.transcript === 'Can you describe the analytics dashboard?', 'plan analysis must use only the extracted latest question');
      assert(plan.steps[0].provenance.entityId === 'project-dashboard', 'latest project question must not be diluted by earlier achievement words');
      const compound = buildInterviewPlan({
        question: 'Tell me about improving onboarding conversion. What did you do?',
        profile,
      });
      assert(compound.status === 'supported', 'a generic compound follow-up should retain the story terms needed for grounded retrieval');
      assert(compound.analysis.transcript === 'Tell me about improving onboarding conversion. What did you do?', 'plan analysis must retain only the adjacent story anchor and its generic follow-up');
      assert(compound.steps.some(step => step.provenance.entityId === 'achievement-onboarding'), 'the retained story anchor should retrieve its matching evidence');
      const ordinary = buildInterviewPlan({ question: 'Thanks, that gives me a clear picture of the project', profile });
      assert(ordinary.status === 'unsupported' && ordinary.steps.length === 0, 'ordinary statement must not generate a plan');
    },
  },
  {
    name: 'interview helper: question extraction is idempotent so a saved rail re-verifies from its own transcript',
    run: () => {
      const profile = profileFixture();
      for (const question of [
        'Describe improving onboarding conversion. ...',
        'How did you improve onboarding conversion. !',
        'Tell me about improving onboarding conversion. What did you do. ...',
        'Describe improving onboarding conversion.',
      ]) {
        const extracted = extractLatestInterviewQuestion(question);
        assert(extracted && extractLatestInterviewQuestion(extracted) === extracted, `extraction must be a no-op on its own output: ${question}`);
        const plan = buildInterviewPlan({ question, profile, snapshotId: 'a'.repeat(64) });
        assert(plan.status === 'supported', `fixture question should be grounded: ${question}`);
        const rebuilt = buildInterviewPlan({ question: plan.analysis.transcript, profile, snapshotId: 'a'.repeat(64) });
        assert(JSON.stringify(rebuilt) === JSON.stringify(plan), `a persisted rail must rebuild identically from its transcript: ${question}`);
      }
      assert(extractLatestInterviewQuestion('Describe improving onboarding conversion. ...') === 'Describe improving onboarding conversion', 'trailing standalone punctuation must be removed with the terminal period');
      assert(extractLatestInterviewQuestion('Thanks. That gives me a clear picture. .') === null, 'ordinary prose with stray punctuation must still be rejected');
    },
  },
  {
    name: 'interview helper: invisible format and control characters never reach a plan transcript',
    run: () => {
      const profile = profileFixture();
      const zwj = String.fromCodePoint(0x200D);
      const softHyphen = String.fromCodePoint(0xAD);
      const zeroWidthSpace = String.fromCodePoint(0x200B);
      const bom = String.fromCodePoint(0xFEFF);
      const bell = String.fromCodePoint(0x07);
      const unsafe = /[\p{Cf}]|[^\P{Cc}\t\n\r]/u;
      for (const question of [
        `How did you improve onboarding conversion for the ${String.fromCodePoint(0x1F469)}${zwj}${String.fromCodePoint(0x1F4BB)} team?`,
        `How did you improve on${softHyphen}boarding conversion?`,
        `How did you improve onboarding${zeroWidthSpace} conversion?`,
        `${bom}How did you improve onboarding${bell} conversion?`,
      ]) {
        const plan = buildInterviewPlan({ question, profile, snapshotId: 'a'.repeat(64) });
        assert(plan.status === 'supported', `an invisible character must not change whether a grounded question matches: ${JSON.stringify(question)}`);
        assert(!unsafe.test(plan.analysis.transcript), `the plan transcript must not carry format/control characters: ${JSON.stringify(plan.analysis.transcript)}`);
        assert(plan.steps.some(step => step.provenance.entityId === 'achievement-onboarding'), 'the cleaned question should retrieve the onboarding evidence');
      }
      const multiline = buildInterviewPlan({ question: 'Tell me about improving onboarding conversion.\nWhat did you do?', profile, snapshotId: 'a'.repeat(64) });
      assert(multiline.status === 'supported' && multiline.analysis.transcript.includes('\n'), 'ordinary newlines remain permitted transcript text');
    },
  },
  {
    name: 'interview helper IPC: accepts only strict snapshot and log-safe node identifiers',
    run: () => {
      assert(isInterviewHelperSnapshotId(INTERVIEW_SNAPSHOT_ID), 'lowercase 64-hex snapshot id should be accepted');
      assert(!isInterviewHelperSnapshotId(INTERVIEW_SNAPSHOT_ID.toUpperCase()), 'uppercase snapshot id must be rejected');
      assert(!isInterviewHelperSnapshotId(` ${INTERVIEW_SNAPSHOT_ID}`), 'snapshot id whitespace must be rejected rather than normalized');
      assert(isInterviewHelperNodeId('interview-helper_01'), 'canvas-safe node id should be accepted');
      assert(!isInterviewHelperNodeId('node\nforged'), 'control characters must not enter IPC task logs');
      assert(!isInterviewHelperNodeId(' node'), 'whitespace node ids must be rejected');
      assert(!isInterviewHelperNodeId('a'.repeat(161)), 'oversized node ids must be rejected');
    },
  },
  {
    name: 'interview helper IPC: projects only allowlisted career facts with opaque direct provenance',
    run: () => {
      const projected = projectInterviewHelperCareerSnapshot(approvedSnapshotFixture());
      const serialized = JSON.stringify(projected);
      assert(projected.snapshotId === INTERVIEW_SNAPSHOT_ID && projected.schemaVersion === 6, 'projection should retain immutable snapshot identity');
      assert(!Object.hasOwn(projected, 'sources') && !Object.hasOwn(projected, 'segments'), 'raw source containers must not cross IPC');
      assert(!Object.hasOwn(projected.profile, 'identity'), 'identity and contacts must not cross IPC');
      assert(!serialized.includes('ada@example.test') && !serialized.includes('RAW_LEGACY_SOURCE_SHOULD_NOT_LEAK') && !serialized.includes('RAW_SEGMENT_SOURCE_SHOULD_NOT_LEAK'), 'contacts and raw source text must not leak through the projection');
      const achievement = projected.profile.achievements[0];
      assert(achievement.roleId === 'role-acme' && achievement.evidenceSegmentIds[0] === 'segment-0003', 'role linkage and opaque achievement provenance must survive');
      assert(achievement.metrics[0].evidenceSegmentIds[0] === 'segment-0003', 'metric provenance must survive');
      const skill = projected.profile.skills.find(item => item.id === 'skill-react');
      assert(skill?.directEvidenceSegmentIds.join(',') === 'segment-0005', 'direct skill provenance must survive while malformed ids are filtered');
      assert(skill?.indexEligible === true, 'the vetted direct skill must retain its controlled index-eligibility boolean');
      assert(!projected.profile.skills.some(item => item.id === 'skill-prototype' || item.id === 'skill-conditional'), 'noneligible and relationship-qualified claims must remain outside the standalone Interview Helper skill projection');
      const other = projected.profile.otherEvidence[0];
      assert(other?.id === 'other-award' && other.text === 'Recognized for delivery.' && other.evidenceSegmentIds[0] === 'segment-0008', 'allowlisted other evidence and opaque provenance must survive');
    },
  },
  {
    name: 'interview helper IPC: projected vetted skills permit only direct exact-usage retrieval',
    run: () => {
      const projected = projectInterviewHelperCareerSnapshot(approvedSnapshotFixture());
      const direct = buildInterviewPlan({
        question: 'How have you used React?',
        profile: projected.profile,
        snapshotId: projected.snapshotId,
      });
      assert(direct.status === 'supported' && direct.steps.some(step => step.provenance.entityId === 'skill-react'), 'a current direct/index-eligible skill must support an exact usage question after the real IPC projection');

      for (const question of ['How have you used Prototype?', 'How have you used Legacy CMS?']) {
        const excluded = buildInterviewPlan({ question, profile: projected.profile, snapshotId: projected.snapshotId });
        assert(excluded.status === 'unsupported' && excluded.steps.length === 0, `${question} must not recover a noneligible or relationship-qualified claim from the projected snapshot`);
      }
    },
  },
  {
    name: 'interview helper IPC: injected loader uses the exact storage root and snapshot id and handles a missing pin',
    run: async () => {
      const snapshot = approvedSnapshotFixture();
      const calls = [];
      const loaded = await loadInterviewHelperCareerSnapshot({
        snapshotId: INTERVIEW_SNAPSHOT_ID,
        userDataPath: '/safe-user-data',
        storageRoot: userDataPath => {
          calls.push(['root', userDataPath]);
          return `${userDataPath}/career-snapshot-store`;
        },
        readSnapshot: async (root, snapshotId) => {
          calls.push(['read', root, snapshotId]);
          return snapshot;
        },
      });
      assert(calls.length === 2 && calls[0].join('|') === 'root|/safe-user-data' && calls[1].join('|') === `read|/safe-user-data/career-snapshot-store|${INTERVIEW_SNAPSHOT_ID}`, 'loader must pass the exact user-data-derived root and snapshot address to the injected reader');
      assert(loaded?.snapshotId === INTERVIEW_SNAPSHOT_ID, 'loader should return the allowlisted snapshot projection');
      const missing = await loadInterviewHelperCareerSnapshot({
        snapshotId: INTERVIEW_SNAPSHOT_ID,
        userDataPath: '/safe-user-data',
        storageRoot: value => value,
        readSnapshot: async () => null,
      });
      assert(missing === null, 'a missing historical pin should be represented as null, not a fabricated profile');
    },
  },
  {
    name: 'interview helper IPC: rejects malformed and unapproved snapshots',
    run: async () => {
      const approved = approvedSnapshotFixture();
      assert(throws(() => projectInterviewHelperCareerSnapshot({ ...approved, status: 'draft' })), 'unapproved snapshots must be rejected before projection');
      assert(throws(() => projectInterviewHelperCareerSnapshot({ ...approved, snapshotId: 'A'.repeat(64) })), 'malformed snapshot addresses must be rejected before projection');
      let malformedRejected = false;
      try {
        await loadInterviewHelperCareerSnapshot({
          snapshotId: INTERVIEW_SNAPSHOT_ID,
          userDataPath: '/safe-user-data',
          storageRoot: value => value,
          readSnapshot: async () => ({ ...approved, status: 'draft' }),
        });
      } catch {
        malformedRejected = true;
      }
      assert(malformedRejected, 'loader must reject an unapproved value returned by its reader');
    },
  },
  {
    name: 'interview helper: factory and clone never retain a source-bound saved rail',
    run: () => {
      const fresh = NODE_FACTORIES.interviewhelper({ x: 24, y: 48 });
      assert(fresh.type === 'interviewhelper', 'factory must register the Interview Helper node type');
      assert(fresh.data.interviewHelperSourceNodeId === null
        && fresh.data.interviewHelperSourceSnapshotId === null
        && fresh.data.interviewHelperManualAiCleanup === null
        && fresh.data.interviewHelperLockedPlan === null
        && fresh.data.interviewHelperCurrentStep === 0,
      'fresh helper must start without a source pin, saved plan, or rail cursor');

      const populated = {
        ...fresh,
        id: 'original-helper',
        draggable: false,
        deletable: false,
        data: {
          ...fresh.data,
          locked: true,
          interviewHelperSourceNodeId: 'job-source',
          interviewHelperSourceSnapshotId: INTERVIEW_SNAPSHOT_ID,
          interviewHelperManualAiCleanup: { version: 1, kind: 'preparation', runId: 'interview-helper:prepare:old', status: 'failed' },
          interviewHelperLockedPlan: { status: 'supported', steps: [{ id: 'forged' }] },
          interviewHelperCurrentStep: 4,
        },
      };
      const copied = cloneNode(populated);
      assert(copied.id !== populated.id && copied.selected === true, 'clone must receive a new selected identity');
      assert(copied.data.interviewHelperSourceNodeId === null
        && copied.data.interviewHelperSourceSnapshotId === null
        && copied.data.interviewHelperManualAiCleanup === null
        && copied.data.interviewHelperLockedPlan === null
        && copied.data.interviewHelperCurrentStep === 0,
      'clone must clear all source-bound Interview Helper state');
      assert(copied.data.locked === false && !Object.hasOwn(copied, 'draggable') && !Object.hasOwn(copied, 'deletable'),
        'clone must retain standard unlocked movable/deletable behavior');
    },
  },
  {
    name: 'interview helper: unmeasured layout matches the full setup card footprint',
    run: () => {
      const dims = getNodeDims({ type: 'interviewhelper' });
      assert(dims.w === 350 && dims.h === 560,
        `Interview Helper needs its real 350x560 setup fallback before DOM measurement, got ${dims.w}x${dims.h}`);
    },
  },
  {
    name: 'interview helper IPC: validates node and snapshot ids before task registration or diagnostic logging',
    run: async () => {
      ipcMain.__clearInvokeHandlers();
      const calls = [];
      registerInterviewHelperHandlers({
        appInstance: { getPath: name => `/test-${name}` },
        loadSnapshot: async args => {
          calls.push(args);
          return { snapshotId: args.snapshotId, profile: profileFixture() };
        },
      });
      const handler = ipcMain.__getInvokeHandler('load-interview-helper-career-snapshot');
      assert(typeof handler === 'function', 'Interview Helper must register its IPC route through handleSafe');

      const malformedNode = 'forged-node\n[IPC] fake registration';
      const malformedEvent = senderEvent();
      const beforeMalformedLogs = getRecentLogs().length;
      const malformedNodeResult = await handler(malformedEvent, {
        nodeId: malformedNode,
        snapshotId: INTERVIEW_SNAPSHOT_ID,
      });
      const malformedNodeLogs = getRecentLogs().slice(beforeMalformedLogs);
      assert(malformedNodeResult.success === false && /valid node id/iu.test(malformedNodeResult.error),
        `malformed node ids must be rejected at the IPC boundary, got ${JSON.stringify(malformedNodeResult)}`);
      assert(snapshotActiveNodeTasks(malformedEvent.sender.id).length === 0,
        'a malformed node id must never enter the node-task registry');
      assert(!malformedNodeLogs.some(entry => entry.message.includes(malformedNode)),
        'a malformed node id must never be interpolated into diagnostic logging');
      assert(calls.length === 0, 'a malformed node id must not reach the snapshot loader');

      const malformedSnapshotEvent = senderEvent();
      const malformedSnapshotResult = await handler(malformedSnapshotEvent, {
        nodeId: 'interview-helper-1',
        snapshotId: 'not-a-snapshot-id',
      });
      assert(malformedSnapshotResult.success === false && /valid career snapshot id/iu.test(malformedSnapshotResult.error),
        `malformed snapshot ids must be rejected before registration, got ${JSON.stringify(malformedSnapshotResult)}`);
      assert(snapshotActiveNodeTasks(malformedSnapshotEvent.sender.id).length === 0,
        'a malformed snapshot must not register an otherwise valid node id');
      assert(calls.length === 0, 'a malformed snapshot id must not reach the snapshot loader');

      for (const [extraKey, attackerValue] of [
        ['manualAiRunId', 'forged-run\n[IPC] fake task'],
        ['manualAiRecoveryMode', 'forged-recovery\n[IPC] fake context'],
      ]) {
        const extraMetadataEvent = senderEvent();
        const beforeExtraMetadataLogs = getRecentLogs().length;
        const extraMetadataResult = await handler(extraMetadataEvent, {
          nodeId: 'interview-helper-1',
          snapshotId: INTERVIEW_SNAPSHOT_ID,
          [extraKey]: attackerValue,
        });
        const extraMetadataLogs = getRecentLogs().slice(beforeExtraMetadataLogs);
        assert(extraMetadataResult.success === false && /only nodeId and snapshotId/iu.test(extraMetadataResult.error),
          `${extraKey} must be rejected before generic task metadata is read, got ${JSON.stringify(extraMetadataResult)}`);
        assert(snapshotActiveNodeTasks(extraMetadataEvent.sender.id).length === 0,
          `${extraKey} must not register a node task`);
        assert(!extraMetadataLogs.some(entry => entry.message.includes(attackerValue)),
          `${extraKey} must not be interpolated into diagnostic logging`);
        assert(calls.length === 0, `${extraKey} must not reach the snapshot loader`);
      }

      const inheritedAttackerValue = 'inherited-run\n[IPC] fake inherited task';
      const inheritedMetadataArgs = Object.assign(Object.create({ manualAiRunId: inheritedAttackerValue }), {
        nodeId: 'interview-helper-1',
        snapshotId: INTERVIEW_SNAPSHOT_ID,
      });
      const inheritedMetadataEvent = senderEvent();
      const beforeInheritedMetadataLogs = getRecentLogs().length;
      const inheritedMetadataResult = await handler(inheritedMetadataEvent, inheritedMetadataArgs);
      const inheritedMetadataLogs = getRecentLogs().slice(beforeInheritedMetadataLogs);
      assert(inheritedMetadataResult.success === false && /only nodeId and snapshotId/iu.test(inheritedMetadataResult.error),
        `inherited generic metadata must be rejected before task setup, got ${JSON.stringify(inheritedMetadataResult)}`);
      assert(snapshotActiveNodeTasks(inheritedMetadataEvent.sender.id).length === 0 && calls.length === 0,
        'inherited generic metadata must not register a node or reach the snapshot loader');
      assert(!inheritedMetadataLogs.some(entry => entry.message.includes(inheritedAttackerValue)),
        'inherited generic metadata must not reach diagnostic logging');

      const validEvent = senderEvent();
      const validResult = await handler(validEvent, {
        nodeId: 'interview-helper-1',
        snapshotId: INTERVIEW_SNAPSHOT_ID,
      });
      assert(validResult.success === true && validResult.snapshot?.snapshotId === INTERVIEW_SNAPSHOT_ID,
        `valid Interview Helper requests must still succeed, got ${JSON.stringify(validResult)}`);
      assert(calls.length === 1 && calls[0].snapshotId === INTERVIEW_SNAPSHOT_ID && calls[0].userDataPath === '/test-userData',
        'only the valid request should reach the injected loader with the app-owned user-data path');
      assert(snapshotActiveNodeTasks(validEvent.sender.id).length === 0,
        'a completed valid request must still clean up its task registry entry');
    },
  },
  {
    name: 'interview helper: Google Jobs document ids keep their base64 padding and nothing else',
    run: async () => {
      const { normalizeInterviewPreparationJobUrl } = await import('../../electron/ipc/interviewPreparation.js');
      const padded = 'https://www.google.com/search?q=ada%40example.test&udm=8&htidocid=ZMarQLnfvtRm5rkhAAAAAA%3D%3D&hl=en&token=secret';
      const expected = 'https://www.google.com/search?udm=8&htidocid=ZMarQLnfvtRm5rkhAAAAAA%3D%3D&hl=en';
      assert(canonicalInterviewJobUrl(padded) === expected && normalizeInterviewPreparationJobUrl(padded) === expected,
        `a real padded Google Jobs id must survive canonicalization, got ${canonicalInterviewJobUrl(padded)}`);
      for (const bad of ['abc%3Ddef', 'abc%3D%3D%3D', '%3D%3D']) {
        const url = `https://www.google.com/search?udm=8&htidocid=${bad}`;
        assert(canonicalInterviewJobUrl(url) === 'https://www.google.com/search?udm=8', `'=' outside trailing padding must drop the id: ${bad}`);
      }
    },
  },
  {
    name: 'interview helper: launch refusals the main process names are repeated to the user, everything else stays generic',
    run: async () => {
      const { interviewLaunchErrorMessage } = await import('../../src/utils/interviewHelper.js');
      const wrapped = new Error("Error invoking remote method 'interview-window:launch': Error: Another Interview Helper on this canvas has an active interview rail.");
      assert(/Another Interview Helper on this canvas has an active interview rail/u.test(interviewLaunchErrorMessage(wrapped)), 'a locked-rail refusal must be explained');
      const generic = 'The interview view could not be opened. Try again from the prepared brief.';
      for (const error of [new Error('Interview Window brief is unavailable or changed.'), new Error('/Users/someone/Library/Application Support/x: EACCES'), null, undefined, 'raw string', { message: 42 }]) {
        assert(interviewLaunchErrorMessage(error) === generic, `unknown launch failures must stay generic: ${String(error?.message || error)}`);
      }
    },
  },
  {
    name: 'interview helper: undo/redo removal detection finds helpers at any depth and ignores retained or unrelated nodes',
    run: async () => {
      const { removedInterviewHelperNodes } = await import('../../src/utils/interviewHelper.js');
      const helperA = { id: 'helper-a', type: 'interviewhelper', data: {} };
      const nestedHelper = { id: 'helper-nested', type: 'interviewhelper', data: {} };
      const legacyNested = { id: 'helper-legacy', type: 'interviewhelper', data: {} };
      const group = { id: 'group', type: 'group', data: { canvasData: { nodes: [nestedHelper] } } };
      const legacyGroup = { id: 'legacy-group', type: 'group', data: { nodes: [legacyNested] } };
      const hub = { id: 'hub', type: 'jobhub', data: {} };
      const before = [helperA, group, legacyGroup, hub];
      assert(removedInterviewHelperNodes(before, [hub]).map(node => node.id).join() === 'helper-a,helper-nested,helper-legacy', 'every removed helper, nested or legacy-nested, must be reported');
      assert(removedInterviewHelperNodes(before, [helperA, group, legacyGroup]).length === 0, 'retained helpers are not removals even when an unrelated node went away');
      assert(removedInterviewHelperNodes(before, [{ id: 'moved', type: 'group', data: { canvasData: { nodes: [helperA, nestedHelper, legacyNested] } } }]).length === 0, 'a helper that moved into another canvas is retained, not removed');
      const cyclic = { id: 'cycle', type: 'group', data: { canvasData: { nodes: [] } } };
      cyclic.data.canvasData.nodes.push(cyclic, helperA);
      assert(removedInterviewHelperNodes([cyclic], []).map(node => node.id).join() === 'helper-a', 'a self-referencing group must not loop and still reports its helper');
      assert(removedInterviewHelperNodes(null, undefined).length === 0 && removedInterviewHelperNodes([null, 'x', 42], []).length === 0, 'malformed inputs yield no removals');
    },
  },
];
