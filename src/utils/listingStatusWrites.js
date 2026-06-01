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
  } else {
    writes[fields.status]  = 'error';
    writes[fields.message] = res?.error || 'Status check failed';
    if (fields.attention) writes[fields.attention] = [];
  }
  return writes;
}

/** Writes for a thrown status-check error (no `attention` — matches both hooks). */
export function statusErrorWrites(err, fields) {
  return {
    [fields.status]:      'error',
    [fields.message]:     err?.message || String(err),
    [fields.lastChecked]: new Date().toISOString(),
  };
}
