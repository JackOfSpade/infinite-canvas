/**
 * Diagnostics-only observer for the description "card walk".
 *
 * Google, LinkedIn, Glassdoor and ZipRecruiter read descriptions by clicking
 * one card at a time and reading a side panel; the page itself never
 * navigates. When an anti-bot check or an unexpected popup covers the page the
 * panel simply never changes, which is indistinguishable from a broken panel
 * selector by counting failures alone. This module only LOOKS at the page and
 * names what it saw. It never clicks, dismisses, waits, scrolls or retries, and
 * it never returns URLs, query strings or form/input values: the result is
 * limited to counts, bounded text, and the identity of the element that owns
 * the viewport centre.
 */

/**
 * Puppeteer-serializable page probe: reads what covers the page during a card
 * walk. Deliberately self-contained (no references to module scope) so
 * `page.evaluate(readPanelWalkCover)` can ship the function source alone.
 *
 * Returns `{ dialogs, dialogText, dialogLabel, checkFrames, cover, position }`:
 *  - dialogs: visible `[role="dialog"], [role="alertdialog"], [aria-modal="true"],
 *    dialog[open]` nodes — laid out and not inside `aria-hidden="true"`;
 *  - dialogText: the first visible dialog's text, collapsed to one line, 120 chars;
 *  - dialogLabel: its own aria-label / aria-labelledby text, 80 chars;
 *  - checkFrames: visible iframes pointing at a known challenge host;
 *  - cover: the element at the viewport centre as `tag#id.firstClass`, 80 chars;
 *  - position: fixed/sticky/other — the nearest fixed/sticky box among the
 *    centre element and its ancestors, i.e. whether something is pinned over it.
 * Nothing derived from the URL, a query string or an input value is returned.
 */
export function readPanelWalkCover(root = globalThis.document) {
  const out = { dialogs: 0, dialogText: '', dialogLabel: '', checkFrames: 0, cover: '', position: '' };
  if (!root || typeof root.querySelectorAll !== 'function') return out;
  const collapse = (value, max) => String(value == null ? '' : value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
  const hidden = (el) => {
    try {
      if (!el) return true;
      const rects = el.getClientRects?.();
      return !rects || rects.length === 0;
    } catch {
      return true;
    }
  };
  const insideAriaHidden = (el) => {
    try {
      return Boolean(el?.closest?.('[aria-hidden="true"]'));
    } catch {
      return false;
    }
  };
  const visible = (el) => !hidden(el) && !insideAriaHidden(el);

  try {
    const dialogNodes = root.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]');
    let firstDialog = null;
    for (const el of dialogNodes || []) {
      if (!visible(el)) continue;
      out.dialogs += 1;
      if (!firstDialog) firstDialog = el;
    }
    if (firstDialog) {
      out.dialogText = collapse(firstDialog.textContent, 120);
      let label = collapse(firstDialog.getAttribute?.('aria-label'), 80);
      if (!label) {
        const ids = String(firstDialog.getAttribute?.('aria-labelledby') || '').split(/\s+/).filter(Boolean);
        const parts = [];
        for (const id of ids) {
          try {
            parts.push(collapse(root.getElementById?.(id)?.textContent, 80));
          } catch {
            // an unresolvable reference simply contributes nothing
          }
        }
        label = collapse(parts.filter(Boolean).join(' '), 80);
      }
      out.dialogLabel = label;
    }
  } catch {
    // A malformed dialog list is not evidence of anything; leave dialogs as counted.
  }

  try {
    const challengeMarkers = [
      'challenges.cloudflare.com',
      'google.com/recaptcha',
      'recaptcha.net',
      'hcaptcha.com',
      'captcha-delivery.com',
      'perimeterx',
    ];
    for (const frame of root.querySelectorAll('iframe') || []) {
      if (!visible(frame)) continue;
      const src = String(frame.getAttribute?.('src') || '').toLowerCase();
      if (!src) continue;
      if (challengeMarkers.some((marker) => src.includes(marker))) out.checkFrames += 1;
    }
  } catch {
    // ignore — frame counting is best-effort diagnostics
  }

  try {
    const view = root.defaultView || globalThis;
    const width = Math.max(0, Math.floor(Number(view?.innerWidth) || 0));
    const height = Math.max(0, Math.floor(Number(view?.innerHeight) || 0));
    const centre = root.elementFromPoint?.(Math.floor(width / 2), Math.floor(height / 2)) || null;
    if (centre) {
      const tag = String(centre.tagName || '').toLowerCase() || 'node';
      const id = centre.id ? `#${collapse(centre.id, 40)}` : '';
      let className = '';
      try {
        const first = centre.classList?.[0] || '';
        if (first) className = `.${collapse(first, 40)}`;
      } catch {
        className = '';
      }
      out.cover = collapse(`${tag}${id}${className}`, 80);
      const positionOf = (el) => {
        try {
          const computed = view?.getComputedStyle?.(el);
          const inline = el?.style?.position;
          return String(computed?.position || inline || '').toLowerCase();
        } catch {
          return '';
        }
      };
      let candidate = centre;
      for (let depth = 0; candidate && depth < 8; depth += 1) {
        const position = positionOf(candidate);
        if (position === 'fixed' || position === 'sticky') {
          out.position = position;
          break;
        }
        candidate = candidate.parentElement || null;
      }
      if (!out.position) out.position = 'other';
    }
  } catch {
    // elementFromPoint can be missing entirely (non-visual document); that only
    // means the cover element is unknown.
  }

  return out;
}

/**
 * Name what the walk ran into. `signals` is `getChallengeSignals(page)`,
 * `cover` is `readPanelWalkCover(...)`. A detected challenge always wins over a
 * dialog: a check that renders inside a modal must not be reported as a popup.
 */
export function classifyPanelWalkInterrupt(input = {}) {
  const { signals = null, cover = null } = input || {};
  if (!signals && !cover) return 'unknown';
  if (signals?.isChallenge === true) return 'check';
  if ((Number(cover?.checkFrames) || 0) > 0) return 'check';
  if ((Number(cover?.dialogs) || 0) > 0) return 'popup';
  const position = String(cover?.position || '').toLowerCase();
  if (position === 'fixed' || position === 'sticky') return 'covered';
  return 'none';
}

/** One short clause for the log line and for the stop message. */
export function describePanelWalkInterrupt(verdict, { signals = null, cover = null } = {}) {
  try {
    if (verdict === 'check') {
      const detail = signals?.hasCloudflareChallengeFrame
        ? 'Cloudflare frame'
        : signals?.hasCloudflareTurnstileWidget
          ? 'Cloudflare Turnstile'
          : signals?.hasDataDomeFrame
            ? 'DataDome frame'
            : signals?.hasPerimeterXBlock
              ? 'PerimeterX block'
              : (Number(signals?.visibleRecaptchaFrames) || 0) > 0
                ? 'reCAPTCHA frame'
                : (Number(signals?.visibleHCaptchaFrames) || 0) > 0
                  ? 'hCaptcha frame'
                  : signals?.reason
                    ? String(signals.reason).replace(/\s+/g, ' ').trim().slice(0, 80)
                    : (Number(cover?.checkFrames) || 0) > 0
                      ? 'verification frame'
                      : '';
      return `a verification check covered the page${detail ? ` (${detail})` : ''}`;
    }
    if (verdict === 'popup') {
      const text = String(cover?.dialogText || cover?.dialogLabel || '').replace(/\s+/g, ' ').trim().slice(0, 120);
      return text ? `a popup was open: "${text}"` : 'a popup was open without readable text';
    }
    if (verdict === 'covered') {
      const kind = String(cover?.position || '').toLowerCase() === 'sticky' ? 'sticky' : 'fixed';
      const element = String(cover?.cover || '').replace(/\s+/g, ' ').trim().slice(0, 80) || 'an unnamed element';
      return `a ${kind} element covered the page centre (${element})`;
    }
    if (verdict === 'none') return 'nothing unusual was on screen';
    return 'the page could not be read';
  } catch {
    return 'the page could not be read';
  }
}
