/**
 * Searchable "Applied Jobs" folder list for the Interview Helper setup.
 *
 * Applications are written to `Applied Jobs/<Company>/<Location>/<Role>/` next
 * to the saved canvas (see jobApplication.js). The renderer only ever receives
 * opaque tokens: a selection is resolved here, inside main, to a folder that
 * this module itself enumerated, so a renderer can never name an arbitrary path.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const APPLIED_JOBS_DIRECTORY = 'Applied Jobs';
const LISTING_FILE = 'Original Job Listing.md';
const MAX_FOLDERS = 2000;
const MAX_TOKENS_PER_NODE = 4000;
const TOKEN_TTL_MS = 30 * 60_000;
const MAX_LISTING_HEAD_BYTES = 8 * 1024;

const visible = name => typeof name === 'string' && name.length > 0 && !name.startsWith('.');

async function directoryEntries(directory) {
  try { return await fs.promises.readdir(directory, { withFileTypes: true }); }
  catch { return []; }
}

// Symlinked folders could point anywhere; only real directories are listed.
async function realSubdirectories(directory) {
  const entries = await directoryEntries(directory);
  return entries.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && visible(entry.name)).map(entry => entry.name);
}

async function regularFile(filePath) {
  try { const stat = await fs.promises.lstat(filePath); return stat.isFile() && !stat.isSymbolicLink() ? stat : null; }
  catch { return null; }
}

/** The Listing URL written in an application's Original Job Listing.md header, or null. */
export async function applicationFolderJobUrl(folder) {
  const file = path.join(folder, LISTING_FILE);
  if (!await regularFile(file)) return null;
  let handle;
  try {
    handle = await fs.promises.open(file, 'r');
    const buffer = Buffer.alloc(MAX_LISTING_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    // The bundle writer emits `**Official posting:** <url>` and
    // `**Listing URL:** <url>` (optionally ` (closed on Board)`); prefer the official one.
    const official = /^\*\*Official posting:\*\*\s*<?(https?:\/\/[^\s>]+)>?\s*$/mu.exec(head);
    const listing = /^\*\*Listing URL:\*\*\s*<?(https?:\/\/[^\s>]+)>?(?:\s+\(closed on [^)\r\n]{1,40}\))?\s*$/mu.exec(head);
    const match = official || listing;
    return match ? match[1] : null;
  } catch { return null; }
  finally { await handle?.close().catch(() => {}); }
}

/** Enumerate application folders under `root` (depth Company/Location/Role), newest first. */
export async function enumerateApplicationFolders(root) {
  const folders = [];
  for (const company of await realSubdirectories(root)) {
    for (const location of await realSubdirectories(path.join(root, company))) {
      for (const role of await realSubdirectories(path.join(root, company, location))) {
        const folder = path.join(root, company, location, role);
        const listing = await regularFile(path.join(folder, LISTING_FILE));
        if (!listing) continue;
        folders.push({ folder, company, location, role, modifiedAt: listing.mtimeMs });
      }
    }
  }
  // Cap after sorting so the newest applications survive regardless of name.
  return folders.sort((left, right) => right.modifiedAt - left.modifiedAt).slice(0, MAX_FOLDERS);
}

/**
 * Resolve the Applied Jobs root next to a saved canvas file. The canvas path is
 * renderer state, so it is validated like an application export destination:
 * absolute, a regular (non-link) file, and allowed by `assertCanvasPathAllowed`.
 */
export async function appliedJobsRootForCanvas(canvasFilePath, { assertCanvasPathAllowed = () => {} } = {}) {
  if (typeof canvasFilePath !== 'string' || !path.isAbsolute(canvasFilePath) || canvasFilePath.length > 4096) {
    return { root: null, reason: 'canvas-unsaved' };
  }
  assertCanvasPathAllowed(canvasFilePath);
  const stat = await regularFile(canvasFilePath);
  if (!stat) return { root: null, reason: 'canvas-unsaved' };
  const canonical = await fs.promises.realpath(canvasFilePath);
  assertCanvasPathAllowed(canonical);
  const root = path.join(path.dirname(canonical), APPLIED_JOBS_DIRECTORY);
  try {
    const rootStat = await fs.promises.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { root: null, reason: 'missing-root' };
  } catch { return { root: null, reason: 'missing-root' }; }
  return { root };
}

/** Per-helper token registry: a token resolves only to a folder this process listed recently. */
export function createApplicationFolderRegistry({ now = Date.now } = {}) {
  const byNode = new Map();
  const prune = (tokens, at) => {
    for (const [token, entry] of tokens) if (at - entry.at > TOKEN_TTL_MS) tokens.delete(token);
    while (tokens.size > MAX_TOKENS_PER_NODE) tokens.delete(tokens.keys().next().value);
  };
  return Object.freeze({
    issue(nodeId, folder) {
      const at = now();
      const tokens = byNode.get(nodeId) || new Map();
      byNode.set(nodeId, tokens);
      prune(tokens, at);
      const token = crypto.randomBytes(18).toString('base64url');
      tokens.set(token, { folder, at });
      return token;
    },
    resolve(nodeId, token) {
      const tokens = byNode.get(nodeId);
      if (!tokens || typeof token !== 'string') return null;
      prune(tokens, now());
      return tokens.get(token)?.folder || null;
    },
  });
}

/** IPC-facing listing: labels and tokens only, never filesystem paths. */
export async function listApplicationFolders({ nodeId, canvasFilePath, registry, assertCanvasPathAllowed }) {
  const { root, reason } = await appliedJobsRootForCanvas(canvasFilePath, { assertCanvasPathAllowed });
  if (!root) return { root: null, folders: [], reason };
  const folders = await enumerateApplicationFolders(root);
  return {
    root: APPLIED_JOBS_DIRECTORY,
    folders: folders.map(({ folder, company, location, role, modifiedAt }) => ({
      token: registry.issue(nodeId, folder), company, location, role,
      label: `${company} · ${role}`, modifiedAt,
    })),
  };
}
