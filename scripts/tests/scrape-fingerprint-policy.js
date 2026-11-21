import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { SCRAPE_FINGERPRINT_POLICY, scrapeBrowserBuildKind, scrapeFingerprintPolicy } from '../../electron/ipc/browser/manualScraper/scrapeBrowser.js';

// Pins the 2026-11-20 ZipRecruiter fix. A live A/B on one IP (20 detail pages
// per arm) drew 7 Cloudflare checks — 3 needing a person — with the stealth
// plugin + navigator mask + detail-tab UA copy, and 0 with a plain launch of the
// same Chrome for Testing build. These tests keep the measured configuration
// from drifting back.
const read = file => fs.readFileSync(path.resolve(file), 'utf8');
const stealthBrowserSource = read('electron/ipc/stealthBrowser.js');
const scrapeBrowserSource = read('electron/ipc/browser/manualScraper/scrapeBrowser.js');
const expandByNavigationSource = read('electron/ipc/browser/manualScraper/expandByNavigation.js');
const manualScraperSource = read('electron/ipc/browser/manualScraper.js');

export default [
  {
    name: 'ZipRecruiter and Indeed scrape with a plain browser fingerprint; unmeasured sources keep the stealth layer',
    run: () => {
      assert.equal(scrapeFingerprintPolicy('ziprecruiter').plain, true);
      assert.equal(scrapeFingerprintPolicy('indeed').plain, true, 'Indeed ships the plain launch its pacing was measured with');
      assert.equal(scrapeFingerprintPolicy('google').plain, true, 'Google: stealth drew the panel 429, plain did not');
      assert.equal(scrapeFingerprintPolicy('glassdoor').plain, true, 'Glassdoor: stealth drew a Cloudflare check on job pages, plain did not');
      for (const sourceId of ['linkedin', 'dice', 'unknown-source']) {
        assert.equal(scrapeFingerprintPolicy(sourceId).plain, false, `${sourceId} must not change fingerprint without its own measurement`);
      }
      assert(Object.isFrozen(SCRAPE_FINGERPRINT_POLICY) && Object.isFrozen(SCRAPE_FINGERPRINT_POLICY.ziprecruiter),
        'the measured policy must not be mutable at runtime');
    },
  },
  {
    name: 'the per-platform launch applies the policy to both the launcher and the list-tab mask',
    run: () => {
      assert.match(manualScraperSource, /launchScrapePlatformBrowser\(\{[\s\S]{0,200}fingerprint:\s*scrapeFingerprintPolicy\(sourceId\)/,
        'the source loop must pass each source its own fingerprint policy');
      const launcher = scrapeBrowserSource.slice(scrapeBrowserSource.indexOf('export async function launchScrapePlatformBrowser'));
      assert.match(launcher, /plainAutomation:\s*plainFingerprint/, 'a plain source must launch without the stealth plugin');
      assert.match(launcher, /if \(!plainFingerprint\) await applyStealthMask\(page\)/, 'a plain source must not get the navigator mask');
    },
  },
  {
    name: 'plainAutomation launches through puppeteer-core and never reaches puppeteer-extra',
    run: () => {
      assert.match(stealthBrowserSource, /import puppeteerCore from 'puppeteer-core';/);
      assert.match(stealthBrowserSource, /plainAutomation = false, \.\.\.launchOptions \} = launchOpts/,
        'plainAutomation must be stripped from the options Chrome receives');
      assert.match(stealthBrowserSource, /const rawLaunch = plainAutomation\s*\?\s*puppeteerCore\.launch\(/,
        'a plain launch must bypass the stealth plugin');
    },
  },
  {
    name: 'the detail tab never copies the UA string (that drops User-Agent Client Hints)',
    run: () => {
      assert.doesNotMatch(expandByNavigationSource, /\w\.setUserAgent\(/,
        'setUserAgent(ua) without metadata strips sec-ch-ua headers and userAgentData brands');
      assert.match(expandByNavigationSource, /if \(!scrapeFingerprintPolicy\(sourceId\)\.plain\) await applyStealthMask\(nextPage\)/,
        'the detail tab must share the list tab fingerprint');
      assert.doesNotMatch(expandByNavigationSource, /defineProperty\(navigator, 'hardwareConcurrency'/,
        'the detail tab must not carry its own copy of the navigator mask');
    },
  },
  {
    name: 'the bug report names the scrape build and fingerprint mode without the executable path',
    run: () => {
      assert.equal(scrapeBrowserBuildKind('/Users/x/Library/Caches/ms-playwright/chromium-1217/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'), 'chrome-for-testing');
      assert.equal(scrapeBrowserBuildKind('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'google-chrome');
      assert.equal(scrapeBrowserBuildKind('/Applications/Chromium.app/Contents/MacOS/Chromium'), 'chromium');
      assert.equal(scrapeBrowserBuildKind(''), 'unknown');
      assert.match(scrapeBrowserSource, /fingerprint: plainFingerprint \? 'plain' : 'stealth'/);
      const jobsSnapshotSource = read('electron/ipc/bugReport/jobsSnapshot.js');
      assert.match(jobsSnapshotSource, /- Build: .*fingerprint: /, 'the Manual-scrape Chrome section prints build and fingerprint');
    },
  },
  {
    name: 'a ZipRecruiter 429 slows the rest of the walk instead of abandoning every remaining description',
    run: async () => {
      const { ZIPRECRUITER_429_RETRIES, ZIPRECRUITER_RATE_LIMITED_GAP_MS, zipRecruiterDetailGapMs } = await import('../../electron/ipc/browser/manualScraper/detailParsing.js');
      assert.equal(zipRecruiterDetailGapMs(5), 2500, 'solved checks never stretch the base gap');
      assert(ZIPRECRUITER_429_RETRIES >= 3, 'several waits before giving up on the source');
      assert(ZIPRECRUITER_RATE_LIMITED_GAP_MS >= 6000, 'the slowed gap matches the ~9s/page cadence that measured clean');
      assert.match(expandByNavigationSource, /Math\.max\(zipRecruiterDetailGapMs\(solvedDetailChallenges\), rateLimitedGapMs\)/);
      assert.match(expandByNavigationSource, /rateLimitedGapMs = Math\.max\(rateLimitedGapMs, ZIPRECRUITER_RATE_LIMITED_GAP_MS\)/);
      assert.match(expandByNavigationSource, /detailPacing\.rateLimitedGapMs = rateLimitedGapMs;/,
        'the slower gap carries across list pages and queries of the same source');
    },
  },
  {
    name: 'Indeed runs at the measured quarter pacing and launches through the per-source policy',
    run: () => {
      const indeedSource = read('electron/extractors/indeedBrowser.js');
      assert.match(indeedSource, /const INDEED_PACING_SCALE = 0\.25;/);
      assert.equal((indeedSource.match(/indeedPacingScale\(\)/g) || []).length, 5,
        'dwell, card gap, page delay and query delay all use the one scale (plus its definition)');
      assert.equal((indeedSource.match(/plainAutomation: scrapeFingerprintPolicy\('indeed'\)\.plain/g) || []).length, 2,
        'both the scrape and the description-retry launch follow the policy');
    },
  },
];
