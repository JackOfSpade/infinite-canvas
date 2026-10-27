/**
 * Pre-generation gate for application bundles.
 *
 * When the user keeps hand-fixing the same kind of thing in bundle after
 * bundle, generating another bundle only creates another copy of the defect.
 * Before a job card queues a new application, this asks the AI (through the
 * ordinary manual-AI handoff) whether the edited bundles since the last
 * improvement session show one kind of change recurring in at least
 * GATE_RECURRENCE_MIN of them. If so, generation is refused until a session
 * runs; the session's counter reset clears the stored result.
 *
 * Cost: the check runs at most once per input digest (edited pair ids, save
 * times, note times, last session) and not at all below
 * GATE_MIN_EDITED_BUNDLES. The stored record holds pair ids and the AI's short
 * pattern summaries only, never document text.
 */
import electronPkg from 'electron';
import { APPLICATION_EDIT_RECURRENCE_SCHEMA } from './aiSchemas.js';
import { handleSafe } from './ipcUtils.js';
import { callLLMText } from './llm.js';
import {
  GATE_MIN_EDITED_BUNDLES,
  GATE_RECURRENCE_MIN,
  generationGateInputDigest,
  generationGateInputs,
  writeGenerationGate,
} from './applicationEditLog.js';

const { app } = electronPkg;

export { APPLICATION_EDIT_RECURRENCE_SCHEMA };

export const APPLICATION_EDIT_RECURRENCE_TASK = 'application-edit-recurrence';
export const APPLICATION_GENERATION_GATE_CHANNEL = 'check-application-generation-gate';
const SUMMARY_MAX = 200;

export function buildEditRecurrencePrompt(editedPairs) {
  const lines = [
    'You are reviewing the hand edits a user made to AI-generated job application bundles (a résumé and usually a cover letter).',
    'Each bundle below lists the user\'s own stated reasons for editing (if any) and every changed block, as document / section / block kind / operation, with the text BEFORE and AFTER the edit.',
    '',
    'Task: find patterns where the SAME KIND of change was applied to similar content in DIFFERENT bundles.',
    'Kinds of change to look for include: wording or tone; structure or ordering; length (trimming or expanding); choice of evidence or achievements; truth fixes (correcting a claim that was wrong or overstated); cover letter structure.',
    'Judge similarity of intent, not identical text: two bundles share a pattern when the user made the same sort of correction for the same sort of reason, even if the words differ.',
    'A change made in only one bundle is not a pattern. List every pattern that appears in at least 2 bundles.',
    'For each pattern give:',
    '- summary: one sentence, at most 200 characters, describing the recurring change. Do not include candidate names, employer names, or other identifying details.',
    '- kind: one of truth, evidence, wording, structure, length, letter, other.',
    '- bundles: the bundle numbers (as listed below) where the change appears, each number once.',
    'Return exactly the JSON object described by the response schema: { "version": 1, "patterns": [ { "summary": "...", "kind": "...", "bundles": [1, 2] } ] }.',
    'When nothing recurs in at least 2 bundles, return { "version": 1, "patterns": [] }.',
    '',
  ];
  (editedPairs || []).forEach(({ pair, diffs }, index) => {
    lines.push(`Bundle ${index + 1}`);
    const notes = typeof pair?.editNotes === 'string' && pair.editNotes.trim() ? pair.editNotes.trim() : 'none given';
    lines.push(`User's earlier shared reasons (document unspecified): ${notes}`);
    for (const [document, label] of [['resume', 'Résumé'], ['cover', 'Cover letter']]) {
      lines.push(`${label} edit reasons: ${pair?.editNotesByDocument?.[document]?.trim() || 'none given'}`);
    }
    for (const diff of diffs || []) {
      lines.push(`- ${diff.document} / ${diff.section || '(no section)'} / ${diff.kind} / ${diff.op}`);
      lines.push(`  BEFORE: ${diff.before || '(none)'}`);
      lines.push(`  AFTER: ${diff.after || '(none)'}`);
    }
    lines.push('');
  });
  return lines.join('\n');
}

/** Map bundle numbers to pair ids and decide whether any pattern blocks generation. */
export function interpretEditRecurrence(response, editedPairs, { min = GATE_RECURRENCE_MIN } = {}) {
  const pairs = Array.isArray(editedPairs) ? editedPairs : [];
  const patterns = [];
  for (const item of Array.isArray(response?.patterns) ? response.patterns : []) {
    const ids = [];
    for (const number of Array.isArray(item?.bundles) ? item.bundles : []) {
      if (!Number.isInteger(number) || number < 1 || number > pairs.length) continue;
      const id = pairs[number - 1].pair.id;
      if (!ids.includes(id)) ids.push(id);
    }
    const summary = String(item?.summary || '').trim().slice(0, SUMMARY_MAX);
    if (ids.length < 2 || !summary) continue;
    patterns.push({ summary, kind: typeof item?.kind === 'string' ? item.kind : 'other', bundles: ids });
  }
  return { blocked: patterns.some(pattern => pattern.bundles.length >= min), patterns };
}

const inFlight = new Map();

function fromRecord(record, reason) {
  return {
    blocked: record.blocked,
    checked: true,
    patterns: record.patterns.map(({ summary, kind, bundles }) => ({ summary, kind, count: bundles.length })),
    editedBundleCount: record.editedBundleCount,
    reason,
  };
}

export async function evaluateApplicationGenerationGate({ root, callText, signal, now = () => new Date().toISOString() }) {
  const { state, editedPairs, gate } = await generationGateInputs(root);
  if (editedPairs.length < GATE_MIN_EDITED_BUNDLES) {
    if (gate && gate.lastSessionAt !== (state.lastSessionAt || null)) await writeGenerationGate(root, null);
    return { blocked: false, checked: false, patterns: [], editedBundleCount: editedPairs.length, reason: 'fewer-than-three-edited-bundles' };
  }
  const inputDigest = generationGateInputDigest(state, editedPairs);
  if (gate && gate.inputDigest === inputDigest) return fromRecord(gate, 'cached');
  // Two cards starting at once must not each pay for the same handoff.
  if (inFlight.has(inputDigest)) return inFlight.get(inputDigest);
  const run = (async () => {
    const response = await callText(buildEditRecurrencePrompt(editedPairs), {
      task: APPLICATION_EDIT_RECURRENCE_TASK,
      responseSchema: APPLICATION_EDIT_RECURRENCE_SCHEMA,
      signal,
      hints: { itemCount: editedPairs.length },
    });
    const { blocked, patterns } = interpretEditRecurrence(response, editedPairs);
    const record = await writeGenerationGate(root, {
      version: 1,
      inputDigest,
      checkedAt: now(),
      lastSessionAt: state.lastSessionAt || null,
      blocked,
      patterns,
      editedBundleCount: editedPairs.length,
    });
    return fromRecord(record, 'checked');
  })();
  inFlight.set(inputDigest, run);
  try { return await run; } finally { inFlight.delete(inputDigest); }
}

export function registerApplicationGenerationGateHandlers({ registerHandler = handleSafe, callText = callLLMText, appInstance = app } = {}) {
  registerHandler(APPLICATION_GENERATION_GATE_CHANNEL, async (_event, _args, signal) =>
    evaluateApplicationGenerationGate({ root: appInstance.getPath('userData'), callText, signal }));
}
