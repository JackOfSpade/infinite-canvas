import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assert, validateLocalApplicationResult } from '../test-dependencies.js';
import { FROZEN_COMPLETED_PACKAGE, LOCAL_AI_JOB_INTEGRITY_CODE, MAX_FROZEN_SOURCE_CHARS, MAX_UNIT_CAREER_DATA_QUOTES, assemblePasteApplicationResult, isJobIntegrityFault, normalizeBoundDocumentText } from '../../electron/ipc/pasteApplicationAssembly.js';
import { APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, LOCAL_AI_GENERATION_AUDIT_VERSION, pasteRejectionChangeDocuments, queueLocalApplicationJob, sanitizeQualityReview, stampPasteQualityReviewFromFit } from '../../electron/ipc/localAiApplication.js';
import { renderStructuredApplicationResume, STRUCTURED_RESUME_LIMITS, STRUCTURED_RESUME_SCHEMA_VERSION } from '../../electron/ipc/structuredResume.js';
import { careerDataProjectProvenanceHeadingForName } from '../../electron/ipc/jobApplication.js';

const careerData = 'Ada Lovelace\nada@example.test\nSoftware Engineer\nBuilt reporting systems that reduced manual work.';
const sourceRoles = [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '' }];

// `overrides` replaces fields of the pasted package; `frozen` replaces the
// app-owned inputs assembly is handed beside it.
function fixture(overrides = {}, frozen = {}) {
  return {
    input: { version: 1, jobId: 'job-1', sourceRoles },
    careerData,
    jobListing: 'Build reliable reporting systems.',
    ...frozen,
    paste: {
      trustedIdentity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
      evidencePlan: { evidence: [
        { id: 'career-proof', sourceId: 'career-data', quote: 'Built reporting systems that reduced manual work.' },
        { id: 'job-need', sourceId: 'job-listing', quote: 'Build reliable reporting systems.' },
      ] },
      resume: {
        schemaVersion: 'structured-resume.v1',
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Software Engineer', credential: '' },
        roles: [{ id: 'role-1', title: 'Software Engineer', company: 'Analytical Engines', dates: '2020 – 2024', location: '', bullets: [{ id: 'bullet-1', text: 'Built reporting systems that reduced manual work.', evidenceIds: ['career-proof'] }] }],
      },
      coverLetter: {
        name: 'Ada Lovelace', contact: ['ada@example.test'],
        paragraphs: [{ id: 'letter-1', text: 'I built reporting systems that reduced manual work.', evidenceIds: ['career-proof', 'job-need'] }],
        coverLetterArgument: { roleThesis: 'I can apply reporting-system experience to this reliable reporting work.', primaryEvidence: { evidence: 'Built reporting systems that reduced manual work.', evidenceRole: 'Software Engineer', relationToThesis: 'It proves direct reporting-system delivery.' } },
        generationAudit: { version: 1, finalDecisionSummary: 'The final review retained only source-supported reporting evidence.', coverLetterPlan: { paragraphs: [{ paragraph: 'I built reporting systems that reduced manual work.' }] } },
      },
      finalReview: { decision: 'pass', findings: [], qualityReview: { checklistVersion: 3, criteria: [], resume: { decision: 'approved', rationale: 'The résumé keeps direct source-supported reporting evidence.' }, coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target reporting work.' } } },
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
    name: 'Structured résumé roles keep career evidence and blank trusted locations within their own identifiable career section',
    run() {
      const scopedCareerData = `Work Done from Past Jobs

Software Engineer

Thomson School District — Loveland, Colorado
*May 2023 – June 2026*
- Built attendance reporting for district staff.

Data Engineer

Horizon Health Alliance — Denver, Colorado
*January 2020 – April 2023*
- Built clinical data pipelines for care teams.

---
Personal Projects`;
      const scopedRoles = [
        { id: 'thomson', title: 'Software Engineer', company: 'Thomson School District', dates: 'May 2023 – June 2026', location: '' },
        { id: 'horizon', title: 'Data Engineer', company: 'Horizon Health Alliance', dates: 'January 2020 – April 2023', location: '' },
      ];
      const scopedResume = {
        schemaVersion: STRUCTURED_RESUME_SCHEMA_VERSION,
        identity: { name: 'Ada Lovelace', contact: ['ada@example.test'] },
        roles: [
          { id: 'thomson', title: 'Software Engineer', company: 'Thomson School District', dates: 'May 2023 – June 2026', location: 'Loveland, Colorado', bullets: [{ id: 'thomson-bullet', text: 'Built attendance reporting for district staff.', evidenceIds: ['thomson-proof'] }] },
          { id: 'horizon', title: 'Data Engineer', company: 'Horizon Health Alliance', dates: 'January 2020 – April 2023', location: 'Denver, Colorado', bullets: [{ id: 'horizon-bullet', text: 'Built clinical data pipelines for care teams.', evidenceIds: ['horizon-proof'] }] },
        ],
      };
      const scopedContext = {
        sourceRoles: scopedRoles,
        careerData: scopedCareerData,
        evidenceCatalog: [
          { id: 'thomson-proof', sourceId: 'career-data', quote: 'Built attendance reporting for district staff.' },
          { id: 'horizon-proof', sourceId: 'career-data', quote: 'Built clinical data pipelines for care teams.' },
          { id: 'job-need', sourceId: 'job-listing', quote: 'Build reliable reporting systems.' },
        ],
      };
      const html = renderStructuredApplicationResume(scopedResume, scopedContext);
      let rejectedCrossRoleEvidence = false;
      try {
        const invalid = structuredClone(scopedResume);
        invalid.roles[0].bullets[0].evidenceIds = ['horizon-proof'];
        renderStructuredApplicationResume(invalid, scopedContext);
      } catch { rejectedCrossRoleEvidence = true; }
      let rejectedMixedCareerEvidence = false;
      try {
        const invalid = structuredClone(scopedResume);
        invalid.roles[0].bullets[0].evidenceIds = ['thomson-proof', 'horizon-proof', 'job-need'];
        renderStructuredApplicationResume(invalid, scopedContext);
      } catch { rejectedMixedCareerEvidence = true; }
      let rejectedCrossRoleLocation = false;
      try {
        const invalid = structuredClone(scopedResume);
        invalid.roles[0].location = 'Denver, Colorado';
        renderStructuredApplicationResume(invalid, scopedContext);
      } catch { rejectedCrossRoleLocation = true; }
      assert(html.includes('Loveland, Colorado') && rejectedCrossRoleEvidence && rejectedMixedCareerEvidence && rejectedCrossRoleLocation,
        'plain title-and-employer career sections bind each role to its own evidence and constrain blank trusted-role locations to that section');
      return { rejectedCrossRoleEvidence, rejectedMixedCareerEvidence, rejectedCrossRoleLocation };
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
      value.careerData = 'Ada Lovelace\nada@example.test\nSoftware Engineer\nBuilt reporting\n systems that reduced manual work.';
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
        careerData: 'Ada Lovelace\nada@example.test\n# Personal Projects\n## Dashboards\n- Analytics reporting dashboards\nBuilt analytics reporting dashboards that reduced manual work.\n# Skills\nGoogle',
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
      assert(html.includes('Analytics reporting') && html.includes('Personal Projects') && rejectedListingOnlyProject && rejectedShortSubstringSkill,
        'project display copy retains its source provenance heading, while neutral editorial headings remain usable and listing-only or substring-only evidence is rejected');
      return { projectRendered: true, rejectedListingOnlyProject, rejectedShortSubstringSkill };
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
      const rejection = (resume) => {
        try { renderStructuredApplicationResume(resume, batchContext); return ''; } catch (error) { return String(error?.message || error); }
      };

      // The measured chain this replaces: three invented group labels cost
      // three sequential manual copy/paste handoff rounds, one per offender.
      const groupNames = ['Bespoke Wizardry', 'Rockstar Ninja Skills', 'World-Class Mastery'];
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
        skills: Array.from({ length: 20 }, (unused, index) => ({ id: `skills-${index}`, group: `Invented Specialty ${index}`, items: ['JavaScript'], evidenceIds: ['career-proof'] })),
      });
      assert(/and \d+ more/u.test(manyBadGroups) && manyBadGroups.length < 2_000 && !manyBadGroups.includes('Invented Specialty 19'),
        'a collection full of offenders reports a bounded list plus a count of the remainder');
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
      });
      const rejection = (resume) => {
        try { renderStructuredApplicationResume(resume, context); return ''; } catch (error) { return String(error?.message || error); }
      };

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
      const collectionsMessage = rejection(acrossCollections);
      assert(collectionsMessage.includes('roles[1].bullets[0]') && collectionsMessage.includes('"ghost"')
        && collectionsMessage.includes('projects.p1.name') && collectionsMessage.includes('"Haskell"') && collectionsMessage.includes('"Bespoke Wizardry"'),
      `a bullet, a project, a skill item and a skill group defect are reported in one rejection (got ${collectionsMessage})`);

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
        && longOffendersMessage.length < 1_000,
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
        fuzzed.skills = [{ id: 's1', group: 'Tools', items: ['pipeline'], evidenceIds: ['e1'] }];
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
      const cleanCareerData = 'Ada Lovelace\nada@example.test\nEngineer\nBuilt supported systems.\nA concise factual letter.';
      const sourceRoles = [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '' }];
      const paragraphs = ['A concise factual letter.'];
      const audit = {
        version: LOCAL_AI_GENERATION_AUDIT_VERSION,
        jobPriorities: [{ requirement: 'Reliable supported systems', priority: 'highest', disposition: 'addressed-both', justification: 'The selected supported-systems evidence directly addresses the stated delivery requirement.' }],
        resumePlan: { strategy: 'Lead with the strongest supported systems evidence for the role.', selectionRationale: 'The retained role preserves direct factual support and concise relevance.' },
        coverLetterPlan: { controllingThesis: 'Reliable system delivery is the supported capability this engineering role needs.', paragraphs: [{ paragraph: paragraphs[0], argumentativeJob: 'Establish the controlling evidence-to-need connection.', relationToThesis: 'Connect the source-supported proof to reliable system delivery.', relationToPreviousParagraph: 'opening', sentences: [{ sentence: paragraphs[0], function: 'Establishes this paragraph’s argumentative direction.', relationToPreviousSentence: 'opening' }] }] },
        finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
      };
      const criteria = APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement }));
      const result = assemblePasteApplicationResult({
        input: { version: 1, jobId: '123e4567-e89b-42d3-a456-426614174000', sourceRoles, qualityChecklist: { version: APPLICATION_QUALITY_CHECKLIST_VERSION }, generationAudit: { version: LOCAL_AI_GENERATION_AUDIT_VERSION, required: true }, job: { title: 'Engineer', company: 'Acme' } },
        careerData: cleanCareerData,
        jobListing: 'Engineer role focused on reliable supported systems.',
        paste: {
          trustedIdentity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer', credential: '' },
          evidencePlan: { evidence: [{ id: 'resume-proof', sourceId: 'career-data', quote: 'Built supported systems.' }, { id: 'letter-proof', sourceId: 'career-data', quote: 'A concise factual letter.' }] },
          resume: { schemaVersion: 'structured-resume.v1', identity: { name: 'Ada Lovelace', contact: ['ada@example.test'], subtitleRole: 'Engineer', credential: '' }, roles: [{ id: 'role-1', title: 'Engineer', company: 'Acme', dates: '', location: '', bullets: [{ id: 'bullet-1', text: 'Built supported systems.', evidenceIds: ['resume-proof'] }] }] },
          coverLetter: { name: 'Ada Lovelace', contact: ['ada@example.test'], paragraphs: [{ id: 'paragraph-1', text: paragraphs[0], evidenceIds: ['letter-proof'] }], roleThesis: audit.coverLetterPlan.controllingThesis, coverLetterArgument: { primaryEvidence: { evidence: 'Built supported systems.', evidenceRole: 'Engineer at Acme', relationToThesis: 'The systems work establishes the delivery capability named in the thesis.' } }, generationAudit: audit },
          finalReview: { decision: 'pass', findings: [], checklist: APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents.` })), qualityReview: { checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, criteria, resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' }, coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' } }, generationAudit: audit },
        },
      });
      const validated = validateLocalApplicationResult(result, result.jobId, '/tmp', { title: 'Engineer', company: 'Acme' }, { careerData: cleanCareerData, evidencePlan: null, qualityChecklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION, generationAuditVersion: LOCAL_AI_GENERATION_AUDIT_VERSION });
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
          assemblePasteApplicationResult(fixture({}, { careerData: `${careerData.split('\n').slice(0, 3).join('\n')}\nBuilt reporting systems\nthat reduced manual work.` }));
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
        ['the job input has no trusted roles', 'input record', () => fixture({}, { input: { version: 1, jobId: 'job-1', sourceRoles: [] } })],
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
    name: 'Frozen state the queue writes is accepted by the grader that ends the job',
    async run() {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'paste-frozen-source-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
      // Every value below is one the QUEUE accepts: a corpus past the ceiling
      // this module grades against, a DEL in both frozen sources, and saved
      // role text past the renderer's short-text ceiling. Each one used to
      // reach assembly as a job-integrity fault whose only named action —
      // press Generate — rebuilt the same files through the same writer and
      // reproduced it, turning a correction round into a four-handoff loop.
      const del = String.fromCharCode(127);
      const oversizedCorpus = `${careerData}\nArchive note${del} retained.\n${'Maintained the reporting corpus. '.repeat(9_000)}`;
      const queued = await queueLocalApplicationJob({
        transport: 'paste',
        canvasFilePath,
        careerData: oversizedCorpus,
        job: { title: 'Reporting Engineer', company: 'Acme Reporting', snippet: `Build reliable reporting systems.\nShift${del} coverage.` },
        resumeProfile: { workHistory: [{
          id: 'role-1',
          title: `Software Engineer ${'and platform reliability specialist '.repeat(12)}`,
          employer: `Analytical Engines ${'worldwide holdings '.repeat(20)}`,
          startDate: '2020', endDate: '2024',
        }] },
      });
      // Read back exactly as the completion submit hands them over.
      const frozenInput = JSON.parse(await fs.promises.readFile(path.join(queued.folder, 'input.json'), 'utf8'));
      const frozenCareerData = await fs.promises.readFile(path.join(queued.folder, 'context', 'career-data.txt'), 'utf8');
      const frozenJobListing = await fs.promises.readFile(path.join(queued.folder, 'context', 'job-listing.md'), 'utf8');
      const frozenRole = frozenInput.sourceRoles[0];
      assert(oversizedCorpus.length > MAX_FROZEN_SOURCE_CHARS && frozenCareerData.length === MAX_FROZEN_SOURCE_CHARS,
        `the queue writes a frozen source at the same ceiling this module grades it against (${frozenCareerData.length} of ${MAX_FROZEN_SOURCE_CHARS})`);
      assert(frozenRole.title.length === STRUCTURED_RESUME_LIMITS.chars.shortText
        && frozenRole.company.length === STRUCTURED_RESUME_LIMITS.chars.shortText,
      `the queue writes role short text at the renderer's own ceiling (${frozenRole.title.length}/${frozenRole.company.length} of ${STRUCTURED_RESUME_LIMITS.chars.shortText})`);
      assert(!`${frozenCareerData}${frozenJobListing}`.includes(del),
        'the queue writes neither frozen source with a character its grader rejects');

      let rejection = null;
      try {
        assemblePasteApplicationResult(fixture(
          { resume: { ...fixture().paste.resume, roles: [{ ...fixture().paste.resume.roles[0], ...frozenRole }] } },
          { input: frozenInput, careerData: frozenCareerData, jobListing: frozenJobListing },
        ));
      } catch (error) {
        rejection = error;
      }
      assert(!rejection,
        `queue-written frozen state assembles instead of ending the job: ${rejection?.message || ''}`);
      return { frozenChars: frozenCareerData.length, roleChars: frozenRole.title.length };
    },
  },
];
