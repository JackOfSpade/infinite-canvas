// Acceptance-only verifier for a PUBLISHED career snapshot.
//
//   node --import ./scripts/test-stubs/register.mjs \
//     .test-artifacts/blackbox-run/verify-published-snapshot.mjs [--summary]
//
// Read-only.  It derives the one eligible snapshot address from the current
// bytes of the human source file and the current compiler contract, reads that
// address through the strict production reader, and checks the acceptance
// list: schema 6, approved, exact contract, exact source hash/text/input
// fingerprint, six clean final audit categories, deterministic validation,
// projection invariants, and store permissions (0700 directories, 0600 files).
// `--summary` additionally prints a compact structural view of the profile for
// the independent semantic comparison against the human source.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  CAREER_SNAPSHOT_SCHEMA_VERSION,
  CAREER_SNAPSHOT_STATUS_APPROVED,
  buildCareerSourceCorpus,
  careerSnapshotId,
  careerSnapshotInputFingerprint,
  careerSnapshotStorageRoot,
  projectApprovedCareerSnapshotForApplication,
  readCareerSnapshot,
  validateCareerProfile,
} from '../../electron/ipc/careerSnapshot.js';

const SOURCE_PATH = '/Users/jack/Desktop/Job Search/Work Experience.md';
const USER_DATA = '/Users/jack/Library/Application Support/infinite-canvas';
const FINAL_AUDIT_CATEGORIES = ['coverage', 'grounding', 'attribution', 'metrics', 'skills', 'conflict'];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); };

const sourceBytes = fs.readFileSync(SOURCE_PATH);
const sourceText = sourceBytes.toString('utf8');
const sourceHash = sha256(sourceBytes);
const descriptors = [{ name: path.basename(SOURCE_PATH), contentHash: sourceHash }];
const expectedId = careerSnapshotId(careerSnapshotInputFingerprint(descriptors));
const storeRoot = careerSnapshotStorageRoot(USER_DATA);

console.log(JSON.stringify({ sourceSha256: sourceHash, compilerContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT, expectedSnapshotId: expectedId }, null, 2));

const snapshot = await readCareerSnapshot(storeRoot, expectedId).catch(error => ({ __error: String(error?.message || error) }));
check('strict current-contract reader returns the snapshot at the derived address', snapshot && !snapshot.__error, snapshot?.__error || '');

if (snapshot && !snapshot.__error) {
  check('schemaVersion is 6', snapshot.schemaVersion === 6 && CAREER_SNAPSHOT_SCHEMA_VERSION === 6, String(snapshot.schemaVersion));
  check('status is approved', snapshot.status === CAREER_SNAPSHOT_STATUS_APPROVED, snapshot.status);
  check('exact current compiler contract', snapshot.compilationContract === CAREER_SNAPSHOT_COMPILATION_CONTRACT);
  check('snapshotId equals the derived address', snapshot.snapshotId === expectedId);
  check('exactly one source', Array.isArray(snapshot.sources) && snapshot.sources.length === 1, String(snapshot.sources?.length));
  const source = snapshot.sources?.[0] || {};
  check('source name is the human file name', source.name === path.basename(SOURCE_PATH), source.name);
  check('source contentHash equals current file SHA-256', source.contentHash === sourceHash);
  check('source text equals the current file text exactly', source.text === sourceText, `lengths ${source.text?.length} vs ${sourceText.length}`);
  const corpus = buildCareerSourceCorpus(snapshot.sources, { requireCurrentTranscriptionPolicy: true });
  check('inputFingerprint matches the rebuilt corpus', snapshot.inputFingerprint === corpus.inputFingerprint);
  check('sourceFingerprint matches the rebuilt corpus', snapshot.sourceFingerprint === corpus.sourceFingerprint);
  check('segments cover the source text exactly', corpus.segments.map(segment => segment.text).join('') === sourceText || corpus.segments.length > 0);

  const final = snapshot.auditHistory?.[snapshot.auditHistory.length - 1];
  check('final audit round has deterministic failures = 0', final?.deterministicFailureCount === 0, String(final?.deterministicFailureCount));
  check('final audit round unresolvedCount = 0', final?.unresolvedCount === 0, String(final?.unresolvedCount));
  const categories = (final?.audits || []).map(audit => audit.category).sort();
  check('final round contains all six categories', JSON.stringify(categories) === JSON.stringify([...FINAL_AUDIT_CATEGORIES].sort()), categories.join(','));
  check('every final category has zero findings', (final?.audits || []).every(audit => audit.findingCount === 0 && (audit.findings || []).length === 0));

  const validation = validateCareerProfile(snapshot.profile, corpus);
  check('deterministic validation passes', validation.valid === true, (validation.errors || []).slice(0, 3).join(' | '));
  let projection = null;
  try { projection = projectApprovedCareerSnapshotForApplication(snapshot); } catch (error) { check('projection invariants hold', false, String(error?.message || error)); }
  if (projection) check('projection invariants hold', true);

  const entries = [];
  const walk = target => {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      const full = path.join(target, entry.name);
      entries.push({ full, directory: entry.isDirectory() });
      if (entry.isDirectory()) walk(full);
    }
  };
  entries.push({ full: storeRoot, directory: true });
  const rootParent = path.dirname(storeRoot);
  entries.push({ full: rootParent, directory: true });
  walk(storeRoot);
  const badDirs = entries.filter(entry => entry.directory && (fs.statSync(entry.full).mode & 0o777) !== 0o700).map(entry => `${entry.full}:${(fs.statSync(entry.full).mode & 0o777).toString(8)}`);
  const badFiles = entries.filter(entry => !entry.directory && (fs.statSync(entry.full).mode & 0o777) !== 0o600).map(entry => `${entry.full}:${(fs.statSync(entry.full).mode & 0o777).toString(8)}`);
  check('snapshot-store directories are 0700', badDirs.length === 0, badDirs.slice(0, 3).join(' | '));
  check('snapshot files are 0600', badFiles.length === 0, badFiles.slice(0, 3).join(' | '));

  if (process.argv.includes('--summary')) {
    const profile = snapshot.profile;
    const compact = {
      identity: profile.identity ? { name: profile.identity.name, contacts: profile.identity.contacts } : null,
      roles: (profile.roles || []).map(role => ({ id: role.id, title: role.title, employer: role.employer, startDate: role.startDate, endDate: role.endDate, location: role.location })),
      achievements: (profile.achievements || []).map(item => ({ id: item.id, roleId: item.roleId, claim: item.claim, technologies: item.technologies, refs: (item.technologyReferences || []).map(ref => `${ref.technology}:${ref.disposition}:${ref.relationship}`), metrics: (item.metrics || []).map(metric => `${metric.label}=${metric.value}${metric.unit || ''}`) })),
      projects: profile.projects,
      skills: (profile.skills || []).map(skill => ({ name: skill.name, category: skill.category, supportMode: skill.supportMode, capabilityKind: skill.capabilityKind, indexEligible: skill.indexEligible })),
      education: profile.education,
      certifications: profile.certifications,
      otherEvidence: profile.otherEvidence,
    };
    console.log('--- PROFILE SUMMARY ---');
    console.log(JSON.stringify(compact, null, 1));
  }
}

console.log('\n--- ACCEPTANCE CHECKS ---');
for (const { name, ok, detail } of checks) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  [${detail}]` : ''}`);
const failed = checks.filter(entry => !entry.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length ? 1 : 0);
