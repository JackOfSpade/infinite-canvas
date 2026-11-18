// One SHA-256 hex digest of a string or buffer. Strings are hashed as UTF-8.
import { createHash } from 'node:crypto';

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}
