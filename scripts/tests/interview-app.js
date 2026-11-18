// The standalone Interview Helper app: its saved interviews, data folders,
// build target, and the pieces of shared code it registers on its own.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ipcMain } from 'electron';
import { interviewAppDataRoots } from '../../electron/interviewApp/dataRoots.js';
import { createInterviewSessionStore, interviewSessionData, normalizeInterviewSessionsState, readInterviewHelperNodesFromCanvas } from '../../electron/interviewApp/sessionStore.js';
import { formatPooledWorkspace, poolWorkspaceContent } from '../../electron/ipc/workspaceContentPool.js';
import { chosenAppliedJobsRoot, createApplicationFolderRegistry, listApplicationFolders } from '../../electron/ipc/interviewApplicationFolders.js';
import { registerCareerDataHandlers } from '../../electron/ipc/jobs.js';
import {
  CAREER_CONVERSIONS_DIR, createCareerFileConversionService, createCareerFileReader, registerCareerConversionHandlers, validateConvertArgs,
} from '../../electron/interviewApp/careerFileConversion.js';
import { addInterview, emptyInterviewData, importCanvasInterviews, interviewRunIds, interviewTitle, patchInterview, removeInterview } from '../../src/interview-app/sessions.js';
import { CURRENT_SCHEMA_VERSION, migrateRemoveInterviewHelperNodes, runNodeMigrations } from '../../src/utils/serializationUtils.js';
import { BUILD_TARGETS, buildTargetFromArgv, packagingLockPath, selectBuildTarget, signBundledHelpers } from '../build-macos.mjs';

const repoFile = relative => new URL(`../../${relative}`, import.meta.url);
const read = relative => fs.readFileSync(repoFile(relative), 'utf8');
async function withTempDir(fn) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-app-'));
  try { return await fn(directory); }
  finally { await fs.promises.rm(directory, { recursive: true, force: true }); }
}
const SNAPSHOT = 'a'.repeat(64);

const tests = [
  {
    name: 'interview app: profile and shared data folders are separate and overridable only by absolute paths',
    run() {
      const roots = interviewAppDataRoots({ appDataPath: '/Users/x/Library/Application Support' });
      assert.equal(roots.profile, '/Users/x/Library/Application Support/Interview Helper');
      // Existing briefs, answer banks and Q&A stay in the folder Infinite Canvas created.
      assert.equal(roots.data, '/Users/x/Library/Application Support/infinite-canvas');
      const overridden = interviewAppDataRoots({ appDataPath: '/a', env: { INTERVIEW_HELPER_PROFILE_DIR: '/tmp/p', INTERVIEW_HELPER_DATA_DIR: 'relative/ignored' } });
      assert.equal(overridden.profile, '/tmp/p');
      assert.equal(overridden.data, '/a/infinite-canvas');
      assert.throws(() => interviewAppDataRoots({ appDataPath: '/a', env: { INTERVIEW_HELPER_PROFILE_DIR: '/same', INTERVIEW_HELPER_DATA_DIR: '/same' } }), /separate/u);
      assert.throws(() => interviewAppDataRoots({ appDataPath: 'relative' }), /application data path/u);
    },
  },
  {
    name: 'interview app: saved interviews round-trip, keep only Interview Helper fields, and survive a reload',
    async run() {
      await withTempDir(async (directory) => {
        const filePath = path.join(directory, 'interview-helper-sessions.json');
        const store = createInterviewSessionStore({ filePath });
        assert.deepEqual(await store.load(), { version: 1, sessions: [], selectedId: null, appliedJobsFolder: null });
        const saved = await store.save({
          selectedId: 'two', appliedJobsFolder: '/Users/x/Applied Jobs',
          sessions: [
            { id: 'one', title: 'First', createdAt: 5, data: { interviewHelperCareerSnapshotId: SNAPSHOT, practiceSteering: 'final round', interviewHelperTypedJob: 'Engineer at Acme', interviewHelperTypedJobKind: 'generated', locked: true, dragHover: { kind: 'accept' }, arbitrary: 1 } },
            { id: 'two', title: '', createdAt: 6, data: {} },
            { id: 'one', title: 'duplicate id is dropped', data: {} },
            { id: 'bad id!', data: {} },
          ],
        });
        assert.deepEqual(saved.sessions.map(session => session.id), ['one', 'two']);
        assert.deepEqual(saved.sessions[0].data, { interviewHelperCareerSnapshotId: SNAPSHOT, practiceSteering: 'final round', interviewHelperTypedJob: 'Engineer at Acme', interviewHelperTypedJobKind: 'generated' }, 'canvas-only state such as a lock or drag cue must not be stored');
        assert.equal(saved.selectedId, 'two');
        assert.equal((await fs.promises.stat(filePath)).mode & 0o777, 0o600);
        const reopened = createInterviewSessionStore({ filePath });
        assert.deepEqual(await reopened.load(), saved);
        assert.deepEqual((await fs.promises.readdir(directory)).sort(), ['interview-helper-sessions.json'], 'no temporary file may be left behind');
        // A selection that no longer exists falls back to the first interview.
        assert.equal(normalizeInterviewSessionsState({ sessions: saved.sessions, selectedId: 'gone' }).selectedId, 'one');
        assert.equal(normalizeInterviewSessionsState({ appliedJobsFolder: 'relative' }).appliedJobsFolder, null);
      });
    },
  },
  {
    name: 'interview app: a damaged saved-interviews file is reported and never overwritten',
    async run() {
      await withTempDir(async (directory) => {
        const filePath = path.join(directory, 'interview-helper-sessions.json');
        await fs.promises.writeFile(filePath, '{ not json');
        const store = createInterviewSessionStore({ filePath });
        await assert.rejects(store.load(), /damaged/u);
        await assert.rejects(store.save({ sessions: [{ id: 'new', data: {} }] }), /damaged/u);
        assert.equal(await fs.promises.readFile(filePath, 'utf8'), '{ not json', 'the unreadable file must be left for recovery');
      });
    },
  },
  {
    name: 'interview app: canvas import reads pooled and nested Interview Helper nodes without writing the canvas',
    async run() {
      await withTempDir(async (directory) => {
        const node = (id, extra = {}) => ({ id, type: 'interviewhelper', position: { x: 0, y: 0 }, data: { interviewHelperCareerSnapshotId: SNAPSHOT, interviewHelperJobUrl: 'https://jobs.example.test/1', locked: true, ...extra } });
        const workspace = { schemaVersion: 11, edges: [], drawings: [], nodes: [
          // Repeated long content is what makes a real canvas save in the pooled format.
          { id: 'note', type: 'text', data: { text: 'repeated '.repeat(400) } },
          { id: 'note-2', type: 'text', data: { text: 'repeated '.repeat(400) } },
          node('top-level'),
          { id: 'group', type: 'group', data: { canvasData: { nodes: [node('nested', { practiceSteering: 'recruiter screen' })] } } },
        ] };
        const pooledPath = path.join(directory, 'pooled.json');
        const plainPath = path.join(directory, 'plain.json');
        const pooled = poolWorkspaceContent(structuredClone(workspace));
        assert(pooled, 'the fixture must exercise the pooled canvas format');
        await fs.promises.writeFile(pooledPath, formatPooledWorkspace(pooled));
        await fs.promises.writeFile(plainPath, JSON.stringify(workspace));
        const before = await fs.promises.readFile(pooledPath);
        for (const canvasPath of [pooledPath, plainPath]) {
          const { interviews } = await readInterviewHelperNodesFromCanvas(canvasPath);
          assert.deepEqual(interviews.map(item => item.id), ['top-level', 'nested']);
          assert.deepEqual(interviews[0].data, { interviewHelperCareerSnapshotId: SNAPSHOT, interviewHelperJobUrl: 'https://jobs.example.test/1' });
          assert.equal(interviews[1].data.practiceSteering, 'recruiter screen');
        }
        assert(before.equals(await fs.promises.readFile(pooledPath)), 'the canvas file must be byte-identical after an import');
        await fs.promises.writeFile(path.join(directory, 'junk.json'), 'not a canvas');
        await assert.rejects(readInterviewHelperNodesFromCanvas(path.join(directory, 'junk.json')), /not a readable Infinite Canvas file/u);
        assert.deepEqual(interviewSessionData(null), {});
      });
    },
  },
  {
    name: 'interview app: an imported interview keeps its canvas node id and never overwrites one already here',
    run() {
      let state = { version: 1, sessions: [], selectedId: null, appliedJobsFolder: null };
      state = addInterview(state, { id: 'here', now: 1, data: { interviewHelperJobUrl: 'https://kept.example.test/' } });
      const result = importCanvasInterviews(state, [
        { id: 'here', data: { interviewHelperJobUrl: 'https://stale-canvas.example.test/' } },
        { id: 'node-5e19', data: { interviewHelperCareerSnapshotId: SNAPSHOT, interviewHelperApplicationBundle: { label: 'Reddit · Software Engineer' } } },
      ], 2);
      assert.deepEqual([result.added, result.skipped], [1, 1]);
      assert.equal(result.state.sessions[0].data.interviewHelperJobUrl, 'https://kept.example.test/', 'the copy already in the app is the newer one');
      const imported = result.state.sessions[1];
      // Q&A and practice history are stored per id, so the id must carry over unchanged.
      assert.equal(imported.id, 'node-5e19');
      assert.equal(imported.data.interviewHelperCurrentStep, 0, 'missing fields take the fresh-interview defaults');
      assert.equal(interviewTitle(imported), 'Reddit · Software Engineer');
      assert.equal(interviewTitle({ title: '  Final round  ', data: imported.data }), 'Final round');
      assert.equal(interviewTitle({ data: emptyInterviewData() }), 'New interview');
      const patched = patchInterview(result.state, 'node-5e19', { interviewHelperCurrentStep: 2 });
      assert.equal(patched.sessions[1].data.interviewHelperCurrentStep, 2);
      assert.equal(patchInterview(patched, 'missing', { x: 1 }), patched, 'a patch for a deleted interview changes nothing');
      const removed = removeInterview({ ...patched, selectedId: 'node-5e19' }, 'node-5e19');
      assert.deepEqual([removed.sessions.length, removed.selectedId], [1, 'here']);
      assert.deepEqual(interviewRunIds({
        interviewHelperCareerCompilation: { manualAiRunId: 'interview-helper:compile:1' },
        interviewHelperPreparationRunId: 'interview-helper:prepare:2',
        interviewHelperManualAiCleanup: { runId: 'interview-helper:prepare:2' },
        interviewHelperManualAiRetirementReceipts: [{ runId: 'interview-helper:compile:3' }, { runId: 'bad id' }],
      }), ['interview-helper:compile:1', 'interview-helper:prepare:2', 'interview-helper:compile:3']);
    },
  },
  {
    name: 'interview app: the application list uses the folder chosen in the app instead of a canvas path',
    async run() {
      await withTempDir(async (directory) => {
        const root = path.join(directory, 'Applied Jobs');
        const application = path.join(root, 'Acme', 'Toronto', 'Engineer');
        await fs.promises.mkdir(application, { recursive: true });
        await fs.promises.writeFile(path.join(application, 'Original Job Listing.md'), '**Listing URL:** https://jobs.example.test/1\n');
        const registry = createApplicationFolderRegistry();
        const listed = await listApplicationFolders({ nodeId: 'interview-1', registry, appliedJobsFolder: root });
        assert.deepEqual(listed.folders.map(folder => folder.label), ['Acme · Engineer']);
        assert.equal(registry.resolve('interview-1', listed.folders[0].token), application);
        assert(!JSON.stringify(listed).includes(directory), 'the renderer receives labels and tokens, never a path');
        assert.equal((await listApplicationFolders({ nodeId: 'interview-1', registry, appliedJobsFolder: null })).reason, 'folder-unset');
        assert.equal((await chosenAppliedJobsRoot(path.join(directory, 'missing'))).reason, 'missing-root');
        await fs.promises.symlink(root, path.join(directory, 'link'));
        assert.equal((await chosenAppliedJobsRoot(path.join(directory, 'link'))).reason, 'missing-root', 'a symlinked folder is not listed');
        const picker = read('src/components/InterviewApplicationPicker.jsx');
        assert.match(picker, /folder-unset/u);
      });
    },
  },
  {
    name: 'interview app: registers the shared career compile handlers alone, not the rest of Job Search',
    run() {
      const channels = [];
      const originalHandle = ipcMain.handle;
      ipcMain.handle = (channel, handler) => { channels.push(channel); return originalHandle(channel, handler); };
      try { registerCareerDataHandlers(); }
      finally { ipcMain.handle = originalHandle; }
      assert.deepEqual(channels.sort(), ['inspect-career-compile-resume', 'parse-career-data']);
    },
  },
  {
    name: 'interview app: Infinite Canvas drops Interview Helper nodes on load and no longer builds the feature',
    run() {
      const helper = id => ({ id, type: 'interviewhelper', data: {} });
      const nodes = [{ id: 'keep', type: 'text', data: {} }, helper('top'), { id: 'group', type: 'group', data: { canvasData: { nodes: [helper('nested'), { id: 'inner', type: 'text', data: {} }] } } }];
      const migrated = runNodeMigrations(nodes, 11);
      assert.deepEqual(migrated.map(node => node.id), ['keep', 'group']);
      assert.deepEqual(migrated[1].data.canvasData.nodes.map(node => node.id), ['inner']);
      assert(CURRENT_SCHEMA_VERSION >= 12);
      const clean = [{ id: 'keep', type: 'text', data: {} }];
      assert.equal(migrateRemoveInterviewHelperNodes(clean), clean, 'a canvas without the node is returned untouched');
      assert.equal(runNodeMigrations(migrated, CURRENT_SCHEMA_VERSION), migrated);

      // Neither bundle may reach into the other app.
      assert.doesNotMatch(read('electron/main.js'), /interviewWindow|practiceCall|interviewPreparation|interviewHelper\.js/u);
      assert.doesNotMatch(read('vite.config.js'), /interview|practiceCall/iu);
      assert.doesNotMatch(read('src/Canvas.jsx'), /InterviewHelper/u);
      const appMain = read('electron/interviewApp/main.js');
      assert.doesNotMatch(appMain, /from '\.\.\/main\.js'|registerJobsHandlers\(|registerFilesystemHandlers/u);
      const appEntry = read('src/interview-app/main.jsx') + read('src/interview-app/InterviewHelperApp.jsx') + read('src/interview-app/InterviewHelperPanel.jsx');
      assert.doesNotMatch(appEntry, /@xyflow|Canvas\.jsx|\/App\.jsx|CanvasNavigationContext/u, 'the standalone window must not import the canvas');
    },
  },
  {
    name: 'interview app: has its own build command, bundle id, outputs and release directory',
    run() {
      const pkg = JSON.parse(read('package.json'));
      const config = JSON.parse(read('electron-builder.interview.json'));
      assert.equal(pkg.scripts['build:interview'], 'node scripts/build-macos.mjs --app interview');
      assert.equal(pkg.scripts['build:interview:compile'], 'vite build --config vite.interview.config.js');
      assert.equal(pkg.scripts.build, 'node scripts/build-macos.mjs');
      assert.notEqual(config.appId, pkg.build.appId);
      assert.equal(config.productName, 'Interview Helper');
      assert.equal(config.extraMetadata.main, 'dist-electron-interview/main.cjs');
      assert.notEqual(config.directories.output, pkg.build.directories.output);
      const shared = config.files.filter(entry => pkg.build.files.includes(entry) && !entry.startsWith('!'));
      assert.deepEqual(shared, [], 'the two apps must not package the same compiled folders');
      const viteConfig = read('vite.interview.config.js');
      assert.match(viteConfig, /outDir: 'dist-interview'/u);
      assert.match(viteConfig, /ELECTRON_OUT_DIR = 'dist-electron-interview'/u);
      assert.match(read('.gitignore'), /^dist-electron-interview$/mu);

      assert.equal(buildTargetFromArgv([]), 'canvas');
      assert.equal(buildTargetFromArgv(['--app', 'interview']), 'interview');
      assert.throws(() => selectBuildTarget('nope'), /Unknown build target/u);
      try {
        selectBuildTarget('interview');
        assert.equal(packagingLockPath('/repo'), '/repo/release-interview/.packaging-build.lock', 'each app serializes only its own packaging');
      } finally { selectBuildTarget('canvas'); }
      assert.equal(packagingLockPath('/repo'), '/repo/release/.packaging-build.lock');
      assert.equal(BUILD_TARGETS.interview.releaseDirectory, config.directories.output);
      assert.deepEqual(BUILD_TARGETS.canvas.helpers, []);
    },
  },
  {
    name: 'interview app: bundled audio helpers are re-signed with their own entitlements',
    run() {
      const commands = [];
      const runCommand = (command, args) => { commands.push([command, ...args]); return { status: 0 }; };
      signBundledHelpers({ apps: ['/out/Interview Helper.app'], identity: 'Local Identity', helpers: BUILD_TARGETS.interview.helpers, projectDir: '/repo', runCommand, exists: () => true });
      assert.equal(commands.length, 2);
      const practice = commands.find(command => command.at(-1).endsWith('Practice Audio Helper.app'));
      assert.equal(practice.at(-1), '/out/Interview Helper.app/Contents/Resources/practice-audio/Practice Audio Helper.app');
      assert.equal(practice[practice.indexOf('--entitlements') + 1], '/repo/native/practice-audio/entitlements.plist');
      assert(practice.includes('runtime') && practice[practice.indexOf('--sign') + 1] === 'Local Identity');
      // The practice helper records the microphone; without this entitlement the hardened runtime refuses it.
      assert.match(read('native/practice-audio/entitlements.plist'), /com\.apple\.security\.device\.audio-input/u);
      assert.throws(() => signBundledHelpers({ apps: ['/out/App.app'], identity: 'x', helpers: BUILD_TARGETS.interview.helpers, runCommand, exists: () => false }), /missing its helper/u);
      assert.throws(() => signBundledHelpers({ apps: ['/out/App.app'], identity: 'x', helpers: BUILD_TARGETS.interview.helpers, runCommand: () => ({ status: 1 }), exists: () => true }), /Signing the bundled helper failed/u);
      const pipeline = read('scripts/build-macos.mjs');
      assert(pipeline.indexOf('signBundledHelpers({ apps, identity') < pipeline.indexOf('signMacApplications({ apps, identity });'), 'helpers are signed before the app that seals them');
    },
  },
  {
    name: 'interview app: its launcher builds and opens only this app, with its own stamp and lock',
    run() {
      const launcher = read('scripts/launch-interview-helper.command');
      const canvasLauncher = read('scripts/launch-app.command');
      assert.match(launcher, /RELEASE_APP="\$PROJECT_DIR\/release-interview\/mac-arm64\/Interview Helper\.app"/u);
      assert.match(launcher, /STATE_DIR="\$PROJECT_DIR\/release-interview\/\.launcher"/u);
      assert.match(launcher, /APP_BUNDLE_ID="com\.antigravity\.interviewhelper"/u);
      assert.match(launcher, /npm run build:interview 2>&1 \| tee "\$LOG"/u);
      assert.doesNotMatch(launcher, /npm run build 2>&1|release\/mac-arm64|infinitecanvas/u, 'it must never build, verify or quit Infinite Canvas');
      assert.doesNotMatch(canvasLauncher, /release-interview|interviewhelper|build:interview/u, 'and the canvas launcher must never touch Interview Helper');
      // The same safety order as the canvas launcher: sentinel removed before the build, written only after a clean one.
      const order = ['rm -f "$STAMP"', 'npm run build:interview 2>&1 | tee "$LOG"', 'built_manifest="$(source_manifest "$BUILD_INPUTS")"', '[[ "$postbuild_manifest" != "$manifest" ]]', 'print -r -- "$built_manifest" > "$STAMP"'];
      const positions = order.map(text => launcher.indexOf(text));
      assert(positions.every((position, index) => position > 0 && (index === 0 || position > positions[index - 1])), `launcher steps out of order: ${positions}`);
      assert.match(launcher, /verify_app\(\) \{[\s\S]*?codesign --verify --deep --strict "\$RELEASE_APP"/u);
      assert(launcher.includes('setopt local_options pipe_fail') && launcher.includes('node "$PROJECT_DIR/scripts/source-manifest.mjs"'));
      // Staleness follows the files the build read, so a canvas-only edit does not rebuild this app.
      assert.match(launcher, /BUILD_INPUTS="\$PROJECT_DIR\/dist-electron-interview\/build-inputs\.json"/u);
      assert.match(read('vite.interview.config.js'), /build-inputs\.json/u);
      // And the reverse: the canvas launcher follows its own build's list, so an edit only this app is built from does not rebuild Infinite Canvas.
      assert.match(canvasLauncher, /BUILD_INPUTS="\$PROJECT_DIR\/dist-electron\/build-inputs\.json"/u);
      assert.match(canvasLauncher, /manifest="\$\(source_manifest "\$BUILD_INPUTS"\)"/u);
      assert.match(read('vite.config.js'), /buildInputsManifest\('dist-electron\/build-inputs\.json'\)/u);
      const canvasInputs = canvasLauncher.slice(canvasLauncher.indexOf('if [[ -n "$inputs"'), canvasLauncher.indexOf('elif git -C'));
      assert.doesNotMatch(canvasInputs, /native|ls-files[^\n]*--exclude-standard \|\|/u, 'with a list, the canvas launcher must not hash the whole repo or the native helpers only the other app ships');
    },
  },
  {
    name: 'interview app: career conversion validates its arguments strictly and refuses one bad file without refusing the others',
    async run() {
      assert.throws(() => validateConvertArgs({ nodeId: 'n', filePaths: ['/a/b.pdf'], extra: 1 }), TypeError);
      assert.throws(() => validateConvertArgs({ nodeId: 'n', filePaths: ['relative.pdf'] }), TypeError);
      assert.throws(() => validateConvertArgs({ nodeId: 'n', filePaths: [] }), TypeError);
      assert.throws(() => validateConvertArgs({ nodeId: '', filePaths: ['/a/b.pdf'] }), TypeError);
      assert.deepEqual(validateConvertArgs({ nodeId: 'n', filePaths: ['/a/b.pdf'] }), { nodeId: 'n', filePaths: ['/a/b.pdf'] });
      await withTempDir(async data => {
        const shown = []; const registered = []; const seen = [];
        const service = createCareerFileConversionService({
          dataRoot: data,
          checkSource: async file => { if (file.endsWith('secret.txt')) throw new Error('secret.txt cannot be used as career data.'); },
          registerInputRoot: root => registered.push(root),
          showItemInFolder: file => shown.push(file),
          randomToken: (() => { let n = 0; return () => `token-${++n}`; })(),
          readWithAi: async () => 'unused',
          convert: async ({ filePaths, userDataPath, readWithAi }) => {
            seen.push({ names: filePaths.map(file => path.basename(file)), userDataPath, hasReader: typeof readWithAi === 'function' });
            const dir = path.join(fs.realpathSync(userDataPath), CAREER_CONVERSIONS_DIR, 'abc123');
            return { files: filePaths.map(file => {
              const name = path.basename(file);
              if (name === 'notes.txt') return { ok: true, method: 'original', textPath: file, textName: name };
              if (name === 'resume.pdf') return { ok: true, method: 'pdf-text-layer', textPath: path.join(dir, 'resume.pdf.txt'), textName: 'resume.pdf.txt', reason: 'machine note' };
              return { ok: false, reason: 'This file is encrypted.' };
            }) };
          },
        });
        const root = await service.conversionsRoot();
        assert.equal(path.basename(root), CAREER_CONVERSIONS_DIR);
        assert.deepEqual(registered, [root], 'the private folder is registered as the one allowed converted input root');
        assert.equal((await fs.promises.stat(root)).mode & 0o777, 0o700);
        await fs.promises.mkdir(path.join(root, 'abc123')); await fs.promises.writeFile(path.join(root, 'abc123', 'resume.pdf.txt'), 'Jane Doe\nEngineer\n');
        const reply = await service.convertFiles({ nodeId: 'n', filePaths: ['/x/notes.txt', '/x/resume.pdf', '/x/locked.docx', '/x/secret.txt'] });
        assert.deepEqual(seen[0].names, ['notes.txt', 'resume.pdf', 'locked.docx'], 'a file the safety check refuses never reaches the converter');
        assert.deepEqual(reply.files.map(file => [file.name, file.status, file.convertedName, file.machineExtracted]), [
          ['notes.txt', 'passthrough', 'notes.txt', false],
          ['resume.pdf', 'converted', 'resume.pdf.txt', true],
          ['locked.docx', 'refused', null, false],
          ['secret.txt', 'refused', null, false],
        ]);
        assert.equal(reply.files[0].filePath, '/x/notes.txt', 'a text file passes through at its own path');
        assert.equal(reply.files[1].filePath, path.join(root, 'abc123', 'resume.pdf.txt'));
        assert.equal(reply.files[1].reason, 'machine note');
        assert.equal(reply.files[2].reason, 'This file is encrypted.');
        assert.equal(reply.files[3].reason, 'secret.txt cannot be used as career data.');
        assert.equal(reply.usableCount, 2);
        assert.equal(reply.files[1].token, 'token-1');
        assert.deepEqual(await service.reveal({ token: 'token-1' }), { shown: true });
        assert.deepEqual(shown, [path.join(root, 'abc123', 'resume.pdf.txt')]);
        await assert.rejects(service.reveal({ token: '/etc/passwd' }), /not known/u);
        await assert.rejects(service.reveal({ token: 'token-9' }), /not known/u);
        // A converter that claims a path outside the private folder is not trusted.
        const rogue = createCareerFileConversionService({ dataRoot: data, checkSource: async () => {}, readWithAi: async () => '',
          convert: async ({ filePaths }) => ({ files: filePaths.map(() => ({ ok: true, method: 'ai', textPath: '/etc/passwd' })) }) });
        assert.equal((await rogue.convertFiles({ nodeId: 'n', filePaths: ['/x/a.pdf'] })).files[0].status, 'refused');
        // A converted file whose name starts with two dots is still inside the private folder.
        const dotted = createCareerFileConversionService({ dataRoot: data, checkSource: async () => {}, readWithAi: async () => '',
          convert: async () => ({ files: [{ ok: true, method: 'ai', textPath: path.join(root, '..resume.txt') }, { ok: true, method: 'ai', textPath: root }] }) });
        const dottedReply = await dotted.convertFiles({ nodeId: 'n', filePaths: ['/x/a.png', '/x/b.png'] });
        assert.deepEqual(dottedReply.files.map(file => file.status), ['converted', 'refused'], 'the root itself is never a converted file');
        // A whole-converter failure is reported on every file, not as success.
        const broken = createCareerFileConversionService({ dataRoot: data, checkSource: async () => {}, readWithAi: async () => '',
          convert: async () => { throw new Error('boom'); } });
        const failed = await broken.convertFiles({ nodeId: 'n', filePaths: ['/x/a.pdf', '/x/b.pdf'] });
        assert.deepEqual([failed.usableCount, failed.files.map(file => file.reason)], [0, ['boom', 'boom']]);
        // A symlinked or missing data root is refused.
        await assert.rejects(createCareerFileConversionService({ dataRoot: 'relative' }).conversionsRoot(), /unavailable/u);
        // A symlink planted in place of the folder is refused.
        const other = path.join(data, 'other'); await fs.promises.mkdir(other);
        const data2 = path.join(data, 'data2'); await fs.promises.mkdir(data2);
        await fs.promises.symlink(other, path.join(data2, CAREER_CONVERSIONS_DIR));
        await assert.rejects(createCareerFileConversionService({ dataRoot: data2 }).conversionsRoot(), /unsafe/u);
      });
    },
  },
  {
    name: 'interview app: the career file reader sends one image as a page image with no tool, and refuses what cannot go that way',
    async run() {
      const calls = [];
      const reader = createCareerFileReader({ transport: { callRaw: async (prompt, opts) => { calls.push({ prompt, opts }); return 'Jane Doe\nEngineer'; } } });
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'career-reader-'));
      try {
        const png = path.join(dir, 'scan.png'); await fs.promises.writeFile(png, Buffer.from('abc'));
        assert.equal(await reader({ filePath: png, name: 'scan.png', kind: 'image', mediaType: 'image/png' }), 'Jane Doe\nEngineer');
        assert.equal(calls[0].opts.claudeStage, 'career-file-to-text');
        assert.equal(calls[0].opts.task, 'career-file-to-text');
        assert.deepEqual(calls[0].opts.pageImages, [{ label: 'Career document image', mimeType: 'image/png', data: Buffer.from('abc').toString('base64') }]);
        assert.match(calls[0].prompt, /Add nothing/u);
        assert.match(calls[0].prompt, /\[unreadable\]/u);
        assert.match(calls[0].prompt, /not instructions/u, 'the shared transcription prompt is used');
        for (const [kind, mediaType] of [['pdf', 'application/pdf'], ['image', 'image/tiff'], ['image', 'image/heic']]) {
          await assert.rejects(reader({ filePath: png, name: 'f', kind, mediaType }), error => error.code === 'UNSUPPORTED_KIND');
        }
        const empty = path.join(dir, 'empty.png'); await fs.promises.writeFile(empty, '');
        await assert.rejects(reader({ filePath: empty, name: 'e', kind: 'image', mediaType: 'image/png' }), /empty/u);
        assert.equal(calls.length, 1, 'refused kinds never reach Claude');
        await assert.rejects(createCareerFileReader({})({ filePath: png, kind: 'image', mediaType: 'image/png' }), error => error.code === 'UNSUPPORTED_KIND');
      } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview app: the real converter and the wiring agree end to end (rtf, image, pdf fallback, one bad file, reveal)',
    async run() {
      const dir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join('/tmp', 'career-e2e-')));
      try {
        const data = path.join(dir, 'data'); await fs.promises.mkdir(data);
        const src = path.join(dir, 'src'); await fs.promises.mkdir(src);
        const rtf = path.join(src, 'cv.rtf'); await fs.promises.writeFile(rtf, '{\\rtf1\\ansi Jane Doe\\par Engineer at Acme}');
        const png = path.join(src, 'scan.png'); await fs.promises.writeFile(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.from('xxxx')]));
        const bad = path.join(src, 'locked.bin'); await fs.promises.writeFile(bad, Buffer.from([0, 1, 2, 3, 0, 0, 5, 6]));
        const txt = path.join(src, 'notes.txt'); await fs.promises.writeFile(txt, 'Plain notes about my career.\n');
        const shown = [];
        const service = createCareerFileConversionService({
          dataRoot: data, checkSource: async () => {}, showItemInFolder: file => shown.push(file),
          transport: { callRaw: async () => 'Scanned line one\nScanned line two' },
        });
        const reply = await service.convertFiles({ nodeId: 'n', filePaths: [rtf, png, bad, txt] });
        assert.deepEqual(reply.files.map(file => file.status), ['converted', 'converted', 'refused', 'passthrough'], JSON.stringify(reply.files.map(file => file.reason)));
        assert.equal(reply.usableCount, 3);
        assert.equal(reply.files[0].convertedName, 'cv.rtf.txt');
        assert.match(await fs.promises.readFile(reply.files[0].filePath, 'utf8'), /Jane Doe\nEngineer at Acme/u);
        assert.match(await fs.promises.readFile(reply.files[1].filePath, 'utf8'), /Scanned line one/u);
        assert.ok(reply.files[2].reason && reply.files[2].reason !== 'The file could not be converted.', 'the converter reason is kept');
        assert.equal(reply.files[3].filePath, txt);
        assert.deepEqual(await service.reveal({ token: reply.files[0].token }), { shown: true });
        assert.equal(shown[0], reply.files[0].filePath);
        const again = await service.convertFiles({ nodeId: 'n', filePaths: [rtf] });
        assert.equal(again.files[0].filePath, reply.files[0].filePath, 'an unchanged original resumes the same converted file');
      } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
    },
  },
  {
    name: 'interview app: career conversion registers its two channels and the reveal channel takes only a token',
    async run() {
      const handled = new Map(); const safe = new Map();
      const service = { convertFiles: async (args, signal) => ({ files: [], args, signal }), reveal: async args => ({ shown: true, args }) };
      registerCareerConversionHandlers({
        handleSafe: (channel, handler, options) => safe.set(channel, { handler, options }),
        ipcMain: { handle: (channel, handler) => handled.set(channel, handler) },
        guarded: handler => async (_event, ...args) => handler(...args),
        service,
      });
      assert.deepEqual([...safe.keys()], ['convert-interview-career-files']);
      assert.deepEqual([...handled.keys()], ['interview-app:reveal-converted-career-file']);
      assert.throws(() => safe.get('convert-interview-career-files').options.validateArgs({ nodeId: 'n', filePaths: ['/a'], x: 1 }), TypeError);
      assert.equal((await safe.get('convert-interview-career-files').handler({}, { nodeId: 'n', filePaths: ['/a'] }, 'sig')).signal, 'sig');
      await assert.rejects(handled.get('interview-app:reveal-converted-career-file')({}, { token: 't', path: '/etc/passwd' }), TypeError);
      assert.equal((await handled.get('interview-app:reveal-converted-career-file')({}, { token: 't' })).shown, true);
      const main = read('electron/interviewApp/main.js');
      assert.match(main, /registerCareerConvertedInputRoot/u);
      assert.doesNotMatch(main, /Career data \(text\)/u, 'the chooser no longer filters to text');
      assert.match(read('electron/ipc/ipcUtils.js'), /'convert-interview-career-files'/u, 'a long conversion pauses at quit like the other career work');
    },
  },
  {
    name: 'interview app: a burst of keystrokes in the interview name box ends in a save of the newest state',
    async run() {
      const { bundleComponent, withDom } = await import('./fixtures/practice-connector/mountComponent.js');
      const entryDirectory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ic-interview-app-entry-'));
      const entry = path.join(entryDirectory, 'entry.mjs');
      await fs.promises.writeFile(entry, `export { default as InterviewHelperApp } from ${JSON.stringify(path.resolve('src/interview-app/InterviewHelperApp.jsx'))};\n`);
      let bundle = null;
      try {
        await withDom(async window => {
          // react-dom decides whether it can use input events when it loads, so the bundle loads inside the DOM.
          bundle = await bundleComponent(entry, {});
          const saved = [];
          const first = { id: 'i1', title: '', createdAt: 1, data: emptyInterviewData() };
          window.interviewAppAPI = {
            loadState: async () => ({ sessions: [first], selectedId: 'i1', appliedJobsFolder: null }),
            saveState: async next => { saved.push(next); await new Promise(resolve => setTimeout(resolve, 5)); },
          };
          const root = bundle.module.createRoot(window.document.getElementById('root'));
          const { act } = bundle.module;
          try {
            await act(async () => { root.render(bundle.module.React.createElement(bundle.module.InterviewHelperApp)); await new Promise(resolve => setTimeout(resolve, 20)); });
            const input = window.document.querySelector('#interview-name-i1');
            assert.ok(input, 'the name box renders for the loaded interview');
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            await act(async () => {
              for (const text of ['A', 'Ac', 'Acm', 'Acme']) { setter.call(input, text); input.dispatchEvent(new window.Event('input', { bubbles: true })); }
            });
            await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)); });
            assert.ok(saved.length >= 1, 'typing saves');
            assert.equal(saved.at(-1).sessions[0].title, 'Acme', 'the last write carries the newest title');
            assert.ok(saved.every(next => next.sessions[0].title === 'Acme'), 'queued writes send the newest state, not each stale step');
          } finally { await act(async () => root.unmount()); }
        });
      } finally {
        if (bundle) await bundle.dispose();
        await fs.promises.rm(entryDirectory, { recursive: true, force: true });
      }
    },
  },
];

export default tests;
