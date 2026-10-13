/** Pure policy for the v8 blind-review panel. */
import { APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE } from './applicationAuthorityWorkflow.js';

export { APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE } from './applicationAuthorityWorkflow.js';
/** Historical plans retain their all-blocking meaning. Fact scopes cannot be demoted. */
export function applicationBlindReviewFindingKind(promptMode, track, finding = {}) {
  if (promptMode !== APPLICATION_BLIND_REVIEW_PANEL_PROMPT_MODE || track === 'fact-fidelity') return 'truth';
  return finding?.kind === 'truth' ? 'truth' : 'editorial';
}
