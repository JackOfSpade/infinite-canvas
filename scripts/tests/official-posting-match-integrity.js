import assert from 'node:assert/strict';
import { descriptionOverlap } from '../../electron/ipc/officialPostingMatch.js';
import { resolveOfficialPosting } from '../../electron/ipc/officialPostingResolver.js';

const EMPLOYER = 'Northwind Labs';
const ROLE = 'Requirements include experience building reliable ledger services for regional dispatch operators. '
  + 'Engineers design reconciliation interfaces and validate scheduled export changes against archived transaction records. '
  + 'Responsibilities include diagnosing incomplete loads, documenting audit contracts and improving exception handling in nightly pipelines. '
  + 'You will investigate delayed deliveries with service owners and maintain repeatable migration checks for operational reviewers.';
const OTHER_ROLE = 'Requirements include experience calibrating optical sensors for industrial inspection stations. '
  + 'Engineers maintain camera firmware and validate exposure timing against physical alignment measurements. '
  + 'Responsibilities include reviewing power budgets, documenting readout protocols and diagnosing sensor failures during laboratory experiments. '
  + 'You will build mechanical test fixtures with production technicians and maintain repeatable calibration procedures for quality inspectors.';
const ABOUT = 'About Northwind Labs. Northwind Labs makes workflow products for regional businesses across the country. '
  + 'We value kind colleagues, steady progress and thoughtful conversations in every office. '
  + 'We offer health coverage, flexible schedules, paid parental leave and a learning budget for every employee. '
  + 'Northwind Labs is an equal opportunity employer and welcomes applicants from every background and ability.';
const SHARED_PROCESS = [
  'Every department follows a review protocol that documents operational decisions before changes reach a supported deployment environment.',
  'Participants prepare a written summary describing dependencies, escalation contacts, release sequencing and recovery procedures for the affected service owners.',
  'Reviewers inspect recorded examples of expected output and compare exception handling behavior with the agreed operational contract before approval.',
  'During scheduled planning sessions colleagues examine pending questions, identify incomplete documentation and assign followup work to the relevant functional group.',
  'Each rollout includes an observation period during which support staff monitor reports and gather feedback from the operators using the updated workflow.',
  'The delivery checklist includes a verification record, an explanation of remaining risks and contact information for the person coordinating the release.',
  'When an unexpected condition appears, the responsible department records a timeline and compares observed outcomes against the original planning assumptions.',
  'A regular retrospective examines delayed decisions, missing context and opportunities to simplify communication across adjacent teams without changing their responsibilities.',
  'Written runbooks describe ordinary operating conditions, troubleshooting steps, escalation thresholds and the process for recording issues discovered during deployment.',
  'A shared archive keeps prior review summaries, operational notices, meeting notes and release records available for later investigation by authorized colleagues.',
  'Each planning cycle concludes with a review of unresolved questions and a clear schedule for gathering any additional information required by reviewers.',
].join(' ');
const ROOT = 'https://northwind.test/';
const BOARD = 'https://api.ashbyhq.com/posting-api/job-board/northwind?includeCompensation=true';
const URL = 'https://jobs.ashbyhq.com/northwind/one';
const row = extra => ({ title: 'Software Engineer', company: EMPLOYER, location: 'Lakeview, Ontario, Canada',
  snippet: ROLE, salary: '', salaryProvenance: 'unknown', url: 'https://www.linkedin.com/jobs/view/synthetic-role-20', ...extra });
const boardJob = extra => ({ id: 'one', title: 'Software Engineer', companyName: EMPLOYER, location: 'Lakeview, Ontario, Canada',
  descriptionPlain: ROLE, jobUrl: URL, applyUrl: `${URL}/application`, isListed: true, ...extra });
function pages(jobs) {
  return { [ROOT]: '<title>Northwind Labs</title><a href="/careers">Careers</a>',
    [`${ROOT}careers`]: '<title>Careers at Northwind Labs</title><a href="https://jobs.ashbyhq.com/northwind">Open roles</a>',
    'https://jobs.ashbyhq.com/northwind': '<main>Available roles</main>',
    [BOARD]: { body: JSON.stringify({ jobs }), contentType: 'application/json' } };
}
function network(fixtures) {
  return async url => {
    const page = fixtures[url];
    if (!page) { const error = new Error('Fixture page is closed'); error.code = 'closed'; throw error; }
    return { url, contentType: 'text/html', statusCode: 200, ...(typeof page === 'string' ? { body: page } : page) };
  };
}
const resolve = (job, jobs) => resolveOfficialPosting(job, { fetch: network(pages(jobs)), candidateUrls: [ROOT] });
function assertNoPosting(result) {
  assert.ok(['L5', 'L6'].includes(result.officialPosting.level), JSON.stringify(result));
  assert.equal(result.officialPosting.sourceUrl || '', '');
  assert.equal(result.officialPosting.officialApplyUrl || '', '');
  assert.equal(result.description, undefined);
}

export default [
  {
    name: 'Official posting integrity: a closed true role never transfers company boilerplate to a live sibling or stub',
    async run() {
      for (const descriptionPlain of [`${OTHER_ROLE} ${ABOUT}`, ABOUT]) {
        const job = row({ snippet: `${ROLE} ${ABOUT}` }); const original = JSON.stringify(job);
        const closed = boardJob({ isListed: false, descriptionPlain: `${ROLE} ${ABOUT}` });
        const sibling = boardJob({ id: 'sibling', jobUrl: 'https://jobs.ashbyhq.com/northwind/sibling',
          applyUrl: 'https://jobs.ashbyhq.com/northwind/sibling/application', descriptionPlain });
        const result = await resolve(job, [closed, sibling]);
        assertNoPosting(result);
        assert.ok(result.officialPosting.trail.includes('closed'));
        assert.equal(JSON.stringify(job), original);
      }
    },
  },
  {
    name: 'Official posting integrity: same-board peer copy is removed even when it is not a recognized boilerplate section',
    async run() {
      const actualText = `Tune graph optimization solvers that assign trucks to freight routes under changing delivery constraints. ${SHARED_PROCESS}`;
      const siblingText = `Reconcile invoice payment settlements that allocate carrier balances across regional billing accounts and financial ledgers. ${SHARED_PROCESS}`;
      assert.equal(descriptionOverlap(actualText, siblingText).anchored, true, 'the fixture requires peer-specific evidence rather than only the generic section filter');
      const result = await resolve(row({ snippet: actualText }), [boardJob({ isListed: false, descriptionPlain: actualText }),
        boardJob({ id: 'sibling', jobUrl: 'https://jobs.ashbyhq.com/northwind/sibling', descriptionPlain: siblingText })]);
      assertNoPosting(result);
      assert.ok(result.officialPosting.trail.includes('no-anchor'));
    },
  },
  {
    name: 'Official posting integrity: an exact live role remains L2 with its own text and apply link',
    async run() {
      const result = await resolve(row(), [boardJob()]);
      assert.equal(result.officialPosting.level, 'L2');
      assert.equal(result.officialPosting.employer, EMPLOYER);
      assert.equal(result.officialPosting.sourceUrl, URL);
      assert.equal(result.officialPosting.officialApplyUrl, `${URL}/application`);
      assert.equal(result.description, ROLE);
      assert.ok(result.officialPosting.trail.includes('description-anchor'));
    },
  },
  {
    name: 'Official posting integrity: ordinary employer wording and decorated titles still reach the employer ATS',
    async run() {
      for (const prefix of ['This is a full-time role.', 'There is a lot to do.', 'SQL is a must.',
        'Northwind is a leading software company.', 'We build tools our customers trust.', 'We are hiring for a Software Engineer.']) {
        const result = await resolve(row({ snippet: `${prefix} ${ROLE}` }), [boardJob()]);
        assert.equal(result.officialPosting.level, 'L2', prefix);
        assert.equal(result.officialPosting.employer, EMPLOYER, prefix);
      }
      for (const decoration of ['(Remote)', '- Remote', ', Lakeview', '| Hiring now', '$120k']) {
        const result = await resolve(row({ title: `Software Engineer at ${EMPLOYER} ${decoration}` }), [boardJob()]);
        assert.equal(result.officialPosting.level, 'L2', decoration);
        assert.equal(result.officialPosting.sourceUrl, URL, decoration);
      }
    },
  },
  {
    name: 'Official posting integrity: a true client intermediary cannot verify itself through its own domain or ATS tenant',
    async run() {
      const poster = 'Acme Talent Partners'; const ownRoot = 'https://acme-talent.test/';
      const ownDomain = `${ownRoot}jobs/one`; const ownTenant = 'https://jobs.lever.co/acme-talent/one';
      const jsonld = url => `<script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', url,
        title: 'Software Engineer', hiringOrganization: { name: poster, sameAs: ownRoot }, description: ROLE,
        jobLocation: { address: { addressLocality: 'Lakeview', addressRegion: 'Ontario', addressCountry: 'Canada' } }, identifier: 'one' })}</script>`;
      for (const url of [ownDomain, ownTenant]) {
        const job = row({ company: poster, snippet: `Our client, a dispatch software company, is hiring. ${ROLE}`, applyOptions: [{ label: 'Apply', href: url }] });
        const fixtures = { [ownRoot]: `<title>${poster}</title>`, [url]: jsonld(url) };
        const result = await resolveOfficialPosting(job, { fetch: network(fixtures) });
        assertNoPosting(result);
        assert.equal(result.postedBy, poster);
        assert.ok(result.officialPosting.trail.includes('poster-tenant'), url);
      }
    },
  },
];
