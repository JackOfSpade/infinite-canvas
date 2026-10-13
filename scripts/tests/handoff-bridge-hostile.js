import { assert } from './testHelpers.js';
import {
  buildResumeDocument,
  fs,
      JSDOM,
      PDFDocument,
    sanitizeDocumentMainHtml,
} from '../test-dependencies.js';
import {
  APPLICATION_QUALITY_CHECKLIST_VERSION,
  APPLICATION_QUALITY_CRITERIA,
  __setLocalAiRenderPdfForTests,
  LOCAL_AI_GENERATION_AUDIT_VERSION,
} from '../../electron/ipc/localAiApplication.js';
import {  REJECTED_CAUTION } from '../../electron/ipc/handoffBridge/framing.js';

const HOSTILE_DOCUMENT_TEXT = 'Maintained reliable internal systems for users. <script>x()</script><img src=https://example.com/x>javascript:x()url(https://example.com/x)';
const HOSTILE_REJECTED_TEXT = `<script>x()</script><img src=https://example.com/x>javascript:x()url(https://example.com/x) ${'q'.repeat(260)}`;
const HOSTILE_REJECTED_TEXT_TWO = `<script>x()</script><img src=https://example.com/x>javascript:x()url(https://example.com/x) ${'r'.repeat(260)}`;
const HOSTILE_MARKERS = Object.freeze([
  '<script>', '<img src=https://example.com/x>', 'javascript:x()', 'url(https://example.com/x)',
]);
const IDENTITY = Object.freeze({
  name: 'Ada Lovelace', contact: Object.freeze(['ada@example.com']), subtitleRole: 'Engineer', credential: '',
});
const LETTER_SENTENCES = Object.freeze([
  'My experience delivering supported systems is a relevant capability.',
  'In my engineering role at Example Co, I updated supported systems for internal users.',
  'I would apply my experience delivering supported systems to reliable system delivery this role requires.',
]);
const LETTER_TEXT = LETTER_SENTENCES.join(' ');
const CAREER_DATA = [
  'Ada Lovelace', 'ada@example.com', 'Engineer', HOSTILE_DOCUMENT_TEXT, LETTER_TEXT,
].join('\n');





function hostileMainHtml() {
  return `<main class="page" onclick="x()"><section class="section" style="background-image:url(https://example.com/style.css)"><p onmouseover="x()">${HOSTILE_DOCUMENT_TEXT}</p><script>window.bad=true</script><img src=https://example.com/pixel onerror="x()"><a href="javascript:x()">bad link</a></section></main>`;
}

function withDom(html, fn) {
  const dom = new JSDOM(html);
  try { return fn(dom.window.document); } finally { dom.window.close(); }
}

function activeRemoteReferences(document) {
  const references = [];
  for (const element of document.querySelectorAll('script[src], link[href], img[src], iframe[src], frame[src], object[data], embed[src], source[src], video[src], audio[src], track[src]')) {
    const value = element.getAttribute('src') || element.getAttribute('href') || element.getAttribute('data') || '';
    if (/^https?:\/\//i.test(value)) references.push(value);
  }
  for (const element of document.querySelectorAll('[style], style')) {
    const css = element.getAttribute('style') || element.textContent || '';
    for (const match of css.matchAll(/url\(\s*['"]?\s*(https?:\/\/[^\s'"()]+)\s*['"]?\s*\)/gi)) references.push(match[1]);
  }
  return references;
}

function assertNoActiveHostileMarkup(html, label, { finalDocument = false } = {}) {
  withDom(html, document => {
    const scripts = [...document.querySelectorAll('script')];
    if (finalDocument) {
      assert(scripts.length > 0 && scripts.every(script => script.hasAttribute('nonce') && !script.hasAttribute('src')),
        `${label} must allow only nonce-bound inline host scripts`);
    } else {
      assert(scripts.length === 0, `${label} must contain no script element`);
    }
    const modelSurfaces = finalDocument
      ? [...document.querySelectorAll('.ic-page-stage main.page')]
      : [...document.querySelectorAll('main.page')];
    assert(modelSurfaces.length > 0, `${label} must contain a model document surface`);
    for (const surface of modelSurfaces) {
      assert(surface.querySelectorAll('img, picture, source, iframe, frame, object, embed, form, input, button, textarea, select, svg, math, canvas').length === 0,
        `${label} must contain no model-controlled active element`);
    }
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        assert(!/^on/i.test(attribute.name), `${label} must remove every event-handler attribute`);
        assert(!/^javascript:/i.test(attribute.value), `${label} must remove javascript URLs`);
      }
    }
    const remote = activeRemoteReferences(document);
    assert(remote.every(value => /^https:\/\/(?:fonts\.googleapis\.com|fonts\.gstatic\.com)\//i.test(value)),
      `${label} must not contain non-font remote resource URLs: ${remote.join(', ')}`);
  });
}

function assertHostileMarkers(value, label) {
  for (const marker of HOSTILE_MARKERS) assert(value.includes(marker), `${label} must contain ${marker}`);
}




function assertCsp(policy) {
  assert(policy.includes("default-src 'none'")
    && /script-src 'nonce-[^']+'/.test(policy)
    && !policy.includes("script-src 'unsafe-inline'")
    && policy.includes("img-src 'none'")
    && policy.includes('connect-src http://127.0.0.1:43192')
    && policy.includes("style-src 'unsafe-inline' https://fonts.googleapis.com")
    && policy.includes('font-src https://fonts.gstatic.com'),
  'print CSP must remain default-deny, nonce-only for scripts, and allow only its font and loopback exceptions');
}

function cspFromDocument(html) {
  return withDom(html, document => document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content') || '');
}









export default [
  {
    name: 'handoff bridge: hostile: synthetic corpus carries every required active-content shape',
    run: () => {
      assertHostileMarkers(HOSTILE_DOCUMENT_TEXT, 'saved hostile corpus');
      assertHostileMarkers(HOSTILE_REJECTED_TEXT, 'rejected hostile corpus');
      assertHostileMarkers(HOSTILE_REJECTED_TEXT_TWO, 'second rejected hostile corpus');
      assert(IDENTITY.name === 'Ada Lovelace' && IDENTITY.contact.length === 1 && IDENTITY.contact[0] === 'ada@example.com'
        && !/example\.test/iu.test(`${CAREER_DATA} ${HOSTILE_DOCUMENT_TEXT}`),
      'hostile corpus must use only the approved synthetic Ada/example.com fixture');
    },
  },
  {
    name: 'handoff bridge: hostile: every planted active-content shape fails the saved-markup assertion',
    run: () => {
      const controls = [
        ['script', '<main class="page"><script>x()</script></main>'],
        ['image', '<main class="page"><img src=https://example.com/x></main>'],
        ['javascript URL', '<main class="page"><a href="javascript:x()">bad</a></main>'],
        ['CSS URL', '<main class="page"><p style="background:url(https://example.com/x)">bad</p></main>'],
      ];
      for (const [kind, fixture] of controls) {
        let rejected = false;
        try { assertNoActiveHostileMarkup(fixture, `unsanitized ${kind} positive control`); } catch { rejected = true; }
        assert(rejected, `the active-markup assertion must fail a planted ${kind} fixture`);
      }
    },
  },
  {
    name: 'handoff bridge: hostile: sanitizer removes active tags handlers javascript and CSS URLs',
    run: () => {
      const sanitized = sanitizeDocumentMainHtml(hostileMainHtml());
      assertNoActiveHostileMarkup(sanitized, 'sanitized model main');
      assert(!sanitized.includes('<script') && !sanitized.includes('<img'),
        'sanitizeDocumentMainHtml must remove active hostile elements before final assembly');
    },
  },
  {
    name: 'handoff bridge: hostile: final document build retains only nonce-bound host scripts',
    run: () => {
      const built = buildResumeDocument({ resumeMainHtml: hostileMainHtml(), docId: 'hostile-synthetic' });
      assertNoActiveHostileMarkup(built, 'final built document', { finalDocument: true });
      assertCsp(cspFromDocument(built));
    },
  },
  {
    name: 'handoff bridge: hostile: CSP source pins the deliberate font and loopback allow-list',
    run: () => {
      const source = fs.readFileSync(new URL('../../electron/ipc/resumeHtml.js', import.meta.url), 'utf8');
      assert(source.includes("default-src 'none'")
        && source.includes("`script-src 'nonce-${scriptNonce}'`")
        && source.includes("style-src 'unsafe-inline' https://fonts.googleapis.com")
        && source.includes('font-src https://fonts.gstatic.com')
        && source.includes('connect-src http://127.0.0.1:43192')
        && source.includes("img-src 'none'"),
      'resume CSP source must pin every deliberate exception');
      assert(!source.includes("script-src 'unsafe-inline'"), 'resume CSP must never allow un-nonced scripts');
    },
  },
  {
    name: 'handoff bridge: hostile: print BrowserWindow source keeps sandbox enabled',
    run: () => {
      const source = fs.readFileSync(new URL('../../electron/ipc/resumeRender.js', import.meta.url), 'utf8');
      assert(source.includes(`webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,`),
        'the print BrowserWindow must retain sandbox: true (live request observation is manual M21)');
    },
  },
      ];
