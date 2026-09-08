import { docSaveDebounceMs, TIMINGS } from './timings.js';

const initialSnapshot = () => ({
  status: 'loading',
  content: null,
  diskContent: null,
  error: null,
  saveStatus: 'idle',
  externalChange: false,
  durabilityUnverified: false,
});

const TEXT_FILE_DURABILITY_UNVERIFIED = 'TEXT_FILE_DURABILITY_UNVERIFIED';

// Textareas normalize every supported newline spelling to LF in their `value`
// IDL attribute. Keep the session/disk string byte-faithful and adapt only at
// the editor boundary. Mixed files deliberately use LF on the next edit: their
// original per-line spelling cannot survive the browser control, and LF avoids
// inventing a platform-specific mixture. A CRLF- or CR-only document retains
// its convention for all edits made through any duplicate view.
export function textDocumentNewlineStyle(content) {
  const value = String(content ?? '');
  const withoutCrLf = value.replace(/\r\n/g, '');
  const hasCrLf = /\r\n/.test(value);
  const hasLoneLf = /\n/.test(withoutCrLf);
  const hasLoneCr = /\r/.test(withoutCrLf);
  if (hasCrLf && !hasLoneLf && !hasLoneCr) return 'crlf';
  if (hasLoneCr && !hasCrLf && !hasLoneLf) return 'cr';
  return 'lf';
}

export function textDocumentToTextarea(content) {
  return String(content ?? '').replace(/\r\n|\r/g, '\n');
}

export function textDocumentFromTextarea(value, sourceContent) {
  return textDocumentFromTextareaWithStyle(value, textDocumentNewlineStyle(sourceContent));
}

export function textDocumentFromTextareaWithStyle(value, style) {
  const normalized = textDocumentToTextarea(value);
  if (style === 'crlf') return normalized.replace(/\n/g, '\r\n');
  if (style === 'cr') return normalized.replace(/\n/g, '\r');
  return normalized;
}

/**
 * One editable local file can be represented by many canvas nodes. Keeping the
 * editing state here, keyed by the canonical target returned by the validated
 * reader, makes stable direct aliases (case and Unicode spellings) views of
 * one document rather than independent last-writer-wins editors. Symlinked
 * spellings intentionally remain separate because they can be retargeted.
 * Until a read has proved a stable identity, the lexical path remains only a
 * provisional key. It is never merged after it could contain a local draft.
 *
 * `read` and `write` are injected so the state machine has deterministic unit
 * tests and does not depend on Electron at module evaluation time.
 */
export function createTextDocumentSessionRegistry({
  read,
  write,
  debounceMs = docSaveDebounceMs,
  feedbackMs = TIMINGS.FEEDBACK_MS,
  evictionMs = 30_000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onListenerError = (error) => console.error('Text document session listener failed:', error),
} = {}) {
  if (typeof read !== 'function' || typeof write !== 'function') {
    throw new Error('Text document sessions require read and write functions.');
  }

  // Maps every renderer-facing spelling to its session. A session may own
  // several aliases once their reads resolve to the same real path.
  const sessions = new Map();
  // A session-identity token is issued only for a path whose entire lexical
  // traversal is non-symlink. It can therefore coalesce case/Unicode aliases
  // without tying a direct view to a mutable symlink. The separate targetToken
  // remains the write CAS precondition in every session.
  const sessionsByIdentityToken = new Map();
  // Error telemetry is observational. A consumer-provided reporter must not
  // get authority to interrupt delivery to the remaining document views.
  const reportListenerError = (error, filePath) => {
    try { onListenerError(error, filePath); } catch { /* reporter failures are isolated */ }
  };
  // The production reader returns the exact text plus the canonical path it
  // validated. Existing deterministic tests intentionally inject plain strings;
  // treat those as tokenless rather than changing that compact test API.
  const normalizeReadResult = (result) => {
    if (typeof result === 'string') {
      return { content: result, targetToken: undefined, sessionIdentityToken: undefined };
    }
    if (result && typeof result.content === 'string') {
      return {
        content: result.content,
        targetToken: typeof result.targetToken === 'string' ? result.targetToken : undefined,
        sessionIdentityToken: typeof result.sessionIdentityToken === 'string'
          ? result.sessionIdentityToken
          : undefined,
      };
    }
    throw new Error('Failed to read text file');
  };

  class Session {
    constructor(filePath) {
      this.filePath = filePath;
      this.aliases = new Set([filePath]);
      this.snapshot = initialSnapshot();
      this.listeners = new Set();
      this.loaded = false;
      this.loadGeneration = 0;
      // The canonical path that produced diskContent. It deliberately remains
      // stable across this app's atomic inode replacement, but differs if a
      // final symlink was retargeted to a separate same-content file.
      this.targetToken = undefined;
      this.indexedIdentityToken = undefined;
      this.revision = 0;
      this.discardedThroughRevision = 0;
      this.pending = null;
      this.saveTimer = null;
      this.feedbackTimer = null;
      this.activeRequest = null;
      this.writeChain = Promise.resolve();
      this.reconcilePromise = null;
      this.reconcileQueued = false;
      this.lastNotificationId = null;
      this.suspended = false;
      this.wasDetached = false;
      this.queuedWriteCount = 0;
      this.evictionTimer = null;
      this.newlineStyle = 'lf';
      this.durabilityUnverified = false;
      this.abandoned = false;
    }

    targetChanged(nextTargetToken) {
      return typeof this.targetToken === 'string'
        && typeof nextTargetToken === 'string'
        && this.targetToken !== nextTargetToken;
    }

    acceptTargetToken(nextTargetToken) {
      if (typeof nextTargetToken === 'string') this.targetToken = nextTargetToken;
    }

    acceptSessionIdentityToken(nextSessionIdentityToken) {
      if (this.indexedIdentityToken === nextSessionIdentityToken) return;
      if (this.indexedIdentityToken
          && sessionsByIdentityToken.get(this.indexedIdentityToken) === this) {
        sessionsByIdentityToken.delete(this.indexedIdentityToken);
      }
      this.indexedIdentityToken = undefined;
      // Never perform a late merge here. A later read can observe a rename,
      // case/Unicode canonicalization change, or a path that has become a
      // symlink while this session holds a draft. It may safely claim an empty
      // identity slot, but ownership collisions remain separate sessions.
      if (typeof nextSessionIdentityToken === 'string'
          && !this.hasUnresolvedChanges()
          && !sessionsByIdentityToken.has(nextSessionIdentityToken)) {
        sessionsByIdentityToken.set(nextSessionIdentityToken, this);
        this.indexedIdentityToken = nextSessionIdentityToken;
      }
    }

    adoptNewlineStyle(content, { preserveEstablishedStyleForSingleLine = false } = {}) {
      if (preserveEstablishedStyleForSingleLine
          && !/[\r\n]/.test(content)
          && (this.newlineStyle === 'crlf' || this.newlineStyle === 'cr')) return;
      this.newlineStyle = textDocumentNewlineStyle(content);
    }

    emit(patch = null) {
      if (patch) this.snapshot = { ...this.snapshot, ...patch };
      // A stale duplicate view must not be able to reject the shared save lane
      // or prevent healthy views from observing the same state. Take a
      // snapshot so an unsubscribe during delivery affects only future emits.
      for (const subscription of [...this.listeners]) {
        try {
          subscription.listener(this.snapshot);
        } catch (error) {
          reportListenerError(error, this.filePath);
        }
      }
    }

    drainQueuedWatch() {
      if (!this.reconcileQueued || this.reconcilePromise) return;
      this.reconcileQueued = false;
      void this.notifyFileChanged();
    }

    subscribe(listener) {
      const wasEmpty = this.listeners.size === 0;
      if (this.evictionTimer) {
        clearTimer(this.evictionTimer);
        this.evictionTimer = null;
      }
      const subscription = { listener, owner: this };
      this.listeners.add(subscription);
      try {
        listener(this.snapshot);
      } catch (error) {
        reportListenerError(error, this.filePath);
      }
      if (wasEmpty && this.wasDetached) {
        this.wasDetached = false;
        void this.refreshAfterDetached();
      }
      return () => {
        // A provisional alias can be promoted into an already-live canonical
        // session while React still holds this original unsubscribe closure.
        // Remove from the current owner, not necessarily `this`.
        const owner = subscription.owner;
        if (!owner.listeners.delete(subscription)) return;
        if (owner.listeners.size === 0) {
          owner.wasDetached = true;
          owner.flushPending();
          owner.maybeScheduleEviction();
        }
      };
    }

    async ensureLoaded() {
      if (this.loaded || this.snapshot.status === 'loading' && this.loadGeneration > 0) return;
      this.loaded = true;
      const generation = ++this.loadGeneration;
      this.emit(initialSnapshot());
      try {
        const { content, targetToken, sessionIdentityToken } = normalizeReadResult(await read(this.filePath, generation));
        if (generation !== this.loadGeneration) return;
        // Claim identity while this alias is still non-editable. If a sibling
        // already owns the target, move this view onto it and do not apply this
        // read over that session's possibly dirty shared draft.
        if (claimInitialSessionIdentity(this, targetToken, sessionIdentityToken, content) !== this) return;
        this.adoptNewlineStyle(content);
        this.emit({ status: 'done', content, diskContent: content, error: null });
        this.drainQueuedWatch();
        this.maybeScheduleEviction();
      } catch (error) {
        if (generation !== this.loadGeneration) return;
        this.emit({ status: 'error', content: null, diskContent: null, error: error?.message || 'Failed to load file' });
        this.drainQueuedWatch();
      }
    }

    edit(content) {
      if (this.abandoned || typeof content !== 'string' || this.snapshot.status !== 'done') return;
      this.revision += 1;
      this.emit({ content, saveStatus: 'idle', error: null });
      if (this.suspended) return;
      this.schedule({ revision: this.revision, content }, debounceMs(content.length));
    }

    editFromTextarea(content) {
      this.edit(textDocumentFromTextareaWithStyle(content, this.newlineStyle));
    }

    schedule(request, delay) {
      if (this.abandoned) return;
      if (this.saveTimer) clearTimer(this.saveTimer);
      if (this.feedbackTimer) {
        clearTimer(this.feedbackTimer);
        this.feedbackTimer = null;
      }
      this.pending = request;
      this.saveTimer = setTimer(() => {
        this.saveTimer = null;
        if (this.pending !== request) return;
        this.pending = null;
        this.enqueueWrite(request);
      }, delay);
    }

    enqueueWrite(request) {
      this.queuedWriteCount += 1;
      const perform = async () => {
        try {
          // A watcher can invalidate a request after its debounce timer has
          // fired but before this serialized lane begins. It still counts as
          // queued, so this guard belongs inside finally-backed cleanup.
          if (this.abandoned || request.revision <= this.discardedThroughRevision || this.suspended) return;
          this.activeRequest = request;
          this.emit({ saveStatus: 'saving' });
          // The expected baseline is deliberately read at execution time: a
          // newer queued local edit follows an earlier local atomic write and
          // must compare against that just-written disk version, not its old
          // pre-write baseline.
          const result = await write(
            this.filePath,
            request.content,
            this.snapshot.diskContent,
            this.targetToken,
          );
          if (!result?.success) {
            if (result?.errorCode === 'TEXT_FILE_CONFLICT') {
              await this.reconcileConflict();
              return;
            }
            if (result?.errorCode === TEXT_FILE_DURABILITY_UNVERIFIED) {
              // The main process only reports this code after rename completed
              // and the parent-directory fsync failed. Record the known disk
              // bytes, but do not let the resulting self-watch event attest
              // durability; a close/manual retry must issue the idempotent
              // write again and clear this flag only after its fsync succeeds.
              this.durabilityUnverified = true;
              const latest = request.revision === this.revision;
              this.emit({
                diskContent: request.content,
                durabilityUnverified: true,
                saveStatus: latest ? 'error' : 'idle',
                error: latest ? (result.error || 'Text file durability could not be verified') : this.snapshot.error,
              });
              return;
            }
            throw new Error(result?.error || 'Failed to write text file');
          }
          this.durabilityUnverified = false;
          // A self-watch may have invalidated this request while its atomic
          // replacement was in flight. A successful write response still
          // proves the parent fsync completed, so clear the private barrier
          // before yielding to that watcher reconciliation.
          if (this.abandoned || request.revision <= this.discardedThroughRevision) {
            // The watcher will classify the observed bytes next, but it must
            // not retain the prior fsync failure after this response has
            // actually completed the barrier.
            if (this.snapshot.durabilityUnverified) {
              this.emit({ durabilityUnverified: false, saveStatus: 'idle', error: null });
            }
            return;
          }
          const latest = request.revision === this.revision;
          this.emit({
            diskContent: request.content,
            durabilityUnverified: false,
            saveStatus: latest ? 'saved' : 'idle',
            error: null,
          });
          if (latest) {
            this.feedbackTimer = setTimer(() => {
              this.feedbackTimer = null;
              if (request.revision === this.revision) this.emit({ saveStatus: 'idle' });
            }, feedbackMs);
          }
        } catch (error) {
          if (!this.abandoned && request.revision === this.revision) {
            this.emit({
              saveStatus: 'error',
              error: error?.message || 'Failed to save text file',
            });
          }
        } finally {
          if (this.activeRequest === request) this.activeRequest = null;
          this.queuedWriteCount -= 1;
          this.maybeScheduleEviction();
        }
      };
      this.writeChain = this.writeChain.then(perform, perform);
    }

    flushPending() {
      if (this.abandoned || !this.pending || this.suspended) return;
      const pending = this.pending;
      this.pending = null;
      if (this.saveTimer) {
        clearTimer(this.saveTimer);
        this.saveTimer = null;
      }
      this.enqueueWrite(pending);
    }

    canEvict() {
      // Status/error/suspension are presentation state when there is no draft
      // that differs from its durable baseline. Retaining an unreadable initial
      // preview or a clean watcher reread failure forever would leak sessions;
      // the next attach performs a fresh read. Any divergent draft/conflict is
      // still deliberately retained for Reload/Keep mine.
      return this.listeners.size === 0
        && this.snapshot.content === this.snapshot.diskContent
        && !this.pending
        && !this.saveTimer
        && !this.activeRequest
        && !this.reconcilePromise
        && this.queuedWriteCount === 0
        && !this.durabilityUnverified;
    }

    hasUnresolvedChanges() {
      if (this.abandoned) return false;
      // A preview that never loaded has no local draft or disk baseline to
      // protect. Do not trap quit merely because an unreadable file node is
      // visible; only retained/edited document content participates.
      if (this.snapshot.content === null && this.snapshot.diskContent === null) return false;
      // A conflict/read error without a divergent local draft is useful UI
      // state, not unsaved data. Conversely, lane work counts even if a user
      // has typed back to the baseline: an older in-flight write can still
      // require a compensating write before it is safe to destroy the window.
      return this.snapshot.content !== this.snapshot.diskContent
        || this.durabilityUnverified
        || Boolean(this.pending)
        || Boolean(this.saveTimer)
        || Boolean(this.activeRequest)
        || this.queuedWriteCount > 0;
    }

    async flushAndSettle() {
      // Closing or replacing a canvas must not abandon the document's last
      // debounce. Conflicts/errors remain intentionally unresolved: this API
      // observes them rather than discarding their drafts to force a close.
      this.flushPending();
      let retriedFailedDraft = false;
      for (;;) {
        const writes = this.writeChain;
        const reconcile = this.reconcilePromise;
        await writes;
        if (reconcile) await reconcile;
        if (this.pending) {
          this.flushPending();
          continue;
        }
        if (writes !== this.writeChain || reconcile !== this.reconcilePromise) continue;
        // A generic IPC failure consumes its debounce request. Closing is a
        // deliberate save boundary, so give an unsuspended dirty draft one
        // fresh CAS-guarded attempt without requiring the user to type again.
        // Conflicts and failed reads set suspended and are never retried here.
        if (!retriedFailedDraft
            && !this.suspended
            && this.snapshot.content !== null
            && (this.durabilityUnverified
              || (this.snapshot.saveStatus === 'error'
                && this.snapshot.content !== this.snapshot.diskContent))) {
          retriedFailedDraft = true;
          const request = { revision: ++this.revision, content: this.snapshot.content };
          this.enqueueWrite(request);
          continue;
        }
        return !this.hasUnresolvedChanges();
      }
    }

    abandon() {
      // Used only by ErrorBoundary's explicit destructive escape. A write
      // already dispatched through IPC cannot be recalled; invalidate every
      // later request before this registry is forgotten.
      this.abandoned = true;
      this.loadGeneration += 1;
      this.reconcileQueued = false;
      this.suspended = true;
      this.discardedThroughRevision = Number.POSITIVE_INFINITY;
      this.pending = null;
      if (this.saveTimer) clearTimer(this.saveTimer);
      this.saveTimer = null;
      if (this.feedbackTimer) clearTimer(this.feedbackTimer);
      this.feedbackTimer = null;
      if (this.evictionTimer) clearTimer(this.evictionTimer);
      this.evictionTimer = null;
    }

    maybeScheduleEviction() {
      if (!this.canEvict() || this.evictionTimer) return;
      this.evictionTimer = setTimer(() => {
        this.evictionTimer = null;
        // A stale timer from a prior session must never delete a replacement
        // session created for the same path after StrictMode reattachment.
        if (this.canEvict() && [...this.aliases].every(alias => sessions.get(alias) === this)) {
          if (this.feedbackTimer) clearTimer(this.feedbackTimer);
          for (const alias of this.aliases) {
            if (sessions.get(alias) === this) sessions.delete(alias);
          }
          if (this.indexedIdentityToken && sessionsByIdentityToken.get(this.indexedIdentityToken) === this) {
            sessionsByIdentityToken.delete(this.indexedIdentityToken);
          }
        }
      }, evictionMs);
      // Browser handles do not expose unref(), while Node's would otherwise
      // keep deterministic tests alive for the grace period.
      this.evictionTimer?.unref?.();
    }

    /** Coalesces the same IPC watch notification delivered to every node view. */
    notifyFileChanged(notificationId = null) {
      if (this.abandoned) return Promise.resolve();
      if (notificationId !== null && notificationId !== undefined) {
        if (notificationId === this.lastNotificationId) {
          return this.reconcilePromise ?? Promise.resolve();
        }
        this.lastNotificationId = notificationId;
      }
      if (!this.loaded) return Promise.resolve();
      if (this.snapshot.status === 'loading') {
        this.reconcileQueued = true;
        return Promise.resolve();
      }
      if (this.reconcilePromise) {
        this.reconcileQueued = true;
        return this.reconcilePromise;
      }
      const activeAtNotification = this.activeRequest;
      this.suspended = true;
      if (this.saveTimer) {
        clearTimer(this.saveTimer);
        this.saveTimer = null;
      }
      this.pending = null;
      this.discardedThroughRevision = Math.max(this.discardedThroughRevision, this.revision);
      this.emit({ saveStatus: this.durabilityUnverified ? 'error' : 'idle' });
      this.reconcilePromise = this.reconcileAfterWrites(activeAtNotification)
        .finally(() => {
          this.reconcilePromise = null;
          this.drainQueuedWatch();
          this.maybeScheduleEviction();
        });
      return this.reconcilePromise;
    }

    async reconcileAfterWrites(activeAtNotification = null) {
      await this.writeChain;
      const generation = ++this.loadGeneration;
      try {
        const { content, targetToken, sessionIdentityToken } = normalizeReadResult(await read(this.filePath, generation));
        if (generation !== this.loadGeneration) return;
        this.acceptSessionIdentityToken(sessionIdentityToken);
        const draft = this.snapshot.content;
        const targetChanged = this.targetChanged(targetToken);
        // A lexical symlink can point at a different file with identical text.
        // A dirty shared draft must not silently become a write to that new
        // target simply because a watcher happened to arrive before the CAS.
        if (targetChanged && (draft !== this.snapshot.diskContent || this.durabilityUnverified)) {
          this.acceptTargetToken(targetToken);
          this.emit({ diskContent: content, externalChange: true, status: 'done', error: null, saveStatus: 'idle' });
          return;
        }
        if (content === draft) {
          this.acceptTargetToken(targetToken);
          this.adoptNewlineStyle(content, { preserveEstablishedStyleForSingleLine: true });
          this.suspended = false;
          this.emit({
            diskContent: content,
            externalChange: false,
            status: 'done',
            durabilityUnverified: this.durabilityUnverified,
            saveStatus: this.durabilityUnverified ? 'error' : this.snapshot.saveStatus,
            error: this.durabilityUnverified ? this.snapshot.error : null,
          });
          return;
        }
        if (activeAtNotification?.content === content) {
          // The watcher observed this session's atomic rename. A peer may have
          // typed while it was in flight; its later shared draft is safe to
          // resume against this newly settled baseline.
          this.acceptTargetToken(targetToken);
          this.suspended = false;
          this.emit({ diskContent: content, externalChange: false, status: 'done', error: null });
          if (draft !== null && draft !== content) {
            // notifyFileChanged invalidates revisions that predate its
            // decision. Make the resumed shared draft unambiguously newer.
            const revision = this.revision > this.discardedThroughRevision
              ? this.revision
              : ++this.revision;
            this.schedule({ revision, content: draft }, debounceMs(draft.length));
          }
          return;
        }
        if (content === this.snapshot.diskContent && !this.snapshot.externalChange) {
          // fs.watch can report a metadata-only/no-op event. The disk still
          // equals our known baseline, so this is not an external conflict;
          // resume the dirty shared draft with a revision newer than the
          // watcher-discard boundary.
          this.acceptTargetToken(targetToken);
          this.suspended = false;
          this.emit({ externalChange: false, status: 'done', error: null });
          if (draft !== null && draft !== content) {
            const revision = this.revision > this.discardedThroughRevision
              ? this.revision
              : ++this.revision;
            this.schedule({ revision, content: draft }, debounceMs(draft.length));
          }
          return;
        }
        if (draft !== this.snapshot.diskContent || this.durabilityUnverified) {
          // Preserve the shared draft in every view. The user explicitly
          // chooses Reload or Keep mine; nothing resumes writes implicitly.
          this.acceptTargetToken(targetToken);
          this.suspended = true;
          this.emit({
            diskContent: content,
            externalChange: true,
            status: 'done',
            durabilityUnverified: this.durabilityUnverified,
            error: null,
            saveStatus: 'idle',
          });
          return;
        }
        this.acceptTargetToken(targetToken);
        this.adoptNewlineStyle(content);
        this.suspended = false;
        this.emit({ content, diskContent: content, externalChange: false, status: 'done', error: null });
      } catch (error) {
        this.emit({
          externalChange: true,
          saveStatus: 'idle',
          error: error?.message || 'Failed to reread file',
        });
      }
    }

    async reconcileConflict() {
      // Main-process compare-and-swap rejected the write. Read the actual disk
      // value directly (we are already inside the session's write lane, so
      // waiting for writeChain here would wait on ourselves) and preserve the
      // shared draft behind the explicit conflict decision.
      this.suspended = true;
      this.pending = null;
      this.discardedThroughRevision = Math.max(this.discardedThroughRevision, this.revision);
      const generation = ++this.loadGeneration;
      try {
        const { content, targetToken, sessionIdentityToken } = normalizeReadResult(await read(this.filePath, generation));
        if (generation !== this.loadGeneration) return;
        this.acceptSessionIdentityToken(sessionIdentityToken);
        if (this.targetChanged(targetToken)
            && (this.snapshot.content !== this.snapshot.diskContent || this.durabilityUnverified)) {
          this.acceptTargetToken(targetToken);
          this.emit({ diskContent: content, externalChange: true, saveStatus: 'idle', error: null });
          return;
        }
        if (content === this.snapshot.content) {
          this.acceptTargetToken(targetToken);
          this.suspended = false;
          this.emit({
            diskContent: content,
            externalChange: false,
            durabilityUnverified: this.durabilityUnverified,
            saveStatus: this.durabilityUnverified ? 'error' : 'idle',
            error: this.durabilityUnverified ? this.snapshot.error : null,
          });
          return;
        }
        this.acceptTargetToken(targetToken);
        this.emit({ diskContent: content, externalChange: true, saveStatus: 'idle', error: null });
      } catch (error) {
        this.emit({
          externalChange: true,
          saveStatus: 'idle',
          error: error?.message || 'Failed to reread file',
        });
      }
    }

    async refreshAfterDetached() {
      // While every view was collapsed the OS watcher still ran, but a session
      // may not have existed yet or a file can be deleted/recreated without a
      // reliable event. A zero→one attach always re-reads after any final flush.
      const priorSnapshot = this.snapshot;
      const generation = ++this.loadGeneration;
      this.emit({ status: 'loading', error: null });
      try {
        let diskRead;
        for (;;) {
          // A close-time flush can append a retry after this refresh has waited
          // for the prior lane but before its disk read resolves. Do not apply
          // that stale read over the later successful write; wait/re-read until
          // the observed lane remains current through the read.
          const writes = this.writeChain;
          await writes;
          try {
            diskRead = normalizeReadResult(await read(this.filePath, generation));
          } catch (error) {
            if (generation !== this.loadGeneration) return;
            if (writes !== this.writeChain) continue;
            throw error;
          }
          if (generation !== this.loadGeneration) return;
          if (writes === this.writeChain) break;
        }
        const { content, targetToken, sessionIdentityToken } = diskRead;
        this.acceptSessionIdentityToken(sessionIdentityToken);
        const settledSnapshot = this.snapshot;
        const draft = this.snapshot.content;
        const targetChanged = this.targetChanged(targetToken);
        if (targetChanged && (draft !== this.snapshot.diskContent || this.durabilityUnverified)) {
          this.acceptTargetToken(targetToken);
          this.suspended = true;
          this.emit({ status: 'done', diskContent: content, externalChange: true, error: null, saveStatus: 'idle' });
        } else if (content === draft) {
          this.acceptTargetToken(targetToken);
          this.adoptNewlineStyle(content, { preserveEstablishedStyleForSingleLine: true });
          this.suspended = false;
          this.emit({
            status: 'done',
            diskContent: content,
            externalChange: false,
            durabilityUnverified: this.durabilityUnverified,
            saveStatus: this.durabilityUnverified ? 'error' : this.snapshot.saveStatus,
            error: this.durabilityUnverified ? this.snapshot.error : null,
          });
        } else if (content === priorSnapshot.diskContent && !priorSnapshot.externalChange) {
          // A failed save does not imply an external edit. If the re-read
          // confirms the original baseline, keep the draft and its save error
          // so a later edit can retry without presenting a false conflict.
          this.acceptTargetToken(targetToken);
          this.suspended = false;
          this.emit({
            status: 'done',
            diskContent: content,
            externalChange: false,
            // A last-view detach can happen while a write is still saving.
            // Use the state settled by writeChain, not the stale pre-await
            // snapshot, so a rejected write remains retryable rather than
            // appearing to save forever after reattach.
            // Starting the refresh briefly clears the visible error while it
            // is loading. If no in-flight write changed that state, retain an
            // earlier generic save failure too; it is still a retryable local
            // draft rather than an external conflict.
            error: settledSnapshot.saveStatus === 'error'
              ? (settledSnapshot.error || priorSnapshot.error)
              : (priorSnapshot.saveStatus === 'error' ? priorSnapshot.error : null),
            saveStatus: settledSnapshot.saveStatus === 'error'
              ? 'error'
              : priorSnapshot.saveStatus,
          });
        } else if (draft !== this.snapshot.diskContent || this.durabilityUnverified) {
          this.acceptTargetToken(targetToken);
          this.suspended = true;
          this.emit({
            status: 'done',
            diskContent: content,
            externalChange: true,
            durabilityUnverified: this.durabilityUnverified,
            error: null,
            saveStatus: 'idle',
          });
        } else {
          this.acceptTargetToken(targetToken);
          this.adoptNewlineStyle(content);
          this.suspended = false;
          this.emit({ status: 'done', content, diskContent: content, externalChange: false, error: null });
        }
        this.drainQueuedWatch();
      } catch (error) {
        if (generation === this.loadGeneration) {
          // A detached dirty/conflicted session may be the only place its
          // local draft still exists. A transient disk/read failure must not
          // turn an attempted reattach into data loss. It also cannot leave a
          // clean-looking editor writing from an unverified baseline: retain
          // the draft behind the same explicit Reload/Keep mine decision.
          if (priorSnapshot.content !== null) {
            this.suspended = true;
            this.emit({
              status: 'done',
              content: priorSnapshot.content,
              diskContent: priorSnapshot.diskContent,
              externalChange: true,
              saveStatus: priorSnapshot.saveStatus,
              error: error?.message || 'Failed to reload file',
            });
          } else {
            this.emit({ status: 'error', content: null, diskContent: null, error: error?.message || 'Failed to reload file' });
          }
          this.drainQueuedWatch();
        }
      } finally {
        this.maybeScheduleEviction();
      }
    }

    async reloadFromDisk() {
      const priorSnapshot = this.snapshot;
      this.suspended = true;
      if (this.saveTimer) clearTimer(this.saveTimer);
      this.saveTimer = null;
      this.pending = null;
      this.discardedThroughRevision = this.revision;
      this.revision += 1;
      const generation = ++this.loadGeneration;
      this.emit({ status: 'loading', externalChange: false, saveStatus: 'idle' });
      try {
        await this.writeChain;
        const { content, targetToken, sessionIdentityToken } = normalizeReadResult(await read(this.filePath, generation));
        if (generation !== this.loadGeneration) return;
        this.acceptSessionIdentityToken(sessionIdentityToken);
        this.acceptTargetToken(targetToken);
        this.adoptNewlineStyle(content);
        this.durabilityUnverified = false;
        this.suspended = false;
        this.emit({
          status: 'done',
          content,
          diskContent: content,
          externalChange: false,
          durabilityUnverified: false,
          error: null,
        });
        this.drainQueuedWatch();
      } catch (error) {
        if (generation !== this.loadGeneration) return;
        // Reload only discards the draft after a replacement was actually
        // read. Preserve the conflict decision and draft when that read fails
        // so the user can retry Reload or choose Keep mine. The failed read
        // itself is an unknown external state, so pause writes even if this
        // session had appeared clean before the attempt.
        if (priorSnapshot.content !== null) {
          this.suspended = true;
          this.emit({
            status: 'done',
            content: priorSnapshot.content,
            diskContent: priorSnapshot.diskContent,
            externalChange: true,
            saveStatus: priorSnapshot.saveStatus,
            error: error?.message || 'Failed to reload file',
          });
        } else {
          this.emit({ status: 'error', content: null, diskContent: null, error: error?.message || 'Failed to reload file' });
        }
        this.drainQueuedWatch();
      } finally {
        this.maybeScheduleEviction();
      }
    }

    keepMine() {
      if (this.abandoned || this.snapshot.content === null) return;
      // A second coalesced watcher pass may already be reading the external
      // version. Its result is obsolete as soon as the user chooses this
      // shared draft, so invalidate it before scheduling the CAS write.
      this.loadGeneration += 1;
      this.reconcileQueued = false;
      this.suspended = false;
      this.revision += 1;
      this.emit({ externalChange: false, saveStatus: 'idle' });
      this.schedule({ revision: this.revision, content: this.snapshot.content }, 0);
    }

    retrySave() {
      // This is only for an ordinary failed local write. Conflicts retain their
      // existing Reload/Keep mine decision, and a loading/empty session has no
      // safe baseline to retry against.
      if (this.abandoned || this.snapshot.content === null || this.suspended
          || this.snapshot.externalChange || this.snapshot.saveStatus !== 'error') return;
      this.revision += 1;
      this.emit({ saveStatus: 'idle', error: null });
      this.schedule({ revision: this.revision, content: this.snapshot.content }, 0);
    }
  }

  const transferAliasViews = (winner, loser, observedContent) => {
    // A watcher can arrive while the losing initial read is pending. It must
    // be reconciled by the surviving session rather than disappearing with the
    // provisional one.
    const queuedWatch = loser.reconcileQueued;
    loser.reconcileQueued = false;
    for (const alias of loser.aliases) {
      sessions.set(alias, winner);
      winner.aliases.add(alias);
    }
    loser.aliases.clear();

    const winnerWasEmpty = winner.listeners.size === 0;
    for (const subscription of loser.listeners) {
      loser.listeners.delete(subscription);
      subscription.owner = winner;
      winner.listeners.add(subscription);
      try {
        subscription.listener(winner.snapshot);
      } catch (error) {
        reportListenerError(error, winner.filePath);
      }
    }
    if (winnerWasEmpty && winner.wasDetached) {
      winner.wasDetached = false;
      if (winner.evictionTimer) {
        clearTimer(winner.evictionTimer);
        winner.evictionTimer = null;
      }
      void winner.refreshAfterDetached();
    }
    loser.wasDetached = true;
    loser.maybeScheduleEviction();
    // The two reads can straddle an external write even when no watcher event
    // arrives. Do not discard the newer alias observation merely because its
    // session lost the identity claim: reconcile the winner whenever its known
    // disk baseline differs, which preserves a dirty draft behind the normal
    // explicit conflict UI.
    const needsReconcile = queuedWatch
      || (winner.snapshot.diskContent !== null && observedContent !== winner.snapshot.diskContent);
    if (needsReconcile) {
      if (!winner.loaded || winner.snapshot.status === 'loading') winner.reconcileQueued = true;
      else void winner.notifyFileChanged();
    }
  };

  const claimInitialSessionIdentity = (session, targetToken, sessionIdentityToken, content) => {
    // The CAS target belongs to every session, including symlink spellings
    // that intentionally receive no shared editing identity.
    session.targetToken = targetToken;
    // Tokenless and alias-unsafe readers retain path-keyed behavior.
    if (typeof sessionIdentityToken !== 'string') return session;
    const existing = sessionsByIdentityToken.get(sessionIdentityToken);
    if (!existing || existing === session) {
      session.indexedIdentityToken = sessionIdentityToken;
      sessionsByIdentityToken.set(sessionIdentityToken, session);
      return session;
    }

    // This function is reached before `ensureLoaded` publishes a usable
    // snapshot, so the provisional session cannot be dirty. The canonical
    // owner may be dirty; attaching this clean direct-path view to it is safe
    // and retains one write lane. Do not add a generic merge API for later
    // dirty sessions or for retargetable aliases.
    if (!session.hasUnresolvedChanges()) {
      transferAliasViews(existing, session, content);
      return existing;
    }
    return session;
  };

  const get = (filePath) => {
    let session = sessions.get(filePath);
    if (!session) {
      session = new Session(filePath);
      sessions.set(filePath, session);
    }
    return session;
  };

  const existingSessionsForPaths = (filePaths) => new Set(
    [...new Set(Array.isArray(filePaths) ? filePaths.filter(path => typeof path === 'string') : [])]
      .map(path => sessions.get(path))
      .filter(Boolean),
  );

  const unresolvedRequestedPaths = (filePaths) => [...new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .filter(path => typeof path === 'string' && sessions.get(path)?.hasUnresolvedChanges()),
  )];

  return {
    attach(filePath, listener) {
      const session = get(filePath);
      const unsubscribe = session.subscribe(listener);
      void session.ensureLoaded();
      return unsubscribe;
    },
    edit: (filePath, content) => get(filePath).edit(content),
    editFromTextarea: (filePath, content) => get(filePath).editFromTextarea(content),
    notifyFileChanged: (filePath, notificationId) => sessions.get(filePath)?.notifyFileChanged(notificationId) ?? Promise.resolve(),
    reloadFromDisk: (filePath) => get(filePath).reloadFromDisk(),
    keepMine: (filePath) => get(filePath).keepMine(),
    retrySave: (filePath) => get(filePath).retrySave(),
    getSnapshot: (filePath) => sessions.get(filePath)?.snapshot ?? initialSnapshot(),
    hasUnresolvedChanges: () => [...new Set(sessions.values())].some(session => session.hasUnresolvedChanges()),
    // These APIs intentionally do not call get(): deletion/clear preflight
    // must never manufacture a session for a collapsed or never-opened node.
    inspectPaths(filePaths) {
      const requestedFilePaths = [...new Set(
        (Array.isArray(filePaths) ? filePaths : []).filter(path => typeof path === 'string'),
      )];
      const trackedFilePaths = requestedFilePaths.filter(path => sessions.has(path));
      return {
        trackedFilePaths,
        unresolvedFilePaths: unresolvedRequestedPaths(requestedFilePaths),
      };
    },
    // A duplicate may be represented by a distinct lexical alias. If both
    // aliases have been validated into the same session, do not preflight the
    // removed spelling while a surviving spelling still owns that session.
    filterPathsWithoutLiveAliases(filePaths, liveFilePaths) {
      const live = new Set(Array.isArray(liveFilePaths) ? liveFilePaths.filter(path => typeof path === 'string') : []);
      return [...new Set(Array.isArray(filePaths) ? filePaths.filter(path => typeof path === 'string') : [])]
        .filter((path) => {
          const session = sessions.get(path);
          if (!session) return !live.has(path);
          for (const livePath of live) {
            if (livePath === path || sessions.get(livePath) === session) return false;
          }
          return true;
        });
    },
    async flushAndSettlePaths(filePaths) {
      const requestedFilePaths = [...new Set(
        (Array.isArray(filePaths) ? filePaths : []).filter(path => typeof path === 'string'),
      )];
      // Resolve from the current alias map without creating anything. Re-read
      // it after awaits because an initial alias read can promote into a
      // canonical session while another selected path is settling.
      await Promise.all([...existingSessionsForPaths(requestedFilePaths)].map(session => session.flushAndSettle()));
      const unresolvedFilePaths = unresolvedRequestedPaths(requestedFilePaths);
      return { success: unresolvedFilePaths.length === 0, unresolvedFilePaths };
    },
    async flushAndSettleAll() {
      const activeSessions = [...new Set(sessions.values())];
      await Promise.all(activeSessions.map(session => session.flushAndSettle()));
      // A different preview can attach and become dirty while an earlier
      // session is still settling. Re-read the registry after the await so a
      // close request never reports success while that newly created draft is
      // waiting on its debounce.
      const unresolvedFilePaths = [...new Set(sessions.values())]
        .filter(session => session.hasUnresolvedChanges())
        .map(session => session.filePath);
      return { success: unresolvedFilePaths.length === 0, unresolvedFilePaths };
    },
    abandonAll() {
      const activeSessions = [...new Set(sessions.values())];
      const abandonedFilePaths = activeSessions.flatMap(session => [...session.aliases]);
      activeSessions.forEach(session => session.abandon());
      sessions.clear();
      sessionsByIdentityToken.clear();
      return { abandonedFilePaths };
    },
    // Test-only observation without exposing mutable session internals.
    size: () => new Set(sessions.values()).size,
  };
}

export const textDocumentSessions = createTextDocumentSessionRegistry({
  async read(filePath) {
    const response = await window.electronAPI?.readTextFile?.(filePath);
    if (!response?.success
        || typeof response.content !== 'string'
        || typeof response.targetToken !== 'string') {
      throw new Error(response?.error || 'Failed to read text file');
    }
    return {
      content: response.content,
      targetToken: response.targetToken,
      sessionIdentityToken: typeof response.sessionIdentityToken === 'string'
        ? response.sessionIdentityToken
        : undefined,
    };
  },
  write(filePath, content, expectedDiskContent, expectedTargetToken) {
    return window.electronAPI?.writeTextFile?.(
      filePath,
      content,
      expectedDiskContent,
      expectedTargetToken,
    )
      ?? Promise.resolve({ success: false, error: 'Text editing is unavailable.' });
  },
});
