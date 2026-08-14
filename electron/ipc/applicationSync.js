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
import { renderPdf, applyDualPdf } from './resumeRender.js';
import { extractVariantAttrs, isDualMode } from './resumeHtml.js';
import { logger } from '../logger.js';

const { app } = electronPkg;

// A stable, loopback-only port means a saved HTML document keeps working after
// a normal app restart. The capability token remains the authorization layer.
export const APPLICATION_SYNC_PORT = 43_192;
export const APPLICATION_SYNC_PATH = '/application-sync';
const MAX_HTML_BYTES = 64 * 1024 * 1024;
const STATE_FILE = 'application-sync-workspaces.json';
const workspaces = new Map();
let server = null;
let stateLoaded = false;
let persistenceQueue = Promise.resolve();

function statePath() {
  return path.join(app.getPath('userData'), STATE_FILE);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
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
  return { token, workspaceDir, applicationPath, resumePdfPath, coverLetterPdfPath };
}

async function persistWorkspaces() {
  const payload = JSON.stringify({ version: 1, workspaces: [...workspaces.values()].map(({ token, workspaceDir }) => ({ token, workspaceDir })) }, null, 2);
  const target = statePath();
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${crypto.randomUUID()}.tmp`;
  await fs.promises.writeFile(temporary, payload, { mode: 0o600 });
  await fs.promises.rename(temporary, target);
}

function persistWorkspacesSerialized() {
  // Two Generate clicks can save into separate company folders at the same
  // time. Serialize snapshots/renames so an older write can never win after a
  // newer capability has been registered.
  const write = persistenceQueue.catch(() => {}).then(() => persistWorkspaces());
  persistenceQueue = write;
  return write;
}

async function loadWorkspaces() {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const parsed = JSON.parse(await fs.promises.readFile(statePath(), 'utf8'));
    for (const raw of Array.isArray(parsed?.workspaces) ? parsed.workspaces : []) {
      const workspace = normalizeWorkspace(raw);
      if (workspace) workspaces.set(workspace.token, workspace);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') logger.warn(`[ApplicationSync] Could not read saved workspace capabilities: ${error?.message || error}`);
  }
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

async function syncWorkspace(payload) {
  const token = typeof payload?.token === 'string' ? payload.token : '';
  const workspace = workspaces.get(token);
  if (!workspace || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(workspace?.token || ''.padEnd(64, '0')))) {
    throw Object.assign(new Error('This workspace is not registered with Infinite Canvas. Launch the app and reopen the saved application.'), { statusCode: 403 });
  }
  const documentKind = payload?.document === 'cover' ? 'cover' : payload?.document === 'resume' ? 'resume' : '';
  const html = typeof payload?.html === 'string' ? payload.html : '';
  if (!documentKind || !html.trim() || Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    throw Object.assign(new Error('Sync received an invalid application document.'), { statusCode: 400 });
  }
  // The renderer has no filesystem authority. It can only ask us to render one
  // of these two named documents, and `renderPdf` uses a no-preload window.
  const rendered = await renderPdf(html, { document: documentKind });
  if (rendered.fontsLoaded === false) {
    throw Object.assign(
      new Error('The application fonts are unavailable. Reconnect to the internet and retry Sync so the existing PDF is not replaced with fallback typography.'),
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
  if (isDualMode(extractVariantAttrs(html))) pdf = await applyDualPdf(pdf);
  const pdfPath = documentKind === 'cover' ? workspace.coverLetterPdfPath : workspace.resumePdfPath;
  await fs.promises.mkdir(workspace.workspaceDir, { recursive: true });
  // Each replacement is an atomic same-directory rename. Both output files
  // are fully staged before either visible artifact is changed.
  const htmlTemp = path.join(workspace.workspaceDir, `.Application.html.${crypto.randomUUID()}.tmp`);
  const pdfTemp = path.join(workspace.workspaceDir, `.${path.basename(pdfPath)}.${crypto.randomUUID()}.tmp`);
  try {
    await Promise.all([fs.promises.writeFile(htmlTemp, html, 'utf8'), fs.promises.writeFile(pdfTemp, pdf)]);
    await fs.promises.rename(htmlTemp, workspace.applicationPath);
    await fs.promises.rename(pdfTemp, pdfPath);
  } finally {
    await Promise.all([fs.promises.unlink(htmlTemp).catch(() => {}), fs.promises.unlink(pdfTemp).catch(() => {})]);
  }
  return { document: documentKind, pdfPath };
}

export function applicationSyncConfig(token) {
  return { endpoint: `http://127.0.0.1:${APPLICATION_SYNC_PORT}${APPLICATION_SYNC_PATH}`, token, version: 1 };
}

export async function registerApplicationSyncWorkspace(workspaceDir) {
  await loadWorkspaces();
  if (!workspaceDir || typeof workspaceDir !== 'string') throw new Error('A workspace directory is required for application sync.');
  const normalizedDir = path.resolve(workspaceDir);
  if (!normalizedDir || !path.isAbsolute(normalizedDir)) throw new Error('A workspace directory is required for application sync.');
  // Regenerating the same application replaces its on-disk workspace, so an
  // older copied HTML must not retain authority to overwrite the new version.
  for (const [existingToken, existing] of workspaces) {
    if (existing.workspaceDir === normalizedDir) workspaces.delete(existingToken);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const workspace = normalizeWorkspace({ token, workspaceDir: normalizedDir });
  workspaces.set(token, workspace);
  await persistWorkspacesSerialized();
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
      const result = await syncWorkspace(await readJson(request));
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
    logger.warn(`[ApplicationSync] Could not start sync service on 127.0.0.1:${APPLICATION_SYNC_PORT}: ${error?.message || error}`);
    return false;
  }
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
