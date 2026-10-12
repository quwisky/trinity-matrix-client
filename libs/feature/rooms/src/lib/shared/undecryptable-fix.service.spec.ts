import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrustService, type TrustStatus } from '@trinity/data-access/trust';
import {
  UndecryptableFixService,
  deriveUndecryptableFix,
} from './undecryptable-fix.service';

describe('deriveUndecryptableFix', () => {
  it.each([
    ['unknown', null, false, null],
    [
      'needs-setup',
      true,
      true,
      { label: 'Security settings', target: 'security' },
    ],
    [
      'needs-recovery',
      true,
      false,
      { label: 'Use recovery key', target: 'unlock' },
    ],
    ['ready', true, false, null],
    ['needs-setup', true, false, null],
    [
      'needs-recovery',
      false,
      false,
      { label: 'Verify this device', target: 'unlock' },
    ],
    [
      'needs-verification',
      false,
      false,
      { label: 'Verify this device', target: 'verify' },
    ],
    [
      'needs-setup',
      false,
      false,
      { label: 'Verify this device', target: 'setup' },
    ],
    ['ready', false, false, null],
  ] as const)(
    'status %s, verified %s, set up elsewhere %s → %o',
    (status, verified, elsewhere, fix) => {
      expect(deriveUndecryptableFix(status, verified, elsewhere)).toEqual(fix);
    },
  );

  it('keeps one reference for an unchanged answer, so rows do not re-render', () => {
    expect(deriveUndecryptableFix('needs-recovery', false, false)).toBe(
      deriveUndecryptableFix('needs-recovery', false, false),
    );
  });
});

describe('UndecryptableFixService', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(status: TrustStatus, verified: boolean | null) {
    const statusSignal = signal<TrustStatus>(status);
    const verifiedSignal = signal<boolean | null>(verified);
    const elsewhere = signal(false);
    const open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
      of({ kind: 'presented' as const, surface: request.surface }),
    );
    TestBed.configureTestingModule({
      providers: [
        UndecryptableFixService,
        MockProvider(TrustService, {
          status: statusSignal.asReadonly(),
          thisDeviceVerified: verifiedSignal.asReadonly(),
          recoverySetupElsewhere: elsewhere.asReadonly(),
        }),
        MockProvider(WorkspaceApplicationSurfaceService, { open }),
      ],
    });
    return {
      service: TestBed.inject(UndecryptableFixService),
      statusSignal,
      verifiedSignal,
      elsewhere,
      open,
    };
  }

  it('opens the recovery-key flow for an unverified device whose account has recovery', async () => {
    const { service, open } = setup('needs-recovery', false);

    await firstValueFrom(service.open(), { defaultValue: undefined });

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'unlock' },
    });
  });

  it('opens encryption setup for an account that has no identity', async () => {
    const { service, open } = setup('needs-setup', false);

    await firstValueFrom(service.open(), { defaultValue: undefined });

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'setup' },
    });
  });

  it('opens Security settings when the identity’s keys are on another device', async () => {
    const { service, elsewhere, open } = setup('needs-setup', true);
    elsewhere.set(true);

    await firstValueFrom(service.open(), { defaultValue: undefined });

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'settings', section: 'security' },
    });
  });

  it('follows the status while the row is on screen', () => {
    const { service, statusSignal, verifiedSignal } = setup(
      'needs-recovery',
      false,
    );
    expect(service.fix()).toEqual({
      label: 'Verify this device',
      target: 'unlock',
    });

    verifiedSignal.set(true);
    expect(service.fix()).toEqual({
      label: 'Use recovery key',
      target: 'unlock',
    });

    statusSignal.set('ready');
    expect(service.fix()).toBeNull();
  });

  it('opens nothing once nothing on this device can help', async () => {
    const { service, open } = setup('ready', true);

    await firstValueFrom(service.open(), { defaultValue: undefined });

    expect(open).not.toHaveBeenCalled();
  });
});
