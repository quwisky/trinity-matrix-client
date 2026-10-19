import { By } from '@angular/platform-browser';
import {
  type ExistingDeviceState,
  type QrSignInFailure,
} from '@trinity/data-access/auth';
import { QrScannerComponent } from '@trinity/components/controls';
import {
  ExternalBrowserService,
  QrCodeService,
} from '@trinity/platform-native';
import { fireEvent, render, screen, waitFor } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, Subject, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { LinkDeviceComponent } from './link-device.component';

const APPROVAL = 'https://auth.example/device?code=ABCD';

/** A fake link whose every scan is one flow the test drives. */
function fakeLinking() {
  const flows: {
    states: Subject<ExistingDeviceState>;
    closed: boolean;
    confirmCheckCode: ReturnType<typeof vi.fn>;
  }[] = [];
  const linker = {
    accountId: '@me:hs',
    link: vi.fn((_qrBytes: Uint8Array) => {
      const flow = {
        states: new Subject<ExistingDeviceState>(),
        closed: false,
        confirmCheckCode: vi.fn(),
      };
      flows.push(flow);
      return {
        state$: new Observable<ExistingDeviceState>((subscriber) => {
          const inner = flow.states.subscribe(subscriber);
          return () => {
            flow.closed = true;
            inner.unsubscribe();
          };
        }),
        confirmCheckCode: flow.confirmCheckCode,
      };
    }),
  };
  return { linker, flows, current: () => flows[flows.length - 1]! };
}

async function renderLink() {
  const fake = fakeLinking();
  const closed = vi.fn();
  const open = vi.fn(() => of(true));
  const result = await render(LinkDeviceComponent, {
    inputs: { linker: fake.linker },
    on: { closed },
    providers: [
      MockProvider(ExternalBrowserService, { open }),
      MockProvider(QrCodeService, {
        openCamera: vi.fn().mockRejectedValue(new Error('camera unavailable')),
      }),
    ],
  });
  const scanner = () =>
    result.fixture.debugElement.query(By.directive(QrScannerComponent));
  const scan = async (bytes = [1, 2, 3]) => {
    (scanner().componentInstance as QrScannerComponent).scanned.emit(
      new Uint8ClampedArray(bytes),
    );
    result.fixture.detectChanges();
    await result.fixture.whenStable();
  };
  const emit = async (state: ExistingDeviceState) => {
    fake.current().states.next(state);
    result.fixture.detectChanges();
    await result.fixture.whenStable();
  };
  return { ...result, ...fake, closed, open, scanner, scan, emit };
}

describe('LinkDeviceComponent', () => {
  it('links the scanned code through its linker, as a copy of the bytes', async () => {
    const { scan, linker } = await renderLink();

    await scan([9, 8, 7]);

    expect(linker.link).toHaveBeenCalledOnce();
    const [bytes] = linker.link.mock.calls[0]!;
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).not.toBeInstanceOf(Uint8ClampedArray);
    expect([...bytes]).toEqual([9, 8, 7]);
  });

  it('asks whether the check codes match and reports the answer', async () => {
    const { scan, emit, current } = await renderLink();
    await scan();
    await emit({ kind: 'confirm-check-code', code: '42' });

    const digits = screen.getByTestId('link-device-check-code');
    expect(digits.textContent?.trim()).toBe('42');
    expect(digits.getAttribute('aria-hidden')).toBe('true');
    expect(digits.parentElement?.textContent).toContain('4 2');

    fireEvent.click(screen.getByRole('button', { name: "They don't match" }));
    expect(current().confirmCheckCode).toHaveBeenLastCalledWith(false);
    fireEvent.click(screen.getByRole('button', { name: 'They match' }));
    expect(current().confirmCheckCode).toHaveBeenLastCalledWith(true);
  });

  it('announces each step politely in one region that starts empty', async () => {
    const { scan, emit } = await renderLink();
    const region = screen.getByTestId('link-device-announcement');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent?.trim()).toBe('');

    await scan();
    await emit({ kind: 'confirm-check-code', code: '07' });

    expect(screen.getByTestId('link-device-announcement')).toBe(region);
    await waitFor(() =>
      expect(region.textContent?.trim()).toBe('Check code: 0 7'),
    );
  });

  it('opens the approval page only when asked, and keeps it while secrets are shared', async () => {
    const { scan, emit, open } = await renderLink();
    await scan();
    await emit({ kind: 'confirm-check-code', code: '42' });
    await emit({ kind: 'approve-in-browser', verificationUri: APPROVAL });
    await emit({ kind: 'sharing-secrets' });

    expect(open).not.toHaveBeenCalled();
    expect(
      screen.getByTestId('link-device-approval-link').textContent,
    ).toContain(APPROVAL);
    fireEvent.click(screen.getByRole('button', { name: 'Open approval page' }));

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(APPROVAL);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('points to the link when the approval page does not open', async () => {
    const { scan, emit, open, fixture } = await renderLink();
    open.mockReturnValue(of(false));
    await scan();
    await emit({ kind: 'approve-in-browser', verificationUri: APPROVAL });

    fireEvent.click(screen.getByRole('button', { name: 'Open approval page' }));
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      "Couldn't open the page. Use the link below.",
    );
  });

  it('keeps scanning after a code that is not a sign-in code', async () => {
    const { scan, emit, scanner } = await renderLink();
    await scan();

    await emit({ kind: 'not-sign-in-code' });

    expect(
      screen.getByText("That's not a Trinity sign-in code", {
        selector: 'p:not([role=status])',
      }),
    ).toBeTruthy();
    expect(scanner()).not.toBeNull();
  });

  const FAILURES: [QrSignInFailure, string][] = [
    ['expired', 'The code expired.'],
    ['declined', 'Sign-in was cancelled on the other device.'],
    ['insecure', "The codes didn't match, so nothing was shared."],
    ['unsupported', "Your server doesn't support QR sign-in."],
    ['already-signed-in', 'That device is already signed in.'],
    ['network', 'Lost connection. Check your network and try again.'],
    ['unknown', 'Something went wrong. Try again or sign in another way.'],
  ];

  it.each(FAILURES)('explains a %s failure', async (reason, message) => {
    const { scan, emit } = await renderLink();
    await scan();

    await emit({ kind: 'failed', reason });

    expect(screen.getByRole('alert').textContent?.trim()).toBe(message);
  });

  it('scans again after a failure', async () => {
    const { scan, emit, scanner, flows, fixture } = await renderLink();
    await scan();
    await emit({ kind: 'failed', reason: 'expired' });

    fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
    fixture.detectChanges();

    expect(scanner()).not.toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(flows[0]!.closed).toBe(true);
  });

  it('says when the device is linked', async () => {
    const { scan, emit } = await renderLink();
    await scan();

    await emit({ kind: 'done' });

    expect(screen.getByRole('heading', { name: 'Device linked' })).toBeTruthy();
  });

  it('moves focus into each step', async () => {
    const { scan, emit } = await renderLink();
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        'Scan the code on your new device',
      ),
    );

    await scan();
    await emit({ kind: 'confirm-check-code', code: '42' });

    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain(
        'Check the code on your new device',
      ),
    );
  });

  it('cancels the link and closes from the cancel button', async () => {
    const { scan, emit, current, closed } = await renderLink();
    await scan();
    await emit({ kind: 'confirm-check-code', code: '42' });

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(current().closed).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('cancels the link and closes on Escape, keeping the Escape to itself', async () => {
    const { scan, current, closed, fixture } = await renderLink();
    await scan();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);

    const unhandled = fireEvent.keyDown(fixture.nativeElement as HTMLElement, {
      key: 'Escape',
    });
    document.removeEventListener('keydown', outer);

    expect(current().closed).toBe(true);
    expect(closed).toHaveBeenCalledOnce();
    expect(unhandled).toBe(false); // default prevented
    expect(outer).not.toHaveBeenCalled(); // the Settings dialog never sees it
  });

  it('cancels the link when it is destroyed', async () => {
    const { scan, current, fixture } = await renderLink();
    await scan();

    fixture.destroy();

    expect(current().closed).toBe(true);
  });
});
