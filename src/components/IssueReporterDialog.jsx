import React, { useEffect, useState } from 'react';
import { Dialog } from './Dialog';
import { Clipboard, Save } from 'lucide-react';

// Persist the in-progress description across dialog open/close cycles AND
// across app restarts. Users were losing in-progress reports when they
// reopened the dialog after a successful submit; preserving the draft is
// almost always what they want, and they can select-all to clear if not.
const DRAFT_STORAGE_KEY = 'issue-reporter-draft';

export function IssueReporterDialog({ isOpen, onClose, onSubmit }) {
  const [description, setDescription]   = useState(() => {
    try { return localStorage.getItem(DRAFT_STORAGE_KEY) || ''; } catch { return ''; }
  });
  const [isSubmitting, setIsSubmitting]  = useState(false);
  const [activeMode, setActiveMode]      = useState(null); // 'clipboard' | 'file'

  // Mirror description to localStorage on every change so reopens (and even
  // app restarts) bring back what the user typed.
  useEffect(() => {
    try { localStorage.setItem(DRAFT_STORAGE_KEY, description); } catch { /* quota/disabled */ }
  }, [description]);

  const isMountedRef = React.useRef(true);
  React.useEffect(() => {
    return () => { isMountedRef.current = false; };
  }, []);

  const submit = async (mode) => {
    if (!description.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setActiveMode(mode);
    try {
      await onSubmit(description, mode);
      if (!isMountedRef.current) return;
      // NB: do NOT clear `description` here. Per user feedback, the draft
      // should survive submit so reopening shows what was typed — useful for
      // sending the same report through both Copy and Save, or refining and
      // re-submitting.
      setIsSubmitting(false);
      setActiveMode(null);
      onClose();
    } catch {
      if (!isMountedRef.current) return;
      // onSubmit handles its own error toasts; just reset UI state
      setIsSubmitting(false);
      setActiveMode(null);
    }
  };

  if (!isOpen) return null;

  const noDesc = !description.trim();

  return (
    <Dialog onClose={onClose} title="Report an Issue">
      <form
        onSubmit={e => { e.preventDefault(); submit('clipboard'); }}
        className="flex flex-col gap-4"
      >
        <textarea
          autoFocus
          className="w-full h-32 bg-black/40 border border-white/10 rounded-md p-3 text-sm
                     text-white focus:border-blue-500 focus:outline-none resize-none transition-colors"
          placeholder="What went wrong? Steps to reproduce?"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />

        <div className="flex justify-end gap-2 mt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-white/70 hover:text-white transition-colors"
          >
            Cancel
          </button>

          {/* Save to file — secondary action, gray. Native save dialog. */}
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

          {/* Copy to clipboard — primary action, blue. Instant, no dialog. */}
          <button
            type="submit"
            disabled={noDesc || isSubmitting}
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
