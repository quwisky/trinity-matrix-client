import { Component, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  EncryptionDialogService,
  type EncryptionDialogLoaders,
} from '@trinity/ui';
import { TrnAlertService, TrnDialogService } from '@trinity/kit/overlay';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from 'vitest';
import { DevicesService, type DeviceInfo } from '@trinity/data-access/crypto';
import { DevicesSectionComponent } from './devices-section.component';

@Component({ selector: 'trn-stub-verify', template: '' })
class StubVerifyPage {}

/** Pretend the viewport is (or isn't) the desktop split-pane layout. */
function stubViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches }));
}

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
  const navigate = vi.fn().mockResolvedValue(true);
  let devices: ReturnType<typeof signal<DeviceInfo[]>>;
  let alertConfirm: Mock;
  let alertPrompt: Mock;
  let dialogOpen: Mock;

  beforeEach(() => {
    rename.mockClear();
    del.mockClear();
    connect.mockClear();
    disconnect.mockClear();
    navigate.mockClear();
    devices = signal<DeviceInfo[]>([CURRENT, OTHER]);
    alertConfirm = vi.fn().mockResolvedValue(true);
    alertPrompt = vi.fn().mockResolvedValue('Tablet');
    dialogOpen = vi.fn();
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderSection() {
    return render(DevicesSectionComponent, {
      providers: [
        // The real dialog service so we exercise its desktop-vs-mobile branching.
        EncryptionDialogService,
        MockProvider(DevicesService, {
          devices,
          list: () => of(devices()),
          rename,
          delete: del,
          connect,
          disconnect,
        }),
        MockProvider(TrnAlertService, {
          confirm: alertConfirm,
          prompt: alertPrompt,
        }),
        MockProvider(TrnDialogService, { open: dialogOpen }),
        MockProvider(Router, { navigate }),
        {
          provide: ENCRYPTION_DIALOG_COMPONENTS,
          useValue: {
            unlock: () => Promise.resolve(StubVerifyPage),
            verify: () => Promise.resolve(StubVerifyPage),
          } satisfies EncryptionDialogLoaders,
        },
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
    alertPrompt.mockResolvedValue('Tablet');
    const { fixture } = await renderSection();

    await fixture.componentInstance.rename(OTHER);

    expect(alertPrompt).toHaveBeenCalled();
    expect(rename).toHaveBeenCalledWith('B', 'Tablet');
  });

  it('does not rename when the prompt is cancelled', async () => {
    alertPrompt.mockResolvedValue(null);
    const { fixture } = await renderSection();

    await fixture.componentInstance.rename(OTHER);

    expect(rename).not.toHaveBeenCalled();
  });

  it('signs out a device via the destructive alert', async () => {
    alertConfirm.mockResolvedValue(true);
    const { fixture } = await renderSection();

    await fixture.componentInstance.remove(OTHER);

    expect(alertConfirm).toHaveBeenCalledWith(
      expect.objectContaining({ destructive: true }),
    );
    expect(del).toHaveBeenCalledWith('B', expect.any(Function));
  });

  it('does not sign out a device when the confirm is cancelled', async () => {
    alertConfirm.mockResolvedValue(false);
    const { fixture } = await renderSection();

    await fixture.componentInstance.remove(OTHER);

    expect(del).not.toHaveBeenCalled();
  });

  it('navigates to the verification flow on mobile, returning to the Devices section', async () => {
    stubViewport(false);
    const { fixture } = await renderSection();

    fixture.componentInstance.verifyDevices();

    expect(navigate).toHaveBeenCalledWith(['/encryption/verify'], {
      queryParams: { returnTo: '/settings/devices' },
    });
    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('opens the verification flow as a dialog on the desktop layout', async () => {
    stubViewport(true);
    const { fixture } = await renderSection();

    fixture.componentInstance.verifyDevices();

    await vi.waitFor(() =>
      expect(dialogOpen).toHaveBeenCalledWith(
        StubVerifyPage,
        expect.objectContaining({
          inputs: { asModal: true },
          disableClose: true,
        }),
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
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
