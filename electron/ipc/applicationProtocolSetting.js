export const V2_APPLICATION_PROTOCOL_SETTING = 'write-then-verify.v2';

// Every stored or requested value maps to the one protocol left, so callers may
// pass whatever they hold; the argument is ignored by design.
export function applicationProtocolSetting() {
  return V2_APPLICATION_PROTOCOL_SETTING;
}
