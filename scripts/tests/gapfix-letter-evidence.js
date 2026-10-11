// Regression tests for the cover-letter evidence gates that were fixed for the
// adaptability gaps in metrics, dates, listing and ownership:
//
//   * the letter figure gate (checkFigureDiscipline) sees multipliers, spelled
//     numbers of any size, magnitude words and "percent", and compares by
//     value, never by spelling
//   * the experience-span gate (findUnsupportedDurationClaim) reads decades,
//     compound and spelled numbers, "-plus", "for N years" and "since YEAR",
//     treats "more than N" as strictly more, and does not let a number of years
//     a quote gives to something else (a backlog's age) stand for the candidate's
//     tenure
//   * the ended-role gate and the tenure engine read dates with ONE parser
//     (year-only ends included)
//   * a fit-assessment years requirement is held to the whole dated career when
//     its category names no usable role
//
// Every fixture is synthetic text in unrelated fields. The only thing a test
// hand-writes is SOURCE text; every verdict comes from the production function.
// Each rejection is paired with its faithful twin (the identical claim, admitted
// once the source states it) and with the removal of that statement (rejected
// again), so a gate that merely rejects more cannot pass.
import { assert } from './testHelpers.js';
import { checkEndedRoleCurrentEmployment, checkFigureDiscipline, findUnsupportedDurationClaim } from '../../electron/ipc/coverLetterChecks.js';
import { calculateDatedTenure, parseCareerDate, splitCareerDateRange, validateAndNormalizeFitAssessment } from '../../electron/ipc/jobFitAssessment.js';

const DOMAINS = [
  { key: 'nurse', role: 'Charge Nurse', employer: 'Alderbrook Community Hospital', field: 'clinical nursing', work: 'Kept medication barcode scan compliance on the emergency ward', other: 'Trained new staff on the discharge checklist' },
  { key: 'pastry', role: 'Pastry Chef', employer: 'Maison Verdelle Patisserie', field: 'professional pastry', work: 'Held pastry ingredient spend per order cycle for the patisserie', other: 'Rewrote the lamination schedule for the morning bake' },
  { key: 'engineer', role: 'Structural Engineer', employer: 'Tessellate Structural Partners', field: 'structural design', work: 'Delivered the footbridge retrofit design for the county', other: 'Reviewed connection details for the culvert replacement' },
  { key: 'analyst', role: 'Data Analyst', employer: 'Northfield Analytics Cooperative', field: 'analytics', work: 'Ran the sales dashboard refresh jobs for the analytics team', other: 'Documented the quarterly forecasting method' },
  { key: 'warehouse', role: 'Warehouse Supervisor', employer: 'Quayside Distribution', field: 'warehouse operations', work: 'Scheduled the dock appointments for the inbound lanes', other: 'Retrained the night shift on pallet labeling' },
];

const lowerFirst = value => `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
const letterAbout = sentence => [`In my last role I ${lowerFirst(sentence)}`];
const figureVerdict = (letter, evidenceLines, plan = null) => checkFigureDiscipline(letter, { bulletTexts: evidenceLines }, plan);
const sentenceWith = (domain, form) => `${domain.work} at ${form}.`;

// ---------------------------------------------------------------------------
// Letter figures
// ---------------------------------------------------------------------------
// Spellings of ONE quantity: each must be admitted from evidence that states any other.
const EQUIVALENT_FIGURES = [
  ['97%', '97 percent', '97 per cent', 'ninety-seven percent'],
  ['30x', '30X', '30 times', 'thirty times', 'thirty-fold'],
  ['$2.4M', '$2.4 million', '$2,400,000', '2.4 million dollars'],
  ['2 million', '2,000,000', 'two million', '2M'],
  ['3 years', 'three years', '3-year', 'three-year', '3 yrs', '3+ years'],
  ['250', 'two hundred and fifty'],
];
// Different quantities: [what the evidence states, what the letter says instead].
const DIFFERENT_FIGURES = [
  ['97%', '97'], ['97%', '9.7%'], ['97%', '970%'], ['97%', '97 percentage points'],
  ['30x', '3x'], ['30x', '30%'], ['30x', '30'],
  ['2 million', '2 thousand'], ['2 million', '2'], ['2 thousand', '2 million'],
  ['$2.4M', '$2.4K'], ['$2.4M', '$24M'], ['$2.4M', '2.4 million'],
  ['3 years', '3 months'], ['3 years', '3'], ['3 years', '30 years'],
];

export default [
  {
    name: 'Gap fix (letter figures): every spelling of one quantity is admitted from the evidence that states any spelling, in every field',
    run() {
      let pairs = 0;
      for (const domain of DOMAINS) {
        for (const group of EQUIVALENT_FIGURES) {
          for (const stated of group) {
            for (const claimed of group) {
              const verdict = figureVerdict(letterAbout(sentenceWith(domain, claimed)), [sentenceWith(domain, stated)]);
              assert(verdict.passed, `${domain.key}: "${claimed}" restates evidence "${stated}" but was refused: ${verdict.detail}`);
              pairs += 1;
            }
          }
        }
      }
      assert(pairs > 300, `the equivalence matrix covered many pairs (${pairs})`);
    },
  },
  {
    name: 'Gap fix (letter figures): a different quantity is refused whatever it looks like, in every field',
    run() {
      for (const domain of DOMAINS) {
        for (const [stated, claimed] of DIFFERENT_FIGURES) {
          const verdict = figureVerdict(letterAbout(sentenceWith(domain, claimed)), [sentenceWith(domain, stated)]);
          assert(!verdict.passed && /absent from résumé evidence/u.test(verdict.detail), `${domain.key}: "${claimed}" is not the quantity "${stated}" the evidence states, got ${verdict.detail}`);
        }
      }
    },
  },
  {
    name: 'Gap fix (letter figures): an invented multiplier, spelled percentage or magnitude is refused, admitted once the source states it, refused again once the statement is removed',
    run() {
      const scenarios = [
        { claimed: 'at thirty-fold speed', stated: 'at 30 times speed', why: 'multiplier' },
        { claimed: 'by forty percent', stated: 'by 40%', why: 'spelled percentage above twenty' },
        { claimed: 'for two million records', stated: 'for 2,000,000 records', why: 'magnitude word' },
        { claimed: 'across ninety-five offices', stated: 'across 95 percent of offices', why: 'kind change is not a restatement' },
      ];
      for (const domain of DOMAINS) {
        const base = `${domain.work}.`;
        for (const scenario of scenarios.slice(0, 3)) {
          const letter = letterAbout(`${domain.work} ${scenario.claimed}.`);
          const supporting = `${domain.other} ${scenario.stated}.`;
          const a = figureVerdict(letter, [base]);
          assert(!a.passed && /absent from résumé evidence/u.test(a.detail), `${domain.key} A: a ${scenario.why} no bullet states is refused, got ${a.detail}`);
          const b = figureVerdict(letter, [base, supporting]);
          assert(b.passed, `${domain.key} B: the same ${scenario.why} passes once a bullet states it: ${b.detail}`);
          const c = figureVerdict(letter, [base]);
          assert(!c.passed, `${domain.key} C: removing the supporting bullet refuses it again`);
          // The figure must come from the evidence the plan selected, not from any bullet that states a number.
          const unanchored = figureVerdict(letter, [base, supporting], { mappings: [{ evidence: base }] });
          assert(!unanchored.passed, `${domain.key}: a ${scenario.why} stated only in an unselected bullet is refused under a plan`);
          const anchored = figureVerdict(letter, [base, supporting], { mappings: [{ evidence: supporting }] });
          assert(anchored.passed, `${domain.key}: and passes under the plan that selected the bullet stating it`);
        }
        const kind = scenarios[3];
        const mismatch = figureVerdict(letterAbout(`${domain.work} ${kind.claimed}.`), [base, `${domain.other} ${kind.stated}.`]);
        assert(!mismatch.passed, `${domain.key}: "95 percent of offices" evidence does not state "ninety-five offices" (${kind.why})`);
      }
    },
  },
  {
    name: 'Gap fix (letter figures): ordinary prose is not a figure, and a repeated quantity is still counted against the budget',
    run() {
      const quiet = [
        'One of the team lead the review.',
        'I worked with someone who handled the handoff.',
        'Thousands of records were audited by the group.',
        'I kept the one clinic open on weekends.',
        'I closed the books on the thirty-first of March.',
        'She was one of twelve applicants, and two of them were from the same site.',
      ];
      for (const sentence of quiet) {
        const verdict = figureVerdict([sentence], []);
        assert(verdict.passed && /^0 figure/u.test(verdict.detail), `"${sentence}" carries no figure, got ${verdict.detail}`);
      }
      // A spelled count too large for any idiom is a figure even without a unit; the digit twin states the same quantity.
      const trained = figureVerdict(['I trained forty nurses on the checklist.'], ['Trained 40 nurses on the discharge checklist.']);
      const untrained = figureVerdict(['I trained forty nurses on the checklist.'], ['Trained nurses on the discharge checklist.']);
      const different = figureVerdict(['I trained fifty nurses on the checklist.'], ['Trained 40 nurses on the discharge checklist.']);
      assert(trained.passed && !untrained.passed && !different.passed && /“forty”/u.test(untrained.detail),
        `a spelled count above twenty is held to the evidence like its digit twin, got ${trained.detail} | ${untrained.detail} | ${different.detail}`);
      const repeated = figureVerdict(['At 2 million, then two million, then 2,000,000, then 2M.'], ['Handled 2 million records.']);
      assert(!repeated.passed && /maximum is 3/u.test(repeated.detail) && !/absent from résumé evidence/u.test(repeated.detail),
        `four spellings of one supported quantity exceed the budget by count alone, got ${repeated.detail}`);
    },
  },

  // -------------------------------------------------------------------------
  // Experience spans
  // -------------------------------------------------------------------------
  {
    name: 'Gap fix (experience spans): decades, compound and spelled numbers, "-plus", "for N years" and "since YEAR" are claims that need a cited quote, and the quote that states them admits them',
    run() {
      const shapes = [
        { claim: 'a decade of experience', support: field => `Ten years of ${field} experience` },
        { claim: 'over a decade of experience', support: field => `Eleven years of ${field} experience` },
        { claim: 'two decades of experience', support: field => `Twenty years of ${field} experience` },
        { claim: 'decades of experience', support: field => `Thirty years of ${field} experience` },
        { claim: 'seven-plus years of experience', support: field => `Nine years of ${field} experience` },
        { claim: 'thirty years of experience', support: field => `30 years of ${field} experience` },
        { claim: 'twenty-five years of experience', support: field => `25+ years of ${field} experience` },
        { claim: 'a decade-plus of experience', support: field => `Eleven years in ${field}, with experience across three sites` },
        { claim: 'working for six years', support: field => `Worked in ${field} for six years` },
        { claim: 'working for over a decade', support: field => `Spent twelve years in ${field}` },
        { claim: 'leading the work since 2014', support: () => 'Joined the unit in March 2014' },
        { claim: 'leading the work since March 2014', support: () => 'Started as a trainee, 03/2014 - 02/2016, then promoted (2014)' },
      ];
      for (const domain of DOMAINS) {
        const base = [`${domain.role} at ${domain.employer}`, 'March 2018 - Present', `${domain.work}.`];
        for (const { claim, support } of shapes) {
          const text = `I bring ${claim} to the work.`;
          const a = findUnsupportedDurationClaim(text, base);
          assert(a, `${domain.key} A: "${claim}" is a span no cited quote states and must be refused`);
          const b = findUnsupportedDurationClaim(text, [...base, support(domain.field)]);
          assert(!b, `${domain.key} B: "${claim}" is admitted once a cited quote states it (${JSON.stringify(b)})`);
          const c = findUnsupportedDurationClaim(text, base);
          assert(c, `${domain.key} C: removing the statement refuses "${claim}" again`);
        }
      }
    },
  },
  {
    name: 'Gap fix (experience spans): near misses around the stated span stay refused',
    run() {
      for (const domain of DOMAINS) {
        const quote = [`Ten years of ${domain.field} experience`];
        const refused = [
          'I bring eleven years of experience.', 'I bring nine years of experience.', 'I bring two decades of experience.',
          'I bring decades of experience.', 'I bring more than ten years of experience.', 'I bring over a decade of experience.',
          'I worked there for nine years.', 'I worked there for a decade and a half, since 2013.', 'I bring 11+ years of experience.',
        ];
        for (const text of refused) assert(findUnsupportedDurationClaim(text, quote), `${domain.key}: "${text}" is more or less than the stated ten years and must be refused`);
        const admitted = ['I bring ten years of experience.', 'I bring 10+ years of experience.', 'I bring a decade of experience.', 'I bring nearly ten years of experience.', 'I bring at least nine years of experience.', 'I bring over nine years of experience.', 'I worked there for ten years.'];
        for (const text of admitted) {
          const found = findUnsupportedDurationClaim(text, quote);
          assert(!found, `${domain.key}: "${text}" restates the stated ten years (${JSON.stringify(found)})`);
        }
      }
    },
  },
  {
    name: 'Gap fix (experience spans): "more than N years" needs a strictly longer span, while "at least N" and "N+" are met by N, and an open-ended statement supports a strict bound',
    run() {
      for (const domain of DOMAINS) {
        for (const n of [4, 7, 14]) {
          const exact = [`${n} years of ${domain.field} experience`];
          const longer = [`${n + 1} years of ${domain.field} experience`];
          const open = [`${n}+ years of ${domain.field} experience`];
          for (const bound of ['more than', 'over', 'upwards of', 'north of', 'greater than']) {
            const text = `I bring ${bound} ${n} years of experience to the work.`;
            assert(findUnsupportedDurationClaim(text, exact), `${domain.key}: "${bound} ${n}" is not supported by exactly ${n}`);
            assert(!findUnsupportedDurationClaim(text, longer), `${domain.key}: "${bound} ${n}" is supported by ${n + 1}`);
            assert(!findUnsupportedDurationClaim(text, open), `${domain.key}: "${bound} ${n}" is supported by "${n}+"`);
          }
          for (const text of [`I bring at least ${n} years of experience.`, `I bring ${n}+ years of experience.`]) {
            assert(!findUnsupportedDurationClaim(text, exact), `${domain.key}: "${text}" is met by exactly ${n}`);
            assert(findUnsupportedDurationClaim(text, [`${n - 1} years of ${domain.field} experience`]), `${domain.key}: "${text}" is not met by ${n - 1}`);
          }
        }
      }
    },
  },
  {
    name: 'Gap fix (experience spans): a number of years a quote gives to something else does not stand for the candidate\'s tenure, but a quote that presents it as the candidate\'s own time does',
    run() {
      for (const domain of DOMAINS) {
        const claims = ['I bring six years of experience to the work.', 'I bring over five years of experience to the work.', 'I bring nearly six years of experience to the work.', 'I bring 6+ years of experience to the work.'];
        const elsewhere = [
          `Cut the ${domain.field} backlog from six years of accumulated files to a same-day queue.`,
          `Cleared a six-year ${domain.field} backlog.`,
          `Retired the ${domain.field} system after six years of archived records.`,
        ];
        const ownTime = [
          `Six years of ${domain.field} experience`,
          `Has six years of ${domain.field} delivery.`,
          `Worked in ${domain.field} for six years.`,
          `${domain.field} (six years)`,
          `${domain.field}: six years`,
          `Six years as a ${domain.role}`,
          `6+ years in ${domain.field}`,
        ];
        for (const claim of claims) {
          for (const quote of elsewhere) assert(findUnsupportedDurationClaim(claim, [quote]), `${domain.key}: "${claim}" is not supported by "${quote}"`);
          for (const quote of ownTime) {
            // "over five" and "nearly six" are met by a quote stating the candidate's own six years.
            const found = findUnsupportedDurationClaim(claim, [quote]);
            assert(!found, `${domain.key}: "${claim}" is supported by "${quote}" (${JSON.stringify(found)})`);
          }
          // Both together: the backlog does not cancel the candidate's own statement.
          assert(!findUnsupportedDurationClaim(claim, [elsewhere[0], ownTime[0]]), `${domain.key}: an own-time quote still supports "${claim}" beside an unrelated one`);
        }
        // The unmarked "for N years" claim keeps its wide evidence rule: a quote stating that number admits it.
        assert(!findUnsupportedDurationClaim(`I negotiated the ${domain.field} vendor contract for three years.`, [`Negotiated a three-year ${domain.field} vendor contract.`]),
          `${domain.key}: a contract term the quote states admits the same term`);
        assert(findUnsupportedDurationClaim(`I negotiated the ${domain.field} vendor contract for three years.`, [`Negotiated a four-year ${domain.field} vendor contract.`]),
          `${domain.key}: and a different term is refused`);
      }
    },
  },
  {
    name: 'Gap fix (experience spans): shapes that assert no span of the candidate stay silent',
    run() {
      for (const domain of DOMAINS) {
        const silent = [
          `${domain.work} through the four-year platform rollout.`,
          `${domain.work} and shortened onboarding from three years to six weeks.`,
          `${domain.work} for 12 teams before the 2024 release.`,
          `${domain.work} after clearing three years of archived ticket data.`,
          `${domain.work} for six years of back records.`,
          `${domain.work} since the 2021 launch.`,
          `A decade ago this ${domain.field} unit was a single desk.`,
          `${domain.work} in the last decade.`,
          'Python 3 on 24/7 paging through 2021 and 2022.',
        ];
        for (const text of silent) {
          const found = findUnsupportedDurationClaim(text, []);
          assert(!found, `${domain.key}: "${text}" asserts no span of the candidate and must stay silent (${JSON.stringify(found)})`);
        }
      }
    },
  },

  // -------------------------------------------------------------------------
  // One date parser
  // -------------------------------------------------------------------------
  {
    name: 'Gap fix (dates): equivalent spellings of one date and one range read identically, in the tenure engine and the ended-role gate',
    run() {
      const asOf = new Date(Date.UTC(2026, 5, 15));
      const tenure = role => JSON.stringify(calculateDatedTenure([role], { asOf }));
      const sameDates = [
        [['03/2017', '3/2017', '2017-03', '2017/03', '2017-03-15', 'Mar. 2017', 'Mar 2017', 'March, 2017', 'March 15, 2017', '15 March 2017', 'march 2017'], 'March 2017'],
        [['Sept. 2016', 'Sep 2016', 'sept 2016', 'September 2016'], 'September 2016'],
        [['Ongoing', 'Current', 'Now', 'present', 'Present'], 'Present'],
      ];
      for (const [spellings, canonical] of sameDates) {
        for (const spelling of spellings) {
          const start = canonical === 'Present' ? { startDate: 'January 2020', endDate: spelling } : { startDate: spelling, endDate: 'Present' };
          const reference = canonical === 'Present' ? { startDate: 'January 2020', endDate: 'Present' } : { startDate: canonical, endDate: 'Present' };
          assert(tenure(start) === tenure(reference), `"${spelling}" must read as "${canonical}": ${tenure(start)} vs ${tenure(reference)}`);
          assert(calculateDatedTenure([start], { asOf }).roleCount === 1, `"${spelling}" is a usable date`);
        }
      }
      const ranges = ['March 2017 - Present', 'March 2017 – Present', 'March 2017 — Present', 'March 2017 to Present', 'March 2017-Present', 'Mar 2017–Present',
        '03/2017 - present', '2017-03 – Ongoing', '03/2017 – Current', 'March 2017 - Present · Remote'];
      for (const dates of ranges) {
        assert(tenure({ dates }) === tenure({ startDate: 'March 2017', endDate: 'Present' }), `the range "${dates}" reads as March 2017 to Present`);
      }
      const closed = ['March 2017 - June 2020', 'Mar 2017 – Jun 2020', '03/2017 - 06/2020', '2017-03 – 2020-06', '2017-03–2020-06', 'March 2017 to June 2020', 'March 2017-June 2020'];
      for (const dates of closed) {
        assert(tenure({ dates }) === tenure({ startDate: 'March 2017', endDate: 'June 2020' }), `the range "${dates}" reads as March 2017 to June 2020`);
      }
      for (const dates of ['1997 - 2003', '1997-2003', '1997–2003', '1997 to 2003']) {
        assert(tenure({ dates }) === tenure({ startDate: '1997', endDate: '2003' }) && calculateDatedTenure([{ dates }], { asOf }).roleCount === 1, `the year range "${dates}" reads as 1997 to 2003`);
      }
      for (const nonsense of ['sometime', 'Q3', '13/2017', '2017-13', 'March', '']) {
        assert(parseCareerDate(nonsense) === null, `"${nonsense}" is not a date`);
        assert(calculateDatedTenure([{ startDate: nonsense, endDate: 'Present' }], { asOf }).roleCount === 0, `a role starting "${nonsense}" has no usable period`);
      }
      assert(splitCareerDateRange('2023-07') === null && splitCareerDateRange('2023-07-15') === null, 'hyphens inside one ISO date never split a range');
      assert(JSON.stringify(parseCareerDate('2017-03-15')) === JSON.stringify(parseCareerDate('March 2017')), 'a dated day reads at month precision');

      // The ended-role gate reads the SAME spellings: every spelling of a past month ends the role, every open spelling does not.
      const reference = '2026-10-01T00:00:00.000Z';
      const frame = 'As a Planner at Harbor Works, I lead the schedule.';
      const flagged = dates => !checkEndedRoleCurrentEmployment([frame], { roles: [{ title: 'Planner', company: 'Harbor Works', dates }] }, reference).passed;
      for (const end of ['March 2020', 'Mar. 2020', '03/2020', '3/2020', '2020-03', '2020/03', '2020-03-31', 'March 31, 2020']) {
        assert(flagged(`June 2018 - ${end}`), `a role ending "${end}" ended before the reference month`);
      }
      for (const end of ['Present', 'Ongoing', 'Current', 'Now', 'October 2026', '2026-10', 'November 2026', '2027']) {
        assert(!flagged(`June 2018 - ${end}`), `a role ending "${end}" is not shown to be over before the reference month`);
      }
    },
  },
  {
    name: 'Gap fix (dates): a year-only end is over once the whole year has passed, and the verdict follows the source: ended, reopened, ended again',
    run() {
      const reference = '2026-06-15T00:00:00.000Z';
      for (const domain of DOMAINS) {
        const frame = `As a ${domain.role} at ${domain.employer}, I lead the daily work of the team.`;
        const verdict = dates => checkEndedRoleCurrentEmployment([frame], { roles: [{ title: domain.role, company: domain.employer, dates }] }, reference);
        for (const dates of ['1997 – 2003', '1997 - 2003', '1997-2003', '1997–2003', '1997 to 2003', '2015 – 2025', 'March 2015 - 2025']) {
          const a = verdict(dates);
          assert(!a.passed && /year-only|ended/u.test(a.detail), `${domain.key}: "${dates}" ended in an earlier year and is framed as current work, got ${a.detail}`);
        }
        // The reference year itself may still be running, and open ends are open.
        for (const dates of ['2019 – 2026', '2019 - 2027', '2019 – Present', '2019 - Ongoing', '2019']) {
          assert(verdict(dates).passed, `${domain.key}: "${dates}" is not shown to be over`);
        }
        // B: the source is recompiled to a Present end -> admitted. C: restored -> refused again.
        const ended = verdict('2015 – 2025');
        const reopened = verdict('2015 – Present');
        const endedAgain = verdict('2015 – 2025');
        assert(!ended.passed && reopened.passed && !endedAgain.passed, `${domain.key}: the verdict follows the stated end date`);
        // Past tense about an ended role is always fine.
        assert(checkEndedRoleCurrentEmployment([`As a ${domain.role} at ${domain.employer}, I led the daily work of the team.`], { roles: [{ title: domain.role, company: domain.employer, dates: '2015 – 2025' }] }, reference).passed,
          `${domain.key}: past tense about a year-only ended role is faithful`);
      }
    },
  },

  // -------------------------------------------------------------------------
  // Fit assessment: a years requirement whose category names no usable role
  // -------------------------------------------------------------------------
  {
    name: 'Gap fix (fit assessment): a years requirement is held to the whole dated career when its category names no usable role, and only that bound is applied',
    run() {
      const asOf = new Date(Date.UTC(2026, 5, 15));
      for (const domain of DOMAINS) {
        const shortCareer = [
          { id: 'earlier', startDate: 'January 2014', endDate: 'December 2016' },
          { id: 'current', startDate: 'March 2018', endDate: 'February 2021' },
        ];
        const longCareer = [{ id: 'founding', startDate: 'January 2000', endDate: 'December 2013' }, ...shortCareer];
        const row = (years, roleIds, candidateRoles) => {
          const quote = `${years} years of ${domain.field} experience`;
          const candidateEvidence = `${domain.work}.`;
          return validateAndNormalizeFitAssessment({
            requirements: [{ id: 'experience', requirement: quote, priority: 'critical', evidenceStatus: 'direct', jobEvidence: [quote], candidateEvidence: [candidateEvidence] }],
            experienceAssessment: { categorySpecificExperience: [{ id: 'category', category: quote, requiredMinimumYears: years, ...(roleIds ? { roleIds } : {}), jobEvidence: [quote] }] },
          }, { jobText: `The ${domain.field} posting requires ${quote}.`, candidateText: `${domain.work}.`, candidateRoles, asOf }).requirementRows[0];
        };
        for (const roleIds of [undefined, [], ['role-that-does-not-exist']]) {
          const label = JSON.stringify(roleIds ?? 'omitted');
          // A: the dated career is about six years; sixteen cannot be reached by any subset of it.
          const a = row(16, roleIds, shortCareer);
          assert(a.effectiveStatus !== 'direct' && a.datedTenure?.disposition === 'shortfall' && a.datedTenure.basis === 'all-dated-roles',
            `${domain.key} A (${label}): sixteen years above a six-year career must not stay direct, got ${JSON.stringify([a.effectiveStatus, a.datedTenure])}`);
          // B: the recompiled source states a long career; the bound no longer refutes it. It cannot confirm it either.
          const b = row(16, roleIds, longCareer);
          assert(b.effectiveStatus === 'direct' && b.datedTenure === undefined,
            `${domain.key} B (${label}): a career that could reach sixteen years leaves the model's label alone, got ${JSON.stringify([b.effectiveStatus, b.datedTenure])}`);
          // C: the long role is removed again.
          const c = row(16, roleIds, shortCareer);
          assert(c.effectiveStatus === a.effectiveStatus && c.datedTenure?.disposition === 'shortfall', `${domain.key} C (${label}): removing the role restores the shortfall`);
          // A requirement the career can reach is never demoted by the bound.
          assert(row(4, roleIds, shortCareer).effectiveStatus === 'direct', `${domain.key} (${label}): four years within a six-year career stays direct`);
          // No usable dates, no verdict.
          assert(row(16, roleIds, [{ id: 'undated' }]).effectiveStatus === 'direct', `${domain.key} (${label}): an undated record cannot refute a requirement`);
        }
        // Roles that DO exist keep the selected-role rule: a short selected role is a shortfall even when the whole career is long.
        const scoped = row(10, ['current'], longCareer);
        assert(scoped.effectiveStatus !== 'direct' && scoped.datedTenure?.basis === 'selected-roles', `${domain.key}: named roles are still measured on their own`);
      }
    },
  },
];
