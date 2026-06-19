import fs from 'fs';
import path from 'path';
import { isWithinDirectory, isExistingFile as isFile } from '../utils/pathSafety.js';

const DEFAULT_MAX_DEPTH = 15;
const DEFAULT_MAX_ENTRIES = 20_000;
const RESULT_CACHE_TTL_MS = 10_000;
const RESULT_CACHE_MAX_ENTRIES = 500;
const SEARCH_ROOT_MAX_ENTRIES = 5_000;
const DIAGNOSTIC_MAX_ENTRIES = 50;

const SKIPPED_DIRECTORY_NAMES = new Set([
  '.git',
  '.ssh',
  '.aws',
  '.config',
  'node_modules',
  'Library',
  'System',
  'Volumes',
]);

const resultCache = new Map();
const searchRootsByPath = new Map();
const diagnostics = [];

function cacheResult(cacheKey, result) {
  resultCache.set(cacheKey, { ts: Date.now(), result });
  if (resultCache.size > RESULT_CACHE_MAX_ENTRIES) {
    resultCache.delete(resultCache.keys().next().value);
  }
}

function recordDiagnostic(entry) {
  diagnostics.push({ ts: Date.now(), ...entry });
  if (diagnostics.length > DIAGNOSTIC_MAX_ENTRIES) diagnostics.shift();
}

function isSearchableDirectory(dirPath) {
  if (!dirPath || !path.isAbsolute(dirPath) || path.parse(dirPath).root === dirPath) return false;
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Associate an image path with its current hierarchy. This is usually recorded
 * while the image exists, so the local-file protocol can reuse the scope after
 * a move when the request only carries the now-broken absolute path.
 */
export function rememberMissingPreviewSearchRoot(filePath, rootDir) {
  if (
    typeof filePath !== 'string'
    || typeof rootDir !== 'string'
    || !path.isAbsolute(filePath)
    || !path.isAbsolute(rootDir)
  ) {
    return false;
  }

  const normalizedPath = path.resolve(filePath);
  const normalizedRoot = path.resolve(rootDir);
  if (!isWithinDirectory(normalizedRoot, normalizedPath)) return false;

  searchRootsByPath.delete(normalizedPath);
  searchRootsByPath.set(normalizedPath, normalizedRoot);
  if (searchRootsByPath.size > SEARCH_ROOT_MAX_ENTRIES) {
    searchRootsByPath.delete(searchRootsByPath.keys().next().value);
  }
  return true;
}

/**
 * Finds an exact filename below a directory. A single match anywhere in the
 * bounded hierarchy is accepted. Multiple matches at any depth are ambiguous
 * and intentionally left unresolved rather than silently linking the wrong
 * photo merely because one duplicate happened to be closer to the root.
 */
export function findExactFilenameBelow(
  rootDir,
  filename,
  { maxDepth = DEFAULT_MAX_DEPTH, maxEntries = DEFAULT_MAX_ENTRIES } = {},
) {
  if (!filename || path.basename(filename) !== filename || !isSearchableDirectory(rootDir)) {
    return { status: 'not-found', path: null, root: rootDir, matches: [], entriesScanned: 0 };
  }

  const queue = [{ dir: path.resolve(rootDir), depth: 0 }];
  const matches = [];
  let entriesScanned = 0;
  let queueIndex = 0;

  while (queueIndex < queue.length) {
    const { dir, depth } = queue[queueIndex];
    queueIndex += 1;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entriesScanned >= maxEntries) {
        return { status: 'limit', path: null, root: rootDir, matches, entriesScanned };
      }
      entriesScanned += 1;

      const candidate = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === filename) matches.push(candidate);
      if (
        entry.isDirectory()
        && depth < maxDepth
        && !SKIPPED_DIRECTORY_NAMES.has(entry.name)
        && !entry.name.endsWith('.tmp')
      ) {
        queue.push({ dir: candidate, depth: depth + 1 });
      }
    }
  }

  if (matches.length === 1) {
    return { status: 'found', path: matches[0], root: rootDir, matches, entriesScanned };
  }
  if (matches.length > 1) {
    return { status: 'ambiguous', path: null, root: rootDir, matches, entriesScanned };
  }
  return { status: 'not-found', path: null, root: rootDir, matches: [], entriesScanned };
}

/**
 * Resolves a missing preview image within exactly one current hierarchy:
 * an explicit caller-provided root, a root remembered while the image existed,
 * or (as a conservative fallback) the missing path's original parent.
 *
 * The search only walks downward from that root. It never climbs to a parent or
 * broadens into a sibling hierarchy. Results are briefly cached so multiple
 * thumbnail/lightbox requests do not repeat the same bounded directory walk.
 */
export function resolveMissingPreviewPath(missingPath, { searchRoot = null } = {}) {
  if (typeof missingPath !== 'string' || !path.isAbsolute(missingPath)) {
    return { status: 'not-found', path: null, root: null, matches: [], entriesScanned: 0 };
  }
  if (isFile(missingPath)) {
    return { status: 'existing', path: missingPath, root: path.dirname(missingPath), matches: [missingPath], entriesScanned: 0 };
  }

  const normalizedPath = path.resolve(missingPath);
  const explicitRoot = typeof searchRoot === 'string' && path.isAbsolute(searchRoot)
    ? path.resolve(searchRoot)
    : null;
  const rememberedRoot = searchRootsByPath.get(normalizedPath) || null;
  const boundedExplicitRoot = explicitRoot && isWithinDirectory(explicitRoot, normalizedPath)
    ? explicitRoot
    : null;
  const boundedRememberedRoot = rememberedRoot && isWithinDirectory(rememberedRoot, normalizedPath)
    ? rememberedRoot
    : null;
  const root = boundedExplicitRoot || boundedRememberedRoot || path.dirname(normalizedPath);
  const rootSource = boundedExplicitRoot ? 'explicit' : boundedRememberedRoot ? 'remembered' : 'original-parent';
  const cacheKey = `${normalizedPath}\0${root}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL_MS) {
    if (!cached.result.path || isFile(cached.result.path)) return { ...cached.result, cached: true };
    resultCache.delete(cacheKey);
  }

  const result = {
    ...findExactFilenameBelow(root, path.basename(normalizedPath)),
    rootSource,
  };
  // A move/copy can briefly leave the destination absent. Do not cache a
  // negative result, so the next thumbnail/lightbox request can recover as
  // soon as a file appears, a duplicate is removed, or a large hierarchy is
  // reduced below the scan limit.
  if (result.status === 'found') cacheResult(cacheKey, result);
  recordDiagnostic({
    missingPath: normalizedPath,
    searchRoot: root,
    rootSource,
    status: result.status,
    resolvedPath: result.path,
    matches: result.matches.length,
    entriesScanned: result.entriesScanned,
  });
  return result;
}

export function clearMissingPreviewRelinkCache() {
  resultCache.clear();
}

export function clearMissingPreviewRelinkDiagnostics() {
  diagnostics.length = 0;
}

export function clearMissingPreviewSearchRoots() {
  searchRootsByPath.clear();
}

export function getMissingPreviewRelinkDiagnostics() {
  return {
    rememberedPathCount: searchRootsByPath.size,
    attempts: diagnostics.map((entry) => ({ ...entry })),
  };
}
