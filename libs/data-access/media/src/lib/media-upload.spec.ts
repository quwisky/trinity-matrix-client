import { TestBed } from '@angular/core/testing';
import { firstValueFrom, of } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { EngineRequestError, engineFail } from '@trinity/util/matrix';
import { withoutMediaMetadata } from './image-metadata/strip-file-metadata';
import {
  containsAscii,
  identifyingJpeg,
} from './image-metadata/image-metadata.fixture';
import { identifyingMovie } from './image-metadata/video-metadata.fixture';
import { mediaServiceSetup } from './media.spec-harness';

// Wrap the metadata stripper so the upload tests can see that, and when, it ran, while it
// keeps doing the real work on real bytes.
vi.mock('./image-metadata/strip-file-metadata', async (importOriginal) => {
  const real =
    await importOriginal<
      typeof import('./image-metadata/strip-file-metadata')
    >();
  return {
    ...real,
    withoutMediaMetadata: vi.fn(real.withoutMediaMetadata),
  };
});

/** The n-th `mxc://` the fake engine hands out (1-based). */
const MEDIA = (n: number) => `mxc://example.org/media${n}`;

/** The screen's devicePixelRatio as the service reads it; tests set it before resolving. */
let devicePixelRatio = 1;
const baseSetup = mediaServiceSetup(() => devicePixelRatio);

/** MediaService over a fake engine; `uploads()` lists each `[file, request]` sent to it. */
function setup() {
  const world = baseSetup();
  return {
    ...world,
    uploads: () =>
      world.upload.mock.calls.map(
        ([, file, request]) => [file, request] as const,
      ),
  };
}

async function bytesOf(blob: Blob | undefined): Promise<Uint8Array> {
  return new Uint8Array(await (blob as Blob).arrayBuffer());
}

let createObjectURL: Mock;
let revokeObjectURL: Mock;
let origCreate: typeof URL.createObjectURL;
let origRevoke: typeof URL.revokeObjectURL;

beforeEach(() => {
  devicePixelRatio = 1;
  // jsdom doesn't implement the object-URL API the media probes use, so swap it wholesale.
  let counter = 0;
  createObjectURL = vi.fn(() => `blob:probe-${++counter}`);
  revokeObjectURL = vi.fn();
  origCreate = URL.createObjectURL;
  origRevoke = URL.revokeObjectURL;
  URL.createObjectURL =
    createObjectURL as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL =
    revokeObjectURL as unknown as typeof URL.revokeObjectURL;
  (withoutMediaMetadata as Mock).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  URL.createObjectURL = origCreate;
  URL.revokeObjectURL = origRevoke;
  TestBed.resetTestingModule();
});

describe('uploadMedia', () => {
  // jsdom's File/Blob lack arrayBuffer() (real browsers/WebViews have it).
  const fileWithBuffer = (
    name: string,
    type: string,
    bytes = new Uint8Array([1, 2, 3, 4]),
  ) => {
    const file = new File([bytes], name, { type });
    if (typeof file.arrayBuffer !== 'function') {
      Object.defineProperty(file, 'arrayBuffer', {
        value: () => Promise.resolve(bytes.buffer),
      });
    }
    return file;
  };
  const pngFile = () => fileWithBuffer('pic.png', 'image/png');
  const imageFile = () => fileWithBuffer('photo.jpg', 'image/jpeg');
  const mediaFile = (name: string, type: string) => fileWithBuffer(name, type);

  // jsdom can't decode images (createImageBitmap/canvas) or load media metadata,
  // so the thumbnail/duration probes are driven by fakes. Mutable per-test meta
  // lets a test set a video/audio duration before uploading.
  let videoMeta: {
    duration: number;
    videoWidth: number;
    videoHeight: number;
  };
  let audioMeta: { duration: number };
  let origCreateElement: typeof document.createElement;
  // How the fake media element behaves on `src` assignment: fire loadedmetadata,
  // fire an error, or stay silent (so the real timeout branch runs).
  let mediaElementMode: 'load' | 'silent' | 'error';
  // Whether a video `currentTime` seek fires `seeked` (false → poster timeout).
  let videoSeekFires: boolean;
  // If true, a seek fires `error` (post-metadata) instead of `seeked`.
  let videoErrorsOnSeek: boolean;
  // What the fake canvas 2D context resolves to (null → drawPoster bails out).
  let canvasContext: 'ctx' | 'null';

  const fakeMediaElement = (tag: 'video' | 'audio') => {
    const el = {
      preload: '',
      muted: false,
      onloadedmetadata: null as null | (() => void),
      onerror: null as null | (() => void),
      onseeked: null as null | (() => void),
      duration: tag === 'video' ? videoMeta.duration : audioMeta.duration,
      videoWidth: tag === 'video' ? videoMeta.videoWidth : 0,
      videoHeight: tag === 'video' ? videoMeta.videoHeight : 0,
      removeAttribute: vi.fn(),
      load: vi.fn(),
      _src: '',
      _currentTime: 0,
      set src(v: string) {
        this._src = v;
        if (mediaElementMode === 'silent') {
          return; // nothing fires → exercises the metadata timeout branch
        }
        // Real elements fire loadedmetadata (or error) async once the header
        // is parsed.
        queueMicrotask(() =>
          mediaElementMode === 'error'
            ? this.onerror?.()
            : this.onloadedmetadata?.(),
        );
      },
      get src() {
        return this._src;
      },
      set currentTime(v: number) {
        const changed = v !== this._currentTime;
        this._currentTime = v;
        // Real <video> only dispatches 'seeked' when the position actually moves.
        if (!changed) {
          return;
        }
        if (videoErrorsOnSeek) {
          queueMicrotask(() => this.onerror?.());
        } else if (videoSeekFires) {
          queueMicrotask(() => this.onseeked?.());
        }
      },
      get currentTime() {
        return this._currentTime;
      },
    };
    return el as unknown as HTMLMediaElement;
  };

  const fakeCanvas = () =>
    ({
      width: 0,
      height: 0,
      getContext: vi.fn(() =>
        canvasContext === 'null' ? null : { drawImage: vi.fn() },
      ),
      toBlob: (cb: (b: Blob) => void, type: string) => {
        const bytes = new Uint8Array([5, 5, 5]);
        const blob = new Blob([bytes], { type });
        if (typeof blob.arrayBuffer !== 'function') {
          Object.defineProperty(blob, 'arrayBuffer', {
            value: () => Promise.resolve(bytes.buffer),
          });
        }
        cb(blob);
      },
    }) as unknown as HTMLCanvasElement;

  /** Stub createImageBitmap to make analyzeImage produce a thumbnail. */
  const stubBitmap = (width: number, height: number) =>
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => ({ width, height, close: vi.fn() })),
    );

  beforeEach(() => {
    videoMeta = { duration: NaN, videoWidth: 0, videoHeight: 0 };
    audioMeta = { duration: NaN };
    mediaElementMode = 'load';
    videoSeekFires = true;
    videoErrorsOnSeek = false;
    canvasContext = 'ctx';
    origCreateElement = document.createElement;
    const realCreate = origCreateElement.bind(document);
    document.createElement = ((tagName: string) => {
      if (tagName === 'video' || tagName === 'audio') {
        return fakeMediaElement(tagName);
      }
      if (tagName === 'canvas') {
        return fakeCanvas();
      }
      return realCreate(tagName);
    }) as unknown as typeof document.createElement;
  });

  afterEach(() => {
    document.createElement = origCreateElement;
  });

  it('uploads a plaintext file and returns a url descriptor', async () => {
    const { svc, upload, uploads } = setup();

    const res = await firstValueFrom(svc.uploadMedia(pngFile(), false));

    expect(upload).toHaveBeenCalledTimes(1);
    const [body, opts] = uploads()[0];
    expect(body).toBeInstanceOf(File);
    expect(opts.filename).toBe('pic.png');
    expect(opts.mimeType).toBe('image/png');
    expect(opts.encrypt).toBe(false);
    expect(res).toMatchObject({
      msgtype: 'm.image',
      body: 'pic.png',
      mxc: MEDIA(1),
      file: null,
      info: { mimetype: 'image/png', size: 4 },
    });
  });

  it('encrypts then uploads ciphertext for an E2EE room, filling file.url', async () => {
    const { svc, upload, uploads } = setup();

    const res = await firstValueFrom(svc.uploadMedia(pngFile(), true));

    expect(upload).toHaveBeenCalledTimes(1);
    const [body, opts] = uploads()[0];
    expect(body).toBeInstanceOf(Blob);
    // Encrypted uploads must not leak the filename/MIME.
    expect(opts).toEqual({
      filename: null,
      mimeType: 'application/octet-stream',
      encrypt: true,
    });
    expect(res.mxc).toBeNull();
    expect(res.file).toMatchObject({ url: MEDIA(1), v: 'v2' });
    // size is the ciphertext length, as the engine reports it.
    expect(res.info).toMatchObject({ mimetype: 'image/png', size: 4 });
  });

  describe('photo metadata', () => {
    const photo = () =>
      new File([identifyingJpeg(6)], 'IMG_0001.jpg', { type: 'image/jpeg' });

    it('uploads a plaintext photo without its location, camera or capture time', async () => {
      const { svc, uploads } = setup();
      const original = photo();

      const res = await firstValueFrom(svc.uploadMedia(original, false));

      expect(withoutMediaMetadata).toHaveBeenCalledWith(original);
      const [body, opts] = uploads()[0];
      expect(body).toBeInstanceOf(File);
      expect(body).not.toBe(original);
      const sent = new Uint8Array(await (body as File).arrayBuffer());
      expect(containsAscii(sent, '52.5200')).toBe(false);
      expect(containsAscii(sent, 'Canon')).toBe(false);
      expect(opts).toMatchObject({
        filename: 'IMG_0001.jpg',
        mimeType: 'image/jpeg',
      });
      // content.info describes what was uploaded, not what was picked.
      expect(res.info).toMatchObject({
        mimetype: 'image/jpeg',
        size: (body as File).size,
      });
      expect((body as File).size).toBeLessThan(original.size);
    });

    it('strips an E2EE photo before the engine encrypts it', async () => {
      const { svc, uploads } = setup();
      const original = photo();

      await firstValueFrom(svc.uploadMedia(original, true));

      expect(withoutMediaMetadata).toHaveBeenCalledWith(original);
      expect(uploads()[0]?.[1].encrypt).toBe(true);
      const plaintext = await bytesOf(uploads()[0]?.[0]);
      expect(plaintext.length).toBeLessThan(original.size);
      expect(containsAscii(plaintext, '52.5200')).toBe(false);
      expect(containsAscii(plaintext, 'Canon')).toBe(false);
    });

    it('uploads a plaintext photo byte for byte when its metadata is kept', async () => {
      const { svc, uploads } = setup();
      const original = photo();

      const res = await firstValueFrom(
        svc.uploadMedia(
          original,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          'keep',
        ),
      );

      expect(withoutMediaMetadata).not.toHaveBeenCalled();
      expect(uploads()[0]?.[0]).toBe(original);
      expect(res.info).toMatchObject({ size: original.size });
    });

    it('encrypts an E2EE photo byte for byte when its metadata is kept', async () => {
      const { svc, uploads } = setup();
      const original = photo();

      await firstValueFrom(
        svc.uploadMedia(
          original,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          'keep',
        ),
      );

      expect(withoutMediaMetadata).not.toHaveBeenCalled();
      const plaintext = await bytesOf(uploads()[0]?.[0]);
      expect(plaintext).toEqual(new Uint8Array(await original.arrayBuffer()));
    });

    it('strips a photo when the upload states no metadata policy', async () => {
      const { svc } = setup();
      const original = photo();

      await firstValueFrom(svc.uploadMedia(original, true));

      expect(withoutMediaMetadata).toHaveBeenCalledWith(original);
    });

    it('uploads a plaintext video without its location, at the same size', async () => {
      const { svc, uploads } = setup();
      const clip = new File([identifyingMovie()], 'clip.mp4', {
        type: 'video/mp4',
      });

      const res = await firstValueFrom(svc.uploadMedia(clip, false));

      expect(withoutMediaMetadata).toHaveBeenCalledWith(clip);
      const [body, opts] = uploads().at(-1) ?? [];
      expect(body).not.toBe(clip);
      const sent = new Uint8Array(await (body as File).arrayBuffer());
      expect(sent.length).toBe(clip.size);
      expect(containsAscii(sent, '52.5200')).toBe(false);
      expect(containsAscii(sent, 'iPhone 15 Pro')).toBe(false);
      expect(opts).toMatchObject({
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
      });
      expect(res.info).toMatchObject({
        mimetype: 'video/mp4',
        size: clip.size,
      });
    });

    it('strips an E2EE video before it is encrypted', async () => {
      const { svc, uploads } = setup();
      const clip = new File([identifyingMovie()], 'clip.mov', {
        type: 'video/quicktime',
      });

      await firstValueFrom(svc.uploadMedia(clip, true));

      expect(withoutMediaMetadata).toHaveBeenCalledWith(clip);
      const plaintext = await bytesOf(uploads()[0]?.[0]);
      expect(plaintext.length).toBe(clip.size);
      expect(containsAscii(plaintext, '52.5200')).toBe(false);
      expect(containsAscii(plaintext, 'iPhone 15 Pro')).toBe(false);
    });

    it('uploads a plaintext video byte for byte when its metadata is kept', async () => {
      const { svc, uploads } = setup();
      const clip = new File([identifyingMovie()], 'clip.mp4', {
        type: 'video/mp4',
      });

      const res = await firstValueFrom(
        svc.uploadMedia(
          clip,
          false,
          undefined,
          undefined,
          undefined,
          undefined,
          'keep',
        ),
      );

      expect(withoutMediaMetadata).not.toHaveBeenCalled();
      expect(uploads().at(-1)?.[0]).toBe(clip);
      expect(res.info).toMatchObject({ size: clip.size });
    });

    it('encrypts an E2EE video byte for byte when its metadata is kept', async () => {
      const { svc, uploads } = setup();
      const clip = new File([identifyingMovie()], 'clip.mov', {
        type: 'video/quicktime',
      });

      await firstValueFrom(
        svc.uploadMedia(
          clip,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          'keep',
        ),
      );

      expect(withoutMediaMetadata).not.toHaveBeenCalled();
      const plaintext = await bytesOf(uploads()[0]?.[0]);
      expect(plaintext).toEqual(new Uint8Array(await clip.arrayBuffer()));
      expect(containsAscii(plaintext, 'iPhone 15 Pro')).toBe(true);
    });

    it('uploads a file that is neither a photo nor a movie exactly as picked', async () => {
      const { svc, uploads } = setup();
      const clip = mediaFile('clip.webm', 'video/webm');

      await firstValueFrom(svc.uploadMedia(clip, false));

      expect(uploads().at(-1)?.[0]).toBe(clip);
    });
  });

  it('derives the msgtype from the MIME type', async () => {
    const { svc } = setup();
    const kindFor = async (type: string) =>
      (
        await firstValueFrom(
          svc.uploadMedia(
            new File([new Uint8Array([0])], 'f', { type }),
            false,
          ),
        )
      ).msgtype;

    expect(await kindFor('image/png')).toBe('m.image');
    expect(await kindFor('video/mp4')).toBe('m.video');
    expect(await kindFor('audio/ogg')).toBe('m.audio');
    expect(await kindFor('application/pdf')).toBe('m.file');
  });

  it('forwards upload progress as a fraction in [0, 1]', async () => {
    const { svc } = setup();
    const seen: number[] = [];

    await firstValueFrom(
      svc.uploadMedia(pngFile(), false, (f) => seen.push(f)),
    );

    // The fake engine reports one update, at the end.
    expect(seen).toEqual([1]);
  });

  it('renders and uploads a thumbnail for a large plaintext image', async () => {
    const { svc, upload } = setup();
    // The thumbnail uploads first (it's small), then the main resource.
    stubBitmap(1000, 500);

    const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

    expect(upload).toHaveBeenCalledTimes(2);
    expect(res.mxc).toBe(MEDIA(2));
    expect(res.info.w).toBe(1000);
    expect(res.info.h).toBe(500);
    expect(res.info.thumbnail_url).toBe(MEDIA(1));
    expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
    // 1000×500 scaled to fit a 640px edge → 640×320.
    expect(res.info.thumbnail_info?.w).toBe(640);
    expect(res.info.thumbnail_info?.h).toBe(320);
  });

  it.each([1, 3])(
    'renders a 640 px upload thumbnail whatever the sender screen (%sx)',
    async (dpr) => {
      devicePixelRatio = dpr;
      const { svc } = setup();
      stubBitmap(3000, 2000);

      const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

      expect(res.info.thumbnail_info?.w).toBe(640);
      expect(res.info.thumbnail_info?.h).toBe(427);
    },
  );

  it('encrypts the thumbnail for an E2EE image and sets thumbnail_file (not _url)', async () => {
    const { svc, uploads } = setup();
    stubBitmap(1024, 768);

    const res = await firstValueFrom(svc.uploadMedia(imageFile(), true));

    expect(uploads().map(([, request]) => request.encrypt)).toEqual([
      true,
      true,
    ]);
    expect(res.mxc).toBeNull();
    expect(res.file).toMatchObject({ url: MEDIA(2), v: 'v2' });
    expect(res.info.thumbnail_url).toBeUndefined();
    expect(res.info.thumbnail_file).toMatchObject({ url: MEDIA(1), v: 'v2' });
    expect(res.info.thumbnail_file?.iv).not.toBe(res.file?.iv);
    expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
  });

  it('does not generate a thumbnail for an already-small image', async () => {
    const { svc, upload } = setup();
    stubBitmap(320, 200); // within the 640px bound → original is its own thumbnail

    const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

    expect(upload).toHaveBeenCalledTimes(1); // main only
    expect(res.info.thumbnail_url).toBeUndefined();
    // Intrinsic dimensions are still recorded.
    expect(res.info).toMatchObject({ w: 320, h: 200 });
  });

  it('still uploads the image when thumbnail generation fails', async () => {
    const { svc, upload } = setup();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('decode failed'))),
    );

    const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

    expect(upload).toHaveBeenCalledTimes(1); // main only
    expect(res.info.thumbnail_url).toBeUndefined();
    expect(res.info.thumbnail_file).toBeUndefined();
    expect(res.mxc).toBe(MEDIA(1));
  });

  it('still sends when the thumbnail upload fails', async () => {
    const { svc, upload } = setup();
    upload.mockReturnValueOnce(
      of({
        kind: 'done',
        result: engineFail({
          kind: 'http',
          code: 'request-failed',
          diagnostic: { kind: 'http', httpStatus: 500 },
        }),
      }),
    );
    stubBitmap(1000, 800);

    const res = await firstValueFrom(svc.uploadMedia(imageFile(), false));

    expect(upload).toHaveBeenCalledTimes(2);
    expect(res.info.thumbnail_url).toBeUndefined();
    expect(res.mxc).toBe(MEDIA(1));
  });

  it('probes a video and captures a poster-frame thumbnail', async () => {
    const { svc, upload } = setup();
    videoMeta = { duration: 12.5, videoWidth: 1280, videoHeight: 960 };
    devicePixelRatio = 3; // the poster ignores the sender's screen

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
    );

    expect(res.msgtype).toBe('m.video');
    expect(res.info.duration).toBe(12500);
    expect(res.info.w).toBe(1280);
    expect(res.info.h).toBe(960);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(res.mxc).toBe(MEDIA(2));
    // 1280×960 scaled to the fixed 640px upload edge → 640×480.
    expect(res.info.thumbnail_url).toBe(MEDIA(1));
    expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
    expect(res.info.thumbnail_info?.w).toBe(640);
    expect(res.info.thumbnail_info?.h).toBe(480);
  });

  it('encrypts the video poster thumbnail for an E2EE room', async () => {
    const { svc, uploads } = setup();
    videoMeta = { duration: 8, videoWidth: 1280, videoHeight: 720 };

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), true),
    );

    expect(uploads().map(([, request]) => request.encrypt)).toEqual([
      true,
      true,
    ]);
    expect(res.info.thumbnail_url).toBeUndefined();
    expect(res.info.thumbnail_file).toMatchObject({ url: MEDIA(1), v: 'v2' });
    expect(res.info.thumbnail_info?.mimetype).toBe('image/jpeg');
  });

  it('keeps the video dimensions when the poster seek never completes', async () => {
    const { svc, upload } = setup();
    videoMeta = { duration: 12.5, videoWidth: 640, videoHeight: 480 };
    videoSeekFires = false; // seeked never fires → the poster timeout fires
    vi.useFakeTimers();
    try {
      const pending = firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
      );
      // Advance past POSTER_TIMEOUT_MS (3000ms in media.service.ts).
      await vi.advanceTimersByTimeAsync(3000);
      await vi.runAllTimersAsync(); // the fake engine's upload result
      const res = await pending;

      // Dimensions/duration survive even though no poster was captured.
      expect(res.info.duration).toBe(12500);
      expect(res.info.w).toBe(640);
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(upload).toHaveBeenCalledTimes(1); // main only
    } finally {
      vi.useRealTimers();
    }
  });

  it('captures the first frame for an unknown-duration video without seeking', async () => {
    const { svc, upload } = setup();
    // seekTo resolves to 0 (== currentTime), so no 'seeked' fires — the poster
    // must still be drawn from the current frame.
    videoMeta = { duration: NaN, videoWidth: 320, videoHeight: 240 };
    videoSeekFires = false;

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
    );

    expect(res.info.duration).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(2); // poster + main
    expect(res.info.thumbnail_url).toBeDefined();
    // 320×240 already within the 640px bound → kept as-is.
    expect(res.info.thumbnail_info?.w).toBe(320);
    expect(res.info.thumbnail_info?.h).toBe(240);
  });

  it('keeps the video dimensions when the poster frame fails to encode', async () => {
    const { svc, upload } = setup();
    videoMeta = { duration: 5, videoWidth: 640, videoHeight: 480 };
    canvasContext = 'null'; // getContext('2d') → null, so drawPoster bails

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
    );

    expect(res.info.duration).toBe(5000);
    expect(res.info.w).toBe(640);
    expect(res.info.thumbnail_url).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(1); // main only
  });

  it('keeps the video dimensions when the poster seek errors', async () => {
    const { svc, upload } = setup();
    videoMeta = { duration: 5, videoWidth: 640, videoHeight: 480 };
    videoErrorsOnSeek = true; // the element errors after metadata, during the seek

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
    );

    expect(res.info.duration).toBe(5000);
    expect(res.info.w).toBe(640);
    expect(res.info.thumbnail_url).toBeUndefined();
    expect(upload).toHaveBeenCalledTimes(1); // main only
  });

  describe('with capture hints', () => {
    const hintedThumbnail = (w: number, h: number) => ({
      blob: new Blob([new Uint8Array([7, 7])], { type: 'image/jpeg' }),
      w,
      h,
    });

    it('lets complete video hints win and skips the WebView probe entirely', async () => {
      const { svc } = setup();
      // What a probe WOULD report, so one that ran would show in the result.
      videoMeta = { duration: 3, videoWidth: 640, videoHeight: 480 };
      const created = vi.spyOn(document, 'createElement');

      const res = await firstValueFrom(
        svc.uploadMedia(
          mediaFile('video.mov', 'video/quicktime'),
          false,
          undefined,
          undefined,
          undefined,
          {
            width: 1920,
            height: 1080,
            durationMs: 12_500,
            thumbnail: hintedThumbnail(480, 270),
          },
        ),
      );

      expect(created).not.toHaveBeenCalledWith('video');
      expect(res.msgtype).toBe('m.video');
      expect(res.info).toMatchObject({
        w: 1920,
        h: 1080,
        duration: 12_500,
        thumbnail_url: MEDIA(1),
        thumbnail_info: { mimetype: 'image/jpeg', w: 480, h: 270, size: 2 },
      });
    });

    it('probes only for what partial hints leave out', async () => {
      const { svc } = setup();
      videoMeta = { duration: 8, videoWidth: 640, videoHeight: 480 };

      const res = await firstValueFrom(
        svc.uploadMedia(
          mediaFile('video.mp4', 'video/mp4'),
          false,
          undefined,
          undefined,
          undefined,
          { width: 1920, height: 1080 },
        ),
      );

      // Hints win for the size; the probe supplies duration and poster.
      expect(res.info.w).toBe(1920);
      expect(res.info.h).toBe(1080);
      expect(res.info.duration).toBe(8000);
      expect(res.info.thumbnail_url).toBe(MEDIA(1));
      expect(res.info.thumbnail_info).toMatchObject({ w: 640, h: 480 });
    });

    it('renders its own thumbnail when the hinted one exceeds the thumbnail bound', async () => {
      const { svc } = setup();
      videoMeta = { duration: 3, videoWidth: 640, videoHeight: 480 };

      const res = await firstValueFrom(
        svc.uploadMedia(
          mediaFile('video.mov', 'video/quicktime'),
          false,
          undefined,
          undefined,
          undefined,
          {
            width: 1920,
            height: 1080,
            durationMs: 12_500,
            thumbnail: hintedThumbnail(1280, 720),
          },
        ),
      );

      expect(res.info.duration).toBe(12_500); // the hint still wins
      expect(res.info.thumbnail_info).toMatchObject({ w: 640, h: 480 });
    });

    it('keeps a hinted thumbnail as large as the 640 px upload bound', async () => {
      const { svc } = setup();

      const res = await firstValueFrom(
        svc.uploadMedia(
          mediaFile('video.mov', 'video/quicktime'),
          false,
          undefined,
          undefined,
          undefined,
          {
            width: 1920,
            height: 1080,
            durationMs: 12_500,
            thumbnail: hintedThumbnail(640, 360),
          },
        ),
      );

      expect(res.info.thumbnail_url).toBe(MEDIA(1));
      expect(res.info.thumbnail_info).toMatchObject({ w: 640, h: 360 });
    });

    it('lets complete photo hints skip decoding the image', async () => {
      const { svc } = setup();
      stubBitmap(4000, 3000);

      const res = await firstValueFrom(
        svc.uploadMedia(imageFile(), false, undefined, undefined, undefined, {
          width: 4032,
          height: 3024,
          thumbnail: hintedThumbnail(480, 360),
        }),
      );

      expect(createImageBitmap).not.toHaveBeenCalled();
      expect(res.info).toMatchObject({ w: 4032, h: 3024 });
      expect(res.info.thumbnail_url).toBe(MEDIA(1));
    });

    describe('a host thumbnail with GPS Exif', () => {
      const gpsThumbnail = () => ({
        blob: new Blob([identifyingJpeg()], { type: 'image/jpeg' }),
        w: 480,
        h: 270,
      });
      const hints = () => ({
        width: 1920,
        height: 1080,
        durationMs: 4000,
        thumbnail: gpsThumbnail(),
      });

      it('uploads it without its location in a plaintext room', async () => {
        const { svc, uploads } = setup();

        const res = await firstValueFrom(
          svc.uploadMedia(
            mediaFile('video.mov', 'video/quicktime'),
            false,
            undefined,
            undefined,
            undefined,
            hints(),
          ),
        );

        const [body, opts] = uploads()[0] ?? [];
        expect(opts).toMatchObject({
          filename: 'thumbnail',
          mimeType: 'image/jpeg',
        });
        const sent = new Uint8Array(await (body as Blob).arrayBuffer());
        expect(containsAscii(sent, '52.5200')).toBe(false);
        expect(containsAscii(sent, 'Canon')).toBe(false);
        expect(sent.length).toBeLessThan(gpsThumbnail().blob.size);
        expect(res.info.thumbnail_info).toMatchObject({
          mimetype: 'image/jpeg',
          size: sent.length,
        });
      });

      it('strips it before it is encrypted in an E2EE room', async () => {
        const { svc, uploads } = setup();

        await firstValueFrom(
          svc.uploadMedia(
            mediaFile('video.mov', 'video/quicktime'),
            true,
            undefined,
            undefined,
            undefined,
            hints(),
          ),
        );

        // The thumbnail is encrypted (and uploaded) before the main file.
        const plaintext = await bytesOf(uploads()[0]?.[0]);
        expect(plaintext.length).toBeGreaterThan(0);
        expect(containsAscii(plaintext, '52.5200')).toBe(false);
        expect(containsAscii(plaintext, 'Canon')).toBe(false);
      });

      it('strips it even when the video keeps its metadata', async () => {
        const { svc, uploads } = setup();
        const clip = mediaFile('video.mov', 'video/quicktime');

        await firstValueFrom(
          svc.uploadMedia(
            clip,
            false,
            undefined,
            undefined,
            undefined,
            hints(),
            'keep',
          ),
        );

        // A derived preview, not the person's file: keeping metadata covers the video only.
        const thumb = uploads()[0]?.[0] as Blob;
        const sent = new Uint8Array(await thumb.arrayBuffer());
        expect(containsAscii(sent, '52.5200')).toBe(false);
        expect(uploads().at(-1)?.[0]).toBe(clip);
      });
    });

    it('still sends when a hinted thumbnail fails to upload', async () => {
      const { svc, upload } = setup();
      upload.mockReturnValueOnce(
        of({
          kind: 'done',
          result: engineFail({
            kind: 'http',
            code: 'request-failed',
            diagnostic: { kind: 'http', httpStatus: 500 },
          }),
        }),
      );

      const res = await firstValueFrom(
        svc.uploadMedia(
          mediaFile('video.mov', 'video/quicktime'),
          false,
          undefined,
          undefined,
          undefined,
          {
            width: 1920,
            height: 1080,
            durationMs: 4000,
            thumbnail: hintedThumbnail(480, 270),
          },
        ),
      );

      expect(res.mxc).toBe(MEDIA(1));
      expect(res.info.thumbnail_url).toBeUndefined();
      expect(res.info.duration).toBe(4000);
    });
  });

  it('probes duration (ms) for audio without dimensions', async () => {
    const { svc } = setup();
    audioMeta = { duration: 30 };

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('voice.ogg', 'audio/ogg'), false),
    );

    expect(res.msgtype).toBe('m.audio');
    expect(res.info.duration).toBe(30000);
    expect(res.info.w).toBeUndefined();
    expect(res.info.h).toBeUndefined();
  });

  it('omits duration when metadata loads but duration is unavailable', async () => {
    const { svc } = setup(); // videoMeta defaults to NaN duration / 0 dims

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
    );

    expect(res.info.duration).toBeUndefined();
    expect(res.info.w).toBeUndefined();
  });

  it('resolves empty (no hang) when metadata never arrives, via the timeout', async () => {
    const { svc, upload } = setup();
    mediaElementMode = 'silent'; // neither loadedmetadata nor error ever fires
    vi.useFakeTimers();
    try {
      const pending = firstValueFrom(
        svc.uploadMedia(mediaFile('clip.mp4', 'video/mp4'), false),
      );
      // Advance past METADATA_TIMEOUT_MS (5000ms in media.service.ts) so the
      // probe's safety timeout fires and resolves to empty dims.
      await vi.advanceTimersByTimeAsync(5000);
      await vi.runAllTimersAsync(); // the fake engine's upload result
      const res = await pending;

      expect(res.msgtype).toBe('m.video');
      expect(res.info.duration).toBeUndefined();
      expect(res.info.w).toBeUndefined();
      // The off-screen probe URL is revoked even on the timeout path.
      expect(revokeObjectURL).toHaveBeenCalled();
      // The main upload still ran.
      expect(upload).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves empty when the media element errors', async () => {
    const { svc } = setup();
    mediaElementMode = 'error'; // the element fires onerror instead of metadata

    const res = await firstValueFrom(
      svc.uploadMedia(mediaFile('voice.ogg', 'audio/ogg'), false),
    );

    expect(res.msgtype).toBe('m.audio');
    expect(res.info.duration).toBeUndefined();
    expect(revokeObjectURL).toHaveBeenCalled(); // URL revoked on the error path too
  });
});

describe('uploadLimit', () => {
  it("reads the active account's m.upload.size", async () => {
    const { svc, engine } = setup();
    engine.uploadLimitBytes = 52_428_800;

    expect(await firstValueFrom(svc.uploadLimit())).toBe(52_428_800);
  });

  it('is null when the server states no limit', async () => {
    const { svc, engine } = setup();
    engine.uploadLimitBytes = null;

    expect(await firstValueFrom(svc.uploadLimit(engine.alice))).toBeNull();
  });

  it('is null for an account that is not live', async () => {
    const { svc } = setup();

    expect(
      await firstValueFrom(svc.uploadLimit('@gone:example.org')),
    ).toBeNull();
  });
});

describe('upload failures and aborts', () => {
  const file = () =>
    new File([new Uint8Array([1, 2, 3, 4])], 'notes.txt', {
      type: 'text/plain',
    });

  it('fails a file over the upload limit as too-large', async () => {
    const { svc, engine } = setup();
    engine.uploadLimitBytes = 2;

    const error = await firstValueFrom(svc.uploadMedia(file(), false)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(EngineRequestError);
    expect((error as EngineRequestError).failure.code).toBe('too-large');
  });

  it('aborts the engine upload when the caller aborts', async () => {
    const { svc, engine } = setup();
    const abortController = new AbortController();
    const pending = firstValueFrom(
      svc.uploadMedia(
        file(),
        false,
        (fraction) => {
          if (fraction > 0) abortController.abort();
        },
        abortController,
      ),
    );

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(engine.aborted).toBe(1);
  });

  it('does not upload once aborted', async () => {
    const { svc, upload } = setup();
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      firstValueFrom(svc.uploadMedia(file(), true, undefined, abortController)),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(upload).not.toHaveBeenCalled();
  });
});
