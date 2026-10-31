import crypto from 'node:crypto';
import { assert } from './testHelpers.js';
import {
  deriveInterviewCandorFlags,
  interviewBulletFailures,
  interviewClaimFailures,
  interviewClaimContent,
  interviewHeadlineFailures,
  interviewStandaloneFailures,
  interviewQuestionFit,
  interviewIntroRoleSummary,
  INTERVIEW_INTRO_ALLOWANCE_EXAMPLES,
} from '../../electron/ipc/interviewSpokenClaims.js';

// The three diagnosed before/after examples. Source text stays complete so
// every factual qualification can be checked, even when it is never spoken.
// Attribution is synthetic; these fixtures contain no employer identity.
const source = (name, text) => ({
  id: `career-${crypto.createHash('sha256').update(name).digest('hex')}`,
  kind: 'career', text, sourceLabel: 'Saved career evidence',
  candorFlags: deriveInterviewCandorFlags(text),
});
const ticketing = source('ticketing', 'Maintained and improved the in-house ticketing system I inherited (not originally built by me), including adding role-restricted access for internal staff. Improvements made together with the other engineer. Tech used: React, TypeScript. (The system was later retired in favor of a third-party platform.)');
const integrations = source('integrations', "Built data integrations and ETL between the district's core records platform (a third-party SaaS that serves as its system of record) and other third-party SaaS platforms that either consume its data or produce data that we ingest. A large number of integrations, run as a mix of scheduled and on-demand jobs; some built solo, others co-built with the other engineer. Tech used: Python.");
const migration = source('migration', "Near the end of my time there, migrated the district's in-house ticketing/repair-tracking and device check-in/check-out systems, with all of their historical data, to an all-in-one third-party IT service and asset management platform. Done with the other engineer over about 3 months, implementing the integrations, data migration workflows, automation, validation, and operational tooling the transition required. The in-house systems stayed in service until the new platform was fully set up for all staff, so day-to-day operations continued without interruption. The district made the move to eliminate the ongoing cost of maintaining these systems in-house.");
const routing = source('routing', "Implemented a modified A* algorithm that accounts for the curvature of the Earth for flight route optimization; it shipped in the company's flight planning app. (The team had already chosen the algorithm before I joined; my work was implementing it correctly and testing it.) Tech used: Python.");
const cron = source('cron', "Maintained cron jobs that sync the FAA's daily data releases through its APIs into our local database, including NOTAMs (Notices to Air Missions) so routing could steer around active warnings.");

const examples = [
  {
    name: 'collaboration', question: 'How do you collaborate with others?',
    before: ticketing.text,
    headline: 'I work closely with one other engineer, splitting solo and shared work.',
    headlineSources: [ticketing, integrations],
    bullets: [
      ['We improved the inherited ticketing system together, adding role-restricted staff access.', [ticketing]],
      ['Some integrations I built solo, others we co-built.', [integrations]],
    ],
  },
  {
    name: 'planning-delivery', question: 'How do you approach planning and delivery?',
    before: migration.text,
    headline: 'I migrated platforms over about three months with another engineer, without interrupting daily operations.',
    headlineSources: [migration],
    bullets: [
      ['We moved ticketing and device check-in systems, with historical data, to a third-party platform.', [migration]],
      ['The old systems stayed live until the new one was ready for all staff.', [migration]],
      ['The work covered integrations, data migration, validation and tooling.', [migration]],
    ],
  },
  {
    name: 'project-result', question: 'Tell me about a result from your work.',
    before: routing.text,
    headline: 'I implemented and tested a curvature-aware A* routing algorithm that shipped in a flight planning app.',
    headlineSources: [routing],
    bullets: [
      ['The team had already chosen the algorithm, so my job was implementing it correctly and testing it.', [routing]],
      ["I also maintained cron jobs syncing the FAA's daily data, including NOTAMs.", [cron]],
    ],
  },
];

function claim(text, sources) {
  return { text, evidenceIds: sources.map(item => item.id) };
}
function supported(text, sources, label) {
  const failures = interviewClaimFailures(claim(text, sources), sources);
  assert(failures.length === 0, `${label}: ${JSON.stringify(failures)}`);
}
function rejected(text, sources, label) {
  const failures = interviewClaimFailures(claim(text, sources), sources);
  assert(failures.length > 0, `${label} must reject`);
  assert(failures.every(item => typeof item.rule === 'string' && typeof item.instruction === 'string'), 'claim failures must support field-level delta correction');
  return failures;
}

export default [
  {
    name: 'interview spoken claims: contractions keep negation, scaled digits match number words, and plurals share stems',
    run() {
      for (const text of ['I didn’t build the billing service; I only maintained it.', "I didn't build the billing service; I only maintained it."]) {
        const denied = source(`denied-${text}`, text);
        assert(rejected('I built the billing service.', [denied], 'a contracted denial').some(item => item.rule === 'INTERVIEW_ANSWER_NEGATION'), 'a contracted negation is a limitation');
        supported("I didn't build the billing service; I only maintained it.", [denied], 'a faithful contracted claim');
      }
      const users = source('users', 'We reached two million users.');
      supported('We reached 2 million users.', [users], 'digits with a scale word equal number words');
      rejected('We reached 3 million users.', [users], 'a different scaled quantity');
      supported('I maintained the listing pages.', [source('listings', 'I maintained the listings pages.')], 'singular and plural share a stem');
    },
  },
  {
    name: 'interview spoken claims: explicit intro role summaries bind employer and title without borrowing project agency',
    run() {
      const first = { ...source('intro-summary-first', 'I maintained an inherited system with the other engineer. The system was later retired.'),
        roleId: 'role-first', roleContext: { title: 'Engineer', employer: 'Sample Works', endDate: 'June 2026' } };
      const earlier = { ...source('intro-summary-earlier', 'I supported the evaluation of a data platform.'),
        roleId: 'role-earlier', roleContext: { title: 'Analyst', employer: 'Example Labs', endDate: 'January 2023' } };
      const sources = [first, earlier];
      const text = INTERVIEW_INTRO_ALLOWANCE_EXAMPLES.positive.claim;
      assert(interviewIntroRoleSummary(claim(text, sources), sources), 'the explicit summary pairs each role title with its own employer');
      assert(interviewClaimFailures(claim(text, sources), sources, { intro: true }).length === 0, 'employment metadata must not inherit unrelated project ownership claims');
      assert(interviewHeadlineFailures(text).length === 0, 'the synthetic role summary is a speakable headline');
      const swapped = INTERVIEW_INTRO_ALLOWANCE_EXAMPLES.negative.claim;
      assert(!interviewIntroRoleSummary(claim(swapped, sources), sources), 'metadata pairs cannot be swapped');
      assert(interviewClaimFailures(claim(swapped, sources), sources, { intro: true }).some(item => item.rule === 'INTERVIEW_ANSWER_INTRO_ROLE_SUMMARY'), 'pooled metadata vocabulary cannot approve changed employment relationships');
      for (const invalid of [
        'I worked as Engineer at Invented Labs and Analyst at Example Labs.',
        'I worked as Engineer at Sample Works for 9 years and Analyst at Example Labs.',
        'I built the inherited system at Sample Works.',
        'I evaluated the data platform at Example Labs.',
      ]) assert(interviewClaimFailures(claim(invalid, sources), sources, { intro: true }).length > 0, 'intro allowance retains entity, number and project candor guards');
    },
  },
  {
    name: 'interview spoken claims: sanitized v4 intro chronology is licensed only by dated role order',
    run() {
      const recent = { ...source('intro-v4-recent', 'Built a full-stack web app as a hub for internal tools. Tech used: React, Django.'), roleId: 'recent',
        roleContext: { title: 'Software Engineer', employer: 'Sample District', startDate: 'May 2023', endDate: 'June 2026' } };
      const past = { ...source('intro-v4-past', 'Built REST APIs for a local medical database. Tech used: Python.'), roleId: 'past',
        roleContext: { title: 'Data Engineer', employer: 'Example Alliance', startDate: 'October 2022', endDate: 'January 2023' } };
      const sources = [recent, past];
      for (const [text, cited] of [
        ['I last worked as Software Engineer at Sample District, building internal tools.', [recent]],
        ['Previously, I built internal tools as Software Engineer at Sample District.', [recent]],
        ['Earlier, I built Python REST APIs as Data Engineer at Example Alliance.', [past]],
      ]) {
        assert(interviewClaimFailures(claim(text, cited), sources, { intro: true, roleEvidence: sources }).length === 0, 'v4-shaped arc may use explicitly verified chronology');
        assert(interviewClaimFailures(claim(text, cited), sources).some(item => item.rule === 'INTERVIEW_ANSWER_NEW_FACT'), 'chronology allowance is limited to an intro');
      }
      for (const [text, cited] of [
        ['Earlier, I built internal tools as Software Engineer at Sample District.', [recent]],
        ['I last worked as Data Engineer at Example Alliance, building Python REST APIs.', [past]],
        ['From May 2023, I built internal tools as Software Engineer at Sample District.', [recent]],
      ]) assert(interviewClaimFailures(claim(text, cited), sources, { intro: true, roleEvidence: sources }).length > 0, 'wrong chronology and role-date quantities remain unsupported');
      const research = { ...source('intro-preserve-inflection', 'Full-stack product engineering while preserving a free experience.'), kind: 'research' };
      supported('Full-stack product engineering preserves a free experience.', [research], 'preserves is the same predicate as preserving');
    },
  },
  {
    name: 'interview spoken claims: achieved qualitative outcomes need their own predicate and object',
    run() {
      const achieved = source('qualitative-achieved', 'I built reporting automation that cut manual clicks needed to generate a report.');
      supported('I reduced manual clicks needed to generate a report.', [achieved], 'explicit qualitative effect does not need a metric');
      supported('I built reporting automation that reduced manual clicks.', [achieved], 'cut and reduced preserve the same achieved effect');
      const qualitative = source('qualitative-improvement', 'I improved the reporting interface.');
      supported('I improved the reporting interface.', [qualitative], 'source-stated nonmetric improvement');
      for (const [name, text] of [
        ['purpose', 'I built reporting automation to reduce manual clicks.'],
        ['plan', 'I planned to reduce manual clicks with reporting automation.'],
        ['possibility', 'I built reporting automation that could reduce manual clicks.'],
        ['unrelated-number', 'I built reporting automation over 3 months to reduce manual clicks.'],
      ]) {
        const evidence = source(`qualitative-${name}`, text);
        assert(rejected('I reduced manual clicks.', [evidence], name).some(item => item.rule === 'INTERVIEW_ANSWER_OUTCOME'), 'an intended effect cannot become an achieved qualitative result');
      }
      const mismatched = source('qualitative-object-binding', 'I reduced errors and reviewed costs.');
      assert(rejected('I reduced costs.', [mismatched], 'wrong outcome object').some(item => item.rule === 'INTERVIEW_ANSWER_OUTCOME'), 'the outcome verb cannot borrow another action object');
      const goal = source('qualitative-goal', 'I migrated systems over 3 months. The move was to eliminate the ongoing cost of maintenance.');
      assert(rejected('I eliminated the ongoing cost of maintenance.', [goal], 'goal with unrelated duration').some(item => item.rule === 'INTERVIEW_ANSWER_OUTCOME'), 'a duration cannot prove an achieved cost outcome');
    },
  },

  {
    name: 'interview spoken claims: v3 supporting role never becomes solo evaluation or presentation',
    run() {
      const limited = source('supporting-v3', 'Evaluated products by analyzing cost, then presenting the final analysis to management; supported the evaluation of the third-party platform.');
      assert(limited.candorFlags.includes('supported-only'), 'supporting evaluation must compile a mechanical flag');
      for (const text of [
        'I evaluated the third-party platform and presented the final analysis to management.',
        'I supported the evaluation and presented the final analysis to management.',
        'I supported the evaluation after I evaluated the platform.',
        'I supported the evaluation, having presented the final analysis.',
        'My work was evaluating the platform and presenting the final analysis.',
        'I owned the platform evaluation.',
        'We decided the final evaluation.',
      ]) assert(rejected(text, [limited], text).some(item => item.rule === 'INTERVIEW_ANSWER_SUPPORTED_ONLY'), 'solo predicates must fail even when their words appear elsewhere in the source');
      supported('I supported the evaluation of the third-party platform.', [limited], 'bounded supporting contribution');
      supported('I helped with the evaluation of the third-party platform.', [limited], 'help remains modest');
      supported('I contributed to the evaluation of the third-party platform.', [limited], 'contribution remains modest');
      const assisted = source('assisted-evaluation', 'Assisted with the evaluation of the platform.');
      assert(assisted.candorFlags.includes('supported-only'), 'assisted work is supporting work');
      supported('I helped with the evaluation of the platform.', [assisted], 'assisted can become helped');
      const employerLimited = { ...limited, roleContext: { title: 'Engineer', employer: 'Example Systems' } };
      supported('At Example Systems, I supported the evaluation of the third-party platform.', [employerLimited], 'employer prefix preserves supporting action');
      const second = source('unrelated-strong-evaluation', 'I evaluated a database.');
      assert(rejected('I evaluated the third-party platform.', [limited, second], 'multi-citation support laundering').some(item => item.rule === 'INTERVIEW_ANSWER_SUPPORTED_ONLY'), 'an extra citation cannot remove the supporting limitation');
    },
  },
  {
    name: 'interview spoken claims: approximate partial example and personal contexts survive speech',
    run() {
      const approximate = source('qualifier-approximate', 'We migrated the systems over about 3 months.');
      assert(rejected('We migrated the systems over three months.', [approximate], 'exact duration').some(item => item.rule === 'INTERVIEW_ANSWER_APPROXIMATE'), 'a source approximation cannot become an exact duration');
      supported('We migrated the systems over roughly three months.', [approximate], 'approximation equivalents retain the quantity');
      const scale = source('qualifier-tilde', 'We supported ~30 schools.');
      assert(scale.candorFlags.includes('approximate'), 'tilde quantities are approximate');
      assert(rejected('We supported 30 schools.', [scale], 'unqualified scale').some(item => item.rule === 'INTERVIEW_ANSWER_APPROXIMATE'), 'tilde cannot disappear');
      const partial = source('qualifier-partial', 'I partially implemented the reporting service.');
      assert(partial.candorFlags.includes('partial'), 'partial contribution is a flag');
      assert(rejected('I implemented the reporting service.', [partial], 'full partial implementation').some(item => item.rule === 'INTERVIEW_ANSWER_PARTIAL'), 'partial implementation cannot sound complete');
      supported('I partially implemented the reporting service.', [partial], 'partial contribution preserved');
      const examples = source('qualifier-examples', 'I recommended cost strategies, such as buying licenses for active users.');
      assert(examples.candorFlags.includes('example-only'), 'such-as clauses are example-only');
      assert(rejected('I recommended buying licenses for active users.', [examples], 'example promoted').some(item => item.rule === 'INTERVIEW_ANSWER_EXAMPLE_ONLY'), 'such-as strategy cannot become an unqualified action');
      supported('I recommended cost strategies, for example buying licenses for active users.', [examples], 'example remains illustrative');
      const personal = source('qualifier-personal', 'In personal projects, I use MCP and delegate tasks by cost.');
      assert(personal.candorFlags.includes('personal-project'), 'personal context is a mechanical flag');
      assert(rejected('I use MCP and delegate tasks by cost.', [personal], 'personal work without context').some(item => item.rule === 'INTERVIEW_ANSWER_PERSONAL_PROJECT'), 'personal work must not sound like employer practice');
      supported('In personal projects, I use MCP and delegate tasks by cost.', [personal], 'personal context preserved');
    },
  },
  {
    name: 'interview spoken claims: modified algorithm headlines retain the team choice',
    run() {
      assert(rejected('I implemented a modified A* algorithm for flight route optimization.', [routing], 'ambiguous modification authorship').some(item => item.rule === 'INTERVIEW_ANSWER_TEAM_CHOSEN'), 'modified algorithm needs its actual decision owner in the same claim');
      supported('I implemented the modified A* algorithm the team had already chosen.', [routing], 'modified algorithm attributed');
      supported('I implemented and tested the A* algorithm for flight route optimization.', [routing], 'omitting modified avoids implying modification authorship');
    },
  },
  {
    name: 'interview spoken claims: role metadata supplies only verified title and employer entities',
    run() {
      const roleEvidence = { ...source('role-context-entity', 'I built REST APIs using Python.'), roleContext: { title: 'Software Engineer', employer: 'Example Systems' } };
      supported('At Example Systems, I built REST APIs using Python.', [roleEvidence], 'employer from cited role metadata');
      rejected('At Imaginary Systems, I built REST APIs using Python.', [roleEvidence], 'invented employer');
      rejected('At Example Systems, I built React APIs using Python.', [roleEvidence], 'role metadata cannot supply new technology');
    },
  },
  {
    name: 'interview spoken claims: glanceable bullets and examples have a same-sentence subject',
    run() {
      for (const text of [
        'They consumed records from the core platform on a schedule.',
        'Those were scheduled jobs that consumed data from other platforms.',
        'It provided controlled access to the local database through APIs.',
        'The data went through OCR and loaded into a database.',
      ]) {
        assert(interviewBulletFailures(text).some(item => item.rule === 'INTERVIEW_ANSWER_UNRESOLVED_REFERENCE'), 'unresolved-start bullets must fail');
        assert(interviewStandaloneFailures(text).length > 0, 'examples use the same standalone speech boundary');
      }
      assert(interviewStandaloneFailures('The data from scanned documents went through OCR before database loading.').length === 0, 'a same-sentence source resolves data');
      assert(JSON.stringify(interviewClaimContent('I had implemented the APIs.')) === JSON.stringify(interviewClaimContent('I implemented APIs.')), 'grammar inflections cannot supply a novel detail');
      assert(JSON.stringify(interviewClaimContent('We migrated for approximately three months.')) === JSON.stringify(interviewClaimContent('We migrated for three months.')), 'an approximation marker alone cannot supply a novel detail');
      assert(interviewBulletFailures('The integrations consumed data from the core platform on a schedule.').length === 0, 'naming the actual subject makes a bullet standalone');
    },
  },

  {
    name: 'interview spoken claims: repair diagnostics name the worker words and required ownership form',
    run() {
      const unknown = rejected('I maintained cron jobs using Rust and invented waterfalls.', [cron], 'unknown content');
      const content = unknown.find(item => item.rule === 'INTERVIEW_ANSWER_NEW_FACT').instruction;
      assert(content.includes('"Rust"') && content.includes('"invented"') && content.includes('"waterfalls"'), 'content diagnostics must name every unsupported token from the worker text');
      assert(unknown.find(item => item.rule === 'INTERVIEW_ANSWER_ENTITY').instruction.includes('"Rust"'), 'entity diagnostics must name the rejected technology');
      const coBuilt = rejected('I migrated historical data.', [migration], 'missing co-owner').find(item => item.rule === 'INTERVIEW_ANSWER_CO_BUILT').instruction;
      assert(coBuilt.includes('"I"') && coBuilt.includes("'we'") && coBuilt.includes("'with the other engineer'") && coBuilt.includes('cited evidence says the work was shared'), 'shared ownership diagnostic must name the subject and grammatical repair');
      const neutral = source('neutral-diagnostic', 'The project shipped in 2023.');
      const agency = rejected('I shipped the project in 2023.', [neutral], 'unsupported subject').find(item => item.rule === 'INTERVIEW_ANSWER_ATTRIBUTION').instruction;
      assert(agency.includes('"I"') && agency.includes('documented owner') && agency.includes('"I shipped the project in 2023."'), 'agency diagnostic must identify exactly what assigns candidate action and require source attribution');
      const quantity = rejected('We migrated three platforms with another engineer.', [migration], 'wrong counted object').find(item => item.rule === 'INTERVIEW_ANSWER_QUANTITY').instruction;
      assert(quantity.includes('three platforms') && quantity.includes('cited unit or counted object'), 'quantity diagnostic must expose the returned number and unit');
      const inherited = rejected('I built the ticketing system.', [ticketing], 'original construction').find(item => item.rule === 'INTERVIEW_ANSWER_INHERITED').instruction;
      assert(inherited.includes('"built"'), 'inherited diagnostic must name the construction verb');
      const shipment = rejected('I shipped cron jobs.', [cron], 'shipment wording').find(item => item.rule === 'INTERVIEW_ANSWER_SHIPPED').instruction;
      assert(shipment.includes('"shipped"'), 'shipment diagnostic must name the shipment verb');
      const headline = interviewHeadlineFailures('I maintained cron jobs.').find(item => item.rule === 'INTERVIEW_ANSWER_HEADLINE_LENGTH').instruction;
      assert(headline.includes('4 whitespace-separated words') && headline.includes('"I maintained cron jobs."'), 'length diagnostic must report the count and returned text');
      const bullet = interviewBulletFailures('We added access.')[0].instruction;
      assert(bullet.includes('3 whitespace-separated words') && bullet.includes('"We added access."'), 'bullet repair must identify the actual short sentence');
      const missingLimitation = source('missing-limitation', 'I maintained the system and did not frobnicate it.');
      const limitation = rejected('I maintained the system.', [missingLimitation], 'omitted limitation').find(item => item.rule === 'INTERVIEW_ANSWER_NEGATION').instruction;
      assert(limitation.includes('"I maintained the system."') && !limitation.includes('frobnicate'), 'diagnostics may quote the returned claim but must not introduce expected career-source wording');
    },
  },
  {
    name: 'interview spoken claims: replay-calibrated inflections and speech equivalents stay bounded',
    run() {
      const data = source('spoken-data', 'Built integrations between core records and third-party platforms that consume data or produce data we ingest. Some built solo, others co-built with the other engineer.');
      supported('The integrations connected core records and third-party platforms.', [data], 'integrations between means a connection');
      supported('The platforms consumed data or produced data we ingested.', [data], 'consume and produce past tense');
      const record = source('spoken-record', 'The platform serves as the system of record.');
      supported('The platform served as the system of record.', [record], 'serve past tense');
      supported('I worked with the other engineer on integrations between platforms.', [data], 'worked with names shared agency');
      supported('I helped with integrations with the other engineer.', [data], 'helped modest shared work');
      const api = source('spoken-api', 'Built REST APIs to provide controlled access to a local database. Tech used: Python.');
      supported("My REST APIs provided controlled access to the database.", [api], 'provide past tense');
      supported("I used Python for the database's REST APIs.", [api], 'possessive is grammar');
      const tools = source('spoken-tools', "Adopted coding tools in day-to-day development, which built a practical sense of each approach's strengths and limitations.");
      supported('I used coding tools in day-to-day development.', [tools], 'adopted tools licenses use');
      supported('I developed a practical sense of development approaches and limitations.', [tools], 'built a practical sense licenses developed');
      const etl = source('spoken-etl', 'Built ETL pipelines that ingested documents, ran them through OCR, and loaded data into a database.');
      supported('The ETL pipelines processed documents through OCR.', [etl], 'processing requires the documented ingestion OCR loading workflow');
      const app = source('spoken-app', 'A productivity app built on a zoomable canvas where you arrange notes. With optional navigation and local persistence, it works as a mind-map.');
      supported('The app uses a zoomable canvas.', [app], 'built on licenses descriptive use');
      supported('The app includes optional navigation and local persistence.', [app], 'with optional licenses includes');
      supported('The app lets you arrange notes.', [app], 'where you licenses lets you');
      const tasks = source('spoken-tasks', 'I delegate tasks across models by cost, matching each task to a model that does it well.');
      supported('I delegate tasks across models by cost and task fit.', [tasks], 'matching a task to what does it well licenses fit');
      rejected('I delegate tasks across models by task requirements.', [tasks], 'requirements is not a licensed matching synonym');
      const choice = source('spoken-preposition', 'I decided against the proposal.');
      supported('I decided against the proposal.', [choice], 'against is a function preposition');
      supported('The other engineer and I migrated historical data.', [migration], 'explicit coordinated collaborator');
      supported('The team had already chosen the algorithm before I joined.', [routing], 'joining time is not algorithm agency');
      supported("I implemented and tested the team's chosen algorithm that shipped in the flight planning app.", [routing], 'possessive team choice is attribution');
      supported('I implemented and tested a team-chosen algorithm that shipped in the flight planning app.', [routing], 'team-chosen adjective is attribution');
      rejected('I worked with Imaginary Corporation on integrations.', [data], 'worked with cannot license a new entity');
      rejected('I helped build the inherited ticketing system with the other engineer.', [ticketing], 'helped cannot license inherited construction');
      rejected('I helped choose and implement the algorithm.', [routing], 'helped cannot license team-choice agency');
      rejected('We moved six systems with historical data.', [migration], 'moved cannot license a count');
      rejected('We helped reduce ticketing costs.', [ticketing], 'help cannot license an outcome');
      const narrow = source('spoken-narrow', 'I reviewed the database.');
      rejected('I connected the database.', [narrow], 'connection equivalence requires integrations between');
      rejected('I processed the database.', [narrow], 'process equivalence requires an OCR workflow');
      rejected('I developed the database.', [narrow], 'develop equivalence requires a documented built practical sense');
    },
  },
  {
    name: 'interview spoken claims: diagnosis before/after fixtures keep facts and absorb candor',
    run() {
      for (const example of examples) {
        rejected(example.before, example.headlineSources, `${example.name} before`);
        assert(interviewHeadlineFailures(example.before).length > 0, `${example.name} transcript cannot be a headline`);
        supported(example.headline, example.headlineSources, `${example.name} headline`);
        assert(interviewHeadlineFailures(example.headline).length === 0, `${example.name} after headline is short and speakable`);
        for (const [text, sources] of example.bullets) supported(text, sources, `${example.name} bullet`);
        const speech = [example.headline, ...example.bullets.map(([text]) => text)].join(' ');
        const evidence = [...example.headlineSources, ...example.bullets.flatMap(([, sources]) => sources)];
        assert(interviewQuestionFit(example.question, speech, evidence) === (example.name === 'planning-delivery'), `${example.name} answer must honestly reflect the question shape`);
      }
      // A second phrasing retains the team's choice and candidate implementation.
      const shortTeamChoice = 'The team chose the algorithm before I joined, and I implemented and tested it.';
      supported(shortTeamChoice, [routing], 'short team-choice bullet');
      assert(interviewBulletFailures(shortTeamChoice).length === 0, 'short team-choice bullet must fit live limits');
      assert(interviewBulletFailures(examples[2].bullets[0][0]).length === 0, 'the evaluator sentence fits the seventeen-word bullet limit');
      return { fixtures: examples.length, claims: examples.reduce((count, item) => count + 1 + item.bullets.length, 0) };
    },
  },
  {
    name: 'interview spoken claims: inherited, shared, chosen and retired notes become mechanical flags',
    run() {
      for (const flag of ['inherited', 'co-built', 'retired']) assert(ticketing.candorFlags.includes(flag), `ticketing must compile ${flag}`);
      assert(integrations.candorFlags.includes('mixed-solo-co-built'), 'mixed attribution must preserve the solo/shared split');
      assert(migration.candorFlags.includes('co-built'), 'migration must retain joint ownership');
      assert(routing.candorFlags.includes('team-chosen'), 'prior team decision must constrain candidate verbs');
      rejected('I built the ticketing system.', [ticketing], 'inherited ownership');
      rejected('I designed the routing algorithm.', [routing], 'team-chosen ownership');
      rejected('I chose the algorithm and implemented it.', [routing], 'candidate choice');
      rejected('I built the integrations.', [integrations], 'mixed work represented as all solo');
      supported('Some integrations I built solo, others we co-built.', [integrations], 'qualified mixed ownership');
      supported('We added role-restricted access for internal staff to the ticketing system.', [ticketing], 'shared inherited maintenance');
      supported('The ticketing system was later retired for a third-party platform.', [ticketing], 'retired status');
    },
  },
  {
    name: 'interview spoken claims: invented metrics, entities, technologies and spoken note leaks fail',
    run() {
      rejected('We reduced ticketing costs by 47%.', [ticketing], 'invented percentage');
      rejected('We reduced ticketing costs.', [ticketing], 'unsupported outcome without a metric');
      rejected('I shipped cron jobs syncing daily data.', [cron], 'unsupported shipping');
      rejected('I maintained cron jobs using Rust.', [cron], 'invented technology');
      rejected('I maintained cron jobs at Imaginary Corporation.', [cron], 'invented employer');
      rejected('We maintained the ticketing system (not originally built by me).', [ticketing], 'parenthetical leak');
      rejected('We maintained the ticketing system. Tech used: React.', [ticketing], 'technology boilerplate leak');
      rejected('I implemented the routing algorithm. I tested it.', [routing], 'multiple sentences in one claim');
      supported('I implemented and tested the routing algorithm that shipped in a flight planning app.', [routing], 'supported shipping');
      supported('I maintained cron jobs syncing daily data from the FAA, including NOTAMs.', [cron], 'exact technology names');
    },
  },
  {
    name: 'interview spoken claims: spoken numbers bind to cited quantities without licensing other facts',
    run() {
      supported('I delivered a migration over about three months with another engineer, without interrupting daily operations.', [migration], 'spoken approximate duration');
      supported('We migrated the systems over about three months with historical data.', [migration], 'spoken duration');
      rejected('We migrated the systems over about six months with historical data.', [migration], 'different duration');
      rejected('We migrated six systems with historical data over about three months.', [migration], 'unbound quantity');
      rejected('We migrated the systems and increased daily operations by three percent.', [migration], 'matching number in a new percentage');
    },
  },
  {
    name: 'interview spoken claims: headline and bullet limits reject long or unspeakable layouts',
    run() {
      const long = 'I maintained the ticketing system with another engineer and added access for internal staff while keeping the system available for everyone across all of the daily operations and scheduled work.';
      assert(long.split(/\s+/u).length > 29 && interviewHeadlineFailures(long).length > 0, 'a 30-word headline must reject');
      for (const text of [
        'I maintained the ticketing system with another engineer: we added role-restricted staff access.',
        'I maintained the ticketing system with another engineer; we added role-restricted staff access.',
        'I maintained the ticketing system with another engineer (we added role-restricted access).',
        'The ticketing system was maintained with another engineer and role-restricted access was added.',
      ]) assert(interviewHeadlineFailures(text).length > 0, 'headline punctuation and first-person active voice must be enforced');
      assert(interviewBulletFailures('We added access.').length > 0, 'bullet below eight words must reject');
      assert(interviewBulletFailures('We maintained the ticketing system with another engineer while adding role-restricted staff access for internal staff across the school district.').length > 0, 'bullet above eighteen words must reject');
    },
  },
  {
    name: 'interview spoken claims: narrow evidence never supplies an invented problem or outcome',
    run() {
      const narrow = source('narrow', 'Built REST APIs for the local medical database to provide controlled access. Tech used: Python.');
      assert(!interviewQuestionFit('Walk me through a technical problem.', 'I built REST APIs giving controlled access to a local medical database.', [narrow]), 'a deliverable alone cannot claim a documented technical problem');
      assert(!interviewQuestionFit('Tell me about a result from your work.', 'I built REST APIs giving controlled access to a local medical database.', [narrow]), 'a deliverable alone cannot supply a measured or shipped result');
      rejected('I solved database outages and reduced data loss.', [narrow], 'invented problem and resolution');
      const negated = source('negated', 'The experiment did not improve conversion in 2024.');
      rejected('I improved conversion in 2024.', [negated], 'discarded negation');
      const observer = source('observer', 'Led by another manager, the project shipped in 2023.');
      rejected('I led the project that shipped in 2023.', [observer], 'discarded passive attribution');
    },
  },
  {
    name: 'interview spoken claims: numeric membership cannot move quantities between units or objects',
    run() {
      rejected('We migrated three platforms with historical data and another engineer.', [migration], 'duration reused as a platform count');
      const measured = source('measured-units', 'I reduced errors by 2% over 3 months.');
      rejected('I reduced errors by 3%.', [measured], 'duration reused as a percentage');
      rejected('I reduced errors over two months.', [measured], 'percentage reused as a duration');
      supported('I reduced errors by two percent over three months.', [measured], 'spoken units preserve the measured relation');
    },
  },
  {
    name: 'interview spoken claims: coordinated and nominal clauses cannot steal the team decision',
    run() {
      rejected('I implemented and chose the routing algorithm that shipped in a flight planning app.', [routing], 'coordinated candidate choice');
      rejected('I implemented the algorithm the team had chosen and I chose the routing algorithm.', [routing], 'candidate choice after team clause');
      rejected('I implemented the algorithm the team chose and I had chosen.', [routing], 'candidate choice after embedded team clause');
      rejected('My work was choosing and implementing the algorithm correctly.', [routing], 'nominal candidate choice');
      rejected('I correctly chose and implemented the algorithm that shipped.', [routing], 'adverb between candidate and choice');
      supported('I implemented and tested the routing algorithm the team had already chosen.', [routing], 'candidate implementation and team choice');
    },
  },
  {
    name: 'interview spoken claims: unrelated negation does not reverse the cited outcome polarity',
    run() {
      const negative = source('negative-conversion', 'The experiment did not improve conversion in 2024.');
      rejected('I improved conversion without an experiment in 2024.', [negative], 'unrelated without cannot qualify a positive outcome');
      const tested = source('tested-negative-conversion', 'The experiment did not improve conversion in 2024. I tested the experiment.');
      rejected('I did not test the experiment and improved conversion in 2024.', [tested], 'unrelated negative predicate cannot qualify a positive outcome');
      const neutral = source('neutral-shipment', 'The project shipped in 2023.');
      rejected('I delivered the project in 2023.', [neutral], 'neutral shipment does not establish candidate delivery');
      rejected('I shipped the project in 2023.', [neutral], 'neutral shipment does not establish candidate agency');
      const failed = source('failed-reduction', 'We failed to reduce errors by 2%.');
      rejected('We never failed to reduce errors by 2%.', [failed], 'double negation cannot turn failure into success');
    },
  },
  {
    name: 'interview spoken claims: retired work stays historical and mixed ownership keeps its scope',
    run() {
      const retired = source('retired-tense', 'Maintained the system with another engineer. The system was later retired.');
      rejected('I maintain the system with another engineer.', [retired], 'simple present cannot revive a retired system');
      assert(rejected('I still maintain the retired system with another engineer.', [retired], 'retirement mention cannot license present maintenance').some(item => item.rule === 'INTERVIEW_ANSWER_RETIRED'), 'the retirement word must not mask ongoing action');
      supported('The system is retired.', [retired], 'present retirement status remains true');
      supported('I maintained the system with another engineer.', [retired], 'historical shared maintenance');
      const mixed = source('mixed-scope', 'Built integrations; some built solo, others co-built with the other engineer.');
      rejected('We built all integrations together.', [mixed], 'all cannot replace a documented subset');
      supported('Some integrations I built solo, others we co-built.', [mixed], 'mixed ownership preserves both contributions');
    },
  },
];
