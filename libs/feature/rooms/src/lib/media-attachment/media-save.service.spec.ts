import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from 'ng-mocks';
import { TrnToastService } from '@trinity/components/overlay';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { HostFileExportService } from '@trinity/runtime/host';
import { MediaSaveService } from './media-save.service';

function media(kind: 'image' | 'video' | 'file' = 'image') {
  return {
    id: 'm',
    kind,
    filename: 'original-name.png',
    mimeType: 'image/png',
  } as PresentedMediaReference;
}

describe('MediaSaveService', () => {
  const downloadMedia = vi.fn();
  const save = vi.fn();
  const show = vi.fn();

  beforeEach(() => {
    vi.resetAllMocks();
    // The pipeline hands back decrypted bytes under whatever name it likes; the saved
    // file must carry the event's own filename.
    downloadMedia.mockReturnValue(
      of({ blob: new Blob(['x']), filename: 'decrypted.bin' }),
    );
    save.mockReturnValue(of({ kind: 'completed' as const }));
    TestBed.configureTestingModule({
      providers: [
        MockProvider(MediaPipeline, { downloadMedia }),
        MockProvider(HostFileExportService, { save }),
        MockProvider(TrnToastService, { show }),
      ],
    });
  });

  it('resolves the media through the pipeline and saves it under the original filename', () => {
    const m = media();
    const service = TestBed.inject(MediaSaveService);

    service.save(m);

    expect(downloadMedia).toHaveBeenCalledWith(m);
    expect(save).toHaveBeenCalledWith({
      bytes: expect.any(Blob),
      filename: 'original-name.png',
    });
    expect(show).not.toHaveBeenCalled();
    expect(service.saving()).toBe(false);
  });

  it('ignores a second request while one is in flight', () => {
    const pending = new Subject<{ blob: Blob; filename: string }>();
    downloadMedia.mockReturnValue(pending);
    const service = TestBed.inject(MediaSaveService);

    service.save(media());
    expect(service.saving()).toBe(true);
    service.save(media());
    expect(downloadMedia).toHaveBeenCalledTimes(1);

    pending.next({ blob: new Blob(['x']), filename: 'x' });
    pending.complete();
    expect(service.saving()).toBe(false);
  });

  it.each([
    ['image', "Couldn't save image"],
    ['video', "Couldn't save video"],
    ['file', "Couldn't save file"],
  ] as const)('toasts when the %s download fails', (kind, message) => {
    downloadMedia.mockReturnValue(throwError(() => new Error('net')));
    const service = TestBed.inject(MediaSaveService);

    service.save(media(kind));

    expect(show).toHaveBeenCalledWith(message, { variant: 'danger' });
    expect(service.saving()).toBe(false);
  });

  it('toasts when the host reports anything but completed', () => {
    save.mockReturnValue(of({ kind: 'unavailable' }));
    const service = TestBed.inject(MediaSaveService);

    service.save(media('video'));

    expect(show).toHaveBeenCalledWith("Couldn't save video", {
      variant: 'danger',
    });
  });
});
