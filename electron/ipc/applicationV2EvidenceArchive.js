import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// A saved job removes .local-ai/jobs/<id>. This archive is deliberately a
// sibling of jobs, so accepted as well as rejected handoffs survive saving.
export const V2_EVIDENCE_MAX_BYTES = 64 * 1024 * 1024;
export const V2_EVIDENCE_MAX_RECORDS = 256;
const JOB_ID = /^[a-f0-9-]{36}$/iu;
const STAGE = /^[a-z-]+$/u;
const KINDS = new Set(['prompt', 'reply', 'candidate-final']);

export function v2EvidenceArchiveDirectory(jobDir, jobId) {
  if (!JOB_ID.test(jobId) || path.basename(jobDir) !== jobId
    || path.basename(path.dirname(jobDir)) !== 'jobs'
    || path.basename(path.dirname(path.dirname(jobDir))) !== '.local-ai') {
    throw new Error('Invalid application v2 evidence archive path.');
  }
  return path.join(path.dirname(path.dirname(jobDir)), 'evidence-archive', jobId);
}

/** Persist content only. A limit failure blocks the handoff rather than losing evidence. */
export async function archiveV2Content({ jobDir, jobId, stage, revision, kind, candidateId = null, content }) {
  if (!STAGE.test(stage) || !Number.isSafeInteger(revision) || revision < 0 || !KINDS.has(kind)
    || (candidateId !== null && !/^candidate-[1-9][0-9]*$/u.test(candidateId))) {
    throw new Error('Invalid application v2 evidence record.');
  }
  if (!content || typeof content !== 'object'
    || (kind === 'prompt' && typeof content.prompt !== 'string')
    || (kind === 'reply' && typeof content.response !== 'string')
    || (kind === 'candidate-final' && (!content.structured?.resume || !content.structured?.coverLetter))) {
    throw new Error('Application v2 evidence archive accepts only stage content.');
  }
  const directory = v2EvidenceArchiveDirectory(jobDir, jobId);
  const payload = Buffer.from(`${JSON.stringify({ stage, revision, kind, candidateId, content })}\n`, 'utf8');
  if (payload.length > V2_EVIDENCE_MAX_BYTES) throw new Error('Application v2 evidence archive is over its per-job byte cap.');
  for (const part of [path.dirname(path.dirname(directory)), path.dirname(directory), directory]) {
    try { await fs.promises.mkdir(part, { mode: 0o700 }); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const stat = await fs.promises.lstat(part);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Application v2 evidence archive must be a regular directory.');
  }
  const stableContent = kind === 'prompt' ? content.prompt : kind === 'reply' ? content.response : JSON.stringify(content);
  const name = `${String(revision).padStart(5, '0')}-${stage}-${kind}-${crypto.createHash('sha256').update(stableContent).digest('hex')}.json`;
  const target = path.join(directory, name);
  const entries = await fs.promises.readdir(directory, { withFileTypes: true });
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile() || entry.isSymbolicLink() || !/^[0-9]{5}-[a-z-]+-(?:prompt|reply|candidate-final)-[a-f0-9]{64}\.json$/u.test(entry.name)) {
      throw new Error('Application v2 evidence archive contains an unexpected entry.');
    }
    bytes += (await fs.promises.stat(path.join(directory, entry.name))).size;
  }
  if (entries.some(entry => entry.name === name)) {
    let prior;
    try { prior = JSON.parse(await fs.promises.readFile(target, 'utf8')); }
    catch { throw new Error('Application v2 evidence archive contains an unreadable record.'); }
    const priorStable = kind === 'prompt' ? prior?.content?.prompt
      : kind === 'reply' ? prior?.content?.response : JSON.stringify(prior?.content);
    if (prior?.stage !== stage || prior?.revision !== revision || prior?.kind !== kind
      || prior?.candidateId !== candidateId || priorStable !== stableContent) {
      throw new Error('Application v2 evidence archive record changed unexpectedly.');
    }
    return target;
  }
  if (entries.length >= V2_EVIDENCE_MAX_RECORDS || bytes + payload.length > V2_EVIDENCE_MAX_BYTES) {
    throw new Error('Application v2 evidence archive reached its per-job limit.');
  }
  await fs.promises.writeFile(target, payload, { flag: 'wx', mode: 0o600 });
  return target;
}
