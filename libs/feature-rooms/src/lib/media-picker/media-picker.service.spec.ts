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
  Camera: { chooseFromGallery: vi.fn() },
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const chooseFromGallery = Camera.chooseFromGallery as unknown as Mock;

function makeService(): MediaPickerService {
  TestBed.configureTestingModule({ providers: [MediaPickerService] });
  return TestBed.inject(MediaPickerService);
}

describe('MediaPickerService', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    chooseFromGallery.mockReset();
  });

  it('is unavailable on web; pickImage resolves null without opening the gallery', async () => {
    const svc = makeService();

    expect(svc.available).toBe(false);
    expect(await firstValueFrom(svc.pickImage())).toBeNull();
    expect(chooseFromGallery).not.toHaveBeenCalled();
  });

  it('opens the native gallery and materializes the choice into a File', async () => {
    isNative.mockReturnValue(true);
    chooseFromGallery.mockResolvedValue({
      results: [{ webPath: 'blob:pic', type: 'photo' }],
    });
    const fetchMock = vi.fn().mockResolvedValue({
      blob: () =>
        Promise.resolve(
          new Blob([new Uint8Array([1, 2])], { type: 'image/png' }),
        ),
    });
    vi.stubGlobal('fetch', fetchMock);

    const svc = makeService();
    const file = await firstValueFrom(svc.pickImage());

    expect(svc.available).toBe(true);
    expect(chooseFromGallery).toHaveBeenCalledWith({
      allowMultipleSelection: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('blob:pic');
    expect(file).toBeInstanceOf(File);
    expect(file?.type).toBe('image/png');

    vi.unstubAllGlobals();
  });
});
