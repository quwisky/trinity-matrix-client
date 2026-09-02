import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import { TrnBadge } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { runWithBusy } from '@trinity/util/ui';
import {
  TrustDevicesService,
  type DeviceInfo,
} from '@trinity/data-access/trust';
import { TrnIconComponent } from '@trinity/components/foundations';
import { filter, firstValueFrom } from 'rxjs';
import { SettingsSectionHeadingComponent } from '../shared/settings-section-heading/settings-section-heading.component';

/**
 * Device-management section of the Settings page: lists the user's sessions with
 * verified/current badges, renames them, and signs them out (driving the password
 * UIA when the homeserver requires it). "Verify a device" links to the existing
 * SAS verification page.
 */
@Component({
  selector: 'trn-devices-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './devices-section.component.html',
  imports: [
    TrnIconComponent,
    TrnBadge,
    TrnButton,
    TrnTooltip,
    SettingsSectionHeadingComponent,
  ],
})
export class DevicesSectionComponent {
  private readonly devicesSvc = inject(TrustDevicesService);
  private readonly alert = inject(TrnAlertService);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly destroyRef = inject(DestroyRef);
  private destroyed = false;

  /** True when this section is mounted inside the web/Electron settings modal. */
  readonly inSettingsDialog = input(false);

  readonly devices = this.devicesSvc.devices;
  readonly loading = signal(false);
  readonly busy = signal(false); // a rename/remove in flight
  readonly error = signal<string | null>(null);
  /** Whether any session is still unverified (drives the verify affordance). */
  readonly hasUnverified = computed(() =>
    this.devices().some((d) => !d.isVerified),
  );

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
    runWithBusy(this.devicesSvc.list(), {
      busy: this.loading,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe();
    // Keep the list live while the section is mounted (e.g. another session
    // signs a device out), and detach on destroy.
    this.devicesSvc.connect();
    this.destroyRef.onDestroy(() => this.devicesSvc.disconnect());
  }

  /** Prompt for a new display name, then rename. */
  rename(device: DeviceInfo): void {
    this.error.set(null); // don't carry a stale error into a fresh action
    this.alert
      .prompt$({
        header: 'Rename device',
        placeholder: 'Device name',
        confirmText: 'Save',
        value: device.displayName,
        maxLength: 100,
      })
      .pipe(
        filter((name): name is string => name !== null),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((name) => this.applyRename(device.id, name));
  }

  /** Confirm, then sign the device out (password UIA handled by the service). */
  remove(device: DeviceInfo): void {
    this.error.set(null);
    this.alert
      .confirm$({
        header: 'Sign out device',
        message: `“${device.displayName}” will be signed out and lose access to your account.`,
        confirmText: 'Sign out',
        variant: 'danger',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.applyRemove(device.id));
  }

  /**
   * Open the SAS verification flow — a modal on the desktop split-pane layout, a
   * routed page (returning here) on mobile — through Workspace's semantic presenter.
   */
  verifyDevices(): void {
    // Return to the Devices sub-page, not the settings index (the category list).
    const nested = this.inSettingsDialog();
    this.applicationSurfaces
      .open({
        surface: { kind: 'trust', flow: 'verify' },
        context: {
          returnTo: { kind: 'settings', section: 'devices' },
          ...(nested
            ? {
                placement: 'nested' as const,
                ownerActive: () => !this.destroyed,
              }
            : {}),
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  private applyRename(id: string, name: string): void {
    if (!name.trim()) {
      return;
    }
    runWithBusy(this.devicesSvc.rename(id, name), {
      busy: this.busy,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe();
  }

  private applyRemove(id: string): void {
    runWithBusy(
      this.devicesSvc.delete(id, () => this.promptPassword()),
      {
        busy: this.busy,
        error: this.error,
        destroyRef: this.destroyRef,
      },
    ).subscribe();
  }

  /** Ask for the account password during a delete UIA (null = cancelled). */
  private promptPassword(): Promise<string | null> {
    // Matrix UIA owns this callback and requires a Promise. Keep the conversion at that
    // boundary while the Settings-facing command stays a cold finite Observable.
    return firstValueFrom(
      this.alert.prompt$({
        header: 'Confirm your password',
        message: 'Signing out a device requires your account password.',
        placeholder: 'Password',
        confirmText: 'Confirm',
        inputType: 'password',
      }),
    );
  }
}
