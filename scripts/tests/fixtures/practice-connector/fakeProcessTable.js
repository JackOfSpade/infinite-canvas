export function createFakeProcessTable({ parentPid = 1000 } = {}) {
  let nextPid = parentPid + 1;
  const rows = new Map();
  const add = (row = {}) => {
    const pid = row.pid || nextPid++;
    const value = {
      pid,
      ppid: row.ppid ?? parentPid,
      pgid: row.pgid ?? pid,
      argv: [...(row.argv || [])],
      alive: row.alive !== false,
      signals: [],
      ignoreSignals: [...(row.ignoreSignals || [])],
      ...row,
    };
    rows.set(pid, value);
    return value;
  };
  const killOne = (pid, signal) => {
    const row = rows.get(pid);
    if (!row || !row.alive) return false;
    row.signals.push(signal);
    if (signal === 'SIGKILL' || !row.ignoreSignals.includes(signal)) row.alive = false;
    return true;
  };
  return Object.freeze({
    add,
    get: pid => rows.get(pid) || null,
    list: () => [...rows.values()].map(row => ({ ...row, argv: [...row.argv], signals: [...row.signals], ignoreSignals: [...row.ignoreSignals] })),
    isAlive: pid => rows.get(pid)?.alive === true,
    kill: (pid, signal = 'SIGTERM') => killOne(pid, signal),
    killGroup: (pgid, signal = 'SIGTERM') => [...rows.values()].filter(row => row.pgid === pgid).map(row => killOne(row.pid, signal)).some(Boolean),
    markExited: pid => { const row = rows.get(pid); if (row) row.alive = false; return row || null; },
    remove: pid => rows.delete(pid),
  });
}
