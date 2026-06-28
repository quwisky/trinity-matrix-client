import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AlertController } from '@ionic/angular/standalone';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesService, type DeviceInfo } from '@trinity/core';
import { DevicesSectionComponent } from './devices-section.component';

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
  const navigateByUrl = vi.fn();
  let devices: ReturnType<typeof signal<DeviceInfo[]>>;
  let alertCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rename.mockClear();
    del.mockClear();
    navigateByUrl.mockClear();
    devices = signal<DeviceInfo[]>([CURRENT, OTHER]);
    alertCreate = vi
      .fn()
      .mockResolvedValue({ present: vi.fn().mockResolvedValue(undefined) });

    TestBed.configureTestingModule({
      imports: [DevicesSectionComponent],
      providers: [
        {
          provide: DevicesService,
          useValue: { devices, list: () => of(devices()), rename, delete: del },
        },
        { provide: AlertController, useValue: { create: alertCreate } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    });
  });

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

  it('navigates to the verification flow', () => {
    const fixture = TestBed.createComponent(DevicesSectionComponent);
    fixture.detectChanges();

    fixture.componentInstance.verifyDevices();

    expect(navigateByUrl).toHaveBeenCalledWith('/encryption/verify');
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
