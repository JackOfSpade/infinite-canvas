import assert from 'node:assert/strict';
import {
  HARD_BLOCK_RETRY_WAIT_MS,
  canAttemptJobSourceResolve,
  canAutomaticallyResolveJobSourceWarning,
  hardBlockRetryWaitMs,
  isHardBlockSourceWarning,
  isTimedRetrySourceWarning,
  jobSourceWarningAction,
} from '../../src/utils/jobSourceWarningPolicy.js';
import {
  GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE,
  buildPendingGoogleApplyRedirects,
  googleApplyLinksRateLimitedWarning,
} from '../../electron/ipc/browser/manualScraper.js';
import { applyGoogleApplyLinkRetryResults } from '../../electron/ipc/jobs.js';

const NOW = 1_700_000_000_000;
const CODE = 'google-apply-links-rate-limited';

// Google's Apply-on controls point at /goto?url=… until the redirect is
// followed; the destination is what a resolved candidate carries instead.
const gotoHref = destination => `https://www.google.com/goto?url=${encodeURIComponent(destination)}`;
const GOTO_1 = gotoHref('https://boards.example.com/jobs/1');
const GOTO_2 = gotoHref('https://boards.example.com/jobs/2');
const GOTO_3 = gotoHref('https://boards.example.com/jobs/3');
const GOTO_4 = gotoHref('https://boards.example.com/jobs/4');
const GOTO_5 = gotoHref('https://boards.example.com/jobs/5');
const EMPLOYER_1 = 'https://www.indeed.com/viewjob?jk=1';
const EMPLOYER_2 = 'https://www.linkedin.com/jobs/view/2';

const pendingRow = (id, redirects) => ({
  id,
  source: 'google',
  title: `Job ${id}`,
  url: `https://www.google.com/search?q=job+${id}`,
  applySource: 'via Indeed',
  pendingApplyRedirects: redirects,
});

export default [{
  name: 'the rate-limit code and its wait come from one exported constant and the hard-block wait',
  run() {
    assert.equal(GOOGLE_APPLY_LINKS_RATE_LIMITED_CODE, CODE);
    const warning = googleApplyLinksRateLimitedWarning({
      url: 'https://www.google.com/search?q=engineer',
      readLinks: 7,
      capturedLinks: 3,
      pendingRows: 5,
      now: NOW,
    });
    assert.deepEqual(warning, {
      code: 'google-apply-links-rate-limited',
      severity: 'block',
      retryAfterAt: NOW + HARD_BLOCK_RETRY_WAIT_MS,
      url: 'https://www.google.com/search?q=engineer',
      shortLabel: 'Links paused, wait then retry',
      evidence: 'Google stopped the apply-link reader after 7 apply links were read (3 employer links captured); 5 listings have no employer link yet.',
      suggestion: 'Retry re-reads only those links after the wait. Skip keeps them with their Google links.',
    });
    // Singular/absent counts must not read as "1 listings".
    const single = googleApplyLinksRateLimitedWarning({ now: NOW, readLinks: 1, capturedLinks: 1, pendingRows: 1 });
    assert.equal(single.evidence, 'Google stopped the apply-link reader after 1 apply link was read (1 employer link captured); 1 listing has no employer link yet.');
    assert.equal(single.url, null);
    assert.equal(single.retryAfterAt, NOW + HARD_BLOCK_RETRY_WAIT_MS);
    // The card's Skip path: a block-severity warning is a real Skip.
    assert.equal(jobSourceWarningAction(warning), 'skip');
    return { retryAfterAt: warning.retryAfterAt };
  },
},
{
  name: 'pending apply redirects keep only unfollowed /goto hrefs, at most four, with short labels',
  run() {
    const trimmed = buildPendingGoogleApplyRedirects([
      { label: '  Apply\n on   Indeed  ', href: GOTO_1 },
      // Already followed: the destination is the job's url, not a pending link.
      { label: 'Apply on LinkedIn', href: EMPLOYER_2 },
      // A Google route that is not an Apply-on redirect.
      { label: 'Share', href: 'https://www.google.com/search?q=share' },
      { label: '', href: GOTO_2 },
      { label: 'Apply on Zip', href: GOTO_3 },
      { label: 'Apply on Monster', href: GOTO_4 },
      { label: 'Apply on Dice', href: GOTO_5 },
    ]);
    assert.deepEqual(trimmed, [
      { label: 'Apply on Indeed', href: GOTO_1 },
      { label: '', href: GOTO_2 },
      { label: 'Apply on Zip', href: GOTO_3 },
      { label: 'Apply on Monster', href: GOTO_4 },
    ]);
    // A fifth redirect is never parked: the checkpoint rows stay small.
    assert.equal(trimmed.length, 4);
    const longLabel = buildPendingGoogleApplyRedirects([{ label: `Apply on ${'x'.repeat(200)}`, href: GOTO_1 }]);
    assert.deepEqual(longLabel, [{ label: `Apply on ${'x'.repeat(111)}`, href: GOTO_1 }]);
    assert.equal(longLabel[0].label.length, 120);
    // Nothing pending when every candidate was resolved.
    assert.deepEqual(buildPendingGoogleApplyRedirects([{ label: 'Apply on Indeed', href: EMPLOYER_1 }]), []);
    assert.deepEqual(buildPendingGoogleApplyRedirects(null), []);
    return { kept: trimmed.length };
  },
},
{
  name: 'the rate-limited reader joins the hard-block wait, Retry and Solve-all hold without widening the hard-block codes',
  run() {
    assert.equal(isTimedRetrySourceWarning({ code: 'cloudflare-hard-block' }), true);
    assert.equal(isTimedRetrySourceWarning({ code: 'description-detail-hard-block' }), true);
    assert.equal(isTimedRetrySourceWarning({ code: CODE }), true);
    assert.equal(isTimedRetrySourceWarning({ code: 'http-403' }), false);
    assert.equal(isTimedRetrySourceWarning(null), false);
    // The narrower helper keeps its original meaning for its existing callers.
    assert.equal(isHardBlockSourceWarning({ code: CODE }), false);
    assert.equal(isHardBlockSourceWarning({ code: 'cloudflare-hard-block' }), true);

    const warning = { code: CODE, severity: 'block', retryAfterAt: NOW + HARD_BLOCK_RETRY_WAIT_MS };
    assert.equal(hardBlockRetryWaitMs(warning, NOW), HARD_BLOCK_RETRY_WAIT_MS);
    assert.equal(hardBlockRetryWaitMs({ ...warning, retryAfterAt: NOW }, NOW), 0);
    assert.equal(hardBlockRetryWaitMs({ code: CODE, severity: 'block' }, NOW), 0);
    // The card shows the countdown and then an enabled Retry: attemptable but
    // never automatic inside the wait.
    assert.equal(canAttemptJobSourceResolve(warning), true);
    assert.equal(canAttemptJobSourceResolve({ code: CODE, severity: 'block', action: 'none' }), true);
    assert.equal(canAutomaticallyResolveJobSourceWarning(warning, NOW), false);
    assert.equal(canAutomaticallyResolveJobSourceWarning(warning, NOW + HARD_BLOCK_RETRY_WAIT_MS), true);
    return { waitMs: hardBlockRetryWaitMs(warning, NOW) };
  },
},
{
  name: 'retrying every parked redirect fixes each row and leaves unrelated rows alone',
  run() {
    const rows = [
      pendingRow('a', [{ label: 'Apply on Indeed', href: GOTO_1 }]),
      { id: 'b', source: 'google', title: 'Job b', url: 'https://www.google.com/search?q=job+b' },
      pendingRow('c', [{ label: 'Apply on LinkedIn', href: GOTO_2 }]),
    ];
    const resolved = new Map([[GOTO_1, EMPLOYER_1], [GOTO_2, EMPLOYER_2]]);
    const { items, remaining } = applyGoogleApplyLinkRetryResults(rows, { resolvedHrefByHref: resolved });
    assert.equal(remaining, 0);
    assert.deepEqual(items, [
      {
        id: 'a',
        source: 'google',
        title: 'Job a',
        url: EMPLOYER_1,
        applySource: 'via Indeed',
        applyOptions: [{ label: 'Apply on Indeed', href: EMPLOYER_1 }],
      },
      {
        id: 'c',
        source: 'google',
        title: 'Job c',
        url: EMPLOYER_2,
        applySource: 'via Indeed',
        applyOptions: [{ label: 'Apply on LinkedIn', href: EMPLOYER_2 }],
      },
    ]);
    // The parked field is gone, and the untouched row never enters the merge.
    assert.equal(Object.hasOwn(items[0], 'pendingApplyRedirects'), false);
    assert.equal(items.some(item => item.id === 'b'), false);
    return { fixed: items.length };
  },
},
{
  name: 'a second rate limit returns the rows fixed so far and leaves the rest parked',
  run() {
    const rows = [
      pendingRow('a', [{ label: 'Apply on Indeed', href: GOTO_1 }]),
      pendingRow('c', [{ label: 'Apply on LinkedIn', href: GOTO_2 }]),
    ];
    const resolved = new Map([[GOTO_1, EMPLOYER_1]]);
    const { items, remaining } = applyGoogleApplyLinkRetryResults(rows, { resolvedHrefByHref: resolved });
    assert.equal(remaining, 1);
    assert.deepEqual(items, [{
      id: 'a',
      source: 'google',
      title: 'Job a',
      url: EMPLOYER_1,
      applySource: 'via Indeed',
      applyOptions: [{ label: 'Apply on Indeed', href: EMPLOYER_1 }],
    }]);
    // The warning is rebuilt for the remaining rows, so the card restarts its wait.
    const warning = googleApplyLinksRateLimitedWarning({
      url: 'https://www.google.com/search?q=job+a',
      readLinks: 1,
      capturedLinks: items.length,
      pendingRows: remaining,
      now: NOW,
    });
    assert.equal(warning.code, CODE);
    assert.equal(warning.retryAfterAt, NOW + HARD_BLOCK_RETRY_WAIT_MS);
    assert.equal(warning.evidence, 'Google stopped the apply-link reader after 1 apply link was read (1 employer link captured); 1 listing has no employer link yet.');
    return { remaining };
  },
},
{
  name: 'rows whose redirects were all unfollowed stay parked and are reported as remaining',
  run() {
    const rows = [pendingRow('a', [{ label: 'Apply on Indeed', href: GOTO_1 }])];
    // A redirect that was never followed keeps its own /goto href, which no
    // Apply-on selector accepts.
    const { items, remaining } = applyGoogleApplyLinkRetryResults(rows, {
      resolvedHrefByHref: new Map([[GOTO_1, GOTO_1]]),
    });
    assert.deepEqual(items, []);
    assert.equal(remaining, 1);
    const { items: missing, remaining: missingRemaining } = applyGoogleApplyLinkRetryResults(rows, {});
    assert.deepEqual(missing, []);
    assert.equal(missingRemaining, 1);
    return { remaining };
  },
},
{
  name: 'a pass with no rate limit releases rows whose followed redirects gave no usable link',
  run() {
    const rows = [pendingRow('a', [{ label: 'Apply on Indeed', href: GOTO_1 }])];
    const { items, remaining } = applyGoogleApplyLinkRetryResults(rows, {
      resolvedHrefByHref: new Map([[GOTO_1, GOTO_1]]),
      attemptedAll: true,
    });
    assert.equal(remaining, 0);
    assert.equal(items.length, 1);
    assert.equal(Object.hasOwn(items[0], 'pendingApplyRedirects'), false);
    assert.equal(items[0].url, rows[0].url);
    return { remaining };
  },
}];
