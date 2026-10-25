import assert from 'node:assert/strict';
import { coreTitle, evaluateOfficialPostingMatch, posterEmployerSignals } from '../../electron/ipc/officialPostingMatch.js';
import { extractAshbyPostings, extractLeverPostings } from '../../electron/ipc/officialPostingExtractors.js';
import { extractJobPostingBaseSalary, extractJobPostingDescription } from '../../electron/extractors/apiExtractors.js';
import { parseGuaranteedCashOffer } from '../../electron/ipc/jobCompensation.js';
import { officialPostingConsumerJobs, snapshotDescriptionRecoveryJobs } from '../../electron/ipc/jobs.js';

const description = 'Full-time engineers maintain dispatch services and coordinate reliable release reviews.';
const company = 'Northwind Labs';
const location = 'Lakeview, Ontario, Canada';
const script = data => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

export default [
  {
    name: 'R3 title identity strips only a known employer suffix and retains at Scale as role identity',
    run() {
      assert.notEqual(coreTitle('Engineer at Scale'), coreTitle('Engineer'));
      assert.notEqual(coreTitle('Engineer at Scale', { company }), coreTitle('Engineer', { company }));
      assert.equal(coreTitle(`Sr. Software Eng. at ${company} (Remote)`, { company }), 'senior software engineer');
      assert.equal(coreTitle('Software Engineer at Cedar Works', { company: 'Elm Talent', employerHypotheses: ['Cedar Works'] }), 'software engineer');
      assert.equal(coreTitle(`Software Engineer at ${company} | Hiring now`, { company }), 'software engineer');
      assert.equal(coreTitle('Engineer at Scale | Hiring now', { company }), 'engineer at scale');
      const result = evaluateOfficialPostingMatch({ title: 'Engineer at Scale', company, location,
        salary: 'USD 90000 - 110000/yr', salaryProvenance: 'posted', snippet: description }, {
        title: 'Engineer', employer: company, location: { display: location },
        salary: { text: 'USD 90000 - 110000/yr', provenance: 'posted' }, description,
        sourceUrl: 'https://jobs.ashbyhq.com/northwind/one', ats: 'ashby', tenant: 'northwind', tenantProven: true, live: true, statusCode: 200,
      });
      assert.equal(result.passed, false);
      assert.equal(result.reason, 'title-mismatch');
    },
  },
  {
    name: 'R3 LinkedIn S2 slug comparison drops ampersands without changing strict employer ownership',
    run() {
      const signals = posterEmployerSignals({ title: 'Software Engineer', company: 'Elm & Finch',
        url: 'https://www.linkedin.com/jobs/view/software-engineer-at-northwind-labs-at-elm-finch-123456', snippet: 'Our client needs reliable dispatch services.' });
      assert.equal(signals.S2, 'northwind labs');
      assert.ok(signals.hypotheses.includes('northwind labs'));
      const reverse = posterEmployerSignals({ title: 'Software Engineer', company: 'Elm & Finch',
        url: 'https://www.linkedin.com/jobs/view/software-engineer-at-elm-finch-at-northwind-labs-123456' });
      assert.equal(reverse.S2, 'northwind labs');
    },
  },
  {
    name: 'R3 vendor hour month and year intervals survive the official consumer view into compensation',
    async run() {
      for (const [leverInterval, ashbyInterval, suffix, low, high, annualLow] of [
        ['per-hour-wage', '1 HOUR', '/hr', 30, 40, 62400],
        ['per-month-salary', '1 MONTH', '/mo', 3000, 4000, 36000],
        ['per-year-salary', '1 YEAR', '/yr', 90000, 110000, 90000],
      ]) {
        const lever = extractLeverPostings(JSON.stringify([{ id: 'one', text: 'Engineer',
          hostedUrl: 'https://jobs.lever.co/northwind/one', categories: { location }, descriptionPlain: description,
          salaryRange: { currency: 'USD', interval: leverInterval, min: low, max: high } }]), { employer: company })[0];
        const ashby = extractAshbyPostings(JSON.stringify({ jobs: [{ id: 'one', title: 'Engineer', location,
          jobUrl: 'https://jobs.ashbyhq.com/northwind/one', descriptionPlain: description, isListed: true,
          compensation: { summaryComponents: [{ compensationType: 'Salary', currencyCode: 'USD', interval: ashbyInterval, minValue: low, maxValue: high }] } }] }), { employer: company })[0];
        for (const candidate of [lever, ashby]) {
          assert.equal(candidate.salary.text, `USD ${low} - ${high}${suffix}`);
          assert.equal(candidate.salary.provenance, 'posted');
          const raw = { title: 'Engineer', company, location, salary: 'USD 20000/yr', snippet: 'Scraped text.', url: 'https://board.example.test/one',
            officialPosting: { level: 'L2', outcome: 'found', employer: company, sourceUrl: candidate.sourceUrl } };
          const [view] = await officialPostingConsumerJobs([raw], { getView: async () => ({ employer: company,
            title: candidate.title, location, salary: candidate.salary.text, description, officialPosting: raw.officialPosting }) });
          assert.equal(view.salary, candidate.salary.text);
          const offer = parseGuaranteedCashOffer(view);
          assert.equal(offer.usable, true, JSON.stringify(offer));
          assert.equal(offer.min, annualLow);
          assert.equal(raw.salary, 'USD 20000/yr');
        }
      }
    },
  },
  {
    name: 'R3 Dice-shaped related ItemList cannot precede the page-bound main posting or lend its salary',
    run() {
      const url = 'https://www.dice.com/job-detail/synthetic-main';
      const related = { '@type': 'JobPosting', url: 'https://www.dice.com/job-detail/synthetic-related',
        description: 'Related job description.', baseSalary: { currency: 'USD', value: { value: 1, unitText: 'HOUR' } } };
      const main = { '@type': 'JobPosting', url: `${url}?utm_source=fixture`, description: '<p>Main dispatch responsibilities.</p>',
        baseSalary: { currency: 'USD', value: { minValue: 30, maxValue: 40, unitText: 'HOUR' } } };
      const html = script({ '@type': 'ItemList', itemListElement: [{ '@type': 'ListItem', item: related }] })
        + script({ '@graph': [{ '@type': 'Organization', name: company }, main] });
      assert.equal(extractJobPostingDescription(html, url), main.description);
      assert.deepEqual(extractJobPostingBaseSalary(html, url), main.baseSalary);
      assert.equal(extractJobPostingDescription(html, `${url}-missing`), '');
      assert.equal(extractJobPostingBaseSalary(html, `${url}-missing`), null);
      const conflict = html + script({ ...main, description: 'Conflicting main description.' });
      assert.equal(extractJobPostingDescription(conflict, url), '');
      assert.equal(extractJobPostingBaseSalary(conflict, url), null);
      assert.equal(extractJobPostingDescription(script({ '@type': 'JobPosting', description: 'Legacy URL-less posting.' }), url), 'Legacy URL-less posting.');
    },
  },
  {
    name: 'R3 Solve recovery overlays only compatible resolved metadata and preserves newly recovered scraped fields',
    run() {
      const raw = { title: 'Engineer', company, location, source: 'google', url: 'https://board.example.test/recovery', snippet: 'New recovered source text.' };
      const resolved = { ...raw, snippet: 'Older recovered text.', postedBy: 'Elm Talent',
        officialPosting: { level: 'L2', outcome: 'found', employer: company, sourceUrl: 'https://jobs.ashbyhq.com/northwind/recovery' } };
      const snapshot = { descriptionRecoveryJobs: [raw], jobs: [resolved] };
      const [carried] = snapshotDescriptionRecoveryJobs(snapshot);
      assert.deepEqual(carried.officialPosting, resolved.officialPosting);
      assert.equal(carried.postedBy, resolved.postedBy);
      for (const field of ['title', 'company', 'location', 'source', 'url', 'snippet']) assert.equal(carried[field], raw[field]);
      assert.equal(Object.hasOwn(raw, 'officialPosting'), false);
      const [different] = snapshotDescriptionRecoveryJobs({ ...snapshot, jobs: [{ ...resolved, company: 'Cedar Works' }] });
      assert.equal(Object.hasOwn(different, 'officialPosting'), false, 'URL identity alone cannot lend another employer proof');
    },
  },
];
