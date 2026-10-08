// This switch exists solely for the headed, disposable acceptance fixture.
// macOS Accessibility expands every native submenu while building an AX tree;
// the normal application menu therefore makes computer-use binding needlessly
// expensive.  It must be an explicit argv token, never an environment toggle,
// so ordinary launches retain their complete native menu.
export const ACCEPTANCE_NO_NATIVE_MENU_FLAG = '--acceptance-no-native-menu';

export function isAcceptanceNoNativeMenu(commandLine = []) {
  return Array.isArray(commandLine)
    && commandLine.includes(ACCEPTANCE_NO_NATIVE_MENU_FLAG);
}

export function shouldSuppressNativeApplicationMenu({ isBackgroundE2E = false, commandLine = [] } = {}) {
  return isBackgroundE2E === true || isAcceptanceNoNativeMenu(commandLine);
}

// `accessory` leaves a headed, focusable BrowserWindow and all renderer/IPC
// services alive, but removes the regular Dock/menu-bar application surface
// whose Apple/Services menus make macOS AX enumeration unbounded in CUA.
export function acceptanceActivationPolicy({ platform = process.platform, commandLine = [] } = {}) {
  return platform === 'darwin' && isAcceptanceNoNativeMenu(commandLine) ? 'accessory' : null;
}
