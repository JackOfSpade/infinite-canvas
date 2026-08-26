import fs from 'node:fs';
import marketplace_monitor from './tests/marketplace-monitor.js';
import ai_models from './tests/ai-models.js';
import fixtures_canvas from './tests/fixtures-canvas.js';
import job_diagnostics from './tests/job-diagnostics.js';
import job_scoring_cache from './tests/job-scoring-cache.js';
import marketplace_extractors_auth from './tests/marketplace-extractors-auth.js';
import jobs_location_language from './tests/jobs-location-language.js';
import job_source_country_scope from './tests/job-source-country-scope.js';
import marketplace_diagnostics_locks from './tests/marketplace-diagnostics-locks.js';
import platform_utils from './tests/platform-utils.js';
import skill_opportunities from './tests/skill-opportunities.js';
import resume_download_bundle from './tests/resume-download-bundle.js';
import cover_letter_harness from './tests/cover-letter-harness.js';
import job_collection_limits from './tests/job-collection-limits.js';
import job_search_queries from './tests/job-search-queries.js';
import electron_regressions from './tests/electron-regressions.js';
import renderer_content_security from './tests/renderer-content-security.js';
import local_ai_application from './tests/local-ai-application.js';
import local_ai_deletion from './tests/local-ai-deletion.js';
import login_url_markers from './tests/login-url-markers.js';
import compensation_assessment from './tests/compensation-assessment.js';
import job_compensation_pipeline from './tests/job-compensation-pipeline.js';
import job_search_locations from './tests/job-search-locations.js';
import job_board_provider from './tests/job-board-provider.js';
import job_fit_assessment from './tests/job-fit-assessment.js';
import auth_cookie_checkpoint from './tests/auth-cookie-checkpoint.js';
import browser_launch_lock_regression from './tests/browser-launch-lock-regression.js';
import claude_cache_telemetry from './tests/claude-cache-telemetry.js';
import claude_cache_bug_report from './tests/claude-cache-bug-report.js';
import schema_validation from './tests/schema-validation.js';
import claude_structured_outputs from './tests/claude-structured-outputs.js';
import job_resume_ingestion from './tests/job-resume-ingestion.js';
import non_api_ai from './tests/non-api-ai.js';
import job_workflow_documentation from './tests/job-workflow-documentation.js';

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
  ['marketplace-diagnostics-locks.js', marketplace_diagnostics_locks],
  ['platform-utils.js', platform_utils],
  ['skill-opportunities.js', skill_opportunities],
  ['resume-download-bundle.js', resume_download_bundle],
  ['cover-letter-harness.js', cover_letter_harness],
  ['job-collection-limits.js', job_collection_limits],
  ['job-search-queries.js', job_search_queries],
  ['electron-regressions.js', electron_regressions],
  ['renderer-content-security.js', renderer_content_security],
  ['local-ai-application.js', local_ai_application],
  ['local-ai-deletion.js', local_ai_deletion],
  ['login-url-markers.js', login_url_markers],
  ['compensation-assessment.js', compensation_assessment],
  ['job-compensation-pipeline.js', job_compensation_pipeline],
  ['job-search-locations.js', job_search_locations],
  ['job-board-provider.js', job_board_provider],
  ['job-fit-assessment.js', job_fit_assessment],
  ['auth-cookie-checkpoint.js', auth_cookie_checkpoint],
  ['browser-launch-lock-regression.js', browser_launch_lock_regression],
  ['claude-cache-telemetry.js', claude_cache_telemetry],
  ['claude-cache-bug-report.js', claude_cache_bug_report],
  ['schema-validation.js', schema_validation],
  ['claude-structured-outputs.js', claude_structured_outputs],
  ['job-resume-ingestion.js', job_resume_ingestion],
  ['non-api-ai.js', non_api_ai],
  ['job-workflow-documentation.js', job_workflow_documentation],
];

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
  return groups.flatMap(([, group]) => group);
}

async function run() {
  let passed = 0;
  let failed = 0;
  const tests = validateTestRegistry(testGroups);

  console.log(`\n[TEST RUNNER] Deterministic smoke tests (${testGroups.length} groups)\n`);

  for (const test of tests) {
    try {
      const details = await test.run();
      console.log(`PASS ${test.name}`, details ? JSON.stringify(details) : '');
      passed++;
    } catch (error) {
      console.error(`FAIL ${test.name}:`, error.stack || error.message);
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
