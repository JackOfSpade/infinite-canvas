import crypto from 'crypto';

// Shared utilities for bug-report markdown generation. Each is used by at
// least two snapshot builders (jobs, marketplace, persisted-workspace), so
// they live here rather than being duplicated or buried in one module.

// Bridge setup lives in the main process while reports may be assembled long
// after a particular bridge runtime stopped. Keep the hostname list here,
// rather than teaching each report builder about bridge configuration.
let reportRedactedHosts = new Set();
let reportRedactedHostPatterns = [];

function escapeReportRedactedHostForRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function reportUrlPath(parsed) {
  const pathname = parsed.pathname || '/';
  const parts = pathname.split('/').filter(Boolean);
  // Providers use several path families for listing/product slugs. Those
  // slugs routinely contain a role, employer, item title, or location even
  // when the query string has already been removed.
  const listingSegments = new Set([
    'job', 'jobs', 'job-search', 'search', 'career', 'careers',
    'position', 'positions', 'listing', 'listings', 'item', 'items', 'product', 'products',
  ]);
  const listingIndex = parts.findIndex(part => listingSegments.has(part.toLowerCase()));
  if (listingIndex >= 0 && parts.length > listingIndex + 1) return '/<listing-path>';
  return pathname;
}

/**
 * Set the configured hostnames that must not be exposed in a bug report.
 * Calling without hosts intentionally restores the historical no-op behavior.
 */
export function setReportRedactedHosts(hosts) {
  const values = typeof hosts === 'string'
    ? [hosts]
    : Array.isArray(hosts)
      ? hosts
      : hosts instanceof Set
        ? [...hosts]
        : [];
  const normalized = new Set();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const hostname = value.trim().toLowerCase();
    if (hostname) normalized.add(hostname);
  }
  reportRedactedHosts = normalized;
  // Keep hostname boundaries explicit: a configured host must not redact a
  // longer hostname or an identifier that merely contains it as a substring.
  // A final dot is the DNS root marker (and ordinary prose punctuation), not
  // the beginning of another label, so it is intentionally a safe boundary.
  reportRedactedHostPatterns = [...normalized].map(hostname => new RegExp(
    `(^|[^a-z0-9_.-])${escapeReportRedactedHostForRegExp(hostname)}(?=$|[^a-z0-9_.-]|\\.(?=$|[^a-z0-9_-]))`,
    'gi',
  ));
}

function redactConfiguredReportHosts(value) {
  if (reportRedactedHostPatterns.length === 0) return value;
  let redacted = value;
  for (const pattern of reportRedactedHostPatterns) {
    redacted = redacted.replace(pattern, (_match, prefix) => `${prefix}<bridge-host>`);
  }
  return redacted;
}

function redactedReportOrigin(parsed) {
  // A terminal root dot is equivalent to the configured DNS hostname. URL
  // parsers retain it, so compare the canonical spelling before deciding
  // whether a report may show the origin.
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, '');
  if (!reportRedactedHosts.has(hostname)) return parsed.origin;
  return `${parsed.protocol}//<bridge-host>${parsed.port ? `:${parsed.port}` : ''}`;
}

/**
 * Keep the diagnostic identity of a URL while removing query/hash data.
 *
 * Session and challenge URLs routinely carry short-lived OAuth, Cloudflare,
 * redirect, or tracking tokens. A bug report only needs the origin/path to
 * identify the page that was reached; exporting the rest is both unnecessary
 * and unsafe. The fallback also covers malformed/relative URL-shaped strings.
 */
export function redactReportUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^(?:file:\/\/|~\/|\/(?:System\/Volumes\/Data\/)?(?:Users|private|tmp|Applications|opt|Volumes|Library|var|etc|usr|home|root|run|mnt|srv|dev|workspace)(?:\/|$)|[a-z]:[\\/])/i.test(raw)) {
    return '<local-path>';
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return redactConfiguredReportHosts(`${redactedReportOrigin(parsed)}${reportUrlPath(parsed)}`);
    }
    return '<redacted-url>';
  } catch {
    return '<redacted-url>';
  }
}

/** Remove query/hash data from every absolute HTTP(S) URL embedded in prose. */
export function redactReportUrlsInText(value) {
  const text = String(value || '').replace(/https?:\/\/[^\s`<>"|]+/gi, (match) => {
    // Sentence/table punctuation is not part of the URL. Preserve it after the
    // redacted identity so prose remains readable.
    const suffixMatch = match.match(/[)\]}.,;:]+$/);
    const suffix = suffixMatch?.[0] || '';
    const url = suffix ? match.slice(0, -suffix.length) : match;
    return `${redactReportUrl(url)}${suffix}`;
  });
  return redactConfiguredReportHosts(text);
}

// Reports can be copied outside the app, so a local path is identifying data
// rather than useful support evidence. Keep the fact that a path was present
// while withholding every component, including a user name or workspace name.
const LOCAL_REPORT_PATH = /(^|[\s=:([`'"])(?:file:\/\/[^\r\n|`]*|(?:~\/|[a-z]:[\\/]|\\\\(?:\?\\)?|\/(?:(?:System\/Volumes\/Data\/)?Users|private|tmp|Applications|opt|Volumes|Library|var|etc|usr|home|root|run|mnt|srv|dev|workspace))(?:[^\r\n|`]*)?)/gimu;

export function redactReportPath(value, fallback = '(unavailable)') {
  return typeof value === 'string' && value.trim() ? '<local-path>' : fallback;
}

export function redactReportLocalPathsInText(value) {
  return String(value ?? '').replace(LOCAL_REPORT_PATH, '$1<local-path>');
}

// Node, job, and run UUIDs are opaque internal correlation tokens. Reports do
// not need their source spelling: a full identifier can be reused to join a
// support export to local state, while the surrounding event/status remains
// actionable without it.
export function redactReportOpaqueIds(value) {
  return String(value ?? '').replace(
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
    '<opaque-id>',
  );
}

/**
 * Project trusted app-authored diagnostics into bounded report text. URLs,
 * paths, credential-bearing forms, and opaque internal identifiers are removed
 * before the text is rendered.
 */
export function projectReportDiagnostic(value, fallback = 'not recorded', max = 240) {
  const normalized = redactReportOpaqueIds(redactReportLogSecrets(redactReportLocalPathsInText(redactReportUrlsInText(value))))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/`/g, "'")
    .replace(/\|/g, '\\|')
    .trim();
  if (!normalized) return fallback;
  return normalized.length > max ? `${normalized.slice(0, Math.max(1, max - 1))}…` : normalized;
}

/** Browser/provider/page-derived text is untrusted account content; retain only presence. */
export function closeReportDiagnostic(value, fallback = 'not recorded') {
  return String(value ?? '').trim() ? 'recorded' : fallback;
}

/** Preserve log structure while removing high-confidence credential forms. */
export function redactReportLogSecrets(value) {
  return String(value ?? '')
    .replace(/\b"?(?:cookie|set[-_ ]?cookie)"?\s*(?:=|:)\s*[^\r\n|]+/gi, 'credential=<redacted>')
    .replace(/\b"?(?:(?:proxy[-_ ]?)?authorization(?:[-_ ]?key)?|password|passphrase|api[-_ ]?key|client[-_ ]?secret|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|session[-_ ]?(?:id|token|key)|token|key)"?\s*(?:=|:)\s*(?:(?:Bearer|Basic)\s+)?(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\]]*\]|\{[^}]*\}|[^\s,;|]+)/gi, () => 'credential=<redacted>')
    .replace(/\bBearer\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[^\]]*\]|\{[^}]*\}|[^\s,;|]+)/gi, 'Bearer <redacted>')
    .replace(/\beyJ[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9._-]+\.[a-zA-Z0-9._-]+\b/g, '<redacted-jwt>');
}

// Renderer events are deliberately a human-readable ring rather than a rigid
// schema. That makes them useful during a failure, but it also means a legacy
// or future producer can accidentally interpolate a search query, target role,
// or Google Jobs document id. Keep this at the report boundary: the reporter
// may send old in-memory rows, and every current/future EventLogger producer
// reaches this formatter before an Event History block is written to disk or
// copied as an inline fallback.
const SAFE_EVENT_DIAGNOSTIC_VALUES = new Set([
  'present', 'missing', 'empty', 'unknown', 'invalid', 'none', 'yes', 'no', 'true', 'false', '?',
]);

const EVENT_SENSITIVE_ASSIGNMENT = /\b(q|query|rawquery|searchquery|careerquery|targetrole|careertarget|preferences?|htidocid|documentid|document|docid|title|company|location|jobtitle|joblocation)(\s*(?:=|:)\s*)("[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|.*?)(?=(?:\s*(?:[,;|]\s*)?[A-Za-z][A-Za-z0-9_-]{0,40}\s*[=:])|[\r\n]|$)/gi;

function eventSensitiveValueKind(key) {
  return /^(?:htidocid|documentid|document|docid)$/i.test(key)
    ? 'document identifier'
    : /^(?:targetrole|careertarget)$/i.test(key)
      ? 'target role'
      : /^preferences?$/i.test(key)
        ? 'preferences'
        : 'query';
}

function redactEventAssignment(_match, key, separator, rawValue) {
  const bare = String(rawValue).trim().replace(/^(?:"|'|`)|(?:"|'|`)$/g, '');
  if (SAFE_EVENT_DIAGNOSTIC_VALUES.has(bare.toLowerCase()) || /^\[redacted [^\]]+\]$/i.test(bare)) {
    return `${key}${separator}${rawValue}`;
  }
  return `${key}${separator}[redacted ${eventSensitiveValueKind(key)}]`;
}

/**
 * Redact private renderer-event values while preserving timestamps, event
 * names, stages, source ids, and bounded diagnostic fields around them.
 */
export function redactReportEventHistoryLine(value) {
  // Match the old event export's String(value) coercion exactly; malformed
  // mocked/legacy rows remain visible as "null"/"undefined" rather than
  // silently disappearing from a timeline.
  let text = redactReportOpaqueIds(redactReportLocalPathsInText(redactReportUrlsInText(String(value))));

  // These are the prose forms emitted by JobSearchNode / JobGroupNode. Match
  // only an explicit sensitive cue and quoted value; ordinary quoted event
  // labels remain intact.
  text = text
    // The value itself can contain a quote (for example a search for
    // `"Staff" engineer`), so consume through the last quote on this event
    // line rather than exposing the suffix after its first embedded quote.
    .replace(/(\b(?:for\s+query|search\s+query)\s*:\s*)"[^\r\n]*"/gi, '$1"[redacted query]"')
    .replace(/(\b(?:job\s+)?(?:title|company|location)\s*:\s*)"[^\r\n]*"/gi, '$1"[redacted value]"')
    .replace(/(\bsearching\s+exactly\s*)"[^\r\n]*"/gi, '$1"[redacted target role]"')
    .replace(/(\bshow\s+more\s+in\s+role\s*)"[^\r\n]*"/gi, '$1"[redacted role]"')
    .replace(/(\b(?:expanded|collapsed)\s+(?:role|salary|category|bucket|branch)\s*)"[^\r\n]*"/gi, '$1"[redacted taxonomy label]"')
    // FIX 10: JobSearchNode's Search-Brief-driven title resolution logs
    // "...skipping query generation and searching them directly: <titles>"
    // with the resolved titles UNQUOTED and comma-joined, running to end of
    // line (see the EventLogger.log call in src/nodes/JobSearchNode.jsx).
    // Unlike the two prose forms above, there is no closing quote to anchor
    // on, so this clause must consume the rest of the line after the colon.
    .replace(/(\bskipping\s+query\s+generation\s+and\s+searching\s+them\s+directly\s*:\s*)[^\r\n]*/gi, '$1[redacted titles]');

  // Key/value forms cover JobCard's q=/htidocid= diagnostics and compatible
  // future event producers. Known metadata-only values (for example the
  // current q=present / htidocid=missing) remain readable.
  return text.replace(EVENT_SENSITIVE_ASSIGNMENT, redactEventAssignment);
}

// "(Ns ago)" suffix for a timestamp — shared by the pipeline snapshot builders.
export const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  return Number.isFinite(s) ? ` (${s}s ago)` : '';
};

/** Bounded free text with an explicit truncation marker — a silent cut reads as corrupted evidence rather than a clipped line. */
export function clipReportText(value, max) {
  const text = String(value ?? '');
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

// Human age ("32s ago" / "5m ago" / "2h14m ago" / "never") for a timestamp —
// shared by the marketplace module/status rollups' check-recency columns.
export function formatAge(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  const h = Math.floor(s / 3600);
  const mn = Math.floor((s % 3600) / 60);
  return h ? `${h}h${mn}m ago` : `${mn}m ago`;
}

// Depth-first walk over a canvas node tree, descending into every node's nested
// `data.canvasData.nodes` (grouped sub-canvases) — the same type-agnostic
// recursion the navigation/serialization layers use. Invokes `fn(node)` for each
// node. Shared by the marketplace-module and sell-hub price-drop rollups so the
// "find every node of type X anywhere on the canvas" traversal can't drift between
// report sections. Non-array input is a no-op.
export function visitCanvasNodes(nodes, fn) {
  if (!Array.isArray(nodes)) return;
  for (const node of nodes) {
    if (!node) continue;
    fn(node);
    const inner = node.data?.canvasData?.nodes;
    if (Array.isArray(inner) && inner.length) visitCanvasNodes(inner, fn);
  }
}

// Renders the model that actually served an AI stage (recorded per stage via the
// LLM layer's `meta` out-param — always the literal string 'non-api-ai' on the
// manual-handoff transport, since there is exactly one transport and no model
// selection). `fallback` (optional, `{ attempts, reason, counts, preferredModel }`)
// is a holdover from the retired provider-cascade era: nothing populates it
// anymore, so the "weak fallback"/"fell back" branches below are permanently
// dormant. Kept rather than deleted because several bug-report call sites still
// pass a `fallback` argument through this shape; ripping it out here without
// touching every caller would just move the dead field, not remove it.
export const modelTag = (model, fallback) => {
  if (!model) return '';
  const preferredModel = fallback?.preferredModel || '';
  const weak = /lite/.test(model) && (!preferredModel || !/lite/.test(preferredModel));
  const fellBack = fallback && fallback.attempts > 0;
  // Distinct-cause breakdown when the chain was mixed; else the single reason.
  const causeLabel = (fb) => {
    const c = fb && fb.counts;
    if (c && typeof c === 'object') {
      const parts = Object.entries(c).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
      if (parts.length > 1) return parts.map(([k, n]) => `${k}×${n}`).join(' + ');
    }
    return fb ? fb.reason : '';
  };
  const why = fellBack ? `${causeLabel(fallback)}: ${fallback.attempts} earlier model(s) failed` : '';
  let suffix = '';
  if (weak) suffix = ` ⚠️ weak fallback${why ? ` (${why})` : ''}`;
  else if (fellBack) suffix = ` ↪ fell back (${why})`;
  return ` · model: \`${model}\`${suffix}`;
};

// Produce a short but meaningful identifier for any node ID.
// UUID-style IDs (e.g. "3539d90c-e09d-…") are unique in their first segment,
// so we show the first 8 chars. All other IDs (e.g. "job-1779484861758-job-0",
// "job-1779484861758-cat-2-buc-1") embed a shared timestamp prefix that makes
// the first 8 chars identical across every job node — we show the last 8 chars
// instead so the unique suffix ("-job-0", "-buc-1") is visible.
export const shortId = (id) => {
  const s = String(id);
  if (s.length <= 8) return s;
  if (/^[0-9a-f]{8}-/.test(s)) return s.slice(0, 8); // UUID: first segment is unique
  return `…${s.slice(-8)}`;                           // timestamp-prefixed: show suffix
};

// Reports need to relate rows from the same export without publishing a node,
// job, or run token that can be joined back to local state.  Keep this here so
// every report renderer uses the same stable, one-way label rather than
// accidentally reintroducing a UUID prefix through `shortId`.
export const reportCorrelationDigest = (value, fallback = 'not recorded') => {
  if (typeof value !== 'string' || !value) return fallback;
  return `#${crypto.createHash('sha256').update(value).digest('hex').slice(0, 10)}`;
};

// Decides whether a pipeline's telemetry belongs to the current canvas window
// and produces the section-header note that explains the attribution. The
// telemetry singletons (jobs/marketplace) are shared across every open window
// — without this scope check, the most recent run from window B would appear
// in window A's bug report. The originating window id (webContents id) is the
// authoritative scope: if it differs from the window that requested the
// report, the run is another canvas's and is OMITTED — the report only
// reflects the canvas it was triggered from.
//
// Node presence alone can't decide this: a node missing from the current canvas
// could be another window's node OR this window's hub that the user DELETED after
// the run (the telemetry deliberately outlives the hub — that's its whole point).
// So node presence only refines the wording for same-window runs; windowId
// decides inclusion. Unknown ids (older telemetry / no sender) → treat as local.
export const pipelineScope = (nodeId, windowId, currentNodeIds, reportWindowId, options = {}) => {
  if (windowId != null && reportWindowId != null && windowId !== reportWindowId) {
    return {
      foreign: true,
      note: "> (No run recorded for this canvas this session — these pipeline tallies are a main-process singleton shared by every open window, and the most recent run was in a DIFFERENT window/canvas, so it is omitted here rather than misattributed to this one.)\n",
    };
  }
  if (!nodeId) return { foreign: false, note: '' };
  const short = reportCorrelationDigest(nodeId);
  const deleted = currentNodeIds && currentNodeIds.size > 0 && !currentNodeIds.has(nodeId);
  const label = options.label || 'Source node';
  const deletedNoun = options.deletedNoun || 'hub';
  return {
    foreign: false,
    note: `> ${label}: \`${short}\`${deleted ? ` (${deletedNoun} since deleted from this canvas — telemetry retained so the run still reports)` : ''}.\n`,
  };
};

// Sanity flag for a recommended price that exceeds the highest ACTUAL sold comp.
// Pricing above the entire sold range won't speed a sale and usually means the
// model over-reached (common on a weak fallback). Compares against the real
// fed-comp max (soldKeptStats), NOT the model's self-reported market summary,
// and stays silent when an active listing legitimately sits that high (market may
// have moved up). Returns the warning text, or null when nothing is off.
export const overPricedSoldFlag = (recommendedPrice, soldKeptStats, activeKeptStats) => {
  const recP = recommendedPrice;
  const soldMax = soldKeptStats?.max;
  const activeMax = activeKeptStats?.max;
  if (!(typeof recP === 'number' && recP > 0)) return null;
  if (!(typeof soldMax === 'number' && soldMax > 0)) return null;
  if (recP <= soldMax) return null;
  if (typeof activeMax === 'number' && activeMax >= recP) return null; // active competition justifies it
  const over = Math.round((recP - soldMax) * 100) / 100;
  const pct = Math.round(((recP - soldMax) / soldMax) * 1000) / 10;
  const med = soldKeptStats?.median;
  return `Recommended $${recP} is ABOVE the highest actual sold comp ($${soldMax}) by $${over} (${pct}%) — nothing sold that high, so for a quick sale it is likely over-priced (common when a weak fallback model anchors aggressively).${med != null ? ` Median sold was $${med}.` : ''}`;
};

// ── Session snapshot rendering ────────────────────────────────────────────────
// The Marketplace-Sessions and Job-Platform-Sessions report sections render the
// SAME table + per-platform verify trace from the SAME session cache, differing
// only in platform list and heading text. These two helpers own that rendering
// so the two sections can't drift (a new trace field is added in one place).

/** Markdown table rows for a platform list against the session cache. */
export const renderSessionRows = (platforms, cache) => platforms.map(p => {
  const entry = cache[p.id];
  const traceStatus = entry?.lastTrace?.status;
  const staleMismatch = entry?.connected && traceStatus != null && traceStatus >= 400;
  const mustContain = p.connectedFinalUrlMustContain;
  const traceFinalUrl = (entry?.lastTrace?.finalUrl || '').toLowerCase();
  // connectedFinalUrlMustContain is an HTTP-verify contract. A trusted puppeteer
  // login window auto-detects the session and stamps a non-HTTP trace
  // (status: 'auto-detected', finalUrl = the detection URL or undefined), which
  // the HTTP redirect check would otherwise flag as a bogus "redirected to
  // undefined". Skip the check for auto-detected traces — they were already
  // proven logged-in by a different (DOM/cookie/auth-gated) signal.
  const isAutoDetected = traceStatus === 'auto-detected';
  // A mismatch is only observable when a final URL was actually recorded. A
  // disk-restored entry (or a trace that only carries an error) has none, and
  // claiming "redirected to " from an absent URL would assert a cause from no
  // evidence — and dereference a missing trace below.
  const redirectMismatch = !staleMismatch && !isAutoDetected && entry?.connected && mustContain && traceFinalUrl && !traceFinalUrl.includes(mustContain.toLowerCase());
  const ambiguousShell = entry?.connected && entry?.lastTrace?.ambiguousShell;
  const connected = entry?.connected
    ? (staleMismatch ? `⚠️ true (last verify ${traceStatus} — URL may have changed)`
      : redirectMismatch ? `⚠️ true (redirected to ${redactReportUrl(entry.lastTrace.finalUrl)} — expected path containing "${mustContain}")`
        : ambiguousShell ? '⚠️ true (AMBIGUOUS shell — no positive logged-in signal; may be a client-rendered login page)'
          : entry?.restoredFromDisk ? '✅ true (restored from prior process)' : '✅ true')
    : entry ? '❌ false' : '— (no entry)';
  const lastConfirmed = entry?.ts
    ? `${new Date(entry.ts).toISOString()} (${Math.round((Date.now() - entry.ts) / 1000)}s ago)`
    : '—';
  const reason = entry?.lastReason ? closeReportDiagnostic(entry.lastReason, 'recorded') : '—';
  return `| \`${p.id}\` | ${p.name} | ${connected} | ${lastConfirmed} | ${reason} |`;
}).join('\n');

// A definitive connected:false verify is preserved in `lastNegative`
// (accounts.js writeStatusCache) even after a later connected:true write
// overwrites `lastTrace` with the positive verdict — otherwise the ONE
// platform whose verify actually misbehaved (a real "not connected" silently
// clobbered by an auto-detected login minutes later) is the one platform a
// bug report can't diagnose. Only surface it here when it tells the reader
// something the current verdict does not: the platform now reads connected,
// but a prior DEFINITIVE not-connected verdict is on record. A currently
// disconnected platform already prints its own reason/trace via `lastTrace`,
// so repeating `lastNegative` there would just restate it. The disk-restored
// shape (selectRestorableStatuses/persistStatusCache) keeps only
// `{ reason, ts }` — never a `trace` — so this must tolerate a traceless
// negative rather than assume the in-memory `{ reason, trace, ts }` shape.
const preservedNegativeVerdict = (entry) => (
  entry?.connected === true && entry?.lastNegative && typeof entry.lastNegative.reason === 'string'
    ? entry.lastNegative
    : null
);

/** Per-platform verify-trace blocks (only platforms with a recorded trace, or a preserved negative worth surfacing). */
export const renderSessionTraceBlocks = (platforms, cache) => platforms.map(p => {
  const entry = cache[p.id];
  const t = entry?.lastTrace;
  const negative = preservedNegativeVerdict(entry);
  if (!t && !negative) return '';
  const lines = [`**${p.name}** (\`${p.id}\`):`];
  if (t) {
    lines.push(
      ...[
        `  - target: \`${redactReportUrl(t.target) || '—'}\``,
        t.finalUrl != null ? `  - finalUrl: \`${redactReportUrl(t.finalUrl)}\`` : null,
        t.status != null ? `  - HTTP status: \`${t.status}\`` : null,
        t.htmlBytes != null ? `  - htmlBytes: \`${t.htmlBytes}\`` : null,
        t.softWallMatch ? '  - softWall: detected' : null,
        t.error ? '  - error: recorded' : null,
        typeof t.authCookiePresent === 'boolean' ? `  - authCookiePresent: \`${t.authCookiePresent}\` (names only; values never exported)` : null,
        Array.isArray(t.authCookieNames) && t.authCookieNames.length > 0 ? `  - authCookieNames: \`${t.authCookieNames.join(', ')}\`` : null,
        t.ambiguousShell ? '  - ⚠️ ambiguousShell: detected' : null,
        t.bodyHead ? '  - pageText: captured (content withheld)' : null,
      ].filter(Boolean),
    );
    if (Array.isArray(t.checks) && t.checks.length > 0) {
      lines.push('  - checks:');
      for (const check of t.checks) {
        const parts = [
          redactReportUrl(check.target) || '—',
          check.status != null ? `HTTP ${check.status}` : null,
          check.finalUrl ? redactReportUrl(check.finalUrl) : null,
          check.softWallMatch ? 'softWall=detected' : null,
          check.antiBot ? `antiBot=${check.antiBot}` : null,
          check.sessionCookieCount != null ? `cookies=${check.sessionCookieCount}` : null,
          check.error ? 'error=recorded' : null,
        ].filter(Boolean);
        lines.push(`    - ${clipReportText(parts.join(' | ').replace(/`/g, "'"), 320)}`);
        // A captured page-text fact distinguishes a body-sniffed verdict from
        // a redirect/status-only verdict. The text itself can be authenticated
        // account content, so it never crosses the report boundary.
        if (!t.bodyHead && check.bodyHead) {
          lines.push('      pageText: captured (content withheld)');
        }
      }
    }
  }
  if (negative) {
    // Same absolute-ISO + relative-seconds style renderSessionRows uses for
    // "Last confirmed" a few lines above in the same report section — keeps a
    // three-week-old preserved negative from reading as if it happened this
    // session, and keeps the two timestamp styles in this section consistent.
    const negTs = Number(negative.ts) || null;
    const negAge = negTs
      ? `${new Date(negTs).toISOString()} (${Math.round((Date.now() - negTs) / 1000)}s ago)`
      : 'time not recorded';
    // This is historical evidence, not a second current verdict. The current
    // row above is connected, but that state may be freshly verified, restored,
    // or defaulted from the absence of a logout signal. Describe only the cache
    // fact shared by all three shapes so a healthy session (notably Indeed in
    // the reported run) does not look contradictory or partially disconnected.
    // `negAge` is the age of the HISTORICAL verdict, so it has to sit beside
    // that clause. Trailing "current cached status is connected" it read as
    // the age of the CURRENT status instead, and on 2026-09-23 that put a
    // 17-day-old stamp (2026-09-06, 1516273s ago) on a LinkedIn row the
    // session table three lines above had verified 6890s ago — two
    // timestamps for one status, apparently contradicting each other, with
    // nothing in the sentence saying they describe different things.
    lines.push(`  - ℹ️ historical NOT-CONNECTED verdict (${negAge}); current cached status is connected.`);
    // The disk-restored shape never carries `trace` (persistStatusCache strips
    // it) — only render this when the in-memory write kept it.
    if (negative.trace && typeof negative.trace === 'object') {
      const nt = negative.trace;
      const negTraceParts = [
        nt.finalUrl != null ? `finalUrl=${redactReportUrl(nt.finalUrl)}` : null,
        nt.status != null ? `HTTP ${nt.status}` : null,
        nt.htmlBytes != null ? `htmlBytes=${nt.htmlBytes}` : null,
        nt.softWallMatch ? 'softWall=detected' : null,
        nt.error ? 'error=recorded' : null,
      ].filter(Boolean);
      if (negTraceParts.length > 0) {
        lines.push(`    - ${clipReportText(negTraceParts.join(' | ').replace(/`/g, "'"), 320)}`);
      }
      if (nt.bodyHead) lines.push('    - pageText: captured (content withheld)');
    }
  }
  return lines.join('\n');
}).filter(Boolean).join('\n\n');
