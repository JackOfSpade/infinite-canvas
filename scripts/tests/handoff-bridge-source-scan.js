import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './testHelpers.js';

const bridgeRoot = new URL('../../electron/ipc/handoffBridge/', import.meta.url);
const PRE_AUTH_FILES = new Set([
  'constants.js', 'http.js', 'mcp.js', 'tools.js', 'oauth.js', 'oauthPages.js', 'clientAuth.js', 'respond.js', 'wire.js',
]);
const PRE_AUTH_FORBIDDEN_IMPORTS = new Set([
  'node:fs', 'node:path', 'node:os', 'node:child_process', 'node:vm', 'node:worker_threads', 'electron', './log.js', './audit.js',
]);
const GENERIC_FORBIDDEN = Object.freeze([
  ['dynamic evaluation', /\beval\b(?:['"]\s*\])?\s*\(/],
  ['Function constructor', /\bFunction\b(?:['"]\s*\])?\s*\(/],
  ['function-constructor alias', /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:(?:globalThis|global|window)\s*(?:\.\s*|\[\s*['"]))?(?:Function|eval)\b/],
  ['constructor call', /\.\s*constructor\s*\(/],
  ['require', /\brequire\b(?:['"]\s*\])?\s*\(/],
  ['process.getBuiltinModule', /\bgetBuiltinModule\b(?:['"]\s*\])?\s*\(/],
  ['createRequire', /\bcreateRequire\b(?:['"]\s*\])?\s*\(/],
  ['process.binding', /\bbinding\b(?:['"]\s*\])?\s*\(/],
  ['dynamic-loader property', /['"](?:Function|eval|require|getBuiltinModule|createRequire|binding|constructor)['"]/],
  ['dynamic-loader member access', /\.\s*(?:Function|eval|require|getBuiltinModule|createRequire|binding)\b/],
  ['dynamic global property access', /\b(?:globalThis|global|window|process|module)\s*\[/],
]);
const TUNNEL_FORBIDDEN = [
  '--token', '--token-file', '--credentials-contents', 'TUNNEL_TOKEN', '--pidfile', '--origincert', '--url', '--hello-world', '--unix-socket',
];

const allBridgeSiblings = [
  './constants.js', './contracts.js', './respond.js', './wire.js', './http.js', './listener.js', './tools.js', './mcp.js',
  './oauth.js', './oauthPages.js', './clientAuth.js', './cimd.js', './egressProbe.js', './oauthStore.js', './store.js',
  './laneStore.js', './engine.js', './lanes.js', './preflight.js', './framing.js', './errors.js', './audit.js', './log.js',
  './telemetry.js', './controller.js', './pairing.js', './ui.js', './uiDialogs.js', './tray.js', './power.js', './index.js',
];
const sibling = (...imports) => [...imports, ...allBridgeSiblings];

// B0 owns this complete table. Rows for later-stage modules deliberately exist
// before their files do; an absent row is skipped, an unlisted file is fatal.
export const SOURCE_SCAN_ROWS = Object.freeze({
  'constants.js': { allow: [] },
  'contracts.js': { allow: [] },
  'respond.js': { allow: sibling('node:crypto', 'node:net', 'node:util') },
  'wire.js': { allow: sibling('node:crypto', 'node:net', 'node:util') },
  'http.js': { allow: sibling('node:crypto', 'node:net', 'node:util') },
  'listener.js': { allow: ['node:http', 'node:net', 'node:fs', 'node:path'] },
  'tools.js': { allow: sibling('node:crypto', '../../../src/utils/handoffBridgeConfig.js') },
  'mcp.js': { allow: sibling('node:crypto') },
  'oauth.js': { allow: sibling('node:crypto') },
  'oauthPages.js': { allow: sibling('node:crypto') },
  'clientAuth.js': { allow: sibling('node:crypto') },
  'cimd.js': { allow: ['node:https', 'node:dns', 'node:net', 'node:crypto'] },
  'egressProbe.js': { allow: ['node:https', 'node:dns', 'node:crypto', './cimd.js'] },
  'oauthStore.js': { allow: ['node:fs', 'node:path', 'node:crypto'] },
  'store.js': { allow: ['node:fs', 'node:path', 'node:crypto', '../../../src/utils/handoffBridgeConfig.js'] },
  'laneStore.js': { allow: ['node:fs', 'node:path', 'node:crypto'] },
  'engine.js': { allow: sibling('node:crypto') },
  'lanes.js': { allow: sibling('node:crypto') },
  'preflight.js': { allow: sibling('node:crypto', '../../../src/utils/pasteIdentityGuard.js') },
  'framing.js': { allow: sibling('node:crypto', '../../../src/utils/pasteIdentityGuard.js') },
  'errors.js': { allow: sibling('node:crypto') },
  'audit.js': { allow: ['node:fs', 'node:path', 'node:crypto', '../logger.js'] },
  'log.js': { allow: ['../logger.js'] },
  'telemetry.js': { allow: ['node:crypto', '../logger.js'] },
  'sources/application.js': { allow: ['../../localAiApplication.js'] },
  'sources/push.js': { allow: ['../../nonApiAi.js', '../../ipcUtils.js'] },
  'controller.js': { allow: sibling('node:crypto') },
  'pairing.js': { allow: sibling('node:crypto') },
  'ui.js': { allow: sibling('electron') },
  'uiDialogs.js': { allow: sibling('electron') },
  'tray.js': { allow: sibling('electron') },
  'power.js': { allow: sibling('electron') },
  'index.js': { allow: sibling('electron', 'node:fs', 'node:path', 'node:os', 'node:http', 'node:crypto', '../../../src/utils/handoffBridgeConfig.js', './sources/application.js', './sources/push.js', './tunnel/index.js', '../bugReport/helpers.js') },
  'tunnel/constants.js': { allow: [] },
  'tunnel/validate.js': { allow: ['../../../../src/utils/handoffBridgeConfig.js', '../constants.js', './constants.js'] },
  'tunnel/config.js': { allow: ['./constants.js', './validate.js'] },
  'tunnel/redact.js': { allow: ['./constants.js'] },
  'tunnel/logRing.js': { allow: ['./constants.js'] },
  'tunnel/classify.js': { allow: ['./constants.js'] },
  'tunnel/psParse.js': { allow: ['./constants.js'] },
  'tunnel/files.js': { allow: ['node:fs', 'node:path', 'node:crypto', '../constants.js', './constants.js', './validate.js'] },
  'tunnel/binary.js': { allow: ['node:fs', 'node:path', 'node:crypto', './constants.js', './files.js', './validate.js'] },
  'tunnel/credentials.js': { allow: ['node:fs', 'node:path', 'node:crypto', './constants.js', './files.js', './validate.js'] },
  'tunnel/exec.js': { allow: ['node:child_process', 'node:fs', 'node:path', './constants.js', './redact.js'] },
  'tunnel/reap.js': { allow: ['node:fs', 'node:path', './constants.js', './exec.js', './psParse.js'] },
  'tunnel/probe.js': { allow: ['node:net', './constants.js', './classify.js'] },
  'tunnel/supervisor.js': { allow: ['node:crypto', './constants.js', './config.js', './files.js', './binary.js', './credentials.js', './exec.js', './reap.js', './probe.js', './classify.js', './logRing.js'] },
  'tunnel/index.js': { allow: ['node:fs', 'node:path', './supervisor.js', './constants.js'] },
});

function stripComments(source) {
  let result = '';
  let quote = null;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (quote) {
      result += character;
      if (character === '\\') result += source[++index] || '';
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') {
      quote = character;
      result += character;
    } else if (character === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') { result += ' '; index++; }
      index--;
    } else if (character === '/' && next === '*') {
      result += '  ';
      index += 2;
      while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
        result += source[index] === '\n' ? '\n' : ' ';
        index++;
      }
      result += '  ';
      index++;
    } else result += character;
  }
  return result;
}

function staticImports(source) {
  const imports = [];
  const pattern = /(?:\bimport\s+(?!\()|\bexport\s+)(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function findClosing(source, openAt, open = '(', close = ')') {
  let depth = 0;
  let quote = null;
  for (let index = openAt; index < source.length; index++) {
    const character = source[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '\'' || character === '"' || character === '`') { quote = character; continue; }
    if (character === open) depth++;
    if (character === close && --depth === 0) return index;
  }
  return -1;
}

function functionRanges(source, acceptedNames) {
  const ranges = [];
  const name = acceptedNames.join('|');
  const pattern = new RegExp(`(?:\\b(?:async\\s+)?function\\s+(${name})\\s*\\([^)]*\\)\\s*|\\b(?:const|let)\\s+(${name})\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*)\\{`, 'g');
  for (const match of source.matchAll(pattern)) {
    const openAt = match.index + match[0].lastIndexOf('{');
    const closeAt = findClosing(source, openAt, '{', '}');
    if (closeAt >= 0) ranges.push([openAt, closeAt]);
  }
  return ranges;
}

function hasUnsafeLogArguments(source) {
  const call = /\b(?:logger\.[A-Za-z_$][\w$]*|(?:log|audit|emit)[A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of source.matchAll(call)) {
    const openAt = match.index + match[0].lastIndexOf('(');
    const closeAt = findClosing(source, openAt);
    if (closeAt >= 0 && /\.(?:message|stack)\b|\breq\s*\.\s*url\b/.test(source.slice(openAt, closeAt + 1))) return true;
  }
  return false;
}

function scanParsedMerges(source, file, errors) {
  const parsed = new Set(['parsed', 'input', 'payload', 'body', 'requestBody']);
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*JSON\.parse\s*\(/g)) parsed.add(match[1]);
  for (const match of source.matchAll(/\bObject\s*\.\s*assign\s*\(/g)) {
    const openAt = match.index + match[0].lastIndexOf('(');
    const closeAt = findClosing(source, openAt);
    const argumentsText = closeAt < 0 ? '' : source.slice(openAt + 1, closeAt);
    if ([...parsed].some(name => new RegExp(`\\b${name}\\b`).test(argumentsText)) || /JSON\.parse\s*\(/.test(argumentsText)) {
      errors.push(`${file} merges parsed input with Object.assign`);
    }
  }
  for (const name of parsed) if (new RegExp(`\\.\\.\\.\\s*${name}\\b`).test(source)) errors.push(`${file} spreads parsed input`);
  if (/\.\.\.\s*JSON\.parse\s*\(/.test(source)) errors.push(`${file} spreads parsed input`);
}

function listJavaScriptFiles(root, relative = '') {
  const directory = path.join(root, relative);
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...listJavaScriptFiles(root, next));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(next);
  }
  return files.sort();
}

function scanTunnelStructure(files, read) {
  const errors = [];
  const tunnelFiles = files.filter(file => file.startsWith('tunnel/'));
  if (!tunnelFiles.length) return errors;
  const sources = new Map(tunnelFiles.map(file => [file, stripComments(read(file))]));
  const joined = [...sources.values()].join('\n');
  const execPresent = sources.has('tunnel/exec.js');
  const spawnCount = (joined.match(/\bspawn\s*\(/g) || []).length;
  if (execPresent && spawnCount !== 1) errors.push('tunnel must contain exactly one spawn call when exec.js exists');
  for (const token of TUNNEL_FORBIDDEN) if (joined.includes(token)) errors.push(`tunnel contains forbidden ${token}`);
  if (/\bshell\s*:\s*true\b/.test(joined)) errors.push('tunnel contains forbidden shell: true');
  const loglevelFlags = (joined.match(/(['"`])--loglevel\1/g) || []).length;
  const literalInfoFlags = (joined.match(/(['"`])--loglevel\1\s*,\s*(['"`])info\2/g) || []).length;
  if (loglevelFlags !== literalInfoFlags) errors.push('tunnel loglevel must be the literal info');

  for (const [file, source] of sources) {
    const imports = staticImports(source);
    if (file !== 'tunnel/exec.js' && imports.includes('node:child_process')) errors.push(`${file} imports child_process outside tunnel/exec.js`);
    if (file === 'tunnel/binary.js' && /\bprocess\s*\.\s*env\b/.test(source)) errors.push('tunnel/binary.js reads process.env');
    const fetchCount = (source.match(/\bfetch\s*\(/g) || []).length;
    if (fetchCount && file !== 'tunnel/probe.js') errors.push(`${file} fetches outside tunnel/probe.js`);
    if (fetchCount && !/\bfetch\s*\(\s*(['"`])http:\/\/127\.0\.0\.1(?::|\/|\1)/.test(source)) errors.push('tunnel/probe.js fetch is not a literal loopback URL expression');
    for (const match of source.matchAll(/\bprocess\s*\.\s*kill\s*\(/g)) {
      const inApprovedFunction = functionRanges(source, ['signalGroup', 'isAlive']).some(([start, end]) => match.index >= start && match.index <= end);
      if (!inApprovedFunction) errors.push(`${file} uses process.kill outside signalGroup/isAlive`);
      const closeAt = findClosing(source, match.index + match[0].lastIndexOf('('));
      const firstArgument = closeAt < 0 ? '' : source.slice(match.index + match[0].lastIndexOf('(') + 1, closeAt).split(',')[0].replace(/\s/g, '');
      if (firstArgument === '0' || firstArgument === '-1' || firstArgument === '1' || firstArgument === '-process.pid') errors.push(`${file} uses a forbidden process.kill target`);
    }
  }
  return errors;
}

export function scanHandoffBridgeSource(root = fileURLToPath(bridgeRoot)) {
  const files = listJavaScriptFiles(root);
  const errors = [];
  const read = file => fs.readFileSync(path.join(root, file), 'utf8');
  for (const file of files) {
    const row = SOURCE_SCAN_ROWS[file];
    if (!row) { errors.push(`${file} has no allow-list row`); continue; }
    const source = stripComments(read(file));
    if (/\bimport\s*\(/.test(source)) errors.push(`${file} uses dynamic import`);
    const imports = staticImports(source);
    for (const specifier of imports) if (!row.allow.includes(specifier)) errors.push(`${file} imports forbidden ${specifier}`);
    for (const [label, pattern] of GENERIC_FORBIDDEN) if (pattern.test(source)) errors.push(`${file} contains forbidden ${label}`);
    if (PRE_AUTH_FILES.has(file)) for (const specifier of PRE_AUTH_FORBIDDEN_IMPORTS) if (imports.includes(specifier)) errors.push(`${file} is pre-auth and imports ${specifier}`);
    if (file !== 'listener.js' && /\b(?:http|net)\s*\.\s*createServer\s*\(|\.listen\s*\(/.test(source)) errors.push(`${file} owns a socket listener outside listener.js`);
    if (!['constants.js', 'index.js', 'listener.js'].includes(file)
        && (/\bSOCKET_RELATIVE_PATH\b|(['"`])[^'"`\n]*b\.sock\1/.test(source)
          || /\b(?:lstat|chmod|unlink)(?:Sync)?\s*\([^)]*\bsocket\w*/i.test(source))) {
      errors.push(`${file} touches the listener socket outside listener.js`);
    }
    if (hasUnsafeLogArguments(source)) errors.push(`${file} logs request-derived free text`);
    scanParsedMerges(source, file, errors);
  }
  return [...new Set([...errors, ...scanTunnelStructure(files, read)])];
}

function makeScratchBridge() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ic-handoff-scan-'));
  fs.mkdirSync(path.join(root, 'tunnel'), { recursive: true });
  return root;
}

function write(root, relative, source) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, source, 'utf8');
}

function expectFailure(root, message) {
  assert(scanHandoffBridgeSource(root).some(error => error.includes(message)), `expected scan failure: ${message}`);
}

export default [
  {
    name: 'handoff bridge: source-scan: complete table skips absent planned modules and rejects a no-row module',
    run: () => {
      assert(Object.keys(SOURCE_SCAN_ROWS).length === 48, 'every planned handoffBridge module needs exactly one row');
      assert(scanHandoffBridgeSource().length === 0, 'the current subset and absent planned rows must conform');
      const root = makeScratchBridge();
      try {
        write(root, 'unplanned.js', 'export const safe = true;\n');
        expectFailure(root, 'unplanned.js has no allow-list row');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: source-scan: enforces imports pre-auth isolation listener ownership and parsed-input merges',
    run: () => {
      const root = makeScratchBridge();
      try {
        write(root, 'oauth.js', "import './log.js';\nimport('node:fs');\nlogger.record(\n  error.message\n);\nconst parsed = JSON.parse('{}');\nconst copy = { ...parsed };\n");
        for (const file of [...PRE_AUTH_FILES].filter(file => file !== 'oauth.js')) write(root, file, "import './log.js';\n");
        write(root, 'controller.js', "import { createServer } from 'node:http';\ncreateServer().listen(1);\nfs.unlinkSync(socketPath);\nconst parsed = JSON.parse('{}');\nObject.assign({}, parsed);\n");
        for (const file of PRE_AUTH_FILES) expectFailure(root, `${file} is pre-auth and imports ./log.js`);
        expectFailure(root, 'oauth.js uses dynamic import');
        expectFailure(root, 'oauth.js logs request-derived free text');
        expectFailure(root, 'oauth.js spreads parsed input');
        expectFailure(root, 'controller.js imports forbidden node:http');
        expectFailure(root, 'controller.js owns a socket listener outside listener.js');
        expectFailure(root, 'controller.js touches the listener socket outside listener.js');
        expectFailure(root, 'controller.js merges parsed input with Object.assign');

        write(root, 'engine.js', [
          "const generated = new /* split */ Function('return 1');",
          "eval /* split */ ('1');",
          "require /* split */ ('node:fs');",
          "globalThis /* split */ . require('node:fs');",
          "process /* split */ . getBuiltinModule('node:fs');",
          "module /* split */ . createRequire(import.meta.url);",
          "globalThis['Function']('return 1')();",
          "const makeCode = globalThis['Function']; makeCode('return 1')();",
          "const indirectMakeCode = (0, globalThis).Function; indirectMakeCode('return 1')();",
          "globalThis['process']['getBuiltinModule']('node:fs');",
          "module['createRequire'](import.meta.url);",
          'const CodeFactory = Function;',
          "[].filter.constructor('return 1')();",
        ].join('\n'));
        for (const forbidden of [
          'Function constructor', 'dynamic evaluation', 'require', 'process.getBuiltinModule',
          'createRequire', 'function-constructor alias', 'constructor call',
          'dynamic-loader property', 'dynamic global property access',
          'dynamic-loader member access',
        ]) expectFailure(root, `engine.js contains forbidden ${forbidden}`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: source-scan: enforces every tunnel structural invariant and ignores comments',
    run: () => {
      const root = makeScratchBridge();
      try {
        write(root, 'tunnel/exec.js', "import { spawn } from 'node:child_process';\nfunction signalGroup() { return process.kill(-2, 'TERM'); }\nspawn('x', ['--loglevel', 'debug', '--token-file', '--credentials-contents', '--pidfile', '--origincert', '--url', '--hello-world', '--unix-socket'], { shell : true, env: { TUNNEL_TOKEN: 'x' } });\nspawn('again');\nprocess.kill(0);\n");
        write(root, 'tunnel/binary.js', "const env = process.env;\n");
        write(root, 'tunnel/reap.js', "import 'node:child_process';\nprocess.kill(-1);\n");
        write(root, 'tunnel/probe.js', "// fetch('https://example.com') and --url are comments\nfetch('https://example.com/mcp');\n");
        write(root, 'tunnel/other.js', "fetch('http://127.0.0.1:1');\nconst token = '--credentials-contents';\n");
        expectFailure(root, 'exactly one spawn');
        for (const token of TUNNEL_FORBIDDEN) expectFailure(root, `forbidden ${token}`);
        expectFailure(root, 'forbidden shell: true');
        expectFailure(root, 'tunnel loglevel must be the literal info');
        expectFailure(root, 'tunnel/binary.js reads process.env');
        expectFailure(root, 'tunnel/reap.js imports child_process outside tunnel/exec.js');
        expectFailure(root, 'process.kill outside signalGroup/isAlive');
        expectFailure(root, 'forbidden process.kill target');
        expectFailure(root, 'tunnel/probe.js fetch is not a literal loopback URL expression');
        expectFailure(root, 'tunnel/other.js has no allow-list row');
        expectFailure(root, 'tunnel/other.js fetches outside tunnel/probe.js');
        expectFailure(root, 'forbidden --credentials-contents');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'handoff bridge: source-scan: accepts a conforming literal tunnel skeleton',
    run: () => {
      const root = makeScratchBridge();
      try {
        write(root, 'tunnel/exec.js', "import { spawn } from 'node:child_process';\nfunction signalGroup() { return process.kill(-2, 'TERM'); }\nfunction isAlive(pid) { return process.kill(pid, 0); }\nspawn('x', ['--loglevel', 'info']);\nexport { signalGroup, isAlive };\n");
        write(root, 'tunnel/probe.js', "fetch('http://127.0.0.1:49152/metrics');\n");
        assert(scanHandoffBridgeSource(root).length === 0, 'a conforming injected tunnel skeleton must pass');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
];
