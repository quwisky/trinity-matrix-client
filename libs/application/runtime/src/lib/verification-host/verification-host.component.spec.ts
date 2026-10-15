import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import {
  TrustVerificationService,
  type VerificationView,
} from '@trinity/data-access/trust';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ENCRYPTION_DIALOG_COMPONENTS } from '../application-dialog-loaders';
import { AppLockDialogGate } from '../composition/app-lock-dialog.gate';
import { VerificationHostComponent } from './verification-host.component';

/** Stands in for the lazy verification page: one control to take focus. */
@Component({
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<button type="button">Accept</button>`,
})
class VerifyPageProbeComponent {}

function incoming(): VerificationView {
  return {
    requestId: 1,
    stage: 'requested',
    otherUserId: '@me:hs',
    otherDeviceId: 'PHONE',
    isSelfVerification: true,
    incoming: true,
    emoji: null,
    sasConfirmed: false,
    newSession: null,
    qrShowAvailable: false,
    qrScanAvailable: false,
    cancelReason: null,
  };
}

async function setup(
  verify: () => Observable<unknown> = () => of(class StubVerify {}),
  options: { status?: AppLockStatus; realSurfaces?: boolean } = {},
) {
  const active = signal<VerificationView | null>(null);
  const status = signal<AppLockStatus>(options.status ?? 'off');
  const dismiss = vi.fn(() => active.set(null));
  const closed = new Subject<void>();
  const close = vi.fn();
  const open = vi.fn().mockReturnValue({ closed, close });
  const { fixture } = await render(VerificationHostComponent, {
    providers: [
      MockProvider(TrustVerificationService, { active, dismiss }),
      MockProvider(AppLockService, { status: status.asReadonly() }),
      ...(options.realSurfaces
        ? []
        : [MockProvider(TrnSurfaceService, { open })]),
      {
        provide: ENCRYPTION_DIALOG_COMPONENTS,
        useValue: {
          unlock: () => of(class StubUnlock {}),
          verify,
        },
      },
    ],
  });
  return {
    fixture,
    active,
    status,
    dismiss,
    gate: fixture.debugElement.injector.get(AppLockDialogGate),
    open,
    close,
  };
}

describe('VerificationHostComponent', () => {
  it('presents incoming and cross-user verification outside routed flows', async () => {
    const { fixture, active, open } = await setup();
    active.set(incoming());
    fixture.detectChanges();
    await vi.waitFor(() => expect(open).toHaveBeenCalled());

    expect(open).toHaveBeenCalledWith(expect.any(Function), {
      inputs: { asModal: true },
      disableClose: true,
    });
  });

  it('leaves outgoing self-verification to the canonical route', async () => {
    const { fixture, active, open } = await setup();
    active.set({ ...incoming(), incoming: false });
    fixture.detectChanges();

    expect(open).not.toHaveBeenCalled();
  });

  it('does not open after destruction while the lazy page is loading', async () => {
    const page = new Subject<unknown>();
    const { fixture, active, open } = await setup(() => page);
    active.set(incoming());
    fixture.detectChanges();

    fixture.destroy();
    page.next(class StubVerify {});

    expect(open).not.toHaveBeenCalled();
  });

  it('closes the active verification dialog on destruction', async () => {
    const { fixture, active, open, close } = await setup();
    active.set(incoming());
    fixture.detectChanges();
    await vi.waitFor(() => expect(open).toHaveBeenCalled());

    fixture.destroy();

    expect(close).toHaveBeenCalledOnce();
  });

  it('dismisses stale presentation when the session projection clears', async () => {
    const { fixture, active, open, close } = await setup();
    active.set(incoming());
    fixture.detectChanges();
    await vi.waitFor(() => expect(open).toHaveBeenCalled());

    active.set(null);
    fixture.detectChanges();

    expect(close).toHaveBeenCalledOnce();
  });

  describe('while App lock covers the app', () => {
    it('holds an incoming request until the person unlocks', async () => {
      const { fixture, active, status, open } = await setup(undefined, {
        status: 'locked',
      });
      active.set(incoming());
      fixture.detectChanges();
      await fixture.whenStable();
      expect(open).not.toHaveBeenCalled();

      status.set('unlocked');
      fixture.detectChanges();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    });

    it('holds a cross-user request too', async () => {
      const { fixture, active, status, open } = await setup(undefined, {
        status: 'locked',
      });
      active.set({ ...incoming(), incoming: false, isSelfVerification: false });
      fixture.detectChanges();
      await fixture.whenStable();
      expect(open).not.toHaveBeenCalled();

      status.set('unlocked');
      fixture.detectChanges();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    });

    it('opens only once the lock screen has closed', async () => {
      const { fixture, active, status, gate, open } = await setup(undefined, {
        status: 'locked',
      });
      gate.coverShown(true);
      active.set(incoming());
      status.set('unlocked');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(open).not.toHaveBeenCalled();

      gate.coverShown(false);
      fixture.detectChanges();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    });

    it('drops a held request that was cancelled or timed out meanwhile', async () => {
      const { fixture, active, status, dismiss, open } = await setup(
        undefined,
        { status: 'locked' },
      );
      active.set(incoming());
      fixture.detectChanges();
      active.set({
        ...incoming(),
        stage: 'cancelled',
        cancelReason: 'The verification timed out.',
      });
      fixture.detectChanges();
      await fixture.whenStable();
      expect(dismiss).toHaveBeenCalledOnce();

      status.set('unlocked');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(open).not.toHaveBeenCalled();
    });

    it('keeps a dialog already open when the app locks', async () => {
      const { fixture, active, status, open, close } = await setup();
      active.set(incoming());
      fixture.detectChanges();
      await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());

      status.set('locked');
      fixture.detectChanges();
      active.set({ ...incoming(), stage: 'cancelled' });
      fixture.detectChanges();
      await fixture.whenStable();
      // An open dialog shows its own cancelled state; the person dismisses it after unlocking.
      expect(close).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledOnce();
    });

    it('moves focus into the dialog as it opens after unlock', async () => {
      const { fixture, active, status, gate } = await setup(
        () => of(VerifyPageProbeComponent),
        { status: 'locked', realSurfaces: true },
      );
      const before = document.createElement('button');
      before.textContent = 'Open room';
      document.body.append(before);
      gate.coverShown(true);
      active.set(incoming());
      status.set('unlocked');
      fixture.detectChanges();
      await fixture.whenStable();
      expect(document.querySelector('.cdk-dialog-container')).toBeNull();

      // The lock screen's native close puts focus back where it was before the lock.
      before.focus();
      gate.coverShown(false);
      fixture.detectChanges();
      await vi.waitFor(() =>
        expect(
          document
            .querySelector('.cdk-dialog-container')
            ?.contains(document.activeElement),
        ).toBe(true),
      );
      expect(document.activeElement).not.toBe(before);
      before.remove();
    });
  });
});
