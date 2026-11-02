import assert from 'node:assert/strict';
import {
  officialPostingSemanticCandidateEvidence,
  officialPostingSemanticInputHash,
  officialPostingSemanticProofMatches,
  officialPostingSemanticScrapedEvidence,
  officialPostingSemanticSourceHash,
} from '../../electron/ipc/officialPostingSemantic.js';

const NOW = Date.UTC(2030, 0, 1);
const source = (extra = {}) => ({
  employer: 'Northwind Labs', title: 'Dispatch Systems Engineer',
  sourceUrl: 'https://careers.northwind.example/jobs/dispatch-17', employerDomainProven: true,
  location: { display: 'Lakeview, Ontario, Canada', workMode: 'hybrid', remote: false },
  salary: { text: 'CAD 117000 - 139000/yr', provenance: 'posted' },
  identifier: 'dispatch-17', provenance: 'employer',
  description: 'Develop routing services for delivery teams. Maintain release procedures and review operational failures.',
  ...extra,
});

export default [
  {
    name: 'Semantic quote evidence includes source metadata and full plain description without requiring wording overlap',
    run() {
      const candidate = source({ employmentType: ['FULL_TIME'], jobLevel: 'mid-level',
        locations: ['Harbor, Ontario, Canada'], validThrough: '2040-01-01', isListed: true, statusCode: 200,
        description: '• Maintain dependable routing services.\n“Coordinate launch reviews” with partner teams.' });
      const evidence = officialPostingSemanticCandidateEvidence({ ...candidate, status: 'live' });
      for (const fact of ['Employer: Northwind Labs', 'Title: Dispatch Systems Engineer', 'Location: Lakeview, Ontario, Canada',
        'Work mode: hybrid', 'Remote: false', 'Advertised salary: CAD 117000 - 139000/yr', 'Salary provenance: posted',
        'Identifier: dispatch-17', 'Employment type: FULL_TIME', 'Seniority or job level: mid-level',
        'Additional locations: Harbor, Ontario, Canada', 'Valid through: 2040-01-01', 'Listed: true', 'HTTP status: 200',
        'Source URL: https://careers.northwind.example/jobs/dispatch-17', 'Provenance: employer',
        'Maintain dependable routing services.', '"Coordinate launch reviews" with partner teams.']) assert.ok(evidence.includes(fact), fact);
      const scraped = officialPostingSemanticScrapedEvidence({ title: 'Delivery Platform Developer', company: 'Northwind Labs',
        location: 'Lakeview, Canada', salary: 'CAD 125000', salaryProvenance: 'estimated',
        snippet: 'Create tools that help operations coordinate regional deliveries.' });
      assert.ok(scraped.includes('Salary provenance: estimated'));
      assert.ok(!scraped.includes('125000'), 'a board estimate must not be presented as the employer’s advertised pay');
      assert.ok(scraped.includes('Create tools that help operations coordinate regional deliveries.'));
      assert.ok(officialPostingSemanticScrapedEvidence({ salary: 'CAD 125000', salaryProvenance: 'posted' }).includes('Advertised salary: CAD 125000'));
      const bothSourceTexts = officialPostingSemanticScrapedEvidence({ snippet: 'Primary scraped reference.', description: 'Another representation.' });
      assert.ok(bothSourceTexts.includes('Primary scraped reference.') && !bothSourceTexts.includes('Another representation.'),
        'scraped evidence follows the same primary snippet preference as its bridge view');
    },
  },
  {
    name: 'Semantic cache proofs require the current contract marker and exact source-input hash',
    run() {
      const job = { title: 'Dispatch Systems Engineer', company: 'Northwind Labs', snippet: 'Maintain regional delivery tools.' };
      const posting = { trail: ['domain-proof', 'semantic-match-v1'], semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(job) } };
      assert.equal(officialPostingSemanticProofMatches(job, posting), true);
      assert.equal(officialPostingSemanticProofMatches(job, { officialPosting: posting }), true);
      assert.equal(officialPostingSemanticProofMatches(job, { ...posting, level: 'L2' }), false,
        'positive resolutions also require a hash of the official source facts');
      assert.equal(officialPostingSemanticProofMatches(job, { ...posting, level: 'L2',
        semanticMatch: { ...posting.semanticMatch, sourceHash: 'b'.repeat(64) } }), true);
      assert.equal(officialPostingSemanticProofMatches({ ...job, snippet: 'Maintain warehouse finance tools.' }, posting), false);
      for (const invalid of [
        { ...posting, trail: ['domain-proof'] },
        { ...posting, semanticMatch: { ...posting.semanticMatch, version: 0 } },
        { ...posting, semanticMatch: { ...posting.semanticMatch, version: '1' } },
        { ...posting, semanticMatch: { ...posting.semanticMatch, inputHash: 'not-a-hash' } },
        { ...posting, semanticMatch: undefined }, null,
      ]) assert.equal(officialPostingSemanticProofMatches(job, invalid), false);
    },
  },
  {
    name: 'Semantic official-source hashes cover all visible facts without depending on object key order or host proof bookkeeping',
    run() {
      const candidate = source();
      const initial = officialPostingSemanticSourceHash(candidate, { now: NOW });
      assert.match(initial, /^[a-f0-9]{64}$/u);
      assert.equal(officialPostingSemanticSourceHash(Object.fromEntries(Object.entries(candidate).reverse()), { now: NOW }), initial);
      assert.equal(officialPostingSemanticSourceHash({ ...candidate, fetchedAt: '2040-01-01', employerDomainProven: false }, { now: NOW }), initial);
      for (const update of [
        { title: 'Another role' }, { employer: 'Another employer' }, { location: 'Harbor, Canada' },
        { salary: { text: 'CAD 140000', provenance: 'posted' } }, { description: 'Changed role facts.' },
        { identifier: 'another-id' }, { employmentType: 'CONTRACTOR' }, { jobLevel: 'senior' },
        { isListed: false }, { validThrough: '2000-01-01' }, { provenance: 'careers' },
        { sourceUrl: 'https://careers.northwind.example/jobs/another' },
      ]) assert.notEqual(officialPostingSemanticSourceHash({ ...candidate, ...update }, { now: NOW }), initial, Object.keys(update)[0]);
    },
  },
  {
    name: 'Semantic input hashes bind saved decisions to full source facts and descriptions',
    run() {
      const job = { title: 'Delivery Platform Developer', company: 'Northwind Labs', location: 'Lakeview, Canada',
        salary: 'CAD 125000', salaryProvenance: 'posted', url: 'https://board.example/jobs/17',
        applyOptions: [{ href: 'https://careers.northwind.example/jobs/17', label: 'Employer' }],
        snippet: `${'Shared source content. '.repeat(300)}Original closing sentence.`, description: 'Additional source description.' };
      const initial = officialPostingSemanticInputHash(job);
      assert.match(initial, /^[a-f0-9]{64}$/u);
      assert.equal(officialPostingSemanticInputHash(Object.fromEntries(Object.entries(job).reverse())), initial);
      assert.equal(officialPostingSemanticInputHash({ ...job, title: '  Delivery  Platform Developer  ' }), initial);
      for (const update of [
        { title: 'Another title' }, { company: 'Another employer' }, { location: 'Another city' },
        { salary: 'CAD 135000' }, { salaryProvenance: 'estimated' }, { url: 'https://board.example/jobs/18' },
        { applyOptions: [{ href: 'https://careers.northwind.example/jobs/18', label: 'Employer' }] },
        { snippet: `${job.snippet} A material fact beyond the excerpt cap.` }, { description: 'Changed description.' },
        { workMode: 'remote' }, { remote: true }, { remoteCountry: 'Canada' }, { remoteRegion: 'Ontario' },
        { locations: ['Another city'] }, { employmentType: 'PART_TIME' }, { seniority: 'senior' }, { jobLevel: 'L4' },
        { identifier: 'another-request' }, { requisitionId: 'another-request' }, { reqId: 'another-request' },
        { googleCardUrl: 'https://board.example/reference/another' },
      ]) assert.notEqual(officialPostingSemanticInputHash({ ...job, ...update }), initial, Object.keys(update)[0]);
      assert.equal(officialPostingSemanticInputHash({ ...job, unrelatedRendererState: true }), initial);
    },
  },
];
