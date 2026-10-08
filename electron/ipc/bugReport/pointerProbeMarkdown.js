// Markdown rendering for the renderer-supplied "Pointer Occlusion Probe".
//
// Every value here is untrusted renderer input: numbers are coerced through
// `Number.isFinite` before Math.round, statuses are compared against a
// whitelist, and free-form strings (an element description, a target id) are
// either validated against a strict character class or dropped entirely.
// Nothing a hostile renderer can place in `pointerProbes` is ever echoed
// verbatim into the report.

const SAFE_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
// The exact grammar the renderer's describe() can produce: `tag`, `tag#id`,
// `tag[data-testid=x]`, or `tag < <one of the previous two>`. Anything else is
// withheld rather than echoed.
const TAG = '[a-z][a-z0-9-]{0,40}';
const LABEL = `${TAG}(?:#[A-Za-z0-9_-]{1,64}|\\[data-testid=[A-Za-z0-9_-]{1,64}\\])`;
const SAFE_OCCLUDER_PATTERN = new RegExp(`^(?:${LABEL}|${TAG}(?: < ${LABEL})?)$`);
const MAX_TARGETS_RENDERED = 12;

const DOCK_STATES = new Set(['absent', 'collapsed', 'expanded', 'unknown']);
const TARGET_STATUSES = new Set([
  'reachable', 'occluded', 'partial', 'missing', 'no-layout', 'offscreen', 'unsupported',
]);

function safeNumber(value) {
  return Number.isFinite(value) ? Math.round(value) : '?';
}

function rectText(rect) {
  if (!rect || typeof rect !== 'object') return 'rect x=? y=? w=? h=?';
  return `rect x=${safeNumber(rect.x)} y=${safeNumber(rect.y)} w=${safeNumber(rect.width)} h=${safeNumber(rect.height)}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function buildWindowSizeLine(frontEndState) {
  const w = frontEndState?.windowInnerWidth;
  const h = frontEndState?.windowInnerHeight;
  if (typeof w === 'number' && typeof h === 'number' && Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
    return `- Window: ${Math.round(w)}×${Math.round(h)} (inner, CSS px)`;
  }
  return '';
}

function safeOccluder(value) {
  if (typeof value !== 'string') return 'an element (description withheld)';
  if (SAFE_OCCLUDER_PATTERN.test(value)) return value;
  return 'an element (description withheld)';
}

function dockLine(probe) {
  const dock = probe.dock || {};
  const state = DOCK_STATES.has(dock.state) ? dock.state : 'unknown';
  if (state === 'absent') return '- AI handoff dock: absent (no dock element in the DOM)';
  if (state === 'expanded' || state === 'collapsed') {
    return `- AI handoff dock: ${state} · ${rectText(dock.rect)}`;
  }
  return '- AI handoff dock: unrecognised state';
}

function statusText(target) {
  const status = TARGET_STATUSES.has(target.status) ? target.status : 'unknown';
  if (status === 'reachable') {
    return `✅ reachable — ${safeNumber(target.reachable)}/${safeNumber(target.sampled)} sampled points hit the control · ${rectText(target.rect)}`;
  }
  if (status === 'occluded' || status === 'partial') {
    const word = status === 'occluded' ? 'occluded' : 'partly occluded';
    const occluder = safeOccluder(target.occludedBy);
    const inDock = target.occluderInDock ? ' (inside the AI handoff dock)' : '';
    return `⚠️ **${word}** — ${safeNumber(target.reachable)}/${safeNumber(target.sampled)} sampled points reach the control; covered by \`${occluder}\`${inDock} · ${rectText(target.rect)}`;
  }
  if (status === 'missing') return 'not in the DOM at capture';
  if (status === 'no-layout') return 'in the DOM but has no layout box';
  if (status === 'offscreen') return 'outside the window (no sampled point is on screen)';
  if (status === 'unsupported') return 'elementFromPoint unavailable';
  return 'unrecognised status';
}

export function buildPointerProbeMarkdown(frontEndState) {
  const probe = frontEndState?.pointerProbes;
  if (!isPlainObject(probe)) return '';

  if (probe.error) {
    return '\n## Pointer Occlusion Probe\n- Probe failed (renderer-side probe-failed); no occlusion data.\n';
  }

  const lines = [];
  lines.push('');
  lines.push('## Pointer Occlusion Probe');
  lines.push('> Whether key controls can actually receive a click right now: document.elementFromPoint on a 3×3 grid inside each control. An occluded control is covered by another element; the occluder is named by tag/id/test-id only, never its text.');
  lines.push(dockLine(probe));

  const targets = Array.isArray(probe.targets) ? probe.targets : [];
  let rendered = 0;
  for (const target of targets) {
    if (rendered >= MAX_TARGETS_RENDERED) break;
    if (!isPlainObject(target)) continue;
    if (typeof target.id !== 'string' || !SAFE_ID_PATTERN.test(target.id)) continue;
    lines.push(`- \`${target.id}\`: ${statusText(target)}`);
    rendered += 1;
  }

  lines.push('');
  return lines.join('\n');
}
