import assert from 'node:assert/strict';
import {
  applicationSkillPermittedForPosting, buildApplicationCareerAuthority,
  validateAuthoritySkill, validateAuthoritySkillGroup,
} from '../../electron/ipc/applicationCareerAuthority.js';
import {
  CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION, postingNamedAttestedSkillTerms,
  requiredCareerAttestedSkillTerms, validateStructuredApplicationResume,
} from '../../electron/ipc/structuredResume.js';
import { CAREER_SNAPSHOT_STATUS_APPROVED } from '../../electron/ipc/careerSnapshot.js';

const skill = (id, name, declaredInSkillsSection, extra = {}) => ({
  id, name, indexEligible: true, capabilityKind: 'tool', supportMode: 'direct',
  evidenceSegmentIds: [`segment-${id}`], directEvidenceSegmentIds: [`segment-${id}`],
  ...(declaredInSkillsSection === undefined ? {} : { declaredInSkillsSection }), ...extra,
});
const projection = (...skills) => ({ version: CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION, skills });
const listing = quote => ({ id: 'listing', sourceId: 'job-listing', quote, priority: 'highest' });
const career = { id: 'career', sourceId: 'career-data', quote: 'Built reporting systems using Delta Roster, Birch Ledger, Aster Queue and Cedar Sort.' };
const identity = { name: 'Ada', contact: ['ada@example.test'] };
const sourceRole = { id: 'r1', title: 'Engineer', company: 'Acme', dates: '', location: '' };
function resume(items) {
  return {
    schemaVersion: 'structured-resume.v1', identity,
    roles: [{ ...sourceRole, bullets: [{ id: 'b1', text: career.quote, evidenceIds: ['career'] }] }],
    ...(items ? { skills: [{ id: 'skills', group: 'Tools', items, evidenceIds: ['career'] }] } : {}),
  };
}
function context(inventory, posting = 'Build reporting systems.') {
  return {
    sourceRoles: [sourceRole], trustedIdentity: identity,
    careerData: `Ada\nada@example.test\n## Acme\nEngineer\n${career.quote}`,
    evidenceCatalog: [career, listing(posting)], careerSkillEvidence: inventory,
  };
}
function authorityFor(name = 'Delta Roster') {
  return buildApplicationCareerAuthority({
    snapshotId: 'official-skill-selection', status: CAREER_SNAPSHOT_STATUS_APPROVED,
    profile: {
      identity: { name: 'Ada', contacts: ['ada@example.test'] },
      roles: [{ id: 'r1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '', location: '', achievementIds: ['a1'], skillIds: ['s1'] }],
      achievements: [{ id: 'a1', roleId: 'r1', claim: 'Built reporting systems.' }], projects: [],
      skills: [{ id: 's1', name, indexEligible: true, category: 'tool', roleIds: ['r1'] }],
      education: [], certifications: [], otherEvidence: [],
    },
  });
}

export default [
  {
    name: 'Official posting skills: declaration flags restrict modern fill while undefined preserves frozen selection',
    run() {
      const inventory = projection(
        skill('declared', 'Delta Roster', true), skill('posting-high', 'Birch Ledger', false),
        skill('posting-support', 'Aster Queue', false), skill('legacy', 'Cedar Sort'),
      );
      const catalog = [career,
        { ...listing('Aster Queue operations.'), id: 'listing-support', priority: 'supporting' },
        { ...listing('Birch Ledger reports.'), id: 'listing-high' },
      ];
      assert.deepEqual(postingNamedAttestedSkillTerms(catalog, inventory), ['Birch Ledger', 'Aster Queue']);
      assert.deepEqual(requiredCareerAttestedSkillTerms(catalog, inventory), ['Birch Ledger', 'Aster Queue', 'Delta Roster', 'Cedar Sort']);
      const noHeading = projection(skill('one', 'Delta Roster', false), skill('two', 'Birch Ledger', false));
      assert.deepEqual(requiredCareerAttestedSkillTerms([career, listing('Build reporting systems.')], noHeading), []);
      assert.deepEqual(requiredCareerAttestedSkillTerms([career, listing('Use Birch Ledger.')], noHeading), ['Birch Ledger']);
      assert.deepEqual(requiredCareerAttestedSkillTerms([career, listing('Build reporting systems.')], projection(skill('old', 'Delta Roster'))), ['Delta Roster']);
    },
  },
  {
    name: 'Official posting skills: permitted names share whole-term, clean-spelling and short-name case rules',
    run() {
      assert.equal(applicationSkillPermittedForPosting(skill('legacy', 'Delta Roster'), []), true);
      assert.equal(applicationSkillPermittedForPosting(skill('declared', 'Delta Roster', true), []), true);
      assert.equal(applicationSkillPermittedForPosting(skill('other', 'Delta Roster', false), []), false);
      assert.equal(applicationSkillPermittedForPosting(skill('other', 'Delta Roster', false), [listing('Use delta roster.')]), true);
      assert.equal(applicationSkillPermittedForPosting(skill('other', 'Delta Roster', false), ['Use Delta Rosters.']), false);
      assert.equal(applicationSkillPermittedForPosting(skill('clean', 'RosterBoard', false, { cleanName: 'Roster Board' }), ['Use Roster Board.']), true);
      assert.equal(applicationSkillPermittedForPosting(skill('clean', 'RosterBoard', false, { cleanName: 'Other Product' }), ['Use Other Product.']), false);
      for (const [name, quote, allowed] of [
        ['C', 'Write C.', true], ['C', 'Write c.', false], ['C', 'Write C++.', false],
        ['Go', 'Write Go.', true], ['Go', 'We go together.', false], ['Node', 'Use Node.js.', false],
        ['Node.js', 'Use node.js.', true],
      ]) assert.equal(applicationSkillPermittedForPosting(skill('term', name, false), [quote]), allowed, `${name}: ${quote}`);
    },
  },
  {
    name: 'Official posting skills: structured normalization retains declarations for required fill and permitted admission',
    run() {
      const modern = projection(skill('declared', 'Delta Roster', true));
      assert.ok(validateStructuredApplicationResume(resume(), context(modern)).advisories.some(entry => /skills omits Delta Roster/u.test(entry.detail)));
      assert.equal(validateStructuredApplicationResume(resume(['delta roster']), context(modern)).skills[0].items[0], 'Delta Roster');
      const outside = projection(skill('outside', 'Delta Roster', false));
      assert.equal(validateStructuredApplicationResume(resume(), context(outside)).skills.length, 0);
      assert.throws(() => validateStructuredApplicationResume(resume(['Delta Roster']), context(outside)), /declared in the source Skills section or named in this posting/u);
      assert.equal(validateStructuredApplicationResume(resume(['Delta Roster']), context(outside, 'Operate delta roster.')).skills[0].items[0], 'Delta Roster');
      const historical = projection(skill('legacy', 'Delta Roster'));
      assert.equal(validateStructuredApplicationResume(resume(['Delta Roster']), context(historical)).skills.length, 1);
      assert.throws(() => validateStructuredApplicationResume(resume(), context(projection(skill('invalid', 'Delta Roster', null)))), /declaredInSkillsSection must be boolean/u);
      const cleanInventory = projection(skill('clean', 'RosterBoard', false, { cleanName: 'Roster Board' }));
      const cleanContext = context(cleanInventory, 'Operate Roster Board.');
      cleanContext.authorityMode = true;
      cleanContext.evidenceCatalog[0] = { ...career, quote: 'Built reporting systems using RosterBoard.', cleanQuote: 'Built reporting systems using Roster Board.' };
      cleanContext.careerData = `Ada\nada@example.test\n## Acme\nEngineer\n${cleanContext.evidenceCatalog[0].quote}`;
      const cleanResume = resume(['roster board']);
      cleanResume.roles[0].bullets[0].text = cleanContext.evidenceCatalog[0].quote;
      assert.equal(validateStructuredApplicationResume(cleanResume, cleanContext).skills[0].items[0], 'Roster Board');
    },
  },
  {
    name: 'Official posting skills: authority group and direct skill validation apply host declaration projection',
    run() {
      const authority = authorityFor();
      const evidence = ['host.career.skill.s1.1'];
      const outside = { careerSkillEvidence: projection(skill('s1', 'Delta Roster', false)) };
      assert.throws(() => validateAuthoritySkill(authority, 's1', 'Delta Roster', evidence, outside), /not declared/u);
      assert.throws(() => validateAuthoritySkillGroup(authority, ['delta roster'], evidence, null, outside), /not declared/u);
      assert.deepEqual(validateAuthoritySkillGroup(authority, ['delta roster'], evidence, null, { ...outside, listingEvidence: [listing('Use DELTA ROSTER.')] }), ['Delta Roster']);
      assert.equal(validateAuthoritySkill(authority, 's1', 'Delta Roster', evidence, {
        careerSkillEvidence: projection(skill('s1', 'Delta Roster', true)),
      }).name, 'Delta Roster');
      assert.deepEqual(validateAuthoritySkillGroup(authority, ['Delta Roster'], evidence), ['Delta Roster']);
      assert.deepEqual(validateAuthoritySkillGroup(authority, ['Delta Roster'], evidence, null, {
        careerSkillEvidence: projection(skill('s1', 'Delta Roster')),
      }), ['Delta Roster']);
    },
  },
  {
    name: 'Official posting skills: authority posting permission accepts only the verified clean name',
    run() {
      const authority = authorityFor('RosterBoard');
      const evidence = ['host.career.skill.s1.1'];
      const cleanNames = new Map([['s1', 'Roster Board']]);
      const options = { careerSkillEvidence: projection(skill('s1', 'RosterBoard', false)), listingEvidence: ['Use Roster Board.'] };
      assert.deepEqual(validateAuthoritySkillGroup(authority, ['Roster Board'], evidence, cleanNames, options), ['RosterBoard']);
      assert.throws(() => validateAuthoritySkillGroup(authority, ['Roster Board'], evidence, cleanNames, { ...options, listingEvidence: [] }), /not declared/u);
      assert.throws(() => validateAuthoritySkillGroup(authority, ['Other Product'], evidence, new Map([['s1', 'Other Product']]), options), /not an exact/u);
    },
  },
];
