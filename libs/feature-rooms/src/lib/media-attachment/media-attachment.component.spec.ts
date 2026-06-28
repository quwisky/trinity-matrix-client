import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MediaService, type MediaPayload } from '@trinity/core';
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

    TestBed.configureTestingModule({
      imports: [MediaAttachmentComponent],
      providers: [
        { provide: MediaService, useValue: mediaService },
        { provide: FileSaveService, useValue: fileSave },
      ],
    });
  });

  it('resolves the thumbnail, sets src, and pins the resolved URL', () => {
    const media = imageMedia();
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', media);
    fixture.detectChanges();

    expect(mediaService.resolveMedia).toHaveBeenCalledWith(media, 'thumbnail');
    expect(fixture.componentInstance.src()).toBe('blob:thumb');
    expect(mediaService.pin).toHaveBeenCalledWith('blob:thumb');
    expect(fixture.componentInstance.hasError()).toBe(false);
  });

  it('surfaces the error state when thumbnail resolution fails', () => {
    mediaService.resolveMedia.mockReturnValue(
      throwError(() => new Error('boom')),
    );
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', imageMedia());
    fixture.detectChanges();

    expect(fixture.componentInstance.hasError()).toBe(true);
    expect(fixture.componentInstance.src()).toBeNull();
  });

  it('does not resolve a thumbnail for a file attachment (download-only card)', () => {
    const media: MediaPayload = {
      ...imageMedia(),
      kind: 'file',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    };
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', media);
    fixture.detectChanges();

    // A file card never binds src — resolving (and decrypting) it would be wasted.
    expect(mediaService.resolveMedia).not.toHaveBeenCalled();
    expect(fixture.componentInstance.src()).toBeNull();
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('pins the full-res URL when the lightbox opens and unpins it on close', () => {
    // Distinct URLs per variant so the lightbox pin is observable apart from the
    // thumbnail's.
    mediaService.resolveMedia.mockImplementation(
      (_m: MediaPayload, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', imageMedia());
    fixture.detectChanges();
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

  it('unpins the full-res URL when destroyed with the lightbox still open', () => {
    mediaService.resolveMedia.mockImplementation(
      (_m: MediaPayload, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', imageMedia());
    fixture.detectChanges();
    fixture.componentInstance.openLightbox();

    mediaService.unpin.mockClear();
    fixture.destroy();

    expect(mediaService.unpin).toHaveBeenCalledWith('blob:full');
  });

  it('download() resolves the full bytes then hands them to FileSaveService', () => {
    const media = imageMedia();
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', media);
    fixture.detectChanges();

    fixture.componentInstance.download();

    expect(mediaService.downloadMedia).toHaveBeenCalledWith(media);
    expect(fileSave.save).toHaveBeenCalledWith(expect.any(Blob), 'pic.png');
    expect(fixture.componentInstance.hasError()).toBe(false);
  });

  it('download() surfaces an error when saving fails', () => {
    fileSave.save.mockReturnValue(throwError(() => new Error('save failed')));
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', imageMedia());
    fixture.detectChanges();

    fixture.componentInstance.download();

    expect(fixture.componentInstance.hasError()).toBe(true);
  });

  it('ignores a second download() while a save is in flight', () => {
    const saveStream = new Subject<void>();
    fileSave.save.mockReturnValue(saveStream.asObservable());
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', imageMedia());
    fixture.detectChanges();

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
