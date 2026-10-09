import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, Router } from '@angular/router';
import { TrnDialogRef } from '@trinity/components/overlay';
import { QrScannerComponent } from '@trinity/components/controls';
import { DateTimeFormatService, QrCodeService } from '@trinity/platform-native';
import { fireEvent, render, screen, within } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import {
  TrustVerificationService,
  type NewSessionDetails,
  type VerificationView,
} from '@trinity/data-access/trust';
import { of, Subject } from 'rxjs';
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
    newSession: null,
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
        createDataUrl: vi.fn(() =>
          Promise.resolve('data:image/gif;base64,AA=='),
        ),
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

function normalized(host: HTMLElement): string {
  return (host.textContent ?? '').replace(/\s+/g, ' ');
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
    await fixture.whenStable();
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
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.componentInstance.qrCodeUrl()).not.toBeNull();

    active.set(view({ requestId: 1, stage: 'waiting' }));
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.qrCodeUrl()).toBeNull();
  });

  it('does not show a QR code that finished rendering after it was hidden', async () => {
    const active = signal(view({ stage: 'ready', qrShowAvailable: true }));
    const { fixture } = await renderPage(active);
    let resolveUrl!: (url: string) => void;
    vi.mocked(TestBed.inject(QrCodeService).createDataUrl).mockReturnValue(
      new Promise((resolve) => (resolveUrl = resolve)),
    );

    fixture.componentInstance.showQr();
    fixture.componentInstance.hideQr();
    resolveUrl('data:image/gif;base64,AA==');
    await fixture.whenStable();

    expect(fixture.componentInstance.qrCodeUrl()).toBeNull();
  });

  it('still shows the code when the request is republished while it renders', async () => {
    const active = signal(view({ stage: 'ready', qrShowAvailable: true }));
    const { fixture, svc } = await renderPage(active);
    const data = new Subject<Uint8ClampedArray>();
    vi.mocked(svc.showQr).mockReturnValue(data);

    fixture.componentInstance.showQr();
    active.set(view({ stage: 'ready', qrShowAvailable: true }));
    fixture.detectChanges();
    active.set(view({ stage: 'qr-shown' }));
    fixture.detectChanges();
    data.next(new Uint8ClampedArray([1, 2, 3]));
    await fixture.whenStable();

    expect(fixture.componentInstance.qrCodeUrl()).not.toBeNull();
  });

  it('reports a failed render while its code is still wanted', async () => {
    const active = signal(view({ stage: 'ready', qrShowAvailable: true }));
    const { fixture } = await renderPage(active);
    vi.mocked(TestBed.inject(QrCodeService).createDataUrl).mockRejectedValue(
      new Error('boom'),
    );

    fixture.componentInstance.showQr();
    await fixture.whenStable();

    expect(fixture.componentInstance.error()).toBe(
      'Couldn’t render the QR code.',
    );
  });

  it('does not report a render that failed after the code was hidden', async () => {
    const active = signal(view({ stage: 'ready', qrShowAvailable: true }));
    const { fixture } = await renderPage(active);
    let rejectUrl!: (error: Error) => void;
    vi.mocked(TestBed.inject(QrCodeService).createDataUrl).mockReturnValue(
      new Promise((_, reject) => (rejectUrl = reject)),
    );

    fixture.componentInstance.showQr();
    fixture.componentInstance.hideQr();
    rejectUrl(new Error('boom'));
    await fixture.whenStable();

    expect(fixture.componentInstance.error()).toBeNull();
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
    const { container, svc } = await renderPage(
      signal(view({ stage: 'done' })),
      { asModal: true },
    );

    expect(container.querySelector('.crypto-modal')).toBeNull();
    expect(
      within(screen.getByTestId('dialog-surface')).getByRole('heading', {
        level: 2,
        name: 'Verify device',
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByTestId('dialog-close'));
    expect(svc.dismiss).toHaveBeenCalledOnce();
  });

  it('does not touch the modal stack on the routed (non-modal) path', async () => {
    const { close, container } = await renderPage(
      signal(view({ stage: 'done' })),
    );

    fireEvent.click(button(container, 'Done'));

    expect(close).not.toHaveBeenCalled();
  });

  describe('a request from a new session', () => {
    const newSession: NewSessionDetails = {
      deviceId: 'PHONE',
      displayName: 'Pixel 9',
      lastSeenIp: '203.0.113.7',
      lastSeenTs: 1_700_000_000_000,
    };
    const requested = (details: NewSessionDetails | null = newSession) =>
      signal(
        view({
          stage: 'requested',
          incoming: true,
          otherDeviceId: 'PHONE',
          newSession: details,
        }),
      );

    it('presents the request as a new sign-in with the session details', async () => {
      const { container } = await renderPage(requested());

      expect(
        within(container).getByRole('heading', {
          name: 'A new session wants access to your encrypted messages',
        }),
      ).toBeTruthy();
      const details = container.querySelector(
        '[data-testid="verify-new-session"]',
      );
      expect(details?.textContent).toContain('Pixel 9');
      expect(details?.textContent).toContain('PHONE');
      expect(details?.textContent).toContain('203.0.113.7');
      expect(details?.textContent).toContain(
        TestBed.inject(DateTimeFormatService).dateTime(1_700_000_000_000),
      );
      expect(container.textContent).toContain(
        'Only accept if you just signed in on that device yourself. Anyone you let in can read your encrypted messages.',
      );
      expect(container.textContent).not.toContain('Verify this device?');
      expect(container.textContent).not.toContain('Another of your sessions');
    });

    it('shows unknown for details the device list did not provide', async () => {
      const { container } = await renderPage(
        requested({
          deviceId: 'PHONE',
          displayName: null,
          lastSeenIp: null,
          lastSeenTs: null,
        }),
      );

      const details = container.querySelector<HTMLElement>(
        '[data-testid="verify-new-session"]',
      );
      expect(details?.textContent).toContain('PHONE');
      expect(details?.textContent?.match(/unknown/gi)).toHaveLength(3);
    });

    it('makes "Not me" the initial focus', async () => {
      await renderPage(requested());
      await Promise.resolve();

      expect(document.activeElement?.textContent).toContain('Not me');
    });

    it('moves focus to the heading when the request returns to the generic wording', async () => {
      const active = requested();
      const { fixture } = await renderPage(active);
      await Promise.resolve();
      expect(document.activeElement?.textContent).toContain('Not me');

      active.set(
        view({
          stage: 'requested',
          incoming: true,
          otherDeviceId: 'PHONE',
          newSession: null,
        }),
      );
      fixture.detectChanges();
      await fixture.whenStable();
      await Promise.resolve();

      expect(document.activeElement?.textContent?.trim()).toBe(
        'Verify this device?',
      );
    });

    it('cancels the request and closes when "Not me" is chosen', async () => {
      const { svc, container, close } = await renderPage(requested(), {
        asModal: true,
      });

      fireEvent.click(button(container, 'Not me'));

      expect(svc.cancel).toHaveBeenCalledOnce();
      expect(svc.accept).not.toHaveBeenCalled();
      expect(svc.dismiss).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalled();
    });

    it('accepts the request when "It was me" is chosen', async () => {
      const { svc, container } = await renderPage(requested());

      fireEvent.click(button(container, 'It was me'));

      expect(svc.accept).toHaveBeenCalledOnce();
      expect(svc.cancel).not.toHaveBeenCalled();
    });

    it('offers the decline before the accept', async () => {
      const { container } = await renderPage(requested());

      const labels = [...container.querySelectorAll('button')].map((b) =>
        b.textContent?.trim(),
      );

      expect(labels.indexOf('Not me')).toBeGreaterThanOrEqual(0);
      expect(labels.indexOf('Not me')).toBeLessThan(
        labels.indexOf('It was me'),
      );
    });

    it('asks which device the emoji should be compared with', async () => {
      const { container } = await renderPage(
        signal(
          view({
            stage: 'sas-shown',
            newSession,
            emoji: [{ glyph: '🐶', name: 'Dog' }],
          }),
        ),
      );

      expect(container.textContent).toContain(
        'Compare with the screen of the device you just signed in on.',
      );
    });

    it('says the session can now read encrypted messages once verified', async () => {
      const { container } = await renderPage(
        signal(view({ stage: 'done', newSession })),
      );

      expect(normalized(container)).toContain(
        'Pixel 9 (PHONE) can now read your encrypted messages.',
      );
      expect(container.textContent).not.toContain(
        'This session is now trusted',
      );
    });

    // A session names itself, so the name is only ever text: never markup, and isolated so
    // a bidi override inside it cannot reorder what follows.
    it('shows a session name as inert, isolated text', async () => {
      const name = '<img src=x onerror=alert(1)>\u202Egpj.exe';
      const hostile = { ...newSession, displayName: name };
      const { container, fixture } = await renderPage(
        signal(view({ stage: 'done', newSession: hostile })),
      );

      expect(container.querySelector('img')).toBeNull();
      const done = container.querySelector('bdi');
      expect(done?.textContent).toBe(name);
      expect(done?.nextSibling?.textContent).toMatch(/^\s*\(/);
      expect(normalized(container)).toContain(
        `${name} (PHONE) can now read your encrypted messages.`,
      );

      const active = fixture.debugElement.injector.get(TrustVerificationService)
        .active as unknown as WritableSignal<VerificationView | null>;
      active.set(
        view({
          stage: 'requested',
          incoming: true,
          newSession: hostile,
        }),
      );
      fixture.detectChanges();

      expect(container.querySelector('img')).toBeNull();
      const row = container.querySelector(
        '[data-testid="verify-new-session"] bdi',
      );
      expect(row?.textContent).toBe(name);
    });

    it('describes both answers with the title, the details and the note', async () => {
      const { container } = await renderPage(requested());

      for (const label of ['Not me', 'It was me']) {
        const ids = button(container, label)
          .getAttribute('aria-describedby')
          ?.split(' ');
        expect(ids).toHaveLength(3);
        expect(
          ids?.map((id) => container.querySelector(`#${id}`)?.tagName),
        ).toEqual(['H2', 'DL', 'P']);
      }
    });

    it('names the session by its id when it has no name', async () => {
      const { container } = await renderPage(
        signal(
          view({
            stage: 'done',
            newSession: { ...newSession, displayName: null },
          }),
        ),
      );

      expect(normalized(container)).toContain(
        'PHONE can now read your encrypted messages.',
      );
    });

    it('keeps the new device’s own done copy', async () => {
      const { container } = await renderPage(signal(view({ stage: 'done' })));

      expect(container.textContent).toContain(
        'This session is now trusted. Your encrypted history will sync.',
      );
    });

    it('keeps the existing wording when this device is the unverified one', async () => {
      const { container } = await renderPage(requested(null));

      expect(
        within(container).getByRole('heading', { name: 'Verify this device?' }),
      ).toBeTruthy();
      expect(container.textContent).toContain(
        'Another of your sessions wants to verify this one',
      );
      expect(button(container, 'Accept')).toBeTruthy();
      expect(button(container, 'Decline')).toBeTruthy();
      expect(container.textContent).not.toContain('A new session wants');
    });

    it('keeps a cross-user request as it was', async () => {
      const { container } = await renderPage(
        signal(
          view({
            stage: 'requested',
            incoming: true,
            isSelfVerification: false,
            otherUserId: '@bob:hs',
          }),
        ),
      );

      expect(
        within(container).getByRole('heading', {
          name: 'Verify another user?',
        }),
      ).toBeTruthy();
      expect(container.textContent).not.toContain('A new session wants');
    });
  });
});
