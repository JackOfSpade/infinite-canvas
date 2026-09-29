

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { JSDOM } from 'jsdom';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Shared body of the fixture helpers. `assertResult` runs while the JSDOM
// window is still open, so a caller's sample assertions can still reach it.
function evalFixtureExtractor({ name, file, extractor }, assertResult) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  try {
    // Extractors return either a bare array or { items, yieldStats } — mirror
    // the browserPool unwrap so the fixture asserts on the items array.
    const raw = dom.window.eval(extractor);
    const result = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : raw);
    assert(Array.isArray(result), `${name}: extractor did not return an array (or { items })`);
    assertResult(result);
    return { count: result.length, sample: result[0] };
  } finally {
    dom.window.close();
  }
}

export function runExtractorFixtureTest({ name, file, extractor, minCount = 1, sampleAssert = null }) {
  return evalFixtureExtractor({ name, file, extractor }, result => {
    assert(result.length >= minCount, `${name}: expected at least ${minCount} result(s), got ${result.length}`);
    if (sampleAssert) sampleAssert(result[0], result);
  });
}

export function runZeroResultFixtureTest({ name, file, extractor }) {
  const { count } = evalFixtureExtractor({ name, file, extractor }, result => {
    assert(result.length === 0, `${name}: expected 0 results, got ${result.length}`);
  });
  return { count };
}

// ---- DOCX fixtures (hand-built ZIP + WordprocessingML) ------------------------------
// Used by the career-file reader tests. Deliberately dependency-free so a fixture is
// exactly the bytes the test says it is.
/** Minimal ZIP writer. options: { packageRels = true } adds the standard _rels/.rels to a package that has word/document.xml but no _rels/.rels. entries: { name, data, method = 8, flags = 0, deflate }. `deflate` compresses the data even under a method other than 8. */
export function zipOf(entries, { packageRels = true } = {}) {
  // A package that holds a main document part but no package relationships is not one Word opens, and the career-file reader
  // (rightly) defers on it, so a fixture that means to be a readable .docx gets the standard relationship unless it brings its own
  // (or passes { packageRels: false } to be the package that has none).
  if (packageRels && entries.some(entry => entry.name === 'word/document.xml') && !entries.some(entry => entry.name === '_rels/.rels')) {
    entries = [{ name: '_rels/.rels', data: officePackageRels() }, ...entries];
  }
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, method = 8, flags = 0, deflate = method === 8 } of entries) {
    const raw = Buffer.from(data);
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, body);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

export const WORD_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
export const WORD_NS_FULL = `${WORD_NS} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** The package-level _rels/.rels part: one officeDocument relationship to `target`. */
export const officePackageRels = (target = 'word/document.xml') => `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="${target}"/></Relationships>`;

/** A document.xml part around a body. */
export const wordDocument = (body, namespaces = WORD_NS_FULL) => `<?xml version="1.0"?><w:document ${namespaces}><w:body>${body}</w:body></w:document>`;
/** One run; rPr is the inner XML of its w:rPr. */
export const wordRun = (text, rPr = '') => `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${text}</w:t></w:r>`;
/** One paragraph of runs (strings are wrapped as plain runs); pPr is the inner XML of its w:pPr. */
export const wordPara = (content, pPr = '') => `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${typeof content === 'string' && !content.startsWith('<') ? wordRun(content) : content}</w:p>`;
/** A table: rows of cells; a cell is a string (one paragraph) or an array of strings (several). */
export const wordTable = rows => `<w:tbl><w:tblPr/><w:tblGrid/>${rows.map(row => `<w:tr>${row.map(cell => `<w:tc><w:tcPr/>${[].concat(cell).map(text => wordPara(text)).join('')}</w:tc>`).join('')}</w:tr>`).join('')}</w:tbl>`;
/** A .docx from a body plus any extra parts ({ name, data, method?, flags? }). */
export const docxFrom = (body, extra = [], namespaces = WORD_NS_FULL) => zipOf([{ name: 'word/document.xml', data: wordDocument(body, namespaces) }, ...extra]);
/** numbering.xml with one abstract definition at level 0 (numId 5 -> abstract 0). */
export const wordNumbering = format => `<w:numbering ${WORD_NS}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="${format}"/></w:lvl></w:abstractNum><w:num w:numId="5"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;
