import electronPkg from 'electron';
import { handleSafe } from './ipcUtils.js';
import {
  careerSnapshotStorageRoot,
  readPinnedCareerSnapshot,
  vettedCareerSkillInventory,
} from './careerSnapshot.js';

const { app } = electronPkg;

// Snapshot IDs are content addresses.  Do not trim or normalize renderer input:
// accepting a near-match would make the boundary's address contract ambiguous.
const SNAPSHOT_ID_RE = /^[a-f0-9]{64}$/u;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,160}$/u;

function string(value) {
  return typeof value === 'string' ? value : '';
}

function strings(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function evidenceSegmentIds(value) {
  // Evidence IDs are opaque provenance handles, not source content. Keep the
  // snapshot schema's exact grammar at this secondary boundary as well, so a
  // future caller cannot smuggle arbitrary strings into UI attribution.
  return strings(value).filter(id => /^segment-[0-9]{4,}$/u.test(id));
}

function entities(value) {
  return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)) : [];
}

function metrics(value) {
  return entities(value).map(metric => ({
    label: string(metric.label),
    value: string(metric.value),
    unit: string(metric.unit),
    evidenceSegmentIds: evidenceSegmentIds(metric.evidenceSegmentIds),
  }));
}

/** True only for an exact, lowercase SHA-256 snapshot address. */
export function isInterviewHelperSnapshotId(snapshotId) {
  return typeof snapshotId === 'string' && SNAPSHOT_ID_RE.test(snapshotId);
}

/** Node-scoped IPC work must name the owner that can cancel it. */
export function isInterviewHelperNodeId(nodeId) {
  // handleSafe records node IDs in its task registry and diagnostic logs.
  // Accept the canvas factory's UUID/prefix grammar, but not whitespace,
  // control characters, punctuation, or arbitrary imported identifiers.
  return typeof nodeId === 'string' && NODE_ID_RE.test(nodeId);
}

function validateInterviewHelperRequestArgs(args) {
  // `handleSafe` provides generic task/recovery metadata for routes that opt
  // into it. This small read-only route does not: reject every unrecognised
  // key before the generic wrapper can read it into task diagnostics/context.
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new TypeError('Interview Helper requires only nodeId and snapshotId.');
  }
  // Electron IPC structured cloning yields a plain object, but direct/internal
  // callers can supply inherited values. handleSafe reads generic metadata by
  // property access, so accept only ordinary or null-prototype records and
  // inspect all own keys (including non-enumerable and symbol properties).
  const prototype = Object.getPrototypeOf(args);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('Interview Helper requires only nodeId and snapshotId.');
  }
  const keys = Reflect.ownKeys(args);
  if (keys.length !== 2
    || !Object.hasOwn(args, 'nodeId')
    || !Object.hasOwn(args, 'snapshotId')
    || keys.some(key => key !== 'nodeId' && key !== 'snapshotId')) {
    throw new TypeError('Interview Helper requires only nodeId and snapshotId.');
  }
  if (!isInterviewHelperNodeId(args?.nodeId)) {
    throw new TypeError('Interview Helper requires a valid node id.');
  }
  if (!isInterviewHelperSnapshotId(args?.snapshotId)) {
    throw new TypeError('Interview Helper requires a valid career snapshot id.');
  }
}

/**
 * A deliberately small, typed career projection for local interview matching.
 *
 * The snapshot reader has already verified approval, historical compatibility,
 * and literal grounding.  This projection is still intentionally explicit: it
 * never forwards the profile object wholesale, so source text, source-segment
 * contents, legacy source projections, identity contacts, and later-added
 * snapshot fields cannot cross the renderer boundary by accident. Opaque
 * evidence segment IDs are intentionally retained for UI attribution.
 */
export function projectInterviewHelperCareerSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !isInterviewHelperSnapshotId(snapshot.snapshotId)
    || snapshot.status !== 'approved' || !snapshot.profile || typeof snapshot.profile !== 'object') {
    throw new TypeError('A validated approved career snapshot is required.');
  }

  const profile = snapshot.profile;
  return {
    snapshotId: snapshot.snapshotId,
    schemaVersion: Number.isInteger(snapshot.schemaVersion) ? snapshot.schemaVersion : null,
    profile: {
      roles: entities(profile.roles).map(role => ({
        id: string(role.id),
        title: string(role.title),
        employer: string(role.employer),
        startDate: string(role.startDate),
        endDate: string(role.endDate),
        location: string(role.location),
        achievementIds: strings(role.achievementIds),
        skillIds: strings(role.skillIds),
        evidenceSegmentIds: evidenceSegmentIds(role.evidenceSegmentIds),
      })),
      achievements: entities(profile.achievements).map(achievement => ({
        id: string(achievement.id),
        roleId: string(achievement.roleId),
        claim: string(achievement.claim),
        technologies: strings(achievement.technologies),
        metrics: metrics(achievement.metrics),
        evidenceSegmentIds: evidenceSegmentIds(achievement.evidenceSegmentIds),
      })),
      projects: entities(profile.projects).map(project => ({
        id: string(project.id),
        roleId: string(project.roleId),
        name: string(project.name),
        description: string(project.description),
        technologies: strings(project.technologies),
        metrics: metrics(project.metrics),
        evidenceSegmentIds: evidenceSegmentIds(project.evidenceSegmentIds),
      })),
      // Relationship-qualified skills are not safe to present as an
      // unqualified answer. The central inventory retains historical behavior
      // while admitting current skills only when direct support was audited.
      skills: vettedCareerSkillInventory(profile).map(skill => ({
        id: string(skill.id),
        name: string(skill.name),
        category: string(skill.category),
        capabilityKind: string(skill.capabilityKind),
        supportMode: string(skill.supportMode),
        // The inventory is already the central eligibility gate. Preserve its
        // controlled boolean explicitly, rather than making the renderer
        // infer eligibility from support metadata. The local direct-usage
        // exception requires this exact true value.
        indexEligible: skill.indexEligible === true,
        roleIds: strings(skill.roleIds),
        evidenceSegmentIds: evidenceSegmentIds(skill.evidenceSegmentIds),
        directEvidenceSegmentIds: evidenceSegmentIds(skill.directEvidenceSegmentIds),
      })),
      education: entities(profile.education).map(item => ({
        id: string(item.id),
        credential: string(item.credential),
        institution: string(item.institution),
        dates: string(item.dates),
        evidenceSegmentIds: evidenceSegmentIds(item.evidenceSegmentIds),
      })),
      certifications: entities(profile.certifications).map(item => ({
        id: string(item.id),
        name: string(item.name),
        issuer: string(item.issuer),
        dates: string(item.dates),
        evidenceSegmentIds: evidenceSegmentIds(item.evidenceSegmentIds),
      })),
      otherEvidence: entities(profile.otherEvidence).map(item => ({
        id: string(item.id),
        kind: string(item.kind),
        label: string(item.label),
        text: string(item.text),
        evidenceSegmentIds: evidenceSegmentIds(item.evidenceSegmentIds),
      })),
    },
  };
}

/**
 * Read one approved (including historically valid pinned) snapshot and apply
 * the renderer allowlist. Dependencies are injectable so tests require no
 * Electron runtime or on-disk snapshot store.
 */
export async function loadInterviewHelperCareerSnapshot({
  snapshotId,
  userDataPath,
  readSnapshot = readPinnedCareerSnapshot,
  storageRoot = careerSnapshotStorageRoot,
} = {}) {
  if (!isInterviewHelperSnapshotId(snapshotId)) {
    throw new TypeError('Interview Helper requires a valid career snapshot id.');
  }
  if (typeof userDataPath !== 'string' || !userDataPath) {
    throw new TypeError('Interview Helper requires an Electron user-data path.');
  }
  if (typeof readSnapshot !== 'function' || typeof storageRoot !== 'function') {
    throw new TypeError('Interview Helper snapshot reader is unavailable.');
  }
  const snapshot = await readSnapshot(storageRoot(userDataPath), snapshotId);
  return snapshot ? projectInterviewHelperCareerSnapshot(snapshot) : null;
}

/** Register the one read-only, node-cancellable Interview Helper IPC route. */
export function registerInterviewHelperHandlers({
  appInstance = app,
  registerHandler = handleSafe,
  loadSnapshot = loadInterviewHelperCareerSnapshot,
} = {}) {
  if (!appInstance || typeof appInstance.getPath !== 'function') {
    throw new TypeError('Interview Helper requires the Electron app path provider.');
  }
  if (typeof registerHandler !== 'function' || typeof loadSnapshot !== 'function') {
    throw new TypeError('Interview Helper IPC registration dependencies are unavailable.');
  }

  registerHandler('load-interview-helper-career-snapshot', async (_event, args = {}, signal) => {
    // Keep defense in depth for alternate registration seams. The handleSafe
    // option below is the authoritative pre-registration boundary: it runs
    // before this request's node ID can reach task bookkeeping or diagnostics.
    validateInterviewHelperRequestArgs(args);
    if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');

    try {
      const snapshot = await loadSnapshot({
        snapshotId: args.snapshotId,
        userDataPath: appInstance.getPath('userData'),
      });
      if (signal?.aborted) throw signal.reason || new Error('Operation cancelled');
      return { snapshot };
    } catch (error) {
      // The snapshot reader can identify local storage paths in a low-level
      // error. Keep those out of the renderer IPC reply and diagnostics surface.
      if (signal?.aborted) throw signal.reason || error;
      throw new Error('The selected career snapshot could not be read safely.');
    }
  }, { validateArgs: validateInterviewHelperRequestArgs });
}
