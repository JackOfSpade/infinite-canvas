export function isAppleEventsJsDisabledError(msg) {
  const value = String(msg || '');
  return /JavaScript through AppleScript is turned off/i.test(value)
    || /Allow JavaScript from Apple Events/i.test(value)
    || /Executing JavaScript through AppleScript/i.test(value);
}
