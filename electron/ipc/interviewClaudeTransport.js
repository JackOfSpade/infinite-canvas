/**
 * Claude CLI transport for Interview Helper preparation.
 *
 * Exposes `callText` / `callRaw` with the signatures interviewPreparation.js
 * already injects, so the research → brief → answer-bank pipeline runs on the
 * same headless Claude Code runner and stage model profiles as application
 * bundle generation (careerWritingCore.js). Each call is one Claude session;
 * a reply the caller's validator rejects is retried in that same session with
 * the rejection text, like the application correction rounds.
 *
 * A stage with a `qa:<stage>` entry in AI_CALL_PROVIDERS is answered through
 * the offload CLI instead (stateless: the messages are resent each attempt).
 * Any OFFLOAD_* error, or a second rejected offload reply, moves the rest of
 * that call to a fresh Claude session. Research and fact-check stages never
 * route: tool use and truth checks stay on Claude.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { claudeChildEnv, resolveClaudeBinary, runClaudeStage } from './claudeApplicationRunner.js';
import { reportClaudeUsageLimit, trackClaudeCall, waitForClaudeRelease, waitForClaudeUsage } from './claudePause.js';
import { standaloneClaudeActivity } from './claudeTaskActivity.js';
import { careerWritingStageProfile } from './careerWritingCore.js';
import { routedCall } from './aiCallProviders.js';
import { recordAiReplaySample, recordAiUsage } from './aiReplaySamples.js';
import { createShadowMeasure } from './aiShadowMeasure.js';
import { handoffMessages, offloadTextCall } from './offloadTextCall.js';

// Research is the only stage allowed tools, and only these read-only web tools.
export const INTERVIEW_RESEARCH_TOOLS = 'WebSearch,WebFetch';
export const INTERVIEW_CLAUDE_MAX_ATTEMPTS = 3;
const MAX_REJECTION_CHARS = 6000;
const OFFLOAD_BLOCK_MS = 30 * 60_000;
const OFFLOAD_REJECTION_LIMIT = 2;
const SHADOW_STAGES = Object.freeze(['qa-brief', 'qa-write']);

// Credit exhaustion blocks Q&A offload for every call in this process.
let offloadBlockedUntil = 0;

/** Clears the Q&A offload credit block (used by tests). */
export function resetInterviewOffloadBlock() { offloadBlockedUntil = 0; }

/** Research and every truth-check stage stay on Claude even if a table entry exists. */
export function interviewStageMayOffload(stage) {
  return typeof stage === 'string' && stage !== 'qa-research' && stage !== 'qa-answer-entailment' && stage !== 'qa-card-repair' && !stage.startsWith('qa-fact-');
}

/** The Claude stage for an interview task. `stage` from the caller wins. */
export function interviewClaudeStage(task, explicitStage) {
  if (typeof explicitStage === 'string' && explicitStage) return explicitStage;
  if (task === 'interview-brief-research') return 'qa-research';
  if (task === 'interview-brief-assessment') return 'qa-brief';
  return 'qa-write';
}

/** The first complete top-level JSON object in a reply (string-aware brace scan). */
export function firstJsonObject(text) {
  const source = String(text ?? '');
  const start = source.indexOf('{');
  if (start < 0) throw new Error('The reply contained no JSON object.');
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return JSON.parse(source.slice(start, index + 1));
  }
  throw new Error('The reply ended before its JSON object closed.');
}

function schemaInstruction(responseSchema) {
  return responseSchema
    ? `\n\nREPLY FORMAT: one JSON object that validates against this JSON Schema, and nothing else (no prose, no code fence):\n${JSON.stringify(responseSchema)}`
    : '';
}

function rejectionPrompt(error) {
  const message = String(error?.message || error || 'The reply was rejected.').slice(0, MAX_REJECTION_CHARS);
  return `YOUR PREVIOUS REPLY WAS REJECTED BY THE APP. The app's checks returned the text below verbatim. Reply again with the complete corrected answer in the same format as before; change only what the text names.\n${message}`;
}

function stepLabel(task) {
  const words = String(task || 'Claude call').replace(/^interview-/u, '').replace(/-/gu, ' ');
  return `${words[0].toUpperCase()}${words.slice(1)}`;
}

const isOffloadError = error => typeof error?.code === 'string' && error.code.startsWith('OFFLOAD_');

export function createInterviewClaudeTransport({
  runStage = runClaudeStage,
  resolveBinary = () => resolveClaudeBinary({ env: process.env, homedir: os.homedir() }),
  env = process.env,
  cwd = os.tmpdir(),
  maxAttempts = INTERVIEW_CLAUDE_MAX_ATTEMPTS,
  onStage = () => {},
  routeFor = stage => routedCall(`qa:${stage}`),
  offloadCall = offloadTextCall,
  shadow = createShadowMeasure(),
  now = () => Date.now(),
  // Every Claude attempt is recorded for offline re-measurement; tests inject
  // recorders so a sample's contents can be inspected without touching disk.
  recordSample = recordAiReplaySample,
  recordUsage = recordAiUsage,
} = {}) {
  let bound = null;
  const binding = () => {
    if (!bound) {
      const binary = resolveBinary();
      bound = { binary, env: claudeChildEnv(env, path.dirname(binary)), cwd };
    }
    return bound;
  };

  async function call(prompt, opts = {}, { json, scope = null }) {
    const { signal, task, responseSchema, responseValidator, claudeStage } = opts;
    const stage = interviewClaudeStage(task, claudeStage);
    const profile = careerWritingStageProfile(stage);
    const tools = stage === 'qa-research' ? INTERVIEW_RESEARCH_TOOLS : '';
    // Ultracode is off by default: only an explicit opt-in (call or stage profile) is forwarded.
    const ultracode = opts.ultracode === true || (opts.ultracode !== false && profile.ultracode === true);
    let sessionId = crypto.randomUUID();
    const originalText = `${prompt}${json ? schemaInstruction(responseSchema) : ''}`;
    // The text the next Claude attempt sends; a resumed session gets only the rejection.
    let text = originalText;
    let lastError = null;
    let lastRejection = null;
    let claudeStarted = false;
    const route = interviewStageMayOffload(stage) && !tools ? routeFor(stage) : null;
    let mode = route && now() >= offloadBlockedUntil ? 'offload' : 'claude';
    const messages = handoffMessages({ text: originalText });
    let offloadRejections = 0;
    const toFreshClaude = () => {
      mode = 'claude';
      sessionId = crypto.randomUUID();
      claudeStarted = false;
      text = lastRejection ? `${originalText}\n\n${lastRejection}` : originalText;
    };
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const started = Date.now();
      let reply = null;
      let provider = 'claude';
      if (mode === 'offload') {
        if (scope) {
          standaloneClaudeActivity.begin(scope.key, { nodeId: scope.nodeId, model: route.route, effort: route.reasoning, countRound: false });
          standaloneClaudeActivity.note(scope.key, attempt > 0 ? `${stepLabel(task)}, corrected reply` : stepLabel(task));
        }
        try {
          reply = await offloadCall({ messages, route: route.route, reasoning: route.reasoning, tag: stage, signal });
          provider = 'offload';
        } catch (error) {
          if (!isOffloadError(error)) throw error;
          if (error.code === 'OFFLOAD_CREDIT_EXHAUSTED') offloadBlockedUntil = now() + OFFLOAD_BLOCK_MS;
          toFreshClaude();
        }
      }
      if (!reply) {
        if (scope) {
          await waitForClaudeUsage(signal);
          await waitForClaudeRelease(scope.key, signal);
          standaloneClaudeActivity.begin(scope.key, { nodeId: scope.nodeId, model: profile.model, effort: profile.effort, countRound: false });
          standaloneClaudeActivity.note(scope.key, attempt > 0 ? `${stepLabel(task)}, corrected reply` : stepLabel(task));
        }
        const callEnded = scope ? trackClaudeCall(scope.key) : () => {};
        try {
          reply = await runStage({ ...binding(), text, signal, model: profile.model, effort: profile.effort, sessionId, resume: claudeStarted, tools,
            ...(ultracode ? { ultracode: true } : {}),
            ...(scope ? { onActivity: event => standaloneClaudeActivity.event(scope.key, event) } : {}) });
        } catch (error) {
          if (!scope || error?.code !== 'CLAUDE_USAGE_LIMIT' || signal?.aborted) throw error;
          // Earlier stages are saved; this one waits for the reset and asks again.
          reportClaudeUsageLimit({ resetsAt: standaloneClaudeActivity.view(scope.key)?.rateLimitResetsAt ?? null });
          standaloneClaudeActivity.note(scope.key, 'Claude usage limit reached');
          standaloneClaudeActivity.released(scope.key);
          if (!claudeStarted) sessionId = crypto.randomUUID();
          attempt -= 1;
          continue;
        } finally { callEnded(); }
        claudeStarted = true;
      }
      if (scope) standaloneClaudeActivity.checking(scope.key);
      onStage({ task, stage, attempt, model: reply?.model, durationMs: Date.now() - started, provider,
        ...(provider === 'offload' ? { route: route.route } : {}) });
      let value;
      let failure = null;
      try {
        value = json ? firstJsonObject(reply?.text) : String(reply?.text ?? '');
        if (typeof responseValidator === 'function') responseValidator(value);
      } catch (error) { failure = error; }
      if (provider === 'claude') {
        // The exact text this attempt sent and how the app judged the reply,
        // kept so a future model can answer it again offline. Recording may
        // never change or fail a call.
        const at = new Date(now()).toISOString();
        const durationMs = Date.now() - started;
        try {
          recordSample({
            at,
            task,
            stage,
            attempt,
            text,
            systemAppend: '',
            model: reply?.model ?? null,
            requestedModel: profile.model ?? null,
            effort: profile.effort ?? null,
            tools: tools || null,
            costUsd: reply?.costUsd ?? null,
            usage: reply?.usage ?? null,
            durationMs,
            answer: String(reply?.text ?? ''),
            outcome: failure ? 'rejected' : 'accepted',
            validationCode: failure ? (failure.code || 'invalid') : null,
          });
        } catch { /* recording cannot change or fail the call */ }
        try {
          recordUsage({
            at,
            task,
            stage,
            model: reply?.model ?? null,
            effort: profile.effort ?? null,
            usage: reply?.usage ?? null,
            costUsd: reply?.costUsd ?? null,
            provider: 'claude',
          });
        } catch { /* usage reporting cannot change or fail the call */ }
      }
      if (attempt === 0 && provider === 'claude' && shadow.enabled && SHADOW_STAGES.includes(stage)) {
        try {
          shadow.measure({
            kind: 'qa', id: stage, messages: handoffMessages({ text: originalText }),
            validate: (shadowText) => {
              try {
                const shadowValue = json ? firstJsonObject(shadowText) : String(shadowText ?? '');
                if (typeof responseValidator === 'function') responseValidator(shadowValue);
                return { valid: true, code: null };
              } catch (error) { return { valid: false, code: error?.code || 'invalid' }; }
            },
            claude: { model: reply?.model ?? null, effort: profile.effort, costUsd: reply?.costUsd ?? null, durationMs: Date.now() - started,
              outcome: failure ? 'rejected' : 'accepted', validationCode: failure ? (failure.code || 'invalid') : null },
            texts: { claude: String(reply?.text ?? '') },
          });
        } catch { /* shadow measurement never affects the real call */ }
      }
      if (!failure) return value;
      if (signal?.aborted) throw failure;
      lastError = failure;
      lastRejection = rejectionPrompt(failure);
      if (provider === 'offload') {
        // The CLI is stateless: the next turn replays the conversation.
        messages.push({ role: 'assistant', content: String(reply.text ?? '') }, { role: 'user', content: lastRejection });
        offloadRejections += 1;
        if (offloadRejections >= OFFLOAD_REJECTION_LIMIT) toFreshClaude();
      } else text = lastRejection;
    }
    // Every attempt was a reply rejection (unparseable or invalid), not a
    // transport failure: callers treat it like any exhausted validation.
    const exhausted = lastError || new Error('Claude did not return an acceptable reply.');
    if (exhausted && typeof exhausted === 'object' && !exhausted.code) exhausted.code = 'VALIDATION_FAILED';
    throw exhausted;
  }

  return Object.freeze({
    callText: (prompt, opts) => call(prompt, opts, { json: true }),
    callRaw: (prompt, opts) => call(prompt, opts, { json: !!opts?.responseSchema }),
    // The same calls, reporting their live steps under one panel's key.
    withActivity: (key, nodeId = null) => ({
      callText: (prompt, opts) => call(prompt, opts, { json: true, scope: { key, nodeId } }),
      callRaw: (prompt, opts) => call(prompt, opts, { json: !!opts?.responseSchema, scope: { key, nodeId } }),
    }),
  });
}
