/** Retain the latest unsaved draft until the host confirms its checkpoint. */
export function createDraftWriteBarrier({ write, flush }) {
  const latest = new Map();
  const pending = new Set();
  function attempt(record) {
    const operation = Promise.resolve().then(() => write(record.requestId, record.response)).then(result => {
      if (result?.saved !== true && result?.code !== 'REQUEST_SETTLED') {
        throw new Error('The AI draft has not been saved yet.');
      }
      if (latest.get(record.requestId) === record) latest.delete(record.requestId);
      return result;
    });
    pending.add(operation);
    // Observe failures without losing the payload needed for a lifecycle retry.
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  }
  return {
    write(requestId, response) {
      const record = { requestId, response };
      latest.set(requestId, record);
      return attempt(record);
    },
    async flush() {
      while (pending.size) await Promise.allSettled([...pending]);
      await Promise.allSettled([...latest.values()].map(attempt));
      while (pending.size) await Promise.allSettled([...pending]);
      if (latest.size) throw new Error('Could not save the latest AI draft. Please retry.');
      const result = await flush();
      if (result?.flushed !== true) throw new Error('Could not confirm the AI draft checkpoint.');
      return result;
    },
  };
}
