import { assert } from './testHelpers.js';
import { interviewQuestionFit, interviewEvidenceRank, interviewWhyCardFailures, interviewResearchInterestText } from '../../electron/ipc/interviewQuestionFit.js';

const career = (id, text) => ({ id, kind: 'career', text });
const fits = (question, speech, evidence = speech) => interviewQuestionFit(question, speech, [career('evidence', evidence)]);

export default [
  {
    name: 'interview question fit: a decimal effect counts as an effect',
    run() {
      assert(fits('Tell me about a result from your work.', 'I saved 1.5 hours per week.'), 'a decimal effect is an effect');
      assert(fits('Tell me about improving a process.', 'I moved deploys from manual scripts to a CI pipeline, which I built.'), 'a real from/to change still fits');
    },
  },
  {
    name: 'interview question fit: why headlines prefer research and thin cards retain research bullets',
    run() {
      // Sanitized v4 shape: the old combined-speech check accepted a career
      // headline because an interest frame appeared in a later research bullet.
      const evidence = [
        career('career-web', 'Built a full-stack web app for internal tools.'),
        career('career-api', 'Built APIs for controlled access to a records database.'),
        { id: 'research-role', kind: 'research', text: 'End-to-end delivery with Product and Design.' },
        { id: 'research-company', kind: 'research', text: 'Example Company keeps its core product free to use.' },
      ];
      const line = (text, ...evidenceIds) => ({ text, evidenceIds });
      const v4Role = {
        question: 'Why are you interested in this role?', thinEvidence: true,
        headline: line('I built a full-stack web app for the internal tools team.', 'career-web'),
        bullets: [line('This role interests me because of end-to-end delivery with Product and Design.', 'research-role'), line('I built APIs for controlled access to the records database.', 'career-api')],
      };
      assert(interviewQuestionFit(v4Role.question, [v4Role.headline, ...v4Role.bullets].map(item => item.text).join(' '), evidence), 'the earlier combined-speech shape explains the v4 escape');
      const failures = interviewWhyCardFailures(v4Role, evidence);
      assert(failures.length === 0, 'a thin why fallback keeps its separately cited research bullet');
      const preferredFailures = interviewWhyCardFailures({ ...v4Role, thinEvidence: false }, evidence);
      assert(preferredFailures.some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_RESEARCH'), 'a full why card still leads with research');
      assert(preferredFailures.some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_REASON'), 'a full headline itself answers why');
      assert(preferredFailures.some(item => item.rule === 'INTERVIEW_ANSWER_WHY_CAREER_CONNECTION'), 'full career connections follow the reason');
      const fixedRole = { ...v4Role, thinEvidence: false,
        headline: line('This role interests me because of end-to-end delivery with Product and Design.', 'research-role'),
        bullets: [line('I built a full-stack web app for internal tools.', 'career-web'), line('I built APIs for controlled access to a records database.', 'career-api')],
      };
      assert(interviewWhyCardFailures(fixedRole, evidence).length === 0, 'research-led reason plus two own facts is expressible');
      const company = { ...fixedRole, question: 'Why are you interested in this company?',
        headline: line('Example Company keeps its core product free for everyone to use.', 'research-company') };
      assert(interviewWhyCardFailures(company, evidence).length === 0, 'company reason can use a third-person researched fact');
      assert(interviewQuestionFit(company.question, [company.headline, ...company.bullets].map(item => item.text).join(' '), evidence), 'career connection subjects do not block a third-person company headline');
      company.headline = line('This company interests me because its core product is free to use.', 'research-company');
      assert(interviewWhyCardFailures(company, evidence).length === 0, 'company has a bounded interest frame too');
      company.headline.evidenceIds.push('career-web');
      assert(interviewWhyCardFailures(company, evidence).some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_RESEARCH'), 'mixed headline citations cannot smuggle candidate facts into the reason');
      assert(interviewResearchInterestText('This company interests me because its core product is free.') === 'its core product is free.', 'only bounded frame is removed before entailment');
      assert(interviewResearchInterestText('I want this role because I have built apps.') === undefined, 'unsupported personal assertions do not receive the interest exception');
      const inventedConnection = { ...fixedRole, headline: line('This role interests me because I already lead Product and Design.', 'research-role') };
      assert(interviewWhyCardFailures(inventedConnection, evidence).some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_REASON'), 'the reason frame cannot include candidate experience');
      const malformed = { ...fixedRole, headline: { text: fixedRole.headline.text, evidenceIds: 'research-role' }, bullets: [{ evidenceIds: null }] };
      assert(interviewWhyCardFailures(malformed, evidence).some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_RESEARCH'), 'malformed citation fields collect failures instead of escaping validation through a type error');
      assert(interviewWhyCardFailures({ ...fixedRole, question: 'Why are you interested in this company?', headline: { text: 7, evidenceIds: ['research-company'] } }, evidence)
        .some(item => item.rule === 'INTERVIEW_ANSWER_WHY_HEADLINE_REASON'), 'a non-string headline collects a reason failure without throwing');
    },
  },
  {
    name: 'interview question fit: v3 deliverables do not establish behavioral shape',
    run() {
      assert(!fits('How do you collaborate with others?', 'We co-built integrations with another engineer.'), 'co-built label has no contribution split');
      assert(!fits('How do you collaborate with others?', 'Some integrations I built solo, others we co-built with another engineer.'), 'mixed ownership alone does not say who did what');
      assert(!fits('Tell me about a result from your work.', 'I implemented an algorithm that shipped in the planning app.'), 'shipment alone is not a result');
      assert(!fits('Tell me about a result from your work.', 'We migrated data over three months.'), 'duration is not an outcome');
      assert(!fits('Tell me about a result from your work.', 'I improved the inherited ticketing system.'), 'vague improvement is a deliverable without an effect');
      assert(!fits('Tell me about a result from your work.', 'I improved the system to reduce errors.'), 'a purpose clause does not establish an achieved effect');
      assert(!fits('Tell me about a result from your work.', 'I planned a migration without downtime.'), 'a planned availability target is not an achieved effect');
      assert(!fits('Tell me about a result from your work.', 'I eliminated ongoing costs.', 'We migrated the system to eliminate ongoing costs.'), 'an intended cost reduction is not an achieved result');
      assert(!fits('How do you prioritize your work?', 'In personal projects I delegate implementation across models by cost and quality.'), 'model allocation does not establish competing work priorities');
      assert(!fits('Tell me about improving a process.', 'I maintained daily cron jobs that sync external data.'), 'deliverable has no before/after change');
      assert(!fits('How do you understand customer needs?', 'I built separate dashboards for users and management.'), 'audience names do not establish discovery');
      assert(!fits('How do you understand customer needs?', 'I built a customer feedback and requests dashboard.'), 'discovery nouns need an actual discovery action');
      assert(!fits('How do you collaborate with others?', 'I built a feedback dashboard for the engineering team.'), 'feedback noun does not establish reciprocal work');
      assert(!fits('Walk me through a decision.', 'I supported evaluation of products, comparing cost and tradeoffs.'), 'evaluation support does not establish an actual decision');
    },
  },
  {
    name: 'interview question fit: speech and evidence must both supply the asked shape',
    run() {
      assert(fits('How do you collaborate with others?', 'I implemented APIs while another engineer built the interface.'), 'documented contribution split fits collaboration');
      assert(fits('How do you collaborate with others?', 'We reviewed API changes together with product designers.'), 'reciprocal review method fits collaboration');
      assert(fits('Tell me about a result from your work.', 'Daily operations continued without interruption during the migration.'), 'documented operational outcome fits result');
      assert(fits('Tell me about a result from your work.', 'I reduced the error rate in data imports.'), 'a stated effect fits without inventing a metric');
      assert(fits('How do you prioritize your work?', 'I prioritized urgent tickets by customer impact and dependencies.'), 'work priority with criteria fits');
      assert(fits('Tell me about improving a process.', 'I replaced manual imports with scheduled data integrations.'), 'documented change fits process');
      assert(fits('How do you understand customer needs?', 'I interviewed users about their requirements before implementing the workflow.'), 'documented discovery action fits customer needs');
      assert(!fits('How do you understand customer needs?', 'I interviewed users about their requirements.', 'I built dashboards for users.'), 'speech cannot manufacture shape absent in evidence');
      assert(!fits('How do you understand customer needs?', 'I built dashboards for users.', 'I interviewed users about their requirements and built dashboards.'), 'unspoken evidence cannot establish spoken answer shape');
      assert(interviewQuestionFit('Why are you interested in this role?', 'This role interests me because it involves React interfaces.', [{ kind: 'research', text: 'The role involves React interfaces.' }]), 'bounded interest frame fits when its research citation is supplied');
    },
  },
  {
    name: 'interview question fit: listing-aware ranking restores frontend evidence over domain distractions',
    run() {
      const evidence = [
        career('medical', 'Built medical ETL pipelines and dashboards for therapists.'),
        career('flight', 'Implemented flight route optimization with external data integrations.'),
        career('frontend', 'Maintained React and TypeScript interfaces and client-server integrations.'),
      ];
      const ranked = interviewEvidenceRank('Walk me through a project.', evidence, ['Full-stack product development'], 'Build React and TypeScript consumer experiences with Product and Design, data integrations and performance.');
      assert(ranked[0].evidenceId === 'frontend', 'listing and role themes select relevant React/TypeScript evidence');
      assert(ranked.find(item => item.evidenceId === 'frontend').roleScore > ranked.find(item => item.evidenceId === 'medical').roleScore, 'role score reflects concrete job fit');
      const medicalJob = interviewEvidenceRank('Walk me through a project.', evidence, ['Medical data pipelines for therapists'], 'Medical ETL pipelines');
      assert(medicalJob[0].evidenceId === 'medical', 'domain penalty is conditional on the actual role');
      const problemRank = interviewEvidenceRank('Walk me through a technical problem.', [
        career('frontend', 'Built React TypeScript full-stack product integrations with data and performance tooling.'),
        career('actual-problem', 'Fixed patient query errors by testing the data imports.'),
      ], ['React TypeScript full-stack product integrations data performance tooling']);
      assert(problemRank[0].evidenceId === 'actual-problem', 'actual question shape ranks before keyword overlap');
    },
  },
];
