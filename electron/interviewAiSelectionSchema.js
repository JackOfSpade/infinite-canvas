/** Shared wire contract for every live interview selection transport. */
export const INTERVIEW_AI_MATCH_SCHEMA = Object.freeze({
  type: 'object', additionalProperties: false,
  required: ['kind', 'cardId', 'confidence'],
  properties: {
    kind: { type: 'string', enum: ['question', 'follow-up', 'not-question'] },
    cardId: { type: 'string', minLength: 1, maxLength: 64 },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
});
