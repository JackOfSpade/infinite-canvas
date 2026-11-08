/**
 * Account voice catalogue and persona voice picking.
 * Voices come from the documented voices search endpoint; names come from voiceNames.js data.
 */
import { classifyFailure, voiceError, redact } from './dialogueVoice.js';
import { DIVERSE_POOL, NAME_POOLS, NEUTRAL_FIRST_NAMES } from './voiceNames.js';

export const VOICES_URL = 'https://api.elevenlabs.io/v2/voices';
export const PAGE_SIZE = 100;
export const MAX_PAGES = 20;

// Longest, most specific accents first so "south african" never matches a bare "african".
const ACCENT_KEYS = [
  ['south african', 'south african'],
  ['new zealand', null],
  ['indian', 'indian'],
  ['nigerian', 'nigerian'],
  ['irish', 'irish'],
  ['scottish', 'scottish'],
  ['australian', 'australian'],
  ['spanish', 'spanish'],
  ['chinese', 'chinese'],
  ['french', 'french'],
  ['german', 'german'],
  ['italian', 'italian'],
  ['japanese', 'japanese'],
  ['korean', 'korean'],
  ['brazilian', 'brazilian'],
  ['mexican', 'mexican'],
];

export const normalizeGender = value => {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return 'neutral';
  if (/non.?binary|neutral|androgyn|gender.?fluid/.test(text)) return 'neutral';
  if (/f/.test(text)) return 'female';
  if (/m/.test(text)) return 'male';
  return 'neutral';
};

export const labelUseCases = labels => String(labels?.use_case ?? labels?.useCase ?? '')
  .split(',').map(item => item.trim().toLowerCase()).filter(Boolean);

export const isConversational = voice => {
  const cases = Array.isArray(voice?.useCases) ? voice.useCases : labelUseCases(voice?.labels);
  return cases.includes('conversational');
};

export const hasKnownGender = voice => {
  const gender = String(voice?.gender ?? voice?.labels?.gender ?? '').trim();
  return gender.length > 0;
};

/** Accent label → regional name pool key, or null for the deliberately diverse pool. */
export function accentPoolKey(accent) {
  const text = String(accent ?? '').trim().toLowerCase();
  for (const [needle, key] of ACCENT_KEYS) if (text.includes(needle)) return key;
  return null;
}

export function normalizeVoice(voice) {
  const labels = voice?.labels ?? {};
  return {
    voiceId: voice?.voice_id ?? voice?.voiceId,
    voiceName: voice?.name ?? '',
    gender: String(labels.gender ?? voice?.gender ?? '').trim().toLowerCase(),
    age: String(labels.age ?? voice?.age ?? '').trim().toLowerCase(),
    accent: String(labels.accent ?? voice?.accent ?? '').trim().toLowerCase(),
    useCases: labelUseCases(labels),
    category: voice?.category ?? '',
    description: labels.description ?? '',
  };
}

const pick = (list, random) => {
  if (!Array.isArray(list) || !list.length) return undefined;
  const value = Number(random?.());
  const at = Number.isFinite(value) ? Math.floor(Math.min(Math.max(value, 0), 0.999999) * list.length) : 0;
  return list[at];
};

export async function listConversationalVoices({
  fetch = globalThis.fetch, key, url = VOICES_URL, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, signal,
} = {}) {
  const voices = [];
  let token;
  for (let page = 0; page < maxPages; page += 1) {
    const target = new URL(url);
    target.searchParams.set('page_size', String(pageSize));
    if (token) target.searchParams.set('next_page_token', token);
    let response;
    try {
      response = await fetch(target.toString(), { headers: { 'xi-api-key': key }, signal });
    } catch (cause) {
      throw voiceError('voice-network', 'voices request failed', { cause });
    }
    if (!response?.ok) {
      const code = classifyFailure({ status: Number(response?.status) || 0 });
      throw voiceError(code, redact(`voices request failed (HTTP ${response?.status})`, key), { status: response?.status });
    }
    let body;
    try { body = await response.json(); } catch (cause) {
      throw voiceError('voice-protocol', 'voices response was not JSON', { cause });
    }
    for (const voice of Array.isArray(body?.voices) ? body.voices : []) {
      const normalized = normalizeVoice(voice);
      if (!normalized.voiceId) continue;
      if (!isConversational(normalized)) continue;
      if (!hasKnownGender(normalized)) continue;
      voices.push(normalized);
    }
    token = body?.next_page_token;
    if (!body?.has_more || !token) break;
  }
  return voices;
}

/** Picks the voice first, then a name that fits its accent and gender label. */
export function pickPersonaVoice({ voices = [], random = Math.random, temperament } = {}) {
  const known = voices.filter(voice => voice?.voiceId && hasKnownGender(voice));
  const conversational = known.filter(isConversational);
  const pool = conversational.length ? conversational : known;
  if (!pool.length) throw voiceError('voice-protocol', 'no conversational voice with a known gender');
  const voice = pick(pool, random);
  const gender = normalizeGender(voice.gender);
  const accent = String(voice.accent ?? '').trim().toLowerCase();
  const key = accentPoolKey(accent);
  const names = (key && NAME_POOLS[key]) || DIVERSE_POOL;
  const gendered = names[gender];
  const firstNames = gender === 'neutral'
    ? (names.neutral?.length ? names.neutral : NEUTRAL_FIRST_NAMES)
    : (gendered?.length ? gendered : NEUTRAL_FIRST_NAMES);
  const first = pick(firstNames, random);
  const last = pick(names.last, random);
  const mood = temperament && ['warm', 'neutral', 'tough'].includes(String(temperament).toLowerCase())
    ? String(temperament).toLowerCase()
    : pick(['warm', 'neutral', 'tough'], random);
  return {
    voiceId: voice.voiceId,
    voiceName: voice.voiceName ?? '',
    name: `${first} ${last}`,
    gender,
    age: voice.age || 'unknown',
    accent: voice.accent || 'unknown',
    temperament: mood,
  };
}
