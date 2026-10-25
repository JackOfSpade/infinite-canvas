import crypto from 'node:crypto';
import { buildCareerSourceCorpus, compileAuditedCareerSnapshot, verbatimCareerTranscriptionAuditReceipt } from '../../electron/ipc/careerSnapshot.js';

/** A complete compiler run with deterministic synthetic responder data and no provider calls. */
export async function compileSyntheticCareerSnapshot(text = 'Synthetic Candidate\n', { sourceName = 'Career.txt', previousCompilation = null } = {}) {
  const sourceFiles = [{ name: sourceName, text, contentHash: crypto.createHash('sha256').update(text).digest('hex'), transcriptionAudit: verbatimCareerTranscriptionAuditReceipt() }];
  const evidence = buildCareerSourceCorpus(sourceFiles).segments.map(segment => segment.id);
  return compileAuditedCareerSnapshot({ sourceFiles, previousCompilation, callText: async (_prompt, options) => {
    const response = options.task === 'career-profile-compile' ? {
      identity: { name: text.split(/\r?\n/u)[0], contacts: [], evidenceSegmentIds: evidence },
      roles: [], achievements: [], projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
      rolePatches: [], projectPatches: [], continuationState: { roles: { mode: 'inherit', ids: [] }, projects: { mode: 'inherit', ids: [] } },
      segmentCoverage: evidence.map(segmentId => ({ segmentId, disposition: 'context', entityIds: ['identity'] })),
    } : { findings: [] };
    options.responseValidator?.(response);
    return response;
  } });
}
