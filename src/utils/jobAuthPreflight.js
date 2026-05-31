import { getScopedJobSourceIds } from './jobSourceScope.js';

// Sources that must have a verified browser session before the main job-search
// pipeline starts. LinkedIn is intentionally excluded: its listing fetch uses
// the public guest API and description enrichment uses anonymous JSON-LD pages,
// so requiring a LinkedIn login blocks a source that can run without one.
export const JOB_AUTH_PREFLIGHT_SOURCE_IDS = [
  'google',
  'indeed',
  'glassdoor',
  'ziprecruiter',
];

export function getJobAuthPreflightSourceIds(scoper = getScopedJobSourceIds) {
  return scoper(JOB_AUTH_PREFLIGHT_SOURCE_IDS);
}
