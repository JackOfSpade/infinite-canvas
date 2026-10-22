// Live progress for ONE application bundle the local Claude runner is
// answering. Pure: everything comes in as arguments. It returns the same view
// shape as deriveBridgeJobProgress so the dock shows the same four-step UI no
// matter which backend answers.
//
// What the inputs PROVE: run.status 'running' and run.stage say the runner is
// working on that handoff stage on this computer; run.updatedAt is stamped
// when the runner entered that stage. Nothing here claims more than that.
import { progressStage, stepsFor } from './bridgeJobProgress.js';
import { applicationStageLabel } from './applicationHandoffDock.js';

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = value => (isObject(value) ? value : {});
const time = value => (Number.isFinite(value) && value >= 0 ? value : null);

export const CLAUDE_PROGRESS_COPY = Object.freeze({
  writing: label => [`Claude is working on: ${label}`, `${label} was handed to Claude, which is writing it on this computer. Its answer has not arrived yet.`],
  writingUnknownStage: Object.freeze(['Claude is working on this', 'This job was handed to Claude, which is writing it on this computer. Its answer has not arrived yet.']),
  fixing: (count, label) => [
    `Claude is fixing ${count} ${count === 1 ? 'issue' : 'issues'}`,
    `The app found ${count === 1 ? 'an issue' : `${count} issues`} in the last ${label ? label.toLowerCase() : 'answer'} and Claude has the list. The corrected answer has not arrived yet.`,
  ],
});

function view(kind, steps, headline, detail, since) {
  return { kind, steps, headline, detail, tone: 'working', since: time(since), lastHeard: null, action: null, actionLabel: null };
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
    return view('claude-fixing', steps, headline, detail, run.updatedAt);
  }
  const [headline, detail] = label ? CLAUDE_PROGRESS_COPY.writing(label) : CLAUDE_PROGRESS_COPY.writingUnknownStage;
  return view('claude-writing', steps, headline, detail, run.updatedAt);
}

/**
 * @param {{run?: object, item?: object}} input `run` is the normalized Claude
 * run ({status, stage, code, message, updatedAt}); `item` is the dock item.
 * Never throws: malformed input becomes a neutral all-upcoming view.
 */
export function deriveClaudeJobProgress(input) {
  try {
    return deriveInner(object(input));
  } catch {
    return neutral();
  }
}
