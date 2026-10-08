// Renderer-side "Pointer Occlusion Probe".
//
// A bug report can describe *what* a control is, but not whether it can
// actually receive a click. This helper samples the points inside the toolbar
// Settings button with `document.elementFromPoint` and reports how many of
// them resolve to the control itself versus some other element covering it —
// which is exactly the failure mode where a fixed, bottom-right AI-handoff
// dock sits on top of the toolbar control.
//
// The bug-report dialog is open at the instant a report is captured, and its
// invisible full-screen backdrop would otherwise "cover" every control. Anything
// inside an element marked `data-pointer-probe-ignore` (see Dialog's
// `probePassthrough`) is looked through: the probe asks for the whole stack at
// each point (`elementsFromPoint`) and takes the first element that is not part
// of an ignored subtree.
//
// Privacy rule: an element description is built ONLY from its tag name and an
// optional `#id` or `[data-testid=...]` attribute. It never contains text
// content, class names, hrefs, aria labels, or input values.

export const POINTER_PROBE_TARGETS = Object.freeze([
  Object.freeze({ id: 'canvas-settings-button', selector: '[data-testid="canvas-settings-button"]' }),
]);

export const POINTER_PROBE_GRID = 3;

const IGNORE_SELECTOR = '[data-pointer-probe-ignore]';
const ID_OR_TESTID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function roundedRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function elementLabel(el) {
  if (!el) return null;
  const tag = String(el.tagName || '').toLowerCase() || 'element';
  if (el.id && ID_OR_TESTID_PATTERN.test(el.id)) {
    return `${tag}#${el.id}`;
  }
  if (el.dataset && el.dataset.testid && ID_OR_TESTID_PATTERN.test(el.dataset.testid)) {
    return `${tag}[data-testid=${el.dataset.testid}]`;
  }
  return null;
}

function describe(el) {
  if (!el) return 'an element';
  const direct = elementLabel(el);
  if (direct) return direct;
  const tag = String(el.tagName || '').toLowerCase() || 'element';
  let ancestor = el.parentElement;
  for (let level = 0; level < 4 && ancestor; level += 1) {
    const label = elementLabel(ancestor);
    if (label) {
      return `${tag} < ${label}`;
    }
    ancestor = ancestor.parentElement;
  }
  return tag;
}

// The element a click at (x, y) would reach, looking through ignored subtrees.
// Without `elementsFromPoint` the top element is all there is to go on.
function hitAt(doc, x, y) {
  if (typeof doc.elementsFromPoint === 'function') {
    const stack = doc.elementsFromPoint(x, y) || [];
    return stack.find(candidate => !(candidate.closest && candidate.closest(IGNORE_SELECTOR))) || null;
  }
  return doc.elementFromPoint(x, y);
}

function dockState(doc) {
  const el = doc.querySelector('[data-handoff-dock]');
  if (!el) return { state: 'absent', rect: null };
  const raw = el.getAttribute('data-handoff-dock');
  const state = raw === 'expanded' || raw === 'collapsed' ? raw : 'unknown';
  return { state, rect: roundedRect(el.getBoundingClientRect()) };
}

export function collectPointerProbes(doc = globalThis.document, win = globalThis.window) {
  try {
    const result = {
      v: 1,
      dock: dockState(doc),
      targets: [],
    };

    const supportsElementFromPoint = typeof doc.elementsFromPoint === 'function'
      || typeof doc.elementFromPoint === 'function';

    for (const target of POINTER_PROBE_TARGETS) {
      const el = doc.querySelector(target.selector);
      if (!el) {
        result.targets.push({
          id: target.id,
          status: 'missing',
          rect: null,
          reachable: 0,
          sampled: 0,
          occludedBy: null,
          occluderInDock: false,
        });
        continue;
      }

      const rect = roundedRect(el.getBoundingClientRect());

      if (rect.width <= 0 || rect.height <= 0) {
        result.targets.push({
          id: target.id,
          status: 'no-layout',
          rect,
          reachable: 0,
          sampled: 0,
          occludedBy: null,
          occluderInDock: false,
        });
        continue;
      }

      if (!supportsElementFromPoint) {
        result.targets.push({
          id: target.id,
          status: 'unsupported',
          rect,
          reachable: 0,
          sampled: 0,
          occludedBy: null,
          occluderInDock: false,
        });
        continue;
      }

      const points = [];
      for (let i = 0; i < POINTER_PROBE_GRID; i += 1) {
        for (let j = 0; j < POINTER_PROBE_GRID; j += 1) {
          const x = rect.x + (rect.width * (i + 0.5)) / POINTER_PROBE_GRID;
          const y = rect.y + (rect.height * (j + 0.5)) / POINTER_PROBE_GRID;
          if (x >= 0 && x < win.innerWidth && y >= 0 && y < win.innerHeight) {
            points.push({ x, y });
          }
        }
      }

      if (points.length === 0) {
        result.targets.push({
          id: target.id,
          status: 'offscreen',
          rect,
          reachable: 0,
          sampled: 0,
          occludedBy: null,
          occluderInDock: false,
        });
        continue;
      }

      let reachable = 0;
      let firstOccluder = null;
      for (const point of points) {
        const hit = hitAt(doc, point.x, point.y);
        if (hit === el || (hit && el.contains(hit))) {
          reachable += 1;
        } else if (firstOccluder === null) {
          firstOccluder = hit || null;
        }
      }

      const sampled = points.length;
      let status;
      if (reachable === sampled) status = 'reachable';
      else if (reachable === 0) status = 'occluded';
      else status = 'partial';

      let occludedBy = null;
      let occluderInDock = false;
      if ((status === 'occluded' || status === 'partial') && firstOccluder) {
        occludedBy = describe(firstOccluder);
        occluderInDock = Boolean(firstOccluder.closest && firstOccluder.closest('[data-handoff-dock]'));
      }

      result.targets.push({
        id: target.id,
        status,
        rect,
        reachable,
        sampled,
        occludedBy,
        occluderInDock,
      });
    }

    return result;
  } catch {
    return { v: 1, error: 'probe-failed' };
  }
}
