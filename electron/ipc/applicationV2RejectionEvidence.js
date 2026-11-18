import path from 'node:path';
import { v2JobDirectoryParts } from './applicationV2JobDirectory.js';

// Saving an application removes .local-ai/jobs/<jobId>. Keep exact rejected
// submissions in the canvas's ignored .local-ai area so run evidence survives.
export function v2RejectionEvidencePaths(jobDir, jobId, filename) {
  const parts = v2JobDirectoryParts(jobDir, jobId);
  if (!parts || !/^revision-[0-9]+-[a-z-]+-[a-f0-9]{64}\.json$/u.test(filename)) {
    throw new Error('Invalid v2 rejection evidence path.');
  }
  return {
    working: path.join(jobDir, 'rejections', filename),
    retained: path.join(parts.localAiDir, 'rejected-handoffs', jobId, filename),
  };
}
