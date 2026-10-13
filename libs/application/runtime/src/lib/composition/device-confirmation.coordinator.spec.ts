import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { MockProvider } from 'ng-mocks';
import { Subject, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TrnSurfaceService } from '@trinity/components/overlay';
import {
  AccountRuntimeService,
  type NewDeviceEstablishment,
} from '@trinity/data-access/accounts';
import {
  TrustDeviceConfirmationService,
  TrustService,
  TrustVerificationService,
  type DeviceConfirmationGate,
  type TrustHealth,
  type VerificationView,
} from '@trinity/data-access/trust';
import { DeviceConfirmationCoordinator } from './device-confirmation.coordinator';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';

function setup(url = '/rooms?account=%40me%3Ahs') {
  const newDevices = new Subject<NewDeviceEstablishment>();
  const activeAccountId = signal<string | null>(null);
  const health = signal<TrustHealth>({
    availability: 'unavailable',
    current: null,
    stale: null,
  });
  const gate = signal<DeviceConfirmationGate>({ kind: 'not-required' });
  const trustDialogOpen = signal(false);
  const verification = signal<VerificationView | null>(null);
  const order: string[] = [];
  const requireConfirmation = vi.fn(() => of(undefined));
  const hydrate = vi.fn(() => of(undefined));
  const completeIfVerified = vi.fn(() => of(undefined));
  const confirmRequired = vi.fn(() => of(true));
  const closeAll = vi.fn(() => {
    order.push('close dialogs');
  });
  const navigateByUrl = vi.fn(async (target: string) => {
    order.push(`navigate ${target}`);
    return true;
  });
  TestBed.configureTestingModule({
    providers: [
      DeviceConfirmationCoordinator,
      MockProvider(AccountRuntimeService, {
        newDevices: newDevices.asObservable(),
        activeAccountId: activeAccountId.asReadonly(),
      }),
      MockProvider(TrustDeviceConfirmationService, {
        gate: gate.asReadonly(),
        require: requireConfirmation,
        hydrate,
        completeIfVerified,
        confirmRequired,
      }),
      MockProvider(TrustService, { health: health.asReadonly() }),
      MockProvider(TrustVerificationService, {
        active: verification.asReadonly(),
      }),
      MockProvider(WorkspaceApplicationSurfacePresenterAdapter, {
        trustDialogOpen: trustDialogOpen.asReadonly(),
      }),
      MockProvider(TrnSurfaceService, { closeAll }),
      { provide: Router, useValue: { url, navigateByUrl } },
    ],
  });
  const subscription = TestBed.inject(DeviceConfirmationCoordinator)
    .run()
    .subscribe();
  TestBed.tick();
  return {
    newDevices,
    activeAccountId,
    health,
    gate,
    trustDialogOpen,
    verification,
    order,
    requireConfirmation,
    hydrate,
    completeIfVerified,
    confirmRequired,
    closeAll,
    navigateByUrl,
    subscription,
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('DeviceConfirmationCoordinator', () => {
  it('records a new-device sign-in as soon as Accounts publishes it', () => {
    const { newDevices, requireConfirmation, subscription } = setup();

    newDevices.next({ accountId: '@me:hs', deviceId: 'DEVICE' });

    expect(requireConfirmation).toHaveBeenCalledWith('@me:hs', 'DEVICE');
    subscription.unsubscribe();
  });

  it('loads the record of the account that becomes active', () => {
    const { activeAccountId, hydrate, subscription } = setup();

    activeAccountId.set('@me:hs');
    TestBed.tick();

    expect(hydrate).toHaveBeenCalledWith('@me:hs');
    subscription.unsubscribe();
  });

  it('clears the record once this device is verified', () => {
    const { activeAccountId, health, completeIfVerified, subscription } =
      setup();
    activeAccountId.set('@me:hs');
    health.set({
      availability: 'coherent',
      current: {
        status: 'ready',
        keyBackupActive: true,
        thisDeviceVerified: true,
        identityElsewhere: false,
      },
      stale: null,
    });
    TestBed.tick();

    expect(completeIfVerified).toHaveBeenCalledWith('@me:hs');
    subscription.unsubscribe();
  });

  it('closes any dialog over the app, then redirects Rooms to the check, when it turns required later', () => {
    const { gate, order, subscription } = setup();

    gate.set({ kind: 'required', status: 'needs-verification' });
    TestBed.tick();

    expect(order).toEqual(['close dialogs', 'navigate /encryption/confirm']);
    subscription.unsubscribe();
  });

  it('does not redirect when a fresh read of the account needs nothing, as just after a switch', () => {
    const { gate, confirmRequired, order, subscription } = setup();
    confirmRequired.mockReturnValue(of(false));

    gate.set({ kind: 'required', status: 'needs-verification' });
    TestBed.tick();

    expect(confirmRequired).toHaveBeenCalledOnce();
    expect(order).toEqual([]);
    subscription.unsubscribe();
  });

  it('waits for an open recovery or verification dialog, then redirects if the check is still needed', () => {
    const { gate, trustDialogOpen, order, subscription } = setup();
    trustDialogOpen.set(true);

    gate.set({ kind: 'required', status: 'needs-recovery' });
    TestBed.tick();
    expect(order).toEqual([]);

    trustDialogOpen.set(false);
    TestBed.tick();
    expect(order).toEqual(['close dialogs', 'navigate /encryption/confirm']);
    subscription.unsubscribe();
  });

  it('stays put when the flow that was open verified the device', () => {
    const { gate, trustDialogOpen, order, subscription } = setup();
    trustDialogOpen.set(true);
    gate.set({ kind: 'required', status: 'needs-recovery' });
    TestBed.tick();

    gate.set({ kind: 'not-required' });
    trustDialogOpen.set(false);
    TestBed.tick();

    expect(order).toEqual([]);
    subscription.unsubscribe();
  });

  it('waits while a verification of this account’s devices is in flight, and redirects once it has stopped', () => {
    const { gate, verification, order, subscription } = setup();
    verification.set({
      stage: 'sas-shown',
      isSelfVerification: true,
    } as VerificationView);
    gate.set({ kind: 'required', status: 'needs-verification' });
    TestBed.tick();
    expect(order).toEqual([]);

    verification.set({
      stage: 'cancelled',
      isSelfVerification: true,
    } as VerificationView);
    TestBed.tick();
    expect(order).toEqual(['close dialogs', 'navigate /encryption/confirm']);
    subscription.unsubscribe();
  });

  it('does not wait for a verification of another person, which cannot verify this device', () => {
    const { gate, verification, order, subscription } = setup();
    verification.set({
      stage: 'sas-shown',
      isSelfVerification: false,
    } as VerificationView);

    gate.set({ kind: 'required', status: 'needs-verification' });
    TestBed.tick();

    expect(order).toEqual(['close dialogs', 'navigate /encryption/confirm']);
    subscription.unsubscribe();
  });

  it('redirects any Settings section but Security', () => {
    const { gate, navigateByUrl, subscription } = setup(
      '/settings/notifications',
    );

    gate.set({ kind: 'required', status: 'needs-recovery' });
    TestBed.tick();

    expect(navigateByUrl).toHaveBeenCalledWith('/encryption/confirm', {
      replaceUrl: true,
    });
    subscription.unsubscribe();
  });

  it.each([
    '/login?add=1',
    '/encryption/unlock?returnTo=%2Fencryption%2Fconfirm',
    '/encryption/verify?returnTo=%2Fencryption%2Fconfirm',
    '/encryption/confirm',
    '/settings/security',
  ])('leaves %s alone', (url) => {
    const { gate, closeAll, navigateByUrl, subscription } = setup(url);

    gate.set({ kind: 'required', status: 'needs-recovery' });
    TestBed.tick();

    expect(closeAll).not.toHaveBeenCalled();
    expect(navigateByUrl).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('stops when the session ends', () => {
    const { newDevices, requireConfirmation, subscription } = setup();

    subscription.unsubscribe();
    newDevices.next({ accountId: '@me:hs', deviceId: 'DEVICE' });

    expect(requireConfirmation).not.toHaveBeenCalled();
  });
});
