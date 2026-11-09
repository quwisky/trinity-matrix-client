import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  QrSignInService,
  type QrDeviceLinker,
} from '@trinity/data-access/auth';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnBadge } from '@trinity/components/generic-content';
import { TrnButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { runWithBusy } from '@trinity/util/ui';
import {
  TrustDevicesService,
  TrustService,
  type DeviceInfo,
} from '@trinity/data-access/trust';
import { TrnIconComponent } from '@trinity/components/foundations';
import { filter, firstValueFrom } from 'rxjs';
import {
  TrnAlertService,
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
} from '@trinity/components/overlay';
import { LinkDeviceComponent } from './link-device/link-device.component';
import { LinkDeviceKeysComponent } from './link-device-keys/link-device-keys.component';

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
    TrnSettingsRowComponent,
    TrnSettingsGroupComponent,
    TrnIconComponent,
    TrnBadge,
    TrnButton,
    TrnTooltip,
    LinkDeviceComponent,
    LinkDeviceKeysComponent,
  ],
})
export class DevicesSectionComponent {
  private readonly devicesSvc = inject(TrustDevicesService);
  private readonly alert = inject(TrnAlertService);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly qrSignIn = inject(QrSignInService);
  private readonly trust = inject(TrustService);
  private readonly activeAccountId = inject(MatrixClientService).activeUserId;
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly linkButton =
    viewChild<ElementRef<HTMLButtonElement>>('linkButton');
  private destroyed = false;

  /** True when this section is mounted inside the web/Electron settings modal. */
  readonly inSettingsDialog = input(false);

  readonly devices = this.devicesSvc.devices;
  /** Only a device holding all three cross-signing keys can link another one. */
  readonly canLinkDevice = this.devicesSvc.canShareSecrets;
  /**
   * Verified, but missing a key a new device needs (emoji verification hands over no master
   * key). Linking is still offered: the recovery key fetches the missing keys first.
   */
  readonly linkNeedsKeys = computed(
    () => !this.canLinkDevice() && this.trust.thisDeviceVerified() === true,
  );
  /** The account has secret storage, so a recovery key can fetch the keys. */
  readonly hasRecovery = computed(() => {
    const status = this.trust.status();
    return status === 'ready' || status === 'needs-recovery';
  });
  /** The recovery-key step before linking is open. */
  readonly keysStep = signal(false);
  /** The open link flow's account, captured when "Link a new device" was clicked. */
  readonly linker = signal<QrDeviceLinker | null>(null);
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
    // Closing the panel cancels its flow: a link never outlives its account or this
    // device's ability to share the keys.
    effect(() => {
      const linker = this.linker();
      if (
        linker &&
        (linker.accountId !== this.activeAccountId() || !this.canLinkDevice())
      ) {
        untracked(() => this.closeLink());
      }
    });
  }

  openLink(): void {
    this.error.set(null);
    if (!this.canLinkDevice()) {
      this.keysStep.set(true);
      return;
    }
    this.linker.set(this.qrSignIn.linkerForActiveAccount());
  }

  /** The recovery key fetched the keys; open the scanner once this device can share them. */
  keysUnlocked(): void {
    this.keysStep.set(false);
    runWithBusy(this.devicesSvc.refreshCanShareSecrets(), {
      busy: this.loading,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe((canShare) => {
      if (canShare) {
        this.openLink();
        return;
      }
      this.error.set(
        'This device still doesn’t have all the keys a new device needs. Link the new device from the device where you set up encryption.',
      );
      this.closeLink();
    });
  }

  closeKeysStep(): void {
    this.keysStep.set(false);
    this.closeLink();
  }

  /** Close the link flow; focus returns to its button, or to the section heading without one. */
  closeLink(): void {
    this.linker.set(null);
    afterNextRender(
      () => {
        const target =
          this.linkButton()?.nativeElement ??
          this.host.nativeElement
            .closest('section[aria-label]')
            ?.querySelector<HTMLElement>('h1[tabindex="-1"]');
        target?.focus();
      },
      { injector: this.injector },
    );
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
