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

export function getSessionProfile() {
  if (!sessionProfile) {
    sessionProfile = FINGERPRINT_PROFILES[Math.floor(Math.random() * FINGERPRINT_PROFILES.length)];
  }
  return sessionProfile;
}

export function getRandomUA() {
  return getSessionProfile().ua;
}
