// Interview Helper card geometry. The card grows sideways as its content
// grows so the whole card fits on screen at the largest readable zoom,
// instead of becoming one very tall strip that must be zoomed out to see.
export const INTERVIEW_HELPER_COLUMN_WIDTH = 348;
export const INTERVIEW_HELPER_COLUMN_GAP = 20;
const BODY_PADDING = 24;
const HEADER_HEIGHT = 60;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 4;
// A different column count must fit at least this much larger before the card
// switches, so a near-tie cannot flip back and forth as content reflows.
const SWITCH_GAIN = 1.08;

export function interviewHelperCardWidth(columns) {
  return BODY_PADDING + columns * INTERVIEW_HELPER_COLUMN_WIDTH + (columns - 1) * INTERVIEW_HELPER_COLUMN_GAP;
}

/**
 * Column count whose card fits the viewport at the largest zoom.
 * singleColumnHeight is the body's content height laid out in one column.
 */
export function interviewHelperColumns(singleColumnHeight, viewport, current = MIN_COLUMNS) {
  if (!(singleColumnHeight > 0) || !(viewport?.width > 0) || !(viewport?.height > 0)) return current;
  const fitZoom = columns => Math.min(
    viewport.width / interviewHelperCardWidth(columns),
    viewport.height / (HEADER_HEIGHT + BODY_PADDING + singleColumnHeight / columns),
  );
  let best = current;
  for (let columns = MIN_COLUMNS; columns <= MAX_COLUMNS; columns += 1) {
    if (fitZoom(columns) > fitZoom(best)) best = columns;
  }
  return best !== current && fitZoom(best) > fitZoom(current) * SWITCH_GAIN ? best : current;
}
