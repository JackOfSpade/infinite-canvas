// Source-verb fidelity: a statement that puts the candidate in a SUPPORT role
// for work that itself carries out an action never supports a sentence that
// makes the candidate the actor of that action.
//
// The failure these tests pin. A live run's career file described a piece of
// work as "<artifact> maintenance that <verb>s <object>": the artifact performs
// the action, and the candidate maintained the artifact. The generated bullet
// made the candidate the actor of the verb and carried no maintenance verb; five
// blind-review rounds and every host gate let it through, and independent
// fact-checkers confirmed it as an unsupported ownership claim. The host's
// ownership checks were ordered strength classes for leadership, oversight and
// authorship, but nothing ordered SUPPORT below PERFORM. The citation made it
// worse: the bullet cited only a technology row the host projected out of the
// statement, a row that holds the clause after "that" and none of the words
// that put the candidate in a support role, so the check must read the
// statement the row was cut from.
//
// What each group proves:
//   lifecycle   A the inflated bullet is rejected with the class mismatch it
//               observes; B one quote that says the candidate made the work (or
//               did the action) makes the SAME text admissible; C removing it
//               rejects again; and the faithful rewrites stay admissible
//               (five invented domains, six statement shapes)
//   mutation    flipping one piece of the evidence in a temporary fixture (the
//               support head, the relative clause, the actor, the verb) flips
//               admissibility
//   letter      the same sentences, in the first person, in a cover-letter
//               paragraph, with the sentence named in the observation
//   excerpt     a quote that excerpts a longer statement is read with that
//               statement: through the options, through a legacy corpus, and
//               through the approved authority's catalog (the real stage twin)
//   clauses     the support role has to be stated for THIS work; coordinated
//               and several-verb statements are read verb by verb
//   quiet       ordinary quotes and bullets that are not this defect (no support
//               head, a passive, another actor, a list of duties, a support
//               verb as the claim, an unrelated claim) are never rejected
//   module      the vocabulary is ordered classes, the stem rule is the stated
//               one, and the actions a text makes the candidate the actor of are
//               read by position
//   wording     the observation states the class mismatch and the repair, from
//               the evidence and the claim only
//
// Every fixture is SYNTHETIC: invented careers in unrelated fields (finance
// reporting, field sensors, library cataloguing, clinic reminders, freight
// routing). Nothing in production names any of them.
import { assert } from './testHelpers.js';
import {
  APPLICATION_QUALITY_CHECKLIST_VERSION, APPLICATION_QUALITY_CRITERIA, __pasteUnitGroundingErrorsForTests, assertSourceQuoteLinksFinalText, sanitizeQualityReview,
} from '../../electron/ipc/localAiApplication.js';
import { authorityEntityEvidenceQuotes, buildApplicationCareerAuthority } from '../../electron/ipc/applicationCareerAuthority.js';
import { approvedCareerEvidenceCatalog, CAREER_SNAPSHOT_STATUS_APPROVED } from '../../electron/ipc/careerSnapshot.js';
import {
  ROLE_STRENGTH_CLASSES, SUPPORT_HEAD_NOUNS, candidateActions, describeRoleStrengthFinding,
  roleStrengthFindings, sameActionStem, supportAssertions,
} from '../../electron/ipc/applicationRoleStrength.js';

// `work` is the thing the candidate maintained; `past`/`ing`/`s`/`base` inflect
// the action the work performs; `done` is a quote in which the candidate did
// that action themself; `made` is a quote in which the candidate made the work.
const DOMAINS = Object.freeze([
  {
    key: 'finance reporting', work: 'nightly report jobs', Work: 'Nightly report job', base: 'compile', s: 'compiles', past: 'Compiled', ing: 'compiling',
    object: 'ledger summaries for the finance team',
    made: 'Wrote the nightly report jobs for the finance team.',
    done: 'Compiled ledger summaries by hand whenever a job failed.',
    unrelatedMade: 'Designed a welcome packet for new analysts.', unrelatedClaim: 'Reconciled vendor invoices for the quarter.',
  },
  {
    key: 'field sensors', work: 'field sensor stations', Work: 'Field sensor station', base: 'record', s: 'records', past: 'Recorded', ing: 'recording',
    object: 'soil moisture readings for the research farm',
    made: 'Designed the field sensor stations for the research farm.',
    done: 'Recorded soil moisture readings by hand during outages.',
    unrelatedMade: 'Created a field guide for volunteer surveyors.', unrelatedClaim: 'Tabulated rainfall totals for the county.',
  },
  {
    // The statement is written in one spelling and the claim in another ("catalogue" / "Cataloged"), so the stem rule's
    // long-common-prefix branch carries this domain.
    key: 'library cataloguing', work: 'catalogue import jobs', Work: 'Catalogue import job', base: 'catalogue', s: 'catalogues', past: 'Cataloged', ing: 'cataloguing',
    object: 'new acquisitions for the reading rooms',
    made: 'Developed the catalogue import jobs for the reading rooms.',
    done: 'Cataloged new acquisitions by hand when an import failed.',
    unrelatedMade: 'Wrote a handout for new patrons.', unrelatedClaim: 'Shelved returned periodicals each morning.',
  },
  {
    key: 'clinic reminders', work: 'appointment reminder service', Work: 'Appointment reminder service', base: 'send', s: 'sends', past: 'Sent', ing: 'sending',
    object: 'text reminders to patients before visits',
    made: 'Built the appointment reminder service for the front desk.',
    done: 'Sent text reminders to patients before visits when the service was down.',
    unrelatedMade: 'Wrote a phone script for the billing desk.', unrelatedClaim: 'Scheduled follow-up visits for the nurses.',
  },
  {
    key: 'freight routing', work: 'route planner service', Work: 'Route planner service', base: 'calculate', s: 'calculates', past: 'Calculated', ing: 'calculating',
    object: 'delivery windows for each depot',
    made: 'Developed the route planner service for the depots.',
    done: 'Calculated delivery windows for each depot during the holiday rush.',
    unrelatedMade: 'Wrote a safety checklist for the loading bays.', unrelatedClaim: 'Dispatched trucks to the northern depots.',
  },
]);

// The six shapes a statement can put the candidate in a support role for work
// that carries out an action.
const SHAPES = Object.freeze([
  { name: 'noun, work before the head', statement: d => `${d.Work} maintenance that ${d.s} ${d.object}.` },
  { name: 'noun, work after the head', statement: d => `Maintenance of the ${d.work} that ${d.base} ${d.object}.` },
  { name: 'verb, work after the verb', statement: d => `Maintained the ${d.work} that ${d.base} ${d.object}.` },
  { name: 'noun with a comma-led participle', statement: d => `${d.Work} upkeep, ${d.ing} ${d.object}.` },
  { name: 'noun with a purpose infinitive', statement: d => `${d.Work} upkeep to ${d.base} ${d.object}.` },
  { name: 'another support noun (monitoring)', statement: d => `${d.Work} monitoring that ${d.s} ${d.object}.` },
]);

const catalogQuote = (text, id = 'ach-0001') => `- Achievement [${id}]: ${text}`;

/** The production verdict of the gate every stage runs: '' when accepted, else the rejection message. */
function judge(text, quotes, { label = 'resumeBullets', identityTokens = [], ...options } = {}) {
  try {
    assertSourceQuoteLinksFinalText(text, quotes.map((quote, index) => catalogQuote(quote, `ach-${index + 1}`)), label, 0, { identityTokens, ...options });
    return '';
  } catch (error) { return String(error?.message || error); }
}
const accepted = (...args) => judge(...args) === '';
const MISMATCH = /Observed class mismatch/u;
const mismatch = (...args) => MISMATCH.test(judge(...args));

const inflated = d => `${d.past} ${d.object}.`;
const faithfulClaims = d => [
  `Maintained the ${d.work} that ${d.base} ${d.object}.`,
  `Maintained the ${d.work} and ${d.past.toLowerCase()} ${d.object}.`,
  `Kept the ${d.work} ${d.ing} ${d.object}.`,
  `Monitored the ${d.work} that ${d.base} ${d.object}.`,
];

export default [
  {
    name: 'Source verb: support of work that performs an action never supports the candidate as its actor, and one quote that says the candidate made the work or did the action admits the same text (A/B/C, five domains, six statement shapes)',
    run() {
      let verdicts = 0;
      for (const d of DOMAINS) {
        for (const shape of SHAPES) {
          const where = `${d.key} / ${shape.name}`;
          const base = [shape.statement(d)];
          const text = inflated(d);
          // A: the inflated bullet is rejected, with the observation the writer needs.
          const a = judge(text, base);
          assert(MISMATCH.test(a), `${where}: A must reject ${JSON.stringify(text)} as a class mismatch (got ${a || 'acceptance'})`);
          assert(a.includes(d.past), `${where}: the observation names the claimed verb ${d.past}`);
          // B: a quote in which the candidate made the work, or did the action, admits the identical text.
          for (const [why, support] of [['made the work', d.made], ['did the action', d.done]]) {
            const b = judge(text, [...base, support]);
            assert(b === '', `${where}: B (a quote says the candidate ${why}) must admit ${JSON.stringify(text)} (got ${b})`);
            // C: take it away again.
            assert(mismatch(text, base), `${where}: C (the ${why} quote removed again) must reject ${JSON.stringify(text)} again`);
            verdicts += 2;
          }
          // A quote about OTHER work the candidate made does not stand in for this work.
          assert(mismatch(text, [...base, d.unrelatedMade]), `${where}: a quote about unrelated work the candidate made must not admit ${JSON.stringify(text)}`);
          // The faithful rewrites stay admissible.
          for (const faithful of faithfulClaims(d)) {
            const verdict = judge(faithful, base);
            assert(verdict === '', `${where}: the faithful ${JSON.stringify(faithful)} must be admitted (got ${verdict})`);
            verdicts += 1;
          }
          verdicts += 2;
        }
      }
      return { verdicts };
    },
  },
  {
    name: 'Source verb: flipping one piece of the evidence flips admissibility (support head, actor, relative clause, verb, the claim itself)',
    run() {
      for (const d of DOMAINS) {
        const text = inflated(d);
        const statement = `${d.Work} maintenance that ${d.s} ${d.object}.`;
        assert(mismatch(text, [statement]), `${d.key}: the unflipped fixture is a mismatch`);
        // The support head is replaced by a noun that is not a support word: no support role is stated.
        assert(accepted(text, [statement.replace('maintenance', 'pipeline')]), `${d.key}: without a support head nothing is asserted`);
        // The candidate is the actor of the clause: the verb is handed to no work.
        assert(accepted(text, [`Handled maintenance work. ${statement.replace('that', 'and').replace(d.s, d.past.toLowerCase())}`]), `${d.key}: a clause the candidate carries is not the work's`);
        // A passive relative clause has no actor, so the work performs nothing.
        assert(accepted(text, [`${d.Work} maintenance that was approved by the board for ${d.object}.`]), `${d.key}: a passive relative clause hands the work no action`);
        // Another actor named in the clause: the work is not the actor either.
        assert(accepted(text, [`${d.Work} maintenance that the vendor team owns for ${d.object}.`]), `${d.key}: a clause with its own subject hands the work no action`);
        // The action is a different action.
        assert(accepted(`Reconciled ${d.object}.`, [statement]), `${d.key}: a different verb is not the asserted action`);
        // The claim keeps the support role.
        assert(accepted(`Maintained the ${d.work} that ${d.base} ${d.object}.`, [statement]), `${d.key}: the faithful claim is admitted`);
        // The same verb, about other work: the quote's work is not the claim's.
        assert(roleStrengthFindings(`${d.past} the quarterly staffing roster for the clinic.`, [catalogQuote(statement)]).length === 0, `${d.key}: the same verb about other work is not a finding`);
        assert(!mismatch(`${d.past} the quarterly staffing roster for the clinic.`, [statement]), `${d.key}: nor is it rejected by the gate as one`);
        // The claim is about other work.
        assert(!mismatch(d.unrelatedClaim, [statement]) && roleStrengthFindings(d.unrelatedClaim, [catalogQuote(statement)]).length === 0, `${d.key}: an unrelated claim is not about this work`);
      }
    },
  },
  {
    name: 'Source verb: the same sentences in a cover-letter paragraph, first person, name the sentence and are admitted once the evidence says so (A/B/C, five domains)',
    run() {
      for (const d of DOMAINS) {
        const statement = `${d.Work} maintenance that ${d.s} ${d.object}.`;
        const opener = `I maintained the ${d.work} that ${d.base} ${d.object}.`;
        const first = `I ${d.past.toLowerCase()} ${d.object}.`;
        const paragraph = `${opener} ${first}`;
        const label = 'coverLetterParagraphs';
        const a = judge(paragraph, [statement], { label });
        assert(MISMATCH.test(a) && /sentence 2/u.test(a), `${d.key}: the second sentence is the mismatch and the observation names it (got ${a || 'acceptance'})`);
        assert(!/sentence 1\b/u.test(a), `${d.key}: the faithful first sentence is not reported`);
        assert(accepted(opener, [statement], { label }), `${d.key}: the faithful first-person sentence is admitted`);
        assert(mismatch(first, [statement], { label }), `${d.key}: the first-person inflated sentence is rejected alone`);
        assert(judge(first, [statement, d.made], { label }) === '', `${d.key}: B a quote that says the candidate made the work admits the sentence`);
        assert(judge(first, [statement, d.done], { label }) === '', `${d.key}: B a quote that says the candidate did the action admits the sentence`);
        assert(mismatch(first, [statement, d.unrelatedMade], { label }), `${d.key}: C an unrelated quote does not`);
        // "by <-ing>" and "my experience <-ing>" make the candidate the actor too.
        assert(mismatch(`I cut review time by ${d.ing} ${d.object}.`, [statement], { label }), `${d.key}: a means ("by ${d.ing}") is the candidate's own action`);
        assert(mismatch(`My experience ${d.ing} ${d.object} shows in this work.`, [statement], { label }), `${d.key}: "my experience ${d.ing}" is the candidate's own action`);
        // An impersonal sentence about the work is not the candidate's action.
        assert(!mismatch(`The ${d.work} ${d.base} ${d.object}.`, [statement], { label }), `${d.key}: a sentence whose subject is the work is not rejected`);
      }
    },
  },
  {
    name: 'Source verb: a quote that excerpts a longer statement is read with that statement (options, legacy corpus, approved authority catalog)',
    run() {
      for (const d of DOMAINS) {
        const statement = `${d.Work} maintenance that ${d.s} ${d.object}.`;
        const parent = catalogQuote(statement, 'ach-0007');
        const excerpt = `- Technology [Achievement ID: ach-0007]: ${d.s} ${d.object}`;
        const text = inflated(d);
        const judgeExcerpt = options => {
          try {
            assertSourceQuoteLinksFinalText(text, [excerpt], 'resumeBullets', 0, { identityTokens: [], ...options });
            return '';
          } catch (error) { return String(error?.message || error); }
        };
        // The excerpt alone says nothing about the candidate's part: nothing to read, nothing rejected.
        assert(judgeExcerpt({}) === '', `${d.key}: the excerpt alone asserts nothing`);
        // With the statement it was cut from (the host projection's sibling rows) the mismatch is plain.
        assert(MISMATCH.test(judgeExcerpt({ statementQuotes: [parent] })), `${d.key}: the statement the excerpt was cut from is read`);
        // Through a legacy career text in which the excerpt is part of a longer line.
        const corpus = ['Some Name', 'Some Role at Some Employer', `- ${statement}`, '- Another line about other work entirely.'].join('\n');
        assert(MISMATCH.test(judgeExcerpt({ sourceCorpus: corpus })), `${d.key}: the corpus line the excerpt occurs in is read`);
        // Mutation: the line says the candidate made the work -> admissible; the line is not about this excerpt -> nothing to read.
        assert(judgeExcerpt({ sourceCorpus: corpus.replace(statement, d.made) }) === '', `${d.key}: a corpus line that says the candidate made the work asserts nothing`);
        assert(judgeExcerpt({ statementQuotes: [catalogQuote(d.made, 'ach-0007')] }) === '', `${d.key}: a statement that says the candidate made the work asserts nothing`);
        assert(judgeExcerpt({ statementQuotes: [parent, catalogQuote(d.made, 'ach-0007')] }) === '', `${d.key}: with the statement AND a quote that the candidate made the work, the text is admitted`);
        // The excerpt row is dropped as a statement of its own: an excerpt that begins with the verb is not "the candidate did it".
        assert(MISMATCH.test(judgeExcerpt({ statementQuotes: [parent, catalogQuote(`${d.s} ${d.object}`, 'ach-0007')] })), `${d.key}: an excerpt of the statement is not a quote that the candidate did the action`);
        // The same when the statement is in the past tense and its excerpt OPENS with the verb in a form that, standing alone, reads as the candidate's own action.
        const past = `${d.Work} maintenance that ${d.past.toLowerCase()} ${d.object}.`;
        const pastExcerpt = `- Technology [Achievement ID: ach-0007]: ${d.past.toLowerCase()} ${d.object}`;
        assert(candidateActions(pastExcerpt).some(action => action.stem === candidateActions(`${d.past} x`)[0].stem), `${d.key}: the past-tense excerpt, alone, does read as the candidate's own action`);
        assert(MISMATCH.test(judgeExcerpt({ statementQuotes: [catalogQuote(past, 'ach-0007'), pastExcerpt] })), `${d.key}: an excerpt that opens with the verb is the statement's clause, not a quote that the candidate did the action`);
        assert(judgeExcerpt({ statementQuotes: [pastExcerpt] }) === '', `${d.key}: and with no statement to read it from, the excerpt alone asserts nothing`);
      }
    },
  },
  {
    name: 'Source verb: through the approved authority the stage twin reads the entity\'s own statement when only a projected row is cited, and flips with the statement (three domains)',
    run() {
      for (const d of DOMAINS.slice(0, 3)) {
        const statement = `${d.Work} maintenance that ${d.s} ${d.object}.`;
        const build = (claim, extra = {}) => {
          const evidence = ['seg-1'];
          const reference = technology => ({ technology, disposition: 'skill', skillId: 'skill-a', relationship: 'independent', relationshipGroup: '', relationshipEvidence: technology, evidenceSegmentIds: evidence });
          const profile = {
            identity: { name: 'Pat Example', contacts: ['pat@example.test'], evidenceSegmentIds: evidence },
            roles: [{ id: 'role-a', title: 'Operations analyst', employer: 'Harborline Services', startDate: 'March 2019', endDate: 'Present', location: '', achievementIds: ['ach-a', 'ach-b'], skillIds: ['skill-a'], evidenceSegmentIds: evidence }],
            achievements: [
              { id: 'ach-a', roleId: 'role-a', claim, technologies: [], technologyReferences: [reference(d.work), reference(`${d.s} ${d.object}`)], metrics: [], evidenceSegmentIds: evidence },
              { id: 'ach-b', roleId: 'role-a', claim: extra.other || `Wrote the intake checklist for ${d.object}.`, technologies: [], technologyReferences: [], metrics: [], evidenceSegmentIds: evidence },
            ],
            projects: [], skills: [{ id: 'skill-a', name: d.Work, category: 'tool', capabilityKind: 'tool', supportMode: 'direct', directEvidenceSegmentIds: evidence, indexEligible: true, roleIds: ['role-a'], evidenceSegmentIds: evidence }],
            education: [], certifications: [], otherEvidence: [], segmentCoverage: [],
          };
          const snapshot = { snapshotId: `verb-fidelity-${d.key}`, status: CAREER_SNAPSHOT_STATUS_APPROVED, profile };
          const catalog = approvedCareerEvidenceCatalog(snapshot);
          return { authority: buildApplicationCareerAuthority(snapshot), catalog };
        };
        const run = ({ authority, catalog }, text, ids) => __pasteUnitGroundingErrorsForTests({
          unitLabel: 'Bullet', unitId: 'b1', finalText: text, evidenceIds: ids, acceptedEvidence: catalog, identityTokens: [], label: 'resumeBullets',
          sourceRoles: authority.sourceRoles, careerData: '', authority, projects: [], targetCompany: '',
        });
        const world = build(statement);
        const excerptId = world.catalog.find(item => item.quote.includes(`${d.s} ${d.object}`) && /^- Technology \[/u.test(item.quote)).id;
        const statementId = world.catalog.find(item => item.quote.startsWith('- Achievement [ach-a]')).id;
        const text = inflated(d);
        // The siblings are exactly the entity's own rows.
        const siblings = authorityEntityEvidenceQuotes(world.authority, excerptId);
        assert(siblings.some(quote => quote.includes(statement)) && siblings.every(quote => quote.includes('ach-a')), `${d.key}: siblings are the rows of the one entity`);
        assert(authorityEntityEvidenceQuotes(world.authority, 'host.career.achievement.nope.1').length === 0, `${d.key}: an unknown id has no siblings`);
        // The live shape: only the projected row is cited.
        const errors = run(world, text, [excerptId]);
        assert(errors.length === 1 && MISMATCH.test(errors[0]) && /Bullet "b1"/u.test(errors[0]), `${d.key}: the stage twin rejects the bullet that cites only the projected row (got ${JSON.stringify(errors)})`);
        // Citing the statement itself is the same verdict.
        assert(run(world, text, [statementId]).some(error => MISMATCH.test(error)), `${d.key}: citing the statement directly is the same verdict`);
        // The faithful rewrite is admitted from either citation.
        for (const faithful of faithfulClaims(d)) assert(run(world, faithful, [excerptId]).length === 0, `${d.key}: the faithful ${JSON.stringify(faithful)} is admitted`);
        // Mutation: the entity's statement now says the candidate made the work -> admitted.
        const changed = build(d.made);
        const changedExcerpt = changed.catalog.find(item => /^- Technology \[/u.test(item.quote) && item.quote.includes(`${d.s} ${d.object}`)).id;
        assert(run(changed, text, [changedExcerpt]).length === 0, `${d.key}: a statement that says the candidate made the work admits the text`);
        // Mutation: another entity's rows are not this entity's statement.
        const other = build(`Wrote the intake checklist for ${d.object}.`, { other: statement });
        const otherExcerpt = other.catalog.find(item => /^- Technology \[/u.test(item.quote) && item.quote.includes(`${d.s} ${d.object}`)).id;
        assert(run(other, text, [otherExcerpt]).length === 0, `${d.key}: a support statement in ANOTHER entity is not read for this bullet`);
        // A cover-letter paragraph meets the same twin, with its sentence named.
        const letter = __pasteUnitGroundingErrorsForTests({
          unitLabel: 'Paragraph', unitId: 'p1', finalText: `I maintained the ${d.work} that ${d.base} ${d.object}. I ${d.past.toLowerCase()} ${d.object}.`, evidenceIds: [excerptId],
          acceptedEvidence: world.catalog, identityTokens: [], label: 'coverLetterParagraphs', sourceRoles: world.authority.sourceRoles, careerData: '',
          authority: world.authority, projects: [], targetCompany: '',
        });
        assert(letter.some(error => MISMATCH.test(error) && /sentence 2/u.test(error)), `${d.key}: the letter twin names the second sentence (got ${JSON.stringify(letter)})`);
      }
    },
  },
  {
    name: 'Source verb: a legacy job\'s stage twin and completion gate read the career-text line an excerpt quote occurs in (three domains)',
    run() {
      for (const d of DOMAINS.slice(2)) {
        const statement = `${d.Work} maintenance that ${d.s} ${d.object}.`;
        const excerpt = `${d.s} ${d.object}`;
        const letterLine = 'Wrote an intake checklist for the front desk team in the clinic.';
        const corpusOf = line => ['Pat Example', 'Operations analyst at Harborline Services', `- ${line}`, `- ${letterLine}`].join('\n');
        const text = inflated(d);
        // The stage twin of a legacy job carries the frozen career text.
        const twin = careerData => __pasteUnitGroundingErrorsForTests({
          unitLabel: 'Bullet', unitId: 'b1', finalText: text, evidenceIds: ['e1'], acceptedEvidence: [{ id: 'e1', sourceId: 'career-data', quote: excerpt }],
          identityTokens: [], label: 'resumeBullets', sourceRoles: [], careerData, authority: null, projects: [], targetCompany: '',
        });
        assert(twin(corpusOf(statement)).some(error => MISMATCH.test(error)), `${d.key}: the legacy twin reads the line the excerpt occurs in`);
        assert(twin(corpusOf(`${d.made} ${statement}`)).length === 0, `${d.key}: a line that also says the candidate made the work admits the bullet`);
        assert(twin(corpusOf(statement.replace('maintenance', 'pipeline'))).length === 0 && twin('').length === 0, `${d.key}: no support statement in the career text, nothing to read`);
        // The completion gate: the same corpus, the same quote, the same verdict.
        const review = bullet => ({
          checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
          criteria: APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: `${requirement} measured on the rendered ${id} copy.` })),
          resume: { decision: 'drafted', rationale: 'The r\u00e9sum\u00e9 keeps source-supported operations evidence and its stated work.' },
          coverLetter: { decision: 'drafted', rationale: 'One controlling argument uses minimum-sufficient evidence for front desk operations work.' },
          sourceGrounding: {
            resumeBullets: [{ bullet, careerDataQuotes: [excerpt] }],
            coverLetterParagraphs: [{ paragraph: letterLine, careerDataQuotes: [letterLine] }],
          },
        });
        const context = (bullet, corpus) => ({
          required: true, careerData: corpus, frozenSourceQuotes: false,
          resumeEvidence: { roles: [{ title: 'Operations analyst', company: 'Harborline Services', bullets: [{ text: bullet }] }] },
          coverLetter: { paragraphs: [letterLine] },
          coverLetterArgument: { primaryEvidence: { evidence: bullet, evidenceRole: 'Operations analyst at Harborline Services' } },
        });
        const gate = (bullet, corpus) => {
          try { sanitizeQualityReview(review(bullet), context(bullet, corpus), APPLICATION_QUALITY_CHECKLIST_VERSION); return ''; } catch (error) { return String(error?.message || error); }
        };
        assert(MISMATCH.test(gate(text, corpusOf(statement))), `${d.key}: the completion gate rejects the inflated bullet that cites an excerpt (got ${gate(text, corpusOf(statement)) || 'acceptance'})`);
        assert(gate(text, corpusOf(`${d.made} ${statement}`)) === '', `${d.key}: and admits it once the line also says the candidate made the work (got ${gate(text, corpusOf(`${d.made} ${statement}`))})`);
        // A career text whose lines were joined keeps its entries apart: only the sentence the excerpt occurs in is read, never the other entries.
        // (Another entry of the text saying the candidate made the work is another entry, not this statement's sentence.)
        const joined = `${[...corpusOf(statement).split('\n'), `- ${d.made}`].join(' ')} ${'Filler sentence about unrelated desk work. '.repeat(30)}`;
        assert(MISMATCH.test(gate(text, joined)), `${d.key}: a joined career text is read by sentence (got ${gate(text, joined) || 'acceptance'})`);
        const faithful = `Maintained the ${d.work} that ${d.base} ${d.object}.`;
        assert(gate(faithful, corpusOf(statement)) === '', `${d.key}: the faithful bullet passes the gate (got ${gate(faithful, corpusOf(statement))})`);
      }
    },
  },
  {
    name: 'Source verb: the support role has to be stated for THIS work, and a statement of several verbs is read verb by verb',
    run() {
      for (const d of DOMAINS) {
        const statement = `${d.Work} maintenance that ${d.s} ${d.object}.`;
        // A support verb for ANOTHER work does not state this work's support role.
        assert(mismatch(`${d.past} ${d.object}; maintained the intake spreadsheet.`, [statement]), `${d.key}: a maintenance clause about other work is not this work's role`);
        assert(accepted(`Maintained the ${d.work} and ${d.past.toLowerCase()} ${d.object}.`, [statement]), `${d.key}: a coordinated support clause about this work is`);
        assert(accepted(`${d.past} ${d.object} while maintaining the ${d.work}.`, [statement]), `${d.key}: a support participle about this work is`);
        // The support noun the statement used also states the role, beside the work.
        assert(accepted(`Provided ${d.work} maintenance, ${d.ing} ${d.object}.`, [statement]), `${d.key}: the statement's own support noun, beside the work, states the role`);
        // Not beside the work: a stray word is no role.
        assert(mismatch(`${d.past} ${d.object} ahead of the maintenance window.`, [statement]), `${d.key}: a support noun unrelated to the work states no role`);
        // Several verbs handed to the work: each is the work's, so each is the candidate's only when the role is kept.
        const many = `${d.Work} maintenance that ${d.s} and archives ${d.object}.`;
        assert(mismatch(`Archived ${d.object}.`, [many]), `${d.key}: the second verb of the statement is asserted too`);
        assert(mismatch(inflated(d), [many]), `${d.key}: and so is the first`);
        assert(accepted(`Maintained the archives of ${d.object}.`, [many]), `${d.key}: a noun of the same stem is not an action`);
        assert(accepted(`Maintained the ${d.work} that archive ${d.object}.`, [many]), `${d.key}: the role kept for the second verb`);
        // A rejected text is reported once per action, not once per statement.
        const twice = judge(inflated(d), [statement, `Maintenance of the ${d.work} that ${d.base} ${d.object}.`]);
        assert((twice.match(/Observed class mismatch/gu) || []).length === 1, `${d.key}: one action is reported once (got ${twice})`);
      }
    },
  },
  {
    name: 'Source verb: ordinary quotes and bullets that are not this defect are never rejected by it (no-false-positive corpus, five domains)',
    run() {
      const quiet = (text, quotes, where, options) => {
        const found = roleStrengthFindings(text, quotes.map(quote => catalogQuote(quote)), options);
        assert(found.length === 0, `${where}: ${JSON.stringify(text)} must not be a role-strength finding (got ${JSON.stringify(found)})`);
        const verdict = judge(text, quotes, options);
        assert(!MISMATCH.test(verdict), `${where}: the production gate must not report a class mismatch for ${JSON.stringify(text)} (got ${verdict})`);
      };
      for (const d of DOMAINS) {
        // The candidate made it, or did it: the ordinary shapes of career data.
        quiet(inflated(d), [`Built a job that ${d.s} ${d.object}.`], d.key);
        quiet(inflated(d), [`${d.past} ${d.object} for the team.`], d.key);
        quiet(`I ${d.past.toLowerCase()} ${d.object}.`, [`${d.past} ${d.object} for the team.`], d.key, { label: 'coverLetterParagraphs' });
        // A support head with no action handed to a work.
        quiet(inflated(d), [`${d.Work} maintenance windows scheduled around ${d.object}.`], d.key);
        quiet(inflated(d), [`Maintenance of the ${d.work}.`, `${d.past} ${d.object} for the team.`], d.key);
        // Not an action of the work: a passive, another actor, a state.
        quiet(`Approved ${d.object}.`, [`${d.Work} maintenance that was approved by the board for ${d.object}.`], d.key);
        quiet(`Requested ${d.object}.`, [`${d.Work} maintenance that the vendor team requested for ${d.object}.`], d.key);
        quiet(`Included ${d.object}.`, [`${d.Work} maintenance that includes ${d.object}.`], d.key);
        // A list of duties is not a work that acts.
        quiet('Patched the servers.', [`${d.Work} maintenance, patching, and troubleshooting.`], d.key);
        quiet('Alerted on failures.', [`${d.Work} monitoring, alerting on failures.`], d.key);
        quiet('Patched the servers.', [`${d.Work} maintenance, patching servers, and monitoring dashboards.`], d.key);
        quiet('Patched the servers.', [`${d.Work} maintenance, patching servers and answering tickets.`], d.key);
        // The claim keeps the support role, in every form of it.
        for (const faithful of faithfulClaims(d)) quiet(faithful, [`${d.Work} maintenance that ${d.s} ${d.object}.`], d.key);
        quiet(`Supported the team with ${d.object}.`, [`${d.Work} maintenance that ${d.s} ${d.object}.`], d.key);
        quiet(`Helped ${d.base} ${d.object}.`, [`${d.Work} maintenance that ${d.s} ${d.object}.`], d.key);
        quiet(`Participated in ${d.ing} ${d.object}.`, [`Participated in the rollout that ${d.s} ${d.object}.`], d.key);
        // An unrelated claim, or one whose verb is another verb.
        quiet(d.unrelatedClaim, [`${d.Work} maintenance that ${d.s} ${d.object}.`], d.key);
        quiet(`Documented ${d.object}.`, [`${d.Work} maintenance that ${d.s} ${d.object}.`], d.key);
        // A verb that opens a noun phrase, and a base-form word that is not a verb here.
        quiet(`${d.base[0].toUpperCase()}${d.base.slice(1)} schedules for ${d.object}.`, [`${d.Work} maintenance that ${d.s} ${d.object}.`], d.key);
        // The work is the candidate's: a statement that says it was made.
        quiet(inflated(d), [`Built ${d.work} monitoring that ${d.s} ${d.object}.`], d.key);
        // Support as a function ("support desk") with no relative clause.
        quiet(inflated(d), [`Support desk coverage for ${d.object}.`, `${d.past} ${d.object} for the team.`], d.key);
      }
    },
  },
  {
    name: 'Source verb module: ordered classes, the stem rule, and the actions a text makes the candidate the actor of',
    run() {
      // Ordered role-strength classes, as data.
      assert(ROLE_STRENGTH_CLASSES.map(klass => klass.id).join('>') === 'support>perform>create', 'the classes are ordered support, perform, create');
      assert(ROLE_STRENGTH_CLASSES.every((klass, index) => klass.rank === index + 1), 'ranks follow the order');
      assert(ROLE_STRENGTH_CLASSES.every(klass => klass.verbs.every(verb => /^[a-z]+$/u.test(verb))), 'the vocabulary is plain lowercase verbs (language data), nothing else');
      const verbOwners = new Map();
      for (const klass of ROLE_STRENGTH_CLASSES) for (const verb of klass.verbs) { assert(!verbOwners.has(verb), `"${verb}" is in one class only`); verbOwners.set(verb, klass.id); }
      for (const verb of ['maintain', 'support', 'monitor', 'administer', 'assist', 'participate']) assert(verbOwners.get(verb) === 'support', `${verb} is support`);
      for (const verb of ['run', 'operate', 'execute', 'perform']) assert(verbOwners.get(verb) === 'perform', `${verb} is perform`);
      for (const verb of ['build', 'develop', 'engineer', 'design', 'implement', 'create', 'author', 'launch', 'lead', 'own', 'architect']) assert(verbOwners.get(verb) === 'create', `${verb} is create/own`);
      for (const noun of ['maintenance', 'upkeep', 'support', 'monitoring', 'administration', 'oversight', 'assistance', 'participation', 'operation']) {
        assert(SUPPORT_HEAD_NOUNS.includes(noun), `${noun} is a support head`);
      }
      // The stem rule: inflection, or a common prefix of at least four letters that covers most of the shorter stem.
      assert(sameActionStem('compil', 'compil') && sameActionStem('prep', 'prepar') && sameActionStem('organis', 'organiz') && sameActionStem('record', 'recorder'), 'inflections and long prefixes share a stem');
      assert(!sameActionStem('compil', 'comput') && !sameActionStem('process', 'procur') && !sameActionStem('manag', 'manual') && !sameActionStem('rep', 'repair'), 'a shared four-letter beginning alone is not the same action');
      // The actions a text makes the candidate the actor of, by position.
      const positions = text => candidateActions(text).map(action => `${action.word.toLowerCase()}:${action.position}`).join(' ');
      const cases = [
        ['Compiled the roster.', 'compiled:initial'],
        ['Also compiled the roster.', 'compiled:initial'],
        ['I regularly compiled the roster.', 'compiled:subject'],
        ['We have compiled the roster.', 'compiled:subject'],
        ['I would compile the roster.', ''],
        ["I'm compiling the roster.", 'compiling:subject'],
        ['I was compiling the roster.', 'compiling:subject'],
        ["I'd compile the roster.", ''],
        ['Maintained jobs that compile summaries.', 'maintained:initial'],
        ['Maintained jobs and compiled summaries.', 'maintained:initial compiled:coordinated'],
        ['Maintained jobs that checked and compiled summaries.', 'maintained:initial'],
        ['Maintained jobs, compiling summaries.', 'maintained:initial compiling:participial'],
        ['Cut effort by compiling summaries.', 'cut:initial compiling:manner'],
        ['My experience compiling summaries is broad.', 'compiling:experience'],
        ['Responsible for compiling summaries.', 'compiling:duty'],
        ['Summaries compiled nightly.', ''],
        ['Compile scripts for the desk.', ''],
        ['Compile the scripts for the desk.', 'compile:initial'],
        ['Built tooling to compile summaries.', 'built:initial'],
      ];
      for (const [text, expected] of cases) assert(positions(text) === expected, `actions of ${JSON.stringify(text)}: expected "${expected}", got "${positions(text)}"`);
      // The class of an action is the vocabulary's, or none.
      const classes = candidateActions('Maintained jobs and ran reports and built tools and tidied desks.').map(action => `${action.word}:${action.cls?.id ?? '-'}`).join(' ');
      assert(classes === 'Maintained:support ran:perform built:create tidied:-', `classes by vocabulary (got ${classes})`);
      // The shapes of an assertion.
      const shapes = [
        ['Report job maintenance that compiles summaries.', 'noun', 'compiles'],
        ['Maintenance of report jobs that compile summaries.', 'noun', 'compile'],
        ['Maintained report jobs that compile summaries.', 'verb', 'compile'],
        ['Report job upkeep, compiling summaries daily.', 'noun', 'compiling'],
        ['Report job upkeep to compile summaries daily.', 'noun', 'compile'],
        ['Report job maintenance that was compiling summaries.', 'noun', 'compiling'],
        ['Report job maintenance that has compiled summaries.', 'noun', 'compiled'],
        ['Operation of the batch scheduler that triggers loads.', 'noun', 'triggers'],
      ];
      for (const [text, kind, verb] of shapes) {
        const found = supportAssertions(text);
        assert(found.length === 1 && found[0].kind === kind && found[0].verbs[0].word === verb, `assertion of ${JSON.stringify(text)}: expected ${kind}/${verb}, got ${JSON.stringify(found.map(entry => [entry.kind, entry.verbs.map(v => v.word)]))}`);
      }
      const none = [
        'Report job maintenance that was approved by the board.',
        'Report job maintenance that the team requested.',
        'Report job maintenance that includes summaries.',
        'Report job maintenance, patching, and troubleshooting.',
        'Built monitoring that tracks temperature.',
        'To support users that compile reports, I wrote guides.',
        'Assistance to staff on the front desk.',
        'Report job maintenance, patching servers, and monitoring dashboards.',
        'Report job maintenance windows that run overnight.',
      ];
      for (const text of none) assert(supportAssertions(text).length === 0, `${JSON.stringify(text)} asserts nothing (got ${JSON.stringify(supportAssertions(text).map(entry => entry.head))})`);
    },
  },
  {
    name: 'Source verb observation: states the class mismatch and BOTH faithful repairs (hold the support role, or cite the statement that shows the candidate did it) from the evidence and the claim only, and never lists a verb to copy',
    run() {
      const wording = [];
      for (const d of DOMAINS) {
        const statement = `${d.Work} maintenance that ${d.s} ${d.object}.`;
        const found = roleStrengthFindings(inflated(d), [catalogQuote(statement)]);
        assert(found.length === 1, `${d.key}: one finding`);
        const message = describeRoleStrengthFinding('Bullet "b1"', found[0]);
        wording.push(message);
        assert(/the source says the candidate supported it/u.test(message) && /the text claims the candidate performed it/u.test(message), `${d.key}: the observed class mismatch is stated (${message})`);
        // Both faithful repairs are stated: hold to the support role, OR cite the statement that shows the candidate did it.
        assert(/Two repairs are faithful/u.test(message) && /hold the candidate to the support role the statement gives/u.test(message)
          && /in your own words with a verb that matches it/u.test(message), `${d.key}: the support-role repair is stated`);
        assert(/only where the career data really says the candidate made the work or did the action themself, cite that statement as well as this one/u.test(message), `${d.key}: the citation repair is stated`);
        assert(!/leave /iu.test(message.replace(/“[^”]*”/gu, ' ')) && /leaving “[^”]+” with the work/u.test(message), `${d.key}: the verb stays with the work, without a bare instruction to leave it out`);
        assert(message.includes(d.past) && message.includes(d.s) && message.includes('maintenance'), `${d.key}: the claim's verb and the evidence's own words are quoted`);
        // The observation says nothing a vocabulary list put there: remove the evidence and the claim and no verb of the vocabulary is left.
        const residue = message.replace(/“[^”]*”/gu, ' ');
        // (The class names the observation is required to state, support and performed, and the adjective of "your own
        // words" are the English words they are, not examples of a verb to copy.)
        const classWords = new Set(['support', 'perform', 'own']);
        for (const klass of ROLE_STRENGTH_CLASSES) {
          for (const verb of klass.verbs.filter(entry => !classWords.has(entry))) {
            assert(!new RegExp(`\\b${verb}(?:s|d|ed|ing)?\\b`, 'iu').test(residue), `${d.key}: the observation must not name the vocabulary verb "${verb}" outside the evidence and the claim`);
          }
        }
      }
      // A claimed creation verb is reported as creation, in the same fixed words.
      const made = roleStrengthFindings('Produced dashboards for regional managers.', [catalogQuote('Supported analysts who produce dashboards for regional managers.')]);
      assert(made.length === 1 && /created or owned/u.test(describeRoleStrengthFinding('Bullet "b1"', made[0])), 'a creation verb is claimed as created or owned');
      assert(new Set(wording).size === DOMAINS.length, 'the wording differs only by the evidence it quotes');
    },
  },
];
