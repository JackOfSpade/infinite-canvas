import assert from 'node:assert/strict';
import {
  OFFICIAL_POSTING_SEMANTIC_INVENTORY_CAP,
  buildOfficialPostingSemanticInventory,
  buildOfficialPostingSemanticOptions,
  evaluateOfficialPostingSourceEligibility,
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
    name: 'Semantic source admission checks fetched ownership rather than employer title location pay or wording identity',
    run() {
      for (const candidate of [
        source(),
        source({ employer: 'A different employer', title: 'An entirely different role' }),
        source({ location: { display: 'Harbor, New Zealand', workMode: 'remote', remote: true } }),
        source({ salary: { text: 'GBP 39000/yr', provenance: 'posted' }, description: 'A paraphrase without common word sequences.' }),
        source({ description: '', title: '', employer: '', location: '' }),
      ]) {
        assert.deepEqual(evaluateOfficialPostingSourceEligibility(candidate, { now: NOW }),
          { eligible: true, reason: '', status: 'live' });
      }
      assert.equal(buildOfficialPostingSemanticInventory([source({ description: 'One word.' })], { now: NOW }).length, 1,
        'a short description remains evidence for AI rather than a deterministic identity veto');
    },
  },
  {
    name: 'Semantic inventory refuses unsafe aggregator and unproven sources even when semantic metadata agrees',
    run() {
      for (const sourceUrl of [
        'http://careers.northwind.example/jobs/17', 'javascript:alert(1)',
        'https://user:secret@careers.northwind.example/jobs/17', 'https://www.linkedin.com/jobs/view/17',
      ]) assert.equal(evaluateOfficialPostingSourceEligibility(source({ sourceUrl }), { now: NOW }).eligible, false, sourceUrl);
      assert.equal(evaluateOfficialPostingSourceEligibility(source({ employerDomainProven: false })).eligible, false);
      assert.equal(evaluateOfficialPostingSourceEligibility(source({ employerDomainProven: 'true' })).eligible, false);
      const ats = source({ sourceUrl: 'https://jobs.ashbyhq.com/northwind/dispatch-17' });
      assert.equal(evaluateOfficialPostingSourceEligibility(ats).eligible, false, 'domain proof cannot replace tenant proof on an ATS');
      assert.equal(evaluateOfficialPostingSourceEligibility({ ...ats, tenantProven: true }).eligible, true);
      assert.equal(evaluateOfficialPostingSourceEligibility(source({ employerDomainProven: false, officialPortalProven: true })).eligible, true);
      assert.equal(buildOfficialPostingSemanticInventory([ats, source({ employerDomainProven: false })]).length, 0);
    },
  },
  {
    name: 'Semantic inventory exposes closure and expiry evidence without treating structured expiry as confirmed closure',
    run() {
      for (const candidate of [source({ isListed: false }), source({ statusCode: 404 }), source({ httpStatus: 410 })]) {
        const result = evaluateOfficialPostingSourceEligibility(candidate, { now: NOW });
        assert.equal(result.eligible, true);
        assert.equal(result.status, 'closed');
      }
      for (const candidate of [source({ validThrough: '2000-01-01' }), source({ live: false })]) {
        const result = evaluateOfficialPostingSourceEligibility(candidate, { now: NOW });
        assert.equal(result.eligible, true);
        assert.equal(result.status, 'unavailable');
      }
      assert.equal(evaluateOfficialPostingSourceEligibility(source({ validThrough: 'invalid' }), { now: NOW }).status, 'live');
      const inventory = buildOfficialPostingSemanticInventory([source({ isListed: false })], { now: NOW });
      assert.equal(buildOfficialPostingSemanticOptions(inventory, ['C1']).options[0].status, 'closed');
    },
  },
  {
    name: 'Semantic inventory deduplicates only exact records and preserves contradictory representations of the same URL',
    run() {
      const first = source();
      const reordered = Object.fromEntries(Object.entries(first).reverse());
      const different = source({ description: 'A different fetched representation describes this role in other words.',
        location: { display: 'Lakeview, Canada', workMode: 'remote', remote: true } });
      const inventory = buildOfficialPostingSemanticInventory([first, reordered, different], { now: NOW });
      assert.equal(inventory.length, 2);
      assert.equal(new Set(inventory.map(item => item.sourceUrl)).size, 1);
      assert.notEqual(inventory[0].evidenceText, inventory[1].evidenceText);
      const reversed = buildOfficialPostingSemanticInventory([different, reordered, first], { now: NOW });
      assert.deepEqual(reversed.map(item => [item.id, item.evidenceText]), inventory.map(item => [item.id, item.evidenceText]),
        'candidate IDs and visible facts must not depend on fetch completion order');
      first.description = 'Caller changed the fetched record after the inventory was created.';
      assert.ok(inventory.every(item => !officialPostingSemanticCandidateEvidence(item).includes('Caller changed')),
        'later source mutations cannot change the evidence an outstanding handoff was shown');
    },
  },
  {
    name: 'Semantic inventory retains every admissible source before the explicit AI shortlist',
    run() {
      const candidates = Array.from({ length: 70 }, (_, index) => source({ identifier: `dispatch-${index}`,
        sourceUrl: `https://careers.northwind.example/jobs/dispatch-${index}` }));
      const inventory = buildOfficialPostingSemanticInventory(candidates, { now: NOW });
      assert.equal(inventory.length, 70, 'neither the final eight-option cap nor a shortlist chunk size truncates the source pool');
      assert.equal(inventory.at(-1).id, 'C70');
      const selected = [inventory[69].id, inventory[2].id, inventory[35].id];
      const result = buildOfficialPostingSemanticOptions(inventory, selected);
      assert.deepEqual(result.options.map(item => item.id), ['P1', 'P2', 'P3']);
      assert.deepEqual(result.candidateIds, ['C3', 'C36', 'C70']);
      assert.deepEqual(result.options.map(item => item.candidateId), result.candidateIds);
      assert.deepEqual(result.options.map(item => item.candidate), [inventory[2].candidate, inventory[35].candidate, inventory[69].candidate]);
      assert.deepEqual(buildOfficialPostingSemanticOptions(inventory, []), { options: [], candidateIds: [] });
      for (const selectedIds of [['C1', 'C1'], ['C999'], Array.from({ length: 9 }, (_, index) => `C${index + 1}`)]) {
        assert.throws(() => buildOfficialPostingSemanticOptions(inventory, selectedIds),
          error => error.code === 'OFFICIAL_POSTING_SEMANTIC_INVENTORY_INVALID');
      }
      assert.equal(buildOfficialPostingSemanticOptions(inventory, Array.from({ length: 8 }, (_, index) => `C${index + 1}`)).options.length, 8);
    },
  },
  {
    name: 'Semantic inventory structural overflow and malformed records hold visibly without silently dropping eligible sources',
    run() {
      const candidates = Array.from({ length: OFFICIAL_POSTING_SEMANTIC_INVENTORY_CAP + 1 }, (_, index) => source({ identifier: String(index) }));
      assert.throws(() => buildOfficialPostingSemanticInventory(candidates), error =>
        error.code === 'OFFICIAL_POSTING_SEMANTIC_INVENTORY_OVERFLOW'
        && error.candidateCount === candidates.length && error.cap === OFFICIAL_POSTING_SEMANTIC_INVENTORY_CAP);
      const cyclic = source(); cyclic.other = cyclic;
      assert.throws(() => buildOfficialPostingSemanticInventory([cyclic]), error => error.code === 'OFFICIAL_POSTING_SEMANTIC_INVENTORY_INVALID');
      assert.throws(() => buildOfficialPostingSemanticInventory(null), error => error.code === 'OFFICIAL_POSTING_SEMANTIC_INVENTORY_INVALID');
    },
  },
  {
    name: 'Semantic quote evidence includes source metadata and full plain description without requiring wording overlap',
    run() {
      const candidate = source({ employmentType: ['FULL_TIME'], jobLevel: 'mid-level',
        locations: ['Harbor, Ontario, Canada'], validThrough: '2040-01-01', isListed: true, statusCode: 200,
        description: '• Maintain dependable routing services.\n“Coordinate launch reviews” with partner teams.' });
      const [inventory] = buildOfficialPostingSemanticInventory([candidate], { now: NOW });
      const evidence = officialPostingSemanticCandidateEvidence(inventory);
      for (const fact of ['Employer: Northwind Labs', 'Title: Dispatch Systems Engineer', 'Location: Lakeview, Ontario, Canada',
        'Work mode: hybrid', 'Remote: false', 'Advertised salary: CAD 117000 - 139000/yr', 'Salary provenance: posted',
        'Identifier: dispatch-17', 'Employment type: FULL_TIME', 'Seniority or job level: mid-level',
        'Additional locations: Harbor, Ontario, Canada', 'Valid through: 2040-01-01', 'Listed: true', 'HTTP status: 200',
        'Source URL: https://careers.northwind.example/jobs/dispatch-17', 'Provenance: employer',
        'Maintain dependable routing services.', '"Coordinate launch reviews" with partner teams.']) assert.ok(evidence.includes(fact), fact);
      assert.equal(evidence, inventory.evidenceText);
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
