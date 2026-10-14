import path from 'node:path';
import { improvementStatus, resetImprovementCounter } from '../electron/ipc/applicationEditLog.js';

const [action, flag, root] = process.argv.slice(2);
if (!['status', 'reset'].includes(action) || flag !== '--data-root' || !root || !path.isAbsolute(root)) {
  console.error('Usage: node scripts/application-improvement-state.mjs <status|reset> --data-root <absolute Electron userData path>');
  process.exitCode = 2;
} else if (action === 'status') {
  console.log(JSON.stringify(await improvementStatus(root), null, 2));
} else {
  await resetImprovementCounter(root);
  console.log(JSON.stringify(await improvementStatus(root), null, 2));
}
