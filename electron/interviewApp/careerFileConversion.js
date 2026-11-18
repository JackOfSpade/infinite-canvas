// Main-process wiring for the Interview Helper's "career data of any file type" drop.
//
// The renderer names dropped files here first. Each one is converted to a plain text
// file in one private folder of the app data root (electron/ipc/careerFileToText.js
// does the converting), and the renderer then hands the converted text files to the
// existing text-only career compile. `.txt` and `.md` files pass through untouched.
//
// This module owns: strict argument checks, the per-file safety check on a renderer-supplied
// path, the private conversions folder, the Claude reader for an image, opaque tokens for
// "show this converted file", and the IPC registration. It never decides what a file's text is.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildCareerFileToTextPrompt } from '../ipc/careerFileToText.js';
import { isWithinDirectory } from '../utils/pathSafety.js';

export const CAREER_CONVERSIONS_DIR = 'interview-helper-career-conversions';
export const CAREER_FILE_TO_TEXT_STAGE = 'career-file-to-text';
// The CommonJS preload cannot import this module, so it repeats these two channel names as literals.
// This file owns the names.
const CONVERT_CAREER_FILES_CHANNEL = 'convert-interview-career-files';
const REVEAL_CONVERTED_CAREER_FILE_CHANNEL = 'interview-app:reveal-converted-career-file';
const MAX_CAREER_DROP_FILES = 50;
const MAX_PATH_CHARS = 4096;
const MAX_NODE_ID_CHARS = 300;
const MAX_TOKENS = 1000;
// Claude's image input limit is 5 MB of image data; larger pictures are refused with a plain reason.
const MAX_AI_IMAGE_BYTES = 5 * 1024 * 1024;
// Image types Claude accepts as an image block. tiff and heic are not among them.
const AI_IMAGE_TYPES = Object.freeze({
  'image/png': 'png', 'image/jpeg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp',
});

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Strict arguments of the convert channel: exactly { nodeId, filePaths }. Throws TypeError. */
export function validateConvertArgs(args) {
  if (!plain(args) || Object.keys(args).some(key => key !== 'nodeId' && key !== 'filePaths')) throw new TypeError('Career file conversion takes only a node and file paths.');
  if (typeof args.nodeId !== 'string' || !args.nodeId || args.nodeId.length > MAX_NODE_ID_CHARS) throw new TypeError('Career file conversion needs a node id.');
  const paths = args.filePaths;
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > MAX_CAREER_DROP_FILES) throw new TypeError(`Drop between 1 and ${MAX_CAREER_DROP_FILES} files at a time.`);
  for (const filePath of paths) {
    if (typeof filePath !== 'string' || !filePath || filePath.length > MAX_PATH_CHARS || filePath.includes('\0') || !path.isAbsolute(filePath)) throw new TypeError('Each dropped file needs an absolute path.');
  }
  return { nodeId: args.nodeId, filePaths: [...paths] };
}

/** The private folder of converted text files under the shared data root (same checks as the other private stores). */
async function privateConversionsRoot(dataRoot) {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot)) throw new Error('Career conversion folder unavailable');
  const userData = path.resolve(dataRoot);
  const stat = await fs.promises.lstat(userData);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe career conversion folder');
  const realData = await fs.promises.realpath(userData);
  const requested = path.join(realData, CAREER_CONVERSIONS_DIR);
  try { await fs.promises.mkdir(requested, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const dirStat = await fs.promises.lstat(requested);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new Error('unsafe career conversion folder');
  const real = await fs.promises.realpath(requested);
  if (real !== requested) throw new Error('unsafe career conversion folder');
  return real;
}

function unsupportedKind(reason) {
  const error = new Error(reason);
  error.code = 'UNSUPPORTED_KIND';
  return error;
}

/**
 * The Claude reader handed to the converter: reads ONE image and returns its text verbatim.
 * The converter calls readWithAi({ filePath, name, kind, mediaType, signal }). The image goes as
 * a base64 image block of a tool-less call; Claude never gets a path, a tool or any other file.
 * A kind that cannot go this way (a PDF, tiff, heic, no transport) throws code UNSUPPORTED_KIND, which
 * the converter answers by falling back (PDF text layer) or refusing that one file. Any other error is
 * reported for that file with its message.
 */
export function createCareerFileReader({ transport, stage = CAREER_FILE_TO_TEXT_STAGE } = {}) {
  return async function readWithAi({ filePath, name = 'file', kind = '', mediaType = '', signal } = {}) {
    if (kind !== 'image') throw unsupportedKind('Only images can be sent to Claude from this app.');
    if (!transport || typeof transport.callRaw !== 'function') throw unsupportedKind('Claude is not available to read this file.');
    const type = String(mediaType || '').toLowerCase();
    if (!Object.hasOwn(AI_IMAGE_TYPES, type)) throw unsupportedKind(`Claude cannot read ${type || 'this'} images.`);
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('It is not a plain file.');
    if (stat.size === 0) throw new Error('The image is empty.');
    if (stat.size > MAX_AI_IMAGE_BYTES) throw new Error('The image is larger than 5 MB. Save a smaller copy or type its text into a .txt file.');
    const buffer = await fs.promises.readFile(filePath);
    const reply = await transport.callRaw(buildCareerFileToTextPrompt({ name, kind: 'image' }), {
      signal, task: stage, claudeStage: stage,
      pageImages: [{ label: 'Career document image', mimeType: type, data: buffer.toString('base64') }],
    });
    return String(reply ?? '');
  };
}

async function loadConvert() {
  const mod = await import('../ipc/careerFileToText.js');
  if (typeof mod.convertCareerFiles !== 'function') throw new Error('The career file converter is unavailable.');
  return mod.convertCareerFiles;
}

// A file below the root; the root itself does not count.
const insideRoot = (root, target) => {
  const resolved = path.resolve(String(target || ''));
  return resolved !== path.resolve(root) && isWithinDirectory(root, resolved);
};

/**
 * The service behind both channels.
 * - dataRoot: the shared data folder (conversions live in a private folder inside it).
 * - convert: convertCareerFiles of electron/ipc/careerFileToText.js:
 *   ({ filePaths, userDataPath, readWithAi, signal }) => { files:[{ ok, method, textPath, textName, reason }] } in order.
 * - checkSource: per-file safety check of a renderer path; throws a plain Error to refuse that file only.
 */
export function createCareerFileConversionService({
  dataRoot, convert = null, transport = null, readWithAi = null,
  checkSource = defaultCheckSource, registerInputRoot = () => {}, showItemInFolder = () => {},
  randomToken = () => crypto.randomBytes(16).toString('hex'),
} = {}) {
  const tokens = new Map();
  let rootPromise = null;
  const conversionsRoot = () => {
    if (!rootPromise) {
      rootPromise = privateConversionsRoot(dataRoot).then(root => { registerInputRoot(root); return root; }, error => { rootPromise = null; throw error; });
    }
    return rootPromise;
  };
  const reader = readWithAi || createCareerFileReader({ transport });

  function remember(convertedPath) {
    for (const [token, existing] of tokens) { if (existing === convertedPath) return token; }
    if (tokens.size >= MAX_TOKENS) tokens.delete(tokens.keys().next().value);
    const token = randomToken();
    tokens.set(token, convertedPath);
    return token;
  }

  async function convertFiles({ nodeId, filePaths }, signal) {
    const args = validateConvertArgs({ nodeId, filePaths });
    const root = await conversionsRoot();
    const results = new Array(args.filePaths.length).fill(null);
    const accepted = [];
    for (let index = 0; index < args.filePaths.length; index += 1) {
      const filePath = args.filePaths[index];
      const name = path.basename(filePath);
      try { await checkSource(filePath); } catch (error) {
        results[index] = { name, convertedName: null, filePath: null, status: 'refused', method: null, reason: String(error?.message || 'This file cannot be used.'), machineExtracted: false, token: null };
        continue;
      }
      accepted.push({ index, filePath, name });
    }
    if (accepted.length) {
      const run = convert || await loadConvert();
      let converted;
      try {
        const reply = await run({ filePaths: accepted.map(({ filePath }) => filePath), userDataPath: dataRoot, readWithAi: reader, signal });
        converted = reply?.files;
      } catch (error) {
        if (signal?.aborted) throw error;
        // One failure of the whole converter must not look like success: every file reports it.
        converted = accepted.map(() => ({ ok: false, reason: String(error?.message || 'The file could not be converted.') }));
      }
      if (!Array.isArray(converted) || converted.length !== accepted.length) throw new Error('The career file converter returned an unexpected result.');
      converted.forEach((entry, position) => {
        const { index, filePath, name } = accepted[position];
        const note = typeof entry?.reason === 'string' && entry.reason ? entry.reason.slice(0, 400) : null;
        if (entry?.ok === true && entry.method === 'original' && entry.textPath === path.resolve(filePath)) {
          results[index] = { name, convertedName: name, filePath: entry.textPath, status: 'passthrough', method: 'original', reason: null, machineExtracted: false, token: null };
        } else if (entry?.ok === true && typeof entry.textPath === 'string' && insideRoot(root, entry.textPath)) {
          results[index] = { name, convertedName: path.basename(entry.textPath), filePath: entry.textPath, status: 'converted', method: String(entry.method || ''), reason: note,
            machineExtracted: entry.method === 'pdf-text-layer', token: remember(entry.textPath) };
        } else {
          results[index] = { name, convertedName: null, filePath: null, status: 'refused', method: null,
            reason: (entry?.ok === true ? 'The file could not be converted.' : (note || 'The file could not be converted.')), machineExtracted: false, token: null };
        }
      });
    }
    return { files: results, usableCount: results.filter(file => file.status !== 'refused').length };
  }

  /** Shows one converted file by its opaque token; a path from the renderer is never accepted. */
  async function reveal({ token } = {}) {
    if (typeof token !== 'string' || !tokens.has(token)) throw new Error('That converted file is not known any more. Convert the file again.');
    const root = await conversionsRoot();
    const target = tokens.get(token);
    if (!insideRoot(root, target)) throw new Error('That converted file is not available.');
    const stat = await fs.promises.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('That converted file is not available.');
    const real = await fs.promises.realpath(target);
    if (real !== target) throw new Error('That converted file is not available.');
    showItemInFolder(target);
    return { shown: true };
  }

  return Object.freeze({ convertFiles, reveal, conversionsRoot });
}

/** Default per-file check: not a private/sensitive path, a plain file (no symlink), not a folder. */
async function defaultCheckSource(filePath) {
  const { isRendererSensitivePath } = await import('../utils/pathSafety.js');
  const name = path.basename(filePath);
  const resolved = path.resolve(filePath);
  if (isRendererSensitivePath(resolved)) throw new Error(`${name} cannot be used as career data.`);
  let stat;
  try { stat = await fs.promises.lstat(resolved); } catch { throw new Error(`${name} could not be found.`); }
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${name} is not a plain file.`);
}

/** Registers both channels. `handleSafe` is ipcUtils.handleSafe; `guarded` is the app's top-frame check. */
export function registerCareerConversionHandlers({ handleSafe, ipcMain, guarded, service }) {
  handleSafe(CONVERT_CAREER_FILES_CHANNEL, async (_event, args, signal) => service.convertFiles(args, signal), {
    validateArgs: args => { validateConvertArgs(args); },
  });
  ipcMain.handle(REVEAL_CONVERTED_CAREER_FILE_CHANNEL, guarded(args => {
    if (!plain(args) || Object.keys(args).some(key => key !== 'token')) throw new TypeError('Showing a converted file takes only its token.');
    return service.reveal(args);
  }));
}
