// The shared screen shows text in a small fixed format and nothing else:
// paragraphs, "- " bullets, fenced code blocks, `inline code` and **bold**.
// Parsing is pure so it can be tested without a DOM; the renderer builds React
// elements from the result, so no HTML in the content is ever interpreted.
export const SCREEN_TITLE_MAX = 120;
export const SCREEN_CONTENT_MAX = 6000;
export const PAD_TEXT_MAX = 20000;

// Mirrors the engine's caps so a longer value that slips through is cut here too.
export function clampScreen(screen) {
  if (!screen || typeof screen !== 'object') return null;
  return {
    title: String(screen.title || '').slice(0, SCREEN_TITLE_MAX),
    content: String(screen.content || '').slice(0, SCREEN_CONTENT_MAX),
  };
}

// A fence is a line of three backticks with at most a language label: a line that merely starts with backticks is text.
const isFence = line => /^\s*```[^`\s]*\s*$/u.test(line);

// Blocks: { type: 'p', text } | { type: 'ul', items: [text] } | { type: 'code', lang, text }.
export function parseScreenContent(content) {
  const lines = String(content ?? '').slice(0, SCREEN_CONTENT_MAX).replace(/\r\n?/gu, '\n').split('\n');
  const blocks = [];
  let paragraph = [];
  let list = null;
  const flush = () => {
    if (paragraph.length) blocks.push({ type: 'p', text: paragraph.join('\n') });
    if (list) blocks.push({ type: 'ul', items: list });
    paragraph = [];
    list = null;
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (isFence(line)) {
      flush();
      const lang = line.trim().slice(3).trim();
      const body = [];
      index += 1;
      // A block left open runs to the end, so a cut at the cap still renders as code.
      while (index < lines.length && !(isFence(lines[index]) && lines[index].trim() === '```')) { body.push(lines[index]); index += 1; }
      blocks.push({ type: 'code', lang, text: body.join('\n') });
    } else if (!line.trim()) {
      flush();
    } else if (line.startsWith('- ')) {
      if (paragraph.length) { blocks.push({ type: 'p', text: paragraph.join('\n') }); paragraph = []; }
      if (!list) list = [];
      list.push(line.slice(2).trim());
    } else {
      if (list) { blocks.push({ type: 'ul', items: list }); list = null; }
      paragraph.push(line);
    }
  }
  flush();
  return blocks;
}

// Segments: { type: 'text' | 'code' | 'bold', text }. A marker with no closing
// partner stays literal text.
export function parseInline(text) {
  const source = String(text ?? '');
  const segments = [];
  let buffer = '';
  const push = () => { if (buffer) { segments.push({ type: 'text', text: buffer }); buffer = ''; } };
  let index = 0;
  while (index < source.length) {
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1);
      if (end > index + 1) { push(); segments.push({ type: 'code', text: source.slice(index + 1, end) }); index = end + 1; continue; }
    }
    if (source.startsWith('**', index)) {
      const end = source.indexOf('**', index + 2);
      if (end > index + 2) { push(); segments.push({ type: 'bold', text: source.slice(index + 2, end) }); index = end + 2; continue; }
    }
    buffer += source[index];
    index += 1;
  }
  push();
  return segments;
}

// Replay lookups: the screen on at a playback time, and the pad text at that time.
export function screenAt(screens, ms) {
  const list = Array.isArray(screens) ? screens : [];
  let found = null;
  for (const item of list) {
    const start = Number(item?.atMs);
    if (!Number.isFinite(start) || start > ms) continue;
    const end = Number(item?.endMs);
    if (item?.endMs != null && Number.isFinite(end) && ms >= end) continue;
    if (!found || start >= Number(found.atMs)) found = item;
  }
  return found;
}

export function padSnapshotAt(pad, ms) {
  const list = Array.isArray(pad?.snapshots) ? pad.snapshots : [];
  let found = null;
  for (const item of list) {
    const start = Number(item?.atMs);
    if (Number.isFinite(start) && start <= ms && (!found || start >= Number(found.atMs))) found = item;
  }
  return found;
}

/**
 * What a key writes into the pad. Tab writes two spaces (Shift+Tab still leaves the field for
 * keyboard users). Enter starts the new line at the indentation of the line it leaves, the one
 * editor habit code is painful without.
 */
export function padKeyInsert(key, before) {
  if (key === 'Tab') return '  ';
  const line = String(before ?? '').slice(String(before ?? '').lastIndexOf('\n') + 1);
  return `\n${/^[ \t]*/u.exec(line)[0]}`;
}
