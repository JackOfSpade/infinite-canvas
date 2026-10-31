import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SOURCE_FILES = ['electron/ipc/resumeHtml.js', 'electron/ipc/resumeRender.js'];
const CSS_FILES = ['colors_and_type.css', 'resume.css', 'cover-letter.css'];
const FONT_EXTENSION = /\.(?:ttf|otf|ttc|woff2?)$/iu;
const SYSTEM_FONT_FAMILY = /^(?:Arial(?:[ .]|$)|Georgia(?:[ .]|$)|Menlo[.]|Times New Roman(?:[ .]|$)|Helvetica(?:Neue)?[.]|Courier(?: New)?(?:[ .]|$)|Apple Color Emoji[.]|Apple Symbols[.]|SFNS(?:Mono)?[.]|LastResort[.])/u;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

export function applicationRendererSourceDigest(root = process.cwd()) {
  return hash(JSON.stringify(SOURCE_FILES.map(file => [file, hash(fs.readFileSync(path.join(root, file)))])));
}

function fontFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...fontFiles(file));
    else if (entry.isFile() && FONT_EXTENSION.test(entry.name) && SYSTEM_FONT_FAMILY.test(entry.name)) files.push(file);
  }
  return files;
}

/** Hash actual assets, not mtimes. Missing inputs disable reuse rather than weakening it. */
export function applicationRendererAssetDigest({ sourceDigest, designDir, fontContract, electronVersion, fontPaths }) {
  if (!sourceDigest || !electronVersion) return null;
  const styles = CSS_FILES.map(file => {
    const source = path.join(designDir, file);
    const bytes = fs.readFileSync(source);
    const localFonts = [];
    for (const match of bytes.toString('utf8').matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/giu)) {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(match[1])) continue;
      const asset = path.resolve(path.dirname(source), match[1]);
      const relative = path.relative(path.resolve(designDir), asset);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !FONT_EXTENSION.test(asset))
        throw new Error('Invalid renderer font asset.');
      localFonts.push([relative, hash(fs.readFileSync(asset))]);
    }
    return [file, hash(bytes), localFonts];
  });
  return hash(JSON.stringify({ sourceDigest, styles, fontContract, electronVersion,
    fonts: fontPaths.slice().sort().map(file => [file, hash(fs.readFileSync(file))]) }));
}

const versions = new Map();
export function applicationV2RendererVersion({ designDir, fontContract, sourceRoot = process.cwd(),
  electronVersion = process.versions.electron, platform = process.platform,
  fontRoots = ['/System/Library/Fonts', '/Library/Fonts', path.join(os.homedir(), 'Library/Fonts')],
} = {}) {
  try {
    if (platform !== 'darwin' || !electronVersion) return null;
    // Main-process Vite supplies the exact source digest because packaged apps do not ship source .js files.
    // eslint-disable-next-line no-undef
    const builtSourceDigest = typeof __APPLICATION_RENDERER_SOURCE_SHA256__ === 'string' ? __APPLICATION_RENDERER_SOURCE_SHA256__ : null;
    const paths = fontRoots.filter(root => fs.existsSync(root)).flatMap(fontFiles).sort();
    if (!['Arial', 'Georgia', 'Menlo'].every(family => paths.some(file => path.basename(file).startsWith(`${family}.`)))) return null;
    const styles = CSS_FILES.map(file => path.join(designDir, file));
    const localFonts = styles.flatMap(file => [...fs.readFileSync(file, 'utf8').matchAll(/url\(\s*['"]?([^'"\s)]+)['"]?\s*\)/giu)]
      .filter(match => !/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/iu.test(match[1]))
      .map(match => path.resolve(path.dirname(file), match[1])));
    const files = [...styles, ...paths, ...localFonts, ...(!builtSourceDigest ? SOURCE_FILES.map(file => path.join(sourceRoot, file)) : [])];
    const signature = JSON.stringify(files.map(file => {
      const stat = fs.statSync(file);
      return [file, stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs];
    }));
    const cacheKey = JSON.stringify([designDir, fontContract, electronVersion, sourceRoot, builtSourceDigest, fontRoots]);
    const prior = versions.get(cacheKey);
    if (prior?.signature === signature) return prior.version;
    const sourceDigest = builtSourceDigest || applicationRendererSourceDigest(sourceRoot);
    const version = applicationRendererAssetDigest({ sourceDigest, designDir, fontContract,
      electronVersion, fontPaths: paths });
    if (version) {
      versions.delete(cacheKey); versions.set(cacheKey, { signature, version });
      while (versions.size > 8) versions.delete(versions.keys().next().value);
    }
    return version;
  } catch { return null; }
}
