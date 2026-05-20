/**
 * Anti-Detect User Profiles configuration.
 * Each profile is internally consistent: UA, client hints, platform, viewport,
 * and screen dimensions all match. We pick ONE profile per session and NEVER
 * rotate — switching fingerprints on a persistent session is a detection vector.
 */

export const FINGERPRINT_PROFILES = [
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1920, height: 1080 },
    clientHints: {
      architecture: 'arm',
      bitness: '64',
      brands: [
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '131.0.6778.204' },
        { brand: 'Chromium', version: '131.0.6778.204' },
      ],
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
    },
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1440, height: 900 },
    clientHints: {
      architecture: 'arm',
      bitness: '64',
      brands: [
        { brand: 'Google Chrome', version: '130' },
        { brand: 'Chromium', version: '130' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '130.0.6723.116' },
        { brand: 'Chromium', version: '130.0.6723.116' },
      ],
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
    },
  },
  {
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    platform: 'macOS',
    viewport: { width: 1680, height: 1050 },
    clientHints: {
      architecture: 'arm',
      bitness: '64',
      brands: [
        { brand: 'Google Chrome', version: '131' },
        { brand: 'Chromium', version: '131' },
        { brand: 'Not_A Brand', version: '24' },
      ],
      fullVersionList: [
        { brand: 'Google Chrome', version: '131.0.6778.204' },
        { brand: 'Chromium', version: '131.0.6778.204' },
      ],
      mobile: false,
      model: '',
      platform: 'macOS',
      platformVersion: '14.5.0',
    },
  },
];

let sessionProfile = null;

/**
 * Per-session "behavioral temperament" — multipliers chosen ONCE per session
 * (like the fingerprint) so human-emulation cadence varies run-to-run instead
 * of drawing from an identical distribution every time. A session might be a
 * fast/twitchy operator or a slow/deliberate one; consumers (humanEmulation)
 * scale their pauses/jitter/scroll depth by these.
 */
function generateBehaviorProfile() {
  const rand = (min, max) => min + Math.random() * (max - min);
  return {
    speed:       rand(0.8, 1.3),  // pace of pauses/delays this session (>1 = slower/more deliberate)
    jitter:      rand(0.85, 1.2), // amplitude of movement randomness
    scrollDepth: rand(0.8, 1.25), // how far this "person" scrolls per gesture
  };
}

export function getSessionProfile() {
  if (!sessionProfile) {
    const base = FINGERPRINT_PROFILES[Math.floor(Math.random() * FINGERPRINT_PROFILES.length)];
    // Shallow-copy so the shared FINGERPRINT_PROFILES entries stay pristine.
    sessionProfile = { ...base, behavior: generateBehaviorProfile() };
  }
  return sessionProfile;
}

export function getRandomUA() {
  return getSessionProfile().ua;
}
