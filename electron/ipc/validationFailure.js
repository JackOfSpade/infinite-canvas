/**
 * One way to build a validator rejection that tells the answering chat exactly
 * which rule failed.
 *
 * A thrown error may carry `correctionDetails` (short numbered lines shown to
 * the AI) and a parallel `correctionRuleIds` array (code-authored constants the
 * bridge transport uses to count how often the same rule failed). Lines may
 * name only rule ids, unit/entity/segment ids, indices, measured numbers and
 * the AI's own offending value. They must never name an expected string drawn
 * from a career source, posting or listing.
 *
 * This module deliberately has no imports.
 */

export const VALIDATION_DETAIL_LIMIT = 12;
export const VALIDATION_RULE_ID_RE = /^[A-Z][A-Z0-9_]{2,63}$/u;
// The trailing "more problems" line. Never counted as a cause.
export const VALIDATION_SUMMARY_RULE_ID = 'VALIDATION_MORE_PROBLEMS';

function cleanEntries(entries) {
  const cleaned = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const line = typeof entry?.line === 'string' ? entry.line.trim() : '';
    if (!line) continue;
    const ruleId = typeof entry.ruleId === 'string' && VALIDATION_RULE_ID_RE.test(entry.ruleId) ? entry.ruleId : null;
    cleaned.push({ line, ruleId });
  }
  return cleaned;
}

/**
 * Pick at most `limit` correction lines. When there are too many, keep one line
 * of each distinct rule first, then fill in order, and end with a summary line
 * so the AI knows more problems of the listed kinds exist.
 */
export function selectCorrectionDetails(entries, limit = VALIDATION_DETAIL_LIMIT) {
  const cleaned = cleanEntries(entries);
  const max = Number.isInteger(limit) && limit > 0 ? limit : VALIDATION_DETAIL_LIMIT;
  let taken = cleaned;
  let summary = null;
  if (cleaned.length > max) {
    const budget = max - 1;
    const chosen = new Set();
    const seenKeys = new Set();
    for (let index = 0; index < cleaned.length && chosen.size < budget; index += 1) {
      const entry = cleaned[index];
      const key = entry.ruleId || `text:${entry.line}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      chosen.add(index);
    }
    for (let index = 0; index < cleaned.length && chosen.size < budget; index += 1) {
      chosen.add(index);
    }
    taken = [...chosen].sort((a, b) => a - b).map((index) => cleaned[index]);
    const omitted = cleaned.length - budget;
    summary = {
      line: `${omitted} more problem${omitted === 1 ? ' was' : 's were'} found beyond the ones listed; fix every problem of the kinds listed, not only the ones shown.`,
      ruleId: VALIDATION_SUMMARY_RULE_ID,
    };
  }
  const all = summary ? [...taken, summary] : taken;
  return { lines: all.map((entry) => entry.line), ruleIds: all.map((entry) => entry.ruleId) };
}

function applyFailureFields(error, { code, stage, reason, counts, selected, validationDiagnostic }) {
  if (code != null) error.code = code;
  if (selected.lines.length) {
    error.correctionDetails = selected.lines;
    error.correctionRuleIds = selected.ruleIds;
  }
  if (validationDiagnostic != null) error.validationDiagnostic = validationDiagnostic;
  else if (reason) {
    error.validationDiagnostic = { stage, reason, counts: counts || {} };
  }
  return error;
}

/**
 * Build (do not throw) a validation error. Callers write
 * `throw validationFailure({ ... })`.
 */
export function validationFailure({
  error: existingError,
  message,
  details = [],
  ruleIds = [],
  code = 'VALIDATION_FAILED',
  stage = 'domain',
  reason = null,
  counts = null,
  validationDiagnostic = null,
} = {}) {
  const lineList = Array.isArray(details) ? details : [];
  const idList = Array.isArray(ruleIds) ? ruleIds : [];
  const selected = selectCorrectionDetails(lineList.map((line, index) => ({ line, ruleId: idList[index] })));
  const error = existingError instanceof Error ? existingError : new Error(message ?? selected.lines.join(' | '));
  if (message != null) error.message = message;
  return applyFailureFields(error, { code, stage, reason, counts, selected, validationDiagnostic });
}

/**
 * Accumulate several problems and throw them together. The message carries
 * every line (uncapped, for the local dock); the correction details are capped.
 */
export function validationFailureCollector({
  prefix = '',
  separator = ' | ',
  suffix = '',
  code = 'VALIDATION_FAILED',
  stage = 'domain',
  reason = null,
  counts = null,
} = {}) {
  const entries = [];
  const collector = {
    add(ruleId, line) {
      entries.push({ ruleId, line });
    },
    get size() {
      return entries.length;
    },
    toError() {
      const selected = selectCorrectionDetails(entries);
      const message = `${prefix}${entries.map((entry) => entry.line).join(separator)}${suffix}`;
      return applyFailureFields(new Error(message), { code, stage, reason, counts, selected });
    },
    throwIfAny() {
      if (entries.length > 0) throw collector.toError();
    },
  };
  return collector;
}
