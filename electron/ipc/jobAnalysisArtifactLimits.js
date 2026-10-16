// Saved candidate pools can exceed 64 MiB (the reported US snapshot was
// 73 MB). Readers, publication recovery, Save As, and writers share one bound
// so a successfully published snapshot remains usable by every consumer.
export const MAX_JOB_ANALYSIS_ARTIFACT_BYTES = 128 * 1024 * 1024;

export function assertJobAnalysisArtifactSize(serialized) {
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JOB_ANALYSIS_ARTIFACT_BYTES) {
    const error = new Error('Saved job analysis exceeds the 128 MiB recovery limit. The previous saved analysis was preserved.');
    error.code = 'JOB_ANALYSIS_ARTIFACT_TOO_LARGE';
    throw error;
  }
  return serialized;
}
