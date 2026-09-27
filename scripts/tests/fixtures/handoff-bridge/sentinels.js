import crypto from 'node:crypto';

export const SENTINEL_PREFIX = 'IC_SENTINEL_';
export function sentinel(label = 'value') { return `${SENTINEL_PREFIX}${label}_${crypto.createHash('sha256').update(label).digest('hex').slice(0, 12)}`; }
export function assertNoSentinel(value, label = 'output') {
  if (String(value).includes(SENTINEL_PREFIX)) throw new Error(`${label} contains a sentinel`);
}
