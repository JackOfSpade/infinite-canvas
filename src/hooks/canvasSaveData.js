import { EventLogger } from '../utils/EventLogger';
import { sanitizeNodesForSave, sanitizeEdgesForSave, CURRENT_SCHEMA_VERSION } from '../utils/serializationUtils';

/**
 * Commits any in-progress contenteditable edit (e.g. a text node being typed
 * into) before a save reads canvas state. TextNode only flushes its DOM
 * content into React state on blur, so without this step both the manual
 * save and the debounced auto-save would silently persist stale (pre-edit)
 * text for whatever the user is actively typing. Two ticks let React process
 * the blur-triggered setState and run the effect that mirrors `nodes`.
 */
export async function flushActiveContentEditable() {
  const active = document.activeElement;
  if (active && active.isContentEditable) {
    active.blur();
    EventLogger.log('save: committed in-progress contenteditable edit');
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
  }
}

/**
 * Shared save-serialization pipeline used by both the manual save
 * (useCanvasPersistence) and the debounced auto-save (useCanvasInitialization)
 * so the two paths can't drift — flush → sanitize → versioned payload.
 *
 * @param {object} opts
 * @param {Function} [opts.flushStack] - Navigation stack flush (returns root-level data)
 * @param {{nodes: Array, edges: Array, drawings: Array}} opts.fallbackState - Used when flushStack is unavailable
 * @returns {Promise<{nodes: Array, edges: Array, drawings: Array, schemaVersion: number}>}
 */
export async function buildSaveData({ flushStack, fallbackState }) {
  await flushActiveContentEditable();
  const rawData = flushStack ? flushStack() : fallbackState;
  const sanitizedNodes = sanitizeNodesForSave(rawData.nodes);
  const sanitizedEdges = sanitizeEdgesForSave(rawData.edges, sanitizedNodes);
  return { ...rawData, nodes: sanitizedNodes, edges: sanitizedEdges, schemaVersion: CURRENT_SCHEMA_VERSION };
}
