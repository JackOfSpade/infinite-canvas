import { PLATFORM_AUTH_GATED_URLS, assert, getJobLoginPlatforms, getSellMonitorConfig } from '../test-dependencies.js';

// Normalize a URL marker to a comparable fragment: markers are written either as
// a path ('/jobseeker/') or as a host+path ('ziprecruiter.com/jobseeker'), and the
// trailing slash is a style choice, not a signal.
const normalizeMarker = (value) => String(value || '')
  .toLowerCase()
  .replace(/^\/+/, '')
  .replace(/\/+$/, '');

// Two markers are co-satisfiable when a single URL can contain both — i.e. one
// normalized fragment is a substring of the other.
const coSatisfiable = (a, b) => {
  const left = normalizeMarker(a);
  const right = normalizeMarker(b);
  if (!left || !right) return false;
  return left.includes(right) || right.includes(left);
};

export default [
{
    name: 'Auth-gated login markers agree with the verify-side connectedFinalUrlMustContain',
    run: () => {
      // Two independent tables assert what a logged-in URL looks like:
      // PLATFORM_AUTH_GATED_URLS closes the login window the moment the browser
      // lands on its marker, and connectedFinalUrlMustContain rejects any final
      // URL that lacks its marker. When the two disagree, the login window
      // auto-detects "logged in" on a URL the HTTP verify immediately calls
      // logged-OUT — the user gets a window that closes itself and a pill that
      // still says "Log in". Google shipped exactly that pairing
      // (google.com/account/about vs myaccount.google.com).
      const verifyConfigById = new Map(getJobLoginPlatforms().map(p => [p.id, p]));
      const pairs = [];
      for (const [platformId, gatedMarker] of Object.entries(PLATFORM_AUTH_GATED_URLS)) {
        const config = verifyConfigById.get(platformId) || getSellMonitorConfig(platformId);
        const verifyMarker = config?.connectedFinalUrlMustContain;
        // No verify-side marker ⇒ nothing to contradict (the verify falls back to
        // body signals, which the auto-close path does not assert against).
        if (!verifyMarker) continue;
        pairs.push({ platformId, gatedMarker, verifyMarker });
        assert(coSatisfiable(gatedMarker, verifyMarker),
          `${platformId}: auth-gated marker "${gatedMarker}" and verify marker "${verifyMarker}" cannot both hold for one URL — the login window would auto-close on a URL the verify reads as logged out`);
      }
      assert(pairs.some(p => p.platformId === 'ziprecruiter'),
        'ziprecruiter carries both markers and must stay covered by this check');
      // The comparator has teeth: the pairing this test was written for must still
      // be rejected if anyone re-adds it.
      assert(!coSatisfiable('google.com/account/about', 'myaccount.google.com'),
        'the co-satisfiability check must still reject the google.com/account/about vs myaccount.google.com pairing');
      return { pairsChecked: pairs.length };
    },
  },
];
