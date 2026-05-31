/**
 * Shared browser overlay for job scraper sessions.
 *
 * buildOverlayScript({ withPause, cdpBridge }) — returns the IIFE string to
 *   inject into the page via evaluateOnNewDocument + evaluate.
 *   - withPause:true adds the ⏸ Pause button; false gives a display-only panel.
 *   - cdpBridge:true wires the button to the Puppeteer-exposed __icSetPaused /
 *     __icGetPaused functions. Those install a CDP Runtime.addBinding, which is
 *     an automation fingerprint anti-bots (DataDome/Cloudflare) read — so set
 *     cdpBridge:false to keep the button but have it only toggle the page-local
 *     window.__icPaused, which the Node side reads by POLLING (no binding).
 *
 * updateOverlay(page, state) — updates the visible panel fields. All fields
 *   are optional; omitted fields are left unchanged.
 *   state: { srcLabel, srcName, qLabel, qText, count, status, progressText, challenge, error }
 */

export function buildOverlayScript({ withPause = true, cdpBridge = true } = {}) {
  const buttonStyles = withPause
    ? `'#__ic-panel button:hover:not(:disabled){filter:brightness(1.2)}',
    '#__ic-panel button:disabled{opacity:.4;cursor:default}',`
    : '';

  const statusMargin = withPause ? '14' : '4';

  const buttonHTML = withPause
    ? `'<button id="ic-pause" style="width:100%;padding:7px 10px;background:rgba(255,255,255,.06);',
      'color:#64748b;border:1px solid rgba(255,255,255,.09);border-radius:7px;',
      'cursor:pointer;font:500 12px system-ui;transition:filter .15s">⏸ Pause</button>',`
    : '';

  // CDP-bridge restore: only emitted when cdpBridge is on. It reads the Node-side
  // flag back into the page after a navigation via the exposed __icGetPaused. With
  // cdpBridge off there's no exposed function (it would be an automation
  // fingerprint), so the Node side re-asserts paused state by pushing it in after
  // each overlay (re)injection instead — see injectOverlay() in manualScraper.js.
  const restoreLogic = (withPause && cdpBridge) ? `
  (function restorePause(attempts) {
    if(typeof window.__icGetPaused !== 'function') {
      if(attempts > 0) setTimeout(function(){ restorePause(attempts - 1); }, 50);
      return;
    }
    window.__icGetPaused().then(function(p){
      window.__icPaused = !!p;
      var btn = el.querySelector('#ic-pause');
      if(btn) btn.textContent = p ? '\\u25b6 Resume' : '\\u23f8 Pause';
      var dot = document.getElementById('ic-dot');
      if(dot && p){ dot.style.background = '#eab308'; dot.style.animation = 'none'; }
    });
  })(10);
` : '';

  const pauseLogic = withPause ? `
  window.__icPaused = false;
  el.querySelector('#ic-pause').addEventListener('click', function(){
    if(this.disabled) return;
    window.__icPaused = !window.__icPaused;
    ${cdpBridge ? 'if(window.__icSetPaused) window.__icSetPaused(window.__icPaused);' : '/* no CDP bridge — Node polls window.__icPaused */'}
    this.textContent = window.__icPaused ? '\\u25b6 Resume' : '\\u23f8 Pause';
    const dot = document.getElementById('ic-dot');
    if(dot){
      if(window.__icPaused){
        dot.style.background = '#eab308';
        dot.style.animation  = 'none';
      } else {
        dot.style.background = '#4ade80';
        dot.style.animation  = 'ic-blink 1.4s ease-in-out infinite';
      }
    }
  });
${restoreLogic}` : '';

  return `(function(){
  if(document.getElementById('__ic-panel')) return;
  // On google.com, only inject on actual search results pages. This prevents
  // the overlay from appearing inside reCAPTCHA iframes (/recaptcha/enterprise/bframe),
  // the CAPTCHA gate page (/sorry), or any other google.com URL that isn't job results.
  if(location.hostname==='www.google.com' && !location.pathname.startsWith('/search')) return;
  // Trusted Types probe — must run before any side effects (window writes, DOM inserts).
  // Cloudflare challenge pages enforce require-trusted-types-for 'script', which blocks
  // el.innerHTML assignments. Detect this early so we leave the challenge page's DOM and
  // window completely untouched (style injection would otherwise contaminate the Turnstile
  // iframe and disrupt bot-detection fingerprinting).
  try { var _tt=document.createElement('div'); _tt.innerHTML=''; } catch(e) { return; }
  const sty = document.createElement('style');
  sty.textContent = [
    '@keyframes ic-blink{0%,100%{opacity:1}50%{opacity:.35}}',
    '@keyframes ic-pulse{0%,100%{opacity:1}50%{opacity:.45}}',
    ${buttonStyles}
  ].join('');
  var _root=document.head||document.documentElement; if(_root) _root.appendChild(sty);

  const el = document.createElement('div');
  el.id = '__ic-panel';
  el.style.cssText = [
    'position:fixed;bottom:max(12px,env(safe-area-inset-bottom));right:max(12px,env(safe-area-inset-right));transform:translateY(-33.3333%);z-index:2147483647',
    'background:#0f172a;color:#e2e8f0;border-radius:14px',
    'padding:18px 20px;width:min(272px,calc(100vw - 24px));max-width:calc(100vw - 24px);box-sizing:border-box',
    'font:13px/1.5 system-ui,-apple-system,sans-serif',
    'box-shadow:0 16px 48px rgba(0,0,0,.8);border:1px solid rgba(255,255,255,.1)',
    'max-height:calc(100vh - 24px);overflow:hidden',
    'pointer-events:auto',
  ].join(';');

  try { el.innerHTML = [
    '<div style="display:flex;align-items:center;gap:7px;margin-bottom:9px">',
      '<div id="ic-dot" style="width:9px;height:9px;border-radius:50%;background:#4ade80;',
        'animation:ic-blink 1.4s ease-in-out infinite;flex-shrink:0"></div>',
      '<b style="font-size:13px;letter-spacing:-.2px">Job Collector</b>',
    '</div>',
    '<div id="ic-src-label" style="font-size:11px;color:#475569;margin-bottom:1px"></div>',
    '<div id="ic-src-name" style="font-weight:700;font-size:16px;margin-bottom:3px;',
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis"></div>',
    '<div id="ic-q-label" style="font-size:11px;color:#64748b;margin-bottom:2px"></div>',
    '<div id="ic-q-text" style="font-size:12px;color:#94a3b8;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;margin-bottom:11px"></div>',
    '<div style="display:flex;align-items:baseline;gap:6px;margin-bottom:4px">',
      '<span id="ic-count" style="font-size:32px;font-weight:800;line-height:1;color:#f8fafc">0</span>',
      '<span id="ic-count-meta" style="font-size:12px;color:#64748b">jobs collected</span>',
    '</div>',
    '<div id="ic-status" style="font-size:11px;color:#64748b;margin-bottom:${statusMargin}px;min-height:16px;',
      'line-height:1.55"></div>',
    ${buttonHTML}
  ].join(''); } catch(e) { return; }
  ${pauseLogic}
  const attach = () => {
    if(typeof window.INDEED_CLOUDFLARE_STATIC_PAGE !== 'undefined') return;
    if(document.body && !document.getElementById('__ic-panel')) document.body.appendChild(el);
  };
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attach);
  else attach();
})()`;
}

export async function updateOverlay(page, state) {
  await page.evaluate((s) => {
    const p = document.getElementById('__ic-panel');
    if (!p) return;
    const g   = id => p.querySelector('#' + id);
    const set = (id, v) => { const e = g(id); if (e && v != null) e.textContent = v; };

    set('ic-src-label', s.srcLabel);
    set('ic-src-name',  s.srcName);
    set('ic-q-label',   s.qLabel);
    set('ic-q-text',    s.qText);
    if (s.count != null) set('ic-count', s.count);
    set('ic-count-meta', s.progressText ?? 'jobs collected');
    set('ic-status',    s.status ?? '');

    const dot = g('ic-dot');
    if (dot) {
      if (s.error) {
        dot.style.background = '#ef4444';
        dot.style.animation  = 'none';
      } else if (s.challenge) {
        dot.style.background = '#f59e0b';
        dot.style.animation  = 'ic-pulse 1s ease-in-out infinite';
      } else {
        dot.style.background = '#4ade80';
        dot.style.animation  = 'ic-blink 1.4s ease-in-out infinite';
      }
    }
  }, state).catch(() => {});
}
