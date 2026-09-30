import {
  ACTIVITY_COPY,
  BRIDGE_ACTION_COPY,
  BRIDGE_COPY,
  BRIDGE_DYNAMIC_COPY,
  JOB_ROW_COPY,
  RELATIVE_TIME_COPY,
} from './handoffBridgeCopy.js';
import { applicationStageLabel } from './applicationHandoffDock.js';

export const HEALTH_IDS = Object.freeze([
  'off', 'setup', 'alarm', 'fault', 'paused', 'restart', 'tunnel-problem', 'starting',
  'tunnel-unreachable', 'link-problem', 'needs-you', 'duplicate-serve', 'stalled',
  'chat-full', 'working', 'saving', 'reached', 'first-call', 'nudge', 'chat-idle', 'ready',
]);

const NOTE_IDS = new Set([
  'tunnel-problem', 'tunnel-unreachable', 'link-problem', 'needs-you', 'duplicate-serve', 'stalled',
]);
const count = value => Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
const minutes = (at, now) => Math.max(0, Math.floor((now - at) / 60000));

function action(id, kind = 'primary') {
  return { id, label: BRIDGE_ACTION_COPY[id], kind };
}

function entry(id, tone, copy, actionIds = []) {
  return {
    id,
    tone,
    headline: copy[0],
    detail: copy[1],
    actions: actionIds.map(item => typeof item === 'string' ? action(item) : action(item.id, item.kind)),
  };
}

// Jobs released after ChatGPT was told to stop: still unread, and nothing will
// read them until the person sends Continue.
function unreadWhileIdle(status) {
  if (status?.chat?.state !== 'idle' || !Array.isArray(status?.queue?.jobs)) return 0;
  return status.queue.jobs.filter(job => job?.phase === 'unread').length;
}

function finish(matches, status) {
  const primary = matches[0] || entry('ready', 'ok', BRIDGE_COPY.health.ready, ['new-chat']);
  const notes = [];
  const seen = new Set();
  for (const item of matches.slice(1)) {
    if (!NOTE_IDS.has(item.id) || seen.has(item.headline)) continue;
    seen.add(item.headline);
    notes.push(item.headline);
  }
  const applications = status?.queue?.applications || {};
  const stalled = status?.chat?.outstanding?.stalled ? 1 : 0;
  const nudge = matches.some(item => item.id === 'nudge')
    ? count(applications.ready) + unreadWhileIdle(status) + (status?.config?.scope?.scoring ? count(status?.queue?.scoring?.pending) : 0)
    : 0;
  return {
    ...primary,
    badge: count(applications.needsYou) + stalled + nudge,
    notes,
  };
}

export function deriveBridgeHealth(status, now = 0) {
  const value = status || {};
  const setup = value.setup || {};
  const tunnel = value.tunnel || {};
  const link = value.link || {};
  const chat = value.chat || {};
  const applications = value.queue?.applications || {};
  const matches = [];

  if (!value.availability?.ok || !value.enabled) {
    return finish([entry('off', 'off', BRIDGE_COPY.health.off, ['enable'])], value);
  }
  if (!setup.binaryApproved || !setup.credentialsOk || !setup.hostnameOk || !setup.linked) {
    const next = !setup.binaryApproved
      ? 'choose and approve cloudflared'
      : !setup.credentialsOk
        ? 'choose your tunnel credentials file'
        : !setup.hostnameOk
          ? 'enter your public address'
          : 'link ChatGPT';
    matches.push(entry('setup', 'setup', BRIDGE_DYNAMIC_COPY.setup(next), ['setup']));
  }
  const activeAlarms = (value.alarms || []).filter(alarm => !alarm.acknowledged);
  if (activeAlarms.length) {
    matches.push(entry('alarm', 'error', BRIDGE_DYNAMIC_COPY.alarm(activeAlarms.length), [
      'resume',
      { id: 'revoke-all', kind: 'danger' },
    ]));
  }
  if (value.fault) matches.push(entry('fault', 'error', BRIDGE_DYNAMIC_COPY.fault(), ['open-panel']));
  if (value.paused) {
    if (value.pauseCause === 'idle') {
      const idleHours = Math.max(1, Math.round(count(value.limits?.idlePauseMinutes) / 60));
      matches.push(entry('paused', 'attention', BRIDGE_DYNAMIC_COPY.idlePaused(idleHours), ['resume']));
    } else if (value.pauseCause === 'quit') {
      matches.push(entry('paused', 'attention', BRIDGE_DYNAMIC_COPY.quitPaused(), []));
    } else {
      matches.push(entry('paused', 'attention', BRIDGE_COPY.health.paused, ['resume']));
    }
  }
  if (value.hold === 'restart') {
    matches.push(entry('restart', 'attention', BRIDGE_COPY.health.restart, ['new-chat']));
  }

  const tunnelProblem = ['off', 'blocked', 'needs-setup', 'needs-trust', 'backoff', 'paused', 'stopping', 'failed'].includes(tunnel.state)
    || (tunnel.state === 'degraded' && tunnel.probe?.state !== 'failing');
  if (tunnelProblem) {
    matches.push(entry('tunnel-problem', 'error', BRIDGE_COPY.health['tunnel-problem'], ['setup']));
  }
  if (['starting', 'connecting', 'checking-public'].includes(tunnel.state) || value.serving === 'starting') {
    matches.push(entry('starting', 'working', BRIDGE_COPY.health.starting));
  }
  const probeFailed = tunnel.probe?.state === 'failing'
    || (typeof tunnel.probe?.state === 'string' && !['unknown', 'off', 'checking', 'ok'].includes(tunnel.probe.state))
    || (tunnel.probe?.reason && !['unknown', 'off', 'checking', 'ok'].includes(tunnel.probe.reason));
  if (probeFailed) {
    matches.push(entry(
      'tunnel-unreachable',
      'error',
      BRIDGE_DYNAMIC_COPY.tunnelFailures(count(tunnel.probe.consecutiveFailures)),
      ['restart-tunnel'],
    ));
  }
  if (link.state === 'needs-renewal' || link.expiresSoon || link.toolsStale) {
    const linkCopy = link.state === 'needs-renewal'
      ? BRIDGE_DYNAMIC_COPY.linkRenewal()
      : link.expiresSoon
        ? BRIDGE_DYNAMIC_COPY.linkExpiresSoon()
        : BRIDGE_DYNAMIC_COPY.toolsStale();
    matches.push(entry('link-problem', 'attention', linkCopy, link.toolsStale ? ['setup'] : ['open-pairing']));
  }
  if (count(applications.needsYou)) {
    matches.push(entry('needs-you', 'attention', BRIDGE_DYNAMIC_COPY.needsYou(count(applications.needsYou)), ['open-dock']));
  }
  if (chat.servedTwice) {
    matches.push(entry('duplicate-serve', 'attention', BRIDGE_COPY.health['duplicate-serve'], ['new-chat']));
  }
  if (chat.outstanding?.stalled) {
    const age = minutes(chat.outstanding.stalledSince || chat.outstanding.servedAt || now, now);
    const stageLabel = chat.outstanding.stage ? applicationStageLabel(chat.outstanding.stage) : null;
    const work = stageLabel && stageLabel !== 'Application handoff'
      ? `${stageLabel.charAt(0).toLowerCase()}${stageLabel.slice(1)}`
      : chat.outstanding.task === 'job-scoring' ? 'job scoring' : 'this handoff';
    matches.push(entry('stalled', 'attention', BRIDGE_DYNAMIC_COPY.stalled(age, work), ['new-chat', 'open-dock']));
  }
  if (chat.state === 'full') {
    matches.push(entry('chat-full', 'attention', BRIDGE_COPY.health['chat-full'], ['new-chat']));
  }
  if (chat.state === 'working' || chat.outstanding) {
    matches.push(entry('working', 'working', BRIDGE_COPY.health.working));
  }
  // Unread jobs count as "working" in the queue totals, but with a stopped chat
  // they are waiting for ChatGPT, not being saved: lead with Continue.
  const idleUnread = unreadWhileIdle(value);
  if (idleUnread) {
    matches.push(entry('nudge', 'nudge', BRIDGE_DYNAMIC_COPY.nudge(count(applications.ready) + idleUnread, chat.ordinal), ['new-chat']));
  }
  if (count(applications.working)) {
    matches.push(entry('saving', 'working', BRIDGE_COPY.health.saving));
  }
  if (chat.state === 'reached') {
    matches.push(entry('reached', 'working', BRIDGE_DYNAMIC_COPY.reached(chat.ordinal)));
  }
  if (chat.state === 'awaiting-first-call') {
    matches.push(entry('first-call', 'nudge', BRIDGE_DYNAMIC_COPY.firstCall(chat.ordinal), ['copy-starter']));
  }
  if (count(applications.ready) && (!chat.ordinal || chat.state === 'idle' || chat.state === 'ended')) {
    matches.push(entry('nudge', 'nudge', BRIDGE_DYNAMIC_COPY.nudge(count(applications.ready), chat.ordinal), ['new-chat']));
  }
  if (chat.state === 'idle') {
    matches.push(entry('chat-idle', 'ok', BRIDGE_DYNAMIC_COPY.chatIdle(chat.ordinal, formatAgo(chat.lastCallAt, now)), ['new-chat']));
  }
  matches.push(entry('ready', 'ok', BRIDGE_COPY.health.ready, ['new-chat']));
  return finish(matches, value);
}

export function formatAgo(at, now = 0) {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return RELATIVE_TIME_COPY.never;
  const seconds = Math.max(0, Math.floor((now - at) / 1000));
  if (seconds < 60) return RELATIVE_TIME_COPY.now;
  if (seconds < 3600) return RELATIVE_TIME_COPY.minutes(Math.floor(seconds / 60));
  if (seconds < 86400) return RELATIVE_TIME_COPY.hours(Math.floor(seconds / 3600));
  return RELATIVE_TIME_COPY.days(Math.floor(seconds / 86400));
}

export function describeChat(chat = {}, now = 0) {
  return {
    ordinal: Number.isFinite(chat.ordinal) ? chat.ordinal : null,
    started: chat.startedAt ? formatAgo(chat.startedAt, now) : null,
    lastCall: chat.lastCallAt ? formatAgo(chat.lastCallAt, now) : null,
    calls: count(chat.calls),
    waitingForFirstCall: chat.state === 'awaiting-first-call',
    workingOn: chat.outstanding?.stage ? applicationStageLabel(chat.outstanding.stage) : null,
  };
}

export function describeJobRow(job = {}) {
  if (job.phase === 'unread' || job.phase === 'awaiting') {
    return { text: job.servedToChat ? JOB_ROW_COPY.withChat(job.servedToChat) : JOB_ROW_COPY.awaiting, action: 'hold' };
  }
  if (job.phase === 'host') return { text: JOB_ROW_COPY.host, action: null };
  if (job.phase === 'done') return { text: JOB_ROW_COPY.done, action: null };
  if (job.phase === 'gone') return { text: JOB_ROW_COPY.gone, action: null };
  if (job.phase === 'held') {
    return { text: job.reason === 'answered_in_dock' || job.reason === 'human_advance' ? JOB_ROW_COPY.answered_in_dock : JOB_ROW_COPY.held, action: 'resume' };
  }
  return { text: JOB_ROW_COPY[job.reason] || JOB_ROW_COPY.unreadable, action: 'dock' };
}

export function activityLabel(item = {}) {
  return ACTIVITY_COPY[item.kind] || ACTIVITY_COPY.unknown;
}

export function setupStepStates(status = {}) {
  const setup = status.setup || {};
  return [
    { id: 1, complete: true },
    { id: 2, complete: !!setup.hostnameOk && !!setup.binaryApproved && !!setup.credentialsOk && !!setup.tunnelReachable },
    { id: 3, complete: !!setup.linked },
    { id: 4, complete: !!setup.firstCallSeen },
  ];
}
