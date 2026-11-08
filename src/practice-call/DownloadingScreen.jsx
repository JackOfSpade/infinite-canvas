import React from 'react';
import { Download } from 'lucide-react';
import { downloadPercent, formatBytes } from './callModel.js';

export default function DownloadingScreen({ download }) {
  const percent = downloadPercent(download);
  return <main className="flex min-h-screen items-center justify-center bg-[#111018] p-4 text-violet-50" aria-label="Downloading practice models">
    <section className="w-full max-w-md space-y-3 rounded-xl border border-white/10 bg-[#181521] p-4">
      <h1 className="flex items-center gap-1.5 text-base font-semibold text-violet-100"><Download size={14} aria-hidden="true" />Downloading practice models</h1>
      <p className="text-[12px] text-white/70">This happens once. The call starts as soon as both models are verified.</p>
      <div role="progressbar" aria-label="Model download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="h-2 w-full overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-violet-400/70" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-[11px] text-white/55">{percent}% · {formatBytes(download?.receivedBytes)} of {formatBytes(download?.totalBytes)}</p>
    </section>
  </main>;
}
