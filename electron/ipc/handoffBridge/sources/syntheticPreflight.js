import { createHash, randomUUID } from 'node:crypto';
import { createApplicationSource } from './application.js';

/** Test-mode-only bridge transport probe. It has no application job or canvas. */
export function createSyntheticPreflightSource({ testMode = false, sizes = [140_000, 200_000, 300_000], codeGuard } = {}) {
  if (testMode !== true) throw new Error('Synthetic bridge preflight requires test mode.');
  if (!Array.isArray(sizes) || sizes.length !== 3 || sizes.some(size => !Number.isSafeInteger(size) || size < 1 || size > 500_000))
    throw new Error('Synthetic bridge preflight requires three bounded handoff sizes.');
  const jobId = randomUUID();
  const canvasFilePath = `/tmp/synthetic-bridge-preflight-${jobId}.json`;
  let index = 0;
  const records = sizes.map((size, ordinal) => {
    const body = Array.from({ length: size }, (_, i) => String.fromCharCode(65 + ((i * 7 + ordinal * 13) % 26))).join('');
    const digest = createHash('sha256').update(body).digest('hex');
    const prompt = `SYNTHETIC BRIDGE PREFLIGHT — NO APPLICATION JOB.\nTransport test ${ordinal + 1} of 3. The payload between markers has ${size} characters. Reply with exactly SHA256=${digest} after receiving the entire handoff.\nBEGIN PAYLOAD\n${body}\nEND PAYLOAD\nSHA256=${digest}`;
    return { code: randomUUID(), prompt, digest, size };
  });
  const handoff = () => index < records.length ? {
    handoffCode: records[index].code, stage: 'write', revision: index,
    prompt: records[index].prompt, draft: '', freshContextRequired: true,
    freshContextKey: `synthetic-preflight-${index + 1}`,
  } : null;
  const api = {
    getLocalApplicationHandoff: async () => ({ completed: index >= records.length, handoff: handoff() }),
    submitLocalApplicationHandoff: async ({ handoffCode, response }) => {
      const current = records[index];
      if (!current || handoffCode !== current.code || String(response || '').trim() !== `SHA256=${current.digest}`)
        return { accepted: false, validationErrors: ['Synthetic checksum echo did not match this handoff.'], handoff: handoff() };
      index += 1;
      return { accepted: true, completed: index >= records.length, handoff: handoff() };
    },
    localApplicationStatus: async () => index >= records.length ? { status: 'completed' } : { status: 'queued', stage: 'write' },
    discoverLocalApplicationJobs: async () => [{ id: jobId, canvasFilePath, createdAt: new Date().toISOString(),
      job: { title: 'Synthetic transport preflight — no application job', company: 'Test mode' } }],
  };
  return { source: createApplicationSource({ api, codeGuard }), jobId, canvasFilePath,
    progress: () => ({ completed: index, total: records.length, sizes: records.map(row => row.size) }) };
}
