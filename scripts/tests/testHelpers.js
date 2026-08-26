

import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function runExtractorFixtureTest({ name, file, extractor, minCount = 1, sampleAssert = null }) {
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
    assert(result.length >= minCount, `${name}: expected at least ${minCount} result(s), got ${result.length}`);
    if (sampleAssert) sampleAssert(result[0], result);
    return { count: result.length, sample: result[0] };
  } finally {
    dom.window.close();
  }
}

export function runZeroResultFixtureTest({ name, file, extractor }) {
  const html = fs.readFileSync(path.resolve(file), 'utf8');
  const dom = new JSDOM(html, {
    url: 'https://example.com',
    runScripts: 'outside-only',
  });
  try {
    const raw = dom.window.eval(extractor);
    const result = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : raw);
    assert(Array.isArray(result), `${name}: extractor did not return an array (or { items })`);
    assert(result.length === 0, `${name}: expected 0 results, got ${result.length}`);
    return { count: result.length };
  } finally {
    dom.window.close();
  }
}
