// Sentence-local source grounding for the cover letter.
//
// A paragraph cites up to four career-data quotes, and the proportion limits make
// merged paragraphs the normal shape of a letter. Judging a sentence against all
// of them lets it borrow a qualifier, figure, count, name or ownership word from a
// quote about OTHER work; judging it against too few rejects the sentence that
// truthfully blends two proofs, and the writer cannot tell why. The reading under
// test judges each claim against the quotes about the CLAUSE that makes it:
//
//   accepted  a stated span of years, a credential, a distinct claim a second
//             quote supports, and a sentence that blends two proofs
//   rejected  a qualifier, figure, ownership word, name or count that only a quote
//             about other work states, with a message that says so
//
// Every case is SYNTHETIC: invented careers in unrelated fields (ward nursing,
// dispatch, teaching, retail, finance, software, nonprofit, clinic data). Nothing
// in production names any of them. The pattern the family uses:
//
//   A  the cited quotes do not state the claim              -> rejected
//   B  A + a quote about the SAME work that states it       -> accepted
//   C  B with that quote swapped for one about OTHER work   -> rejected, naming it
//   D  the quote removed again                              -> rejected
//
// and every rejection is paired with the faithful version of the same sentence,
// so a rule cannot pass by rejecting everything.
import { assert } from './testHelpers.js';
import {
  __poolingAnalysisForTests, assertSourceQuoteLinksFinalText, postingFreeClauses, sentenceAddressesTarget,
} from '../../electron/ipc/localAiApplication.js';
import { findUnsupportedDurationClaim, sentences } from '../../electron/ipc/coverLetterChecks.js';
import {
  LOCAL_QUOTE_CONTAINMENT_FRACTION, LOCAL_QUOTE_NEAR_DUPLICATE_FRACTION, LOCAL_QUOTE_SHARE_FRACTION, MIN_LOCAL_QUOTE_DISTINCT_TERMS,
  MIN_LOCAL_QUOTE_SHARED_RUN, MIN_LOCAL_QUOTE_SHARED_TERMS, groundingClauses, quantityFindings, quoteVerbHints, relatedQuoteIndexes,
  relatednessStem,
} from '../../electron/ipc/applicationClaimGrounding.js';

const catalog = (text, index) => `- Achievement [ach-${index}]: ${text}`;
const meaningful = value => [...new Set(String(value).toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])];

/** '' when the paragraph is accepted, else the rejection message. */
function verdict(text, quotes, identityTokens = [], options = {}) {
  try {
    assertSourceQuoteLinksFinalText(text, quotes.map((quote, index) => catalog(quote, index + 1)), 'coverLetterParagraphs', 0, { identityTokens, ...options });
    return '';
  } catch (error) { return String(error?.message || error); }
}
const BORROWED = /states? it, but describes? different work from this clause/u;
// A claim no single cited quote states for its clause, though the whole sentence passed on words that belong to another clause.
const ELSEWHERE = /no cited quote about this clause states it, and what let the whole sentence pass belongs to a different clause/u;
const QUOTE_A_PASSAGE = /quote a passage/u;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Each domain: the quote the work sentence is about, a quote that states a span of years, a credential quote, and the
// sentence stems the cases below extend.
const SPAN_DOMAINS = Object.freeze([
  { key: 'ward nursing', work: 'Coordinated bedside handoffs across a twenty eight bed cardiac unit.', span: 'Fourteen years of clinical nursing experience.', shorter: 'Eleven years of clinical nursing experience.',
    clause: 'I coordinated bedside handoffs across a twenty eight bed cardiac unit' },
  { key: 'dispatch', work: 'Rerouted drivers each week with a dispatch board built for the regional offices.', span: 'Fourteen years of dispatch experience.', shorter: 'Eleven years of dispatch experience.',
    clause: 'I rerouted drivers each week with a dispatch board built for the regional offices' },
  { key: 'teaching', work: 'Taught algebra to four sections of ninth graders and tutored the school math team.', span: 'Fourteen years of classroom teaching experience.', shorter: 'Eleven years of classroom teaching experience.',
    clause: 'I taught algebra to four sections of ninth graders and tutored the school math team' },
  { key: 'retail', work: 'Counted the receiving dock each morning and reconciled the delivery manifests.', span: 'Fourteen years of retail operations experience.', shorter: 'Eleven years of retail operations experience.',
    clause: 'I counted the receiving dock each morning and reconciled the delivery manifests' },
]);

// ---------------------------------------------------------------------------

export default [
  {
    name: 'Locality: a stated span of years cited beside the work quote supports the span in any clause of the sentence, and the answer agrees with the shared duration decision (A/B/C, four domains)',
    run() {
      for (const domain of SPAN_DOMAINS) {
        const both = [domain.work, domain.span];
        const claims = [
          `${domain.clause}, drawing on 14+ years.`,
          `${domain.clause}, drawing on 14 years in the field.`,
          `With 14 years in the profession, ${domain.clause.replace(/^I /u, 'I ')}.`,
          `After 14 years at the work, ${domain.clause}.`,
          `${domain.clause}, and I did it with 14 years of experience.`,
          `${domain.clause} and have done so for 14 years.`,
          `${domain.clause}, drawing on nearly fourteen years.`,
        ];
        for (const text of claims) {
          // B: the span quote is cited, so every shape is accepted, and the shared duration decision agrees.
          const b = verdict(text, both);
          assert(b === '', `${domain.key}/B: accepted when a cited quote states the span (${text}; got ${b})`);
          assert(!findUnsupportedDurationClaim(text, both.map((quote, index) => catalog(quote, index + 1))), `${domain.key}: the shared duration decision accepts ${text}`);
          // A: no cited quote states a span, so the claim is rejected for the span, by the duration decision.
          const a = verdict(text, [domain.work]);
          assert(a !== '', `${domain.key}/A: rejected when no cited quote states a span (${text})`);
          // C: a quote that states a SHORTER span supports no longer one.
          const c = verdict(text, [domain.work, domain.shorter]);
          assert(c !== '', `${domain.key}/C: eleven years does not support fourteen (${text})`);
          // D: restored.
          assert(verdict(text, both) === '', `${domain.key}/D: accepted again`);
        }
        // A bound that the stated span does not reach is rejected even with the quote, by the same decision.
        const over = `${domain.clause}, a skill I developed over 14 years.`;
        assert(verdict(over, both) !== '' && Boolean(findUnsupportedDurationClaim(over, both.map((quote, index) => catalog(quote, index + 1)))),
          `${domain.key}: “over 14 years” needs more than the 14 the quote states, by the shared decision and by the gate`);
        // The rejection of a span still names a span, not a borrowed clause.
        assert(/claims an experience span/u.test(verdict(over, both)), `${domain.key}: the message names the span`);
      }
    },
  },
  {
    name: 'Locality: a credential or a role the candidate states about themselves is supported by the quote that records it, not only by the quote about the work (A/B/C, three domains)',
    run() {
      const cases = [
        { key: 'scrum', work: 'Led sprint planning and retrospectives for four product teams.', credential: 'Certified Scrum Master, Scrum Alliance, 2021.', notCredential: 'Facilitated sprint retrospectives for four product teams.',
          text: 'As a Certified Scrum Master I led sprint planning for four product teams.', unowned: 'As a Certified Scrum Master I managed sprint planning for four product teams.' },
        { key: 'nursing', work: 'Coordinated bedside handoffs across a twenty eight bed cardiac unit.', credential: 'Registered Nurse, state board license, 2012.', notCredential: 'Charted vital signs for a twenty eight bed cardiac unit.',
          text: 'As a Registered Nurse I coordinated bedside handoffs across a twenty eight bed cardiac unit.', unowned: 'As a Registered Nurse I managed the staffing of a twenty eight bed cardiac unit.' },
        { key: 'dispatch', work: 'Rerouted drivers each week with a dispatch board built for the regional offices.', credential: 'Commercial Driver CDL license, class B.', notCredential: 'Dispatched drivers each week from the regional offices.',
          text: 'I rerouted drivers each week with a dispatch board and hold a CDL license.', unowned: 'I rerouted drivers each week with a dispatch board and hold a PMP certification.' },
      ];
      for (const entry of cases) {
        assert(verdict(entry.text, [entry.work]) !== '', `${entry.key}/A: rejected when no cited quote records the credential`);
        const b = verdict(entry.text, [entry.work, entry.credential]);
        assert(b === '', `${entry.key}/B: accepted when a cited quote records it (got ${b})`);
        assert(verdict(entry.text, [entry.work, entry.notCredential]) !== '', `${entry.key}/C: a quote about the same work that records no credential does not support it`);
        assert(verdict(entry.text, [entry.work]) !== '', `${entry.key}/D: rejected again`);
        // The credential quote lends the credential only: an ownership word still needs a quote about the work that says it.
        assert(verdict(entry.unowned, [entry.work, entry.credential]) !== '', `${entry.key}: the credential quote lends no claim about other work (${entry.unowned})`);
      }
      // A credential named without a frame ("A Certified Scrum Master, I led ...") is still a statement about the candidate.
      // The work quote is long and the credential quote short, so the credential quote is not "about the clause" by any measure of the work:
      // it supports the credential because it records it.
      const longWork = 'Led sprint planning, retrospectives, and release reviews for four product teams across the platform group.';
      const frameless = 'A Certified Scrum Master, I led sprint planning, retrospectives, and release reviews for four product teams across the platform group.';
      assert(verdict(frameless, [longWork, cases[0].credential]) === '' && verdict(frameless, [longWork]) !== '', 'a credential named without “as a” is supported by the quote that records it and by nothing else');
    },
  },
  {
    name: 'Locality: a second cited quote supports the distinct claim it states in the same sentence: a name, a credential, a count, a figure (A/B/C/D, four domains)',
    run() {
      const cases = [
        { key: 'dispatch name', work: 'Rerouted drivers each week with a dispatch board built for the regional offices and cut late deliveries.', other: 'Built weekly reports in Tableau for the operations director.',
          wrong: 'Built weekly reports in Looker for the operations director.', text: 'I rerouted drivers each week with a dispatch board and reported results in Tableau.' },
        { key: 'dispatch credential', work: 'Rerouted drivers each week with a dispatch board built for the regional offices.', other: 'Commercial Driver CDL license, class B.',
          wrong: 'Dispatched drivers each week from the regional offices.', text: 'I rerouted drivers each week with a dispatch board and hold a CDL license.' },
        { key: 'dispatch count', work: 'Rerouted drivers each week with a dispatch board built for the regional offices.', other: 'Coached six coordinators on the dispatch tooling.',
          wrong: 'Coached coordinators on the dispatch tooling.', text: 'I rerouted drivers each week with a dispatch board and coached six coordinators.' },
        { key: 'dispatch figure', work: 'Rerouted drivers each week with a dispatch board built for the regional offices.', other: 'Late deliveries fell by 12% after the dispatch board launched.',
          wrong: 'Late deliveries fell after the dispatch board launched.', text: 'I rerouted drivers each week with a dispatch board and late deliveries fell by 12%.' },
        { key: 'teaching count', work: 'Led the science department curriculum review for grades nine through twelve.', other: 'Trained five new teachers on the school grade book software.',
          wrong: 'Trained new teachers on the school grade book software.', text: 'I led the science curriculum review and trained five new teachers on the grade book software.' },
        { key: 'retail figure', work: 'Managed a team of twelve cashiers and stockers across two shifts at a grocery store.', other: 'Cut shrink by 18% by counting the receiving dock each morning.',
          wrong: 'Cut shrink by counting the receiving dock each morning.', text: 'I managed twelve cashiers and stockers across two shifts and cut shrink by 18%.' },
        { key: 'software name', work: 'Owned the release pipeline for a mobile app with 40,000 users.', other: 'Reduced build time from 25 minutes to 9 minutes by caching dependencies in Docker.',
          wrong: 'Reduced build time from 25 minutes to 9 minutes by caching dependencies.', text: 'I owned the release pipeline for 40,000 users and cut build time by caching dependencies in Docker.' },
        { key: 'finance name', work: 'Reconciled fifty small business accounts each month in Excel.', other: 'Built a Power BI dashboard of monthly cash flow for the branch managers.',
          wrong: 'Built a dashboard of monthly cash flow for the branch managers.', text: 'I reconciled fifty small business accounts each month in Excel and built a Power BI dashboard of cash flow.' },
      ];
      for (const entry of cases) {
        const a = verdict(entry.text, [entry.work]);
        assert(a !== '', `${entry.key}/A: rejected when only the work quote is cited (${entry.text})`);
        const b = verdict(entry.text, [entry.work, entry.other]);
        assert(b === '', `${entry.key}/B: accepted when the second quote states the claim (got ${b})`);
        assert(verdict(entry.text, [entry.other, entry.work]) === '', `${entry.key}: the order the quotes are cited in changes nothing`);
        const c = verdict(entry.text, [entry.work, entry.wrong]);
        assert(c !== '', `${entry.key}/C: a second quote that does not state the claim does not support it`);
        assert(verdict(entry.text, [entry.work]) !== '', `${entry.key}/D: rejected again`);
      }
    },
  },
  {
    name: 'Locality: blended sentences are accepted when each clause is supported by its own quote, ownership verbs and tool names count toward relatedness, and the quote dropped from the clause that needs it is the rejection (A/B/C, six domains)',
    run() {
      const cases = [
        { key: 'support desk', idt: ['support', 'team', 'lead'],
          quotes: ['Managed the Zendesk help desk for a support team of nine and rewrote the macros agents used most often.', 'Built a weekly ticket report that showed response times by queue and shared it with the product team.'],
          text: 'I managed the Zendesk help desk and built a weekly ticket report that showed response times by queue.', drop: 0, rule: /managed|management ownership|Zendesk/u },
        { key: 'release pipeline', idt: ['engineer'],
          quotes: ['Owned the release pipeline for a mobile app with 40,000 users.', 'Wrote the runbook that on-call engineers used during outages.'],
          // outage / outages: one term
          text: 'I owned the release pipeline for 40,000 users and wrote the outage runbook.', drop: 1, rule: /wrote|authorship/u },
        { key: 'meal service', idt: ['coordinator'],
          quotes: ['Led weekend meal service for 60 volunteers across three community sites.', 'Kept a donation intake log that matched each delivery to the food bank invoice.'],
          text: 'I led weekend meal service for 60 volunteers and kept a donation intake log.', drop: 0, rule: /led|leadership|60/u },
        { key: 'analytics', idt: ['analyst'],
          quotes: ['Wrote SQL queries against the sales database to build a weekly dashboard of sales by store.', 'Analyzed twelve promotions and showed that three of them lowered profit.'],
          text: 'I wrote SQL queries to build a weekly dashboard of sales by store and analyzed twelve promotions.', drop: 1, rule: /twelve|three|analy/u },
        { key: 'curriculum', idt: ['teacher'],
          quotes: ['Led the science department curriculum review for grades nine through twelve.', 'Trained five new teachers on the school grade book software.'],
          text: 'I led the curriculum review for grades nine through twelve and trained five new teachers.', drop: 1, rule: /five/u },
        { key: 'dock scheduling', idt: ['analyst'],
          quotes: ['Managed inbound dock scheduling for a distribution center with three shifts.', 'Built a weekly report of late trucks by carrier and used it to renegotiate two carrier contracts.'],
          text: 'I managed dock scheduling for three shifts, and I built a weekly report of late trucks that helped renegotiate two carrier contracts.', drop: 0, rule: /managed|management|three/u },
        { key: 'long first clause', idt: ['analyst'],
          quotes: ['Merged appointment and billing records from three clinic scheduling systems into one reporting database with nightly Python pipelines.', 'Supervised the data operations desk during the night shift and managed the weekend roster.'],
          text: 'I merged appointment and billing records from three clinic scheduling systems into one reporting database with nightly Python pipelines and managed the night shift for the data operations desk.', drop: 1, rule: /managed|management ownership/u },
        { key: 'cardiac unit', idt: ['nurse'],
          quotes: ['Coordinated bedside handoffs across a twenty eight bed cardiac unit.', 'Precepted new graduate nurses on a surgical ward.'],
          text: 'I coordinated handoffs on a twenty eight bed cardiac unit and precepted new graduate nurses on a surgical ward.', drop: 0, rule: /./u, permissive: true },
      ];
      for (const entry of cases) {
        const b = verdict(entry.text, entry.quotes, entry.idt);
        assert(b === '', `${entry.key}/B: the blended sentence is accepted (got ${b})`);
        assert(verdict(entry.text, [...entry.quotes].reverse(), entry.idt) === '', `${entry.key}: citation order changes nothing`);
        if (entry.permissive) continue;
        // C: the quote that is about the clause is removed (a filler quote about nothing in the sentence stands in): rejected.
        const dropped = entry.quotes.map((quote, index) => (index === entry.drop ? 'Balanced the department supply budget before each quarter closed.' : quote));
        const c = verdict(entry.text, dropped, entry.idt);
        assert(c !== '' && entry.rule.test(c), `${entry.key}/C: the clause whose quote was removed is rejected (got ${c || 'acceptance'})`);
        assert(verdict(entry.text, entry.quotes, entry.idt) === '', `${entry.key}/D: restored`);
      }
      // One term, not two: a stem joins outage and outages, managed and manage, planning and plans, queries and query.
      for (const [left, right] of [['outage', 'outages'], ['managed', 'manage'], ['planning', 'plans'], ['queries', 'query'], ['reported', 'reports'], ['cutting', 'cut'], ['processes', 'process']]) {
        assert(relatednessStem(left) === relatednessStem(right), `“${left}” and “${right}” are one term (${relatednessStem(left)} / ${relatednessStem(right)})`);
      }
      assert(relatednessStem('status') === 'status' && relatednessStem('analysis') === 'analysis' && relatednessStem('dispatch') !== relatednessStem('dispatcher'), 'a stem does not strip the s of a word that ends in -us or -is, nor join a noun to its agent');
    },
  },
  {
    name: 'Locality: a qualifier, figure, ownership word, name or interval that only a quote about OTHER work states is rejected, the message names that quote and the repair, and the same sentence is accepted once its own quote states it (A/B/C/D, four kinds, three domains)',
    run() {
      const cases = [
        // clinic data
        { key: 'qualifier', own: 'Built a nightly import job that loads clinic appointment records into the reporting database.', other: 'Led an organization-wide rollout of clinic reporting dashboards on the appointment records database.',
          same: 'Built a nightly import job that loads clinic appointment records into the reporting database and rolled it out organization-wide.',
          text: 'I built a nightly import job that loads clinic appointment records into the reporting database organization-wide.', rule: /unsupported organization-wide scope/u },
        { key: 'interval', own: 'Built a nightly import job that loads clinic appointment records into the reporting database.', other: 'Ran a daily refresh of the clinic reporting dashboards from the appointment records database.',
          same: 'Built a nightly import job that loads clinic appointment records into the reporting database and ran it every day.',
          text: 'I built a nightly import job that loads clinic appointment records into the reporting database every day.', rule: /rate interval “per day”/u },
        { key: 'figure', own: 'Built a nightly import job that loads clinic appointment records into the reporting database.', other: 'Cut manual reporting effort by 40% for the clinic reporting team using appointment records dashboards.',
          same: 'Built a nightly import job that loads clinic appointment records into the reporting database and cut manual effort by 40%.',
          text: 'I built a nightly import job that loads clinic appointment records into the reporting database, cutting manual effort by 40%.', rule: /unsupported figure “40%”/u },
        { key: 'ownership', own: 'Built a nightly import job that loads clinic appointment records into the reporting database.', other: 'Led the clinic reporting migration and owned the appointment records database.',
          same: 'Led a nightly import job that loads clinic appointment records into the reporting database.',
          text: 'I led a nightly import job that loads clinic appointment records into the reporting database.', rule: /unsupported leadership ownership/u },
        // dispatch
        { key: 'qualifier', own: 'Compared on-time delivery rates for twelve carriers over six months.', other: 'Reviewed the dock schedule every day for the receiving supervisor.',
          same: 'Compared on-time delivery rates for twelve carriers over six months, every day.',
          text: 'I compared on-time delivery rates for twelve carriers over six months daily.', rule: /unsupported daily frequency/u },
        { key: 'name', own: 'Built a weekly sales dashboard for regional managers.', other: 'Administered Tableau Server for 200 analysts.',
          same: 'Built a weekly sales dashboard for regional managers in Tableau.',
          text: 'I built a weekly sales dashboard for regional managers in Tableau.', rule: /names “Tableau”/u },
        { key: 'ownership', own: 'Scheduled weekly staffing using Excel and the payroll system.', other: 'Managed a team of twelve cashiers and stockers across two shifts.',
          same: 'Scheduled weekly staffing for a team of twelve and managed the payroll system.',
          text: 'I scheduled weekly staffing for the team of twelve and managed the payroll system.', rule: /unsupported management ownership/u },
        // finance
        { key: 'figure', own: 'Reconciled fifty small business accounts each month in Excel.', other: 'Built a Power BI dashboard of monthly cash flow for branch managers, saving 30% of review time.',
          same: 'Reconciled fifty small business accounts each month in Excel, saving 30% of review time.',
          text: 'I reconciled fifty small business accounts each month in Excel, saving 30% of review time.', rule: /unsupported figure “30%”/u },
        { key: 'qualifier', own: 'Trained five new teachers on the school grade book software.', other: 'Led the science curriculum review for grades nine through twelve across the district.',
          same: 'Trained five new teachers on the school grade book software across the district.',
          text: 'I trained five new teachers on the grade book software, district-wide.', rule: /unsupported organization-wide scope/u },
      ];
      for (const entry of cases) {
        const where = `${entry.key}: ${entry.text}`;
        const a = verdict(entry.text, [entry.own]);
        assert(a !== '' && entry.rule.test(a), `A rejects with its own reason (${where}; got ${a || 'acceptance'})`);
        assert(!BORROWED.test(a), `A: with no quote stating it, the message does not claim another quote does (${where})`);
        const c = verdict(entry.text, [entry.own, entry.other]);
        assert(c !== '' && entry.rule.test(c), `C: the quote about other work lends nothing (${where}; got ${c || 'acceptance'})`);
        assert(BORROWED.test(c) || ELSEWHERE.test(c), `C: the message says a cited quote states it but describes different work, or that the words which passed it belong to another clause (${where}; got ${c})`);
        if (BORROWED.test(c)) assert(c.includes(entry.other.split(' ').slice(0, 3).join(' ')), `C: the message names the quote (${where})`);
        assert(/Say it in a sentence about the work that states it, or leave it out of this one/u.test(c) && !QUOTE_A_PASSAGE.test(c), `C: the message names the repair, and it is not “quote a passage” (${where})`);
        assert(verdict(entry.text, [entry.other, entry.own]) !== '', `C: citation order changes nothing (${where})`);
        const b = verdict(entry.text, [entry.own, entry.same]);
        assert(b === '', `B: a quote about the same work that states it admits the sentence (${where}; got ${b})`);
        assert(verdict(entry.text, [entry.own, entry.other]) !== '', `D: rejected again (${where})`);
      }
    },
  },
  {
    name: 'Locality: each claim is judged against the clause that makes it: a coordinated clause has its own quote, a trailing result phrase belongs to the clause it trails, a means or another piece of work does not (three domains)',
    run() {
      // The coordinated clause is its own work.
      const support = ['Managed the Zendesk help desk for a support team of nine.', 'Built a weekly ticket report that showed response times by queue.'];
      const analysis = __poolingAnalysisForTests('I managed the Zendesk help desk and built a weekly ticket report that showed response times by queue.', support.map(catalog));
      assert(analysis.clauses.length === 2 && analysis.clauses[0] === 'I managed the Zendesk help desk' && analysis.clauses[1].startsWith('built a weekly ticket report'), `a sentence is cut at the coordinated statement (${JSON.stringify(analysis.clauses)})`);
      const clauseOf = (analysisResult, term) => analysisResult.entries.find(entry => entry.term === term);
      assert(JSON.stringify(clauseOf(analysis, 'managed').related) === '[0]' && JSON.stringify(clauseOf(analysis, 'weekly').related) === '[1]', 'each claim is judged against the quote its own clause is about');
      // A list, and a noun phrase that happens to contain a gerund, are not clauses.
      assert(groundingClauses('I built pipelines in Python, SQL, and Tableau for the finance team.').length === 1, 'a list is one clause');
      assert(groundingClauses('I loaded appointment and billing records from three systems.').length === 1, 'a noun phrase joined by “and” is one clause');
      assert(groundingClauses('I tracked and prepared them weekly.').length === 1, 'two verbs that share a complement are one clause');
      assert(groundingClauses('I managed the help desk, and managing the budget fell to me.').length === 2, 'after a comma, “and” + a gerund starts a clause');
      assert(groundingClauses('I wrote the report; the director signed it.').length === 2 && groundingClauses('I wrote the report: the director signed it.').length === 2, 'a semicolon or a colon cuts');
      assert(groundingClauses('I kept the log and kept the books for three shifts.').length === 2 && groundingClauses('I kept the log and she kept the books.').length === 2, 'an irregular verb or a subject after “and” starts a clause');
      assert(groundingClauses('I ran the desk and coached staff.', quoteVerbHints(['Coached staff on the new tooling.'])).length === 2 && quoteVerbHints(['Coached staff.', 'Built reports; Trained staff.']).has('trained'),
        'a word the cited quotes open a statement with is a verb');

      // A trailing result phrase belongs to the clause it trails: a figure only another quote states is rejected there...
      const job = 'Built a nightly import job that loads clinic appointment records into the reporting database.';
      const dashboards = 'Cut manual reporting effort by 40% for the clinic reporting team using appointment records dashboards.';
      const result = 'I built a nightly import job that loads clinic appointment records into the reporting database, cutting manual effort by 40%.';
      assert(/unsupported figure “40%”/u.test(verdict(result, [job, dashboards])) && BORROWED.test(verdict(result, [job, dashboards])), 'a result phrase is judged against the clause it trails');
      assert(verdict(result.replace(', cutting manual effort by 40%', ' and cut manual effort by 40%'), [job, dashboards]) === '', 'the same words as a coordinated clause are a claim of their own, supported by their own quote');
      // ...while a means or another piece of work is its own clause.
      const board = ['Built a weekly sales dashboard of sales by store.', 'Analyzed twelve promotions and showed that three of them lowered profit.', 'Presented the results to store operations managers each month.'];
      const means = 'I presented the promotion results to store operations managers each month, using the weekly dashboard I had built.';
      assert(verdict(means, board, ['analyst']) === '', 'a phrase that brings in another piece of work is judged against the quote about it');
      assert(verdict(means, [board[2], board[1]], ['analyst']) !== '', 'and is rejected when no cited quote is about it');
      // A qualifier and an interval in a result phrase are claims about the trailed work too.
      const importer = 'Built a nightly import job that loads clinic appointment records into the reporting database.';
      const refresh = 'Ran a daily refresh of the clinic reporting dashboards from the appointment records database.';
      const savings = 'I built a nightly import job that loads clinic appointment records into the reporting database, saving the reporting team hours daily.';
      const savingsEveryDay = 'I built a nightly import job that loads clinic appointment records into the reporting database, saving the reporting team hours every day.';
      assert(/unsupported daily frequency/u.test(verdict(savings, [importer, refresh])) && BORROWED.test(verdict(savings, [importer, refresh])), 'a qualifier in a result phrase is judged against the clause it trails');
      assert(/rate interval “per day”/u.test(verdict(savingsEveryDay, [importer, refresh])) && BORROWED.test(verdict(savingsEveryDay, [importer, refresh])), 'and so is an interval');
      assert(verdict(savings, [importer, `${importer.slice(0, -1)}, saving the reporting team hours daily.`]) === '' && verdict(savingsEveryDay, [importer, `${importer.slice(0, -1)}, saving the reporting team hours every day.`]) === '',
        'both are accepted once a quote about the trailed work states them');
      // Three domains, A/B/C: the result phrase with and without the quote about the trailed work.
      const triples = [
        ['dispatch', 'I rerouted drivers each week with the dispatch board, cutting late deliveries by 12%.', 'Rerouted drivers each week with the dispatch board and cut late deliveries by 12%.', 'Rerouted drivers each week with the dispatch board.', 'Cut late deliveries by 12% after the dispatch board launched.'],
        ['teaching', 'I led the curriculum review for grades nine through twelve, raising the department pass rate from 71% to 84%.', 'Led the curriculum review for grades nine through twelve and raised the department pass rate from 71% to 84%.', 'Led the science department curriculum review for grades nine through twelve.', 'Raised the department pass rate from 71% to 84% over two years.'],
        ['retail', 'I counted the receiving dock each morning, which cut shrink by 18%.', 'Cut shrink by 18% by counting the receiving dock each morning.', 'Counted the receiving dock each morning.', 'Cut shrink by 18% across the store.'],
      ];
      for (const [key, text, same, own, other] of triples) {
        const a = verdict(text, [own]);
        assert(/unsupported figure/u.test(a) && !BORROWED.test(a), `${key}/A: rejected when nothing states the figure`);
        assert(verdict(text, [own, same]) === '', `${key}/B: accepted when the quote about the trailed work states it (got ${verdict(text, [own, same])})`);
        if (key !== 'retail') assert(BORROWED.test(verdict(text, [own, other])), `${key}/C: a quote about other work states it and is named`);
        assert(/unsupported figure/u.test(verdict(text, [own])), `${key}/D: rejected again`);
      }
    },
  },
  {
    name: 'Locality: which quotes a clause is about: the best-sharing quote is always one, a quote with only the subject matter in common is not, and the same work stated again or in more detail is (unit)',
    run() {
      const clause = 'built a nightly import job that loads clinic appointment records into the reporting database';
      const best = 'Built a nightly import job that loads clinic appointment records into the reporting database.';
      const subjectOnly = 'Led an organization-wide rollout of clinic reporting dashboards on the appointment records database.';
      const sameWorkMoreDetail = 'Built a nightly import job that loads clinic appointment records into the reporting database, and ran it for the whole network.';
      const nearDuplicate = 'Nightly import job for clinic appointment records, loading the reporting database.';
      const distinctPart = 'Trained the clinic front desk to read the nightly reporting database exports.';
      const unrelated = 'Balanced the department supply budget before each quarter closed.';
      const related = (quotes, excluded = '') => relatedQuoteIndexes(clause, quotes, excluded).indexes;
      assert(MIN_LOCAL_QUOTE_SHARED_TERMS === 2 && LOCAL_QUOTE_SHARE_FRACTION === 0.5 && LOCAL_QUOTE_NEAR_DUPLICATE_FRACTION === 0.8
        && MIN_LOCAL_QUOTE_DISTINCT_TERMS === 2 && LOCAL_QUOTE_CONTAINMENT_FRACTION === 0.8 && MIN_LOCAL_QUOTE_SHARED_RUN === 5, 'the measure the cases sit either side of');
      assert(JSON.stringify(related([best, unrelated])) === '[0]', 'a quote that shares nothing is not related');
      assert(JSON.stringify(related([best, subjectOnly])) === '[0]', 'a quote that shares only the subject matter the quotes have in common is not related');
      assert(JSON.stringify(related([subjectOnly, best])) === '[1]', 'and the order does not matter');
      assert(JSON.stringify(related([best, sameWorkMoreDetail])) === '[0,1]', 'the same work in more detail is related (a shared run of five terms)');
      assert(JSON.stringify(related([best, nearDuplicate])) === '[0,1]', 'a second statement of the same work is related');
      assert(JSON.stringify(related([best, distinctPart])) === '[0,1]' || JSON.stringify(related([best, distinctPart])) === '[0]', 'a quote that adds distinct terms is judged on them');
      // The claim's own words are left out: "organization-wide" does not make the rollout quote about the import job.
      assert(JSON.stringify(related([best, subjectOnly], 'organization-wide')) === '[0]', 'the claim\'s words are no evidence that a quote is about the same work');
      // Below the floor the best-sharing quotes stand in; sharing nothing keeps every quote.
      const thin = relatedQuoteIndexes('tracked and prepared them weekly', ['Tracked eleven restricted grant budgets.', 'Prepared monthly spending reports.', 'Closed the books each week.'], 'weekly');
      assert(thin.mode === 'best' && JSON.stringify(thin.indexes) === '[0,1]', `a clause that reaches no floor is judged by the quotes it shares most with (${JSON.stringify(thin)})`);
      const none = relatedQuoteIndexes('completely unrelated words', [best, subjectOnly]);
      assert(none.mode === 'all' && none.indexes.length === 2, 'a clause that shares nothing leaves every quote');
      assert(relatedQuoteIndexes(clause, [best, subjectOnly]).mode === 'related', 'a clause that reaches the floor is judged by the related quotes');
    },
  },
  {
    name: 'Locality: the claim\'s own words are no evidence that a quote is about the same work, but an ownership verb and a tool name are (three kinds, through the analysis)',
    run() {
      const entryFor = (sentence, quotes, term) => __poolingAnalysisForTests(sentence, quotes.map(catalog), { identityTokens: ['analyst', 'support'] }).entries.find(entry => entry.term === term);
      // A qualifier: "organization-wide" is two terms in a rollout quote, and the rollout quote shares nothing else with the sentence.
      const qualifier = entryFor('I built a nightly import job for clinic appointment records organization-wide.',
        ['Built a nightly import job for clinic appointment records.', 'Led an organization-wide rollout of dashboards.'], 'organization-wide');
      assert(qualifier && qualifier.shares[1] === 0 && qualifier.shares[0] >= 5 && JSON.stringify(qualifier.related) === '[0]', `a qualifier's words are not counted (${JSON.stringify(qualifier)})`);
      // A figure: "12" is a term in a retention quote, and that quote shares nothing else.
      const figure = entryFor('I cut late deliveries by 12% with the dispatch board.', ['Cut late deliveries with the dispatch board.', 'Held attrition at 12% for the night staff.'], '12%');
      assert(figure && figure.shares[1] === 0 && figure.shares[0] >= 3, `a figure's digits are not counted (${JSON.stringify(figure)})`);
      // An interval: "every day" is two terms in a schedule quote.
      const interval = entryFor('I ran the nightly import job every day for the clinic office.', ['Ran the nightly import job for the clinic office.', 'Reviewed the dock schedule every day for the receiving supervisor.'], 'per day');
      assert(interval && interval.shares[1] === 0 && interval.shares[0] >= 4, `an interval's words are not counted (${JSON.stringify(interval)})`);
      // An ownership verb and a tool name are: they say which work the clause is about.
      const sentence = 'I managed the Zendesk help desk for nine agents.';
      const quotes = ['Managed the Zendesk help desk for a support team of nine.', 'Managed a team of nine cashiers.'];
      const ownership = entryFor(sentence, quotes, 'managed');
      assert(ownership && ownership.shares[1] === 2 && ownership.shares[0] >= 4, `an ownership verb is counted (${JSON.stringify(ownership)})`);
      const tool = entryFor(sentence, ['Managed the Zendesk help desk for a support team of nine.', 'Administered Zendesk for the refunds team.'], 'Zendesk');
      assert(tool && tool.shares[1] === 1 && tool.shares[0] >= 4, `a tool name is counted (${JSON.stringify(tool)})`);
    },
  },
  {
    name: 'Locality: a qualifier or a name stated beside the very words it sits beside in the sentence is supported by that quote even when the clause is mostly another quote\'s, and a borrowed one is not (A/B/C, three domains)',
    run() {
      // "weekly" in "the weekly dashboard" and "Snowflake" after "the reporting database" are supported by the quote that says the same.
      const cases = [
        { key: 'analytics', own: 'Built dashboards for the store managers and analyzed twelve promotions that lowered profit.', beside: 'Reviewed the weekly sales dashboard with the store managers.', elsewhere: 'Reviewed the weekly staffing plan for the front desk.',
          text: 'I built the weekly dashboard for the store managers and analyzed twelve promotions.' },
        { key: 'clinic', own: 'Merged appointment and billing records from three scheduling systems with Python and SQL pipelines.', beside: 'Loaded the appointment and billing database in Snowflake.', elsewhere: 'Administered the Snowflake warehouse for the analytics team.',
          text: 'I merged appointment and billing records from three scheduling systems with Python and SQL pipelines into the appointment and billing database in Snowflake.' },
        { key: 'dispatch', own: 'Trained six night coordinators on the new dispatch tooling.', beside: 'Reviewed the daily late-delivery report for the regional offices.', elsewhere: 'Reviewed the daily dock schedule for the receiving supervisor.',
          text: 'I trained six night coordinators on the new dispatch tooling using the daily late-delivery report for the regional offices.' },
      ];
      for (const entry of cases) {
        const a = verdict(entry.text, [entry.own], ['analyst']);
        assert(a !== '' && !BORROWED.test(a), `${entry.key}/A: rejected when nothing states it (${entry.text})`);
        const b = verdict(entry.text, [entry.own, entry.beside], ['analyst']);
        assert(b === '', `${entry.key}/B: accepted when a cited quote states it beside the same words (got ${b})`);
        const c = verdict(entry.text, [entry.own, entry.elsewhere], ['analyst']);
        assert(c !== '' && BORROWED.test(c), `${entry.key}/C: a quote that states it beside other words is borrowed, and the message says so (got ${c || 'acceptance'})`);
        assert(verdict(entry.text, [entry.own], ['analyst']) !== '', `${entry.key}/D: rejected again`);
      }
      // A count borrowed from a quote about other work is not rescued by sharing the counted noun alone.
      const school = 'I managed a fleet of Chromebooks and tablets for two schools, including enrollment in the management console, repairs, and a loaner program for 400 devices.';
      assert(BORROWED.test(verdict(school, ['Managed a fleet of Chromebooks and tablets for two schools, including enrollment in the management console, repairs, and a loaner program for students.', 'Handled the help desk queue for 400 devices across the district.'])),
        'a count whose noun a quote about other work shares is still borrowed');
    },
  },
  {
    name: 'Locality: every borrowed claim in a sentence is reported in the same round, once each, so one rewrite repairs them all',
    run() {
      const importer = 'Built a nightly import job that loads clinic appointment records into the reporting database and checked the load log.';
      const refresh = 'Ran a daily refresh of the clinic reporting dashboards from the appointment records database.';
      const rollout = 'Led an organization-wide rollout of the clinic scheduling dashboard to all offices.';
      const failuresOf = (text, quotes) => {
        try { assertSourceQuoteLinksFinalText(text, quotes.map(catalog), 'coverLetterParagraphs', 0, { identityTokens: [] }); return []; } catch (error) { return error.failures || [error.message]; }
      };
      const stem = 'I built a nightly import job that loads clinic appointment records into the reporting database';
      // Two different borrowed claims: two numbered items. The same claim twice: one.
      const two = failuresOf(`${stem} every day and checked the load log organization-wide.`, [importer, refresh, rollout]);
      assert(two.length === 2 && two.some(message => /unsupported organization-wide scope/u.test(message)) && two.some(message => /rate interval “per day”/u.test(message)) && two.every(message => BORROWED.test(message)),
        `each borrowed claim is reported, with the quote it was borrowed from (got ${JSON.stringify(two.map(message => message.slice(0, 120)))})`);
      // The quote named for an interval is one that states an interval: a rollout quote that states none is not offered as the source.
      const perDay = two.find(message => /rate interval “per day”/u.test(message)) || '';
      assert(perDay.includes('Ran a daily refresh') && !perDay.includes('organization-wide rollout'), `an interval is attributed only to a quote that states one (got ${perDay.slice(0, 400)})`);
      // One quote or several: the message names each quote that states the claim, in the number it is.
      const rollout2 = 'Led an organization-wide migration of the clinic billing database to all offices.';
      const one = failuresOf(`${stem} organization-wide.`, [importer, rollout]).join(' ');
      const several = failuresOf(`${stem} organization-wide.`, [importer, rollout, rollout2]).join(' ');
      assert(/the cited quote “[^”]+” states it, but describes different work from this clause/u.test(one), `one quote: singular (got ${one.slice(0, 300)})`);
      assert(/the cited quotes “[^”]+” and “[^”]+” state it, but describe different work from this clause/u.test(several), `two quotes: plural (got ${several.slice(0, 400)})`);
      const twice = failuresOf(`${stem} every day and checked the load log every day.`, [importer, refresh]);
      assert(twice.length === 1, `a claim repeated in two clauses is reported once (got ${twice.length})`);
      assert(failuresOf(`${stem} and checked the load log.`, [importer, refresh, rollout]).length === 0, 'and the faithful sentence raises none');
      // A claim that no cited quote states is reported as that, alone: the borrowed readings wait until every claim has some quote behind it.
      const unstated = failuresOf(`${stem} every day and always checked the load log.`, [importer, refresh]);
      assert(unstated.length === 1 && /unsupported absolute frequency/u.test(unstated[0]) && !BORROWED.test(unstated[0]), `a claim nothing states is reported by itself (got ${JSON.stringify(unstated.map(message => message.slice(0, 120)))})`);
    },
  },
  {
    name: 'Locality: a claim no cited quote states keeps its older message, and a clause that shares nothing with any quote is judged against all of them as before',
    run() {
      const quotes = ['Built a nightly import job that loads clinic appointment records into the reporting database.', 'Led the clinic reporting migration.'];
      const none = verdict('I built a nightly import job that loads clinic appointment records into the reporting database organization-wide.', quotes);
      assert(/its bound career-data quotes must state that qualifier in one of these forms/u.test(none) && !BORROWED.test(none), 'nothing states it: the message lists the forms that would, as it always did');
      // A sentence made only of its claim words has nothing else to be about: judged against every cited quote.
      const bare = 'I ran the nightly import job for the clinic office. I led it organization-wide.';
      assert(verdict(bare, ['Ran the nightly import job for the clinic office.', 'Led an organization-wide rollout of the shared scheduling dashboard.']) === '', 'a sentence of only claim words is judged against every cited quote');
      assert(verdict(bare, ['Ran the nightly import job for the clinic office.', 'Rolled out the shared scheduling dashboard.']) !== '', 'and is rejected when none of them states the qualifier');
      // A single cited quote is never subject to the locality reading.
      assert(verdict('I built a nightly import job that loads clinic appointment records into the reporting database.', [quotes[0]]) === '', 'one quote: the faithful sentence is accepted');
    },
  },
  {
    name: 'Posting counts: a count the posting states supports a claim only for the same counted noun, never against a cited quote that counts that noun differently (unit, three domains)',
    run() {
      const ctx = { meaningful, trustedNames: [], exemptTokens: [], skipPopulationNouns: true };
      const cases = [
        { key: 'dispatch', sentence: 'The board serves the four regional offices.', same: 'We run four regional offices across the state.', other: 'We run four distribution centers across the state.', quote: 'Rerouted drivers for three regional offices.', value: 'We run seven regional offices across the state.' },
        { key: 'clinic', sentence: 'The pipelines feed the six clinics.', same: 'The group operates six clinics and a lab.', other: 'The group operates six labs and a pharmacy.', quote: 'Loaded records from four clinics.', value: 'The group operates nine clinics and a lab.' },
        { key: 'school', sentence: 'The guides cover the twelve classrooms.', same: 'The campus has twelve classrooms and a gym.', other: 'The campus has twelve teachers and a gym.', quote: 'Wrote guides for eight classrooms.', value: 'The campus has fifteen classrooms and a gym.' },
      ];
      for (const entry of cases) {
        const find = (posting, quotes = ['Wrote the weekly summary for the board.']) => quantityFindings(entry.sentence, quotes, { ...ctx, postingText: posting });
        assert(find('').length === 1, `${entry.key}/A: unsupported without a posting`);
        assert(find(entry.same).length === 0, `${entry.key}/B: supported by a posting count for the same noun`);
        assert(find(entry.other).length === 1, `${entry.key}/C: a posting count for another noun supports nothing`);
        assert(find(entry.value).length === 1, `${entry.key}: a different value supports nothing`);
        assert(find(entry.same, [entry.quote]).length === 1, `${entry.key}: a cited quote that counts the same noun differently wins over the posting`);
        assert(find('').length === 1, `${entry.key}/D: unsupported again`);
      }
      // A count with no counted noun after it names nothing the posting could state a count of.
      const bare = quantityFindings('The board serves four across the state.', ['Wrote the weekly summary for the board.'], { ...ctx, postingText: 'We run four across the region.' });
      assert(bare.length === 1, 'a bare count is supported by no posting count');
    },
  },
  {
    // Round-3 blocker 1. A sentence about the candidate's own work in the present tense ("My scorecards feed ...", "I track ...")
    // passed none of the older candidate readings, so a "your team" anywhere in it freed the posting's tool names for the
    // candidate's work. The freedom is now decided per clause and never granted to a clause with a first-person word.
    name: 'Posting freedom: a first-person clause in any tense gets no posting name, the target marker is read per clause, and a name the candidate\'s clause also carries stays unsupported (A/B/C, three domains)',
    run() {
      const NAMES = /names “/u;
      const domains = [
        { key: 'logistics', company: 'Redline Distribution', tool: 'Tableau', other: 'Looker',
          quote: 'Built weekly carrier scorecards that feed the carrier rotation for the regional offices.',
          posting: tool => `Logistics Analyst, Redline Distribution. Our analysts present carrier scorecards in ${tool}.`,
          stem: 'weekly carrier scorecards feed the carrier rotation for the regional offices', tail: 'carrier rotation', verb: 'I track weekly carrier scorecards that feed the carrier rotation for the regional offices' },
        { key: 'nonprofit', company: 'Community Housing Trust', tool: 'Airtable', other: 'Notion',
          quote: 'Kept a shared workbook of eleven grant budgets and monthly spending reports for each funder.',
          posting: tool => `Grants Finance Analyst, Community Housing Trust. Program managers submit receipts in ${tool}.`,
          stem: 'shared workbook of eleven grant budgets holds monthly spending reports for each funder', tail: 'grant budgets', verb: 'I keep a shared workbook of eleven grant budgets and monthly spending reports for each funder' },
        { key: 'clinic', company: 'Lumen Clinical Analytics', tool: 'Snowflake', other: 'Teradata',
          quote: 'Built nightly pipelines that load appointment and billing records from three clinic scheduling systems into one reporting database.',
          posting: tool => `Data Platform Engineer, Lumen Clinical Analytics. You will run our ${tool} warehouse.`,
          stem: 'nightly pipelines load appointment and billing records from three clinic scheduling systems into one reporting database', tail: 'billing records', verb: 'I run nightly pipelines that load appointment and billing records from three clinic scheduling systems into one reporting database' },
      ];
      for (const d of domains) {
        // Re-applying to an approved former employer keeps the structural
        // employment guard from pre-empting this test of posting-name locality.
        const options = tool => ({ postingText: d.posting(tool), targetCompany: d.company, approvedOrganizations: [d.company] });
        const v = (text, tool = d.tool) => verdict(text, [d.quote], [], options(tool));
        const Stem = `${d.stem.charAt(0).toUpperCase()}${d.stem.slice(1)}`;
        // B: the round-1 shape, an impersonal sentence addressed to the target, still gets the posting's name.
        for (const text of [`The ${d.stem} in ${d.tool} for your team.`, `The ${d.stem} in ${d.tool} for this role.`, `The ${d.stem} in ${d.tool} at ${d.company}.`]) {
          assert(v(text) === '', `${d.key}/B: an impersonal target-facing sentence keeps the posting's name (${text}; got ${v(text)})`);
          assert(NAMES.test(v(text, d.other)), `${d.key}/B': and is rejected when the posting names another tool (${text})`);
        }
        // A: the same name in a sentence that speaks as the candidate, in the present tense, possessive or subject.
        for (const text of [
          `My ${d.stem} in ${d.tool}, the way your team works.`,
          `Our ${d.stem} in ${d.tool} for your team.`,
          `${d.verb} in ${d.tool} for your team.`,
          `For your team, ${d.stem.replace(/^/u, 'my ')} in ${d.tool}.`,
          `The ${d.stem} for me in ${d.tool} at ${d.company}.`,
        ]) {
          if (text.includes(`at ${d.company}`)) {
            const unapproved = verdict(text, [d.quote], [], { postingText: d.posting(d.tool), targetCompany: d.company });
            assert(/the employer this letter is addressed to/u.test(unapproved), `${d.key}/A: an unapproved target employment frame is rejected before tool grounding`);
          }
          const got = v(text);
          assert(NAMES.test(got) && got.includes(`“${d.tool}”`), `${d.key}/A: a first-person clause gets no posting name (${text}; got ${got || 'acceptance'})`);
        }
        // C: the marker is read per clause. A name in a clause that addresses nobody is not freed by "your team" in another clause.
        const unmarked = `${Stem} in ${d.tool}; your team will find the same load.`;
        assert(NAMES.test(v(unmarked)), `${d.key}/C: a name in an unaddressed clause is not freed by another clause's marker (${unmarked}; got ${v(unmarked) || 'acceptance'})`);
        // C': a name the candidate's own clause carries stays unsupported though the target clause names it too.
        const both = `${d.verb} in ${d.tool}; your team runs the ${d.tail} in ${d.tool} as well.`;
        assert(NAMES.test(v(both)), `${d.key}/C': a name the first-person clause also carries stays unsupported (${both}; got ${v(both) || 'acceptance'})`);
        // B'': the target clause alone may carry it, beside a first-person clause that does not.
        const split = `${d.verb}; your team runs the ${d.tail} in ${d.tool} as well.`;
        assert(v(split) === '', `${d.key}/B'': the posting's name in the clause that addresses the target only is free (${split}; got ${v(split)})`);
        // D: without the posting every form is rejected again.
        assert(NAMES.test(verdict(`The ${d.stem} in ${d.tool} for your team.`, [d.quote], [], { targetCompany: d.company })), `${d.key}/D: no posting, no freedom`);
      }
      // "US" in capitals is a country, not a first-person word.
      const country = postingFreeClauses('The scorecards serve the US offices of your team.', '');
      assert(country.free.length === 1 && country.free[0], 'a capitalized country abbreviation is not “us”');
      const people = postingFreeClauses('The scorecards serve us and your team.', '');
      assert(people.free.length === 1 && !people.free[0], 'lowercase “us” is first person');
    },
  },
  {
    // Round-3 blocker 2. Two names in one sentence were treated as the same name when they shared ANY token, so "of", or a
    // single initial of a dotted abbreviation, made a name its own clause's quote states look borrowed.
    name: 'Borrowed names: two names that share only a function word or an initial are different names, each accepted from the quote its own clause restates, and a lone borrowed name is still rejected (A/B/C, three domains)',
    run() {
      const cases = [
        { key: 'education',
          own: 'Earned a history degree from the University of Leeds.', second: 'Advised the Department of Education on school policy for rural districts.',
          wrong: 'Advised the county school board on school policy for rural districts.',
          text: 'I earned a history degree from the University of Leeds and advised the Department of Education on school policy for rural districts.',
          borrowed: 'I advised the Department of Education on school policy for rural districts at the University of Leeds.', borrowedName: 'University of Leeds',
          borrowedQuotes: ['Advised the Department of Education on school policy for rural districts.', 'Earned a history degree from the University of Leeds.'] },
        { key: 'audit',
          own: 'Audited payroll ledgers for U.S. clients each quarter.', second: 'Trained audit staff for U.K. regulators on ledger sampling.',
          wrong: 'Trained audit staff for state regulators on ledger sampling.',
          text: 'I audited payroll ledgers for U.S. clients each quarter and trained audit staff for U.K. regulators on ledger sampling.',
          borrowed: 'I trained audit staff on sampling methods for U.S. regulators.', borrowedName: 'U.S',
          borrowedQuotes: ['Trained audit staff on sampling methods for state regulators.', 'Audited payroll ledgers for U.S. clients each quarter.'] },
        { key: 'nursing',
          own: 'Precepted R.N. staff on the cardiac unit night shift.', second: 'Tutored B.S.N. students in pharmacology at the county college.',
          wrong: 'Tutored nursing students in pharmacology at the county college.',
          text: 'I precepted R.N. staff on the cardiac unit night shift and tutored B.S.N. students in pharmacology at the county college.',
          borrowed: 'I tutored nursing students in pharmacology at the county college for the B.S.N. program.', borrowedName: 'B.S.N',
          borrowedQuotes: ['Tutored nursing students in pharmacology at the county college.', 'Precepted B.S.N. students on the cardiac unit night shift.'] },
      ];
      for (const entry of cases) {
        const a = verdict(entry.text, [entry.own]);
        assert(a !== '' && /names “/u.test(a), `${entry.key}/A: rejected while only one of the two names is stated (got ${a || 'acceptance'})`);
        const b = verdict(entry.text, [entry.own, entry.second]);
        assert(b === '', `${entry.key}/B: each name stated verbatim by the quote its own clause restates is accepted (got ${b})`);
        assert(verdict(entry.text, [entry.second, entry.own]) === '', `${entry.key}/B: citation order changes nothing`);
        const c = verdict(entry.text, [entry.own, entry.wrong]);
        assert(c !== '' && /names “/u.test(c), `${entry.key}/C: a second quote about the same work that does not state the name supports nothing (got ${c || 'acceptance'})`);
        // A name stated only by a quote about other work is still borrowed.
        const borrowed = verdict(entry.borrowed, entry.borrowedQuotes);
        assert(BORROWED.test(borrowed) && borrowed.includes(`names “${entry.borrowedName}”`), `${entry.key}: a lone borrowed name is still rejected and named (got ${borrowed || 'acceptance'})`);
        assert(verdict(entry.text, [entry.own, entry.second]) === '', `${entry.key}/D: accepted again`);
      }
      // A short name written inside a longer one is the same name: the scope that leaves "IT" ungrounded leaves "IT Service Desk" ungrounded.
      const desk = verdict('I ran the IT Service Desk for the county offices and rebuilt the badge request form.', ['Ran the Service Desk for the county offices.', 'Rebuilt the IT badge request form for county staff.']);
      assert(desk !== '', `a short name inside a longer one still counts as that name (got ${desk || 'acceptance'})`);
    },
  },
  {
    // Round-3 blocker 3. A coordinated list of names ("Epic and Pyxis") was one claim, so a member borrowed from a quote about
    // other work was reported as the whole list with no quote named, and the writer could not tell which member to move.
    name: 'Borrowed names: a coordinated list of names is judged member by member, and a borrowed member is named with the quote that states it (A/B/C, three domains)',
    run() {
      const cases = [
        { key: 'nursing', member: 'Pyxis', kept: 'Epic',
          own: 'Charted medication passes in Epic on the cardiac unit.', other: 'Restocked the Pyxis cabinets for the surgical ward.',
          same: 'Charted medication passes in Epic and pulled doses from Pyxis on the cardiac unit.',
          text: 'I charted medication passes in Epic and Pyxis on the cardiac unit.' },
        { key: 'analytics', member: 'Python', kept: 'Tableau',
          own: 'Built weekly sales dashboards by store with SQL queries and Tableau.', other: 'Taught a Python workshop for the finance interns.',
          same: 'Built weekly sales dashboards by store with SQL queries, Tableau and Python.',
          text: 'I built weekly sales dashboards by store with SQL, Tableau and Python.' },
        { key: 'retail', member: 'Square', kept: 'Shopify',
          own: 'Ran the online storefront orders in Shopify for the gift shop.', other: 'Reconciled Square card terminal deposits for the cafe.',
          same: 'Ran the online storefront orders in Shopify and Square for the gift shop.',
          text: 'I ran the online storefront orders in Shopify and Square for the gift shop.' },
      ];
      for (const entry of cases) {
        const where = `${entry.key}: ${entry.text}`;
        const a = verdict(entry.text, [entry.own]);
        assert(a.includes(`names “${entry.member}”`) && !a.includes(`“${entry.kept} and`), `A: the unstated member is named on its own (${where}; got ${a || 'acceptance'})`);
        const c = verdict(entry.text, [entry.own, entry.other]);
        assert(BORROWED.test(c), `C: a member only a quote about other work states is borrowed (${where}; got ${c || 'acceptance'})`);
        assert(c.includes(`names “${entry.member}”`) && !c.includes(`names “${entry.kept}`) && !/ and Pyxis”| and Python”| and Square”/u.test(c),
          `C: the message names the borrowed member, not the list and not the member its own quote states (${where}; got ${c})`);
        assert(c.includes(entry.other.split(' ').slice(0, 3).join(' ')), `C: the message names the quote that states it (${where})`);
        assert(/Say it in a sentence about the work that states it, or leave it out of this one/u.test(c), `C: the message names the repair (${where})`);
        const b = verdict(entry.text, [entry.own, entry.same]);
        assert(b === '', `B: a quote about the same work that states every member admits the list (${where}; got ${b})`);
        assert(BORROWED.test(verdict(entry.text, [entry.other, entry.own])), `D: rejected again, in either citation order (${where})`);
      }
      // "of" joins the words of one name: it is not a list.
      const one = __poolingAnalysisForTests('I advised the Department of Education on school policy.', ['Advised the Department of Education on school policy.', 'Balanced the supply budget.'].map(catalog));
      assert(one.entries.filter(entry => entry.kind === 'name').every(entry => entry.term !== 'Department' && entry.term !== 'Education'), `a name joined by “of” is one name (${JSON.stringify(one.entries.map(entry => entry.term))})`);
    },
  },
  {
    name: 'Locality: the target-address test reads the second person, the employer\'s name and this role, and nothing else (unit)',
    run() {
      for (const text of ['The pipelines suit your warehouse.', 'You will find the load nightly.', 'This role needs the same load.', 'The load fits this team.', 'It is the work this position asks for.']) {
        assert(sentenceAddressesTarget(text, ''), `addresses the target: ${text}`);
      }
      for (const text of ['The pipelines load nightly.', 'Youth programs ran nightly.', 'A team of nine ran the load.', 'Roles change.']) {
        assert(!sentenceAddressesTarget(text, ''), `addresses nobody: ${text}`);
      }
      assert(sentenceAddressesTarget('The load runs at Lumen Clinical Analytics.', 'Lumen Clinical Analytics Inc.') && !sentenceAddressesTarget('The load runs at Lumen.', 'Lumen Clinical Analytics'), 'the employer\'s whole name, without its legal suffix, addresses the target');
      assert(sentences('The load runs at Lumen Clinical Analytics.').length === 1, 'the fixtures are single sentences');
    },
  },
  {
    // Round-11 blocker 1. A capital "I" after a capitalized word ("Level I", "Title I", "Algebra I", "Phase I") was read as the
    // pronoun, so a target-facing clause that names the program its quote names lost the posting's freedom. The numeral reading
    // is granted only to a bigram a cited quote or the posting writes word for word, never to a capitalized word by itself.
    name: 'Roman numeral: a "<Name> I" the cited quote or the posting writes is a numeral, not the candidate, and a capitalized word alone never makes "I" one (A/B/C, three domains)',
    run() {
      const NAMES = /names “/u;
      const domains = [
        { key: 'ward nursing', company: 'Harbor Point Health', tool: 'Cerner', name: 'Level',
          quote: n => `Ran triage on the ${n} trauma unit and kept handoffs clean across every night shift.`,
          spelled: 'Ran triage on the level one trauma unit and kept handoffs clean across every night shift.',
          posting: tool => `ER Nurse, Harbor Point Health. Your team charts in ${tool}.`,
          text: n => `Triage on the ${n} trauma unit keeps handoffs clean across every night shift, the same handoffs your team charts in Cerner.` },
        { key: 'literacy coaching', company: 'Brightpath Schools', tool: 'Panorama', name: 'Title',
          quote: n => `Led reading intervention at the ${n} elementary school and lifted reading scores for struggling readers.`,
          spelled: 'Led reading intervention at the title one elementary school and lifted reading scores for struggling readers.',
          posting: tool => `Literacy Coach, Brightpath Schools. Your coaches track progress in ${tool}.`,
          text: n => `Reading intervention at the ${n} elementary school lifts reading scores for struggling readers, work your coaches track in Panorama.` },
        { key: 'clinical trials', company: 'Corvid Bio', tool: 'Medidata', name: 'Phase',
          quote: n => `Handled monitoring for the ${n} oncology trial across every patient site visit.`,
          spelled: 'Handled monitoring for the phase one oncology trial across every patient site visit.',
          posting: tool => `Clinical Research Associate, Corvid Bio. Your associates run monitoring in ${tool}.`,
          text: n => `Monitoring for the ${n} oncology trial spans every patient site visit, the monitoring your associates run in Medidata.` },
      ];
      for (const d of domains) {
        const numeral = `${d.name} I`;
        const v = (text, quote, posting = d.posting(d.tool)) => verdict(text, [quote], [], { postingText: posting, targetCompany: d.company });
        // B: the numeral the quote writes leaves the target clause free, exactly as its "II" control is.
        assert(v(d.text(numeral), d.quote(numeral)) === '', `${d.key}/B: "${numeral}" written by the quote is a numeral (got ${v(d.text(numeral), d.quote(numeral))})`);
        assert(v(d.text(`${d.name} II`), d.quote(`${d.name} II`)) === '', `${d.key}/control: the "II" form is accepted the same way`);
        // A: the quote spells it another way and the posting does not write it: the "I" reads as the candidate, so the posting's name is not free.
        const a = v(d.text(numeral), d.spelled);
        assert(NAMES.test(a) && a.includes(`“${d.tool}”`), `${d.key}/A: a bigram no reference text writes stays first person (got ${a || 'acceptance'})`);
        // B': the posting writing the bigram is a reference too.
        const fromPosting = v(d.text(numeral), d.spelled, `${d.posting(d.tool)} The ${numeral} program is ours.`);
        assert(fromPosting === '', `${d.key}/B': the posting writing "${numeral}" makes it a numeral (got ${fromPosting})`);
        // C: the posting names another tool: rejected as before, the numeral changes nothing else.
        assert(NAMES.test(v(d.text(numeral), d.quote(numeral), d.posting('Looker'))), `${d.key}/C: the target clause still needs the posting to name the tool`);
      }
      // "<Place> I <verb>" is the candidate speaking: a capitalized word alone never makes "I" a numeral.
      const teacher = { postingText: 'Instructional Coach, Brightpath Schools. Coaches support teachers using Desmos and Tableau across five campuses.', targetCompany: 'Brightpath Schools' };
      const taught = ['Taught Algebra I and Geometry to 150 students a year at Cedar Ridge High School.'];
      for (const text of [
        'At Cedar Ridge I taught Algebra I to 150 students a year in Tableau for your team.',
        'At Cedar Ridge I keep Algebra I scores for 150 students a year in Tableau for your team.',
        'In Algebra I I track scores for 150 students a year in Desmos for your team.',
      ]) {
        const got = verdict(text, taught, [], teacher);
        assert(NAMES.test(got), `a real first-person "I" after a capitalized word keeps the posting's name a claim (${text}; got ${got || 'acceptance'})`);
      }
      // The same words with the numeral the quote writes and no pronoun are free.
      assert(verdict('Algebra I scores for 150 students a year sit in Desmos for your team at Cedar Ridge High School.', taught, [], teacher) === '', 'the quoted "Algebra I" alone is a numeral');
      const grant = postingFreeClauses('Algebra I scores sit in Desmos for your team.', '', null, ['Taught Algebra I and Geometry.']);
      const pronoun = postingFreeClauses('Algebra I scores sit in Desmos for your team.', '', null, ['Taught algebra and geometry.']);
      assert(grant.free[0] && !pronoun.free[0], 'postingFreeClauses: the numeral reading follows the reference texts only');
    },
  },
  {
    // Round-11 miss. A clause that speaks as the candidate in the present tense ("My <work> runs on <tool>") is a claim about
    // the candidate's own work, but it was read by no candidate reading when a target-facing tail kept it from counting as a
    // restatement: the tool was accepted with no quote and no posting. Such a clause is now held to the career readings when it
    // writes a name, count, figure or qualifier, and a target clause beside it keeps the posting's freedom.
    name: 'First-person claims: a present-tense "my"/"I" clause that names a tool, count or qualifier is grounded like a career sentence whatever its tail, and an impersonal target clause beside it stays free (A/B/C, three domains)',
    run() {
      const NAMES = /names “/u;
      const domains = [
        { key: 'platform', company: 'Orbit Systems', tool: 'Datadog', own: 'Terraform', count: '40 services',
          quote: 'Wrote Terraform modules for the staging environment used by the payments team.',
          stated: tool => `Wrote Terraform modules for the staging environment used by the payments team and monitored in ${tool}.`,
          counted: 'Wrote Terraform modules for the staging environment used by the payments team across 40 services.',
          posting: 'Platform Engineer, Orbit Systems. Our platform team runs Kubernetes on AWS with Terraform and Datadog.',
          claim: tool => `My Terraform modules for the staging environment run on ${tool}, the way your team works.`,
          countClaim: 'My Terraform modules for the staging environment serve 40 services.',
          split: 'My Terraform modules for the staging environment serve the payments team; your team runs Datadog.' },
        { key: 'logistics', company: 'Redline Distribution', tool: 'Tableau', own: 'Power BI', count: 'nine regional offices',
          quote: 'Built weekly carrier scorecards in Power BI for three regional offices at Northgate Freight.',
          stated: tool => `Built weekly carrier scorecards in Power BI and ${tool} for three regional offices at Northgate Freight.`,
          counted: 'Built weekly carrier scorecards in Power BI for nine regional offices at Northgate Freight.',
          posting: 'Transportation Analyst, Redline Distribution. Our analysts build carrier scorecards in Tableau.',
          claim: tool => `My weekly scorecards still live in ${tool}, which is how your analysts work.`,
          countClaim: 'My weekly carrier scorecards now cover nine regional offices.',
          split: 'My weekly carrier scorecards live in Power BI; your analysts build the same carrier scorecards in Tableau.' },
        { key: 'nonprofit', company: 'Community Housing Trust', tool: 'Airtable', own: 'Excel', count: 'eleven grant budgets',
          quote: 'Kept a shared Excel workbook of grant budgets and spending reports for each funder.',
          stated: tool => `Kept a shared Excel workbook of grant budgets and spending reports for each funder, mirrored in ${tool}.`,
          counted: 'Kept a shared Excel workbook of eleven grant budgets and spending reports for each funder.',
          posting: 'Grants Finance Analyst, Community Housing Trust. Program managers submit receipts in Airtable.',
          claim: tool => `Our grant budgets and spending reports sit in ${tool}, much like the way your program managers work.`,
          countClaim: 'My Excel workbook holds eleven grant budgets.',
          split: 'My Excel workbook keeps spending reports for each funder; your program managers file the same spending reports in Airtable.' },
      ];
      for (const d of domains) {
        const withPosting = { postingText: d.posting, targetCompany: d.company };
        const noPosting = { targetCompany: d.company };
        // A: the tool no quote states is rejected, with and without the posting naming it.
        for (const options of [noPosting, withPosting]) {
          const got = verdict(d.claim(d.tool), [d.quote], [], options);
          assert(NAMES.test(got) && got.includes(`“${d.tool}”`), `${d.key}/A: the first-person clause's tool is a claim (${d.claim(d.tool)}; got ${got || 'acceptance'})`);
        }
        // B: a quote about the same work that states it admits it.
        assert(verdict(d.claim(d.tool), [d.stated(d.tool)], [], withPosting) === '', `${d.key}/B: accepted once the quote states the tool (got ${verdict(d.claim(d.tool), [d.stated(d.tool)], [], withPosting)})`);
        // C: the quote names another tool: rejected again.
        assert(NAMES.test(verdict(d.claim(d.tool), [d.stated('Looker')], [], withPosting)), `${d.key}/C: a quote naming another tool supports nothing`);
        // A count in the same kind of clause.
        assert(/states the count/u.test(verdict(d.countClaim, [d.quote], [], withPosting)), `${d.key}: a first-person count no quote states is rejected (${d.countClaim})`);
        assert(verdict(d.countClaim, [d.counted], [], withPosting) === '', `${d.key}: and accepted from the quote that states it (got ${verdict(d.countClaim, [d.counted], [], withPosting)})`);
        // The impersonal target clause beside a grounded first-person clause keeps the posting's name, and only with the posting.
        assert(verdict(d.split, [d.quote], [], withPosting) === '', `${d.key}: an impersonal target clause stays free (${d.split}; got ${verdict(d.split, [d.quote], [], withPosting)})`);
        assert(NAMES.test(verdict(d.split, [d.quote], [], noPosting)), `${d.key}: and is a claim again without the posting`);
      }
      // What the clause does not claim stays outside: an intent with no possessive, and a count written as the reader's.
      const quote = ['Compared on-time delivery rates for twelve carriers over six months for the weekly rotation.'];
      const lead = 'I compared on-time delivery rates for twelve carriers over six months.';
      assert(verdict(`${lead} I would run that comparison across your four distribution centers.`, quote) === '', 'an intent clause about the reader\'s sites is not a candidate claim');
      // AMENDMENT-2 item 12 keeps first-person possessive counts grounded in every tense.
      const possessiveCount = `${lead} My carrier comparison would serve your four distribution centers.`;
      assert(/states the count “four”/u.test(verdict(possessiveCount, quote)), 'a non-intent first-person clause cannot free a target-owned count');
      const countedQuote = ['Compared on-time delivery rates for twelve carriers over six months for the weekly rotation across four distribution centers.'];
      assert(verdict(possessiveCount, countedQuote) === '', 'the same count is accepted when its bound career quote states it for the same sites');
      assert(/states the count “four”/u.test(verdict(`${lead} My carrier comparison would serve my four distribution centers.`, quote)), 'the same count written as the candidate\'s is a claim');
      assert(/states the count “four”/u.test(verdict(`${lead} I ranked carriers across your four distribution centers.`, quote)), 'and past work at the reader\'s sites is a claim');
      assert(NAMES.test(verdict(`${lead} I look forward to bringing my Kubernetes skills to your team.`, quote)), 'a possessive skill claim in an intent sentence is still a claim');
    },
  },
  {
    // Round-11 word-form gap. "cut" in the letter was not stated by "cutting" in the quote, though "cut(s)" was accepted: the
    // outcome-verb rows now read the regular inflections of the word the claim wrote. A compound modifier ("cutting-edge") and a
    // row whose -ing form is a different sense ("saving parsed work") stay outside.
    name: 'Word forms: an outcome verb in the letter is stated by the same verb in another regular inflection in the quote, never by a hyphenated compound or a row that excludes the form (A/B/C, three domains)',
    run() {
      const QUALIFIER = /unsupported (?:reduction|increase) outcome/u;
      const cases = [
        { key: 'logistics', text: 'I negotiated freight rates with 14 carriers and cut annual spend.',
          none: 'Negotiated freight rates with 14 carriers to manage annual spend.', inflected: 'Negotiated freight rates with 14 carriers, cutting annual spend.',
          compound: 'Negotiated freight rates with 14 carriers using cutting-edge tools for annual spend.' },
        { key: 'ward nursing', text: 'I ran hourly rounding on the cardiac unit and cut patient falls.',
          none: 'Ran hourly rounding on the cardiac unit to watch patient falls.', inflected: 'Ran hourly rounding on the cardiac unit, cutting patient falls.',
          compound: 'Ran hourly rounding on the cardiac unit with cutting-edge alarms for patient falls.' },
        { key: 'teaching', text: 'I ran the peer-tutoring program and raised algebra pass rates.',
          none: 'Ran the peer-tutoring program to track algebra pass rates.', inflected: 'Ran the peer-tutoring program, raising algebra pass rates.',
          compound: 'Ran the peer-tutoring program with raising-hand drills for algebra pass rates.' },
      ];
      for (const entry of cases) {
        assert(QUALIFIER.test(verdict(entry.text, [entry.none])), `${entry.key}/A: no form of the verb in the quote is rejected`);
        assert(verdict(entry.text, [entry.inflected]) === '', `${entry.key}/B: the -ing form in the quote states it (got ${verdict(entry.text, [entry.inflected])})`);
        assert(QUALIFIER.test(verdict(entry.text, [entry.compound])), `${entry.key}/C: a hyphenated compound is another word`);
        assert(QUALIFIER.test(verdict(entry.text, [entry.none])), `${entry.key}/D: rejected again`);
      }
      // The same through the résumé reading, and the rows that list their forms on purpose stay as they are.
      const bullet = (text, quote) => {
        try { assertSourceQuoteLinksFinalText(text, [quote], 'resumeBullets', 0, { identityTokens: [] }); return ''; } catch (error) { return String(error?.message || error); }
      };
      assert(bullet('Cut detention fees for the receiving dock.', 'Reviewed the receiving dock and kept cutting detention fees.') === '', 'a bullet reads the same inflection');
      assert(/unsupported savings outcome/u.test(bullet('Saved the reporting team hours of manual database work.', 'Wrote the reporting job that keeps saving parsed database work to disk for the team.')),
        'the savings row still excludes "saving"');
    },
  },
  {
    // Round-11 blocker 4. A restatement followed by ", which is the work your coaches do." was rejected as an appended clause,
    // while the same words were accepted as their own sentence. A trailing relative or semicolon clause that only addresses the
    // target is now read the way that sentence is; one that reports work, speaks as the candidate, or writes a claim is not.
    name: 'Trailing target clause: a relative or semicolon clause that only addresses the target owes the quotes no shared term, and one that adds work, a name, a count, a qualifier or the candidate is still appended work (A/B/C, three domains)',
    run() {
      const APPENDED = /adds the clause/u;
      const domains = [
        { key: 'teaching', company: 'Brightpath Schools', quote: 'Mentored three first-year teachers in the math department on lesson planning.',
          base: 'I mentored three first-year teachers in the math department on lesson planning', target: 'which is the coaching work this role centers on', alone: 'That is the coaching work this role centers on.' },
        { key: 'ward nursing', company: 'Harbor Point Health', quote: 'Precepted eight new graduate nurses on the cardiac step-down unit.',
          base: 'I precepted eight new graduate nurses on the cardiac step-down unit', target: 'which is the support your new hires need', alone: 'That is the support your new hires need.' },
        { key: 'accounting', company: 'Quill Financial', quote: 'Trained two junior accountants on accounts payable workflows.',
          base: 'I trained two junior accountants on accounts payable workflows', target: 'where your close calendar would see the same care', alone: 'Your close calendar would see the same care.' },
      ];
      const added = [
        ['which kept your coaches on schedule', 'past work'],
        ['which is how I also ran payroll for your team', 'the candidate'],
        ['handling your payroll audits', 'a participle'],
        ['allowing your team to plan ahead', 'a consequence'],
        ['which your coaches track in Panorama', 'a name'],
        ['which matches what your five campuses need', 'a count'],
        ['which is the work your coaches do daily', 'a qualifier'],
      ];
      for (const d of domains) {
        const options = { targetCompany: d.company };
        const sentence = `${d.base}, ${d.target}.`;
        // B: the trailing target clause is read like the standalone target sentence.
        assert(verdict(sentence, [d.quote], [], options) === '', `${d.key}/B: ${sentence} (got ${verdict(sentence, [d.quote], [], options)})`);
        assert(verdict(`${d.base}. ${d.alone}`, [d.quote], [], options) === '', `${d.key}/B: the same words as their own sentence`);
        assert(verdict(`${d.base}; your team ${d.key === 'accounting' ? 'closes the same way' : 'works the same way'}.`, [d.quote], [], options) === '', `${d.key}/B: a semicolon target clause too`);
        // A/C: every way a trailing clause adds work stays rejected.
        for (const [tail, why] of added) {
          const got = verdict(`${d.base}, ${tail}.`, [d.quote], [], options);
          assert(got !== '' && (APPENDED.test(got) || /names “|states the count|unsupported/u.test(got)), `${d.key}/C: a trailing clause with ${why} is appended work (${tail}; got ${got || 'acceptance'})`);
        }
        // D: the restatement on its own is accepted, so the tail alone decides.
        assert(verdict(`${d.base}.`, [d.quote], [], options) === '', `${d.key}/D: the restatement alone is accepted`);
      }
    },
  },

];
