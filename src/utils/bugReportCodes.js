/**
 * bugReportCodes.js — AI Bug Report Filter Code Vocabulary
 *
 * Defines the set of named codes an AI assistant can give to the user
 * when they report a bug. The user pastes the code into the bug report
 * dialog; the system uses it to extract ONLY the relevant telemetry,
 * keeping reports short and focused.
 *
 * Usage example:
 *   User → AI: "The app crashed when I resized a node"
 *   AI  → User: "Please use bug report code: CRASH+UI+LEAN"
 *   User pastes "CRASH+UI+LEAN" into the filter code box, writes their
 *   description, then presses Copy to Clipboard. That saves the full report
 *   to a file and copies its path (not the report text) — the AI reads the
 *   report from that file on disk instead of receiving it pasted inline.
 *
 * Codes are combined with '+':  ERR+LEAN,  SAVE+QUICK,  CRASH+UI
 */

// ── Code Definitions ─────────────────────────────────────────────────────────

/**
 * Each code definition may have:
 *   label          — short human-readable name
 *   description    — what it includes
 *   logFilter      — function(line: string) => boolean, keep log line if true
 *   logExclude     — function(line: string) => boolean, drop log line if true
 *   logSlice       — number, keep only the last N log lines (applied after filtering)
 *   excludeSections — string[], payload sections to omit from the report
 */
export const CODE_DEFINITIONS = {

  // ── Log Content Filters ───────────────────────────────────────────────────

  ERR: {
    label: 'Errors & Warnings',
    description: 'Show only error and warning events from the event log',
    logFilter: line =>
      /error|warn|crash|exception|failed|failure|ERROR:|WARN:/i.test(line),
  },

  SAVE: {
    label: 'Save & Load',
    description: 'Save, load, and file system events (good for "lost my work" bugs)',
    logFilter: line =>
      /save|load|open|close|write|read|file|EACCES|ENOSPC|disk|export|import/i.test(line),
  },

  CRASH: {
    label: 'JS Crashes',
    description: 'JavaScript errors, unhandled promise rejections, console errors',
    logFilter: line =>
      /JS-ERROR|UNHANDLED-PROMISE|CONSOLE-ERROR|CONSOLE-WARN/i.test(line),
  },

  UI: {
    label: 'UI Interactions',
    description: 'Confirm dialogs, node add, remove, move, resize, and edge events',
    logFilter: line =>
      /node added|node removed|node moved|node resized|edge added|edge removed|node removal BLOCKED|ConfirmDialog/i.test(line),
  },

  PASTE: {
    label: 'Clipboard & Paste',
    description: 'Clipboard and paste events (good for paste/drop bugs)',
    logFilter: line =>
      /paste|clipboard|PASTE:/i.test(line),
  },

  MEDIA: {
    label: 'Media Events',
    description: 'Audio and video player events',
    logFilter: line =>
      /video|audio|media|playback|seek|play|pause/i.test(line),
  },

  PREVIEW: {
    label: 'Image Previews & Relinking',
    description: 'Broken image previews, thumbnail/lightbox activity, local-file requests, and automatic moved-image relinking diagnostics',
    logFilter: line =>
      /image|photo|preview|thumbnail|lightbox|local-file|relink/i.test(line),
  },

  SETTINGS: {
    label: 'Settings Changes',
    description: 'Settings and configuration change events',
    logFilter: line =>
      /settings|SETTINGS-CHANGED|shortcut|api.?key|config/i.test(line),
  },

  UNDO: {
    label: 'Undo / Redo',
    description: 'Undo and redo operation events',
    // Word-bounded to avoid false positives on unrelated "history"/"snapshot"
    // log lines (e.g. Job Search Module's "History append failed").
    logFilter: line =>
      /\bundo\b|\bredo\b/i.test(line),
  },

  TEXT: {
    label: 'Text Editing',
    description: 'Text-field focus, selection, middle-edit, and native undo/redo diagnostics',
    logFilter: line =>
      /\[TextEdit\]/i.test(line),
  },

  FORM: {
    label: 'Form Field Focus',
    description: 'Form-control focus events ([Focus] …) — which input/date-picker/select the user was interacting with, and on which node. Use for "X flickered / reset / closed / jumped while I was using it" reports: it places the interaction on the timeline next to concurrent background activity (e.g. startup login-verification re-rendering the canvas).',
    logFilter: line =>
      /\[Focus\]/i.test(line),
  },

  RENDER: {
    label: 'Render Storms',
    description: 'Abnormally fast re-render bursts ([RenderStorm] …) that fingerprint an effect/state feedback loop or a prop that is unstable every render — for "the canvas is janking / a node keeps flickering / fans spinning" reports. One event per burst (not per render), with the culprit node and rate.',
    logFilter: line =>
      /\[RenderStorm\]/i.test(line),
  },

  NAV: {
    label: 'Canvas Navigation',
    description: 'Nested canvas dive-in and dive-out events',
    logFilter: line =>
      /dive|navigation|breadcrumb|nested|canvas level/i.test(line),
  },

  VIEWPORT: {
    label: 'Canvas Viewport',
    description: 'Canvas zoom/pan changes and fit-view actions, including whether a viewport change was interactive or programmatic',
    logFilter: line =>
      /viewport changed|fit-view|zoom|pan|WASD navigation/i.test(line),
  },

  TREE: {
    label: 'Results Tree & Minimap',
    description: 'Job/results cascade expand/collapse/show-more events (and minimap). Use for "minimap or canvas not reflecting collapsed/expanded cards" or node visibility/culling bugs — these interactions go through setNodes, so they would NOT appear in the log without this category.',
    logFilter: line =>
      /\[JobTree\]|\[JobBoard\]|\[JobCard\]|minimap/i.test(line),
  },

  TAXONOMY: {
    label: 'Job Taxonomy & Salary Buckets',
    description: 'Job-board likelihood/salary/role bucketing diagnostics, including taxonomy validation repairs and raw salary → annualized-pay placement audits. Use for malformed salary bands, unexpected job buckets, or role grouping questions. Keeps the compact Job Search Pipeline section while omitting heavy canvas/media dumps.',
    logFilter: line =>
      /taxonomy|bucket(?:ing)?|salary|\[JobTree\]|\[JobBoard\]/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  SCORE: {
    label: 'Job Scoring Consistency',
    description: 'Job-scoring audit — batch outcomes plus bounded per-job score/direction/reason evidence and cross-batch drift flags for effectively identical postings. Use when similar jobs received inconsistent scores. Included automatically in FULL; keeps the compact Job Search Pipeline section while dropping heavy canvas/media dumps.',
    logFilter: line =>
      /scor(?:e|ed|ing)|batch|job|gemini|claude|taxonomy|bucket/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  RELEVANCE: {
    label: 'Job Role Relevance',
    description: 'All-source role relevance diagnostics — exact title-match evidence where available, post-hoc title audits for board-ranked sources, and bounded rejected-title samples. Use when unrelated jobs appear or expected roles are missing. Included automatically in FULL.',
    logFilter: line =>
      /relevance|rejected|query|job|dice|usajobs|remoteok|weworkremotely|glassdoor|ziprecruiter|indeed|linkedin|google/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  QUALITY: {
    label: 'Job Listing Field Quality',
    description: 'Per-source listing quality diagnostics — missing/short descriptions with bounded title/URL samples, salary/date/URL selector health, encoding issues, and LinkedIn telemetry-vs-snapshot completion checks. Use when jobs were scored with incomplete or malformed source data. Included automatically in FULL.',
    logFilter: line =>
      /field.?quality|description|snippet|salary|posted|selector|mojibake|enrich|linkedin|job/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  JOBLINK: {
    label: 'Job Listing Links',
    description: 'External job-link diagnostics — bounded per-source URL-shape health plus JobCard dispatch/rejection outcomes. Use when an Open listing button reaches an error page, the wrong posting, or nothing at all. Query values and tracking tokens are never included. Included automatically in FULL.',
    logFilter: line =>
      /\[JobCard\].*external-link|open.?external|job.*(?:url|link)|(?:google|indeed|glassdoor|ziprecruiter).*?(?:url|link)/i.test(line),
    // Keep lightweight nodes so the compact structural link audit can inspect
    // current card data, while omitting the large diagnostics/media sections.
    excludeSections: ['edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  CAREERCACHE: {
    label: 'Career File Parse Cache',
    description: 'Career-file parse cache behavior — parse/cache hits and misses, key/fingerprint mismatch cases, stored profile reuse boundaries, and parser/model/schema invalidation reasons.',
    logFilter: line =>
      /career-file-parse|career file parse cache|career parse cache|parse cache|cache miss|cache hit/i.test(line),
  },

  CARDWALK: {
    label: 'Browser Job Card Walk',
    description: 'Browser job-card traversal diagnostics — compact per-card recovery/miss evidence plus the Job Search Pipeline’s extracted-versus-expanded counts. Use when a visible browser appears to skip, jump over, or select the wrong job cards. Included automatically in FULL; drops heavy canvas/media dumps.',
    logFilter: line =>
      /\[JobSearch\]|\[JobBoard\]|\[JobCard\]|\[JobTree\]|browser.*(?:scrape|card)|(?:google|indeed|glassdoor|ziprecruiter).*?(?:scrape|card|description)|(?:scrape|description).*?(?:google|indeed|glassdoor|ziprecruiter)/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  // ── Exclusion Modifiers ───────────────────────────────────────────────────
  // Prefix with X to mean "exclude these from the log"

  XDRAG: {
    label: 'Exclude Drag Noise',
    description: 'Remove high-volume drag/move position chatter from the log',
    logExclude: line =>
      /node moved|rf-drag-start|rf-drag-stop|rf-drag/i.test(line),
  },

  XRESIZE: {
    label: 'Exclude Resize Noise',
    description: 'Remove high-volume resize observer events from the log',
    logExclude: line =>
      /node resized|resize-correction/i.test(line),
  },

  // ── Volume Limiters ───────────────────────────────────────────────────────

  QUICK: {
    label: 'Last 50 Events',
    description: 'Only the 50 most recent log events (fastest to attach)',
    logSlice: 50,
  },

  LAST100: {
    label: 'Last 100 Events',
    description: 'Only the 100 most recent log events',
    logSlice: 100,
  },

  LAST200: {
    label: 'Last 200 Events',
    description: 'Only the 200 most recent log events',
    logSlice: 200,
  },

  // ── Section Controls ──────────────────────────────────────────────────────

  LEAN: {
    label: 'Lean Mode',
    description: 'Omit the heavy node/edge data dumps — include only description, app state, and the filtered event log',
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState'],
  },

  NOMEDIA: {
    label: 'No Media State',
    description: 'Omit the media player state snapshot',
    excludeSections: ['mediaState', 'imageState'],
  },

  XNODES: {
    label: 'Exclude Node Diagnostics',
    description: 'Omit the per-node Node Diagnostics table (positions/sizes/component state). Node COUNTS and every pipeline/session section are kept. Combine with FULL (e.g. "FULL+XNODES") to get everything except the heavy node table.',
    excludeSections: ['nodeInternals', 'nodeComponentStates'],
  },

  XSESS: {
    label: 'Exclude Session Verify Traces',
    description: 'Omit the verbose per-platform "Last verify trace" blocks (target/final URL + bodyHead HTML dumps) under Marketplace/Job Platform Sessions. The compact session summary tables (connected? / last reason) are kept.',
    excludeSections: ['sessionTraces'],
  },

  XJOBAUDIT: {
    label: 'Exclude Job Pipeline Detail Audits',
    description: 'Omit the heavy per-job audit prose inside the Job Search Pipeline section — the taxonomy salary-placement audit (one multi-line entry per job), the bounded scoring-evidence rows (long quoted reasons), the all-source role-relevance audit (one row per job), the Glassdoor location→locId cache dump, and the deferred-listing samples. The funnel numbers, stop reasons, warnings, and per-source outcomes in that same section are NOT affected — only the bulky per-job/per-location enumeration collapses to a one-line marker. Use this (not XNODES/XSESS) when that detail is not relevant to the issue.',
    excludeSections: ['jobAuditDetail'],
  },

  // ── Composite lenses ──────────────────────────────────────────────────────

  JOBS: {
    label: 'Job Search Pipeline',
    description: 'Job-search pipeline audit — the search→score→bucket funnel, per-source gather counts, and AI/scraper telemetry that confirm no jobs were silently dropped or not gathered. Drops the heavy node/edge/media dumps and narrows the event log to job-pipeline events (the pipeline / AI / scraper sections are built main-process-side and are always kept).',
    logFilter: line =>
      /\bjob|career|resume|scrape|gemini|bucket|scoring|funnel|dice|linkedin|usajobs|lever|greenhouse|remoteok|weworkremotely|glassdoor|ziprecruiter|indeed/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  JOBHANDOFF: {
    label: 'Manual Job-AI Handoff',
    description: 'Manual Non-API job-AI lifecycle — issued prompts, validation rejections, dialog-remount replays, acceptance, cancellation, and terminal timing. Use when a copy/paste job-analysis step appears stuck or when a submitted response was not applied. The compact redacted lifecycle receipt is also included in FULL.',
    logFilter: line =>
      /non-api ai|non-api-ai|manual ai|manual handoff|taxonomy|scor(?:e|ing)|compensation|career-file|resume-parse/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  APPLICATION: {
    label: 'Application Generation',
    description: 'Local application handoff audit — queued-job lifecycle, result validation/import, PDF render outcome, and final application-save events. Use when Generate fails, hangs, produces no document/PDF, or cannot save its artifacts. Included automatically in FULL.',
    logFilter: line =>
      /\[LocalAI(?:-Fallback)?\]|queue-local-application|get-local-application-status|import-local-application|save-application|ApplicationSync|JobApplication.*(?:Saved|import)|fit-feedback|result\.json|résumé|resume|cover.?letter|PDF|render.?fit/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  HANDOFF: {
    label: 'Local AI Handoff',
    description: 'Local AI application handoff audit — app-authored result-hash and page-measurement trace, result.json / fit-feedback lifecycle, import, render, and final-save events. Use when a local coding agent reports an iteration that the app did not appear to observe, a result is imported too early, or a measured revision loop is disputed. Included automatically in FULL.',
    logFilter: line =>
      /\[LocalAI(?:-Fallback)?\]|get-local-application-status|queue-local-application|import-local-application|fit-feedback|result\.json|JobApplication.*(?:Saved|import)|ApplicationSync|save-application/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  AUTH: {
    label: 'Login/Auth Windows',
    description: 'Login/session diagnostics — auth-window launch mode, current login URL/title, session verifier traces, account-related main-process logs, and (since AUTH now implies PERSIST) the close-lifecycle table with each window’s Chrome executable, profile directory, and whether the cookie store was checkpointed before close. Use for Google/Indeed/marketplace login loops, “browser may not be secure” errors, or a login that reports success but still reads logged out.',
    logFilter: line =>
      /auth|login|log.?in|logged|sign.?in|session|account|cookie|verify|verified|not connected|connected|StealthBrowser|Accounts|google|indeed|glassdoor|ziprecruiter|facebook|ebay|poshmark|mercari|swappa/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  PERSIST: {
    label: 'Session Persistence',
    description: 'Cross-restart login durability diagnostics — browser-profile file checkpoints, restored cache provenance, per-platform auth-cookie-on-disk presence (never values), the close-lifecycle table (including which Chrome executable and profile directory each login window used), and startup verification. Use when login works until the app closes/reopens, OR when a login window and a later scrape/read used a different Chrome binary or profile within the SAME session (they cannot share cookies — e.g. a native login window vs. a Puppeteer-launched scrape). Included automatically in FULL.',
    logFilter: line =>
      /auth|login|log.?in|session|cookie|profile|checkpoint|persist|restor|startup verify|browser.*(?:close|exit|kill)|SIGTERM|SIGKILL|StealthBrowser|Accounts/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  RECOVERY: {
    label: 'Job Recovery After Restart',
    description: 'Job Search restart/completion audit — durable last-run terminal receipt plus saved run manifest/staging-ledger health and current/last-successful scrape snapshot metadata. Use after closing/crashing during search or manual AI copy/paste, or to establish whether a prior-process run completed; never includes job contents or AI prompt/response text. Included automatically in FULL.',
    logFilter: line =>
      /\[JobSearch\]|\[Jobs\]|job.?run|jobs?.(?:staging|run)|saved (?:AI prompt|scrape)|resume(?:d|ing)? (?:job|saved|search)|manual ai|non-api-ai|copy\/?paste|cancel.?node.?task/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  JOBRESOLVE: {
    label: 'Job Source Solve & Continue',
    description: 'Job Search source-card Solve/Continue/retry audit — the visible resolver launch, current-run description-recovery snapshot ownership/readiness, per-source progress, returned-item merge, and relevant task lifecycle. Use when a Job Search source card says Solve/Continue did nothing, reopened repeatedly, or reports that its recovery snapshot belongs to another hub/run. Keeps the compact job pipeline/recovery evidence while dropping heavy canvas, media, session-trace, and per-job audit detail. This is separate from the SellHub-only RESOLVE code.',
    logFilter: line =>
      /\[JobSearch\].*(?:\bResolved\b|source[- ]?(?:retry|resolved|progress)|(?:pre[- ]score )?description[- ]recovery|recovery checkpoint|\b(?:Solve|Continue|retry|cancel(?:led)?)\b)|\[JobSource\].*(?:\bResolve\b|\bContinue\b|queue cancelled)|\[Jobs\].*(?:requested source resolve|opening resolve(?: window)?|resolve-job-source|resume-job-source|description[- ]recovery(?:-snapshot)?|recovery snapshot|Saved AI prompt snapshot|source[- ]?progress|\b(?:Solve|Continue|retry|cancel(?:led)?)\b)|\b(?:resolve-job-source|resume-job-source|job-source-(?:retry-start|resolved|progress)|description[- ]recovery-(?:snapshot-(?:stale|unavailable)|not-ready)|current[- ]run (?:recovery )?snapshot|User (?:requested source resolve|opening resolve)|Registered task|cancel[- ]node[- ]task)\b/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState', 'sessionTraces', 'jobAuditDetail'],
  },

  MARKET: {
    label: 'Marketplace Pricing Pipeline',
    description: 'Sell-hub pricing audit — photo analysis, multi-source comp scrape (per-source counts, warnings, blocks), captcha resolve outcomes, AI synthesis (FMV, match quality), and platform-fit results. Drops heavy node/edge/media dumps and narrows the event log to marketplace pipeline events (the marketplaceTelemetry section is always kept).',
    logFilter: line =>
      /price|pric|sell.?hub|marketplace|comp.?source|scrape|captcha|resolve|block|throttle|stale.?selector|fmv|synthesis|platform.?fit|ebay|poshmark|mercari|swappa|stockx|reverb/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  RESOLVE: {
    label: 'Source Resolve Queue',
    description: 'SellHub source-resolve/retry diagnostics — captcha Solve windows, resolved-source drains, rescrape-source IPC tasks, source card progress, and marketplace browser-queue waits. Use for “source retries stuck/in progress after solving” reports. Keeps the compact SellHub Source Resolve Queue section but drops heavy node payloads/diagnostics.',
    logFilter: line =>
      /resolved source|source resolve|resolve\/rescrape|queued .*resolve|applying queued source resolve|source retr|rescrape-source|Rescrap(?:e|ing)|captcha-resolve|price-source-progress|BrowserPool|marketplace browser|queued behind/i.test(line),
    excludeSections: ['nodes', 'edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  SELL: {
    label: 'SellHub State & Price Drops',
    description: 'SellHub UI/state audit — price-drop plan fields, target price commits (including $0/free targets), listing cards, and focused sell-form controls. Keeps lightweight node data so the compact SellHub Price-Drop Plans section can render, but drops the heavy node diagnostics table and media/image dumps.',
    logFilter: line =>
      /sell.?hub|price.?drop|target price|must sell|listing card|marketplacecard|\[Focus\].*(target price|must sell|price-drop|sell)/i.test(line),
    excludeSections: ['edges', 'drawings', 'nodeInternals', 'nodeComponentStates', 'imageState', 'mediaState'],
  },

  STATUS: {
    label: 'Listing Status Checks',
    description: 'Listing status-check audit — per-card "Check" / "Check All" runs: the per-URL verdict trace, whether the identity anchor matched each page, and sold/ended/needs-login/unknown outcomes. Use for "Check All said X but the listing is Y", "my deletion was not detected", or "card stuck on unknown" reports. The per-URL trace + listing-URL shape live in Node Diagnostics (`listing:` and `checkTrace[…]`); this also narrows the event log to status-check lines.',
    logFilter: line =>
      /status check|check.?all|checking .* status|Result: (live|sold|ended|unknown|needs.?login|error)|ListingStatusCheck|needs.?login|lastCheckTrace/i.test(line),
  },

  STALL: {
    label: 'Stuck / Not Progressing',
    description: 'Liveness audit for a run that appears frozen — the browser scraper\'s activity beat (its on-screen per-card/per-page progress line, refreshed every few seconds), the operation currently being awaited and for how long, whether the scrape is user-PAUSED, whether a scrape Chrome is actually running, retained source/query origin phases, and the active IPC task ages. Use for "processing stuck", "stuck on searching", "nothing is happening", "frozen", or "it has been sitting there for ages". Answers the one question a phase timestamp cannot: is this working silently, or genuinely wedged? Included automatically in FULL; drops heavy canvas/media dumps.',
    // Word-bounded on purpose: an unanchored `hang` matches "c-hang-ed", which
    // made every "viewport changed" line survive the filter and defeated the
    // point of scoping the report at all.
    logFilter: line =>
      /\[JobSearch\]|\[Jobs\]|\[BrowserScraper\]|\[BrowserPool\]|still awaiting|activity beat|page-extract|card.?walk|Registered task|cancel.?node.?task|\bstall(?:ed|ing)?\b|\bhang(?:s|ing|ung)?\b|\bpaus(?:e|ed|ing)\b|\bresum(?:e|ed|ing)\b|\bscrap(?:e|ed|ing|er)\b|\bextract(?:s|ed|ing|or|ion)?\b|\babort(?:s|ed|ing)?\b|\btimeouts?\b|\btimed out\b|\bheartbeat\b|\bfrozen\b|\bstuck\b/i.test(line),
    excludeSections: ['drawings', 'nodeInternals', 'imageState', 'mediaState'],
  },

  // ── Presets ───────────────────────────────────────────────────────────────

  FULL: {
    label: 'Full Report',
    description: 'All currently retained report sections and renderer event-log lines, without filter-code reduction (for complex or unclear issues). It cannot restore history from an earlier app process.',
    preset: 'full',
  },
};

// ── AI Prompt Builder ─────────────────────────────────────────────────────────
// Builds the prompt the user copies and pastes to any AI assistant. The user's
// bug description is embedded directly so they never write a filter code by hand
// — the AI reads the description, picks codes, and replies with just the code
// string. Generated from CODE_DEFINITIONS so the list can never drift out of
// sync with the codes that actually exist.

export function buildAiPrompt(description) {
  const codeLines = Object.entries(CODE_DEFINITIONS)
    .map(([code, def]) => `• ${`${code} `.padEnd(10)}— ${def.description}`)
    .join('\n');
  const bug = (description || '').trim() || '[describe what went wrong here]';
  return `I'm using the Infinite Canvas app and hit this issue:

"${bug}"

From the filter codes below, pick the one(s) that capture the telemetry needed to debug this and reply with ONLY the code string (e.g. "CRASH+UI+LEAN"). Combine codes with "+". I'll paste it straight into the bug reporter to attach exactly the relevant data — I won't edit the code by hand. The generated report is saved to a file on disk, not pasted inline: when I hand you its file path next, read the report yourself from that file (in segments if it's large) rather than waiting for the text to be pasted.

Available codes:
${codeLines}

If none of these codes capture the telemetry needed to debug this, don't force a fit and don't ask first — implement a new code directly. Add an entry to CODE_DEFINITIONS in src/utils/bugReportCodes.js: a short UPPERCASE name, a label, a description, and one of — logFilter (regex that keeps matching log lines), logExclude (regex that drops matching lines), logSlice (keep only the last N lines), or excludeSections (array of payload sections to omit). Then reply with the code string to use, including the new code you added.

Examples: "CRASH+UI+LEAN", "SAVE+ERR", "UI+QUICK"`;
}

// ── Core Filter Logic ─────────────────────────────────────────────────────────

// Events kept on either side of each filter match. Inclusion filtering that
// dropped every non-matching line would discard the reproduction trail — the
// events right before an error are usually the most diagnostic, and they're
// rarely errors themselves. Keeping a small window preserves that causality
// while still trimming the bulk of the noise.
const CONTEXT_LINES = 3;

/**
 * Apply a bug report code string to filter event logs and payload sections.
 *
 * @param {string[]} logs          - All event log lines from EventLogger
 * @param {object}   payload       - The full bug report payload object
 * @param {string}   codeString    - Code string like "ERR+LEAN" or "SAVE+QUICK"
 * @returns {{
 *   filteredLogs: string[],
 *   sectionExclusions: Set<string>,
 *   matchedCodes: string[],
 *   unknownCodes: string[],
 *   label: string,
 * }}
 */
export function applyBugReportCode(logs, payload, codeString) {
  const normalised = (codeString || '').trim().toUpperCase();

  // Empty or FULL → return everything untouched
  if (!normalised || normalised === 'FULL') {
    return {
      filteredLogs: logs,
      sectionExclusions: new Set(),
      matchedCodes: normalised === 'FULL' ? ['FULL'] : [],
      unknownCodes: [],
      label: 'Full report',
    };
  }

  const codes = normalised.split(/[+\s,]+/).filter(Boolean);
  // FULL is an explicit request to preserve the entire reproduction timeline.
  // It may be combined with section-only modifiers such as XNODES/XSESS, but
  // never with a log reducer: `FULL+ERR`, `FULL+QUICK`, and `FULL+XDRAG` all
  // keep every event. This also keeps the UI summary's "unfiltered" claim true.
  const hasFull = codes.includes('FULL');

  const logFilters = [];       // functions: line → true = INCLUDE
  const logExclusions = [];    // functions: line → true = EXCLUDE
  let logSlice = null;         // keep last N after filtering
  const sectionExclusions = new Set();
  const matchedCodes = [];
  const unknownCodes = [];

  for (const code of codes) {
    const def = CODE_DEFINITIONS[code];
    if (!def) {
      unknownCodes.push(code);
      continue;
    }
    matchedCodes.push(code);
    if (!hasFull && def.logFilter) logFilters.push(def.logFilter);
    if (!hasFull && def.logExclude) logExclusions.push(def.logExclude);
    if (!hasFull && def.logSlice != null) {
      // Take the smallest slice if multiple slice codes given
      logSlice = logSlice === null ? def.logSlice : Math.min(logSlice, def.logSlice);
    }
    if (def.excludeSections) {
      def.excludeSections.forEach(s => sectionExclusions.add(s));
    }
  }

  // Step 1: Apply inclusion filters (OR logic — keep if ANY filter matches),
  //         plus ±CONTEXT_LINES of surrounding events around each match so the
  //         reproduction trail survives. If no inclusion filters were given,
  //         start with all logs.
  let filteredLogs;
  if (logFilters.length > 0) {
    const keep = new Set();
    logs.forEach((line, i) => {
      if (logFilters.some(f => f(line))) {
        const lo = Math.max(0, i - CONTEXT_LINES);
        const hi = Math.min(logs.length - 1, i + CONTEXT_LINES);
        for (let j = lo; j <= hi; j++) keep.add(j);
      }
    });
    filteredLogs = logs.filter((_, i) => keep.has(i));
  } else {
    filteredLogs = [...logs];
  }

  // Step 2: Apply exclusions (AND logic — drop if ANY exclusion matches).
  if (logExclusions.length > 0) {
    filteredLogs = filteredLogs.filter(
      line => !logExclusions.some(f => f(line))
    );
  }

  // Step 3: Apply volume limiter (keep last N).
  if (logSlice !== null && filteredLogs.length > logSlice) {
    filteredLogs = filteredLogs.slice(-logSlice);
  }

  const labelParts = matchedCodes
    .map(c => CODE_DEFINITIONS[c]?.label)
    .filter(Boolean);

  return {
    filteredLogs,
    sectionExclusions,
    matchedCodes,
    unknownCodes,
    label: labelParts.length > 0 ? labelParts.join(' + ') : 'Custom filter',
  };
}

/**
 * Lightweight preview: count how many log lines a code would select,
 * and describe what the code does — without needing the full payload.
 *
 * @param {string[]} logs       - Raw event log lines
 * @param {string}   codeString - Code string
 * @returns {{ count: number, label: string, unknownCodes: string[], valid: boolean }}
 */
export function previewBugReportCode(logs, codeString) {
  const { filteredLogs, matchedCodes, unknownCodes, label } =
    applyBugReportCode(logs, {}, codeString);

  return {
    count: filteredLogs.length,
    total: logs.length,
    label,
    matchedCodes,
    unknownCodes,
    valid: matchedCodes.length > 0 || !codeString?.trim(),
  };
}
