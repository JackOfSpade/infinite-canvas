import assert from 'node:assert/strict';
import { authorityDigest, createStoreAuthorityWorkflowRoot } from '../../electron/ipc/applicationAuthorityWorkflow.js';

export default [{
  name: 'v2 requirements root retains exact stream binding and digest semantics',
  run() {
    const requirements = { count: 2, digest: 'a'.repeat(64) };
    const catalog = { count: 3, digest: 'b'.repeat(64) };
    const args = { requirements, catalog, rolesDigest: 'roles', skillsDigest: 'skills' };
    const root = createStoreAuthorityWorkflowRoot(args);
    const { digest, ...unsigned } = root;
    assert.equal(root.kind, 'authority-store-workflow-root');
    assert.deepEqual(root.requirements, requirements);
    assert.deepEqual(root.catalog, catalog);
    assert.equal(root.requirementsStream, undefined);
    assert.equal(digest, authorityDigest(unsigned));
    const epoch = createStoreAuthorityWorkflowRoot({ ...args, requirementsStream: 'requirements-e1' });
    assert.equal(epoch.requirementsStream, 'requirements-e1');
    assert.notEqual(epoch.digest, root.digest);
    assert.throws(() => createStoreAuthorityWorkflowRoot({ ...args, catalog: { count: 0, digest: catalog.digest } }), /catalog stream receipt is invalid/);
    assert.throws(() => createStoreAuthorityWorkflowRoot({ ...args, requirementsStream: '../other' }), /requirementsStream is invalid/);
    return { rootDigest: root.digest, epochDigest: epoch.digest };
  },
}];
