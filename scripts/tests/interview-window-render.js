import fs from 'node:fs';
import path from 'node:path';
import { assert } from './testHelpers.js';
import { bundleComponent, withDom } from './fixtures/handoff-bridge/mountComponent.js';

const DISPLAY = {
  version: 1, snapshotId: 'a'.repeat(64),
  plan: { status: 'supported', question: 'How did you improve onboarding conversion and retention?', currentStep: 0, message: 'Use saved details.', missingComponents: ['lesson'], steps: [
    { id: 'one', label: 'RELEVANT EXPERIENCE', cue: 'Improved onboarding conversion.', roleAttribution: 'Product Manager · Acme' },
    { id: 'two', label: 'RELATED EXPERIENCE', cue: 'Reviewed retention weekly.', roleAttribution: 'Product Manager · Acme' },
  ] },
  briefing: { role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Own onboarding.' }, roleThemes: ['Product strategy'], companyFacts: ['B2B SaaS'], recentContext: ['Launch'], likelyQuestions: ['How do you measure?'], questionsToAsk: ['What is success?'], applicationPositioning: ['Conversion experience'], warnings: ['Verify fresh facts'], sources: [{ sourceUrl: `https://research.example.test/${'long-reference-path/'.repeat(16)}`, sourceDate: '2026-10-08' }] },
};

async function flush() { await Promise.resolve(); await Promise.resolve(); }

export default [
  {
    name: 'interview window entry: branch-selected lazy views do not eagerly import the canvas App',
    run() {
      const source = fs.readFileSync(path.resolve('src/main.jsx'), 'utf8');
      assert(source.includes("const activeView = lazy(() => isInterviewWindow"), 'entry must select its active view behind one lazy boundary');
      assert(source.includes("typeof window.interviewAPI?.getBrief === 'function'"), 'the child route must require its narrow preload bridge, not only a query flag');
      assert(source.includes("? import('./interview-window/InterviewWindowApp.jsx')"), 'interview child must be lazy-loaded on the interview branch');
      assert(source.includes(": import('./App.jsx'))"), 'canvas App must be lazy-loaded on the canvas branch');
      assert(!source.includes("import App from './App.jsx'"), 'entry must not eagerly import the canvas App into the interview child');
      assert(!source.includes("import InterviewWindowApp from './interview-window/InterviewWindowApp.jsx'"), 'entry must not eagerly import the child into the canvas view');
    },
  },
  {
    name: 'interview window render: fixed evidence rail keeps one current marker and accepts update events',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let update;
        let nextCalls = 0;
        window.interviewAPI = { getBrief: async () => DISPLAY, onBriefUpdated: callback => { update = callback; return () => { update = null; }; }, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => { nextCalls += 1; return { ...DISPLAY, plan: null }; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const rail = window.document.querySelector('[aria-label="Saved evidence rail"]');
          assert(rail && rail.children.length === 2, 'supported plan must render its complete fixed rail in canonical order');
          assert([...rail.children].map(item => item.textContent).join('\n').includes('Improved onboarding conversion.') && [...rail.children].map(item => item.textContent).join('\n').includes('Reviewed retention weekly.'), 'every cue must remain visibly top-to-bottom in the rail, not only in current detail');
          assert([...rail.children].filter(item => item.getAttribute('aria-current') === 'step').length === 1 && rail.children[0].getAttribute('aria-current') === 'step', 'exactly first step must be current initially');
          assert(window.document.body.textContent.includes('Use saved details.'), 'supported plan disclosure must remain visible with the fixed evidence rail');
          assert(window.document.body.textContent.includes('Role themes') && window.document.body.textContent.includes('Source warnings'), 'briefing must label reference sections');
          const citations = window.document.querySelector('[aria-label="Research citations"]');
          assert(citations?.textContent.includes(DISPLAY.briefing.sources[0].sourceUrl)
            && citations.textContent.includes('Source date: 2026-10-08')
            && citations.querySelectorAll('a').length === 0,
          'the briefing must visibly render canonical research citations as inert text, never a navigation link');
          const css = fs.readFileSync(path.resolve('src/interview-window/interviewWindow.css'), 'utf8');
          assert(css.includes('.citation-url') && css.includes('overflow-wrap: anywhere'), 'long inert citation URLs must wrap inside the narrow child window');
          const next = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Next');
          await bundle.module.act(async () => { next.click(); await flush(); });
          assert([...rail.children].filter(item => item.getAttribute('aria-current') === 'step').length === 1 && rail.children[1].getAttribute('aria-current') === 'step', 'Next must move marker without reordering the fixed rail');
          await bundle.module.act(async () => { update({ ...DISPLAY, plan: { ...DISPLAY.plan, currentStep: 1 } }); await flush(); });
          assert(rail.children[1].getAttribute('aria-current') === 'step', 'main-process update event must safely replace display state');
          const nextQuestion = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Next question');
          await bundle.module.act(async () => { nextQuestion.click(); await flush(); });
          assert(nextCalls === 1 && !window.document.querySelector('[aria-label="Saved evidence rail"]'), 'Next question must await the narrow main-owned transition rather than clear locally');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: initial marker follows main state and missing brief has alert, retry, and close affordances',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let requests = 0; let closed = false;
        window.interviewAPI = { getBrief: async () => { requests += 1; return requests === 1 ? { ...DISPLAY, plan: { ...DISPLAY.plan, currentStep: 1 } } : null; }, onBriefUpdated: () => () => undefined, close: async () => { closed = true; }, submitQuestion: async () => DISPLAY, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const rail = window.document.querySelector('[aria-label="Saved evidence rail"]');
          assert(rail.children[1].getAttribute('aria-current') === 'step', 'initial main-provided current step must initialize the marker');
          await bundle.module.act(async () => { root.unmount(); await flush(); });
          window.interviewAPI.getBrief = async () => { throw new Error('unavailable'); };
          const retryRoot = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { retryRoot.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          assert(window.document.querySelector('[role="alert"]')?.textContent.includes('could not load'), 'failed initial brief must be visibly reported');
          const close = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Close');
          await bundle.module.act(async () => { close.click(); await flush(); });
          assert(closed, 'failed initial load must still offer Close');
          await bundle.module.act(async () => retryRoot.unmount());
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: question submit consumes its returned display when the update event is delayed',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unplanned = { ...DISPLAY, plan: null };
        window.interviewAPI = {
          getBrief: async () => unplanned,
          // Deliberately retain the callback without invoking it: the invoke
          // response itself must be enough to render the returned rail.
          onBriefUpdated: () => () => undefined,
          close: async () => true,
          submitQuestion: async () => DISPLAY,
          nextQuestion: async () => ({ ...DISPLAY, plan: null }),
          setAlwaysOnTop: async () => true,
        };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const submit = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Find saved evidence');
          await bundle.module.act(async () => { submit.click(); await flush(); });
          assert(window.document.querySelector('[aria-label="Saved evidence rail"]'),
            'the returned submit display must render even before a brief-updated event arrives');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: arrow keys scroll the briefing when no supported rail is shown',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unsupported = { ...DISPLAY, plan: { status: 'unsupported', question: 'Why?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } };
        let update;
        window.interviewAPI = { getBrief: async () => unsupported, onBriefUpdated: callback => { update = callback; return () => { update = null; }; }, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        const press = key => {
          const event = new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
          window.document.body.dispatchEvent(event);
          return event.defaultPrevented;
        };
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          assert(window.document.body.textContent.includes('No saved evidence matches.'), 'unsupported state should render');
          assert(!press('ArrowDown') && !press('ArrowUp'), 'an unsupported plan must not swallow arrow-key scrolling');
          await bundle.module.act(async () => { update(DISPLAY); await flush(); });
          let prevented = false;
          await bundle.module.act(async () => { prevented = press('ArrowDown'); await flush(); });
          const rail = window.document.querySelector('[aria-label="Saved evidence rail"]');
          assert(prevented && rail.children[1].getAttribute('aria-current') === 'step', 'a supported rail keeps arrow-key step navigation');
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: a failed submit explains what failed, and only an invalid question gets the validation text',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unplanned = { ...DISPLAY, plan: null };
        const wrap = reason => new Error(`Error invoking remote method 'interview-window:submit-question': Error: ${reason}`);
        const attempt = async failure => {
          window.interviewAPI = { getBrief: async () => unplanned, onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => { throw failure; }, nextQuestion: async () => unplanned, setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            const form = window.document.querySelector('form');
            await bundle.module.act(async () => { form.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true })); await flush(); });
            return window.document.querySelector('form [role="alert"]')?.textContent || '';
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        try {
          const invalid = await attempt(wrap('Interview question is invalid.'));
          assert(invalid === 'Enter a short interview question (up to 2,000 characters).', `an invalid question keeps the validation text, got: ${invalid}`);
          const preload = await attempt(new TypeError('Interview question must be a bounded string.'));
          assert(preload === invalid, `the preload guard is an invalid question too, got: ${preload}`);
          const snapshot = await attempt(wrap('Interview Window snapshot is unavailable.'));
          const ended = await attempt(wrap('Interview session is not available.'));
          const raw = await attempt(new Error("EACCES: permission denied, open '/Users/someone/Library/Application Support/app/x.json'"));
          assert(/career evidence/u.test(snapshot) && !/short interview question/u.test(snapshot), `an unreadable snapshot must not read as a bad question, got: ${snapshot}`);
          assert(/session has ended/u.test(ended) && !/short interview question/u.test(ended), `a retired session must say so, got: ${ended}`);
          assert(/could not be checked/u.test(raw) && !/Users|EACCES/u.test(raw), `an unknown failure stays generic and never echoes the raw error, got: ${raw}`);
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: the always-on-top checkbox follows the window state main reports and reverts when main does not apply a change',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const mount = async api => {
          window.interviewAPI = { getBrief: async () => ({ ...DISPLAY, plan: null }), onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => DISPLAY, setAlwaysOnTop: async () => true, ...api };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          return root;
        };
        const box = () => window.document.querySelector('.pin input[type=checkbox]');
        try {
          // A normal round trip applies each change in main.
          const calls = [];
          let root = await mount({ setAlwaysOnTop: async value => { calls.push(value); return true; } });
          assert(box().checked === false, 'a window that was never pinned loads unchecked');
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === true, 'a pin that main applied stays checked');
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === false && calls.join() === 'true,false', `an unpin that main applied stays unchecked, calls: ${calls}`);
          await bundle.module.act(async () => root.unmount());
          // A reloaded page re-reads the native pin from main instead of defaulting to unchecked.
          root = await mount({ getBrief: async () => ({ ...DISPLAY, plan: null, alwaysOnTop: true }) });
          assert(box().checked === true, 'a page loaded while the window is pinned must show it pinned');
          await bundle.module.act(async () => root.unmount());
          // Main answers false when it did not apply the change: the box must not claim otherwise.
          root = await mount({ setAlwaysOnTop: async () => false });
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === false, 'a refused pin must revert the checkbox');
          await bundle.module.act(async () => root.unmount());
          // A failed unpin leaves the window pinned, so the box returns to checked (not to a hard-coded false).
          root = await mount({ getBrief: async () => ({ ...DISPLAY, plan: null, alwaysOnTop: true }), setAlwaysOnTop: async () => { throw new Error('ipc failed'); } });
          await bundle.module.act(async () => { box().click(); await flush(); });
          assert(box().checked === true, 'a rejected unpin must restore the checked state');
          await bundle.module.act(async () => root.unmount());
          // A page that first failed to load restores the pin when Retry succeeds.
          let requests = 0;
          root = await mount({ getBrief: async () => { requests += 1; if (requests === 1) throw new Error('unavailable'); return { ...DISPLAY, plan: null, alwaysOnTop: true }; } });
          const retry = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Retry');
          await bundle.module.act(async () => { retry.click(); await flush(); });
          assert(box().checked === true, 'Retry must also restore the pin from main');
          await bundle.module.act(async () => root.unmount());
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: Next question after the session ended shows the missing-brief alert instead of loading forever',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unsupported = { ...DISPLAY, plan: { status: 'unsupported', question: 'Why?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } };
        const attempt = async (shown, buttonLabel) => {
          let closed = false;
          // Main answers null to next-question when the sender has no session.
          window.interviewAPI = { getBrief: async () => shown, onBriefUpdated: () => () => undefined, close: async () => { closed = true; }, submitQuestion: async () => DISPLAY, nextQuestion: async () => null, setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            const button = [...window.document.querySelectorAll('button')].find(item => item.textContent === buttonLabel);
            await bundle.module.act(async () => { button.click(); await flush(); });
            const labels = [...window.document.querySelectorAll('button')].map(item => item.textContent);
            const close = [...window.document.querySelectorAll('button')].filter(item => item.textContent === 'Close').pop();
            await bundle.module.act(async () => { close.click(); await flush(); });
            return { alert: window.document.querySelector('[role="alert"]')?.textContent || '', text: window.document.body.textContent, labels, closed, rail: !!window.document.querySelector('[aria-label="Saved evidence rail"]') };
          } finally { await bundle.module.act(async () => root.unmount()); }
        };
        try {
          for (const [label, shown, buttonLabel] of [['supported rail', DISPLAY, 'Next question'], ['unsupported banner', unsupported, 'Enter another question']]) {
            const result = await attempt(shown, buttonLabel);
            assert(/session has ended/u.test(result.alert), `${label}: a null next-question answer must say the session ended, got: ${result.alert}`);
            assert(!result.text.includes('Loading prepared brief') && !result.rail, `${label}: the window must not fall back to the loading state or keep a stale rail`);
            assert(result.labels.includes('Retry') && result.labels.includes('Close') && result.closed, `${label}: the alert keeps Retry and Close`);
          }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: a rejected Next question is visible while the rail or unsupported banner is shown',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        const unsupported = { ...DISPLAY, plan: { status: 'unsupported', question: 'Why?', currentStep: 0, message: 'No saved evidence matches.', missingComponents: [], steps: [] } };
        try {
          for (const [label, shown, buttonLabel] of [['supported rail', DISPLAY, 'Next question'], ['unsupported banner', unsupported, 'Enter another question']]) {
            let update;
            window.interviewAPI = { getBrief: async () => shown, onBriefUpdated: callback => { update = callback; return () => { update = null; }; }, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => { throw new Error('ipc failed'); }, setAlwaysOnTop: async () => true };
            const root = bundle.module.createRoot(window.document.getElementById('root'));
            try {
              await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
              assert(!window.document.querySelector('[role="alert"]'), `${label}: no alert before anything fails`);
              const button = [...window.document.querySelectorAll('button')].find(item => item.textContent === buttonLabel);
              await bundle.module.act(async () => { button.click(); await flush(); });
              assert(window.document.querySelector('[role="alert"]')?.textContent.includes('could not advance'), `${label}: a rejected Next question must be visible`);
              assert(window.document.body.textContent.includes(shown.plan.status === 'supported' ? 'Locked question' : 'No saved evidence matches.'), `${label}: the current plan stays shown`);
              // The next main-process display replaces the plan, so the message must not go stale.
              await bundle.module.act(async () => { update({ ...DISPLAY, plan: { ...DISPLAY.plan, currentStep: 1 } }); await flush(); });
              assert(!window.document.querySelector('[role="alert"]'), `${label}: a new display clears the message`);
            } finally { await bundle.module.act(async () => root.unmount()); }
          }
          // A load error left from a failed first attempt does not linger over the rail once Retry succeeds.
          let requests = 0;
          window.interviewAPI = { getBrief: async () => { requests += 1; if (requests === 1) throw new Error('unavailable'); return DISPLAY; }, onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => ({ ...DISPLAY, plan: null }), setAlwaysOnTop: async () => true };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          try {
            await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
            assert(window.document.querySelector('[role="alert"]')?.textContent.includes('could not load'), 'the failed first load is reported');
            const retry = [...window.document.querySelectorAll('button')].find(item => item.textContent === 'Retry');
            await bundle.module.act(async () => { retry.click(); await flush(); });
            assert(window.document.querySelector('[aria-label="Saved evidence rail"]') && !window.document.querySelector('[role="alert"]'), 'a successful Retry must not leave the earlier load error over the rail');
          } finally { await bundle.module.act(async () => root.unmount()); }
        } finally { await bundle.dispose(); }
      });
    },
  },
  {
    name: 'interview window render: Retry after the session ended keeps saying the session ended',
    async run() {
      await withDom(async window => {
        const bundle = await bundleComponent(path.resolve('src/interview-window/InterviewWindowApp.jsx'), {});
        let ended = false;
        // Once main reports the session gone, get-brief answers null too.
        window.interviewAPI = { getBrief: async () => (ended ? null : DISPLAY), onBriefUpdated: () => () => undefined, close: async () => true, submitQuestion: async () => DISPLAY, nextQuestion: async () => { ended = true; return null; }, setAlwaysOnTop: async () => true };
        const root = bundle.module.createRoot(window.document.getElementById('root'));
        try {
          await bundle.module.act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewWindowApp)); await flush(); });
          const click = async label => { const target = [...window.document.querySelectorAll('button')].find(item => item.textContent === label); await bundle.module.act(async () => { target.click(); await flush(); await flush(); }); };
          await click('Next question');
          assert(/session has ended/u.test(window.document.querySelector('[role="alert"]')?.textContent || ''), 'the session-ended alert is shown after Next question');
          await click('Retry');
          const alert = window.document.querySelector('[role="alert"]')?.textContent || '';
          assert(/session has ended/u.test(alert) && !/prepared brief/u.test(alert), `a retry that still finds no session must keep the session-ended explanation, got: ${alert}`);
        } finally { await bundle.module.act(async () => root.unmount()); await bundle.dispose(); }
      });
    },
  },
];
