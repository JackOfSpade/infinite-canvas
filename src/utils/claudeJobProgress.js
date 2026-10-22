// Live progress for ONE application bundle the local Claude runner is
// answering. Pure: everything comes in as arguments. It returns the same view
// shape as deriveBridgeJobProgress so the dock shows the same four-step UI no
// matter which backend answers.
//
// What the inputs PROVE: run.status 'running' and run.stage say the runner is
// working on that handoff stage on this computer; run.updatedAt is stamped
// when the runner entered that stage; run.lastActivityAt is the last time the
// Claude stream yielded anything during that stage. Nothing here claims more.
import { formatProgressDuration, progressStage, stepsFor } from './bridgeJobProgress.js';
import { BRIDGE_PROGRESS_COPY } from './handoffBridgeCopy.js';
import { applicationStageLabel } from './applicationHandoffDock.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = value => (isObject(value) ? value : {});
const time = value => (Number.isFinite(value) && value >= 0 ? value : null);

export const CLAUDE_PROGRESS_COPY = Object.freeze({
  writing: label => [`Claude is working on: ${label}`, 'Running on this computer.'],
  writingUnknownStage: Object.freeze(['Claude is working on this', 'Running on this computer.']),
  fixing: (count, label) => [
    `Claude is fixing ${count} ${count === 1 ? 'issue' : 'issues'}`,
    `Found in its last ${label ? label.toLowerCase() : 'answer'}.`,
  ],
  lastHeard: ago => `Last heard from Claude ${ago}`,
  notHeardYet: 'Nothing heard from Claude yet in this step',
});

function view(kind, steps, headline, detail, since, lastHeard = null) {
  return { kind, steps, headline, detail, tone: 'working', since: time(since), lastHeard: time(lastHeard), action: null, actionLabel: null };
}

function neutral() {
  const [headline, detail] = CLAUDE_PROGRESS_COPY.writingUnknownStage;
  return view('claude-writing', stepsFor(null, false), headline, detail, null);
}

function deriveInner(input) {
  const run = object(input.run);
  const item = object(input.item);
  const stage = progressStage(run.stage) || progressStage(item.stage);
  const label = stage ? applicationStageLabel(stage) : null;
  const steps = stepsFor(stage, false);
  const corrections = Array.isArray(item.corrections) ? item.corrections.filter(Boolean).length : 0;
  if (corrections > 0) {
    const [headline, detail] = CLAUDE_PROGRESS_COPY.fixing(corrections, label);
    return view('claude-fixing', steps, headline, detail, run.updatedAt, run.lastActivityAt);
  }
  const [headline, detail] = label ? CLAUDE_PROGRESS_COPY.writing(label) : CLAUDE_PROGRESS_COPY.writingUnknownStage;
  return view('claude-writing', steps, headline, detail, run.updatedAt, run.lastActivityAt);
}

/**
 * @param {{run?: object, item?: object}} input `run` is the normalized Claude
 * run ({status, stage, code, message, updatedAt, lastActivityAt}); `item` is
 * the dock item. Never throws: malformed input becomes a neutral view.
 */
export function deriveClaudeJobProgress(input) {
  try {
    return deriveInner(object(input));
  } catch {
    return neutral();
  }
}

/**
 * Elapsed clock plus a "Last heard from Claude" line, shown together so the
 * user can tell a stuck stage from a long one. Pure, never throws.
 */
export function claudeProgressTimeLines(view, now) {
  try {
    const clock = time(now);
    const since = time(view?.since);
    const heard = time(view?.lastHeard);
    const elapsedText = clock !== null && since !== null ? formatProgressDuration(Math.max(0, clock - since)) : null;
    let heardLine = null;
    if (heard !== null && clock !== null) {
      const ms = Math.max(0, clock - heard);
      const ago = ms < 2000 ? BRIDGE_PROGRESS_COPY.justNow : BRIDGE_PROGRESS_COPY.ago(formatProgressDuration(ms));
      heardLine = CLAUDE_PROGRESS_COPY.lastHeard(ago);
    } else if (heard === null && since !== null) {
      heardLine = CLAUDE_PROGRESS_COPY.notHeardYet;
    }
    return {
      elapsed: elapsedText ? BRIDGE_PROGRESS_COPY.elapsed(elapsedText) : null,
      heard: heardLine,
    };
  } catch {
    return { elapsed: null, heard: null };
  }
}
