import { TestBed } from '@angular/core/testing';
import { QrCodeService } from '@trinity/platform-native/qr-code';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QrScannerComponent } from './qr-scanner.component';

describe('QrScannerComponent', () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
  });

  it('surfaces a denied camera permission and allows retrying', async () => {
    const { container, fixture } = await render(QrScannerComponent, {
      providers: [
        MockProvider(QrCodeService, {
          openCamera: vi
            .fn()
            .mockRejectedValue(
              new DOMException('Permission denied', 'NotAllowedError'),
            ),
        }),
      ],
    });
    await fixture.whenStable();

    expect(container.textContent).toContain('Camera access was denied');
    fireEvent.click(container.querySelector('button')!);

    expect(TestBed.inject(QrCodeService).openCamera).toHaveBeenCalledTimes(2);
  });

  it('releases the camera and emits when cancelled', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const closeCamera = vi.fn();
    const { container, fixture } = await render(QrScannerComponent, {
      providers: [
        MockProvider(QrCodeService, {
          openCamera: vi.fn().mockResolvedValue(stream),
          closeCamera,
        }),
      ],
    });
    let cancelled = false;
    fixture.componentInstance.cancelled.subscribe(() => (cancelled = true));
    await fixture.whenStable();

    fireEvent.click(
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes('Cancel scan'),
      )!,
    );

    expect(closeCamera).toHaveBeenCalledWith(stream);
    expect(cancelled).toBe(true);
  });

  it('releases the camera when the app is hidden without auto-resuming', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const closeCamera = vi.fn();
    const { fixture } = await render(QrScannerComponent, {
      providers: [
        MockProvider(QrCodeService, {
          openCamera: vi.fn().mockResolvedValue(stream),
          closeCamera,
        }),
      ],
    });
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);
    await fixture.whenStable();

    window.dispatchEvent(new Event('pagehide'));

    expect(closeCamera).toHaveBeenCalledWith(stream);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(TestBed.inject(QrCodeService).openCamera).toHaveBeenCalledOnce();
  });
});
