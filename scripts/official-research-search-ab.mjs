#!/usr/bin/env node
// Side-by-side test of the official-posting research step with Claude's built-in web
// tools versus the Tavily MCP server. Both arms get the app's exact prompt, prompt
// preparation, model profile and validator; only the search/read tools differ.
// Scored against official postings the app already confirmed (answer key) and on
// jobs it found nothing for (leads to review by hand).
//
//   node --import ./scripts/test-stubs/register.mjs scripts/official-research-search-ab.mjs \
//     --canvas "<canvas.json>" --out <private dir> [--found 12] [--missed 6] [--seed 1] [--concurrency 3]
//
// The Tavily key is read from the macOS Keychain (service infinite-canvas-tavily-api-key)
// and never printed. Job details are written only to the private --out directory.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs as parseNodeArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const KEYCHAIN_SERVICE = 'infinite-canvas-tavily-api-key';
const TASK = 'job-official-posting-research';
const RESEARCH_MAX_TURNS = 16;
const TAVILY_TOOLS = ['mcp__tavily__tavily_search', 'mcp__tavily__tavily_extract'];
const ipc = rel => import(new URL(`../electron/ipc/${rel}`, import.meta.url).href);

function options(argv) {
  const { values } = parseNodeArgs({ args: argv, options: {
    canvas: { type: 'string' }, out: { type: 'string' }, found: { type: 'string', default: '12' },
    missed: { type: 'string', default: '6' }, seed: { type: 'string', default: '1' }, concurrency: { type: 'string', default: '3' },
    'dry-run': { type: 'boolean', default: false }, arms: { type: 'string', default: 'native,tavily' },
  } });
  if (!values.canvas || !values.out) throw new Error('--canvas and --out are required.');
  const int = (name, min) => { const n = Number(values[name]); if (!Number.isInteger(n) || n < min) throw new Error(`--${name} must be an integer >= ${min}`); return n; };
  return { canvas: values.canvas, out: path.resolve(values.out), found: int('found', 0), missed: int('missed', 0), seed: int('seed', 0), concurrency: int('concurrency', 1), dryRun: values['dry-run'] === true,
    arms: String(values.arms).split(',').map(arm => arm.trim()).filter(Boolean) };
}

function readTavilyKey() {
  try {
    const key = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!key) throw new Error('empty');
    return key;
  } catch {
    throw new Error(`No Tavily key in the Keychain. Run: security add-generic-password -s ${KEYCHAIN_SERVICE} -a tavily -w`);
  }
}

const redactWith = key => text => String(text ?? '').split(key).join('<tavily-key>');

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function sample(list, count, random) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; }
  return copy.slice(0, count);
}

/** host without www + path without trailing slash, lowercased; query and hash dropped. */
export function normalizeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.hostname.toLowerCase().replace(/^www\./u, '')}${url.pathname.replace(/\/+$/u, '').toLowerCase()}`;
  } catch { return ''; }
}
/** host plus the first path segment: the employer's ATS tenant or careers section. */
export function tenantOf(value) {
  const normalized = normalizeUrl(value);
  const [host, first = ''] = normalized.split('/');
  return host ? `${host}/${first}` : '';
}

async function usage(key) {
  try {
    const response = await fetch('https://api.tavily.com/usage', { headers: { Authorization: `Bearer ${key}` } });
    if (!response.ok) return null;
    const body = await response.json();
    return body?.key?.usage ?? body?.account?.plan_usage ?? null;
  } catch { return null; }
}

async function main(argv) {
  const opts = options(argv);
  const key = opts.dryRun ? 'dry-run-no-key' : readTavilyKey();
  const redact = redactWith(key);
  const [{ parseWorkspaceText, restoreWorkspaceContent }, bridge, nonApi, worker, profiles, sdk, runner, offload, replay] = await Promise.all([
    ipc('workspaceContentPool.js'), ipc('officialPostingBridge.js'), ipc('nonApiAi.js'), ipc('claudeTaskWorker.js'),
    ipc('claudeTaskProfiles.js'), ipc('claudeApplicationSdkStage.js'), ipc('claudeApplicationRunner.js'), ipc('offloadTextCall.js'),
    import(new URL('./ai-task-replay.mjs', import.meta.url).href),
  ]);
  const parsed = parseWorkspaceText(fs.readFileSync(opts.canvas, 'utf8'));
  const canvas = restoreWorkspaceContent(parsed) ?? parsed;
  const node = replay.findBoardNode(canvas);
  if (!node) throw new Error('No Job Board node with rows was found in the canvas.');
  const rows = replay.selectRowsForTask(TASK, [node.data.scoredJobs, node.data.rows, node.data.jobs].find(Array.isArray));
  const knownUrls = row => [row.officialPosting.sourceUrl, row.officialPosting.officialApplyUrl].filter(Boolean);
  const found = rows.filter(row => row.officialPosting.outcome === 'found' && knownUrls(row).length);
  const missed = rows.filter(row => row.officialPosting.outcome === 'not-found');
  const random = mulberry32(opts.seed);
  const picked = [...sample(found, opts.found, random).map(row => ({ row, kind: 'found' })),
    ...sample(missed, opts.missed, random).map(row => ({ row, kind: 'missed' }))];
  console.log(`board rows with a lookup result: ${rows.length} (found ${found.length}, not found ${missed.length}); testing ${picked.length}`);

  const profile = profiles.claudeTaskProfile(TASK);
  if (opts.dryRun) {
    for (const item of picked) {
      const job = { ...item.row }; delete job.officialPosting; delete job.postedBy;
      const request = bridge.buildOfficialPostingResearchRequest([job]);
      const prompt = nonApi.materializeNonApiPrompt({ prompt: request.prompt, cachedPrefix: request.cachedPrefix, task: TASK, grounding: request.grounding });
      console.log(`${item.kind.padEnd(6)} prompt ${prompt.length} chars · description ${String(job.snippet || job.description || '').length} chars · known urls ${item.kind === 'found' ? knownUrls(item.row).length : 0}`);
    }
    console.log(`dry run: profile ${profile.model}/${profile.effort}, native tools ${profile.tools}; no AI call made`);
    return 0;
  }
  const binary = runner.resolveClaudeBinary({ env: process.env, homedir: os.homedir() });
  const stage = { binary, env: runner.claudeChildEnv(process.env, path.dirname(binary)), cwd: os.tmpdir() };
  const arms = {
    native: { tools: String(profile.tools).split(','), mcpServers: {} },
    tavily: { tools: TAVILY_TOOLS, mcpServers: { tavily: { type: 'http', url: `https://mcp.tavily.com/mcp/?tavilyApiKey=${encodeURIComponent(key)}` } } },
  };
  // Both toolsets in one call: Claude's own search and page reader plus Tavily's.
  arms.both = { tools: [...arms.native.tools, ...TAVILY_TOOLS], mcpServers: arms.tavily.mcpServers };
  // DeepSeek Flash through Offload with its own web_search/web_fetch, exactly as a routed task call.
  arms.deepseek = { offload: { route: 'deepseek-flash', reasoning: 'high' } };
  const armNames = opts.arms;
  for (const arm of armNames) if (!arms[arm]) throw new Error(`Unknown arm ${arm}; use native, tavily, both or deepseek.`);

  fs.mkdirSync(opts.out, { recursive: true, mode: 0o700 });
  const resultsPath = path.join(opts.out, 'results.jsonl');
  fs.writeFileSync(resultsPath, '', { mode: 0o600 });
  const usageBefore = await usage(key);

  async function runArm(armName, item) {
    const job = { ...item.row };
    delete job.officialPosting; delete job.postedBy;
    const request = bridge.buildOfficialPostingResearchRequest([job]);
    const prompt = nonApi.materializeNonApiPrompt({ prompt: request.prompt, cachedPrefix: request.cachedPrefix, task: TASK, grounding: request.grounding });
    const cached = worker.cachedPromptParts(prompt, request.cachedPrefix ? String(request.cachedPrefix) : '');
    const toolCalls = {};
    const started = Date.now();
    const record = { arm: armName, kind: item.kind, title: item.row.title, company: item.row.company, known: item.kind === 'found' ? knownUrls(item.row) : [] };
    try {
      const reply = arms[armName].offload
        ? await offload.offloadTextCall({ messages: offload.handoffMessages(cached), route: arms[armName].offload.route,
          reasoning: arms[armName].offload.reasoning, tag: TASK, webTools: {} })
        : await sdk.runClaudeSdkStage({
        ...stage, ...cached, env: cached.systemAppend ? stage.env : { ...stage.env, DISABLE_PROMPT_CACHING: '1' },
        pageImages: [], model: profile.model, effort: profile.effort, persistSession: false, maxTurns: RESEARCH_MAX_TURNS,
        tools: arms[armName].tools, mcpServers: arms[armName].mcpServers,
        onActivity: event => { if (event?.kind === 'tool') for (const call of event.calls) toolCalls[call.tool] = (toolCalls[call.tool] || 0) + 1; },
      });
      record.durationMs = Date.now() - started;
      record.costUsd = reply.costUsd ?? null;
      record.toolCalls = reply.webTools && typeof reply.webTools === 'object' && !Object.keys(toolCalls).length
        ? Object.fromEntries(Object.entries(reply.webTools).filter(([, value]) => typeof value === 'number')) : toolCalls;
      try {
        const [parsedRow] = request.responseValidator(reply.text);
        record.valid = true;
        record.candidates = parsedRow.candidates.map(candidate => candidate.postingUrl || candidate.careersPageUrl);
      } catch (error) {
        record.valid = false;
        record.rejection = error?.ruleIds?.join(',') || error?.code || 'invalid';
        record.candidates = [];
      }
    } catch (error) {
      record.durationMs = Date.now() - started;
      record.error = redact(error?.code || error?.message || 'error');
      record.toolCalls = toolCalls;
      record.candidates = [];
    }
    const known = new Set(record.known.map(normalizeUrl));
    const knownTenants = new Set(record.known.map(tenantOf));
    record.exactHit = record.candidates.some(url => known.has(normalizeUrl(url)));
    record.tenantHit = record.candidates.some(url => knownTenants.has(tenantOf(url)));
    fs.appendFileSync(resultsPath, `${redact(JSON.stringify(record))}\n`);
    return record;
  }

  const queue = picked.flatMap(item => armNames.map(arm => ({ arm, item })));
  const records = [];
  let next = 0;
  await Promise.all(Array.from({ length: opts.concurrency }, async () => {
    while (next < queue.length) {
      const { arm, item } = queue[next++];
      const record = await runArm(arm, item);
      records.push(record);
      console.log(`${String(records.length).padStart(3)}/${queue.length} ${arm.padEnd(6)} ${item.kind.padEnd(6)} valid=${record.valid ?? false} exact=${record.exactHit} tools=${JSON.stringify(record.toolCalls)}${record.error ? ` error=${record.error}` : ''}`);
    }
  }));
  const usageAfter = await usage(key);

  const summary = {};
  for (const arm of armNames) {
    const mine = records.filter(record => record.arm === arm);
    const foundSet = mine.filter(record => record.kind === 'found');
    const missedSet = mine.filter(record => record.kind === 'missed');
    const sum = (list, fn) => list.reduce((total, record) => total + (fn(record) || 0), 0);
    summary[arm] = {
      runs: mine.length,
      errors: mine.filter(record => record.error).length,
      validReplies: mine.filter(record => record.valid).length,
      foundExactHits: `${foundSet.filter(record => record.exactHit).length}/${foundSet.length}`,
      foundTenantHits: `${foundSet.filter(record => record.tenantHit).length}/${foundSet.length}`,
      missedWithLeads: `${missedSet.filter(record => record.candidates.length).length}/${missedSet.length}`,
      avgSeconds: mine.length ? Math.round(sum(mine, record => record.durationMs) / mine.length / 1000) : null,
      claudeCostUsd: Number(sum(mine, record => record.costUsd).toFixed(4)),
      runsUsingNoTool: mine.filter(record => !Object.keys(record.toolCalls || {}).length).length,
      toolCalls: mine.reduce((all, record) => { for (const [tool, n] of Object.entries(record.toolCalls || {})) all[tool] = (all[tool] || 0) + n; return all; }, {}),
    };
  }
  summary.tavilyCredits = usageBefore !== null && usageAfter !== null ? usageAfter - usageBefore : 'unavailable';
  fs.writeFileSync(path.join(opts.out, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
  console.log(redact(JSON.stringify(summary, null, 2)));
  console.log(`details: ${resultsPath}`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 1; });
}
