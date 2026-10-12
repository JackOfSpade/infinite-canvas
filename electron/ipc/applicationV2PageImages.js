import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_PAGE_IMAGE_BYTES = 300 * 1024;

/** Convert a verified one-page PDF to an actual PNG for the blind judge. */
export async function applicationV2PagePng(pdfBytes) {
  if (!Buffer.isBuffer(pdfBytes) || !pdfBytes.length) throw new Error('Application v2 judge requires a verified PDF page.');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'application-v2-page-'));
  try {
    const source = path.join(folder, 'page.pdf');
    const target = path.join(folder, 'page.png');
    await fs.writeFile(source, pdfBytes, { mode: 0o600 });
    await run('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', target], { timeout: 30_000 });
    const bytes = await fs.readFile(target);
    if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || bytes.length > MAX_PAGE_IMAGE_BYTES)
      throw new Error('Application v2 judge PNG is malformed or exceeds the page-image limit.');
    return bytes.toString('base64');
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
}
