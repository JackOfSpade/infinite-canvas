import fs from 'node:fs';
import careerCompilationProgressTests from './careerCompilationProgressFixture.mjs';
import jobRendererIntegrityTests from './jobRendererIntegrityFixture.mjs';
import assert from 'node:assert';

function readSource(relativePath) {
  return fs.readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

const button = () => readSource('../../src/nodes/jobsearch/TwoStepConfirmButton.jsx');
const done = () => readSource('../../src/nodes/jobsearch/JobSearchDoneState.jsx');
const sourcesReady = () => readSource('../../src/nodes/jobsearch/JobSearchSourcesReadyState.jsx');

export default [
  ...careerCompilationProgressTests,
  ...jobRendererIntegrityTests,
  {
    name: 'TwoStepConfirmButton never uses a browser confirm/alert dialog',
    run: async () => {
      const src = button();
      assert(!/\bconfirm\(/.test(src), 'must not call confirm(');
      assert(!/window\.confirm/.test(src), 'must not call window.confirm');
      assert(!/\balert\(/.test(src), 'must not call alert()');
    },
  },
  {
    name: 'TwoStepConfirmButton exposes the specified props with defaults',
    run: async () => {
      const src = button();
      assert(/export function TwoStepConfirmButton\(/.test(src), 'named export expected');
      for (const fragment of [
        "className = ''",
        "armedClassName = ''",
        'disabled = false',
        'timeoutMs = 4000',
      ]) {
        assert(src.includes(fragment), `missing prop default: ${fragment}`);
      }
    },
  },
  {
    name: 'TwoStepConfirmButton arms on first click, confirms only when armed, and clears its timer',
    run: async () => {
      const src = button();
      // onConfirm is invoked exactly once, after the armed check.
      assert.strictEqual(src.match(/onConfirm\?\.\(/g)?.length, 1, 'onConfirm must be called exactly once');
      const armedGuard = src.indexOf('if (!armed || Date.now() >= armedUntilRef.current)');
      const confirmCall = src.indexOf('onConfirm?.(');
      assert(armedGuard !== -1 && confirmCall > armedGuard, 'onConfirm must come after the not-armed early return');
      const armBranch = src.slice(armedGuard, confirmCall);
      assert(armBranch.includes('setArmed(true)') && armBranch.includes('setTimeout('), 'first click must arm and start the timer');
      assert(armBranch.includes('return;'), 'first click must return before confirming');
      assert(src.includes('if (disabled) return;'), 'disabled clicks must be a no-op');
      // Unmount cleanup is inside a useEffect cleanup function.
      assert(/return \(\) => \{[^}]*clearTimeout\(timerRef\.current\)/.test(src), 'timer must be cleared in a useEffect cleanup');
      // Confirm path clears the timer before disarming.
      assert(/clearTimer\(\);\s*armedUntilRef\.current = 0;\s*setArmed\(false\);\s*onConfirm\?\.\(/.test(src), 'confirm must clear timer and disarm before calling onConfirm');
    },
  },
  {
    name: 'TwoStepConfirmButton stops propagation, is nodrag, type=button and aria-live polite',
    run: async () => {
      const src = button();
      assert(/event\.stopPropagation\(\);\s*if \(disabled\) return;/.test(src), 'click must stopPropagation first');
      assert(/onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/.test(src), 'pointerdown must stopPropagation');
      assert(src.includes('className={`nodrag ${isArmed && armedClassName ? armedClassName : className}`}'), 'nodrag leads and the armed list replaces the base list');
      assert(src.includes('type="button"'), 'type=button expected');
      assert(src.includes('aria-live="polite"'), 'aria-live polite expected');
      assert(src.includes('{isArmed ? confirmLabel : label}'), 'label must swap to confirmLabel when armed');
    },
  },
  {
    name: 'JobSearchDoneState renders Clear Scrape and Clear Career Data via TwoStepConfirmButton',
    run: async () => {
      const src = done();
      assert(src.includes("import { TwoStepConfirmButton } from './TwoStepConfirmButton';"), 'must import TwoStepConfirmButton');
      assert(/<TwoStepConfirmButton\s+label="Clear Scrape"/.test(src), 'Clear Scrape must use TwoStepConfirmButton');
      assert(/<TwoStepConfirmButton\s+label="Clear Career Data"/.test(src), 'Clear Career Data must use TwoStepConfirmButton');
      assert(src.includes('confirmLabel="Click again to clear career data"'), 'career confirm label');
      assert(src.includes("`Click again to clear ${savedJobCount} job${savedJobCount === 1 ? '' : 's'}`"), 'scrape confirm label');
      assert(src.includes('onConfirm={onClearScrape}'), 'Clear Scrape wired to onClearScrape');
      assert(src.includes('onConfirm={onClearCareerFiles}'), 'Clear Career Data wired to onClearCareerFiles');
      assert(!src.includes('>\n          Clear career data\n'), 'old plain Clear career data button must be gone');
      assert(src.includes('onClearScrape && savedJobCount > 0'), 'Clear Scrape gated on savedJobCount > 0');
      assert(src.includes('onClearCareerFiles && (!careerCleared || careerCompileFailed)'), 'Clear Career Data hidden while career is cleared, except to replace files after a failed compile');
      assert(/<div className="flex gap-1 mt-2 w-full">/.test(src), 'buttons share one flex gap-1 row');
    },
  },
  {
    name: 'JobSearchDoneState gates Re-scan and its hint on savedJobCount === 0 && !careerCleared',
    run: async () => {
      const src = done();
      assert(src.includes('{onRerun && savedJobCount === 0 && !careerCleared && (\n'), 'Re-scan button gate');
      assert(src.includes('{onRerun && savedJobCount === 0 && !careerCleared && !platformsVerifying && ('), 'Next re-scan hint gate');
      // The un-gated forms must not survive anywhere.
      assert(!src.includes('{onRerun && ('), 'no ungated Re-scan render');
      assert(!src.includes('{onRerun && !platformsVerifying && ('), 'no ungated hint render');
      assert(src.includes('{onReanalyze && !careerCleared && ('), 'Re-analyze hidden when careerCleared');
    },
  },
  {
    name: 'JobSearchDoneState defaults the new props',
    run: async () => {
      const src = done();
      for (const fragment of [
        'savedJobCount = 0,',
        'onClearScrape = null,',
        'careerCleared = false,',
        'careerCompiling = false,',
        'careerCompileFailed = false,',
        "careerCompileError = '',",
        'onRetryCareerCompile = null,',
        'careerImportControls = null,',
        "rescorePendingText = '',",
      ]) {
        assert(src.includes(fragment), `missing prop default: ${fragment}`);
      }
    },
  },
  {
    name: 'JobSearchDoneState shows the career-cleared panel and rescore note per spec',
    run: async () => {
      const src = done();
      assert(src.includes('{careerCleared && (!locked || careerCompiling) && ('), 'passive progress remains visible while active compilation locks actions');
      assert(src.includes("? 'Career compilation' : 'Career data cleared'"), 'panel heading');
      assert(src.includes('<LiveCareerCompilationProgress nodeId={careerNodeId} runId={careerRunId} />'), 'compiling body uses the current host action for the exact run');
      assert(src.includes('<p>Saved jobs are kept.</p>'), 'retained jobs remain explained while career processing runs');
      assert(src.includes("`Career compilation failed${careerCompileError ? `: ${careerCompileError}` : ''}.`"), 'failed body');
      assert(src.includes("`Drop new career files to re-score ${savedJobCount} saved job${savedJobCount === 1 ? '' : 's'}. Jobs are kept.`"), 'default body');
      assert(src.includes('{!careerCompiling && (careerCompileFailed || careerCompileUnstarted) && onRetryCareerCompile && ('), 'retry gate');
      assert(src.includes('Retry Career Compilation'), 'retry label');
      assert(src.includes('{!careerCompiling && !careerCompileFailed && !careerCompileUnstarted && careerImportControls}'), 'import controls gate');
      assert(/\{rescorePendingText && \(\s*<p className="[^"]*text-emerald-[^"]*">/.test(src), 'rescore note in emerald');
    },
  },
  {
    name: 'JobSearchDoneState Board guidance no longer offers re-scan',
    run: async () => {
      const src = done();
      assert(!src.includes('re-scan here to refresh them'), 'stale re-scan guidance must be removed');
      assert(src.includes("'Connected to Job Board · Results are ready to combine there.'"), 'new Board guidance');
    },
  },
  {
    name: 'JobSearchSourcesReadyState uses TwoStepConfirmButton for its clear action',
    run: async () => {
      const src = sourcesReady();
      assert(src.includes("import { TwoStepConfirmButton } from './TwoStepConfirmButton';"), 'must import TwoStepConfirmButton');
      assert(/<TwoStepConfirmButton\s+label="Clear Career Data"\s+confirmLabel="Click again to clear career data"\s+onConfirm=\{onClearCareerFiles\}/.test(src), 'clear action must be a TwoStepConfirmButton wired to onClearCareerFiles');
      assert(!src.includes('Clear career data\n'), 'old plain button text must be gone');
    },
  },
];
