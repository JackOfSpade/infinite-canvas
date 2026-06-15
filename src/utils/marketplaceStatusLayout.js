/**
 * Marketplace Status layout geometry.
 *
 * Cards stay a fixed width, so evaluating every possible column count is stable:
 * card wrapping never changes while a candidate layout is measured. The caller
 * supplies measured collapsed card heights and non-grid overhead; first paint
 * falls back to the estimates below. Log-symmetric ratio error treats "2x too
 * tall" and "2x too wide" equally.
 */
export const MARKETPLACE_STATUS_GRID = {
  CARD_W: 272,
  CARD_H_EST: 104,
  GAP: 8,
  PAD: 12,
  HEADER_H: 46,
  BUTTON_BLOCK_H: 40,
};

const TARGET_RATIO = 16 / 9;
const OVERHEAD_EST = MARKETPLACE_STATUS_GRID.HEADER_H
  + MARKETPLACE_STATUS_GRID.BUTTON_BLOCK_H
  + 2 * MARKETPLACE_STATUS_GRID.PAD;

export function marketplaceStatusNodeWidth(cols) {
  const safeCols = Math.max(1, Number(cols) || 1);
  return safeCols * MARKETPLACE_STATUS_GRID.CARD_W
    + (safeCols - 1) * MARKETPLACE_STATUS_GRID.GAP
    + 2 * MARKETPLACE_STATUS_GRID.PAD;
}

export function bestMarketplaceStatusColumnCount(n, heights = [], overhead) {
  if (n <= 1) return 1;
  const oh = overhead > 0 ? overhead : OVERHEAD_EST;
  let best = 1;
  let bestErr = Infinity;

  for (let cols = 1; cols <= n; cols++) {
    const gridRows = Math.ceil(n / cols);
    let gridH = (gridRows - 1) * MARKETPLACE_STATUS_GRID.GAP;
    for (let row = 0; row < gridRows; row++) {
      let rowMax = 0;
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (index >= n) break;
        rowMax = Math.max(rowMax, heights[index] || MARKETPLACE_STATUS_GRID.CARD_H_EST);
      }
      gridH += rowMax;
    }

    const width = marketplaceStatusNodeWidth(cols);
    const height = oh + gridH;
    const error = Math.abs(Math.log(width / height / TARGET_RATIO));
    if (error < bestErr) {
      bestErr = error;
      best = cols;
    }
  }
  return best;
}
