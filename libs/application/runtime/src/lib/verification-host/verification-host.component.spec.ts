import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ENCRYPTION_DIALOG_COMPONENTS } from '@trinity/components/encryption-dialog';
import { TrnDialogService } from '@trinity/components/overlay';
import {
  TrustVerificationService,
  type VerificationView,
} from '@trinity/data-access/trust';
import {
  MatrixClientService,
  type SyncState,
} from '@trinity/data-access/matrix-client';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
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
  verify: () => Promise<unknown> = () => Promise.resolve(class StubVerify {}),
) {
  const syncState = signal<SyncState | null>(null);
  const active = signal<VerificationView | null>(null);
  const closed = new Subject<void>();
  const close = vi.fn();
  const open = vi.fn().mockReturnValue({ closed, close });
  const { fixture } = await render(VerificationHostComponent, {
    providers: [
      MockProvider(MatrixClientService, { syncState }),
      MockProvider(TrustVerificationService, { active }),
      MockProvider(TrnDialogService, { open }),
      {
        provide: ENCRYPTION_DIALOG_COMPONENTS,
        useValue: {
          unlock: () => Promise.resolve(class StubUnlock {}),
          verify,
        },
      },
    ],
  });
  return {
    fixture,
    syncState,
    active,
    open,
    close,
    connect: TestBed.inject(TrustVerificationService).connect,
  };
}

describe('VerificationHostComponent', () => {
  it('connects only once a Matrix session is live', async () => {
    const { fixture, syncState, connect } = await setup();
    expect(connect).not.toHaveBeenCalled();

    syncState.set('PREPARED' as SyncState);
    fixture.detectChanges();

    expect(connect).toHaveBeenCalled();
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
    let resolvePage: ((page: unknown) => void) | undefined;
    const page = new Promise<unknown>((resolve) => {
      resolvePage = resolve;
    });
    const { fixture, active, open } = await setup(() => page);
    active.set(incoming());
    fixture.detectChanges();

    fixture.destroy();
    resolvePage?.(class StubVerify {});
    await page;

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
});
