import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { targetEmploymentFrames, assertSourceQuoteLinksFinalText, __pasteUnitGroundingErrorsForTests } from '../../electron/ipc/localAiApplication.js';

const EMPLOYER = 'Northwind Labs';
const WORK = 'dispatch rosters for freight routes';
const QUOTE = `I built and rebuilt ${WORK}. I now run ${WORK}. My work on dispatch rosters cut triage time. I maintained ${WORK} and coordinated updates with the team during regular operations.`;
const OPTIONS = { identityTokens: [], targetTitle: 'Freight Systems Engineer', targetCompany: EMPLOYER, postingText: `${EMPLOYER} needs dispatch rosters for freight routes.` };
const render = text => text.replaceAll('{P}', `${EMPLOYER}'s`).replaceAll('{E}', EMPLOYER);
const flags = (text, options = {}, company = EMPLOYER) => targetEmploymentFrames(text, company, options);
function gateErrors(text, options = {}) {
  let completion = [];
  try { assertSourceQuoteLinksFinalText(text, [QUOTE], 'coverLetterParagraphs', 0, { ...OPTIONS, ...options }); }
  catch (error) { completion = error.validationFailures || [error.message]; }
  const drafting = __pasteUnitGroundingErrorsForTests({ unitLabel: 'Cover-letter paragraph', unitId: 'p1', finalText: text,
    evidenceIds: ['career-one'], acceptedEvidence: [{ id: 'career-one', sourceId: 'career-data', quote: QUOTE }],
    label: 'coverLetterParagraphs', sourceRoles: [{ title: 'Dispatch Engineer', company: 'Cedar Works' }], ...OPTIONS, ...options });
  return { completion, drafting };
}

const FRAMES = [
  {
    "group": "F1 sentence-initial \"At E,\"/\"At E I\"",
    "expect": "reject",
    "text": "At {E}, I built dispatch rosters for freight routes."
  },
  {
    "group": "F1 sentence-initial \"At E,\"/\"At E I\"",
    "expect": "reject",
    "text": "At {E} I built dispatch rosters for freight routes."
  },
  {
    "group": "F1 sentence-initial \"At E,\"/\"At E I\"",
    "expect": "reject",
    "text": "At {E}, I now run dispatch rosters for freight routes."
  },
  {
    "group": "F1 sentence-initial \"At E,\"/\"At E I\"",
    "expect": "reject",
    "text": "At {E}, my work on dispatch rosters cut triage time."
  },
  {
    "group": "F1 sentence-initial \"At E,\"/\"At E I\"",
    "expect": "reject",
    "text": "At {E}, I maintained dispatch rosters for freight routes and coordinated updates with the team."
  },
  {
    "group": "F1 sentence-initial \"At E,\"/\"At E I\"",
    "expect": "reject",
    "text": "At {E}, I run dispatch rosters for freight routes."
  },
  {
    "group": "F1 control: \"At E,\" + third person / modal (literal rule rejects; refined allows)",
    "expect": "allow-refined",
    "text": "At {E}, the team needs dependable dispatch tools."
  },
  {
    "group": "F1 control: \"At E,\" + third person / modal (literal rule rejects; refined allows)",
    "expect": "allow-refined",
    "text": "At {E}, engineers own dispatch tools end to end."
  },
  {
    "group": "F1 control: \"At E,\" + third person / modal (literal rule rejects; refined allows)",
    "expect": "allow-refined",
    "text": "At {E}, I would apply that experience to routing tools."
  },
  {
    "group": "F2 \"while at E\"",
    "expect": "reject",
    "text": "While at {E}, I built dispatch rosters for freight routes."
  },
  {
    "group": "F2 \"while at E\"",
    "expect": "reject",
    "text": "While working at {E}, I maintained dispatch rosters for freight routes."
  },
  {
    "group": "F2 \"while at E\"",
    "expect": "reject",
    "text": "I built dispatch rosters for freight routes while at {E}."
  },
  {
    "group": "F2 \"while at E\"",
    "expect": "reject",
    "text": "While at {E}, I run dispatch rosters for freight routes."
  },
  {
    "group": "F3 \"during my time at E\"",
    "expect": "reject",
    "text": "During my time at {E}, I built dispatch rosters for freight routes."
  },
  {
    "group": "F3 \"during my time at E\"",
    "expect": "reject",
    "text": "During my time at {E}, my work on dispatch rosters cut triage time."
  },
  {
    "group": "F3 \"during my time at E\"",
    "expect": "reject",
    "text": "Throughout my tenure at {E}, I maintained dispatch rosters for freight routes."
  },
  {
    "group": "F3 \"during my time at E\"",
    "expect": "reject",
    "text": "I built dispatch rosters for freight routes during my time at {E}."
  },
  {
    "group": "F3 \"during my time at E\"",
    "expect": "reject",
    "text": "During my years with {E}, I maintained dispatch rosters for freight routes."
  },
  {
    "group": "F4 \"my time/role/work/... at|with E\"",
    "expect": "reject",
    "text": "My role at {E} involves dispatch rosters for freight routes."
  },
  {
    "group": "F4 \"my time/role/work/... at|with E\"",
    "expect": "reject",
    "text": "My work at {E} covers dispatch rosters for freight routes."
  },
  {
    "group": "F4 \"my time/role/work/... at|with E\"",
    "expect": "reject",
    "text": "My time at {E} was spent on dispatch rosters for freight routes."
  },
  {
    "group": "F4 \"my time/role/work/... at|with E\"",
    "expect": "reject",
    "text": "My position with {E} centers on dispatch rosters for freight routes."
  },
  {
    "group": "F4 \"my time/role/work/... at|with E\"",
    "expect": "reject",
    "text": "I built dispatch rosters for freight routes in my role at {E}."
  },
  {
    "group": "F4 \"my time/role/work/... at|with E\"",
    "expect": "reject",
    "text": "My tenure at {E} began with dispatch rosters for freight routes."
  },
  {
    "group": "F4 \"my time/role/work/... at|with E\"",
    "expect": "reject",
    "text": "My job at {E} is running dispatch rosters for freight routes."
  },
  {
    "group": "F4 control: hypothetical \"my role at E would ...\"",
    "expect": "allow",
    "text": "I imagine my role at {E} would involve dispatch tooling."
  },
  {
    "group": "F5 \"worked/work at|for E\" (claim)",
    "expect": "reject",
    "text": "I worked at {E} on dispatch rosters for freight routes."
  },
  {
    "group": "F5 \"worked/work at|for E\" (claim)",
    "expect": "reject",
    "text": "I worked for {E} building dispatch rosters for freight routes."
  },
  {
    "group": "F5 \"worked/work at|for E\" (claim)",
    "expect": "reject",
    "text": "I have worked at {E} maintaining dispatch rosters for freight routes."
  },
  {
    "group": "F5 \"worked/work at|for E\" (claim)",
    "expect": "reject",
    "text": "I work at {E} and run dispatch rosters for freight routes."
  },
  {
    "group": "F5 \"worked/work at|for E\" (claim)",
    "expect": "reject",
    "text": "I currently work for {E} maintaining dispatch rosters for freight routes."
  },
  {
    "group": "F5 \"worked/work at|for E\" (claim)",
    "expect": "reject",
    "text": "I am working at {E} on dispatch rosters for freight routes."
  },
  {
    "group": "F5 control: modal / intent \"work at E\"",
    "expect": "allow",
    "text": "I would love to work at {E}."
  },
  {
    "group": "F5 control: modal / intent \"work at E\"",
    "expect": "allow",
    "text": "I would love to work for {E} on dispatch tooling."
  },
  {
    "group": "F5 control: modal / intent \"work at E\"",
    "expect": "allow",
    "text": "I hope to work at {E} on dispatch tooling."
  },
  {
    "group": "F5 control: modal / intent \"work at E\"",
    "expect": "allow",
    "text": "I am excited to work at {E}."
  },
  {
    "group": "F5 control: modal / intent \"work at E\"",
    "expect": "allow",
    "text": "Working at {E} would let me run dispatch rosters at scale."
  },
  {
    "group": "F5 control: modal / intent \"work at E\"",
    "expect": "allow",
    "text": "I want to work for {E}."
  },
  {
    "group": "F6 \"joined E\" / \"since joining E\"",
    "expect": "reject",
    "text": "I joined {E} and built dispatch rosters for freight routes."
  },
  {
    "group": "F6 \"joined E\" / \"since joining E\"",
    "expect": "reject",
    "text": "Since joining {E}, I have maintained dispatch rosters for freight routes."
  },
  {
    "group": "F6 \"joined E\" / \"since joining E\"",
    "expect": "reject",
    "text": "I joined the {E} team and now run dispatch rosters for freight routes."
  },
  {
    "group": "F6 \"joined E\" / \"since joining E\"",
    "expect": "reject",
    "text": "When I joined {E}, I built dispatch rosters for freight routes."
  },
  {
    "group": "F6 \"joined E\" / \"since joining E\"",
    "expect": "reject",
    "text": "Since I joined {E}, I have run dispatch rosters for freight routes."
  },
  {
    "group": "F6 control: future \"join E\"",
    "expect": "allow",
    "text": "I look forward to joining {E}."
  },
  {
    "group": "F6 control: future \"join E\"",
    "expect": "allow",
    "text": "Joining {E} would be a natural step."
  },
  {
    "group": "F6 control: future \"join E\"",
    "expect": "allow",
    "text": "I would like to join {E}."
  },
  {
    "group": "F6 control: future \"join E\"",
    "expect": "allow",
    "text": "I am excited about joining {E}."
  },
  {
    "group": "F7 \"as a(n) E <role noun>\"",
    "expect": "reject",
    "text": "As a {E} engineer, I built dispatch rosters for freight routes."
  },
  {
    "group": "F7 \"as a(n) E <role noun>\"",
    "expect": "reject",
    "text": "As an {E} developer I maintained dispatch rosters for freight routes."
  },
  {
    "group": "F7 \"as a(n) E <role noun>\"",
    "expect": "reject",
    "text": "I built dispatch rosters for freight routes as a {E} engineer."
  },
  {
    "group": "F7 \"as a(n) E <role noun>\"",
    "expect": "reject",
    "text": "As a {E} software engineer, I now run dispatch rosters for freight routes."
  },
  {
    "group": "F7 control: \"as an engineer ... {E}\"",
    "expect": "allow",
    "text": "As an engineer who cares about dependable tools, I would like to join {E}."
  },
  {
    "group": "F8 \"rejoin / return to E\"",
    "expect": "reject",
    "text": "I am excited to rejoin {E}."
  },
  {
    "group": "F8 \"rejoin / return to E\"",
    "expect": "reject",
    "text": "I would like to return to {E}."
  },
  {
    "group": "F8 \"rejoin / return to E\"",
    "expect": "reject",
    "text": "I want to come back to {E} and run dispatch rosters for freight routes."
  },
  {
    "group": "F8 \"rejoin / return to E\"",
    "expect": "reject",
    "text": "I would love to go back to {E}."
  },
  {
    "group": "F8 \"rejoin / return to E\"",
    "expect": "reject",
    "text": "I look forward to rejoining {E}."
  },
  {
    "group": "F8 \"rejoin / return to E\"",
    "expect": "reject",
    "text": "Rejoining {E} would be a natural step."
  },
  {
    "group": "F8 \"rejoin / return to E\"",
    "expect": "reject",
    "text": "I am ready to return to {E} and run dispatch rosters for freight routes."
  }
];
const MUST_ALLOW = [
  {
    "group": "at/with/for E, claim-free",
    "text": "I would love to work at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I am excited about the role at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "My application to {E} reflects a long interest in freight software."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I am applying for the Freight Systems Engineer role at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "The routing challenge at {E} interests me."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I would be glad to work for {E} on dispatch tooling."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I look forward to a conversation with {E} about the role."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I would welcome the chance to discuss the role with {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "Thank you for considering my application for the role at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I would like to bring that approach to the team at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "The Freight Systems Engineer position at {E} matches the work I do best."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I am drawn to the engineering culture at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I hope to work with {E} on dispatch tooling."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I would like to work with the routing team at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I have followed the product work at {E} with interest."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I found the opening at {E} while researching freight software."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "Working at {E} would let me apply this experience every day."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I would enjoy working for a team like the one at {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "The mission at {E} fits the kind of work I want to do next."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I am eager to talk with {E} about how my roster work could help."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "A role at {E} would be a good fit for my dispatch roster experience."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I would welcome the chance to work for {E}."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I am excited to work at {E} on dispatch tooling."
  },
  {
    "group": "at/with/for E, claim-free",
    "text": "I imagine my role at {E} would involve dispatch tooling."
  }
];


// Amendment-7 review phrasings: synthetic fixtures, copied verbatim.
const WORK_AT_ALLOWED = [
 'I would bring the tooling I built to the platform team at Northwind Labs.',
 'I want to apply what I built to the dispatch problems at Northwind Labs.',
 'What I built for schools maps to the routing work at Northwind Labs.',
 "I'd bring the dashboards I designed to the analytics team at Northwind Labs.",
 'I am excited to apply what I learned building rosters to the challenges at Northwind Labs.',
 'The pipeline I built handles the same scale the team at Northwind Labs describes.',
 'I built tools that help teams like those at Northwind Labs.',
 'I design systems for the kind of customers at Northwind Labs.',
 'I build reliable services and would enjoy doing so at Northwind Labs.',
 'I write code that would fit right in at Northwind Labs.',
 'I built dispatch rosters at Cedar Works and would bring that experience to Northwind Labs.',
 'I led the migration at Cedar Works, which mirrors the platform work at Northwind Labs.',
 'I maintain the same standard of testing the engineers at Northwind Labs describe.',
 'I support the kind of reliability goals the team at Northwind Labs has set.',
 'I developed an interest in freight software as a user at Northwind Labs.',
 'I build the sort of tooling the engineers at Northwind Labs rely on.',
 'I manage releases with the same care the posting at Northwind Labs asks for.',
 'I would build the same rigor into the dispatch platform at Northwind Labs.',
 'I lead projects end to end, as the role at Northwind Labs requires.',
 'I designed the roster engine at Cedar Works to the standard at Northwind Labs.',
];
const WORK_AT_MORE_ALLOWED = [
 'I build the kind of reliable services customers at Northwind Labs expect.',
 'I wrote about freight routing after reading the engineering blog at Northwind Labs.',
 'I led workshops on the same tools the analysts at Northwind Labs use.',
 'I ship features quickly, which matches the pace at Northwind Labs.',
 'I design for accessibility, a priority I noticed at Northwind Labs.',
 'I handle on-call rotations calmly, something the posting at Northwind Labs stresses.',
 'I support the mission at Northwind Labs.',
 'I work best on small teams like the one at Northwind Labs.',
 'I code daily in Go, the main language at Northwind Labs.',
 'I lead with clear written specs, the norm at Northwind Labs.',
];
const WORK_AT_CLAIMS = [
 'I now run dispatch rosters for freight routes at Northwind Labs.',
 'I rebuilt dispatch rosters for freight routes at Northwind Labs.',
 'I currently lead the dispatch team at Northwind Labs.',
 'I built the roster service at Northwind Labs.',
 'I am applying for the roster role that I rebuilt at Northwind Labs.',
 'We shipped the routing engine at Northwind Labs.',
 'I maintain the billing pipeline at Northwind Labs.',
 'I rebuilt dispatch rosters for freight routes with the team at Northwind Labs.',
];

export default [
  {
    name: 'Amendment 9 item 2 bounds masked blank runs repeated starts and raw spaces below 50 ms',
    async run() {
      const guardUrl = new URL('../../electron/ipc/applicationEmploymentGuard.js', import.meta.url).href;
      const rows = await new Promise((resolve, reject) => {
        const measurements = [];
        const worker = new Worker(`
          import('node:worker_threads').then(({ parentPort, workerData }) => import(workerData).then(({ targetEmploymentFrames: guard }) => {
            const cases = [
              ['ws3-2050', 'I built '.repeat(125) + 'northwind labs '.repeat(70)],
              ['ws3-8200', 'I built '.repeat(500) + 'northwind labs '.repeat(280)],
              ['lowercase-interspersed', 'I built tools at northwind labs '.repeat(80)],
              ['approved-mask-blank-run', 'I built '.repeat(125) + 'Cedar Works '.repeat(110), { approvedOrganizations: ['Cedar Works'] }],
              ['repeated-starts', 'I built '.repeat(300)],
              ['raw-spaces', 'I built ' + ' '.repeat(2400) + 'x'],
              ['raw-spaces-after-starts', 'I built '.repeat(100) + ' '.repeat(2400) + 'x'],
            ];
            // Masking writes U+2063, so the cases run on two-byte strings; warm both
            // string representations or the first case times V8's regex compile.
            for (let i = 0; i < 30; i++) {
              guard('I built rosters at Cedar Works.', 'Northwind Labs');
              guard('I built rosters at northwind labs and Cedar Works.', 'Northwind Labs', { approvedOrganizations: ['Cedar Works'] });
            }
            for (const [name, text, options] of cases) {
              const start = performance.now();
              guard(text, 'Northwind Labs', options);
              parentPort.postMessage({ row: { name, chars: text.length, elapsedMs: performance.now() - start } });
            }
            parentPort.postMessage({ done: true });
          })).catch(error => { throw error; });
        `, { eval: true, workerData: guardUrl });
        const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Employment guard exceeded the isolated 2 second limit')); }, 2000);
        worker.on('message', message => {
          if (message.row) {
            measurements.push(message.row);
            if (message.row.elapsedMs >= 50) {
              clearTimeout(timer); void worker.terminate();
              reject(new Error(`${message.row.name}: ${message.row.elapsedMs.toFixed(2)} ms exceeds 50 ms`));
            }
          } else if (message.done) { clearTimeout(timer); void worker.terminate(); resolve(measurements); }
        });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
      });
      assert.equal(rows.length, 7);
      for (const row of rows) {
        assert.ok(row.chars >= 2000, row.name);
        assert.ok(row.elapsedMs < 50, `${row.name}: ${row.elapsedMs.toFixed(2)} ms`);
      }
      return rows;
    },
  },
  {
    name: 'Amendment 9 item 4 keeps contraction leads in prior affiliation claims',
    run() {
      for (const text of [`I'm excited to return to ${EMPLOYER}.`, `I'd love to return to ${EMPLOYER}.`]) {
        assert.equal(flags(text)[0]?.frame, 'rejoin-return-resume', text);
      }
    },
  },
  {
    name: 'Amendment 9 item 4 masks both lowercase mentions and preserves the Title-case claim index',
    run() {
      const text = 'I built tools at northwind labs. I built tools at northwind labs. I built tools at Northwind Labs.';
      assert.equal(flags(text)[0]?.index, text.lastIndexOf('I built'));
      const approved = 'Cedar Works Holdings, northwind labs northwind labs: I built tools at Northwind Labs.';
      assert.equal(flags(approved, { approvedOrganizations: ['Cedar Works Holdings'] })[0]?.index, approved.indexOf('I built'));
    },
  },
  {
    name: 'Amendment 9 item 4 rejects a 5000-character company before dynamic regex compilation',
    run() {
      const NativeRegExp = globalThis.RegExp;
      let compiled = 0;
      try {
        globalThis.RegExp = new Proxy(NativeRegExp, { construct(target, args) {
          compiled++;
          return Reflect.construct(target, ['(?!)', args[1]]);
        } });
        flags('I worked at Northwind Labs.', {}, 'N'.repeat(5000));
        assert.equal(compiled, 0, 'Overlong company must return before compiling any regex');
      } finally { globalThis.RegExp = NativeRegExp; }
    },
  },
  {
    name: 'Amendment 8 item 12 handles null options unicode rejoin and bounded company names without throwing',
    run() {
      const text = 'I worked at Northwind Labs.';
      for (const options of [null, {}, { approvedOrganizations: null }, { approvedCareerEmployers: null },
        { approvedOrganizations: 'Cedar Works' }, { approvedCareerEmployers: 'Cedar Works' },
        { approvedOrganizations: [null, undefined, 5, {}, ''] }, { approvedCareerEmployers: [null, undefined, 5, {}] }]) {
        assert.doesNotThrow(() => flags(text, options));
        assert.ok(flags(text, options).length);
      }
      for (const dash of ['-', '‐', '‑', '‒', '–', '—', '―']) {
        assert.ok(flags(`I would re${dash}join Northwind Labs.`).length, dash);
        assert.ok(flags(`Re${dash}joining Northwind Labs would be a natural step.`).length, dash);
      }
      assert.deepEqual(flags(text, {}, 'N'.repeat(50000)), []);
      assert.deepEqual(flags(text, {}, 'Northwind '.repeat(1000)), []);
      assert.ok(flags(text, {}, 'Northwind Labs - ' + 'N'.repeat(1000)).length);
      assert.deepEqual(flags(text, {}, Object.create(null)), []);
      assert.deepEqual(flags(Object.create(null)), []);
    },
  },
  {
    name: 'Amendment 8 item 11 preserves target names containing an approved shorter organization',
    run() {
      for (const text of ['At Northwind Labs, I rebuilt rosters.', 'I worked at Northwind Labs.', 'My time at Northwind Labs shaped the rosters.', 'I joined Northwind Labs.', 'I rebuilt rosters at Northwind Labs.']) {
        assert.ok(flags(text, { approvedOrganizations: ['Northwind'], approvedCareerEmployers: ['Northwind'] }).length, text);
        assert.ok(flags(text, { approvedOrganizations: ['Northwind Labs'] }).length, text);
      }
      assert.deepEqual(flags('I worked at Northwind Labs Holdings.', { approvedOrganizations: ['Northwind Labs Holdings'] }), []);
      assert.deepEqual(flags('I worked at Northwind Labs, Inc.', { approvedOrganizations: ['Northwind Labs, Inc.'] }), []);
      assert.ok(flags('I worked at Northwind Labs.', { approvedOrganizations: ['Cedar Works'] }).length);
    },
  },
  {
    name: 'Amendment 8 item 10 matches legal and parenthetical forms and typographic apostrophes without brand aliases',
    run() {
      for (const company of ['Northwind Labs, Inc.', 'Northwind Labs LLC', 'Northwind Labs (Regional)', 'Northwind Labs Corp (NW)']) {
        assert.ok(flags('I joined Northwind Labs.', {}, company).length, company);
        assert.ok(flags('I worked at Northwind Labs.', {}, company).length, company);
        assert.deepEqual(flags('I worked at Northwind.', {}, company), [], company);
      }
      for (const [company, text] of [["Osprey's", 'I worked at Osprey’s.'], ['Osprey’s', "I worked at Osprey's."], ["Osprey's", 'I worked at Ospreyʼs.']]) {
        assert.ok(flags(text, {}, company).length, text);
        assert.deepEqual(flags(text, { approvedCareerEmployers: ["Osprey's"] }, company), [], text);
      }
      assert.deepEqual(flags('At Northwind Labs, I rebuilt rosters.', { approvedCareerEmployers: ['Northwind Labs'] }, 'Northwind Labs (Regional)'), []);
    },
  },
  {
    name: 'Amendment 8 item 9 exempts approved career employers through each frozen target form',
    run() {
      for (const company of ['Cedar Works - Logistics Platform', 'Cedar Works | Logistics', 'Cedar Works, Inc.']) {
        assert.deepEqual(flags('At Cedar Works, I rebuilt dispatch rosters.', { approvedCareerEmployers: ['Cedar Works'] }, company), [], company);
      }
      assert.ok(flags('At Cedar Works, I rebuilt dispatch rosters.', { approvedCareerEmployers: ['Cedar Works Logistics'] }, 'Cedar Works - Logistics Platform').length);
      assert.ok(flags('At Northwind Labs, I rebuilt dispatch rosters.', { approvedCareerEmployers: ['Cedar Works'] }).length);
    },
  },
  {
    name: 'Amendment 8 item 7 distinguishes lowercase target words and tool experience with the target',
    run() {
      for (const [company, text] of [
        ['Remote', 'I built scheduling tools for remote teams.'],
        ['Scale', 'I operated payment services at scale.'],
        ['Box', 'I built a pipeline for box score data.'],
        ['Shift', 'I built rosters for shift workers.'],
        ['Target', 'I built reports for target accounts.'],
      ]) {
        assert.deepEqual(flags(text, {}, company), [], text);
        assert.ok(flags(text.replace(company.toLowerCase(), company), {}, company).length, company);
        assert.ok(flags(text.replace(company.toLowerCase(), company.toUpperCase()), {}, company).length, company.toUpperCase());
      }
      for (const noun of ['experience', 'work']) {
        assert.deepEqual(flags(`My ${noun} with Zephyr integrations shaped my roster tools.`, {}, 'Zephyr'), []);
        assert.ok(flags(`My ${noun} at Zephyr shaped my roster tools.`, {}, 'Zephyr').length);
      }
      assert.ok(flags('I worked at remote.', {}, 'remote').length, 'A lowercase frozen company retains its literal form');
      assert.ok(flags('My role with Zephyr involves dispatch tools.', {}, 'Zephyr').length);
    },
  },
  {
    name: 'Amendment 8 item 6 keeps every employment frame below 50 ms for long degenerate input',
    async run() {
      const guardUrl = new URL('../../electron/ipc/applicationEmploymentGuard.js', import.meta.url).href;
      const rows = await new Promise((resolve, reject) => {
        const worker = new Worker(`
          import('node:worker_threads').then(({ parentPort, workerData }) => import(workerData).then(({ targetEmploymentFrames: guard }) => {
            const tail = 'roster details '.repeat(160);
            const cases = [
              ['initial-at', 'At Northwind Labs, I ' + tail],
              ['while-at', 'While at Northwind Labs, I ' + tail],
              ['during-my-time-at', 'During my time at Northwind Labs, I ' + tail],
              ['my-time-role-at', 'My role at Northwind Labs involves ' + tail],
              ['worked-at', 'I worked at Northwind Labs on ' + tail],
              ['present-work-at', 'I work at Northwind Labs on ' + tail],
              ['joined', 'I joined Northwind Labs for ' + tail],
              ['since-joining', 'Since joining Northwind Labs, I ' + tail],
              ['as-target-role', 'As a Northwind Labs engineer, I ' + tail],
              ['work-for', 'I built ' + tail + 'for Northwind Labs.'],
              ['work-at', 'I built ' + tail + 'at Northwind Labs.'],
              ['member-of-team', 'As a member of the Northwind Labs team, I ' + tail],
              ['where-i', 'Northwind Labs is where I ' + tail],
              ['our-team-at', 'Our team at Northwind Labs owns ' + tail],
              ['continuity', 'I would return to Northwind Labs with ' + tail],
              ['am-excited-to-chain', 'I ' + 'am excited to '.repeat(160) + 'x'],
              ['repeated-work-clauses', 'I built roster tooling '.repeat(100)],
            ];
            guard('I would return to Northwind Labs.', 'Northwind Labs');
            const rows = cases.map(([name, text]) => {
              const start = performance.now();
              guard(text, 'Northwind Labs');
              return { name, chars: text.length, elapsedMs: performance.now() - start };
            });
            parentPort.postMessage(rows);
          })).catch(error => { throw error; });
        `, { eval: true, workerData: guardUrl });
        const timer = setTimeout(() => { void worker.terminate(); reject(new Error('Employment guard exceeded the isolated 2 second limit')); }, 2000);
        worker.once('message', rows => { clearTimeout(timer); void worker.terminate(); resolve(rows); });
        worker.once('error', error => { clearTimeout(timer); reject(error); });
      });
      for (const row of rows) {
        assert.ok(row.chars >= 2000, row.name);
        assert.ok(row.elapsedMs < 50, `${row.name}: ${row.elapsedMs.toFixed(2)} ms`);
      }
      return rows;
    },
  },
  {
    name: 'Amendment 7 work-at rejects all eight work claims while preserving thirty forward-looking at sentences',
    run() {
      assert.equal(WORK_AT_CLAIMS.length, 8);
      assert.equal(WORK_AT_ALLOWED.length + WORK_AT_MORE_ALLOWED.length, 30);
      for (const text of [...WORK_AT_ALLOWED, ...WORK_AT_MORE_ALLOWED]) assert.deepEqual(flags(text, { approvedCareerEmployers: ['Cedar Works'], approvedOrganizations: ['Cedar Works'] }), [], text);
      for (const text of WORK_AT_CLAIMS) {
        assert.ok(flags(text).length, text);
        for (const errors of Object.values(gateErrors(text))) assert.ok(errors.some(error => error.includes('states work at')), text);
      }
    },
  },
  {
    name: 'Amendment 6 narrow employment guard covers all 44 measured claims and permits the frame controls',
    run() {
      assert.equal(FRAMES.filter(row => row.expect === 'reject').length, 44);
      for (const row of FRAMES) {
        const text = render(row.text);
        assert.equal(flags(text).length > 0, row.expect === 'reject', text);
        if (row.expect === 'reject') for (const errors of Object.values(gateErrors(`I built ${WORK}. ${text}`))) {
          assert.ok(errors.some(error => error.includes('states work at')), text);
        }
      }
    },
  },
  {
    name: 'Amendment 6 keeps the 24 at with for intent sentences outside the guard',
    run() { for (const row of MUST_ALLOW) assert.deepEqual(flags(render(row.text)), [], row.text); },
  },
  {
    name: 'Amendment 6 first-person initial at and joined-company object refinements',
    run() {
      for (const text of [`At ${EMPLOYER}, the team needs dispatch tools.`, `At ${EMPLOYER}, I would apply that experience.`,
        `At ${EMPLOYER}, I definitely would improve reliability.`,
        `At ${EMPLOYER}, my work on dispatch systems would improve reliability.`,
        `At ${EMPLOYER}, my goal would be to help with ${WORK}.`,
        ...['webinar', 'event', 'talk', 'meetup', 'call', 'newsletter'].flatMap(noun => [`I joined ${EMPLOYER}'s ${noun}.`, `I joined ${EMPLOYER}’s ${noun}.`]),
        `While at ${EMPLOYER}, I would use my roster experience.`, `During my time at ${EMPLOYER}, I would use roster experience.`,
        `As a ${EMPLOYER} engineer, I would use my roster experience.`, `I met a colleague who joined ${EMPLOYER}.`,
        `I look forward to hearing how your alumni return to ${EMPLOYER}.`,
        `I would love to hear why your engineers rejoin ${EMPLOYER}.`,
        `My interviewers will return to ${EMPLOYER} after the conference.`,
        `The team will return to ${EMPLOYER} after the conference.`,
        `The team worked at ${EMPLOYER}.`, `The team joined ${EMPLOYER}.`]) assert.deepEqual(flags(text), [], text);
      for (const text of [`At ${EMPLOYER}, I rebuilt ${WORK}.`, `At ${EMPLOYER}, our work covers ${WORK}.`, `I joined ${EMPLOYER}.`]) assert.ok(flags(text).length, text);
    },
  },
  {
    name: 'Amendment 6 new employment and prior affiliation frames tighten both gates',
    run() {
      for (const text of [`I run ${WORK} for ${EMPLOYER}.`, `I rebuilt ${WORK} for ${EMPLOYER}.`,
        `I proudly work for ${EMPLOYER}.`, `As a member of the ${EMPLOYER} team, I run ${WORK}.`,
        `${EMPLOYER} is where I run ${WORK}.`, `Our team at ${EMPLOYER} owns ${WORK}.`,
        `I would love to return to ${EMPLOYER}.`, `I am excited to re-join ${EMPLOYER}.`,
        `I would resume work at ${EMPLOYER}.`, `I am eager to continue at ${EMPLOYER}.`,
        ...['again', 'once more', 'anew'].map(tail => `I am excited to join ${EMPLOYER} ${tail}.`)]) {
        assert.ok(flags(text).length, text);
        for (const errors of Object.values(gateErrors(`I built ${WORK}. ${text}`))) assert.ok(errors.some(error => error.includes('states work at')), text);
      }
    },
  },
  {
    name: 'Amendment 6 exact possessive and pre-separator names are guarded without brand matching',
    run() {
      for (const company of [EMPLOYER, `${EMPLOYER} - Freight`, `${EMPLOYER} | Freight`]) {
        assert.ok(flags(`At ${EMPLOYER}, I rebuilt ${WORK}.`, {}, company).length, company);
        assert.ok(flags(`At ${company}, I rebuilt ${WORK}.`, {}, company).length, company);
      }
      assert.ok(flags(`At ${EMPLOYER}'s, I rebuilt ${WORK}.`).length);
      assert.deepEqual(flags(`At Northwind, I rebuilt ${WORK}.`), []);
      assert.deepEqual(flags('My time at Northwind Health taught me to coordinate rosters.'), []);
      for (const company of ['QX', 'ZV']) assert.ok(flags(`At ${company}, I rebuilt ${WORK}.`, {}, company).length);
      for (const text of [`My work at ${EMPLOYER} - Platform would focus on dispatch tools.`, `Our team at ${EMPLOYER} - Platform would build dispatch tools.`]) assert.deepEqual(flags(text, {}, `${EMPLOYER} - Platform`), [], text);
    },
  },
  {
    name: 'Amendment 6 masks approved organization names before matching and exempts only a career employer',
    run() {
      for (const row of FRAMES) assert.deepEqual(flags(render(row.text), { approvedCareerEmployers: [EMPLOYER] }), [], row.text);
      for (const approved of ['career employer', 'school', 'issuer', 'project']) {
        const company = 'Cedar'; const name = `Cedar ${approved}`;
        assert.deepEqual(flags(`At ${name}, I rebuilt ${WORK}.`, { approvedOrganizations: [name] }, company), [], approved);
      }
      assert.ok(flags(`At ${EMPLOYER}, I rebuilt ${WORK}.`, { approvedOrganizations: ['Cedar Works'] }).length);
      assert.ok(flags(`I would return to ${EMPLOYER}.`, { approvedOrganizations: ['Cedar Works'] }).length);
    },
  },
  {
    name: 'Amendment 6 restores baseline rejection of past reading verbs including team sources',
    run() {
      for (const verb of ['reviewed', 'noticed', 'browsed', 'watched', 'learned', 'discovered']) {
        for (const source of ['posting', 'team']) {
          const text = `I built ${WORK}. I ${verb} ${EMPLOYER}'s ${source}.`;
          for (const errors of Object.values(gateErrors(text))) {
            assert.ok(errors.length, `${verb} ${source}`);
          }
        }
      }
    },
  },
  {
    name: 'Amendment 6 keeps the first-person relative application claim tightening',
    run() {
      for (const relative of ['that', 'which']) {
        for (const errors of Object.values(gateErrors(`I built ${WORK}. I am applying for the role ${relative} I led across forty Initech sites.`))) assert.ok(errors.length);
      }
    },
  },
];
