import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { render, screen } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, Subject, of, throwError, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEVICE_CONFIRMATION_SETTLE_MS,
  TrustDeviceConfirmationService,
  type DeviceConfirmationGate,
} from '@trinity/data-access/trust';
import {
  ACCOUNT_REMOVAL_LAUNCHER,
  type AccountRemovalOutcome,
} from '@trinity/platform-native';
import { DeviceConfirmationPage } from './device-confirmation.page';

async function renderPage(
  options: {
    gate?: DeviceConfirmationGate;
    canSkip?: boolean;
    skipFails?: boolean;
    removal?: AccountRemovalOutcome;
    /** The removal's own stream, when a test settles it by hand. */
    removal$?: Observable<AccountRemovalOutcome>;
    /** `settledGate()`; by default it answers with the gate as it is now. */
    settled?: () => Observable<DeviceConfirmationGate>;
  } = {},
) {
  const gate = signal<DeviceConfirmationGate>(
    options.gate ?? { kind: 'required', status: 'needs-recovery' },
  );
  const navigate = vi.fn(async () => true);
  const navigateByUrl = vi.fn(async () => true);
  const skip = vi.fn(() =>
    options.skipFails ? throwError(() => new Error('refused')) : of(undefined),
  );
  const remove = vi.fn(
    () => options.removal$ ?? of(options.removal ?? { kind: 'kept' }),
  );
  const settledGate = options.settled ?? vi.fn(() => of(gate()));
  const result = await render(DeviceConfirmationPage, {
    providers: [
      MockProvider(TrustDeviceConfirmationService, {
        gate: gate.asReadonly(),
        activeAccountId: signal<string | null>('@me:hs').asReadonly(),
        canSkip: options.canSkip ?? false,
        skip,
        settledGate,
      }),
      { provide: ACCOUNT_REMOVAL_LAUNCHER, useValue: { remove } },
      MockProvider(Router, { navigate, navigateByUrl }),
    ],
  });
  return { ...result, gate, navigate, navigateByUrl, skip, remove };
}

function byTestId(container: Element, id: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

/** RxJS timers run on `setInterval`, so fake it along with `setTimeout`. */
function useFakeTimers(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  });
}

afterEach(() => vi.useRealTimers());

describe('DeviceConfirmationPage', () => {
  it('leads with the recovery key when the account has recovery', async () => {
    const { container } = await renderPage();

    expect(
      screen.getByRole('heading', { name: 'Verify it’s you' }),
    ).toBeTruthy();
    expect(container.textContent).toContain(
      'This is a new device for this account. Verify it before you continue, so your encrypted messages are readable here and other people’s apps keep sending messages to it.',
    );
    const actions = [
      ...container.querySelectorAll<HTMLElement>('button[data-testid]'),
    ].map((button) => button.textContent?.trim());
    expect(actions).toEqual([
      'Use recovery key',
      'Verify with another device',
      'Reset my identity',
      'Remove account from this device',
    ]);
    expect(screen.queryByRole('button', { name: /Report a bug/ })).toBeNull();
  });

  it('offers only another device, with the note, when the identity has no recovery', async () => {
    const { container } = await renderPage({
      gate: { kind: 'required', status: 'needs-verification' },
    });

    expect(byTestId(container, 'device-confirmation-recovery-key')).toBeNull();
    expect(
      byTestId(
        container,
        'device-confirmation-no-recovery',
      )?.textContent?.trim(),
    ).toBe(
      'This account has no recovery key yet. Verify with a device where you’re already signed in.',
    );
    expect(
      byTestId(container, 'device-confirmation-other-device'),
    ).not.toBeNull();
  });

  it('explains the reset and presents it as a danger action', async () => {
    const { container } = await renderPage();

    expect(container.textContent).toContain(
      'Can’t verify? Resetting your identity lets you continue, but people who verified you need to do it again and your message backup is deleted.',
    );
    expect(
      byTestId(container, 'device-confirmation-reset')?.getAttribute('variant'),
    ).toBe('danger');
  });

  it('opens the existing flows and asks them to come back here', async () => {
    const { container, navigate } = await renderPage();

    byTestId(container, 'device-confirmation-recovery-key')!.click();
    expect(navigate).toHaveBeenLastCalledWith(['/encryption/unlock'], {
      queryParams: { returnTo: '/encryption/confirm' },
    });

    byTestId(container, 'device-confirmation-other-device')!.click();
    expect(navigate).toHaveBeenLastCalledWith(['/encryption/verify'], {
      queryParams: { returnTo: '/encryption/confirm' },
    });

    byTestId(container, 'device-confirmation-reset')!.click();
    expect(navigate).toHaveBeenLastCalledWith(['/encryption/unlock'], {
      queryParams: { returnTo: '/encryption/confirm', reset: '1' },
    });
  });

  // Release builds: the first test's action list has no skip (canSkip defaults to false).
  it('offers the skip in debug builds', async () => {
    const { container, skip } = await renderPage({ canSkip: true });

    const button = byTestId(container, 'device-confirmation-skip');
    expect(button?.textContent?.trim()).toBe('Skip for now (debug build)');
    button!.click();
    expect(skip).toHaveBeenCalledOnce();
  });

  it('says when the skip did not work', async () => {
    const { container, fixture } = await renderPage({
      canSkip: true,
      skipFails: true,
    });

    byTestId(container, 'device-confirmation-skip')!.click();
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Skipping the check didn’t work. Try again.',
    );
  });

  it('says it is checking while the status is still loading', async () => {
    const { container } = await renderPage({
      gate: { kind: 'pending' },
      settled: () => NEVER,
    });

    // The spinner carries its own status role, so read the text, not the role.
    expect(screen.getByText('Checking this device…')).toBeTruthy();
    expect(byTestId(container, 'device-confirmation-other-device')).toBeNull();
    expect(byTestId(container, 'device-confirmation-retry')).toBeNull();
  });

  it('offers Try again when the check cannot settle, and checks again', async () => {
    // `settledGate()` gives up after its settle time while the gate is still pending.
    const settled = vi
      .fn<() => Observable<DeviceConfirmationGate>>()
      .mockReturnValueOnce(of({ kind: 'not-required' }))
      .mockReturnValue(NEVER);
    const { container, fixture } = await renderPage({
      gate: { kind: 'pending' },
      settled,
    });

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Checking this device is taking longer than expected. Try again.',
    );
    expect(screen.queryByText('Checking this device…')).toBeNull();

    byTestId(container, 'device-confirmation-retry')!.click();
    fixture.detectChanges();

    expect(settled).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Checking this device…')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('leaves for Rooms once nothing is required', async () => {
    const { gate, navigateByUrl } = await renderPage();

    gate.set({ kind: 'not-required' });
    TestBed.tick();

    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('leaves at once when visited with nothing required', async () => {
    const { navigateByUrl } = await renderPage({
      gate: { kind: 'not-required' },
    });
    TestBed.tick();

    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('removes the account through the shared flow and opens Rooms when others remain', async () => {
    const { container, remove, navigateByUrl } = await renderPage({
      removal: { kind: 'removed', remainingAccountIds: ['@alt:hs'] },
    });

    byTestId(container, 'device-confirmation-remove')!.click();

    expect(remove).toHaveBeenCalledWith('@me:hs');
    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('leaves sign-in to the removal flow when no account remains', async () => {
    const { container, navigateByUrl } = await renderPage({
      removal: { kind: 'removed', remainingAccountIds: [] },
    });

    byTestId(container, 'device-confirmation-remove')!.click();

    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('opens Security settings when the person exports keys first', async () => {
    const { container, navigate } = await renderPage({
      removal: { kind: 'export-keys' },
    });

    byTestId(container, 'device-confirmation-remove')!.click();

    expect(navigate).toHaveBeenCalledWith(['/settings/security']);
  });

  it('says when the account could not be removed', async () => {
    const { container, fixture } = await renderPage({
      removal: { kind: 'failed' },
    });

    byTestId(container, 'device-confirmation-remove')!.click();
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'This account couldn’t be removed right now. Try again.',
    );
  });

  it('stays for the removal’s outcome when the sign-out ends the check first', async () => {
    // Signing the account out repoints the active account before the outcome arrives, so
    // the gate stops asking while the removal is still in flight.
    const removal = new Subject<AccountRemovalOutcome>();
    const { container, fixture, gate, navigateByUrl } = await renderPage({
      removal$: removal,
    });

    byTestId(container, 'device-confirmation-remove')!.click();
    gate.set({ kind: 'not-required' });
    TestBed.tick();
    expect(navigateByUrl).not.toHaveBeenCalled();

    removal.next({ kind: 'failed' });
    removal.complete();
    fixture.detectChanges();
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'This account couldn’t be removed right now. Try again.',
    );
  });

  it('leaves for Rooms once, after the removal, when other accounts remain', async () => {
    const removal = new Subject<AccountRemovalOutcome>();
    const { container, gate, navigateByUrl } = await renderPage({
      removal$: removal,
    });

    byTestId(container, 'device-confirmation-remove')!.click();
    gate.set({ kind: 'not-required' });
    TestBed.tick();
    removal.next({ kind: 'removed', remainingAccountIds: ['@alt:hs'] });
    removal.complete();
    TestBed.tick();

    expect(navigateByUrl).toHaveBeenCalledOnce();
    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('leaves sign-in to the removal flow, even once the gate stops asking', async () => {
    const removal = new Subject<AccountRemovalOutcome>();
    const { container, gate, navigateByUrl } = await renderPage({
      removal$: removal,
    });

    byTestId(container, 'device-confirmation-remove')!.click();
    gate.set({ kind: 'not-required' });
    TestBed.tick();
    removal.next({ kind: 'removed', remainingAccountIds: [] });
    removal.complete();
    TestBed.tick();

    expect(navigateByUrl).not.toHaveBeenCalled();
  });

  it('offers the ways out when the check goes back to loading and stays there', async () => {
    const { container, fixture, gate } = await renderPage();
    useFakeTimers();

    gate.set({ kind: 'pending' });
    TestBed.tick();
    expect(screen.getByText('Checking this device…')).toBeTruthy();

    vi.advanceTimersByTime(DEVICE_CONFIRMATION_SETTLE_MS);
    fixture.detectChanges();

    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Checking this device is taking longer than expected. Try again.',
    );
    const actions = [
      ...container.querySelectorAll<HTMLElement>('button[data-testid]'),
    ].map((button) => button.textContent?.trim());
    expect(actions).toEqual([
      'Try again',
      'Continue',
      'Remove account from this device',
    ]);
  });

  it('keeps checking while the loading is within the settle time', async () => {
    const { container, fixture, gate } = await renderPage();
    useFakeTimers();

    gate.set({ kind: 'pending' });
    TestBed.tick();
    vi.advanceTimersByTime(DEVICE_CONFIRMATION_SETTLE_MS - 1);
    fixture.detectChanges();

    expect(screen.getByText('Checking this device…')).toBeTruthy();
    expect(byTestId(container, 'device-confirmation-continue')).toBeNull();
  });

  it('drops the stalled state once the status arrives', async () => {
    const { container, fixture, gate } = await renderPage();
    useFakeTimers();
    gate.set({ kind: 'pending' });
    TestBed.tick();
    vi.advanceTimersByTime(DEVICE_CONFIRMATION_SETTLE_MS);
    fixture.detectChanges();
    expect(byTestId(container, 'device-confirmation-continue')).not.toBeNull();

    gate.set({ kind: 'required', status: 'needs-verification' });
    TestBed.tick();
    fixture.detectChanges();
    expect(
      byTestId(container, 'device-confirmation-other-device'),
    ).not.toBeNull();

    // Loading again starts a fresh wait rather than stalling at once.
    gate.set({ kind: 'pending' });
    TestBed.tick();
    fixture.detectChanges();
    expect(screen.getByText('Checking this device…')).toBeTruthy();
    expect(byTestId(container, 'device-confirmation-continue')).toBeNull();
  });

  it('lets the person continue to Rooms when the check cannot settle', async () => {
    const { container, fixture, navigateByUrl } = await renderPage({
      gate: { kind: 'pending' },
      settled: () => of({ kind: 'not-required' }),
    });
    fixture.detectChanges();

    byTestId(container, 'device-confirmation-continue')!.click();

    expect(navigateByUrl).toHaveBeenCalledWith('/rooms', { replaceUrl: true });
  });

  it('removes the account from the stalled check too', async () => {
    const { container, fixture, remove } = await renderPage({
      gate: { kind: 'pending' },
      settled: () => of({ kind: 'not-required' }),
    });
    fixture.detectChanges();

    byTestId(container, 'device-confirmation-remove')!.click();

    expect(remove).toHaveBeenCalledWith('@me:hs');
  });
});
