/**
 * Status-code → human label map for the marketplace monitor pill — the status
 * codes the AI classifier emits via `check-listing-status`, mapped to wording.
 * (A parallel job-board vocabulary once lived here, but the transient-card
 * overhaul removed job-card monitoring, so only the marketplace map remains.)
 */

export const MARKETPLACE_STATUS_LABELS = {
  live:          'Live',
  sold:          'Sold',
  ended:         'Ended',
  expired:       'Ended', // back-compat: nodes saved before the rename
  'needs-login': 'Needs login',
  error:         'Error',
  unknown:       'Not checked',
};
