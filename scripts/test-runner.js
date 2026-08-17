import marketplace_monitor from './tests/marketplace-monitor.js';
import ai_models from './tests/ai-models.js';
import fixtures_canvas from './tests/fixtures-canvas.js';
import job_diagnostics from './tests/job-diagnostics.js';
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

const tests = [
  ...marketplace_monitor,
  ...ai_models,
  ...fixtures_canvas,
  ...job_diagnostics,
  ...marketplace_extractors_auth,
  ...jobs_location_language,
  ...job_source_country_scope,
  ...marketplace_diagnostics_locks,
  ...platform_utils,
  ...skill_opportunities,
  ...resume_download_bundle,
  ...cover_letter_harness,
  ...job_collection_limits,
  ...job_search_queries,
  ...electron_regressions,
  ...renderer_content_security,
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
