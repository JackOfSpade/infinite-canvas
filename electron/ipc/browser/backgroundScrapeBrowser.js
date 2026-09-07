/**
 * Focus-safe headed-browser helpers for background scraping.
 *
 * macOS creates and activates a normal initial Chrome page during launch unless
 * it is explicitly suppressed. Create the scrape target through CDP instead of
 * Browser.newPage(), which can foreground the Chrome window.
 */

export function prepareBackgroundScrapeLaunchOptions(options = {}) {
  if (process.platform !== 'darwin') return options;

  const args = Array.isArray(options.args) ? options.args : [];
  const launchArgs = args.includes('--no-startup-window')
    ? args
    : [...args, '--no-startup-window'];

  // `true` already suppresses every Puppeteer default, including about:blank.
  // Preserve that stronger caller policy instead of turning defaults back on.
  if (options.ignoreDefaultArgs === true) {
    return {
      ...options,
      args: launchArgs,
      waitForInitialPage: false,
    };
  }

  const ignoreDefaultArgs = Array.isArray(options.ignoreDefaultArgs)
    ? options.ignoreDefaultArgs
    : [];
  const ignoredDefaults = ignoreDefaultArgs.includes('about:blank')
    ? ignoreDefaultArgs
    : [...ignoreDefaultArgs, 'about:blank'];

  return {
    ...options,
    args: launchArgs,
    ignoreDefaultArgs: ignoredDefaults,
    waitForInitialPage: false,
  };
}

export async function createBackgroundScrapePage(browser, { width, height } = {}) {
  if (process.platform !== 'darwin') return browser.newPage();

  const cdp = await browser.target().createCDPSession();
  let targetId = null;
  let pageHandedOff = false;
  try {
    const createTargetOptions = {
      url: 'about:blank',
      background: true,
    };

    if ((await browser.pages()).length === 0) {
      createTargetOptions.newWindow = true;
      if (width !== undefined) createTargetOptions.width = width;
      if (height !== undefined) createTargetOptions.height = height;
    }

    ({ targetId } = await cdp.send('Target.createTarget', createTargetOptions));
    let target = browser.targets().find(candidate => candidate._targetId === targetId);
    if (!target) {
      try {
        target = await browser.waitForTarget(candidate => candidate._targetId === targetId, { timeout: 15_000 });
      } catch (error) {
        throw new Error(`Background scrape target ${targetId} was not exposed to Puppeteer within 15 seconds: ${error?.message || String(error)}`);
      }
    }

    const page = await target.page();
    if (!page) {
      throw new Error(`Background scrape target ${targetId} does not expose a Puppeteer Page.`);
    }
    pageHandedOff = true;
    return page;
  } finally {
    if (targetId && !pageHandedOff) {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
    }
    await cdp.detach().catch(() => {});
  }
}
