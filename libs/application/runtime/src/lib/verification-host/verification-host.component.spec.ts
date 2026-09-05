import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { TrnDialogService } from '@trinity/components/overlay';
import {
  TrustVerificationService,
  type VerificationView,
} from '@trinity/data-access/trust';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, of, Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ENCRYPTION_DIALOG_COMPONENTS } from '../application-dialog-loaders';
import { VerificationHostComponent } from './verification-host.component';

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
    qrShowAvailable: false,
    qrScanAvailable: false,
    cancelReason: null,
  };
}

async function setup(
  verify: () => Observable<unknown> = () => of(class StubVerify {}),
) {
  const active = signal<VerificationView | null>(null);
  const closed = new Subject<void>();
  const close = vi.fn();
  const open = vi.fn().mockReturnValue({ closed, close });
  const { fixture } = await render(VerificationHostComponent, {
    providers: [
      MockProvider(TrustVerificationService, { active }),
      MockProvider(TrnDialogService, { open }),
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
    open,
    close,
    connect: TestBed.inject(TrustVerificationService).connect,
  };
}

describe('VerificationHostComponent', () => {
  it('does not start the session-owned verification projection', async () => {
    const { connect } = await setup();

    expect(connect).not.toHaveBeenCalled();
  });

  it('presents incoming and cross-user verification outside routed flows', async () => {
    const { fixture, active, open } = await setup();
    active.set(incoming());
    fixture.detectChanges();
    await vi.waitFor(() => expect(open).toHaveBeenCalled());

    expect(open).toHaveBeenCalledWith(expect.any(Function), {
      inputs: { asModal: true },
      ariaLabel: 'Verify device',
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
});
