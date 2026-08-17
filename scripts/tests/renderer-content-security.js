import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../../src/utils/markdownRenderer.js';
import { escapeHtmlAttribute, normalizeExternalHttpUrl } from '../../src/utils/urlSafety.js';
import { assert } from './testHelpers.js';

function markdownDocument(source) {
  return new JSDOM(renderMarkdown(source)).window.document;
}

export default [
  {
    name: 'renderer markdown escapes generated link and image attributes',
    run() {
      // Marked unescapes the backslash-escaped quotes in these titles/texts.
      // Without attribute encoding, each payload creates an event-handler
      // attribute inside the dangerouslySetInnerHTML preview.
      const linkDocument = markdownDocument('[link](https://example.test/ "title\\" onmouseover=\\"alert(1)")');
      const link = linkDocument.querySelector('a');
      assert(link, 'safe link should still render');
      assert(link.getAttribute('title') === 'title" onmouseover="alert(1)', 'link title should remain data');
      assert(!link.hasAttribute('onmouseover'), 'link title must not create an event handler');

      const hrefDocument = new JSDOM(`<a href="${escapeHtmlAttribute('https://example.test/" onmouseover="alert(1)')}">safe</a>`).window.document;
      const hrefLink = hrefDocument.querySelector('a');
      assert(hrefLink.getAttribute('href') === 'https://example.test/" onmouseover="alert(1)', 'href should remain data');
      assert(!hrefLink.hasAttribute('onmouseover'), 'href must not create an event handler');

      const imageDocument = markdownDocument('![alt\\" onerror=\\"alert(1)](https://example.test/image.png "title\\" onload=\\"alert(1)")');
      const image = imageDocument.querySelector('img');
      assert(image, 'safe image should still render');
      assert(image.getAttribute('alt') === 'alt\\" onerror=\\"alert(1)', 'image alt should remain data');
      assert(image.getAttribute('title') === 'title" onload="alert(1)', 'image title should remain data');
      assert(!image.hasAttribute('onerror') && !image.hasAttribute('onload'), 'image attributes must not become handlers');

      return { linkTitle: link.title, imageAlt: image.alt };
    },
  },
  {
    name: 'renderer markdown rejects script URLs and raw HTML',
    run() {
      const document = markdownDocument('[bad](javascript:alert(1))\n\n![bad](data:text/html,boom)\n\n<img src=x onerror=alert(1)>');
      assert(document.querySelectorAll('a, img').length === 0, 'unsafe markdown URLs and raw HTML must not render as elements');
      return { renderedElements: document.querySelectorAll('*').length };
    },
  },
  {
    name: 'renderer external links only dispatch http(s) URLs',
    run() {
      assert(normalizeExternalHttpUrl('example.test/path') === 'https://example.test/path', 'bare domain should retain LinkNode convenience');
      assert(normalizeExternalHttpUrl('HTTPS://example.test/a?x=1') === 'https://example.test/a?x=1', 'https should be canonicalized');
      for (const unsafe of ['javascript:alert(1)', 'data:text/html,boom', 'file:///etc/passwd', 'mailto:test@example.test', 'https://example.test/\njavascript:alert(1)']) {
        assert(normalizeExternalHttpUrl(unsafe) === '', `unsafe external scheme must be rejected: ${unsafe}`);
      }
      return { accepted: normalizeExternalHttpUrl('example.test/path') };
    },
  },
];
