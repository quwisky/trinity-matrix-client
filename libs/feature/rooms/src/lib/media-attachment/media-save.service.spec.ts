import { TestBed } from '@angular/core/testing';
import { NEVER, Subject, of, throwError } from 'rxjs';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MockProvider } from 'ng-mocks';
import { TrnToastService } from '@trinity/components/overlay';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { HostFileExportService } from '@trinity/runtime/host';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { MediaSaveService } from './media-save.service';

function media(kind: 'image' | 'video' | 'file' = 'image', id = 'm') {
  return {
    id,
    kind,
    filename: 'original-name.png',
    mimeType: 'image/png',
  } as PresentedMediaReference;
}

describe('MediaSaveService', () => {
  const downloadMedia = vi.fn();
  const save = vi.fn();
  const show = vi.fn();
  const activeAccountId = signal<string | null>('@a:hs');

  beforeEach(() => {
    vi.resetAllMocks();
    activeAccountId.set('@a:hs');
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
        MockProvider(AccountRuntimeService, { activeAccountId }),
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
    expect(service.isSaving(m)).toBe(false);
  });

  it('ignores a repeat request for an item while it is saving', () => {
    const pending = new Subject<{ blob: Blob; filename: string }>();
    downloadMedia.mockReturnValue(pending);
    const service = TestBed.inject(MediaSaveService);
    const m = media();

    service.save(m);
    expect(service.isSaving(m)).toBe(true);
    service.save(m);
    expect(downloadMedia).toHaveBeenCalledTimes(1);

    pending.next({ blob: new Blob(['x']), filename: 'x' });
    pending.complete();
    expect(service.isSaving(m)).toBe(false);
  });

  it('keeps saving other items while one save never settles', () => {
    downloadMedia.mockReturnValueOnce(NEVER);
    const service = TestBed.inject(MediaSaveService);
    const a = media('image', 'a');
    const b = media('image', 'b');

    service.save(a);
    service.save(b);

    expect(downloadMedia).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(service.isSaving(a)).toBe(true);
    expect(service.isSaving(b)).toBe(false);
  });

  it('clears the busy state when the save fails', () => {
    downloadMedia.mockReturnValue(throwError(() => new Error('net')));
    const service = TestBed.inject(MediaSaveService);
    const m = media();

    service.save(m);

    expect(service.isSaving(m)).toBe(false);
  });

  it('clears every busy state when the account changes', () => {
    downloadMedia.mockReturnValue(NEVER);
    const service = TestBed.inject(MediaSaveService);
    const a = media('image', 'a');
    service.save(a);
    TestBed.tick();
    expect(service.isSaving(a)).toBe(true);

    activeAccountId.set('@b:hs');
    TestBed.tick();

    expect(service.isSaving(a)).toBe(false);
    downloadMedia.mockReturnValue(of({ blob: new Blob(['x']), filename: 'x' }));
    service.save(a);
    expect(save).toHaveBeenCalledTimes(1);
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
    expect(service.isSaving(media(kind))).toBe(false);
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
