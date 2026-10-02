// Mojibake repair for scraped text.
//
// Some job sources (notably RemoteOK's open API) serve descriptions whose UTF-8
// was already mis-decoded as Latin-1 at THEIR end — e.g. an apostrophe (U+2019,
// bytes E2 80 99) arrives as the 3-char sequence U+00E2 U+0080 U+0099; em-dashes
// and 𝗯𝗼𝗹𝗱-Unicode titles mangle the same way. This corruption flows into
// scoring AND the generated résumé, and previously tricked language detection.
//
// The fix reverses the transform: treat each ≤0xFF code point as a raw byte and
// re-decode VALID UTF-8 multibyte sequences back to their original character.
//
// Framework-agnostic (TextDecoder-free hand parser / Uint8Array — no Node Buffer)
// so both `src/` and `electron/` can import it.

// C1 control chars (U+0080–U+009F) never occur in legitimate text — they're the
// tell-tale continuation bytes of a UTF-8 sequence mis-read as Latin-1. This is
// the same signal the bug-report field-quality check uses, and the gate that
// stops us from ever touching clean text or real accents (é/à/ç).
const C1_CONTROL = /[\u0080-\u009f]/;

export function hasMojibake(s) {
  return typeof s === 'string' && C1_CONTROL.test(s);
}

// Tolerant UTF-8 decode over a byte array: decode each VALID multibyte sequence,
// and pass any byte that isn't part of one straight through as its Latin-1 char.
// This recovers valid mojibake even when interleaved with un-recoverable bytes
// (e.g. an orphaned "Â" whose nbsp was normalized away) and NEVER emits U+FFFD.
function decodeUtf8Tolerant(bytes) {
  let res = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i];
    if (b < 0x80) { res += String.fromCharCode(b); i++; continue; }
    let len = 0, cp = 0;
    if (b >= 0xc2 && b <= 0xdf) { len = 2; cp = b & 0x1f; }
    else if (b >= 0xe0 && b <= 0xef) { len = 3; cp = b & 0x0f; }
    else if (b >= 0xf0 && b <= 0xf4) { len = 4; cp = b & 0x07; }
    else { res += String.fromCharCode(b); i++; continue; } // not a valid lead byte
    if (i + len > bytes.length) { res += String.fromCharCode(b); i++; continue; }
    let ok = true;
    for (let k = 1; k < len; k++) {
      const c = bytes[i + k];
      if (c < 0x80 || c > 0xbf) { ok = false; break; }
      cp = (cp << 6) | (c & 0x3f);
    }
    if (!ok || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) { res += String.fromCharCode(b); i++; continue; }
    res += String.fromCodePoint(cp);
    i += len;
  }
  return res;
}

// Return `s` with mojibake repaired, or `s` unchanged when there's nothing to fix.
// Only runs when C1 controls are present (so clean text and real accents are never
// touched). Genuine high-Unicode chars (emoji, real smart-quotes) act as run
// boundaries and pass through verbatim — only the ≤0xFF byte-runs are re-decoded.
export function repairMojibake(s) {
  if (typeof s !== 'string' || !s) return s;
  if (!C1_CONTROL.test(s)) return s;
  let out = '';
  let bytes = [];
  const flush = () => { if (bytes.length) { out += decodeUtf8Tolerant(bytes); bytes = []; } };
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp > 0xff) { flush(); out += ch; } // genuine Unicode → not a mojibake byte
    else bytes.push(cp);
  }
  flush();
  return out;
}

// Repair the user-facing text fields of a job IN PLACE. Returns the job.
const JOB_TEXT_FIELDS = ['title', 'company', 'location', 'salary', 'snippet', 'description'];
function repairJobMojibake(job) {
  if (!job || typeof job !== 'object') return job;
  for (const f of JOB_TEXT_FIELDS) {
    if (typeof job[f] === 'string' && job[f]) job[f] = repairMojibake(job[f]);
  }
  return job;
}

export function repairJobsMojibake(jobs) {
  if (Array.isArray(jobs)) for (const j of jobs) repairJobMojibake(j);
  return jobs;
}

// ── HTML markup normalization ────────────────────────────────────────────────
//
// Sources that hand us text through a DOM (`innerText`/`textContent`) arrive
// already-decoded. The ones that DON'T — WeWorkRemotely (regex over raw RSS
// XML) and LinkedIn (raw `description` HTML) — leak markup and entities all the
// way into the scoring prompt, the card, and the résumé generator: confirmed in
// a live run as titles reading "Customer Support &amp; Product Demo Specialist"
// and descriptions opening with "<p> <strong>Headquarters:</strong> …". Raw tags
// are pure token waste on a paid scoring call and dilute the text the model
// reasons over, so both are normalized once at the pipeline chokepoint next to
// repairJobsMojibake rather than per-extractor (a new source gets the fix free).

// Only the entities that actually appear in scraped listing text. A general
// named-entity table would be dead weight; numeric refs cover the long tail.
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘',
  rdquo: '”', ldquo: '“', bull: '•', middot: '·', trade: '™',
  reg: '®', copy: '©', deg: '°', eacute: 'é', euro: '€', pound: '£', cent: '¢',
};

/**
 * Decode the HTML entities a non-DOM extraction path leaves behind. Handles
 * named refs (table above), decimal (`&#39;`) and hex (`&#x27;`) numeric refs.
 * Unknown entities are left verbatim — never guessed at, so a literal "&foo;"
 * in a job description survives intact. Pure + testable.
 */
export function decodeHtmlEntities(s) {
  if (typeof s !== 'string' || !s || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body) => {
    const b = body.toLowerCase();
    if (b[0] === '#') {
      const cp = b[1] === 'x' ? parseInt(b.slice(2), 16) : parseInt(b.slice(1), 10);
      // Reject non-characters/surrogates rather than emitting a replacement char.
      if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, b) ? NAMED_ENTITIES[b] : whole;
  });
}

/**
 * Strip HTML markup from a description body, preserving its BLOCK structure as
 * newlines so the model still sees paragraph/list boundaries (a naive tag strip
 * runs every bullet into one wall of prose). Entities are decoded AFTER the
 * strip, so an escaped "&lt;script&gt;" in the copy stays inert text.
 */
export function stripHtmlToText(s) {
  if (typeof s !== 'string' || !s) return s;
  if (!/<[a-z!/]/i.test(s)) return decodeHtmlEntities(s);
  const withBreaks = s
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/\s*(?:script|style)\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(?:br|hr)\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(?:p|div|li|tr|h[1-6]|ul|ol|table|section|article|blockquote)\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n• ')
    .replace(/<[^>]+>/g, ' ');
  return decodeHtmlEntities(withBreaks)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Short fields must never contain markup at all; long ones keep block structure.
const JOB_ENTITY_FIELDS = ['title', 'company', 'location', 'salary'];
const JOB_MARKUP_FIELDS = ['snippet', 'description'];

/**
 * Normalize a job's scraped text IN PLACE: entities decoded everywhere, markup
 * stripped from the description bodies. Returns the job. Idempotent and a no-op
 * on text that is already clean.
 */
export function normalizeJobMarkup(job) {
  if (!job || typeof job !== 'object') return job;
  for (const f of JOB_ENTITY_FIELDS) {
    if (typeof job[f] === 'string' && job[f]) job[f] = decodeHtmlEntities(job[f]);
  }
  for (const f of JOB_MARKUP_FIELDS) {
    if (typeof job[f] === 'string' && job[f]) job[f] = stripHtmlToText(job[f]);
  }
  return job;
}

export function normalizeJobsMarkup(jobs) {
  if (Array.isArray(jobs)) for (const j of jobs) normalizeJobMarkup(j);
  return jobs;
}
