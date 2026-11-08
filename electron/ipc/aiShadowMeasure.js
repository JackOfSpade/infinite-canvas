// Opt-in shadow measurement: re-asks a real worker or Q&A prompt on DeepSeek
// after Claude has answered, and records whether the shadow answer would have
// been accepted. Off unless INFINITE_CANVAS_SHADOW_OFFLOAD and an absolute
// INFINITE_CANVAS_SHADOW_DIR are both set. It never blocks or fails the real call.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { offloadTextCall } from './offloadTextCall.js';

const ROUTES = Object.freeze({ flash: 'deepseek-flash', pro: 'deepseek-pro' });
const LEVELS = Object.freeze(['off', 'low', 'medium', 'high', 'max']);
const CONCURRENCY = 2;

/** The valid `<flash|pro>:<level>` entries of INFINITE_CANVAS_SHADOW_OFFLOAD. */
export function parseShadowConfigs(value) {
  if (typeof value !== 'string') return [];
  const configs = [];
  for (const part of value.split(',')) {
    const [model, level, ...rest] = part.trim().split(':');
    if (rest.length || !Object.hasOwn(ROUTES, model) || !LEVELS.includes(level)) continue;
    if (!configs.some(item => item.route === ROUTES[model] && item.reasoning === level)) configs.push({ route: ROUTES[model], reasoning: level });
  }
  return configs;
}

export function createShadowMeasure({ env = process.env, offloadCall = offloadTextCall, now = () => Date.now(), fsImpl = fs } = {}) {
  const configs = parseShadowConfigs(env?.INFINITE_CANVAS_SHADOW_OFFLOAD);
  const dir = env?.INFINITE_CANVAS_SHADOW_DIR;
  const enabled = configs.length > 0 && typeof dir === 'string' && path.isAbsolute(dir);
  if (!enabled) return Object.freeze({ enabled: false, measure() {} });
  const repsRaw = Number.parseInt(env.INFINITE_CANVAS_SHADOW_REPS, 10);
  const reps = Number.isInteger(repsRaw) && repsRaw >= 1 && repsRaw <= 5 ? repsRaw : 1;
  const withTexts = env.INFINITE_CANVAS_SHADOW_TEXTS === '1';
  const files = fsImpl.promises || fsImpl;
  let active = 0;
  const waiting = [];

  async function slot(fn) {
    if (active >= CONCURRENCY) await new Promise(resolve => waiting.push(resolve));
    active += 1;
    try { return await fn(); } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function runOne(job, config, rep, sampleId) {
    const started = now();
    const row = {
      at: new Date(started).toISOString(), kind: job.kind, id: job.id, sampleId,
      route: config.route, reasoning: config.reasoning, rep, ok: false, valid: false, code: null,
      costUsd: null, latencyMs: null, usage: null, model: null, claude: job.claude ?? null,
    };
    let text = null;
    try {
      const reply = await offloadCall({ messages: job.messages, route: config.route, reasoning: config.reasoning,
        tag: `shadow-${job.id}`, caller: 'infinite-canvas-shadow' });
      text = typeof reply?.text === 'string' ? reply.text : '';
      row.ok = true;
      row.costUsd = typeof reply.costUsd === 'number' ? reply.costUsd : null;
      row.latencyMs = Number.isFinite(reply.durationMs) ? reply.durationMs : null;
      row.usage = reply.usage ?? null;
      row.model = reply.model ?? null;
      let verdict;
      try { verdict = job.validate ? await job.validate(text) : { valid: true, code: null }; } catch { verdict = { valid: false, code: 'VALIDATOR_THREW' }; }
      row.valid = verdict?.valid === true;
      row.code = verdict?.code ?? null;
    } catch (error) {
      row.code = typeof error?.code === 'string' ? error.code : 'OFFLOAD_ERROR';
      row.latencyMs = Number.isFinite(error?.detail?.latencyMs) ? error.detail.latencyMs : null;
    }
    await files.appendFile(path.join(dir, 'shadow.jsonl'), `${JSON.stringify(row)}\n`, { mode: 0o600 });
    try { await files.chmod(path.join(dir, 'shadow.jsonl'), 0o600); } catch { /* best effort */ }
    return text === null ? null : { route: config.route, reasoning: config.reasoning, rep, text };
  }

  async function run(job) {
    await files.mkdir(dir, { recursive: true, mode: 0o700 });
    try { await files.chmod(dir, 0o700); } catch { /* best effort */ }
    const sampleId = crypto.randomBytes(8).toString('hex');
    const tasks = [];
    for (const config of configs) for (let rep = 1; rep <= reps; rep += 1) {
      tasks.push(slot(() => runOne(job, config, rep, sampleId)).catch(() => null));
    }
    const shadow = (await Promise.all(tasks)).filter(Boolean);
    if (withTexts && shadow.length) {
      const textsDir = path.join(dir, 'texts');
      await files.mkdir(textsDir, { recursive: true, mode: 0o700 });
      await files.writeFile(path.join(textsDir, `${sampleId}.json`),
        JSON.stringify({ kind: job.kind, id: job.id, messages: job.messages, claudeText: typeof job.texts === 'string' ? job.texts : (job.texts?.claudeText ?? job.texts?.claude ?? null), shadow }),
        { mode: 0o600 });
      try { await files.chmod(path.join(textsDir, `${sampleId}.json`), 0o600); } catch { /* best effort */ }
    }
  }

  return Object.freeze({
    enabled: true,
    // Fire and forget: never awaited by the caller and never throws.
    measure(job) {
      try {
        if (!job || !Array.isArray(job.messages)) return;
        void run(job).catch(() => {});
      } catch { /* shadow measurement must not touch the real call */ }
    },
  });
}
