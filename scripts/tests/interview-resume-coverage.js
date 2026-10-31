import { assert } from './testHelpers.js';
import { deriveInterviewResumeConsistency, resumeCoverage } from '../../electron/ipc/interviewResumeCoverage.js';

// Synthetic replay of v4's captured HTML shape: semantic paragraph separators,
// role/date headings, and quotations assembled across omitted résumé bullets.
const FIRST = 'Built a reporting dashboard in Python for internal staff.';
const SECOND = 'Maintained scheduled data integrations for the support team.';
const capturedResume = [
  'Experience', 'Software Engineer · Aster Labs', 'May 2023 – June 2026 · Remote', FIRST,
  'Created a deployment checklist for internal staff.',
  'Data Engineer · Birch Works', 'October 2021 – January 2023 · Remote', SECOND,
].join('\u2029');
const career = [
  { id: 'reporting', text: FIRST, roleContext: { title: 'Software Engineer', employer: 'Aster Labs' } },
  { id: 'integrations', text: SECOND, roleContext: { title: 'Data Engineer', employer: 'Birch Works' } },
];
const statements = [
  { text: 'I built a reporting dashboard in Python for internal staff.', evidenceIds: ['reporting'] },
  { text: 'At Birch Works, I maintained scheduled data integrations for the support team.', evidenceIds: ['integrations'] },
];

export default [
  {
    name: 'interview résumé coverage: captured role headings and nonadjacent complete excerpts preserve a genuine match',
    run: () => {
      const quote = `Software Engineer · Aster Labs May 2023 – June 2026 · Remote ${FIRST} Data Engineer · Birch Works October 2021 – January 2023 · Remote ${SECOND}`;
      assert(resumeCoverage(quote, career, capturedResume, true, statements), 'flattened role/date headings and omitted unrelated bullets must retain exact complete-sentence coverage');
      assert(!resumeCoverage(`${SECOND} ${FIRST}`, career, capturedResume, true, statements), 'quoted excerpts must retain captured résumé order');
      assert(!resumeCoverage('a reporting dashboard in Python for internal staff.', career, capturedResume, true, statements), 'an excerpt cannot start inside a captured sentence');
      assert(!resumeCoverage(quote.replace('Python', 'Java'), career, capturedResume, true, statements), 'a quote cannot invent a technology');
    },
  },
  {
    name: 'interview résumé coverage: the host recovers exact matches after a worker consistency reset',
    run: () => {
      const match = deriveInterviewResumeConsistency(statements, career, capturedResume);
      assert(match?.consistentWithResume && match.resumeQuote === `${FIRST}\u2029Data Engineer · Birch Works\u2029${SECOND}`, 'host recovery retains a captured role heading when the spoken claim names that employer');
      assert(resumeCoverage(match.resumeQuote, career, capturedResume, true, statements), 'a recovered quote passes the same sealed-bank coverage guard');
      const unknownEntity = structuredClone(statements); unknownEntity[0].text = unknownEntity[0].text.replace('Python', 'Java');
      assert(!deriveInterviewResumeConsistency(unknownEntity, career, capturedResume), 'recovery cannot manufacture a technology match');
      const unknownEmployer = structuredClone(statements); unknownEmployer[1].text = unknownEmployer[1].text.replace('Birch Works', 'Cedar Studio');
      assert(!deriveInterviewResumeConsistency(unknownEmployer, career, capturedResume), 'recovery cannot borrow an employer outside the claim citation');
    },
  },
  {
    name: 'interview résumé coverage: source role metadata cannot supply absent or contradictory résumé employment',
    run: () => {
      const evidence = [{ id: 'dashboards', text: 'Built dashboards.', roleContext: { title: 'Engineer', employer: 'Aster Labs' } }];
      const spoken = [{ text: 'I built dashboards as an Engineer at Aster Labs.', evidenceIds: ['dashboards'] }];
      for (const [text, resume] of [
        ['I built dashboards at Aster Labs.', 'Engineer at Birch Works. Built dashboards.'],
        ['I built dashboards at Aster Labs.', 'Built dashboards.'],
        ['I built dashboards as an Engineer.', 'Designer at Aster Labs. Built dashboards.'],
        ['I built dashboards as an Engineer.', 'Built dashboards.'],
      ]) assert(!deriveInterviewResumeConsistency([{ text, evidenceIds: ['dashboards'] }], evidence, resume), 'each spoken employer or title independently needs captured support');
      for (const resume of [
        'Engineer at Birch Works. Built dashboards.',
        'Built dashboards.',
        'Engineer. Built dashboards.',
        'Designer at Aster Labs. Built dashboards.',
        'Engineer at Aster Labs. Maintained alerts. Designer at Birch Works. Built dashboards.',
        'Engineer at Aster Labs. Maintained alerts. Designer Birch Works. Built dashboards.',
        'Engineer at Aster Labs. Maintained alerts. Birch Works. Built dashboards.',
        'Engineer at Aster Labs. I worked at Birch Works. Built dashboards.',
        'Engineer at Aster Labs. I built reports at Birch Works. Built dashboards.',
      ]) {
        assert(!deriveInterviewResumeConsistency(spoken, evidence, resume), 'career metadata cannot create missing captured employer/title or cross a contradictory role heading');
        assert(!resumeCoverage('Built dashboards.', evidence, resume, true, spoken), 'omitting the captured role context cannot support spoken employment');
      }
      const resume = 'Engineer at Aster Labs. Built dashboards.';
      const match = deriveInterviewResumeConsistency(spoken, evidence, resume);
      assert(match?.resumeQuote === 'Engineer at Aster Labs.\u2029Built dashboards.', 'a matching captured role heading establishes the stated employment');
      assert(resumeCoverage(match.resumeQuote, evidence, resume, true, spoken)
        && resumeCoverage(match.resumeQuote, evidence, undefined, false, spoken), 'captured role attribution survives both bound and sealed quote validation');
    },
  },
  {
    name: 'interview résumé coverage: complete-excerpt recovery preserves number and candor guards',
    run: () => {
      for (const [resume, claim] of [
        ['Built about 8 reporting dashboards for internal staff.', 'I built 8 reporting dashboards for internal staff.'],
        ['Built 8 reporting dashboards for internal staff.', 'I built 12 reporting dashboards for internal staff.'],
        ['Observed:\u2029Built a reporting dashboard in Python for internal staff.', statements[0].text],
        ['Did not perform:\u2029Built a reporting dashboard in Python for internal staff.', statements[0].text],
        ['Partially built a reporting dashboard in Python for internal staff.', statements[0].text],
        ['Supported the reporting dashboard implementation for internal staff.', 'I implemented the reporting dashboard for internal staff.'],
      ]) {
        const source = [{ id: 'guarded', text: resume }];
        const spoken = [{ text: claim, evidenceIds: ['guarded'] }];
        assert(!deriveInterviewResumeConsistency(spoken, source, resume), 'recovery cannot drop an approximation, quantity, attribution or scope limitation');
      }
    },
  },
];
