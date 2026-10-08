// Tone styling shared by the single-item bridge progress card and the shared
// application page's rows, so the two can never drift to different colors.
// Lives outside the components because a component file may only export
// components (fast refresh).

export const TONE_CLASS = Object.freeze({
  neutral: 'border-white/10 bg-white/[0.03]',
  working: 'border-violet-400/25 bg-violet-500/10',
  attention: 'border-amber-400/35 bg-amber-500/10',
  problem: 'border-red-400/35 bg-red-500/10',
});
export const HEADLINE_CLASS = Object.freeze({
  neutral: 'text-white',
  working: 'text-white',
  attention: 'text-amber-50',
  problem: 'text-red-100',
});
