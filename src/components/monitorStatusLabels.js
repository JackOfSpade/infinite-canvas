/**
 * Status-code → human label maps for the monitor pill.
 * Both vocabularies cover the same six status codes that the AI classifier
 * emits via `check-listing-status`; only the wording differs per use case.
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

export const JOB_STATUS_LABELS = {
  live:          'Open',
  sold:          'Filled',
  ended:         'Closed',
  expired:       'Closed', // back-compat: nodes saved before the rename
  'needs-login': 'Needs login',
  error:         'Error',
  unknown:       'Not checked',
};
