let uiState = Object.freeze({ popoverOpen: false, setup: null });
let uiListeners = new Set();
function publish(next) { if (next.popoverOpen === uiState.popoverOpen && next.setup?.step === uiState.setup?.step) return; uiState = Object.freeze(next); for (const listener of [...uiListeners]) { try { listener(); } catch { /* isolated UI subscriber */ } } }
export function getBridgeUiState() { return uiState; }
export function subscribeBridgeUi(listener) { if (typeof listener !== 'function') return () => {}; uiListeners.add(listener); return () => uiListeners.delete(listener); }
export function openBridgePopover() { publish({ ...uiState, popoverOpen: true }); }
export function closeBridgePopover() { publish({ ...uiState, popoverOpen: false }); }
export function toggleBridgePopover() { publish({ ...uiState, popoverOpen: !uiState.popoverOpen }); }
export function openBridgeSetup(step = 1) { const safeStep = Number.isInteger(step) && step >= 1 && step <= 4 ? step : 1; publish({ popoverOpen: false, setup: Object.freeze({ step: safeStep }) }); }
export function closeBridgeSetup() { publish({ ...uiState, setup: null }); }
export function __resetBridgeUiForTests() { uiState = Object.freeze({ popoverOpen: false, setup: null }); uiListeners = new Set(); }
