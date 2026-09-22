/**
 * Secure bridge for syncing an editable application workspace opened directly
 * from disk. A browser cannot write a sibling file for a file:// document, so
 * the generated HTML POSTs to this localhost-only service instead. The client
 * holds an unguessable capability token; the service, never the browser,
 * chooses the fixed workspace files it may replace.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import electronPkg from 'electron';
import { JSDOM } from 'jsdom';
import { PDFDocument } from 'pdf-lib';
import { renderPdf, applyDualPdf, pdfHasDualModeBackground } from './resumeRender.js';
import {
  embedApplicationSyncConfig,
  extractVariantAttrs,
  isDualMode,
  restoreTrustedReceiptDerivations,
  sanitizeDocumentMainHtml,
} from './resumeHtml.js';
import { reconcileApplicationHtmlFromPdf } from './applicationPdfReconcile.js';
import { replaceApplicationBundleAtomically } from './applicationFileTransaction.js';
import { logger } from '../logger.js';

const { app } = electronPkg;

// A stable, loopback-only port means a saved HTML document keeps working after
// a normal app restart. The capability token remains the authorization layer.
const APPLICATION_SYNC_PORT = 43_192;
const APPLICATION_SYNC_PATH = '/application-sync';
const MAX_HTML_BYTES = 64 * 1024 * 1024;
const STATE_FILE = 'application-sync-workspaces.json';
const APPLICATION_SYNC_TOKEN_RE = /^[a-f0-9]{64}$/i;
const workspaces = new Map();
const workspaceSyncQueues = new Map();
let server = null;
let loadPromise = null;
let persistenceQueue = Promise.resolve();
let lastServerError = null;
let lastSyncAttempt = null;

export function getApplicationSyncTelemetry() {
  return lastSyncAttempt;
}

// Exported for deterministic report fixtures. Production records are owned by
// syncWorkspace below and never retain the bearer token or document HTML.
export function recordApplicationSyncTelemetry(data) {
  lastSyncAttempt = data == null ? null : { ts: Date.now(), ...data };
}

function updateSyncAttempt(attemptId, changes) {
  if (!attemptId || lastSyncAttempt?.attemptId !== attemptId) return;
  recordApplicationSyncTelemetry({ ...lastSyncAttempt, ...changes });
}

function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function canonicalPathKey(value) {
  const normalized = path.resolve(value).normalize('NFC');
  return process.platform === 'win32' || process.platform === 'darwin'
    ? normalized.toLowerCase()
    : normalized;
}

function normalizeWorkspaceIdentity(raw) {
  const realWorkspaceDir = typeof raw?.realWorkspaceDir === 'string' && path.isAbsolute(raw.realWorkspaceDir)
    ? path.resolve(raw.realWorkspaceDir)
    : '';
  const dev = String(raw?.dev ?? '');
  const ino = String(raw?.ino ?? '');
  return realWorkspaceDir && /^\d{1,32}$/.test(dev) && /^\d{1,32}$/.test(ino)
    ? { realWorkspaceDir, dev, ino }
    : null;
}

function normalizeWorkspace(raw) {
  const token = typeof raw?.token === 'string' && /^[a-f0-9]{64}$/i.test(raw.token) ? raw.token : '';
  const workspaceDir = typeof raw?.workspaceDir === 'string' ? path.resolve(raw.workspaceDir) : '';
  if (!token || !workspaceDir || !path.isAbsolute(workspaceDir)) return null;
  const applicationPath = path.resolve(workspaceDir, 'Application.html');
  const resumePdfPath = path.resolve(workspaceDir, 'Resume.pdf');
  const coverLetterPdfPath = path.resolve(workspaceDir, 'Cover Letter.pdf');
  // Keep persisted data intentionally tiny and reconstruct filenames rather
  // than trusting paths from the state file.
  if (!isInside(workspaceDir, applicationPath) || !isInside(workspaceDir, resumePdfPath) || !isInside(workspaceDir, coverLetterPdfPath)) return null;
  return {
    token,
    workspaceDir,
    applicationPath,
    resumePdfPath,
    coverLetterPdfPath,
    identity: normalizeWorkspaceIdentity(raw?.identity),
  };
}

async function captureOrVerifyWorkspaceIdentity(workspace) {
  let directoryStat;
  try {
    directoryStat = await fs.promises.lstat(workspace.workspaceDir);
  } catch (error) {
    // Keep the code so restore can distinguish a disposable, user-deleted
    // application folder from an unsafe replacement.
    const unavailable = new Error(`Application Sync workspace is unavailable: ${error?.message || error}`);
    unavailable.code = error?.code;
    throw unavailable;
  }
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    throw new Error('Application Sync workspace must be a regular directory, not a symbolic link.');
  }
  const realWorkspaceDir = await fs.promises.realpath(workspace.workspaceDir);
  if (canonicalPathKey(realWorkspaceDir) !== canonicalPathKey(workspace.workspaceDir)) {
    throw new Error('Application Sync workspace must not traverse a symbolic link.');
  }
  let applicationStat;
  try {
    applicationStat = await fs.promises.lstat(workspace.applicationPath);
  } catch (error) {
    const unavailable = new Error(`Application Sync workspace HTML is unavailable: ${error?.message || error}`);
    unavailable.code = error?.code;
    throw unavailable;
  }
  if (!applicationStat.isFile() || applicationStat.isSymbolicLink()) {
    throw new Error('Application Sync workspace HTML must be a regular file.');
  }

  const currentIdentity = {
    realWorkspaceDir,
    dev: String(directoryStat.dev),
    ino: String(directoryStat.ino),
  };
  if (workspace.identity
    && (canonicalPathKey(workspace.identity.realWorkspaceDir) !== canonicalPathKey(currentIdentity.realWorkspaceDir)
      || workspace.identity.dev !== currentIdentity.dev
      || workspace.identity.ino !== currentIdentity.ino)) {
    throw new Error('Application Sync workspace was replaced after it was registered.');
  }
  return { ...workspace, identity: currentIdentity };
}

function sameFileIdentity(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

async function readFileHandleBounded(handle, maxBytes) {
  const chunks = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes + 1 - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    chunks.push(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new Error('The saved application workspace exceeds the safe Sync size limit.');
  return Buffer.concat(chunks, offset).toString('utf8');
}

async function readBinaryFileHandleBounded(handle, maxBytes) {
  const chunks = [];
  let offset = 0;
  while (offset <= maxBytes) {
    const buffer = Buffer.allocUnsafe(Math.min(1024 * 1024, maxBytes + 1 - offset));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) break;
    chunks.push(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  if (offset > maxBytes) throw new Error('The application PDF exceeds the safe Sync size limit.');
  return Buffer.concat(chunks, offset);
}

async function readRegisteredWorkspaceHtml(workspace) {
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let preOpenStat = null;
  let handle;
  if (!noFollow) {
    preOpenStat = await fs.promises.lstat(workspace.applicationPath);
    if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
      throw new Error('Application Sync workspace HTML must be a regular file.');
    }
  }
  try {
    handle = await fs.promises.open(workspace.applicationPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    // A few filesystems expose O_NOFOLLOW but reject the flag itself. Fall
    // back only for an unsupported operation, never for ELOOP (the expected
    // rejection when the path is actually a symbolic link), and bind the
    // opened handle to a pre-open lstat identity below.
    if (!noFollow || !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    preOpenStat = await fs.promises.lstat(workspace.applicationPath);
    if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
      throw new Error('Application Sync workspace HTML must be a regular file.');
    }
    handle = await fs.promises.open(workspace.applicationPath, fs.constants.O_RDONLY);
  }

  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size > MAX_HTML_BYTES
      || (preOpenStat && !sameFileIdentity(openedStat, preOpenStat))) {
      throw new Error('Application Sync workspace HTML changed or is not a safe regular file.');
    }
    // Opening a final file with O_NOFOLLOW is not enough if an ancestor was
    // replaced. Re-check the captured directory after the handle is open,
    // then prove the current path still names that exact opened file.
    await captureOrVerifyWorkspaceIdentity(workspace);
    const currentPathStat = await fs.promises.lstat(workspace.applicationPath);
    if (!currentPathStat.isFile() || currentPathStat.isSymbolicLink()
      || !sameFileIdentity(currentPathStat, openedStat)) {
      throw new Error('Application Sync workspace HTML changed while it was being opened.');
    }
    const html = await readFileHandleBounded(handle, MAX_HTML_BYTES);
    const finalStat = await handle.stat();
    if (!sameFileIdentity(finalStat, openedStat)
      || finalStat.size !== openedStat.size
      || finalStat.mtimeMs !== openedStat.mtimeMs
      || finalStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error('Application Sync workspace HTML changed while it was being read.');
    }
    return html;
  } finally {
    await handle.close();
  }
}

async function readRegisteredWorkspacePdf(workspace, documentKind) {
  const pdfPath = documentKind === 'cover' ? workspace.coverLetterPdfPath
    : documentKind === 'resume' ? workspace.resumePdfPath : '';
  if (!pdfPath || !isInside(workspace.workspaceDir, pdfPath)) {
    throw new Error('Application Sync received an invalid PDF document kind.');
  }
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  let preOpenStat = null;
  let handle;
  if (!noFollow) {
    preOpenStat = await fs.promises.lstat(pdfPath);
    if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
      throw new Error('Application Sync PDF must be a regular file.');
    }
  }
  try {
    handle = await fs.promises.open(pdfPath, fs.constants.O_RDONLY | noFollow);
  } catch (error) {
    if (!noFollow || !['EINVAL', 'ENOTSUP', 'EOPNOTSUPP'].includes(error?.code)) throw error;
    preOpenStat = await fs.promises.lstat(pdfPath);
    if (!preOpenStat.isFile() || preOpenStat.isSymbolicLink()) {
      throw new Error('Application Sync PDF must be a regular file.');
    }
    handle = await fs.promises.open(pdfPath, fs.constants.O_RDONLY);
  }
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size > MAX_HTML_BYTES
      || (preOpenStat && !sameFileIdentity(openedStat, preOpenStat))) {
      throw new Error('Application Sync PDF changed or is not a safe regular file.');
    }
    await captureOrVerifyWorkspaceIdentity(workspace);
    const currentPathStat = await fs.promises.lstat(pdfPath);
    if (!currentPathStat.isFile() || currentPathStat.isSymbolicLink()
      || !sameFileIdentity(currentPathStat, openedStat)) {
      throw new Error('Application Sync PDF changed while it was being opened.');
    }
    const bytes = await readBinaryFileHandleBounded(handle, MAX_HTML_BYTES);
    const finalStat = await handle.stat();
    if (!sameFileIdentity(finalStat, openedStat)
      || finalStat.size !== openedStat.size
      || finalStat.mtimeMs !== openedStat.mtimeMs
      || finalStat.ctimeMs !== openedStat.ctimeMs) {
      throw new Error('Application Sync PDF changed while it was being read.');
    }
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('Application Sync sibling is not a valid PDF.');
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

// Rendering can take long enough for a user to save another edit in the
// external Application.html. Do not let the earlier Sync request silently
// promote over that newer revision. This deliberately reuses the descriptor-
// bound reader, so the comparison also rechecks the workspace and final-file
// symlink/identity defenses before the bundle transaction begins.
async function assertWorkspaceHtmlUnchanged(workspace, expectedHtml) {
  const currentHtml = await readRegisteredWorkspaceHtml(workspace);
  const expected = Buffer.from(String(expectedHtml || ''), 'utf8');
  const current = Buffer.from(currentHtml, 'utf8');
  if (expected.length !== current.length || !crypto.timingSafeEqual(expected, current)) {
    throw new Error('Application Sync workspace changed while the PDF was rendering. Reopen the latest Application.html and retry Sync.');
  }
}

async function persistWorkspaces() {
  const payload = JSON.stringify({
    version: 2,
    workspaces: [...workspaces.values()].map(({ token, workspaceDir, identity }) => ({ token, workspaceDir, identity })),
  }, null, 2);
  const target = statePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(temporary, payload, { mode: 0o600 });
    await fs.promises.rename(temporary, target);
  } finally {
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function persistWorkspacesSerialized() {
  // Two Generate clicks can save into separate company folders at the same
  // time. Serialize snapshots/renames so an older write can never win after a
  // newer capability has been registered.
  const write = persistenceQueue.catch(() => {}).then(() => persistWorkspaces());
  persistenceQueue = write;
  return write;
}

// registerApplicationSyncWorkspace and startApplicationSyncServer can both run
// this close together at launch. A boolean "already loading" flag lets a
// second caller proceed against a still-empty `workspaces` map, and its later
// `workspaces.set(...)` replays a token the first caller's dedup just deleted.
// Memoizing the in-flight promise itself means every caller awaits the SAME
// completed load.
function loadWorkspaces() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    let parsed;
    try {
      parsed = JSON.parse(await fs.promises.readFile(statePath(), 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn(`[ApplicationSync] Could not read saved workspace capabilities: ${error?.message || error}`);
      return;
    }

    let rewriteState = false;
    for (const raw of Array.isArray(parsed?.workspaces) ? parsed.workspaces : []) {
      const normalized = normalizeWorkspace(raw);
      // Invalid entries cannot ever be served. Drop them from the durable
      // state too, rather than rediscovering the same bad capability at every
      // launch.
      if (!normalized) {
        rewriteState = true;
        continue;
      }
      try {
        const workspace = await captureOrVerifyWorkspaceIdentity(normalized);
        if (!normalized.identity) rewriteState = true;
        workspaces.set(workspace.token, workspace);
      } catch (error) {
        rewriteState = true;
        if (error?.code === 'ENOENT') {
          // Generated application folders are deliberately disposable. Their
          // absence after a user cleans Applied Jobs is expected, not a
          // security incident, and should not produce a warning on every
          // subsequent launch.
          logger.info(`[ApplicationSync] Discarding unavailable saved workspace capability: ${normalized.workspaceDir}`);
        } else {
          logger.warn(`[ApplicationSync] Ignoring unsafe saved workspace: ${error?.message || error}`);
        }
      }
    }
    if (rewriteState) {
      try {
        await persistWorkspaces();
      } catch (error) {
        logger.warn(`[ApplicationSync] Could not prune saved workspace capabilities: ${error?.message || error}`);
      }
    }
  })();
  return loadPromise;
}

function corsHeaders(origin) {
  // file:// pages send Origin: null in Chromium. Do not grant CORS to web
  // origins: token validation is still required, but this prevents a web page
  // from using the response as an oracle.
  const allowedOrigin = origin === 'null' || origin === 'file://' ? origin : '';
  return {
    ...(allowedOrigin ? { 'Access-Control-Allow-Origin': allowedOrigin, Vary: 'Origin' } : {}),
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Allow-Private-Network': 'true',
    'Access-Control-Max-Age': '600',
  };
}

function sendJson(response, status, body, origin) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders(origin) });
  response.end(JSON.stringify(body));
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function applicationPanelSha256(html, documentKind) {
  const dom = new JSDOM(String(html || ''));
  try {
    const panel = dom.window.document.querySelector(`[data-ic-document-panel="${documentKind}"]`);
    const main = panel?.querySelector('main.page');
    if (!main) throw new Error(`Application workspace is missing its ${documentKind} document panel.`);
    return sha256(Buffer.from(main.outerHTML, 'utf8'));
  } finally {
    dom.window.close();
  }
}

function applicationSyncDataFromHtml(html) {
  const dom = new JSDOM(String(html || ''));
  try {
    const node = dom.window.document.querySelector('[id="ic-application-bundle-data"][type="application/json"]');
    if (!node) throw new Error('Application workspace is missing its Sync data.');
    const data = JSON.parse(node.textContent || '{}');
    return data?.sync && typeof data.sync === 'object' ? data.sync : {};
  } finally {
    dom.window.close();
  }
}

function withApplicationDocumentRevision(html, documentKind, pdfBytes, token) {
  const existing = applicationSyncDataFromHtml(html);
  const documents = {
    resume: {
      pdfSha256: String(existing?.documents?.resume?.pdfSha256 || ''),
      htmlSha256: String(existing?.documents?.resume?.htmlSha256 || ''),
    },
    cover: {
      pdfSha256: String(existing?.documents?.cover?.pdfSha256 || ''),
      htmlSha256: String(existing?.documents?.cover?.htmlSha256 || ''),
    },
  };
  documents[documentKind] = {
    pdfSha256: sha256(pdfBytes),
    htmlSha256: applicationPanelSha256(html, documentKind),
  };
  return embedApplicationSyncConfig(html, {
    endpoint: `http://127.0.0.1:${APPLICATION_SYNC_PORT}${APPLICATION_SYNC_PATH}`,
    token,
    version: 2,
    documents,
  });
}

function withApplicationPrintVariant(html, dualMode) {
  const source = String(html || '');
  const dom = new JSDOM(source, { includeNodeLocations: true });
  let location;
  try {
    location = dom.nodeLocation(dom.window.document.documentElement)?.startTag;
  } finally {
    dom.window.close();
  }
  if (!location || !Number.isInteger(location.startOffset) || !Number.isInteger(location.endOffset)) {
    throw new Error('Application workspace root HTML element has no source boundary.');
  }
  const rootTag = source.slice(location.startOffset, location.endOffset);
  const mode = dualMode ? 'dual-pdf' : 'ink-only';
  const attribute = /\sdata-print(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/i;
  const updatedRoot = attribute.test(rootTag)
    ? rootTag.replace(attribute, ` data-print="${mode}"`)
    : rootTag.slice(0, -1) + ` data-print="${mode}">`;
  return source.slice(0, location.startOffset) + updatedRoot + source.slice(location.endOffset);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const headerLength = Number(request.headers['content-length']);
    if (Number.isFinite(headerLength) && headerLength > MAX_HTML_BYTES) {
      reject(Object.assign(new Error('The application HTML is too large to sync.'), { statusCode: 413 }));
      request.resume();
      return;
    }
    const chunks = [];
    let bytes = 0;
    request.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_HTML_BYTES) {
        reject(Object.assign(new Error('The application HTML is too large to sync.'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('Sync received invalid data.'), { statusCode: 400 })); }
    });
  });
}

/**
 * The browser sends its complete two-panel workspace, but Sync only renders
 * one companion PDF at a time. Persisting the incoming document verbatim
 * would therefore let an unsynced edit in the OTHER panel leak into
 * Application.html while that panel's PDF remained on the previous revision.
 *
 * The saved file is the trusted shell. Browser-supplied HTML may differ only in
 * the selected editable `<main>`; toolbar/scripts/styles/capability data and the
 * inactive document all come from the last saved revision. Both document mains
 * pass through the same strict allowlist used at initial generation, which also
 * cleans an older pre-sanitizer inactive panel when it next participates in a
 * Sync. Source-offset replacement preserves the trusted shell byte-for-byte.
 */
export function mergeSelectedApplicationPanel(incomingHtml, storedHtml, documentKind, { expectedToken = '' } = {}) {
  const selected = documentKind === 'cover' ? 'cover' : documentKind === 'resume' ? 'resume' : '';
  if (!selected) throw new Error('A valid application document kind is required.');
  const collectUniqueReviewState = (dom, selector, keyAttribute, stateAttribute, allowedStates) => {
    const values = new Map();
    const duplicates = new Set();
    for (const element of dom.window.document.querySelectorAll(selector)) {
      const key = String(element.getAttribute(keyAttribute) || '');
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(key)) continue;
      if (values.has(key)) {
        duplicates.add(key);
        values.delete(key);
        continue;
      }
      if (duplicates.has(key)) continue;
      const state = String(element.getAttribute(stateAttribute) || '');
      const location = dom.nodeLocation(element)?.startTag;
      values.set(key, {
        state: allowedStates.has(state) ? state : '',
        location: location && Number.isInteger(location.startOffset) && Number.isInteger(location.endOffset)
          ? location : null,
      });
    }
    return values;
  };
  const inspect = (html, label, { validateCapability = false } = {}) => {
    const dom = new JSDOM(String(html || ''), { includeNodeLocations: true });
    const locations = {};
    try {
      for (const kind of ['resume', 'cover']) {
        const nodes = dom.window.document.querySelectorAll(`[data-ic-document-panel="${kind}"]`);
        if (nodes.length !== 1) {
          throw new Error(`${label} application workspace must contain exactly one ${kind} panel (found ${nodes.length}).`);
        }
        const mains = nodes[0].querySelectorAll('main.page');
        if (mains.length !== 1) {
          throw new Error(`${label} application workspace ${kind} panel must contain exactly one document page (found ${mains.length}).`);
        }
        const location = dom.nodeLocation(mains[0]);
        if (!location || !Number.isInteger(location.startOffset) || !Number.isInteger(location.endOffset)) {
          throw new Error(`${label} application workspace ${kind} panel has no source boundary.`);
        }
        locations[kind] = location;
      }

      if (validateCapability) {
        const bundles = dom.window.document.querySelectorAll('[id="ic-application-bundle-data"][type="application/json"]');
        if (bundles.length !== 1) throw new Error('Saved application workspace has an invalid Sync capability node.');
        let bundle;
        try { bundle = JSON.parse(bundles[0].textContent || '{}'); }
        catch { throw new Error('Saved application workspace has invalid Sync capability data.'); }
        if (bundle?.sync?.endpoint !== `http://127.0.0.1:${APPLICATION_SYNC_PORT}${APPLICATION_SYNC_PATH}`
          || (expectedToken && bundle?.sync?.token !== expectedToken)) {
          throw new Error('Saved application workspace Sync capability does not match this registered workspace.');
        }
      }
      return {
        mains: locations,
        decisions: collectUniqueReviewState(
          dom,
          '[data-ic-insight][data-ic-kind="verify"]',
          'data-ic-insight',
          'data-ic-decision',
          new Set(['verified', 'not_mine']),
        ),
        locations: collectUniqueReviewState(
          dom,
          '[data-ic-location-check]',
          'data-ic-location-check',
          'data-ic-location-decision',
          new Set(['confirmed']),
        ),
      };
    } finally {
      dom.window.close();
    }
  };
  const incoming = String(incomingHtml || '');
  const stored = String(storedHtml || '');
  const incomingState = inspect(incoming, 'Incoming');
  const storedState = inspect(stored, 'Saved', { validateCapability: Boolean(expectedToken) });
  const incomingLocations = incomingState.mains;
  const storedLocations = storedState.mains;
  const replacements = ['resume', 'cover'].map((kind) => {
    const storedMain = sanitizeDocumentMainHtml(
      stored.slice(storedLocations[kind].startOffset, storedLocations[kind].endOffset),
      { documentKind: kind, allowHostState: true, allowTrustedDerivations: true },
    );
    const incomingMain = kind === selected
      ? sanitizeDocumentMainHtml(
        incoming.slice(incomingLocations[kind].startOffset, incomingLocations[kind].endOffset),
        { documentKind: kind, allowHostState: true, allowTrustedDerivations: false },
      )
      : null;
    return {
      start: storedLocations[kind].startOffset,
      end: storedLocations[kind].endOffset,
      html: incomingMain
        ? restoreTrustedReceiptDerivations(incomingMain, storedMain)
        : storedMain,
    };
  });

  const setStartTagAttribute = (startTag, name, value) => {
    const attribute = new RegExp(`\\s${name}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?(?=\\s|/?>)`, 'i');
    const serialized = ` ${name}="${value}"`;
    if (attribute.test(startTag)) return startTag.replace(attribute, serialized);
    const insertionPoint = startTag.endsWith('/>') ? startTag.length - 2 : startTag.length - 1;
    return startTag.slice(0, insertionPoint) + serialized + startTag.slice(insertionPoint);
  };
  const addReviewStateReplacements = (incomingMap, storedMap, attributeName) => {
    for (const [key, incomingReview] of incomingMap) {
      if (!incomingReview.state) continue;
      const storedReview = storedMap.get(key);
      const location = storedReview?.location;
      if (!location) continue;
      // Review controls are trusted shell UI, never part of an editable main.
      // Refuse an overlapping target even if a malformed stored document
      // somehow placed a matching attribute inside one of the pages.
      if (Object.values(storedLocations).some(main => location.startOffset >= main.startOffset && location.endOffset <= main.endOffset)) continue;
      const current = stored.slice(location.startOffset, location.endOffset);
      replacements.push({
        start: location.startOffset,
        end: location.endOffset,
        html: setStartTagAttribute(current, attributeName, incomingReview.state),
      });
    }
  };
  addReviewStateReplacements(incomingState.decisions, storedState.decisions, 'data-ic-decision');
  addReviewStateReplacements(incomingState.locations, storedState.locations, 'data-ic-location-decision');
  replacements.sort((a, b) => b.start - a.start);

  let merged = stored;
  for (const replacement of replacements) {
    merged = merged.slice(0, replacement.start) + replacement.html + merged.slice(replacement.end);
  }
  return merged;
}

// Sync is atomic per file, but an application workspace has one shared HTML
// source and two derived PDFs. Without a workspace-scoped queue, a resume Sync
// and cover-letter Sync can render concurrently and interleave their renames:
// the later HTML can be paired with the earlier PDF. Serialize only callers
// targeting the same directory; unrelated applications still sync in parallel.
export function withApplicationSyncWorkspaceLock(workspaceDir, fn) {
  const key = path.resolve(workspaceDir);
  const previous = workspaceSyncQueues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(fn);
  const tail = result.then(() => {}, () => {});
  workspaceSyncQueues.set(key, tail);
  return result.finally(() => {
    if (workspaceSyncQueues.get(key) === tail) workspaceSyncQueues.delete(key);
  });
}

/**
 * Prove that a promoted Sync revision is the exact HTML/PDF pair rendered for
 * this request. A `%PDF-` prefix is not sufficient: parse the document and
 * require at least one real page. The HTML must retain both editable panels
 * and the same capability that authorized the request, otherwise a successful
 * edit could silently disable its own next Sync.
 */
export async function inspectApplicationSyncRevision({ applicationPath, pdfPath, html, pdf, token }) {
  const manifest = [];
  const expected = [
    { name: path.basename(applicationPath), path: applicationPath, data: Buffer.from(String(html || ''), 'utf8'), kind: 'html' },
    { name: path.basename(pdfPath), path: pdfPath, data: Buffer.from(pdf || []), kind: 'pdf' },
  ];
  for (const item of expected) {
    const row = { name: item.name, exists: false, readable: false, bytes: 0, matchesSource: false };
    try {
      const stat = await fs.promises.stat(item.path);
      row.exists = stat.isFile();
      row.mtimeMs = stat.mtimeMs;
      if (row.exists) {
        const data = await fs.promises.readFile(item.path);
        row.readable = true;
        row.bytes = data.length;
        row.sha256 = crypto.createHash('sha256').update(data).digest('hex').slice(0, 16);
        row.matchesSource = data.equals(item.data);
        if (item.kind === 'html') {
          const dom = new JSDOM(data.toString('utf8'));
          try {
            const document = dom.window.document;
            const resumePanels = document.querySelectorAll('[data-ic-document-panel="resume"]');
            const coverPanels = document.querySelectorAll('[data-ic-document-panel="cover"]');
            let bundle = {};
            try { bundle = JSON.parse(document.getElementById('ic-application-bundle-data')?.textContent || '{}'); }
            catch { bundle = {}; }
            row.syncConfigValid = bundle?.sync?.endpoint === `http://127.0.0.1:${APPLICATION_SYNC_PORT}${APPLICATION_SYNC_PATH}`
              && bundle?.sync?.token === token;
            row.htmlStructureValid = document.doctype?.name?.toLowerCase() === 'html'
              && resumePanels.length === 1
              && coverPanels.length === 1
              && !!resumePanels[0].querySelector('main.page')
              && !!coverPanels[0].querySelector('main.page')
              && row.syncConfigValid;
          } finally {
            dom.window.close();
          }
        } else {
          row.pdfHeaderValid = data.subarray(0, 5).toString('ascii') === '%PDF-';
          row.pdfParsed = false;
          if (row.pdfHeaderValid) {
            const parsed = await PDFDocument.load(data);
            row.pageCount = parsed.getPageCount();
            if (row.pageCount > 0) {
              const { width, height } = parsed.getPage(0).getSize();
              row.firstPagePoints = `${Math.round(width)}x${Math.round(height)}`;
              row.pdfParsed = true;
            }
          }
        }
      }
    } catch (error) {
      row.error = String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 300);
    }
    row.integrityVerified = row.exists && row.readable && row.bytes > 0 && row.matchesSource
      && (item.kind === 'html' ? row.htmlStructureValid === true : row.pdfParsed === true);
    manifest.push(row);
  }
  if (manifest.some(row => !row.integrityVerified)) {
    const error = new Error(`Application Sync readback failed for: ${manifest.filter(row => !row.integrityVerified).map(row => row.name).join(', ')}`);
    error.syncManifest = manifest;
    throw error;
  }
  return manifest;
}

function registeredWorkspaceForToken(payload) {
  const token = typeof payload?.token === 'string' ? payload.token : '';
  // Validate before looking up or comparing the bearer value. Besides making
  // malformed requests an ordinary authorization denial, this guarantees both
  // buffers given to timingSafeEqual have the same fixed byte length.
  if (!APPLICATION_SYNC_TOKEN_RE.test(token)) {
    throw Object.assign(new Error('This workspace is not registered with Infinite Canvas. Launch the app and reopen the saved application.'), { statusCode: 403 });
  }
  const workspace = workspaces.get(token);
  if (!workspace || !APPLICATION_SYNC_TOKEN_RE.test(workspace.token)
    || !crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(workspace.token, 'hex'))) {
    throw Object.assign(new Error('This workspace is not registered with Infinite Canvas. Launch the app and reopen the saved application.'), { statusCode: 403 });
  }
  return { token, workspace };
}

async function reconcileWorkspacePdfs(payload) {
  const { token, workspace } = registeredWorkspaceForToken(payload);
  return withApplicationSyncWorkspaceLock(workspace.workspaceDir, async () => {
    if (workspaces.get(token) !== workspace) {
      throw Object.assign(new Error('This workspace was replaced by a newer generated application. Reopen the latest Application.html.'), { statusCode: 409 });
    }
    await captureOrVerifyWorkspaceIdentity(workspace);
    const storedHtml = await readRegisteredWorkspaceHtml(workspace);
    let reconciledHtml = storedHtml;
    let syncData = applicationSyncDataFromHtml(reconciledHtml);
    const importedDocuments = [];
    const staleDocuments = [];
    const conflicts = [];
    const variantMismatches = [];
    const checkedPdfs = new Map();
    const pdfDualModes = new Map();
    let metadataChanged = false;

    for (const documentKind of ['resume', 'cover']) {
      let pdfBytes;
      try {
        pdfBytes = await readRegisteredWorkspacePdf(workspace, documentKind);
      } catch (error) {
        if (error?.code === 'ENOENT') {
          conflicts.push({ document: documentKind, reason: 'The sibling PDF is missing.' });
          continue;
        }
        throw error;
      }
      checkedPdfs.set(documentKind, pdfBytes);
      pdfDualModes.set(documentKind, await pdfHasDualModeBackground(pdfBytes));
    }

    // The paper treatment belongs to the shared HTML root, so import it only
    // when BOTH sibling PDFs agree. A matching pair is an unambiguous external
    // revision and the saved preview should look like those PDFs. If the two
    // PDFs disagree, neither one is allowed to silently change the other
    // document's display; the per-document mismatch remains stale below.
    const originalDualMode = isDualMode(extractVariantAttrs(reconciledHtml));
    const distinctPdfModes = new Set(pdfDualModes.values());
    if (pdfDualModes.size === 2 && distinctPdfModes.size === 1) {
      const [pdfDualMode] = distinctPdfModes;
      if (pdfDualMode !== originalDualMode) {
        reconciledHtml = withApplicationPrintVariant(reconciledHtml, pdfDualMode);
        importedDocuments.push('resume', 'cover');
        metadataChanged = true;
      }
    }

    for (const documentKind of ['resume', 'cover']) {
      const pdfBytes = checkedPdfs.get(documentKind);
      if (!pdfBytes) continue;
      const actualPdfSha256 = sha256(pdfBytes);
      const expected = syncData?.documents?.[documentKind] || {};
      const currentHtmlSha256 = applicationPanelSha256(reconciledHtml, documentKind);
      const pdfChanged = Boolean(expected.pdfSha256) && expected.pdfSha256 !== actualPdfSha256;
      const htmlChanged = Boolean(expected.htmlSha256) && expected.htmlSha256 !== currentHtmlSha256;
      const expectedDualMode = isDualMode(extractVariantAttrs(reconciledHtml));
      const actualDualMode = pdfDualModes.get(documentKind);
      const variantMismatch = expectedDualMode !== actualDualMode;

      if (variantMismatch) {
        if (!staleDocuments.includes(documentKind)) staleDocuments.push(documentKind);
        variantMismatches.push({
          document: documentKind,
          expected: expectedDualMode ? 'dual-pdf' : 'ink-only',
          actual: actualDualMode ? 'dual-pdf' : 'ink-only',
        });
      }

      if (!pdfChanged && expected.pdfSha256) {
        if (htmlChanged && !staleDocuments.includes(documentKind)) staleDocuments.push(documentKind);
        continue;
      }
      if (pdfChanged && htmlChanged) {
        conflicts.push({ document: documentKind, reason: 'Both the PDF and editable HTML changed after their last shared revision.' });
        continue;
      }

      let reconciliation;
      try {
        reconciliation = await reconcileApplicationHtmlFromPdf({
          html: reconciledHtml,
          pdfBytes,
          documentKind,
        });
      } catch (error) {
        conflicts.push({
          document: documentKind,
          reason: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 500),
        });
        continue;
      }
      if (reconciliation?.success !== true || reconciliation?.status === 'conflict'
        || typeof reconciliation?.html !== 'string') {
        conflicts.push({
          document: documentKind,
          reason: String(reconciliation?.error || reconciliation?.reason || 'The PDF text could not be mapped back to editable HTML without ambiguity.').slice(0, 500),
        });
        continue;
      }
      reconciledHtml = reconciliation.html;
      if (reconciliation.changed && !importedDocuments.includes(documentKind)) importedDocuments.push(documentKind);
      // Do not certify a text-aligned but visually incompatible pair. The HTML
      // owns the app-selected paper treatment; a normal Sync will re-render
      // this PDF with the correct ink-only/dual-mode state.
      if (!variantMismatch) {
        reconciledHtml = withApplicationDocumentRevision(reconciledHtml, documentKind, pdfBytes, token);
        syncData = applicationSyncDataFromHtml(reconciledHtml);
        metadataChanged = true;
      }
    }

    if (reconciledHtml !== storedHtml) {
      await captureOrVerifyWorkspaceIdentity(workspace);
      await assertWorkspaceHtmlUnchanged(workspace, storedHtml);
      await replaceApplicationBundleAtomically([
        { destination: workspace.applicationPath, data: reconciledHtml, expectedCurrentData: storedHtml },
      ], {
        verify: async () => {
          const saved = await readRegisteredWorkspaceHtml(workspace);
          if (saved !== reconciledHtml) throw new Error('Reconciled application HTML failed readback verification.');
          for (const [documentKind, expectedPdf] of checkedPdfs) {
            const currentPdf = await readRegisteredWorkspacePdf(workspace, documentKind);
            if (!currentPdf.equals(expectedPdf)) {
              throw new Error(`The ${documentKind} PDF changed while its text was being imported.`);
            }
          }
          return true;
        },
      });
    }
    return {
      importedDocuments,
      staleDocuments,
      conflicts,
      variantMismatches,
      metadataChanged,
      reloadRequired: importedDocuments.length > 0,
    };
  });
}

async function syncWorkspace(payload) {
  const { token, workspace } = registeredWorkspaceForToken(payload);
  const documentKind = payload?.document === 'cover' ? 'cover' : payload?.document === 'resume' ? 'resume' : '';
  const html = typeof payload?.html === 'string' ? payload.html : '';
  if (!documentKind || !html.trim() || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw Object.assign(new Error('Sync received an invalid application document.'), { statusCode: 400 });
  }
  const attemptId = crypto.randomUUID();
  const attempt = {
    attemptId,
    workspaceDir: workspace.workspaceDir,
    document: documentKind,
    startedAt: Date.now(),
    status: 'running',
    phase: 'queued',
  };
  recordApplicationSyncTelemetry(attempt);
  try {
    return await withApplicationSyncWorkspaceLock(workspace.workspaceDir, async () => {
      updateSyncAttempt(attemptId, { phase: 'reading saved workspace' });
      // The request may have queued behind a newly generated replacement for
      // this same directory. Re-check after acquiring the lock so a token that
      // was valid at receipt time cannot overwrite the newly saved workspace.
      if (workspaces.get(token) !== workspace) {
        throw Object.assign(new Error('This workspace was replaced by a newer generated application. Reopen the latest Application.html before syncing.'), { statusCode: 409 });
      }
      try {
        await captureOrVerifyWorkspaceIdentity(workspace);
      } catch (error) {
        throw Object.assign(new Error(`The registered application workspace is no longer safe: ${error?.message || error}`), { statusCode: 409 });
      }
      let storedHtml;
      try {
        storedHtml = await readRegisteredWorkspaceHtml(workspace);
      } catch (error) {
        throw Object.assign(new Error(`The saved application workspace could not be read: ${error?.message || error}`), { statusCode: 409 });
      }
      let mergedHtml;
      try {
        mergedHtml = mergeSelectedApplicationPanel(html, storedHtml, documentKind, { expectedToken: token });
      } catch (error) {
        throw Object.assign(new Error(`The application workspace could not be merged safely: ${error?.message || error}`), { statusCode: 400 });
      }
      updateSyncAttempt(attemptId, { phase: 'rendering PDF' });
      // The renderer has no filesystem authority. It can only ask us to render one
      // of these two named documents, and `renderPdf` uses a no-preload window.
      const rendered = await renderPdf(mergedHtml, { document: documentKind });
      if (rendered.fontsLoaded === false) {
        // Name the faces, not a cause. The predicate reports which faces the
        // render window could not resolve; it cannot tell a network failure
        // from a face the document asks for and the ATS-safe PDF substitution
        // does not cover, and "reconnect to the internet" sent the user after
        // the wrong thing when it was the latter.
        const faces = (Array.isArray(rendered.missingFontFaces) ? rendered.missingFontFaces : []).filter(Boolean);
        throw Object.assign(
          new Error(
            'The render window could not resolve the application fonts'
            + `${faces.length ? ` (${faces.join(', ')})` : ''}. `
            + 'Retry Sync so the existing PDF is not replaced with fallback typography.',
          ),
          { statusCode: 503 },
        );
      }
      let pdf = rendered.bytes;
      // Read the variant back out of the very document we just rendered, so the
      // OCG decision is made from the same attributes the CSS itself cascaded from
      // (the root `<html>` element — see extractVariantAttrs). A synced PDF must be
      // indistinguishable from the one the generate path wrote beside it; applying
      // the cream layer to a variant that already paints its own opaque background
      // produces a page that is neither.
      if (isDualMode(extractVariantAttrs(mergedHtml))) pdf = await applyDualPdf(pdf);
      // Persist the exact source/PDF pair that produced this revision. The
      // load-time reconciliation path uses these hashes to distinguish a
      // one-sided external PDF edit (safe to import) from simultaneous HTML
      // and PDF edits (a conflict that must not be resolved silently).
      mergedHtml = withApplicationDocumentRevision(mergedHtml, documentKind, pdf, token);
      const pdfPath = documentKind === 'cover' ? workspace.coverLetterPdfPath : workspace.resumePdfPath;
      try {
        await captureOrVerifyWorkspaceIdentity(workspace);
        await assertWorkspaceHtmlUnchanged(workspace, storedHtml);
      } catch (error) {
        throw Object.assign(new Error(`The registered application workspace changed before Sync could write: ${error?.message || error}`), { statusCode: 409 });
      }
      // HTML and its derived PDF are one logical revision. A failure promoting
      // either file restores both prior versions, so Sync cannot leave a new
      // editable document paired with an old employer-facing PDF.
      updateSyncAttempt(attemptId, { phase: 'writing and verifying revision' });
      const manifest = await replaceApplicationBundleAtomically([
        // The transaction rechecks this snapshot after moving the old HTML to
        // its rollback backup. That closes the final gap after the pre-render
        // guard above: an external editor save cannot be backed up and then
        // deleted while this older render is promoted.
        { destination: workspace.applicationPath, data: mergedHtml, expectedCurrentData: storedHtml },
        { destination: pdfPath, data: pdf },
      ], {
        verify: () => inspectApplicationSyncRevision({
          applicationPath: workspace.applicationPath,
          pdfPath,
          html: mergedHtml,
          pdf,
          token,
        }),
      });
      updateSyncAttempt(attemptId, {
        status: 'completed', phase: 'completed', finishedAt: Date.now(), manifest,
      });
      logger.info(`[ApplicationSync] Synced ${documentKind} and verified destination revision in ${workspace.workspaceDir}`);
      return {
        document: documentKind,
        pdfPath,
        // The browser binds its autosave to this saved panel revision. Returning
        // it prevents an older same-generation draft from masking the exact
        // HTML/PDF pair this transaction just verified.
        htmlSha256: applicationPanelSha256(mergedHtml, documentKind),
      };
    });
  } catch (error) {
    updateSyncAttempt(attemptId, {
      status: 'failed', failedAt: Date.now(),
      error: String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 500),
      ...(Array.isArray(error?.syncManifest) ? { manifest: error.syncManifest } : {}),
    });
    throw error;
  }
}

export function applicationSyncConfig(token, { html = '', resumePdf = null, coverPdf = null } = {}) {
  const documentRevision = (documentKind, pdf) => ({
    pdfSha256: pdf == null ? '' : sha256(Buffer.from(pdf)),
    htmlSha256: html ? applicationPanelSha256(html, documentKind) : '',
  });
  return {
    endpoint: `http://127.0.0.1:${APPLICATION_SYNC_PORT}${APPLICATION_SYNC_PATH}`,
    token,
    version: 2,
    documents: {
      resume: documentRevision('resume', resumePdf),
      cover: documentRevision('cover', coverPdf),
    },
  };
}

export function applicationSyncStatusSnapshot() {
  return {
    serverListening: Boolean(server?.listening),
    serverStarting: Boolean(server && !server.listening),
    endpoint: `http://127.0.0.1:${APPLICATION_SYNC_PORT}${APPLICATION_SYNC_PATH}`,
    lastError: lastServerError,
  };
}

export async function registerApplicationSyncWorkspace(workspaceDir, requestedToken = '') {
  await loadWorkspaces();
  if (!workspaceDir || typeof workspaceDir !== 'string') throw new Error('A workspace directory is required for application sync.');
  const normalizedDir = path.resolve(workspaceDir);
  if (!normalizedDir || !path.isAbsolute(normalizedDir)) throw new Error('A workspace directory is required for application sync.');
  const token = requestedToken && /^[a-f0-9]{64}$/i.test(requestedToken)
    ? requestedToken
    : crypto.randomBytes(32).toString('hex');
  const normalized = normalizeWorkspace({ token, workspaceDir: normalizedDir });
  const workspace = await captureOrVerifyWorkspaceIdentity(normalized);
  const previous = [...workspaces.entries()].filter(([, existing]) => canonicalPathKey(existing.workspaceDir) === canonicalPathKey(normalizedDir));
  // Regenerating the same application replaces its on-disk workspace, so an
  // older copied HTML must not retain authority to overwrite the new version.
  for (const [existingToken, existing] of workspaces) {
    if (canonicalPathKey(existing.workspaceDir) === canonicalPathKey(normalizedDir)) workspaces.delete(existingToken);
  }
  workspaces.set(token, workspace);
  try {
    await persistWorkspacesSerialized();
  } catch (error) {
    workspaces.delete(token);
    for (const [previousToken, previousWorkspace] of previous) workspaces.set(previousToken, previousWorkspace);
    throw error;
  }
  return applicationSyncConfig(token);
}

export async function startApplicationSyncServer() {
  await loadWorkspaces();
  if (server) return true;
  server = http.createServer(async (request, response) => {
    const origin = String(request.headers.origin || '');
    const url = new URL(request.url || '/', `http://127.0.0.1:${APPLICATION_SYNC_PORT}`);
    if (url.pathname !== APPLICATION_SYNC_PATH) return sendJson(response, 404, { success: false, error: 'Not found.' }, origin);
    if (request.method === 'OPTIONS') return sendJson(response, 204, {}, origin);
    if (request.method !== 'POST' || (origin && origin !== 'null' && origin !== 'file://')) return sendJson(response, 403, { success: false, error: 'Sync requests must come from a saved local application file.' }, origin);
    try {
      const payload = await readJson(request);
      const result = payload?.action === 'reconcile'
        ? await reconcileWorkspacePdfs(payload)
        : await syncWorkspace(payload);
      sendJson(response, 200, { success: true, ...result }, origin);
    } catch (error) {
      logger.warn(`[ApplicationSync] Sync failed: ${error?.message || error}`);
      sendJson(response, error?.statusCode || 500, { success: false, error: error?.message || 'Could not sync this application.' }, origin);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(APPLICATION_SYNC_PORT, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    server = null;
    lastServerError = String(error?.message || error).replace(/[\r\n\t]+/g, ' ').slice(0, 500);
    logger.warn(`[ApplicationSync] Could not start sync service on 127.0.0.1:${APPLICATION_SYNC_PORT}: ${lastServerError}`);
    return false;
  }
  lastServerError = null;
  logger.info(`[ApplicationSync] Listening on 127.0.0.1:${APPLICATION_SYNC_PORT}`);
  return true;
}

export async function stopApplicationSyncServer() {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise(resolve => current.close(resolve));
}

// Test seams: deterministic suites do not bind a port, but can verify that
// persisted capabilities reconstruct only their canonical sibling paths.
export function __normaliseApplicationSyncWorkspaceForTests(raw) { return normalizeWorkspace(raw); }
export async function __captureApplicationSyncWorkspaceIdentityForTests(raw) {
  const workspace = normalizeWorkspace(raw);
  if (!workspace) throw new Error('Invalid test workspace.');
  return captureOrVerifyWorkspaceIdentity(workspace);
}
export async function __verifyApplicationSyncWorkspaceIdentityForTests(workspace) {
  return captureOrVerifyWorkspaceIdentity(workspace);
}
export async function __readApplicationSyncWorkspaceHtmlForTests(workspace) {
  return readRegisteredWorkspaceHtml(workspace);
}
export async function __assertApplicationSyncWorkspaceSnapshotForTests(workspace, expectedHtml) {
  return assertWorkspaceHtmlUnchanged(workspace, expectedHtml);
}
export function __applicationPanelSha256ForTests(html, documentKind) {
  return applicationPanelSha256(html, documentKind);
}
export async function __reconcileApplicationSyncWorkspaceForTests(payload) {
  return reconcileWorkspacePdfs(payload);
}
export async function __syncApplicationSyncWorkspaceForTests(payload) {
  return syncWorkspace(payload);
}
export function __withApplicationSyncWorkspaceLockForTests(workspaceDir, fn) { return withApplicationSyncWorkspaceLock(workspaceDir, fn); }
export function __applicationSyncStatePathForTests() { return statePath(); }
export async function __loadApplicationSyncWorkspacesForTests() { return loadWorkspaces(); }
export async function __resetApplicationSyncWorkspacesForTests() {
  await persistenceQueue.catch(() => {});
  workspaces.clear();
  workspaceSyncQueues.clear();
  loadPromise = null;
  persistenceQueue = Promise.resolve();
}
