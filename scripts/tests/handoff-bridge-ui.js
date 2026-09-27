import { assert } from './testHelpers.js';
import fs from 'node:fs';
import { isValidHostname, isValidPluginName, isValidSocketPath } from '../../src/utils/handoffBridgeConfig.js';

const configUrl = new URL('../../src/utils/handoffBridgeConfig.js', import.meta.url);
const IMPORT_SYNTAX = /\bimport(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*(?:\(|['"{*A-Za-z_$])/;

export default [{
  name: 'handoff bridge: ui: shared setup validators are import-free and reject hostile input',
  run: () => {
    const preload = {};
    assert(preload.handoffBridgeGetStatus === undefined, 'the UI must tolerate a preload without bridge keys');
    assert(isValidHostname('b-0123456789abcdef0123.lullascape.com'), 'the production hostname shape must be accepted');
    for (const hostile of ['example.com', 'Bridge.example.com', 'bridge.example.com.', '127.0.0.1', 'bridge..example.com', 'bridge:443.example.com', 'bridge\n.example.com', 'bráce.example.com', 'xn--brce-6pa.example.com']) {
      assert(!isValidHostname(hostile), `hostname validator must reject ${JSON.stringify(hostile)}`);
    }
    for (const hostile of ['bad\nplugin', 'bad{plugin}', 'bad"plugin', '..']) {
      assert(!isValidPluginName(hostile), `plugin validator must reject ${JSON.stringify(hostile)}`);
    }
    assert(isValidPluginName('Infinite Canvas'), 'safe plugin names must remain accepted');
    assert(isValidSocketPath('/Users/ada/Library/Application Support/infinite-canvas/handoff-bridge/b.sock'), 'real Application Support socket paths with a space must be accepted');
    for (const hostile of ['relative/b.sock', '/tmp/../b.sock', '/tmp/a\n.sock', '/tmp/a:1.sock', '/tmp/a{b}.sock', '/tmp/a"b.sock', '/tmp/é.sock', `/tmp/${'x'.repeat(96)}.sock`]) {
      assert(!isValidSocketPath(hostile), `socket validator must reject ${JSON.stringify(hostile)}`);
    }
    const source = fs.readFileSync(configUrl, 'utf8');
    assert(IMPORT_SYNTAX.test("import/* split */ { readFile } from 'node:fs';"), 'zero-import scan must recognize comment-separated import syntax');
    assert(!IMPORT_SYNTAX.test(source), 'shared configuration must have zero imports');
  },
}];
