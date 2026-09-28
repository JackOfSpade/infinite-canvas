import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import electronPkg from 'electron';
import { CONSTANTS } from './constants.js';
import { IPC_EVENTS, STATUS_SNAPSHOT_EXAMPLE } from './contracts.js';
import { fixedError } from './errors.js';
import { forgetConfig, readConfig, writeConfig } from './store.js';
import { isValidHostname, isValidPluginName } from '../../../src/utils/handoffBridgeConfig.js';
import { setReportRedactedHosts } from '../bugReport/helpers.js';
import { createAuditSink } from './audit.js';
import { createHandoffBridgeLog } from './log.js';
import { createApplicationSource } from './sources/application.js';
import { createPushSource } from './sources/push.js';
import { createHandoffEngine } from './engine.js';
import { createHandoffCodeGuard } from './lanes.js';
import { createLaneStore } from './laneStore.js';
import { createOAuthStore } from './oauthStore.js';
import { createOAuthServer } from './oauth.js';
import { createCimdFetcher, createJwksFetcher } from './cimd.js';
import { createMcpHandler } from './mcp.js';
import { createRequestHandler } from './http.js';
import { createListener } from './listener.js';
import { createRealTunnelSupervisor } from './tunnel/index.js';
import { createHandoffBridgeController } from './controller.js';
import { createPairingOrchestrator } from './pairing.js';
import { publicProbe, socketPublicProbe } from './egressProbe.js';
import { createHandoffBridgeDialogs } from './uiDialogs.js';
import { registerHandoffBridgeUi } from './ui.js';
import { createHandoffBridgeTray } from './tray.js';
import { createHandoffBridgePower } from './power.js';
import { clearFailedStartDiagnostic, recordFailedStartDiagnostic } from './telemetry.js';

let registered = false;
let startPromise = null;
let runtime = null;
let controllerBridge = null;
let uiRegistration = null;
let lifecycle = 0;
let bootstrapContext = null;
let bootstrapCleared = false;
let pairingTestHookRuntime = null;
let detachingRuntime = null;
const pairingBlockedRuntimes = new WeakSet();
const pairingBlockDepth = new WeakMap();
const runtimeDisposals = new WeakMap();
const runtimeDisposalModes = new WeakMap();
const completedRuntimeDisposals = new WeakMap();
const runtimeEnableOperations = new WeakMap();
const detachedPlatformOwners = new WeakSet();
const ENABLE_CONSENT_VERSION = 1;

function safelyUnderTmp(candidate, tmpdir, realpath) {
  if (typeof candidate !== 'string' || typeof tmpdir !== 'string' || !path.isAbsolute(candidate)) return false;
  if (candidate.split(path.sep).includes('..')) return false;
  try {
    const root = realpath(path.resolve(tmpdir));
    const resolved = realpath(path.resolve(candidate));
    return resolved === root || resolved.startsWith(`${root}${path.sep}`);
  } catch { return false; }
}

// The only bridge module allowed to read INFINITE_CANVAS_HANDOFF_BRIDGE_*.
export function resolveTestMode({ env = {}, isPackaged, paths = {}, tmpdir = os.tmpdir(), realpath = fs.realpathSync.native } = {}) {
  if (env.INFINITE_CANVAS_HANDOFF_BRIDGE_TEST !== '1' || isPackaged || typeof realpath !== 'function') return false;
  if (!['binaryPath', 'credentialsPath', 'userData'].every(key => safelyUnderTmp(paths[key], tmpdir, realpath))) return false;
  return Buffer.byteLength(path.join(paths.userData, CONSTANTS.SOCKET_RELATIVE_PATH)) <= CONSTANTS.SOCKET_PATH_MAX_BYTES;
}

const isE2e = env => env.INFINITE_CANVAS_E2E === '1' || env.INFINITE_CANVAS_E2E_BACKGROUND === '1';
function environmentRefusal(env, isPackaged, testMode) {
  if (env.INFINITE_CANVAS_HANDOFF_BRIDGE === '0') return 'env_disabled';
  if (isE2e(env) && !testMode) return 'e2e';
  if (!isPackaged && env.INFINITE_CANVAS_HANDOFF_BRIDGE_DEV !== '1' && !testMode) return 'unpackaged';
  return null;
}

export function refusalForStart({ env = process.env, isPackaged = electronPkg.app?.isPackaged, paths = {}, tmpdir = os.tmpdir(), enabled = false, config = null, setup = {}, stateUnreadable = false } = {}) {
  const environment = environmentRefusal(env, isPackaged, resolveTestMode({ env, isPackaged, paths, tmpdir }));
  if (environment) return environment;
  if (!enabled) return 'not_enabled';
  if (!config?.hostname) return 'no_hostname';
  if (!setup.binaryPath) return 'no_binary';
  if (!setup.binaryTrusted) return 'binary_untrusted';
  if (!setup.credentialsPath) return 'no_credentials';
  if (!setup.configValid) return 'config_invalid';
  if (setup.socketUnavailable) return 'socket_unavailable';
  if (setup.tunnelFailed) return 'tunnel_failed';
  if (stateUnreadable) return 'state_unreadable';
  return null;
}

function cloneStatusExample() { return JSON.parse(JSON.stringify(STATUS_SNAPSHOT_EXAMPLE)); }

function unavailableSnapshot(reason = null) {
  const availabilityReason = reason === 'env_disabled' ? 'env-disabled' : reason === 'e2e' ? 'e2e' : reason === 'unpackaged' ? 'dev-build' : null;
  const snapshot = cloneStatusExample();
  snapshot.availability = { ok: availabilityReason === null, reason: availabilityReason };
  snapshot.serving = 'off'; snapshot.pauseCause = null;
  return snapshot;
}
function refusalResult(reason, requestReason) { return { success: false, ...fixedError(reason), status: unavailableSnapshot(reason), reason: requestReason }; }
function appFor(deps) { return deps.app || electronPkg.app; }
function userDataFor(deps, app) { return deps.userData ?? app?.getPath?.('userData') ?? ''; }
function packagedFor(deps, app) { return deps.isPackaged ?? app?.isPackaged ?? false; }
function socketPathFor(userData) { return path.join(userData, CONSTANTS.SOCKET_RELATIVE_PATH); }
const noOp = () => undefined;
// `restartConfirmed: false` is meaningful: a routine repeat enable must leave
// the first New chat/Continue restart gate in place.  Preserve the presence of
// that boolean through bootstrap composition rather than collapsing it to the
// ordinary manual-enable default.
function startEnableArgs(reason, deps = {}) {
  const args = { reason, confirmed: deps?.confirmed === true, autoStart: reason === 'auto-start' };
  if (deps && typeof deps === 'object' && Object.hasOwn(deps, 'restartConfirmed')) {
    args.restartConfirmed = deps.restartConfirmed === true;
  }
  return args;
}

function syncReportRedactedHosts(loaded) {
  // An unreadable config does not prove that its previous hostname stopped
  // being sensitive, so leave the last known redaction set intact.
  if (!loaded || loaded.state === 'unreadable') return loaded;
  const config = loaded.config ?? loaded;
  setReportRedactedHosts(isValidHostname(config?.hostname) ? [config.hostname] : []);
  return loaded;
}

// Both OAuth and HTTP sit on untrusted/identifier-bearing boundaries.  Keep
// their composition adapter deliberately smaller than the audit schema: it
// translates only the few events these transports are allowed to project and
// never forwards an entry object wholesale (which could contain an origin,
// source prefix, header, capability id, or a future HTTP-only field).
const AUDIT_ROUTES = new Set(['mcp', 'token', 'revoke', 'authorize', 'well_known']);
const AUDIT_STATUS_CLASSES = new Set(['2xx', '4xx']);
const AUDIT_PERMIT_KINDS = new Set(['mcp_auth', 'mcp_body', 'anon_body', 'anon_body_source', 'anon_get']);
const AUDIT_FETCH_SITES = new Set(['none', 'same-origin', 'same-site', 'cross-site']);
const LOG_CLIENT_KINDS = new Set(['cimd', 'unknown']);
const AUTHENTICATED_PERMIT_POOLS = new Set(['mcp_auth', 'mcp_body']);
const auditRoute = value => {
  const normalized = value === 'oauth/token' ? 'token' : value === 'oauth/revoke' ? 'revoke' : value;
  return AUDIT_ROUTES.has(normalized) ? normalized : 'other';
};
const auditKind = value => value === 'cimd' ? 'cimd' : 'unknown';
const auditOriginHost = value => {
  const host = typeof value === 'string' ? value.toLowerCase() : '';
  // `originHost` has already parsed the header in http.js. Retain only a
  // bounded DNS-like host—not a URL, port, IPv4/IPv6 literal, or arbitrary
  // header value—under the ledger's sanctioned `source` field.
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,38}[a-z0-9])?$/.test(host)) return 'other';
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return 'other';
  return host;
};

/**
 * Project a transport event onto the frozen audit vocabulary. The sole
 * transport-derived value retained is a sanitized browser Origin hostname.
 * Returns false for unknown input and always observes async sink failures.
 */
export function appendClosedHandoffAudit(audit, event, fields = {}, stamp = Date.now()) {
  const kind = auditKind(fields?.clientKind);
  let mapped = null;
  switch (event) {
    case 'link_created': case 'link_replaced': case 'link_revoked':
    case 'refresh_reuse': case 'code_reuse':
      mapped = [event, { kind }]; break;
    case 'refresh_expired':
      mapped = ['link_revoked', { kind, reason: 'refresh_expired' }]; break;
    case 'token_revoked_by_client':
      mapped = ['link_revoked', { kind, reason: 'client' }]; break;
    case 'source_mismatch':
      mapped = ['source_mismatch', {
        route: auditRoute(fields?.route),
        statusClass: AUDIT_STATUS_CLASSES.has(fields?.statusClass) ? fields.statusClass : '4xx',
      }]; break;
    case 'permit_leak':
      mapped = ['permit_leak', { kind: AUDIT_PERMIT_KINDS.has(fields?.pool) ? fields.pool : 'unknown' }]; break;
    case 'origin_seen': {
      // Preserve only the parsed/sanitized host and the closed fetch-site
      // enum required by MG5. The raw Origin URL and raw header never cross.
      const site = typeof fields?.secFetchSite === 'string' ? fields.secFetchSite.toLowerCase() : 'none';
      mapped = ['origin_seen', {
        route: auditRoute(fields?.route),
        source: auditOriginHost(fields?.origin),
        kind: AUDIT_FETCH_SITES.has(site) ? site : 'other',
      }]; break;
    }
    case 'rate_lru_aggregate_only':
      // The aggregate limiter transition is anonymous transport telemetry;
      // represent it with the existing aggregate-only event rather than
      // widening the ledger's event vocabulary.
      mapped = ['anonymous_summary', { kind: 'rate_lru', count: 1 }]; break;
    default:
      return false;
  }
  try {
    const pending = audit?.append?.(mapped[0], mapped[1], stamp);
    pending?.catch?.(noOp);
    return true;
  } catch { return false; }
}

function recordClosedBridgeEvent(log, code, fields = {}) {
  try { log?.record?.(code, fields); return true; } catch { return false; }
}

// Keep the listener-facing handler stable while it adds the one local
// observation that belongs at the socket boundary.  In particular, an
// `Expect: 100-continue` request is dispatched through `preflight`, not the
// ordinary call path, so composition must retain that capability.
export function wrapRequestHandlerWithEgressObservation(requestHandler, observeOwnEgress = noOp) {
  const observed = new WeakSet();
  const observe = req => {
    if (req && (typeof req === 'object' || typeof req === 'function')) {
      if (observed.has(req)) return;
      observed.add(req);
    }
    try { observeOwnEgress?.({ header: req?.headers?.['x-ic-probe'], address: req?.headers?.['cf-connecting-ip'] }); } catch { /* observation is a tripwire */ }
  };
  const wrapped = (req, res) => {
    observe(req);
    return requestHandler(req, res);
  };
  if (typeof requestHandler?.preflight === 'function') {
    Object.defineProperty(wrapped, 'preflight', {
      value: (req, res) => { observe(req); return requestHandler.preflight(req, res); },
      enumerable: false,
    });
  }
  return wrapped;
}

// OAuth emits a few credential lifecycle events with internal link ids. Keep
// those ids out of the app-wide logger by projecting each event to the small,
// frozen field vocabulary in log.js. Unknown and anonymous transport events
// deliberately have no path into this function.
function projectOAuthLog(log, event, fields = {}) {
  const clientKind = LOG_CLIENT_KINDS.has(fields?.clientKind) ? fields.clientKind : 'unknown';
  switch (event) {
    case 'link_created': return recordClosedBridgeEvent(log, 'link_created', { clientKind });
    case 'link_replaced': return recordClosedBridgeEvent(log, 'link_replaced', { clientKind });
    case 'link_revoked': return recordClosedBridgeEvent(log, 'link_revoked', { cause: 'user', clientKind });
    case 'refresh_expired': return recordClosedBridgeEvent(log, 'link_revoked', { cause: 'refresh_expired', clientKind });
    case 'token_revoked_by_client': return recordClosedBridgeEvent(log, 'link_revoked', { cause: 'client', clientKind });
    case 'refresh_reuse': return recordClosedBridgeEvent(log, 'refresh_reuse', { cause: 'refresh_reuse', clientKind });
    case 'code_reuse': return recordClosedBridgeEvent(log, 'code_reuse', { cause: 'code_reuse', clientKind });
    default: return false;
  }
}

function projectAuthenticatedTransportLog(log, event, fields = {}) {
  // The HTTP pools are shared by authenticated and anonymous routes. Only the
  // two authenticated pools may affect the app logger or Activity ring.
  if (event !== 'permit_leak' || !AUTHENTICATED_PERMIT_POOLS.has(fields?.pool)) return false;
  return recordClosedBridgeEvent(log, 'permit_leak', { pool: fields.pool });
}

function isRecord(value) { return value !== null && typeof value === 'object'; }

// Setup facts are durable input; a supervisor is a live owner. Keep them
// separate even for legacy injected dependency bags that used `tunnel` for
// either shape before B6 composed both in the same call.
function isTunnelState(value) {
  return isRecord(value) && ['binaryPath', 'credentialsPath', 'pin', 'approvedAt', 'binaryTrusted', 'binaryVersion']
    .some(key => Object.hasOwn(value, key));
}

function stateFromDeps(deps = {}) {
  if (isRecord(deps.tunnelState)) return deps.tunnelState;
  if (isRecord(deps.setupState)) return deps.setupState;
  return isTunnelState(deps.tunnel) ? deps.tunnel : {};
}

function isTunnelSupervisor(value) {
  return isRecord(value) && ['start', 'stop', 'dispose', 'probe', 'status'].some(key => typeof value[key] === 'function');
}

function setupPortFromDeps(deps = {}) {
  if (isRecord(deps.tunnelSetup)) return deps.tunnelSetup;
  if (isRecord(deps.setupPort)) return deps.setupPort;
  return isRecord(deps.tunnel) && ['chooseBinary', 'approveBinary', 'chooseCredentials', 'getApprovalDetails']
    .some(key => typeof deps.tunnel[key] === 'function') ? deps.tunnel : null;
}

function mergeDefinedDeps(previous = {}, next = {}) {
  const merged = { ...(previous || {}) };
  for (const [key, value] of Object.entries(next || {})) if (value !== undefined) merged[key] = value;
  return merged;
}

function safeBootstrapConfig(value) {
  const fallback = cloneStatusExample();
  const limits = value?.limits && typeof value.limits === 'object' ? value.limits : {};
  const prefs = value?.prefs && typeof value.prefs === 'object' ? value.prefs : {};
  const hostname = isValidHostname(value?.hostname) ? value.hostname : null;
  return {
    hostname,
    pluginName: isValidPluginName(value?.pluginName) ? value.pluginName : '',
    scope: {
      applications: value?.scope?.applications !== false,
      scoring: value?.scope?.scoring === true,
    },
    autoStart: value?.autoStart === true,
    autoRelease: value?.autoRelease === true,
    limits: Object.fromEntries(Object.entries(fallback.limits).map(([key, fallbackValue]) => [
      key,
      Number.isSafeInteger(limits[key]) && limits[key] >= 0 ? limits[key] : fallbackValue,
    ])),
    prefs: {
      sourcePolicy: ['enforce', 'alert', 'off'].includes(prefs.sourcePolicy) ? prefs.sourcePolicy : fallback.prefs.sourcePolicy,
      pairingNetworkCheck: prefs.pairingNetworkCheck !== false,
    },
    telemetryInBugReports: value?.telemetryInBugReports === true,
  };
}

function readBootstrapState(context) {
  const deps = context?.deps || {};
  const userData = context?.userData;
  if (typeof userData !== 'string' || !userData) return { config: null, configUnreadable: true, setup: null };
  let loaded = null;
  try {
    loaded = (deps.readConfig || readConfig)(userData, { fsImpl: deps.fsImpl });
    if (loaded && typeof loaded.then === 'function') loaded = null;
  } catch { loaded = null; }
  const configUnreadable = !loaded || loaded.state === 'unreadable';
  if (!bootstrapCleared && !configUnreadable) syncReportRedactedHosts(loaded);
  let setup = null;
  // Read the injected setup seam only when status is requested.  Even when
  // config is unreadable, its paths may be needed internally to report the
  // test/dev availability truthfully; all setup readiness facts remain gated
  // closed below and no path-like value is ever projected.
  if (!bootstrapCleared) {
    try {
      setup = typeof deps.readTunnelState === 'function'
        ? deps.readTunnelState(userData, { fsImpl: deps.fsImpl })
        : null;
      if (setup && typeof setup.then === 'function') setup = null;
    } catch { setup = null; }
  }
  return { config: configUnreadable || bootstrapCleared ? null : (loaded.config || loaded), configUnreadable, setup };
}

function bootstrapSnapshot(context = bootstrapContext) {
  const deps = context?.deps || {};
  const env = deps.env || process.env;
  const app = context?.app || appFor(deps);
  const isPackaged = context?.isPackaged ?? packagedFor(deps, app);
  const { config: storedConfig, configUnreadable, setup } = readBootstrapState(context);
  const configured = safeBootstrapConfig(storedConfig);
  const testMode = resolveTestMode({
    env,
    isPackaged,
    paths: { binaryPath: setup?.binaryPath, credentialsPath: setup?.credentialsPath, userData: context?.userData || '' },
    tmpdir: deps.tmpdir || os.tmpdir(),
    realpath: deps.realpath || fs.realpathSync.native,
  });
  const snapshot = unavailableSnapshot(environmentRefusal(env, isPackaged, testMode));
  snapshot.enabled = false;
  snapshot.autoStart = configured.autoStart;
  snapshot.autoRelease = configured.autoRelease;
  snapshot.config = {
    hostname: configured.hostname,
    pluginName: configured.pluginName,
    mcpUrl: configured.hostname ? `https://${configured.hostname}${CONSTANTS.MCP_PATH}` : null,
    scope: configured.scope,
    telemetryInBugReports: configured.telemetryInBugReports,
  };
  snapshot.limits = configured.limits;
  snapshot.prefs = configured.prefs;
  snapshot.setup.hostnameOk = Boolean(configured.hostname);
  const binarySelected = !configUnreadable
    && typeof setup?.binaryPath === 'string'
    && /^[a-f0-9]{64}$/.test(setup?.pin || '');
  snapshot.setup.binaryApproved = binarySelected
    && (setup?.binaryTrusted === true || Number.isFinite(setup?.approvedAt));
  snapshot.setup.credentialsOk = !configUnreadable && typeof setup?.credentialsPath === 'string' && path.isAbsolute(setup.credentialsPath);
  // The off-state view deliberately never carries a path, a version, or a
  // hash prefix. It can still distinguish a selected-but-unapproved copy
  // from no copy at all through this closed, redacted binary shape.
  snapshot.tunnel.binary = binarySelected
    ? { path: null, version: null, sha256Prefix: null, approved: snapshot.setup.binaryApproved }
    : null;
  snapshot.setup.tunnelReachable = false;
  snapshot.setup.linked = false;
  snapshot.setup.toolsListed = false;
  snapshot.setup.firstCallSeen = false;
  if (configUnreadable) snapshot.fault = { code: 'state_unreadable' };
  return snapshot;
}

function activeController(current) {
  return current && runtime?.controller === current ? current : null;
}

function activeRuntimeForController(current) {
  return activeController(current) ? runtime : null;
}

// Controller snapshots include an `at` timestamp that naturally changes on
// every read.  Their source `seq` is normally the ordering authority, but a
// port-derived field can change before that controller advances its sequence.
// Compare the remaining complete projection deterministically so an
// authoritative read can surface that fact without weakening callback order.
function activeSnapshotContentKey(value) {
  if (!isRecord(value)) return null;
  const seen = new WeakSet();
  const encode = (item, topLevel = false) => {
    if (item === null) return 'null';
    if (typeof item === 'string' || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') return Number.isFinite(item) ? `number:${item}` : `number:${String(item)}`;
    if (typeof item === 'undefined') return 'undefined';
    if (typeof item === 'bigint') return `bigint:${item}`;
    if (typeof item === 'function' || typeof item === 'symbol') return `${typeof item}`;
    if (typeof item !== 'object') return String(item);
    if (seen.has(item)) return 'circular';
    seen.add(item);
    if (Array.isArray(item)) return `[${item.map(entry => encode(entry)).join(',')}]`;
    const keys = Object.keys(item)
      .filter(key => !topLevel || (key !== 'seq' && key !== 'at'))
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${encode(item[key])}`).join(',')}}`;
  };
  try { return encode(value, true); } catch { return null; }
}

function createControllerBridge() {
  let current = null;
  const listeners = new Set();
  let unsubscribe = noOp;
  // A controller instance starts its own sequence at zero, while the closed
  // bootstrap projection has no live controller at all and also uses zero.
  // The renderer quite correctly rejects equal or older snapshots. Give the
  // public IPC stream one monotonic sequence across bootstrap, attach, detach
  // and recompose, rather than asking the renderer to weaken that guard.
  let publicSeq = 0;
  let attachedGeneration = 0;
  let lastActive = null;
  let lastActiveSeq = null;
  let lastActiveContent = null;
  let lastPublic = null;
  let lastPublicOwner = null;
  let lastPublicPublished = false;
  let lastBootstrap = null;
  const project = (value, owner = null) => {
    const base = isRecord(value) ? value : bootstrapSnapshot();
    publicSeq += 1;
    lastPublicOwner = owner;
    lastPublic = { ...base, seq: publicSeq };
    lastPublicPublished = false;
    return lastPublic;
  };
  const projectActive = (active, value, { authoritativeRead = false } = {}) => {
    const sourceSeq = Number.isSafeInteger(value?.seq) && value.seq >= 0 ? value.seq : null;
    const content = activeSnapshotContentKey(value);
    // A live controller already supplies a monotonic source sequence. Keep
    // that ordering check here before translating it to the process-global
    // public sequence, so a delayed live notification cannot roll state back.
    if (lastActive === active && sourceSeq !== null && lastActiveSeq !== null && sourceSeq <= lastActiveSeq) {
      if (sourceSeq < lastActiveSeq) return null;
      // A controller's own sequence can lag a port-derived snapshot fact (for
      // example, a tunnel reachability change).  Only a direct controller read
      // is authoritative enough to accept that same-sequence content change;
      // an equal subscriber callback may be a delayed older projection.
      if (content !== null && content !== lastActiveContent) {
        if (!authoritativeRead) return null;
        lastActiveContent = content;
        return project(value, active);
      }
      // A GET/status read can observe a fresh controller value before that
      // controller's scheduled subscriber callback. The read must not cause
      // the later equal callback to disappear for other renderer windows.
      // Relay the cached public projection exactly once; lower callbacks and
      // already-relayed duplicates remain no-ops.
      if (sourceSeq === lastActiveSeq && lastPublicOwner === active && lastPublic && !lastPublicPublished) return lastPublic;
      return null;
    }
    if (lastActive === active && sourceSeq === null && lastActiveSeq === null) {
      if (content !== null && content === lastActiveContent) {
        if (lastPublicOwner === active && lastPublic && !lastPublicPublished) return lastPublic;
        return null;
      }
      // Legacy injected controllers without a source sequence have no
      // callback ordering token. Preserve their historical update behavior,
      // while still keeping identical reads stable.
    }
    if (lastActive === active && sourceSeq === null && lastActiveSeq !== null) return null;
    lastActive = active;
    lastActiveSeq = sourceSeq;
    lastActiveContent = content;
    return project(value, active);
  };
  const bootstrapStatus = ({ advance = false } = {}) => {
    if (advance || !lastBootstrap) lastBootstrap = project(bootstrapSnapshot());
    return lastBootstrap;
  };
  const status = () => {
    const active = activeController(current);
    if (!active) return bootstrapStatus();
    try {
      const next = projectActive(active, active.snapshot?.(), { authoritativeRead: true });
      // Re-reading an unchanged active controller is harmless. Return its
      // last projection instead of minting a newer sequence for the same raw
      // state; this preserves ordering when an IPC replay races a notification.
      if (next) return next;
      if (lastPublicOwner === active && lastPublic) return lastPublic;
      return bootstrapStatus();
    } catch {
      // A controller read can fail while an older bootstrap cache still exists.
      // Never return that lower sequence after this bridge has already exposed a
      // newer active projection; callers may safely retain the last known state.
      return lastPublic || bootstrapStatus();
    }
  };
  const publish = value => {
    if (value === lastPublic) lastPublicPublished = true;
    for (const listener of listeners) try { listener(value); } catch { /* renderer isolation */ }
  };
  const publishBootstrap = () => publish(bootstrapStatus({ advance: true }));
  const attach = next => {
    try { unsubscribe(); } catch { /* old runtime is already stopped */ }
    current = next || null;
    attachedGeneration += 1;
    lastActive = null;
    lastActiveSeq = null;
    lastActiveContent = null;
    const generation = attachedGeneration;
    unsubscribe = typeof current?.subscribe === 'function'
      ? current.subscribe(value => {
        // An old controller may finish a scheduled callback after detach or
        // replacement. Its status belongs to neither the current graph nor
        // the public sequence stream.
        if (generation !== attachedGeneration || current !== next || activeController(current) !== next) return;
        const projected = projectActive(next, value);
        if (projected) publish(projected);
      })
      : noOp;
    // An attach or detach is a real public state transition even if both
    // owners happen to report source sequence zero. Off-state reads, in
    // contrast, keep their stable cached bootstrap snapshot until an explicit
    // mutation/publish asks us to refresh it.
    if (!next) {
      publish(bootstrapStatus({ advance: true }));
      return;
    }
    let initial;
    try { initial = next.snapshot?.(); } catch {
      // A newly attached controller has no usable public state yet.  Do not
      // re-label the preceding controller's projection as this controller:
      // that could show a stale live bridge after a failed recompose.  A
      // synchronous injected subscriber may already have supplied this
      // controller's status; otherwise publish a fresh, closed bootstrap
      // projection for the new dependency/user-data context.
      if (lastPublicOwner !== next) publish(project(bootstrapSnapshot(), next));
      return;
    }
    const projected = projectActive(next, initial, { authoritativeRead: true });
    if (projected) publish(projected);
  };
  const unavailable = () => ({ success: false, code: 'UNAVAILABLE', status: status() });
  const call = name => (...args) => activeController(current)?.[name]?.(...args) || Promise.resolve(unavailable());
  return Object.freeze({
    attach, snapshot: status, status, publishBootstrap,
    // Registration can replace the user-data/dependency context without
    // attaching a runtime. Clear only the cached projection; the next status
    // read performs the normal lazy bootstrap read and receives a new public
    // sequence. This must not publish or touch disk during registration.
    invalidateBootstrap: () => { lastBootstrap = null; },
    subscribe(listener) { if (typeof listener !== 'function') return noOp; listeners.add(listener); return () => listeners.delete(listener); },
    enable: async args => {
      const active = activeController(current);
      // Go through the graph wrapper rather than invoking an attached
      // controller directly. It owns the redacted failed-start receipt used
      // by an opted-in FULL bug report after runtime disposal.
      const attached = activeRuntimeForController(active);
      if (attached) return enableAttachedRuntime(attached, args);
      if (active?.enable) return active.enable(args);
      const startDeps = { ...(bootstrapContext?.deps || {}), enabled: true, activate: true, confirmed: args?.confirmed === true };
      if (args && typeof args === 'object' && Object.hasOwn(args, 'restartConfirmed')) {
        startDeps.restartConfirmed = args.restartConfirmed === true;
      }
      return startHandoffBridge({ reason: 'manual', deps: startDeps });
    },
    disable: async () => disposeCurrentRuntime(),
    revokeAll: async (...args) => revokeActiveRuntime(activeRuntimeForController(current), args, status),
    forget: async () => forgetActiveRuntime(activeRuntimeForController(current), status),
    pause: call('pause'), resume: call('resume'), release: call('release'), unrelease: call('unrelease'),
    releasePushHubs: call('releasePushHubs'), unreleasePushHub: call('unreleasePushHub'),
    newChat: call('newChat'), continueChat: call('continueChat'), prepareChat: call('prepareChat'), commitChat: call('commitChat'), abandonChat: call('abandonChat'),
    getActivity: call('getActivity'),
    reloadConfig: async () => {
      const active = activeController(current);
      if (active?.reloadConfig) return active.reloadConfig();
      const fresh = bootstrapStatus({ advance: true }); publish(fresh); return { success: true, status: fresh };
    },
    ackAlarm: call('ackAlarm'),
  });
}

function runtimePort(name, methods) {
  const port = {};
  for (const method of methods) port[method] = (...args) => runtime?.[name]?.[method]?.(...args);
  return Object.freeze(port);
}

function tunnelUiPort(setup = null) {
  const setupMethod = name => (...args) => setup?.[name]?.(...args) || Promise.resolve({ ok: false, code: 'NOT_READY' });
  const runtimeMethod = name => (...args) => runtime?.tunnel?.[name]?.(...args) || Promise.resolve(name === 'getLog' ? [] : { ok: false, code: 'NOT_READY' });
  return Object.freeze({
    chooseBinary: setupMethod('chooseBinary'), approveBinary: setupMethod('approveBinary'), chooseCredentials: setupMethod('chooseCredentials'), getApprovalDetails: setupMethod('getApprovalDetails'),
    // Reaping is a fixed-argument setup operation. Do not route it through a
    // live supervisor or accept a renderer-supplied PID/path.
    reapOrphans: setupMethod('reapOrphans'),
    restart: runtimeMethod('restart'), getLog: runtimeMethod('getLog'),
  });
}

function enableConsentPort({ userData, deps = {} } = {}) {
  const load = () => {
    try { return syncReportRedactedHosts((deps.readConfig || readConfig)(userData, deps))?.config || null; } catch { return null; }
  };
  const describe = async () => {
    const config = load();
    const hostname = isValidHostname(config?.hostname) ? config.hostname : null;
    const groups = new Map();
    try {
      // This is intentionally the raw durable list: restart rehydration is
      // for engine serving, whereas consent describes the originally selected
      // jobs before a user has reaffirmed that restart hold.
      const lanes = createLaneStore({ userDataPath: userData, fsImpl: deps.fsImpl }).readLanes?.() || [];
      for (const lane of Array.isArray(lanes) ? lanes : []) {
        if (typeof lane?.canvasFilePath !== 'string' || typeof lane?.jobId !== 'string') continue;
        const ids = groups.get(lane.canvasFilePath) || [];
        if (ids.length < 50) ids.push(lane.jobId);
        groups.set(lane.canvasFilePath, ids);
      }
    } catch { /* missing or malformed lane state is an empty durable set */ }
    const source = deps.application || runtime?.application || createApplicationSource({ api: deps.applicationApi });
    const items = [];
    for (const [canvasFilePath, jobIds] of groups) {
      try {
        const described = await source.describeForConfirm?.(canvasFilePath, jobIds);
        if (!Array.isArray(described?.items)) continue;
        const wanted = new Set(jobIds);
        const seen = new Set();
        for (const item of described.items) {
          if (items.length >= 50) break;
          // An application adapter is a data boundary too: native consent may
          // name only durable lanes which were actually selected, never an
          // opportunistic extra returned by a broad canvas query.
          if (!wanted.has(item?.jobId) || seen.has(item.jobId)) continue;
          seen.add(item.jobId);
          items.push(item);
        }
      } catch { /* an unavailable canvas never makes untrusted text */ }
    }
    return {
      // Hostname changes atomically reset this field in the write adapter,
      // therefore a matching current version is also a matching address.
      long: config?.consentVersion !== ENABLE_CONSENT_VERSION,
      hostname,
      idlePauseMinutes: config?.limits?.idlePauseMinutes,
      items,
    };
  };
  const accept = async () => {
    const config = load();
    if (!config || config.consentVersion === ENABLE_CONSENT_VERSION) return true;
    try {
      const result = await (deps.writeConfig || writeConfig)(userData, { consentVersion: ENABLE_CONSENT_VERSION }, { linked: false });
      return result?.ok === true;
    } catch { return false; }
  };
  return Object.freeze({ describe, accept });
}


/** Builds, but never starts, the real graph after the refusal ladder passes. */
export function composeHandoffBridge({ userData, config, tunnelState, setupState, tunnel: legacyTunnel, testMode = false, deps = {} } = {}) {
  // `tunnel` remains a read-only compatibility alias for existing callers;
  // new composition callers must pass `tunnelState` so it cannot be confused
  // with `deps.tunnel`, the optional live supervisor seam.
  const setup = isRecord(tunnelState) ? tunnelState : isRecord(setupState) ? setupState : isRecord(legacyTunnel) ? legacyTunnel : {};
  const socketPath = socketPathFor(userData);
  if (Buffer.byteLength(socketPath) > CONSTANTS.SOCKET_PATH_MAX_BYTES) {
    const error = new Error('socket path too long'); error.code = 'path_too_long'; throw error;
  }
  const now = deps.now || Date.now;
  const timers = deps.timers || globalThis;
  // A supplied test log remains the exact injected port. Production gets one
  // concrete owner shared by engine and controller, backed by main's existing
  // app logger and its bug-report ring.
  const bridgeLog = deps.log || createHandoffBridgeLog({ logger: deps.appLogger, now });
  const getCanvasWindows = deps.getCanvasWindows || (() => []);
  const windows = {
    getCanvasWindows,
    // Push validates the exact live sender/window/path tuple.  This adapter is
    // a read-only view over BrowserWindow instances, never renderer metadata.
    get: id => (getCanvasWindows() || []).find(window => window?.webContents?.id === id) || null,
  };
  const audit = deps.audit || createAuditSink({ userDataPath: userData, fsImpl: deps.fsImpl });
  const laneStore = deps.laneStore || createLaneStore({ userDataPath: userData, fsImpl: deps.fsImpl });
  const codeGuard = deps.codeGuard || createHandoffCodeGuard();
  const application = deps.application || createApplicationSource({ api: deps.applicationApi, setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout, codeGuard });
  const hubKey = (canvasFilePath, nodeId) => crypto.createHash('sha256').update(`${canvasFilePath}\n${nodeId}`, 'utf8').digest('hex');
  const push = deps.push || createPushSource({ seam: deps.pushSeam, now, timers, windows, hubKey, codeGuard });
  let pairing;
  let controller;
  const oauthStore = deps.oauthStore || createOAuthStore({ filePath: path.join(userData, 'handoff-bridge', 'oauth-state.json'), fsImpl: deps.fsImpl });
  const appendOAuthAudit = (event, fields = {}) => appendClosedHandoffAudit(audit, event, fields, now());
  const oauth = deps.oauth || createOAuthServer({ issuer: `https://${config.hostname}`, store: oauthStore,
    fetchClientMetadata: deps.fetchClientMetadata || createCimdFetcher({ request: deps.httpsRequest, lookup: deps.lookup }),
    fetchJwks: deps.fetchJwks || createJwksFetcher({ request: deps.httpsRequest, lookup: deps.lookup }), now,
    pairingGate: request => pairing?.pairingGate?.(request) === true,
    onPairingClosed: reason => pairing?.onOAuthPairingClosed?.(reason),
    onConsentRequested: value => {
      // A consent request reaches this callback only after an active pairing
      // gate and a valid local transaction. Keep its logger facts closed.
      recordClosedBridgeEvent(bridgeLog, 'consent_requested', { clientKind: LOG_CLIENT_KINDS.has(value?.clientKind) ? value.clientKind : 'unknown' });
      return pairing?.onConsentRequested?.(value);
    }, onLinked: value => pairing?.onLinked?.(value), onDisconnected: value => pairing?.onDisconnected?.(value),
    onAuthorizeWithoutWindow: value => {
      // This is deliberately a one-way, status-only reconnect seam. Pairing
      // applies its fresh-own-egress/renewal/rate gates and never opens a
      // sheet, sends a notice, or receives any request content here.
      try { pairing?.maybeHint?.({ source: value?.source, linkState: value?.linkState, knownFamily: value?.knownFamily === true }); } catch { /* anonymous noise stays inert */ }
    },
    emitSecurityEvent: (event, fields) => {
      // OAuth knows whether the credential event was authenticated; controller
      // alone decides whether it can pause/revoke.  Anonymous traffic never
      // reaches the app logger or activity ring.
      const credentialEvent = event === 'refresh_reuse' || event === 'code_reuse';
      try { controller?.onSecurityEvent?.({ kind: event, authenticated: credentialEvent || fields?.authenticated === true }); } catch { /* policy is fail-closed */ }
      appendOAuthAudit(event, fields);
      projectOAuthLog(bridgeLog, event, fields);
    } });
  // UI candidate ownership is established by the renderer publication port.
  // The engine must never broadcast by a canvas path, which can have several
  // windows; the registration resolves the exact current publishing sender.
  const notifyOwningWindow = value => uiRegistration?.notifyJobChanged?.(value) === true;
  const makeEngine = () => deps.engine || createHandoffEngine({
    sources: { application, push }, store: laneStore, audit, logger: bridgeLog, now, timers,
    limits: config.limits, scope: config.scope,
    // Engine restoration needs restart-held normalized lanes, while the
    // native enable confirmation below intentionally reads raw durable lanes
    // so it can name the original selected jobs before rehydration.
    restoredLanes: laneStore.loadLanes?.(now()) || [], autoStart: config.autoStart === true,
    confirmRestart: async ords => (await controller?.confirmRestart?.(ords)) === true,
    onJobChanged: notifyOwningWindow,
    codeGuard,
  });
  let engine = makeEngine();
  // HTTP owns source-family evaluation and its sole audit/counter event.  This
  // dynamic mode port is deliberately distinct from the controller's direct
  // test seam, so an authenticated MCP request is not evaluated twice.
  const sourcePolicy = () => {
    const policy = controller?.snapshot?.()?.prefs?.sourcePolicy || config.prefs?.sourcePolicy;
    return ['enforce', 'alert', 'off'].includes(policy) ? policy : 'enforce';
  };
  const mcp = deps.mcp || createMcpHandler({
    // Do not expose the engine directly: source, auth, window and pause gates
    // belong to the controller and must apply to every MCP tool request.
    port: { get: args => controller?.get?.(args), submit: args => controller?.submit?.(args) },
    setTimeoutImpl: timers.setTimeout, clearTimeoutImpl: timers.clearTimeout,
  });
  const requestHandler = deps.requestHandler || createRequestHandler({
    hostname: config.hostname, oauth, authenticate: oauth.authenticate, mcp, now, timers, sourcePolicy,
    // HTTP owns its anonymous accounting and audit write.  The controller only
    // projects its closed counters; it must not turn transport noise into a
    // security event or write a second audit record.
    counters: { increment: kind => controller?.onTransportCount?.(kind) },
    audit: { write: entry => {
      const event = entry?.ev;
      const appended = appendClosedHandoffAudit(audit, event, entry, now());
      projectAuthenticatedTransportLog(bridgeLog, event, entry);
      return appended;
    } },
  });
  // The listener is the only place that sees Cf-Connecting-IP.  It consumes
  // the one-shot HMAC observation before the OAuth route can inspect pairing.
  let supervisedTunnel = null;
  const listenerHandler = wrapRequestHandlerWithEgressObservation(requestHandler, value => pairing?.recordOwnEgress?.(value));
  const listener = deps.listener || createListener({ socketPath, handler: listenerHandler, fsModule: deps.fsImpl, timers, beforeRebind: async () => { await supervisedTunnel?.stop?.(); } });
  const probe = testMode
    ? options => socketPublicProbe({ ...options, socketPath, request: deps.socketRequest || http.request })
    : options => publicProbe({ ...options, request: deps.publicRequest, lookup: deps.lookup });
  // `power` below is the one owner of the platform resume listener.  Passing
  // the same monitor to the tunnel wrapper would register a second probe.
  const makeTunnelSupervisor = typeof deps.createTunnelSupervisor === 'function'
    ? deps.createTunnelSupervisor
    : createRealTunnelSupervisor;
  supervisedTunnel = deps.tunnelSupervisor || (isTunnelSupervisor(deps.tunnel) ? deps.tunnel : null)
    || makeTunnelSupervisor({ userData, hostname: config.hostname, socketPath, credentialsPath: setup.credentialsPath, binaryPath: setup.binaryPath, pin: setup.pin, approvedAt: setup.approvedAt, testMode, publicProbeFn: hostname => probe({ hostname }), timers, now, fsImpl: deps.fsImpl, HOME: deps.HOME ?? os.homedir(), TMPDIR: deps.TMPDIR ?? os.tmpdir() });
  // Only the app-owned production supervisor gets readiness authority. An
  // injected controller/tunnel port keeps its direct start/probe contract for
  // deterministic unit tests and narrow integration seams.
  const waitForOwnedTunnelOnline = !deps.tunnelSupervisor && !isTunnelSupervisor(deps.tunnel);
  // Preserve only setup facts suitable for the status card; supervisor status
  // is still the authority for process state and never exposes child details.
  const tunnel = Object.freeze({
    ...supervisedTunnel,
    status: () => ({
      ...(supervisedTunnel.status?.() || {}),
      binary: { approved: setup.binaryTrusted === true, version: typeof setup.binaryVersion === 'string' ? setup.binaryVersion : null, sha256Prefix: /^[a-f0-9]{64}$/.test(setup.pin || '') ? setup.pin.slice(0, 12) : null },
      credentialsOk: Boolean(setup.credentialsPath), credentialsMode: typeof setup.credentialsMode === 'string' ? setup.credentialsMode : null,
      // Tunnel UUIDs and all filesystem locations stay main-owned.  The UI
      // gets only a closed readiness/status projection.
      tunnelId: null,
    }),
  });
  const dialogs = deps.dialogs || createHandoffBridgeDialogs({ dialog: deps.dialog || electronPkg.dialog, getCanvasWindows: windows.getCanvasWindows });
  let pairingParent = null;
  let pairingCode = null;
  const pairingLifecycle = (event, cause) => {
    const safeCause = event === 'pairing_opened'
      ? 'user'
      : ['linked', 'denied', 'expired', 'cancelled', 'locked', 'replaced', 'restart', 'revoked'].includes(cause) ? cause : 'cancelled';
    try { audit.append?.(event, { cause: safeCause }, now())?.catch?.(noOp); } catch { /* audit is best effort */ }
    recordClosedBridgeEvent(bridgeLog, event, { cause: safeCause });
  };
  pairing = deps.pairing || createPairingOrchestrator({ oauth, request: deps.publicRequest, lookup: deps.lookup,
    egressProbe: deps.probeOwnEgress, now, timers,
    // The test-only hook is armed only after the dialog adapter synchronously
    // confirms a real native sheet.  In particular, a missing/busy/rejected
    // adapter must not make the code observable for even one event-loop turn.
    showCode: value => {
      const shown = () => {
        let accepted = false;
        try { accepted = value?.onShown?.() === true; } catch { accepted = false; }
        if (accepted) pairingCode = typeof value?.code === 'string' ? value.code : null;
        return accepted;
      };
      let pending;
      try { pending = dialogs.showCode?.({ ...value, onShown: shown }); }
      catch (error) { pairingCode = null; throw error; }
      return Promise.resolve(pending).finally(() => { pairingCode = null; });
    },
    showNotice: value => dialogs.showNotice?.({ ...value, parentWindow: pairingParent }),
    hint: () => controller?.onReconnectHint?.(),
    onOpened: () => pairingLifecycle('pairing_opened', 'user'),
    onClosed: cause => pairingLifecycle('pairing_closed', cause) });
  const openPairing = async value => {
    const status = controller?.snapshot?.(false);
    if (status?.enabled !== true || status?.setup?.tunnelReachable !== true) return Promise.resolve({ ok: false, code: 'TUNNEL_NOT_READY' });
    pairingParent = value?.parentWindow || null;
    const networkCheck = status?.prefs?.pairingNetworkCheck === false ? 'off' : 'enforce';
    const result = await pairing.open({ ...(value || {}), networkCheck });
    if (result?.ok === true) controller?.notePairingAction?.();
    return result;
  };
  const dialogConfirm = kind => async (details, dialogContext = null) => {
    const windows = () => {
      try { return (getCanvasWindows() || []).filter(window => !window?.isDestroyed?.()); } catch { return []; }
    };
    // A New/Continue IPC can defer its restart warning until after a short
    // enable. If it supplied an exact guarded sender, never silently move
    // that warning to a different canvas when the original closes. Direct
    // controller/tray calls have no context and retain the first-window
    // fallback for their existing main-process-only path.
    const requested = dialogContext?.sender;
    const parent = requested
      ? windows().find(window => window?.webContents === requested) || null
      : windows()[0] || null;
    const answer = await dialogs.ask?.(parent?.webContents, kind, details);
    // A deferred restart sheet belongs to its initiating renderer, not merely
    // whichever canvas happens to be open when the sheet resolves. Do not let
    // an accepted response from a closed canvas acknowledge that restart hold.
    if (requested && !windows().some(window => window?.webContents === requested)) {
      return { ok: false, code: 'NO_WINDOW' };
    }
    return answer;
  };
  let tray = null;
  const showFixedNotification = kind => {
    const body = {
      paused: 'Handoff bridge paused. Review it in Infinite Canvas.',
      'served-after-idle': 'Handoff bridge served after a long idle period. Review it in Infinite Canvas.',
      'link-expiring': 'ChatGPT link expires soon. Review it in Infinite Canvas.',
    }[kind];
    if (!body) return;
    try {
      const Notification = deps.Notification || electronPkg.Notification;
      const notification = typeof Notification === 'function' ? new Notification({ title: 'Infinite Canvas', body }) : null;
      notification?.show?.();
    } catch { /* notification permission is optional */ }
  };
  const controllerNotification = kind => {
    const status = controller?.snapshot?.(false);
    if (kind === 'paused') {
      try { tray?.alarm?.(status); } catch { /* tray is optional */ }
      return;
    }
    try { tray?.apply?.(status); } catch { /* tray is optional */ }
    showFixedNotification(kind);
  };
  controller = deps.controller || createHandoffBridgeController({ now, timers, config, enabled: false, audit, log: bridgeLog, windows, tunnel, engine, listener,
    waitForTunnelOnline: waitForOwnedTunnelOnline,
    ui: { confirmEnable: dialogConfirm('enable'), confirmRestart: dialogConfirm('restart'), notify: controllerNotification },
    oauth: {
      ...oauth,
      pairingStatus: () => ({ ...pairing.status(), unarmedRequests: oauth.unarmedStatus?.() }),
      openPairing,
      cancelPairing: pairing.cancel,
    }, publicProbe: options => probe(options),
    store: {
      readConfig: () => syncReportRedactedHosts((deps.readConfig || readConfig)(userData, deps)),
      setEnabled: async enabled => (deps.writeEnabled ? deps.writeEnabled(enabled) : true),
      forget: () => (deps.forgetConfig || forgetConfig)(userData, { fsImpl: deps.fsImpl }),
    },
    sourcePolicy: null,
    rate: deps.rate,
    recreateEngine: async () => {
      // `engine.close()` is terminal. Build a fresh memory-only epoch after a
      // hard Disable so the next explicit enable cannot reuse a closed engine.
      const next = deps.engine ? null : makeEngine();
      if (!next) return null;
      engine = next;
      return next;
    },
    describeRestart: async ({ groups = [] } = {}) => {
      const items = [];
      for (const group of Array.isArray(groups) ? groups.slice(0, 50) : []) {
        if (typeof group?.canvasFilePath !== 'string' || !Array.isArray(group.jobIds)) continue;
        try {
          const described = await application.describeForConfirm?.(group.canvasFilePath, group.jobIds);
          if (!Array.isArray(described?.items)) continue;
          const wanted = new Set(group.jobIds);
          const seen = new Set();
          for (const item of described.items) {
            if (items.length >= 50) break;
            if (!wanted.has(item?.jobId) || seen.has(item.jobId)) continue;
            seen.add(item.jobId);
            items.push(item);
          }
        } catch { /* unavailable source produces an empty native list */ }
      }
      return { items };
    },
    refusalForStart: input => refusalForStart({
      env: input?.env, isPackaged: input?.isPackaged, tmpdir: input?.tmpdir,
      enabled: input?.enabled, config: input?.config, stateUnreadable: input?.stateUnreadable,
      paths: { binaryPath: setup.binaryPath, credentialsPath: setup.credentialsPath, userData },
      setup: { binaryPath: setup.binaryPath, binaryTrusted: setup.binaryTrusted, credentialsPath: setup.credentialsPath, configValid: true, socketUnavailable: setup.socketUnavailable, tunnelFailed: setup.tunnelFailed },
    }) });
  const power = deps.power || createHandoffBridgePower({
    powerMonitor: deps.powerMonitor,
    powerSaveBlocker: deps.powerSaveBlocker,
    getCanvasWindows,
    now,
    timers,
    // This is the sole platform resume listener. It fences stale engine work
    // and asks the already-composed supervisor for one contained probe.
    onResume: () => {
      try { engine?.onPowerResume?.(); } catch { /* engine fence is best effort */ }
      try { void supervisedTunnel?.probe?.(); } catch { /* supervisor owns retries */ }
    },
  });
  tray = deps.tray || createHandoffBridgeTray({
    controller,
    getCanvasWindows: windows.getCanvasWindows,
    dialogs,
    onOpenPanel: value => uiRegistration?.openPanel?.(value?.panel || 'bridge', value?.step),
    notify: showFixedNotification,
  });
  const unsubscribeUi = controller.subscribe?.(status => {
    try { tray.apply?.(status); } catch { /* platform tray is optional */ }
    try {
      const internal = engine.powerState?.() || {};
      const hostPaths = new Set(Array.isArray(internal.hostCanvasPaths) ? internal.hostCanvasPaths : []);
      const hostWindowIds = (getCanvasWindows() || []).filter(window => hostPaths.has(window?.__canvasFilePath)).map(window => window?.webContents?.id).filter(Number.isInteger);
      power.update?.({
        hostLane: hostWindowIds.length > 0,
        awaitingLane: internal.awaiting === true,
        lastCallAt: Number.isFinite(internal.lastCallAt) ? internal.lastCallAt : null,
        hostWindowIds,
      });
    } catch { /* power policy is best effort */ }
  }) || noOp;
  return Object.freeze({ userData, config, socketPath, testMode, audit, log: bridgeLog, laneStore, application, push, oauth, openPairing, get engine() { return engine; }, mcp, requestHandler, listener, tunnel, pairing, controller, dialogs, power, tray, unsubscribeUi, readPairingCode: () => pairingCode });
}

function removePairingTestHook(current = null) {
  if (current && pairingTestHookRuntime !== current) return;
  try { delete globalThis.__icHandoffBridgeTest; } catch { /* an exotic global must not block teardown */ }
  pairingTestHookRuntime = null;
}

function installPairingTestHook(current) {
  pairingTestHookRuntime = current;
  globalThis.__icHandoffBridgeTest = Object.freeze({ readPairingCode: () => current.readPairingCode?.() ?? null });
}

function invokeOwner(port, methods) {
  for (const method of methods) {
    if (typeof port?.[method] !== 'function') continue;
    try { Promise.resolve(port[method]()).catch(noOp); } catch { /* cleanup is best effort after hard-off */ }
  }
}

function blockRuntimePairing(current) {
  if (!current || typeof current !== 'object') return;
  pairingBlockDepth.set(current, (pairingBlockDepth.get(current) || 0) + 1);
  pairingBlockedRuntimes.add(current);
}

function unblockRuntimePairing(current) {
  const depth = pairingBlockDepth.get(current) || 0;
  if (depth > 1) { pairingBlockDepth.set(current, depth - 1); return; }
  pairingBlockDepth.delete(current);
  pairingBlockedRuntimes.delete(current);
}

function cancelRuntimePairing(current, { block = true } = {}) {
  if (!current || typeof current !== 'object') return;
  if (block) blockRuntimePairing(current);
  // Pairing owns a separate native-sheet AbortController and expiry timer; the
  // OAuth close alone cannot stop either one.
  invokeOwner(current.pairing, ['cancel', 'close', 'dispose']);
  invokeOwner(current.oauth, ['closePairing']);
}

function detachRuntime(current, { advanceLifecycle = true } = {}) {
  if (!current || runtime !== current) return false;
  if (advanceLifecycle) lifecycle += 1;
  cancelRuntimePairing(current);
  runtime = null;
  runtimeEnableOperations.delete(current);
  if (startPromise) startPromise = null;
  removePairingTestHook(current);
  controllerBridge?.attach?.(null);
  return true;
}

function detachPlatformOwners(current) {
  if (!current || detachedPlatformOwners.has(current)) return;
  detachedPlatformOwners.add(current);
  try { current?.unsubscribeUi?.(); } catch { /* the controller is already detached */ }
  try { current?.power?.dispose?.(); } catch { /* removes suspend/resume listeners */ }
  try { current?.tray?.destroy?.(); } catch { /* tray and Dock state are optional */ }
}

function finishRuntimeDisposal(current) {
  detachPlatformOwners(current);
  cancelRuntimePairing(current);
  // Controller.disable performs the ordered stop path. These calls cover
  // owners it does not own (or a custom injected graph) without making the
  // hard-off result wait beyond the controller's shared teardown budget.
  invokeOwner(current?.listener, ['dispose', 'close', 'stop']);
  invokeOwner(current?.tunnel, ['dispose', 'stop', 'close']);
  invokeOwner(current?.oauth, ['closePairing', 'close', 'dispose']);
  invokeOwner(current?.audit, ['flush', 'close', 'dispose']);
  invokeOwner(current?.engine, ['close', 'dispose']);
}

function escalateDetachedRuntimeToHardOff(current) {
  if (!current || runtimeDisposalModes.get(current) !== 'graceful') return;
  // shutdownForQuit() deliberately keeps an already admitted request alive
  // through listener.drain. A later interactive Disable must be able to turn
  // that grace period into an immediate source fence without starting a second
  // teardown or extending its shared deadline.
  try { Promise.resolve(current.controller?.disable?.()).catch(noOp); } catch { /* the existing disposer owns final cleanup */ }
}

function disposeDetachedRuntime(current, { controllerAlreadyDisabled = false, graceful = false } = {}) {
  if (!current || typeof current !== 'object') return Promise.resolve({ success: true, status: bootstrapSnapshot() });
  const completed = completedRuntimeDisposals.get(current);
  if (completed) return Promise.resolve({ ...completed, status: bootstrapSnapshot() });
  const previous = runtimeDisposals.get(current);
  if (previous) {
    if (!controllerAlreadyDisabled && !graceful) escalateDetachedRuntimeToHardOff(current);
    return previous;
  }
  const stopMethod = graceful && typeof current.controller?.shutdownForQuit === 'function' ? 'shutdownForQuit' : 'disable';
  runtimeDisposalModes.set(current, stopMethod === 'shutdownForQuit' ? 'graceful' : 'hard');
  const operation = (async () => {
    cancelRuntimePairing(current);
    let result = { success: true };
    if (!controllerAlreadyDisabled) {
      let stopping;
      try { stopping = Promise.resolve(current.controller?.[stopMethod]?.()); } catch { stopping = Promise.resolve({ success: false, code: 'persist_failed' }); }
      // Both controller stop paths synchronously close their accepting gate.
      // The quit-specific one then drains already admitted listener work before
      // closing the engine; an interactive Disable uses the hard fence.
      detachPlatformOwners(current);
      try { result = await stopping; } catch { result = { success: false, code: 'persist_failed' }; }
    }
    finishRuntimeDisposal(current);
    return result?.success === false
      ? { ...result, status: bootstrapSnapshot() }
      : { success: true, status: bootstrapSnapshot() };
  })();
  const settled = operation.then(result => {
    const remembered = { success: result?.success !== false, ...(result?.code ? { code: result.code } : {}) };
    completedRuntimeDisposals.set(current, remembered);
    return result;
  }).finally(() => {
    runtimeDisposals.delete(current);
    runtimeDisposalModes.delete(current);
    if (detachingRuntime === current) detachingRuntime = null;
  });
  runtimeDisposals.set(current, settled);
  return settled;
}

async function disposeCurrentRuntime({ graceful = false } = {}) {
  const current = runtime;
  if (!current) {
    const pending = detachingRuntime && runtimeDisposals.get(detachingRuntime);
    if (pending) {
      // A UI Disable may arrive through its IPC bridge after stopHandoffBridge
      // detached the runtime. Escalate the existing graceful owner rather
      // than silently accepting the command or launching duplicate cleanup.
      if (!graceful) escalateDetachedRuntimeToHardOff(detachingRuntime);
      const result = await pending;
      return {
        success: result?.success !== false,
        status: bootstrapSnapshot(),
        ...(result?.code ? { code: result.code } : {}),
      };
    }
    lifecycle += 1;
    if (startPromise) startPromise = null;
    removePairingTestHook();
    controllerBridge?.attach?.(null);
    return { success: true, status: bootstrapSnapshot() };
  }
  detachRuntime(current);
  detachingRuntime = current;
  const result = await disposeDetachedRuntime(current, { graceful });
  // A failed durable flag is still a hard detached graph, but the IPC caller
  // must not receive a false acknowledgement: another launch could otherwise
  // observe the old durable setting and attempt an automatic start.
  return {
    success: result?.success !== false,
    status: bootstrapSnapshot(),
    ...(result?.code ? { code: result.code } : {}),
  };
}

function openRuntimePairing(...args) {
  const current = runtime;
  if (!current || pairingBlockedRuntimes.has(current)) return Promise.resolve({ ok: false, code: 'TUNNEL_NOT_READY' });
  try {
    const status = current.controller?.snapshot?.(false);
    if (status?.enabled !== true || status?.setup?.tunnelReachable !== true) return Promise.resolve({ ok: false, code: 'TUNNEL_NOT_READY' });
    return current.openPairing?.(...args) || Promise.resolve({ ok: false, code: 'TUNNEL_NOT_READY' });
  } catch { return Promise.resolve({ ok: false, code: 'TUNNEL_NOT_READY' }); }
}

// `current.config` is the immutable composition input, whereas reloadConfig()
// deliberately lets an attached controller adopt a newer durable preference.
// Failed-start telemetry is optional, so its decision must come from the
// controller's just-produced status (or, for injected legacy results without
// one, a fresh controller snapshot). Treat every malformed or unreadable
// status as opt-out; diagnostics must never survive a preference read fault.
function failedStartTelemetryEnabled(result, controller) {
  try {
    const status = result?.status === undefined ? controller?.snapshot?.(false) : result.status;
    return status !== null
      && typeof status === 'object'
      && status.config !== null
      && typeof status.config === 'object'
      && status.config.telemetryInBugReports === true;
  } catch { return false; }
}

function enableAttachedRuntime(current, args, lifecycleTicket = lifecycle) {
  if (!current?.controller?.enable) return Promise.resolve({ success: false, code: 'UNAVAILABLE', status: bootstrapSnapshot() });
  const prior = runtimeEnableOperations.get(current);
  if (prior) return prior;
  // A new explicit Enable attempt supersedes a prior failed-start receipt.
  // Do this only after the coalescing check: a duplicate click must never
  // erase the diagnostic while the original operation is still running.
  clearFailedStartDiagnostic();
  const retainFailedStart = result => {
    // Refusals/cancellation are ordinary control flow, not diagnostic events.
    // A controller only supplies this closed object after an actual startup
    // fault, and its `at` is taken from the controller's injected clock.
    if (result?.success || !result?.diagnostic || typeof result.diagnostic !== 'object') return result;
    // A graph may have been attached earlier (for example before its first
    // explicit Enable). Keep the same closed receipt as the fresh-composition
    // path before a failed controller start can be detached by its caller.
    // Never retain the thrown value itself: controller diagnostics are the
    // only source and telemetry.js reduces them to fixed enums.
    const telemetry = failedStartTelemetryEnabled(result, current.controller);
    if (!telemetry) {
      // The receipt itself is optional telemetry. Keeping a false-marked
      // receipt would let a later preference bug revive an opted-out attempt.
      clearFailedStartDiagnostic();
      return result;
    }
    recordFailedStartDiagnostic({
      telemetry,
      phase: result?.diagnostic?.phase,
      cause: result?.diagnostic?.cause,
      tunnel: result?.diagnostic?.tunnel || current.tunnel?.status?.(),
      startedAt: result?.diagnostic?.startedAt,
      at: result.diagnostic.at,
    });
    return result;
  };
  let settled;
  const operation = Promise.resolve()
    .then(() => current.controller.enable(args))
    .then(result => (runtime === current && lifecycleTicket === lifecycle
      ? result
      : { success: false, code: 'CANCELLED', status: bootstrapSnapshot() }))
    .catch(() => ({ success: false, code: 'tunnel_failed' }))
    .then(retainFailedStart);
  settled = operation.finally(() => {
    if (runtimeEnableOperations.get(current) === settled) runtimeEnableOperations.delete(current);
  });
  runtimeEnableOperations.set(current, settled);
  return settled;
}

async function revokeActiveRuntime(current, args, status) {
  if (!current) return { success: false, code: 'UNAVAILABLE', status: status() };
  // Block first so a concurrent Open pairing cannot create a fresh sheet while
  // revokeAll is flushing durable OAuth state.
  blockRuntimePairing(current);
  cancelRuntimePairing(current, { block: false });
  try {
    const result = await current.controller?.revokeAll?.(...args);
    cancelRuntimePairing(current, { block: false });
    return result || { success: false, code: 'persist_failed', status: status() };
  } catch { return { success: false, code: 'persist_failed', status: status() }; }
  finally {
    // Revoke is a short critical section, not a permanent pairing lock. A
    // still-attached runtime may immediately open a fresh, user-initiated
    // pairing sheet whether the durable revoke succeeded or failed.
    if (runtime === current) unblockRuntimePairing(current);
  }
}

async function clearBootstrapSetup() {
  try { await bootstrapContext?.deps?.tunnelSetup?.clearSession?.(); } catch { /* durable config is already the authority */ }
}

async function forgetActiveRuntime(current, status) {
  // Disable leaves config.json in place, so it deliberately keeps report
  // redaction. Forget is the distinct destructive action and must clear it
  // even when revocation or the durable wipe later reports a failure.
  // The optional failed-start receipt is bridge setup state too; leaving it in
  // memory after Forget would let a later FULL report disclose an old attempt
  // despite the user explicitly clearing this bridge's settings.
  clearFailedStartDiagnostic();
  setReportRedactedHosts([]);
  try {
    if (!current) {
      const deps = bootstrapContext?.deps || {};
      const userData = bootstrapContext?.userData;
      if (!userData) return { success: false, code: 'UNAVAILABLE', status: status() };
      let wiped = false;
      try { wiped = await (deps.forgetConfig || forgetConfig)(userData, { fsImpl: deps.fsImpl }); } catch { wiped = false; }
      if (wiped !== true) return { success: false, code: 'persist_failed', status: status() };
      bootstrapCleared = true;
      await clearBootstrapSetup();
      controllerBridge?.publishBootstrap?.();
      return { success: true, status: bootstrapSnapshot() };
    }
    // Remove all externally reachable runtime ports before revocation starts. If
    // revocation fails, we still force Disable so a failed Forget cannot leave a
    // live listener, pairing timer, process, or socket behind.
    detachRuntime(current);
    let result;
    try { result = await current.controller?.forget?.(); } catch { result = { success: false, code: 'persist_failed' }; }
    if (result?.success) {
      bootstrapCleared = true;
      await clearBootstrapSetup();
      await disposeDetachedRuntime(current, { controllerAlreadyDisabled: true });
      controllerBridge?.publishBootstrap?.();
      return { success: true, status: bootstrapSnapshot() };
    }
    await disposeDetachedRuntime(current);
    return { success: false, code: result?.code || 'persist_failed', status: bootstrapSnapshot() };
  } finally {
    // Detaching publishes a bootstrap snapshot synchronously; clear again so
    // that publication cannot re-install an old hostname during Forget.
    setReportRedactedHosts([]);
  }
}

async function invalidateRuntimeForMutation() {
  clearFailedStartDiagnostic();
  bootstrapCleared = false;
  const disposed = await disposeCurrentRuntime();
  const status = bootstrapSnapshot();
  controllerBridge?.publishBootstrap?.();
  return { success: disposed?.success !== false, status, ...(disposed?.code ? { code: disposed.code } : {}) };
}

export function getHandoffBridgeStatus() {
  // Once IPC is registered, the bridge owns the renderer-facing monotonic
  // sequence. Keep the direct runtime fallback only for callers that start a
  // graph before registration has created that public projection.
  try { return controllerBridge?.snapshot?.() || runtime?.controller?.snapshot?.() || bootstrapSnapshot(); }
  catch { return bootstrapSnapshot(); }
}

export function registerHandoffBridgeHandlers({ ipcMain = electronPkg.ipcMain, deps = {} } = {}) {
  if (registered && typeof ipcMain?.__getInvokeHandler === 'function' && !ipcMain.__getInvokeHandler('handoff-bridge:get-status')) registered = false;
  if (registered) return false;
  const app = appFor(deps);
  const bootstrapUserData = userDataFor(deps, app);
  const priorUserData = bootstrapContext?.userData;
  bootstrapContext = { deps, userData: bootstrapUserData, app, isPackaged: packagedFor(deps, app) };
  // A same-process IPC re-registration must not resurrect facts after a
  // successful Forget. A different user-data root is a fresh app context.
  if (priorUserData && priorUserData !== bootstrapUserData) {
    // A replacement IPC registry is a fresh application context, not a way
    // to keep the prior root's live graph reachable.  Stop its UI publisher
    // before detaching, then begin the existing hard-off disposer without
    // awaiting it: registration stays synchronous and never starts a port or
    // process for the new context.
    try { uiRegistration?.dispose?.(); } catch { /* prior UI registry is already gone */ }
    uiRegistration = null;
    const priorRuntime = runtime;
    if (priorRuntime) {
      detachRuntime(priorRuntime);
      detachingRuntime = priorRuntime;
      void disposeDetachedRuntime(priorRuntime).catch(noOp);
    }
    bootstrapCleared = false;
    // A receipt is optional telemetry for exactly one app-data root.  Never
    // carry even its closed fields into another profile/context that has not
    // opted in to diagnostics.
    clearFailedStartDiagnostic();
    setReportRedactedHosts([]);
  }
  controllerBridge ||= createControllerBridge();
  controllerBridge.invalidateBootstrap?.();
  const controller = controllerBridge;
  const getCanvasWindows = deps.getCanvasWindows || (() => []);
  // Enable is confirmed before a runtime exists, so this port must be real at
  // registration time. Construction is inert; the first sheet is still a
  // user IPC and always has a canvas parent.
  const bootstrapDialogs = deps.dialogs || createHandoffBridgeDialogs({ dialog: deps.dialog || electronPkg.dialog, getCanvasWindows, validateHostname: isValidHostname });
  const writeBootstrapConfig = async (patch, options = {}) => {
    if (!patch || typeof patch !== 'object') return { ok: false, code: 'INVALID' };
    const targetUserData = runtime?.userData || bootstrapUserData;
    if (!targetUserData) return { ok: false, code: 'NOT_READY' };
    // `writeConfig` evaluates this in its serialized mutation and again after
    // native hostname consent. Never carry a pre-queue authorization snapshot:
    // an OAuth code exchange may link this hostname while a config write waits.
    const isLinked = () => {
      try {
        const activeRuntime = runtime?.userData === targetUserData ? runtime : null;
        const links = activeRuntime?.oauth?.linkStatus?.();
        if (links !== undefined && (!Array.isArray(links) || links.some(link => link?.revoked !== true))) return true;
        const oauthStatePath = path.join(targetUserData, 'handoff-bridge', 'oauth-state.json');
        let rawState;
        try { rawState = (deps.fsImpl || fs).readFileSync(oauthStatePath, 'utf8'); }
        catch (error) { return error?.code === 'ENOENT' ? false : true; }
        if (typeof rawState !== 'string' || Buffer.byteLength(rawState, 'utf8') > 4 * 1024 * 1024) return true;
        let parsed;
        try { parsed = JSON.parse(rawState); } catch { return true; }
        if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.families)) return true;
        return parsed.families.some(family => family?.revoked !== true);
      } catch { return true; }
    };
    let persisted = null;
    try { persisted = syncReportRedactedHosts((deps.readConfig || readConfig)(targetUserData, { fsImpl: deps.fsImpl })); } catch { persisted = null; }
    const oldHostname = persisted?.config?.hostname ?? null;
    const changedHostname = Object.hasOwn(patch, 'hostname') && patch.hostname !== oldHostname;
    const safePatch = changedHostname ? { ...patch, consentVersion: 0 } : patch;
    let result;
    try {
      result = await Promise.resolve((deps.writeConfig || writeConfig)(targetUserData, safePatch, {
        ...options, isLinked, confirmHostnameChange: async () => true, fsImpl: deps.fsImpl,
      }));
    } catch { return { ok: false, code: 'STATE_UNREADABLE' }; }
    if (result?.ok === true) {
      bootstrapCleared = false;
      // An explicit telemetry opt-out must also remove an already retained
      // in-memory failed-start receipt before any later FULL report is built.
      if (Object.hasOwn(safePatch, 'telemetryInBugReports') && safePatch.telemetryInBugReports !== true) clearFailedStartDiagnostic();
      if (result.config) syncReportRedactedHosts({ config: result.config, state: 'ok' });
      else if (Object.hasOwn(safePatch, 'hostname')) syncReportRedactedHosts({ config: { hostname: safePatch.hostname }, state: 'ok' });
      // UI calls reloadConfig once after this adapter returns. Hostname is a
      // captured graph value, so detach first and let that one reload publish
      // the newly persisted bootstrap projection rather than reloading twice.
      if (changedHostname) {
        const invalidated = await invalidateRuntimeForMutation();
        if (invalidated?.success === false) return { ok: false, code: 'STATE_UNREADABLE' };
      }
    }
    return result;
  };
  const openPanel = value => {
    try {
      const target = (getCanvasWindows() || []).find(window => !window?.isDestroyed?.());
      if (!target?.webContents?.send) return false;
      const payload = { panel: 'bridge' };
      if (Number.isInteger(value?.step) && value.step >= 1 && value.step <= 4) payload.step = value.step;
      target.webContents.send(IPC_EVENTS.OPEN_PANEL, payload);
      return true;
    } catch { return false; }
  };
  uiRegistration?.dispose?.();
  uiRegistration = null;
  let nextRegistration = null;
  try {
    nextRegistration = registerHandoffBridgeUi({ ipc: ipcMain, controller,
      store: { writeConfig: writeBootstrapConfig }, getCanvasWindows,
      dialogs: bootstrapDialogs, clipboard: deps.clipboard || electronPkg.clipboard,
      application: deps.application || runtimePort('application', ['describeForConfirm']),
      tunnel: tunnelUiPort(setupPortFromDeps(deps)),
      oauth: deps.oauth || Object.freeze({ openPairing: (...args) => openRuntimePairing(...args), cancelPairing: (...args) => runtime?.pairing?.cancel?.(...args) || Promise.resolve({ ok: false, code: 'NOT_READY' }) }),
      engine: deps.engine || runtimePort('engine', ['hold', 'resume', 'hint']),
      push: deps.push || Object.freeze({
        release: keys => controller.releasePushHubs?.(keys),
        unrelease: key => controller.unreleasePushHub?.(key),
      }),
      enableConsent: enableConsentPort({ userData: bootstrapUserData, deps }),
      validateHostname: isValidHostname,
      now: deps.now,
      timers: deps.timers,
      onOpenPanel: openPanel,
      onSetupMutation: async () => invalidateRuntimeForMutation(),
    });
  } catch {
    registered = false;
    return false;
  }
  if (nextRegistration?.registration?.ok !== true) {
    try { nextRegistration?.dispose?.(); } catch { /* failed registration is already inert */ }
    registered = false;
    return false;
  }
  uiRegistration = nextRegistration;
  registered = true;
  return true;
}

export function startHandoffBridge({ reason = 'manual', deps = {} } = {}) {
  if (deps.activate === true) clearFailedStartDiagnostic();
  const existing = runtime;
  if (existing?.controller) {
    if (deps.activate === true) return enableAttachedRuntime(existing, startEnableArgs(reason, deps));
    return Promise.resolve({ success: true, status: getHandoffBridgeStatus(), reason, testMode: existing.testMode === true });
  }
  if (startPromise) return startPromise;
  const env = deps.env || process.env;
  if (env.INFINITE_CANVAS_HANDOFF_BRIDGE === '0') return Promise.resolve(refusalResult('env_disabled', reason));
  const app = appFor(deps); const isPackaged = packagedFor(deps, app);
  // Ordinary refused launches must not even ask Electron for a path. The test
  // predicate is the sole exception because it is defined by the persisted
  // setup paths themselves.
  const wantsTestMode = env.INFINITE_CANVAS_HANDOFF_BRIDGE_TEST === '1';
  const preflight = environmentRefusal(env, isPackaged, false);
  if (!wantsTestMode && preflight) return Promise.resolve(refusalResult(preflight, reason));
  if (deps.enabled !== true) return Promise.resolve(refusalResult('not_enabled', reason));
  const userData = userDataFor(deps, app);
  const prior = bootstrapContext;
  const inherited = prior?.userData === userData ? prior?.deps : {};
  if (prior?.userData && prior.userData !== userData) {
    // This path can change roots without IPC re-registration (for example a
    // controlled in-process test or host switch).  Keep the receipt scoped to
    // its originating root just like hostname report redaction.
    clearFailedStartDiagnostic();
    setReportRedactedHosts([]);
  }
  const composedDeps = mergeDefinedDeps(inherited, deps);
  bootstrapContext = { deps: composedDeps, userData, app, isPackaged };
  bootstrapCleared = false;
  let setup = stateFromDeps(composedDeps);
  // The persisted setup determines whether the deliberately narrow test-mode
  // predicate can succeed. Read it before resolving mode, never after.
  if (!isTunnelState(setup) && userData) {
    try { setup = (typeof composedDeps.readTunnelState === 'function' ? composedDeps.readTunnelState(userData, { fsImpl: composedDeps.fsImpl }) : null) || {}; } catch { setup = {}; }
  }
  const testMode = resolveTestMode({ env, isPackaged, paths: { binaryPath: setup.binaryPath, credentialsPath: setup.credentialsPath, userData }, tmpdir: composedDeps.tmpdir || os.tmpdir(), realpath: composedDeps.realpath || fs.realpathSync.native });
  const environment = environmentRefusal(env, isPackaged, testMode);
  if (environment) return Promise.resolve(refusalResult(environment, reason));
  // tunnel.json records an explicit pin/approval on the app-owned copy. The
  // supervisor re-hashes that copy again before spawn; this bit merely lets
  // the refusal ladder distinguish unapproved setup from no binary.
  if (setup.binaryTrusted !== true) setup = { ...setup, binaryTrusted: Boolean(setup.binaryPath && setup.pin && setup.approvedAt) };
  const lifecycleTicket = lifecycle;
  const operation = (async () => {
    let loaded;
    try { loaded = syncReportRedactedHosts(composedDeps.loadedConfig || (composedDeps.readConfig || readConfig)(userData, { fsImpl: composedDeps.fsImpl })); } catch { return refusalResult('state_unreadable', reason); }
    if (!loaded || loaded.state === 'unreadable') return refusalResult('state_unreadable', reason);
    const refusal = refusalForStart({ env, isPackaged, paths: { binaryPath: setup.binaryPath, credentialsPath: setup.credentialsPath, userData }, tmpdir: composedDeps.tmpdir || os.tmpdir(), enabled: true, config: loaded.config, setup: { binaryPath: setup.binaryPath, binaryTrusted: setup.binaryTrusted, credentialsPath: setup.credentialsPath, configValid: loaded.state === 'ok' || loaded.state === 'missing', socketUnavailable: setup.socketUnavailable, tunnelFailed: setup.tunnelFailed } });
    if (refusal) return refusalResult(refusal, reason);
    if (lifecycleTicket !== lifecycle) return refusalResult('not_enabled', reason);
    let candidate;
    try { candidate = (composedDeps.compose || composeHandoffBridge)({ userData, config: loaded.config, tunnelState: setup, testMode, deps: composedDeps }); }
    catch (error) { return refusalResult(error?.code === 'path_too_long' ? 'socket_unavailable' : 'tunnel_failed', reason); }
    if (lifecycleTicket !== lifecycle || runtime) {
      await disposeDetachedRuntime(candidate);
      return refusalResult('not_enabled', reason);
    }
    runtime = candidate;
    controllerBridge?.attach?.(candidate.controller);
    if (testMode) installPairingTestHook(candidate);
    if (deps.activate === true) {
      let result;
      try { result = await enableAttachedRuntime(candidate, startEnableArgs(reason, deps)); }
      catch { result = { success: false, code: 'tunnel_failed' }; }
      if (lifecycleTicket !== lifecycle || runtime !== candidate) {
        if (runtime === candidate) detachRuntime(candidate, { advanceLifecycle: false });
        await disposeDetachedRuntime(candidate);
        return refusalResult('not_enabled', reason);
      }
      if (!result?.success) {
        detachRuntime(candidate);
        await disposeDetachedRuntime(candidate);
      }
      return result;
    }
    return { success: true, status: getHandoffBridgeStatus(), reason, testMode };
  })();
  let pending;
  pending = operation.finally(() => { if (startPromise === pending) startPromise = null; });
  startPromise = pending;
  return pending;
}

export function scheduleHandoffBridgeLaunch({ userData = '', setTimeoutImpl = setTimeout, stat = fs.promises.stat, readConfig: loadConfig = readConfig, reapOrphans = async () => undefined, start = startHandoffBridge, delayMs = 3_000 } = {}) {
  return setTimeoutImpl(async () => {
    const pidfile = path.join(userData, 'handoff-bridge', 'tunnel', 'tunnel.pid.json'); let exists = false;
    try { await stat(pidfile); exists = true; } catch { /* no pidfile means no process inspection */ }
    let loaded; try { loaded = syncReportRedactedHosts(loadConfig(userData)); } catch { return; }
    if (exists) try { await reapOrphans({ reason: 'launch', pidfile }); } catch { return; }
  if (loaded?.config?.autoStart) {
    // Keep the loaded value both as the launch contract and in the default
    // starter's dependency bag.  Main consumes the former; startHandoffBridge
    // consumes the latter, so neither path re-reads the config file.
    try { void Promise.resolve(start({ reason: 'auto-start', loadedConfig: loaded, deps: { loadedConfig: loaded, enabled: true, activate: true } })).catch(noOp); } catch { /* fire-and-forget */ }
  }
  }, delayMs);
}

export async function stopHandoffBridge() {
  return disposeCurrentRuntime({ graceful: true });
}
export async function holdHandoffBridgeForQuit() {
  if (runtime?.controller?.holdForQuit) return runtime.controller.holdForQuit();
  return { success: true, status: getHandoffBridgeStatus() };
}
export async function resumeHandoffBridgeAfterQuitCancel() {
  if (runtime?.controller?.resumeAfterQuitCancel) return runtime.controller.resumeAfterQuitCancel();
  return { success: true, status: getHandoffBridgeStatus() };
}
