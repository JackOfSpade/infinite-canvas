/**
 * Shape a `checkListingStatus` IPC result (or a thrown error) into the node-data
 * writes both monitor hooks apply. Shared by useMonitorCheck (per-card) and
 * useCheckAllConnected (batch) so the backend response→writes mapping has a
 * single source of truth and the two can't drift.
 *
 * The backend always returns `{ status, message, sources, attention }` — there's
 * no top-level `success` flag (per-URL errors live in `sources`, and the
 * aggregate `status` already reflects them). `fields` maps logical field names
 * (status/message/lastChecked/attention) to the node-data keys to write. The
 * `attention` field is written only when `fields.attention` is provided, so a
 * caller that doesn't track attention (useCheckAllConnected) simply omits it.
 */
export function statusCheckWrites(res, fields) {
  const writes = { [fields.lastChecked]: new Date().toISOString() };
  if (res?.status) {
    writes[fields.status]  = res.status;
    writes[fields.message] = res.message || '';
    if (fields.attention) writes[fields.attention] = Array.isArray(res.attention) ? res.attention : [];
    if (fields.trace) writes[fields.trace] = compactCheckTrace(res);
  } else {
    writes[fields.status]  = 'error';
    writes[fields.message] = res?.error || 'Status check failed';
    if (fields.attention) writes[fields.attention] = [];
    if (fields.trace) writes[fields.trace] = null;
  }
  return writes;
}

/**
 * Compact, bounded per-URL trace of the last status check — the diagnostic the
 * bug report needs to answer "did Check All work?" without the heavy `sources`
 * array (which the card otherwise discards). Keeps the identity anchor (the
 * search needle), the URL count, and one row per URL: label, verdict, whether
 * the anchor matched on that page, the URL itself — so a `/share/<hash>`
 * listing URL is visible, which is the reason a deleted/share-linked card can
 * read "unknown" — and, for an `error` verdict only, a bounded `reason`.
 *
 * The reason matters because the aggregate `status`/`statusMsg` the card shows
 * is the STRONGEST source's verdict (e.g. the platform-watch dashboard that
 * found the listing live), so an errored listing-page check leaves no trace of
 * WHY it failed: a fetch timeout, an anti-bot connection drop, and an AI
 * classification failure all collapse to a bare `listing=error`. Without the
 * reason a systematic source failure (every eBay listing-page check erroring,
 * silently leaning on the watch fallback) is indistinguishable from a one-off
 * blip in the bug report. Other verdicts don't get a reason: live/sold/ended
 * are self-evident, and the winning one is already in statusMsg; unknown is
 * usually the benign "listing not on this dashboard page" and attaching it to
 * every watch row would bloat the trace and break the `×N` collapse.
 *
 * Capped (8 URLs, 120-char URLs, 80-char reason) so it never bloats the
 * persisted canvas.
 */
export function compactCheckTrace(res) {
  if (!res || !Array.isArray(res.sources) || res.sources.length === 0) return null;
  return {
    identifier: res.listingIdentifier || null,
    checked: res.sources.length,
    sources: res.sources.slice(0, 8).map(s => {
      const out = {
        label:   s.urlLabel || null,
        status:  s.status || null,
        matched: typeof s.matched === 'boolean' ? s.matched : null,
        url:     s.url ? String(s.url).slice(0, 120) : null,
      };
      if (s.status === 'error' && s.message) {
        // Drop the `[label]` prefix the formatter adds (the trace already shows
        // the label) so the 80 chars are spent on the actual cause.
        out.reason = String(s.message).replace(/^\[[^\]]+\]\s*/, '').trim().slice(0, 80);
      }
      return out;
    }),
  };
}

export function cachedAuthNeedsLoginResult({ platformId, name, reason } = {}) {
  const platformName = name || platformId || 'Marketplace';
  const detail = reason ? ` ${reason}` : '';
  const message = `${platformName} session needs login.${detail} Open Settings > Accounts and log in to ${platformName}, then run Check All again.`;
  return {
    status: 'needs-login',
    message,
    attention: [],
    sources: [{
      url: null,
      urlLabel: 'session',
      status: 'needs-login',
      message,
    }],
  };
}

/** Writes for a thrown status-check error, clearing stale attention when present. */
export function statusErrorWrites(err, fields) {
  const writes = {
    [fields.status]:      'error',
    [fields.message]:     err?.message || String(err),
    [fields.lastChecked]: new Date().toISOString(),
  };
  if (fields.attention) writes[fields.attention] = [];
  return writes;
}
