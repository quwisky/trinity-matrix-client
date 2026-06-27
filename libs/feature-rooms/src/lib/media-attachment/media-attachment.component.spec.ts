import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { MediaService, type MediaPayload } from '@trinity/core';
import { MediaAttachmentComponent } from './media-attachment.component';

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
  let origCreate: typeof URL.createObjectURL;
  let origRevoke: typeof URL.revokeObjectURL;

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

    // saveBlob() uses the object-URL API, which jsdom doesn't implement.
    origCreate = URL.createObjectURL;
    origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(
      () => 'blob:dl',
    ) as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;

    TestBed.configureTestingModule({
      imports: [MediaAttachmentComponent],
      providers: [{ provide: MediaService, useValue: mediaService }],
    });
  });

  afterEach(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
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

  it('download() requests the full bytes via downloadMedia', () => {
    const media = imageMedia();
    const fixture = TestBed.createComponent(MediaAttachmentComponent);
    fixture.componentRef.setInput('media', media);
    fixture.detectChanges();

    fixture.componentInstance.download();

    expect(mediaService.downloadMedia).toHaveBeenCalledWith(media);
  });
});
