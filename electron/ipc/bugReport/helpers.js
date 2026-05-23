// Shared utilities for bug-report markdown generation. Each is used by at
// least two snapshot builders (jobs, marketplace, persisted-workspace), so
// they live here rather than being duplicated or buried in one module.

// "(Ns ago)" suffix for a timestamp — shared by the pipeline snapshot builders.
export const ago = (ts) => {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  return Number.isFinite(s) ? ` (${s}s ago)` : '';
};

// Renders the model that actually served an AI stage (recorded per stage via the
// LLM layer's `meta` out-param). Flags a degraded run: a `*-lite` model = the
// call fell through every stronger model (404/quota) to the weakest fallback —
// so e.g. a "strong match" price is really flash-lite's verdict, not a top
// model's. Empty when no model was recorded (older telemetry).
export const modelTag = (model) => {
  if (!model) return '';
  const weak = /lite/.test(model);
  return ` · model: \`${model}\`${weak ? ' ⚠️ weak fallback' : ''}`;
};

// Produce a short but meaningful identifier for any node ID.
// UUID-style IDs (e.g. "3539d90c-e09d-…") are unique in their first segment,
// so we show the first 8 chars. All other IDs (e.g. "job-1779484861758-job-0",
// "job-1779484861758-cat-2-buc-1") embed a shared timestamp prefix that makes
// the first 8 chars identical across every job node — we show the last 8 chars
// instead so the unique suffix ("-job-0", "-buc-1") is visible.
export const shortId = (id) => {
  const s = String(id);
  if (s.length <= 8) return s;
  if (/^[0-9a-f]{8}-/.test(s)) return s.slice(0, 8); // UUID: first segment is unique
  return `…${s.slice(-8)}`;                           // timestamp-prefixed: show suffix
};

// Decides whether a pipeline's telemetry belongs to the current canvas window
// and produces the section-header note that explains the attribution. The
// telemetry singletons (jobs/marketplace) are shared across every open window
// — without this scope check, the most recent run from window B would appear
// in window A's bug report. The originating window id (webContents id) is the
// authoritative scope: if it differs from the window that requested the
// report, the run is another canvas's and is OMITTED — the report only
// reflects the canvas it was triggered from.
//
// Node presence alone can't decide this: a node missing from the current canvas
// could be another window's node OR this window's hub that the user DELETED after
// the run (the telemetry deliberately outlives the hub — that's its whole point).
// So node presence only refines the wording for same-window runs; windowId
// decides inclusion. Unknown ids (older telemetry / no sender) → treat as local.
export const pipelineScope = (nodeId, windowId, currentNodeIds, reportWindowId) => {
  if (windowId != null && reportWindowId != null && windowId !== reportWindowId) {
    return {
      foreign: true,
      note: "> (No run recorded for this canvas this session — these pipeline tallies are a main-process singleton shared by every open window, and the most recent run was in a DIFFERENT window/canvas, so it is omitted here rather than misattributed to this one.)\n",
    };
  }
  if (!nodeId) return { foreign: false, note: '' };
  const short = shortId(nodeId);
  const deleted = currentNodeIds && currentNodeIds.size > 0 && !currentNodeIds.has(nodeId);
  return {
    foreign: false,
    note: `> Source node: \`${short}\`${deleted ? ' (hub since deleted from this canvas — telemetry retained so the run still reports)' : ''}.\n`,
  };
};
