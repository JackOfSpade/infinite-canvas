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

/** Résumé documents accepted by the JobHub drop path. */
export const RESUME_EXT_RE = /\.(pdf|docx|doc|txt)$/i;

/** Web/document images (no HEIC — those are handled by the selling flow). */
export const IMAGE_EXT_RE = /\.(png|jpg|jpeg|webp|gif)$/i;

/** Product photos accepted by the selling flow (includes HEIC/HEIF from iOS). */
export const PRODUCT_IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|heic|heif)$/i;
