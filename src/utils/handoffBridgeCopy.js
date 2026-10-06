// All renderer-visible bridge language lives here so a status value can never
// become UI text accidentally.  Keep this free of codes, secrets and emoji.
export const BRIDGE_COPY = Object.freeze({
  health: Object.freeze({
    off: ['Bridge off', 'Turn on the bridge when you are ready.'],
    setup: ['Setup needed', 'Finish the required setup steps before ChatGPT can help.'],
    alarm: ['Paused: unexpected caller', 'Calls with a valid ChatGPT link but the wrong chat code were refused. If this was not you, revoke access.'],
    fault: ['Bridge needs attention', 'The bridge stopped serving until you address this problem.'],
    paused: ['Paused', 'ChatGPT is told to wait and nothing is served. The tunnel and the link stay up.'],
    restart: ['Confirm to restart', 'The bridge restarted, so every earlier ChatGPT chat has ended. Prepare the worker plan to begin again.'],
    'tunnel-problem': ['Tunnel needs attention', 'ChatGPT cannot reach this Mac until the tunnel is ready.'],
    starting: ['Starting tunnel', 'Connecting this Mac to ChatGPT.'],
    'tunnel-unreachable': ['Tunnel unreachable', 'ChatGPT cannot reach this Mac right now.'],
    'link-problem': ['ChatGPT link needs renewing', 'First press Open pairing here, then press Reconnect in ChatGPT and type the code on the page your browser opens.'],
    'needs-you': ['Needs you', 'One or more jobs need your attention in the dock.'],
    'response-overdue': ['No recent response from a worker', 'This worker has made no bridge call for at least 5 min while a handoff awaits its response. It may still be writing or may have stopped. Use that worker’s Copy replacement starter control in the roster to resume the exact handoff.'],
    'duplicate-serve': ['Two chats are using one code', 'Start a fresh chat so only one chat is serving this work.'],
    'chat-full': ['Chat limit reached', 'This chat reached its safety budget. Prepare fresh workers to continue.'],
    working: ['ChatGPT is working', 'A handoff is currently with ChatGPT.'],
    saving: ['The app is saving this', 'The app is applying a finished answer.'],
    'first-call': ['Waiting for chat', 'Check the plugin appeared as a chip and the message was sent.'],
    reached: ['Chat has connected', 'ChatGPT reached the bridge with this chat\'s code, but that call was turned away before any work was handed over. If the chat has stopped, tell it to try again.'],
    nudge: ['Waiting for ChatGPT', 'Send Continue in the existing chat, or prepare fresh workers.'],
    'chat-idle': ['Chat is idle', 'Nothing is waiting right now.'],
    ready: ['Ready', 'Linked and reachable. Nothing is waiting.'],
  }),
  keepAwakeOn: 'During bridge work, the app asks macOS to keep your Mac awake and keeps this window\'s timers running. Closing the lid still sleeps it.',
  keepAwakeOff: 'During bridge work, your Mac may sleep or slow this window\'s timers until it wakes. Closing the lid always sleeps it.',
  e2eUnavailable: 'The bridge is disabled during automated test runs.',
  noWindow: 'Open a canvas window first.',
});

// The plugin's configured name (status.config.pluginName), which the person
// picks after typing @ in ChatGPT. Callers pass it in: this module never reads
// config. Without one, say which plugin without inventing its name.
export const BRIDGE_PLUGIN_FALLBACK = 'the Infinite Canvas plugin';
export function bridgePluginRef(pluginName) {
  return typeof pluginName === 'string' && pluginName.trim() ? pluginName.trim() : BRIDGE_PLUGIN_FALLBACK;
}

export const BRIDGE_ACTION_COPY = Object.freeze({
  enable: 'Turn on',
  setup: 'Open setup',
  'open-panel': 'Open panel',
  'revoke-all': 'Revoke access',
  resume: 'Resume',
  'new-chat': 'Prepare worker plan',
  'restart-tunnel': 'Restart tunnel',
  'open-pairing': 'Open pairing',
  'open-dock': 'Open in dock',
  // Every visible recovery/start path now opens the sized worker plan. A live
  // pool exposes the actual per-worker copy controls directly beneath it.
  'copy-starter': 'Prepare worker plan',
});

export const BRIDGE_DYNAMIC_COPY = Object.freeze({
  setup: next => ['Setup needed', `Next: ${next}`],
  alarm: amount => ['Paused: unexpected caller', `Calls with a valid ChatGPT link but the wrong chat code were refused ${amount} ${amount === 1 ? 'time' : 'times'}, so the bridge paused itself. If this was not you, revoke access.`],
  // Fault identifiers are deliberately not rendered.  A future main-process
  // value must not become renderer-visible diagnostic text.
  fault: () => ['Bridge error', 'The bridge stopped itself after an internal error. Turn it off and on again. If it repeats, copy a bug report.'],
  idlePaused: hours => [`Paused: nothing from you for ${hours} h`, 'Nothing has been served since you last acted here. Press Resume to continue.'],
  quitPaused: () => ['Closing', 'Nothing more is served while the app closes.'],
  tunnelFailures: failures => ['Tunnel unreachable', `${failures} checks in a row failed; ChatGPT cannot reach this Mac right now.`],
  linkRenewal: () => ['ChatGPT link needs renewing', 'ChatGPT can no longer use its link to this app. First press Open pairing here, then press Reconnect in ChatGPT and type the code on the page your browser opens.'],
  linkExpiresSoon: () => ['ChatGPT link expires soon', 'You can renew it any time: open pairing, then press Reconnect in ChatGPT.'],
  toolsStale: () => ['Refresh the plugin in ChatGPT', 'This app version changed the tool descriptions since ChatGPT last read them. In ChatGPT open the plugin settings and press Refresh.'],
  needsYou: amount => [`Needs you (${amount})`, BRIDGE_COPY.health['needs-you'][1]],
  firstCall: ordinal => [`Waiting for chat ${ordinal || ''}`.trim(), BRIDGE_COPY.health['first-call'][1]],
  reached: ordinal => [`Chat ${ordinal || ''} has connected`.replace(/\s+/g, ' ').trim(), BRIDGE_COPY.health.reached[1]],
  nudge: (amount, ordinal) => [`${amount} waiting for ChatGPT`, ordinal ? `Chat ${ordinal} has stopped. Send Continue there, or prepare fresh workers.` : 'Prepare worker chats for this queue.'],
  chatIdle: (ordinal, lastCall) => [`Chat ${ordinal || ''}: idle`.trim(), `Last call ${lastCall}. Nothing is waiting.`],
});

export const RELATIVE_TIME_COPY = Object.freeze({
  never: 'never',
  now: 'just now',
  minutes: value => `${value} min ago`,
  hours: value => `${value} h ago`,
  days: value => `${value} d ago`,
});

export const JOB_ROW_COPY = Object.freeze({
  awaiting: 'Waiting for ChatGPT',
  withChat: ordinal => `With ChatGPT (chat ${ordinal})`,
  host: 'The app is saving this',
  done: 'Saved',
  gone: 'Discarded',
  held: 'Kept for you',
  answered_in_dock: 'Answered here; ChatGPT stopped serving it',
  integrity_fault: 'Needs you: this job cannot continue. See the dock.',
  failed: 'Needs you: this job failed. See the dock.',
  render_retry_required: 'Needs you: press Retry layout check on the job card.',
  rejection_cap: 'Needs you: ChatGPT\'s answers were rejected too many times.',
  review_round_cap: 'Needs you: too many review rounds.',
  junk_cap: 'Needs you: ChatGPT sent empty answers repeatedly.',
  host_silent: 'Needs you: the app has not moved this job for 10 minutes. Is its canvas open?',
  job_broken: 'Needs you: this job cannot continue. See the dock.',
  render_retry: 'Needs you: press Retry layout check on the job card.',
  app_fix_required: 'Needs you: update the app before this layout check can continue. Do not retry the job card.',
  canvas_unavailable: 'Needs you: this canvas is not available. Open it, then see the dock.',
  read_failed: 'Needs you: this job could not be read. See the dock.',
  write_failed: 'Needs you: the app could not save this answer. See the dock.',
  submit_stuck: 'Needs you: the app has not finished saving this answer. See the dock.',
  lapsed: 'Needs you: this job is no longer released. See the dock.',
  restart: 'Needs you: confirm the restart before serving this job. See the dock.',
  app_only_handoffs: 'Needs you: this job stays in the copy/paste dock. See the dock.',
  user_hold: 'Kept for you',
  human_advance: 'Answered here; ChatGPT stopped serving it',
  commit_failed: 'Needs you: the app could not finish this change. See the dock.',
  person_editing: 'Kept for you',
  hub_not_selected: 'Needs you: select this scoring handoff before serving it. See the dock.',
  task_disabled: 'Needs you: this scoring handoff is not enabled. See the dock.',
  unreadable: 'Reading this job failed; retrying',
});

// Live progress for one application the bridge holds (bridgeJobProgress.js).
// Every line states what a lane phase, chat state or counter PROVES: none names
// a guessed cause, and none claims progress the status cannot see.
export const BRIDGE_PROGRESS_COPY = Object.freeze({
  region: 'ChatGPT progress',
  stepper: 'Application steps',
  stepState: Object.freeze({ done: 'done', current: 'current step', upcoming: 'not started yet' }),
  toneLabel: Object.freeze({ neutral: '', working: 'In progress', attention: 'Needs attention', problem: 'Problem' }),
  generic: Object.freeze(['Checking on this job', 'The bridge has not reported this job\'s progress yet.']),
  gone: Object.freeze(['Discarded', 'The bridge is no longer holding this job.']),
  done: Object.freeze(['Saved', 'Every step of this application is finished.']),
  unread: Object.freeze(['Not read yet', 'The app reads this job when ChatGPT asks for its next handoff.']),
  host: Object.freeze([JOB_ROW_COPY.host, 'The app is building the documents.']),
  chatFullNote: 'This chat reached its safety budget; fresh workers are needed to continue.',
  needsYou: 'This job needs you',
  needsYouFallback: 'Open the job card to see what it needs.',
  kept: 'The bridge is not giving this job to ChatGPT. Choose Resume serving in the bridge panel to hand it back.',
  noChat: pluginName => Object.freeze(['No worker chats yet', `Prepare the worker plan, then copy each starter into a separate ChatGPT chat with ${bridgePluginRef(pluginName)} selected.`]),
  queued: label => ['Queued for ChatGPT', `${label ? `The ${label.toLowerCase()} step is ready.` : 'This job is ready.'} ChatGPT gets it when it asks for its next handoff.`],
  queuedChatFull: cap => ['Queued for the next chat', `This chat is already carrying its limit of ${cap} ${cap === 1 ? 'bundle' : 'bundles'}. This one is handed over in a later chat.`],
  writing: label => [`ChatGPT is working on: ${label}`, `${label} was handed to ChatGPT. Its answer has not arrived yet.`],
  writingUnknownStage: Object.freeze(['ChatGPT is working on this', 'This job was handed to ChatGPT. Its answer has not arrived yet.']),
  responseOverdue: Object.freeze([
    'No recent response from this worker',
    'This worker has not made a bridge call for at least 5 min while this handoff awaits its response. It may still be writing or may have stopped. Copying a replacement starter resumes this exact handoff.',
  ]),
  fixing: (count, label) => [`ChatGPT is fixing ${count} ${count === 1 ? 'issue' : 'issues'}`, `The app found ${count === 1 ? 'an issue' : `${count} issues`} in the last ${label ? label.toLowerCase() : 'answer'} and ChatGPT has the list. The corrected answer has not arrived yet.`],
  sameCheckStreak: count => `The same check has now failed ${count} times in a row.`,
  lastHeard: ago => `Last heard from ChatGPT ${ago}`,
  elapsed: duration => `for ${duration}`,
  justNow: 'just now',
  ago: duration => `${duration} ago`,
  copiedNew: pluginName => `Copied the one-time starter. Now switch to ChatGPT, open a new chat, type @ and pick ${bridgePluginRef(pluginName)}, then paste and send. The plugin handles the queued handoffs automatically after that.`,
  copiedContinue: 'Copied. Now switch to ChatGPT, paste it into the existing chat, and send.',
  // Pressing Copy starter again before ChatGPT has called: same starter, same chat.
  copiedAgain: (ordinal, pluginName) => `Copied again: the same one-time starter for chat ${ordinal}. Paste and send it in a new ChatGPT chat with ${bridgePluginRef(pluginName)} selected; the plugin then handles the queue automatically.`,
});

// The job card's application line while the bridge holds the job. Its title is
// the dock's own headline for the job (bridgeHeldApplication.js), so these are
// only the words around it. Nothing here claims what ChatGPT is doing: that is
// the dock's to say, and it differs by phase.
export const BRIDGE_CARD_COPY = Object.freeze({
  detail: 'Open AI handoffs to see its progress.',
  detailNeedsYou: 'Open AI handoffs: it needs you.',
  open: 'Open AI handoffs',
  pending: 'In AI handoffs',
  pendingTitle: 'This application is in the AI handoffs dock. Open it to see its progress.',
});

export const ACTIVITY_COPY = Object.freeze({
  'link-paired': 'ChatGPT linked',
  'link-revoked': 'Link revoked',
  'link-refresh-failed': 'ChatGPT\'s link could not be renewed',
  'chat-started': 'Chat started',
  'chat-continued': 'Continue message copied',
  'get-served': 'Handed over a handoff',
  'get-waiting': 'Told ChatGPT to wait',
  'get-empty': 'Told ChatGPT nothing is waiting',
  'submit-accepted': 'Accepted an answer',
  'submit-rejected': 'Rejected an answer; ChatGPT was sent the fixes',
  'submit-duplicate': 'Ignored a repeated answer',
  'submit-junk': 'Ignored an empty answer',
  'submit-superseded': 'An answer arrived after the step had moved on',
  'submit-held': 'Answer not applied (job kept for you)',
  stall: 'No answer from ChatGPT',
  paused: 'Paused',
  resumed: 'Resumed',
  'tunnel-up': 'Tunnel connected',
  'tunnel-down': 'Tunnel unreachable',
  'tunnel-restart': 'Tunnel restarted',
  alarm: 'Unexpected caller',
  enabled: 'Turned on',
  disabled: 'Turned off',
  unknown: 'Bridge event',
});

export const BRIDGE_UI_COPY = Object.freeze({
  done: 'Done.',
  saved: 'Saved.',
  copied: 'Copied.',
  panelLabel: 'ChatGPT bridge',
  settingsLabel: 'ChatGPT bridge settings',
  closePanel: 'Close bridge panel',
  pause: 'Pause',
  resume: 'Resume',
  chat: 'Chat',
  noChat: 'No chat started',
  workingOn: value => `Working on ${value}`,
  application: 'Application',
  chatOrdinal: value => `Chat ${value}`,
  copyContinue: 'Copy Continue',
  startChat: 'Prepare worker plan',
  workerPoolLead: 'Prepare worker chats for this queue.',
  startWorkerPool: 'Prepare worker plan',
  preparingWorkerPool: 'Preparing worker chats…',
  workerPoolReady: 'Worker plan ready.',
  workerPoolPlan: (count, queued, materialized = queued) => queued
    ? `${count} ${count === 1 ? 'worker chat' : 'worker chats'} · ${materialized} released now · ${queued} forecast`
    : `${count} ${count === 1 ? 'worker chat' : 'worker chats'}`,
  workerPoolDirections: count => count === 1
    ? 'Copy the starter into a new pinned ChatGPT chat.'
    : 'Copy each starter into a separate pinned ChatGPT chat.',
  workerPoolGrowing: (count, recommended) => `${recommended - count} more ${recommended - count === 1 ? 'worker chat is' : 'worker chats are'} being prepared automatically.`,
  copyWorkerStarter: ordinal => `Copy worker ${ordinal} starter`,
  copyingWorker: ordinal => `Copying worker ${ordinal}…`,
  workerStarterLocked: ordinal => `Worker ${ordinal} already ready`,
  workerStarterCopied: (ordinal, count) => `Copied worker ${ordinal} of ${count}. Paste, send, and pin that ChatGPT chat before copying the next starter.`,
  // A worker's starter is one-time. These are deliberately status labels, not
  // replacement actions: a connected worker remains part of the pool even
  // while a later queue wave arrives.
  workerState: (state, quietReason = null) => ({
    available: 'Ready to start',
    ready: 'Starter copied',
    working: 'Working',
    quiet: quietReason === 'answer_silent' ? 'Response overdue' : 'Stopped polling after wait',
    waiting: 'Ready for later work',
    idle: 'Idle',
  })[state] || 'Worker active',
  workerDone: count => `${count} ${count === 1 ? 'handoff completed' : 'handoffs completed'}`,
  workerQuiet: quietReason => quietReason === 'answer_silent'
    ? 'This worker has not made a bridge call for at least 5 min while it owns a handoff response. It may still be writing or may have stopped. Copy a replacement starter to resume the exact handoff.'
    : 'This chat was told to poll again but has made no bridge call for at least 5 min. If this waiting chat is gone, copy a replacement starter and send it in a new ChatGPT chat.',
  copyReplacementStarter: 'Copy replacement starter',
  applications: 'Applications',
  sendAll: 'Send all pending',
  release: 'Release',
  readyToRelease: 'Ready to release',
  keepForMe: 'Keep for me',
  resumeServing: 'Resume serving',
  openDock: 'Open in dock',
  otherWindows: value => `and ${value} in other windows`,
  scoring: 'Scoring and research',
  scoringHub: (ordinal, pending) => `Scoring handoff ${ordinal} (${pending} waiting)`,
  scoringSummary: (pending, withChat) => `${pending} waiting, ${withChat} with ChatGPT`,
  activity: 'Activity',
  noActivity: 'No bridge activity yet.',
  counts: 'Counts since launch',
  served: 'Served',
  accepted: 'Accepted',
  rejected: 'Rejected',
  duplicates: 'Duplicates',
  junk: 'Junk',
  stalls: 'Stalls',
  tunnelRestarts: 'Tunnel restarts',
  also: 'Also:',
  revoke: 'Revoke ChatGPT access…',
  turnOff: 'Turn off',
  confirmRevokeTitle: 'Revoke ChatGPT access?',
  confirmRevokeMessage: 'This disconnects ChatGPT and ends the active chat. Released jobs stay in this app.',
  confirmRevoke: 'Revoke access',
  settingsHeading: 'ChatGPT bridge',
  settingsGroup: 'ChatGPT bridge controls',
  enabledLabel: 'Turn on the ChatGPT bridge',
  checkingAvailability: 'Checking bridge availability…',
  retryAvailability: 'Try again',
  unavailable: 'The bridge is unavailable in this build.',
  envDisabled: 'The bridge was disabled by this app launch.',
  setUp: 'Set up…',
  manage: 'Manage…',
  openPanel: 'Open panel',
  scoringSetting: 'Let ChatGPT handle job-search text handoffs',
  marketplaceSetting: 'Let ChatGPT handle marketplace pricing handoffs',
  autoStart: 'Turn on when the app starts',
  renewConsentToStart: 'This bridge needs your confirmation again before it can turn on automatically. Select Turn on the ChatGPT bridge to review and start it.',
  autoRelease: 'Automatically release new application handoffs this session',
  jobsPerChat: 'Application bundles one chat may carry',
  dangerZone: 'Danger zone',
  forget: 'Forget setup…',
  cancel: 'Cancel',
  triggerLabel: headline => `ChatGPT bridge: ${headline}`,
  externalLinkFailure: 'Could not open the ChatGPT plugin settings. Please try again.',
});

// cloudflared can put addresses, local paths and credential-shaped values in a
// diagnostic.  The log is optional UI troubleshooting, never a transport for
// raw process output.  Keep just a bounded, redacted single line.
export function sanitizeTunnelLogLine(value) {
  if (typeof value !== 'string') return null;
  const redacted = [...value].map(character => {
    const code = character.codePointAt(0);
    return code <= 31 || (code >= 127 && code <= 159) ? ' ' : character;
  }).join('')
    .replace(/https?:\/\/\S+/gi, '<url>')
    .replace(/(?:\/[^\s'"\\]+)+/g, '<path>')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, '<tunnel-id>')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '<address>')
    .replace(/\b(token|secret|credential|authorization|bearer|password)\s*[=:]\s*[^\s]+/gi, '$1=<redacted>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return redacted || null;
}

export const BRIDGE_SETUP_COPY = Object.freeze({
  title: 'Set up ChatGPT bridge',
  close: 'Close setup',
  steps: Object.freeze(['Overview', 'Tunnel', 'Plugin and link', 'First chat']),
  goTo: step => `Go to ${step}`,
  back: 'Back',
  next: 'Next',
  finish: 'Done',
  overview: 'Send released application and scoring handoffs to a ChatGPT plugin through a Cloudflare tunnel.',
  requirements: 'You need cloudflared, a named Cloudflare tunnel and credentials file, and a public address in your zone.',
  tunnelLead: 'Choose and approve cloudflared, then choose this named tunnel’s credentials file.',
  chooseBinary: 'Choose cloudflared…',
  approveBinary: 'Approve cloudflared…',
  chooseCredentials: 'Choose credentials…',
  publicAddress: 'Public address',
  hostnamePlaceholder: 'bridge.your-domain.com',
  pluginName: 'Plugin name',
  saveAddress: 'Save address',
  restartTunnel: 'Restart tunnel',
  showLog: 'Show tunnel log',
  tunnelLog: 'Recent tunnel diagnostics',
  noTunnelLog: 'No tunnel diagnostics are available yet.',
  noTunnel: 'Need a tunnel?',
  tunnelCommands: 'Run the commands below. Route the hostname with the UUID printed by create. Do not route by name: a default config can select the wrong tunnel. Then choose that tunnel’s credentials JSON here. The app creates ingress; do not run a token command.',
  tunnelCommandList: Object.freeze(['cloudflared tunnel login', 'cloudflared tunnel create NAME', 'cloudflared tunnel route dns <UUID_FROM_CREATE_OUTPUT> bridge.your-domain.com', 'cloudflared tunnel list']),
  zoneChecklist: 'Confirm the public hostname is in your zone and routes to this named tunnel.',
  binary: 'Tunnel program',
  credentials: 'Credentials file',
  approved: 'Approved',
  notApproved: 'Needs approval',
  noBinary: 'Not selected',
  binarySelected: 'Selected',
  noCredentials: 'Not selected',
  credentialsSelected: 'Selected',
  credentialsTooOpen: 'This credentials file is readable by other accounts. Restrict its permissions before continuing.',
  certPresent: 'A cert.pem file is present. This bridge uses the named-tunnel credentials file instead.',
  advanced: 'Advanced',
  includeDiagnostics: 'Include bridge diagnostics in FULL bug reports',
  status: 'Tunnel status',
  tunnelStates: Object.freeze({ off: 'Off', blocked: 'Blocked', 'needs-setup': 'Setup needed', 'needs-trust': 'Needs approval', starting: 'Starting', connecting: 'Connecting', 'checking-public': 'Checking public address', up: 'Online', degraded: 'Degraded', backoff: 'Waiting to retry', paused: 'Paused', stopping: 'Stopping', failed: 'Failed', unknown: 'Unknown' }),
  defaultPluginName: 'infinite_canvas',
  suggestedPluginName: 'infinite_canvas',
  suggestedPluginNameLead: 'Use this exact plugin name in ChatGPT:',
  copyPluginName: 'Copy plugin name',
  pluginNameCopied: 'Copied plugin name.',
  commandPreview: 'The app runs the approved cloudflared copy with private settings. This is not a command to copy.',
  pairingLead: 'Press Open pairing here before creating or reconnecting the ChatGPT plugin.',
  openPairing: 'Open pairing',
  cancelPairing: 'Cancel pairing',
  openChatGpt: 'Open ChatGPT plugin settings',
  copyServerUrl: 'Copy server URL',
  serverUrlCopied: 'Copied server URL.',
  copyPairingCode: 'Copy pairing code',
  pairingCodeCopied: 'Copied pairing code.',
  pairingCode: 'Pairing code',
  pairingCodeWarning: 'Enter this code only in the ChatGPT pairing page you opened yourself. Never share it.',
  pairingCodeExpiry: 'This code expires automatically within 10 minutes and disappears here when it expires.',
  progress: 'Link progress',
  progressItems: Object.freeze(['Plugin discovery opened', 'Permission requested', 'Pairing approved', 'Link issued', 'Tools listed']),
  pluginSteps: Object.freeze([
    'In ChatGPT, open Apps and create an MCP app.',
    'Enter the exact plugin name and server address shown here, then choose OAuth.',
    'Leave all Advanced OAuth fields blank. Before creating or reconnecting, press Open pairing here.',
    'Finish browser pairing. When ChatGPT first asks, choose Always allow.',
  ]),
  serverUnavailable: 'Server address appears after tunnel setup.',
  earlyBlock: 'A new plugin can be blocked for a few minutes. If its first call is blocked, wait, then start a fresh chat.',
  reconnect: 'If ChatGPT shows Reconnect, first open pairing here, then press Reconnect and enter this app’s code.',
  firstChat: 'The next step opens the worker plan. Copy each starter into a separate ChatGPT chat with the plugin selected.',
  chooseAndApproveBinaryFirst: 'Choose and approve cloudflared before continuing.',
  approveBinaryFirst: 'Approve cloudflared before continuing.',
  chooseCredentialsFirst: 'Choose the credentials file before continuing.',
  saveAddressFirst: 'Save the public address before continuing.',
  turnOnBridge: 'Turn on bridge',
  turningOnBridge: 'Turning on bridge…',
  turnOnBridgeFirst: 'Tunnel setup is saved. Turn on the bridge to start the tunnel.',
  waitForTunnel: 'The bridge is starting. Wait for the tunnel to be online before continuing.',
  completeLinkFirst: 'Link ChatGPT before starting a chat.',
  bridgeMustBeReady: 'Turn on the bridge and finish setup before starting a chat.',
  invalid: 'That value is not valid.',
});

export const IPC_ERROR_COPY = Object.freeze({
  // This is action feedback, including an incomplete preload surface and a
  // failed bridge start. The authoritative status card alone may say that a
  // build is unavailable.
  UNAVAILABLE: 'The bridge could not complete that action. Check its status and try again.', SENDER: 'That action is not allowed from this window.', BUSY: 'Another bridge dialog is open. Finish it first.', DECLINED: 'Cancelled.', INVALID: 'That value is not valid.', NO_WINDOW: 'Open a canvas window first.', NOT_READY: 'Finish setup first.', TUNNEL_NOT_READY: 'The tunnel is not reachable yet.', TUNNEL_NOT_SERVING: 'This public hostname is not serving the selected tunnel. In Cloudflare DNS, make sure its tunnel target matches the credentials file you chose.', NOT_LINKED: 'Link ChatGPT first.', PAUSED: 'The bridge is paused. Resume it first.', NO_CHAT: 'No chat has started yet. Use Copy chat starter.', QUEUE_EMPTY: 'There are no eligible handoffs queued right now.', POOL_ACTIVE: 'A worker pool is active. Use its worker starters; those chats will keep claiming handoffs automatically.', CLIPBOARD_FAILED: 'Could not copy to the clipboard. Try again.', NOT_FOUND: 'That item is no longer available.', LIMIT_REACHED: 'The bridge has reached its handoff limit.', UNKNOWN_JOB: 'That job is no longer available.', DISABLED: 'Turn on the bridge first.', LINK_WOULD_BREAK: 'Changing this breaks the ChatGPT link.', SESSION_STARTED: 'That worker has already started. Its chat will keep claiming handoffs automatically.', STARTER_COPIED: 'That unique starter was already copied. Paste, send, and pin that ChatGPT chat before starting another worker.', INTERNAL: 'Something went wrong in the bridge. Try again; if it repeats, copy a bug report.',
});
export function ipcErrorMessage(code) { return IPC_ERROR_COPY[code] || IPC_ERROR_COPY.INTERNAL; }
