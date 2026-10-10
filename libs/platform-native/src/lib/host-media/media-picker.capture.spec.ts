import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { MediaPickerService } from './media-picker.service';
import {
  CapturePermissionDeniedError,
  CaptureTooLargeError,
  NoCameraError,
} from './captured-media';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => true),
    convertFileSrc: vi.fn((u: string) => `converted:${u}`),
  },
}));
vi.mock('@capacitor/camera', () => ({
  Camera: {
    takePhoto: vi.fn(),
    recordVideo: vi.fn(),
    chooseFromGallery: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
  },
  CameraErrorCode: {
    CameraPermissionDenied: 'OS-PLUG-CAMR-0003',
    GalleryPermissionDenied: 'OS-PLUG-CAMR-0005',
    TakePhotoCancelled: 'OS-PLUG-CAMR-0006',
    NoCameraAvailable: 'OS-PLUG-CAMR-0007',
    RecordVideoCancelled: 'OS-PLUG-CAMR-0017',
    ChooseMediaCancelled: 'OS-PLUG-CAMR-0020',
  },
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const takePhoto = Camera.takePhoto as unknown as Mock;
const recordVideo = Camera.recordVideo as unknown as Mock;
const checkPermissions = Camera.checkPermissions as unknown as Mock;
const requestPermissions = Camera.requestPermissions as unknown as Mock;
/** `FF D8 FF E0`: enough of a JPEG header for the decoder stub. */
const JPEG_BASE64 = btoa(String.fromCharCode(0xff, 0xd8, 0xff, 0xe0));

function makeService(): MediaPickerService {
  TestBed.configureTestingModule({ providers: [MediaPickerService] });
  return TestBed.inject(MediaPickerService);
}

function serveBlob(bytes: number, type: string): Mock {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob([new Uint8Array(bytes)], { type })),
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function decodeThumbnailsAs(width: number, height: number): void {
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width, height, close: vi.fn() })),
  );
}

describe('MediaPickerService capture', () => {
  beforeEach(() => {
    isNative.mockReturnValue(true);
    takePhoto.mockReset();
    recordVideo.mockReset();
    checkPermissions
      .mockReset()
      .mockResolvedValue({ camera: 'granted', photos: 'granted' });
    requestPermissions
      .mockReset()
      .mockResolvedValue({ camera: 'granted', photos: 'granted' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('offers nothing off a native platform and never opens the camera', async () => {
    isNative.mockReturnValue(false);
    const svc = makeService();

    expect(svc.captureSupported).toBe(false);
    expect(
      await firstValueFrom(svc.capturePhoto({ saveToGallery: false })),
    ).toBeNull();
    expect(takePhoto).not.toHaveBeenCalled();
  });

  it('takes a photo with metadata and orientation, named and typed from its format', async () => {
    serveBlob(3, 'image/jpeg');
    decodeThumbnailsAs(160, 120);
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'capacitor://localhost/_capacitor_file_/photo',
      thumbnail: JPEG_BASE64,
      saved: false,
      metadata: { format: 'jpg', resolution: '4032x3024', size: 3 },
    });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    );

    expect(takePhoto).toHaveBeenCalledWith({
      includeMetadata: true,
      correctOrientation: true,
      saveToGallery: false,
    });
    expect(captured?.file.name).toBe('photo.jpeg');
    expect(captured?.file.type).toBe('image/jpeg');
    expect(captured?.hints).toMatchObject({
      width: 4032,
      height: 3024,
      thumbnail: { w: 160, h: 120 },
    });
    expect(captured?.hints.thumbnail?.blob.type).toBe('image/jpeg');
  });

  it('records a video, saving it to the gallery when asked, with duration in milliseconds', async () => {
    serveBlob(5, '');
    decodeThumbnailsAs(480, 270);
    recordVideo.mockResolvedValue({
      type: 1,
      uri: 'file:///tmp/video.mov',
      thumbnail: JPEG_BASE64,
      saved: true,
      metadata: { format: 'mov', resolution: '1920x1080', duration: 12.5 },
    });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.captureVideo({ saveToGallery: true }),
    );

    expect(recordVideo).toHaveBeenCalledWith({
      includeMetadata: true,
      saveToGallery: true,
    });
    expect(fetch).toHaveBeenCalledWith('converted:file:///tmp/video.mov');
    expect(captured?.file.name).toBe('video.mov');
    expect(captured?.file.type).toBe('video/quicktime');
    expect(captured?.hints).toMatchObject({
      width: 1920,
      height: 1080,
      durationMs: 12_500,
    });
  });

  it('falls back to the blob type and no hints when the plugin returns no metadata', async () => {
    serveBlob(5, 'video/mp4');
    recordVideo.mockResolvedValue({ type: 1, webPath: 'blob:v', saved: false });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.captureVideo({ saveToGallery: false }),
    );

    expect(captured?.file.name).toBe('video.mp4');
    expect(captured?.hints).toEqual({});
  });

  it('keeps the capture but drops a thumbnail it cannot decode', async () => {
    serveBlob(3, 'image/jpeg');
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('bad'))),
    );
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      thumbnail: JPEG_BASE64,
      saved: false,
      metadata: { format: 'jpeg' },
    });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    );

    expect(captured?.file.name).toBe('photo.jpeg');
    expect(captured?.hints.thumbnail).toBeUndefined();
  });

  it('leaves the size to the probe when the thumbnail cannot be decoded', async () => {
    serveBlob(3, 'image/jpeg');
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('bad'))),
    );
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      thumbnail: JPEG_BASE64,
      saved: false,
      metadata: { format: 'jpeg', resolution: '4032x3024' },
    });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    );

    expect(captured?.hints).not.toHaveProperty('width');
    expect(captured?.hints).not.toHaveProperty('height');
  });

  it('leaves the size to the probe when the capture has no thumbnail', async () => {
    serveBlob(3, 'image/jpeg');
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      saved: false,
      metadata: { format: 'jpeg', resolution: '4032x3024' },
    });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    );

    expect(captured?.hints).not.toHaveProperty('width');
    expect(captured?.hints).not.toHaveProperty('height');
  });

  it('fails the capture when the local file cannot be read', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      blob: () => Promise.resolve(new Blob(['<h1>Not found</h1>'])),
    });
    vi.stubGlobal('fetch', fetchMock);
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      saved: false,
      metadata: { format: 'jpeg' },
    });
    const svc = makeService();

    await expect(
      firstValueFrom(svc.capturePhoto({ saveToGallery: false })),
    ).rejects.toThrow(/could not be read/u);
  });

  it('turns a sensor-oriented photo resolution to match its portrait thumbnail', async () => {
    serveBlob(3, 'image/jpeg');
    decodeThumbnailsAs(120, 160);
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      thumbnail: JPEG_BASE64,
      saved: false,
      metadata: { format: 'jpeg', resolution: '4032x3024' },
    });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    );

    expect(captured?.hints).toMatchObject({ width: 3024, height: 4032 });
  });

  it('resolves null, not an error, when the user cancels either capture', async () => {
    takePhoto.mockRejectedValue({ code: 'OS-PLUG-CAMR-0006' });
    recordVideo.mockRejectedValue({ code: 'OS-PLUG-CAMR-0017' });
    const svc = makeService();

    expect(
      await firstValueFrom(svc.capturePhoto({ saveToGallery: false })),
    ).toBeNull();
    expect(
      await firstValueFrom(svc.captureVideo({ saveToGallery: false })),
    ).toBeNull();
  });

  it('asks for camera access when it has not been answered, then captures', async () => {
    checkPermissions.mockResolvedValue({ camera: 'prompt', photos: 'prompt' });
    serveBlob(3, 'image/jpeg');
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      saved: false,
      metadata: { format: 'jpeg' },
    });
    const svc = makeService();

    await firstValueFrom(svc.capturePhoto({ saveToGallery: false }));

    expect(requestPermissions).toHaveBeenCalledWith({
      permissions: ['camera'],
    });
    expect(takePhoto).toHaveBeenCalled();
  });

  it('refuses with a typed camera denial and never opens the camera', async () => {
    checkPermissions.mockResolvedValue({ camera: 'denied', photos: 'granted' });
    const svc = makeService();

    const error = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CapturePermissionDeniedError);
    expect((error as CapturePermissionDeniedError).permission).toBe('camera');
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(takePhoto).not.toHaveBeenCalled();
  });

  it('maps denials and a missing camera raised at capture time', async () => {
    const svc = makeService();
    takePhoto.mockRejectedValueOnce({ code: 'OS-PLUG-CAMR-0003' });
    const camera = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    ).catch((e: unknown) => e);
    recordVideo.mockRejectedValueOnce({ code: 'OS-PLUG-CAMR-0005' });
    const photos = await firstValueFrom(
      svc.captureVideo({ saveToGallery: true }),
    ).catch((e: unknown) => e);
    takePhoto.mockRejectedValueOnce({ code: 'OS-PLUG-CAMR-0007' });
    const none = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false }),
    ).catch((e: unknown) => e);

    expect((camera as CapturePermissionDeniedError).permission).toBe('camera');
    expect((photos as CapturePermissionDeniedError).permission).toBe('photos');
    expect(none).toBeInstanceOf(NoCameraError);
  });

  it('refuses a capture over the upload limit before reading its bytes', async () => {
    const fetchMock = serveBlob(3, 'video/mp4');
    recordVideo.mockResolvedValue({
      type: 1,
      webPath: 'blob:v',
      saved: false,
      metadata: { format: 'mp4', size: 200 },
    });
    const svc = makeService();

    const error = await firstValueFrom(
      svc.captureVideo({ saveToGallery: false, maxBytes: 100 }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CaptureTooLargeError);
    expect((error as CaptureTooLargeError).limit).toBe(100);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses by the real size when the plugin did not report one', async () => {
    serveBlob(3, 'image/jpeg');
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      saved: false,
      metadata: { format: 'jpeg' },
    });
    const svc = makeService();

    const error = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false, maxBytes: 2 }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CaptureTooLargeError);
  });

  describe('with an upload limit that is still resolving', () => {
    function deferredLimit(): {
      promise: Promise<number | null>;
      resolve: (limit: number | null) => void;
    } {
      let resolve!: (limit: number | null) => void;
      const promise = new Promise<number | null>((r) => (resolve = r));
      return { promise, resolve };
    }

    it('opens the camera before the limit is known and checks the size once it is', async () => {
      const fetchMock = serveBlob(3, 'video/mp4');
      recordVideo.mockResolvedValue({
        type: 1,
        webPath: 'blob:v',
        saved: false,
        metadata: { format: 'mp4', size: 200 },
      });
      const limit = deferredLimit();
      const svc = makeService();

      const outcome = firstValueFrom(
        svc.captureVideo({ saveToGallery: false, maxBytes: limit.promise }),
      ).catch((e: unknown) => e);
      await vi.waitFor(() => expect(recordVideo).toHaveBeenCalledTimes(1));
      await Promise.resolve();
      expect(fetchMock).not.toHaveBeenCalled();

      limit.resolve(100);
      const error = await outcome;

      expect(error).toBeInstanceOf(CaptureTooLargeError);
      expect((error as CaptureTooLargeError).size).toBe(200);
      expect((error as CaptureTooLargeError).limit).toBe(100);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('stages a capture that fits a late limit', async () => {
      serveBlob(3, 'image/jpeg');
      takePhoto.mockResolvedValue({
        type: 0,
        webPath: 'blob:p',
        saved: false,
        metadata: { format: 'jpeg', size: 3 },
      });
      const limit = deferredLimit();
      const svc = makeService();

      const outcome = firstValueFrom(
        svc.capturePhoto({ saveToGallery: false, maxBytes: limit.promise }),
      );
      await vi.waitFor(() => expect(takePhoto).toHaveBeenCalledTimes(1));
      limit.resolve(100);

      expect((await outcome)?.file.name).toBe('photo.jpeg');
    });

    it('stages a capture when the late limit turns out to be unknown', async () => {
      serveBlob(3, 'image/jpeg');
      takePhoto.mockResolvedValue({
        type: 0,
        webPath: 'blob:p',
        saved: false,
        metadata: { format: 'jpeg', size: 3 },
      });
      const svc = makeService();

      const captured = await firstValueFrom(
        svc.capturePhoto({
          saveToGallery: false,
          maxBytes: Promise.resolve(null),
        }),
      );

      expect(captured?.file.name).toBe('photo.jpeg');
    });

    it('lets a cancelled capture finish without waiting for the limit', async () => {
      takePhoto.mockRejectedValue({ code: 'OS-PLUG-CAMR-0006' });
      recordVideo.mockRejectedValue({ code: 'OS-PLUG-CAMR-0017' });
      const never = new Promise<number | null>(() => undefined);
      const svc = makeService();

      expect(
        await firstValueFrom(
          svc.capturePhoto({ saveToGallery: false, maxBytes: never }),
        ),
      ).toBeNull();
      expect(
        await firstValueFrom(
          svc.captureVideo({ saveToGallery: false, maxBytes: never }),
        ),
      ).toBeNull();
    });
  });

  it('still honours a plain number limit', async () => {
    serveBlob(3, 'image/jpeg');
    takePhoto.mockResolvedValue({
      type: 0,
      webPath: 'blob:p',
      saved: false,
      metadata: { format: 'jpeg', size: 3 },
    });
    const svc = makeService();

    const captured = await firstValueFrom(
      svc.capturePhoto({ saveToGallery: false, maxBytes: 100 }),
    );

    expect(captured?.file.name).toBe('photo.jpeg');
  });
});
