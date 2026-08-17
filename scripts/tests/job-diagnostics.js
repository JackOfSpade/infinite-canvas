import { ALL_COMP_SOURCE_IDS, CLAUDE_MEDIUM_MANUAL_THINKING_BUDGET, COL_X, MODEL_FLOOR, assert, applyBugReportCode, buildAnthropicMessageParams, buildAnthropicTokenCountParams, buildCachedUserContent, buildCoverLetterDocument, buildFilterSummaryMarkdown, buildJobTreeNodes, buildJobsPipelineSnapshot, buildOverlayScript, buildResumeDocument, buildResumeLengthRevisionPrompt, buildScoringAudit, canonicalSalaryRangeLabel, chunkScoringBatches, claudeReasoningMaxTokens, combineSignature, computeJobTreeView, computeLayoutPositions, countMatchingDescendantCards, decideFitStep, dedupAgainstHistory, dedupJobsAcrossSources, dedupeJobsByKey, deriveBoardCardStats, electronPkg, enforceClipboardMarkdownCap, enforceOnePageRevisionStructure, extractExecutedGoogleQueryStrings, extractSalaryFromText, extractVariantAttrs, extractZipRecruiterDomSalaryText, filterHandledJobSourceWarnings, filterJobsByDescriptionEvidence, formatGlassdoorCacheProvenance, formatJsonLdSalary, formatPipelineState, formatSourceEvent, formatUSAJobsSalary, fs, generateMarkdown, getApplicationTelemetry, getClaudeDefaultReasoningConfig, getJobsTelemetry, getManualScraperTelemetry, getStats, getStatsSignature, isDualMode, isIgnorableManualBrowserTelemetry, isJobCardVisible, isJobSourceWarningGating, isLegacyCombineSignature, isRemoteOkSponsoredPlacement, jobSourceWarningAction, jobTitleCompanyKey, jobTitleCompanyLocationKey, jobTitleCompanyUrlKey, linkedInBrowserUnavailableResult, linkedInBrowserUnavailableWarning, linkedInSameIpRetryDecision, looksLikeMoney, mergeExpandedJobDetail, mergeResolvedSourceItems, mergeSourceProgress, moduleFingerprint, normalizeBandsWithRepairs, normalizeCompWarnings, normalizeDetailNavigationUrl, normalizeRangesWithRepairs, parseSalaryToNumeric, path, reconcileBatchScores, reconcileZipRecruiterDomSalary, recordApplicationTelemetry, recordJobSourceProgress, recordJobsBoardScope, recordJobsSourceScope, recordLinkedinResolveAttempt, recordManualScraperTelemetry, resetManualScraperTelemetry, replaceApplicationBundleAtomically, reserveSharedProfile, resolveNodePresence, salaryRangeAnomaly, sanitizeJobTaxonomy, scoringAuditRowsFromBatches, shouldNavigateForDescription, isUnavailableDetailPage, sourceJobKey, staleReason, summarizeResumeMarkup, summarizeScoringInputQuality, targetPageCountForJob, unionScoredJobs, uniqueJobsAcrossSources, uniqueJobsNotIn, zipRecruiterRetryAfterMs } from '../test-dependencies.js';
import { JOB_COLLECTION_PAGE_CEILING, PDFLib, getApplicationSyncTelemetry, inspectApplicationExport, mergeSelectedApplicationPanel, recordApplicationSyncTelemetry } from '../test-dependencies.js';
import { reconcileTitleRelevanceFunnel, recordIssuedManualQuery } from '../test-dependencies.js';
import { buildLoginVerificationTimingMarkdown, formatLoginVerificationTimingResult } from '../../electron/ipc/bugReport.js';

export default [
{
    name: 'Job-hub Node Diagnostics distinguishes fetched listings from kept scoring input',
    run: () => {
      const report = generateMarkdown({
        description: 'Counter wording regression fixture.',
        nodes: [{
          id: 'job-hub-counter-fixture', type: 'jobhub',
          data: { hubState: 'done', gatheredCount: 31, scrapedCount: 3, resultCount: 3, scoredJobs: [{}, {}, {}] },
        }],
        edges: [], drawings: [], frontEndState: {}, nodeComponentStates: [],
        nodeInternals: [{
          id: 'job-hub-counter-fixture', type: 'jobhub', position: { x: 0, y: 0 },
          measured: { width: 260, height: 140 },
        }],
      }).markdown;
      assert(report.includes('scraped: 31 → kept: 3')
        && !report.includes('hubState: done, scraped: 3, results: 3'),
      'Node Diagnostics must not label the post-filter scoring input as the total scraped count');
      return { scraped: 31, kept: 3 };
    },
  },
{
    name: 'Login verification timing distinguishes verified, retained, and native-skipped state',
    run: () => {
      const report = buildLoginVerificationTimingMarkdown({
        startedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
        totalMs: 900,
        concurrency: 4,
        platformCount: 7,
        durations: [
          { platformId: 'indeed', ms: 500, connected: true, outcome: 'retained-prior', inconclusive: true, reason: 'transient fetch failure' },
          { platformId: 'linkedin', ms: 400, connected: true, outcome: 'verified', reason: 'feed loaded' },
          { platformId: 'mercari', ms: 0, connected: false, outcome: 'skipped-native', reason: 'native read owns login state' },
          { platformId: 'swappa', ms: 0, connected: false, outcome: 'skipped-login-flow', reason: 'login flow owns verification' },
          { platformId: 'legacy-ok', ms: 20, connected: false },
          { platformId: 'legacy-skip', ms: 0, connected: false, skipped: true },
          { platformId: 'failed', ms: 10, connected: false, outcome: 'error', error: 'navigation failed' },
        ],
      });
      assert(report.includes('retained prior: connected (inconclusive verify) — transient fetch failure'),
        'verification timing must not render a retained cache state as freshly connected');
      assert(report.includes('verified connected'),
        'verification timing must mark a fresh verifier verdict');
      const clipped = formatLoginVerificationTimingResult({
        connected: true, outcome: 'retained-prior', inconclusive: true,
        reason: `Anti-bot wall at https://example.test/${'very-long-path/'.repeat(20)}`,
      });
      assert(clipped.endsWith('…') && clipped.length < 180,
        'bounded verification reasons mark truncation with an ellipsis instead of ending mid-token silently');
      assert(report.includes('skipped native read (prior: not connected) — native read owns login state'),
        'verification timing must distinguish an intentional native-read skip');
      assert(report.includes('Platforms considered: 7')
        && report.includes('Fresh verifier attempts: 4 — 2 fresh verdicts; 1 retained prior after inconclusive verify; 1 error')
        && report.includes('Skipped without a verifier navigation: 3 — 1 native-state read; 1 login-flow skip; 1 legacy generic skip'),
      'verification timing must count considered platforms separately from fresh verifier attempts, outcome types, native/login skips, and legacy records');
      return { outcomes: 7 };
    },
  },
{
    name: 'Bug report clipboard cap reserves the logs + event timeline',
    run: () => {
      const events = Array.from({ length: 200 }, (_, i) => `EVT ${i} something happened on the canvas`);
      const logs = Array.from({ length: 60 }, (_, i) => `[Marketplace] LOG ${i} scrape/resolve detail line`);
      const fullFilterSummary = buildFilterSummaryMarkdown({
        filterCode: 'FULL',
        filterStats: { eventsShown: events.length, eventsTotal: events.length, omittedSections: [] },
      });

      // Small base, tiny cap unreachable: nothing truncated, everything present.
      const roomy = enforceClipboardMarkdownCap('# Bug Report\nbody\n', events, logs, 1_000_000);
      assert(!roomy.truncated && roomy.markdown.includes('## Event History') && roomy.markdown.includes('## Recent Main-Process Logs'),
        'Clipboard cap: roomy budget keeps logs + full event history untouched');
      assert(roomy.markdown.includes('**Timestamps:** UTC (`HH:MM:SS.mmm`).')
        && roomy.markdown.includes('**Timestamps:** local time (renderer).'),
      'Clipboard cap: timestamp bases are labeled for main-process and renderer evidence');
      assert(roomy.markdown.includes('EVT 0 ') && roomy.markdown.includes('EVT 199 '),
        'Clipboard cap: roomy budget keeps both oldest and newest events');

      // The normal file/export path does not invoke the clipboard cap. Its
      // independently assembled Event History heading must carry the same local
      // time basis as the cap helper's shared tail.
      const uncapped = generateMarkdown({
        description: 'Timestamp-basis regression fixture.',
        nodes: [], edges: [], drawings: [], frontEndState: {},
        nodeInternals: [], nodeComponentStates: [], eventLogs: ['12:00:00 renderer event'],
      }).markdown;
      assert(uncapped.includes('## Event History\n> **Timestamps:** local time (renderer). See Runtime Identity'),
        'Uncapped report labels renderer Event History timestamps as local time');
      assert(uncapped.includes('## Runtime Identity') && uncapped.includes('timezone ') && uncapped.includes('UTC offset '),
        'FULL report renders runtime versions and the date/timezone correlation anchor it already collects');

      // Phase 1: base fits but full tail doesn't — oldest events trimmed first,
      // newest events + the logs survive.
      const cap = 8_000;
      const smallBase = '# Bug Report\n' + fullFilterSummary + '\n' + 'x'.repeat(2_000) + '\n';
      const phase1 = enforceClipboardMarkdownCap(smallBase, events, logs, cap);
      assert(phase1.markdown.length <= cap, `Clipboard cap: phase-1 output must respect the cap (${phase1.markdown.length} <= ${cap})`);
      assert(phase1.trimmedEventCount > 0 && !phase1.hardTruncated, 'Clipboard cap: phase-1 should trim oldest events, not hard-truncate');
      assert(phase1.markdown.includes('EVT 199 ') && !phase1.markdown.includes('EVT 0 '),
        'Clipboard cap: phase-1 keeps the NEWEST events and sheds the oldest');
      assert(phase1.markdown.includes('## Recent Main-Process Logs') && phase1.markdown.includes('LOG 59'),
        'Clipboard cap: phase-1 must not sacrifice the main-process logs');
      assert(phase1.markdown.includes(`clipboard retained ${events.length - phase1.trimmedEventCount} of ${events.length} event line(s)`)
        && !phase1.markdown.includes(`event log kept all ${events.length} line(s)`),
      'Clipboard cap: phase-1 FULL summary reports final retained events, not the pre-cap selection');
      assert(phase1.markdown.includes(`retained ${events.length - phase1.trimmedEventCount} of ${events.length} most-recent event line(s)`)
        && phase1.markdown.includes(`${logs.length - phase1.trimmedLogCount} of ${logs.length} most-recent main-process log line(s)`),
      'Clipboard cap: phase-1 banner quantifies retained event and log lines');

      // Phase 2: the static base ALONE exceeds the cap (the bug from this report).
      // The logs + most-recent events MUST survive; the base tail is what gets cut.
      const giantBase = '# Bug Report\n' + fullFilterSummary + '\nNARRATIVE TOP\n' + 'Z'.repeat(40_000) + '\n## Node Diagnostics\nNODE TAIL\n';
      const phase2 = enforceClipboardMarkdownCap(giantBase, events, logs, cap);
      assert(phase2.markdown.length <= cap, `Clipboard cap: phase-2 output must respect the cap (${phase2.markdown.length} <= ${cap})`);
      assert(phase2.hardTruncated, 'Clipboard cap: phase-2 should flag a hard truncation');
      assert(phase2.markdown.includes('## Event History') && phase2.markdown.includes('EVT 199 '),
        'Clipboard cap: phase-2 MUST preserve the recent event timeline (regression guard)');
      assert(phase2.markdown.includes('**Timestamps:** UTC (`HH:MM:SS.mmm`).')
        && phase2.markdown.includes('**Timestamps:** local time (renderer).'),
      'Clipboard hard cap preserves both timestamp-basis notes with the retained diagnostics');
      assert(phase2.markdown.includes('## Recent Main-Process Logs') && phase2.markdown.includes('LOG 59'),
        'Clipboard cap: phase-2 MUST preserve the main-process logs (regression guard)');
      assert(phase2.markdown.includes('NARRATIVE TOP') && !phase2.markdown.includes('NODE TAIL'),
        'Clipboard cap: phase-2 keeps the curated top of the base and sheds its low-value tail');
      assert(phase2.markdown.includes(`clipboard retained ${events.length - phase2.trimmedEventCount} of ${events.length} event line(s)`)
        && !phase2.markdown.includes(`event log kept all ${events.length} line(s)`),
      'Clipboard cap: hard-capped FULL summary reports final retained events, not the pre-cap selection');
      assert(phase2.markdown.includes(`retained ${events.length - phase2.trimmedEventCount} of ${events.length} most-recent event line(s)`)
        && phase2.markdown.includes(`${logs.length - phase2.trimmedLogCount} of ${logs.length} most-recent main-process log line(s)`),
      'Clipboard cap: hard-cap banner quantifies retained event and log lines');
      assert(phase2.markdown.includes('static report content')
        && phase2.markdown.includes('oldest event history line(s)')
        && phase2.markdown.includes('oldest main-process log line(s)')
        && phase2.markdown.includes('Report content after this point was omitted by the clipboard cap')
        && !phase2.markdown.includes('older timeline entries')
        && !phase2.markdown.includes('static node/session tail'),
      'Clipboard cap: hard-cap copy names only the static/event/log content actually omitted');

      // A hard cap can truncate the large static base while preserving EVERY
      // event. Its banner must not claim that older event/timeline entries were
      // lost merely because other content was cut (the real FULL-report case).
      const shortEvents = Array.from({ length: 8 }, (_, i) => `SHORT EVT ${i}`);
      const longLogs = Array.from({ length: 60 }, (_, i) => `[Main] LONG LOG ${i} ${'detail '.repeat(12)}`);
      const staticAndLogsOnly = enforceClipboardMarkdownCap(giantBase, shortEvents, longLogs, cap);
      assert(staticAndLogsOnly.hardTruncated && staticAndLogsOnly.trimmedEventCount === 0
        && staticAndLogsOnly.trimmedLogCount > 0,
      'Clipboard cap: fixture hard-truncates static/log content while retaining the full event history');
      assert(staticAndLogsOnly.markdown.includes(`retained ${shortEvents.length} of ${shortEvents.length} most-recent event line(s)`)
        && !staticAndLogsOnly.markdown.includes('oldest event history line(s)')
        && !staticAndLogsOnly.markdown.includes('older timeline entries')
        && staticAndLogsOnly.markdown.includes('oldest main-process log line(s)'),
      'Clipboard cap: hard-cap banner does not claim event loss when every event was retained');

      // Name both kinds of static loss. The exact cap assertion is especially
      // important here because adding the names makes the banner longer and
      // therefore leaves less room for the base than the initial generic pass.
      const namedHardBase = '# Bug Report\n## Kept Summary\n' + 'A'.repeat(5_000)
        + '\n## Partial Audit\n' + 'B'.repeat(5_000)
        + '\n## Dropped Diagnostics\nbody\n## Also Dropped\nbody\n';
      const namedHard = enforceClipboardMarkdownCap(namedHardBase, events, logs, cap);
      assert(namedHard.hardTruncated && namedHard.markdown.length <= cap,
        `Clipboard cap: named hard-cap output respects the exact cap (${namedHard.markdown.length} <= ${cap})`);
      assert(namedHard.markdown.includes('3 section(s) dropped: Partial Audit, Dropped Diagnostics, Also Dropped')
        && namedHard.markdown.includes('"Kept Summary" cut mid-section'),
      'Clipboard cap: hard-cap banner names whole dropped sections and the section cut in progress');

      // This begins on the soft path (the base plus reserved tail fits), then
      // the event/log notice tips it into its secondary static hard-cap path.
      // It must use the same final-cut section diagnostics as the direct hard
      // path rather than reporting the stale generic or first-pass omission.
      const secondaryCap = 2_000;
      const secondarySections = Array.from({ length: 12 }, (_, i) => `## S${i}\n${String(i).repeat(84)}\n`).join('');
      const secondaryEvents = Array.from({ length: 100 }, (_, i) => `EVENT ${i} ${'x'.repeat(18)}`);
      const secondaryLogs = Array.from({ length: 60 }, (_, i) => `LOG ${i} ${'x'.repeat(18)}`);
      const secondaryHard = enforceClipboardMarkdownCap(secondarySections, secondaryEvents, secondaryLogs, secondaryCap);
      assert(secondaryHard.hardTruncated && secondaryHard.markdown.length <= secondaryCap,
        `Clipboard cap: secondary hard-cap output respects the exact cap (${secondaryHard.markdown.length} <= ${secondaryCap})`);
      assert(secondaryHard.markdown.includes('2 section(s) dropped: S10, S11')
        && secondaryHard.markdown.includes('"S9" cut mid-section'),
      'Clipboard cap: secondary hard-cap banner names the final dropped and partial sections');
      return { phase1Len: phase1.markdown.length, phase2Len: phase2.markdown.length, phase1Trimmed: phase1.trimmedEventCount };
    },
  },
{
    name: 'LinkedIn Solve telemetry reflects the latest attempt and permits cooled same-IP retry',
    run: () => {
      const telemetry = getJobsTelemetry();
      const prior = {
        nodeId: telemetry.nodeId,
        boardNodeId: telemetry.boardNodeId,
        windowId: telemetry.windowId,
        bucketing: telemetry.bucketing,
        sourceEvents: telemetry.sourceEvents,
        sourceEventsT0: telemetry.sourceEventsT0,
        pipeline: telemetry.pipeline,
        resolves: telemetry.resolves,
      };
      try {
        recordJobsSourceScope('linkedin-resolve-telemetry-test', 901);
        telemetry.sourceEvents = {};
        telemetry.sourceEventsT0 = Date.now() - 1_000;
        telemetry.pipeline = { phase: 'completed', active: false, ts: Date.now() - 1_000, pendingSources: [] };

        const first = recordLinkedinResolveAttempt('linkedin', {
          needEnrich: 9, enrichSuccess: 0, walled: true, skippedSameIp: true, warmIp: '70.48.176.119', stillEmpty: 9,
        });
        const second = recordLinkedinResolveAttempt('linkedin', {
          needEnrich: 1, enrichSuccess: 1, walled: false, stillEmpty: 0,
        });
        const latest = telemetry.resolves.linkedin;
        assert(latest === second && second.ts >= first.ts && !('skippedSameIp' in latest) && !('warmIp' in latest),
          'LinkedIn Solve telemetry must be a fresh latest-attempt snapshot, without a prior skip/IP leaking into a successful pass');

        recordLinkedinResolveAttempt('linkedin', {
          needEnrich: 4, enrichSuccess: 2, walled: true, stillEmpty: 2, warmIp: '185.98.171.115',
        });
        const blockedSolveReport = buildJobsPipelineSnapshot(new Set(['linkedin-resolve-telemetry-test']), 901, null);
        assert(blockedSolveReport.includes('hit a guest wall')
          && blockedSolveReport.includes('key may be IP, guest context, or fingerprint/session')
          && blockedSolveReport.includes('Wait about 1 minute then Solve on this IP'),
        'LinkedIn Solve report must present wait-or-switch guidance without asserting an IP-only limit');

        recordJobSourceProgress({ sourceId: 'linkedin', status: 'error', warning: { code: 'linkedin-rate-limited', severity: 'throttle' } });
        telemetry.pipeline = { ...telemetry.pipeline, phase: 'completed', active: false };
        recordJobSourceProgress({ sourceId: 'linkedin', status: 'done', detail: 're-fetch complete' }, {
          updatePipeline: false,
          expectedNodeId: 'linkedin-resolve-telemetry-test',
        });
        assert(telemetry.sourceEvents.linkedin.at(-1).status === 'done'
          && telemetry.pipeline.phase === 'completed' && telemetry.pipeline.active === false,
        'A post-search Solve must update the source trail to done without resurrecting the completed gather stage');

        const justWalled = linkedInSameIpRetryDecision('185.98.171.115', 1_000_000, '185.98.171.115', 1_000_001);
        const cooled = linkedInSameIpRetryDecision('185.98.171.115', 1_000_000, '185.98.171.115', 1_060_000);
        const switched = linkedInSameIpRetryDecision('185.98.171.115', 1_000_000, '149.22.82.90', 1_000_001);
        assert(justWalled.skip && justWalled.retryAfterMs > 0 && !cooled.skip && cooled.retryAfterMs === 0 && !switched.skip,
          'Same-IP retry policy must suppress only the immediate retry, then allow a one-minute cooled retry or an IP change');
        return { latestResolve: latest.enrichSuccess, cooledRetryAllowed: !cooled.skip };
      } finally {
        telemetry.nodeId = prior.nodeId;
        telemetry.boardNodeId = prior.boardNodeId;
        telemetry.windowId = prior.windowId;
        telemetry.bucketing = prior.bucketing;
        telemetry.sourceEvents = prior.sourceEvents;
        telemetry.sourceEventsT0 = prior.sourceEventsT0;
        telemetry.pipeline = prior.pipeline;
        telemetry.resolves = prior.resolves;
      }
    },
  },
{
    name: 'Application failure telemetry and APPLICATION filter remain diagnosable',
    run: () => {
      const prior = getApplicationTelemetry();
      try {
        recordApplicationTelemetry({
          attemptId: 'application-failure-report-test',
          nodeId: 'application-failure-card',
          jobTitle: 'Senior Example Engineer',
          company: 'Example Co',
          status: 'failed',
          stage: 'résumé generation',
          failedStage: 'résumé generation',
          error: 'Gemini quota exhausted after all compatible fallbacks.',
          companyResearch: { available: false, error: 'Research quota exhausted first.' },
          taskRoutes: [
            { task: 'company-research', provider: 'gemini', model: 'gemini-3.7-flash' },
            { task: 'application-resume', provider: 'gemini', model: 'gemini-3.7-flash' },
          ],
          stages: [
            { stage: 'model resolution', ts: Date.now() - 50 },
            { stage: 'company and role research', ts: Date.now() - 20 },
            { stage: 'résumé generation', ts: Date.now() - 1 },
            { stage: 'failed', ts: Date.now() },
          ],
        });
        const report = generateMarkdown({
          description: 'Generate failed.',
          nodes: [{ id: 'application-failure-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;
        assert(report.includes('### Application Generation (last)')
          && report.includes('Outcome: **⚠️ failed** · current/final stage: résumé generation')
          && report.includes('Gemini quota exhausted after all compatible fallbacks.')
          && report.includes('Company/role research unavailable — generation used only the scraped job description')
          && report.includes('application-resume → gemini / `gemini-3.7-flash`'),
        'FULL report must retain the failed application attempt, its exact stage/error, research fallback, and task route');

        recordApplicationTelemetry({
          attemptId: 'application-research-degraded-report-test',
          nodeId: 'application-failure-card', jobTitle: 'Senior Example Engineer', company: 'Example Co',
          status: 'completed', stage: 'completed', companyResearch: {
            available: false, error: 'Gemini quota exhausted while searching.',
          },
          jobContext: {
            scrapedDescriptionChars: 0, scrapedDescriptionAvailable: false,
            researchAvailable: false, limitedToMetadata: true,
          },
          taskOutcomes: [
            {
              task: 'company-research', provider: 'gemini', model: null,
              status: 'degraded', error: 'Gemini quota exhausted while searching.',
            },
            {
              task: 'application-letter-needs', provider: 'gemini', model: 'gemini-3.5-flash',
              status: 'completed', fallback: { attempts: 2, reason: 'rate-limit' }, error: null,
            },
          ],
          coverLetter: {
            needsAvailable: true, needsCount: 2, topNeedArgued: true, mappingCount: 1,
            planRetried: false, planDegraded: false, revised: false, pageCount: 1,
            checks: [],
          },
          applicationExport: {
            status: 'saved', destination: '/tmp/Applied Jobs/Example Co/Remote/Senior Example Engineer',
            savedAt: Date.now(), revealSucceeded: true, bundleError: null, integrityVerified: true,
            sync: {
              registered: true, serverListening: true,
              endpoint: 'http://127.0.0.1:43192/application-sync', error: null,
            },
            manifest: [
              { name: 'Application.html', expected: true, exists: true, readable: true, bytes: 82000, sha256: '0123456789abcdef', matchesSource: true, htmlStructureValid: true, htmlPanelCount: 2, syncConfigValid: true },
              { name: 'Resume.pdf', expected: true, exists: true, readable: true, bytes: 105000, sha256: '123456789abcdef0', matchesSource: true, pdfHeaderValid: true, pdfParsed: true, pageCount: 1, firstPagePoints: '612x792' },
              { name: 'Cover Letter.pdf', expected: true, exists: true, readable: true, bytes: 109000, sha256: '23456789abcdef01', matchesSource: true, pdfHeaderValid: true, pdfParsed: true, pageCount: 1, firstPagePoints: '612x792' },
              { name: 'Original Job Listing.md', expected: true, exists: true, readable: true, bytes: 445, sha256: '3456789abcdef012', matchesSource: true, markdownNonEmpty: true },
            ],
          },
        });
        const degradedReport = generateMarkdown({
          description: 'Generate completed without research.',
          nodes: [{ id: 'application-failure-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;
        assert(degradedReport.includes('Limited application context:')
          && degradedReport.includes('no scraped job description was captured')
          && degradedReport.includes('scraped description 0 char(s) (missing)')
          && degradedReport.includes('Gemini quota exhausted while searching.')
          && degradedReport.includes('application-letter-needs → gemini / `gemini-3.5-flash` [completed] (fallback after 2: rate-limit)')
          && degradedReport.includes('needs evidence source: job metadata only (title/company/location/salary; no scraped description or research)'),
        'Application report must state when generation had only metadata/career context, not claim an empty scraped description was used');
        assert(degradedReport.includes('### Application Export (last)')
          && degradedReport.includes('Outcome: **saved + integrity verified**')
          && degradedReport.includes('Resume.pdf: readable · 105000 bytes')
          && degradedReport.includes('source bytes exact · PDF header valid · PDF parse valid (1p, 612x792pt)')
          && degradedReport.includes('Local edit Sync: workspace registered · service listening')
          && degradedReport.includes('Opened destination folder: ✅')
          && degradedReport.includes('Applied-jobs record for this export: not marked'),
        'FULL report must include the bounded destination readback manifest and reveal result');

        const filtered = applyBugReportCode([
          '[JobApplication] Generating application',
          '[generate-application] failed: quota exhausted',
          '[Canvas] node moved',
        ], {}, 'APPLICATION');
        assert(filtered.filteredLogs.some(line => /JobApplication/.test(line))
          && filtered.filteredLogs.some(line => /generate-application/.test(line))
          && filtered.sectionExclusions.has('nodeInternals'),
        'APPLICATION filter selects application lifecycle logs (with causal context) while omitting heavy canvas diagnostics');
      } finally {
        recordApplicationTelemetry(prior);
      }
      return { status: 'failed', stage: 'résumé generation' };
    },
  },
{
    name: 'Application telemetry is scoped to the reporting canvas window',
    run: () => {
      const prior = getApplicationTelemetry();
      try {
        recordApplicationTelemetry({
          attemptId: 'application-foreign-window',
          nodeId: 'foreign-application-card',
          windowId: 902,
          jobTitle: 'Foreign Role',
          company: 'Foreign Company',
          status: 'completed',
        });
        const foreign = generateMarkdown({
          description: 'Check this canvas only.',
          nodes: [{ id: 'local-application-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }, 901).markdown;
        assert(!foreign.includes('Foreign Role') && !foreign.includes('Foreign Company'),
          'a FULL report must omit the last application attempt when it belongs to another window');

        recordApplicationTelemetry({
          attemptId: 'application-local-window',
          nodeId: 'local-application-card',
          windowId: 901,
          jobTitle: 'Local Role',
          company: 'Local Company',
          status: 'completed',
        });
        const local = generateMarkdown({
          description: 'Check this canvas only.',
          nodes: [{ id: 'local-application-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }, 901).markdown;
        assert(local.includes('### Application Generation (last)')
          && local.includes('Local Role @ Local Company')
          && !local.includes('Foreign Role'),
        'a same-window application attempt must remain in the FULL report');
      } finally {
        recordApplicationTelemetry(prior);
      }
      return { foreignWindowOmitted: true, localWindowRetained: true };
    },
  },
{
    name: 'Application Sync telemetry is integrity-rich and scoped to the saved canvas',
    run: () => {
      const prior = getApplicationSyncTelemetry();
      try {
        recordApplicationSyncTelemetry({
          attemptId: 'sync-report-test',
          workspaceDir: '/tmp/canvas-a/Applied Jobs/Example Co/Toronto/Engineer',
          document: 'cover', status: 'completed', phase: 'completed', finishedAt: Date.now(),
          manifest: [
            { name: 'Application.html', readable: true, bytes: 1200, sha256: 'abc123', matchesSource: true, htmlStructureValid: true, syncConfigValid: true },
            { name: 'Cover Letter.pdf', readable: true, bytes: 800, sha256: 'def456', matchesSource: true, pdfParsed: true, pageCount: 1, firstPagePoints: '612x792' },
          ],
        });
        const local = buildJobsPipelineSnapshot([], 901, '/tmp/canvas-a/canvas.json');
        assert(local.includes('### Application Sync (last)')
          && local.includes('completed + integrity verified')
          && local.includes('Document: cover letter')
          && local.includes('PDF parse valid (1p, 612x792pt)')
          && local.includes('source bytes exact'),
        'a FULL report must retain the local Sync outcome and exact-byte/structural readback evidence');

        const foreign = buildJobsPipelineSnapshot([], 901, '/tmp/canvas-b/canvas.json');
        assert(!foreign.includes('### Application Sync (last)') && !foreign.includes('sync-report-test'),
          'a Sync from another canvas Applied Jobs root must not appear in this report');
        return { localRetained: true, foreignOmitted: true };
      } finally {
        recordApplicationSyncTelemetry(prior);
      }
    },
  },
{
    name: 'Résumé length revision permits structural cuts after compact overflow',
    run: () => {
      const prompt = buildResumeLengthRevisionPrompt({
        mainHtml: '<main class="page"><section class="section"><ul><li>Weak one</li><li>Strong two</li></ul></section></main>',
        pageCount: 2, targetPageCount: 1, compactApplied: true,
      });
      assert(prompt.includes('cut at least 12 line(s)')
        && prompt.includes('explicitly supersedes the initial-draft bullet count')
        && prompt.includes('reduce every role to 1-2 strongest bullets')
        && prompt.includes('MUST contain fewer content blocks')
        && !prompt.includes('Keep the exact same markup structure'),
      'the fit revision must not forbid the bullet removals/merges it needs to reach the target');
      return { minimumLinesToCut: 12, structuralCutsAllowed: true };
    },
  },
{
    name: 'Résumé one-page revision is structurally enforced when the editor ignores the cut',
    run: () => {
      const input = `<main class="page"><article class="role"><div class="role-meta"><p class="role-summary">Redundant summary.</p></div><ul class="highlights"><li>Strongest</li><li>Second</li><li>Weak third</li></ul></article><dl class="skills"><dt>Ops</dt><dd>One</dd><dt>Safety</dt><dd>Two</dd></dl></main>`;
      const output = enforceOnePageRevisionStructure(input, 1);
      const before = summarizeResumeMarkup(input);
      const after = summarizeResumeMarkup(output);
      assert(before.bullets === 3 && after.bullets === 2 && before.roleSummaries === 1 && after.roleSummaries === 0,
        'one-page post-processing must cap each role at two bullets and remove redundant role summaries');
      assert(enforceOnePageRevisionStructure(input, 2) === input,
        'two-page targets must not receive the one-page structural cut');
      assert(after.hash !== before.hash && after.chars < before.chars && after.skillRows === 2,
        'revision diagnostics must prove a real structural change without deleting the Skills rows');
      assert(!/role-meta/.test(output),
        'a role-meta row emptied by the summary cut must be dropped, not left spending its margin on nothing');

      // The shipped Allied Universal résumé kept a lone city in the second
      // meta row: .meta-row is `1fr auto`, so the orphan sat in column one and
      // right-aligned exactly one --col-gap (0.32in) short of the dates above.
      const withLocation = `<main class="page"><article class="role"><div class="role-header meta-row"><p class="role-title-line"><span class="title">Security Officer</span></p><p class="role-dates"><time datetime="2024-10">Oct 2024</time> – <time>Present</time></p></div><div class="role-meta meta-row"><p class="role-summary">Cut me.</p><p class="role-location">Memphis, TN</p></div><ul class="highlights"><li>One</li></ul></article></main>`;
      const folded = enforceOnePageRevisionStructure(withLocation, 1);
      assert(!/role-meta/.test(folded) && !/role-location/.test(folded),
        'a role-meta row left holding only a location must be folded away, not kept as a whole line');
      assert(/class="role-dates"[^>]*>[\s\S]*?Present[\s\S]*?Memphis, TN[\s\S]*?<\/p>/.test(folded),
        'the folded location must land in the dates cell, after the date range');
      assert(summarizeResumeMarkup(folded).bullets === 1,
        'folding the location must not disturb the bullets');

      // A row still carrying a second cell is doing its job — leave it alone.
      const twoCell = `<main class="page"><article class="role"><div class="role-header meta-row"><p class="role-dates">Oct 2024</p></div><div class="role-meta meta-row"><p class="role-scope">Kept</p><p class="role-location">Memphis, TN</p></div><ul class="highlights"><li>One</li></ul></article></main>`;
      assert(/role-meta/.test(enforceOnePageRevisionStructure(twoCell, 1)),
        'a populated two-cell meta row must survive the one-page cut');
      return { before, after, folded: folded.length };
    },
  },
{
    name: 'Résumé compact density reaches printed @page margins',
    run: () => {
      const css = fs.readFileSync(path.join(process.cwd(), 'resume_design_system', 'resume.css'), 'utf8');
      assert(css.includes('@page letter-compact') && css.includes('margin: 0.6in 0;')
        && css.includes('[data-density="compact"] .page { page: letter-compact; }'),
      'compact density must select a named Letter page with the advertised 0.6in print margins');
      assert(css.includes('@page a4-compact') && css.includes('page: a4-compact;'),
        'A4 + compact must select its own compact named page instead of falling back to full A4 margins');
      // .meta-row is `1fr auto`; a lone cell lands in column one and stops a
      // full --col-gap short of the content edge unless it spans both tracks.
      assert(/\.meta-row\s*>\s*:only-child\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/.test(css),
        'a single-cell meta row must span both columns so it aligns to the content edge');
      return { letterCompact: true, a4Compact: true, onlyChildSpan: true };
    },
  },
{
    name: 'Application prompts preserve evidence scope and reject pseudo-growth metrics',
    run: () => {
      const source = fs.readFileSync(path.join(process.cwd(), 'electron', 'ipc', 'jobApplication.js'), 'utf8');
      assert(source.includes('sequential jobs/employers/clients/sectors are chronology, not percentage growth')
        && source.includes('Never convert a sequence or count of jobs, employers, clients, sectors, or role changes into percentage growth'),
      'achievement refutation and résumé writing must both reject sequential-role counts presented as scope growth');
      assert(source.includes('Do not strengthen "coordinated with emergency personnel" into "served as the municipal point of contact"')
        && source.includes('General evening/weekend availability may be described only at that same level')
        && source.includes('never imply that they are local, can commute, or will relocate'),
      'cover-letter generation must preserve evidence specificity, availability granularity, and geography truthfulness');
      assert(source.includes('does not make CPR/BLS a high-impact gap unless the target posting explicitly requires or strongly prefers CPR/BLS'),
        'skill-gap analysis must not elevate an adjacent, unstated CPR/BLS credential into a blocking check');
      return { achievementScope: true, coverEvidenceScope: true, cprGate: true };
    },
  },
{
    name: 'Application workspace requires confirmation for an on-site city mismatch',
    run: () => {
      const doc = buildResumeDocument({
        resumeMainHtml: '<main class="page"><h1 class="name">Derrick</h1></main>',
        docId: 'location-check',
        jobContext: {
          title: 'Security Guard', company: 'Allied Universal',
          candidateLocation: 'Memphis, TN', location: 'Charlotte, NC, United States',
        },
      });
      assert(doc.includes('data-ic-location-check="work-location"')
        && doc.includes('Memphis, TN') && doc.includes('Charlotte, NC, United States')
        && doc.includes('I can work there'),
      'a cross-city on-site application must show a concrete work-location confirmation card');
      assert(doc.includes('var locationBlocked = !!locationCard && !locationConfirmed;')
        && doc.includes('var blocked = locationBlocked || (activeDocument === \'resume\' && reviewBlocked);'),
      'unresolved location confirmation must gate Sync for both résumé and cover-letter documents');
      const sameCity = buildResumeDocument({
        resumeMainHtml: '<main class="page">Same city</main>',
        jobContext: { candidateLocation: 'Charlotte, NC', location: 'Charlotte, NC, United States' },
      });
      assert(!sameCity.includes('data-ic-location-check="work-location"'),
        'format differences within the same city must not create a false relocation check');
      return { mismatchBlocked: true, sameCityClear: true };
    },
  },
{
    name: 'Application bundle replacement removes stale siblings and rolls back a partial promotion',
    run: async () => {
      const dir = await fs.promises.mkdtemp('/tmp/infinite-canvas-application-transaction-');
      const files = {
        html: path.join(dir, 'Application.html'),
        resume: path.join(dir, 'Resume.pdf'),
        cover: path.join(dir, 'Cover Letter.pdf'),
        listing: path.join(dir, 'Original Job Listing.md'),
      };
      try {
        await Promise.all([
          fs.promises.writeFile(files.html, 'old html'),
          fs.promises.writeFile(files.resume, '%PDF-old resume'),
          fs.promises.writeFile(files.cover, '%PDF-old cover'),
          fs.promises.writeFile(files.listing, 'old listing'),
        ]);
        await replaceApplicationBundleAtomically([
          { destination: files.html, data: 'new html' },
          { destination: files.resume, data: null },
          { destination: files.cover, data: '%PDF-new cover' },
          { destination: files.listing, data: null },
        ]);
        assert(await fs.promises.readFile(files.html, 'utf8') === 'new html'
          && await fs.promises.readFile(files.cover, 'utf8') === '%PDF-new cover',
        'a successful transaction promotes every produced artifact');
        assert(!fs.existsSync(files.resume) && !fs.existsSync(files.listing),
          'a new generation that lacks an optional artifact removes the stale prior sibling');

        await Promise.all([
          fs.promises.writeFile(files.html, 'baseline html'),
          fs.promises.writeFile(files.resume, '%PDF-baseline resume'),
          fs.promises.writeFile(files.cover, '%PDF-baseline cover'),
          fs.promises.writeFile(files.listing, 'baseline listing'),
        ]);
        const realOps = fs.promises;
        const failingOps = {
          access: (...args) => realOps.access(...args),
          writeFile: (...args) => realOps.writeFile(...args),
          unlink: (...args) => realOps.unlink(...args),
          rename: (source, destination) => {
            if (/\.Cover Letter\.pdf\..*\.tmp$/.test(source) && destination === files.cover) {
              return Promise.reject(new Error('simulated cover promotion failure'));
            }
            return realOps.rename(source, destination);
          },
        };
        let failed = false;
        try {
          await replaceApplicationBundleAtomically([
            { destination: files.html, data: 'v2 html' },
            { destination: files.resume, data: '%PDF-v2 resume' },
            { destination: files.cover, data: '%PDF-v2 cover' },
            { destination: files.listing, data: 'v2 listing' },
          ], { fileOps: failingOps });
        } catch (error) {
          failed = /simulated cover promotion failure/.test(error.message);
        }
        assert(failed, 'the injected mid-transaction promotion failure must reach the caller');
        assert(await fs.promises.readFile(files.html, 'utf8') === 'baseline html'
          && await fs.promises.readFile(files.resume, 'utf8') === '%PDF-baseline resume'
          && await fs.promises.readFile(files.cover, 'utf8') === '%PDF-baseline cover'
          && await fs.promises.readFile(files.listing, 'utf8') === 'baseline listing',
        'a partial promotion restores the complete previous bundle, never a mixed generation');
        let verificationFailed = false;
        try {
          await replaceApplicationBundleAtomically([
            { destination: files.html, data: 'unverified html' },
            { destination: files.resume, data: '%PDF-unverified resume' },
          ], { verify: async () => { throw new Error('simulated readback failure'); } });
        } catch (error) {
          verificationFailed = /simulated readback failure/.test(error.message);
        }
        assert(verificationFailed
          && await fs.promises.readFile(files.html, 'utf8') === 'baseline html'
          && await fs.promises.readFile(files.resume, 'utf8') === '%PDF-baseline resume',
        'a failed post-write verification also restores the prior visible artifacts');
        return { staleRemoved: 2, rollbackRestored: 4, readbackRollback: true };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
  },
},
{
    name: 'Application export integrity parses PDFs and matches every promoted byte',
    run: async () => {
      const dir = await fs.promises.mkdtemp('/tmp/infinite-canvas-application-integrity-');
      const htmlPath = path.join(dir, 'Application.html');
      const pdfPath = path.join(dir, 'Resume.pdf');
      const listingPath = path.join(dir, 'Original Job Listing.md');
      const token = 'a'.repeat(64);
      const html = `<!doctype html><html><body><section data-ic-document-panel="resume"><main class="page">Resume</main></section><section data-ic-document-panel="cover"><main class="page">Cover</main></section><script id="ic-application-bundle-data" type="application/json">{"sync":{"endpoint":"http://127.0.0.1:43192/application-sync","token":"${token}"}}</script></body></html>`;
      const listing = '# Example Role\n\n**Company:** Example Co\n';
      const pdf = await PDFLib.PDFDocument.create();
      pdf.addPage([612, 792]);
      const pdfBytes = Buffer.from(await pdf.save());
      try {
        await Promise.all([
          fs.promises.writeFile(htmlPath, html),
          fs.promises.writeFile(pdfPath, pdfBytes),
          fs.promises.writeFile(listingPath, listing),
        ]);
        const manifest = await inspectApplicationExport([
          { path: htmlPath, expectedData: html, kind: 'html' },
          { path: pdfPath, expectedData: pdfBytes, kind: 'pdf' },
          { path: listingPath, expectedData: listing, kind: 'markdown' },
        ]);
        const pdfRow = manifest.find(row => row.name === 'Resume.pdf');
        assert(manifest.every(row => row.integrityVerified && row.matchesSource)
          && pdfRow?.pdfParsed && pdfRow.pageCount === 1 && pdfRow.firstPagePoints === '612x792',
        'readback must prove exact source bytes and parse a non-empty Letter PDF');

        await fs.promises.writeFile(pdfPath, '%PDF-not-a-real-document');
        let corruptRejected = false;
        try {
          await inspectApplicationExport([{ path: pdfPath, expectedData: Buffer.from('%PDF-not-a-real-document'), kind: 'pdf' }]);
        } catch (error) {
          corruptRejected = /readback failed/.test(error.message);
        }
        assert(corruptRejected, 'a matching %PDF- prefix must not make a structurally corrupt PDF pass readback');

        await fs.promises.writeFile(listingPath, 'different bytes');
        let mismatchRejected = false;
        try {
          await inspectApplicationExport([{ path: listingPath, expectedData: listing, kind: 'markdown' }]);
        } catch (error) {
          mismatchRejected = /readback failed/.test(error.message);
        }
        assert(mismatchRejected, 'destination bytes that differ from the staged source must fail readback');
        let missingSourceRejected = false;
        try {
          await inspectApplicationExport([{ path: listingPath, kind: 'markdown' }]);
        } catch (error) {
          missingSourceRejected = /readback failed/.test(error.message);
        }
        assert(missingSourceRejected, 'an integrity claim requires staged source bytes to compare against');
        return { artifactsVerified: manifest.length, corruptRejected, mismatchRejected, missingSourceRejected };
      } finally {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    },
  },
{
    name: 'Application Sync persists only the selected panel revision',
    run: () => {
      const workspace = (resume, cover, shell) => `<!doctype html><html><body data-shell="${shell}"><section data-ic-document-panel="resume"><main class="page">${resume}</main></section><section data-ic-document-panel="cover"><main class="page">${cover}</main></section></body></html>`;
      const stored = workspace('saved resume', 'saved cover', 'stored');
      const incoming = workspace('edited resume', 'edited cover', 'incoming');
      const resumeMerged = mergeSelectedApplicationPanel(incoming, stored, 'resume');
      assert(resumeMerged.includes('edited resume') && resumeMerged.includes('saved cover')
        && !resumeMerged.includes('edited cover') && resumeMerged.includes('data-shell="incoming"'),
      'résumé Sync must retain the incoming résumé and last-synced cover panel without serializing the shell');
      const coverMerged = mergeSelectedApplicationPanel(incoming, stored, 'cover');
      assert(coverMerged.includes('saved resume') && coverMerged.includes('edited cover')
        && !coverMerged.includes('edited resume'),
      'cover Sync must retain the incoming cover and last-synced résumé panel');
      let malformedRejected = false;
      try {
        mergeSelectedApplicationPanel('<html><body></body></html>', stored, 'resume');
      } catch (error) {
        malformedRejected = /exactly one resume panel/.test(error.message);
      }
      assert(malformedRejected, 'Sync must reject a workspace that cannot preserve its inactive panel');
      let missingSelectedRejected = false;
      try {
        mergeSelectedApplicationPanel('<html><body><section data-ic-document-panel="cover"><main class="page">Cover only</main></section></body></html>', stored, 'resume');
      } catch (error) {
        missingSelectedRejected = /exactly one resume panel/.test(error.message);
      }
      let duplicateRejected = false;
      try {
        mergeSelectedApplicationPanel(incoming.replace('</body>', '<section data-ic-document-panel="cover"><main class="page">Duplicate</main></section></body>'), stored, 'resume');
      } catch (error) {
        duplicateRejected = /exactly one cover panel \(found 2\)/.test(error.message);
      }
      assert(missingSelectedRejected && duplicateRejected,
        'Sync must reject a missing selected panel and duplicate selected/inactive panels before rendering');
      return { resumeIsolated: true, coverIsolated: true, malformedRejected, missingSelectedRejected, duplicateRejected };
    },
  },
{
    name: 'Application report renders skill-opportunity detail, honest fit-loop labeling, and the Skills-block sample',
    run: () => {
      const prior = getApplicationTelemetry();
      try {
        // A completed generation whose verify-item sample was capped (25
        // analyzed, only 20 kept) — the report must show the kept items AND
        // say plainly how many were left out, per the clipboard-cap
        // truncation-marking convention used everywhere else in this section.
        const verifySample = Array.from({ length: 20 }, (_, i) => ({
          canonicalSkillName: `Skill ${i}`,
          resumeCategory: i === 0 ? 'Infrastructure' : 'Certifications',
        }));
        recordApplicationTelemetry({
          attemptId: 'application-skillops-report-test',
          nodeId: 'application-skillops-card',
          jobTitle: 'Platform Engineer',
          company: 'Example Co',
          status: 'completed',
          stage: 'completed',
          companyResearch: { available: true, error: null },
          coverLetter: {
            salutation: 'Dear Example Co Hiring Team,', recipient: 'Hiring Team\nExample Co',
            paragraphs: ['A concise thesis.', 'A grounded mechanism.'], closing: 'Sincerely,',
            signatureTitle: 'Platform Engineer · candidate', contact: ['Toronto, ON'],
            needsAvailable: true, needsCount: 3, topNeedArgued: true, mappingCount: 1,
            droppedNeeds: [{ need: 'Own the data plane', reason: 'No résumé evidence supports it.' }],
            planRetried: true, planRetryReason: 'first mapping was not grounded', planDegraded: false,
            checks: [
              { id: 'evidence-grounding', passed: true, detail: 'one mapping grounded' },
              { id: 'company-specificity', passed: false, detail: 'no research-sourced specific appears in the letter' },
            ],
            revised: true, revisionError: null, pageCount: 1,
          },
          coverLetterPlan: {
            roleThesis: 'Operational judgment is the relevant through-line.',
            mappings: [{ needIndex: 0, evidence: 'Triaged incomplete reports under time pressure.' }],
            companyHook: { detail: '', source: '', whyItMattersToCandidate: '' },
            logistics: '', droppedNeeds: [{ needIndex: 2, reason: 'No résumé evidence supports it.' }],
          },
          achievements: { source: 'reused', kept: 8, suppressedWeakened: 1, stats: null, minedBy: null },
          variantAttrs: 'data-print="ink-only" data-mono',
          resumeHtmlSample: '<main class="page" data-print="ink-only" data-mono><section class="section"><h1>Jordan Rivera</h1></section>',
          resumeSkillsDlSample: {
            found: true,
            sample: '<dl class="skills">\n  <dt>Infrastructure</dt>\n  <dd>Kubernetes<span class="sep" data-ic-inferred-separator="join" hidden>·</span><span class="ic-inferred-skill" data-ic-inferred-skill="skill-1" hidden>Terraform</span></dd>\n</dl>',
            truncated: false,
          },
          resumeRoleBlockSample: {
            found: true,
            roleCount: 3,
            sample: '<article class="role"><div class="role-header meta-row"><p class="role-title-line"><span class="title">Security Officer</span></p><p class="role-dates">Oct 2024 – Present<span class="sep" aria-hidden="true">·</span>Memphis, TN</p></div><ul class="highlights"><li>One</li></ul></article>',
            truncated: false,
          },
          skillOpportunities: {
            itemCount: 25, verifyCount: 25, learnCount: 0, histogramRoleCount: 3,
            error: null, recordedAfterArtifacts: true,
            verifyItems: { sample: verifySample, total: 25, truncated: true },
          },
          render: {
            targetPageCount: 1, attempts: [{ attempt: 1, density: null, pageCount: 2, fontsLoaded: true }],
            initialPageCount: 2, finalPageCount: 2, compactApplied: true, revisionApplied: true,
            revisionDiagnostics: {
              input: { chars: 7000, hash: 'aaaaaaaaaaaa', bullets: 9, roleSummaries: 3, skillRows: 4 },
              editorOutput: { chars: 5600, hash: 'cccccccccccc', bullets: 8, roleSummaries: 0, skillRows: 4 },
              output: { chars: 5100, hash: 'bbbbbbbbbbbb', bullets: 6, roleSummaries: 0, skillRows: 4 },
            },
            pdfProduced: true, baselinePdfProduced: true,
            baselinePageCount: 1, baselinePdfError: null, baselineFontsLoaded: true,
            coverLetterPdfProduced: true, coverLetterPdfError: null, coverLetterFontsLoaded: true,
            resumeRequiresReview: true, locationReviewRequired: true,
            candidateLocation: 'Memphis, TN', jobLocation: 'Charlotte, NC, United States',
            error: null, fontsLoaded: true,
          },
        });
        const report = generateMarkdown({
          description: 'Generate completed with skill-opportunity detail.',
          nodes: [{ id: 'application-skillops-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;

        assert(report.includes('Skill-opportunity analysis: 25 item(s) — 25 verify, 0 learn · histogram 3 role(s) · demand recorded after artifacts'),
          'Report must render the skill-opportunity counts and recordedAfterArtifacts flag');
        assert(report.includes('"Skill 0" → "Infrastructure"') && report.includes('"Skill 19" → "Certifications"'),
          'Report must render per-item canonical skill name → résumé category pairs');
        assert(report.includes('_5 additional verify item(s) omitted from this bounded sample._'),
          'Report must mark the verify-item sample as truncated with an exact count, not emit silently');
        assert(report.includes('Résumé variant: `data-print="ink-only" data-mono`'),
          'Report must render the captured variantAttrs as a structured field');
        // The head slice dies inside the first role header, so without this
        // block the Experience structure the fit loop edits is invisible.
        assert(report.includes('Résumé role block (first of 3 `<article class="role">`')
          && report.includes('<p class="role-dates">Oct 2024 – Present'),
          'Report must render a whole role block so the shipped Experience structure is visible');
        // "6 bullets" alone cannot say whether the editor complied or the
        // clamp truncated it; the editor snapshot is what separates them.
        assert(report.includes('structural clamp: APPLIED — editor returned 5600 chars · bullets 8'),
          'Report must attribute the one-page cut to the editor or to the structural clamp');
        assert(report.includes('1 refute-weakened item(s) withheld from application prompts'),
          'Report must say when a cached achievement remains auditable but is intentionally unavailable to résumé/letter generation');
        // The fit-loop measures the worst case (all candidate skills shown);
        // the shipped baseline is a separate, honestly-labeled number that
        // must never be conflated with it (this report's whole reason for
        // existing — see Defect 2).
        assert(report.includes('Résumé fit-loop (worst case, ALL candidate skills shown — NOT the shipped page count): target 1p · 2→2p · compact applied · 1 length-revision call')
          && !report.includes('Résumé render/fit:'),
          'Fit-loop line must be relabeled as the worst-case measurement, not implied to be the delivered document');
        assert(report.includes('Résumé shipped baseline: 1p · PDF produced'),
          'Report must record the shipped baseline page count separately, obtained free from the baseline PDF render');
        assert(report.includes('length revision: 7000→5100 chars · bullets 9→6 · role summaries 3→0 · skill rows 4→4 · hash aaaaaaaaaaaa→bbbbbbbbbbbb'),
          'Report must show whether the length editor actually changed structure, not only that it was called');
        assert(report.includes('Work-location confirmation required before Sync: candidate `Memphis, TN` → job `Charlotte, NC, United States`'),
          'Report must expose a candidate/job city mismatch and the required confirmation gate');
        assert(report.includes('<dl class="skills">') && report.includes('Terraform'),
          'Report must include the résumé\'s Skills <dl> block, where skill-opportunity injection actually lands');
        assert(report.includes('Cover-letter harness: needs available (3) · top need argued · 1 mapping(s) · plan retried once')
          && report.includes('company-specificity: no research-sourced specific appears in the letter'),
        'Report must surface the harness lifecycle and factual unmet-check observation');
        assert(report.includes('Cover-letter argument plan')
          && report.includes('Operational judgment is the relevant through-line.'),
        'Report must include the persisted typed argument plan that explains the generated prose');

        // A second generation whose résumé genuinely had no Skills section —
        // the report must say so explicitly rather than rendering nothing.
        recordApplicationTelemetry({
          attemptId: 'application-skillops-no-skills-report-test',
          nodeId: 'application-skillops-card', jobTitle: 'Platform Engineer', company: 'Example Co',
          status: 'completed', stage: 'completed',
          resumeHtmlSample: '<main class="page"><section class="section"><h1>Jordan Rivera</h1></section>',
          resumeSkillsDlSample: { found: false, sample: '', truncated: false },
          skillOpportunities: { itemCount: 0, verifyCount: 0, learnCount: 0, histogramRoleCount: 3, error: null },
        });
        const noSkillsReport = generateMarkdown({
          description: 'Generate completed with no Skills block.',
          nodes: [{ id: 'application-skillops-card', type: 'jobcard', data: {} }],
          edges: [], drawings: [], frontEndState: {}, nodeInternals: [], nodeComponentStates: [],
        }).markdown;
        assert(noSkillsReport.includes('⚠️ Résumé Skills block (`<dl class="skills">`) was not found in the final document.'),
          'Report must state explicitly when the Skills block is absent, not emit nothing (Defect 3\'s own diagnostics principle)');
      } finally {
        recordApplicationTelemetry(prior);
      }
      return { verifyItemsSampled: 20, verifyItemsTotal: 25 };
    },
  },
{
    name: 'Bug report preserves failed diagnostic sections and profile reservations',
    run: () => {
      const releaseReservation = reserveSharedProfile('captcha-resolve:bug-report-test');
      try {
        const malformedMedia = {
          tag: 'video',
          seekable: {
            length: 1,
            map: () => { throw new Error('malformed media\n`payload`'); },
          },
        };
        const report = generateMarkdown({
          description: 'The browser is busy.',
          nodes: [], edges: [], drawings: [], frontEndState: {},
          nodeInternals: [], nodeComponentStates: [], mediaState: [malformedMedia],
        }).markdown;
        assert(report.includes('## Media Player State')
          && report.includes('section failed to render: `malformed media \'payload\'`'),
        'Bug report must visibly preserve a bounded, sanitized marker when a section renderer fails');
        assert(report.includes('Shared profile reservation: `captcha-resolve:bug-report-test`')
          && report.includes('a headless scrape must wait until that visible browser closes'),
        'Bug report must show an active shared-profile reservation even before a browser launches');
      } finally {
        releaseReservation();
      }
      return { ok: true };
    },
  },
{
    name: 'LinkedIn shared-profile reservation is explicit and retryable',
    run: () => {
      const jobs = [{ url: 'https://www.linkedin.com/jobs/view/1', snippet: '' }];
      const reserved = linkedInBrowserUnavailableResult(
        jobs,
        new Error('Shared browser profile is reserved for captcha-resolve:captcha:www.glassdoor.com; headless stealth browser cannot start until that visible browser closes.'),
      );
      assert(reserved.browserUnavailable === true && reserved.profileReserved === true && reserved.retryable === true,
        'shared-profile collision must be explicit and retryable, never a clean LinkedIn pass');
      assert(reserved.successCount === 0 && reserved.jobs === jobs,
        'collision preserves un-enriched jobs and reports zero enrichment');
      const warning = linkedInBrowserUnavailableWarning(reserved);
      assert(warning.code === 'browser-profile-reserved' && warning.severity === 'throttle' && warning.shortLabel === 'Browser busy',
        'collision renders an actionable retryable source warning');
      assert(/close the other captcha\/login window/i.test(warning.suggestion),
        'retry guidance explains how to release the shared profile');

      const unavailable = linkedInBrowserUnavailableResult(jobs, new Error('Chrome failed to launch'));
      assert(unavailable.browserUnavailable === true && unavailable.profileReserved === false && unavailable.retryable === true,
        'non-reservation browser startup failures also cannot be laundered into clean completion');
      return { code: warning.code, profileReserved: reserved.profileReserved };
    },
  },
{
    name: 'job pipeline report: LinkedIn browser contention is retryable, not clean',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        linkedinEnrich: telemetry.linkedinEnrich,
        linkedinCooldown: telemetry.linkedinCooldown,
      };
      Object.assign(telemetry, {
        nodeId: 'linkedin-browser-contention',
        linkedinEnrich: [{
          ts: Date.now(),
          startedAt: Date.now() - 1000,
          kind: 'search',
          browserUnavailable: true,
          stillEmpty: 3,
          enriched: 0,
        }],
        linkedinCooldown: { running: false, attempts: 2, foundMs: null, waitsMs: [60000], browserUnavailable: true },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['linkedin-browser-contention']), null, null);
        assert(report.includes('browser/profile contention — retryable'),
          'profile reservation renders as a retryable browser contention outcome');
        assert(report.includes('not a clean finish or a guest-limit result'),
          'residual explains that contention did not prove LinkedIn recovered');
        assert(report.includes('Cooldown probe paused — browser/profile contention'),
          'a contention-paused cooldown probe is not reported as exhausted');
        assert(!report.includes('**clean finish (cold)**'),
          'contention-only trail must never be labelled clean');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
  },
},
{
    name: 'job pipeline report: LinkedIn scope and cooldown inferences require a stable IP/browser identity',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        linkedinEnrich: telemetry.linkedinEnrich,
        linkedinCooldown: telemetry.linkedinCooldown,
      };
      const now = Date.now();
      try {
        // This mirrors the misleading real-world pattern: every pass uses the
        // same browser generation, but each one receives a smaller pool and a
        // different VPN egress. The final clean result cannot be credited to a
        // 40s cooldown, and the falling yield cannot identify a session limit.
        Object.assign(telemetry, {
          nodeId: 'linkedin-identity-controls', windowId: null, linkedinCooldown: null,
          linkedinEnrich: [
            { ts: now - 60_000, startedAt: now - 65_000, kind: 'search', ip: '70.0.0.1', walled: true, attempted: 58, remainingBefore: 58, enriched: 16, stillEmpty: 42, browserGen: 2 },
            { ts: now - 40_000, startedAt: now - 45_000, kind: 'solve', ip: '185.0.0.1', walled: true, attempted: 42, remainingBefore: 42, enriched: 4, stillEmpty: 38, browserGen: 2 },
            { ts: now - 20_000, startedAt: now - 25_000, kind: 'solve', ip: '141.0.0.1', walled: true, attempted: 38, remainingBefore: 38, enriched: 5, stillEmpty: 33, browserGen: 2 },
            { ts: now - 1_000, startedAt: now - 6_000, kind: 'solve', ip: '149.0.0.1', walled: false, attempted: 1, remainingBefore: 1, enriched: 1, stillEmpty: 0, browserGen: 2 },
          ],
        });
        const changedIpReport = buildJobsPipelineSnapshot(new Set(['linkedin-identity-controls']), null, null);
        assert(changedIpReport.includes('cannot identify whether the ceiling is IP- or browser/session-scoped')
          && changedIpReport.includes('remaining input pool also shrank')
          && changedIpReport.includes('attempted 1'),
        'changed-IP, shrinking-pool trail must be explicitly inconclusive and expose per-pass workload');
        assert(!changedIpReport.includes('yield collapsed')
          && !changedIpReport.includes('That points to a **browser/session-scoped** limit')
          && !changedIpReport.includes('Cooldown ≈')
          && changedIpReport.includes('Cooldown cannot be estimated from this trail'),
        'changed IPs must not be turned into a browser-scope verdict or a cooldown estimate');

        telemetry.linkedinCooldown = {
          running: false, attempts: 2, foundMs: null, waitsMs: [60_000], identityChanged: true,
          expectedIdentity: { ip: '70.0.0.1', browserGen: 2 },
          observedIdentity: { ip: '149.0.0.1', browserGen: 2 },
        };
        const invalidProbeReport = buildJobsPipelineSnapshot(new Set(['linkedin-identity-controls']), null, null);
        assert(invalidProbeReport.includes('Cooldown probe invalid — IP/browser identity changed')
          && !invalidProbeReport.includes('Cooldown confirmed:'),
        'an automated probe with a changed egress/browser identity must be marked invalid, never confirmed');

        // A cooldown bound is allowed only when the prior wall and retry share
        // both observed egress IP and browser generation.
        Object.assign(telemetry, {
          linkedinCooldown: null,
          linkedinEnrich: [
            { ts: now - 30_000, startedAt: now - 35_000, kind: 'search', ip: '70.0.0.1', walled: true, attempted: 10, remainingBefore: 10, enriched: 2, stillEmpty: 8, browserGen: 3 },
            { ts: now - 1_000, startedAt: now - 6_000, kind: 'solve', ip: '70.0.0.1', walled: false, attempted: 8, remainingBefore: 8, enriched: 8, stillEmpty: 0, browserGen: 3 },
          ],
        });
        const stableIdentityReport = buildJobsPipelineSnapshot(new Set(['linkedin-identity-controls']), null, null);
        assert(stableIdentityReport.includes('Cooldown on IP 70.0.0.1, browser#3: ≤ 24s'),
          'a clean retry after a wall can bound cooldown only for its matching IP/browser identity');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { changedIpInconclusive: true, stableIdentityBounded: true };
    },
  },
{
    name: 'job pipeline report: saved LinkedIn short-description input overrides stale clean telemetry',
    run: () => {
      const dir = path.join(electronPkg.app.getPath('userData'), 'job-search');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'job-search-last-scrape.json'), JSON.stringify({ jobs: [{
        source: 'linkedin', title: 'Maintenance Technician II', company: 'Acme',
        url: 'https://linkedin.example/jobs/short', snippet: 'Short listing-card excerpt only. '.repeat(3),
        salary: '', posted: '2026-08-01',
      }] }), 'utf8');

      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        linkedinEnrich: telemetry.linkedinEnrich, linkedinCooldown: telemetry.linkedinCooldown,
      };
      Object.assign(telemetry, {
        nodeId: 'linkedin-short-snapshot', windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1 },
        linkedinEnrich: [{
          ts: Date.now(), startedAt: Date.now() - 1000, kind: 'search', browserGen: 1,
          walled: false, enriched: 1, stillEmpty: 0, noDesc: 0, noDescSoftBlock: 0, noDescGenuine: 0,
        }],
        linkedinCooldown: null,
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['linkedin-short-snapshot']), null, null);
        assert(report.includes('Completion telemetry disagrees with the saved scoring snapshot')
          && report.includes('Maintenance Technician II')
          && report.includes('https://linkedin.example/jobs/short')
          && report.includes('do not treat this as a clean full-description finish'),
        'saved scoring input is authoritative and the report includes bounded title/URL evidence for the short row');
        assert(!report.includes('Residual: 0 below enrichment threshold'),
          'stale process telemetry cannot bless a saved sub-threshold description as complete');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: manually closed Glassdoor Solve retains final page identity',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'glassdoor-resolve-diagnostics',
        windowId: null,
        resolves: {
          glassdoor: {
            ts: Date.now(),
            extracted: 0,
            ageDropped: 0,
            historyDropped: 0,
            hiddenApplied: 0,
            kept: 0,
            diag: {
              closeReason: 'user-closed',
              extractOutcome: 'never-extracted',
              textLen: 0,
              finalHost: 'www.glassdoor.com',
              finalUrl: 'https://www.glassdoor.com/Job/jobs.htm?sc.keyword=Camera%20Operator',
              finalTitle: 'Jobs in United States | Glassdoor',
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['glassdoor-resolve-diagnostics']), null, null);
        assert(report.includes('closed: user-closed') && report.includes('extractor: never-extracted'),
          'job pipeline report retains the manual-close/extractor outcome');
        assert(report.includes('final URL: `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=Camera%20Operator`'),
          'job pipeline report identifies whether Solve reached the expected Glassdoor results URL');
        assert(report.includes('final title: "Jobs in United States | Glassdoor"'),
          'job pipeline report retains the final page title to distinguish a results page from login/challenge pages');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: resolved rows expose relevance and description recovery',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId,
        resolves: telemetry.resolves, search: telemetry.search,
      };
      Object.assign(telemetry, {
        nodeId: 'resolved-quality-diagnostics', windowId: null, search: null,
        resolves: {
          glassdoor: {
            ts: Date.now(), extracted: 6, relevanceDropped: 2,
            relevanceRejected: ['Loss Prevention Associate', 'Armed Driver/Messenger'],
            ageDropped: 0, historyDropped: 0, hiddenApplied: 0, kept: 4,
            enrichment: {
              attempted: 4, enriched: 3, empty: 1,
              emptySamples: [{ title: 'Security Officer', url: 'https://jobs/missing-jd' }],
            },
            diag: {
              closeReason: 'settled', extractOutcome: 'matched 6',
              postprocessOutcome: 'completed 6', textLen: 5000,
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['resolved-quality-diagnostics']), null, null);
        assert(report.includes('title-relevance-dropped 2')
          && report.includes('Loss Prevention Associate')
          && report.includes('Resolve detail enrichment: attempted 4 → full descriptions 3 → empty 1')
          && report.includes('https://jobs/missing-jd')
          && report.includes('detail postprocess: completed 6'),
        'resolved-source diagnostics retain admission and detail-enrichment provenance');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline attribution: board bucketing preserves source hub and direct re-score clears the old board',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        boardNodeId: telemetry.boardNodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
        scoring: telemetry.scoring,
        bucketing: telemetry.bucketing,
        history: telemetry.history,
      };
      Object.assign(telemetry, {
        nodeId: null,
        boardNodeId: null,
        windowId: null,
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1,
          ageDropped: 0, historyDropped: 0, kept: 1,
        },
        resolves: {},
        scoring: { ts: Date.now(), input: 1, selectedForScoring: 1, cappedForBudget: 0, scored: 1, placeholders: 0, unscored: 0, batches: 1, failedBatches: 0 },
        bucketing: { ts: Date.now(), input: 1, roleCount: 1, placed: 1, missing: 0, duplicated: 0, bandSummary: [], salaryRangeLabels: [], roleSummary: [], taxonomyAudit: [], error: null },
        history: null,
      });
      try {
        recordJobsSourceScope('source-jobhub-12345678', 42);
        recordJobsBoardScope('results-board-87654321', 42);

        assert(telemetry.nodeId === 'source-jobhub-12345678',
          'bucket scope must not overwrite the originating jobhub id');
        assert(telemetry.boardNodeId === 'results-board-87654321',
          'bucket scope records the Job Board separately');
        let report = buildJobsPipelineSnapshot(
          new Set(['source-jobhub-12345678', 'results-board-87654321']),
          42,
          null,
        );
        assert(report.includes('Source hub: `…12345678`'),
          'report attributes search/scoring to the originating Job Search hub');
        assert(report.includes('Job Board node: `…87654321`'),
          'report names the board that performed bucketing separately');
        assert(!report.includes('Source hub: `…87654321`'),
          'board node must never be rendered as the source hub');

        // A direct re-score is a new source-owned pipeline even when no fresh
        // search call precedes it. It must clear the old board attribution so a
        // previous Combine cannot be presented as part of the new score run.
        recordJobsSourceScope('direct-rescore-hub-abcdef12', 77);
        assert(telemetry.nodeId === 'direct-rescore-hub-abcdef12',
          'direct re-score replaces the source scope with its own jobhub');
        assert(telemetry.boardNodeId === null,
          'direct re-score clears stale board attribution');
        assert(telemetry.bucketing === null,
          'direct re-score clears the previous board-owned bucketing result');
        assert(telemetry.windowId === 77,
          'direct re-score scopes telemetry to its own sender window');
        report = buildJobsPipelineSnapshot(new Set(['direct-rescore-hub-abcdef12']), 77, null);
        assert(report.includes('Source hub: `…abcdef12`') && !report.includes('Job Board node:'),
          'direct re-score report shows only its source hub until a new board combines it');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: distinguishes raw role queries from Google-expanded keywords',
    run: () => {
      const issuedQueries = [];
      recordIssuedManualQuery(issuedQueries, { url: 'https://google.test/failed' }, false);
      recordIssuedManualQuery(issuedQueries, { url: 'https://google.test/sent' }, true);
      assert(issuedQueries.length === 1 && issuedQueries[0].url.endsWith('/sent'),
        'a failed location assignment never enters the sent-query telemetry');
      const executed = extractExecutedGoogleQueryStrings({
        google: {
          executedQueries: [{ url: 'https://www.google.com/search?q=Camera%20Operator%20Toronto%20jobs&udm=8' }],
        },
      });
      assert(executed.join('|') === 'Camera Operator Toronto jobs',
        'Google query telemetry derives only navigation-issued requests, not every planned task');
      const funnel = reconcileTitleRelevanceFunnel(21, 21, {
        google: { preCapRelevanceDropped: 1 },
        indeed: { preCapRelevanceDropped: 4 },
        linkedin: { preCapRelevanceDropped: 3 },
        glassdoor: { preCapRelevanceDropped: 5 },
        ziprecruiter: { preCapRelevanceDropped: 1 },
      });
      assert(funnel.raw === 35 && funnel.relevanceDropped === 14 && funnel.finalDropped === 0,
        'top-level funnel retains candidates rejected before browser caps (35 → 14 dropped → 21 admitted)');
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'google-query-diagnostics',
        windowId: null,
        resolves: {},
        search: {
          ts: Date.now(), queries: 2, raw: 3, relevanceDropped: 1, deduped: 2, ageDropped: 0, historyDropped: 0, kept: 2,
          bySource: { google: { count: 2, providerGathered: 3, relevanceDropped: 1 } },
          location: { rawInput: 'Toronto, ON', canonical: 'Toronto, ON', perSource: { google: 'keyword-only: canonical location appended to the query (no location param available)' } },
          queryStrings: ['Camera Operator', 'Film Editor Toronto'],
          googleQueryStrings: ['Camera Operator Toronto, ON jobs', 'Film Editor Toronto jobs'],
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['google-query-diagnostics']), null, null);
        assert(report.includes('Raw role queries (shared across sources):') && report.includes('`Camera Operator`'),
          'report labels shared role queries as raw input, not exact per-source request strings');
      assert(report.includes('Google keyword queries sent (canonical location appended when absent):')
          && report.includes('`Camera Operator Toronto, ON jobs`')
          && report.includes('`Film Editor Toronto jobs`'),
        'report renders the actual Google keyword queries, including the deduplicated canonical-location expansion');
        assert(report.includes('Per source (provider returned → retained for pipeline): google=3 → 2')
          && !report.includes('Per source (raw gathered)'),
        'per-source counts distinguish provider-returned candidates from the rows retained for this pipeline');
        assert(report.includes('Found (raw): 3 → title-relevance-dropped 1 → after dedup: 2 → age-dropped: 0 → history-dropped: 0 → **new: 2**')
          && !report.includes('→ deduped 2 → age-dropped 0 → already-seen/history 0'),
        'funnel labels make survivor counts and dropped counts unambiguous');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: rejected title samples state their nearest gate evidence',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'relevance-rejection-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 2, raw: 2, relevanceDropped: 2, deduped: 0,
          ageDropped: 0, historyDropped: 0, kept: 0,
          queryStrings: ['Corporate Security Officer', 'Property Management Assistant'],
          bySource: {
            usajobs: {
              count: 0, providerGathered: 2, relevanceDropped: 2,
              relevanceRejected: [
                'Public Safety Officer',
                'TRANSPORTATION ASSISTANT (PERSONAL PROPERTY)',
              ],
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['relevance-rejection-diagnostics']), null, null);
        assert(report.includes('"Public Safety Officer" [matched officer — 1/2 required]')
          && report.includes('"TRANSPORTATION ASSISTANT (PERSONAL PROPERTY)" [matched property+assistant, but not within one title phrase]'),
        'rejected-title samples show the closest query’s observed failed gate check');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: current-run snapshot correlation blocks stale field-quality evidence and shows empty current snapshots',
    run: () => {
      const dir = path.join(electronPkg.app.getPath('userData'), 'job-search');
      const filePath = path.join(dir, 'job-search-last-scrape.json');
      fs.mkdirSync(dir, { recursive: true });
      const priorFile = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : null;
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'snapshot-correlation-diagnostics',
        windowId: null,
        resolves: {},
        search: {
          ts: Date.now(), runId: 'current-empty-run', queries: 1,
          raw: 100, relevanceDropped: 100, deduped: 0, ageDropped: 0, historyDropped: 0, kept: 0,
          queryStrings: ['Systems Architect'],
          bySource: {
            weworkremotely: {
              count: 0, gathered: 0, providerGathered: 100, relevanceDropped: 100,
              relevanceRejected: ['Customer Support Specialist'],
            },
          },
        },
      });
      try {
        fs.writeFileSync(filePath, JSON.stringify({
          runId: 'prior-71-job-run', sourceHubId: 'snapshot-correlation-diagnostics',
          jobs: [{
            source: 'old-source', title: 'Old Snapshot Job', company: 'Old Co',
            salary: '$90,000/year', posted: '2026-08-01', url: 'https://example.com/old',
            snippet: 'Stale description that must never be presented as this run. '.repeat(20),
          }],
        }), 'utf8');
        const staleReport = buildJobsPipelineSnapshot(new Set(['snapshot-correlation-diagnostics']), null, null);
        assert(staleReport.includes('Per source (provider returned → retained for pipeline): weworkremotely=100 → 0')
          && !staleReport.includes('provider returned → retained for pipeline): (none)'),
        'whole-feed provider rows remain visible even when title admission retains none');
        assert(staleReport.includes('Saved scrape snapshot does not match the current search run')
          && staleReport.includes('Snippet, salary, and field-quality checks were skipped')
          && !staleReport.includes('Old Snapshot Job')
          && !staleReport.includes('`old-source`: min'),
        'a prior-run snapshot cannot leak stale snippets, salary coverage, or quality findings into the current funnel');

        fs.writeFileSync(filePath, JSON.stringify({
          runId: 'current-empty-run', sourceHubId: 'snapshot-correlation-diagnostics', jobs: [],
        }), 'utf8');
        const emptyReport = buildJobsPipelineSnapshot(new Set(['snapshot-correlation-diagnostics']), null, null);
        assert(emptyReport.includes('Saved scrape snapshot (current run): 0 jobs')
          && !emptyReport.includes('Saved scrape snapshot does not match the current search run'),
        'a matching terminal-zero snapshot is explicitly identified as empty rather than treated as stale');
      } finally {
        Object.assign(telemetry, saved);
        if (priorFile == null) fs.rmSync(filePath, { force: true });
        else fs.writeFileSync(filePath, priorFile, 'utf8');
      }
      return { providerRows: 100, retained: 0 };
    },
  },
{
    name: 'job pipeline report: intentional source skips are not reported as failed searches',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'intentional-skip-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 0, relevanceDropped: 0, deduped: 0,
          ageDropped: 0, historyDropped: 0, kept: 0,
          bySource: {
            dice: { count: 0, warning: { code: 'country-source-skipped', severity: 'info', evidence: 'excluded for Canada' } },
            usajobs: { count: 0, warning: { code: 'config-missing', severity: 'info', evidence: 'API key missing' } },
            glassdoor: { count: 0, warning: { code: 'location-resolution-failed', severity: 'info', evidence: 'autocomplete unavailable' } },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['intentional-skip-diagnostics']), null, null);
        assert(report.includes('intentionally not queried (scope/configuration):')
          && report.includes('dice (country-source-skipped)')
          && report.includes('usajobs (config-missing)'),
        'scope/configuration skips remain visible under a neutral label');
        const realMissLine = report.split('\n').find(line => line.includes('real miss to investigate')) || '';
        assert(realMissLine.includes('glassdoor (location-resolution-failed)')
          && !realMissLine.includes('country-source-skipped')
          && !realMissLine.includes('config-missing'),
        'only an unexpected runtime/safety skip is labeled a real miss');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
},
{
    name: 'job pipeline report: remote-feed relevance trace shows title evidence, not tags',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves };
      Object.assign(telemetry, {
        nodeId: 'remote-relevance-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1,
          remoteRelevance: {
            remoteok: [{
              url: 'https://remoteok.com/l/customer-support', title: 'Customer Support Specialist', company: 'Acme',
              matched: [{
                query: 'Customer Service Coordinator', matchedTerms: ['customer', 'service'], requiredMatches: 2,
                matchedConcepts: [
                  { queryTerm: 'customer', matched: 'customer', kind: 'exact' },
                  { queryTerm: 'service', matched: 'support', kind: 'synonym' },
                ],
              }],
              tags: ['customer-service', 'support'],
            }],
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['remote-relevance-diagnostics']), null, null);
        assert(report.includes('All-source role relevance audit')
          && report.includes('`Customer Service Coordinator` → [customer, service→support]/2 required')
          && report.includes('tags: customer-service, support'),
        'report records exact and synonym title evidence separately from RemoteOK tags');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'jobs history: read-time suppression captures the matched identity and prior row',
    run: () => {
      const current = {
        source: 'weworkremotely', title: 'Customer Support Systems & Analytics Architect', company: 'Mercury',
        location: 'Anywhere in the World', url: 'https://weworkremotely.com/remote-jobs/mercury-customer-support-systems-analytics-architect',
      };
      const prior = {
        seen_date: '2026-08-16', source: 'weworkremotely', title: 'Customer Support Systems &amp; Analytics Architect', company: 'Mercury',
        location: 'Anywhere in the World', url: current.url,
      };
      const result = dedupAgainstHistory([current], [prior]);
      const sample = result.samples[0];
      assert(result.removed === 1 && result.kept.length === 0 && result.samples.length === 1,
        'a history-suppressed job exposes one bounded provenance sample');
      assert(sample.keyKind === 'url' && sample.key === 'u:https://weworkremotely.com/remote-jobs/mercury-customer-support-systems-analytics-architect'
        && sample.dropped.title === current.title && sample.dropped.company === current.company
        && sample.dropped.location === current.location && sample.dropped.url === current.url
        && sample.history.seen_date === prior.seen_date && sample.history.title === prior.title && sample.history.url === prior.url,
      'history provenance identifies the dropped listing, normalized key, and matching durable row');
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves };
      Object.assign(telemetry, {
        nodeId: 'history-read-time-diagnostics', windowId: null, resolves: {},
        search: {
          ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0,
          historyDropped: result.removed, historyDropSamples: result.samples, kept: 0,
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['history-read-time-diagnostics']), null, null);
        assert(report.includes('History suppression evidence (1/1 bounded sample)')
          && report.includes('matched URL key')
          && report.includes('Customer Support Systems & Analytics Architect')
          && report.includes('seen_date=2026-08-16')
          && report.includes('Customer Support Systems &amp; Analytics Architect'),
        'FULL/JOBS report renders both the dropped row and matched history evidence');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { keyKind: sample.keyKind, samples: result.samples.length };
    },
  },
{
    name: 'job pipeline report: durable seen-history writes expose success and failure',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
        scoring: telemetry.scoring,
        history: telemetry.history,
      };
      Object.assign(telemetry, {
        nodeId: 'history-diagnostics',
        windowId: null,
        search: null,
        resolves: {},
        scoring: null,
        history: {
          preScoring: {
            ts: Date.now(), input: 5, written: 0, pruned: 0, skipped: 'deferred until results are visible', error: null,
          },
          boardDisplay: {
            ts: Date.now(), input: 6, written: 5, pruned: 2, skipped: null, error: null,
            skips: {
              url: 1, titleCompany: 0, noKey: 0, inBatch: 1, bySource: { google: 1 },
              collisionSamples: [{
                key: 'u:https://google.com/search?htidocid=repeat', sameListing: true,
                first: { source: 'google', title: 'Assistant Property Manager', company: 'Acme', location: 'Florida', url: 'https://google.com/search?htidocid=repeat&query=one' },
                duplicate: { source: 'google', title: 'Assistant Property Manager', company: 'Acme', location: 'Florida', url: 'https://google.com/search?htidocid=repeat&query=two' },
              }],
            },
          },
        },
      });
      try {
        let report = buildJobsPipelineSnapshot(new Set(['history-diagnostics']), null, null);
        assert(report.includes('Seen-history persistence') && report.includes('Pre-results write') && report.includes('deferred until results are visible'),
          'report makes the deliberate pre-results history deferral explicit');
        assert(report.includes('likely the same listing surfaced twice') && report.includes('htidocid=repeat')
          && report.includes('kept:') && report.includes('skipped:'),
        'report exposes collision identity and correctly distinguishes a duplicate query result from a bad history key');
        assert(report.includes('Board-displayed write') && report.includes('5 new history row(s), 2 expired row(s) pruned'),
          'report renders the authoritative board-display history outcome');

        telemetry.history.boardDisplay = { ts: Date.now(), input: 1, written: 0, pruned: 0, skipped: null, error: 'EACCES' };
        report = buildJobsPipelineSnapshot(new Set(['history-diagnostics']), null, null);
        assert(report.includes('history write failed: `EACCES`'),
          'report makes a durable-history failure explicit rather than silently claiming dedup is healthy');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'seen-history: gathered jobs are deferred until results are exposed',
    run: () => {
      const backend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const evidenceFilterStart = backend.indexOf('const descriptionEvidence = filterJobsByDescriptionEvidence(kept)');
      const returnStart = backend.indexOf('return { jobs: kept', evidenceFilterStart);
      const finalDisposition = backend.slice(evidenceFilterStart, returnStart);
      assert(evidenceFilterStart >= 0
        && finalDisposition.includes("skipped: canvasFilePath ? 'deferred until results are visible'")
        && !finalDisposition.includes('await appendJobsHistory('),
      'low-evidence and gathered-but-unshown jobs must not enter durable seen-history');

      const searchRenderer = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      const finishStart = searchRenderer.indexOf('const finishScoringAndSpawn');
      const finishEnd = searchRenderer.indexOf('const runScoringAndSpawn', finishStart);
      assert(!searchRenderer.slice(finishStart, finishEnd).includes('appendJobsHistory'),
        'scoring completion alone does not write seen-history');

      const boardRenderer = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      const combineStart = boardRenderer.indexOf('const handleCombine');
      const combineEnd = boardRenderer.indexOf('\n  return (', combineStart);
      const combinePath = boardRenderer.slice(combineStart, combineEnd);
      assert(combinePath.includes('addElementsGlobally')
        && combinePath.includes("historyStage: 'boardDisplay'")
        && combinePath.indexOf('addElementsGlobally') < combinePath.indexOf("historyStage: 'boardDisplay'"),
      'the Job Board writes seen-history only after it adds displayed cards');
      return { deferred: true };
    },
  },
{
    name: 'job pipeline report: taxonomy audit exposes salary placement and repairs',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      Object.assign(telemetry, {
        nodeId: 'taxonomy-audit-diagnostics', windowId: null, search: null, resolves: {}, scoring: null,
        bucketing: {
          ts: Date.now(), input: 1, roleCount: 1, placed: 1, missing: 0, duplicated: 0,
          bandSummary: [{ label: 'Low fit (0–79%)', count: 1 }], salaryRangeLabels: ['$80k–$120k/yr'],
          roleSummary: [{ name: 'Creative', count: 1, sampleTitles: ['Weekly role'] }],
          taxonomyRepairs: ['canonicalized salary label "$120k process/yr"'],
          taxonomyAudit: [{ index: 0, title: 'Weekly role', source: 'dice', rawSalary: '$1.6K - $2.0K/wk', annualSalary: 83200, likelihood: 'Low fit (0–79%)', salaryRange: '$80k–$120k/yr', role: 'Creative' }],
          taxonomyAuditOmitted: 0, model: 'gemini-2.5-flash',
          fallback: { preferredModel: 'gemini-3.7-flash', attempts: 1, reason: 'server', counts: { server: 1 } },
          error: null,
        },
      });
      try {
        let report = buildJobsPipelineSnapshot(new Set(['taxonomy-audit-diagnostics']), null, null);
        assert(report.includes('Taxonomy validation repaired: canonicalized salary label "$120k process/yr"')
          && report.includes('"$1.6K - $2.0K/wk" → $83,200/yr → **$80k–$120k/yr**')
          && report.includes('model: `gemini-2.5-flash` ↪ fell back (server: 1 earlier model(s) failed)'),
        'job pipeline report makes salary placement, repair evidence, and taxonomy fallback cause visible');

        telemetry.bucketing = {
          ts: Date.now(), input: 20, roleCount: 4, placed: 20, missing: 0, duplicated: 0,
          modelRoleCoverage: {
            placed: 0, structuralPlaced: 8, missing: 20, duplicated: 0, invalid: 0,
            malformedNames: 1, malformedNameIndices: [0, 1, 2, 3, 4, 5, 6, 7],
            unassigned: 12, unassignedIndices: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
          },
          repairedRoleCoverage: { roleCount: 4, placed: 20, missing: 0, duplicated: 0, invalid: 0 },
          bandSummary: [], salaryRangeLabels: [], roleSummary: [],
          taxonomyRepairs: ['recovered 8 job(s) into career-direction role(s)', 'recovered 12 unhinted job(s) into Other'],
          taxonomyAudit: [], taxonomyAuditOmitted: 0, error: null,
        };
        report = buildJobsPipelineSnapshot(new Set(['taxonomy-audit-diagnostics']), null, null);
        assert(report.includes('AI role-partition defect: 12 unassigned job(s), 8 job(s) under malformed role name(s).')
          && report.includes('Deterministic recovery placed 20/20 job(s) into renderable roles; career-direction/Other details appear in Taxonomy validation repaired below.')
          && !report.includes('NOT placed in any role by the AI'),
        'job pipeline report distinguishes the raw model role defect from complete deterministic recovery');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: scoring audit exposes cross-batch calibration drift',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      Object.assign(telemetry, {
        nodeId: 'scoring-audit-diagnostics', windowId: null, search: null, resolves: {}, bucketing: null,
        scoring: {
          ts: Date.now(), input: 2, selectedForScoring: 2, cappedForBudget: 0, scored: 2,
          placeholders: 0, batches: 2, failedBatches: 0, unscored: 0, models: ['gemini-test'],
          fallbacks: [{
            servedModel: 'gemini-2.5-flash', preferredModel: 'gemini-3.7-flash',
            attempts: 1, reason: 'server', counts: { server: 1 },
          }],
          audit: {
            rows: [
              { batch: 1, title: 'Bank Equipment Technician', company: 'Cennox', location: 'Madison, AL', source: 'dice', url: 'https://jobs/1', score: 55, direction: 'Field Services', reason: 'Transferable background.', descriptionFingerprint: 'deadbeef' },
              { batch: 2, title: 'Bank Equipment Technician', company: 'Cennox', location: 'Phoenix, AZ', source: 'dice', url: 'https://jobs/2', score: 35, direction: 'Field Operations', reason: 'Large fit gaps.', descriptionFingerprint: 'deadbeef' },
            ],
            omitted: 0,
            anomalies: [{ delta: 20, first: { index: 0, batch: 1, score: 55 }, second: { index: 1, batch: 2, score: 35 }, title: 'Bank Equipment Technician', company: 'Cennox', descriptionFingerprint: 'deadbeef' }],
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['scoring-audit-diagnostics']), null, null);
        assert(report.includes('20-point cross-batch drift') && report.includes('Madison, AL')
          && report.includes('Phoenix, AZ') && report.includes('https://jobs/1')
          && report.includes('Transferable background.'),
        'FULL/JOBS scoring section contains enough bounded evidence to diagnose score drift');
        assert(report.includes('Scoring evidence (2/2 bounded row(s))')
          && report.includes('score 55') && report.includes('Field Services')
          && report.includes('input ') && report.includes('reason: "Transferable background."'),
        'FULL/JOBS/SCORE reports preserve ordinary per-job score/direction/reason/input evidence, not only anomaly pairs');
        assert(report.includes('Model fallback routes')
          && report.includes('preferred `gemini-3.7-flash`')
          && report.includes('served `gemini-2.5-flash`')
          && report.includes('server: 1 earlier model(s) failed'),
        'FULL/JOBS scoring section preserves fallback cause after the main-process log rolls over');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: real model scores do not hide incomplete descriptions',
    run: () => {
      const inputs = [
        ...Array.from({ length: 6 }, (_, index) => ({
          source: 'glassdoor', title: `Security Officer ${index + 1}`,
          url: `https://jobs/glassdoor-empty-${index + 1}`, snippet: '',
        })),
        { source: 'indeed', title: 'Security Officer — Indeed', url: 'https://jobs/indeed-empty', snippet: '' },
        { source: 'linkedin', title: 'Security Guard', url: 'https://jobs/short', snippet: 'Short listing excerpt.' },
        { source: 'indeed', title: 'Full JD', url: 'https://jobs/full', snippet: 'Complete description. '.repeat(40) },
      ];
      const quality = summarizeScoringInputQuality(inputs);
      assert(quality.empty === 7 && quality.short === 1
        && quality.bySource.glassdoor.empty === 6
        && quality.bySource.indeed.empty === 1
        && quality.bySource.linkedin.short === 1,
      'scoring input quality classifies empty and short evidence per source');

      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search,
        resolves: telemetry.resolves, scoring: telemetry.scoring, bucketing: telemetry.bucketing,
      };
      Object.assign(telemetry, {
        nodeId: 'scoring-input-quality', windowId: null, search: null, resolves: {}, bucketing: null,
        scoring: {
          ts: Date.now(), input: inputs.length, selectedForScoring: inputs.length, cappedForBudget: 0, scored: inputs.length,
          placeholders: 0, batches: 1, failedBatches: 0, unscored: 0,
          models: ['gemini-test'], inputQuality: quality,
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['scoring-input-quality']), null, null);
        assert(report.includes('scored but low-evidence')
          && report.includes('Low-evidence scoring inputs')
          && report.includes('7 empty description(s), 1 short')
          && report.includes('glassdoor=6 empty/0 short')
          && report.includes('indeed=1 empty/0 short')
          && report.includes('linkedin=0 empty/1 short')
          && report.includes('Security Officer 1')
          && report.includes('https://jobs/glassdoor-empty-1')
          && report.includes('https://jobs/indeed-empty')
          && report.includes('https://jobs/short'),
        'report separates successful model responses from full-description evidence with bounded per-source samples');
        assert(!report.includes('all received real model scores')
          && !report.includes('all genuinely analyzed')
          && !report.includes('all analyzed with full descriptions'),
        'incomplete descriptions can never receive the green full-evidence verdict');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
  },
},
{
    name: 'description-evidence filter: brief or empty listings never reach scoring/history',
    run: () => {
      const filtered = filterJobsByDescriptionEvidence([
        {
          source: 'ziprecruiter', title: 'Senior Manager, Architect',
          url: 'https://www.ziprecruiter.com/jobs/example-1',
          snippet: 'A concise but genuine description recovered from the detail page.',
          descriptionCapture: 'json-ld-job-description',
        },
        {
          source: 'ziprecruiter', title: 'Applications Architect',
          url: 'https://www.ziprecruiter.com/jobs/example-2',
          snippet: 'Another terse detail-page job description.',
          descriptionCapture: 'detail-page-description',
        },
        {
          source: 'ziprecruiter', title: 'No description yet',
          url: 'https://www.ziprecruiter.com/jobs/example-3',
          snippet: '',
        },
        {
          source: 'ziprecruiter', title: 'Complete listing',
          url: 'https://www.ziprecruiter.com/jobs/example-4',
          snippet: 'Complete employer-supplied job description. '.repeat(20),
        },
      ]);
      assert(filtered.jobs.length === 1
        && filtered.jobs[0]?.title === 'Complete listing'
        && filtered.dropped.length === 3
        && filtered.quality.empty === 1
        && filtered.quality.short === 2,
      'brief and empty listings are omitted before scoring/history while complete listings remain eligible');
      return { ok: true };
    },
  },
{
    // End-to-end regression for the salary field-quality rewrite: renders the
    // real markdown through buildJobsPipelineSnapshot (backed by a real saved
    // snapshot file on disk, same as the app writes) rather than re-testing the
    // classifier in isolation, so the exact rendered lines are pinned down.
    //
    // (1) False alarm this closes: a bare thousands-scale numeric range like
    //     Dice's "38000 - 40000" used to fail looksLikeMoney (no $/k/comma) and
    //     got reported "salary garbage" even though the real annualizer parses
    //     it fine as $38,000/yr.
    // (2) Missed defect this closes: a source whose present salaries all "look
    //     like money" (pass looksLikeMoney) could still have some annualize to
    //     0 and get reported "all monetary ✅" while real pay data was silently
    //     dropped into the "Unspecified" bucket (the real USAJobs run: 10/10
    //     present, 4 of them "/ PH" rates the annualizer couldn't read).
    //
    // Fixture salaries are NOT the two exact strings another agent is making
    // parseable at the extractor level ('$22.31 - $22.31 / PH', '$20 - $24') —
    // different digits, same shape, and their unparseability is asserted
    // directly via parseSalaryToNumeric below so this test stays honest either
    // way even if that extractor-level fix broadens further.
    name: 'job pipeline report: salary field-quality reports the annualizer-measured unparseable count, not a lookalike-regex verdict',
    run: () => {
      const lostCadenceSamples = ['$19.75 - $19.75 / PH', '$24.10 - $24.10 / PH', '$31.40 - $31.40 / PH', '$27.85 - $27.85 / PH'];
      for (const s of lostCadenceSamples) {
        assert(parseSalaryToNumeric(s) === 0, `precondition: "${s}" must be unparseable for this regression fixture to be meaningful`);
        assert(looksLikeMoney(s), `precondition: "${s}" must still look monetary (lands in the cadence-lost bucket, not prose)`);
      }
      assert(parseSalaryToNumeric('38000 - 40000') > 0,
        'precondition: the Dice false-alarm value must still parse fine for the "must not be flagged" assertion below to be meaningful');

      const dir = path.join(electronPkg.app.getPath('userData'), 'job-search');
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, 'job-search-last-scrape.json');
      const longSnippet = 'Full job description text goes here. '.repeat(20);
      const parseableSalaries = ['$60,000 - $75,000', '$82,000 - $95,000', '$71,500 - $88,000', '$64,000 - $79,000', '$90,000 - $110,000', '$58,000 - $66,000'];
      const usajobsJobs = [...lostCadenceSamples, ...parseableSalaries].map((salary, i) => ({
        title: `Analyst ${i}`, company: 'Agency', location: 'Remote', source: 'usajobs-regression-test',
        salary, posted: '2026-08-01', url: `https://example.com/usajobs/${i}`, snippet: longSnippet,
      }));
      const diceJobs = [{
        title: 'Engineer', company: 'Acme', location: 'Remote', source: 'dice-regression-test',
        salary: '38000 - 40000', posted: '2026-08-01', url: 'https://example.com/dice/1', snippet: longSnippet,
      }];
      const indeedJobs = [{
        title: 'Locker Room Attendant', company: 'Acme', location: 'Austin, TX', source: 'indeed-regression-test',
        salary: '$18.75 - $19.70 a year', posted: '2026-08-01', url: 'https://example.com/indeed/1', snippet: longSnippet,
      }];
      fs.writeFileSync(filePath, JSON.stringify({ jobs: [...usajobsJobs, ...diceJobs, ...indeedJobs] }), 'utf8');

      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search, resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'salary-quality-regression-test', windowId: null, resolves: {},
        search: { ts: Date.now(), queries: 1, raw: 11, deduped: 11, ageDropped: 0, historyDropped: 0, kept: 11 },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['salary-quality-regression-test']), null, null);

        // (2) A source that's 100% "looks like money" must never be summarized
        // "all monetary" / "all annualized ✅" when 4/10 of its values actually
        // annualize to 0 — this is the exact USAJobs regression from the bug
        // report. The coverage note is mutually exclusive (if/else), so pinning
        // down the exact "N unparseable ⚠" string for this source (not present
        // anywhere else — the string embeds the source name) already proves the
        // healthy strings were never chosen for it.
        assert(report.includes('`usajobs-regression-test`: 10/10 present (100%) — 4 unparseable ⚠'),
          'salary coverage line reports the annualizer-measured unparseable count instead of "all monetary ✅"');
        assert(report.includes('salary unparseable: 4/10 (40%)'),
          'field-quality warning reports the annualizer-measured unparseable count/pct, not a looksLikeMoney count');
        assert(report.includes('4 money-shaped but cadence missing — extractor could not recover a unit, so these remain Unspecified rather than guessing'),
          'field-quality warning reports the missing unit without claiming a recoverable source cadence');
        assert(lostCadenceSamples.some(s => report.includes(`"${s}"`)),
          'field-quality warning includes a real offending sample value, as the old garbage warning did');
        assert(report.includes('1 implausibly tiny explicit annual amount')
          && report.includes('"$18.75 - $19.70 a year"'),
        'field-quality warning identifies corrupt tiny annual pay separately from a missing cadence');

        // (1) A bare numeric range the real annualizer parses fine must never be
        // flagged, and its source must be reported healthy.
        assert(!report.includes('"38000 - 40000"'),
          'a salary the real annualizer parses successfully must never appear as an offending sample');
        assert(report.includes('`dice-regression-test`: 1/1 present (100%) — all annualized ✅'),
          'a source whose only salary the annualizer parses fine must be reported healthy, not flagged as garbage (the old looksLikeMoney-based check misflagged this exact shape)');
      } finally {
        Object.assign(telemetry, saved);
        fs.rmSync(filePath, { force: true });
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: names card-owned collection limits and their widening action',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = {
        nodeId: telemetry.nodeId,
        windowId: telemetry.windowId,
        search: telemetry.search,
        resolves: telemetry.resolves,
      };
      Object.assign(telemetry, {
        nodeId: 'collection-limit-diagnostics',
        windowId: null,
        resolves: {},
        search: {
          ts: Date.now(), queries: 2, raw: 28, deduped: 28, ageDropped: 0, historyDropped: 0, kept: 20,
          collectionLimits: { jobsPerPlatform: 10, pagesPerPlatform: 2 },
          bySource: {
            indeed: {
              count: 10, unique: 10, gathered: 18,
              capOverflow: 8,
              cap: { type: 'per-platform', limit: 10 },
            },
            glassdoor: {
              count: 0, unique: 0, gathered: 5, providerGathered: 5,
              relevanceDropped: 5, finalRelevanceDropped: 5,
              relevanceRejected: ['Junior Project Buyer'],
            },
            ziprecruiter: {
              count: 10, unique: 10, pagesWalked: 2, stopReason: 'per-source-cap',
              cap: { type: 'per-platform', limit: 10 },
            },
          },
        },
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['collection-limit-diagnostics']), null, null);
        assert(report.includes('Collection limits: 10 job(s)/platform; 2 browser page(s)/search'),
          'the report must retain the exact card-owned collection limits used by the run');
        telemetry.search.collectionLimits = { jobsPerPlatform: null, pagesPerPlatform: null };
        const unboundedReport = buildJobsPipelineSnapshot(new Set(['collection-limit-diagnostics']), null, null);
        assert(unboundedReport.includes(`Collection limits: unlimited jobs/platform; all browser pages/search (safety backstop ${JOB_COLLECTION_PAGE_CEILING})`),
          'the report identifies an all-pages run and its shared finite safety backstop');
        assert(unboundedReport.includes('dedup / age / history drops are by-design')
          && !unboundedReport.includes('title-relevance / dedup / age / history drops are by-design'),
        'a current provider-trust run does not imply title drops when none occurred');
        assert(report.includes('per-platform job limit (10)') && report.includes('increase or clear the Jobs per platform setting'),
          'API and browser truncation must point back to the editable card setting');
        assert(report.includes('stopped: per-source-cap'),
          'browser source-limit stops must remain visible rather than looking completed');
        assert(!report.includes('`glassdoor`: collected 0 of 5')
          && report.includes('0 retained after the title relevance gate: glassdoor (5 gathered, then title-filtered)')
          && !report.includes('genuinely empty / off-category): glassdoor'),
        'final title rejections must not be mislabeled as cap truncation or a genuinely empty source');
        assert(!report.includes('disable fast mode') && !report.includes('JOB_RESULT_CAP'),
          'collection-limit diagnostics must not send users toward removed code-only cap controls');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { api: 10, browser: 10 };
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

      // sourceJobKey: native id wins, then url, then the location-aware fallback.
      // Both Indeed extractors share it so the within-source gather can't
      // over-collapse two distinct-location reqs that share a title + company.
      assert(sourceJobKey({ jobkey: 'JK1', url: 'u', title: 't', company: 'co' }) === 'JK1',
        'sourceJobKey: native jobkey wins over url/composed');
      assert(sourceJobKey({ url: 'https://x/job', title: 't', company: 'co' }) === 'https://x/job',
        'sourceJobKey: url wins when no native id');
      const googleFirstQuery = {
        source: 'google', title: 'Assistant Property Manager, Multifamily', company: 'Cushman & Wakefield', location: 'Florida, United States',
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Leasing+Assistant+United+States+jobs&htidocid=u59K_-BxO-_w8CI0AAAAAA%3D%3D&shmd=first#htiq=Leasing+Assistant+United+States+jobs',
      };
      const googleSecondQuery = {
        ...googleFirstQuery,
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Property+Management+Assistant+United+States+jobs&htidocid=u59K_-BxO-_w8CI0AAAAAA%3D%3D&shmd=second#htiq=Property+Management+Assistant+United+States+jobs',
      };
      const differentGoogleListing = {
        ...googleFirstQuery,
        url: 'https://www.google.com/search?ibp=htl;jobs&q=Leasing+Assistant+United+States+jobs&htidocid=DifferentGoogleListingAAAAAA%3D%3D',
      };
      assert(sourceJobKey(googleFirstQuery) === sourceJobKey(googleSecondQuery),
        'sourceJobKey: the same Google htidocid dedupes across distinct query URLs');
      assert(sourceJobKey(googleFirstQuery) !== sourceJobKey(differentGoogleListing),
        'sourceJobKey: distinct Google htidocid values remain separate');
      assert(dedupeJobsByKey([googleFirstQuery, googleSecondQuery, differentGoogleListing], sourceJobKey).length === 2,
        'sourceJobKey: duplicate Google cards from two queries collapse before scoring/history');
      const sf = { title: 'SWE', company: 'Google', location: 'San Francisco, CA' };
      const nyc = { title: 'SWE', company: 'Google', location: 'New York, NY' };
      assert(sourceJobKey(sf) !== sourceJobKey(nyc),
        'sourceJobKey: idless same-title/company reqs in different cities stay distinct (no over-collapse)');
      assert(dedupeJobsByKey([sf, nyc], sourceJobKey).length === 2,
        'sourceJobKey: nationwide distinct-location reqs both survive within-source dedup');
      return { deduped: deduped.length, fresh: fresh.length };
    },
  },
{
    name: 'dedupJobsAcrossSources: location-aware cross-source dedup',
    run: () => {
      // Same posting scraped from two boards: different URL/source, one board
      // omits location — must still collapse (this is the whole point of
      // cross-source dedup: two boards showing the same job under two URLs).
      const linkedin = { title: 'SWE', company: 'Google', source: 'LinkedIn', url: 'https://linkedin.com/a' };
      const indeed = { title: 'swe', company: 'google', source: 'Indeed', url: 'https://indeed.com/b', location: 'New York, NY' };
      const crossSource = dedupJobsAcrossSources([linkedin, indeed]);
      assert(crossSource.length === 1, `dedupJobsAcrossSources: same posting missing location on one side should collapse, got ${crossSource.length}`);

      // Nationwide search: same title+company, both sides HAVE a location, and
      // the locations genuinely differ — must stay distinct (the bug being
      // fixed: title+company alone silently dropped the second city's req).
      const nycReq = { title: 'Software Engineer', company: 'Google', location: 'New York, NY' };
      const sfReq = { title: 'Software Engineer', company: 'Google', location: 'San Francisco, CA' };
      const distinctCities = dedupJobsAcrossSources([nycReq, sfReq]);
      assert(distinctCities.length === 2, `dedupJobsAcrossSources: distinct-location same-title/company reqs must both survive, got ${distinctCities.length}`);

      // Same title+company+location (from two boards, identical location text) → collapses.
      const nycAgain = { title: 'software engineer', company: 'google', location: 'new york, ny' };
      const sameCity = dedupJobsAcrossSources([nycReq, nycAgain, sfReq]);
      assert(sameCity.length === 2, `dedupJobsAcrossSources: matching-location duplicate should collapse, distinct city should survive, got ${sameCity.length}`);

      // Regression: a group's FIRST entry landing with an unknown location
      // used to match (and swallow) EVERY later job via the "either side
      // unknown" leniency, regardless of the later jobs' own distinct real
      // locations — collapsing NYC and SF onto the one unresolved entry
      // instead of onto each other. The unresolved entry must only absorb
      // the FIRST location-bearing match, then behave like a normal
      // exact-match city for anything after that.
      const noLocationFirst = { title: 'Software Engineer', company: 'Google', source: 'USAJobs' };
      const orderDependent = dedupJobsAcrossSources([noLocationFirst, nycReq, sfReq]);
      assert(orderDependent.length === 2,
        `dedupJobsAcrossSources: an unknown-location entry seen FIRST must not swallow two distinct later cities, got ${orderDependent.length}`);

      // Same source + same title/company/location is NOT enough evidence to
      // collapse two concurrent requisitions. Native IDs are authoritative.
      const sameSourceA = { title: 'Front Desk Agent', company: 'Acme Hotels', location: 'Toronto, ON', source: 'indeed', jobkey: 'a', url: 'https://indeed.test/a' };
      const sameSourceB = { ...sameSourceA, jobkey: 'b', url: 'https://indeed.test/b' };
      assert(dedupJobsAcrossSources([sameSourceA, sameSourceB]).length === 2,
        'dedupJobsAcrossSources: same-source distinct listing IDs survive even with identical title/company/location');
      assert(dedupJobsAcrossSources([sameSourceA, { ...sameSourceA }]).length === 1,
        'dedupJobsAcrossSources: exact same-source listing ID still collapses query/page overlap');

      // Real cross-board shape: one source decorates the company/location while
      // both carry the same full JD. The substantial content fingerprint is a
      // safe secondary identity; city remains part of the guard so templated
      // multi-location requisitions do not collapse.
      const fullJdA = 'Requisition 2026-107. ' + 'Customer service communications responsibilities and requirements. '.repeat(12);
      const fullJdB = 'Requisition 2026-107! ' + 'Customer service communications responsibilities and requirements.'.repeat(12);
      const glassdoorCopy = {
        title: 'Customer Service Coordinator, Communications',
        company: 'Town of Saugeen Shores, Ontario', location: 'Port Elgin',
        source: 'glassdoor', snippet: fullJdA,
      };
      const indeedCopy = {
        title: 'Customer Service Coordinator, Communications',
        company: 'Town of Saugeen Shores', location: 'Port Elgin, ON',
        source: 'indeed', snippet: fullJdB,
      };
      const otherCityCopy = { ...indeedCopy, location: 'Southampton, ON', source: 'linkedin' };
      assert(dedupJobsAcrossSources([glassdoorCopy, indeedCopy]).length === 1,
        'cross-source copies with the same title/city/full JD collapse despite company and location decoration');
      assert(dedupJobsAcrossSources([glassdoorCopy, otherCityCopy]).length === 2,
        'same title/full JD in a different city remains a distinct requisition');

      return { crossSource: crossSource.length, distinctCities: distinctCities.length, sameCity: sameCity.length, orderDependent: orderDependent.length };
    },
  },
{
    name: 'uniqueJobsAcrossSources: location-aware "new vs existing" merge (renderer resolve/append paths)',
    run: () => {
      const nycExisting = { title: 'Software Engineer', company: 'Google', location: 'New York, NY', source: 'Indeed' };
      const sfFresh = { title: 'Software Engineer', company: 'Google', location: 'San Francisco, CA', source: 'LinkedIn' };
      const dup = { title: 'software engineer', company: 'google', location: 'new york, ny', source: 'USAJobs' };

      // A genuinely distinct-city fresh job must be added, not swallowed.
      const added1 = uniqueJobsAcrossSources([nycExisting], [sfFresh]);
      assert(added1.length === 1 && added1[0] === sfFresh, 'uniqueJobsAcrossSources: distinct city is added');

      // A same-city duplicate must NOT be added again.
      const added2 = uniqueJobsAcrossSources([nycExisting], [dup]);
      assert(added2.length === 0, 'uniqueJobsAcrossSources: matching-location duplicate is not re-added');

      // The exact bug this replaces uniqueJobsNotIn(..., jobTitleCompanyKey)
      // for: with the old location-blind key, BOTH nycExisting and sfFresh
      // share the null-location existing entry's title+company, so NEITHER
      // would ever be added — a genuinely new posting in a second city could
      // never surface. The location-aware version lets the ambiguous
      // existing entry absorb (at most) the FIRST candidate it plausibly
      // matches, so the clearly-distinct second city still gets through.
      const noLocationExisting = { title: 'Software Engineer', company: 'Google', source: 'USAJobs' };
      const added3 = uniqueJobsAcrossSources([noLocationExisting], [nycExisting, sfFresh]);
      assert(added3.length === 1 && added3[0] === sfFresh,
        `uniqueJobsAcrossSources: an unknown-location existing entry absorbs one candidate but still lets a second, distinct city through, got ${added3.length}`);

      return { added1: added1.length, added2: added2.length, added3: added3.length };
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
    name: 'Job source warning policy: partial ZipRecruiter warning does not wait for Skip',
    run: () => {
      const zipPartial = { sourceId: 'ziprecruiter', code: 'description-detail-miss', severity: 'warn' };
      const zipBlocked = { sourceId: 'ziprecruiter', code: 'cloudflare-hard-block', severity: 'block' };
      const linkedinLimited = { sourceId: 'linkedin', code: 'linkedin-rate-limited', severity: 'throttle' };
      const ordinaryThrottle = { sourceId: 'indeed', code: 'temporary-throttle', severity: 'throttle' };

      assert(!isJobSourceWarningGating(zipPartial), 'a partial ZipRecruiter description warning must not delay scoring');
      assert(jobSourceWarningAction(zipPartial) === 'dismiss', 'a non-gating warning action is Dismiss, not Skip');
      assert(isJobSourceWarningGating(zipBlocked), 'a hard ZipRecruiter block must pause for Resolve/Skip');
      assert(jobSourceWarningAction(zipBlocked) === 'skip', 'a gating source action remains Skip');
      assert(isJobSourceWarningGating(linkedinLimited), 'LinkedIn guest rate-limit remains the explicit throttle exception');
      assert(!isJobSourceWarningGating(ordinaryThrottle), 'ordinary source throttles must not delay scoring');

      const sourceCard = fs.readFileSync(path.resolve('src/nodes/JobSourceCardNode.jsx'), 'utf8');
      const hub = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      assert(sourceCard.includes("document.addEventListener('job-source-warning-sync'")
        && sourceCard.includes('(!hasWarn || warningBlocksScoring)')
        && sourceCard.includes('replaceMatchingItems'),
      'a derived source warning keeps an actionable exact-retry control on its source card');
      const jobsBackend = fs.readFileSync(path.resolve('electron/ipc/jobs.js'), 'utf8');
      const scraper = fs.readFileSync(path.resolve('electron/ipc/browser/manualScraper.js'), 'utf8');
      assert(scraper.includes("phase: 'detail-external-page-text'")
        && scraper.includes('never clicks Apply, fills fields, logs in, or')
        && scraper.includes("document.body?.innerText || ''")
        && jobsBackend.includes('filterJobsByDescriptionEvidence')
        && jobsBackend.includes('not scored or marked seen'),
      'ZipRecruiter external listing URLs are read once for text without any application-form automation');
      assert(hub.includes("hubState === 'sources-ready' || hasGatingWarning")
        && hub.includes("new CustomEvent('job-source-warning-sync'"),
      'a review-gated source card cancels clean-card auto-dismiss and receives the derived warning');

      const finalWarnings = filterHandledJobSourceWarnings(
        [zipBlocked, ordinaryThrottle],
        new Set(['ziprecruiter']),
      );
      assert(finalWarnings.length === 1 && finalWarnings[0].sourceId === 'indeed',
        'a source skipped during an in-flight search must not be re-blocked by the backend final warning list');

      return { zipAction: jobSourceWarningAction(zipPartial), remaining: finalWarnings.map(w => w.sourceId) };
    },
  },
{
    name: 'Job card filters',
    run: () => {
      const job = { source: 'indeed', matchScore: 72 };
      assert(isJobCardVisible(job, { sourceFilter: 'indeed', scoreThreshold: 70 }), 'Job card filters: matching source and score should be visible');
      assert(!isJobCardVisible(job, { sourceFilter: 'linkedin' }), 'Job card filters: non-matching source should be hidden');
      assert(!isJobCardVisible(job, { scoreThreshold: 80 }), 'Job card filters: score below threshold should be hidden');
      assert(isJobCardVisible({}, {}), 'Job card filters: empty filter shows everything');
      assert(!isJobCardVisible({}, { scoreThreshold: 1 }), 'Job card filters: missing score counts as 0');
      return { ok: true };
    },
  },
{
    name: 'anthropicRequest: buildCachedUserContent splits the cached prefix into an ephemeral block',
    run: () => {
      const arr = [{ type: 'image' }];
      assert(buildCachedUserContent('hi', null) === 'hi', 'no prefix → string passthrough');
      assert(buildCachedUserContent(arr, null) === arr, 'no prefix → array passthrough (same ref)');
      const s = buildCachedUserContent('JOBS', 'PROFILE');
      assert(Array.isArray(s) && s.length === 2, 'string + prefix → 2 blocks');
      assert(s[0].type === 'text' && s[0].text === 'PROFILE' && s[0].cache_control?.type === 'ephemeral', 'prefix block is ephemeral-cached');
      assert(s[1].type === 'text' && s[1].text === 'JOBS', 'second block is the dynamic content');
      const a = buildCachedUserContent([{ type: 'image' }, { type: 'text', text: 'p' }], 'PFX');
      assert(a.length === 3 && a[0].cache_control?.type === 'ephemeral' && a[1].type === 'image', 'array + prefix → prefix prepended to media blocks');
      return { ok: true };
    },
  },
{
    name: 'anthropicRequest: buildAnthropicMessageParams builds the identical live/batch request shape',
    run: () => {
      const base = { model: 'claude-sonnet-4-6', maxTokens: 8000, cachedPrefix: 'PROFILE' };
      const schema = { type: 'object', properties: {} };
      // responseSchema → forced submit_response tool, no JSON prefill.
      const p1 = buildAnthropicMessageParams('JOBS', { ...base, responseSchema: schema });
      assert(p1.model === 'claude-sonnet-4-6' && p1.max_tokens === 8000, 'carries model + max_tokens');
      assert(p1.thinking?.type === 'adaptive', 'modern Claude requests explicitly enable adaptive thinking');
      assert(p1.output_config?.effort === 'medium', 'modern Claude requests explicitly use medium effort');
      assert(p1.tools?.[0]?.name === 'submit_response' && p1.tools[0].input_schema === schema, 'responseSchema → submit_response tool');
      assert(p1.tool_choice?.type === 'tool' && p1.tool_choice?.name === 'submit_response', 'responseSchema → forced tool_choice');
      assert(p1.messages.length === 1, 'tool-use mode adds no assistant prefill');
      assert(p1.messages[0].content[0].cache_control?.type === 'ephemeral', 'cached prefix carried into params');
      const count = buildAnthropicTokenCountParams('JOBS', { ...base, responseSchema: schema });
      const { max_tokens: _maxTokens, ...liveWithoutOutputCap } = p1;
      assert(JSON.stringify(count) === JSON.stringify(liveWithoutOutputCap),
        'token-count params are derived from the live request shape and differ only by max_tokens (including forced tool_choice)');
      // expectJson (no schema) → NO assistant prefill. Current models 400 on
      // an assistant-role prefill turn ("This model does not support
      // assistant message prefill" — verified live against claude-opus-5 /
      // claude-sonnet-5 / claude-fable-5), so the old `{ role: 'assistant',
      // content: '{' }` branch was removed; expectJson is now a no-op on the
      // request shape (parseAiJson handles the resulting prose/fence slop
      // instead). This must resolve IDENTICALLY to the plain (no-schema,
      // no-expectJson) case below.
      const p2 = buildAnthropicMessageParams('X', { model: 'm', maxTokens: 100, expectJson: true });
      assert(!p2.tools && !p2.tool_choice && p2.messages.length === 1 && p2.messages[0].role === 'user',
        'expectJson no longer adds an assistant prefill turn — single user message, no envelope');
      // plain → single user turn, no envelope.
      const p3 = buildAnthropicMessageParams('X', { model: 'm', maxTokens: 100 });
      assert(!p3.tools && !p3.tool_choice && p3.messages.length === 1, 'plain → single user message, no envelope');
      const haiku = getClaudeDefaultReasoningConfig(MODEL_FLOOR.HAIKU);
      assert(haiku.thinking?.type === 'enabled' && haiku.thinking.budget_tokens === CLAUDE_MEDIUM_MANUAL_THINKING_BUDGET,
        'Haiku receives explicit manual thinking at the shared medium-equivalent budget');
      assert(!haiku.outputConfig, 'Haiku omits unsupported output_config.effort');
      assert(claudeReasoningMaxTokens(MODEL_FLOOR.HAIKU, 512) === CLAUDE_MEDIUM_MANUAL_THINKING_BUDGET + 1024,
        'manual-thinking models reserve room for both the medium reasoning budget and a visible answer');
      return { ok: true };
    },
  },
{
    name: 'compSourceScope: normalizeCompWarnings preserves every exact blocked source',
    run: () => {
      assert(ALL_COMP_SOURCE_IDS.includes('swappa-sold') && ALL_COMP_SOURCE_IDS.includes('swappa'),
        'Swappa sold and active must have separate source cards/retry actions');
      const cards = ['ebay-sold', 'ebay-active', 'swappa-sold', 'swappa', 'reverb'];
      const out1 = normalizeCompWarnings([{ sourceId: 'swappa-sold', code: 'zero-extracted', severity: 'block' }], cards);
      assert(out1.length === 1 && out1[0].sourceId === 'swappa-sold', `swappa-sold stays exact (got ${out1[0]?.sourceId})`);
      assert(out1[0].code === 'zero-extracted' && out1[0].severity === 'block', 'warning fields preserved');
      // A real card warning is kept untouched (same ref).
      const w = { sourceId: 'ebay-sold', code: 'x' };
      const out2 = normalizeCompWarnings([w], cards);
      assert(out2.length === 1 && out2[0] === w, 'real card warning kept as-is (same ref)');
      // Sold and active variants are separate sources and both remain blocked.
      const out4 = normalizeCompWarnings([{ sourceId: 'swappa', code: 'a' }, { sourceId: 'swappa-sold', code: 'b' }], cards);
      assert(out4.length === 2, 'distinct sold/active source warnings must never collapse');
      // Unexpected sources remain blocked rather than silently pricing without them.
      const orphan = normalizeCompWarnings([{ sourceId: 'unexpected-source', code: 'x' }], cards);
      assert(orphan.length === 1 && orphan[0].sourceId === 'unexpected-source', 'unexpected source warning is preserved');
      // Multiple item-query warnings for one exact source share one source retry.
      assert(normalizeCompWarnings([{ sourceId: 'ebay-sold', code: 'a' }, { sourceId: 'ebay-sold', code: 'b' }], cards).length === 1,
        'duplicate warnings for one exact source collapse to one retry action');
      return { ok: true };
    },
  },
{
    name: 'nodePresence: resolveNodePresence prefers stamped filterStats over a dropped nodes section',
    run: () => {
      // No filter, nodes intact → scan nodes.
      const scanned = resolveNodePresence({ nodes: [{ type: 'sellhub' }, { type: 'text' }] });
      assert(scanned.hasSellNodes === true && scanned.hasJobNodes === false, 'scans nodes when no flags present');
      // The bug: a filter code (MARKET/JOBS) drops the nodes section; the stamped
      // flags must still drive the module-section gates.
      const stamped = resolveNodePresence({ filterStats: { hasSellNodes: true, hasJobNodes: false } });
      assert(stamped.hasSellNodes === true && stamped.hasJobNodes === false, 'uses stamped flags when nodes absent');
      const jobs = resolveNodePresence({ nodes: [{ type: 'jobhub' }, { type: 'jobboard' }] });
      assert(jobs.hasJobNodes === true && jobs.hasSellNodes === false, 'jobhub/jobboard count as job nodes');
      // ?? not || — a genuine false from a node-less canvas is respected.
      const empty = resolveNodePresence({ filterStats: { hasJobNodes: false, hasSellNodes: false }, nodes: [] });
      assert(empty.hasJobNodes === false && empty.hasSellNodes === false, 'genuine false flag respected');
      return { ok: true };
    },
  },
{
    name: 'dashboardStats: getStats uses combined bundle price and single-item recommended_price',
    run: () => {
      const nodes = [
        { type: 'jobcard', data: {} },
        { type: 'jobcard', data: {} },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: 250 } } },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: '99.5' } } },
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: null } } }, // no-comps → 0
        { type: 'sellhub', data: { hubState: 'draft', pricing: { recommended_price: 999 } } },    // not priced → excluded
        { type: 'sellhub', data: { hubState: 'priced', userPrice: 500 } },                        // legacy/wrong field → 0
        { type: 'sellhub', data: { hubState: 'priced', pricing: { recommended_price: 20 }, bundleTotal: 42, bundlePricing: { bundle_price: 40 } } },
      ];
      const { jobCardsCount, sellHubsCount, totalValue } = getStats(nodes);
      assert(jobCardsCount === 2, `getStats: jobCardsCount should be 2, got ${jobCardsCount}`);
      assert(sellHubsCount === 6, `getStats: sellHubsCount should be 6, got ${sellHubsCount}`);
      assert(totalValue === 389.5, `getStats: totalValue should include the $40 combined bundle price, got ${totalValue}`);
      return { totalValue };
    },
  },
{
    name: 'dashboardStats: getStatsSignature is stable across position-only changes, changes with priced fields',
    run: () => {
      const base = [
        { id: 'a', type: 'jobcard', position: { x: 0, y: 0 }, data: {} },
        { id: 'b', type: 'sellhub', position: { x: 0, y: 0 }, data: { hubState: 'priced', pricing: { recommended_price: 100 } } },
        { id: 'c', type: 'text', position: { x: 0, y: 0 }, data: {} },
      ];
      const moved = [
        { ...base[0], position: { x: 50, y: 30 } },  // dragged — position changed, nothing stats-relevant
        base[1],
        { ...base[2], position: { x: 10, y: 10 } },
      ];
      assert(getStatsSignature(base) === getStatsSignature(moved),
        'a pure position-only change (drag) must not change the signature');

      const rePriced = [base[0], { ...base[1], data: { hubState: 'priced', pricing: { recommended_price: 200 } } }, base[2]];
      assert(getStatsSignature(base) !== getStatsSignature(rePriced),
        'a changed recommended_price must change the signature');

      const stateChanged = [base[0], { ...base[1], data: { ...base[1].data, hubState: 'draft' } }, base[2]];
      assert(getStatsSignature(base) !== getStatsSignature(stateChanged),
        'a changed hubState must change the signature');

      const added = [...base, { id: 'd', type: 'jobcard', position: { x: 0, y: 0 }, data: {} }];
      assert(getStatsSignature(base) !== getStatsSignature(added),
        'adding a jobcard must change the signature');
      return { ok: true };
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
          { index: 0, matchScore: 90, reasoning: 'great', careerDirection: 'X' },
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
      assert(bJob.matchScore === 40 && bJob.careerDirection === 'Y', 'Batch reconcile: matched score fields spread onto the job');
      return { scored: scoredJobs.length, placeholderCount, failedBatches };
    },
  },
{
    name: 'Scoring audit: retains batch evidence and flags identical cross-batch JD drift',
    run: () => {
      const jd = 'Perform scheduled cleanings, update signage, inspect electrical components, and maintain automated teller machines. '.repeat(6);
      const batches = [
        [{ title: 'Bank Equipment Technician', company: 'Cennox', location: 'Madison, AL', url: 'https://jobs/1', source: 'dice', snippet: jd }],
        [{ title: 'Bank Equipment Technician', company: 'Cennox', location: 'Phoenix, AZ', url: 'https://jobs/2', source: 'dice', snippet: jd }],
      ];
      const scored = [
        { ...batches[1][0], matchScore: 35, careerDirection: 'Field Operations', reasoning: 'Large fit gaps.' },
        { ...batches[0][0], matchScore: 55, careerDirection: 'Field Services', reasoning: 'Transferable service background.' },
      ];
      const audit = buildScoringAudit(scoringAuditRowsFromBatches(batches, scored));
      assert(audit.rows.length === 2 && audit.rows[0].batch === 1 && audit.rows[0].score === 55,
        'audit restores original batch attribution after scored jobs are sorted');
      assert(audit.anomalies.length === 1 && audit.anomalies[0].delta === 20,
        `identical cross-batch postings with a 20-point delta are flagged, got ${JSON.stringify(audit.anomalies)}`);
      assert(audit.rows.every(row => row.url && row.reason && row.descriptionFingerprint),
        'bounded rows retain the evidence needed to diagnose drift from a report');
      return { ok: true, anomalies: audit.anomalies.length };
    },
  },
{
    name: 'Scoring batches: identical postings stay together for one-pass calibration',
    run: () => {
      const jd = 'Maintain automated teller machines, inspect electrical components, update signage, and perform preventative maintenance. '.repeat(5);
      const jobs = [
        { title: 'Unique A', company: 'Acme', snippet: 'short a' },
        { title: 'Bank Equipment Technician', company: 'Cennox', location: 'Madison, AL', snippet: jd, url: 'https://jobs/1' },
        { title: 'Unique B', company: 'Beta', snippet: 'short b' },
        { title: 'Unique C', company: 'Gamma', snippet: 'short c' },
        { title: 'Bank Equipment Technician', company: 'Cennox', location: 'Phoenix, AZ', snippet: jd, url: 'https://jobs/2' },
      ];
      const batches = chunkScoringBatches(jobs, 3);
      const firstBatch = batches.findIndex(batch => batch.some(job => job.url === 'https://jobs/1'));
      const secondBatch = batches.findIndex(batch => batch.some(job => job.url === 'https://jobs/2'));
      assert(firstBatch >= 0 && firstBatch === secondBatch,
        `same title/company/JD postings should share a scoring prompt, got batches ${firstBatch}/${secondBatch}`);
      assert(batches.every(batch => batch.length <= 3), 'similarity packing still honors the model-aware item cap');
      return { ok: true, batchCount: batches.length };
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

      const exactReplacement = mergeResolvedSourceItems(existing, [
        { title: 'Indeed A', company: 'Acme', url: 'https://jobs/a', source: 'indeed', snippet: 'recovered full description' },
      ], 'indeed', { replaceMatchingItems: true });
      assert(exactReplacement.mergedPending.length === existing.length
        && exactReplacement.replacedExisting === 1
        && exactReplacement.mergedPending.some(job => job.url === 'https://jobs/a' && job.snippet === 'recovered full description'),
      'Job source resolve merge: exact retry replaces the matching pending row without dropping unrelated jobs');

      const unavailableRemoval = mergeResolvedSourceItems(existing, [], 'indeed', {
        removedItemKeys: ['https://jobs/a'],
      });
      assert(unavailableRemoval.mergedPending.length === existing.length - 1
        && unavailableRemoval.mergedPending.every(job => job.url !== 'https://jobs/a')
        && unavailableRemoval.mergedPending.some(job => job.url === 'https://jobs/li-a'),
      'Job source resolve merge: an unavailable exact retry removes only that stale listing');

      // Cross-source collapse (same-run policy): a resolved LinkedIn copy of a
      // posting Indeed already returned must NOT enter pendingJobs twice — the
      // backend's dedupByTitleCompany would have collapsed it had LinkedIn not
      // blocked. (Was URL-keyed, so the two copies both reached the scorer.)
      const crossSource = mergeResolvedSourceItems(existing, [
        { title: 'Indeed A', company: 'Acme', url: 'https://jobs/li-dup', source: 'linkedin' },
        { title: 'LinkedIn New', company: 'Acme', url: 'https://jobs/li-new', source: 'linkedin' },
      ], 'linkedin');
      assert(crossSource.fresh.length === 1 && crossSource.fresh[0].title === 'LinkedIn New',
        'Job source resolve merge: cross-source duplicate (same title+company, different board URL) collapses');
      return { incremental: incremental.mergedPending.length, replacement: replacement.mergedPending.length };
    },
  },
{
    name: 'computeJobTreeView: pagination window slices MATCHING cards (filter backfill + ghost tolerance)',
    run: () => {
      // Role leaf with 15 cards: the first 10 from 'lever', the last 5 from
      // 'dice'. Regression: the window used to slice RAW childIds then filter,
      // so a dice source-filter on the expanded role revealed slice(0,10) → 0
      // cards while 5 matches sat beyond the window ("empty" expanded role).
      const cardIds = Array.from({ length: 15 }, (_, i) => `c${i}`);
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'R', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: cardIds, expanded: true, visibleCount: 10 } },
        ...cardIds.map((id, i) => ({
          id, type: 'jobcard', hidden: true, position: { x: 0, y: 0 },
          data: { hubId: 'hub', matchScore: 90 - i, source: i < 10 ? 'lever' : 'dice' },
        })),
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;

      const diced = computeJobTreeView(tree(), 'hub', { sourceFilter: 'dice' });
      const revealedDice = cardIds.filter(id => !hiddenOf(diced, id));
      assert(revealedDice.length === 5 && revealedDice.every(id => Number(id.slice(1)) >= 10),
        `source filter backfills matches beyond the raw window (got ${revealedDice.join(',')})`);
      // Every revealed card must also get a layout position (the layout walks
      // ALL children and skips hidden — it must not re-impose the raw window).
      const positioned = computeLayoutPositions(diced, 'hub', COL_X, { x: 0, y: 0 });
      assert(revealedDice.every(id => positioned[id]), 'revealed beyond-window cards are positioned');

      // No filter: the window still reveals exactly the first 10.
      const plain = computeJobTreeView(tree(), 'hub', {});
      const revealedPlain = cardIds.filter(id => !hiddenOf(plain, id));
      assert(revealedPlain.length === 10 && revealedPlain.every(id => Number(id.slice(1)) < 10),
        'no filter: window reveals exactly the first visibleCount cards');

      // Dismissed ghosts: drop 3 of the first 10 cards from the node set — the
      // window must backfill the next live cards instead of counting ghosts.
      const withGhosts = tree().filter(n => !['c0', 'c1', 'c2'].includes(n.id));
      const backfilled = computeJobTreeView(withGhosts, 'hub', {});
      const revealedLive = cardIds.filter(id => withGhosts.some(n => n.id === id) && !hiddenOf(backfilled, id));
      assert(revealedLive.length === 10, `ghost ids do not consume pagination slots (revealed ${revealedLive.length})`);
      return { ok: true };
    },
  },
{
    name: 'countMatchingDescendantCards: live badge/pagination math skips ghosts + filtered cards',
    run: () => {
      const nodes = new Map([
        ['R', { id: 'R', type: 'jobgroup', data: { childIds: ['a', 'b', 'gone'] } }],
        ['S', { id: 'S', type: 'jobgroup', data: { childIds: ['R', 'c'] } }],
        ['a', { id: 'a', type: 'jobcard', data: { matchScore: 90, source: 'lever' } }],
        ['b', { id: 'b', type: 'jobcard', data: { matchScore: 40, source: 'dice' } }],
        ['c', { id: 'c', type: 'jobcard', data: { matchScore: 70, source: 'dice' } }],
      ]);
      const get = (id) => nodes.get(id);
      assert(countMatchingDescendantCards(['a', 'b', 'gone'], get, {}) === 2, 'leaf: dismissed id does not count');
      assert(countMatchingDescendantCards(['a', 'b'], get, { scoreThreshold: 50 }) === 1, 'leaf: filtered card does not count');
      assert(countMatchingDescendantCards(['R', 'c'], get, {}) === 3, 'recursive: counts cards under nested groups');
      assert(countMatchingDescendantCards(['R', 'c'], get, { sourceFilter: 'dice' }) === 2, 'recursive + filter');
      // Cycle-safe: a malformed tree must not hang.
      nodes.set('X', { id: 'X', type: 'jobgroup', data: { childIds: ['X', 'a'] } });
      assert(countMatchingDescendantCards(['X'], get, {}) === 1, 'cycle-guarded');
      return { ok: true };
    },
  },
{
    name: 'computeJobTreeView: malformed reachable childIds cycle remains renderable',
    run: () => {
      // A hand-edited/legacy canvas can contain a loop beneath an otherwise
      // valid root. The count pass was guarded, but the visibility walk used to
      // recurse forever as soon as the cycle had a matching card.
      const nodes = [
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'root', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', expanded: true, childIds: ['loop'] } },
        { id: 'loop', type: 'jobgroup', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', expanded: true, childIds: ['loop', 'card'] } },
        { id: 'card', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'indeed' } },
      ];
      const out = computeJobTreeView(nodes, 'hub', {});
      assert(out.find(n => n.id === 'root')?.hidden === false, 'cycle: reachable root remains visible');
      assert(out.find(n => n.id === 'loop')?.hidden === false, 'cycle: first loop group remains visible');
      assert(out.find(n => n.id === 'card')?.hidden === false, 'cycle: matching card remains visible');
      return { ok: true };
    },
  },
{
    name: 'Job tree: likelihood → salary → role hierarchy',
    run: () => {
      const mk = (title, score, salary, url) => ({
        title, company: 'Acme', location: 'Remote', salary, snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today',
      });
      // idx0/idx1 excellent+pay, idx2 long-shot+nopay.
      const displayedJobs = [
        { ...mk('Brand Lead', 92, '$150,000 a year', 'https://jobs/0'), originHubId: 'search-A' },
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
      // Two fixed-rubric bands present (Excellent has 2 jobs, Long shot has 1).
      assert(bands.length === 2, `hierarchy: expected 2 likelihood bands, got ${bands.length}`);
      const excellent = bands.find(b => b.data.label.startsWith('Excellent'));
      const longshot = bands.find(b => b.data.label.startsWith('Long shot'));
      assert(excellent.data.count === 2 && longshot.data.count === 1, `hierarchy: band counts wrong (${excellent.data.count}/${longshot.data.count})`);
      // Bands are roots (children of hub, not of any group) and ordered best-first.
      assert(excellent.position.y < longshot.position.y, 'hierarchy: Excellent band should sit above Long shot');
      // Excellent band → two salary ranges ($100k+ for idx0, $50-100k for idx1).
      const excellentRanges = salary.filter(s => (excellent.data.childIds || []).includes(s.id));
      assert(excellentRanges.length === 2, `hierarchy: Excellent band should have 2 salary ranges, got ${excellentRanges.length}`);
      // Highest salary range ordered first WITHIN the band — checked via
      // childIds order, since nothing auto-expands at analysis end so the salary
      // nodes (hidden under the collapsed band) have no laid-out position.
      const hi = excellentRanges.find(s => s.data.label === '$100k+/yr');
      const lo = excellentRanges.find(s => s.data.label === '$50k–$100k/yr');
      assert(excellent.data.childIds[0] === hi.id && excellent.data.childIds[1] === lo.id, 'hierarchy: higher salary range should be ordered first within the band');
      // idx2 (no salary, weak) lands in the Long shot band's Unspecified range.
      const lsRange = salary.find(s => (longshot.data.childIds || []).includes(s.id));
      assert(lsRange.data.label === 'Unspecified', 'hierarchy: no-salary job should land in Unspecified');
      // Role leaves hold the cards.
      assert(roles.every(r => (r.data.childIds || []).every(cid => cards.some(c => c.id === cid))), 'hierarchy: role children should be cards');
      assert(result.scoreRangeMin === 30 && result.scoreRangeMax === 92, 'hierarchy: score range from displayed jobs');
      // Cards carry a string reference to their ORIGIN search module (for
      // "Generate Résumé" career-data lookup), never a profile deep copy.
      const brandLead = cards.find(c => c.data.title === 'Brand Lead');
      assert(brandLead.data.originHubId === 'search-A', 'hierarchy: card carries its origin module id');
      assert(cards.every(c => !('resumeProfile' in c.data)), 'hierarchy: no per-card resumeProfile copies');
      return { cards: cards.length, bands: bands.length, salary: salary.length, roles: roles.length };
    },
  },
{
    name: 'Job tree: parseable low salary does not land in Unspecified',
    run: () => {
      const displayedJobs = [
        {
          title: 'Coordinator', company: 'Acme', location: 'Remote',
          salary: '$45,000 a year', snippet: 'x', matchScore: 80,
          reasoning: 'r', careerDirection: 'Operations', source: 'lever',
          url: 'https://jobs/low', posted: 'today',
        },
        {
          title: 'Mystery Role', company: 'Acme', location: 'Remote',
          salary: '', snippet: 'x', matchScore: 78,
          reasoning: 'r', careerDirection: 'Operations', source: 'lever',
          url: 'https://jobs/none', posted: 'today',
        },
      ];
      const result = buildJobTreeNodes({
        displayedJobs,
        bucketTree: {
          likelihoodBands: [{ label: 'Strong (0-100%)', minScore: 0, maxScore: 100 }],
          // Malformed-but-plausible model output: it forgot a low-end catch-all.
          salaryRanges: [
            { label: '$80k+', minSalary: 80000, maxSalary: 0 },
            { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
          ],
          roles: [{ name: 'Operations', jobIndices: [0, 1] }],
        },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-1', baseNodeId: 'job-low',
      });
      const salaryGroups = result.newNodes.filter(n => n.data?.kind === 'salary');
      const lowRange = salaryGroups.find(n => n.data.label === 'Under $80k/yr');
      const unspecified = salaryGroups.find(n => n.data.label === 'Unspecified');
      assert(lowRange, 'salary fallback: expected synthetic low-end range');
      assert(unspecified, 'salary fallback: expected Unspecified range for missing salary');
      assert(lowRange.data.count === 1, `salary fallback: low salary should be in Below $80k (got ${lowRange.data.count})`);
      assert(unspecified.data.count === 1, `salary fallback: only missing salary should be Unspecified (got ${unspecified.data.count})`);
      return { salaryGroups: salaryGroups.map(g => g.data.label) };
    },
  },
{
    name: 'Job tree: ZipRecruiter Canadian hourly range keeps display text and salary placement',
    run: () => {
      const rawSalary = 'CA$40 - CA$85/hr';
      const result = buildJobTreeNodes({
        displayedJobs: [{
          title: 'Software Developer - Cloud Solutions', company: 'PulseLearning', location: 'Toronto, ON',
          salary: rawSalary, snippet: 'x', matchScore: 68, reasoning: 'r', careerDirection: 'Full-Stack Engineering',
          source: 'ziprecruiter', url: 'https://jobs/pulselearning', posted: '17 days ago',
        }],
        bucketTree: {
          salaryRanges: [
            { label: '$120k+', minSalary: 120000, maxSalary: 0 },
            { label: '$80k–$120k', minSalary: 80000, maxSalary: 120000 },
            { label: 'Under $80k', minSalary: 1, maxSalary: 80000 },
            { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
          ],
          roles: [{ name: 'Full-Stack Engineering', jobIndices: [0] }],
        },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-pulselearning', baseNodeId: 'job-pulselearning',
      });
      const salaryGroup = result.newNodes.find(node => node.data?.kind === 'salary');
      const card = result.newNodes.find(node => node.type === 'jobcard');
      assert(salaryGroup?.data.label === '$80k–$120k/yr',
        `PulseLearning salary: CA$40/hr annualizes into $80k–$120k/yr (got "${salaryGroup?.data.label}")`);
      assert(card?.data.salary === rawSalary,
        `PulseLearning card: preserves the complete source range (got "${card?.data.salary}")`);
      return { salaryGroup: salaryGroup.data.label, display: card.data.salary };
    },
  },
{
    name: 'USAJobs salary: RateIntervalCode maps to a cadence the shared annualizer can read',
    run: () => {
      // Real captured values from a live run (bug report): "/ PH" (per hour)
      // matched no cadence token the shared parser recognizes, so every
      // hourly USAJobs listing silently annualized to 0/Unspecified even
      // though real pay was present.
      const phRates = ['22.31', '18.98', '18.23', '19.59'];
      for (const rate of phRates) {
        const formatted = formatUSAJobsSalary({ MinimumRange: rate, MaximumRange: rate, RateIntervalCode: 'PH' });
        assert(formatted === `$${rate} / hr`,
          `USAJobs salary: "$${rate} - $${rate} / PH" collapses to "$${rate} / hr" (got "${formatted}")`);
        assert(parseSalaryToNumeric(formatted) === Math.round(Number(rate) * 40 * 52),
          `USAJobs salary regression: "$${rate} - $${rate} / PH" now annualizes instead of staying 0/Unspecified`);
      }
      // The "/ PA" (per annum) listings only survived pre-fix by luck — the
      // number itself already cleared the credibility floor. Confirm they
      // still annualize correctly (to the lower endpoint) now that "/ yr" is
      // an explicit, recognized annual cadence rather than an unmatched code.
      // USAJobs ships bare integers; amounts are comma-grouped for display (as
      // formatDiceBaseSalary does) and must still annualize through the parser.
      const paRanges = [['106437', '138370'], ['52727', '68549'], ['63795', '82938'], ['109137', '141880']];
      const grouped = (n) => Number(n).toLocaleString('en-US');
      for (const [min, max] of paRanges) {
        const formatted = formatUSAJobsSalary({ MinimumRange: min, MaximumRange: max, RateIntervalCode: 'PA' });
        assert(formatted === `$${grouped(min)} - $${grouped(max)} / yr`,
          `USAJobs salary: "$${min} - $${max} / PA" maps to comma-grouped "/ yr" (got "${formatted}")`);
        assert(parseSalaryToNumeric(formatted) === Number(min),
          `USAJobs salary: "${formatted}" annualizes to the lower endpoint`);
      }
      assert(formatUSAJobsSalary({ MinimumRange: 'Negotiable', RateIntervalCode: 'PA' }) === '$Negotiable - $Negotiable / yr',
        'USAJobs salary: a non-numeric range value passes through rather than becoming $0');

      assert(formatUSAJobsSalary({ MinimumRange: '200', MaximumRange: '250', RateIntervalCode: 'PD' }) === '$200 - $250 / day',
        'USAJobs salary: PD (per day) maps to "/ day"');
      assert(parseSalaryToNumeric('$200 - $250 / day') === 200 * 5 * 52, 'USAJobs salary: daily cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '800', MaximumRange: '900', RateIntervalCode: 'PW' }) === '$800 - $900 / wk',
        'USAJobs salary: PW (per week) maps to "/ wk"');
      assert(parseSalaryToNumeric('$800 - $900 / wk') === 800 * 52, 'USAJobs salary: weekly cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '1500', MaximumRange: '1600', RateIntervalCode: 'PB' }) === '$1,500 - $1,600 bi-weekly',
        'USAJobs salary: PB (per bi-week) maps to the literal "bi-weekly" phrase');
      assert(parseSalaryToNumeric('$1,500 - $1,600 bi-weekly') === 1500 * 26, 'USAJobs salary: bi-weekly cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '4000', MaximumRange: '4500', RateIntervalCode: 'PM' }) === '$4,000 - $4,500 / mo',
        'USAJobs salary: PM (per month) maps to "/ mo"');
      assert(parseSalaryToNumeric('$4,000 - $4,500 / mo') === 4000 * 12, 'USAJobs salary: monthly cadence annualizes');

      assert(formatUSAJobsSalary({ MinimumRange: '90000', MaximumRange: '95000', RateIntervalCode: 'FY' }) === '$90,000 - $95,000 / yr',
        'USAJobs salary: FY (fee basis, per year) maps to "/ yr"');
      assert(parseSalaryToNumeric('$90,000 - $95,000 / yr') === 90000, 'USAJobs salary: fee-basis annual range annualizes');

      // PS (per piece) and SY (per school year) have no defined multiplier in
      // the shared annualizer — keep the amount, never fabricate a cadence.
      assert(formatUSAJobsSalary({ MinimumRange: '50000', MaximumRange: '55000', RateIntervalCode: 'PS' }) === '$50,000 - $55,000 (PS)',
        'USAJobs salary: PS (piece rate) keeps the raw code instead of guessing a cadence');
      assert(parseSalaryToNumeric('$50,000 - $55,000 (PS)') === 50000, 'USAJobs salary: PS amount still annualizes on magnitude alone');
      assert(formatUSAJobsSalary({ MinimumRange: '5', MaximumRange: '5', RateIntervalCode: 'PS' }) === '$5 (PS)',
        'USAJobs salary: degenerate low-magnitude PS range collapses to a single amount');
      assert(parseSalaryToNumeric('$5 (PS)') === 0,
        'USAJobs salary: low-magnitude PS never gets a fabricated cadence — correctly stays Unspecified');

      assert(formatUSAJobsSalary({ MinimumRange: '45000', MaximumRange: '50000', RateIntervalCode: 'SY' }) === '$45,000 - $50,000 (SY)',
        'USAJobs salary: SY (school year) keeps the raw code instead of guessing a cadence');
      assert(parseSalaryToNumeric('$45,000 - $50,000 (SY)') === 45000, 'USAJobs salary: SY amount still annualizes on magnitude alone');

      // WC = "without compensation" — there is no pay at all, so no salary string.
      assert(formatUSAJobsSalary({ MinimumRange: '0', MaximumRange: '0', RateIntervalCode: 'WC' }) === '',
        'USAJobs salary: WC emits no salary string');
      assert(formatUSAJobsSalary({ RateIntervalCode: 'WC' }) === '',
        'USAJobs salary: WC with no range at all still emits nothing');

      // Unknown/future code — never invent a cadence; keep the raw code
      // visible so an undocumented code stays diagnosable.
      assert(formatUSAJobsSalary({ MinimumRange: '40000', MaximumRange: '45000', RateIntervalCode: 'XX' }) === '$40,000 - $45,000 (XX)',
        'USAJobs salary: unknown RateIntervalCode keeps the amount + raw code, no fabricated cadence');
      assert(parseSalaryToNumeric('$40,000 - $45,000 (XX)') === 40000, 'USAJobs salary: unknown-code amount still annualizes on magnitude alone');

      // Missing code entirely.
      assert(formatUSAJobsSalary({ MinimumRange: '40000', MaximumRange: '45000' }) === '$40,000 - $45,000',
        'USAJobs salary: absent RateIntervalCode emits the amount with no suffix and no parens');

      // Guards preserved from before the fix.
      assert(formatUSAJobsSalary(null) === '', 'USAJobs salary: no PositionRemuneration entry → empty string');
      assert(formatUSAJobsSalary({ RateIntervalCode: 'PH' }) === '',
        'USAJobs salary: entry present but MinimumRange/MaximumRange both absent → empty string');
      return { ok: true };
    },
  },
{
    name: 'Job taxonomy: salary cadence parser and canonical range repairs',
    run: () => {
      assert(parseSalaryToNumeric('$1.6K - $2.0K/wk') === 83200, 'salary parser: decimal weekly salary annualizes');
      assert(parseSalaryToNumeric('$2,000 bi-weekly') === 52000, 'salary parser: biweekly salary annualizes');
      assert(parseSalaryToNumeric('$5,000/month') === 60000, 'salary parser: monthly salary annualizes');
      assert(parseSalaryToNumeric('$300/day') === 78000, 'salary parser: daily salary annualizes');
      assert(parseSalaryToNumeric('$22/hour') === 45760, 'salary parser: hourly salary annualizes');
      for (const raw of ['$19', '$20', '$18.15', '$1.0K', '$2,500', '3 years experience', '401k matching']) {
        assert(parseSalaryToNumeric(raw) === 0, `salary parser: ${raw} without an annual/pay cadence is unspecified`);
      }
      for (const raw of ['19 - 21', '$21 - $22', '$24 - $24', 'USD49 - USD54']) {
        assert(parseSalaryToNumeric(raw) === 0,
          `salary parser: cadence-less low range ${raw} stays Unspecified instead of becoming dollars per year`);
      }
      const annualized = {
        '$19 Hourly': 39520,
        '$71K Annually': 71000,
        '$18.15 an hour': 37752,
        '$1.6K Weekly': 83200,
        '$1.0K Weekly': 52000,
        '$2,500 Monthly': 30000,
        '$71K': 71000,
        '$1.5M a year': 1500000,
        '$65K/yr': 65000,
        '$147,000-$175,000': 147000,
        '$80,000': 80000,
        '$172,333/year': 172333,
        '$8,000 a year': 8000,
        '$22/hour': 45760,
        '$5,000/month': 60000,
        '$2,000 bi-weekly': 52000,
        '$300/day': 78000,
      };
      for (const [raw, expected] of Object.entries(annualized)) {
        assert(parseSalaryToNumeric(raw) === expected, `salary parser: ${raw} → ${expected}`);
      }
      assert(parseSalaryToNumeric('$65K/hr') === 0,
        'salary parser: implausible abbreviated hourly rate stays Unspecified instead of overflowing annual salary ranges');
      const malformedRange = salaryRangeAnomaly('$23.50–$250.00 an hour');
      assert(parseSalaryToNumeric('$23.50–$250.00 an hour') === 48880,
        'salary parser: range placement remains lower-endpoint based');
      assert(malformedRange?.lowerAnnual === 48880 && malformedRange?.upperAnnual === 520000 && malformedRange?.ratio > 10,
        'salary anomaly: implausibly wide hourly range exposes both annualized endpoints without changing placement');
      assert(salaryRangeAnomaly('$15.68–$26.61 an hour') === null,
        'salary anomaly: ordinary compensation ranges stay quiet');
      // Regression: Google and Glassdoor both prefix USD amounts with a country
      // code ("US$50K–US$250K a year"). The endpoint pattern used to require a
      // bare `$` or digit right after the separator, so the letters in `US$250K`
      // failed the whole match and the anomaly check silently went dark for those
      // two sources at ANY ratio. Compare against the identical bare-$ string.
      const prefixedWide = salaryRangeAnomaly('US$50K–US$250K a year');
      const bareWide = salaryRangeAnomaly('$50K–$250K a year');
      assert(prefixedWide?.lowerAnnual === 50000 && prefixedWide?.upperAnnual === 250000,
        'salary anomaly: a US$-prefixed range annualizes both endpoints (was silently unmatched)');
      assert(bareWide?.ratio === prefixedWide?.ratio,
        'salary anomaly: country-code currency prefix does not change the reported ratio');
      assert(salaryRangeAnomaly('CA$20K–CA$150K a year')?.ratio === 7.5,
        'salary anomaly: the prefix fix is not hard-coded to US$');
      assert(salaryRangeAnomaly('US$17.00–US$18.50 an hour') === null,
        'salary anomaly: an ordinary US$-prefixed hourly band still stays quiet');
      assert(salaryRangeAnomaly('$20 to $30 an hour') === null,
        'salary anomaly: a "to" separator is not mistaken for a currency-code prefix');
      assert(salaryRangeAnomaly('USD 90,000.00 - 125,000.00 per year') === null,
        'salary anomaly: symbol-less currency-code ranges (Dice) stay quiet at a normal ratio');
      const wwrCadenceCases = {
        'Starting base compensation: $2,500 USD per month': ['$2,500 USD per month', 30000],
        'Compensation: $1,600 CAD/week.': ['$1,600 CAD/week', 83200],
        'Base pay is $1,000 per day.': ['$1,000 per day', 260000],
        'Salary: $80,000 USD annually.': ['$80,000 USD annually', 80000],
      };
      for (const [text, [rawSalary, annualSalary]] of Object.entries(wwrCadenceCases)) {
        const extracted = extractSalaryFromText(text);
        assert(extracted === rawSalary, `WWR salary extractor: preserves currency + cadence for ${text}`);
        assert(parseSalaryToNumeric(extracted) === annualSalary, `WWR salary extractor: ${extracted} → ${annualSalary}`);
      }
      // extractSalaryFromText shares its global unit regexp between calls. The
      // iterator must not leak lastIndex and skip an otherwise-identical later
      // listing in a full RSS feed.
      for (let i = 0; i < 3; i++) {
        assert(extractSalaryFromText('Remote role offers $95,000 per year.') === '$95,000 per year',
          `WWR salary extractor: shared regexp remains stateless across call ${i + 1}`);
      }
      assert(parseSalaryToNumeric('401k matching') === 0, 'salary parser: benefit prose is not salary');
      assert(parseSalaryToNumeric('3 years experience') === 0, 'salary parser: incidental numeric prose is not salary');
      assert(canonicalSalaryRangeLabel(120000, 0) === '$120k+/yr', 'salary labels derive from numeric open-ended bound');
      assert(canonicalSalaryRangeLabel(80000, 120000) === '$80k–$120k/yr', 'salary labels derive from numeric closed bounds');

      const ranges = normalizeRangesWithRepairs([
        { label: '$120k process/yr', minSalary: 120000, maxSalary: 0 },
        { label: 'bad prose', minSalary: 80000, maxSalary: 100000 },
        { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
      ]);
      assert(ranges.real[0].label === '$120k+/yr' && ranges.real[1].label === '$80k–$120k/yr',
        'salary ranges: labels and maxima canonicalize from contiguous thresholds');
      assert(ranges.repairs.some(repair => repair.includes('canonicalized salary label "$120k process/yr"')),
        'salary ranges: malformed model labels are preserved in validation repairs');
      const lowCatchAllRepair = normalizeRangesWithRepairs([
        { label: '$120k+/yr', minSalary: 120000, maxSalary: 0 },
        { label: 'Under $120k/yr', minSalary: 1, maxSalary: 80000 },
        { label: 'Unspecified', minSalary: 0, maxSalary: 0 },
      ]);
      assert(lowCatchAllRepair.repairs.includes('normalized salary upper bound for the low-salary catch-all')
        && !lowCatchAllRepair.repairs.some(repair => /for \$1$/.test(repair)),
      'salary ranges: synthetic low-salary catch-all repair is not misreported as a literal $1 salary');
      const bands = normalizeBandsWithRepairs([{ label: 'Strong fit', minScore: 80, maxScore: 99 }]);
      assert(bands.bands.map(b => `${b.label}:${b.minScore}-${b.maxScore}`).join('|')
        === 'Excellent fit (85–100%):85-100|Good fit (65–84%):65-84|Possible (40–64%):40-64|Long shot (0–39%):0-39',
      'likelihood bands: model-authored thresholds/labels are replaced by the fixed scoring rubric');
      assert(bands.repairs.includes('replaced likelihood bands with fixed scoring rubric'),
        'likelihood bands: replacing legacy/model thresholds is visible in repair telemetry');
      const taxonomy = sanitizeJobTaxonomy({
        likelihoodBands: [{ label: 'Strong', minScore: 80, maxScore: 100 }],
        salaryRanges: [
          { label: '$120k process/yr', minSalary: 120000, maxSalary: 0 },
          { label: 'bad $80–$100k prose', minSalary: 80000, maxSalary: 100000 },
        ],
        roles: [{ name: 'Creative', jobIndices: [0, 0, 99] }],
      }, 2, ['$123K - $130K/yr', '$1.6K - $2.0K/wk']);
      assert(taxonomy.salaryRanges.some(r => r.label === '$80k–$120k/yr'),
        'taxonomy sanitization: adds a low-end range for parseable weekly salary');
      assert(taxonomy.likelihoodBands.map(b => b.minScore).join(',') === '85,65,40,0',
        'taxonomy sanitization: likelihood thresholds stay aligned with the scoring rubric');
      assert(taxonomy.roles[0].jobIndices.join(',') === '0', 'taxonomy sanitization: drops duplicate/out-of-range role indexes');
      assert(taxonomy.roles.find(role => role.name === 'Other')?.jobIndices.join(',') === '1',
        'taxonomy sanitization: legacy callers without job metadata recover unassigned jobs into Other');

      // A real Claude tool call under the legacy grouped-index contract returned
      // this shape: a blank role containing only part of the input. Keep the
      // sanitizer backstop even though the new positional contract structurally
      // requires full coverage: useful scorer directions must recover malformed
      // saved/provider output, while valid AI assignments stay authoritative.
      const roleRecovery = sanitizeJobTaxonomy({
        salaryRanges: [],
        roles: [
          { name: '', jobIndices: [0, 1, 3] },
          { name: 'Platform Architecture', jobIndices: [2, 2, 99] },
        ],
      }, 5, [], [
        { careerDirection: ' Software Engineering ' },
        { careerDirection: 'Data Engineering' },
        { careerDirection: 'Solutions Architecture' },
        { careerDirection: 'Software Engineering' },
        { careerDirection: 'Other' },
      ]);
      const recoveredByName = new Map(roleRecovery.roles.map(role => [role.name, role.jobIndices]));
      assert(recoveredByName.get('Platform Architecture')?.join(',') === '2',
        'taxonomy role recovery: valid AI assignment remains authoritative');
      assert(recoveredByName.get('Software Engineering')?.join(',') === '0,3'
        && recoveredByName.get('Data Engineering')?.join(',') === '1',
      'taxonomy role recovery: blank/missing assignments use normalized career directions');
      assert(recoveredByName.get('Other')?.join(',') === '4',
        'taxonomy role recovery: only a genuinely unhinted/generic direction uses Other');
      const recoveredIndexes = roleRecovery.roles.flatMap(role => role.jobIndices).sort((a, b) => a - b);
      assert(recoveredIndexes.join(',') === '0,1,2,3,4',
        'taxonomy role recovery: every job index is assigned exactly once');
      assert(roleRecovery.repairs.includes('recovered 3 job(s) into career-direction role(s)')
        && roleRecovery.repairs.includes('recovered 1 unhinted job(s) into Other'),
      'taxonomy role recovery: diagnostics distinguish direction recovery from unhinted Other');

      const result = buildJobTreeNodes({
        displayedJobs: [{ title: 'Weekly', company: 'Acme', location: 'Remote', salary: '$1.6K - $2.0K/wk', snippet: '', matchScore: 50, source: 'dice', url: 'https://jobs/weekly' }],
        bucketTree: taxonomy,
        originalPos: { x: 0, y: 0 }, hubId: 'hub-salary', baseNodeId: 'job-salary',
      });
      assert(result.newNodes.some(n => n.data?.kind === 'salary' && n.data.label === '$80k–$120k/yr' && n.data.count === 1),
        'tree placement: decimal weekly salary lands in its annualized range');

      const boundaryScores = [100, 85, 84, 65, 64, 40, 39, 0];
      const boundaryTree = buildJobTreeNodes({
        displayedJobs: boundaryScores.map((matchScore, index) => ({
          title: `Boundary ${matchScore}`, company: 'Acme', location: 'Remote',
          salary: '', snippet: '', matchScore, source: 'indeed', url: `https://jobs/boundary-${index}`,
        })),
        bucketTree: {
          // Deliberately contradictory legacy/model taxonomy: renderer must
          // ignore it and use the scorer's fixed boundaries.
          likelihoodBands: [{ label: 'Everything is good (0–100%)', minScore: 0, maxScore: 100 }],
          salaryRanges: [{ label: 'Unspecified', minSalary: 0, maxSalary: 0 }],
          roles: [{ name: 'Boundary roles', jobIndices: boundaryScores.map((_, index) => index) }],
        },
        originalPos: { x: 0, y: 0 }, hubId: 'hub-boundaries', baseNodeId: 'job-boundaries',
      });
      const boundaryBands = boundaryTree.newNodes
        .filter(n => n.data?.kind === 'likelihood')
        .map(n => [n.data.label, n.data.count]);
      assert(JSON.stringify(boundaryBands) === JSON.stringify([
        ['Excellent fit (85–100%)', 2],
        ['Good fit (65–84%)', 2],
        ['Possible (40–64%)', 2],
        ['Long shot (0–39%)', 2],
      ]), `tree placement: rubric boundary scores map to fixed bands, got ${JSON.stringify(boundaryBands)}`);
      return { repairs: taxonomy.repairs.length };
    },
  },
{
    name: 'Job search extractors: retain salary cadence and reject known RemoteOK ads',
    run: () => {
      assert(formatJsonLdSalary({ value: { value: 19, unitText: 'HOUR' } }) === '$19/hr',
        'JSON-LD salary: hourly values retain their cadence');
      assert(formatJsonLdSalary({ value: { value: 19 } }) === '',
        'JSON-LD salary: unitless small values defer to the visible salary chip');
      assert(formatJsonLdSalary({ value: { minValue: 80000, maxValue: 120000 } }) === '$80,000 - $120,000',
        'JSON-LD salary: unitless annual-scale ranges remain useful');
      assert(reconcileZipRecruiterDomSalary('$65K/hr', 'Base Salary: Starting at $65,000 annually') === '$65,000 annually',
        'ZipRecruiter: malformed abbreviated hourly chip is replaced by explicit annual pay from the JD');
      assert(reconcileZipRecruiterDomSalary('$65K/hr', 'Responsibilities and qualifications only.') === '',
        'ZipRecruiter: malformed abbreviated hourly chip is blanked when the JD cannot correct it');
      assert(reconcileZipRecruiterDomSalary('$29/hr', 'Base Salary: Starting at $65,000 annually') === '$29/hr',
        'ZipRecruiter: plausible hourly chips remain authoritative over a separate annual JD figure');
      const pulseLearningPay = extractZipRecruiterDomSalaryText('CA$40 - CA$85/hr');
      assert(pulseLearningPay === 'CA$40 - CA$85/hr',
        `ZipRecruiter: currency-prefixed range keeps both endpoints and cadence (got "${pulseLearningPay}")`);
      assert(reconcileZipRecruiterDomSalary(pulseLearningPay, '') === 'CA$40 - CA$85/hr'
        && parseSalaryToNumeric(pulseLearningPay) === 83200,
      'ZipRecruiter: the exact PulseLearning chip survives source reconciliation and annualizes from CA$40/hr');
      const prefixedCadenceRanges = new Map([
        ['CA$100 - CA$120/hr', 208000],
        ['CA$2.0K - CA$2.5K/wk', 104000],
        ['US$17.60 - US$22.00 Per hour', 36608],
      ]);
      for (const [raw, annual] of prefixedCadenceRanges) {
        const extracted = extractZipRecruiterDomSalaryText(raw);
        assert(extracted === raw && parseSalaryToNumeric(extracted) === annual,
          `ZipRecruiter: preserves and annualizes prefixed cadence range "${raw}"`);
      }
      assert(reconcileZipRecruiterDomSalary('', 'Salary range CA$40 - CA$85 Compensation Type: Hourly') === '$40 - $85/hr',
        'ZipRecruiter: the description fallback also accepts currency prefixes on both range endpoints');
      const tranePay = 'Annual Base Salary Range or Hourly Base Pay Range: $111308,33 - $155435,00 Compensation Type: Salary';
      const recoveredTranePay = reconcileZipRecruiterDomSalary('$22', tranePay);
      assert(recoveredTranePay === '$111,308.33 - $155,435/yr',
        `ZipRecruiter: decimal-comma JD salary repairs a cadence-less chip (got "${recoveredTranePay}")`);
      assert(parseSalaryToNumeric(recoveredTranePay) === 111308,
        'ZipRecruiter: recovered locale salary annualizes instead of landing in Unspecified');
      assert(parseSalaryToNumeric('$19 Hourly') === 39520,
        'salary parser: capitalized word-form hourly cadence annualizes');
      assert(parseSalaryToNumeric('$19') === 0,
        'salary parser: unitless low dollar values are not invented as annual salary');
      assert(parseSalaryToNumeric('$8,000 a year') === 8000,
        'salary parser: explicit annual cadence permits legitimate low annual pay');
      assert(parseSalaryToNumeric('$18.75 - $19.70 a year') === 0,
        'salary parser: implausibly tiny explicit annual ranges stay Unspecified instead of becoming $19/year');
      assert(isRemoteOkSponsoredPlacement({ company: ' AI Supermarket ' }),
        'RemoteOK: exact sponsored pseudo-employer is excluded');
      assert(!isRemoteOkSponsoredPlacement({ company: 'A Supermarket' }),
        'RemoteOK: similarly named real employers remain eligible');
      const apiRows = [
        { company: 'AI Supermarket', position: 'Promoted Product' },
        { company: 'Acme', position: 'Customer Support Specialist' },
      ];
      const eligible = apiRows.filter(row => !isRemoteOkSponsoredPlacement(row));
      assert(eligible.length === 1 && eligible[0].company === 'Acme',
        'RemoteOK: sponsored rows are excluded by the predicate before any relevance matching; ordinary rows survive');
      return { jsonLd: 'cadence-preserved', remoteok: 'sponsored-filtered' };
    },
  },
{
    name: 'manualScraper telemetry: known ad/tracker CSP and network noise cannot evict genuine failures',
    run: () => {
      const ignoredUrls = [
        'https://znboux7hrdwpqwmoe-ziprecruiter.siteintercept.qualtrics.com/SIE/?Q_ZID=abc',
        'https://d.impactradius-event.com/A1957846/example.js',
        'https://googleads.g.doubleclick.net/pagead/viewthroughconversion/995393872/',
        'https://ad.doubleclick.net/ccm/s/collect?fmt=8',
        'https://www.google.com/rmkt/collect/995393872/?fmt=8',
        'https://www.google.com/ccm/collect?rcb=14&frm=0',
        'https://csp.withgoogle.com/csp/IdentityRotateCookiesHttp',
      ];
      for (const url of ignoredUrls) {
        assert(isIgnorableManualBrowserTelemetry({ url }), `known telemetry noise should be ignored: ${url}`);
      }

      // Console CSP failures are reported at the first-party bundle that made
      // the request; the actual blocked tracker URL appears in the message.
      assert(isIgnorableManualBrowserTelemetry({
        url: 'https://www.ziprecruiter.com/_next/static/chunks/app.js',
        text: "Loading the script 'https://d.impactradius-event.com/tracker.js' violates the following Content Security Policy directive",
      }), 'known tracker URL embedded in a first-party CSP message is ignored');
      assert(isIgnorableManualBrowserTelemetry({
        url: 'https://www.google.com/search?q=jobs',
        text: 'Fetch API cannot load https://csp.withgoogle.com/csp/IdentityRotateCookiesHttp. Refused to connect.',
      }), 'Google cookie-rotation ORB/CSP noise embedded in console text is ignored');

      // The classifier is intentionally not a blanket third-party/CSP filter.
      // Unknown dependencies and first-party job-page failures are precisely
      // the evidence these bounded buffers exist to retain.
      assert(!isIgnorableManualBrowserTelemetry({
        url: 'https://www.ziprecruiter.com/jobs-search',
        text: 'Failed to load resource: net::ERR_CONNECTION_RESET',
      }), 'first-party request failures remain visible');
      assert(!isIgnorableManualBrowserTelemetry({
        url: 'https://cdn.unfamiliar-vendor.example/widget.js',
        text: 'Failed to load resource: the server responded with a status of 503',
      }), 'unknown third-party failures remain visible');
      assert(!isIgnorableManualBrowserTelemetry({ url: 'https://doubleclick.net.attacker.example/api' }),
        'lookalike hostnames do not inherit a known tracker exclusion');
      assert(!isIgnorableManualBrowserTelemetry({ url: 'https://www.google.com/search?q=rmkt+jobs' }),
        'ordinary first-party Google requests are retained; only the exact /rmkt/ endpoint is noise');
      assert(!isIgnorableManualBrowserTelemetry({
        url: 'https://www.ziprecruiter.com/app.js',
        text: "Connecting to 'https://api.ziprecruiter.com/jobs' violates CSP; connect-src also allows https://googleads.g.doubleclick.net",
      }), 'a genuine first target is retained even when later CSP directive text names an ignored domain');
      assert(!isIgnorableManualBrowserTelemetry({ text: 'This document requires TrustedHTML assignment. The action has been blocked.' }),
        'unknown console failures without a target URL remain visible');
      return { ignored: ignoredUrls.length, genuinePreserved: 6 };
    },
  },
{
    name: 'scraper overlay: Trusted Types-safe construction remains inert on challenge documents',
    run: () => {
      const script = buildOverlayScript({ withPause: true, cdpBridge: false });
      assert(!script.includes('innerHTML'),
        'overlay script never assigns or probes an HTML sink, so it cannot emit TrustedHTML errors');
      assert(script.includes("_icTitle.startsWith('just a moment')")
        && script.includes('#cf-challenge-running')
        && script.includes('challenges.cloudflare.com'),
      'overlay script exits before style/DOM work on known Cloudflare challenge documents');
      assert(script.includes("make('button', 'ic-pause'") && script.includes('appendChild'),
        'overlay still builds the pause control through DOM nodes');
      return { trustedTypesSafe: true };
    },
  },
{
    name: 'manualScraper telemetry: per-job anomalies join the trail without hijacking the current phase',
    run: () => {
      // `active` is a MERGE that never deletes fields, so a desc-miss/date-miss
      // recorded as a normal phase would pin its `key` onto every later render —
      // the bug report would then attribute one job's miss to whatever phase the
      // scraper happened to be in at report time. Anomalies must reach the event
      // trail (that visibility is the whole point) but leave `active` alone.
      recordManualScraperTelemetry({ phase: 'page-extract', srcName: 'ZipRecruiter', pageNum: 1 });
      recordManualScraperTelemetry(
        { phase: 'desc-miss', srcName: 'ZipRecruiter', key: 'Patient Representative II | ld=0 nd=0' },
        { updateActive: false },
      );
      const afterMiss = getManualScraperTelemetry();
      assert(afterMiss.active.phase === 'page-extract',
        `anomaly must not become the current phase, got ${afterMiss.active.phase}`);
      assert(afterMiss.active.key === undefined,
        `anomaly key must never leak into active, got ${JSON.stringify(afterMiss.active.key)}`);
      assert(afterMiss.events.some(e => e.phase === 'desc-miss' && /Patient Representative II/.test(e.key || '')),
        'the desc-miss must still be recorded in the event trail');
      assert(afterMiss.fieldAnomalies?.some(e => e.phase === 'desc-miss' && /Patient Representative II/.test(e.key || '')),
        'the desc-miss is also retained in the dedicated field-quality trail');

      // A real phase transition still advances `active` — the opt-out is per-call,
      // not a behaviour change for the ordinary path.
      recordManualScraperTelemetry({
        phase: 'detail-expand', srcName: 'Glassdoor', key: 'Old Glassdoor listing',
        itemIndex: 5, itemTotal: 5, descriptionSource: 'jsonLd', reason: 'old detail',
      });
      recordManualScraperTelemetry({
        phase: 'source-start', srcName: 'Google for Jobs', sourceId: 'google', queryTotal: 12,
      });
      const afterSourceChange = getManualScraperTelemetry();
      assert(afterSourceChange.active.srcName === 'Google for Jobs'
        && afterSourceChange.active.key === undefined
        && afterSourceChange.active.itemIndex === undefined
        && afterSourceChange.active.descriptionSource === undefined
        && afterSourceChange.active.reason === undefined,
      `source transition must clear prior listing context, got ${JSON.stringify(afterSourceChange.active)}`);

      recordManualScraperTelemetry({ phase: 'source-finished', srcName: 'ZipRecruiter' });
      const afterPhase = getManualScraperTelemetry();
      assert(afterPhase.active.phase === 'source-finished',
        `ordinary phases still advance active, got ${afterPhase.active.phase}`);
      assert(afterPhase.active.key === undefined,
        'a stale anomaly key must not resurface on a later phase');
      return { ok: true, activePhase: afterPhase.active.phase };
    },
  },
{
    name: 'manualScraper telemetry: a new job-search run clears prior browser phases and diagnostics',
    run: () => {
      // Simulate a completed Google browser scrape, then the boundary crossed by
      // a LinkedIn-only/API-only follow-up. That second run never calls the
      // manual browser loop, so this explicit reset is what prevents the old
      // source-finished event from being rendered as current work.
      recordManualScraperTelemetry({
        phase: 'source-finished', sourceId: 'google', srcName: 'Google for Jobs', count: 117,
      });
      recordManualScraperTelemetry(
        { phase: 'desc-miss', sourceId: 'google', srcName: 'Google for Jobs', key: 'Old Google job' },
        { updateActive: false },
      );
      assert(getManualScraperTelemetry().active?.sourceId === 'google',
        'fixture must begin with prior browser activity');

      resetManualScraperTelemetry();
      const fresh = getManualScraperTelemetry();
      assert(fresh.active === null, 'a new run has no inherited active browser phase');
      assert(fresh.events.length === 0, 'a new run has no inherited browser phase trail');
      assert(fresh.fieldAnomalies.length === 0, 'a new run has no inherited field-quality anomaly');
      assert(fresh.consoleLogs.length === 0 && fresh.networkErrors.length === 0,
        'a new run has no inherited browser console/network diagnostics');
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: field-quality scraper anomalies survive later source phases',
    run: () => {
      // Fill the capped telemetry ring exactly as a multi-source run does: two
      // ZipRecruiter description misses followed by enough Google phases to
      // displace them from the ordinary trailing-eight progress display.
      recordManualScraperTelemetry(
        { phase: 'desc-miss', srcName: 'ZipRecruiter', key: 'First missing JD | ld=0 nd=0' },
        { updateActive: false },
      );
      recordManualScraperTelemetry(
        { phase: 'desc-miss', srcName: 'ZipRecruiter', key: 'Second missing JD | ld=0 nd=0' },
        { updateActive: false },
      );
      for (let i = 0; i < 40; i++) {
        recordManualScraperTelemetry({ phase: 'page-extract', srcName: 'Google for Jobs', pageNum: i + 1 });
      }
      const scrapeTelemetry = getManualScraperTelemetry();
      assert(!scrapeTelemetry.events.some(e => /First missing JD/.test(e.key || ''))
        && scrapeTelemetry.fieldAnomalies?.some(e => /First missing JD/.test(e.key || '')),
      'dedicated anomaly retention survives after ordinary phases evict the shared 30-event trail');
      const telemetry = getJobsTelemetry();
      const report = buildJobsPipelineSnapshot(
        telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
        telemetry?.windowId ?? null,
        null,
      );
      assert(report.includes('Detail-recovery diagnostics (retained independently of recent phases)')
        && report.includes('First missing JD') && report.includes('Second missing JD'),
      'FULL pipeline diagnostics retain early per-job description misses after later sources advance the phase trail');
      return { ok: true };
  },
},
{
    name: 'job pipeline report: bounded browser card-walk evidence identifies misses, click identities, and cancellation',
    run: () => {
      recordManualScraperTelemetry({
        phase: 'card-walk',
        sourceId: 'google',
        srcName: 'Google for Jobs',
        queryIndex: 1,
        queryTotal: 1,
        pageNum: 1,
        itemTotal: 25,
        attempted: 17,
        expanded: 15,
        missing: 1,
        panelTimeouts: 1,
        selectionMismatches: 1,
        titleBypassed: 96,
        aborted: true,
        interruptedAt: 18,
        abortReason: 'user-cancelled',
        failureSamples: [
          { itemIndex: 7, key: 'Systems Architect at Example', reason: 'card-not-found' },
          { itemIndex: 16, key: 'Principal Systems Architect at Example', reason: 'panel-timeout' },
        ],
        transitionSamples: [
          {
            itemIndex: 1,
            expectedKey: 'google-card-1',
            expectedTitle: 'First Systems Architect',
            hitKey: 'google-card-1',
            hitTitle: 'First Systems Architect',
            physicalIndex: 1,
            physicalTotal: 108,
            selectedTitle: 'First Systems Architect',
            selectionVerified: true,
            lookup: 'primary',
          },
          {
            itemIndex: 2,
            expectedKey: 'google-card-2',
            expectedTitle: 'Second Systems Architect',
            // Exercise the resolved aliases used by the live DOM probe.
            resolvedKey: 'google-card-3',
            resolvedTitle: 'Third Systems Architect',
            physicalIndex: 5,
            physicalTotal: 108,
            skippedSincePrevious: 3,
            selectedTitle: 'Fourth Systems Architect',
            selectionMismatch: true,
            lookup: 'data-share-url',
            mismatch: true,
          },
        ],
      }, { updateActive: false });
      const telemetry = getJobsTelemetry();
      const report = buildJobsPipelineSnapshot(
        telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
        telemetry?.windowId ?? null,
        null,
      );
      assert(report.includes('Browser card traversal (bounded batch summaries)')
        && report.includes('Google for Jobs · q1/1 · p1 · attempted 17/25 · expanded 15/25 · missing-target 1 · panel-timeout 1 · selection-mismatches 1 · title-bypassed 96 (intentional, page-local) · aborted before #18 (user-cancelled)')
        && report.includes('#7 key=Systems Architect at Example reason=card-not-found')
        && report.includes('#16 key=Principal Systems Architect at Example reason=panel-timeout')
        && report.includes('Click transition samples (expected → hit):')
        && report.includes('#1 · physical #1/108 expected key=google-card-1 title=First Systems Architect → hit key=google-card-1 title=First Systems Architect via primary → selected title=First Systems Architect [selection verified]')
        && report.includes('⚠️ #2 · physical #5/108 · 3 physical cards skipped since previous expected key=google-card-2 title=Second Systems Architect → hit key=google-card-3 title=Third Systems Architect via data-share-url [MISMATCH] → selected title=Fourth Systems Architect [SELECTION MISMATCH]'),
      'FULL/CARDWALK diagnostics must preserve physical positions, post-click selection identity, failed positions, and cancellation context, not only a misleading expanded aggregate');
      return { total: 25, attempted: 17, expanded: 15, titleBypassed: 96, selectionMismatches: 1, failures: 2, transitions: 2 };
    },
  },
{
    name: 'Live job-search pipeline telemetry names pending sources before search completion',
    run: () => {
      const telemetry = getJobsTelemetry();
      const priorPipeline = telemetry.pipeline;
      const priorSourceEvents = telemetry.sourceEvents;
      try {
        telemetry.pipeline = {
          phase: 'gathering-sources',
          startedAt: Date.now() - 241_000,
          ts: Date.now() - 2_000,
          active: true,
          pendingSources: ['dice'],
          lastSource: 'ziprecruiter',
        };
        telemetry.sourceEvents = {
          dice: [{ t: 0, status: 'searching', code: null }],
          ziprecruiter: [
            { t: 0, status: 'searching', code: null },
            { t: 60_000, status: 'done', code: 'description-detail-miss' },
          ],
        };
        const report = buildJobsPipelineSnapshot(
          telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
          telemetry?.windowId ?? null,
          null,
        );
        assert(report.includes('Live Search Stage') && report.includes('gathering-sources')
          && report.includes('Pending source(s): `dice`') && report.includes('last progress from `ziprecruiter`'),
        'FULL/JOBS telemetry identifies the live gather stage and the exact source still pending');
        assert(report.includes('`dice`: searching@+0s'),
          'an active searching-only source is retained in the progress trail instead of being filtered as uninteresting');
        return { ok: true };
      } finally {
        telemetry.pipeline = priorPipeline;
        telemetry.sourceEvents = priorSourceEvents;
      }
    },
  },
{
    name: 'formatSourceEvent renders a folded heartbeat span, repeat count, and detail',
    run: () => {
      // Shape emitProgress produces for a paced source: repeated same-status
      // heartbeats folded into the previous trail entry, keeping the ORIGINAL
      // start `t` but gaining `lastT`/`repeats`/`detail` from the newest one.
      const folded = formatSourceEvent({ t: 0, lastT: 188_000, repeats: 15, status: 'searching', detail: 'q3/12 · p2' });
      assert(folded === 'searching@+0s→+188s ×15 (q3/12 · p2)',
        'a folded entry must render its original start, the newest offset as a span, the repeat count, and the newest detail');
      return { folded };
    },
  },
{
    name: 'formatSourceEvent renders an unfolded single entry with no span/repeat/detail suffix',
    run: () => {
      const single = formatSourceEvent({ t: 0, status: 'searching' });
      assert(single === 'searching@+0s',
        'an entry that never folded (no lastT/repeats/detail) must render exactly as status@+Ns with no trailing suffix');
      return { single };
    },
  },
{
    name: 'formatSourceEvent still renders a warning code as ⚠<code>',
    run: () => {
      const warned = formatSourceEvent({ t: 5_000, status: 'error', code: 'description-detail-miss' });
      assert(warned === 'error⚠description-detail-miss@+5s',
        'a carried warning code must render immediately after the status as ⚠<code>, unaffected by the folding change');
      // A folded entry can ALSO carry a warning code (a source that flips to
      // the same warning repeatedly) — the code sits before the span/repeat.
      const foldedWithCode = formatSourceEvent({ t: 5_000, lastT: 65_000, repeats: 4, status: 'error', code: 'description-detail-miss' });
      assert(foldedWithCode === 'error⚠description-detail-miss@+5s→+65s ×4',
        'a folded entry with a warning code must render the code before the span/repeat suffix');
      return { warned, foldedWithCode };
    },
  },
{
    name: 'job pipeline report: Live Search Stage renders a folded pending-source heartbeat',
    run: () => {
      // The real-world case this exists for: a linkedin source mid-walk sends
      // dozens of identical "searching" heartbeats over minutes. Without the
      // fold, only the FIRST @+0s survives the array cap and the report reads
      // as though the source stopped emitting seconds into the run.
      const telemetry = getJobsTelemetry();
      const priorPipeline = telemetry.pipeline;
      const priorSourceEvents = telemetry.sourceEvents;
      try {
        telemetry.pipeline = {
          phase: 'gathering-sources',
          startedAt: Date.now() - 241_000,
          ts: Date.now() - 2_000,
          active: true,
          pendingSources: ['linkedin'],
          lastSource: 'linkedin',
        };
        telemetry.sourceEvents = {
          linkedin: [{ t: 0, lastT: 188_000, repeats: 15, status: 'searching', detail: 'q3/12 · p2' }],
        };
        const report = buildJobsPipelineSnapshot(
          telemetry?.nodeId ? new Set([telemetry.nodeId]) : new Set(),
          telemetry?.windowId ?? null,
          null,
        );
        assert(report.includes('Live Search Stage') && report.includes('Pending source(s): `linkedin`'),
          'FULL/JOBS telemetry still identifies the live gather stage and the pending source');
        assert(report.includes('`linkedin`: searching@+0s→+188s ×15 (q3/12 · p2)'),
          'the Active source progress line must render the folded span, repeat count, and detail — not just the first heartbeat');
      } finally {
        telemetry.pipeline = priorPipeline;
        telemetry.sourceEvents = priorSourceEvents;
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: terminal phases and Glassdoor cache ages are truthful',
    run: () => {
      assert(formatPipelineState({ active: false, phase: 'completed' }) === '✅ complete'
        && formatPipelineState({ active: false, phase: 'aborted' }) === '⏹️ cancelled'
        && formatPipelineState({ active: false, phase: 'source-gather-failed' }) === '❌ failed',
      'an inactive aborted/failed pipeline must not be mislabeled as a successful completion');
      const provenance = formatGlassdoorCacheProvenance({
        country: 'CA', verifiedAt: Date.now() - 65_000,
      });
      assert(/country CA · verified 1m ago/.test(provenance)
        && !provenance.includes('ago ago')
        && !/\d{4,}h/.test(provenance),
      'Glassdoor cache provenance passes an epoch to formatAge and appends no duplicate age suffix');
      return { provenance };
    },
  },
{
    name: 'job pipeline report: Glassdoor Location Cache section is absent with no location skips and an empty cache',
    run: () => {
      // Scrape telemetry is a process-global singleton, so this negative case
      // clears the event ring for the duration of the assertion instead of
      // relying on running before whichever test records a
      // location-resolution-failed event. Order-dependent negatives rot silently
      // the moment a test is inserted above them.
      const telemetry = getJobsTelemetry();
      const scrapeTelemetry = getManualScraperTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search };
      const savedEvents = scrapeTelemetry.events;
      Object.assign(telemetry, {
        nodeId: 'glassdoor-cache-absent-diagnostics',
        windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1 },
      });
      scrapeTelemetry.events = [];
      try {
        const report = buildJobsPipelineSnapshot(new Set(['glassdoor-cache-absent-diagnostics']), null, null);
        assert(!report.includes('### Glassdoor Location Cache'),
          'the Glassdoor Location Cache section must not render when this run had no location skip and the persisted cache is empty');
      } finally {
        Object.assign(telemetry, saved);
        scrapeTelemetry.events = savedEvents;
      }
      return { ok: true };
    },
  },
{
    name: 'job pipeline report: Glassdoor Location Cache section names a skipped location, its failureKind, and cache absence',
    run: () => {
      const telemetry = getJobsTelemetry();
      const saved = { nodeId: telemetry.nodeId, windowId: telemetry.windowId, search: telemetry.search };
      Object.assign(telemetry, {
        nodeId: 'glassdoor-cache-diagnostics',
        windowId: null,
        search: { ts: Date.now(), queries: 1, raw: 1, deduped: 1, ageDropped: 0, historyDropped: 0, kept: 1 },
      });
      recordManualScraperTelemetry({
        phase: 'location-resolution-failed',
        sourceId: 'glassdoor',
        srcName: 'Glassdoor',
        queryIndex: 1,
        queryTotal: 3,
        location: 'Erie, PA',
        reason: 'autocomplete returned no verified exact match',
        failureKind: 'no-match',
        attempts: 2,
      });
      try {
        const report = buildJobsPipelineSnapshot(new Set(['glassdoor-cache-diagnostics']), null, null);
        assert(report.includes('### Glassdoor Location Cache'),
          'a location-resolution-failed scrape event must render the Glassdoor Location Cache section');
        assert(report.includes('Skipped `Glassdoor` for "Erie, PA" (no-match): no cached entry was present'),
          'the section must name the skipped location, its failureKind, and state that no cached entry existed for it');
        const phaseLine = (report.split('\n').find(line => line.includes('location-resolution-failed') && line.includes('Erie, PA')) || '');
        assert(phaseLine.includes('kind=no-match') && phaseLine.includes('reason=autocomplete returned no verified exact match'),
          'the Recent browser-scrape phases line for a location skip must surface kind= and reason=, not just the bare phase name');
      } finally {
        Object.assign(telemetry, saved);
      }
      return { ok: true };
    },
  },
{
    name: 'ZipRecruiter Trakstar detail navigation leaves application mode before extraction',
    run: () => {
      const applyUrl = 'https://xideral.hire.trakstar.com/jobs/fk0zdvb/?apply=true&utm_source=ziprecruiter';
      const normalized = normalizeDetailNavigationUrl(applyUrl);
      const parsed = new URL(normalized);
      assert(!parsed.searchParams.has('apply') && parsed.searchParams.get('utm_source') === 'ziprecruiter',
        'Trakstar application mode is removed while unrelated source attribution remains intact');
      assert(normalizeDetailNavigationUrl('https://boards.greenhouse.io/acme/jobs/123?apply=true')
        === 'https://boards.greenhouse.io/acme/jobs/123?apply=true',
      'application-mode normalization is host-specific and cannot alter another ATS');
      assert(normalizeDetailNavigationUrl('/jobs/fk0zdvb/?apply=true') === '/jobs/fk0zdvb/?apply=true',
        'relative or malformed source URLs remain unchanged for the normal navigation error path');
      return { normalized };
    },
  },
{
    name: 'ZipRecruiter detail enrichment reads external application pages without form automation and bounds 429 retry waits',
    run: () => {
      assert(shouldNavigateForDescription('ziprecruiter', 'https://www.ziprecruiter.com/jobs/acme/platform-architect?lvk=abc'),
        'a ZipRecruiter /jobs detail page remains eligible for read-only enrichment');
      assert(shouldNavigateForDescription('ziprecruiter', 'https://www.ziprecruiter.com/c/Actalent/Job/Principal-Systems-Engineer/-in-Kanata,ON?jid=abc'),
        'a legacy ZipRecruiter /c/<company>/Job/<title> detail page remains eligible for read-only enrichment');
      assert(shouldNavigateForDescription('ziprecruiter', 'https://lbg.wd3.myworkdayjobs.com/lbg_Careers/job/Architect_123/apply?utm_source=ziprecruiter'),
        'an employer Workday page is eligible for one read-only text extraction without clicking its form');
      assert(shouldNavigateForDescription('ziprecruiter', 'https://xideral.hire.trakstar.com/jobs/fk0ziuq/?apply=true&utm_source=ziprecruiter'),
        'an external Trakstar page is eligible for one read-only text extraction without clicking its form');
      assert(!shouldNavigateForDescription('ziprecruiter', 'file:///Users/example/job.html'),
        'only ordinary HTTP(S) detail URLs are eligible for external-page enrichment');
      assert(shouldNavigateForDescription('glassdoor', 'https://example.com/apply'),
        'the ZipRecruiter ownership guard cannot change another source\'s navigation policy');
      assert(isUnavailableDetailPage({ isNotFound: true })
        && isUnavailableDetailPage({ workdayPostingAvailable: false })
        && !isUnavailableDetailPage({ workdayPostingAvailable: true })
        && !isUnavailableDetailPage({}),
      'an HTTP-200 Workday bootstrap marked postingAvailable=false is treated as a closed listing, while an ordinary available/unknown page remains eligible for recovery');
      assert(zipRecruiterRetryAfterMs('120') === 60_000
        && zipRecruiterRetryAfterMs('', 0) === 45_000
        && zipRecruiterRetryAfterMs('invalid', 0) === 45_000
        && zipRecruiterRetryAfterMs('0') === 1_000,
      'Retry-After handling respects server waits where practical, has a safe fallback, and never spins immediately');
      return { externalApplySkipped: true, retryWaitCappedMs: zipRecruiterRetryAfterMs('120') };
    },
  },
{
    name: 'ZipRecruiter detail merge: a description miss still retains the detail-page posted date',
    run: () => {
      // ZR's live trigger is still telemetry-led, but the mechanism is known:
      // description failure and date recovery are independent. Do not require a
      // description/salary before writing the recovered date back to the card.
      const listCard = {
        title: 'Patient Representative II',
        company: 'Acme Health',
        location: 'Toronto, ON',
        url: 'https://www.ziprecruiter.com/jobs/example',
        salary: '$29/hr',
        snippet: 'Search-result summary survives a detail description miss.',
        posted: '',
      };
      const merged = mergeExpandedJobDetail(listCard, {
        text: '',
        jsonLdDate: '2026-08-10',
        jsonLdSalary: '',
        salaryChanged: false,
      });
      assert(merged.posted === '2026-08-10',
        'a recovered date must be written even when description and salary both miss');
      assert(merged.snippet === listCard.snippet && merged.title === listCard.title && merged.salary === listCard.salary,
        'a partial detail update preserves list-card snippet and all unrelated fields');

      const emptyListDescription = mergeExpandedJobDetail(
        { ...listCard, snippet: '', posted: '' },
        { text: '', jsonLdDate: '2026-08-10', jsonLdSalary: '', salaryChanged: false },
      );
      assert(Object.hasOwn(emptyListDescription, 'snippet') && emptyListDescription.snippet === '',
        'a bounded detail-description miss retains a listing with an explicitly empty description');
      assert(emptyListDescription.url === listCard.url && emptyListDescription.title === listCard.title,
        'an empty detail description cannot discard or mutate the ZipRecruiter list row');
      assert(emptyListDescription.posted === '2026-08-10',
        'an empty description still permits independent detail fields such as datePosted');

      const existingDate = mergeExpandedJobDetail({ ...listCard, posted: '3 days ago' }, {
        text: '', jsonLdDate: '2026-08-10', jsonLdSalary: '', salaryChanged: false,
      });
      assert(existingDate.posted === '3 days ago',
        'detail ISO dates do not clobber an existing list-card relative date');
      const repairedSalary = mergeExpandedJobDetail({ ...listCard, salary: 'US$19 - US$20 (Employer provided)' }, {
        jsonLdSalary: '$19/hr', salaryChanged: false,
      });
      assert(repairedSalary.salary === '$19/hr',
        'authoritative structured detail pay repairs a present but unparseable list salary');
      const healthySalary = mergeExpandedJobDetail({ ...listCard, salary: '$29/hr' }, {
        jsonLdSalary: '$19/hr', salaryChanged: false,
      });
      assert(healthySalary.salary === '$29/hr',
        'structured detail pay does not clobber an already-parseable list salary');
      const filledCompany = mergeExpandedJobDetail({ ...listCard, company: '   ' }, {
        jsonLdCompany: '  Detail-page employer  ',
      });
      assert(filledCompany.company === 'Detail-page employer',
        'structured detail company fills a blank list-card company and is normalized');
      const preservedCompany = mergeExpandedJobDetail(listCard, {
        jsonLdCompany: 'Different detail-page employer',
      });
      assert(preservedCompany.company === 'Acme Health',
        'structured detail company does not clobber a usable list-card company');
      const blankDetailCompany = mergeExpandedJobDetail({ ...listCard, company: '   ' }, {
        jsonLdCompany: '   ',
      });
      assert(blankDetailCompany.company === '   ',
        'blank structured company data does not replace an equally blank list-card field');
      return { posted: merged.posted, preserved: true };
    },
  },
{
    name: 'Job tree: fully collapsed at analysis end (no auto-expand)',
    run: () => {
      const mk = (title, score, url) => ({
        title, company: 'Acme', location: 'Remote', salary: '$120k', snippet: 'x',
        matchScore: score, reasoning: 'r', careerDirection: 'x',
        source: 'lever', url, posted: 'today',
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
      const excellent = bands.find(b => b.data.label.startsWith('Excellent'));
      const possible = bands.find(b => b.data.label.startsWith('Possible'));
      // Nothing is expanded — the whole tree is closed when analysis ends.
      assert(result.newNodes.every(n => !n.data?.expanded), 'collapsed: no node should be expanded');
      // Band roots are visible (collapsed pills); everything below is hidden.
      assert(bands.every(b => b.hidden === false), 'collapsed: band roots should be visible');
      assert(nonBandGroups.every(g => g.hidden === true), 'collapsed: salary/role groups should be hidden');
      assert(cards.every(c => c.hidden === true), 'collapsed: all cards should be hidden');
      // Bands still ordered best-first and stacked (layout pass runs regardless).
      assert(excellent.position.y < possible.position.y, 'collapsed: Excellent band should still sit above Possible');
      return { ok: true };
    },
  },
{
    name: 'Job Board: unionScoredJobs dedups by identity, keeps higher score',
    run: () => {
      const a = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 60, originHubId: 'A' },
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 80, originHubId: 'A' },
      ];
      const b = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 90, originHubId: 'B' }, // dup of a[0], higher
        { title: 'Designer', company: 'Gamma', url: '', matchScore: 50, originHubId: 'B' },
        { title: 'designer', company: 'gamma', url: '', matchScore: 70, originHubId: 'B' }, // dup by title|company (no url)
      ];
      const out = unionScoredJobs([a, b]);
      assert(out.length === 3, `union: expected 3 unique, got ${out.length}`);
      const eng = out.find(j => j.url === 'https://j/1');
      assert(eng.matchScore === 90, `union: higher score should win (got ${eng.matchScore})`);
      assert(eng.originHubId === 'B', 'union: winning copy carries its own origin module id');
      // First-seen order preserved: Eng (a[0]), PM, Designer.
      assert(out[0].url === 'https://j/1' && out[1].url === 'https://j/2', 'union: first-seen order preserved');
      const designer = out.find(j => j.company.toLowerCase() === 'gamma');
      assert(designer.matchScore === 70, 'union: title|company dedup keeps higher score when url missing');
      return { unique: out.length };
    },
  },
{
    name: 'Job Board: unionScoredJobs reports merge stats via out-param',
    run: () => {
      const a = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 60 },
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 80 },
      ];
      const b = [
        { title: 'Eng', company: 'Acme', url: 'https://j/1', matchScore: 90 }, // dup, higher → upgrade
        { title: 'PM', company: 'Beta', url: 'https://j/2', matchScore: 50 },  // dup, lower → no upgrade
        { title: 'New', company: 'Gamma', url: 'https://j/3', matchScore: 70 },
      ];
      const stats = {};
      const out = unionScoredJobs([a, b], stats);
      assert(out.length === 3, `stats: expected 3 unique, got ${out.length}`);
      assert(stats.totalIncoming === 5, `stats: totalIncoming should be 5 (got ${stats.totalIncoming})`);
      assert(stats.unique === 3, `stats: unique should be 3 (got ${stats.unique})`);
      assert(stats.duplicatesRemoved === 2, `stats: duplicatesRemoved should be 2 (got ${stats.duplicatesRemoved})`);
      assert(stats.collisions === 2, `stats: collisions should be 2 (got ${stats.collisions})`);
      assert(stats.collisionUpgrades === 1, `stats: only the higher-score collision upgrades (got ${stats.collisionUpgrades})`);
      // Stats path must not alter the returned union vs. the no-stats call.
      assert(unionScoredJobs([a, b]).length === out.length, 'stats: out-param does not change the result');
      return stats;
    },
  },
{
    name: 'Job Board: unionScoredJobs tolerates empty / non-array inputs',
    run: () => {
      assert(unionScoredJobs([]).length === 0, 'union: empty → empty');
      assert(unionScoredJobs(null).length === 0, 'union: null → empty');
      const out = unionScoredJobs([null, undefined, [{ title: 'x', company: 'y', url: 'u', matchScore: 1 }]]);
      assert(out.length === 1, 'union: skips non-array entries');
      return { ok: true };
    },
  },
{
    name: 'Job Board: moduleFingerprint catches re-runs the old count+sum format missed',
    run: () => {
      const a = [{ matchScore: 90, title: 'Eng' }, { matchScore: 80, title: 'PM' }];
      assert(moduleFingerprint(a) === moduleFingerprint([{ matchScore: 90, title: 'Eng' }, { matchScore: 80, title: 'PM' }]),
        'fingerprint: identical data → same fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90, title: 'Eng' }]),
        'fingerprint: fewer jobs → different fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90, title: 'Eng' }, { matchScore: 81, title: 'PM' }]),
        'fingerprint: re-scored (same count, different score) → different fp');
      // Regression: the old count+score-sum fingerprint was blind to BOTH of
      // these, silently leaving the board un-stale after a real re-run.
      assert(moduleFingerprint([{ matchScore: 80, title: 'Eng' }, { matchScore: 90, title: 'PM' }])
          !== moduleFingerprint([{ matchScore: 85, title: 'Eng' }, { matchScore: 85, title: 'PM' }]),
        'fingerprint: equal-sum rescore ([80,90] vs [85,85]) → different fp');
      assert(moduleFingerprint(a) !== moduleFingerprint([{ matchScore: 90, title: 'Lead' }, { matchScore: 80, title: 'PM' }]),
        'fingerprint: same scores, different jobs → different fp');
      assert(moduleFingerprint([{ matchScore: 90, title: 'Manager A', url: 'https://jobs/old', source: 'indeed' }])
          !== moduleFingerprint([{ matchScore: 90, title: 'Manager B', url: 'https://jobs/new', source: 'linkedin' }]),
        'fingerprint: same score/title initial/title length but different job identity → different fp');
      assert(moduleFingerprint([{ matchScore: 90, title: 'Manager A', url: 'https://jobs/old', reasoning: 'old reason' }])
          !== moduleFingerprint([{ matchScore: 90, title: 'Manager A', url: 'https://jobs/old', reasoning: 'new reason' }]),
        'fingerprint: card-visible reasoning changes invalidate a board');
      assert(moduleFingerprint(null).startsWith('3:0:'), 'fingerprint: nullish → v3 empty fingerprint');
      // Legacy detection: pre-versioned signatures adopt-as-baseline, not stale.
      assert(isLegacyCombineSignature('hub-1=5.10|hub-2=3.7'), 'legacy count.sum signature detected');
      assert(isLegacyCombineSignature('hub-1=2:1:123'), 'v2 fingerprints adopt as a safe v3 baseline');
      assert(!isLegacyCombineSignature(combineSignature([{ id: 'A', fingerprint: moduleFingerprint(a) }])),
        'current-format signature is not legacy');
      assert(!isLegacyCombineSignature('') && !isLegacyCombineSignature(null),
        'empty/null signature is not legacy (handled by the null-adopt path)');
      return { ok: true };
    },
  },
{
    name: 'Job Board: deriveBoardCardStats reconciles dismissed cards and clamps filters',
    run: () => {
      const nodes = [
        { id: 'board', type: 'jobboard', data: {} },
        { id: 'a', type: 'jobcard', data: { hubId: 'board', source: 'indeed', matchScore: 82 } },
        { id: 'b', type: 'jobcard', data: { hubId: 'board', source: 'linkedin', matchScore: 90 } },
        { id: 'other', type: 'jobcard', data: { hubId: 'other-board', source: 'indeed', matchScore: 100 } },
      ];
      const afterDismiss = deriveBoardCardStats(nodes.filter(n => n.id !== 'b'), 'board', {
        scoreThreshold: 90,
        sourceFilter: 'linkedin',
      });
      assert(afterDismiss.resultCount === 1, 'board stats: only live board-owned cards count');
      assert(JSON.stringify(afterDismiss.finalSourceCounts) === JSON.stringify({ indeed: 1 }), 'board stats: source counts remove dismissed card');
      assert(afterDismiss.scoreRangeMin === 82 && afterDismiss.scoreRangeMax === 82, 'board stats: score range follows live cards');
      assert(afterDismiss.scoreThreshold === 82, 'board stats: out-of-range active threshold clamps to remaining score');
      assert(afterDismiss.sourceFilter === null, 'board stats: dismissed active source filter clears');
      const empty = deriveBoardCardStats([], 'board', { scoreThreshold: 80, sourceFilter: 'indeed' });
      assert(empty.resultCount === 0 && empty.scoreRangeMin === 0 && empty.scoreRangeMax === 100 && empty.scoreThreshold === 0,
        'board stats: empty board returns stable default score bounds');
      return { ok: true };
    },
  },
{
    name: 'Job Board: combineSignature is order-independent over modules',
    run: () => {
      const m1 = { id: 'A', fingerprint: '5.10' };
      const m2 = { id: 'B', fingerprint: '3.7' };
      assert(combineSignature([m1, m2]) === combineSignature([m2, m1]),
        'signature: connection order does not matter');
      assert(combineSignature([m1]) !== combineSignature([m1, m2]),
        'signature: dropping a module changes it');
      assert(combineSignature([m1, m2]) !== combineSignature([m1, { id: 'B', fingerprint: '4.8' }]),
        'signature: a module whose data changed changes it');
      assert(combineSignature([]) === '', 'signature: empty → ""');
      return { ok: true };
    },
  },
{
    name: 'Job Board: staleReason diffs last-combine signature vs. live modules',
    run: () => {
      const prev = combineSignature([{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }]);
      // B disconnected:
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }]) === '1 disconnected',
        'reason: a removed connection');
      // B is still wired but is searching, so it temporarily leaves the
      // terminal signature. That is a refresh, never a disconnection.
      assert(staleReason(
        prev,
        [{ id: 'A', fingerprint: '5.10' }],
        [{ id: 'A', hubState: 'done' }, { id: 'B', hubState: 'searching' }],
      ) === '1 updating',
      'reason: a connected non-terminal module is updating, not disconnected');
      // B re-ran (data changed):
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '4.9' }]) === '1 updated',
        'reason: a connection whose data changed');
      // C newly added:
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }, { id: 'C', fingerprint: '2.2' }]) === '1 added',
        'reason: a new connection');
      // Identical → no drift (caller wouldn't show it, but the function stays honest):
      assert(staleReason(prev, [{ id: 'A', fingerprint: '5.10' }, { id: 'B', fingerprint: '3.7' }]) === 'connections changed',
        'reason: no diff → generic fallback');
      // Combined change:
      assert(staleReason(prev, [{ id: 'B', fingerprint: '9.9' }, { id: 'C', fingerprint: '1.1' }]) === '1 disconnected · 1 added · 1 updated',
        'reason: disconnected + added + updated together');
      return { ok: true };
  },
},
{
    name: 'Job Board: terminal zero-result source remains an updated input and can replace stale results',
    run: () => {
      const previousJobs = [{ title: 'Architect', company: 'Acme', url: 'https://jobs/acme', matchScore: 90 }];
      const previous = combineSignature([{ id: 'search-a', fingerprint: moduleFingerprint(previousJobs) }]);
      const completedZero = [{ id: 'search-a', fingerprint: moduleFingerprint([]) }];
      assert(combineSignature(completedZero) !== '',
        'zero-result terminal module stays in the board signature instead of vanishing as a disconnect');
      assert(staleReason(previous, completedZero) === '1 updated',
        'zero-result terminal module is reported as updated, not disconnected');

      // The component-level transition clears the prior cascade only after the
      // user explicitly accepts its empty terminal input. Lock that wiring in
      // place without adding a heavyweight ReactFlow DOM harness.
      const boardSource = fs.readFileSync(path.resolve('src/nodes/JobBoardNode.jsx'), 'utf8');
      const doneStateSource = fs.readFileSync(path.resolve('src/nodes/jobboard/JobBoardDoneState.jsx'), 'utf8');
      const bugReportSource = fs.readFileSync(path.resolve('electron/ipc/bugReport.js'), 'utf8');
      const jobSearchSource = fs.readFileSync(path.resolve('src/nodes/JobSearchNode.jsx'), 'utf8');
      assert(boardSource.includes('const completedModules = useMemo')
        && boardSource.includes('() => combineSignature(completedModules)')
        && boardSource.includes('const allConnectedModulesDone =')
        && boardSource.includes('staleReason(data.combineSignature, completedModules, connectedModules)')
        && boardSource.includes('if (nextStale) hideBoardChildren()')
        && boardSource.includes('replaced stale results with empty completed inputs')
        && boardSource.includes('const cancelled = epoch.start()')
        && boardSource.includes('if (cancelled() || !getNode(id))')
        && boardSource.includes('cancelNodeTask?.(id)')
        && boardSource.includes('combine cancelled before spawn'),
      'board tracks terminal zero-result modules, accurately labels connected refreshes, reconciles stale children, and has an explicit empty replacement path');
      assert(doneStateSource.includes('canReplaceWithEmpty') && doneStateSource.includes('Clear stale results') && doneStateSource.includes('Inputs changed'),
        'stale zero-result boards expose a truthful action rather than a dead Re-combine button');
      assert(bugReportSource.includes('staleReason:') && bugReportSource.includes('combineSignature:'),
        'FULL node diagnostics preserve board stale reason and signature evidence');
      const terminalZeroStart = jobSearchSource.indexOf('if (foundJobs.length === 0)');
      const terminalZeroEnd = jobSearchSource.indexOf('return true;', terminalZeroStart);
      assert(terminalZeroStart >= 0 && terminalZeroEnd > terminalZeroStart
        && /jobCount:\s*0/.test(jobSearchSource.slice(terminalZeroStart, terminalZeroEnd)),
      'terminal empty job searches clear stale jobCount instead of retaining the prior result total');
      return { reason: staleReason(previous, completedZero), zeroSignature: combineSignature(completedZero) };
    },
  },
{
    name: 'computeJobTreeView: filter removes non-matching cards + empty branches (not dim)',
    run: () => {
      // Two bands: A (Excellent, scores 90/88) and B (Long shot, score 20).
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'A',   type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', label: 'Excellent', childIds: ['A-S'], expanded: false } },
        { id: 'A-S', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', label: '$100k+', childIds: ['A-R'], expanded: false } },
        { id: 'A-R', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: ['a1', 'a2'], expanded: false, visibleCount: 10 } },
        { id: 'a1',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'a2',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 88, source: 'dice' } },
        { id: 'B',   type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', label: 'Long shot', childIds: ['B-S'], expanded: false } },
        { id: 'B-S', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', label: 'Under', childIds: ['B-R'], expanded: false } },
        { id: 'B-R', type: 'jobgroup', hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', label: 'Eng', childIds: ['b1'], expanded: false, visibleCount: 10 } },
        { id: 'b1',  type: 'jobcard',  hidden: true,  position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 20, source: 'indeed' } },
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;

      // No filter on the spawned/collapsed tree → no change (same ref).
      const base = tree();
      assert(computeJobTreeView(base, 'hub', {}) === base, 'no-filter on collapsed tree is a same-ref no-op');

      // Filter ≥85 (collapsed): empty band B removed; matching band A stays visible.
      const f85 = computeJobTreeView(tree(), 'hub', { scoreThreshold: 85 });
      assert(hiddenOf(f85, 'A') === false, 'filter: band with matches stays visible');
      assert(hiddenOf(f85, 'B') === true, 'filter: empty band REMOVED (hidden), not dimmed');

      // Expand A fully under ≥89 → only a1 (90) shows; a2 (88) removed; branch stays.
      const expanded = tree().map(n =>
        ['A', 'A-S', 'A-R'].includes(n.id) ? { ...n, data: { ...n.data, expanded: true } } : n);
      const f89 = computeJobTreeView(expanded, 'hub', { scoreThreshold: 89 });
      assert(hiddenOf(f89, 'a1') === false, 'filter+expand: matching card visible');
      assert(hiddenOf(f89, 'a2') === true, 'filter+expand: non-matching card REMOVED');
      assert(hiddenOf(f89, 'A-R') === false && hiddenOf(f89, 'B') === true, 'filter+expand: branch with a match kept, empty band gone');

      // Filter above every score → whole tree removed.
      const f99 = computeJobTreeView(tree(), 'hub', { scoreThreshold: 99 });
      assert(['A', 'A-S', 'A-R', 'a1', 'a2', 'B', 'b1'].every(id => hiddenOf(f99, id)), 'filter above max removes everything');

      // Source filter: only dice → a2 stays, a1 (lever) + b1 (indeed) removed.
      const expandedSrc = computeJobTreeView(expanded, 'hub', { sourceFilter: 'dice' });
      assert(hiddenOf(expandedSrc, 'a2') === false && hiddenOf(expandedSrc, 'a1') === true, 'source filter keeps only matching source');
      return { ok: true };
    },
  },
{
    name: 'computeJobTreeView: flat-spawn fallback (no jobgroups) — cards survive filter/restore',
    run: () => {
      // Bucketing failed → flat spawn: jobcards wired straight to the hub, NO groups.
      // Regression: previously computeJobTreeView only seeded `visible` by walking
      // jobgroups, so a flat board had an empty visible set and ALL cards were hidden
      // on any filter/restore (blank board with a non-zero header count).
      const tree = () => ([
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'c1', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'c2', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 60, source: 'dice' } },
      ]);
      const hiddenOf = (out, id) => !!out.find(n => n.id === id)?.hidden;
      const f0 = computeJobTreeView(tree(), 'hub', {});
      assert(hiddenOf(f0, 'c1') === false && hiddenOf(f0, 'c2') === false, 'flat: no-filter keeps all cards visible');
      const fLow = computeJobTreeView(tree(), 'hub', { scoreThreshold: 50 });
      assert(hiddenOf(fLow, 'c1') === false && hiddenOf(fLow, 'c2') === false, 'flat: threshold below all keeps both');
      const fMid = computeJobTreeView(tree(), 'hub', { scoreThreshold: 80 });
      assert(hiddenOf(fMid, 'c1') === false && hiddenOf(fMid, 'c2') === true, 'flat: threshold removes only sub-threshold card');
      const fHigh = computeJobTreeView(tree(), 'hub', { scoreThreshold: 95 });
      assert(hiddenOf(fHigh, 'c1') === true && hiddenOf(fHigh, 'c2') === true, 'flat: threshold above all hides both');
      const fSrc = computeJobTreeView(tree(), 'hub', { sourceFilter: 'dice' });
      assert(hiddenOf(fSrc, 'c2') === false && hiddenOf(fSrc, 'c1') === true, 'flat: source filter keeps only matching source');
      return { ok: true };
    },
  },
{
    name: 'computeJobTreeView: forced measured-card reflow tightens a collapse/re-expand stale height without initial churn',
    run: () => {
      // A card's reasoning disclosure is local component state. Collapsing its
      // role unmounts it; when re-expanded, it resets closed even though React
      // Flow can still hold the old expanded 308px measurement until its next
      // ResizeObserver pass reports 210px. The old fast path skipped layout when
      // visibility was unchanged, leaving the next root positioned for 308px.
      const tree = (height) => [
        { id: 'hub', type: 'jobboard', position: { x: 0, y: 0 }, data: {} },
        { id: 'A', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['R'], expanded: true } },
        { id: 'R', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['card'], expanded: true, visibleCount: 10 } },
        { id: 'card', type: 'jobcard', hidden: false, position: { x: 0, y: 0 }, measured: { width: 280, height }, data: { hubId: 'hub', matchScore: 90, source: 'lever' } },
        { id: 'B', type: 'jobgroup', hidden: false, position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['bcard'], expanded: false } },
        { id: 'bcard', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub', matchScore: 80, source: 'lever' } },
      ];
      const stale = computeJobTreeView(tree(308), 'hub', {}, COL_X, true);
      const staleB = stale.find(n => n.id === 'B')?.position?.y;
      const tightened = computeJobTreeView(
        stale.map(n => n.id === 'card' ? { ...n, measured: { ...n.measured, height: 210 } } : n),
        'hub', {}, COL_X, true,
      );
      const tightB = tightened.find(n => n.id === 'B')?.position?.y;
      assert(staleB === 348 && tightB === 280,
        `measured reflow: downstream root must tighten from 348 to 280 after 308→210 (got ${staleB}→${tightB})`);
      // The ordinary path preserves its no-op fast path for a freshly measured
      // cascade, so initial N-card measurements don't enqueue reflows.
      const initial = tree(210);
      assert(computeJobTreeView(initial, 'hub', {}) === initial,
        'measured reflow: ordinary initial tree remains a same-ref no-op');
      return { staleB, tightB };
    },
  },
{
    name: 'Job tree layout positions',
    run: () => {
      // Windowing is owned by `hidden` (computeJobTreeView): the layout walks
      // every child and skips hidden ones — job-2 is the beyond-window card.
      const nodes = [
        { id: 'hub', type: 'jobhub', position: { x: 10, y: 20 }, data: {} },
        { id: 'L', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'likelihood', childIds: ['S'], expanded: true } },
        { id: 'S', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'salary', childIds: ['R'], expanded: true } },
        { id: 'R', type: 'jobgroup', position: { x: 0, y: 0 }, data: { hubId: 'hub', kind: 'role', childIds: ['job-1', 'job-2'], expanded: true, visibleCount: 1 } },
        { id: 'job-1', type: 'jobcard', position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
        { id: 'job-2', type: 'jobcard', hidden: true, position: { x: 0, y: 0 }, data: { hubId: 'hub' } },
      ];
      const positions = computeLayoutPositions(nodes, 'hub', COL_X, { x: 10, y: 20 });
      assert(positions.L?.x === 10 + COL_X.likelihood && positions.L?.y === 20, 'layout: likelihood position mismatch');
      assert(positions.S?.x === 10 + COL_X.salary && positions.S?.y === 20, 'layout: salary position mismatch');
      assert(positions.R?.x === 10 + COL_X.role && positions.R?.y === 20, 'layout: role position mismatch');
      assert(positions['job-1']?.x === 10 + COL_X.job && positions['job-1']?.y === 20, 'layout: visible job position mismatch');
      assert(!positions['job-2'], 'layout: hidden card takes no space and gets no position');
      return positions;
    },
  },
{
    name: 'Application: résumé document scaffold',
    run: () => {
      // buildResumeDocument now INLINES the design-system CSS into one <style>
      // block (design doc §5.2) instead of emitting <link> tags pointing at
      // files copied next to the HTML — that whole temp-dir-of-siblings setup
      // is exactly what HTML-first retires, so the doc must be openable with
      // zero sibling assets.
      const doc = buildResumeDocument({ resumeMainHtml: '<main class="page" data-print="ink-only" data-mono data-page="a4" data-density="compact"><h1 class="name">Jane</h1></main>' });
      assert(/^<!doctype html>/i.test(doc.trim()), 'resume doc: missing doctype');
      assert(!doc.includes('<link rel="stylesheet"'), 'resume doc: design CSS must stay inline in the single-file workspace');
      assert((doc.match(/<style>/g) || []).length === 1, 'resume doc: exactly one inlined <style> block');
      // Content proof the two design-system files were actually inlined, not
      // just an empty <style> tag — .resume-header/.name come from resume.css,
      // --ff-display from colors_and_type.css.
      assert(doc.includes('.resume-header') && doc.includes('.name'), 'resume doc: resume.css was not inlined');
      assert(doc.includes('--ff-display'), 'resume doc: colors_and_type.css was not inlined');
      assert(doc.includes('data-print="ink-only"') && doc.includes('Jane'), 'resume doc: lost the <main> block');
      const renderedMain = doc.split('</style>').pop().match(/<main\b[^>]*>/i)?.[0] || '';
      assert(!/\sdata-(?:print|mono|page|density)\b/i.test(renderedMain), 'resume doc: root variants must not be shadowed by model-level main attributes');
      // A model that mistakenly returns a full fenced document is normalized to
      // one résumé <main> plus the application workspace's cover-letter panel.
      // Counted only AFTER the inlined
      // <style> block — colors_and_type.css's own comments literally contain
      // the text "<main class=\"page\" …>" as documentation of where a variant
      // attribute may be placed, which would otherwise inflate this count now
      // that the CSS lives in the same document (see the cover-letter test's
      // `body` split for the same hazard).
      const fenced = buildResumeDocument({ resumeMainHtml: '```html\n<html><body><main class="page">X</main></body></html>\n```' });
      const fencedBody = fenced.split('</style>').pop();
      const mainCount = (fencedBody.match(/<main/gi) || []).length;
      assert(mainCount === 2 && fencedBody.includes('>X</main>'), 'resume doc: should extract one résumé main from a fenced full doc and add one cover panel');
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
      assert(extractVariantAttrs("<main class='page' data-print='ink-only' data-page='a4' data-density='compact'>") === 'data-print="ink-only" data-page="a4" data-density="compact"', 'variant: single-quoted model attributes are preserved');
      // isDualMode gates the OCG cream post-process.
      assert(isDualMode('data-print="dual-pdf"') === true, 'isDualMode: dual-pdf → true');
      assert(isDualMode('data-print="ink-only" data-mono') === false, 'isDualMode: ink-only → false');
      return { ok: true };
    },
  },
{
    // A BUILT document carries its variant on <html> and has it stripped off
    // <main> (stripMainVariantAttrs), so nothing usable is left on the tag the
    // model originally wrote it to. Worse, the design-system CSS this builder
    // inlines documents its own variants with literal `<main class="page"
    // data-print="…">` examples inside CSS COMMENTS — so a scan for the first
    // `<main …>` in a built document lands on a decoy from a stylesheet
    // comment, not on the résumé at all. applicationSync.js re-reads exactly
    // such a document to decide whether to apply the OCG cream layer; reading
    // anything but the root resolved every saved application to the dual-pdf
    // default and stacked cream behind an ink-only page's own opaque white
    // fill, shipping a résumé that matched neither variant.
    name: 'Application: variant attrs are read from a built document’s <html> root, not a <main> decoy',
    run: () => {
      const builtDoc = (attrs) => buildResumeDocument({
        resumeMainHtml: `<main class="page" ${attrs}><h1 class="name">Jane</h1></main>`,
        docId: 'variant-roundtrip',
      });
      const resumePanelMain = (doc) => /<section[^>]*data-ic-document-panel="resume"[^>]*>\s*(<main\b[^>]*>)/i.exec(doc)?.[1] || '';

      for (const [attrs, expected] of [
        ['data-print="ink-only"', 'data-print="ink-only"'],
        ['data-print="ink-only" data-mono data-page="a4"', 'data-print="ink-only" data-mono data-page="a4"'],
        ['data-print="dual-pdf" data-density="compact"', 'data-print="dual-pdf" data-density="compact"'],
        ['', 'data-print="dual-pdf"'],
      ]) {
        const doc = builtDoc(attrs);
        assert(doc.includes(`<html lang="en" ${expected}>`), `built document must hoist "${expected}" onto <html>`);
        const panelMain = resumePanelMain(doc);
        assert(panelMain && !/\sdata-(?:print|mono|page|density)/i.test(panelMain), `built document must strip variant attrs off the résumé <main> (got ${panelMain})`);
        // The round trip: what the builder wrote is what a re-read resolves.
        assert(extractVariantAttrs(doc) === expected, `re-reading a built document must yield "${expected}", not the dual-pdf default`);
      }
      // The decoy is real, not hypothetical: the first <main …> in a built
      // document is a stylesheet-comment example, never the résumé's own tag.
      const inkDoc = builtDoc('data-print="ink-only"');
      assert(/<main\b[^>]*>/i.exec(inkDoc)?.[0] !== resumePanelMain(inkDoc), 'the first <main> in a built document is expected to be a stylesheet-comment decoy');

      // The OCG gate — the actual consumer, and the thing that was inverted.
      assert(isDualMode(extractVariantAttrs(builtDoc('data-print="ink-only"'))) === false, 'a saved ink-only application must NOT be re-read as dual (no OCG cream layer)');
      assert(isDualMode(extractVariantAttrs(builtDoc('data-print="dual-pdf"'))) === true, 'a saved dual-pdf application must still be re-read as dual');

      // The cover letter is a separate built document on the same rule.
      const coverDoc = buildCoverLetterDocument({ letter: { salutation: 'Dear team,', paragraphs: ['Hi.'] }, variantAttrs: 'data-print="ink-only" data-mono', docId: 'variant-cover' });
      assert(extractVariantAttrs(coverDoc) === 'data-print="ink-only" data-mono', 'cover letter: re-reading a built document must yield its own variant');

      // A bare <main> block (the résumé model's raw output) still wins when no
      // root carries a variant — the generate path must be unaffected.
      assert(extractVariantAttrs('<html lang="en"><body><main class="page" data-print="ink-only"></main></body></html>') === 'data-print="ink-only"', 'a variant-less <html> must fall through to <main>');
      return { ok: true };
    },
  },
{
    // extractVariantAttrs used to recognize only data-print/data-mono/
    // data-page and silently DROP data-density — the fit loop's one lever
    // (jobApplication.js's renderResumeWithFit) was structurally unreachable.
    name: 'Application: extractVariantAttrs carries data-density (was silently dropped) and the caller can force it',
    run: () => {
      // No density anywhere → absent, not a false "compact".
      assert(extractVariantAttrs('<main class="page" data-print="ink-only">') === 'data-print="ink-only"', 'no density: attribute absent entirely');
      // The model emitted it on its own (defensive recognition, not the normal
      // path — the model is never instructed to set this).
      assert(extractVariantAttrs('<main class="page" data-density="compact">') === 'data-print="dual-pdf" data-density="compact"', 'density read from the model markup when present');
      // The fit loop forcing it ON, regardless of what the markup says.
      assert(extractVariantAttrs('<main class="page">', { density: 'compact' }) === 'data-print="dual-pdf" data-density="compact"', 'caller-forced density: compact wins over absent markup');
      assert(extractVariantAttrs('<main class="page" data-density="compact">', { density: null }) === 'data-print="dual-pdf"', 'caller-forced density: null wins over a model-emitted compact (fit loop resetting to the un-compact state)');
      // Composes with the other variants, per SKILL.md's "pairs cleanly with" note.
      assert(extractVariantAttrs('<main class="page" data-print="ink-only" data-mono data-page="a4">', { density: 'compact' }) === 'data-print="ink-only" data-mono data-page="a4" data-density="compact"', 'density composes with ink-only + mono + a4');
      return { ok: true };
    },
  },
{
    name: 'Application: target page count heuristic (SKILL.md §5 — "1 for IC roles up to staff, 2 for principal+")',
    run: () => {
      assert(targetPageCountForJob('Senior Software Engineer') === 1, 'senior IC → 1 page');
      assert(targetPageCountForJob('Staff Software Engineer') === 1, 'bare "staff" is still an IC role under SKILL.md — 1 page, NOT 2');
      assert(targetPageCountForJob('Software Engineer, Staff+') === 2, '"Staff+" (literal plus) is the ladder shorthand for staff-and-above → 2 pages');
      assert(targetPageCountForJob('Senior Staff Engineer') === 2, 'senior staff is above the Staff ceiling → 2 pages');
      assert(targetPageCountForJob('Sr. Staff Engineer') === 2, 'abbreviated senior staff is above the Staff ceiling → 2 pages');
      assert(targetPageCountForJob('Principal Engineer') === 2, 'principal → 2 pages');
      assert(targetPageCountForJob('Director of Engineering') === 2, 'director → 2 pages');
      assert(targetPageCountForJob('VP of Engineering') === 2, 'VP → 2 pages');
      assert(targetPageCountForJob('Head of Platform') === 2, '"head of" → 2 pages');
      assert(targetPageCountForJob('Chief Technology Officer') === 2, 'chief → 2 pages');
      assert(targetPageCountForJob('Chief of Staff') === 1, 'Chief of Staff is an administrative/advisory title, not a principal+ IC title');
      assert(targetPageCountForJob('Chief-of-Staff') === 1, 'hyphenated Chief-of-Staff is the same administrative/advisory title');
      assert(targetPageCountForJob('') === 1, 'empty/missing title defaults to 1 page, not a throw');
      assert(targetPageCountForJob(null) === 1, 'null title defaults to 1 page, not a throw');
      return { ok: true };
    },
  },
{
    name: 'Application: decideFitStep — the render → page-count → fit loop\'s pure decision function',
    run: () => {
      // Fits already → ship, no compact ever applied pre-emptively (SKILL.md:
      // "do not apply pre-emptively").
      const fits = decideFitStep({ pageCount: 1, target: 1, compactTried: false, revisionTried: false });
      assert(fits.action === 'ship', 'fits target → ship');
      const underTarget = decideFitStep({ pageCount: 1, target: 2, compactTried: false, revisionTried: false });
      assert(underTarget.action === 'ship', 'under target → ship (never pads to fill the target)');

      // Over target, nothing tried yet → the FREE lever first, never straight to an LLM call.
      const first = decideFitStep({ pageCount: 2, target: 1, compactTried: false, revisionTried: false });
      assert(first.action === 'compact', 'over target, compact not yet tried → compact (free, no LLM)');

      // Page count cannot tell whether a 2-page/1-page-target result is a
      // one-line or almost-full-page overflow, but 3 pages against a 1-page
      // target is conclusively large. That case must not waste a compact pass.
      const clearlyLarge = decideFitStep({ pageCount: 3, target: 1, compactTried: false, revisionTried: false });
      assert(clearlyLarge.action === 'revise', 'more than one full page beyond target → revise content before compact');

      // Over target, compact already tried → the one paid revision call.
      const second = decideFitStep({ pageCount: 2, target: 1, compactTried: true, revisionTried: false });
      assert(second.action === 'revise', 'still over after compact → revise (one LLM call)');

      // Over target, BOTH levers exhausted → ship best-effort, never loop.
      const exhausted = decideFitStep({ pageCount: 2, target: 1, compactTried: true, revisionTried: true });
      assert(exhausted.action === 'ship', 'both levers exhausted → ship best-effort, no third attempt');

      // A page count measured against fallback typefaces (fonts didn't load)
      // must never drive a fit decision — could compact a résumé that already
      // fits, or worse, spend an LLM call cutting real content over a phantom
      // overflow. Ships regardless of how far "over" the fallback count looks,
      // and regardless of what's already been tried.
      const noFonts = decideFitStep({ pageCount: 5, target: 1, compactTried: false, revisionTried: false, fontsLoaded: false });
      assert(noFonts.action === 'ship', 'fonts not loaded → ship without acting on a page count that isn\'t trustworthy');
      // fontsLoaded defaults to true (the common case) when the caller omits it.
      const defaultsTrue = decideFitStep({ pageCount: 2, target: 1, compactTried: false, revisionTried: false });
      assert(defaultsTrue.action === 'compact', 'fontsLoaded omitted defaults to true — normal fit logic still runs');

      // Every decision carries a human-readable reason (bug-report / log line).
      assert(typeof first.reason === 'string' && first.reason.length > 0, 'decision carries a non-empty reason');
      return { ok: true };
    },
  },
{
    name: 'Application: cover letter builder (design-system native surface)',
    run: () => {
      // buildCoverLetterDocument takes { letter, variantAttrs, docId } — see
      // the résumé scaffold test above for why fields now nest under `letter`
      // and CSS is inlined rather than linked (design doc §5.2).
      const html = buildCoverLetterDocument({
        letter: {
          name: 'Jane Doe',
          tagline: 'Product Marketer',
          contact: ['Austin, TX', 'jane@x.com'],
          date: 'May 31, 2026',
          recipient: 'Hiring Team\nAcme\nProduct Marketing',
          salutation: 'Dear Acme Team,',
          paragraphs: ['I love <Acme> & your work.', 'Second para.', '   '],
          closing: 'Sincerely,',
          signatureTitle: 'Senior Product Marketer · candidate',
        },
        variantAttrs: 'data-print="ink-only"',
      });
      // Uses the design system's NATIVE cover-letter surface, inlined — all
      // three stylesheets' content present in one <style> block, not a <link>
      // pointing at sibling files (HTML-first single-file workspace, §5.2).
      assert(!html.includes('<link rel="stylesheet"'), 'cover: must not link external stylesheets');
      assert((html.match(/<style>/g) || []).length === 1, 'cover: exactly one inlined <style> block');
      assert(html.includes('.letter-body') && html.includes('.resume-header') && html.includes('--ff-display'),
        'cover: colors_and_type.css + resume.css + cover-letter.css must all be inlined');
      // Every "does the MARKUP use this class/text" check below is scoped to
      // the content AFTER the inlined <style> block, never to the raw `html`
      // string as a whole — the design-system CSS is now inlined into the
      // same document (§5.2), and it names its own selectors in plain text
      // ('.letter-recipient', '.signature-title', …), so a whole-document
      // substring search would pass even when the builder emitted NEITHER
      // markup element. `</style>` is a reliable split point: it can only
      // close the one real <style> tag (asserted singular just above).
      const body = html.split('</style>').pop();
      // Native structure classes (cover-letter.html / cover-letter.css).
      for (const cls of ['resume-header letter-letterhead', 'letterhead-rule', 'letter-meta', 'letter-date', 'letter-recipient', 'letter-body', 'salutation', 'letter-close', 'valediction', 'signature']) {
        assert(body.includes(cls), `cover: missing native class "${cls}"`);
      }
      assert(body.includes('Jane Doe') && body.includes('Product Marketer'), 'cover: letterhead missing');
      assert(html.includes('data-print="ink-only"'), 'cover: variant not mirrored onto <html>');
      // Recipient block split: first line is the bolded .recipient-name, the rest .recipient-line.
      assert(body.includes('<span class="recipient-name">Hiring Team</span>'), 'cover: recipient-name (first line) missing');
      assert((body.match(/<span class="recipient-line">/g) || []).length === 2, 'cover: expected 2 recipient-line rows');
      // signatureTitle renders under the signature.
      assert(body.includes('<p class="signature-title">Senior Product Marketer · candidate</p>'), 'cover: signature-title missing');
      // User text is HTML-escaped (no markup injection from model output).
      assert(body.includes('I love &lt;Acme&gt; &amp; your work.'), 'cover: body not HTML-escaped');
      // Blank/whitespace paragraphs dropped; body uses bare <p> (every other
      // paragraph is classed, so this count isolates the body).
      const bodyParas = (body.match(/<p>/g) || []).length;
      assert(bodyParas === 2, `cover: expected 2 body paragraphs, got ${bodyParas}`);
      assert(body.includes('jane@x.com') && body.includes('class="sep"'), 'cover: contact line missing separators');
      // Sensible fallbacks when optional fields are omitted: salutation/closing
      // default; no recipient → no <address>; no signatureTitle → no signature-title.
      const bareFull = buildCoverLetterDocument({ letter: { name: 'X' } });
      const bare = bareFull.split('</style>').pop();
      assert(bare.includes('Dear Hiring Team,') && bare.includes('Sincerely,'), 'cover: missing salutation/closing fallback');
      assert(!bare.includes('letter-recipient') && !bare.includes('signature-title'), 'cover: optional blocks must be omitted when empty');
      assert(bare.includes('<p class="signature"'), 'cover: signature (name) always present');
      return { ok: true };
    },
  }
];
