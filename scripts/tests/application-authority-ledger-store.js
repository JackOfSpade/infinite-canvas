import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import nodeAssert from 'node:assert/strict';
import {
  __setAuthorityLedgerStoreFaultHookForTests,
  __setAuthorityLedgerProcessIdentityHookForTests,
  assert,
  createAuthorityLedgerStore,
  openAuthorityLedgerStore,
} from '../test-dependencies.js';

const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);
const digest = value => crypto.createHash('sha256').update(canonical(value)).digest('hex');
const pageFile = (stream, number) => `${stream}-${String(number).padStart(12, '0')}.json`;
const indexFile = (stream, start, span) => `index-${stream}-${String(start).padStart(12, '0')}-${String(span).padStart(12, '0')}.json`;

// Build a v2 fixture directly so the read-complexity test measures lookup,
// not 10k durable fsyncs. Production append coverage above still exercises
// publication; this fixture is a valid immutable index/root as a restart sees.
async function writeIndexedFixture(dir, count) {
  const pagesDir = path.join(dir, 'authority-ledger-pages'); await fs.promises.mkdir(pagesDir, { recursive: true });
  const peaks = []; let previous = null; let pageDigest = null; let middle = null; let forgedIndex = null;
  const writeNode = async node => {
    node.digest = digest(node); const file = indexFile(node.stream, node.start, node.span);
    await fs.promises.writeFile(path.join(pagesDir, file), JSON.stringify(node));
    return { start: node.start, span: node.span, file, digest: node.digest };
  };
  for (let number = 0; number < count; number += 1) {
    const records = [{ id: `p-${number}`, text: `page ${number}` }];
    const page = { version: 2, stream: 'listing', number, previous: previous?.file || null, previousDigest: previous?.digest || null, records, recordsDigest: digest(records) };
    page.digest = digest(page); const file = pageFile('listing', number);
    await fs.promises.writeFile(path.join(pagesDir, file), JSON.stringify(page));
    if (number === Math.floor(count / 2)) middle = { file, page: structuredClone(page) };
    let carry = await writeNode({ version: 1, kind: 'authority-ledger-receipt-index', stream: 'listing', start: number, span: 1, page: { file, digest: page.digest } });
    while (peaks.length && peaks.at(-1).span === carry.span) {
      const left = peaks.pop();
      carry = await writeNode({ version: 1, kind: 'authority-ledger-receipt-index', stream: 'listing', start: left.start, span: left.span + carry.span,
        left: { file: left.file, digest: left.digest }, right: { file: carry.file, digest: carry.digest } });
    }
    peaks.push(carry); previous = { file, digest: page.digest }; pageDigest = page.digest;
  }
  forgedIndex = peaks[0].file;
  const stream = { count, head: pageFile('listing', count - 1), digest: pageDigest, index: { version: 1, peaks } };
  const root = { version: 2, namespace: 'authority-ledger', revision: 1, genesis: { fixture: 'indexed-read-complexity' }, streams: { listing: stream } };
  root.digest = digest(root); await fs.promises.writeFile(path.join(dir, 'authority-ledger.root.json'), JSON.stringify(root));
  return { pagesDir, middle, forgedIndex };
}

async function writeLegacyFixture(dir) {
  const pagesDir = path.join(dir, 'authority-ledger-pages'); await fs.promises.mkdir(pagesDir, { recursive: true });
  let prior = null;
  for (let number = 0; number < 2; number += 1) {
    const records = [{ id: `legacy-${number}`, text: `legacy page ${number}` }];
    const page = { version: 1, stream: 'listing', number, previous: prior?.file || null, previousDigest: prior?.digest || null, records, recordsDigest: digest(records) };
    page.digest = digest(page); const file = pageFile('listing', number);
    await fs.promises.writeFile(path.join(pagesDir, file), JSON.stringify(page)); prior = { file, digest: page.digest };
  }
  const root = { version: 1, namespace: 'authority-ledger', revision: 2, genesis: { fixture: 'legacy-v1' }, streams: { listing: { count: 2, head: prior.file, digest: prior.digest } } };
  root.digest = digest(root); await fs.promises.writeFile(path.join(dir, 'authority-ledger.root.json'), JSON.stringify(root));
}

export default [{
  name: 'Authority ledger store keeps a bounded root and rejects substituted immutable pages',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-store-'));
    try {
      const store = await createAuthorityLedgerStore(dir, { genesis: { jobId: 'job-1' } });
      for (let index = 0; index < 160; index += 1) await store.appendReceiptPage('listing', [{ id: `listing-${index}`, text: `requirement ${index}` }]);
      for (let index = 0; index < 160; index += 1) await store.appendReceiptPage('requirements', [{ id: `p${index}-requirement`, text: `requirement ${index}`, indexKeys: [`requirement-text:requirement ${index}`] }]);
      const reopened = await openAuthorityLedgerStore(dir);
      assert(reopened.receipt().streams.listing.count === 160 && (await reopened.listingSlice(159)).text === 'requirement 159'
        && await reopened.hasPriorId('requirements', 'p159-requirement')
        && await reopened.hasPriorIndexKey('requirement-text:requirement 159'), 'lazy pages retain last records and normalized indexes without a root array');
      const crossing = []; for await (const slice of reopened.listingRange(79, 81)) crossing.push(slice.text);
      assert(JSON.stringify(crossing) === JSON.stringify(['requirement 79', 'requirement 80', 'requirement 81']), 'bounded listing-range iteration crosses immutable page boundaries in order');
      let genericPages = 0; for await (const _page of reopened.iterateReceiptPages('requirements')) genericPages += 1;
      assert(genericPages === 160, 'generic receipt streams paginate independently of listing pages');
      const middle = path.join(dir, 'authority-ledger-pages', 'listing-000000000080.json');
      const rewritten = JSON.parse(await fs.promises.readFile(middle, 'utf8')); rewritten.records[0].text = 'substituted';
      const { digest: _old, ...unsigned } = rewritten; rewritten.digest = digest(unsigned);
      await fs.promises.writeFile(middle, `${JSON.stringify(rewritten)}\n`);
      let chainRejected = false; try { await reopened.getReceiptPage('listing', 80); } catch { chainRejected = true; }
      assert(chainRejected, 'a recomputed middle-page digest cannot escape the root-bound reverse-chain proof');
      // Restore before exercising the no-follow page check below.
      rewritten.records[0].text = 'requirement 80'; const { digest: _again, ...restoredUnsigned } = rewritten; rewritten.digest = digest(restoredUnsigned);
      await fs.promises.writeFile(middle, `${JSON.stringify(rewritten)}\n`);
      const page = path.join(dir, 'authority-ledger-pages', 'listing-000000000000.json');
      const outside = path.join(dir, 'outside.json'); await fs.promises.writeFile(outside, await fs.promises.readFile(page));
      await fs.promises.unlink(page); await fs.promises.symlink(outside, page);
      let rejected = false; try { await reopened.getReceiptPage('listing', 0); } catch { rejected = true; }
      assert(rejected, 'symlink substitution fails closed');
      return { pages: 320, lazyLast: true, symlinkRejected: rejected };
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'Authority ledger store keeps v1 page-chain roots readable and append-compatible without a silent index migration',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-v1-'));
    try {
      await writeLegacyFixture(dir); const store = await openAuthorityLedgerStore(dir);
      assert((await store.getReceiptPage('listing', 0)).records[0].text === 'legacy page 0', 'a v1 root retains historical reverse-chain reads');
      await store.appendReceiptPage('listing', [{ id: 'legacy-2', text: 'legacy page 2' }]);
      const reopened = await openAuthorityLedgerStore(dir);
      assert(reopened.receipt().version === 1 && reopened.receipt().streams.listing.count === 3
        && (await reopened.getReceiptPage('listing', 2)).records[0].text === 'legacy page 2', 'a v1 job remains v1 after an append instead of silently changing its signed root contract');
      await reopened.appendReceiptPage('listing', [{ id: 'legacy-held', text: 'held legacy page' }], { holdJournal: true });
      const held = await openAuthorityLedgerStore(dir); await held.rollbackPendingJournal();
      const rolledBack = await openAuthorityLedgerStore(dir);
      assert(rolledBack.receipt().version === 1 && rolledBack.receipt().streams.listing.count === 3,
        'v1 roots retain held-journal rollback compatibility without an index migration');
      return { legacyVersion: rolledBack.receipt().version, count: rolledBack.receipt().streams.listing.count, heldRollback: true };
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'Authority ledger store rejects escaped namespaces and reserved page-family stream names before preparation',
  run: async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-namespace-'));
    const dir = path.join(parent, 'root'); const escapedPages = path.join(parent, 'escaped-pages');
    try {
      await fs.promises.mkdir(dir);
      await nodeAssert.rejects(createAuthorityLedgerStore(dir, { namespace: '../escaped' }), /namespace is invalid/i,
        'creation validates the namespace before joining its pages directory');
      await nodeAssert.rejects(openAuthorityLedgerStore(dir, { namespace: '../escaped' }), /namespace is invalid/i,
        'opening rejects the same path-escaping namespace before file access');
      await nodeAssert.rejects(fs.promises.lstat(escapedPages), { code: 'ENOENT' },
        'an escaped namespace never creates a sibling pages directory');

      const store = await createAuthorityLedgerStore(dir);
      const { AuthorityLedgerStore } = await import('../../electron/ipc/applicationAuthorityLedgerStore.js');
      nodeAssert.throws(() => new AuthorityLedgerStore(dir, '../escaped', store.state), /namespace is invalid/i,
        'the public constructor cannot reintroduce an unchecked namespace');

      let collidingId;
      for (let index = 0; !collidingId; index += 1) {
        const candidate = `reserved-stream-collision-${index}`;
        if (crypto.createHash('sha256').update(`id:${candidate}`).digest('hex').slice(0, 2) === 'ab') collidingId = candidate;
      }
      await nodeAssert.rejects(store.appendReceiptPage('ids-ab', [{ id: collidingId }]), /invalid stream or records/i,
        'a receipt stream cannot claim the ID-bucket filename family');
      await nodeAssert.rejects(store.appendReceiptPages([{ stream: 'index-a-000000000000', records: [] }]), /invalid stream or records/i,
        'batch appends cannot claim the MMR-index filename family');
      assert((await fs.promises.readdir(path.join(dir, 'authority-ledger-pages'))).length === 0 && Object.keys(store.receipt().streams).length === 0,
        'reserved stream names fail before a receipt page, index node, or orphan can be prepared');
      return { escapedNamespaceRejected: true, reservedStreamsRejected: true, preparedFiles: 0 };
    } finally { await fs.promises.rm(parent, { recursive: true, force: true }); }
  },
}, {
  name: 'Authority ledger store v2 authenticates 10k receipt-page lookup logarithmically and rejects forged index or middle pages',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-indexed-'));
    try {
      const fixture = await writeIndexedFixture(dir, 10_000);
      const store = await openAuthorityLedgerStore(dir);
      let reads = 0;
      __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === 'read:index' || step === 'read:page') reads += 1; });
      const target = await store.getReceiptPage('listing', 5_000);
      __setAuthorityLedgerStoreFaultHookForTests(null);
      assert(target.records[0].text === 'page 5000' && reads <= 16,
        `a 10k-page random lookup follows only its authenticated logarithmic index path (reads=${reads})`);

      const middlePath = path.join(fixture.pagesDir, fixture.middle.file);
      const forgedMiddle = structuredClone(fixture.middle.page); forgedMiddle.records[0].text = 'forged middle'; forgedMiddle.recordsDigest = digest(forgedMiddle.records);
      forgedMiddle.digest = digest(Object.fromEntries(Object.entries(forgedMiddle).filter(([key]) => key !== 'digest')));
      await fs.promises.writeFile(middlePath, JSON.stringify(forgedMiddle));
      await nodeAssert.rejects(store.getReceiptPage('listing', 5_000), /inclusion proof/i, 'a recomputed middle page no longer matches its authenticated index leaf');
      await fs.promises.writeFile(middlePath, JSON.stringify(fixture.middle.page));

      const indexPath = path.join(fixture.pagesDir, fixture.forgedIndex);
      const forgedIndex = JSON.parse(await fs.promises.readFile(indexPath, 'utf8'));
      if (forgedIndex.span === 1) forgedIndex.page.digest = '0'.repeat(64);
      else forgedIndex.left.digest = '0'.repeat(64);
      forgedIndex.digest = digest(Object.fromEntries(Object.entries(forgedIndex).filter(([key]) => key !== 'digest')));
      await fs.promises.writeFile(indexPath, JSON.stringify(forgedIndex));
      await nodeAssert.rejects(store.getReceiptPage('listing', 0), /index inclusion proof|branch is invalid/i, 'a forged index node cannot redirect an authenticated page lookup');
      return { pageCount: 10_000, reads, forgedMiddleRejected: true, forgedIndexRejected: true };
    } finally { __setAuthorityLedgerStoreFaultHookForTests(null); await fs.promises.rm(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'Authority ledger store rejects non-JSON genesis and records before they can leave artifacts',
  run: async () => {
    const parent = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-json-values-'));
    const invalidGenesis = path.join(parent, 'invalid-genesis'); const dir = path.join(parent, 'records');
    try {
      await Promise.all([fs.promises.mkdir(invalidGenesis), fs.promises.mkdir(dir)]);
      await nodeAssert.rejects(createAuthorityLedgerStore(invalidGenesis, { genesis: { missing: undefined } }), /not JSON serializable/i,
        'genesis rejects an undefined value before creating a pages directory');
      assert((await fs.promises.readdir(invalidGenesis)).length === 0,
        'a rejected genesis leaves neither a root nor a prepared directory behind');

      const store = await createAuthorityLedgerStore(dir);
      const sparse = [{ id: 'sparse-zero' }]; sparse.length = 2;
      const cyclic = { id: 'cyclic' }; cyclic.self = cyclic;
      const accessor = { id: 'accessor' }; Object.defineProperty(accessor, 'bad', { enumerable: true, get: () => 'not read' });
      const symbolKey = { id: 'symbol-key' }; symbolKey[Symbol('bad')] = 'not persisted';
      const invalidRecords = [
        [{ id: 'undefined', bad: undefined }],
        [{ id: 'function', bad: () => {} }],
        [{ id: 'symbol', bad: Symbol('bad') }],
        [{ id: 'bigint', bad: 1n }],
        [{ id: 'non-finite', bad: Infinity }],
        sparse,
        [cyclic],
        [{ id: 'exotic', bad: new Date() }],
        [accessor],
        [symbolKey],
      ];
      for (const records of invalidRecords) await nodeAssert.rejects(store.appendReceiptPage('receipt', records), /not JSON serializable/i,
        'records outside the canonical JSON value domain fail before hashing or writing a page');
      await nodeAssert.rejects(store.appendReceiptPages([
        { stream: 'receipt', records: [{ id: 'otherwise-valid-first-entry' }] },
        { stream: 'receipt', records: [{ id: 'invalid-later-entry', bad: undefined }] },
      ]), /not JSON serializable/i, 'array transactions preflight every record set before preparing their first page');
      assert((await fs.promises.readdir(path.join(dir, 'authority-ledger-pages'))).length === 0
        && Object.keys(store.receipt().streams).length === 0,
      'all rejected record shapes leave the root and immutable page directory untouched');
      await store.appendReceiptPage('receipt', [{ id: 'valid-after-rejections', nested: { values: [null, true, false, 1.5, 'text'] } }]);
      assert((await openAuthorityLedgerStore(dir)).receipt().streams.receipt.count === 1,
        'a valid canonical JSON record remains durable after the failed attempts');
      return { invalidGenesisArtifactFree: true, invalidRecordsArtifactFree: true, validRetry: true };
    } finally { await fs.promises.rm(parent, { recursive: true, force: true }); }
  },
}, {
  name: 'Authority ledger mutation-lock acquisition retries a released owner and reaps a dead owner',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-lock-handoff-'));
    const lock = path.join(dir, 'authority-ledger.mutation.lock');
    let removed = false;
    try {
      const store = await createAuthorityLedgerStore(dir);
      await fs.promises.writeFile(lock, JSON.stringify({ version: 1, namespace: 'authority-ledger', pid: process.pid, token: 'handoff-owner' }));
      __setAuthorityLedgerStoreFaultHookForTests(async step => {
        if (step === 'mutation-lock:exists') { removed = true; await fs.promises.unlink(lock); }
      });
      await store.appendReceiptPage('receipt', [{ id: 'released-lock-owner' }]);
      assert(removed && store.receipt().streams.receipt.count === 1,
        'a lock released between EEXIST and the follow-up read is retried and publishes normally');
      await nodeAssert.rejects(fs.promises.lstat(lock), { code: 'ENOENT' },
        'the successful retry releases only its own lease');
      __setAuthorityLedgerStoreFaultHookForTests(null);
      await fs.promises.writeFile(lock, JSON.stringify({ version: 1, namespace: 'authority-ledger', pid: 99_999_999, token: 'dead-owner' }));
      await store.appendReceiptPage('receipt', [{ id: 'reaped-dead-owner' }]);
      assert(store.receipt().streams.receipt.count === 2,
        'a dead process lock is unlinked by inode ownership and the next lease publishes normally');
      await nodeAssert.rejects(fs.promises.lstat(lock), { code: 'ENOENT' },
        'dead-owner recovery does not leave a replacement lease behind');
      return { disappearedLockRetried: removed, deadOwnerReaped: true, count: store.receipt().streams.receipt.count };
    } finally {
      __setAuthorityLedgerStoreFaultHookForTests(null);
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  },
}, {
  name: 'Authority ledger Darwin lock ownership is invariant across caller locales',
  run: async () => {
    if (process.platform !== 'darwin') return { skipped: 'darwin-only process identity' };
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-darwin-locale-'));
    const lock = path.join(dir, 'authority-ledger.mutation.lock');
    const originalLcAll = process.env.LC_ALL;
    const originalLang = process.env.LANG;
    const readStart = env => String(execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
      encoding: 'utf8', env,
    })).trim().replace(/\s+/gu, ' ');
    try {
      const cEnvironment = { ...process.env, LC_ALL: 'C', LANG: 'C' };
      const cStart = readStart(cEnvironment);
      const alternate = ['fr_FR.UTF-8', 'de_DE.UTF-8', 'ja_JP.UTF-8']
        .map(locale => ({ locale, start: readStart({ ...process.env, LC_ALL: locale, LANG: locale }) }))
        .find(candidate => candidate.start && candidate.start !== cStart);
      // Minimal macOS images occasionally install no alternate locale data;
      // their formatter cannot exercise this regression, so retain a clean
      // platform skip rather than making the whole suite locale-dependent.
      if (!alternate) return { skipped: 'no alternate ps lstart locale installed' };
      const store = await createAuthorityLedgerStore(dir);
      await fs.promises.writeFile(lock, JSON.stringify({
        version: 1, namespace: 'authority-ledger', pid: process.pid, token: 'same-process-different-locale',
        ownerStartIdentity: `darwin:${cStart}`,
      }));
      process.env.LC_ALL = alternate.locale;
      process.env.LANG = alternate.locale;
      await nodeAssert.rejects(store.appendReceiptPage('receipt', [{ id: 'must-not-reap-live-locale-owner' }]), /transaction is busy/i,
        'the same live PID must not be classified as reused merely because the contender has another locale');
      assert((await fs.promises.lstat(lock)).isFile(), 'a live lock remains owned after a locale-different contender is rejected');
      return { cLocaleIdentity: true, alternateLocale: alternate.locale };
    } finally {
      if (originalLcAll === undefined) delete process.env.LC_ALL; else process.env.LC_ALL = originalLcAll;
      if (originalLang === undefined) delete process.env.LANG; else process.env.LANG = originalLang;
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  },
}, {
  name: 'Authority ledger caches only successful local process-start identity lookups',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-local-identity-cache-'));
    const lock = path.join(dir, 'authority-ledger.mutation.lock');
    let child = null;
    try {
      const store = await createAuthorityLedgerStore(dir);
      const calls = [];
      let failFirstLocalLookup = true;
      __setAuthorityLedgerProcessIdentityHookForTests(pid => {
        calls.push(pid);
        if (pid === process.pid && failFirstLocalLookup) {
          failFirstLocalLookup = false;
          throw new Error('temporary self identity failure');
        }
        return `identity:${pid}`;
      });
      await nodeAssert.rejects(store.appendReceiptPage('receipt', [{ id: 'retry-local-identity' }]), /temporary self identity failure/i,
        'a failed self identity lookup must abort rather than populating the cache');
      await store.appendReceiptPage('receipt', [{ id: 'cached-local-identity' }]);
      await store.appendReceiptPage('receipt', [{ id: 'cached-local-identity-again' }]);
      assert(calls.filter(pid => pid === process.pid).length === 2,
        'the first failed self lookup must be retried once, then the successful self identity must be reused');

      child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10_000)'], { stdio: 'ignore' });
      await once(child, 'spawn');
      for (const id of ['foreign-lookup-one', 'foreign-lookup-two']) {
        await fs.promises.writeFile(lock, JSON.stringify({
          version: 1, namespace: 'authority-ledger', pid: child.pid, token: id, ownerStartIdentity: 'former-child-instance',
        }));
        await store.appendReceiptPage('receipt', [{ id }]);
      }
      assert(calls.filter(pid => pid === child.pid).length === 2,
        'a foreign PID must be re-identified for every stale-lock decision rather than using the local identity cache');
      return { failedLocalLookupRetried: true, successfulLocalLookupCached: true, foreignLookupsUncached: true };
    } finally {
      __setAuthorityLedgerProcessIdentityHookForTests(null);
      if (child && !child.killed) {
        child.kill();
        await once(child, 'exit').catch(() => {});
      }
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  },
}, {
  name: 'Authority ledger reaps a PID-reused lock but never takes over an unidentifiable live owner',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-pid-reuse-'));
    const lock = path.join(dir, 'authority-ledger.mutation.lock');
    try {
      const store = await createAuthorityLedgerStore(dir);
      await fs.promises.writeFile(lock, JSON.stringify({
        version: 1, namespace: 'authority-ledger', pid: process.pid, token: 'former-process', ownerStartIdentity: 'former-instance',
      }));
      __setAuthorityLedgerProcessIdentityHookForTests(() => 'current-instance');
      await store.appendReceiptPage('receipt', [{ id: 'reused-pid-lock-reaped' }]);
      assert(store.receipt().streams.receipt.count === 1,
        'a live PID with a different recorded process-start identity is a stale lock, not an active owner');

      await fs.promises.writeFile(lock, JSON.stringify({
        version: 1, namespace: 'authority-ledger', pid: process.pid, token: 'unidentifiable-owner', ownerStartIdentity: 'unknown-instance',
      }));
      let identityLookups = 0;
      __setAuthorityLedgerProcessIdentityHookForTests(() => {
        identityLookups += 1;
        if (identityLookups === 1) return 'current-instance';
        throw new Error('identity unavailable');
      });
      await nodeAssert.rejects(store.appendReceiptPage('receipt', [{ id: 'must-not-take-over' }]), /cannot be identified safely/i,
        'a live owner without a verifiable start identity must fail closed rather than being expired or taken over');
      assert((await fs.promises.lstat(lock)).isFile(), 'the unidentifiable live owner lock remains in place');
      return { pidReuseReaped: true, unknownOwnerPreserved: true };
    } finally {
      __setAuthorityLedgerProcessIdentityHookForTests(null);
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  },
}, {
  name: 'Authority ledger complete-history verification catches latent historical MMR and bucket loss without taxing ordinary opens',
  run: async () => {
    const indexed = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-complete-indexed-'));
    const buckets = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-complete-buckets-'));
    const held = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-complete-held-'));
    const nonHeld = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-complete-non-held-'));
    try {
      const fixture = await writeIndexedFixture(indexed, 10);
      await fs.promises.unlink(path.join(fixture.pagesDir, fixture.middle.file));
      const ordinary = await openAuthorityLedgerStore(indexed);
      assert((await ordinary.getReceiptPage('listing', 9)).records[0].text === 'page 9',
        'the ordinary poll-path head probe remains logarithmic when an earlier MMR leaf is absent');
      await nodeAssert.rejects(openAuthorityLedgerStore(indexed, { verifyAll: true }), /ENOENT|no such file|inclusion proof|invalid/i,
        'an explicit complete-history open walks every MMR path and rejects a missing historical leaf');
      await fs.promises.writeFile(path.join(fixture.pagesDir, fixture.middle.file), JSON.stringify(fixture.middle.page));
      await fs.promises.unlink(path.join(fixture.pagesDir, fixture.forgedIndex));
      assert((await openAuthorityLedgerStore(indexed)).receipt().streams.listing.count === 10,
        'the head stays readable when a different, historical MMR peak is absent');
      await nodeAssert.rejects(openAuthorityLedgerStore(indexed, { verifyAll: true }), /ENOENT|no such file|index|invalid/i,
        'complete-history verification reaches every root-referenced MMR peak and branch');

      const bucketStore = await createAuthorityLedgerStore(buckets);
      await bucketStore.appendReceiptPage('receipt', [{ id: 'repeated-id' }]);
      await bucketStore.appendReceiptPage('receipt', [{ id: 'repeated-id' }]);
      const bucketRoot = JSON.parse(await fs.promises.readFile(path.join(buckets, 'authority-ledger.root.json'), 'utf8'));
      const [bucket] = Object.entries(bucketRoot.idBuckets).find(([, value]) => value.count === 2);
      await fs.promises.unlink(path.join(buckets, 'authority-ledger-pages', `ids-${bucket}-000000000000.json`));
      assert((await openAuthorityLedgerStore(buckets)).receipt().streams.receipt.count === 2,
        'ordinary opens do not linearly rescan independent ID buckets');
      await nodeAssert.rejects(openAuthorityLedgerStore(buckets, { verifyAll: true }), /ENOENT|no such file|bucket|invalid/i,
        'complete-history verification checks every root-referenced ID bucket page');

      const heldStore = await createAuthorityLedgerStore(held);
      await heldStore.appendReceiptPage('receipt', [{ id: 'held-zero' }]);
      await heldStore.appendReceiptPage('receipt', [{ id: 'held-one' }], { holdJournal: true });
      await fs.promises.unlink(path.join(held, 'authority-ledger-pages', pageFile('receipt', 0)));
      await nodeAssert.rejects(openAuthorityLedgerStore(held), /ENOENT|no such file|inclusion proof|invalid/i,
        'a held-journal recovery open automatically performs complete-history verification before exposing cleanup controls');
      const nonHeldStore = await createAuthorityLedgerStore(nonHeld);
      await nonHeldStore.appendReceiptPage('receipt', [{ id: 'non-held-zero' }]);
      __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === 'root-published') throw new Error(step); });
      await nodeAssert.rejects(nonHeldStore.appendReceiptPage('receipt', [{ id: 'non-held-one' }]), /root-published/);
      __setAuthorityLedgerStoreFaultHookForTests(null);
      const nonHeldJournal = path.join(nonHeld, 'authority-ledger.journal.json');
      const nonHeldJournalBytes = await fs.promises.readFile(nonHeldJournal, 'utf8'); const nonHeldJournalStat = await fs.promises.lstat(nonHeldJournal);
      await fs.promises.unlink(path.join(nonHeld, 'authority-ledger-pages', pageFile('receipt', 0)));
      await nodeAssert.rejects(openAuthorityLedgerStore(nonHeld), /ENOENT|no such file|inclusion proof|invalid/i,
        'non-held recovery verifies the complete next root before discarding its crash journal');
      const preservedJournalStat = await fs.promises.lstat(nonHeldJournal);
      assert(await fs.promises.readFile(nonHeldJournal, 'utf8') === nonHeldJournalBytes
        && preservedJournalStat.ino === nonHeldJournalStat.ino && preservedJournalStat.dev === nonHeldJournalStat.dev,
      'a failed non-held recovery preserves the exact journal marker for diagnosis and retry');
      return { latentLeafRejected: true, latentIndexRejected: true, latentBucketRejected: true, heldRecoveryRejected: true, nonHeldMarkerPreserved: true };
    } finally {
      __setAuthorityLedgerStoreFaultHookForTests(null);
      await Promise.all([indexed, buckets, held, nonHeld].map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
    }
  },
}, {
  name: 'Authority ledger immutable pages reject divergent stale writes and serialize journal publication',
  run: async () => {
    const divergentDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-no-replace-pages-'));
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-no-replace-journal-'));
    let releaseJournal; let leftWrite;
    try {
      // A journal-before-root crash leaves an unreachable immutable capability.
      // A divergent retry must not replace it, even after ordinary recovery
      // clears the non-held crash marker.
      await createAuthorityLedgerStore(divergentDir);
      const divergentLeft = await openAuthorityLedgerStore(divergentDir);
      const leftRecords = [{ id: 'left-id', indexKeys: ['left-key'], text: 'left writer' }];
      const rightRecords = [{ id: 'right-id', indexKeys: ['right-key'], text: 'right writer' }];
      __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === 'journal-published') throw new Error(step); });
      await nodeAssert.rejects(divergentLeft.appendReceiptPage('receipt', leftRecords), /journal-published/);
      __setAuthorityLedgerStoreFaultHookForTests(null);
      await openAuthorityLedgerStore(divergentDir);
      const divergentPage = path.join(divergentDir, 'authority-ledger-pages', pageFile('receipt', 0));
      const divergentBytes = await fs.promises.readFile(divergentPage, 'utf8');
      const divergentRight = await openAuthorityLedgerStore(divergentDir);
      await nodeAssert.rejects(divergentRight.appendReceiptPage('receipt', rightRecords), /immutable page already exists/i,
        'a divergent retry cannot replace an immutable page left by an interrupted writer');
      assert(await fs.promises.readFile(divergentPage, 'utf8') === divergentBytes,
        'the interrupted immutable capability remains byte-identical after a divergent retry fails');

      await createAuthorityLedgerStore(dir);
      const left = await openAuthorityLedgerStore(dir); const right = await openAuthorityLedgerStore(dir);
      let reachedPage;
      const releasePublication = new Promise(resolve => { releaseJournal = resolve; });
      const pagePublished = new Promise(resolve => { reachedPage = resolve; });
      __setAuthorityLedgerStoreFaultHookForTests(async step => {
        if (step === 'page:fsync') { reachedPage(); await releasePublication; }
      });
      const sharedRecords = [{ id: 'shared-id', indexKeys: ['shared-key'], text: 'same immutable writer' }];
      leftWrite = left.appendReceiptPage('receipt', sharedRecords);
      await pagePublished;
      await nodeAssert.rejects(right.appendReceiptPage('other-stream', [{ id: 'other-id', text: 'other stream' }]), /transaction is busy/i,
        'a second writer cannot publish even a different-stream page while the first owns prepare/publication');
      releaseJournal(); await leftWrite;
      __setAuthorityLedgerStoreFaultHookForTests(null);
      await nodeAssert.rejects(right.appendReceiptPage('other-stream', [{ id: 'other-id', text: 'other stream' }]), /root (?:ownership )?changed|reopen and retry/i,
        'after the lease releases, the stale writer rechecks the root instead of regressing it');
      const immutablePath = path.join(dir, 'authority-ledger-pages', pageFile('receipt', 0));
      const publishedBytes = await fs.promises.readFile(immutablePath, 'utf8');
      assert(JSON.stringify(JSON.parse(publishedBytes).records) === JSON.stringify(sharedRecords),
        'only the prepare/publication lease owner creates the receipt page');
      await nodeAssert.rejects(fs.promises.lstat(path.join(dir, 'authority-ledger-pages', pageFile('other-stream', 0))), /ENOENT/,
        'the rejected different-stream writer leaves no unreferenced immutable capability behind');
      assert(await fs.promises.readFile(immutablePath, 'utf8') === publishedBytes,
        'the committed immutable receipt page remains unchanged after stale attempts');
      return { preparedWriterRejectedBeforePage: true, rejectedDivergentPublisher: true };
    } finally {
      releaseJournal?.(); __setAuthorityLedgerStoreFaultHookForTests(null); await leftWrite?.catch(() => {});
      await Promise.all([divergentDir, dir].map(value => fs.promises.rm(value, { recursive: true, force: true })));
    }
  },
}, {
  name: 'Authority ledger store publishes a many-page multi-stream transaction as one root',
  run: async () => {
    const boundaries = ['transaction:page', 'transaction:index', 'transaction:bucket', 'journal-published', 'root-published', 'journal-removed'];
    for (const boundary of boundaries) {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-many-'));
      try {
        const store = await createAuthorityLedgerStore(dir); const entries = Array.from({ length: 101 }, (_unused, index) => ({
          stream: index % 2 ? 'reductions' : 'role-omissions', records: [{ id: `${index % 2 ? 'r' : 'o'}-${index}`, indexKeys: [`k-${index}`] }],
        }));
        __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === boundary) throw new Error(boundary); });
        await nodeAssert.rejects(store.appendReceiptPages(entries), new RegExp(boundary.replace(':', '\\:')));
        __setAuthorityLedgerStoreFaultHookForTests(null);
        const reopened = await openAuthorityLedgerStore(dir); const receipt = reopened.receipt();
        const total = (receipt.streams.reductions?.count || 0) + (receipt.streams['role-omissions']?.count || 0);
        assert([0, 101].includes(total), `${boundary} exposes either the prior root or the complete transaction, never a partial root`);
        if (!total) await reopened.appendReceiptPages(entries);
        const retried = await openAuthorityLedgerStore(dir);
        assert((retried.receipt().streams.reductions?.count || 0) + (retried.receipt().streams['role-omissions']?.count || 0) === 101, `${boundary} retry publishes all pages exactly once`);
      } finally { __setAuthorityLedgerStoreFaultHookForTests(null); await fs.promises.rm(dir, { recursive: true, force: true }); }
    }
  },
}, {
  name: 'Authority ledger store holds a cross-file receipt until the manifest transaction commits or rolls back',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-held-'));
    try {
      const store = await createAuthorityLedgerStore(dir);
      const before = store.receipt();
      await store.appendReceiptPage('requirements', [{ id: 'p1-need' }], { holdJournal: true });
      const published = store.receipt();
      assert(store.pendingJournal?.previous === before.digest && store.pendingJournal?.next === published.digest,
        'a held append binds both manifest-visible receipt roots');
      const reopenedBeforeManifest = await openAuthorityLedgerStore(dir);
      assert(reopenedBeforeManifest.pendingJournal?.previous === before.digest,
        'a restart retains the held journal for the manifest owner rather than silently committing it');
      await reopenedBeforeManifest.rollbackPendingJournal();
      assert((await openAuthorityLedgerStore(dir)).receipt().digest === before.digest,
        'the manifest owner can deterministically roll an unpublished receipt back');

      const retry = await openAuthorityLedgerStore(dir);
      await retry.appendReceiptPage('requirements', [{ id: 'p1-need' }], { holdJournal: true });
      const committed = retry.receipt();
      const reopenedAfterManifest = await openAuthorityLedgerStore(dir);
      assert(reopenedAfterManifest.receipt().digest === committed.digest && reopenedAfterManifest.pendingJournal,
        'a published root remains readable while its manifest-finalization marker is pending');
      await reopenedAfterManifest.finalizePendingJournal();
      assert(!(await openAuthorityLedgerStore(dir)).pendingJournal,
        'the manifest owner clears only the journal for the receipt it committed');
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'Authority ledger held ownership rejects a rollback actor opened between journal and root publication',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-held-before-root-race-'));
    let release; let append;
    try {
      const store = await createAuthorityLedgerStore(dir); const before = store.receipt(); let journalPublished;
      const waitForJournal = new Promise(resolve => { journalPublished = resolve; });
      const releaseJournal = new Promise(resolve => { release = resolve; });
      __setAuthorityLedgerStoreFaultHookForTests(async step => {
        if (step === 'journal-published') { journalPublished(); await releaseJournal; }
      });
      append = store.appendReceiptPage('receipt', [{ id: 'between-journal-and-root' }], { holdJournal: true });
      await waitForJournal;
      const stale = await openAuthorityLedgerStore(dir);
      assert(stale.receipt().digest === before.digest && stale.pendingJournal,
        'the race actor observes the durable held journal while the root is still previous');
      await nodeAssert.rejects(stale.rollbackPendingJournal(), /transaction is busy|reopen and retry/i,
        'the journal writer lease prevents rollback from deleting pages before its root publication finishes');
      release(); await append; __setAuthorityLedgerStoreFaultHookForTests(null);
      const committed = await openAuthorityLedgerStore(dir);
      assert(committed.pendingJournal && committed.receipt().streams.receipt.count === 1
        && (await committed.getReceiptPage('receipt', 0)).records[0].id === 'between-journal-and-root',
      'the writer commits a complete, readable root after the racing rollback was denied');
      await nodeAssert.rejects(stale.rollbackPendingJournal(), /root (?:ownership )?changed|reopen and retry/i,
        'the stale pre-root snapshot cannot restore its old root after the writer commits');
      const after = await openAuthorityLedgerStore(dir);
      assert(after.receipt().digest === committed.receipt().digest && (await after.getReceiptPage('receipt', 0)).records[0].id === 'between-journal-and-root',
        'the stale rollback leaves the committed page and held journal intact');
      await after.finalizePendingJournal();
      return { busyPreRootRollbackRejected: true, stalePostRootRollbackRejected: true };
    } finally {
      release?.(); __setAuthorityLedgerStoreFaultHookForTests(null); await append?.catch(() => {});
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  },
}, {
  name: 'Authority ledger held ownership cannot unlink a successor journal or delete its committed history',
  run: async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-held-successor-race-'));
    try {
      const initial = await createAuthorityLedgerStore(dir);
      await initial.appendReceiptPage('receipt', [{ id: 'first-held-page' }], { holdJournal: true });
      const staleFinalizer = await openAuthorityLedgerStore(dir);
      const staleRollbacker = await openAuthorityLedgerStore(dir);
      const journalFile = path.join(dir, 'authority-ledger.journal.json'); const firstJournal = await fs.promises.readFile(journalFile, 'utf8');
      const firstJournalStat = await fs.promises.lstat(journalFile); const sameContentReplacement = `${journalFile}.same-content-replacement`;
      await fs.promises.writeFile(sameContentReplacement, firstJournal); await fs.promises.rename(sameContentReplacement, journalFile);
      const replacedJournalStat = await fs.promises.lstat(journalFile);
      assert(replacedJournalStat.ino !== firstJournalStat.ino || replacedJournalStat.dev !== firstJournalStat.dev,
        'the inode replacement seam actually gives the stale actor a byte-identical successor inode');
      await nodeAssert.rejects(staleFinalizer.finalizePendingJournal(), /held journal ownership changed|reopen and retry/i,
        'transaction content equality alone cannot authorize a stale finalizer after its journal inode changes');
      const firstOwner = await openAuthorityLedgerStore(dir); await firstOwner.finalizePendingJournal();
      const successor = await openAuthorityLedgerStore(dir);
      await successor.appendReceiptPage('receipt', [{ id: 'successor-held-page' }], { holdJournal: true });
      const expected = successor.receipt();
      const successorJournal = await fs.promises.readFile(journalFile, 'utf8'); const successorJournalStat = await fs.promises.lstat(journalFile);
      await nodeAssert.rejects(staleFinalizer.finalizePendingJournal(), /held journal ownership changed|reopen and retry/i,
        'a stale finalizer cannot unlink the successor journal at the shared pathname');
      await nodeAssert.rejects(staleRollbacker.rollbackPendingJournal(), /held journal ownership changed|reopen and retry/i,
        'a stale rollbacker cannot restore its old root or delete a now-committed historical page');
      const afterJournalStat = await fs.promises.lstat(journalFile);
      assert(await fs.promises.readFile(journalFile, 'utf8') === successorJournal
        && afterJournalStat.ino === successorJournalStat.ino && afterJournalStat.dev === successorJournalStat.dev,
      'the successor journal retains exact content and inode ownership after both stale operations fail');
      const reopened = await openAuthorityLedgerStore(dir);
      assert(reopened.pendingJournal && reopened.receipt().digest === expected.digest
        && (await reopened.getReceiptPage('receipt', 0)).records[0].id === 'first-held-page'
        && (await reopened.getReceiptPage('receipt', 1)).records[0].id === 'successor-held-page',
      'the successor root retains both the formerly held page and its newly committed page');
      await reopened.finalizePendingJournal();
      return { inodeReplacementRejected: true, successorJournalPreserved: true, committedHistoryPreserved: true };
    } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
  },
}, {
  name: 'Authority ledger held rollback binds its next root, survives cleanup interruption, and fails closed on tampering',
  run: async () => {
    const journalPublished = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-held-journal-'));
    const cleanupInterrupted = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-held-cleanup-'));
    const tampered = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-held-tampered-'));
    const largeRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-held-large-root-'));
    try {
      // The journal is durable before the root pointer. Its self-contained next
      // root must identify every orphan so a different retry can reuse names.
      const beforeJournal = await createAuthorityLedgerStore(journalPublished);
      __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === 'journal-published') throw new Error(step); });
      await nodeAssert.rejects(beforeJournal.appendReceiptPage('receipt', [{ id: 'first-random-capability' }], { holdJournal: true }), /journal-published/);
      __setAuthorityLedgerStoreFaultHookForTests(null);
      const afterJournal = await openAuthorityLedgerStore(journalPublished);
      assert(afterJournal.pendingJournal?.nextState?.digest === afterJournal.pendingJournal?.next,
        'a held journal published before its root binds the exact intended next root');
      await afterJournal.rollbackPendingJournal();
      await afterJournal.appendReceiptPage('receipt', [{ id: 'second-random-capability' }], { holdJournal: true });
      assert(afterJournal.pendingJournal && afterJournal.receipt().streams.receipt.count === 1,
        'rollback removes the unreachable first page before a distinct retry reuses its page number');

      // A cleanup crash must never leave the durable root referring to a page
      // that has already been removed. The still-held journal makes retrying
      // the remainder idempotent.
      const beforeCleanup = await createAuthorityLedgerStore(cleanupInterrupted);
      const cleanupBefore = beforeCleanup.receipt();
      await beforeCleanup.appendReceiptPage('receipt', [{ id: 'cleanup-first', indexKeys: ['cleanup-first'] }], { holdJournal: true });
      const interrupted = await openAuthorityLedgerStore(cleanupInterrupted);
      __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === 'rollback:orphan-removed') throw new Error(step); });
      await nodeAssert.rejects(interrupted.rollbackPendingJournal(), /rollback:orphan-removed/);
      __setAuthorityLedgerStoreFaultHookForTests(null);
      const resumed = await openAuthorityLedgerStore(cleanupInterrupted);
      assert(resumed.receipt().digest === cleanupBefore.digest && resumed.pendingJournal,
        'an interrupted cleanup reopens the previous complete root with its resumable held journal');
      await resumed.rollbackPendingJournal();
      await resumed.appendReceiptPage('receipt', [{ id: 'cleanup-second' }]);
      assert((await openAuthorityLedgerStore(cleanupInterrupted)).receipt().streams.receipt.count === 1,
        'resumed cleanup removes only remaining orphans and permits the retry');

      const beforeTamper = await createAuthorityLedgerStore(tampered);
      __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === 'journal-published') throw new Error(step); });
      await nodeAssert.rejects(beforeTamper.appendReceiptPage('receipt', [{ id: 'tampered' }], { holdJournal: true }), /journal-published/);
      __setAuthorityLedgerStoreFaultHookForTests(null);
      const orphan = path.join(tampered, 'authority-ledger-pages', pageFile('receipt', 0));
      await fs.promises.writeFile(orphan, '{}', 'utf8');
      const tamperedJournal = await openAuthorityLedgerStore(tampered);
      await nodeAssert.rejects(tamperedJournal.rollbackPendingJournal(), /substituted|inclusion proof|invalid/i,
        'rollback refuses a substituted orphan rather than deleting an arbitrary regular file');
      assert(await fs.promises.readFile(orphan, 'utf8') === '{}', 'a rejected rollback leaves the unverified file intact');

      // Each root remains a normal bounded page, but a held journal contains
      // two snapshots. This is deliberately larger than one page and proves
      // journal reads/writes use their own fixed, bounded envelope.
      const large = await createAuthorityLedgerStore(largeRoot, { genesis: { padding: 'x'.repeat(220 * 1024) } });
      await large.appendReceiptPage('receipt', [{ id: 'large-root-journal' }], { holdJournal: true });
      assert((await openAuthorityLedgerStore(largeRoot)).pendingJournal,
        'a held journal accepts two near-page-size roots without imposing a hidden aggregate review cap');
      return { journalPublishedRollback: true, cleanupResumed: true, substitutedOrphanPreserved: true, largeHeldJournal: true };
    } finally {
      __setAuthorityLedgerStoreFaultHookForTests(null);
      await Promise.all([journalPublished, cleanupInterrupted, tampered, largeRoot].map(dir => fs.promises.rm(dir, { recursive: true, force: true })));
    }
  },
}, {
  name: 'Authority ledger store recovers journal publication boundaries without publishing an orphan',
  run: async () => {
    for (const boundary of ['journal-published', 'root-published', 'journal-removed']) {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-crash-'));
      try {
        const store = await createAuthorityLedgerStore(dir);
        __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === boundary) throw new Error(boundary); });
        let interrupted = false; try { await store.appendReceiptPage('receipt', [{ id: 'one' }]); } catch { interrupted = true; }
        finally { __setAuthorityLedgerStoreFaultHookForTests(null); }
        assert(interrupted, `fault injected after ${boundary}`);
        const reopened = await openAuthorityLedgerStore(dir);
        const count = reopened.receipt().streams.receipt?.count || 0;
        assert((boundary === 'journal-published' ? count === 0 : count === 1), `${boundary} reopens at exactly one published root revision`);
      } finally { __setAuthorityLedgerStoreFaultHookForTests(null); await fs.promises.rm(dir, { recursive: true, force: true }); }
    }
  },
}, {
  name: 'Authority ledger store cleans every low-level interrupted writer boundary',
  run: async () => {
    const boundaries = ['temp', 'write', 'fsync', 'rename', 'dir-fsync'];
    for (const kind of ['page', 'bucket', 'journal', 'root']) for (const phase of boundaries) {
      const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'authority-ledger-low-level-'));
      try {
        const store = await createAuthorityLedgerStore(dir);
        const target = `${kind}:${phase}`;
        __setAuthorityLedgerStoreFaultHookForTests(step => { if (step === target) throw new Error(target); });
        let interrupted = false; try { await store.appendReceiptPage('receipt', [{ id: 'one' }]); } catch (error) { interrupted = String(error?.message || error).includes(target); }
        finally { __setAuthorityLedgerStoreFaultHookForTests(null); }
        assert(interrupted, `injects ${target}`);
        const reopened = await openAuthorityLedgerStore(dir);
        const published = kind === 'root' && ['rename', 'dir-fsync'].includes(phase);
        assert((reopened.receipt().streams.receipt?.count || 0) === (published ? 1 : 0), `${target} reopens at its exact publication boundary`);
        const names = await fs.promises.readdir(dir);
        const pageNames = await fs.promises.readdir(path.join(dir, 'authority-ledger-pages'));
        assert(![...names, ...pageNames].some(name => name.startsWith('.') && name.endsWith('.tmp')), `${target} cleans every temporary file`);
        if (!published) await reopened.appendReceiptPage('receipt', [{ id: 'one' }]);
        assert((await openAuthorityLedgerStore(dir)).receipt().streams.receipt.count === 1, `${target} retry publishes exactly once`);
      } finally { __setAuthorityLedgerStoreFaultHookForTests(null); await fs.promises.rm(dir, { recursive: true, force: true }); }
    }
  },
}];
