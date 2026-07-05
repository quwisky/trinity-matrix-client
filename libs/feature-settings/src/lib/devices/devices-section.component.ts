import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  lucidePencil,
  lucideShieldCheck,
  lucideTrash2,
} from '@ng-icons/lucide';
import { TrnAlertService } from '@trinity/helm/overlay';
import { HlmBadge } from '@trinity/helm/badge';
import { HlmButton } from '@trinity/helm/button';
import { HlmTooltip } from '@trinity/helm/tooltip';
import { EncryptionDialogService, runWithBusy } from '@trinity/ui';
import { DevicesService, type DeviceInfo } from '@trinity/data-access-crypto';

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
  styleUrl: './devices-section.component.scss',
  imports: [NgIcon, HlmBadge, HlmButton, HlmTooltip],
  viewProviders: [
    provideIcons({ lucidePencil, lucideShieldCheck, lucideTrash2 }),
  ],
})
export class DevicesSectionComponent {
  private readonly devicesSvc = inject(DevicesService);
  private readonly alert = inject(TrnAlertService);
  private readonly dialogs = inject(EncryptionDialogService);
  private readonly destroyRef = inject(DestroyRef);

  readonly devices = this.devicesSvc.devices;
  readonly loading = signal(false);
  readonly busy = signal(false); // a rename/remove in flight
  readonly error = signal<string | null>(null);
  /** Whether any session is still unverified (drives the verify affordance). */
  readonly hasUnverified = computed(() =>
    this.devices().some((d) => !d.isVerified),
  );

  constructor() {
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
  async rename(device: DeviceInfo): Promise<void> {
    this.error.set(null); // don't carry a stale error into a fresh action
    const name = await this.alert.prompt({
      header: 'Rename device',
      placeholder: 'Device name',
      confirmText: 'Save',
      value: device.displayName,
      maxLength: 100,
    });
    if (name !== null) {
      this.applyRename(device.id, name);
    }
  }

  /** Confirm, then sign the device out (password UIA handled by the service). */
  async remove(device: DeviceInfo): Promise<void> {
    this.error.set(null);
    const confirmed = await this.alert.confirm({
      header: 'Sign out device',
      message: `“${device.displayName}” will be signed out and lose access to your account.`,
      confirmText: 'Sign out',
      destructive: true,
    });
    if (confirmed) {
      this.applyRemove(device.id);
    }
  }

  /**
   * Open the SAS verification flow — a modal on the desktop split-pane layout, a
   * routed page (returning here) on mobile — via {@link EncryptionDialogService}.
   */
  verifyDevices(): void {
    void this.dialogs.openVerify({ returnTo: '/settings' });
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
    return this.alert.prompt({
      header: 'Confirm your password',
      message: 'Signing out a device requires your account password.',
      placeholder: 'Password',
      confirmText: 'Confirm',
      inputType: 'password',
    });
  }
}
