import { Component, signal } from '@angular/core';
import type { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  WorkspaceApplicationSurfaceService,
  type WorkspaceApplicationSurfaceRequest,
} from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  QrSignInService,
  type ExistingDeviceState,
  type QrDeviceLinker,
} from '@trinity/data-access/auth';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ExternalBrowserService,
  QrCodeService,
} from '@trinity/platform-native';
import { fireEvent, render, screen, waitFor } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { Observable, of } from 'rxjs';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import {
  TrustDevicesService,
  type DeviceInfo,
} from '@trinity/data-access/trust';
import { DevicesSectionComponent } from './devices-section.component';
import { LinkDeviceComponent } from './link-device/link-device.component';

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

/** The section inside a detail pane shaped like the settings layout's. */
@Component({
  imports: [DevicesSectionComponent],
  template: `<section aria-label="Devices">
    <h1 tabindex="-1">Devices</h1>
    <trn-devices-section />
  </section>`,
})
class InSettingsLayoutComponent {}

describe('DevicesSectionComponent', () => {
  const rename = vi.fn(() => of(undefined));
  const del = vi.fn(() => of(undefined));
  const connect = vi.fn();
  const disconnect = vi.fn();
  let devices: ReturnType<typeof signal<DeviceInfo[]>>;
  let canShareSecrets: ReturnType<typeof signal<boolean>>;
  let alertConfirm: Mock;
  let alertPrompt: Mock;
  let open: Mock;
  let activeUserId: ReturnType<typeof signal<string | null>>;
  let flowClosed: boolean;
  let linker: QrDeviceLinker & { link: Mock };
  let linkerForActiveAccount: Mock;

  beforeEach(() => {
    activeUserId = signal<string | null>('@me:hs');
    flowClosed = false;
    linker = {
      accountId: '@me:hs',
      link: vi.fn(() => ({
        state$: new Observable<ExistingDeviceState>(() => () => {
          flowClosed = true;
        }),
        confirmCheckCode: vi.fn(),
      })),
    };
    linkerForActiveAccount = vi.fn(() => linker);
    rename.mockClear();
    del.mockClear();
    connect.mockClear();
    disconnect.mockClear();
    devices = signal<DeviceInfo[]>([CURRENT, OTHER]);
    canShareSecrets = signal(true);
    alertConfirm = vi.fn(() => of(true));
    alertPrompt = vi.fn(() => of('Tablet'));
    open = vi.fn((request: WorkspaceApplicationSurfaceRequest) =>
      of({ kind: 'presented' as const, surface: request.surface }),
    );
  });

  function renderSection() {
    return render(DevicesSectionComponent, { providers: providers() });
  }

  function providers() {
    return [
      MockProvider(TrustDevicesService, {
        devices,
        canShareSecrets,
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
      MockProvider(QrSignInService, { linkerForActiveAccount }),
      MockProvider(MatrixClientService, {
        activeUserId: activeUserId.asReadonly(),
      }),
      MockProvider(ExternalBrowserService),
      MockProvider(QrCodeService, {
        openCamera: vi.fn().mockRejectedValue(new Error('no camera')),
      }),
    ];
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
  it('offers to link a new device only when this device can share its keys', async () => {
    canShareSecrets.set(false);
    const { fixture } = await renderSection();
    expect(
      screen.queryByRole('button', { name: 'Link a new device' }),
    ).toBeNull();

    canShareSecrets.set(true);
    fixture.detectChanges();

    expect(
      screen.getByRole('button', { name: 'Link a new device' }),
    ).toBeTruthy();
  });

  /** Opens the link panel and starts a flow in it; returns the flow's teardown flag. */
  async function startLink(fixture: ComponentFixture<unknown>) {
    fireEvent.click(screen.getByRole('button', { name: 'Link a new device' }));
    fixture.detectChanges();
    const panel = fixture.debugElement.query(By.directive(LinkDeviceComponent))
      .componentInstance as LinkDeviceComponent;
    panel.scan(new Uint8ClampedArray([1]));
    fixture.detectChanges();
    return panel;
  }

  it('links as the account that was active when "Link a new device" was clicked', async () => {
    const { fixture } = await renderSection();

    const panel = await startLink(fixture);

    expect(linkerForActiveAccount).toHaveBeenCalledOnce();
    expect(panel.linker()).toBe(linker);
    expect(linker.link).toHaveBeenCalledOnce();
  });

  it('closes the panel, cancelling its flow, when the account switches', async () => {
    const { fixture } = await renderSection();
    await startLink(fixture);
    expect(flowClosed).toBe(false);

    activeUserId.set('@other:hs');
    fixture.detectChanges();

    expect(
      fixture.debugElement.query(By.directive(LinkDeviceComponent)),
    ).toBeNull();
    expect(flowClosed).toBe(true);
  });

  it('closes the panel when this device can no longer share its keys, focusing the section heading', async () => {
    const { fixture } = await render(InSettingsLayoutComponent, {
      providers: providers(),
    });
    await startLink(fixture);

    canShareSecrets.set(false);
    fixture.detectChanges();

    expect(
      fixture.debugElement.query(By.directive(LinkDeviceComponent)),
    ).toBeNull();
    expect(flowClosed).toBe(true);
    await waitFor(() =>
      expect(document.activeElement?.textContent?.trim()).toBe('Devices'),
    );
  });

  it('opens the link flow, then returns focus to its button on close', async () => {
    const { fixture } = await renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Link a new device' }));
    fixture.detectChanges();
    const link = fixture.debugElement.query(By.directive(LinkDeviceComponent));
    expect(link).not.toBeNull();

    (link.componentInstance as LinkDeviceComponent).closed.emit();
    fixture.detectChanges();

    expect(
      fixture.debugElement.query(By.directive(LinkDeviceComponent)),
    ).toBeNull();
    await waitFor(() =>
      expect(document.activeElement?.textContent?.trim()).toBe(
        'Link a new device',
      ),
    );
  });
});
