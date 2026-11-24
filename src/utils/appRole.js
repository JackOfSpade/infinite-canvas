// The role of the app this window belongs to (see appRoleRules.js). The app
// process passes it to the window; a window with none (tests, a plain browser)
// is 'all'.
import { appRoleAllowsModule, appRoleHas, appRoleSidebarTabs, normalizeAppRole } from './appRoleRules.js';

export const APP_ROLE = normalizeAppRole(typeof window !== 'undefined' ? window.electronAPI?.appRole : null);

export const appHas = feature => appRoleHas(APP_ROLE, feature);
export const appAllowsModule = nodeType => appRoleAllowsModule(APP_ROLE, nodeType);
export const appSidebarTabs = () => appRoleSidebarTabs(APP_ROLE);
