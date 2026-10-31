// Offline synthetic measurements only. Run with the repository's Electron stub:
// node --import ./scripts/test-stubs/register.mjs scripts/interview-helper-benchmark.mjs
// This script never opens the app, contacts a model or reads private app data.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { buildInterviewBrief } from '../electron/ipc/interviewPreparation.js';
import { materializeNonApiPrompt } from '../electron/ipc/nonApiAi.js';
import { projectInterviewDisplay } from '../electron/interviewWindow.js';
import { buildInterviewPlan, buildInterviewFollowUpPlan } from '../src/utils/interviewHelper.js';

const snapshotId = 'a'.repeat(64);
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function preparedBrief() {
  const semantic = {
    version: 1,
    inputs: { careerSnapshotId: snapshotId, jobUrlSha256: sha256('https://jobs.example.test/1'), applicationArtifactId: 'e'.repeat(64), applicationArtifactDigest: 'd'.repeat(64) },
    role: { title: 'Product Manager', company: 'Acme', location: 'Toronto', summary: 'Own onboarding.' },
    roleThemes: ['Product strategy'], companyFacts: [], recentContext: [],
    likelyQuestions: ['Tell me about improving onboarding conversion.'],
    questionsToAsk: ['What is success?'],
    applicationPositioning: [{ documentKind: 'resume', point: 'Improved onboarding conversion.' }],
    warnings: ['Synthetic benchmark data.'],
  };
  return { ...semantic, briefId: sha256(stableJson(semantic)), createdAt: '2026-10-30T00:00:00.000Z', sources: [] };
}
function measure(operation) {
  for (let index = 0; index < 10; index += 1) operation();
  const times = [];
  for (let index = 0; index < 100; index += 1) {
    const start = performance.now();
    operation();
    times.push(performance.now() - start);
  }
  times.sort((left, right) => left - right);
  return { p50Ms: times[50], p95Ms: times[95], maxMs: times.at(-1) };
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'interview-helper-benchmark-'));
try {
  const promptSizes = [];
  for (const [listingSize, resumeSize, researchSize] of [[46, 73, 73], [8000, 10000, 8000]]) {
    const bundle = {
      job: { title: 'Product Manager', company: 'Acme', location: 'Toronto' },
      listingText: 'Acme seeks a product leader. '.repeat(Math.ceil(listingSize / 28)).slice(0, listingSize),
      applicationPositioning: {
        resume: 'Candidate led delivery. '.repeat(Math.ceil(resumeSize / 24)).slice(0, resumeSize),
        coverLetter: 'Build reliable systems.',
      },
      digests: { applicationHtmlSha256: 'a'.repeat(64) },
    };
    const prompts = [];
    const stopAfterCapture = new Error('Synthetic prompt capture complete.');
    try {
      await buildInterviewBrief({
        nodeId: 'node-1', snapshotId, canonicalJobUrl: 'https://jobs.example.test/1',
        bundleArtifactId: 'e'.repeat(64), manualAiRunId: 'run-1', userDataPath: root,
        loadBundle: async () => bundle,
        callRaw: async (prompt, opts) => {
          prompts.push({ prompt, opts });
          return 'Acme serves teams. '.repeat(Math.ceil(researchSize / 19)).slice(0, researchSize);
        },
        callText: async (prompt, opts) => { prompts.push({ prompt, opts }); throw stopAfterCapture; },
      });
    } catch (error) {
      if (error !== stopAfterCapture) throw error;
    }
    promptSizes.push({
      input: { listingSize, resumeSize, researchSize },
      prompts: prompts.map(({ prompt, opts }) => {
        const full = materializeNonApiPrompt({ prompt, ...opts,
          requestKind: opts.responseSchema ? 'structured-text' : 'raw-text',
          maxOutputTokens: opts.responseSchema ? 4096 : 6144, handoffCode: 'IH01' });
        return { task: opts.task, baseChars: prompt.length, baseTokens: Math.ceil(prompt.length / 4),
          materializedChars: full.length, materializedTokens: Math.ceil(full.length / 4) };
      }),
    });
  }
  const brief = preparedBrief();
  const live = [];
  for (const count of [10, 100, 1000]) {
    const profile = { snapshotId, profile: {
      roles: [{ id: 'r1', title: 'Product Manager', employer: 'Acme' }],
      achievements: Array.from({ length: count }, (_, index) => ({ id: `a${index}`, roleId: 'r1',
        claim: `Improved onboarding conversion through a simpler setup flow for product ${index}.`,
        evidenceSegmentIds: ['segment-0001'] })),
      projects: [], skills: [], education: [], certifications: [], otherEvidence: [],
    } };
    const question = 'Tell me about improving onboarding conversion.';
    const anchorPlan = buildInterviewPlan({ question, profile, snapshotId });
    const followUp = () => buildInterviewFollowUpPlan({ question: 'What did you learn?', anchorPlan });
    live.push({ count, profileChars: JSON.stringify(profile).length,
      retrieval: measure(() => buildInterviewPlan({ question, profile, snapshotId })),
      followUp: measure(followUp),
      retrievalAndProjection: measure(() => projectInterviewDisplay({ brief,
        plan: buildInterviewPlan({ question, profile, snapshotId }), snapshotId, currentStep: 0 })),
      followUpAndProjection: measure(() => projectInterviewDisplay({ brief,
        plan: followUp(), snapshotId, currentStep: 0 })),
      followUpWithAnchorRebuildAndProjection: measure(() => {
        const canonical = buildInterviewPlan({ question, profile, snapshotId });
        if (stableJson(canonical) !== stableJson(anchorPlan)) throw new Error('Synthetic anchor changed.');
        return projectInterviewDisplay({ brief,
          plan: buildInterviewFollowUpPlan({ question: 'What did you learn?', anchorPlan: canonical }),
          snapshotId, currentStep: 0 });
      }),
    });
  }
  console.log(JSON.stringify({ syntheticOnly: true, warmupCalls: 10, measuredCalls: 100,
    liveAiRoundTrips: 0, livePromptTokens: 0,
    excludes: ['snapshot read and validation', 'Electron IPC and event-loop scheduling', 'React render and paint'],
    promptSizes, live }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
