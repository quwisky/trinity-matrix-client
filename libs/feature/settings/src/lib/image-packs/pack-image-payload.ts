import type { MediaPayload } from '@trinity/util/matrix';

/** An image-pack image as a media payload, for the media cache. */
export function packImagePayload(
  url: string,
  info: Readonly<Record<string, unknown>> = {},
  filename = '',
): MediaPayload {
  return {
    kind: 'image',
    mxc: url,
    file: null,
    filename,
    mimeType:
      typeof info['mimetype'] === 'string' ? info['mimetype'] : 'image/png',
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}
