/** Media types an attachment may carry once it is turned into a `blob:` URL for display. */
const DISPLAY_SAFE_MIME: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/apng',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/ogg',
  'audio/webm',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/flac',
  'audio/opus',
  'audio/mp3',
  'audio/x-m4a',
  'audio/m4a',
  'audio/x-aac',
  'audio/3gpp',
  'video/x-m4v',
  'video/3gpp',
]);

const OPAQUE_MIME = 'application/octet-stream';

/**
 * The media type a sender declared, without parameters: everything before `;`, trimmed and
 * lowercased. Empty for a missing or non-string value.
 */
export function mimeEssence(declared: unknown): string {
  return typeof declared === 'string'
    ? (declared.split(';', 1)[0] ?? '').trim().toLowerCase()
    : '';
}

/**
 * The type a displayed attachment's `Blob` gets: the declared essence when it is an
 * allowlisted image, video or audio type, otherwise `application/octet-stream`. Blobs are
 * never typed with the raw declared value, so only known display formats are ever served
 * with a format-specific type.
 */
export function displaySafeMime(declared: unknown): string {
  const essence = mimeEssence(declared);
  // `image/jpg` is a common misspelling of the registered `image/jpeg`.
  const canonical = essence === 'image/jpg' ? 'image/jpeg' : essence;
  return DISPLAY_SAFE_MIME.has(canonical) ? canonical : OPAQUE_MIME;
}
