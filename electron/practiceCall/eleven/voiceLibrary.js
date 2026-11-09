/**
 * The shared voice library: a uniformly random draw over the whole eligible ElevenLabs
 * Voice Library, and never over the account's own voices. Library voices are drawn
 * unsaved and used directly, because live tests on 2026-11-08 showed an unsaved library
 * id works with the text-to-dialogue WebSocket (~4.5 s on the first line, then ~0.2 s),
 * so the app never writes a library voice to the account.
 * Every call is injected (fetch, fs) so tests never touch the network or the disk.
 */
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { classifyFailure, redact, voiceError, SUBSCRIPTION_URL } from './dialogueVoice.js';
import {
  hasKnownGender, isEnglishVoice, isStandardPrice, languageOf, normalizeGender, rateOf,
} from './voiceCatalog.js';

export { SUBSCRIPTION_URL };

export const SHARED_VOICES_URL = 'https://api.elevenlabs.io/v1/shared-voices';

const MAX_LAST_USED = 50;

const textOf = value => String(value ?? '').trim().toLowerCase();
const finiteNumber = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

/** One HTTP request with the key in the header and never in an error message. */
async function sendRequest({ fetch: fetchImpl = globalThis.fetch, key, url, method = 'GET', body, signal, what }) {
  const headers = { 'xi-api-key': key };
  const options = { method, headers, signal };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetchImpl(url, options);
  } catch (cause) {
    throw voiceError('voice-network', redact(`${what} request failed`, key), { cause });
  }
  if (!response?.ok) {
    const status = Number(response?.status) || 0;
    throw voiceError(classifyFailure({ status, message: '' }), redact(`${what} request failed (HTTP ${status})`, key), { status });
  }
  return response;
}

async function requestJson({ what, ...options }) {
  const response = await sendRequest({ ...options, what });
  try {
    return await response.json();
  } catch (cause) {
    throw voiceError('voice-protocol', redact(`${what} response was not JSON`, options.key), { cause });
  }
}

const caseLabelsOf = voice => {
  if (Array.isArray(voice?.useCases)) return voice.useCases.map(textOf).filter(Boolean);
  return String(voice?.use_case ?? voice?.labels?.use_case ?? '')
    .split(',').map(textOf).filter(Boolean);
};

/** One shared-voices row → the library shape, or null when it is not a usable candidate. */
export function normalizeLibraryVoice(voice) {
  const voiceId = String(voice?.voice_id ?? voice?.voiceId ?? '').trim();
  const publicOwnerId = String(voice?.public_owner_id ?? voice?.publicOwnerId ?? '').trim();
  if (!voiceId || !publicOwnerId) return null;
  if (voice?.is_added_by_user === true || voice?.isAddedByUser === true) return null;
  if (!hasKnownGender({ gender: voice?.gender ?? voice?.labels?.gender })) return null;
  const useCases = caseLabelsOf(voice);
  if (!useCases.includes('conversational')) return null;
  if (!isEnglishVoice(voice)) return null;
  if (!isStandardPrice(voice)) return null;
  return {
    voiceId,
    publicOwnerId,
    voiceName: String(voice?.name ?? voice?.voiceName ?? ''),
    gender: normalizeGender(voice?.gender ?? voice?.labels?.gender),
    age: textOf(voice?.age ?? voice?.labels?.age),
    accent: textOf(voice?.accent ?? voice?.labels?.accent),
    language: languageOf(voice),
    useCases,
    rate: rateOf(voice),
    category: String(voice?.category ?? ''),
    descriptive: textOf(voice?.descriptive ?? voice?.labels?.descriptive),
    description: String(voice?.description ?? voice?.labels?.description ?? '').trim(),
  };
}

/** A normalized library voice in the catalogue shape pickPersonaVoice and voiceCharacterOf read. */
const catalogVoiceOf = voice => ({
  voiceId: voice.voiceId,
  voiceName: voice.voiceName,
  gender: voice.gender,
  age: voice.age,
  accent: voice.accent,
  useCases: voice.useCases,
  category: voice.category,
  description: voice.description,
  descriptive: voice.descriptive,
  language: voice.language,
  rate: voice.rate,
});

const indexAt = (value, length) => {
  const number = Number(value?.());
  const clamped = Number.isFinite(number) ? Math.min(Math.max(number, 0), 0.999999) : 0;
  return Math.floor(clamped * length);
};

/**
 * The voice library's own failure code. dialogueVoice's voiceError keeps only its socket
 * codes, so the error is built through it — message, status and cause plumbing stay
 * shared — and the library code is restored on the way out.
 */
function libraryUnavailable(message, options = {}) {
  const error = voiceError('voice-protocol', message, options);
  error.code = 'voice-library-unavailable';
  return error;
}

/**
 * Draws one interviewer voice uniformly from the eligible rows of the whole shared
 * library, by rejection sampling over the index space T: i = floor(random * T), page
 * floor(i / pageSize), row i % pageSize. Only library voices are ever returned: the
 * account's own voices are not candidates and there is no fallback.
 * Library voices are returned unsaved; the only requests are GETs of shared-voices pages.
 * An unreadable page 0 or a total_count that is not a positive number, and exhausting
 * maxAttempts, both throw code 'voice-library-unavailable'.
 */
export async function drawVoice({
  fetch: fetchImpl = globalThis.fetch, key, random = Math.random,
  excludeVoiceIds = [], pageSize = 100, maxAttempts = 24, signal,
} = {}) {
  const exclude = new Set((Array.isArray(excludeVoiceIds) ? excludeVoiceIds : [])
    .map(voiceId => String(voiceId ?? '').trim()).filter(Boolean));
  const attemptLimit = Number.isFinite(Number(maxAttempts)) && Number(maxAttempts) >= 1 ? Math.floor(Number(maxAttempts)) : 0;
  const size = Number.isFinite(Number(pageSize)) && Number(pageSize) >= 1 ? Math.floor(Number(pageSize)) : 100;

  const pages = new Map();
  const fetchPage = async page => {
    if (pages.has(page)) return pages.get(page);
    const target = new URL(SHARED_VOICES_URL);
    target.searchParams.set('language', 'en');
    target.searchParams.set('use_cases', 'conversational');
    target.searchParams.set('page_size', String(size));
    target.searchParams.set('page', String(page));
    let found;
    try {
      const body = await requestJson({ fetch: fetchImpl, key, url: target.toString(), signal, what: 'voice library' });
      found = {
        rows: Array.isArray(body?.voices) ? body.voices : [],
        total: finiteNumber(body?.total_count),
        error: null,
      };
    } catch (error) {
      found = { rows: [], total: null, error };
    }
    pages.set(page, found);
    return found;
  };

  const first = await fetchPage(0);
  if (!first || first.total === null || !(first.total > 0)) {
    throw libraryUnavailable('The ElevenLabs voice library could not be read.',
      first?.error ? { cause: first.error } : {});
  }
  const libraryTotal = first.total;

  for (let attempts = 1; attempts <= attemptLimit; attempts += 1) {
    const index = indexAt(random, libraryTotal);
    const data = await fetchPage(Math.floor(index / size));
    if (!data) continue;
    const row = normalizeLibraryVoice(data.rows[index % size]);
    if (!row) continue;
    if (exclude.has(row.voiceId)) continue;
    return { voice: catalogVoiceOf(row), source: 'library', libraryTotal, attempts };
  }

  throw libraryUnavailable('No usable voice was found in the ElevenLabs voice library.');
}

function emptyState() {
  return { version: 1, lastUsed: {} };
}

/** Anything a hand-edited or older file holds is coerced back into the documented shape. */
function cleanState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState();
  const entries = [];
  if (raw.lastUsed && typeof raw.lastUsed === 'object' && !Array.isArray(raw.lastUsed)) {
    for (const [voiceId, at] of Object.entries(raw.lastUsed)) {
      const value = finiteNumber(at);
      if (voiceId && value !== null) entries.push({ voiceId, at: value });
    }
  }
  const recent = new Set(entries.slice().sort((left, right) => right.at - left.at)
    .slice(0, MAX_LAST_USED).map(entry => entry.voiceId));
  const lastUsed = {};
  for (const entry of entries) if (recent.has(entry.voiceId)) lastUsed[entry.voiceId] = entry.at;
  return { version: 1, lastUsed };
}

/** The pool state file: tolerant on load, atomic (tmp + rename) on save. */
export function createVoicePoolStore({ filePath, fs = fsPromises } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('practice voice pool requires a file path');
  return {
    async load() {
      try {
        const text = await fs.readFile(filePath, 'utf8');
        return cleanState(JSON.parse(String(text)));
      } catch {
        return emptyState();
      }
    },
    async save(state) {
      const temp = `${filePath}.tmp`;
      const data = `${JSON.stringify(cleanState(state), null, 2)}\n`;
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(temp, data, { mode: 0o600 });
      await fs.rename(temp, filePath);
    },
  };
}
