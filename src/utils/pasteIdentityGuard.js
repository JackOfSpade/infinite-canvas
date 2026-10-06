/**
 * Guards against a pasted AI response landing in the wrong AI handoff dock
 * prompt (src/components/NonApiAiDialog.jsx).
 *
 * The dock juggles up to the shared handoff-concurrency limit of scoring prompts and
 * APPLICATION_HANDOFF_LIMIT application bundles side by side, each with its
 * own textarea. A person can paste into the wrong one — a chat-tab mix-up, a
 * stale clipboard, or simply re-pasting the same answer while retrying a
 * stalled AI session — and the two protocols this dock speaks (see
 * applicationHandoffDock.js's header for why there are two) each stamp a
 * different kind of identity into the response text: a PUSH/scoring answer
 * echoes `HANDOFF-XXXXXX` as a header line or `handoffCode` JSON property; an
 * APPLICATION bundle answer is a JSON object carrying `jobId`/`handoffCode`/
 * `stage` at its top level.
 *
 * Everything here is pure: it reads text and the small plain-object shapes
 * the dock already holds in React state, and returns a verdict for the dock
 * to render. It never touches IPC, disk, or the DOM, and it must never throw
 * — a crash here would take the whole dock down mid-paste.
 */

// Short answers ("Done.", "Yes, proceed") are legitimately repeatable across
// unrelated prompts, so anything shorter is never fingerprinted at all —
// there is no length at which a short answer's repetition is evidence of
// anything.
export const DUPLICATE_RESPONSE_MIN_CHARS = 400;

/**
 * Collapse every newline convention to `\n` and trim the ends. Pasted text
 * can arrive with CRLF (a Windows-side AI client) or a lone CR (an old
 * clipboard path some managers still emit); leaving either in place would
 * fingerprint semantically-identical text differently depending on which
 * machine produced it.
 */
export function normalizePastedResponse(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
}

// cyrb53: a cheap, well-distributed 53-bit non-cryptographic hash. Good
// enough here because the fingerprint only ever guards against this dock
// accidentally re-submitting its OWN prior text, never an adversarial
// collision — and it runs on every keystroke, so anything cryptographic
// would be wasted work.
function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * A stable identity for a pasted response, or '' when the text is too short
 * to fingerprint (see DUPLICATE_RESPONSE_MIN_CHARS).
 *
 * The normalized LENGTH is appended after the hash so a bare 53-bit
 * collision between two different long texts cannot, on its own, read as a
 * duplicate submission.
 */
export function responseFingerprint(text) {
  const normalized = normalizePastedResponse(text);
  if (normalized.length < DUPLICATE_RESPONSE_MIN_CHARS) return '';
  return `${cyrb53(normalized).toString(16)}-${normalized.length}`;
}

// Bounds how many characters a captured JSON string value may span. This is
// not merely a length check applied after matching — the bound lives INSIDE
// the character class, so a value longer than this has no closing quote
// within reach and the regex simply fails to match at all. That is what
// "an over-long value is rejected" means for this function: bounded, not
// truncated.
const ENVELOPE_VALUE_MAX_CHARS = 200;

/**
 * The first JSON-string value of `key` in `text`, or null.
 *
 * Deliberately not JSON.parse: a pasted response can run 30k+ characters and
 * this runs on every keystroke, so a bounded, single-pass regex stands in
 * for a real parse. Both the canonical double-quoted JSON form and a
 * single-quoted variant are matched, in one alternation, so whichever
 * appears first in the text wins regardless of which style produced it.
 *
 * The regex is constructed fresh on every call rather than hoisted to a
 * shared module-level constant. This particular pattern carries no /g flag,
 * so it does not actually need that to stay correct — but every regex in
 * this module is built the same way, on principle: a /g regex reused across
 * calls carries its lastIndex forward and silently skips matches on the next
 * call, which is the exact trap documented next to findMismatchedHandoffStamp
 * in NonApiAiDialog.jsx. Keeping one rule with no carve-outs is cheaper than
 * remembering which regexes in a file are the safe ones.
 */
function firstJsonStringField(text, key) {
  const pattern = new RegExp(
    `"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\]){0,${ENVELOPE_VALUE_MAX_CHARS}})"`
    + `|'${key}'\\s*:\\s*'((?:\\\\.|[^'\\\\]){0,${ENVELOPE_VALUE_MAX_CHARS}})'`,
  );
  const match = pattern.exec(text);
  if (!match) return null;
  const raw = match[1] !== undefined ? match[1] : match[2];
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value ? value : null;
}

/**
 * Pull whatever identity markers a pasted response carries, checking for
 * both protocols at once — the dock does not know which one it is holding
 * until it compares the result against the active prompt.
 */
export function extractPasteEnvelopeIdentity(text) {
  const source = typeof text === 'string' ? text : '';
  const jobId = firstJsonStringField(source, 'jobId');
  const handoffCode = firstJsonStringField(source, 'handoffCode');
  const stage = firstJsonStringField(source, 'stage');
  // Built fresh here too, for the reason above: a /g regex hoisted to module
  // scope would carry its lastIndex from the previous call and silently miss
  // stamps on this one.
  const pushStampPattern = /\bHANDOFF-[2-9A-HJ-NP-Z]{6}\b/gi;
  const pushStamps = [...new Set((source.match(pushStampPattern) || []).map((stamp) => stamp.toUpperCase()))];
  return { jobId, handoffCode, stage, pushStamps };
}

/**
 * Whether a pasted response belongs to a DIFFERENT prompt still in the dock,
 * or duplicates a response this session already spent. Returns
 * `{ block, notice }`; the dock must stop the submit for a `block` and must
 * NOT stop it for a `notice` — see the module doc comment above and the
 * Conflict shape in the caller's spec for what each field means.
 *
 * `activeRequest`: the prompt the text was pasted into,
 *   `{ requestId, handoffCode, jobId, kind }` (any field may be missing).
 * `queuedRequests`: every prompt currently in the dock queue, INCLUDING the
 *   active one, in the same shape.
 * `priorSubmissions`: responses this dock has already submitted this
 *   session, newest last:
 *   `{ fingerprint, requestId, handoffCode, jobId, label, accepted }`.
 */
export function assessPastedResponse({ response, activeRequest, queuedRequests, priorSubmissions } = {}) {
  const text = typeof response === 'string' ? response : '';
  if (!text.trim() || !activeRequest) return { block: null, notice: null };

  const queued = Array.isArray(queuedRequests) ? queuedRequests.filter(Boolean) : [];
  const priors = Array.isArray(priorSubmissions) ? priorSubmissions.filter(Boolean) : [];
  const activeRequestId = activeRequest.requestId ?? null;
  const isOtherQueued = (request) => Boolean(request) && request.requestId !== activeRequestId;

  // Rule 2: ENVELOPE OWNERSHIP. A conflict here must only ever point at a
  // value that is ALREADY IN THE QUEUE — never inferred from a value merely
  // looking different from the active prompt's own. A wrong block traps the
  // person with no escape, so this has to be conclusive.
  const identity = extractPasteEnvelopeIdentity(text);

  if (identity.handoffCode) {
    const owner = queued.find((request) => isOtherQueued(request) && request.handoffCode === identity.handoffCode);
    if (owner) {
      return {
        block: {
          reason: 'other-queued-prompt',
          ownerRequestId: owner.requestId ?? null,
          ownerLabel: null,
          detail: `carries handoff code ${identity.handoffCode}`,
        },
        notice: null,
      };
    }
  }

  if (identity.jobId && identity.jobId !== activeRequest.jobId) {
    const owner = queued.find((request) => isOtherQueued(request) && request.jobId === identity.jobId);
    if (owner) {
      return {
        block: {
          reason: 'other-queued-prompt',
          ownerRequestId: owner.requestId ?? null,
          ownerLabel: null,
          detail: `carries job id ${identity.jobId}`,
        },
        notice: null,
      };
    }
  }

  for (const stamp of identity.pushStamps) {
    const owner = queued.find((request) => isOtherQueued(request) && request.handoffCode === stamp);
    if (owner) {
      return {
        block: {
          reason: 'other-queued-prompt',
          ownerRequestId: owner.requestId ?? null,
          ownerLabel: null,
          detail: `carries handoff code ${stamp}`,
        },
        notice: null,
      };
    }
  }

  // Rule 3/4: DUPLICATE CONTENT.
  const fingerprint = responseFingerprint(text);
  if (fingerprint) {
    let ownRepeat = null;
    for (const submission of priors) {
      if (submission.fingerprint !== fingerprint) continue;
      if (submission.requestId === activeRequestId) {
        // Rule 4 (notice, never blocks): re-sending identical text under a
        // rotated handoff code is a documented legitimate repair. Every
        // matching entry counts here regardless of `accepted` — a repeat of
        // one's own REJECTED text is exactly the case this notice exists for.
        ownRepeat = ownRepeat || submission;
        continue;
      }
      // Rule 3 (block) may only fire on an entry that was ACCEPTED somewhere
      // else. A response rejected for prompt 1 because it was actually
      // prompt 2's answer is legitimately re-pasted into prompt 2 — that is
      // the correct repair, and blocking it would strand the person holding
      // the right answer with no way to submit it.
      if (submission.accepted !== true) continue;
      // And even an accepted entry only blocks when it can be proven to be a
      // DIFFERENT logical prompt: a stepped-back or reissued request can
      // carry a new requestId for the same question, so the handoff codes
      // must also differ — with either side's code missing read as "cannot
      // prove they differ", not as a difference.
      const priorCode = submission.handoffCode;
      const activeCode = activeRequest.handoffCode;
      const codesConclusivelyDiffer = Boolean(priorCode) && Boolean(activeCode) && priorCode !== activeCode;
      if (!codesConclusivelyDiffer) continue;
      const stillQueued = queued.find((request) => request.requestId === submission.requestId);
      return {
        block: {
          reason: 'already-submitted',
          ownerRequestId: stillQueued ? stillQueued.requestId : null,
          ownerLabel: stillQueued ? null : (submission.label ?? null),
          detail: `matches a response already submitted${submission.label ? ` for ${submission.label}` : ''}`,
        },
        notice: null,
      };
    }
    if (ownRepeat) {
      return {
        block: null,
        notice: {
          reason: 'repeat-of-own-rejected',
          ownerRequestId: activeRequestId,
          ownerLabel: ownRepeat.label ?? null,
          detail: 'matches the text already submitted for this prompt',
        },
      };
    }
  }

  return { block: null, notice: null };
}
