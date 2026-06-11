// Shared utilities for bug-report markdown generation. Each is used by at
// least two snapshot builders (jobs, marketplace, persisted-workspace), so
// they live here rather than being duplicated or buried in one module.

// "(Ns ago)" suffix for a timestamp — shared by the pipeline snapshot builders.
export const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  return Number.isFinite(s) ? ` (${s}s ago)` : '';
};

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

// Renders the model that actually served an AI stage (recorded per stage via the
// LLM layer's `meta` out-param). Flags a degraded run: a `*-lite` model = the
// call fell through every stronger model to the weakest fallback — so e.g. a
// "strong match" price is really flash-lite's verdict, not a top model's. Empty
// when no model was recorded (older telemetry).
//
// `fallback` (optional, `{ attempts, reason, counts }` from gemini.js) names WHY
// stronger models were skipped — `rate-limit`/quota (external: wait or upgrade
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
  const weak = /lite/.test(model);
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
  const why = fellBack ? `${causeLabel(fallback)}: ${fallback.attempts} stronger model(s) failed` : '';
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
export const pipelineScope = (nodeId, windowId, currentNodeIds, reportWindowId) => {
  if (windowId != null && reportWindowId != null && windowId !== reportWindowId) {
    return {
      foreign: true,
      note: "> (No run recorded for this canvas this session — these pipeline tallies are a main-process singleton shared by every open window, and the most recent run was in a DIFFERENT window/canvas, so it is omitted here rather than misattributed to this one.)\n",
    };
  }
  if (!nodeId) return { foreign: false, note: '' };
  const short = shortId(nodeId);
  const deleted = currentNodeIds && currentNodeIds.size > 0 && !currentNodeIds.has(nodeId);
  return {
    foreign: false,
    note: `> Source node: \`${short}\`${deleted ? ' (hub since deleted from this canvas — telemetry retained so the run still reports)' : ''}.\n`,
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
  const redirectMismatch = !staleMismatch && !isAutoDetected && entry?.connected && mustContain && !traceFinalUrl.includes(mustContain.toLowerCase());
  const connected = entry?.connected
    ? (staleMismatch ? `⚠️ true (last verify ${traceStatus} — URL may have changed)`
      : redirectMismatch ? `⚠️ true (redirected to ${entry.lastTrace.finalUrl} — expected path containing "${mustContain}")`
        : '✅ true')
    : entry ? '❌ false' : '— (no entry)';
  const lastConfirmed = entry?.ts
    ? `${new Date(entry.ts).toISOString()} (${Math.round((Date.now() - entry.ts) / 1000)}s ago)`
    : '—';
  const reason = entry?.lastReason ? entry.lastReason.replace(/\|/g, '\\|') : '—';
  return `| \`${p.id}\` | ${p.name} | ${connected} | ${lastConfirmed} | ${reason} |`;
}).join('\n');

/** Per-platform verify-trace blocks (only platforms with a recorded trace). */
export const renderSessionTraceBlocks = (platforms, cache) => platforms.map(p => {
  const t = cache[p.id]?.lastTrace;
  if (!t) return '';
  const lines = [
    `**${p.name}** (\`${p.id}\`):`,
    `  - target: \`${t.target || '—'}\``,
    t.finalUrl != null ? `  - finalUrl: \`${t.finalUrl}\`` : null,
    t.status != null ? `  - HTTP status: \`${t.status}\`` : null,
    t.htmlBytes != null ? `  - htmlBytes: \`${t.htmlBytes}\`` : null,
    t.softWallMatch ? `  - softWallMatch: \`${t.softWallMatch}\`` : null,
    t.error ? `  - error: \`${t.error}\`` : null,
    t.bodyHead ? `  - bodyHead: \`${t.bodyHead.replace(/`/g, "'").slice(0, 240)}\`` : null,
  ].filter(Boolean);
  if (Array.isArray(t.checks) && t.checks.length > 0) {
    lines.push('  - checks:');
    for (const check of t.checks) {
      const parts = [
        check.target || '—',
        check.status != null ? `HTTP ${check.status}` : null,
        check.finalUrl || null,
        check.softWallMatch ? `softWall=${check.softWallMatch}` : null,
        check.antiBot ? `antiBot=${check.antiBot}` : null,
        check.sessionCookieCount != null ? `cookies=${check.sessionCookieCount}` : null,
        check.error ? `error=${check.error}` : null,
      ].filter(Boolean);
      lines.push(`    - ${parts.join(' | ').replace(/`/g, "'").slice(0, 320)}`);
    }
  }
  return lines.join('\n');
}).filter(Boolean).join('\n\n');
