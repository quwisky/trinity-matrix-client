import { TestBed } from '@angular/core/testing';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  MediaPipeline,
  type PresentedMediaReference,
} from '@trinity/data-access/media';
import { EMPTY, Subject, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LightboxComponent } from './lightbox/lightbox.component';
import { MediaViewerLauncher } from './media-viewer-launcher';

const image = {
  id: 'presented-media-image',
  kind: 'image',
  filename: 'pic.png',
  mimeType: 'image/png',
} as PresentedMediaReference;

describe('MediaViewerLauncher', () => {
  let closed: Subject<void>;
  const pipeline = {
    resolveMedia: vi.fn(),
    pin: vi.fn(),
    unpin: vi.fn(),
    drop: vi.fn(),
  };
  const dialogs = { open: vi.fn(), prefersSheet: vi.fn(() => false) };
  const ref = {
    close: vi.fn(() => closed.next()),
    get closed() {
      return closed;
    },
  };

  beforeEach(() => {
    closed = new Subject<void>();
    pipeline.resolveMedia.mockReset().mockReturnValue(of('blob:full'));
    pipeline.pin.mockReset();
    pipeline.unpin.mockReset();
    pipeline.drop.mockReset();
    dialogs.open.mockReset().mockReturnValue(ref);
    dialogs.prefersSheet.mockReturnValue(false);
    ref.close.mockClear();
    TestBed.configureTestingModule({
      providers: [
        MediaViewerLauncher,
        { provide: MediaPipeline, useValue: pipeline },
        { provide: TrnSurfaceService, useValue: dialogs },
      ],
    });
  });

  it('opens the full image in the lightbox and pins it while open', async () => {
    const launcher = TestBed.inject(MediaViewerLauncher);

    expect(await firstValueFrom(launcher.open(image))).toBe('opened');

    expect(pipeline.resolveMedia).toHaveBeenCalledWith(image, 'full');
    expect(dialogs.open).toHaveBeenCalledWith(
      LightboxComponent,
      expect.objectContaining({
        inputs: { src: 'blob:full', filename: 'pic.png', media: image },
        ariaLabel: 'pic.png',
        kind: 'auto',
        autoFocus: 'dialog',
      }),
    );
    expect(pipeline.pin).toHaveBeenCalledWith('blob:full');
    expect(pipeline.drop).not.toHaveBeenCalled();
  });

  it('fills the screen where a sheet would clip the image', async () => {
    dialogs.prefersSheet.mockReturnValue(true);

    await firstValueFrom(TestBed.inject(MediaViewerLauncher).open(image));

    expect(dialogs.open).toHaveBeenCalledWith(
      LightboxComponent,
      expect.objectContaining({ kind: 'fullscreen' }),
    );
  });

  it('opens one viewer however often it is asked while one is open', async () => {
    const launcher = TestBed.inject(MediaViewerLauncher);

    await firstValueFrom(launcher.open(image));
    expect(await firstValueFrom(launcher.open(image))).toBe('busy');

    expect(dialogs.open).toHaveBeenCalledTimes(1);
  });

  it('drops the full image when the viewer closes, and can open again', async () => {
    const launcher = TestBed.inject(MediaViewerLauncher);
    await firstValueFrom(launcher.open(image));

    launcher.close();

    // Dropped, not merely unpinned: the full-size blob leaves the cache with the viewer.
    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(
      image,
      'full',
      'blob:full',
    );
    expect(pipeline.unpin).not.toHaveBeenCalled();
    expect(await firstValueFrom(launcher.open(image))).toBe('opened');
  });

  it('reports a failure and lets the next request try again', async () => {
    pipeline.resolveMedia.mockReturnValueOnce(
      throwError(() => new Error('offline')),
    );
    const launcher = TestBed.inject(MediaViewerLauncher);

    expect(await firstValueFrom(launcher.open(image))).toBe('failed');
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(await firstValueFrom(launcher.open(image))).toBe('opened');
  });

  it('reports a resolve that ends without a URL as failed, and lets a retry open', async () => {
    pipeline.resolveMedia.mockReturnValueOnce(EMPTY);
    const launcher = TestBed.inject(MediaViewerLauncher);

    expect(await firstValueFrom(launcher.open(image))).toBe('failed');
    expect(dialogs.open).not.toHaveBeenCalled();
    expect(await firstValueFrom(launcher.open(image))).toBe('opened');
    expect(dialogs.open).toHaveBeenCalledTimes(1);
  });

  it('answers busy while the full image is still loading, and resolves it once', () => {
    const full = new Subject<string>();
    pipeline.resolveMedia.mockReturnValue(full.asObservable());
    const launcher = TestBed.inject(MediaViewerLauncher);
    const first: string[] = [];
    const second: string[] = [];

    launcher.open(image).subscribe((outcome) => first.push(outcome));
    launcher.open(image).subscribe((outcome) => second.push(outcome));

    expect(second).toEqual(['busy']);
    expect(pipeline.resolveMedia).toHaveBeenCalledTimes(1);
    expect(first).toEqual([]);

    full.next('blob:full');

    expect(first).toEqual(['opened']);
    expect(dialogs.open).toHaveBeenCalledTimes(1);
  });

  it('closes the viewer when its owner goes away', async () => {
    const launcher = TestBed.inject(MediaViewerLauncher);
    await firstValueFrom(launcher.open(image));

    launcher.ngOnDestroy();

    expect(ref.close).toHaveBeenCalled();
    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(
      image,
      'full',
      'blob:full',
    );
  });

  it('cancels a full image still loading when its owner goes away', () => {
    const full = new Subject<string>();
    pipeline.resolveMedia.mockReturnValue(full.asObservable());
    const launcher = TestBed.inject(MediaViewerLauncher);
    const request = launcher.open(image).subscribe();

    launcher.ngOnDestroy();

    expect(full.observed).toBe(false);
    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(image, 'full', null);
    expect(dialogs.open).not.toHaveBeenCalled();
    // The request ends without an outcome rather than hanging.
    expect(request.closed).toBe(true);
  });

  it('cancels a full image still loading when its request is abandoned', () => {
    const full = new Subject<string>();
    pipeline.resolveMedia.mockReturnValue(full.asObservable());
    const launcher = TestBed.inject(MediaViewerLauncher);

    launcher.open(image).subscribe().unsubscribe();

    expect(full.observed).toBe(false);
    expect(pipeline.drop).toHaveBeenCalledExactlyOnceWith(image, 'full', null);
    launcher.ngOnDestroy();
    expect(pipeline.drop).toHaveBeenCalledTimes(1);
  });
});
