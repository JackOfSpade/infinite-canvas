// Shared marketplace / price-comp source scope for dev / test mode.
//
// Sibling of src/utils/jobSourceScope.js, but deliberately simpler: price
// research runs fast and to completion, so the only knob is targeting ONE comp
// source. When enabled with a sourceId, only that source participates:
// - backend: buildCompTasks / fetchApiMarketplaceSources skip every other source
// - frontend: only the targeted comp-source card is spawned/shown
// There is NO run-tier / skip-AI / cooldown-probe machinery here — the run goes
// through in full, exactly as in production, just narrowed to one platform.
//
// Keep this file framework-agnostic so both `src/` and `electron/` can import it.
//
// Opt in with env vars instead of editing source:
// - MARKETPLACE_TEST_ENABLED=true
// - MARKETPLACE_TEST_SOURCE=ebay-sold
//
// Renderer builds must use the matching VITE_ prefix for the same keys
// (VITE_MARKETPLACE_TEST_ENABLED / VITE_MARKETPLACE_TEST_SOURCE), since Vite
// only exposes VITE_-prefixed vars to the client bundle.

import { getRuntimeEnv, getEnvValue, parseScopeEnvBoolean } from './sourceScopeShared.js';

// Public name kept for existing importers/tests; the logic is the shared parser.
export const parseMarketplaceEnvBoolean = parseScopeEnvBoolean;

export function createMarketplaceTestMode(env = getRuntimeEnv()) {
  const enabled = parseMarketplaceEnvBoolean(getEnvValue(env, 'MARKETPLACE_TEST_ENABLED'), false);
  const sourceId = String(getEnvValue(env, 'MARKETPLACE_TEST_SOURCE') || '').trim();
  return {
    enabled,
    // Only meaningful when enabled — a stray MARKETPLACE_TEST_SOURCE without the
    // enable flag must NOT silently narrow a production run to one source.
    sourceId: enabled ? (sourceId || null) : null,
  };
}

export const MARKETPLACE_TEST_MODE = createMarketplaceTestMode();

// Scope match is family-aware: a bare scope like "swappa" (or "ebay") enables the
// whole family — "swappa" + "swappa-sold" (or "ebay-sold" + "ebay-active") — so a
// platform with both a sold and an active comp source can be tested as one unit.
// An exact id ("ebay-sold", "swappa-sold") still isolates just that one source.
function matchesCompScope(id, scope) {
  return id === scope || String(id).startsWith(`${scope}-`);
}

export function getScopedCompSourceIds(allSourceIds = []) {
  const ids = Array.isArray(allSourceIds) ? allSourceIds.filter(Boolean) : [];
  if (!MARKETPLACE_TEST_MODE.enabled || !MARKETPLACE_TEST_MODE.sourceId) return ids;
  return ids.filter(id => matchesCompScope(id, MARKETPLACE_TEST_MODE.sourceId));
}

export function isCompSourceEnabledInScope(sourceId) {
  if (!MARKETPLACE_TEST_MODE.enabled || !MARKETPLACE_TEST_MODE.sourceId) return true;
  return matchesCompScope(sourceId, MARKETPLACE_TEST_MODE.sourceId);
}

/**
 * Normalize scrape warnings to card-representable source ids so the SellHub
 * comps-ready gate can never be stranded by a warning whose sourceId has no
 * spawned card. The backend emits per-sub-source warnings (e.g. 'swappa-sold')
 * but the canvas shows ONE family card ('swappa'); since Skip/Solve clear by
 * EXACT sourceId, a 'swappa-sold' warning could never be cleared, freezing the
 * hub in 'comps-ready' (a common outcome — Swappa's sold scrape is anti-bot
 * prone). Each warning: kept as-is if its sourceId IS a card; else re-tagged to
 * the family card that owns it (so that card's Skip/Solve clears it); else
 * dropped (no card can ever resolve it, so it must not gate). De-duped by final
 * sourceId so one family card never carries two lingering entries.
 *
 * @param {object[]} warnings  raw scrapeWarnings from the backend
 * @param {string[]} cardIds   ids of the comp-source cards actually on the canvas
 * @returns {object[]}
 */
export function normalizeCompWarnings(warnings, cardIds = []) {
  const cards = new Set(Array.isArray(cardIds) ? cardIds : []);
  const out = [];
  const seen = new Set();
  for (const w of (Array.isArray(warnings) ? warnings : [])) {
    if (!w || typeof w !== 'object') continue;
    let sid = w.sourceId;
    if (!cards.has(sid)) {
      const family = [...cards].find(cid => matchesCompScope(sid, cid)); // 'swappa-sold' → 'swappa'
      if (!family) continue; // orphan — nothing on the canvas can resolve it
      sid = family;
    }
    if (seen.has(sid)) continue; // family already represented
    seen.add(sid);
    out.push(sid === w.sourceId ? w : { ...w, sourceId: sid });
  }
  return out;
}
