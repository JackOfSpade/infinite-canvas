import crypto from 'node:crypto';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');

/** Random document ids belong to the editor, not the printed content. */
export function applicationV2RenderKey({ html, letter, variantAttrs, trustedRenderedRoleDates, targetPageCount, rendererVersion }) {
  if (typeof rendererVersion !== 'string' || !rendererVersion) return null;
  return hash(JSON.stringify([String(html), letter, variantAttrs, trustedRenderedRoleDates, targetPageCount, rendererVersion]));
}

function clone(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value);
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function verified(phase) {
  return phase?.kind === 'ok' && [phase.resumeFit, phase.letterFit].every(fit =>
    fit?.fontsLoaded === true && fit.pageCount === 1 && fit.bytes instanceof Uint8Array && fit.bytes.byteLength > 0
      && !fit.renderError && !(fit.layoutIssues?.length));
}

/** Private process-local artifacts only; unsuccessful measurements are never retained. */
export function createApplicationV2RenderCache({ maxEntries = 32, maxBytes = 32 * 1024 * 1024 } = {}) {
  const entries = new Map();
  const pending = new Map();
  let bytes = 0;
  let epoch = 0;
  let hits = 0;
  let misses = 0;
  let coalesced = 0;
  const clear = () => { entries.clear(); pending.clear(); bytes = 0; epoch += 1; hits = 0; misses = 0; coalesced = 0; };
  const hit = phase => ({ ...clone(phase), hostRenders: 0, cacheHit: true });
  return {
    clear,
    stats: () => ({ entries: entries.size, bytes, pending: pending.size, hits, misses, coalesced }),
    async getOrRender(key, render) {
      if (!key) return render();
      const found = entries.get(key);
      if (found) {
        entries.delete(key); entries.set(key, found); hits += 1;
        return hit(found.phase);
      }
      if (pending.has(key)) {
        coalesced += 1;
        // A coalesced failure is returned to this caller, but is not cached.
        const phase = await pending.get(key);
        return verified(phase) ? hit(phase) : clone(phase);
      }
      misses += 1;
      const startedEpoch = epoch;
      const work = Promise.resolve().then(render).then(phase => {
        if (verified(phase) && startedEpoch === epoch) {
          const stored = clone(phase);
          const size = stored.resumeFit.bytes.byteLength + stored.letterFit.bytes.byteLength
            + Buffer.byteLength(JSON.stringify({ ...stored, resumeFit: { ...stored.resumeFit, bytes: null }, letterFit: { ...stored.letterFit, bytes: null } }));
          if (maxEntries > 0 && size <= maxBytes) {
            entries.set(key, { phase: stored, size }); bytes += size;
            while (entries.size > maxEntries || bytes > maxBytes) {
              const first = entries.keys().next().value;
              bytes -= entries.get(first).size; entries.delete(first);
            }
          }
        }
        return phase;
      });
      pending.set(key, work);
      try { return await work; }
      finally { if (pending.get(key) === work) pending.delete(key); }
    },
  };
}
