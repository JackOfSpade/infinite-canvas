import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  buildCareerProfileCompilePrompt,
  buildCareerSourceCorpus,
  careerSnapshotId,
  validateCareerProfile,
  verbatimCareerTranscriptionAuditReceipt,
} from '../../electron/ipc/careerSnapshot.js';

const artifactDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = '/Users/jack/Desktop/Job Search/Work Experience.md';
const candidatePath = path.join(artifactDirectory, 'candidate-profile.json');
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const sourceText = fs.readFileSync(sourcePath, 'utf8');
const profile = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
const sourceHash = sha256(sourceText);
const corpus = buildCareerSourceCorpus([{
  name: 'Work Experience.md',
  text: sourceText,
  contentHash: sourceHash,
  transcriptionAudit: verbatimCareerTranscriptionAuditReceipt(),
}]);
const validation = validateCareerProfile(profile, corpus);
const prompt = buildCareerProfileCompilePrompt(corpus);
const coveredSegmentIds = new Set(profile.segmentCoverage.map(entry => entry.segmentId));
if (process.argv.includes('--corpus')) {
  console.log(JSON.stringify(corpus, null, 2));
  process.exit(0);
}
if (process.argv.includes('--compiler-prompt')) {
  console.log(prompt);
  process.exit(0);
}
const report = {
  artifactKind: 'production-career-profile-candidate-validation',
  sourcePath,
  sourceSha256: sourceHash,
  sourceCharacterCount: sourceText.length,
  inputFingerprint: corpus.inputFingerprint,
  sourceFingerprint: corpus.sourceFingerprint,
  snapshotId: careerSnapshotId(corpus),
  compilationContract: CAREER_SNAPSHOT_COMPILATION_CONTRACT,
  segmentCount: corpus.segments.length,
  coveredSegmentCount: coveredSegmentIds.size,
  compilerPromptSha256: sha256(prompt),
  compilerPromptCharacterCount: prompt.length,
  candidateCounts: {
    roles: profile.roles.length,
    achievements: profile.achievements.length,
    projects: profile.projects.length,
    skills: profile.skills.length,
    education: profile.education.length,
    certifications: profile.certifications.length,
    otherEvidence: profile.otherEvidence.length,
    segmentCoverage: profile.segmentCoverage.length,
  },
  validator: validation,
};
console.log(JSON.stringify(report, null, 2));
if (!validation.valid) process.exitCode = 1;
