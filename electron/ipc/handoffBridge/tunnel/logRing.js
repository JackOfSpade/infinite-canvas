import { TUNNEL_CONSTANTS } from './constants.js';

export function createLogRing({ maxLines = TUNNEL_CONSTANTS.LOG_RING_LINES, maxBytes = TUNNEL_CONSTANTS.LOG_RING_BYTES, mirror = null } = {}) {
  const lines = [];
  let bytes = 0;
  return Object.freeze({
    add(line) { const text = String(line).slice(0, 1024); lines.push(text); bytes += Buffer.byteLength(text); while (lines.length > maxLines || bytes > maxBytes) bytes -= Buffer.byteLength(lines.shift()); try { mirror?.(text); } catch { /* mirroring is best effort */ } },
    values() { return [...lines]; },
    clear() { lines.length = 0; bytes = 0; },
    get size() { return bytes; },
  });
}

export function createRotatingLog({ fsImpl, target, maxBytes = 256 * 1024 } = {}) {
  return line => {
    if (!fsImpl || !target) return;
    const text = `${String(line).slice(0, 1024)}\n`;
    try {
      const size = fsImpl.existsSync(target) ? fsImpl.statSync(target).size : 0;
      if (size + Buffer.byteLength(text) > maxBytes) { try { fsImpl.renameSync(target, `${target}.1`); } catch { /* no prior log */ } }
      fsImpl.appendFileSync(target, text, { mode: 0o600 }); fsImpl.chmodSync?.(target, 0o600);
    } catch { /* tunnel output must never crash supervision */ }
  };
}
