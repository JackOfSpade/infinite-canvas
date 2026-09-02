/**
 * ContentEditable event handlers shared by nodes with an inline-editable text
 * surface (TextNode, LinkNode). Plain functions, not hooks -- they don't own
 * any useRef/useState of their own, so pulling them out here doesn't run into
 * the React-Compiler inline-hook-state constraint that applies elsewhere in
 * this codebase. Callers keep wrapping them in their own useCallback.
 */

/**
 * Force pasted clipboard content into plain text, discarding any HTML/rich
 * formatting the source page or app attached to the clipboard.
 *
 * @param {ClipboardEvent} e
 */
export function pasteAsPlainText(e) {
  e.preventDefault();
  const text = e.clipboardData.getData('text/plain');
  document.execCommand('insertText', false, text);
}

/**
 * Escape key blurs the contentEditable, ending the edit.
 *
 * @param {KeyboardEvent} e
 * @param {React.RefObject<HTMLElement>} ref
 */
export function blurOnEscape(e, ref) {
  if (e.key === 'Escape') ref.current?.blur();
}
