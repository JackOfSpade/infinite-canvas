// Language sniff for scraped job listings — a HYBRID of the `tinyld` library
// (free, MIT, pure-JS, no native build) for full descriptions plus a small
// diacritic fallback for the short / title-only case n-gram libraries can't
// handle (e.g. an authwalled fr.glassdoor.ca listing with an empty description).
//
// We REQUEST English everywhere (Accept-Language: en-US, --lang=en-US), but some
// boards serve localized job descriptions anyway — fr.glassdoor.ca for Ontario,
// Québec / EU employers posting in their own language. Before scoring, drop
// listings whose description (or snippet when empty) is mostly non-English.
// Measure sections separately so bilingual postings with a larger English
// section survive even when the non-English section comes first. Dropped rows
// retain a language tag for run diagnostics; kept rows need no language chip.
//
// Detection is offline (no network, no LLM) and intentionally CONSERVATIVE:
// English is the default, and tinyld must be confident (or the text long enough)
// before counting a section as non-English. Dropping a normal English JD is
// worse than retaining an inconclusive one.
//
// Framework-agnostic so both `src/` (renderer) and `electron/` (main) can import
// it — though in practice only the main process runs detection (the renderer
// imports labels from jobLanguageLabels.js, which has no tinyld dependency).

import { detectAll } from 'tinyld';

// Latin letters + the diacritics our fallback recognizes.
const TOKEN_RE = /[a-zà-öø-ÿ]+/g;

// The short-text heuristic is only for sparse Latin-script titles. A genuine
// listing in one of the non-Latin scripts we support must reach tinyld even
// when TOKEN_RE finds no words; otherwise, for example, a Greek or Arabic JD
// would always fall through to the English default before scriptConsistent()
// could validate its result.
const NON_LATIN_JOB_SCRIPT_RE = /[\p{Script=Arabic}\p{Script=Greek}\p{Script=Hebrew}\p{Script=Devanagari}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Hangul}\p{Script=Cyrillic}]/u;

// Job boards in this app target English-speaking North American users. Keep a
// conservative set of languages plausibly encountered in localized listings;
// sparse profiles such as Berber/Klingon/Volapük otherwise win telegraphic
// English strings simply because tinyld normalizes confidence across all 62
// bundled profiles.
const JOB_LANGUAGE_CANDIDATES = Object.freeze([
  'en', 'fr', 'es', 'pt', 'de', 'it', 'nl',
  'pl', 'uk', 'ru', 'tr', 'ar', 'he', 'hi',
  'zh', 'ja', 'ko', 'vi', 'tl', 'el',
]);

const SCRIPT_TESTS = Object.freeze({
  ar: /\p{Script=Arabic}/u,
  el: /\p{Script=Greek}/u,
  he: /\p{Script=Hebrew}/u,
  hi: /\p{Script=Devanagari}/u,
  ja: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u,
  ko: /\p{Script=Hangul}/u,
  ru: /\p{Script=Cyrillic}/u,
  uk: /\p{Script=Cyrillic}/u,
  zh: /\p{Script=Han}/u,
});

function scriptConsistent(lang, raw) {
  const re = SCRIPT_TESTS[lang];
  return !re || re.test(raw);
}

// Short-text fallback: when there's too little text for tinyld to be reliable
// (it returns near-zero-accuracy guesses on a 2-3 word title), lean on script
// hints. Requires ≥2 diacritics so a single accented loanword in an English
// title ("Café Manager", "Naïve Bayes Engineer") is NOT mistaken for a language.
function diacriticGuess(s) {
  const dia = s.match(/[à-öø-ÿ¿¡]/g) || [];
  if (dia.length < 2) return null;
  if (/[ñ¿¡]/.test(s)) return 'es';
  if (/ß/.test(s)) return 'de';
  if (/[ãõ]/.test(s)) return 'pt';
  if (/[äöü]/.test(s)) return 'de';
  if (/[éèêëàâçîïù]/.test(s)) return 'fr';
  return null;
}

// Returns a 2-letter ISO 639-1 language code. Defaults to 'en' whenever the
// signal is weak or ambiguous.
export function detectLanguage(text) {
  const raw = String(text || '');
  if (!raw.trim()) return 'en';
  const lower = raw.toLowerCase();
  const tokens = lower.match(TOKEN_RE) || [];

  // Too little text for the n-gram model → diacritic hint only (the authwalled
  // title-only case). tinyld returns garbage below ~6 words, so don't trust it.
  if (tokens.length < 6 && !NON_LATIN_JOB_SCRIPT_RE.test(raw)) return diacriticGuess(lower) || 'en';

  const ranked = detectAll(raw.slice(0, 2000), { only: JOB_LANGUAGE_CANDIDATES }); // first ~2k chars is plenty + cheap
  const top = ranked[0];
  // detectAll's `only` filter and result rows both use two-letter ids.
  const enAcc = ranked.find((r) => r.lang === 'en')?.accuracy || 0;
  const topLang = top?.lang;

  // Trust tinyld on 6+ words. Tag non-English only when it's BOTH confident
  // (≥0.5) AND clearly ahead of English (≥0.2 margin) — the margin rejects
  // garbage / stylized-Unicode near-ties. Genuine foreign JDs clear both bars
  // easily (a Portuguese JD scores pt:0.78, en:~0); a false chip on an English
  // JD is the worst outcome, so otherwise default to English.
  //
  // We deliberately do NOT second-guess a tinyld 'en' verdict with a diacritic
  // scan here: scraped JDs are riddled with mojibake ("—"→"â€"", "'"→"â€™") whose
  // stray à/â/ç bytes would mis-flag a clearly-English post as fr/es. The
  // diacritic hint is only for the short title-only path above (no body to read).
  if (
    top && topLang && topLang !== 'en'
    && top.accuracy >= 0.5
    && (top.accuracy - enAcc) >= 0.2
    && scriptConsistent(topLang, raw)
  ) {
    return topLang;
  }
  return 'en';
}

// Estimate the English share by character weight, across at most 8k characters.
// Greedy sentence/line groups give tinyld enough context without letting the
// first language in a bilingual description decide the whole listing. Short or
// inconclusive chunks keep detectLanguage's conservative English default.
export function englishShare(text) {
  const pieces = String(text || '').slice(0, 8000).split(/[\r\n]+|(?<=[.!?。])\s+/u);
  const nonEnglishWeights = new Map();
  let englishWeight = 0;
  let totalWeight = 0;
  let chunk = '';
  const scoreChunk = () => {
    if (!chunk) return;
    const language = detectLanguage(chunk);
    const weight = chunk.length;
    totalWeight += weight;
    if (language === 'en') englishWeight += weight;
    else nonEnglishWeights.set(language, (nonEnglishWeights.get(language) || 0) + weight);
    chunk = '';
  };
  for (const piece of pieces) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    chunk = chunk ? `${chunk} ${trimmed}` : trimmed;
    if (chunk.length >= 200) scoreChunk();
  }
  scoreChunk();

  let dominant = null;
  let dominantWeight = 0;
  for (const [language, weight] of nonEnglishWeights) {
    if (weight > dominantWeight) {
      dominant = language;
      dominantWeight = weight;
    }
  }
  return { share: totalWeight ? englishWeight / totalWeight : 1, dominant };
}

// Mutate language tags on the original rows, but return a new kept list. This
// lets callers summarize the pre-filter list to count and sample dropped jobs.
// Titles never decide eligibility; empty descriptions fall back to snippets.
export function filterNonEnglishJobs(jobs) {
  const kept = [];
  const dropped = [];
  for (const job of Array.isArray(jobs) ? jobs : []) {
    if (!job || typeof job !== 'object') {
      kept.push(job);
      continue;
    }
    const description = String(job.description || '').trim();
    const { share, dominant } = englishShare(description || job.snippet);
    if (share < 0.5) {
      job.language = dominant;
      dropped.push(job);
    } else {
      delete job.language;
      kept.push(job);
    }
  }
  return { jobs: kept, dropped };
}

// Legacy tagging helper retained for older callers and saved-card behavior.
// Mutates a job IN PLACE: sets `job.language` only when confidently non-English
// (English is the implicit default, so the field is left unset to keep the
// payload small and the card chip absent). Re-tagging is common after a scraper
// recovers a fuller description, so clear an older non-English tag when the new
// evidence is English or inconclusive; otherwise a stale language chip survives
// even though the current listing text no longer supports it. Returns the job.
export function tagJobLanguage(job) {
  if (!job || typeof job !== 'object') return job;
  const lang = detectLanguage(`${job.title || ''}\n${job.description || ''}\n${job.snippet || ''}`);
  if (lang && lang !== 'en') job.language = lang;
  else delete job.language;
  return job;
}

export function tagJobLanguages(jobs) {
  if (Array.isArray(jobs)) for (const j of jobs) tagJobLanguage(j);
  return jobs;
}

// Tally for the run report: summarize the pre-filter rows after filtering to
// count non-English drops by language, with one sample each.
export function summarizeJobLanguages(jobs) {
  const list = Array.isArray(jobs) ? jobs : [];
  const byLang = {};
  const samples = {};
  let nonEnglish = 0;
  for (const j of list) {
    const l = j?.language;
    if (!l || l === 'en') continue;
    nonEnglish++;
    byLang[l] = (byLang[l] || 0) + 1;
    if (!samples[l]) {
      const where = j.location ? ` — ${j.location}` : '';
      const evidence = String(j.description || j.snippet || j.title || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160);
      samples[l] = {
        label: `${j.title || 'Untitled'}${where} [${j.source || '?'}]`,
        evidence,
      };
    }
  }
  return { total: list.length, nonEnglish, byLang, samples };
}
