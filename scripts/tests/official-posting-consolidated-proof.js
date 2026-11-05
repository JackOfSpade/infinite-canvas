import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOfficialPostingStore, officialPostingView } from '../../electron/ipc/officialPostingStore.js';
import {
  officialPostingConsolidatedMemberShapes, officialPostingSemanticInputHash,
  officialPostingSemanticProjectedInput, officialPostingSemanticProofMatches,
} from '../../electron/ipc/officialPostingSemantic.js';
import { officialPostingConsumerJobs } from '../../electron/ipc/jobs.js';
import { __projectLocalApplicationJobForAcceptanceHarness as hostProjection } from '../../electron/ipc/localAiApplication.js';
import { projectOfficialPostingGenerationJob } from '../../src/utils/officialPostingPreparation.js';
import { consolidateJobLocations, MULTIPLE_LOCATIONS_LABEL } from '../../src/utils/jobLocationConsolidation.js';

// Long enough (500+ alphanumerics) for exact-description consolidation.
const SCRAPED = Array.from({ length: 12 }, (_, index) => `Kestrel Freight builds dispatch routing tools, part ${index}, `
  + 'and its engineers review rosters, carrier contracts and release procedures with operations staff.').join(' ');
const OFFICIAL = 'Kestrel Freight official posting: build dispatch routing services, own release reviews and mentor engineers. Pay CAD 120,000 to 150,000.';
const SOURCE_HASH = 'b'.repeat(64);

const member = (extra = {}) => ({
  source: 'linkedin', title: 'Routing Engineer', company: 'Kestrel Freight', salary: '',
  snippet: SCRAPED, description: SCRAPED, ...extra,
});
const TORONTO = member({ location: 'Toronto, Ontario, Canada', url: 'https://ca.linkedin.example/jobs/view/routing-engineer-101' });
const OTTAWA = member({ location: 'Ottawa, Ontario, Canada', url: 'https://ca.linkedin.example/jobs/view/routing-engineer-202' });

function proven(judged, extra = {}) {
  return {
    level: 'L2', outcome: 'found', employer: 'Kestrel Freight', title: 'Routing Engineer',
    location: { display: 'Toronto, Ontario, Canada', workMode: 'hybrid', remote: false, remoteCountry: '', remoteRegion: '' },
    salary: { text: 'CAD 120,000 to 150,000', provenance: 'posted' },
    sourceUrl: 'https://careers.kestrel.example/jobs/101', ats: 'synthetic', tenant: 'kestrel',
    fetchedAt: '2026-11-01T00:00:00.000Z', trail: ['worker-research', 'comparative-match', 'semantic-match-v1'],
    semanticMatch: { version: 1, inputHash: officialPostingSemanticInputHash(judged), sourceHash: SOURCE_HASH },
    ...extra,
  };
}

async function withStore(run) {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'official-posting-consolidated-'));
  try { await run(createOfficialPostingStore(path.join(parent, 'official-postings'))); }
  finally { await fs.rm(parent, { recursive: true, force: true }); }
}

/** Save the judged member's record, then consolidate the members exactly as the Board does. */
async function consolidatedFixture(store, { judged = TORONTO, posting = proven(judged) } = {}) {
  const record = await store.save(judged, { officialPosting: posting, description: OFFICIAL });
  const rows = [TORONTO, OTTAWA].map(row => ({ ...row, officialPosting: record.officialPosting }));
  const { jobs } = consolidateJobLocations(rows);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].location, MULTIPLE_LOCATIONS_LABEL);
  assert.equal(jobs[0].consolidatedPostingCount, 2);
  return { record, row: jobs[0] };
}

const isOfficial = view => view.description === OFFICIAL && view.salary === 'CAD 120,000 to 150,000' && Boolean(view.officialPosting);
const isScraped = (view, row) => view.description === String(row.snippet || row.description || '') && view.salary === String(row.salary ?? '') && !view.officialPosting;

export default [
  {
    name: 'A consolidated row regains official facts through the stored record its primary member proved, keeping its own location label',
    async run() {
      await withStore(async store => {
        const { row } = await consolidatedFixture(store);
        assert.equal(officialPostingSemanticInputHash(row) === officialPostingSemanticInputHash(TORONTO), false, 'consolidation changes the hashed input');
        const view = await officialPostingView(row, { store, requireSemantic: true });
        assert.ok(isOfficial(view), JSON.stringify(view).slice(0, 300));
        assert.equal(view.location, MULTIPLE_LOCATIONS_LABEL, 'one member\'s official place never relabels the row');
        const [consumer] = await officialPostingConsumerJobs([row], { getView: job => officialPostingView(job, { store, requireSemantic: true }) });
        assert.equal(consumer.description, OFFICIAL);
        assert.equal(consumer.location, MULTIPLE_LOCATIONS_LABEL);
        assert.equal(Object.hasOwn(consumer, 'remote'), false, 'one member\'s remote status never speaks for the row');
      });
    },
  },
  {
    name: 'A consolidated row also regains a record a non-primary member proved, rebuilt from that member\'s own variant',
    async run() {
      await withStore(async store => {
        const { row } = await consolidatedFixture(store, { judged: OTTAWA, posting: proven(OTTAWA, {
          location: { display: 'Ottawa, Ontario, Canada', workMode: 'hybrid', remote: false, remoteCountry: '', remoteRegion: '' } }) });
        assert.equal(row.url, TORONTO.url, 'Toronto stays the primary row');
        assert.ok(isOfficial(await officialPostingView(row, { store, requireSemantic: true })));
      });
    },
  },
  {
    name: 'Without a matching stored record a consolidated row gets nothing, whatever its own metadata claims',
    async run() {
      await withStore(async store => {
        const { row } = await consolidatedFixture(store);
        const empty = await fs.mkdtemp(path.join(os.tmpdir(), 'official-posting-consolidated-empty-'));
        try {
          const other = createOfficialPostingStore(path.join(empty, 'official-postings'));
          assert.ok(isScraped(await officialPostingView(row, { store: other, requireSemantic: true }), row));
        } finally { await fs.rm(empty, { recursive: true, force: true }); }
        // A row that carries a different content hash than the stored record never reads it.
        const swapped = { ...row, officialPosting: { ...row.officialPosting, contentHash: 'c'.repeat(64) } };
        assert.ok(!isOfficial(await officialPostingView(swapped, { store, requireSemantic: true })));
      });
    },
  },
  {
    name: 'A forged consolidated row whose rebuilt members were never judged, and unconsolidated rows with a failed proof, get no official facts',
    async run() {
      await withStore(async store => {
        const { row } = await consolidatedFixture(store);
        // The same variants with another description: no member reproduces the judged input.
        const forged = { ...row, snippet: `${SCRAPED} Extra duties.`, description: `${SCRAPED} Extra duties.` };
        assert.ok(isScraped(await officialPostingView(forged, { store, requireSemantic: true }), forged));
        // A variant whose location was judged, but whose URL belongs to nobody the judge saw.
        const strangerVariants = { ...row, url: 'https://ca.linkedin.example/jobs/view/routing-engineer-999',
          postingVariants: row.postingVariants.map(variant => ({ ...variant, url: 'https://ca.linkedin.example/jobs/view/routing-engineer-999' })) };
        assert.ok(isScraped(await officialPostingView(strangerVariants, { store, requireSemantic: true }), strangerVariants));
        // Unconsolidated rows never get member shapes: the label alone, or variants without the consolidation count.
        for (const unconsolidated of [
          { ...row, consolidatedPostingCount: undefined },
          { ...row, consolidatedPostingCount: 1 },
          { ...TORONTO, location: MULTIPLE_LOCATIONS_LABEL, officialPosting: row.officialPosting },
          { ...TORONTO, location: 'Ottawa, Ontario, Canada', postingVariants: row.postingVariants, officialPosting: row.officialPosting },
        ]) {
          assert.deepEqual(officialPostingConsolidatedMemberShapes(unconsolidated), [], JSON.stringify(unconsolidated.location));
          assert.equal(officialPostingSemanticProofMatches(unconsolidated, row.officialPosting), false);
          assert.ok(!isOfficial(await officialPostingView(unconsolidated, { store, requireSemantic: true })));
        }
      });
    },
  },
  {
    name: 'A closed or missing verdict about one member never settles a consolidated row',
    async run() {
      await withStore(async store => {
        const { row } = await consolidatedFixture(store);
        const live = row.officialPosting;
        assert.equal(officialPostingSemanticProofMatches(row, live), true);
        for (const outcome of ['closed', 'not-found', 'ambiguous']) {
          assert.equal(officialPostingSemanticProofMatches(row, { ...live, outcome }), false, outcome);
          // The same verdict still holds for the member it was about.
          assert.equal(officialPostingSemanticProofMatches(TORONTO, { ...live, outcome }), true, outcome);
        }
      });
    },
  },
  {
    name: 'A proof saved by card refresh or Prepare, which judge the projected card, holds for the raw Board row',
    async run() {
      await withStore(async store => {
        const raw = { ...TORONTO, location: 'Toronto, Ontario, Canada' };
        const projected = hostProjection(projectOfficialPostingGenerationJob(raw));
        assert.notEqual(officialPostingSemanticInputHash(projected), officialPostingSemanticInputHash(raw), 'the projection fills defaults the raw row lacks');
        const record = await store.save(raw, { officialPosting: proven(projected), description: OFFICIAL });
        const card = { ...raw, officialPosting: record.officialPosting };
        assert.equal(officialPostingSemanticProofMatches(card, record.officialPosting), true);
        assert.ok(isOfficial(await officialPostingView(card, { store, requireSemantic: true })));
        // The projected job itself still matches, so Prepare and refresh keep reading their own proofs.
        assert.equal(officialPostingSemanticProofMatches(projected, record.officialPosting), true);
        // A changed row is not rescued by the projection.
        const changed = { ...card, snippet: `${SCRAPED} Changed.` };
        assert.equal(officialPostingSemanticProofMatches(changed, record.officialPosting), false);
        assert.ok(isScraped(await officialPostingView(changed, { store, requireSemantic: true }), changed));
      });
    },
  },
  {
    name: 'The proof\'s projection hashes exactly what the renderer and host projections deliver',
    run() {
      const rows = [
        TORONTO,
        { ...TORONTO, url: undefined, googleCardUrl: 'https://www.google.com/search?q=routing&htidocid=Opaque-K%3D%3D&ibp=htl;jobs' },
        { ...TORONTO, salary: ' CAD 1\r\n', salaryProvenance: 'posted', applyOptions: [{ href: 'https://careers.kestrel.example/jobs/101', title: 'Kestrel' }],
          remote: false, workMode: 'hybrid', employer: 'Kestrel Freight', locations: ['Toronto', 'Ottawa'], identifier: 'R-101' },
        { title: 'Routing Engineer', company: 'Kestrel Freight' },
      ];
      for (const raw of rows) {
        const real = hostProjection(projectOfficialPostingGenerationJob(raw));
        assert.equal(officialPostingSemanticInputHash(officialPostingSemanticProjectedInput(raw)), officialPostingSemanticInputHash(real), JSON.stringify(raw).slice(0, 120));
        // Projection is stable, so a projected job re-projects to itself.
        assert.equal(officialPostingSemanticInputHash(officialPostingSemanticProjectedInput(real)), officialPostingSemanticInputHash(real));
      }
    },
  },
];
