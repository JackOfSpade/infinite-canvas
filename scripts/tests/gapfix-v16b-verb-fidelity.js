// Source-verb fidelity, hardening round. A statement that puts the candidate in a
// SUPPORT role for work that itself carries out an action (or that the candidate
// only took part in) never supports a sentence that makes the candidate the
// actor of that action, or the maker of that work, unless a statement says so.
//
// Round one pinned the core lifecycle (gapfix-v16-verb-fidelity.js). An adversarial
// review then found that the checks it shipped could be switched off, or
// bypassed, by cheap rewordings. This file pins each of those, with fixtures
// from six unrelated invented fields (library cataloguing, bridge inspection,
// retail analytics, freight depots, school timetabling, sequencing labs) and a
// mutation for each rule (flip one piece of evidence or one flag of a temporary
// fixture and the admissibility flips):
//
//   authorship   "the same work" is decided by the CLAUSE that states the
//                authorship (the noun phrase its verb acts on), never by the
//                sentence it sits in: an unrelated "built ..." clause joined to the
//                support clause, a dashboard that merely shares two generic words,
//                and documentation FOR the work do not release the claim
//   support      a support role is stated only by the candidate's own support verb
//                about THIS work, or the statement's own support noun beside it; a
//                word that is a support word as a noun elsewhere ("services",
//                "aid", "keep") switches nothing off, and a claim verb that IS the
//                work's action does not state a role merely because the verb is a
//                support verb
//   ladder       a creation verb whose direct object is the supported work itself
//                skips two rungs whatever the work's action is; the perform and own
//                rungs over the work are NOT compared here (documented boundary)
//   shapes       ", which ...", "(which ...)", a reduced relative after a plural work,
//                and "assisted in <V>ing ...", "helped <V> ..." frames are read; outcome
//                and instrumental participles, singular reduced relatives and nouns
//                that look like activities are not
//   stems        the abbreviation / spelling branch of the stem rule is a threshold:
//                a table of stem pairs across fields, with the boundary cases
//   wording      the observation states the mismatch and BOTH faithful repairs
//   fuzz         thousands of ordinary bullets against quotes that contain no
//                support-class head are never findings
//
// Every fixture is SYNTHETIC. Nothing in production names any of them.
import { assert } from './testHelpers.js';
import { assertSourceQuoteLinksFinalText } from '../../electron/ipc/localAiApplication.js';
import {
  ROLE_STRENGTH_CLASSES, SUPPORT_HEAD_NOUNS, candidateActions, describeRoleStrengthFinding, roleStrengthFindings, sameActionStem, supportAssertions,
} from '../../electron/ipc/applicationRoleStrength.js';
import { relatednessStem } from '../../electron/ipc/applicationClaimGrounding.js';

// `v` is the verb form that agrees with the work (plural or singular) inside a relative clause.
const DOMAINS = Object.freeze([
  {
    key: 'library cataloguing', plural: true, work: 'catalogue import jobs', Work: 'Catalogue import job', base: 'catalogue', s: 'catalogues', ing: 'cataloguing', past: 'Cataloged',
    object: 'new acquisitions for the reading rooms',
    alt: 'new donor letters for the reading rooms', altOther: 'old donor maps for the reading rooms',
    made: 'Developed the catalogue import jobs for the reading rooms.', done: 'Cataloged new acquisitions by hand when an import failed.',
    other: 'Shelved returned periodicals each morning.', otherMade: 'Wrote a handout for new patrons.',
    frame: { ing: 'designing', base: 'design', past: 'Designed', thing: 'the shelf-label kiosk for the reading rooms' },
  },
  {
    key: 'bridge inspection', plural: true, work: 'bridge inspection tools', Work: 'Bridge inspection tool', base: 'estimate', s: 'estimates', ing: 'estimating', past: 'Estimated',
    object: 'load ratings for steel girders',
    alt: 'load plans for the northern bridges', altOther: 'weather alerts for the northern bridges',
    made: 'Developed the bridge inspection tools for the county.', done: 'Estimated load ratings for steel girders by hand after the audit.',
    other: 'Surveyed culverts along the county roads.', otherMade: 'Drafted a field manual for inspectors.',
    frame: { ing: 'building', base: 'build', past: 'Built', thing: 'the culvert load calculator for the county' },
  },
  {
    key: 'retail analytics', plural: true, work: 'weekly sales digests', Work: 'Weekly sales digest', base: 'summarise', s: 'summarises', ing: 'summarising', past: 'Summarized',
    object: 'store sales by region for the buyers',
    alt: 'store traffic by region for the planners', altOther: 'supplier lead times by region for the planners',
    made: 'Wrote the weekly sales digests for the buyers.', done: 'Summarized store sales by region for the buyers whenever a digest failed.',
    other: 'Priced clearance racks for the spring sale.', otherMade: 'Created a signage kit for the new stores.',
    frame: { ing: 'developing', base: 'develop', past: 'Developed', thing: 'the markdown planner for the buyers' },
  },
  {
    key: 'freight depots', plural: true, work: 'depot slotting scripts', Work: 'Depot slotting script', base: 'prep', s: 'preps', ing: 'prepping', past: 'Prepared',
    object: 'pallet manifests for outbound trucks',
    alt: 'pallet labels for outbound trailers', altOther: 'driver rosters for outbound trailers',
    made: 'Programmed the depot slotting scripts for the outbound dock.', done: 'Prepared pallet manifests for outbound trucks by hand during outages.',
    other: 'Loaded trailers at the east dock.', otherMade: 'Designed a yard map for the night crew.',
    frame: { ing: 'implementing', base: 'implement', past: 'Implemented', thing: 'the dock appointment board for the depots' },
  },
  {
    key: 'school timetabling', plural: false, work: 'timetable generator', Work: 'Timetable generator', base: 'organise', s: 'organises', ing: 'organising', past: 'Organized',
    object: 'class rotas for the upper school',
    alt: 'class lists for the upper school staff', altOther: 'exam fees for the upper school staff',
    made: 'Built the timetable generator for the upper school.', done: 'Organized class rotas for the upper school by hand each term.',
    other: 'Chaperoned field trips for year nine.', otherMade: 'Developed a parent newsletter for the lower school.',
    frame: { ing: 'launching', base: 'launch', past: 'Launched', thing: 'the exam seating planner for the upper school' },
  },
  {
    key: 'sequencing labs', plural: false, work: 'sequencing quality pipeline', Work: 'Sequencing quality pipeline', base: 'analyse', s: 'analyses', ing: 'analysing', past: 'Analyzed',
    object: 'read depth across sample batches',
    alt: 'read lengths across sample runs', altOther: 'freezer logs across sample runs',
    made: 'Implemented the sequencing quality pipeline for the sample batches.', done: 'Analyzed read depth across sample batches manually when the pipeline stalled.',
    other: 'Labeled freezer racks for the cold room.', otherMade: 'Created a sample intake form for the front bench.',
    frame: { ing: 'running', base: 'run', past: 'Ran', thing: 'the batch review sessions for the sample batches' },
  },
]);
const verb = d => (d.plural ? d.base : d.s);

const catalogQuote = (text, id = 'ach-0001') => `- Achievement [${id}]: ${text}`;
function judge(text, quotes, { label = 'resumeBullets', identityTokens = [], ...options } = {}) {
  try {
    assertSourceQuoteLinksFinalText(text, quotes.map((quote, index) => catalogQuote(quote, `ach-${index + 1}`)), label, 0, { identityTokens, ...options });
    return '';
  } catch (error) { return String(error?.message || error); }
}
const MISMATCH = /Observed class mismatch/u;
const mismatch = (...args) => MISMATCH.test(judge(...args));
const findings = (text, quotes) => roleStrengthFindings(text, quotes.map((quote, index) => catalogQuote(quote, `ach-${index + 1}`)));
const rejected = (text, quotes) => findings(text, quotes).length > 0;

const inflated = d => `${d.past} ${d.object}.`;
const statement = d => `${d.Work} maintenance that ${d.s} ${d.object}.`;

// Words that are a support word as a noun in some other phrase: each tacked on to an otherwise rejected bullet.
const NOUN_DECOYS = Object.freeze([
  'for the financial services team', 'for the support group', 'for the aid office', 'beside the castle keep', 'for the help desk',
  'for the monitoring group', 'with the assistance fund', 'for the upkeep budget', 'near the tend office', 'for the operation managers',
]);

export default [
  {
    name: 'Authorship: "the same work" is decided by the clause that states the authorship, never by the sentence around it (semicolon, comma and conjunction joins, two generic words, documentation FOR the work), and flips with the evidence (six fields)',
    run() {
      let checks = 0;
      for (const d of DOMAINS) {
        const text = inflated(d);
        const support = statement(d);
        assert(rejected(text, [support]), `${d.key}: control — the inflated bullet is a finding`);
        // An unrelated build clause joined to the SUPPORT clause licenses nothing: the support clause itself used to supply the shared terms.
        for (const joiner of ['; built', ', designed', ' and wrote', ' and then launched']) {
          const joined = `${support.replace(/\.$/u, '')}${joiner} a lobby display for the front office.`;
          assert(rejected(text, [joined]), `${d.key}: an unrelated build clause joined by "${joiner}" must not release ${JSON.stringify(text)}`);
          assert(mismatch(text, [joined]), `${d.key}: the production gate agrees for "${joiner}"`);
          checks += 2;
        }
        // A quote that shares two or more generic words with the work's action but is another thing the candidate built.
        const dashboard = `Built a dashboard that visualizes ${d.object}.`;
        assert(rejected(text, [support, dashboard]), `${d.key}: a dashboard sharing every word of the action's object is another thing`);
        assert(mismatch(text, [support, dashboard]), `${d.key}: the production gate agrees`);
        // Documentation, a template, a runbook FOR the work is not the work.
        for (const about of ['documentation', 'a runbook', 'a status dashboard', 'a test harness']) {
          const quote = `Wrote ${about} for the ${d.work}.`;
          assert(rejected(text, [support, quote]), `${d.key}: "${quote}" is about the work, not the work`);
          checks += 1;
        }
        // The action done on OTHER objects, sharing two generic words with this one.
        const otherObject = d.object.split(' ').slice(-3).join(' ');
        assert(rejected(text, [support, `${d.past} reports about ${otherObject} for audits.`]), `${d.key}: the same verb on another object that shares words is not this action`);
        // Releases, with the same shape of evidence: the candidate made the work / did the action on the same object.
        assert(!rejected(text, [support, d.made]), `${d.key}: B a quote that makes the work releases it`);
        assert(!rejected(text, [support, d.done]), `${d.key}: B a quote that does the action releases it`);
        assert(judge(text, [support, d.made]) === '', `${d.key}: the production gate admits it with the quote that makes the work`);
        assert(judge(text, [support, d.done]) === '', `${d.key}: the production gate admits it with the quote that does the action`);
        // The statement itself says the candidate built AND maintained the work.
        const both = `Built and maintained the ${d.work} that ${verb(d)} ${d.object}.`;
        assert(!rejected(text, [both]), `${d.key}: one statement that builds and maintains the work releases it`);
        assert(!rejected(text, [`Designed, built, and maintained the ${d.work} that ${verb(d)} ${d.object}.`]), `${d.key}: a list of three coordinated verbs shares the work`);
        // Mutation: the same release quote with a different head noun is no longer the work; restore it and it is.
        const wrongHead = d.made.replace(d.work, `${d.work.split(' ').slice(0, -1).join(' ')} schedules`);
        assert(wrongHead !== d.made && rejected(text, [support, wrongHead]), `${d.key}: mutation — the made quote about another head noun (${JSON.stringify(wrongHead)}) no longer releases`);
        assert(!rejected(text, [support, d.made]), `${d.key}: mutation restored — it releases again`);
        // Mutation: the quote that makes the work is the vendor's, not the candidate's — nothing to release with.
        const vendor = `The vendor built the ${d.work} for the team.`;
        assert(rejected(text, [support, vendor]), `${d.key}: a quote whose maker is the vendor releases nothing`);
        // The candidate made it in a relative clause of the quote's own ("the jobs that I wrote").
        assert(!rejected(text, [support, `Maintained the ${d.work} that I wrote.`]), `${d.key}: "the ${d.work} that I wrote" is the candidate making the work`);
        assert(rejected(text, [support, 'Maintained the intake spreadsheet that I wrote.']), `${d.key}: mutation — a spreadsheet the candidate wrote is another thing`);
        // The claim's own statement: the candidate did the very action the bullet claims, on the very thing it claims it on, in a
        // quote about a different object than the work's action acts on. Without this a truthful two-quote bullet could never pass.
        const alt = `${d.past} ${d.alt}.`;
        const altQuote = `${d.past} ${d.alt.replace(/ (?:for|across|by) .*$/u, '')} by hand when the work was down.`;
        assert(rejected(alt, [support]), `${d.key}: control — ${JSON.stringify(alt)} against the support statement alone is a finding`);
        assert(!rejected(alt, [support, altQuote]), `${d.key}: a quote of the candidate doing that action on that thing releases ${JSON.stringify(alt)}`);
        assert(judge(alt, [support, altQuote]) === '', `${d.key}: the production gate admits it`);
        const otherQuote = altQuote.replace(d.alt.replace(/ (?:for|across|by) .*$/u, ''), d.altOther.replace(/ (?:for|across|by) .*$/u, ''));
        assert(otherQuote !== altQuote && rejected(alt, [support, otherQuote]), `${d.key}: mutation — the same action on another thing (${JSON.stringify(otherQuote)}) releases nothing`);
        checks += 4;
      }
      return { checks };
    },
  },
  {
    name: 'Support role: only the candidate\'s own support verb about THIS work (or the statement\'s own support noun beside it) states the role; a support word as a noun elsewhere, or a claim verb that IS the work\'s action, switches nothing off (six fields)',
    run() {
      for (const d of DOMAINS) {
        const support = statement(d);
        // Ten decoys, each a support word that is a noun in another phrase, appended to the inflated bullet.
        for (const decoy of NOUN_DECOYS) {
          const text = `${d.past} ${d.object} ${decoy}.`;
          assert(rejected(text, [support]), `${d.key}: "${decoy}" must not state a support role (${JSON.stringify(text)})`);
          assert(mismatch(text, [support]), `${d.key}: the production gate agrees for "${decoy}"`);
          // The same decoy beside a REAL support verb about this work is admitted, so the decoy is the only difference.
          assert(!rejected(`Maintained the ${d.work} and ${d.past.toLowerCase()} ${d.object} ${decoy}.`, [support]), `${d.key}: with a real support verb about the work the decoy sentence is admitted`);
        }
        // A single-clause bullet gets no free pass from a stray word: the same words, one clause.
        assert(rejected(`${d.past} ${d.object} for the services desk.`, [support]), `${d.key}: a single clause with a stray support noun is still a finding`);
        // The support verb must be about THIS work.
        assert(rejected(`${d.past} ${d.object}; maintained the intake spreadsheet.`, [support]), `${d.key}: a support verb about other work states no role`);
        assert(rejected(`Maintained rota templates and ${d.past.toLowerCase()} ${d.object}.`, [support]), `${d.key}: nor does a support verb whose object only shares one generic word`);
        assert(!rejected(`${d.past} ${d.object}; maintained the ${d.work}.`, [support]), `${d.key}: a support verb about this work, after a semicolon, states the role`);
        assert(!rejected(`${d.past} ${d.object} while maintaining the ${d.work}.`, [support]), `${d.key}: a support participle about this work states it`);
        assert(!rejected(`Provided ${d.work} maintenance, ${d.ing} ${d.object}.`, [support]), `${d.key}: the statement's own support noun beside the work states it`);
        assert(!rejected(`${d.past} ${d.object} as the ${d.work} maintenance lead.`, [support]), `${d.key}: the support noun as the candidate's role ("as the ... lead") states it`);
        // A support verb in a relative clause of the candidate's own acts on what the clause is about ("the jobs that I maintain").
        assert(!rejected(`${d.past} ${d.object} through the ${d.work} that I maintain.`, [support]), `${d.key}: "the ${d.work} that I maintain" states the role`);
        assert(!rejected(`${d.past} ${d.object} through the ${d.work}, which we maintain for the team.`, [support]), `${d.key}: ", which we maintain" states the role`);
        assert(rejected(`${d.past} ${d.object} through the intake spreadsheet that I maintain.`, [support]), `${d.key}: mutation — the same clause about another work states nothing`);
        // ... and a making verb there is the maker's claim on the antecedent: it is a creation claim, released only by a statement.
        assert(rejected(`${d.past} ${d.object} through the ${d.work} that I wrote.`, [support]), `${d.key}: "the ${d.work} that I wrote" claims the making of the work`);
        assert(!rejected(`${d.past} ${d.object} through the ${d.work} that I wrote.`, [support, d.made]), `${d.key}: and a quote that makes the work releases it`);
        assert(rejected(`${d.past} ${d.object} ahead of the maintenance window.`, [support]), `${d.key}: a support noun that is not beside the work states nothing`);
        // The reviewer's shape: a claim whose own verb is a support verb that IS the work's action.
      }
      const verbIsAction = [
        ['Provided nursing support that administered medications to 12 patients per shift.', 'Administered medications to 12 patients per shift.', 'Administered medications to 12 patients per shift by hand when the cart was down.'],
        ['Provided plant support that monitored boiler pressure for the night crew.', 'Monitored boiler pressure for the night crew.', 'Monitored boiler pressure for the night crew from the control room.'],
        ['Provided yard support that serviced forklifts for the loading dock.', 'Serviced forklifts for the loading dock.', 'Serviced forklifts for the loading dock every Friday.'],
        ['Pool upkeep that maintained chlorine levels for the swim club.', 'Maintained chlorine levels for the swim club.', 'Maintained chlorine levels for the swim club with test strips.'],
      ];
      for (const [quote, claim, doneQuote] of verbIsAction) {
        assert(rejected(claim, [quote]), `${JSON.stringify(claim)}: a claim verb that is the work's own action is not a stated support role`);
        assert(mismatch(claim, [quote]), `${JSON.stringify(claim)}: the production gate agrees`);
        assert(!rejected(claim, [quote, doneQuote]), `${JSON.stringify(claim)}: a quote that says the candidate did it releases the claim (mutation)`);
        assert(rejected(claim, [quote, 'Chaired the safety committee for the site.']), `${JSON.stringify(claim)}: an unrelated quote releases nothing`);
      }
    },
  },
  {
    name: 'Ladder: a creation verb whose direct object is the supported work skips two rungs (with no stem in common with the work\'s action), the perform and own rungs are not compared, and a no-false-positive corpus of ordinary bullets stays quiet (six fields)',
    run() {
      const CREATION = ['Rebuilt', 'Redesigned', 'Refactored', 'Constructed', 'Produced', 'Automated', 'Assembled', 'Crafted', 'Rewrote', 'Implemented', 'Architected', 'Programmed', 'Established', 'Launched', 'Devised'];
      let verdicts = 0;
      for (const d of DOMAINS) {
        const support = `Maintenance of the ${d.work} that ${verb(d)} ${d.object}.`;
        for (const creation of CREATION) {
          const text = `${creation} the ${d.work} for the team.`;
          const found = findings(text, [support]);
          assert(found.length === 1 && found[0].shape === 'creation' && found[0].claimClass === 'created or owned', `${d.key}: ${JSON.stringify(text)} must be one creation finding (got ${JSON.stringify(found)})`);
          const message = describeRoleStrengthFinding('Bullet "b1"', found[0]);
          assert(/presents the candidate as the maker of “[^”]+” “[^”]+”/u.test(message) && /no cited statement says the candidate made it/u.test(message), `${d.key}: the creation observation names the claim and the missing statement`);
          // B: a quote that says the candidate made THIS work releases it; C: remove it and it is rejected again.
          assert(!rejected(text, [support, d.made]), `${d.key}: ${creation} — B a quote that makes the work releases it`);
          assert(rejected(text, [support, d.otherMade]), `${d.key}: ${creation} — a quote that makes other work releases nothing`);
          assert(rejected(text, [support, d.done]), `${d.key}: ${creation} — doing the work's action is not making the work`);
          verdicts += 4;
        }
        // The production gate reads it too.
        assert(mismatch(`Rebuilt the ${d.work} for the team.`, [support]), `${d.key}: the production gate rejects a creation claim over a supported work`);
        assert(!mismatch(`Rebuilt the ${d.work} for the team.`, [support, d.made]), `${d.key}: and not once a quote makes the work`);
        // The work's own head noun matters: another thing for the work, or a thing of another name, is not the work.
        for (const text of [
          `Rebuilt a dashboard for the ${d.work}.`, `Designed documentation for the ${d.work}.`, `Wrote a runbook covering the ${d.work}.`,
          `Built a test harness for the ${d.work}.`, `Rebuilt the ${d.work} schedule template.`, `Crafted onboarding notes for new owners of the ${d.work}.`,
          d.otherMade, `Rebuilt the ${d.work.split(' ')[0]} calendar for the team.`,
        ]) {
          assert(!rejected(text, [support]), `${d.key}: ${JSON.stringify(text)} is not a creation claim over the work`);
          verdicts += 1;
        }
        // The rungs that are NOT compared over the work itself: perform and own. This pins the documented boundary (the
        // strength-family gate orders leadership words; "run" over a maintained work is the adjacent rung).
        for (const text of [`Ran the ${d.work} every night.`, `Managed the ${d.work} for the team.`, `Oversaw the ${d.work} during the audit.`]) {
          assert(!rejected(text, [support]), `${d.key}: ${JSON.stringify(text)} is the perform or own rung, which this module does not compare over a supported work`);
          verdicts += 1;
        }
        // The support statement is what makes a creation claim a finding: without it, nothing is asserted.
        assert(!rejected(`Rebuilt the ${d.work} for the team.`, [d.made]) && !rejected(`Rebuilt the ${d.work} for the team.`, [`Operated the ${d.work} for the team.`]), `${d.key}: no support statement, no finding`);
        // And a support statement of another work leaves this claim alone.
        assert(!rejected(`Rebuilt the ${d.work} for the team.`, ['Maintenance of the staff intranet that publishes weekly notices.']), `${d.key}: support of another work leaves it alone`);
        // A claim with the support stated for the same work in the same sentence still claims the creation: only a statement releases it.
        assert(rejected(`Rebuilt and maintained the ${d.work} for the team.`, [support]), `${d.key}: stating the support role does not release a creation claim in the same sentence`);
        verdicts += 3;
      }
      // The vocabulary is the ordered classes; the rung skip reads the ranks (creation is two above support).
      const [support, perform, create] = ROLE_STRENGTH_CLASSES;
      assert(create.rank - support.rank === 2 && perform.rank - support.rank === 1, 'ranks: creation is two rungs above support, performance one');
      return { verdicts };
    },
  },
  {
    name: 'Shapes: a comma-led "which", a parenthesised "which", a reduced relative after a plural work and "assisted in <V>ing" frames are read, the same inflation is rejected in each and its faithful rewrite and its release are admitted (six fields)',
    run() {
      for (const d of DOMAINS) {
        const text = inflated(d);
        const faithful = `Maintained the ${d.work} and ${d.past.toLowerCase()} ${d.object}.`;
        const done = d.past.toLowerCase();
        const shapes = [
          ['non-restrictive relative', `Monitored the ${d.work}, which ${d.s} ${d.object}.`, `Monitored the ${d.work} and ${done} ${d.object}.`],
          ['parenthesised relative', `Maintained the ${d.work} (which ${verb(d)} ${d.object}).`, `Maintained the ${d.work} (and ${done} ${d.object}).`],
          ['relative after a long work phrase', `Maintained the ${d.work} for the operations group, which ${d.s} ${d.object}.`, `Maintained the ${d.work} for the operations group and ${done} ${d.object}.`],
          ['non-restrictive noun shape', `Maintenance of the ${d.work}, which ${d.s} ${d.object}.`, `Maintenance of the ${d.work}; ${done} ${d.object}.`],
          ['parenthesised noun shape', `Maintenance of the ${d.work} (which ${d.s} ${d.object}).`, `Maintenance of the ${d.work} (${done} ${d.object}).`],
          ...(d.plural ? [['reduced relative', `Maintained ${d.work} ${d.ing} ${d.object}.`, `Maintained ${d.work} and ${done} ${d.object}.`]] : []),
        ];
        for (const [name, quote, mutated] of shapes) {
          assert(supportAssertions(quote).length === 1, `${d.key} / ${name}: the statement is read as one assertion (got ${supportAssertions(quote).length})`);
          assert(rejected(text, [quote]), `${d.key} / ${name}: ${JSON.stringify(text)} must be a finding`);
          assert(mismatch(text, [quote]), `${d.key} / ${name}: the production gate agrees`);
          assert(!rejected(faithful, [quote]), `${d.key} / ${name}: the faithful rewrite is admitted`);
          assert(!rejected(text, [quote, d.made]) && !rejected(text, [quote, d.done]), `${d.key} / ${name}: a quote that makes the work, or does the action, releases it`);
          assert(rejected(text, [quote, d.otherMade]), `${d.key} / ${name}: an unrelated quote does not`);
          // Mutation: the clause is the candidate's own words, not the work's — nothing is asserted.
          assert(supportAssertions(mutated).length === 0 && !rejected(text, [mutated]), `${d.key} / ${name}: mutation — the clause as the candidate's own words asserts nothing (${JSON.stringify(mutated)})`);
        }
        // A singular work's reduced relative is ambiguous (a participle of the candidate or a modifier) and is not read.
        if (!d.plural) assert(supportAssertions(`Maintained the ${d.work} ${d.ing} ${d.object}.`).length === 0, `${d.key}: a reduced relative after a singular work is not read`);
        // Verbs that say what a work is built from, not what it does ("uses", "leverages"), are not an action handed to it either.
        for (const stative of ['uses', 'utilizes', 'leverages', 'features', 'includes', 'contains']) {
          assert(supportAssertions(`${d.Work} maintenance that ${stative} ${d.object}.`).length === 0, `${d.key}: "that ${stative}" is not an action of the work`);
        }
        // Participles that state a purpose, an outcome or an instrument are not what a work does.
        for (const participle of ['ensuring', 'improving', 'reducing', 'using', 'utilizing', 'leveraging', 'featuring', 'including', 'providing', 'enabling', 'running']) {
          assert(supportAssertions(`Maintained ${d.work} ${participle} ${d.object}.`).length === 0, `${d.key}: "${participle}" after a plural work is not an action handed to it`);
        }
        // Frames: the candidate took part in an activity the vocabulary classes.
        const { ing, base, past, thing } = d.frame;
        const frames = [
          ['assisted ... in', `Assisted the platform team in ${ing} ${thing}.`],
          ['contributed to', `Contributed to ${ing} ${thing}.`],
          ['participated in', `Participated in ${ing} ${thing}.`],
          ['helped (base verb)', `Helped ${base} ${thing}.`],
          ['assisted with', `Assisted with ${ing} ${thing}.`],
        ];
        for (const [name, quote] of frames) {
          const claim = `${past} ${thing}.`;
          assert(supportAssertions(quote).length === 1 && supportAssertions(quote)[0].kind === 'frame', `${d.key} / ${name}: one frame assertion`);
          assert(rejected(claim, [quote]), `${d.key} / ${name}: ${JSON.stringify(claim)} takes over the activity the candidate only took part in`);
          assert(mismatch(claim, [quote]), `${d.key} / ${name}: the production gate agrees`);
          assert(!rejected(`Assisted in ${ing} ${thing}.`, [quote]), `${d.key} / ${name}: the faithful restatement is admitted`);
          assert(!rejected(claim, [quote, claim]), `${d.key} / ${name}: a quote that says the candidate did it releases the claim`);
          assert(rejected(claim, [quote, d.otherMade]), `${d.key} / ${name}: an unrelated quote does not`);
          assert(!rejected(`${past} a volunteer roster for the open day.`, [quote]), `${d.key} / ${name}: another thing is not the activity`);
          const message = describeRoleStrengthFinding('Bullet "b1"', findings(claim, [quote])[0]);
          assert(/in “[^”]+” the work, not that the candidate alone did it/u.test(message), `${d.key} / ${name}: the frame observation says the part the candidate took`);
        }
        // Nouns that look like activities are not read: no determiner for the object, or an unclassed activity.
        assert(supportAssertions(`Assisted in ${ing} inspections for the county.`).length === 0, `${d.key}: "${ing} inspections" is a noun phrase, not an activity with an object`);
        assert(supportAssertions('Assisted users in resetting passwords for the portal.').length === 0, `${d.key}: an activity the vocabulary does not class is not read`);
        assert(supportAssertions(`Assisted code review for the ${d.work}.`).length === 0, `${d.key}: "code review" is not "code" the verb`);
      }
    },
  },
  {
    name: 'Stem rule: the abbreviation / spelling branch is a threshold (prefix of at least four letters covering at least three quarters of the shorter stem), proven on a table of pairs across fields and on the boundary, and end to end through the gate',
    run() {
      const stem = relatednessStem;
      const SAME = [
        // an abbreviation and its long form
        ['prep', 'prepared'], ['preps', 'prepare'], ['calcs', 'calculated'], ['configs', 'configured'], ['recons', 'reconciled'], ['admins', 'administered'],
        ['demos', 'demonstrated'], ['auths', 'authenticated'],
        // two spellings of one verb
        ['organises', 'organized'], ['catalogues', 'cataloged'], ['analyses', 'analyzed'], ['summarising', 'summarized'], ['optimise', 'optimized'], ['digitise', 'digitized'],
        // inflections
        ['compiles', 'compiled'], ['recording', 'recorded'], ['dispatches', 'dispatched'],
      ];
      const DIFFERENT = [
        ['compiles', 'computed'], ['processed', 'procured'], ['managed', 'manually'], ['repairs', 'reported'], ['calculate', 'calendar'], ['reconcile', 'recount'],
        ['classify', 'classroom'], ['verifies', 'verbalized'], ['inspected', 'insured'], ['scheduled', 'schooled'], ['trained', 'transcribed'], ['audited', 'auctioned'],
        ['dispatched', 'displayed'], ['estimates', 'establishes'], ['prepared', 'presented'],
      ];
      for (const [left, right] of SAME) assert(sameActionStem(stem(left), stem(right)), `${left} / ${right} (${stem(left)} | ${stem(right)}) name one action`);
      for (const [left, right] of DIFFERENT) assert(!sameActionStem(stem(left), stem(right)), `${left} / ${right} (${stem(left)} | ${stem(right)}) name two actions`);
      // The boundary, on bare letter runs: prefix >= 4 AND prefix >= ceil(0.75 * shorter length).
      const boundary = [
        ['abcdefgh', 'abcdefxy', true],  // 6 of 8 = 75 percent
        ['abcdefgh', 'abcdexyz', false], // 5 of 8
        ['abcdef', 'abcdxy', false],     // 4 of 6 = 67 percent
        ['abcdef', 'abcdey', true],      // 5 of 6
        ['abcde', 'abcdy', true],        // 4 of 5
        ['abcd', 'abcdq', true],         // 4 of 4
        ['abc', 'abcd', false],          // three letters is never enough
        ['abcdefghij', 'abcdefghxy', true],
        ['abcdefghij', 'abcdefgxyz', false], // 7 of 10
        ['abcdefghij', 'abcdefgxyz', false],
        ['', 'abcd', false], ['abcd', '', false],
      ];
      for (const [left, right, expected] of boundary) assert(sameActionStem(left, right) === expected, `boundary ${left} / ${right}: expected ${expected}`);
      assert(sameActionStem('compil', 'compil') && sameActionStem('x', 'x'), 'equal stems are one action');
      // End to end: the statement uses one form, the claim another, in six fields (the branch carries four of them).
      const pairs = [
        ['library cataloguing', 'Catalogue import job maintenance that catalogues new acquisitions for the reading rooms.', 'Cataloged new acquisitions for the reading rooms.', true],
        ['school timetabling', 'Timetable generator maintenance that organises class rotas for the upper school.', 'Organized class rotas for the upper school.', true],
        ['sequencing labs', 'Sequencing quality pipeline maintenance that analyses read depth across sample batches.', 'Analyzed read depth across sample batches.', true],
        ['freight depots', 'Depot slotting script maintenance that preps pallet manifests for outbound trucks.', 'Prepared pallet manifests for outbound trucks.', true],
        ['retail analytics', 'Weekly sales digest maintenance that summarises store sales by region for the buyers.', 'Summarized store sales by region for the buyers.', true],
        ['bridge inspection', 'Bridge inspection tool maintenance that estimates load ratings for steel girders.', 'Estimated load ratings for steel girders.', true],
        // two different actions that share a beginning
        ['different action', 'Report job maintenance that compiles ledger summaries for the finance team.', 'Computed ledger summaries for the finance team.', false],
        ['different action', 'Intake queue maintenance that processes patient referrals for the clinic.', 'Procured patient referrals for the clinic.', false],
        ['different action', 'Field kit maintenance that repairs cracked casings for the survey crew.', 'Reported cracked casings for the survey crew.', false],
      ];
      for (const [key, quote, claim, expected] of pairs) {
        assert(rejected(claim, [quote]) === expected, `${key}: ${JSON.stringify(claim)} against ${JSON.stringify(quote)} should be ${expected ? 'a finding' : 'quiet'}`);
        assert(mismatch(claim, [quote]) === expected, `${key}: the production gate agrees`);
      }
    },
  },
  {
    name: 'Observation: states the class mismatch and BOTH faithful repairs, names no vocabulary verb outside the evidence and the claim, and is the same words for every shape',
    run() {
      // The class names the observation is required to state ("supported", "performed", "created or owned") are the English
      // words they are, not examples of a verb to copy.
      const classWords = new Set(['support', 'perform', 'own', 'create']);
      for (const d of DOMAINS) {
        const rows = [
          [inflated(d), statement(d)],
          [`Rebuilt the ${d.work} for the team.`, `Maintenance of the ${d.work} that ${verb(d)} ${d.object}.`],
          [`${d.frame.past} ${d.frame.thing}.`, `Assisted the platform team in ${d.frame.ing} ${d.frame.thing}.`],
        ];
        for (const [claim, quote] of rows) {
          const [found] = findings(claim, [quote]);
          assert(found, `${d.key}: ${JSON.stringify(claim)} is a finding`);
          const message = describeRoleStrengthFinding('Bullet "b1"', found);
          assert(/Observed class mismatch: the source says the candidate supported it; the text claims the candidate (?:performed|created or owned) it\./u.test(message), `${d.key}: the observed class mismatch is stated`);
          assert(/Two repairs are faithful\. Either hold the candidate to the support role the statement gives, stating that role in this same sentence in your own words with a verb that matches it/u.test(message), `${d.key}: the first repair`);
          assert(/or, only where the career data really says the candidate made the work or did the action themself, cite that statement as well as this one\./u.test(message), `${d.key}: the second repair`);
          const residue = message.replace(/“[^”]*”/gu, ' ');
          for (const klass of ROLE_STRENGTH_CLASSES) {
            for (const vocabularyVerb of klass.verbs.filter(entry => !classWords.has(entry))) {
              assert(!new RegExp(`\\b${vocabularyVerb}(?:s|d|ed|ing)?\\b`, 'iu').test(residue), `${d.key}: the observation must not name the vocabulary verb "${vocabularyVerb}" outside the evidence and the claim`);
            }
          }
          // Nothing of the candidate's own career is in the fixed words: the same message with the quoted parts blanked is one string.
          assert(residue.replace(/\s+/gu, ' ').includes('Observed class mismatch'), `${d.key}: fixed words only outside the quotes`);
        }
      }
      // The fixed words differ only by the class the claim stands at (a verb the vocabulary ranks as creation reads "created or
      // owned", the others "performed"): within one class they are one string in every field.
      const fixed = new Map();
      for (const d of DOMAINS) {
        const [found] = findings(inflated(d), [statement(d)]);
        if (!fixed.has(found.claimClass)) fixed.set(found.claimClass, new Set());
        fixed.get(found.claimClass).add(describeRoleStrengthFinding('Bullet', found).replace(/“[^”]*”/gu, '“”'));
      }
      for (const [claimClass, words] of fixed) assert(words.size === 1, `the fixed words are the same in every field for the class "${claimClass}" (got ${words.size} variants)`);
    },
  },
  {
    name: 'Fuzz: thousands of ordinary bullets (every class of verb, six fields) against quotes that contain no support-class head are never role-strength findings, and neither are bullets from one field against support statements of another',
    run() {
      // A small seeded generator (mulberry32): deterministic, no dependency.
      let state = 0x9e3779b9;
      const random = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const pick = list => list[Math.floor(random() * list.length)];
      const FIELDS = [
        { nouns: ['pallet counts', 'dock schedules', 'carrier invoices', 'route sheets', 'load plans'], places: ['the east yard', 'the northern hub', 'the regional dock'], things: ['yard appointment board', 'route cost sheet', 'carrier scorecard'] },
        { nouns: ['patient referrals', 'clinic rosters', 'lab requisitions', 'reminder texts', 'intake forms'], places: ['the front desk', 'the pediatric ward', 'the outpatient clinic'], things: ['appointment reminder app', 'intake kiosk', 'roster board'] },
        { nouns: ['ledger entries', 'vendor invoices', 'budget variances', 'tax schedules', 'audit samples'], places: ['the finance team', 'the audit committee', 'the treasury office'], things: ['nightly close checklist', 'variance workbook', 'invoice matching macro'] },
        { nouns: ['soil samples', 'rainfall totals', 'culvert surveys', 'span ratings', 'crack reports'], places: ['the county roads', 'the research farm', 'the river basin'], things: ['field sensor stations', 'survey tablet app', 'culvert atlas'] },
        { nouns: ['class lists', 'exam papers', 'lesson plans', 'attendance sheets', 'reading lists'], places: ['the sixth form', 'the language department', 'the music wing'], things: ['seating planner', 'reading list portal', 'rehearsal calendar'] },
        { nouns: ['shelf labels', 'catalogue records', 'loan statistics', 'acquisition lists', 'reading room signs'], places: ['the central library', 'the archive', 'the map room'], things: ['loan dashboard', 'shelf-label kiosk', 'donor register'] },
      ];
      const VERBS = [
        // support class
        'Maintained', 'Monitored', 'Administered', 'Assisted', 'Helped', 'Supported', 'Kept', 'Serviced',
        // perform class
        'Ran', 'Operated', 'Executed', 'Performed', 'Handled', 'Completed', 'Delivered', 'Processed',
        // create and own class
        'Built', 'Developed', 'Designed', 'Created', 'Rebuilt', 'Redesigned', 'Automated', 'Implemented', 'Led', 'Managed', 'Owned', 'Directed',
        // not in the vocabulary
        'Compiled', 'Reconciled', 'Tabulated', 'Scheduled', 'Trained', 'Summarized', 'Estimated', 'Cataloged', 'Prepared', 'Organized',
      ];
      const PARTICIPLES = ['compiling', 'tracking', 'routing', 'reconciling', 'building', 'designing', 'running', 'scheduling', 'training', 'maintaining', 'monitoring', 'managing', 'summarizing'];
      const bullet = field => {
        const noun = pick(field.nouns);
        const place = pick(field.places);
        const thing = pick(field.things);
        const verbWord = pick(VERBS);
        const template = Math.floor(random() * 8);
        if (template === 0) return `${verbWord} ${noun} for ${place}.`;
        if (template === 1) return `${verbWord} the ${thing} for ${place}.`;
        if (template === 2) return `I ${verbWord.toLowerCase()} ${noun} at ${place}.`;
        if (template === 3) return `${verbWord} ${noun} and ${pick(VERBS).toLowerCase()} the ${thing}.`;
        if (template === 4) return `${verbWord} the ${thing} ${random() < 0.5 ? 'by' : 'through'} ${pick(PARTICIPLES)} ${noun}.`;
        if (template === 5) return `${verbWord} ${noun}; ${pick(VERBS).toLowerCase()} ${place} ${pick(field.nouns)}.`;
        if (template === 6) return `${verbWord} ${random() < 0.5 ? 'weekly' : 'nightly'} ${noun}, ${pick(PARTICIPLES)} ${pick(field.nouns)}.`;
        return `My experience ${pick(PARTICIPLES)} ${noun} shows in ${thing}.`;
      };
      // Quotes with NO support-class head: a verb the vocabulary does not class, or a creation / ownership / performance verb, with a relative clause or not.
      const plainQuote = field => {
        const noun = pick(field.nouns);
        const thing = pick(field.things);
        const place = pick(field.places);
        const actor = pick(['Built', 'Developed', 'Designed', 'Led', 'Managed', 'Ran', 'Compiled', 'Reconciled', 'Trained', 'Wrote', 'Created']);
        const lower = pick(['compiles', 'records', 'sends', 'routes', 'tracks', 'reconciles', 'flags']);
        const template = Math.floor(random() * 6);
        if (template === 0) return `${actor} the ${thing} that ${lower} ${noun} for ${place}.`;
        if (template === 1) return `${actor} ${noun} for ${place}, cutting turnaround by 30 percent.`;
        if (template === 2) return `${actor} a team of 4 that ${lower} ${noun}.`;
        if (template === 3) return `${actor} ${noun} and the ${thing} for ${place}.`;
        if (template === 4) return `Weekly ${noun} reports, ${pick(['tracking', 'routing', 'flagging'])} ${pick(field.nouns)} for ${place}.`;
        return `${actor} the ${thing}; ${pick(['Trained', 'Mentored', 'Scheduled'])} ${noun} for ${place}.`;
      };
      const SUPPORT_WORD = new RegExp(`\\b(?:${SUPPORT_HEAD_NOUNS.join('|')}|maintain(?:ed|s|ing)?|monitor(?:ed|s|ing)?|administer(?:ed|s|ing)?|assist(?:ed|s|ing)?|help(?:ed|s|ing)?|support(?:ed|s|ing)?|keep|kept|service[sd]?|servicing|participat(?:ed|es|ing)|contribut(?:ed|es|ing)|aid(?:ed|s)?|tend(?:ed|s)?)\\b`, 'iu');
      let total = 0;
      for (let round = 0; round < 5400; round += 1) {
        const field = FIELDS[round % FIELDS.length];
        const quotes = [plainQuote(field), plainQuote(field), plainQuote(field)].slice(0, 1 + (round % 3));
        for (const quote of quotes) assert(!SUPPORT_WORD.test(quote), `the fuzz quote must hold no support-class head (${JSON.stringify(quote)})`);
        const text = bullet(field);
        const found = findings(text, quotes);
        assert(found.length === 0, `round ${round}: ${JSON.stringify(text)} against ${JSON.stringify(quotes)} must be quiet (got ${JSON.stringify(found)})`);
        total += 1;
      }
      // Through the production gate, a sample: no class mismatch is ever reported for them.
      for (let round = 0; round < 360; round += 1) {
        const field = FIELDS[round % FIELDS.length];
        const quotes = [plainQuote(field)];
        const text = bullet(field);
        assert(!mismatch(text, quotes), `round ${round}: the production gate reports no class mismatch for ${JSON.stringify(text)}`);
        total += 1;
      }
      // Another field's support statements leave a bullet alone, whatever the bullet says.
      const supportShapes = d => [statement(d), `Maintenance of the ${d.work} that ${verb(d)} ${d.object}.`, `Monitored the ${d.work}, which ${d.s} ${d.object}.`, `Maintained the ${d.work} (which ${verb(d)} ${d.object}).`];
      for (let round = 0; round < 2400; round += 1) {
        const owner = DOMAINS[round % DOMAINS.length];
        const field = FIELDS[(round + 1 + Math.floor(random() * (FIELDS.length - 1))) % FIELDS.length];
        // A bullet whose verb IS the owner's action is the tripwire's business (it shares a verb and may share a word); draw another.
        let text = bullet(field);
        for (let attempt = 0; attempt < 20 && candidateActions(text).some(action => sameActionStem(action.stem, relatednessStem(owner.base))); attempt += 1) text = bullet(field);
        const quotes = [supportShapes(owner)[round % 4]];
        const found = findings(text, quotes);
        assert(found.length === 0, `round ${round}: ${JSON.stringify(text)} is about another field than ${JSON.stringify(quotes)}`);
        total += 1;
      }
      assert(total >= 8000, 'at least eight thousand cases');
      return { total };
    },
  },
  {
    name: 'Module: candidate actions carry the noun phrase they act on and the reach of their clause, and an action with nothing of its own to act on shares the object of the verb it is coordinated to',
    run() {
      const phrase = (text, word) => {
        const action = candidateActions(text).find(entry => entry.word.toLowerCase() === word);
        assert(action, `${JSON.stringify(text)}: an action "${word}" exists`);
        return `${action.np.terms.join('+')}|${action.np.head}|${action.reachTerms.join('+')}`;
      };
      assert(phrase('Built the nightly report jobs for the finance team.', 'built') === 'nightly+report+job|job|nightly+report+job+financ+team', 'object stops at the preposition, reach does not');
      assert(phrase('Designed and built the nightly report jobs.', 'designed') === phrase('Designed and built the nightly report jobs.', 'built'), 'coordinated verbs share an object');
      assert(phrase('Designed, built, and deployed the intake form.', 'designed').startsWith('intak+form|form|'), 'a list of three shares the final object');
      assert(phrase('Wrote documentation for the report jobs.', 'wrote').startsWith('documentation|documentation|'), 'the object of "wrote" is the documentation');
      assert(phrase('Built a dashboard that visualizes ledger summaries.', 'built').startsWith('dashboard|dashboard|'), 'a relative clause is not part of the object');
      assert(phrase('Compiled ledger summaries daily.', 'compiled').startsWith('ledger+summary|summary|'), 'a trailing adverb is not part of the object');
      assert(phrase('Maintained the intake sheet; compiled summaries.', 'maintained').endsWith('|intak+sheet'), 'a semicolon ends the reach of a clause');
    },
  },
];
