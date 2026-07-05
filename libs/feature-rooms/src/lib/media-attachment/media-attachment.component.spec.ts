import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MediaService } from '@trinity/data-access-media';
import { type MediaPayload } from '@trinity/util-matrix';
import { MediaAttachmentComponent } from './media-attachment.component';
import { FileSaveService } from '../media-save/file-save.service';

function imageMedia(): MediaPayload {
  return {
    kind: 'image',
    mxc: 'mxc://hs/abc',
    file: null,
    filename: 'pic.png',
    mimeType: 'image/png',
    thumbnailMxc: null,
    thumbnailFile: null,
  };
}

interface MediaServiceStub {
  resolveMedia: Mock;
  downloadMedia: Mock;
  pin: Mock;
  unpin: Mock;
  releaseAll: Mock;
}

describe('MediaAttachmentComponent', () => {
  let mediaService: MediaServiceStub;
  let fileSave: { save: Mock };

  beforeEach(() => {
    mediaService = {
      resolveMedia: vi.fn().mockReturnValue(of('blob:thumb')),
      downloadMedia: vi
        .fn()
        .mockReturnValue(of({ blob: new Blob(['x']), filename: 'pic.png' })),
      pin: vi.fn(),
      unpin: vi.fn(),
      releaseAll: vi.fn(),
    };
    // FileSaveService owns the platform branch; stub it so the component test
    // doesn't touch the object-URL API / native plugins.
    fileSave = { save: vi.fn().mockReturnValue(of(undefined)) };
  });

  /**
   * Render the component with the mocked injected services. Behaviour is
   * configured on the `mediaService` / `fileSave` stubs *before* calling this
   * (render triggers the initial change detection that fires the resolve effect).
   */
  function renderMedia(media: MediaPayload) {
    return render(MediaAttachmentComponent, {
      inputs: { media },
      // MockProvider auto-mocks the service; the second arg wires our spies in
      // as the method implementations so assertions read the same references.
      providers: [
        MockProvider(MediaService, mediaService),
        MockProvider(FileSaveService, fileSave),
      ],
    });
  }

  it('resolves the thumbnail, sets src, and pins the resolved URL', async () => {
    const media = imageMedia();
    const { fixture } = await renderMedia(media);

    expect(mediaService.resolveMedia).toHaveBeenCalledWith(media, 'thumbnail');
    expect(fixture.componentInstance.src()).toBe('blob:thumb');
    expect(mediaService.pin).toHaveBeenCalledWith('blob:thumb');
    expect(fixture.componentInstance.hasError()).toBe(false);
  });

  it('surfaces the error state when thumbnail resolution fails', async () => {
    mediaService.resolveMedia.mockReturnValue(
      throwError(() => new Error('boom')),
    );
    const { fixture } = await renderMedia(imageMedia());

    expect(fixture.componentInstance.hasError()).toBe(true);
    expect(fixture.componentInstance.src()).toBeNull();
  });

  it('does not resolve a thumbnail for a file attachment (download-only card)', async () => {
    const media: MediaPayload = {
      ...imageMedia(),
      kind: 'file',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    };
    const { fixture } = await renderMedia(media);

    // A file card never binds src — resolving (and decrypting) it would be wasted.
    expect(mediaService.resolveMedia).not.toHaveBeenCalled();
    expect(fixture.componentInstance.src()).toBeNull();
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('pins the full-res URL when the lightbox opens and unpins it on close', async () => {
    // Distinct URLs per variant so the lightbox pin is observable apart from the
    // thumbnail's.
    mediaService.resolveMedia.mockImplementation(
      (_m: MediaPayload, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    const cmp = fixture.componentInstance;

    cmp.openLightbox();
    expect(cmp.lightboxSrc()).toBe('blob:full');
    // Pinned so a burst of live media can't evict/revoke it while it's on screen.
    expect(mediaService.pin).toHaveBeenCalledWith('blob:full');

    mediaService.unpin.mockClear();
    cmp.closeLightbox();
    expect(cmp.lightboxSrc()).toBeNull();
    expect(mediaService.unpin).toHaveBeenCalledWith('blob:full');
  });

  it('unpins the full-res URL when destroyed with the lightbox still open', async () => {
    mediaService.resolveMedia.mockImplementation(
      (_m: MediaPayload, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    fixture.componentInstance.openLightbox();

    mediaService.unpin.mockClear();
    fixture.destroy();

    expect(mediaService.unpin).toHaveBeenCalledWith('blob:full');
  });

  it('download() resolves the full bytes then hands them to FileSaveService', async () => {
    const media = imageMedia();
    const { fixture } = await renderMedia(media);

    fixture.componentInstance.download();

    expect(mediaService.downloadMedia).toHaveBeenCalledWith(media);
    expect(fileSave.save).toHaveBeenCalledWith(expect.any(Blob), 'pic.png');
    expect(fixture.componentInstance.hasError()).toBe(false);
  });

  it('download() surfaces an error when saving fails', async () => {
    fileSave.save.mockReturnValue(throwError(() => new Error('save failed')));
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentInstance.download();

    expect(fixture.componentInstance.hasError()).toBe(true);
  });

  it('ignores a second download() while a save is in flight', async () => {
    const saveStream = new Subject<void>();
    fileSave.save.mockReturnValue(saveStream.asObservable());
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentInstance.download();
    fixture.componentInstance.download(); // second tap while the first is saving

    expect(mediaService.downloadMedia).toHaveBeenCalledTimes(1);
    expect(fileSave.save).toHaveBeenCalledTimes(1);

    // Completing the first save re-enables downloads.
    saveStream.complete();
    fixture.componentInstance.download();
    expect(fileSave.save).toHaveBeenCalledTimes(2);
  });
});
