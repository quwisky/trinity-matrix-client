import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { MediaAttachmentComponent } from './media-attachment.component';
import {
  HostFileExportService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';

function imageMedia(): PresentedMediaReference {
  return {
    id: 'presented-media-image',
    kind: 'image',
    filename: 'pic.png',
    mimeType: 'image/png',
  } as PresentedMediaReference;
}

interface MediaServiceStub {
  resolveMedia: Mock;
  downloadMedia: Mock;
  pin: Mock;
  unpin: Mock;
  releaseAll: Mock;
}

/** The lightbox renders into the CDK overlay container, outside the fixture's own DOM. */
function lightboxImage(): HTMLImageElement | null {
  return document.querySelector('.cdk-overlay-container trn-lightbox img');
}

describe('MediaAttachmentComponent', () => {
  let mediaService: MediaServiceStub;
  let fileSave: { save: Mock };

  afterEach(() => {
    // The overlay outlives the fixture; leaving it attached leaks into the next test.
    document
      .querySelectorAll('.cdk-overlay-container')
      .forEach((el) => el.remove());
  });

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
    // HostFileExportService owns the host contract; stub it so the component test
    // doesn't touch the object-URL API / native plugins.
    fileSave = {
      save: vi.fn().mockReturnValue(of({ kind: 'completed' as const })),
    };
  });

  /**
   * Render the component with the mocked injected services. Behaviour is
   * configured on the `mediaService` / `fileSave` stubs *before* calling this
   * (render triggers the initial change detection that fires the resolve effect).
   */
  function renderMedia(media: PresentedMediaReference) {
    return render(MediaAttachmentComponent, {
      inputs: { media },
      // MockProvider auto-mocks the service; the second arg wires our spies in
      // as the method implementations so assertions read the same references.
      providers: [
        MockProvider(MediaPipeline, mediaService),
        MockProvider(HostFileExportService, fileSave),
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
    const media: PresentedMediaReference = {
      ...imageMedia(),
      kind: 'file',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
    } as PresentedMediaReference;
    const { fixture } = await renderMedia(media);

    // A file card never binds src — resolving (and decrypting) it would be wasted.
    expect(mediaService.resolveMedia).not.toHaveBeenCalled();
    expect(fixture.componentInstance.src()).toBeNull();
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('shows the full-res image in an overlay, pinned while it is open', async () => {
    // Distinct URLs per variant so the lightbox pin is observable apart from the
    // thumbnail's.
    mediaService.resolveMedia.mockImplementation(
      (_m: PresentedMediaReference, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    const cmp = fixture.componentInstance;

    cmp.openLightbox();
    // The dialog's own view is created by the overlay, outside this fixture — nothing has
    // rendered it until change detection runs.
    TestBed.tick();

    // In the OVERLAY container, not the component's own DOM — that relocation is the whole
    // change, and asserting it here is what would catch a revert to the inline element.
    expect(lightboxImage()?.getAttribute('src')).toBe('blob:full');
    // Pinned so a burst of live media can't evict/revoke it while it's on screen.
    expect(mediaService.pin).toHaveBeenCalledWith('blob:full');

    mediaService.unpin.mockClear();
    cmp.closeLightbox();

    expect(lightboxImage()).toBeNull();
    expect(mediaService.unpin).toHaveBeenCalledWith('blob:full');
  });

  it('opens one lightbox however many times the image is tapped', async () => {
    // `resolveMedia` hands every caller the same in-flight observable, so without a guard
    // a second tap during the resolve reaches `next` twice: two dialogs, one remembered
    // ref, and closing the remembered one unpins a URL the other is still showing.
    mediaService.resolveMedia.mockImplementation(
      (_m: PresentedMediaReference, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    const cmp = fixture.componentInstance;

    cmp.openLightbox();
    cmp.openLightbox();
    TestBed.tick();

    expect(
      document.querySelectorAll('.cdk-overlay-container trn-lightbox').length,
    ).toBe(1);

    // And once it is dismissed, a later tap opens one again — the guard must not latch.
    mediaService.unpin.mockClear();
    cmp.closeLightbox();
    TestBed.tick();
    cmp.openLightbox();
    TestBed.tick();

    expect(
      document.querySelectorAll('.cdk-overlay-container trn-lightbox').length,
    ).toBe(1);
  });

  it('releases the pin when the reader dismisses the overlay themselves', async () => {
    // Escape and viewer-surface dismissal do not call this smart component's
    // closeLightbox(), so the unpin has to hang off `closed`. Hanging it off the method
    // would leak the URL on every dismissal that is not programmatic.
    mediaService.resolveMedia.mockImplementation(
      (_m: PresentedMediaReference, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    fixture.componentInstance.openLightbox();
    TestBed.tick();
    mediaService.unpin.mockClear();

    const close = document.querySelector<HTMLButtonElement>(
      '[data-testid=lightbox-close]',
    );
    expect(close?.getAttribute('aria-label')).toBe('Close image viewer');
    close?.click();

    expect(lightboxImage()).toBeNull();
    expect(mediaService.unpin).toHaveBeenCalledWith('blob:full');
  });

  it('leaves the lightbox open when a new message recycles the row underneath it', async () => {
    // The inline version had to force-close here: a recycled row would have gone on
    // rendering the PREVIOUS message's image. An overlay holds its own URL, pinned until it
    // closes, so the image the reader opened is theirs to dismiss.
    mediaService.resolveMedia.mockImplementation(
      (_m: PresentedMediaReference, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    fixture.componentInstance.openLightbox();
    TestBed.tick();
    mediaService.unpin.mockClear();

    fixture.componentRef.setInput('media', {
      ...imageMedia(),
      id: 'presented-media-other',
      filename: 'other.png',
    });
    TestBed.tick();

    expect(lightboxImage()?.getAttribute('src')).toBe('blob:full');
    expect(mediaService.unpin).not.toHaveBeenCalledWith('blob:full');
  });

  it('unpins the full-res URL when destroyed with the lightbox still open', async () => {
    mediaService.resolveMedia.mockImplementation(
      (_m: PresentedMediaReference, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    fixture.componentInstance.openLightbox();

    mediaService.unpin.mockClear();
    fixture.destroy();

    expect(mediaService.unpin).toHaveBeenCalledWith('blob:full');
  });

  it('download() resolves the full bytes then hands them to the host file contract', async () => {
    const media = imageMedia();
    const { fixture } = await renderMedia(media);

    fixture.componentInstance.download();

    expect(mediaService.downloadMedia).toHaveBeenCalledWith(media);
    expect(fileSave.save).toHaveBeenCalledWith({
      bytes: expect.any(Blob),
      filename: 'pic.png',
    });
    expect(fixture.componentInstance.hasError()).toBe(false);
  });

  it('download() surfaces an error when saving fails', async () => {
    fileSave.save.mockReturnValue(throwError(() => new Error('save failed')));
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentInstance.download();

    expect(fixture.componentInstance.hasError()).toBe(true);
  });

  it('download() surfaces an explicit unavailable host outcome', async () => {
    fileSave.save.mockReturnValue(
      of({ kind: 'unavailable', reason: 'not-supported' }),
    );
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentInstance.download();

    expect(fixture.componentInstance.hasError()).toBe(true);
  });

  it('ignores a second download() while a save is in flight', async () => {
    const saveStream = new Subject<HostOperationOutcome>();
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
