// Which app this is. One codebase builds three apps:
//
//   canvas      Infinite Canvas — productivity and marketplace only, no job modules
//   job-search  Job Search — searches job sites and writes listings to saved streams
//   job-board   Job Board — reads those streams, scores listings, shows cards, builds applications
//
// 'all' is for tests and an unpackaged run with no role named: every module is
// available, as before the apps were split.
//
// Pure rules only (no Electron, no window), shared by the app process and the
// window so both agree on what each app may do.

export const APP_ROLES = Object.freeze(['canvas', 'job-search', 'job-board', 'all']);

export const APP_ROLE_NAMES = Object.freeze({
  canvas: 'Infinite Canvas',
  'job-search': 'Job Search',
  'job-board': 'Job Board',
  all: 'Infinite Canvas',
});

export function normalizeAppRole(value) {
  return APP_ROLES.includes(value) ? value : 'all';
}

/** What an app does, by role. Each key is a feature area, not a screen. */
const FEATURES = Object.freeze({
  // Job Search modules, job-site logins, the scraper.
  jobSearch: ['job-search', 'all'],
  // Job Board modules, job cards, scoring, application bundles.
  jobBoard: ['job-board', 'all'],
  // Selling modules and marketplace logins.
  marketplace: ['canvas', 'all'],
  // Documents, notes, links, nested canvases: every app is a canvas.
  productivity: ['canvas', 'job-search', 'job-board', 'all'],
});

export function appRoleHas(role, feature) {
  return (FEATURES[feature] || []).includes(normalizeAppRole(role));
}

/** Canvas module types an app may create or show, by role. */
const MODULE_FEATURE = Object.freeze({
  jobhub: 'jobSearch',
  jobsourcecard: 'jobSearch',
  jobboard: 'jobBoard',
  jobcard: 'jobBoard',
  jobgroup: 'jobBoard',
  sellhub: 'marketplace',
  marketplacecard: 'marketplace',
  marketplacestatus: 'marketplace',
  compsourcecard: 'marketplace',
});

export function appRoleAllowsModule(role, nodeType) {
  const feature = MODULE_FEATURE[nodeType];
  return feature ? appRoleHas(role, feature) : true;
}

/** Sidebar tabs an app shows, by role. */
export function appRoleSidebarTabs(role) {
  return [
    ...(appRoleHas(role, 'marketplace') ? ['sell'] : []),
    ...(appRoleHas(role, 'jobSearch') || appRoleHas(role, 'jobBoard') ? ['jobs'] : []),
    ...(appRoleHas(role, 'marketplace') ? ['dashboard'] : []),
  ];
}

/** Job-site and marketplace logins an app verifies at startup: only its own. */
export function appRoleVerifiesPlatform(role, { isJobPlatform = false } = {}) {
  return isJobPlatform ? appRoleHas(role, 'jobSearch') : appRoleHas(role, 'marketplace');
}
