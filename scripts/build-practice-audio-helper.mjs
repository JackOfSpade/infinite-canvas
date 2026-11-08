#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(import.meta.url);
const defaultProjectDir = path.dirname(path.dirname(scriptPath));

/** Compile only the native helper, never Electron or the application. */
export function buildPracticeAudioHelper({
  projectDir = defaultProjectDir,
  outputDir = path.join(projectDir, 'native', 'practice-audio', 'build'),
  identity = null,
  runCommand = spawnSync,
} = {}) {
  if (process.platform !== 'darwin') throw new Error('The practice audio helper requires the macOS SDK.');
  if (identity !== null && (typeof identity !== 'string' || !identity.trim() || identity === '-')) {
    throw new Error('Use the pinned named macOS signing identity; ad-hoc helper signing is not supported.');
  }
  const sourceDir = path.join(projectDir, 'native', 'practice-audio');
  const appPath = path.join(path.resolve(outputDir), 'Practice Audio Helper.app');
  const contents = path.join(appPath, 'Contents');
  const executable = path.join(contents, 'MacOS', 'practice-audio-helper');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.copyFileSync(path.join(sourceDir, 'Info.plist'), path.join(contents, 'Info.plist'));
  const moduleCache = fs.mkdtempSync(path.join(os.tmpdir(), 'practice-audio-swift-cache-'));
  function run(command, args) {
    const result = runCommand(command, args, { cwd: projectDir, encoding: 'utf8' });
    if (result?.error || result?.status !== 0) {
      throw new Error(`Practice audio helper ${path.basename(command)} failed.\n${result?.stderr || result?.error?.message || ''}`);
    }
  }
  try {
    run('/usr/bin/xcrun', [
      'swiftc', '-parse-as-library', '-swift-version', '5', '-O',
      '-target', 'arm64-apple-macos26.0', '-module-cache-path', moduleCache,
      '-framework', 'AppKit', '-framework', 'AVFoundation', '-framework', 'Speech',
      '-framework', 'CoreMedia',
      path.join(sourceDir, 'PracticeAudioHelper.swift'), '-o', executable,
    ]);
    fs.chmodSync(executable, 0o755);
    if (identity !== null) {
      run('/usr/bin/codesign', [
        '--force', '--sign', identity.trim(), '--options', 'runtime', '--timestamp=none',
        '--entitlements', path.join(sourceDir, 'entitlements.plist'), appPath,
      ]);
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath]);
    }
  } finally {
    fs.rmSync(moduleCache, { recursive: true, force: true });
  }
  return { appPath, executable };
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  try {
    const args = process.argv.slice(2);
    let outputDir;
    let identity = null;
    for (let index = 0; index < args.length; index += 2) {
      if (!args[index + 1] || !['--output', '--sign'].includes(args[index])) throw new Error('Usage: node scripts/build-practice-audio-helper.mjs [--output DIRECTORY] [--sign IDENTITY]');
      if (args[index] === '--output') outputDir = args[index + 1];
      else identity = args[index + 1];
    }
    const result = buildPracticeAudioHelper({ outputDir, identity });
    process.stdout.write(`Compiled practice audio helper: ${result.executable}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
