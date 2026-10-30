import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  buildPostingVariant, consolidateJobLocations, postingVariantKey,
} from '../../src/utils/jobLocationConsolidation.js';
import {
  formatOriginalJobListingMarkdown, normaliseJobPostingVariants,
} from '../../electron/ipc/applicationBundle.js';
import { buildResumeDocument } from '../../electron/ipc/resumeHtml.js';
import {
  __projectLocalApplicationJobForAcceptanceHarness as project,
  buildLocalGenerationAuditArtifact, queueLocalApplicationJob,
} from '../../electron/ipc/localAiApplication.js';
import { getPreparedOfficialPosting, prepareOfficialPostingForGeneration } from '../../electron/ipc/officialPostingGeneration.js';
import { LISTING_LIVENESS_RULES } from '../../electron/ipc/listingLiveness.js';
import { OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL } from '../../electron/ipc/officialPostingNegativePolicy.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';

const at = '2026-10-26T12:00:00.000Z';
const description = 'Synthetic engineering responsibilities and requirements. '.repeat(18);
const base = (extra = {}) => ({
  title: 'Synthetic Platform Engineer', company: 'Synthetic Systems Lab',
  location: 'Toronto', source: 'linkedin', sourceJobKey: 'synthetic-one',
  url: 'https://board.example.test/jobs/one', snippet: description,
  description, matchScore: 75, ...extra,
});
const closed = (extra = {}) => base({
  listingLiveness: { verdict: 'closed', basis: 'ai', board: 'linkedin', at },
  boardClosed: { board: 'linkedin', reason: 'ai-confirmed-closed', at }, ...extra,
});
const open = (extra = {}) => base({
  listingLiveness: { verdict: 'open', basis: 'ai', board: 'linkedin', at }, ...extra,
});
const resumeMainHtml = '<main class="page"><h1>Synthetic Candidate</h1><p>Relevant experience.</p></main>';

export default [
  { name: 'listing bundle deferred: selected link changes the companion and rendered link but not inert identity', run() {
    const original = 'https://www.linkedin.com/jobs/view/synthetic-original';
    const selected = 'https://www.indeed.com/viewjob?jk=synthetic-selected';
    const job = base({ url: original, listingLinkUrl: selected,
      listingAudit: { outcome: 'alternate', basis: 'open-marker', at } });
    const bundle = formatOriginalJobListingMarkdown(job, { audience: 'bundle' });
    const prompt = formatOriginalJobListingMarkdown(job, { audience: 'prompt' });
    assert.ok(bundle.includes(`**Listing URL:** <${selected}>`));
    assert.equal(bundle.includes(`**Listing URL:** <${original}>`), false);
    assert.ok(prompt.includes(`**Listing URL:** <${original}>`));
    const html = buildResumeDocument({ resumeMainHtml, docId: 'synthetic-selected-link',
      downloadBundle: { company: job.company, jobUrl: original, listingLinkUrl: selected,
        jobMarkdown: bundle, postingVariants: [] } });
    const dom = new JSDOM(html);
    try {
      const data = JSON.parse(dom.window.document.getElementById('ic-application-bundle-data').textContent);
      assert.equal(data.jobUrl, original);
      assert.equal(dom.window.document.querySelector('.ic-job-posting-link')?.href, selected);
    } finally { dom.window.close(); }
  } },
  { name: 'listing bundle deferred: selected alternate stays the primary rendered link beside multiple variants', run() {
    const original = 'https://www.linkedin.com/jobs/view/synthetic-original-multi';
    const selected = 'https://www.indeed.com/viewjob?jk=synthetic-selected-multi';
    const variants = [
      { location: 'Toronto', url: original },
      { location: 'Ottawa', url: 'https://www.linkedin.com/jobs/view/synthetic-variant-ottawa' },
    ];
    const job = base({ url: original, listingLinkUrl: selected, postingVariants: variants,
      listingAudit: { outcome: 'alternate', basis: 'open-marker', at } });
    const bundle = formatOriginalJobListingMarkdown(job, { audience: 'bundle' });
    assert.ok(bundle.includes(`**Listing URL:** <${selected}>`));
    const html = buildResumeDocument({ resumeMainHtml, docId: 'synthetic-selected-multi',
      downloadBundle: { company: job.company, jobUrl: original, listingLinkUrl: selected,
        jobMarkdown: bundle, postingVariants: variants } });
    const dom = new JSDOM(html);
    try {
      const links = [...dom.window.document.querySelectorAll('.ic-job-posting-link')].map(link => link.href);
      assert.equal(links[0], selected);
      assert.ok(links.includes(variants[1].url));
      const data = JSON.parse(dom.window.document.getElementById('ic-application-bundle-data').textContent);
      assert.equal(data.jobUrl, original); assert.equal(data.listingLinkUrl, selected);
    } finally { dom.window.close(); }
  } },
  { name: 'listing bundle deferred: a closed primary selects an open alternate without changing scraped identity', async run() {
    const alternateUrl = 'https://www.indeed.com/viewjob?jk=synthetic-alternate-open';
    const primary = closed({ url: 'https://www.linkedin.com/jobs/view/synthetic-primary-closed',
      alternateListings: [{ board: 'indeed', url: alternateUrl }] });
    const page = { requestedUrl: alternateUrl, finalUrl: alternateUrl, httpStatus: 200,
      board: 'indeed', ruleKey: 'indeed', finalHostClass: 'aggregator',
      title: primary.title, h1: primary.title, expectedTitle: primary.title,
      expectedCompany: primary.company, expectedLocation: primary.location,
      chromeText: `${primary.title} is hiring for a synthetic engineering role. Apply now for this role.`,
      descriptionText: description, descriptionIsPage: false, titleMatchesPage: true, redirectedAway: false,
      closedHits: [], openSignals: [{ ruleId: 'indeed-enabled-apply', state: 'active' }],
      jsonLd: { validThrough: '', isListed: null } };
    const visits = [];
    const prepared = await prepareOfficialPostingForGeneration({ job: primary }, {
      projectJob: project, store: { find: async () => null },
      resolve: async rows => ({ jobs: [{ ...rows[0], officialPosting: {
        level: 'L5', outcome: 'not-found', employer: primary.company, trail: ['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL],
      } }], telemetry: {} }),
      bridgeStatus: () => ({ enabled: true, link: { state: 'linked' } }),
      listingProbe: { probe: async url => { visits.push(url); return page; } },
      calibrationStore: { snapshot: async () => ({ rulesFor: key => ({ ...LISTING_LIVENESS_RULES[key],
        openRules: LISTING_LIVENESS_RULES[key].openRules.map(rule => ({ ...rule, state: 'active' })) }) }),
        latestDemotedAt: async () => null },
    });
    assert.deepEqual(visits, [alternateUrl]);
    assert.equal(prepared.listingCheck.action, 'proceed');
    assert.equal(prepared.listingLinkUrl, alternateUrl);
    const frozen = getPreparedOfficialPosting(prepared.resolutionId, project(primary));
    assert.equal(frozen.scrapedJob.url, primary.url);
    assert.equal(frozen.listingLinkUrl, alternateUrl);
    assert.equal(frozen.listingAudit.outcome, 'alternate');
  } },
  { name: 'listing bundle: confirmed-closed member token survives variant construction and rank beats richness', run() {
    const closedRow = closed({ location: 'Toronto', url: 'https://board.example.test/jobs/toronto', matchScore: 100 });
    const openRow = open({ location: 'Ottawa', url: 'https://board.example.test/jobs/ottawa', matchScore: 1 });
    const closedVariant = buildPostingVariant(closedRow);
    const openVariant = buildPostingVariant(openRow);
    assert.equal(closedVariant.liveness, 'closed');
    assert.equal(Object.hasOwn(openVariant, 'liveness'), false);
    assert.notEqual(postingVariantKey(closedVariant), postingVariantKey({ ...closedVariant, liveness: undefined }));
    const merged = consolidateJobLocations([closedRow, openRow]).jobs;
    assert.equal(merged.length, 1);
    assert.equal(merged[0].url, openRow.url, 'open representative must outrank a richer closed member');
    assert.equal(merged[0].postingVariants.find(variant => variant.url === closedRow.url)?.liveness, 'closed');
    assert.equal(Object.hasOwn(merged[0].postingVariants.find(variant => variant.url === openRow.url), 'liveness'), false);
    const protectedClosed = consolidateJobLocations([{ ...closedRow, localApplication: { id: 'synthetic-application' } }, openRow]).jobs;
    assert.equal(protectedClosed[0].url, closedRow.url, 'an application-linked card remains the representative');
  } },
  { name: 'listing bundle: pending markers and legacy-only rows cannot receive a closed variant or URL suffix', run() {
    const marker = { board: 'linkedin', reason: 'linkedin-no-longer-accepting', at };
    for (const row of [
      base({ boardClosed: marker, listingLiveness: { verdict: 'pending', basis: 'closed-marker', board: 'linkedin', at } }),
      base({ boardClosed: marker }),
    ]) {
      assert.equal(Object.hasOwn(buildPostingVariant(row), 'liveness'), false);
      const bundle = formatOriginalJobListingMarkdown(row, { audience: 'bundle' });
      assert.ok(bundle.includes(`**Listing URL:** <${row.url}>`));
      assert.equal(bundle.includes('(closed on LinkedIn)'), false);
    }
  } },
  { name: 'listing bundle: normalized variants retain only exact closed token and hide closed targets', run() {
    const variants = [
      { location: 'Toronto', url: 'https://board.example.test/jobs/toronto', liveness: 'closed' },
      { location: 'Ottawa', url: 'https://board.example.test/jobs/ottawa', liveness: 'open' },
      { location: 'Montreal', url: 'https://board.example.test/jobs/montreal', liveness: 'CLOSED' },
    ];
    const normalized = normaliseJobPostingVariants(variants);
    assert.equal(normalized[0].liveness, 'closed');
    assert.equal(Object.hasOwn(normalized[1], 'liveness'), false);
    assert.equal(Object.hasOwn(normalized[2], 'liveness'), false);
    const sameTarget = normaliseJobPostingVariants([
      { location: 'Toronto', url: 'https://board.example.test/jobs/one', liveness: 'closed' },
      { location: 'Toronto', url: 'https://board.example.test/jobs/one' },
    ]);
    assert.equal(sameTarget.length, 2, 'a later open copy must survive a stale closed duplicate');
    const job = closed({
      listingAudit: { outcome: 'official', basis: 'official', at },
      postingVariants: variants,
      officialPosting: { level: 'L2', outcome: 'found', employer: 'Synthetic Systems Lab',
        sourceUrl: 'https://careers.example.test/jobs/open' },
    });
    const prompt = formatOriginalJobListingMarkdown(job, { audience: 'prompt' });
    const bundle = formatOriginalJobListingMarkdown(job, { audience: 'bundle' });
    assert.equal(prompt.includes('**Listing check:**'), false);
    assert.equal(prompt.includes('(closed on LinkedIn)'), false);
    assert.ok(prompt.includes(`**Listing URL:** <${job.url}>`));
    assert.ok(bundle.includes(`**Listing URL:** <${job.url}> (closed on LinkedIn)`));
    assert.ok(bundle.includes('**Listing check:** Official posting found'));
    assert.equal(bundle.includes('**Toronto:** <https://board.example.test/jobs/toronto>'), false);
    assert.ok(bundle.includes('**Ottawa:** <https://board.example.test/jobs/ottawa>'));
    assert.ok(bundle.includes('**Montreal:** <https://board.example.test/jobs/montreal>'));
    const html = buildResumeDocument({
      resumeMainHtml, docId: 'synthetic-listing-bundle',
      downloadBundle: { company: job.company, jobUrl: job.url, jobMarkdown: bundle,
        officialPosting: job.officialPosting, postingVariants: variants },
    });
    const dom = new JSDOM(html);
    try {
      const links = [...dom.window.document.querySelectorAll('.ic-job-posting-link')].map(link => link.href);
      assert.ok(links.includes('https://careers.example.test/jobs/open'));
      assert.ok(links.includes('https://board.example.test/jobs/ottawa'));
      assert.ok(links.includes('https://board.example.test/jobs/montreal'));
      assert.equal(links.includes('https://board.example.test/jobs/toronto'), false);
      const data = JSON.parse(dom.window.document.getElementById('ic-application-bundle-data').textContent);
      assert.equal(data.jobUrl, job.url, 'the inert bundle retains the scraped URL as an audit value');
      assert.equal(data.postingVariants[0].liveness, 'closed');
    } finally { dom.window.close(); }
  } },
  { name: 'listing bundle: safeJob and generation audit carry only bounded audit facts', run() {
    const raw = base({ listingAudit: { outcome: 'open', basis: 'ai', at, extra: 'untrusted prose' },
      listingLiveness: { verdict: 'open', basis: 'ai', board: 'linkedin', at },
      postingVariants: [{ location: 'Toronto', url: 'https://board.example.test/jobs/one', liveness: 'closed' }] });
    const rejected = project(raw);
    assert.equal(rejected.listingAudit, undefined, 'extra keys invalidate an audit fact');
    const job = project({ ...raw, listingAudit: { outcome: 'open', basis: 'ai', at } });
    assert.deepEqual(job.listingAudit, { outcome: 'open', basis: 'ai', at });
    assert.equal(job.postingVariants[0].liveness, 'closed');
    const audit = JSON.parse(buildLocalGenerationAuditArtifact({ jobId: 'synthetic-job', input: { job } }));
    assert.deepEqual(audit.listingAudit, job.listingAudit);
    const unavailable = JSON.parse(buildLocalGenerationAuditArtifact({ jobId: 'synthetic-job', input: { job: base() } }));
    assert.deepEqual(unavailable.listingAudit, { outcome: 'unavailable' });
  } },
  { name: 'listing bundle: queue ignores renderer listing facts and uses the identity-bound prepare record', async run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'listing-liveness-bundle-'));
    const canvasFilePath = path.join(root, 'canvas.json');
    try {
      await fs.writeFile(canvasFilePath, '{}');
      const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
      const raw = base();
      const officialPosting = { level: 'L5', outcome: 'not-found', employer: raw.company,
        trail: ['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL] };
      const prepared = await prepareOfficialPostingForGeneration({ job: raw }, {
        projectJob: project, store: { find: async () => null },
        resolve: async rows => ({ jobs: [{ ...rows[0], officialPosting }], telemetry: {} }),
        bridgeStatus: () => ({ enabled: true, link: { state: 'linked' } }),
      });
      assert.ok(prepared.resolutionId);
      assert.equal(prepared.listingCheck?.action, 'proceed');
      assert.equal(prepared.listingCheck?.verdict, 'unobservable');
      const forged = {
        ...raw,
        listingAudit: { outcome: 'open', basis: 'ai', at },
        listingLiveness: { verdict: 'closed', basis: 'ai', board: 'linkedin', at },
        boardClosed: { board: 'linkedin', reason: 'ai-confirmed-closed', at },
      };
      const queued = await queueLocalApplicationJob({ canvasFilePath, transport: 'paste',
        careerSnapshotId, resolutionId: prepared.resolutionId, job: forged });
      const input = JSON.parse(await fs.readFile(path.join(queued.folder, 'input.json'), 'utf8'));
      assert.deepEqual(input.job.listingAudit, {
        outcome: 'unobservable', basis: 'unobservable', at: prepared.listingCheck.at,
      });
      assert.equal(input.job.listingLiveness, undefined);
      assert.equal(input.job.boardClosed, undefined);
      const noRecord = await queueLocalApplicationJob({ canvasFilePath, transport: 'paste', careerSnapshotId, job: forged });
      const fallback = JSON.parse(await fs.readFile(path.join(noRecord.folder, 'input.json'), 'utf8'));
      assert.deepEqual(fallback.job.listingAudit, { outcome: 'unavailable' });
      assert.equal(fallback.job.listingLiveness, undefined);
      assert.equal(fallback.job.boardClosed, undefined);

      const confirmed = closed({ sourceJobKey: 'synthetic-closed-official',
        url: 'https://www.linkedin.com/jobs/view/synthetic-closed-official' });
      const liveOfficial = { level: 'L4', outcome: 'link-only', employer: confirmed.company,
        sourceUrl: 'https://careers.example.test/jobs/synthetic-open-official',
        officialApplyUrl: 'https://careers.example.test/jobs/synthetic-open-official',
        trail: ['description-anchor'] };
      const preparedClosed = await prepareOfficialPostingForGeneration({ job: confirmed }, {
        projectJob: project, semanticMatching: false, store: { find: async () => null },
        resolve: async rows => ({ jobs: [{ ...rows[0], officialPosting: liveOfficial }], telemetry: {} }),
        bridgeStatus: () => ({ enabled: false }),
        listingProbe: { probe: async () => { throw new Error('official live must skip the listing probe'); } },
      });
      assert.equal(preparedClosed.listingCheck.action, 'proceed');
      assert.deepEqual(preparedClosed.listingLiveness, confirmed.listingLiveness);
      assert.deepEqual(preparedClosed.boardClosed, confirmed.boardClosed);
      const queuedClosed = await queueLocalApplicationJob({ canvasFilePath, transport: 'paste',
        careerSnapshotId, resolutionId: preparedClosed.resolutionId, job: confirmed });
      const frozen = JSON.parse(await fs.readFile(path.join(queuedClosed.folder, 'input.json'), 'utf8')).job;
      assert.deepEqual(frozen.listingLiveness, confirmed.listingLiveness);
      assert.deepEqual(frozen.boardClosed, confirmed.boardClosed);
      assert.equal(frozen.listingAudit.outcome, 'official');
      assert.ok(formatOriginalJobListingMarkdown(frozen, { audience: 'bundle' })
        .includes(`**Listing URL:** <${confirmed.url}> (closed on LinkedIn)`));
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  } },
  { name: 'listing bundle deferred: queue freezes the prepared alternate link and rejects renderer link and variant forgeries', async run() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'synthetic-selected-queue-'));
    const canvasFilePath = path.join(root, 'canvas.json');
    try {
      await fs.writeFile(canvasFilePath, '{}');
      const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
      const original = 'https://www.linkedin.com/jobs/view/synthetic-primary-closed';
      const selected = 'https://www.indeed.com/viewjob?jk=synthetic-selected-open';
      const injected = 'https://www.dice.com/job-detail/synthetic-renderer-forged';
      const variants = [{ location: 'Toronto', url: original },
        { location: 'Ottawa', url: 'https://www.linkedin.com/jobs/view/synthetic-ottawa' }];
      const primary = closed({ url: original, sourceJobKey: 'synthetic-closed-with-alternate',
        alternateListings: [{ board: 'indeed', url: selected }], postingVariants: variants });
      const page = { requestedUrl: selected, finalUrl: selected, httpStatus: 200,
        board: 'indeed', ruleKey: 'indeed', finalHostClass: 'aggregator',
        title: primary.title, h1: primary.title, expectedTitle: primary.title,
        expectedCompany: primary.company, expectedLocation: primary.location,
        chromeText: `${primary.title} is hiring for a synthetic engineering role. Apply now for this role.`,
        descriptionText: description, descriptionIsPage: false, titleMatchesPage: true, redirectedAway: false,
        closedHits: [], openSignals: [{ ruleId: 'indeed-enabled-apply', state: 'active' }],
        jsonLd: { validThrough: '', isListed: null } };
      const prepared = await prepareOfficialPostingForGeneration({ job: primary }, {
        projectJob: project, store: { find: async () => null },
        resolve: async rows => ({ jobs: [{ ...rows[0], officialPosting: {
          level: 'L5', outcome: 'not-found', employer: primary.company, trail: ['bridge-research', OFFICIAL_POSTING_NEGATIVE_PROOF_TRAIL],
        } }], telemetry: {} }),
        bridgeStatus: () => ({ enabled: true, link: { state: 'linked' } }),
        listingProbe: { probe: async () => page },
        calibrationStore: { snapshot: async () => ({ rulesFor: key => ({ ...LISTING_LIVENESS_RULES[key],
          openRules: LISTING_LIVENESS_RULES[key].openRules.map(rule => ({ ...rule, state: 'active' })) }) }),
        latestDemotedAt: async () => null },
      });
      assert.equal(prepared.listingLinkUrl, selected);
      const renderer = { ...primary, listingLinkUrl: injected,
        alternateListings: [{ board: 'dice', url: injected }] };
      const queued = await queueLocalApplicationJob({ canvasFilePath, transport: 'paste', careerSnapshotId,
        resolutionId: prepared.resolutionId, job: renderer });
      const frozen = JSON.parse(await fs.readFile(path.join(queued.folder, 'input.json'), 'utf8')).job;
      assert.equal(frozen.url, original);
      assert.equal(frozen.listingLinkUrl, selected);
      assert.deepEqual(frozen.alternateListings, primary.alternateListings);
      assert.deepEqual(frozen.postingVariants, normaliseJobPostingVariants(variants));
      const bundle = formatOriginalJobListingMarkdown(frozen, { audience: 'bundle' });
      assert.ok(bundle.includes(`**Listing URL:** <${selected}>`));
      assert.equal(bundle.includes(`**Listing URL:** <${injected}>`), false);
      const source = await fs.readFile(new URL('../../electron/ipc/localAiApplication.js', import.meta.url), 'utf8');
      assert.match(source, /listingLinkUrl: input\.job\?\.listingLinkUrl/u,
        'the actual application output must pass the selected link to the inert HTML bundle');

      const forgedVariant = { ...renderer, postingVariants: [
        ...variants, { location: 'Montreal', url: injected },
      ] };
      assert.equal(getPreparedOfficialPosting(prepared.resolutionId, project(forgedVariant)), null,
        'a changed variant must fail the exact prepared alias identity check');
      await assert.rejects(queueLocalApplicationJob({ canvasFilePath, transport: 'paste', careerSnapshotId,
        resolutionId: prepared.resolutionId, job: forgedVariant }), error => error.code === 'OFFICIAL_POSTING_LOOKUP_INCOMPLETE',
      'a changed variant must require fresh preparation instead of silently accepting an unprepared fallback');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  } },
];
