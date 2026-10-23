import path from 'node:path';
import { applicationCareerHistory, improvementStatus, resetImprovementCounter } from '../electron/ipc/applicationEditLog.js';
import { readCareerImportHistory } from '../electron/ipc/careerImportLog.js';

const [action, flag, root, pairFlag, pairId, ...extra] = process.argv.slice(2);
if (!['status', 'reset', 'career-history'].includes(action) || flag !== '--data-root' || !root || !path.isAbsolute(root)
  || extra.length || (pairFlag !== undefined && (action !== 'career-history' || pairFlag !== '--pair' || !pairId))) {
  console.error('Usage: node scripts/application-improvement-state.mjs <status|reset|career-history> --data-root <absolute Electron userData path> [--pair <pair-id>]');
  process.exitCode = 2;
} else if (action === 'status') {
  console.log(JSON.stringify(await improvementStatus(root), null, 2));
} else if (action === 'career-history') {
  console.log(JSON.stringify(pairId ? await applicationCareerHistory({ root, pairId }) : await readCareerImportHistory(root), null, 2));
} else {
  await resetImprovementCounter(root);
  console.log(JSON.stringify(await improvementStatus(root), null, 2));
}
