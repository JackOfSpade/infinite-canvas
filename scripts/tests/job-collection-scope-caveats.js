import { readFileSync } from 'node:fs';
import { assert } from './testHelpers.js';
import { buildJobTasks, fs, markSourceStatus, os, path, readRunState, startRun } from '../test-dependencies.js';
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
      assert(done.includes('Glassdoor country scope was not enforceable.')
        && done.includes('may follow this machine&apos;s browsing region')
        && done.includes('Set a city, state, or province')
        && done.includes('role="status"'),
      'the completed-result UI gives an always-visible, accessible non-gating disclosure');
      return { wired: true };
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
      assert(search.includes('<SearchBriefAdvisories searchBriefPlan={data.searchBriefPlan || null} />'),
        'JobSearchNode.jsx must render SearchBriefAdvisories directly in its own draft/empty state');
      assert(search.includes('searchBriefPlan={data.searchBriefPlan || null}')
        && search.includes('<JobSearchDoneState'),
      'JobSearchNode.jsx must pass searchBriefPlan through to JobSearchDoneState');
      assert(done.includes('<SearchBriefAdvisories searchBriefPlan={searchBriefPlan} />'),
        'JobSearchDoneState.jsx must render SearchBriefAdvisories internally using the prop it received');

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
      assert((component.match(/role="status"/g) || []).length >= 1,
        'SearchBriefAdvisories must use the neutral role="status", not role="alert"');

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
];
