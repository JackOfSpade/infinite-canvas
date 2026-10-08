import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAREER_PROFILE_AUDIT_SCHEMA,
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  CAREER_SNAPSHOT_SCHEMA_VERSION,
  CAREER_SNAPSHOT_STATUS_APPROVED,
  buildCareerSourceCorpus,
  careerSnapshotId,
  readCareerSnapshot,
  validateCareerProfile,
  verbatimCareerTranscriptionAuditReceipt,
  writeCareerSnapshotAtomically,
} from '../../electron/ipc/careerSnapshot.js';
import { validateResponseSchema } from '../../electron/ipc/schemaValidation.js';

const artifactDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = '/Users/jack/Desktop/Job Search/Work Experience.md';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const canonicalJson = value => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(artifactDirectory, name), 'utf8'));
}

function validateAuditReceipts(receipts) {
  const expected = ['coverage', 'grounding', 'attribution', 'metrics', 'skills', 'conflict'];
  const errors = [];
  if (!Array.isArray(receipts) || receipts.length !== expected.length) {
    errors.push('Expected exactly six audit receipts.');
    return { valid: false, errors };
  }
  const received = new Set();
  for (const receipt of receipts) {
    for (const error of validateResponseSchema({ findings: receipt?.findings }, CAREER_PROFILE_AUDIT_SCHEMA)) {
      errors.push(`${String(receipt?.category || 'unknown')} audit schema ${error.path} ${error.message}.`);
    }
    if (!expected.includes(receipt?.category)) errors.push(`Unknown audit category ${String(receipt?.category)}.`);
    if (received.has(receipt?.category)) errors.push(`Duplicate audit category ${String(receipt?.category)}.`);
    received.add(receipt?.category);
    for (const finding of receipt?.findings || []) {
      if (finding.category !== receipt.category) errors.push(`${receipt.category} audit finding ${finding.id} has category ${finding.category}.`);
    }
  }
  for (const category of expected) if (!received.has(category)) errors.push(`Missing audit category ${category}.`);
  return { valid: errors.length === 0, errors };
}

function buildInputs() {
  const sourceText = fs.readFileSync(sourcePath, 'utf8');
  const profile = readJson('candidate-profile.json');
  const factsReceipts = readJson('audit-facts.json');
  const coverageReceipts = readJson('audit-coverage.json');
  const auditReceipts = [...factsReceipts, ...coverageReceipts];
  const auditValidation = validateAuditReceipts(auditReceipts);
  if (!auditValidation.valid) throw new Error(auditValidation.errors.join(' '));
  const corpus = buildCareerSourceCorpus([{
    name: 'Work Experience.md',
    text: sourceText,
    contentHash: sha256(sourceText),
    transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
  }]);
  const profileValidation = validateCareerProfile(profile, corpus);
  if (!profileValidation.valid) throw new Error(profileValidation.errors.join(' '));
  const order = ['coverage', 'grounding', 'attribution', 'metrics', 'skills', 'conflict'];
  const byCategory = new Map(auditReceipts.map(receipt => [receipt.category, receipt.findings]));
  const audits = order.map(category => {
    const findings = byCategory.get(category);
    return {
      category,
      task: `career-profile-audit-${category === 'conflict' ? 'conflicts' : category === 'coverage' ? 'completeness' : category}`,
      findingCount: findings.length,
      findingDigest: sha256(canonicalJson(findings)),
      findings,
    };
  });
  return { sourceText, profile, corpus, profileValidation, auditValidation, auditReceipts, audits };
}

function assembleSnapshot(inputs, approvedAt = new Date().toISOString()) {
  const snapshot = {
    schemaVersion: CAREER_SNAPSHOT_SCHEMA_VERSION,
    status: CAREER_SNAPSHOT_STATUS_APPROVED,
    snapshotId: careerSnapshotId(inputs.corpus),
    inputFingerprint: inputs.corpus.inputFingerprint,
    sourceFingerprint: inputs.corpus.sourceFingerprint,
    compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
    approvedAt,
    sources: inputs.corpus.sources,
    segments: inputs.corpus.segments,
    profile: inputs.profile,
    auditHistory: [{
      round: 0,
      deterministicFailureCount: 0,
      deterministicFailures: [],
      audits: inputs.audits,
      unresolvedCount: 0,
    }],
  };
  // Keep bytes and identity coupled: the output is what callers persist.
  return { snapshot, bytes: `${JSON.stringify(snapshot, null, 2)}\n` };
}

async function verifySnapshot(snapshot) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'career-snapshot-reader-'));
  try {
    const write = await writeCareerSnapshotAtomically(root, snapshot);
    const read = await readCareerSnapshot(root, snapshot.snapshotId);
    return {
      writerCreated: write.created,
      readerAccepted: Boolean(read),
      exactRoundTrip: canonicalJson(read) === canonicalJson(snapshot),
    };
  } finally {
    await fs.promises.rm(root, { recursive: true, force: true });
  }
}

if (process.argv.includes('--snapshot')) {
  const assembled = assembleSnapshot(buildInputs());
  // Hash the exact UTF-8 payload emitted below, after approvedAt is fixed.
  const snapshotSha256 = sha256(assembled.bytes);
  if (process.argv.includes('--print-assembly-hash')) process.stderr.write(snapshotSha256 + '\n');
  process.stdout.write(assembled.bytes);
  process.exit(0);
}
const fileIndex = process.argv.indexOf('--verify-file');
const snapshotPath = fileIndex >= 0
  ? process.argv[fileIndex + 1]
  : path.join(artifactDirectory, 'approved-snapshot.json');
const snapshotBytes = fs.readFileSync(snapshotPath, 'utf8');
const snapshot = JSON.parse(snapshotBytes);
const inputs = buildInputs();
const profileValidation = validateCareerProfile(snapshot.profile, {
  ...inputs.corpus,
  sources: snapshot.sources,
  segments: snapshot.segments,
});
const reader = await verifySnapshot(snapshot);
const snapshotSha256 = sha256(snapshotBytes);
const reportPath = path.join(artifactDirectory, 'final-approval-report.json');
const emitReport = process.argv.includes('--emit-report');
const existingReport = emitReport ? null : readJson('final-approval-report.json');
const reportedSnapshotSha256 = existingReport?.snapshotSha256;
const reportSnapshotSha256MatchesFile = emitReport ? true : reportedSnapshotSha256 === snapshotSha256;
const report = {
  artifactKind: 'production-approved-career-snapshot-validation',
  sourcePath,
  sourceSha256: sha256(fs.readFileSync(sourcePath, 'utf8')),
  artifactHashes: {
    candidateProfileSha256: sha256(fs.readFileSync(path.join(artifactDirectory, 'candidate-profile.json'), 'utf8')),
    auditFactsSha256: sha256(fs.readFileSync(path.join(artifactDirectory, 'audit-facts.json'), 'utf8')),
    auditCoverageSha256: sha256(fs.readFileSync(path.join(artifactDirectory, 'audit-coverage.json'), 'utf8')),
    snapshotSha256,
  },
  snapshotSha256,
  inputFingerprint: snapshot.inputFingerprint,
  sourceFingerprint: snapshot.sourceFingerprint,
  snapshotId: snapshot.snapshotId,
  compilationContract: snapshot.compilationContract,
  schemaVersion: snapshot.schemaVersion,
  status: snapshot.status,
  segmentCount: snapshot.segments.length,
  auditHistory: {
    rounds: snapshot.auditHistory.length,
    categories: snapshot.auditHistory[0].audits.map(audit => audit.category),
    findingCounts: Object.fromEntries(snapshot.auditHistory[0].audits.map(audit => [audit.category, audit.findingCount])),
  },
  auditReceiptValidation: inputs.auditValidation,
  profileValidation,
  reader,
  reportSnapshotSha256MatchesFile,
};
console.log(JSON.stringify(report, null, 2));
if (!profileValidation.valid || !inputs.auditValidation.valid || !reader.readerAccepted || !reader.exactRoundTrip
  || (!emitReport && !reportSnapshotSha256MatchesFile)) process.exitCode = 1;
