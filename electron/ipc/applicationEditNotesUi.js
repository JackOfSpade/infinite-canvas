export const APPLICATION_EDIT_NOTES_MARKUP = ['resume', 'cover'].map(document => {
  const label = document === 'resume' ? 'résumé' : 'cover letter';
  return `<section class="ic-panel ic-notes-panel" data-ic-notes-document="${document}"${document === 'cover' ? ' hidden' : ''} aria-labelledby="ic-notes-title-${document}"><div class="ic-panel-head"><h2 class="ic-panel-title" id="ic-notes-title-${document}">Why I changed the ${label}</h2><span id="ic-notes-status-${document}" class="ic-panel-note" role="status"></span></div><textarea id="ic-edit-notes-${document}" class="ic-notes-input" rows="5" maxlength="4000" placeholder="Why did you change this ${label}?" aria-describedby="ic-notes-hint-${document}"></textarea><p id="ic-notes-hint-${document}" class="ic-panel-note">Saved with this ${label}'s private edit record. Never printed, never sent to a worker.</p></section>`;
}).join('\n') + '<section id="ic-legacy-notes-panel" class="ic-panel" hidden><h2 class="ic-panel-title">Earlier shared notes</h2><p class="ic-panel-note">These older notes were shared by both documents; their document was not recorded.</p><textarea id="ic-legacy-edit-notes" class="ic-notes-input" rows="3" readonly aria-label="Earlier shared notes"></textarea></section>';

export const APPLICATION_EDIT_NOTES_RUNTIME = String.raw`
  var notesFields = {};
  var documentNotesSupported = false;
  var legacyNotesInput = document.getElementById('ic-legacy-edit-notes');
  var legacyNotesKey = 'ic-edit-notes:' + DOC_ID;
  function showLegacyNotes(text) {
    if (!legacyNotesInput || !text) return;
    legacyNotesInput.value = text;
    document.getElementById('ic-legacy-notes-panel').hidden = false;
  }
  try { showLegacyNotes(localStorage.getItem(legacyNotesKey) || ''); } catch (e) {}
  function showDocumentNotes(kind) {
    Array.prototype.slice.call(document.querySelectorAll('[data-ic-notes-document]')).forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-ic-notes-document') !== kind;
    });
  }
  ['resume', 'cover'].forEach(function (kind) {
    var input = document.getElementById('ic-edit-notes-' + kind);
    if (!input) return;
    var field = notesFields[kind] = { input: input, status: document.getElementById('ic-notes-status-' + kind),
      key: legacyNotesKey + ':' + kind, timer: null, touched: false, version: 0 };
    try { var stored = localStorage.getItem(field.key); if (stored !== null) { input.value = stored; field.touched = true; } } catch (e) {}
    input.addEventListener('input', function () {
      field.touched = true;
      var version = ++field.version;
      var text = input.value;
      try { localStorage.setItem(field.key, text); } catch (e) {}
      if (field.timer) clearTimeout(field.timer);
      field.status.textContent = 'Saving…';
      field.timer = setTimeout(function () {
        field.timer = null;
        var sync = BUNDLE_DATA && BUNDLE_DATA.sync;
        if (!documentNotesSupported) {
          if (version === field.version) field.status.textContent = 'Saved in this browser · reopen Infinite Canvas to save separate notes';
          return;
        }
        if (!(HAS_APPLICATION_BUNDLE && typeof window.fetch === 'function' && sync && sync.endpoint && sync.token)) {
          if (version === field.version) field.status.textContent = 'Saved in this browser';
          return;
        }
        function failed() { if (version === field.version) field.status.textContent = 'Saved in this browser only · Infinite Canvas unreachable'; }
        try {
          window.fetch(sync.endpoint, { method: 'POST', mode: 'cors', credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: sync.token, action: 'notes', document: kind, editNotes: text })
          }).then(function (response) { return response.json().then(function (body) {
            if (response.ok === false || !body || body.success === false) throw new Error('notes');
            if (version === field.version) field.status.textContent = 'Saved';
          }); }).catch(failed);
        } catch (e) { failed(); }
      }, 800);
    });
  });
`;

export const APPLICATION_EDIT_NOTES_RESTORE = String.raw`
      if (body && body.success) {
        documentNotesSupported = body.editNotesSchemaVersion === 2;
        if (!legacyNotesInput || !legacyNotesInput.value) showLegacyNotes(body.editNotes);
        ['resume', 'cover'].forEach(function (kind) {
          var field = notesFields[kind];
          var value = body.editNotesByDocument && body.editNotesByDocument[kind];
          if (field && !field.touched && typeof value === 'string') {
            field.input.value = value;
            field.touched = true;
            try { localStorage.setItem(field.key, value); } catch (e) {}
          } else if (field && field.touched && documentNotesSupported && field.input.value !== (typeof value === 'string' ? value : '')) {
            field.input.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
      }
`;

// Upgrade the editor chrome only. Application prose, styles, capability tokens,
// document IDs and PDF fingerprints remain byte-for-byte intact.
export function upgradeApplicationEditNotesHtml(source) {
  if (source.includes('data-ic-notes-document="resume"')) return source;
  const markup = /<section class="ic-panel ic-notes-panel"[\s\S]*?<\/section>/;
  const runtime = / {2}var notesInput = document.getElementById\('ic-edit-notes'\);[\s\S]*?(?= {2}var skillStorageKey =)/;
  const restore = / {6}if \(notesInput && body && body.success[\s\S]*?(?= {6}if \(improvementDue)/;
  const payload = "editNotes: notesInput ? notesInput.value : ''";
  if (!markup.test(source) || !runtime.test(source) || !restore.test(source)
    || !source.includes(payload) || !source.includes('    activeDocument = kind;')) {
    throw new Error('This application editor cannot be upgraded without rebuilding its workspace.');
  }
  return source.replace(markup, () => APPLICATION_EDIT_NOTES_MARKUP)
    .replace(runtime, () => APPLICATION_EDIT_NOTES_RUNTIME)
    .replace(restore, () => APPLICATION_EDIT_NOTES_RESTORE)
    .replace(payload, "editNotes: undefined")
    .replace('    activeDocument = kind;', '    activeDocument = kind;\n    showDocumentNotes(kind);');
}
