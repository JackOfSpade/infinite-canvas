const MAX_PARSED_COLOR_CACHE_SIZE = 256;
const parsedColorCache = new Map();
let colorProbeContext = null;

function isVisibleColor(color) {
  let visible = true;
  try {
    if (typeof document === 'undefined') return visible;
    colorProbeContext ||= document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    if (colorProbeContext) {
      colorProbeContext.clearRect(0, 0, 1, 1);
      colorProbeContext.fillStyle = '#000000';
      colorProbeContext.fillStyle = color;
      colorProbeContext.fillRect(0, 0, 1, 1);
      visible = colorProbeContext.getImageData(0, 0, 1, 1).data[3] > 0;
    }
  } catch {
    // Validation already passed; keep rendering if the optional alpha probe is unavailable.
  }
  return visible;
}

function rememberParsedColor(color, parsed) {
  if (parsedColorCache.size >= MAX_PARSED_COLOR_CACHE_SIZE) {
    parsedColorCache.delete(parsedColorCache.keys().next().value);
  }
  parsedColorCache.set(color, parsed);
  return parsed;
}

export function parseStaticGlowColor(value) {
  if (typeof value !== 'string') return { valid: false, color: null };
  const color = value.trim();
  if (parsedColorCache.has(color)) return parsedColorCache.get(color);
  if (!color || color.toLowerCase() === 'transparent') {
    return rememberParsedColor(color, { valid: true, color: null });
  }
  if (/\b(?:var|env|attr)\s*\(/i.test(color)) {
    return rememberParsedColor(color, { valid: false, color: null });
  }

  // CSS.supports('color', ...) alone accepts CSS-wide keywords such as
  // "inherit", but those are invalid inside color-mix() and would invalidate
  // the reminder's entire animated box-shadow.
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return { valid: false, color: null };
  if (!CSS.supports('color', color)) {
    return rememberParsedColor(color, { valid: false, color: null });
  }
  if (!CSS.supports('color', `color-mix(in srgb, ${color} 35%, transparent)`)) {
    return rememberParsedColor(color, { valid: false, color: null });
  }
  return rememberParsedColor(color, { valid: true, color: isVisibleColor(color) ? color : null });
}

/**
 * Return a trimmed color that is safe and visible in the listing glow, or null.
 */
export function normalizeStaticGlowColor(value) {
  return parseStaticGlowColor(value).color;
}
