import { JSDOM } from 'jsdom';
import { renderMarkdown } from '../../src/utils/markdownRenderer.js';
import { escapeHtmlAttribute, normalizeExternalHttpUrl } from '../../src/utils/urlSafety.js';
import { isGoogleJobsInternalUrl, normalizeJobListingExternalUrl, summarizeJobListingUrl } from '../../src/utils/jobListingUrl.js';
import { describeUnexpectedNetworkTarget } from '../test-stubs/networkGuard.mjs';
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
  {
    name: 'unit network guard keeps sensitive request details out of failure output',
    run() {
      const target = describeUnexpectedNetworkTarget('https://client-id:client-secret@api.example.test/v1/jobs/secret-requisition?api_key=private-token#response-token');
      assert(target === 'https://api.example.test/<path redacted>'
        && !target.includes('client-secret')
        && !target.includes('private-token')
        && !target.includes('response-token'),
      'an unexpected unit-test network error must identify only a safe origin and never echo credentials, query values, or fragments');
      return { target };
    },
  },
  {
    name: 'job listing links repair legacy Google Jobs share URLs without exposing query values',
    run() {
      const legacy = 'https://www.google.com/search?ibp=htl;jobs&q&htidocid=Opaque-ID%3D%3D&hl=en-CA#fpstate=tldetail&htivrt=jobs&htiq&htidocid=Opaque-ID%3D%3D';
      const job = {
        source: 'google',
        title: 'AI Platform Architect',
        company: 'Aalo Atomics',
        location: 'Austin, TX',
        url: legacy,
      };
      const repaired = normalizeJobListingExternalUrl(job);
      const parsed = new URL(repaired);
      assert(isGoogleJobsInternalUrl(legacy), 'legacy Google card/share route must be recognized');
      assert(parsed.pathname === '/search' && parsed.searchParams.get('udm') === '8',
        'legacy Google route must be repaired to the current Jobs search surface');
      assert(parsed.searchParams.get('q') === 'AI Platform Architect Aalo Atomics Austin, TX jobs',
        'blank Google q/htiq must fall back to the saved job identity');
      assert(parsed.searchParams.get('htidocid') === 'Opaque-ID==',
        'opaque Google card identity must survive click-time repair');
      assert(!repaired.includes('ibp=') && !repaired.includes('/webhp'),
        'repaired destination must not retain the obsolete ibp/webhp route');
      const direct = 'https://careers.example.test/jobs/42?ref=board';
      assert(normalizeJobListingExternalUrl({ ...job, url: direct, googleCardUrl: legacy }) === direct,
        'a future direct employer URL must win over the internal Google card identity');
      const lookalike = 'https://www.google.com.evil.test/search?udm=8&htidocid=attacker-controlled';
      assert(!isGoogleJobsInternalUrl(lookalike)
        && normalizeJobListingExternalUrl({ ...job, url: lookalike }) === lookalike,
      'only a real Google host can be treated as an internal Jobs route; a lookalike host must stay an ordinary external link');
      const diagnostic = summarizeJobListingUrl(job, repaired);
      assert(diagnostic.rawQuery === 'empty' && diagnostic.documentId === 'present' && diagnostic.repaired,
        'event diagnostics must report URL shape, not raw query values');
      const pathDiagnostic = summarizeJobListingUrl({
        url: 'https://careers.example.test/jobs/secret-requisition-id?tracking=private',
      });
      assert(pathDiagnostic.rawRoute === 'careers.example.test/jobs/:segment'
        && !JSON.stringify(pathDiagnostic).includes('secret-requisition-id')
        && !JSON.stringify(pathDiagnostic).includes('tracking'),
      'link diagnostics retain safe route vocabulary while redacting opaque path and query tokens');
      return { route: parsed.pathname, repaired: diagnostic.repaired };
    },
  },
];
