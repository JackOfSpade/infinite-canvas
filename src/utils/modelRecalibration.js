// Pure text builders for the model-recalibration banner. No React and no
// Electron here, so the tests can call them directly.

const FOOTER = 'Copy the prompt and paste it into Claude Code in this repository. The banner clears once CALIBRATED_MODELS in electron/ipc/aiModelCalibration.js is updated.';

function detectionsOf(status) {
  return Array.isArray(status?.detections) ? status.detections.filter(detection => detection && typeof detection.modelId === 'string') : [];
}

function capitalize(value) {
  const text = typeof value === 'string' ? value : '';
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : text;
}

export function recalibrationBannerText(status) {
  if (!status?.due) return null;
  const calibratedOn = status.calibratedOn ?? 'an earlier date';
  const lines = detectionsOf(status).map((detection) => {
    if (detection.kind === 'new-family') {
      return `${detection.modelId} is a new model family. Test all its efforts below max on every call it could serve.`;
    }
    const family = capitalize(detection.family);
    return `${detection.modelId} replaced ${detection.calibratedId} (calibrated ${calibratedOn}). Re-check every call on ${family}, and probe ${family} for the calls set above it.`;
  });
  return { headline: 'Model recalibration due', lines, footer: FOOTER };
}

export function recalibrationPrompt(status) {
  if (!status?.due) return null;
  const calibratedOn = status.calibratedOn ?? 'an earlier date';
  const detected = detectionsOf(status).map((detection) => (
    detection.kind === 'new-family'
      ? `- ${detection.modelId} is a new model family`
      : `- ${detection.modelId} replaced ${detection.calibratedId}`
  ));
  return [
    'New Claude model versions were detected, so the app\'s model and effort choices need recalibration.',
    '',
    `Detected (calibrated on ${calibratedOn}):`,
    ...detected,
    '',
    'Do this in the infinite-canvas repository:',
    '1. Read docs/ai-model-selection.md first, especially "Policy", "How to measure" and "New model release playbook", and the table "Which calls a release affects".',
    '2. For each affected family, follow the playbook: a regression check of every call currently on that family at its current setting on the new version; re-check costs; then step down one rung at a time and stop at the first rung that fails (quality for non-live calls, speed for live interview calls). For a cheaper family with a new version, probe its strongest allowed setting on the calls set above it first. For a new family, test all its efforts below max. Never test max effort or Fable.',
    '3. Reuse stored baselines and the existing tools (scripts/claude-effort-ladder.mjs, scripts/ai-task-replay.mjs, scripts/web-research-ab.mjs, scripts/live-bundle-harness.mjs). Use the cheapest test that answers each question: offline replay before live bundles, 4 jobs before 14.',
    '4. Keep every run durable: --out under ~/Library/Application Support/infinite-canvas/ai-test-runs/ (live harness: tmp/claude-e2e/runs/); runs record themselves in docs/ai-test-runs.md; record any hand-made result with node scripts/ai-test-journal.mjs record.',
    '5. Update each call\'s row in docs/ai-model-selection.md, the "Model versions tested" table and the affected-calls table, and apply any setting that changed.',
    '6. When every affected call is done, set CALIBRATED_MODELS in electron/ipc/aiModelCalibration.js to the new model ids and CALIBRATED_ON to today. That clears the recalibration banner. Run npm run test:unit and confirm 0 failed.',
    'Report the cost and number of model calls you spent.',
  ].join('\n');
}
