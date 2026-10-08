import { assert } from './testHelpers.js';
import fs from 'node:fs';
import { approvedCareerEvidenceCatalog, CAREER_SNAPSHOT_STATUS_APPROVED } from '../../electron/ipc/careerSnapshot.js';
import { authorityCareerQuotes, buildApplicationCareerAuthority, resolveAuthorityEvidence, resolveAuthorityProject, resolveAuthorityRole, resolveAuthoritySkill, validateAuthorityCertificationEvidence, validateAuthorityEducationEvidence, validateAuthorityIdentityAndLocation, validateAuthorityProjectEvidence, validateAuthorityRoleEvidence, validateAuthoritySkillGroup } from '../../electron/ipc/applicationCareerAuthority.js';
import { assemblePasteApplicationResult, assertAuthorityDraftSelection, assertFrozenEvidencePlan } from '../../electron/ipc/pasteApplicationAssembly.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, __localAiApplicationOutputTelemetryForTests } from '../../electron/ipc/localAiApplication.js';
import { assertRetainedResumeRoleBullets, extractResumeEvidence } from '../../electron/ipc/jobApplication.js';
import { renderStructuredApplicationResume, validateStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';

const snapshot = (otherCount = 0) => ({
  snapshotId: 'authority-test', status: CAREER_SNAPSHOT_STATUS_APPROVED,
  profile: {
    identity: { name: 'Ada', contacts: ['ada@example.test'] },
    roles: [{ id: 'r1', title: 'Engineer', employer: 'Acme', startDate: '', endDate: '', location: 'Toronto', achievementIds: ['a1'], skillIds: ['s1', 's3'] }, { id: 'r2', title: 'Engineer', employer: 'Else', startDate: '', endDate: '', location: '', achievementIds: ['a2'], skillIds: ['s2'] }],
    achievements: [{ id: 'a1', roleId: 'r1', claim: 'Built service one.' }, { id: 'a2', roleId: 'r2', claim: 'Built service two.' }],
    projects: [{ id: 'p1', name: 'Project', description: 'Built project.' }],
    skills: [{ id: 's1', name: 'TypeScript', category: 'language', indexEligible: true, roleIds: ['r1'] }, { id: 's2', name: 'Ambiguous', category: 'other', indexEligible: false, roleIds: ['r2'] }, { id: 's3', name: 'Node.js', category: 'language', indexEligible: true, roleIds: ['r1'] }],
    education: [{ id: 'e1', credential: 'BSc', institution: 'First University' }, { id: 'e2', credential: 'MSc', institution: 'Later University' }], certifications: [{ id: 'c1', name: 'Cert', issuer: 'Issuer' }],
    otherEvidence: Array.from({ length: otherCount }, (_, i) => ({ id: `o${i}`, label: `Other ${i}`, kind: 'note', text: 'x'.repeat(180) })),
  },
});

export default [{
  name: 'Application career authority: immutable indexed exact entity evidence',
  run() {
    const largeSnapshot = snapshot(6000);
    assert(JSON.stringify(largeSnapshot).length > 1_000_000, 'synthetic authority fixture exceeds one megabyte before indexing');
    const authority = buildApplicationCareerAuthority(largeSnapshot);
    const projectCatalogEntry = approvedCareerEvidenceCatalog(largeSnapshot).find(entry => entry.id === 'host.career.project.p1.1');
    const last = resolveAuthorityEvidence(authority, 'host.career.other.o5999.1');
    const achievement = resolveAuthorityEvidence(authority, 'host.career.achievement.a1.1');
    const secondAchievement = resolveAuthorityEvidence(authority, 'host.career.achievement.a2.1');
    assert(authority.counts.catalog > 6000 && last.quote.includes('Other 5999') && authority.identity.name === 'Ada' && authority.identity.contact[0] === 'ada@example.test' && authority.identity.credential === undefined && authority.identity.subtitleRole === undefined && authority.sourceRoles[0].company === 'Acme'
      && projectCatalogEntry?.owner?.type === 'project' && projectCatalogEntry.owner.id === 'p1',
    'large authority indexes last catalog evidence and keeps education out of source-order identity projection while retaining source roles and typed project ownership');
    const digest = authority.digests.catalog;
    try { authority.catalogById?.set('x', {}); } catch { /* private by design */ }
    const role = resolveAuthorityRole(authority, 'r1');
    try { role.location = 'mutated'; } catch { /* frozen by design */ }
    assert(authority.digests.catalog === digest && resolveAuthorityEvidence(authority, 'host.career.achievement.a1.1').quote.includes('Built service one') && resolveAuthorityRole(authority, 'r1').location === 'Toronto', 'private indexes and cloned records cannot be mutated through the exported authority');
    const fail = fn => { try { fn(); return false; } catch { return true; } };
    assert(fail(() => resolveAuthorityEvidence(authority, 'host.career.achievement.a1.1', 'altered'))
      && fail(() => validateAuthorityRoleEvidence(authority, 'r1', []))
      && fail(() => validateAuthorityRoleEvidence(authority, 'r1', ['host.career.achievement.a2.1']))
      && fail(() => validateAuthorityRoleEvidence(authority, 'r1', ['host.career.role.r1.1']))
      && fail(() => validateAuthorityProjectEvidence(authority, 'p1', []))
      && fail(() => validateAuthorityProjectEvidence(authority, 'p1', ['host.career.achievement.a1.1']))
      && fail(() => validateAuthoritySkillGroup(authority, ['Ambiguous'], ['host.career.skill.s2.1']))
      && fail(() => validateAuthoritySkillGroup(authority, ['TypeScript'], []))
      && fail(() => validateAuthoritySkillGroup(authority, ['TypeScript', 'Node.js'], ['host.career.skill.s1.1']))
      && fail(() => validateAuthoritySkillGroup(authority, ['TypeScript'], ['host.career.achievement.a1.1']))
      && fail(() => validateAuthorityIdentityAndLocation(authority, { name: 'Ada', contact: ['ada@example.test'], credential: 'Wrong' }, 'r1', 'Toronto'))
      && fail(() => validateAuthorityIdentityAndLocation(authority, { name: 'Ada', contact: ['ada@example.test'], credential: 'BSc, First University', subtitleRole: 'Engineer' }, 'r1', 'Toronto'))
      && fail(() => validateAuthorityIdentityAndLocation(authority, { name: 'Ada', contact: ['ada@example.test'] }, 'r1', '')),
    'altered, empty, header-only, cross-entity, ineligible skill, credential, and wrong nonempty location inputs fail closed');
    validateAuthorityIdentityAndLocation(authority, { name: 'Ada', contact: ['ada@example.test'] }, 'r1', 'Toronto');
    validateAuthorityIdentityAndLocation(authority, { name: 'Ada', contact: ['ada@example.test'] }, 'r2', '');
    validateAuthoritySkillGroup(authority, ['TypeScript'], ['host.career.skill.s1.1']);
    validateAuthoritySkillGroup(authority, ['TypeScript', 'Node.js'], ['host.career.skill.s1.1', 'host.career.skill.s3.1']);
    assert(authorityCareerQuotes(authority, ['host.career.achievement.a1.1']).length === 1
      && resolveAuthorityProject(authority, 'p1').name === 'Project'
      && resolveAuthoritySkill(authority, 's1').name === 'TypeScript'
      && resolveAuthorityEvidence(authority, 'host.career.education.e1.1').kind === 'education'
      && resolveAuthorityEvidence(authority, 'host.career.certification.c1.1').kind === 'certification'
      && resolveAuthorityEvidence(authority, 'host.career.other.o0.1').kind === 'other', 'read-only resolvers classify all approved entity namespaces and provide deterministic claim/duration source sets');
    const authorityPlan = { evidence: [{ id: last.id, sourceId: 'career-data', quote: last.quote }] };
    assertFrozenEvidencePlan(authorityPlan, '', 'Listing text', { authority });
    assert(fail(() => assertFrozenEvidencePlan({ evidence: [{ ...authorityPlan.evidence[0], quote: 'altered' }] }, '', 'Listing text', { authority }))
      && fail(() => assertFrozenEvidencePlan({ evidence: [{ id: 'host.career.other.unknown.1', sourceId: 'career-data', quote: last.quote }] }, '', 'Listing text', { authority })), 'authority-backed frozen plans validate the final catalog entry by reserved ID and exact quote without a raw career projection');
    const assembled = assemblePasteApplicationResult({
      input: { version: 1, jobId: 'authority-last-item', sourceRoles: authority.sourceRoles },
      authority,
      careerData: '',
      jobListing: 'Build reliable services.',
      paste: {
        trustedIdentity: authority.identity,
        evidencePlan: { evidence: [
          { id: achievement.id, sourceId: 'career-data', quote: achievement.quote },
          { id: secondAchievement.id, sourceId: 'career-data', quote: secondAchievement.quote },
          { id: last.id, sourceId: 'career-data', quote: last.quote },
          { id: 'job-need', sourceId: 'job-listing', quote: 'Build reliable services.' },
        ] },
        resume: { schemaVersion: 'structured-resume.v1', identity: authority.identity, roles: [
          { id: 'r1', title: 'Engineer', company: 'Acme', dates: '', location: 'Toronto', bullets: [{ id: 'bullet-1', text: 'Built service one.', evidenceIds: [achievement.id] }] },
          { id: 'r2', title: 'Engineer', company: 'Else', dates: '', location: '', bullets: [{ id: 'bullet-2', text: 'Built service two.', evidenceIds: [secondAchievement.id] }] },
        ] },
        coverLetter: {
          name: 'Ada', contact: ['ada@example.test'],
          paragraphs: [{ id: 'letter-1', text: 'I built service one and can apply that experience to reliable services.', evidenceIds: [achievement.id, last.id, 'job-need'] }],
          coverLetterArgument: { roleThesis: 'I can apply service delivery experience to reliable services.', primaryEvidence: { evidence: 'Built service one.', evidenceRole: 'Engineer', relationToThesis: 'It establishes direct service delivery experience.' } },
          generationAudit: { version: 1, finalDecisionSummary: 'The final review retains source-supported service evidence.', coverLetterPlan: { paragraphs: [{ paragraph: 'I built service one and can apply that experience to reliable services.' }] } },
        },
        finalReview: { decision: 'pass', findings: [], qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: [], resume: { decision: 'approved', rationale: 'The résumé retains exact approved service evidence.' }, coverLetter: { decision: 'approved', rationale: 'The letter presents one source-supported argument.' } } },
      },
    });
    assert(assembled.status === 'completed'
      && assembled.qualityReview.sourceGrounding.coverLetterParagraphs[0].careerDataQuotes.includes(last.quote),
    'completion assembly accepts a citation to the final >1MB authority catalog record without a raw career projection');
    const duplicate = snapshot();
    duplicate.profile.projects.push({ ...duplicate.profile.projects[0] });
    const collidingSkill = snapshot();
    collidingSkill.profile.skills.push({ id: 's4', name: 'typescript', category: 'language', indexEligible: true, roleIds: ['r1'] });
    const collidingEntity = snapshot();
    collidingEntity.profile.projects[0].id = 'r1';
    const invalidCatalogId = snapshot();
    invalidCatalogId.profile.roles[0].id = 'r1.invalid';
    assert(fail(() => buildApplicationCareerAuthority(duplicate))
      && fail(() => buildApplicationCareerAuthority(collidingSkill))
      && fail(() => buildApplicationCareerAuthority(collidingEntity))
      && fail(() => buildApplicationCareerAuthority(invalidCatalogId))
      && buildApplicationCareerAuthority(snapshot()).digests.catalog === buildApplicationCareerAuthority(snapshot()).digests.catalog, 'duplicate IDs, skill-name collisions, invalid catalog namespaces, and noncanonical authority construction fail closed or remain stable');
  },
}, {
  name: 'Application career authority: current relationship-qualified rows are relation evidence, never selectable skills',
  run() {
    const current = snapshot();
    current.profile.achievements[0] = {
      ...current.profile.achievements[0], claim: 'Built service one using TypeScript or Node.js.', technologies: ['TypeScript', 'Node.js'],
      technologyReferences: [
        { technology: 'TypeScript', disposition: 'skill', skillId: 's1', relationship: 'alternative', relationshipGroup: 'runtime-choice', relationshipEvidence: 'Built service one using TypeScript or Node.js.' },
        { technology: 'Node.js', disposition: 'skill', skillId: 's3', relationship: 'alternative', relationshipGroup: 'runtime-choice', relationshipEvidence: 'Built service one using TypeScript or Node.js.' },
      ],
    };
    // The synthetic catalog does not invoke the full compiler validator, but
    // carries the exact current semantic fields used by authority/projection.
    // TypeScript has separate direct support; Node.js has only this choice.
    current.profile.skills = [
      { id: 's1', name: 'TypeScript', category: 'language', capabilityKind: 'language', supportMode: 'direct', directEvidenceSegmentIds: ['segment-direct'], indexEligible: true, roleIds: ['r1'], evidenceSegmentIds: ['segment-direct'] },
      { id: 's2', name: 'Ambiguous', category: 'other', capabilityKind: 'capability', supportMode: 'direct', directEvidenceSegmentIds: ['segment-other'], indexEligible: false, roleIds: ['r2'], evidenceSegmentIds: ['segment-other'] },
      { id: 's3', name: 'Node.js', category: 'language', capabilityKind: 'platform', supportMode: 'relationship-qualified', directEvidenceSegmentIds: [], indexEligible: false, roleIds: ['r1'], evidenceSegmentIds: ['segment-choice'] },
    ];
    const authority = buildApplicationCareerAuthority(current);
    const catalog = approvedCareerEvidenceCatalog(current);
    const fail = fn => { try { fn(); return false; } catch { return true; } };
    validateAuthoritySkillGroup(authority, ['TypeScript'], ['host.career.skill.s1.1']);
    assert(catalog.some(item => item.id === 'host.career.skill.s1.1')
      && !catalog.some(item => item.id.startsWith('host.career.skill.s3.'))
      && catalog.some(item => item.id.startsWith('host.career.achievement.a1.') && item.quote.includes('Usage relationship'))
      && authority.counts.skills === 1
      && fail(() => resolveAuthoritySkill(authority, 's3'))
      && fail(() => validateAuthoritySkillGroup(authority, ['Node.js'], ['host.career.skill.s3.1']))
      && fail(() => validateAuthorityRoleEvidence(authority, 'r1', ['host.career.skill.s3.1'])),
    'current authority retains relationship-aware achievement evidence but admits only direct index-eligible skills to its catalog, resolver map, and selection paths, so a qualified label cannot be promoted through a known opaque ID');
    return { directSkillCatalogued: true, qualifiedSkillBlocked: true };
  },
}, {
  name: 'Application career authority: role-less education and credential résumés remain evidence-backed and authority-selected',
  run() {
    const roleless = snapshot();
    roleless.profile.roles = [];
    roleless.profile.achievements = [];
    roleless.profile.projects = [];
    roleless.profile.skills = [];
    const authority = buildApplicationCareerAuthority(roleless);
    const catalog = approvedCareerEvidenceCatalog(roleless);
    const educationEvidence = catalog.filter(item => item.id.startsWith('host.career.education.e2.'));
    const certificationEvidence = catalog.filter(item => item.id.startsWith('host.career.certification.c1.'));
    validateAuthorityEducationEvidence(authority, 'e2', educationEvidence.map(item => item.id));
    validateAuthorityCertificationEvidence(authority, 'c1', certificationEvidence.map(item => item.id));
    const resume = {
      schemaVersion: 'structured-resume.v1', identity: authority.identity, roles: [],
      // Deliberately not source order: a matched later postgraduate item can
      // precede the earlier degree without becoming an unaudited assertion.
      education: [{ id: 'education-e2', credential: 'MSc', institution: 'Later University', evidenceIds: educationEvidence.map(item => item.id) }],
      credentials: [{ id: 'credential-c1', name: 'Cert', issuer: 'Issuer', evidenceIds: certificationEvidence.map(item => item.id) }],
    };
    validateStructuredApplicationResume(resume, { sourceRoles: [], evidenceCatalog: catalog, trustedIdentity: authority.identity,
      careerData: 'MSc, Later University\nCert — Issuer' });
    const html = renderStructuredApplicationResume(resume, { sourceRoles: [], evidenceCatalog: catalog, trustedIdentity: authority.identity,
      careerData: 'MSc, Later University\nCert — Issuer' });
    assert(authority.identity.credential === undefined && !html.includes('BSc') && !html.includes('sec-experience')
      && html.includes('sec-education') && html.includes('sec-credentials')
      && html.includes('<dl class="credentials-list">') && html.indexOf('MSc') < html.indexOf('Cert'),
    'with source-order BSc followed by relevant MSc, identity carries neither degree and the evidence-selected MSc renders once in accessible Education without a fake Experience section');
    const extracted = extractResumeEvidence(html);
    const output = __localAiApplicationOutputTelemetryForTests({ resumeMainHtml: html, coverLetter: { paragraphs: [] } });
    let legacyRoleGateRejected = false;
    let unexpectedRoleRejected = false;
    let selectedRoleBulletRejected = false;
    try { assertRetainedResumeRoleBullets(html); } catch { legacyRoleGateRejected = true; }
    assertRetainedResumeRoleBullets(html, { expectedRoleCount: authority.sourceRoles.length });
    try {
      assertRetainedResumeRoleBullets(`${html.slice(0, -7)}<article class="role"><ul class="highlights"><li>Invented work history.</li></ul></article></main>`, { expectedRoleCount: authority.sourceRoles.length });
    } catch { unexpectedRoleRejected = true; }
    try {
      assertRetainedResumeRoleBullets('<main class="page"><article class="role"><span class="title">Engineer</span><ul class="highlights"></ul></article></main>', { expectedRoleCount: 1 });
    } catch { selectedRoleBulletRejected = true; }
    assert(legacyRoleGateRejected && unexpectedRoleRejected && selectedRoleBulletRejected
      && extracted.education.includes('MSc · Later University')
      && extracted.education.includes('Cert · Issuer')
      && output.metadata.resume.educationCount === 2
      && output.documents.resume.education.includes('MSc · Later University')
      && output.documents.resume.education.includes('Cert · Issuer'),
    'the structured draft, final role gate, evidence extraction, and APPOUTPUT all retain a roleless Education/Certifications résumé while rejecting malformed role markup and a selected role without a bullet');
    const css = fs.readFileSync('Job Application Design System/resume.css', 'utf8');
    assert(css.includes('.credentials-list') && css.includes('.credential-item { display: contents; }'),
      'the PDF stylesheet gives the semantic credential definition lists a compact, explicit grid treatment');
    const selection = { selectedRoleIds: [], selectedProjectIds: [], selectedEducationIds: ['e2'], selectedCertificationIds: ['c1'], selectedSkillIds: [], selectedEvidenceIds: [...educationEvidence, ...certificationEvidence].map(item => item.id) };
    assertAuthorityDraftSelection({ fullAuthority: { catalog, skills: [] }, selection, resume,
      coverLetter: { paragraphs: [] } });
    let forgedRejected = false;
    try {
      assertAuthorityDraftSelection({ fullAuthority: { catalog, skills: [] }, selection: { ...selection, selectedEducationIds: ['e1'] }, resume,
        coverLetter: { paragraphs: [] } });
    } catch { forgedRejected = true; }
    assert(authority.sourceRoles.length === 0 && authority.sourceEducation[1].id === 'e2'
      && authority.sourceCertifications[0].id === 'c1' && selection.selectedEvidenceIds.length > 0 && forgedRejected,
    'role-less authority retains immutable education/certification projections and selected evidence IDs for restart validation, and rejects forged typed selections');

    // A sparse career can be project-led too. This uses the same selected-ID
    // gate as the production current-authority path, rather than merely
    // proving that the renderer tolerates an empty role array.
    const projectLed = snapshot();
    projectLed.profile.roles = [];
    projectLed.profile.achievements = [];
    projectLed.profile.skills = [];
    projectLed.profile.education = [];
    projectLed.profile.certifications = [];
    projectLed.profile.projects = [{ id: 'p1', name: 'Reporting Project', description: 'Built durable reporting workflow.' }];
    const projectAuthority = buildApplicationCareerAuthority(projectLed);
    const projectCatalog = approvedCareerEvidenceCatalog(projectLed);
    const projectEvidence = projectCatalog.filter(item => item.id.startsWith('host.career.project.p1.'));
    validateAuthorityProjectEvidence(projectAuthority, 'p1', projectEvidence.map(item => item.id));
    const projectResume = {
      schemaVersion: 'structured-resume.v1', identity: projectAuthority.identity, roles: [],
      projects: [{ id: 'project-p1', name: 'Reporting Project', description: 'Built durable reporting workflow.', evidenceIds: projectEvidence.map(item => item.id) }],
    };
    validateStructuredApplicationResume(projectResume, { sourceRoles: [], evidenceCatalog: projectCatalog, trustedIdentity: projectAuthority.identity,
      careerData: 'Reporting Project\nBuilt durable reporting workflow.' });
    const projectHtml = renderStructuredApplicationResume(projectResume, { sourceRoles: [], evidenceCatalog: projectCatalog, trustedIdentity: projectAuthority.identity,
      careerData: 'Reporting Project\nBuilt durable reporting workflow.', authorityMode: true });
    assertAuthorityDraftSelection({ fullAuthority: { catalog: projectCatalog, skills: [] }, selection: {
      selectedRoleIds: [], selectedProjectIds: ['p1'], selectedEducationIds: [], selectedCertificationIds: [], selectedSkillIds: [], selectedEvidenceIds: projectEvidence.map(item => item.id),
    }, resume: projectResume, coverLetter: { paragraphs: [] } });
    const highestProjectSelection = {
      selectedRoleIds: [], selectedProjectIds: ['p1'], selectedEducationIds: [], selectedCertificationIds: [], selectedSkillIds: [], selectedEvidenceIds: projectEvidence.map(item => item.id),
      resumeProjectObligation: { version: 1, projectId: 'p1', evidenceId: projectEvidence[0].id, requirementId: 'highest-requirement', priority: 'highest' },
    };
    assertAuthorityDraftSelection({ fullAuthority: { catalog: projectCatalog, skills: [] }, selection: highestProjectSelection,
      resume: projectResume, coverLetter: { paragraphs: [] } });
    let omittedHighestProjectRejected = false;
    try {
      assertAuthorityDraftSelection({ fullAuthority: { catalog: projectCatalog, skills: [] }, selection: highestProjectSelection,
        resume: { ...projectResume, projects: [] }, coverLetter: { paragraphs: [] } });
    } catch (error) { omittedHighestProjectRejected = /host-required project/i.test(String(error?.message || error)); }
    // No obligation means no selected project was matched to a highest-priority
    // requirement; selected project authority remains optional in that case.
    assertAuthorityDraftSelection({ fullAuthority: { catalog: projectCatalog, skills: [] }, selection: {
      ...highestProjectSelection, resumeProjectObligation: null,
    }, resume: { ...projectResume, projects: [] }, coverLetter: { paragraphs: [] } });
    assertRetainedResumeRoleBullets(projectHtml, { expectedRoleCount: projectAuthority.sourceRoles.length });
    assert(omittedHighestProjectRejected && !projectHtml.includes('sec-experience') && projectHtml.includes('sec-projects') && projectHtml.includes('>Projects<')
      && projectHtml.includes('Reporting Project') && projectHtml.includes('Built durable reporting workflow.')
      && !projectHtml.includes('Selected Systems') && projectAuthority.sourceRoles.length === 0,
    'a zero-role authority résumé preserves its exact selected project facts under a plain Projects heading without a fake Experience or inferred provenance heading');

    // The current protocol may carry a small authority-derived display
    // projection for legacy renderer plumbing, but it must never turn that
    // projection back into authority. A missing citation quote is therefore
    // a closed failure even where the raw text happens to contain the field.
    const quotedEducation = { id: 'quoted-education', sourceId: 'career-data', quote: 'MSc, Later University' };
    const quoteMissing = { id: 'quote-missing', sourceId: 'career-data' };
    const rejectRawFallback = (draft, expected) => {
      let message = '';
      try {
        validateStructuredApplicationResume(draft, {
          sourceRoles: [], evidenceCatalog: [quotedEducation, quoteMissing], trustedIdentity: projectAuthority.identity,
          careerData: 'MSc, Later University\nReporting Project\nBuilt durable reporting workflow.\nTypeScript\nCert — Issuer', authorityMode: true,
        });
      } catch (error) { message = String(error?.message || error); }
      return message.includes(expected);
    };
    const authorityBase = { schemaVersion: 'structured-resume.v1', identity: projectAuthority.identity, roles: [],
      education: [{ id: 'education', credential: 'MSc', institution: 'Later University', evidenceIds: ['quoted-education'] }] };
    assert(rejectRawFallback({ ...authorityBase, projects: [{ id: 'project', name: 'Reporting Project', description: 'Built durable reporting workflow.', evidenceIds: ['quote-missing'] }] }, 'projects.project')
      && rejectRawFallback({ ...authorityBase, skills: [{ id: 'skills', group: 'Languages', items: ['TypeScript'], evidenceIds: ['quote-missing'] }] }, 'skills[0] item')
      && rejectRawFallback({ ...authorityBase, credentials: [{ id: 'credential', name: 'Cert', issuer: 'Issuer', evidenceIds: ['quote-missing'] }] }, 'credentials.credential'),
    'current authority validation cannot resurrect project, skill, or credential support from raw career text when its approved evidence quote is absent');
  },
}];
