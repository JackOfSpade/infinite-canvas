import crypto from 'node:crypto';
import fs from 'node:fs';
import { assert, buildResumeDocument, extractResumeEvidence, projectContactChannels, projectTrustedIdentity, resumeRoleLocationFailures, validateLocalApplicationResult } from '../test-dependencies.js';
import { FROZEN_COMPLETED_PACKAGE, LOCAL_AI_JOB_INTEGRITY_CODE, MAX_FROZEN_SOURCE_CHARS, MAX_UNIT_CAREER_DATA_QUOTES, assemblePasteApplicationResult, assertAuthorityDraftSelection, isJobIntegrityFault, normalizeBoundDocumentText } from '../../electron/ipc/pasteApplicationAssembly.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, LOCAL_AI_GENERATION_AUDIT_VERSION, __queueLegacyLocalApplicationFixtureForTests, pasteRejectionChangeDocuments, sanitizeQualityReview, stampPasteQualityReviewFromFit } from '../../electron/ipc/localAiApplication.js';
import { CAREER_SNAPSHOT_HISTORICAL_SKILL_EVIDENCE_VERSION, CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION, careerAttestedSkillTerms, formatRoleDateForPresentation, MAX_REQUIRED_CAREER_SKILL_TERMS, MAX_REQUIRED_POSTING_SKILL_TERMS, missingPostingNamedSkillTerms, missingRequiredCareerSkillTerms, NEUTRAL_SKILL_GROUP_LABELS, NEUTRAL_SKILL_GROUP_RULE, neutralSkillGroupRule, postingNamedAttestedSkillTerms, requiredCareerAttestedSkillTerms, renderStructuredApplicationResume, SKILLS_BLOCK_BUDGET_RULE, STRUCTURED_RESUME_LIMITS, STRUCTURED_RESUME_SCHEMA_VERSION, skillGroupVocabulary, STRUCTURED_RESUME_SKILLS_BUDGET, titleCaseSkillGroupLabel, validateStructuredApplicationResume } from '../../electron/ipc/structuredResume.js';
import { careerDataProjectProvenanceHeadingForName } from '../../electron/ipc/jobApplication.js';

const careerData = 'Ada Lovelace\nada@example.test\n## Analytical Engines\nSoftware Engineer\n\nBuilt reporting systems that reduced manual work.';
const sourceRoles = [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];

// Synthetic approved-inventory rows (career-snapshot-skills.v2). Every name in
// this file is invented and spans unrelated fields on purpose: the rules under
// test must decide from the evidence handed to them, never from a vocabulary of
// real products.
function approvedSkill(slug, name, extra = {}) {
  return {
    id: `skill-${slug}`, name, capabilityKind: 'tool', supportMode: 'direct', indexEligible: true,
    directEvidenceSegmentIds: [`segment-${slug}`], evidenceSegmentIds: [`segment-${slug}`], ...extra,
  };
}
function approvedInventory(...skills) {
  return { version: CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION, skills };
}

// What one structured résumé draft produces under the résumé check
// dispositions (electron/ipc/resumeCheckDispositions.js): a TRUTH or HYGIENE
// rule rejects it, so `rejected` is true and `text` is the thrown message; a
// TASTE rule only advises, so the draft is accepted, still renders, and `text`
// is the advisories' detail. Tests that pin what a rule SAYS read `text`; tests
// that pin what it DOES read `rejected`.
function structuredOutcome(resume, context) {
  try {
    const draft = validateStructuredApplicationResume(resume, context);
    renderStructuredApplicationResume(resume, context);
    const advisoryText = draft.advisories.map(entry => entry.detail).join(' ');
    return { rejected: false, message: '', advisories: draft.advisories, advisoryText, text: advisoryText };
  } catch (error) {
    if (error?.code !== 'STRUCTURED_RESUME_INVALID') throw error;
    const advisories = error.advisories || [];
    return { rejected: true, message: String(error.message || error), advisories, advisoryText: advisories.map(entry => entry.detail).join(' '), text: String(error.message || error) };
  }
}

// `overrides` replaces fields of the pasted package; `frozen` replaces the
// app-owned inputs assembly is handed beside it.
function fixture(overrides = {}, frozen = {}) {
  return {
    input: { version: 1, jobId: 'job-1', sourceRoles },
    careerData,
    jobListing: 'Build reliable reporting systems.',
    ...frozen,
    paste: {
      trustedIdentity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: '', credential: '' },
      evidencePlan: { evidence: [
        { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' },
        { id: 'job-need', sourceId: 'job-listing', quote: 'Build reliable reporting systems.' },
      ] },
      resume: {
        schemaVersion: 'structured-resume.v1',
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: '', credential: '' },
        roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
      },
      coverLetter: {
        name: 'Ada Lovelace', contact: ['ada@example.test'],
        paragraphs: [{ id: 'letter-1', text: 'I built reporting systems that reduced manual work.', evidenceIds: ['career-proof', 'job-need'] }],
        coverLetterArgument: { roleThesis: 'I can apply reporting-system experience to this reliable reporting work.', primaryEvidence: { evidence: 'Built reporting systems that reduced manual work.', evidenceRole: 'Software Engineer', relationToThesis: 'It proves direct reporting-system delivery.' } },
        generationAudit: { version: 1, finalDecisionSummary: 'The final review retained only source-supported reporting evidence.', coverLetterPlan: { paragraphs: [{ paragraph: 'I built reporting systems that reduced manual work.' }] } },
      },
      finalReview: { decision: 'pass', findings: [], qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: [], resume: { decision: 'approved', rationale: 'The résumé keeps direct source-supported reporting evidence.' }, coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target reporting work.' } } },
      ...overrides,
    },
  };
}

export default [
  {
    name: 'Structured résumé renderer preserves trusted metadata and rejects unsupported pasted structure',
    run() {
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{
          id: '123e4567-e89b-42d3-a456-426614174000', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: 'London, UK',
          bullets: [{ id: 'bullet-1', text: '<script>unsafe</script> Built systems.', evidenceIds: ['career-proof'] }],
        }],
        skills: [{ id: 'skills-1', group: 'Languages', items: ['JavaScript'], evidenceIds: ['career-proof'] }],
      };
      const context = {
        sourceRoles: [{ id: '123e4567-e89b-42d3-a456-426614174000', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }],
        evidenceCatalog: ['career-proof'], careerData: `${careerData}\nLondon, UK\nLanguages\nJavaScript`,
      };
      const html = renderStructuredApplicationResume(resume, context);
      let rejectedUnknownEvidence = false;
      let rejectedInventedCompany = false;
      let rejectedSkillEvidence = false;
      try { renderStructuredApplicationResume({ ...resume, roles: [{ ...resume.roles[0], bullets: [{ ...resume.roles[0].bullets[0], evidenceIds: ['unknown'] }] }] }, context); } catch { rejectedUnknownEvidence = true; }
      try { renderStructuredApplicationResume({ ...resume, roles: [{ ...resume.roles[0], company: 'Invented Co' }] }, context); } catch { rejectedInventedCompany = true; }
      try { renderStructuredApplicationResume({ ...resume, skills: [{ ...resume.skills[0], evidenceIds: ['unknown'] }] }, context); } catch { rejectedSkillEvidence = true; }
      assert(html.includes('London, UK') && html.includes('&lt;script&gt;unsafe&lt;/script&gt;') && !html.includes('<script>unsafe</script>')
        && rejectedUnknownEvidence && rejectedInventedCompany && rejectedSkillEvidence,
      'the host renderer accepts UUID roles and career-backed locations, escapes pasted copy, and rejects unknown evidence or metadata changes');
      return { escaped: true, uuidRole: true, sourceBackedLocation: true };
    },
  },
  {
    name: 'Structured résumé date presentation only removes the proven Month, YYYY comma without changing source authority',
    run() {
      const sourceDate = 'April, 2022 – Present';
      const sourceRole = { id: 'role-date-display', title: 'Engineer', company: 'Example Co', dates: sourceDate, location: '' };
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Candidate', contact: ['candidate@example.test'] },
        roles: [{ ...sourceRole, bullets: [{ id: 'date-display-bullet', text: 'Built a supported workflow.', evidenceIds: ['career-proof'] }] }],
      };
      const html = renderStructuredApplicationResume(resume, {
        sourceRoles: [sourceRole], evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'At Example Co, built a supported workflow.' }],
        careerData: 'Candidate\nExample Co\nAt Example Co, built a supported workflow.',
      });
      const document = buildResumeDocument({ resumeMainHtml: html, trustedRenderedRoleDates: [formatRoleDateForPresentation(sourceDate)] });
      assert(html.includes('April 2022 – Present') && !html.includes('April, 2022')
        && sourceRole.dates === sourceDate && resume.roles[0].dates === sourceDate
        && document.includes('April 2022 – Present')
        && formatRoleDateForPresentation('2022, April') === '2022, April'
        && formatRoleDateForPresentation('April 2022') === 'April 2022',
      'the renderer presents only exact written month-year commas conventionally, keeps the source/draft date byte-for-byte intact, and the trusted date gate recognizes that host-owned display projection');
      return { sourceDateUnchanged: true, displayDate: 'April 2022 – Present' };
    },
  },
  {
    name: 'Paste application assembly renders host-owned HTML and exact evidence grounding',
    run() {
      const result = assemblePasteApplicationResult(fixture());
      assert(result.status === 'completed' && result.outputBundleRoot === 'Applied Jobs',
        'assembly sets the app-owned legacy completion envelope and output root');
      assert(result.resumeMainHtml.includes('<main class="page"')
        && result.resumeMainHtml.includes('Built reporting systems that reduced manual work.'),
      'assembly renders structured résumé copy through the host renderer');
      assert(result.qualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes[0] === 'Built reporting systems that reduced manual work.'
        && result.qualityReview.sourceGrounding.coverLetterParagraphs[0].paragraph === 'I built reporting systems that reduced manual work.',
      'assembly derives exact final-text source bindings from accepted evidence IDs');
      assert(result.qualityReview.resume.decision === 'drafted' && result.qualityReview.coverLetter.decision === 'drafted',
        'the first legacy import remains a host-owned initial rendering snapshot while preserving the AI review rationale');
      return { rendered: true };
    },
  },
  {
    name: 'Current authority draft selection derives project permission from typed selected evidence and ignores hostile unknown nesting',
    run() {
      const fullAuthority = {
        catalog: [
          { id: 'role-proof', roleId: 'role-1' },
          { id: 'project-proof', owner: { type: 'project', id: 'project-1' } },
          { id: 'project-alternate-proof', owner: { type: 'project', id: 'project-1' } },
          { id: 'project-two-proof', projectId: 'project-2' },
        ],
        skills: [],
      };
      const selection = {
        selectedRoleIds: ['role-1'], selectedEvidenceIds: ['role-proof', 'project-proof', 'project-alternate-proof'],
        selectedProjectIds: ['project-1'], selectedSkillIds: [],
      };
      let hostileUnknown = { evidenceIds: ['project-two-proof'] };
      for (let index = 0; index < 20_000; index += 1) hostileUnknown = { unknown: hostileUnknown };
      const acceptedResume = {
        roles: [{ id: 'role-1', bullets: [{ id: 'bullet-1', evidenceIds: ['role-proof'] }] }],
        projects: [{ id: 'rendered-project', evidenceIds: ['project-proof'] }], skills: [],
        // Unknown fields are not an alternate citation schema. A deep hostile
        // object must neither blow the stack nor smuggle an unselected ID.
        hostileUnknown,
      };
      assertAuthorityDraftSelection({ fullAuthority, selection, resume: acceptedResume,
        coverLetter: { paragraphs: [{ id: 'p1', evidenceIds: ['role-proof'] }] } });

      const obligation = {
        version: 1, priority: 'highest', projectId: 'project-1',
        evidenceId: 'project-proof', requirementId: 'highest-requirement',
      };
      assertAuthorityDraftSelection({ fullAuthority, selection: { ...selection, resumeProjectObligation: obligation }, resume: acceptedResume,
        coverLetter: { paragraphs: [{ id: 'p1', evidenceIds: ['role-proof'] }] } });
      let wrongRequiredEvidenceRejected = false;
      try {
        assertAuthorityDraftSelection({ fullAuthority, selection: { ...selection, resumeProjectObligation: obligation },
          resume: { ...acceptedResume, projects: [{ id: 'wrong-required-project-evidence', evidenceIds: ['project-alternate-proof'] }] },
          coverLetter: { paragraphs: [{ id: 'p1', evidenceIds: ['role-proof'] }] } });
      } catch (error) { wrongRequiredEvidenceRejected = /exact host-required project evidence/i.test(String(error?.message || error)); }

      let projectRejected = false;
      try {
        assertAuthorityDraftSelection({ fullAuthority, selection,
          resume: { ...acceptedResume, projects: [{ id: 'synthetic-project', evidenceIds: ['role-proof'] }] },
          coverLetter: { paragraphs: [{ id: 'p1', evidenceIds: ['role-proof'] }] } });
      } catch (error) { projectRejected = /selected typed project authority/i.test(String(error?.message || error)); }
      let tamperedProjectionRejected = false;
      try {
        assertAuthorityDraftSelection({ fullAuthority,
          selection: { ...selection, selectedEvidenceIds: ['role-proof', 'project-two-proof'] },
          resume: acceptedResume, coverLetter: { paragraphs: [{ id: 'p1', evidenceIds: ['role-proof'] }] } });
      } catch (error) { tamperedProjectionRejected = /typed project-authority projection/i.test(String(error?.message || error)); }
      assert(projectRejected && tamperedProjectionRejected && wrongRequiredEvidenceRejected,
        'a rendered project needs exactly one host-selected project owner, a required project cites its exact selected evidence row, and selectedProjectIds exactly derives from the typed selected evidence');
      return { typedProject: true, hostileDepth: 20_000, syntheticRejected: projectRejected, exactRequiredEvidence: wrongRequiredEvidenceRejected };
    },
  },
  {
    name: 'Current authority draft selection permits only host-allowed frozen listing citations',
    run() {
      const selectedCareerEvidence = 'host.career.achievement.selected.1';
      const unselectedCareerEvidence = 'host.career.achievement.unselected.1';
      const fullAuthority = {
        catalog: [
          { id: selectedCareerEvidence, roleId: 'role-1' },
          { id: unselectedCareerEvidence, roleId: 'role-1' },
        ],
        skills: [],
      };
      const selection = {
        selectedRoleIds: ['role-1'], selectedProjectIds: [], selectedEducationIds: [],
        selectedCertificationIds: [], selectedSkillIds: [], selectedEvidenceIds: [selectedCareerEvidence],
      };
      const resume = {
        roles: [{ id: 'role-1', bullets: [{ id: 'bullet-1', evidenceIds: [selectedCareerEvidence] }] }],
        projects: [], skills: [],
      };
      const coverLetter = evidenceIds => ({ paragraphs: [{ id: 'paragraph-1', evidenceIds }] });
      const rejected = ({ evidenceIds, acceptedNonAuthorityEvidenceIds = ['p1-e1'] }) => {
        try {
          assertAuthorityDraftSelection({ fullAuthority, selection, acceptedNonAuthorityEvidenceIds, resume,
            coverLetter: coverLetter(evidenceIds) });
          return false;
        } catch { return true; }
      };
      assert(!rejected({ evidenceIds: [selectedCareerEvidence, 'p1-e1'] })
        && rejected({ evidenceIds: [selectedCareerEvidence, 'p1-forged'] })
        && rejected({ evidenceIds: [unselectedCareerEvidence] })
        && rejected({ evidenceIds: [unselectedCareerEvidence], acceptedNonAuthorityEvidenceIds: [unselectedCareerEvidence] }),
      'a frozen p1-e listing citation is allowed, while forged listing-looking IDs and unselected pinned career evidence remain closed even if an invalid allowlist attempts to include it');
      return { acceptedListingCitation: 'p1-e1', forgedListingRejected: true, unselectedCareerRejected: true };
    },
  },
  {
    name: 'Structured résumé roles keep career evidence and blank trusted locations within their own identifiable career section',
    run() {
      const scopedCareerData = `Work Done from Past Jobs

Software Engineer

Maple Ridge School District — Brookfield, Ohio
*April 2022 – July 2025*
- Built attendance reporting for district staff.

Data Engineer

Cedar Valley Health Alliance — Lakeview, Ontario
*January 2019 – March 2022*
- Built clinical data pipelines for care teams.

---
Personal Projects`;
      const scopedRoles = [
        { id: 'maple', title: 'Software Engineer', company: 'Maple Ridge School District', dates: 'April 2022 – July 2025', location: '' },
        { id: 'cedar', title: 'Data Engineer', company: 'Cedar Valley Health Alliance', dates: 'January 2019 – March 2022', location: '' },
      ];
      const scopedResume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [
          { id: 'maple', title: 'Software Engineer', company: 'Maple Ridge School District', dates: 'April 2022 – July 2025', location: 'Brookfield, Ohio', bullets: [{ id: 'maple-bullet', text: 'Built attendance reporting for district staff.', evidenceIds: ['maple-proof'] }] },
          { id: 'cedar', title: 'Data Engineer', company: 'Cedar Valley Health Alliance', dates: 'January 2019 – March 2022', location: 'Lakeview, Ontario', bullets: [{ id: 'cedar-bullet', text: 'Built clinical data pipelines for care teams.', evidenceIds: ['cedar-proof'] }] },
        ],
      };
      const scopedContext = {
        sourceRoles: scopedRoles,
        careerData: scopedCareerData,
        evidenceCatalog: [
          { id: 'maple-proof', sourceId: 'career-data', quote: 'Built attendance reporting for district staff.' },
          { id: 'cedar-proof', sourceId: 'career-data', quote: 'Built clinical data pipelines for care teams.' },
          { id: 'job-need', sourceId: 'job-listing', quote: 'Build reliable reporting systems.' },
        ],
      };
      const html = renderStructuredApplicationResume(scopedResume, scopedContext);
      let rejectedCrossRoleEvidence = false;
      try {
        const invalid = structuredClone(scopedResume);
        invalid.roles[0].bullets[0].evidenceIds = ['cedar-proof'];
        renderStructuredApplicationResume(invalid, scopedContext);
      } catch { rejectedCrossRoleEvidence = true; }
      let rejectedMixedCareerEvidence = false;
      try {
        const invalid = structuredClone(scopedResume);
        invalid.roles[0].bullets[0].evidenceIds = ['maple-proof', 'cedar-proof', 'job-need'];
        renderStructuredApplicationResume(invalid, scopedContext);
      } catch { rejectedMixedCareerEvidence = true; }
      let rejectedCrossRoleLocation = false;
      try {
        const invalid = structuredClone(scopedResume);
        invalid.roles[0].location = 'Lakeview, Ontario';
        renderStructuredApplicationResume(invalid, scopedContext);
      } catch { rejectedCrossRoleLocation = true; }
      assert(html.includes('Brookfield, Ohio') && rejectedCrossRoleEvidence && rejectedMixedCareerEvidence && rejectedCrossRoleLocation,
        'plain title-and-employer career sections bind each role to its own evidence and constrain blank trusted-role locations to that section');
      return { rejectedCrossRoleEvidence, rejectedMixedCareerEvidence, rejectedCrossRoleLocation };
    },
  },
  {
    name: 'Snapshot role-ID headings scope repeated employers to their own career evidence',
    run() {
      const repeatedEmployerCareerData = `# Career Profile

## Work Experience

### Software Engineer — Acme [Role ID: role-acme-engineer]
Acme — Lakeview, Ontario
Dates: January 2020 — Present
- Built the production Python service for customer reporting.

### Engineering Intern — Acme [Role ID: role-acme-intern]
Acme — Lakeview, Ontario
Dates: May 2019 — August 2019
- Built the internal JavaScript dashboard for support teams.
`;
      const repeatedEmployerRoles = [
        { id: 'role-acme-engineer', title: 'Software Engineer', company: 'Acme', dates: 'January 2020 — Present', location: '' },
        { id: 'role-acme-intern', title: 'Engineering Intern', company: 'Acme', dates: 'May 2019 — August 2019', location: '' },
      ];
      const repeatedEmployerResume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [
          { id: 'role-acme-engineer', title: 'Software Engineer', company: 'Acme', dates: 'January 2020 — Present', location: '', bullets: [{ id: 'engineer-bullet', text: 'Built the production Python service for customer reporting.', evidenceIds: ['engineer-proof'] }] },
          { id: 'role-acme-intern', title: 'Engineering Intern', company: 'Acme', dates: 'May 2019 — August 2019', location: '', bullets: [{ id: 'intern-bullet', text: 'Built the internal JavaScript dashboard for support teams.', evidenceIds: ['intern-proof'] }] },
        ],
        skills: [{ id: 'skills-tools', group: 'Tools', items: ['Python', 'JavaScript'], evidenceIds: ['engineer-proof', 'intern-proof'] }],
      };
      const repeatedEmployerContext = {
        sourceRoles: repeatedEmployerRoles,
        careerData: repeatedEmployerCareerData,
        evidenceCatalog: [
          { id: 'engineer-proof', sourceId: 'career-data', quote: 'Built the production Python service for customer reporting.' },
          { id: 'intern-proof', sourceId: 'career-data', quote: 'Built the internal JavaScript dashboard for support teams.' },
          { id: 'job-need', sourceId: 'job-listing', quote: 'Build reliable customer reporting systems.' },
        ],
      };
      const html = renderStructuredApplicationResume(repeatedEmployerResume, repeatedEmployerContext);
      let rejectedCrossRoleEvidence = false;
      try {
        const invalid = structuredClone(repeatedEmployerResume);
        invalid.roles[0].bullets[0].evidenceIds = ['intern-proof'];
        renderStructuredApplicationResume(invalid, repeatedEmployerContext);
      } catch { rejectedCrossRoleEvidence = true; }
      assert(html.includes('production Python service') && rejectedCrossRoleEvidence,
        'exact immutable role-ID markers take precedence over employer-name matching, so one Acme role cannot cite another Acme role’s evidence');
      return { repeatedEmployerScoped: rejectedCrossRoleEvidence };
    },
  },
  {
    name: 'Paste application assembly rejects ungrounded identities and candidate units without career evidence',
    run() {
      let rejectedIdentity = false;
      try {
        const value = fixture();
        value.paste.resume.identity.name = 'Untrusted Name';
        assemblePasteApplicationResult(value);
      } catch { rejectedIdentity = true; }
      let rejectedListingOnly = false;
      try {
        const value = fixture();
        value.paste.resume.roles[0].bullets[0].evidenceIds = ['job-need'];
        assemblePasteApplicationResult(value);
      } catch { rejectedListingOnly = true; }
      let rejectedCoverIdentity = false;
      try {
        const value = fixture();
        value.paste.coverLetter.name = 'A Different Candidate';
        assemblePasteApplicationResult(value);
      } catch { rejectedCoverIdentity = true; }
      let rejectedDuplicateParagraph = false;
      try {
        const value = fixture();
        value.paste.coverLetter.paragraphs.push({ ...value.paste.coverLetter.paragraphs[0] });
        assemblePasteApplicationResult(value);
      } catch { rejectedDuplicateParagraph = true; }
      let rejectedUnknownEvidence = false;
      try {
        const value = fixture();
        value.paste.coverLetter.paragraphs[0].evidenceIds = ['unknown-evidence'];
        assemblePasteApplicationResult(value);
      } catch { rejectedUnknownEvidence = true; }
      let rejectedStaleAudit = false;
      try {
        const value = fixture();
        value.paste.coverLetter.generationAudit.coverLetterPlan.paragraphs[0].paragraph = 'Stale prior wording.';
        assemblePasteApplicationResult(value);
      } catch { rejectedStaleAudit = true; }
      let rejectedMissingCoverIdentity = false;
      try {
        const value = fixture();
        delete value.paste.coverLetter.name;
        value.paste.coverLetter.contact = [];
        assemblePasteApplicationResult(value);
      } catch { rejectedMissingCoverIdentity = true; }
      let rejectedInventedProject = false;
      try {
        const value = fixture();
        value.paste.resume.projects = [{ id: 'project-1', name: 'Invented product launch', description: 'An invented candidate claim.', evidenceIds: ['career-proof'] }];
        assemblePasteApplicationResult(value);
      } catch { rejectedInventedProject = true; }
      let rejectedInventedSkillGroup = false;
      try {
        const value = fixture();
        value.paste.resume.skills = [{ id: 'skill-1', group: 'Invented specialty', items: ['Software Engineer'], evidenceIds: ['career-proof'] }];
        assemblePasteApplicationResult(value);
      } catch { rejectedInventedSkillGroup = true; }
      assert(rejectedIdentity && rejectedListingOnly && rejectedCoverIdentity && rejectedDuplicateParagraph && rejectedUnknownEvidence && rejectedStaleAudit
        && rejectedMissingCoverIdentity && rejectedInventedProject && rejectedInventedSkillGroup,
      'assembly rejects arbitrary or omitted identities, duplicate IDs, unknown IDs, stale audits, listing-only candidate copy, and invented rendered project or skill claims');
      return { rejectedIdentity, rejectedListingOnly, rejectedCoverIdentity, rejectedDuplicateParagraph, rejectedUnknownEvidence, rejectedStaleAudit, rejectedMissingCoverIdentity, rejectedInventedProject, rejectedInventedSkillGroup };
    },
  },
  {
    name: 'The audit paragraph binding is read by one comparison, so it cannot pass assembly and fail the completion gate',
    run() {
      // Two validators bind this same field: assembly, and the generation-audit
      // sanitizer a moment later inside validateLocalApplicationResult. They
      // used different normalizers — whitespace here, whitespace-after-NFKC
      // there — so a paragraph repeated back with a compatibility-equivalent
      // character failed one and passed the other. Both now read
      // normalizeBoundDocumentText.
      const paragraph = 'I built reporting systems that identified manual work.';
      const compatible = paragraph.replace('identified', 'identiﬁed');
      assert(compatible !== paragraph && normalizeBoundDocumentText(compatible) === normalizeBoundDocumentText(paragraph),
        'the fixture differs only by a character NFKC folds away');
      const value = fixture();
      value.paste.coverLetter.paragraphs[0].text = paragraph;
      value.paste.coverLetter.generationAudit.coverLetterPlan.paragraphs[0].paragraph = compatible;
      const result = assemblePasteApplicationResult(value);
      assert(result.coverLetter.paragraphs[0] === paragraph,
        'assembly binds the audit to the letter and keeps the letter’s own spelling of the paragraph');
      let differentText = '';
      try {
        const stale = fixture();
        stale.paste.coverLetter.generationAudit.coverLetterPlan.paragraphs[0].paragraph = 'Different wording from an earlier draft.';
        assemblePasteApplicationResult(stale);
      } catch (error) { differentText = String(error?.message || error); }
      assert(/does not repeat the final cover-letter paragraph it binds/u.test(differentText),
        `a paragraph that genuinely differs is still rejected, and the message states what was observed: ${differentText}`);
      return { folded: true };
    },
  },
  {
    name: 'A bullet may bind at most the disclosed number of distinct career-data quotes, and the cap is only reachable at assembly',
    run() {
      // The résumé stage checks that every cited ID exists and that at least
      // one is career evidence; it never counts them. A bullet citing five
      // distinct career-data quotes therefore clears that stage and dies here,
      // three stages later, which is why the résumé contract now prints this
      // number alongside the rules the drafting stage does enforce.
      const extraQuotes = [
        'Ran the nightly reconciliation for the billing ledger.',
        'Wrote the ingestion service for partner feeds.',
        'Documented the alerting runbook for on-call engineers.',
        'Rebuilt the export scheduler for downstream teams.',
      ];
      const cite = (count) => {
        const value = fixture();
        value.careerData = `${careerData}\n${extraQuotes.join('\n')}`;
        value.paste.evidencePlan.evidence = [
          ...value.paste.evidencePlan.evidence,
          ...extraQuotes.map((quote, index) => ({ id: `career-extra-${index + 1}`, sourceId: 'career-data', quote })),
        ];
        value.paste.resume.roles[0].bullets[0].evidenceIds = ['career-proof', ...extraQuotes.slice(0, count - 1).map((unused, index) => `career-extra-${index + 1}`)];
        return value;
      };
      const atCap = assemblePasteApplicationResult(cite(MAX_UNIT_CAREER_DATA_QUOTES));
      assert(atCap.qualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes.length === MAX_UNIT_CAREER_DATA_QUOTES,
        'a bullet citing exactly the disclosed number of distinct career-data quotes assembles');
      let overCap = '';
      try {
        assemblePasteApplicationResult(cite(MAX_UNIT_CAREER_DATA_QUOTES + 1));
      } catch (error) {
        overCap = String(error?.message || error);
      }
      assert(overCap.includes(`uses more than ${MAX_UNIT_CAREER_DATA_QUOTES} distinct career-data quotes`),
        `one more is rejected with the same number the contract prints (error=${overCap})`);
      return { cap: MAX_UNIT_CAREER_DATA_QUOTES };
    },
  },
  {
    name: 'Paste application assembly preserves exact multiline source quotes',
    run() {
      const value = fixture();
      value.careerData = 'Ada Lovelace\nada@example.test\n## Analytical Engines\nSoftware Engineer\n\nBuilt reporting\n systems that reduced manual work.';
      value.paste.evidencePlan.evidence[0].quote = 'Built reporting\n systems that reduced manual work.';
      const result = assemblePasteApplicationResult(value);
      assert(result.qualityReview.sourceGrounding.resumeBullets[0].careerDataQuotes[0] === 'Built reporting\n systems that reduced manual work.',
        'the assembly checks evidence against the frozen source before display-text whitespace normalization');
      return { multilineQuoteRetained: true };
    },
  },
  {
    name: 'Structured résumé renders source-backed project paraphrases and neutral skill headings only',
    run() {
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Built analytics reporting dashboards.', evidenceIds: ['career-proof'] }] }],
        projects: [{ id: 'project-1', name: 'Analytics reporting', description: 'Built analytics reporting dashboards that reduced manual work.', evidenceIds: ['career-proof'] }],
        skills: [{ id: 'skills-1', group: 'Tools', items: ['Analytics'], evidenceIds: ['career-proof'] }],
      };
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '' }],
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built analytics reporting dashboards that reduced manual work.' }],
        careerData: 'Ada Lovelace\nada@example.test\n# Acme\nEngineer\n\nBuilt analytics reporting dashboards that reduced manual work.\n# Personal Projects\n## Dashboards\n- Analytics reporting dashboards\nBuilt analytics reporting dashboards that reduced manual work.\n# Skills\nGoogle',
      };
      const html = renderStructuredApplicationResume(resume, context);
      let rejectedListingOnlyProject = false;
      try {
        renderStructuredApplicationResume({ ...resume, projects: [{ ...resume.projects[0], evidenceIds: ['listing-proof'] }] }, {
          ...context,
          evidenceCatalog: [...context.evidenceCatalog, { id: 'listing-proof', sourceId: 'job-listing', quote: 'Reporting systems' }],
        });
      } catch { rejectedListingOnlyProject = true; }
      let rejectedShortSubstringSkill = false;
      try {
        renderStructuredApplicationResume({ ...resume, skills: [{ ...resume.skills[0], items: ['Go'] }] }, context);
      } catch { rejectedShortSubstringSkill = true; }
      const sparseProjects = [resume.projects[0]];
      sparseProjects.length = 2;
      let sparseProjectMessage = '';
      try {
        renderStructuredApplicationResume({ ...resume, projects: sparseProjects }, context);
      } catch (error) { sparseProjectMessage = String(error?.message || error); }
      assert(html.includes('Analytics reporting') && html.includes('Personal Projects') && rejectedListingOnlyProject && rejectedShortSubstringSkill
        && sparseProjectMessage.includes('projects[1] must be an object.'),
      'project display copy retains its source provenance heading, while neutral editorial headings remain usable and listing-only, substring-only, or sparse project input is rejected at validation');
      return { projectRendered: true, rejectedListingOnlyProject, rejectedShortSubstringSkill, sparseProjectRejected: true };
    },
  },
  {
    // THE DEFECT this covers, rendered by a real generation: one lowercase row
    // labelled with a synonym of its own section head, a dozen terms of which
    // three were concepts rather than names, in a `dd` far past one printed
    // line. Nothing refused any of it: the structural ceilings are 8x looser
    // than the design system (24 groups of 48 items), and the only skills check
    // that existed — build/fit-estimate-test.js — reads `dd` text and never runs
    // against generated output. The design system's shape is 3 Title Case
    // domain rows, 16-20 filterable nouns, no `dd` over 64 characters.
    //
    // The names below are invented and belong to no field in particular: the
    // budget gates count rows, items and characters and must not care what the
    // words are.
    name: 'The rendered skills block is held to the design system’s shape, not to the structural ceilings',
    run() {
      const names = ['Aster', 'Birch', 'Cedar', 'Dune', 'Ember', 'Fjord', 'Garnet', 'Heron', 'Iris', 'Juniper', 'Kestrel', 'Lumen', 'Mica', 'Nimbus', 'Onyx', 'Pylon', 'Quartz', 'Ridge', 'Sable', 'Tundra', 'Umber'];
      const longNames = ['Meridian Ledger', 'Observatory Console', 'Cartographic Suite', 'Foundry Scheduler', 'Harbourmaster Portal'];
      const concepts = ['handoff coaching', 'shift swapping', 'workflow mapping'];
      const skillsCareer = [
        'Ada Lovelace', 'ada@example.test', 'Operations Lead',
        'Coordinated the Aster rota and the Birch intake desk.',
        `Used ${names.join(', ')} across the site.`,
        `Operated ${longNames.join(', ')} for the regional office.`,
        `Practised ${concepts.join(', ')} with new staff.`,
      ].join('\n');
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }],
        evidenceCatalog: ['career-proof'],
        careerData: skillsCareer,
      };
      const resume = (skills) => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Coordinated the Aster rota and the Birch intake desk.', evidenceIds: ['career-proof'] }] }],
        skills,
      });
      const group = (index, label, items) => ({ id: `skills-${index}`, group: label, items, evidenceIds: ['career-proof'] });
      const outcome = (skills) => structuredOutcome(resume(skills), context);
      const rejection = (skills) => outcome(skills).text;

      // The shipped block itself: one rejection round names the label, the
      // unsplit row, the row's length and all three concepts, because every
      // repair costs the user the same manual copy/paste round.
      const shippedItems = [...names.slice(0, 8), ...concepts];
      const shipped = rejection([group(0, 'skills', shippedItems)]);
      assert(shipped.includes('skills[0].group "skills" must be a neutral category label')
        && shipped.includes(`skills[0].group "skills" carries all ${shippedItems.length} items of this block under one label`)
        && shipped.includes(`skills[0].items renders a row of ${shippedItems.join(' · ').length} characters`)
        && concepts.every(item => shipped.includes(`skills[0] item "${item}"`)),
      `the whole shipped skills defect is reported in one round (got ${shipped})`);
      // Layout, label vocabulary and the capitalisation guess are TASTE: the
      // writer is told, the document is not refused for them.
      assert(!outcome([group(0, 'skills', shippedItems)]).rejected,
        'a skills block that only breaks the design system’s shape advises and is never rejected for it');

      // Each budget gate alone, on a block that breaks only that one, so a
      // later edit cannot pass this case by rejecting everything.
      const fourRows = rejection([
        group(0, 'tools', names.slice(0, 2)),
        group(1, 'methods', names.slice(2, 4)),
        group(2, 'systems', names.slice(4, 6)),
        group(3, 'practices', names.slice(6, 8)),
      ]);
      assert(fourRows.includes(`skills renders 4 rows but this block carries at most ${STRUCTURED_RESUME_SKILLS_BUDGET.groups}`)
        && !fourRows.includes('item "') && !fourRows.includes('renders a row of'),
      `a fourth row is rejected on the row budget alone (got ${fourRows})`);

      const overTerms = rejection([
        group(0, 'tools', names.slice(0, 7)),
        group(1, 'methods', names.slice(7, 14)),
        group(2, 'systems', names.slice(14, 21)),
      ]);
      assert(overTerms.includes(`skills lists 21 items but this block carries at most ${STRUCTURED_RESUME_SKILLS_BUDGET.items} in total`)
        && !overTerms.includes('renders a row of') && !overTerms.includes('rows but this block'),
      `21 terms inside 3 short rows are rejected on the term budget alone (got ${overTerms})`);

      // Five items, so the split gate stands down and only the rendered row's
      // own length is at issue. The gate measures the string the renderer
      // emits, separators included.
      const overRow = rejection([group(0, 'systems', longNames)]);
      assert(overRow.includes(`skills[0].items renders a row of ${longNames.join(' · ').length} characters but a row holds at most ${STRUCTURED_RESUME_SKILLS_BUDGET.rowChars}`)
        && !overRow.includes('carries all') && !overRow.includes('item "'),
      `a row past the character budget is rejected on its own, measured on what renders (got ${overRow})`);

      const unsplit = names.slice(0, 6);
      const oneBigRow = rejection([group(0, 'tools', unsplit)]);
      assert(oneBigRow.includes(`skills[0].group "tools" carries all ${unsplit.length} items of this block under one label`)
        && oneBigRow.includes(`must name at least ${STRUCTURED_RESUME_SKILLS_BUDGET.splitIntoGroups} groups`)
        && !oneBigRow.includes('renders a row of'),
      `a block that has reached the split threshold must be split even when its row fits (got ${oneBigRow})`);
      assert(rejection([group(0, 'tools', unsplit.slice(0, STRUCTURED_RESUME_SKILLS_BUDGET.splitAtItems - 1))]) === '',
        'one row below the split threshold is still a real answer and is accepted');

      // The concept rule, batched: three lowercase phrases across two groups
      // come back as one message, and the named products beside them are never
      // mentioned.
      const conceptual = rejection([
        group(0, 'systems', [names[0], concepts[0], concepts[1]]),
        group(1, 'methods', [names[1], concepts[2]]),
      ]);
      assert([`skills[0] item "${concepts[0]}"`, `skills[0] item "${concepts[1]}"`, `skills[1] item "${concepts[2]}"`].every(fragment => conceptual.includes(fragment))
        && !conceptual.includes(`"${names[0]}"`) && !conceptual.includes(`"${names[1]}"`)
        && conceptual.split('also applies to').length === 2,
      `every concept phrase is reported once in one round while the filterable names beside them pass (got ${conceptual})`);

      const clean = [
        group(0, 'tools', names.slice(0, 2)),
        group(1, 'methods', names.slice(2, 4)),
        group(2, 'systems', names.slice(4, 7)),
      ];
      const html = renderStructuredApplicationResume(resume(clean), context);
      assert(html.includes(`<dt>Tools</dt><dd>${names.slice(0, 2).join(' · ')}</dd>`)
        && html.includes(`<dt>Methods</dt><dd>${names.slice(2, 4).join(' · ')}</dd>`)
        && html.includes(`<dt>Systems</dt><dd>${names.slice(4, 7).join(' · ')}</dd>`),
      `a three-row block inside every budget renders the design system's own shape (got ${html})`);
      return { gates: 5, cleanRows: clean.length, shippedTerms: shippedItems.length };
    },
  },
  {
    // `.skills dt` has no text-transform (resume.css:568-574), so whatever a
    // response wrote printed. Every `<dt>` the design system ships is Title
    // Case and no prose rule anywhere said so, which is how a lowercase label
    // reached a PDF.
    name: 'A skills-group label renders in Title Case without changing the text it was graded as',
    run() {
      const labelCareer = [
        'Ada Lovelace', 'ada@example.test', 'Operations Lead',
        'Ran the Aster rota and the Birch intake desk for the regional office.',
        'Reviewed the QA/HR handoff for the regional office.',
      ].join('\n');
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }],
        evidenceCatalog: ['career-proof'],
        careerData: labelCareer,
      };
      const resume = (skills) => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Ran the Aster rota and the Birch intake desk for the regional office.', evidenceIds: ['career-proof'] }] }],
        skills,
      });
      const group = (index, label, items) => ({ id: `skills-${index}`, group: label, items, evidenceIds: ['career-proof'] });
      const outcome = (skills) => structuredOutcome(resume(skills), context);
      const rejection = (skills) => outcome(skills).text;

      const cased = [
        group(0, 'tools and methods', ['Aster']),
        group(1, 'systems & practices', ['Birch']),
        group(2, 'qa/hr', ['Aster']),
      ];
      const html = renderStructuredApplicationResume(resume(cased), context);
      assert(html.includes('<dt>Tools and Methods</dt>')
        && html.includes('<dt>Systems &amp; Practices</dt>')
        && html.includes('<dt>QA/HR</dt>'),
      `a lowercase label renders Title Case, its connectors survive, a connecting "and" stays lowercase, and a short lowercase abbreviation from the career data prints as an acronym (got ${html})`);

      // Casing is display only: the validated draft every later stage reads,
      // echoes and patches still carries the text the response actually sent.
      const draft = validateStructuredApplicationResume(resume(cased), context);
      assert(draft.skills.map(entry => entry.group).join('|') === 'tools and methods|systems & practices|qa/hr',
        'the validated draft keeps the responder’s own label text, so the careerData and neutral-vocabulary comparisons read what was sent');

      // The section-head synonyms are never part of the vocabulary. A row
      // labelled with one of them restates the <h2>Skills</h2> above it and
      // gives a parser no category axis it did not already have.
      const sectionHeadSynonyms = ['skills', 'technical skills', 'technologies'];
      assert(sectionHeadSynonyms.every(label => !NEUTRAL_SKILL_GROUP_LABELS.includes(label)),
        'the neutral vocabulary no longer offers a label that only names the section');
      for (const label of sectionHeadSynonyms) {
        const message = rejection([group(0, label, ['Aster', 'Birch'])]);
        assert(message.includes(`skills[0].group "${label}" must be a neutral category label`)
          && sectionHeadSynonyms.every(synonym => !message.includes(`, ${synonym},`)),
        `"${label}" is rejected and the vocabulary the rejection prints never offers it back (got ${message})`);
      }
      // 'tools' stays: it is a real kind of skill in any field.
      assert(NEUTRAL_SKILL_GROUP_LABELS.includes('tools')
        && renderStructuredApplicationResume(resume([group(0, 'tools', ['Aster'])]), context).includes('<dt>Tools</dt>'),
      'a label naming a kind of skill rather than the section is still accepted, and renders Title Case');
      // The acronym rule is structural, not a list: a short lowercase word is
      // printed as an acronym unless it is a two-letter function word, so a
      // label from any field's abbreviation is cased alike.
      assert(titleCaseSkillGroupLabel('qa & hr') === 'QA & HR'
        && titleCaseSkillGroupLabel('tools of the trade') === 'Tools Of The Trade'
        && titleCaseSkillGroupLabel('iOS and c') === 'iOS and C',
      'a short lowercase word is an acronym, a function word is not, and a word that already carries an uppercase letter is left exactly as written');
      return { labels: cased.length, rejectedSynonyms: sectionHeadSynonyms.length };
    },
  },
  {
    // THE DEFECT: the app could not emit the design system's OWN exemplar
    // labels, because the label vocabulary was a closed list and a list cannot
    // name the compound domains a real profile carries. Closing the gap by
    // widening the list for each sample row was the wrong repair: it taught the
    // gate one trade's nouns. The vocabulary is now a small domain-neutral base
    // plus what the approved snapshot's own skill rows contribute.
    //
    // This case harvests the labels from the design system's own files rather
    // than restating them, then proves each is emit-able exactly when the
    // current approved profile carries it: an exemplar row this app cannot
    // emit fails here instead of costing the user a manual correction round,
    // and the same row is refused when no approved evidence backs it.
    name: 'Every skills-row label the design system ships is emit-able when the approved profile carries it, in its published casing',
    run() {
      // Each file publishes an exemplar skills block: the shipped sample, the
      // component preview, the in-context multi-page check, the line-yield
      // measurement harness, and the whole-Application fixtures.
      const exemplarFiles = ['resume.html', 'preview/component-skills.html', 'build/multi-page-fragmentation-check.html', 'build/line-yield-check.html', 'uploads/Application.html', 'handoff/Application-paginated-example.html'];
      const shippedLabels = new Map();
      for (const file of exemplarFiles) {
        const markup = fs.readFileSync(new URL(`../../Job Application Design System/${file}`, import.meta.url), 'utf8');
        const labels = [...markup.matchAll(/<dt[^>]*>([^<]*)<\/dt>/gu)].map(match => match[1].replace(/&amp;/gu, '&').trim()).filter(Boolean);
        assert(labels.length > 0, `the design system still publishes skills-row labels in ${file}`);
        for (const label of labels) shippedLabels.set(label, [...(shippedLabels.get(label) || []), file]);
      }
      const sectionHead = new Set(['skills', 'technical skills', 'technologies']);
      const exemplars = [...shippedLabels.keys()].filter(label => !sectionHead.has(label.toLocaleLowerCase()));
      assert(exemplars.length > 0, 'the design system ships at least one skills-row label that is not a synonym of the section head');

      const careerData = 'Ada Lovelace\nada@example.test\n## Analytical Engines\nOperations Lead\n\nReconciled the Zephyr Ledger for the regional office.';
      const evidenceCatalog = [
        { id: 'career-proof', sourceId: 'career-data', quote: 'Reconciled the Zephyr Ledger for the regional office.' },
        { id: 'job-need', sourceId: 'job-listing', quote: 'Own the reporting workflow for the office.' },
      ];
      const sourceRoles = [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];
      const resume = (label) => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Reconciled the Zephyr Ledger for the regional office.', evidenceIds: ['career-proof'] }] }],
        skills: [{ id: 'skills-1', group: label, items: ['Zephyr Ledger'], evidenceIds: ['career-proof'] }],
      });
      const rendered = (label, category) => {
        try {
          return renderStructuredApplicationResume(resume(label), {
            sourceRoles, evidenceCatalog, careerData, authorityMode: true,
            careerSkillEvidence: approvedInventory(approvedSkill('zephyr', 'Zephyr Ledger', category ? { category } : {})),
          });
        } catch (error) { return `REJECTED: ${String(error?.message || error)}`; }
      };
      const skillsBlock = (html) => /<dl class="skills">.*?<\/dl>/su.exec(html)?.[0] || html;
      const labelAdvisories = (label, category) => validateStructuredApplicationResume(resume(label), {
        sourceRoles, evidenceCatalog, careerData, authorityMode: true,
        careerSkillEvidence: approvedInventory(approvedSkill('zephyr', 'Zephyr Ledger', category ? { category } : {})),
      }).advisories;
      assert(exemplars.every(label => !careerData.toLocaleLowerCase().includes(label.toLocaleLowerCase())),
        'the frozen corpus states no exemplar label, so only the vocabulary can accept one');

      const baseOnly = skillGroupVocabulary(null);
      let evidenceRelative = 0;
      for (const label of exemplars) {
        const printed = `<dt>${label.replace(/&/gu, '&amp;')}</dt>`;
        // Both spellings a responder can plausibly send have to reach the
        // published casing: the label as the design system prints it, and the
        // all-lowercase form the prompt's own vocabulary offers it in.
        for (const sent of [label, label.toLocaleLowerCase()]) {
          const html = rendered(sent, label);
          assert(html.includes(printed),
            `${shippedLabels.get(label)?.join(', ')} publishes "${label}"; sent as "${sent}" against an approved profile whose category is "${label}" it must be accepted and render as ${printed} (got ${skillsBlock(html)})`);
        }
        // The same label with no approved evidence behind it is refused unless
        // it is made of the domain-neutral base alone.
        const unbacked = rendered(label, '');
        const neutralAlone = label.toLocaleLowerCase().split(/\s*(?:&|\/|,|\band\b)\s*/u).filter(Boolean).every(part => baseOnly.words.has(part));
        if (!neutralAlone) {
          // The vocabulary is a labelling preference: a label the approved
          // profile does not carry is advised about and still renders.
          assert(!unbacked.startsWith('REJECTED:') && unbacked.includes(printed),
            `"${label}" is not a reason to reject the document when the approved profile does not carry it (got ${skillsBlock(unbacked)})`);
          const advice = labelAdvisories(label, '');
          assert(advice.some(entry => entry.id === 'skill-group-is-neutral-or-in-career-data' && entry.detail.includes(`skills[0].group "${label}" must be a neutral category label`)),
            `"${label}" is only a neutral label when the approved profile carries it, and the writer is told so (got ${JSON.stringify(advice)})`);
          evidenceRelative += 1;
        }
      }

      // Widening the nouns did not widen the gate: an editorializing word
      // beside an approved category is still refused on the same rule.
      // A label that GRADES the candidate's skill is a strength claim, not a
      // vocabulary preference, so it is still refused: on its own rule, because
      // the evidence cited for the group never states the level.
      const first = exemplars[0];
      const editorialized = rendered(`Advanced ${first}`, first);
      assert(editorialized.startsWith('REJECTED:')
        && editorialized.includes(`skills[0].group "Advanced ${first}" grades the candidate’s skill with “advanced”`),
      `a compound built on a skill-level word is still rejected (got ${editorialized})`);
      return { exemplars: exemplars.length, files: exemplarFiles.length, evidenceRelative, casings: 2 };
    },
  },
  {
    name: 'The skills-row vocabulary is a small neutral base plus the approved profile’s own kinds and categories, never the section head',
    run() {
      const base = skillGroupVocabulary(null);
      assert(JSON.stringify(base.labels) === JSON.stringify([...NEUTRAL_SKILL_GROUP_LABELS].sort())
        && base.labels.length <= 12,
      `a retained pre-snapshot job has only the small base (got ${base.labels.join(', ')})`);

      const projected = [
        { name: 'Aster Press', capabilityKind: 'language' },
        { name: 'Birch Ledger', capabilityKind: 'technology', category: 'Ward Operations & Triage' },
        { name: 'Cedar Loom', capabilityKind: 'capability', category: 'Skills' },
      ];
      const derived = skillGroupVocabulary(projected);
      assert(['languages', 'capabilities', 'ward operations', 'triage'].every(label => derived.words.has(label))
        && base.labels.every(label => derived.words.has(label)),
      `kinds and categories the approved rows carry join the base (got ${derived.labels.join(', ')})`);
      assert(!derived.words.has('technologies') && !derived.words.has('skills') && !derived.words.has('technical skills'),
        'a kind or category that merely names the section is never offered, whichever layer it came from');
      assert(!derived.words.has('frameworks') && !derived.words.has('platform'),
        'a kind no approved row carries is not offered');
      const rule = neutralSkillGroupRule(derived);
      assert(derived.labels.every(label => rule.includes(label)) && /up to 3 of those joined by/u.test(rule),
        'the stated rule is built from the vocabulary the gate reads');
      assert(NEUTRAL_SKILL_GROUP_RULE.includes('capabilityKind') && NEUTRAL_SKILL_GROUP_RULE.includes('language gives languages')
        && !NEUTRAL_SKILL_GROUP_RULE.includes('technology gives'),
      'the prompt-time rule names where the rest of the vocabulary comes from, derived from the controlled taxonomy');
      return { base: base.labels.length, derived: derived.labels.length };
    },
  },
  {
    name: 'The skills budget this app enforces is the budget the design system publishes',
    run() {
      // structuredResume.js restates these three numbers because
      // build/fit-estimate-test.js is a CommonJS build script that runs its
      // whole suite on load and exports nothing, so it cannot be imported by
      // the validator. This case is what keeps the restatement honest: both
      // published sources are read here, and a drift on either side fails.
      const fitGate = fs.readFileSync(new URL('../../Job Application Design System/build/fit-estimate-test.js', import.meta.url), 'utf8');
      const published = /skillsRow:\s+(\d+),[^\n]*\n\s*skillsRows:\s+(\d+)/u.exec(fitGate);
      assert(published, 'the design system still publishes its skills row budget in build/fit-estimate-test.js');
      const skillMd = fs.readFileSync(new URL('../../Job Application Design System/SKILL.md', import.meta.url), 'utf8');
      const negativeSpace = /No skills block over (\d+) rows \/ (\d+) terms/u.exec(skillMd);
      assert(negativeSpace, 'SKILL.md still states the whole-block ceiling in its negative-space list');
      assert(STRUCTURED_RESUME_SKILLS_BUDGET.rowChars === Number(published[1])
        && STRUCTURED_RESUME_SKILLS_BUDGET.groups === Number(published[2])
        && STRUCTURED_RESUME_SKILLS_BUDGET.groups === Number(negativeSpace[1])
        && STRUCTURED_RESUME_SKILLS_BUDGET.items === Number(negativeSpace[2]),
      `the enforced budget equals the published one (enforced=${JSON.stringify(STRUCTURED_RESUME_SKILLS_BUDGET)}, fit gate=${published.slice(1, 3)}, SKILL.md=${negativeSpace.slice(1, 3)})`);
      // The sentence a responder is given is interpolated from the same
      // constants the gates read, so it can never state a budget the gates do
      // not enforce.
      assert(SKILLS_BLOCK_BUDGET_RULE.includes(`at most ${STRUCTURED_RESUME_SKILLS_BUDGET.groups} groups and ${STRUCTURED_RESUME_SKILLS_BUDGET.items} items`)
        && SKILLS_BLOCK_BUDGET_RULE.includes(`at most ${STRUCTURED_RESUME_SKILLS_BUDGET.rowChars} characters`)
        && SKILLS_BLOCK_BUDGET_RULE.includes(`${STRUCTURED_RESUME_SKILLS_BUDGET.splitAtItems} items or more is sorted into at least ${STRUCTURED_RESUME_SKILLS_BUDGET.splitIntoGroups} groups`),
      `the stated budget is interpolated from the constants the gates read (got ${SKILLS_BLOCK_BUDGET_RULE})`);
      // The structural ceilings stay far looser on purpose: they bound a
      // pathological paste, they are not the design budget.
      assert(STRUCTURED_RESUME_LIMITS.skillGroups > STRUCTURED_RESUME_SKILLS_BUDGET.groups
        && STRUCTURED_RESUME_LIMITS.skillItemsPerGroup > STRUCTURED_RESUME_SKILLS_BUDGET.items,
      'the structural ceilings remain the outer bound on a pathological response, above the design budget');
      return { rowChars: STRUCTURED_RESUME_SKILLS_BUDGET.rowChars, rows: STRUCTURED_RESUME_SKILLS_BUDGET.groups, terms: STRUCTURED_RESUME_SKILLS_BUDGET.items };
    },
  },
  {
    name: 'A project earns its place on one résumé rather than on every résumé alike',
    run() {
      // Career grounding says a project is true of the candidate. It never
      // said the project belongs on THIS résumé, so a true one rendered for
      // every posting alike — the one thing a tailored résumé is not.
      const career = { id: 'career-proof', sourceId: 'career-data', quote: 'Built analytics reporting dashboards that reduced manual work.' };
      const project = { id: 'project-1', name: 'Analytics reporting', description: 'Built analytics reporting dashboards that reduced manual work.', evidenceIds: ['career-proof'] };
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Built analytics reporting dashboards.', evidenceIds: ['career-proof'] }] }],
        projects: [project],
      };
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '' }],
        careerData: 'Ada Lovelace\nada@example.test\n# Acme\nEngineer\n\nBuilt analytics reporting dashboards that reduced manual work.\n# Personal Projects\n## Dashboards\n- Analytics reporting dashboards\nBuilt analytics reporting dashboards that reduced manual work.',
      };
      const posting = { id: 'job-analytics', sourceId: 'job-listing', quote: 'analytics reporting ownership' };
      const unrelated = { id: 'job-unrelated', sourceId: 'job-listing', quote: 'warehouse logistics scheduling' };
      const outcome = (projects, evidenceCatalog) => structuredOutcome({ ...resume, projects }, { ...context, evidenceCatalog });
      const render = (projects, evidenceCatalog) => outcome(projects, evidenceCatalog).text;

      const careerOnly = render([project], [career, posting]);
      const citedButUnrelated = render([{ ...project, evidenceIds: ['career-proof', 'job-unrelated'] }], [career, posting, unrelated]);
      const answersThePosting = render([{ ...project, evidenceIds: ['career-proof', 'job-analytics'] }], [career, posting]);
      assert(/cites no job-listing evidence/.test(careerOnly)
        && /share at least two distinct meaningful terms with a job-listing quote/.test(citedButUnrelated)
        && answersThePosting === '',
      'a project the posting does not ask about is reported to the writer: it cites a posting quote and shares that quote’s words, and citing one it answers nothing of does not save it');
      // Relevance is selection, not grounding: the project is TRUE, so the
      // document is told and never refused for it.
      assert(!outcome([project], [career, posting]).rejected
        && !outcome([{ ...project, evidenceIds: ['career-proof', 'job-unrelated'] }], [career, posting, unrelated]).rejected,
      'a true project that does not answer the posting advises and is never rejected');

      // The same standdown the career-evidence rule takes: a plan that named
      // no posting evidence cannot be graded on posting relevance, and a rule
      // that cannot read its input must not invent a verdict.
      assert(render([project], [career]) === '',
        'a catalog carrying no job-listing evidence at all grades no project against the posting');
      return { careerOnlyAdvised: true, unrelatedCitationAdvised: true };
    },
  },
  {
    name: 'One handoff round reports every same-class structured résumé defect in a collection',
    run() {
      const batchCareerData = 'Ada Lovelace\nada@example.test\nEngineer\nBuilt JavaScript, Python and Docker reporting systems that reduced manual work.';
      const batchContext = {
        sourceRoles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '' }],
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built JavaScript, Python and Docker reporting systems that reduced manual work.' }],
        careerData: batchCareerData,
      };
      const batchResume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Built reporting systems.', evidenceIds: ['career-proof'] }] }],
      };
      const rejection = (resume) => structuredOutcome(resume, batchContext).text;

      // The measured chain this replaces: three invented group labels cost
      // three sequential manual copy/paste handoff rounds, one per offender.
      // The labels that still REJECT are the ones that grade the candidate's
      // own skill (a strength the evidence never states); a merely invented
      // label advises, and is batched the same way below.
      const groupNames = ['Expert Wizardry', 'Advanced Ninja Skills', 'Proficient Craft'];
      const threeBadGroups = rejection({
        ...batchResume,
        skills: groupNames.map((group, index) => ({ id: `skills-${index}`, group, items: ['JavaScript'], evidenceIds: ['career-proof'] })),
      });
      assert(groupNames.every(group => threeBadGroups.includes(`"${group}"`)),
        'one résumé rejection names every offending skill-group label instead of revealing one per handoff round');
      assert(/skills\[0\]\.group/u.test(threeBadGroups) && /skills\[1\]\.group/u.test(threeBadGroups) && /skills\[2\]\.group/u.test(threeBadGroups),
        'the batched group-label failure locates every offender by its own index');

      // A single offender keeps its exact existing wording, so the rule text
      // the responder is shown never changes shape with the offender count.
      const oneBadGroup = rejection({ ...batchResume, skills: [{ id: 'skills-0', group: groupNames[0], items: ['JavaScript'], evidenceIds: ['career-proof'] }] });
      assert(oneBadGroup.includes(`skills[0].group "${groupNames[0]}"`) && !/same rule also rejects/u.test(oneBadGroup),
        'a lone offender still reports the single-offender message without a multi-offender tail');
      assert(threeBadGroups.startsWith(oneBadGroup.replace(/\.$/u, '')) || threeBadGroups.includes(oneBadGroup),
        'the batched failure restates the full rule before listing the remaining offenders');

      const ungroundedItems = rejection({
        ...batchResume,
        skills: [
          { id: 'skills-0', group: 'Languages', items: ['Kubernetes', 'Rust'], evidenceIds: ['career-proof'] },
          { id: 'skills-1', group: 'Tools', items: ['Haskell', 'Erlang'], evidenceIds: ['career-proof'] },
        ],
      });
      assert(['Kubernetes', 'Rust', 'Haskell', 'Erlang'].every(item => ungroundedItems.includes(`"${item}"`)),
        'one rejection names every ungrounded skill item across all skill groups');

      const ungroundedProjects = rejection({
        ...batchResume,
        projects: [
          { id: 'alpha', name: 'Invented Alpha', evidenceIds: ['career-proof'] },
          { id: 'beta', name: 'Invented Beta', evidenceIds: ['career-proof'] },
          { id: 'gamma', name: 'Invented Gamma', evidenceIds: ['career-proof'] },
        ],
      });
      assert(ungroundedProjects.includes('projects.alpha.name') && ungroundedProjects.includes('projects.beta.name') && ungroundedProjects.includes('projects.gamma.name'),
        'one rejection names every ungrounded project field');

      const unknownBulletEvidence = rejection({
        ...batchResume,
        roles: [{ ...batchResume.roles[0], bullets: [
          { id: 'bullet-1', text: 'Built reporting systems.', evidenceIds: ['missing-one'] },
          { id: 'bullet-2', text: 'Built more reporting systems.', evidenceIds: ['missing-two'] },
          { id: 'bullet-3', text: 'Built other reporting systems.', evidenceIds: ['missing-three'] },
        ] }],
      });
      assert(['missing-one', 'missing-two', 'missing-three'].every(evidenceId => unknownBulletEvidence.includes(`"${evidenceId}"`)),
        'one rejection names every bullet citing unverified evidence across the role');

      // Bounded output: a pathological response cannot produce an unbounded
      // correction prompt, and the count of hidden offenders stays visible.
      const manyBadGroups = rejection({
        ...batchResume,
        skills: Array.from({ length: 20 }, (unused, index) => ({ id: `skills-${index}`, group: `Expert Specialty ${index}`, items: ['JavaScript'], evidenceIds: ['career-proof'] })),
      });
      assert(/and \d+ more/u.test(manyBadGroups) && manyBadGroups.length < 2_000 && !manyBadGroups.includes('Expert Specialty 19'),
        'a collection full of offenders reports a bounded list plus a count of the remainder');
      // An advisory collection is bounded the same way: advice about twenty
      // invented labels is one finding, not twenty.
      const manyAdvisedGroups = structuredOutcome({
        ...batchResume,
        skills: Array.from({ length: 20 }, (unused, index) => ({ id: `skills-${index}`, group: `Invented Specialty ${index}`, items: ['JavaScript'], evidenceIds: ['career-proof'] })),
      }, { ...batchContext, careerData: 'Ada Lovelace\nada@example.test\n## Acme\nEngineer\n\nBuilt JavaScript, Python and Docker reporting systems that reduced manual work.' });
      assert(!manyAdvisedGroups.rejected && manyAdvisedGroups.advisories.filter(entry => entry.id === 'skill-group-is-neutral-or-in-career-data').length === 1
        && /and \d+ more/u.test(manyAdvisedGroups.advisoryText) && !manyAdvisedGroups.advisoryText.includes('Invented Specialty 19'),
      'twenty invented labels are one bounded advisory and no rejection');
      return { batchedGroups: 3, batchedItems: 4, batchedProjects: 3, batchedBullets: 3 };
    },
  },
  {
    name: 'One handoff round reports a same-class defect across every role, project and skill group it appears in',
    run() {
      // Measured before this: three bad skill items in one group reported
      // together, but three bad bullets in three ROLES did not, because each
      // role drained its own collector — so a corpus with three employers
      // cost three manual copy/paste rounds for one rule the responder had to
      // relearn once. The same held across collections: a bad bullet hid a
      // bad project and a bad skill group behind it.
      const careerData = [
        'Ada Lovelace', 'ada@example.test', '',
        '## Analytical Engines', '', 'Senior Engineer', '*2021 – 2024*',
        '- Built the reporting pipeline for nightly batches.',
        '- Shipped JavaScript and Docker tooling for the pipeline.', '', '---', '',
        '## Difference Machines', '', 'Software Engineer', '*2018 – 2021*',
        '- Shipped the billing service with automated alerts.', '', '---', '',
        '## Third Works', '', 'Engineer', '*2016 – 2018*',
        '- Ran the ledger migration for the finance team.', '', '---', '',
      ].join('\n');
      const context = {
        sourceRoles: [
          { id: 'r1', title: 'Senior Engineer', company: 'Analytical Engines', dates: '2021 – 2024', location: '' },
          { id: 'r2', title: 'Software Engineer', company: 'Difference Machines', dates: '2018 – 2021', location: '' },
          { id: 'r3', title: 'Engineer', company: 'Third Works', dates: '2016 – 2018', location: '' },
        ],
        evidenceCatalog: [
          { id: 'e1', sourceId: 'career-data', quote: 'Built the reporting pipeline for nightly batches.' },
          { id: 'e2', sourceId: 'career-data', quote: 'Shipped the billing service with automated alerts.' },
          { id: 'e3', sourceId: 'career-data', quote: 'Ran the ledger migration for the finance team.' },
          { id: 'e4', sourceId: 'career-data', quote: 'Shipped JavaScript and Docker tooling for the pipeline.' },
          { id: 'job', sourceId: 'job-listing', quote: 'reporting work' },
        ],
        careerData,
      };
      const draft = () => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [
          { id: 'r1', title: 'Senior Engineer', company: 'Analytical Engines', dates: '2021 – 2024', location: '', bullets: [{ id: 'b1', text: 'Built the reporting pipeline for nightly batches.', evidenceIds: ['e1'] }] },
          { id: 'r2', title: 'Software Engineer', company: 'Difference Machines', dates: '2018 – 2021', location: '', bullets: [{ id: 'b2', text: 'Shipped the billing service with automated alerts.', evidenceIds: ['e2'] }] },
          { id: 'r3', title: 'Engineer', company: 'Third Works', dates: '2016 – 2018', location: '', bullets: [{ id: 'b3', text: 'Ran the ledger migration for the finance team.', evidenceIds: ['e3'] }] },
        ],
        skills: [{ id: 's1', group: 'Tools', items: ['JavaScript', 'Docker'], evidenceIds: ['e4'] }],
      });
      const rejection = (resume) => structuredOutcome(resume, context).message;

      const acrossRoles = draft();
      acrossRoles.roles.forEach((role, index) => { role.bullets[0].evidenceIds = [`ghost-${index}`]; });
      const rolesMessage = rejection(acrossRoles);
      assert(['ghost-0', 'ghost-1', 'ghost-2'].every(evidenceId => rolesMessage.includes(`"${evidenceId}"`))
        && /roles\[0\]/u.test(rolesMessage) && /roles\[1\]/u.test(rolesMessage) && /roles\[2\]/u.test(rolesMessage),
      `one rejection names the offending bullet in every role, not only the first (got ${rolesMessage})`);

      // The scope rule is the measured top rejection, and it too now reports
      // every role at once.
      const scopeAcrossRoles = draft();
      scopeAcrossRoles.roles[1].bullets[0].evidenceIds = ['e1'];
      scopeAcrossRoles.roles[2].bullets[0].evidenceIds = ['e1'];
      const scopeMessage = rejection(scopeAcrossRoles);
      assert(scopeMessage.includes('roles[1].bullets[0]') && scopeMessage.includes('roles[2].bullets[0]')
        && /same rule also rejects 1 more/u.test(scopeMessage),
      `one rejection names every out-of-section bullet across roles (got ${scopeMessage})`);

      // Four different rules, in three different collections, in one round.
      const acrossCollections = draft();
      acrossCollections.roles[1].bullets[0].evidenceIds = ['e1'];
      acrossCollections.roles[2].bullets[0].evidenceIds = ['ghost'];
      acrossCollections.projects = [{ id: 'p1', name: 'Invented Alpha', evidenceIds: ['e1'] }];
      acrossCollections.skills = [{ id: 's1', group: 'Bespoke Wizardry', items: ['Haskell'], evidenceIds: ['e1'] }];
      const collectionsOutcome = structuredOutcome(acrossCollections, context);
      const collectionsMessage = collectionsOutcome.message;
      assert(collectionsMessage.includes('roles[1].bullets[0]') && collectionsMessage.includes('"ghost"')
        && collectionsMessage.includes('projects.p1.name') && collectionsMessage.includes('"Haskell"'),
      `a bullet, a project and a skill item defect are reported in one rejection (got ${collectionsMessage})`);
      // The invented skill-group label is TASTE: it rides along as an advisory
      // on the same rejection and is never part of what rejects.
      assert(!collectionsMessage.includes('Bespoke Wizardry') && collectionsOutcome.advisoryText.includes('skills[0].group "Bespoke Wizardry"'),
        `a skill-group label the vocabulary does not offer is advised about beside the rejection, not part of it (got ${collectionsOutcome.advisoryText})`);

      // Structural and shape checks still fail fast, so nothing downstream
      // runs on data an earlier check rejected: a bullets array of the wrong
      // shape is reported alone, not batched behind a grounding walk it would
      // have crashed inside.
      const structural = draft();
      structural.roles[1].bullets = 'not an array';
      structural.skills = [{ id: 's1', group: 'Bespoke Wizardry', items: ['Haskell'], evidenceIds: ['e1'] }];
      const structuralMessage = rejection(structural);
      assert(/roles\[1\]\.bullets must contain between/u.test(structuralMessage) && !structuralMessage.includes('Bespoke Wizardry'),
        `a shape defect the later walks depend on still throws on its own (got ${structuralMessage})`);

      // Bounded: the worst draft the ceilings allow — every role at its bullet
      // ceiling, every project and skill group full and ungrounded — must not
      // produce an unbounded correction prompt.
      const pathological = draft();
      pathological.roles.forEach((role, roleIndex) => {
        role.bullets = Array.from({ length: STRUCTURED_RESUME_LIMITS.bulletsPerRole }, (unused, index) => ({
          id: `b${roleIndex}-${index}`, text: 'x'.repeat(400), evidenceIds: [`ghost-${roleIndex}-${index}`],
        }));
      });
      pathological.projects = Array.from({ length: STRUCTURED_RESUME_LIMITS.projects }, (unused, index) => ({
        id: `p${index}`, name: 'N'.repeat(300), description: 'D'.repeat(1_200), metrics: 'M'.repeat(500), evidenceIds: ['e1'],
      }));
      pathological.skills = Array.from({ length: STRUCTURED_RESUME_LIMITS.skillGroups }, (unused, index) => ({
        id: `s${index}`, group: `Invented Specialty ${index}`.repeat(8), items: Array.from({ length: STRUCTURED_RESUME_LIMITS.skillItemsPerGroup }, (value, item) => `item-${index}-${item}`), evidenceIds: ['e1'],
      }));
      const pathologicalMessage = rejection(pathological);
      assert(pathologicalMessage.length < 20_000 && /and \d+ more/u.test(pathologicalMessage),
        `a response at every ceiling still yields a bounded message (${pathologicalMessage.length} chars)`);

      // An offender embeds text the response supplied, so the sibling list
      // clips each entry: the locating label is written first and survives,
      // and a skill item at its own ceiling cannot pad the message by itself.
      const longItem = index => `${index}-${'Lexicographic'.repeat(STRUCTURED_RESUME_LIMITS.chars.skillText)}`.slice(0, STRUCTURED_RESUME_LIMITS.chars.skillText);
      const longOffenders = draft();
      longOffenders.skills = [{ id: 's1', group: 'Tools', items: [longItem(1), longItem(2), longItem(3)], evidenceIds: ['e1'] }];
      const longOffendersMessage = rejection(longOffenders);
      assert(longOffendersMessage.includes(longItem(1)) && !longOffendersMessage.includes(longItem(2))
        && longOffendersMessage.includes('skills[0] item "2-Lexicographic') && longOffendersMessage.includes('…')
        && longOffendersMessage.length < 1_500,
      `a sibling offender is clipped to its locating label while the first offender keeps its full wording (${longOffendersMessage.length} chars)`);
      return { rolesBatched: 3, collectionsBatched: 4, pathologicalChars: pathologicalMessage.length, clippedChars: longOffendersMessage.length };
    },
  },
  {
    name: 'Batched structured résumé reporting survives malformed drafts without crashing out of its own error class',
    run() {
      // Batching means code now runs AFTER a defect is collected instead of
      // throwing at it, so every later read happens on data an earlier check
      // already rejected. A crash there would leave the responder with a stack
      // trace instead of a repair. Every malformed draft below must come back
      // as this module's own validation failure (or the host-misconfiguration
      // failure), never as a TypeError, a RangeError, or a hang.
      const careerData = [
        'Ada Lovelace', 'ada@example.test', '',
        '## Analytical Engines', '', 'Senior Engineer', '*2021 – 2024*',
        '- Built the reporting pipeline for nightly batches.',
        '- Shipped JavaScript and Docker tooling for the pipeline.', '', '---', '',
        '## Difference Machines', '', 'Software Engineer', '*2018 – 2021*',
        '- Shipped the billing service with automated alerts.', '', '---', '',
        '## Third Works', '', 'Engineer', '*2016 – 2018*',
        '- Ran the ledger migration for the finance team.', '', '---', '',
      ].join('\n');
      const sourceRoles = [
        { id: 'r1', title: 'Senior Engineer', company: 'Analytical Engines', dates: '2021 – 2024', location: '' },
        { id: 'r2', title: 'Software Engineer', company: 'Difference Machines', dates: '2018 – 2021', location: '' },
        { id: 'r3', title: 'Engineer', company: 'Third Works', dates: '2016 – 2018', location: '' },
      ];
      const evidenceCatalog = [
        { id: 'e1', sourceId: 'career-data', quote: 'Built the reporting pipeline for nightly batches.' },
        { id: 'e2', sourceId: 'career-data', quote: 'Shipped the billing service with automated alerts.' },
        { id: 'e3', sourceId: 'career-data', quote: 'Ran the ledger migration for the finance team.' },
        { id: 'e4', sourceId: 'career-data', quote: 'Shipped JavaScript and Docker tooling for the pipeline.' },
        { id: 'job', sourceId: 'job-listing', quote: 'reporting work' },
      ];
      const baseContext = { sourceRoles, evidenceCatalog, careerData };
      const good = () => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [
          { id: 'r1', title: 'Senior Engineer', company: 'Analytical Engines', dates: '2021 – 2024', location: '', bullets: [{ id: 'b1', text: 'Built the reporting pipeline for nightly batches.', evidenceIds: ['e1'] }] },
          { id: 'r2', title: 'Software Engineer', company: 'Difference Machines', dates: '2018 – 2021', location: '', bullets: [{ id: 'b2', text: 'Shipped the billing service with automated alerts.', evidenceIds: ['e2'] }] },
          { id: 'r3', title: 'Engineer', company: 'Third Works', dates: '2016 – 2018', location: '', bullets: [{ id: 'b3', text: 'Ran the ledger migration for the finance team.', evidenceIds: ['e3'] }] },
        ],
      });
      const mutate = (change) => { const draft = good(); change(draft); return draft; };
      const NO_CONTEXT = Symbol('no-context');
      const cases = [];
      const add = (name, draft, context = baseContext) => cases.push({ name, draft, context: context === NO_CONTEXT ? undefined : context });

      for (const [index, value] of [null, undefined, 'a draft', 42, [], true].entries()) add(`draft-is-${index}`, value);
      add('schema-missing', mutate(d => { delete d.schemaVersion; }));
      add('schema-wrong', mutate(d => { d.schemaVersion = 'v2'; }));
      add('schema-object', mutate(d => { d.schemaVersion = {}; }));
      add('roles-missing', mutate(d => { delete d.roles; }));
      add('roles-string', mutate(d => { d.roles = 'roles'; }));
      add('roles-short', mutate(d => { d.roles.pop(); }));
      add('roles-long', mutate(d => { d.roles.push(d.roles[0]); }));
      add('roles-null-entry', mutate(d => { d.roles[1] = null; }));
      add('roles-array-entry', mutate(d => { d.roles[1] = ['r2']; }));
      add('role-id-missing', mutate(d => { delete d.roles[2].id; }));
      add('role-id-number', mutate(d => { d.roles[2].id = 7; }));
      add('role-id-unknown', mutate(d => { d.roles[2].id = 'nope'; }));
      add('role-id-duplicate', mutate(d => { d.roles[2].id = 'r1'; }));
      add('role-title-drift', mutate(d => { d.roles[0].title = 'Principal Engineer'; }));
      add('role-summary-present', mutate(d => { d.roles[0].summary = 'A summary.'; }));
      add('role-location-invented', mutate(d => { d.roles[0].location = 'Atlantis'; }));
      add('bullets-missing', mutate(d => { delete d.roles[1].bullets; }));
      add('bullets-empty', mutate(d => { d.roles[1].bullets = []; }));
      add('bullets-string', mutate(d => { d.roles[1].bullets = 'b'; }));
      add('bullets-null-entry', mutate(d => { d.roles[1].bullets[0] = null; }));
      add('bullet-text-missing', mutate(d => { delete d.roles[1].bullets[0].text; }));
      add('bullet-text-object', mutate(d => { d.roles[1].bullets[0].text = { a: 1 }; }));
      add('bullet-id-duplicate', mutate(d => { d.roles[0].bullets.push({ ...d.roles[0].bullets[0] }); }));
      add('evidence-missing', mutate(d => { delete d.roles[0].bullets[0].evidenceIds; }));
      add('evidence-empty', mutate(d => { d.roles[0].bullets[0].evidenceIds = []; }));
      add('evidence-string', mutate(d => { d.roles[0].bullets[0].evidenceIds = 'e1'; }));
      add('evidence-null-entry', mutate(d => { d.roles[0].bullets[0].evidenceIds = [null]; }));
      add('evidence-object-entry', mutate(d => { d.roles[0].bullets[0].evidenceIds = [{ id: 'e1' }]; }));
      add('evidence-duplicate', mutate(d => { d.roles[0].bullets[0].evidenceIds = ['e1', 'e1']; }));
      add('evidence-unknown-every-role', mutate(d => { d.roles.forEach((role, index) => { role.bullets[0].evidenceIds = [`ghost-${index}`]; }); }));
      add('evidence-listing-only-every-role', mutate(d => { d.roles.forEach((role) => { role.bullets[0].evidenceIds = ['job']; }); }));
      add('evidence-out-of-section-every-role', mutate(d => { d.roles.forEach((role) => { role.bullets[0].evidenceIds = ['e1']; }); }));
      add('projects-string', mutate(d => { d.projects = 'p'; }));
      add('projects-null-entry', mutate(d => { d.projects = [null]; }));
      add('project-name-missing', mutate(d => { d.projects = [{ id: 'p1', evidenceIds: ['e1'] }]; }));
      add('project-name-number', mutate(d => { d.projects = [{ id: 'p1', name: 5, evidenceIds: ['e1'] }]; }));
      add('project-evidence-unknown', mutate(d => { d.projects = [{ id: 'p1', name: 'Alpha', evidenceIds: ['ghost'] }]; }));
      add('project-evidence-empty', mutate(d => { d.projects = [{ id: 'p1', name: 'Alpha', evidenceIds: [] }]; }));
      add('project-duplicate-id', mutate(d => { d.projects = [{ id: 'p1', name: 'x', evidenceIds: ['e1'] }, { id: 'p1', name: 'y', evidenceIds: ['e1'] }]; }));
      add('project-ungrounded-many', mutate(d => { d.projects = Array.from({ length: 5 }, (unused, index) => ({ id: `p${index}`, name: `Invented ${index}`, description: `Invented description ${index}`, metrics: `${index} invented`, evidenceIds: ['e1'] })); }));
      add('skills-string', mutate(d => { d.skills = 's'; }));
      add('skills-null-entry', mutate(d => { d.skills = [null]; }));
      add('skill-items-missing', mutate(d => { d.skills = [{ id: 's1', group: 'Tools', evidenceIds: ['e1'] }]; }));
      add('skill-items-empty', mutate(d => { d.skills = [{ id: 's1', group: 'Tools', items: [], evidenceIds: ['e1'] }]; }));
      add('skill-item-object', mutate(d => { d.skills = [{ id: 's1', group: 'Tools', items: [{}], evidenceIds: ['e1'] }]; }));
      add('skill-item-duplicate', mutate(d => { d.skills = [{ id: 's1', group: 'Tools', items: ['Docker', 'Docker'], evidenceIds: ['e4'] }]; }));
      add('skill-evidence-unknown', mutate(d => { d.skills = [{ id: 's1', group: 'Tools', items: ['Docker'], evidenceIds: ['ghost'] }]; }));
      add('skill-group-missing', mutate(d => { d.skills = [{ id: 's1', items: ['Docker'], evidenceIds: ['e4'] }]; }));
      add('identity-missing', mutate(d => { delete d.identity; }));
      add('identity-array', mutate(d => { d.identity = []; }));
      add('identity-contact-missing', mutate(d => { delete d.identity.contact; }));
      add('identity-contact-empty', mutate(d => { d.identity.contact = []; }));
      add('identity-contact-object', mutate(d => { d.identity.contact = [{}]; }));
      add('identity-contact-duplicate', mutate(d => { d.identity.contact = ['a@b.test', 'a@b.test']; }));
      add('context-missing', good(), NO_CONTEXT);
      add('context-empty', good(), {});
      add('sourceRoles-missing', good(), { evidenceCatalog, careerData });
      add('sourceRoles-empty', good(), { sourceRoles: [], evidenceCatalog, careerData });
      add('sourceRoles-null-entry', good(), { sourceRoles: [null, ...sourceRoles], evidenceCatalog, careerData });
      add('evidenceCatalog-missing', good(), { sourceRoles, careerData });
      add('evidenceCatalog-null-entry', good(), { sourceRoles, evidenceCatalog: [null], careerData });
      add('careerData-object', good(), { sourceRoles, evidenceCatalog, careerData: {} });
      add('json-proto-key', JSON.parse('{"schemaVersion":"structured-resume.v1","__proto__":{"polluted":true},"roles":[],"identity":{}}'));
      add('pathological-volume', mutate((d) => {
        d.roles.forEach((role, roleIndex) => {
          role.bullets = Array.from({ length: STRUCTURED_RESUME_LIMITS.bulletsPerRole }, (unused, index) => ({ id: `b${roleIndex}-${index}`, text: 'x'.repeat(400), evidenceIds: [`ghost-${roleIndex}-${index}`] }));
        });
        d.projects = Array.from({ length: STRUCTURED_RESUME_LIMITS.projects }, (unused, index) => ({ id: `p${index}`, name: 'N'.repeat(300), description: 'D'.repeat(1_200), metrics: 'M'.repeat(500), evidenceIds: ['e1'] }));
        d.skills = Array.from({ length: STRUCTURED_RESUME_LIMITS.skillGroups }, (unused, index) => ({ id: `s${index}`, group: `G${index}`.repeat(30), items: Array.from({ length: STRUCTURED_RESUME_LIMITS.skillItemsPerGroup }, (value, item) => `item-${index}-${item}`), evidenceIds: ['e1'] }));
      }));
      add('junk-evidence-array', mutate(d => { d.roles[0].bullets[0].evidenceIds = [null, 0, true, '', [], {}, NaN, Infinity]; }));

      const expected = new Set(['StructuredResumeValidationError', 'StructuredResumeConfigurationError']);
      const crashes = [];
      let longest = 0;
      for (const item of cases) {
        try { renderStructuredApplicationResume(item.draft, item.context); } catch (error) {
          if (!expected.has(error?.name)) crashes.push(`${item.name}: ${error?.name} ${error?.message}`);
          longest = Math.max(longest, String(error?.message || '').length);
        }
      }
      assert(cases.length >= 40 && !crashes.length,
        `${cases.length} hand-built malformed drafts all come back as a stated validation failure (crashes=${JSON.stringify(crashes.slice(0, 3))})`);
      assert(longest < 20_000, `no malformed draft produces an unbounded message (longest=${longest})`);
      assert({}.polluted === undefined, 'a draft carrying a JSON __proto__ key does not pollute Object.prototype');

      // A property fuzz over the same validator: random deletions, type
      // swaps, duplications and appends against a valid draft. Deterministic
      // seeds keep a failure reproducible.
      let seed = 20260921;
      const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      const pick = (list) => { const value = list[Math.floor(random() * list.length)]; return value && typeof value === 'object' ? structuredClone(value) : value; };
      const VALUES = [null, undefined, 0, 1, -1, NaN, Infinity, '', '  ', 'x'.repeat(9_000), true, false, [], {}, [null], [{}], ['e1', 'e1'], { id: 'e1' }, 'e1', 'ghost', 'r1'];
      const walk = (value, prefix = [], out = [], depth = 0) => {
        if (value && typeof value === 'object' && depth < 8) {
          for (const key of Object.keys(value)) {
            out.push([...prefix, key]);
            walk(value[key], [...prefix, key], out, depth + 1);
          }
        }
        return out;
      };
      const parentOf = (root, path) => path.slice(0, -1).reduce((node, key) => (node == null ? node : node[key]), root);
      const fuzzCrashes = [];
      let fuzzAccepted = 0;
      const rounds = 2_000;
      for (let round = 0; round < rounds; round += 1) {
        const fuzzed = good();
        fuzzed.projects = [{ id: 'p1', name: 'reporting pipeline', description: 'Built the reporting pipeline for nightly batches.', evidenceIds: ['e1'] }];
        fuzzed.skills = [{ id: 's1', group: 'Tools', items: ['JavaScript', 'Docker'], evidenceIds: ['e4'] }];
        for (let edit = 0; edit < 1 + Math.floor(random() * 4); edit += 1) {
          const all = walk(fuzzed);
          if (!all.length) break;
          const path = all[Math.floor(random() * all.length)];
          const parent = parentOf(fuzzed, path);
          if (parent == null || typeof parent !== 'object') continue;
          const key = path[path.length - 1];
          const operation = Math.floor(random() * 4);
          if (operation === 0) delete parent[key];
          else if (operation === 2 && Array.isArray(parent[key])) parent[key] = [...parent[key], ...parent[key]];
          else if (operation === 3 && Array.isArray(parent)) parent.push(pick(VALUES));
          else parent[key] = pick(VALUES);
        }
        try { renderStructuredApplicationResume(fuzzed, baseContext); fuzzAccepted += 1; } catch (error) {
          if (!expected.has(error?.name)) fuzzCrashes.push(`${error?.name}: ${String(error?.message).slice(0, 120)}`);
          longest = Math.max(longest, String(error?.message || '').length);
        }
      }
      assert(!fuzzCrashes.length && fuzzAccepted > 0 && fuzzAccepted < rounds,
        `${rounds} fuzzed drafts stay inside the stated error class, and the fuzz is neither all-accepting nor all-rejecting (accepted=${fuzzAccepted}, crashes=${JSON.stringify(fuzzCrashes.slice(0, 3))})`);
      return { malformed: cases.length, fuzzRounds: rounds, fuzzAccepted, longestMessage: longest };
    },
  },
  {
    name: 'Project provenance helper matches nested and plain source-section boundaries',
    run() {
      const nested = '# Personal Projects\n## Dashboards\n- Atlas dashboard\n# Skills\nJavaScript';
      const plain = 'Personal Projects\n- Atlas dashboard\nSkills\n- Beta tool';
      assert(careerDataProjectProvenanceHeadingForName(nested, 'Atlas dashboard') === 'Personal Projects'
        && careerDataProjectProvenanceHeadingForName(plain, 'Beta tool') === '',
      'the shared provenance parser retains nested project entries and stops at a subsequent plain source section');
      return { nestedHeading: true, plainBoundary: true };
    },
  },
  {
    name: 'Paste application assembly produces a clean first-import result for the legacy validator',
    run() {
      const cleanCareerData = 'Ada Lovelace\nada@example.test\n## Acme\nEngineer\n\nBuilt supported systems.\nI built supported systems for the teams that depend on them. The engineering was in matching the constraints those teams set rather than my own preferences. I would apply that delivery work to the reliable supported systems this role needs.';
      const sourceRoles = [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '' }];
      const paragraphs = ['I built supported systems for the teams that depend on them. The engineering was in matching the constraints those teams set rather than my own preferences. I would apply that delivery work to the reliable supported systems this role needs.'];
      const audit = {
        version: LOCAL_AI_GENERATION_AUDIT_VERSION,
        jobPriorities: [{ requirement: 'Reliable supported systems', priority: 'highest', disposition: 'addressed-both', justification: 'The selected supported-systems evidence directly addresses the stated delivery requirement.' }],
        resumePlan: { strategy: 'Lead with the strongest supported systems evidence for the role.', selectionRationale: 'The retained role preserves direct factual support and concise relevance.' },
        coverLetterPlan: { controllingThesis: 'Reliable system delivery is the supported capability this engineering role needs.', paragraphs: [{ paragraph: paragraphs[0], argumentativeJob: 'Establish the controlling evidence-to-need connection.', relationToThesis: 'Connect the source-supported proof to reliable system delivery.', relationToPreviousParagraph: 'opening', sentences: [{ sentence: 'I built supported systems for the teams that depend on them.', function: 'Establishes this paragraph’s argumentative direction.', relationToPreviousSentence: 'opening' }, { sentence: 'The engineering was in matching the constraints those teams set rather than my own preferences.', function: 'Abstracts the completed work into the problem shape it required.', relationToPreviousSentence: 'Generalizes the preceding proof without adding a new fact.' }, { sentence: 'I would apply that delivery work to the reliable supported systems this role needs.', function: 'States the transfer to the responsibility this posting names.', relationToPreviousSentence: 'Applies the abstracted capability to the target responsibility.' }], argumentMapping: { claim: 'The engineering was in matching the constraints those teams set rather than my own preferences.', proof: 'I built supported systems for the teams that depend on them.', relevance: 'I would apply that delivery work to the reliable supported systems this role needs.', jobNeedQuote: 'reliable supported systems' } }] },
        finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
      };
      const criteria = APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement }));
      const result = assemblePasteApplicationResult({
        input: { version: 1, jobId: '123e4567-e89b-42d3-a456-426614174000', sourceRoles, qualityChecklist: { version: APPLICATION_QUALITY_CHECKLIST_VERSION }, generationAudit: { version: LOCAL_AI_GENERATION_AUDIT_VERSION, required: true }, job: { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable supported systems.' } },
        careerData: cleanCareerData,
        jobListing: 'Engineer role focused on reliable supported systems.',
        paste: {
          trustedIdentity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer', credential: '' },
          evidencePlan: { evidence: [{ id: 'resume-proof', sourceId: 'career-data', quote: 'Built supported systems.' }, { id: 'letter-proof', sourceId: 'career-data', quote: 'I built supported systems for the teams that depend on them. The engineering was in matching the constraints those teams set rather than my own preferences. I would apply that delivery work to the reliable supported systems this role needs.' }] },
          resume: { schemaVersion: 'structured-resume.v1', identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer', credential: '' }, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Built supported systems.', evidenceIds: ['resume-proof'] }] }] },
          coverLetter: { name: 'Ada Lovelace', contact: ['ada@example.test'], paragraphs: [{ id: 'paragraph-1', text: paragraphs[0], evidenceIds: ['letter-proof'] }], roleThesis: audit.coverLetterPlan.controllingThesis, coverLetterArgument: { primaryEvidence: { evidence: 'Built supported systems.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } }, generationAudit: audit },
          finalReview: { decision: 'pass', findings: [], checklist: APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents.` })), qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria, resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' }, coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' } }, generationAudit: audit },
        },
      });
      const validated = validateLocalApplicationResult(result, result.jobId, '/tmp', { title: 'Engineer', company: 'Acme', snippet: 'Engineer role focused on reliable supported systems.' }, { careerData: cleanCareerData, evidencePlan: null, qualityChecklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, generationAuditVersion: LOCAL_AI_GENERATION_AUDIT_VERSION });
      assert(validated.resumeMainHtml.includes('Built supported systems.') && validated.qualityReview.resume.decision === 'drafted',
        'the structured paste result passes the existing validator as the initial measured-import snapshot');
      return { validated: true };
    },
  },
  {
    name: 'Paste application fit retry stamps changed decisions and rejects an unchanged failing document',
    run() {
      const hash = value => crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
      const result = {
        resumeMainHtml: 'resume version one',
        coverLetter: { paragraphs: ['letter version one'] },
        qualityReview: { resume: { decision: 'drafted' }, coverLetter: { decision: 'drafted' } },
      };
      const feedback = {
        status: 'revision-required',
        documentSha256: { resume: hash(result.resumeMainHtml), coverLetter: hash(JSON.stringify(result.coverLetter)) },
        resume: { pageCount: 2, targetPageCount: 1, layout: {} },
        coverLetter: { pageCount: 1, targetPageCount: 1, layout: {} },
      };
      let unchangedRejected = false;
      try { stampPasteQualityReviewFromFit(structuredClone(result), feedback); } catch (error) { unchangedRejected = /materially regenerate the résumé/u.test(String(error?.message || error)); }
      const changed = structuredClone(result);
      changed.resumeMainHtml = 'resume version two';
      stampPasteQualityReviewFromFit(changed, feedback);
      assert(unchangedRejected && changed.qualityReview.resume.decision === 'changed_materially'
        && changed.qualityReview.coverLetter.decision === 'kept_diminishing_returns',
      'a measured retry receives host-stamped decisions and cannot pass with an unchanged overflowing résumé');
      // The rejection itself carries which documents it names, so the list
      // survives the unchanged-document path without anyone re-reading prose.
      let raisedDocuments = null;
      try { stampPasteQualityReviewFromFit(structuredClone(result), feedback); } catch (error) { raisedDocuments = pasteRejectionChangeDocuments(error); }
      assert(JSON.stringify(raisedDocuments?.documents) === JSON.stringify(['resume']) && !raisedDocuments.unattributed.length,
        `the unchanged-résumé rejection requires a résumé edit and attributes every defect it reports (${JSON.stringify(raisedDocuments)})`);
      // A record written by an older build carries that same sentence and
      // nothing else, and it still resolves to both documents.
      assert(JSON.stringify(pasteRejectionChangeDocuments(['Local AI must materially regenerate the résumé and cover letter because their prior app-measured layout criteria are still unsatisfied.']).documents) === JSON.stringify(['resume', 'coverLetter']),
        'one combined measured-fit failure requires review edits to both structured documents');
      // The case that used to answer "" for everything it did not recognise:
      // a defect no route attributes is reported as unattributed, never as a
      // rejection with nothing to change.
      const unknown = pasteRejectionChangeDocuments(['Local AI résumé failed editorial checks: resume-bullet-length: bullet 1 is 216 visible characters (budget 180).']);
      assert(!unknown.documents.length && unknown.unattributed.length === 1,
        `an unattributed rejection string is reported as unattributed rather than as no required change (${JSON.stringify(unknown)})`);
      // And it is not recorded as "nothing has to change" either: an
      // unattributed defect takes the default target, so the round it reopens
      // still owes the app something it can measure.
      assert(JSON.stringify(unknown.targets) === JSON.stringify(['response']),
        `an unattributed rejection still requires a change the app can measure (${JSON.stringify(unknown.targets)})`);
      return { unchangedRejected, resumeDecision: changed.qualityReview.resume.decision };
    },
  },
  {
    // sanitizeQualityReview raises two kinds of defect. Its own fields are
    // repaired by correcting the review; its source-grounding arm grades the
    // final bullets, paragraphs and the letter's argument contract, and those
    // repair only by changing a document. Attributing by WHICH VALIDATOR
    // raised the defect answered "no document has to change" for both, which
    // is what let a package the host rejected come back forever.
    name: 'One validator, two repairs: a quality-review defect and an argument-binding defect are attributed apart',
    run() {
      const careerData = 'Ada Lovelace\nEngineer\nBuilt reporting systems that reduced manual work.';
      const resumeEvidence = { roles: [{ title: 'Engineer', company: 'Acme', bullets: [{ text: 'Built reporting systems that reduced manual work.' }] }] };
      const coverLetter = { paragraphs: ['Built reporting systems that reduced manual work.'] };
      const grounding = {
        resumeBullets: [{ bullet: 'Built reporting systems that reduced manual work.', careerDataQuotes: ['Built reporting systems that reduced manual work.'] }],
        coverLetterParagraphs: [{ paragraph: 'Built reporting systems that reduced manual work.', careerDataQuotes: ['Built reporting systems that reduced manual work.'] }],
      };
      const review = (overrides = {}) => ({
        checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
        criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: `${requirement} measured on the rendered ${id} copy.` })),
        resume: { decision: 'drafted', rationale: 'The résumé keeps the strongest source-supported reporting evidence.' },
        coverLetter: { decision: 'drafted', rationale: 'One controlling argument uses minimum-sufficient evidence for reporting-system delivery.' },
        sourceGrounding: grounding,
        ...overrides,
      });
      // A paste job: the host projects these quotes out of the frozen evidence
      // plan. The split that flag controls is about the quote TEXT; every
      // defect below is about which evidence a document bound, which the next
      // response still chooses, so all three keep a document repair target.
      const context = argument => ({
        required: true, careerData, resumeEvidence, coverLetter, frozenSourceQuotes: true,
        coverLetterArgument: { primaryEvidence: argument },
      });
      const grounded = { evidence: 'Built reporting systems that reduced manual work.', evidenceRole: 'Engineer at Acme' };

      let ownField = null;
      try {
        sanitizeQualityReview(review({ coverLetter: { decision: 'drafted', rationale: 'Fine.' } }), context(grounded), APPLICATION_QUALITY_CHECKLIST_VERSION);
      } catch (error) { ownField = pasteRejectionChangeDocuments(error); }
      assert(ownField && !ownField.documents.length && JSON.stringify(ownField.targets) === JSON.stringify(['qualityReview']) && !ownField.unattributed.length,
        `a defect in the review's own field is repaired by correcting that field (${JSON.stringify(ownField)})`);

      let argumentBinding = null;
      try {
        sanitizeQualityReview(review(), context({ evidence: 'Ran a distributed message queue across three regions.', evidenceRole: 'Engineer at Acme' }), APPLICATION_QUALITY_CHECKLIST_VERSION);
      } catch (error) { argumentBinding = pasteRejectionChangeDocuments(error); }
      assert(argumentBinding && JSON.stringify(argumentBinding.documents) === JSON.stringify(['coverLetter'])
        && JSON.stringify(argumentBinding.targets) === JSON.stringify(['coverLetter:authored']) && !argumentBinding.unattributed.length,
      `an argument binding graded against the final résumé is repaired by changing the letter (${JSON.stringify(argumentBinding)})`);

      let bulletBinding = null;
      try {
        sanitizeQualityReview(review({ sourceGrounding: { ...grounding, resumeBullets: [{ bullet: 'Built reporting systems that reduced manual work.', careerDataQuotes: ['Ada Lovelace'] }] } }), context(grounded), APPLICATION_QUALITY_CHECKLIST_VERSION);
      } catch (error) { bulletBinding = pasteRejectionChangeDocuments(error); }
      assert(bulletBinding && JSON.stringify(bulletBinding.targets) === JSON.stringify(['resume:authored']),
        `a bullet binding graded against the career record is repaired by changing the résumé (${JSON.stringify(bulletBinding)})`);
      return { targets: [ownField.targets, argumentBinding.targets, bulletBinding.targets] };
    },
  },
  {
    name: 'Source grounding rejects an unsupported percentage result that shares the cited artifact words',
    run() {
      const source = 'Built reporting systems that reduced manual work by 25%.';
      const supportedBullet = 'Built reporting systems that reduced manual work by 25%.';
      const inventedFigureBullet = 'Built reporting systems that reduced manual work by 40%.';
      const review = (bullet, quote = source) => ({
        checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
        criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: `${requirement} measured on the rendered ${id} copy.` })),
        resume: { decision: 'drafted', rationale: 'The résumé keeps source-supported reporting evidence and its stated result.' },
        coverLetter: { decision: 'drafted', rationale: 'One controlling argument uses minimum-sufficient evidence for reporting-system delivery.' },
        sourceGrounding: {
          resumeBullets: [{ bullet, careerDataQuotes: [quote] }],
          coverLetterParagraphs: [{ paragraph: source, careerDataQuotes: [source] }],
        },
      });
      const context = (bullet, corpus = source) => ({
        required: true,
        careerData: corpus,
        frozenSourceQuotes: false,
        resumeEvidence: { roles: [{ title: 'Engineer', company: 'Acme', bullets: [{ text: bullet }] }] },
        coverLetter: { paragraphs: [source] },
        coverLetterArgument: { primaryEvidence: { evidence: bullet, evidenceRole: 'Engineer at Acme' } },
      });
      sanitizeQualityReview(review(supportedBullet), context(supportedBullet), APPLICATION_QUALITY_CHECKLIST_VERSION);
      let rejected = null;
      try {
        sanitizeQualityReview(review(inventedFigureBullet), context(inventedFigureBullet), APPLICATION_QUALITY_CHECKLIST_VERSION);
      } catch (error) { rejected = error; }
      const repair = pasteRejectionChangeDocuments(rejected);
      assert(rejected?.message.includes('unsupported figure')
        && JSON.stringify(repair.targets) === JSON.stringify(['resume:authored']),
      `an unsupported numerical result is rejected as a résumé repair while a sourced result passes (${rejected?.message || 'accepted'})`);
      return { rejected: true, repair: repair.targets };
    },
  },
  {
    name: 'Figure grounding preserves decimal precision and ignores listing-only paragraph figures',
    run() {
      const decimalSource = 'Built reporting systems that generated $1.2M and operated at 2.5x efficiency.';
      const candidateSource = 'I built reporting systems that reduced manual work by 25%.';
      const review = ({ bullet, paragraph, quote, quotes = [quote] }) => ({
        checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
        criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: `${requirement} measured on the rendered ${id} copy.` })),
        resume: { decision: 'drafted', rationale: 'The résumé retains source-supported reporting evidence and quantified results.' },
        coverLetter: { decision: 'drafted', rationale: 'One controlling argument uses minimum-sufficient evidence for reporting-system delivery.' },
        sourceGrounding: {
          resumeBullets: [{ bullet, careerDataQuotes: quotes }],
          coverLetterParagraphs: [{ paragraph, careerDataQuotes: quotes }],
        },
      });
      const context = ({ bullet, paragraph, corpus }) => ({
        required: true,
        careerData: corpus,
        frozenSourceQuotes: false,
        resumeEvidence: { roles: [{ title: 'Engineer', company: 'Acme', bullets: [{ text: bullet }] }] },
        coverLetter: { paragraphs: [paragraph] },
        coverLetterArgument: { primaryEvidence: { evidence: bullet, evidenceRole: 'Engineer at Acme' } },
      });

      const decimalMutation = 'Built reporting systems that generated $12M and operated at 25x efficiency.';
      let decimalError = null;
      try {
        sanitizeQualityReview(
          review({ bullet: decimalMutation, paragraph: decimalSource, quote: decimalSource }),
          context({ bullet: decimalMutation, paragraph: decimalSource, corpus: decimalSource, quote: decimalSource }),
          APPLICATION_QUALITY_CHECKLIST_VERSION,
        );
      } catch (error) { decimalError = error; }
      assert(decimalError?.message.includes('unsupported figures')
        && decimalError.message.includes('$12M') && decimalError.message.includes('25x'),
      `decimal values must not collapse into integer values (${decimalError?.message || 'accepted'})`);

      const formattedSource = 'Built reporting systems that generated $1,200.00, improved conversion by 25.0%, and operated at 2.50x efficiency.';
      const formattedEquivalent = 'Built reporting systems that generated $1200, improved conversion by 25%, and operated at 2.5x efficiency.';
      sanitizeQualityReview(
        review({ bullet: formattedEquivalent, paragraph: formattedEquivalent, quote: formattedSource }),
        context({ bullet: formattedEquivalent, paragraph: formattedEquivalent, corpus: formattedSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const magnitudeEquivalent = 'Built reporting systems that generated $1,200,000 and operated at 2.5x efficiency.';
      sanitizeQualityReview(
        review({ bullet: magnitudeEquivalent, paragraph: magnitudeEquivalent, quote: decimalSource }),
        context({ bullet: magnitudeEquivalent, paragraph: magnitudeEquivalent, corpus: decimalSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );

      // A spaced x is an ambiguous technical dimension, not a compact 3x
      // performance multiplier. The source-grounding rule intentionally
      // leaves it to ordinary semantic review rather than making up a figure
      // claim it cannot prove mechanically.
      const dimensionSource = 'I built a 4 x 4 reporting matrix for internal teams.';
      const changedDimension = 'I built a 3 x 3 reporting matrix for internal teams.';
      sanitizeQualityReview(
        review({ bullet: changedDimension, paragraph: changedDimension, quote: dimensionSource }),
        context({ bullet: changedDimension, paragraph: changedDimension, corpus: dimensionSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      // The written dimension form is equally ambiguous. It must stand down
      // when it denotes matrix dimensions, while an actual speed multiplier
      // remains a source-grounded quantitative claim.
      const writtenDimensionSource = 'I built a 4 times 4 reporting matrix for internal teams.';
      const changedWrittenDimension = 'I built a 3 times 3 reporting matrix for internal teams.';
      sanitizeQualityReview(
        review({ bullet: changedWrittenDimension, paragraph: changedWrittenDimension, quote: writtenDimensionSource }),
        context({ bullet: changedWrittenDimension, paragraph: changedWrittenDimension, corpus: writtenDimensionSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );

      const rejectFigure = ({ source, final, quotes = [source] }) => {
        try {
          sanitizeQualityReview(
            review({ bullet: final, paragraph: final, quote: source, quotes }),
            context({ bullet: final, paragraph: final, corpus: source }),
            APPLICATION_QUALITY_CHECKLIST_VERSION,
          );
          return null;
        } catch (error) { return error; }
      };
      const splitFigureSource = 'Built reporting systems that improved 25% conversion in weekly reports.';
      const splitFigureError = rejectFigure({
        source: splitFigureSource,
        final: splitFigureSource,
        quotes: ['Built reporting systems that improved 25', '% conversion in weekly reports.'],
      });
      const signedFigureError = rejectFigure({
        source: 'I built reporting systems that reduced manual work by -25%.',
        final: 'I built reporting systems that reduced manual work by 25%.',
      });
      const leadingDecimalError = rejectFigure({
        source: 'I built reporting systems that reduced manual work by .5%.',
        final: 'I built reporting systems that reduced manual work by 5%.',
      });
      const denominationError = rejectFigure({
        source: 'I built reporting systems that generated $1M in revenue.',
        final: 'I built reporting systems that generated €1M in revenue.',
      });
      const dollarError = rejectFigure({
        source: 'I built reporting systems that generated 1 dollar in revenue.',
        final: 'I built reporting systems that generated 2 dollars in revenue.',
      });
      const millionDollarError = rejectFigure({
        source: 'I built reporting systems that generated 1.2 million dollars in revenue.',
        final: 'I built reporting systems that generated 2.2 million dollars in revenue.',
      });
      const indianRupeeError = rejectFigure({
        source: 'I built reporting systems that generated 1 Indian rupee in revenue.',
        final: 'I built reporting systems that generated 2 Indian rupees in revenue.',
      });
      const qualifiedDollarError = rejectFigure({
        source: 'I built reporting systems that generated 1 Canadian dollar in revenue.',
        final: 'I built reporting systems that generated USD 1 in revenue.',
      });
      const qualifiedSymbolDollarError = rejectFigure({
        source: 'I built reporting systems that generated US$1M in revenue.',
        final: 'I built reporting systems that generated US$2M in revenue.',
      });
      const prefixWordCurrencyError = rejectFigure({
        source: 'I built reporting systems that generated Canadian dollars 1M in revenue.',
        final: 'I built reporting systems that generated Canadian dollars 2M in revenue.',
      });
      const brlCurrencyError = rejectFigure({
        source: 'I built reporting systems that generated BRL 1M in revenue.',
        final: 'I built reporting systems that generated BRL 2M in revenue.',
      });
      const writtenMultiplierError = rejectFigure({
        source: 'I built reporting systems that rendered reports 3 times faster.',
        final: 'I built reporting systems that rendered reports 2 times faster.',
      });
      assert(splitFigureError?.message.includes('25%')
        && signedFigureError?.message.includes('25%')
        && leadingDecimalError?.message.includes('5%')
        && denominationError?.message.includes('€1M')
        && dollarError?.message.includes('(currency)')
        && millionDollarError?.message.includes('(currency)')
        && indianRupeeError?.message.includes('(currency)')
        && qualifiedDollarError?.message.includes('(currency)')
        && qualifiedSymbolDollarError?.message.includes('(currency)')
        && prefixWordCurrencyError?.message.includes('(currency)')
        && brlCurrencyError?.message.includes('(currency)')
        && writtenMultiplierError?.message.includes('2 times'),
      `quote boundaries, signs, leading decimals, currency denominations, word currencies on either side of a number, and real written multipliers cannot manufacture figure support (${[splitFigureError, signedFigureError, leadingDecimalError, denominationError, dollarError, millionDollarError, indianRupeeError, prefixWordCurrencyError, writtenMultiplierError].map(error => error?.message || 'accepted').join(' | ')})`);

      const inrSource = 'I built reporting systems that generated ₹1M and improved conversion by 25 percentage points.';
      const inrEquivalent = 'I built reporting systems that generated INR 1,000,000 and improved conversion by 25pp.';
      sanitizeQualityReview(
        review({ bullet: inrEquivalent, paragraph: inrEquivalent, quote: inrSource }),
        context({ bullet: inrEquivalent, paragraph: inrEquivalent, corpus: inrSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const plusSource = 'I built reporting systems that improved conversion by 25%.';
      const plusEquivalent = 'I built reporting systems that improved conversion by +25%.';
      sanitizeQualityReview(
        review({ bullet: plusEquivalent, paragraph: plusEquivalent, quote: plusSource }),
        context({ bullet: plusEquivalent, paragraph: plusEquivalent, corpus: plusSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const qualifiedDollarSource = 'I built reporting systems that generated USD 1 in revenue.';
      const qualifiedDollarEquivalent = 'I built reporting systems that generated 1 US dollar in revenue.';
      sanitizeQualityReview(
        review({ bullet: qualifiedDollarEquivalent, paragraph: qualifiedDollarEquivalent, quote: qualifiedDollarSource }),
        context({ bullet: qualifiedDollarEquivalent, paragraph: qualifiedDollarEquivalent, corpus: qualifiedDollarSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const qualifiedSymbolDollarSource = 'I built reporting systems that generated US$1M in revenue.';
      const qualifiedSymbolDollarEquivalent = 'I built reporting systems that generated USD 1,000,000 in revenue.';
      sanitizeQualityReview(
        review({ bullet: qualifiedSymbolDollarEquivalent, paragraph: qualifiedSymbolDollarEquivalent, quote: qualifiedSymbolDollarSource }),
        context({ bullet: qualifiedSymbolDollarEquivalent, paragraph: qualifiedSymbolDollarEquivalent, corpus: qualifiedSymbolDollarSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const prefixWordCurrencySource = 'I built reporting systems that generated Canadian dollars 1M in revenue.';
      const prefixWordCurrencyEquivalent = 'I built reporting systems that generated CAD 1,000,000 in revenue.';
      sanitizeQualityReview(
        review({ bullet: prefixWordCurrencyEquivalent, paragraph: prefixWordCurrencyEquivalent, quote: prefixWordCurrencySource }),
        context({ bullet: prefixWordCurrencyEquivalent, paragraph: prefixWordCurrencyEquivalent, corpus: prefixWordCurrencySource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const brlCurrencySource = 'I built reporting systems that generated BRL 1M in revenue.';
      const brlCurrencyEquivalent = 'I built reporting systems that generated BRL 1,000,000 in revenue.';
      sanitizeQualityReview(
        review({ bullet: brlCurrencyEquivalent, paragraph: brlCurrencyEquivalent, quote: brlCurrencySource }),
        context({ bullet: brlCurrencyEquivalent, paragraph: brlCurrencyEquivalent, corpus: brlCurrencySource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const genericDollarSource = 'I built reporting systems that generated $1 in revenue.';
      const genericDollarEquivalent = 'I built reporting systems that generated 1 dollar in revenue.';
      sanitizeQualityReview(
        review({ bullet: genericDollarEquivalent, paragraph: genericDollarEquivalent, quote: genericDollarSource }),
        context({ bullet: genericDollarEquivalent, paragraph: genericDollarEquivalent, corpus: genericDollarSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      sanitizeQualityReview(
        review({ bullet: genericDollarSource, paragraph: genericDollarSource, quote: genericDollarEquivalent }),
        context({ bullet: genericDollarSource, paragraph: genericDollarSource, corpus: genericDollarEquivalent }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const genericPoundSource = 'I built reporting systems that saved £1.';
      const genericPoundEquivalent = 'I built reporting systems that saved 1 pound.';
      sanitizeQualityReview(
        review({ bullet: genericPoundEquivalent, paragraph: genericPoundEquivalent, quote: genericPoundSource }),
        context({ bullet: genericPoundEquivalent, paragraph: genericPoundEquivalent, corpus: genericPoundSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      sanitizeQualityReview(
        review({ bullet: genericPoundSource, paragraph: genericPoundSource, quote: genericPoundEquivalent }),
        context({ bullet: genericPoundSource, paragraph: genericPoundSource, corpus: genericPoundEquivalent }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const yenSymbolError = rejectFigure({
        source: 'I built reporting systems that generated ¥1 in revenue.',
        final: 'I built reporting systems that generated 1 yen in revenue.',
      });
      assert(yenSymbolError?.message.includes('(currency)'),
        `the ambiguous yen/yuan symbol stays distinct from national word denominations (${yenSymbolError?.message || 'accepted'})`);
      // Calendar years and version-like labels are intentionally not FIGURES:
      // a changed version label is left to the ordinary term/semantic review
      // rather than a multiplier parser. A year is a different claim with a
      // rule of its own: the same year is admissible, and a shifted year is
      // rejected as one the cited quote never states.
      const versionSource = 'I built v2x reporting tools during 2024.';
      const changedVersion = 'I built v3x reporting tools during 2024.';
      sanitizeQualityReview(
        review({ bullet: changedVersion, paragraph: changedVersion, quote: versionSource }),
        context({ bullet: changedVersion, paragraph: changedVersion, corpus: versionSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const shiftedYear = 'I built v3x reporting tools during 2025.';
      let shiftedYearError = null;
      try {
        sanitizeQualityReview(
          review({ bullet: shiftedYear, paragraph: shiftedYear, quote: versionSource }),
          context({ bullet: shiftedYear, paragraph: shiftedYear, corpus: versionSource }),
          APPLICATION_QUALITY_CHECKLIST_VERSION,
        );
      } catch (error) { shiftedYearError = error; }
      assert(/dates its work with .during 2025/u.test(shiftedYearError?.message || ''),
        `a year the cited quote never states is rejected by the year rule, not the figure rule (${shiftedYearError?.message || 'accepted'})`);

      const listingOnlyFigure = 'This role has a 40% target. I built reporting systems that reduced manual work by 25%.';
      sanitizeQualityReview(
        review({ bullet: candidateSource, paragraph: listingOnlyFigure, quote: candidateSource }),
        context({ bullet: candidateSource, paragraph: listingOnlyFigure, corpus: candidateSource, quote: candidateSource }),
        APPLICATION_QUALITY_CHECKLIST_VERSION,
      );
      const inventedCandidateFigure = 'This role has a 40% target. I built reporting systems that reduced manual work by 40%.';
      let candidateError = null;
      try {
        sanitizeQualityReview(
          review({ bullet: candidateSource, paragraph: inventedCandidateFigure, quote: candidateSource }),
          context({ bullet: candidateSource, paragraph: inventedCandidateFigure, corpus: candidateSource, quote: candidateSource }),
          APPLICATION_QUALITY_CHECKLIST_VERSION,
        );
      } catch (error) { candidateError = error; }
      const repair = pasteRejectionChangeDocuments(candidateError);
      assert(candidateError?.message.includes('sentence 2')
        && JSON.stringify(repair.targets) === JSON.stringify(['coverLetter:authored']),
      `candidate-work figures in a mixed paragraph remain grounded while listing-only figures stand down (${candidateError?.message || 'accepted'})`);

      // Cover-letter prose often omits its grammatical subject after a prior
      // sentence establishes the candidate. It is still candidate work when
      // its action and substantive terms come from the cited career evidence;
      // absence of a literal employer/title or first-person token must not
      // let it manufacture a result.
      const implicitCandidateFigure = 'Reduced manual work by 40% through reporting systems.';
      let implicitCandidateError = null;
      try {
        sanitizeQualityReview(
          review({ bullet: candidateSource, paragraph: implicitCandidateFigure, quote: candidateSource }),
          context({ bullet: candidateSource, paragraph: implicitCandidateFigure, corpus: candidateSource }),
          APPLICATION_QUALITY_CHECKLIST_VERSION,
        );
      } catch (error) { implicitCandidateError = error; }
      const implicitRepair = pasteRejectionChangeDocuments(implicitCandidateError);
      assert(implicitCandidateError?.message.includes('sentence 1')
        && implicitCandidateError.message.includes('40%')
        && JSON.stringify(implicitRepair.targets) === JSON.stringify(['coverLetter:authored']),
      `an implicit-subject candidate result remains source-grounded without a pronoun or identity token (${implicitCandidateError?.message || 'accepted'})`);
      return { decimalRejected: true, formattingEquivalent: true, boundaryAndSignGuards: true, wordCurrencyGuards: true, plusEquivalent: true, inrAndPointsEquivalent: true, versionStandsDown: true, dimensionStandsDown: true, listingOnlyAccepted: true, implicitCandidateRejected: true, repair: repair.targets };
    },
  },
  {
    // The source-grounding arm grades values the HOST projected: for a paste
    // job the careerDataQuotes in each binding come out of the frozen evidence
    // plan, and the document chose only which evidence IDs to cite. So the arm
    // cannot answer "the responder rewrites this quote" for everything it
    // raises. It splits by what citing a different ID can actually reach.
    name: 'A host-projected source quote splits by what citing different evidence can reach',
    run() {
      const bound = 'Built reporting systems that reduced manual work.';
      // The line break is the point of the third case: the corpus wraps this
      // passage and the plan quotes it on one line.
      const wrappedCorpus = 'Ada Lovelace\nEngineer\nBuilt reporting systems\nthat reduced manual work.';
      const resumeEvidence = { roles: [{ title: 'Engineer', company: 'Acme', bullets: [{ text: bound }] }] };
      const review = quotes => ({
        checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
        criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: `${requirement} measured on the rendered ${id} copy.` })),
        resume: { decision: 'drafted', rationale: 'The résumé keeps the strongest source-supported reporting evidence.' },
        coverLetter: { decision: 'drafted', rationale: 'One controlling argument uses minimum-sufficient evidence for reporting-system delivery.' },
        sourceGrounding: {
          resumeBullets: [{ bullet: bound, careerDataQuotes: quotes }],
          coverLetterParagraphs: [{ paragraph: bound, careerDataQuotes: [bound] }],
        },
      });
      const raise = (quotes, { frozenSourceQuotes, corpus = wrappedCorpus }) => {
        try {
          sanitizeQualityReview(review(quotes), {
            required: true, careerData: corpus, resumeEvidence,
            coverLetter: { paragraphs: [bound] },
            coverLetterArgument: { primaryEvidence: { evidence: bound, evidenceRole: 'Engineer at Acme' } },
            frozenSourceQuotes,
          }, APPLICATION_QUALITY_CHECKLIST_VERSION);
          return null;
        } catch (error) { return error; }
      };
      const attribution = (error) => {
        try { return { targets: pasteRejectionChangeDocuments(error).targets, rethrown: false }; }
        catch (rethrown) { return { targets: null, rethrown: rethrown === error }; }
      };

      // 1. A quote that is not in the corpus at all. Nothing the responder can
      //    send replaces it: the frozen plan's own quotes were already graded
      //    against this same corpus before this validator ran, so what
      //    disagrees is the package the host assembled.
      const absent = 'Ran a distributed message queue across three regions.';
      const projectedAbsent = raise([absent], { frozenSourceQuotes: true });
      assert(isJobIntegrityFault(projectedAbsent)
        && projectedAbsent.jobIntegrity.subject === FROZEN_COMPLETED_PACKAGE
        && attribution(projectedAbsent).rethrown,
      `a projected quote missing from the corpus ends the job and takes no repair target (${projectedAbsent?.message || 'accepted'})`);

      // 2. The same defect in a LEGACY filesystem job, whose responder wrote
      //    that quote into result.json itself. Same gate, repairable, because
      //    the next response genuinely does write it.
      const authoredAbsent = raise([absent], { frozenSourceQuotes: false });
      assert(!isJobIntegrityFault(authoredAbsent)
        && JSON.stringify(attribution(authoredAbsent).targets) === JSON.stringify(['resume:authored']),
      `the same quote defect stays a document repair when the responder wrote it (${JSON.stringify(attribution(authoredAbsent))})`);

      // 3. The one predicate. The corpus wraps this passage across two lines
      //    and the plan quotes it on one; assemblePasteApplicationResult and
      //    this validator used to answer that differently — absent for one,
      //    present for the other — which is two rule sets, not two
      //    strictnesses, because only one of them ends the job.
      assert(!raise([bound], { frozenSourceQuotes: true }),
        'a quote whose corpus form wraps is present for the validator, as it is for the assembly');
      const assembled = (() => {
        try {
          assemblePasteApplicationResult(fixture({}, { careerData: 'Ada Lovelace\nada@example.test\n## Analytical Engines\nSoftware Engineer\n\nBuilt reporting systems\nthat reduced manual work.' }));
          return null;
        } catch (error) { return error; }
      })();
      assert(!assembled, `the assembly reads the same wrapped corpus the same way (${assembled?.message || ''})`);

      // 4. A quote that IS in the corpus but binds nothing. The responder
      //    cannot lengthen it, but it can cite one of the plan's other
      //    passages, and the résumé and cover-letter stages grade exactly that
      //    change in one round — so this half stays repairable, and the
      //    message has to name the move rather than the quote.
      const tooShort = 'Ada Lovelace';
      const projectedShort = raise([tooShort], { frozenSourceQuotes: true });
      assert(!isJobIntegrityFault(projectedShort)
        && JSON.stringify(attribution(projectedShort).targets) === JSON.stringify(['resume:authored'])
        && /cite a different evidence ID/.test(projectedShort.message),
      `a projected quote too short to bind names the re-citation that repairs it (${projectedShort?.message || 'accepted'})`);
      const authoredShort = raise([tooShort], { frozenSourceQuotes: false });
      assert(!/cite a different evidence ID/.test(authoredShort.message),
        `a responder that wrote the quote is not sent to the evidence plan for it (${authoredShort?.message || 'accepted'})`);
      return { split: ['absent', 'wrapped', 'short'] };
    },
  },
  {
    name: 'Structured résumé grading requires the frozen corpus instead of silently dropping the rules that read it',
    run() {
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{
          id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '',
          bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }],
        }],
      };
      const context = {
        sourceRoles,
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' }],
        careerData,
      };
      const failure = (run) => { try { run(); return null; } catch (error) { return error; } };

      // An absent or blank corpus left the role-scope and provenance rules
      // unable to fire while the validator still reported a complete pass.
      const noCorpus = failure(() => renderStructuredApplicationResume(resume, { ...context, careerData: undefined }));
      const blankCorpus = failure(() => renderStructuredApplicationResume(resume, { ...context, careerData: '   ' }));
      assert(noCorpus?.code === 'STRUCTURED_RESUME_CONFIGURATION' && blankCorpus?.code === 'STRUCTURED_RESUME_CONFIGURATION',
        `grading without the frozen corpus must fail loudly, got ${noCorpus?.message || 'acceptance'} and ${blankCorpus?.message || 'acceptance'}`);
      // A host fault carries its own code so the paste stages rethrow it
      // instead of listing it among the corrections a responder is asked for.
      assert(noCorpus.code !== 'STRUCTURED_RESUME_INVALID',
        'a missing grounding input is reported as a host defect, not as a résumé defect for the responder to repair');

      const html = renderStructuredApplicationResume(resume, context);
      assert(html.includes('Built reporting systems that reduced manual work.'),
        'a stated corpus still renders the validated résumé unchanged');

      // The career-evidence rule inside the same validator is reachable only
      // from callers in this file, so its strictness is pinned at the
      // signature: a restored default would turn the rule off for the next one.
      const source = fs.readFileSync(new URL('../../electron/ipc/structuredResume.js', import.meta.url), 'utf8');
      const signature = source.match(/function normalizeEvidenceIds\([^)]*\)/u)?.[0] || '';
      assert(signature.includes('careerEvidenceIds,') && signature.includes('{ requireCareerEvidence,'),
        `both strictness arguments of the career-evidence rule must be stated by the caller, got ${signature || 'no signature'}`);
      return { rendered: true };
    },
  },
  {
    // The whole fail() surface of pasteApplicationAssembly.js, sorted on the
    // one question that decides the class: can the responder repair this by
    // changing what it returns? A defect it cannot — one whose subject is
    // state the app froze before any response existed — must never take a
    // repair target, because a repair target is a promise that the next
    // response can answer it. The verifier's loop was three of these falling
    // to the unattributed default, which forbids only a byte-identical repeat,
    // so a cosmetic edit reopened the same round forever.
    name: 'Completion-time assembly sorts every defect by whether the responder can repair it',
    run() {
      const CONTROL_CHAR = String.fromCharCode(7);
      const raise = (build) => {
        try { assemblePasteApplicationResult(build()); return null; }
        catch (error) { return error; }
      };
      // The property that keeps the class out of every correction round: the
      // collector that turns rejections into repair targets rethrows it
      // instead of listing it, so no present or future collector can quietly
      // hand it a target.
      const attribution = (error) => {
        try { return { targets: pasteRejectionChangeDocuments(error).targets, rethrown: false }; }
        catch (rethrown) { return { targets: null, rethrown: rethrown === error }; }
      };

      // Subject → the frozen thing each observation is about. Every case here
      // is reachable only by corrupting state the response never supplies.
      const unrepairable = [
        ['career corpus carries a control character', 'career corpus', () => fixture({}, { careerData: `${careerData}${CONTROL_CHAR}` })],
        ['career corpus is empty', 'career corpus', () => fixture({}, { careerData: '   ' })],
        ['job listing carries a control character', 'job listing', () => fixture({}, { jobListing: `Build reliable reporting systems.${CONTROL_CHAR}` })],
        ['evidence plan is not a record', 'evidence plan', () => fixture({ evidencePlan: 'plan' })],
        ['evidence plan has no evidence', 'evidence plan', () => fixture({ evidencePlan: { evidence: [] } })],
        ['evidence plan repeats an ID', 'evidence plan', () => fixture({ evidencePlan: { evidence: [
          { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' },
          { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' },
        ] } })],
        ['evidence plan carries an unusable source', 'evidence plan', () => fixture({ evidencePlan: { evidence: [
          { id: 'career-proof', sourceId: 'invented', quote: 'Built reporting systems that reduced manual work.' },
        ] } })],
        ['a frozen quote no longer occurs in the corpus', 'evidence plan', () => fixture({ evidencePlan: { evidence: [
          { id: 'career-proof', sourceId: 'career-data', quote: 'Ran a distributed message queue across three regions.' },
          { id: 'job-need', sourceId: 'job-listing', quote: 'Build reliable reporting systems.' },
        ] } })],
        ['a frozen quote no longer occurs in the listing', 'evidence plan', () => fixture({ evidencePlan: { evidence: [
          { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' },
          { id: 'job-need', sourceId: 'job-listing', quote: 'Operate a fleet of build agents.' },
        ] } })],
        ['a frozen evidence ID is blank', 'evidence plan', () => fixture({ evidencePlan: { evidence: [
          { id: '   ', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' },
        ] } })],
        ['the frozen identity is absent from the corpus', 'candidate identity', () => fixture({ trustedIdentity: { name: 'Someone Else Entirely', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' } })],
        ['the frozen identity has no contact list', 'candidate identity', () => fixture({ trustedIdentity: { name: 'Ada Lovelace', contact: 'ada@example.test', subtitleRole: 'Software Engineer', credential: '' } })],
        ['the job input is not a record', 'input record', () => fixture({}, { input: 'job-1' })],
        ['the job input has no trusted role list', 'input record', () => fixture({}, { input: { version: 1, jobId: 'job-1', sourceRoles: 'not-a-list' } })],
        ['the job input has no job id', 'input record', () => fixture({}, { input: { version: 1, jobId: '   ', sourceRoles } })],
        // The renderer grades this list too, but it reaches it through the
        // résumé, so a defect in it reported there reads as a résumé defect.
        ['a frozen trusted role is malformed', 'input record', () => fixture({}, { input: { version: 1, jobId: 'job-1', sourceRoles: [{ id: 'role-1', title: '', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }] } })],
        ['two frozen trusted roles share an id', 'input record', () => fixture({}, { input: { version: 1, jobId: 'job-1', sourceRoles: [sourceRoles[0], { ...sourceRoles[0], title: 'Staff Engineer' }] } })],
      ];

      const misclassified = [];
      const unnamedAction = [];
      const attributed = [];
      for (const [label, subject, build] of unrepairable) {
        const error = raise(build);
        if (!isJobIntegrityFault(error) || error?.code !== LOCAL_AI_JOB_INTEGRITY_CODE) {
          misclassified.push(`${label}: ${error?.message || 'accepted'}`);
          continue;
        }
        // Observation, honesty about the repair, the subject, and the action:
        // a message missing any of them sends a reader somewhere useless.
        if (!error.message.includes(error.jobIntegrity.observation)
          || !error.message.includes(subject)
          || !/no pasted response can repair it/.test(error.message)
          || !/Press Generate on the job card/.test(error.message)) {
          unnamedAction.push(`${label}: ${error.message}`);
        }
        if (!attribution(error).rethrown) attributed.push(label);
      }
      assert(!misclassified.length,
        `every defect about app-owned frozen state is a job-integrity fault: ${JSON.stringify(misclassified)}`);
      assert(!unnamedAction.length,
        `each fault states what was observed, that no response repairs it, whose value it is, and the action that does: ${JSON.stringify(unnamedAction)}`);
      assert(!attributed.length,
        `a job-integrity fault is rethrown by the attribution collector rather than given a repair target: ${JSON.stringify(attributed)}`);

      // One helper grades two different identities — the résumé's own block and
      // the one the job froze — so the observation has to name which was read.
      // Reporting the frozen identity as "resume identity" describes the wrong
      // value to the only person who can act on it.
      const frozenIdentity = raise(() => fixture({ trustedIdentity: { name: 'Someone Else Entirely', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' } }));
      assert(/trusted candidate identity value/.test(frozenIdentity.jobIntegrity.observation)
        && !/resume identity/.test(frozenIdentity.jobIntegrity.observation),
      `the observation names the identity that was read (${frozenIdentity.jobIntegrity?.observation})`);

      // The other half of the sweep, and the regression that would matter
      // more: a defect the responder CAN repair in one round must keep its
      // concrete target. Turning one of these into "regenerate the job" throws
      // away a finished package over an edit the next response could make.
      const repairable = [
        ['résumé identity value absent from the corpus', ['resume:authored'], () => fixture({ resume: { ...fixture().paste.resume, identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Principal Architect', credential: '' } } })],
        ['résumé is not a record', ['resume:authored'], () => fixture({ resume: 'a résumé' })],
        ['a bullet cites an evidence ID the plan does not hold', ['resume:authored'], () => fixture({ resume: { ...fixture().paste.resume, roles: [{ ...fixture().paste.resume.roles[0], bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['not-in-plan'] }] }] } })],
        ['a bullet cites only listing evidence', ['resume:authored'], () => fixture({ resume: { ...fixture().paste.resume, roles: [{ ...fixture().paste.resume.roles[0], bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['job-need'] }] }] } })],
        ['the letter envelope contradicts the frozen identity', ['coverLetter:authored'], () => fixture({ coverLetter: { ...fixture().paste.coverLetter, name: 'A. Lovelace' } })],
        ['a paragraph cites no evidence', ['coverLetter:authored'], () => fixture({ coverLetter: { ...fixture().paste.coverLetter, paragraphs: [{ id: 'letter-1', text: 'I built reporting systems that reduced manual work.', evidenceIds: [] }] } })],
        ['the letter carries no argument contract', ['coverLetter:authored'], () => fixture({ coverLetter: { ...fixture().paste.coverLetter, coverLetterArgument: null } })],
        ['the review carries no quality review', ['qualityReview'], () => fixture({ finalReview: { decision: 'pass', findings: [] } })],
        ['the review retains no generation audit', ['generationAudit'], () => fixture({ coverLetter: { ...fixture().paste.coverLetter, generationAudit: null } })],
        ['the audit binds the wrong number of paragraphs', ['generationAudit'], () => fixture({ coverLetter: { ...fixture().paste.coverLetter, generationAudit: { version: 1, coverLetterPlan: { paragraphs: [] } } } })],
        ['a bound audit paragraph carries a control character', ['generationAudit'], () => fixture({ coverLetter: { ...fixture().paste.coverLetter, generationAudit: { version: 1, coverLetterPlan: { paragraphs: [{ paragraph: `I built reporting systems that reduced manual work.${CONTROL_CHAR}` }] } } } })],
      ];

      const wrongTarget = [];
      for (const [label, targets, build] of repairable) {
        const error = raise(build);
        const attributed = attribution(error);
        if (isJobIntegrityFault(error) || attributed.rethrown || JSON.stringify(attributed.targets) !== JSON.stringify(targets)) {
          wrongTarget.push(`${label}: ${JSON.stringify(attributed.targets)} (${error?.message || 'accepted'})`);
        }
      }
      assert(!wrongTarget.length,
        `a defect the next response can repair keeps the target that names it: ${JSON.stringify(wrongTarget)}`);

      // The unattributed default, and what is honestly left for it: the review
      // response itself, whole. "Return a different response" is the literal
      // repair, so this one case is not a gap.
      const wholeResponse = raise(() => fixture({ finalReview: 'passed' }));
      assert(!isJobIntegrityFault(wholeResponse)
        && JSON.stringify(attribution(wholeResponse).targets) === JSON.stringify(['response']),
      `the unattributed default is left only for a defect in the response as a whole (${wholeResponse?.message || 'accepted'})`);
      return { unrepairable: unrepairable.length, repairable: repairable.length };
    },
  },
    {
    name: 'A lone role location folds into the dates cell with no separate role-meta row',
    run() {
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2022-04 – 2025-07', location: 'Brookfield, Ohio', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
      };
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2022-04 – 2025-07', location: '' }],
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' }],
        careerData: `${careerData}\nBrookfield, Ohio`,
      };
      const html = renderStructuredApplicationResume(resume, context);
      assert(!html.includes('role-meta') && !html.includes('role-location'),
        `a lone location renders no .role-meta row and no .role-location cell (html=${html})`);
      assert(html.includes('<p class="role-dates">2022-04 – 2025-07<span class="sep" aria-hidden="true">·</span>Brookfield, Ohio</p>'),
        `the dates cell carries the folded location after the standard separator (html=${html})`);
      return { folded: true };
    },
  },
  {
    name: 'Structured résumé role-dates fold round-trips through the evidence extractor and the location gate',
    run() {
      // STYLE.md §5.2b's whole justification is that the fold is READABLE, not
      // only that it renders — a fold this reader could not split back into
      // dates and location would satisfy the writer's budget while starving
      // the gate that requires the location, which is why this is the
      // assertion that matters most here, not the render alone.
      const roundTripCareerData = '## Maple Ridge School District — Brookfield, Ohio\nSoftware Engineer\n\nBuilt attendance reporting for district staff.';
      const roundTripRoles = [{ id: 'maple', title: 'Software Engineer', company: 'Maple Ridge School District', dates: '2022-04 – 2025-07', location: '' }];
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'maple', title: 'Software Engineer', company: 'Maple Ridge School District', dates: '2022-04 – 2025-07', location: 'Brookfield, Ohio', bullets: [{ id: 'bullet-1', text: 'Built attendance reporting for district staff.', evidenceIds: ['career-proof'] }] }],
      };
      const context = {
        sourceRoles: roundTripRoles,
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built attendance reporting for district staff.' }],
        careerData: roundTripCareerData,
      };
      const html = renderStructuredApplicationResume(resume, context);
      assert(!html.includes('role-location'),
        `the fold actually happened, so no separate .role-location cell exists to read instead (html=${html})`);
      const evidence = extractResumeEvidence(html);
      assert(evidence.roles[0].dates === '2022-04 – 2025-07' && evidence.roles[0].location === 'Brookfield, Ohio',
        `the extractor splits the folded dates cell back into its own dates and location (got dates="${evidence.roles[0].dates}" location="${evidence.roles[0].location}")`);
      const failures = resumeRoleLocationFailures(evidence.roles, roundTripCareerData);
      assert(!failures.length,
        `the gate that requires a shown location reads the folded shape as satisfied, not missing (${JSON.stringify(failures)})`);
      return { dates: evidence.roles[0].dates, location: evidence.roles[0].location };
    },
  },
  {
    name: 'A location naming a bare four-digit year keeps its own role-meta row instead of folding',
    run() {
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: 'Site 2020, Springfield', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
      };
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }],
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' }],
        careerData: `${careerData}\nSite 2020, Springfield`,
      };
      const html = renderStructuredApplicationResume(resume, context);
      assert(html.includes('<div class="role-meta meta-row"><p class="role-location">Site 2020, Springfield</p></div>'),
        `a location naming a bare four-digit year keeps its own .role-meta/.role-location row, because folding it would read as a second date range (html=${html})`);
      assert(html.includes('<p class="role-dates">2020 – 2024</p>'),
        'the dates cell stays unfolded');
      return { folded: false };
    },
  },
  {
    name: 'A role with a location but no dates keeps its own role-location row since there is no dates cell to fold into',
    run() {
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '', location: 'London, UK', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
      };
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '', location: '' }],
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' }],
        careerData: `${careerData}\nLondon, UK`,
      };
      const html = renderStructuredApplicationResume(resume, context);
      assert(!html.includes('<p class="role-dates">'),
        `a role with no dates renders no role-dates cell at all (html=${html})`);
      assert(html.includes('<div class="role-meta meta-row"><p class="role-location">London, UK</p></div>'),
        `a role with a location but no dates keeps its own .role-location row (html=${html})`);
      return { folded: false };
    },
  },
  {
    name: 'projectContactChannels drops application-logistics values that carry no channel, exactly the shipped letterhead defect',
    run() {
      const contact = ['Email: riley.okafor@example.test', 'Phone: (555) 010-0142', 'Freedonian citizenship', 'Willing to work anywhere. Can obtain a work visa without sponsorship.'];
      const projected = projectContactChannels(contact);
      assert(JSON.stringify(projected) === JSON.stringify(['Email: riley.okafor@example.test', 'Phone: (555) 010-0142']),
        `the projection keeps only the email and phone, in order, and drops the citizenship and visa lines (got ${JSON.stringify(projected)})`);
      return { projected };
    },
  },
  {
    name: 'A real contact channel survives projection even when it contains a logistics-sounding word',
    run() {
      const contact = ['github.com/visacard', 'Relocation Services Inc — hire@relocation.io'];
      const projected = projectContactChannels(contact);
      assert(projected.includes('github.com/visacard') && projected.includes('Relocation Services Inc — hire@relocation.io'),
        `a value that carries a channel is never dropped, whatever else it says (got ${JSON.stringify(projected)})`);
      return { projected };
    },
  },
  {
    name: 'An ordinary city and a profile link survive contact projection untouched',
    run() {
      const contact = ['Lakeview, Ontario', 'linkedin.com/in/rileyokafor'];
      const projected = projectContactChannels(contact);
      assert(JSON.stringify(projected) === JSON.stringify(contact),
        `neither value states application logistics, so both are kept unchanged (got ${JSON.stringify(projected)})`);
      return { projected };
    },
  },
  {
    name: 'projectContactChannels fails open when every value is application logistics, because a contact row is required',
    run() {
      const contact = ['Freedonian citizenship', 'Willing to relocate anywhere', 'Available immediately, no notice period'];
      const projected = projectContactChannels(contact);
      assert(projected === contact,
        `a contact list with no reachable channel at all is returned unchanged rather than emptied (got ${JSON.stringify(projected)})`);
      return { projected };
    },
  },
  {
    name: 'projectTrustedIdentity projects only the contact array and is idempotent',
    run() {
      const identity = { name: 'Ada Lovelace', subtitleRole: 'Software Engineer', credential: 'B.S. Computer Science', contact: ['ada@example.test', 'Freedonian citizenship'] };
      const once = projectTrustedIdentity(identity);
      const twice = projectTrustedIdentity(once);
      assert(once.name === identity.name && once.subtitleRole === identity.subtitleRole && once.credential === identity.credential,
        'projecting the identity leaves name, subtitleRole and credential untouched');
      assert(JSON.stringify(once.contact) === JSON.stringify(['ada@example.test']),
        `the identity's own contact array is projected the same way the bare list is (got ${JSON.stringify(once.contact)})`);
      assert(JSON.stringify(twice) === JSON.stringify(once),
        `projecting an already-projected identity is a no-op (once=${JSON.stringify(once)}, twice=${JSON.stringify(twice)})`);
      return { once, twice };
    },
  },
  {
    name: 'A rendered résumé contact row excludes application logistics even when the trusted identity supplied them',
    run() {
      const contact = ['ada@example.test', 'Freedonian citizenship', 'Willing to work anywhere. Can obtain a work visa without sponsorship.'];
      const resume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact },
        roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
      };
      const context = {
        sourceRoles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }],
        evidenceCatalog: [{ id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' }],
        careerData,
        trustedIdentity: { name: 'Ada Lovelace', contact },
      };
      const html = renderStructuredApplicationResume(resume, context);
      const contactRow = /<p class="contact"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] || '';
      assert(contactRow.includes('ada@example.test') && !/citizenship/i.test(contactRow) && !/visa/i.test(contactRow) && !/sponsorship/i.test(contactRow),
        `the rendered contact row keeps the reachable channel and drops the application-logistics values (contactRow=${contactRow})`);
      return { contactRow };
    },
  },
  {
    // Root cause this whole gate exists to prevent: the career corpus wrote one
    // required skill in lowercase and another in an odd mixed case while the
    // posting named both in the canonical spelling. Nothing required a
    // posting-named, career-attested name to reach the rendered block, so a
    // real generation dropped exactly the names whose corpus casing disagreed.
    // Which names count is decided by the approved inventory alone.
    name: 'Posting-named, career-attested skills must appear in the skills block',
    run() {
      const sourceRoles = [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];
      const catalog = () => [
        { id: 'ev-report', sourceId: 'career-data', quote: 'Coordinated the regional rota.' },
        { id: 'ev-ledger', sourceId: 'career-data', quote: 'Tech used: ledgerpro' },
        { id: 'ev-intake', sourceId: 'career-data', quote: 'Trained staff on the Aldrin Intake forms.' },
        { id: 'ev-quanta', sourceId: 'career-data', quote: 'Built forecasts with the Quanta Model.' },
        { id: 'ev-need', sourceId: 'job-listing', quote: 'Are proficient in LedgerPro and Aldrin Intake', priority: 'highest' },
      ];
      const inventory = approvedInventory(
        approvedSkill('ledger', 'LedgerPro'), approvedSkill('intake', 'Aldrin Intake', { capabilityKind: 'platform' }),
        approvedSkill('quanta', 'Quanta Model', { capabilityKind: 'method' }),
      );
      const careerData = 'Ada Lovelace\nada@example.test\n## Analytical Engines\nOperations Lead\n\nCoordinated the regional rota.\nTech used: ledgerpro\nTrained staff on the Aldrin Intake forms.\nBuilt forecasts with the Quanta Model.';
      const context = (overrides = {}) => ({ sourceRoles, evidenceCatalog: catalog(), careerData, careerSkillEvidence: inventory, authorityMode: true, ...overrides });
      const draft = (skills) => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Coordinated the regional rota.', evidenceIds: ['ev-report'] }] }],
        skills,
      });
      // `reject` keeps its name from when these omissions rejected: it returns
      // what the draft is told about the skills block. Completeness of the index
      // is a selection preference, so it advises and never rejects.
      const reject = (skills, overrides = {}) => structuredOutcome(draft(skills), context(overrides)).text;

      assert(JSON.stringify(postingNamedAttestedSkillTerms(catalog(), inventory)) === JSON.stringify(['LedgerPro', 'Aldrin Intake']),
        'the posting names two approved skills and the career quotes state both, so both are required, in the approved spelling, even though one career quote spells the name in lowercase');

      const onlyQuanta = reject([
        { id: 's1', group: 'methods', items: ['Quanta Model'], evidenceIds: ['ev-quanta'] },
      ]);
      assert(onlyQuanta.includes('skills omits LedgerPro, Aldrin Intake'),
        `a block that drops the posting-named skills is advised about, naming both in their approved spelling (got ${onlyQuanta})`);
      assert(!onlyQuanta.includes('ledgerpro'),
        `the advice names only the approved spelling, never the corpus's lowercase one (got ${onlyQuanta})`);
      assert(!structuredOutcome(draft([{ id: 's1', group: 'methods', items: ['Quanta Model'], evidenceIds: ['ev-quanta'] }]), context()).rejected,
        'a skills block that leaves out a posting-named, career-attested skill is told so and is never rejected for it');

      const carryingAll = reject([
        { id: 's1', group: 'tools', items: ['LedgerPro'], evidenceIds: ['ev-ledger'] },
        { id: 's2', group: 'platforms', items: ['Aldrin Intake'], evidenceIds: ['ev-intake'] },
        { id: 's3', group: 'methods', items: ['Quanta Model'], evidenceIds: ['ev-quanta'] },
      ]);
      assert(carryingAll === '', `a block carrying every posting-required and prioritized career-attested skill in its approved spelling is accepted (got ${carryingAll})`);

      const noBlock = reject(undefined);
      assert(noBlock.includes('LedgerPro') && noBlock.includes('Aldrin Intake'),
        `a résumé with no skills block at all is rejected for every required name (got ${noBlock})`);

      // A retained pre-snapshot job has no approved inventory, so there is no
      // evidence from which to demand a name: the same plan demands nothing.
      const legacy = reject(undefined, { careerSkillEvidence: null, authorityMode: false });
      assert(legacy === '', `without an approved inventory nothing can be demanded (got ${legacy})`);
      return { requiredRejected: true, carryingAllAccepted: true, noBlockRejected: true, legacyStandsDown: true };
    },
  },
  {
    name: 'Posting-named matching is whole-term and never reads a longer name as a shorter one',
    run() {
      const sourceRoles = [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];
      const careerData = 'Ada Lovelace\nada@example.test\n## Analytical Engines\nOperations Lead\n\nCoordinated the regional rota.';
      const draft = () => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Coordinated the regional rota.', evidenceIds: ['ev-report'] }] }],
      });
      // Each case's career quote states a name the approved inventory carries, so
      // the résumé owes a skills block; each case carries the one row its own
      // quote states, which leaves the posting-named rule under test the only
      // thing that can reject it.
      const outcome = (inventory, listingQuote, careerQuote, skills) => {
        const result = structuredOutcome({ ...draft(), skills }, {
          sourceRoles, careerData, careerSkillEvidence: inventory, authorityMode: true,
          evidenceCatalog: [
            { id: 'ev-report', sourceId: 'career-data', quote: 'Coordinated the regional rota.' },
            { id: 'ev-career', sourceId: 'career-data', quote: careerQuote },
            { id: 'ev-need', sourceId: 'job-listing', quote: listingQuote },
          ],
        });
        return result.text === '' ? true : result.text;
      };

      const longer = outcome(
        approvedInventory(approvedSkill('long', 'LedgerPro Cloud')),
        'Ledger duties for the clinic', 'Operated LedgerPro Cloud nightly',
        [{ id: 's1', group: 'tools', items: ['LedgerPro Cloud'], evidenceIds: ['ev-career'] }],
      );
      assert(longer === true, 'a listing that names only part of an approved multi-word skill demands nothing of it, and the block that carries the full approved name is accepted');

      const adjacent = outcome(
        approvedInventory(approvedSkill('short', 'Ledger'), approvedSkill('long', 'LedgerPro')),
        'Ledger duties for the clinic', 'Operated LedgerPro nightly',
        [{ id: 's1', group: 'tools', items: ['LedgerPro'], evidenceIds: ['ev-career'] }],
      );
      assert(adjacent === true, 'a listing naming Ledger is not satisfied by LedgerPro in career data (whole-term, no substring match), so the shorter approved skill demands nothing here');

      // Positive controls: the same shapes, but with the posting and the career
      // evidence naming the term in matching form.
      const demanded = outcome(
        approvedInventory(approvedSkill('short', 'Ledger'), approvedSkill('long', 'LedgerPro')),
        'Ledger duties for the clinic', 'Operated Ledger and LedgerPro nightly',
        [{ id: 's1', group: 'tools', items: ['LedgerPro'], evidenceIds: ['ev-career'] }],
      );
      assert(typeof demanded === 'string' && demanded.includes('skills omits Ledger:'),
        `a name the posting and the career quote both state as a whole term is demanded (got ${demanded})`);
      return { wholeTerm: true, adjacentKept: true, demanded: true };
    },
  },
  {
    name: 'Posting-named term requirement stands down without a source-tagged catalog or an approved inventory',
    run() {
      const sourceRoles = [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];
      const careerData = 'Ada Lovelace\nada@example.test\n## Analytical Engines\nOperations Lead\n\nCoordinated the regional rota.';
      const draft = () => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Coordinated the regional rota.', evidenceIds: ['ev-report'] }] }],
      });
      const inventory = approvedInventory(approvedSkill('ledger', 'LedgerPro'));
      const accept = (evidenceCatalog, careerSkillEvidence = inventory) => structuredOutcome(draft(), { sourceRoles, evidenceCatalog, careerData, careerSkillEvidence, authorityMode: careerSkillEvidence != null }).text;

      const careerOnly = accept([
        { id: 'ev-report', sourceId: 'career-data', quote: 'Coordinated the regional rota.' },
        { id: 'ev-ledger', sourceId: 'career-data', quote: 'Operated LedgerPro nightly' },
      ]);
      assert(careerOnly === '', 'a catalog with no job-listing source stands the rule down rather than guessing (career-only catalogue)');

      const stringIds = accept(['ev-report']);
      assert(stringIds === '', 'a plain string-id catalog cannot say which quotes came from the posting, so the rule stands down');

      const noInventory = accept([
        { id: 'ev-report', sourceId: 'career-data', quote: 'Coordinated the regional rota.' },
        { id: 'ev-ledger', sourceId: 'career-data', quote: 'Operated LedgerPro nightly' },
        { id: 'ev-need', sourceId: 'job-listing', quote: 'LedgerPro duties', priority: 'highest' },
      ], null);
      assert(noInventory === '', 'a job with no approved inventory has no evidence from which to demand a name');

      return { careerOnlyStandsDown: true, stringIdsStandDown: true, noInventoryStandsDown: true };
    },
  },
  {
    name: 'requiredCareerAttestedSkillTerms prioritizes posting matches, then inventory order, drops a name a longer selected name already carries, and keeps merely adjacent names',
    run() {
      const inventory = approvedInventory(
        approvedSkill('ledger', 'LedgerPro'), approvedSkill('cloud', 'LedgerPro Cloud'),
        approvedSkill('plain', 'Ledger'), approvedSkill('quanta', 'Quanta'), approvedSkill('model', 'Quanta Model', { capabilityKind: 'method' }),
        approvedSkill('triage', 'Triage Board', { capabilityKind: 'method' }), approvedSkill('rota', 'Rotamax', { capabilityKind: 'platform' }),
      );
      const catalog = [
        { id: 'l', sourceId: 'job-listing', quote: 'Rotamax scheduling for dependable regional rosters.', priority: 'highest' },
        { id: 'c-low', sourceId: 'career-data', quote: 'Kept the Triage Board current.', priority: 'supporting' },
        { id: 'c-high', sourceId: 'career-data', quote: 'Operated LedgerPro Cloud and the Quanta Model nightly.', priority: 'high' },
        { id: 'c-rota', sourceId: 'career-data', quote: 'Automated Rotamax and Ledger reporting.', priority: 'supporting' },
      ];
      const required = requiredCareerAttestedSkillTerms(catalog, inventory);
      assert(JSON.stringify(required) === JSON.stringify(['Rotamax', 'LedgerPro Cloud', 'Ledger', 'Quanta Model', 'Triage Board']),
        `posting matches lead, career terms follow inventory order, a name that is a whole-word sub-phrase of another selected name is dropped (LedgerPro stays out only because its longer form is selected; Quanta likewise), and the adjacent but distinct Ledger is kept (got ${JSON.stringify(required)})`);
      const missing = missingRequiredCareerSkillTerms([{ items: ['Rotamax', 'LedgerPro Cloud'] }], catalog, inventory);
      assert(JSON.stringify(missing) === JSON.stringify(['Ledger', 'Quanta Model', 'Triage Board']),
        `the missing-index helper reports every required name the rendered block lacks (got ${JSON.stringify(missing)})`);
      assert(required.length <= MAX_REQUIRED_CAREER_SKILL_TERMS, 'the prioritized index stays inside its published cap');

      // A shorter name stays required when no longer selected name carries it.
      const alone = requiredCareerAttestedSkillTerms(catalog, approvedInventory(approvedSkill('ledger', 'LedgerPro'), approvedSkill('rota', 'Rotamax')));
      assert(alone.includes('LedgerPro') && alone.includes('Rotamax'), `a name with no longer selected form is kept (got ${JSON.stringify(alone)})`);
      return { required, cap: MAX_REQUIRED_CAREER_SKILL_TERMS };
    },
  },
  {
    name: 'careerAttestedSkillTerms lists approved names, stands down without both sources, and the host names no technology',
    run() {
      const inventory = approvedInventory(approvedSkill('a', 'Aster Press'), approvedSkill('b', 'Birch Ledger'));
      const catalog = [
        { id: 'l', sourceId: 'job-listing', quote: 'Coordinate the office.' },
        { id: 'c1', sourceId: 'career-data', quote: 'Built it with Birch Ledger and Aster Press.' },
        { id: 'c2', sourceId: 'career-data', quote: 'A swift migration during a spring release.' },
      ];
      assert(JSON.stringify(careerAttestedSkillTerms(catalog, inventory)) === JSON.stringify(['Aster Press', 'Birch Ledger']),
        `approved names come back in inventory order, matched whole-term (got ${JSON.stringify(careerAttestedSkillTerms(catalog, inventory))})`);
      assert(careerAttestedSkillTerms(catalog.filter(entry => entry.sourceId === 'career-data'), inventory).length === 0, 'no job-listing source: stands down');
      assert(careerAttestedSkillTerms(catalog.filter(entry => entry.sourceId === 'job-listing'), inventory).length === 0, 'no career-data source: nothing attested');
      assert(careerAttestedSkillTerms(undefined, inventory).length === 0 && careerAttestedSkillTerms(['a'], inventory).length === 0, 'non-catalog input yields no names and never throws');

      // No host vocabulary: a pre-snapshot job whose quotes name widely used
      // products demands none of them, because nothing approved says they are
      // this candidate's skills.
      const famous = [
        { id: 'l', sourceId: 'job-listing', quote: 'Python, TypeScript, Docker Compose, Nginx, React and SQL required.', priority: 'highest' },
        { id: 'c', sourceId: 'career-data', quote: 'Tech used: Python, TypeScript, Docker Compose, Nginx, React, SQL' },
      ];
      assert(careerAttestedSkillTerms(famous).length === 0 && postingNamedAttestedSkillTerms(famous).length === 0 && requiredCareerAttestedSkillTerms(famous).length === 0,
        'without an approved inventory no name is demanded, however widely used it is');
      return { inventoryOrder: true };
    },
  },
  {
    // The approved inventory is the sole authority for how a skill is spelled.
    // A fixed rule about one product's casing is wrong for every other product
    // and wrong for a candidate whose source spells that product differently.
    name: 'A mixed-case approved skill name is held to its approved spelling in prose, and the host knows no spelling of its own',
    run() {
      const sourceRoles = [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];
            const run = ({ approved, bullet, project = null, skillItem = null }) => {
        const quote = `Reconciled payroll in ${approved} for the regional office.`;
        const evidenceCatalog = [{ id: 'career-proof', sourceId: 'career-data', quote }, { id: 'job-need', sourceId: 'job-listing', quote: 'Own regional payroll reconciliation.' }];
        const careerData = `Ada Lovelace\nada@example.test\n## Analytical Engines\nOperations Lead\n\n${quote}`;
        try {
          renderStructuredApplicationResume({
            schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
            identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
            roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: bullet, evidenceIds: ['career-proof'] }] }],
            ...(project ? { projects: [project] } : {}),
            skills: [{ id: 'skills-1', group: 'tools', items: [skillItem || approved], evidenceIds: ['career-proof'] }],
          }, { sourceRoles, evidenceCatalog, careerData, careerSkillEvidence: approvedInventory(approvedSkill('x', approved)), authorityMode: true });
          return '';
        } catch (error) { return String(error?.message || error); }
      };

      const faithful = run({ approved: 'LedgerPro', bullet: 'Reconciled payroll in LedgerPro for the regional office.' });
      assert(faithful === '', `the approved spelling renders (got ${faithful})`);
      const variant = run({ approved: 'LedgerPro', bullet: 'Reconciled payroll in Ledgerpro for the regional office.' });
      assert(variant.includes('roles[0].bullets[0].text uses “Ledgerpro”') && variant.includes('approved spelling “LedgerPro”'),
        `a different capitalization of a mixed-case approved name is rejected in prose with the approved spelling named (got ${variant})`);
      const projectVariant = run({
        approved: 'LedgerPro', bullet: 'Reconciled payroll in LedgerPro for the regional office.',
        project: { id: 'project-1', name: 'LEDGERPRO', description: 'Reconciled payroll in LedgerPro for the regional office.', metrics: '', evidenceIds: ['career-proof', 'job-need'] },
      });
      assert(projectVariant.includes('projects[0].name uses “LEDGERPRO”'), `the same rule reaches project copy (got ${projectVariant})`);

      // Faithful prose is not rejected: an initial-capital or all-capitals
      // approved name has a common-word reading in another case.
      const common = run({ approved: 'Swift', bullet: 'Reconciled payroll in Swift during a swift handover for the regional office.' });
      assert(common === '', `a name whose other-case form is an ordinary word is left alone (got ${common})`);
      const acronym = run({ approved: 'REST', bullet: 'Reconciled payroll in REST while the rest of the office slept.' });
      assert(acronym === '', `an all-capitals approved name never rejects the ordinary word (got ${acronym})`);

      // The source's own spelling is authoritative: when the approved name IS
      // the odd spelling, that spelling renders and nothing is flagged.
      const odd = run({ approved: 'Ledgerpro', bullet: 'Reconciled payroll in Ledgerpro for the regional office.' });
      assert(odd === '', `a name approved in an unusual spelling is rendered exactly as approved (got ${odd})`);
      return { variantRejected: true, projectRejected: true, commonWordKept: true };
    },
  },
  {
    // Root cause this gate exists to prevent: a posting that names none of the
    // candidate's skills made the posting-named rule demand nothing, and a real
    // generation shipped a résumé with one skill while the accepted career
    // evidence also stated several more. Presence alone is not quality: ATS
    // skill fields are extracted off this index.
    name: 'A résumé must carry the bounded prioritized career-attested skill index, not merely one token',
    run() {
      const sourceRoles = [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];
      const genericListing = { id: 'ev-need', sourceId: 'job-listing', quote: 'Participates in cross-functional teams to coordinate and improve regional operations.', priority: 'highest' };
      const inventory = approvedInventory(
        approvedSkill('ledger', 'LedgerPro'), approvedSkill('triage', 'Triage Board', { capabilityKind: 'method' }),
        approvedSkill('quanta', 'Quanta Model', { capabilityKind: 'method' }), approvedSkill('rota', 'Rotamax', { capabilityKind: 'platform' }),
      );
      const catalog = () => [
        { id: 'ev-report', sourceId: 'career-data', quote: 'Coordinated the regional rota.' },
        { id: 'ev-ledger', sourceId: 'career-data', quote: 'Tech used: ledgerpro' },
        { id: 'ev-hub', sourceId: 'career-data', quote: 'Ran the Triage Board, the Quanta Model and Rotamax for the regional office.' },
        genericListing,
      ];
      const careerData = 'Ada Lovelace\nada@example.test\n## Analytical Engines\nOperations Lead\n\nCoordinated the regional rota.\nTech used: ledgerpro\nRan the Triage Board, the Quanta Model and Rotamax for the regional office.';
      const draft = (skills) => ({
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-1', title: 'Operations Lead', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Coordinated the regional rota.', evidenceIds: ['ev-report'] }] }],
        ...(skills === undefined ? {} : { skills }),
      });
      const attempt = (skills, evidenceCatalog = catalog(), careerSkillEvidence = inventory) => structuredOutcome(draft(skills), { sourceRoles, evidenceCatalog, careerData, careerSkillEvidence, authorityMode: careerSkillEvidence != null }).text;

      assert(postingNamedAttestedSkillTerms(catalog(), inventory).length === 0, 'precondition: the generic posting names no attested skill, so the coverage rule demands nothing');
      const absent = attempt(undefined);
      assert(absent.includes('skills omits LedgerPro, Triage Board, Quanta Model, Rotamax') && absent.includes('bounded career-attested index'),
        `a draft with no skills key is told the complete bounded index it owes (got ${absent})`);
      const emptyArray = attempt([]);
      assert(emptyArray.includes('skills omits LedgerPro, Triage Board, Quanta Model, Rotamax'), `an empty skills array owes the same complete index (got ${emptyArray})`);

      const oneRow = attempt([{ id: 's1', group: 'tools', items: ['LedgerPro'], evidenceIds: ['ev-ledger'] }]);
      assert(oneRow.includes('skills omits Triage Board, Quanta Model, Rotamax'), `a one-item compliance gesture is told the evidence-backed terms it dropped (got ${oneRow})`);
      const complete = attempt([
        { id: 's1', group: 'tools', items: ['LedgerPro'], evidenceIds: ['ev-ledger'] },
        { id: 's2', group: 'methods', items: ['Triage Board', 'Quanta Model'], evidenceIds: ['ev-hub'] },
        { id: 's3', group: 'platforms', items: ['Rotamax'], evidenceIds: ['ev-hub'] },
      ]);
      assert(complete === '', `the complete, source-grounded four-term index passes (got ${complete})`);

      // Satisfiable by construction: nothing to index means nothing demanded.
      const nothingAttested = attempt(undefined, [
        { id: 'ev-report', sourceId: 'career-data', quote: 'Coordinated the regional rota.' },
        genericListing,
      ]);
      assert(nothingAttested === '', `a plan whose career quotes state no approved skill stands the floor down (got ${nothingAttested})`);

      // Same stand-downs as the coverage rule: without both halves of a
      // source-tagged catalog the rule cannot tell it is in the paste workflow.
      const careerOnly = attempt(undefined, catalog().filter(entry => entry.sourceId === 'career-data'));
      assert(careerOnly === '', `a catalog with no job-listing source stands the floor down (got ${careerOnly})`);
      const stringIds = attempt(undefined, ['ev-report']);
      assert(stringIds === '', `a string-id catalog stands the floor down (got ${stringIds})`);

      // The posting-specific wording remains for its own omission while the
      // breadth rule names only the additional career-attested terms.
      const postingNamed = attempt(undefined, [...catalog(), { id: 'ev-need-ledger', sourceId: 'job-listing', quote: 'Proficient in LedgerPro', priority: 'highest' }]);
      assert(postingNamed.includes('skills omits LedgerPro')
        && postingNamed.includes('skills omits Triage Board, Quanta Model, Rotamax from the bounded career-attested index'),
      `posting-named and additional career coverage are both actionable without duplicating LedgerPro (got ${postingNamed})`);

      assert(!structuredOutcome(draft(undefined), { sourceRoles, evidenceCatalog: catalog(), careerData, careerSkillEvidence: inventory, authorityMode: true }).rejected,
        'an absent skills block owes the index as advice and is never rejected for it');
      return { absentAdvised: true, emptyArrayAdvised: true, oneRowAdvised: true, completeAccepted: true, standsDown: true };
    },
  },
  {
    name: 'postingNamedAttestedSkillTerms orders by priority then listing order and caps at ten',
    run() {
      const names = ['Axiom Ledger', 'Borealis CAD', 'Cobalt Intake', 'Dune Roster', 'Ember Pantry', 'Fathom Audit', 'Garnet Triage', 'Harbor Dispatch', 'Indigo Grader', 'Juniper Lathe', 'Kestrel Survey', 'Lumen Pharmacy'];
      const inventory = approvedInventory(...names.map((name, index) => approvedSkill(`n${index}`, name)));
      const career = { id: 'c', sourceId: 'career-data', quote: `Tech used: ${names.join(', ')}` };
      const listing = [
        { id: 'l1', sourceId: 'job-listing', quote: 'Dune Roster scheduling', priority: 'high' },
        { id: 'l2', sourceId: 'job-listing', quote: 'Axiom Ledger reporting', priority: 'highest' },
        { id: 'l3', sourceId: 'job-listing', quote: 'Garnet Triage rounds', priority: 'high' },
        { id: 'l4', sourceId: 'job-listing', quote: 'Cobalt Intake forms', priority: 'supporting' },
      ];
      assert(JSON.stringify(postingNamedAttestedSkillTerms([...listing, career], inventory)) === JSON.stringify(['Axiom Ledger', 'Dune Roster', 'Garnet Triage', 'Cobalt Intake']),
        'higher priority is listed first, then the first listing entry, no matter the inventory order');

      const cappedCatalog = [
        { id: 'need', sourceId: 'job-listing', quote: `Required: ${names.join(', ')}`, priority: 'highest' },
        career,
      ];
      assert(postingNamedAttestedSkillTerms(cappedCatalog, inventory).length === MAX_REQUIRED_POSTING_SKILL_TERMS
        && JSON.stringify(postingNamedAttestedSkillTerms(cappedCatalog, inventory)) === JSON.stringify(names.slice(0, MAX_REQUIRED_POSTING_SKILL_TERMS)),
      'twelve posting-named, career-attested names are capped to exactly ten, in priority/listing order');

      const missing = missingPostingNamedSkillTerms(
        [{ items: ['Axiom Ledger', 'Borealis CAD'] }, { items: ['Dune Roster'] }],
        [...listing, career],
        inventory,
      );
      assert(JSON.stringify(missing) === JSON.stringify(['Garnet Triage', 'Cobalt Intake']),
        'missingPostingNamedSkillTerms returns only the required names no item carries');

      const noCatalog = postingNamedAttestedSkillTerms(undefined, inventory);
      assert(JSON.stringify(noCatalog) === JSON.stringify([]), 'a non-array catalog yields no required names');
      return { ordering: true, cap: MAX_REQUIRED_POSTING_SKILL_TERMS, missing: 2 };
    },
  },
  {
    name: 'Snapshot skill evidence uses approved novel names and keeps short ambiguous names source-limited',
    run() {
      const snapshotSkills = {
        version: 'career-snapshot-skills.v1',
        skills: [
          { id: 'skill-novel', name: 'ZyzzyvaDB', indexEligible: true, evidenceSegmentIds: ['segment-0001'] },
          { id: 'skill-c', name: 'C', indexEligible: true, evidenceSegmentIds: ['segment-0002'] },
        ],
      };
      const catalog = [
        { id: 'listing-novel', sourceId: 'job-listing', quote: 'Operate ZyzzyvaDB storage.', priority: 'highest' },
        { id: 'listing-prose', sourceId: 'job-listing', quote: 'Candidates can communicate clearly.', priority: 'highest' },
        { id: 'career-novel', sourceId: 'career-data', quote: 'Built ZyzzyvaDB storage migrations.', priority: 'high' },
        { id: 'career-c', sourceId: 'career-data', quote: 'Maintained C services for embedded devices.', priority: 'supporting' },
      ];
      assert(JSON.stringify(postingNamedAttestedSkillTerms(catalog, snapshotSkills)) === JSON.stringify(['ZyzzyvaDB']),
        'a snapshot-backed run requires an approved novel technology without falling back to the closed list or mistaking lowercase prose for C');
      assert(JSON.stringify(requiredCareerAttestedSkillTerms(catalog, snapshotSkills)) === JSON.stringify(['ZyzzyvaDB', 'C']),
        'the complete snapshot index retains only names the accepted career evidence actually states');
      assert(JSON.stringify(missingRequiredCareerSkillTerms([{ items: ['ZyzzyvaDB'] }], catalog, snapshotSkills)) === JSON.stringify(['C']),
        'dynamic missing-term checks use the frozen approved set rather than the legacy vocabulary');
      const lowercaseContext = {
        sourceRoles: [{ id: 'role-npm', title: 'Engineer', company: 'Acme', dates: '2020 – 2024', location: '' }],
        careerData: 'Ada Lovelace\nada@example.test\n## Acme\nEngineer\n\nBuilt npm packages for internal services.',
        evidenceCatalog: [
          { id: 'career-npm', sourceId: 'career-data', quote: 'Built npm packages for internal services.' },
          { id: 'listing-npm', sourceId: 'job-listing', quote: 'Maintain package tooling.' },
        ],
        careerSkillEvidence: {
          version: 'career-snapshot-skills.v1',
          skills: [{ id: 'skill-npm', name: 'npm', indexEligible: null, evidenceSegmentIds: ['segment-0003'] }],
        },
      };
      const lowercaseDraft = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [{ id: 'role-npm', title: 'Engineer', company: 'Acme', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-npm', text: 'Built npm packages for internal services.', evidenceIds: ['career-npm'] }] }],
        skills: [{ id: 'skills-npm', group: 'tools', items: ['npm'], evidenceIds: ['career-npm'] }],
      };
      assert(renderStructuredApplicationResume(lowercaseDraft, lowercaseContext).includes('npm'),
        'an exact lowercase approved snapshot name bypasses the legacy uppercase-or-digit heuristic');
      // A case/spacing variant of an approved skill resolves to the approved
      // canonical spelling; it is never rendered as a new spelling.
      let variantOutcome;
      try {
        variantOutcome = renderStructuredApplicationResume({ ...lowercaseDraft, skills: [{ ...lowercaseDraft.skills[0], items: ['NPM'] }] }, lowercaseContext);
      } catch (error) { variantOutcome = error; }
      assert(typeof variantOutcome === 'string' ? (variantOutcome.includes('npm') && !variantOutcome.includes('NPM')) : variantOutcome instanceof Error,
        'snapshot mode either resolves a capitalization variant to the approved canonical spelling or rejects it; it never prints an invented spelling');
      return { novelRequired: true, shortTokenSourceLimited: true, lowercaseApproved: true };
    },
  },
  {
    name: 'Snapshot skill evidence v2 is a direct-only inventory and v1 remains an isolated historical reader',
    run() {
      const catalog = [
        { id: 'listing-cedar', sourceId: 'job-listing', quote: 'Operate Cedar infrastructure.', priority: 'highest' },
        { id: 'career-cedar', sourceId: 'career-data', quote: 'Maintained Cedar infrastructure directly.' },
      ];
      const directInventory = {
        version: CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION,
        skills: [{
          id: 'skill-cedar', name: 'Cedar', capabilityKind: 'platform', supportMode: 'direct',
          directEvidenceSegmentIds: ['segment-0001'], indexEligible: true, evidenceSegmentIds: ['segment-0001'],
        }],
      };
      const historical = {
        version: CAREER_SNAPSHOT_HISTORICAL_SKILL_EVIDENCE_VERSION,
        skills: [{ id: 'skill-elm', name: 'Elm', indexEligible: true, evidenceSegmentIds: ['segment-0002'] }],
      };
      let qualifiedRejected = false;
      try {
        postingNamedAttestedSkillTerms(catalog, {
          version: CAREER_SNAPSHOT_SKILL_EVIDENCE_VERSION,
          skills: [{
            id: 'skill-juniper', name: 'Juniper', capabilityKind: 'platform', supportMode: 'relationship-qualified',
            directEvidenceSegmentIds: [], indexEligible: false, evidenceSegmentIds: ['segment-0003'],
          }],
        });
      } catch { qualifiedRejected = true; }
      assert(JSON.stringify(postingNamedAttestedSkillTerms(catalog, directInventory)) === JSON.stringify(['Cedar'])
        && JSON.stringify(postingNamedAttestedSkillTerms(catalog, historical)) === JSON.stringify([])
        && qualifiedRejected,
      'v2 accepts only direct, index-eligible inventory rows, rejects relation-qualified rows instead of flattening them into keyword matching, and keeps the explicit v1 reader separate');
      return { v2DirectOnly: true, v1Historical: true };
    },
  },
];
