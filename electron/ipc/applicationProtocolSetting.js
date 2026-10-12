export const LEGACY_APPLICATION_PROTOCOL_SETTING = 'legacy';
export const V2_APPLICATION_PROTOCOL_SETTING = 'write-then-verify.v2';

export function applicationProtocolSetting(value) {
  return value === LEGACY_APPLICATION_PROTOCOL_SETTING
    ? LEGACY_APPLICATION_PROTOCOL_SETTING : V2_APPLICATION_PROTOCOL_SETTING;
}
