import { logger } from '../logger.js';

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
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
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

  // Clean trailing commas that V8's JSON.parse chokes on
  jsonStr = jsonStr.replace(/,\s*([}\]])/g, '$1');

  try {
    const parsed = JSON.parse(jsonStr.trim());
    return parsed;
  } catch (error) {
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
          const recovered = JSON.parse(raw.substring(s, e + 1).replace(/,\s*([}\]])/g, '$1').trim());
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
    // Log a window AROUND the failure position, not the head of the doc.
    // V8's JSON.parse error messages include "at position N" — pull that
    // out and dump ±200 chars so bug reports show the actual malformed
    // syntax instead of valid prelude that gets truncated by the ring
    // buffer before the error site is reached.
    const posMatch = String(error.message || '').match(/at position (\d+)/);
    let context = '';
    if (posMatch) {
      const pos = Number(posMatch[1]);
      const start = Math.max(0, pos - 200);
      const end = Math.min(jsonStr.length, pos + 200);
      const before = jsonStr.slice(start, pos);
      const after = jsonStr.slice(pos, end);
      context = `\nContext (±200 chars around pos ${pos}, length=${jsonStr.length}):\n${before}«ERROR HERE»${after}`;
    } else {
      context = `\nRaw (length=${jsonStr.length}):\n${jsonStr.slice(0, 1000)}${jsonStr.length > 1000 ? '\n…[truncated]' : ''}`;
    }
    logger.error('[jsonRepair] Failed to parse JSON response:', error.message, context);
    throw new Error(`AI returned invalid JSON: ${error.message}`);
  }
}
