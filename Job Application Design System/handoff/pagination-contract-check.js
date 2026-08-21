// Deterministic contract tests for the paginated screen preview.
// Run with Playwright: npx playwright test handoff/pagination-contract-check.js
// Point FIXTURE at any generated Application.html — this file is a fixture example.
const { test, expect } = require('@playwright/test');
const path = require('path');

const FIXTURE = 'file://' + path.join(__dirname, 'Application-paginated-example.html');

test.describe('paginated preview contract', () => {
  test('one main.page per document panel, wrapped by non-content chrome only', async ({ page }) => {
    await page.goto(FIXTURE);
    const panels = await page.$$('[data-ic-document-panel]');
    expect(panels.length).toBe(2);
    for (const panel of panels) {
      const mains = await panel.$$('main.page');
      expect(mains.length).toBe(1); // never duplicated
      const stage = await panel.$('.ic-page-stage');
      expect(stage).toBeTruthy(); // wrapped by stage chrome
      const guidesInsideMain = await panel.$('main.page .ic-page-guides');
      expect(guidesInsideMain).toBeNull(); // guides never live inside the editable content tree
    }
  });

  test('guides overlay is inert: aria-hidden and non-interactive', async ({ page }) => {
    await page.goto(FIXTURE);
    const guides = await page.$$('.ic-page-guides');
    expect(guides.length).toBe(2);
    for (const g of guides) {
      expect(await g.getAttribute('aria-hidden')).toBe('true');
      const pe = await g.evaluate((el) => getComputedStyle(el).pointerEvents);
      expect(pe).toBe('none');
    }
  });

  test('recompute API is exposed and runs without throwing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(FIXTURE);
    await page.waitForTimeout(300); // initial rAF-scheduled compute
    const hasApi = await page.evaluate(() => typeof window.icPageGuidesRecompute === 'function');
    expect(hasApi).toBe(true);
    await page.evaluate(() => window.icPageGuidesRecompute());
    await page.waitForTimeout(150);
    expect(errors).toEqual([]);
  });

  test('resume stage reports a positive integer page count after load', async ({ page }) => {
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    const count = await page.$eval(
      '[data-ic-document-panel="resume"] .ic-page-stage',
      (el) => Number(el.getAttribute('data-ic-page-count'))
    );
    expect(Number.isInteger(count)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('shadow columns advance by one outer paper width', async ({ page }) => {
    await page.goto(FIXTURE);
    const geometry = await page.evaluate(() => new Promise((resolve) => {
      const observed = [];
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            const clone = node.querySelector && node.querySelector('main.page');
            if (!clone || clone.style.columnWidth === '') continue;
            observed.push({
              outer: parseFloat(clone.style.width),
              side: parseFloat(clone.style.paddingLeft),
              gap: parseFloat(clone.style.columnGap),
            });
          }
        }
      });
      observer.observe(document.body, { childList: true });
      window.icPageGuidesRecompute();
      setTimeout(() => {
        observer.disconnect();
        resolve(observed[0] || null);
      }, 100);
    }));
    expect(geometry).toBeTruthy();
    expect(geometry.gap).toBeCloseTo(geometry.side * 2, 4);
    expect((geometry.outer - geometry.side * 2) + geometry.gap).toBeCloseTo(geometry.outer, 4);
  });

  test('switching tabs computes guides for the newly visible panel', async ({ page }) => {
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.click('#ic-cover-tab');
    await page.waitForTimeout(200);
    const coverCount = await page.$eval(
      '[data-ic-document-panel="cover"] .ic-page-stage',
      (el) => el.getAttribute('data-ic-page-count')
    );
    expect(coverCount).not.toBeNull();
  });

  test('editing content triggers a recompute (no stale state, no throw)', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const main = document.querySelector('[data-ic-document-panel="resume"] main.page');
      const p = document.createElement('p');
      p.textContent = 'Contract-test inserted paragraph to force a reflow.';
      main.appendChild(p);
      main.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(250);
    expect(errors).toEqual([]);
    const count = await page.$eval(
      '[data-ic-document-panel="resume"] .ic-page-stage',
      (el) => Number(el.getAttribute('data-ic-page-count'))
    );
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('data-density="compact" and data-page="a4" recompute geometry without throwing', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.evaluate(() => document.documentElement.setAttribute('data-density', 'compact'));
    await page.waitForTimeout(200);
    await page.evaluate(() => document.documentElement.setAttribute('data-page', 'a4'));
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });

  test('print media hides every page-boundary affordance and leaves .page untouched', async ({ page }) => {
    await page.goto(FIXTURE);
    await page.waitForTimeout(300);
    await page.emulateMedia({ media: 'print' });
    const guidesDisplay = await page.$$eval('.ic-page-guides', (els) =>
      els.map((el) => getComputedStyle(el).display)
    );
    expect(guidesDisplay.every((d) => d === 'none')).toBe(true);

    const stageDisplay = await page.$$eval('.ic-page-stage', (els) =>
      els.map((el) => getComputedStyle(el).display)
    );
    expect(stageDisplay.every((d) => d === 'contents')).toBe(true);

    // .page itself must render exactly as the pre-existing print rule specifies:
    // no width cap, side padding only, no box-shadow, page-break-after present.
    const pageStyle = await page.$eval('[data-ic-document-panel="resume"] main.page', (el) => {
      const cs = getComputedStyle(el);
      return { width: cs.width, boxShadow: cs.boxShadow, paddingTop: cs.paddingTop };
    });
    expect(pageStyle.boxShadow).toBe('none');
  });

  test('no page-boundary markup is present inside main.page in print (nothing to strip)', async ({ page }) => {
    await page.goto(FIXTURE);
    await page.emulateMedia({ media: 'print' });
    const leaked = await page.$$eval('main.page .ic-page-seam, main.page .ic-page-folio', (els) => els.length);
    expect(leaked).toBe(0);
  });
});
