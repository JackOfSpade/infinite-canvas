import { assert } from './testHelpers.js';
import { adaFlow } from './fixtures/handoff-bridge/adaFlow.js';
import { persona } from './fixtures/handoff-bridge/synthetic.js';
import {
  discoverLocalApplicationJobs,
  fs,
  getLocalApplicationHandoff,
  localApplicationStatus,
  os,
  path,
  queueLocalApplicationJob,
  submitLocalApplicationHandoff,
} from '../test-dependencies.js';
import {
  classifyApplicationThrow,
  cleanConfirmText,
  createApplicationSource,
  isAdoptableStatus,
  mapApplicationStatus,
} from '../../electron/ipc/handoffBridge/sources/application.js';
import { createHandoffCodeGuard } from '../../electron/ipc/handoffBridge/lanes.js';

const lane = Object.freeze({ jobId: 'job-ada-0001', canvasFilePath: '/tmp/ada.canvas' });
const handoff = Object.freeze({
  handoffCode: 'BRIDGE-CODE', stage: 'resume', revision: 2, prompt: 'Prompt bytes \u03bb',
  draft: 'private draft', corrections: ['fix field'], correctionPrompt: 'repair', correctionsRecovered: { active: true },
  localJob: { folder: '/private/path' }, baseHashes: { private: 'hash' },
});
const codeGuard = createHandoffCodeGuard();

function source(overrides = {}) {
  const api = {
    getLocalApplicationHandoff: async () => ({ handoff }),
    submitLocalApplicationHandoff: async () => ({ accepted: true, completed: false, handoff }),
    localApplicationStatus: async () => ({ status: 'queued' }),
    discoverLocalApplicationJobs: async () => [{
      id: lane.jobId, canvasFilePath: '/tmp/canonical.canvas', createdAt: '2026-09-27T12:00:00.000Z',
      job: { title: 'Ada Lovelace Engineer', company: 'Example Labs' },
    }],
    ...(overrides.api || {}),
  };
  return createApplicationSource({
    api,
    watchdogMs: 5,
    // Keep the watchdog timer referenced in this standalone Node group. The
    // app's event loop stays alive in production, where the timer may unref.
    setTimeoutImpl: (fn, ms) => { setTimeout(fn, ms); return 0; },
    codeGuard,
    ...(overrides.options || {}),
  });
}

export default [
  {
    name: 'handoff bridge: application: injected guard makes rotated-code detection timing-safe and wrapper-aware',
    run: async () => {
      const wrapped = source({ api: { submitLocalApplicationHandoff: async () => ({ accepted: false, handoff }) } });
      const same = await wrapped.submit(lane, { code: ' `BRIDGE-CODE` ', text: '{}' });
      const lower = await wrapped.submit(lane, { code: 'bridge-code', text: '{}' });
      assert(same.rotated === false && lower.rotated === true, 'only canonical edge wrappers may preserve an application code');
    },
  },
  {
    name: 'handoff bridge: application: Ada fixture and the four frozen adapter exports are available',
    run: () => {
      assert(adaFlow.map(step => step.stage).join(',') === 'evidence-plan,resume,cover-letter,review', 'the fixture must model the app handoff order');
      assert(persona.email.endsWith('@example.com') && /^555-01\d\d$/.test(persona.phone), 'application fixtures must be synthetic');
      for (const exported of [getLocalApplicationHandoff, submitLocalApplicationHandoff, localApplicationStatus, discoverLocalApplicationJobs]) assert(typeof exported === 'function', 'the adapter must use a frozen app export');
    },
  },
  {
    name: 'handoff bridge: application: scratch app read keeps prompt bytes and confirm data disk-derived',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'handoff-bridge-application-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath,
          careerData: 'Ada Lovelace\nada@example.com\nSoftware Engineer\nBuilt reliable reporting systems.',
          job: { title: 'Application Engineer', company: 'Example Labs', snippet: 'Build reliable reporting systems.' },
          resumeProfile: { workHistory: [{ id: 'ada-role', title: 'Software Engineer', employer: 'Example Labs', startDate: '2020', endDate: '2024' }] },
        });
        const raw = await getLocalApplicationHandoff({ jobId: queued.id, canvasFilePath });
        const adapter = createApplicationSource();
        const result = await adapter.read({ jobId: queued.id, canvasFilePath });
        const confirm = await adapter.describeForConfirm(canvasFilePath, [queued.id]);
        assert(result.kind === 'open' && result.handoff.prompt === raw.handoff.prompt, 'prompt must be byte-for-byte preserved');
        assert(Object.keys(result.handoff).join(',') === 'code,stage,revision,prompt,corrections,correctionPrompt,recovered,draftBytes', 'read must expose only the handoff projection');
        assert(confirm.ok && confirm.canvasFilePath === canvasFilePath && confirm.items[0].title === 'Application Engineer', 'confirm data must be discovered from disk');
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
  { name: 'handoff bridge: application: completed read becomes host', run: async () => assert((await source({ api: { getLocalApplicationHandoff: async () => ({ completed: true }) } }).read(lane)).kind === 'host', 'completed app state must become host') },
  { name: 'handoff bridge: application: malformed handoff is a fixed shape failure', run: async () => assert((await source({ api: { getLocalApplicationHandoff: async () => ({ handoff: { prompt: 'only prompt' } }) } }).read(lane)).shape === true, 'bad app handoff must not be copied') },
  {
    name: 'handoff bridge: application: read watchdog returns busy and preserves the shared call',
    run: async () => {
      let calls = 0; let release;
      const pending = new Promise(resolve => { release = resolve; });
      const adapter = source({ api: { getLocalApplicationHandoff: async () => { calls++; return pending; } } });
      const [first, second] = await Promise.all([adapter.read(lane), adapter.read(lane)]);
      assert(first.kind === 'busy' && second.kind === 'busy' && calls === 1, 'a locked app job must be a single busy read');
      release({ handoff }); await new Promise(resolve => setTimeout(resolve, 0));
      assert((await adapter.read(lane)).kind === 'open' && calls === 2, 'the settled slot must permit a later refresh');
    },
  },
  { name: 'handoff bridge: application: terminal status mapping is field-based', run: () => { assert(mapApplicationStatus({ status: 'saved' }).phase === 'done', 'saved must be done'); assert(mapApplicationStatus({ status: 'failed', folder: null }).phase === 'gone', 'removed folders must be gone'); assert(mapApplicationStatus({ status: 'failed', folder: '/safe' }).reason === 'job_broken', 'trusted failed folders must be integrity failures'); } },
  { name: 'handoff bridge: application: queued status requests a fresh read', run: () => assert(mapApplicationStatus({ status: 'queued' }).read === true, 'queued status must kick a read') },
  { name: 'handoff bridge: application: completed and importing status are host', run: () => { for (const status of ['completed', 'importing']) assert(mapApplicationStatus({ status }).phase === 'host', `${status} must be host`); } },
  { name: 'handoff bridge: application: recoverable host statuses request a bounded read', run: () => { for (const status of ['revision-required', 'invalid']) assert(mapApplicationStatus({ status }).read === true, `${status} must be read-recovered`); } },
  { name: 'handoff bridge: application: render retry requires a person', run: () => assert(mapApplicationStatus({ status: 'render-retry-required' }).reason === 'render_retry', 'render retry must not be auto-driven') },
  { name: 'handoff bridge: application: unknown status is a shape failure', run: () => assert(mapApplicationStatus({ status: 'unknown' }).shape === true, 'unknown app status must fail closed') },
  {
    name: 'handoff bridge: application: status watchdog shares a call and returns busy',
    run: async () => {
      let calls = 0;
      const adapter = source({ api: { localApplicationStatus: async () => { calls++; return new Promise(() => {}); } } });
      assert((await adapter.status(lane)).kind === 'busy' && (await adapter.status(lane)).kind === 'busy' && calls === 1, 'status lock must have one app call');
    },
  },
  { name: 'handoff bridge: application: throws are classified only by error code', run: () => { const missing = classifyApplicationThrow({ code: 'ENOENT', message: '/private/secret' }); const integrity = classifyApplicationThrow({ code: 'LOCAL_AI_JOB_INTEGRITY', message: '/private/observation' }); const access = classifyApplicationThrow({ code: 'EPERM', message: 'private path' }); assert(missing.enoent && !Object.hasOwn(missing, 'message') && integrity.integrity && !integrity.message.includes('/private') && access.eaccess && !Object.hasOwn(access, 'message'), 'adapter errors must not expose app text'); } },
  {
    name: 'handoff bridge: application: accepted submit projects only completion and next handoff',
    run: async () => {
      const result = await source().submit(lane, { code: 'BRIDGE-CODE', text: '{}' });
      assert(result.kind === 'accepted' && result.next.code === 'BRIDGE-CODE', 'accepted result must preserve next code');
      assert(!JSON.stringify(result).includes('/private/path'), 'submit result must not expose local job data');
    },
  },
  {
    name: 'handoff bridge: application: rejected submit preserves same code',
    run: async () => {
      const result = await source({ api: { submitLocalApplicationHandoff: async () => ({ accepted: false, validationErrors: ['bad field'], handoff }) } }).submit(lane, { code: 'BRIDGE-CODE', text: '{}' });
      assert(result.kind === 'rejected' && result.rotated === false && result.validationErrors[0] === 'bad field', 'schema rejection must retain its code');
    },
  },
  {
    name: 'handoff bridge: application: completion rejection exposes rotated code',
    run: async () => {
      const rotated = { ...handoff, handoffCode: 'NEW-CODE' };
      const result = await source({ api: { submitLocalApplicationHandoff: async () => ({ accepted: false, validationErrors: [], handoff: rotated }) } }).submit(lane, { code: 'BRIDGE-CODE', text: '{}' });
      assert(result.rotated === true && result.handoff.code === 'NEW-CODE', 'host rejection must use the returned code');
    },
  },
  { name: 'handoff bridge: application: submit throw is code-classified', run: async () => assert((await source({ api: { submitLocalApplicationHandoff: async () => { const error = new Error('private'); error.code = 'LOCAL_AI_JOB_INTEGRITY'; throw error; } } }).submit(lane, { code: 'x', text: '{}' })).integrity === true, 'submit errors must not leak app text') },
  {
    name: 'handoff bridge: application: identical submits are single flight',
    run: async () => {
      let calls = 0; let release;
      const pending = new Promise(resolve => { release = resolve; });
      const adapter = source({ api: { submitLocalApplicationHandoff: async () => { calls++; return pending; } } });
      const one = adapter.submit(lane, { code: 'x', text: '{}' }); const two = adapter.submit(lane, { code: 'x', text: '{}' });
      release({ accepted: true, completed: true });
      assert((await one).completed && (await two).completed && calls === 1, 'identical submit retries must attach');
    },
  },
  {
    name: 'handoff bridge: application: describeForConfirm is disk-derived and canonical',
    run: async () => {
      const result = await source().describeForConfirm('/renderer-untrusted.canvas', [lane.jobId]);
      assert(result.ok && result.canvasFilePath === '/tmp/canonical.canvas' && result.items[0].jobId === lane.jobId, 'confirm data must come from discovery, not renderer labels');
    },
  },
  { name: 'handoff bridge: application: unknown confirm id is refused', run: async () => assert((await source().describeForConfirm('/tmp/a', ['not-present'])).code === 'unknown_job', 'undiscovered job must not be released') },
  {
    name: 'handoff bridge: application: confirm text strips controls bidi and clips hostile titles',
    run: async () => {
      const text = `Hostile\u202E\u0007 ${'title '.repeat(30)}`;
      const result = await source({ api: { discoverLocalApplicationJobs: async () => [{ id: lane.jobId, canvasFilePath: '/tmp/a', createdAt: '2026-09-27T12:00:00Z', job: { title: text, company: 'Example\u0000Co' } }] } }).describeForConfirm('/tmp/a', [lane.jobId]);
      assert(result.items[0].title.length <= 60 && !result.items[0].title.includes('\u0007') && !result.items[0].title.includes('\u202E') && result.items[0].company === 'Example Co', 'dialog text must be safe and clipped');
    },
  },
  {
    name: 'handoff bridge: application: createdAt provenance gates auto release after launch',
    run: () => {
      const adapter = source(); const launch = Date.parse('2026-09-27T12:00:00.000Z');
      assert(adapter.isAutoReleaseEligible({ createdAt: '2026-09-27T12:00:01.000Z' }, launch), 'post-launch job should qualify');
      assert(!adapter.isAutoReleaseEligible({ createdAt: '2026-09-26T12:00:00.000Z' }, launch), 'pre-launch job must not qualify');
    },
  },
  { name: 'handoff bridge: application: path adoption accepts only ownership-probed live statuses', run: () => { for (const status of ['queued', 'completed', 'importing', 'revision-required', 'invalid', 'render-retry-required']) assert(isAdoptableStatus({ status }), `${status} should prove candidate ownership`); } },
  {
    name: 'handoff bridge: application: path adoption refuses terminal or foreign statuses',
    run: async () => {
      const adapter = source({ api: { localApplicationStatus: async () => ({ status: 'saved', folder: null }) } });
      const refused = await adapter.adoptCanvasPath(lane.jobId, '/tmp/foreign.canvas', lane.canvasFilePath);
      assert(!refused.adopted && refused.canvasFilePath === lane.canvasFilePath, 'terminal status must not replace lane path');
      const thrown = source({ api: { localApplicationStatus: async () => { throw new Error('foreign'); } } });
      assert(!(await thrown.adoptCanvasPath(lane.jobId, '/tmp/foreign.canvas', lane.canvasFilePath)).adopted, 'ownership throw must retain old path');
    },
  },
  {
    name: 'handoff bridge: application: injected adapter failures release every single-flight slot',
    run: async () => {
      let reads = 0; let statuses = 0; let submits = 0;
      const adapter = source({ api: {
        getLocalApplicationHandoff: async () => { reads++; if (reads === 1) throw new Error('fault'); return { handoff }; },
        localApplicationStatus: async () => { statuses++; if (statuses === 1) throw new Error('fault'); return { status: 'queued' }; },
        submitLocalApplicationHandoff: async () => { submits++; if (submits === 1) throw new Error('fault'); return { accepted: true, completed: true }; },
        discoverLocalApplicationJobs: async () => { throw new Error('fault'); },
      } });
      assert((await adapter.read(lane)).kind === 'threw' && (await adapter.read(lane)).kind === 'open', 'read failure must release');
      assert((await adapter.status(lane)).kind === 'threw' && (await adapter.status(lane)).kind === 'awaiting', 'status failure must release');
      assert((await adapter.submit(lane, { code: 'a', text: '{}' })).kind === 'threw' && (await adapter.submit(lane, { code: 'b', text: '{}' })).kind === 'accepted', 'submit failure must release');
      const adopter = source({ api: { localApplicationStatus: async () => { throw new Error('fault'); } } });
      assert((await adapter.describeForConfirm('/tmp/a', [lane.jobId])).code === 'unavailable' && !(await adopter.adoptCanvasPath(lane.jobId, '/tmp/b', lane.canvasFilePath)).adopted, 'confirm and adoption failures must fail closed');
    },
  },
  {
    name: 'handoff bridge: application: watchdog setup failure never leaves a call pending',
    run: async () => {
      const adapter = source({ options: { setTimeoutImpl: () => { throw new Error('timer fault'); } } });
      const result = await adapter.read(lane);
      assert(result.kind === 'threw' && (await source().read(lane)).kind === 'open', 'watchdog errors must resolve to a fixed adapter outcome');
      assert(cleanConfirmText(' Ada\nLovelace ', 60) === 'Ada Lovelace', 'confirm cleaner must normalize display whitespace');
    },
  },
  {
    name: 'handoff bridge: application: describeForConfirm can answer for the jobs that still exist without weakening the manual confirmation',
    run: async () => {
      const partial = source({ api: { discoverLocalApplicationJobs: async () => [{
        id: lane.jobId, canvasFilePath: '/tmp/canonical.canvas', createdAt: '2026-09-27T12:00:00.000Z', job: { title: 'Ada Lovelace Engineer', company: 'Example Labs' },
      }] } });
      const ids = [lane.jobId, 'job-discarded-0002'];
      const strict = await partial.describeForConfirm('/tmp/ada.canvas', ids);
      assert(strict.ok === false && strict.code === 'unknown_job' && strict.items.length === 0, 'the manual release confirmation still fails closed when any requested job is missing');
      const lenient = await partial.describeForConfirm('/tmp/ada.canvas', ids, { requireAll: false });
      assert(lenient.ok === true && lenient.items.length === 1 && lenient.items[0].jobId === lane.jobId, 'the restart, enable and auto-release paths keep the live job\'s name when a sibling was discarded');
      const none = await partial.describeForConfirm('/tmp/ada.canvas', ['job-discarded-0002'], { requireAll: false });
      assert(none.ok === false && none.code === 'unknown_job', 'but with nothing left there is nothing to describe');
    },
  },
  {
    name: 'handoff bridge: application: the source forwards bundle-removal events from the app and unsubscribes cleanly',
    run: async () => {
      const heard = []; let unsubscribed = 0; let registered = null;
      const wired = source({ api: { subscribeLocalApplicationDiscards: listener => { registered = listener; return () => { unsubscribed += 1; }; } } });
      const stop = wired.subscribeDiscard(event => heard.push(event));
      registered({ jobId: lane.jobId, canvasFilePath: '/tmp/ada.canvas', cause: 'bundle_discarded' });
      assert(heard.length === 1 && heard[0].cause === 'bundle_discarded', 'the app\'s event reaches the bridge');
      stop();
      assert(unsubscribed === 1, 'and the subscription can be withdrawn');
      assert(typeof wired.subscribeDiscard(null) === 'function', 'a non-function listener is inert rather than a crash');
    },
  },
  {
    name: 'handoff bridge: application: a lane whose canvas lost its whole .local-ai folder reads as gone, while a moved canvas file and other callers keep the ownership rejection',
    run: async () => {
      const root = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'handoff-bridge-application-')));
      const canvasFilePath = path.join(root, 'Canvas.json');
      try {
        await fs.promises.writeFile(canvasFilePath, '{}', 'utf8');
        const queued = await queueLocalApplicationJob({
          transport: 'paste', canvasFilePath,
          careerData: 'Ada Lovelace\nada@example.com\nSoftware Engineer\nBuilt reliable reporting systems.',
          job: { title: 'Application Engineer', company: 'Example Labs', snippet: 'Build reliable reporting systems.' },
          resumeProfile: { workHistory: [{ id: 'ada-role', title: 'Software Engineer', employer: 'Example Labs', startDate: '2020', endDate: '2024' }] },
        });
        const adapter = createApplicationSource();
        const target = { jobId: queued.id, canvasFilePath };
        assert(['awaiting', 'host'].includes((await adapter.status(target)).kind), 'a live bundle is not gone');
        await fs.promises.rm(path.join(root, '.local-ai'), { recursive: true, force: true });
        const gone = await adapter.status(target);
        assert(gone.kind === 'gone', `an intact canvas with no .local-ai folder is proof the bundle is gone, got ${JSON.stringify(gone)}`);
        let ownership = null;
        try { await localApplicationStatus(queued.id, canvasFilePath); } catch (error) { ownership = error; }
        assert(ownership?.code === 'ENOENT', 'a caller that does not own the job still gets the ownership rejection');
        const moved = await adapter.status({ jobId: queued.id, canvasFilePath: path.join(root, 'Moved.json') });
        assert(moved.kind === 'threw' && moved.enoent === true, `a canvas file that is not there proves nothing about the bundle, got ${JSON.stringify(moved)}`);
      } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
    },
  },
];
