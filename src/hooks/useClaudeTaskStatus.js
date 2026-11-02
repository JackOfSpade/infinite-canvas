import { useSyncExternalStore } from 'react';
import { getClaudeTaskStatus, subscribeClaudeTaskStatus, subscribeClaudeTaskStatusPolling } from '../utils/claudeTaskStatusStore.js';

/** The Claude worker's status. `poll` keeps it fresh while mounted, for the pause notice. */
export function useClaudeTaskStatus({ poll = false } = {}) {
  return useSyncExternalStore(poll ? subscribeClaudeTaskStatusPolling : subscribeClaudeTaskStatus, getClaudeTaskStatus, getClaudeTaskStatus);
}
