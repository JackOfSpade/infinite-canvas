import { useEffect } from 'react';
import { clearJobRunStatus, publishJobRunStatus } from '../utils/jobRunStatusStore';

// entry null means this module has nothing to report. The store ignores a publish
// that changes nothing, so this may run on every render of a busy node.
export function usePublishJobRunStatus(nodeId, entry) {
  useEffect(() => {
    if (!nodeId) return;
    if (entry) publishJobRunStatus(nodeId, entry);
    else clearJobRunStatus(nodeId);
  });
  useEffect(() => () => { if (nodeId) clearJobRunStatus(nodeId); }, [nodeId]);
}
