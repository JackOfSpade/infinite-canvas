import fs from 'node:fs';
import { assert } from './testHelpers.js';

const nonApiAiUrl = new URL('../../electron/ipc/nonApiAi.js', import.meta.url);
const seamPatchUrl = new URL('../../docs/chatgpt-bridge-phase1/push-seam-prototype/nonApiAi.seam.patch', import.meta.url);
const seamBlockUrl = new URL('../../docs/chatgpt-bridge-phase1/push-seam-prototype/seam-block.js.txt', import.meta.url);

export default [{
  name: 'handoff bridge: seam: prototype pins the hoist anchor and all bridge exports',
  run: () => {
    const source = fs.readFileSync(nonApiAiUrl, 'utf8');
    const patch = fs.readFileSync(seamPatchUrl, 'utf8');
    const block = fs.readFileSync(seamBlockUrl, 'utf8');
    assert(source.includes('submit-non-api-ai-response'), 'the seam must remain anchored to the existing submit handler');
    assert(source.includes('registerNonApiAiHandlers'), 'the seam must remain inside the existing handler module');
    assert(patch.includes('async function acceptNonApiAiResponse(record, args)') && patch.includes('grounded: grounding === true,'), 'prototype must preserve the two B5a edit anchors');
    for (const exported of ['listBridgeableNonApiAiHandoffs', 'readBridgeableNonApiAiHandoff', 'submitNonApiAiResponseForBridge']) {
      assert(block.includes(`export ${exported.includes('submit') ? 'async function' : 'function'} ${exported}`), `seam block must export ${exported}`);
    }
  },
}];
