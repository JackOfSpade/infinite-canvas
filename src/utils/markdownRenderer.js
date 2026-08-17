import { marked } from 'marked';
import { escapeHtmlAttribute, normalizeMarkdownUrl } from './urlSafety.js';

// The preview renders user-droppable .md files with dangerouslySetInnerHTML.
// Marked intentionally does not sanitize HTML, so raw HTML must be discarded
// and every generated attribute must be escaped independently.
marked.use({
  breaks: true,
  gfm: true,
  renderer: {
    html() { return ''; },
    link(token) {
      const href = normalizeMarkdownUrl(token.href);
      const text = this.parser.parseInline(token.tokens);
      if (!href) return text;
      const title = token.title ? ` title="${escapeHtmlAttribute(token.title)}"` : '';
      return `<a href="${escapeHtmlAttribute(href)}"${title}>${text}</a>`;
    },
    image(token) {
      const href = normalizeMarkdownUrl(token.href);
      if (!href) return escapeHtmlAttribute(token.text || '');
      const alt = escapeHtmlAttribute(token.text || '');
      const title = token.title ? ` title="${escapeHtmlAttribute(token.title)}"` : '';
      return `<img src="${escapeHtmlAttribute(href)}" alt="${alt}"${title}>`;
    },
  },
});

export function renderMarkdown(content) {
  return marked.parse(String(content ?? ''));
}
