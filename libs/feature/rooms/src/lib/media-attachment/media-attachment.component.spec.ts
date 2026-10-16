import { Injector, type Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import { BELOW_MD_QUERY } from '@trinity/util/ui';
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
import { TimelineMediaGate } from '../shared/timeline-media-gate';
import { TimelineScrollActivity } from '../shared/timeline-scroll-activity';
import {
  TestIntersectionObserver,
  stubIntersectionObserver,
} from '../testing/intersection-observer.stub';

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
  drop: Mock;
  releaseAll: Mock;
  sameMedia: Mock;
}

/** The lightbox renders into the CDK overlay container, outside the fixture's own DOM. */
function lightboxImage(): HTMLImageElement | null {
  return document.querySelector('.cdk-overlay-container trn-lightbox img');
}

describe('MediaAttachmentComponent', () => {
  let mediaService: MediaServiceStub;
  let fileSave: { save: Mock };
  let toast: { show: Mock };

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
      drop: vi.fn(),
      releaseAll: vi.fn(),
      // Same bytes when the file is the same: one message projected twice.
      sameMedia: vi.fn(
        (a: PresentedMediaReference, b: PresentedMediaReference) =>
          a.kind === b.kind && a.filename === b.filename,
      ),
    };
    // HostFileExportService owns the host contract; stub it so the component test
    // doesn't touch the object-URL API / native plugins.
    toast = { show: vi.fn() };
    fileSave = {
      save: vi.fn().mockReturnValue(of({ kind: 'completed' as const })),
    };
  });

  /**
   * Render the component with the mocked injected services. Behaviour is
   * configured on the `mediaService` / `fileSave` stubs *before* calling this
   * (render triggers the initial change detection that fires the resolve effect).
   */
  function renderMedia(
    media: PresentedMediaReference,
    extraProviders: Provider[] = [],
  ) {
    return render(MediaAttachmentComponent, {
      inputs: { media },
      // MockProvider auto-mocks the service; the second arg wires our spies in
      // as the method implementations so assertions read the same references.
      providers: [
        MockProvider(MediaPipeline, mediaService),
        MockProvider(HostFileExportService, fileSave),
        MockProvider(TrnToastService, toast),
        ...extraProviders,
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

  describe('video and audio load only when played', () => {
    const clip = (
      kind: 'video' | 'audio',
      over: Partial<PresentedMediaReference> = {},
    ) =>
      ({
        ...imageMedia(),
        kind,
        filename: kind === 'video' ? 'clip.mp4' : 'note.ogg',
        mimeType: kind === 'video' ? 'video/mp4' : 'audio/ogg',
        ...over,
      }) as PresentedMediaReference;

    const byVariant = (variant: string) =>
      of(variant === 'full' ? 'blob:full' : 'blob:poster');

    beforeEach(() => {
      mediaService.resolveMedia.mockImplementation(
        (_m: PresentedMediaReference, variant: string) => byVariant(variant),
      );
    });

    it.each(['video', 'audio'] as const)(
      'does not touch the media service for a %s until it is played',
      async (kind) => {
        const { fixture } = await renderMedia(clip(kind));

        // Fetching, decrypting and pinning the whole file for every row on screen (and the
        // overscan) is the memory cost this change removes.
        expect(mediaService.resolveMedia).not.toHaveBeenCalled();
        expect(mediaService.pin).not.toHaveBeenCalledWith('blob:full');
        expect(fixture.componentInstance.src()).toBeNull();
        expect(fixture.componentInstance.loading()).toBe(false);
      },
    );

    it('resolves only the bundled thumbnail for a video, as its poster', async () => {
      const media = clip('video', { hasThumbnail: true });
      const { fixture } = await renderMedia(media);

      expect(mediaService.resolveMedia).toHaveBeenCalledTimes(1);
      expect(mediaService.resolveMedia).toHaveBeenCalledWith(
        media,
        'thumbnail',
      );
      expect(fixture.componentInstance.poster()).toBe('blob:poster');
      expect(fixture.componentInstance.src()).toBeNull();
      expect(mediaService.pin).toHaveBeenCalledWith('blob:poster');
    });

    it('shows a neutral placeholder rather than fetching the video when it has no thumbnail', async () => {
      const { fixture } = await renderMedia(clip('video'));

      // Without a bundled thumbnail the thumbnail variant would fetch the whole original.
      expect(mediaService.resolveMedia).not.toHaveBeenCalled();
      expect(fixture.componentInstance.poster()).toBeNull();
    });

    it.each(['video', 'audio'] as const)(
      'resolves the full %s on play, pins it, and never binds the thumbnail as its source',
      async (kind) => {
        const media = clip(kind, { hasThumbnail: kind === 'video' });
        const { fixture } = await renderMedia(media);

        fixture.componentInstance.play();

        expect(mediaService.resolveMedia).toHaveBeenCalledWith(media, 'full');
        expect(fixture.componentInstance.src()).toBe('blob:full');
        expect(mediaService.pin).toHaveBeenCalledWith('blob:full');
        expect(fixture.componentInstance.loading()).toBe(false);
      },
    );

    it('keeps the poster pinned while the clip plays, to show it again afterwards', async () => {
      const { fixture } = await renderMedia(
        clip('video', { hasThumbnail: true }),
      );

      fixture.componentInstance.play();

      expect(mediaService.unpin).not.toHaveBeenCalledWith('blob:poster');
      expect(mediaService.drop).not.toHaveBeenCalledWith(
        expect.anything(),
        'thumbnail',
        'blob:poster',
      );
    });

    it('reports loading while the full file resolves, and a second press does not refetch', async () => {
      const full = new Subject<string>();
      mediaService.resolveMedia.mockReturnValue(full.asObservable());
      const { fixture } = await renderMedia(clip('video'));

      fixture.componentInstance.play();
      fixture.componentInstance.play();

      expect(fixture.componentInstance.loading()).toBe(true);
      expect(mediaService.resolveMedia).toHaveBeenCalledTimes(1);

      full.next('blob:full');
      full.complete();
      expect(fixture.componentInstance.loading()).toBe(false);
      expect(fixture.componentInstance.src()).toBe('blob:full');
    });

    it('surfaces the error state when the full file cannot be resolved', async () => {
      mediaService.resolveMedia.mockReturnValue(
        throwError(() => new Error('boom')),
      );
      const { fixture } = await renderMedia(clip('audio'));

      fixture.componentInstance.play();

      expect(fixture.componentInstance.hasError()).toBe(true);
      expect(fixture.componentInstance.src()).toBeNull();
    });

    it.each(['video', 'audio'] as const)(
      'drops the played %s from the cache when it is destroyed',
      async (kind) => {
        const media = clip(kind);
        const { fixture } = await renderMedia(media);
        fixture.componentInstance.play();

        fixture.destroy();

        expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
          media,
          'full',
          'blob:full',
        );
        // Dropping releases the pin itself; a separate unpin would release someone else's.
        expect(mediaService.unpin).not.toHaveBeenCalledWith('blob:full');
      },
    );

    it('cancels a clip still loading when it is destroyed', async () => {
      const full = new Subject<string>();
      mediaService.resolveMedia.mockReturnValue(full.asObservable());
      const media = clip('audio');
      const { fixture } = await renderMedia(media);
      fixture.componentInstance.play();

      fixture.destroy();

      expect(full.observed).toBe(false);
      expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
        media,
        'full',
        null,
      );
    });

    it('lets go of a clip still loading before dropping it, so the drop can cancel it', async () => {
      const full = new Subject<string>();
      mediaService.resolveMedia.mockReturnValue(full.asObservable());
      const observedAtDrop: boolean[] = [];
      mediaService.drop.mockImplementation(() =>
        observedAtDrop.push(full.observed),
      );
      const { fixture } = await renderMedia(clip('video'));
      fixture.componentInstance.play();

      fixture.destroy();

      // MediaService cancels an in-flight resolve only once nobody is subscribed to it.
      expect(observedAtDrop).toEqual([false]);
    });

    it('drops a played file when the row is recycled for another message', async () => {
      const media = clip('video');
      const { fixture } = await renderMedia(media);
      fixture.componentInstance.play();
      mediaService.resolveMedia.mockClear();

      const other = clip('video', { id: 'other', filename: 'other.mp4' });
      fixture.componentRef.setInput('media', other);
      TestBed.tick();

      expect(mediaService.sameMedia).toHaveBeenCalledWith(media, other);
      expect(fixture.componentInstance.src()).toBeNull();
      expect(mediaService.resolveMedia).not.toHaveBeenCalled();
      // The clip belonged to the previous message, so that is the rendition dropped.
      expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
        media,
        'full',
        'blob:full',
      );
    });

    it.each(['video', 'audio'] as const)(
      'keeps a playing %s when its message is re-projected (a receipt, a reaction)',
      async (kind) => {
        const media = clip(kind);
        const { fixture } = await renderMedia(media);
        fixture.componentInstance.play();
        mediaService.resolveMedia.mockClear();

        // The same file under a new reference, as every re-projection mints one.
        const again = clip(kind, { id: 'presented-media-again' });
        fixture.componentRef.setInput('media', again);
        TestBed.tick();

        expect(fixture.componentInstance.src()).toBe('blob:full');
        expect(mediaService.drop).not.toHaveBeenCalled();
        expect(mediaService.resolveMedia).not.toHaveBeenCalled();
        expect(mediaService.sameMedia).toHaveBeenCalledWith(media, again);

        fixture.componentInstance.playbackEnded();

        // The rendition dropped is the one played, under the reference it was resolved for.
        expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
          media,
          'full',
          'blob:full',
        );
      },
    );

    it('keeps a clip loading when its message is re-projected', async () => {
      const full = new Subject<string>();
      mediaService.resolveMedia.mockReturnValue(full.asObservable());
      const media = clip('audio');
      const { fixture } = await renderMedia(media);
      fixture.componentInstance.play();

      const again = clip('audio', { id: 'presented-media-again' });
      fixture.componentRef.setInput('media', again);
      TestBed.tick();

      expect(full.observed).toBe(true);
      expect(mediaService.drop).not.toHaveBeenCalled();
      expect(mediaService.sameMedia).toHaveBeenCalledWith(media, again);
      full.next('blob:full');
      expect(fixture.componentInstance.src()).toBe('blob:full');
      expect(mediaService.resolveMedia).toHaveBeenCalledTimes(1);
    });

    it.each(['video', 'audio'] as const)(
      'drops the %s and resets the player when playback ends, then re-resolves on play',
      async (kind) => {
        const media = clip(kind, { hasThumbnail: kind === 'video' });
        const { fixture } = await renderMedia(media);
        const cmp = fixture.componentInstance;
        cmp.play();

        cmp.playbackEnded();

        expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
          media,
          'full',
          'blob:full',
        );
        expect(cmp.src()).toBeNull();
        if (kind === 'video') expect(cmp.poster()).toBe('blob:poster');

        mediaService.resolveMedia.mockClear();
        cmp.play();

        expect(mediaService.resolveMedia).toHaveBeenCalledExactlyOnceWith(
          media,
          'full',
        );
        expect(cmp.src()).toBe('blob:full');
      },
    );

    it('returns to the poster control when the video element reports the end', async () => {
      vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
      const media = clip('video', { hasThumbnail: true });
      const { fixture } = await renderMedia(media);
      const host = fixture.nativeElement as HTMLElement;
      fixture.componentInstance.play();
      TestBed.tick();

      host.querySelector('video')!.dispatchEvent(new Event('ended'));
      TestBed.tick();

      expect(host.querySelector('video')).toBeNull();
      expect(
        host.querySelector('button[aria-label="Play video clip.mp4"]'),
      ).not.toBeNull();
      expect(mediaService.drop).toHaveBeenCalledWith(
        media,
        'full',
        'blob:full',
      );
    });

    it('ignores play for an image', async () => {
      const { fixture } = await renderMedia(imageMedia());
      mediaService.resolveMedia.mockClear();

      fixture.componentInstance.play();

      expect(mediaService.resolveMedia).not.toHaveBeenCalled();
    });

    it('plays the video after a press on its poster control', async () => {
      const playSpy = vi
        .spyOn(HTMLMediaElement.prototype, 'play')
        .mockResolvedValue();
      const { fixture } = await renderMedia(
        clip('video', { hasThumbnail: true }),
      );
      const host = fixture.nativeElement as HTMLElement;
      expect(host.querySelector('video')).toBeNull();

      host
        .querySelector<HTMLButtonElement>('button[aria-label^="Play video"]')!
        .click();
      TestBed.tick();
      const video = host.querySelector('video')!;
      video.dispatchEvent(new Event('loadedmetadata'));

      expect(mediaService.resolveMedia).toHaveBeenCalledWith(
        expect.anything(),
        'full',
      );
      expect(video.getAttribute('src')).toBe('blob:full');
      expect(playSpy).toHaveBeenCalledTimes(1);
      playSpy.mockRestore();
    });
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

    cmp.closeLightbox();

    expect(lightboxImage()).toBeNull();
    // Dropped, not merely unpinned: the full-size blob leaves the cache with the viewer.
    expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
      imageMedia(),
      'full',
      'blob:full',
    );
    expect(mediaService.unpin).not.toHaveBeenCalledWith('blob:full');
  });

  it('opens the lightbox fullscreen below md, where a sheet pane would clip it', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => ({ matches: query === BELOW_MD_QUERY })),
    );
    const { fixture } = await renderMedia(imageMedia());
    const open = vi.spyOn(TestBed.inject(TrnSurfaceService), 'open');

    fixture.componentInstance.openLightbox();

    expect(open).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: 'fullscreen' }),
    );
    vi.unstubAllGlobals();
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

    const close = document.querySelector<HTMLButtonElement>(
      '[data-testid=lightbox-close]',
    );
    expect(close?.getAttribute('aria-label')).toBe('Close image viewer');
    close?.click();

    expect(lightboxImage()).toBeNull();
    expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
      imageMedia(),
      'full',
      'blob:full',
    );
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
    expect(mediaService.drop).not.toHaveBeenCalled();

    // Closing it later drops the image it opened with, not the new message's.
    fixture.componentInstance.closeLightbox();
    expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
      imageMedia(),
      'full',
      'blob:full',
    );
  });

  it('drops the full-res image when destroyed with the lightbox still open', async () => {
    mediaService.resolveMedia.mockImplementation(
      (_m: PresentedMediaReference, variant: string) =>
        of(variant === 'full' ? 'blob:full' : 'blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    fixture.componentInstance.openLightbox();

    fixture.destroy();

    expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
      imageMedia(),
      'full',
      'blob:full',
    );
  });

  it('cancels a full-res image still loading for the lightbox when destroyed', async () => {
    const full = new Subject<string>();
    mediaService.resolveMedia.mockImplementation(
      (_m: PresentedMediaReference, variant: string) =>
        variant === 'full' ? full.asObservable() : of('blob:thumb'),
    );
    const { fixture } = await renderMedia(imageMedia());
    fixture.componentInstance.openLightbox();

    fixture.destroy();

    expect(full.observed).toBe(false);
    expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
      imageMedia(),
      'full',
      null,
    );
  });

  it('pins the thumbnail once however often the same URL is resolved for it', async () => {
    // Pins are counted, so pinning the URL a row already holds would leak a pin.
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentRef.setInput('media', { ...imageMedia() });
    TestBed.tick();
    fixture.destroy();

    const pins = mediaService.pin.mock.calls.filter(
      ([u]) => u === 'blob:thumb',
    );
    const unpins = mediaService.unpin.mock.calls.filter(
      ([u]) => u === 'blob:thumb',
    );
    expect(pins.length).toBe(unpins.length);
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

  it('download() toasts instead of breaking the bubble when saving fails', async () => {
    fileSave.save.mockReturnValue(throwError(() => new Error('save failed')));
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentInstance.download();

    expect(toast.show).toHaveBeenCalledWith("Couldn't save image", {
      variant: 'danger',
    });
    expect(fixture.componentInstance.hasError()).toBe(false);
  });

  it('download() surfaces an explicit unavailable host outcome', async () => {
    fileSave.save.mockReturnValue(
      of({ kind: 'unavailable', reason: 'not-supported' }),
    );
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentInstance.download();

    expect(toast.show).toHaveBeenCalledWith("Couldn't save image", {
      variant: 'danger',
    });
  });

  it('opens the lightbox with a download button wired to the same save', async () => {
    const { fixture } = await renderMedia(imageMedia());

    fixture.componentInstance.openLightbox();
    TestBed.tick();
    document
      .querySelector<HTMLButtonElement>(
        '.cdk-overlay-container [data-testid="lightbox-download"]',
      )!
      .click();

    expect(mediaService.downloadMedia).toHaveBeenCalledWith(imageMedia());
    expect(fileSave.save).toHaveBeenCalledTimes(1);
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

  describe('in a timeline that loads images after fast scrolling', () => {
    let activity: TimelineScrollActivity;
    let gate: TimelineMediaGate;

    beforeEach(() => {
      stubIntersectionObserver();
      // The list's own pair, as its rows find them; built before render configures TestBed.
      const list = Injector.create({
        providers: [TimelineScrollActivity, TimelineMediaGate],
      });
      activity = list.get(TimelineScrollActivity);
      gate = list.get(TimelineMediaGate);
      gate.connect(document.createElement('div'));
    });

    afterEach(() => vi.unstubAllGlobals());

    /** Render inside that timeline. */
    function renderInTimeline(media: PresentedMediaReference) {
      return renderMedia(media, [
        { provide: TimelineScrollActivity, useValue: activity },
        { provide: TimelineMediaGate, useValue: gate },
      ]);
    }

    /** The list moves at `pxPerS` (one 100 ms sample replaces the estimate outright). */
    function fling(pxPerS = 8_000): void {
      activity.start();
      activity.moved(0, 0);
      activity.moved(pxPerS / 10, 100);
    }

    /** The gate's observer reports the attachment within reach of the viewport. */
    function comesNear(host: Element): void {
      const [observer] = TestIntersectionObserver.instances;
      observer.report(host, true);
    }

    it('loads on render as before while the flag is off', async () => {
      fling();
      const media = imageMedia();

      const { fixture } = await renderInTimeline(media);

      expect(mediaService.resolveMedia).toHaveBeenCalledExactlyOnceWith(
        media,
        'thumbnail',
      );
      expect(fixture.componentInstance.src()).toBe('blob:thumb');
    });

    it('leaves a thumbnail still loading to finish while the flag is off', async () => {
      const thumb = new Subject<string>();
      mediaService.resolveMedia.mockReturnValue(thumb.asObservable());
      const { fixture } = await renderInTimeline(imageMedia());

      fixture.destroy();

      expect(mediaService.drop).not.toHaveBeenCalled();
    });

    it('keeps a playing video when its message is re-projected while the flag is off', async () => {
      mediaService.resolveMedia.mockImplementation(
        (_m: PresentedMediaReference, variant: string) =>
          of(variant === 'full' ? 'blob:full' : 'blob:poster'),
      );
      const video = {
        ...imageMedia(),
        kind: 'video',
        filename: 'clip.mp4',
        mimeType: 'video/mp4',
        hasThumbnail: true,
      } as PresentedMediaReference;
      const { fixture } = await renderInTimeline(video);
      fixture.componentInstance.play();
      expect(fixture.componentInstance.src()).toBe('blob:full');

      const again = { ...video, id: 'presented-media-again' };
      fixture.componentRef.setInput('media', again);
      TestBed.tick();

      expect(fixture.componentInstance.src()).toBe('blob:full');
      expect(mediaService.drop).not.toHaveBeenCalledWith(
        expect.anything(),
        'full',
        expect.anything(),
      );
      expect(mediaService.sameMedia).toHaveBeenCalledWith(video, again);
      // The poster is resolved again as before while the flag is off.
      expect(mediaService.resolveMedia).toHaveBeenLastCalledWith(
        again,
        'thumbnail',
      );
    });

    describe('with the flag on', () => {
      beforeEach(() => gate.setEnabled(true));

      it('shows the skeleton while the list flings, and loads once the scroll settles', async () => {
        fling();
        const media = imageMedia();
        const { fixture, container } = await renderInTimeline(media);
        comesNear(fixture.nativeElement);

        expect(mediaService.resolveMedia).not.toHaveBeenCalled();
        expect(container.querySelector('.media__skeleton')).not.toBeNull();

        activity.settle();
        fixture.detectChanges();

        expect(mediaService.resolveMedia).toHaveBeenCalledExactlyOnceWith(
          media,
          'thumbnail',
        );
        expect(fixture.componentInstance.src()).toBe('blob:thumb');
        expect(container.querySelector('img.media__img')).not.toBeNull();
      });

      it('loads at once when the list is still and the row is near the viewport', async () => {
        const { fixture } = await renderInTimeline(imageMedia());

        comesNear(fixture.nativeElement);

        expect(fixture.componentInstance.src()).toBe('blob:thumb');
      });

      it('never loads a row that is gone before the scroll settles', async () => {
        fling();
        const { fixture } = await renderInTimeline(imageMedia());
        comesNear(fixture.nativeElement);

        fixture.destroy();
        activity.settle();

        expect(mediaService.resolveMedia).not.toHaveBeenCalled();
      });

      it('cancels a thumbnail still loading when its row is destroyed', async () => {
        const thumb = new Subject<string>();
        mediaService.resolveMedia.mockReturnValue(thumb.asObservable());
        const observedAtDrop: boolean[] = [];
        mediaService.drop.mockImplementation(() =>
          observedAtDrop.push(thumb.observed),
        );
        const media = imageMedia();
        const { fixture } = await renderInTimeline(media);
        comesNear(fixture.nativeElement);
        expect(thumb.observed).toBe(true);

        fixture.destroy();

        // Let go first: MediaService cancels a resolve only once nobody waits for it.
        expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
          media,
          'thumbnail',
          null,
        );
        expect(observedAtDrop).toEqual([false]);
      });

      it('does not cancel a thumbnail that already loaded when its row is destroyed', async () => {
        const { fixture } = await renderInTimeline(imageMedia());
        comesNear(fixture.nativeElement);

        fixture.destroy();

        // The cached URL stays for the next row that shows it; only the pin goes.
        expect(mediaService.drop).not.toHaveBeenCalled();
        expect(mediaService.unpin).toHaveBeenCalledWith('blob:thumb');
      });

      it('keeps showing a loaded image when its message is re-projected mid-fling', async () => {
        const { fixture } = await renderInTimeline(imageMedia());
        comesNear(fixture.nativeElement);
        mediaService.resolveMedia.mockClear();
        fling();

        const reprojected = { ...imageMedia(), id: 'presented-media-again' };
        fixture.componentRef.setInput('media', reprojected);
        TestBed.tick();

        expect(mediaService.resolveMedia).not.toHaveBeenCalled();
        expect(fixture.componentInstance.src()).toBe('blob:thumb');
      });

      it('keeps a thumbnail loading when its message is re-projected (a receipt, a reaction)', async () => {
        const thumb = new Subject<string>();
        mediaService.resolveMedia.mockReturnValue(thumb.asObservable());
        const { fixture } = await renderInTimeline(imageMedia());
        comesNear(fixture.nativeElement);

        fixture.componentRef.setInput('media', {
          ...imageMedia(),
          id: 'presented-media-again',
        });
        TestBed.tick();

        // Neither cancelled nor started again: the one download carries on.
        expect(mediaService.drop).not.toHaveBeenCalled();
        expect(mediaService.resolveMedia).toHaveBeenCalledTimes(1);
        expect(thumb.observed).toBe(true);
        thumb.next('blob:thumb');
        expect(fixture.componentInstance.src()).toBe('blob:thumb');
      });

      it('retries a failed thumbnail when its message is re-projected', async () => {
        mediaService.resolveMedia.mockReturnValueOnce(
          throwError(() => new Error('offline')),
        );
        const { fixture } = await renderInTimeline(imageMedia());
        comesNear(fixture.nativeElement);
        expect(fixture.componentInstance.hasError()).toBe(true);

        fixture.componentRef.setInput('media', {
          ...imageMedia(),
          id: 'presented-media-again',
        });
        TestBed.tick();
        comesNear(fixture.nativeElement);

        expect(mediaService.resolveMedia).toHaveBeenCalledTimes(2);
        expect(fixture.componentInstance.hasError()).toBe(false);
        expect(fixture.componentInstance.src()).toBe('blob:thumb');
      });

      it('swaps the load when an edit changes the image', async () => {
        const thumb = new Subject<string>();
        mediaService.resolveMedia.mockReturnValueOnce(thumb.asObservable());
        const first = imageMedia();
        const { fixture } = await renderInTimeline(first);
        comesNear(fixture.nativeElement);

        const edited = {
          ...imageMedia(),
          id: 'presented-media-edited',
          filename: 'other.png',
        };
        fixture.componentRef.setInput('media', edited);
        TestBed.tick();
        comesNear(fixture.nativeElement);

        expect(mediaService.drop).toHaveBeenCalledExactlyOnceWith(
          first,
          'thumbnail',
          null,
        );
        expect(mediaService.resolveMedia).toHaveBeenLastCalledWith(
          edited,
          'thumbnail',
        );
      });

      it('holds a video poster the same way', async () => {
        fling();
        const video = {
          ...imageMedia(),
          kind: 'video',
          filename: 'clip.mp4',
          mimeType: 'video/mp4',
          hasThumbnail: true,
        } as PresentedMediaReference;
        const { fixture } = await renderInTimeline(video);
        comesNear(fixture.nativeElement);
        expect(mediaService.resolveMedia).not.toHaveBeenCalled();

        activity.settle();

        expect(mediaService.resolveMedia).toHaveBeenCalledExactlyOnceWith(
          video,
          'thumbnail',
        );
        expect(fixture.componentInstance.poster()).toBe('blob:thumb');
      });

      it('loads what it held once the flag is turned off', async () => {
        fling();
        const { fixture } = await renderInTimeline(imageMedia());

        gate.setEnabled(false);

        expect(fixture.componentInstance.src()).toBe('blob:thumb');
      });
    });
  });
});
