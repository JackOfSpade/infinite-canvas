import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  EBAY_ACTIVE_EXTRACTOR,
  EBAY_SOLD_EXTRACTOR,
  MERCARI_SOLD_EXTRACTOR,
  POSHMARK_SOLD_EXTRACTOR,
  SWAPPA_SOLD_EXTRACTOR,
  priceChartingQuery,
} from '../electron/extractors/marketplace.js';
import { GOOGLE_JOBS_EXTRACTOR } from '../electron/extractors/jobs.js';
import {
  getJobHubTransientKeysForSave,
  SELLHUB_TRANSIENT_KEYS,
  TRANSIENT_PROCESSING_HUB_STATES,
} from '../src/utils/persistenceTransientState.js';
import {
  jobTitleCompanyKey,
  jobTitleCompanyUrlKey,
  jobTitleCompanyLocationKey,
  dedupeJobsByKey,
  uniqueJobsNotIn,
} from '../src/utils/jobIdentity.js';
import { mergeSourceProgress } from '../src/utils/sourceProgress.js';
import { applyJobCardFiltersToNodes, getJobCardFilterOpacity, isJobCardVisible } from '../src/utils/jobCardFilters.js';
import { reconcileBatchScores } from '../electron/ipc/jobBatchReconcile.js';
import { mergeResolvedSourceItems } from '../src/utils/jobSourceResolveMerge.js';
import {
  LIKELY_THRESHOLD,
  buildJobTreeNodes,
  computeLayoutPositions,
  partitionJobsForBranches,
  strongMatchGate,
  COL_X,
} from '../src/nodes/jobhub/buildJobTree.js';
import { buildGeoTermSet, extractIndeedJobsFromHtml, jobRelevanceMatch, selectReverbPriceGuides, reverbTransactionsToComps, parsePriceChartingHtml } from '../electron/extractors/apiExtractors.js';
import { buildResumeDocument, buildCoverLetterDocument, extractVariantAttrs, isDualMode } from '../electron/ipc/resumeHtml.js';
import {
  fingerprint,
  migrateGroupNodes,
  sanitizeEdgesForSave,
  sanitizeNodesForSave,
} from '../src/utils/serializationUtils.js';
import { cloneNode, reassignCanvasDataIDs } from '../src/utils/nodeFactory.js';
import {
  distToSegment,
  pixelEraseStroke,
  segmentCircleIntersections,
} from '../src/utils/geometry.js';
import {
  edgeZoneForRadius,
  fitViewDuration,
  gridSpacing,
  panDuration,
  radialRadius,
  spiralStep,
} from '../src/utils/layoutGeometry.js';
import { computeTidiedNodes, findNonOverlappingPlacement } from '../src/utils/layoutUtils.js';
import { FILE_CATEGORIES, getFileCategoryInfo, toLocalFileUrl } from '../src/utils/fileDisplayUtils.js';
import { parsePostedDate, filterJobsByAge } from '../electron/ipc/jobDateFilter.js';
import { compsForPricing, priceSynthesisMaxTokens, jobScoringBatchSize, JOB_MAX_PAGES, JOB_PER_PAGE_CAP } from '../electron/ipc/resultCaps.js';
import { parseGeminiJSON } from '../electron/ipc/gemini.js';
import { withSharedProfileLock } from '../electron/ipc/sharedProfileLock.js';
import os from 'node:os';
import { startRun, recordSourcePage, markSourceStatus, setStage, readStagedJobs, readRunState, clearRun, RESUMABLE_MAX_AGE_MS } from '../electron/ipc/jobRunStaging.js';
import { modelTag, overPricedSoldFlag } from '../electron/ipc/bugReport/helpers.js';
import { classifyCompScrapeFailure, computeMissingLogins } from '../electron/ipc/marketplace.js';
import { isAuthChallengeUrl } from '../electron/ipc/browser/authWindows.js';
import { applyBugReportCode, previewBugReportCode } from '../src/utils/bugReportCodes.js';
import { createJobSearchTestMode, parseJobSearchEnvBoolean } from '../src/utils/jobSourceScope.js';
import { createMarketplaceTestMode, parseMarketplaceEnvBoolean, getScopedCompSourceIds, isCompSourceEnabledInScope } from '../src/utils/compSourceScope.js';
import { getJobAuthPreflightSourceIds, JOB_AUTH_PREFLIGHT_SOURCE_IDS } from '../src/utils/jobAuthPreflight.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runExtractorFixtureTest({ name, file, extractor, minCount = 1, sampleAssert = null }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  // Extractors return either a bare array or { items, yieldStats } — mirror the
  // browserPool unwrap so the fixture asserts on the items array either way.
  const raw = dom.window.eval(extractor);
  const result = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : raw);
  assert(Array.isArray(result), `${name}: extractor did not return an array (or { items })`);
  assert(result.length >= minCount, `${name}: expected at least ${minCount} result(s), got ${result.length}`);
  if (sampleAssert) sampleAssert(result[0], result);
  return { count: result.length, sample: result[0] };
}

function runZeroResultFixtureTest({ name, file, extractor }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  const raw = dom.window.eval(extractor);
  const result = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : raw);
  assert(Array.isArray(result), `${name}: extractor did not return an array (or { items })`);
  assert(result.length === 0, `${name}: expected 0 results, got ${result.length}`);
  return { count: result.length };
}

const tests = [
  {
    name: 'eBay sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'eBay sold fixture',
      file: 'ebay-body.html',
      extractor: EBAY_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'ebay-sold', 'eBay sold fixture: wrong source id');
        assert(sample.title && sample.price > 0 && sample.soldDate, 'eBay sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'eBay active fixture',
    run: () => runExtractorFixtureTest({
      name: 'eBay active fixture',
      file: 'ebay-body.html',
      extractor: EBAY_ACTIVE_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'ebay-active', 'eBay active fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'eBay active fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Mercari sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'Mercari sold fixture',
      file: 'mercari-body.html',
      extractor: MERCARI_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'mercari', 'Mercari sold fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'Mercari sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Poshmark sold fixture',
    run: () => runExtractorFixtureTest({
      name: 'Poshmark sold fixture',
      file: 'poshmark-body.html',
      extractor: POSHMARK_SOLD_EXTRACTOR,
      minCount: 10,
      sampleAssert: (sample) => {
        assert(sample.source === 'poshmark', 'Poshmark sold fixture: wrong source id');
        assert(sample.title && sample.price > 0, 'Poshmark sold fixture: incomplete sample payload');
      },
    }),
  },
  {
    name: 'Google captcha fixture',
    run: () => runZeroResultFixtureTest({
      name: 'Google captcha fixture',
      file: 'google-jobs.html',
      extractor: GOOGLE_JOBS_EXTRACTOR,
    }),
  },
  {
    name: 'Indeed DOM extraction',
    run: () => {
      const html = `
        <html><body>
          <div class="job_seen_beacon" data-jk="abc123">
            <h2 class="jobTitle"><a href="/rc/clk?jk=abc123">Senior Product Manager</a></h2>
            <span data-testid="company-name">Acme</span>
            <div data-testid="text-location">Remote</div>
            <div data-testid="attribute_snippet_testid">$120,000 a year</div>
            <div data-testid="job-snippet">Own product strategy.</div>
            <span data-testid="myJobsStateDate">Posted 1 day ago</span>
          </div>
          <div class="job_seen_beacon" data-jk="abc123">
            <h2 class="jobTitle"><a href="/rc/clk?jk=abc123">Senior Product Manager</a></h2>
            <span data-testid="company-name">Acme</span>
            <div data-testid="text-location">Remote</div>
          </div>
        </body></html>`;
      const jobs = extractIndeedJobsFromHtml(html);
      assert(jobs.length === 1, `Indeed DOM extraction: expected deduped single job, got ${jobs.length}`);
      assert(jobs[0].title === 'Senior Product Manager', 'Indeed DOM extraction: wrong title');
      assert(jobs[0].company === 'Acme' && jobs[0].location === 'Remote', 'Indeed DOM extraction: wrong company/location');
      assert(jobs[0].url === 'https://www.indeed.com/viewjob?jk=abc123', `Indeed DOM extraction: normalized URL mismatch ${jobs[0].url}`);
      return { count: jobs.length, sample: jobs[0] };
    },
  },
  {
    name: 'Transient jobhub save rules',
    run: () => {
      const normal = getJobHubTransientKeysForSave('searching');
      const sourcesReady = getJobHubTransientKeysForSave('sources-ready');
      assert(normal.includes('scrapeWarnings'), 'Transient jobhub save rules: default state should strip scrapeWarnings');
      assert(normal.includes('pendingTargetRole'), 'Transient jobhub save rules: default state should strip pendingTargetRole');
      assert(!sourcesReady.includes('scrapeWarnings'), 'Transient jobhub save rules: sources-ready should preserve scrapeWarnings');
      assert(sourcesReady.includes('errorMessage') && sourcesReady.includes('isRateLimit'), 'Transient jobhub save rules: sources-ready should still strip banners');
      return { normal, sourcesReady };
    },
  },
  {
    name: 'Transient state constants',
    run: () => {
      assert(TRANSIENT_PROCESSING_HUB_STATES.includes('searching'), 'Transient state constants: missing searching');
      assert(TRANSIENT_PROCESSING_HUB_STATES.includes('researching'), 'Transient state constants: missing researching');
      assert(SELLHUB_TRANSIENT_KEYS.includes('platformFitPending'), 'Transient state constants: missing platformFitPending');
      return {
        transientStates: TRANSIENT_PROCESSING_HUB_STATES.length,
        sellhubKeys: SELLHUB_TRANSIENT_KEYS.length,
      };
    },
  },
  {
    name: 'Serialization sanitizes transient state',
    run: () => {
      const nodes = [
        { id: 'hub', type: 'jobhub', position: { x: 0, y: 0 }, data: { hubState: 'searching', pendingJobs: [1], scrapeWarnings: [2], errorMessage: 'old' } },
        { id: 'job', type: 'jobcard', position: { x: 1, y: 1 }, style: { opacity: 0.3, width: 180 }, data: { title: 'A', isDropTarget: true } },
        { id: 'clean-source', type: 'jobsourcecard', position: { x: 2, y: 2 }, data: { persistedProgress: { status: 'done' } } },
        { id: 'blocked-source', type: 'jobsourcecard', position: { x: 3, y: 3 }, data: { persistedProgress: { status: 'error', warning: { code: 'captcha' } } } },
        { id: 'group', type: 'group', position: { x: 4, y: 4 }, data: { isDropTarget: true, canvasData: { nodes: [
          { id: 'inner-job', type: 'jobcard', position: { x: 0, y: 0 }, style: { opacity: 0.1 }, data: { title: 'Inner' } },
        ], edges: [], drawings: [] } } },
      ];
      const sanitized = sanitizeNodesForSave(nodes);
      const hub = sanitized.find(n => n.id === 'hub');
      const job = sanitized.find(n => n.id === 'job');
      assert(hub.data.hubState === 'empty', 'Serialization sanitizes transient state: active jobhub should reset to empty');
      assert(!('pendingJobs' in hub.data) && !('scrapeWarnings' in hub.data), 'Serialization sanitizes transient state: jobhub transient buffers should be stripped');
      assert(!('isDropTarget' in job.data) && job.style.opacity === undefined && job.style.width === 180, 'Serialization sanitizes transient state: node transient UI state should be stripped');
      assert(!sanitized.some(n => n.id === 'clean-source'), 'Serialization sanitizes transient state: clean source card should be dropped');
      assert(sanitized.some(n => n.id === 'blocked-source'), 'Serialization sanitizes transient state: blocked source card should persist');
      assert(sanitized.find(n => n.id === 'group').data.canvasData.nodes[0].style === undefined, 'Serialization sanitizes transient state: nested nodes should be sanitized');
      const edges = sanitizeEdgesForSave([
        { id: 'keep', source: 'hub', target: 'job' },
        { id: 'drop', source: 'hub', target: 'missing' },
      ], sanitized);
      assert(edges.length === 1 && edges[0].id === 'keep', 'Serialization sanitizes transient state: orphan edges should be pruned');
      return { nodes: sanitized.length, edges: edges.length };
    },
  },
  {
    name: 'Serialization migration and fingerprints',
    run: () => {
      const legacy = [{
        id: 'g1',
        type: 'group',
        position: { x: 0, y: 0 },
        dragHandle: '.old',
        data: {
          title: 'Legacy',
          collapsed: true,
          nodes: [{ id: 'child', type: 'text', position: { x: 1, y: 2 }, data: { text: 'A' } }],
          edges: [{ id: 'e', source: 'child', target: 'child' }],
          drawings: [{ id: 'd', points: [{ x: 0, y: 0 }] }],
        },
      }];
      const migrated = migrateGroupNodes(legacy);
      assert(migrated[0].data.canvasData.nodes.length === 1, 'Serialization migration and fingerprints: legacy group should migrate canvasData');
      assert(!('nodes' in migrated[0].data) && !('dragHandle' in migrated[0]), 'Serialization migration and fingerprints: legacy fields should be removed');
      const fpA = fingerprint({ nodes: migrated, edges: [], drawings: [{ points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 10 }] }] });
      const fpB = fingerprint({ nodes: migrated, edges: [], drawings: [{ points: [{ x: 0, y: 0 }, { x: 7, y: 7 }, { x: 10, y: 10 }] }] });
      assert(fpA !== fpB, 'Serialization migration and fingerprints: middle drawing point should affect fingerprint');
      return { migratedNodes: migrated[0].data.canvasData.nodes.length };
    },
  },
  {
    name: 'Node factory clone safety',
    run: () => {
      const source = {
        id: 'hub-a',
        type: 'jobhub',
        position: { x: 10, y: 20 },
        draggable: false,
        deletable: false,
        data: { locked: true, hubState: 'searching', isNew: true },
      };
      const clone = cloneNode(source, 5, 6);
      assert(clone.id !== source.id, 'Node factory clone safety: clone should get a new id');
      assert(clone.position.x === 15 && clone.position.y === 26, 'Node factory clone safety: clone should be offset');
      assert(clone.data.locked === false && clone.draggable === undefined && clone.deletable === undefined, 'Node factory clone safety: clone should unlock');
      assert(clone.data.hubState === 'empty' && clone.data.isNew === false, 'Node factory clone safety: active state/new flag should be sanitized');

      const group = {
        id: 'group-a',
        type: 'group',
        position: { x: 0, y: 0 },
        data: {
          canvasData: {
            nodes: [{ id: 'child-a', type: 'text', position: { x: 1, y: 1 }, data: {} }],
            edges: [{ id: 'edge-a', source: 'child-a', target: 'child-a' }],
            drawings: [{ id: 'draw-a', points: [] }],
          },
        },
      };
      const reassigned = reassignCanvasDataIDs(group);
      const childId = reassigned.data.canvasData.nodes[0].id;
      assert(childId !== 'child-a', 'Node factory clone safety: nested child id should be reassigned');
      assert(reassigned.data.canvasData.edges[0].source === childId && reassigned.data.canvasData.edges[0].target === childId, 'Node factory clone safety: nested edge endpoints should be remapped consistently');
      assert(reassigned.data.canvasData.drawings[0].id !== 'draw-a', 'Node factory clone safety: drawing ids should be reassigned');
      return { cloneIdChanged: clone.id !== source.id, childId };
    },
  },
  {
    name: 'Geometry eraser math',
    run: () => {
      assert(distToSegment({ x: 5, y: 5 }, { x: 0, y: 0 }, { x: 10, y: 0 }) === 5, 'Geometry eraser math: point-to-segment distance mismatch');
      const ts = segmentCircleIntersections({ x: -10, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }, 5);
      assert(ts.length === 2 && Math.abs(ts[0] - 0.25) < 1e-6 && Math.abs(ts[1] - 0.75) < 1e-6, 'Geometry eraser math: segment-circle intersections mismatch');
      const pieces = pixelEraseStroke({ id: 's', points: [{ x: -10, y: 0 }, { x: 10, y: 0 }] }, { x: 0, y: 0 }, 5);
      assert(pieces.length === 2, `Geometry eraser math: expected stroke split into 2 pieces, got ${pieces.length}`);
      assert(pieces[0].points.at(-1).x === -5 && pieces[1].points[0].x === 5, 'Geometry eraser math: split points should sit on eraser boundary');
      return { intersections: ts, pieces: pieces.length };
    },
  },
  {
    name: 'Layout geometry helpers',
    run: () => {
      assert(radialRadius({ count: 12, cardW: 140, cardH: 50, hubW: 260, hubH: 140 }) >= 223, 'Layout geometry helpers: radial radius should clear hub/cards');
      assert(fitViewDuration(0) === 450 && fitViewDuration(100) === 900, 'Layout geometry helpers: fit duration clamp mismatch');
      assert(panDuration(0) === 260 && panDuration(5000) === 900, 'Layout geometry helpers: pan duration clamp mismatch');
      assert(edgeZoneForRadius(10) === 8 && edgeZoneForRadius(1000) === 28, 'Layout geometry helpers: edge zone clamp mismatch');
      const spacing = gridSpacing([{ type: 'text' }, { type: 'listing' }]);
      assert(spacing.gutter >= 32 && spacing.gutter <= 80, 'Layout geometry helpers: grid spacing out of bounds');
      assert(spiralStep(1000, 20) === 240 && spiralStep(40, 40) === 60, 'Layout geometry helpers: spiral step clamp mismatch');
      return { radius: radialRadius({ count: 12, cardW: 140, cardH: 50, hubW: 260, hubH: 140 }), spacing };
    },
  },
  {
    name: 'Layout utilities',
    run: () => {
      const nodes = [
        { id: 'a', type: 'text', selected: true, position: { x: 100, y: 100 }, data: {} },
        { id: 'b', type: 'text', selected: true, position: { x: 10, y: 100 }, data: {} },
        { id: 'locked', type: 'text', selected: true, position: { x: 999, y: 999 }, data: { locked: true } },
      ];
      const tidied = computeTidiedNodes(nodes, true);
      assert(tidied.find(n => n.id === 'locked').position.x === 999, 'Layout utilities: locked nodes should not move');
      assert(tidied.find(n => n.id === 'b').position.x === 10, 'Layout utilities: leftmost selected node should anchor layout');
      const placement = findNonOverlappingPlacement(
        [{ id: 'drop', type: 'text', position: { x: 0, y: 0 }, data: {} }],
        [{ id: 'existing', type: 'text', position: { x: 0, y: 0 }, data: {} }],
      );
      assert(Number.isFinite(placement.anchorX) && Number.isFinite(placement.anchorY), 'Layout utilities: placement should be finite');
      assert(Math.abs(placement.anchorX) > 1 || Math.abs(placement.anchorY) > 1, 'Layout utilities: placement should move away from overlap');
      return { placement };
    },
  },
  {
    name: 'File display helpers',
    run: () => {
      assert(toLocalFileUrl('/tmp/a b#c?.png') === 'local-file:///tmp/a%20b%23c%3F.png', 'File display helpers: local file URL encoding mismatch');
      assert(getFileCategoryInfo('photo.HEIC').category === FILE_CATEGORIES.IMAGE, 'File display helpers: HEIC should be image');
      assert(getFileCategoryInfo('script.tsx').category === FILE_CATEGORIES.CODE, 'File display helpers: TSX should be code');
      assert(getFileCategoryInfo('report.pdf').label === 'PDF Document', 'File display helpers: PDF label mismatch');
      assert(getFileCategoryInfo('unknown').badge === 'FILE', 'File display helpers: extensionless badge mismatch');
      return { image: getFileCategoryInfo('photo.HEIC').label };
    },
  },
  {
    name: 'Job date and cap helpers',
    run: () => {
      const twoDaysAgo = parsePostedDate('2 days ago');
      const twoMonthsAgo = parsePostedDate('2mo ago');
      const minutesAgo = parsePostedDate('5m ago');
      assert(twoDaysAgo && Date.now() - twoDaysAgo.getTime() >= 1.5 * 86400000, 'Job date and cap helpers: days parsing mismatch');
      assert(twoMonthsAgo && Date.now() - twoMonthsAgo.getTime() >= 50 * 86400000, 'Job date and cap helpers: months parsing mismatch');
      assert(minutesAgo && Date.now() - minutesAgo.getTime() < 86400000, 'Job date and cap helpers: minutes should be today');
      const filtered = filterJobsByAge([
        { title: 'keep', posted: 'today' },
        { title: 'drop', posted: '90 days ago' },
        { title: 'unknown', posted: 'some weird source text' },
      ], 30);
      assert(filtered.map(j => j.title).join(',') === 'keep,unknown', 'Job date and cap helpers: age filter should keep recent and unknown dates');
      // compsForPricing is unbounded — a small set passes through in full...
      const cSmall = compsForPricing(8, 4);
      assert(cSmall.sold === 8 && cSmall.active === 4, 'Job date and cap helpers: small comp set should pass through unbounded');
      // ...and a large set is bounded ONLY by the synthesis token budget (scaled
      // proportionally, well above the old 25/15 caps), and the count actually fed
      // must always receive a NON-clamped budget (i.e. it can't truncate).
      const cBig = compsForPricing(1000, 1000);
      assert(cBig.sold === cBig.active && cBig.sold > 15, 'Job date and cap helpers: large comp set should scale proportionally above the old caps');
      assert(priceSynthesisMaxTokens(cBig.sold + cBig.active) < 24576, 'Job date and cap helpers: fed comp count must fit the synthesis token budget (no clamp/truncate)');
      assert(jobScoringBatchSize() >= 5 && jobScoringBatchSize() <= 15, 'Job date and cap helpers: scoring batch out of bounds');
      assert(JOB_MAX_PAGES === 10 && JOB_PER_PAGE_CAP > 0, 'Job date and cap helpers: job caps unexpected');
      return { filtered: filtered.length, scoringBatch: jobScoringBatchSize() };
    },
  },
  {
    name: 'Job board relevance filtering',
    run: () => {
      const geoTerms = buildGeoTermSet(['Denver, CO', 'hybrid in Chicago']);
      assert(geoTerms.has('denver') && geoTerms.has('chicago'), 'Job board relevance filtering: geo terms should include city tokens');
      assert(!geoTerms.has('co'), 'Job board relevance filtering: short state token should be ignored');
      assert(
        !jobRelevanceMatch('Account Executive - Denver', 'Junior Cinematographer Denver', geoTerms),
        'Job board relevance filtering: location/seniority tokens should not pull unrelated board roles',
      );
      assert(
        jobRelevanceMatch('Senior Cinematographer', 'Junior Cinematographer Denver', geoTerms),
        'Job board relevance filtering: surviving role noun should match',
      );
      assert(
        !jobRelevanceMatch('Account Executive - Chicago', 'Product Designer Chicago', geoTerms),
        'Job board relevance filtering: preferred-location token should not become role relevance',
      );
      assert(
        jobRelevanceMatch('Engineering Manager', 'Senior Manager', new Set()),
        'Job board relevance filtering: all-generic role query should still fall back rather than match nothing',
      );
      return { geoTerms: [...geoTerms].sort(), fallback: true };
    },
  },
  {
    name: 'Job source test-mode env parsing',
    run: () => {
      const off = createJobSearchTestMode({});
      assert(off.enabled === false && off.sourceId === null, 'Job source test-mode env parsing: default should be production/all-source mode');
      const disabledWithSource = createJobSearchTestMode({ JOB_SEARCH_TEST_SOURCE: 'linkedin' });
      assert(disabledWithSource.sourceId === null, 'Job source test-mode env parsing: source should be ignored unless enabled');
      const full = createJobSearchTestMode({
        JOB_SEARCH_TEST_ENABLED: 'true',
        JOB_SEARCH_TEST_SOURCE: 'linkedin',
        JOB_SEARCH_TEST_FULL_RUN: '1',
        JOB_SEARCH_TEST_SKIP_AI: 'yes',
      });
      assert(full.enabled && full.sourceId === 'linkedin' && full.fullRun && full.skipAI, 'Job source test-mode env parsing: plain env values not parsed');
      assert(full.fast === false, 'Job source test-mode env parsing: fast should default false');
      const vite = createJobSearchTestMode({
        VITE_JOB_SEARCH_TEST_ENABLED: 'on',
        VITE_JOB_SEARCH_TEST_SOURCE: 'indeed',
        VITE_JOB_SEARCH_TEST_FULL_RUN: '0',
      });
      assert(vite.enabled && vite.sourceId === 'indeed' && !vite.fullRun, 'Job source test-mode env parsing: VITE env values not parsed');
      assert(parseJobSearchEnvBoolean('not-a-bool', true) === true, 'Job source test-mode env parsing: invalid bool should use fallback');
      // FAST mode: parsed from its own flag, independent of fullRun. Precedence
      // (fast wins over medium/full) lives in resultCaps.js, not this parser.
      const fast = createJobSearchTestMode({
        JOB_SEARCH_TEST_ENABLED: 'true',
        JOB_SEARCH_TEST_SOURCE: 'glassdoor',
        JOB_SEARCH_TEST_FAST: 'true',
      });
      assert(fast.enabled && fast.fast === true && fast.sourceId === 'glassdoor' && !fast.fullRun, 'Job source test-mode env parsing: FAST flag not parsed');
      const viteFast = createJobSearchTestMode({ VITE_JOB_SEARCH_TEST_ENABLED: '1', VITE_JOB_SEARCH_TEST_FAST: 'on' });
      assert(viteFast.fast === true, 'Job source test-mode env parsing: VITE FAST flag not parsed');
      return { defaultEnabled: off.enabled, fullSource: full.sourceId, viteSource: vite.sourceId, fast: fast.fast };
    },
  },
  {
    name: 'Marketplace source test-mode env parsing',
    run: () => {
      const off = createMarketplaceTestMode({});
      assert(off.enabled === false && off.sourceId === null, 'Marketplace test-mode: default should be production/all-source mode');
      const disabledWithSource = createMarketplaceTestMode({ MARKETPLACE_TEST_SOURCE: 'ebay-sold' });
      assert(disabledWithSource.sourceId === null, 'Marketplace test-mode: source should be ignored unless enabled');
      const on = createMarketplaceTestMode({ MARKETPLACE_TEST_ENABLED: 'true', MARKETPLACE_TEST_SOURCE: 'ebay-sold' });
      assert(on.enabled && on.sourceId === 'ebay-sold', 'Marketplace test-mode: plain env values not parsed');
      const vite = createMarketplaceTestMode({ VITE_MARKETPLACE_TEST_ENABLED: '1', VITE_MARKETPLACE_TEST_SOURCE: 'reverb' });
      assert(vite.enabled && vite.sourceId === 'reverb', 'Marketplace test-mode: VITE env values not parsed');
      assert(parseMarketplaceEnvBoolean('not-a-bool', true) === true, 'Marketplace test-mode: invalid bool should use fallback');
      // The module singleton sees no env vars in the test process, so scope is a
      // passthrough — every source stays enabled (production behavior).
      assert(getScopedCompSourceIds(['ebay-sold', 'reverb']).length === 2, 'Marketplace test-mode: disabled scope returns all sources');
      assert(isCompSourceEnabledInScope('ebay-sold') === true, 'Marketplace test-mode: disabled scope enables every source');
      return { defaultEnabled: off.enabled, targetSource: on.sourceId, viteSource: vite.sourceId };
    },
  },
  {
    name: 'Job auth preflight sources',
    run: () => {
      const required = getJobAuthPreflightSourceIds(ids => ids);
      assert(!required.includes('linkedin'), 'Job auth preflight sources: LinkedIn should not block anonymous public job search');
      assert(required.includes('indeed') && required.includes('glassdoor'), 'Job auth preflight sources: browser sources should still be gated');
      const scopedLinkedIn = getJobAuthPreflightSourceIds(ids => ids.filter(id => id === 'linkedin'));
      assert(scopedLinkedIn.length === 0, 'Job auth preflight sources: LinkedIn-only test scope should require no login preflight');
      const scopedIndeed = getJobAuthPreflightSourceIds(ids => ids.filter(id => id === 'indeed'));
      assert(scopedIndeed.join(',') === 'indeed', 'Job auth preflight sources: source scope should still gate required browser sources');
      return { required: JOB_AUTH_PREFLIGHT_SOURCE_IDS.length, scopedLinkedIn: scopedLinkedIn.length };
    },
  },
  {
    name: 'Bug report code filtering',
    run: () => {
      const logs = [
        '00:00 User clicked save',
        '00:01 normal interaction',
        '00:02 Error: failed to save workspace',
        '00:03 recovery toast shown',
        '00:04 unrelated tail',
      ];
      const full = applyBugReportCode(logs, {}, 'FULL');
      assert(full.filteredLogs === logs && full.matchedCodes.includes('FULL'), 'Bug report code filtering: FULL should keep original logs');
      const filtered = applyBugReportCode(logs, {}, 'ERR+QUICK');
      assert(filtered.filteredLogs.length <= logs.length && filtered.matchedCodes.includes('ERR'), 'Bug report code filtering: ERR+QUICK should match ERR');
      const preview = previewBugReportCode(logs, 'ERR+NOPE');
      assert(preview.unknownCodes.includes('NOPE') && preview.valid, 'Bug report code filtering: preview should report unknown codes while keeping valid matches');
      return { filtered: filtered.filteredLogs.length, unknown: preview.unknownCodes };
    },
  },
  {
    name: 'Job identity helpers',
    run: () => {
      const a = { title: ' Senior Engineer ', company: 'Acme ', location: ' Denver ', url: ' HTTPS://EXAMPLE.COM/JOB ' };
      const b = { title: 'senior engineer', company: 'acme', location: 'denver', url: 'https://example.com/job' };
      const c = { title: 'Senior Engineer', company: 'Acme', location: 'Remote', url: 'https://example.com/job-2' };
      assert(jobTitleCompanyKey(a) === 'senior engineer|acme', 'Job identity helpers: title/company key should normalize case and whitespace');
      assert(jobTitleCompanyUrlKey(a) === jobTitleCompanyUrlKey(b), 'Job identity helpers: URL key should normalize case and whitespace');
      assert(jobTitleCompanyLocationKey(a) === jobTitleCompanyLocationKey(b), 'Job identity helpers: location key should normalize case and whitespace');
      assert(jobTitleCompanyLocationKey(a) !== jobTitleCompanyLocationKey(c), 'Job identity helpers: location key should keep distinct locations');

      const deduped = dedupeJobsByKey([a, b, c], jobTitleCompanyKey);
      assert(deduped.length === 1, `Job identity helpers: expected title/company dedupe to keep 1, got ${deduped.length}`);
      const fresh = uniqueJobsNotIn([a], [b, c], jobTitleCompanyUrlKey);
      assert(fresh.length === 1 && fresh[0] === c, 'Job identity helpers: uniqueJobsNotIn should preserve only unseen candidates');
      return { deduped: deduped.length, fresh: fresh.length };
    },
  },
  {
    name: 'Source progress merge',
    run: () => {
      const first = mergeSourceProgress(null, {
        status: 'searching',
        count: 0,
        warning: { code: 'captcha', severity: 'block' },
        url: 'https://example.com/jobs',
        detail: 'page 1',
        completed: 0,
        total: 10,
      });
      const terminal = mergeSourceProgress(first, { status: 'done', count: 12 });
      assert(terminal.warning?.code === 'captcha', 'Source progress merge: warning should stay sticky when omitted');
      assert(terminal.url === 'https://example.com/jobs', 'Source progress merge: url should stay sticky when omitted');
      assert(terminal.detail === null, 'Source progress merge: detail should not stay sticky');
      assert(terminal.completed === 0 && terminal.total === 10, 'Source progress merge: completed/total should stay sticky when omitted');
      const advanced = mergeSourceProgress(terminal, { status: 'searching', count: 12, completed: 4, total: 10 });
      assert(advanced.completed === 4 && advanced.total === 10, 'Source progress merge: completed/total should update when provided');
      const cleared = mergeSourceProgress(terminal, { status: 'done', count: 12, warning: null, url: null });
      assert(cleared.warning === null && cleared.url === null, 'Source progress merge: explicit null should clear sticky fields');
      return { terminal, advanced, cleared };
    },
  },
  {
    name: 'Job card filters',
    run: () => {
      const job = { source: 'indeed', matchScore: 72, status: 'New' };
      assert(isJobCardVisible(job, { sourceFilter: 'indeed', scoreThreshold: 70 }), 'Job card filters: matching source and score should be visible');
      assert(!isJobCardVisible(job, { sourceFilter: 'linkedin' }), 'Job card filters: non-matching source should be hidden');
      assert(!isJobCardVisible(job, { scoreThreshold: 80 }), 'Job card filters: score below threshold should be hidden');
      assert(isJobCardVisible({ ...job, status: undefined }, { statusFilters: ['New'] }), 'Job card filters: missing status should default to New');
      assert(!isJobCardVisible(job, { statusFilters: ['Filled'] }), 'Job card filters: non-matching status should be hidden');
      assert(getJobCardFilterOpacity(job, { sourceFilter: 'linkedin' }) === 0.15, 'Job card filters: hidden opacity should match UI contract');
      const otherHubCard = { id: 'other', type: 'jobcard', style: {}, data: { ...job, hubId: 'hub-b', source: 'linkedin' } };
      const alreadyHidden = { id: 'hidden', type: 'jobcard', style: { opacity: 0.15 }, data: { ...job, hubId: 'hub-a', source: 'linkedin' } };
      const nodes = [
        { id: 'visible', type: 'jobcard', style: {}, data: { ...job, hubId: 'hub-a' } },
        { id: 'to-hide', type: 'jobcard', style: {}, data: { ...job, hubId: 'hub-a', source: 'linkedin' } },
        otherHubCard,
        alreadyHidden,
      ];
      const filteredNodes = applyJobCardFiltersToNodes(nodes, 'hub-a', { sourceFilter: 'indeed' });
      assert(filteredNodes[0] === nodes[0], 'Job card filters: already-visible cards should preserve node identity');
      assert(filteredNodes[1].style.opacity === 0.15, 'Job card filters: hidden same-hub cards should get hidden opacity');
      assert(filteredNodes[2] === otherHubCard, 'Job card filters: cards from other hubs should not be mutated');
      assert(filteredNodes[3] === alreadyHidden, 'Job card filters: unchanged opacity should preserve node identity');
      return { visible: getJobCardFilterOpacity(job, { sourceFilter: 'indeed' }), nodes: filteredNodes.length };
    },
  },
  {
    name: 'Batch scoring reconciliation',
    run: () => {
      const batches = [
        [{ url: 'a', title: 'A' }, { url: 'b', title: 'B' }], // b0 — both scored
        [{ url: 'c', title: 'C' }],                            // b1 — whole request failed
        [{ url: 'd', title: 'D' }, { url: 'e', title: 'E' }], // b2 — index 1 missing
      ];
      const results = {
        b0: { scores: [
          { index: 0, matchScore: 90, reasoning: 'great', careerDirection: 'X', isTargetRoleMatch: true },
          { index: 1, matchScore: 40, reasoning: 'meh', careerDirection: 'Y' },
        ] },
        b1: null, // errored/expired batch request
        b2: { scores: [{ index: 0, matchScore: 70, reasoning: 'ok', careerDirection: 'Z' }] },
      };
      const { scoredJobs, placeholderCount, failedBatches } = reconcileBatchScores(batches, results, { fallbackScore: 50 });
      assert(scoredJobs.length === 5, `Batch reconcile: expected 5 scored, got ${scoredJobs.length}`);
      assert(failedBatches === 1, `Batch reconcile: expected 1 failed batch, got ${failedBatches}`);
      assert(placeholderCount === 2, `Batch reconcile: expected 2 placeholders, got ${placeholderCount}`);
      assert(scoredJobs[0].matchScore === 90 && scoredJobs[0].url === 'a', 'Batch reconcile: results sorted desc by score');
      const cJob = scoredJobs.find(j => j.url === 'c');
      assert(cJob.matchScore === 50 && cJob.reasoning === 'AI format error', 'Batch reconcile: failed-batch job → AI format error placeholder');
      const eJob = scoredJobs.find(j => j.url === 'e');
      assert(eJob.matchScore === 50 && eJob.reasoning === 'Unable to score', 'Batch reconcile: missing-index job → Unable to score placeholder');
      const bJob = scoredJobs.find(j => j.url === 'b');
      assert(bJob.isTargetRoleMatch === false, 'Batch reconcile: missing isTargetRoleMatch coerced to false');
      assert(scoredJobs.find(j => j.url === 'a').isTargetRoleMatch === true, 'Batch reconcile: isTargetRoleMatch preserved');
      return { scored: scoredJobs.length, placeholderCount, failedBatches };
    },
  },
  {
    name: 'Job source resolve merge',
    run: () => {
      const existing = [
        { title: 'Indeed A', company: 'Acme', url: 'https://jobs/a', source: 'indeed' },
        { title: 'LinkedIn A', company: 'Acme', url: 'https://jobs/li-a', source: 'linkedin', snippet: '' },
        { title: 'Other', company: 'Beta', url: 'https://jobs/b', source: 'remoteok' },
      ];
      const incremental = mergeResolvedSourceItems(existing, [
        { title: 'Indeed B', company: 'Acme', url: 'https://jobs/indeed-b', source: 'indeed' },
      ], 'indeed');
      assert(incremental.replacedExisting === 0, 'Job source resolve merge: incremental source should not drop existing same-source jobs');
      assert(incremental.mergedPending.filter(j => j.source === 'indeed').length === 2, 'Job source resolve merge: incremental source should append fresh jobs');

      const replacement = mergeResolvedSourceItems(existing, [
        { title: 'LinkedIn A', company: 'Acme', url: 'https://jobs/li-a', source: 'linkedin', snippet: 'full description' },
        { title: 'LinkedIn B', company: 'Acme', url: 'https://jobs/li-b', source: 'linkedin', snippet: 'full description' },
      ], 'linkedin', { replaceSourceItems: true });
      assert(replacement.replacedExisting === 1, 'Job source resolve merge: replacement source should drop stale same-source jobs');
      assert(replacement.mergedPending.filter(j => j.source === 'linkedin').length === 2, 'Job source resolve merge: replacement source should use returned full source set');
      return { incremental: incremental.mergedPending.length, replacement: replacement.mergedPending.length };
    },
  },
  {
    name: 'Job target partitioning',
    run: () => {
      const jobs = [
        { title: 'A', company: 'Co', url: '1', matchScore: 90, isTargetRoleMatch: true },
        { title: 'B', company: 'Co', url: '2', matchScore: 60, isTargetRoleMatch: true },
        { title: 'C', company: 'Co', url: '3', matchScore: 58, isTargetRoleMatch: true },
        { title: 'D', company: 'Co', url: '4', matchScore: 40, isTargetRoleMatch: true },
        { title: 'E', company: 'Co', url: '5', matchScore: 30, isTargetRoleMatch: true },
        { title: 'Other Strong', company: 'Co', url: '6', matchScore: 80, isTargetRoleMatch: false },
        { title: 'Other Thin', company: 'Co', url: '7', matchScore: 55, isTargetRoleMatch: false },
      ];
      const gate = strongMatchGate([80, 55, 54, 53, 52]);
      assert(gate === 52, `Job target partitioning: expected relaxed gate 52, got ${gate}`);
      const split = partitionJobsForBranches(jobs, true);
      assert(split.targetList.length === 5, `Job target partitioning: expected 5 target jobs after loose-fill, got ${split.targetList.length}`);
      assert(split.targetList.filter(j => (j.matchScore || 0) < LIKELY_THRESHOLD).length === 4, 'Job target partitioning: 4 sub-threshold target jobs should be backfilled via loose-fill');
      assert(split.otherList.length === 2, `Job target partitioning: expected relaxed other list to include 2 jobs, got ${split.otherList.length}`);
      assert(partitionJobsForBranches(jobs, false).displayedJobs.length === jobs.length, 'Job target partitioning: no-target path should be passthrough');
      assert(LIKELY_THRESHOLD === 65, 'Job target partitioning: unexpected likely threshold');
      return { gate: split.gate, target: split.targetList.length, other: split.otherList.length };
    },
  },
  {
    name: 'Job tree: likelihood → salary → role hierarchy',
    run: () => {
      const mk = (title, score, salary, url) => ({
        title, company: 'Acme', location: 'Remote', salary, snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today', isTargetRoleMatch: false,
      });
      // idx0 strong+highpay+Brand, idx1 strong+lowpay+Growth, idx2 weak+nopay+Brand
      const displayedJobs = [
        mk('Brand Lead', 92, '$150,000 a year', 'https://jobs/0'),
        mk('Growth Mgr', 88, '$70,000 a year', 'https://jobs/1'),
        mk('Brand Intern', 30, '', 'https://jobs/2'),
      ];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [
            { label: 'Strong (70–100%)', minScore: 70, maxScore: 100 },
            { label: 'Long shot (0–69%)', minScore: 0, maxScore: 69 },
          ],
          salaryRanges: [
            { label: '$100k+', minSalary: 100000, maxSalary: 0 },
            { label: '$50-100k', minSalary: 50000, maxSalary: 100000 },
            { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
          ],
          roles: [
            { name: 'Brand Marketing', jobIndices: [0, 2] },
            { name: 'Growth', jobIndices: [1] },
          ],
        },
        profile: { skills: ['x'] },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-h',
      });
      const byKind = (k) => result.newNodes.filter(n => n.data?.kind === k);
      const cards = result.newNodes.filter(n => n.type === 'jobcard');
      const bands = byKind('likelihood');
      const salary = byKind('salary');
      const roles = byKind('role');
      assert(cards.length === 3, `hierarchy: expected 3 cards, got ${cards.length}`);
      // Two bands present (Strong has 2 jobs, Long shot has 1).
      assert(bands.length === 2, `hierarchy: expected 2 likelihood bands, got ${bands.length}`);
      const strong = bands.find(b => b.data.label.startsWith('Strong'));
      const longshot = bands.find(b => b.data.label.startsWith('Long shot'));
      assert(strong.data.count === 2 && longshot.data.count === 1, `hierarchy: band counts wrong (${strong.data.count}/${longshot.data.count})`);
      // Bands are roots (children of hub, not of any group) and ordered best-first.
      assert(strong.position.y < longshot.position.y, 'hierarchy: Strong band should sit above Long shot');
      // Strong band → two salary ranges ($100k+ for idx0, $50-100k for idx1).
      const strongRanges = salary.filter(s => (strong.data.childIds || []).includes(s.id));
      assert(strongRanges.length === 2, `hierarchy: Strong band should have 2 salary ranges, got ${strongRanges.length}`);
      // Highest salary range ordered first WITHIN the band — checked via
      // childIds order, since nothing auto-expands at analysis end so the salary
      // nodes (hidden under the collapsed band) have no laid-out position.
      const hi = strongRanges.find(s => s.data.label === '$100k+');
      const lo = strongRanges.find(s => s.data.label === '$50-100k');
      assert(strong.data.childIds[0] === hi.id && strong.data.childIds[1] === lo.id, 'hierarchy: higher salary range should be ordered first within the band');
      // idx2 (no salary, weak) lands in the Long shot band's Unspecified range.
      const lsRange = salary.find(s => (longshot.data.childIds || []).includes(s.id));
      assert(lsRange.data.label === 'Unspecified', 'hierarchy: no-salary job should land in Unspecified');
      // Role leaves hold the cards.
      assert(roles.every(r => (r.data.childIds || []).every(cid => cards.some(c => c.id === cid))), 'hierarchy: role children should be cards');
      assert(result.scoreRangeMin === 30 && result.scoreRangeMax === 92, 'hierarchy: score range from displayed jobs');
      return { cards: cards.length, bands: bands.length, salary: salary.length, roles: roles.length };
    },
  },
  {
    name: 'Job tree: fully collapsed at analysis end (no auto-expand)',
    run: () => {
      const mk = (title, score, url) => ({
        title, company: 'Acme', location: 'Remote', salary: '$120k', snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today', isTargetRoleMatch: false,
      });
      const displayedJobs = [mk('Weak', 40, 'https://jobs/lo'), mk('Strong', 95, 'https://jobs/hi')];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [
            { label: 'Strong (70–100%)', minScore: 70, maxScore: 100 },
            { label: 'Possible (0–69%)', minScore: 0, maxScore: 69 },
          ],
          salaryRanges: [{ label: '$100k+', minSalary: 100000, maxSalary: 0 }, { label: 'Unspecified', minSalary: 0, maxSalary: 0 }],
          roles: [{ name: 'Role A', jobIndices: [0, 1] }],
        },
        profile: { skills: ['x'] },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-c',
      });
      const bands = result.newNodes.filter(n => n.data?.kind === 'likelihood');
      const nonBandGroups = result.newNodes.filter(n => n.type === 'jobgroup' && n.data?.kind !== 'likelihood');
      const cards = result.newNodes.filter(n => n.type === 'jobcard');
      const strong = bands.find(b => b.data.label.startsWith('Strong'));
      const possible = bands.find(b => b.data.label.startsWith('Possible'));
      // Nothing is expanded — the whole tree is closed when analysis ends.
      assert(result.newNodes.every(n => !n.data?.expanded), 'collapsed: no node should be expanded');
      // Band roots are visible (collapsed pills); everything below is hidden.
      assert(bands.every(b => b.hidden === false), 'collapsed: band roots should be visible');
      assert(nonBandGroups.every(g => g.hidden === true), 'collapsed: salary/role groups should be hidden');
      assert(cards.every(c => c.hidden === true), 'collapsed: all cards should be hidden');
      // Bands still ordered best-first and stacked (layout pass runs regardless).
      assert(strong.position.y < possible.position.y, 'collapsed: Strong band should still sit above Possible');
      return { ok: true };
    },
  },
  {
    name: 'Job tree layout positions',
    run: () => {
      const nodes = [
        { id: 'hub', type: 'jobhub', position: { x: 10, y: 20 }, data: {} },
        { id: 'L', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['S'], expanded: true } },
        { id: 'S', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', childIds: ['R'], expanded: true } },
        { id: 'R', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['job-1', 'job-2'], expanded: true, visibleCount: 1 } },
        { id: 'job-1', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
        { id: 'job-2', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
      ];
      const positions = computeLayoutPositions(nodes, 'hub', COL_X, { x: 10, y: 20 });
      assert(positions.L?.x === 10 + COL_X.likelihood && positions.L?.y === 20, 'layout: likelihood position mismatch');
      assert(positions.S?.x === 10 + COL_X.salary && positions.S?.y === 20, 'layout: salary position mismatch');
      assert(positions.R?.x === 10 + COL_X.role && positions.R?.y === 20, 'layout: role position mismatch');
      assert(positions['job-1']?.x === 10 + COL_X.job && positions['job-1']?.y === 20, 'layout: visible job position mismatch');
      assert(!positions['job-2'], 'layout: hidden overflow job (past visibleCount) should not be positioned');
      return positions;
    },
  },
  {
    name: 'Application: résumé document scaffold',
    run: () => {
      const doc = buildResumeDocument('<main class="page" data-print="ink-only"><h1 class="name">Jane</h1></main>');
      assert(/^<!doctype html>/i.test(doc.trim()), 'resume doc: missing doctype');
      assert(doc.includes('<link rel="stylesheet" href="colors_and_type.css">'), 'resume doc: missing tokens stylesheet');
      assert(doc.includes('<link rel="stylesheet" href="resume.css">'), 'resume doc: missing component stylesheet');
      assert(doc.includes('data-print="ink-only"') && doc.includes('Jane'), 'resume doc: lost the <main> block');
      // A model that mistakenly returns a full fenced document is normalized to
      // exactly one <main> inside our scaffold.
      const fenced = buildResumeDocument('```html\n<html><body><main class="page">X</main></body></html>\n```');
      const mainCount = (fenced.match(/<main/gi) || []).length;
      assert(mainCount === 1 && fenced.includes('>X</main>'), 'resume doc: should extract a single <main> from a fenced full doc');
      return { ok: true };
    },
  },
  {
    name: 'Application: variant attrs mirror résumé',
    run: () => {
      assert(extractVariantAttrs('<main class="page" data-print="ink-only" data-mono>') === 'data-print="ink-only" data-mono', 'variant: ink-only + mono');
      // dual-pdf is the design system default — present even when the model
      // omits data-print (and when it only sets paper size).
      assert(extractVariantAttrs('<main class="page" data-page="a4">') === 'data-print="dual-pdf" data-page="a4"', 'variant: a4 defaults to dual-pdf');
      assert(extractVariantAttrs('<main class="page" data-print="dual-pdf">') === 'data-print="dual-pdf"', 'variant: dual-pdf preserved');
      assert(extractVariantAttrs('<main class="page">') === 'data-print="dual-pdf"', 'variant: plain → dual-pdf default');
      // isDualMode gates the OCG cream post-process.
      assert(isDualMode('data-print="dual-pdf"') === true, 'isDualMode: dual-pdf → true');
      assert(isDualMode('data-print="ink-only" data-mono') === false, 'isDualMode: ink-only → false');
      return { ok: true };
    },
  },
  {
    name: 'Application: cover letter builder',
    run: () => {
      const html = buildCoverLetterDocument({
        name: 'Jane Doe',
        tagline: 'Product Marketer',
        contact: ['Austin, TX', 'jane@x.com'],
        date: 'May 31, 2026',
        recipient: 'Hiring Team\nAcme',
        salutation: 'Dear Acme Team,',
        paragraphs: ['I love <Acme> & your work.', 'Second para.', '   '],
        closing: 'Sincerely,',
      }, 'data-print="ink-only"');
      assert(html.includes('Jane Doe') && html.includes('Product Marketer'), 'cover: letterhead missing');
      assert(html.includes('data-print="ink-only"'), 'cover: variant not mirrored onto <main>');
      // User text is HTML-escaped (no markup injection from model output).
      assert(html.includes('I love &lt;Acme&gt; &amp; your work.'), 'cover: body not HTML-escaped');
      // Blank/whitespace-only paragraphs dropped; body uses bare <p> (heading
      // paragraphs use <p class=…>, so this count isolates the body).
      const bodyParas = (html.match(/<p>/g) || []).length;
      assert(bodyParas === 2, `cover: expected 2 body paragraphs, got ${bodyParas}`);
      assert(html.includes('jane@x.com') && html.includes('class="sep"'), 'cover: contact line missing separators');
      // Sensible fallbacks when optional fields are omitted.
      const bare = buildCoverLetterDocument({ name: 'X' });
      assert(bare.includes('Dear Hiring Team,') && bare.includes('Sincerely,'), 'cover: missing salutation/closing fallback');
      return { ok: true };
    },
  },
  {
    name: 'Gemini JSON parsing',
    run: () => {
      const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      // Plain object, markdown-fenced, and trailing-comma cleanup.
      assert(eq(parseGeminiJSON('{"a":1}'), { a: 1 }), 'parseGeminiJSON: plain object');
      assert(eq(parseGeminiJSON('```json\n{"a":1}\n```'), { a: 1 }), 'parseGeminiJSON: fenced object');
      assert(eq(parseGeminiJSON('{"a":1,}'), { a: 1 }), 'parseGeminiJSON: trailing comma');
      // Top-level arrays must NOT be mangled (guards the fallback against
      // starting the span at the first inner brace).
      assert(eq(parseGeminiJSON('[{"a":1},{"b":2}]'), [{ a: 1 }, { b: 2 }]), 'parseGeminiJSON: top-level array');
      // Regression: prose containing a stray bracket before the JSON object used
      // to make the first-open/last-close span start at the stray '[' and throw.
      assert(eq(parseGeminiJSON('Use [ ] for arrays: {"status":"ok"}'), { status: 'ok' }), 'parseGeminiJSON: stray bracket in prose');
      return { ok: true };
    },
  },
  {
    name: 'SITE_CHANGED diagnostic on empty page',
    run: () => {
      // The throw site fires only when extraction returns 0; it must append the
      // decisive facts (candidate count, path, login-wall flag) so a bug report
      // can tell a login wall / empty anon page from a genuine selector change —
      // without the user pasting page HTML.
      const evalThrow = (extractor, html, url) => {
        const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
        try { dom.window.eval(extractor); return null; }
        catch (e) { return e.message; }
      };

      // (a) Login wall: no listing cards + a /login URL + password field →
      //     cards=0 and the LOGIN-WALL flag (→ "log in", not a code bug).
      const loginMsg = evalThrow(
        POSHMARK_SOLD_EXTRACTOR,
        '<html><head><title>Login | Poshmark</title></head><body><input type="password"></body></html>',
        'https://poshmark.com/login',
      );
      assert(loginMsg && /SITE_CHANGED/.test(loginMsg), `poshmark empty page should throw SITE_CHANGED → ${loginMsg}`);
      assert(/\[diag /.test(loginMsg), `diag block missing → ${loginMsg}`);
      assert(/cards=0/.test(loginMsg), `expected cards=0 → ${loginMsg}`);
      assert(/LOGIN-WALL/.test(loginMsg), `expected LOGIN-WALL flag → ${loginMsg}`);

      // (b) Real results page whose tile selectors changed: candidate cards
      //     present but our sub-selectors match 0 → cards>0, titleSel=0, NO
      //     login flag (→ a genuine redesign; says exactly what to fix).
      const redesignMsg = evalThrow(
        POSHMARK_SOLD_EXTRACTOR,
        '<html><head><title>Search</title></head><body>' +
          '<div data-et-name="listing"></div><div data-et-name="listing"></div></body></html>',
        'https://poshmark.com/search?query=x',
      );
      assert(/cards=2/.test(redesignMsg), `expected cards=2 → ${redesignMsg}`);
      assert(/titleSel=0/.test(redesignMsg), `expected titleSel=0 → ${redesignMsg}`);
      assert(!/LOGIN-WALL/.test(redesignMsg), `should NOT flag login on a real search page → ${redesignMsg}`);

      // (c) Card class skeleton: a renamed card whose OLD sub-selectors all miss
      //     still surfaces the NEW class names via card0=[…] — so a selector
      //     rewrite is derivable from the bug report without pasting page HTML.
      const renamedMsg = evalThrow(
        POSHMARK_SOLD_EXTRACTOR,
        '<html><head><title>Search</title></head><body>' +
          '<div data-et-name="listing" class="tile__v2"><a href="/listing/x"><div class="tile__v2-title">iPhone</div>' +
          '<span class="tile__v2-price">$500</span></a></div></body></html>',
        'https://poshmark.com/search?query=x',
      );
      assert(/card0=\[/.test(renamedMsg), `expected card0 skeleton → ${renamedMsg}`);
      assert(/tile__v2-title/.test(renamedMsg) && /tile__v2-price/.test(renamedMsg),
        `skeleton should expose the new class names → ${renamedMsg}`);

      // The other throwing extractors also carry the diag block.
      for (const [label, ex] of [['ebay-sold', EBAY_SOLD_EXTRACTOR], ['ebay-active', EBAY_ACTIVE_EXTRACTOR], ['mercari', MERCARI_SOLD_EXTRACTOR]]) {
        const m = evalThrow(ex, '<html><body></body></html>', 'https://example.com');
        assert(m && /\[diag .*cards=0/.test(m), `${label} diag missing cards=0 → ${m}`);
      }
      return { ok: true };
    },
  },
  {
    name: 'extraction yield (noFields) surfaces partial per-card drift',
    run: () => {
      // The gap this guards: a sub-selector (e.g. price) drifts for SOME cards,
      // so items.length stays > 0 (no SITE_CHANGED throw) but a chunk of the
      // page is silently dropped. yieldStats.{seen,noFields} makes that visible.
      const listing = (slug, withPrice) =>
        `<div data-et-name="listing"><a href="/listing/${slug}">` +
        `<div class="tile-grid-redesign__title">iPhone XS</div>` +
        (withPrice ? `<span class="tile-grid-redesign__price-current">$200</span>` : '') +
        `</a></div>`;
      // 2 complete cards + 1 with title+link but NO price → kept=2, noFields=1, seen=3.
      const html = '<html><head><title>Search</title></head><body>' +
        listing('a', true) + listing('b', true) + listing('c', false) + '</body></html>';
      const dom = new JSDOM(html, { url: 'https://poshmark.com/search?query=x&availability=sold_out', runScripts: 'outside-only' });
      const out = dom.window.eval(POSHMARK_SOLD_EXTRACTOR);
      assert(out && Array.isArray(out.items), 'poshmark extractor should return { items }');
      assert(out.items.length === 2, `expected 2 kept items, got ${out.items.length}`);
      assert(out.yieldStats && out.yieldStats.seen === 3, `expected seen=3 (cards on page), got ${out.yieldStats?.seen}`);
      assert(out.yieldStats.noFields === 1, `expected noFields=1 (the price-less card), got ${out.yieldStats?.noFields}`);

      // A fully healthy page reports noFields=0 (denominator == kept) so the
      // report stays quiet — only real drift produces a non-zero noFields.
      const cleanDom = new JSDOM(
        '<html><head><title>Search</title></head><body>' + listing('x', true) + listing('y', true) + '</body></html>',
        { url: 'https://poshmark.com/search?query=x&availability=sold_out', runScripts: 'outside-only' });
      const clean = cleanDom.window.eval(POSHMARK_SOLD_EXTRACTOR);
      assert(clean.items.length === 2 && clean.yieldStats.seen === 2 && clean.yieldStats.noFields === 0,
        `clean page should read seen=2 noFields=0, got seen=${clean.yieldStats?.seen} noFields=${clean.yieldStats?.noFields}`);
      return { ok: true, drift: out.yieldStats, clean: clean.yieldStats };
    },
  },
  {
    name: 'price parse: strikethrough/range second number is not fused onto the price',
    run: () => {
      // Regression for the Mercari "$3.0415" bug: an on-sale card renders the
      // current price AND the strikethrough original in the SAME node, and the old
      // greedy strip (replace(/[^0-9.]/g,'')) concatenated them — "$3.04"+"$15" →
      // 3.0415, and a whole-dollar "$110"+"$199" → a catastrophic 110199. __money
      // must capture only the FIRST money token (the current/sold price).
      const mcard = (id, priceInner) =>
        `<a href="/us/item/${id}/?ref=search_results"><img alt="Apple iPhone XS 64GB Silver"/>` +
        `<p data-testid="ProductThumbItemPrice">${priceInner}</p></a>`;
      const mhtml = '<html><head><title>iPhone XS sold</title></head><body>' +
        mcard('m1', '$3.04 <span>$15</span>') +     // 2-decimal current + higher original
        mcard('m2', '$110 <span>$199</span>') +     // WHOLE-dollar current → old code → 110199
        '</body></html>';
      const mdom = new JSDOM(mhtml, { url: 'https://www.mercari.com/search/?keyword=iphone%20xs&status=sold_out', runScripts: 'outside-only' });
      const mout = mdom.window.eval(MERCARI_SOLD_EXTRACTOR);
      const mprices = mout.items.map(i => i.price);
      assert(mprices.includes(3.04), `Mercari current price should be 3.04 (not 3.0415), got ${mprices.join(',')}`);
      assert(mprices.includes(110), `Mercari whole-dollar current should be 110 (not 110199), got ${mprices.join(',')}`);
      assert(mprices.every(p => p < 1000), `no fused price should survive, got ${mprices.join(',')}`);

      // eBay price ranges ("$10.00 to $20.00") are the same hazard — take the low end.
      const ehtml = '<html><head><title>eBay</title></head><body><ul class="srp-results">' +
        '<li class="s-card"><span class="su-styled-text primary">Apple iPhone XS</span>' +
        '<div class="s-card__price">$10.00 to $20.00</div>' +
        '<a class="s-card__link" href="https://www.ebay.com/itm/123"></a></li>' +
        '</ul></body></html>';
      const edom = new JSDOM(ehtml, { url: 'https://www.ebay.com/sch/i.html?_nkw=x&_sop=15', runScripts: 'outside-only' });
      const eout = edom.window.eval(EBAY_ACTIVE_EXTRACTOR);
      assert(eout.items[0].price === 10, `eBay range should parse the low end 10 (not 10.002), got ${eout.items[0]?.price}`);
      return { ok: true, mercari: mprices, ebayRange: eout.items[0].price };
    },
  },
  {
    name: 'drift telemetry: Mercari counts missing-title cards in noFields',
    run: () => {
      // Mercari: title comes solely from img[alt]. A card whose image/alt drifts
      // must count toward noFields (not silently vanish), matching the renderer's
      // advertised "price/title/link" drift semantics.
      const mcard = (id, withImg, priceTxt) =>
        `<a href="/us/item/${id}/"><div>` +
        (withImg ? `<img alt="Apple iPhone XS 64GB Silver"/>` : '') +
        `<p>${priceTxt}</p></div></a>`;
      const mhtml = '<html><head><title>iPhone XS sold</title></head><body>' +
        mcard('a', true, '$100') + mcard('b', true, '$120') +
        mcard('c', false, '$130') +   // valid price but NO img[alt] → title drift → counted
        '</body></html>';
      const mdom = new JSDOM(mhtml, { url: 'https://www.mercari.com/search/?keyword=x&status=sold_out', runScripts: 'outside-only' });
      const mout = mdom.window.eval(MERCARI_SOLD_EXTRACTOR);
      assert(mout.items.length === 2, `Mercari: expected 2 kept (title-less dropped), got ${mout.items.length}`);
      assert(mout.yieldStats.seen === 3, `Mercari: expected seen=3, got ${mout.yieldStats?.seen}`);
      assert(mout.yieldStats.noFields === 1, `Mercari: title-less card must count toward noFields=1, got ${mout.yieldStats?.noFields}`);
      return { ok: true, mercari: mout.yieldStats };
    },
  },
  {
    name: 'priceChartingQuery strips listing cruft but keeps price-distinct edition tokens',
    run: () => {
      // The reported case: a seller title finds 0 exact + 100 fuzzy. Strip
      // capacity/condition/"Console"/separator → canonical product name. KEEP
      // "Digital Edition" (a distinct SKU ~$80–100 below the Disc edition).
      const ps5 = priceChartingQuery('Sony PlayStation 5 Digital Edition 1TB Console - Certified Refurbished');
      assert(ps5 === 'Sony PlayStation 5 Digital Edition', `PS5 query → "${ps5}"`);
      // Capacity stripped, variant token (OLED) kept.
      assert(priceChartingQuery('Nintendo Switch OLED 64GB') === 'Nintendo Switch OLED', `switch → "${priceChartingQuery('Nintendo Switch OLED 64GB')}"`);
      // Intra-word hyphen preserved (only space-padded listing dashes removed).
      assert(priceChartingQuery("Marvel's Spider-Man") === "Marvel's Spider-Man", `hyphen → "${priceChartingQuery("Marvel's Spider-Man")}"`);
      // All-cruft never reduces to empty — falls back to the original trimmed.
      assert(priceChartingQuery('  Used Console  ') === 'Used Console', `all-cruft fallback → "${priceChartingQuery('  Used Console  ')}"`);
      // A plain game title is untouched.
      assert(priceChartingQuery('Gears of War 4') === 'Gears of War 4', 'plain game title unchanged');
      return { ok: true, ps5 };
    },
  },
  {
    name: 'parsePriceChartingHtml extracts server-rendered prices (the bot-gated-JS workaround)',
    run: () => {
      // PriceCharting moved off the stealth browser to a direct HTTP fetch because
      // its client-side JS blanks the prices under automation. The prices are
      // server-rendered into <span class="js-price"> — verified by curl — so this
      // parses the raw HTML directly. Mirrors the real row markup.
      const row = (id, slug, name, used, cib, neu) =>
        `<tr id="product-${id}" data-product="${id}">` +
        `<td class="image"><a href="https://www.pricecharting.com/game/${slug}"></a></td>` +
        `<td class="title"><a href="https://www.pricecharting.com/game/${slug}" title="${id}">${name}</a>` +
        `<div class="console-in-title"><a href="/console/playstation-5">Playstation 5</a></div></td>` +
        `<td class="console">Playstation 5</td>` +
        `<td class="price numeric used_price"><span class="js-price">${used}</span></td>` +
        `<td class="price numeric cib_price"><span class="js-price">${cib}</span></td>` +
        `<td class="price numeric new_price"><span class="js-price">${neu}</span></td></tr>`;
      const html = '<html><head><title>PS5 Digital Price</title></head><body><table id="games_table"><tbody>' +
        '<tr><th>&nbsp;</th><th>Title</th><th>Loose</th><th>CIB</th><th>New</th></tr>' +   // header → no td.title a, skipped
        row('6179528', 'playstation-5/playstation-5-slim-digital-edition', 'Playstation 5 Slim Digital Edition', '$366.55', '$401.93', '$524.25') +
        row('37393', 'playstation-4/playstation-4-pro-1tb-console', 'Playstation 4 Pro 1TB Console', '$144.98', '$167.20', '$413.56') +
        row('9999', 'playstation-5/ps5-cover-plate', 'Digital Edition Console Cover', '', '', '') +   // unpriced accessory → skipped
        row('6179528', 'playstation-5/playstation-5-slim-digital-edition', 'Dup row', '$366.55', '', '') +  // dup URL → deduped
        '</tbody></table></body></html>';
      const comps = parsePriceChartingHtml(html);
      assert(comps.length === 2, `expected 2 comps (header/unpriced/dup excluded), got ${comps.length}`);
      // Takes the FIRST (loose/used) price column, not CIB/new.
      assert(comps[0].price === 366.55 && comps[0].priceText === '$366.55', `loose price first → ${JSON.stringify(comps[0])}`);
      assert(comps[0].title === 'Playstation 5 Slim Digital Edition' && comps[0].source === 'pricecharting', `title/source → ${JSON.stringify(comps[0])}`);
      assert(comps[0].url === 'https://www.pricecharting.com/game/playstation-5/playstation-5-slim-digital-edition', `absolute url → ${comps[0].url}`);
      assert(comps[1].price === 144.98, `second comp loose price → ${comps[1].price}`);
      // Empty / off-category HTML → no comps, no throw.
      assert(parsePriceChartingHtml('<html><body><table id="games_table"><tbody></tbody></table></body></html>').length === 0, 'empty table → 0 comps');
      assert(parsePriceChartingHtml('').length === 0, 'empty string → 0 comps');
      return { ok: true, prices: comps.map(c => c.price) };
    },
  },
  {
    name: 'Swappa SOLD extractor parses /xui sales fragment',
    run: () => {
      // Swappa's /listings page (active source) is asking prices; the REAL sold
      // data is the /xui/product/<slug>/sales HTMX fragment — one <tr> per
      // completed sale: date · condition · carrier · storage ·
      // <a href="/listing/view/<id>">$price</a>. Step 1 of the extractor parses
      // such a fragment directly (no fetch), which is what we assert here.
      const row = (date, cond, carrier, storage, id, price) =>
        `<tr><td>${date}</td><td>${cond}</td><td>${carrier}</td><td>${storage}</td>` +
        `<td><a href="/listing/view/${id}" title="View Sold Listing">$${price}</a></td></tr>`;
      const html = '<html><head><title>Apple iPhone X Sales</title></head><body><table class="table fs-sm"><tbody>' +
        row('May 29', 'Good', 'Unlocked', '64 GB', 'LAFB09505', 99) +
        row('May 28', 'Good', 'Unlocked', '256 GB', 'LAFM79221', 114) +
        row('May 26', 'Fair', 'Unlocked Non-US', '256 GB', 'LAES54888', 47) +
        row('May 29', 'Good', 'Unlocked', '64 GB', 'LAFB09505', 99) +   // duplicate listing → must dedup by URL
        '</tbody></table></body></html>';
      const dom = new JSDOM(html, { url: 'https://swappa.com/xui/product/apple-iphone-x/sales', runScripts: 'outside-only' });
      const out = dom.window.eval(SWAPPA_SOLD_EXTRACTOR);
      assert(Array.isArray(out) && out.length === 3, `expected 3 sold comps after deduping the repeated listing, got ${out && out.length}`);
      const first = out[0];
      assert(first.source === 'swappa-sold', `wrong source ${first.source}`);
      assert(first.price === 99 && first.priceText === '$99', `wrong price ${first.priceText}`);
      assert(first.url === 'https://swappa.com/listing/view/LAFB09505', `wrong url ${first.url}`);
      assert(first.condition === 'Good' && first.soldDate === 'May 29', `wrong condition/date ${first.condition}/${first.soldDate}`);
      // Title is built from the slug (model name) + the row's spec columns, since
      // the sales fragment carries no model name of its own.
      assert(/iphone x/i.test(first.title) && /64 gb/i.test(first.title) && /unlocked/i.test(first.title),
        `title should carry model + storage + carrier → ${first.title}`);
      // Distinct prices preserved (incl. the low Non-US outlier) — no collapsing.
      assert(out.map(c => c.price).join(',') === '99,114,47', `prices mismatch → ${out.map(c => c.price).join(',')}`);
      return { ok: true, count: out.length, sample: first };
    },
  },
  {
    name: 'Reverb SOLD price-guide mapping (real sales, not live retail)',
    run: () => {
      // Reverb's /listings/all only returns LIVE listings (state=sold/ended are
      // silently ignored → brand-new retail prices). Real sold data is the Price
      // Guide: selectReverbPriceGuides picks the matching guide; then
      // reverbTransactionsToComps maps its completed transactions (price_final).
      const guides = [
        { id: 81477, title: 'Yamaha A3R-VN Dreadnought with Electronics 2010s Vintage Natural', make: 'Yamaha', model: 'A3R-VN Dreadnought with Electronics', finish: 'Vintage Natural', _links: { web: { href: 'https://reverb.com/price-guide/guide/81477-yamaha-a3r-vn' } } },
        { id: 100299, title: 'Yamaha LS6M ARE 2020s Natural', make: 'Yamaha', model: 'LS6M ARE', finish: 'Natural' }, // shares yamaha+are but WRONG model
        { id: 999, title: 'Fender Stratocaster American Pro', make: 'Fender', model: 'Stratocaster', finish: 'Sunburst' },
      ];
      const picked = selectReverbPriceGuides('Yamaha A3R ARE', guides);
      assert(picked.length === 1 && picked[0].id === 81477,
        `should pick only the A3R guide — NOT the LS6M ARE on the generic 'yamaha'/'are' tokens, got ${picked.map(g => g.id).join(',')}`);
      assert(selectReverbPriceGuides('Gibson Les Paul', guides).length === 0, 'unrelated query should match no guide (no pricing the wrong instrument)');

      const txs = [
        { date: '2025-07-31', condition: 'Excellent', order_id: 23592701, price_ask: { amount: '575.00', display: '$575' }, price_final: { amount: '575.00', display: '$575' } },
        { date: '2025-05-13', condition: 'Mint', order_id: 23010111, price_final: { amount: '620.00', display: '$620' } },
        { date: '2025-05-13', condition: 'Mint', order_id: 23010111, price_final: { amount: '620.00', display: '$620' } }, // dup order_id → deduped
        { date: '2024-01-01', condition: 'Good', order_id: 1, price_final: { amount: '0.00', display: '$0' } },           // zero price → dropped
      ];
      const comps = reverbTransactionsToComps(picked[0], txs);
      assert(comps.length === 2, `expected 2 comps (dup + zero-price dropped), got ${comps.length}`);
      assert(comps.every(c => c.source === 'reverb'), 'source should be reverb');
      assert(comps[0].price === 575 && comps[0].condition === 'Excellent' && comps[0].soldDate === '2025-07-31', `wrong first comp ${JSON.stringify(comps[0])}`);
      assert(comps[0].title === 'Yamaha A3R-VN Dreadnought with Electronics 2010s Vintage Natural', `title should be the guide title → ${comps[0].title}`);
      // Each distinct sale gets the guide link + a unique #tx fragment, so the
      // pipeline's url-keyed dedup counts them as distinct (not "1 unique of N").
      assert(comps[0].url === 'https://reverb.com/price-guide/guide/81477-yamaha-a3r-vn#tx-23592701', `url should be guide link + tx fragment → ${comps[0].url}`);
      assert(comps[0].url !== comps[1].url, 'distinct sales must get distinct urls so uniqueCompCount does not collapse them');
      // The real sold figures ($575–620) are ~half the live-retail price (~$1180)
      // the broken /listings path returned — the whole point of this fix.
      assert(Math.max(...comps.map(c => c.price)) <= 620, 'sold comps should reflect used-market price, not new retail');
      return { ok: true, picked: picked[0].id, comps: comps.length, prices: comps.map(c => c.price) };
    },
  },
  {
    name: 'login auto-close: wait on captcha/challenge, not on logged-in home',
    run: () => {
      // MUST keep waiting (NOT auto-close) — the user is mid human-verification.
      const challenge = [
        'https://www.ebay.com/splashui/captcha?ap=1&appName=orch&ru=https%3A%2F%2Fsignin.ebay.com%2Fsignin', // the reported eBay bug
        'https://www.depop.com/signup/google/',          // OAuth signup interstitial
        'https://www.linkedin.com/checkpoint/challenge/', // LinkedIn challenge
        'https://accounts.google.com/signin/v2/challenge/ipp',
        'https://example.com/account/verify-email',
        'https://example.com/login/2fa',
      ];
      for (const u of challenge) assert(isAuthChallengeUrl(u), `should WAIT (challenge) on ${u}`);

      // MUST NOT match — these are real logged-in landings; auto-close should fire.
      const loggedIn = [
        'https://www.ebay.com/', 'https://www.ebay.com/mye/myebay/summary',
        'https://poshmark.com/feed', 'https://www.mercari.com/mypage/',
        'https://www.facebook.com/', 'https://swappa.com/', 'https://reverb.com/',
        'https://www.depop.com/', 'https://www.linkedin.com/feed',
        'https://www.ziprecruiter.com/jobseeker/home', 'https://www.glassdoor.com/member/home/index.htm',
      ];
      for (const u of loggedIn) assert(!isAuthChallengeUrl(u), `should NOT block auto-close on logged-in home ${u}`);
      return { ok: true };
    },
  },
  {
    name: 'hard login preflight (missing logins)',
    run: () => {
      const eqSet = (a, b) => a.length === b.length && a.every(x => b.includes(x));
      // Test mode scoped to poshmark, logged out → poshmark required & missing.
      assert(eqSet(computeMissingLogins([{ id: 'poshmark' }], { poshmark: { connected: false } }), ['poshmark']),
        'scoped poshmark logged-out → [poshmark]');
      // Same source logged in → nothing missing → run proceeds.
      assert(computeMissingLogins([{ id: 'poshmark' }], { poshmark: { connected: true } }).length === 0,
        'poshmark logged-in → no missing');
      // Full run: ebay-sold+ebay-active dedupe to one 'ebay'; only logged-out platforms returned.
      const full = computeMissingLogins(
        [{ id: 'ebay-sold' }, { id: 'ebay-active' }, { id: 'poshmark' }, { id: 'mercari' }, { id: 'pricecharting' }],
        { ebay: { connected: false }, poshmark: { connected: false }, mercari: { connected: true } },
      );
      assert(eqSet(full, ['ebay', 'poshmark']), `full run missing → ebay,poshmark (deduped, mercari ok, pricecharting no-login) → ${full}`);
      // A no-login-platform source (pricecharting) never imposes a requirement.
      assert(computeMissingLogins([{ id: 'pricecharting' }], {}).length === 0, 'pricecharting → no login requirement');
      return { ok: true };
    },
  },
  {
    name: 'comp scrape login-vs-selectors classification',
    run: () => {
      const SC = (extra) => `SITE_CHANGED: poshmark tile-grid-redesign extractor returned 0 — selectors or page structure may have changed [diag ${extra}]`;
      const loggedOut = { poshmark: { connected: false } };
      const loggedIn  = { poshmark: { connected: true } };

      // (a) Page-level login wall → promoted to login-required (sign in, don't fix selectors).
      const wall = classifyCompScrapeFailure(SC('cards=0 titleSel=0 path=/login LOGIN-WALL/anon-page'), 'poshmark', loggedOut);
      assert(wall.code === 'login-required' && wall.severity === 'block', `login wall → login-required, got ${wall.code}`);
      assert(/log in to poshmark/i.test(wall.suggestion), `login-required suggestion should name the platform → ${wall.suggestion}`);

      // (b) Real redesign (cards present, sub-selector gone) while logged IN → stale-selectors, no login noise.
      const redesign = classifyCompScrapeFailure(SC('cards=24 titleSel=0'), 'poshmark', loggedIn);
      assert(redesign.code === 'stale-selectors', `redesign → stale-selectors, got ${redesign.code}`);
      assert(!/log in/i.test(redesign.suggestion), `logged-in redesign must not suggest login → ${redesign.suggestion}`);

      // (c) No hard login wall but the platform isn't connected → still stale-selectors,
      //     but the suggestion nudges toward logging in first (softer corroborator).
      const ambiguous = classifyCompScrapeFailure(SC('cards=0 titleSel=0 path=/search'), 'poshmark', loggedOut);
      assert(ambiguous.code === 'stale-selectors', `ambiguous → stale-selectors, got ${ambiguous.code}`);
      assert(/not logged in/i.test(ambiguous.suggestion), `logged-out ambiguous should mention login → ${ambiguous.suggestion}`);

      // (d) A navigation TIMEOUT is its own bucket — NOT 'task-failed' (which implies
      //     a profile-lock/browser conflict). A 45s hang is a slow/hung site or tarpit.
      const timeout = classifyCompScrapeFailure('Scrape timed out after 45000ms for https://poshmark.com/search', 'poshmark', loggedOut);
      assert(timeout.code === 'scrape-timeout', `timeout → scrape-timeout, got ${timeout.code}`);
      assert(/tarpit/i.test(timeout.suggestion) && !/profile-lock conflict\.?$/i.test(timeout.suggestion), `timeout suggestion should say tarpit, not profile-lock → ${timeout.suggestion}`);
      assert(/not logged in/i.test(timeout.suggestion), `logged-out timeout should mention login → ${timeout.suggestion}`);

      // (e) A genuine internal throw (no "timeout" wording) → task-failed.
      const failed = classifyCompScrapeFailure('Protocol error: Target closed', 'poshmark', loggedOut);
      assert(failed.code === 'task-failed', `internal throw → task-failed, got ${failed.code}`);
      return { ok: true };
    },
  },
  {
    name: 'modelTag fallback reason',
    run: () => {
      // No model recorded → empty (older telemetry).
      assert(modelTag(null) === '', 'modelTag: null model is empty');
      // Top model, no fallback → bare model, no flags.
      assert(modelTag('gemini-3.1-pro-preview') === ' · model: `gemini-3.1-pro-preview`', 'modelTag: top model bare');
      // Lite model with no recorded reason → legacy bare weak-fallback flag.
      assert(modelTag('gemini-3.1-flash-lite') === ' · model: `gemini-3.1-flash-lite` ⚠️ weak fallback', 'modelTag: lite without reason');
      // Lite model WITH reason → reason is surfaced (the gap this closes): a
      // reader sees quota (external) vs truncation (our cap) without the logs.
      const quota = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit' });
      assert(quota.includes('⚠️ weak fallback (rate-limit: 3 stronger model(s) failed)'), `modelTag: lite with reason → ${quota}`);
      // Non-lite model that still fell back → lighter "↪ fell back" note.
      const partial = modelTag('gemini-3.5-flash', { attempts: 1, reason: 'truncation' });
      assert(partial.includes('↪ fell back (truncation: 1 stronger model(s) failed)'), `modelTag: non-lite partial fallback → ${partial}`);
      assert(!partial.includes('weak fallback'), 'modelTag: non-lite is not flagged weak');
      // MIXED chain (the reported trap): 2 quota + 1 truncation. `reason` alone
      // would say only "rate-limit" and hide the truncation (whose fix — raise our
      // cap — is the opposite of quota's). counts must drive a breakdown.
      const mixed = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit', counts: { 'rate-limit': 2, truncation: 1 } });
      assert(mixed.includes('rate-limit×2 + truncation×1: 3 stronger model(s) failed'), `modelTag: mixed chain must show breakdown → ${mixed}`);
      // Single-cause counts → no ×N noise, falls back to the plain reason.
      const single = modelTag('gemini-3.1-flash-lite', { attempts: 3, reason: 'rate-limit', counts: { 'rate-limit': 3 } });
      assert(single.includes('(rate-limit: 3 stronger model(s) failed)'), `modelTag: single-cause stays plain → ${single}`);
      return { ok: true };
    },
  },
  {
    name: 'over-priced recommendation sanity flag',
    run: () => {
      // The reported case: recommended $849 above the $846.59 sold max → flagged.
      const f = overPricedSoldFlag(849, { max: 846.59, median: 625 }, null);
      assert(f && /ABOVE the highest actual sold comp \(\$846\.59\)/.test(f) && /Median sold was \$625/.test(f),
        `should flag $849 over $846.59 (incl. median) → ${f}`);
      // Within the sold range → no flag.
      assert(overPricedSoldFlag(800, { max: 846.59, median: 625 }, null) === null, 'at/below sold max → no flag');
      // An active listing at/above the recommendation justifies it → suppressed.
      assert(overPricedSoldFlag(849, { max: 846.59 }, { max: 900 }) === null, 'active >= rec suppresses the flag');
      // Robust to missing/zero/null stats.
      assert(overPricedSoldFlag(849, null, null) === null, 'no sold stats → no flag');
      assert(overPricedSoldFlag(null, { max: 800 }, null) === null, 'null price → no flag');
      assert(overPricedSoldFlag(849, { max: 0 }, null) === null, 'zero sold max → no flag');
      return { ok: true };
    },
  },
  {
    name: 'shared-profile lock serializes browser launchers (Indeed vs manual scraper)',
    run: async () => {
      // Two launchers must NOT overlap on the shared Chrome profile — the second
      // can't start until the first fully settles (launch→scrape→close).
      const order = [];
      let releaseA;
      const aGate = new Promise(r => { releaseA = r; });
      const p1 = withSharedProfileLock(async () => { order.push('A-start'); await aGate; order.push('A-end'); return 'a'; });
      const p2 = withSharedProfileLock(async () => { order.push('B-start'); return 'b'; });
      // Flush microtasks: A may start, but B must still be queued behind it.
      await new Promise(r => setTimeout(r, 0));
      assert(order.join(',') === 'A-start', `B must not start until A ends — got [${order.join(',')}]`);
      releaseA();
      const [r1, r2] = await Promise.all([p1, p2]);
      assert(r1 === 'a' && r2 === 'b', 'each caller observes its own fn result');
      assert(order.join(',') === 'A-start,A-end,B-start', `B runs strictly after A — got [${order.join(',')}]`);
      // A rejection must NOT wedge the queue — the next acquirer still runs.
      const errMsg = await withSharedProfileLock(async () => { throw new Error('boom'); }).catch(e => e.message);
      const recovered = await withSharedProfileLock(async () => 'recovered');
      assert(errMsg === 'boom' && recovered === 'recovered', 'queue survives a rejected critical section');
      return { ok: true, order: order.join(',') };
    },
  },
  {
    name: 'job run staging: per-page ledger + resumable detection + cleanup',
    run: async () => {
      const dir = path.join(os.tmpdir(), `ic-jobstaging-${process.pid}`);
      fs.mkdirSync(dir, { recursive: true });
      const canvas = path.join(dir, 'test-canvas.json');
      const T0 = 1_000_000;   // fixed clock (test runner forbids Date.now())
      try {
        await startRun(canvas, { runId: 'r1', startedAt: T0, queries: ['swe'], sourceIds: ['indeed', 'google'] });
        await recordSourcePage(canvas, { sourceId: 'indeed', query: 'swe', page: 0, jobs: [{ title: 'A' }, { title: 'B' }], now: T0 + 1 });
        await recordSourcePage(canvas, { sourceId: 'indeed', query: 'swe', page: 1, jobs: [{ title: 'C' }], now: T0 + 2 });
        await markSourceStatus(canvas, 'indeed', 'done', T0 + 3);

        const staged = await readStagedJobs(canvas);
        assert(staged.length === 3 && staged[0].job.title === 'A' && staged[2].page === 1, `staged rows recovered (${staged.length})`);

        // recent + incomplete (stage still 'searching') → resumable, with ledger
        const st = await readRunState(canvas, T0 + 100);
        assert(st && st.incomplete && st.resumable, 'recent incomplete run is resumable');
        assert(st.manifest.sources.indeed.status === 'done', 'indeed marked done');
        assert(st.manifest.sources.indeed.queries.swe.lastPage === 1, 'indeed lastPage ledger = 1');
        assert(st.stagedJobs.length === 3, 'run state carries staged jobs');

        // older than the 24h window → still incomplete but NOT auto-resumable
        const stale = await readRunState(canvas, T0 + RESUMABLE_MAX_AGE_MS + 5);
        assert(stale.incomplete && !stale.resumable, 'stale run is not auto-resumable');

        // finished → not incomplete; clearRun removes both sidecars
        await setStage(canvas, 'done', T0 + 200);
        const done = await readRunState(canvas, T0 + 300);
        assert(done && !done.incomplete && !done.resumable, 'done run is not resumable');
        await clearRun(canvas);
        assert((await readRunState(canvas, T0 + 400)) === null, 'cleared run → null state');

        return { ok: true, staged: staged.length };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
  {
    // Regression: the per-source completion loop in jobs.js fires one
    // markSourceStatus per source WITHOUT awaiting — all concurrent. Before the
    // per-path mutex + unique tmp name, every write shared `<manifest>.<pid>.tmp`
    // so the first rename() won and the rest hit ENOENT (lost write), and stale
    // read-modify-write clobbered every source's status but the last. Fire many
    // concurrent writers and assert ALL land and `stage` is not reverted.
    name: 'job run staging: concurrent writers do not clobber or ENOENT',
    run: async () => {
      const dir = path.join(os.tmpdir(), `ic-jobstaging-conc-${process.pid}`);
      fs.mkdirSync(dir, { recursive: true });
      const canvas = path.join(dir, 'test-canvas.json');
      const T0 = 2_000_000;
      const sources = ['indeed', 'google', 'linkedin', 'remoteok', 'dice', 'glassdoor', 'ziprecruiter', 'weworkremotely', 'usajobs'];
      try {
        await startRun(canvas, { runId: 'rc', startedAt: T0, queries: ['swe'], sourceIds: sources });
        // All concurrent, no inter-await — exactly the jobs.js completion loop.
        await Promise.all([
          ...sources.map((s, i) => markSourceStatus(canvas, s, 'done', T0 + i + 1)),
          setStage(canvas, 'gathered', T0 + 100), // races the status writes
        ]);
        const st = await readRunState(canvas, T0 + 200);
        assert(st && st.manifest, 'manifest survived concurrent writes');
        const missing = sources.filter(s => st.manifest.sources[s]?.status !== 'done');
        assert(missing.length === 0, `every source persisted 'done' (missing: ${missing.join(',') || 'none'})`);
        assert(st.manifest.stage === 'gathered', `stage not reverted by a stale write (got '${st.manifest.stage}')`);
        return { ok: true, sources: sources.length };
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];

async function run() {
  let passed = 0;
  let failed = 0;

  console.log('\n[TEST RUNNER] Deterministic smoke tests\n');

  for (const test of tests) {
    try {
      const details = await test.run();
      console.log(`PASS ${test.name}`, details ? JSON.stringify(details) : '');
      passed++;
    } catch (error) {
      console.error(`FAIL ${test.name}: ${error.message}`);
      failed++;
    }
  }

  console.log(`\n[TEST RUNNER] ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error('[TEST RUNNER] Fatal error:', error);
  process.exitCode = 1;
});
