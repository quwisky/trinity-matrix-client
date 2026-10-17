import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeEvent, privacyProvider, setup } from './timeline.spec-harness';

// The fake clients here model one page of history as `client.scrollback`. The real paging
// (and its race with gappy syncs) is covered against the SDK in live-scrollback.spec.
vi.mock('./live-scrollback', () => ({
  scrollbackLive: async (
    client: { scrollback: (room: unknown, limit: number) => Promise<unknown> },
    room: unknown,
    limit: number,
  ) => {
    await client.scrollback(room, limit);
  },
}));

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [privacyProvider(true)] });
});

beforeEach(() => {
  // Viewing a room = the window is focused (the normal case). markRead only acks
  // while focused; the unfocused / refocus paths are exercised explicitly below.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe('media messages', () => {
  it('projects m.sticker as an image-backed, non-editable sticker row', () => {
    const svc = setup([
      fakeEvent({
        id: '$sticker',
        sender: '@a:hs',
        type: 'm.sticker',
        body: 'Party parrot',
        url: 'mxc://hs/parrot',
        info: { w: 64, h: 48 },
      }),
    ]);

    const sticker = svc.messages()[0];
    expect(sticker.kind).toBe('sticker');
    expect(sticker.body).toBe('Party parrot');
    expect(sticker.media).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      width: 64,
      height: 48,
    });
    expect(sticker.media).not.toHaveProperty('mxc');
  });

  it('does not render a sticker with a remote image source', () => {
    const svc = setup([
      fakeEvent({
        id: '$sticker',
        sender: '@a:hs',
        type: 'm.sticker',
        body: 'tracker',
        url: 'https://tracker.example/pixel.png',
      }),
    ]);

    expect(svc.messages()[0]).toMatchObject({
      kind: 'unsupported',
      media: null,
    });
  });

  it('projects an m.image event to a safe opaque media reference', () => {
    const svc = setup([
      fakeEvent({
        id: '$img',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'pic.png',
        url: 'mxc://hs/abc',
        info: { mimetype: 'image/png', w: 800, h: 600, size: 1234 },
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.kind).toBe('image');
    expect(m.body).toBe('pic.png'); // body falls back to the filename
    expect(m.media).toMatchObject({
      kind: 'image',
      mimeType: 'image/png',
      width: 800,
      height: 600,
      size: 1234,
      filename: 'pic.png',
    });
    expect(m.media).not.toHaveProperty('mxc');
    expect(m.media).not.toHaveProperty('file');
    expect(m.media).not.toHaveProperty('key');
    expect(m.caption).toBeNull(); // no MSC2530 filename → no caption
  });

  it('keeps encrypted media source and key material behind the pipeline boundary', () => {
    const svc = setup([
      fakeEvent({
        id: '$encrypted-image',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'secret.png',
        file: {
          url: 'mxc://hs/ciphertext',
          key: { kty: 'oct', k: 'secret-key' },
          iv: 'secret-iv',
          hashes: { sha256: 'secret-hash' },
          v: 'v2',
        },
        info: { mimetype: 'image/png', size: 1234 },
      }),
    ]);

    const media = svc.messages()[0].media;

    expect(media).toMatchObject({
      kind: 'image',
      filename: 'secret.png',
      mimeType: 'image/png',
      size: 1234,
    });
    expect(media).not.toHaveProperty('mxc');
    expect(media).not.toHaveProperty('file');
    expect(media).not.toHaveProperty('key');
    expect(JSON.stringify(media)).not.toContain('secret-key');
    expect(JSON.stringify(media)).not.toContain('ciphertext');
    expect(JSON.stringify(media)).not.toContain('secret-iv');
  });

  it('deep-freezes normalized poll payloads at the presentation boundary', () => {
    const svc = setup([
      fakeEvent({
        id: '$poll',
        sender: '@a:hs',
        type: 'm.poll.start',
        content: {
          'm.poll.start': {
            question: { 'm.text': 'Choose one' },
            answers: [
              { id: 'a', 'm.text': 'A' },
              { id: 'b', 'm.text': 'B' },
            ],
          },
        },
      }),
    ]);

    const poll = svc.messages()[0].poll;
    expect(poll?.options).toHaveLength(2);
    expect(Object.isFrozen(poll)).toBe(true);
    expect(Object.isFrozen(poll?.options)).toBe(true);
    expect(Object.isFrozen(poll?.options[0])).toBe(true);
  });

  it('freezes normalized location payloads at the presentation boundary', () => {
    const svc = setup([
      fakeEvent({
        id: '$location',
        sender: '@a:hs',
        msgtype: 'm.location',
        content: {
          msgtype: 'm.location',
          body: 'Meeting point',
          geo_uri: 'geo:47.4979,19.0402',
        },
      }),
    ]);

    const location = svc.messages()[0].location;
    expect(location).toMatchObject({ lat: 47.4979, lng: 19.0402 });
    expect(Object.isFrozen(location)).toBe(true);
  });

  it('projects an MSC2530 caption alongside a media message', () => {
    const svc = setup([
      fakeEvent({
        id: '$capimg',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'look at this', // body is the caption when filename is present
        filename: 'pic.png',
        url: 'mxc://hs/abc',
        info: { mimetype: 'image/png' },
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.media?.filename).toBe('pic.png'); // real name, not the caption
    expect(m.caption).toBe('look at this');
    expect(m.captionHtml).toBeNull(); // plain caption
  });

  // A caption is a label for the attachment, not prose, so it is NOT linkified the way
  // a message body is — the two renderings share a code path and only diverge here, on
  // a plain caption that happens to contain a URL.
  it('leaves a plain MSC2530 caption unlinkified', () => {
    const svc = setup([
      fakeEvent({
        id: '$urlcap',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'from https://example.com',
        filename: 'pic.png',
        url: 'mxc://hs/abc',
        info: { mimetype: 'image/png' },
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.caption).toBe('from https://example.com');
    expect(m.captionHtml).toBeNull();
  });

  it('projects a rich (markdown) MSC2530 caption', () => {
    const svc = setup([
      fakeEvent({
        id: '$richcap',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'look **here**',
        format: 'org.matrix.custom.html',
        formattedBody: '<p>look <strong>here</strong></p>',
        filename: 'pic.png',
        url: 'mxc://hs/abc',
        info: { mimetype: 'image/png' },
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.caption).toBe('look **here**');
    expect(m.captionHtml).toContain('<strong>here</strong>'); // sanitized rich caption
  });

  it('flags an MSC3245 voice message and exposes its waveform', () => {
    const svc = setup([
      fakeEvent({
        id: '$voice',
        sender: '@a:hs',
        msgtype: 'm.audio',
        url: 'mxc://hs/clip',
        info: { mimetype: 'audio/webm', size: 10 },
        voice: true,
        waveform: [0, 512, 1024],
        durationMs: 3000,
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.kind).toBe('audio');
    expect(m.media).toMatchObject({
      kind: 'audio',
      isVoice: true,
      waveform: [0, 512, 1024],
      durationMs: 3000,
    });
    expect(Object.isFrozen(m.media)).toBe(true);
    expect(Object.isFrozen(m.media?.waveform)).toBe(true);
  });

  it('caps a hostile voice message’s waveform length (DoS guard)', () => {
    const svc = setup([
      fakeEvent({
        id: '$huge',
        sender: '@a:hs',
        msgtype: 'm.audio',
        url: 'mxc://hs/clip',
        info: { mimetype: 'audio/webm', size: 10 },
        voice: true,
        waveform: Array.from({ length: 5000 }, () => 512),
      }),
    ]);

    // Rendered one DOM node each, so the received array must be bounded.
    // prettier-ignore
    expect(svc.messages()[0].media?.waveform?.length).toBeLessThanOrEqual(
      512,
    );
  });

  it('leaves a plain m.audio unflagged as voice', () => {
    const svc = setup([
      fakeEvent({
        id: '$aud',
        sender: '@a:hs',
        msgtype: 'm.audio',
        url: 'mxc://hs/song',
        info: { mimetype: 'audio/mpeg', size: 100, duration: 60000 },
      }),
    ]);

    const media = svc.messages()[0].media;
    expect(media?.kind).toBe('audio');
    expect(media?.isVoice).toBeUndefined();
  });

  it('projects an m.file event to a safe opaque media reference', () => {
    const svc = setup([
      fakeEvent({
        id: '$file',
        sender: '@a:hs',
        msgtype: 'm.file',
        body: 'report.pdf',
        url: 'mxc://hs/doc',
        info: { mimetype: 'application/pdf', size: 9000 },
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.kind).toBe('file');
    expect(m.media).toMatchObject({
      kind: 'file',
      mimeType: 'application/pdf',
      size: 9000,
      filename: 'report.pdf',
    });
    expect(m.media).not.toHaveProperty('mxc');
  });

  it('downgrades a script-bearing image MIME (svg) to a download-only file', () => {
    const svc = setup([
      fakeEvent({
        id: '$svg',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'logo.svg',
        url: 'mxc://hs/svg',
        info: { mimetype: 'image/svg+xml', w: 10, h: 10 },
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.kind).toBe('file'); // not rendered inline
    expect(m.media?.kind).toBe('file');
    expect(m.media?.mimeType).toBe('image/svg+xml'); // MIME preserved on the payload
  });

  it('renders an m.image without info inline, since the spec makes info optional', () => {
    const svc = setup([
      fakeEvent({
        id: '$bare',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'shot.png',
        url: 'mxc://hs/shot',
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.kind).toBe('image');
    expect(m.media?.kind).toBe('image');
    // No declared type, so the blob stays opaque; <img> sniffs the raster bytes.
    expect(m.media?.mimeType).toBe('application/octet-stream');
  });

  it('downgrades an image whose declared MIME is not an image', () => {
    const svc = setup([
      fakeEvent({
        id: '$html',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: 'page.html',
        url: 'mxc://hs/html',
        info: { mimetype: 'application/xhtml+xml' },
      }),
    ]);

    expect(svc.messages()[0].media?.kind).toBe('file');
  });

  it('falls back to unsupported with no media when a media event has neither url nor file', () => {
    const svc = setup([
      fakeEvent({
        id: '$bad',
        sender: '@a:hs',
        msgtype: 'm.image',
        body: '',
        info: { mimetype: 'image/png' },
      }),
    ]);

    const m = svc.messages()[0];
    expect(m.kind).toBe('unsupported');
    expect(m.media).toBeNull();
    expect(m.body).toBe('[image]'); // label fallback when body is empty too
  });
});
