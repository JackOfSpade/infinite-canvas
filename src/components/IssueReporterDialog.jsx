import React, { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { Dialog } from './Dialog';
import { Clipboard, Save, Sparkles, Copy, AlertTriangle } from 'lucide-react';
import { EventLogger } from '../utils/EventLogger';
import { previewBugReportCode, buildAiPrompt } from '../utils/bugReportCodes';
import { useIsMountedRef } from '../hooks/useIsMountedRef';

// Persist the in-progress description across dialog open/close cycles but NOT
// across app restarts/exit.
const DRAFT_STORAGE_KEY = 'issue-reporter-draft';
const DEFAULT_FILTER_CODE = 'FULL';

export function IssueReporterDialog({ isOpen, onClose, onSubmit }) {
  const [description, setDescription] = useState(() => {
    try { return sessionStorage.getItem(DRAFT_STORAGE_KEY) || ''; } catch { return ''; }
  });
  const [filterCode, setFilterCode] = useState(DEFAULT_FILTER_CODE);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeMode, setActiveMode] = useState(null); // 'clipboard' | 'file'
  const [promptCopied, setPromptCopied] = useState(false);
  const promptCopiedTimerRef = useRef(null);

  // Mirror description to sessionStorage on every change so reopens
  // bring back what the user typed within the same session.
  useEffect(() => {
    try { sessionStorage.setItem(DRAFT_STORAGE_KEY, description); } catch { /* quota/disabled */ }
  }, [description]);

  // Clean up legacy localStorage draft key from previous versions on mount
  useEffect(() => {
    try {
      if (localStorage.getItem(DRAFT_STORAGE_KEY) !== null) {
        localStorage.removeItem(DRAFT_STORAGE_KEY);
      }
    } catch { /* ignore */ }
  }, []);

  const isMountedRef = useIsMountedRef();

  const handleClose = useCallback(() => {
    setFilterCode(DEFAULT_FILTER_CODE);
    onClose();
  }, [onClose]);

  // ── Live code preview ──────────────────────────────────────────────────────
  // Recomputes whenever the filter code changes, showing count of matching log lines.
  const codePreview = useMemo(() => {
    const rawLogs = EventLogger.getLogs();
    return previewBugReportCode(rawLogs, filterCode);
  }, [filterCode]);

  const hasValidCode  = filterCode.trim().length > 0;
  const hasUnknown    = (codePreview.unknownCodes?.length ?? 0) > 0;
  const codeIsClean   = hasValidCode && !hasUnknown && codePreview.matchedCodes.length > 0;
  const codeIsPartial = hasValidCode && hasUnknown;

  // ── Copy AI prompt to clipboard ───────────────────────────────────────────
  const copyAIPrompt = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(buildAiPrompt(description));
      setPromptCopied(true);
      if (promptCopiedTimerRef.current) clearTimeout(promptCopiedTimerRef.current);
      promptCopiedTimerRef.current = setTimeout(() => {
        promptCopiedTimerRef.current = null;
        setPromptCopied(false);
      }, 2000);
    } catch { /* ignore */ }
  }, [description]);

  useEffect(() => () => {
    if (promptCopiedTimerRef.current) clearTimeout(promptCopiedTimerRef.current);
  }, []);

  // ── Submit ────────────────────────────────────────────────────────────────
  const submit = useCallback(async (mode) => {
    if (!description.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setActiveMode(mode);
    try {
      await onSubmit(description, filterCode, mode);
      if (!isMountedRef.current) return;
      setIsSubmitting(false);
      setActiveMode(null);
      handleClose();
    } catch {
      if (!isMountedRef.current) return;
      setIsSubmitting(false);
      setActiveMode(null);
    }
  }, [filterCode, handleClose, isSubmitting, onSubmit, description, isMountedRef]);

  if (!isOpen) return null;

  const noDesc = !description.trim();

  return (
    <Dialog onClose={handleClose} title="Report an Issue">
      <form
        onSubmit={e => { e.preventDefault(); submit('clipboard'); }}
        className="flex flex-col gap-3"
        style={{ width: '380px' }}
      >
        {/* ── Description ─────────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-white/60 uppercase tracking-wider">
            What went wrong?
          </label>
          <textarea
            autoFocus
            className="w-full h-28 bg-black/40 border border-white/10 rounded-md p-3 text-sm
                       text-white placeholder-white/40 focus:border-blue-500/60 focus:outline-none
                       resize-none transition-colors"
            placeholder="Describe the bug and steps to reproduce…"
            value={description}
            onChange={e => setDescription(e.target.value)}
          />
        </div>

        {/* ── AI Filter Code ───────────────────────────────────────────────── */}
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-white/60 uppercase tracking-wider flex items-center gap-1.5">
            <Sparkles size={11} className="text-violet-400" />
            AI Filter Code
            <span className="text-white/30 font-normal normal-case tracking-normal">(optional)</span>
          </label>

          {/* Copy AI prompt — embeds the user's description so the AI can pick
              codes from it and reply with a code string. The user pastes that
              into the field below; they never write a code by hand. */}
          <button
            type="button"
            onClick={copyAIPrompt}
            className="flex items-center justify-center gap-2 w-full px-3 py-2 rounded-md
                       bg-violet-500/15 border border-violet-500/30 hover:bg-violet-500/25
                       text-violet-300 hover:text-violet-200 transition-colors text-xs font-medium"
          >
            <Copy size={11} />
            {promptCopied ? 'Copied — paste it to any AI assistant' : 'Copy AI Prompt to Clipboard'}
          </button>
          <p className="text-[11px] text-white/35 px-0.5 leading-snug">
            Describe the bug above, copy this prompt to any AI assistant, then paste the code it replies with below.
          </p>

          {/* ── Code input ────────────────────────────────────────────────── */}
          <div className="relative">
            <input
              type="text"
              className={`w-full bg-black/40 border rounded-md px-3 py-2 text-sm font-mono
                         text-white placeholder-white/30 focus:outline-none transition-colors pr-24
                         ${codeIsClean   ? 'border-violet-500/50 focus:border-violet-400' :
                           codeIsPartial ? 'border-amber-500/50  focus:border-amber-400'  :
                           'border-white/10 focus:border-white/30'}`}
              placeholder="Paste the code the AI gives you"
              value={filterCode}
              onChange={e => setFilterCode(e.target.value.toUpperCase())}
              spellCheck={false}
            />
            {hasValidCode && (
              <button
                type="button"
                onClick={() => setFilterCode('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-white/30
                           hover:text-white/60 transition-colors text-xs px-1"
              >
                clear
              </button>
            )}
          </div>

          {/* ── Code preview / status ────────────────────────────────────── */}
          {hasValidCode && (
            <div className={`flex items-start gap-1.5 text-xs px-2 py-1.5 rounded-md
                            ${codeIsClean   ? 'bg-violet-500/10 text-violet-300/80' :
                              codeIsPartial ? 'bg-amber-500/10 text-amber-300/80'   :
                              'bg-white/5 text-white/40'}`}>
              {codeIsPartial && <AlertTriangle size={11} className="shrink-0 mt-0.5 text-amber-400" />}
              <div className="flex flex-col gap-0.5">
                {codeIsClean && (
                  <>
                    <span className="font-medium">{codePreview.label}</span>
                    <span className="text-violet-400/70">
                      {codePreview.count} of {codePreview.total} log line{codePreview.count !== 1 ? 's' : ''} selected
                    </span>
                  </>
                )}
                {codeIsPartial && (
                  <>
                    {codePreview.matchedCodes.length > 0 && (
                      <span className="font-medium">{codePreview.label}</span>
                    )}
                    <span>
                      Unknown code{codePreview.unknownCodes.length > 1 ? 's' : ''}:{' '}
                      <span className="font-mono">{codePreview.unknownCodes.join(', ')}</span>
                      {' '}— check the code list above
                    </span>
                    {codePreview.matchedCodes.length > 0 && (
                      <span className="text-amber-400/70">
                        {codePreview.count} of {codePreview.total} log lines selected (using matched codes)
                      </span>
                    )}
                  </>
                )}
                {!codeIsClean && !codeIsPartial && (
                  <span>No matching codes — use the list above or ask AI</span>
                )}
              </div>
            </div>
          )}

          {!hasValidCode && (
            <p className="text-xs text-white/30 px-0.5">
              No code? The full report will be included. Ask AI for a code to keep it focused.
            </p>
          )}
        </div>

        {/* ── Actions ──────────────────────────────────────────────────────── */}
        <div className="flex justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={handleClose}
            className="px-4 py-2 text-sm text-white/50 hover:text-white/80 transition-colors"
          >
            Cancel
          </button>

          {/* Save to file — secondary action */}
          <button
            type="button"
            disabled={noDesc || isSubmitting}
            onClick={() => submit('file')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm
                       bg-white/8 hover:bg-white/14 disabled:opacity-50
                       text-white/80 hover:text-white rounded-md transition-colors border border-white/10"
          >
            <Save size={13} />
            {activeMode === 'file' ? 'Saving…' : 'Save to File'}
          </button>

          {/* Copy to clipboard — primary action. Saves the full report to a
              file and copies its PATH, not the report body — an AI assistant
              reads the file from disk instead of receiving a giant paste. */}
          <button
            type="submit"
            disabled={noDesc || isSubmitting}
            title="Saves the full report to a file and copies its file path — not the report text — to your clipboard."
            className="flex items-center gap-1.5 px-4 py-2 text-sm
                       bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                       text-white rounded-md transition-colors"
          >
            <Clipboard size={13} />
            {activeMode === 'clipboard' ? 'Copying…' : 'Copy to Clipboard'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
