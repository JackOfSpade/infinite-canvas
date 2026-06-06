import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';
import { EventLogger } from '../utils/EventLogger';
import { TIMINGS } from '../utils/timings';

/**
 * useListingActions — shared logic for ListingNode and SellHubNode.
 *
 * Encapsulates:
 *   - Field editing (brand, model, title, etc.)
 *   - Price input state + quick-price selection
 *   - Copy-to-clipboard for generated listing text
 *   - Platform selection toggle
 *   - Price research API call
 *
 * @param {string} id — ReactFlow node id
 * @param {object} data — node data
 * @returns shared state and handlers
 */
export function useListingActions(id, data) {
  const { updateNodeData } = useReactFlow();
  const product = useMemo(() => data.product || {}, [data.product]);

  // Price to display: the user's explicit price when set — including a deliberate
  // 0 (free / parts-only items) — otherwise the recommended price. Uses an
  // explicit "is set" test rather than `||`, so a legitimate 0 isn't treated as
  // unset and silently replaced by recommended_price. '' / null / undefined mean
  // "not set" and correctly fall through to the recommended price.
  const externalPrice = (data.userPrice === 0 || data.userPrice)
    ? data.userPrice
    : (data.pricing?.recommended_price || '');

  const [editing, setEditing] = useState(null);
  const [priceInput, setPriceInput] = useState(externalPrice);
  const [justificationExpanded, setJustificationExpanded] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState(data.selectedPlatforms || ['ebay', 'facebook', 'mercari']);
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef(null);
  // Ref for userPrice so syncPriceFromBackend is stable across renders.
  const userPriceRef = useRef(data.userPrice);
  useEffect(() => { userPriceRef.current = data.userPrice; }, [data.userPrice]);

  useEffect(() => {
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    };
  }, []);
 
  // Sync local state when data changes externally (e.g. undo/redo)
  // We do this during render to avoid cascading effects, following the "Adjusting state based on props" pattern.
  const [prevPlatforms, setPrevPlatforms] = useState(data.selectedPlatforms);
  if (JSON.stringify(data.selectedPlatforms) !== JSON.stringify(prevPlatforms)) {
    setPrevPlatforms(data.selectedPlatforms);
    setSelectedPlatforms(data.selectedPlatforms || ['ebay', 'facebook', 'mercari']);
  }

  const [prevExternalPrice, setPrevExternalPrice] = useState(externalPrice);
  const currentExternalPrice = externalPrice;
  if (editing !== 'price' && String(currentExternalPrice) !== String(prevExternalPrice)) {
    setPrevExternalPrice(currentExternalPrice);
    setPriceInput(currentExternalPrice);
  }

  // ── Field editing ──────────────────────────────────────────────────────────

  const handleFieldEdit = useCallback((field, value) => {
    updateNodeData(id, { product: { ...product, [field]: value } });
    setEditing(null);
  }, [id, product, updateNodeData]);

  const handlePricingNotesChange = useCallback((value) => {
    updateNodeData(id, { pricingNotes: String(value || '') });
  }, [id, updateNodeData]);

  // ── Price input ────────────────────────────────────────────────────────────

  const handlePriceChange = useCallback((value) => {
    setPriceInput(value);
    updateNodeData(id, { userPrice: parseFloat(value) || 0 });
  }, [id, updateNodeData]);

  const handleQuickPrice = useCallback((price) => {
    setPriceInput(price);
    updateNodeData(id, { userPrice: price });
  }, [id, updateNodeData]);

  // ── Sync price from backend when it first arrives ─────────────────────────

  const syncPriceFromBackend = useCallback((pricing) => {
    if (pricing?.recommended_price && !userPriceRef.current) {
      setPriceInput(pricing.recommended_price);
    }
  // Stable: reads userPriceRef to avoid re-creating on every userPrice change.
  }, []);

  // ── Copy listing ─────────────────────────────────────────────────────

  // Memoised so both Copy and Save-to-File use the same text without duplication.
  const listingText = useMemo(() =>
    `${product.generated_title || ''}\n\nPrice: $${priceInput}\nCondition: ${product.condition || ''}\n\n${product.generated_description || ''}`,
    [product, priceInput]
  );

  const handleCopyListing = useCallback((textOverride) => {
    if (!navigator.clipboard?.writeText) {
      EventLogger.log('handleCopyListing: Clipboard API not available');
      return;
    }
    navigator.clipboard.writeText(textOverride ?? listingText)
      .then(() => {
        setCopied(true);
        if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
        copiedTimeoutRef.current = setTimeout(() => { setCopied(false); }, TIMINGS.FEEDBACK_MS);
      })
      .catch((err) => {
        EventLogger.log('handleCopyListing: clipboard write failed: ' + (err?.message || String(err)));
      });
  }, [listingText]);

  // ── Platform selection ─────────────────────────────────────────────────────

  const togglePlatform = useCallback((platformId) => {
    const updated = selectedPlatforms.includes(platformId)
      ? selectedPlatforms.filter(p => p !== platformId)
      : [...selectedPlatforms, platformId];
    setSelectedPlatforms(updated);
    updateNodeData(id, { selectedPlatforms: updated });
  }, [selectedPlatforms, id, updateNodeData]);

  // ── Price research ─────────────────────────────────────────────────────────

  const isMountedRef = useRef(true);
  useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  // Build a neutral search-friendly query string. Prefer the AI-generated
  // `search_query` field (brand + model + price-driving specs only, no
  // condition / color / marketing fluff) because marketplace search engines
  // do relevance ranking on token overlap — and a noisy query like
  // "FOR PARTS: Apple iPhone XS Silver 512GB" biases toward a narrow slice
  // instead of the broader pool we want for anchor/adjusted/bound weighting.
  // Falls back to the old brand+model+title concat for workspaces saved
  // before the search_query field existed.
  const buildSearchQuery = useCallback(() => {
    const ai = product.search_query?.trim();
    if (ai) return ai;
    return `${product.brand || ''} ${product.model || ''} ${product.generated_title || ''}`.trim();
  }, [product]);

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
    const result = await window.electronAPI.scrapePriceComps({ items, nodeId: id });
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return result;
  }, [buildSearchQuery, product.condition, id]);

  // Rescrape a single comp source — used after captcha-resolve to refetch
  // just the unblocked source instead of re-running the whole pipeline. Pass
  // `researchItems` to refetch that source for every item of a bundle (returns
  // a per-item result); omit it for the single-item path.
  const rescrapeSource = useCallback(async (sourceId, researchItems) => {
    if (!window.electronAPI?.rescrapeSource) throw new Error('rescrapeSource API unavailable');
    const payload = (Array.isArray(researchItems) && researchItems.length > 0)
      ? { sourceId, items: researchItems, nodeId: id }
      : { sourceId, query: buildSearchQuery(), nodeId: id };
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
      condition: overrides.condition || product.condition || 'Used - Good',
      // Full spec (not just the broad search query) so the backend can rank comps
      // by what actually distinguishes this item — color/model/title carry the
      // discriminating signal the deliberately-broad query strips out.
      productSpec: overrides.productSpec || {
        model: product.model,
        color: product.color,
        title: product.generated_title,
      },
      pricingNotes: data.pricingNotes || '',
      comps,
    });
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    if (isMountedRef.current && result.pricing?.recommended_price) {
      setPriceInput(result.pricing.recommended_price);
    }
    return result;
  }, [buildSearchQuery, product.condition, product.model, product.color, product.generated_title, data.pricingNotes, id]);

  // ── Justification toggle ───────────────────────────────────────────────────

  const toggleJustification = useCallback(() => {
    setJustificationExpanded(prev => !prev);
  }, []);

  return {
    // State
    product,
    editing,
    setEditing,
    priceInput,
    justificationExpanded,
    selectedPlatforms,
    copied,
    listingText,

    // Handlers
    handleFieldEdit,
    handlePricingNotesChange,
    handlePriceChange,
    handleQuickPrice,
    handleCopyListing,
    togglePlatform,
    toggleJustification,
    scrapePriceComps,
    rescrapeSource,
    synthesizePrice,
    syncPriceFromBackend,
  };
}
