import { assert } from './testHelpers.js';
import { hostileListing } from './fixtures/handoff-bridge/synthetic.js';

export default [{
  name: 'handoff bridge: hostile: synthetic hostile fixture carries markup and a remote URL',
  run: () => {
    assert(hostileListing.description.includes('<script>') && hostileListing.description.includes('https://example.com/'), 'hostile fixture must exercise markup and a remote URL');
    assert(hostileListing.url === 'https://example.com/jobs/ada', 'hostile fixture must remain synthetic');
  },
}];
