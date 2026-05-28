import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import {
  EBAY_ACTIVE_EXTRACTOR,
  EBAY_SOLD_EXTRACTOR,
  MERCARI_SOLD_EXTRACTOR,
  POSHMARK_SOLD_EXTRACTOR,
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
import {
  LIKELY_THRESHOLD,
  TARGET_BUCKETING_CATEGORY,
  buildJobsForBucketing,
  buildJobTreeNodes,
  computeLayoutPositions,
  partitionJobsForBranches,
  strongMatchGate,
} from '../src/nodes/jobhub/buildJobTree.js';
import { extractIndeedJobsFromHtml } from '../electron/extractors/apiExtractors.js';
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
import { compsForPricing, jobScoringBatchSize, JOB_MAX_PAGES, JOB_PER_PAGE_CAP } from '../electron/ipc/resultCaps.js';
import { applyBugReportCode, previewBugReportCode } from '../src/utils/bugReportCodes.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function runExtractorFixtureTest({ name, file, extractor, minCount = 1, sampleAssert = null }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  const result = dom.window.eval(extractor);
  assert(Array.isArray(result), `${name}: extractor did not return an array`);
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
  const result = dom.window.eval(extractor);
  assert(Array.isArray(result), `${name}: extractor did not return an array`);
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
      assert(compsForPricing(100, 100).sold === 25 && compsForPricing(100, 100).active === 15, 'Job date and cap helpers: comp caps mismatch');
      assert(jobScoringBatchSize() >= 5 && jobScoringBatchSize() <= 15, 'Job date and cap helpers: scoring batch out of bounds');
      assert(JOB_MAX_PAGES === 10 && JOB_PER_PAGE_CAP > 0, 'Job date and cap helpers: job caps unexpected');
      return { filtered: filtered.length, scoringBatch: jobScoringBatchSize() };
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
      assert(split.targetList.filter(j => j.strengthLabel === 'stretch').length === 4, 'Job target partitioning: sub-threshold target fillers should be marked stretch');
      assert(split.otherList.length === 2, `Job target partitioning: expected relaxed other list to include 2 jobs, got ${split.otherList.length}`);
      assert(partitionJobsForBranches(jobs, false).displayedJobs.length === jobs.length, 'Job target partitioning: no-target path should be passthrough');
      assert(LIKELY_THRESHOLD === 65, 'Job target partitioning: unexpected likely threshold');
      return { gate: split.gate, target: split.targetList.length, other: split.otherList.length };
    },
  },
  {
    name: 'Job bucketing input',
    run: () => {
      const target = { title: 'Director', company: 'Acme', url: 'https://jobs/1', careerDirection: 'Leadership', isTargetRoleMatch: true };
      const targetCasedDuplicate = { ...target, title: ' director ', company: 'ACME', url: 'HTTPS://JOBS/1' };
      const other = { title: 'Engineer', company: 'Acme', url: 'https://jobs/2', careerDirection: 'Engineering', isTargetRoleMatch: false };
      const input = buildJobsForBucketing([targetCasedDuplicate, other], [target], [target, other], true);
      assert(input[0].careerDirection === TARGET_BUCKETING_CATEGORY, 'Job bucketing input: target job should use synthetic target category');
      assert(input[1].careerDirection === 'Engineering', 'Job bucketing input: non-target job should keep original category');
      const passthrough = buildJobsForBucketing([target], [target], [target, other], false);
      assert(passthrough.length === 2 && passthrough[0] === target, 'Job bucketing input: no-target path should return original scored jobs');
      return { targetCategory: input[0].careerDirection, passthrough: passthrough.length };
    },
  },
  {
    name: 'Job tree graph builder',
    run: () => {
      const target = {
        title: 'Product Manager',
        company: 'Acme',
        location: 'Remote',
        salary: '$120k',
        snippet: 'Own roadmaps',
        matchScore: 88,
        reasoning: 'Strong match',
        careerDirection: TARGET_BUCKETING_CATEGORY,
        strengthLabel: 'strong',
        source: 'lever',
        url: 'https://jobs/pm',
        posted: 'today',
        isTargetRoleMatch: true,
      };
      const other = {
        ...target,
        title: 'Solutions Architect',
        url: 'https://jobs/sa',
        careerDirection: 'Engineering',
        isTargetRoleMatch: false,
      };
      const result = buildJobTreeNodes({
        scoredJobs: [target, other],
        bucketTree: [
          { name: TARGET_BUCKETING_CATEGORY, buckets: [{ label: 'Best Fits', jobIndices: [0] }] },
          { name: 'Engineering', buckets: [{ label: 'Adjacent', jobIndices: [1] }] },
        ],
        bucketingInput: [target, other],
        targetList: [target],
        otherList: [other],
        displayedJobs: [target, other],
        hasTarget: true,
        targetRole: 'Product Manager',
        profile: { skills: ['strategy'] },
        originalPos: { x: 10, y: 20 },
        hubId: 'hub-1',
        baseNodeId: 'job-test',
      });
      const jobCards = result.newNodes.filter(n => n.type === 'jobcard');
      const branches = result.newNodes.filter(n => n.type === 'jobgroup' && n.data.kind === 'branch');
      assert(jobCards.length === 2, `Job tree graph builder: expected 2 job cards, got ${jobCards.length}`);
      assert(branches.length === 2, `Job tree graph builder: expected 2 branch groups, got ${branches.length}`);
      assert(result.newEdges.length >= 4, `Job tree graph builder: expected structural edges, got ${result.newEdges.length}`);
      assert(result.scoreRangeMin === 88 && result.scoreRangeMax === 88, 'Job tree graph builder: expected score range from displayed jobs');
      return { nodes: result.newNodes.length, edges: result.newEdges.length, jobs: jobCards.length, scoreRangeMin: result.scoreRangeMin };
    },
  },
  {
    name: 'Job tree layout positions',
    run: () => {
      const nodes = [
        { id: 'hub', type: 'jobhub', position: { x: 10, y: 20 }, data: {} },
        { id: 'cat', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'category', childIds: ['buc'], expanded: true } },
        { id: 'buc', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'bucket', childIds: ['job-1', 'job-2'], expanded: true, visibleCount: 1 } },
        { id: 'job-1', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
        { id: 'job-2', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
      ];
      const positions = computeLayoutPositions(
        nodes,
        'hub',
        { category: 400, bucket: 700, job: 1100 },
        { x: 10, y: 20 },
      );
      assert(positions.cat?.x === 410 && positions.cat?.y === 20, 'Job tree layout positions: category position mismatch');
      assert(positions.buc?.x === 710 && positions.buc?.y === 20, 'Job tree layout positions: bucket position mismatch');
      assert(positions['job-1']?.x === 1110 && positions['job-1']?.y === 20, 'Job tree layout positions: visible job position mismatch');
      assert(!positions['job-2'], 'Job tree layout positions: hidden overflow job should not be positioned');
      return positions;
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
