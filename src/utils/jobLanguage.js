// Language sniff for scraped job listings — a HYBRID of the `tinyld` library
// (free, MIT, pure-JS, no native build) for full descriptions plus a small
// diacritic fallback for the short / title-only case n-gram libraries can't
// handle (e.g. an authwalled fr.glassdoor.ca listing with an empty description).
//
// We REQUEST English everywhere (Accept-Language: en-US, --lang=en-US), but some
// boards serve localized job descriptions anyway — fr.glassdoor.ca for Ontario,
// Québec / EU employers posting in their own language. We deliberately KEEP these
// listings: the AI scorer reads any language fine, and the user may well speak
// it, so whether to apply is left to the user. This module ONLY tags a listing's
// language so the card can show a chip and the run report can note how many came
// through. It never drops or down-scores anything.
//
// Detection is offline (no network, no LLM) and intentionally CONSERVATIVE:
// English is the default, and tinyld must be confident (or the text long enough)
// before we tag non-English — mislabeling a normal English JD is worse, and more
// visible to the user, than leaving a foreign one untagged.
//
// Framework-agnostic so both `src/` (renderer) and `electron/` (main) can import
// it — though in practice only the main process runs detection (the renderer
// imports labels from jobLanguageLabels.js, which has no tinyld dependency).

import { detectAll } from 'tinyld';

// Latin letters + the diacritics our fallback recognizes.
const TOKEN_RE = /[a-zà-öø-ÿ]+/g;

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
  if (tokens.length < 6) return diacriticGuess(lower) || 'en';

  const ranked = detectAll(raw.slice(0, 2000)); // first ~2k chars is plenty + cheap
  const top = ranked[0];
  const enAcc = ranked.find((r) => r.lang === 'en')?.accuracy || 0;

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
  if (top && top.lang && top.lang !== 'en' && top.accuracy >= 0.5 && (top.accuracy - enAcc) >= 0.2) {
    return top.lang;
  }
  return 'en';
}

// Mutates a job IN PLACE: sets `job.language` only when confidently non-English
// (English is the implicit default, so the field is left unset to keep the
// payload small and the card chip absent). Returns the job.
export function tagJobLanguage(job) {
  if (!job || typeof job !== 'object') return job;
  const lang = detectLanguage(`${job.title || ''}\n${job.description || ''}\n${job.snippet || ''}`);
  if (lang && lang !== 'en') job.language = lang;
  return job;
}

export function tagJobLanguages(jobs) {
  if (Array.isArray(jobs)) for (const j of jobs) tagJobLanguage(j);
  return jobs;
}

// Tally for the run report: how many kept listings were non-English, broken down
// by language, with one sample each.
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
      samples[l] = `${j.title || 'Untitled'}${where} [${j.source || '?'}]`;
    }
  }
  return { total: list.length, nonEnglish, byLang, samples };
}
