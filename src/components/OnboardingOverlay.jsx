import React, { useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Briefcase, Camera, ArrowRight, Sparkles, MousePointerClick } from 'lucide-react';
import { ACTIVE_JOB_SOURCES } from '../utils/constants';

const activeJobSourceLabel = `${ACTIVE_JOB_SOURCES.length} source${ACTIVE_JOB_SOURCES.length === 1 ? '' : 's'}`;

const STEPS = [
  {
    id: 'welcome',
    title: 'Welcome to Infinite Canvas',
    subtitle: 'Your AI-powered workspace for job hunting & selling',
    content: (
      <div className="relative flex flex-col items-center">
        <div className="onboarding-glow w-24 h-24 rounded-full flex items-center justify-center mb-4">
          <Sparkles size={40} className="text-white" />
        </div>
        <p className="text-white/50 text-sm text-center max-w-xs leading-relaxed">
          Drop files, photos, or resumes onto an infinite canvas — AI does the rest.
        </p>
      </div>
    ),
  },
  {
    id: 'drag-drop',
    title: 'Drag & Drop Everything',
    subtitle: 'Your canvas, your way',
    content: (
      <div className="flex flex-col items-center gap-4">
        <div className="flex gap-6 items-center">
          <div className="onboarding-card w-16 h-20 rounded-lg flex flex-col items-center justify-center">
            <div className="text-2xl mb-1">📄</div>
            <span className="text-[9px] text-white/40">Resume</span>
          </div>
          <ArrowRight size={20} className="text-white/20 onboarding-arrow" />
          <div className="onboarding-card w-16 h-20 rounded-lg flex flex-col items-center justify-center border-blue-500/30">
            <Briefcase size={20} className="text-blue-400 mb-1" />
            <span className="text-[9px] text-white/40">Jobs</span>
          </div>
        </div>
        <div className="flex gap-6 items-center">
          <div className="onboarding-card w-16 h-20 rounded-lg flex flex-col items-center justify-center">
            <div className="text-2xl mb-1">📸</div>
            <span className="text-[9px] text-white/40">Photos</span>
          </div>
          <ArrowRight size={20} className="text-white/20 onboarding-arrow" />
          <div className="onboarding-card w-16 h-20 rounded-lg flex flex-col items-center justify-center border-emerald-500/30">
            <Camera size={20} className="text-emerald-400 mb-1" />
            <span className="text-[9px] text-white/40">Listing</span>
          </div>
        </div>
        <p className="text-white/40 text-xs text-center mt-1">
          Drop your career files → AI finds matching jobs across {activeJobSourceLabel}<br/>
          Drop photos → AI creates a listing with price research
        </p>
      </div>
    ),
  },
  {
    id: 'ai-powered',
    title: 'AI Does the Heavy Lifting',
    subtitle: 'Powered by Gemini',
    content: (
      <div className="flex flex-col items-center gap-3">
        <div className="grid grid-cols-2 gap-3 w-full max-w-xs">
          {[
            { icon: '🔍', label: 'Multi-source search', desc: '12 job boards at once' },
            { icon: '🎯', label: 'Smart scoring', desc: 'AI ranks every match' },
            { icon: '💰', label: 'Price research', desc: 'eBay, Amazon, Mercari' },
            { icon: '✉️', label: 'Cover letters', desc: 'One-click generation' },
          ].map(item => (
            <div key={item.label} className="onboarding-card rounded-lg p-3 text-center">
              <div className="text-lg mb-1">{item.icon}</div>
              <div className="text-white/70 text-[10px] font-medium">{item.label}</div>
              <div className="text-white/30 text-[9px]">{item.desc}</div>
            </div>
          ))}
        </div>
      </div>
    ),
  },
  {
    id: 'get-started',
    title: 'Ready to Go',
    subtitle: 'Start by dropping a file or using the sidebar',
    content: (
      <div className="flex flex-col items-center gap-3">
        <MousePointerClick size={32} className="text-blue-400 onboarding-bounce" />
        <p className="text-white/40 text-xs text-center max-w-xs leading-relaxed">
          <strong className="text-white/60">Double-click</strong> the canvas to add text<br/>
          <strong className="text-white/60">Right-click</strong> for the context menu<br/>
          <strong className="text-white/60">Drag modules</strong> from the sidebar<br/>
        </p>
        <div className="flex items-center gap-2 mt-1">
          <div className="w-2 h-2 rounded-full bg-blue-500" />
          <span className="text-white/20 text-[10px]">Files dropped are linked, not copied</span>
        </div>
      </div>
    ),
  },
];

/**
 * OnboardingOverlay — multi-step animated walkthrough for first-time users.
 * Replaces the old StartupWarning with a premium experience.
 * Persisted via localStorage.
 */
export function OnboardingOverlay() {
  const [visible, setVisible] = useState(() => {
    try {
      return localStorage.getItem('onboardingComplete') !== 'true';
    } catch {
      return true;
    }
  });
  const [step, setStep] = useState(0);
  const [direction, setDirection] = useState('next');

  const dismiss = useCallback(() => {
    try {
      localStorage.setItem('onboardingComplete', 'true');
    } catch { /* noop */ }
    setVisible(false);
  }, []);

  const next = useCallback(() => {
    if (step < STEPS.length - 1) {
      setDirection('next');
      setStep(s => s + 1);
    } else {
      dismiss();
    }
  }, [step, dismiss]);

  const prev = useCallback(() => {
    if (step > 0) {
      setDirection('prev');
      setStep(s => s - 1);
    }
  }, [step]);

  if (!visible) return null;

  const current = STEPS[step];
  const isLast = step === STEPS.length - 1;

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div
        className="onboarding-panel relative w-[380px] bg-neutral-900/95 border border-white/10 rounded-2xl shadow-2xl overflow-hidden"
      >
        {/* Content area */}
        <div
          key={step}
          className={`p-8 flex flex-col items-center gap-4 ${
            direction === 'next' ? 'onboarding-slide-in-right' : 'onboarding-slide-in-left'
          }`}
        >
          <h2 className="text-white text-lg font-semibold text-center">{current.title}</h2>
          <p className="text-white/40 text-xs text-center -mt-2">{current.subtitle}</p>
          <div className="mt-2 w-full flex justify-center">{current.content}</div>
        </div>

        {/* Footer */}
        <div className="px-8 pb-6 flex items-center justify-between">
          {/* Progress dots */}
          <div className="flex gap-1.5">
            {STEPS.map((_, i) => (
              <button
                key={i}
                onClick={() => { setDirection(i > step ? 'next' : 'prev'); setStep(i); }}
                className={`w-2 h-2 rounded-full transition-all duration-300 ${
                  i === step ? 'bg-blue-500 w-5' : 'bg-white/20 hover:bg-white/40'
                }`}
              />
            ))}
          </div>

          {/* Navigation */}
          <div className="flex gap-2">
            {step > 0 && (
              <button
                onClick={prev}
                className="px-3 py-1.5 rounded-lg text-xs text-white/50 hover:text-white/80 hover:bg-white/5 transition-colors"
              >
                Back
              </button>
            )}
            <button
              onClick={next}
              className={`px-4 py-1.5 rounded-lg text-xs font-medium transition-all ${
                isLast
                  ? 'bg-gradient-to-r from-blue-500 to-purple-500 text-white hover:from-blue-600 hover:to-purple-600 shadow-lg shadow-blue-500/20'
                  : 'bg-white/10 text-white hover:bg-white/15'
              }`}
            >
              {isLast ? "Let's Go!" : 'Next'}
            </button>
          </div>
        </div>

        {/* Skip */}
        {!isLast && (
          <button
            onClick={dismiss}
            className="absolute top-4 right-4 text-white/20 hover:text-white/50 text-xs transition-colors"
          >
            Skip
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}
