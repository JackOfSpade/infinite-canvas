import fs from 'fs';
import path from 'path';

const DEFAULT_MAX_DEPTH = 15;
const DEFAULT_MAX_ENTRIES = 20_000;
const RESULT_CACHE_TTL_MS = 10_000;
const RESULT_CACHE_MAX_ENTRIES = 500;

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

function cacheResult(cacheKey, result) {
  resultCache.set(cacheKey, { ts: Date.now(), result });
  if (resultCache.size > RESULT_CACHE_MAX_ENTRIES) {
    resultCache.delete(resultCache.keys().next().value);
  }
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
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
 * Finds an exact filename below a directory. Breadth-first traversal makes the
 * nearest moved file win. Multiple matches at that same depth are ambiguous and
 * intentionally left unresolved rather than silently linking the wrong photo.
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
  let entriesScanned = 0;

  while (queue.length > 0) {
    const levelDepth = queue[0].depth;
    const matches = [];

    while (queue.length > 0 && queue[0].depth === levelDepth) {
      const { dir, depth } = queue.shift();
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        continue;
      }

      entriesScanned += entries.length;
      for (const entry of entries) {
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

      if (entriesScanned >= maxEntries) {
        return { status: 'limit', path: null, root: rootDir, matches, entriesScanned };
      }
    }

    if (matches.length === 1) {
      return { status: 'found', path: matches[0], root: rootDir, matches, entriesScanned };
    }
    if (matches.length > 1) {
      return { status: 'ambiguous', path: null, root: rootDir, matches, entriesScanned };
    }
  }

  return { status: 'not-found', path: null, root: rootDir, matches: [], entriesScanned };
}

/**
 * Resolves a missing preview image by searching below its original parent and
 * any supplied workspace-relative roots. Results are briefly cached so multiple
 * thumbnail/lightbox requests do not repeat the same bounded directory walk.
 */
export function resolveMissingPreviewPath(missingPath, additionalRoots = []) {
  if (typeof missingPath !== 'string' || !path.isAbsolute(missingPath)) {
    return { status: 'not-found', path: null, root: null, matches: [], entriesScanned: 0 };
  }
  if (isFile(missingPath)) {
    return { status: 'existing', path: missingPath, root: path.dirname(missingPath), matches: [missingPath], entriesScanned: 0 };
  }

  const roots = [...new Set([
    path.dirname(missingPath),
    ...additionalRoots,
  ].filter(root => typeof root === 'string' && path.isAbsolute(root)).map(root => path.resolve(root)))]
    .filter(isSearchableDirectory);

  const cacheKey = `${missingPath}\0${roots.join('\0')}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < RESULT_CACHE_TTL_MS) {
    if (!cached.result.path || isFile(cached.result.path)) return { ...cached.result, cached: true };
    resultCache.delete(cacheKey);
  }

  const filename = path.basename(missingPath);
  let entriesScanned = 0;
  for (const root of roots) {
    const result = findExactFilenameBelow(root, filename);
    entriesScanned += result.entriesScanned;
    if (result.status === 'found' || result.status === 'ambiguous' || result.status === 'limit') {
      const combined = { ...result, entriesScanned };
      cacheResult(cacheKey, combined);
      return combined;
    }
  }

  const result = { status: 'not-found', path: null, root: roots.at(-1) || null, matches: [], entriesScanned };
  cacheResult(cacheKey, result);
  return result;
}

export function clearMissingPreviewRelinkCache() {
  resultCache.clear();
}
