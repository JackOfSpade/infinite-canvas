// Which drag cue a hub (jobhub / sellhub) paints while something hovers it.
//
// Pure so the accept/refuse policy is unit-testable without a renderer —
// HubContainer.jsx owns only the styling of whatever this returns, and the
// border, the outer halo and the floating chip all read this one value so they
// can never disagree about whether the drop will be taken.
//
// Two independent drag lanes feed it:
//   • the canvas-node lane, which arrives as `dragHover` — a { kind, label }
//     verdict already computed by buildHubHoverState (hubNodeDrop.js);
//   • the OS/Finder file lane, which arrives as `isDragOver` — a bare "a drag
//     is overhead" boolean with no verdict of its own, because the HTML5
//     dataTransfer exposes no readable paths during dragover.

export function resolveHubDropCue({
  dragHover = null,
  isDragOver = false,
  dropsBlocked = false,
  dropBlockedLabel = null,
} = {}) {
  const dragActive = !!isDragOver || !!dragHover;
  if (!dragActive) return null;

  // A refusal always paints, dropsBlocked or not. It used to be suppressed
  // alongside everything else whenever dropsBlocked was true, which made it
  // unreachable in practice: buildHubHoverState takes its reject label from
  // getHubDropRejectLabel, which is non-null under exactly the lock reasons
  // that raise dropsBlocked. 'Locked', 'Busy' and 'Already started' were
  // therefore recomputed every frame and never once shown, and the hub went
  // completely dark in the very states it had already written an honest
  // explanation for.
  if (dragHover?.kind === 'reject') return dragHover;

  if (dropsBlocked) {
    // The file lane carries no verdict, so it borrows the reason the hub
    // supplies. With no reason to show, stay silent rather than paint an
    // unexplained red ring.
    return dropBlockedLabel ? { kind: 'reject', label: dropBlockedLabel } : null;
  }

  // An accept cue never survives dropsBlocked — promising a drop that the drop
  // handler is about to bounce would be a lie. `label: null` lets the caller
  // fall back to its own generic invitation ("Drop career files" / "Drop
  // photos") for a file drag that has no verdict to report.
  return dragHover || { kind: 'accept', label: null };
}
