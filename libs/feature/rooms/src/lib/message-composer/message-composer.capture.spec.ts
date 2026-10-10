import {
  renderComposer,
  setMobilePlatform,
  stagedFiles,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { EMPTY, NEVER, Subject, of, throwError } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from 'vitest';
import { TrnToastService } from '@trinity/components/overlay';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  MediaPickerService,
  PrivacySettingsService,
  type CaptureOptions,
  type CapturedMedia,
} from '@trinity/platform-native';

const photo = (): CapturedMedia => ({
  file: new File([new Uint8Array([1, 2])], 'photo.jpeg', {
    type: 'image/jpeg',
  }),
  hints: { width: 4032, height: 3024 },
});

function nativePicker(overrides: Partial<MediaPickerService> = {}) {
  return MockProvider(MediaPickerService, {
    available: true,
    captureSupported: true,
    capturePhoto: vi.fn(() => of(photo())),
    captureVideo: vi.fn(() => of(null)),
    ...overrides,
  });
}

/** The ceiling an unknown homeserver limit falls back to off the phone apps (jsdom). */
const FALLBACK_BYTES = 512 * 1_048_576;

/** What the composer handed the camera as its upload limit, once that has settled. */
function maxBytesOf(capture: Mock): Promise<number | null> {
  const [options] = capture.mock.calls[0] as unknown as [CaptureOptions];
  return Promise.resolve(options.maxBytes ?? null);
}

describe('MessageComposerComponent — capture', () => {
  beforeEach(() => stubObjectUrls());
  afterEach(() => {
    setMobilePlatform(false);
    vi.useRealTimers();
  });

  // One render per case: the suite's global providers are registered in a `beforeEach`, so a
  // second render after `TestBed.resetTestingModule()` inside one test would lose them.
  describe('derives one capture mode', () => {
    it('native on device', async () => {
      const { fixture } = await renderComposer({}, [nativePicker()]);
      expect(fixture.componentInstance['attachments'].captureMode).toBe(
        'native',
      );
    });

    it('web on a phone browser', async () => {
      setMobilePlatform(true);
      const { fixture } = await renderComposer();
      expect(fixture.componentInstance['attachments'].captureMode).toBe('web');
    });

    it('none on desktop', async () => {
      const { fixture } = await renderComposer();
      expect(fixture.componentInstance['attachments'].captureMode).toBe('none');
    });
  });

  it('stages a native photo with its hints, asking the camera to follow the gallery setting', async () => {
    const capturePhoto = vi.fn(() => of(photo()));
    const { fixture } = await renderComposer({}, [
      nativePicker({ capturePhoto }),
      MockProvider(PrivacySettingsService, {
        saveCapturesToGallery: signal(true).asReadonly(),
      }),
    ]);
    const cmp = fixture.componentInstance;

    cmp.onTakePhoto();

    expect(capturePhoto).toHaveBeenCalledWith({
      saveToGallery: true,
      maxBytes: expect.any(Promise),
    });
    expect(await maxBytesOf(capturePhoto)).toBe(FALLBACK_BYTES);
    expect(stagedFiles(cmp).map((f) => f.name)).toEqual(['photo.jpeg']);
    expect(cmp['attachments'].staged()[0]?.media.hints).toEqual({
      width: 4032,
      height: 3024,
    });
  });

  it('does not save to the gallery by default', async () => {
    const captureVideo = vi.fn(() => of(null));
    const { fixture } = await renderComposer({}, [
      nativePicker({ captureVideo }),
    ]);

    fixture.componentInstance.onRecordVideo();

    expect(captureVideo).toHaveBeenCalledWith({
      saveToGallery: false,
      maxBytes: expect.any(Promise),
    });
    expect(await maxBytesOf(captureVideo)).toBe(FALLBACK_BYTES);
  });

  it("passes the account's homeserver upload limit to the camera", async () => {
    const capturePhoto = vi.fn(() => of(null));
    const { fixture } = await renderComposer({ accountId: '@me:example.org' }, [
      nativePicker({ capturePhoto }),
    ]);
    const uploadLimit = vi
      .spyOn(TestBed.inject(MediaPipeline), 'uploadLimit')
      .mockReturnValue(of(5_000_000));

    fixture.componentInstance.onTakePhoto();

    expect(uploadLimit).toHaveBeenCalledWith('@me:example.org');
    expect(capturePhoto).toHaveBeenCalledWith({
      saveToGallery: false,
      maxBytes: expect.any(Promise),
    });
    expect(await maxBytesOf(capturePhoto)).toBe(5_000_000);
  });

  it('opens the camera at once, without waiting for an upload limit that never arrives', async () => {
    const capturePhoto = vi.fn(() => of(null));
    const { fixture } = await renderComposer({}, [
      nativePicker({ capturePhoto }),
    ]);
    vi.spyOn(TestBed.inject(MediaPipeline), 'uploadLimit').mockReturnValue(
      NEVER,
    );
    vi.useFakeTimers();

    fixture.componentInstance.onTakePhoto();

    expect(capturePhoto).toHaveBeenCalledTimes(1);
  });

  it('falls back to the device ceiling once the wait, counted from the tap, runs out', async () => {
    const capturePhoto = vi.fn(() => of(null));
    const { fixture } = await renderComposer({}, [
      nativePicker({ capturePhoto }),
    ]);
    vi.spyOn(TestBed.inject(MediaPipeline), 'uploadLimit').mockReturnValue(
      NEVER,
    );
    vi.useFakeTimers();

    fixture.componentInstance.onTakePhoto();
    const limit = maxBytesOf(capturePhoto);
    vi.advanceTimersByTime(3000);

    expect(await limit).toBe(FALLBACK_BYTES);
  });

  it('falls back to the device ceiling on a failed limit lookup and still stages the capture', async () => {
    const capturePhoto = vi.fn(() => of(photo()));
    const { fixture } = await renderComposer({}, [
      nativePicker({ capturePhoto }),
    ]);
    vi.spyOn(TestBed.inject(MediaPipeline), 'uploadLimit').mockReturnValue(
      throwError(() => new Error('media config unavailable')),
    );

    fixture.componentInstance.onTakePhoto();

    expect(await maxBytesOf(capturePhoto)).toBe(FALLBACK_BYTES);
    expect(stagedFiles(fixture.componentInstance)).toHaveLength(1);
  });

  it('leaves no unhandled rejection when the limit lookup completes empty and the camera is cancelled', async () => {
    // The limit is only awaited once a capture comes back, so a cancel never consumes it: a
    // rejection in the promise itself (an empty lookup) would go unhandled.
    const capturePhoto = vi.fn(() => of(null));
    const { fixture } = await renderComposer({}, [
      nativePicker({ capturePhoto }),
    ]);
    vi.spyOn(TestBed.inject(MediaPipeline), 'uploadLimit').mockReturnValue(
      EMPTY,
    );
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      fixture.componentInstance.onTakePhoto();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off('unhandledRejection', onRejection);
    }

    expect(rejections).toEqual([]);
    expect(await maxBytesOf(capturePhoto)).toBe(FALLBACK_BYTES);
  });

  it('stages nothing and says nothing when the camera is cancelled', async () => {
    const { fixture } = await renderComposer({}, [
      nativePicker({ capturePhoto: vi.fn(() => of(null)) }),
    ]);

    fixture.componentInstance.onTakePhoto();

    expect(stagedFiles(fixture.componentInstance)).toEqual([]);
    expect(TestBed.inject(TrnToastService).show).not.toHaveBeenCalled();
  });

  it('opens one camera for a double tap', async () => {
    const shot = new Subject<CapturedMedia | null>();
    const capturePhoto = vi.fn(() => shot);
    const { fixture } = await renderComposer({}, [
      nativePicker({ capturePhoto }),
    ]);
    const cmp = fixture.componentInstance;

    cmp.onTakePhoto();
    cmp.onTakePhoto();
    expect(capturePhoto).toHaveBeenCalledTimes(1);

    shot.next(photo());
    shot.complete();
    expect(stagedFiles(cmp)).toHaveLength(1);
    cmp.onTakePhoto();
    expect(capturePhoto).toHaveBeenCalledTimes(2);
  });

  it('drops a capture that returns after the room changed', async () => {
    const shot = new Subject<CapturedMedia | null>();
    const { fixture } = await renderComposer({ roomId: '!a:example.org' }, [
      nativePicker({ capturePhoto: vi.fn(() => shot) }),
    ]);

    fixture.componentInstance.onTakePhoto();
    fixture.componentRef.setInput('roomId', '!b:example.org');
    fixture.detectChanges();
    shot.next(photo());

    expect(stagedFiles(fixture.componentInstance)).toEqual([]);
  });

  it('on a phone browser, opens the camera input and stages what it returns', async () => {
    setMobilePlatform(true);
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid=composer-photo-capture-input]',
    )!;
    const click = vi.spyOn(input, 'click').mockImplementation(() => undefined);

    cmp.onTakePhoto();
    expect(click).toHaveBeenCalledTimes(1);
    expect(input.getAttribute('accept')).toBe('image/*');
    expect(input.hasAttribute('capture')).toBe(true);
    expect(
      container
        .querySelector('[data-testid=composer-video-capture-input]')
        ?.getAttribute('accept'),
    ).toBe('video/*');

    const shot = new File([new Uint8Array([1])], 'image.jpg', {
      type: 'image/jpeg',
    });
    Object.defineProperty(input, 'files', {
      value: [shot],
      configurable: true,
    });
    cmp.onCaptureInput({ target: input } as unknown as Event, 'photo');

    expect(stagedFiles(cmp)).toEqual([shot]);
    expect(input.value).toBe('');
  });

  it('on a phone browser, refuses a capture larger than the homeserver accepts', async () => {
    setMobilePlatform(true);
    const { fixture, container } = await renderComposer();
    const cmp = fixture.componentInstance;
    vi.spyOn(TestBed.inject(MediaPipeline), 'uploadLimit').mockReturnValue(
      of(2 * 1_048_576),
    );
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid=composer-video-capture-input]',
    )!;
    const clip = new File([new Uint8Array(3 * 1_048_576)], 'video.mp4', {
      type: 'video/mp4',
    });
    Object.defineProperty(input, 'files', {
      value: [clip],
      configurable: true,
    });

    cmp.onCaptureInput({ target: input } as unknown as Event, 'video');

    expect(stagedFiles(cmp)).toEqual([]);
    expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
      'That video is too large to send. Your homeserver accepts files up to 2 MB.',
      { duration: 6000, variant: 'danger' },
    );
  });

  it('keeps the thread composer a plain attach button when it cannot capture', async () => {
    const { fixture } = await renderComposer({ richActions: false });
    expect(fixture.componentInstance.hasInsertMenu()).toBe(false);
  });

  it('gives the thread composer the tray once it can capture', async () => {
    const { fixture, container } = await renderComposer(
      { richActions: false },
      [nativePicker()],
    );
    expect(fixture.componentInstance.hasInsertMenu()).toBe(true);
    expect(
      container.querySelector('[data-testid=composer-insert]'),
    ).not.toBeNull();
  });
});
