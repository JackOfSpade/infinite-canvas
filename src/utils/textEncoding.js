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
 * Read one HTML-like tag without treating `>` inside a quoted attribute as its
 * end. This is deliberately a small tokenizer rather than a regular-expression
 * tag filter: scraped HTML is untrusted and commonly contains quoted URLs,
 * malformed attributes, comments, and raw script/style bodies. It is also
 * framework-agnostic, so the same behavior is available in the renderer and
 * Electron's main process without a DOMParser dependency.
 */
function readHtmlTag(source, start) {
  const length = source.length;
  let i = start + 1;
  if (i >= length) return null;

  // Comments and declarations have no tag name, but are still markup. An
  // unterminated comment consumes the remainder just as an HTML parser would.
  if (source.startsWith('<!--', start)) {
    const close = source.indexOf('-->', start + 4);
    return { kind: 'comment', end: close === -1 ? length : close + 3 };
  }
  if (source[i] === '!' || source[i] === '?') {
    const end = findHtmlTagEnd(source, i + 1);
    return end === -1 ? null : { kind: 'declaration', end: end + 1 };
  }

  let closing = false;
  if (source[i] === '/') {
    closing = true;
    i += 1;
  }
  // A tag name must begin with a letter. This retains prose such as "x < 5"
  // and malformed literal fragments instead of silently deleting it.
  if (!isAsciiLetter(source[i])) return null;
  const nameStart = i;
  i += 1;
  while (i < length && isHtmlTagNameChar(source[i])) i += 1;
  const end = findHtmlTagEnd(source, i);
  if (end === -1) return null;
  return { kind: 'tag', name: source.slice(nameStart, i).toLowerCase(), closing, end: end + 1 };
}

function findHtmlTagEnd(source, start) {
  let quote = null;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function isAsciiLetter(ch) {
  return typeof ch === 'string' && ch.length === 1
    && ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z'));
}

function isHtmlTagNameChar(ch) {
  return isAsciiLetter(ch) || (ch >= '0' && ch <= '9') || ch === ':' || ch === '-' || ch === '_';
}

const BLOCK_TAGS = new Set(['p', 'div', 'li', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'table', 'section', 'article', 'blockquote']);
const RAW_TEXT_TAGS = new Set(['script', 'style']);

/**
 * Strip HTML markup from a description body, preserving its BLOCK structure as
 * newlines so the model still sees paragraph/list boundaries. Entities are
 * decoded AFTER tokenizing, so an escaped "&lt;script&gt;" in the copy stays inert
 * text rather than becoming markup.
 */
export function stripHtmlToText(s) {
  if (typeof s !== 'string' || !s) return s;
  let text = '';
  let rawTextTag = null;
  for (let i = 0; i < s.length;) {
    if (s[i] !== '<') {
      if (!rawTextTag) text += s[i];
      i += 1;
      continue;
    }
    const tag = readHtmlTag(s, i);
    if (!tag) {
      if (!rawTextTag) text += s[i];
      i += 1;
      continue;
    }
    i = tag.end;
    if (rawTextTag) {
      if (tag.kind === 'tag' && tag.closing && tag.name === rawTextTag) {
        rawTextTag = null;
        text += ' ';
      }
      continue;
    }
    if (tag.kind !== 'tag') {
      text += ' ';
    } else if (!tag.closing && RAW_TEXT_TAGS.has(tag.name)) {
      rawTextTag = tag.name;
      text += ' ';
    } else if (!tag.closing && tag.name === 'li') {
      text += '\n• ';
    } else if (!tag.closing && (tag.name === 'br' || tag.name === 'hr')) {
      text += '\n';
    } else if (tag.closing && BLOCK_TAGS.has(tag.name)) {
      text += '\n';
    } else {
      text += ' ';
    }
  }
  return decodeHtmlEntities(text)
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
