import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular/standalone';
import {
  MatrixClientService,
  VerificationService,
  type VerificationView,
} from '@trinity/core';
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

function setup() {
  const syncState = signal<string | null>(null);
  const active = signal<VerificationView | null>(null);
  const connect = vi.fn();
  const create = vi.fn().mockResolvedValue({
    present: vi.fn().mockResolvedValue(undefined),
    dismiss: vi.fn().mockResolvedValue(undefined),
    onDidDismiss: vi.fn().mockResolvedValue(undefined),
  });
  TestBed.configureTestingModule({
    imports: [VerificationHostComponent],
    providers: [
      { provide: MatrixClientService, useValue: { syncState } },
      { provide: VerificationService, useValue: { active, connect } },
      { provide: ModalController, useValue: { create } },
    ],
  });
  const fixture = TestBed.createComponent(VerificationHostComponent);
  fixture.detectChanges();
  return { fixture, syncState, active, connect, create };
}

describe('VerificationHostComponent', () => {
  it('connects only once the client is live', () => {
    const { fixture, syncState, connect } = setup();
    expect(connect).not.toHaveBeenCalled();

    syncState.set('PREPARED');
    fixture.detectChanges();

    expect(connect).toHaveBeenCalled();
  });

  it('presents a modal for an incoming verification request', async () => {
    const { fixture, active, create } = setup();

    active.set(incoming());
    fixture.detectChanges();
    // present() lazy-imports the verification page before creating the modal.
    await vi.waitFor(() => expect(create).toHaveBeenCalled());

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ componentProps: { asModal: true } }),
    );
  });

  it('does not present a modal for a self-initiated (outgoing) request', () => {
    const { fixture, active, create } = setup();

    active.set({ ...incoming(), incoming: false });
    fixture.detectChanges();

    expect(create).not.toHaveBeenCalled();
  });
});
