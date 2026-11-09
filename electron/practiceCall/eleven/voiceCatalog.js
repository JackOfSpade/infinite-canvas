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
  ['cantonese', 'chinese'],
  ['mandarin', 'chinese'],
  ['taiwan', 'chinese'],
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

const textOf = value => String(value ?? '').trim().toLowerCase();

/** Verified language codes, from raw API voices (objects) or normalized voices (strings). */
export const verifiedLanguagesOf = voice => {
  const list = Array.isArray(voice?.verifiedLanguages) ? voice.verifiedLanguages
    : Array.isArray(voice?.verified_languages) ? voice.verified_languages : [];
  return list.map(item => (typeof item === 'string' ? item : item?.language)).map(textOf).filter(Boolean);
};

/** labels.language, else fine_tuning.language, else the first verified language, else ''. */
export const languageOf = voice => {
  const labels = voice?.labels ?? {};
  const explicit = textOf(voice?.language ?? labels.language);
  if (explicit) return explicit;
  const tuned = textOf(voice?.fine_tuning?.language);
  if (tuned) return tuned;
  return verifiedLanguagesOf(voice)[0] ?? '';
};

export const rateOf = voice => {
  const raw = voice?.sharing?.rate ?? voice?.rate;
  if (raw === null || raw === undefined || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
};

/** English unless a language label says otherwise; any verified languages must include English. */
export const isEnglishVoice = voice => {
  const language = languageOf(voice);
  if (language && !language.startsWith('en')) return false;
  const verified = verifiedLanguagesOf(voice);
  return verified.length === 0 || verified.some(item => item.startsWith('en'));
};

/** Standard price: no price multiplier at all, or one at or below the base rate. */
export const isStandardPrice = voice => {
  const rate = rateOf(voice);
  return rate === null || rate <= 1;
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
    descriptive: String(labels.descriptive ?? voice?.descriptive ?? '').trim().toLowerCase(),
    description: String(voice?.description ?? labels.description ?? '').trim(),
    language: languageOf(voice),
    rate: rateOf(voice),
    verifiedLanguages: verifiedLanguagesOf(voice),
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
      // A Chinese-language library voice must never voice an English interviewer.
      if (!isEnglishVoice(normalized)) continue;
      if (!isStandardPrice(normalized)) continue;
      voices.push(normalized);
    }
    token = body?.next_page_token;
    if (!body?.has_more || !token) break;
  }
  return voices;
}

/** Picks the voice first, then a name that fits its accent and gender label. */
export function pickPersonaVoice({ voices = [], random = Math.random, temperament, avoidVoiceIds } = {}) {
  const known = voices.filter(voice => voice?.voiceId && hasKnownGender(voice));
  const conversational = known.filter(isConversational);
  const eligible = conversational.length ? conversational : known;
  if (!eligible.length) throw voiceError('voice-protocol', 'no conversational voice with a known gender');
  // The last used voice is skipped only while another eligible voice exists.
  const avoided = new Set((Array.isArray(avoidVoiceIds) ? avoidVoiceIds : []).map(textOf).filter(Boolean));
  const fresh = avoided.size ? eligible.filter(voice => !avoided.has(textOf(voice.voiceId))) : eligible;
  const pool = fresh.length ? fresh : eligible;
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
  // Only a requested temperament is set here; otherwise Claude chooses one that fits the voice.
  const mood = temperament && ['warm', 'neutral', 'tough'].includes(String(temperament).toLowerCase())
    ? String(temperament).toLowerCase()
    : null;
  return {
    voiceId: voice.voiceId,
    voiceName: voice.voiceName ?? '',
    name: `${first} ${last}`,
    gender,
    age: voice.age || 'unknown',
    accent: voice.accent || 'unknown',
    language: languageOf(voice),
    temperament: mood,
    character: voiceCharacterOf(voice),
  };
}

/** The voice's own descriptors, for the interviewer prompt: never its ElevenLabs first name. */
export function voiceCharacterOf(voice) {
  const named = String(voice?.voiceName ?? '');
  const dash = named.search(/\s[-\u2013\u2014]\s/);
  const traits = dash >= 0 ? named.slice(dash + 3).trim() : '';
  // The interviewer has its own name, so the voice's own name words are cut from the blurb.
  const nameWords = (dash >= 0 ? named.slice(0, dash) : named).split(/\s+/)
    .map(word => word.replace(/[^\p{L}'-]/gu, '')).filter(word => word.length >= 2);
  let about = String(voice?.description ?? '');
  for (const word of nameWords) about = about.replace(new RegExp(`(?<![\\p{L}])${word}(?![\\p{L}])`, 'giu'), '');
  about = about.replace(/\s+/g, ' ').replace(/^[\s\-\u2013\u2014,:.]+/, '').trim();
  return {
    traits: traits.slice(0, 80),
    descriptive: String(voice?.descriptive ?? '').trim().toLowerCase(),
    about: about.length > 200 ? `${about.slice(0, 197).trimEnd()}...` : about,
  };
}
