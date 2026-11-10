// Tracks the Claude model ids this app's model/effort choices were calibrated
// on. A call that answers with any other id means the calibration is stale, so
// the app persists that id and the renderer shows a recalibration banner until
// CALIBRATED_MODELS below is updated in code.
import fs from 'node:fs';
import path from 'node:path';

// These must match "Model versions tested" in docs/ai-model-selection.md. After
// following its "New model release playbook", update them to the newly tested
// ids (and CALIBRATED_ON to that day); doing so clears the recalibration banner.
export const CALIBRATED_MODELS = Object.freeze({
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
});
export const CALIBRATED_ON = '2026-11-10';
export const MODEL_CALIBRATION_FILE = 'ai-model-calibration.json';
export const MODEL_CALIBRATION_STATUS_CHANNEL = 'ai-model-calibration:status';
export const MODEL_CALIBRATION_EVENT = 'ai-model-calibration:changed';
export const PLAYBOOK_REF = 'docs/ai-model-selection.md, section "New model release playbook"';
const STORED_VERSION = 1;
const MAX_SOURCES = 5;
const MAX_ID_LENGTH = 200;

/** `claude-<family>-<version>` -> { family, version, normalized }, or null. */
export function parseClaudeModelId(id) {
  if (typeof id !== 'string') return null;
  let value = id.trim();
  if (!value || value.length > MAX_ID_LENGTH) return null;
  // A trailing display suffix such as "[1m]" is not part of the model id.
  value = value.replace(/\[[^\]]*\]$/u, '').trim();
  // Provider snapshots append a release date; it names the same model version.
  value = value.replace(/-\d{8}$/u, '').trim();
  const match = /^claude-([a-z]+)-([a-z0-9][a-z0-9.-]*)$/u.exec(value);
  if (!match) return null;
  const [, family, version] = match;
  return { family, version, normalized: `claude-${family}-${version}` };
}

function calibratedIdFor(family, calibrated) {
  if (!calibrated || typeof calibrated !== 'object') return null;
  const value = calibrated[family];
  if (typeof value !== 'string' || !value.trim()) return null;
  return parseClaudeModelId(value)?.normalized ?? value.trim();
}

/** null when the id is unparseable or still matches the calibrated id. */
export function assessModel(id, calibrated = CALIBRATED_MODELS) {
  const parsed = parseClaudeModelId(id);
  if (!parsed) return null;
  const calibratedId = calibratedIdFor(parsed.family, calibrated);
  if (calibratedId && calibratedId === parsed.normalized) return null;
  return {
    modelId: parsed.normalized,
    family: parsed.family,
    kind: calibratedId ? 'new-version' : 'new-family',
    calibratedId,
  };
}

function isoAt(now) {
  let value;
  try { value = typeof now === 'function' ? now() : Date.now(); } catch { value = Date.now(); }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function loadDetections(filePath) {
  const empty = Object.create(null);
  if (!filePath) return empty;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    // A missing or corrupt file simply starts empty; it never blocks a call.
    return empty;
  }
  const stored = parsed && typeof parsed === 'object' && parsed.detections && typeof parsed.detections === 'object'
    ? parsed.detections
    : null;
  if (!stored) return empty;
  const detections = Object.create(null);
  for (const entry of Object.values(stored)) {
    if (!entry || typeof entry !== 'object') continue;
    if (typeof entry.modelId !== 'string' || !entry.modelId) continue;
    detections[entry.modelId] = {
      modelId: entry.modelId,
      family: typeof entry.family === 'string' ? entry.family : null,
      kind: entry.kind === 'new-family' ? 'new-family' : 'new-version',
      calibratedId: typeof entry.calibratedId === 'string' ? entry.calibratedId : null,
      firstSeenAt: typeof entry.firstSeenAt === 'string' ? entry.firstSeenAt : new Date(0).toISOString(),
      lastSeenAt: typeof entry.lastSeenAt === 'string' ? entry.lastSeenAt : new Date(0).toISOString(),
      count: Number.isFinite(entry.count) ? entry.count : 1,
      sources: Array.isArray(entry.sources)
        ? entry.sources.filter(source => typeof source === 'string' && source).slice(0, MAX_SOURCES)
        : [],
    };
  }
  return detections;
}

export function createModelCalibrationMonitor({
  userData,
  calibrated = CALIBRATED_MODELS,
  calibratedOn = CALIBRATED_ON,
  now = () => Date.now(),
  onChange = () => {},
} = {}) {
  const filePath = userData ? path.join(String(userData), MODEL_CALIBRATION_FILE) : null;
  let detections = loadDetections(filePath);

  function persist() {
    if (!filePath) return;
    const directory = path.dirname(filePath);
    const temporary = path.join(directory, `.${MODEL_CALIBRATION_FILE}.${process.pid}.${Date.now()}.tmp`);
    const payload = `${JSON.stringify({ version: STORED_VERSION, detections }, null, 2)}\n`;
    try {
      fs.mkdirSync(directory, { recursive: true });
      const handle = fs.openSync(temporary, 'w', 0o600);
      try {
        fs.writeFileSync(handle, payload, 'utf8');
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temporary, filePath);
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* nothing to clean up */ }
      throw error;
    }
  }

  function status() {
    const detectionsOut = [];
    for (const entry of Object.values(detections)) {
      // Only entries the CURRENT calibration still disagrees with: updating
      // CALIBRATED_MODELS in code is what clears the banner.
      if (!assessModel(entry.modelId, calibrated)) continue;
      detectionsOut.push({ ...entry, sources: [...entry.sources] });
    }
    detectionsOut.sort((a, b) => (a.firstSeenAt < b.firstSeenAt ? -1 : a.firstSeenAt > b.firstSeenAt ? 1 : 0));
    return {
      due: detectionsOut.length > 0,
      calibrated,
      calibratedOn,
      detections: detectionsOut,
      playbook: PLAYBOOK_REF,
    };
  }

  function note(modelId, { source } = {}) {
    try {
      const assessment = assessModel(modelId, calibrated);
      if (!assessment) return null;
      const timestamp = isoAt(now);
      const existing = detections[assessment.modelId];
      const created = !existing;
      const sources = existing ? [...existing.sources] : [];
      if (typeof source === 'string' && source && !sources.includes(source)) sources.push(source);
      const entry = {
        ...assessment,
        firstSeenAt: existing?.firstSeenAt ?? timestamp,
        lastSeenAt: timestamp,
        count: (Number(existing?.count) || 0) + 1,
        sources: sources.slice(0, MAX_SOURCES),
      };
      detections = { ...detections, [assessment.modelId]: entry };
      persist();
      if (created) {
        try { onChange(status()); } catch { /* a listener must not fail the call */ }
      }
      return entry;
    } catch {
      return null;
    }
  }

  return { note, status };
}

let singleton = null;

function broadcast(status, getAllWindows) {
  let windows = [];
  try { windows = typeof getAllWindows === 'function' ? getAllWindows() : []; } catch { return; }
  for (const win of Array.isArray(windows) ? windows : []) {
    try {
      if (!win || win.isDestroyed?.()) continue;
      const contents = win.webContents;
      if (!contents || contents.isDestroyed?.()) continue;
      contents.send(MODEL_CALIBRATION_EVENT, status);
    } catch { /* one window must not break the others */ }
  }
}

export function configureModelCalibration({ userData, getAllWindows, onChange, ...rest } = {}) {
  singleton = createModelCalibrationMonitor({
    userData,
    ...rest,
    onChange: status => {
      broadcast(status, getAllWindows);
      try { onChange?.(status); } catch { /* listener only */ }
    },
  });
  return singleton;
}

export function noteResolvedClaudeModel(modelId, source) {
  try {
    if (!singleton) return null;
    return singleton.note(modelId, source ? { source } : {});
  } catch {
    return null;
  }
}

export function getModelCalibrationStatus() {
  try {
    if (singleton) return singleton.status();
  } catch { /* fall through to the not-configured answer */ }
  return { due: false, calibrated: CALIBRATED_MODELS, calibratedOn: CALIBRATED_ON, detections: [], playbook: PLAYBOOK_REF };
}

export function registerModelCalibrationHandler({ ipcMain } = {}) {
  if (!ipcMain) return;
  try { ipcMain.removeHandler?.(MODEL_CALIBRATION_STATUS_CHANNEL); } catch { /* fresh app: no handler */ }
  ipcMain.handle(MODEL_CALIBRATION_STATUS_CHANNEL, () => getModelCalibrationStatus());
}

export function resetModelCalibrationForTests() {
  singleton = null;
}
