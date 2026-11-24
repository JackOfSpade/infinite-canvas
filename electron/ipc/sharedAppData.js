/**
 * Data shared between the Job Search side and the Job Board side.
 *
 * Each side keeps its own private state (its canvas, its Chrome profile, its
 * settings). The only things both read are small files under one shared root,
 * written by one side and read by the other; nothing here is a command.
 *
 *   <root>/job-streams/   saved listing streams (jobListingStream.js)
 *
 * The root sits beside the apps' own data folders, not inside either, so it
 * does not move when one app is rebuilt or its data folder is replaced.
 */
import path from 'node:path';
import electronPkg from 'electron';

const { app } = electronPkg;

export const SHARED_APP_DATA_FOLDER = 'infinite-canvas-shared';

let configuredRoot = null;

/** Tests and a second app entry point can name the root explicitly. */
export function configureSharedAppDataRoot(root) {
  configuredRoot = typeof root === 'string' && path.isAbsolute(root) ? root : null;
}

export function sharedAppDataRoot() {
  if (configuredRoot) return configuredRoot;
  try {
    const appData = app?.getPath?.('appData');
    return typeof appData === 'string' && path.isAbsolute(appData) ? path.join(appData, SHARED_APP_DATA_FOLDER) : null;
  } catch {
    return null;
  }
}

/** Folder holding every saved listing stream, or null when no root is known. */
export function jobListingStreamRoot() {
  const root = sharedAppDataRoot();
  return root ? path.join(root, 'job-streams') : null;
}
