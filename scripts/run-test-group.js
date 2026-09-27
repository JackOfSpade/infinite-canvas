// Optional local loop for one registered group. It installs the same no-network
// guard as the normal runner because register.mjs intentionally keys on argv[1].
import { blockUnexpectedNetworkRequest } from './test-stubs/networkGuard.mjs';
const stem = process.argv[2];
if (!stem || !/^[a-z0-9-]+$/.test(stem)) throw new Error('usage: run-test-group.js <group-file-stem>');
globalThis.fetch = async input => blockUnexpectedNetworkRequest(input);
const group = (await import(`./tests/${stem}.js`)).default;
if (!Array.isArray(group)) throw new Error(`${stem} must default-export tests`);
let failed = 0;
for (const test of group) {
  try { await test.run(); console.log(`PASS ${test.name}`); }
  catch (error) { failed++; console.error(`FAIL ${test.name}:`, error.stack || error.message); }
}
if (failed) process.exitCode = 1;
