// Application protocol v2 limits. The transport caps are hard bridge limits.
// ChatGPT's 16,384-token output cap is documented. The live synthetic bridge
// checksum ramp delivered and answered 300,000 characters intact (measurement:
// .test-artifacts/blackbox-run/live-one-card/redesign-evidence/panel-runs/
// write-then-verify-v2-ruling2-raw/bridge-ramp/result.json). 250,000 keeps
// 50,000 headroom.
export const APPLICATION_V2_LIMITS = Object.freeze({
  bridgeRequestBytes: 2 * 1024 * 1024,
  bridgeToolResultBytes: 2 * 1024 * 1024,
  chatReplyTokens: 16_384,
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
  // Reserve 128 KiB for the MCP result frame and status metadata.
  const transportBudget = APPLICATION_V2_LIMITS.bridgeToolResultBytes - 128 * 1024;
  if (bytes > transportBudget) throw new ApplicationV2LimitError('tool-result bytes', bytes, transportBudget);
  return { chars, bytes };
}

export function assertApplicationV2ReplyLimit(reply) {
  const bytes = Buffer.byteLength(reply, 'utf8');
  // Reserve 128 KiB for the submit_handoff request frame.
  const transportBudget = APPLICATION_V2_LIMITS.bridgeRequestBytes - 128 * 1024;
  if (bytes > transportBudget) throw new ApplicationV2LimitError('request bytes', bytes, transportBudget);
  return bytes;
}
