import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assert } from './testHelpers.js';
import { CREDENTIAL_LOG_CODES, LOG_FIELDS_BY_CODE, makeLogRecord } from '../../electron/ipc/handoffBridge/log.js';

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
  './laneStore.js', './engine.js', './lanes.js', './workerPool.js', './preflight.js', './framing.js', './errors.js', './audit.js', './log.js',
  './telemetry.js', './restartContext.js', './controller.js', './pairing.js', './ui.js', './uiDialogs.js', './tray.js', './power.js', './index.js',
];
const sibling = (...imports) => [...imports, ...allBridgeSiblings];

// B0 owns this complete table. Rows for later-stage modules deliberately exist
// before their files do; an absent row is skipped, an unlisted file is fatal.
export const SOURCE_SCAN_ROWS = Object.freeze({
  // The shared scheduler owns the single capacity value; constants re-exports
  // it as bridge policy without acquiring capabilities.
  'constants.js': { allow: ['../../../src/utils/handoffScheduler.js'] },
  'contracts.js': { allow: [] },
  'respond.js': { allow: sibling('node:crypto', 'node:net', 'node:util') },
  'wire.js': { allow: sibling('node:crypto', 'node:net', 'node:util') },
  'http.js': { allow: sibling('node:crypto', 'node:net', 'node:util') },
  'listener.js': { allow: ['node:http', 'node:net', 'node:fs', 'node:path', './constants.js'] },
  'tools.js': { allow: sibling('node:crypto', '../../../src/utils/handoffBridgeConfig.js') },
  'mcp.js': { allow: sibling('node:crypto') },
  'oauth.js': { allow: sibling('node:crypto') },
  'oauthPages.js': { allow: sibling('node:crypto') },
  'clientAuth.js': { allow: sibling('node:crypto') },
  'cimd.js': { allow: ['node:https', 'node:dns', 'node:net', 'node:crypto'] },
  'egressProbe.js': { allow: ['node:https', 'node:dns', 'node:crypto', './cimd.js'] },
  'oauthStore.js': { allow: ['node:fs', 'node:path', 'node:crypto'] },
  // constants.js is the inert values module with no imports of its own; the
  // config validator reads the jobsPerChat range from it rather than repeating
  // the numbers, which is how a legal value starts being rejected on save.
  'store.js': { allow: ['node:fs', 'node:path', 'node:crypto', './constants.js', '../../../src/utils/handoffBridgeConfig.js'] },
  'laneStore.js': { allow: ['node:fs', 'node:path', 'node:crypto', '../../../src/utils/handoffScheduler.js'] },
  'engine.js': { allow: sibling('node:crypto') },
  'lanes.js': { allow: sibling('node:crypto') },
  // Pure, main-process planning math for the manual worker pool. Its only
  // import is the inert bridge capacity policy.
  'workerPool.js': { allow: ['./constants.js'] },
  'preflight.js': { allow: sibling('node:crypto', './lanes.js', '../../../src/utils/pasteIdentityGuard.js') },
  'framing.js': { allow: sibling('node:crypto', '../../../src/utils/pasteIdentityGuard.js', '../../../src/utils/handoffBridgeConfig.js') },
  'errors.js': { allow: sibling('node:crypto') },
  'audit.js': { allow: ['node:fs', 'node:path', 'node:crypto', '../logger.js'] },
  'log.js': { allow: ['../logger.js'] },
  'telemetry.js': { allow: ['./log.js', '../../../src/utils/handoffScheduler.js'] },
  'restartContext.js': { allow: [] },
  'sources/application.js': { allow: ['../../localAiApplication.js'] },
  'sources/push.js': { allow: ['../../nonApiAi.js', '../../ipcUtils.js', '../constants.js'] },
  'controller.js': { allow: sibling('node:crypto') },
  'pairing.js': { allow: sibling('node:crypto') },
  'ui.js': { allow: sibling('electron') },
  'uiDialogs.js': { allow: sibling('electron') },
  'tray.js': { allow: sibling('electron') },
  'power.js': { allow: sibling('electron') },
  'index.js': { allow: sibling('electron', 'node:fs', 'node:path', 'node:os', 'node:http', 'node:crypto', '../../../src/utils/handoffBridgeConfig.js', './sources/application.js', './sources/push.js', './tunnel/index.js', '../bugReport/helpers.js', '../nonApiAi.js') },
  'tunnel/constants.js': { allow: [] },
  'tunnel/validate.js': { allow: ['../../../../src/utils/handoffBridgeConfig.js', '../constants.js', './constants.js'] },
  'tunnel/config.js': { allow: ['./constants.js', './validate.js'] },
  'tunnel/redact.js': { allow: ['./constants.js'] },
  'tunnel/logRing.js': { allow: ['./constants.js'] },
  'tunnel/classify.js': { allow: ['./constants.js'] },
  'tunnel/psParse.js': { allow: ['./constants.js'] },
  'tunnel/files.js': { allow: ['node:fs', 'node:path', 'node:crypto', '../../../utils/pathSafety.js', '../constants.js', './constants.js', './validate.js'] },
  'tunnel/binary.js': { allow: ['node:fs', 'node:path', 'node:crypto', './constants.js', './files.js', './validate.js'] },
  'tunnel/credentials.js': { allow: ['node:fs', 'node:path', 'node:crypto', './constants.js', './files.js', './validate.js'] },
  'tunnel/exec.js': { allow: ['node:child_process', 'node:fs', 'node:path', './constants.js', './redact.js'] },
  'tunnel/reap.js': { allow: ['node:fs', 'node:path', './constants.js', './exec.js', './psParse.js'] },
  'tunnel/probe.js': { allow: ['node:net', './constants.js', './classify.js'] },
  'tunnel/supervisor.js': { allow: ['node:crypto', './constants.js', './config.js', './files.js', './binary.js', './credentials.js', './exec.js', './reap.js', './probe.js', './classify.js', './logRing.js', './redact.js'] },
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

const LOG_CALL = /\b(?:logger|bridgeLog|log|audit)\s*(?:\?\.|\.)\s*(?:record|info|warn|error|debug|append|write)\s*(?:(?:\?\.|\.)\s*)?\(/g;
const LOG_HELPER_CALL = /\b(?:recordClosedBridgeEvent|emitCredentialLog)\s*\(/g;
const UNSAFE_LOG_VALUE = /\bconsole\s*(?:\?\.|\.)|(?:\?\.|\.)\s*(?:message|stack)\b|\b(?:req|request)\s*(?:\?\.|\.)\s*url\b/;

function unsafeLogArguments(source) {
  const failures = [];
  for (const call of [LOG_CALL, LOG_HELPER_CALL]) {
    for (const match of source.matchAll(call)) {
      const openAt = match.index + match[0].lastIndexOf('(');
      const closeAt = findClosing(source, openAt);
      const argumentsText = closeAt < 0 ? source.slice(openAt + 1) : source.slice(openAt + 1, closeAt);
      if (UNSAFE_LOG_VALUE.test(argumentsText)) failures.push(argumentsText);
    }
  }
  return failures;
}

function hasUnsafeLogArguments(source) {
  return unsafeLogArguments(source).length > 0;
}

function namedFunctionSource(source, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`\\b(?:function\\s+${escaped}\\s*\\([^)]*\\)|(?:const|let)\\s+${escaped}\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>)\\s*\\{`, 'g');
  const match = pattern.exec(source);
  if (!match) return '';
  const openAt = match.index + match[0].lastIndexOf('{');
  const closeAt = findClosing(source, openAt, '{', '}');
  return closeAt < 0 ? '' : source.slice(openAt, closeAt + 1);
}

const DIALOG_DETAIL_KEYS = new Set([
  'at', 'canvasFilePath', 'count', 'hostname', 'idlePauseMinutes', 'items', 'long',
  'minutes', 'path', 'pluginName', 'reason', 'releasedCount', 'sha256', 'signature', 'size',
  'sourcePath', 'version',
]);

function dialogSpecViolations(source) {
  const body = namedFunctionSource(source, 'ask');
  if (!body) return ['missing ask dialog builder'];
  const keys = [];
  for (const match of body.matchAll(/\bdetails\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)) keys.push(match[1]);
  for (const match of body.matchAll(/\bdetails\s*\[\s*['"]([^'"]+)['"]\s*\]/g)) keys.push(match[1]);
  if (/\.\.\.\s*details\b/.test(body)) keys.push('spread');
  return [...new Set(keys.filter(key => !DIALOG_DETAIL_KEYS.has(key)))];
}

function webContentsSendLabelViolations(source) {
  const failures = [];
  for (const match of source.matchAll(/\bwebContents\s*(?:\?\.|\.)\s*send\s*(?:(?:\?\.|\.)\s*)?\(/g)) {
    const openAt = match.index + match[0].lastIndexOf('(');
    const closeAt = findClosing(source, openAt);
    const argumentsText = closeAt < 0 ? source.slice(openAt + 1) : source.slice(openAt + 1, closeAt);
    if (/\blabel\s*:|\[['"]label['"]\]/.test(argumentsText)) failures.push('webContents.send carries label');
  }
  return failures;
}

function ipcLabelViolations(source) {
  const failures = [];
  for (const name of ['validJob', 'validPatch', 'publish']) {
    const body = namedFunctionSource(source, name);
    if (!body) { failures.push(`missing ${name} validator`); continue; }
    if (/\blabel\b/.test(body)) failures.push(`${name} carries label`);
  }
  return [...failures, ...webContentsSendLabelViolations(source)];
}

function secretComparisonViolations(source) {
  const identifier = '[A-Za-z_$][\\w$]*(?:Token|Secret|Verifier|Challenge|Session|Key|Mac|Digest|Hash)';
  const direct = new RegExp(`\\b${identifier}\\s*(?:===|!==|==|!=)|(?:===|!==|==|!=)\\s*\\b${identifier}`, 'g');
  // Type checks are not equality checks of a secret. Remove them before the
  // deliberately conservative identifier scan, so a persisted `metadataHash`
  // shape validation cannot mask a future raw-token comparison.
  const withoutTypeChecks = source.replace(/\btypeof\s+[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*(?:===|!==|==|!=)\s*(?:['"][^'"]*['"]|undefined|null)/g, '');
  return [...withoutTypeChecks.matchAll(direct)].map(match => match[0]);
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
      assert(Object.keys(SOURCE_SCAN_ROWS).length === 50, 'every planned handoffBridge module needs exactly one row');
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
  {
    name: 'handoff bridge: source-scan: B6 cross-cutting seams keep env, test hook and main wiring contained',
    run: () => {
      const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
      const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
      const bridge = path.join(repoRoot, 'electron/ipc/handoffBridge');
      const bridgeFiles = listJavaScriptFiles(bridge);
      const envReaders = bridgeFiles.filter(file => /\bINFINITE_CANVAS_HANDOFF_BRIDGE_[A-Z_]+\b/.test(read(path.join('electron/ipc/handoffBridge', file))));
      assert(envReaders.length === 1 && envReaders[0] === 'index.js', 'only index.js may read bridge environment variables');
      const hookReaders = [
        ...bridgeFiles.map(file => `electron/ipc/handoffBridge/${file}`),
        'electron/preload.js',
      ].filter(file => read(file).includes('__icHandoffBridgeTest'));
      assert(hookReaders.length === 1 && hookReaders[0] === 'electron/ipc/handoffBridge/index.js', 'test pairing hook is main-only and never preload/IPC');
      const main = read('electron/main.js');
      const cleanup = main.indexOf('const cleanup = async');
      const stop = main.indexOf('stopHandoffBridge()', cleanup);
      const authClose = main.indexOf('await closeAllAuthWindows()', cleanup);
      assert(cleanup >= 0 && stop > cleanup && authClose > stop, 'hard stop must begin cleanup before auth windows close');
      assert(main.includes('holdHandoffBridgeForQuit()') && main.includes('resumeHandoffBridgeAfterQuitCancel()'), 'quit handoff hooks remain additive');
      const packageJson = JSON.parse(read('package.json'));
      assert(Object.keys(packageJson.scripts).includes('test:e2e:bridge'), 'B0 bridge smoke script remains registered');
      assert(main.includes('requestSingleInstanceLock'), 'main must retain the single-instance guard');
      assert(/const bridgeBootContext = Object\.freeze\(\{ app, isPackaged: Boolean\(app\.isPackaged\) \}\);/.test(main)
        && /registerHandoffBridgeHandlers\(\{ ipcMain: electronPkg\.ipcMain, deps: \{\s*\.\.\.bridgeBootContext,/.test(main)
        && /scheduleRegisteredHandoffBridgeLaunch\(\{\s*registered: bridgeRegistered,/.test(main)
        && /startHandoffBridge\(\{ reason, deps: \{\s*\.\.\.bridgeBootContext,/.test(main),
      'main must pass one explicit canonical packaging state to registration and only schedule a delayed start after complete registration');
      assert(main.includes("logger.info(`[HandoffBridge] boot packaged=${bridgeBootContext.isPackaged ? 'yes' : 'no'} registered=yes`)")
        && main.includes("registration_failed reason=incomplete")
        && main.includes('registration_failed reason=exception kind=${handoffBridgeRegistrationErrorKind(error)}'),
      'bridge boot diagnostics must be closed and present in the main-log ring');
    },
  },
  {
    name: 'handoff bridge: source-scan: B6 composition keeps socket/test-mode branches and redacted tunnel relay explicit',
    run: () => {
      const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
      const read = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');
      const index = read('electron/ipc/handoffBridge/index.js');
      const supervisor = read('electron/ipc/handoffBridge/tunnel/supervisor.js');
      assert(index.includes('Buffer.byteLength(socketPath) > CONSTANTS.SOCKET_PATH_MAX_BYTES')
        && index.includes("error.code = 'path_too_long'"), 'composition must reject an overlong shared Unix-socket path before transport creation');
      assert(index.includes('socketPublicProbe({ ...options, socketPath') && index.includes('publicProbe({ ...options'), 'test mode must select a socket probe while production uses guarded public probe');
      assert(index.includes('if (testMode) installPairingTestHook(candidate)')
        && index.includes('delete globalThis.__icHandoffBridgeTest')
        && index.includes('removePairingTestHook(current)'), 'the pairing hook is test-mode-only and removed when a candidate is hard-stopped/detached');
      assert(SOURCE_SCAN_ROWS['tunnel/supervisor.js'].allow.includes('./redact.js') && supervisor.includes("from './redact.js'"), 'the reviewed bounded/redacted tunnel log relay must be allow-listed');
    },
  },
  {
    name: 'handoff bridge: source-scan: B8 privacy guards reject free-text logs, raw secret compares, label IPC, and renderer dialog fields',
    run: () => {
      const root = fileURLToPath(bridgeRoot);
      const files = listJavaScriptFiles(root);
      const read = file => stripComments(fs.readFileSync(path.join(root, file), 'utf8'));
      const expectedCodes = [
        'listener_started', 'listener_stopped', 'listener_error', 'link_created', 'link_replaced',
        'link_revoked', 'refresh_reuse', 'code_reuse', 'pause', 'resume', 'pairing_opened',
        'pairing_closed', 'consent_requested', 'refresh_rotated', 'persist_failed', 'state_version',
        'tool_call', 'tool_deadline', 'port_error', 'probe', 'permit_leak', 'restart_confirmed',
        'epoch_closed', 'release', 'unrelease', 'new_chat', 'starter_recopied', 'continue', 'source_mismatch',
        'worker_pool_started', 'worker_pool_expanded',
      ];
      assert(JSON.stringify(CREDENTIAL_LOG_CODES) === JSON.stringify(expectedCodes), 'the logger code surface is the frozen credential/control enum');
      assert(JSON.stringify(Object.keys(LOG_FIELDS_BY_CODE)) === JSON.stringify(expectedCodes), 'each logger code has a closed field allow-list');
      assert(makeLogRecord('listener_started', { state: 'live' }).code === 'listener_started', 'a listed logger event remains a positive control');
      let rejectedUnknownCode = false;
      try { makeLogRecord('anonymous_summary', { route: 'mcp' }); } catch { rejectedUnknownCode = true; }
      assert(rejectedUnknownCode, 'an anonymous-event logger code must be rejected rather than silently admitted');

      const directLoggerOwners = files.filter(file => /\blogger\s*(?:\?\.|\.)\s*(?:record|info)\s*(?:(?:\?\.|\.)\s*)?\(/.test(read(file)));
      assert(JSON.stringify(directLoggerOwners) === JSON.stringify(['engine.js', 'log.js']), 'only the engine log port and log.js may invoke a logger directly');
      assert(read('index.js').includes('logger: bridgeLog'), 'production must inject the validating bridge log into the engine rather than a raw app logger');
      for (const file of files) assert(unsafeLogArguments(read(file)).length === 0, `${file} must not pass console, message, stack, or request URL text to a log sink`);
      assert(unsafeLogArguments('logger?.info?.(console.error(error?.message), request.url, error.stack);').length === 1, 'the free-text logger scan must reject console/message/stack/request-url positive controls');

      const oauth = read('oauth.js'); const engine = read('engine.js'); const probe = read('egressProbe.js');
      for (const [source, name] of [[oauth, 'sameSecret'], [oauth, 'hexEqual'], [oauth, 'authenticate'], [engine, 'sameDigest'], [probe, 'verify']]) {
        assert(namedFunctionSource(source, name).includes('timingSafeEqual'), `${name} must use timingSafeEqual on its secret comparison path`);
      }
      for (const [source, file] of [[oauth, 'oauth.js'], [engine, 'engine.js'], [probe, 'egressProbe.js']]) {
        assert(secretComparisonViolations(source).length === 0, `${file} must not directly compare a token, secret, verifier, challenge, session, key, MAC, digest, or hash`);
      }
      assert(secretComparisonViolations('if (providedToken === storedToken || pairingSecret !== expectedSecret) return false;').length === 2, 'the secret-comparison sweep must reject raw comparison positive controls');

      const fixedDigestLookup = namedFunctionSource(oauth, 'fixedDigestLookup');
      assert(fixedDigestLookup.includes('for (const candidate of records.values())')
        && fixedDigestLookup.includes('hexEqual(digest, candidate.hash)')
        && !fixedDigestLookup.includes('.get('), 'caller-derived OAuth digests must use a full fixed-digest timing-safe scan');
      const codeGrant = namedFunctionSource(oauth, 'codeGrant');
      const refreshGrant = namedFunctionSource(oauth, 'refreshGrant');
      const revokeRoute = namedFunctionSource(oauth, 'revokeRoute');
      assert(codeGrant.includes('fixedDigestLookup(codes, shaHex(raw))')
        && refreshGrant.includes('fixedDigestLookup(refreshTokens, shaHex(raw))')
        && revokeRoute.includes('fixedDigestLookup(refreshTokens, digest)')
        && revokeRoute.includes('fixedDigestLookup(accessTokens, digest)'), 'code, refresh, and revoke input digests must not select hash-map buckets directly');
      assert(refreshGrant.includes('hexEqual(record.successor, successorDigest)')
        && refreshGrant.includes('fixedDigestLookup(refreshTokens, successorDigest)'), 'refresh grace must compare and resolve the successor digest through safe digest helpers');
      assert(!/\b(?:codes|refreshTokens|accessTokens)\s*\.\s*(?:get|has)\s*\(\s*(?:shaHex\(|digest\b)/.test(oauth),
        'OAuth token maps must not directly look up caller-derived digests');

      const verify = namedFunctionSource(probe, 'verify');
      const hmacAt = verify.indexOf('const expected = sign(value);');
      const comparisonAt = verify.indexOf('timingSafeEqual');
      const nonceLookupAt = verify.indexOf('active.get(value)');
      assert(verify.includes('PROBE_NONCE_RE.test(value)') && verify.includes('PROBE_MAC_RE.test(mac)')
        && hmacAt >= 0 && comparisonAt > hmacAt && nonceLookupAt > comparisonAt
        && !/\bactive\s*\.\s*(?:get|has)\s*\(\s*value\s*\)/.test(verify.slice(0, comparisonAt)),
      'a bounded syntactically valid probe MAC must be computed and timing-compared before nonce lookup');

      const epochAuth = namedFunctionSource(engine, 'authenticate');
      const workerSession = namedFunctionSource(engine, 'workerForSession');
      assert(workerSession.includes('for (const worker of epochWorkers(target))')
        && workerSession.includes('sameDigest(epochHash(boundLinkId, presented), worker.keyHash)')
        && epochAuth.includes('const worker = workerForSession(epoch, boundLinkId, presented);')
        && epochAuth.includes('sameHex(retired.digest, ended)')
        && !epochAuth.includes('epoch.linkId') && !epochAuth.includes('retired.linkId')
        && !engine.includes('linkId: epoch.linkId'), 'each live worker key must stay link-bound through a constant-time digest comparison, and ended chats must remain link-free and constant-time recognised');
      assert(namedFunctionSource(engine, 'sameHex').includes('sameDigest') && /function endedDigest\(key\)/.test(engine) && !/function endedDigest\([^)]*linkId/.test(engine),
        'the ended-chat digest takes the key alone and hex digests are compared through the constant-time helper');

      const lanes = read('lanes.js'); const application = read('sources/application.js'); const push = read('sources/push.js'); const index = read('index.js');
      const guard = namedFunctionSource(lanes, 'createHandoffCodeGuard');
      assert(guard.includes("createHash('sha256')") && guard.includes('length === 32') && guard.includes('timingSafeEqual'),
        'lanes must own fixed SHA-256 handoff-code identity and its timing-safe equality');
      for (const source of [engine, application, push]) assert(!/\b(?:previous|returned|marker|retained|handoff|served|current)\??\.code\s*(?:===|!==)/.test(source),
        'application and push handoff codes must not use direct raw equality');
      for (const source of [engine, push, lanes]) assert(!/\b(?:codeIndex|tombstones|byCode|issuedCodes)\s*\.\s*(?:get|set|has|delete)\s*\(\s*(?:code\b|currentCode\b|handoffCode\b|canonicalCode\s*\()/.test(source),
        'caller-derived handoff codes must not be raw Map keys');
      assert(engine.includes('codeGuard.sameDigest(codeDigest, entry.codeDigest)')
        && push.includes('handoffCodeGuard.sameDigest(digest, route.codeDigest)')
        && push.includes('tombstoneEntry && handoffCodeGuard.sameDigest(digest, tombstoneEntry.codeDigest)'),
      'every digest-key hit must re-verify its stored fixed digest');
      assert(index.includes("runtimePort('engine', ['hold', 'resume', 'hint'])"), 'runtime engine exposure must retain the hint port');

      const ui = read('ui.js'); const dialogs = read('uiDialogs.js');
      assert(ipcLabelViolations(ui).length === 0, 'IPC job/config validators and bridge sends must not carry a label key');
      for (const file of files) assert(webContentsSendLabelViolations(read(file)).length === 0, `${file} must not send a label key to a renderer`);
      assert(ipcLabelViolations("function validJob(value) { return value.label === 'x'; } function validPatch(value) { return value; } function publish() {} target.webContents.send('x', { label: 'x' });").length >= 2, 'the IPC label scan must reject both a validator field and a renderer payload positive control');
      assert(dialogSpecViolations(dialogs).length === 0, 'native dialog specs may use only the reviewed main-owned details fields');
      assert(dialogSpecViolations("function ask() { return dialog.showMessageBox(parent, { message: details.label }); }").includes('label'), 'the native-dialog scan must reject a renderer-controlled details field');
    },
  },
];
