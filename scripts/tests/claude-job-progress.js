import { assert } from './testHelpers.js';
import { CLAUDE_PROGRESS_COPY, claudeProgressTimeLines, deriveClaudeJobProgress } from '../../src/utils/claudeJobProgress.js';
import { deriveBridgeJobProgress } from '../../src/utils/bridgeJobProgress.js';
import { applicationStageLabel } from '../../src/utils/applicationHandoffDock.js';

const KEYS = ['evidence-plan', 'resume', 'cover-letter', 'review'];
const expectedSteps = states => KEYS.map((key, index) => ({ key, label: applicationStageLabel(key), state: states[index] }));
const json = value => JSON.stringify(value);
const sameSteps = (actual, expected, context) => {
  assert(json(actual) === json(expected), `${context}: expected ${json(expected)}, got ${json(actual)}`);
};

const running = (stage, ...rest) => ({ status: 'running', stage, code: '', message: '', updatedAt: rest.length ? rest[0] : 1000 });

export default [
  {
    name: 'claude progress: each writing stage marks done/current/upcoming steps',
    run() {
      sameSteps(deriveClaudeJobProgress({ run: running('evidence-plan') }).steps,
        expectedSteps(['current', 'upcoming', 'upcoming', 'upcoming']), 'evidence-plan');
      sameSteps(deriveClaudeJobProgress({ run: running('resume') }).steps,
        expectedSteps(['done', 'current', 'upcoming', 'upcoming']), 'resume');
      sameSteps(deriveClaudeJobProgress({ run: running('cover-letter') }).steps,
        expectedSteps(['done', 'done', 'current', 'upcoming']), 'cover-letter');
    },
  },
  {
    name: 'claude progress: review-bucket stages mark Review and edit current',
    run() {
      for (const stage of ['write', 'convert', 'fit-correction', 'fact-check', 'blind-review']) {
        const view = deriveClaudeJobProgress({ run: running(stage) });
        sameSteps(view.steps, expectedSteps(['done', 'done', 'done', 'current']), stage);
        assert(view.headline === `Claude is working on: ${applicationStageLabel('review')}`, `${stage}: headline ${view.headline}`);
      }
    },
  },
  {
    name: 'claude progress: writing view shape, tone and stage-labelled headline',
    run() {
      const view = deriveClaudeJobProgress({ run: running('resume', 5000), item: { stage: 'resume' } });
      assert(view.kind === 'claude-writing', `kind ${view.kind}`);
      assert(view.tone === 'working', `tone ${view.tone}`);
      assert(view.headline === `Claude is working on: ${applicationStageLabel('resume')}`, `headline ${view.headline}`);
      assert(typeof view.detail === 'string' && view.detail === 'Running on this computer.', `detail ${view.detail}`);
      assert(view.lastHeard === null && view.action === null && view.actionLabel === null, 'no last-heard or action');
      assert(view.since === 5000, `since ${view.since}`);
    },
  },
  {
    name: 'claude progress: falls back to the dock item stage when the run has none',
    run() {
      const view = deriveClaudeJobProgress({ run: running(''), item: { stage: 'cover-letter' } });
      sameSteps(view.steps, expectedSteps(['done', 'done', 'current', 'upcoming']), 'item stage');
    },
  },
  {
    name: 'claude progress: unknown or missing stage shows all upcoming and the generic headline',
    run() {
      for (const stage of ['mystery-stage', null, undefined, '']) {
        const view = deriveClaudeJobProgress({ run: running(stage) });
        sameSteps(view.steps, expectedSteps(['upcoming', 'upcoming', 'upcoming', 'upcoming']), String(stage));
        assert(view.headline === 'Claude is working on this', `${String(stage)}: headline ${view.headline}`);
        assert(view.kind === 'claude-writing', `${String(stage)}: kind ${view.kind}`);
      }
    },
  },
  {
    name: 'claude progress: corrections switch to the fixing kind with a pluralized headline',
    run() {
      const one = deriveClaudeJobProgress({ run: running('resume'), item: { corrections: ['a', null, ''] } });
      assert(one.kind === 'claude-fixing', `kind ${one.kind}`);
      assert(one.headline === 'Claude is fixing 1 issue', `headline ${one.headline}`);
      sameSteps(one.steps, expectedSteps(['done', 'current', 'upcoming', 'upcoming']), 'fixing steps');
      const many = deriveClaudeJobProgress({ run: running('resume'), item: { corrections: ['a', 'b', 'c'] } });
      assert(many.headline === 'Claude is fixing 3 issues', `headline ${many.headline}`);
      const none = deriveClaudeJobProgress({ run: running('resume'), item: { corrections: [null, false] } });
      assert(none.kind === 'claude-writing', `all-falsy corrections stay writing, got ${none.kind}`);
    },
  },
  {
    name: 'claude progress: since passes updatedAt through and rejects bad values',
    run() {
      assert(deriveClaudeJobProgress({ run: running('resume', 0) }).since === 0, 'zero is a valid time');
      assert(deriveClaudeJobProgress({ run: running('resume', 1234567) }).since === 1234567, 'valid time passes');
      for (const bad of [-1, NaN, Infinity, '1000', null, undefined, {}]) {
        const since = deriveClaudeJobProgress({ run: running('resume', bad) }).since;
        assert(since === null, `${String(bad)} should give null, got ${since}`);
      }
    },
  },
  {
    name: 'claude progress: steps deep-equal the ChatGPT bridge steps for the same stage',
    run() {
      for (const stage of ['evidence-plan', 'resume', 'cover-letter', 'write', 'fact-check', 'blind-review', 'mystery-stage']) {
        const bridge = deriveBridgeJobProgress({
          job: { jobId: 'j1', phase: 'awaiting', stage, awaitingAnswer: true, servedAt: 1000 },
          chat: { state: 'working', ordinal: 1 },
          item: { stage },
        });
        assert(bridge.kind === 'writing', `${stage}: bridge fixture must reach the writing branch, got ${bridge.kind}`);
        const claude = deriveClaudeJobProgress({ run: running(stage), item: { stage } });
        sameSteps(claude.steps, bridge.steps, `${stage} vs bridge`);
      }
    },
  },
  {
    name: 'claude progress: malformed input never throws and stays neutral',
    run() {
      const all = expectedSteps(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
      const hostile = {};
      Object.defineProperty(hostile, 'stage', { get() { throw new Error('boom'); } });
      for (const input of [undefined, null, 42, 'x', [], { run: null, item: null }, { run: [], item: 'x' }, { run: hostile }]) {
        let view;
        try {
          view = deriveClaudeJobProgress(input);
        } catch (error) {
          assert(false, `threw for ${json(input)}: ${error.message}`);
        }
        sameSteps(view.steps, all, `malformed ${json(input)}`);
        assert(view.headline === 'Claude is working on this', `headline ${view.headline}`);
        assert(view.tone === 'working', `tone ${view.tone}`);
      }
    },
  },
  {
    name: 'claude progress: lastHeard comes from run.lastActivityAt and rejects bad values',
    run() {
      const heard = deriveClaudeJobProgress({ run: { ...running('resume', 1000), lastActivityAt: 4321 } });
      assert(heard.lastHeard === 4321, `lastHeard ${heard.lastHeard}`);
      const fixing = deriveClaudeJobProgress({ run: { ...running('resume', 1000), lastActivityAt: 0 }, item: { corrections: ['x'] } });
      assert(fixing.kind === 'claude-fixing' && fixing.lastHeard === 0, `fixing lastHeard ${fixing.lastHeard}`);
      for (const bad of [-5, NaN, Infinity, '4321', null, undefined]) {
        const value = deriveClaudeJobProgress({ run: { ...running('resume', 1000), lastActivityAt: bad } }).lastHeard;
        assert(value === null, `${String(bad)} should give null lastHeard, got ${value}`);
      }
    },
  },
  {
    name: 'claude progress: time lines show Elapsed and Last heard from Claude together while writing',
    run() {
      const view = deriveClaudeJobProgress({ run: { ...running('resume', 100000), lastActivityAt: 148000 } });
      const lines = claudeProgressTimeLines(view, 160000);
      assert(lines.elapsed === 'Elapsed: 1 min', `elapsed ${lines.elapsed}`);
      assert(lines.heard === 'Last heard from Claude 12s ago', `heard ${lines.heard}`);
      assert(CLAUDE_PROGRESS_COPY.lastHeard('x') === 'Last heard from Claude x', 'copy');
    },
  },
  {
    name: 'claude progress: heard is "just now" under 2 s and clamps future activity',
    run() {
      const view = deriveClaudeJobProgress({ run: { ...running('resume', 1000), lastActivityAt: 10000 } });
      assert(claudeProgressTimeLines(view, 11999).heard === 'Last heard from Claude just now', 'under 2 s');
      assert(claudeProgressTimeLines(view, 12000).heard === 'Last heard from Claude 2s ago', 'at 2 s');
      assert(claudeProgressTimeLines(view, 5000).heard === 'Last heard from Claude just now', 'future activity clamps to 0');
      assert(claudeProgressTimeLines(view, 11999).elapsed === 'Elapsed: 10s', 'elapsed alongside');
    },
  },
  {
    name: 'claude progress: notHeardYet with only since; nothing when both are unknown',
    run() {
      const onlySince = claudeProgressTimeLines(deriveClaudeJobProgress({ run: running('resume', 1000) }), 31000);
      assert(onlySince.elapsed === 'Elapsed: 30s', `elapsed ${onlySince.elapsed}`);
      assert(onlySince.heard === 'Nothing heard from Claude yet in this step', `heard ${onlySince.heard}`);
      assert(onlySince.heard === CLAUDE_PROGRESS_COPY.notHeardYet, 'uses the copy constant');
      const none = claudeProgressTimeLines(deriveClaudeJobProgress({ run: running('resume', null) }), 31000);
      assert(none.elapsed === null && none.heard === null, `both null, got ${json(none)}`);
      for (const bad of [undefined, null, 42, 'x']) {
        const out = claudeProgressTimeLines(bad, 1000);
        assert(out.elapsed === null && out.heard === null, `malformed view ${json(bad)}`);
      }
    },
  },
];
