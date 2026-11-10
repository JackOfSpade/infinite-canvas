import test from 'node:test';
import assert from 'node:assert/strict';

// The runner reads its overrides once at module load, so clear any harness
// variables inherited from the shell before importing it: every assertion here
// must see the production profiles unless it passes an explicit env.
delete process.env.INFINITE_CANVAS_E2E;
delete process.env.INFINITE_CANVAS_STAGE_PROFILES;

const {
  claudeStageProfile,
  parseStageProfileOverrides,
  stageProfileOverridesFromEnv,
} = await import('../electron/ipc/claudeApplicationRunner.js');

test('parseStageProfileOverrides parses a valid list into frozen profiles', () => {
  const overrides = parseStageProfileOverrides('convert=haiku:medium, verify-correction=sonnet:low');
  assert.deepEqual(overrides, {
    convert: { model: 'haiku', effort: 'medium' },
    'verify-correction': { model: 'sonnet', effort: 'low' },
  });
  assert.ok(Object.isFrozen(overrides));
  assert.ok(Object.isFrozen(overrides.convert));
  assert.deepEqual(parseStageProfileOverrides('write=opus:xhigh'), { write: { model: 'opus', effort: 'xhigh' } });
});

test('parseStageProfileOverrides returns an empty frozen object for empty input', () => {
  for (const value of [undefined, null, '', '   ', ' , ']) {
    const overrides = parseStageProfileOverrides(value);
    assert.deepEqual(overrides, {});
    assert.ok(Object.isFrozen(overrides));
    assert.ok(!Object.hasOwn(overrides, 'write'));
  }
});

test('parseStageProfileOverrides rejects the max effort and names the entry', () => {
  assert.throws(() => parseStageProfileOverrides('write=opus:max'), error => {
    assert.match(error.message, /write=opus:max/u);
    assert.match(error.message, /effort/u);
    return true;
  });
});

test('parseStageProfileOverrides rejects fable and unknown models', () => {
  assert.throws(() => parseStageProfileOverrides('write=fable:high'), error => {
    assert.match(error.message, /write=fable:high/u);
    assert.match(error.message, /model/u);
    return true;
  });
  assert.throws(() => parseStageProfileOverrides('convert=sonnet:medium,pick=gpt:low'), error => {
    assert.match(error.message, /pick=gpt:low/u);
    assert.match(error.message, /model/u);
    return true;
  });
});

test('parseStageProfileOverrides rejects malformed entries', () => {
  for (const value of ['write', '=opus:high', 'write=opus', 'write=:high', 'write=opus:', 'write=opus:high:extra']) {
    assert.throws(() => parseStageProfileOverrides(value), /Stage profile override/u);
  }
});

test('stageProfileOverridesFromEnv honors the variable only under INFINITE_CANVAS_E2E=1', () => {
  const profiles = 'convert=haiku:medium';
  assert.deepEqual(stageProfileOverridesFromEnv({ INFINITE_CANVAS_STAGE_PROFILES: profiles }), {});
  assert.deepEqual(stageProfileOverridesFromEnv({ INFINITE_CANVAS_E2E: '0', INFINITE_CANVAS_STAGE_PROFILES: profiles }), {});
  assert.deepEqual(stageProfileOverridesFromEnv({ INFINITE_CANVAS_E2E: 'true', INFINITE_CANVAS_STAGE_PROFILES: profiles }), {});
  assert.deepEqual(stageProfileOverridesFromEnv({}), {});
  assert.deepEqual(
    stageProfileOverridesFromEnv({ INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_STAGE_PROFILES: profiles }),
    { convert: { model: 'haiku', effort: 'medium' } },
  );
  // The gate comes first: a bad value outside the harness is never parsed.
  assert.deepEqual(stageProfileOverridesFromEnv({ INFINITE_CANVAS_STAGE_PROFILES: 'write=fable:max' }), {});
  assert.throws(() => stageProfileOverridesFromEnv({ INFINITE_CANVAS_E2E: '1', INFINITE_CANVAS_STAGE_PROFILES: 'write=fable:max' }), /write=fable:max/u);
});

test('claudeStageProfile keeps the production profile without an active override', () => {
  assert.deepEqual(claudeStageProfile('write'), { model: 'opus', effort: 'low' });
  assert.deepEqual(claudeStageProfile('convert'), { model: 'sonnet', effort: 'medium' });
  // A stage the table does not name falls back to the default profile.
  assert.deepEqual(claudeStageProfile('no-such-stage'), { model: 'sonnet', effort: 'high' });
});
