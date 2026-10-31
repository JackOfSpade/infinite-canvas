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
const inventory = source('inventory', 'Maintained and improved the legacy in-house inventory system I inherited (not built by me originally), including adding role-restricted access controls for internal staff members. Improvements made together, working with the other engineer. Technologies used: Preact, ScriptType. (The system was eventually retired in favor of a commercial third-party platform.)');
const integrations = source('integrations', "Built data integrations and ETL links between the cooperative's central member-ledger platform (a third-party Subscription that serves as its official system of record) and several other third-party Subscription platforms that either consume its exported data or produce new data that we ingest. A sizable number of integrations, each run as a blend of scheduled and on-request jobs; some built solo by me, others co-built jointly with the other engineer. Technologies used: Quartz.");
const migration = source('migration', "In my final months there, migrated the cooperative's in-house inventory/repair-planning and equipment check-in/check-out tracking systems, with all of their archived history, to a unified third-party service-desk and asset-tracking platform. Done with the other engineer over about 4 months, jointly implementing the integrations plus data migration runbooks, automation, validation, and support tooling the cutover required at the time. The in-house systems stayed fully in service until the new target platform was completely set up for all staff, meaning day-to-day floor operations continued without interruption. The cooperative made the switch to eliminate the recurring cost of maintaining these internal systems in-house.");
const routing = source('routing', "Implemented a modified B* algorithm that accounts for the Globe's curvature for ferry route optimization; it shipped inside the company's ferry planning application. (The team had already chosen this algorithm before I joined; my own work was implementing it accurately and testing it.) Technologies used: Quartz.");
const cron = source('cron', "Maintained cron jobs that pull and sync the CWA's daily published data releases through its public APIs into our local station database, including DOCKs (Notices to Dock Missions) so the routing logic could steer around active hazard warnings.");

const examples = [
  {
    name: 'collaboration', question: 'How do you collaborate with others?',
    before: inventory.text,
    headline: 'I work closely with one other engineer, splitting solo and shared work.',
    headlineSources: [inventory, integrations],
    bullets: [
      ['We improved the inherited inventory system together, adding role-restricted staff access.', [inventory]],
      ['Some integrations I built solo, others we co-built.', [integrations]],
    ],
  },
  {
    name: 'planning-delivery', question: 'How do you approach planning and delivery?',
    before: migration.text,
    headline: 'I migrated platforms over about four months with another engineer, without interrupting daily operations.',
    headlineSources: [migration],
    bullets: [
      ['We moved inventory and equipment check-in systems, with archived history, to a third-party platform.', [migration]],
      ['The old systems stayed live until the new one was ready for all staff.', [migration]],
      ['The work covered integrations, data migration, validation and tooling.', [migration]],
    ],
  },
  {
    name: 'project-result', question: 'Tell me about a result from your work.',
    before: routing.text,
    headline: 'I implemented and tested a curvature-aware B* routing algorithm that shipped in a ferry planning application.',
    headlineSources: [routing],
    bullets: [
      ['The team had already chosen this algorithm, so my job was implementing it accurately and testing it.', [routing]],
      ["I also maintained cron jobs syncing the CWA's daily data, including DOCKs.", [cron]],
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
      const first = { ...source('intro-summary-first', 'I maintained an inherited system with the other engineer. The system was eventually retired.'),
        roleId: 'role-first', roleContext: { title: 'Engineer', employer: 'Sample Works', endDate: 'June 2025' } };
      const earlier = { ...source('intro-summary-earlier', 'I supported the evaluation of a data platform.'),
        roleId: 'role-earlier', roleContext: { title: 'Analyst', employer: 'Example Labs', endDate: 'January 2022' } };
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
      const recent = { ...source('intro-v4-recent', 'Built a full-stack intranet portal as a launchpad for back-office utilities. Technologies used: Preact, Marlow.'), roleId: 'recent',
        roleContext: { title: 'Software Engineer', employer: 'Sample Cooperative', startDate: 'May 2022', endDate: 'June 2025' } };
      const past = { ...source('intro-v4-past', 'Built RPC APIs for a local warehouse database. Technologies used: Quartz.'), roleId: 'past',
        roleContext: { title: 'Data Developer', employer: 'Example Alliance', startDate: 'October 2021', endDate: 'January 2022' } };
      const sources = [recent, past];
      for (const [text, cited] of [
        ['I last worked as Software Engineer at Sample Cooperative, building back-office utilities.', [recent]],
        ['Previously, I built back-office utilities as Software Engineer at Sample Cooperative.', [recent]],
        ['Earlier, I built Quartz RPC APIs as Data Developer at Example Alliance.', [past]],
      ]) {
        assert(interviewClaimFailures(claim(text, cited), sources, { intro: true, roleEvidence: sources }).length === 0, 'v4-shaped arc may use explicitly verified chronology');
        assert(interviewClaimFailures(claim(text, cited), sources).some(item => item.rule === 'INTERVIEW_ANSWER_NEW_FACT'), 'chronology allowance is limited to an intro');
      }
      for (const [text, cited] of [
        ['Earlier, I built back-office utilities as Software Engineer at Sample Cooperative.', [recent]],
        ['I last worked as Data Developer at Example Alliance, building Quartz RPC APIs.', [past]],
        ['From May 2022, I built back-office utilities as Software Engineer at Sample Cooperative.', [recent]],
      ]) assert(interviewClaimFailures(claim(text, cited), sources, { intro: true, roleEvidence: sources }).length > 0, 'wrong chronology and role-date quantities remain unsupported');
      const research = { ...source('intro-preserve-inflection', 'Full-stack product engineering while preserving a free experience.'), kind: 'research' };
      supported('Full-stack product engineering preserves a free experience.', [research], 'preserves is the same predicate as preserving');
    },
  },
  {
    name: 'interview spoken claims: achieved qualitative outcomes need their own predicate and object',
    run() {
      const achieved = source('qualitative-achieved', 'I built reporting automation that cut manual steps required to produce a summary.');
      supported('I reduced manual steps required to produce a summary.', [achieved], 'explicit qualitative effect does not need a metric');
      supported('I built reporting automation that reduced manual steps.', [achieved], 'cut and reduced preserve the same achieved effect');
      const qualitative = source('qualitative-improvement', 'I improved the reporting interface.');
      supported('I improved the reporting interface.', [qualitative], 'source-stated nonmetric improvement');
      for (const [name, text] of [
        ['purpose', 'I built reporting automation to reduce manual steps.'],
        ['plan', 'I planned to reduce manual steps with reporting automation.'],
        ['possibility', 'I built reporting automation that could reduce manual steps.'],
        ['unrelated-number', 'I built reporting automation over 3 months to reduce manual steps.'],
      ]) {
        const evidence = source(`qualitative-${name}`, text);
        assert(rejected('I reduced manual steps.', [evidence], name).some(item => item.rule === 'INTERVIEW_ANSWER_OUTCOME'), 'an intended effect cannot become an achieved qualitative result');
      }
      const mismatched = source('qualitative-object-binding', 'I reduced errors and reviewed costs.');
      assert(rejected('I reduced costs.', [mismatched], 'wrong outcome object').some(item => item.rule === 'INTERVIEW_ANSWER_OUTCOME'), 'the outcome verb cannot borrow another action object');
      const goal = source('qualitative-goal', 'I migrated systems over 3 months. The move was to eliminate the recurring cost of maintenance.');
      assert(rejected('I eliminated the recurring cost of maintenance.', [goal], 'goal with unrelated duration').some(item => item.rule === 'INTERVIEW_ANSWER_OUTCOME'), 'a duration cannot prove an achieved cost outcome');
    },
  },

  {
    name: 'interview spoken claims: v3 supporting role never becomes solo evaluation or presentation',
    run() {
      const limited = source('supporting-v3', 'Evaluated products by analyzing cost, then presenting the completed analysis to management; supported the evaluation of a third-party platform.');
      assert(limited.candorFlags.includes('supported-only'), 'supporting evaluation must compile a mechanical flag');
      for (const text of [
        'I evaluated the third-party platform and presented the completed analysis to management.',
        'I supported the evaluation and presented the completed analysis to management.',
        'I supported the evaluation after I evaluated the platform.',
        'I supported the evaluation, having presented the completed analysis.',
        'My work was evaluating the platform and presenting the completed analysis.',
        'I owned the platform evaluation.',
        'We decided the final evaluation.',
      ]) assert(rejected(text, [limited], text).some(item => item.rule === 'INTERVIEW_ANSWER_SUPPORTED_ONLY'), 'solo predicates must fail even when their words appear elsewhere in the source');
      supported('I supported the evaluation of a third-party platform.', [limited], 'bounded supporting contribution');
      supported('I helped with the evaluation of a third-party platform.', [limited], 'help remains modest');
      supported('I contributed to the evaluation of a third-party platform.', [limited], 'contribution remains modest');
      const assisted = source('assisted-evaluation', 'Assisted with the evaluation of the platform.');
      assert(assisted.candorFlags.includes('supported-only'), 'assisted work is supporting work');
      supported('I helped with the evaluation of the platform.', [assisted], 'assisted can become helped');
      const employerLimited = { ...limited, roleContext: { title: 'Engineer', employer: 'Example Systems' } };
      supported('At Example Systems, I supported the evaluation of a third-party platform.', [employerLimited], 'employer prefix preserves supporting action');
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
      const examples = source('qualifier-examples', 'I recommended cost strategies, such as buying licenses for current users.');
      assert(examples.candorFlags.includes('example-only'), 'such-as clauses are example-only');
      assert(rejected('I recommended buying licenses for current users.', [examples], 'example promoted').some(item => item.rule === 'INTERVIEW_ANSWER_EXAMPLE_ONLY'), 'such-as strategy cannot become an unqualified action');
      supported('I recommended cost strategies, for example buying licenses for current users.', [examples], 'example remains illustrative');
      const personal = source('qualifier-personal', 'In my personal projects, I use MCP and delegate tasks by price.');
      assert(personal.candorFlags.includes('personal-project'), 'personal context is a mechanical flag');
      assert(rejected('I use MCP and delegate tasks by price.', [personal], 'personal work without context').some(item => item.rule === 'INTERVIEW_ANSWER_PERSONAL_PROJECT'), 'personal work must not sound like employer practice');
      supported('In my personal projects, I use MCP and delegate tasks by price.', [personal], 'personal context preserved');
    },
  },
  {
    name: 'interview spoken claims: modified algorithm headlines retain the team choice',
    run() {
      assert(rejected('I implemented a modified B* algorithm for ferry route optimization.', [routing], 'ambiguous modification authorship').some(item => item.rule === 'INTERVIEW_ANSWER_TEAM_CHOSEN'), 'modified algorithm needs its actual decision owner in the same claim');
      supported('I implemented the modified B* algorithm the team had already chosen.', [routing], 'modified algorithm attributed');
      supported('I implemented and tested the B* algorithm for ferry route optimization.', [routing], 'omitting modified avoids implying modification authorship');
    },
  },
  {
    name: 'interview spoken claims: role metadata supplies only verified title and employer entities',
    run() {
      const roleEvidence = { ...source('role-context-entity', 'I built RPC APIs using Quartz.'), roleContext: { title: 'Software Engineer', employer: 'Example Systems' } };
      supported('At Example Systems, I built RPC APIs using Quartz.', [roleEvidence], 'employer from cited role metadata');
      rejected('At Imaginary Systems, I built RPC APIs using Quartz.', [roleEvidence], 'invented employer');
      rejected('At Example Systems, I built Preact APIs using Quartz.', [roleEvidence], 'role metadata cannot supply new technology');
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
      assert(interviewStandaloneFailures('The data from digitized documents went through OCR before database loading.').length === 0, 'a same-sentence source resolves data');
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
      const coBuilt = rejected('I migrated archived history.', [migration], 'missing co-owner').find(item => item.rule === 'INTERVIEW_ANSWER_CO_BUILT').instruction;
      assert(coBuilt.includes('"I"') && coBuilt.includes("'we'") && coBuilt.includes("'with the other engineer'") && coBuilt.includes('cited evidence says the work was shared'), 'shared ownership diagnostic must name the subject and grammatical repair');
      const neutral = source('neutral-diagnostic', 'The project shipped in 2023.');
      const agency = rejected('I shipped the project in 2023.', [neutral], 'unsupported subject').find(item => item.rule === 'INTERVIEW_ANSWER_ATTRIBUTION').instruction;
      assert(agency.includes('"I"') && agency.includes('documented owner') && agency.includes('"I shipped the project in 2023."'), 'agency diagnostic must identify exactly what assigns candidate action and require source attribution');
      const quantity = rejected('We migrated four platforms with another engineer.', [migration], 'wrong counted object').find(item => item.rule === 'INTERVIEW_ANSWER_QUANTITY').instruction;
      assert(quantity.includes('four platforms') && quantity.includes('cited unit or counted object'), 'quantity diagnostic must expose the returned number and unit');
      const inherited = rejected('I built the inventory system.', [inventory], 'original construction').find(item => item.rule === 'INTERVIEW_ANSWER_INHERITED').instruction;
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
      const data = source('spoken-data', 'Built integrations between core records and third-party platforms that consume data or produce data we ingest. Some built solo by me, others co-built jointly with the other engineer.');
      supported('The integrations connected core records and third-party platforms.', [data], 'integrations between means a connection');
      supported('The platforms consumed data or produced data we ingested.', [data], 'consume and produce past tense');
      const record = source('spoken-record', 'The platform serves as the system of record.');
      supported('The platform served as the system of record.', [record], 'serve past tense');
      supported('I worked with the other engineer on integrations between platforms.', [data], 'worked with names shared agency');
      supported('I helped with integrations with the other engineer.', [data], 'helped modest shared work');
      const api = source('spoken-api', 'Built RPC APIs to provide controlled access to a local database. Technologies used: Quartz.');
      supported("My RPC APIs provided controlled access to the database.", [api], 'provide past tense');
      supported("I used Quartz for the database's RPC APIs.", [api], 'possessive is grammar');
      const tools = source('spoken-tools', "Adopted programming tools in day-to-day product development, which gradually built a practical sense of every method's strengths and drawbacks.");
      supported('I used programming tools in day-to-day product development.', [tools], 'adopted tools licenses use');
      supported('I developed a practical sense of development methods and drawbacks.', [tools], 'built a practical sense licenses developed');
      const etl = source('spoken-etl', 'Built ETL pipelines that ingested documents, ran them through an OCR pass, and loaded data into a database.');
      supported('The ETL pipelines processed documents through OCR.', [etl], 'processing requires the documented ingestion OCR loading workflow');
      const app = source('spoken-app', 'A note-taking app built on a zoomable canvas where you arrange notes. With optional navigation and offline persistence, it works as a concept-map.');
      supported('The app uses a zoomable canvas.', [app], 'built on licenses descriptive use');
      supported('The app includes optional navigation and offline persistence.', [app], 'with optional licenses includes');
      supported('The app lets you arrange notes.', [app], 'where you licenses lets you');
      const tasks = source('spoken-tasks', 'I delegate tasks among models by price, matching every task to a model that does it well.');
      supported('I delegate tasks among models by price and task fit.', [tasks], 'matching a task to what does it well licenses fit');
      rejected('I delegate tasks among models by task requirements.', [tasks], 'requirements is not a licensed matching synonym');
      const choice = source('spoken-preposition', 'I decided against the proposal.');
      supported('I decided against the proposal.', [choice], 'against is a function preposition');
      supported('The other engineer and I migrated archived history.', [migration], 'explicit coordinated collaborator');
      supported('The team had already chosen this algorithm before I joined.', [routing], 'joining time is not algorithm agency');
      supported("I implemented and tested the team's chosen algorithm that shipped in the ferry planning application.", [routing], 'possessive team choice is attribution');
      supported('I implemented and tested a team-chosen algorithm that shipped in the ferry planning application.', [routing], 'team-chosen adjective is attribution');
      rejected('I worked with Imaginary Corporation on integrations.', [data], 'worked with cannot license a new entity');
      rejected('I helped build the inherited inventory system with the other engineer.', [inventory], 'helped cannot license inherited construction');
      rejected('I helped choose and implement the algorithm.', [routing], 'helped cannot license team-choice agency');
      rejected('We moved six systems with archived history.', [migration], 'moved cannot license a count');
      rejected('We helped reduce inventory costs.', [inventory], 'help cannot license an outcome');
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
      for (const flag of ['inherited', 'co-built', 'retired']) assert(inventory.candorFlags.includes(flag), `inventory must compile ${flag}`);
      assert(integrations.candorFlags.includes('mixed-solo-co-built'), 'mixed attribution must preserve the solo/shared split');
      assert(migration.candorFlags.includes('co-built'), 'migration must retain joint ownership');
      assert(routing.candorFlags.includes('team-chosen'), 'prior team decision must constrain candidate verbs');
      rejected('I built the inventory system.', [inventory], 'inherited ownership');
      rejected('I designed the routing algorithm.', [routing], 'team-chosen ownership');
      rejected('I chose the algorithm and implemented it.', [routing], 'candidate choice');
      rejected('I built the integrations.', [integrations], 'mixed work represented as all solo');
      supported('Some integrations I built solo, others we co-built.', [integrations], 'qualified mixed ownership');
      supported('We added role-restricted access controls for internal staff members to the inventory system.', [inventory], 'shared inherited maintenance');
      supported('The inventory system was eventually retired for a third-party platform.', [inventory], 'retired status');
    },
  },
  {
    name: 'interview spoken claims: invented metrics, entities, technologies and spoken note leaks fail',
    run() {
      rejected('We reduced inventory costs by 47%.', [inventory], 'invented percentage');
      rejected('We reduced inventory costs.', [inventory], 'unsupported outcome without a metric');
      rejected('I shipped cron jobs syncing daily data.', [cron], 'unsupported shipping');
      rejected('I maintained cron jobs using Rust.', [cron], 'invented technology');
      rejected('I maintained cron jobs at Imaginary Corporation.', [cron], 'invented employer');
      rejected('We maintained the inventory system (not built by me originally).', [inventory], 'parenthetical leak');
      rejected('We maintained the inventory system. Technologies used: Preact.', [inventory], 'technology boilerplate leak');
      rejected('I implemented the routing algorithm. I tested it.', [routing], 'multiple sentences in one claim');
      supported('I implemented and tested the routing algorithm that shipped in a ferry planning application.', [routing], 'supported shipping');
      supported('I maintained cron jobs syncing daily data from the CWA, including DOCKs.', [cron], 'exact technology names');
    },
  },
  {
    name: 'interview spoken claims: spoken numbers bind to cited quantities without licensing other facts',
    run() {
      supported('I delivered a migration over about four months with another engineer, without interrupting daily operations.', [migration], 'spoken approximate duration');
      supported('We migrated the systems over about four months with archived history.', [migration], 'spoken duration');
      rejected('We migrated the systems over about six months with archived history.', [migration], 'different duration');
      rejected('We migrated six systems with archived history over about four months.', [migration], 'unbound quantity');
      rejected('We migrated the systems and increased daily operations by four percent.', [migration], 'matching number in a new percentage');
    },
  },
  {
    name: 'interview spoken claims: headline and bullet limits reject long or unspeakable layouts',
    run() {
      const long = 'I maintained the inventory system with another engineer and added access for internal staff members while keeping the system available for everyone across all of the daily operations and scheduled work.';
      assert(long.split(/\s+/u).length > 29 && interviewHeadlineFailures(long).length > 0, 'a 30-word headline must reject');
      for (const text of [
        'I maintained the inventory system with another engineer: we added role-restricted staff access.',
        'I maintained the inventory system with another engineer; we added role-restricted staff access.',
        'I maintained the inventory system with another engineer (we added role-restricted access).',
        'The inventory system was maintained with another engineer and role-restricted access was added.',
      ]) assert(interviewHeadlineFailures(text).length > 0, 'headline punctuation and first-person active voice must be enforced');
      assert(interviewBulletFailures('We added access.').length > 0, 'bullet below eight words must reject');
      assert(interviewBulletFailures('We maintained the inventory system with another engineer while adding role-restricted staff access for internal staff members across the cooperative.').length > 0, 'bullet above eighteen words must reject');
    },
  },
  {
    name: 'interview spoken claims: narrow evidence never supplies an invented problem or outcome',
    run() {
      const narrow = source('narrow', 'Built RPC APIs for the local warehouse database to provide controlled access. Technologies used: Quartz.');
      assert(!interviewQuestionFit('Walk me through a technical problem.', 'I built RPC APIs giving controlled access to a local warehouse database.', [narrow]), 'a deliverable alone cannot claim a documented technical problem');
      assert(!interviewQuestionFit('Tell me about a result from your work.', 'I built RPC APIs giving controlled access to a local warehouse database.', [narrow]), 'a deliverable alone cannot supply a measured or shipped result');
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
      rejected('We migrated four platforms with archived history and another engineer.', [migration], 'duration reused as a platform count');
      const measured = source('measured-units', 'I reduced errors by 2% over 3 months.');
      rejected('I reduced errors by 3%.', [measured], 'duration reused as a percentage');
      rejected('I reduced errors over two months.', [measured], 'percentage reused as a duration');
      supported('I reduced errors by two percent over three months.', [measured], 'spoken units preserve the measured relation');
    },
  },
  {
    name: 'interview spoken claims: coordinated and nominal clauses cannot steal the team decision',
    run() {
      rejected('I implemented and chose the routing algorithm that shipped in a ferry planning application.', [routing], 'coordinated candidate choice');
      rejected('I implemented the algorithm the team had chosen and I chose the routing algorithm.', [routing], 'candidate choice after team clause');
      rejected('I implemented the algorithm the team chose and I had chosen.', [routing], 'candidate choice after embedded team clause');
      rejected('My work was choosing and implementing the algorithm accurately.', [routing], 'nominal candidate choice');
      rejected('I accurately chose and implemented the algorithm that shipped.', [routing], 'adverb between candidate and choice');
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
      const retired = source('retired-tense', 'Maintained the system with another engineer. The system was eventually retired.');
      rejected('I maintain the system with another engineer.', [retired], 'simple present cannot revive a retired system');
      assert(rejected('I still maintain the retired system with another engineer.', [retired], 'retirement mention cannot license present maintenance').some(item => item.rule === 'INTERVIEW_ANSWER_RETIRED'), 'the retirement word must not mask ongoing action');
      supported('The system is retired.', [retired], 'present retirement status remains true');
      supported('I maintained the system with another engineer.', [retired], 'historical shared maintenance');
      const mixed = source('mixed-scope', 'Built integrations; some built solo by me, others co-built jointly with the other engineer.');
      rejected('We built all integrations together.', [mixed], 'all cannot replace a documented subset');
      supported('Some integrations I built solo, others we co-built.', [mixed], 'mixed ownership preserves both contributions');
    },
  },
];
