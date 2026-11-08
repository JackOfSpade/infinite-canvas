import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRows, renderMarkdown, summarize, wilson } from '../ai-shadow-report.mjs';

const SCRIPT = fileURLToPath(new URL('../ai-shadow-report.mjs', import.meta.url));
const REPO = path.resolve(path.dirname(SCRIPT), '..');

// One Claude answer per sample; every config gets one row per sample.
// configs: [{ route, reasoning, cost, latency, valid(i) => bool, ok(i) => bool }]
function makeRows({ kind = 'task', id = 'stage-a', samples, claudeAccepted, configs }) {
  const rows = [];
  for (let i = 0; i < samples; i += 1) {
    const claude = { model: 'claude-x', effort: 'high', costUsd: 0.05, durationMs: 1000 + i, outcome: i < claudeAccepted ? 'accepted' : 'rejected', validationCode: null };
    for (const config of configs) {
      const ok = config.ok ? config.ok(i) : true;
      rows.push({
        at: '2025-01-01T00:00:00.000Z', kind, id, sampleId: `s${i}`, route: config.route, reasoning: config.reasoning, rep: 1,
        ok, valid: ok && config.valid(i), code: null, costUsd: ok ? config.cost : null, latencyMs: config.latency + i, usage: null, model: 'm', claude,
      });
    }
  }
  return rows;
}

const toText = rows => `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
const flash = (reasoning, extra) => ({ route: 'deepseek-flash', reasoning, cost: 0.001, latency: 500, ...extra });
const pro = (reasoning, extra) => ({ route: 'deepseek-pro', reasoning, cost: 0.01, latency: 900, ...extra });
const find = (group, route, reasoning) => group.configs.find(config => config.route === route && config.reasoning === reasoning);

export default [
  {
    name: 'ai shadow report: wilson interval matches the known 8/10 value and handles n=0',
    async run() {
      const { rate, low, high } = wilson(8, 10);
      assert.equal(rate, 0.8);
      assert.ok(Math.abs(low - 0.4902) < 0.001, `low ${low}`);
      assert.ok(Math.abs(high - 0.9433) < 0.001, `high ${high}`);
      assert.deepEqual(wilson(0, 0), { rate: null, low: null, high: null });
    },
  },
  {
    name: 'ai shadow report: Claude baseline is counted once per sampleId and parseRows skips junk lines',
    async run() {
      const rows = makeRows({ samples: 5, claudeAccepted: 4, configs: [flash('off', { valid: () => true }), pro('high', { valid: () => true })] });
      const parsed = parseRows(`not json\n\n[1]\n${toText(rows)}{"kind":"task"}\n`);
      assert.equal(parsed.length, 10);
      const [group] = summarize(parsed, { minSamples: 3 }).groups;
      assert.equal(group.claude.samples, 5);
      assert.equal(group.claude.acceptanceRate, 0.8);
      assert.ok(Math.abs(group.claude.meanCostUsd - 0.05) < 1e-12);
      assert.equal(group.claude.p50DurationMs, 1002);
      assert.equal(find(group, 'deepseek-flash', 'off').n, 5);
      assert.equal(find(group, 'deepseek-pro', 'high').n, 5);
    },
  },
  {
    name: 'ai shadow report: qa rows with a null outcome count as accepted',
    async run() {
      const rows = makeRows({ kind: 'qa', id: 'review', samples: 4, claudeAccepted: 4, configs: [flash('off', { valid: () => true })] });
      for (const row of rows) row.claude.outcome = null;
      const [group] = summarize(rows, { minSamples: 2 }).groups;
      assert.equal(group.claude.acceptanceRate, 1);
    },
  },
  {
    name: 'ai shadow report: the cheapest eligible config wins over a pricier, better one',
    async run() {
      const rows = makeRows({
        samples: 40, claudeAccepted: 36,
        configs: [
          flash('off', { valid: i => i >= 2 }), // 95% valid, cheapest
          flash('low', { cost: 0.002, valid: i => i >= 2 }),
          pro('high', { valid: () => true }), // 100% valid, priciest
        ],
      });
      const [group] = summarize(rows, { minSamples: 30 }).groups;
      assert.equal(group.recommendation.decision, 'recommend');
      assert.equal(group.recommendation.route, 'deepseek-flash');
      assert.equal(group.recommendation.reasoning, 'off');
      assert.equal(find(group, 'deepseek-pro', 'high').eligible, true);
      assert.match(renderMarkdown(summarize(rows, { minSamples: 30 })), /\*\*Recommendation:\*\* deepseek-flash off/);
    },
  },
  {
    name: 'ai shadow report: equal cost falls back to the lower p50 latency',
    async run() {
      const rows = makeRows({
        samples: 40, claudeAccepted: 40,
        configs: [flash('low', { latency: 800, valid: () => true }), flash('medium', { latency: 300, valid: () => true })],
      });
      const [group] = summarize(rows, { minSamples: 30 }).groups;
      assert.equal(group.recommendation.reasoning, 'medium');
    },
  },
  {
    name: 'ai shadow report: a config significantly below Claude is rejected even when cheaper',
    async run() {
      const rows = makeRows({
        samples: 40, claudeAccepted: 40,
        configs: [flash('off', { valid: i => i < 28 }), pro('high', { valid: () => true })],
      });
      const [group] = summarize(rows, { minSamples: 30 }).groups;
      assert.equal(find(group, 'deepseek-flash', 'off').eligible, false);
      assert.equal(find(group, 'deepseek-flash', 'off').belowClaude, true);
      assert.equal(group.recommendation.route, 'deepseek-pro');
      const onlyFlash = makeRows({ samples: 40, claudeAccepted: 40, configs: [flash('off', { valid: i => i < 28 })] });
      const [stay] = summarize(onlyFlash, { minSamples: 30 }).groups;
      assert.equal(stay.recommendation.decision, 'stay');
      assert.match(stay.recommendation.reason, /below Claude/);
    },
  },
  {
    name: 'ai shadow report: a config not within noise of the best config is rejected',
    async run() {
      // Claude is weak (60%) so both clear the Claude test, but 70% is far below the 100% best.
      const rows = makeRows({
        samples: 100, claudeAccepted: 60,
        configs: [flash('off', { valid: i => i < 70 }), pro('high', { valid: () => true })],
      });
      const [group] = summarize(rows, { minSamples: 30 }).groups;
      assert.equal(find(group, 'deepseek-flash', 'off').belowClaude, false);
      assert.equal(find(group, 'deepseek-flash', 'off').eligible, false);
      assert.equal(group.recommendation.route, 'deepseek-pro');
    },
  },
  {
    name: 'ai shadow report: too few samples means stay on Claude',
    async run() {
      const rows = makeRows({ samples: 10, claudeAccepted: 10, configs: [flash('off', { valid: () => true })] });
      const summary = summarize(rows, { minSamples: 30 });
      assert.equal(summary.groups[0].recommendation.decision, 'stay');
      assert.match(summary.groups[0].recommendation.reason, /too few samples/);
      assert.match(renderMarkdown(summary), /stay on Claude — too few samples/);
      assert.equal(summarize(rows, { minSamples: 10 }).groups[0].recommendation.decision, 'recommend');
    },
  },
  {
    name: 'ai shadow report: a failure rate above 5% is rejected',
    async run() {
      const flaky = flash('off', { ok: i => i >= 4, valid: () => true }); // 4/40 = 10% call failures
      const only = makeRows({ samples: 40, claudeAccepted: 30, configs: [flaky] });
      const [stay] = summarize(only, { minSamples: 30 }).groups;
      assert.equal(find(stay, 'deepseek-flash', 'off').failureRate, 0.1);
      assert.equal(stay.recommendation.decision, 'stay');
      assert.match(stay.recommendation.reason, /failure/);
      const steady = pro('high', { ok: i => i !== 0, valid: () => true }); // 1/40 = 2.5%
      const both = makeRows({ samples: 40, claudeAccepted: 30, configs: [flaky, steady] });
      const [pick] = summarize(both, { minSamples: 30 }).groups;
      assert.equal(pick.recommendation.route, 'deepseek-pro');
    },
  },
  {
    name: 'ai shadow report: output always carries the blind-judge footnote and a Claude row',
    async run() {
      const markdown = renderMarkdown(summarize(makeRows({ samples: 3, claudeAccepted: 3, configs: [flash('off', { valid: () => true })] }), { minSamples: 30 }));
      assert.match(markdown, /\| Claude baseline \| 3 \|/);
      assert.match(markdown, /blind quality judge is still needed/);
      assert.match(renderMarkdown(summarize([], { minSamples: 30 })), /blind quality judge is still needed/);
    },
  },
  {
    name: 'ai shadow report: CLI refuses a --dir inside the repository, and supports --help and --json',
    async run() {
      const inside = spawnSync(process.execPath, [SCRIPT, '--dir', path.join(REPO, 'scripts')], { encoding: 'utf8' });
      assert.notEqual(inside.status, 0);
      assert.match(inside.stderr, /inside the repository/);
      assert.equal(inside.stdout, '');
      const repoRoot = spawnSync(process.execPath, [SCRIPT, '--dir', REPO], { encoding: 'utf8' });
      assert.notEqual(repoRoot.status, 0);
      assert.match(repoRoot.stderr, /inside the repository/);

      const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
      assert.equal(help.status, 0);
      assert.match(help.stdout, /^Usage: node scripts\/ai-shadow-report\.mjs --dir/);

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-shadow-report-test-'));
      try {
        fs.writeFileSync(path.join(dir, 'shadow.jsonl'), toText(makeRows({ samples: 5, claudeAccepted: 5, configs: [flash('off', { valid: () => true })] })));
        const json = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--min-samples', '5', '--json'], { encoding: 'utf8' });
        assert.equal(json.status, 0, json.stderr);
        const parsed = JSON.parse(json.stdout);
        assert.equal(parsed.minSamples, 5);
        assert.equal(parsed.groups[0].recommendation.decision, 'recommend');
        const md = spawnSync(process.execPath, [SCRIPT, '--dir', dir, '--min-samples', '5'], { encoding: 'utf8' });
        assert.equal(md.status, 0, md.stderr);
        assert.match(md.stdout, /## task \/ stage-a/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  },
];
