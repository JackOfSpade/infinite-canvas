// Small DOM-touching helper kept OUT of layoutGeometry.js — that file is
// documented and relied upon as pure (no React, no DOM) so it can run under
// the plain-node test runner; this one can't be, since it reads layout from
// the live page.

/**
 * Screen-pixel size of the ReactFlow viewport's container element, with a
 * window-size fallback for the (rare) case the viewport DOM node isn't
 * mounted yet. Used to center content in the visible flow area — callers that
 * need FLOW-space (not screen) dimensions divide by the current zoom
 * themselves, since that varies by call site (see pasteNodes' flow-space
 * centering vs diveIn's screen-space viewport centering).
 * @returns {{ width: number, height: number }}
 */
export function getReactFlowContainerSize() {
  const viewportNode = document.querySelector('.react-flow__viewport');
  const container = viewportNode?.parentElement;
  return {
    width: container ? container.clientWidth : window.innerWidth,
    height: container ? container.clientHeight : window.innerHeight,
  };
}
