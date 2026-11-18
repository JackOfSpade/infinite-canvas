import fs from 'node:fs';
import path from 'node:path';

// The manual scraper is an entry file plus a folder of cohesive modules. A
// NEGATIVE source assertion (text that must appear nowhere in the scraper) has
// to scan all of them; a positive one reads the single file that holds the text.
const ENTRY = 'electron/ipc/browser/manualScraper.js';
const FOLDER = 'electron/ipc/browser/manualScraper';

export function readManualScraperSources() {
  const files = [ENTRY, ...fs.readdirSync(path.resolve(FOLDER)).filter((f) => f.endsWith('.js')).sort().map((f) => `${FOLDER}/${f}`)];
  return files.map((f) => fs.readFileSync(path.resolve(f), 'utf8')).join('\n');
}
