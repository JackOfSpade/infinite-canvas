/**
 * App-global, permanent aggregation of high-value skills surfaced while
 * tailoring resumes. This is intentionally separate from canvas/job history:
 * it answers a long-term learning-prioritization question across applications
 * and must never be pruned when a canvas is removed or a job gets old.
 *
 * The store is deliberately sync and atomic, following appliedJobs.js. A
 * record operation has no await between read and write, and temp-file rename
 * means a crash cannot replace a good histogram with truncated JSON. Unlike a
 * preferences cache, a corrupt file is a loud error: silently starting over
 * would erase the user’s accumulated evidence of skill demand.
 */
import electronPkg from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  createEmptySkillOpportunityHistogram,
  assertValidSkillOpportunityHistogram,
  migrateSkillOpportunityHistogram,
  replaceSkillOpportunityAnalysis,
} from '../../src/utils/skillOpportunityHistogram.js';

const { app } = electronPkg;
const FILE_NAME = 'skill-opportunity-histogram.json';

export function skillOpportunityHistogramFilePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function fileSignatureSync(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return {
      exists: true,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false };
    throw new Error(`Skill-opportunity histogram at ${filePath} could not be statted: ${error.message}`);
  }
}

function sameFileSignature(a, b) {
  return !!a && !!b
    && a.exists === b.exists
    && (!a.exists || (a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs));
}

function readHistogramSync(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return createEmptySkillOpportunityHistogram();
    throw new Error(`Skill-opportunity histogram at ${filePath} could not be read: ${error.message}`);
  }
  let histogram;
  try {
    histogram = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Skill-opportunity histogram at ${filePath} is corrupt (${error.message}). Fix or remove it by hand — it will not be reset automatically.`);
  }
  try {
    return histogram?.version === 1
      ? migrateSkillOpportunityHistogram(histogram)
      : assertValidSkillOpportunityHistogram(histogram);
  } catch (error) {
    throw new Error(`Skill-opportunity histogram at ${filePath} is corrupt (${error.message}). Fix or remove it by hand — it will not be reset automatically.`);
  }
}

function readSnapshotSync(filePath) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = fileSignatureSync(filePath);
    const histogram = readHistogramSync(filePath);
    const after = fileSignatureSync(filePath);
    if (sameFileSignature(before, after)) return { histogram, signature: after };
  }
  throw new Error(`Skill-opportunity histogram at ${filePath} changed repeatedly while being read. Finish the external edit and retry.`);
}

function writeHistogramAtomic(filePath, histogram) {
  const content = `${JSON.stringify(histogram, null, 2)}\n`;
  let tmpPath = '';
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmpPath = `${filePath}.__ic_atomic_${randomUUID()}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    // A failed write must not leave our own temp files accumulating forever;
    // never touch the existing final file, whose old good revision is intact.
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup only */ }
    }
    throw new Error(`Skill-opportunity histogram at ${filePath} could not be written: ${error.message}`);
  }
  return fileSignatureSync(filePath);
}

let cache = null;

/** Loads the current durable histogram, observing deliberate hand edits. */
export function loadSkillOpportunityHistogram() {
  const filePath = skillOpportunityHistogramFilePath();
  const signature = fileSignatureSync(filePath);
  if (!cache || cache.path !== filePath || !sameFileSignature(cache.signature, signature)) {
    const snapshot = readSnapshotSync(filePath);
    cache = { histogram: snapshot.histogram, path: filePath, signature: snapshot.signature };
  }
  return cache.histogram;
}

/**
 * Atomically records the latest completed AI analysis for one stable job-card
 * source. A retry replaces that card's earlier contribution; a stale attempt
 * cannot overwrite a later-started generation which finished first.
 */
export function recordSkillOpportunityAnalysis(sourceKey, analysis, options = {}) {
  const current = loadSkillOpportunityHistogram();
  const next = replaceSkillOpportunityAnalysis(current, sourceKey, analysis, options);
  if (next === current) return current;
  const filePath = skillOpportunityHistogramFilePath();
  const signature = writeHistogramAtomic(filePath, next);
  cache = { histogram: next, path: filePath, signature };
  return next;
}

/** Test-only escape hatch for swapping app.getPath('userData') between cases. */
export function __resetSkillOpportunityHistogramCacheForTests() {
  cache = null;
}
