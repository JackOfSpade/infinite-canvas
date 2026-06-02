/**
 * Single source of truth for the file-type classification regexes used across
 * drag/drop, canvas, and selling flows. Compiled once at module load.
 *
 * Kept here (not inlined per-consumer) so adding support for a new extension
 * — e.g. another image format — is a one-line change that every drop/upload
 * path picks up at once, instead of drifting across files.
 */

/** Source/text files that drop in as code/text DocumentNodes. */
export const CODE_EXT_RE = /\.(?:js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|swift|kt|md|txt|sh|yaml|yml|toml|ini|env|log)$/i;

// NOTE: file drops NEVER auto-spawn a module. A résumé/PDF/image dropped on the
// canvas becomes a plain document node; the Job Search Module & SellHub are spawned ONLY from
// the left sidebar, and accept files dropped ONTO them (see fileSupportedByHub in
// useDragCorrections.js). The old RESUME_EXT_RE / IMAGE_EXT_RE drop-routing
// regexes were removed with that auto-spawn branch — don't reintroduce them here.

/**
 * Product photos accepted by the selling flow. Matches every image format the
 * canvas can display + AI vision can read: web-native (png/jpg/webp/gif/svg/bmp/
 * ico/avif) plus the sips-transcoded ones (heic/heif from iOS, tiff/tif, jxl).
 * Kept in sync with getFileCategoryInfo()'s IMAGE set and main.js display.
 */
export const PRODUCT_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|svg|bmp|ico|heic|heif|tiff?|avif|jxl)$/i;
