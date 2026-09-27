import fs from 'node:fs';
import { assert } from './testHelpers.js';

const seamBlockUrl = new URL('../../docs/chatgpt-bridge-phase1/push-seam-prototype/seam-block.js.txt', import.meta.url);

export default [{
  name: 'handoff bridge: push: prototype keeps default-deny structural exclusions',
  run: () => {
    const source = fs.readFileSync(seamBlockUrl, 'utf8');
    for (const reason of ['attachment', 'grounded', 'free_text', 'task_not_allowed', 'node_not_allowed', 'person_editing']) {
      assert(source.includes(`'${reason}'`), `prototype must default-deny ${reason}`);
    }
    assert(source.includes('allowTasks instanceof Set') && source.includes('allowNodeIds'), 'prototype must require explicit task and node allowlists');
  },
}];
