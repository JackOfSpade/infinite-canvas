import React, { useEffect, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Settings, Zap, Scale, Sparkles,
  Grid3x3, Map, Keyboard, RotateCcw, Check,
  ShoppingBag, LogIn, Eye, Loader2,
} from 'lucide-react';
import { ANIMATION_DURATIONS, DEFAULT_SHORTCUTS } from '../hooks/useSettings';
import { useSyncWhileFocused } from '../hooks/useSyncWhileFocused';
import { useToast } from './ToastProvider';
import { SELL_PLATFORMS } from '../utils/constants';
import { PlatformBadge } from './PlatformBadge';

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
  }, [isCapturing, id, label, onSave]);

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
 *   2. Add "watch URLs" the AI check should also scrape every time it runs
 *      for any card on this platform. These are typically:
 *        - the seller dashboard / active-listings page
 *        - a notifications / activity feed
 *        - a sold-items tab
 *      The strongest signal across all URLs wins, so a SOLD notification in
 *      the feed will outrank a "still live" reading from the listing page
 *      that hasn't been re-rendered yet.
 */
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
    const lines = (value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    onChangeUrls(platform.id, lines);
  };

  // Live count from the editor reflects unsaved edits — friendlier than
  // showing the persisted count while the user is mid-typing.
  const liveCount = (value || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).length;

  return (
    <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3 space-y-2">
      <div className="flex items-center gap-2">
        <PlatformBadge name={platform.name} letter={platform.letter} color={platform.color} domain={platform.domain} size={20} />
        <div className="flex-1 text-white/80 text-xs font-semibold">{platform.name}</div>
        {pending ? (
          <span
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border bg-white/[0.04] border-white/10 text-white/50 select-none"
            title="Verifying session…"
          >
            <Loader2 size={10} className="animate-spin" />
            Verifying<span className="login-pending-dots" />
          </span>
        ) : connected ? (
          <span
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border bg-emerald-500/10 border-emerald-500/30 text-emerald-300 select-none"
            title="Session active — the app will flip this back to Log in automatically when it expires."
          >
            <Check size={10} />
            Logged in
          </span>
        ) : (
          <button
            onClick={() => onLogin(platform.id)}
            className="flex items-center gap-1 text-[10px] px-2 py-1 rounded border transition-colors bg-blue-500/10 border-blue-500/30 text-blue-300 hover:bg-blue-500/20"
            title="Open a window to log into this marketplace"
          >
            <LogIn size={10} />
            Log in
          </button>
        )}
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
          One URL per line. Each is fetched (logged-in if you're signed in) and scanned by AI for THIS listing's status. The strongest signal across all URLs wins.
        </div>
      </div>
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

  const handleLogin = useCallback(async (platformId) => {
    setPendingByPlatform(prev => ({ ...prev, [platformId]: true }));
    try {
      // open-login-window now returns the verify verdict inline
      // ({ connected, reason }) — no need for a second IPC roundtrip.
      // Surfacing the reason as a toast tells the user WHY a login didn't
      // stick (e.g. "Redirected to /signin — login not completed"), which
      // is the difference between "I think nothing happened" and "oh, the
      // verifier hit a seller-only page and bounced."
      const res = await window.electronAPI?.openLoginWindow?.({ platformId });
      const connected = !!res?.connected;
      setAuthByPlatform(prev => ({ ...prev, [platformId]: connected }));
      const niceName = SELL_PLATFORMS.find(p => p.id === platformId)?.name || platformId;
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
  }, [addToast]);

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

/**
 * Application settings panel.
 * Sections: AI, Marketplace Monitors, Animation Speed, View, Keyboard Shortcuts.
 */
export function SettingsPanel({ isOpen, onClose, settings, updateSetting, updateShortcut, resetShortcuts }) {
  const [capturingId, setCapturingId] = useState(null);
  const [aiSettings, setAiSettings] = useState(null);
  const [watchUrlsByPlatform, setWatchUrlsByPlatform] = useState({});

  useEffect(() => {
    if (!isOpen || !window.electronAPI?.getSettings) return;
    let cancelled = false;
    window.electronAPI.getSettings()
      .then((storeData) => {
        if (cancelled) return;
        if (storeData && storeData.ai) setAiSettings(storeData.ai);
        if (storeData && storeData.marketplaceWatchUrls) setWatchUrlsByPlatform(storeData.marketplaceWatchUrls);
      })
      .catch(() => { /* IPC unavailable — leave loading state until next open */ });
    return () => { cancelled = true; };
  }, [isOpen]);

  const updateAISetting = useCallback((key, value) => {
    if (!window.electronAPI?.updateSettings || !aiSettings) return;
    const next = { ...aiSettings, [key]: value };
    setAiSettings(next);
    // IPC outside the setState updater so it fires exactly once — strict /
    // concurrent mode may invoke updaters twice, which would double-write.
    window.electronAPI.updateSettings({ ai: next });
  }, [aiSettings]);

  const updateMarketplaceWatchUrls = useCallback((platformId, urls) => {
    if (!window.electronAPI?.updateSettings) return;
    setWatchUrlsByPlatform(prev => {
      const next = { ...prev, [platformId]: urls };
      window.electronAPI.updateSettings({ marketplaceWatchUrls: next });
      return next;
    });
  }, []);

  // Close on Escape (also cancels capturing)
  useEffect(() => {
    if (!isOpen) return;
    const handleKey = (e) => {
      if (e.key === 'Escape') {
        if (capturingId) { setCapturingId(null); return; }
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isOpen, onClose, capturingId]);

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
                  <div className="text-white/50 text-[11px] mb-1.5">Primary AI Provider</div>
                  <div className="flex gap-1.5">
                    {['gemini', 'claude'].map(p => (
                      <button
                        key={p}
                        onClick={() => updateAISetting('provider', p)}
                        className={`flex-1 py-1.5 rounded-lg text-[11px] font-medium transition-all capitalize ${
                          aiSettings.provider === p
                            ? 'bg-blue-500/30 border border-blue-500/50 text-blue-300'
                            : 'bg-white/[0.03] border border-white/[0.06] text-white/35 hover:bg-white/[0.07] hover:text-white/60'
                        }`}
                      >
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Gemini Settings */}
                {aiSettings.provider === 'gemini' && (
                  <div className="space-y-3 bg-white/[0.02] border border-white/5 p-3 rounded-lg">
                    <div className="text-white/40 text-[10px] leading-snug">
                      Model is picked automatically per task — Flash for vision &amp; pricing, Flash-Lite for status checks &amp; light edits.
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
                        Either an API key or a service-account file works. The file is preferred when both are set.
                      </p>
                    </div>
                  </div>
                )}

                {/* Claude Settings */}
                {aiSettings.provider === 'claude' && (
                  <div className="space-y-3 bg-white/[0.02] border border-white/5 p-3 rounded-lg">
                    <div className="text-white/40 text-[10px] leading-snug">
                      Model is picked automatically per task — Sonnet 4.6 for vision &amp; pricing, Haiku 4.5 for status checks &amp; light edits.
                    </div>
                    <div>
                      <div className="flex justify-between items-end mb-1">
                        <div className="text-white/50 text-[11px]">API Key</div>
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
                  </div>
                )}
              </div>
            ) : (
              <div className="text-white/30 text-xs text-center py-2">Loading settings...</div>
            )}
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
              Log in once per marketplace so status checks can read your dashboards and notification feeds, then list any extra pages you want every check to scan for THIS listing's status.
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
