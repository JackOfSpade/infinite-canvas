import { useState, useCallback, useMemo } from 'react';
import { useReactFlow } from '@xyflow/react';
import { buildItemQuery } from '../utils/bundlePricing';
import { useToast } from '../components/ToastProvider';

/**
 * useListingActions — shared logic for SellHubNode's product/pricing state.
 *
 * Encapsulates:
 *   - Field editing (brand, model, title, etc.)
 *   - Price research API calls (scrape comps, synthesize single/bundle price)
 *
 * @param {string} id — ReactFlow node id
 * @param {object} data — node data
 * @returns shared state and handlers
 */
export function useListingActions(id, data) {
  const { updateNodeData } = useReactFlow();
  const { addToast } = useToast();
  const product = useMemo(() => data.product || {}, [data.product]);

  const [editing, setEditing] = useState(null);
  const [justificationExpanded, setJustificationExpanded] = useState(false);

  // ── Field editing ──────────────────────────────────────────────────────────

  const handleFieldEdit = useCallback((field, value) => {
    // Title is REQUIRED — a listing must have one. Reject an empty/whitespace
    // title edit, keeping the previous title rather than blanking it. Brand and
    // model have no such rule: clearing either is allowed and persists as ''
    // (buildItemQuery strips blank/"Unknown" tokens), so an empty edit there is
    // kept empty, NOT reverted to the pre-edit value.
    if (field === 'generated_title' && !String(value ?? '').trim()) {
      addToast({ title: 'Title required', description: "A listing title can't be empty — keeping the previous title.", type: 'error' });
      setEditing(null);
      return;
    }
    // Title / brand / model define what the item IS. Editing any of them makes
    // the AI's original `search_query` stale — it may describe a broader or
    // bundle-spanning product than the user now sees. Clear it so the scrape +
    // price query re-derive from the visible fields (buildItemQuery). "What you
    // priced = what you saw."
    const patch = { [field]: value };
    if (field === 'generated_title' || field === 'brand' || field === 'model') {
      patch.search_query = '';
    }
    updateNodeData(id, { product: { ...product, ...patch } });
    setEditing(null);
  }, [id, product, updateNodeData, addToast]);

  const handlePricingNotesChange = useCallback((value) => {
    updateNodeData(id, { pricingNotes: String(value || '') });
  }, [id, updateNodeData]);

  // ── Price research ─────────────────────────────────────────────────────────

  // Build a neutral search-friendly query string. Prefer the AI-generated
  // `search_query` field (brand + model + price-driving specs only, no
  // condition / color / marketing fluff) because marketplace search engines
  // do relevance ranking on token overlap — and a noisy query like
  // "FOR PARTS: Apple iPhone XS Silver 512GB" biases toward a narrow slice
  // instead of the broader pool we want for anchor/adjusted/bound weighting.
  // Falls back to the brand+model+title concat (with "Unknown"/blank tokens
  // stripped) for workspaces saved before the search_query field existed.
  // Delegates to the SAME buildItemQuery used by the bundle scrape (see
  // buildResearchItems) so the primary item is SYNTHESIZED with the exact query
  // it was SCRAPED with — otherwise the prompt's `ITEM:` line could disagree with
  // what produced the comps (e.g. "Brand Unknown Title" vs "Brand Title").
  const buildSearchQuery = useCallback(() => buildItemQuery(product), [product]);

  // Split into two stages so the caller can pause between scrape and synthesis
  // when sources errored — see SellHubNode.handleConfirmDraft for the
  // resolve-or-skip decision flow that lives between them.
  // Accepts an optional list of research items (multi-item "bundle" listings —
  // e.g. kayak + paddle). Each item carries its own { query, condition } and
  // gets a complete pricing pass server-side. With no argument, falls back to a
  // single item built from the primary product (the common single-item case).
  const scrapePriceComps = useCallback(async (researchItems) => {
    if (!window.electronAPI?.scrapePriceComps) throw new Error('scrapePriceComps API unavailable');
    const items = (Array.isArray(researchItems) && researchItems.length > 0)
      ? researchItems
      : [{ query: buildSearchQuery(), condition: product.condition || 'Used - Good' }];
    // Hub-level product category gates niche comp sources server-side (e.g.
    // PriceCharting only runs for video-game/collectible categories — it fuzzily
    // "matches" any query otherwise). Blank/Unknown is fine; the backend treats
    // an unknown category as "don't suppress".
    const result = await window.electronAPI.scrapePriceComps({ items, nodeId: id, category: product.category });
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return result;
  }, [buildSearchQuery, product.condition, product.category, id]);

  // Rescrape a single comp source — used after captcha-resolve to refetch
  // just the unblocked source instead of re-running the whole pipeline. Pass
  // `researchItems` to refetch that source for every item of a bundle (returns
  // a per-item result); omit it for the single-item path.
  const rescrapeSource = useCallback(async (sourceId, researchItems, noChallengeConfirmed = false) => {
    if (!window.electronAPI?.rescrapeSource) throw new Error('rescrapeSource API unavailable');
    const payload = (Array.isArray(researchItems) && researchItems.length > 0)
      ? { sourceId, items: researchItems, nodeId: id, noChallengeConfirmed }
      : { sourceId, query: buildSearchQuery(), nodeId: id, noChallengeConfirmed };
    const result = await window.electronAPI.rescrapeSource(payload);
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return result;
  }, [buildSearchQuery, id]);

  // `overrides` lets the caller price an extra bundle item with ITS OWN query /
  // condition / spec instead of the primary product's (defaults derive from the
  // primary, so single-item callers pass just `comps`).
  const synthesizePrice = useCallback(async (comps, overrides = {}) => {
    if (!window.electronAPI?.synthesizePrice) throw new Error('synthesizePrice API unavailable');
    const query = overrides.query || buildSearchQuery();
    const result = await window.electronAPI.synthesizePrice({
      query,
      nodeId: id,
      itemKey: overrides.itemKey || 'primary',
      itemLabel: overrides.itemLabel || product.generated_title || query,
      condition: overrides.condition || product.condition || 'Used - Good',
      // Full spec (not just the broad search query) so the backend can rank comps
      // by what actually distinguishes this item — color/model/title carry the
      // discriminating signal the deliberately-broad query strips out.
      productSpec: overrides.productSpec || {
        model: product.model,
        color: product.color,
        title: product.generated_title,
      },
      // Per-item notes for multi-item bundles: each extra item carries its own
      // pricing notes. Falls back to the hub-level notes for the primary item
      // (and any caller that doesn't pass an override).
      pricingNotes: overrides.pricingNotes !== undefined ? overrides.pricingNotes : (data.pricingNotes || ''),
      comps,
    });
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return result;
  }, [buildSearchQuery, product.condition, product.model, product.color, product.generated_title, data.pricingNotes, id]);

  // Multi-item bundle: ask the AI for attributable bundle/tier pricing factors
  // across independently-priced items. The backend deterministically derives
  // whole-listing quick/best/max prices and explanation from those factors.
  // Returns null when fewer than 2 items were priced.
  const synthesizeBundlePrice = useCallback(async (items, sumOfPrices) => {
    if (!window.electronAPI?.synthesizeBundlePrice) throw new Error('synthesizeBundlePrice API unavailable');
    const result = await window.electronAPI.synthesizeBundlePrice({ items, sumOfPrices, nodeId: id });
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return result.bundlePricing || null;
  }, [id]);

  // ── Justification toggle ───────────────────────────────────────────────────

  const toggleJustification = useCallback(() => {
    setJustificationExpanded(prev => !prev);
  }, []);

  return {
    // State
    product,
    editing,
    setEditing,
    justificationExpanded,

    // Handlers
    handleFieldEdit,
    handlePricingNotesChange,
    toggleJustification,
    scrapePriceComps,
    rescrapeSource,
    synthesizePrice,
    synthesizeBundlePrice,
  };
}
