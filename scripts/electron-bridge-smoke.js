#!/usr/bin/env node

// An out-of-band Electron smoke: TEST mode only, a Unix socket only, and a
// fake tunnel process only. It must never resolve or contact a public host.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import {
  APPLICATION_QUALITY_CHECKLIST_VERSION,
  APPLICATION_QUALITY_CRITERIA,
  LOCAL_AI_GENERATION_AUDIT_VERSION,
} from '../electron/ipc/localAiApplication.js';
import { BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS } from '../electron/utils/backgroundE2e.js';
import { readConfig } from '../electron/ipc/handoffBridge/store.js';
import { readTunnelState } from '../electron/ipc/handoffBridge/tunnel/files.js';

const SOCKET_RELATIVE_PATH = path.join('handoff-bridge', 'b.sock');
const TUNNEL_ID = '01234567-89ab-cdef-0123-456789abcdef';
const HOSTNAME = 'bridge.test.example.com';
const BRIDGE_KEYS = [
  'handoffBridgeGetStatus', 'handoffBridgeSetEnabled', 'handoffBridgeSaveConfig', 'handoffBridgeChooseBinary',
  'handoffBridgeApproveBinary', 'handoffBridgeChooseCredentials', 'handoffBridgeRestartTunnel', 'handoffBridgeStopOrphan',
  'handoffBridgeGetTunnelLog', 'handoffBridgeOpenPairing', 'handoffBridgeCancelPairing', 'handoffBridgeNewChat',
  'handoffBridgeContinueChat', 'handoffBridgePause', 'handoffBridgeResume', 'handoffBridgeRevokeAll',
  'handoffBridgeForgetSetup', 'handoffBridgeRelease', 'handoffBridgeUnrelease', 'handoffBridgeReleasePush',
  'handoffBridgeUnreleasePush', 'handoffBridgeHoldJob', 'handoffBridgeAckAlarm', 'handoffBridgeGetActivity',
  'handoffBridgePublishJobs', 'onHandoffBridgeStatus', 'onHandoffBridgeJobChanged', 'onHandoffBridgeOpenPanel',
].sort();

// Electron canonicalises macOS /var through /private. Seed and launch from
// that same real path so the socket length assertion covers what main uses.
const userDataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ic-b-')));
const socketPath = path.join(userDataDir, SOCKET_RELATIVE_PATH);
const tunnelRoot = path.join(userDataDir, 'handoff-bridge', 'tunnel');
const credentialsPath = path.join(userDataDir, 'credentials', `${TUNNEL_ID}.json`);
const fakeSourceRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ic-b-fake-')));
const fakeProgramPath = path.join(fakeSourceRoot, 'fake-cloudflared.js');
const fakeLauncherPath = path.join(fakeSourceRoot, 'fake-cloudflared');
const rendererErrors = [];
let app;
let copiedBinaryPath = null;
let binaryPin = null;
const tunnelSecretField = ['Tunnel', 'Secret'].join('');
const CLIENT_ID = 'https://chatgpt.com/oauth/client.json';
const REDIRECT_URI = 'https://chatgpt.com/connector_platform_oauth_redirect';
const SYNTHETIC_IDENTITY = Object.freeze({
  name: 'Ada Lovelace', contact: Object.freeze(['ada@example.com']), subtitleRole: 'Engineer', credential: '',
});
const SYNTHETIC_EVIDENCE = 'Maintained reliable internal systems for users.';
const SYNTHETIC_LETTER_SENTENCES = Object.freeze([
  'My experience delivering supported systems is a relevant capability.',
  'In my engineering role at Example Co, I updated supported systems for internal users.',
  'I would apply my experience delivering supported systems to reliable system delivery this role requires.',
]);
const SYNTHETIC_LETTER = SYNTHETIC_LETTER_SENTENCES.join(' ');
const SYNTHETIC_THESIS = 'Reliable system delivery is the supported capability this engineering role needs.';
const SYNTHETIC_CAREER_DATA = [
  SYNTHETIC_IDENTITY.name, SYNTHETIC_IDENTITY.contact[0], SYNTHETIC_IDENTITY.subtitleRole,
  SYNTHETIC_EVIDENCE, SYNTHETIC_LETTER,
].join('\n');
const SYNTHETIC_JOB = Object.freeze({
  title: 'Engineer', company: 'Example Co', snippet: 'Engineer role focused on reliable system delivery.',
});
// The mounted bridge panel can publish its initial empty candidate list first.
// Reserve a high local sequence range so this explicit smoke fixture cannot be
// discarded as an older renderer publication.
const SMOKE_PUBLISH_SEQUENCE_BASE = 1_000;

async function exists(target) {
  try { await fs.lstat(target); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

async function waitFor(predicate, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) assert.fail(label);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

function socketRequest(requestPath, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, path: requestPath, method, headers: { host: HOSTNAME, accept: 'application/json', ...headers } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.setTimeout(3_000, () => request.destroy(new Error('Unix socket request timed out')));
    request.once('error', reject);
    request.end(body || undefined);
  });
}

function formRequest(requestPath, fields, headers = {}) {
  const body = new URLSearchParams(fields).toString();
  return socketRequest(requestPath, 'POST', body, {
    'content-type': 'application/x-www-form-urlencoded',
    'content-length': Buffer.byteLength(body),
    ...headers,
  });
}

async function linkOAuth(pairingCode) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const state = crypto.randomBytes(18).toString('base64url');
  const query = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI,
    state, code_challenge: challenge, code_challenge_method: 'S256',
    resource: `https://${HOSTNAME}/mcp`, scope: 'handoff',
  });
  const page = await socketRequest(`/oauth/authorize?${query}`);
  assert.equal(page.statusCode, 200, `OAuth authorize must be offline-capable: ${page.body.slice(0, 200)}`);
  const txn = /name="txn" value="([^"]+)"/.exec(page.body)?.[1];
  assert.ok(txn, 'OAuth consent page must contain its one-time transaction id');
  const approved = await formRequest('/oauth/authorize', { txn, pairing_code: pairingCode, action: 'approve' });
  assert.equal(approved.statusCode, 302, 'pairing approval must redirect to the fixed ChatGPT callback');
  const callback = new URL(approved.headers.location);
  assert.equal(callback.origin + callback.pathname, REDIRECT_URI);
  assert.equal(callback.searchParams.get('state'), state);
  const code = callback.searchParams.get('code');
  assert.ok(code, 'OAuth callback must carry an authorization code');
  const token = await formRequest('/oauth/token', {
    grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
    code_verifier: verifier, client_id: CLIENT_ID, resource: `https://${HOSTNAME}/mcp`,
  });
  assert.equal(token.statusCode, 200, `OAuth code exchange failed: ${token.body.slice(0, 200)}`);
  const tokens = JSON.parse(token.body);
  assert.equal(tokens.token_type, 'Bearer');
  assert.equal(typeof tokens.access_token, 'string');
  return tokens.access_token;
}

function syntheticQualityCriteria() {
  return APPLICATION_QUALITY_CRITERIA.map(({ id, requirement }) => ({ id, status: 'pass', evidence: requirement }));
}

function syntheticQualityChecklist() {
  return APPLICATION_QUALITY_CRITERIA.map(({ id }) => ({ id, status: 'pass', detail: `Reviewed ${id} against the final documents.` }));
}

function syntheticGenerationAudit() {
  return {
    version: LOCAL_AI_GENERATION_AUDIT_VERSION,
    jobPriorities: [{
      requirement: 'Reliable system delivery', priority: 'highest', disposition: 'addressed-both',
      justification: 'The selected systems evidence directly addresses the stated delivery requirement.',
    }],
    resumePlan: {
      strategy: 'Lead with the strongest supported systems evidence for the role.',
      selectionRationale: 'The retained role preserves direct factual support and concise relevance.',
    },
    coverLetterPlan: {
      controllingThesis: SYNTHETIC_THESIS,
      paragraphs: [{
        paragraph: SYNTHETIC_LETTER,
        argumentativeJob: 'Establish the controlling evidence-to-need connection.',
        relationToThesis: 'Connect the source-supported proof to reliable system delivery.',
        relationToPreviousParagraph: 'opening',
        sentences: SYNTHETIC_LETTER_SENTENCES.map((sentence, index) => ({
          sentence,
          function: index === 0
            ? 'States the general candidate capability.'
            : (index === 1 ? 'Supplies the source-supported candidate proof.' : 'Connects the proof to the target responsibility.'),
          relationToPreviousSentence: index === 0 ? 'opening' : 'Develops the preceding argument step.',
        })),
        argumentMapping: {
          claim: SYNTHETIC_LETTER_SENTENCES[0], proof: SYNTHETIC_LETTER_SENTENCES[1], relevance: SYNTHETIC_LETTER_SENTENCES[2],
          jobNeedQuote: 'reliable system delivery',
        },
      }],
    },
    finalDecisionSummary: 'The final documents use the strongest supported evidence without introducing a second cover-letter argument.',
  };
}

function syntheticApplicationFields(stage) {
  switch (stage) {
    case 'evidence-plan':
      return {
        identity: SYNTHETIC_IDENTITY,
        evidence: [
          { id: 'resume-proof', sourceId: 'career-data', quote: SYNTHETIC_EVIDENCE, requirement: 'Reliable system delivery', priority: 'highest' },
          { id: 'letter-proof', sourceId: 'career-data', quote: SYNTHETIC_LETTER, requirement: 'Reliable system delivery', priority: 'highest' },
          { id: 'job-proof', sourceId: 'job-listing', quote: 'reliable system delivery', requirement: 'Reliable system delivery', priority: 'highest' },
        ],
        requirements: [{ id: 'need-1', text: 'Reliable system delivery', priority: 'highest', evidenceIds: ['resume-proof', 'job-proof'] }],
      };
    case 'resume':
      return {
        resume: {
          schemaVersion: 'structured-resume.v1', identity: SYNTHETIC_IDENTITY,
          roles: [{
            id: 'role-1', title: 'Engineer', company: 'Example Co', dates: '', location: '',
            bullets: [{ id: 'bullet-1', text: SYNTHETIC_EVIDENCE, evidenceIds: ['resume-proof'] }],
          }],
        },
      };
    case 'cover-letter':
      return {
        coverLetter: {
          name: SYNTHETIC_IDENTITY.name, contact: SYNTHETIC_IDENTITY.contact,
          paragraphs: [{ id: 'paragraph-1', text: SYNTHETIC_LETTER, evidenceIds: ['letter-proof', 'job-proof'] }],
          roleThesis: SYNTHETIC_THESIS,
          coverLetterArgument: {
            primaryEvidence: {
              evidence: SYNTHETIC_EVIDENCE, evidenceRole: 'Engineer at Example Co',
              relationToThesis: 'The systems work establishes the delivery capability named in the thesis.',
            },
          },
        },
      };
    case 'review':
      return {
        decision: 'pass', findings: [], checklist: syntheticQualityChecklist(),
        qualityReview: {
          checklistVersion: APPLICATION_QUALITY_CHECKLIST_VERSION,
          criteria: syntheticQualityCriteria(),
          resume: { decision: 'approved', rationale: 'The résumé preserves direct source-supported systems evidence with clear relevance.' },
          coverLetter: { decision: 'approved', rationale: 'One controlling argument uses minimum-sufficient evidence for target system delivery.' },
        },
        generationAudit: syntheticGenerationAudit(),
      };
    default:
      throw new Error(`Unexpected synthetic application handoff stage: ${String(stage)}`);
  }
}

function sharedFieldsFromPrompt(prompt) {
  const source = typeof prompt === 'string' ? prompt : '';
  const marker = 'Shared fields (copy exactly):\n';
  const markerAt = source.indexOf(marker);
  assert.notEqual(markerAt, -1, 'served application prompt must contain the authoritative shared-fields block');
  const start = markerAt + marker.length;
  const end = source.indexOf('\n\n', start);
  assert.notEqual(end, -1, 'served application prompt must terminate the shared-fields JSON before its schema');
  const shared = JSON.parse(source.slice(start, end));
  assert.equal(shared?.protocol, 1, 'served application prompt must carry protocol v1 shared fields');
  assert.equal(typeof shared?.handoffCode, 'string', 'served application prompt must carry its current handoff code');
  return shared;
}

function syntheticResponseForServedHandoff(handoff) {
  assert.equal(handoff?.status, 'served', 'a synthetic application response requires a served MCP handoff');
  const shared = sharedFieldsFromPrompt(handoff.prompt);
  assert.equal(shared.stage, handoff.stage, 'served stage must equal the stage in its authoritative prompt');
  assert.equal(shared.handoffCode, handoff.handoffCode, 'served code must equal the code in its authoritative prompt');
  return JSON.stringify({ ...shared, ...syntheticApplicationFields(shared.stage) });
}

function mcpToolBody(response, label) {
  assert.equal(response.statusCode, 200, `${label}: MCP tool route must return HTTP 200`);
  let envelope;
  try { envelope = JSON.parse(response.body); } catch { assert.fail(`${label}: MCP tool route must return JSON-RPC JSON`); }
  const text = envelope?.result?.content?.[0]?.text;
  assert.equal(typeof text, 'string', `${label}: MCP tool result must carry one text response`);
  try { return JSON.parse(text); } catch { assert.fail(`${label}: MCP tool text must contain JSON`); }
}

async function mcpToolCall(accessToken, id, name, args, label) {
  const response = await socketRequest('/mcp', 'POST', JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args },
  }), {
    'content-type': 'application/json', authorization: `Bearer ${accessToken}`,
  });
  return mcpToolBody(response, label);
}

async function queueSyntheticApplication(page, canvasFilePath, label) {
  const queued = await page.evaluate(async ({ filePath, job, careerData }) => window.electronAPI.queueLocalApplication({
    canvasFilePath: filePath, transport: 'paste', job, careerData,
    additionalNotes: 'Synthetic smoke fixture only.',
    resumeProfile: { workHistory: [{ id: 'role-1', title: 'Engineer', employer: 'Example Co', startDate: '', endDate: '' }] },
  }), { filePath: canvasFilePath, job: SYNTHETIC_JOB, careerData: SYNTHETIC_CAREER_DATA });
  assert.equal(queued.success, true, `${label}: synthetic application must queue through the frozen app IPC: ${JSON.stringify(queued)}`);
  assert.match(queued.localJob?.id || '', /^[0-9a-f-]{36}$/i, `${label}: queueLocalApplication must return its durable localJob id`);
  return queued;
}

async function publishApplicationJobs(page, seq, jobs, label) {
  const published = await page.evaluate(({ nextSeq, nextJobs }) => window.electronAPI.handoffBridgePublishJobs({
    v: 1, seq: nextSeq, jobs: nextJobs,
  }), { nextSeq: seq, nextJobs: jobs });
  assert.equal(published, undefined, `${label}: renderer candidate publication must remain fire-and-forget advisory IPC`);
}

async function releaseApplicationJob(page, jobId, label) {
  const release = await page.evaluate(id => window.electronAPI.handoffBridgeRelease({ items: [{ jobId: id }] }), jobId);
  assert.equal(release.success, true, `${label}: release must derive the job and canvas from main-owned state: ${JSON.stringify(release)}`);
}

async function fakeProcessGone() {
  const fakePidPath = path.join(tunnelRoot, 'fake.pid');
  if (!(await exists(fakePidPath))) return true;
  const pid = Number.parseInt(await fs.readFile(fakePidPath, 'utf8'), 10);
  if (!Number.isInteger(pid) || pid <= 1) return true;
  try { process.kill(pid, 0); return false; } catch (error) { return error?.code === 'ESRCH'; }
}

async function fakeProcessPid() {
  const fakePidPath = path.join(tunnelRoot, 'fake.pid');
  assert.equal(await exists(fakePidPath), true, 'the fake connector must record its pid after a real spawn');
  const pid = Number.parseInt(await fs.readFile(fakePidPath, 'utf8'), 10);
  assert(Number.isInteger(pid) && pid > 1, 'the fake connector pid must be a live positive process id');
  return pid;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code !== 'ESRCH'; }
}

// Playwright's ElectronApplication state is not an OS reaper. Chromium
// helpers can survive after its root process has been reparented, so scope all
// cleanup to the random user-data root allocated by this smoke. Never use a
// broad executable-name match or pkill.
function userDataMarkers(directory) {
  const resolved = path.resolve(directory);
  const markers = new Set([resolved]);
  if (process.platform === 'darwin') {
    if (resolved.startsWith('/var/')) markers.add(`/private${resolved}`);
    if (resolved.startsWith('/private/var/')) markers.add(resolved.slice('/private'.length));
  }
  return markers;
}

function smokeProcessRows() {
  const stdout = execFileSync('/bin/ps', ['-axww', '-o', 'pid=,pgid=,command='], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000, maxBuffer: 2 * 1024 * 1024,
  });
  return String(stdout).split('\n').flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
    return match ? [{ pid: Number(match[1]), pgid: Number(match[2]), command: match[3] }] : [];
  });
}

function hasSmokeUserDataMarker(command, markers) {
  return [...markers].some((marker) => {
    const needle = `--user-data-dir=${marker}`;
    let offset = command.indexOf(needle);
    while (offset !== -1) {
      const next = command[offset + needle.length];
      // The random root must terminate the argv value; a sibling such as
      // <random-root>-other is not smoke-owned.
      if (next === undefined || /\s/.test(next)) return true;
      offset = command.indexOf(needle, offset + needle.length);
    }
    return false;
  });
}

function smokeElectronProcesses(directory) {
  const markers = userDataMarkers(directory);
  return smokeProcessRows().filter(row => hasSmokeUserDataMarker(row.command, markers));
}

async function waitForSmokeElectronExit(directory, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (smokeElectronProcesses(directory).length === 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function killSmokeElectronProcesses(directory) {
  const markers = userDataMarkers(directory);
  const rows = smokeProcessRows();
  const owned = rows.filter(row => hasSmokeUserDataMarker(row.command, markers));
  const killedGroups = new Set();
  for (const row of owned) {
    // Refresh both the PID and its current process group immediately before
    // any signal. This excludes a reused PID and a group that gained a
    // non-smoke member after the first ps snapshot.
    const currentRows = smokeProcessRows();
    const current = currentRows.find(candidate => candidate.pid === row.pid
      && hasSmokeUserDataMarker(candidate.command, markers));
    if (!current || killedGroups.has(current.pgid)) continue;
    const group = currentRows.filter(candidate => candidate.pgid === current.pgid);
    // Only signal a whole process group after each member has independently
    // been tied to this unique smoke root. Otherwise target the exact process
    // after a second lookup so a reused PID cannot be killed from stale data.
    if (process.platform !== 'win32' && current.pgid > 1 && group.length > 0
      && group.every(candidate => hasSmokeUserDataMarker(candidate.command, markers))) {
      try { process.kill(-current.pgid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
      killedGroups.add(current.pgid);
      continue;
    }
    try { process.kill(current.pid, 'SIGKILL'); } catch (error) { if (error?.code !== 'ESRCH') throw error; }
  }
}

function processCommand(pid) {
  try {
    return String(execFileSync('/bin/ps', ['-p', String(pid), '-ww', '-o', 'command='], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3_000,
    })).trim();
  } catch {
    return '';
  }
}

async function readTunnelIntent() {
  const pidfile = path.join(tunnelRoot, 'tunnel.pid.json');
  const value = JSON.parse(await fs.readFile(pidfile, 'utf8'));
  assert(Number.isInteger(value?.pid) && value.pid > 1, 'the real watchdog pidfile must name its shell process');
  assert(Number.isInteger(value?.pgid) && value.pgid > 1, 'the real watchdog pidfile must name its process group');
  assert.equal(value.configPath, path.join(tunnelRoot, 'config.yml'), 'the pidfile must bind reaping to this smoke config');
  return value;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function assertCopiedBinary() {
  assert.ok(copiedBinaryPath && binaryPin, 'seeded tunnel state must define its expected copy and pin');
  const stat = await fs.stat(copiedBinaryPath);
  assert.equal(stat.mode & 0o777, 0o500, 'the supervisor must execute only a mode-0500 app-owned copy');
  const copiedPin = crypto.createHash('sha256').update(await fs.readFile(copiedBinaryPath)).digest('hex');
  assert.equal(copiedPin, binaryPin, 'the app-owned fake copy must retain the pre-seeded SHA-256 pin');
  const state = readTunnelState(userDataDir);
  assert.equal(state?.binaryPath, fakeLauncherPath, 'setup must retain the mutable source path while execution uses the copy');
  assert.equal(state?.pin, binaryPin, 'tunnel state must retain the pre-seeded copy pin');
}

function hasOwnedTunnelMarker(command) {
  const marker = `${copiedBinaryPath} tunnel --config ${path.join(tunnelRoot, 'config.yml')} --no-autoupdate `;
  return typeof command === 'string' && command.includes(marker);
}

async function assertOwnedFakeCommand(pid) {
  const command = processCommand(pid);
  assert.ok(hasOwnedTunnelMarker(command), 'the fake launch must preserve the copied-binary/config marker required by the real orphan reaper');
}

async function waitForFakeAlive(label) {
  let pid = null;
  await waitFor(async () => {
    try {
      pid = await fakeProcessPid();
      return pidAlive(pid);
    } catch {
      return false;
    }
  }, label);
  return pid;
}

async function seedTestState() {
  assert(Buffer.byteLength(socketPath) <= 100, `TEST socket path exceeds Unix limit: ${socketPath}`);
  await fs.mkdir(path.dirname(credentialsPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(tunnelRoot, 'bin'), { recursive: true, mode: 0o700 });
  await fs.writeFile(credentialsPath, JSON.stringify({
    TunnelID: TUNNEL_ID,
    [tunnelSecretField]: 'synthetic-test-secret-for-marisol-ada-555-0101-only',
  }), { mode: 0o600 });
  await fs.chmod(credentialsPath, 0o600);

  // The fake SOURCE stays outside tunnel/bin. The supervisor must make and
  // execute an immutable 0500 copy under tunnel/bin, just as it would for a
  // selected Homebrew binary. The launcher preserves its copied $0 before
  // `tunnel --config`, which is the real orphan-reaper ownership marker.
  await fs.chmod(fakeSourceRoot, 0o755);
  assert.equal(fakeLauncherPath.startsWith(`${path.join(tunnelRoot, 'bin')}${path.sep}`), false,
    'the fake source must not already be an app-owned tunnel copy');
  const fakeProgram = `const fs = require('node:fs');
const path = require('node:path');
const mode = process.argv[2];
const invokedAs = process.argv[3];
const args = process.argv.slice(4);
const configIndex = args.indexOf('--config');
const config = configIndex >= 0 ? args[configIndex + 1] : '';
const target = args[args.length - 1] || '';
if (args.includes('ingress') && args.includes('validate')) {
  process.stdout.write('Validating rules from ' + config + '\\nOK');
  process.exit(0);
}
if (args.includes('ingress') && args.includes('rule') && target === ${JSON.stringify(`https://${HOSTNAME}/mcp`)}) {
  process.stdout.write('Using rules from ' + config + '\\nMatched rule #0\\n\\thostname: ' + ${JSON.stringify(HOSTNAME)} + '\\n\\tservice: unix:' + ${JSON.stringify(socketPath)} + '\\n');
  process.exit(0);
}
if (args.includes('ingress') && args.includes('rule') && target === 'https://not-the-bridge.invalid/') {
  process.stdout.write('Using rules from ' + config + '\\nMatched rule #1\\n\\tservice: http_status:404\\n');
  process.exit(0);
}
if (!path.isAbsolute(invokedAs)) process.exit(64);
try {
  fs.writeFileSync(path.join(path.dirname(path.dirname(invokedAs)), 'fake.pid'), String(process.pid) + '\\n', { mode: 0o600 });
} catch {
  process.exit(65);
}
if (mode === 'ignore-sigterm') {
  process.on('SIGTERM', () => {});
  process.on('SIGINT', () => {});
}
setInterval(() => undefined, 1_000);
`;
  await fs.writeFile(fakeProgramPath, fakeProgram, { mode: 0o600 });
  await fs.chmod(fakeProgramPath, 0o600);
  const launcher = `#!/bin/sh
exec ${shellQuote(process.execPath)} ${shellQuote(fakeProgramPath)} ignore-sigterm "$0" "$@"
`;
  await fs.writeFile(fakeLauncherPath, launcher, { mode: 0o700 });
  await fs.chmod(fakeLauncherPath, 0o700);
  binaryPin = crypto.createHash('sha256').update(await fs.readFile(fakeLauncherPath)).digest('hex');
  copiedBinaryPath = path.join(tunnelRoot, 'bin', `cloudflared-${binaryPin.slice(0, 8)}`);
  assert.equal(await exists(copiedBinaryPath), false, 'the pinned copy must not exist before explicit bridge enablement');
  await fs.writeFile(path.join(tunnelRoot, 'tunnel.json'), JSON.stringify({
    v: 1, binaryPath: fakeLauncherPath, credentialsPath, pin: binaryPin, approvedAt: Date.now(),
  }), { mode: 0o600 });
  await fs.chmod(path.join(tunnelRoot, 'tunnel.json'), 0o600);
  await fs.writeFile(path.join(userDataDir, 'handoff-bridge', 'config.json'), JSON.stringify({
    v: 1, hostname: HOSTNAME, pluginName: 'Synthetic bridge', scope: { applications: true, scoring: false },
    autoStart: false, autoRelease: false,
    limits: { releaseTtlHours: 0, chatKeyMaxAgeHours: 0, idlePauseMinutes: 0, jobsPerChat: 2, epochSoftBytes: 500000, epochHardBytes: 900000 },
    prefs: { sourcePolicy: 'off', pairingNetworkCheck: false }, telemetryInBugReports: false, consentVersion: 0,
  }), { mode: 0o600 });
  // This fixture is intentionally enough for offline CIMD lookup.  The
  // runtime must use it instead of reaching ChatGPT from this smoke.
  await fs.writeFile(path.join(userDataDir, 'handoff-bridge', 'oauth-state.json'), JSON.stringify({
    v: 1, issuer: `https://${HOSTNAME}`,
    clients: [{ id: CLIENT_ID, clientKind: 'cimd', clientHost: 'chatgpt.com', name: 'ChatGPT',
      redirectUris: [REDIRECT_URI], grantTypes: ['authorization_code', 'refresh_token'], authMethods: ['none'], jwksUri: null,
      metadataHash: 'smoke-fixture' }], codes: [], families: [], refresh: [], access: [],
  }), { mode: 0o600 });
}

await seedTestState();
assert.equal(readConfig(userDataDir).state, 'ok', 'synthetic bridge config must pass the production parser');
assert.ok(readTunnelState(userDataDir), 'synthetic tunnel state must pass the production parser');
const env = { ...process.env, INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_E2E_BACKGROUND: '1', INFINITE_CANVAS_HANDOFF_BRIDGE_TEST: '1' };
delete env.ELECTRON_RUN_AS_NODE;

async function assertBackgroundWindow(application) {
  const windows = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map(window => ({
    visible: window.isVisible(), focusable: window.isFocusable(), focused: window.isFocused(),
  })));
  assert.equal(windows.length, 1, 'bridge smoke must keep exactly one canvas window');
  assert.deepEqual(windows[0], { visible: false, focusable: false, focused: false },
    'TEST-mode bridge smoke must not show or focus an Electron window');
}

async function closeElectron(app, { restoreHttps = false } = {}) {
  if (app && restoreHttps) {
    try { await app.evaluate(() => globalThis.__icBridgeSmokeRestoreHttps?.()); } catch { /* a crash may already have ended main */ }
  }
  if (app) {
    let timeout;
    try {
      // This remains the primary, lifecycle-aware shutdown path.
      await Promise.race([
        app.close(),
        new Promise(resolve => { timeout = setTimeout(resolve, BACKGROUND_E2E_SHUTDOWN_TIMEOUT_MS + 5_000); }),
      ]);
    } catch { /* retain the OS-verified SIGKILL-only fallback below */ }
    finally { if (timeout) clearTimeout(timeout); }
  }
  // Do not trust Playwright's process handle: after a successful close it can
  // say "exited" while reparented Chromium helpers are still alive. Give
  // Electron a bounded grace, then SIGKILL only the process(es)/groups proved
  // to use this smoke's random user-data root, and wait for OS disappearance.
  if (!await waitForSmokeElectronExit(userDataDir, 3_000)) {
    await killSmokeElectronProcesses(userDataDir);
    assert.equal(await waitForSmokeElectronExit(userDataDir, 3_000), true,
      'Electron SIGKILL fallback must leave no smoke-owned process alive');
  }
}

async function killElectronForCrash(application) {
  const processHandle = application.process();
  assert(Number.isInteger(processHandle.pid) && processHandle.pid > 1, 'Electron crash case needs a live process id');
  process.kill(processHandle.pid, 'SIGKILL');
  await waitFor(() => !pidAlive(processHandle.pid), 'SIGKILL must terminate Electron before orphan checks', 3_000);
  try { await Promise.race([application.close(), new Promise(resolve => setTimeout(resolve, 3_000))]); } catch { /* main is intentionally dead */ }
}

async function launchCrashApplication() {
  let application;
  try {
    application = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env });
    const page = await application.firstWindow();
    page.on('pageerror', error => rendererErrors.push(`pageerror: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`); });
    await page.waitForLoadState('domcontentloaded');
    await assertBackgroundWindow(application);
    await application.evaluate(({ dialog, app: electronApp }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
      return { userData: electronApp.getPath('userData'), isPackaged: electronApp.isPackaged };
    }).then(value => {
      assert.equal(value.userData, userDataDir, 'each crash/reaper relaunch must retain the smoke-owned userData');
      assert.equal(value.isPackaged, false, 'TEST mode cannot exercise a packaged app');
    });
    const skip = page.getByText('Skip', { exact: true });
    if (await skip.count()) await skip.click();
    return { application, page };
  } catch (error) {
    await closeElectron(application);
    throw error;
  }
}

async function enableBridge(page, label, { expectFreshCopy = false } = {}) {
  if (expectFreshCopy) {
    assert.equal(await exists(copiedBinaryPath), false, 'the first enable must be the copy-then-pin path');
  }
  const enabled = await page.evaluate(() => window.electronAPI.handoffBridgeSetEnabled({ enabled: true }));
  const failedStatus = enabled.success ? null : await page.evaluate(() => window.electronAPI.handoffBridgeGetStatus());
  assert.equal(enabled.success, true, `${label}: explicit TEST enable failed: ${JSON.stringify({ enabled, failedStatus })}`);
  await waitFor(async () => {
    const status = (await page.evaluate(() => window.electronAPI.handoffBridgeGetStatus())).status;
    return status?.serving === 'live' && status?.setup?.tunnelReachable === true;
  }, `${label}: bridge did not reach live with a reachable fake tunnel`);
  await assertCopiedBinary();
  const fakePid = await waitForFakeAlive(`${label}: fake connector did not start`);
  await assertOwnedFakeCommand(fakePid);
  return fakePid;
}

async function emergencyStopTunnel() {
  // Error cleanup is constrained to the pidfile inside this smoke-owned temp
  // root. Use KILL only: a TERM path is precisely what the crash scenarios are
  // meant to avoid relying on.
  try {
    const intent = await readTunnelIntent();
    if (intent.pid !== process.pid && pidAlive(intent.pid) && hasOwnedTunnelMarker(processCommand(intent.pid))) {
      process.kill(intent.pid, 'SIGKILL');
    }
  } catch { /* no live intent, or it already exited */ }
  try {
    const pid = await fakeProcessPid();
    const command = processCommand(pid);
    if (pid !== process.pid && pidAlive(pid) && command.includes(fakeProgramPath) && hasOwnedTunnelMarker(command)) {
      process.kill(pid, 'SIGKILL');
    }
  } catch { /* no fake has been spawned */ }
}

let smokePassed = false;
let primarySmokeFailure = null;
const cleanupFailures = [];
try {
  app = await electron.launch({ args: ['.', `--user-data-dir=${userDataDir}`], env });
  const page = await app.firstWindow();
  page.on('pageerror', error => rendererErrors.push(`pageerror: ${error.message}`));
  page.on('console', message => { if (message.type() === 'error') rendererErrors.push(`console: ${message.text()}`); });
  await page.waitForLoadState('domcontentloaded');
  await assertBackgroundWindow(app);

  const liveUserData = await app.evaluate(({ dialog, app: electronApp }, fixture) => {
    dialog.showMessageBox = async (_parent, options = {}) => {
      // A real code sheet remains visible while the browser completes OAuth.
      // Resolving it early calls pairing.cancel(), so the test hook would be
      // empty before the Node driver can read it.
      if (options.title === 'ChatGPT pairing code') {
        return new Promise(resolve => {
          const finish = () => resolve({ response: 0 });
          if (options.signal?.aborted) finish();
          else options.signal?.addEventListener?.('abort', finish, { once: true });
        });
      }
      return { response: 1 };
    };
    // The enabled smoke must never resolve or contact ChatGPT.  The production
    // CIMD fetcher is pinned to this one document; replacing node:https in the
    // isolated main process gives that fetcher a deterministic, typed reply.
    // (The bridge is composed only after this hook is installed.)
    const { EventEmitter } = process.getBuiltinModule('node:events');
    const https = process.getBuiltinModule('node:https');
    const originalRequest = https.request;
    const http = process.getBuiltinModule('node:http');
    https.request = (target, options = {}, callback) => {
      const url = String(target);
      if (url === fixture.probeUrl) {
        // The production own-egress probe still issues two HTTPS-shaped
        // requests. TEST mode transports those bytes through the real Unix
        // listener instead: no DNS, TLS, or public network is involved.
        const family = options.family === 6 ? 6 : 4;
        const headers = { ...(options.headers || {}), host: fixture.hostname,
          'cf-connecting-ip': family === 6 ? '2001:4860:1234:5678::9' : '8.8.8.8' };
        return http.request({ socketPath: fixture.socketPath, path: '/.well-known/oauth-protected-resource/mcp',
          method: options.method || 'GET', headers }, callback);
      }
      const request = new EventEmitter();
      request.setTimeout = () => request;
      request.destroy = error => { if (error) request.emit('error', error); };
      request.end = () => process.nextTick(() => {
        if (url !== 'https://chatgpt.com/oauth/client.json') {
          request.emit('error', new Error(`unexpected smoke HTTPS target: ${url}`));
          return;
        }
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = { 'content-type': 'application/json' };
        response.resume = () => undefined;
        callback(response);
        response.emit('data', Buffer.from(JSON.stringify({
          client_id: 'https://chatgpt.com/oauth/client.json', client_name: 'ChatGPT',
          redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
          token_endpoint_auth_methods_supported: ['none'],
        })));
        response.emit('end');
      });
      return request;
    };
    globalThis.__icBridgeSmokeRestoreHttps = () => { https.request = originalRequest; };
    return { userData: electronApp.getPath('userData'), isPackaged: electronApp.isPackaged, env: {
      e2e: process.env.INFINITE_CANVAS_E2E,
      background: process.env.INFINITE_CANVAS_E2E_BACKGROUND,
      test: process.env.INFINITE_CANVAS_HANDOFF_BRIDGE_TEST,
    } };
  }, { socketPath, hostname: HOSTNAME, probeUrl: `https://${HOSTNAME}/.well-known/oauth-protected-resource/mcp` });
  assert.equal(liveUserData.userData, userDataDir, 'Electron must use smoke-owned temporary userData');
  assert.equal(liveUserData.isPackaged, false, 'TEST mode is permitted only in an unpackaged Electron app');
  assert.deepEqual(liveUserData.env, { e2e: '1', background: '1', test: '1' }, 'bridge smoke must set the E2E, hidden-window, and TEST-mode gates it relies on');
  assert(Buffer.byteLength(path.join(liveUserData.userData, SOCKET_RELATIVE_PATH)) <= 100, 'canonical Electron userData path must leave room for b.sock');

  const preload = await page.evaluate(async () => ({
    keys: Object.keys(window.electronAPI || {}).filter(key => key.startsWith('handoffBridge') || key.startsWith('onHandoffBridge')).sort(),
    status: await window.electronAPI.handoffBridgeGetStatus(),
  }));
  assert.deepEqual(preload.keys, BRIDGE_KEYS, 'preload must expose the exact closed bridge API surface');
  assert.equal(preload.status.success, true, 'bridge status IPC must be available in TEST mode');
  assert.equal(preload.status.status.serving, 'off', 'pre-seeded bridge must remain off until explicitly enabled');
  assert.equal(await exists(socketPath), false, 'disabled TEST bridge must not create a socket');

  // Exercise the ordinary UI boundary too: this is a real browser document,
  // but background E2E makes its window hidden and non-focusable.
  const skip = page.getByText('Skip', { exact: true });
  if (await skip.count()) await skip.click();

  await enableBridge(page, 'main enabled path', { expectFreshCopy: true });
  assert.equal(await exists(socketPath), true, 'enabled bridge must bind its Unix socket');
  const discovery = await socketRequest('/.well-known/oauth-protected-resource/mcp');
  assert.equal(discovery.statusCode, 200, 'real Unix listener must serve OAuth discovery');
  assert.match(discovery.body, /bridge\.test\.example\.com/, 'discovery must contain only the synthetic hostname');
  const mcp = await socketRequest('/mcp', 'POST', '{"jsonrpc":"2.0","id":1,"method":"tools/list"}', { 'content-type': 'application/json' });
  assert.equal(mcp.statusCode, 401, 'real MCP route must require OAuth before tool access');

  const opened = await page.evaluate(() => window.electronAPI.handoffBridgeOpenPairing());
  assert.equal(opened.success, true, `pairing must be opened by real IPC: ${JSON.stringify(opened)}`);
  const pairingCode = await app.evaluate(() => globalThis.__icHandoffBridgeTest?.readPairingCode?.() || null);
  assert.match(pairingCode || '', /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{10}$/,
    'only the TEST-only main hook may expose the raw compact pairing code while its sheet is open');
  const accessToken = await linkOAuth(pairingCode);
  const listed = await socketRequest('/mcp', 'POST', JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }), {
    'content-type': 'application/json', authorization: `Bearer ${accessToken}`,
  });
  assert.equal(listed.statusCode, 200, `authenticated tools/list failed: ${listed.body.slice(0, 200)}`);
  assert.deepEqual(JSON.parse(listed.body).result.tools.map(tool => tool.name), ['get_handoff', 'submit_handoff'],
    'MCP must expose the frozen two-tool golden surface exactly');

  const canvasPath = path.join(userDataDir, 'synthetic-application.canvas');
  await page.evaluate(async filePath => {
    const data = { schemaVersion: 3, nodes: [], edges: [], drawings: [] };
    return window.electronAPI.saveWorkspace({ data, filePath });
  }, canvasPath);
  const humanPasteJob = await queueSyntheticApplication(page, canvasPath, 'human-paste fixture');
  const published = await app.evaluate(({ BrowserWindow }, filePath) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.__canvasFilePath = filePath;
    return window.__canvasFilePath;
  }, canvasPath);
  assert.equal(published, canvasPath, 'test setup must bind the live main-owned canvas path before renderer publication');
  await publishApplicationJobs(page, SMOKE_PUBLISH_SEQUENCE_BASE + 1, [{
    jobId: humanPasteJob.localJob.id, canvasFilePath: canvasPath, dockState: 'awaiting', sig: 'synthetic-human-v1',
  }], 'human-paste fixture');
  await releaseApplicationJob(page, humanPasteJob.localJob.id, 'human-paste fixture');

  const chat = await page.evaluate(() => window.electronAPI.handoffBridgeNewChat());
  assert.equal(chat.success, true, `New chat must mint a session after a link: ${JSON.stringify(chat)}`);
  const starter = await app.evaluate(({ clipboard }) => clipboard.readText());
  const session = /\bwith session ([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{26})\./.exec(starter)?.[1];
  assert.ok(session, 'main-owned clipboard starter must contain the 26-character session code after "with session"');
  const humanHandoff = await mcpToolCall(accessToken, 3, 'get_handoff', { session }, 'human-paste initial get_handoff');
  assert.equal(humanHandoff.status, 'served', `active synthetic application must be served before a human paste: ${JSON.stringify(humanHandoff)}`);
  assert.equal(humanHandoff.stage, 'evidence-plan', 'the human-paste fixture must begin at the application evidence stage');
  const humanPaste = await page.evaluate(({ jobId, canvasFilePath, handoffCode, response }) => window.electronAPI.submitLocalApplicationHandoff({
    jobId, canvasFilePath, handoffCode, response,
  }), {
    jobId: humanPasteJob.localJob.id,
    canvasFilePath: canvasPath,
    handoffCode: humanHandoff.handoffCode,
    response: syntheticResponseForServedHandoff(humanHandoff),
  });
  assert.equal(humanPaste.accepted, true, `human local-application paste must advance the active bridge-served handoff: ${JSON.stringify(humanPaste)}`);
  assert.equal(humanPaste.completed, false, 'the human evidence-plan paste must leave later application stages to run');
  assert.equal(humanPaste.handoff?.stage, 'resume', 'human local-application paste must advance the durable app handoff to résumé');
  assert.notEqual(humanPaste.handoff?.handoffCode, humanHandoff.handoffCode, 'human local-application paste must rotate the app-owned handoff code');

  // This is the renderer publication the real dock publisher sends after the
  // human paste changes its handoff code. It is advisory only, but it makes
  // main re-read the app-owned handoff; that re-read must hold the lane rather
  // than silently adopting a human-issued advance for the MCP chat.
  await publishApplicationJobs(page, SMOKE_PUBLISH_SEQUENCE_BASE + 2, [{
    jobId: humanPasteJob.localJob.id, canvasFilePath: canvasPath, dockState: 'awaiting', sig: 'synthetic-human-v2',
  }], 'human-paste update');
  await page.evaluate(() => window.electronAPI.handoffBridgeGetStatus());
  // The real dock hint path deliberately coalesces reads for 500 ms. Wait for
  // that production timer instead of racing the stale pre-paste snapshot.
  await new Promise(resolve => setTimeout(resolve, 650));
  const preHeldLane = await page.evaluate(async jobId => {
    const status = await window.electronAPI.handoffBridgeGetStatus();
    return status.status?.queue?.jobs?.find(job => job.jobId === jobId) || null;
  }, humanPasteJob.localJob.id);
  const heldRead = await mcpToolCall(accessToken, 4, 'get_handoff', { session }, 'human-paste auto-hold get_handoff');
  assert.equal(heldRead.status, 'paused', `the next MCP get after a human app paste must stop serving the lane: ${JSON.stringify(preHeldLane)}`);
  assert.equal(heldRead.reason, 'needs_user', 'the MCP protocol must report a held application as needing human attention');
  await waitFor(async () => {
    const status = await page.evaluate(() => window.electronAPI.handoffBridgeGetStatus());
    const lane = status.status?.queue?.jobs?.find(job => job.jobId === humanPasteJob.localJob.id);
    return lane?.phase === 'held' && lane?.reason === 'human_advance';
  }, 'a human local-application paste must auto-hold its active bridge lane with human_advance');

  // Keep the held human lane intact, then prove a second all-synthetic job
  // drains every application stage through the real OAuth/MCP/main/app path.
  const fullDrainJob = await queueSyntheticApplication(page, canvasPath, 'full-drain fixture');
  await publishApplicationJobs(page, SMOKE_PUBLISH_SEQUENCE_BASE + 3, [
    { jobId: humanPasteJob.localJob.id, canvasFilePath: canvasPath, dockState: 'awaiting', sig: 'synthetic-human-v2' },
    { jobId: fullDrainJob.localJob.id, canvasFilePath: canvasPath, dockState: 'awaiting', sig: 'synthetic-full-drain-v1' },
  ], 'full-drain fixture');
  await releaseApplicationJob(page, fullDrainJob.localJob.id, 'full-drain fixture');
  const applicationStages = ['evidence-plan', 'resume', 'cover-letter', 'review'];
  let rpcId = 5;
  for (const [index, stage] of applicationStages.entries()) {
    const served = await mcpToolCall(accessToken, rpcId++, 'get_handoff', { session }, `full-drain ${stage} get_handoff`);
    assert.equal(served.status, 'served', `full-drain ${stage}: real MCP get_handoff must serve the application stage`);
    assert.equal(served.stage, stage, `full-drain ${stage}: real MCP get_handoff must preserve application stage order`);
    const accepted = await mcpToolCall(accessToken, rpcId++, 'submit_handoff', {
      session, handoffCode: served.handoffCode, response: syntheticResponseForServedHandoff(served),
    }, `full-drain ${stage} submit_handoff`);
    assert.equal(accepted.status, 'accepted', `full-drain ${stage}: real MCP submit_handoff must accept the synthetic stage response`);
    assert.equal(accepted.jobComplete, index === applicationStages.length - 1,
      `full-drain ${stage}: completion must occur only after the final review stage`);
    if (index < applicationStages.length - 1) {
      assert.equal(accepted.next?.status, 'served', `full-drain ${stage}: accepted response must expose the app-owned next handoff`);
      assert.equal(accepted.next?.stage, applicationStages[index + 1], `full-drain ${stage}: next handoff must advance exactly one stage`);
    } else {
      assert.equal(accepted.next, null, 'full-drain review: completed application must not expose another handoff');
    }
  }

  const nextChat = await page.evaluate(() => window.electronAPI.handoffBridgeNewChat());
  assert.equal(nextChat.success, true, 'a second human New chat must retire the old session');
  const stale = await mcpToolCall(accessToken, rpcId++, 'get_handoff', { session }, 'retired-session get_handoff');
  assert.equal(stale.status, 'session_ended', 'an old session code must never revive a retired chat');

  const disabled = await page.evaluate(() => window.electronAPI.handoffBridgeSetEnabled({ enabled: false }));
  assert.equal(disabled.success, true, `Disable must settle before app shutdown: ${JSON.stringify(disabled)}`);
  await waitFor(async () => !(await exists(socketPath)), 'Disable did not remove the Unix socket');
  await waitFor(fakeProcessGone, 'Disable did not terminate the fake cloudflared process group', 6_000);

  // First prove that the real watchdog escalates from TERM to KILL after a
  // Force Quit. The generated fake deliberately ignores TERM, and this code
  // sends SIGKILL only; it never relies on a POSIX TERM to close Electron.
  await closeElectron(app, { restoreHttps: true });
  app = null;
  const watchdogCrash = await launchCrashApplication();
  app = watchdogCrash.application;
  await enableBridge(watchdogCrash.page, 'watchdog escalation');
  await killElectronForCrash(watchdogCrash.application);
  app = null;
  await waitFor(fakeProcessGone, 'SIGKILL Electron alone must let the watchdog kill an ignore-SIGTERM fake within 6 seconds', 6_000);

  // A lone Force Quit no longer leaves an orphan, so kill the watchdog shell
  // from its live pidfile first, then Electron. This leaves the fake alive in
  // its detached group until a fresh app exercises launch-entry reaping.
  const orphanCrash = await launchCrashApplication();
  app = orphanCrash.application;
  const survivorPid = await enableBridge(orphanCrash.page, 'orphan reaper setup');
  const intent = await readTunnelIntent();
  assert.equal(pidAlive(intent.pid), true, 'the pidfile watchdog shell must be alive before the deliberate crash');
  assert.match(processCommand(intent.pid), /\bsh(?:\s|$)/,
    'the pidfile must name the real watchdog sh process, not the fake connector');
  process.kill(intent.pid, 'SIGKILL');
  await waitFor(() => !pidAlive(intent.pid), 'SIGKILL must terminate the pidfile watchdog shell', 3_000);
  await killElectronForCrash(orphanCrash.application);
  app = null;
  assert.equal(pidAlive(survivorPid), true, 'the ignore-SIGTERM fake must outlive the killed Electron and watchdog until relaunch');

  const reaperRelaunch = await launchCrashApplication();
  app = reaperRelaunch.application;
  // autoStart remains false, so no start-supervisor cleanup may run here.
  // Wait for the delayed launch-entry reaper to terminate the old process
  // before enabling a replacement; otherwise this drill could pass merely
  // because startHandoffBridge reaps while preparing its new supervisor.
  // This is distinct from the watchdog's six-second bound: launch waits three
  // seconds before invoking the reaper, whose deliberate TERM-ignoring fake
  // then takes the real TERM/TERM/KILL escalation path.
  await waitFor(() => !pidAlive(survivorPid), 'launch-entry scheduled reaper must reap the surviving owned fake before replacement enablement', 12_000);
  const replacementPid = await enableBridge(reaperRelaunch.page, 'post-launch-reaper replacement');
  assert.notEqual(replacementPid, survivorPid, 'the post-reap tunnel must be a fresh fake process, never the orphan');
  const reaperDisabled = await reaperRelaunch.page.evaluate(() => window.electronAPI.handoffBridgeSetEnabled({ enabled: false }));
  assert.equal(reaperDisabled.success, true, `relaunch Disable must settle before shutdown: ${JSON.stringify(reaperDisabled)}`);
  await waitFor(async () => !(await exists(socketPath)), 'relaunch Disable did not remove the Unix socket');
  await waitFor(fakeProcessGone, 'relaunch Disable did not terminate the replacement fake', 6_000);
  await closeElectron(app);
  app = null;
  assert.deepEqual(rendererErrors, [], 'bridge smoke renderer must remain error-free');
  smokePassed = true;
} catch (error) {
  primarySmokeFailure = error;
} finally {
  // Run every cleanup phase even when a preceding phase fails, then make the
  // complete teardown failure visible rather than printing a false PASS.
  try {
    await closeElectron(app, { restoreHttps: true });
  } catch (error) {
    cleanupFailures.push(error);
  }
  try {
    await emergencyStopTunnel();
  } catch (error) {
    cleanupFailures.push(error);
  }
  // The fake connector and Electron verification may each fail, but both
  // unique fixture roots are always attempted and rejected removals are fatal.
  const removals = await Promise.allSettled([
    fs.rm(userDataDir, { recursive: true, force: true }),
    fs.rm(fakeSourceRoot, { recursive: true, force: true }),
  ]);
  for (const result of removals) {
    if (result.status === 'rejected') cleanupFailures.push(result.reason);
  }
}
if (primarySmokeFailure) {
  if (cleanupFailures.length === 0) throw primarySmokeFailure;
  throw new globalThis.AggregateError([primarySmokeFailure, ...cleanupFailures], 'Electron bridge smoke and cleanup failed');
}
if (cleanupFailures.length > 0) throw new globalThis.AggregateError(cleanupFailures, 'Electron bridge smoke cleanup failed');
if (smokePassed) console.log('Electron bridge smoke test passed');
