import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { findSavedApplicationLinks, loadAppliedListingKeys } from '../../electron/ipc/localAiApplication.js';
import {
  applicationListingKeys, applicationRoleKey, filterAppliedListings, selectSavedApplicationBundle,
} from '../../src/utils/applicationBundleIdentity.js';

const FIXTURE_JOB = { company: 'Acme Corp', title: 'Senior Engineer', location: 'Remote' };
const FIXTURE_IMPORTED_AT = '2024-05-01T10:00:00.000Z';

// Builds one verified legacy-free receipt (listingKeys stored) in a temp canvas.
async function withReceiptFixture(run) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ic-role-')));
  const canvasFilePath = path.join(root, 'canvas.json');
  const jobId = '123e4567-e89b-42d3-a456-426614174888';
  const out = path.join(root, 'Applied Jobs', 'Acme');
  const receipts = path.join(root, '.local-ai', 'handoff-receipts');
  try {
    await fs.writeFile(canvasFilePath, '{}');
    await fs.mkdir(out, { recursive: true });
    await fs.mkdir(receipts, { recursive: true });
    const receipt = {
      version: 2, jobId, canvasFilePath, status: 'imported', resultSha256: 'b'.repeat(64), outputDir: out,
      importedAt: FIXTURE_IMPORTED_AT,
      listingKeys: applicationListingKeys({ url: 'https://example.test/jobs/acme-1' }),
    };
    await fs.writeFile(path.join(receipts, `${jobId}.json`), JSON.stringify(receipt));
    await fs.writeFile(path.join(out, 'Generation Audit.json'), JSON.stringify({
      jobId, job: FIXTURE_JOB, finalArtifacts: { resultSha256: receipt.resultSha256 },
    }));
    await run({ root, canvasFilePath, out });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

export default [
  { name: 'bundle matching preserves fragment posting ids and ignores Google search route changes', run() {
    const first = applicationListingKeys({ url: 'https://www.google.com/search?q=engineer&ibp=htl;jobs#htidocid=AbC123&htivrt=jobs' });
    const second = applicationListingKeys({ url: 'https://www.google.com/search?q=engineer&ibp=htl;jobs#htidocid=Other123&htivrt=jobs' });
    assert.notDeepEqual(first, second);
    assert.deepEqual(first, applicationListingKeys({ googleCardUrl: 'https://www.google.ca/search?udm=8&htidocid=AbC123&q=different' }));
    assert.notDeepEqual(first, applicationListingKeys({ url: 'https://www.google.com/search?udm=8&htidocid=abc123' }));
    assert.deepEqual(applicationListingKeys({ url: 'https://www.google.com/search?q=engineer&ibp=htl;jobs' }), []);
    assert.notDeepEqual(applicationListingKeys({ url: 'https://example.test/careers#/jobs/one' }),
      applicationListingKeys({ url: 'https://example.test/careers#/jobs/two' }));
  } },
  { name: 'FULL and APPLINK include metadata-only restoration diagnostics', run() {
    const payload = { description: '', nodes: [], edges: [], drawings: [], frontEndState: {}, eventLogs: [] };
    for (const filterCode of ['FULL', 'APPLINK']) {
      assert.ok(generateMarkdown({ ...payload, filterCode }).markdown.includes('## Saved Application Links (APPLINK)'));
    }
  } },
  { name: 'saved bundle lookup restores rebuilt variants and rejects ambiguous folders', async run() {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ic-links-')));
    const canvasFilePath = path.join(root, 'canvas.json');
    const jobId = '123e4567-e89b-42d3-a456-426614174777';
    const out = path.join(root, 'Applied Jobs', 'Synthetic');
    const receipts = path.join(root, '.local-ai', 'handoff-receipts');
    try {
      await fs.writeFile(canvasFilePath, '{}');
      await fs.mkdir(out, { recursive: true });
      await fs.mkdir(receipts, { recursive: true });
      const listing = '# Synthetic\n\n**Listing URL:** <https://example.test/jobs/one>\n\n---\n\nUntrusted listing body';
      const hash = crypto.createHash('sha256').update(listing).digest('hex');
      const receipt = { version: 2, jobId, canvasFilePath, status: 'imported', resultSha256: 'a'.repeat(64), outputDir: out };
      await fs.writeFile(path.join(receipts, `${jobId}.json`), JSON.stringify(receipt));
      await fs.writeFile(path.join(out, 'Original Job Listing.md'), listing);
      const audit = { jobId, job: FIXTURE_JOB, finalArtifacts: { resultSha256: receipt.resultSha256, originalJobListingSha256: hash } };
      await fs.writeFile(path.join(out, 'Generation Audit.json'), JSON.stringify(audit));
      const jobs = [{ nodeId: 'rebuilt', url: 'https://example.test/jobs/two', postingVariants: [{ url: 'https://example.test/jobs/one?utm_source=board' }] }];
      const result = await findSavedApplicationLinks({ canvasFilePath, jobs });
      assert.equal(result.links.length, 1);
      assert.equal(result.links[0].localApplication.savedDir, out);
      assert.equal(result.links[0].localApplication.status, 'saved');
      assert.equal((await findSavedApplicationLinks({ canvasFilePath, jobs: [{ nodeId: 'other', url: 'https://example.test/jobs/new' }] })).links.length, 0);
      // Sibling canvases do not own this receipt.
      const otherCanvas = path.join(root, 'other.json');
      await fs.writeFile(otherCanvas, '{}');
      assert.equal((await findSavedApplicationLinks({ canvasFilePath: otherCanvas, jobs })).links.length, 0);
      await fs.writeFile(path.join(out, 'Original Job Listing.md'), listing + '\nmodified');
      assert.equal((await findSavedApplicationLinks({ canvasFilePath, jobs })).links.length, 0);
      await fs.writeFile(path.join(out, 'Original Job Listing.md'), listing);
      await fs.writeFile(path.join(receipts, `${jobId}.json`), JSON.stringify({ ...receipt,
        listingKeys: applicationListingKeys({ url: 'https://example.test/jobs/one' }),
      }));
      await fs.unlink(path.join(out, 'Original Job Listing.md'));
      assert.equal((await findSavedApplicationLinks({ canvasFilePath, jobs })).links.length, 1,
        'new receipts keep posting identity independently of editable listing text');
      await fs.writeFile(path.join(out, 'Generation Audit.json'), JSON.stringify({ ...audit, jobId: 'replaced' }));
      assert.equal((await findSavedApplicationLinks({ canvasFilePath, jobs })).links.length, 0);
      await fs.rm(out, { recursive: true });
      assert.equal((await findSavedApplicationLinks({ canvasFilePath, jobs })).links.length, 0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
    const keys = applicationListingKeys({ url: 'https://example.test/job?jk=one' });
    const bundles = ['folder-a', 'folder-b'].map(savedDir => ({ listingKeys: keys, localApplication: { savedDir } }));
    assert.equal(selectSavedApplicationBundle({ url: 'https://example.test/job?jk=one' }, bundles), null);
    assert.notDeepEqual(keys, applicationListingKeys({ url: 'https://example.test/job?jk=two' }));
  } },
  { name: 'filterAppliedListings removes only exact listing overlaps', run() {
    const applied = new Set(applicationListingKeys({ url: 'https://example.test/jobs/acme-1' }));
    const jobs = [
      { title: 'A', company: 'Acme', url: 'https://www.example.test/jobs/acme-1/?utm_source=x' },
      { title: 'B', company: 'Acme', url: 'https://example.test/jobs/other', postingVariants: [{ url: 'https://example.test/jobs/acme-1' }] },
      { title: 'Senior Engineer', company: 'Acme Corp', url: 'https://example.test/jobs/acme-2' },
    ];
    const result = filterAppliedListings(jobs, applied);
    assert.equal(result.removed, 2);
    assert.deepEqual(result.kept, [jobs[2]]);
    assert.deepEqual(result.samples.map(s => s.title), ['A', 'B']);
    assert.deepEqual(result.samples[0], { title: 'A', company: 'Acme', url: jobs[0].url });
    assert.equal(filterAppliedListings(jobs, new Set()).kept.length, 3);
    assert.equal(filterAppliedListings(jobs, undefined).removed, 0);
    assert.equal(filterAppliedListings(jobs, [...applied]).removed, 2);
    assert.deepEqual(filterAppliedListings(null, applied), { kept: [], removed: 0, samples: [] });
    const many = Array.from({ length: 8 }, (_, i) => ({ title: `T${i}`, url: 'https://example.test/jobs/acme-1' }));
    const capped = filterAppliedListings(many, applied);
    assert.equal(capped.removed, 8);
    assert.equal(capped.samples.length, 5);
  } },
  { name: 'applicationRoleKey normalizes company and title', run() {
    assert.equal(applicationRoleKey({ company: 'Acme Corp', title: 'Senior Engineer' }), 'acme corp|senior engineer');
    assert.equal(applicationRoleKey({ company: '  ACME   Corp. ', title: 'Senior\n Engineer -' }), 'acme corp|senior engineer');
    assert.equal(applicationRoleKey({ company: 'R&amp;D &#38; Co', title: 'Dev &quot;Lead&quot; &#39;x&apos;' }), `r&d & co|dev "lead" 'x'`);
    assert.equal(applicationRoleKey({ company: 'Acme', title: '  ' }), '');
    assert.equal(applicationRoleKey({ company: '', title: 'Engineer' }), '');
    assert.equal(applicationRoleKey({ title: 'Engineer' }), '');
  } },
  { name: 'saved bundle lookup reports reposts as role matches without linking them', async run() {
    await withReceiptFixture(async ({ canvasFilePath, out }) => {
      const jobs = [
        { nodeId: 'exact', url: 'https://www.example.test/jobs/acme-1/?utm_medium=y', ...FIXTURE_JOB },
        { nodeId: 'repost', url: 'https://example.test/jobs/acme-NEW', company: 'ACME  corp.', title: ' senior   ENGINEER ', location: 'Elsewhere' },
        { nodeId: 'different', url: 'https://example.test/jobs/acme-3', company: 'Acme Corp', title: 'Staff Engineer', location: 'Remote' },
      ];
      const result = await findSavedApplicationLinks({ canvasFilePath, jobs });
      assert.deepEqual(result.links.map(l => l.nodeId), ['exact']);
      assert.deepEqual(result.roleMatches.map(m => m.nodeId), ['repost']);
      const prior = result.roleMatches[0].priorRoleApplication;
      assert.equal(prior.savedDir, out);
      assert.equal(prior.appliedAt, FIXTURE_IMPORTED_AT);
      assert.equal(prior.company, FIXTURE_JOB.company);
      assert.equal(prior.title, FIXTURE_JOB.title);
      assert.equal(prior.location, FIXTURE_JOB.location);
      assert.equal(prior.listingUrl, 'https://example.test/jobs/acme-1');
      assert.equal(prior.id, '123e4567-e89b-42d3-a456-426614174888');
    });
  } },
  { name: 'loadAppliedListingKeys returns verified listing keys and an empty set without receipts', async run() {
    await withReceiptFixture(async ({ canvasFilePath }) => {
      const keys = await loadAppliedListingKeys(canvasFilePath);
      assert.ok(keys instanceof Set);
      assert.ok(keys.has(applicationListingKeys({ url: 'https://example.test/jobs/acme-1' })[0]));
      assert.equal(keys.size, 1);
    });
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ic-empty-')));
    try {
      const canvasFilePath = path.join(root, 'canvas.json');
      await fs.writeFile(canvasFilePath, '{}');
      const empty = await loadAppliedListingKeys(canvasFilePath);
      assert.ok(empty instanceof Set);
      assert.equal(empty.size, 0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  } },
];
