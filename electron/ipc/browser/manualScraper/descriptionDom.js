/**
 * Card-walk planning and the DOM-root helpers for the description side panel,
 * including the Glassdoor job-alert modal inspection and its physical-click
 * dismiss. Imports only walkRules among the siblings.
 */

import { DESC_CONFIGS } from './walkRules.js';
import { humanDelay } from '../../../utils/humanDelay.js';
import { sourceJobKey } from '../../../../src/utils/jobIdentity.js';

/**
 * Produce the stable DOM target for each card-click description attempt.
 *
 * Keeping this derivation in one place matters for virtualized lists: every
 * on-demand click receives the extracted listing's opaque identity instead of
 * relying on a mutable visible-list position.
 */
export function buildDescriptionCardTargets(jobs, sourceId) {
  const cfg = DESC_CONFIGS[sourceId];
  if (!cfg) return [];
  return (Array.isArray(jobs) ? jobs : []).map((job, index) => {
    const identityUrl = sourceId === 'google' ? (job?.googleCardUrl || job?.url) : job?.url;
    const rawKey = (cfg.keyField && job?.[cfg.keyField])
      ? job[cfg.keyField]
      : cfg.keyRegex
        ? identityUrl?.match(new RegExp(cfg.keyRegex))?.[1]
        : identityUrl?.match(new RegExp(`[?&]${cfg.keyParam}=([^&]+)`))?.[1];
    let key = rawKey || '';
    if (key && cfg.keyDecode) {
      try { key = decodeURIComponent(key); } catch { key = ''; }
    }
    return { index, key: String(key || '') };
  });
}

/**
 * Preserve where selected cards came from in a physical, DOM-ordered result
 * list. The normal walk now includes every provider row; retaining the ordinal
 * still proves that result caps and virtualized remounts did not change click
 * identity, without adding transient fields to persisted/scored job objects.
 */
export function buildPhysicalCardWalkPlan(extractedJobs, selectedJobs) {
  const extracted = Array.isArray(extractedJobs) ? extractedJobs : [];
  const selected = Array.isArray(selectedJobs) ? selectedJobs : [];
  // Resolve preparation normalizes/tag-copies rows before selecting the
  // persisted deferred subset. Prefer stable provider identity so those copies
  // retain their original DOM ordinal instead of clicking selected index N as
  // physical card N after age/history/recovery filtering.
  const ordinalsByKey = new Map();
  extracted.forEach((job, index) => {
    const key = sourceJobKey(job);
    if (key && !ordinalsByKey.has(key)) ordinalsByKey.set(key, index + 1);
  });
  const ordinalsByReference = new Map(extracted.map((job, index) => [job, index + 1]));
  return {
    physicalTotal: extracted.length,
    physicalIndexes: selected.map((job) => {
      const key = sourceJobKey(job);
      return (key ? ordinalsByKey.get(key) : null) ?? ordinalsByReference.get(job) ?? null;
    }),
  };
}

/** Read a heading from Google's active detail region, never a left-list card. */
export function readActiveGoogleDetailTitle(root) {
  if (!root?.querySelectorAll) return '';
  const candidates = Array.from(root.querySelectorAll('h1, h2, h3, [role="heading"]'))
    .filter(el => !el.closest?.('[aria-hidden="true"]'))
    .filter(el => !el.closest?.('[data-share-url]'))
    .filter(el => !!el.closest?.('[aria-hidden="false"]'))
    .map(el => el.textContent?.replace(/\s+/g, ' ').trim() || '')
    .filter(Boolean);
  return candidates[0] || '';
}

/**
 * Read the visible Google detail-panel text without accidentally accepting a
 * cached previous card or a preloaded next card. Google keeps those panels in
 * the DOM under aria-hidden="true" while the active panel can include a
 * CSS-hidden `.ejCXj` continuation under aria-hidden="false". The latter is
 * real description text and must stay; only the ARIA-hidden ancestor is a
 * reliable exclusion boundary.
 *
 * Kept DOM-root based and side-effect free so fixture tests exercise the same
 * selection policy that runs in the browser page.
 */
export function readDescriptionPanelText(root, panelSelector, panelMulti = false) {
  if (!root?.querySelectorAll || !panelSelector) return '';
  if (panelMulti) {
    return Array.from(root.querySelectorAll(panelSelector))
      .filter(el => el.matches?.('span') && !el.closest?.('[aria-hidden="true"]'))
      .map(el => el.textContent?.trim()).filter(Boolean).join('\n\n').trim();
  }
  const active = Array.from(root.querySelectorAll(panelSelector))
    .find(el => !el.closest?.('[aria-hidden="true"]'));
  return active?.innerText?.trim() || active?.textContent?.trim() || '';
}

/**
 * Resolve the stable identity carried by a rendered description-card element.
 * `elementFromPoint()` normally returns a descendant, so generic attribute
 * sources such as Glassdoor must walk to the owning `[data-jobid]` card before
 * comparing it with the planned `jl` key.
 */
export function readDescriptionCardDomKey(element, {
  cardAttr = null,
  cardDataUrlParam = null,
  expectedKey = '',
} = {}) {
  if (!element) return '';
  if (cardAttr) {
    const owner = element.matches?.(`[${cardAttr}]`)
      ? element
      : element.closest?.(`[${cardAttr}]`);
    const value = owner?.getAttribute?.(cardAttr);
    if (value) return String(value);
  }
  const resultCard = element.matches?.('[data-share-url]')
    ? element
    : element.closest?.('[data-share-url]');
  if (resultCard && cardDataUrlParam) {
    try {
      return new URL(resultCard.getAttribute('data-share-url') || '', 'https://example.invalid')
        .searchParams.get(cardDataUrlParam) || '';
    } catch { /* fall through to the legacy id */ }
  }
  return element.id === expectedKey ? expectedKey : '';
}

// This is deliberately narrower than a generic "close every dialog" helper.
// Glassdoor can legitimately show saved-job and application dialogs; closing one
// of those behind a user's back would change the visible result state. The job
// alert interstitial in the 2026-08-25 report is instead a non-essential prompt
// that blocks the result cards after a normal list-card click, so its distinctive
// copy gives us a safe, source-specific fingerprint.
export const GLASSDOOR_OPPORTUNITY_MODAL_MARKERS = [
  'never miss an opportunity',
  'create a job alert',
  'continue with google',
];
export const GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR = [
  '[role="dialog"]',
  '[aria-modal="true"]',
  'dialog',
  '[data-test*="modal" i]',
  '[data-testid*="modal" i]',
  '[class*="modal" i]',
].join(', ');
export const GLASSDOOR_OPPORTUNITY_CLOSE_SELECTOR = [
  'button[aria-label*="close" i]',
  '[role="button"][aria-label*="close" i]',
  'button[title*="close" i]',
  '[role="button"][title*="close" i]',
  'button[data-test*="close" i]',
  '[role="button"][data-test*="close" i]',
  'button[data-testid*="close" i]',
  '[role="button"][data-testid*="close" i]',
].join(', ');

export function normalizedModalText(element) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
}

export function isGlassdoorOpportunityModal(element) {
  const text = normalizedModalText(element);
  return GLASSDOOR_OPPORTUNITY_MODAL_MARKERS.every(marker => text.includes(marker));
}

export function isCloseControl(element) {
  if (!element) return false;
  const label = [
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element.getAttribute?.('data-test'),
    element.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
  const text = normalizedModalText(element);
  // The actual prompt's close control can be an icon-only X, depending on the
  // currently served Glassdoor experiment. An empty SVG button is accepted only
  // inside this exact, positively fingerprinted prompt.
  return label.includes('close') || text === 'x' || text === '×'
    || (!text && !!element.querySelector?.('svg'));
}

/**
 * Inspect the specific Glassdoor job-alert interstitial without clicking it.
 * Keeping its signature DOM-root based makes the live safety rule testable: an
 * ordinary dialog or an unrelated close icon must never qualify.
 */
export function inspectGlassdoorOpportunityModal(root) {
  if (!root?.querySelectorAll) return { detected: false, reason: 'no-dom-root' };
  const modal = Array.from(root.querySelectorAll(GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR))
    .find(element => !element.closest?.('[aria-hidden="true"]') && isGlassdoorOpportunityModal(element));
  if (!modal) return { detected: false, reason: 'not-present' };
  const close = Array.from(modal.querySelectorAll(GLASSDOOR_OPPORTUNITY_CLOSE_SELECTOR))
    .find(isCloseControl)
    || Array.from(modal.querySelectorAll('button, [role="button"]')).find(isCloseControl)
    || null;
  return {
    detected: true,
    reason: close ? 'close-control-found' : 'close-control-missing',
    modal,
    close,
  };
}

/**
 * Deterministic virtual-list diagnostic: which planned click targets are still
 * present in the current DOM window. The live clicker reports these misses and
 * never treats a list-card snippet as a recovered full description.
 */
export function inspectDescriptionCardTargetAvailability(targets, availableKeys) {
  const available = new Set(Array.isArray(availableKeys) ? availableKeys : []);
  const planned = Array.isArray(targets) ? targets : [];
  const missing = planned.filter(target => target?.key && !available.has(target.key));
  return {
    planned: planned.filter(target => target?.key).length,
    available: planned.filter(target => target?.key && available.has(target.key)).length,
    missing,
  };
}

/**
 * Close only Glassdoor's identified job-alert prompt with a physical click.
 * A list-card click is intentionally a real mouse action; retain that property
 * for the close control too, while refusing a click when some other overlay has
 * already covered it. The returned bounded fingerprint is retained on the
 * card-walk event so FULL can distinguish a popup from selector drift.
 */
export async function dismissGlassdoorOpportunityModal(page) {
  const target = await page.evaluate((modalSelector, closeSelector, markers) => {
    const normalizedText = (element) => String(element?.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
    const visible = (element) => {
      if (!element || element.hidden || element.closest?.('[aria-hidden="true"]')) return false;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };
    const describe = (element) => element ? {
      tag: String(element.tagName || '').toLowerCase(),
      id: String(element.id || '').slice(0, 80),
      role: String(element.getAttribute?.('role') || '').slice(0, 80),
      ariaLabel: String(element.getAttribute?.('aria-label') || '').slice(0, 120),
      testId: String(element.getAttribute?.('data-testid') || element.getAttribute?.('data-test') || '').slice(0, 120),
      classes: String(element.className || '').replace(/\s+/g, ' ').slice(0, 160),
      text: String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    } : null;
    const isClose = (element) => {
      const label = [
        element?.getAttribute?.('aria-label'), element?.getAttribute?.('title'),
        element?.getAttribute?.('data-test'), element?.getAttribute?.('data-testid'),
      ].filter(Boolean).join(' ').toLocaleLowerCase();
      const text = normalizedText(element);
      return label.includes('close') || text === 'x' || text === '×'
        || (!text && !!element?.querySelector?.('svg'));
    };
    const modal = Array.from(document.querySelectorAll(modalSelector))
      .find(element => visible(element) && markers.every(marker => normalizedText(element).includes(marker)));
    if (!modal) return { detected: false, action: 'none', reason: 'not-present' };
    const close = Array.from(modal.querySelectorAll(closeSelector)).find(isClose)
      || Array.from(modal.querySelectorAll('button, [role="button"]')).find(isClose)
      || null;
    if (!close || !visible(close)) {
      return { detected: true, action: 'failed', reason: 'close-control-missing', modal: describe(modal), dismiss: describe(close) };
    }
    const rect = close.getBoundingClientRect();
    const x = rect.left + (rect.width / 2);
    const y = rect.top + (rect.height / 2);
    const hit = document.elementFromPoint(x, y);
    if (!hit || (!close.contains(hit) && !hit.contains(close))) {
      return { detected: true, action: 'failed', reason: 'close-control-covered', modal: describe(modal), dismiss: describe(close) };
    }
    return { detected: true, action: 'ready', reason: 'close-control-found', x, y, modal: describe(modal), dismiss: describe(close) };
  }, GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR, GLASSDOOR_OPPORTUNITY_CLOSE_SELECTOR, GLASSDOOR_OPPORTUNITY_MODAL_MARKERS)
    .catch(() => ({ detected: false, action: 'none', reason: 'page-evaluate-failed' }));
  if (!target?.detected || target.action !== 'ready') return target;

  await page.mouse.move(target.x, target.y).catch(() => {});
  await page.mouse.click(target.x, target.y, { delay: humanDelay(70) }).catch(() => {});
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(resolve => setTimeout(resolve, humanDelay(140)));
    const remains = await page.evaluate((modalSelector, markers) => {
      const text = (element) => String(element?.textContent || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
      return Array.from(document.querySelectorAll(modalSelector)).some(element => {
        if (element.hidden || element.closest?.('[aria-hidden="true"]')) return false;
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0
          && rect.width > 0 && rect.height > 0 && markers.every(marker => text(element).includes(marker));
      });
    }, GLASSDOOR_OPPORTUNITY_MODAL_SELECTOR, GLASSDOOR_OPPORTUNITY_MODAL_MARKERS).catch(() => false);
    if (!remains) return { ...target, action: 'dismissed', reason: 'close-control-clicked' };
  }
  return { ...target, action: 'failed', reason: 'close-control-still-visible' };
}
