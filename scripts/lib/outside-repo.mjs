// Path checks shared by the scripts that write private output and must keep it
// out of the repository. Symlinks are resolved through the nearest existing
// parent, so a link cannot place output inside the checkout.
import fs from 'node:fs';
import path from 'node:path';

/** True when `child` is `parent` itself or lies inside it. Both must already be resolved. */
export function isPathInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** The real path of `target`, with a not-yet-existing tail kept as written. Async; other errors than ENOENT are thrown. */
export async function resolveThroughExistingParent(target) {
  let probe = path.resolve(target);
  const rest = [];
  for (;;) {
    try { probe = await fs.promises.realpath(probe); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(probe);
      if (parent === probe) break;
      rest.unshift(path.basename(probe)); probe = parent;
    }
  }
  return path.join(probe, ...rest);
}

/** Sync twin: a path that cannot be resolved is returned as plain `path.resolve` output. */
export function resolveThroughExistingParentSync(target) {
  const resolved = path.resolve(target);
  let current = resolved;
  const rest = [];
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return resolved;
    rest.unshift(path.basename(current));
    current = parent;
  }
  try { return path.join(fs.realpathSync(current), ...rest); } catch { return resolved; }
}
