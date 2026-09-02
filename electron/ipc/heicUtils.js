import { execFile } from 'child_process';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import fs from 'fs';
import crypto from 'crypto';

// execFile (no shell) with an args array — never interpolate a caller-controlled
// file path into a shell string (a filename with quotes/backticks/$() could break
// or inject). `/usr/bin/sips` is the absolute path, matching electron/main.js.
const execFileAsync = promisify(execFile);
const SIPS = '/usr/bin/sips';

// Formats EVERY vision provider (Claude + Gemini) accepts inline. Claude takes
// only jpeg/png/gif/webp; Gemini also takes heic/webp — but to keep one code path
// we normalize anything outside this set to JPEG, so both providers always get
// bytes they can read (HEIC, TIFF, JXL, AVIF, BMP, SVG, …).
const VISION_SAFE_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/**
 * Transcode `filePath` to a JPEG temp file via sips when its extension is NOT in
 * `safeExts`; otherwise return the original path untouched. Generalizes the old
 * HEIC-only helper to every format macOS/ImageIO can read (HEIC/HEIF/TIFF/JXL/
 * AVIF/BMP/SVG/…). macOS-only: throws on other platforms ONLY when a conversion
 * is actually required (safe formats pass through everywhere).
 */
async function convertToJpegIfNeeded(filePath, safeExts) {
  const ext = path.extname(filePath).toLowerCase();
  if (safeExts.has(ext)) {
    return filePath; // already a format the consumer accepts — no conversion needed
  }

  // Only attempt on macOS (sips). The caller's downstream readFile/AI call would
  // otherwise surface a less clear error, so fail with an actionable message.
  if (process.platform !== 'darwin') {
    throw new Error(`Converting ${ext || 'this image'} is only supported on macOS (needs sips). Please convert to JPG/PNG manually.`);
  }

  // randomUUID, not Date.now(): the vision pipeline runs every image through
  // here in Promise.all, so 5-7 conversions land in the same millisecond.
  // Same-ms Date.now() collisions caused two sips invocations to race on the
  // same --out path, surfacing as Error 13 "Cannot rename temporary file".
  const tempFile = path.join(os.tmpdir(), `converted_${crypto.randomUUID()}.jpg`);

  try {
    // macOS built-in sips tool
    await execFileAsync(SIPS, ['-s', 'format', 'jpeg', filePath, '--out', tempFile]);
    return tempFile;
  } catch (err) {
    // sips may have produced a partial file before failing — clean it up so
    // the temp dir doesn't accumulate zero-byte junk over a long session.
    try { await fs.promises.unlink(tempFile); } catch { /* not created */ }
    throw new Error(`Failed to convert ${ext} to JPG: ${err.message}`);
  }
}

/**
 * Ensure an image is in a format every vision provider accepts, transcoding
 * anything that isn't (HEIC/HEIF/TIFF/JXL/AVIF/BMP/SVG) to JPEG. Returns the
 * original path when already safe, else a temp JPEG the caller must clean up
 * (track it and pass to cleanupTempFile). Replaces the old heic-only path.
 */
export function ensureVisionSafeImage(filePath) {
  return convertToJpegIfNeeded(filePath, VISION_SAFE_IMAGE_EXT);
}

export async function cleanupTempFile(filePath) {
  try {
    // Only cleanup files we put in temp dir — anchor the check to the tmpdir
    // prefix (a bare substring `includes` would also match an unrelated path
    // that merely embeds the tmpdir string somewhere in the middle).
    const resolved = path.resolve(filePath);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
      await fs.promises.unlink(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Resize an image so the longer side is at most `maxLongSide` px. Used before
 * sending photos to Claude vision — Claude charges per ~1568x1568 tile
 * (~1600 input tokens), so a 4032px phone photo ends up at ~4 tiles ≈ 6400
 * tokens. Downscaling to 768px fits in one tile (~260 tokens) with no
 * measurable impact on brand/model/condition identification. Skipped if the
 * image is already small enough.
 *
 * Returns the path to a downscaled temp file if a resize happened, OR the
 * original `srcPath` if the image was already small. The caller is
 * responsible for tracking returned temp paths in their cleanup list.
 *
 * macOS-only (uses sips). On other platforms, returns the original path —
 * Claude will accept the full-res image, just at higher cost.
 */
export async function downscaleImageIfNeeded(srcPath, { maxLongSide = 768 } = {}) {
  if (process.platform !== 'darwin') return srcPath;

  let width = 0, height = 0;
  try {
    // sips emits "  pixelWidth: 4032" / "  pixelHeight: 2268" — grep both
    // in one call instead of two execs.
    const { stdout } = await execFileAsync(SIPS, ['--getProperty', 'pixelWidth', '--getProperty', 'pixelHeight', srcPath]);
    width  = parseInt(stdout.match(/pixelWidth:\s*(\d+)/)?.[1] || '0', 10);
    height = parseInt(stdout.match(/pixelHeight:\s*(\d+)/)?.[1] || '0', 10);
  } catch {
    // sips failed to read the image (corrupt file, unknown format) — let the
    // downstream readFile/Claude call surface the real error.
    return srcPath;
  }

  if (width === 0 || height === 0) return srcPath;
  if (Math.max(width, height) <= maxLongSide) return srcPath;

  const tempFile = path.join(os.tmpdir(), `scaled_${crypto.randomUUID()}.jpg`);
  try {
    // sips -Z preserves aspect ratio: resizes so the longest side is exactly
    // maxLongSide. Format-converts to JPEG to avoid any PNG/HEIC parsing
    // overhead downstream (Claude accepts JPEG just fine for vision).
    await execFileAsync(SIPS, ['-Z', String(maxLongSide), '-s', 'format', 'jpeg', srcPath, '--out', tempFile]);
    return tempFile;
  } catch {
    try { await fs.promises.unlink(tempFile); } catch { /* not created */ }
    // Resize failure shouldn't sink the whole vision call — fall back to the
    // original full-res image (more expensive, but correct).
    return srcPath;
  }
}
