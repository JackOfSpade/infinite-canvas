import { generateMarkdown } from '../../electron/ipc/bugReport.js';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import * as localAiFallback from '../../src/utils/localAiFallback.js';
import { readFileSync } from 'node:fs';
import { appliedRemovalToast, jobCardHasApplicationWorkInFlight, shouldRemoveCardFoundAfterApplication } from '../../src/utils/applicationLinkRemoval.js';
import { claimRunningApplicationDocument, clearRunningApplicationDocument } from '../../src/utils/applicationDocumentRuns.js';
import { beginOfficialPostingPreparation } from '../../src/utils/officialPostingPreparation.js';
import { mergeCarriedJobs } from '../../src/utils/jobSearchCarriedResults.js';
import { consolidateJobLocations } from '../../src/utils/jobLocationConsolidation.js';
import { moduleFingerprint, unionScoredJobs } from '../../src/nodes/jobboard/mergeJobs.js';
import { buildJobTreeNodes } from '../../src/nodes/jobsearch/buildJobTree.js';
import { planJobCardDeletionCleanup } from '../../src/utils/jobCardDeletionCleanup.js';
import { deepRemoveNodes, filterEdgesForRemovedNodes, removeNodesFromActiveLevel, removeNodesFromStack } from '../../src/utils/navigationUtils.js';
import { findSavedApplicationLinks, loadAppliedListingKeys } from '../../electron/ipc/localAiApplication.js';
import {
  appliedCheckTime, applicationListingKeys, applicationRoleKey, earliestAppliedCheckAt, foldAppliedCheckInto, filterAppliedListings, selectSavedApplicationBundle,
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
  { name: 'a verified employer posting identifies the job across boards, and nothing weaker does', run() {
    const official = (extra = {}) => ({ level: 'L2', outcome: 'found', sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', ...extra });
    const key = 'https://job-boards.greenhouse.io/acme/jobs/123';
    const onGoogle = applicationListingKeys({ googleCardUrl: 'https://www.google.com/search?udm=8&htidocid=AbC123', officialPosting: official() });
    const onLinkedIn = applicationListingKeys({ url: 'https://ca.linkedin.com/jobs/view/eng-at-acme-1', officialPosting: official({ sourceUrl: `${key}?gh_jid=123&gh_src=xyz` }) });
    assert.ok(onGoogle.includes(key) && onGoogle.includes('google-job:AbC123'));
    assert.ok(onLinkedIn.includes(key) && onLinkedIn.includes(`${key}?gh_jid=123&gh_src=xyz`));
    assert.deepEqual(filterAppliedListings([{ url: 'https://ca.linkedin.com/jobs/view/eng-at-acme-1', officialPosting: official() }], new Set(onGoogle)).removed, 1);
    // A sibling requisition, an unverified lead, a miss and a malformed record add no key.
    assert.ok(!applicationListingKeys({ officialPosting: official({ sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/124?gh_jid=124' }) }).includes(key));
    for (const officialPosting of [official({ level: 'L5' }), official({ outcome: 'not-found' }), official({ outcome: 'closed' }),
      official({ sourceUrl: 'http://job-boards.greenhouse.io/acme/jobs/123' }), official({ sourceUrl: 'not a url' }), [official()], 'x', null]) {
      assert.deepEqual(applicationListingKeys({ officialPosting }), [], JSON.stringify(officialPosting));
    }
    assert.deepEqual(applicationListingKeys({ officialPosting: official({ outcome: 'link-only', sourceUrl: '', officialApplyUrl: `${key}/` }) }), [key]);
    // A parameter that carries the id on a shared path is identity and stays.
    assert.deepEqual(applicationListingKeys({ officialPosting: official({ sourceUrl: 'https://acme.test/careers/job?reqId=77' }) }), ['https://acme.test/careers/job?reqId=77']);
  } },
  { name: 'a bundle saved before official keys existed is matched through its saved listing header', async run() {
    await withReceiptFixture(async ({ canvasFilePath, out }) => {
      const official = 'https://job-boards.greenhouse.io/acme/jobs/123';
      const card = { nodeId: 'other-board', url: 'https://ca.linkedin.com/jobs/view/eng-at-acme-9', ...FIXTURE_JOB,
        officialPosting: { level: 'L2', outcome: 'found', sourceUrl: `${official}?gh_jid=123` } };
      const sibling = { ...card, nodeId: 'sibling', officialPosting: { level: 'L2', outcome: 'found', sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/124' } };
      const save = async (listing, hashed = listing) => {
        const auditPath = path.join(out, 'Generation Audit.json');
        const audit = JSON.parse(await fs.readFile(auditPath, 'utf8'));
        audit.finalArtifacts.originalJobListingSha256 = crypto.createHash('sha256').update(hashed).digest('hex');
        await fs.writeFile(auditPath, JSON.stringify(audit));
        await fs.writeFile(path.join(out, 'Original Job Listing.md'), listing);
      };
      const listing = check => `# Senior Engineer\n\n**Company:** Acme Corp\n**Official posting:** <${official}>\n**Official posting check:** ${check}\n\n---\n\nBody\n**Official posting:** <https://job-boards.greenhouse.io/acme/jobs/124>\n`;
      // No listing file: the bundle still loads and the card is only a repost.
      let result = await findSavedApplicationLinks({ canvasFilePath, jobs: [card, sibling] });
      assert.deepEqual([result.links.length, result.roleMatches.map(m => m.nodeId)], [0, ['other-board', 'sibling']]);
      await save(listing('Exact official posting verified'));
      result = await findSavedApplicationLinks({ canvasFilePath, jobs: [card, sibling] });
      assert.deepEqual(result.links.map(l => l.nodeId), ['other-board']);
      assert.equal(result.links[0].localApplication.savedDir, out);
      assert.deepEqual(result.roleMatches.map(m => m.nodeId), ['sibling']);
      assert.ok((await loadAppliedListingKeys(canvasFilePath)).has(official));
      // An unverified header, or bytes the audit does not bind, name nothing.
      await save(listing('No exact official posting found'));
      assert.equal((await findSavedApplicationLinks({ canvasFilePath, jobs: [card] })).links.length, 0);
      await save(listing('Exact official posting verified'), 'other bytes');
      assert.equal((await findSavedApplicationLinks({ canvasFilePath, jobs: [card] })).links.length, 0);
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
  { name: 'a card whose row passed the applied check after its bundle was saved is removable; unstamped, earlier and locked are not', run() {
    const saved = Date.parse(FIXTURE_IMPORTED_AT);
    const at = ms => new Date(ms).toISOString();
    const bundle = { id: 'b', status: 'saved', receipt: { importedAt: FIXTURE_IMPORTED_AT } };
    const board = (extra = {}) => ({ id: 'board', type: 'jobboard', data: { ...extra } });
    const card = (extra = {}) => ({ id: 'c', type: 'jobcard', data: { hubId: 'board', originHubId: 'late', appliedCheckAt: at(saved + 60_000), ...extra } });
    const lookup = (...nodes) => id => nodes.find(node => node.id === id) || null;
    assert.equal(shouldRemoveCardFoundAfterApplication(card(), bundle, lookup(board())), true);
    // Checked before or exactly at the save: the card may have been shown before it.
    assert.equal(shouldRemoveCardFoundAfterApplication(card({ appliedCheckAt: at(saved - 1) }), bundle, lookup(board())), false);
    assert.equal(shouldRemoveCardFoundAfterApplication(card({ appliedCheckAt: at(saved) }), bundle, lookup(board())), false, 'strictly later only');
    // Unstamped (every older row) or unparsable stamps keep the X.
    assert.equal(shouldRemoveCardFoundAfterApplication(card({ appliedCheckAt: undefined }), bundle, lookup(board())), false);
    assert.equal(shouldRemoveCardFoundAfterApplication(card({ appliedCheckAt: 'not a date' }), bundle, lookup(board())), false);
    assert.equal(shouldRemoveCardFoundAfterApplication(card(), { ...bundle, receipt: {} }, lookup(board())), false);
    assert.equal(shouldRemoveCardFoundAfterApplication(card(), { ...bundle, receipt: { importedAt: 'not a date' } }, lookup(board())), false);
    // Locks and an existing bundle keep the X path (work in flight is deferred by the caller).
    assert.equal(shouldRemoveCardFoundAfterApplication(card({ locked: true }), bundle, lookup(board())), false);
    assert.equal(shouldRemoveCardFoundAfterApplication(card(), bundle, lookup(board({ locked: true }))), false);
    assert.equal(shouldRemoveCardFoundAfterApplication(card({ localApplication: { id: 'x' } }), bundle, lookup(board())), false);
  } },
  { name: 'Generate in flight is read from the card claim, its posting preparation, its Board refresh and the run queue', run() {
    const card = { id: 'busy-card', type: 'jobcard', data: { hubId: 'busy-board' } };
    const file = '/project/canvas.json';
    assert.equal(jobCardHasApplicationWorkInFlight(card, { canvasFilePath: file, queueSnapshot: { active: null, queued: [], activeRuns: [] } }), false);
    assert.ok(claimRunningApplicationDocument('busy-card', 'both'));
    try { assert.equal(jobCardHasApplicationWorkInFlight(card, { canvasFilePath: file }), true); }
    finally { clearRunningApplicationDocument('busy-card'); }
    for (const nodeId of ['busy-card', 'busy-board']) {
      const preparation = beginOfficialPostingPreparation({ canvasFilePath: file, nodeId, cancel() {} });
      try {
        assert.equal(jobCardHasApplicationWorkInFlight(card, { canvasFilePath: file }), true, nodeId);
        assert.equal(jobCardHasApplicationWorkInFlight(card, { canvasFilePath: '/other.json' }), false, 'claims are per canvas');
      } finally { preparation.finish(); }
    }
    assert.equal(jobCardHasApplicationWorkInFlight(card, { queueSnapshot: { activeRuns: [{ nodeId: 'busy-card', lane: 'application' }], queued: [] } }), true);
    assert.equal(jobCardHasApplicationWorkInFlight(card, { queueSnapshot: { activeRuns: [], queued: [{ nodeId: 'busy-card', lane: 'application' }] } }), true);
    assert.equal(jobCardHasApplicationWorkInFlight(card, { queueSnapshot: { activeRuns: [{ nodeId: 'other' }], queued: [{ nodeId: 'other' }] } }), false);
  } },
  { name: 'the removal toast names up to three jobs, then counts the rest', run() {
    const named = (company, title) => ({ data: { company, title } });
    assert.equal(appliedRemovalToast([]), null);
    assert.deepEqual(appliedRemovalToast([named('Intouch Insight', 'Software Developer')]), {
      title: 'Already applied', type: 'info',
      description: 'Removed 1 job you already applied to: Intouch Insight — Software Developer',
    });
    const many = appliedRemovalToast([named('A', 'One'), named('B', 'Two'), named('', 'Three'), named('D', 'Four'), named('E', 'Five')]);
    assert.equal(many.description, 'Removed 5 jobs you already applied to: A — One; B — Two; Three; +2 more');
  } },
  { name: 'filterAppliedListings stamps every kept row with one check time and keeps an earlier stamp', run() {
    const applied = new Set(applicationListingKeys({ url: 'https://example.test/jobs/acme-1' }));
    const earlier = '2024-01-01T00:00:00.000Z';
    const rows = [
      { url: 'https://example.test/jobs/acme-1' },
      { url: 'https://example.test/jobs/acme-2' },
      { url: 'https://example.test/jobs/acme-3', appliedCheckAt: earlier },
      { url: 'https://example.test/jobs/acme-4', appliedCheckAt: '2030-01-01T00:00:00.000Z' },
    ];
    const checkedAt = '2024-06-01T00:00:00.000Z';
    const result = filterAppliedListings(rows, applied, { checkedAt });
    assert.equal(result.removed, 1);
    assert.equal(rows[0].appliedCheckAt, undefined, 'a dropped row is not stamped');
    assert.equal(result.kept[0], rows[1], 'kept rows keep their identity');
    assert.deepEqual(result.kept.map(row => row.appliedCheckAt), [checkedAt, earlier, checkedAt]);
    // No saved bundles is still a check; the default time is the call time.
    const before = Date.now();
    const [fresh] = filterAppliedListings([{ url: 'https://example.test/jobs/x' }], new Set()).kept;
    assert.ok(appliedCheckTime(fresh) >= before - 1 && appliedCheckTime(fresh) <= Date.now());
    assert.equal(earliestAppliedCheckAt([{ appliedCheckAt: checkedAt }, { appliedCheckAt: earlier }]), earlier);
    assert.equal(earliestAppliedCheckAt([{ appliedCheckAt: checkedAt }, {}]), null, 'missing on any => missing');
    assert.equal(earliestAppliedCheckAt([]), null);
    // Board research's official-duplicate drop folds the dropped row's check into the kept row, in place.
    const winner = { appliedCheckAt: checkedAt };
    assert.equal(foldAppliedCheckInto(winner, [winner, { appliedCheckAt: earlier }]), winner);
    assert.equal(winner.appliedCheckAt, earlier);
    foldAppliedCheckInto(winner, [winner, {}]);
    assert.ok(!Object.hasOwn(winner, 'appliedCheckAt'), 'an unstamped duplicate leaves the kept row unstamped');
  } },
  { name: 'every search filter site stamps through the shared filterAppliedListings', async run() {
    const sites = { 'electron/ipc/jobs/searchHandlers.js': 2, 'electron/ipc/jobs/recoveryHandlers.js': 3 };
    for (const [file, count] of Object.entries(sites)) {
      const source = await fs.readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert.equal(source.match(/filterAppliedListings\(/g)?.length, count, file);
      assert.ok(!source.includes('appliedCheckAt'), `${file} must not stamp on its own`);
    }
  } },
  { name: 'a re-scan keeps the original stamp of a carried row, and a re-found listing never looks newer', run() {
    const old = '2024-04-01T00:00:00.000Z';
    const fresh = '2024-06-01T00:00:00.000Z';
    const row = (id, extra = {}) => ({ source: 'indeed', title: `Engineer ${id}`, company: 'Acme', location: 'Ottawa, ON',
      url: `https://ca.indeed.com/viewjob?jk=${id}`, jobkey: id, ...extra });
    const carried = [row('a', { appliedCheckAt: old }), row('b', { appliedCheckAt: old }), row('c')];
    const scanned = [row('a', { appliedCheckAt: fresh }), row('c', { appliedCheckAt: fresh }), row('d', { appliedCheckAt: fresh })];
    const merged = mergeCarriedJobs(scanned, carried);
    const byKey = new Map(merged.map(job => [job.jobkey, job]));
    assert.deepEqual([...byKey.keys()].sort(), ['a', 'b', 'c', 'd']);
    assert.equal(byKey.get('a').appliedCheckAt, old, 'the re-found listing keeps the earlier stamp');
    assert.equal(byKey.get('b'), carried[1], 'a carried row is kept as is');
    assert.equal(byKey.get('c').appliedCheckAt, undefined, 'an unstamped carried copy leaves the merged row unstamped');
    assert.equal(byKey.get('d'), scanned[2], 'a new listing keeps its own stamp and identity');
    assert.equal(scanned[0].appliedCheckAt, fresh, 'the new rows are not mutated');
    assert.equal(mergeCarriedJobs(scanned, []), scanned);
  } },
  { name: 'location consolidation and the Board union keep the earliest stamp, and none when any copy lacks one', run() {
    const description = Array.from({ length: 120 }, (_, i) => `responsibility${i} builds reliable services`).join(' ');
    const posting = (location, extra = {}) => ({ title: 'Platform Engineer', company: 'Acme', location, description,
      source: 'indeed', url: `https://ca.indeed.com/viewjob?jk=${encodeURIComponent(location)}`, matchScore: 80, ...extra });
    const early = '2024-05-02T00:00:00.000Z';
    const late = '2024-05-03T00:00:00.000Z';
    const both = consolidateJobLocations([posting('Ottawa, ON', { appliedCheckAt: late }), posting('Toronto, ON', { appliedCheckAt: early })]);
    assert.equal(both.jobs.length, 1, 'the fixture consolidates');
    assert.equal(both.jobs[0].appliedCheckAt, early);
    const partial = consolidateJobLocations([posting('Ottawa, ON', { appliedCheckAt: late }), posting('Toronto, ON')]);
    assert.equal(partial.jobs.length, 1);
    assert.ok(!Object.hasOwn(partial.jobs[0], 'appliedCheckAt'));
    const url = 'https://example.test/jobs/1';
    const union = unionScoredJobs([[{ title: 'T', company: 'C', url, matchScore: 90, appliedCheckAt: late }], [{ title: 'T', company: 'C', url, matchScore: 70, appliedCheckAt: early }]]);
    assert.equal(union.length, 1);
    assert.equal(union[0].matchScore, 90);
    assert.equal(union[0].appliedCheckAt, early);
    const unstamped = unionScoredJobs([[{ title: 'T', company: 'C', url, matchScore: 90, appliedCheckAt: late }], [{ title: 'T', company: 'C', url, matchScore: 70 }]]);
    assert.ok(!Object.hasOwn(unstamped[0], 'appliedCheckAt'));
    const single = { title: 'S', company: 'C', url: 'https://example.test/jobs/2', appliedCheckAt: late };
    assert.equal(unionScoredJobs([[single]])[0], single, 'a row without collisions keeps its identity');
    assert.equal(moduleFingerprint([single]), moduleFingerprint([{ ...single, appliedCheckAt: early }]), 'the stamp never makes a Board stale');
  } },
  { name: 'a Board Combine card carries its row stamp in its data', run() {
    const build = job => buildJobTreeNodes({
      displayedJobs: [job],
      bucketTree: {
        roles: [{ name: 'Platform Engineering', jobIndices: [0] }],
        likelihoodBands: [{ label: 'Strong (70-100%)', minScore: 70, maxScore: 100 }],
        salaryRanges: [{ label: '$120k+', minSalary: 120000, maxSalary: null }],
      },
      originalPos: { x: 0, y: 0 }, hubId: 'board', baseNodeId: 'b',
    }).newNodes.find(node => node.type === 'jobcard');
    const job = { title: 'T', company: 'C', url: 'https://example.test/jobs/1', matchScore: 80, salary: '$130,000', originHubId: 'search' };
    assert.equal(build({ ...job, appliedCheckAt: '2024-05-02T00:00:00.000Z' }).data.appliedCheckAt, '2024-05-02T00:00:00.000Z');
    assert.equal(build(job).data.appliedCheckAt, undefined);
  } },
  { name: 'saved bundle links carry the receipt save time the removal rule compares against', async run() {
    await withReceiptFixture(async ({ canvasFilePath }) => {
      const result = await findSavedApplicationLinks({ canvasFilePath, jobs: [{ nodeId: 'n', url: 'https://example.test/jobs/acme-1', ...FIXTURE_JOB }] });
      assert.equal(result.links[0]?.localApplication?.receipt?.importedAt, FIXTURE_IMPORTED_AT);
    });
  } },
  { name: 'global node removal reaches nested canvases, drops their edges and reflows only levels that lost nodes', run() {
    const ids = new Set(['gone']);
    const untouched = [{ id: 'a', data: {} }];
    assert.equal(deepRemoveNodes(untouched, ids).nodes, untouched, 'identity kept when nothing matches');
    const group = { id: 'g', type: 'group', data: { canvasData: { nodes: [{ id: 'gone' }, { id: 'stay' }], edges: [{ source: 'stay', target: 'gone' }, { source: 'stay', target: 'x' }] } } };
    const reflowed = [];
    const result = deepRemoveNodes([{ id: 'root' }, group], ids, (remaining, removed) => {
      reflowed.push([remaining.map(n => n.id), removed.map(n => n.id)]);
      return remaining.map(n => ({ ...n, reflowed: true }));
    });
    assert.equal(result.updated, true);
    assert.deepEqual(reflowed, [[['stay'], ['gone']]]);
    const inner = result.nodes[1].data.canvasData;
    assert.deepEqual(inner.nodes, [{ id: 'stay', reflowed: true }]);
    assert.deepEqual(inner.edges, [{ source: 'stay', target: 'x' }]);
    const edges = [{ source: 'a', target: 'b' }];
    assert.equal(filterEdgesForRemovedNodes(edges, ids), edges);
    assert.deepEqual(filterEdgesForRemovedNodes([...edges, { source: 'gone', target: 'a' }], ids), edges);
  } },
  { name: 'the removal setters drop the cards from the active level, every stack level and their edges, reflowing each level once', run() {
    const ids = new Set(['gone']);
    const reflowCalls = [];
    const reflow = (remaining, removed) => {
      reflowCalls.push(removed.map(n => n.id));
      return remaining.map(n => ({ ...n, reflowed: true }));
    };
    const active = [{ id: 'a' }, { id: 'gone' }];
    assert.deepEqual(removeNodesFromActiveLevel(active, ids, reflow), [{ id: 'a', reflowed: true }]);
    const untouchedActive = [{ id: 'a' }];
    assert.equal(removeNodesFromActiveLevel(untouchedActive, ids, reflow), untouchedActive);
    const untouchedLevel = { nodes: [{ id: 'x' }], edges: [{ source: 'x', target: 'y' }] };
    const parentLevel = {
      nodes: [{ id: 'g', type: 'group', data: { canvasData: { nodes: [{ id: 'gone' }, { id: 'kid' }], edges: [{ source: 'kid', target: 'gone' }] } } }],
      edges: [{ source: 'g', target: 'gone' }, { source: 'g', target: 'x' }],
      viewport: { zoom: 1 },
    };
    const stack = [untouchedLevel, parentLevel];
    const next = removeNodesFromStack(stack, ids, reflow);
    assert.notEqual(next, stack);
    assert.equal(next[0], untouchedLevel, 'an untouched level keeps its identity');
    assert.deepEqual(next[1].edges, [{ source: 'g', target: 'x' }]);
    assert.deepEqual(next[1].viewport, { zoom: 1 });
    assert.deepEqual(next[1].nodes[0].data.canvasData, { nodes: [{ id: 'kid', reflowed: true }], edges: [] });
    assert.equal(removeNodesFromStack(next, ids, reflow), next, 'a second removal changes nothing');
    assert.equal(removeNodesFromStack(stack, new Set(), reflow), stack);
    // An edge-only reference still rewrites the level.
    const edgeOnly = [{ nodes: [{ id: 'k' }], edges: [{ source: 'k', target: 'gone' }] }];
    assert.deepEqual(removeNodesFromStack(edgeOnly, ids)[0].edges, []);
    const source = readFileSync(new URL('../../src/hooks/useCanvasNavigation.js', import.meta.url), 'utf8');
    const body = source.slice(source.indexOf('const removeNodesGlobally = useCallback'), source.indexOf('}, [setNodes, setEdges, canMutateCanvas, setStackGuarded]);'));
    assert.ok(body.includes('setNodes(prev => removeNodesFromActiveLevel(prev, ids, reflowLevel));'));
    assert.ok(body.includes('setEdges(prev => filterEdgesForRemovedNodes(prev, ids));'));
    assert.ok(body.includes('setStackGuarded(prevStack => removeNodesFromStack(prevStack, ids, reflowLevel));'));
  } },
  { name: 'the restore tick removes a late-found applied repost like a dismissal, toasts it once, defers busy cards, and keeps the X otherwise', async run() {
    const source = await fs.readFile(new URL('../../src/hooks/useLocalAiFallbackManager.js', import.meta.url), 'utf8');
    const start = source.indexOf('export function useLocalAiFallbackManager(');
    assert.ok(start >= 0);
    const saved = Date.parse(FIXTURE_IMPORTED_AT);
    const after = new Date(saved + 60_000).toISOString();
    const before = new Date(saved - 60_000).toISOString();
    const official = { level: 'L2', outcome: 'found', sourceUrl: 'https://acme.bamboohr.com/careers/142' };
    const card = (id, appliedCheckAt, extra = {}) => ({ id, type: 'jobcard', position: { x: 0, y: 0 },
      data: { hubId: 'board', originHubId: 'search', url: `https://jooble.test/${id}`, officialPosting: official, appliedCheckAt, ...FIXTURE_JOB, ...extra } });
    let nodes = [
      { id: 'board', type: 'jobboard', data: {} },
      { id: 'search', type: 'jobhub', data: { jobRunId: `search-${saved + 120_000}` } },
      card('repost', after),
      // Same current search run, but the row was checked before the save
      // (carried into the re-scan): shown before the application, keeps the X.
      card('carried', before),
      card('unstamped', undefined),
      card('locked', after, { locked: true }),
      card('generating', after),
      card('queued', after),
      { id: 'unmatched', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'board', url: 'https://jooble.test/other', title: 'Other', company: 'Elsewhere', appliedCheckAt: after } },
    ];
    const boardWrites = [];
    const cancelled = [];
    const logs = [];
    const toasts = [];
    let nudges = 0;
    let lookups = 0;
    const navigation = {
      enumerateAllNodes: () => nodes,
      updateNodeDataGlobally(id, patch) {
        nodes = nodes.map(node => {
          if (node.id !== id) return node;
          const next = typeof patch === 'function' ? patch(node) : patch;
          if (next && node.type === 'jobboard') boardWrites.push(next);
          return next ? { ...node, data: { ...node.data, ...next } } : node;
        });
      },
      removeNodesGlobally(ids, reflow) { nodes = removeNodesFromActiveLevel(nodes, new Set(ids), reflow); return true; },
    };
    const localApplication = { id: 'bundle', status: 'saved', savedDir: '/x', receipt: { importedAt: FIXTURE_IMPORTED_AT } };
    let tick;
    const refs = [];
    const effects = [];
    const queueSnapshot = { active: null, activeRuns: [], queued: [{ nodeId: 'queued', lane: 'application' }] };
    assert.ok(claimRunningApplicationDocument('generating', 'both'));
    const hook = runInNewContext(`(${source.slice(start).replace('export function', 'function')})`, {
      ...localAiFallback,
      applicationListingKeys, shouldRemoveCardFoundAfterApplication, planJobCardDeletionCleanup,
      jobCardHasApplicationWorkInFlight, appliedRemovalToast,
      LOCAL_AI_RETRY_NOTICE_INTERVAL_MS: 30_000,
      useRef: value => { const ref = { current: value }; refs.push(ref); return ref; },
      useEffect: effect => effects.push(effect),
      useModuleRunQueue: () => ({ cancelQueuedRunsForNode: (id) => cancelled.push(id), getSnapshot: () => queueSnapshot }),
      window: { electronAPI: {
        getLocalApplicationStatus: async () => ({ success: false }), importLocalApplication: async () => ({ success: false }),
        findSavedApplicationLinks: async ({ jobs }) => {
          lookups++;
          return { success: true, links: jobs.filter(job => job.nodeId !== 'unmatched').map(job => ({ nodeId: job.nodeId, localApplication })), roleMatches: [] };
        },
      }, setInterval: callback => { tick = callback; return 1; }, clearInterval() {} },
      EventLogger: { log: line => logs.push(line) },
      requestApplicationHandoffRefresh() {},
      Date,
    });
    hook({ navigation, getCurrentFile: () => '/project/canvas.json', addToast: toast => toasts.push(toast), nudgePersistence: () => { nudges++; } });
    const cleanups = effects.map(effect => effect());
    try {
      for (let i = 0; i < 30 && !logs.some(line => line.includes('restored saved bundle pointers')); i++) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(nodes.filter(n => n.type === 'jobcard').map(n => [n.id, n.data.localApplication?.id || null]), [
        ['carried', 'bundle'], ['unstamped', 'bundle'], ['locked', 'bundle'], ['generating', null], ['queued', null], ['unmatched', null],
      ], 'the late-found idle repost is removed; busy ones wait with no X; the rest keep the X');
      assert.deepEqual(cancelled, ['repost']);
      assert.ok(logs.includes('[ApplicationLinks] removed 1 cards found after their application was saved boards=1'), logs.join('\n'));
      assert.deepEqual(toasts, [{ title: 'Already applied', type: 'info', description: 'Removed 1 job you already applied to: Acme Corp — Senior Engineer' }]);
      assert.equal(boardWrites.length, 1, 'the Board stats are rewritten once, like a dismissal');
      assert.ok(nudges >= 1);
      const settle = async () => { await tick?.(); for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
      // While work is in flight the deferred cards are looked up again each tick and still not decided.
      let lookupsBefore = lookups;
      await settle();
      assert.equal(lookups, lookupsBefore + 1, 'a deferred card keeps the inventory unsettled');
      assert.deepEqual(nodes.filter(n => ['generating', 'queued'].includes(n.id)).map(n => n.data.localApplication || null), [null, null]);
      // Once the claims are released the next tick removes them, in one toast.
      clearRunningApplicationDocument('generating');
      queueSnapshot.queued = [];
      await settle();
      assert.deepEqual(nodes.filter(n => n.type === 'jobcard').map(n => n.id), ['carried', 'unstamped', 'locked', 'unmatched']);
      assert.equal(toasts.length, 2);
      assert.match(toasts[1].description, /^Removed 2 jobs you already applied to: /);
      // With the unmatched card still present, the inventory settles: no further lookup.
      lookupsBefore = lookups;
      await settle();
      assert.equal(lookups, lookupsBefore, 'the restored inventory signature settles after the removal');
      // The removed card rebuilt under the same id (undo or a later Combine) is
      // looked up and removed again, without naming the same job twice.
      nodes = [...nodes, card('repost', after)];
      await settle();
      assert.equal(lookups, lookupsBefore + 1, 'a restored card is looked up again');
      assert.ok(!nodes.some(n => n.id === 'repost'));
      assert.equal(toasts.length, 2, 'a job is named in a toast once per session');
    } finally {
      clearRunningApplicationDocument('generating');
      cleanups.forEach(cleanup => cleanup?.());
    }
  } },
];
