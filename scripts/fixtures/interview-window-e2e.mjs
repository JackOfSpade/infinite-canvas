/** Synthetic, public-safe approved-profile projection. Never reads a private store. */
import crypto from 'node:crypto';
import {
  answerBankRecordId,
  buildInterviewAnswerEvidence,
  INTERVIEW_ANSWER_QUESTION_CATALOG,
  interviewAnswerBankApplicationDigest,
  validateInterviewAnswerBank,
} from '../../electron/ipc/interviewAnswerBank.js';
import { interviewPreparedBriefRecordId } from '../../electron/ipc/interviewPreparation.js';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const ROLE_ROWS = [
  ['northstar', 'Senior Product Manager', 'Northstar Cloud', '2023-02', 'present'],
  ['harbour', 'Technical Product Manager', 'Harbour Health', '2020-05', '2023-01'],
  ['maple', 'Product Manager', 'Maple Market', '2018-03', '2020-04'],
  ['signal', 'Senior Data Analyst', 'Signal Freight', '2016-07', '2018-02'],
  ['bright', 'Business Analyst', 'Bright Ledger', '2014-06', '2016-06'],
  ['civic', 'Operations Analyst', 'Civic Path', '2012-09', '2014-05'],
];

const ACHIEVEMENT_ROWS = [
  ['northstar', 'onboarding', 'I led onboarding discovery that raised activation from 54% to 68%.'],
  ['northstar', 'onboarding-research', 'I interviewed 18 new administrators and tested a guided setup with 120 trial accounts.'],
  ['northstar', 'onboarding-result', 'The guided setup cut median time to first workspace from 43 to 26 minutes.'],
  ['northstar', 'prioritization', 'I ranked 23 requests by customer impact, effort and delivery risk before choosing three quarterly bets.'],
  ['northstar', 'leadership', 'I coached four product managers through weekly problem reviews and improved on-time discovery delivery from 61% to 86%.'],
  ['northstar', 'failure', 'I stopped a pricing experiment after a 4% conversion decline and restored the previous offer within one day.'],
  ['harbour', 'api', 'I led an API reliability programme that reduced failed appointment bookings by 38%.'],
  ['harbour', 'api-diagnosis', 'I paired with two engineers to trace retry storms across 14 services and agree an idempotency contract.'],
  ['harbour', 'api-rollout', 'We released the booking changes to 5%, 25% and then 100% of traffic with a rollback threshold.'],
  ['harbour', 'pressure', 'I coordinated a six-person response to a booking outage and restored service in 47 minutes.'],
  ['harbour', 'pressure-update', 'I sent status updates every 15 minutes while engineering owned diagnosis and recovery.'],
  ['harbour', 'delivery', 'I introduced weekly release reviews that reduced late integration surprises from nine to three per quarter.'],
  ['maple', 'conflict', 'I resolved a sales and engineering disagreement over checkout scope and protected a six-week launch date.'],
  ['maple', 'conflict-action', 'I put both teams in front of eight customer interviews and documented the scope tradeoff in one decision log.'],
  ['maple', 'conflict-result', 'The smaller checkout release increased completed purchases by 11% without adding payment incidents.'],
  ['maple', 'collaboration', 'I aligned design, support and engineering around one checkout metric across three teams.'],
  ['maple', 'decision', 'I chose payment retry fixes over a new loyalty feature after comparing 2,400 failed checkout sessions.'],
  ['maple', 'decision-result', 'The payment retry changes recovered 7% of failed purchases in the first month.'],
  ['signal', 'kafka', 'I reduced Kafka consumer lag from 18 minutes to 40 seconds by replacing a serial export with partitioned workers.'],
  ['signal', 'kafka-validation', 'I replayed 2.6 million synthetic shipment events and checked ordering and duplicate handling before rollout.'],
  ['signal', 'forecast', 'I built a SQL forecast model that improved weekly shipment accuracy from 72% to 89%.'],
  ['signal', 'process', 'I automated a daily reporting process and saved the operations team 12 hours each week.'],
  ['signal', 'process-check', 'I reconciled 30 days of automated reports against the manual ledger before retiring the spreadsheet.'],
  ['signal', 'quality', 'I added 24 data quality checks and reduced missing shipment identifiers by 63%.'],
  ['bright', 'discovery', 'I interviewed 22 small-business owners to understand their month-end reconciliation problems.'],
  ['bright', 'discovery-result', 'I tested reconciliation prototypes with nine owners and reduced the median task time by 31%.'],
  ['bright', 'adoption', 'I supported a reconciliation launch used by 640 businesses in its first quarter.'],
  ['bright', 'training', 'I created a training guide that reduced new analyst onboarding from 15 to 10 working days.'],
  ['bright', 'reporting', 'I replaced five competing revenue definitions with one reviewed metric used by finance and sales.'],
  ['bright', 'learning', 'I changed my interview guide after three owners struggled with leading questions and completed 19 neutral interviews.'],
  ['civic', 'routing', 'I analysed 8,000 service requests and helped reduce duplicate routing by 21%.'],
  ['civic', 'service', 'I built a service dashboard that cut weekly reporting time from six hours to 90 minutes.'],
  ['civic', 'support', 'I rewrote 16 support templates and reduced repeat clarification requests by 17%.'],
  ['civic', 'records', 'I reconciled 4,200 legacy records and improved valid contact coverage from 76% to 94%.'],
  ['civic', 'planning', 'I coordinated four volunteer teams to complete a community survey two weeks before its deadline.'],
  ['civic', 'survey', 'I summarized 570 survey responses into six service priorities approved by the programme lead.'],
];

const PROJECT_ROWS = [
  ['northstar', 'onboarding-project', 'Guided workspace setup', 'I led a designer, researcher and two engineers through six weeks of guided setup discovery and delivery.'],
  ['northstar', 'priorities-project', 'Quarterly investment review', 'I shared a one-page scorecard with sales and engineering, recorded assumptions and revisited the ranking every fortnight.'],
  ['northstar', 'leadership-project', 'Product coaching circle', 'I used real discovery plans in fortnightly coaching sessions and asked each product manager to explain the evidence behind a decision.'],
  ['northstar', 'failure-project', 'Pricing trial rollback', 'I reviewed the failed pricing trial with sales and support, documented the weak demand assumption and changed the next test to a smaller audience.'],
  ['harbour', 'api-project', 'Reliable appointment booking', 'I translated booking failure logs into an error budget and agreed safe retries, observability and release gates with engineering.'],
  ['harbour', 'pressure-project', 'Booking incident coordination', 'I kept the incident team focused on restoring bookings, separated customer communication from diagnosis and scheduled the follow-up review.'],
  ['maple', 'checkout-project', 'Checkout scope agreement', 'I compared a thin checkout release with a full redesign, made the risks visible and asked both teams to sign off on one success measure.'],
  ['maple', 'collaboration-project', 'Shared checkout delivery', 'I ran a weekly cross-functional review with design, support and engineering so customer issues shaped the next delivery decision.'],
  ['maple', 'decision-project', 'Payment retry investment', 'I compared expected recovered purchases, engineering effort and incident risk before proposing the retry work to the product director.'],
  ['signal', 'reporting-project', 'Daily reporting automation', 'I mapped the reporting handoffs, automated the repeatable SQL transformations and kept a manual reconciliation check during the first month.'],
  ['bright', 'discovery-project', 'Month-end reconciliation discovery', 'I asked owners to show their actual month-end work, compared observed workarounds and tested prototypes before writing delivery requirements.'],
];

const SPOKEN_CARD_ROWS = [
  ['intro', 0, 'northstar', 'I lead onboarding discovery and coach product managers through practical customer workflow work.', 'I now lead onboarding discovery and coach product managers at Northstar Cloud.', 'My product management background includes analytics and reliable customer workflows.'],
  ['relevant', 1, 'northstar', 'I led onboarding discovery and raised activation through guided workspace setup.', 'I interviewed 18 new administrators and tested setup with trial accounts.', 'The guided setup cut median workspace time from 43 to 26 minutes.'],
  ['why-role', 2, 'northstar', 'I want to combine customer discovery with technically reliable product delivery.', 'I led onboarding discovery and tested a guided setup with administrators.', 'The guided setup raised activation from 54% to 68% during delivery.'],
  ['why-company', 3, 'northstar', 'I want to help small teams remove administrative work through reliable workflows.', 'I tested self-service setup prototypes with small teams before reviewing delivery decisions.', 'I reviewed onboarding discovery plans with administrators before testing guided setup.'],
  ['project', 4, 'northstar', 'I led guided setup discovery and delivery with designers and engineers.', 'I led a designer, researcher and two engineers through six weeks of delivery.', 'I reviewed workspace setup prototypes with the designer before delivery.'],
  ['challenge', 5, 'harbour', 'I led a reliability programme that reduced failed appointment bookings by 38%.', 'I paired with two engineers to trace retry storms across 14 services.', 'We released booking changes gradually with traffic controls and a rollback threshold.'],
  ['priorities', 6, 'northstar', 'I ranked requests by customer impact, effort and delivery risk before choosing work.', 'I ranked 23 requests before choosing three quarterly bets for delivery.', 'I shared a scorecard, recorded assumptions and revisited the ranking every fortnight.'],
  ['collaboration', 7, 'maple', 'I aligned design, support and engineering around a shared checkout metric.', 'I ran weekly reviews with design, support and engineering around customer issues.', 'I put teams in front of customer interviews and documented scope tradeoffs.'],
  ['conflict', 8, 'maple', 'I resolved a sales and engineering disagreement while protecting the checkout launch.', 'I put both teams in front of eight customer interviews.', 'I documented the scope tradeoff in one decision log for both teams.'],
  ['leadership', 9, 'northstar', 'I coached product managers through weekly problem reviews and practical discovery plans.', 'I coached four product managers and improved on-time discovery delivery from 61% to 86%.', 'I asked each product manager to explain the evidence behind a decision.'],
  ['technical', 10, 'harbour', 'I traced retry storms with engineers and agreed an idempotency contract.', 'I checked retry ordering with two engineers before agreeing the idempotency contract.', 'I translated booking failure logs into an error budget and safe retries.'],
  ['process', 11, 'signal', 'I automated daily reporting and saved the operations team twelve hours weekly.', 'I mapped reporting handoffs and automated repeatable SQL transformations for daily reports.', 'I reconciled automated reports against the manual ledger before retiring the spreadsheet.'],
  ['pressure', 12, 'harbour', 'I coordinated a booking outage response and restored service within 47 minutes.', 'I sent status updates every 15 minutes while engineering owned diagnosis.', 'I kept the incident team focused on restoring bookings and scheduled follow-up.'],
  ['decision', 13, 'maple', 'I chose payment retry fixes after comparing failed checkout sessions and effort.', 'I compared expected recovered purchases, engineering effort and incident risk.', 'The payment retry changes recovered 7% of failed purchases in the first month.'],
  ['customer', 16, 'bright', 'I interviewed small business owners to understand their month end reconciliation problems.', 'I asked owners to show their actual work and compared observed workarounds.', 'I tested reconciliation prototypes with owners before writing delivery requirements.'],
  ['failure', 18, 'northstar', 'I stopped a pricing experiment after conversion declined and restored the previous offer.', 'I reviewed the failed trial after a 4% conversion decline with sales.', 'I changed the next pricing test to a smaller audience after review.'],
];

/** Independent expectations describe the desired candidate outcome, including misses. */
export const interviewWindowE2EScenarios = Object.freeze([
  { id: 'intro', question: 'Tell me about yourself.', expectedKind: 'card', expectedCardId: 'intro' },
  { id: 'why-role', question: 'Why are you interested in this role?', expectedKind: 'card', expectedCardId: 'why-role' },
  { id: 'why-company', question: 'Why do you want to work here?', expectedKind: 'card', expectedCardId: 'why-company' },
  { id: 'relevant', question: 'Which experience is most relevant to this role?', expectedKind: 'card', expectedCardId: 'relevant' },
  { id: 'project', question: 'Tell me about a project you worked on.', expectedKind: 'card', expectedCardId: 'project' },
  { id: 'challenge', question: 'Describe a challenge you faced.', expectedKind: 'card', expectedCardId: 'challenge' },
  { id: 'priorities', question: 'How do you prioritize your work?', expectedKind: 'card', expectedCardId: 'priorities' },
  { id: 'collaboration', question: 'Tell me about working with stakeholders.', expectedKind: 'card', expectedCardId: 'collaboration' },
  { id: 'conflict', question: 'Describe a time you faced pushback.', expectedKind: 'card', expectedCardId: 'conflict' },
  { id: 'leadership', question: 'Tell me about leading a team.', expectedKind: 'card', expectedCardId: 'leadership' },
  { id: 'technical', question: 'Walk me through a technical problem.', expectedKind: 'card', expectedCardId: 'technical' },
  { id: 'process', question: 'Describe a process improvement.', expectedKind: 'card', expectedCardId: 'process' },
  { id: 'pressure', question: 'Tell me about a tight deadline.', expectedKind: 'card', expectedCardId: 'pressure' },
  { id: 'decision', question: 'Describe a tradeoff you considered.', expectedKind: 'card', expectedCardId: 'decision' },
  { id: 'customer', question: 'How do you understand customer needs?', expectedKind: 'card', expectedCardId: 'customer' },
  { id: 'failure', question: 'Tell me about a mistake or failure.', expectedKind: 'card', expectedCardId: 'failure' },
  { id: 'typo', question: 'Tell me about leadng a team.', expectedKind: 'card', expectedCardId: 'leadership' },
  { id: 'paraphrase-priorities', question: 'How do you prioritise your work?', expectedKind: 'card', expectedCardId: 'priorities' },
  { id: 'paraphrase-pressure', question: 'How do you handle working under pressure?', expectedKind: 'card', expectedCardId: 'pressure' },
  { id: 'paraphrase-intro', question: 'Could you briefly walk me through your background?', expectedKind: 'card', expectedCardId: 'intro' },
  { id: 'cue-kafka', question: 'How did you reduce Kafka consumer lag?', expectedKind: 'cue', expectedCardId: null },
  { id: 'follow-up', question: 'What was the result?', expectedKind: 'cue', expectedCardId: null, followUp: true },
  { id: 'multipart', question: 'How did you reduce Kafka consumer lag, and what did you learn from that work?', expectedKind: 'cue', expectedCardId: null },
  { id: 'salary', question: 'What are your salary expectations?', expectedKind: 'abstain', expectedCardId: null },
  { id: 'notice', question: 'What is your notice period?', expectedKind: 'abstain', expectedCardId: null },
  { id: 'unrelated', question: 'What telescope aperture would you choose for photographing Jupiter?', expectedKind: 'abstain', expectedCardId: null },
  { id: 'changed-anchor', question: 'How did you handle disagreement at RivalCo?', expectedKind: 'abstain', expectedCardId: null },
].map(item => Object.freeze({ followUp: false, ...item })));

export function createInterviewWindowE2EFixture() {
  const canonicalJobUrl = 'https://careers.cedarflow.example.test/jobs/senior-product-manager';
  const snapshotId = sha('synthetic-interview-e2e-approved-profile-2026-10-30');
  const roles = ROLE_ROWS.map(([id, title, employer, startDate, endDate]) => ({ id, title, employer, startDate, endDate }));
  const achievements = ACHIEVEMENT_ROWS.map(([roleId, id, claim], index) => ({ id, roleId, claim, evidenceSegmentIds: [`segment-${String(index + 1).padStart(4, '0')}`] }));
  const projects = PROJECT_ROWS.map(([roleId, id, name, description], index) => ({ id, roleId, name, description, evidenceSegmentIds: [`segment-${String(index + 37).padStart(4, '0')}`] }));
  const otherEvidence = [
    { id: 'intro-earlier', roleId: 'harbour', label: 'Earlier role', text: 'Earlier, I led an API reliability programme that reduced failed appointment bookings by 38%.' },
    { id: 'intro-summary', roleId: 'northstar', label: 'Career introduction', text: 'I am a product manager with a background in analytics and reliable customer workflows.' },
    { id: 'intro-focus', roleId: 'northstar', label: 'Current focus', text: 'I now lead onboarding discovery and coach product managers at Northstar Cloud.' },
    { id: 'role-interest', roleId: 'northstar', label: 'Role motivation', text: 'I want to keep combining customer discovery with technically reliable product delivery.' },
    { id: 'company-interest', roleId: 'northstar', label: 'Company motivation', text: 'I am interested in helping small teams remove time-consuming administrative work.' },
  ].map((item, index) => ({ ...item, evidenceSegmentIds: [`segment-${String(index + 48).padStart(4, '0')}`] }));
  otherEvidence.push(...SPOKEN_CARD_ROWS.map(([id, , roleId, headline, first, second], index) => ({ id: `spoken-${id}`, roleId, label: 'Synthetic spoken evidence', text: [headline, first, second, 'I documented delivery decisions in a shared team review guide.'].join(' '), evidenceSegmentIds: [`segment-${String(index + 52).padStart(4, '0')}`] })));
  const snapshot = { snapshotId, profile: { roles, achievements, projects,
    skills: [{ id: 'sql', name: 'SQL' }, { id: 'discovery', name: 'Product discovery' }, { id: 'experimentation', name: 'Experiment design' }],
    education: [{ id: 'degree', credential: 'BSc Information Systems', institution: 'Lakeview University' }],
    certifications: [], otherEvidence } };
  const resume = roles.map(role => [role.title, role.employer,
    ...achievements.filter(item => item.roleId === role.id).map(item => item.claim),
    ...projects.filter(item => item.roleId === role.id).map(item => item.description)].join(' ')).join('\n\n');
  const bundle = {
    artifactId: sha('synthetic-e2e-captured-application'),
    job: { title: 'Senior Product Manager', company: 'CedarFlow', location: 'Toronto / hybrid' },
    listingText: 'CedarFlow seeks a Senior Product Manager to lead self-service onboarding for small business teams, partner with engineering on reliable workflows, and measure activation and retention.',
    applicationPositioning: { resume, coverLetter: 'I am interested in CedarFlow because its self-service mission connects customer research, practical workflow design and reliable delivery. My recent work has focused on onboarding activation.' },
    digests: { applicationHtml: sha(resume), originalJobListing: sha('synthetic-CedarFlow-listing') },
  };
  const applicationArtifactDigest = interviewAnswerBankApplicationDigest(bundle);
  bundle.applicationArtifactDigest = applicationArtifactDigest;
  const fact = (text, url, sourceDate = '2026-10-20') => ({ fact: text, sourceId: sha(url).slice(0, 16), sourceUrl: url, sourceDate });
  const companyFacts = [
    fact('CedarFlow provides self-service workflow software for small business teams.', 'https://cedarflow.example.test/about'),
    fact('CedarFlow names faster customer setup and dependable integrations as product priorities.', 'https://cedarflow.example.test/product'),
  ];
  const recentContext = [fact('CedarFlow announced a guided setup pilot for new customer teams.', 'https://cedarflow.example.test/news/guided-setup', '2026-09-15')];
  const semantic = {
    version: 1, inputs: { careerSnapshotId: snapshotId, jobUrlSha256: sha(canonicalJobUrl), applicationArtifactId: bundle.artifactId, applicationArtifactDigest },
    role: { title: bundle.job.title, company: bundle.job.company, location: bundle.job.location, summary: 'Lead self-service onboarding, customer discovery and reliable workflow delivery for small business teams.' },
    roleThemes: ['Self-service onboarding and activation', 'Customer discovery', 'Technical reliability', 'Cross-functional product leadership'],
    companyFacts, recentContext,
    likelyQuestions: ['Tell me about yourself.', 'How do you understand customer needs?', 'How do you prioritize your work?', 'Walk me through a technical problem.', 'How do you handle disagreement?', 'Tell me about something that did not go as planned.'],
    questionsToAsk: ['Where do new teams encounter the most friction during setup?', 'How do product and engineering agree reliability investments?', 'What would success look like after six months?'],
    applicationPositioning: [{ documentKind: 'resume', point: achievements[0].claim }, { documentKind: 'resume', point: achievements[6].claim }, { documentKind: 'coverLetter', point: bundle.applicationPositioning.coverLetter }],
    warnings: ['Synthetic research fixture. Public example domains are not live company research.'],
  };
  const brief = { ...semantic, briefId: sha(stable(semantic)), createdAt: '2026-10-30T13:00:00.000Z',
    sources: [...companyFacts, ...recentContext].map(({ sourceId, sourceUrl, sourceDate }) => ({ sourceId, sourceUrl, sourceDate })) };
  const context = { snapshot, brief, bundle, canonicalJobUrl, bundleArtifactId: bundle.artifactId };
  const evidence = buildInterviewAnswerEvidence(context);
  const byEntity = id => {
    const item = evidence.find(candidate => candidate.entityId === id);
    if (!item) throw new Error(`Synthetic interview fixture is missing evidence ${id}`);
    return item;
  };
  const statement = (item, text) => ({ text, evidenceIds: [item.id], quotes: [{ evidenceId: item.id, quote: item.text }] });
  const response = { cards: SPOKEN_CARD_ROWS.map(([id, catalogIndex, , headline, first, second]) => {
    const source = byEntity(`spoken-${id}`);
    return {
      id, question: INTERVIEW_ANSWER_QUESTION_CATALOG[catalogIndex].question,
      variants: [...INTERVIEW_ANSWER_QUESTION_CATALOG[catalogIndex].variants], thinEvidence: true,
      headline: statement(source, headline), bullets: [first, second].map(text => ({ stage: 'point', ...statement(source, text) })),
      example: statement(source, 'I documented delivery decisions in a shared team review guide.'), extensions: [], consistency: { consistentWithResume: false, resumeQuote: '' },
    };
  }) };
  const intro = response.cards.find(card => card.id === 'intro');
  intro.bullets = [
    { stage: 'point', ...statement(byEntity('intro-earlier'), 'Earlier, I led an API reliability programme that reduced failed appointment bookings by 38%.') },
    { stage: 'point', ...statement(evidence.find(item => item.kind === 'research'), 'This role interests me because CedarFlow provides self-service workflow software for small business teams.') },
  ];
  const whyResearch = evidence.find(item => item.kind === 'research' && item.text === companyFacts[0].fact);
  for (const [id, subject] of [['why-role', 'role'], ['why-company', 'company']]) {
    response.cards.find(card => card.id === id).headline = statement(whyResearch,
      `This ${subject} interests me because ${companyFacts[0].fact}`);
  }
  response.cards.find(card => card.id === 'leadership').extensions = [
    { id: 'leadership-coaching-plans', ...statement(byEntity('leadership-project'), 'I used real discovery plans in fortnightly coaching sessions.') },
    { id: 'leadership-shared-scorecard', ...statement(byEntity('priorities-project'), 'I shared a one-page scorecard with sales and engineering.') },
  ];
  const bank = validateInterviewAnswerBank(response, context);
  return { ...context, bank, briefRecordId: interviewPreparedBriefRecordId(brief),
    answerBankRecordId: answerBankRecordId(bank), questions: interviewWindowE2EScenarios };
}
