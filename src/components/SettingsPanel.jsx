import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Settings, Zap, Scale, Sparkles,
  Grid3x3, Map, Keyboard, RotateCcw, Check,
  ShoppingBag, LogIn, Eye, Loader2, Briefcase,
} from 'lucide-react';
import { ANIMATION_DURATIONS, DEFAULT_SHORTCUTS } from '../hooks/useSettings';
import { useSyncWhileFocused } from '../hooks/useSyncWhileFocused';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import { useToast } from './ToastProvider';
import { SELL_PLATFORMS, SELL_PLATFORM_BY_ID, JOB_SOURCES, JOB_SOURCE_BY_ID } from '../utils/constants';
import { normalizeMarketplaceWatchUrls } from '../utils/marketplaceWatchUrls';
import { PlatformBadge } from './PlatformBadge';
import { updateModalCount } from './modalStack';
import { ConfirmDialog } from './ConfirmDialog';

const SPEED_OPTIONS = [
  { key: 'snappy',   label: 'Snappy',   desc: `${ANIMATION_DURATIONS.snappy}ms`,   icon: Zap,      color: 'text-amber-400' },
  { key: 'balanced', label: 'Balanced', desc: `${ANIMATION_DURATIONS.balanced}ms`, icon: Scale,    color: 'text-blue-400' },
  { key: 'dramatic', label: 'Dramatic', desc: `${ANIMATION_DURATIONS.dramatic}ms`, icon: Sparkles, color: 'text-purple-400' },
];

const BG_OPTIONS = [
  { key: 'dots',  label: 'Dots' },
  { key: 'lines', label: 'Grid' },
  { key: 'none',  label: 'None' },
];

// Claude family tiers, most-to-least capable — mirrors electron/ipc/
// modelResolver.js's CLAUDE_FAMILY_LADDER. Duplicated as plain strings
// (renderer code can't import the main-process module), so keep this in
// sync by hand if a family is ever added/removed there.
const CLAUDE_FAMILY_OPTIONS = [
  { token: 'FABLE',  label: 'Fable',  desc: 'highest tier · ~2x Opus price' },
  { token: 'OPUS',   label: 'Opus',   desc: 'most capable' },
  { token: 'SONNET', label: 'Sonnet', desc: 'balanced' },
  { token: 'HAIKU',  label: 'Haiku',  desc: 'fastest & cheapest' },
];

// The live API task GROUPS a Claude family is picked for (llm.js TASK_GROUPS) —
// `defaultToken` mirrors llm.js's GROUP_DEFAULT_FAMILY so the "(default)"
// hint in each dropdown stays accurate without an extra IPC round trip.
const CLAUDE_MODEL_GROUPS = [
  {
    key: 'judgment', label: 'Judgment', defaultToken: 'OPUS',
    note: 'Pricing and bundle-price decisions. Job scoring and compensation research use the manual non-API handoff instead.',
  },
  {
    key: 'extraction', label: 'Extraction', defaultToken: 'SONNET',
    note: 'Vision/product analysis, plus fallback for unmapped tasks. Résumé parsing, query generation, and job bucketing use the manual non-API handoff instead.',
  },
  {
    key: 'light', label: 'Light', defaultToken: 'HAIKU',
    note: 'Platform-fit and page-status checks, marketplace hub scans, and light text edits.',
  },
];

const AI_PROVIDER_OPTIONS = [
  { key: 'gemini', label: 'Gemini API' },
  { key: 'claude', label: 'Claude API' },
];

const isMac = (() => {
  const p = navigator.userAgentData?.platform ?? navigator.platform ?? '';
  return p.toLowerCase().includes('mac');
})();

/** Format a shortcut binding into a human-readable string like ⌘⇧Z */
function formatBinding(binding) {
  if (!binding) return '—';
  const parts = [];
  if (binding.meta)  parts.push(isMac ? '⌘' : 'Ctrl');
  if (binding.shift) parts.push(isMac ? '⇧' : 'Shift');
  if (binding.alt)   parts.push(isMac ? '⌥' : 'Alt');
  parts.push(binding.key.toUpperCase());
  return parts.join(isMac ? '' : '+');
}

/** Inline key-capture widget for a single shortcut. */
function ShortcutRow({ id, binding, onSave, isCapturing, onStartCapture, onCancelCapture }) {
  const label = DEFAULT_SHORTCUTS[id]?.label ?? id;

  // While capturing, listen for the next key combination
  useEffect(() => {
    if (!isCapturing) return;
    const handler = (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Escape (and Tab) cancel capture rather than being bound as the shortcut.
      // This capture-phase listener stopPropagation()s, so the panel-level Escape
      // handler never sees the event — cancel must happen here.
      if (e.key === 'Escape' || e.key === 'Tab') { onCancelCapture(); return; }
      // Ignore bare modifier presses
      if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
      onSave(id, {
        meta:  e.metaKey || e.ctrlKey,
        shift: e.shiftKey,
        alt:   e.altKey,
        key:   e.key.toLowerCase(),
        label,
      });
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [isCapturing, id, label, onSave, onCancelCapture]);

  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-white/60 text-xs">{label}</span>
      <div className="flex items-center gap-1.5">
        {isCapturing ? (
          <>
            <span className="text-[10px] text-blue-400 animate-pulse font-medium">Press shortcut…</span>
            <button
              onClick={onCancelCapture}
              className="text-white/30 hover:text-white/60 transition p-0.5"
            >
              <X size={12} />
            </button>
          </>
        ) : (
          <button
            onClick={() => onStartCapture(id)}
            className="text-[10px] text-white/40 bg-white/5 border border-white/10 rounded px-2 py-0.5
                       font-mono hover:bg-white/10 hover:text-white/70 transition-all"
          >
            {formatBinding(binding)}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Per-platform marketplace monitor block. Two responsibilities per platform:
 *
 *   1. Log in to that marketplace so subsequent status checks can read pages
 *      that require auth (dashboards, notification centers). Reuses the
 *      existing `openLoginWindow` IPC, which persists cookies in the stealth
 *      browser's userDataDir — one login lasts until cookies expire.
 *
 *   2. Add platform-wide "watch URLs" the Marketplace Status Module scans once
 *      per check. These are typically:
 *        - the seller dashboard / active-listings page
 *        - a notifications / activity feed
 *        - a sold-items tab
 *      All configured pages feed one consolidated account-wide scan.
 */
/**
 * Three-state session pill shared by the marketplace-monitor and job-board
 * login rows: in-flight verification → connected (re-login) → logged out.
 * One home so the two sections render login state identically and can't drift.
 */
function LoginStatusPill({ pending, connected, sessionNoun, onClick }) {
  if (pending) {
    return (
      <span
        className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border bg-white/[0.04] border-white/10 text-white/50 select-none"
        title="Verifying session…"
      >
        <Loader2 size={10} className="animate-spin" />
        Verifying<span className="login-pending-dots" />
      </span>
    );
  }
  return connected ? (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors bg-emerald-500/10 border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20"
      title={`Re-open login window to refresh this ${sessionNoun} session`}
    >
      <Check size={10} />
      Re-login
    </button>
  ) : (
    <button
      onClick={onClick}
      className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors bg-blue-500/10 border-blue-500/30 text-blue-300 hover:bg-blue-500/20"
      title={`Open a window to log into this ${sessionNoun}`}
    >
      <LogIn size={10} />
      Log in
    </button>
  );
}

/**
 * Shared "open login window → adopt verdict → toast the reason" flow for both
 * login sections. The open-login-window IPC returns the verify verdict inline
 * ({ connected, reason }) — no second roundtrip — and surfacing the reason
 * tells the user WHY a login didn't stick (e.g. "Redirected to /signin —
 * login not completed"), the difference between "I think nothing happened"
 * and "oh, the verifier hit a seller-only page and bounced." A plain async
 * function rather than a hook so each section keeps its own state inline.
 */
async function runLoginWindowFlow({ platformId, niceName, setAuthByPlatform, setPendingByPlatform, addToast }) {
  setPendingByPlatform(prev => ({ ...prev, [platformId]: true }));
  try {
    const res = await window.electronAPI?.openLoginWindow?.({ platformId });
    const connected = !!res?.connected;
    setAuthByPlatform(prev => ({ ...prev, [platformId]: connected }));
    if (connected) {
      addToast({ title: `${niceName}: logged in`, description: res?.reason || 'Session verified.', type: 'success' });
    } else {
      addToast({ title: `${niceName}: login not verified`, description: res?.reason || 'Closed the login window without completing sign-in. Try again.', type: 'error' });
    }
  } catch (err) {
    addToast({ title: 'Login failed', description: err?.message || String(err), type: 'error' });
  } finally {
    setPendingByPlatform(prev => ({ ...prev, [platformId]: false }));
  }
}

/**
 * One platform's row. Owns its own textarea state via useSyncWhileFocused so:
 *   - Async settings load AFTER panel open populates the textarea (the old
 *     useState-initializer approach captured the empty initial map forever,
 *     then onBlur clobbered the real saved URLs with an empty list).
 *   - In-flight typing isn't wiped by an unrelated settings update.
 */
function PlatformWatchUrlsRow({ platform, urls, connected, pending, onLogin, onChangeUrls }) {
  const joined = (urls || []).join('\n');
  const { value, setValue, focusProps } = useSyncWhileFocused(joined);

  const handleBlur = () => {
    focusProps.onBlur();
    const lines = normalizeMarketplaceWatchUrls((value || '').split(/\r?\n/));
    onChangeUrls(platform.id, lines);
    setValue(lines.join('\n'));
  };

  // Live count from the editor reflects unsaved edits — friendlier than
  // showing the persisted count while the user is mid-typing.
  const liveCount = normalizeMarketplaceWatchUrls((value || '').split(/\r?\n/)).length;

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <PlatformBadge name={platform.name} letter={platform.letter} color={platform.color} domain={platform.domain} size={20} />
        <div className="flex-1 text-white/80 text-xs font-semibold">{platform.name}</div>
        <LoginStatusPill
          pending={pending}
          connected={connected}
          sessionNoun="marketplace"
          onClick={() => onLogin(platform.id)}
        />
      </div>
      <div>
        <div className="flex items-center gap-1.5 mb-1">
          <Eye size={10} className="text-white/30" />
          <span className="text-white/40 text-[10px] font-semibold uppercase tracking-wider">
            Watch URLs ({liveCount})
          </span>
        </div>
        <textarea
          rows={3}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={focusProps.onFocus}
          onBlur={handleBlur}
          placeholder={`e.g.\nhttps://www.${platform.domain}/seller/dashboard\nhttps://www.${platform.domain}/notifications`}
          className="w-full bg-black/40 border border-white/10 rounded px-2 py-1.5 text-white/80 text-[10px] outline-none focus:border-blue-400/50 font-mono leading-relaxed resize-none"
        />
        <div className="text-white/30 text-[9px] mt-1 leading-snug">
          One URL per line. Marketplace Status scans these logged-in dashboard, notification, and message pages once per platform.
        </div>
      </div>
    </div>
  );
}

// IDs of the browser-scraped platforms that require login.
// LinkedIn remains available here as an optional session utility, but job search
// no longer requires it: listings and description enrichment use public guest
// endpoints and handle guest rate limits on the source card.
const JOB_LOGIN_IDS = ['linkedin', 'google', 'indeed', 'glassdoor', 'ziprecruiter'];
const JOB_LOGIN_PLATFORMS = JOB_SOURCES.filter(s => JOB_LOGIN_IDS.includes(s.id));
const NATIVE_READ_MARKETPLACE_NAMES = SELL_PLATFORMS
  .filter(p => ['mercari', 'swappa'].includes(p.id))
  .map(p => p.name)
  .join(' and ');

function JobPlatformLoginsSection() {
  const [authByPlatform, setAuthByPlatform] = useState({});
  const [pendingByPlatform, setPendingByPlatform] = useState({});
  const [resetTarget, setResetTarget] = useState(null);
  const { addToast } = useToast();

  useEffect(() => {
    let cancelled = false;
    Promise.all(JOB_LOGIN_PLATFORMS.map(async (p) => {
      try {
        const res = await window.electronAPI?.checkJobPlatformAuth?.({ platformId: p.id });
        return [p.id, !!res?.connected];
      } catch { return [p.id, false]; }
    })).then(entries => {
      if (!cancelled) setAuthByPlatform(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, []);

  const handleLogin = useCallback((platformId) => runLoginWindowFlow({
    platformId,
    niceName: JOB_SOURCE_BY_ID[platformId]?.name || platformId,
    setAuthByPlatform,
    setPendingByPlatform,
    addToast,
  }), [addToast]);

  const handleReset = useCallback(async () => {
    const platformId = resetTarget;
    if (!platformId) return;
    setResetTarget(null);
    setPendingByPlatform(prev => ({ ...prev, [platformId]: true }));
    try {
      const res = await window.electronAPI?.resetPlatformSession?.({ platformId });
      if (!res?.success) throw new Error(res?.reason || res?.error || 'The session could not be reset.');
      setAuthByPlatform(prev => ({ ...prev, [platformId]: false }));
      addToast({
        title: 'Indeed session reset',
        description: 'Indeed cookies and saved site data were cleared. Other platform sessions were left unchanged; log in to Indeed again before searching.',
        type: 'success',
      });
    } catch (err) {
      addToast({
        title: 'Indeed reset failed',
        description: err?.message || String(err),
        type: 'error',
      });
    } finally {
      setPendingByPlatform(prev => ({ ...prev, [platformId]: false }));
    }
  }, [resetTarget, addToast]);

  return (
    <div className="space-y-3">
      {JOB_LOGIN_PLATFORMS.map(platform => (
        <div key={platform.id} className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
          <div className="flex items-center gap-2">
            <PlatformBadge name={platform.name} letter={platform.letter} color={platform.color} domain={platform.domain} size={20} />
            <div className="flex-1 text-white/80 text-xs font-semibold">{platform.name}</div>
            {platform.id === 'indeed' && (
              <button
                onClick={() => setResetTarget(platform.id)}
                disabled={!!pendingByPlatform[platform.id]}
                className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors bg-white/[0.03] border-white/10 text-white/40 hover:bg-white/[0.08] hover:text-white/70 disabled:opacity-40"
                title="Sign out of Indeed and clear only Indeed cookies and saved site data"
              >
                <RotateCcw size={10} />
                Reset site
              </button>
            )}
            <LoginStatusPill
              pending={!!pendingByPlatform[platform.id]}
              connected={authByPlatform[platform.id]}
              sessionNoun="job board"
              onClick={() => handleLogin(platform.id)}
            />
          </div>
        </div>
      ))}
      {resetTarget && (
        <ConfirmDialog
          title="Reset Indeed session?"
          message="This signs you out of Indeed and clears cookies and saved site data for indeed.com only. Google, LinkedIn, and marketplace sessions are unchanged. Close any open Indeed login or verification window first."
          confirmLabel="Reset Indeed"
          cancelLabel="Keep session"
          variant="warning"
          onConfirm={handleReset}
          onCancel={() => setResetTarget(null)}
        />
      )}
    </div>
  );
}

function MarketplaceMonitorSection({ watchUrlsByPlatform, onChangeWatchUrls }) {
  const [authByPlatform, setAuthByPlatform] = useState({});
  // Per-platform in-flight flag — drives the "Verifying…" pill so the user
  // sees that the click registered even during the post-window verify gap
  // (window auto-closes, then verifySellMonitorLogin runs ~2s before the
  // cache updates and the button can flip to "Logged in").
  const [pendingByPlatform, setPendingByPlatform] = useState({});
  const { addToast } = useToast();

  // Refresh auth status for every platform on mount. The cached IPC is cheap
  // (reads a JSON file); the full Chrome-backed check fires when the user
  // clicks "Log in" so we don't launch Chrome just to render this panel.
  useEffect(() => {
    let cancelled = false;
    Promise.all(SELL_PLATFORMS.map(async (p) => {
      try {
        const res = await window.electronAPI?.checkSellMonitorAuth?.({ platformId: p.id });
        return [p.id, !!res?.connected];
      } catch { return [p.id, false]; }
    })).then(entries => {
      if (cancelled) return;
      setAuthByPlatform(Object.fromEntries(entries));
    });
    return () => { cancelled = true; };
  }, []);

  const handleLogin = useCallback((platformId) => runLoginWindowFlow({
    platformId,
    niceName: SELL_PLATFORM_BY_ID[platformId]?.name || platformId,
    setAuthByPlatform,
    setPendingByPlatform,
    addToast,
  }), [addToast]);

  return (
    <div className="space-y-3">
      {SELL_PLATFORMS.map(p => (
        <PlatformWatchUrlsRow
          key={p.id}
          platform={p}
          urls={watchUrlsByPlatform?.[p.id] || []}
          connected={authByPlatform[p.id]}
          pending={!!pendingByPlatform[p.id]}
          onLogin={handleLogin}
          onChangeUrls={onChangeWatchUrls}
        />
      ))}
    </div>
  );
}

/** Seconds → "Xs" / "Ym Zs". */
function fmtSecLeft(s) {
  if (s == null) return null;
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ''}` : `${s}s`;
}

/**
 * Per-provider availability card: a live "Check availability" button plus the
 * last verdict. Claude shows REAL remaining/limit/reset pulled from the response
 * headers; Gemini shows real RPM/RPD/TPM from Cloud Monitoring when a service
 * account is configured, or ping-only when using only an API key.
 * Presentational only.
 */
function AIProviderStatus({ provider, status, checking, onCheck }) {
  const probe = status?.lastProbe || null;
  const tele = status?.telemetry || null;
  const isClaude = provider === 'claude';
  const hasQuotaStats = !isClaude && (probe?.hasQuotaStats === true);

  const line = (label, b) => b && (
    <div>{label}: <span className="text-white/65">{b.remaining ?? '?'}</span> / {b.limit ?? '?'} left{b.resetInSec != null ? ` · resets ${fmtSecLeft(b.resetInSec)}` : ''}</div>
  );

  // Verdict for a SINGLE probe result (Claude per-model, or the one Gemini probe).
  // The model name is rendered separately, so the text here omits it.
  const verdictFor = (p) => {
    if (!p) return null;
    if (p.ok) return { cls: 'text-emerald-400', text: '✅ Available' };
    const prl = p.rateLimit || null;
    if (p.classification === 'no-quota') {
      return { cls: 'text-red-400', text: '❌ No quota allocated — dashboard 0 / 0 is not consumed usage' };
    }
    if (p.classification === 'daily-quota') {
      return { cls: 'text-amber-400', text: '⚠️ Daily quota exhausted' };
    }
    if (p.status === 429) {
      const hint = isClaude
        ? (prl?.requests?.resetInSec != null ? `resets in ${fmtSecLeft(prl.requests.resetInSec)}` : '')
        : (p.retryAfterMs != null ? `retry in ${fmtSecLeft(Math.round(p.retryAfterMs / 1000))}` : '');
      return { cls: 'text-amber-400', text: `⚠️ Temporarily rate-limited${hint ? ` — ${hint}` : ''}` };
    }
    if (p.status === 401) return { cls: 'text-red-400', text: '❌ Invalid or unauthorized API key' };
    // A 403 can mean a bad key OR that this specific model isn't enabled for the
    // key/project (a Pro preview that needs allow-listing). The fallback chain
    // keeps using the other models, so don't imply the whole key is dead.
    if (p.status === 403) return { cls: 'text-red-400', text: '❌ Unauthorized — key invalid or this model not enabled for it' };
    return { cls: 'text-red-400', text: `❌ ${p.error || `Error ${p.status ?? ''}`}` };
  };

  // Backward-compatible rendering for an older single-model Gemini probe.
  // Current Gemini and Claude checks both render their per-model rows above.
  const geminiVerdict = (!isClaude && probe && !probe.models) ? (() => {
    const v = verdictFor(probe);
    if (v && probe.ok && probe.model) v.text = `✅ Available — ${probe.model} responded`;
    return v;
  })() : null;

  /** Render a single quota stat cell: "6 / 5" with amber when over limit.
   *  Comparison always runs on the raw numbers — `format` only affects display,
   *  so a K-formatted limit can't defeat the `>=` check (NaN) or get compared
   *  lexicographically as a string. */
  const QuotaCell = ({ used, limit, format }) => {
    if (used == null || limit == null) return <span className="text-white/30">—</span>;
    const over = limit > 0 && used >= limit;
    const display = format || ((n) => n.toLocaleString());
    return (
      <span className={over ? 'text-amber-400 font-semibold' : 'text-white/60'}>
        {display(used)} / {display(limit)}
        {over && <span className="ml-0.5">⚠️</span>}
      </span>
    );
  };

  /** Format large token numbers as e.g. "87.4K" */
  function fmtK(n) {
    if (n == null) return null;
    return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  }

  return (
    <div className="mt-1 pt-2 border-t border-white/5 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-white/50 text-[11px]">Availability</div>
        <button
          onClick={() => onCheck(provider)}
          disabled={checking}
          className="px-2 py-1 rounded-md bg-blue-500/20 hover:bg-blue-500/30 disabled:opacity-50 text-blue-300 text-[10px] font-medium border border-blue-500/30 transition-colors"
        >
          {checking ? 'Checking…' : 'Check availability'}
        </button>
      </div>

      {/* Models list */}
      {probe?.models && (
        <div className="space-y-2">
          <div className="text-white/40 text-[10px]">
            {isClaude
              ? 'Per model in use (Anthropic rate limits are per-model):'
              : hasQuotaStats
                ? 'Per model in use (live usage from Cloud Monitoring API — peak last 25h):'
                : 'Per model in use (Gemini fallback chain):'
            }
          </div>
          {probe.models.map((m, i) => {
            const v = verdictFor(m);
            const mrl = m.rateLimit || null;
            const qs = m.quotaStats || null;
            return (
              <div key={m.model || i} className="space-y-0.5">
                <div className="text-[11px] font-medium leading-snug">
                  <span className="text-white/70 font-mono">{m.model || '(unknown model)'}</span>
                  {v && <> — <span className={v.cls}>{v.text}</span></>}
                </div>
                {/* Claude per-model rate limit rows */}
                {mrl && isClaude && (
                  <div className="text-white/45 text-[10px] leading-relaxed font-mono pl-3">
                    {line('requests', mrl.requests)}
                    {line('tokens', mrl.tokens)}
                    {line('input tok', mrl.input_tokens)}
                    {line('output tok', mrl.output_tokens)}
                  </div>
                )}
                {/* Gemini Cloud Monitoring quota stats */}
                {qs && !isClaude && (
                  <div className="text-[10px] leading-relaxed font-mono pl-3 flex flex-wrap gap-x-3 gap-y-0.5">
                    {qs.rpm && (
                      <span className="text-white/40">
                        RPM: <QuotaCell used={qs.rpm.used} limit={qs.rpm.limit} />
                      </span>
                    )}
                    {qs.rpd && (
                      <span className="text-white/40">
                        RPD: <QuotaCell used={qs.rpd.used} limit={qs.rpd.limit} />
                      </span>
                    )}
                    {qs.tpm && (
                      <span className="text-white/40">
                        TPM: <QuotaCell used={qs.tpm.used} limit={qs.tpm.limit} format={fmtK} />
                      </span>
                    )}
                    {/* These figures are project-wide, not model-specific — say so
                        rather than implying each model has its own numbers. */}
                    {qs.scope === 'project' && (qs.rpm || qs.rpd || qs.tpm) && (
                      <span className="text-white/25" title="Reported at the project level by Cloud Monitoring — not a per-model breakdown. See Google's dashboard for model-specific limits (e.g. Pro at 0/0).">project-wide</span>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {!isClaude && geminiVerdict && <div className={`text-[11px] font-medium ${geminiVerdict.cls}`}>{geminiVerdict.text}</div>}

      {!isClaude && (
        <div className="text-white/40 text-[10px] leading-relaxed space-y-0.5">
          {Array.isArray(tele?.compatibleModels) && tele.compatibleModels.length > 0 && (
            <div>Compatible fallback catalog: <span className="text-white/55">{tele.compatibleModels.length}</span></div>
          )}
          {/* Entitlement-gated tiers (Pro). Reported from a live minimal probe,
              not a hard-coded assumption — so "why isn't it using Pro?" has a
              visible, checkable answer instead of being invisible app policy.
              `lastProbe.tierEntitlement` is the fresh Check-availability result;
              `tele.tierEntitlement` is the cached verdict the cascade is using. */}
          {(probe?.tierEntitlement || tele?.tierEntitlement || []).map((t) => (
            <div key={t.tier}>
              <span className="capitalize">{t.tier}</span> tier:{' '}
              {t.allowed
                ? <span className="text-emerald-400/70">available — leads the quality chain</span>
                : <span className="text-white/45">{t.known ? 'not available on this key (no quota) — chain starts at Flash' : 'not checked yet'}</span>}
              {t.model && <span className="text-white/30 font-mono"> ({t.model})</span>}
            </div>
          ))}
          {tele?.lastSuccessfulModel && tele.lastSuccessfulModel !== '(none)' && (
            <div>Last success: <span className="text-white/55">{tele.lastSuccessfulModel}</span></div>
          )}
          {tele?.lastAttemptedError && tele.lastAttemptedError !== '(none)' && (
            <div className="text-amber-400/70 truncate" title={tele.lastAttemptedError}>Last error: {tele.lastAttemptedError.slice(0, 90)}</div>
          )}
          {Array.isArray(tele?.warnings) && tele.warnings.length > 0 && (
            <div className="pt-1 space-y-1">
              <div className="text-amber-400/70">Model warnings:</div>
              {tele.warnings.map((warning, i) => (
                <div
                  key={`${warning.model || 'model'}-${warning.type || 'warning'}-${i}`}
                  className="pl-2 text-amber-300/55"
                  title={warning.message}
                >
                  <span className="font-mono">{warning.model}</span>: {String(warning.message || '').slice(0, 160)}
                </div>
              ))}
            </div>
          )}
          <a href="https://aistudio.google.com/rate-limit" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">View quota dashboard ↗</a>
          {hasQuotaStats
            ? <div className="text-emerald-500/50 text-[9px]">✓ Usage data sourced from Cloud Monitoring API — 100% confirmed from Google.</div>
            : <div className="text-white/25 text-[9px]">No service account configured — live checks distinguish available, temporary rate limits, daily exhaustion, and zero allocated quota. Add a service-account.json to see project-wide RPM/RPD/TPM.</div>
          }
        </div>
      )}

      {!probe && <div className="text-white/30 text-[10px]">Click for a live up / rate-limited / bad-key check.</div>}
    </div>
  );
}

/**
 * Application settings panel.
 * Sections: AI, Marketplace Monitors, Animation Speed, View, Keyboard Shortcuts.
 */
export function SettingsPanel({ isOpen, onClose, settings, updateSetting, updateShortcut, resetShortcuts }) {
  const [capturingId, setCapturingId] = useState(null);
  const [aiSettings, setAiSettings] = useState(null);
  const [jobsSettings, setJobsSettings] = useState(null);
  const [watchUrlsByPlatform, setWatchUrlsByPlatform] = useState({});
  const watchUrlsByPlatformRef = useRef(watchUrlsByPlatform);
  const [aiStatus, setAiStatus] = useState({ gemini: null, claude: null });
  const [checkingProvider, setCheckingProvider] = useState(null);
  // Live Claude family -> resolved model id (e.g. { OPUS: 'claude-opus-5', ... }),
  // so each family dropdown option can show proof the always-latest resolver is
  // actually working, not just a static family name. Empty until the IPC round
  // trip resolves — dropdown options render without the id suffix until then.
  const [claudeModelIds, setClaudeModelIds] = useState({});
  useLayoutEffect(() => {
    watchUrlsByPlatformRef.current = watchUrlsByPlatform;
  }, [watchUrlsByPlatform]);

  // Register with the global modal stack while open — unlike Dialog/ConfirmDialog,
  // this component stays mounted at all times (returns null when !isOpen further
  // below), so registration must track the isOpen prop rather than mount/unmount.
  // Without this, undo/redo and canvas keyboard shortcuts stayed live underneath
  // an open Settings panel (Cmd+Z while adjusting a setting silently undid canvas
  // edits behind the dialog).
  useEffect(() => {
    if (!isOpen) return;
    updateModalCount(1);
    return () => updateModalCount(-1);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !window.electronAPI?.getSettings) return;
    let cancelled = false;
    window.electronAPI.getSettings()
      .then((storeData) => {
        if (cancelled) return;
        if (storeData && storeData.ai) setAiSettings(storeData.ai);
        if (storeData && storeData.jobs) setJobsSettings(storeData.jobs);
        if (storeData && storeData.marketplaceWatchUrls) {
          watchUrlsByPlatformRef.current = storeData.marketplaceWatchUrls;
          setWatchUrlsByPlatform(storeData.marketplaceWatchUrls);
        }
      })
      .catch(() => { /* IPC unavailable — leave loading state until next open */ });
    // Last-known AI availability (passive — the button does a live re-check).
    window.electronAPI.getAIStatus?.()
      .then((res) => { if (!cancelled && res?.success) setAiStatus({ gemini: res.gemini || null, claude: res.claude || null }); })
      .catch(() => { /* ignore — card falls back to "click to check" */ });
    // Resolved Claude model ids for the family dropdowns below.
    window.electronAPI.getClaudeModelMap?.()
      .then((res) => { if (!cancelled && res?.success) setClaudeModelIds(res.resolved || {}); })
      .catch(() => { /* ignore — dropdowns still show family names, just without the resolved id */ });
    return () => { cancelled = true; };
  }, [isOpen]);

  const checkAvailability = useCallback(async (provider) => {
    if (!window.electronAPI?.checkAIAvailability) return;
    setCheckingProvider(provider);
    try {
      const res = await window.electronAPI.checkAIAvailability({ provider });
      if (res?.success) {
        setAiStatus(prev => ({
          ...prev,
          [provider]: {
            ...(prev[provider] || {}),
            lastProbe: res,
            ...(res.telemetry ? { telemetry: res.telemetry } : {}),
          },
        }));
      }
    } catch { /* ignore — leave prior status */ }
    finally { setCheckingProvider(null); }
  }, []);

  const updateAISetting = useCallback((key, value) => {
    if (!window.electronAPI?.updateSettings || !aiSettings) return;
    setAiSettings(prev => ({ ...prev, [key]: value }));
    // Send ONLY the changed key — the backend shallow-merges per section, so a
    // single-key payload preserves sibling keys (incl. any the main process
    // wrote at runtime after this panel's snapshot was taken). Echoing back the
    // whole stale section would clobber those concurrent writes. IPC is outside
    // the setState updater so it fires exactly once (strict/concurrent mode may
    // invoke updaters twice, which would double-write).
    window.electronAPI.updateSettings({ ai: { [key]: value } });
  }, [aiSettings]);

  // Sets ONE live API group's Claude family (Judgment/Extraction/Light — llm.js
  // TASK_GROUPS). Persist only the changed group. Sending the entire local
  // object looks harmless, but two quick picker changes can have stale React
  // closures and the second request would overwrite the first group's new
  // value. settings.js owns the deep merge, so this payload preserves changes
  // from another picker (or another renderer) while the local UI updates
  // optimistically.
  const updateClaudeModelGroup = useCallback((group, token) => {
    if (!window.electronAPI?.updateSettings || !aiSettings) return;
    // Merge against React's latest state as well as persisting only this group.
    // Two selections can land before this callback is recreated; using the
    // captured aiSettings object here would leave the panel displaying the
    // second change with the first one visually reverted even though the
    // backend deep-merge correctly saved both.
    setAiSettings(prev => ({
      ...prev,
      claudeModels: { ...(prev?.claudeModels || {}), [group]: token },
    }));
    window.electronAPI.updateSettings({ ai: { claudeModels: { [group]: token } } });
  }, [aiSettings]);

  const updateJobsSetting = useCallback((key, value) => {
    if (!window.electronAPI?.updateSettings || !jobsSettings) return;
    setJobsSettings(prev => ({ ...prev, [key]: value }));
    // Send ONLY the changed key (see updateAISetting): the panel's `jobsSettings`
    // snapshot is taken once on open and never re-synced, so it can hold a stale
    // diceApiKey / glassdoorLocIds that the main process refreshed at runtime
    // (saveDiceApiKey on a Dice 500, saveGlassdoorLocId on a location resolve).
    // Posting the full snapshot would revert those; a single-key payload doesn't.
    window.electronAPI.updateSettings({ jobs: { [key]: value } });
  }, [jobsSettings]);

  const updateMarketplaceWatchUrls = useCallback((platformId, urls) => {
    if (!window.electronAPI?.updateSettings) return;
    const next = { ...watchUrlsByPlatformRef.current, [platformId]: urls };
    watchUrlsByPlatformRef.current = next;
    setWatchUrlsByPlatform(next);
    // IPC must stay outside the React updater: Strict/concurrent rendering may
    // replay updater functions, which previously issued duplicate writes.
    window.electronAPI.updateSettings({ marketplaceWatchUrls: next });
  }, []);

  // Close on Escape (also cancels capturing)
  useEscapeToClose((e) => {
    if (capturingId) { setCapturingId(null); return; }
    e.preventDefault();
    onClose();
  }, { enabled: isOpen });

  // Reset capturing when panel closes
  useEffect(() => {
    if (!isOpen) {
      const timer = setTimeout(() => setCapturingId(null), 0);
      return () => clearTimeout(timer);
    }
  }, [isOpen]);

  const handleSaveShortcut = useCallback((id, newBinding) => {
    updateShortcut(id, newBinding);
    setCapturingId(null);
  }, [updateShortcut]);

  if (!isOpen) return null;

  const shortcuts = settings.shortcuts ?? DEFAULT_SHORTCUTS;

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm confirm-overlay-enter"
      onClick={onClose}
    >
      <div
        className="w-[420px] max-h-[85vh] bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden onboarding-panel flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-2.5">
            <Settings size={18} className="text-blue-400" />
            <h2 className="text-white text-sm font-semibold">Settings</h2>
          </div>
          <button onClick={onClose} className="text-white/30 hover:text-white/70 transition-colors p-1">
            <X size={16} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="px-6 py-5 space-y-6 overflow-y-auto custom-scrollbar flex-1">

          {/* ── AI Models & APIs ─────────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Sparkles size={13} className="text-white/30" />
              <span className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
                AI Models & APIs
              </span>
            </div>

            {aiSettings ? (
              <div className="space-y-4">
                {/* Provider Selection */}
                <div>
                  <div className="text-white/50 text-[11px] mb-1.5">API Provider</div>
                  <div className="flex gap-1.5">
                    {AI_PROVIDER_OPTIONS.map(({ key, label }) => (
                      <button
                        key={key}
                        onClick={() => updateAISetting('provider', key)}
                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all whitespace-nowrap ${
                          aiSettings.provider === key
                            ? 'bg-blue-500/30 border border-blue-500/50 text-blue-300'
                            : 'bg-white/[0.03] border border-white/[0.06] text-white/35 hover:bg-white/[0.07] hover:text-white/60'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-white/30 text-[9px] leading-relaxed">
                    Used by in-app AI features. Application Generate uses the separate local application handoff.
                  </p>
                </div>

                {/* Gemini Settings */}
                {aiSettings.provider === 'gemini' && (
                  <div className="space-y-3 bg-white/[0.02] border border-white/5 p-3 rounded-lg">
                    <div className="text-white/40 text-[10px] leading-snug">
                      Model is picked automatically per task and falls back down a capability ladder — Pro, then Flash, then Flash-Lite — with Flash preferred for quality-sensitive work and Flash-Lite for status checks and light edits. Pro is used only if a live check confirms your key is entitled to it; free-tier keys report no Pro quota, so the chain starts at Flash. Run Check availability after upgrading a key.
                    </div>
                    <div>
                      <div className="flex justify-between items-end mb-1">
                        <div className="text-white/50 text-[11px]">API Key (AI Studio)</div>
                        <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="text-[9px] text-blue-400 hover:underline">Get Key</a>
                      </div>
                      <input
                        type="password"
                        placeholder="AIzaSy..."
                        value={aiSettings.geminiApiKey || ''}
                        onChange={(e) => updateAISetting('geminiApiKey', e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 focus:outline-none focus:border-blue-500/50"
                      />
                    </div>

                    {/* Vertex AI service-account.json — alternative to the API key */}
                    <div>
                      <div className="text-white/50 text-[11px] mb-1">
                        Or service-account.json (Vertex AI)
                      </div>
                      <div className="flex gap-1.5">
                        <input
                          type="text"
                          readOnly
                          placeholder="No file selected"
                          value={aiSettings.serviceAccountPath || ''}
                          className="flex-1 bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-[10px] text-white/60 focus:outline-none truncate"
                          title={aiSettings.serviceAccountPath || ''}
                        />
                        <button
                          onClick={async () => {
                            const res = await window.electronAPI?.pickServiceAccountFile?.();
                            if (res?.path) updateAISetting('serviceAccountPath', res.path);
                          }}
                          className="px-2 py-1.5 rounded-md bg-blue-500/20 hover:bg-blue-500/30 text-blue-300 text-[10px] font-medium border border-blue-500/30 transition-colors"
                        >
                          Browse…
                        </button>
                        {aiSettings.serviceAccountPath && (
                          <button
                            onClick={() => updateAISetting('serviceAccountPath', '')}
                            className="px-2 py-1.5 rounded-md bg-white/5 hover:bg-white/10 text-white/40 text-[10px] border border-white/10 transition-colors"
                            title="Clear configured path"
                          >
                            Clear
                          </button>
                        )}
                      </div>
                      <p className="text-white/30 text-[9px] mt-1">
                        Either credential works. When both are set, the AI Studio API key is used; clear it to use the Vertex service account.
                      </p>
                    </div>

                    <AIProviderStatus provider="gemini" status={aiStatus.gemini} checking={checkingProvider === 'gemini'} onCheck={checkAvailability} />
                  </div>
                )}

                {/* Claude-only configuration. It is intentionally absent until
                    Claude is the active provider: none of these controls
                    affect Gemini's capability-ladder path. Values persist, so
                    switching back to Claude restores prior selections. */}
                {aiSettings.provider === 'claude' && (
                  <div className="space-y-3 bg-white/[0.02] border border-white/5 p-3 rounded-lg">
                    <div className="text-white/40 text-[10px] leading-snug">
                      The app resolves the newest compatible model in each selected family automatically. The displayed id is the current resolved model, not a setting you need to pin.
                    </div>

                    {/* Per-group Claude family — replaces the old hard-coded
                        per-task tier assignment. Each option shows the id it
                        currently resolves to (claudeModelIds, fetched via
                        getClaudeModelMap) as live proof the always-latest
                        resolver is working, not just a static family name. */}
                    <div className="space-y-2.5">
                      {CLAUDE_MODEL_GROUPS.map(({ key, label, defaultToken, note }) => {
                        const selected = aiSettings.claudeModels?.[key] || defaultToken;
                        return (
                          <div key={key}>
                            <div className="text-white/50 text-[11px] mb-1">{label}</div>
                            <select
                              value={selected}
                              onChange={(e) => updateClaudeModelGroup(key, e.target.value)}
                              className="w-full bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-[11px] text-white/80 focus:outline-none focus:border-blue-500/50"
                            >
                              {CLAUDE_FAMILY_OPTIONS.map(({ token, label: familyLabel, desc }) => {
                                const modelId = claudeModelIds[token];
                                const isDefault = defaultToken === token;
                                return (
                                  <option key={token} value={token}>
                                    {familyLabel}{modelId ? ` — ${modelId}` : ''} ({desc}{isDefault ? ', default' : ''})
                                  </option>
                                );
                              })}
                            </select>
                            <p className="text-white/30 text-[9px] mt-1">{note}</p>
                            {key === 'judgment' && selected === 'HAIKU' && (
                              <p className="text-amber-300/80 text-[9px] mt-1">
                                Haiku is usable, but pricing and bundle-price decisions are recommendations you act on directly, so weaker judgment carries real cost. Sonnet or Opus is recommended here.
                              </p>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    <div>
                      <div className="flex justify-between items-end mb-1">
                        <div className="text-white/50 text-[11px]">
                          API Key
                        </div>
                        <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" className="text-[9px] text-blue-400 hover:underline">Get Key</a>
                      </div>
                      <input
                        type="password"
                        placeholder="sk-ant-api..."
                        value={aiSettings.anthropicApiKey || ''}
                        onChange={(e) => updateAISetting('anthropicApiKey', e.target.value)}
                        className="w-full bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 focus:outline-none focus:border-blue-500/50"
                      />
                    </div>

                    <AIProviderStatus provider="claude" status={aiStatus.claude} checking={checkingProvider === 'claude'} onCheck={checkAvailability} />
                  </div>
                )}
              </div>
            ) : (
              <div className="text-white/30 text-xs text-center py-2">Loading settings...</div>
            )}
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── Job Sources ─────────────────────────────────────────── */}
          {/* Per-source credentials for job-search APIs that require keys.
              Stored in electron-store (Settings) — not .env — so they
              persist across sessions and don't require restarting the app. */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Briefcase size={13} className="text-white/30" />
              <span className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
                Job Sources
              </span>
            </div>
            <div className="text-white/40 text-[11px] mb-3 leading-relaxed">
              Some job boards require an API key. Paste your credentials here to enable that source — keys are stored locally and persist between sessions.
            </div>
            {jobsSettings ? (
              <div className="space-y-4">
                {/* USAJobs */}
                <div className="bg-white/[0.02] border border-white/5 p-3 rounded-lg space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="text-white/70 text-[11px] font-medium">USAJobs</div>
                    <a
                      href="https://developer.usajobs.gov/apirequest/"
                      target="_blank"
                      rel="noreferrer"
                      className="text-[9px] text-blue-400 hover:underline"
                    >
                      Get Free Key
                    </a>
                  </div>
                  <div>
                    <div className="text-white/50 text-[11px] mb-1">API Key</div>
                    <input
                      type="password"
                      placeholder="Authorization-Key"
                      value={jobsSettings.usajobsApiKey || ''}
                      onChange={(e) => updateJobsSetting('usajobsApiKey', e.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 focus:outline-none focus:border-blue-500/50"
                    />
                  </div>
                  <div>
                    <div className="text-white/50 text-[11px] mb-1">Email</div>
                    <input
                      type="email"
                      placeholder="you@example.com"
                      value={jobsSettings.usajobsEmail || ''}
                      onChange={(e) => updateJobsSetting('usajobsEmail', e.target.value)}
                      className="w-full bg-black/40 border border-white/10 rounded-md px-2 py-1.5 text-xs text-white/80 focus:outline-none focus:border-blue-500/50"
                    />
                  </div>
                  <div className="text-white/30 text-[10px] leading-snug">
                    USAJobs requires both your API key and the email address it was issued to.
                  </div>
                </div>

              </div>
            ) : (
              <div className="text-white/30 text-xs text-center py-2">Loading settings...</div>
            )}
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── Job Platform Logins ───────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Briefcase size={13} className="text-white/30" />
              <span className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
                Job Platform Logins
              </span>
            </div>
            <div className="text-white/40 text-[11px] mb-3 leading-relaxed">
              Log in to enable full results. Most sources require login to page past the first page; Google for Jobs works without login but a session reduces bot-detection risk.
            </div>
            <JobPlatformLoginsSection />
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── Marketplace Monitors ─────────────────────────────────── */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <ShoppingBag size={13} className="text-white/30" />
              <span className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
                Marketplace Monitors
              </span>
            </div>
            <div className="text-white/40 text-[11px] mb-3 leading-relaxed">
              Log in once per marketplace, then add the dashboard, notification, message, or activity pages Marketplace Status should scan for account-wide updates.
            </div>
            <div className="mb-3 rounded-lg border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[10px] leading-relaxed text-amber-100/75">
              {NATIVE_READ_MARKETPLACE_NAMES || 'Mercari and Swappa'} hub reads use your normal Google Chrome window. In Chrome, turn on View → Developer → Allow JavaScript from Apple Events before running Marketplace Status.
            </div>
            <MarketplaceMonitorSection
              watchUrlsByPlatform={watchUrlsByPlatform}
              onChangeWatchUrls={updateMarketplaceWatchUrls}
            />
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── Animation Speed ─────────────────────────────────────── */}
          <div>
            <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-3">
              Animation Speed
            </div>
            <div className="text-white/40 text-[11px] mb-3">
              Controls nested canvas dive-in / dive-out speed.
            </div>
            <div className="space-y-1.5">
              {SPEED_OPTIONS.map(opt => {
                const Icon = opt.icon;
                const isSelected = settings.animationSpeed === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => updateSetting('animationSpeed', opt.key)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                      isSelected
                        ? 'bg-white/10 border border-white/15'
                        : 'bg-white/[0.02] border border-transparent hover:bg-white/[0.06] hover:border-white/10'
                    }`}
                  >
                    <div className={`p-1.5 rounded-md ${isSelected ? 'bg-white/10' : 'bg-white/5'}`}>
                      <Icon size={14} className={isSelected ? opt.color : 'text-white/30'} />
                    </div>
                    <div className="flex-1 text-left">
                      <div className={`text-xs font-medium ${isSelected ? 'text-white' : 'text-white/50'}`}>
                        {opt.label}
                      </div>
                    </div>
                    <span className={`text-[10px] font-mono ${isSelected ? 'text-white/50' : 'text-white/20'}`}>
                      {opt.desc}
                    </span>
                    {isSelected && <div className="w-2 h-2 rounded-full bg-blue-400 shrink-0" />}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── View ────────────────────────────────────────────────── */}
          <div>
            <div className="text-white/30 text-[10px] font-semibold uppercase tracking-wider mb-3">
              View
            </div>

            {/* Background Pattern */}
            <div className="mb-4">
              <div className="flex items-center gap-2 mb-2">
                <Grid3x3 size={13} className="text-white/30" />
                <span className="text-white/50 text-xs">Background Pattern</span>
              </div>
              <div className="flex gap-1.5">
                {BG_OPTIONS.map(opt => {
                  const isSelected = (settings.bgVariant ?? 'dots') === opt.key;
                  return (
                    <button
                      key={opt.key}
                      onClick={() => updateSetting('bgVariant', opt.key)}
                      className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all ${
                        isSelected
                          ? 'bg-indigo-500/30 border border-indigo-500/50 text-indigo-300'
                          : 'bg-white/[0.03] border border-white/[0.06] text-white/35 hover:bg-white/[0.07] hover:text-white/60'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* MiniMap */}
            <button
              onClick={() => updateSetting('showMiniMap', !(settings.showMiniMap ?? true))}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all ${
                (settings.showMiniMap ?? true)
                  ? 'bg-white/10 border border-white/15'
                  : 'bg-white/[0.02] border border-transparent hover:bg-white/[0.06] hover:border-white/10'
              }`}
            >
              <Map size={14} className={(settings.showMiniMap ?? true) ? 'text-indigo-400' : 'text-white/30'} />
              <div className="flex-1 text-left">
                <div className={`text-xs font-medium ${(settings.showMiniMap ?? true) ? 'text-white' : 'text-white/50'}`}>
                  Show MiniMap
                </div>
              </div>
              {(settings.showMiniMap ?? true) && <div className="w-2 h-2 rounded-full bg-indigo-400 shrink-0" />}
            </button>
          </div>

          <div className="w-full h-px bg-white/[0.06]" />

          {/* ── Keyboard Shortcuts ───────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Keyboard size={13} className="text-white/30" />
                <span className="text-white/30 text-[10px] font-semibold uppercase tracking-wider">
                  Keyboard Shortcuts
                </span>
              </div>
              <button
                onClick={resetShortcuts}
                className="flex items-center gap-1 text-[10px] text-white/30 hover:text-white/60 transition-colors px-2 py-0.5 rounded border border-white/10 hover:border-white/20"
              >
                <RotateCcw size={10} />
                Reset
              </button>
            </div>

            <div className="text-white/30 text-[11px] mb-3">
              Click a shortcut key to rebind it. Press the new key combination to save.
            </div>

            {/* Customizable shortcuts */}
            <div className="space-y-0.5 mb-4">
              {Object.keys(DEFAULT_SHORTCUTS).map(id => (
                <ShortcutRow
                  key={id}
                  id={id}
                  binding={shortcuts[id]}
                  isCapturing={capturingId === id}
                  onStartCapture={setCapturingId}
                  onCancelCapture={() => setCapturingId(null)}
                  onSave={handleSaveShortcut}
                />
              ))}
            </div>

            {/* Read-only reference shortcuts */}
            <div className="text-white/20 text-[10px] font-semibold uppercase tracking-wider mb-2">
              System Shortcuts
            </div>
            <div className="space-y-0.5">
              {[
                { keys: 'Double-click',            desc: 'Add text node' },
                { keys: 'Right-click',             desc: 'Context menu' },
                { keys: 'Delete / ⌫',             desc: 'Delete selected' },
                { keys: 'Escape',                  desc: 'Cancel placement' },
                { keys: `${isMac ? '⌘' : 'Ctrl+'}N`, desc: 'New canvas' },
                { keys: `${isMac ? '⌘' : 'Ctrl+'}O`, desc: 'Open canvas' },
                { keys: `${isMac ? '⌘' : 'Ctrl+'}S`, desc: 'Save canvas' },
                { keys: `${isMac ? '⌘⇧' : 'Ctrl+Shift+'}E`, desc: 'Export PNG' },
                { keys: `${isMac ? '⌘' : 'Ctrl+'}F`, desc: 'Search' },
                { keys: '?',                       desc: 'Open settings' },
              ].map(s => (
                <div key={s.desc} className="flex items-center justify-between py-1">
                  <span className="text-white/40 text-xs">{s.desc}</span>
                  <kbd className="text-[10px] text-white/30 bg-white/5 border border-white/10 rounded px-2 py-0.5 font-mono">
                    {s.keys}
                  </kbd>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-white/10 flex items-center justify-center shrink-0">
          <span className="text-white/20 text-[10px]">Settings are saved automatically</span>
        </div>
      </div>
    </div>,
    document.body
  );
}
