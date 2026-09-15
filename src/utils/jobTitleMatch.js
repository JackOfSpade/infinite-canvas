/**
 * Boolean/operator syntax advisory for the Job Search role box.
 *
 * This file used to hold a deterministic post-search title gate — tokenize a
 * pinned role (or list of pinned titles) and require every word to appear in
 * the job TITLE, in any order, with prefix matching and a closed
 * tech-vocabulary normalization layer to absorb inflection and spelling
 * variants. That gate, and its Phase A list-of-titles generalization, are
 * both gone: role relevance is now decided by screenJobRolesByTitle
 * (electron/ipc/jobPreferences.js), a title-only AI pass that judges role
 * equivalence semantically and fails open, so none of the token-matching
 * machinery is reachable from production code any more.
 *
 * detectQueryOperators is the one export that survives. It never filtered a
 * job itself — it only flags Boolean/operator syntax the user typed into the
 * role box so the UI can warn that a job board will not honor it — and that
 * job is independent of how (or whether) titles are matched downstream.
 */

/**
 * Boolean/operator syntax a user might type into the target-role box.
 *
 * Operators are unsafe to broadcast: measured across the seven boards, negation
 * is IGNORED and count-increasing on Glassdoor/LinkedIn/ZipRecruiter,
 * DESTRUCTIVE on Google and USAJobs (query → 0 rows), and on ZipRecruiter it
 * INVERTS INTENT — `Controller NOT carpenter NOT superintendent` returned five
 * results, all carpenters and superintendents. The typed text is still sent
 * through unchanged; this only lets the caller surface a non-blocking advisory,
 * because the inversion is otherwise completely invisible in the run report.
 *
 * @param {string} role
 * @returns {string[]} The operator-looking fragments found, for the advisory.
 */
export function detectQueryOperators(role) {
  const text = String(role == null ? '' : role);
  const found = new Set();
  if (/(^|\s)-\S/.test(text)) found.add('-term');
  for (const word of ['NOT', 'AND', 'OR']) {
    if (new RegExp(`(^|\\s)${word}(\\s|$)`).test(text)) found.add(word);
  }
  if (/\b\w+:/.test(text)) found.add('field:');
  if (/"/.test(text)) found.add('"quotes"');
  return [...found];
}
