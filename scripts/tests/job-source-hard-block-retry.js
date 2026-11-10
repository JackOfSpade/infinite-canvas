import assert from 'node:assert/strict';
import {
  HARD_BLOCK_RETRY_WAIT_MS,
  canAttemptJobSourceResolve,
  canAutomaticallyResolveJobSourceWarning,
  hardBlockRetryWaitMs,
  isHardBlockSourceWarning,
} from '../../src/utils/jobSourceWarningPolicy.js';

const NOW = 1_700_000_000_000;
const HARD_BLOCK_CODES = ['cloudflare-hard-block', 'description-detail-hard-block'];
const DESCRIPTION_RECOVERY_CODES = [
  'description-recovery-not-ready',
  'description-recovery-snapshot-stale',
  'description-recovery-snapshot-unavailable',
];

export default [{
  name: 'the hard-block retry wait is exported as fifteen minutes and names only the two hard-block codes',
  run() {
    assert.equal(HARD_BLOCK_RETRY_WAIT_MS, 15 * 60 * 1000);
    assert.equal(HARD_BLOCK_RETRY_WAIT_MS, 900_000);
    assert.equal(isHardBlockSourceWarning({ code: 'cloudflare-hard-block' }), true);
    assert.equal(isHardBlockSourceWarning({ code: 'description-detail-hard-block' }), true);
    assert.equal(isHardBlockSourceWarning({ code: 'http-403' }), false);
    assert.equal(isHardBlockSourceWarning({ code: 'description-recovery-not-ready' }), false);
    assert.equal(isHardBlockSourceWarning(null), false);
    return { waitMs: HARD_BLOCK_RETRY_WAIT_MS };
  },
},
{
  name: 'a hard block is attemptable whether or not it still carries the legacy none action',
  run() {
    for (const code of HARD_BLOCK_CODES) {
      // The scraper keeps `action: 'none'` so nothing drives it unattended.
      assert.equal(canAttemptJobSourceResolve({ code, severity: 'block', action: 'none' }), true);
      // An old persisted warning has no action field at all.
      assert.equal(canAttemptJobSourceResolve({ code, severity: 'block' }), true);
    }
    // Removing the hard-block exclusion must not resurrect the codes that are
    // genuinely state/ownership outcomes rather than browser challenges.
    for (const code of DESCRIPTION_RECOVERY_CODES) {
      assert.equal(canAttemptJobSourceResolve({ code, severity: 'block' }), false);
      assert.equal(canAttemptJobSourceResolve({ code, severity: 'block', action: 'solve' }), false);
    }
    // The `action: 'none'` early return still refuses every other warning.
    assert.equal(canAttemptJobSourceResolve({ code: 'http-403', severity: 'block', action: 'none' }), false);
    assert.equal(canAttemptJobSourceResolve({ code: 'http-403', severity: 'block' }), true);
    return { hardBlocks: HARD_BLOCK_CODES.length, recoveryCodes: DESCRIPTION_RECOVERY_CODES.length };
  },
},
{
  name: 'hardBlockRetryWaitMs counts down from retryAfterAt and treats a missing stamp as already retryable',
  run() {
    const warning = { code: 'cloudflare-hard-block', severity: 'block', action: 'none' };
    assert.equal(hardBlockRetryWaitMs({ ...warning, retryAfterAt: NOW + 900_000 }, NOW), 900_000);
    assert.equal(hardBlockRetryWaitMs({ ...warning, retryAfterAt: NOW + 1 }, NOW), 1);
    // A passed stamp is 0, never a negative wait.
    assert.equal(hardBlockRetryWaitMs({ ...warning, retryAfterAt: NOW - 1 }, NOW), 0);
    assert.equal(hardBlockRetryWaitMs({ ...warning, retryAfterAt: NOW }, NOW), 0);
    // An old persisted hard block has no stamp and may retry at once.
    assert.equal(hardBlockRetryWaitMs(warning, NOW), 0);
    // Malformed stamps are ignored rather than producing NaN.
    assert.equal(hardBlockRetryWaitMs({ ...warning, retryAfterAt: Number.NaN }, NOW), 0);
    assert.equal(hardBlockRetryWaitMs({ ...warning, retryAfterAt: 'soon' }, NOW), 0);
    // A non-hard-block warning never waits, even with a stamp.
    assert.equal(hardBlockRetryWaitMs({ code: 'http-403', severity: 'block', retryAfterAt: NOW + 900_000 }, NOW), 0);
    return { missing: hardBlockRetryWaitMs(warning, NOW) };
  },
},
{
  name: 'Solve all skips a hard block during its wait and picks it up once the wait has passed',
  run() {
    const duringWait = { code: 'description-detail-hard-block', severity: 'block', action: 'none', retryAfterAt: NOW + 900_000 };
    const afterWait = { ...duringWait, retryAfterAt: NOW - 1 };
    const noStamp = { code: 'description-detail-hard-block', severity: 'block', action: 'none' };
    assert.equal(canAutomaticallyResolveJobSourceWarning(duringWait, NOW), false);
    assert.equal(canAutomaticallyResolveJobSourceWarning(duringWait, NOW + 900_000), true);
    assert.equal(canAutomaticallyResolveJobSourceWarning(afterWait, NOW), true);
    assert.equal(canAutomaticallyResolveJobSourceWarning(noStamp, NOW), true);
    // Default `now` is live: a wait that ends one minute from now is still a
    // wait, and the same warning is automatic once the wall clock passes it.
    assert.equal(canAutomaticallyResolveJobSourceWarning({ ...noStamp, retryAfterAt: Date.now() + 60_000 }), false);
    assert.equal(canAutomaticallyResolveJobSourceWarning({ ...noStamp, retryAfterAt: Date.now() - 60_000 }), true);
    // A hard block is still per-card only for the two human-workflow actions,
    // which is unrelated behaviour that must survive the wait-aware change.
    assert.equal(canAutomaticallyResolveJobSourceWarning({ code: 'http-403', severity: 'block', action: 'open-external' }, NOW), false);
    assert.equal(canAttemptJobSourceResolve({ code: 'http-403', severity: 'block', action: 'open-external' }), true);
    return { duringWait: canAutomaticallyResolveJobSourceWarning(duringWait, NOW) };
  },
},
{
  name: 'a non-hard-block warning is unaffected by retryAfterAt',
  run() {
    const challenge = { code: 'http-403', severity: 'block', action: 'solve', retryAfterAt: NOW + 900_000 };
    assert.equal(canAttemptJobSourceResolve(challenge), true);
    assert.equal(hardBlockRetryWaitMs(challenge, NOW), 0);
    assert.equal(canAutomaticallyResolveJobSourceWarning(challenge, NOW), true);
    const recovery = { code: 'description-recovery-snapshot-stale', severity: 'block', action: 'solve' };
    assert.equal(canAutomaticallyResolveJobSourceWarning(recovery, NOW), false);
    return { challengeAutomatic: canAutomaticallyResolveJobSourceWarning(challenge, NOW) };
  },
}];
