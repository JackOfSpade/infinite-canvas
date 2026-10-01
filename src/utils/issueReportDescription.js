// Issue reports are local diagnostics, but their description crosses the
// renderer-to-main IPC boundary and is echoed into Markdown and a clipboard
// pointer. It is intentionally user-authored payload, so this validator must
// never silently truncate or impose an arbitrary length ceiling. File-backed
// report delivery keeps the full description available to the recipient.

// Newlines and tabs are useful in reproduction steps. All other C0/C1 control
// characters can corrupt terminal, Markdown, or clipboard consumers.
const UNSAFE_CONTROL_CHARACTER = new RegExp(String.raw`[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]`, 'u');

export function validateIssueReportDescription(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: 'The issue description must be text.' };
  }
  if (UNSAFE_CONTROL_CHARACTER.test(value)) {
    return { ok: false, error: 'The issue description contains an unsupported control character.' };
  }
  // An empty string is intentional: a user can produce a report from the
  // captured diagnostics alone, or add context after handing the file off.
  return { ok: true, value };
}
