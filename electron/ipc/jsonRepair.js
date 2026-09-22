import { logger } from '../logger.js';

// Remove only structural trailing commas. A regex cannot distinguish
// `{"text":"literal ,} marker"}` from `{"text":"value",}`, and the old
// cleanup silently changed the former's data before parsing it. Keep this
// deliberately small and string-aware rather than trying to guess at ambiguous
// model mistakes such as missing separators or unescaped quotation marks.
function removeStructuralTrailingCommas(value) {
  const source = String(value || '');
  let result = '';
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      result += char;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') {
      inString = true;
      result += char;
      continue;
    }

    if (char === ',') {
      let next = index + 1;
      while (next < source.length && /\s/.test(source[next])) next += 1;
      if (source[next] === '}' || source[next] === ']') continue;
    }
    result += char;
  }

  return result;
}

// ChatGPT's web UI can append these inline transport annotations while copying
// an answer that cites an automatically-created paste attachment. They are not
// model-authored JSON and the quoted attribute values make an otherwise-valid
// JSON string syntactically invalid (for example
// `:chatgpt-content-reference{index="0"}`). Keep this deliberately exact and
// bounded: it is a recovery for a known UI artifact, never a general attempt to
// guess whether an arbitrary unescaped quote was intended as text. In
// particular, do not remove the same-looking text outside a JSON string — it
// might be the malformed structure we need to reject.
// Exported for copy/paste flows that intentionally accept only one complete
// JSON object, but still need the same narrow ChatGPT UI-artifact recovery as
// the general AI response parser below. Callers must retry strict JSON parsing
// after this cleanup; this helper does not make malformed JSON acceptable.
export function removeChatGptContentReferenceArtifacts(value) {
  const source = String(value || '');
  let cleaned = '';
  let count = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    if (inString && !escaped && source.startsWith(':chatgpt-content-reference{index="', index)) {
      const marker = source.slice(index).match(/^:chatgpt-content-reference\{index="\d{1,10}"\}/);
      if (marker) {
        count += 1;
        index += marker[0].length - 1;
        continue;
      }
    }
    const char = source[index];
    cleaned += char;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') {
      inString = true;
    }
  }
  return { cleaned, count };
}

function jsonErrorLocation(error, source) {
  const message = String(error?.message || '');
  const positionMatch = message.match(/(?:at\s+)?position\s+(\d+)/i);
  if (!positionMatch) return '';
  const position = Math.max(0, Math.min(Number(positionMatch[1]), source.length));
  if (!Number.isFinite(position)) return '';
  const before = source.slice(0, position);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  const column = position - lastNewline;
  return ` near line ${line}, column ${column}`;
}

// Diagnostics go into the application's bug-report event log. Keep them
// content-free: the response itself can contain a user's career details, job
// listings, or other private text. Location and shape are enough to distinguish
// a truncation from a serializer error without exporting any response fragment.
function jsonErrorMetadata(error, source) {
  const message = String(error?.message || '');
  const positionMatch = message.match(/(?:at\s+)?position\s+(\d+)/i);
  const length = source.length;
  if (!positionMatch) return `position=unknown length=${length}`;
  const position = Math.max(0, Math.min(Number(positionMatch[1]), length));
  if (!Number.isFinite(position)) return `position=unknown length=${length}`;
  const before = source.slice(0, position);
  const line = before.split('\n').length;
  const lastNewline = before.lastIndexOf('\n');
  const column = position - lastNewline;
  return `position=${position} line=${line} column=${column} length=${length}`;
}

function jsonParseErrorCategory(error) {
  const message = String(error?.message || '');
  if (/unexpected end/i.test(message)) return 'unexpected-end';
  if (/unterminated/i.test(message)) return 'unterminated-string';
  if (/expected/i.test(message)) return 'expected-structure';
  if (/unexpected token/i.test(message)) return 'unexpected-token';
  return 'parse-failure';
}

/**
 * Parse raw LLM response text into JSON, stripping markdown fences if present
 * and recovering from a handful of common malformations (trailing commas,
 * conversational prose wrapping the JSON, a stray bracket/brace in that prose
 * mis-anchoring the span). Handles both ```json and bare ``` wrappers.
 *
 * Despite living under a Gemini-sounding name for a while (parseGeminiJSON),
 * this parser is provider-agnostic: nonApiAi.js calls it on whatever text the
 * user pastes back from their own chosen chat application (Claude, Gemini,
 * ChatGPT, or anything else), not a specific provider's output. Relocated to
 * this neutral file so that isn't a readability trap for the next reader.
 */
export function parseAiJson(raw) {
  if (!raw) return null;

  // Resilient JSON extraction: Find the first code block or the outer-most { } pair.
  // This handles instances where the model adds markdown fences OR conversational text.
  let jsonStr = raw;
  // Prefer an explicitly-labelled JSON fence wherever it appears. The old
  // optional `json` token allowed any first fenced block (for example a prose
  // or shell example) to win, and it missed uppercase ```JSON labels. Only use
  // an unlabelled fence as the fallback; other language-labelled blocks are
  // not plausible response payloads.
  const match = raw.match(/```[ \t]*json\b[ \t]*(?:\r?\n)?([\s\S]*?)\s*```/i)
    || raw.match(/```[ \t]*\r?\n([\s\S]*?)\s*```/);
  if (match) {
    jsonStr = match[1];
  } else {
    // If no markdown block, try to find the first { or [ and the last } or ]
    const firstBrace = raw.indexOf('{');
    const firstBracket = raw.indexOf('[');
    const lastBrace = raw.lastIndexOf('}');
    const lastBracket = raw.lastIndexOf(']');

    let start = -1;
    let end = -1;

    if (firstBrace !== -1 && firstBracket !== -1) {
      start = Math.min(firstBrace, firstBracket);
    } else if (firstBrace !== -1) {
      start = firstBrace;
    } else if (firstBracket !== -1) {
      start = firstBracket;
    }

    if (lastBrace !== -1 && lastBracket !== -1) {
      end = Math.max(lastBrace, lastBracket);
    } else if (lastBrace !== -1) {
      end = lastBrace;
    } else if (lastBracket !== -1) {
      end = lastBracket;
    }

    if (start !== -1 && end !== -1 && end > start) {
      jsonStr = raw.substring(start, end + 1);
    }
  }

  // Clean structural trailing commas that V8's JSON.parse chokes on without
  // touching comma/brace text inside otherwise-valid JSON strings.
  jsonStr = removeStructuralTrailingCommas(jsonStr);

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return parsed;
  } catch (error) {
    // Do not alter a response that parsed successfully above. Only after a
    // strict parse failure may this known ChatGPT copy/paste artifact be
    // removed, then the complete payload is parsed strictly again. A failed
    // retry deliberately falls through to the ordinary fail-loud path so we do
    // not turn this into a generic unescaped-quote repairer.
    const artifactRepair = removeChatGptContentReferenceArtifacts(jsonStr);
    if (artifactRepair.count > 0) {
      try {
        const repaired = JSON.parse(artifactRepair.cleaned.trim());
        logger.info(`[jsonRepair] Recovered JSON after removing ${artifactRepair.count} ChatGPT content-reference transport artifact${artifactRepair.count === 1 ? '' : 's'}.`);
        return repaired;
      } catch { /* continue with the original syntax error and strict fallbacks */ }
    }
    // Strictly-additive fallback: the first-open/last-close span above can
    // mis-bracket when the model prefixes the JSON with prose that contains a
    // stray '{', '[', '}' or ']' (e.g. "use [ ] for arrays: {…}"), so it starts
    // the span at the stray delimiter and JSON.parse fails. Retry with a
    // brace-only then bracket-only span. This runs ONLY after the primary parse
    // already threw, so it can never regress a response that parsed cleanly.
    for (const [open, close] of [['{', '}'], ['[', ']']]) {
      const s = raw.indexOf(open);
      const e = raw.lastIndexOf(close);
      if (s !== -1 && e > s) {
        try {
          const recovered = JSON.parse(removeStructuralTrailingCommas(raw.substring(s, e + 1)).trim());
          // Reject a trivially-empty literal here. This loop runs ONLY after the
          // primary parse already failed (mis-bracketed prose), so an empty {}/[]
          // almost always came from a STRAY delimiter pair in the prose — e.g.
          // "use [ ] for arrays: {…}", where the bracket span grabs the prose's
          // "[ ]" and parses it to []. Returning that would silently fabricate an
          // empty result and mask the failure; fall through to the fail-loud throw.
          const isEmptyLiteral = recovered && typeof recovered === 'object'
            && (Array.isArray(recovered) ? recovered.length === 0 : Object.keys(recovered).length === 0);
          if (!isEmptyLiteral) return recovered;
        } catch { /* try the next delimiter pair, then fall through to the throw */ }
      }
    }
    logger.error(
      `[jsonRepair] Failed to parse JSON response: category=${jsonParseErrorCategory(error)} `
      + `${jsonErrorMetadata(error, jsonStr)} chatgptContentReferenceCandidates=${artifactRepair.count}.`,
    );
    const friendly = new Error(
      `AI returned invalid JSON${jsonErrorLocation(error, jsonStr)}. `
      + 'A text value may contain an unescaped double quote or line break, a comma may be missing, or the response may have been cut off. '
      + 'Regenerate the complete response as strict JSON and validate it before replying; no partial result was used.',
      { cause: error },
    );
    friendly.code = 'AI_JSON_INVALID';
    throw friendly;
  }
}
