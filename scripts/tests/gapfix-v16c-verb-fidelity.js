// Source-verb fidelity, third round. The round-two truthfulness review found the lexical
// holes that were left in the role-strength gate (applicationRoleStrength.js); this file
// pins each repair, with fixtures from eight unrelated invented fields (hospital pharmacy,
// bridge inspection, orchestra scheduling, greenhouse farming, freight forwarding, library
// cataloguing, retail analytics, a university registrar) and a mutation for each rule
// (flip one piece of evidence, one verb, or one flag of a temporary fixture and the
// admissibility flips):
//
//   adverbs     a base-form verb right after a relative pronoun is read as the verb even
//               when it ends in "-ly" ("scripts that apply / supply / reply / comply /
//               multiply / rally / imply / tally ..."), an adverb in front of the verb is
//               still skipped (closed list and open "-ly" words alike), and an unknown
//               "-ly" word is decided by the token after it; a y-to-ied verb with a
//               four-letter base ("copy", "deny") shares a stem with its past form
//   creation    the creation vocabulary is the verbs of authorship, fabrication, release and
//               remaking of EVERY field, plus the phrasal pairs ("stood up", "set up"): a
//               one-word synonym swap over a supported work is the same inflation, and the
//               statement that says the candidate did one of them releases the claim
//   unclassed   a verb the vocabulary cannot class is decided fail-closed in ONE frame (it
//               opens the sentence, is no verb of sustaining, and acts directly on the
//               supported work as the statement names it) and nowhere else; the usual
//               releases flip it
//   team        "member of the team that <V>ed X" (and part of / on / with the group that)
//               is read as a participation statement: "<V>ed X" takes over the group's
//               action, a claim that says the candidate worked with others does not
//   quiet       an ordinary-bullet corpus (more than three hundred, eight fields) and a
//               fuzz of thousands of bullets, against quotes with no support head, are never
//               findings
//
// Every fixture is SYNTHETIC. Nothing in production names any of them.
import { assert } from './testHelpers.js';
import { assertSourceQuoteLinksFinalText } from '../../electron/ipc/localAiApplication.js';
import {
  ROLE_STRENGTH_CLASSES, ROLE_STRENGTH_PHRASAL_MAKING, ROLE_STRENGTH_SUSTAINING_VERBS, candidateActions, describeRoleStrengthFinding,
  roleStrengthFindings, supportAssertions,
} from '../../electron/ipc/applicationRoleStrength.js';

const DOMAINS = Object.freeze([
  {
    key: 'hospital pharmacy', plural: false, work: 'ward stock reconciliation tool', Work: 'Ward stock reconciliation tool', s: 'flags', base: 'flag', past: 'Flagged', ing: 'flagging',
    object: 'expiring medicines for the night nurses',
    made: 'Wrote the ward stock reconciliation tool for the night nurses.', done: 'Flagged expiring medicines by hand for the night nurses.',
    otherMade: 'Drafted a handover checklist for the day pharmacists.',
    things: ['controlled drug registers', 'fridge temperature logs', 'discharge medication lists', 'pharmacy rotas', 'supplier price sheets', 'patient counselling leaflets', 'audit packs', 'dosing charts'],
    places: ['the inpatient wards', 'the outpatient pharmacy', 'the oncology floor', 'the night shift'],
  },
  {
    key: 'bridge inspection', plural: true, work: 'deck strain sensors', Work: 'Deck strain sensor', s: 'logs', base: 'log', past: 'Logged', ing: 'logging',
    object: 'strain readings for the inspection engineers',
    made: 'Designed the deck strain sensors for the inspection engineers.', done: 'Logged strain readings by hand during outages.',
    otherMade: 'Wrote a field manual for new inspectors.',
    things: ['culvert surveys', 'span ratings', 'crack photographs', 'load test reports', 'scour assessments', 'bearing inspections', 'traffic counts', 'repair schedules'],
    places: ['the river crossings', 'the county roads', 'the northern bypass', 'the harbour viaduct'],
  },
  {
    key: 'orchestra scheduling', plural: false, work: 'rehearsal booking system', Work: 'Rehearsal booking system', s: 'sends', base: 'send', past: 'Sent', ing: 'sending',
    object: 'room confirmations to the section leaders',
    made: 'Built the rehearsal booking system for the section leaders.', done: 'Sent room confirmations to the section leaders by phone when it was down.',
    otherMade: 'Compiled a programme booklet for the spring concerts.',
    things: ['seating plans', 'concert programmes', 'guest artist contracts', 'touring itineraries', 'instrument loan forms', 'subscriber letters', 'audition schedules', 'hall rental invoices'],
    places: ['the main hall', 'the touring party', 'the youth orchestra', 'the box office'],
  },
  {
    key: 'greenhouse farming', plural: true, work: 'climate control units', Work: 'Climate control unit', s: 'adjusts', base: 'adjust', past: 'Adjusted', ing: 'adjusting',
    object: 'vent settings for the tomato houses',
    made: 'Engineered the climate control units for the tomato houses.', done: 'Adjusted vent settings by hand for the tomato houses during storms.',
    otherMade: 'Wrote a pruning guide for seasonal staff.',
    things: ['seedling trays', 'irrigation schedules', 'harvest crates', 'pest scouting notes', 'nutrient mixes', 'packing lines', 'yield summaries', 'supplier orders'],
    places: ['the tomato houses', 'the packing shed', 'the cold store', 'the north field'],
  },
  {
    key: 'freight forwarding', plural: false, work: 'customs filing portal', Work: 'Customs filing portal', s: 'submits', base: 'submit', past: 'Submitted', ing: 'submitting',
    object: 'export declarations to port authorities',
    made: 'Developed the customs filing portal for the brokers.', done: 'Submitted export declarations to port authorities by hand when the portal failed.',
    otherMade: 'Wrote a rate card for new accounts.',
    things: ['bills of lading', 'container manifests', 'duty drawback claims', 'carrier rate sheets', 'vessel schedules', 'pallet labels', 'insurance certificates', 'clearance reports'],
    places: ['the Rotterdam desk', 'the inland depot', 'the air cargo desk', 'the broker network'],
  },
  {
    key: 'library cataloguing', plural: true, work: 'shelf label printers', Work: 'Shelf label printer', s: 'prints', base: 'print', past: 'Printed', ing: 'printing',
    object: 'call-number labels for new acquisitions',
    made: 'Assembled the shelf label printers for the reading rooms.', done: 'Printed call-number labels by hand for new acquisitions when a printer jammed.',
    otherMade: 'Drafted a policy for donated books.',
    things: ['donation receipts', 'loan statistics', 'overdue notices', 'reading lists', 'interlibrary requests', 'archive finding lists', 'map collections', 'event posters'],
    places: ['the central library', 'the map room', 'the children\'s wing', 'the archive'],
  },
  {
    key: 'retail analytics', plural: false, work: 'markdown pricing engine', Work: 'Markdown pricing engine', s: 'recommends', base: 'recommend', past: 'Recommended', ing: 'recommending',
    object: 'clearance prices for seasonal stock',
    made: 'Created the markdown pricing engine for the buyers.', done: 'Recommended clearance prices for seasonal stock by hand each Friday.',
    otherMade: 'Wrote a briefing deck for the regional buyers.',
    things: ['sales digests', 'store traffic counts', 'supplier scorecards', 'promotion calendars', 'basket analyses', 'stock turn reports', 'price elasticity models', 'loyalty cohorts'],
    places: ['the regional buyers', 'the flagship stores', 'the planning office', 'the finance office'],
  },
  {
    key: 'university registrar', plural: true, work: 'transcript request queues', Work: 'Transcript request queue', s: 'dispatches', base: 'dispatch', past: 'Dispatched', ing: 'dispatching',
    object: 'official copies to receiving schools',
    made: 'Designed the transcript request queues for the registrar.', done: 'Dispatched official copies to receiving schools by hand during the outage.',
    otherMade: 'Prepared a guide for new advisers.',
    things: ['enrolment forms', 'degree audits', 'grade appeals', 'exam timetables', 'graduation lists', 'fee waivers', 'scholarship letters', 'course catalogues'],
    places: ['the registrar\'s office', 'the admissions desk', 'the graduate school', 'the student centre'],
  },
]);
// The verb form that agrees with the work inside a relative clause.
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
const lower = word => `${word[0].toLowerCase()}${word.slice(1)}`;

const support = d => `Maintenance of the ${d.work} that ${verb(d)} ${d.object}.`;

// A small seeded generator (mulberry32): deterministic, no dependency.
function seeded(seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { random, pick: list => list[Math.floor(random() * list.length)] };
}

// "-ly" words that are verbs: right after a relative pronoun each one is the work's action, not an adverb.
const LY_VERBS = Object.freeze([
  { base: 'apply', s: 'applies', past: 'Applied', object: 'seasonal discounts to store orders' },
  { base: 'supply', s: 'supplies', past: 'Supplied', object: 'wind forecasts to the planners' },
  // The object of these two follows a preposition: the work's action is read, a release by a statement needs a direct object.
  { base: 'reply', s: 'replies', past: 'Replied', object: 'to patient enquiries within the hour', prepositional: true },
  { base: 'comply', s: 'complies', past: 'Complied', object: 'with the filing rules for each region', prepositional: true },
  { base: 'multiply', s: 'multiplies', past: 'Multiplied', object: 'unit prices by exchange rates' },
  { base: 'imply', s: 'implies', past: 'Implied', object: 'quality scores from sample sizes' },
  { base: 'rally', s: 'rallies', past: 'Rallied', object: 'volunteers for weekend shifts' },
  { base: 'tally', s: 'tallies', past: 'Tallied', object: 'ballots from each polling station' },
  { base: 'copy', s: 'copies', past: 'Copied', object: 'ledger files to cold storage' },
  { base: 'deny', s: 'denies', past: 'Denied', object: 'expired badges at the gate' },
]);
// "-ly" adverbs made from adjectives by the ordinary spelling rules: many are on no list, so the open rule reads them.
const ADJECTIVES = ['eager', 'smug', 'random', 'tireless', 'meticulous', 'diligent', 'reluctant', 'cheerful', 'steady', 'prompt', 'rapid', 'recent', 'regular', 'reliable', 'remote', 'repeated',
  'routine', 'secure', 'separate', 'slow', 'swift', 'thorough', 'typical', 'usual', 'systematic', 'gentle', 'bold', 'broad', 'clear', 'close', 'crisp', 'even', 'fair', 'firm', 'frank',
  'fresh', 'full', 'grim', 'happy', 'heavy', 'keen', 'kind', 'light', 'loud', 'mild', 'neat', 'noisy', 'plain', 'polite', 'proud', 'pure', 'quiet', 'rough', 'sharp', 'short', 'silent',
  'simple', 'smooth', 'solid', 'strict', 'strong', 'sure', 'tidy', 'tight', 'warm', 'wide', 'wise', 'obsessive', 'gleeful', 'careful', 'tense', 'vivid', 'candid', 'humble'];
const adverbOf = adjective => {
  if (/ic$/u.test(adjective)) return `${adjective}ally`;
  if (/le$/u.test(adjective)) return `${adjective.slice(0, -1)}y`;
  if (/[^aeiou]y$/u.test(adjective)) return `${adjective.slice(0, -1)}ily`;
  return `${adjective}ly`;
};
const ADVERBS = Object.freeze({
  closed: ['quickly', 'automatically', 'daily', 'nightly', 'manually', 'regularly', 'successfully', 'independently', 'continuously', 'then', 'also', 'always', 'directly', 'routinely'],
  open: ADJECTIVES.map(adverbOf).filter(word => word.length > 4),
});

export default [
  {
    name: 'Adverbs: a base-form verb in "-ly" right after a relative pronoun is the work\'s action in every statement shape (eight fields, ten verbs), an adverb before it changes nothing, and an unknown "-ly" word is decided by the token after it',
    run() {
      let verdicts = 0;
      for (const [index, entry] of LY_VERBS.entries()) {
        const d = DOMAINS[index % DOMAINS.length];
        const plural = 'the batch scripts';
        const single = 'the batch script';
        // Plural works take the base form ("that apply ..."), singular ones "-ies"/"-s"; both are read.
        const statements = [
          ['verb, restrictive relative', `Maintained ${plural} that ${entry.base} ${entry.object}.`],
          ['verb, non-restrictive relative', `Monitored ${plural}, which ${entry.base} ${entry.object}.`],
          ['noun, work after the head', `Maintenance of ${plural} that ${entry.base} ${entry.object}.`],
          ['noun, work before the head', `Batch script maintenance that ${entry.s} ${entry.object}.`],
          ['singular work', `Maintained ${single} that ${entry.s} ${entry.object}.`],
        ];
        for (const [name, quote] of statements) {
          const found = supportAssertions(quote);
          assert(found.length === 1 && found[0].verbs[0].stem && [entry.base, entry.s].includes(found[0].verbs[0].word), `${entry.base} / ${name}: the verb after the relative pronoun is the action (got ${JSON.stringify(found.map(item => item.verbs.map(v => v.word)))})`);
          const claim = `${entry.past} ${entry.object}.`;
          assert(rejected(claim, [quote]), `${entry.base} / ${name}: ${JSON.stringify(claim)} takes over the work's action and must be a finding`);
          assert(mismatch(claim, [quote]), `${entry.base} / ${name}: the production gate agrees`);
          // The faithful rewrite (the support role stated in the sentence, the repair that is always available) and the releases flip the verdict.
          assert(!rejected(`Maintained ${plural} and ${lower(entry.past)} ${entry.object}.`, [quote]), `${entry.base} / ${name}: the faithful rewrite is admitted`);
          if (!entry.prepositional) assert(!rejected(claim, [quote, `${entry.past} ${entry.object} by hand when a job failed.`]), `${entry.base} / ${name}: a quote that says the candidate did it releases the claim`);
          assert(rejected(claim, [quote, `${d.otherMade}`]), `${entry.base} / ${name}: an unrelated quote releases nothing`);
          verdicts += 5;
        }
        // The claim side: the verb in the base form after "I"/"we" is the candidate's own action (it is no adverb either).
        const own = candidateActions(`I ${entry.base} ${entry.object}.`);
        assert(own.length === 1 && own[0].word === entry.base && own[0].position === 'subject', `${entry.base}: the claim-side verb after "I" is an own action`);
        verdicts += 1;
      }
      // An adverb before the verb is skipped, whether the closed list holds it or the open rule reads it, and the verb read is the same.
      assert(ADVERBS.open.length >= 60, 'at least sixty generated adverbs');
      const { random, pick } = seeded(0x51d3);
      let metamorphic = 0;
      for (let round = 0; round < 2400; round += 1) {
        const entry = round % 3 === 0 ? pick(LY_VERBS) : null;
        const d = pick(DOMAINS);
        const action = entry ? entry.base : d.base;
        const actionObject = entry ? entry.object : d.object;
        const adverb = pick(random() < 0.5 ? ADVERBS.closed : ADVERBS.open);
        const shapes = [
          (a) => `Maintained the batch scripts that ${a}${action} ${actionObject}.`,
          (a) => `Maintenance of the batch scripts that ${a}${action} ${actionObject}.`,
          (a) => `Batch script maintenance that ${a}${action} ${actionObject}.`,
          (a) => `Monitored the batch scripts, which ${a}${action} ${actionObject}.`,
        ];
        const shape = pick(shapes);
        const bare = supportAssertions(shape(''));
        const withAdverb = supportAssertions(shape(`${adverb} `));
        assert(bare.length === 1 && bare[0].verbs[0].word === action, `round ${round}: the bare statement reads "${action}" (got ${JSON.stringify(bare.map(item => item.verbs.map(v => v.word)))})`);
        assert(withAdverb.length === 1 && withAdverb[0].verbs[0].word === action, `round ${round}: "${adverb}" before the verb is skipped and the verb is still "${action}" (got ${JSON.stringify(withAdverb.map(item => item.verbs.map(v => v.word)))})`);
        assert(withAdverb[0].artifactHead === bare[0].artifactHead && withAdverb[0].terms.join() === bare[0].terms.join(), `round ${round}: the adverb leaves the assertion alone`);
        // The claim side: an adverb in front of the candidate's own verb is skipped too.
        const claim = candidateActions(`I ${adverb} ${action} ${actionObject}.`);
        assert(claim.length === 1 && claim[0].word === action, `round ${round}: "I ${adverb} ${action}" reads the verb after the adverb`);
        metamorphic += 1;
      }
      // An "-ly" verb the exception list does not know is decided by the token after it: with a determiner it IS the verb; with a
      // verb after it, it is an adverb. (The word is real: "to sully a reputation".)
      assert(supportAssertions('Maintained the batch scripts that sully the incoming orders.')[0]?.verbs[0].word === 'sully', 'an unknown "-ly" word before a determiner is the verb');
      assert(supportAssertions('Maintained the batch scripts that sully compile the incoming orders.')[0]?.verbs[0].word === 'compile', 'the same word before a verb is an adverb');
      assert(supportAssertions('Maintained the batch scripts that sully with the incoming orders.')[0]?.verbs[0].word === 'sully', 'an unknown "-ly" word before a preposition is the verb');
      // A word that merely ends in "-ly" and is a noun is no adverb either, at the end of a noun phrase.
      const familyAction = candidateActions('Rebuilt the final assembly for the plant.')[0];
      assert(familyAction.np.head === 'assembly', 'a noun in "-ly" ("assembly") is the head of its phrase, not a trailing adverb');
      const trailing = candidateActions('Compiled ledger summaries daily.')[0];
      assert(trailing.np.head === 'summary', 'a trailing adverb is not part of the phrase');
      return { verdicts, metamorphic };
    },
  },
  {
    name: 'Stems: a past form that drops the "y" shares a stem with its base for the four-letter bases too ("copy"/"copied", "deny"/"denied"), in every statement shape, and the boundary is a threshold',
    run() {
      const four = LY_VERBS.filter(entry => ['copy', 'deny'].includes(entry.base));
      assert(four.length === 2, 'the table holds the four-letter bases');
      for (const entry of four) {
        for (const form of [`Maintained the backup scripts that ${entry.base} ${entry.object}.`, `Maintenance of the backup scripts that ${entry.base} ${entry.object}.`, `Backup script maintenance that ${entry.s} ${entry.object}.`, `Monitored the backup scripts, which ${entry.base} ${entry.object}.`]) {
          assert(rejected(`${entry.past} ${entry.object}.`, [form]), `${entry.base}: ${JSON.stringify(form)} — the past form takes over the action`);
        }
        // A different verb that starts alike is not the same action.
        const other = entry.base === 'copy' ? 'Coped' : 'Dented';
        assert(!rejected(`${other} ${entry.object}.`, [`Maintained the backup scripts that ${entry.base} ${entry.object}.`]), `${entry.base}: "${other}" is another verb`);
      }
      // The y-to-ied family with longer bases, which the stem rule already shared, is unchanged.
      for (const [base, past] of [['carry', 'Carried'], ['query', 'Queried'], ['verify', 'Verified'], ['notify', 'Notified'], ['modify', 'Modified'], ['identify', 'Identified']]) {
        assert(rejected(`${past} intake records for the clinic.`, [`Maintained the intake scripts that ${base} intake records for the clinic.`]), `${base}/${past}`);
      }
    },
  },
  {
    name: 'Creation vocabulary: authorship, fabrication, release and remaking verbs of every field over a supported work are the same inflation as "Rebuilt" (eight fields, fifty verbs and phrasal pairs), and the statement that says the candidate did one releases the claim',
    run() {
      const CREATION = [
        // authorship and composition
        'Drafted', 'Composed', 'Formulated', 'Conceived', 'Made', 'Generated', 'Prepared', 'Synthesized', 'Fashioned', 'Authored', 'Crafted',
        // fabrication and standing a thing up
        'Fabricated', 'Manufactured', 'Constructed', 'Assembled', 'Produced', 'Installed', 'Commissioned', 'Provisioned', 'Prototyped', 'Bootstrapped',
        // release and publication
        'Published', 'Released', 'Issued', 'Shipped', 'Deployed', 'Instituted', 'Productionized', 'Launched',
        // remaking
        'Overhauled', 'Revamped', 'Reworked', 'Remade', 'Reengineered', 'Rearchitected', 'Reimagined', 'Reinvented', 'Remodeled', 'Modernized', 'Transformed',
        'Rebuilt', 'Redesigned', 'Rewrote', 'Founded', 'Established',
        // phrasal pairs
        'Stood up', 'Set up', 'Spun up', 'Rolled out', 'Put together', 'Drew up', 'Stitched together',
      ];
      assert(CREATION.length >= 50, 'at least fifty verbs');
      let verdicts = 0;
      for (const d of DOMAINS) {
        const statement = support(d);
        for (const creation of CREATION) {
          const claim = `${creation} the ${d.work} for the team.`;
          const found = findings(claim, [statement]);
          assert(found.length === 1 && found[0].shape === 'creation' && found[0].claimClass === 'created or owned' && found[0].claimVerb === creation,
            `${d.key}: ${JSON.stringify(claim)} is one creation finding (got ${JSON.stringify(found)})`);
          assert(mismatch(claim, [statement]), `${d.key}: ${creation} — the production gate agrees`);
          // B: a quote that says the candidate made this work, or the very same act on it, releases the claim. C: doing the work's action, or making other work, does not.
          assert(!rejected(claim, [statement, d.made]), `${d.key}: ${creation} — a quote that makes the work releases it`);
          assert(!rejected(claim, [statement, `${creation} the ${d.work} for the county.`]), `${d.key}: ${creation} — the very same act, stated, releases it`);
          assert(rejected(claim, [statement, d.otherMade]) && rejected(claim, [statement, d.done]), `${d.key}: ${creation} — making other work, or doing the work's action, releases nothing`);
          // Mutations: the support statement without its relative clause, or a quote that makes the work the statement is about, asserts nothing.
          assert(!rejected(claim, [`Maintenance of the ${d.work}.`]), `${d.key}: ${creation} — no action handed to the work, no assertion`);
          verdicts += 7;
        }
        // A phrasal pair coordinated to another verb is read as well.
        const coordinated = findings(`Tested and set up the ${d.work} for the county.`, [statement]);
        assert(coordinated.length === 1 && coordinated[0].shape === 'creation' && coordinated[0].claimVerb === 'set up', `${d.key}: "Tested and set up the ..." is a creation finding (got ${JSON.stringify(coordinated)})`);
        // The phrasal pair is the pair: the particle is not part of what the verb acts on, and the verb alone is no creation verb.
        const stood = candidateActions(`Stood up the ${d.work} for the team.`)[0];
        assert(stood.word === 'Stood up' && stood.making && stood.cls.id === 'create' && stood.np.head === candidateActions(`Built the ${d.work} for the team.`)[0].np.head, `${d.key}: the pair is one action whose object excludes the particle`);
        for (const text of [`Stood watch over the ${d.work} overnight.`, `Set the ${d.work} to night mode.`, `Rolled the ${d.work} out of the shed for the storm.`, `Put the ${d.work} on the agenda.`, `Drew on the ${d.work} for reference.`]) {
          assert(!rejected(text, [statement]), `${d.key}: ${JSON.stringify(text)} — the verb alone, or another particle, is no creation of the work`);
          verdicts += 1;
        }
        // Things that are NOT the work stay quiet whatever the verb: a creation verb on a thing for, about or beside the work.
        for (const creation of ['Published', 'Released', 'Drafted', 'Issued', 'Fabricated', 'Set up', 'Prepared']) {
          for (const text of [`${creation} documentation for the ${d.work}.`, `${creation} a status report on the ${d.work}.`, `${creation} a runbook covering the ${d.work}.`, `${creation} the ${d.work} schedule.`, `${creation} notices about the ${d.work} outage.`]) {
            assert(!rejected(text, [statement]), `${d.key}: ${JSON.stringify(text)} is not a creation of the work`);
            verdicts += 1;
          }
        }
        // The documented boundary: the perform and own rungs are not compared over a supported work.
        for (const text of [`Ran the ${d.work} every night.`, `Operated the ${d.work} for the team.`, `Delivered the ${d.work} to the county.`, `Managed the ${d.work} for the team.`, `Led the ${d.work} programme.`]) {
          assert(!rejected(text, [statement]), `${d.key}: ${JSON.stringify(text)} is the perform or own rung, which this module does not compare over a supported work`);
          verdicts += 1;
        }
      }
      // The vocabulary: one class per verb, plain lowercase, and not software-shaped. Every field has its authorship and fabrication verbs in it.
      const create = ROLE_STRENGTH_CLASSES.find(klass => klass.id === 'create');
      for (const verbName of ['draft', 'compose', 'formulate', 'fabricate', 'manufacture', 'fashion', 'construct', 'assemble', 'produce', 'prepare', 'issue', 'publish', 'release', 'synthesize', 'conceive', 'author', 'craft', 'establish', 'found']) {
        assert(create.verbs.includes(verbName), `${verbName} is a creation verb`);
      }
      const owners = new Map();
      for (const klass of ROLE_STRENGTH_CLASSES) for (const entry of klass.verbs) { assert(!owners.has(entry), `"${entry}" is in one class only`); owners.set(entry, klass.id); }
      for (const entry of ROLE_STRENGTH_SUSTAINING_VERBS) assert(!owners.has(entry), `"${entry}" is a verb of sustaining and of no class`);
      assert(ROLE_STRENGTH_PHRASAL_MAKING.every(entry => /^[a-z]+ [a-z]+$/u.test(entry)) && ROLE_STRENGTH_PHRASAL_MAKING.length >= 7, 'phrasal pairs are "verb particle"');
      // The "found" collision: "founded" is the verb of making, "found" is the past of "find".
      assert(candidateActions('Founded the clinic network.')[0].making === true, '"Founded" is a verb of making');
      assert(candidateActions('Found the clinic network.')[0].making === false, '"Found" (find) is not');
      // A noun-prone creation verb opens a clause as a verb only with a determiner or a number ("Release notes ..." is a noun phrase).
      assert(candidateActions('Release notes for the clinic network.').length === 0 && candidateActions('Draft policies for the clinic network.').length === 0, 'a noun-prone word at the head of a noun phrase is no action');
      assert(candidateActions('Release the clinic network notes.').length === 1 && candidateActions('Draft the clinic network policies.').length === 1, 'with a determiner it is');
      return { verdicts };
    },
  },
  {
    name: 'Unclassed act: a verb the vocabulary cannot class is decided fail-closed in ONE frame (opens the sentence, no verb of sustaining, acts directly on the supported work as named) and nowhere else, and the usual releases flip it (eight fields, fourteen verbs)',
    run() {
      const UNCLASSED = ['Migrated', 'Integrated', 'Configured', 'Piloted', 'Championed', 'Relocated', 'Staged', 'Bundled', 'Wired', 'Cloned', 'Rebranded', 'Ported', 'Reorganized', 'Rehomed'];
      const SUSTAINING = ['Fixed', 'Patched', 'Tested', 'Documented', 'Reviewed', 'Upgraded', 'Audited', 'Restarted', 'Scheduled', 'Calibrated', 'Troubleshot', 'Inspected', 'Optimized', 'Expanded', 'Tuned', 'Hardened'];
      let verdicts = 0;
      // The fixture is honest: none of these is in the vocabulary, and the sustaining ones are exactly the list.
      for (const word of UNCLASSED) {
        const action = candidateActions(`${word} the intake desk.`)[0];
        assert(action && action.cls === null && !action.making, `${word} is outside the vocabulary`);
      }
      // (They are unclassed too, so what keeps them quiet over the work is the list of verbs of sustaining and nothing else.)
      for (const word of SUSTAINING) {
        const action = candidateActions(`${word} the intake desk.`)[0];
        assert(action && action.cls === null && !action.making, `${word} is outside the vocabulary of the ladder`);
      }
      assert(ROLE_STRENGTH_SUSTAINING_VERBS.length >= 60 && ROLE_STRENGTH_SUSTAINING_VERBS.every(entry => /^[a-z]+$/u.test(entry)), 'the verbs of sustaining are plain lowercase language data');
      for (const d of DOMAINS) {
        const statement = support(d);
        for (const word of UNCLASSED) {
          const claim = `${word} the ${d.work} to a new site.`;
          const found = findings(claim, [statement]);
          assert(found.length === 1 && found[0].shape === 'unclassified' && found[0].claimClass === 'performed' && found[0].claimVerb === word, `${d.key}: ${JSON.stringify(claim)} is one unclassified finding (got ${JSON.stringify(found)})`);
          assert(mismatch(claim, [statement]), `${d.key}: ${word} — the production gate agrees`);
          // The first-person form of the same sentence.
          assert(rejected(`I ${lower(word)} the ${d.work} to a new site.`, [statement]), `${d.key}: ${word} — "I ${lower(word)}" is the same frame`);
          // Releases: a statement that made the work; the very same act on the very same thing; the support role stated in the sentence.
          assert(!rejected(claim, [statement, d.made]), `${d.key}: ${word} — a quote that makes the work releases it`);
          assert(!rejected(claim, [statement, `${word} the ${d.work} to a cloud host.`]), `${d.key}: ${word} — the very same act, stated, releases it`);
          assert(!rejected(claim, [statement, `Maintained the ${d.work} and ${lower(word)} it to a cloud host.`]), `${d.key}: ${word} — the very same act on "it", stated, releases it`);
          assert(rejected(claim, [statement, `${word} to a new ticketing system for the help desk.`]), `${d.key}: ${word} — the same verb with no object of its own, only a destination, releases nothing`);
          assert(!rejected(`Maintained the ${d.work}; ${lower(word)} the ${d.work} to a new site.`, [statement]), `${d.key}: ${word} — the support role stated in the sentence releases it`);
          assert(!rejected(`Maintained the ${d.work} and ${lower(word)} it to a new site.`, [statement]), `${d.key}: ${word} — coordinated to the support verb, it is not the frame`);
          // Not released: the act on another thing, making other work, doing the work's own action.
          assert(rejected(claim, [statement, `${word} the payroll database to a new site.`]) && rejected(claim, [statement, d.otherMade]) && rejected(claim, [statement, d.done]), `${d.key}: ${word} — another thing, other work, or the work's action releases nothing`);
          verdicts += 11;
        }
        const word = 'Migrated';
        // The frame is exact: each departure leaves an unclassed verb alone.
        const outside = [
          [`Cut costs by migrating the ${d.work}.`, 'a participle of means'],
          [`Responsible for migrating the ${d.work}.`, 'a duty'],
          [`Maintained the ${d.work} and migrated the ${d.work}.`, 'coordinated to a clause that opens'],
          [`${word} the new regional ${d.work} to a new site.`, 'two modifiers more than the work'],
          [`${word} the ${d.work} schedule to a new site.`, 'a different head noun'],
          [`${word} the ${d.work.split(' ').slice(0, -1).join(' ')} calendar to a new site.`, 'another thing sharing the work\'s terms'],
          [`${word} data into the ${d.work}.`, 'the work is not the direct object'],
          [`${word} the ${d.work.split(' ').slice(-1)[0]} to a new site.`, 'the head noun alone does not name the work'],
          [`Backed up the ${d.work} to cold storage.`, 'a phrasal verb'],
          [`Handed over the ${d.work} to the vendor.`, 'a phrasal verb'],
          [`Worked on the ${d.work} with the vendor.`, 'the work follows a preposition'],
        ];
        for (const [text, why] of outside) {
          assert(!rejected(text, [statement]), `${d.key}: ${JSON.stringify(text)} is outside the frame (${why})`);
          verdicts += 1;
        }
        // One modifier more is still the frame, and a trailing time phrase does not take the work out of it.
        assert(rejected(`${word} the new ${d.work} to a new site.`, [statement]), `${d.key}: one modifier more than the work is the frame`);
        assert(rejected(`${word} the ${d.work} each quarter.`, [statement]) && rejected(`Rebuilt the ${d.work} every year.`, [statement]), `${d.key}: "each quarter" / "every year" after the work is not part of the work`);
        // A verb of sustaining acts on the work without making it, however exactly it names the work.
        for (const sustaining of SUSTAINING) {
          assert(!rejected(`${sustaining} the ${d.work} after each audit.`, [statement]), `${d.key}: ${sustaining} is sustaining`);
          verdicts += 1;
        }
        // Mutations of the evidence: no relative clause, a different head, the work made by the candidate: nothing asserted.
        assert(!rejected(`${word} the ${d.work} to a new site.`, [`Maintenance of the ${d.work}.`]), `${d.key}: no action handed to the work`);
        assert(!rejected(`${word} the ${d.work} to a new site.`, [`Built the ${d.work} that ${verb(d)} ${d.object}.`]), `${d.key}: a work the candidate built is not supported work`);
        assert(!rejected(`${word} the ${d.work} to a new site.`, [`Maintenance of the ${d.work.replace(/\s\S+$/u, ' archive')} that ${verb(d)} ${d.object}.`]), `${d.key}: another work`);
        verdicts += 3;
      }
      // The observation: the class mismatch and BOTH faithful repairs, in the same fixed words in every field, naming no vocabulary verb.
      const fixed = new Set();
      for (const d of DOMAINS) {
        const [found] = findings(`Migrated the ${d.work} to a new site.`, [support(d)]);
        const message = describeRoleStrengthFinding('Bullet "b1"', found);
        assert(/presents the candidate as the actor of “Migrated” on “[^”]+”/u.test(message) && /no cited statement says the candidate did that to it/u.test(message), `${d.key}: the unclassified observation names the claim, the work and the missing statement`);
        assert(/Observed class mismatch: the source says the candidate supported it; the text claims the candidate performed it\./u.test(message), `${d.key}: the class mismatch is stated`);
        assert(/Two repairs are faithful\. Either hold the candidate to the support role/u.test(message) && /cite that statement as well as this one\./u.test(message), `${d.key}: both repairs are stated`);
        const residue = message.replace(/“[^”]*”/gu, ' ');
        for (const klass of ROLE_STRENGTH_CLASSES) for (const entry of klass.verbs.filter(item => !['support', 'perform', 'own', 'create'].includes(item))) {
          assert(!new RegExp(`\\b${entry}(?:s|d|ed|ing)?\\b`, 'iu').test(residue), `${d.key}: the observation must not name the vocabulary verb "${entry}"`);
        }
        fixed.add(message.replace(/“[^”]*”/gu, '“”'));
      }
      assert(fixed.size === 1, `the fixed words are the same in every field (got ${fixed.size} variants)`);
      return { verdicts };
    },
  },
  {
    name: 'Team: "member of the team that <V>ed X" (part of / on / with the group that) becomes "<V>ed X" only by inflation: it is rejected, a claim that says the candidate worked with others, or did it, is admitted, and leading or reporting to the group is not belonging (eight fields)',
    run() {
      let verdicts = 0;
      for (const d of DOMAINS) {
        const done = lower(d.past);
        const forms = [
          ['member of', `Member of the team that ${done} ${d.object}.`, 'team'],
          ['part of', `Part of the group that ${done} ${d.object}.`, 'group'],
          ['worked on', `Worked on the crew that ${done} ${d.object}.`, 'crew'],
          ['on the', `On the committee that ${done} ${d.object}.`, 'committee'],
          ['collaborated with', `Collaborated with the department that ${done} ${d.object}.`, 'department'],
          ['served as a member of', `Served as a member of the squad that ${done} ${d.object}.`, 'squad'],
        ];
        const claim = `${d.past} ${d.object}.`;
        for (const [name, statement, noun] of forms) {
          const read = supportAssertions(statement);
          assert(read.length === 1 && read[0].kind === 'team' && read[0].head.toLowerCase().includes(noun) && read[0].verbs[0].word === done, `${d.key} / ${name}: one team assertion (got ${JSON.stringify(read.map(item => [item.kind, item.head]))})`);
          const found = findings(claim, [statement]);
          assert(found.length === 1 && found[0].shape === 'action' && found[0].headKind === 'team', `${d.key} / ${name}: ${JSON.stringify(claim)} takes over the group's action (got ${JSON.stringify(found)})`);
          assert(mismatch(claim, [statement]), `${d.key} / ${name}: the production gate agrees`);
          const message = describeRoleStrengthFinding('Bullet "b1"', found[0]);
          assert(/the candidate's part is “[^”]+”, a group that “[^”]+” the work, not the candidate alone/u.test(message), `${d.key} / ${name}: the observation says the part the candidate took`);
          // Faithful: the claim says the candidate worked with others, or the evidence says the candidate did it.
          for (const faithful of [`${d.past} ${d.object} with a team of six.`, `${d.past} ${d.object} as part of the platform group.`, `${d.past} ${d.object} alongside two colleagues.`, `Collaborated on ${d.ing} ${d.object}.`, `Member of the team that ${done} ${d.object}.`]) {
            assert(!rejected(faithful, [statement]), `${d.key} / ${name}: ${JSON.stringify(faithful)} states the belonging and is admitted`);
            verdicts += 1;
          }
          assert(!rejected(claim, [statement, d.done]) && rejected(claim, [statement, d.otherMade]), `${d.key} / ${name}: a quote that says the candidate did it releases the claim; other work does not`);
          // A group the work was done FOR states nothing about the candidate's part.
          assert(rejected(`${d.past} ${d.object} for the planning team.`, [statement]), `${d.key} / ${name}: "for the planning team" is not belonging`);
          verdicts += 5;
        }
        // Not belonging, so not read: leading the group, reporting to it, something of the group, a bare noun.
        for (const text of [
          `Led the team that ${done} ${d.object}.`, `Reported to the team that ${done} ${d.object}.`, `Budget of the team that ${done} ${d.object}.`,
          `Presented to the board that ${done} ${d.object}.`, `Member of the tool that ${done} ${d.object}.`, `Leader of the team that ${done} ${d.object}.`,
        ]) {
          assert(supportAssertions(text).length === 0 && !rejected(claim, [text]), `${d.key}: ${JSON.stringify(text)} is not a statement of belonging`);
          verdicts += 1;
        }
        // Mutations: no object for the group's verb, a stative verb, a passive: nothing is handed to the group.
        for (const text of [`Member of the team that ${done}.`, `Member of the team that uses ${d.object}.`, `Member of the team that was approved for ${d.object}.`, `Member of the team that the board named for ${d.object}.`]) {
          assert(supportAssertions(text).length === 0, `${d.key}: ${JSON.stringify(text)} hands no action to the group`);
          verdicts += 1;
        }
        // The creation rung reads the team statement too: the group reviewed the work, the claim ships it.
        const reviewed = `Member of the team that reviewed the ${d.work} for the county.`;
        const shipped = findings(`Shipped the ${d.work} for the team.`, [reviewed]);
        assert(shipped.length === 1 && shipped[0].shape === 'creation' && shipped[0].headKind === 'team', `${d.key}: the creation rung reads the team statement (got ${JSON.stringify(shipped)})`);
        assert(!rejected(`Shipped the ${d.work} for the team.`, [reviewed, d.made]), `${d.key}: and a quote that makes the work releases it`);
        verdicts += 2;
      }
      // The observation's fixed words are the same in every field.
      const fixed = new Set();
      for (const d of DOMAINS) {
        const [found] = findings(`${d.past} ${d.object}.`, [`Member of the team that ${lower(d.past)} ${d.object}.`]);
        fixed.add(describeRoleStrengthFinding('Bullet', found).replace(/“[^”]*”/gu, '“”'));
      }
      assert(fixed.size === 1, `the fixed words are the same in every field (got ${fixed.size} variants)`);
      return { verdicts };
    },
  },
  {
    name: 'Letter: the new readings (an unclassed act, a wider or irregular or phrasal creation verb, belonging to a group) are rejected in a first-person letter sentence even when the host\'s own verb list does not know the verb, name the sentence, and are admitted once the evidence or the sentence says so (eight fields)',
    run() {
      for (const d of DOMAINS) {
        const done = lower(d.past);
        const statement = support(d);
        const team = `Member of the team that ${done} ${d.object}.`;
        const letter = (text, quotes) => judge(text, quotes, { label: 'coverLetterParagraphs' });
        const rows = [
          ['unclassed act', `I migrated the ${d.work} to a new site.`, [statement], `I migrated the ${d.work} to a new site.`, [statement, `Migrated the ${d.work} to a cloud host.`]],
          ['wider creation verb', `I published the ${d.work} for the county.`, [statement], `I published the ${d.work} for the county.`, [statement, d.made]],
          ['phrasal creation verb', `We stood up the ${d.work} for the county.`, [statement], `We stood up the ${d.work} for the county.`, [statement, d.made]],
          // The host's own list of past-tense career verbs holds none of these irregular forms, so no other reading judges the sentence.
          ['irregular creation verb', `I rebuilt the ${d.work} for the county.`, [statement], `I rebuilt the ${d.work} for the county.`, [statement, d.made]],
          ['"made"', `I made the ${d.work} for the county.`, [statement], `I made the ${d.work} for the county.`, [statement, d.made]],
          ['phrasal "set up"', `I set up the ${d.work} for the county.`, [statement], `I set up the ${d.work} for the county.`, [statement, d.made]],
          ['belonging to a group', `I ${done} ${d.object}.`, [team], `I ${done} ${d.object} as part of the platform group.`, [team]],
        ];
        for (const [name, text, quotes, admittedText, admittedQuotes] of rows) {
          const verdict = letter(text, quotes);
          assert(MISMATCH.test(verdict) && /cover-letter paragraph 1, sentence 1/u.test(verdict), `${d.key} / ${name}: ${JSON.stringify(text)} is rejected as a class mismatch and names the sentence (got ${verdict || 'acceptance'})`);
          if (name === 'unclassed act') assert(!MISMATCH.test(letter(text, [statement, `Maintained the ${d.work} and migrated it to a cloud host.`])), `${d.key} / ${name}: the same act on "it", stated, releases it`);
          assert(!MISMATCH.test(letter(admittedText, admittedQuotes)) && (name === 'belonging to a group' || admittedText === text), `${d.key} / ${name}: admitted once the evidence or the sentence says so (${letter(admittedText, admittedQuotes)})`);
        }
      }
    },
  },
  {
    name: 'Quiet: an ordinary-bullet corpus (more than three hundred bullets, eight fields, every class of verb, faithful bullets about the supported work itself) is never a role-strength finding against the field\'s support statements',
    run() {
      const CREATION = ['Built', 'Designed', 'Drafted', 'Published', 'Prepared', 'Issued', 'Developed', 'Authored', 'Produced', 'Wrote', 'Composed', 'Launched', 'Created', 'Assembled', 'Fabricated'];
      const PERFORM = ['Ran', 'Operated', 'Processed', 'Delivered', 'Handled', 'Completed', 'Executed', 'Conducted'];
      const OWN = ['Led', 'Managed', 'Directed', 'Oversaw', 'Coordinated'];
      const OTHER = ['Reconciled', 'Audited', 'Trained', 'Negotiated', 'Migrated', 'Integrated', 'Configured', 'Piloted', 'Summarized', 'Translated', 'Mentored', 'Presented', 'Streamlined', 'Forecast', 'Rebranded', 'Staged'];
      const ALL = [...CREATION, ...PERFORM, ...OWN, ...OTHER];
      const corpus = [];
      DOMAINS.forEach((d, di) => {
        const statements = [support(d), `Maintained the ${d.work} that ${verb(d)} ${d.object}.`, `${d.Work} maintenance that ${d.s} ${d.object}.`, `Monitored the ${d.work}, which ${d.s} ${d.object}.`];
        const bullets = new Set();
        // Ordinary bullets about other things, one verb at a time, in six sentence shapes.
        for (let k = 0; bullets.size < 38 && k < 400; k += 1) {
          const V = ALL[(k * 7 + di * 3) % ALL.length];
          const V2 = ALL[(k * 11 + di * 5 + 1) % ALL.length];
          const thing = d.things[(k + di) % d.things.length];
          const thing2 = d.things[(k * 3 + 1 + di) % d.things.length];
          const place = d.places[(k + 2 * di) % d.places.length];
          const n = 12 + ((k * 5) % 70);
          const shape = k % 6;
          if (shape === 0) bullets.add(`${V} ${thing} for ${place}.`);
          else if (shape === 1) bullets.add(`${V} ${thing} and ${lower(V2)} ${thing2} for ${place}.`);
          else if (shape === 2) bullets.add(`${V} ${thing} at ${place}, cutting turnaround by ${n} percent.`);
          else if (shape === 3) bullets.add(`I ${lower(V)} ${thing} for ${place}.`);
          else if (shape === 4) bullets.add(`${V} the ${thing} across ${place} each quarter.`);
          else bullets.add(`${V} ${n} ${thing} for ${place} using shared checklists.`);
        }
        // Faithful bullets about the supported work itself: the support role kept, sustaining and operating acts, a document about it, an outcome.
        for (const text of [
          `Maintained the ${d.work} for ${d.places[0]}.`, `Monitored the ${d.work} during peak weeks.`, `Tested the ${d.work} after each release.`, `Documented the ${d.work} for new staff.`,
          `Upgraded the ${d.work} to the latest version.`, `Restarted the ${d.work} after outages.`, `Reviewed the ${d.work} with the vendor.`, `Ran the ${d.work} every night.`,
          `Wrote a runbook for the ${d.work}.`, `Reduced errors in the ${d.work} by 20%.`, `Trained six colleagues on the ${d.work}.`, `Supported the ${d.work} and ${lower(d.past)} ${d.object}.`,
          `Maintained the ${d.work} while ${d.ing} ${d.object}.`, `Kept the ${d.work} running through ${d.places[1]}.`, `Set the ${d.work} to night mode.`, `Moved the ${d.work} to the east wing.`,
        ]) bullets.add(text);
        for (const text of bullets) corpus.push({ d, text, statements });
      });
      assert(new Set(corpus.map(entry => entry.text)).size >= 300, `at least three hundred distinct bullets (got ${new Set(corpus.map(entry => entry.text)).size})`);
      assert(corpus.length >= 400, 'the corpus is large');
      let gateChecks = 0;
      corpus.forEach(({ d, text, statements }, index) => {
        const found = findings(text, statements);
        assert(found.length === 0, `${d.key}: ${JSON.stringify(text)} is ordinary and must not be a role-strength finding (got ${JSON.stringify(found)})`);
        if (index % 3 === 0) {
          assert(!mismatch(text, statements), `${d.key}: the production gate reports no class mismatch for ${JSON.stringify(text)}`);
          gateChecks += 1;
        }
      });
      // The corpus is not vacuous: the same bullets with the field's inflation among them are caught, so the quiet is the rule's, not the fixture's.
      for (const d of DOMAINS) {
        assert(rejected(`${d.past} ${d.object}.`, [support(d)]) && rejected(`Shipped the ${d.work} for the team.`, [support(d)]) && rejected(`Migrated the ${d.work} to a new site.`, [support(d)]), `${d.key}: the inflations of the field are caught`);
      }
      return { bullets: corpus.length, gateChecks };
    },
  },
  {
    name: 'Fuzz: thousands of ordinary bullets (every class of verb, the whole creation vocabulary, unclassed and sustaining verbs, eight fields) against quotes with no support-class head are never findings, and neither are bullets from one field against the support statements of another',
    run() {
      const { random, pick } = seeded(0x7a15e);
      const CREATION = ['Drafted', 'Composed', 'Formulated', 'Fabricated', 'Manufactured', 'Fashioned', 'Crafted', 'Constructed', 'Produced', 'Authored', 'Prepared', 'Issued', 'Published', 'Released', 'Shipped', 'Deployed', 'Installed', 'Built', 'Designed', 'Created', 'Overhauled', 'Revamped', 'Stood up', 'Set up', 'Rolled out', 'Put together', 'Made', 'Generated', 'Rebuilt', 'Founded'];
      const KEEP = ['Ran', 'Operated', 'Executed', 'Delivered', 'Led', 'Managed', 'Owned', 'Directed', 'Fixed', 'Patched', 'Tested', 'Documented', 'Upgraded', 'Reviewed', 'Audited', 'Restarted', 'Scheduled', 'Moved', 'Trained'];
      const UNCLASSED = ['Migrated', 'Integrated', 'Configured', 'Piloted', 'Championed', 'Relocated', 'Staged', 'Reconciled', 'Tabulated', 'Summarized', 'Translated', 'Negotiated', 'Forecast', 'Rebranded'];
      const VERBS = [...CREATION, ...KEEP, ...UNCLASSED];
      const PARTICIPLES = ['compiling', 'tracking', 'routing', 'reconciling', 'building', 'designing', 'running', 'scheduling', 'training', 'drafting', 'publishing', 'shipping', 'preparing'];
      const bullet = d => {
        const noun = pick(d.things);
        const noun2 = pick(d.things);
        const place = pick(d.places);
        const V = pick(VERBS);
        const template = Math.floor(random() * 9);
        if (template === 0) return `${V} ${noun} for ${place}.`;
        if (template === 1) return `${V} the ${noun} for ${place}.`;
        if (template === 2) return `I ${lower(V)} ${noun} at ${place}.`;
        if (template === 3) return `${V} ${noun} and ${lower(pick(VERBS))} the ${noun2}.`;
        if (template === 4) return `${V} the ${noun} ${random() < 0.5 ? 'by' : 'through'} ${pick(PARTICIPLES)} ${noun2}.`;
        if (template === 5) return `${V} ${noun}; ${lower(pick(VERBS))} ${place} ${noun2}.`;
        if (template === 6) return `${V} ${random() < 0.5 ? 'weekly' : 'nightly'} ${noun}, ${pick(PARTICIPLES)} ${noun2}.`;
        if (template === 7) return `My experience ${pick(PARTICIPLES)} ${noun} shows in ${noun2}.`;
        return `${V} ${noun} ${random() < 0.5 ? 'quickly' : 'successfully'} for ${place}.`;
      };
      // Quotes with NO support-class head: a verb of making, owning or performing, a relative clause or not. Some build, release or ship the
      // very things the bullet does; none of them puts the candidate in a support role or in a group.
      const plainQuote = d => {
        const noun = pick(d.things);
        const place = pick(d.places);
        const actor = pick(['Built', 'Developed', 'Designed', 'Led', 'Managed', 'Ran', 'Wrote', 'Created', 'Published', 'Shipped', 'Drafted', 'Released']);
        const relative = pick(['compiles', 'records', 'sends', 'routes', 'tracks', 'reconciles', 'flags', 'prints', 'dispatches']);
        const template = Math.floor(random() * 6);
        if (template === 0) return `${actor} the ${pick(d.things)} register that ${relative} ${noun} for ${place}.`;
        if (template === 1) return `${actor} ${noun} for ${place}, cutting turnaround by 30 percent.`;
        if (template === 2) return `${actor} a panel of 4 that ${relative} ${noun}.`;
        if (template === 3) return `${actor} ${noun} and the ${pick(d.things)} for ${place}.`;
        if (template === 4) return `Weekly ${noun} reports, ${pick(['tracking', 'routing', 'flagging'])} ${pick(d.things)} for ${place}.`;
        return `${actor} the ${noun}; ${pick(['Trained', 'Mentored', 'Scheduled'])} ${pick(d.things)} for ${place}.`;
      };
      const SUPPORT_OR_GROUP = /\b(?:maintenance|upkeep|monitoring|administration|oversight|assistance|participation|operation|support|servicing|stewardship|sustainment|housekeeping|maintain(?:ed|s|ing)?|monitor(?:ed|s|ing)?|administer(?:ed|s|ing)?|assist(?:ed|s|ing)?|help(?:ed|s|ing)?|support(?:ed|s|ing)?|keep|kept|service[sd]?|participat(?:ed|es|ing)|contribut(?:ed|es|ing)|aid(?:ed|s)?|tend(?:ed|s)?|member|part|team|group|crew|squad|committee)\b/iu;
      let total = 0;
      for (let round = 0; round < 5400; round += 1) {
        const d = DOMAINS[round % DOMAINS.length];
        const quotes = [plainQuote(d), plainQuote(d), plainQuote(d)].slice(0, 1 + (round % 3));
        for (const quote of quotes) assert(!SUPPORT_OR_GROUP.test(quote), `the fuzz quote must hold no support-class head (${JSON.stringify(quote)})`);
        const text = bullet(d);
        const found = findings(text, quotes);
        assert(found.length === 0, `round ${round}: ${JSON.stringify(text)} against ${JSON.stringify(quotes)} must be quiet (got ${JSON.stringify(found)})`);
        total += 1;
      }
      // Through the production gate, a sample: no class mismatch is ever reported for them.
      for (let round = 0; round < 360; round += 1) {
        const d = DOMAINS[round % DOMAINS.length];
        const quotes = [plainQuote(d)];
        const text = bullet(d);
        assert(!mismatch(text, quotes), `round ${round}: the production gate reports no class mismatch for ${JSON.stringify(text)}`);
        total += 1;
      }
      // Another field's statements of every shape (support noun, support verb, frame, team) leave a bullet alone, whatever the bullet says.
      const shapes = d => [
        support(d), `Maintained the ${d.work} that ${verb(d)} ${d.object}.`, `Monitored the ${d.work}, which ${d.s} ${d.object}.`, `Member of the team that ${lower(d.past)} ${d.object}.`,
        `Assisted the platform team in ${d.ing} ${d.object}.`, `Worked with the crew that ${lower(d.past)} ${d.object}.`,
      ];
      for (let round = 0; round < 3000; round += 1) {
        const owner = DOMAINS[round % DOMAINS.length];
        const other = DOMAINS[(round + 1 + Math.floor(random() * (DOMAINS.length - 1))) % DOMAINS.length];
        const text = bullet(other);
        const found = findings(text, [shapes(owner)[round % 6]]);
        // A bullet whose verb IS the owner's action is the tripwire's business, and draws no conclusion about another field.
        if (candidateActions(text).some(action => action.stem === candidateActions(`${owner.past} ${owner.object}.`)[0].stem)) continue;
        assert(found.length === 0, `round ${round}: ${JSON.stringify(text)} is about another field than ${JSON.stringify(shapes(owner)[round % 6])} (got ${JSON.stringify(found)})`);
        total += 1;
      }
      assert(total >= 8000, 'at least eight thousand cases');
      return { total };
    },
  },
];
