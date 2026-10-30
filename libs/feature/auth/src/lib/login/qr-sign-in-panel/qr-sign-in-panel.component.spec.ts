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
  const enterCheckCode = vi.fn();
  const service = {
    signInByShowingCode: vi.fn(() => ({
      state$: new Observable<NewDeviceState>((subscriber) => {
        const flow = { states: new Subject<NewDeviceState>(), closed: false };
        flows.push(flow);
        const inner = flow.states.subscribe(subscriber);
        return () => {
          flow.closed = true;
          inner.unsubscribe();
        };
      }),
      enterCheckCode,
    })),
  };
  return {
    service,
    flows,
    enterCheckCode,
    current: () => flows[flows.length - 1]!,
  };
}

async function renderPanel() {
  const fake = fakeSignIn();
  const signedIn = vi.fn();
  const back = vi.fn();
  const result = await render(QrSignInPanelComponent, {
    inputs: { homeserverUrl: 'https://hs.example', serverName: 'example' },
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
  it('starts one sign-in for the chosen homeserver and server name', async () => {
    const { service } = await renderPanel();

    expect(service.signInByShowingCode).toHaveBeenCalledOnce();
    expect(service.signInByShowingCode).toHaveBeenCalledWith(
      'https://hs.example',
      'example',
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

  describe('the code step', () => {
    const typeCode = async (
      fixture: { detectChanges(): void; whenStable(): Promise<unknown> },
      code: string,
    ) => {
      fireEvent.input(screen.getByTestId('qr-check-code-input'), {
        target: { value: code },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fixture.detectChanges();
      await fixture.whenStable();
    };

    it('shows the code step and announces it', async () => {
      const { emit } = await renderPanel();
      const region = screen.getByTestId('qr-sign-in-announcement');
      expect(region.getAttribute('aria-live')).toBe('polite');
      await waitFor(() =>
        expect(region.textContent?.trim()).toBe('Creating a code…'),
      );

      await emit({ kind: 'enter-check-code' });

      expect(
        screen.getByRole('heading', {
          name: 'Enter the code from your other device',
        }),
      ).toBeTruthy();
      const field = screen.getByRole('textbox', { name: 'Code' });
      expect(field).toBe(screen.getByTestId('qr-check-code-input'));
      expect(field.getAttribute('inputmode')).toBe('numeric');
      expect(field.getAttribute('aria-describedby')).toBe('qr-check-code-hint');
      expect(
        document.getElementById('qr-check-code-hint')?.textContent?.trim(),
      ).toBe('Your other device shows a two-digit number.');
      // The same node, so the change is announced rather than a new region's content.
      expect(screen.getByTestId('qr-sign-in-announcement')).toBe(region);
      await waitFor(() =>
        expect(region.textContent?.trim()).toBe(
          'Enter the code your other device shows.',
        ),
      );
    });

    it('keeps a leading zero', async () => {
      const { emit, enterCheckCode, fixture } = await renderPanel();
      await emit({ kind: 'enter-check-code' });

      await typeCode(fixture, '07');

      expect(enterCheckCode).toHaveBeenCalledOnce();
      expect(enterCheckCode).toHaveBeenCalledWith('07');
    });

    it('refuses one digit with the schema error', async () => {
      const { emit, enterCheckCode, fixture } = await renderPanel();
      await emit({ kind: 'enter-check-code' });

      await typeCode(fixture, '7');

      expect(enterCheckCode).not.toHaveBeenCalled();
      const field = screen.getByTestId('qr-check-code-input');
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(field.getAttribute('aria-describedby')).toBe(
        'qr-check-code-error',
      );
      expect(
        document.getElementById('qr-check-code-error')?.textContent?.trim(),
      ).toBe('Enter the two digits.');
      expect(document.activeElement).toBe(field);
    });

    it('moves focus to the field when the step opens', async () => {
      const { emit } = await renderPanel();

      await emit({ kind: 'enter-check-code' });

      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByTestId('qr-check-code-input'),
        ),
      );
    });

    it('shows the wrong-code alert once a code was entered', async () => {
      const { emit, fixture } = await renderPanel();
      await emit({ kind: 'enter-check-code' });
      await typeCode(fixture, '24');

      await emit({ kind: 'failed', reason: 'insecure' });

      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        "That isn't the code your other device shows, so nothing was shared. Show a new code and try again.",
      );
      expect(
        screen.getByRole('button', { name: 'Show a new code' }),
      ).toBeTruthy();
    });

    it('blames no code for an insecure connection before one is entered in this flow', async () => {
      const { emit, fixture } = await renderPanel();
      await emit({ kind: 'enter-check-code' });
      await typeCode(fixture, '24');
      await emit({ kind: 'failed', reason: 'insecure' });
      fireEvent.click(screen.getByRole('button', { name: 'Show a new code' }));
      fixture.detectChanges();

      await emit({ kind: 'failed', reason: 'insecure' });

      expect(screen.getByRole('alert').textContent?.trim()).toBe(
        "The connection between the devices wasn't secure, so nothing was shared.",
      );
    });

    it('starts empty again with a new code', async () => {
      const { emit, fixture } = await renderPanel();
      await emit({ kind: 'enter-check-code' });
      fireEvent.input(screen.getByTestId('qr-check-code-input'), {
        target: { value: '24' },
      });
      await emit({ kind: 'failed', reason: 'insecure' });

      fireEvent.click(screen.getByRole('button', { name: 'Show a new code' }));
      fixture.detectChanges();
      await emit({ kind: 'enter-check-code' });

      expect(
        (screen.getByTestId('qr-check-code-input') as HTMLInputElement).value,
      ).toBe('');
    });
  });

  it('shows the user code while it waits for approval', async () => {
    const { emit } = await renderPanel();

    await emit({ kind: 'waiting-for-approval', userCode: 'ABCD-1234' });

    expect(screen.getByTestId('qr-sign-in-user-code').textContent).toContain(
      'ABCD-1234',
    );
    expect(screen.getByTestId('qr-sign-in-user-code').textContent).toContain(
      'Approve the sign-in on your other device.',
    );
    expect(
      screen.getByRole('heading', { name: 'Waiting for approval' }),
    ).toBeTruthy();
    expect(screen.queryByTestId('qr-check-code-input')).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByTestId('qr-sign-in-announcement').textContent?.trim(),
      ).toBe(
        'Waiting for approval. Approve the sign-in on your other device. If it asks for a code, enter ABCD-1234.',
      ),
    );
  });

  it('shows progress while it signs in', async () => {
    const { emit } = await renderPanel();

    await emit({ kind: 'signing-in' });

    expect(
      screen.getByText('Signing in…', { selector: '.qr-sign-in__busy p' }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getByTestId('qr-sign-in-announcement').textContent?.trim(),
      ).toBe('Signing in…'),
    );
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

    await emit({ kind: 'waiting-for-approval', userCode: 'ABCD' });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        'Waiting for approval',
      ),
    );
  });

  const FAILURES: [QrSignInFailure, string, boolean][] = [
    ['expired', 'The code expired.', true],
    ['declined', 'Sign-in was cancelled on the other device.', true],
    [
      'insecure',
      "The connection between the devices wasn't secure, so nothing was shared.",
      true,
    ],
    ['unsupported', "Your server doesn't support QR sign-in.", false],
    [
      'already-signed-in',
      'This account is already signed in on this device.',
      false,
    ],
    [
      'other-server',
      "That account is on a different server from the one you chose, so Trinity signed it out again. Sign in through that account's server.",
      false,
    ],
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
    const { emit, flows, service, fixture } = await renderPanel();

    await emit({ kind: 'failed', reason: 'expired' });
    fireEvent.click(screen.getByRole('button', { name: 'Show a new code' }));
    fixture.detectChanges();

    // The failure does not linger while the new code is created.
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByText('Creating a code…', { selector: '.qr-sign-in__busy p' }),
    ).toBeTruthy();
    expect(service.signInByShowingCode).toHaveBeenCalledTimes(2);
    expect(flows[0]!.closed).toBe(true);
    expect(flows[1]!.closed).toBe(false);
  });

  it('offers another way to sign in at every step', async () => {
    const { emit, back, current } = await renderPanel();

    await emit({ kind: 'enter-check-code' });
    fireEvent.click(
      screen.getByRole('button', { name: 'Sign in another way' }),
    );

    expect(back).toHaveBeenCalledOnce();
    expect(current().closed).toBe(true);
  });

  it('cancels and goes back on Escape', async () => {
    const { back, current, fixture } = await renderPanel();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);

    const unhandled = fireEvent.keyDown(fixture.nativeElement as HTMLElement, {
      key: 'Escape',
    });
    document.removeEventListener('keydown', outer);

    expect(back).toHaveBeenCalledOnce();
    expect(current().closed).toBe(true);
    expect(unhandled).toBe(false);
    expect(outer).not.toHaveBeenCalled();
  });

  it('cancels the sign-in when it is destroyed', async () => {
    const { current, fixture } = await renderPanel();

    fixture.destroy();

    expect(current().closed).toBe(true);
  });

  it('reports a finished sign-in', async () => {
    const { emit, signedIn } = await renderPanel();

    await emit({ kind: 'done' });

    expect(signedIn).toHaveBeenCalledOnce();
  });
});
