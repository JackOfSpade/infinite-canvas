/**
 * Status-code → human label map for the Marketplace Status Module's per-platform
 * monitor pill — the hub-scan read states (`ok` / `needs-login` / `error` /
 * `unknown`) mapped to wording. (A per-listing label map and a job-board
 * vocabulary once lived here too, but both of those monitoring paths were
 * removed, so only the hub-scan map remains.)
 */

const MARKETPLACE_HUB_STATUS_LABELS = {
  ok:            'Checked',
  'needs-login': 'Login needed',
  error:         'Error',
  unknown:       'Unknown',
};

/** Marketplace Status Module labels use platform-level hub-scan states. */
export function getMarketplaceHubStatusLabel(status, lastChecked) {
  if ((!status || status === 'unknown') && !lastChecked) return 'Not checked';
  return MARKETPLACE_HUB_STATUS_LABELS[status] || MARKETPLACE_HUB_STATUS_LABELS.unknown;
}
