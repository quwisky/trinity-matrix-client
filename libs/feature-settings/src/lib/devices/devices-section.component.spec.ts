import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController, ModalController } from '@ionic/angular/standalone';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  EncryptionDialogService,
  type EncryptionDialogLoaders,
} from '@trinity/ui';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesService, type DeviceInfo } from '@trinity/core';
import { DevicesSectionComponent } from './devices-section.component';

@Component({ selector: 'trn-stub-verify', template: '' })
class StubVerifyPage {}

/** Pretend the viewport is (or isn't) the desktop split-pane layout. */
function stubViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches }));
}

interface AlertButton {
  text: string;
  role?: string;
  handler?: (data?: Record<string, string>) => void;
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
  let alertCreate: ReturnType<typeof vi.fn>;
  let modalCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rename.mockClear();
    del.mockClear();
    connect.mockClear();
    disconnect.mockClear();
    navigate.mockClear();
    devices = signal<DeviceInfo[]>([CURRENT, OTHER]);
    alertCreate = vi
      .fn()
      .mockResolvedValue({ present: vi.fn().mockResolvedValue(undefined) });
    modalCreate = vi
      .fn()
      .mockResolvedValue({ present: vi.fn().mockResolvedValue(undefined) });

    TestBed.configureTestingModule({
      imports: [DevicesSectionComponent],
      providers: [
        // The real dialog service so we exercise its desktop-vs-mobile branching.
        EncryptionDialogService,
        {
          provide: DevicesService,
          useValue: {
            devices,
            list: () => of(devices()),
            rename,
            delete: del,
            connect,
            disconnect,
          },
        },
        { provide: AlertController, useValue: { create: alertCreate } },
        { provide: ModalController, useValue: { create: modalCreate } },
        { provide: Router, useValue: { navigate } },
        {
          provide: ENCRYPTION_DIALOG_COMPONENTS,
          useValue: {
            unlock: () => Promise.resolve(StubVerifyPage),
            verify: () => Promise.resolve(StubVerifyPage),
          } satisfies EncryptionDialogLoaders,
        },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  function lastAlertButtons(): AlertButton[] {
    return alertCreate.mock.calls.at(-1)?.[0].buttons as AlertButton[];
  }

  it('lists devices with badges; only non-current devices can be signed out', () => {
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    expect(el.querySelectorAll('ion-item').length).toBe(3); // 2 devices + verify row
    expect(el.textContent).toContain('Laptop');
    expect(el.textContent).toContain('Phone');
    expect(el.textContent).toContain('This device');
    expect(el.textContent).toContain('Unverified');
    // Current device has no remove button; the other one does.
    expect(el.querySelectorAll('[data-testid=remove-device]').length).toBe(1);
    expect(el.querySelectorAll('[data-testid=rename-device]').length).toBe(2);
  });

  it('renames a device via the alert', async () => {
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();

    await fixture.componentInstance.rename(OTHER);
    lastAlertButtons()
      .find((b) => b.text === 'Save')
      ?.handler?.({ name: 'Tablet' });

    expect(rename).toHaveBeenCalledWith('B', 'Tablet');
  });

  it('signs out a device via the destructive alert', async () => {
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();

    await fixture.componentInstance.remove(OTHER);
    lastAlertButtons()
      .find((b) => b.role === 'destructive')
      ?.handler?.();

    expect(del).toHaveBeenCalledWith('B', expect.any(Function));
  });

  it('navigates to the verification flow on mobile, returning to settings', () => {
    stubViewport(false);
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();

    fixture.componentInstance.verifyDevices();

    expect(navigate).toHaveBeenCalledWith(['/encryption/verify'], {
      queryParams: { returnTo: '/settings' },
    });
    expect(modalCreate).not.toHaveBeenCalled();
  });

  it('opens the verification flow as a modal on the desktop layout', async () => {
    stubViewport(true);
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();

    fixture.componentInstance.verifyDevices();

    await vi.waitFor(() =>
      expect(modalCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          component: StubVerifyPage,
          componentProps: { asModal: true },
        }),
      ),
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('subscribes to live device updates while mounted', () => {
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();
    expect(connect).toHaveBeenCalled();

    fixture.destroy();
    expect(disconnect).toHaveBeenCalled();
  });

  it('hides the verify affordance when every session is verified', () => {
    devices.set([CURRENT, { ...OTHER, isVerified: true }]);
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();

    expect(
      (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid=verify-devices]',
      ),
    ).toBeNull();
  });
});
