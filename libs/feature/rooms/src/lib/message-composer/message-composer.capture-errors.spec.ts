import {
  renderComposer,
  stagedFiles,
  stubObjectUrls,
} from './message-composer.spec-harness';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnToastService } from '@trinity/components/overlay';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  AppSettingsService,
  CapturePermissionDeniedError,
  CaptureTooLargeError,
  MediaPickerService,
  NoCameraError,
} from '@trinity/platform-native';

const MB = 1_048_576;

function failingCamera(error: Error) {
  return MockProvider(MediaPickerService, {
    captureSupported: true,
    capturePhoto: vi.fn(() => throwError(() => error)),
    captureVideo: vi.fn(() => throwError(() => error)),
  });
}

describe('MessageComposerComponent — capture errors', () => {
  beforeEach(() => stubObjectUrls());

  it('shows an inline notice with Open settings when camera access is denied', async () => {
    const openAppSettings = vi.fn(() => of(true));
    const { fixture, container } = await renderComposer({}, [
      failingCamera(new CapturePermissionDeniedError('camera')),
      MockProvider(AppSettingsService, { available: true, openAppSettings }),
    ]);

    fixture.componentInstance.onTakePhoto();
    fixture.detectChanges();

    const notice = container.querySelector(
      '[data-testid=composer-capture-notice]',
    );
    expect(notice?.textContent).toContain(
      "Trinity can't use the camera. Allow camera access in your device settings.",
    );
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid=composer-capture-open-settings]',
      )!
      .click();
    fixture.detectChanges();

    expect(openAppSettings).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid=composer-capture-notice]'),
    ).toBeNull();
  });

  it('explains a refused photo library and can be dismissed; no Open settings without a host bridge', async () => {
    const { fixture, container } = await renderComposer({}, [
      failingCamera(new CapturePermissionDeniedError('photos')),
    ]);

    fixture.componentInstance.onRecordVideo();
    fixture.detectChanges();

    expect(
      container.querySelector('[data-testid=composer-capture-notice]')
        ?.textContent,
    ).toContain("Trinity can't save to your photo library.");
    expect(
      container.querySelector('[data-testid=composer-capture-open-settings]'),
    ).toBeNull();
    container
      .querySelector<HTMLButtonElement>(
        '[data-testid=composer-capture-notice-dismiss]',
      )!
      .click();
    fixture.detectChanges();
    expect(
      container.querySelector('[data-testid=composer-capture-notice]'),
    ).toBeNull();
  });

  it('rejects an over-limit native capture with the size error and stages nothing', async () => {
    const { fixture } = await renderComposer({}, [
      failingCamera(new CaptureTooLargeError(200 * MB, 100 * MB)),
    ]);

    fixture.componentInstance.onRecordVideo();

    expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
      'That video is too large to send. Your homeserver accepts files up to 100 MB.',
      { duration: 6000, variant: 'danger' },
    );
    expect(stagedFiles(fixture.componentInstance)).toEqual([]);
  });

  it('rejects an over-limit mobile-web capture before staging', async () => {
    const { fixture } = await renderComposer();
    vi.spyOn(TestBed.inject(MediaPipeline), 'uploadLimit').mockReturnValue(
      of(MB),
    );
    const input = document.createElement('input');
    Object.defineProperty(input, 'files', {
      value: [
        new File([new Uint8Array(2 * MB)], 'image.jpg', { type: 'image/jpeg' }),
      ],
      configurable: true,
    });

    fixture.componentInstance.onCaptureInput(
      { target: input } as unknown as Event,
      'photo',
    );

    expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
      'That photo is too large to send. Your homeserver accepts files up to 1 MB.',
      { duration: 6000, variant: 'danger' },
    );
    expect(stagedFiles(fixture.componentInstance)).toEqual([]);
  });

  it('says so when the device has no camera', async () => {
    const { fixture } = await renderComposer({}, [
      failingCamera(new NoCameraError()),
    ]);

    fixture.componentInstance.onTakePhoto();

    expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
      'This device has no camera.',
      { duration: 4000, variant: 'danger' },
    );
  });

  it('falls back to a retryable message for any other camera failure', async () => {
    const { fixture } = await renderComposer({}, [
      failingCamera(new Error('boom')),
    ]);

    fixture.componentInstance.onTakePhoto();

    expect(TestBed.inject(TrnToastService).show).toHaveBeenCalledWith(
      'Could not take a photo. Try again.',
      { duration: 4000, variant: 'danger' },
    );
  });
});
