import React, { useState } from 'react';
import { Dialog } from './Dialog';
import { Clipboard, Save } from 'lucide-react';

export function IssueReporterDialog({ isOpen, onClose, onSubmit }) {
  const [description, setDescription]   = useState('');
  const [isSubmitting, setIsSubmitting]  = useState(false);
  const [activeMode, setActiveMode]      = useState(null); // 'clipboard' | 'file'

  const submit = async (mode) => {
    if (!description.trim() || isSubmitting) return;
    setIsSubmitting(true);
    setActiveMode(mode);
    try {
      await onSubmit(description, mode);
      setDescription('');
      setIsSubmitting(false);
      setActiveMode(null);
      onClose();
    } catch {
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
        onSubmit={e => { e.preventDefault(); submit('file'); }}
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

          {/* Copy to clipboard — no file dialog, instant */}
          <button
            type="button"
            disabled={noDesc || isSubmitting}
            onClick={() => submit('clipboard')}
            className="flex items-center gap-1.5 px-4 py-2 text-sm
                       bg-white/8 hover:bg-white/14 disabled:opacity-50
                       text-white/80 hover:text-white rounded-md transition-colors border border-white/10"
          >
            <Clipboard size={13} />
            {activeMode === 'clipboard' ? 'Copying…' : 'Copy to Clipboard'}
          </button>

          {/* Save to file — native save dialog */}
          <button
            type="submit"
            disabled={noDesc || isSubmitting}
            className="flex items-center gap-1.5 px-4 py-2 text-sm
                       bg-blue-600 hover:bg-blue-500 disabled:opacity-50
                       text-white rounded-md transition-colors"
          >
            <Save size={13} />
            {activeMode === 'file' ? 'Saving…' : 'Save to File'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
