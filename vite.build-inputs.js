// Records which project files a build actually read, as a sorted JSON list.
// Each app's launcher rebuilds that app only when one of the listed files
// changes, so an edit that concerns only the other app does not rebuild it.
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

/** One shared plugin instance per build: add it to the renderer and to every Electron entry. */
export function buildInputsManifest(manifestFile, name = 'build-inputs') {
  const root = process.cwd()
  const seen = new Set()
  const manifestPath = path.join(root, manifestFile)
  const collect = function () {
    for (const id of this.getModuleIds()) {
      const file = id.split('?')[0]
      if (!path.isAbsolute(file) || file.includes(`${path.sep}node_modules${path.sep}`)) continue
      const relative = path.relative(root, file)
      if (!relative.startsWith('..') && fs.existsSync(file)) seen.add(relative.split(path.sep).join('/'))
    }
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
    fs.writeFileSync(manifestPath, `${JSON.stringify([...seen].sort(), null, 1)}\n`)
  }
  return { name, buildEnd: collect }
}
