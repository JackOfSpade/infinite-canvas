import puppeteer from 'puppeteer-extra';
import { getStealthBrowser, closeStealthBrowser, getUserDataDir, findChromePath } from '../stealthBrowser.js';

/** Known platform login URLs */
export const PLATFORM_LOGIN_URLS = {
  // Job platforms
  linkedin:      'https://www.linkedin.com/login',
  indeed:        'https://secure.indeed.com/auth',
  glassdoor:     'https://www.glassdoor.com/profile/login_input.htm',
  ziprecruiter:  'https://www.ziprecruiter.com/login',
  dice:          'https://www.dice.com/dashboard/login',
  wellfound:     'https://wellfound.com/login',
  // Marketplace — selling destinations
  ebay:          'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn',
  facebook:      'https://www.facebook.com/login',
  mercari:       'https://www.mercari.com/login/',
  poshmark:      'https://poshmark.com/login',
  depop:         'https://www.depop.com/login/',
  swappa:        'https://swappa.com/login',
  reverb:        'https://reverb.com/login',
  whatnot:       'https://www.whatnot.com/login',
  // Marketplace — pricing data only
  stockx:        'https://stockx.com/login',
};

/** Cookie domains to check per platform */
export const PLATFORM_COOKIE_DOMAINS = {
  // Job platforms
  linkedin:      ['.linkedin.com'],
  indeed:        ['.indeed.com'],
  glassdoor:     ['.glassdoor.com'],
  ziprecruiter:  ['.ziprecruiter.com'],
  dice:          ['.dice.com'],
  wellfound:     ['.wellfound.com'],
  // Marketplace — selling + pricing
  ebay:          ['.ebay.com'],
  facebook:      ['.facebook.com'],
  mercari:       ['.mercari.com'],
  poshmark:      ['.poshmark.com'],
  depop:         ['.depop.com'],
  swappa:        ['.swappa.com'],
  reverb:        ['.reverb.com'],
  whatnot:       ['.whatnot.com'],
  stockx:        ['.stockx.com'],
};

/**
 * Open a VISIBLE browser window for the user to log into a platform.
 * Uses the same persistent userDataDir so cookies are shared with scraping.
 * Returns when the user closes the window.
 * 
 * Hardening: Monitors the IPC sender; if the sender is destroyed (e.g. window closed),
 * the login browser is closed immediately to prevent process leaks.
 */
export async function openLoginWindow(platformId, sender = null) {
  const url = PLATFORM_LOGIN_URLS[platformId];
  if (!url) throw new Error(`Unknown platform: ${platformId}`);

  const executablePath = process.env.CHROME_PATH || await findChromePath();
  console.log(`[StealthBrowser] Opening login window for ${platformId}`);

  // Launch a SEPARATE visible browser for login (shares the same userDataDir)
  const loginBrowser = await puppeteer.launch({
    headless: false,
    executablePath,
    userDataDir: await getUserDataDir(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1100,800',
      '--lang=en-US,en',
    ],
    defaultViewport: null, // Use the window size as viewport
    ignoreHTTPSErrors: true,
  });

  // Close the headless scraping browser — can't share userDataDir simultaneously
  await closeStealthBrowser();

  const pages = await loginBrowser.pages();
  const page = pages[0] || await loginBrowser.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});

  // Wait for the user to close the browser window or the app window to be destroyed
  return new Promise((resolve) => {
    let isTerminated = false;

    const cleanup = async () => {
      if (isTerminated) return;
      isTerminated = true;
      if (sender) sender.removeListener('destroyed', cleanup);
      try {
        await loginBrowser.close();
      } catch { /* ignored */ }
      resolve({ success: true, platform: platformId, closedByApp: sender?.isDestroyed?.() });
    };

    if (sender) {
      if (sender.isDestroyed()) {
        cleanup();
        return;
      }
      sender.once('destroyed', cleanup);
    }

    loginBrowser.on('disconnected', cleanup);
  });
}

/**
 * Check if we have active session cookies for a given platform.
 * Launches a quick headless page, navigates to the site, and checks for auth indicators.
 */
export async function getSessionStatus(platformId) {
  const domains = PLATFORM_COOKIE_DOMAINS[platformId];
  if (!domains) return { platform: platformId, connected: false };

  try {
    const browser = await getStealthBrowser();
    const page = await browser.newPage();

    try {
      // Check cookies for this domain
      const cookies = await page.cookies(...domains.map(d => `https://${d.replace(/^\./, '')}`));

      // Simple heuristic: if there are session/auth cookies, we're logged in
      const hasSession = cookies.some(c =>
        c.name.toLowerCase().includes('session') ||
        c.name.toLowerCase().includes('token') ||
        c.name.toLowerCase().includes('auth') ||
        c.name.toLowerCase().includes('li_at') ||      // LinkedIn
        c.name.toLowerCase().includes('jses') ||        // Indeed  
        c.name.toLowerCase().includes('dp1') ||          // eBay
        c.name.toLowerCase().includes('session-id')      // Amazon
      );

      return {
        platform: platformId,
        connected: hasSession,
        cookieCount: cookies.length,
      };
    } finally {
      if (page && !page.isClosed()) {
        await page.close().catch(() => {});
      }
    }
  } catch {
    return { platform: platformId, connected: false };
  }
}

/**
 * Get connection status for all known platforms.
 */
export async function getAllSessionStatuses() {
  const platforms = Object.keys(PLATFORM_LOGIN_URLS);
  const results = await Promise.all(platforms.map(p => getSessionStatus(p)));
  return results;
}

/**
 * Get the list of supported platforms.
 */
export function getSupportedPlatforms() {
  return Object.keys(PLATFORM_LOGIN_URLS).map(id => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    loginUrl: PLATFORM_LOGIN_URLS[id],
  }));
}
