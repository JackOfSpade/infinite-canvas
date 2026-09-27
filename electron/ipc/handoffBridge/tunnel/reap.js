import fs from 'node:fs';
import path from 'node:path';
import { execFixed } from './exec.js';
import { parsePsRows, isOwnedTunnelRow } from './psParse.js';

export function signalGroup(pid, signal, { kill = process.kill } = {}) {
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
  try { kill(-pid, signal); return true; } catch { return false; }
}

function remove(fsImpl, target) { try { fsImpl.unlinkSync(target); } catch { /* absent */ } }
function sameIdentity(left, right) { return !!right && left.pid === right.pid && left.pgid === right.pgid && left.lstart === right.lstart && left.command === right.command; }

export async function reapOrphans({ userData, configPath, parentPid = process.pid, fsImpl = fs, exec = execFixed, kill = process.kill, wait = async () => undefined } = {}) {
  const pidfile = path.join(userData, 'handoff-bridge', 'tunnel', 'tunnel.pid.json');
  if (!fsImpl.existsSync(pidfile)) return { ok: true, reaped: 0, notices: [] };
  let intent;
  try {
    const stat = fsImpl.lstatSync?.(pidfile) || fsImpl.statSync?.(pidfile);
    if (stat && (stat.isSymbolicLink?.() || !stat.isFile?.() || stat.size > 16 * 1024)) throw new Error('unsafe intent');
    const raw = fsImpl.readFileSync(pidfile, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 16 * 1024) throw new Error('oversize intent');
    intent = JSON.parse(raw);
    if (!Number.isInteger(intent.pid) || intent.pid <= 1 || !Number.isInteger(intent.pgid) || intent.pgid <= 1
      || typeof intent.lstart !== 'string' || !intent.lstart || intent.lstart.length > 64
      || typeof intent.configPath !== 'string' || intent.configPath !== configPath) throw new Error('invalid intent');
  } catch { remove(fsImpl, pidfile); return { ok: true, reaped: 0, notices: ['stale-pidfile'] }; }
  const rowsFor = args => parsePsRows(exec('ps', args));
  let rows;
  try { rows = rowsFor(['-axww', '-o', 'pid=,ppid=,pgid=,lstart=,command=']); } catch { return { ok: true, reaped: 0, notices: ['ps-failed'] }; }
  const ours = rows.filter(row => isOwnedTunnelRow(row, { configPath, userData }));
  const exactGroup = ours.filter(row => row.pgid === intent.pgid);
  const fallbackGroup = exactGroup.length ? [] : ours.filter(row => row.ppid === parentPid && row.pgid > 1);
  const group = exactGroup.length ? exactGroup : fallbackGroup;
  const groupId = exactGroup.length ? intent.pgid : group[0]?.pgid;
  const tracked = group.find(row => row.pid === intent.pid);
  const notices = [];
  // The wrapper and cloudflared child are both owned members of ONE group,
  // not foreign connectors.  A hand-run connector has no app-owned marker.
  if (ours.some(row => row.pgid !== intent.pgid) || rows.some(row => /(?:^|[\s/])cloudflared\b/.test(row.command) && /\btunnel\b/.test(row.command) && !isOwnedTunnelRow(row, { configPath, userData }))) notices.push('foreign-connector');
  if (!group.length) { remove(fsImpl, pidfile); return { ok: true, reaped: 0, notices: [...notices, 'stale-pidfile'] }; }
  if (tracked && tracked.lstart !== intent.lstart) { remove(fsImpl, pidfile); return { ok: true, reaped: 0, notices: [...notices, 'pid-reused'] }; }
  if (!tracked) notices.push(exactGroup.length ? 'wrapper-missing' : 'untracked-own-child');
  const groupPids = new Set(group.map(row => row.pid));
  if (group.some(row => row.ppid !== 1 && row.ppid !== parentPid && !groupPids.has(row.ppid))) return { ok: true, reaped: 0, notices: [...notices, 'foreign-connector'] };
  // A tracked child of this still-live supervisor is an audit observation.  A
  // group whose wrapper vanished and child was reparented is deliberately
  // reaped by intent.pgid, even though no row has pgid === pid.
  if (tracked && tracked.ppid === parentPid) return { ok: true, reaped: 0, notices: [...notices, 'live-child'] };
  const lookup = row => {
    try { return rowsFor(['-p', String(row.pid), '-o', 'pid=,ppid=,pgid=,lstart=,command=']).find(candidate => candidate.pid === row.pid) || null; }
    catch (error) {
      // macOS ps exits 1 when the selected pid vanished between the scan and
      // identity check.  That is the desired stopped result, not a ps outage.
      return error?.status === 1 || error?.code === 1 ? null : undefined;
    }
  };
  const alive = () => {
    let reused = false;
    for (const row of group) { const current = lookup(row); if (current === undefined) return undefined; if (sameIdentity(row, current)) return true; if (current) reused = true; }
    if (reused) return 'pid-reused';
    return false;
  };
  const before = alive();
  if (before === undefined) return { ok: true, reaped: 0, notices: [...notices, 'ps-failed'] };
  if (before === 'pid-reused') return { ok: true, reaped: 0, notices: [...notices, 'pid-reused'] };
  if (!before) { remove(fsImpl, pidfile); return { ok: true, reaped: 0, notices: [...notices, 'stale-pidfile'] }; }
  signalGroup(groupId, 'SIGTERM', { kill }); await wait(1500);
  let remaining = alive();
  if (remaining === undefined) return { ok: true, reaped: 0, notices: [...notices, 'ps-failed'] };
  if (remaining === 'pid-reused') return { ok: true, reaped: 0, notices: [...notices, 'pid-reused'] };
  if (remaining) { signalGroup(groupId, 'SIGTERM', { kill }); await wait(2500); remaining = alive(); }
  if (remaining === undefined) return { ok: true, reaped: 0, notices: [...notices, 'ps-failed'] };
  if (remaining === 'pid-reused') return { ok: true, reaped: 0, notices: [...notices, 'pid-reused'] };
  if (remaining) { signalGroup(groupId, 'SIGKILL', { kill }); await wait(1500); remaining = alive(); }
  if (remaining === 'pid-reused') return { ok: true, reaped: 0, notices: [...notices, 'pid-reused'] };
  if (remaining) return { ok: true, reaped: 0, notices: [...notices, 'orphan-stuck'] };
  remove(fsImpl, pidfile);
  return { ok: true, reaped: 1, notices: [...notices, 'orphan-stopped'] };
}
