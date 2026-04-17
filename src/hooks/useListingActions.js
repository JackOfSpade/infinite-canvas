import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useReactFlow } from '@xyflow/react';

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
  const [selectedPlatforms, setSelectedPlatforms] = useState(data.selectedPlatforms || ['ebay', 'facebook', 'craigslist']);
  const [copied, setCopied] = useState(false);
  const copiedTimeoutRef = useRef(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
      isMountedRef.current = false;
    };
  }, []);

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
    if (pricing?.recommended_price && !data.userPrice) {
      setPriceInput(pricing.recommended_price);
    }
  }, [data.userPrice]);

  // ── Copy listing ───────────────────────────────────────────────────────────

  const handleCopyListing = useCallback(() => {
    const text = `${product.generated_title || ''}\n\nPrice: $${priceInput}\nCondition: ${product.condition || ''}\n\n${product.generated_description || ''}`;
    navigator.clipboard.writeText(text).catch((err) => {
      console.warn('Clipboard write failed:', err);
    });
    setCopied(true);
    if (copiedTimeoutRef.current) clearTimeout(copiedTimeoutRef.current);
    copiedTimeoutRef.current = setTimeout(() => setCopied(false), 2000);
  }, [product, priceInput]);

  // ── Platform selection ─────────────────────────────────────────────────────

  const togglePlatform = useCallback((platformId) => {
    const updated = selectedPlatforms.includes(platformId)
      ? selectedPlatforms.filter(p => p !== platformId)
      : [...selectedPlatforms, platformId];
    setSelectedPlatforms(updated);
    updateNodeData(id, { selectedPlatforms: updated });
  }, [selectedPlatforms, id, updateNodeData]);

  // ── Price research ─────────────────────────────────────────────────────────

  const researchPrice = useCallback(async (onStateChange) => {
    if (!window.electronAPI?.researchPrice) return;
    onStateChange?.('researching');

    try {
      const query = `${product.brand || ''} ${product.model || ''} ${product.generated_title || ''}`.trim();
      const result = await window.electronAPI.researchPrice({
        query,
        condition: product.condition || 'Used - Good',
      });

      if (!isMountedRef.current) return result;

      if (result.success) {
        setPriceInput(result.pricing.recommended_price || '');
        onStateChange?.('priced', result);
      } else {
        onStateChange?.('priced-empty', result);
      }
      return result;
    } catch (err) {
      console.error('Price research failed:', err);
      onStateChange?.('error', err);
      return null;
    }
  }, [product]);

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

    // Handlers
    handleFieldEdit,
    handlePriceChange,
    handleQuickPrice,
    handleCopyListing,
    togglePlatform,
    toggleJustification,
    researchPrice,
    syncPriceFromBackend,
  };
}
