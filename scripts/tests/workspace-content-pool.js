import assert from 'node:assert/strict';
import {
  parseWorkspaceText,
  poolWorkspaceContent,
  restoreWorkspaceContent,
  WORKSPACE_POOL_KEY,
  WORKSPACE_REF_KEY,
} from '../../electron/ipc/workspaceContentPool.js';
import { serializeWorkspaceForSave } from '../../electron/ipc/filesystem.js';

const longText = label => `${label} `.repeat(200);
const roundTrip = data => restoreWorkspaceContent(JSON.parse(JSON.stringify(poolWorkspaceContent(data))));

function repeatedCanvas() {
  const assessment = { matches: [{ detail: longText('match') }], score: 7 };
  const snippet = longText('snippet');
  return {
    schemaVersion: 11,
    nodes: [{
      id: 'hub', type: 'jobhub', data: {
        scoredJobs: [{ title: 'A', snippet, preferenceAssessment: { ...assessment } }],
        preferenceCandidatePool: [{ title: 'A', snippet, preferenceAssessment: { ...assessment } }],
        preferenceEvaluation: { audits: [{ index: 0, matches: assessment.matches.map(item => ({ ...item })) }] },
      },
    }],
    edges: [], drawings: [],
  };
}

export default [
  { name: 'Canvas pool stores repeated content once and restores the exact saved text', run() {
    const data = repeatedCanvas();
    const plain = JSON.stringify(data);
    const pooled = JSON.stringify(poolWorkspaceContent(data));
    assert.ok(pooled.length < plain.length * 0.6, 'repeats are not stored again');
    assert.equal(pooled.split('snippet snippet snippet').length > 1, true);
    assert.equal(JSON.stringify(restoreWorkspaceContent(JSON.parse(pooled))), plain);
  } },
  { name: 'Restored canvas copies are independent, so editing one job cannot change another', run() {
    const restored = roundTrip(repeatedCanvas());
    const { scoredJobs, preferenceCandidatePool } = restored.nodes[0].data;
    assert.deepEqual(scoredJobs[0].preferenceAssessment, preferenceCandidatePool[0].preferenceAssessment);
    assert.notEqual(scoredJobs[0].preferenceAssessment, preferenceCandidatePool[0].preferenceAssessment);
    scoredJobs[0].preferenceAssessment.matches[0].detail = 'edited';
    assert.notEqual(preferenceCandidatePool[0].preferenceAssessment.matches[0].detail, 'edited');
  } },
  { name: 'Canvas pool keeps JSON meaning for key order, odd values and __proto__ keys', run() {
    const text = longText('value');
    const hostileKey = JSON.parse(`{"__proto__":{"text":${JSON.stringify(text)}},"after":1}`);
    const data = {
      nodes: [
        { a: text, b: 1 }, { b: 1, a: text },
        { skipped: undefined, fn: () => 1, nan: Number.NaN, list: [undefined, Number.POSITIVE_INFINITY], when: new Date(0), repeat: text },
        hostileKey, JSON.parse(JSON.stringify(hostileKey)),
      ],
    };
    const restored = roundTrip(data);
    assert.equal(JSON.stringify(restored), JSON.stringify(data));
    assert.equal(Object.getPrototypeOf(restored.nodes[3]), Object.prototype);
  } },
  { name: 'Canvas pool leaves unrepeated or reserved-key data in the plain form', run() {
    assert.equal(poolWorkspaceContent({ nodes: [{ text: longText('once') }] }), null);
    const collision = { nodes: [{ a: longText('x'), b: longText('x'), c: { [WORKSPACE_REF_KEY]: 0 } }] };
    assert.equal(poolWorkspaceContent(collision), null);
    assert.equal(JSON.parse(serializeWorkspaceForSave(collision)).nodes[0].c[WORKSPACE_REF_KEY], 0);
    assert.equal(WORKSPACE_POOL_KEY in JSON.parse(serializeWorkspaceForSave(collision)), false);
  } },
  { name: 'A plain older canvas loads unchanged, and a damaged or newer pool is refused', run() {
    const older = { nodes: [{ id: 'n' }], edges: [] };
    assert.equal(restoreWorkspaceContent(older), older);
    assert.throws(() => restoreWorkspaceContent({ nodes: [], [WORKSPACE_POOL_KEY]: { version: 2, values: [] } }), /newer or unknown/);
    assert.throws(() => restoreWorkspaceContent({ nodes: [{ [WORKSPACE_REF_KEY]: 5 }], [WORKSPACE_POOL_KEY]: { version: 1, values: [] } }), /broken content reference/);
  } },
  { name: 'A saved canvas with repeats is written pooled and restores to the same content', run() {
    const data = repeatedCanvas();
    const saved = serializeWorkspaceForSave(data);
    assert.equal(JSON.stringify(parseWorkspaceText(saved)), JSON.stringify(data));
    assert.throws(() => JSON.parse(saved), SyntaxError, 'a build without the pool refuses this file instead of saving references back');
  } },
];
