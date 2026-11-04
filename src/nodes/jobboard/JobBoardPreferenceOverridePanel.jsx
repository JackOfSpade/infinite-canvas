import React, { useState } from 'react';
import { JOB_BOARD_PREFERENCE_BRIEF_MAX_LENGTH } from '../../utils/jobBoardPreferenceOverride';

const BUTTON_CLASS = 'nodrag rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] text-white/70 hover:bg-white/10 disabled:opacity-40 disabled:cursor-not-allowed';

export function JobBoardPreferenceOverridePanel({ view, seed, busy = false, hasSavedJobs = false, onApply, onClear }) {
  const saved = view?.brief || '';
  const [draft, setDraft] = useState(null);
  // The box holds only what the person applied or typed. A Search's brief enters it
  // only through the button below, and nothing takes effect until Apply to Board.
  const text = draft ?? saved;
  const trimmed = text.trim();
  const unchanged = view?.state === 'applied' && trimmed === saved.trim();
  const counts = view?.counts;
  const seedBrief = (seed?.brief || '').trim();
  const canUseSeed = !!seedBrief && trimmed !== seedBrief;
  return (
    <div className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-2 mt-2" onPointerDown={(e) => e.stopPropagation()}>
      <p className="text-[10px] font-semibold text-white/70">Preferences for these jobs</p>
      <p className="text-[9px] leading-snug text-white/30">
        Replaces each connected search&apos;s rules for this Board, including jobs from later scans. Nothing is scraped again, and existing scores stay. AI checks your saved jobs when the rules change. Empty the box and apply to go back to each search&apos;s rules.
      </p>
      <textarea
        data-native-undo="true"
        aria-label="Preferences for these jobs"
        value={text}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="None set. Each search's own rules are in use."
        rows={3}
        maxLength={JOB_BOARD_PREFERENCE_BRIEF_MAX_LENGTH}
        disabled={busy}
        className="nodrag nowheel mt-1.5 w-full resize-y rounded border border-white/10 bg-white/5 px-2 py-1 text-[10px] leading-snug text-white/70 placeholder:text-white/25 focus:border-blue-400/50 focus:outline-none disabled:opacity-50"
      />
      {view?.state === 'pending' && trimmed === saved.trim() && (
        <p className="mt-1 text-[9px] leading-snug text-amber-300/70">These preferences have not finished applying. Apply again to continue.</p>
      )}
      {trimmed !== saved.trim() && (
        <p className="mt-1 text-[9px] leading-snug text-amber-300/70">
          Not applied yet. Until you press Apply to Board, Combine uses {saved ? 'the preferences applied earlier' : 'each search’s own rules'}.
        </p>
      )}
      {canUseSeed && seed?.briefsDiffer && (
        <p className="mt-1 text-[9px] leading-snug text-amber-300/70">The connected searches have different briefs. The button below uses the first one, and it would apply to all of them.</p>
      )}
      {view?.state === 'applied' && counts && (
        <p className="mt-1 text-[9px] leading-snug text-white/40">
          In use: {counts.passed} of {counts.checked} saved jobs pass, {counts.removed} removed. {counts.newlyScored} newly scored, {counts.keptScores} scores kept.
          {counts.unscored > 0 ? ` ${counts.unscored} could not be scored; Re-combine to retry.` : ''}
        </p>
      )}
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          className={BUTTON_CLASS}
          disabled={busy || unchanged || (trimmed ? !hasSavedJobs : view?.state === 'empty')}
          onClick={() => { if (trimmed) onApply?.(trimmed); else onClear?.(); setDraft(null); }}
        >
          Apply to Board
        </button>
        {canUseSeed && (
          <button type="button" className={BUTTON_CLASS} disabled={busy} onClick={() => setDraft(seedBrief)}>
            Use Job Search preferences
          </button>
        )}
      </div>
    </div>
  );
}
