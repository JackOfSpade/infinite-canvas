// Display labels for ISO 639-1 language codes used by the job-listing language
// chip. Kept in its OWN dependency-free module so the renderer (JobCardNode) can
// import a label without pulling the detection library (tinyld) into the UI
// bundle — detection runs only in the main process (see jobLanguage.js).

export const LANGUAGE_LABELS = {
  en: 'English', fr: 'Français', es: 'Español', de: 'Deutsch',
  pt: 'Português', it: 'Italiano', nl: 'Nederlands', ca: 'Català',
  zh: '中文', ja: '日本語', ko: '한국어', ru: 'Русский',
  ar: 'العربية', pl: 'Polski', sv: 'Svenska', no: 'Norsk',
  da: 'Dansk', fi: 'Suomi', tr: 'Türkçe', uk: 'Українська',
  cs: 'Čeština', ro: 'Română', hu: 'Magyar', el: 'Ελληνικά',
  he: 'עברית', hi: 'हिन्दी', vi: 'Tiếng Việt', th: 'ไทย',
  id: 'Bahasa Indonesia',
};

// Falls back to the uppercased code so an unlabeled-but-detected language still
// shows something sensible on the chip (we keep ALL non-English jobs regardless).
export function languageLabel(code) {
  return LANGUAGE_LABELS[code] || String(code || '').toUpperCase();
}
