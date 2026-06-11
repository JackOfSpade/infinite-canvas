import { SELL_PLATFORM_BY_ID } from './constants.js';

/** Normalized hostname from a (possibly protocol-less) URL; '' if unparseable. */
function parseHost(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  try {
    // Stored listing URLs are often protocol-less ("www.ebay.com/itm/123"), which
    // `new URL` rejects — prepend a scheme so the host parses.
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withProto).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

/**
 * Does `url`'s host belong to marketplace `platformId`? Guards "Check" / "Check
 * All" from running against a listing URL that's for a DIFFERENT platform than
 * the card claims (e.g. an ebay.com link pasted into a Facebook card) — that
 * check would fetch the wrong site and return a meaningless verdict.
 *
 * Deliberately CONSERVATIVE: returns ok:true whenever we can't be sure it's
 * wrong (unknown platform id, or a blank / unparseable URL) so the only thing
 * that ever blocks a check is a CLEARLY mismatched host. The host match accepts
 * the bare domain and any subdomain (m.facebook.com, www. already stripped).
 *
 * @returns {{ ok: boolean, expectedDomain: string, actualHost: string }}
 */
export function listingUrlMatchesPlatform(url, platformId) {
  const expectedDomain = SELL_PLATFORM_BY_ID[platformId]?.domain || '';
  const actualHost = parseHost(url);
  if (!expectedDomain || !actualHost) return { ok: true, expectedDomain, actualHost };
  const ok = actualHost === expectedDomain || actualHost.endsWith(`.${expectedDomain}`);
  return { ok, expectedDomain, actualHost };
}

/**
 * Is `url` a Facebook `/share/<hash>` link (the "Share → Copy link" form) rather
 * than a canonical `/marketplace/item/<id>` listing URL? Share links are a poor
 * status-check anchor: Facebook returns HTTP 400 for them to automated fetches,
 * and the share hash never appears on the seller's dashboard, so neither the
 * listing page nor any watch page can confirm the listing's state — the check
 * resolves to a conservative "unknown" even though the listing is live.
 *
 * Shared so the card UI can nudge toward the canonical URL and the status engine
 * can explain the same cause; keep the two in lockstep via this one definition.
 */
export function isFacebookShareUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  try {
    const withProto = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    const u = new URL(withProto);
    return /(^|\.)facebook\.com$/i.test(u.hostname) && /^\/share\/[^/]+\/?$/i.test(u.pathname);
  } catch {
    return false;
  }
}
