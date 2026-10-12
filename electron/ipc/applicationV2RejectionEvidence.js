import path from 'node:path';

// Saving an application removes .local-ai/jobs/<jobId>. Keep exact rejected
// submissions in the canvas's ignored .local-ai area so run evidence survives.
export function v2RejectionEvidencePaths(jobDir, jobId, filename) {
  if (path.basename(jobDir) !== jobId || path.basename(path.dirname(jobDir)) !== 'jobs'
    || path.basename(path.dirname(path.dirname(jobDir))) !== '.local-ai'
    || !/^revision-[0-9]+-[a-z-]+-[a-f0-9]{64}\.json$/u.test(filename)) {
    throw new Error('Invalid v2 rejection evidence path.');
  }
  return {
    working: path.join(jobDir, 'rejections', filename),
    retained: path.join(path.dirname(path.dirname(jobDir)), 'rejected-handoffs', jobId, filename),
  };
}
