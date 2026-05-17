/**
 * Status-code → human label maps for the monitor pill.
 * Both vocabularies cover the same six status codes that the AI classifier
 * emits via `check-listing-status`; only the wording differs per use case.
 */

export const MARKETPLACE_STATUS_LABELS = {
  live:          'Live',
  sold:          'Sold',
  expired:       'Expired',
  'needs-login': 'Needs login',
  error:         'Error',
  unknown:       'Not checked',
};

export const JOB_STATUS_LABELS = {
  live:          'Open',
  sold:          'Filled',
  expired:       'Closed',
  'needs-login': 'Needs login',
  error:         'Error',
  unknown:       'Not checked',
};
