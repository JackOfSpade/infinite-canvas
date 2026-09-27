import { assert } from './testHelpers.js';
import { adaFlow } from './fixtures/handoff-bridge/adaFlow.js';
import { persona } from './fixtures/handoff-bridge/synthetic.js';
import {
  discoverLocalApplicationJobs,
  getLocalApplicationHandoff,
  localApplicationStatus,
  submitLocalApplicationHandoff,
} from '../test-dependencies.js';

export default [{
  name: 'handoff bridge: application: Ada fixture and the four frozen adapter exports are available',
  run: () => {
    assert(adaFlow.map(step => step.stage).join(',') === 'evidence-plan,resume,cover-letter,review', 'the fixture must model the app handoff order');
    assert(persona.email.endsWith('@example.com') && /^555-01\d\d$/.test(persona.phone), 'application fixtures must be synthetic');
    for (const exported of [getLocalApplicationHandoff, submitLocalApplicationHandoff, localApplicationStatus, discoverLocalApplicationJobs]) {
      assert(typeof exported === 'function', 'the application adapter must use a frozen app export rather than a copied implementation');
    }
  },
}];
