import path from 'node:path';

/**
 * A working job directory is <canvas>/.local-ai/jobs/<jobId>. Returns the
 * `.local-ai` directory and the canvas root, or null when the directory does
 * not have that shape.
 */
export function v2JobDirectoryParts(jobDir, jobId) {
  const jobsDir = path.dirname(jobDir);
  const localAiDir = path.dirname(jobsDir);
  if (path.basename(jobDir) !== jobId || path.basename(jobsDir) !== 'jobs' || path.basename(localAiDir) !== '.local-ai') return null;
  return { localAiDir, canvasRoot: path.dirname(localAiDir) };
}
