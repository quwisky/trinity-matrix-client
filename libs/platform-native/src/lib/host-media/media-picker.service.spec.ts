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
import { Filesystem } from '@capacitor/filesystem';
import { MediaPickerService } from './media-picker.service';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    convertFileSrc: vi.fn((u: string) => u),
  },
}));
vi.mock('@capacitor/filesystem', () => ({
  Filesystem: { stat: vi.fn() },
}));
vi.mock('@capacitor/camera', () => ({
  Camera: {
    chooseFromGallery: vi.fn(),
    checkPermissions: vi.fn(),
    requestPermissions: vi.fn(),
  },
  CameraErrorCode: {
    GalleryPermissionDenied: 'OS-PLUG-CAMR-0005',
    ChooseMediaCancelled: 'OS-PLUG-CAMR-0020',
  },
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const chooseFromGallery = Camera.chooseFromGallery as unknown as Mock;
const stat = Filesystem.stat as unknown as Mock;
const checkPermissions = Camera.checkPermissions as unknown as Mock;
const requestPermissions = Camera.requestPermissions as unknown as Mock;

function makeService(): MediaPickerService {
  TestBed.configureTestingModule({ providers: [MediaPickerService] });
  return TestBed.inject(MediaPickerService);
}

describe('MediaPickerService host adapter', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    chooseFromGallery.mockReset();
    stat.mockReset();
    // Default to already-granted photo access so the gallery branch runs; tests
    // that exercise the permission gate override this.
    checkPermissions
      .mockReset()
      .mockResolvedValue({ camera: 'granted', photos: 'granted' });
    requestPermissions
      .mockReset()
      .mockResolvedValue({ camera: 'granted', photos: 'granted' });
  });

  it('is unavailable on web; pickImages resolves empty without opening the gallery', async () => {
    const svc = makeService();

    expect(svc.available).toBe(false);
    expect(await firstValueFrom(svc.pickImages())).toEqual({
      files: [],
      oversized: 0,
    });
    expect(chooseFromGallery).not.toHaveBeenCalled();
  });

  it('opens the native gallery and materializes EVERY choice into a File', async () => {
    // The gallery has supported multi-select all along; the flag was the only thing stopping
    // a batch from a phone, which is where most of the screenshots are.
    isNative.mockReturnValue(true);
    chooseFromGallery.mockResolvedValue({
      results: [
        { webPath: 'blob:one', type: 'photo' },
        { webPath: 'blob:two', type: 'photo' },
      ],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: () =>
        Promise.resolve(
          new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
        ),
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = makeService();
    const { files } = await firstValueFrom(svc.pickImages());

    expect(svc.available).toBe(true);
    expect(chooseFromGallery).toHaveBeenCalledWith({
      allowMultipleSelection: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('blob:one');
    expect(fetchMock).toHaveBeenCalledWith('blob:two');
    expect(files).toHaveLength(2);
    expect(files[0]).toBeInstanceOf(File);
    expect(files[0]?.type).toBe('image/png');

    vi.unstubAllGlobals();
  });

  describe('with a size limit', () => {
    const okFetch = () =>
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () =>
          Promise.resolve(
            new Blob([new Uint8Array([1])], { type: 'image/png' }),
          ),
      });
    const photo = (name: string) => ({
      uri: `file:///photos/${name}.jpg`,
      webPath: `blob:${name}`,
      type: 'photo',
    });
    /** Stat answers by file name; a missing name rejects like an unreadable path. */
    const sizes = (bySize: Record<string, number>) =>
      stat.mockImplementation(({ path }: { path: string }) => {
        const name = /([^/]+)\.jpg$/u.exec(path)?.[1] ?? '';
        return name in bySize
          ? Promise.resolve({ size: bySize[name] })
          : Promise.reject(new Error('cannot stat'));
      });
    const pick = (
      names: string[],
      maxBytes?: Parameters<MediaPickerService['pickImages']>[0],
    ) => {
      isNative.mockReturnValue(true);
      chooseFromGallery.mockResolvedValue({ results: names.map(photo) });
      const fetchMock = okFetch();
      vi.stubGlobal('fetch', fetchMock);
      return {
        fetchMock,
        done: firstValueFrom(makeService().pickImages(maxBytes)),
      };
    };

    afterEach(() => vi.unstubAllGlobals());

    it('never fetches a photo whose size on disk is over the limit, and counts it', async () => {
      sizes({ huge: 300, small: 100 });
      const { fetchMock, done } = pick(['huge', 'small'], 200);

      const { files, oversized } = await done;

      expect(stat).toHaveBeenCalledWith({ path: 'file:///photos/huge.jpg' });
      expect(fetchMock).toHaveBeenCalledWith('blob:small');
      expect(fetchMock).not.toHaveBeenCalledWith('blob:huge');
      expect(files).toHaveLength(1);
      expect(oversized).toBe(1);
    });

    it('does not ask the plugin to decode metadata for the size', async () => {
      sizes({ small: 100 });
      await pick(['small'], 200).done;

      expect(chooseFromGallery).toHaveBeenCalledWith({
        allowMultipleSelection: true,
      });
    });

    it('reads a photo exactly at the limit', async () => {
      sizes({ edge: 200 });
      const { fetchMock, done } = pick(['edge'], 200);

      const { files, oversized } = await done;

      expect(fetchMock).toHaveBeenCalledWith('blob:edge');
      expect(files).toHaveLength(1);
      expect(oversized).toBe(0);
    });

    it('still reads a photo whose size cannot be stat-ed', async () => {
      sizes({});
      const { fetchMock, done } = pick(['unknown'], 200);

      const { files, oversized } = await done;

      expect(fetchMock).toHaveBeenCalledWith('blob:unknown');
      expect(files).toHaveLength(1);
      expect(oversized).toBe(0);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
      'treats a stat size of %s as unknown and reads the photo',
      async (size) => {
        sizes({ odd: size });
        const { fetchMock, done } = pick(['odd'], 200);

        const { files, oversized } = await done;

        expect(fetchMock).toHaveBeenCalledWith('blob:odd');
        expect(files).toHaveLength(1);
        expect(oversized).toBe(0);
      },
    );

    it('stats every photo in parallel, before any answers', async () => {
      const release: (() => void)[] = [];
      stat.mockImplementation(
        () =>
          new Promise((resolve) => release.push(() => resolve({ size: 1 }))),
      );
      const { done } = pick(['a', 'b', 'c'], 200);

      await vi.waitFor(() => expect(stat).toHaveBeenCalledTimes(3));
      release.forEach((fn) => fn());

      expect((await done).files).toHaveLength(3);
    });

    it('opens the gallery before the limit has settled, then awaits it', async () => {
      sizes({ huge: 300 });
      let settle: (bytes: number) => void = () => undefined;
      const limit = new Promise<number>((resolve) => (settle = resolve));
      const { fetchMock, done } = pick(['huge'], limit);

      await vi.waitFor(() => expect(chooseFromGallery).toHaveBeenCalled());
      expect(stat).not.toHaveBeenCalled();
      settle(200);
      const { oversized } = await done;

      expect(fetchMock).not.toHaveBeenCalled();
      expect(oversized).toBe(1);
    });

    it('reads everything, without a stat, when the limit is null', async () => {
      sizes({ huge: 300 });
      const { fetchMock, done } = pick(['huge'], null);

      const { files, oversized } = await done;

      expect(stat).not.toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalledWith('blob:huge');
      expect(files).toHaveLength(1);
      expect(oversized).toBe(0);
    });
  });

  it('keeps the photos that resolved when one of them cannot be fetched', async () => {
    // One unreadable photo used to reject the whole selection, so picking ten and having one
    // fail left the user with an error toast and nothing staged.
    isNative.mockReturnValue(true);
    chooseFromGallery.mockResolvedValue({
      results: [
        { webPath: 'blob:broken', type: 'photo' },
        { webPath: 'blob:good', type: 'photo' },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((src: string) =>
        src === 'blob:broken'
          ? Promise.reject(new Error('cannot read'))
          : Promise.resolve({
              ok: true,
              blob: () =>
                Promise.resolve(
                  new Blob([new Uint8Array([1])], { type: 'image/png' }),
                ),
            }),
      ),
    );

    const svc = makeService();
    const { files } = await firstValueFrom(svc.pickImages());

    expect(files).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('drops a photo the local file server answers with an error page', async () => {
    // A 404 resolves rather than rejects, so without the status check its HTML body
    // would be staged and sent as the image.
    isNative.mockReturnValue(true);
    chooseFromGallery.mockResolvedValue({
      results: [
        { webPath: 'blob:missing', type: 'photo' },
        { webPath: 'blob:good', type: 'photo' },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((src: string) =>
        Promise.resolve(
          src === 'blob:missing'
            ? {
                ok: false,
                status: 404,
                blob: () =>
                  Promise.resolve(
                    new Blob(['<html>Not found</html>'], {
                      type: 'text/html',
                    }),
                  ),
              }
            : {
                ok: true,
                status: 200,
                blob: () =>
                  Promise.resolve(
                    new Blob([new Uint8Array([1])], { type: 'image/png' }),
                  ),
              },
        ),
      ),
    );

    const svc = makeService();
    const { files } = await firstValueFrom(svc.pickImages());

    expect(files).toHaveLength(1);
    expect(files[0]?.type).toBe('image/png');

    vi.unstubAllGlobals();
  });

  it('drops a result it cannot resolve to a URL, keeping the rest', async () => {
    // A gallery entry with neither `webPath` nor `uri` yields no File; one unusable photo
    // must not take the others with it, nor leave a null in the staged list.
    isNative.mockReturnValue(true);
    chooseFromGallery.mockResolvedValue({
      results: [{ type: 'photo' }, { webPath: 'blob:good', type: 'photo' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () =>
          Promise.resolve(
            new Blob([new Uint8Array([1])], { type: 'image/png' }),
          ),
      }),
    );

    const svc = makeService();
    const { files } = await firstValueFrom(svc.pickImages());

    expect(files).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('requests photo access when prompting, then opens the gallery on grant', async () => {
    isNative.mockReturnValue(true);
    checkPermissions.mockResolvedValue({ camera: 'denied', photos: 'prompt' });
    requestPermissions.mockResolvedValue({
      camera: 'denied',
      photos: 'granted',
    });
    chooseFromGallery.mockResolvedValue({
      results: [{ webPath: 'blob:pic', type: 'photo' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () =>
          Promise.resolve(
            new Blob([new Uint8Array([1])], { type: 'image/png' }),
          ),
      }),
    );

    const svc = makeService();
    const { files } = await firstValueFrom(svc.pickImages());

    expect(requestPermissions).toHaveBeenCalledWith({
      permissions: ['photos'],
    });
    expect(chooseFromGallery).toHaveBeenCalled();
    expect(files[0]).toBeInstanceOf(File);

    vi.unstubAllGlobals();
  });

  it('accepts iOS’s partial library grant', async () => {
    // "Select Photos…" rather than "Allow All" reports 'limited', which is enough to pick.
    // Treating it as a denial would show "photo access is denied" to a user who had just
    // granted it, on the platform this feature is most used on.
    isNative.mockReturnValue(true);
    checkPermissions.mockResolvedValue({ camera: 'denied', photos: 'limited' });
    chooseFromGallery.mockResolvedValue({
      results: [{ webPath: 'blob:pic', type: 'photo' }],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        blob: () =>
          Promise.resolve(
            new Blob([new Uint8Array([1])], { type: 'image/png' }),
          ),
      }),
    );

    const svc = makeService();
    const { files } = await firstValueFrom(svc.pickImages());

    expect(requestPermissions).not.toHaveBeenCalled(); // already answered
    expect(files).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it('errors with a clear message and never opens the gallery when access is denied', async () => {
    isNative.mockReturnValue(true);
    checkPermissions.mockResolvedValue({ camera: 'denied', photos: 'denied' });

    const svc = makeService();

    await expect(firstValueFrom(svc.pickImages())).rejects.toThrow(
      /photo access is denied/i,
    );
    expect(requestPermissions).not.toHaveBeenCalled(); // already denied → no prompt
    expect(chooseFromGallery).not.toHaveBeenCalled();
  });

  it('resolves empty (no error) when the user cancels the picker', async () => {
    isNative.mockReturnValue(true);
    chooseFromGallery.mockRejectedValue({ code: 'OS-PLUG-CAMR-0020' });

    const svc = makeService();

    expect(await firstValueFrom(svc.pickImages())).toEqual({
      files: [],
      oversized: 0,
    });
  });

  it('surfaces a denial raised at pick time as the permission error', async () => {
    isNative.mockReturnValue(true);
    chooseFromGallery.mockRejectedValue({ code: 'OS-PLUG-CAMR-0005' });

    const svc = makeService();

    await expect(firstValueFrom(svc.pickImages())).rejects.toThrow(
      /photo access is denied/i,
    );
  });
});
