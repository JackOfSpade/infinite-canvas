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
export function repairJobMojibake(job) {
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
