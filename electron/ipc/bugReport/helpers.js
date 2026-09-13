// Shared utilities for bug-report markdown generation. Each is used by at
// least two snapshot builders (jobs, marketplace, persisted-workspace), so
// they live here rather than being duplicated or buried in one module.

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
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return `${parsed.origin}${parsed.pathname}`;
    }
    return raw.split(/[?#]/, 1)[0];
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
}

/** Remove query/hash data from every absolute HTTP(S) URL embedded in prose. */
export function redactReportUrlsInText(value) {
  return String(value || '').replace(/https?:\/\/[^\s`<>"|]+/gi, (match) => {
    // Sentence/table punctuation is not part of the URL. Preserve it after the
    // redacted identity so prose remains readable.
    const suffixMatch = match.match(/[)\]}.,;:]+$/);
    const suffix = suffixMatch?.[0] || '';
    const url = suffix ? match.slice(0, -suffix.length) : match;
    return `${redactReportUrl(url)}${suffix}`;
  });
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

const EVENT_SENSITIVE_ASSIGNMENT = /\b(q|query|rawquery|searchquery|careerquery|targetrole|careertarget|preferences?|htidocid|documentid|document|docid)(\s*(?:=|:)\s*)("[^"\r\n]*"|'[^'\r\n]*'|`[^`\r\n]*`|.*?)(?=(?:\s*(?:[,;|]\s*)?[A-Za-z][A-Za-z0-9_-]{0,40}\s*[=:])|[\r\n]|$)/gi;

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
  let text = redactReportUrlsInText(String(value));

  // These are the prose forms emitted by JobSearchNode / JobGroupNode. Match
  // only an explicit sensitive cue and quoted value; ordinary quoted event
  // labels remain intact.
  text = text
    // The value itself can contain a quote (for example a search for
    // `"Staff" engineer`), so consume through the last quote on this event
    // line rather than exposing the suffix after its first embedded quote.
    .replace(/(\b(?:for\s+query|search\s+query)\s*:\s*)"[^\r\n]*"/gi, '$1"[redacted query]"')
    .replace(/(\bsearching\s+exactly\s*)"[^\r\n]*"/gi, '$1"[redacted target role]"')
    .replace(/(\bshow\s+more\s+in\s+role\s*)"[^\r\n]*"/gi, '$1"[redacted role]"');

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
// LLM layer's `meta` out-param). Flags a degraded run: a `*-lite` model is weak
// only when the task preferred a non-lite model (or older telemetry did not
// record the preference). Lightweight tasks legitimately prefer Lite.
//
// `fallback` (optional, `{ attempts, reason, counts, preferredModel }` from
// gemini.js) names WHY earlier models were skipped — `rate-limit`/quota (external: wait or upgrade
// tier), `truncation` (our token cap is too low: raise it in llm.js), or `server`
// (overload). Without it, "weak fallback" collapses three causes with opposite
// fixes into one ambiguous flag, and the reason otherwise lives only in the
// scrolling log buffer. A non-lite model that still fell back is noted lightly
// (e.g. pro→flash on quota is a milder degradation, but still "not as expected").
//
// A MIXED chain (e.g. two models 429'd but a third truncated) is the trap: `reason`
// is only the DOMINANT cause, so a sole "rate-limit" hides a truncation whose fix
// (raise our cap) is the opposite of quota's (wait/upgrade). gemini.js already
// records the full per-cause `counts`, so when more than one cause appears we
// render the breakdown ("rate-limit×2 + truncation×1") instead of just the winner.
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
  const short = shortId(nodeId);
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
  const reason = entry?.lastReason ? redactReportUrlsInText(entry.lastReason).replace(/\|/g, '\\|') : '—';
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
        t.pageTitle ? `  - pageTitle: \`${clipReportText(String(t.pageTitle).replace(/`/g, "'"), 160)}\`` : null,
        t.softWallMatch ? `  - softWallMatch: \`${t.softWallMatch}\`` : null,
        t.error ? `  - error: \`${redactReportUrlsInText(t.error)}\`` : null,
        typeof t.authCookiePresent === 'boolean' ? `  - authCookiePresent: \`${t.authCookiePresent}\` (names only; values never exported)` : null,
        Array.isArray(t.authCookieNames) && t.authCookieNames.length > 0 ? `  - authCookieNames: \`${t.authCookieNames.join(', ')}\`` : null,
        t.ambiguousShell ? `  - ⚠️ ambiguousShell: ${(t.ambiguousReason || 'body matched no logged-in marker (likely an unrendered SSR shell / inline login form)').replace(/`/g, "'")}` : null,
        t.bodyHead ? `  - bodyHead: \`${clipReportText(t.bodyHead.replace(/`/g, "'"), 240)}\`` : null,
      ].filter(Boolean),
    );
    if (Array.isArray(t.checks) && t.checks.length > 0) {
      lines.push('  - checks:');
      for (const check of t.checks) {
        const parts = [
          redactReportUrl(check.target) || '—',
          check.status != null ? `HTTP ${check.status}` : null,
          check.finalUrl ? redactReportUrl(check.finalUrl) : null,
          check.softWallMatch ? `softWall=${check.softWallMatch}` : null,
          check.antiBot ? `antiBot=${check.antiBot}` : null,
          check.sessionCookieCount != null ? `cookies=${check.sessionCookieCount}` : null,
          check.error ? `error=${redactReportUrlsInText(check.error)}` : null,
        ].filter(Boolean);
        lines.push(`    - ${clipReportText(parts.join(' | ').replace(/`/g, "'"), 320)}`);
        // Surface the captured visible-text head per check. The top-level bodyHead
        // is only set on the CONNECTED return path, so on a verify FAILURE
        // (soft-wall match, redirect, 401/403) the page text was captured per-check
        // but never rendered — leaving "logged out per body sniff" with no way to
        // see WHAT the page actually said. That's the difference between "genuinely
        // logged out (login form / sign-in shell)" and "logged in but the signal
        // mis-fired / an SPA hadn't client-rendered the account UI yet". Only when
        // the top-level bodyHead is absent, to avoid duplicating it for connected.
        if (!t.bodyHead && check.bodyHead) {
          lines.push(`      bodyHead: \`${clipReportText(String(check.bodyHead).replace(/`/g, "'"), 240)}\``);
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
    lines.push(`  - ℹ️ historical NOT-CONNECTED verdict; current cached status is connected (${negAge}): ${redactReportUrlsInText(negative.reason)}`);
    // The disk-restored shape never carries `trace` (persistStatusCache strips
    // it) — only render this when the in-memory write kept it.
    if (negative.trace && typeof negative.trace === 'object') {
      const nt = negative.trace;
      const negTraceParts = [
        nt.finalUrl != null ? `finalUrl=${redactReportUrl(nt.finalUrl)}` : null,
        nt.status != null ? `HTTP ${nt.status}` : null,
        nt.htmlBytes != null ? `htmlBytes=${nt.htmlBytes}` : null,
        nt.softWallMatch ? `softWall=${nt.softWallMatch}` : null,
        nt.error ? `error=${redactReportUrlsInText(nt.error)}` : null,
      ].filter(Boolean);
      if (negTraceParts.length > 0) {
        lines.push(`    - ${clipReportText(negTraceParts.join(' | ').replace(/`/g, "'"), 320)}`);
      }
      if (nt.bodyHead) {
        lines.push(`    - bodyHead: \`${clipReportText(String(nt.bodyHead).replace(/`/g, "'"), 240)}\``);
      }
    }
  }
  return lines.join('\n');
}).filter(Boolean).join('\n\n');
