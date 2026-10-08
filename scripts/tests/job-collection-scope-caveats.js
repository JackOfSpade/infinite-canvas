import { readFileSync } from 'node:fs';
import { assert } from './testHelpers.js';
import { __compactErrorStackForTests, buildJobTasks, claimJobAnalysisOperationAuthority, fs, ipcMain, markSourceStatus, os, path, readRunState, recordSourcePage, setStage, startRun } from '../test-dependencies.js';
import { registerJobsHandlers } from '../../electron/ipc/jobs.js';
import {
  COLLECTION_SCOPE_CAVEAT,
  collectionScopeCaveatsForSavedJobReanalysis,
  collectionScopeCaveatsFromCompletedManifestSources,
  collectionScopeCaveatsFromSourceResults,
  hasGlassdoorCountryScopeCaveat,
  hydrateCollectionScopeCaveatsIntoSourceResults,
  normalizeCollectionScopeCaveats,
} from '../../src/utils/jobCollectionScopeCaveats.js';
import { classifyLayoutWarning } from '../../src/utils/EventLogger.js';
import { writeApprovedCareerSnapshotFixture } from './careerSnapshotFixture.mjs';

export default [
  {
    name: 'Job Search collection scope caveat: nation-tier Glassdoor remains non-gating and bounded',
    run: () => {
      const caveats = collectionScopeCaveatsFromSourceResults({
        glassdoor: { locationScopeUnenforced: true },
        google: { locationScopeUnenforced: true },
      });
      assert(caveats.length === 1
        && caveats[0].sourceId === 'glassdoor'
        && caveats[0].code === COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED,
      'only the known Glassdoor nation-tier qualification may cross the process boundary');
      assert(hasGlassdoorCountryScopeCaveat(caveats), 'the UI predicate recognizes the trusted caveat');
      assert(!hasGlassdoorCountryScopeCaveat([{ sourceId: 'evil', code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED }]),
        'untrusted source IDs cannot forge the disclosure');
      assert(normalizeCollectionScopeCaveats([...caveats, ...caveats, { sourceId: 'glassdoor', code: 'unknown' }]).length === 1,
        'persisted caveats are de-duplicated and unknown records are discarded');
      assert(collectionScopeCaveatsFromSourceResults({ glassdoor: { locationScopeUnenforced: false } }).length === 0,
        'an enforced Glassdoor run adds no caveat');
      return { caveats: caveats.length };
    },
  },
  {
    name: 'Job Search collection scope caveat: saved-job re-analysis preserves the completed collection disclosure',
    run: () => {
      const prior = [{
        sourceId: 'glassdoor',
        code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED,
      }];
      const retained = collectionScopeCaveatsForSavedJobReanalysis({
        collectionScopeCaveats: [...prior, { sourceId: 'untrusted', code: 'ignored' }],
      });
      assert(retained.length === 1 && hasGlassdoorCountryScopeCaveat(retained),
        'a successful score-only re-analysis must retain the prior trusted scope disclosure');
      return { retained: retained.length };
    },
  },
  {
    name: 'Job Search collection scope caveat: resumed manifest hydration trusts only bounded completed Glassdoor data',
    run: () => {
      const caveat = {
        sourceId: 'glassdoor',
        code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED,
      };
      const forgedUnderIndeed = collectionScopeCaveatsFromCompletedManifestSources({
        indeed: { status: 'done', collectionScopeCaveats: [caveat] },
        glassdoor: { status: 'pending', collectionScopeCaveats: [] },
      });
      const noisyManifest = {
        glassdoor: {
          status: 'done',
          // A caveat after the fixed inspection window must not turn an
          // attacker-controlled oversized sidecar into unbounded recovery work.
          collectionScopeCaveats: [
            ...Array.from({ length: 16 }, () => ({ sourceId: 'other', code: 'noise' })),
            caveat,
          ],
        },
      };
      for (let index = 0; index < 200; index += 1) {
        noisyManifest[`source-${index}`] = { status: 'done', collectionScopeCaveats: [caveat] };
      }
      const bounded = collectionScopeCaveatsFromCompletedManifestSources(noisyManifest);
      assert(forgedUnderIndeed.length === 0,
        'a Glassdoor-shaped caveat under another source key cannot be restored');
      assert(bounded.length === 0,
        'manifest hydration must not scan an unbounded source map or caveat array for a late token');
      return { forged: forgedUnderIndeed.length, bounded: bounded.length };
    },
  },
  {
    name: 'Job Search collection scope caveat: interrupted completed Glassdoor source rehydrates through resume without a refetch',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-glassdoor-scope-resume-'));
      const canvasPath = path.join(root, 'workspace.json');
      const runId = 'glassdoor-interrupted-run';
      const caveat = [{
        sourceId: 'glassdoor',
        code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED,
      }];
      try {
        await startRun(canvasPath, {
          runId,
          startedAt: 1,
          nodeId: 'scope-resume-hub',
          sourceIds: ['glassdoor', 'indeed'],
        });
        await markSourceStatus(canvasPath, 'glassdoor', 'done', 2, {
          nodeId: 'scope-resume-hub',
          expectedRunId: runId,
          collectionScopeCaveats: [...caveat, ...caveat, { sourceId: 'other', code: 'forged' }],
        });
        // The interrupted run leaves Indeed pending. On resume Glassdoor is
        // already done, so this is the exact manifest-only hydration path.
        const interrupted = await readRunState(canvasPath, 3, { nodeId: 'scope-resume-hub' });
        const resumedCaveats = collectionScopeCaveatsFromCompletedManifestSources(interrupted?.manifest?.sources);
        const terminalSourceResults = {};
        hydrateCollectionScopeCaveatsIntoSourceResults(terminalSourceResults, resumedCaveats);
        const terminalCaveats = collectionScopeCaveatsFromSourceResults(terminalSourceResults);
        assert(interrupted?.incomplete === true
          && interrupted.manifest.sources.glassdoor.status === 'done'
          && interrupted.manifest.sources.indeed.status === 'pending'
          && resumedCaveats.length === 1
          && hasGlassdoorCountryScopeCaveat(terminalCaveats),
        `completed Glassdoor caveat must survive an interrupted multi-source resume, got ${JSON.stringify({ interrupted, resumedCaveats, terminalCaveats })}`);
        return { resumedCaveats: terminalCaveats.length };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'Glassdoor location transport: city and province remain fail-closed while country-only is disclosed',
    run: () => {
      for (const location of ['Toronto, Ontario, Canada', 'Ontario, Canada']) {
        const task = buildJobTasks(['Systems Architect'], 21, { onlySources: new Set(['glassdoor']) }, location)
          .find((entry) => entry.sourceId === 'glassdoor');
        assert(task?.resolveGlassdoorLocation === location && !task?.glassdoorLocationSoftScope,
          `${location}: an unverified precise location must not widen to an unscoped Glassdoor result`);
      }
      const country = buildJobTasks(['Systems Architect'], 21, { onlySources: new Set(['glassdoor']) }, 'Canada')
        .find((entry) => entry.sourceId === 'glassdoor');
      assert(country?.resolveGlassdoorLocation === 'Canada' && !country?.glassdoorLocationSoftScope,
        'a country-only non-remote request still attempts a verified nation-tier location and its non-enforcement is disclosed separately');
      return { exactScopes: 2 };
    },
  },
  {
    name: 'Job Search collection scope caveat: terminal wiring, new-run clear, career clear, and Done-state disclosure stay connected',
    run: () => {
      const backend = readFileSync(new URL('../../electron/ipc/jobs.js', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const done = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');
      assert(done.includes("searchWindow: 'Posting date window'"),
        'a recency instruction advisory must name the posting-date policy, not a retired editable age control');
      assert(backend.includes('collectionScopeCaveats: collectionScopeCaveatsFromSourceResults(sourceResults)'),
        'main-process source facts are returned separately from scrape warnings');
      assert(search.includes('collectionScopeCaveats: searchResult.collectionScopeCaveats')
        && search.includes('collectionScopeCaveats: searchResult?.collectionScopeCaveats')
        && search.includes('collectionScopeCaveats={data.collectionScopeCaveats || []}'),
      'fresh and resumed results both carry the caveat to DoneState');
      assert((search.match(/collectionScopeCaveats: collectionScopeCaveatsForSavedJobReanalysis\(runData\)/g) || []).length === 2,
        'both successful saved-job re-analysis terminal paths retain their prior collection caveat');
      assert(backend.includes('resumedCollectionScopeCaveats = collectionScopeCaveatsFromCompletedManifestSources(priorSources)')
        && backend.includes('hydrateCollectionScopeCaveatsIntoSourceResults(sourceResults, resumedCollectionScopeCaveats)'),
      'a completed source’s durable caveat is rehydrated before resumed terminal results are derived');
      assert((search.match(/collectionScopeCaveats: \[\]/g) || []).length >= 3,
        'a fresh run, Reset, and Clear career files each remove stale caveats');
      assert(done.includes('Search limitations ({historicalNoticeCount})')
        && done.includes('<details')
        && done.includes('Glassdoor may reflect this computer&apos;s browsing region.')
        && done.includes('This completed search had no city, state, or province')
        && !done.includes('role="status"'),
      'the completed-result UI keeps historical scope limitations in an opt-in disclosure without announcing static content as live status');
      return { wired: true };
    },
  },
  {
    name: 'Completed Job Search historical notices stay static, non-actionable, and diagnostically complete',
    run: () => {
      const done = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');
      const scrapePanel = readFileSync(new URL('../../src/components/ScrapeWarningsPanel.jsx', import.meta.url), 'utf8');
      const advisoryStart = done.indexOf('export function SearchBriefAdvisories');
      const advisoryEnd = done.indexOf('export function JobSearchDoneState', advisoryStart);
      const advisories = done.slice(advisoryStart, advisoryEnd);
      const titleNoteStart = done.indexOf('normalizedTitleOperatorWarnings.length > 0');
      const titleNoteEnd = done.indexOf('</label>', titleNoteStart);
      const titleNote = done.slice(titleNoteStart, titleNoteEnd);

      assert(advisoryStart >= 0 && advisoryEnd > advisoryStart
        && !advisories.includes('role="status"')
        && !advisories.includes('Clear career files to change this setup.'),
      'locked Brief advisories are static saved-plan context without an action prompt');
      assert(titleNoteStart >= 0 && titleNoteEnd > titleNoteStart
        && titleNote.includes('Saved search-title note')
        && !titleNote.includes('role="status"')
        && !titleNote.includes('Clear career files to change this setup.'),
      'the persisted title-operator note remains a static historical note without a duplicate action prompt');
      assert(scrapePanel.includes('!resultMode && w.suggestion')
        && scrapePanel.includes('suggestion: ${w.suggestion}')
        && scrapePanel.includes('Recorded during this completed search. Re-scan to try the affected source again.'),
      'completed-result warning cards hide stale per-source instructions, retain them in Copy all diagnostics, and give a truthful re-scan path');
      return { staticNotices: true, copiedDiagnostics: true };
    },
  },
  {
    name: 'SearchBriefAdvisories: settingConflicts and warnings render in both JobSearchNode.jsx and JobSearchDoneState.jsx, and NOTHING when both are empty',
    run: () => {
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const done = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');

      // Isolate the component's own definition (not its call sites) so the
      // empty-case and both-fields assertions below are anchored to the
      // actual implementation, not a substring that happens to appear
      // elsewhere in the file.
      const componentStart = done.indexOf('export function SearchBriefAdvisories');
      const componentEnd = done.indexOf('export function JobSearchDoneState', componentStart);
      assert(componentStart >= 0 && componentEnd > componentStart,
        'SearchBriefAdvisories must be defined (and be followed by JobSearchDoneState) in JobSearchDoneState.jsx');
      const component = done.slice(componentStart, componentEnd);

      // The likely bug this test guards against: an always-visible empty
      // container (e.g. a wrapping <div> with no early return) that shows a
      // blank amber/neutral box on every ordinary brief with no advisories.
      // Assert the explicit early-return-null guard exists, keyed on BOTH
      // fields being empty — not just one of them.
      assert(component.includes('if (settingConflicts.length === 0 && warnings.length === 0) return null;'),
        'SearchBriefAdvisories must return null (render nothing) when both settingConflicts and warnings are empty, not an empty container');

      // Both fields must actually be read and mapped, not just one of the
      // two the task calls out (a common half-finished-feature bug).
      assert(component.includes('searchBriefPlan?.settingConflicts') && component.includes('settingConflicts.map('),
        'the component must read and render settingConflicts entries');
      assert(component.includes('searchBriefPlan?.warnings') && component.includes('warnings.map('),
        'the component must read and render warnings entries');

      // Both render states wire the prop through: JobSearchNode.jsx renders
      // the component directly in its own pre-run/draft state (where a
      // settingConflict is still actionable, before settings freeze), and
      // separately hands searchBriefPlan to JobSearchDoneState, which
      // renders its OWN internal <SearchBriefAdvisories> for the completed
      // state. Both usages must exist — this is a shared component, not two
      // independent copies that could silently drift.
      assert(/<SearchBriefAdvisories\s+searchBriefPlan=\{data\.searchBriefPlan \|\| null\}\s+completedLocked=\{settingsFrozen\}\s*\/>/.test(search),
        'JobSearchNode.jsx must render SearchBriefAdvisories directly in its draft/empty state and identify a reset-retained locked plan');
      assert(search.includes('searchBriefPlan={data.searchBriefPlan || null}')
        && search.includes('<JobSearchDoneState'),
      'JobSearchNode.jsx must pass searchBriefPlan through to JobSearchDoneState');
      assert(/<SearchBriefAdvisories\s+searchBriefPlan=\{searchBriefPlan\}\s+completedLocked=\{settingsFrozen\}\s*\/>/.test(done),
        'JobSearchDoneState.jsx must render SearchBriefAdvisories internally in locked-plan mode');

      return { componentFound: true, bothFieldsWired: true, bothCallSitesWired: true };
    },
  },
  {
    name: 'SearchBriefAdvisories is structurally distinct from HubErrorBanner: read-only status, never routed through the error/alert path',
    run: () => {
      const done = readFileSync(new URL('../../src/nodes/jobsearch/JobSearchDoneState.jsx', import.meta.url), 'utf8');
      const search = readFileSync(new URL('../../src/nodes/JobSearchNode.jsx', import.meta.url), 'utf8');
      const errorBanner = readFileSync(new URL('../../src/components/HubErrorBanner.jsx', import.meta.url), 'utf8');

      // HubErrorBanner is the red "alert" affordance with retry/dismiss
      // controls for a FAILED run. Confirm that's still what it is, so the
      // contrast below is meaningful rather than assuming stale knowledge.
      assert(errorBanner.includes('role="alert"') && errorBanner.includes('bg-red-500/10') && errorBanner.includes('border-red-500/30'),
        'HubErrorBanner must remain the red role="alert" failure affordance this test contrasts against');

      const componentStart = done.indexOf('export function SearchBriefAdvisories');
      const componentEnd = done.indexOf('export function JobSearchDoneState', componentStart);
      const component = done.slice(componentStart, componentEnd);

      // The advisory is informational ("you may have meant something else"),
      // never an alert ("your run failed") — it must not borrow the error
      // path's semantics (role, color) or its retry/dismiss affordances,
      // since it never gates, cancels, or retries a search.
      assert(!component.includes('role="alert"'),
        'SearchBriefAdvisories must not use role="alert" — that is HubErrorBanner\'s failure semantics, not an advisory\'s');
      assert(!component.includes('bg-red') && !component.includes('border-red'),
        'SearchBriefAdvisories must not use HubErrorBanner\'s red failure styling');
      assert(!component.includes('onRetry') && !component.includes('onDismiss') && !component.includes('errorMessage'),
        'SearchBriefAdvisories must not accept error-path props (onRetry/onDismiss/errorMessage) — it is read-only display with no gating');
      assert(!component.includes('role="status"'),
        'static Search Brief advisories must not misuse a live-status announcement role');

      // JobSearchNode.jsx's `banner` block is exactly the HubErrorBanner /
      // queued-run / test-mode-note conditional group. SearchBriefAdvisories
      // must render OUTSIDE it (in the settings form, not the error strip) —
      // proving it is never gated behind, or rendered as part of, the error
      // path.
      const bannerStart = search.indexOf('const banner = (');
      const bannerEnd = search.indexOf('return (\n    <HubContainer', bannerStart);
      assert(bannerStart >= 0 && bannerEnd > bannerStart,
        'JobSearchNode.jsx must still define the banner block this test isolates');
      const banner = search.slice(bannerStart, bannerEnd);
      assert(!banner.includes('SearchBriefAdvisories'),
        'SearchBriefAdvisories must never be rendered inside the HubErrorBanner/queued-run banner block');

      return { distinctFromErrorBanner: true, outsideBannerBlock: true };
    },
  },
  {
    name: 'Event logger: Chromium ResizeObserver delivery warnings remain captured as layout warnings',
    run: () => {
      const completed = classifyLayoutWarning('ResizeObserver loop completed with undelivered notifications');
      const completedPunctuated = classifyLayoutWarning('ResizeObserver loop completed with undelivered notifications.');
      const limit = classifyLayoutWarning('ResizeObserver loop limit exceeded');
      assert(completed === 'LAYOUT-WARNING: ResizeObserver loop completed with undelivered notifications'
        && completedPunctuated === 'LAYOUT-WARNING: ResizeObserver loop completed with undelivered notifications.'
        && limit === 'LAYOUT-WARNING: ResizeObserver loop limit exceeded',
      'both exact spelling variants of Chromium ResizeObserver warnings remain in the timeline with their layout classification');
      assert(classifyLayoutWarning('ResizeObserver callback failed') === null
        && classifyLayoutWarning('TypeError: boom') === null,
      'nearby observer/application failures remain ordinary JS errors rather than being suppressed');
      return { classified: 2 };
    },
  },
  {
    name: 'Resume hydrating a Glassdoor caveat onto a source with no staged rows leaves a complete source result',
    run: () => {
      const caveats = [{ sourceId: 'glassdoor', code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED }];
      const empty = hydrateCollectionScopeCaveatsIntoSourceResults({}, caveats).glassdoor;
      assert(Array.isArray(empty.jobs) && empty.jobs.length === 0
        && Array.isArray(empty.warnings) && empty.errors === 0
        && empty.pagesWalked === 0 && empty.stopReasons instanceof Set
        && empty.locationScopeUnenforced === true,
      `a caveat-only Glassdoor entry must carry the full per-source shape the Glassdoor gate and finalizer read unguarded, got ${JSON.stringify(empty)}`);
      const rows = [{ title: 'kept' }];
      const merged = hydrateCollectionScopeCaveatsIntoSourceResults({ glassdoor: { jobs: rows, errors: 2, warnings: [{ code: 'x' }] } }, caveats).glassdoor;
      assert(merged.jobs === rows && merged.errors === 2 && merged.warnings.length === 1 && merged.locationScopeUnenforced === true,
        'hydration must add the caveat without replacing a result that already owns rows, errors, or warnings');
      return { shape: true };
    },
  },
  {
    name: 'Exact resume of a gathered run whose done Glassdoor staged no rows passes the Glassdoor gate',
    run: async () => {
      const root = await fs.promises.mkdtemp(path.join('/tmp', 'ic-resume-empty-glassdoor-'));
      const canvasPath = path.join(root, 'workspace.json');
      const nodeId = 'resume-empty-glassdoor-hub';
      const runId = 'resume-empty-glassdoor-run';
      const queries = ['data engineer'];
      const fingerprint = 'a'.repeat(64);
      const startedAt = Date.now() - 60_000;
      let destroy = () => {};
      const seen = [];
      const { snapshotId: careerSnapshotId } = await writeApprovedCareerSnapshotFixture();
      const sender = {
        id: 98_223,
        isDestroyed: () => false,
        once: (name, callback) => { if (name === 'destroyed') destroy = callback; },
        on: () => {},
        removeListener: () => {},
        send: (channel) => {
          seen.push(channel);
          // Safety net only: a regression that reaches a manual-AI handoff must
          // abort instead of waiting forever for a paste.
          if (channel === 'non-api-ai-request') destroy();
        },
      };
      try {
        await startRun(canvasPath, {
          runId,
          startedAt,
          nodeId,
          queries,
          profileFingerprint: fingerprint,
          careerSnapshotId,
          canonicalLocation: 'Canada',
          sourceIds: ['glassdoor', 'remoteok'],
        });
        await recordSourcePage(canvasPath, {
          expectedRunId: runId,
          nodeId,
          sourceId: 'remoteok',
          query: '',
          page: 0,
          jobs: [{ id: 'rok-1', title: 'Data Engineer', company: 'Acme', url: 'https://remoteok.com/remote-jobs/rok-1', posted: new Date().toISOString(), description: 'Build data pipelines. '.repeat(20) }],
          now: startedAt + 100,
        });
        await markSourceStatus(canvasPath, 'remoteok', 'done', startedAt + 200, { expectedRunId: runId, nodeId });
        // Glassdoor finished with the nation-tier caveat but yielded no rows, so
        // recovery has nothing to seed its source result from.
        await markSourceStatus(canvasPath, 'glassdoor', 'done', startedAt + 300, {
          expectedRunId: runId,
          nodeId,
          collectionScopeCaveats: [{ sourceId: 'glassdoor', code: COLLECTION_SCOPE_CAVEAT.GLASSDOOR_COUNTRY_SCOPE_UNENFORCED }],
        });
        await setStage(canvasPath, 'gathered', startedAt + 400, { expectedRunId: runId, nodeId });
        const stagedState = await readRunState(canvasPath, Date.now(), { nodeId });
        const stagedAuthority = stagedState?.manifest?.inputs?.operationAuthority;
        assert(stagedAuthority,
          'the exact-resume fixture must carry the durable authority receipt issued with its staged manifest');
        const resumeClaim = await claimJobAnalysisOperationAuthority({
          canvasFilePath: canvasPath,
          hubId: nodeId,
          operationId: 'resume-empty-glassdoor-operation',
          semanticBase: {
            kind: 'resume',
            careerSnapshotId,
            runId,
            analysisRevisionId: null,
            fingerprint: null,
            continuationId: null,
            sourceArtifactFingerprint: null,
          },
          predecessor: stagedAuthority,
        });
        assert(resumeClaim?.admitted === true && resumeClaim.receipt,
          'the exact-resume fixture must make a successor authority claim that names the staged receipt as its immediate predecessor');
        const operationAuthority = resumeClaim.receipt;
        registerJobsHandlers();
        const searchJobs = ipcMain.__getInvokeHandler('search-jobs');
        const guard = setTimeout(() => destroy(), 20_000);
        let result;
        try {
          result = await searchJobs({ sender }, {
            nodeId,
            canvasFilePath: canvasPath,
            queries,
            preferredLocation: 'Canada',
            resume: true,
            resumeRunId: runId,
            profileFingerprint: fingerprint,
            careerSnapshotId,
            operationAuthority,
            profileInputMode: 'stored-profile',
          });
        } finally {
          clearTimeout(guard);
        }
        assert(!/Cannot read properties/.test(String(result?.error || '')),
          `a done Glassdoor with a caveat and no staged rows must not crash the resume, got ${JSON.stringify(result)}`);
        assert(result?.success === true && result.jobs?.some(job => job.id === 'rok-1'),
          `the resume must finish past the Glassdoor gate with its staged rows, saw ${JSON.stringify(seen)} and ${JSON.stringify(result)?.slice(0, 400)}`);
        return { resumed: true };
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true });
      }
    },
  },
  {
    name: 'IPC failure stack frames survive report path redaction when the install path contains spaces',
    run: () => {
      const error = new Error('boom');
      error.stack = [
        'Error: boom',
        '    at /Users/jack/Desktop/My Apps/infinite-canvas/electron/ipc/jobs.js:10956:31',
        '    at async Object.handler (/Applications/Infinite Canvas.app/Contents/Resources/app.asar/dist-electron/main.cjs:777:12)',
        '    at async file:///Users/jack/Desktop/My Apps/x/ipcUtils.js:417:22',
        '    at C:\\Program Files\\Infinite Canvas\\main.cjs:5:9',
      ].join('\n');
      const compact = __compactErrorStackForTests(error);
      assert(compact === 'at jobs.js:10956:31 ← at async Object.handler (main.cjs:777:12) ← at async ipcUtils.js:417:22 ← at main.cjs:5:9',
        `frames must reduce to basename:line:col with the leading text intact, got ${compact}`);
      return { compact };
    },
  },
];
