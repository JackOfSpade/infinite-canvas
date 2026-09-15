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
