import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { registerJobsHandlers } from '../electron/ipc/jobs.js';
import { registerMarketplaceHandlers } from '../electron/ipc/marketplace.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function runTests() {
  console.log('\n[TEST RUNNER] Phase 2 — Multi-Source End-to-End Verification\n');
  
  registerJobsHandlers();
  registerMarketplaceHandlers();

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'electron', 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  await win.loadURL('data:text/html,<html><body><h1>Testing Phase 2...</h1></body></html>');

  let passed = 0;
  let failed = 0;

  const runTest = async (name, script) => {
    try {
      console.log(`\n[TEST] Running: ${name}...`);
      const result = await win.webContents.executeJavaScript(`
        (async () => {
          try {
            ${script}
          } catch (e) {
            return { error: e.message || String(e) };
          }
        })()
      `);
      if (result && result.error) throw new Error(result.error);
      console.log(`✅ [PASS] ${name}`);
      passed++;
      return result;
    } catch (e) {
      console.error(`❌ [FAIL] ${name}\n   Error: ${e.message.substring(0, 200)}`);
      failed++;
      return null;
    }
  };

  // ── Jobs Tests ──────────────────────────────────────────────────────────

  // Test 1: Resume Parsing (Gemini)
  const dummyResumePath = path.join(__dirname, 'dummy-resume.txt');
  fs.writeFileSync(dummyResumePath, "Jane Doe\nFrontend Engineer\n5 years experience with React, Node.js, and Electron.\nLocation: San Francisco, CA\nPreviously: UI Developer at Stripe, Software Engineer at Airbnb\nSkills: TypeScript, GraphQL, Next.js, AWS, Figma, Cypress");
  
  const parseRes = await runTest('Gemini Resume Parsing', `
    const res = await window.electronAPI.parseResume({ filePath: ${JSON.stringify(dummyResumePath)} });
    if (!res.success) throw new Error(res.error || 'Failed');
    if (!res.profile?.skills || res.profile.skills.length === 0) throw new Error("No skills extracted");
    return { skills: res.profile.skills.length, titles: res.profile.titles };
  `);
  if (parseRes) console.log('   Stats:', parseRes);

  // Test 2: Multi-Source Job Search (5 sources)
  const jobRes = await runTest('Multi-Source Job Search (5 sources)', `
    const res = await window.electronAPI.searchJobs({ queries: ["React developer remote"] });
    if (!res.success) throw new Error(res.error || 'Failed');
    const sources = {};
    (res.jobs || []).forEach(j => { sources[j.source] = (sources[j.source] || 0) + 1; });
    return { totalJobs: res.jobs.length, sourceCounts: sources, sourceCount: Object.keys(sources).length };
  `);
  if (jobRes) console.log('   Stats:', jobRes);

  // Test 3: Gemini Job Scoring
  const scoreRes = await runTest('Gemini Job Scoring & Clustering', `
    const mockProfile = { titles: ["Frontend Developer"], skills: ["React", "JavaScript", "TypeScript"] };
    const mockJobs = [
      { title: "Senior React Engineer", company: "TestCorp", location: "Remote", snippet: "Looking for a React dev.", source: "google" },
      { title: "Engineering Manager", company: "StartupCo", location: "Remote", snippet: "Lead a team of 5 engineers.", source: "linkedin" },
    ];
    const res = await window.electronAPI.scoreJobs({ jobs: mockJobs, profile: mockProfile });
    if (!res.success) throw new Error(res.error || 'Failed');
    return { clustersCount: Object.keys(res.clusters).length, topScore: res.scoredJobs[0].matchScore };
  `);
  if (scoreRes) console.log('   Stats:', scoreRes);

  // ── Marketplace Tests ───────────────────────────────────────────────────

  // Test 4: Multi-Source Price Research (5 sources)
  const priceRes = await runTest('Multi-Source Price Research (5 sources)', `
    const res = await window.electronAPI.researchPrice({ query: "iPhone 14 Pro 256GB", condition: "Used - Excellent" });
    if (!res.success) throw new Error(res.error || 'Failed');
    const soldCount = res.comps?.sold?.length || 0;
    const activeCount = res.comps?.active?.length || 0;
    const sources = {};
    [...(res.comps?.sold || []), ...(res.comps?.active || [])].forEach(c => { sources[c.source] = (sources[c.source] || 0) + 1; });
    return { soldCount, activeCount, sourceBreakdown: sources, hasPrice: !!res.pricing?.recommended_price, justification: res.pricing?.justification?.substring(0, 100) };
  `);
  if (priceRes) console.log('   Stats:', priceRes);

  // Cleanup
  fs.unlinkSync(dummyResumePath);

  console.log(`\n${'═'.repeat(50)}`);
  console.log(`[TEST RUNNER] Results: ${passed} passed, ${failed} failed`);
  console.log(`${'═'.repeat(50)}\n`);
  app.quit();
}

app.whenReady().then(runTests);
