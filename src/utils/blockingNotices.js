// Notices the person must dismiss, shown one at a time in the middle of the
// window. For outcomes that change what is on the canvas while they may be
// away (a job card hidden because the job closed); a toast is gone by the time
// they return. Kept outside React so a card can raise one and then unmount.
let notices = [];
let nextId = 1;
const listeners = new Set();

function publish(next) {
  notices = next;
  for (const listener of listeners) listener();
}

export function showBlockingNotice({ title, message, detail = '' }) {
  const id = nextId++;
  publish([...notices, { id, title: String(title || ''), message: String(message || ''), detail: String(detail || '') }]);
  return id;
}

export function dismissBlockingNotice(id) {
  publish(notices.filter(notice => notice.id !== id));
}

export function subscribeBlockingNotices(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getBlockingNotices() {
  return notices;
}
