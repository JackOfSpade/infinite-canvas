// GENERATION-TIME ONLY. Loads the real app modules in memory so the fixture
// generator can call the app's own prompt builder and validators instead of
// re-typing their wording. The spike server never imports this file or the app.
//
// How: Node's module.registerHooks() installs two hooks for this process only.
//   resolve: maps the bare specifiers 'electron' and 'electron-store' to tiny
//            data: URL stubs (no Electron binary, no files, no app-data folder).
//   load:    appends an `export { ... }` line to electron/ipc/localAiApplication.js
//            so its unexported prompt builder and grading helpers can be called.
// Nothing is written anywhere. If the app renames one of the names below the
// load fails loudly with a SyntaxError, which is the intended failure mode.
import * as nodeModule from 'node:module'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const NOOP = 'const noop = () => {};'

const ELECTRON_STUB = `data:text/javascript,${encodeURIComponent(`
${NOOP}
export const app = { isPackaged: false, getPath: () => '/nonexistent-synthetic', getName: () => 'synthetic', getVersion: () => '0.0.0', whenReady: () => Promise.resolve(), on: noop, once: noop, quit: noop, exit: noop };
export class BrowserWindow { constructor() { this.webContents = { send: noop, isDestroyed: () => false, executeJavaScript: () => Promise.resolve() }; } static getAllWindows() { return []; } static getFocusedWindow() { return null; } }
export class BrowserView { constructor() { this.webContents = { send: noop }; } }
export const ipcMain = { handle: noop, handleOnce: noop, removeHandler: noop, on: noop, once: noop, removeListener: noop, removeAllListeners: noop };
export const shell = { openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop, trashItem: async () => {} };
export const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }), showMessageBox: async () => ({ response: 0 }), showErrorBox: noop };
export const protocol = {};
export const session = {};
export const screen = {};
export const nativeImage = {};
export const clipboard = {};
export const Menu = {};
export const powerMonitor = { on: noop };
export const powerSaveBlocker = {};
export const safeStorage = {};
export const net = {};
export const crashReporter = {};
export const globalShortcut = {};
export class Notification {}
export default { app, BrowserWindow, BrowserView, ipcMain, shell, dialog, protocol, session, screen, nativeImage, clipboard, Menu, powerMonitor, powerSaveBlocker, safeStorage, net, crashReporter, globalShortcut, Notification };
`)}`

const STORE_STUB = `data:text/javascript,${encodeURIComponent(`
export default class Store {
  constructor() { this.data = {}; }
  get(key, fallback) { return key in this.data ? this.data[key] : fallback; }
  set(key, value) { this.data[key] = value; }
  has(key) { return key in this.data; }
  delete(key) { delete this.data[key]; }
  clear() { this.data = {}; }
  get store() { return this.data; }
  get path() { return ''; }
}
`)}`

// Unexported names of localAiApplication.js that the generator calls.
const UNEXPORTED = [
  'pastePrompt', 'pasteBaseHashesFor', 'pasteJsonHash', 'jobListingQuoteSource', 'safeJob', 'cleanText',
  'validatePasteResponse', 'assertFrozenJobState', 'completedResultValidationOptions',
]

let cached = null

/** Repo HEAD, so a manifest says which app source the prompts were built from. */
export function gitHead(repoRoot) {
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

/** Paths under `paths` with uncommitted changes (empty when the tree is clean there). */
export function gitDirtyPaths(repoRoot, paths) {
  const out = execFileSync('git', ['status', '--porcelain', '--', ...paths], { cwd: repoRoot, encoding: 'utf8' })
  return out.split('\n').map(line => line.slice(3)).filter(Boolean)
}

/** The committer date of HEAD, used as the deterministic "generatedAt". */
export function gitHeadDate(repoRoot) {
  return execFileSync('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim()
}

export async function loadApp(repoRoot) {
  if (cached) return cached
  if (typeof nodeModule.registerHooks !== 'function') {
    throw new Error(`The fixture generator needs module.registerHooks (Node 22.15 or newer); this is Node ${process.versions.node}.`)
  }
  const target = pathToFileURL(path.join(repoRoot, 'electron/ipc/localAiApplication.js')).href
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === 'electron') return { url: ELECTRON_STUB, shortCircuit: true }
      if (specifier === 'electron-store') return { url: STORE_STUB, shortCircuit: true }
      return nextResolve(specifier, context)
    },
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (url !== target) return loaded
      const exports = UNEXPORTED.map(name => `${name} as __${name}`).join(', ')
      return { ...loaded, source: `${String(loaded.source)}\nexport { ${exports} };\n`, shortCircuit: true }
    },
  })
  const [local, assembly, jobApp, structured, cover, bundle] = await Promise.all([
    import(target),
    import(pathToFileURL(path.join(repoRoot, 'electron/ipc/pasteApplicationAssembly.js')).href),
    import(pathToFileURL(path.join(repoRoot, 'electron/ipc/jobApplication.js')).href),
    import(pathToFileURL(path.join(repoRoot, 'electron/ipc/structuredResume.js')).href),
    import(pathToFileURL(path.join(repoRoot, 'electron/ipc/coverLetterChecks.js')).href),
    import(pathToFileURL(path.join(repoRoot, 'electron/ipc/applicationBundle.js')).href),
  ])
  cached = { local, assembly, jobApp, structured, cover, bundle }
  return cached
}

// ------------------------------------------------------------ in-memory job

const PROTOCOL_VERSION = 1
const CANVAS_ROOT = '/synthetic/canvas'
const CANVAS_FILE = `${CANVAS_ROOT}/Canvas.json`

/**
 * An in-memory model of one paste-back application job: the frozen input record,
 * the frozen sources, and the paste state a stage prompt is built from. It
 * mirrors queueLocalApplicationJob() (electron/ipc/localAiApplication.js) and
 * the accept path of submitLocalApplicationHandoff(), without touching disk.
 */
export function createJobModel(app, content, { handoffCode, createdAt }) {
  const { local, assembly } = app
  const job = local.__safeJob(content.job)
  const careerData = local.__cleanText(content.careerData, assembly.MAX_FROZEN_SOURCE_CHARS)
  const jobListing = local.__jobListingQuoteSource(job)
  const input = JSON.parse(JSON.stringify({
    version: local.LOCAL_AI_APPLICATION_VERSION,
    jobId: content.jobId,
    createdAt,
    canvasFilePath: CANVAS_FILE,
    canvasRoot: CANVAS_ROOT,
    job,
    additionalNotes: app.jobApp.normalizeApplicationAdditionalNotes(''),
    reasoning: '',
    matchScore: null,
    achievements: null,
    mineAllowed: false,
    // Mirrors queueLocalApplicationJob: the résumé profile's work history.
    sourceRoles: content.roles.map(role => ({ id: role.id, title: role.title, company: role.employer, dates: role.dates, location: '' })),
    targetPageCount: app.jobApp.targetPageCountForJob(job.title),
    qualityChecklist: { version: local.APPLICATION_QUALITY_CHECKLIST_VERSION, criteria: local.APPLICATION_QUALITY_CRITERIA },
    generationAudit: { version: local.LOCAL_AI_GENERATION_AUDIT_VERSION, required: true },
  }))
  const paste = {
    version: PROTOCOL_VERSION,
    stage: 'evidence-plan',
    revision: 0,
    handoffCode,
    priorHandoffCodes: [],
    baseHashes: local.__pasteBaseHashesFor({}),
    evidencePlan: null,
    resume: null,
    coverLetter: null,
    findings: [],
    logCount: 0,
  }
  const manifest = {
    version: local.LOCAL_AI_APPLICATION_VERSION,
    id: content.jobId,
    status: 'queued',
    createdAt,
    canvasFilePath: CANVAS_FILE,
    canvasRoot: CANVAS_ROOT,
    generationAudit: { version: local.LOCAL_AI_GENERATION_AUDIT_VERSION, required: true },
    transport: 'paste',
    paste,
    files: ['input.json', 'context/job-listing.md', 'context/career-data.txt', 'Generation Log.jsonl', 'drafts/'],
  }

  const model = {
    input,
    manifest,
    careerData,
    jobListing,
    handoffCode,
    initialState: () => ({ ...paste, careerData, jobListing }),
    /** The real pastePrompt() for a state. */
    prompt: (state) => local.__pastePrompt({ input, state }),
    /** The real validatePasteResponse(): [] means the app would accept the answer. */
    validate: (state, answer) => local.__validatePasteResponse(JSON.parse(JSON.stringify(answer)), state, input, {}),
    /** Grade the frozen state the way every paste surface does at load. */
    assertFrozen: (state) => {
      const { careerData: _careerData, jobListing: _jobListing, ...persisted } = state
      return local.__assertFrozenJobState({
        jobId: input.jobId, manifest: { ...manifest, paste: persisted }, input, careerData, jobListing,
      })
    },
    /**
     * The next state after `answer` is accepted for `state`, following the accept
     * path of submitLocalApplicationHandoff for the three drafting stages.
     */
    accept: (state, answer) => {
      const parsed = JSON.parse(JSON.stringify(answer))
      const { careerData: _c, jobListing: _j, ...persisted } = state
      const next = { ...persisted, revision: state.revision + 1, findings: [] }
      if (state.stage === 'evidence-plan') {
        next.evidencePlan = parsed
        next.trustedIdentity = app.structured.projectTrustedIdentity(parsed.identity)
        next.stage = 'resume'
      } else if (state.stage === 'resume') {
        next.resume = parsed.resume
        next.stage = 'cover-letter'
      } else if (state.stage === 'cover-letter') {
        next.coverLetter = parsed.coverLetter
        next.stage = 'review'
      } else {
        next.stage = 'completed'
        next.finalReview = parsed
      }
      next.baseHashes = local.__pasteBaseHashesFor(next)
      next.handoffCode = next.stage === 'completed' ? null : handoffCode
      next.logCount = (state.logCount || 0) + 1
      return { ...next, careerData, jobListing }
    },
    /**
     * The completion gate a passing review meets: assemble the finished package
     * from frozen state and run the app's own result validator on it. Returns []
     * when the app would accept the package, else the failure messages.
     */
    completionErrors: (completedState) => {
      const { careerData: _c, jobListing: _j, ...persisted } = completedState
      const paste = persisted
      try {
        const frozen = local.__assertFrozenJobState({ jobId: input.jobId, manifest: { ...manifest, paste }, input, careerData, jobListing })
        const options = local.__completedResultValidationOptions({ manifest: { ...manifest, paste }, frozen })
        const raw = assembly.assemblePasteApplicationResult({ input, paste, careerData, jobListing })
        local.stampPasteQualityReviewFromFit(raw, null)
        local.validateLocalApplicationResult(raw, input.jobId, input.canvasRoot, input.job, options)
        return []
      } catch (error) {
        return [String(error?.message || error)]
      }
    },
  }
  return model
}
