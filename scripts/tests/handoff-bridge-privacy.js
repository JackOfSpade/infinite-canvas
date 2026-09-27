import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { assert } from './testHelpers.js';
import { SENTINEL_PREFIX, assertNoSentinel, sentinel } from './fixtures/handoff-bridge/sentinels.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/handoff-bridge/', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function filesRecursively(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...filesRecursively(target));
    else if (entry.isFile()) files.push(target);
  }
  return files;
}

function isSyntheticPhone(value) {
  const digits = value.replace(/\D/g, '');
  return /^55501\d{2}$/.test(digits);
}

const PHONE_CANDIDATE = /(?<![\w])(?:\+?1[-. ()]*)?(?:\(?\d{3}\)?[-. ]*)?\d{3}[-. ]?\d{4}(?![\w])/g;

export default [{
  name: 'handoff bridge: privacy: sentinels, fixture contacts and paths are safe',
  run: () => {
    const value = sentinel('chat-key');
    assert(value.startsWith(SENTINEL_PREFIX), 'privacy sentinel must be uniquely recognizable');
    assertNoSentinel('fixed safe output');
    let caught = false;
    try {
      assertNoSentinel(`leak ${value}`);
    } catch {
      caught = true;
    }
    assert(caught, 'privacy sentinel must make a leak test fail');
    const realLookingPhone = '+1 416 555 0123';
    assert(realLookingPhone.match(PHONE_CANDIDATE)?.[0] === realLookingPhone, 'phone scan must capture a full NANP candidate, not an inner seven-digit suffix');
    assert(!isSyntheticPhone(realLookingPhone), 'only the designated 555-01xx fixture range is synthetic');

    const fixtureFiles = filesRecursively(fixtureDirectory);
    assert(fixtureFiles.length > 0, 'fixture directory must not be empty');
    for (const file of fixtureFiles) {
      const content = fs.readFileSync(file, 'utf8');
      for (const email of content.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || []) {
        assert(email.toLowerCase().endsWith('@example.com'), `${path.basename(file)} contains a non-synthetic email`);
      }
      for (const phone of content.match(PHONE_CANDIDATE) || []) {
        assert(isSyntheticPhone(phone), `${path.basename(file)} contains a non-synthetic phone`);
      }
      const relative = path.relative(repoRoot, file);
      const checked = spawnSync('git', ['check-ignore', '-q', '--', relative], { cwd: repoRoot, encoding: 'utf8' });
      assert(checked.status === 1, `${relative} is ignored and would disappear from CI`);
    }
  },
}];
