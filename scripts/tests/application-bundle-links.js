import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { findSavedApplicationLinks } from '../../electron/ipc/localAiApplication.js';
import { applicationListingKeys, selectSavedApplicationBundle } from '../../src/utils/applicationBundleIdentity.js';

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
      const audit = { jobId, finalArtifacts: { resultSha256: receipt.resultSha256, originalJobListingSha256: hash } };
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
];
