import { getStealthBrowser } from '../electron/ipc/stealthBrowser.js';
import { GOOGLE_JOBS_EXTRACTOR } from '../electron/extractors/jobs.js';
import fs from 'fs';

async function run() {
  const browser = await getStealthBrowser();
  const page = await browser.newPage();
  const url = 'https://www.google.com/search?q=React%20developer%20remote&ibp=htl;jobs';
  console.log('Navigating...');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await new Promise(r => setTimeout(r, 4000));
  await page.screenshot({ path: 'google-jobs.png', fullPage: true });
  const html = await page.content();
  fs.writeFileSync('google-jobs.html', html);
  const result = await page.evaluate(GOOGLE_JOBS_EXTRACTOR);
  console.log('Result length:', result.length);
  await browser.close();
  process.exit(0);
}
run();
