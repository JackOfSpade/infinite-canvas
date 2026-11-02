// Application protocol v2 limits: operational caps for a single prompt and
// reply. 250,000 characters keeps headroom under the 300,000 characters
// that were measured to travel intact.
export const APPLICATION_V2_LIMITS = Object.freeze({
  requestBytes: 2 * 1024 * 1024,
  toolResultBytes: 8 * 1024 * 1024,
  toolTextBytes: 2 * 1024 * 1024,
  chatPromptChars: 250_000,
});

export class ApplicationV2LimitError extends Error {
  constructor(kind, measured, limit) {
    super(`Application v2 ${kind} is ${measured}; limit ${limit}. The complete hand is retained and this handoff cannot proceed.`);
    this.name = 'ApplicationV2LimitError';
    this.code = 'APPLICATION_V2_LIMIT';
    this.kind = kind;
    this.measured = measured;
    this.limit = limit;
  }
}

export function assertApplicationV2PromptLimit(prompt) {
  const chars = prompt.length;
  if (chars > APPLICATION_V2_LIMITS.chatPromptChars) throw new ApplicationV2LimitError('prompt characters', chars, APPLICATION_V2_LIMITS.chatPromptChars);
  const bytes = Buffer.byteLength(prompt, 'utf8');
  // Reserve 128 KiB for the result frame and status metadata.
  const transportBudget = APPLICATION_V2_LIMITS.toolTextBytes - 128 * 1024;
  if (bytes > transportBudget) throw new ApplicationV2LimitError('tool-result bytes', bytes, transportBudget);
  return { chars, bytes };
}

export function assertApplicationV2ReplyLimit(reply) {
  const bytes = Buffer.byteLength(reply, 'utf8');
  // Reserve 128 KiB for the reply request frame.
  const transportBudget = APPLICATION_V2_LIMITS.requestBytes - 128 * 1024;
  if (bytes > transportBudget) throw new ApplicationV2LimitError('request bytes', bytes, transportBudget);
  return bytes;
}
