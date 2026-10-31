import crypto from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
const digest = value => crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function content(record) {
  return digest([record, record.freshContextRequired, record.freshContextKey]);
}

/** Only the same host-created object can be reused; IPC clones have no brand. */
export function createApplicationV2HandoffReuse() {
  const records = new WeakMap();
  return {
    remember(record, binding) {
      records.set(record, { binding: digest(binding), content: content(record) });
      return record;
    },
    match(record, binding) {
      if (!record || typeof record !== 'object') return null;
      const prior = records.get(record);
      try { return prior && prior.binding === digest(binding) && prior.content === content(record) ? record : null; }
      catch { return null; }
    },
  };
}
