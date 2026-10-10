import {
  pasteEvent,
  pickFiles,
  renderComposer,
  setNativePlatform,
  stagedFiles,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { EMPTY, NEVER, Subject, of, shareReplay, throwError } from 'rxjs';
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
  CaptureTooLargeError,
  MediaPickerService,
  type CaptureOptions,
} from '@trinity/platform-native';

const MB = 1_048_576;

/** A one-byte file that reports `bytes` as its size, as a disk-backed pick does unread. */
function sized(name: string, type: string, bytes: number): File {
  const file = new File([new Uint8Array([1])], name, { type });
  Object.defineProperty(file, 'size', { value: bytes });
  return file;
}

function stubLimit(limit: ReturnType<MediaPipeline['uploadLimit']>): void {
  vi.spyOn(TestBed.inject(MediaPipeline), 'uploadLimit').mockReturnValue(limit);
}

function camera(overrides: Partial<MediaPickerService> = {}) {
  return MockProvider(MediaPickerService, {
    available: true,
    captureSupported: true,
    capturePhoto: vi.fn(() => of(null)),
    captureVideo: vi.fn(() => of(null)),
    ...overrides,
  });
}

/** What the composer handed the camera as its largest acceptable capture, once settled. */
function maxBytesOf(capture: Mock): Promise<number | null> {
  const [options] = capture.mock.calls[0] as unknown as [CaptureOptions];
  return Promise.resolve(options.maxBytes ?? null);
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const toast = () => TestBed.inject(TrnToastService).show;

const DEVICE_256 =
  'Trinity can send files up to 256 MB on this device.' as const;
const DEVICE_512 =
  'Trinity can send files up to 512 MB on this device.' as const;

describe('MessageComposerComponent — upload limit fallback', () => {
  beforeEach(() => stubObjectUrls());
  afterEach(() => {
    setNativePlatform(false);
    vi.useRealTimers();
  });

  describe('captures', () => {
    it('caps a native capture at 256 MB on a phone when the homeserver states no limit', async () => {
      setNativePlatform(true);
      const captureVideo = vi.fn(() => of(null));
      const { fixture } = await renderComposer({}, [camera({ captureVideo })]);
      stubLimit(of(null));

      fixture.componentInstance.onRecordVideo();

      expect(await maxBytesOf(captureVideo)).toBe(256 * MB);
    });

    it('caps a capture at 512 MB off the phone apps when the homeserver states no limit', async () => {
      const capturePhoto = vi.fn(() => of(null));
      const { fixture } = await renderComposer({}, [camera({ capturePhoto })]);
      stubLimit(of(null));

      fixture.componentInstance.onTakePhoto();

      expect(await maxBytesOf(capturePhoto)).toBe(512 * MB);
    });

    it('lets a stated homeserver limit above the cap govern a capture', async () => {
      setNativePlatform(true);
      const captureVideo = vi.fn(() => of(null));
      const { fixture } = await renderComposer({}, [camera({ captureVideo })]);
      stubLimit(of(1024 * MB));

      fixture.componentInstance.onRecordVideo();

      expect(await maxBytesOf(captureVideo)).toBe(1024 * MB);
    });

    it('caps a capture when the limit lookup fails', async () => {
      setNativePlatform(true);
      const captureVideo = vi.fn(() => of(null));
      const { fixture } = await renderComposer({}, [camera({ captureVideo })]);
      stubLimit(throwError(() => new Error('media config unavailable')));

      fixture.componentInstance.onRecordVideo();

      expect(await maxBytesOf(captureVideo)).toBe(256 * MB);
    });

    it('caps a capture when the limit lookup times out', async () => {
      setNativePlatform(true);
      const captureVideo = vi.fn(() => of(null));
      const { fixture } = await renderComposer({}, [camera({ captureVideo })]);
      stubLimit(NEVER);
      vi.useFakeTimers();

      fixture.componentInstance.onRecordVideo();
      const limit = maxBytesOf(captureVideo);
      vi.advanceTimersByTime(3000);

      expect(await limit).toBe(256 * MB);
    });

    it("refuses an over-cap native capture with this device's cap, not the homeserver's", async () => {
      setNativePlatform(true);
      const { fixture } = await renderComposer({}, [
        camera({
          captureVideo: vi.fn(() =>
            throwError(() => new CaptureTooLargeError(300 * MB, 256 * MB)),
          ),
        }),
      ]);
      stubLimit(of(null));

      fixture.componentInstance.onRecordVideo();
      await settle();

      expect(toast()).toHaveBeenCalledWith(
        `That video is too large to send. ${DEVICE_256}`,
        { duration: 6000, variant: 'danger' },
      );
      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
    });

    it('refuses an over-cap mobile-web capture before staging when the limit is unknown', async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(null));
      const input = document.createElement('input');
      Object.defineProperty(input, 'files', {
        value: [sized('video.mp4', 'video/mp4', 600 * MB)],
        configurable: true,
      });

      fixture.componentInstance.onCaptureInput(
        { target: input } as unknown as Event,
        'video',
      );

      expect(toast()).toHaveBeenCalledWith(
        `That video is too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
    });
  });

  describe('prewarming the lookup', () => {
    // Spied on the prototype: the composer asks as soon as it connects, before a test could
    // reach the root instance through TestBed.
    const lookups = () => vi.spyOn(MediaPipeline.prototype, 'uploadLimit');

    afterEach(() =>
      vi.mocked(MediaPipeline.prototype.uploadLimit).mockRestore?.(),
    );

    it("asks for the account's limit once on connect, so a later pick does not wait", async () => {
      // A server answer that only a subscriber already listening hears, then replays — the
      // shape of MediaService's shared, cached lookup.
      const answer = new Subject<number | null>();
      const cached = answer.pipe(shareReplay(1));
      const uploadLimit = lookups().mockReturnValue(cached);
      const { fixture } = await renderComposer({
        accountId: '@me:example.org',
      });

      expect(uploadLimit).toHaveBeenCalledTimes(1);
      expect(uploadLimit).toHaveBeenCalledWith('@me:example.org');

      answer.next(null);
      const file = sized('clip.mp4', 'video/mp4', MB);
      pickFiles(fixture.componentInstance, [file]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([file]);
    });

    it('asks again when the active account changes', async () => {
      const uploadLimit = lookups().mockReturnValue(of(null));
      const { fixture } = await renderComposer({
        accountId: '@me:example.org',
      });

      fixture.componentRef.setInput('accountId', '@other:example.org');
      fixture.detectChanges();
      await fixture.whenStable();

      expect(uploadLimit.mock.calls).toEqual([
        ['@me:example.org'],
        ['@other:example.org'],
      ]);
    });

    it('swallows a failed prewarm', async () => {
      lookups().mockReturnValue(
        throwError(() => new Error('media config unavailable')),
      );
      const { fixture } = await renderComposer({
        accountId: '@me:example.org',
      });

      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
      expect(toast()).not.toHaveBeenCalled();
    });
  });

  describe('picked files', () => {
    it('refuses a picked file over the cap when the homeserver states no limit', async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(null));

      pickFiles(fixture.componentInstance, [
        sized('long.mov', 'video/quicktime', 600 * MB),
      ]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
      expect(toast()).toHaveBeenCalledWith(
        `That file is too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it('stages a picked file under the cap when the homeserver states no limit', async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(null));
      const file = sized('clip.mp4', 'video/mp4', 500 * MB);

      pickFiles(fixture.componentInstance, [file]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([file]);
      expect(toast()).not.toHaveBeenCalled();
    });

    it('applies the 256 MB cap to a phone app gallery pick', async () => {
      setNativePlatform(true);
      const big = sized('panorama.jpg', 'image/jpeg', 300 * MB);
      const small = sized('photo.jpg', 'image/jpeg', 4 * MB);
      const { fixture } = await renderComposer({}, [
        camera({ pickImages: vi.fn(() => of([big, small])) }),
      ]);
      stubLimit(of(null));

      fixture.componentInstance.onAttach();

      expect(stagedFiles(fixture.componentInstance)).toEqual([small]);
      expect(toast()).toHaveBeenCalledWith(
        `That file is too large to send. ${DEVICE_256}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it("names the homeserver's limit when it is below the cap", async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(50 * MB));

      pickFiles(fixture.componentInstance, [
        sized('talk.mp4', 'video/mp4', 60 * MB),
      ]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
      expect(toast()).toHaveBeenCalledWith(
        'That file is too large to send. Your homeserver accepts files up to 50 MB.',
        { duration: 6000, variant: 'danger' },
      );
    });

    it('lets a stated homeserver limit above the cap govern a pick', async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(1024 * MB));
      const file = sized('film.mkv', 'video/x-matroska', 700 * MB);

      pickFiles(fixture.componentInstance, [file]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([file]);
      expect(toast()).not.toHaveBeenCalled();
    });

    it('caps a pick when the limit lookup fails', async () => {
      const { fixture } = await renderComposer();
      stubLimit(throwError(() => new Error('media config unavailable')));

      pickFiles(fixture.componentInstance, [
        sized('long.mov', 'video/quicktime', 600 * MB),
      ]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
      expect(toast()).toHaveBeenCalledWith(
        `That file is too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it('caps a pick when the limit lookup completes without a value', async () => {
      const { fixture } = await renderComposer();
      stubLimit(EMPTY);
      const file = sized('clip.mp4', 'video/mp4', 10 * MB);

      pickFiles(fixture.componentInstance, [
        sized('long.mov', 'video/quicktime', 600 * MB),
        file,
      ]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([file]);
      expect(toast()).toHaveBeenCalledWith(
        `That file is too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it('stages a pick exactly at the cap and refuses one byte over it', async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(null));
      const atCap = sized('at-cap.mp4', 'video/mp4', 512 * MB);

      pickFiles(fixture.componentInstance, [
        atCap,
        sized('over-cap.mp4', 'video/mp4', 512 * MB + 1),
      ]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([atCap]);
      expect(toast()).toHaveBeenCalledTimes(1);
      expect(toast()).toHaveBeenCalledWith(
        `That file is too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it('stages nothing when edit mode began while the limit was being looked up', async () => {
      const limit = new Subject<number | null>();
      const { fixture } = await renderComposer();
      stubLimit(limit);

      fixture.componentInstance.stageFiles([
        sized('clip.mp4', 'video/mp4', MB),
      ]);
      fixture.componentRef.setInput('editing', true);
      fixture.detectChanges();
      limit.next(null);

      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
    });

    it('caps a pick once the limit lookup times out', async () => {
      const { fixture } = await renderComposer();
      stubLimit(NEVER);
      vi.useFakeTimers();
      const file = sized('clip.mp4', 'video/mp4', 10 * MB);

      pickFiles(fixture.componentInstance, [
        sized('long.mov', 'video/quicktime', 600 * MB),
        file,
      ]);
      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
      vi.advanceTimersByTime(3000);

      expect(stagedFiles(fixture.componentInstance)).toEqual([file]);
      expect(toast()).toHaveBeenCalledWith(
        `That file is too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it('counts every refused file in one message and stages the rest', async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(null));
      const file = sized('notes.pdf', 'application/pdf', MB);

      fixture.componentInstance.stageFiles([
        sized('a.mov', 'video/quicktime', 600 * MB),
        file,
        sized('b.mov', 'video/quicktime', 700 * MB),
      ]);

      expect(stagedFiles(fixture.componentInstance)).toEqual([file]);
      expect(toast()).toHaveBeenCalledTimes(1);
      expect(toast()).toHaveBeenCalledWith(
        `2 files are too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it('refuses a pasted image over the cap', async () => {
      const { fixture } = await renderComposer();
      stubLimit(of(null));
      const { event, preventDefault } = pasteEvent({
        files: [sized('scan.png', 'image/png', 600 * MB)],
      });

      fixture.componentInstance.onPaste(event);

      expect(preventDefault).toHaveBeenCalled();
      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
      expect(toast()).toHaveBeenCalledWith(
        `That file is too large to send. ${DEVICE_512}`,
        { duration: 6000, variant: 'danger' },
      );
    });

    it('drops a pick whose limit arrives after the room changed', async () => {
      const limit = new Subject<number | null>();
      const { fixture } = await renderComposer({ roomId: '!a:example.org' });
      stubLimit(limit);

      pickFiles(fixture.componentInstance, [
        sized('clip.mp4', 'video/mp4', MB),
      ]);
      fixture.componentRef.setInput('roomId', '!b:example.org');
      fixture.detectChanges();
      limit.next(null);

      expect(stagedFiles(fixture.componentInstance)).toEqual([]);
    });
  });
});
