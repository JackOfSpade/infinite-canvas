import { exec } from 'child_process';
import path from 'path';
import os from 'os';
import { promisify } from 'util';
import fs from 'fs';

const execAsync = promisify(exec);

export async function convertHeicIfNecessary(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.heic' && ext !== '.heif') {
    return filePath; // No conversion needed
  }

  // Only attempt on macOS
  if (process.platform !== 'darwin') {
    throw new Error('HEIC conversion is only supported on macOS. Please convert to JPG manually.');
  }

  const tempFile = path.join(os.tmpdir(), `converted_${Date.now()}.jpg`);
  
  try {
    // macOS built-in sips tool
    await execAsync(`sips -s format jpeg "${filePath}" --out "${tempFile}"`);
    return tempFile;
  } catch (err) {
    throw new Error(`Failed to convert HEIC to JPG: ${err.message}`);
  }
}

export async function cleanupTempFile(filePath) {
  try {
    // Only cleanup files we put in temp dir
    if (filePath.includes(os.tmpdir())) {
      await fs.promises.unlink(filePath);
    }
  } catch {
    // Ignore cleanup errors
  }
}
