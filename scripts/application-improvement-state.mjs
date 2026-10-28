import fs from 'node:fs/promises';
import path from 'node:path';
import { applicationCareerHistory, improvementStatus, resetImprovementCounter } from '../electron/ipc/applicationEditLog.js';
import { readCareerImportHistory } from '../electron/ipc/careerImportLog.js';
import { applyWatchlistReview, watchlistReport } from '../electron/ipc/applicationWatchlist.js';

const [action, flag, root, optionFlag, optionValue, ...extra] = process.argv.slice(2);
const option = { 'career-history': '--pair', 'watch-review': '--file' }[action];
if (!['status', 'reset', 'career-history', 'watch', 'watch-review'].includes(action) || flag !== '--data-root' || !root || !path.isAbsolute(root)
  || extra.length || (optionFlag !== undefined && (optionFlag !== option || !optionValue)) || (action === 'watch-review' && !optionValue)) {
  console.error('Usage: node scripts/application-improvement-state.mjs <status|reset|watch> --data-root <absolute Electron userData path>\n'
    + '       node scripts/application-improvement-state.mjs career-history --data-root <path> [--pair <pair-id>]\n'
    + '       node scripts/application-improvement-state.mjs watch-review --data-root <path> --file <session review JSON>');
  process.exitCode = 2;
} else if (action === 'status') {
  console.log(JSON.stringify(await improvementStatus(root), null, 2));
} else if (action === 'career-history') {
  console.log(JSON.stringify(optionValue ? await applicationCareerHistory({ root, pairId: optionValue }) : await readCareerImportHistory(root), null, 2));
} else if (action === 'watch') {
  console.log(JSON.stringify(await watchlistReport(root), null, 2));
} else if (action === 'watch-review') {
  console.log(JSON.stringify(await applyWatchlistReview(root, JSON.parse(await fs.readFile(optionValue, 'utf8'))), null, 2));
} else {
  await resetImprovementCounter(root);
  console.log(JSON.stringify(await improvementStatus(root), null, 2));
}
