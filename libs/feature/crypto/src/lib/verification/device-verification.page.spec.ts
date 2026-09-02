import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TrnDialogRef } from '@trinity/components/overlay';
import { QrScannerComponent } from '@trinity/components/controls';
import { QrCodeService } from '@trinity/platform-native';
import { fireEvent, render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import {
  TrustVerificationService,
  type VerificationView,
} from '@trinity/data-access/trust';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { DeviceVerificationPage } from './device-verification.page';

function view(partial: Partial<VerificationView>): VerificationView {
  return {
    requestId: 1,
    stage: 'requested',
    otherUserId: '@me:hs',
    otherDeviceId: 'OTHER',
    isSelfVerification: true,
    incoming: false,
    emoji: null,
    sasConfirmed: false,
    qrShowAvailable: false,
    qrScanAvailable: false,
    cancelReason: null,
    ...partial,
  };
}

async function renderPage(
  active: WritableSignal<VerificationView | null>,
  options: { returnTo?: string | null; asModal?: boolean } = {},
) {
  const { returnTo = null, asModal = false } = options;
  const close = vi.fn();
  const result = await render(DeviceVerificationPage, {
    inputs: { asModal },
    providers: [
      MockProvider(TrustVerificationService, { active }),
      MockProvider(QrCodeService, {
        cameraSupported: true,
        createDataUrl: vi.fn(() => 'data:image/gif;base64,AA=='),
        openCamera: vi.fn().mockRejectedValue(new Error('camera unavailable')),
      }),
      MockProvider(Router),
      MockProvider(ActivatedRoute, {
        snapshot: {
          queryParamMap: {
            get: (key: string) => (key === 'returnTo' ? returnTo : null),
          },
        } as never,
      }),
      MockProvider(TrnDialogRef, { close }),
    ],
  });

  // Every action method returns a cold Observable the page feeds to runWithBusy.
  const svc = TestBed.inject(TrustVerificationService);
  vi.mocked(svc.startSelfVerification).mockReturnValue(of(undefined));
  vi.mocked(svc.accept).mockReturnValue(of(undefined));
  vi.mocked(svc.startSas).mockReturnValue(of(undefined));
  vi.mocked(svc.showQr).mockReturnValue(of(new Uint8ClampedArray([0, 255, 7])));
  vi.mocked(svc.scanQr).mockReturnValue(of(undefined));
  vi.mocked(svc.confirmQr).mockReturnValue(of(undefined));
  vi.mocked(svc.confirmSas).mockReturnValue(of(undefined));
  vi.mocked(svc.mismatchSas).mockReturnValue(of(undefined));
  vi.mocked(svc.cancel).mockReturnValue(of(undefined));
  const router = TestBed.inject(Router);

  return { ...result, svc, router, close };
}

// Every control on the page is now a native `<button trnBtn>`: the body buttons,
// the routed header's Close (converted to the app-shell <header>), and the SAS
// "They match"/"They don't match"/"Cancel" controls owned by <trn-sas-compare>.
function button(host: HTMLElement, text: string): HTMLElement {
  return [...host.querySelectorAll('button')].find((b) =>
    b.textContent?.includes(text),
  ) as HTMLElement;
}

describe('DeviceVerificationPage', () => {
  it('offers to start when nothing is in flight', async () => {
    const { svc, container } = await renderPage(signal(null));

    fireEvent.click(button(container, 'Start verification'));

    expect(svc.startSelfVerification).toHaveBeenCalledOnce();
  });

  it('accepts an incoming request', async () => {
    const { svc, container } = await renderPage(
      signal(view({ stage: 'requested', incoming: true })),
    );

    fireEvent.click(button(container, 'Accept'));

    expect(svc.accept).toHaveBeenCalledOnce();
  });

  // A cross-user request comes from ANY user who can DM you — not from your own
  // session. Labelling it as self-verification would invite the user to click through a
  // stranger's request, cross-signing that stranger's identity for good.
  it('names the other user on an incoming cross-user request', async () => {
    const { container } = await renderPage(
      signal(
        view({
          stage: 'requested',
          incoming: true,
          isSelfVerification: false,
          otherUserId: '@mallory:evil.example',
        }),
      ),
    );

    expect(container.textContent).toContain('@mallory:evil.example');
    expect(container.textContent).not.toContain('Another of your sessions');
  });

  it('names the other user when comparing emoji cross-user', async () => {
    const { container } = await renderPage(
      signal(
        view({
          stage: 'sas-shown',
          isSelfVerification: false,
          otherUserId: '@mallory:evil.example',
          emoji: [{ glyph: '🐶', name: 'Dog' }],
        }),
      ),
    );

    // The trust decision happens here, so this is where the identity must appear.
    expect(container.textContent).toContain('@mallory:evil.example');
  });

  it('still labels a self-verification as your own session', async () => {
    const { container } = await renderPage(
      signal(view({ stage: 'requested', incoming: true })),
    );

    expect(container.textContent).toContain('Another of your sessions');
  });

  it('shows the emoji and confirms on match', async () => {
    const { svc, container } = await renderPage(
      signal(
        view({ stage: 'sas-shown', emoji: [{ glyph: '🐶', name: 'Dog' }] }),
      ),
    );

    expect(container.textContent).toContain('Dog');
    fireEvent.click(button(container, 'They match'));

    expect(svc.confirmSas).toHaveBeenCalledOnce();
  });

  it('offers show, scan, and emoji choices for a compatible self-verification', async () => {
    const { container } = await renderPage(
      signal(
        view({
          stage: 'ready',
          qrShowAvailable: true,
          qrScanAvailable: true,
        }),
      ),
    );

    expect(button(container, 'Show a QR code')).toBeTruthy();
    expect(button(container, 'Scan a QR code')).toBeTruthy();
    expect(button(container, 'Use emoji instead')).toBeTruthy();
  });

  it('never offers QR verification for another user', async () => {
    const { container } = await renderPage(
      signal(
        view({
          stage: 'ready',
          isSelfVerification: false,
          qrShowAvailable: true,
          qrScanAvailable: true,
        }),
      ),
    );

    expect(container.textContent).not.toContain('QR code');
    expect(button(container, 'Start emoji verification')).toBeTruthy();
  });

  it('generates a QR code only after the explicit show action', async () => {
    const { svc, container } = await renderPage(
      signal(view({ stage: 'ready', qrShowAvailable: true })),
    );

    fireEvent.click(button(container, 'Show a QR code'));

    expect(svc.showQr).toHaveBeenCalledOnce();
  });

  it('renders the generated code with a privacy warning', async () => {
    const active = signal(view({ stage: 'ready', qrShowAvailable: true }));
    const { container, fixture } = await renderPage(active);

    fixture.componentInstance.showQr();
    active.set(view({ stage: 'qr-shown' }));
    fixture.detectChanges();

    expect(
      container.querySelector<HTMLImageElement>('[data-testid="verify-qr"]')
        ?.src,
    ).toContain('data:image/gif;base64,AA==');
    expect(container.textContent).toContain('Do not share, screenshot');
  });

  it('overwrites the rendered QR data URL when the sensitive presentation closes', async () => {
    const active = signal(view({ stage: 'ready', qrShowAvailable: true }));
    const { fixture } = await renderPage(active);

    fixture.componentInstance.showQr();
    active.set(view({ stage: 'qr-shown' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.qrCodeUrl()).not.toBeNull();

    active.set(view({ requestId: 1, stage: 'waiting' }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.qrCodeUrl()).toBeNull();
  });

  it('passes decoded scanner bytes to the verification service', async () => {
    const { fixture, svc, container } = await renderPage(
      signal(view({ stage: 'ready', qrScanAvailable: true })),
    );
    fireEvent.click(button(container, 'Scan a QR code'));
    await fixture.whenStable();
    const scanner = fixture.debugElement.query(
      By.directive(QrScannerComponent),
    );
    const payload = new Uint8ClampedArray([0, 255, 7]);

    scanner.componentInstance.scanned.emit(payload);

    expect(svc.scanQr).toHaveBeenCalledWith(payload);
  });

  it('does not carry scanner intent into a replacement request', async () => {
    const active = signal(
      view({ stage: 'ready', requestId: 1, qrScanAvailable: true }),
    );
    const { fixture, container } = await renderPage(active);
    fireEvent.click(button(container, 'Scan a QR code'));
    await fixture.whenStable();
    expect(
      fixture.debugElement.query(By.directive(QrScannerComponent)),
    ).not.toBeNull();

    active.set(view({ stage: 'ready', requestId: 2, qrScanAvailable: true }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(
      fixture.debugElement.query(By.directive(QrScannerComponent)),
    ).toBeNull();
    expect(container.textContent).toContain('Choose how to verify');
  });

  it('moves focus to the heading when a security-critical stage changes', async () => {
    const active = signal(view({ stage: 'ready', requestId: 1 }));
    const { fixture } = await renderPage(active);

    active.set(view({ stage: 'qr-confirm', requestId: 1 }));
    fixture.detectChanges();
    await fixture.whenStable();
    await Promise.resolve();

    expect(document.activeElement?.textContent).toContain(
      'Did your other device scan this code?',
    );
  });

  it('confirms that the other device scanned the displayed code', async () => {
    const { svc, container } = await renderPage(
      signal(view({ stage: 'qr-confirm' })),
    );

    fireEvent.click(button(container, 'Yes, it scanned this code'));

    expect(svc.confirmQr).toHaveBeenCalledOnce();
  });

  it('waits on the other device once the match is confirmed', async () => {
    const { container } = await renderPage(
      signal(
        view({
          stage: 'sas-shown',
          emoji: [{ glyph: '🐶', name: 'Dog' }],
          sasConfirmed: true,
        }),
      ),
    );

    expect(
      container.querySelector('[data-testid="sas-waiting"] trn-spinner'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="sas-match"]')).toBeNull();
  });

  it('dismisses and navigates to /rooms when done (routed, no returnTo)', async () => {
    const { svc, router, container } = await renderPage(
      signal(view({ stage: 'done' })),
    );

    fireEvent.click(button(container, 'Done'));

    expect(svc.dismiss).toHaveBeenCalledOnce();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('returns to the launch route (returnTo) when finishing a routed flow', async () => {
    const { router, container } = await renderPage(
      signal(view({ stage: 'done' })),
      { returnTo: '/settings' },
    );

    fireEvent.click(button(container, 'Done'));

    expect(router.navigateByUrl).toHaveBeenCalledWith('/settings', {
      replaceUrl: true,
    });
  });

  it('rejects an off-app returnTo and falls back to /rooms', async () => {
    const { router, container } = await renderPage(
      signal(view({ stage: 'done' })),
      { returnTo: '//evil.com' },
    );

    fireEvent.click(button(container, 'Done'));

    expect(router.navigateByUrl).toHaveBeenCalledWith('/rooms', {
      replaceUrl: true,
    });
  });

  it('dismisses its own modal (and emits close) instead of navigating when modal', async () => {
    const { svc, router, close, container, fixture } = await renderPage(
      signal(view({ stage: 'done' })),
      { asModal: true },
    );
    let closed = false;
    fixture.componentInstance.closed.subscribe(() => (closed = true));

    fireEvent.click(button(container, 'Done'));

    expect(svc.dismiss).toHaveBeenCalledOnce();
    expect(closed).toBe(true);
    expect(router.navigateByUrl).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  it('uses the canonical dialog surface recipe in modal mode', async () => {
    const { container } = await renderPage(signal(view({ stage: 'done' })), {
      asModal: true,
    });

    const surface = container.querySelector('.crypto-modal');
    expect(surface).toHaveAttribute('data-trn-layout', 'dialog');
    expect(surface).toHaveAttribute('data-trn-size', 'md');
    expect(surface).toHaveAttribute('data-trn-variant', 'neutral');
  });

  it('does not touch the modal stack on the routed (non-modal) path', async () => {
    const { close, container } = await renderPage(
      signal(view({ stage: 'done' })),
    );

    fireEvent.click(button(container, 'Done'));

    expect(close).not.toHaveBeenCalled();
  });
});
