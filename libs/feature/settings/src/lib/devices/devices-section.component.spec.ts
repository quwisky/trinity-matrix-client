import { signal } from '@angular/core';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  TrustDevicesService,
  type DeviceInfo,
} from '@trinity/data-access/trust';
import { DevicesSectionComponent } from './devices-section.component';

const CURRENT: DeviceInfo = {
  id: 'A',
  displayName: 'Laptop',
  lastSeenTs: 200,
  lastSeenIp: '1.2.3.4',
  isCurrent: true,
  isVerified: true,
};
const OTHER: DeviceInfo = {
  id: 'B',
  displayName: 'Phone',
  lastSeenTs: 100,
  lastSeenIp: null,
  isCurrent: false,
  isVerified: false,
};

describe('DevicesSectionComponent', () => {
  const rename = vi.fn(() => of(undefined));
  const del = vi.fn(() => of(undefined));
  const connect = vi.fn();
  const disconnect = vi.fn();
  let devices: ReturnType<typeof signal<DeviceInfo[]>>;
  let alertConfirm: Mock;
  let alertPrompt: Mock;
  let open: Mock;

  beforeEach(() => {
    rename.mockClear();
    del.mockClear();
    connect.mockClear();
    disconnect.mockClear();
    devices = signal<DeviceInfo[]>([CURRENT, OTHER]);
    alertConfirm = vi.fn(() => of(true));
    alertPrompt = vi.fn(() => of('Tablet'));
    open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
      of({ kind: 'presented' as const, surface: request.surface }),
    );
  });

  function renderSection() {
    return render(DevicesSectionComponent, {
      providers: [
        MockProvider(TrustDevicesService, {
          devices,
          list: () => of(devices()),
          rename,
          delete: del,
          connect,
          disconnect,
        }),
        MockProvider(TrnAlertService, {
          confirm$: alertConfirm,
          prompt$: alertPrompt,
        }),
        MockProvider(WorkspaceApplicationSurfaceService, { open }),
      ],
    });
  }

  it('lists devices with badges; only non-current devices can be signed out', async () => {
    const { container } = await renderSection();

    expect(container.querySelectorAll('[data-testid=device-row]').length).toBe(
      2,
    );
    expect(
      container.querySelector('[data-testid=verify-devices]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('Laptop');
    expect(container.textContent).toContain('Phone');
    expect(container.textContent).toContain('This device');
    expect(container.textContent).toContain('Unverified');
    // Current device has no remove button; the other one does.
    expect(
      container.querySelectorAll('[data-testid=remove-device]').length,
    ).toBe(1);
    expect(
      container.querySelectorAll('[data-testid=rename-device]').length,
    ).toBe(2);
  });

  it('renames a device via the alert', async () => {
    alertPrompt.mockReturnValue(of('Tablet'));
    const { fixture } = await renderSection();

    await fixture.componentInstance.rename(OTHER);

    expect(alertPrompt).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith('B', 'Tablet');
  });

  it('does not rename when the prompt is cancelled', async () => {
    alertPrompt.mockReturnValue(of(null));
    const { fixture } = await renderSection();

    await fixture.componentInstance.rename(OTHER);

    expect(rename).not.toHaveBeenCalled();
  });

  it('signs out a device via the destructive alert', async () => {
    alertConfirm.mockReturnValue(of(true));
    const { fixture } = await renderSection();

    await fixture.componentInstance.remove(OTHER);

    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'danger' }),
    );
    expect(del).toHaveBeenCalledWith('B', expect.any(Function));
  });

  it('does not sign out a device when the confirm is cancelled', async () => {
    alertConfirm.mockReturnValue(of(false));
    const { fixture } = await renderSection();

    await fixture.componentInstance.remove(OTHER);

    expect(del).not.toHaveBeenCalled();
  });

  it('opens verification with a semantic return to the Devices section', async () => {
    const { fixture } = await renderSection();

    fixture.componentInstance.verifyDevices();

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'verify' },
      context: {
        returnTo: { kind: 'settings', section: 'devices' },
      },
    });
  });

  it('keeps verification modal when Settings uses a narrow web dialog', async () => {
    const { fixture } = await renderSection();
    fixture.componentRef.setInput('inSettingsDialog', true);
    fixture.detectChanges();

    fixture.componentInstance.verifyDevices();

    expect(open).toHaveBeenCalledWith({
      surface: { kind: 'trust', flow: 'verify' },
      context: expect.objectContaining({
        returnTo: { kind: 'settings', section: 'devices' },
        placement: 'nested',
        ownerActive: expect.any(Function),
      }),
    });
  });

  it('subscribes to live device updates while mounted', async () => {
    const { fixture } = await renderSection();
    expect(connect).toHaveBeenCalled();

    fixture.destroy();
    expect(disconnect).toHaveBeenCalled();
  });

  it('hides the verify affordance when every session is verified', async () => {
    devices.set([CURRENT, { ...OTHER, isVerified: true }]);
    const { container } = await renderSection();

    expect(container.querySelector('[data-testid=verify-devices]')).toBeNull();
  });
});
