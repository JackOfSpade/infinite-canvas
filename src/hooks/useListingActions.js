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

  const [editing, setEditing] = useState(null);
  const [priceInput, setPriceInput] = useState(data.userPrice || data.pricing?.recommended_price || '');
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
    setSelectedPlatforms(data.selectedPlatforms);
  }

  const [prevExternalPrice, setPrevExternalPrice] = useState(data.userPrice || data.pricing?.recommended_price || '');
  const currentExternalPrice = data.userPrice || data.pricing?.recommended_price || '';
  if (editing !== 'price' && String(currentExternalPrice) !== String(prevExternalPrice)) {
    setPrevExternalPrice(currentExternalPrice);
    setPriceInput(currentExternalPrice);
  }

  // ── Field editing ──────────────────────────────────────────────────────────

  const handleFieldEdit = useCallback((field, value) => {
    updateNodeData(id, { product: { ...product, [field]: value } });
    setEditing(null);
  }, [id, product, updateNodeData]);

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
  const scrapePriceComps = useCallback(async () => {
    if (!window.electronAPI?.scrapePriceComps) throw new Error('scrapePriceComps API unavailable');
    const query = buildSearchQuery();
    const result = await window.electronAPI.scrapePriceComps({ query, nodeId: id });
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return result;
  }, [buildSearchQuery, id]);

  // Rescrape a single comp source — used after captcha-resolve to refetch
  // just the unblocked source instead of re-running the whole pipeline.
  const rescrapeSource = useCallback(async (sourceId) => {
    if (!window.electronAPI?.rescrapeSource) throw new Error('rescrapeSource API unavailable');
    const query = buildSearchQuery();
    const result = await window.electronAPI.rescrapeSource({ sourceId, query, nodeId: id });
    if (!result.success) {
      const err = new Error(result.error);
      if (result.isRateLimit) err.isRateLimit = true;
      throw err;
    }
    return result;
  }, [buildSearchQuery, id]);

  const synthesizePrice = useCallback(async (comps) => {
    if (!window.electronAPI?.synthesizePrice) throw new Error('synthesizePrice API unavailable');
    const query = buildSearchQuery();
    const result = await window.electronAPI.synthesizePrice({
      query,
      nodeId: id,
      condition: product.condition || 'Used - Good',
      // Full spec (not just the broad search query) so the backend can rank comps
      // by what actually distinguishes this item — color/model/title carry the
      // discriminating signal the deliberately-broad query strips out.
      productSpec: {
        model: product.model,
        color: product.color,
        title: product.generated_title,
      },
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
  }, [buildSearchQuery, product.condition, product.model, product.color, product.generated_title, id]);

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
