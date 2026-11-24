/**
 * Which of the three apps this process is (src/utils/appRoleRules.js).
 *
 * All three are packaged from the same built code. What differs is each
 * package's own package.json, written at packaging time: its `name` (which is
 * what gives each app its own data folder under Application Support, and so its
 * own settings, Chrome profile and single-instance lock), its product name,
 * and `appRole`. An unpackaged run names its role with INFINITE_CANVAS_APP_ROLE.
 * With neither, the role is 'all': every module, as before the split.
 */
import fs from 'node:fs';
import path from 'node:path';
import electronPkg from 'electron';
import { appRoleHas, normalizeAppRole } from '../src/utils/appRoleRules.js';

const { app } = electronPkg;

let cached = null;

export function resolveAppRole({ env = process.env, readPackage = null } = {}) {
  const fromEnv = typeof env?.INFINITE_CANVAS_APP_ROLE === 'string' ? env.INFINITE_CANVAS_APP_ROLE.trim() : '';
  if (fromEnv) return normalizeAppRole(fromEnv);
  try {
    const read = readPackage || (() => JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')));
    const role = read()?.appRole;
    return typeof role === 'string' ? normalizeAppRole(role) : 'all';
  } catch {
    return 'all';
  }
}

export function appRole() {
  cached ||= resolveAppRole();
  return cached;
}

export function appHas(feature) {
  return appRoleHas(appRole(), feature);
}

/** Tests only. */
export function __setAppRoleForTests(role) {
  cached = role == null ? null : normalizeAppRole(role);
}
