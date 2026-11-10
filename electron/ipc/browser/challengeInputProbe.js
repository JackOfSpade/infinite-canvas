// Did a person touch the page while a verification check was open?
//
// The scraper waits on a check with no time limit, and a check can clear in two
// ways: the user solves it, or the site lets the browser through on its own. The
// log used to say only "challenge resolved", so a report could not tell them
// apart. This probe counts real (isTrusted) mouse and key input that reaches the
// page while the check is open, so the log can say what was seen.
//
// What it can and cannot see, stated in every summary it produces:
// - Clicks and keys on the page itself are counted.
// - A click INSIDE the check's own frame (Turnstile, reCAPTCHA) is in another
//   origin's document and never reaches this page. It shows up only as focus
//   moving into a frame, which is counted separately.
// - Mouse movement is counted but never treated as solving anything.
// The site may reload the page while the check is open (a solve usually ends in
// a redirect), which wipes the page's counters; each document gets its own id
// and the counts are summed across documents on the Node side.

// Installs once per document, then returns that document's counts. Pure reads
// and passive listeners: it never changes the page or any event.
export const CHALLENGE_INPUT_PROBE_SOURCE = `(() => {
  const w = window;
  if (!w.__icChallengeInput) {
    const s = { id: Math.random().toString(36).slice(2) + Date.now().toString(36), clicks: 0, keys: 0, moves: 0, frameFocus: 0 };
    w.__icChallengeInput = s;
    const opts = { capture: true, passive: true };
    w.addEventListener('pointerdown', e => { if (e.isTrusted) s.clicks += 1; }, opts);
    w.addEventListener('keydown', e => { if (e.isTrusted) s.keys += 1; }, opts);
    w.addEventListener('pointermove', e => { if (e.isTrusted) s.moves += 1; }, opts);
    w.addEventListener('blur', e => {
      const active = document.activeElement;
      if (e.isTrusted && active && active.tagName === 'IFRAME') s.frameFocus += 1;
    }, opts);
  }
  const s = w.__icChallengeInput;
  return { id: s.id, clicks: s.clicks, keys: s.keys, moves: s.moves, frameFocus: s.frameFocus };
})()`;

const FIELDS = ['clicks', 'keys', 'moves', 'frameFocus'];

/**
 * One probe per open check. poll() after each wait-loop read; summary() when it
 * ends. Every failure is swallowed: diagnostics must never break a scrape.
 */
export function createChallengeInputProbe(page, { now = () => Date.now() } = {}) {
  const perDocument = new Map();
  const startedAt = now();
  let polls = 0;
  let failedPolls = 0;
  let firstInputAt = null;
  return {
    async poll() {
      polls += 1;
      try {
        const counts = await page.evaluate(CHALLENGE_INPUT_PROBE_SOURCE);
        if (!counts || typeof counts.id !== 'string') { failedPolls += 1; return; }
        const before = perDocument.get(counts.id);
        const next = Object.fromEntries(FIELDS.map(field => [field, Math.max(0, Number(counts[field]) || 0)]));
        perDocument.set(counts.id, next);
        const gained = !before ? next.clicks + next.keys + next.frameFocus > 0
          : FIELDS.some(field => field !== 'moves' && next[field] > before[field]);
        if (gained && firstInputAt === null) firstInputAt = now();
      } catch {
        failedPolls += 1;
      }
    },
    summary() {
      const totals = { clicks: 0, keys: 0, moves: 0, frameFocus: 0 };
      for (const counts of perDocument.values()) for (const field of FIELDS) totals[field] += counts[field];
      return {
        ...totals,
        documents: perDocument.size,
        polls,
        failedPolls,
        firstInputAfterMs: firstInputAt === null ? null : Math.max(0, firstInputAt - startedAt),
      };
    },
  };
}

/** 'input' | 'movement' | 'none' | 'unknown' — what the probe saw, nothing more. */
export function challengeInputVerdict(summary) {
  if (!summary || !(summary.polls > 0) || summary.documents === 0) return 'unknown';
  if (summary.clicks + summary.keys + summary.frameFocus > 0) return 'input';
  if (summary.moves > 0) return 'movement';
  return 'none';
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * One clause for the log line. It states what was observed; it never claims who
 * solved the check, because a solve inside the check's frame is only partly visible.
 */
export function describeChallengeInput(summary) {
  const verdict = challengeInputVerdict(summary);
  if (verdict === 'unknown') return 'whether anyone touched the page is unknown (the page could not be read)';
  if (verdict === 'input') {
    const parts = [];
    if (summary.clicks) parts.push(plural(summary.clicks, 'click'));
    if (summary.keys) parts.push(plural(summary.keys, 'key press'));
    if (summary.frameFocus) parts.push(`focus moved into the check's frame ${summary.frameFocus}×`);
    return `user input reached the page (${parts.join(', ')}), so it was most likely solved by hand`;
  }
  if (verdict === 'movement') return 'the mouse moved over the page but nothing was clicked or typed, so it most likely cleared by itself';
  return 'no mouse or key input reached the page, so it most likely cleared by itself';
}
