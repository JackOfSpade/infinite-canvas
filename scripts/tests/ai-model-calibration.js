import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assessModel,
  CALIBRATED_MODELS,
  CALIBRATED_ON,
  configureModelCalibration,
  createModelCalibrationMonitor,
  getModelCalibrationStatus,
  MODEL_CALIBRATION_FILE,
  noteResolvedClaudeModel,
  parseClaudeModelId,
  resetModelCalibrationForTests,
} from '../../electron/ipc/aiModelCalibration.js';
import { recalibrationBannerText, recalibrationPrompt } from '../../src/utils/modelRecalibration.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ai-model-calibration-test-'));
const storedFile = dir => path.join(dir, MODEL_CALIBRATION_FILE);
const storedJson = dir => JSON.parse(fs.readFileSync(storedFile(dir), 'utf8'));
const dueStatus = () => ({
  due: true,
  calibrated: CALIBRATED_MODELS,
  calibratedOn: CALIBRATED_ON,
  detections: [
    {
      modelId: 'claude-sonnet-6-0', family: 'sonnet', kind: 'new-version', calibratedId: 'claude-sonnet-5-5',
      firstSeenAt: '2026-11-11T00:00:00.000Z', lastSeenAt: '2026-11-11T00:00:00.000Z', count: 1, sources: ['claude-sdk-stage'],
    },
    {
      modelId: 'claude-abc-1', family: 'abc', kind: 'new-family', calibratedId: null,
      firstSeenAt: '2026-11-11T00:00:01.000Z', lastSeenAt: '2026-11-11T00:00:01.000Z', count: 1, sources: ['practice-call'],
    },
  ],
  playbook: 'docs/ai-model-selection.md, section "New model release playbook"',
});

export default [
  {
    name: 'ai model calibration: parseClaudeModelId keeps version, strips dates and display suffixes',
    run() {
      assert.deepEqual(parseClaudeModelId('claude-sonnet-5-5'), { family: 'sonnet', version: '5-5', normalized: 'claude-sonnet-5-5' });
      assert.deepEqual(parseClaudeModelId('  claude-sonnet-5-5-20261110 '), { family: 'sonnet', version: '5-5', normalized: 'claude-sonnet-5-5' });
      assert.deepEqual(parseClaudeModelId('claude-opus-6[1m]'), { family: 'opus', version: '6', normalized: 'claude-opus-6' });
      assert.deepEqual(parseClaudeModelId('claude-sonnet-6-1'), { family: 'sonnet', version: '6-1', normalized: 'claude-sonnet-6-1' });
      assert.equal(parseClaudeModelId('deepseek-flash'), null);
      assert.equal(parseClaudeModelId(''), null);
      assert.equal(parseClaudeModelId('   '), null);
      assert.equal(parseClaudeModelId(null), null);
      assert.equal(parseClaudeModelId(undefined), null);
      assert.equal(parseClaudeModelId(42), null);
    },
  },
  {
    name: 'ai model calibration: assessModel reports nothing for calibrated ids and classifies new versions and families',
    run() {
      assert.equal(assessModel('claude-sonnet-5-5'), null);
      assert.equal(assessModel('claude-haiku-5-5-20261110'), null);
      assert.deepEqual(assessModel('claude-sonnet-6-0'), {
        modelId: 'claude-sonnet-6-0', family: 'sonnet', kind: 'new-version', calibratedId: 'claude-sonnet-5-5',
      });
      assert.deepEqual(assessModel('claude-abc-1'), {
        modelId: 'claude-abc-1', family: 'abc', kind: 'new-family', calibratedId: null,
      });
      assert.equal(assessModel('deepseek-flash'), null);
    },
  },
  {
    name: 'ai model calibration: a monitor persists detections and a second monitor on the same directory reloads them',
    run() {
      const dir = tempDir();
      const monitor = createModelCalibrationMonitor({ userData: dir, now: () => Date.parse('2026-11-11T00:00:00.000Z') });
      assert.equal(monitor.status().due, false);
      const entry = monitor.note('claude-sonnet-6-0', { source: 'claude-sdk-stage' });
      assert.equal(entry.modelId, 'claude-sonnet-6-0');
      assert.equal(entry.kind, 'new-version');
      assert.equal(entry.calibratedId, 'claude-sonnet-5-5');
      assert.equal(entry.firstSeenAt, '2026-11-11T00:00:00.000Z');
      const stored = storedJson(dir);
      assert.equal(stored.version, 1);
      assert.equal(Object.keys(stored.detections).join(','), 'claude-sonnet-6-0');
      assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.tmp')).length, 0);
      const reloaded = createModelCalibrationMonitor({ userData: dir });
      const status = reloaded.status();
      assert.equal(status.due, true);
      assert.equal(status.calibratedOn, CALIBRATED_ON);
      assert.equal(status.detections.length, 1);
      assert.equal(status.detections[0].modelId, 'claude-sonnet-6-0');
      assert.deepEqual(status.detections[0].sources, ['claude-sdk-stage']);
      assert.equal(status.playbook.includes('New model release playbook'), true);
    },
  },
  {
    name: 'ai model calibration: onChange fires only for a new model id while the repeat updates count and lastSeenAt',
    run() {
      const dir = tempDir();
      const changes = [];
      let clock = Date.parse('2026-11-11T00:00:00.000Z');
      const monitor = createModelCalibrationMonitor({
        userData: dir,
        now: () => clock,
        onChange: status => changes.push(status),
      });
      monitor.note('claude-sonnet-6-0', { source: 'claude-sdk-stage' });
      assert.equal(changes.length, 1);
      assert.equal(changes[0].due, true);
      clock += 60_000;
      const entry = monitor.note('claude-sonnet-6-0', { source: 'practice-call' });
      assert.equal(changes.length, 1);
      assert.equal(entry.count, 2);
      assert.equal(entry.lastSeenAt, '2026-11-11T00:01:00.000Z');
      assert.equal(entry.firstSeenAt, '2026-11-11T00:00:00.000Z');
      assert.deepEqual(entry.sources, ['claude-sdk-stage', 'practice-call']);
      assert.equal(storedJson(dir).detections['claude-sonnet-6-0'].count, 2);
      monitor.note('claude-abc-1');
      assert.equal(changes.length, 2);
      assert.equal(monitor.note('deepseek-flash'), null);
      assert.equal(monitor.note('claude-sonnet-5-5'), null);
      assert.equal(changes.length, 2);
    },
  },
  {
    name: 'ai model calibration: status drops detections the new calibrated set now covers',
    run() {
      const dir = tempDir();
      createModelCalibrationMonitor({ userData: dir }).note('claude-sonnet-6-0');
      const monitor = createModelCalibrationMonitor({ userData: dir, calibrated: { ...CALIBRATED_MODELS, sonnet: 'claude-sonnet-6-0' } });
      const status = monitor.status();
      assert.equal(status.due, false);
      assert.deepEqual(status.detections, []);
      assert.equal(status.calibrated.sonnet, 'claude-sonnet-6-0');
    },
  },
  {
    name: 'ai model calibration: a corrupt store file starts empty and the next note rewrites it',
    run() {
      const dir = tempDir();
      fs.writeFileSync(storedFile(dir), '{not json at all', 'utf8');
      const monitor = createModelCalibrationMonitor({ userData: dir });
      assert.equal(monitor.status().due, false);
      assert.equal(monitor.note('claude-abc-1').kind, 'new-family');
      assert.equal(storedJson(dir).detections['claude-abc-1'].modelId, 'claude-abc-1');
      fs.writeFileSync(storedFile(dir), 'null', 'utf8');
      assert.equal(createModelCalibrationMonitor({ userData: dir }).status().due, false);
    },
  },
  {
    name: 'ai model calibration: singleton is a no-op until configured, then reports and broadcasts',
    run() {
      resetModelCalibrationForTests();
      assert.equal(noteResolvedClaudeModel('claude-sonnet-6-0', 'claude-sdk-stage'), null);
      const idle = getModelCalibrationStatus();
      assert.equal(idle.due, false);
      assert.deepEqual(idle.detections, []);
      assert.equal(idle.calibrated, CALIBRATED_MODELS);
      const dir = tempDir();
      const sent = [];
      const windows = [
        { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: (...args) => sent.push(args) } },
        { isDestroyed: () => true, webContents: { isDestroyed: () => false, send: () => { throw new Error('destroyed window must not receive'); } } },
      ];
      configureModelCalibration({ userData: dir, getAllWindows: () => windows });
      const entry = noteResolvedClaudeModel('claude-sonnet-6-0', 'claude-sdk-stage');
      assert.equal(entry.modelId, 'claude-sonnet-6-0');
      assert.equal(sent.length, 1);
      assert.equal(sent[0][0], 'ai-model-calibration:changed');
      assert.equal(sent[0][1].detections[0].modelId, 'claude-sonnet-6-0');
      assert.equal(getModelCalibrationStatus().due, true);
      const after = noteResolvedClaudeModel('claude-sonnet-6-0', 'practice-call');
      assert.equal(after.count, 2);
      assert.equal(sent.length, 1);
      resetModelCalibrationForTests();
      assert.equal(getModelCalibrationStatus().due, false);
    },
  },
  {
    name: 'ai model calibration: banner text and prompt stay null until the status is due',
    run() {
      assert.equal(recalibrationBannerText(null), null);
      assert.equal(recalibrationBannerText({ due: false, detections: [] }), null);
      assert.equal(recalibrationPrompt(undefined), null);
      assert.equal(recalibrationPrompt({ due: false, detections: [] }), null);
    },
  },
  {
    name: 'ai model calibration: banner text names the detected and calibrated ids per detection kind',
    run() {
      const banner = recalibrationBannerText(dueStatus());
      assert.equal(banner.headline, 'Model recalibration due');
      assert.equal(banner.lines.length, 2);
      assert.equal(banner.lines[0].startsWith('claude-sonnet-6-0 replaced claude-sonnet-5-5 (calibrated 2026-11-10).'), true);
      assert.equal(banner.lines[0].includes('Re-check every call on Sonnet, and probe Sonnet'), true);
      assert.equal(banner.lines[1], 'claude-abc-1 is a new model family. Test all its efforts below max on every call it could serve.');
      assert.equal(banner.footer.includes('CALIBRATED_MODELS in electron/ipc/aiModelCalibration.js'), true);
    },
  },
  {
    name: 'ai model calibration: prompt names the new ids, the playbook, the durable-run rules and the constant update',
    run() {
      const prompt = recalibrationPrompt(dueStatus());
      assert.equal(prompt.includes('Detected (calibrated on 2026-11-10):'), true);
      assert.equal(prompt.includes('- claude-sonnet-6-0 replaced claude-sonnet-5-5'), true);
      assert.equal(prompt.includes('- claude-abc-1 is a new model family'), true);
      assert.equal(prompt.includes('New model release playbook'), true);
      assert.equal(prompt.includes('scripts/ai-test-journal.mjs record'), true);
      assert.equal(prompt.includes('~/Library/Application Support/infinite-canvas/ai-test-runs/'), true);
      assert.equal(prompt.includes('set CALIBRATED_MODELS in electron/ipc/aiModelCalibration.js'), true);
      assert.equal(prompt.includes('npm run test:unit and confirm 0 failed.'), true);
      assert.equal(prompt.trimEnd().endsWith('Report the cost and number of model calls you spent.'), true);
    },
  },
];
