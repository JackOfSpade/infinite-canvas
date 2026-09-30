// Live progress for ONE application the ChatGPT bridge holds. Pure: everything
// comes in as arguments, nothing here reads a clock, a store or the DOM.
//
// What each input PROVES (read from electron/ipc/handoffBridge/engine.js, not
// guessed), because this file may say no more than that:
//  - job.phase 'unread': the engine has not read the job's next prompt yet.
//    Nothing reads it until ChatGPT calls get (refreshOneLane runs inside
//    get), so 'unread' never means "the app is reading it right now".
//  - 'awaiting': the next prompt is open. job.servedToChat is set once this
//    chat was given a slot for the job.
//  - job.awaitingAnswer (engine-computed, per job): this job's CURRENT stage was
//    served to the current chat and no accepted answer has come since. It is the
//    ONLY proof that "ChatGPT is working on this job" and the only thing this
//    file uses for it. servedToChat alone is not: after an accepted answer the
//    job keeps its slot while the next stage is not served yet.
//  - job.servedAt: when that stage was served (null unless awaitingAnswer).
//    job.answeredAt: the last accepted answer. job.stalled / job.stalledSince:
//    the engine's own "quiet for STALL_NOTICE_MS" verdict for THIS job;
//    stalledSince is when the quiet BEGAN (the last time the chat was heard),
//    so `now - stalledSince` is the real quiet age.
//  - 'host': the app is building the documents. The lane also reaches 'host'
//    when the source adapter reports it (a job finished in the dock), so it
//    does not prove ChatGPT answered every stage.
//  - 'done' / 'gone': finished / discarded.  'held' / 'needs_user': the engine
//    stopped serving the job; job.reason says why.
import {
  BRIDGE_ACTION_COPY,
  BRIDGE_COPY,
  BRIDGE_DYNAMIC_COPY,
  BRIDGE_PROGRESS_COPY,
  BRIDGE_UI_COPY,
  JOB_ROW_COPY,
} from './handoffBridgeCopy.js';
import { applicationStageLabel } from './applicationHandoffDock.js';
import { CHAT_STATES, JOB_PHASES } from './handoffBridgeStatus.js';

export const PROGRESS_STAGES = Object.freeze(['evidence-plan', 'resume', 'cover-letter', 'review']);
export const PROGRESS_TONES = Object.freeze(['neutral', 'working', 'attention', 'problem']);
export const PROGRESS_ACTIONS = Object.freeze(['start-chat', 'continue-chat']);

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = value => (isObject(value) ? value : {});
const time = value => (Number.isFinite(value) && value >= 0 ? value : null);
const lowerFirst = text => `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
const upperFirst = text => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

function stepsFor(stage, allDone) {
  const current = PROGRESS_STAGES.indexOf(stage);
  return PROGRESS_STAGES.map((key, index) => ({
    key,
    label: applicationStageLabel(key),
    state: allDone || (current >= 0 && index < current)
      ? 'done'
      : current === index ? 'current' : 'upcoming',
  }));
}

function build(base, fields) {
  const action = PROGRESS_ACTIONS.includes(fields.action) ? fields.action : null;
  const tone = PROGRESS_TONES.includes(fields.tone) ? fields.tone : 'neutral';
  return {
    kind: base.kind,
    steps: base.steps,
    headline: fields.headline,
    detail: fields.detail,
    tone,
    since: time(fields.since),
    lastHeard: time(fields.lastHeard),
    action,
    actionLabel: action === 'continue-chat'
      ? BRIDGE_UI_COPY.copyContinue
      : action === 'start-chat'
        ? (fields.actionLabel || BRIDGE_UI_COPY.startChat)
        : null,
  };
}

function generic(steps = stepsFor(null, false)) {
  return build({ kind: 'generic', steps }, {
    headline: BRIDGE_PROGRESS_COPY.generic[0],
    detail: BRIDGE_PROGRESS_COPY.generic[1],
    tone: 'neutral',
  });
}

// "Needs you: this job failed. See the dock." -> "This job failed." The reader
// is already in the dock, and the row prefix repeats the headline.
function needsYouDetail(text) {
  if (typeof text !== 'string' || !/^Needs you:\s*/.test(text)) return null;
  const stripped = text.replace(/^Needs you:\s*/, '').replace(/\s*See the dock\.?$/, '').trim();
  return stripped ? upperFirst(stripped) : null;
}

function deriveInner({ job: rawJob, chat: rawChat, item: rawItem, now: rawNow, bridge: rawBridge }) {
  const job = object(rawJob);
  const chat = object(rawChat);
  const item = object(rawItem);
  const bridge = object(rawBridge);
  const now = time(rawNow);
  const phase = job.phase;
  if (!JOB_PHASES.includes(phase) || phase === 'unknown') return generic();

  const stage = PROGRESS_STAGES.includes(job.stage)
    ? job.stage
    : PROGRESS_STAGES.includes(item.stage) ? item.stage : null;
  const label = stage ? applicationStageLabel(stage) : null;
  const finished = phase === 'done';
  const base = steps => ({ steps, kind: phase });
  const steps = stepsFor(stage, finished);

  if (phase === 'gone') {
    return build(base(stepsFor(stage, false)), { headline: BRIDGE_PROGRESS_COPY.gone[0], detail: BRIDGE_PROGRESS_COPY.gone[1], tone: 'neutral' });
  }
  if (phase === 'done') {
    return build(base(steps), { headline: BRIDGE_PROGRESS_COPY.done[0], detail: BRIDGE_PROGRESS_COPY.done[1], tone: 'neutral' });
  }

  // 1. The engine stopped serving this job.
  if (phase === 'needs_user' || phase === 'held') {
    const rowText = typeof JOB_ROW_COPY[job.reason] === 'string' ? JOB_ROW_COPY[job.reason] : null;
    const problem = phase === 'needs_user';
    const since = job.changedAt;
    if (job.reason === 'restart') {
      // The controller confirms a restart when a chat is started.
      return build({ kind: 'held', steps }, {
        headline: BRIDGE_COPY.health.restart[0], detail: BRIDGE_COPY.health.restart[1], tone: 'attention', since, action: 'start-chat',
      });
    }
    const detail = needsYouDetail(rowText);
    if (problem || detail) {
      return build({ kind: phase, steps }, {
        headline: BRIDGE_PROGRESS_COPY.needsYou,
        detail: detail || BRIDGE_PROGRESS_COPY.needsYouFallback,
        tone: problem ? 'problem' : 'attention',
        since,
      });
    }
    return build({ kind: phase, steps }, {
      headline: rowText || JOB_ROW_COPY.held, detail: BRIDGE_PROGRESS_COPY.kept, tone: 'attention', since,
    });
  }

  // 2. App-side work: no chat is involved, so the chat's state is irrelevant.
  if (phase === 'host') {
    return build(base(steps), { headline: BRIDGE_PROGRESS_COPY.host[0], detail: BRIDGE_PROGRESS_COPY.host[1], tone: 'working' });
  }

  // Phases 'unread' and 'awaiting' remain. A paused bridge serves nothing.
  if (bridge.paused === true) {
    return build(base(steps), { headline: BRIDGE_COPY.health.paused[0], detail: BRIDGE_COPY.health.paused[1], tone: 'attention' });
  }
  const state = typeof chat.state === 'string' ? chat.state : null;
  const unread = phase === 'unread';
  // An unread job does not depend on the chat's state to be described.
  const unreadLine = () => build(base(steps), { headline: BRIDGE_PROGRESS_COPY.unread[0], detail: BRIDGE_PROGRESS_COPY.unread[1], tone: 'neutral' });
  if (!CHAT_STATES.includes(state) || state === 'unknown') return unread ? unreadLine() : generic(steps);
  const ordinal = time(chat.ordinal);
  const hasChat = state !== 'none' && ordinal !== null && ordinal > 0;
  const lastHeard = hasChat ? time(chat.lastCallAt) : null;
  // Given a slot in this chat (it may have been answered since) vs proven to be
  // waiting on ChatGPT's answer right now.
  const served = !unread && time(job.servedToChat) !== null;
  const awaiting = !unread && job.awaitingAnswer === true;

  // 3. This job's current stage was served and ChatGPT has been quiet too long.
  if (awaiting && job.stalled === true) {
    const anchor = time(job.stalledSince) ?? time(job.servedAt);
    const age = anchor !== null && now !== null ? Math.max(0, Math.floor((now - anchor) / 60000)) : 0;
    const stalledLabel = label ? lowerFirst(label) : 'this handoff';
    const [headline, detail] = BRIDGE_DYNAMIC_COPY.stalled(age, stalledLabel);
    return build({ kind: 'stalled', steps }, { headline, detail, tone: 'attention', since: anchor, lastHeard, action: 'start-chat' });
  }

  // 4. Nobody to hand the job to yet.
  if (!hasChat) {
    const [headline, detail] = BRIDGE_PROGRESS_COPY.noChat(bridge.pluginName);
    return build({ kind: 'no-chat', steps }, { headline, detail, tone: 'attention', action: 'start-chat' });
  }
  if (state === 'awaiting-first-call') {
    const [headline, detail] = BRIDGE_DYNAMIC_COPY.firstCall(ordinal);
    return build({ kind: 'first-call', steps }, {
      headline, detail, tone: 'attention', action: 'start-chat', actionLabel: BRIDGE_ACTION_COPY['copy-starter'],
    });
  }

  // Nothing reads an unread job until ChatGPT calls; only the two chat states
  // that mean "no call is coming yet" have something to press.
  if (unread) return unreadLine();

  // 5. The chat cannot take this job. A job ChatGPT is answering is different:
  // the hard cap fences get() but not submit(), so it may still be answered.
  if (state === 'full' && !awaiting) {
    return build({ kind: 'chat-full', steps }, {
      headline: BRIDGE_COPY.health['chat-full'][0], detail: BRIDGE_COPY.health['chat-full'][1], tone: 'attention', lastHeard, action: 'start-chat',
    });
  }
  if (state === 'ended' || state === 'idle') {
    return build({ kind: 'chat-ended', steps }, {
      headline: BRIDGE_COPY.health.nudge[0], detail: BRIDGE_DYNAMIC_COPY.nudge(1, ordinal)[1], tone: 'attention', lastHeard, action: 'continue-chat',
    });
  }

  // 6. A live chat that is not being answered for this job right now: either
  // never handed it, or it answered the previous stage and this one is not
  // served yet. Both are "ready, waiting for ChatGPT's next request".
  if (!awaiting) {
    const cap = time(chat.jobsCap) ?? 0;
    const assigned = time(chat.jobsAssigned) ?? 0;
    const [headline, detail] = !served && cap > 0 && assigned >= cap
      ? BRIDGE_PROGRESS_COPY.queuedChatFull(cap)
      : BRIDGE_PROGRESS_COPY.queued(label);
    return build({ kind: 'queued', steps }, { headline, detail, tone: 'working', lastHeard });
  }

  // 7. Handed over; the answer has not arrived. The hand-over time is this
  // job's own servedAt, which the engine stamps per job, so it is exact.
  const servedSince = time(job.servedAt);
  // A full chat still takes this job's answer, so say the weaker true thing.
  const fullNote = state === 'full' ? ` ${BRIDGE_PROGRESS_COPY.chatFullNote}` : '';
  const corrections = Array.isArray(item.corrections) ? item.corrections.filter(Boolean).length : 0;
  if (corrections > 0) {
    const [headline, detail] = BRIDGE_PROGRESS_COPY.fixing(corrections, label);
    const escalation = object(item.rejectionEscalation);
    const streak = escalation.active === true && Number.isFinite(escalation.streak) && escalation.streak >= 2
      ? Math.floor(escalation.streak) : 0;
    return build({ kind: 'fixing', steps }, {
      headline, detail: `${streak ? `${detail} ${BRIDGE_PROGRESS_COPY.sameCheckStreak(streak)}` : detail}${fullNote}`, tone: 'working', since: servedSince, lastHeard,
    });
  }
  const [headline, detail] = label ? BRIDGE_PROGRESS_COPY.writing(label) : BRIDGE_PROGRESS_COPY.writingUnknownStage;
  return build({ kind: 'writing', steps }, { headline, detail: `${detail}${fullNote}`, tone: 'working', since: servedSince, lastHeard });
}

/**
 * @param {{job?: object, chat?: object, item?: object, now?: number, bridge?: {paused?: boolean, pluginName?: string}}} input
 * `job` is one status.queue.jobs entry, `chat` is status.chat, `item` is the
 * dock item (stage, corrections, rejectionEscalation), `now` is epoch ms,
 * `bridge.pluginName` is status.config.pluginName (named in the no-chat line).
 * Never throws: malformed input becomes a neutral generic line.
 */
export function deriveBridgeJobProgress(input) {
  try {
    return deriveInner(object(input));
  } catch {
    return generic();
  }
}

/** 20s, 4 min, 1 h 5 min. Null for a value that is not a non-negative number. */
export function formatProgressDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** The two timer lines for a view model, or null for each that has no anchor. */
export function progressTimeLines(view, now) {
  const clock = time(now);
  const since = time(view?.since);
  const heard = time(view?.lastHeard);
  const elapsed = clock !== null && since !== null ? formatProgressDuration(Math.max(0, clock - since)) : null;
  const heardMs = clock !== null && heard !== null ? Math.max(0, clock - heard) : null;
  const ago = heardMs === null ? null : heardMs < 2000 ? BRIDGE_PROGRESS_COPY.justNow : BRIDGE_PROGRESS_COPY.ago(formatProgressDuration(heardMs));
  return {
    elapsed: elapsed ? BRIDGE_PROGRESS_COPY.elapsed(elapsed) : null,
    heard: ago ? BRIDGE_PROGRESS_COPY.lastHeard(ago) : null,
  };
}
