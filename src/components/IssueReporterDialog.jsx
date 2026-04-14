import React, { useState } from 'react';
import { Dialog } from './Dialog';

export function IssueReporterDialog({ isOpen, onClose, onSubmit }) {
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!description.trim()) return;

    setIsSubmitting(true);
    await onSubmit(description);
    setIsSubmitting(false);
    setDescription('');
    onClose();
  };

  if (!isOpen) return null;

  return (
    <Dialog onClose={onClose} title="Report an Issue">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4">
        <textarea
          autoFocus
          className="w-full h-32 bg-black/40 border border-white/10 rounded-md p-3 text-sm text-white focus:border-blue-500 focus:outline-none resize-none transition-colors"
          placeholder="What went wrong? Steps to reproduce?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />

        <div className="flex justify-end gap-3 mt-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm text-white/70 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!description.trim() || isSubmitting}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white rounded-md transition-colors"
          >
            {isSubmitting ? 'Generating...' : 'Generate Report'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
