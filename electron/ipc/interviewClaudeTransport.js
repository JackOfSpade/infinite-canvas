/**
 * Claude CLI transport for Interview Helper preparation.
 *
 * Exposes `callText` / `callRaw` with the signatures interviewPreparation.js
 * already injects, so the research → brief → answer-bank pipeline runs on the
 * same headless Claude Code runner and stage model profiles as application
 * bundle generation (careerWritingCore.js). Each call is one Claude session;
 * a reply the caller's validator rejects is retried in that same session with
 * the rejection text, like the application correction rounds.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { claudeChildEnv, resolveClaudeBinary, runClaudeStage } from './claudeApplicationRunner.js';
import { careerWritingStageProfile } from './careerWritingCore.js';

// Research is the only stage allowed tools, and only these read-only web tools.
export const INTERVIEW_RESEARCH_TOOLS = 'WebSearch,WebFetch';
export const INTERVIEW_CLAUDE_MAX_ATTEMPTS = 3;
const MAX_REJECTION_CHARS = 6000;

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

export function createInterviewClaudeTransport({
  runStage = runClaudeStage,
  resolveBinary = () => resolveClaudeBinary({ env: process.env, homedir: os.homedir() }),
  env = process.env,
  cwd = os.tmpdir(),
  maxAttempts = INTERVIEW_CLAUDE_MAX_ATTEMPTS,
  onStage = () => {},
} = {}) {
  let bound = null;
  const binding = () => {
    if (!bound) {
      const binary = resolveBinary();
      bound = { binary, env: claudeChildEnv(env, path.dirname(binary)), cwd };
    }
    return bound;
  };

  async function call(prompt, opts = {}, { json }) {
    const { signal, task, responseSchema, responseValidator, claudeStage } = opts;
    const stage = interviewClaudeStage(task, claudeStage);
    const profile = careerWritingStageProfile(stage);
    const tools = stage === 'qa-research' ? INTERVIEW_RESEARCH_TOOLS : '';
    const sessionId = crypto.randomUUID();
    let text = `${prompt}${json ? schemaInstruction(responseSchema) : ''}`;
    let lastError = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const started = Date.now();
      const reply = await runStage({ ...binding(), text, signal, model: profile.model, effort: profile.effort, sessionId, resume: attempt > 0, tools });
      onStage({ task, stage, attempt, model: reply?.model, durationMs: Date.now() - started });
      try {
        const value = json ? firstJsonObject(reply?.text) : String(reply?.text ?? '');
        if (typeof responseValidator === 'function') responseValidator(value);
        return value;
      } catch (error) {
        if (signal?.aborted) throw error;
        lastError = error;
        text = rejectionPrompt(error);
      }
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
  });
}
