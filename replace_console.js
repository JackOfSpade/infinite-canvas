import fs from 'fs';

const files = [
  'electron/ipc/gemini.js',
  'electron/ipc/ipcUtils.js',
  'electron/ipc/filesystem.js',
  'electron/ipc/accounts.js',
  'electron/ipc/browser/authWindows.js',
  'electron/ipc/browserPool.js',
  'electron/ipc/jobs.js',
  'electron/ipc/browserViewMonitor.js',
  'electron/ipc/marketplace.js',
  'electron/ipc/stealthBrowser.js',
  'electron/extractors/apiExtractors.js'
];

for (const file of files) {
  try {
    let content = fs.readFileSync(file, 'utf8');
    let changed = false;

    if (content.includes('console.log')) {
      content = content.replace(/console\.log/g, 'logger.info');
      changed = true;
    }
    if (content.includes('console.warn')) {
      content = content.replace(/console\.warn/g, 'logger.warn');
      changed = true;
    }
    if (content.includes('console.error')) {
      content = content.replace(/console\.error/g, 'logger.error');
      changed = true;
    }
    
    if (changed) {
      let depth = (file.match(/\//g) || []).length;
      let up = '../'.repeat(depth - 1);
      let importStmt = `import { logger } from '${up}logger.js';\n`;
      if (!content.includes('import { logger }')) {
        content = importStmt + content;
      }
      fs.writeFileSync(file, content);
      console.log(`Updated ${file}`);
    }
  } catch(e) {
    console.error(`Skipping ${file}: ${e.message}`);
  }
}
