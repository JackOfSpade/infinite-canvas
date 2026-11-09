// LIVE end-to-end probe of the practice-call interviewer persona pipeline:
// ElevenLabs voice pick -> derived name/gender/accent -> temperament -> interviewer prompt -> spoken greeting.
//
//   node scripts/practice-probes/persona-e2e.mjs [--draws N] [--seed S] [--speak K] [--speak-all]
//                                               [--claude K] [--library-draws N] [--out DIR]
//
// --claude K starts K real interviewer sessions (Claude CLI, Opus low) on distinct voices and
// records which temperament each one chose for its voice.
//
// --library-draws N (default 40) chains N real full-library draws, each avoiding the previous pick,
// and proves every request behind them is a GET to /v1/shared-voices. Step 10 then warms one drawn
// library voice up with a discarded 'Hi.' and measures the greeting that follows.
//
// Runs by hand against the real ElevenLabs account (network + macOS Keychain). The API key is read
// from the keychain and is never printed: every error is passed through redact(). Node built-ins only.

import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { readElevenLabsKey } from '../../electron/practiceCall/eleven/elevenKey.js';
import {
  createDialogueVoiceFactory, fetchSubscriptionTier, rateForTier, redact,
} from '../../electron/practiceCall/eleven/dialogueVoice.js';
import {
  VOICES_URL, accentPoolKey, hasKnownGender, isConversational, isEnglishVoice, isStandardPrice,
  listConversationalVoices, normalizeGender, normalizeVoice, pickPersonaVoice,
} from '../../electron/practiceCall/eleven/voiceCatalog.js';
import { DIVERSE_POOL, NAME_POOLS, NEUTRAL_FIRST_NAMES } from '../../electron/practiceCall/eleven/voiceNames.js';
import { drawVoice } from '../../electron/practiceCall/eleven/voiceLibrary.js';
import { buildInterviewerInstructions, temperamentFromReady } from '../../electron/interviewPracticeCallPrompt.js';
import { createInterviewerSession } from '../../electron/interviewPracticeTransport.js';

const SPEAK_TIMEOUT_MS = 20000;
const greetingFor = firstName => `Hi, I'm ${firstName}. Thanks for making the time today. Shall we get started?`;

// ---------------------------------------------------------------- harness

const state = { key: '', args: null };
const results = [];

const pad = (value, width) => String(value ?? '').padEnd(width).slice(0, width);
const fmtPct = value => `${(value * 100).toFixed(1)}%`;
const fmtMs = value => (Number.isFinite(value) ? `${Math.round(value)}ms` : 'n/a');

function heading(title) {
  console.log(`\n=== ${title} ===`);
}

function describeError(error) {
  return redact(error?.message ?? String(error), state.key);
}

/** Records and prints one check line; `detail` is always redacted before printing. */
function check(name, ok, detail = '') {
  const safe = redact(detail, state.key);
  results.push({ name, ok });
  console.log(ok ? `PASS ${name}` : `FAIL ${name}${safe ? ` - ${safe}` : ''}`);
  return ok;
}

// ---------------------------------------------------------------- CLI

function countOption(name, value, min) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min) {
    throw new Error(`--${name} must be an integer >= ${min}`);
  }
  return parsed;
}

function parseCliArgs(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      draws: { type: 'string', default: '3000' },
      seed: { type: 'string', default: '1' },
      speak: { type: 'string', default: '3' },
      'speak-all': { type: 'boolean', default: false },
      claude: { type: 'string', default: '0' },
      out: { type: 'string' },
      'library-draws': { type: 'string', default: '40' },
    },
  });
  const out = path.resolve(values.out ?? path.join(os.tmpdir(), `persona-e2e-${Date.now()}`));
  return {
    draws: countOption('draws', values.draws, 1),
    seed: countOption('seed', values.seed, 0),
    speak: countOption('speak', values.speak, 0),
    speakAll: values['speak-all'] === true,
    claude: countOption('claude', values.claude, 0),
    out,
    libraryDraws: countOption('library-draws', values['library-draws'], 1),
  };
}

// ---------------------------------------------------------------- seeded PRNG and statistics

/** mulberry32: tiny deterministic 32-bit PRNG returning values in [0, 1). */
function mulberry32(seed) {
  let state32 = (Number(seed) || 0) >>> 0;
  return function random() {
    state32 = (state32 + 0x6d2b79f5) >>> 0;
    let t = state32;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(list, random) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

/** Abramowitz-Stegun 7.1.26 approximation of the error function. */
function erf(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const poly = ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

function normalCdf(z) {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

/** Chi-square upper-tail p-value via the Wilson-Hilferty normal approximation. */
function chiSquarePValue(statistic, df) {
  if (!(df > 0)) return 1;
  if (!(statistic > 0)) return 1;
  const z = (Math.cbrt(statistic / df) - (1 - 2 / (9 * df))) / Math.sqrt(2 / (9 * df));
  return Math.min(1, Math.max(0, 1 - normalCdf(z)));
}

// ---------------------------------------------------------------- voice / name / WAV helpers

/** The name pool the picker must draw from for a voice's accent and gender. */
function expectedNames({ accent, gender }) {
  const key = accentPoolKey(accent);
  const names = (key && NAME_POOLS[key]) || DIVERSE_POOL;
  const normalized = normalizeGender(gender);
  const gendered = names[normalized];
  const list = normalized === 'neutral'
    ? (Array.isArray(names.neutral) && names.neutral.length ? names.neutral : NEUTRAL_FIRST_NAMES)
    : (Array.isArray(gendered) && gendered.length ? gendered : NEUTRAL_FIRST_NAMES);
  return { key: key || 'diverse', firstNames: [...list], lastNames: [...(names.last ?? [])] };
}

function firstNameOf(fullName) {
  return String(fullName ?? '').trim().split(/\s+/)[0] ?? '';
}

function lastNameOf(fullName) {
  const parts = String(fullName ?? '').trim().split(/\s+/);
  return parts.slice(1).join(' ');
}

/** 44-byte RIFF header for 16-bit mono little-endian PCM. */
function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Re-parses a 44-byte header and reports whether it is a valid mono/16-bit PCM WAV at `sampleRate`. */
function inspectWav(header, dataBytes, sampleRate) {
  const problems = [];
  if (header.length !== 44) problems.push(`header ${header.length} bytes`);
  if (header.toString('ascii', 0, 4) !== 'RIFF') problems.push('no RIFF');
  if (header.toString('ascii', 8, 12) !== 'WAVE') problems.push('no WAVE');
  if (header.toString('ascii', 12, 16) !== 'fmt ') problems.push('no fmt');
  if (header.readUInt16LE(20) !== 1) problems.push('not PCM');
  if (header.readUInt16LE(22) !== 1) problems.push('not mono');
  if (header.readUInt32LE(24) !== sampleRate) problems.push(`rate ${header.readUInt32LE(24)}`);
  if (header.readUInt16LE(34) !== 16) problems.push('not 16-bit');
  if (header.toString('ascii', 36, 40) !== 'data') problems.push('no data');
  if (header.readUInt32LE(40) !== dataBytes) problems.push('bad data length');
  if (header.readUInt32LE(4) !== 36 + dataBytes) problems.push('bad RIFF length');
  return problems;
}

const slug = value => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'voice';

// ---------------------------------------------------------------- catalogue audit helpers

/** One raw /v2/voices entry with the fields the verdicts read. */
function catalogueEntry(raw) {
  const normalized = normalizeVoice(raw);
  const labels = raw?.labels ?? {};
  const language = String(labels.language ?? raw?.language ?? '').trim().toLowerCase();
  return {
    ...normalized,
    labels,
    language,
    priceMultiplier: Number(labels.price_multiplier ?? raw?.price_multiplier),
    useCaseLabel: String(labels.use_case ?? labels.useCase ?? '').trim(),
  };
}

/** First failing reason in the documented order, or ELIGIBLE. */
function eligibility(voice) {
  if (!isConversational(voice)) return 'not-conversational';
  if (!hasKnownGender(voice)) return 'no-gender';
  if (!isEnglishVoice(voice)) return 'not-english';
  if (!isStandardPrice(voice)) return 'price-multiplier';
  return 'ELIGIBLE';
}

// ---------------------------------------------------------------- step 1

async function step1Account() {
  heading('1. account');
  let key;
  try {
    key = await readElevenLabsKey();
  } catch (error) {
    check('account: keychain lookup', false, describeError(error));
    return null;
  }
  state.key = key;
  if (!check('account: keychain lookup', Boolean(key), key ? '' : 'empty key')) return null;
  try {
    const tier = await fetchSubscriptionTier({ fetch, key });
    const rate = rateForTier(tier);
    console.log(`tier=${tier || '(empty)'} sampleRate=${rate}`);
    check('account: tier fetched', Boolean(tier), tier ? '' : 'empty tier string');
    check('account: sample rate is 24000 or 44100', rate === 24000 || rate === 44100, `rate=${rate}`);
    return { tier, rate };
  } catch (error) {
    check('account: subscription request', false, describeError(error));
    return null;
  }
}

// ---------------------------------------------------------------- step 2

async function fetchCatalogueRaw({ key, pageSize = 100, maxPages = 20 }) {
  const voices = [];
  let token;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(VOICES_URL);
    url.searchParams.set('page_size', String(pageSize));
    if (token) url.searchParams.set('next_page_token', token);
    const response = await fetch(url.toString(), { headers: { 'xi-api-key': key } });
    if (!response?.ok) throw new Error(`voices page ${page + 1} failed (HTTP ${response?.status})`);
    const body = await response.json();
    for (const voice of Array.isArray(body?.voices) ? body.voices : []) voices.push(voice);
    token = body?.next_page_token;
    if (!body?.has_more || !token) break;
  }
  return voices;
}

async function step2Catalogue({ key }) {
  heading('2. raw catalogue audit');
  let entries;
  let listed;
  try {
    const raw = await fetchCatalogueRaw({ key });
    entries = raw.map(rawVoice => {
      const voice = catalogueEntry(rawVoice);
      return { voice, verdict: eligibility(voice) };
    });
    listed = await listConversationalVoices({ fetch, key });
  } catch (error) {
    check('catalogue: raw audit', false, describeError(error));
    return;
  }
  console.log([
    pad('voice', 28), pad('category', 12), pad('gender', 8), pad('age', 8),
    pad('accent', 16), pad('language', 10), pad('use_case', 20), 'verdict',
  ].join(' '));
  for (const { voice, verdict } of entries) {
    console.log([
      pad(voice.voiceName || '-', 28), pad(voice.category || '-', 12), pad(voice.gender || '-', 8),
      pad(voice.age || '-', 8), pad(voice.accent || '-', 16), pad(voice.language || '-', 10),
      pad(voice.useCaseLabel || '-', 20), verdict,
    ].join(' '));
  }
  const eligible = new Set(entries.filter(entry => entry.verdict === 'ELIGIBLE').map(entry => entry.voice.voiceId));
  const listedIds = new Set(listed.map(voice => voice.voiceId));
  const missing = [...eligible].filter(id => !listedIds.has(id));
  const extra = [...listedIds].filter(id => !eligible.has(id));
  check(
    'catalogue: ELIGIBLE ids match listConversationalVoices()',
    missing.length === 0 && extra.length === 0,
    `raw=${entries.length} eligible=${eligible.size} listed=${listedIds.size} missing=${missing.join(',') || '-'} extra=${extra.join(',') || '-'}`,
  );
}

// ---------------------------------------------------------------- step 3

async function step3Pool({ key }) {
  heading('3. pool summary');
  let pool;
  try {
    pool = await listConversationalVoices({ fetch, key });
  } catch (error) {
    check('pool: listConversationalVoices()', false, describeError(error));
    return [];
  }
  if (!check('pool: conversational voices available', pool.length > 0, pool.length ? '' : 'empty pool')) return pool;
  const split = { male: 0, female: 0, neutral: 0 };
  for (const voice of pool) split[normalizeGender(voice.gender)] += 1;
  console.log(`size=${pool.length} gender split=male=${split.male} female=${split.female} neutral=${split.neutral}`);
  for (const voice of pool) {
    const names = expectedNames({ accent: voice.accent, gender: voice.gender });
    console.log(`${pad(voice.voiceName || '-', 30)} ${pad(voice.gender || '-', 10)} ${pad(voice.accent || '-', 20)} -> ${names.key}`);
  }
  return pool;
}

// ---------------------------------------------------------------- step 4

function newBucket() {
  return { count: 0, examples: [] };
}

function violate(bucket, message) {
  bucket.count += 1;
  if (bucket.examples.length < 5) bucket.examples.push(message);
}

function invariantCheck(label, bucket) {
  return check(`draws: ${label}`, bucket.count === 0,
    bucket.count ? `${bucket.count} violation(s); e.g. ${bucket.examples.join(' | ')}` : '');
}

async function step4Draws({ pool, draws, seed }) {
  heading(`4. independent draws (${draws}, seed ${seed})`);
  if (!pool.length) {
    check('draws: pool available', false, 'no conversational voices');
    return { drawn: [] };
  }
  const byId = new Map(pool.map(voice => [voice.voiceId, voice]));
  const random = mulberry32(seed);
  const violations = {
    voice: newBucket(), gender: newBucket(), first: newBucket(),
    last: newBucket(), language: newBucket(), temperament: newBucket(),
  };
  const counts = new Map();
  const nameStats = new Map();
  const drawn = [];

  for (let index = 0; index < draws; index += 1) {
    let draw;
    try {
      draw = pickPersonaVoice({ voices: pool, random });
    } catch (error) {
      check('draws: pickPersonaVoice()', false, describeError(error));
      return { drawn };
    }
    drawn.push(draw);
    const voice = byId.get(draw.voiceId);
    if (!voice) violate(violations.voice, `#${index} voiceId=${draw.voiceId} not in pool`);
    counts.set(draw.voiceId, (counts.get(draw.voiceId) ?? 0) + 1);
    const first = firstNameOf(draw.name);
    const last = lastNameOf(draw.name);
    const stats = nameStats.get(draw.voiceId) ?? { full: new Set(), first: new Set(), examples: [] };
    stats.full.add(draw.name);
    stats.first.add(first);
    if (stats.examples.length < 3 && !stats.examples.includes(draw.name)) stats.examples.push(draw.name);
    nameStats.set(draw.voiceId, stats);
    if (!voice) continue;

    const expectedGender = normalizeGender(voice.gender);
    if (draw.gender !== expectedGender) violate(violations.gender, `#${index} ${draw.voiceId} ${draw.gender} != ${expectedGender}`);
    const names = expectedNames({ accent: voice.accent, gender: voice.gender });
    if (!names.firstNames.includes(first)) violate(violations.first, `#${index} ${first} not in ${names.key}.${expectedGender}`);
    if (!last || !names.lastNames.includes(last)) violate(violations.last, `#${index} ${last || '(none)'} not in ${names.key}.last`);
    const language = String(draw.language ?? voice.language ?? '').trim().toLowerCase();
    if (!(language === '' || language.startsWith('en'))) violate(violations.language, `#${index} ${draw.voiceId} language=${language}`);
    // No temperament was requested, so none is set: Claude chooses one from the voice.
    if (draw.temperament !== null) violate(violations.temperament, `#${index} temperament=${draw.temperament}`);
    if (!draw.character || typeof draw.character.traits !== 'string') violate(violations.temperament, `#${index} no voice character`);
  }

  invariantCheck('voiceId in pool', violations.voice);
  invariantCheck('gender matches voice label', violations.gender);
  invariantCheck('first name from expected pool', violations.first);
  invariantCheck('last name from expected pool', violations.last);
  invariantCheck("language is '' or starts with 'en'", violations.language);
  invariantCheck('temperament left for Claude, voice character present', violations.temperament);

  const total = drawn.length;
  const voiceCount = pool.length;
  const expected = total / voiceCount;
  let chiSquare = 0;
  const rows = pool.map(voice => {
    const picks = counts.get(voice.voiceId) ?? 0;
    chiSquare += ((picks - expected) ** 2) / expected;
    const stats = nameStats.get(voice.voiceId) ?? { full: new Set(), first: new Set(), examples: [] };
    return {
      voice,
      picks,
      share: total ? picks / total : 0,
      full: stats.full.size,
      first: stats.first.size,
      examples: stats.examples,
      key: expectedNames({ accent: voice.accent, gender: voice.gender }).key,
    };
  });
  const df = voiceCount - 1;
  const pValue = chiSquarePValue(chiSquare, df);
  check('draws: chi-square uniformity p >= 0.001', pValue >= 0.001,
    `chi2=${chiSquare.toFixed(2)} df=${df} p=${pValue.toFixed(4)}`);
  const neverPicked = rows.filter(row => row.picks === 0);
  const coverageApplicable = total >= 20 * voiceCount;
  check('draws: every voice picked (draws >= 20*n)', !coverageApplicable || neverPicked.length === 0,
    coverageApplicable ? `${neverPicked.length} never picked` : `not applicable (${total} < ${20 * voiceCount})`);

  console.log([
    pad('voice', 28), pad('gender', 8), pad('accent', 18), pad('pool', 14),
    pad('picks', 6), pad('share', 8), pad('distinct', 20), 'examples',
  ].join(' '));
  for (const row of rows) {
    console.log([
      pad(row.voice.voiceName || '-', 28), pad(row.voice.gender || '-', 8), pad(row.voice.accent || '-', 18),
      pad(row.key, 14), pad(String(row.picks), 6), pad(fmtPct(row.share), 8),
      pad(`${row.full} full/${row.first} first`, 20), row.examples.join(', '),
    ].join(' '));
  }

  return { drawn };
}

// ---------------------------------------------------------------- step 5

async function step5Chaining({ pool, draws, seed }) {
  heading(`5. consecutive-call simulation (${draws} chained draws with avoidVoiceIds)`);
  if (!pool.length) {
    check('chain: pool available', false, 'no conversational voices');
    return;
  }
  const byId = new Map(pool.map(voice => [voice.voiceId, voice]));
  const random = mulberry32(seed + 1);
  const picked = [];
  const repeats = [];
  let previous = null;
  for (let index = 0; index < draws; index += 1) {
    let draw;
    try {
      draw = pickPersonaVoice({ voices: pool, random, avoidVoiceIds: previous ? [previous] : [] });
    } catch (error) {
      check('chain: pickPersonaVoice()', false, describeError(error));
      return;
    }
    if (previous && draw.voiceId === previous) repeats.push(index);
    picked.push(draw.voiceId);
    previous = draw.voiceId;
  }
  check('chain: no consecutive repeat', pool.length <= 1 || repeats.length === 0,
    repeats.length ? `${repeats.length} repeat(s) at draw ${repeats.slice(0, 5).join(',')}` : '');

  const lastSeen = new Map();
  let longestGap = 0;
  let gapVoice = '';
  picked.forEach((id, index) => {
    if (lastSeen.has(id)) {
      const gap = index - lastSeen.get(id);
      if (gap > longestGap) {
        longestGap = gap;
        gapVoice = id;
      }
    }
    lastSeen.set(id, index);
  });
  const counts = new Map();
  for (const id of picked) counts.set(id, (counts.get(id) ?? 0) + 1);
  const gapName = byId.get(gapVoice)?.voiceName ?? '-';
  console.log(`longest gap between picks of one voice: ${longestGap} draw(s) (${gapName})`);
  console.log(`${pad('voice', 28)} ${pad('picks', 6)} share`);
  for (const voice of pool) {
    const picks = counts.get(voice.voiceId) ?? 0;
    console.log(`${pad(voice.voiceName || '-', 28)} ${pad(String(picks), 6)} ${fmtPct(picked.length ? picks / picked.length : 0)}`);
  }
}

// ---------------------------------------------------------------- step 6

async function step6ForcedTemperament({ pool, seed }) {
  heading('6. forced temperament');
  if (!pool.length) {
    check('forced: pool available', false, 'no conversational voices');
    return;
  }
  const random = mulberry32(seed + 2);
  const wrong = [];
  for (let index = 0; index < 200; index += 1) {
    let draw;
    try {
      draw = pickPersonaVoice({ voices: pool, random, temperament: 'tough' });
    } catch (error) {
      check('forced: pickPersonaVoice()', false, describeError(error));
      return;
    }
    if (draw.temperament !== 'tough') wrong.push(`#${index}=${draw.temperament}`);
  }
  check('forced: all 200 draws are tough', wrong.length === 0, wrong.slice(0, 5).join(', '));
}

// ---------------------------------------------------------------- step 7

async function step7PromptAlignment({ pool, seed, claude }) {
  heading('7. voice described to Claude, temperament chosen by Claude');
  if (!pool.length) {
    check('prompt: pool available', false, 'no conversational voices');
    return;
  }
  const random = mulberry32(seed + 3);
  const voices = shuffle(pool, random).slice(0, Math.max(3, claude));
  const brief = { company: 'Example Co', role: 'Software Engineer', roleSummary: '', roleThemes: [], companyFacts: [], recentContext: [] };
  for (const [index, voice] of voices.entries()) {
    const draw = pickPersonaVoice({ voices: [voice], random });
    const persona = {
      name: draw.name, role: 'Hiring Manager', team: 'Platform', temperament: null,
      voice: { gender: draw.gender, age: draw.age, accent: draw.accent, character: draw.character },
    };
    const text = buildInterviewerInstructions({ persona, brief, plan: [], targetMinutes: [25, 30] });
    const voiceLine = text.split('\n').find(line => line.startsWith('- You speak with')) ?? '';
    console.log(`${voice.voiceName}: ${voiceLine || '(no voice line)'}`);
    const firstName = String(voice.voiceName ?? '').split(/\s[-\u2013\u2014]\s/)[0].trim();
    const leaksName = firstName.length >= 2
      && new RegExp(`(?<![\\p{L}])${firstName.replace(/[^\p{L}'-]/gu, '')}(?![\\p{L}])`, 'iu').test(voiceLine);
    check(`prompt: ${draw.name} has a voice line and a temperament choice`,
      text.startsWith(`You are ${draw.name}, `) && Boolean(voiceLine) && text.includes('Choose your temperament now')
        && text.endsWith('READY neutral') && !leaksName,
      `voiceLine=${Boolean(voiceLine)} leaksVoiceName=${leaksName}`);
    if (index >= claude) continue;
    const session = await createInterviewerSession({ model: 'opus', effort: 'low' });
    try {
      const startedAt = performance.now();
      const ready = await withTimeout(session.start({ instructions: text }), 120000);
      const chosen = temperamentFromReady(ready?.reply);
      console.log(`  Claude chose: ${ready?.reply} (${fmtMs(performance.now() - startedAt)})`);
      check(`claude: ${voice.voiceName} -> ${chosen ?? '(none)'}`, Boolean(chosen), `reply=${ready?.reply}`);
    } catch (error) {
      check(`claude: ${voice.voiceName}`, false, describeError(error));
    } finally {
      await session.close?.();
    }
  }
}

// ---------------------------------------------------------------- step 8

/** Distinct-voice pick that prefers covering both genders and different accents. */
function chooseSpeakTargets({ pool, count, random }) {
  const shuffled = shuffle(pool, random);
  const chosen = [];
  const genders = new Set();
  const accents = new Set();
  for (const voice of shuffled) {
    if (chosen.length >= count) break;
    const gender = normalizeGender(voice.gender);
    const accent = String(voice.accent ?? '').trim().toLowerCase();
    if (!genders.has(gender) || !accents.has(accent)) {
      chosen.push(voice);
      genders.add(gender);
      accents.add(accent);
    }
  }
  for (const voice of shuffled) {
    if (chosen.length >= count) break;
    if (!chosen.includes(voice)) chosen.push(voice);
  }
  return chosen;
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* the probe already failed */ }
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function speakOne({ key, tier, voice, persona, index, outDir }) {
  const factory = createDialogueVoiceFactory({ key, voiceId: voice.voiceId, tier });
  const stream = factory.open({ utteranceId: `e2e-${index}` });
  const chunks = [];
  const words = [];
  let firstAudioAt = null;
  let audioRate = stream.sampleRate;
  let streamError = '';
  stream.onWords(list => { for (const word of Array.isArray(list) ? list : []) words.push(word); });
  stream.onError(error => { streamError = redact(error?.message ?? error, key); });
  stream.onAudio(chunk => {
    if (firstAudioAt === null) {
      firstAudioAt = performance.now();
      audioRate = stream.sampleRate;
    }
    chunks.push(Buffer.from(chunk));
  });

  const firstName = firstNameOf(persona.name);
  const sentAt = performance.now();
  const accepted = stream.sendText(greetingFor(firstName));
  let timedOut = false;
  try {
    await withTimeout(stream.finish(), SPEAK_TIMEOUT_MS, () => { timedOut = true; stream.cancel(); });
  } catch (error) {
    streamError = streamError || redact(error?.message ?? error, key);
  }

  const pcm = Buffer.concat(chunks);
  const audioMs = (pcm.length / 2 / audioRate) * 1000;
  const firstAudioMs = firstAudioAt === null ? null : firstAudioAt - sentAt;
  const wavPath = path.join(outDir, `${slug(voice.voiceName)}-${slug(firstName)}.wav`);
  let wavProblems = [];
  if (pcm.length > 0) {
    await fs.mkdir(outDir, { recursive: true });
    const header = wavHeader(pcm.length, audioRate);
    wavProblems = inspectWav(header, pcm.length, audioRate);
    await fs.writeFile(wavPath, Buffer.concat([header, pcm]));
  }
  const problems = [];
  if (!accepted) problems.push('sendText rejected');
  if (pcm.length === 0) problems.push('no audio');
  if (streamError) problems.push(`stream error: ${streamError}`);
  if (timedOut) problems.push('completion timeout');
  if (wavProblems.length > 0) problems.push(`bad wav: ${wavProblems.join(',')}`);
  return {
    voiceName: voice.voiceName || voice.voiceId,
    name: persona.name,
    sampleRate: audioRate,
    firstAudioMs,
    audioMs,
    words: words.length,
    wavPath: pcm.length > 0 ? wavPath : '',
    ok: problems.length === 0,
    problems,
  };
}

async function step8Speech({ key, tier, pool, args }) {
  heading('8. spoken greeting');
  if (args.speak === 0 && !args.speakAll) {
    console.log('speech disabled (--speak 0)');
    return;
  }
  if (!pool.length) {
    check('speech: pool available', false, 'no conversational voices');
    return;
  }
  const random = mulberry32(args.seed + 4);
  const targets = args.speakAll ? [...pool] : chooseSpeakTargets({ pool, count: args.speak, random });
  console.log(`speaking ${targets.length} voice(s)${args.speakAll ? ' (--speak-all)' : ''}`);
  const rows = [];
  for (let index = 0; index < targets.length; index += 1) {
    const voice = targets[index];
    const persona = pickPersonaVoice({ voices: [voice], random });
    let row;
    try {
      row = await speakOne({ key, tier, voice, persona, index, outDir: args.out });
    } catch (error) {
      row = {
        voiceName: voice.voiceName || voice.voiceId, name: persona.name, sampleRate: null,
        firstAudioMs: null, audioMs: 0, words: 0, wavPath: '', ok: false,
        problems: [redact(error?.message ?? error, key)],
      };
    }
    rows.push(row);
    check(`speech: ${row.voiceName} as ${row.name}`, row.ok, row.problems.join('; '));
  }
  console.log([
    pad('voice', 28), pad('name', 22), pad('rate', 7), pad('firstAudio', 12),
    pad('audioMs', 10), pad('words', 6), 'wav',
  ].join(' '));
  for (const row of rows) {
    console.log([
      pad(row.voiceName, 28), pad(row.name, 22), pad(String(row.sampleRate ?? '-'), 7),
      pad(fmtMs(row.firstAudioMs), 12), pad(String(Math.round(row.audioMs)), 10),
      pad(String(row.words), 6), row.wavPath || '-',
    ].join(' '));
  }
  console.log(`WAV files in ${args.out}`);
}

// ---------------------------------------------------------------- step 9

function tally(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].map(([key, count]) => `${key}:${count}`).join(', ') || '-';
}

function topEntries(values, limit) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => `${value}:${count}`)
    .join(', ') || '-';
}

/**
 * The real uniform draw, chained so each pick avoids the previous one. Every request behind it is
 * recorded: the draw must only ever read /v1/shared-voices, because the app never writes voices.
 */
async function step9FullLibraryDraw({ key, args }) {
  heading(`9. full-library draw (${args.libraryDraws} chained draws, GET only)`);
  const random = mulberry32(args.seed + 9);
  const requests = [];
  const recordingFetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: String(init?.method ?? 'GET').toUpperCase() });
    return fetch(url, init);
  };
  const picks = [];
  let libraryTotal = null;
  for (let index = 0; index < args.libraryDraws; index += 1) {
    const previous = picks.length ? picks.at(-1).voice?.voiceId : null;
    try {
      const drawn = await drawVoice({
        fetch: recordingFetch, key, random,
        excludeVoiceIds: previous ? [previous] : [],
      });
      picks.push(drawn);
      if (Number.isFinite(drawn.libraryTotal)) libraryTotal = drawn.libraryTotal;
    } catch (error) {
      check('draw: drawVoice()', false, describeError(error));
      return null;
    }
  }
  // The draw is library-only, so every pick in this step is a library pick.
  const genders = picks.map(pick => normalizeGender(pick.voice?.gender));
  const accents = picks.map(pick => String(pick.voice?.accent ?? '').trim().toLowerCase() || 'unknown');
  console.log(`libraryTotal=${libraryTotal ?? 'n/a'} split=library:${picks.length} gender=${tally(genders)}`);
  console.log(`top accents: ${topEntries(accents, 6)}`);
  for (const pick of picks) {
    console.log(`  ${pad(pick.source, 8)} ${pad(pick.voice?.voiceId, 24)} ${pad(pick.voice?.voiceName || '-', 28)} `
      + `${pad(pick.voice?.gender || '-', 8)} ${pad(pick.voice?.accent || '-', 14)} attempts=${pick.attempts}`);
  }

  check('draw: libraryTotal > 1000', Number.isFinite(libraryTotal) && libraryTotal > 1000, `libraryTotal=${libraryTotal}`);
  const unknownGender = picks.filter(pick => !hasKnownGender(pick.voice));
  check('draw: every draw has a known gender', unknownGender.length === 0,
    `${unknownGender.length} unknown: ${unknownGender.slice(0, 3).map(pick => pick.voice?.voiceId).join(',') || '-'}`);
  const repeats = [];
  for (let index = 1; index < picks.length; index += 1) {
    if (picks[index].voice?.voiceId === picks[index - 1].voice?.voiceId) repeats.push(index);
  }
  check('draw: no consecutive repeat', repeats.length === 0,
    repeats.length ? `${repeats.length} repeat(s) at draw ${repeats.slice(0, 5).join(',')}` : '');
  const libraryRead = request => request.method === 'GET' && new URL(request.url).pathname === '/v1/shared-voices';
  const others = requests.filter(request => !libraryRead(request));
  check('draw: every request is a GET to /v1/shared-voices', requests.length > 0 && others.length === 0,
    `requests=${requests.length} other=${others.slice(0, 3).map(request => `${request.method} ${request.url}`).join(' | ') || '-'}`);

  return { picks, libraryPicks: picks.filter(pick => pick.source === 'library').map(pick => pick.voice) };
}

// ---------------------------------------------------------------- step 10

/** Speaks one line on a shared factory and reports its first-audio latency and PCM. */
async function speakLine({ factory, key, text, utteranceId }) {
  const stream = factory.open({ utteranceId });
  const chunks = [];
  let firstAudioAt = null;
  let audioRate = stream.sampleRate;
  let streamError = '';
  stream.onError(error => { streamError = redact(error?.message ?? error, key); });
  stream.onAudio(chunk => {
    if (firstAudioAt === null) {
      firstAudioAt = performance.now();
      audioRate = stream.sampleRate;
    }
    chunks.push(Buffer.from(chunk));
  });
  const sentAt = performance.now();
  const accepted = stream.sendText(text);
  let timedOut = false;
  try {
    await withTimeout(stream.finish(), SPEAK_TIMEOUT_MS, () => { timedOut = true; stream.cancel(); });
  } catch (error) {
    streamError = streamError || redact(error?.message ?? error, key);
  }
  const pcm = Buffer.concat(chunks);
  return {
    accepted,
    pcm,
    sampleRate: audioRate,
    firstAudioMs: firstAudioAt === null ? null : firstAudioAt - sentAt,
    audioMs: (pcm.length / 2 / audioRate) * 1000,
    error: streamError,
    timedOut,
  };
}

async function step10WarmUpThenSpeak({ key, tier, args, draw }) {
  heading('10. warm-up then speak a library voice');
  if (args.speak === 0) {
    console.log('speech disabled (--speak 0)');
    return;
  }
  const voice = draw?.libraryPicks?.[0];
  if (!voice) {
    check('warm-up: a library voice was drawn', false, 'step 9 produced no library pick');
    return;
  }
  const persona = pickPersonaVoice({ voices: [voice], random: mulberry32(args.seed + 10) });
  const factory = createDialogueVoiceFactory({ key, voiceId: voice.voiceId, tier });

  const warm = await speakLine({ factory, key, text: 'Hi.', utteranceId: 'warm-up' });
  const warmProblems = [];
  if (warm.pcm.length === 0) warmProblems.push('no audio');
  if (warm.error) warmProblems.push(`stream error: ${warm.error}`);
  if (warm.timedOut) warmProblems.push('completion timeout');
  check(`warm-up: one discarded 'Hi.' on ${voice.voiceName || voice.voiceId}`, warmProblems.length === 0,
    `${warmProblems.join('; ')} firstAudio=${fmtMs(warm.firstAudioMs)}`);

  const firstName = firstNameOf(persona.name);
  const greeting = await speakLine({ factory, key, text: greetingFor(firstName), utteranceId: 'library-greeting' });
  const problems = [];
  if (!greeting.accepted) problems.push('sendText rejected');
  if (greeting.pcm.length === 0) problems.push('no audio');
  if (greeting.error) problems.push(`stream error: ${greeting.error}`);
  if (greeting.timedOut) problems.push('completion timeout');
  check('speech: greeting first audio < 1500ms', greeting.firstAudioMs !== null && greeting.firstAudioMs < 1500,
    `firstAudio=${fmtMs(greeting.firstAudioMs)} voice=${voice.voiceId}`);

  let wavPath = '';
  if (greeting.pcm.length > 0) {
    await fs.mkdir(args.out, { recursive: true });
    const header = wavHeader(greeting.pcm.length, greeting.sampleRate);
    const wavProblems = inspectWav(header, greeting.pcm.length, greeting.sampleRate);
    if (wavProblems.length > 0) problems.push(`bad wav: ${wavProblems.join(',')}`);
    wavPath = path.join(args.out, `library-${slug(voice.voiceName)}-${slug(firstName)}.wav`);
    await fs.writeFile(wavPath, Buffer.concat([header, greeting.pcm]));
  }
  console.log(`warm-up first audio ${fmtMs(warm.firstAudioMs)}; greeting first audio ${fmtMs(greeting.firstAudioMs)}, `
    + `audio ${Math.round(greeting.audioMs)}ms, wav=${wavPath || '-'}`);
  check(`speech: library voice ${voice.voiceName || voice.voiceId} as ${persona.name}`, problems.length === 0,
    problems.join('; '));
  console.log(`WAV file in ${args.out}`);
}

// ---------------------------------------------------------------- main

function summarize() {
  heading('summary');
  for (const result of results) console.log(`${result.ok ? 'PASS' : 'FAIL'} ${result.name}`);
  const failed = results.filter(result => !result.ok).length;
  console.log(`\n${results.length} check(s): ${results.length - failed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

async function main() {
  let args;
  try {
    args = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`argument error: ${error.message}`);
    return 2;
  }
  state.args = args;
  console.log(`persona-e2e: draws=${args.draws} seed=${args.seed} speak=${args.speakAll ? 'all' : args.speak} `
    + `libraryDraws=${args.libraryDraws} out=${args.out}`);

  const account = await step1Account();
  if (!account) return summarize();
  await step2Catalogue({ key: state.key });
  const pool = await step3Pool({ key: state.key });
  await step4Draws({ pool, draws: args.draws, seed: args.seed });
  await step5Chaining({ pool, draws: args.draws, seed: args.seed });
  await step6ForcedTemperament({ pool, seed: args.seed });
  await step7PromptAlignment({ pool, seed: args.seed, claude: args.claude });
  await step8Speech({ key: state.key, tier: account.tier, pool, args });
  const libraryDraw = await step9FullLibraryDraw({ key: state.key, args });
  await step10WarmUpThenSpeak({ key: state.key, tier: account.tier, args, draw: libraryDraw });
  return summarize();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let exitCode = 1;
  try {
    exitCode = await main();
  } catch (error) {
    console.error(`FATAL ${redact(error?.stack ?? error?.message ?? error, state.key)}`);
    exitCode = 1;
  }
  process.exit(exitCode);
}
