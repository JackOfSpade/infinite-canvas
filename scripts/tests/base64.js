import assert from 'node:assert/strict';
import { isBase64Text } from '../../electron/utils/base64.js';

export default [{
  name: 'base64 validation preserves padded and unpadded text and rejects misplaced padding',
  run() {
    for (const value of ['AA', 'AAA=', 'AA==', 'aA09+/', 'AAAA']) assert.equal(isBase64Text(value), true, value);
    for (const value of ['', null, undefined, 123, '=', '==', 'AAA===', 'A=AA', 'AA=A', 'AA\n', 'AA ', 'AA_/', 'éAAA']) {
      assert.equal(isBase64Text(value), false, String(value));
    }
  },
}, {
  name: 'base64 validation handles multi-megabyte boundary payloads with bounded stack',
  run() {
    const body = 'a'.repeat(8 * 1024 * 1024);
    assert.equal(isBase64Text(body), true);
    assert.equal(isBase64Text(`${body}==`), true);
    assert.equal(isBase64Text(`${body}!`), false);
    assert.equal(isBase64Text(`${body}=a`), false);
  },
}, {
  name: 'base64 validation matches the retained text grammar across generated short inputs',
  run() {
    const alphabet = 'Aa09+/= !';
    const oldGrammar = /^[A-Za-z0-9+/]+={0,2}$/u;
    const check = (prefix, depth) => {
      assert.equal(isBase64Text(prefix), oldGrammar.test(prefix), JSON.stringify(prefix));
      if (depth === 0) return;
      for (const character of alphabet) check(prefix + character, depth - 1);
    };
    check('', 4);
  },
}];
