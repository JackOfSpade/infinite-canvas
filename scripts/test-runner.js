import fs from 'node:fs';
import marketplace_monitor from './tests/marketplace-monitor.js';
import ai_models from './tests/ai-models.js';
import fixtures_canvas from './tests/fixtures-canvas.js';
import job_diagnostics from './tests/job-diagnostics.js';
import job_scoring_cache from './tests/job-scoring-cache.js';
import marketplace_extractors_auth from './tests/marketplace-extractors-auth.js';
import jobs_location_language from './tests/jobs-location-language.js';
import job_source_country_scope from './tests/job-source-country-scope.js';
import job_collection_scope_caveats from './tests/job-collection-scope-caveats.js';
import marketplace_diagnostics_locks from './tests/marketplace-diagnostics-locks.js';
import platform_utils from './tests/platform-utils.js';
import skill_opportunities from './tests/skill-opportunities.js';
import resume_download_bundle from './tests/resume-download-bundle.js';
import application_multi_posting from './tests/application-multi-posting.js';
import cover_letter_harness from './tests/cover-letter-harness.js';
import job_collection_limits from './tests/job-collection-limits.js';
import job_search_queries from './tests/job-search-queries.js';
import electron_regressions from './tests/electron-regressions.js';
import renderer_content_security from './tests/renderer-content-security.js';
import local_ai_application from './tests/local-ai-application.js';
import application_authority_ledger_store from './tests/application-authority-ledger-store.js';
import application_authority_match_queue from './tests/application-authority-match-queue.js';
import current_authority_parallel_match from './tests/current-authority-parallel-match.js';
import application_career_authority from './tests/application-career-authority.js';
import paste_application_assembly from './tests/paste-application-assembly.js';
import paste_application_flow from './tests/paste-application-flow.js';
import paste_application_fit_save from './tests/paste-application-fit-save.js';
import local_ai_deletion from './tests/local-ai-deletion.js';
import login_url_markers from './tests/login-url-markers.js';
import compensation_assessment from './tests/compensation-assessment.js';
import job_compensation_pipeline from './tests/job-compensation-pipeline.js';
import job_location_lookup from './tests/job-location-lookup.js';
import job_location_consolidation from './tests/job-location-consolidation.js';
import job_search_locations from './tests/job-search-locations.js';
import job_title_match from './tests/job-title-match.js';
import job_posted_date from './tests/job-posted-date.js';
import job_search_date_window from './tests/job-search-date-window.js';
import job_board_provider from './tests/job-board-provider.js';
import job_fit_assessment from './tests/job-fit-assessment.js';
import auth_cookie_checkpoint from './tests/auth-cookie-checkpoint.js';
import browser_launch_lock_regression from './tests/browser-launch-lock-regression.js';
import schema_validation from './tests/schema-validation.js';
import job_resume_ingestion from './tests/job-resume-ingestion.js';
import job_analysis_operation_ledger from './tests/job-analysis-operation-ledger.js';
import job_analysis_operation_authority_adversarial from './tests/job-analysis-operation-authority-adversarial.js';
import job_continuation_authority_contract from './tests/job-continuation-authority-contract.js';
import career_canvas_file_import from './tests/career-canvas-file-import.js';
import career_profile_compilation from './tests/career-profile-compilation.js';
import non_api_ai from './tests/non-api-ai.js';
import job_workflow_documentation from './tests/job-workflow-documentation.js';
import job_run_staging from './tests/job-run-staging.js';
import job_autoresume_recovery from './tests/job-autoresume-recovery.js';
import job_board_recovery_notice from './tests/job-board-recovery-notice.js';
import job_board_action_visibility from './tests/job-board-action-visibility.js';
import job_board_combine_receipt from './tests/job-board-combine-receipt.js';
import job_api_probe from './tests/job-api-probe.js';
import application_pdf_reconcile from './tests/application-pdf-reconcile.js';
import packaging_integrity from './tests/packaging-integrity.js';
import solve_ipc_failure from './tests/solve-ipc-failure.js';
import nested_canvas_absorption from './tests/nested-canvas-absorption.js';
import job_role_lock_regressions from './tests/job-role-lock-regressions.js';
import application_handoff_dock from './tests/application-handoff-dock.js';
import paste_identity_guard from './tests/paste-identity-guard.js';
import paste_review_delta from './tests/paste-review-delta.js';
import event_log_deletion_batching from './tests/event-log-deletion-batching.js';
import handoff_bridge_inert from './tests/handoff-bridge-inert.js';
import handoff_bridge_http from './tests/handoff-bridge-http.js';
import handoff_bridge_mcp from './tests/handoff-bridge-mcp.js';
import handoff_bridge_oauth from './tests/handoff-bridge-oauth.js';
import handoff_bridge_engine from './tests/handoff-bridge-engine.js';
import handoff_bridge_application from './tests/handoff-bridge-application.js';
import handoff_bridge_push from './tests/handoff-bridge-push.js';
import non_api_ai_bridge_seam from './tests/non-api-ai-bridge-seam.js';
import handoff_bridge_store from './tests/handoff-bridge-store.js';
import handoff_bridge_tunnel from './tests/handoff-bridge-tunnel.js';
import handoff_bridge_controls from './tests/handoff-bridge-controls.js';
import handoff_bridge_ipc from './tests/handoff-bridge-ipc.js';
import handoff_bridge_privacy from './tests/handoff-bridge-privacy.js';
import handoff_bridge_hostile from './tests/handoff-bridge-hostile.js';
import handoff_bridge_source_scan from './tests/handoff-bridge-source-scan.js';
import handoff_bridge_ui from './tests/handoff-bridge-ui.js';
import handoff_bridge_render from './tests/handoff-bridge-render.js';
import issue_reporter from './tests/issue-reporter.js';
import network_rolling_scheduler from './tests/network-rolling-scheduler.js';
import handoff_scheduler from './tests/handoff-scheduler.js';
import application_slot_queue from './tests/application-slot-queue.js';
import job_tree_user_arranged_layout from './tests/job-tree-user-arranged-layout.js';
import job_card_bundle_indicator from './tests/job-card-bundle-indicator.js';
import handoff_bridge_application_pool_growth from './tests/handoff-bridge-application-pool-growth.js';
import application_bridge_page from './tests/application-bridge-page.js';
import application_bridge_page_render from './tests/application-bridge-page-render.js';
import application_bridge_page_dock from './tests/application-bridge-page-dock.js';
import application_authority_workflow from './tests/application-authority-workflow.js';
import application_blind_review from './tests/application-blind-review.js';
import one_card_live_acceptance from './tests/one-card-live-acceptance.js';
import pointer_occlusion_probe from './tests/pointer-occlusion-probe.js';
import test_runner_watchdog from './tests/test-runner-watchdog.js';

// Keep the file name beside its group so omissions and stale registrations
// fail before a green test run gives a false signal.
const testGroups = [
  ['marketplace-monitor.js', marketplace_monitor],
  ['ai-models.js', ai_models],
  ['fixtures-canvas.js', fixtures_canvas],
  ['job-diagnostics.js', job_diagnostics],
  ['job-scoring-cache.js', job_scoring_cache],
  ['marketplace-extractors-auth.js', marketplace_extractors_auth],
  ['jobs-location-language.js', jobs_location_language],
  ['job-source-country-scope.js', job_source_country_scope],
  ['job-collection-scope-caveats.js', job_collection_scope_caveats],
  ['marketplace-diagnostics-locks.js', marketplace_diagnostics_locks],
  ['platform-utils.js', platform_utils],
  ['skill-opportunities.js', skill_opportunities],
  ['resume-download-bundle.js', resume_download_bundle],
  ['application-multi-posting.js', application_multi_posting],
  ['cover-letter-harness.js', cover_letter_harness],
  ['job-collection-limits.js', job_collection_limits],
  ['job-search-queries.js', job_search_queries],
  ['electron-regressions.js', electron_regressions],
  ['renderer-content-security.js', renderer_content_security],
  ['local-ai-application.js', local_ai_application],
  ['application-authority-ledger-store.js', application_authority_ledger_store],
  ['application-authority-match-queue.js', application_authority_match_queue],
  ['current-authority-parallel-match.js', current_authority_parallel_match],
  ['application-career-authority.js', application_career_authority],
  ['paste-application-assembly.js', paste_application_assembly],
  ['paste-application-flow.js', paste_application_flow],
  ['paste-application-fit-save.js', paste_application_fit_save],
  ['local-ai-deletion.js', local_ai_deletion],
  ['login-url-markers.js', login_url_markers],
  ['compensation-assessment.js', compensation_assessment],
  ['job-compensation-pipeline.js', job_compensation_pipeline],
  ['job-location-lookup.js', job_location_lookup],
  ['job-location-consolidation.js', job_location_consolidation],
  ['job-search-locations.js', job_search_locations],
  ['job-title-match.js', job_title_match],
  ['job-posted-date.js', job_posted_date],
  ['job-search-date-window.js', job_search_date_window],
  ['job-board-provider.js', job_board_provider],
  ['job-fit-assessment.js', job_fit_assessment],
  ['auth-cookie-checkpoint.js', auth_cookie_checkpoint],
  ['browser-launch-lock-regression.js', browser_launch_lock_regression],
  ['schema-validation.js', schema_validation],
  ['job-resume-ingestion.js', job_resume_ingestion],
  ['job-analysis-operation-ledger.js', job_analysis_operation_ledger],
  ['job-analysis-operation-authority-adversarial.js', job_analysis_operation_authority_adversarial],
  ['job-continuation-authority-contract.js', job_continuation_authority_contract],
  ['career-canvas-file-import.js', career_canvas_file_import],
  ['career-profile-compilation.js', career_profile_compilation],
  ['non-api-ai.js', non_api_ai],
  ['job-workflow-documentation.js', job_workflow_documentation],
  ['job-run-staging.js', job_run_staging],
  ['job-autoresume-recovery.js', job_autoresume_recovery],
  ['job-board-recovery-notice.js', job_board_recovery_notice],
  ['job-board-action-visibility.js', job_board_action_visibility],
  ['job-board-combine-receipt.js', job_board_combine_receipt],
  ['job-api-probe.js', job_api_probe],
  ['application-pdf-reconcile.js', application_pdf_reconcile],
  ['packaging-integrity.js', packaging_integrity],
  ['solve-ipc-failure.js', solve_ipc_failure],
  ['nested-canvas-absorption.js', nested_canvas_absorption],
  ['job-role-lock-regressions.js', job_role_lock_regressions],
  ['application-handoff-dock.js', application_handoff_dock],
  ['paste-identity-guard.js', paste_identity_guard],
  ['paste-review-delta.js', paste_review_delta],
  ['event-log-deletion-batching.js', event_log_deletion_batching],
  ['handoff-bridge-inert.js', handoff_bridge_inert],
  ['handoff-bridge-http.js', handoff_bridge_http],
  ['handoff-bridge-mcp.js', handoff_bridge_mcp],
  ['handoff-bridge-oauth.js', handoff_bridge_oauth],
  ['handoff-bridge-engine.js', handoff_bridge_engine],
  ['handoff-bridge-application.js', handoff_bridge_application],
  ['handoff-bridge-push.js', handoff_bridge_push],
  ['non-api-ai-bridge-seam.js', non_api_ai_bridge_seam],
  ['handoff-bridge-store.js', handoff_bridge_store],
  ['handoff-bridge-tunnel.js', handoff_bridge_tunnel],
  ['handoff-bridge-controls.js', handoff_bridge_controls],
  ['handoff-bridge-ipc.js', handoff_bridge_ipc],
  ['handoff-bridge-privacy.js', handoff_bridge_privacy],
  ['handoff-bridge-hostile.js', handoff_bridge_hostile],
  ['handoff-bridge-source-scan.js', handoff_bridge_source_scan],
  ['handoff-bridge-ui.js', handoff_bridge_ui],
  ['handoff-bridge-render.js', handoff_bridge_render],
  ['issue-reporter.js', issue_reporter],
  ['network-rolling-scheduler.js', network_rolling_scheduler],
  ['handoff-scheduler.js', handoff_scheduler],
  ['application-slot-queue.js', application_slot_queue],
  ['job-tree-user-arranged-layout.js', job_tree_user_arranged_layout],
  ['job-card-bundle-indicator.js', job_card_bundle_indicator],
  ['handoff-bridge-application-pool-growth.js', handoff_bridge_application_pool_growth],
  ['application-bridge-page.js', application_bridge_page],
  ['application-bridge-page-render.js', application_bridge_page_render],
  ['application-bridge-page-dock.js', application_bridge_page_dock],
  ['application-authority-workflow.js', application_authority_workflow],
  ['application-blind-review.js', application_blind_review],
  ['one-card-live-acceptance.js', one_card_live_acceptance],
  ['pointer-occlusion-probe.js', pointer_occlusion_probe],
  ['test-runner-watchdog.js', test_runner_watchdog],
];

// Unit tests are normally short, but a suspended Promise otherwise lets Node
// drain the event loop and exit before the runner has printed a failure
// summary. Keep a referenced watchdog around every test. The default is
// deliberately generous; a slow, legitimate test can opt into a longer budget
// with TEST_RUNNER_TIMEOUT_MS=<positive integer>.
const DEFAULT_TEST_TIMEOUT_MS = 120_000;

function readTestTimeoutMs(value = process.env.TEST_RUNNER_TIMEOUT_MS) {
  if (value === undefined || value === '') return DEFAULT_TEST_TIMEOUT_MS;
  if (!/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value))) {
    throw new Error('TEST_RUNNER_TIMEOUT_MS must be a positive integer number of milliseconds');
  }
  return Number(value);
}

function watchdogFixtureGroups() {
  // A narrow, process-only seam used by the runner regression. It keeps the
  // normal registry immutable while testing the exact failure mode that used
  // to silently terminate a run.
  if (process.env.TEST_RUNNER_SELFTEST !== 'never-settles') return testGroups;
  return [[
    'watchdog-fixture.js',
    [
      { name: 'test runner watchdog fixture: never settles', run: () => new Promise(() => {}) },
      { name: 'test runner watchdog fixture: continues after timeout', run: () => ({ continued: true }) },
    ],
  ]];
}

function validateTestRegistry(groups) {
  const testDirectory = new URL('./tests/', import.meta.url);
  const discoveredFiles = fs.readdirSync(testDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js') && entry.name !== 'testHelpers.js')
    .map((entry) => entry.name)
    .sort();
  const registeredFiles = groups.map(([file]) => file);
  const registeredSet = new Set(registeredFiles);
  const problems = [];
  const unregistered = discoveredFiles.filter((file) => !registeredSet.has(file));
  const stale = registeredFiles.filter((file) => !discoveredFiles.includes(file));
  const duplicateFiles = registeredFiles.filter((file, index) => registeredFiles.indexOf(file) !== index);

  if (unregistered.length) problems.push(`unregistered test file(s): ${unregistered.join(', ')}`);
  if (stale.length) problems.push(`missing test file(s): ${stale.join(', ')}`);
  if (duplicateFiles.length) problems.push(`duplicate test registration(s): ${[...new Set(duplicateFiles)].join(', ')}`);

  const names = new Set();
  for (const [file, group] of groups) {
    if (!Array.isArray(group)) {
      problems.push(`${file} must default-export an array of tests`);
      continue;
    }
    if (group.length === 0) {
      problems.push(`${file} must declare at least one test`);
      continue;
    }
    for (const test of group) {
      if (!test || typeof test.name !== 'string' || !test.name || typeof test.run !== 'function') {
        problems.push(`${file} contains an invalid test declaration`);
        continue;
      }
      if (names.has(test.name)) problems.push(`duplicate test name: ${test.name}`);
      names.add(test.name);
    }
  }

  if (problems.length) throw new Error(`Test registry invalid: ${problems.join('; ')}`);
  return groups;
}

function captureTestConsole() {
  const levels = ['log', 'warn', 'error'];
  const original = Object.fromEntries(levels.map(level => [level, console[level]]));
  const entries = [];
  for (const level of levels) {
    console[level] = (...args) => entries.push({ level, args });
  }
  return {
    restore() {
      for (const level of levels) console[level] = original[level];
    },
    replay() {
      for (const { level, args } of entries) original[level]('[TEST OUTPUT]', ...args);
    },
    count: () => entries.length,
  };
}

function runTestWithWatchdog(test, { file, timeoutMs }) {
  let timer;
  const timeout = new Promise((_, reject) => {
    // Do not call unref(): this timer is what prevents Node from treating a
    // suspended test as a successful, naturally-complete process.
    timer = setTimeout(() => {
      const error = new Error(`timed out after ${timeoutMs}ms`);
      error.name = 'TestTimeoutError';
      error.testFile = file;
      error.testName = test.name;
      reject(error);
    }, timeoutMs);
  });
  const execution = Promise.resolve().then(() => test.run());
  return Promise.race([execution, timeout]).finally(() => clearTimeout(timer));
}

async function run() {
  let passed = 0;
  let failed = 0;
  // Always check the real registry, even when the narrow watchdog fixture is
  // selected in a child process. The fixture should not weaken registration
  // coverage for the normal unit suite.
  validateTestRegistry(testGroups);
  const groups = watchdogFixtureGroups();
  const verbose = process.env.TEST_VERBOSE === '1';
  const timeoutMs = readTestTimeoutMs();

  console.log(`\n[TEST RUNNER] Deterministic smoke tests (${groups.length} groups)\n`);

  for (const [file, tests] of groups) {
    let groupPassed = 0;
    for (const test of tests) {
      const capturedConsole = captureTestConsole();
      try {
        const details = await runTestWithWatchdog(test, { file, timeoutMs });
        capturedConsole.restore();
        if (verbose) console.log(`PASS ${test.name}`, details ? JSON.stringify(details) : '');
        passed++;
        groupPassed++;
      } catch (error) {
        capturedConsole.restore();
        console.error(`FAIL ${file} :: ${test.name}:`, error.stack || error.message);
        if (capturedConsole.count() > 0) capturedConsole.replay();
        failed++;
      }
    }
    const status = groupPassed === tests.length ? 'PASS' : 'FAIL';
    const write = status === 'PASS' ? console.log : console.error;
    write(`${status} ${file} (${groupPassed}/${tests.length} tests)`);
  }

  console.log(`\n[TEST RUNNER] ${passed} passed, ${failed} failed`);
  summaryPrinted = true;
  // Only now is a green result earned; until here the exit code stays failing.
  process.exitCode = failed > 0 ? 1 : 0;
}

// A test whose promise never settles lets the event loop drain, and Node then
// exits quietly with the code it already holds. Start failing and clear that
// only after the summary prints, so an unfinished run can never look green.
let summaryPrinted = false;
process.exitCode = 1;
process.on('exit', () => {
  if (summaryPrinted) return;
  process.exitCode = 1;
  // process.stderr, not console: a hung test never restores the captured console.
  process.stderr.write('[TEST RUNNER] Exited before the summary: a test never settled (or the runner crashed). Treating the run as FAILED.\n');
});

run().catch((error) => {
  console.error('[TEST RUNNER] Fatal error:', error);
  process.exitCode = 1;
});
