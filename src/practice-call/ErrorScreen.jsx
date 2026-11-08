import React from 'react';
import { AlertTriangle } from 'lucide-react';

export default function ErrorScreen({ error, onClose }) {
  return <main className="flex min-h-screen items-center justify-center bg-[#111018] p-4 text-violet-50" aria-label="Practice call error">
    <section role="alert" className="w-full max-w-md space-y-2 rounded-xl border border-red-400/30 bg-red-500/10 p-4">
      <h1 className="flex items-center gap-1.5 text-base font-semibold text-red-100"><AlertTriangle size={14} aria-hidden="true" />The practice call stopped</h1>
      <p className="text-[12px] text-red-100/90">{error?.message || 'Something went wrong in the call window.'}</p>
      {error?.code && <p className="text-[10px] text-red-100/60">Code: {error.code}</p>}
      {typeof onClose === 'function' && <button type="button" onClick={onClose} className="rounded-md border border-white/15 px-2 py-1 text-[11px] text-white/75 hover:bg-white/5">Close window</button>}
    </section>
  </main>;
}
