import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import {
  MatrixClientService,
  VerificationService,
  type VerificationView,
} from '@trinity/core';
import { TrnDialogService } from '@trinity/helm/overlay';
import { MockProvider } from 'ng-mocks';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { VerificationHostComponent } from './verification-host.component';

function incoming(): VerificationView {
  return {
    stage: 'requested',
    otherUserId: '@me:hs',
    otherDeviceId: 'PHONE',
    isSelfVerification: true,
    incoming: true,
    emoji: null,
    cancelReason: null,
  };
}

async function setup() {
  const syncState = signal<string | null>(null);
  const active = signal<VerificationView | null>(null);
  const open = vi.fn().mockReturnValue({ closed: new Subject() });
  const { fixture } = await render(VerificationHostComponent, {
    providers: [
      MockProvider(MatrixClientService, { syncState }),
      MockProvider(VerificationService, { active }),
      MockProvider(TrnDialogService, { open }),
    ],
  });
  // `connect` is auto-spied by ng-mocks (see test-setup autoSpy).
  const connect = TestBed.inject(VerificationService).connect;
  return { fixture, syncState, active, connect, open };
}

describe('VerificationHostComponent', () => {
  it('connects only once the client is live', async () => {
    const { fixture, syncState, connect } = await setup();
    expect(connect).not.toHaveBeenCalled();

    syncState.set('PREPARED');
    fixture.detectChanges();

    expect(connect).toHaveBeenCalled();
  });

  it('presents a modal for an incoming verification request', async () => {
    const { fixture, active, open } = await setup();

    active.set(incoming());
    fixture.detectChanges();
    // present() lazy-imports the verification page before opening the dialog.
    await vi.waitFor(() => expect(open).toHaveBeenCalled());

    // The page is lazy-loaded (dynamic import), so a static import here would trip
    // the module-boundary lint — assert on the class shape, not the identity.
    expect(open).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        inputs: { asModal: true },
        disableClose: true,
      }),
    );
  });

  it('does not present a modal for a self-initiated (outgoing) request', async () => {
    const { fixture, active, open } = await setup();

    active.set({ ...incoming(), incoming: false });
    fixture.detectChanges();

    expect(open).not.toHaveBeenCalled();
  });
});
