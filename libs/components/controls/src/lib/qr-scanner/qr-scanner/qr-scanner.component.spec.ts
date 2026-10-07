import { TestBed } from '@angular/core/testing';
import { QrCodeService } from '@trinity/platform-native';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrnButton } from '../../button/trn-button';
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

  it('keeps scanner actions behind Trinity button contracts', async () => {
    const { fixture } = await render(QrScannerComponent, {
      providers: [
        MockProvider(QrCodeService, {
          openCamera: vi
            .fn()
            .mockRejectedValue(new Error('Camera unavailable')),
        }),
      ],
    });
    await fixture.whenStable();

    expect(
      fixture.debugElement.queryAll((debugElement) =>
        debugElement.providerTokens.includes(TrnButton),
      ),
    ).toHaveLength(2);
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

  it('closes a camera that opens after the scan was cancelled and never attaches it', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    let resolve!: (stream: MediaStream) => void;
    const opening = new Promise<MediaStream>((r) => (resolve = r));
    const closeCamera = vi.fn();
    const { container, fixture } = await render(QrScannerComponent, {
      providers: [
        MockProvider(QrCodeService, {
          openCamera: vi.fn().mockReturnValue(opening),
          closeCamera,
        }),
      ],
    });
    const cancelled = vi.fn();
    fixture.componentInstance.cancelled.subscribe(cancelled);

    window.dispatchEvent(new Event('pagehide'));
    closeCamera.mockClear();
    resolve(stream);
    await fixture.whenStable();

    expect(cancelled).toHaveBeenCalledOnce();
    expect(closeCamera).toHaveBeenCalledExactlyOnceWith(stream);
    expect(container.querySelector('video')!.srcObject).toBeNull();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
  });

  it('shows a friendly error and stops the camera when the QR library fails to load', async () => {
    const stream = { getTracks: () => [] } as unknown as MediaStream;
    const closeCamera = vi.fn();
    const load = vi
      .fn()
      .mockRejectedValueOnce(
        new TypeError('Failed to fetch dynamically imported module: /chunk.js'),
      )
      .mockResolvedValue({});
    const { container, fixture } = await render(QrScannerComponent, {
      providers: [
        MockProvider(QrCodeService, {
          openCamera: vi.fn().mockResolvedValue(stream),
          closeCamera,
          load,
        }),
      ],
    });
    await vi.waitFor(() =>
      expect(fixture.componentInstance.status()).toBe('error'),
    );
    await fixture.whenStable();

    expect(container.textContent).toContain('QR scanner couldn’t be loaded');
    expect(container.textContent).not.toContain('dynamically imported');
    expect(closeCamera).toHaveBeenCalledWith(stream);

    fireEvent.click(container.querySelector('button')!);

    await vi.waitFor(() =>
      expect(fixture.componentInstance.status()).toBe('scanning'),
    );
    expect(load).toHaveBeenCalledTimes(2);
  });

  describe.each([
    ['cancelled', 'cancel'],
    ['destroyed', 'destroy'],
  ] as const)(
    'when %s while the decoder is still loading',
    (_label, action) => {
      it('closes the camera that opened meanwhile and never starts scanning', async () => {
        const stream = { getTracks: () => [] } as unknown as MediaStream;
        let finishLoading!: () => void;
        const closeCamera = vi.fn();
        const openCamera = vi.fn().mockResolvedValue(stream);
        const { container, fixture } = await render(QrScannerComponent, {
          providers: [
            MockProvider(QrCodeService, {
              openCamera,
              closeCamera,
              load: () =>
                new Promise<never>((r) => (finishLoading = r as never)),
            }),
          ],
        });
        const scanned = vi.fn();
        fixture.componentInstance.scanned.subscribe(scanned);
        await vi.waitFor(() => expect(openCamera).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve));

        if (action === 'cancel') {
          fireEvent.click(
            [...container.querySelectorAll('button')].find((button) =>
              button.textContent?.includes('Cancel scan'),
            )!,
          );
        } else {
          fixture.destroy();
        }
        finishLoading();
        await vi.waitFor(() =>
          expect(closeCamera).toHaveBeenCalledWith(stream),
        );
        await new Promise((resolve) => setTimeout(resolve));

        expect(fixture.componentInstance.status()).not.toBe('scanning');
        expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
        expect(scanned).not.toHaveBeenCalled();
      });
    },
  );
});
