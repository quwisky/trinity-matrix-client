import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { MediaPickerService } from './media-picker.service';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    convertFileSrc: vi.fn((u: string) => u),
  },
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
const checkPermissions = Camera.checkPermissions as unknown as Mock;
const requestPermissions = Camera.requestPermissions as unknown as Mock;

function makeService(): MediaPickerService {
  TestBed.configureTestingModule({ providers: [MediaPickerService] });
  return TestBed.inject(MediaPickerService);
}

describe('MediaPickerService', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    chooseFromGallery.mockReset();
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
    expect(await firstValueFrom(svc.pickImages())).toEqual([]);
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
      blob: () =>
        Promise.resolve(
          new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
        ),
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = makeService();
    const files = await firstValueFrom(svc.pickImages());

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
              blob: () =>
                Promise.resolve(
                  new Blob([new Uint8Array([1])], { type: 'image/png' }),
                ),
            }),
      ),
    );

    const svc = makeService();
    const files = await firstValueFrom(svc.pickImages());

    expect(files).toHaveLength(1);

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
        blob: () =>
          Promise.resolve(
            new Blob([new Uint8Array([1])], { type: 'image/png' }),
          ),
      }),
    );

    const svc = makeService();
    const files = await firstValueFrom(svc.pickImages());

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
        blob: () =>
          Promise.resolve(
            new Blob([new Uint8Array([1])], { type: 'image/png' }),
          ),
      }),
    );

    const svc = makeService();
    const files = await firstValueFrom(svc.pickImages());

    expect(requestPermissions).toHaveBeenCalledWith({
      permissions: ['photos'],
    });
    expect(chooseFromGallery).toHaveBeenCalled();
    expect(files[0]).toBeInstanceOf(File);

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

    expect(await firstValueFrom(svc.pickImages())).toEqual([]);
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
