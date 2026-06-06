// Aggregates per-source scrape progress across a MULTI-ITEM price run so the
// hub's ephemeral comp-source cards behave exactly as they do for a single item
// — except a source only reports its terminal (done/error) after EVERY item has
// finished it, instead of after the first. The cards subscribe to the raw
// `price-source-progress` IPC stream and auto-dismiss 3s after they see `done`,
// so withholding `done` until the last item is what keeps a source card on
// screen (spinning) across all item runs. No card-side change needed.
//
// Single-item runs (totalItems === 1) pass terminals straight through, so the
// existing one-item flow is byte-for-byte unchanged.
//
// Pure + dependency-free (no electron) so the test runner can drive it directly.

/**
 * @param {object}   opts
 * @param {number}   opts.totalItems  how many items this run will scrape
 * @param {(payload: object) => void} opts.send  emits one `price-source-progress`
 *        payload (the caller adds nodeId + ships it over IPC)
 * @returns {(itemIndex: number) => (sourceId: string, payload: object) => void}
 *   a factory: call it once per item to get that item's `emit(sourceId, payload)`.
 */
export function createAggregatingProgress({ totalItems, send }) {
  // sourceId -> { count, warning, url, errored }
  const agg = new Map();
  const slot = (id) => {
    let a = agg.get(id);
    if (!a) { a = { count: 0, warning: null, url: null, errored: false }; agg.set(id, a); }
    return a;
  };

  return function emitForItem(itemIndex) {
    const isLast = itemIndex >= totalItems - 1;
    return function emit(sourceId, payload = {}) {
      const status = payload.status;

      // "searching" = a source announcing it has started. The first item seeds
      // the spinner; later items' re-announcements are swallowed so the running
      // count carried on the card isn't blanked back to 0 mid-run.
      if (status === 'searching') {
        if (itemIndex === 0) send({ sourceId, status: 'searching', count: payload.count ?? 0 });
        return;
      }

      // Terminal for THIS item (done | error) → fold into the cross-item total.
      const a = slot(sourceId);
      if (typeof payload.count === 'number') a.count += payload.count;
      if (payload.warning) a.warning = payload.warning;       // sticky: a block in any item keeps the card blocked
      if (payload.url) a.url = payload.url;
      if (status === 'error') a.errored = true;

      if (!isLast) {
        // Not the last item yet — keep the card spinning, but surface cumulative
        // progress so a long bundle run isn't a frozen spinner.
        send({ sourceId, status: 'searching', count: a.count, completed: itemIndex + 1, total: totalItems });
      } else {
        // Last item finished this source → release the real terminal.
        send({
          sourceId,
          status: a.errored ? 'error' : 'done',
          count: a.count,
          warning: a.warning,
          url: a.url,
        });
      }
    };
  };
}
