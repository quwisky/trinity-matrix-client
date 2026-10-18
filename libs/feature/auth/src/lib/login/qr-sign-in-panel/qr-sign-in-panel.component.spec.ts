import {
  QrSignInService,
  type NewDeviceState,
  type QrSignInFailure,
} from '@trinity/data-access/auth';
import { QrCodeService } from '@trinity/platform-native';
import { fireEvent, render, screen, waitFor } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { QrSignInPanelComponent } from './qr-sign-in-panel.component';

/** A fake sign-in whose every subscription is one flow the test drives. */
function fakeSignIn() {
  const flows: { states: Subject<NewDeviceState>; closed: boolean }[] = [];
  const service = {
    signInByShowingCode: vi.fn(
      () =>
        new Observable<NewDeviceState>((subscriber) => {
          const flow = { states: new Subject<NewDeviceState>(), closed: false };
          flows.push(flow);
          const inner = flow.states.subscribe(subscriber);
          return () => {
            flow.closed = true;
            inner.unsubscribe();
          };
        }),
    ),
  };
  return { service, flows, current: () => flows[flows.length - 1]! };
}

async function renderPanel() {
  const fake = fakeSignIn();
  const signedIn = vi.fn();
  const back = vi.fn();
  const result = await render(QrSignInPanelComponent, {
    inputs: { homeserverUrl: 'https://hs.example' },
    on: { signedIn, back },
    providers: [
      MockProvider(QrSignInService, fake.service),
      MockProvider(QrCodeService, {
        createDataUrl: vi.fn(async () => 'data:image/gif;base64,R0lG'),
      }),
    ],
  });
  const emit = async (state: NewDeviceState) => {
    fake.current().states.next(state);
    result.fixture.detectChanges();
    await result.fixture.whenStable();
  };
  return { ...result, ...fake, signedIn, back, emit };
}

describe('QrSignInPanelComponent', () => {
  it('starts one sign-in for the chosen homeserver', async () => {
    const { service } = await renderPanel();

    expect(service.signInByShowingCode).toHaveBeenCalledOnce();
    expect(service.signInByShowingCode).toHaveBeenCalledWith(
      'https://hs.example',
    );
  });

  it('shows the code with a text alternative and its expiry', async () => {
    const { emit } = await renderPanel();

    await emit({
      kind: 'showing-code',
      qr: new Uint8Array([1, 2, 3]),
      expiresAt: new Date(2026, 9, 19, 14, 5).getTime(),
    });

    const image = await screen.findByAltText(
      'QR code to sign in on this device',
    );
    expect(image.getAttribute('src')).toBe('data:image/gif;base64,R0lG');
    expect(screen.getByTestId('qr-sign-in-expiry').textContent).toMatch(
      /2:05\s?PM/,
    );
  });

  it('announces the check code politely in large digits', async () => {
    const { emit } = await renderPanel();

    await emit({ kind: 'confirm-check-code', code: '07' });

    const code = screen.getByTestId('qr-sign-in-check-code');
    expect(code.textContent?.trim()).toBe('07');
    expect(code.closest('[aria-live="polite"]')).not.toBeNull();
  });

  it('keeps the check code beside the user code while it waits for approval', async () => {
    const { emit } = await renderPanel();

    await emit({ kind: 'confirm-check-code', code: '42' });
    await emit({ kind: 'waiting-for-approval', userCode: 'ABCD-1234' });

    expect(
      screen.getByTestId('qr-sign-in-check-code').textContent?.trim(),
    ).toBe('42');
    expect(screen.getByTestId('qr-sign-in-user-code').textContent).toContain(
      'ABCD-1234',
    );
  });

  it('shows progress while it signs in', async () => {
    const { emit } = await renderPanel();

    await emit({ kind: 'signing-in' });

    expect(
      screen.getByText('Signing in…').closest('[aria-live="polite"]'),
    ).not.toBeNull();
  });

  it('moves focus to each step', async () => {
    const { emit } = await renderPanel();

    await emit({
      kind: 'showing-code',
      qr: new Uint8Array([1]),
      expiresAt: Date.now() + 60_000,
    });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        'Scan this code with your other device',
      ),
    );

    await emit({ kind: 'confirm-check-code', code: '42' });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        'Check the code on your other device',
      ),
    );
  });

  const FAILURES: [QrSignInFailure, string, boolean][] = [
    ['expired', 'The code expired.', true],
    ['declined', 'Sign-in was cancelled on the other device.', true],
    ['insecure', "The codes didn't match, so nothing was shared.", true],
    ['unsupported', "Your server doesn't support QR sign-in.", false],
    ['already-signed-in', 'That device is already signed in.', false],
    ['network', 'Lost connection. Check your network and try again.', true],
    [
      'unknown',
      'Something went wrong. Try again or sign in another way.',
      true,
    ],
  ];

  it.each(FAILURES)(
    'explains a %s failure with its next action',
    async (reason, message, canRetry) => {
      const { emit } = await renderPanel();

      await emit({ kind: 'failed', reason });

      expect(screen.getByRole('alert').textContent?.trim()).toBe(message);
      expect(
        screen.queryByRole('button', { name: 'Show a new code' }) !== null,
      ).toBe(canRetry);
      expect(
        screen.getByRole('button', { name: 'Sign in another way' }),
      ).toBeTruthy();
    },
  );

  it('treats a flow that errors as an unknown failure', async () => {
    const { current, fixture } = await renderPanel();

    current().states.error(new Error('boom'));
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Something went wrong. Try again or sign in another way.',
    );
  });

  it('shows a new code by starting a new flow', async () => {
    const { emit, flows, service } = await renderPanel();

    await emit({ kind: 'failed', reason: 'expired' });
    fireEvent.click(screen.getByRole('button', { name: 'Show a new code' }));

    expect(service.signInByShowingCode).toHaveBeenCalledTimes(2);
    expect(flows[0]!.closed).toBe(true);
    expect(flows[1]!.closed).toBe(false);
  });

  it('offers another way to sign in at every step', async () => {
    const { emit, back, current } = await renderPanel();

    await emit({ kind: 'confirm-check-code', code: '42' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in another way' }),
    );

    expect(back).toHaveBeenCalledOnce();
    expect(current().closed).toBe(true);
  });

  it('cancels and goes back on Escape', async () => {
    const { back, current, fixture } = await renderPanel();

    fireEvent.keyDown(fixture.nativeElement as HTMLElement, { key: 'Escape' });

    expect(back).toHaveBeenCalledOnce();
    expect(current().closed).toBe(true);
  });

  it('cancels the sign-in when it is destroyed', async () => {
    const { current, fixture } = await renderPanel();

    fixture.destroy();

    expect(current().closed).toBe(true);
  });

  it.each([true, false])(
    'reports a finished sign-in (verified: %s)',
    async (verified) => {
      const { emit, signedIn } = await renderPanel();

      await emit({ kind: 'done', verified });

      expect(signedIn).toHaveBeenCalledWith({ verified });
    },
  );
});
