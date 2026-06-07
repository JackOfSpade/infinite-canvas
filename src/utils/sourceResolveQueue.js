export function enqueueUniqueSourceResolve(queue, entry, activeSourceIds = []) {
  const current = Array.isArray(queue) ? queue : [];
  const sourceId = entry?.sourceId;
  if (!sourceId) return { queue: current, status: 'invalid' };

  const active = activeSourceIds instanceof Set ? activeSourceIds : new Set(activeSourceIds);
  if (active.has(sourceId)) return { queue: current, status: 'active' };

  const index = current.findIndex(item => item?.sourceId === sourceId);
  if (index >= 0) {
    return {
      queue: current.map((item, i) => (i === index ? entry : item)),
      status: 'replaced',
    };
  }

  return { queue: [...current, entry], status: 'added' };
}
