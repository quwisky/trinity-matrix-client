import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  AlertController,
  IonButton,
  IonIcon,
  IonItem,
  IonLabel,
  IonList,
  IonListHeader,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  createOutline,
  shieldCheckmarkOutline,
  trashOutline,
} from 'ionicons/icons';
import { TrnBadgeDirective } from '@trinity/ui-spartan';
import { EncryptionDialogService, runWithBusy } from '@trinity/ui';
import { DevicesService, type DeviceInfo } from '@trinity/core';

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
  imports: [
    IonButton,
    IonIcon,
    IonItem,
    IonLabel,
    IonList,
    IonListHeader,
    TrnBadgeDirective,
  ],
})
export class DevicesSectionComponent {
  private readonly devicesSvc = inject(DevicesService);
  private readonly alertCtrl = inject(AlertController);
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
    addIcons({ createOutline, shieldCheckmarkOutline, trashOutline });
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
    const alert = await this.alertCtrl.create({
      header: 'Rename device',
      inputs: [
        {
          name: 'name',
          value: device.displayName,
          placeholder: 'Device name',
          attributes: { maxlength: 100 },
        },
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Save',
          handler: (data: { name?: string }) =>
            this.applyRename(device.id, data.name ?? ''),
        },
      ],
    });
    await alert.present();
  }

  /** Confirm, then sign the device out (password UIA handled by the service). */
  async remove(device: DeviceInfo): Promise<void> {
    this.error.set(null);
    const alert = await this.alertCtrl.create({
      header: 'Sign out device',
      message: `“${device.displayName}” will be signed out and lose access to your account.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Sign out',
          role: 'destructive',
          handler: () => this.applyRemove(device.id),
        },
      ],
    });
    await alert.present();
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
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: string | null): void => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };
      void this.alertCtrl
        .create({
          header: 'Confirm your password',
          message: 'Signing out a device requires your account password.',
          backdropDismiss: false, // force a button so the promise always settles
          inputs: [
            { name: 'password', type: 'password', placeholder: 'Password' },
          ],
          buttons: [
            { text: 'Cancel', role: 'cancel', handler: () => done(null) },
            {
              text: 'Confirm',
              handler: (data: { password?: string }) =>
                done(data.password ?? ''),
            },
          ],
        })
        .then((alert) => {
          // Settle on any dismiss too, so a programmatic close can't strand the promise.
          void alert.onDidDismiss().then(() => done(null));
          return alert.present();
        });
    });
  }
}
