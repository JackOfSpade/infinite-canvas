import { PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

const emojiSequence = /^(?:\p{RGI_Emoji})+$/v;

function unicodeFromHex(hex) {
  if (!/^(?:[0-9a-f]{4})+$/i.test(hex)) return '';
  return String.fromCharCode(...hex.match(/.{4}/g).map(unit => parseInt(unit, 16)));
}

// Chromium's macOS color-emoji subset is necessarily Type 3, even after all
// prose faces switch to system fonts. Its ToUnicode map preserves emoji text.
// Allow only that known font and only explicit emoji mappings; never exempt a
// prose font, missing/malformed map, or an unfamiliar CMap representation.
export function isExtractableColorEmojiFont(font) {
  try {
    const descriptor = font.lookup(PDFName.of('FontDescriptor'));
    if (!(descriptor instanceof PDFDict)) return false;
    const name = descriptor.lookup(PDFName.of('FontName'));
    if (!(name instanceof PDFName) || !/^(?:[A-Z]{6}\+)?AppleColorEmoji$/.test(name.decodeText())) return false;
    const stream = font.lookup(PDFName.of('ToUnicode'));
    if (!(stream instanceof PDFRawStream)) return false;
    const cmap = Buffer.from(decodePDFRawStream(stream).decode()).toString('ascii');
    const mappings = new Map();
    const add = (code, hex) => {
      const text = unicodeFromHex(hex);
      if (!emojiSequence.test(text) || mappings.has(code)) throw new Error('Invalid emoji mapping');
      mappings.set(code, text);
    };
    let blocks = 0;
    const remainder = cmap.replace(/(\d+)\s+beginbf(char|range)([\s\S]*?)endbf\2/g, (_, count, kind, body) => {
      blocks += 1;
      let rows = 0;
      const residue = body.replace(kind === 'char'
        ? /<([\da-f]{2})>\s*<([\da-f]+)>/gi
        : /<([\da-f]{2})>\s*<([\da-f]{2})>\s*<([\da-f]+)>/gi,
      (_row, first, second, third) => {
        rows += 1;
        const start = parseInt(first, 16);
        if (kind === 'char') add(start, second);
        else {
          const end = parseInt(second, 16);
          if (end < start || third.length > 8) throw new Error('Invalid emoji range');
          const base = parseInt(third, 16);
          for (let code = start; code <= end; code += 1) {
            add(code, (base + code - start).toString(16).padStart(third.length, '0'));
          }
        }
        return '';
      });
      if (residue.trim() || rows !== Number(count)) throw new Error('Invalid emoji CMap');
      return '';
    });
    if (!blocks || !mappings.size || /beginbf|usecmap|beginnotdef/i.test(remainder)) return false;
    // A .notdef glyph at code zero is normal. Every other drawable glyph must
    // have a mapping, so an incomplete map cannot silently lose PDF text.
    const encoding = font.lookup(PDFName.of('Encoding'));
    const differences = encoding?.lookup(PDFName.of('Differences'));
    const procs = font.lookup(PDFName.of('CharProcs'));
    if (!differences || !(procs instanceof PDFDict)) return false;
    let code = null;
    let drawableMappings = 0;
    for (const item of differences.asArray()) {
      if (typeof item.asNumber === 'function') code = item.asNumber();
      else {
        if (!(item instanceof PDFName) || code === null) return false;
        if (item.decodeText() !== 'g0' && (!mappings.has(code) || !procs.has(item))) return false;
        if (item.decodeText() !== 'g0') drawableMappings += 1;
        code += 1;
      }
    }
    return drawableMappings > 0;
  } catch {
    return false;
  }
}

export function pdfDocContainsUnsafeType3Fonts(pdf) {
  return pdf.context.enumerateIndirectObjects().some(([, object]) =>
    object instanceof PDFDict && object.get(PDFName.of('Subtype')) === PDFName.of('Type3')
    && !isExtractableColorEmojiFont(object));
}
